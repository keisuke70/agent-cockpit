# Codex App Server integration + slash commands

## Context

Agent Cockpit currently treats Codex as a one-shot CLI process per prompt via
`codex exec --json`. That works for basic prompt/response, but it leaves several
Codex-native rich-client features out of reach:

- canonical Codex thread start/resume/read/list lifecycle
- incremental `item/agentMessage/delta` streaming
- structured tool / command / file-change events
- `turn/interrupt` instead of killing a child process
- model/account/MCP/app/plugin discovery
- slash-command-like UI affordances such as `/status`, `/model`, `/mcp`,
  `/review`, `/compact`, and `/fork`

OpenAI now documents `codex app-server` as the interface used by rich clients.
This matches Agent Cockpit's product goal: a mobile-friendly web cockpit for
normal prompt-driven development.

Local verification on this machine:

- `/opt/homebrew/bin/codex`
- `codex-cli 0.125.0`
- `codex app-server --help` works
- `codex app-server generate-ts --out <tmp>` works
- basic `initialize`, `account/read`, and `model/list` JSON-RPC calls work

## Goal

Replace the Codex-specific backend path with a Codex app-server-backed runtime
while preserving the existing Cockpit frontend contract.

This first implementation should be shippable and narrow:

1. Codex sessions use a long-lived backend-owned `codex app-server` process over
   stdio.
2. Existing Cockpit WebSocket events continue to work:
   - `text_delta`
   - `message_complete`
   - `tool_use`
   - `turn_complete`
   - `status`
   - `error`
3. Existing SQLite records remain the Cockpit source for session list and
   transcript display.
4. `sessions.cli_session_id` stores the Codex app-server `thread.id`.
5. Stop uses `turn/interrupt` instead of process kill for Codex app-server
   sessions.
6. Add a small slash-command MVP for Codex sessions:
   - `/help`
   - `/status`
   - `/model`
   - `/mcp`

## Non-goals for this pass

- Do not migrate Claude. Claude stays on the current `claude --print` one-shot
  adapter.
- Do not expose the experimental app-server WebSocket transport; use stdio.
- Do not implement approval UI yet. Preserve the existing trusted local
  execution decision with `approvalPolicy: "never"` and
  `sandbox: "danger-full-access"` when starting/resuming Codex threads.
- Do not implement the full Codex CLI slash-command list yet.
- Do not import generated TypeScript protocol files into the repo in this pass.
  Use a focused runtime wrapper with conservative `unknown`/narrow types, and
  leave generated-schema vendoring for a follow-up if the integration expands.

## Architecture

### 1. App-server JSON-RPC client

Add `packages/server/src/codex/app-server-client.ts`.

Responsibilities:

- spawn `codex app-server` over stdio
- send `initialize` once and then `initialized`
- correlate JSON-RPC responses by `id`
- expose `request(method, params)` for focused server use
- expose `subscribeThread(threadId, callback)` for notifications and server
  requests that include a `threadId`
- restart is not required in this first pass; if app-server exits, pending
  requests fail and affected sessions surface an error

Transport choice: stdio. Official docs mark WebSocket transport experimental and
unsupported, while backend-owned stdio is enough for Agent Cockpit.

### 2. ManagedSession runtime split

The existing `ManagedSession` assumes a CLI adapter and a child process. Extend
it to support two runtimes:

- `runtime: "cli"` for Claude and any future process-backed adapters
- `runtime: "codex-app-server"` for Codex

For Codex app-server sessions, store:

- `codexThreadId`
- `codexActiveTurnId`
- optional cleanup function returned by `subscribeThread`

`removeManaged()` must call the cleanup function and only call
`adapter.dispose(handle)` for `runtime: "cli"` sessions.

### 3. Codex session lifecycle

In `ensureManaged(sessionId)`:

- if session agent is `claude`, keep current behavior
- if session agent is `codex`:
  - create/get app-server client
  - if `cli_session_id` exists, call `thread/resume`
  - otherwise call `thread/start`
  - pass cwd, `approvalPolicy: "never"`, `sandbox: "danger-full-access"`, and
    `serviceName: "agent_cockpit"`
  - save returned `thread.id` to `sessions.cli_session_id`
  - subscribe to thread notifications

### 4. Codex turn lifecycle

In `sendPrompt()`:

- keep the current running-session guard
- create Cockpit `turns` row and persist the user message as today
- if content is a recognized slash command for a Codex app-server session,
  handle it without starting a model turn
- otherwise for Codex app-server sessions:
  - set session status to `running`
  - call `turn/start` with text input
  - store returned `turn.id` as `codexActiveTurnId`

