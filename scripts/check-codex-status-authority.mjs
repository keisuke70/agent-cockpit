import { readFileSync } from 'node:fs';
import ts from 'typescript';

function fail(message) {
  console.error(`[codex-status-authority-check] ${message}`);
  process.exitCode = 1;
}

function assertIncludes(file, needle, label) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(needle)) fail(`${label} missing in ${file}`);
}

function assertNotIncludes(file, needle, label) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(needle)) fail(`${label} still present in ${file}`);
}

async function loadAuthorityModule() {
  const source = readFileSync('packages/server/src/ws/codex-status-authority.ts', 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function assertDecision(name, actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) fail(`${name}: expected ${key}=${value}, got ${actual[key]} (${JSON.stringify(actual)})`);
  }
}

assertIncludes('packages/server/src/ws/codex-status-authority.ts', 'reason: "awaiting-start"', 'pending submit-inflight ignore decision');
assertIncludes('packages/server/src/ws/codex-status-authority.ts', 'shouldIgnoreTerminalForDifferentRunningTurn', 'mapped stale terminal running-row guard');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'Do not attach an arbitrary started notification', 'turn/started pending guard');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'Ignoring unmatched Codex terminal turn', 'turn/completed pending guard');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'Ignoring stale terminal for older Codex turn', 'mapped stale terminal guard');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'Restoring running status because a local Codex turn is still running', 'inconsistent session/running-row guard');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'Compaction is not an exact terminal event', 'thread/compacted exact-terminal fence');
assertIncludes('packages/server/src/ws/session-bridge.ts', 'Waiting for exact Codex turn materialization', 'watchdog stale-terminal wait');
assertNotIncludes('packages/server/src/ws/session-bridge.ts', 'localTurnIdForCodexTurn(managed, sessionId, completedTurnId) ?? managed.codexPendingLocalTurnId', 'terminal-to-pending fallback');
assertNotIncludes('packages/server/src/ws/session-bridge.ts', '|| latestTerminal', 'latest-terminal desync shortcut');

const authority = await loadAuthorityModule();
const { decideCodexTerminalTransition, shouldIgnoreTerminalForDifferentRunningTurn } = authority;

assertDecision(
  'pending submit_inflight + stale terminal B',
  decideCodexTerminalTransition({ id: 'local-1', codexSyncStatus: 'submit_inflight', codexTurnId: null }, 'B', 'interrupted'),
  { action: 'ignore', reason: 'awaiting-start' },
);
assertDecision(
  'submitted A + stale terminal B',
  decideCodexTerminalTransition({ id: 'local-1', codexSyncStatus: 'submitted', codexTurnId: 'A' }, 'B', 'completed'),
  { action: 'ignore', reason: 'unmatched-terminal' },
);
assertDecision(
  'submitted A + completed A',
  decideCodexTerminalTransition({ id: 'local-1', codexSyncStatus: 'submitted', codexTurnId: 'A' }, 'A', 'completed'),
  { action: 'apply', sessionStatus: 'idle', turnStatus: 'complete' },
);
assertDecision(
  'submitted A + interrupted A',
  decideCodexTerminalTransition({ id: 'local-1', codexSyncStatus: 'submitted', codexTurnId: 'A' }, 'A', 'interrupted'),
  { action: 'apply', sessionStatus: 'stopped', turnStatus: 'stopped' },
);

if (!shouldIgnoreTerminalForDifferentRunningTurn({ id: 'new-running', codexSyncStatus: 'submit_inflight', codexTurnId: null }, 'old-mapped')) {
  fail('mapped old terminal must be ignored while a newer local row is running');
}
if (shouldIgnoreTerminalForDifferentRunningTurn({ id: 'same-running', codexSyncStatus: 'submitted', codexTurnId: 'A' }, 'same-running')) {
  fail('exact mapped terminal for current running row must be allowed');
}

if (!process.exitCode) console.log('[codex-status-authority-check] ok');
