#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function assertIncludes(file, needle, label = needle) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(needle)) {
    console.error(`[codex-sync-check] missing ${label} in ${file}`);
    process.exitCode = 1;
  }
}

assertIncludes('packages/server/src/db.ts', 'codex_sync_status', 'turn sync column');
assertIncludes('packages/server/src/db.ts', 'idx_turns_session_codex_turn', 'unique codex turn index');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'localTurnId: string,\n  content: string', 'startCodexTurn localTurnId parameter');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'verifyCodexTurnMaterialized', 'materialization verifier');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'ensureCodexThreadReadyForTurn', 'pre-turn thread resume');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'persistExtendedHistory: true', 'extended Codex history persistence');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'markTurnDesynced', 'desync marker');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'retryDesyncedTurn', 'targeted retry handler');
assertIncludes('packages/server/src/routes/realtime.ts', 'codexRealtimeState = "starting"', 'server-side realtime state');
assertIncludes('packages/shared/src/protocol.ts', 'retry_desynced_turn', 'retry protocol');
assertIncludes('packages/web/src/components/StreamOutput.tsx', 'Saved locally, not confirmed in Codex.', 'desync UI warning');

if (process.exitCode) process.exit(process.exitCode);
console.log('[codex-sync-check] ok');
