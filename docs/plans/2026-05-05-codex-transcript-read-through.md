# Codex transcript read-through from app-server

## Context

Agent Cockpit now has a Codex app-server runtime (`codex-cli 0.125.0` on this
machine) and already stores the Codex app-server thread id in
`sessions.cli_session_id`. The current implementation still treats SQLite
`messages` as the primary transcript for every session and uses a Codex-only
`Sync` button to import missing app-server thread items into that table.

This creates the problem described in the user conversation: mobile and desktop
clients can diverge because Cockpit DB rows are a second transcript source of
truth while Codex itself owns the real thread history.

Local verification for this investigation:

- `/opt/homebrew/bin/codex`
- `codex-cli 0.125.0`
- `codex app-server --help` works
- `codex app-server generate-ts --out /tmp/codex-app-server-schema-readthrough`
  works
- generated `v2/ThreadReadParams.ts` confirms `thread/read` supports
  `{ threadId, includeTurns: boolean }`
- generated `v2/Thread.ts` confirms `thread/read` with `includeTurns` returns
  `turns: Array<Turn>`
- generated `v2/ThreadItem.ts` confirms turn items include `userMessage`,
  `agentMessage`, tools, reasoning, plans, file changes, command execution, web
  search, and other non-chat items

Relevant current code:

- `packages/server/src/codex/app-server-client.ts` provides a singleton JSON-RPC
  client with `request()` and per-thread notification subscriptions.
- `packages/server/src/ws/session-bridge.ts` already calls `thread/read` inside
  `syncCodexThreadMessages()`, but writes imported items into SQLite and then
  sends DB rows back to the client.
- `packages/server/src/ws/handler.ts` always builds WebSocket snapshots from the
  `messages` table.
- `packages/web/src/hooks/useWebSocket.ts` exposes `syncMessages()` and treats
  `messages_synced` as a replacement message list.
- `packages/web/src/pages/SessionPage.tsx` shows a Codex-only `Sync` button.
- `messages` is still necessary for Claude transcripts and for Cockpit-only
  messages such as local slash-command responses.

## Feasibility conclusion

This is feasible now, but the DB cannot be removed wholesale.

Adopt this source-of-truth split:

```txt
Codex normal conversation transcript = Codex app-server thread/read
Cockpit DB messages = Claude transcript + Cockpit-only overlays + fallback/cache
Cockpit DB sessions/repos/schedules/push/settings = Cockpit metadata source of truth
```

The important nuance is Cockpit-only Codex messages. Several Codex slash commands
are handled locally by Agent Cockpit without creating a Codex model turn
(`/help`, `/status`, `/sessions`, `/rename`, unsupported-command help, etc.). If
Codex sessions displayed only `thread/read`, those local user/assistant rows
would disappear. Therefore the implementation should not literally delete the
`messages` table for Codex. It should render Codex thread items as canonical and
merge a narrow DB overlay for messages that are intentionally not present in the
Codex thread.

## Goal

Make Codex session display read through Codex app-server on every full snapshot
or explicit refresh, so a newly opened phone/desktop view sees the canonical
Codex thread without requiring manual DB sync.

Expected product behavior:

1. Opening/reloading a Codex session reads `thread/read` instead of relying on
   SQLite `messages` as primary transcript.
2. Normal Codex user and assistant messages are derived from Codex thread items.
3. Cockpit-only slash-command messages still appear by merging a DB overlay.
4. `Sync` becomes `Refresh` and no longer imports Codex messages into the DB.
5. Sending a normal Codex prompt still streams live as today, then future
   snapshots reflect Codex's canonical thread.
6. Claude sessions continue to use SQLite `messages` exactly as today.
7. Existing old Codex sessions with only DB messages still have a fallback path
   if `thread/read` fails or the old `cli_session_id` cannot be resumed.

## Non-goals

- Do not remove the `messages` table.
- Do not migrate Claude to app-server or read-through behavior.
- Do not build a full transcript renderer for every non-chat Codex item in this
  pass. Tool/file/command items may continue to appear as live `tool_use` badges
  and debug output; transcript bubbles should focus on `userMessage` and
  `agentMessage`.
- Do not change the app-server transport from stdio.
- Do not add approval UI.
- Do not make token usage, thread list, fork/resume list, or archive/pinned
  metadata part of this pass, except where existing behavior needs to keep
  working.

## Architecture

### 1. Add a transcript reader module

Create `packages/server/src/codex/transcript.ts` (or an equivalently focused
module) with these responsibilities:

