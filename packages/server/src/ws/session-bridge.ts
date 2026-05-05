import { nanoid } from "nanoid";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SLASH_COMMANDS,
  findSlashCommandDefinition,
  type AgentType,
  type Message,
  type ServerEvent,
  type SessionStatus,
} from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import type { CLIAdapter } from "../adapters/base.js";
import { notifyAll } from "../push.js";
import {
  getCodexAppServerClient,
  type AppServerMessage,
} from "../codex/app-server-client.js";
import {
  type ManagedSession,
  getManaged,
  setManaged,
  removeManaged,
  nextSeq,
  broadcastEvent,
  broadcastLobby,
} from "../process-manager.js";

const execFileAsync = promisify(execFile);
const AUTO_TITLE_MAX_LENGTH = 48;

/**
 * Shared termination notification helper. Called from every code path that
 * transitions a session out of `running`: structured `turn_complete`, structured
 * `error`, and the one-shot `close` fallback. Push delivery is fire-and-forget.
 */
function notifyTurnTerminated(
  sessionId: string,
  outcome: "complete" | "error" | "stopped",
) {
  const db = getDb();
  const session = db
    .prepare("SELECT name FROM sessions WHERE id = ?")
    .get(sessionId) as { name: string | null } | undefined;
  const name = session?.name || `Session ${sessionId.slice(0, 8)}`;
  const titleByOutcome = {
    complete: "Turn complete",
    error: "Turn failed",
    stopped: "Turn stopped",
  } as const;
  notifyAll({
    title: titleByOutcome[outcome],
    body: name,
    sessionId,
  });
}

function getAdapter(agent: AgentType): CLIAdapter {
  switch (agent) {
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      // Kept as a fallback type-level branch. `ensureManaged` routes Codex to
      // app-server before this is used.
      return new CodexAdapter();
  }
}

export async function ensureManaged(sessionId: string): Promise<ManagedSession> {
  let managed = getManaged(sessionId);
  if (managed) return managed;

  const db = getDb();
  const session = db
    .prepare(
      "SELECT id, repo_id, agent, cli_session_id, cwd FROM sessions WHERE id = ?",
    )
    .get(sessionId) as any;
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const repo = db
    .prepare("SELECT path FROM repos WHERE id = ?")
    .get(session.repo_id) as any;
  if (!repo) throw new Error(`Repo for session ${sessionId} not found`);

  const cwd = session.cwd ?? repo.path;

  if (session.agent === "codex") {
    managed = await ensureCodexAppServerManaged({
      sessionId,
      cwd,
      cliSessionId: session.cli_session_id ?? undefined,
    });
    setManaged(sessionId, managed);
    return managed;
  }

  const adapter = getAdapter(session.agent);
  const handle = await adapter.init({
    cwd,
    cliSessionId: session.cli_session_id ?? undefined,
  });

  managed = {
    sessionId,
    runtime: "cli",
    adapter,
    handle,
    seq: 0,
    eventBuffer: [],
    listeners: new Set(),
  };

  setManaged(sessionId, managed);

  // Claude is one-shot-per-turn (no long-lived process from init). Process
  // listeners are attached in sendPrompt after startTurn.

  return managed;
}

