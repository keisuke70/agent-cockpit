# Codex status authority reset plan

- Date: 2026-05-06
- Status: Approved by codex-plan-review
- Scope: stop Agent Cockpit from flipping Codex sessions to `stopped`/`idle` while Codex is still processing, and simplify the turn-status authority model after the current sync-hardening changes.

## Problem statement

Recent Codex turn-sync hardening added local turn sync fields, transcript cache overlays, realtime guards, preflight thread materialization checks, and a watchdog. The intent was correct, but the current implementation now has too many independent paths that can mutate `turns.status` and `sessions.status`. In practice, the mobile/PWA UI has repeatedly shown `stopped` or `ready` during an active Codex answer.

Observed local DB evidence on 2026-05-06:

- Session `AlSLevx_UB9mi3r5Owqfw` is persisted as `stopped`. Its latest turn seq 2 has `status='stopped'`, `codex_sync_status='stopped'`, a non-null `codex_turn_id`, and `finished_at` equal to `started_at` (`2026-05-06 22:20:35`). That means Cockpit marked it stopped immediately after submission.
- Session `2m7vdubY2dhW5cvSUpXpJ` shows the same pattern: seq 2 is `stopped` with `finished_at` equal to `started_at`.
- Session `WCqm997HragQia3LXozRB` has alternating immediate `stopped` turns and later `desynced` turns, which indicates multiple reconciliation paths are racing rather than a single source of truth deciding lifecycle transitions.

The likely direct cause is in `packages/server/src/ws/session-bridge.ts`: `reconcileCodexThreadStatus()` treats any latest terminal transcript turn, especially `interrupted`, as enough to stop the current local running turn unless the current local turn already has a different `codex_turn_id`. During the local-only / submit-inflight window, or when `thread/read` lags and reports a previous interrupted terminal turn, that guard does not apply. The code then calls generic `stopTurn(sessionId)` / `failTurn(sessionId)` / `completeTurn(sessionId)`, which target the latest local running row and can mutate the new turn even though the terminal event belongs to an old Codex turn.

A second likely cause is `reconcileCodexTurnUntilTerminal()`: if the accepted Codex turn id is not yet visible in `thread/read`, it treats an older terminal latest turn as proof of desync after only a few attempts. This is too aggressive when app-server transcript reads lag or return stale/notLoaded status while the new turn is still active.

## Goals

1. Make one explicit server-side status reducer the only place that writes `turns.status` and `sessions.status` for Codex text turns.
2. Never let an unmatched latest terminal Codex turn stop/fail/complete a different local running turn.
3. Keep the session `running` throughout local-only, submit-inflight, submitted, materialized, assistant activity, permissions, tool use, and streaming states.
4. Treat `stopped` as only user-requested interruption or a terminal Codex `interrupted` event that matches the exact active/local turn.
5. Treat `idle` as only exact-turn completion, cockpit-local slash completion, or no-running-turn startup state.
6. Preserve explicit desync detection, but only after bounded evidence that the exact submitted turn cannot be found and Codex is definitely no longer active for that turn.
7. Add tests that reproduce the observed stale interrupted/latest-turn race.

## Non-goals

- Do not rewrite the Codex app-server client protocol.
- Do not remove transcript cache overlays in this pass.
- Do not implement automatic resend of desynced prompts.
- Do not change the broad shared `SessionStatus` union unless tests prove a new user-visible state is required.
- Do not deploy until the implementation review passes if this plan is implemented later.

## Existing decisions to preserve or refine

- `docs/decisions/2026-05-05-codex-transcripts-read-through.md`: Codex `thread/read` stays canonical for materialized transcript display.
- `docs/decisions/2026-05-05-codex-running-cache-overlay.md`: local cache overlay remains a safety net for accepted user prompts.
- `docs/decisions/2026-05-05-codex-idle-thread-reconciliation.md`: stale local running state can be reconciled from app-server, but this plan narrows the allowed evidence.
- `docs/decisions/2026-05-06-codex-ignore-stale-terminal-turn.md`: unmatched stale terminal turns must be ignored while a newer turn is running; extend this to local-only/submit-inflight states.
- `docs/decisions/2026-05-06-codex-turn-terminal-watchdog.md`: watchdog remains, but its desync branch must use exact-turn evidence rather than “latest terminal exists”.

## Proposed design

### 1. Introduce a single Codex lifecycle reducer

Add a small internal reducer/helper in `packages/server/src/ws/session-bridge.ts` or a new `packages/server/src/ws/codex-turn-state.ts` module:

```ts
type CodexLifecycleInput =
  | { type: "local_submitted"; localTurnId: string }
  | { type: "codex_started"; localTurnId: string; codexTurnId: string }
  | { type: "assistant_activity"; localTurnId: string; codexTurnId?: string }
  | { type: "exact_terminal"; localTurnId: string; codexTurnId: string; terminal: "completed" | "interrupted" | "failed" | "error" }
  | { type: "unmatched_terminal_observed"; latestTurnId: string; terminal: string }
  | { type: "materialization_timeout"; localTurnId: string; codexTurnId?: string; threadStatus: string | null };
```

