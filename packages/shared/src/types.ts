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

/** Schedule record (cron-based prompt firing) */
export type ScheduleStatus = "fired" | "skipped_running" | "error";

export interface Schedule {
  id: string;
  sessionId: string;
  prompt: string;
  cronExpr: string;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: ScheduleStatus | null;
  createdAt: string;
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
