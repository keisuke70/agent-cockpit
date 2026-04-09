import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { createRepoSchema } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import { removeManaged } from "../process-manager.js";

export async function repoRoutes(app: FastifyInstance) {
  app.get("/api/repos", () => {
    const db = getDb();
    return db
      .prepare("SELECT id, name, path, created_at as createdAt FROM repos ORDER BY name")
      .all();
  });

  app.post("/api/repos", (req, reply) => {
    const parsed = createRepoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { name, path } = parsed.data;

    if (!existsSync(path)) {
      return reply.status(400).send({ error: "Path does not exist" });
    }

    const db = getDb();
    const id = nanoid();
    try {
      db.prepare("INSERT INTO repos (id, name, path) VALUES (?, ?, ?)").run(
        id,
        name,
        path,
      );
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return reply.status(409).send({ error: "Repo path already registered" });
      }
      throw err;
    }

    return reply.status(201).send({ id, name, path });
  });

  app.delete<{ Params: { id: string } }>("/api/repos/:id", (req, reply) => {
    const db = getDb();
    const repoId = req.params.id;

    // Cascade delete inside a transaction. Capture the affected session ids
    // so we can tear down their managed processes only after a successful commit.
    let affectedSessions: string[] = [];
    const tx = db.transaction((id: string) => {
      affectedSessions = (
        db
          .prepare("SELECT id FROM sessions WHERE repo_id = ?")
          .all(id) as { id: string }[]
      ).map((row) => row.id);

      db.prepare(
        "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE repo_id = ?)",
      ).run(id);
      db.prepare(
        "DELETE FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE repo_id = ?)",
      ).run(id);
      db.prepare("DELETE FROM sessions WHERE repo_id = ?").run(id);
      return db.prepare("DELETE FROM repos WHERE id = ?").run(id);
    });

    const result = tx(repoId);
    if (result.changes === 0) {
      return reply.status(404).send({ error: "Not found" });
    }

    // Only after the DB transaction commits do we tear down in-memory processes.
    for (const sid of affectedSessions) {
      removeManaged(sid);
    }

    return reply.status(204).send();
  });
}
