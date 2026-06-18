# Codex turn sync hardening plan

- Date: 2026-05-06
- Status: Approved by codex-plan-review
- Scope: prevent Agent Cockpit from marking a Codex prompt as successfully handled unless Codex app-server actually accepted and materialized the turn, and make desync/retry states visible after realtime failures, reconnects, and deploy restarts.

## Problem statement

Agent Cockpit currently stores a user prompt locally before calling Codex app-server `turn/start`. That local row is useful as a UI cache, but the code can later treat the turn as `complete` even when Cockpit has no durable proof that Codex accepted or persisted the turn. In the observed incident, a new Codex session first attempted `thread/realtime/start`, the WebRTC answer failed, and later normal text prompts were present in Cockpit SQLite but absent from Codex logs/transcript. Re-opening the session then made the work appear to have vanished because Codex `thread/read` is the canonical transcript source for Codex sessions.

The fix should not make SQLite the canonical Codex transcript again. It should make the handoff to Codex explicit, verifiable, recoverable, and visible to the user.

## Goals

1. Distinguish local acceptance from Codex submission, Codex materialization, assistant activity, and final completion.
2. Never mark a normal Codex text turn `complete` solely because a local fallback or stale terminal event fired.
3. Detect turns that were accepted locally but not submitted/materialized in Codex, especially after realtime start failures and reconnects.
4. Show a clear UI state and retry path for desynced/unsent turns.
5. Keep Codex app-server `thread/read` as canonical for materialized Codex transcript while preserving local cache rows as safety overlays.
6. Avoid expensive or fragile transcript reads on every streamed delta; verify at lifecycle boundaries and reconnect/refresh points.

## Non-goals

- Do not replace Codex app-server transcript with Cockpit SQLite as the normal source of truth.
- Do not implement full offline queueing for prompts in this pass.
- Do not attempt to repair Codex's internal realtime/WebRTC behavior; Cockpit should contain failures and recover cleanly.
- Do not persist every streaming delta forever unless needed for a clear user-facing recovery state.

## Existing decisions to preserve

- `docs/decisions/2026-05-05-codex-transcripts-read-through.md`: Codex `thread/read` remains canonical for normal transcript display.
- `docs/decisions/2026-05-05-codex-running-cache-overlay.md`: local cache rows may be overlaid when app-server transcript has not materialized matching messages.
- `docs/decisions/2026-05-05-codex-idle-thread-reconciliation.md`: stale local running state may be reconciled from app-server lifecycle state, but this plan narrows when reconciliation is allowed to declare `complete`.

## Proposed model

Add an explicit sync layer around Codex turns.

### Turn lifecycle states

Keep existing `turns.status` for broad UI compatibility, but add Codex-specific fields that explain where a turn is in the handoff:

- `codex_turn_id TEXT`: app-server turn id returned by `turn/start` or observed in `turn/started`.
- `codex_sync_status TEXT`: one of:
  - `local_only`: prompt accepted into Cockpit DB, not yet submitted to Codex.
  - `submit_inflight`: `turn/start` request is in progress.
  - `submitted`: `turn/start` returned or `turn/started` was observed.
  - `materialized`: `thread/read` contains the matching app-server turn/user item.
  - `assistant_started`: assistant/tool activity was observed for this turn.
  - `assistant_completed`: assistant message was persisted/observed for this turn.
  - `complete`: terminal Codex turn with expected evidence.
  - `stopped`: user interrupted or Codex interrupted.
  - `error`: Codex returned a failure.
  - `desynced`: Cockpit has a local turn but cannot prove Codex accepted/materialized it.
- `codex_submitted_at TEXT`
- `codex_materialized_at TEXT`
- `codex_last_checked_at TEXT`
- `codex_sync_error TEXT`
- `retry_of_turn_id TEXT` or `metadata` JSON field usage for linking targeted retries; prefer a real nullable column if the UI needs efficient lookups.

Use a migration via `ensureColumn` in `packages/server/src/db.ts`. Add a required index `idx_turns_session_codex_sync` on `(session_id, codex_sync_status, started_at)` and a unique partial index for `(session_id, codex_turn_id)` where `codex_turn_id IS NOT NULL` to prevent accidental duplicate local mappings.

