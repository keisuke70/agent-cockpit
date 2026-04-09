import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { getDb } from "./db.js";
import { ensureManaged, sendPrompt } from "./ws/session-bridge.js";

/**
 * In-memory cron scheduler. Single-process, no missed-run catch-up. Assumes
 * the launchd agent is the only running instance. Loads all enabled schedules
 * from the DB at startup; mutating routes call addScheduleRunner / removeScheduleRunner
 * to keep the in-memory map in sync with the DB.
 */

interface RunningSchedule {
  task: ScheduledTask;
}

const runners = new Map<string, RunningSchedule>();

interface ScheduleRow {
  id: string;
  session_id: string;
  prompt: string;
  cron_expr: string;
  enabled: number;
}

async function fireSchedule(scheduleId: string) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, session_id, prompt, cron_expr, enabled FROM schedules WHERE id = ?",
    )
    .get(scheduleId) as ScheduleRow | undefined;
  if (!row || !row.enabled) return;

  const session = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(row.session_id) as { status: string } | undefined;

  if (!session) {
    db.prepare(
      "UPDATE schedules SET last_run = datetime('now'), last_status = 'error' WHERE id = ?",
    ).run(scheduleId);
    return;
  }

  if (session.status === "running") {
    db.prepare(
      "UPDATE schedules SET last_run = datetime('now'), last_status = 'skipped_running' WHERE id = ?",
    ).run(scheduleId);
    return;
  }

  try {
    const managed = await ensureManaged(row.session_id);
    const result = sendPrompt(managed, row.session_id, row.prompt);
    if (!result.ok) {
      db.prepare(
        "UPDATE schedules SET last_run = datetime('now'), last_status = ? WHERE id = ?",
      ).run(
        result.error === "Session is already running" ? "skipped_running" : "error",
        scheduleId,
      );
      return;
    }
    db.prepare(
      "UPDATE schedules SET last_run = datetime('now'), last_status = 'fired' WHERE id = ?",
    ).run(scheduleId);
  } catch {
    db.prepare(
      "UPDATE schedules SET last_run = datetime('now'), last_status = 'error' WHERE id = ?",
    ).run(scheduleId);
  }
}

function startRunner(scheduleId: string, cronExpr: string) {
  if (runners.has(scheduleId)) return;
  if (!cron.validate(cronExpr)) return;
  const task = cron.schedule(cronExpr, () => {
    void fireSchedule(scheduleId);
  });
  runners.set(scheduleId, { task });
}

function stopRunner(scheduleId: string) {
  const r = runners.get(scheduleId);
  if (!r) return;
  r.task.stop();
  runners.delete(scheduleId);
}

/** Called by routes after a schedule is created or its cron_expr/enabled changes. */
export function refreshSchedule(scheduleId: string) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, session_id, prompt, cron_expr, enabled FROM schedules WHERE id = ?",
    )
    .get(scheduleId) as ScheduleRow | undefined;
  stopRunner(scheduleId);
  if (row && row.enabled) {
    startRunner(row.id, row.cron_expr);
  }
}

/** Called by the delete route. */
export function removeScheduleRunner(scheduleId: string) {
  stopRunner(scheduleId);
}

/** Called once at server startup. Loads all enabled schedules and starts runners. */
export function initScheduler() {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, session_id, prompt, cron_expr, enabled FROM schedules WHERE enabled = 1",
    )
    .all() as ScheduleRow[];
  for (const r of rows) {
    startRunner(r.id, r.cron_expr);
  }
}

/** Stops all runners (server shutdown). */
export function stopAllSchedules() {
  for (const [id] of runners) {
    stopRunner(id);
  }
}

/**
 * Validate a 5-field cron expression. node-cron.validate() also accepts 6- and
 * 7-field forms (with seconds / years), but Phase 6's scope is documented as
 * "5-field cron only" — sub-minute schedules would also stress the in-process
 * scheduler and the agent CLI. Reject anything that is not exactly 5 fields.
 */
export function isValidCronExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return cron.validate(expr);
}
