import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ClientMessage, SnapshotEvent } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import {
  ensureManaged,
  getLastUserMessage,
  listPendingPermissions,
  loadSessionCapabilities,
  listDisplayMessagesForSession,
  refreshDisplayTranscript,
  resolvePermissionRequest,
  retryDesyncedTurn,
  sendPrompt,
  stopSession,
} from "./session-bridge.js";
import {
  broadcastEvent,
  getEventsSince,
  getManaged,
  nextSeq,
  type ManagedSession,
} from "../process-manager.js";

export async function wsRoutes(app: FastifyInstance) {
  app.get(
    "/ws",
    { websocket: true },
    async (socket: WebSocket, req) => {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const sessionId = url.searchParams.get("sessionId");
      const lastSeqParam = url.searchParams.get("lastSeq");

      if (!sessionId) {
        socket.send(JSON.stringify({ type: "error", message: "Missing sessionId", seq: 0 }));
        socket.close();
        return;
      }

      let managed: ManagedSession;
      try {
        managed = await ensureManaged(sessionId);
      } catch (err: any) {
        socket.send(
          JSON.stringify({ type: "error", message: err.message, seq: 0 }),
        );
        socket.close();
        return;
      }

      const queuedEvents: any[] = [];
      let replayReady = false;
      const listener = (event: any) => {
        if (socket.readyState !== 1) return;
        if (!replayReady) {
          queuedEvents.push(event);
          return;
        }
        socket.send(JSON.stringify(event));
      };
      managed.listeners.add(listener);

      const flushQueuedEventsAfter = (
        lastSentSeq: number,
        snapshot?: SnapshotEvent,
      ) => {
        replayReady = true;
        const snapshotAssistantIds = new Set(
          snapshot?.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.id) ?? [],
        );
        let reflectedCompleteSeq = -1;
        for (const event of queuedEvents) {
          const seq = getEventSeq(event);
          if (
            seq !== null &&
            seq > lastSentSeq &&
            isReflectedMessageComplete(event, snapshotAssistantIds)
          ) {
            reflectedCompleteSeq = Math.max(reflectedCompleteSeq, seq);
          }
        }

        for (const event of queuedEvents) {
          const seq = getEventSeq(event);
          if (seq !== null && seq <= lastSentSeq) continue;
          if (shouldSuppressSnapshotReflectedEvent(event, reflectedCompleteSeq)) continue;
          socket.send(JSON.stringify(event));
        }
        queuedEvents.length = 0;
      };

      // Send initial snapshot or catch-up events. The live listener is already
      // installed so an async Codex thread/read snapshot cannot drop turn
      // events that arrive while the snapshot is being assembled.
      const replayStartSeq = managed.seq;
      if (lastSeqParam) {
        const lastSeq = parseInt(lastSeqParam, 10);
        const catchUp = Number.isFinite(lastSeq) ? getEventsSince(managed, lastSeq) : null;
        if (catchUp && catchUp.length > 0 && lastSeq <= managed.seq) {
          let lastSentSeq = lastSeq;
          for (const event of catchUp) {
            socket.send(JSON.stringify(event));
            const seq = getEventSeq(event);
            if (seq !== null) lastSentSeq = Math.max(lastSentSeq, seq);
          }
          flushQueuedEventsAfter(lastSentSeq);
        } else {
          // If there is no catch-up event to send, the client still needs an
          // authoritative status. This is especially important after server
          // restart, where the browser reconnects with an old lastSeq while the
          // new in-memory buffer starts empty; without a snapshot the UI remains
          // stuck in `connecting`.
          const snapshot = await sendSnapshotMsg(socket, managed, sessionId, replayStartSeq);
          flushQueuedEventsAfter(replayStartSeq, snapshot);
        }
      } else {
        const snapshot = await sendSnapshotMsg(socket, managed, sessionId, replayStartSeq);
        flushQueuedEventsAfter(replayStartSeq, snapshot);
      }

      socket.on("message", async (raw: any) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Re-resolve managed session on each command to avoid stale references
        let current;
        try {
          current = await ensureManaged(sessionId!);
        } catch (err: any) {
          socket.send(JSON.stringify({ type: "error", message: err.message, seq: 0 }));
          return;
        }

        // Migrate listener to new managed instance if it changed
        if (current !== managed) {
          managed!.listeners.delete(listener);
          current.listeners.add(listener);
          managed = current;
        }

        switch (msg.type) {
          case "send_prompt":
            if (
              msg.content?.trim() ||
              msg.images?.length ||
              msg.skills?.length ||
              msg.mentions?.length
            ) {
              const result = sendPrompt(current, sessionId!, msg.content ?? "", {
                images: msg.images,
                skills: msg.skills,
                mentions: msg.mentions,
              });
              if (!result.ok) {
                socket.send(JSON.stringify({ type: "error", message: result.error, seq: 0 }));
              }
            }
            break;
          case "stop":
            stopSession(current, sessionId!);
            break;
          case "retry": {
            const lastUserMsg = await getLastUserMessage(current, sessionId!);
            if (lastUserMsg) {
              const result = sendPrompt(current, sessionId!, lastUserMsg, { allowDuplicate: true });
              if (!result.ok) {
                socket.send(JSON.stringify({ type: "error", message: result.error, seq: 0 }));
              }
            }
            break;
          }
          case "retry_desynced_turn": {
            const result = await retryDesyncedTurn(current, sessionId!, msg.turnId);
            if (!result.ok) {
              socket.send(JSON.stringify({ type: "error", message: result.error, seq: 0 }));
            }
            break;
          }
          case "refresh_transcript":
          case "sync_messages":
            try {
              await refreshDisplayTranscript(current, sessionId!);
              broadcastEvent(current, {
                type: "session_capabilities",
                capabilities: await loadSessionCapabilities(current, sessionId!),
                seq: nextSeq(current),
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Refresh failed";
              broadcastEvent(current, {
                type: "transcript_refresh_failed",
                message,
                seq: nextSeq(current),
              });
            }
            break;
          case "approve_permission":
            await resolvePermissionRequest(current, msg.id, "approve");
            break;
          case "approve_permission_for_session":
            await resolvePermissionRequest(current, msg.id, "approve_session");
            break;
          case "reject_permission":
            await resolvePermissionRequest(current, msg.id, "reject", msg.message);
            break;
          case "answer_user_input":
            await resolvePermissionRequest(current, msg.id, "answer", msg.answer);
            break;
        }
      });

      socket.on("close", () => {
        // Clean up from whichever managed instance we're currently subscribed to
        const current = getManaged(sessionId!);
        if (current) {
          current.listeners.delete(listener);
        }
        managed?.listeners.delete(listener);
      });
    },
  );
}

