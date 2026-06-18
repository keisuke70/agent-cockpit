import { nanoid } from "nanoid";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  SLASH_COMMANDS,
  findSlashCommandDefinition,
  type AgentType,
  type CodexApprovalPolicy,
  type CodexApprovalsReviewer,
  type CodexCollaborationMode,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type CodexSessionSettings,
  type CodexTurnSyncStatus,
  type Message,
  type PermissionRequestEvent,
  type PromptImageInput,
  type PromptMentionInput,
  type PromptSkillInput,
  type ServerEvent,
  type SessionCapabilities,
  type SessionStatus,
} from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import {
  decideCodexTerminalTransition,
  isCodexTerminalStatus,
  isCodexTurnAwaitingStart,
  shouldIgnoreTerminalForDifferentRunningTurn,
  type CodexLocalTurnSnapshot,
} from "./codex-status-authority.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import type { CLIAdapter } from "../adapters/base.js";
import { notifyAll } from "../push.js";
import {
  getCodexAppServerClient,
  isCodexAppServerAuthStaleError,
  restartCodexAppServerClient,
  restartCodexAppServerClientIfStaleForNewTurn,
  type AppServerMessage,
  type CodexAppServerClient,
} from "../codex/app-server-client.js";
import {
  type ManagedSession,
  type PendingPermissionRequest,
  getManaged,
  setManaged,
  removeManaged,
  nextSeq,
  broadcastEvent,
  broadcastLobby,
} from "../process-manager.js";

const execFileAsync = promisify(execFile);
const AUTO_TITLE_MAX_LENGTH = 48;
const IMAGE_TMP_DIR = join(tmpdir(), "agent-cockpit-codex-images");
const CODEX_TURN_RECONCILE_INTERVAL_MS = 2000;
const CODEX_TURN_RECONCILE_MAX_ATTEMPTS = 900; // 30 minutes.
const CODEX_TURN_MATERIALIZATION_DESYNC_MIN_ATTEMPTS = 10;

/**
 * Shared termination notification helper. Called from every code path that
 * transitions a session out of `running`: structured `turn_complete`, structured
 * `error`, and the one-shot `close` fallback. Push delivery is fire-and-forget.
 */
function notifyTurnTerminated(
  sessionId: string,
  outcome: "complete" | "error" | "stopped",
) {
  const db = getDb();
  const session = db
    .prepare("SELECT name FROM sessions WHERE id = ?")
    .get(sessionId) as { name: string | null } | undefined;
  const name = session?.name || `Session ${sessionId.slice(0, 8)}`;
  const titleByOutcome = {
    complete: "Turn complete",
    error: "Turn failed",
    stopped: "Turn stopped",
  } as const;
  notifyAll({
    title: titleByOutcome[outcome],
    body: name,
    sessionId,
  });
}

function getAdapter(agent: AgentType): CLIAdapter {
  switch (agent) {
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      // Kept as a fallback type-level branch. `ensureManaged` routes Codex to
      // app-server before this is used.
      return new CodexAdapter();
  }
}

type SendPromptOptions = {
  images?: PromptImageInput[];
  skills?: PromptSkillInput[];
  mentions?: PromptMentionInput[];
  allowDuplicate?: boolean;
};

function readCodexSessionSettings(sessionId: string): CodexSessionSettings {
  const row = getDb()
    .prepare(
      `SELECT codex_model as model,
              codex_reasoning_effort as reasoningEffort,
              codex_approval_policy as approvalPolicy,
              codex_approvals_reviewer as approvalsReviewer,
              codex_sandbox_mode as sandboxMode,
              codex_collaboration_mode as collaborationMode,
              codex_additional_writable_roots as additionalWritableRoots
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as any;

  return {
    model: typeof row?.model === "string" && row.model.trim() ? row.model.trim() : null,
    reasoningEffort: normalizeReasoningEffort(row?.reasoningEffort),
    approvalPolicy: normalizeApprovalPolicy(row?.approvalPolicy),
    approvalsReviewer: normalizeApprovalsReviewer(row?.approvalsReviewer),
    sandboxMode: normalizeSandboxMode(row?.sandboxMode),
    collaborationMode: normalizeCollaborationMode(row?.collaborationMode),
    additionalWritableRoots: parseStringArray(row?.additionalWritableRoots),
  };
}

function updateCodexSessionSettings(sessionId: string, patch: Partial<CodexSessionSettings>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if ("model" in patch) {
    sets.push("codex_model = ?");
    params.push(patch.model || null);
  }
  if ("reasoningEffort" in patch) {
    sets.push("codex_reasoning_effort = ?");
    params.push(patch.reasoningEffort || null);
  }
  if ("approvalPolicy" in patch && patch.approvalPolicy) {
    sets.push("codex_approval_policy = ?");
    params.push(patch.approvalPolicy);
  }
  if ("approvalsReviewer" in patch && patch.approvalsReviewer) {
    sets.push("codex_approvals_reviewer = ?");
    params.push(patch.approvalsReviewer);
  }
  if ("sandboxMode" in patch && patch.sandboxMode) {
    sets.push("codex_sandbox_mode = ?");
    params.push(patch.sandboxMode);
  }
  if ("collaborationMode" in patch && patch.collaborationMode) {
    sets.push("codex_collaboration_mode = ?");
    params.push(patch.collaborationMode);
  }
  if ("additionalWritableRoots" in patch) {
    sets.push("codex_additional_writable_roots = ?");
    params.push(JSON.stringify(patch.additionalWritableRoots ?? []));
  }
  if (!sets.length) return;
  getDb()
    .prepare(`UPDATE sessions SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...params, sessionId);
}

function codexThreadParamsFromSettings(settings: CodexSessionSettings, cwd: string, threadId?: string) {
  return {
    ...(threadId ? { threadId } : {}),
    cwd,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: normalizeReviewerForAppServer(settings.approvalsReviewer),
    sandbox: settings.sandboxMode,
    ...(settings.model ? { model: settings.model } : {}),
    serviceName: "agent_cockpit",
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  };
}

async function codexTurnParamsFromSettings(
  settings: CodexSessionSettings,
  threadId: string,
  input: unknown[],
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {
    threadId,
    input,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: normalizeReviewerForAppServer(settings.approvalsReviewer),
  };
  if (settings.model) params.model = settings.model;
  if (settings.reasoningEffort) params.effort = settings.reasoningEffort;
  const collaboration = await buildCollaborationModeParam(settings);
  if (collaboration) params.collaborationMode = collaboration;
  return params;
}

async function buildCollaborationModeParam(settings: CodexSessionSettings): Promise<Record<string, unknown> | null> {
  const model = settings.model ?? (await getDefaultCodexModelId().catch(() => null));
  if (!model) return null;
  return {
    mode: settings.collaborationMode,
    settings: {
      model,
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      developer_instructions: null,
    },
  };
}

async function getDefaultCodexModelId(): Promise<string | null> {
  const client = await getCodexAppServerClient();
  const result = await client.request("model/list", { limit: 50, includeHidden: false });
  const models = Array.isArray(result?.data) ? result.data : [];
  const found = models.find((model: any) => model?.isDefault) ?? models[0];
  return typeof found?.id === "string" ? found.id : typeof found?.model === "string" ? found.model : null;
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | null {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : null;
}
function normalizeApprovalPolicy(value: unknown): CodexApprovalPolicy {
  return value === "on-request" || value === "on-failure" || value === "untrusted" || value === "never" ? value : "never";
}
function normalizeApprovalsReviewer(value: unknown): CodexApprovalsReviewer {
  return value === "auto_review" || value === "guardian_subagent" || value === "user" ? value : "user";
}
function normalizeReviewerForAppServer(value: CodexApprovalsReviewer): string {
  return value === "auto_review" ? "guardian_subagent" : value;
}
function normalizeSandboxMode(value: unknown): CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : "danger-full-access";
}
function normalizeCollaborationMode(value: unknown): CodexCollaborationMode {
  return value === "plan" ? "plan" : "default";
}
function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function loadSessionCapabilities(
  managed: ManagedSession,
  sessionId: string,
): Promise<SessionCapabilities> {
  const codexSettings = readCodexSessionSettings(sessionId);
  if (managed.runtime !== "codex-app-server") {
    return { codexSettings };
  }

  const client = await getCodexAppServerClient();
  const cwd = getSessionCwd(sessionId);
  const [modelsResult, skillsResult, appsResult, pluginsResult] = await Promise.allSettled([
    client.request("model/list", { limit: 80, includeHidden: false }),
    client.request("skills/list", { cwds: [cwd], forceReload: false }),
    client.request("app/list", {
      limit: 80,
      threadId: managed.codexThreadId ?? null,
      forceRefetch: false,
    }),
    client.request("plugin/list", { cwds: [cwd] }),
  ]);

  const warnings = [modelsResult, skillsResult, appsResult, pluginsResult]
    .flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    )
    .slice(0, 3);

  return {
    codexSettings,
    models:
      modelsResult.status === "fulfilled"
        ? normalizeModelOptions(modelsResult.value?.data ?? [])
        : [],
    skills:
      skillsResult.status === "fulfilled"
        ? normalizeSkillEntities(flattenSkillsListEntries(skillsResult.value?.data ?? []))
        : [],
    mentions: [
      ...(appsResult.status === "fulfilled"
        ? normalizeAppMentions(appsResult.value?.data ?? [])
        : []),
      ...(pluginsResult.status === "fulfilled"
        ? normalizePluginMentions(pluginsResult.value)
        : []),
    ],
    warning: warnings.length ? warnings.join("; ") : undefined,
  };
}

function flattenSkillsListEntries(entries: any[]): any[] {
  return entries.flatMap((entry) => (Array.isArray(entry?.skills) ? entry.skills : []));
}

function normalizeModelOptions(models: any[]): NonNullable<SessionCapabilities["models"]> {
  return models
    .map((model) => ({
      id: String(model.id ?? model.model ?? ""),
      label: String(model.displayName ?? model.name ?? model.id ?? model.model ?? ""),
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    }))
    .filter((model) => model.id && model.label);
}

function normalizeSkillEntities(skills: any[]): NonNullable<SessionCapabilities["skills"]> {
  return skills
    .map((skill) => ({
      name: String(skill.name ?? skill.id ?? ""),
      path: String(skill.path ?? skill.uri ?? ""),
      description:
        typeof skill.description === "string" ? skill.description : undefined,
      defaultPrompt:
        typeof skill.defaultPrompt === "string" ? skill.defaultPrompt : null,
    }))
    .filter((skill) => skill.name && skill.path);
}

function normalizeAppMentions(apps: any[]): NonNullable<SessionCapabilities["mentions"]> {
  return apps
    .map((app) => ({
      id: typeof app.id === "string" ? app.id : undefined,
      name: String(app.name ?? app.displayName ?? app.id ?? ""),
      path: String(app.uri ?? app.path ?? (app.id ? `app://${app.id}` : "")),
      description:
        typeof app.description === "string"
          ? app.description
          : typeof app.authStatus === "string"
            ? app.authStatus
            : undefined,
      kind: "app" as const,
    }))
    .filter((mention) => mention.name && mention.path);
}

function normalizePluginMentions(result: any): NonNullable<SessionCapabilities["mentions"]> {
  const marketplaces = Array.isArray(result?.marketplaces) ? result.marketplaces : [];
  return marketplaces.flatMap((marketplace: any) =>
    (marketplace.plugins ?? marketplace.entries ?? []).map((plugin: any) => ({
      id: typeof plugin.id === "string" ? plugin.id : undefined,
      name: String(plugin.name ?? plugin.id ?? ""),
      path: String(
        plugin.uri ??
          plugin.path ??
          (plugin.name && marketplace.name
            ? `plugin://${plugin.name}@${marketplace.name}`
            : ""),
      ),
      description:
        typeof plugin.description === "string" ? plugin.description : undefined,
      kind: "plugin" as const,
    })),
  ).filter((mention: any) => mention.name && mention.path);
}

export async function ensureManaged(sessionId: string): Promise<ManagedSession> {
  let managed = getManaged(sessionId);
  if (managed) return managed;

  const db = getDb();
  const session = db
    .prepare(
      "SELECT id, repo_id, agent, cli_session_id, cwd FROM sessions WHERE id = ?",
    )
    .get(sessionId) as any;
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const repo = db
    .prepare("SELECT path FROM repos WHERE id = ?")
    .get(session.repo_id) as any;
  if (!repo) throw new Error(`Repo for session ${sessionId} not found`);

  const cwd = session.cwd ?? repo.path;

  if (session.agent === "codex") {
    managed = await ensureCodexAppServerManaged({
      sessionId,
      cwd,
      cliSessionId: session.cli_session_id ?? undefined,
    });
    setManaged(sessionId, managed);
    return managed;
  }

  const adapter = getAdapter(session.agent);
  const handle = await adapter.init({
    cwd,
    cliSessionId: session.cli_session_id ?? undefined,
  });

  managed = {
    sessionId,
    runtime: "cli",
    adapter,
    handle,
    seq: 0,
    eventBuffer: [],
    listeners: new Set(),
  };

  setManaged(sessionId, managed);

  // Claude is one-shot-per-turn (no long-lived process from init). Process
  // listeners are attached in sendPrompt after startTurn.

  return managed;
}

