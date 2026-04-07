import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { CLIAdapter, AdapterHandle, NormalizedEvent } from "./base.js";
import { makeSpawnEnv } from "./base.js";

const CLAUDE_BIN = "/Users/kei/.local/bin/claude";

export class ClaudeAdapter implements CLIAdapter {
  readonly name = "claude";

  async init(opts: { cwd: string; cliSessionId?: string }): Promise<AdapterHandle> {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    if (opts.cliSessionId) {
      args.push("--resume", opts.cliSessionId);
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: makeSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { proc, cliSessionId: opts.cliSessionId };
  }

  startTurn(handle: AdapterHandle, prompt: string): void {
    if (!handle.proc?.stdin?.writable) {
      throw new Error("Claude process stdin not available");
    }
    const msg = JSON.stringify({ type: "user", content: prompt });
    handle.proc.stdin.write(msg + "\n");
  }

  stopTurn(handle: AdapterHandle): void {
    if (handle.proc && !handle.proc.killed) {
      handle.proc.kill("SIGTERM");
    }
  }

  dispose(handle: AdapterHandle): void {
    if (handle.proc && !handle.proc.killed) {
      handle.proc.kill("SIGTERM");
      handle.proc = null;
    }
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

    // System init -> capture session_id
    if (data.type === "system" && data.subtype === "init") {
      return {
        type: "init",
        sessionId: data.session_id ?? "",
      };
    }

    // Stream event with content_block_delta -> text delta
    if (data.type === "stream_event") {
      const event = data.event;
      if (!event) return null;

      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        return {
          type: "text_delta",
          text: event.delta.text ?? "",
        };
      }

      // Tool use
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        return {
          type: "tool_use",
          tool: event.content_block.name ?? "unknown",
          input: event.content_block.input ?? {},
        };
      }

      return null;
    }

    // Completed assistant message
    if (data.type === "assistant" && data.message) {
      const textBlocks = (data.message.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text);
      return {
        type: "message_complete",
        content: textBlocks.join(""),
        role: "assistant",
      };
    }

    // Result -> turn complete
    if (data.type === "result") {
      return {
        type: "turn_complete",
        cost: data.cost_usd ?? undefined,
        sessionId: data.session_id ?? undefined,
      };
    }

    return null;
  }
}
