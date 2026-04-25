# Claude headless turns use one process per prompt

- Date: 2026-04-13
- Status: Accepted

## Context

The original MVP plan treated Claude as a long-lived process using stdin JSON messages,
while Codex was one-shot per turn. In headless `claude --print` mode, project/plugin
initialization can hang before stdin-driven turns complete, which leaves the web session
stuck in `running` even though the Cockpit UI is still connected.

Claude CLI already persists conversation state and supports `--resume <session-id>`, so
we can keep multi-turn continuity without keeping the process alive between prompts.

## Decision

The Claude adapter spawns a fresh `claude --print --output-format stream-json` process for
each user prompt. The prompt is passed as the final positional argument and stdin is closed
immediately. When a prior Claude session id exists, the adapter passes `--resume` so the
CLI loads the previous conversation.

For this headless path, the adapter passes settings that disable Claude plugins known to
hang in non-interactive execution, while leaving project files, permissions, hooks, MCP
configuration, and skills available through the normal CLI environment.

## Consequences

- `session-bridge` must treat both Claude and Codex as one-shot-per-turn adapters and attach
  process listeners after `startTurn()`.
- A normal process close is a valid fallback completion path if no structured `turn_complete`
  event arrived.
- Do not reintroduce a long-lived Claude stdin process unless the headless hang has been
  proven fixed and `--resume` continuity is preserved.