Notification mapping:

- `item/agentMessage/delta` -> `text_delta`
- `item/completed` with `item.type === "agentMessage"` -> persist assistant
  message and emit `message_complete`
- `item/started` with command/file/MCP/dynamic/web-search-like items -> emit
  `tool_use`
- `turn/completed`:
  - `completed` -> `completeTurn`, status `idle`, `turn_complete`
  - `failed` -> `failTurn`, status `error`, `error`
  - `interrupted` -> `stopTurn`, status `stopped`, `turn_complete`

### 5. Stop lifecycle

For CLI sessions, keep existing adapter stop.

For Codex app-server sessions:

- if there is an active `codexActiveTurnId`, call `turn/interrupt`
- optimistically mark Cockpit status `stopped` as current behavior does
- tolerate the later `turn/completed` interrupted notification

### 6. Slash command MVP

Slash commands are implemented by Cockpit, not by sending raw `/status` text to
the model. The app-server protocol does not expose a generic
`slashCommand/execute` method in the local generated schema.

MVP behavior:

- `/help`
  - return a markdown list of supported Cockpit slash commands
- `/status`
  - show Cockpit session id, Codex thread id, status, cwd, default/available
    model summary, and rate-limit summary when available
- `/model`
  - call `model/list` and show visible models with default marker
- `/mcp`
  - call `mcpServerStatus/list` with `detail: "toolsAndAuthOnly"` and summarize
    configured MCP servers/tools/auth status

Unsupported slash commands should return a helpful assistant message rather than
starting a model turn.

Frontend slash menu/autocomplete is not required for this pass; typing the
command into the existing composer is enough. A later pass can add mobile
friendly suggestions when text starts with `/`.

## Validation

Run:

```bash
npm run typecheck
npm run build
```

Manual smoke test after implementation:

1. start dev server
2. create a Codex session
3. send `/help`
4. send `/status`
5. send a normal prompt and confirm streaming output
6. press Stop during a running turn and confirm status changes
7. reload the session and confirm persisted transcript still appears

## Risks and mitigations

- **Protocol drift**: app-server is new. Keep the wrapper small and avoid
  vendoring large generated schemas in this first pass.
