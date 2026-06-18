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

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const DEFAULT_APP_SERVER_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours.
const CODEX_APP_SERVER_MAX_AGE_MS = Number.parseInt(
  process.env.CODEX_APP_SERVER_MAX_AGE_MS ?? `${DEFAULT_APP_SERVER_MAX_AGE_MS}`,
  10,
);

let singleton: CodexAppServerClient | null = null;
let singletonInit: Promise<void> | null = null;
let nextGeneration = 1;

function safeDeclineResponse(method: string): unknown {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "denied" };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/tool/call":
      return {
        contentItems: [
          {
            type: "inputText",
            text: "Pocket Agent does not support app/plugin dynamic tool execution yet.",
          },
        ],
        success: false,
      };
    default:
      return {};
  }
}

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

export function getCodexAppServerClientAgeMs(): number | null {
  return singleton && !singleton.closed ? singleton.ageMs() : null;
}

export function getCodexAppServerClientGeneration(): number | null {
  return singleton && !singleton.closed ? singleton.generation : null;
}

export function isCodexAppServerAuthStaleError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("codex app-server authentication became stale") ||
    (normalized.includes("401 unauthorized") &&
      (normalized.includes("/v1/responses") ||
        normalized.includes("api.openai.com") ||
        normalized.includes("missing bearer"))) ||
    normalized.includes("missing bearer or basic authentication")
  );
}

export function restartCodexAppServerClient(
  reason: string,
  opts: { notifyListeners?: boolean } = {},
) {
  singleton?.shutdown({
    notifyListeners: opts.notifyListeners ?? false,
    reason,
  });
  singleton = null;
  singletonInit = null;
}

export function restartCodexAppServerClientIfStaleForNewTurn(): boolean {
  const maxAgeMs = Number.isFinite(CODEX_APP_SERVER_MAX_AGE_MS)
    ? CODEX_APP_SERVER_MAX_AGE_MS
    : DEFAULT_APP_SERVER_MAX_AGE_MS;
  if (maxAgeMs <= 0) return false;
  const ageMs = getCodexAppServerClientAgeMs();
  if (ageMs === null || ageMs < maxAgeMs) return false;
  restartCodexAppServerClient(
    `Codex app-server age ${Math.round(ageMs / 1000)}s exceeded ${Math.round(maxAgeMs / 1000)}s; restarting before new turn.`,
  );
  return true;
}

export function shutdownCodexAppServerClient() {
  singleton?.shutdown({
    notifyListeners: false,
    reason: "Codex app-server shutdown",
  });
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
  private startedAt = Date.now();
  private suppressCloseNotification = false;
  readonly generation = nextGeneration++;
  closed = false;

  constructor() {
    this.proc = spawn(CODEX_BIN, ["--enable", "realtime_conversation", "app-server"], {
      env: makeSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk) => {
      // Keep stderr visible in launchd/app logs for diagnostics. app-server
      // structured events are read from stdout.
      const text = chunk.toString();
      process.stderr.write(`[codex app-server] ${text}`);
      if (isCodexAppServerAuthStaleError(text)) {
        this.invalidateAuthStale(text);
      }
    });

    this.proc.on("close", (code, signal) => {
      this.closed = true;
      const error = new Error(
        `Codex app-server exited${code === null ? "" : ` with code ${code}`}${
          signal ? ` (${signal})` : ""
        }`,
      );
      this.rejectAll(error);
      if (!this.suppressCloseNotification) {
        this.notifyAll({
          method: "error",
          params: { message: error.message, localFatal: true },
        });
      }
    });
  }

  ageMs(): number {
    return Date.now() - this.startedAt;
  }

  async initialize() {
    if (this.initialized) return;

    await this.request("initialize", {
      clientInfo: {
        name: "agent_cockpit",
        title: "Pocket Agent",
        version: "0.1.0",
      },
      capabilities: {
        // Pocket Agent mirrors Codex-native slash commands. Some native
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

  shutdown(opts: { notifyListeners?: boolean; reason?: string } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.suppressCloseNotification = opts.notifyListeners === false;
    this.rejectAll(new Error(opts.reason ?? "Codex app-server shutdown"));
    this.proc.kill("SIGTERM");
  }

  private invalidateAuthStale(reason: string) {
    if (this.closed) return;
    const message = `Codex app-server authentication became stale; restarting app-server. ${reason}`;
    this.shutdown({
      notifyListeners: false,
      reason: message,
    });
    this.notifyAll({
      method: "error",
      params: {
        message,
        localFatal: true,
        staleAuth: true,
      },
    });
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
        const error = new Error(message.error.message ?? "Codex app-server error");
        pending.reject(error);
        if (isCodexAppServerAuthStaleError(error)) {
          this.invalidateAuthStale(error.message);
        }
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated requests have both method and id. Approval/user-input
    // requests are routed to the matching thread so Pocket Agent can render a UI
    // and respond later; unsupported requests are rejected explicitly.
    if (message.method && typeof message.id === "number") {
      this.handleServerRequest(message as AppServerMessage & { id: number; method: string });
      return;
    }

    this.dispatchNotification(message);
  }

  private handleServerRequest(message: AppServerMessage & { id: number; method: string }) {
    if (message.method === "account/chatgptAuthTokens/refresh") {
      this.respondError(
        message.id,
        "Pocket Agent does not manage external ChatGPT auth token refresh.",
      );
      this.invalidateAuthStale("Codex app-server requested ChatGPT auth token refresh from Pocket Agent.");
      return;
    }

    const approvalMethods = new Set([
      "execCommandApproval",
      "applyPatchApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "mcpServer/elicitation/request",
      "item/tool/requestUserInput",
      "item/tool/call",
    ]);

    if (approvalMethods.has(message.method)) {
      if (!this.dispatchServerRequest(message)) {
        this.respond(message.id, safeDeclineResponse(message.method));
      }
      return;
    }

    this.respondError(message.id, `Unsupported request: ${message.method}`, -32601);
  }

  private dispatchServerRequest(message: AppServerMessage): boolean {
    const threadId = message.params?.threadId ?? message.params?.conversationId;
    if (typeof threadId !== "string") return false;
    return this.dispatchToThread(threadId, message);
  }

  private dispatchNotification(message: AppServerMessage): boolean {
    const threadId = message.params?.threadId ?? message.params?.conversationId;
    if (typeof threadId === "string") {
      return this.dispatchToThread(threadId, message);
    }

    this.notifyAll(message);
    return true;
  }

  private dispatchToThread(threadId: string, message: AppServerMessage): boolean {
    const listeners = this.threadListeners.get(threadId);
    if (!listeners || listeners.size === 0) return false;
    for (const listener of listeners) listener(message);
    return true;
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
