import { useEffect, useRef, useState, useCallback } from "react";
import type { Message, SessionStatus, ServerEvent } from "@agent-cockpit/shared";

interface UseWebSocketResult {
  messages: Message[];
  streamingText: string;
  status: SessionStatus | "connecting";
  sendPrompt: (text: string) => void;
  stop: () => void;
  retry: () => void;
}

export function useWebSocket(sessionId: string): UseWebSocketResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<SessionStatus | "connecting">("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const intentionalClose = useRef(false);

  const connect = useCallback(() => {
    const params = new URLSearchParams({ sessionId });
    if (lastSeqRef.current > 0) {
      params.set("lastSeq", String(lastSeqRef.current));
    }
    const token = localStorage.getItem("cockpit-token");
    if (token) {
      params.set("token", token);
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws?${params}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      reconnectAttempts.current = 0;
      setStatus("idle");
    };

    ws.onmessage = (e) => {
      const event: ServerEvent = JSON.parse(e.data);

      if ("seq" in event && typeof event.seq === "number") {
        lastSeqRef.current = event.seq;
      }

      switch (event.type) {
        case "snapshot":
          setMessages(event.messages);
          setStreamingText("");
          lastSeqRef.current = event.lastSeq;
          setStatus(event.status);
          break;

        case "text_delta":
          setStreamingText((prev) => prev + event.text);
          break;

        case "message_complete":
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              sessionId,
              turnId: null,
              role: event.role,
              content: event.content,
              createdAt: new Date().toISOString(),
            },
          ]);
          setStreamingText("");
          break;

        case "status":
          setStatus(event.status);
          if (event.status === "running") {
            setStreamingText("");
          }
          break;

        case "error":
          setStatus("error");
          break;

        case "turn_complete":
          break;
      }
    };

    ws.onclose = () => {
      if (intentionalClose.current) return;
      setStatus("connecting");
      // Exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 30s (capped)
      const attempt = reconnectAttempts.current++;
      const delay = Math.min(500 * 2 ** attempt, 30000);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [sessionId]);

  useEffect(() => {
    // Reset all per-session state so that switching sessions does not carry
    // over a stale lastSeq / messages / streaming buffer to the new socket.
    intentionalClose.current = false;
    reconnectAttempts.current = 0;
    lastSeqRef.current = 0;
    setMessages([]);
    setStreamingText("");
    setStatus("connecting");

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

  const sendPrompt = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(JSON.stringify({ type: "send_prompt", content: text }));
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sessionId,
          turnId: null,
          role: "user",
          content: text,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    [sessionId],
  );

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
  }, []);

  const retry = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Find last user message to optimistically re-append for transcript continuity
    setMessages((prev) => {
      const lastUser = [...prev].reverse().find((m) => m.role === "user");
      if (!lastUser) return prev;
      return [
        ...prev,
        {
          ...lastUser,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        },
      ];
    });

    ws.send(JSON.stringify({ type: "retry" }));
  }, []);

  return { messages, streamingText, status, sendPrompt, stop, retry };
}
