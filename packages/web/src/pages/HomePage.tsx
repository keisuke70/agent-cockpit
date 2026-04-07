import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import type { Repo, Session, AgentType } from "@agent-cockpit/shared";
import { authHeaders } from "../hooks/useAuth.js";
import { RepoAgentSelector } from "../components/RepoAgentSelector.js";
import { SessionList } from "../components/SessionList.js";

export function HomePage() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentType>("claude");
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoPath, setRepoPath] = useState("");

  const fetchRepos = useCallback(async () => {
    const res = await fetch("/api/repos", { headers: authHeaders() });
    const data = await res.json();
    setRepos(data);
    if (data.length > 0 && !selectedRepoId) {
      setSelectedRepoId(data[0].id);
    }
  }, [selectedRepoId]);

  const fetchSessions = useCallback(async () => {
    if (!selectedRepoId) return;
    const res = await fetch(`/api/sessions?repoId=${selectedRepoId}`, { headers: authHeaders() });
    setSessions(await res.json());
  }, [selectedRepoId]);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  async function createSession() {
    if (!selectedRepoId) return;
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ repoId: selectedRepoId, agent: selectedAgent }),
    });
    const session = await res.json();
    navigate(`/session/${session.id}`);
  }

  async function addRepo() {
    if (!repoName.trim() || !repoPath.trim()) return;
    await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: repoName.trim(), path: repoPath.trim() }),
    });
    setRepoName("");
    setRepoPath("");
    setShowAddRepo(false);
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
            placeholder="Absolute path (e.g. /Users/kei/projects/myapp)"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          />
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

      <RepoAgentSelector
        repos={repos}
        selectedRepoId={selectedRepoId}
        selectedAgent={selectedAgent}
        onRepoChange={setSelectedRepoId}
        onAgentChange={setSelectedAgent}
      />

      <div style={{ flex: 1, overflowY: "auto" }}>
        <SessionList sessions={sessions} />
      </div>

      <div style={{ padding: "12px 16px", paddingBottom: "calc(12px + var(--safe-bottom))" }}>
        <button
          onClick={createSession}
          disabled={!selectedRepoId}
          style={{
            width: "100%",
            padding: "12px",
            background: selectedRepoId ? "var(--accent)" : "var(--bg-surface)",
            color: selectedRepoId ? "white" : "var(--text-muted)",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            fontSize: 16,
            minHeight: 48,
          }}
        >
          New Session
        </button>
      </div>
    </>
  );
}