async function ensureCodexAppServerManaged(opts: {
  sessionId: string;
  cwd: string;
  cliSessionId?: string;
}): Promise<ManagedSession> {
  const client = await getCodexAppServerClient();
  let threadId: string | null = null;
  let threadStatusType: string | null = null;

  if (opts.cliSessionId) {
    try {
      const resumed = await client.request("thread/resume", {
        threadId: opts.cliSessionId,
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      threadId = resumed?.thread?.id ?? opts.cliSessionId;
      threadStatusType = resumed?.thread?.status?.type ?? null;
    } catch {
      threadId = null;
    }
  }

  if (!threadId) {
    const started = await client.request("thread/start", {
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "agent_cockpit",
      experimentalRawEvents: true,
    });
    threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    threadStatusType = started?.thread?.status?.type ?? null;

    getDb()
      .prepare(
        "UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(threadId, opts.sessionId);
  }

  reconcileCodexThreadStatus(opts.sessionId, threadStatusType);

  const managed: ManagedSession = {
    sessionId: opts.sessionId,
    runtime: "codex-app-server",
    codexThreadId: threadId,
    codexActiveTurnId: null,
    codexStopRequested: false,
    codexStoppingTurnId: null,
    seq: 0,
    eventBuffer: [],
    listeners: new Set(),
  };

  managed.cleanup = client.subscribeThread(threadId, (message) => {
    handleCodexAppServerMessage(managed, opts.sessionId, message);
  });

  return managed;
}

export async function syncCodexThreadMessages(
  managed: ManagedSession,
  sessionId: string,
): Promise<{ importedCount: number; messages: Message[] }> {
  if (managed.runtime !== "codex-app-server" || !managed.codexThreadId) {
    throw new Error("Sync is only available for Codex sessions.");
  }

  const client = await getCodexAppServerClient();
  const result = await client.request("thread/read", {
    threadId: managed.codexThreadId,
    includeTurns: true,
  });
  const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
  let importedCount = 0;

  for (const turn of turns) {
    const turnTimestamp = sqliteTimestampFromUnixSeconds(
      turn?.completedAt ?? turn?.startedAt ?? null,
    );
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const extracted = messageFromThreadItem(item);
      if (!extracted) continue;
      const externalId = `${managed.codexThreadId}:${turn.id}:${item.id}`;
      if (upsertExternalMessage(
        sessionId,
        extracted.role,
        extracted.content,
        externalId,
        turnTimestamp,
      )) {
        importedCount += 1;
      }
    }
  }

  if (importedCount > 0) {
    getDb()
      .prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?")
      .run(sessionId);
  }

  const messages = listSessionMessages(sessionId);
  broadcastEvent(managed, {
    type: "messages_synced",
    messages,
    importedCount,
    seq: nextSeq(managed),
  });

  return { importedCount, messages };
}

function messageFromThreadItem(
  item: any,
): { role: "user" | "assistant"; content: string } | null {
  if (item?.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? item.content
          .map((part: any) => {
            if (part?.type === "text") return String(part.text ?? "");
            if (part?.type === "image") return `[image: ${part.url ?? ""}]`;
            if (part?.type === "localImage") return `[local image: ${part.path ?? ""}]`;
            if (part?.type === "skill") return `[$${part.name ?? "skill"}]`;
            if (part?.type === "mention") return `[@${part.name ?? "mention"}]`;
            return "";
          })
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";
    return content ? { role: "user", content } : null;
  }

  if (item?.type === "agentMessage") {
    const content = String(item.text ?? "").trim();
    return content ? { role: "assistant", content } : null;
  }

  return null;
}

function upsertExternalMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  externalId: string,
  createdAt: string | null,
): boolean {
  const db = getDb();
  const existingExternal = db
    .prepare("SELECT id FROM messages WHERE session_id = ? AND external_id = ?")
    .get(sessionId, externalId);
  if (existingExternal) return false;

  const existingLocal = db
    .prepare(
      `SELECT id FROM messages
       WHERE session_id = ? AND role = ? AND content = ? AND external_id IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(sessionId, role, content) as { id: string } | undefined;

  if (existingLocal) {
    db.prepare("UPDATE messages SET external_id = ? WHERE id = ?").run(
      externalId,
      existingLocal.id,
    );
    return false;
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO messages (id, session_id, turn_id, role, content, external_id, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(id, sessionId, role, content, externalId, createdAt);
  return true;
}

function sqliteTimestampFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function listSessionMessages(sessionId: string): Message[] {
  return getDb()
    .prepare(
      `SELECT id, session_id as sessionId, turn_id as turnId, role, content,
              created_at as createdAt
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as Message[];
}

function attachProcessListeners(
  managed: ManagedSession,
  sessionId: string,
  isOneShot: boolean,
) {
  const { handle, adapter } = managed;
  if (!handle?.proc?.stdout || !adapter) return;

  let buffer = "";
  handle.proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();

    // Forward the raw chunk to listeners as a debug-view event. Excluded
    // from the eventBuffer in process-manager (live-only).
    broadcastEvent(managed, {
      type: "raw_stdout",
      data: text,
      seq: nextSeq(managed),
    });

    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = adapter.parseEvent(line);
      if (!event) continue;

      const seq = nextSeq(managed);

      if (event.type === "init" && event.sessionId) {
        const db = getDb();
        db.prepare(
          "UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(event.sessionId, sessionId);
        if (managed.handle) managed.handle.cliSessionId = event.sessionId as string;
      }

      const serverEvent: ServerEvent = { ...event, seq } as any;
      broadcastEvent(managed, serverEvent);

      if (event.type === "message_complete") {
        persistMessage(sessionId, "assistant", event.content as string);
      }

      if (event.type === "turn_complete") {
        completeTurn(sessionId, event.cost as number | undefined);
        updateSessionStatus(sessionId, "idle");
        broadcastEvent(managed, {
          type: "status",
          status: "idle",
          seq: nextSeq(managed),
        });
        notifyTurnTerminated(sessionId, "complete");
      }

      if (event.type === "error") {
        failTurn(sessionId);
        updateSessionStatus(sessionId, "error");
        broadcastEvent(managed, {
          type: "status",
          status: "error",
          seq: nextSeq(managed),
        });
        notifyTurnTerminated(sessionId, "error");
      }
    }
  });

  handle.proc.on("close", (code) => {
    if (isOneShot) {
      const db = getDb();
      const session = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionId) as any;

      if (session?.status === "running") {
        if (code === 0) {
          completeTurn(sessionId);
          updateSessionStatus(sessionId, "idle");
          broadcastEvent(managed, {
            type: "status",
            status: "idle",
            seq: nextSeq(managed),
          });
          notifyTurnTerminated(sessionId, "complete");
        } else {
          stopTurn(sessionId);
          updateSessionStatus(sessionId, "stopped");
          broadcastEvent(managed, {
            type: "status",
            status: "stopped",
            seq: nextSeq(managed),
          });
          notifyTurnTerminated(sessionId, "stopped");
        }
      }
      handle.proc = null;
    } else {
      const db = getDb();
      const sess = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionId) as { status: string } | undefined;
      const wasRunning = sess?.status === "running";
      if (wasRunning) {
        stopTurn(sessionId);
      }
      updateSessionStatus(sessionId, "stopped");
      broadcastEvent(managed, {
        type: "status",
        status: "stopped",
        seq: nextSeq(managed),
      });
      if (wasRunning) {
        notifyTurnTerminated(sessionId, "stopped");
      }
      removeManaged(sessionId);
    }
  });
}

export function sendPrompt(
  managed: ManagedSession,
  sessionId: string,
  content: string,
): { ok: boolean; error?: string } {
  const db = getDb();
  const session = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as any;

  if (
    session?.status === "running" ||
    hasRunningTurn(sessionId) ||
    managed.codexStopRequested
  ) {
    return { ok: false, error: "Session is already running" };
  }

  const turnId = createRunningTurn(sessionId, content);

  const slashContent = content.trimStart();
  if (!slashContent.startsWith("/")) {
    maybeAutoTitleSession(managed, sessionId, content);
  }

  if (slashContent.startsWith("/")) {
    updateSessionStatus(sessionId, "running");
    broadcastEvent(managed, {
      type: "status",
      status: "running",
      seq: nextSeq(managed),
    });
    if (managed.runtime === "codex-app-server") {
      void handleSlashCommand(managed, sessionId, turnId, slashContent);
    } else {
      void handleNonCodexSlashCommand(managed, sessionId, turnId, slashContent);
    }
    return { ok: true };
  }

  updateSessionStatus(sessionId, "running");
  broadcastEvent(managed, {
    type: "status",
    status: "running",
    seq: nextSeq(managed),
  });

  if (managed.runtime === "codex-app-server") {
    void startCodexTurn(managed, sessionId, content);
    return { ok: true };
  }

  if (!managed.adapter || !managed.handle) {
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    return { ok: false, error: "Session runtime is not available" };
  }

  managed.adapter.startTurn(managed.handle, content);

  if (managed.handle.proc) {
    attachProcessListeners(managed, sessionId, true);
  }

  return { ok: true };
}

