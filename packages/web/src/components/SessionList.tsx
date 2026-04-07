import { useNavigate } from "react-router";
import type { Session } from "@agent-cockpit/shared";

interface SessionListProps {
  sessions: Session[];
}

const STATUS_COLORS: Record<string, string> = {
  idle: "var(--text-muted)",
  running: "var(--success)",
  stopped: "var(--text-muted)",
  error: "var(--danger)",
};

export function SessionList({ sessions }: SessionListProps) {
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
      {sessions.map((s) => (
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
              background: STATUS_COLORS[s.status] ?? "var(--text-muted)",
              flexShrink: 0,
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
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {s.agent} &middot;{" "}
              {new Date(s.updatedAt).toLocaleString()}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
