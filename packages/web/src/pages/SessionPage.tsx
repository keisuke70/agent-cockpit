import { useParams, useNavigate } from "react-router";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { StreamOutput } from "../components/StreamOutput.js";
import { Composer } from "../components/Composer.js";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { messages, streamingText, status, sendPrompt, stop } = useWebSocket(
    id!,
  );

  return (
    <>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={() => navigate("/")}
          style={{ fontSize: 20, padding: "4px 8px", minWidth: 44, minHeight: 44 }}
          aria-label="Back"
        >
          &larr;
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            Session {id?.slice(0, 8)}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {status === "connecting"
              ? "Connecting..."
              : status === "running"
                ? "Running..."
                : status}
          </div>
        </div>
        <StatusDot status={status} />
      </header>

      <StreamOutput messages={messages} streamingText={streamingText} />
      <Composer status={status} onSend={sendPrompt} onStop={stop} />
    </>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--success)"
      : status === "error"
        ? "var(--danger)"
        : "var(--text-muted)";

  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}
