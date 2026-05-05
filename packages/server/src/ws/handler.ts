import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ClientMessage, Message, SnapshotEvent } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import {
  ensureManaged,
  sendPrompt,
  stopSession,
  syncCodexThreadMessages,
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

      // Send initial snapshot or catch-up events
      if (lastSeqParam) {
        const lastSeq = parseInt(lastSeqParam, 10);
        const catchUp = getEventsSince(managed, lastSeq);
        if (catchUp) {
          for (const event of catchUp) {
            socket.send(JSON.stringify(event));
          }
        } else {
          sendSnapshotMsg(socket, sessionId, managed.seq);
        }
      } else {
        sendSnapshotMsg(socket, sessionId, managed.seq);
      }

      // Subscribe to live events
      const listener = (event: any) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(event));
        }
      };
      managed.listeners.add(listener);

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
            if (msg.content?.trim()) {
              const result = sendPrompt(current, sessionId!, msg.content.trim());
              if (!result.ok) {
                socket.send(JSON.stringify({ type: "error", message: result.error, seq: 0 }));
              }
            }
            break;
          case "stop":
            stopSession(current, sessionId!);
            break;
          case "retry": {
            const lastUserMsg = getLastUserMessage(sessionId!);
            if (lastUserMsg) {
              const result = sendPrompt(current, sessionId!, lastUserMsg);
              if (!result.ok) {
                socket.send(JSON.stringify({ type: "error", message: result.error, seq: 0 }));
              }
            }
            break;
          }
          case "sync_messages":
            try {
              await syncCodexThreadMessages(current, sessionId!);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Sync failed";
              broadcastEvent(current, {
                type: "messages_sync_failed",
                message,
                seq: nextSeq(current),
              });
            }
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

function sendSnapshotMsg(socket: WebSocket, sessionId: string, lastSeq: number) {
  const db = getDb();
  const messages = db
    .prepare(
      `SELECT id, session_id as sessionId, turn_id as turnId, role, content,
              created_at as createdAt
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as Message[];

  const session = db
    .prepare("SELECT status, name FROM sessions WHERE id = ?")
    .get(sessionId) as { status?: SnapshotEvent["status"]; name?: string | null } | undefined;

  const snapshot: SnapshotEvent = {
    type: "snapshot",
    messages,
    lastSeq,
    status: session?.status ?? "idle",
    sessionName: session?.name ?? null,
  };

  socket.send(JSON.stringify(snapshot));
}

function getLastUserMessage(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    )
    .get(sessionId) as any;
  return row?.content ?? null;
}
