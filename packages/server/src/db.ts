import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "agent-cockpit",
);

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  ensureDataDir();
  const dbPath = join(DATA_DIR, "cockpit.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      repo_id         TEXT NOT NULL REFERENCES repos(id),
      agent           TEXT NOT NULL,
      cli_session_id  TEXT,
      cwd             TEXT,
      name            TEXT,
      status          TEXT NOT NULL DEFAULT 'idle',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS turns (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      seq         INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      cost_usd    REAL,
      metadata    TEXT,
      UNIQUE(session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      turn_id     TEXT REFERENCES turns(id),
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          TEXT PRIMARY KEY,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      prompt      TEXT NOT NULL,
      cron_expr   TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_run    TEXT,
      last_status TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_session ON schedules(session_id);

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);
  `);

  ensureColumn(db, "messages", "external_id", "TEXT");
  ensureColumn(db, "messages", "source", "TEXT");
  ensureColumn(db, "sessions", "codex_unreadable_thread_id", "TEXT");
  ensureColumn(db, "sessions", "codex_unreadable_at", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_external
    ON messages(session_id, external_id)
    WHERE external_id IS NOT NULL;
  `);
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((row) => row.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