- **Approval prompts**: initial configuration uses trusted execution
  (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`) to match the
  existing decision record. If a server-initiated approval request still appears,
  surface an error and decline/cancel safely.
- **Duplicate assistant messages**: only persist assistant content on
  `item/completed`, not on deltas.
- **CLI and app-server thread id mismatch**: existing `cli_session_id` values
  produced by `codex exec` are expected to be Codex thread ids. If resume fails,
  fall back to `thread/start` and update the DB.

## Follow-up work

- Slash autocomplete in `Composer`
- `/review`, `/compact`, `/fork`, `/apps`, `/plugins`, `/permissions` support
- Approval UI for command/file/MCP prompts
- Generated app-server TS schema management
- Model picker in the normal session creation UI

---

## Review-driven clarifications

The first plan review identified several implementation risks. The following
clarifications are part of the accepted plan and override any looser wording
above.

### A. App-server client ownership

The app-server client is a **singleton per Agent Cockpit server process**.

- Owner module: `packages/server/src/codex/app-server-client.ts`
- Public API:
  - `getCodexAppServerClient()` returns the singleton, creating and
    initializing it on first use
  - `shutdownCodexAppServerClient()` terminates it during server shutdown
  - `subscribeThread(threadId, listener)` registers a per-thread listener and
    returns an unsubscribe function
- `cleanupAll()` / `removeManaged()` only unsubscribe a managed session's thread
  listener. They do **not** terminate the singleton, because other Codex
  sessions may still need it.
- `index.ts` shutdown should call `shutdownCodexAppServerClient()` after
  `cleanupAll()`.

If the singleton process exits unexpectedly:

- reject all pending requests
- mark the client closed
- thread listeners may receive a synthetic local error notification
- the next `getCodexAppServerClient()` call may create a new process, but a
  managed session that was active during the crash should surface an error and
  be removed/recreated on the next reconnect rather than pretending its turn is
  still alive

### B. Resume and migration fallback

Existing `sessions.cli_session_id` values from `codex exec` are treated as
candidate app-server `thread.id` values, but resume failure is expected and must
be safe.

Fallback sequence in `ensureManaged()` for Codex:

1. If `cli_session_id` is present, try `thread/resume` with the stored id.
2. If resume succeeds, keep the stored id.
3. If resume fails:
   - log/broadcast a non-fatal warning only to the session debug/error stream
     if practical
   - call `thread/start` with the same cwd/trusted settings
   - update `sessions.cli_session_id` to the new `thread.id`
   - do **not** delete existing Cockpit `messages` rows; Cockpit transcript
     continuity remains available even if Codex model-visible history starts a
     new thread
4. Ensure the new managed session stores the successful new `codexThreadId`, so
   reconnects do not repeatedly try the failing old id.

Validation must include an existing Codex session row with a populated
`cli_session_id` and a normal reconnect/resume path.

### C. Slash-command turn semantics

Slash commands are transcript-visible but non-model turns.

Exact server behavior for recognized slash commands:

1. Check `session.status`; if `running`, reject like normal prompts.
2. Insert a Cockpit `turns` row with status `running`.
3. Persist the user slash command as a `messages` row linked to that turn.
4. Execute the Cockpit slash handler without calling `turn/start`.
5. Persist the generated assistant markdown reply as a `messages` row linked to
   the same turn.
6. Mark the Cockpit turn `complete`.
7. Keep or set session status to `idle`.
8. Emit, in order:
   - optional `status idle` if needed
   - `message_complete` with the generated assistant content
   - `turn_complete`

Unsupported slash commands follow the same path and produce a helpful assistant
message listing supported commands. They must never fall through into a model
turn in this MVP.

If a slash command handler throws:

- persist an assistant error message when possible
- mark the turn `error`
- set session status `error`
- emit `error`

### D. Notification normalization table

The app-server wrapper maps notifications to the existing Cockpit protocol as
follows.

| App-server message | Condition | Cockpit event | Persistence |
| --- | --- | --- | --- |
| `item/agentMessage/delta` | matching `threadId` | `text_delta { text: params.delta }` | none |
| `item/completed` | `item.type === "agentMessage"` | `message_complete { role: "assistant", content: item.text }` | persist assistant `item.text` |
| `item/started` | `item.type === "commandExecution"` | `tool_use { tool: "command", input: { command, cwd } }` | none |
| `item/started` | `item.type === "fileChange"` | `tool_use { tool: "fileChange", input: { changes } }` | none |
| `item/started` | `item.type === "mcpToolCall"` | `tool_use { tool: server + "/" + tool, input: arguments }` | none |
| `item/started` | `item.type === "dynamicToolCall"` | `tool_use { tool: namespace ? namespace + "/" + tool : tool, input: arguments }` | none |
| `item/started` | `item.type === "webSearch"` | `tool_use { tool: "webSearch", input: { query } }` | none |
| `turn/completed` | `turn.status === "completed"` | `turn_complete`, `status idle` | complete latest running Cockpit turn |
| `turn/completed` | `turn.status === "failed"` | `error`, `status error` | fail latest running Cockpit turn |
| `turn/completed` | `turn.status === "interrupted"` | `turn_complete`, `status stopped` | stop latest running Cockpit turn |
| `error` | matching `threadId` if present, or active thread context | `error` | fail latest running Cockpit turn if running |

Unsupported item types are ignored by default, but may be mirrored to the debug
log. They must not break the active turn. Unknown `turn.status` values are
handled as errors.

Duplicate handling rule:

- Deltas are UI-only and never persisted.
- Only `item/completed` for `agentMessage` persists assistant text.
- If a turn completes without any completed agent message, the turn still closes
  normally; no synthetic assistant message is created unless the completion is a
  slash-command handler response.

### E. Interruption race semantics

`stopSession()` for Codex app-server sessions is optimistic for UI parity with
current behavior:

1. If `codexActiveTurnId` exists, send `turn/interrupt` asynchronously.
2. Mark the Cockpit turn stopped and session `stopped` immediately.
3. Clear `codexActiveTurnId`.
4. If a later `turn/completed` notification arrives for the same interrupted
   turn, treat it as idempotent: do not create a second final status transition
   if there is no running Cockpit turn.

### F. Expanded validation

In addition to `npm run typecheck` and `npm run build`, manual validation must
cover:

1. New Codex session normal prompt streams deltas and persists one final
   assistant message.
2. Existing Codex session with populated `cli_session_id` reconnects/resumes; if
   resume fails, a new thread id is written and transcript remains visible.
3. `/help`, `/status`, `/model`, and `/mcp` complete without leaving the session
   running.
4. Unsupported slash command returns a helpful assistant message and leaves the
   session idle.
5. Stop during streaming produces a single stable final state.
6. Two Codex sessions open at once receive only their own thread notifications.
7. Forced app-server process exit surfaces an error and does not leak a running
   Cockpit turn.