async function startCodexTurn(
  managed: ManagedSession,
  sessionId: string,
  content: string,
) {
  try {
    const client = await getCodexAppServerClient();
    if (!managed.codexThreadId) throw new Error("Missing Codex thread id");

    const result = await client.request("turn/start", {
      threadId: managed.codexThreadId,
      input: [{ type: "text", text: content, text_elements: [] }],
    });
    const turnId = result?.turn?.id ?? managed.codexActiveTurnId ?? null;
    if (turnId && managed.codexStopRequested) {
      managed.codexStoppingTurnId = turnId;
      await interruptCodexTurn(managed, turnId);
      return;
    }
    if (getSessionStatus(sessionId) === "running") {
      managed.codexActiveTurnId = turnId;
    }
  } catch (err) {
    if (
      managed.codexStopRequested ||
      getSessionStatus(sessionId) === "stopped" ||
      !hasRunningTurn(sessionId)
    ) {
      managed.codexStopRequested = false;
      managed.codexActiveTurnId = null;
      return;
    }
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    const message = err instanceof Error ? err.message : "Failed to start Codex turn";
    broadcastEvent(managed, {
      type: "error",
      message,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
  }
}

export function stopSession(managed: ManagedSession, sessionId: string) {
  const localTurnIsRunning =
    hasRunningTurn(sessionId) || getSessionStatus(sessionId) === "running";
  if (!localTurnIsRunning) {
    return;
  }

  if (managed.runtime === "codex-app-server") {
    const threadId = managed.codexThreadId;
    const turnId = managed.codexActiveTurnId;
    managed.codexActiveTurnId = null;
    managed.codexStopRequested = true;
    managed.codexStoppingTurnId = turnId ?? null;
    if (threadId && turnId) {
      void interruptCodexTurn(managed, turnId);
    }
  } else if (managed.adapter && managed.handle) {
    managed.adapter.stopTurn(managed.handle);
  }

  stopTurn(sessionId);
  updateSessionStatus(sessionId, "stopped");
  const seq = nextSeq(managed);
  broadcastEvent(managed, { type: "status", status: "stopped", seq });
  notifyTurnTerminated(sessionId, "stopped");
}

function handleCodexAppServerMessage(
  managed: ManagedSession,
  sessionId: string,
  message: AppServerMessage,
) {
  const method = message.method;
  const params = message.params ?? {};

  if (
    method?.startsWith("item/") &&
    (managed.codexStopRequested || !hasRunningTurn(sessionId))
  ) {
    return;
  }

  if (method === "item/agentMessage/delta") {
    broadcastEvent(managed, {
      type: "text_delta",
      text: String(params.delta ?? ""),
      seq: nextSeq(managed),
    });
    return;
  }

  if (method === "turn/started") {
    if (params.turn?.id) {
      if (managed.codexStopRequested) {
        managed.codexStoppingTurnId = params.turn.id;
        void interruptCodexTurn(managed, params.turn.id);
        return;
      }
      if (getSessionStatus(sessionId) === "running") {
        managed.codexActiveTurnId = params.turn.id;
      }
    }
    return;
  }

  if (method === "item/started") {
    const toolUse = normalizeToolUse(params.item);
    if (toolUse) {
      broadcastEvent(managed, {
        type: "tool_use",
        tool: toolUse.tool,
        input: toolUse.input,
        seq: nextSeq(managed),
      });
    }
    return;
  }

  if (method === "item/completed") {
    const item = params.item;
    if (item?.type === "agentMessage") {
      const content = String(item.text ?? "");
      const externalId = managed.codexThreadId && params.turnId && item.id
        ? `${managed.codexThreadId}:${params.turnId}:${item.id}`
        : undefined;
      persistMessage(sessionId, "assistant", content, undefined, externalId);
      broadcastEvent(managed, {
        type: "message_complete",
        role: "assistant",
        content,
        seq: nextSeq(managed),
      });
    }
    return;
  }

  if (method === "turn/completed") {
    if (!hasRunningTurn(sessionId)) {
      managed.codexActiveTurnId = null;
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      return;
    }
    completeCodexTurnFromNotification(managed, sessionId, params.turn);
    return;
  }

  if (method === "thread/compacted") {
    if (!hasRunningTurn(sessionId)) {
      managed.codexActiveTurnId = null;
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      return;
    }
    managed.codexActiveTurnId = null;
    managed.codexStopRequested = false;
    managed.codexStoppingTurnId = null;
    completeTurn(sessionId);
    updateSessionStatus(sessionId, "idle");
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "complete");
    return;
  }

  if (method === "error") {
    const errMessage = String(params.message ?? "Codex app-server error");
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    managed.codexActiveTurnId = null;
    managed.codexStopRequested = false;
    managed.codexStoppingTurnId = null;
    broadcastEvent(managed, {
      type: "error",
      message: errMessage,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
    if (params.localFatal) {
      removeManaged(sessionId);
    }
  }
}

async function interruptCodexTurn(managed: ManagedSession, turnId: string) {
  if (!managed.codexThreadId) return;
  try {
    const client = await getCodexAppServerClient();
    await client.request("turn/interrupt", {
      threadId: managed.codexThreadId,
      turnId,
    });
  } catch {
    // Stop is best-effort. The local Cockpit state has already moved to
    // stopped, and a late completion notification is ignored when no running
    // Cockpit turn remains.
  } finally {
    // Do not clear codexStopRequested here. It is a guard that prevents a new
    // prompt from starting on the same app-server thread until the terminal
    // turn/completed notification arrives (or a local slash command observes
    // that its Cockpit turn was stopped).
  }
}

function normalizeToolUse(item: any): { tool: string; input: unknown } | null {
  switch (item?.type) {
    case "commandExecution":
      return {
        tool: "command",
        input: { command: item.command, cwd: item.cwd },
      };
    case "fileChange":
      return { tool: "fileChange", input: { changes: item.changes } };
    case "mcpToolCall":
      return {
        tool: `${item.server ?? "mcp"}/${item.tool ?? "tool"}`,
        input: item.arguments ?? {},
      };
    case "dynamicToolCall":
      return {
        tool: item.namespace ? `${item.namespace}/${item.tool}` : item.tool ?? "tool",
        input: item.arguments ?? {},
      };
    case "webSearch":
      return { tool: "webSearch", input: { query: item.query } };
    case "contextCompaction":
      return { tool: "contextCompaction", input: { status: "inProgress" } };
    case "enteredReviewMode":
      return { tool: "review", input: { status: "entered" } };
    case "exitedReviewMode":
      return { tool: "review", input: { status: "exited" } };
    default:
      return null;
  }
}

function completeCodexTurnFromNotification(
  managed: ManagedSession,
  sessionId: string,
  turn: any,
) {
  const status = turn?.status;
  managed.codexActiveTurnId = null;
  managed.codexStopRequested = false;
  managed.codexStoppingTurnId = null;

  if (status === "completed") {
    completeTurn(sessionId);
    updateSessionStatus(sessionId, "idle");
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "complete");
    return;
  }

  if (status === "interrupted") {
    stopTurn(sessionId);
    updateSessionStatus(sessionId, "stopped");
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "stopped",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "stopped");
    return;
  }

  failTurn(sessionId);
  updateSessionStatus(sessionId, "error");
  const message = turn?.error?.message ?? "Codex turn failed";
  broadcastEvent(managed, {
    type: "error",
    message,
    seq: nextSeq(managed),
  });
  broadcastEvent(managed, {
    type: "status",
    status: "error",
    seq: nextSeq(managed),
  });
  notifyTurnTerminated(sessionId, "error");
}

async function handleSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  turnId: string,
  content: string,
) {
  try {
    const result = await runSlashCommand(managed, sessionId, content);
    if (!isTurnRunning(turnId) || getSessionStatus(sessionId) !== "running") {
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      return;
    }

    if (result.type === "codex-turn") {
      if (result.codexTurnId) {
        if (managed.codexStopRequested) {
          managed.codexStoppingTurnId = result.codexTurnId;
          await interruptCodexTurn(managed, result.codexTurnId);
          return;
        }
        managed.codexActiveTurnId = result.codexTurnId;
      }
      return;
    }

    const reply = result.content;
    persistMessage(sessionId, "assistant", reply, turnId);
    completeTurn(sessionId);
    updateSessionStatus(sessionId, "idle");
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "message_complete",
      role: "assistant",
      content: reply,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
  } catch (err) {
    if (!isTurnRunning(turnId) || getSessionStatus(sessionId) === "stopped") {
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      return;
    }
    const message = err instanceof Error ? err.message : "Slash command failed";
    persistMessage(sessionId, "assistant", `Slash command failed: ${message}`, turnId);
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    broadcastEvent(managed, {
      type: "error",
      message,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
  }
}

async function handleNonCodexSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  turnId: string,
  content: string,
) {
  try {
    const reply = await runNonCodexSlashCommand(managed, sessionId, content);
    if (!isTurnRunning(turnId) || getSessionStatus(sessionId) !== "running") {
      return;
    }
    persistMessage(sessionId, "assistant", reply, turnId);
    completeTurn(sessionId);
    updateSessionStatus(sessionId, "idle");
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "message_complete",
      role: "assistant",
      content: reply,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Slash command failed";
    persistMessage(sessionId, "assistant", `Slash command failed: ${message}`, turnId);
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    broadcastEvent(managed, {
      type: "error",
      message,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
  }
}

async function runNonCodexSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  content: string,
): Promise<string> {
  const trimmed = content.trim();
  const [command] = trimmed.split(/\s+/, 1);
  const definition = findSlashCommandDefinition(command.toLowerCase());
  const canonical = definition?.command ?? command.toLowerCase();

  switch (canonical) {
    case "/help":
      return slashHelp();
    case "/status":
      return slashBasicStatus(sessionId);
    case "/model":
      return slashModels();
    case "/permissions":
      return slashPermissions(sessionId);
    case "/mcp":
      return slashMcp(trimmed.slice(command.length).trim());
    case "/diff":
      return slashDiff(sessionId);
    case "/debug-config":
      return slashDebugConfig(managed, sessionId);
    case "/experimental":
      return slashExperimental();
    case "/skills":
      return slashSkills(sessionId);
    case "/hooks":
      return slashHooks(sessionId);
    case "/apps":
      return slashApps(managed);
    case "/plugins":
      return slashPlugins(sessionId);
    case "/rename":
      return slashRenameCockpitOnly(sessionId, trimmed.slice(command.length).trim());
    case "/copy":
      return slashCopyLastAssistantMessage(sessionId);
    case "/new":
    case "/clear":
      return slashNewSession(sessionId, trimmed.slice(command.length).trim());
    case "/resume":
    case "/sessions":
      return slashResume(sessionId, trimmed.slice(command.length).trim());
    default:
      if (definition) {
        return [
          `\`${definition.command}\` is a native Codex slash command, but this session is not running on the Codex app-server runtime.`,
          "",
          "Agent Cockpit recognized the command and did not forward it to the model. Switch this session to Codex to use Codex-native slash commands.",
        ].join("\n");
      }
      return `${unsupportedSlash(content)}\n\n${slashHelp()}`;
  }
}

type SlashCommandResult =
  | { type: "message"; content: string }
  | { type: "codex-turn"; codexTurnId?: string | null };

async function runSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  content: string,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  const [command] = trimmed.split(/\s+/, 1);
  const normalized = command.toLowerCase();
  const args = trimmed.slice(command.length).trim();
  const definition = findSlashCommandDefinition(normalized);
  const canonical = definition?.command ?? normalized;

  switch (canonical) {
    case "/help":
      return messageResult(slashHelp());
    case "/status":
      return messageResult(await slashStatus(managed, sessionId));
    case "/model":
      return messageResult(await slashModels());
    case "/permissions":
      return messageResult(await slashPermissions(sessionId));
    case "/mcp":
      return messageResult(await slashMcp(args));
    case "/diff":
      return messageResult(await slashDiff(sessionId));
    case "/debug-config":
      return messageResult(await slashDebugConfig(managed, sessionId));
    case "/experimental":
      return messageResult(await slashExperimental());
    case "/skills":
      return messageResult(await slashSkills(sessionId));
    case "/hooks":
      return messageResult(await slashHooks(sessionId));
    case "/apps":
      return messageResult(await slashApps(managed));
    case "/plugins":
      return messageResult(await slashPlugins(sessionId));
    case "/rename":
      return messageResult(await slashRename(managed, sessionId, args));
    case "/copy":
      return messageResult(await slashCopyLastAssistantMessage(sessionId));
    case "/new":
    case "/clear":
      return messageResult(await slashNewSession(sessionId, args));
    case "/resume":
    case "/sessions":
      return messageResult(await slashResume(sessionId, args));
    case "/fork":
      return messageResult(await slashFork(managed, sessionId));
    case "/goal":
      return messageResult(await slashGoal(managed, args));
    case "/review":
      return slashReview(managed, args);
    case "/compact":
      return slashCompact(managed);
    case "/stop":
      return messageResult(await slashStopBackgroundTerminals(managed));
    default:
      if (definition) {
        return messageResult(recognizedNativeSlash(definition.command));
      }
      return messageResult(`${unsupportedSlash(content)}\n\n${slashHelp()}`);
  }
}

function messageResult(content: string): SlashCommandResult {
  return { type: "message", content };
}

function slashHelp(): string {
  const supportLabel = {
    local: "Cockpit",
    "codex-app-server": "Codex",
    recognized: "recognized",
  } as const;
  const categories = [
    "workflow",
    "session",
    "configuration",
    "information",
    "integration",
    "ui",
    "debug",
  ] as const;

  return [
    "## Slash commands",
    "",
    "Agent Cockpit recognizes the native Codex slash-command catalog. Commands marked `Codex` start the matching app-server operation; commands marked `recognized` are TUI/desktop-only today and are not sent to the model by accident.",
    "",
    ...categories.flatMap((category) => {
      const commands = SLASH_COMMANDS.filter((command) => command.category === category);
      if (!commands.length) return [];
      return [
        `### ${category}`,
        "",
        ...commands.map((command) => {
          const aliases = command.aliases?.length
            ? ` (${command.aliases.join(", ")})`
            : "";
          return `- \`${command.command}\`${aliases} — ${command.description} _${supportLabel[command.support]}_`;
        }),
        "",
      ];
    }),
  ].join("\n");
}

function unsupportedSlash(content: string): string {
  const command = content.trim().split(/\s+/, 1)[0] || "/";
  return `Unsupported slash command: \`${command}\`.`;
}

function recognizedNativeSlash(command: string): string {
  return [
    `\`${command}\` is a native Codex slash command and Agent Cockpit now recognizes it.`,
    "",
    "This command depends on Codex TUI/desktop UI state that Cockpit does not expose yet, so it was not forwarded to the model. Use `/help` to see which commands are currently mapped to Cockpit or Codex app-server operations.",
  ].join("\n");
}

function optionalNativeCommandUnavailable(command: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `\`${command}\` is a native Codex slash command, but this Codex app-server does not expose the matching API in the currently installed version.`,
    "",
    `App-server response: ${message}`,
  ].join("\n");
}

