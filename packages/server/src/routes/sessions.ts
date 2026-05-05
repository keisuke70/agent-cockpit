import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { createSessionSchema } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import { getManaged, removeManaged } from "../process-manager.js";
import { removeScheduleRunner } from "../scheduler.js";
import { ensureWorkspaceRepo, getWorkspaceSettings } from "./settings.js";

function detachManagedProcessListeners(sessionId: string) {
  const proc = getManaged(sessionId)?.handle?.proc;
  proc?.stdout?.removeAllListeners("data");
  proc?.removeAllListeners("close");
}

export async function sessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { repoId?: string } }>("/api/sessions", (req) => {
    const db = getDb();
    if (req.query.repoId) {
      return db
        .prepare(
          `SELECT id, repo_id as repoId, agent, cli_session_id as cliSessionId,
                  cwd, name, status, created_at as createdAt, updated_at as updatedAt
           FROM sessions WHERE repo_id = ? ORDER BY updated_at DESC`,
        )
        .all(req.query.repoId);
    }
    return db
      .prepare(
        `SELECT id, repo_id as repoId, agent, cli_session_id as cliSessionId,
                cwd, name, status, created_at as createdAt, updated_at as updatedAt
         FROM sessions ORDER BY updated_at DESC`,
      )
      .all();
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", (req, reply) => {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT id, repo_id as repoId, agent, cli_session_id as cliSessionId,
                cwd, name, status, created_at as createdAt, updated_at as updatedAt
         FROM sessions WHERE id = ?`,
      )
      .get(req.params.id);
    if (!session) {
      return reply.status(404).send({ error: "Not found" });
    }
    return session;
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