async function ensureCodexAppServerManaged(opts: {
  sessionId: string;
  cwd: string;
  cliSessionId?: string;
}): Promise<ManagedSession> {
  const client = await getCodexAppServerClient();
  const settings = readCodexSessionSettings(opts.sessionId);
  let threadId: string | null = null;
  let threadStatusType: string | null = null;
  let unreadableThreadId: string | null = null;
  let startedReplacementThread = false;

  if (opts.cliSessionId) {
    try {
      const resumed = await client.request(
        "thread/resume",
        codexThreadParamsFromSettings(settings, opts.cwd, opts.cliSessionId),
      );
      threadId = resumed?.thread?.id ?? opts.cliSessionId;
      threadStatusType = resumed?.thread?.status?.type ?? null;
    } catch {
      unreadableThreadId = opts.cliSessionId;
      threadId = null;
    }
  }

  if (!threadId) {
    const started = await client.request(
      "thread/start",
      codexThreadParamsFromSettings(settings, opts.cwd),
    );
    threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    threadStatusType = started?.thread?.status?.type ?? null;
    startedReplacementThread = Boolean(unreadableThreadId);

    getDb()
      .prepare(
        `UPDATE sessions
         SET cli_session_id = ?,
             codex_unreadable_thread_id = COALESCE(codex_unreadable_thread_id, ?),
             codex_unreadable_at = CASE
               WHEN ? IS NOT NULL AND codex_unreadable_at IS NULL THEN datetime('now')
               ELSE codex_unreadable_at
             END,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(threadId, unreadableThreadId, unreadableThreadId, opts.sessionId);
  }

  reconcileCodexThreadStatus(opts.sessionId, threadStatusType);

  const managed: ManagedSession = {
    sessionId: opts.sessionId,
    runtime: "codex-app-server",
    codexThreadId: threadId,
    codexAppServerGeneration: client.generation,
    codexActiveTurnId: null,
    codexStopRequested: false,
    codexStoppingTurnId: null,
    codexLocalTurnByCodexTurnId: new Map(),
    codexCodexTurnByLocalTurnId: new Map(),
    codexPendingLocalTurnId: null,
    codexThreadUnhealthy: false,
    codexThreadFresh: startedReplacementThread,
    pendingPermissions: new Map(),
    activeTools: [],
    seq: 0,
    eventBuffer: [],
    listeners: new Set(),
  };

  managed.cleanup = client.subscribeThread(threadId, (message) => {
    handleCodexAppServerMessage(managed, opts.sessionId, message);
  });

  return managed;
}

type MessageSource = "cockpit" | "cache";

export type DisplayTranscriptSource = "codex-thread" | "db" | "db-fallback";

export interface DisplayMessagesResult {
  messages: Message[];
  source: DisplayTranscriptSource;
  warning?: string;
  threadName?: string | null;
}

interface CodexTranscriptResult {
  messages: Message[];
  threadName: string | null;
  threadPreview: string | null;
  threadStatusType: string | null;
  latestTurnStatus: string | null;
  latestTurnId: string | null;
}

export async function refreshDisplayTranscript(
  managed: ManagedSession,
  sessionId: string,
): Promise<DisplayMessagesResult> {
  const result = await listDisplayMessagesForSession(managed, sessionId);
  broadcastEvent(managed, {
    type: "transcript_refreshed",
    messages: result.messages,
    transcriptSource: result.source,
    transcriptWarning: result.warning,
    seq: nextSeq(managed),
  });
  return result;
}

export async function listDisplayMessagesForSession(
  managed: ManagedSession,
  sessionId: string,
): Promise<DisplayMessagesResult> {
  if (managed.runtime !== "codex-app-server") {
    return { messages: listSessionMessages(sessionId), source: "db" };
  }

  if (!managed.codexThreadId) {
    return {
      messages: listSessionMessages(sessionId),
      source: "db-fallback",
      warning: "Codex thread id is unavailable; showing Pocket Agent DB fallback.",
    };
  }

  const resumeMarker = getCodexUnreadableThreadMarker(sessionId);
  try {
    const transcript = await readCodexTranscript(managed.codexThreadId, sessionId);
    reconcileCodexThreadStatus(
      sessionId,
      transcript.threadStatusType,
      transcript.latestTurnStatus,
      transcript.latestTurnId,
      managed,
    );
    const legacy = resumeMarker
      ? listLegacyCodexMessagesForUnreadableThread(sessionId, resumeMarker.at)
      : [];
    const overlay = listCodexCockpitOverlayMessages(sessionId);
    const cacheOverlay = filterCodexCacheOverlayMessages(
      transcript.messages,
      listCodexCacheOverlayMessages(sessionId),
    );
    const messages = mergeDisplayMessages(
      resumeMarker
        ? [...legacy, ...transcript.messages, ...cacheOverlay, ...overlay]
        : [...transcript.messages, ...cacheOverlay, ...overlay],
    );
    const source: DisplayTranscriptSource =
      resumeMarker && (legacy.length > 0 || transcript.messages.length === 0)
        ? "db-fallback"
        : "codex-thread";
    const warning = resumeMarker
      ? `Previous Codex thread ${resumeMarker.threadId} could not be resumed; showing preserved Pocket Agent DB history with the current Codex thread.`
      : undefined;

    syncCodexThreadNameFromAppServer(managed, sessionId, transcript.threadName);

    return {
      messages,
      source,
      warning,
      threadName: transcript.threadName,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Codex transcript read failed";
    return {
      messages: listSessionMessages(sessionId),
      source: "db-fallback",
      warning: `Codex transcript read failed; showing Pocket Agent DB fallback. ${message}`,
    };
  }
}


function syncCodexThreadNameFromAppServer(
  managed: ManagedSession,
  sessionId: string,
  name: unknown,
) {
  const nextName = typeof name === "string" ? name.trim() : "";
  if (!nextName) return;

  const db = getDb();
  const row = db
    .prepare("SELECT name FROM sessions WHERE id = ?")
    .get(sessionId) as { name: string | null } | undefined;
  if (row?.name === nextName) return;

  db.prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(nextName, sessionId);

  broadcastEvent(managed, {
    type: "session_updated",
    sessionId,
    name: nextName,
    seq: nextSeq(managed),
  });
}

function messageFromThreadItem(
  item: any,
): { role: "user" | "assistant"; content: string } | null {
  if (item?.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? item.content
          .map((part: any) => {
            if (part?.type === "text") return String(part.text ?? "");
            if (part?.type === "image") return `[image: ${part.url ?? ""}]`;
            if (part?.type === "localImage") return `[local image: ${part.path ?? ""}]`;
            if (part?.type === "skill") return `[$${part.name ?? "skill"}]`;
            if (part?.type === "mention") return `[@${part.name ?? "mention"}]`;
            return "";
          })
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";
    return content ? { role: "user", content } : null;
  }

  if (item?.type === "agentMessage") {
    const content = String(item.text ?? "").trim();
    return content ? { role: "assistant", content } : null;
  }

  if (item?.type === "plan") {
    const content = String(item.text ?? "").trim();
    return content ? { role: "assistant", content } : null;
  }

  return null;
}

async function readCodexTranscript(
  threadId: string,
  sessionId: string,
): Promise<CodexTranscriptResult> {
  const client = await getCodexAppServerClient();
  let result: any;
  try {
    result = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
  } catch (err) {
    if (!isUnmaterializedCodexThreadReadError(err)) {
      throw err;
    }

    // Fresh Codex app-server threads are created before the first user message,
    // but `thread/read` currently rejects `includeTurns: true` until the thread
    // has been materialized by an actual turn. That is a normal empty-session
    // state, not a transcript failure, so keep the chat blank without surfacing
    // a scary DB-fallback warning in newly opened sessions.
    try {
      result = await client.request("thread/read", { threadId });
    } catch {
      return {
        messages: [],
        threadName: null,
        threadPreview: null,
        threadStatusType: null,
        latestTurnStatus: null,
        latestTurnId: null,
      };
    }
  }
  const thread = result?.thread ?? {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages: Message[] = [];

  turns.forEach((turn: any, turnIndex: number) => {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    items.forEach((item: any, itemIndex: number) => {
      const extracted = messageFromThreadItem(item);
      if (!extracted) return;
      const timestamp =
        extracted.role === "user"
          ? turn?.startedAt ?? turn?.completedAt ?? thread.updatedAt ?? thread.createdAt
          : turn?.completedAt ?? turn?.startedAt ?? thread.updatedAt ?? thread.createdAt;
      messages.push({
        id: stableCodexMessageId(threadId, turn, item, turnIndex, itemIndex, extracted.role),
        sessionId,
        turnId: null,
        role: extracted.role,
        content: extracted.content,
        createdAt: isoTimestampFromUnixSeconds(timestamp),
      });
    });
  });

  return {
    messages,
    threadName: typeof thread.name === "string" && thread.name.trim() ? thread.name : null,
    threadPreview:
      typeof thread.preview === "string" && thread.preview.trim() ? thread.preview : null,
    threadStatusType:
      typeof thread.status?.type === "string" ? thread.status.type : null,
    latestTurnStatus:
      typeof turns.at(-1)?.status === "string" ? turns.at(-1).status : null,
    latestTurnId:
      typeof turns.at(-1)?.id === "string" ? turns.at(-1).id : null,
  };
}

async function readCodexThreadTurns(
  threadId: string,
): Promise<{ turns: any[]; threadStatusType: string | null }> {
  const client = await getCodexAppServerClient();
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const thread = result?.thread ?? {};
  return {
    turns: Array.isArray(thread.turns) ? thread.turns : [],
    threadStatusType:
      typeof thread.status?.type === "string" ? thread.status.type : null,
  };
}

function isUnmaterializedCodexThreadReadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("not materialized yet") &&
    message.includes("includeTurns")
  );
}

function stableCodexMessageId(
  threadId: string,
  turn: any,
  item: any,
  turnIndex: number,
  itemIndex: number,
  role: string,
): string {
  if (turn?.id && item?.id) return `${threadId}:${turn.id}:${item.id}`;
  return `${threadId}:turn-${turnIndex}:item-${itemIndex}:${role}`;
}

function isoTimestampFromUnixSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return new Date().toISOString();
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function getCodexUnreadableThreadMarker(
  sessionId: string,
): { threadId: string; at: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT codex_unreadable_thread_id as threadId,
              codex_unreadable_at as at
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as { threadId?: string | null; at?: string | null } | undefined;
  return row?.threadId ? { threadId: row.threadId, at: row.at ?? null } : null;
}

function listCodexCockpitOverlayMessages(sessionId: string): Message[] {
  return getDb()
    .prepare(
      `SELECT messages.id, messages.session_id as sessionId, messages.turn_id as turnId, messages.role, messages.content,
              messages.created_at as createdAt,
              turns.codex_sync_status as codexSyncStatus,
              turns.codex_sync_error as codexSyncError,
              turns.retry_of_turn_id as retryOfTurnId
       FROM messages
       LEFT JOIN turns ON turns.id = messages.turn_id
       WHERE messages.session_id = ?
         AND (
           messages.source = 'cockpit'
           OR (
             messages.source IS NULL
             AND turn_id IN (
               SELECT turn_id FROM messages
               WHERE session_id = ? AND role = 'user' AND content LIKE '/%'
             )
           )
         )
       ORDER BY messages.created_at ASC, messages.id ASC`,
    )
    .all(sessionId, sessionId) as Message[];
}

function listCodexCacheOverlayMessages(sessionId: string): Message[] {
  return getDb()
    .prepare(
      `SELECT messages.id,
              messages.session_id as sessionId,
              messages.turn_id as turnId,
              messages.role,
              messages.content,
              messages.created_at as createdAt,
              turns.codex_sync_status as codexSyncStatus,
              turns.codex_sync_error as codexSyncError,
              turns.retry_of_turn_id as retryOfTurnId
       FROM messages
       LEFT JOIN turns ON turns.id = messages.turn_id
       WHERE messages.session_id = ?
         AND messages.source = 'cache'
         AND messages.role IN ('user', 'assistant')
       ORDER BY messages.created_at ASC, messages.id ASC`,
    )
    .all(sessionId) as Message[];
}

function filterCodexCacheOverlayMessages(
  transcriptMessages: Message[],
  cacheMessages: Message[],
): Message[] {
  return cacheMessages.filter((cached) => {
    if (["desynced", "local_only", "submit_inflight", "submitted"].includes(String(cached.codexSyncStatus ?? ""))) {
      return true;
    }
    return !transcriptMessages.some((message) => {
      if (message.role !== cached.role || message.content !== cached.content) {
        return false;
      }

      // Exact same transcript content wins over the local cache regardless of
      // timestamp. App-server materialization can assign timestamps that differ
      // from Cockpit's accepted-at time, and a narrow timestamp window
      // reintroduces duplicate bubbles after a reconnect/deploy refresh.
      return true;
    });
  });
}

function listLegacyCodexMessagesForUnreadableThread(
  sessionId: string,
  unreadableAt: string | null,
): Message[] {
  const cutoffClause = unreadableAt ? "AND created_at <= ?" : "";
  const params = unreadableAt ? [sessionId, unreadableAt] : [sessionId];
  return getDb()
    .prepare(
      `SELECT messages.id, messages.session_id as sessionId, messages.turn_id as turnId, messages.role, messages.content,
              messages.created_at as createdAt,
              turns.codex_sync_status as codexSyncStatus,
              turns.codex_sync_error as codexSyncError,
              turns.retry_of_turn_id as retryOfTurnId
       FROM messages
       LEFT JOIN turns ON turns.id = messages.turn_id
       WHERE messages.session_id = ?
         AND messages.external_id IS NULL
         AND (messages.source IS NULL OR messages.source IN ('cache', 'cockpit'))
         ${cutoffClause}
       ORDER BY messages.created_at ASC, messages.id ASC`,
    )
    .all(...params) as Message[];
}

function mergeDisplayMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const timeA = Date.parse(a.message.createdAt);
      const timeB = Date.parse(b.message.createdAt);
      const safeA = Number.isNaN(timeA) ? 0 : timeA;
      const safeB = Number.isNaN(timeB) ? 0 : timeB;
      return safeA === safeB ? a.index - b.index : safeA - safeB;
    })
    .flatMap(({ message }) => {
      const key = `${message.id}\u0000${message.role}\u0000${message.content}\u0000${message.createdAt}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [message];
    });
}

export async function getLastUserMessage(
  managed: ManagedSession,
  sessionId: string,
): Promise<string | null> {
  if (managed.runtime === "codex-app-server" && managed.codexThreadId) {
    try {
      const transcript = await readCodexTranscript(managed.codexThreadId, sessionId);
      const lastUser = [...transcript.messages].reverse().find((m) => m.role === "user");
      if (lastUser?.content) return lastUser.content;
    } catch {
      // Fall back to Cockpit DB below.
    }
  }

  const excludeSlash = managed.runtime === "codex-app-server";
  const row = getDb()
    .prepare(
      `SELECT content FROM messages
       WHERE session_id = ? AND role = 'user'
         ${excludeSlash ? "AND content NOT LIKE '/%'" : ""}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { content?: string } | undefined;
  return row?.content ?? null;
}

function listSessionMessages(sessionId: string): Message[] {
  return getDb()
    .prepare(
      `SELECT messages.id, messages.session_id as sessionId, messages.turn_id as turnId, messages.role, messages.content,
              messages.created_at as createdAt,
              turns.codex_sync_status as codexSyncStatus,
              turns.codex_sync_error as codexSyncError,
              turns.retry_of_turn_id as retryOfTurnId
       FROM messages
       LEFT JOIN turns ON turns.id = messages.turn_id
       WHERE messages.session_id = ? ORDER BY messages.created_at ASC`,
    )
    .all(sessionId) as Message[];
}

function attachProcessListeners(
  managed: ManagedSession,
  sessionId: string,
  isOneShot: boolean,
) {
  const { handle, adapter } = managed;
  if (!handle?.proc?.stdout || !adapter) return;

  let buffer = "";
  handle.proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();

    // Forward the raw chunk to listeners as a debug-view event. Excluded
    // from the eventBuffer in process-manager (live-only).
    broadcastEvent(managed, {
      type: "raw_stdout",
      data: text,
      seq: nextSeq(managed),
    });

    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = adapter.parseEvent(line);
      if (!event) continue;

      const seq = nextSeq(managed);

      if (event.type === "init" && event.sessionId) {
        const db = getDb();
        db.prepare(
          "UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(event.sessionId, sessionId);
        if (managed.handle) managed.handle.cliSessionId = event.sessionId as string;
      }

      const serverEvent: ServerEvent = { ...event, seq } as any;
      broadcastEvent(managed, serverEvent);

      if (event.type === "message_complete") {
        persistMessage(sessionId, "assistant", event.content as string);
      }

      if (event.type === "turn_complete") {
        completeTurn(sessionId, event.cost as number | undefined);
        updateSessionStatus(sessionId, "idle");
        broadcastEvent(managed, {
          type: "status",
          status: "idle",
          seq: nextSeq(managed),
        });
        notifyTurnTerminated(sessionId, "complete");
      }

      if (event.type === "error") {
        failTurn(sessionId);
        updateSessionStatus(sessionId, "error");
        broadcastEvent(managed, {
          type: "status",
          status: "error",
          seq: nextSeq(managed),
        });
        notifyTurnTerminated(sessionId, "error");
      }
    }
  });

  handle.proc.on("close", (code) => {
    if (isOneShot) {
      const db = getDb();
      const session = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionId) as any;

      if (session?.status === "running") {
        if (code === 0) {
          completeTurn(sessionId);
          updateSessionStatus(sessionId, "idle");
          broadcastEvent(managed, {
            type: "status",
            status: "idle",
            seq: nextSeq(managed),
          });
          notifyTurnTerminated(sessionId, "complete");
        } else {
          stopTurn(sessionId);
          updateSessionStatus(sessionId, "stopped");
          broadcastEvent(managed, {
            type: "status",
            status: "stopped",
            seq: nextSeq(managed),
          });
          notifyTurnTerminated(sessionId, "stopped");
        }
      }
      handle.proc = null;
    } else {
      const db = getDb();
      const sess = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionId) as { status: string } | undefined;
      const wasRunning = sess?.status === "running";
      if (wasRunning) {
        stopTurn(sessionId);
      }
      updateSessionStatus(sessionId, "stopped");
      broadcastEvent(managed, {
        type: "status",
        status: "stopped",
        seq: nextSeq(managed),
      });
      if (wasRunning) {
        notifyTurnTerminated(sessionId, "stopped");
      }
      removeManaged(sessionId);
    }
  });
}

export function isCodexThreadBusyForNewWork(
  managed: ManagedSession,
  sessionId: string,
): boolean {
  const session = getDb()
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as { status?: string } | undefined;
  const localTurnRunning = hasRunningTurn(sessionId);
  if (managed.runtime === "codex-app-server" && session?.status !== "running" && !localTurnRunning && !managed.codexStoppingTurnId) {
    managed.codexStopRequested = false;
    managed.codexActiveTurnId = null;
    managed.codexPendingLocalTurnId = null;
  }
  return Boolean(
    session?.status === "running" ||
      localTurnRunning ||
      managed.codexStopRequested ||
      managed.codexActiveTurnId ||
      managed.codexPendingLocalTurnId,
  );
}

export function sendPrompt(
  managed: ManagedSession,
  sessionId: string,
  content: string,
  options: SendPromptOptions = {},
): { ok: boolean; error?: string } {
  const db = getDb();
  const session = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as any;
  const localTurnRunning = hasRunningTurn(sessionId);

  // A Codex stop is best-effort: after a server restart or a reconnect race the
  // local DB can already be stopped/idle while the in-memory ManagedSession
  // still carries `codexStopRequested = true`. If we keep that stale flag, the
  // next prompt to the same session is rejected as "already running" and the UI
  // appears to hard-error. Clear stale runtime flags whenever there is no local
  // active turn.
  if (
    managed.runtime === "codex-app-server" &&
    session?.status !== "running" &&
    !localTurnRunning &&
    !managed.codexStoppingTurnId
  ) {
    managed.codexStopRequested = false;
    managed.codexActiveTurnId = null;
    managed.codexPendingLocalTurnId = null;
    managed.codexStoppingTurnId = null;
  }

  if (
    session?.status === "running" ||
    localTurnRunning ||
    managed.codexStopRequested ||
    Boolean(managed.codexActiveTurnId) ||
    Boolean(managed.codexPendingLocalTurnId)
  ) {
    return { ok: false, error: "Session is already running" };
  }

  const hasStructuredInput =
    Boolean(options.images?.length) ||
    Boolean(options.skills?.length) ||
    Boolean(options.mentions?.length);
  const normalizedContent = content.trim();
  if (!normalizedContent && !hasStructuredInput) {
    return { ok: false, error: "Prompt is empty" };
  }

  if (managed.runtime === "codex-app-server" && !options.allowDuplicate && isLikelyDuplicateRecentCodexPrompt(sessionId, normalizedContent)) {
    return { ok: false, error: "Duplicate prompt ignored; the same message was just submitted." };
  }

  const slashContent = content.trimStart();
  const messageSource: MessageSource | undefined =
    managed.runtime === "codex-app-server"
      ? slashContent.startsWith("/")
        ? "cockpit"
        : "cache"
      : undefined;
  const displayContent = buildPromptDisplayContent(content, options);
  const turnId = createRunningTurn(sessionId, displayContent, messageSource);

  if (!slashContent.startsWith("/") && managed.runtime !== "codex-app-server") {
    maybeAutoTitleSession(managed, sessionId, displayContent);
  }

  if (slashContent.startsWith("/")) {
    updateSessionStatus(sessionId, "running");
    broadcastEvent(managed, {
      type: "status",
      status: "running",
      seq: nextSeq(managed),
    });
    if (managed.runtime === "codex-app-server") {
      void handleSlashCommand(managed, sessionId, turnId, slashContent);
    } else {
      void handleNonCodexSlashCommand(managed, sessionId, turnId, slashContent);
    }
    return { ok: true };
  }

  updateSessionStatus(sessionId, "running");
  broadcastEvent(managed, {
    type: "status",
    status: "running",
    seq: nextSeq(managed),
  });

  if (managed.runtime === "codex-app-server") {
    void startCodexTurn(managed, sessionId, turnId, normalizedContent, options);
    return { ok: true };
  }

  if (!managed.adapter || !managed.handle) {
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    return { ok: false, error: "Session runtime is not available" };
  }

  managed.adapter.startTurn(managed.handle, normalizedContent);

  if (managed.handle.proc) {
    attachProcessListeners(managed, sessionId, true);
  }

  return { ok: true };
}

async function startCodexTurn(
  managed: ManagedSession,
  sessionId: string,
  localTurnId: string,
  content: string,
  options: SendPromptOptions = {},
  authRetryAttempt = 0,
) {
  const cleanupPaths: string[] = [];
  try {
    const client = await prepareCodexClientForNewTurn(managed, sessionId);
    if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
    if (managed.codexThreadUnhealthy) {
      await rotateCodexThread(managed, sessionId, "Previous Codex thread accepted turns that never materialized.");
    }
    if (!managed.codexThreadId) throw new Error("Missing Codex thread id");

    const input = await buildCodexInput(content, options, cleanupPaths);
    updateTurnSyncById(localTurnId, "submit_inflight");
    managed.codexPendingLocalTurnId = localTurnId;
    const settings = readCodexSessionSettings(sessionId);
    const result = await client.request(
      "turn/start",
      await codexTurnParamsFromSettings(settings, managed.codexThreadId, input),
    );
    const turnId = result?.turn?.id ?? managed.codexActiveTurnId ?? null;
    if (turnId) {
      linkCodexTurn(managed, localTurnId, turnId);
      updateTurnSyncById(localTurnId, "submitted", undefined, {
        codexTurnId: turnId,
        submitted: true,
      });
      managed.codexThreadFresh = false;
      if (getSessionStatus(sessionId) === "running") {
        managed.codexActiveTurnId = turnId;
      }
      watchCodexTurnUntilTerminal(managed, sessionId, localTurnId, turnId);
      const materialized = await verifyCodexTurnMaterialized(sessionId, managed, localTurnId, { retries: 10 });
      if (!materialized && !managed.codexStopRequested && isTurnRunning(localTurnId)) {
        // Do not mark the Cockpit turn idle/desynced here. `turn/start` returned
        // a Codex turn id, so Codex may still be running while thread/read is
        // temporarily stale. The terminal watchdog will only mark desynced after
        // a later canonical read shows the thread idle without the accepted turn.
        updateTurnSyncById(localTurnId, "submitted", "Waiting for Codex transcript materialization.");
      }
    }
    if (turnId && managed.codexStopRequested) {
      managed.codexStoppingTurnId = turnId;
      await interruptCodexTurn(managed, turnId);
      return;
    }
    if (getSessionStatus(sessionId) === "running") {
      managed.codexActiveTurnId = turnId;
    }
  } catch (err) {
    if (
      managed.codexStopRequested ||
      getSessionStatus(sessionId) === "stopped" ||
      !hasRunningTurn(sessionId)
    ) {
      managed.codexStopRequested = false;
      managed.codexActiveTurnId = null;
      managed.codexPendingLocalTurnId = null;
      return;
    }
    let message = err instanceof Error ? err.message : "Failed to start Codex turn";
    if (isCodexAppServerAuthStaleError(message) && authRetryAttempt < 1) {
      broadcastEvent(managed, {
        type: "error",
        message: "Codex app-server auth looked stale. Restarting the app-server and retrying this prompt once.",
        nonFatal: true,
        seq: nextSeq(managed),
      });
      updateTurnSyncById(localTurnId, "submit_inflight", "Restarting stale Codex app-server auth bridge and retrying.");
      try {
        restartCodexAppServerClient("Codex app-server auth looked stale during turn/start retry.");
        await rebindCodexBridgeAfterPlannedRestart(managed, sessionId);
        await startCodexTurn(managed, sessionId, localTurnId, content, options, authRetryAttempt + 1);
        return;
      } catch (retryErr) {
        message = retryErr instanceof Error ? retryErr.message : "Failed to restart Codex app-server after stale auth";
      }
    }
    if (managed.codexThreadUnhealthy || message.includes("Codex app-server")) {
      updateTurnSyncById(localTurnId, "submit_inflight", message);
      broadcastEvent(managed, {
        type: "error",
        message,
        nonFatal: true,
        seq: nextSeq(managed),
      });
      void recoverCodexBridgeAfterLocalFatal(managed, sessionId);
      return;
    }
    managed.codexActiveTurnId = null;
    managed.codexPendingLocalTurnId = null;
    managed.codexStopRequested = false;
    managed.codexStoppingTurnId = null;
    clearActiveTools(managed);
    failTurnById(localTurnId, message);
    updateSessionStatus(sessionId, "error");
    broadcastEvent(managed, {
      type: "error",
      message,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
  } finally {
    void cleanupTempFiles(cleanupPaths);
  }
}

async function prepareCodexClientForNewTurn(
  managed: ManagedSession,
  sessionId: string,
): Promise<CodexAppServerClient> {
  await restartStaleCodexBridgeBeforeNewTurn(managed, sessionId);
  let client = await ensureCodexBridgeBoundToCurrentClient(managed, sessionId);
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  await ensureCodexThreadReadyForTurn(managed, sessionId);
  client = await ensureCodexBridgeBoundToCurrentClient(managed, sessionId);
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  return client;
}

async function runCodexTurnOperationWithAuthRetry<T>(
  managed: ManagedSession,
  sessionId: string,
  label: string,
  operation: (client: CodexAppServerClient) => Promise<T>,
  attempt = 0,
): Promise<T> {
  try {
    const client = await prepareCodexClientForNewTurn(managed, sessionId);
    const result = await operation(client);
    managed.codexThreadFresh = false;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCodexAppServerAuthStaleError(message) && attempt < 1) {
      broadcastEvent(managed, {
        type: "error",
        message: `Codex app-server auth looked stale while running ${label}. Restarting and retrying once.`,
        nonFatal: true,
        seq: nextSeq(managed),
      });
      restartCodexAppServerClient(`Codex app-server auth looked stale during ${label}.`);
      await rebindCodexBridgeAfterPlannedRestart(managed, sessionId);
      return runCodexTurnOperationWithAuthRetry(managed, sessionId, label, operation, attempt + 1);
    }
    throw err;
  }
}

async function restartStaleCodexBridgeBeforeNewTurn(
  managed: ManagedSession,
  sessionId: string,
) {
  if (managed.runtime !== "codex-app-server") return;
  if (hasOtherRunningCodexSession(sessionId)) return;
  const restarted = restartCodexAppServerClientIfStaleForNewTurn();
  if (!restarted) return;
  broadcastEvent(managed, {
    type: "error",
    message: "Codex app-server had been running for a long time, so Pocket Agent restarted it before sending this prompt.",
    nonFatal: true,
    seq: nextSeq(managed),
  });
  await rebindCodexBridgeAfterPlannedRestart(managed, sessionId);
}

function hasOtherRunningCodexSession(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM sessions
       WHERE id != ? AND agent = 'codex' AND status = 'running'
       LIMIT 1`,
    )
    .get(sessionId);
  return Boolean(row);
}

