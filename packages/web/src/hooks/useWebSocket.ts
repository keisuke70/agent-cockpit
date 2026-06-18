import { useEffect, useRef, useState, useCallback } from "react";
import type {
  ActiveToolActivity,
  Message,
  PermissionRequestEvent,
  PromptImageInput,
  PromptMentionInput,
  PromptSkillInput,
  ServerEvent,
  SessionCapabilities,
  SessionStatus,
} from "@agent-cockpit/shared";

export type ToolActivity = ActiveToolActivity;

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
  capabilities: SessionCapabilities | null;
  pendingPermissions: PermissionRequestEvent[];
  sendPrompt: (
    text: string,
    options?: {
      images?: PromptImageInput[];
      skills?: PromptSkillInput[];
      mentions?: PromptMentionInput[];
    },
  ) => void;
  refreshTranscript: () => void;
  stop: () => void;
  retry: () => void;
  retryDesyncedTurn: (turnId: string) => void;
  approvePermission: (id: string) => void;
  approvePermissionForSession: (id: string) => void;
  rejectPermission: (id: string) => void;
  answerUserInput: (id: string, answer: string) => void;
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
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequestEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const optimisticIdsRef = useRef<string[]>([]);
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
      // Do not optimistically report "ready" on TCP/WebSocket open. The
      // authoritative session state arrives in the snapshot/catch-up stream;
      // flipping to idle here makes an actively running Codex turn appear ready
      // during slow transcript reads or reconnects.
    };

    ws.onmessage = (e) => {
      const event: ServerEvent = JSON.parse(e.data);

      if ("seq" in event && typeof event.seq === "number") {
        lastSeqRef.current = event.seq;
      }

      switch (event.type) {
        case "snapshot":
          optimisticIdsRef.current = [];
          setMessages(event.messages);
          setStreamingText("");
          lastSeqRef.current = event.lastSeq;
          setStatus(event.status);
          setSessionName(event.sessionName);
          setCapabilities(event.capabilities ?? null);
          setPendingPermissions(event.pendingPermissions ?? []);
          setActiveTools(event.status === "running" ? event.activeTools ?? [] : []);
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.transcriptWarning ?? "");
          break;

        case "transcript_refreshed":
          optimisticIdsRef.current = [];
          setMessages(event.messages);
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.transcriptWarning ?? "");
          break;

        case "transcript_refresh_failed":
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.message);
          break;

        case "session_capabilities":
          setCapabilities(event.capabilities);
          break;

        case "permission_request":
          setPendingPermissions((prev) => [
            ...prev.filter((request) => request.id !== event.id),
            event,
          ]);
          break;

        case "permission_resolved":
          setPendingPermissions((prev) =>
            prev.filter((request) => request.id !== event.id),
          );
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
            optimisticIdsRef.current = [];
            setStreamingText("");
          } else {
            setActiveTools([]);
          }
          break;

        case "session_updated":
          if (event.sessionId === sessionId) {
            setSessionName(event.name);
          }
          break;

        case "tool_use":
          setActiveTools((prev) => {
            const activity = {
              id: event.id,
              tool: event.tool,
              input: event.input,
              timestamp: event.timestamp ?? Date.now(),
            };
            return activity.id
              ? [...prev.filter((tool) => tool.id !== activity.id), activity]
              : [...prev, activity];
          });
          break;

        case "active_tools":
          setActiveTools(event.activeTools);
          break;

        case "error":
          setRefreshingTranscript(false);
          setTranscriptRefreshError(event.message);
          if (event.seq === 0) {
            const rollbackId = optimisticIdsRef.current.pop();
            if (rollbackId) {
              setMessages((prev) => prev.filter((message) => message.id !== rollbackId));
            }
          }
          if (event.seq > 0 && !event.nonFatal) {
            setStatus("error");
            setActiveTools([]);
          }
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
    optimisticIdsRef.current = [];
    setMessages([]);
    setStreamingText("");
    setActiveTools([]);
    setRawStdout("");
    setStatus("connecting");
    setSessionName(undefined);
    setRefreshingTranscript(false);
    setTranscriptRefreshError("");
    setCapabilities(null);
    setPendingPermissions([]);

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
    (
      text: string,
      options: {
        images?: PromptImageInput[];
        skills?: PromptSkillInput[];
        mentions?: PromptMentionInput[];
      } = {},
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(JSON.stringify({ type: "send_prompt", content: text, ...options }));
      const optimisticContent = buildOptimisticPromptContent(text, options);
      const optimisticId = crypto.randomUUID();
      optimisticIdsRef.current.push(optimisticId);
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          sessionId,
          turnId: null,
          role: "user",
          content: optimisticContent,
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

  const retryDesyncedTurn = useCallback((turnId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "retry_desynced_turn", turnId }));
  }, []);

  const sendPermissionAction = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const approvePermission = useCallback(
    (id: string) => sendPermissionAction({ type: "approve_permission", id }),
    [sendPermissionAction],
  );

  const approvePermissionForSession = useCallback(
    (id: string) => sendPermissionAction({ type: "approve_permission_for_session", id }),
    [sendPermissionAction],
  );

  const rejectPermission = useCallback(
    (id: string) => sendPermissionAction({ type: "reject_permission", id }),
    [sendPermissionAction],
  );

  const answerUserInput = useCallback(
    (id: string, answer: string) =>
      sendPermissionAction({ type: "answer_user_input", id, answer }),
    [sendPermissionAction],
  );

  return {
    messages,
    streamingText,
    activeTools,
    rawStdout,
    status,
    sessionName,
    refreshingTranscript,
    capabilities,
    pendingPermissions,
    sendPrompt,
    refreshTranscript,
    transcriptRefreshError,
    stop,
    retry,
    retryDesyncedTurn,
    approvePermission,
    approvePermissionForSession,
    rejectPermission,
    answerUserInput,
  };
}

function buildOptimisticPromptContent(
  text: string,
  options: {
    images?: PromptImageInput[];
    skills?: PromptSkillInput[];
    mentions?: PromptMentionInput[];
  },
): string {
  const parts = [text.trim()].filter(Boolean);
  if (options.skills?.length) parts.push(options.skills.map((skill) => `$${skill.name}`).join(" "));
  if (options.mentions?.length) parts.push(options.mentions.map((mention) => `@${mention.name}`).join(" "));
  if (options.images?.length) {
    parts.push(options.images.map((image) => `[image: ${image.name || image.mimeType}]`).join("\n"));
  }
  return parts.join("\n").trim() || "Attached structured input";
}