### Mapping to existing `turns.status` and `sessions.status`

Do not add `desynced` to the existing broad status union in this pass. Keep `codex_sync_status` as the detailed state and map it to existing statuses as follows:

- `local_only`, `submit_inflight`, `submitted`, `materialized`, `assistant_started`, `assistant_completed`: `turns.status='running'`, `sessions.status='running'` while the turn is actively being processed.
- `complete`: `turns.status='complete'`, `sessions.status='idle'`.
- `stopped`: `turns.status='stopped'`, `sessions.status='stopped'` for explicit user/Codex interrupts.
- `error`: `turns.status='error'`, `sessions.status='error'` for Codex/app-server failures where retrying the whole session may be appropriate.
- `desynced`: `turns.status='error'`, `sessions.status='idle'` after Cockpit finishes bounded verification and determines the prompt is saved locally but not confirmed in Codex. This unlocks the composer without pretending the work completed. The transcript row carries `codex_sync_status='desynced'` so the UI shows a targeted “Saved locally, not confirmed in Codex” retry action instead of the generic stopped/error retry button.

A `desynced` turn must never set `turns.status='complete'`. Generic retry should not be the primary UI for it; targeted retry by local turn/message id is required.

### Evidence rules

A normal Codex text turn may become `complete` only if at least one of these is true:

1. Cockpit observed a terminal `turn/completed` for the same `codex_turn_id` and has either observed assistant activity or confirmed materialization via `thread/read`.
2. `thread/read` confirms the app-server turn exists and is terminal, and the latest local running turn maps to that Codex turn.
3. The turn is an explicitly Cockpit-local slash command (`source='cockpit'`), which remains outside normal Codex turn evidence.

A turn with no `codex_turn_id`, no assistant activity, and no matching app-server transcript after a bounded check must become `desynced`, not `complete`.

## Implementation plan

### Phase 1 — Schema and typed helpers

Files:

- `packages/server/src/db.ts`
- `packages/shared/src/types.ts`
- `packages/shared/src/protocol.ts`

Tasks:

1. Add Codex sync columns to `turns`.
2. Define shared types for `CodexTurnSyncStatus` and expose optional sync fields on turn/session diagnostics if needed.
3. Add helper functions in `session-bridge.ts` or a new small module for:
   - setting sync status for the latest or specific turn,
   - mapping `codex_turn_id` to local `turns.id`,
   - recording materialization checks and errors.

### Phase 2 — Submit path becomes explicit

Files:

- `packages/server/src/ws/session-bridge.ts`

Tasks:

1. Change `createRunningTurn` for Codex normal prompts to initialize `codex_sync_status='local_only'` and return the local `turnId` as it does today.
2. Change the call signature to `startCodexTurn(managed, sessionId, localTurnId, normalizedContent, options)`. The local turn id created before submission must be passed through every async path. Do not infer the target row from “latest running turn” in submit/complete logic.
3. In `startCodexTurn`:
   - set `submit_inflight` immediately before `client.request('turn/start', ...)`,
   - on returned `result.turn.id`, set `codex_turn_id`, `codex_submitted_at`, `submitted` on that exact `localTurnId`,
   - if `turn/start` rejects before returning an id, mark that local turn `turns.status='error'`, `codex_sync_status='error'` or `desynced` depending on whether Codex rejected vs. Cockpit lost confirmation, set `codex_sync_error`, unlock the session appropriately, and broadcast an error that makes clear the prompt did not reach Codex.
4. Track an in-memory map on `ManagedSession` from `codexTurnId -> localTurnId` and `localTurnId -> codexTurnId` for the active turn. Persisted `codex_turn_id` remains the durable source after reconnect.
5. In `turn/started` notification handling, update only the matching local turn by `codex_turn_id` or by the currently pending `localTurnId` from `startCodexTurn`. Do not let stale notifications attach to the newest local turn if ids disagree.
6. Persist `assistant_started` when an agent message delta, tool use, or agent item for the current `codex_turn_id` is observed.
7. Persist `assistant_completed` when an `agentMessage` item completes.
8. Content matching is not allowed to mark a no-id turn complete during normal operation. It may only be used during bounded reconnect recovery when exactly one local candidate and exactly one transcript candidate match within the recovery window; ambiguous matches remain `desynced`.

