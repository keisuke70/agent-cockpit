import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import {
  refreshSchedule,
  removeScheduleRunner,
  isValidCronExpr,
} from "../scheduler.js";

interface CreateScheduleBody {
  prompt: string;
  cronExpr: string;
}

interface PatchScheduleBody {
  enabled?: boolean;
  cronExpr?: string;
  prompt?: string;
}

interface ScheduleRow {
  id: string;
  session_id: string;
  prompt: string;
  cron_expr: string;
  enabled: number;
  last_run: string | null;
  last_status: string | null;
  created_at: string;
}

function rowToSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    cronExpr: row.cron_expr,
    enabled: row.enabled === 1,
    lastRun: row.last_run,
    lastStatus: row.last_status,
    createdAt: row.created_at,
  };
}

export async function scheduleRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/schedules",
    (req) => {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT id, session_id, prompt, cron_expr, enabled, last_run, last_status, created_at
           FROM schedules WHERE session_id = ? ORDER BY created_at DESC`,
        )
        .all(req.params.id) as ScheduleRow[];
      return rows.map(rowToSchedule);
    },
  );

  app.post<{ Params: { id: string }; Body: CreateScheduleBody }>(
    "/api/sessions/:id/schedules",
    (req, reply) => {
      const body = req.body;
      if (
        !body ||
        typeof body.prompt !== "string" ||
        !body.prompt.trim() ||
        typeof body.cronExpr !== "string" ||
        !isValidCronExpr(body.cronExpr)
      ) {
        return reply.status(400).send({ error: "Invalid prompt or cronExpr" });
      }

      const db = getDb();
      const session = db
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(req.params.id);
      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const id = nanoid();
      db.prepare(
        `INSERT INTO schedules (id, session_id, prompt, cron_expr)
         VALUES (?, ?, ?, ?)`,
      ).run(id, req.params.id, body.prompt.trim(), body.cronExpr.trim());

      refreshSchedule(id);

      const row = db
        .prepare(
          `SELECT id, session_id, prompt, cron_expr, enabled, last_run, last_status, created_at
           FROM schedules WHERE id = ?`,
        )
        .get(id) as ScheduleRow;
      return reply.status(201).send(rowToSchedule(row));
    },
  );

  app.patch<{ Params: { id: string }; Body: PatchScheduleBody }>(
    "/api/schedules/:id",
    (req, reply) => {
      const db = getDb();
      const existing = db
        .prepare("SELECT id FROM schedules WHERE id = ?")
        .get(req.params.id);
      if (!existing) {
        return reply.status(404).send({ error: "Not found" });
      }

      const body = req.body ?? {};
      if (
        body.cronExpr !== undefined &&
        !isValidCronExpr(body.cronExpr)
      ) {
        return reply.status(400).send({ error: "Invalid cronExpr" });
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      if (typeof body.enabled === "boolean") {
        updates.push("enabled = ?");
        values.push(body.enabled ? 1 : 0);
      }
      if (typeof body.cronExpr === "string") {
        updates.push("cron_expr = ?");
        values.push(body.cronExpr);
      }
      if (typeof body.prompt === "string" && body.prompt.trim()) {
        updates.push("prompt = ?");
        values.push(body.prompt.trim());
      }
      if (updates.length === 0) {
        return reply.status(400).send({ error: "Nothing to update" });
      }
      values.push(req.params.id);

      db.prepare(`UPDATE schedules SET ${updates.join(", ")} WHERE id = ?`).run(
        ...values,
      );

      refreshSchedule(req.params.id);

      const row = db
        .prepare(
          `SELECT id, session_id, prompt, cron_expr, enabled, last_run, last_status, created_at
           FROM schedules WHERE id = ?`,
        )
        .get(req.params.id) as ScheduleRow;
      return rowToSchedule(row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    (req, reply) => {
      const db = getDb();
      const result = db
        .prepare("DELETE FROM schedules WHERE id = ?")
        .run(req.params.id);
      if (result.changes === 0) {
        return reply.status(404).send({ error: "Not found" });
      }
      removeScheduleRunner(req.params.id);
      return reply.status(204).send();
    },
  );
}