async function slashStatus(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT agent, cwd, status, cli_session_id as cliSessionId, updated_at as updatedAt
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as any;
  const client = await getCodexAppServerClient();
  const [accountResult, modelsResult] = await Promise.allSettled([
    client.request("account/read", { refreshToken: false }),
    client.request("model/list", { limit: 20, includeHidden: false }),
  ]);

  const defaultModel =
    modelsResult.status === "fulfilled"
      ? (modelsResult.value?.data ?? []).find((m: any) => m.isDefault) ??
        (modelsResult.value?.data ?? [])[0]
      : null;
  const account = accountResult.status === "fulfilled" ? accountResult.value?.account : null;

  return [
    "## Status",
    "",
    `- Cockpit session: \`${sessionId}\``,
    `- Agent: \`${session?.agent ?? "unknown"}\``,
    `- Cockpit status: \`${session?.status ?? "unknown"}\``,
    `- Codex thread: \`${managed.codexThreadId ?? session?.cliSessionId ?? "unknown"}\``,
    `- CWD: \`${session?.cwd ?? "repo default"}\``,
    defaultModel
      ? `- Default model: \`${defaultModel.displayName ?? defaultModel.id}\``
      : "- Default model: unavailable",
    account?.type
      ? `- Auth: \`${account.type}\`${account.planType ? ` (${account.planType})` : ""}`
      : "- Auth: unavailable",
    `- Updated: ${session?.updatedAt ?? "unknown"}`,
  ].join("\n");
}

