import { nanoid } from "nanoid";
import type { AgentType, ServerEvent, SessionStatus } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import type { CLIAdapter } from "../adapters/base.js";
import { notifyAll } from "../push.js";
import {
  type ManagedSession,
  getManaged,
  setManaged,
  removeManaged,
  nextSeq,
  broadcastEvent,
  broadcastLobby,
} from "../process-manager.js";

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

  const adapter = getAdapter(session.agent);
  const cwd = session.cwd ?? repo.path;
  const handle = await adapter.init({
    cwd,
    cliSessionId: session.cli_session_id ?? undefined,
  });

  managed = {
    sessionId,
    adapter,
    handle,
    seq: 0,
    eventBuffer: [],
    listeners: new Set(),
  };

  setManaged(sessionId, managed);

  // Both Claude and Codex are now one-shot-per-turn (no long-lived process
  // from init). Process listeners are attached in sendPrompt after startTurn.

  return managed;
}

function attachProcessListeners(
  managed: ManagedSession,
  sessionId: string,
  isOneShot: boolean,
) {
  const { handle, adapter } = managed;
  if (!handle.proc?.stdout) return;

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
        managed.handle.cliSessionId = event.sessionId as string;
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
      // One-shot process (codex): normal exit without turn_complete means the
      // turn finished without a structured completion event. Check current status.
      const db = getDb();
      const session = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionId) as any;

      // Only mark stopped if still running (turn_complete/error didn't fire)
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
      // Persistent process (claude): closing means the session is done.
      // Remove managed session so a new one is created on next connect.
      // If a turn was in flight when the persistent process died, also notify
      // the user — they were probably waiting for output that will never come.
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
  // Guard against overlapping prompts
  const db = getDb();
  const session = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as any;

  if (session?.status === "running") {
    return { ok: false, error: "Session is already running" };
  }

  // Create turn
  const turnSeq = getNextTurnSeq(sessionId);
  const turnId = nanoid();
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, status) VALUES (?, ?, ?, 'running')",
  ).run(turnId, sessionId, turnSeq);

  persistMessage(sessionId, "user", content, turnId);
  updateSessionStatus(sessionId, "running");

  const seq = nextSeq(managed);
  broadcastEvent(managed, { type: "status", status: "running", seq });

  // Both Claude and Codex are one-shot-per-turn: startTurn spawns a new process.
  managed.adapter.startTurn(managed.handle, content);

  if (managed.handle.proc) {
    attachProcessListeners(managed, sessionId, true);
  }

  return { ok: true };
}

export function stopSession(managed: ManagedSession, sessionId: string) {
  managed.adapter.stopTurn(managed.handle);
  stopTurn(sessionId);
  updateSessionStatus(sessionId, "stopped");
  const seq = nextSeq(managed);
  broadcastEvent(managed, { type: "status", status: "stopped", seq });
  notifyTurnTerminated(sessionId, "stopped");
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

  db.prepare(
    "INSERT INTO messages (id, session_id, turn_id, role, content) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, resolvedTurnId, role, content);
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

function updateSessionStatus(sessionId: string, status: SessionStatus) {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(status, sessionId);
  // Broadcast to lobby listeners (cross-session). This is the single
  // funnel point for all status transitions in session-bridge.
  broadcastLobby({ type: "session_status", sessionId, status });
}