function rebindCodexBridgeSubscription(
  managed: ManagedSession,
  sessionId: string,
  client: CodexAppServerClient,
) {
  if (managed.runtime !== "codex-app-server" || !managed.codexThreadId) return;
  managed.cleanup?.();
  managed.codexAppServerGeneration = client.generation;
  managed.cleanup = client.subscribeThread(managed.codexThreadId, (message) => {
    handleCodexAppServerMessage(managed, sessionId, message);
  });
}

async function ensureCodexBridgeBoundToCurrentClient(
  managed: ManagedSession,
  sessionId: string,
): Promise<CodexAppServerClient> {
  const client = await getCodexAppServerClient();
  if (managed.codexAppServerGeneration !== client.generation) {
    await rebindCodexBridgeAfterPlannedRestart(managed, sessionId);
    const reboundClient = await getCodexAppServerClient();
    rebindCodexBridgeSubscription(managed, sessionId, reboundClient);
    return reboundClient;
  }
  rebindCodexBridgeSubscription(managed, sessionId, client);
  return client;
}

async function rebindCodexBridgeAfterPlannedRestart(
  managed: ManagedSession,
  sessionId: string,
) {
  if (managed.runtime !== "codex-app-server") return;
  const client = await getCodexAppServerClient();
  const settings = readCodexSessionSettings(sessionId);
  const cwd = getSessionCwd(sessionId);
  const previousThreadId = managed.codexThreadId ?? null;
  let nextThreadId = previousThreadId;

  if (previousThreadId) {
    try {
      const resumed = await client.request(
        "thread/resume",
        codexThreadParamsFromSettings(settings, cwd, previousThreadId),
      );
      nextThreadId =
        typeof resumed?.thread?.id === "string" ? resumed.thread.id : previousThreadId;
      const turns = Array.isArray(resumed?.thread?.turns) ? resumed.thread.turns : [];
      managed.codexThreadFresh =
        managed.codexThreadFresh === true &&
        turns.length === 0 &&
        !hasMaterializedCodexTurn(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isUnmaterializedCodexThreadReadError(err) && !message.includes("no rollout")) {
        throw err;
      }
      nextThreadId = null;
    }
  }

  if (!nextThreadId) {
    const started = await client.request(
      "thread/start",
      codexThreadParamsFromSettings(settings, cwd),
    );
    nextThreadId = typeof started?.thread?.id === "string" ? started.thread.id : null;
    if (!nextThreadId) {
      throw new Error("Codex app-server did not return a thread id after bridge restart");
    }
    managed.codexThreadFresh = true;
  }

  if (nextThreadId !== previousThreadId) {
    getDb()
      .prepare("UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(nextThreadId, sessionId);
  }

  managed.cleanup?.();
  managed.codexThreadId = nextThreadId ?? undefined;
  managed.codexAppServerGeneration = client.generation;
  managed.codexThreadUnhealthy = false;
  if (nextThreadId) {
    managed.cleanup = client.subscribeThread(nextThreadId, (message) => {
      handleCodexAppServerMessage(managed, sessionId, message);
    });
  }
}

function buildPromptDisplayContent(content: string, options: SendPromptOptions): string {
  const parts = [content.trim()].filter(Boolean);
  if (options.skills?.length) {
    parts.push(options.skills.map((skill) => `$${skill.name}`).join(" "));
  }
  if (options.mentions?.length) {
    parts.push(options.mentions.map((mention) => `@${mention.name}`).join(" "));
  }
  if (options.images?.length) {
    parts.push(
      options.images
        .map((image) => `[image: ${image.name?.trim() || image.mimeType || "attachment"}]`)
        .join("\n"),
    );
  }
  return parts.join("\n").trim() || "Attached structured input";
}

async function buildCodexInput(
  content: string,
  options: SendPromptOptions,
  cleanupPaths: string[],
): Promise<unknown[]> {
  const input: unknown[] = [];

  for (const skill of options.skills ?? []) {
    if (!skill.name || !skill.path) continue;
    input.push({ type: "skill", name: skill.name, path: skill.path });
  }

  for (const mention of options.mentions ?? []) {
    if (!mention.name || !mention.path) continue;
    input.push({ type: "mention", name: mention.name, path: mention.path });
  }

  for (const image of options.images ?? []) {
    const path = await writePromptImage(image);
    cleanupPaths.push(path);
    input.push({ type: "localImage", path });
  }

  const text = content.trim() || (input.length ? "Please analyze the attached input." : "");
  if (text) {
    input.push({ type: "text", text, text_elements: [] });
  }

  return input;
}

async function writePromptImage(image: PromptImageInput): Promise<string> {
  if (!image.base64) throw new Error("Image attachment is missing data");
  await mkdir(IMAGE_TMP_DIR, { recursive: true });
  const ext = imageExtension(image.mimeType);
  const path = join(IMAGE_TMP_DIR, `${Date.now()}-${nanoid()}${ext}`);
  await writeFile(path, Buffer.from(stripDataUrlPrefix(image.base64), "base64"));
  return path;
}

function stripDataUrlPrefix(value: string): string {
  return value.replace(/^data:[^;]+;base64,/i, "");
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

async function cleanupTempFiles(paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
}

async function rotateCodexThread(
  managed: ManagedSession,
  sessionId: string,
  reason: string,
) {
  if (managed.runtime !== "codex-app-server") return;
  const oldThreadId = managed.codexThreadId ?? null;
  const client = await getCodexAppServerClient();
  const settings = readCodexSessionSettings(sessionId);
  const cwd = getSessionCwd(sessionId);
  const started = await client.request(
    "thread/start",
    codexThreadParamsFromSettings(settings, cwd),
  );
  const nextThreadId = started?.thread?.id;
  if (typeof nextThreadId !== "string" || !nextThreadId.trim()) {
    throw new Error("Codex app-server did not return a replacement thread id");
  }

  managed.cleanup?.();
  managed.codexThreadId = nextThreadId;
  managed.codexActiveTurnId = null;
  managed.codexStopRequested = false;
  managed.codexStoppingTurnId = null;
  managed.codexPendingLocalTurnId = null;
  managed.codexThreadUnhealthy = false;
  managed.codexThreadFresh = true;
  managed.codexLocalTurnByCodexTurnId = new Map();
  managed.codexCodexTurnByLocalTurnId = new Map();
  managed.codexAppServerGeneration = client.generation;
  managed.cleanup = client.subscribeThread(nextThreadId, (message) => {
    handleCodexAppServerMessage(managed, sessionId, message);
  });

  getDb()
    .prepare(
      `UPDATE sessions
       SET cli_session_id = ?,
           codex_unreadable_thread_id = COALESCE(codex_unreadable_thread_id, ?),
           codex_unreadable_at = CASE
             WHEN ? IS NOT NULL AND codex_unreadable_at IS NULL THEN datetime('now')
             ELSE codex_unreadable_at
           END,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(nextThreadId, oldThreadId, oldThreadId, sessionId);

  broadcastEvent(managed, {
    type: "error",
    message: `${reason} Started a fresh Codex thread and will preserve prior Pocket Agent history as local fallback.`,
    nonFatal: true,
    seq: nextSeq(managed),
  });
}

async function ensureCodexThreadReadyForTurn(
  managed: ManagedSession,
  sessionId: string,
) {
  if (managed.runtime !== "codex-app-server" || !managed.codexThreadId) return;
  if (managed.codexThreadFresh && !hasMaterializedCodexTurn(sessionId)) {
    // A brand-new app-server thread can legitimately have no rollout file yet;
    // the first turn materializes it. Calling thread/resume before that first
    // turn fails with "no rollout found", so only preflight-resume threads that
    // Cockpit has already observed in the Codex transcript. Imported or older
    // rows are not marked fresh, so they still get a resume attempt even if
    // local Cockpit never recorded codex_materialized_at.
    return;
  }
  const client = await getCodexAppServerClient();
  const settings = readCodexSessionSettings(sessionId);
  const cwd = getSessionCwd(sessionId);
  const resumed = await client.request(
    "thread/resume",
    codexThreadParamsFromSettings(settings, cwd, managed.codexThreadId),
  );
  managed.codexAppServerGeneration = client.generation;
  const thread = resumed?.thread ?? {};
  const threadId = typeof thread.id === "string" ? thread.id : managed.codexThreadId;
  if (threadId !== managed.codexThreadId) {
    managed.cleanup?.();
    managed.codexThreadId = threadId;
    managed.codexAppServerGeneration = client.generation;
    getDb()
      .prepare("UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(threadId, sessionId);
    managed.cleanup = client.subscribeThread(threadId, (message) => {
      handleCodexAppServerMessage(managed, sessionId, message);
    });
  }
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (turns.length > 0 || hasMaterializedCodexTurn(sessionId)) {
    managed.codexThreadFresh = false;
  }
  reconcileCodexThreadStatus(
    sessionId,
    typeof thread.status?.type === "string" ? thread.status.type : null,
    typeof turns.at(-1)?.status === "string" ? turns.at(-1).status : null,
    typeof turns.at(-1)?.id === "string" ? turns.at(-1).id : null,
    managed,
  );
}

function watchCodexTurnUntilTerminal(
  managed: ManagedSession,
  sessionId: string,
  localTurnId: string,
  codexTurnId: string,
) {
  void reconcileCodexTurnUntilTerminal(managed, sessionId, localTurnId, codexTurnId);
}

async function reconcileCodexTurnUntilTerminal(
  managed: ManagedSession,
  sessionId: string,
  localTurnId: string,
  codexTurnId: string,
) {
  for (let attempt = 0; attempt < CODEX_TURN_RECONCILE_MAX_ATTEMPTS; attempt++) {
    await delay(CODEX_TURN_RECONCILE_INTERVAL_MS);
    if (!isTurnRunning(localTurnId) || getSessionStatus(sessionId) !== "running") {
      return;
    }
    if (!managed.codexThreadId) return;

    let thread: { turns: any[]; threadStatusType: string | null };
    try {
      thread = await readCodexThreadTurns(managed.codexThreadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTurnSyncById(localTurnId, "submitted", message);
      continue;
    }

    const turn = thread.turns.find((candidate) => candidate?.id === codexTurnId);
    if (!turn) {
      // `thread/read` can lag and expose an older terminal latest turn while the
      // newly accepted Codex turn is still materializing. An unmatched latest
      // terminal is therefore not evidence for this local turn. Only a clearly
      // idle thread after a grace window may unlock as retryable desync.
      if (thread.threadStatusType === "idle" && attempt >= CODEX_TURN_MATERIALIZATION_DESYNC_MIN_ATTEMPTS) {
        markTurnDesynced(localTurnId, "Codex accepted turn/start but the accepted turn never appeared in the target transcript.");
        managed.codexActiveTurnId = null;
        managed.codexStopRequested = false;
        managed.codexStoppingTurnId = null;
        managed.codexPendingLocalTurnId = null;
        clearActiveTools(managed);
        updateSessionStatus(sessionId, "idle");
        await refreshDisplayTranscript(managed, sessionId);
        broadcastEvent(managed, { type: "status", status: "idle", seq: nextSeq(managed) });
        broadcastEvent(managed, {
          type: "error",
          message: "Prompt was saved locally, but Codex did not confirm it in the transcript. Use Retry on that message.",
          nonFatal: true,
          code: "codex_desynced",
          seq: nextSeq(managed),
        });
      } else {
        updateTurnSyncById(localTurnId, "submitted", "Waiting for exact Codex turn materialization.");
      }
      continue;
    }

    linkCodexTurn(managed, localTurnId, codexTurnId);
    if (turn.status === "inProgress") {
      updateTurnSyncById(localTurnId, "materialized", undefined, {
        codexTurnId,
        materialized: true,
      });
      continue;
    }

    if (!isTurnRunning(localTurnId) || getSessionStatus(sessionId) !== "running") {
      return;
    }
    await completeCodexTurnFromNotification(managed, sessionId, localTurnId, turn);
    await refreshDisplayTranscript(managed, sessionId);
    return;
  }
}

export async function retryDesyncedTurn(
  managed: ManagedSession,
  sessionId: string,
  originalTurnId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (managed.runtime !== "codex-app-server") {
    return { ok: false, error: "Desynced retry is only available for Codex sessions" };
  }
  const row = getTurnSyncRow(originalTurnId);
  if (!row?.content?.trim()) {
    return { ok: false, error: "Original desynced prompt was not found" };
  }
  if (getSessionStatus(sessionId) === "running" || hasRunningTurn(sessionId)) {
    return { ok: false, error: "Session is already running" };
  }
  const materialized = await verifyCodexTurnMaterialized(sessionId, managed, originalTurnId, { retries: 1 });
  if (materialized) {
    await refreshDisplayTranscript(managed, sessionId);
    return { ok: true };
  }
  if (isCodexThreadBusyForNewWork(managed, sessionId)) {
    return { ok: false, error: "Session is already running" };
  }

  const newTurnId = createRunningTurn(sessionId, row.content, "cache", originalTurnId);
  updateTurnSyncById(originalTurnId, "retried");
  updateSessionStatus(sessionId, "running");
  broadcastEvent(managed, { type: "status", status: "running", seq: nextSeq(managed) });

  void startCodexTurn(managed, sessionId, newTurnId, row.content);
  return { ok: true };
}

export function stopSession(managed: ManagedSession, sessionId: string) {
  const localTurnIsRunning =
    hasRunningTurn(sessionId) || getSessionStatus(sessionId) === "running";
  if (!localTurnIsRunning) {
    return;
  }

  if (managed.runtime === "codex-app-server") {
    const threadId = managed.codexThreadId;
    const turnId = managed.codexActiveTurnId;
    void declinePendingPermissions(managed);
    managed.codexStopRequested = true;
    managed.codexStoppingTurnId = turnId ?? null;
    if (threadId && turnId) {
      void interruptCodexTurn(managed, turnId);
      return;
    }
    if (managed.codexPendingLocalTurnId) {
      // A turn/start is still in flight. Keep Cockpit running until Codex returns
      // a turn id and then interrupts it, or until startCodexTurn proves that no
      // Codex turn was ever accepted. This avoids showing stopped before Codex
      // has actually stopped.
      return;
    }
  } else if (managed.adapter && managed.handle) {
    managed.adapter.stopTurn(managed.handle);
  }

  stopTurn(sessionId);
  updateSessionStatus(sessionId, "stopped");
  clearActiveTools(managed);
  const seq = nextSeq(managed);
  broadcastEvent(managed, { type: "status", status: "stopped", seq });
  notifyTurnTerminated(sessionId, "stopped");
}

async function declinePendingPermissions(managed: ManagedSession) {
  const pending = [...(managed.pendingPermissions?.values() ?? [])];
  if (!pending.length) return;
  const client = await getCodexAppServerClient();
  for (const request of pending) {
    client.respond(request.requestId as number, buildPermissionResponse(request, "reject"));
    managed.pendingPermissions?.delete(request.id);
    broadcastEvent(managed, {
      type: "permission_resolved",
      id: request.id,
      seq: nextSeq(managed),
    });
  }
}

export function listPendingPermissions(managed: ManagedSession): PermissionRequestEvent[] {
  return [...(managed.pendingPermissions?.values() ?? [])].map((request) => ({
    type: "permission_request",
    id: request.id,
    kind: request.kind,
    toolName: request.toolName,
    input: request.input,
    allowForSession: request.allowForSession,
    seq: request.seq,
  }));
}

export async function resolvePermissionRequest(
  managed: ManagedSession,
  id: string,
  action: "approve" | "approve_session" | "reject" | "answer",
  answer?: string,
) {
  const pending = managed.pendingPermissions?.get(id);
  if (!pending) return;

  const client = await getCodexAppServerClient();
  client.respond(
    pending.requestId as number,
    buildPermissionResponse(pending, action, answer),
  );
  managed.pendingPermissions?.delete(id);
  broadcastEvent(managed, {
    type: "permission_resolved",
    id,
    seq: nextSeq(managed),
  });
}

function buildPermissionResponse(
  request: PendingPermissionRequest,
  action: "approve" | "approve_session" | "reject" | "answer",
  answer?: string,
): unknown {
  if (request.kind === "questions") {
    return { answers: action === "reject" ? {} : buildUserInputAnswers(request.input, answer ?? "") };
  }

  if (request.kind === "elicitation") {
    return action === "reject"
      ? { action: "decline", content: null, _meta: null }
      : { action: "accept", content: answer ?? "", _meta: null };
  }

  if (request.kind === "permissions") {
    if (action === "reject") return { permissions: {}, scope: "turn" };
    const permissions = normalizeGrantedPermissions(
      request.requestedPermissions ?? request.input.permissions,
    );
    return {
      permissions,
      scope: action === "approve_session" ? "session" : "turn",
    };
  }

  if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
    return {
      decision:
        action === "reject"
          ? "denied"
          : action === "approve_session"
            ? "approved_for_session"
            : "approved",
    };
  }

  return {
    decision:
      action === "reject"
        ? "decline"
        : action === "approve_session"
          ? "acceptForSession"
          : "accept",
  };
}

function normalizeGrantedPermissions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const requested = value as Record<string, unknown>;
  return Object.fromEntries(
    ["network", "fileSystem"].flatMap((key) => {
      const grant = requested[key];
      return grant && typeof grant === "object" ? [[key, grant]] : [];
    }),
  );
}

function buildUserInputAnswers(input: Record<string, unknown>, answer: string): Record<string, { answers: string[] }> {
  const questions = input.questions;
  if (!Array.isArray(questions)) return answer ? { answer: { answers: [answer] } } : {};
  return Object.fromEntries(
    questions.map((question: any, index) => [
      String(question?.id ?? question?.name ?? `answer_${index + 1}`),
      { answers: answer ? [answer] : [] },
    ]),
  );
}

function handleCodexAppServerMessage(
  managed: ManagedSession,
  sessionId: string,
  message: AppServerMessage,
) {
  const method = message.method;
  const params = message.params ?? {};


  if (method === "thread/name/updated") {
    const threadId = typeof params.threadId === "string"
      ? params.threadId
      : typeof params.thread?.id === "string"
        ? params.thread.id
        : null;
    if (!threadId || threadId === managed.codexThreadId) {
      syncCodexThreadNameFromAppServer(
        managed,
        sessionId,
        params.name ?? params.thread?.name ?? params.title,
      );
    }
    return;
  }

  if (method === "item/tool/call" && typeof message.id === "number") {
    void respondUnsupportedDynamicToolCall(managed, message.id, params);
    return;
  }

  const permissionRequest = normalizePermissionRequest(message);
  if (permissionRequest) {
    managed.pendingPermissions ??= new Map();
    managed.pendingPermissions.set(permissionRequest.id, permissionRequest);
    broadcastEvent(managed, {
      ...permissionRequest,
      seq: nextSeq(managed),
    });
    return;
  }

  if (
    method?.startsWith("item/") &&
    (managed.codexStopRequested || !hasRunningTurn(sessionId))
  ) {
    return;
  }

  if (method === "item/agentMessage/delta") {
    markCodexTurnActivity(managed, sessionId, params.turnId ?? managed.codexActiveTurnId ?? null, "assistant_started");
    broadcastEvent(managed, {
      type: "text_delta",
      text: String(params.delta ?? ""),
      seq: nextSeq(managed),
    });
    return;
  }

  if (method === "item/plan/delta") {
    markCodexTurnActivity(managed, sessionId, params.turnId ?? managed.codexActiveTurnId ?? null, "assistant_started");
    broadcastEvent(managed, {
      type: "text_delta",
      text: String(params.delta ?? ""),
      seq: nextSeq(managed),
    });
    return;
  }

  if (method === "turn/started") {
    const codexTurnId = typeof params.turn?.id === "string" ? params.turn.id : null;
    if (codexTurnId) {
      const existingLocalTurnId = localTurnIdForCodexTurn(managed, sessionId, codexTurnId);
      if (existingLocalTurnId) {
        linkCodexTurn(managed, existingLocalTurnId, codexTurnId);
        updateTurnSyncById(existingLocalTurnId, "submitted", undefined, { codexTurnId, submitted: true });
        watchCodexTurnUntilTerminal(managed, sessionId, existingLocalTurnId, codexTurnId);
        if (managed.codexStopRequested) {
          managed.codexStoppingTurnId = codexTurnId;
          void interruptCodexTurn(managed, codexTurnId);
          return;
        }
        if (getSessionStatus(sessionId) === "running") {
          managed.codexActiveTurnId = codexTurnId;
        }
      } else if (managed.codexPendingLocalTurnId) {
        // Do not attach an arbitrary started notification to the submit-inflight
        // local row. The `turn/start` response or bounded content recovery must
        // establish correlation first; otherwise stale app-server notifications
        // can make a new local turn inherit an old terminal lifecycle.
        updateTurnSyncById(managed.codexPendingLocalTurnId, "submit_inflight", `Ignoring unmatched Codex turn/started ${codexTurnId}.`);
      }
    }
    return;
  }

  if (method === "item/started") {
    markCodexTurnActivity(managed, sessionId, params.turnId ?? managed.codexActiveTurnId ?? null, "assistant_started");
    const toolUse = normalizeToolUse(params.item);
    if (toolUse) {
      const activeTool = rememberActiveTool(managed, params.item, toolUse);
      broadcastEvent(managed, {
        type: "tool_use",
        tool: activeTool.tool,
        input: activeTool.input,
        id: activeTool.id,
        timestamp: activeTool.timestamp,
        seq: nextSeq(managed),
      });
    }
    return;
  }

  if (method === "item/completed") {
    const item = params.item;
    if (normalizeToolUse(item)) {
      forgetActiveTool(managed, item);
    }
    if (item?.type === "agentMessage" || item?.type === "plan") {
      const content = String(item.text ?? "");
      const codexTurnId = typeof params.turnId === "string" ? params.turnId : managed.codexActiveTurnId ?? null;
      const localTurnId = localTurnIdForCodexTurn(managed, sessionId, codexTurnId);
      const externalId = managed.codexThreadId && codexTurnId && item.id
        ? `${managed.codexThreadId}:${codexTurnId}:${item.id}`
        : undefined;
      if (localTurnId) updateTurnSyncById(localTurnId, "assistant_completed");
      persistMessage(sessionId, "assistant", content, localTurnId ?? undefined, externalId, "cache");
      broadcastEvent(managed, {
        type: "message_complete",
        role: "assistant",
        content,
        messageId: externalId,
        seq: nextSeq(managed),
      });
    }
    return;
  }

  if (method === "turn/completed") {
    const completedTurnId =
      typeof params.turn?.id === "string" ? params.turn.id : null;

    if (
      completedTurnId &&
      managed.codexActiveTurnId &&
      completedTurnId !== managed.codexActiveTurnId
    ) {
      // A previously interrupted Codex turn can complete after Cockpit has
      // already moved on to a later local turn. Never let that stale terminal
      // event mutate the newest running turn.
      if (completedTurnId === managed.codexStoppingTurnId) {
        managed.codexStopRequested = false;
        managed.codexStoppingTurnId = null;
      }
      return;
    }

    const localTurnId = localTurnIdForCodexTurn(managed, sessionId, completedTurnId);
    if (!localTurnId) {
      if (completedTurnId && completedTurnId === managed.codexStoppingTurnId) {
        managed.codexStopRequested = false;
        managed.codexStoppingTurnId = null;
      }
      if (!hasRunningTurn(sessionId)) {
        managed.codexActiveTurnId = null;
        clearActiveTools(managed);
      } else if (managed.codexPendingLocalTurnId) {
        updateTurnSyncById(managed.codexPendingLocalTurnId, "submit_inflight", `Ignoring unmatched Codex terminal turn ${completedTurnId ?? "<unknown>"}.`);
      }
      return;
    }
    // Do not require the Cockpit DB turn to still be `running` here. The local
    // server can mark a turn stopped/error during a WebSocket reconnect, manual
    // interrupt, or launchd restart while Codex keeps producing terminal
    // transcript items. Applying the canonical terminal notification by local
    // turn id lets Cockpit repair the stale status and push the transcript live
    // instead of only showing the missing messages after a browser reload.
    void completeCodexTurnFromNotification(managed, sessionId, localTurnId, params.turn);
    return;
  }

  if (method === "thread/compacted") {
    const latest = getLatestRunningTurnSyncRow(sessionId);
    if (!latest) {
      managed.codexActiveTurnId = null;
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      clearActiveTools(managed);
      return;
    }
    if (latest.messageSource === "cockpit") {
      completeTurnById(latest.id);
      updateSessionStatus(sessionId, "idle");
      clearActiveTools(managed);
      broadcastEvent(managed, { type: "turn_complete", seq: nextSeq(managed) });
      broadcastEvent(managed, { type: "status", status: "idle", seq: nextSeq(managed) });
      notifyTurnTerminated(sessionId, "complete");
      return;
    }
    // Compaction is not an exact terminal event for the active text turn. Keep
    // the session running; the exact terminal notification/watchdog owns the
    // eventual transition.
    updateTurnSyncById(latest.id, latest.codexSyncStatus as CodexTurnSyncStatus || "submitted", "Codex compacted context while the turn is still awaiting exact terminal status.");
    return;
  }

  if (method === "error") {
    const errMessage = String(params.message ?? "Codex app-server error");
    const localTurnRunning =
      hasRunningTurn(sessionId) || getSessionStatus(sessionId) === "running";

    if (isCodexAppServerAuthStaleError(errMessage)) {
      broadcastEvent(managed, {
        type: "error",
        message: "Codex app-server auth became stale. Restarting the app-server bridge before accepting more work.",
        nonFatal: true,
        seq: nextSeq(managed),
      });
      managed.codexThreadUnhealthy = true;
      clearActiveTools(managed);
      restartCodexAppServerClient(errMessage);
      if (localTurnRunning) {
        void recoverCodexBridgeAfterLocalFatal(managed, sessionId);
      } else {
        managed.codexActiveTurnId = null;
        managed.codexStopRequested = false;
        managed.codexStoppingTurnId = null;
        removeManaged(sessionId);
      }
      return;
    }

    if (params.localFatal && !localTurnRunning) {
      // The shared Codex app-server process can exit while this Cockpit
      // session is idle/stopped. That invalidates the in-memory bridge, not
      // the user session itself. Drop the bridge so a later reconnect/prompt
      // recreates it, but do not flip the persisted session to Error.
      managed.codexActiveTurnId = null;
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      removeManaged(sessionId);
      return;
    }

    if (params.localFatal) {
      // A local app-server bridge failure is not proof that the Codex turn
      // failed. Leave the Cockpit turn running so the next snapshot/reconnect can
      // reconcile against the canonical Codex thread instead of preemptively
      // turning the UI red while Codex may still be completing the response.
      broadcastEvent(managed, {
        type: "error",
        message: errMessage,
        nonFatal: true,
        seq: nextSeq(managed),
      });
      managed.codexThreadUnhealthy = true;
      clearActiveTools(managed);
      void recoverCodexBridgeAfterLocalFatal(managed, sessionId);
      return;
    }

    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const localTurnId = localTurnIdForCodexTurn(managed, sessionId, turnId);
    if (localTurnId) {
      updateTurnSyncById(localTurnId, "materialized", errMessage, {
        codexTurnId: turnId ?? undefined,
        materialized: true,
      });
      if (turnId && isTurnRunning(localTurnId)) {
        watchCodexTurnUntilTerminal(managed, sessionId, localTurnId, turnId);
      }
    }
    // Codex's protocol-level `error` notification is turn-scoped and may be
    // followed by `turn/completed` with status `interrupted`/`failed`, or by a
    // retry. Treat it as diagnostic only; the canonical terminal turn status or
    // the watchdog must decide Cockpit's stopped/error/idle state. Failing the
    // session here was the remaining path that made the UI show ready while the
    // Codex thread still had work/items to reconcile.
    broadcastEvent(managed, {
      type: "error",
      message: errMessage,
      nonFatal: true,
      seq: nextSeq(managed),
    });
  }
}

async function respondUnsupportedDynamicToolCall(
  managed: ManagedSession,
  requestId: number,
  params: any,
) {
  const toolName = params.namespace
    ? `${params.namespace}/${params.tool ?? "tool"}`
    : String(params.tool ?? "tool");
  const message = `Pocket Agent does not support app/plugin dynamic tool execution yet: ${toolName}`;
  try {
    const client = await getCodexAppServerClient();
    client.respond(requestId, {
      contentItems: [{ type: "inputText", text: message }],
      success: false,
    });
  } catch {
    // If the app-server is already gone, the normal local-fatal error path
    // handles session cleanup.
  }
  broadcastEvent(managed, {
    type: "error",
    message,
    nonFatal: true,
    code: "codex_dynamic_tool_unsupported",
    seq: nextSeq(managed),
  });
}

function normalizePermissionRequest(message: AppServerMessage): PendingPermissionRequest | null {
  if (!message.method || typeof message.id !== "number") return null;
  const params = message.params ?? {};
  const id = String(message.id);

  if (message.method === "execCommandApproval" || message.method === "item/commandExecution/requestApproval") {
    const item = params.item ?? params;
    return {
      type: "permission_request",
      id,
      requestId: message.id,
      method: message.method,
      params,
      kind: "command",
      toolName: "command",
      input: compactObject({
        command: item.command ?? params.command,
        cwd: item.cwd ?? params.cwd,
        reason: params.reason ?? item.reason,
      }),
      allowForSession: true,
      seq: 0,
    };
  }

  if (message.method === "applyPatchApproval" || message.method === "item/fileChange/requestApproval") {
    const item = params.item ?? params;
    return {
      type: "permission_request",
      id,
      requestId: message.id,
      method: message.method,
      params,
      kind: "file",
      toolName: item.toolName ?? "file change",
      input: compactObject({
        path: item.path ?? item.file_path ?? item.filePath,
        changes: item.changes ?? params.changes,
        reason: params.reason ?? item.reason,
      }),
      allowForSession: true,
      seq: 0,
    };
  }

  if (message.method === "item/permissions/requestApproval") {
    const permissions = params.permissions ?? params.requestedPermissions ?? {};
    return {
      type: "permission_request",
      id,
      requestId: message.id,
      method: message.method,
      params,
      kind: "permissions",
      toolName: "permissions",
      input: compactObject({
        permissions,
        reason: params.reason,
      }),
      requestedPermissions:
        permissions && typeof permissions === "object" ? permissions : undefined,
      allowForSession: true,
      seq: 0,
    };
  }

  if (message.method === "item/tool/requestUserInput") {
    return {
      type: "permission_request",
      id,
      requestId: message.id,
      method: message.method,
      params,
      kind: "questions",
      toolName: params.toolName ?? "user input",
      input: compactObject({
        questions: params.questions ?? params.input?.questions ?? params.input,
      }),
      seq: 0,
    };
  }

  if (message.method === "mcpServer/elicitation/request") {
    return {
      type: "permission_request",
      id,
      requestId: message.id,
      method: message.method,
      params,
      kind: "elicitation",
      toolName: params.serverName ?? params.server ?? "MCP elicitation",
      input: compactObject({
        message: params.message,
        requestedSchema: params.requestedSchema,
        schema: params.schema,
      }),
      seq: 0,
    };
  }

  return null;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  );
}

async function recoverCodexBridgeAfterLocalFatal(managed: ManagedSession, sessionId: string, attempt = 0) {
  await delay(1000);
  if (!hasRunningTurn(sessionId) && getSessionStatus(sessionId) !== "running") return;
  try {
    if (managed.codexThreadId) {
      const client = await getCodexAppServerClient();
      managed.cleanup?.();
      managed.codexAppServerGeneration = client.generation;
      managed.cleanup = client.subscribeThread(managed.codexThreadId, (message) => {
        handleCodexAppServerMessage(managed, sessionId, message);
      });
    }
    await refreshDisplayTranscript(managed, sessionId);
    const settled = await reconcilePendingCodexStartAfterRecovery(managed, sessionId);
    managed.codexThreadUnhealthy = false;
    if (!settled && attempt < 30) {
      void recoverCodexBridgeAfterLocalFatal(managed, sessionId, attempt + 1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Codex bridge recovery failed";
    broadcastEvent(managed, {
      type: "transcript_refresh_failed",
      message,
      seq: nextSeq(managed),
    });
    if (attempt < 30) {
      void recoverCodexBridgeAfterLocalFatal(managed, sessionId, attempt + 1);
    }
  }
}

async function reconcilePendingCodexStartAfterRecovery(managed: ManagedSession, sessionId: string): Promise<boolean> {
  const pendingTurnId = managed.codexPendingLocalTurnId;
  if (!pendingTurnId || !managed.codexThreadId || !isTurnRunning(pendingTurnId)) return true;
  const linkedTurn = managed.codexCodexTurnByLocalTurnId?.get(pendingTurnId) ?? null;
  if (linkedTurn) return true;
  const thread = await readCodexThreadTurns(managed.codexThreadId);
  const inProgressTurns = thread.turns.filter((turn) => turn?.status === "inProgress" && typeof turn?.id === "string");
  const latestTurn = thread.turns.at(-1);
  const candidate =
    inProgressTurns.length === 1
      ? inProgressTurns[0]
      : latestTurn?.status === "inProgress" && typeof latestTurn?.id === "string"
        ? latestTurn
        : null;
  if (candidate?.id) {
    linkCodexTurn(managed, pendingTurnId, candidate.id);
    updateTurnSyncById(pendingTurnId, "materialized", undefined, {
      codexTurnId: candidate.id,
      submitted: true,
      materialized: true,
    });
    managed.codexActiveTurnId = candidate.id;
    watchCodexTurnUntilTerminal(managed, sessionId, pendingTurnId, candidate.id);
    return true;
  }
  if (thread.threadStatusType !== "idle") return false;
  markTurnDesynced(pendingTurnId, "Codex app-server restarted during turn/start and no accepted turn materialized in the transcript.");
  managed.codexPendingLocalTurnId = null;
  managed.codexActiveTurnId = null;
  managed.codexStopRequested = false;
  managed.codexStoppingTurnId = null;
  updateSessionStatus(sessionId, "idle");
  await refreshDisplayTranscript(managed, sessionId);
  broadcastEvent(managed, { type: "status", status: "idle", seq: nextSeq(managed) });
  broadcastEvent(managed, {
    type: "error",
    message: "Prompt was saved locally, but Codex did not confirm it in the transcript. Use Retry on that message.",
    nonFatal: true,
    code: "codex_desynced",
    seq: nextSeq(managed),
  });
  notifyTurnTerminated(sessionId, "error");
  return true;
}

async function interruptCodexTurn(managed: ManagedSession, turnId: string) {
  if (!managed.codexThreadId) return;
  try {
    const client = await getCodexAppServerClient();
    await client.request("turn/interrupt", {
      threadId: managed.codexThreadId,
      turnId,
    });
  } catch {
    // Stop is best-effort. The local Cockpit state has already moved to
    // stopped, and a late completion notification is ignored when no running
    // Cockpit turn remains.
  } finally {
    // Do not clear codexStopRequested here. It is a guard that prevents a new
    // prompt from starting on the same app-server thread until the terminal
    // turn/completed notification arrives (or a local slash command observes
    // that its Cockpit turn was stopped).
  }
}

function rememberActiveTool(
  managed: ManagedSession,
  item: any,
  toolUse: { tool: string; input: unknown },
) {
  const activeTool = {
    id: typeof item?.id === "string" ? item.id : undefined,
    tool: toolUse.tool,
    input: toolUse.input,
    timestamp: Date.now(),
  };
  const existing = managed.activeTools ?? [];
  managed.activeTools = activeTool.id
    ? [...existing.filter((tool) => tool.id !== activeTool.id), activeTool]
    : [...existing, activeTool];
  return activeTool;
}

function forgetActiveTool(managed: ManagedSession, item: any) {
  if (!managed.activeTools?.length) return;
  const itemId = typeof item?.id === "string" ? item.id : null;
  const toolUse = normalizeToolUse(item);
  const next = itemId
    ? managed.activeTools.filter((tool) => tool.id !== itemId)
    : managed.activeTools.filter(
        (tool) => !(tool.tool === toolUse?.tool && JSON.stringify(tool.input) === JSON.stringify(toolUse.input)),
      );
  if (next.length === managed.activeTools.length) return;
  managed.activeTools = next;
  broadcastEvent(managed, {
    type: "active_tools",
    activeTools: managed.activeTools,
    seq: nextSeq(managed),
  });
}

function clearActiveTools(managed: ManagedSession) {
  if (!managed.activeTools?.length) return;
  managed.activeTools = [];
  broadcastEvent(managed, {
    type: "active_tools",
    activeTools: [],
    seq: nextSeq(managed),
  });
}

function normalizeToolUse(item: any): { tool: string; input: unknown } | null {
  switch (item?.type) {
    case "commandExecution":
      return {
        tool: "command",
        input: { command: item.command, cwd: item.cwd },
      };
    case "fileChange":
      return { tool: "fileChange", input: { changes: item.changes } };
    case "mcpToolCall":
      return {
        tool: `${item.server ?? "mcp"}/${item.tool ?? "tool"}`,
        input: item.arguments ?? {},
      };
    case "dynamicToolCall":
      return {
        tool: item.namespace ? `${item.namespace}/${item.tool}` : item.tool ?? "tool",
        input: item.arguments ?? {},
      };
    case "webSearch":
      return { tool: "webSearch", input: { query: item.query } };
    case "contextCompaction":
      return { tool: "contextCompaction", input: { status: "inProgress" } };
    case "enteredReviewMode":
      return { tool: "review", input: { status: "entered" } };
    case "exitedReviewMode":
      return { tool: "review", input: { status: "exited" } };
    default:
      return null;
  }
}

async function completeCodexTurnFromNotification(
  managed: ManagedSession,
  sessionId: string,
  localTurnId: string,
  turn: any,
) {
  const status = turn?.status;
  const codexTurnId = typeof turn?.id === "string" ? turn.id : null;
  const row = getTurnSyncRow(localTurnId);
  if (!isCodexTerminalStatus(status)) return;
  const currentRunning = getLatestRunningTurnSyncRow(sessionId);
  if (shouldIgnoreTerminalForDifferentRunningTurn(currentRunning, localTurnId)) {
    updateTurnSyncById(
      currentRunning!.id,
      currentRunning!.codexSyncStatus as CodexTurnSyncStatus || (isCodexTurnAwaitingStart(currentRunning) ? "submit_inflight" : "submitted"),
      `Ignoring stale terminal for older Codex turn ${codexTurnId ?? "<unknown>"} while a newer local turn is running.`,
    );
    if (codexTurnId && codexTurnId === managed.codexStoppingTurnId) {
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
    }
    return;
  }
  const decision = decideCodexTerminalTransition(row, codexTurnId, status);
  if (decision.action === "ignore") {
    if (row) updateTurnSyncById(localTurnId, row.codexSyncStatus as CodexTurnSyncStatus || "submitted", `Ignoring ${decision.reason} Codex terminal ${codexTurnId ?? "<unknown>"}.`);
    return;
  }
  if (codexTurnId) linkCodexTurn(managed, localTurnId, codexTurnId);
  managed.codexActiveTurnId = null;
  managed.codexStopRequested = false;
  managed.codexStoppingTurnId = null;
  managed.codexPendingLocalTurnId = null;
  clearActiveTools(managed);

  if (status === "completed") {
    const hasAssistantEvidence = row?.codexSyncStatus === "assistant_completed" || row?.codexSyncStatus === "assistant_started";
    const materialized = await verifyCodexTurnMaterialized(sessionId, managed, localTurnId, { retries: hasAssistantEvidence ? 1 : 3 });
    if (!materialized && !hasAssistantEvidence) {
      markTurnDesynced(localTurnId, "Codex turn completed but was not found in app-server transcript and no assistant activity was observed.");
      updateSessionStatus(sessionId, "idle");
      await refreshDisplayTranscript(managed, sessionId);
      broadcastEvent(managed, { type: "status", status: "idle", seq: nextSeq(managed) });
      broadcastEvent(managed, {
        type: "error",
        message: "Prompt was saved locally, but Codex did not confirm it in the transcript. Use Retry on that message.",
        nonFatal: true,
        code: "codex_desynced",
        seq: nextSeq(managed),
      });
      notifyTurnTerminated(sessionId, "error");
      return;
    }
    completeTurnById(localTurnId);
    updateSessionStatus(sessionId, "idle");
    await refreshDisplayTranscript(managed, sessionId);
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "complete");
    return;
  }

  if (status === "interrupted") {
    stopTurnById(localTurnId);
    updateSessionStatus(sessionId, "stopped");
    await refreshDisplayTranscript(managed, sessionId);
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "stopped",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "stopped");
    return;
  }

  const message = turn?.error?.message ?? "Codex turn failed";
  failTurnById(localTurnId, message);
  updateSessionStatus(sessionId, "error");
  await refreshDisplayTranscript(managed, sessionId);
  broadcastEvent(managed, {
    type: "error",
    message,
    seq: nextSeq(managed),
  });
  broadcastEvent(managed, {
    type: "status",
    status: "error",
    seq: nextSeq(managed),
  });
  notifyTurnTerminated(sessionId, "error");
}

async function handleSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  turnId: string,
  content: string,
) {
  try {
    const result = await runSlashCommand(managed, sessionId, content);
    if (!isTurnRunning(turnId) || getSessionStatus(sessionId) !== "running") {
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      return;
    }

    if (result.type === "codex-turn") {
      if (result.codexTurnId) {
        linkCodexTurn(managed, turnId, result.codexTurnId);
        updateTurnSyncById(turnId, "submitted", undefined, {
          codexTurnId: result.codexTurnId,
          submitted: true,
        });
        watchCodexTurnUntilTerminal(managed, sessionId, turnId, result.codexTurnId);
        if (managed.codexStopRequested) {
          managed.codexStoppingTurnId = result.codexTurnId;
          await interruptCodexTurn(managed, result.codexTurnId);
          return;
        }
        managed.codexActiveTurnId = result.codexTurnId;
      } else {
        updateTurnSyncById(turnId, "submit_inflight");
        managed.codexPendingLocalTurnId = turnId;
      }
      return;
    }

    const reply = result.content;
    persistMessage(sessionId, "assistant", reply, turnId, undefined, "cockpit");
    completeTurn(sessionId);
    updateSessionStatus(sessionId, "idle");
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "message_complete",
      role: "assistant",
      content: reply,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
  } catch (err) {
    if (!isTurnRunning(turnId) || getSessionStatus(sessionId) === "stopped") {
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      return;
    }
    const message = err instanceof Error ? err.message : "Slash command failed";
    persistMessage(
      sessionId,
      "assistant",
      `Slash command failed: ${message}`,
      turnId,
      undefined,
      "cockpit",
    );
    managed.codexActiveTurnId = null;
    managed.codexPendingLocalTurnId = null;
    managed.codexStopRequested = false;
    managed.codexStoppingTurnId = null;
    clearActiveTools(managed);
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    broadcastEvent(managed, {
      type: "error",
      message,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
  }
}

async function handleNonCodexSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  turnId: string,
  content: string,
) {
  try {
    const reply = await runNonCodexSlashCommand(managed, sessionId, content);
    if (!isTurnRunning(turnId) || getSessionStatus(sessionId) !== "running") {
      return;
    }
    persistMessage(sessionId, "assistant", reply, turnId);
    completeTurn(sessionId);
    updateSessionStatus(sessionId, "idle");
    broadcastEvent(managed, {
      type: "status",
      status: "idle",
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "message_complete",
      role: "assistant",
      content: reply,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "turn_complete",
      seq: nextSeq(managed),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Slash command failed";
    persistMessage(sessionId, "assistant", `Slash command failed: ${message}`, turnId);
    failTurn(sessionId);
    updateSessionStatus(sessionId, "error");
    broadcastEvent(managed, {
      type: "error",
      message,
      seq: nextSeq(managed),
    });
    broadcastEvent(managed, {
      type: "status",
      status: "error",
      seq: nextSeq(managed),
    });
    notifyTurnTerminated(sessionId, "error");
  }
}

async function runNonCodexSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  content: string,
): Promise<string> {
  const trimmed = content.trim();
  const [command] = trimmed.split(/\s+/, 1);
  const definition = findSlashCommandDefinition(command.toLowerCase());
  const canonical = definition?.command ?? command.toLowerCase();

  switch (canonical) {
    case "/help":
      return slashHelp();
    case "/status":
      return slashBasicStatus(sessionId);
    case "/model":
      return slashModels(sessionId);
    case "/reasoning":
      return slashReasoning(sessionId, trimmed.slice(command.length).trim());
    case "/permissions":
      return slashPermissions(sessionId);
    case "/mcp":
      return slashMcp(trimmed.slice(command.length).trim());
    case "/diff":
      return slashDiff(sessionId);
    case "/debug-config":
      return slashDebugConfig(managed, sessionId);
    case "/experimental":
      return slashExperimental();
    case "/skills":
      return slashSkills(sessionId);
    case "/hooks":
      return slashHooks(sessionId);
    case "/apps":
      return slashApps(managed);
    case "/plugins":
      return slashPlugins(sessionId);
    case "/rename":
      return slashRenameCockpitOnly(sessionId, trimmed.slice(command.length).trim());
    case "/copy":
      return slashCopyLastAssistantMessage(managed, sessionId);
    case "/new":
    case "/clear":
      return slashNewSession(sessionId, trimmed.slice(command.length).trim());
    case "/resume":
    case "/sessions":
      return slashResume(sessionId, trimmed.slice(command.length).trim());
    default:
      if (definition) {
        return [
          `\`${definition.command}\` is a native Codex slash command, but this session is not running on the Codex app-server runtime.`,
          "",
          "Pocket Agent recognized the command and did not forward it to the model. Switch this session to Codex to use Codex-native slash commands.",
        ].join("\n");
      }
      return `${unsupportedSlash(content)}\n\n${slashHelp()}`;
  }
}