function slashBasicStatus(sessionId: string): string {
  const session = getDb()
    .prepare(
      `SELECT agent, cwd, status, cli_session_id as cliSessionId, updated_at as updatedAt
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as any;

  return [
    "## Status",
    "",
    `- Cockpit session: \`${sessionId}\``,
    `- Agent: \`${session?.agent ?? "unknown"}\``,
    `- Cockpit status: \`${session?.status ?? "unknown"}\``,
    `- CLI session: \`${session?.cliSessionId ?? "unknown"}\``,
    `- CWD: \`${session?.cwd ?? "repo default"}\``,
    `- Updated: ${session?.updatedAt ?? "unknown"}`,
  ].join("\n");
}

async function slashModels(): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("model/list", {
    limit: 50,
    includeHidden: false,
  });
  const models = result?.data ?? [];
  if (!models.length) return "No visible Codex models returned by app-server.";

  return [
    "## Visible Codex models",
    "",
    ...models.map((model: any) => {
      const markers = [
        model.isDefault ? "default" : null,
        model.defaultReasoningEffort ? `effort: ${model.defaultReasoningEffort}` : null,
      ].filter(Boolean);
      return `- \`${model.displayName ?? model.id}\` (${model.id})${
        markers.length ? ` — ${markers.join(", ")}` : ""
      }`;
    }),
  ].join("\n");
}

async function slashPermissions(sessionId: string): Promise<string> {
  let config: any = null;
  try {
    const client = await getCodexAppServerClient();
    config = await client.request("config/read", {
      cwd: getSessionCwd(sessionId),
    });
  } catch {
    // Non-Codex sessions can still report the Cockpit launch-time defaults.
  }

  const effective = config?.effectiveValue ?? config?.effective ?? config ?? {};
  const sandbox =
    effective.sandboxMode ??
    effective.sandbox ??
    effective.sandbox_policy ??
    "danger-full-access";
  const approval =
    effective.approvalPolicy ??
    effective.approval_policy ??
    "never";
  const reviewer =
    effective.approvalsReviewer ??
    effective.approvals_reviewer ??
    "user";

  return [
    "## Permissions",
    "",
    "Cockpit launches Codex sessions with these defaults:",
    "",
    `- Approval policy: ${inlineCode(String(approval))}`,
    `- Sandbox: ${inlineCode(String(sandbox))}`,
    `- Approval reviewer: ${inlineCode(String(reviewer))}`,
    "",
    "Changing permissions interactively is not exposed yet; start a new Cockpit session after changing server/config defaults.",
  ].join("\n");
}

