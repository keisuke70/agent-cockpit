import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { createSessionSchema } from "@agent-cockpit/shared";
import { getDb } from "../db.js";

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
    const repo = db.prepare("SELECT id FROM repos WHERE id = ?").get(parsed.data.repoId);
    if (!repo) {
      return reply.status(400).send({ error: "Repo not found" });
    }

    const id = nanoid();
    db.prepare(
      `INSERT INTO sessions (id, repo_id, agent, cwd, name)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, parsed.data.repoId, parsed.data.agent, parsed.data.cwd ?? null, parsed.data.name ?? null);

    return reply.status(201).send({
      id,
      repoId: parsed.data.repoId,
      agent: parsed.data.agent,
      cwd: parsed.data.cwd ?? null,
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
}
