import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import type {
  Repo,
  Session,
  SessionStatus,
  AgentType,
  WorkspaceSettings,
} from "@agent-cockpit/shared";
import { authHeaders } from "../hooks/useAuth.js";
import { usePushSubscription } from "../hooks/usePushSubscription.js";
import { useLobby } from "../hooks/useLobby.js";
import { RepoAgentSelector, ALL_REPOS } from "../components/RepoAgentSelector.js";
import { SessionList } from "../components/SessionList.js";
import { sessionDisplayName } from "../sessionDisplay.js";

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
    () => localStorage.getItem("cockpit-selected-repo") ?? ALL_REPOS,
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentType>(() => {
    const stored = localStorage.getItem("cockpit-selected-agent");
    return stored === "claude" || stored === "codex" ? stored : "claude";
  });
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>({
    rootPath: null,
    workspaceRepoId: null,
  });
  const [workspaceRootInput, setWorkspaceRootInput] = useState("");
  const [workspaceRootError, setWorkspaceRootError] = useState("");
  const [isSavingWorkspaceRoot, setIsSavingWorkspaceRoot] = useState(false);
  const push = usePushSubscription();
  const liveStatuses = useLobby();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteSessionError, setDeleteSessionError] = useState("");
  const [newSessionError, setNewSessionError] = useState("");

  const isAllRepos = selectedRepoId === ALL_REPOS;
  const isSpecificRepo = selectedRepoId !== "" && !isAllRepos;

  const repoNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of repos) map.set(r.id, r.name);
    if (workspaceSettings.workspaceRepoId) {
      map.set(workspaceSettings.workspaceRepoId, "Workspace Root");
    }
    return map;
  }, [repos, workspaceSettings.workspaceRepoId]);

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
    setNewSessionError("");
    localStorage.setItem("cockpit-selected-repo", id);
  }, []);

  const handleAgentChange = useCallback((agent: AgentType) => {
    setSelectedAgent(agent);
    localStorage.setItem("cockpit-selected-agent", agent);
  }, []);

  const fetchWorkspaceSettings = useCallback(async () => {
    const res = await fetch("/api/settings/workspace-root", {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setWorkspaceRootError(body.error ?? `Workspace root unavailable (${res.status})`);
      return;
    }
    const data = (await res.json()) as WorkspaceSettings;
    setWorkspaceSettings(data);
    setWorkspaceRootInput(data.rootPath ?? "");
  }, []);

  const fetchRepos = useCallback(async () => {
    const res = await fetch("/api/repos", { headers: authHeaders() });
    const data = (await res.json()) as Repo[];
    setRepos(data);

    const selectedExists =
      selectedRepoId === ALL_REPOS || data.some((repo) => repo.id === selectedRepoId);
    if (!selectedRepoId || !selectedExists) {
      handleRepoChange(data[0]?.id ?? ALL_REPOS);
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
    fetchWorkspaceSettings();
  }, [fetchWorkspaceSettings]);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  async function createSession() {
    const repoId = isAllRepos ? workspaceSettings.workspaceRepoId : selectedRepoId;
    const cwd = isAllRepos ? workspaceSettings.rootPath : null;
    if (!repoId || (!isAllRepos && !isSpecificRepo)) return;

    setNewSessionError("");
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          repoId,
          agent: selectedAgent,
          ...(cwd ? { cwd } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setNewSessionError(body.error ?? `Session creation failed (${res.status})`);
        if (isAllRepos) fetchWorkspaceSettings();
        return;
      }

      const session = await res.json();
      if (!session.id) {
        setNewSessionError("Session creation returned no session id.");
        return;
      }
      navigate(`/session/${session.id}`);
    } catch (err) {
      setNewSessionError(err instanceof Error ? err.message : "Session creation failed");
    }
  }

  async function deleteSessionFromList(session: Session) {
    if (deletingSessionIds.has(session.id)) return;

    const label = sessionDisplayName(session);
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

  async function saveWorkspaceRoot() {
    const rootPath = workspaceRootInput.trim();
    if (!rootPath || isSavingWorkspaceRoot) return;

    setWorkspaceRootError("");
    setIsSavingWorkspaceRoot(true);
    try {
      const res = await fetch("/api/settings/workspace-root", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ rootPath }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setWorkspaceRootError(body.error ?? `Error ${res.status}`);
        return;
      }

      const data = (await res.json()) as WorkspaceSettings;
      setWorkspaceSettings(data);
      setWorkspaceRootInput(data.rootPath ?? "");
      setWorkspaceRootError("");
      setNewSessionError("");
      fetchRepos();
    } catch (err) {
      setWorkspaceRootError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSavingWorkspaceRoot(false);
    }
  }

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
    handleRepoChange(ALL_REPOS);
    setSessions([]);
    fetchRepos();
  }

  const canCreateSession =
    isSpecificRepo ||
    (isAllRepos && Boolean(workspaceSettings.rootPath && workspaceSettings.workspaceRepoId));
  const newSessionLabel = isAllRepos
    ? workspaceSettings.rootPath
      ? "New Workspace Session"
      : "Set root directory to create a session"
    : "New Session";

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

      <WorkspaceRootSettings
        rootPath={workspaceSettings.rootPath}
        value={workspaceRootInput}
        error={workspaceRootError}
        saving={isSavingWorkspaceRoot}
        onChange={setWorkspaceRootInput}
        onSave={saveWorkspaceRoot}
      />

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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="repo-name" style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Repo name
            </label>
            <input
              id="repo-name"
              placeholder="myapp"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="repo-path" style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Local path
            </label>
            <input
              id="repo-path"
              placeholder="/path/to/your/repo"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
            />
          </div>
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
        {newSessionError && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "0 0 8px" }}>
            {newSessionError}
          </p>
        )}
        <button
          onClick={createSession}
          disabled={!canCreateSession}
          style={{
            width: "100%",
            padding: "12px",
            background: canCreateSession ? "var(--accent)" : "var(--bg-surface)",
            color: canCreateSession ? "white" : "var(--text-muted)",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            fontSize: 16,
            minHeight: 48,
          }}
          title={
            isAllRepos && !workspaceSettings.rootPath
              ? "Set a workspace root directory before creating an All Repos session"
              : undefined
          }
        >
          {newSessionLabel}
        </button>
      </div>
    </>
  );
}

