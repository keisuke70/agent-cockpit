import { useParams, useNavigate } from "react-router";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { useSession } from "../hooks/useSession.js";
import { StreamOutput } from "../components/StreamOutput.js";
import { Composer } from "../components/Composer.js";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const session = useSession(id!);
  const { messages, streamingText, status, sendPrompt, stop, retry } =
    useWebSocket(id!);

  const displayName = session?.name || `Session ${id?.slice(0, 8)}`;
  const agent = session?.agent ?? "";

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
          <div
            style={{
              fontWeight: 600,
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {displayName}
            {agent && (
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontWeight: 500,
                }}
              >
                {agent}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            <StatusLabel status={status} />
          </div>
        </div>
        <StatusDot status={status} />
      </header>

      <StreamOutput messages={messages} streamingText={streamingText} />
      <Composer status={status} onSend={sendPrompt} onStop={stop} onRetry={retry} />
    </>
  );
}

function StatusLabel({ status }: { status: string }) {
  switch (status) {
    case "connecting":
      return <>Connecting...</>;
    case "running":
      return <>Running...</>;
    case "error":
      return <span style={{ color: "var(--danger)" }}>Error</span>;
    case "stopped":
      return <>Stopped</>;
    default:
      return <>Ready</>;
  }
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--success)"
      : status === "error"
        ? "var(--danger)"
        : status === "connecting"
          ? "var(--accent)"
          : "var(--text-muted)";

  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        ...(status === "running" || status === "connecting"
          ? { animation: "blink 1.5s ease-in-out infinite" }
          : {}),
      }}
    />
  );
}
