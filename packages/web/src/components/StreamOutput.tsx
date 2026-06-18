import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Message, PermissionRequestEvent } from "@agent-cockpit/shared";
import type { ToolActivity } from "../hooks/useWebSocket.js";

interface StreamOutputProps {
  messages: Message[];
  streamingText: string;
  activeTools?: ToolActivity[];
  pendingPermissions?: PermissionRequestEvent[];
  onApprovePermission?: (id: string) => void;
  onApprovePermissionForSession?: (id: string) => void;
  onRejectPermission?: (id: string) => void;
  onAnswerUserInput?: (id: string, answer: string) => void;
  onRetryDesyncedTurn?: (turnId: string) => void;
}

export function StreamOutput({
  messages,
  streamingText,
  activeTools,
  pendingPermissions = [],
  onApprovePermission,
  onApprovePermissionForSession,
  onRejectPermission,
  onAnswerUserInput,
  onRetryDesyncedTurn,
}: StreamOutputProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolled.current = !atBottom;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!userScrolled.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingText, pendingPermissions.length]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {messages.length === 0 && !streamingText && (
        <div
          style={{
            textAlign: "center",
            color: "var(--text-muted)",
            marginTop: 40,
          }}
        >
          Send a prompt to get started.
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onRetryDesyncedTurn={onRetryDesyncedTurn}
        />
      ))}

      {streamingText && (
        <MessageBubble message={{ id: "streaming", sessionId: "", turnId: null, role: "assistant", content: streamingText, createdAt: new Date().toISOString() }} streaming />
      )}

      {activeTools && activeTools.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignSelf: "flex-start",
            maxWidth: "85%",
          }}
        >
          {activeTools.map((t, i) => (
            <ToolBadge key={i} tool={t.tool} input={t.input} />
          ))}
        </div>
      )}

      {pendingPermissions.map((request) => (
        <PermissionCard
          key={request.id}
          request={request}
          onApprove={() => onApprovePermission?.(request.id)}
          onApproveForSession={
            request.allowForSession
              ? () => onApprovePermissionForSession?.(request.id)
              : undefined
          }
          onReject={() => onRejectPermission?.(request.id)}
          onAnswer={(answer) => onAnswerUserInput?.(request.id, answer)}
        />
      ))}

      <div ref={bottomRef} />
    </div>
  );
}

function PermissionCard({
  request,
  onApprove,
  onApproveForSession,
  onReject,
  onAnswer,
}: {
  request: PermissionRequestEvent;
  onApprove: () => void;
  onApproveForSession?: () => void;
  onReject: () => void;
  onAnswer: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const needsText = request.kind === "questions" || request.kind === "elicitation";
  return (
    <section className="permission-card" aria-label={`${request.toolName} permission request`}>
      <div className="permission-card-header">
        <strong>{permissionTitle(request)}</strong>
        <span>{request.kind}</span>
      </div>
      <pre className="permission-card-input">
        {JSON.stringify(request.input, null, 2)}
      </pre>
      {needsText && (
        <label className="permission-answer-label">
          Answer
          <input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Type response for Codex"
          />
        </label>
      )}
      <div className="permission-card-actions">
        {needsText ? (
          <button type="button" onClick={() => onAnswer(answer)}>
            Send answer
          </button>
        ) : (
          <>
            <button type="button" className="permission-approve" onClick={onApprove}>
              Approve
            </button>
            {onApproveForSession && (
              <button type="button" onClick={onApproveForSession}>
                Approve for session
              </button>
            )}
          </>
        )}
        <button type="button" className="permission-reject" onClick={onReject}>
          Reject
        </button>
      </div>
    </section>
  );
}

function permissionTitle(request: PermissionRequestEvent): string {
  switch (request.kind) {
    case "command":
      return "Codex wants to run a command";
    case "file":
      return "Codex wants to change files";
    case "permissions":
      return "Codex requests broader permissions";
    case "questions":
      return "Codex needs user input";
    case "elicitation":
      return "A plugin/app requests input";
    case "plan":
      return "Codex plan approval";
  }
}

function MessageBubble({
  message,
  streaming,
  onRetryDesyncedTurn,
}: {
  message: Message;
  streaming?: boolean;
  onRetryDesyncedTurn?: (turnId: string) => void;
}) {
  const isUser = message.role === "user";
  const isDesynced = message.codexSyncStatus === "desynced" && Boolean(message.turnId);

  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "85%",
        padding: "10px 14px",
        borderRadius: "var(--radius)",
        background: isUser ? "var(--user-bubble)" : "var(--assistant-bubble)",
        wordBreak: "break-word",
        fontSize: 15,
        lineHeight: 1.6,
      }}
    >
      {isUser ? (
        <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>
      ) : (
        <div className="markdown-body">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
      )}
      {isDesynced && (
        <div className="message-sync-warning" role="status" aria-live="polite">
          <span>Saved locally, not confirmed in Codex.</span>
          <button
            type="button"
            onClick={() => message.turnId && onRetryDesyncedTurn?.(message.turnId)}
          >
            Retry this message
          </button>
        </div>
      )}
      {streaming && (
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 16,
            background: "var(--accent)",
            marginLeft: 2,
            verticalAlign: "text-bottom",
            animation: "blink 1s step-end infinite",
          }}
        />
      )}
    </div>
  );
}

function ToolBadge({ tool, input }: { tool: string; input: unknown }) {
  let detail = "";
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Show the most useful field depending on the tool
    if (typeof obj.command === "string") {
      detail = obj.command.length > 80 ? obj.command.slice(0, 80) + "..." : obj.command;
    } else if (typeof obj.file_path === "string") {
      detail = obj.file_path;
    } else if (typeof obj.pattern === "string") {
      detail = obj.pattern;
    } else if (typeof obj.query === "string") {
      detail = obj.query.length > 60 ? obj.query.slice(0, 60) + "..." : obj.query;
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        color: "var(--text-muted)",
        animation: "blink 2s ease-in-out infinite",
      }}
    >
      <span style={{ color: "var(--accent)", fontWeight: 600 }}>{tool}</span>
      {detail && <span style={{ opacity: 0.7 }}>{detail}</span>}
    </div>
  );
}
