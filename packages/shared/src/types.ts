/** Supported CLI agents */
export type AgentType = "claude" | "codex";

/** Session status */
export type SessionStatus = "idle" | "running" | "stopped" | "error";

/** Turn status */
export type TurnStatus = "running" | "complete" | "error" | "stopped";

export type CodexTurnSyncStatus =
  | "local_only"
  | "submit_inflight"
  | "submitted"
  | "materialized"
  | "assistant_started"
  | "assistant_completed"
  | "complete"
  | "stopped"
  | "error"
  | "desynced"
  | "retried";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexCollaborationMode = "default" | "plan";

export interface CodexSessionSettings {
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer: CodexApprovalsReviewer;
  sandboxMode: CodexSandboxMode;
  collaborationMode: CodexCollaborationMode;
  additionalWritableRoots: string[];
}

export interface CodexSkillEntity {
  name: string;
  path: string;
  description?: string;
  defaultPrompt?: string | null;
}

export interface CodexMentionEntity {
  id?: string;
  name: string;
  path: string;
  description?: string;
  kind: "app" | "plugin";
}

export interface CodexModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
}

export interface SessionCapabilities {
  codexSettings?: CodexSessionSettings;
  models?: CodexModelOption[];
  skills?: CodexSkillEntity[];
  mentions?: CodexMentionEntity[];
  warning?: string;
}

/** Repo record */
export interface Repo {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  codexSyncStatus?: CodexTurnSyncStatus | null;
  codexSyncError?: string | null;
  retryOfTurnId?: string | null;
}

/** Workspace root setting used for cross-repo sessions */
export interface WorkspaceSettings {
  rootPath: string | null;
  workspaceRepoId: string | null;
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
  codexSettings?: CodexSessionSettings;
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
  codexTurnId?: string | null;
  codexSyncStatus?: CodexTurnSyncStatus | null;
  codexSubmittedAt?: string | null;
  codexMaterializedAt?: string | null;
  codexLastCheckedAt?: string | null;
  codexSyncError?: string | null;
  retryOfTurnId?: string | null;
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
  codexSyncStatus?: CodexTurnSyncStatus | null;
  codexSyncError?: string | null;
  retryOfTurnId?: string | null;
}

/** Message record */
export interface Message {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  codexSyncStatus?: CodexTurnSyncStatus | null;
  codexSyncError?: string | null;
  retryOfTurnId?: string | null;
}