type SlashCommandResult =
  | { type: "message"; content: string }
  | { type: "codex-turn"; codexTurnId?: string | null };

async function runSlashCommand(
  managed: ManagedSession,
  sessionId: string,
  content: string,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  const [command] = trimmed.split(/\s+/, 1);
  const normalized = command.toLowerCase();
  const args = trimmed.slice(command.length).trim();
  const definition = findSlashCommandDefinition(normalized);
  const canonical = definition?.command ?? normalized;

  switch (canonical) {
    case "/help":
      return messageResult(slashHelp());
    case "/status":
      return messageResult(await slashStatus(managed, sessionId));
    case "/model":
      return messageResult(await slashModels(sessionId, args));
    case "/reasoning":
      return messageResult(slashReasoning(sessionId, args));
    case "/permissions":
      return messageResult(await slashPermissions(sessionId, args));
    case "/mcp":
      return messageResult(await slashMcp(args));
    case "/diff":
      return messageResult(await slashDiff(sessionId));
    case "/debug-config":
      return messageResult(await slashDebugConfig(managed, sessionId));
    case "/experimental":
      return messageResult(await slashExperimental());
    case "/skills":
      return messageResult(await slashSkills(sessionId));
    case "/hooks":
      return messageResult(await slashHooks(sessionId));
    case "/apps":
      return messageResult(await slashApps(managed));
    case "/plugins":
      return messageResult(await slashPlugins(sessionId));
    case "/rename":
      return messageResult(await slashRename(managed, sessionId, args));
    case "/copy":
      return messageResult(await slashCopyLastAssistantMessage(managed, sessionId));
    case "/new":
    case "/clear":
      return messageResult(await slashNewSession(sessionId, args));
    case "/resume":
    case "/sessions":
      return messageResult(await slashResume(sessionId, args));
    case "/fork":
      return messageResult(await slashFork(managed, sessionId));
    case "/undo":
      return messageResult(await slashUndo(managed, sessionId, args));
    case "/plan":
      return slashPlan(managed, sessionId, args);
    case "/goal":
      return messageResult(await slashGoal(managed, args));
    case "/review":
      return slashReview(managed, sessionId, args);
    case "/compact":
      return slashCompact(managed, sessionId);
    case "/stop":
      return messageResult(await slashStopBackgroundTerminals(managed));
    default:
      if (definition) {
        return messageResult(recognizedNativeSlash(definition.command));
      }
      return messageResult(`${unsupportedSlash(content)}\n\n${slashHelp()}`);
  }
}