async function sendSnapshotMsg(
  socket: WebSocket,
  managed: ManagedSession,
  sessionId: string,
  lastSeq: number,
): Promise<SnapshotEvent> {
  const db = getDb();
  const display = await listDisplayMessagesForSession(managed, sessionId);

  const session = db
    .prepare("SELECT status, name FROM sessions WHERE id = ?")
    .get(sessionId) as { status?: SnapshotEvent["status"]; name?: string | null } | undefined;

  const snapshot: SnapshotEvent = {
    type: "snapshot",
    messages: display.messages,
    lastSeq,
    status: session?.status ?? "idle",
    sessionName: session?.name ?? display.threadName ?? null,
    transcriptSource: display.source,
    transcriptWarning: display.warning,
    capabilities: await loadSessionCapabilities(managed, sessionId),
    pendingPermissions: listPendingPermissions(managed),
    activeTools: managed.activeTools ?? [],
  };

  socket.send(JSON.stringify(snapshot));
  return snapshot;
}

function getEventSeq(event: unknown): number | null {
  if (
    event &&
    typeof event === "object" &&
    "seq" in event &&
    typeof (event as { seq?: unknown }).seq === "number"
  ) {
    return (event as { seq: number }).seq;
  }
  return null;
}

function isReflectedMessageComplete(
  event: unknown,
  snapshotAssistantIds: Set<string>,
): boolean {
  return Boolean(
    event &&
      typeof event === "object" &&
      "type" in event &&
      (event as { type?: unknown }).type === "message_complete" &&
      "messageId" in event &&
      typeof (event as { messageId?: unknown }).messageId === "string" &&
      snapshotAssistantIds.has((event as { messageId: string }).messageId),
  );
}

function shouldSuppressSnapshotReflectedEvent(
  event: unknown,
  reflectedCompleteSeq: number,
): boolean {
  const seq = getEventSeq(event);
  if (seq === null || reflectedCompleteSeq < 0 || seq > reflectedCompleteSeq) {
    return false;
  }
  if (!event || typeof event !== "object" || !("type" in event)) return false;
  const type = (event as { type?: unknown }).type;
  return type === "text_delta" || type === "tool_use" || type === "message_complete";
}
