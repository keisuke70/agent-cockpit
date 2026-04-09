import type { Repo, AgentType } from "@agent-cockpit/shared";

/** Sentinel value for the "All Repos" cross-repo view. */
export const ALL_REPOS = "(all)";

interface RepoAgentSelectorProps {
  repos: Repo[];
  selectedRepoId: string;
  selectedAgent: AgentType;
  onRepoChange: (repoId: string) => void;
  onAgentChange: (agent: AgentType) => void;
}

export function RepoAgentSelector({
  repos,
  selectedRepoId,
  selectedAgent,
  onRepoChange,
  onAgentChange,
}: RepoAgentSelectorProps) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "12px 16px" }}>
      <select
        value={selectedRepoId}
        onChange={(e) => onRepoChange(e.target.value)}
        style={{ flex: 1, minHeight: 44 }}
      >
        <option value="">Select repo...</option>
        <option value={ALL_REPOS}>All Repos</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      <div
        style={{
          display: "flex",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
        }}
      >
        {(["claude", "codex"] as AgentType[]).map((agent) => (
          <button
            key={agent}
            onClick={() => onAgentChange(agent)}
            style={{
              padding: "8px 14px",
              minHeight: 44,
              background:
                selectedAgent === agent ? "var(--accent)" : "var(--bg-surface)",
              color: selectedAgent === agent ? "white" : "var(--text-muted)",
              fontWeight: selectedAgent === agent ? 600 : 400,
              fontSize: 14,
            }}
          >
            {agent}
          </button>
        ))}
      </div>
    </div>
  );
}
