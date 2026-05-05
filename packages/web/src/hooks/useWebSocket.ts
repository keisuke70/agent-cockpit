import { useEffect, useRef, useState, useCallback } from "react";
import type { Message, SessionStatus, ServerEvent } from "@agent-cockpit/shared";

export interface ToolActivity {
  tool: string;
  input: unknown;
  timestamp: number;
}

interface UseWebSocketResult {
  messages: Message[];
  streamingText: string;
  /** Currently active tool (e.g. "Bash", "Edit"). Cleared on message_complete. */
  activeTools: ToolActivity[];
  /** Live raw stdout buffer for the embedded terminal Debug view. */
  rawStdout: string;
  status: SessionStatus | "connecting";
  sessionName: string | null | undefined;
  refreshingTranscript: boolean;
  transcriptRefreshError: string;
  sendPrompt: (text: string) => void;
  refreshTranscript: () => void;
  stop: () => void;
  retry: () => void;
}

/** Cap the in-memory raw stdout buffer to keep memory bounded. */
const RAW_STDOUT_MAX_BYTES = 64 * 1024;

export function useWebSocket(sessionId: string): UseWebSocketResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [activeTools, setActiveTools] = useState<ToolActivity[]>([]);
  const [rawStdout, setRawStdout] = useState("");
  const [status, setStatus] = useState<SessionStatus | "connecting">("connecting");
  const [sessionName, setSessionName] = useState<string | null | undefined>(undefined);
  const [refreshingTranscript, setRefreshingTranscript] = useState(false);
  const [transcriptRefreshError, setTranscriptRefreshError] = useState("");
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
          setSessionName(event.sessionName);
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.transcriptWarning ?? "");
          break;

        case "transcript_refreshed":
          setMessages(event.messages);
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.transcriptWarning ?? "");
          break;

        case "transcript_refresh_failed":
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.message);
          break;

        case "text_delta":
          setStreamingText((prev) => prev + event.text);
          break;

        case "message_complete":
          setMessages((prev) => [
            ...prev,
            {
              id: event.messageId ?? crypto.randomUUID(),
              sessionId,
              turnId: null,
              role: event.role,
              content: event.content,
              createdAt: new Date().toISOString(),
            },
          ]);
          setStreamingText("");
          setActiveTools([]);
          break;

        case "status":
          setStatus(event.status);
          if (event.status === "running") {
            setStreamingText("");
          }
          break;

        case "session_updated":
          if (event.sessionId === sessionId) {
            setSessionName(event.name);
          }
          break;

        case "tool_use":
          setActiveTools((prev) => [
            ...prev,
            { tool: event.tool, input: event.input, timestamp: Date.now() },
          ]);
          break;

        case "error":
          setRefreshingTranscript(false);
          setStatus("error");
          break;

        case "turn_complete":
          setActiveTools([]);
          break;

        case "raw_stdout":
          setRawStdout((prev) => {
            const next = prev + event.data;
            if (next.length <= RAW_STDOUT_MAX_BYTES) return next;
            // Truncate from the front, keeping the most recent bytes.
            return next.slice(next.length - RAW_STDOUT_MAX_BYTES);
          });
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
    setActiveTools([]);
    setRawStdout("");
    setStatus("connecting");
    setSessionName(undefined);
    setRefreshingTranscript(false);
    setTranscriptRefreshError("");

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

  const refreshTranscript = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setRefreshingTranscript(true);
    setTranscriptRefreshError("");
    ws.send(JSON.stringify({ type: "refresh_transcript" }));
  }, []);

  const retry = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "retry" }));
  }, []);

  return {
    messages,
    streamingText,
    activeTools,
    rawStdout,
    status,
    sessionName,
    refreshingTranscript,
    sendPrompt,
    refreshTranscript,
    transcriptRefreshError,
    stop,
    retry,
  };
}
