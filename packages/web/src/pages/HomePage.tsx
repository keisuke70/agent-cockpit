import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import type {
  Repo,
  Session,
  SessionStatus,
  AgentType,
} from "@agent-cockpit/shared";
import { authHeaders } from "../hooks/useAuth.js";
import { usePushSubscription } from "../hooks/usePushSubscription.js";
import { useLobby } from "../hooks/useLobby.js";
import { RepoAgentSelector, ALL_REPOS } from "../components/RepoAgentSelector.js";
import { SessionList } from "../components/SessionList.js";

type StatusFilter = "all" | "running" | "idle" | "error";

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "idle", label: "Idle" },
  { id: "error", label: "Error" },
];

function statusMatchesFilter(
  status: SessionStatus,
  filter: StatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "idle") return status === "idle" || status === "stopped";
  return status === filter;
}

export function HomePage() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState(
    () => localStorage.getItem("cockpit-selected-repo") ?? "",
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentType>(() => {
    const stored = localStorage.getItem("cockpit-selected-agent");
    return stored === "claude" || stored === "codex" ? stored : "claude";
  });
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const push = usePushSubscription();
  const liveStatuses = useLobby();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteSessionError, setDeleteSessionError] = useState("");

  const isAllRepos = selectedRepoId === ALL_REPOS;
  const isSpecificRepo = selectedRepoId !== "" && !isAllRepos;

  const repoNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of repos) map.set(r.id, r.name);
    return map;
  }, [repos]);

  // effectiveStatus = live status from lobby if available, else the persisted
  // status from the last fetch. Filtering uses this so the chip filters reflect
  // reality without needing a refetch every time a session transitions.
  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      const eff: SessionStatus = liveStatuses.get(s.id) ?? s.status;
      return statusMatchesFilter(eff, statusFilter);
    });
  }, [sessions, liveStatuses, statusFilter]);

  const handleRepoChange = useCallback((id: string) => {
    setSelectedRepoId(id);
    localStorage.setItem("cockpit-selected-repo", id);
  }, []);

  const handleAgentChange = useCallback((agent: AgentType) => {
    setSelectedAgent(agent);
    localStorage.setItem("cockpit-selected-agent", agent);
  }, []);

  const fetchRepos = useCallback(async () => {
    const res = await fetch("/api/repos", { headers: authHeaders() });
    const data = (await res.json()) as Repo[];
    setRepos(data);

    if (data.length === 0) {
      if (selectedRepoId) handleRepoChange("");
      return;
    }

    const selectedExists =
      selectedRepoId === ALL_REPOS || data.some((repo) => repo.id === selectedRepoId);
    if (!selectedRepoId || !selectedExists) {
      handleRepoChange(data[0].id);
    }
  }, [handleRepoChange, selectedRepoId]);

  const fetchSessions = useCallback(async () => {
    if (!selectedRepoId) return;
    const url = isAllRepos
      ? "/api/sessions"
      : `/api/sessions?repoId=${selectedRepoId}`;
    const res = await fetch(url, { headers: authHeaders() });
    setSessions(await res.json());
  }, [selectedRepoId, isAllRepos]);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  async function createSession() {
    if (!isSpecificRepo) return;
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ repoId: selectedRepoId, agent: selectedAgent }),
    });
    const session = await res.json();
    navigate(`/session/${session.id}`);
  }

  async function deleteSessionFromList(session: Session) {
    if (deletingSessionIds.has(session.id)) return;

    const label = session.name || `Session ${session.id.slice(0, 8)}`;
    const confirmed = confirm(
      `Delete "${label}"? This removes its messages and schedules.`,
    );
    if (!confirmed) return;

    setDeleteSessionError("");
    setDeletingSessionIds((prev) => {
      const next = new Set(prev);
      next.add(session.id);
      return next;
    });

    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== session.id));
        return;
      }

      const body = await res.json().catch(() => ({}));
      setDeleteSessionError(body.error ?? `Delete failed (${res.status})`);
    } catch (err) {
      setDeleteSessionError(
        err instanceof Error ? err.message : "Delete failed",
      );
    } finally {
      setDeletingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        return next;
      });
    }
  }

  const [addRepoError, setAddRepoError] = useState("");

  async function addRepo() {
    if (!repoName.trim() || !repoPath.trim()) return;
    setAddRepoError("");
    const res = await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: repoName.trim(), path: repoPath.trim() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setAddRepoError(body.error ?? `Error ${res.status}`);
      return;
    }
    setRepoName("");
    setRepoPath("");
    setShowAddRepo(false);
    setAddRepoError("");
    fetchRepos();
  }

  async function deleteSelectedRepo() {
    if (!isSpecificRepo) return;
    const repo = repos.find((r) => r.id === selectedRepoId);
    if (!repo) return;
    if (!confirm(`Delete repo "${repo.name}" and all its sessions?`)) return;
    await fetch(`/api/repos/${selectedRepoId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    handleRepoChange("");
    setSessions([]);
    fetchRepos();
  }

  return (
    <>
      <header
        style={{
          padding: "16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Agent Cockpit</h1>
        <div style={{ display: "flex", gap: 4 }}>
          {isSpecificRepo && (
            <button
              onClick={deleteSelectedRepo}
              style={{
                fontSize: 13,
                color: "var(--danger)",
                padding: "6px 12px",
              }}
              aria-label="Delete selected repo"
            >
              Delete
            </button>
          )}
          <button
            onClick={() => setShowAddRepo(!showAddRepo)}
            style={{
              fontSize: 13,
              color: "var(--accent)",
              padding: "6px 12px",
            }}
          >
            {showAddRepo ? "Cancel" : "+ Repo"}
          </button>
        </div>
      </header>

      {showAddRepo && (
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <input
            placeholder="Repo name"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
          />
          <input
            placeholder="Mac local path (e.g. /Users/kei/projects/myapp)"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          />
          {addRepoError && (
            <span style={{ fontSize: 13, color: "var(--danger)" }}>{addRepoError}</span>
          )}
          <button
            onClick={addRepo}
            style={{
              padding: "10px",
              background: "var(--accent)",
              color: "white",
              borderRadius: "var(--radius-sm)",
              fontWeight: 600,
              minHeight: 44,
            }}
          >
            Add Repo
          </button>
        </div>
      )}

      <PushSettings push={push} />

      <RepoAgentSelector
        repos={repos}
        selectedRepoId={selectedRepoId}
        selectedAgent={selectedAgent}
        onRepoChange={handleRepoChange}
        onAgentChange={handleAgentChange}
      />

      <StatusFilterChips value={statusFilter} onChange={setStatusFilter} />

      {deleteSessionError && (
        <div
          role="alert"
          style={{
            padding: "0 16px 10px",
            color: "var(--danger)",
            fontSize: 13,
          }}
        >
          {deleteSessionError}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }}>
        <SessionList
          sessions={filteredSessions}
          repoNames={isAllRepos ? repoNames : undefined}
          liveStatuses={liveStatuses}
          onDeleteSession={deleteSessionFromList}
          deletingSessionIds={deletingSessionIds}
        />
      </div>

      <div style={{ padding: "12px 16px", paddingBottom: "calc(12px + var(--safe-bottom))" }} data-section="new-session">
        <button
          onClick={createSession}
          disabled={!isSpecificRepo}
          style={{
            width: "100%",
            padding: "12px",
            background: isSpecificRepo ? "var(--accent)" : "var(--bg-surface)",
            color: isSpecificRepo ? "white" : "var(--text-muted)",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            fontSize: 16,
            minHeight: 48,
          }}
          title={
            isAllRepos
              ? "Pick a specific repo to create a new session"
              : undefined
          }
        >
          {isAllRepos ? "Pick a repo to create a session" : "New Session"}
        </button>
      </div>
    </>
  );
}

function StatusFilterChips({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        padding: "0 16px 12px",
        overflowX: "auto",
      }}
    >
      {STATUS_FILTERS.map((f) => {
        const active = value === f.id;
        return (
          <button
            key={f.id}
            onClick={() => onChange(f.id)}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: active ? "var(--accent)" : "var(--bg-surface)",
              color: active ? "white" : "var(--text-muted)",
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              flexShrink: 0,
            }}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function PushSettings({ push }: { push: ReturnType<typeof usePushSubscription> }) {
  const { state, busy, enable, disable } = push;

  let label = "";
  let action: (() => void) | null = null;
  let actionLabel = "";
  let disabled = busy;

  switch (state) {
    case "subscribed":
      label = "Notifications: ON";
      action = disable;
      actionLabel = "Disable";
      break;
    case "default":
      label = "Notifications: off";
      action = enable;
      actionLabel = "Enable";
      break;
    case "denied":
      label = "Notifications blocked in browser settings";
      disabled = true;
      break;
    case "ios-needs-pwa":
      label = "iOS: add to Home Screen (16.4+) for notifications";
      disabled = true;
      break;
    case "unsupported":
      label = "Notifications not supported";
      disabled = true;
      break;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        borderBottom: "1px solid var(--border)",
        fontSize: 13,
        color: "var(--text-muted)",
        gap: 12,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {action && (
        <button
          onClick={action}
          disabled={disabled}
          style={{
            fontSize: 13,
            padding: "6px 12px",
            color: disabled ? "var(--text-muted)" : "var(--accent)",
          }}
        >
          {busy ? "..." : actionLabel}
        </button>
      )}
    </div>
  );
}
