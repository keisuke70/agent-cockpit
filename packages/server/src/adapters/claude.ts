import { spawn } from "node:child_process";
import type { CLIAdapter, AdapterHandle, NormalizedEvent } from "./base.js";
import { makeSpawnEnv } from "./base.js";

const CLAUDE_BIN = "/Users/kei/.local/bin/claude";

/**
 * Claude adapter. Each turn spawns a new `claude --print` process. Multi-turn
 * continuity is handled via `--resume <session-id>`: Claude CLI's own session
 * persistence loads the prior conversation.
 *
 * Key flags:
 * - `--settings '{"enabledPlugins":{}}'`: Disable plugins that hang in headless
 *   `--print` mode (e.g. frontend-design, swift-lsp try to initialize LSP/MCP
 *   connections that never complete without an interactive terminal). All other
 *   project settings (MCP servers, permissions, hooks, skills, CLAUDE.md) remain
 *   fully loaded.
 * - Prompt is passed as a CLI positional arg, not via stdin.
 */
export class ClaudeAdapter implements CLIAdapter {
  readonly name = "claude";

  async init(opts: { cwd: string; cliSessionId?: string }): Promise<ClaudeHandle> {
    return {
      proc: null,
      cliSessionId: opts.cliSessionId,
      cwd: opts.cwd,
    };
  }

  startTurn(handle: AdapterHandle, prompt: string): void {
    const h = handle as ClaudeHandle;

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--settings",
      '{"enabledPlugins":{}}',
    ];

    if (h.cliSessionId) {
      args.push("--resume", h.cliSessionId);
    }

    // Prompt as the final positional argument
    args.push(prompt);

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: h.cwd,
      env: makeSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Close stdin immediately — we pass the prompt as a CLI arg, not via stdin
    proc.stdin.end();

    h.proc = proc;
  }

  stopTurn(handle: AdapterHandle): void {
    if (handle.proc && !handle.proc.killed) {
      handle.proc.kill("SIGTERM");
    }
  }

  dispose(handle: AdapterHandle): void {
    if (handle.proc && !handle.proc.killed) {
      handle.proc.kill("SIGTERM");
    }
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

export interface ClaudeHandle extends AdapterHandle {
  cwd: string;
}
