import type { FastifyInstance } from "fastify";
import { statSync } from "node:fs";
import { workspaceRootSchema } from "@agent-cockpit/shared";
import { getDb } from "../db.js";
import { normalizeLocalPath } from "../path-utils.js";

export const WORKSPACE_REPO_ID = "__workspace_root__";
const WORKSPACE_REPO_NAME = "Workspace Root";
const SETTING_WORKSPACE_ROOT_PATH = "workspaceRootPath";
const SETTING_WORKSPACE_REPO_ID = "workspaceRepoId";

type WorkspaceSettingRow = { value: string } | undefined;

class WorkspaceRootPathConflict extends Error {}

function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as WorkspaceSettingRow;
  return row?.value ?? null;
}

function setSetting(key: string, value: string) {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(key, value);
}

export function ensureWorkspaceRepo(rootPath: string): string {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM repos WHERE path = ?")
    .get(rootPath) as { id: string } | undefined;
  if (existing && existing.id !== WORKSPACE_REPO_ID) {
    throw new WorkspaceRootPathConflict();
  }

  const hidden = db
    .prepare("SELECT id FROM repos WHERE id = ?")
    .get(WORKSPACE_REPO_ID) as { id: string } | undefined;

  if (hidden) {
    db.prepare("UPDATE repos SET name = ?, path = ? WHERE id = ?").run(
      WORKSPACE_REPO_NAME,
      rootPath,
      WORKSPACE_REPO_ID,
    );
    return WORKSPACE_REPO_ID;
  }

  db.prepare("INSERT INTO repos (id, name, path) VALUES (?, ?, ?)").run(
    WORKSPACE_REPO_ID,
    WORKSPACE_REPO_NAME,
    rootPath,
  );
  return WORKSPACE_REPO_ID;
}

export function getWorkspaceSettings() {
  const rootPath = getSetting(SETTING_WORKSPACE_ROOT_PATH);
  if (!rootPath) {
    return { rootPath: null, workspaceRepoId: null };
  }

  try {
    if (statSync(rootPath).isDirectory()) {
      const workspaceRepoId = ensureWorkspaceRepo(rootPath);
      setSetting(SETTING_WORKSPACE_REPO_ID, workspaceRepoId);
      return { rootPath, workspaceRepoId };
    }
  } catch {
    // Keep returning the saved path so the UI can show and let the user fix it.
  }

  return { rootPath, workspaceRepoId: null };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings/workspace-root", () => getWorkspaceSettings());

  app.put("/api/settings/workspace-root", (req, reply) => {
    const parsed = workspaceRootSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const rootPath = normalizeLocalPath(parsed.data.rootPath);
    try {
      if (!statSync(rootPath).isDirectory()) {
        return reply.status(400).send({ error: "Root path must be a directory" });
      }
    } catch {
      return reply.status(400).send({ error: "Root path does not exist" });
    }

    const db = getDb();
    const save = db.transaction(() => {
      const workspaceRepoId = ensureWorkspaceRepo(rootPath);
      setSetting(SETTING_WORKSPACE_ROOT_PATH, rootPath);
      setSetting(SETTING_WORKSPACE_REPO_ID, workspaceRepoId);
      return { rootPath, workspaceRepoId };
    });

    try {
      return save();
    } catch (err) {
      if (err instanceof WorkspaceRootPathConflict) {
        return reply.status(409).send({
          error: "Root path is already registered as a repo. Remove that repo or choose its parent directory as the workspace root.",
        });
      }
      throw err;
    }
  });
}