async function slashMcp(args = ""): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("mcpServerStatus/list", {
    limit: 50,
    detail: args.trim().toLowerCase() === "verbose" ? "tools" : "toolsAndAuthOnly",
  });
  const servers = result?.data ?? [];
  if (!servers.length) return "No MCP servers returned by app-server.";

  return [
    "## MCP servers",
    "",
    ...servers.flatMap((server: any) => {
      const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
      const status = server.status ?? server.startupStatus ?? "unknown";
      const line = `- \`${server.name ?? "unnamed"}\` — ${status}, ${toolCount} tools`;
      if (args.trim().toLowerCase() !== "verbose" || !toolCount) return [line];
      return [
        line,
        ...server.tools.map((tool: any) => `  - \`${tool.name ?? tool}\``),
      ];
    }),
  ].join("\n");
}

async function slashDiff(sessionId: string): Promise<string> {
  const cwd = getSessionCwd(sessionId);
  const [status, unstaged, staged] = await Promise.all([
    runGit(cwd, ["status", "--short"]),
    runGit(cwd, ["diff", "--stat"]),
    runGit(cwd, ["diff", "--cached", "--stat"]),
  ]);

  return [
    "## Git diff",
    "",
    `- CWD: \`${cwd}\``,
    "",
    "### Status",
    "",
    codeBlock(status || "No changed files."),
    "",
    "### Unstaged diff stat",
    "",
    codeBlock(unstaged || "No unstaged diff."),
    "",
    "### Staged diff stat",
    "",
    codeBlock(staged || "No staged diff."),
  ].join("\n");
}

async function slashDebugConfig(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  const status = await slashStatus(managed, sessionId);
  const client = await getCodexAppServerClient();
  const config = await client.request("config/read", {
    cwd: getSessionCwd(sessionId),
  });
  return [
    status,
    "",
    "## Config",
    "",
    codeBlock(JSON.stringify(config, null, 2), "json"),
  ].join("\n");
}

async function slashExperimental(): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("experimentalFeature/list", { limit: 50 });
  const features = result?.data ?? [];
  if (!features.length) return "No experimental features returned by app-server.";
  return [
    "## Experimental features",
    "",
    ...features.map((feature: any) => {
      const enabled = feature.enabled ? "enabled" : "disabled";
      const stage = feature.stage ? `, ${feature.stage}` : "";
      return `- \`${feature.name}\` — ${enabled}${stage}${
        feature.description ? ` — ${feature.description}` : ""
      }`;
    }),
  ].join("\n");
}

async function slashSkills(sessionId: string): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("skills/list", {
    cwds: [getSessionCwd(sessionId)],
    forceReload: false,
  });
  const skills = result?.data ?? [];
  if (!skills.length) return "No skills returned by app-server.";
  return [
    "## Skills",
    "",
    ...skills.slice(0, 80).map((skill: any) => {
      const name = skill.name ?? skill.id ?? skill.path ?? "unnamed";
      const source = skill.source ? ` — ${skill.source}` : "";
      return `- \`${name}\`${source}`;
    }),
  ].join("\n");
}

async function slashHooks(sessionId: string): Promise<string> {
  const client = await getCodexAppServerClient();
  let result: any;
  try {
    result = await client.request("hooks/list", {
      cwds: [getSessionCwd(sessionId)],
    });
  } catch (err) {
    return optionalNativeCommandUnavailable("/hooks", err);
  }
  const hooks = result?.data ?? [];
  if (!hooks.length) return "No hooks returned by app-server.";
  return [
    "## Hooks",
    "",
    ...hooks.map((hook: any) => `- \`${hook.name ?? hook.event ?? "hook"}\``),
  ].join("\n");
}

async function slashApps(managed: ManagedSession): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("app/list", {
    limit: 50,
    threadId: managed.codexThreadId ?? null,
    forceRefetch: false,
  });
  const apps = result?.data ?? [];
  if (!apps.length) return "No apps returned by app-server.";
  return [
    "## Apps",
    "",
    ...apps.map((app: any) => {
      const status = app.authStatus ?? app.status ?? (app.connected ? "connected" : "available");
      return `- \`${app.name ?? app.displayName ?? app.id ?? "unnamed"}\` — ${status}`;
    }),
  ].join("\n");
}

async function slashPlugins(sessionId: string): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("plugin/list", {
    cwds: [getSessionCwd(sessionId)],
  });
  const marketplaces = result?.marketplaces ?? [];
  if (!marketplaces.length) return "No plugin marketplaces returned by app-server.";
  return [
    "## Plugins",
    "",
    ...marketplaces.flatMap((marketplace: any) => {
      const plugins = marketplace.plugins ?? marketplace.entries ?? [];
      const title = `- ${marketplace.name ?? marketplace.path ?? "marketplace"} — ${plugins.length} plugins`;
      return [
        title,
        ...plugins
          .slice(0, 20)
          .map((plugin: any) => `  - \`${plugin.name ?? plugin.id ?? "plugin"}\``),
      ];
    }),
  ].join("\n");
}

async function slashRename(
  managed: ManagedSession,
  sessionId: string,
  name: string,
): Promise<string> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "Usage: `/rename <thread name>`";
  }
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  await client.request("thread/name/set", {
    threadId: managed.codexThreadId,
    name: trimmedName,
  });
  getDb()
    .prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(trimmedName, sessionId);
  return `Renamed current thread to **${trimmedName}**.`;
}

function slashRenameCockpitOnly(sessionId: string, name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "Usage: `/rename <session name>`";
  }
  getDb()
    .prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(trimmedName, sessionId);
  return `Renamed current Cockpit session to **${trimmedName}**.`;
}