The reducer should return an action set, and only its action applier should update:

- `turns.status`
- `turns.codex_sync_status`
- `turns.finished_at`
- `sessions.status`
- active tool/session in-memory fields
- status broadcasts

This does not need to be an elaborate framework; the important rule is that existing direct calls to generic `stopTurn(sessionId)`, `failTurn(sessionId)`, and `completeTurn(sessionId)` are removed from Codex text-turn paths.

### 2. Exact-turn terminal evidence becomes mandatory

For Codex text turns, terminal events/read results may mutate a local running turn only when one of these is true:

- `codex_turn_id` on the local row equals the terminal Codex turn id.
- `managed.codexActiveTurnId` equals the terminal Codex turn id and maps to the local row.
- A bounded reconnect recovery path finds exactly one local running no-id row and exactly one transcript turn with matching user content and timestamp; this path must explicitly link the ids before applying terminal state.

If a terminal latest turn is observed but does not match the local running row, log it and leave status unchanged. This must apply even if the local row is still `local_only` or `submit_inflight` and therefore has no `codex_turn_id` yet.

### 3. Protect local-only and submit-inflight windows

`sendPrompt()` currently creates a local running row before `turn/start` returns. During that window:

- Snapshot/reconnect transcript reads may refresh display messages.
- They must not convert the session to `stopped`, `idle`, or `error` based on latest transcript status.
- If `turn/start` later rejects before returning an id, only `startCodexTurn()` / the reducer should decide whether the turn is `error` or retryable local failure.

Add helper predicates:

- `isCodexTurnAwaitingStart(row)` for `local_only` / `submit_inflight` / pending local id.
- `terminalBelongsToLocalTurn(localRow, terminalTurnId, managed)`.
- `shouldIgnoreUnmatchedTerminalWhileRunning(localRow, terminalTurnId)`.

### 4. Replace broad reconciliation with scoped reconciliation

Refactor `reconcileCodexThreadStatus()` so it no longer performs generic latest-row mutation. It should instead:

1. Load the latest running Codex turn row.
2. If there is no running row, optionally repair a previously linked stale row by exact `codex_turn_id`; do not change session status unless that row is still terminal-incomplete.
3. If there is a running row and `latestTurnId` does not match it, return without changing status.
4. If there is a running row and `latestTurnId` matches it, call the reducer with `exact_terminal`.
5. If `threadStatusType === 'idle'` and there is a running no-id/submitted row, run exact materialization verification before any desync transition.

This removes the current branch that maps an unmatched latest `interrupted` to `nextStatus='stopped'` and then calls `stopTurn(sessionId)`.

### 5. Make watchdog desync evidence stricter

Update `reconcileCodexTurnUntilTerminal()`:

- If the exact `codexTurnId` is absent from `thread/read`, do not treat an older terminal latest turn as sufficient proof of desync.
- Only mark desynced when both are true:
  1. The exact turn id is absent after the bounded window; and
  2. app-server reports a non-running thread state that is not merely stale/notLoaded, or an exact API read confirms the accepted turn cannot exist in the target thread.
- While uncertain, keep `sessions.status='running'` and set only diagnostic `codex_sync_error` such as “waiting for materialization”.
- Use a longer or adaptive grace period for accepted `turn/start` ids because the user-visible failure mode of premature idle/stopped is worse than staying running a bit longer.

### 6. Reconcile terminal notifications by exact local turn only

`turn/completed` notification handling should:

- Resolve `localTurnId` from the terminal `turn.id`.
- If no mapping exists, do **not** attach the terminal event to `managed.codexPendingLocalTurnId` just because a pending no-id row exists. That submit-inflight window is where stale terminal notifications are most dangerous.
- An unmapped terminal notification may attach to a pending no-id local turn only after it first satisfies the §2 bounded recovery rule: explicit `turn/start` correlation from the request/response path, or a recovery `thread/read` that finds exactly one transcript turn with matching user content and timestamp. The implementation must link the Codex id to the local row before applying any terminal mutation.
- If the terminal id differs from active/local mappings, ignore it except for cleaning `codexStoppingTurnId` when it is the explicitly interrupted turn.
- Call the reducer with `exact_terminal`; do not directly set `sessions.status` in the notification handler.

### 7. Tests and diagnostics

Add tests or a deterministic script that can run in CI/local development without a real Codex app-server by extracting pure helper logic where practical.

Minimum cases:

1. Running local-only turn + latest transcript `interrupted` from an old turn => remains `running`.
2. Running submitted turn with `codex_turn_id=A` + latest transcript `completed`/`interrupted` for `B` => remains `running`.
3. Running submitted turn with exact `codex_turn_id=A` + terminal `completed` for `A` => becomes `idle`/`complete`.
4. Running submitted turn with exact `codex_turn_id=A` + terminal `interrupted` for `A` after user stop => becomes `stopped`.
5. Watchdog cannot see `A`, but latest old terminal `B` exists => remains `running` until strict desync criteria pass.
6. Pending `submit_inflight` local turn with no Codex id + stale/unmapped `turn/completed` for old id `B` => remains `running`; pending row stays unchanged and no id is linked.
7. Startup with no running turn and stale linked terminal row can be repaired by exact id without affecting a newer turn.