function messageResult(content: string): SlashCommandResult {
  return { type: "message", content };
}

function slashHelp(): string {
  const supportLabel = {
    local: "Pocket Agent",
    "codex-app-server": "Codex",
    recognized: "recognized",
  } as const;
  const categories = [
    "workflow",
    "session",
    "configuration",
    "information",
    "integration",
    "ui",
    "debug",
  ] as const;

  return [
    "## Slash commands",
    "",
    "Pocket Agent recognizes the native Codex slash-command catalog. Commands marked `Codex` start the matching app-server operation; commands marked `recognized` are TUI/desktop-only today and are not sent to the model by accident.",
    "",
    ...categories.flatMap((category) => {
      const commands = SLASH_COMMANDS.filter((command) => command.category === category);
      if (!commands.length) return [];
      return [
        `### ${category}`,
        "",
        ...commands.map((command) => {
          const aliases = command.aliases?.length
            ? ` (${command.aliases.join(", ")})`
            : "";
          return `- \`${command.command}\`${aliases} — ${command.description} _${supportLabel[command.support]}_`;
        }),
        "",
      ];
    }),
  ].join("\n");
}

function unsupportedSlash(content: string): string {
  const command = content.trim().split(/\s+/, 1)[0] || "/";
  return `Unsupported slash command: \`${command}\`.`;
}