### Phase 3 — Materialization verification at boundaries

Files:

- `packages/server/src/ws/session-bridge.ts`

Tasks:

1. Add `verifyCodexTurnMaterialized(sessionId, managed, localTurnId)` that loads the exact local turn row, then calls `thread/read` with `includeTurns: true` and searches in this order:
   - matching `turn.id === turns.codex_turn_id`,
   - only for reconnect recovery with no `codex_turn_id`: a unique matching user content candidate near the local turn timestamp.
   Ambiguous content matches return “unconfirmed”, never “materialized”.
2. Run verification:
   - after `turn/start` succeeds, asynchronously with a short retry/backoff window,
   - after `turn/completed` before declaring local `complete`,
   - during snapshot/refresh/reconnect reconciliation for local `running`, `submitted`, or `desynced` candidates.
3. Treat `thread/read` errors carefully:
   - `not materialized yet` on fresh empty threads should stay non-fatal for no-turn sessions,
   - a submitted local prompt that remains absent after bounded retries should become `desynced`,
   - app-server unavailable should surface as `error`/warning without losing local cache rows.
4. Avoid reading after every delta; verification occurs only at submit, terminal, and refresh/reconnect boundaries.

### Phase 4 — Completion and reconciliation rules

Files:

- `packages/server/src/ws/session-bridge.ts`

Tasks:

1. Update `completeCodexTurnFromNotification` so a normal text turn is completed only if the terminal event maps to a local turn by `codex_turn_id`/active mapping and has sufficient evidence.
2. Update `reconcileCodexThreadStatus` to avoid converting a local running/submitted turn to `complete` when there is no matching Codex turn/user item. Mark it `desynced` instead.
3. Preserve existing stopped/error behavior for explicit interrupts and terminal failed/error statuses.
4. Add an invariant: normal Codex turns with `source='cache'` user messages and no assistant/codex evidence cannot silently become `complete`.

### Phase 5 — Realtime failure isolation

Files:

- `packages/server/src/routes/realtime.ts`
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/hooks/useWebSocket.ts`
- `packages/shared/src/protocol.ts`

Tasks:

1. Ensure `thread/realtime/start` failure does not mutate normal prompt text or create a normal text turn.
2. After realtime start failure, explicitly clear voice server state and broadcast a `codex_realtime_error`/voice error that is visually separate from composer text.
3. Block normal Send while `voiceState` is `starting`, `recording`, `stopping`, or finalizing. The current UI mostly does this; verify edge cases where start fails after the user has typed more text.
4. Add mandatory server-side realtime state to `ManagedSession`, for example `codexRealtimeState: 'idle' | 'starting' | 'active' | 'stopping' | 'error'` plus `codexRealtimeError`. Set it in `routes/realtime.ts` before/after `thread/realtime/start` and `thread/realtime/stop`, and update it from app-server realtime notifications.
5. Make `sendPrompt` reject normal text sends while realtime state is `starting`, `active`, or `stopping`. The rejection must not create a turn or message row; it should broadcast/send a retryable voice/realtime error to the client.
6. After realtime start failure, set realtime state to `error` briefly for UI display, then allow a clean transition back to `idle` only after cleanup.
7. Confirm a failed realtime attempt leaves the Codex thread usable for normal `turn/start`; if not, mark the current managed thread unhealthy, remove/recreate the managed bridge, and start a fresh Codex thread while preserving a warning and the local voice error.

### Phase 6 — UI recovery and retry

Files:

- `packages/web/src/components/StreamOutput.tsx`
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/hooks/useWebSocket.ts`
- `packages/shared/src/protocol.ts`
- `packages/server/src/ws/handler.ts`

Tasks:

