# Codex rich-client parity: modes, approvals, structured composer input, and rewind

## Context

Agent Cockpit already uses `codex app-server` for Codex sessions and has a broad
static slash-command catalog. Current support is mostly text-first:

- local slash commands such as `/status`, `/model`, `/mcp`, `/skills`, `/apps`,
  and `/plugins` return markdown information
- app-server-backed commands such as `/review`, `/compact`, `/fork`, `/goal`,
  and `/stop` call focused RPCs
- many native Codex slash commands are marked `recognized` so they are not
  accidentally sent to the model
- normal turns send only text input to `turn/start`
- app-server approval requests are currently declined automatically because no
  approval UI exists

A comparison with CC Pocket showed the main remaining gap is not command
recognition. It is rich-client behavior: session-level model/permission/mode
state, approval round-trips, plan mode via `collaborationMode`, structured
composer entities (`$skill`, `$app`, `@plugin`), image input, and rollback/rewind.

Relevant current files:

- `packages/shared/src/slash-commands.ts`
- `packages/shared/src/protocol.ts`
- `packages/shared/src/types.ts`
- `packages/server/src/db.ts`
- `packages/server/src/codex/app-server-client.ts`
- `packages/server/src/process-manager.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/ws/handler.ts`
- `packages/server/src/ws/session-bridge.ts`
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/components/StreamOutput.tsx`
- `packages/web/src/hooks/useWebSocket.ts`
- `packages/web/src/pages/SessionPage.tsx`

Protocol verification note: implementation must run `codex app-server generate-ts`
for the installed CLI version before editing app-server request/response shapes.
The plan intentionally names current expected shapes, but generated schema wins
where it differs.

Relevant decisions:

- `docs/decisions/2026-04-13-codex-trusted-execution.md`
- `docs/decisions/2026-05-05-codex-transcripts-read-through.md`

Working-tree note: `packages/server/src/ws/session-bridge.ts` is already
modified before this plan. Implementation must inspect and preserve those edits
rather than overwriting the file wholesale.

## Goals

1. Make Codex sessions carry explicit rich-client settings:
   - model
   - reasoning effort
   - approval policy
   - approval reviewer
   - sandbox mode
   - collaboration mode (`default` or `plan`)
   - optional additional writable roots, but only through validated app-server
    `sandboxPolicy`/permission-profile support; do not send unverified thread
    params
2. Implement an approval UI and app-server approval round-trip instead of always
   auto-declining server-initiated requests.
3. Make `/plan` actually switch Codex collaboration mode and make plan exit an
   explicit user decision.
4. Make `/model`, `/reason`, and `/permissions` able to change session settings,
   not only display current values.
5. Make `/skills`, `/apps`, and `/plugins` usable from the composer as structured
   Codex input (`skill` and `mention` items), not only as markdown lists.
6. Add image attachment support for Codex turns using app-server structured input.
7. Implement `/undo` / rollback for recent Codex turns and tighten existing
   `/fork` behavior around user-facing session creation.
8. Preserve the existing PWA-first architecture, Tailscale/local-token security
   model, and SQLite metadata model.

## Non-goals

- Do not replace the PWA with a native app.
- Do not copy CC Pocket's entire protocol or Flutter UX.
- Do not remove SQLite `messages`; Codex transcript read-through and Cockpit
  overlay behavior remain as decided in
  `2026-05-05-codex-transcripts-read-through.md`.
- Do not expose public internet access or change the localhost/Tailscale Serve
  deployment model.
- Do not make Claude use Codex app-server-only concepts. Claude may keep the
  existing local slash helpers and DB transcript behavior.
- Do not implement every native Codex TUI command in the first pass. Commands
  that depend on desktop/TUI state may remain `recognized` with explicit help.

## Architecture

### 1. Persist Codex session settings

Add nullable columns to `sessions` via `packages/server/src/db.ts` migrations:

```sql
codex_model TEXT
codex_reasoning_effort TEXT
codex_approval_policy TEXT
codex_approvals_reviewer TEXT
codex_sandbox_mode TEXT
codex_collaboration_mode TEXT
codex_additional_writable_roots TEXT -- JSON array, initially dormant until validated
```

`codex_additional_writable_roots` is persisted now so `/sandbox-add-read-dir` can
be added later, but it must not be blindly sent to `thread/start` or
`thread/resume`. Current app-server schema should be verified during
implementation; if writable roots are only supported through turn-level
`sandboxPolicy`, `permissionProfile`, or config/profile mechanisms, use that
validated path or keep the value display-only until the matching command is
implemented.

Default behavior should preserve today's trusted execution when columns are
unset:

- `approvalPolicy = "never"`
- `approvalsReviewer = "user"`
- `sandbox = "danger-full-access"`
- `collaborationMode = "default"`

Add narrow helpers in `session-bridge.ts` or a focused `codex/session-settings.ts`
module:

- `readCodexSessionSettings(sessionId)`
- `updateCodexSessionSettings(sessionId, patch)`
- `codexThreadParamsFromSettings(settings, cwd)`
- `codexTurnParamsFromSettings(settings, threadId, input)`

Update shared `Session` types and `/api/sessions` route output only with
backward-compatible optional fields.

### 2. Apply settings to app-server thread and turn lifecycle

In `ensureCodexAppServerManaged()`:

- read saved settings
- pass model, approval policy, approvals reviewer, sandbox mode, and only
  schema-verified supported config to `thread/start` / `thread/resume`
- continue to tolerate app-server protocol drift by sending only validated fields
- if a setting is unsupported by the installed app-server, surface a clear local
  slash-command or status warning rather than breaking session start

In `startCodexTurn()` and slash commands that launch turns:

- convert text/images/skills/mentions into an app-server `input` array
- include saved model / reasoning effort when supported
- pass `collaborationMode` only after constructing a schema-valid value; the
  current generated schema requires an effective non-empty `settings.model`,
  `settings.reasoning_effort` when present, and `developer_instructions: null`
  where required. Resolve the model from saved session setting, app-server
  default model/config, or omit `collaborationMode` with a clear warning until
  a valid model is available.
- keep stop/interruption race semantics from the existing app-server plan

### 3. Approval request routing and UI

Replace unconditional auto-decline in `CodexAppServerClient.handleServerRequest()`
with routable pending requests.

Server-side design:

- Extend `AppServerMessage` dispatch so server-initiated requests with a
  `threadId`, `itemId`, `approvalId`, or equivalent thread context can be routed
  to the relevant `ManagedSession` listener.
- Store pending requests on `ManagedSession`, for example:
  - `pendingApprovals: Map<string, PendingApproval>`
  - `pendingUserInputs: Map<string, PendingUserInput>`
- Add client protocol events:
  - `permission_request`
  - `permission_resolved`
  - optionally `user_input_request` if question-style requests need a distinct
    shape; otherwise use `permission_request` with `kind`.
- Add client protocol messages:
  - `approve_permission`
  - `approve_permission_for_session`
  - `reject_permission`
  - `answer_user_input`
- Map app-server requests:
  - legacy `execCommandApproval` -> command approval card or safe decline with
    user-visible diagnostic if the legacy payload cannot be normalized
  - legacy `applyPatchApproval` -> file-change approval card or safe decline
    with user-visible diagnostic if the legacy payload cannot be normalized
  - `item/commandExecution/requestApproval` -> command approval card
  - `item/fileChange/requestApproval` -> file-change approval card
  - `item/permissions/requestApproval` -> permission-grant card
  - `mcpServer/elicitation/request` -> MCP elicitation/question card
  - `item/tool/requestUserInput` -> question card
  - preserve `account/chatgptAuthTokens/refresh` handling as an explicit
    `respondError`; Agent Cockpit does not manage those tokens
- Respond to app-server using current protocol shapes:
  - command/file: `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }`
  - permissions: `{ scope: "turn" | "session", permissions }`
  - questions: `{ answers }`
  - elicitation: shape based on request kind, with safe decline fallback

Safety rules:

- If no WebSocket client is connected and the session is waiting on approval,
  keep the request pending and show it on reconnect via snapshot/catch-up.
- If the request cannot be routed to a session, decline safely as today and log
  enough context for debugging without leaking secrets.
- If the user presses Stop while waiting, reject/decline pending approvals and
  interrupt the active turn.
- Do not expose non-`never` approval modes in the UI until the approval path is
  working end-to-end.

Frontend design:

- Extend `useWebSocket()` state with pending approval/question items.
- Add an approval bar/card near the composer or top of the stream with:
  - tool name / command / cwd / file change summary
  - Approve
  - Approve for session when available
  - Reject
  - answer form for question-style requests
- Ensure buttons are keyboard reachable and announce updates via `role="status"`
  or `aria-live` where appropriate.

### 4. Implement session-changing slash commands

Update `SLASH_COMMANDS` support status and `runSlashCommand()` behavior.

#### `/model` and `/reason`

Supported syntax:

- `/model` — list models and show current setting
- `/model <model-id>` — set session model
- `/model default` — clear explicit model
- `/reason` — show current reasoning effort
- `/reason <minimal|low|medium|high|xhigh>` — set reasoning effort

After changes:

- persist setting to `sessions`
- return markdown confirmation
- apply to the next `turn/start`
- do not restart a running turn

#### `/permissions`

Supported syntax:

- `/permissions` — show current saved/effective approval and sandbox settings
- `/permissions approval <never|on-request|on-failure|untrusted>`
- `/permissions reviewer <user|auto_review|guardian_subagent>`
- `/permissions sandbox <read-only|workspace-write|danger-full-access>`
- `/permissions reset` — clear explicit settings back to Agent Cockpit defaults

Phase gating:

- Before Phase 3 approval UI is validated, `/permissions` may only display
  settings, reset settings, or set safe trusted values (`approval never` with the
  current sandbox default). Attempts to set `on-request`, `on-failure`, or
  `untrusted` must return a message explaining that approval UI must be enabled
  first. After Phase 3, those modes can be enabled.

For sandbox changes that need thread-level application:

- persist immediately
- tell the user it applies to the next session resume or next new thread if the
  current app-server cannot mutate it live
- if app-server supports per-turn equivalent policy, use it only after validation

#### `/plan`

Change `/plan` from `recognized` to implemented.

Supported syntax:

- `/plan` — set `codex_collaboration_mode = "plan"`
- `/plan off` or `/plan default` — set mode back to `default`
- `/plan <prompt>` — set mode to `plan` and immediately start a Codex turn with
  `<prompt>`

Turn behavior:

- `turn/start` includes `collaborationMode.mode = "plan"` while plan mode is on
- when app-server emits plan items or plan updates, show them as structured-ish
  tool/status entries in the stream where practical
- when a plan completes and app-server does not provide a native approval
  request, create a Cockpit-local `ExitPlanMode` approval card:
  - Approve: switch mode to `default` and send `Execute the approved plan...`
    as the next turn or a steer request if supported
  - Reject: keep mode as `plan` and optionally send feedback
- obey repo plan workflow rules: if Codex is operating in this repo and writes a
  formal plan, Agent Cockpit must not encourage bypassing required plan review.

#### `/undo`

Change `/undo` from `recognized` to app-server-backed when possible.

Supported syntax:

- `/undo` — rollback one Codex user turn
- `/undo <n>` — rollback `n` turns, capped to a small safe maximum such as 5

Implementation:

- call `thread/rollback` with `{ threadId, numTurns }`
- refresh display transcript after success
- mark or delete affected normal Codex `source = 'cache'` rows for rolled-back
  turns so DB fallback does not resurrect them
- persist a Cockpit-local assistant message explaining what was rolled back
- if `thread/rollback` is unavailable, return an explicit unsupported message

#### `/fork`

Define `/fork` as: create a new Codex thread that preserves the current
conversation up to the latest committed turn, then create a new Cockpit session
pointing at that thread. To match that user-facing meaning, call
`thread/fork` with the current `threadId` and `persistExtendedHistory: true` and
do **not** pass `excludeTurns: true` unless generated schema/documentation proves
that omitting it would fork an empty thread. If implementation verification
shows the installed app-server requires a different field to fork at the current
turn, update this plan/implementation note before coding.

After creating the new session:

- refresh session list/lobby so it appears immediately
- include a link to the new session as today
- ensure transcript read-through can open the forked thread without DB-only
  fallback

### 5. Composer capabilities and structured entities

Add a session capabilities path so the composer can offer dynamic Codex entities.

Server:

- Add a `session_capabilities` WebSocket event or `/api/sessions/:id/capabilities`
  endpoint returning:
  - static slash commands with support/category/description
  - visible models
  - current settings
  - skills from `skills/list`
  - apps from `app/list`
  - plugins from `plugin/list`
- Cache per session/cwd with short TTL and refresh on app-server notifications
  such as `skills/changed` or `app/list/updated`.
- Keep failures non-fatal; return partial capabilities and warnings.

Frontend composer:

- Keep `/` completion for slash commands.
- Add `$` completion for skills and apps:
  - `$skill-name` inserts a skill token
  - `$app-id` inserts an app connector token
- Add `@` completion for plugins.
- Show category labels and descriptions.
- Support tap, arrow keys, Tab/Enter selection, Escape dismissal.
- Maintain mobile-friendly sizing and avoid covering the whole viewport.

Protocol:

Extend `SendPromptMessage` with optional structured fields and validation that
allows either non-empty text or at least one image:

```ts
content: string;
images?: Array<{ base64: string; mimeType: string; name?: string }>;
skills?: Array<{ name: string; path: string }>;
mentions?: Array<{ name: string; path: string }>;
```

Image-only prompts are supported only after Phase 6. Before Phase 6, the
composer must require text. After Phase 6, both client and server validation must
accept `content.trim() === ""` when `images.length > 0` and provide a default
text item such as `"Please analyze the attached image."` only if the app-server
requires a text item.

Before sending, parse the composer text for selected `$skill`, `$app`, and
`@plugin` tokens and attach the matching structured entries. Send the original
text too so the transcript stays human-readable.

App-server input conversion:

```ts
[
  ...skills.map(s => ({ type: "skill", name: s.name, path: s.path })),
  ...mentions.map(m => ({ type: "mention", name: m.name, path: m.path })),
  { type: "text", text },
  ...images.map(img => ({ type: "localImage", path: tempPath }))
]
```

Use protocol field names that match the installed Codex app-server. If current
schema uses `localImage` vs `local_image`, verify with `codex app-server
generate-ts` during implementation and document the chosen shape.

### 6. Image attachments

Frontend:

- Add an attach-image button to `Composer`.
- Accept common image MIME types: PNG, JPEG, WebP, GIF if app-server supports it.
- Show attached thumbnails with remove buttons before send.
- Enforce a conservative size/count limit, e.g. 5 images and 10 MB total, before
  base64 encoding.

Server:

- Decode base64 into temp files under OS temp directory, not the repo.
- Pass temp image paths as app-server structured input.
- Delete temp files after `turn/start` accepts the input or after failure.
- For reconnect/history, show the text prompt and image-count badge first; full
  persistent image gallery can be a follow-up unless simple to add safely.

### 7. Stream rendering for richer Codex items

Improve `StreamOutput` enough to make new flows understandable:

- render pending approval cards
- render plan update / plan result items distinctly when normalized from
  app-server notifications
- render tool use summaries for command/file/MCP/dynamic/webSearch items
- do not block the first implementation on a perfect transcript renderer for
  every Codex item type

Maintain existing read-through design:

- canonical Codex chat messages still come from `thread/read`
- Cockpit-local slash results and approval/status messages remain DB overlays
- no duplicate normal assistant messages after refresh/reload

## Implementation sequence

### Phase 1 — Settings foundation

1. Add DB columns and TypeScript types for Codex settings.
2. Add read/update helpers and expose settings in session API responses.
3. Apply settings to `thread/start`, `thread/resume`, and `turn/start`.
4. Update `/status` and `/permissions` to show saved and effective values.
5. Validation: existing Codex session still starts with trusted defaults.

### Phase 2 — Model/reasoning and permissions commands

1. Implement `/model <id|default>` and `/reason <effort>`.
2. Implement `/permissions ...` display/reset/safe trusted setting changes with
   validation. Gate non-`never` approval modes until Phase 3 approval UI passes
   smoke testing.
3. Add small UI indicators in `SessionPage` for model/mode/approval if space
   permits.
4. Validation: setting changes persist across reload and affect the next turn.

### Phase 3 — Approval round-trip

1. Refactor `CodexAppServerClient` server request handling to route requests.
2. Extend shared protocol with approval events/messages.
3. Add pending approval state to `ManagedSession` and WebSocket snapshot/catch-up.
4. Add frontend approval card/bar.
5. Enable non-`never` approval policy in `/permissions` only after this phase is
   working, and document that old auto-decline behavior is no longer active for
   routed requests.
6. Validation: `on-request` command approval can be approved/rejected from the
   PWA and the turn resumes or fails predictably.

### Phase 4 — Plan mode

1. Implement `/plan`, `/plan off`, and `/plan <prompt>`.
2. Send schema-valid `collaborationMode` on Codex turns when an effective model
   can be resolved; otherwise omit it and surface a clear warning.
3. Normalize plan items/updates enough for the UI.
4. Add Cockpit-local plan approval fallback when app-server does not emit a
   native approval request.
5. Validation: `/plan` changes mode, the next turn plans instead of executing,
   approval switches back to default and starts execution.

### Phase 5 — Composer entities and structured input

1. Add capabilities event/API for skills/apps/plugins/models/current settings.
2. Add `$` and `@` completion overlays in `Composer`.
3. Extend prompt protocol and parse selected tokens into `skills`/`mentions`.
4. Convert structured input in `startCodexTurn()`.
5. Validation: selecting `$skill` sends a `skill` input item; selecting `$app` or
   `@plugin` sends a `mention` input item.

### Phase 6 — Images

1. Add image picker/thumbnail UI.
2. Extend prompt protocol with image attachments and limits.
3. Decode to temp files and pass app-server local image input.
4. Clean up temp files reliably.
5. Validation: image + text prompt and, after server validation is updated,
   image-only prompt reach Codex and no temp files accumulate.

### Phase 7 — Rewind/rollback polish

1. Implement `/undo` via `thread/rollback`.
2. Refresh transcript after rollback.
3. Mark or delete affected normal Codex `source = 'cache'` DB rows so rolled-back
   turns do not reappear in DB fallback/unreadable-thread views; preserve the
   Cockpit overlay rows for the `/undo` command and its result.
4. Validation: rollback removes recent turn from read-through transcript and
   does not corrupt Cockpit DB overlays.

## Validation

Automated checks after implementation:

```bash
npm run typecheck
npm run build
```

Because this is a plan-mode implementation touching more than three files, run
implementation review before completion:

```bash
bash scripts/run-codex-review.sh impl <session-key> < review-prompt.txt
```

Then deploy before reporting user-testable completion, per repo instructions:

```bash
npm run deploy
```

Manual smoke tests:

1. Existing Codex session opens and normal prompt still streams.
2. `/model`, `/reason`, and `/permissions` display and persist settings.
3. `/permissions approval on-request` plus a command prompt creates an approval
   card and approve/reject works.
4. `/plan` switches to plan mode; `/plan off` returns to default.
5. `$skill`, `$app`, and `@plugin` completions appear after capabilities load and
   are sent as structured input.
6. Image attachment prompt works and temp files are removed.
7. `/undo` rolls back one Codex turn, cleans/marks affected cache rows, and
   refreshes transcript.
8. Refresh/reload preserves canonical Codex transcript plus Cockpit overlay rows.
9. Claude sessions still handle local slash helpers and do not receive
   Codex-only structured fields.
10. PWA accessibility: composer and approval controls are keyboard operable,
    labeled, and do not trap focus.

## Risks and mitigations

- **Codex app-server protocol drift**: verify shapes with `codex app-server
  generate-ts` during implementation; isolate runtime narrowing at the server
  boundary.
- **Approval request routing ambiguity**: if a request cannot be mapped to a
  `threadId`, decline safely and show a diagnostic. Do not hang the app-server.
- **Non-`never` approval modes without UI**: do not expose setting changes until
  Phase 3 is validated.
- **Plan execution semantics**: app-server plan-mode behavior may differ by
  version. Keep `/plan` mode toggling independent from plan approval fallback so
  the user can recover with `/plan off`.
- **Structured token parsing mistakes**: only attach structured items for tokens
  selected from known capabilities; leave unknown `$foo` or `@foo` as plain text.
- **Large image payloads**: enforce client-side and server-side limits.
- **Transcript duplication**: keep normal Codex assistant/user messages as
  app-server read-through data; mark local slash/approval/status rows as
  Cockpit overlays.
- **Existing modified file**: review current `session-bridge.ts` edits before
  patching and avoid wholesale rewrites.

## Follow-up work

- Persistent image gallery/history integration for Codex image prompts.
- Dedicated UI for model and permissions instead of slash-only controls.
- More native commands: `/ps`, `/provider`, `/fast`, `/undo` variants,
  `/sandbox-add-read-dir`.
- Session capability cache invalidation tests.
- Rich transcript rendering for every Codex item type.
- Decision Record if the implementation changes the trusted-execution default or
  introduces a durable approval policy change.
