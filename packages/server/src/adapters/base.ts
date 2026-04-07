import type { ChildProcess } from "node:child_process";

export interface NormalizedEvent {
  type:
    | "init"
    | "text_delta"
    | "message_complete"
    | "tool_use"
    | "turn_complete"
    | "error"
    | "status";
  [key: string]: unknown;
}

export interface AdapterHandle {
  proc: ChildProcess | null;
  cliSessionId?: string;
}

export interface CLIAdapter {
  readonly name: string;

  /** Initialize or resume a session. Persistent adapters spawn a long-lived process here. */
  init(opts: { cwd: string; cliSessionId?: string }): Promise<AdapterHandle>;

  /** Start a new turn. One-shot adapters spawn a new process here. */
  startTurn(handle: AdapterHandle, prompt: string): void;

  /** Stop the current turn. */
  stopTurn(handle: AdapterHandle): void;

  /** Dispose of the session entirely. */
  dispose(handle: AdapterHandle): void;

  /** Parse a single JSONL line into a normalized event. Returns null if not parseable. */
  parseEvent(line: string): NormalizedEvent | null;
}

/** PATH entries for CLI discovery */
export const CLI_PATH_PREFIX = "/Users/kei/.local/bin:/opt/homebrew/bin";

export function makeSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${CLI_PATH_PREFIX}:${process.env.PATH ?? ""}`,
  };
}