function slashCopyLastAssistantMessage(sessionId: string): string {
  const row = getDb()
    .prepare(
      `SELECT assistant.content
       FROM messages assistant
       JOIN messages user
         ON user.turn_id = assistant.turn_id
        AND user.role = 'user'
       WHERE assistant.session_id = ?
         AND assistant.role = 'assistant'
         AND user.content NOT LIKE '/%'
       ORDER BY assistant.created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { content?: string } | undefined;

  if (!row?.content) {
    return "No assistant response is available to copy yet.";
  }

  return [
    "## Last assistant response",
    "",
    "Copy the markdown below:",
    "",
    codeBlock(row.content, "markdown"),
  ].join("\n");
}

function slashNewSession(sessionId: string, name: string): string {
  const db = getDb();
  const current = db
    .prepare(
      `SELECT repo_id as repoId, agent, cwd
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId) as
    | { repoId: string; agent: string; cwd: string | null }
    | undefined;

  if (!current) return "Current Cockpit session was not found.";

  const newSessionId = nanoid();
  const trimmedName = name.trim();
  db.prepare(
    `INSERT INTO sessions (id, repo_id, agent, cwd, name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    newSessionId,
    current.repoId,
    current.agent,
    current.cwd ?? null,
    trimmedName || null,
  );

  const title = trimmedName || `Session ${newSessionId.slice(0, 8)}`;
  return [
    "## New Cockpit session",
    "",
    `Created [${escapeMarkdownLinkText(title)}](/session/${encodeURIComponent(
      newSessionId,
    )}) in the same repo.`,
    "",
    "Open the link to switch to the clean session.",
  ].join("\n");
}

async function slashFork(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  const forked = await client.request("thread/fork", {
    threadId: managed.codexThreadId,
    excludeTurns: true,
    persistExtendedHistory: true,
  });

  const thread = forked?.thread ?? forked;
  const forkedThreadId = thread?.id;
  if (!forkedThreadId) {
    return "Codex did not return a forked thread id.";
  }

  const db = getDb();
  const current = db
    .prepare(
      `SELECT repo_id as repoId, agent, cwd, name
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId) as
    | { repoId: string; agent: string; cwd: string | null; name: string | null }
    | undefined;
  if (!current) return "Current Cockpit session was not found.";

  const newSessionId = nanoid();
  const forkName = current.name ? `Fork of ${current.name}` : `Fork ${newSessionId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO sessions (id, repo_id, agent, cli_session_id, cwd, name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    newSessionId,
    current.repoId,
    current.agent,
    forkedThreadId,
    current.cwd ?? null,
    forkName,
  );

  return [
    "## Forked session",
    "",
    `Created [${escapeMarkdownLinkText(forkName)}](/session/${encodeURIComponent(
      newSessionId,
    )}) from the current Codex thread.`,
    "",
    `- Codex thread: ${inlineCode(forkedThreadId)}`,
  ].join("\n");
}

type SlashResumeRow = {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  agent: string;
  cwd: string | null;
  name: string | null;
  status: string;
  updatedAt: string;
};

async function slashResume(sessionId: string, args: string): Promise<string> {
  const query = args.trim().toLowerCase();
  const db = getDb();
  const current = db
    .prepare("SELECT repo_id as repoId FROM sessions WHERE id = ?")
    .get(sessionId) as { repoId?: string } | undefined;

  const rows = db
    .prepare(
      `SELECT s.id, s.repo_id as repoId, r.name as repoName, r.path as repoPath,
              s.agent, s.cwd, s.name, s.status, s.updated_at as updatedAt
       FROM sessions s
       JOIN repos r ON r.id = s.repo_id
       ORDER BY
         CASE WHEN s.repo_id = ? THEN 0 ELSE 1 END,
         s.updated_at DESC
       LIMIT 100`,
    )
    .all(current?.repoId ?? "") as SlashResumeRow[];

  const matches = query
    ? rows.filter((row) => {
        const haystack = [
          row.id,
          row.name,
          row.repoName,
          row.repoPath,
          row.cwd,
          row.agent,
          row.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : rows;

  const shown = matches.slice(0, 20);
  if (!shown.length) {
    return [
      "## Resume sessions",
      "",
      query
        ? `No Cockpit sessions matched \`${escapeMarkdownInline(args.trim())}\`.`
        : "No Cockpit sessions found.",
      "",
      "Usage: `/resume` or `/resume <session name, repo, or id>`",
    ].join("\n");
  }

  return [
    "## Resume sessions",
    "",
    query
      ? `Showing ${shown.length} of ${matches.length} matches for \`${escapeMarkdownInline(args.trim())}\`.`
      : `Showing ${shown.length} recent Cockpit sessions.`,
    "",
    ...shown.map((row) => {
      const title = row.name?.trim() || `Session ${row.id.slice(0, 8)}`;
      const currentMarker = row.id === sessionId ? " _(current)_" : "";
      const cwd = row.cwd ? ` · ${inlineCode(row.cwd)}` : "";
      return `- [${escapeMarkdownLinkText(title)}](/session/${encodeURIComponent(
        row.id,
      )})${currentMarker} — ${inlineCode(row.repoName)} · ${inlineCode(
        row.agent,
      )} · ${inlineCode(row.status)} · ${formatUpdated(row.updatedAt)}${cwd}`;
    }),
    matches.length > shown.length
      ? `\n_${matches.length - shown.length} more hidden. Narrow it with \`/resume <query>\`._`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function slashGoal(managed: ManagedSession, args: string): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  const trimmed = args.trim();

  try {
    if (!trimmed) {
      const result = await client.request("thread/goal/get", {
        threadId: managed.codexThreadId,
      });
      const goal = result?.goal;
      if (!goal) {
        return "No goal is set. Use `/goal <objective>` to set one.";
      }
      return [
        "## Goal",
        "",
        `- Objective: ${goal.objective}`,
        `- Status: \`${goal.status ?? "unknown"}\``,
        goal.tokenBudget ? `- Token budget: ${goal.tokenBudget}` : null,
        typeof goal.tokensUsed === "number" ? `- Tokens used: ${goal.tokensUsed}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }

    const lowered = trimmed.toLowerCase();
    if (lowered === "clear") {
      const result = await client.request("thread/goal/clear", {
        threadId: managed.codexThreadId,
      });
      return result?.cleared ? "Cleared the current goal." : "No goal was set.";
    }

    if (lowered === "pause" || lowered === "resume") {
      const status = lowered === "pause" ? "paused" : "active";
      const result = await client.request("thread/goal/set", {
        threadId: managed.codexThreadId,
        status,
      });
      return `Goal status is now \`${result?.goal?.status ?? status}\`.`;
    }

    const result = await client.request("thread/goal/set", {
      threadId: managed.codexThreadId,
      objective: trimmed,
      status: "active",
    });
    return `Set goal: **${result?.goal?.objective ?? trimmed}**.`;
  } catch (err) {
    return optionalNativeCommandUnavailable("/goal", err);
  }
}

async function slashReview(
  managed: ManagedSession,
  args: string,
): Promise<SlashCommandResult> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  const result = await client.request("review/start", {
    threadId: managed.codexThreadId,
    target: parseReviewTarget(args),
  });
  return { type: "codex-turn", codexTurnId: result?.turn?.id ?? null };
}

