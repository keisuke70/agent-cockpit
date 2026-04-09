import { useNavigate } from "react-router";
import type { Session, SessionStatus } from "@agent-cockpit/shared";

interface SessionListProps {
  sessions: Session[];
  /** Optional map of repoId -> repo name. When provided, each row shows the repo name. */
  repoNames?: Map<string, string>;
  /** Optional live status overrides from the lobby WebSocket. */
  liveStatuses?: Map<string, SessionStatus>;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "var(--text-muted)",
  running: "var(--success)",
  stopped: "var(--text-muted)",
  error: "var(--danger)",
};

export function SessionList({
  sessions,
  repoNames,
  liveStatuses,
}: SessionListProps) {
  const navigate = useNavigate();

  if (sessions.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          color: "var(--text-muted)",
          padding: 40,
        }}
      >
        No sessions yet. Create one to get started.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {sessions.map((s) => {
        const effectiveStatus = liveStatuses?.get(s.id) ?? s.status;
        const repoName = repoNames?.get(s.repoId);
        return (
          <button
            key={s.id}
            onClick={() => navigate(`/session/${s.id}`)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              borderBottom: "1px solid var(--border)",
              textAlign: "left",
              minHeight: 56,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  STATUS_COLORS[effectiveStatus] ?? "var(--text-muted)",
                flexShrink: 0,
                ...(effectiveStatus === "running"
                  ? { animation: "blink 1.5s ease-in-out infinite" }
                  : {}),
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.name || `Session ${s.id.slice(0, 8)}`}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {repoName && (
                  <>
                    <span
                      style={{
                        color: "var(--accent)",
                        fontWeight: 500,
                      }}
                    >
                      {repoName}
                    </span>
                    <span>&middot;</span>
                  </>
                )}
                <span>{s.agent}</span>
                <span>&middot;</span>
                <span>{new Date(s.updatedAt).toLocaleString()}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
