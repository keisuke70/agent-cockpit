import { spawn } from "node:child_process";
import type { CLIAdapter, AdapterHandle, NormalizedEvent } from "./base.js";
import { makeSpawnEnv } from "./base.js";

const CODEX_BIN = "/opt/homebrew/bin/codex";
const CODEX_TRUSTED_EXECUTION_ARG = "--dangerously-bypass-approvals-and-sandbox";

export interface CodexHandle extends AdapterHandle {
  cwd: string;
}

export class CodexAdapter implements CLIAdapter {
  readonly name = "codex";

  async init(opts: { cwd: string; cliSessionId?: string }): Promise<CodexHandle> {
    return { proc: null, cliSessionId: opts.cliSessionId, cwd: opts.cwd };
  }

  startTurn(handle: AdapterHandle, prompt: string): void {
    const codexHandle = handle as CodexHandle;
    // -C is exec-level only; --json and the bypass flag live on each subcommand.
    const args = ["exec", "-C", codexHandle.cwd];

    if (codexHandle.cliSessionId) {
      args.push(
        "resume",
        "--json",
        CODEX_TRUSTED_EXECUTION_ARG,
        codexHandle.cliSessionId,
        "-",
      );
    } else {
      args.push("--json", CODEX_TRUSTED_EXECUTION_ARG, "-");
    }

    const proc = spawn(
      CODEX_BIN,
      args,
      {
        env: makeSpawnEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // Send the prompt via stdin so resumed sessions can use `codex exec resume ... -`
    // and long prompts do not need to fit in argv.
    proc.stdin.end(prompt);

    handle.proc = proc;
  }

  stopTurn(handle: AdapterHandle): void {
    if (handle.proc && !handle.proc.killed) {
      handle.proc.kill("SIGTERM");
    }
  }

  dispose(handle: AdapterHandle): void {
    this.stopTurn(handle);
    handle.proc = null;
  }

  parseEvent(line: string): NormalizedEvent | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return null;

    let data: any;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (data.type === "thread.started") {
      return {
        type: "init",
        sessionId: data.thread_id ?? "",
      };
    }

    // Agent message completed
    if (
      data.type === "item.completed" &&
      data.item?.type === "agent_message"
    ) {
      return {
        type: "message_complete",
        content: data.item.text ?? "",
        role: "assistant",
      };
    }

    // Turn completed successfully
    if (data.type === "turn.completed") {
      return {
        type: "turn_complete",
        cost: undefined,
      };
    }

    // Turn failed
    if (data.type === "turn.failed") {
      return {
        type: "error",
        message: data.error ?? "Codex turn failed",
      };
    }

    return null;
  }
}