- `readCodexTranscript(managed, sessionId): Promise<CodexTranscriptReadResult>`
- call `thread/read` with `{ threadId: managed.codexThreadId, includeTurns: true }`
- map thread `turns[].items[]` to shared `Message` objects for:
  - `userMessage` -> role `user`
  - `agentMessage` -> role `assistant`
- create stable synthetic ids from Codex identity:
  - `${threadId}:${turn.id}:${item.id}` when all parts exist
  - a deterministic fallback including role + turn index + item index if needed
- derive `createdAt` from `turn.startedAt` for user messages and
  `turn.completedAt ?? turn.startedAt` for assistant messages, converted to ISO
  strings accepted by the current frontend.
- preserve item order from app-server rather than sorting only by timestamp.
- return thread metadata needed by the snapshot path, at minimum:
  - `threadId`
  - `thread.name`
  - `thread.preview`
  - `thread.status.type`
  - `thread.updatedAt`

Keep this module tolerant of protocol drift by narrowing unknown runtime values
at the boundary instead of importing generated schema files into the repo in
this pass.

### 2. Mark or identify Cockpit-only DB overlay rows

Add an explicit way to distinguish DB transcript rows that should be merged into
Codex read-through output from DB rows that are just old cached duplicates.

Preferred schema change:

```sql
ALTER TABLE messages ADD COLUMN source TEXT;
```

Use values:

- `cockpit` for local-only slash command user/assistant rows and other
  Cockpit-generated transcript messages.
- `cache` for any Codex thread imports retained for fallback/backcompat.
- `NULL` for legacy rows.

Implementation rules:

- For Claude, no behavior change is required; legacy/NULL rows remain the
  transcript source because the session agent is Claude.
- For Codex normal prompts, stop relying on DB rows as primary transcript. The
  existing `createRunningTurn()` may still insert the local user row for retry,
  audit, and fallback, but it should mark the row `source = 'cache'` or another
  non-overlay value so it is not merged into read-through snapshots when the
  Codex thread item exists.
- For locally handled slash commands, mark both the user command row and the
  Cockpit assistant reply `source = 'cockpit'` so they survive in Codex sessions
  even though they are absent from `thread/read`.
- For assistant messages received from app-server `item/completed`, either stop
  persisting them for Codex normal turns or persist them as `source = 'cache'`
  with `external_id`. Do not merge them into read-through output unless the
  Codex read fails.

If a smaller first patch avoids a new column, an acceptable alternative is to
use `external_id IS NULL` plus slash-command turn detection (`user.content LIKE
'/%'`) as the overlay heuristic, but this is more fragile. The plan recommends
an explicit `source` column because the source-of-truth distinction is an
architectural boundary.

### 3. Build one message-list helper for snapshots and refresh

Replace duplicated SQL reads with a single server helper, for example:

```ts
async function listDisplayMessagesForSession(managed, sessionId): Promise<{
  messages: Message[];
  source: 'codex-thread' | 'db' | 'db-fallback';
  warning?: string;
  threadName?: string | null;
}>;
```

Behavior:

- If the session agent/runtime is not Codex app-server, return current DB
  `messages` rows.
- If Codex app-server is available and `thread/read` succeeds:
  1. map Codex thread chat items to `Message[]`
  2. load Codex DB overlay rows where `source = 'cockpit'`
  3. merge overlay rows into the Codex message list at the approximate turn
     position when possible:
     - keep DB `createdAt` order for overlay rows
     - if exact interleaving is ambiguous, append overlay rows by timestamp after
       the nearest surrounding Codex messages; deterministic ordering is more
       important than perfect chronology
  4. return `source = 'codex-thread'`
- If `thread/read` fails:
  1. return DB rows for the session
  2. return `source = 'db-fallback'` and a warning string that can be surfaced in
     the existing sync/refresh error area

This helper should be used by:

- WebSocket initial snapshot in `packages/server/src/ws/handler.ts`
- reconnect full snapshot fallback in the same file
- explicit refresh action
- Codex-aware retry/last-user-message lookup if retry remains DB-backed today
- Codex local slash helpers that need “last assistant message”, such as `/copy`

### 4. Convert WebSocket snapshot path to async read-through

`sendSnapshotMsg()` in `packages/server/src/ws/handler.ts` is currently
synchronous. Convert it to an async function and `await` it in both snapshot
call sites.

The snapshot should continue using the existing `SnapshotEvent` shape initially,
with optional backward-compatible fields added only if useful:

```ts
transcriptSource?: 'codex-thread' | 'db' | 'db-fallback';
transcriptWarning?: string;
```

If these optional fields are added, update
`packages/shared/src/protocol.ts` and the web hook. Existing clients can ignore
unknown fields, but the TypeScript types should stay accurate.