async function slashCompact(managed: ManagedSession): Promise<SlashCommandResult> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  await client.request("thread/compact/start", {
    threadId: managed.codexThreadId,
  });
  return { type: "codex-turn" };
}

async function slashStopBackgroundTerminals(
  managed: ManagedSession,
): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  await client.request("thread/backgroundTerminals/clean", {
    threadId: managed.codexThreadId,
  });
  return "Requested Codex to stop all background terminals.";
}

function parseReviewTarget(args: string): any {
  const trimmed = args.trim();
  if (!trimmed) return { type: "uncommittedChanges" };

  const baseMatch = trimmed.match(/^(?:base|--base|-b)\s+(.+)$/i);
  if (baseMatch?.[1]) {
    return { type: "baseBranch", branch: baseMatch[1].trim() };
  }

  const commitMatch = trimmed.match(/^(?:commit|--commit)\s+([^\s]+)(?:\s+(.+))?$/i);
  if (commitMatch?.[1]) {
    return {
      type: "commit",
      sha: commitMatch[1],
      title: commitMatch[2]?.trim() || null,
    };
  }

  return { type: "custom", instructions: trimmed };
}

function getSessionCwd(sessionId: string): string {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(s.cwd, r.path) as cwd
       FROM sessions s
       JOIN repos r ON r.id = s.repo_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as { cwd?: string } | undefined;
  return row?.cwd ?? process.cwd();
}

async function runGit(cwd: string, args: string): Promise<string>;
async function runGit(cwd: string, args: string[]): Promise<string>;
async function runGit(cwd: string, args: string | string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", Array.isArray(args) ? args : [args], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || stderr).trim();
  } catch (err: any) {
    return String(err?.stdout || err?.stderr || err?.message || "git command failed").trim();
  }
}

function codeBlock(content: string, language = ""): string {
  return [`\`\`\`${language}`, content.replace(/```/g, "`\u200b``"), "```"].join("\n");
}

function inlineCode(value: string): string {
  return `\`${String(value).replace(/`/g, "`\u200b")}\``;
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/[`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]\\]/g, "\\$&");
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}


function maybeAutoTitleSession(
  managed: ManagedSession,
  sessionId: string,
  content: string,
) {
  const db = getDb();
  const row = db
    .prepare("SELECT name FROM sessions WHERE id = ?")
    .get(sessionId) as { name: string | null } | undefined;

  if (row?.name?.trim()) return;

  const title = createTitleFromPrompt(content);
  if (!title) return;

  db.prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, sessionId);

  broadcastEvent(managed, {
    type: "session_updated",
    sessionId,
    name: title,
    seq: nextSeq(managed),
  });
}

function createTitleFromPrompt(content: string): string {
  const firstMeaningfulLine = content
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/u, "")
        .replace(/[`*_~[\]()]/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find(Boolean);

  if (!firstMeaningfulLine) return "";

  if ([...firstMeaningfulLine].length <= AUTO_TITLE_MAX_LENGTH) {
    return firstMeaningfulLine;
  }

  return [...firstMeaningfulLine].slice(0, AUTO_TITLE_MAX_LENGTH - 1).join("").trimEnd() + "…";
}

function createRunningTurn(sessionId: string, content: string): string {
  const db = getDb();
  const turnSeq = getNextTurnSeq(sessionId);
  const turnId = nanoid();
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, status) VALUES (?, ?, ?, 'running')",
  ).run(turnId, sessionId, turnSeq);
  persistMessage(sessionId, "user", content, turnId);
  return turnId;
}

function reconcileCodexThreadStatus(
  sessionId: string,
  threadStatusType: string | null,
) {
  if (threadStatusType !== "idle") return;
  if (getSessionStatus(sessionId) !== "running" || !hasRunningTurn(sessionId)) {
    return;
  }

  // The app-server thread is already idle, but Cockpit still has a running
  // turn. This can happen when the local server restarts or previously closes
  // the WebSocket before observing the terminal turn notification. Mark the
  // local turn complete so reconnecting clients do not get stuck in a
  // permanent "running/connecting" state.
  completeTurn(sessionId);
  updateSessionStatus(sessionId, "idle");
}

function getNextTurnSeq(sessionId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(seq) as maxSeq FROM turns WHERE session_id = ?")
    .get(sessionId) as any;
  return (row?.maxSeq ?? 0) + 1;
}

function persistMessage(
  sessionId: string,
  role: string,
  content: string,
  turnId?: string,
  externalId?: string,
) {
  const db = getDb();
  const id = nanoid();
  const resolvedTurnId =
    turnId ??
    (
      db
        .prepare(
          "SELECT id FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(sessionId) as any
    )?.id ??
    null;

  if (externalId) {
    const existing = db
      .prepare("SELECT id FROM messages WHERE session_id = ? AND external_id = ?")
      .get(sessionId, externalId);
    if (existing) return;
  }

  db.prepare(
    `INSERT INTO messages (id, session_id, turn_id, role, content, external_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, resolvedTurnId, role, content, externalId ?? null);
}

function completeTurn(sessionId: string, cost?: number) {
  const db = getDb();
  db.prepare(
    `UPDATE turns SET status = 'complete', finished_at = datetime('now'),
     cost_usd = COALESCE(?, cost_usd)
     WHERE id = (SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
  ).run(cost ?? null, sessionId);
}

function stopTurn(sessionId: string) {
  const db = getDb();
  db.prepare(
    `UPDATE turns SET status = 'stopped', finished_at = datetime('now')
     WHERE id = (SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
  ).run(sessionId);
}

function failTurn(sessionId: string) {
  const db = getDb();
  db.prepare(
    `UPDATE turns SET status = 'error', finished_at = datetime('now')
     WHERE id = (SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
  ).run(sessionId);
}

function hasRunningTurn(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId);
  return Boolean(row);
}

function isTurnRunning(turnId: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM turns WHERE id = ? AND status = 'running'")
    .get(turnId);
  return Boolean(row);
}

function updateSessionStatus(sessionId: string, status: SessionStatus) {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(status, sessionId);
  broadcastLobby({ type: "session_status", sessionId, status });
}

function getSessionStatus(sessionId: string): SessionStatus | null {
  const row = getDb()
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as { status: SessionStatus } | undefined;
  return row?.status ?? null;
}