Add a DB diagnostics route or script output for recent turn state transitions if needed:

- local turn id
- codex turn id
- old/new broad status
- old/new sync status
- reason/event type
- latest transcript turn id/status

### 8. Manual verification

After implementation:

1. Run `npm run check:codex-sync`.
2. Run `npm run typecheck`.
3. Run new lifecycle unit/script tests.
4. Start a Codex session and send two turns back-to-back from the web UI.
5. While the second turn is streaming, manually refresh transcript and navigate away/back; status must stay `running`.
6. Test a long-running command/tool use; status must stay `running` until exact terminal completion.
7. Press Stop during a running turn; only then should status become `stopped`, and only for the exact active turn.
8. Run `npm run deploy` before reporting an implementation as ready, because this repo’s launchd server will otherwise keep serving old code.

## Implementation phases

### Phase A — Extract status authority helpers

Files:

- `packages/server/src/ws/session-bridge.ts`
- optional `packages/server/src/ws/codex-turn-state.ts`
- optional `packages/server/src/ws/codex-turn-state.test.ts` or `scripts/check-codex-status-lifecycle.mjs`

Tasks:

1. Add exact-turn matching predicates.
2. Add the lifecycle reducer/action applier.
3. Move status writes for Codex text turns behind the reducer.
4. Leave non-Codex CLI and cockpit-local slash command flows unchanged.

### Phase B — Refactor reconciliation and watchdog

Files:

- `packages/server/src/ws/session-bridge.ts`

Tasks:

1. Refactor `reconcileCodexThreadStatus()` to ignore unmatched latest terminal turns while any Codex local row is running or submit-inflight.
2. Refactor `reconcileCodexTurnUntilTerminal()` to avoid stale latest-terminal desync.
3. Ensure `completeCodexTurnFromNotification()` applies only exact-turn terminal transitions.
4. Remove or fence generic `stopTurn(sessionId)`, `failTurn(sessionId)`, and `completeTurn(sessionId)` from Codex text-turn paths.
5. Add an explicit audit checklist for every Codex app-server status mutator. Grep/review all uses of `completeTurn`, `stopTurn`, `failTurn`, `completeTurnById`, `stopTurnById`, `failTurnById`, `markTurnDesynced`, and `updateSessionStatus`; assign each use to exactly one category:
   - reducer-owned Codex text-turn transition,
   - exact-id fenced Codex transition,
   - non-Codex CLI path,
   - cockpit-local slash command path,
   - startup/no-running-turn repair path that cannot affect an active newer turn.
6. Include `thread/compacted`, slash-command handling, bridge recovery, desync handling, notification completion, and realtime cleanup in the audit. `thread/compacted` must not complete an active text turn unless it is fenced by exact active turn or there is no active local turn.

### Phase C — Tests and observability

Files:

- `scripts/check-codex-turn-sync.mjs` or a new lifecycle check script
- `package.json`
- optional diagnostics route in `packages/server/src/routes/sessions.ts`

Tasks:

1. Add regression checks for the stale terminal scenarios.
2. Update `npm run check:codex-sync` or add a new script and run it in the verification sequence.
3. Add structured logs around ignored unmatched terminal events and exact terminal transitions.

### Phase D — Review and deploy

Tasks:

1. Run `npm run check:codex-sync`.
2. Run `npm run typecheck`.
3. Run the new lifecycle tests.
4. Because implementation would change more than three files or follow this approved plan, run `/codex-impl-review` before commit/completion.
5. Run `npm run deploy` before final implementation report.

## Risk assessment

- Risk: Keeping status `running` too long if an exact terminal event is missed. Mitigation: exact-id watchdog still completes/stops/fails when it sees the matching turn; strict desync eventually unlocks the UI with a retryable state.
- Risk: Refactor regresses cockpit-local slash commands or Claude CLI sessions. Mitigation: fence new reducer to Codex app-server normal text turns only.
- Risk: Tests become too coupled to private helper shapes. Mitigation: extract small pure predicates and reducer actions with stable input/output.
- Risk: Existing DB rows with wrong `stopped` status remain stale. Mitigation: optional one-time diagnostic/repair can be added after code is fixed, but do not mass-rewrite history before stabilizing lifecycle logic.

## Open questions for implementation

1. Should strict desync eventually map session to `idle` or a new user-visible retry-required status? Current plan keeps broad `idle` plus per-turn `desynced` metadata to avoid expanding shared status in this pass.
2. Should exact terminal `interrupted` become `stopped` only if `managed.codexStopRequested` is true? The safer initial rule is exact id + interrupted => stopped, but logs should distinguish user stop vs. Codex-side interruption.
3. Should older mis-marked `stopped` rows be repaired automatically if transcript later contains completed assistant output? This can be a follow-up once new transitions are stable.
