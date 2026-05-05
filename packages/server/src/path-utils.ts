import { homedir } from "node:os";
import { resolve } from "node:path";

/** Normalize a user-entered local filesystem path for server-side checks. */
export function normalizeLocalPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Path is required");
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}
