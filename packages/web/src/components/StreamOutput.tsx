import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Message } from "@agent-cockpit/shared";
import type { ToolActivity } from "../hooks/useWebSocket.js";

interface StreamOutputProps {
  messages: Message[];
  streamingText: string;
  activeTools?: ToolActivity[];
}

export function StreamOutput({ messages, streamingText, activeTools }: StreamOutputProps) {
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
  }, [messages, streamingText]);

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
        <MessageBubble key={msg.id} role={msg.role} content={msg.content} />
      ))}

      {streamingText && (
        <MessageBubble role="assistant" content={streamingText} streaming />
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

      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({
  role,
  content,
  streaming,
}: {
  role: string;
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";

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
        <span style={{ whiteSpace: "pre-wrap" }}>{content}</span>
      ) : (
        <div className="markdown-body">
          <ReactMarkdown>{content}</ReactMarkdown>
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
