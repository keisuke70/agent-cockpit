import { useState } from "react";
import type { Schedule } from "@agent-cockpit/shared";
import { useSchedules } from "../hooks/useSchedules.js";

interface SchedulePanelProps {
  sessionId: string;
}

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Every 5 min", expr: "*/5 * * * *" },
  { label: "Hourly", expr: "0 * * * *" },
  { label: "Daily 9am", expr: "0 9 * * *" },
  { label: "Mon 9am", expr: "0 9 * * 1" },
];

export function SchedulePanel({ sessionId }: SchedulePanelProps) {
  const { schedules, create, remove, toggle } = useSchedules(sessionId);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (!prompt.trim() || !cronExpr.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await create(prompt.trim(), cronExpr.trim());
    setSubmitting(false);
    if (!result) {
      setError("Failed to create schedule (check cron expression)");
      return;
    }
    setPrompt("");
    setAdding(false);
  }

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          padding: "10px 16px",
          textAlign: "left",
          fontSize: 13,
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 40,
        }}
      >
        <span>
          Schedules{" "}
          {schedules.length > 0 && (
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>
              ({schedules.length})
            </span>
          )}
        </span>
        <span>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {schedules.length === 0 && !adding && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0" }}>
              No schedules. Add one to fire a prompt on a cron schedule.
            </p>
          )}

          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onToggle={toggle} onRemove={remove} />
          ))}

          {adding ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 10,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-surface)",
              }}
            >
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Prompt to fire on schedule"
                rows={2}
                style={{ resize: "vertical", minHeight: 60, fontSize: 14 }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.expr}
                    onClick={() => setCronExpr(p.expr)}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: "1px solid var(--border)",
                      background:
                        cronExpr === p.expr
                          ? "var(--accent)"
                          : "var(--bg)",
                      color:
                        cronExpr === p.expr ? "white" : "var(--text-muted)",
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="Cron (e.g. 0 9 * * *)"
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: 13,
                }}
              />
              {error && (
                <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleAdd}
                  disabled={submitting || !prompt.trim()}
                  style={{
                    flex: 1,
                    padding: "8px",
                    background: "var(--accent)",
                    color: "white",
                    borderRadius: "var(--radius-sm)",
                    fontWeight: 600,
                    minHeight: 40,
                    opacity: submitting || !prompt.trim() ? 0.5 : 1,
                  }}
                >
                  {submitting ? "..." : "Add"}
                </button>
                <button
                  onClick={() => {
                    setAdding(false);
                    setError(null);
                  }}
                  style={{
                    padding: "8px 16px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    color: "var(--text-muted)",
                    borderRadius: "var(--radius-sm)",
                    minHeight: 40,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setAdding(true);
                setError(null);
              }}
              style={{
                fontSize: 13,
                color: "var(--accent)",
                padding: "8px 0",
                textAlign: "left",
                minHeight: 36,
              }}
            >
              + Add schedule
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  onToggle,
  onRemove,
}: {
  schedule: Schedule;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 10,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code
          style={{
            fontSize: 11,
            background: "var(--bg)",
            padding: "2px 6px",
            borderRadius: 4,
            color: "var(--accent)",
          }}
        >
          {schedule.cronExpr}
        </code>
        <span
          style={{
            fontSize: 11,
            color: schedule.enabled ? "var(--success)" : "var(--text-muted)",
          }}
        >
          {schedule.enabled ? "● enabled" : "○ disabled"}
        </span>
        {schedule.lastStatus && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            last: {schedule.lastStatus}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={schedule.prompt}
      >
        {schedule.prompt}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => onToggle(schedule.id, !schedule.enabled)}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            color: "var(--accent)",
          }}
        >
          {schedule.enabled ? "Disable" : "Enable"}
        </button>
        <button
          onClick={() => {
            if (confirm("Delete this schedule?")) onRemove(schedule.id);
          }}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            color: "var(--danger)",
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