function recognizedNativeSlash(command: string): string {
  return [
    `\`${command}\` is a native Codex slash command and Pocket Agent now recognizes it.`,
    "",
    "This command depends on Codex TUI/desktop UI state that Pocket Agent does not expose yet, so it was not forwarded to the model. Use `/help` to see which commands are currently mapped to Pocket Agent or Codex app-server operations.",
  ].join("\n");
}

function optionalNativeCommandUnavailable(command: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `\`${command}\` is a native Codex slash command, but this Codex app-server does not expose the matching API in the currently installed version.`,
    "",
    `App-server response: ${message}`,
  ].join("\n");
}

async function slashStatus(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT agent, cwd, status, cli_session_id as cliSessionId, updated_at as updatedAt
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as any;
  const client = await getCodexAppServerClient();
  const [accountResult, modelsResult] = await Promise.allSettled([
    client.request("account/read", { refreshToken: false }),
    client.request("model/list", { limit: 20, includeHidden: false }),
  ]);

  const defaultModel =
    modelsResult.status === "fulfilled"
      ? (modelsResult.value?.data ?? []).find((m: any) => m.isDefault) ??
        (modelsResult.value?.data ?? [])[0]
      : null;
  const account = accountResult.status === "fulfilled" ? accountResult.value?.account : null;

  return [
    "## Status",
    "",
    `- Pocket Agent session: \`${sessionId}\``,
    `- Agent: \`${session?.agent ?? "unknown"}\``,
    `- Pocket Agent status: \`${session?.status ?? "unknown"}\``,
    `- Codex thread: \`${managed.codexThreadId ?? session?.cliSessionId ?? "unknown"}\``,
    `- CWD: \`${session?.cwd ?? "repo default"}\``,
    defaultModel
      ? `- Default model: \`${defaultModel.displayName ?? defaultModel.id}\``
      : "- Default model: unavailable",
    account?.type
      ? `- Auth: \`${account.type}\`${account.planType ? ` (${account.planType})` : ""}`
      : "- Auth: unavailable",
    `- Updated: ${session?.updatedAt ?? "unknown"}`,
  ].join("\n");
}

function slashBasicStatus(sessionId: string): string {
  const session = getDb()
    .prepare(
      `SELECT agent, cwd, status, cli_session_id as cliSessionId, updated_at as updatedAt
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as any;

  return [
    "## Status",
    "",
    `- Pocket Agent session: \`${sessionId}\``,
    `- Agent: \`${session?.agent ?? "unknown"}\``,
    `- Pocket Agent status: \`${session?.status ?? "unknown"}\``,
    `- CLI session: \`${session?.cliSessionId ?? "unknown"}\``,
    `- CWD: \`${session?.cwd ?? "repo default"}\``,
    `- Updated: ${session?.updatedAt ?? "unknown"}`,
  ].join("\n");
}

async function slashModels(sessionId: string, args = ""): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("model/list", {
    limit: 50,
    includeHidden: false,
  });
  const models = result?.data ?? [];
  if (!models.length) return "No visible Codex models returned by app-server.";

  const requested = args.trim();
  if (requested) {
    const found = models.find((model: any) => {
      const id = String(model.id ?? model.model ?? "");
      const label = String(model.displayName ?? model.name ?? "");
      return id === requested || label.toLowerCase() === requested.toLowerCase();
    });
    if (!found) {
      return [
        `Unknown model: ${inlineCode(requested)}.`,
        "",
        "Use `/model` without arguments to list visible model ids.",
      ].join("\n");
    }
    const modelId = String(found.id ?? found.model);
    updateCodexSessionSettings(sessionId, { model: modelId });
    return `Model set to ${inlineCode(found.displayName ?? modelId)} (${inlineCode(modelId)}).`;
  }

  const settings = readCodexSessionSettings(sessionId);
  return [
    "## Visible Codex models",
    "",
    `Current session model: ${settings.model ? inlineCode(settings.model) : "_default_"}`,
    "",
    "Use `/model <model-id>` to change this session.",
    "",
    ...models.map((model: any) => {
      const markers = [
        model.isDefault ? "default" : null,
        model.defaultReasoningEffort ? `effort: ${model.defaultReasoningEffort}` : null,
      ].filter(Boolean);
      return `- \`${model.displayName ?? model.id}\` (${model.id})${
        markers.length ? ` — ${markers.join(", ")}` : ""
      }`;
    }),
  ].join("\n");
}

function slashReasoning(sessionId: string, args = ""): string {
  const value = args.trim().toLowerCase();
  if (value) {
    const effort = normalizeReasoningEffort(value);
    if (!effort) {
      return "Usage: `/reasoning minimal|low|medium|high|xhigh`";
    }
    updateCodexSessionSettings(sessionId, { reasoningEffort: effort });
    return `Reasoning effort set to ${inlineCode(effort)}.`;
  }
  const settings = readCodexSessionSettings(sessionId);
  return [
    "## Reasoning",
    "",
    `Current reasoning effort: ${
      settings.reasoningEffort ? inlineCode(settings.reasoningEffort) : "_model default_"
    }`,
    "",
    "Usage: `/reasoning minimal|low|medium|high|xhigh`",
  ].join("\n");
}

async function slashPermissions(sessionId: string, args = ""): Promise<string> {
  const updates = parsePermissionArgs(args);
  if (updates.error) return updates.error;
  if (updates.patch) updateCodexSessionSettings(sessionId, updates.patch);

  const settings = readCodexSessionSettings(sessionId);

  return [
    "## Permissions",
    "",
    updates.patch ? "Updated current session settings:" : "Current session settings:",
    "",
    `- Approval policy: ${inlineCode(settings.approvalPolicy)}`,
    `- Sandbox: ${inlineCode(settings.sandboxMode)}`,
    `- Approval reviewer: ${inlineCode(settings.approvalsReviewer)}`,
    "",
    "Usage: `/permissions approval=<never|on-request|on-failure|untrusted> sandbox=<read-only|workspace-write|danger-full-access> reviewer=<user|auto_review|guardian_subagent>`",
  ].join("\n");
}

function parsePermissionArgs(args: string): {
  patch?: Partial<CodexSessionSettings>;
  error?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) return {};
  const patch: Partial<CodexSessionSettings> = {};
  for (const token of trimmed.split(/\s+/)) {
    const [rawKey, rawValue] = token.split("=", 2);
    const key = rawKey.toLowerCase();
    const value = rawValue?.trim();
    if (!value) {
      return { error: "Usage: `/permissions approval=<...> sandbox=<...> reviewer=<...>`" };
    }
    if (key === "approval" || key === "approvalpolicy" || key === "policy") {
      const approval = normalizeApprovalPolicy(value);
      if (approval !== value) return { error: `Unknown approval policy: ${inlineCode(value)}` };
      patch.approvalPolicy = approval;
    } else if (key === "sandbox" || key === "sandboxmode") {
      const sandbox = normalizeSandboxMode(value);
      if (sandbox !== value) return { error: `Unknown sandbox mode: ${inlineCode(value)}` };
      patch.sandboxMode = sandbox;
    } else if (key === "reviewer" || key === "approvalsreviewer") {
      const reviewer = normalizeApprovalsReviewer(value);
      if (reviewer !== value) return { error: `Unknown approvals reviewer: ${inlineCode(value)}` };
      patch.approvalsReviewer = reviewer;
    } else {
      return { error: `Unknown permission setting: ${inlineCode(rawKey)}` };
    }
  }
  return { patch };
}

async function slashMcp(args = ""): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("mcpServerStatus/list", {
    limit: 50,
    detail: args.trim().toLowerCase() === "verbose" ? "tools" : "toolsAndAuthOnly",
  });
  const servers = result?.data ?? [];
  if (!servers.length) return "No MCP servers returned by app-server.";

  return [
    "## MCP servers",
    "",
    ...servers.flatMap((server: any) => {
      const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
      const status = server.status ?? server.startupStatus ?? "unknown";
      const line = `- \`${server.name ?? "unnamed"}\` — ${status}, ${toolCount} tools`;
      if (args.trim().toLowerCase() !== "verbose" || !toolCount) return [line];
      return [
        line,
        ...server.tools.map((tool: any) => `  - \`${tool.name ?? tool}\``),
      ];
    }),
  ].join("\n");
}

async function slashDiff(sessionId: string): Promise<string> {
  const cwd = getSessionCwd(sessionId);
  const [status, unstaged, staged] = await Promise.all([
    runGit(cwd, ["status", "--short"]),
    runGit(cwd, ["diff", "--stat"]),
    runGit(cwd, ["diff", "--cached", "--stat"]),
  ]);

  return [
    "## Git diff",
    "",
    `- CWD: \`${cwd}\``,
    "",
    "### Status",
    "",
    codeBlock(status || "No changed files."),
    "",
    "### Unstaged diff stat",
    "",
    codeBlock(unstaged || "No unstaged diff."),
    "",
    "### Staged diff stat",
    "",
    codeBlock(staged || "No staged diff."),
  ].join("\n");
}

async function slashDebugConfig(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  const status = await slashStatus(managed, sessionId);
  const client = await getCodexAppServerClient();
  const config = await client.request("config/read", {
    cwd: getSessionCwd(sessionId),
  });
  return [
    status,
    "",
    "## Config",
    "",
    codeBlock(JSON.stringify(config, null, 2), "json"),
  ].join("\n");
}

async function slashExperimental(): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("experimentalFeature/list", { limit: 50 });
  const features = result?.data ?? [];
  if (!features.length) return "No experimental features returned by app-server.";
  return [
    "## Experimental features",
    "",
    ...features.map((feature: any) => {
      const enabled = feature.enabled ? "enabled" : "disabled";
      const stage = feature.stage ? `, ${feature.stage}` : "";
      return `- \`${feature.name}\` — ${enabled}${stage}${
        feature.description ? ` — ${feature.description}` : ""
      }`;
    }),
  ].join("\n");
}

async function slashSkills(sessionId: string): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("skills/list", {
    cwds: [getSessionCwd(sessionId)],
    forceReload: false,
  });
  const skills = flattenSkillsListEntries(result?.data ?? []);
  if (!skills.length) return "No skills returned by app-server.";
  return [
    "## Skills",
    "",
    ...skills.slice(0, 80).map((skill: any) => {
      const name = skill.name ?? skill.id ?? skill.path ?? "unnamed";
      const state = skill.enabled === false ? " — disabled" : "";
      const scope = skill.scope ? ` — ${skill.scope}` : "";
      return `- \`${name}\`${scope}${state}`;
    }),
  ].join("\n");
}

async function slashHooks(sessionId: string): Promise<string> {
  const client = await getCodexAppServerClient();
  let result: any;
  try {
    result = await client.request("hooks/list", {
      cwds: [getSessionCwd(sessionId)],
    });
  } catch (err) {
    return optionalNativeCommandUnavailable("/hooks", err);
  }
  const hooks = result?.data ?? [];
  if (!hooks.length) return "No hooks returned by app-server.";
  return [
    "## Hooks",
    "",
    ...hooks.map((hook: any) => `- \`${hook.name ?? hook.event ?? "hook"}\``),
  ].join("\n");
}

async function slashApps(managed: ManagedSession): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("app/list", {
    limit: 50,
    threadId: managed.codexThreadId ?? null,
    forceRefetch: false,
  });
  const apps = result?.data ?? [];
  if (!apps.length) return "No apps returned by app-server.";
  return [
    "## Apps",
    "",
    ...apps.map((app: any) => {
      const status = app.authStatus ?? app.status ?? (app.connected ? "connected" : "available");
      return `- \`${app.name ?? app.displayName ?? app.id ?? "unnamed"}\` — ${status}`;
    }),
  ].join("\n");
}

async function slashPlugins(sessionId: string): Promise<string> {
  const client = await getCodexAppServerClient();
  const result = await client.request("plugin/list", {
    cwds: [getSessionCwd(sessionId)],
  });
  const marketplaces = result?.marketplaces ?? [];
  if (!marketplaces.length) return "No plugin marketplaces returned by app-server.";
  return [
    "## Plugins",
    "",
    ...marketplaces.flatMap((marketplace: any) => {
      const plugins = marketplace.plugins ?? marketplace.entries ?? [];
      const title = `- ${marketplace.name ?? marketplace.path ?? "marketplace"} — ${plugins.length} plugins`;
      return [
        title,
        ...plugins
          .slice(0, 20)
          .map((plugin: any) => `  - \`${plugin.name ?? plugin.id ?? "plugin"}\``),
      ];
    }),
  ].join("\n");
}

async function slashRename(
  managed: ManagedSession,
  sessionId: string,
  name: string,
): Promise<string> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "Usage: `/rename <thread name>`";
  }
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  await client.request("thread/name/set", {
    threadId: managed.codexThreadId,
    name: trimmedName,
  });
  getDb()
    .prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(trimmedName, sessionId);
  return `Renamed current thread to **${trimmedName}**.`;
}

function slashRenameCockpitOnly(sessionId: string, name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "Usage: `/rename <session name>`";
  }
  getDb()
    .prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(trimmedName, sessionId);
  return `Renamed current Pocket Agent session to **${trimmedName}**.`;
}

