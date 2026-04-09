/** Supported CLI agents */
export type AgentType = "claude" | "codex";

/** Session status */
export type SessionStatus = "idle" | "running" | "stopped" | "error";

/** Turn status */
export type TurnStatus = "running" | "complete" | "error" | "stopped";

/** Repo record */
export interface Repo {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

/** Session record */
export interface Session {
  id: string;
  repoId: string;
  agent: AgentType;
  cliSessionId: string | null;
  cwd: string | null;
  name: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

/** Turn record */
export interface Turn {
  id: string;
  sessionId: string;
  seq: number;
  status: TurnStatus;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number | null;
  metadata: string | null;
}

/** Git status snapshot for a repo path */
export interface GitStatus {
  branch: string;
  dirty: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Message record */
export interface Message {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}
