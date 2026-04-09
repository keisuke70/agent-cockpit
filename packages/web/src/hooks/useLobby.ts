import { useEffect, useRef, useState, useCallback } from "react";
import type { LobbyEvent, SessionStatus } from "@agent-cockpit/shared";

/**
 * Subscribes to /ws/lobby and returns a live Map<sessionId, SessionStatus>.
 *
 * Single connection, status-only payloads. The map is seeded from the initial
 * lobby_snapshot and updated incrementally on session_status events.
 *
 * Mirrors the reconnect / cleanup pattern of useWebSocket: intentional close
 * tracking + exponential backoff.
 */
export function useLobby(): Map<string, SessionStatus> {
  const [statuses, setStatuses] = useState<Map<string, SessionStatus>>(
    () => new Map(),
  );
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const intentionalClose = useRef(false);

  const connect = useCallback(() => {
    const token = localStorage.getItem("cockpit-token") ?? "";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws/lobby${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (e) => {
      let event: LobbyEvent;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === "lobby_snapshot") {
        const next = new Map<string, SessionStatus>();
        for (const [id, status] of Object.entries(event.statuses)) {
          next.set(id, status);
        }
        setStatuses(next);
      } else if (event.type === "session_status") {
        setStatuses((prev) => {
          const next = new Map(prev);
          next.set(event.sessionId, event.status);
          return next;
        });
      }
    };

    ws.onclose = () => {
      if (intentionalClose.current) return;
      const attempt = reconnectAttempts.current++;
      const delay = Math.min(500 * 2 ** attempt, 30000);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    intentionalClose.current = false;
    reconnectAttempts.current = 0;
    connect();
    return () => {
      intentionalClose.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return statuses;
}