When a Codex snapshot reads a thread name and the Cockpit session `name` is null,
use `thread.name ?? thread.preview` as the displayed `sessionName` fallback. Do
not overwrite a non-null Cockpit `sessions.name` automatically; users may want a
Cockpit-specific display name later.

### 5. Replace Sync import with Refresh read-through

Retire the current meaning of `syncCodexThreadMessages()`.

Implementation options, in order of preference:

1. Introduce protocol names that match behavior:
   - client message: `refresh_transcript`
   - server success event: `transcript_refreshed`
   - server failure event: `transcript_refresh_failed`
2. Or keep existing wire names for a smaller patch but change UI wording and
   server semantics:
   - `sync_messages` now means “re-read display transcript”
   - `messages_synced.importedCount` becomes always `0` or is ignored

The plan recommends option 1 if the patch is not too large, because “sync” now
suggests DB mutation and can reintroduce confusion.

Frontend changes:

- `packages/web/src/hooks/useWebSocket.ts`
  - rename state/callbacks to `refreshingTranscript`, `refreshTranscript`, and
    `transcriptRefreshError` (or keep aliases internally if minimizing churn)
  - on refresh success replace `messages` with the server-provided list
  - on refresh failure show the warning/error without clearing existing messages
- `packages/web/src/pages/SessionPage.tsx`
  - change the Codex-only button label from `Sync` to `Refresh`
  - update title text to “Re-read the Codex thread transcript”
  - keep disabled while running to avoid confusing mid-turn partial snapshots

### 6. Keep live streaming behavior but stop treating DB as canonical

For Codex app-server notifications in
`packages/server/src/ws/session-bridge.ts`:

- Continue broadcasting `text_delta`, `message_complete`, `tool_use`,
  `turn_complete`, `status`, and `error` so connected clients see live progress.
- Avoid duplicate persistence for canonical Codex items:
  - either do not call `persistMessage()` for normal Codex `agentMessage` items
  - or call it with `source = 'cache'` and an `external_id`, then exclude it from
    read-through overlay.
- At normal turn completion, optionally trigger a background transcript refresh
  for connected clients only if live event ordering proves insufficient. The
  first implementation can skip this because connected clients already receive
  `message_complete`, and disconnected/new clients will read through on snapshot.
- Ensure stopped/failed turns do not leave local DB turn state running. The
  existing `turn/completed` handling remains necessary because Cockpit status,
  notifications, schedules, and retry guards are still Cockpit metadata.

### 7. Retry and copy semantics

Current retry uses the last DB user message. For Codex read-through sessions,
that can become stale or miss messages created by another client.

Update `getLastUserMessage()` to:

- if Codex app-server is available, read the current Codex transcript and return
  the last role `user` message from `thread/read`
- if that fails, fall back to the DB query
- for Claude, keep the DB query

Update `/copy` for Codex to use the display transcript helper and copy the last
assistant message from the merged read-through output. Claude can keep the
existing DB behavior.

### 8. Migration and fallback policy

No destructive migration is required.

- Existing `messages` rows stay in place.
- Existing Codex rows with `external_id` should be treated as cache/fallback, not
  overlay.
- Existing Codex rows without `external_id` are ambiguous. Conservative behavior
  for old sessions:
  - if `thread/read` succeeds, prefer Codex thread and merge only rows that are
    clearly Cockpit-local (`source = 'cockpit'` after new writes, or slash-command
    heuristic for legacy rows)
  - if `thread/read` fails, show all DB rows as `db-fallback`
- Existing sessions whose `cli_session_id` cannot resume need an explicit
  resume-failure marker before `ensureManaged()` overwrites the stored thread id.
  Add one of these implementation mechanisms:
  - preferred: add nullable session columns such as
    `codex_unreadable_thread_id` and `codex_unreadable_at`, populated with the
    old `cli_session_id` and timestamp when `thread/resume` fails before writing
    the new `thread/start` id; or
  - if avoiding schema columns, persist equivalent metadata in a narrowly named
    `app_settings`/metadata record keyed by Cockpit session id.
- The display helper must use that marker so old transcripts do not disappear
  after resume failure. When `codex_unreadable_thread_id` is present:
  1. read the new current Codex thread normally, if possible;
  2. load legacy DB messages for the session that are not clearly app-server
     duplicates (`external_id IS NULL` and `source IS NULL OR source IN
     ('cache','cockpit')`);
  3. prepend/merge those legacy DB rows before the readable new-thread messages,
     de-duping exact role/content pairs where possible;
  4. keep doing this until the user explicitly deletes the Cockpit session or a
     future migration provides a better archival boundary.
