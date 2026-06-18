import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { basename } from "node:path";
import { createSessionSchema } from "@agent-cockpit/shared";
import type { SessionStatus } from "@agent-cockpit/shared";
import { getCodexAppServerClient } from "../codex/app-server-client.js";
import { getDb } from "../db.js";
import { getManaged, removeManaged } from "../process-manager.js";
import { removeScheduleRunner } from "../scheduler.js";
import { ensureWorkspaceRepo, getWorkspaceSettings } from "./settings.js";

function detachManagedProcessListeners(sessionId: string) {
  const proc = getManaged(sessionId)?.handle?.proc;
  proc?.stdout?.removeAllListeners("data");
  proc?.removeAllListeners("close");
}

function mapSessionRow(row: any) {
  if (!row) return row;
  const {
    codexModel,
    codexReasoningEffort,
    codexApprovalPolicy,
    codexApprovalsReviewer,
    codexSandboxMode,
    codexCollaborationMode,
    codexAdditionalWritableRoots,
    ...session
  } = row;
  return {
    ...session,
    codexSettings: {
      model: codexModel ?? null,
      reasoningEffort: codexReasoningEffort ?? null,
      approvalPolicy: codexApprovalPolicy ?? "never",
      approvalsReviewer: codexApprovalsReviewer ?? "user",
      sandboxMode: codexSandboxMode ?? "danger-full-access",
      collaborationMode: codexCollaborationMode ?? "default",
      additionalWritableRoots: parseJsonStringArray(codexAdditionalWritableRoots),
    },
  };
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

interface CodexThreadSummary {
  id?: unknown;
  preview?: unknown;
  name?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  status?: { type?: unknown };
}

function isoTimestampFromUnixSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return new Date().toISOString();
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function codexThreadStatusToSessionStatus(status: unknown): SessionStatus {
  return status === "running" ? "running" : "idle";
}



function hasLocalRunningTurn(sessionId: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM turns WHERE session_id = ? AND status = 'running' LIMIT 1")
    .get(sessionId);
  return Boolean(row);
}

function shouldPreserveLocalRunningStatus(sessionId: string, existingStatus: SessionStatus, threadStatus: SessionStatus): boolean {
  return existingStatus === "running" && threadStatus !== "running" && hasLocalRunningTurn(sessionId);
}
function shouldAdoptCodexThreadUpdatedAt(existing: { name: string | null; status: SessionStatus }, next: { name: string | null; status: SessionStatus }): boolean {
  // Codex app-server may advance thread.updatedAt when a thread is merely
  // resumed/opened. Treat only visible activity signals as recency changes so
  // the session list does not jump just because the user inspected a session.
  return (next.name ?? null) !== (existing.name ?? null) || next.status !== existing.status;
}

function displayNameFromCodexThread(thread: CodexThreadSummary): string | null {
  const name = typeof thread.name === "string" ? thread.name.trim() : "";
  // Codex app-server generates canonical thread titles. Do not fall back to
  // preview text here: preview is transcript content and produces noisy,
  // unstable Cockpit session names.
  return name || null;
}

function resolveRepoForCodexThread(cwd: string): string {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM repos WHERE path = ?")
    .get(cwd) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = nanoid();
  const name = basename(cwd.replace(/\/+$/, "")) || cwd;
  db.prepare("INSERT INTO repos (id, name, path) VALUES (?, ?, ?)").run(id, name, cwd);
  return id;
}

async function syncCodexThreadsIntoSessions(opts: { repoId?: string } = {}) {
  const db = getDb();
  let cwdFilter: string | null = null;
  if (opts.repoId) {
    const repo = db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(opts.repoId) as { path: string } | undefined;
    if (!repo) return;
    cwdFilter = repo?.path ?? null;
  }

  try {
    const client = await getCodexAppServerClient();
    const result = await client.request(
      "thread/list",
      cwdFilter ? { cwd: cwdFilter } : {},
    );
    const threads = Array.isArray(result?.data) ? result.data as CodexThreadSummary[] : [];

    const upsert = db.transaction((items: CodexThreadSummary[]) => {
      for (const thread of items) {
        if (typeof thread.id !== "string" || !thread.id.trim()) continue;
        const cwd = typeof thread.cwd === "string" && thread.cwd.trim() ? thread.cwd : cwdFilter;
        if (!cwd) continue;
        if (cwdFilter && cwd !== cwdFilter) continue;

        const existing = db
          .prepare("SELECT id, name, status, updated_at as updatedAt FROM sessions WHERE agent = 'codex' AND cli_session_id = ?")
          .get(thread.id) as { id: string; name: string | null; status: SessionStatus; updatedAt: string } | undefined;

        const repoId = opts.repoId ?? resolveRepoForCodexThread(cwd);
        const name = displayNameFromCodexThread(thread);
        const createdAt = isoTimestampFromUnixSeconds(thread.createdAt);
        const updatedAt = isoTimestampFromUnixSeconds(thread.updatedAt);
        const threadStatus = codexThreadStatusToSessionStatus(thread.status?.type);

        if (existing) {
          const status = shouldPreserveLocalRunningStatus(existing.id, existing.status, threadStatus)
            ? existing.status
            : threadStatus;
          const nextName = name ?? existing.name;
          const nextUpdatedAt = shouldAdoptCodexThreadUpdatedAt(
            existing,
            { name: nextName, status },
          )
            ? updatedAt
            : existing.updatedAt;
          db.prepare(
            `UPDATE sessions
             SET repo_id = ?,
                 cwd = COALESCE(?, cwd),
                 name = COALESCE(?, name),
                 status = ?,
                 updated_at = ?
             WHERE id = ?`,
          ).run(repoId, cwd, name, status, nextUpdatedAt, existing.id);
          continue;
        }

        db.prepare(
          `INSERT INTO sessions (
             id, repo_id, agent, cli_session_id, cwd, name, status, created_at, updated_at
           )
           VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
        ).run(nanoid(), repoId, thread.id, cwd, name, threadStatus, createdAt, updatedAt);
      }
    });

    upsert(threads);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sessions] Failed to sync Codex thread/list into sessions: ${message}`);
  }
}

export async function sessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { repoId?: string } }>("/api/sessions", async (req) => {
    const db = getDb();
    await syncCodexThreadsIntoSessions({ repoId: req.query.repoId });

    if (req.query.repoId) {
      const rows = db
        .prepare(
          `SELECT id, repo_id as repoId, agent, cli_session_id as cliSessionId,
                  cwd, name, status, created_at as createdAt, updated_at as updatedAt,
                  codex_model as codexModel,
                  codex_reasoning_effort as codexReasoningEffort,
                  codex_approval_policy as codexApprovalPolicy,
                  codex_approvals_reviewer as codexApprovalsReviewer,
                  codex_sandbox_mode as codexSandboxMode,
                  codex_collaboration_mode as codexCollaborationMode,
                  codex_additional_writable_roots as codexAdditionalWritableRoots
           FROM sessions WHERE repo_id = ? ORDER BY updated_at DESC`,
        )
        .all(req.query.repoId);
      return rows.map(mapSessionRow);
    }
    const rows = db
      .prepare(
        `SELECT id, repo_id as repoId, agent, cli_session_id as cliSessionId,
                cwd, name, status, created_at as createdAt, updated_at as updatedAt,
                codex_model as codexModel,
                codex_reasoning_effort as codexReasoningEffort,
                codex_approval_policy as codexApprovalPolicy,
                codex_approvals_reviewer as codexApprovalsReviewer,
                codex_sandbox_mode as codexSandboxMode,
                codex_collaboration_mode as codexCollaborationMode,
                codex_additional_writable_roots as codexAdditionalWritableRoots
         FROM sessions ORDER BY updated_at DESC`,
      )
      .all();
    return rows.map(mapSessionRow);
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", (req, reply) => {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT id, repo_id as repoId, agent, cli_session_id as cliSessionId,
                cwd, name, status, created_at as createdAt, updated_at as updatedAt,
                codex_model as codexModel,
                codex_reasoning_effort as codexReasoningEffort,
                codex_approval_policy as codexApprovalPolicy,
                codex_approvals_reviewer as codexApprovalsReviewer,
                codex_sandbox_mode as codexSandboxMode,
                codex_collaboration_mode as codexCollaborationMode,
                codex_additional_writable_roots as codexAdditionalWritableRoots
         FROM sessions WHERE id = ?`,
      )
      .get(req.params.id);
    if (!session) {
      return reply.status(404).send({ error: "Not found" });
    }
    return mapSessionRow(session);
  });

  app.post("/api/sessions", (req, reply) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const db = getDb();
    const workspace = getWorkspaceSettings();
    if (
      parsed.data.repoId === workspace.workspaceRepoId &&
      workspace.rootPath
    ) {
      ensureWorkspaceRepo(workspace.rootPath);
    }

    const repo = db.prepare("SELECT id FROM repos WHERE id = ?").get(parsed.data.repoId);
    if (!repo) {
      return reply.status(400).send({ error: "Repo not found" });
    }

    const cwd =
      parsed.data.cwd ??
      (parsed.data.repoId === workspace.workspaceRepoId ? workspace.rootPath : null);

    const id = nanoid();
    db.prepare(
      `INSERT INTO sessions (id, repo_id, agent, cwd, name)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, parsed.data.repoId, parsed.data.agent, cwd, parsed.data.name ?? null);

    return reply.status(201).send({
      id,
      repoId: parsed.data.repoId,
      agent: parsed.data.agent,
      cwd,
      name: parsed.data.name ?? null,
      status: "idle",
    });
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", (req) => {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, session_id as sessionId, turn_id as turnId, role, content,
                created_at as createdAt
         FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", (req, reply) => {
    const db = getDb();
    const sessionId = req.params.id;
    const session = db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(sessionId);

    if (!session) {
      return reply.status(404).send({ error: "Not found" });
    }

    // Delete all rows that reference the session explicitly because the schema
    // does not declare ON DELETE CASCADE. Capture schedule ids first so their
    // in-memory cron runners can be stopped after the DB transaction commits.
    let scheduleIds: string[] = [];
    const tx = db.transaction((id: string) => {
      scheduleIds = (
        db
          .prepare("SELECT id FROM schedules WHERE session_id = ?")
          .all(id) as { id: string }[]
      ).map((row) => row.id);

      db.prepare("DELETE FROM schedules WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });

    tx(sessionId);

    for (const scheduleId of scheduleIds) {
      removeScheduleRunner(scheduleId);
    }
    // The DB commit is complete, and we are still in the same event-loop turn:
    // detach process listeners before killing the process so late stdout/close
    // events cannot write back into rows that were just deleted.
    detachManagedProcessListeners(sessionId);
    removeManaged(sessionId);

    return reply.status(204).send();
  });
}
