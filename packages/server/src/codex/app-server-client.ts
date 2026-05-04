import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { makeSpawnEnv } from "../adapters/base.js";

type JsonRpcId = number;

export interface AppServerMessage {
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

type ThreadListener = (message: AppServerMessage) => void;

const CODEX_BIN = "/opt/homebrew/bin/codex";

let singleton: CodexAppServerClient | null = null;
let singletonInit: Promise<void> | null = null;

export async function getCodexAppServerClient(): Promise<CodexAppServerClient> {
  if (!singleton || singleton.closed) {
    singleton = new CodexAppServerClient();
    singletonInit = singleton.initialize();
  }

  if (singletonInit) {
    try {
      await singletonInit;
    } catch (err) {
      singleton = null;
      throw err;
    } finally {
      singletonInit = null;
    }
  }
  return singleton;
}

export function shutdownCodexAppServerClient() {
  singleton?.shutdown();
  singleton = null;
  singletonInit = null;
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    JsonRpcId,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
    }
  >();
  private threadListeners = new Map<string, Set<ThreadListener>>();
  private initialized = false;
  closed = false;

  constructor() {
    this.proc = spawn(CODEX_BIN, ["app-server"], {
      env: makeSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk) => {
      // Keep stderr visible in launchd/app logs for diagnostics. app-server
      // structured events are read from stdout.
      process.stderr.write(`[codex app-server] ${chunk.toString()}`);
    });

    this.proc.on("close", (code, signal) => {
      this.closed = true;
      const error = new Error(
        `Codex app-server exited${code === null ? "" : ` with code ${code}`}${
          signal ? ` (${signal})` : ""
        }`,
      );
      this.rejectAll(error);
      this.notifyAll({
        method: "error",
        params: { message: error.message, localFatal: true },
      });
    });
  }

  async initialize() {
    if (this.initialized) return;

    await this.request("initialize", {
      clientInfo: {
        name: "agent_cockpit",
        title: "Agent Cockpit",
        version: "0.1.0",
      },
      capabilities: {
        // Agent Cockpit mirrors Codex-native slash commands. Some native
        // command mappings (for example background terminal cleanup) live on
        // the app-server experimental surface, so opt in explicitly.
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  request(method: string, params?: unknown): Promise<any> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.nextId++;
    const message =
      params === undefined ? { method, id } : { method, id, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(message);
    });
  }

  respond(id: JsonRpcId, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, message: string, code = -32603) {
    this.write({ id, error: { code, message } });
  }

  notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  subscribeThread(threadId: string, listener: ThreadListener): () => void {
    let listeners = this.threadListeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.threadListeners.set(threadId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.threadListeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.threadListeners.delete(threadId);
      }
    };
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Codex app-server shutdown"));
    this.proc.kill("SIGTERM");
  }

  private write(message: unknown) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    if (!line.trim()) return;

    let message: AppServerMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated requests have both method and id. This MVP does not
    // implement approval UI, so decline/cancel safely and surface a local
    // notification to the matching thread where possible.
    if (message.method && typeof message.id === "number") {
      this.handleServerRequest(message as AppServerMessage & { id: number; method: string });
      return;
    }

    this.dispatchNotification(message);
  }

  private handleServerRequest(message: AppServerMessage & { id: number; method: string }) {
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      this.respond(message.id, { decision: "decline" });
      return;
    }

    if (
      message.method === "execCommandApproval" ||
      message.method === "applyPatchApproval"
    ) {
      this.respond(message.id, { decision: "denied" });
      return;
    }

    if (message.method === "item/permissions/requestApproval") {
      this.respond(message.id, {
        permissions: {},
        scope: "turn",
      });
      return;
    }

    if (message.method === "mcpServer/elicitation/request") {
      this.respond(message.id, {
        action: "decline",
        content: null,
        _meta: null,
      });
      return;
    }

    if (message.method === "item/tool/requestUserInput") {
      this.respond(message.id, { answers: {} });
      return;
    }

    if (message.method === "account/chatgptAuthTokens/refresh") {
      this.respondError(
        message.id,
        "Agent Cockpit does not manage external ChatGPT auth token refresh.",
      );
      return;
    }

    this.respondError(message.id, `Unsupported request: ${message.method}`, -32601);
  }

  private dispatchNotification(message: AppServerMessage) {
    const threadId = message.params?.threadId;
    if (typeof threadId === "string") {
      this.dispatchToThread(threadId, message);
      return;
    }

    this.notifyAll(message);
  }

  private dispatchToThread(threadId: string, message: AppServerMessage) {
    const listeners = this.threadListeners.get(threadId);
    if (!listeners) return;
    for (const listener of listeners) listener(message);
  }

  private notifyAll(message: AppServerMessage) {
    for (const listeners of this.threadListeners.values()) {
      for (const listener of listeners) listener(message);
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