async function slashCopyLastAssistantMessage(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  if (managed.runtime === "codex-app-server" && managed.codexThreadId) {
    try {
      const transcript = await readCodexTranscript(managed.codexThreadId, sessionId);
      const lastAssistant = [...transcript.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant?.content) {
        return [
          "## Last assistant response",
          "",
          "Copy the markdown below:",
          "",
          codeBlock(lastAssistant.content, "markdown"),
        ].join("\n");
      }
    } catch {
      // Fall back to the DB query below, which excludes local slash-command turns.
    }
  }

  const row = getDb()
    .prepare(
      `SELECT assistant.content
       FROM messages assistant
       JOIN messages user
         ON user.turn_id = assistant.turn_id
        AND user.role = 'user'
       WHERE assistant.session_id = ?
         AND assistant.role = 'assistant'
         AND user.content NOT LIKE '/%'
       ORDER BY assistant.created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { content?: string } | undefined;

  if (!row?.content) {
    return "No assistant response is available to copy yet.";
  }

  return [
    "## Last assistant response",
    "",
    "Copy the markdown below:",
    "",
    codeBlock(row.content, "markdown"),
  ].join("\n");
}

function slashNewSession(sessionId: string, name: string): string {
  const db = getDb();
  const current = db
    .prepare(
      `SELECT repo_id as repoId, agent, cwd
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId) as
    | { repoId: string; agent: string; cwd: string | null }
    | undefined;

  if (!current) return "Current Pocket Agent session was not found.";

  const newSessionId = nanoid();
  const trimmedName = name.trim();
  db.prepare(
    `INSERT INTO sessions (id, repo_id, agent, cwd, name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    newSessionId,
    current.repoId,
    current.agent,
    current.cwd ?? null,
    trimmedName || null,
  );

  const title = trimmedName || `Session ${newSessionId.slice(0, 8)}`;
  return [
    "## New Pocket Agent session",
    "",
    `Created [${escapeMarkdownLinkText(title)}](/session/${encodeURIComponent(
      newSessionId,
    )}) in the same repo.`,
    "",
    "Open the link to switch to the clean session.",
  ].join("\n");
}

async function slashFork(
  managed: ManagedSession,
  sessionId: string,
): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  const forked = await client.request("thread/fork", {
    threadId: managed.codexThreadId,
    persistExtendedHistory: true,
  });

  const thread = forked?.thread ?? forked;
  const forkedThreadId = thread?.id;
  if (!forkedThreadId) {
    return "Codex did not return a forked thread id.";
  }

  const db = getDb();
  const current = db
    .prepare(
      `SELECT repo_id as repoId, agent, cwd, name
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId) as
    | { repoId: string; agent: string; cwd: string | null; name: string | null }
    | undefined;
  if (!current) return "Current Pocket Agent session was not found.";

  const newSessionId = nanoid();
  const forkName = current.name ? `Fork of ${current.name}` : `Fork ${newSessionId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO sessions (id, repo_id, agent, cli_session_id, cwd, name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    newSessionId,
    current.repoId,
    current.agent,
    forkedThreadId,
    current.cwd ?? null,
    forkName,
  );

  return [
    "## Forked session",
    "",
    `Created [${escapeMarkdownLinkText(forkName)}](/session/${encodeURIComponent(
      newSessionId,
    )}) from the current Codex thread.`,
    "",
    `- Codex thread: ${inlineCode(forkedThreadId)}`,
  ].join("\n");
}

async function slashUndo(
  managed: ManagedSession,
  sessionId: string,
  args = "",
): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const numTurns = parseUndoCount(args);
  const client = await getCodexAppServerClient();
  try {
    await client.request("thread/rollback", {
      threadId: managed.codexThreadId,
      numTurns,
    });
  } catch (err) {
    return optionalNativeCommandUnavailable("/undo", err);
  }

  getDb()
    .prepare(
      `UPDATE messages
       SET source = 'rolled_back_cache'
       WHERE id IN (
         SELECT id FROM messages
         WHERE session_id = ? AND source = 'cache'
         ORDER BY created_at DESC
         LIMIT ?
       )`,
    )
    .run(sessionId, numTurns * 2);

  await refreshDisplayTranscript(managed, sessionId);

  return `Rolled back ${numTurns} Codex turn${numTurns === 1 ? "" : "s"} and refreshed the transcript.`;
}

function parseUndoCount(args: string): number {
  const raw = args.trim();
  if (!raw) return 1;
  const count = Number.parseInt(raw, 10);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(count, 5);
}

async function slashPlan(
  managed: ManagedSession,
  sessionId: string,
  args: string,
): Promise<SlashCommandResult> {
  const normalized = args.trim().toLowerCase();
  if (!args.trim() || normalized === "on") {
    updateCodexSessionSettings(sessionId, { collaborationMode: "plan" });
    return messageResult("Plan mode enabled for this session. Future prompts will use Codex `collaborationMode: plan`.");
  }
  if (["off", "default", "done", "exit"].includes(normalized)) {
    updateCodexSessionSettings(sessionId, { collaborationMode: "default" });
    return messageResult("Plan mode disabled for this session.");
  }

  updateCodexSessionSettings(sessionId, { collaborationMode: "plan" });
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const result = await runCodexTurnOperationWithAuthRetry(
    managed,
    sessionId,
    "/plan",
    async (client) => {
      if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
      const input = await buildCodexInput(args.trim(), {}, []);
      const settings = readCodexSessionSettings(sessionId);
      return client.request(
        "turn/start",
        await codexTurnParamsFromSettings(settings, managed.codexThreadId, input),
      );
    },
  );
  const codexTurnId = result?.turn?.id ?? null;
  if (codexTurnId) {
    const localTurnId = getLatestRunningTurnSyncRow(sessionId)?.id;
    if (localTurnId) {
      linkCodexTurn(managed, localTurnId, codexTurnId);
      updateTurnSyncById(localTurnId, "submitted", undefined, { codexTurnId, submitted: true });
      watchCodexTurnUntilTerminal(managed, sessionId, localTurnId, codexTurnId);
    }
  }
  return { type: "codex-turn", codexTurnId };
}

type SlashResumeRow = {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  agent: string;
  cwd: string | null;
  name: string | null;
  status: string;
  updatedAt: string;
};

type SlashResumeCodexThread = {
  id?: unknown;
  preview?: unknown;
  name?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  status?: { type?: unknown };
};



function shouldPreserveLocalRunningStatus(sessionId: string, existingStatus: string, threadStatus: string): boolean {
  return existingStatus === "running" && threadStatus !== "running" && hasRunningTurn(sessionId);
}

function shouldAdoptCodexThreadUpdatedAt(existing: { name: string | null; status: string }, next: { name: string | null; status: string }): boolean {
  // Codex app-server may advance thread.updatedAt when a thread is merely
  // resumed/opened. Treat only visible activity signals as recency changes so
  // /resume does not reshuffle sessions just because the user inspected one.
  return (next.name ?? null) !== (existing.name ?? null) || next.status !== existing.status;
}

function codexThreadTitle(thread: SlashResumeCodexThread): string | null {
  const name = typeof thread.name === "string" ? thread.name.trim() : "";
  // Use Codex's canonical generated thread title only. Preview text and local
  // id fallbacks are display-only and must not be persisted as session names.
  return name || null;
}

function codexThreadDisplayTitle(row: Pick<SlashResumeRow, "id" | "name">): string {
  return row.name?.trim() || `Codex ${row.id.slice(0, 8)}`;
}

function unixSecondsToSqliteDateTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return new Date().toISOString();
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function codexThreadSessionStatus(thread: SlashResumeCodexThread): SessionStatus {
  return thread.status?.type === "running" ? "running" : "idle";
}

function ensureRepoForCodexResumeThread(cwd: string, preferredRepoId?: string | null): string {
  const db = getDb();
  if (preferredRepoId) {
    const preferred = db
      .prepare("SELECT id, path FROM repos WHERE id = ?")
      .get(preferredRepoId) as { id: string; path: string } | undefined;
    if (preferred?.path === cwd) return preferred.id;
  }

  const existing = db
    .prepare("SELECT id FROM repos WHERE path = ?")
    .get(cwd) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = nanoid();
  const name = basename(cwd.replace(/\/+$/, "")) || cwd;
  db.prepare("INSERT INTO repos (id, name, path) VALUES (?, ?, ?)").run(id, name, cwd);
  return id;
}

function materializeCodexThreadForResume(
  thread: SlashResumeCodexThread,
  fallback: { repoId?: string | null; cwd: string },
): SlashResumeRow | null {
  if (typeof thread.id !== "string" || !thread.id.trim()) return null;
  const cwd = typeof thread.cwd === "string" && thread.cwd.trim() ? thread.cwd : fallback.cwd;
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT s.id, s.repo_id as repoId, r.name as repoName, r.path as repoPath,
              s.agent, s.cwd, s.name, s.status, s.updated_at as updatedAt
       FROM sessions s
       JOIN repos r ON r.id = s.repo_id
       WHERE s.agent = 'codex' AND s.cli_session_id = ?`,
    )
    .get(thread.id) as SlashResumeRow | undefined;

  const repoId = ensureRepoForCodexResumeThread(cwd, fallback.repoId);
  const title = codexThreadTitle(thread);
  const threadStatus = codexThreadSessionStatus(thread);
  const status = existing && shouldPreserveLocalRunningStatus(existing.id, existing.status, threadStatus)
    ? existing.status
    : threadStatus;
  const createdAt = unixSecondsToSqliteDateTime(thread.createdAt);
  const updatedAt = unixSecondsToSqliteDateTime(thread.updatedAt);

  if (existing) {
    const nextName = title ?? existing.name;
    const nextUpdatedAt = shouldAdoptCodexThreadUpdatedAt(
      existing,
      { name: nextName, status },
    )
      ? updatedAt
      : existing.updatedAt;
    db.prepare(
      `UPDATE sessions
       SET repo_id = ?,
           cwd = ?,
           name = ?,
           status = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(repoId, cwd, nextName, status, nextUpdatedAt, existing.id);
    return {
      ...existing,
      repoId,
      repoName: basename(cwd.replace(/\/+$/, "")) || existing.repoName,
      repoPath: cwd,
      cwd,
      name: nextName,
      status,
      updatedAt: nextUpdatedAt,
    };
  }

  const sessionId = nanoid();
  db.prepare(
    `INSERT INTO sessions (
       id, repo_id, agent, cli_session_id, cwd, name, status, created_at, updated_at
     )
     VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, repoId, thread.id, cwd, title, status, createdAt, updatedAt);

  const repo = db
    .prepare("SELECT name, path FROM repos WHERE id = ?")
    .get(repoId) as { name: string; path: string } | undefined;

  return {
    id: sessionId,
    repoId,
    repoName: repo?.name ?? (basename(cwd.replace(/\/+$/, "")) || cwd),
    repoPath: repo?.path ?? cwd,
    agent: "codex",
    cwd,
    name: title,
    status,
    updatedAt,
  };
}

