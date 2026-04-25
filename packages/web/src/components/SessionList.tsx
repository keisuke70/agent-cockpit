import { useNavigate } from "react-router";
import type { Session, SessionStatus } from "@agent-cockpit/shared";

interface SessionListProps {
  sessions: Session[];
  /** Optional map of repoId -> repo name. When provided, each row shows the repo name. */
  repoNames?: Map<string, string>;
  /** Optional live status overrides from the lobby WebSocket. */
  liveStatuses?: Map<string, SessionStatus>;
  /** Called when the trailing delete control is activated. */
  onDeleteSession?: (session: Session) => void;
  /** Session ids currently being deleted, used to disable their trailing controls. */
  deletingSessionIds?: ReadonlySet<string>;
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
  onDeleteSession,
  deletingSessionIds,
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
    <ul
      style={{
        display: "flex",
        flexDirection: "column",
        listStyle: "none",
        width: "100%",
      }}
    >
      {sessions.map((s) => {
        const effectiveStatus = liveStatuses?.get(s.id) ?? s.status;
        const repoName = repoNames?.get(s.repoId);
        const label = s.name || `Session ${s.id.slice(0, 8)}`;
        const isDeleting = deletingSessionIds?.has(s.id) ?? false;
        return (
          <li
            key={s.id}
            style={{
              display: "grid",
              gridTemplateColumns: onDeleteSession
                ? "minmax(0, 1fr) auto"
                : "minmax(0, 1fr)",
              alignItems: "stretch",
              borderBottom: "1px solid var(--border)",
              width: "100%",
            }}
          >
            <button
              type="button"
              onClick={() => navigate(`/session/${s.id}`)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: `14px ${onDeleteSession ? 12 : 16}px 14px 16px`,
                textAlign: "left",
                minHeight: 56,
                flex: 1,
                minWidth: 0,
                width: "100%",
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
                  {label}
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
            {onDeleteSession && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteSession(s);
                }}
                disabled={isDeleting}
                aria-label={
                  isDeleting ? `Deleting ${label}` : `Delete ${label}`
                }
                title={`Delete ${label}`}
                style={{
                  alignSelf: "center",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 76,
                  minHeight: 36,
                  margin: "10px 12px 10px 0",
                  padding: "0 12px",
                  border: "1px solid rgba(239, 68, 68, 0.45)",
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(239, 68, 68, 0.12)",
                  color: "var(--danger)",
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: isDeleting ? 0.5 : 1,
                  cursor: isDeleting ? "default" : "pointer",
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                }}
              >
                {isDeleting ? "Deleting" : "Delete"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
