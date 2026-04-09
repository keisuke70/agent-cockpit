import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { LobbyEvent, LobbySnapshotEvent, SessionStatus } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import {
  addLobbyListener,
  removeLobbyListener,
} from "../process-manager.js";

/**
 * /ws/lobby — single cross-session WebSocket. Broadcasts only session status
 * transitions, not transcript content. Each connecting client receives an
 * initial snapshot of all known session statuses, then receives a
 * `session_status` event whenever any session transitions state.
 */
export async function lobbyRoutes(app: FastifyInstance) {
  app.get(
    "/ws/lobby",
    { websocket: true },
    async (socket: WebSocket) => {
      // Send initial snapshot built from the DB so the client immediately
      // has a complete picture, not just deltas going forward.
      const db = getDb();
      const rows = db
        .prepare("SELECT id, status FROM sessions")
        .all() as { id: string; status: SessionStatus }[];

      const statuses: Record<string, SessionStatus> = {};
      for (const r of rows) statuses[r.id] = r.status;

      const snapshot: LobbySnapshotEvent = {
        type: "lobby_snapshot",
        statuses,
      };
      socket.send(JSON.stringify(snapshot));

      // Subscribe to live transitions
      const listener = (event: LobbyEvent) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(event));
        }
      };
      addLobbyListener(listener);

      socket.on("close", () => {
        removeLobbyListener(listener);
      });
    },
  );
}