async function slashResume(sessionId: string, args: string): Promise<string> {
  const query = args.trim().toLowerCase();
  const db = getDb();
  const current = db
    .prepare("SELECT repo_id as repoId, cwd FROM sessions WHERE id = ?")
    .get(sessionId) as { repoId?: string; cwd?: string | null } | undefined;
  const cwd = current?.cwd ?? getSessionCwd(sessionId);

  const client = await getCodexAppServerClient();
  const result = await client.request("thread/list", { cwd });
  const threads = Array.isArray(result?.data)
    ? result.data as SlashResumeCodexThread[]
    : [];
  const rows = threads
    .map((thread) => materializeCodexThreadForResume(thread, {
      repoId: current?.repoId ?? null,
      cwd,
    }))
    .filter((row): row is SlashResumeRow => Boolean(row))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const matches = query
    ? rows.filter((row) => {
        const haystack = [
          row.id,
          row.name,
          row.repoName,
          row.repoPath,
          row.cwd,
          row.agent,
          row.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : rows;

  const shown = matches.slice(0, 20);
  if (!shown.length) {
    return [
      "## Resume sessions",
      "",
      query
        ? `No Codex threads in ${inlineCode(cwd)} matched \`${escapeMarkdownInline(args.trim())}\`.`
        : `No Codex threads found for ${inlineCode(cwd)}.`,
      "",
      "Usage: `/resume` or `/resume <thread name, preview, or id>`",
    ].join("\n");
  }

  return [
    "## Resume Codex threads",
    "",
    query
      ? `Showing ${shown.length} of ${matches.length} matches for \`${escapeMarkdownInline(args.trim())}\`.`
      : `Showing ${shown.length} recent Codex threads for ${inlineCode(cwd)}.`,
    "",
    ...shown.map((row) => {
      const title = codexThreadDisplayTitle(row);
      const currentMarker = row.id === sessionId ? " _(current)_" : "";
      return `- [${escapeMarkdownLinkText(title)}](/session/${encodeURIComponent(
        row.id,
      )})${currentMarker} — ${inlineCode(row.status)} · ${formatUpdated(row.updatedAt)}`;
    }),
    matches.length > shown.length
      ? `\n_${matches.length - shown.length} more hidden. Narrow it with \`/resume <query>\`._`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function slashGoal(managed: ManagedSession, args: string): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  const trimmed = args.trim();

  try {
    if (!trimmed) {
      const result = await client.request("thread/goal/get", {
        threadId: managed.codexThreadId,
      });
      const goal = result?.goal;
      if (!goal) {
        return "No goal is set. Use `/goal <objective>` to set one.";
      }
      return [
        "## Goal",
        "",
        `- Objective: ${goal.objective}`,
        `- Status: \`${goal.status ?? "unknown"}\``,
        goal.tokenBudget ? `- Token budget: ${goal.tokenBudget}` : null,
        typeof goal.tokensUsed === "number" ? `- Tokens used: ${goal.tokensUsed}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }

    const lowered = trimmed.toLowerCase();
    if (lowered === "clear") {
      const result = await client.request("thread/goal/clear", {
        threadId: managed.codexThreadId,
      });
      return result?.cleared ? "Cleared the current goal." : "No goal was set.";
    }

    if (lowered === "pause" || lowered === "resume") {
      const status = lowered === "pause" ? "paused" : "active";
      const result = await client.request("thread/goal/set", {
        threadId: managed.codexThreadId,
        status,
      });
      return `Goal status is now \`${result?.goal?.status ?? status}\`.`;
    }

    const result = await client.request("thread/goal/set", {
      threadId: managed.codexThreadId,
      objective: trimmed,
      status: "active",
    });
    return `Set goal: **${result?.goal?.objective ?? trimmed}**.`;
  } catch (err) {
    return optionalNativeCommandUnavailable("/goal", err);
  }
}

async function slashReview(
  managed: ManagedSession,
  sessionId: string,
  args: string,
): Promise<SlashCommandResult> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const result = await runCodexTurnOperationWithAuthRetry(
    managed,
    sessionId,
    "/review",
    async (client) => {
      if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
      return client.request("review/start", {
        threadId: managed.codexThreadId,
        target: parseReviewTarget(args),
      });
    },
  );
  return { type: "codex-turn", codexTurnId: result?.turn?.id ?? null };
}

async function slashCompact(
  managed: ManagedSession,
  sessionId: string,
): Promise<SlashCommandResult> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  await runCodexTurnOperationWithAuthRetry(
    managed,
    sessionId,
    "/compact",
    async (client) => {
      if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
      return client.request("thread/compact/start", {
        threadId: managed.codexThreadId,
      });
    },
  );
  return { type: "codex-turn" };
}

async function slashStopBackgroundTerminals(
  managed: ManagedSession,
): Promise<string> {
  if (!managed.codexThreadId) throw new Error("Missing Codex thread id");
  const client = await getCodexAppServerClient();
  await client.request("thread/backgroundTerminals/clean", {
    threadId: managed.codexThreadId,
  });
  return "Requested Codex to stop all background terminals.";
}

function parseReviewTarget(args: string): any {
  const trimmed = args.trim();
  if (!trimmed) return { type: "uncommittedChanges" };

  const baseMatch = trimmed.match(/^(?:base|--base|-b)\s+(.+)$/i);
  if (baseMatch?.[1]) {
    return { type: "baseBranch", branch: baseMatch[1].trim() };
  }

  const commitMatch = trimmed.match(/^(?:commit|--commit)\s+([^\s]+)(?:\s+(.+))?$/i);
  if (commitMatch?.[1]) {
    return {
      type: "commit",
      sha: commitMatch[1],
      title: commitMatch[2]?.trim() || null,
    };
  }

  return { type: "custom", instructions: trimmed };
}

function getSessionCwd(sessionId: string): string {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(s.cwd, r.path) as cwd
       FROM sessions s
       JOIN repos r ON r.id = s.repo_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as { cwd?: string } | undefined;
  return row?.cwd ?? process.cwd();
}

async function runGit(cwd: string, args: string): Promise<string>;
async function runGit(cwd: string, args: string[]): Promise<string>;
async function runGit(cwd: string, args: string | string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", Array.isArray(args) ? args : [args], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || stderr).trim();
  } catch (err: any) {
    return String(err?.stdout || err?.stderr || err?.message || "git command failed").trim();
  }
}

function codeBlock(content: string, language = ""): string {
  return [`\`\`\`${language}`, content.replace(/```/g, "`\u200b``"), "```"].join("\n");
}

function inlineCode(value: string): string {
  return `\`${String(value).replace(/`/g, "`\u200b")}\``;
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/[`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]\\]/g, "\\$&");
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}


function maybeAutoTitleSession(
  managed: ManagedSession,
  sessionId: string,
  content: string,
) {
  const db = getDb();
  const row = db
    .prepare("SELECT name FROM sessions WHERE id = ?")
    .get(sessionId) as { name: string | null } | undefined;

  if (row?.name?.trim()) return;

  const title = createTitleFromPrompt(content);
  if (!title) return;

  db.prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, sessionId);

  broadcastEvent(managed, {
    type: "session_updated",
    sessionId,
    name: title,
    seq: nextSeq(managed),
  });
}

function createTitleFromPrompt(content: string): string {
  const firstMeaningfulLine = content
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/u, "")
        .replace(/[`*_~[\]()]/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find(Boolean);

  if (!firstMeaningfulLine) return "";

  if ([...firstMeaningfulLine].length <= AUTO_TITLE_MAX_LENGTH) {
    return firstMeaningfulLine;
  }

  return [...firstMeaningfulLine].slice(0, AUTO_TITLE_MAX_LENGTH - 1).join("").trimEnd() + "…";
}


type TurnSyncUpdateOptions = {
  codexTurnId?: string | null;
  submitted?: boolean;
  materialized?: boolean;
  retryOfTurnId?: string | null;
};

function linkCodexTurn(managed: ManagedSession, localTurnId: string, codexTurnId: string) {
  managed.codexLocalTurnByCodexTurnId ??= new Map();
  managed.codexCodexTurnByLocalTurnId ??= new Map();
  managed.codexLocalTurnByCodexTurnId.set(codexTurnId, localTurnId);
  managed.codexCodexTurnByLocalTurnId.set(localTurnId, codexTurnId);
  managed.codexThreadFresh = false;
  if (managed.codexPendingLocalTurnId === localTurnId) {
    managed.codexPendingLocalTurnId = null;
  }
}

function localTurnIdForCodexTurn(managed: ManagedSession, sessionId: string, codexTurnId: string | null): string | null {
  if (!codexTurnId) return null;
  const inMemory = managed.codexLocalTurnByCodexTurnId?.get(codexTurnId);
  if (inMemory) return inMemory;
  const row = getDb()
    .prepare("SELECT id FROM turns WHERE session_id = ? AND codex_turn_id = ? LIMIT 1")
    .get(sessionId, codexTurnId) as { id?: string } | undefined;
  if (row?.id) {
    linkCodexTurn(managed, row.id, codexTurnId);
    return row.id;
  }
  return null;
}

function updateTurnSyncById(
  localTurnId: string,
  status: CodexTurnSyncStatus,
  error?: string,
  opts: TurnSyncUpdateOptions = {},
) {
  const sets = ["codex_sync_status = ?", "codex_last_checked_at = datetime('now')"];
  const params: unknown[] = [status];
  if (opts.codexTurnId !== undefined) {
    sets.push("codex_turn_id = ?");
    params.push(opts.codexTurnId);
  }
  if (opts.submitted) sets.push("codex_submitted_at = COALESCE(codex_submitted_at, datetime('now'))");
  if (opts.materialized) sets.push("codex_materialized_at = COALESCE(codex_materialized_at, datetime('now'))");
  if (opts.retryOfTurnId !== undefined) {
    sets.push("retry_of_turn_id = ?");
    params.push(opts.retryOfTurnId);
  }
  if (error !== undefined) {
    sets.push("codex_sync_error = ?");
    params.push(error);
  } else if (status !== "error" && status !== "desynced") {
    sets.push("codex_sync_error = NULL");
  }
  params.push(localTurnId);
  getDb().prepare(`UPDATE turns SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

function markCodexTurnActivity(managed: ManagedSession, sessionId: string, codexTurnId: string | null, status: CodexTurnSyncStatus) {
  const localTurnId = localTurnIdForCodexTurn(managed, sessionId, codexTurnId) ?? managed.codexPendingLocalTurnId ?? null;
  if (!localTurnId) return;
  updateTurnSyncById(localTurnId, status);
}

function failTurnById(localTurnId: string, error?: string) {
  getDb()
    .prepare(
      `UPDATE turns
       SET status = 'error', finished_at = COALESCE(finished_at, datetime('now')),
           codex_sync_status = 'error',
           codex_sync_error = COALESCE(?, codex_sync_error),
           codex_last_checked_at = datetime('now')
       WHERE id = ?`,
    )
    .run(error ?? null, localTurnId);
}

function completeTurnById(localTurnId: string) {
  getDb()
    .prepare(
      `UPDATE turns
       SET status = 'complete', finished_at = COALESCE(finished_at, datetime('now')),
           codex_sync_status = 'complete',
           codex_materialized_at = COALESCE(codex_materialized_at, datetime('now')),
           codex_last_checked_at = datetime('now')
       WHERE id = ?`,
    )
    .run(localTurnId);
}

function stopTurnById(localTurnId: string) {
  getDb()
    .prepare(
      `UPDATE turns
       SET status = 'stopped', finished_at = COALESCE(finished_at, datetime('now')),
           codex_sync_status = 'stopped', codex_last_checked_at = datetime('now')
       WHERE id = ?`,
    )
    .run(localTurnId);
}

function markTurnDesynced(localTurnId: string, error: string) {
  getDb()
    .prepare(
      `UPDATE turns
       SET status = 'error', finished_at = COALESCE(finished_at, datetime('now')),
           codex_sync_status = 'desynced', codex_sync_error = ?,
           codex_last_checked_at = datetime('now')
       WHERE id = ?`,
    )
    .run(error, localTurnId);
}

function getTurnSyncRow(localTurnId: string): {
  id: string;
  sessionId: string;
  codexTurnId: string | null;
  content: string | null;
  codexSyncStatus: string | null;
  startedAt: string | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT turns.id,
              turns.session_id as sessionId,
              turns.codex_turn_id as codexTurnId,
              turns.codex_sync_status as codexSyncStatus,
              turns.started_at as startedAt,
              messages.content as content
       FROM turns
       LEFT JOIN messages ON messages.turn_id = turns.id AND messages.role = 'user'
       WHERE turns.id = ?
       ORDER BY messages.created_at ASC
       LIMIT 1`,
    )
    .get(localTurnId) as any;
  return row ?? null;
}

async function verifyCodexTurnMaterialized(
  sessionId: string,
  managed: ManagedSession,
  localTurnId: string,
  opts: { retries?: number; markDesynced?: boolean; allowContentFallback?: boolean } = {},
): Promise<boolean> {
  const retries = opts.retries ?? 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await delay(Math.min(250 * attempt, 1000));
    const row = getTurnSyncRow(localTurnId);
    if (!row || !managed.codexThreadId) return false;
    try {
      const client = await getCodexAppServerClient();
      const result = await client.request("thread/read", {
        threadId: managed.codexThreadId,
        includeTurns: true,
      });
      const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
      const byId = row.codexTurnId
        ? turns.find((turn: any) => turn?.id === row.codexTurnId)
        : null;
      const byUniqueContent = opts.allowContentFallback && !row.codexTurnId && row.content
        ? uniqueTranscriptTurnByUserContent(turns, row.content, row.startedAt)
        : null;
      const found = byId ?? byUniqueContent;
      if (found) {
        const codexTurnId = typeof found.id === "string" ? found.id : row.codexTurnId;
        if (codexTurnId) linkCodexTurn(managed, localTurnId, codexTurnId);
        updateTurnSyncById(localTurnId, "materialized", undefined, {
          codexTurnId: codexTurnId ?? undefined,
          materialized: true,
        });
        return true;
      }
      updateTurnSyncById(localTurnId, row.codexSyncStatus as CodexTurnSyncStatus || "submitted");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTurnSyncById(localTurnId, "submitted", message);
    }
  }
  if (opts.markDesynced) {
    markTurnDesynced(localTurnId, "Codex turn was not found in app-server transcript after verification.");
  }
  return false;
}

function uniqueTranscriptTurnByUserContent(turns: any[], content: string, localStartedAt: string | null): any | null {
  const localTime = localStartedAt ? Date.parse(localStartedAt) : NaN;
  const matches = turns.filter((turn) =>
    (Number.isNaN(localTime) || Math.abs(((turn?.startedAt ?? turn?.completedAt ?? 0) * 1000) - localTime) <= 2 * 60 * 1000) &&
    (Array.isArray(turn?.items) ? turn.items : []).some((item: any) => {
      const extracted = messageFromThreadItem(item);
      return extracted?.role === "user" && extracted.content === content;
    }),
  );
  return matches.length === 1 ? matches[0] : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunningTurn(
  sessionId: string,
  content: string,
  source?: MessageSource,
  retryOfTurnId?: string | null,
): string {
  const db = getDb();
  const turnSeq = getNextTurnSeq(sessionId);
  const turnId = nanoid();
  const syncStatus = source === "cache" ? "local_only" : null;
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, status, codex_sync_status, retry_of_turn_id) VALUES (?, ?, ?, 'running', ?, ?)",
  ).run(turnId, sessionId, turnSeq, syncStatus, retryOfTurnId ?? null);
  persistMessage(sessionId, "user", content, turnId, undefined, source);
  return turnId;
}

function reconcileCodexThreadStatus(
  sessionId: string,
  threadStatusType: string | null,
  latestTurnStatus: string | null = null,
  latestTurnId: string | null = null,
  managed?: ManagedSession,
) {
  const hasTerminalLatestTurn = isCodexTerminalStatus(latestTurnStatus);
  if (threadStatusType !== "idle" && !hasTerminalLatestTurn) return;

  const sessionStatus = getSessionStatus(sessionId);
  const latest = getLatestRunningTurnSyncRow(sessionId);

  if (!latest) {
    // Startup/no-running-turn repair is allowed only by exact persisted Codex id.
    // It must never mutate a newer active row because no local row is running.
    if (hasTerminalLatestTurn && latestTurnId) {
      const stale = getLatestTurnByCodexTurnId(sessionId, latestTurnId);
      if (stale && stale.status !== "complete") {
        const repairedStatus = latestTurnStatus === "interrupted"
          ? "stopped"
          : latestTurnStatus === "failed" || latestTurnStatus === "error"
            ? "error"
            : "complete";
        if (repairedStatus === "stopped") stopTurnById(stale.id);
        else if (repairedStatus === "error") failTurnById(stale.id, stale.codexSyncError ?? undefined);
        else completeTurnById(stale.id);
        const repairedSessionStatus = repairedStatus === "complete" ? "idle" : repairedStatus;
        updateSessionStatus(sessionId, repairedSessionStatus);
        if (managed) {
          clearActiveTools(managed);
          managed.codexActiveTurnId = null;
          managed.codexStopRequested = false;
          managed.codexStoppingTurnId = null;
          managed.codexPendingLocalTurnId = null;
          broadcastEvent(managed, { type: "status", status: repairedSessionStatus, seq: nextSeq(managed) });
        }
      }
    }
    return;
  }

  if (sessionStatus !== "running") {
    updateSessionStatus(sessionId, "running");
    if (managed) {
      broadcastEvent(managed, { type: "status", status: "running", seq: nextSeq(managed) });
    }
    updateTurnSyncById(
      latest.id,
      latest.codexSyncStatus as CodexTurnSyncStatus || (isCodexTurnAwaitingStart(latest) ? "submit_inflight" : "submitted"),
      "Restoring running status because a local Codex turn is still running.",
    );
    return;
  }

  if (hasTerminalLatestTurn) {
    const decision = decideCodexTerminalTransition(latest, latestTurnId, latestTurnStatus);
    if (decision.action === "ignore") {
      updateTurnSyncById(
        latest.id,
        latest.codexSyncStatus as CodexTurnSyncStatus || (isCodexTurnAwaitingStart(latest) ? "submit_inflight" : "submitted"),
        `Ignoring ${decision.reason} latest Codex terminal turn ${latestTurnId ?? "<unknown>"}.`,
      );
      return;
    }

    if (decision.turnStatus === "complete") {
      updateTurnSyncById(latest.id, "complete", undefined, { materialized: true });
      completeTurnById(latest.id);
    } else if (decision.turnStatus === "stopped") {
      stopTurnById(latest.id);
    } else {
      failTurnById(latest.id, undefined);
    }
    updateSessionStatus(sessionId, decision.sessionStatus);
    if (managed) {
      managed.codexActiveTurnId = null;
      managed.codexStopRequested = false;
      managed.codexStoppingTurnId = null;
      managed.codexPendingLocalTurnId = null;
      clearActiveTools(managed);
      broadcastEvent(managed, { type: "status", status: decision.sessionStatus, seq: nextSeq(managed) });
    }
    return;
  }

  // An idle thread without an exact terminal turn is not enough to complete,
  // stop, or fail the local running row. Keep awaiting-start/submitted turns
  // running until exact notification/watchdog materialization decides.
  if (threadStatusType === "idle" && latest.messageSource !== "cockpit") {
    updateTurnSyncById(
      latest.id,
      latest.codexSyncStatus as CodexTurnSyncStatus || (isCodexTurnAwaitingStart(latest) ? "submit_inflight" : "submitted"),
      "Codex thread is idle but no exact terminal turn matched the local running turn.",
    );
  }
}

function getLatestTurnByCodexTurnId(sessionId: string, codexTurnId: string): {
  id: string;
  status: string;
  codexSyncError: string | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT id, status, codex_sync_error as codexSyncError
       FROM turns
       WHERE session_id = ? AND codex_turn_id = ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId, codexTurnId) as
    | { id: string; status: string; codexSyncError: string | null }
    | undefined;
  return row ?? null;
}

function getLatestRunningTurnSyncRow(sessionId: string): CodexLocalTurnSnapshot | null {
  const row = getDb()
    .prepare(
      `SELECT turns.id,
              turns.codex_sync_status as codexSyncStatus,
              turns.codex_turn_id as codexTurnId,
              messages.source as messageSource
       FROM turns
       LEFT JOIN messages ON messages.turn_id = turns.id AND messages.role = 'user'
       WHERE turns.session_id = ? AND turns.status = 'running'
       ORDER BY turns.seq DESC, messages.created_at ASC LIMIT 1`,
    )
    .get(sessionId) as
    | { id: string; codexSyncStatus: string | null; codexTurnId: string | null; messageSource: string | null }
    | undefined;
  return row ?? null;
}

function isLikelyDuplicateRecentCodexPrompt(sessionId: string, content: string): boolean {
  if (!content) return false;
  const row = getDb()
    .prepare(
      `SELECT messages.content as content,
              turns.status as turnStatus,
              turns.started_at as startedAt,
              turns.finished_at as finishedAt
       FROM messages
       JOIN turns ON turns.id = messages.turn_id
       WHERE messages.session_id = ?
         AND messages.role = 'user'
         AND messages.source = 'cache'
       ORDER BY messages.created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as
    | { content: string | null; turnStatus: string | null; startedAt: string | null; finishedAt: string | null }
    | undefined;
  if (!row || row.content?.trim() !== content) return false;
  const referenceTime = Date.parse(`${row.finishedAt ?? row.startedAt ?? ""}Z`);
  if (!Number.isFinite(referenceTime)) return false;
  const ageMs = Date.now() - referenceTime;
  if (ageMs < 0 || ageMs > 2 * 60 * 1000) return false;
  // If a user truly wants to send the same text again after a successful turn,
  // allow it. Suppress the accidental resend pattern caused by stale ready/error
  // UI during stopped/error/desynced/recovering turns.
  return row.turnStatus !== "complete";
}

function getNextTurnSeq(sessionId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(seq) as maxSeq FROM turns WHERE session_id = ?")
    .get(sessionId) as any;
  return (row?.maxSeq ?? 0) + 1;
}

function persistMessage(
  sessionId: string,
  role: string,
  content: string,
  turnId?: string,
  externalId?: string,
  source?: MessageSource,
) {
  const db = getDb();
  const id = nanoid();
  const resolvedTurnId =
    turnId ??
    (
      db
        .prepare(
          "SELECT id FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(sessionId) as any
    )?.id ??
    null;

  if (externalId) {
    const existing = db
      .prepare("SELECT id FROM messages WHERE session_id = ? AND external_id = ?")
      .get(sessionId, externalId);
    if (existing) return;
  }

  db.prepare(
    `INSERT INTO messages (id, session_id, turn_id, role, content, external_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, resolvedTurnId, role, content, externalId ?? null, source ?? null);
}

function completeTurn(sessionId: string, cost?: number) {
  const db = getDb();
  db.prepare(
    `UPDATE turns SET status = 'complete', finished_at = datetime('now'),
     cost_usd = COALESCE(?, cost_usd)
     WHERE id = (SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
  ).run(cost ?? null, sessionId);
}

function stopTurn(sessionId: string) {
  const db = getDb();
  db.prepare(
    `UPDATE turns SET status = 'stopped', finished_at = datetime('now')
     WHERE id = (SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
  ).run(sessionId);
}

function failTurn(sessionId: string) {
  const db = getDb();
  db.prepare(
    `UPDATE turns SET status = 'error', finished_at = datetime('now')
     WHERE id = (SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
  ).run(sessionId);
}

function hasRunningTurn(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId);
  return Boolean(row);
}

function hasMaterializedCodexTurn(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM turns
       WHERE session_id = ?
         AND codex_turn_id IS NOT NULL
         AND codex_materialized_at IS NOT NULL
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId);
  return Boolean(row);
}

function isTurnRunning(turnId: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM turns WHERE id = ? AND status = 'running'")
    .get(turnId);
  return Boolean(row);
}

function updateSessionStatus(sessionId: string, status: SessionStatus) {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(status, sessionId);
  broadcastLobby({ type: "session_status", sessionId, status });
}

function getSessionStatus(sessionId: string): SessionStatus | null {
  const row = getDb()
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as { status: SessionStatus } | undefined;
  return row?.status ?? null;
}
