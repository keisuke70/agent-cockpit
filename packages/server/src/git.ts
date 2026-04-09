import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { makeSpawnEnv } from "./adapters/base.js";

export interface GitStatus {
  branch: string;
  dirty: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

const TIMEOUT_MS = 5000;

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: makeSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      proc.kill("SIGKILL");
      resolve(null);
    }, TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve(null);
    });
  });
}

function parseShortstat(text: string): { insertions: number; deletions: number } {
  // " 3 files changed, 12 insertions(+), 5 deletions(-)"
  const ins = text.match(/(\d+) insertion/);
  const del = text.match(/(\d+) deletion/);
  return {
    insertions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0,
  };
}

export async function getGitStatus(repoPath: string): Promise<GitStatus | null> {
  if (!existsSync(repoPath)) return null;

  const [branchOut, porcelainOut, shortstatOut] = await Promise.all([
    runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(repoPath, ["status", "--porcelain"]),
    runGit(repoPath, ["diff", "--shortstat", "HEAD"]),
  ]);

  if (branchOut === null || porcelainOut === null) {
    return null;
  }

  const branch = branchOut.trim() || "(detached)";
  const porcelainLines = porcelainOut
    .split("\n")
    .filter((line) => line.length > 0);
  const filesChanged = porcelainLines.length;
  const dirty = filesChanged > 0;

  const { insertions, deletions } = shortstatOut
    ? parseShortstat(shortstatOut)
    : { insertions: 0, deletions: 0 };

  return { branch, dirty, filesChanged, insertions, deletions };
}
