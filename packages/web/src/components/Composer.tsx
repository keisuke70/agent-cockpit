import { useState, useRef, useEffect } from "react";
import type { SessionStatus } from "@agent-cockpit/shared";

interface ComposerProps {
  status: SessionStatus | "connecting";
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ status, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isRunning = status === "running";
  const canSend = text.trim().length > 0 && !isRunning && status !== "connecting";

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }
  }, [text]);

  function handleSend() {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        padding: "12px 16px",
        paddingBottom: "calc(12px + var(--safe-bottom))",
        background: "var(--bg)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 8,
        alignItems: "flex-end",
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a prompt..."
        rows={1}
        style={{
          flex: 1,
          resize: "none",
          minHeight: 44,
          maxHeight: 120,
        }}
      />
      {isRunning ? (
        <button
          onClick={onStop}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: "var(--radius-sm)",
            background: "var(--danger)",
            color: "white",
            fontWeight: 600,
          }}
        >
          Stop
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: "var(--radius-sm)",
            background: canSend ? "var(--accent)" : "var(--bg-surface)",
            color: canSend ? "white" : "var(--text-muted)",
            fontWeight: 600,
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}