- If the readable current Codex thread is empty and legacy DB messages exist,
  return `source = 'db-fallback'` or a mixed `db-fallback` result rather than an
  empty `codex-thread` transcript. This rule is mandatory because current
  `ensureManaged()` starts a new empty thread after resume failure.

### 9. Decision Record

During implementation, add a Decision Record because this source-of-truth split
is easy to regress:

`docs/decisions/YYYY-MM-DD-codex-transcripts-read-through.md`

It should record:

- Codex thread/read is canonical for normal Codex transcript display.
- SQLite `messages` remains canonical for Claude and Cockpit-only transcript
  overlays.
- The DB is still canonical for Cockpit metadata such as sessions, repos,
  schedules, push subscriptions, status, and display preferences.
- Future features must not reintroduce DB import as the primary Codex transcript
  path.

## Implementation steps

1. Add `messages.source` migration and update `persistMessage()` call sites to
   tag Claude/default, Codex cache, and Cockpit-local rows correctly.
2. Add a durable resume-failure marker for Codex sessions before overwriting an
   unreadable old `cli_session_id`, so the display layer can preserve legacy DB
   history after a new app-server thread is created.
3. Extract transcript mapping/reading helpers for Codex `thread/read`.
4. Add the display-message helper that chooses Codex read-through, mixed
   legacy-DB-plus-Codex output, DB, or DB fallback by session/runtime.
5. Convert WebSocket snapshot sending to async and use the helper.
6. Replace Codex Sync semantics with Refresh semantics in shared protocol,
   server handler, web hook, and session page.
7. Update Codex retry and `/copy` to read from the display transcript helper.
8. Add the Decision Record.
9. Run validation and deploy.

## Validation

Automated:

```bash
npm run typecheck
npm run build
```

Because repo instructions require it after an implementation chunk:

```bash
npm run deploy
```

Manual smoke tests:

1. Create a new Codex session, send a normal prompt, reload the page, and confirm
   the transcript still appears without pressing Sync.
2. Open the same Codex session from another device/browser after a turn completes
   and confirm the new client sees the canonical thread.
3. Press Refresh in a Codex session and confirm it re-reads without importing
   duplicate DB messages.
4. Send local slash commands such as `/help`, `/status`, `/sessions`, and an
   unsupported slash command; reload and confirm those Cockpit-only rows still
   appear.
5. Send a normal Codex prompt after local slash commands and confirm no duplicate
   user/assistant bubbles appear after reload.
6. Retry a Codex session and confirm the retried prompt is the last user message
   from the Codex thread, with DB fallback if app-server read fails.
7. Open a Claude session and confirm its transcript behavior is unchanged.
8. Simulate a Codex `thread/read` failure and confirm DB fallback keeps old
   messages visible with an error/warning.
9. Simulate a non-resumable old Codex `cli_session_id`; confirm the server
   records the old unreadable thread id before writing the new one, and confirm
   the session still displays legacy DB messages plus any new current-thread
   messages after reload.
10. Confirm schedules still run prompts against the same Cockpit session metadata
    and do not depend on Codex transcript DB rows.

## Risks and mitigations

- **Local slash-command rows disappearing**: mitigated by explicit
  `messages.source = 'cockpit'` overlay rows.
- **Duplicate messages after reload**: mitigated by excluding Codex cache rows
  from read-through overlay and using stable app-server-derived ids.
- **Thread/read latency on mobile reconnect**: one `thread/read` per full
  snapshot is acceptable for this pass. If it becomes slow, add short-lived
  in-memory caching keyed by `threadId + thread.updatedAt` later.
- **Protocol drift**: keep app-server shape checks narrow and fallback to DB on
  read failure.
- **Legacy ambiguous DB rows**: prefer app-server when readable, but preserve a
  durable resume-failure marker before overwriting an unreadable old thread id.
  Use that marker to keep pre-existing DB history visible as a legacy segment
  alongside the new readable thread, rather than replacing the display with an
  empty/new thread.
- **Status and transcript source confusion**: keep Cockpit DB as metadata source
  for status/turn/schedule/push, while transcript bubbles for Codex come from
  `thread/read`.

## Open questions for implementation

- Whether to introduce new protocol event names (`refresh_transcript`) or reuse
  the existing `sync_messages` wire names for a smaller patch. The plan
  recommends new names unless the diff becomes unnecessarily large.
- Whether normal Codex user rows should continue to be inserted as DB cache for
  audit/retry fallback or skipped entirely. The plan recommends keeping them as
  cache because it improves fallback and does not affect canonical display once
  `source` filtering is in place.