function WorkspaceRootSettings({
  rootPath,
  value,
  error,
  saving,
  onChange,
  onSave,
}: {
  rootPath: string | null;
  value: string;
  error: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const trimmed = value.trim();
  const unchanged = trimmed === (rootPath ?? "");
  const hintId = "workspace-root-hint";
  const errorId = "workspace-root-error";

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || unchanged || saving) return;
    onSave();
  }

  return (
    <section
      aria-labelledby="workspace-root-heading"
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <h2 id="workspace-root-heading" style={{ fontSize: 14, fontWeight: 650 }}>
          Workspace root
        </h2>
        <p id={hintId} style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
          Choose the parent folder that contains your repositories. All Repos sessions start here.
        </p>
      </div>
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
      >
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <label
            htmlFor="workspace-root-path"
            style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 6 }}
          >
            Root directory path
          </label>
          <input
            id="workspace-root-path"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="~/Projects"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            aria-invalid={Boolean(error)}
            style={{ width: "100%", minHeight: 44 }}
          />
        </div>
        <button
          type="submit"
          disabled={!trimmed || unchanged || saving}
          style={{
            minHeight: 44,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            background: !trimmed || unchanged || saving ? "var(--bg-surface)" : "var(--accent)",
            color: !trimmed || unchanged || saving ? "var(--text-muted)" : "white",
            fontWeight: 600,
          }}
        >
          {saving ? "Saving..." : rootPath ? "Update root" : "Set root"}
        </button>
      </form>
      {error && (
        <p id={errorId} role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>
          {error}
        </p>
      )}
    </section>
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
