import { useEffect, useRef } from "react";
import type { Message } from "@agent-cockpit/shared";

interface StreamOutputProps {
  messages: Message[];
  streamingText: string;
}

export function StreamOutput({ messages, streamingText }: StreamOutputProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  return (
    <div
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
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 15,
        lineHeight: 1.6,
      }}
    >
      {content}
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