1. Extend snapshot/transcript events with per-message/turn sync warnings for local cache rows that are not materialized in Codex.
2. Display a compact warning bubble for `desynced` turns: “Saved locally, not confirmed in Codex.”
3. Add a new targeted retry protocol, separate from the existing generic `retry` command, for example client message `{ type: 'retry_desynced_turn', turnId }`.
4. The server must re-check materialization for that exact local turn immediately before retrying. If it materialized meanwhile, clear the warning and do not resend.
5. If still unconfirmed, create a new linked retry turn with the same user content and store `retry_of_turn_id` (new column) or equivalent metadata. Mark the original `codex_sync_status='desynced'` or `retried`/`superseded` if that status is added, but keep it visible so the user can see what happened.
6. Expose per-message/turn sync metadata in `snapshot` and `transcript_refreshed` so the UI can attach the retry button to the exact affected user bubble.
7. Avoid automatically resending without user action in this pass; duplicate work is worse than a clear retry prompt.
8. Keep existing cache overlay behavior so reloads still show the user's message and any assistant cache rows.

### Phase 7 — Observability and diagnostics

Files:

- `packages/server/src/ws/session-bridge.ts`
- `packages/server/src/routes/sessions.ts` or a new diagnostics route if needed
- `docs/decisions/` optional new Decision Record

Tasks:

1. Add structured server logs for:
   - local prompt accepted,
   - `turn/start` request sent,
   - Codex turn id received,
   - materialization confirmed,
   - desync detected,
   - realtime start failure and thread recovery.
2. Add a lightweight debug route or slash command output showing the latest turn sync fields for a session.
3. Add a Decision Record documenting that Cockpit requires Codex turn materialization evidence before normal completion.

### Phase 8 — Tests and manual verification

Automated checks:

- `npm run typecheck`
- Add required scriptable tests or pure helper assertions even if there is no full test harness yet. At minimum cover:
  - materialization matching by `codex_turn_id`,
  - ambiguous content fallback stays unconfirmed,
  - stale terminal notification does not complete the latest local turn,
  - `turn/start` rejection marks the exact local turn error/desynced and unlocks the session,
  - realtime-start failure followed by normal send is rejected during realtime cleanup and succeeds only after state returns to `idle`,
  - desynced targeted retry re-checks materialization before resubmitting.

Manual scenarios:

1. Normal text prompt succeeds:
   - local turn progresses `local_only -> submit_inflight -> submitted/materialized -> assistant_completed/complete`.
   - reload shows Codex transcript without duplicate cache rows.
2. `turn/start` rejects:
   - local user message remains visible,
   - turn is `error` or `desynced`,
   - UI says it did not reach Codex.
3. `turn/start` returns id but `thread/read` does not materialize after retries:
   - turn is `desynced`, not `complete`.
4. Realtime start fails, then user sends text:
   - realtime error is separate from composer text,
   - normal text produces a real Codex `turn/start`,
   - no local-only complete turn is created.
5. Server restart during a running Codex turn:
   - reconnect reconciliation uses Codex evidence,
   - stale running state is not silently turned into complete without a matching turn.
6. Mobile/PWA reload after desync:
   - local cache row remains visible with warning and retry action.

Deployment:

- After implementation and review, run `npm run build`, `npm run typecheck`, and repo-required `npm run deploy` before reporting completion.
- Because deploy restarts launchd and can interrupt the Cockpit chat, report that users should wait briefly and reload the PWA.

## Risks and mitigations

- Risk: `thread/read` is eventually consistent and may lag. Mitigation: use bounded retry/backoff before marking `desynced`.
- Risk: exact content matching can misidentify retries. Mitigation: prefer `codex_turn_id`; content matching is fallback only when no id exists.
- Risk: added sync states complicate UI. Mitigation: expose a single user-facing warning for desync and keep internal states server-side.
- Risk: realtime failures leave Codex thread unhealthy. Mitigation: explicitly test post-realtime normal `turn/start`; if unhealthy, start a fresh thread and preserve local warning.
- Risk: over-verification slows normal turns. Mitigation: verify only at lifecycle boundaries, not per delta.
