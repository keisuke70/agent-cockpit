import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const usage = `Usage: node .agents/scripts/run-codex-review.mjs <plan|impl> <session-key> [--fresh]

Reads the review prompt from stdin and runs Codex review with persisted resume state.

The session-key is required and is treated as the canonical resume key.`;

const reviewType = process.argv[2];
if (!reviewType || ['-h', '--help'].includes(reviewType)) {
  console.log(usage);
  process.exit(reviewType ? 0 : 2);
}

if (!['plan', 'impl'].includes(reviewType)) {
  console.error(`Unknown review type: ${reviewType}`);
  console.error(usage);
  process.exit(2);
}

const extraArgs = process.argv.slice(3);
const freshOnly = extraArgs.includes('--fresh');
const rawSessionKey = extraArgs.find((arg) => !arg.startsWith('-')) ?? '';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = path.resolve(scriptDir, '..');
const projectRepoRoot = path.resolve(scriptDir, '..', '..');
const repoRoot =
  existsSync(path.join(sourceRepoRoot, 'sync.sh')) && existsSync(path.join(sourceRepoRoot, 'skills'))
    ? sourceRepoRoot
    : projectRepoRoot;
const stateDir = path.join(repoRoot, '.agents', 'state');
const schemaCandidates = [
  path.join(scriptDir, 'review-schema.json'),
  path.join(repoRoot, 'skills', 'core', 'review-schema.json'),
];
const model = process.env.CODEX_REVIEW_MODEL?.trim() || null;
const reasoningEffort = process.env.CODEX_REVIEW_REASONING_EFFORT?.trim() || null;
const timeoutSeconds = Number.parseInt(
  process.env.CODEX_REVIEW_TIMEOUT_SECONDS ?? '300',
  10,
);
const concurrentWaitSeconds = Number.parseInt(
  process.env.CODEX_REVIEW_CONCURRENT_WAIT_SECONDS ?? '5',
  10,
);
const debugDir = process.env.CODEX_REVIEW_DEBUG_DIR
  ? path.resolve(process.env.CODEX_REVIEW_DEBUG_DIR)
  : null;

function compact(text, limit = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 3)}...`
    : normalized;
}

function sanitizeSessionKey(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || reviewType;
}

function requireSessionKey(value) {
  const normalized = sanitizeSessionKey(value);
  if (!value || !normalized) {
    throw new Error(`A stable session-key is required for ${reviewType} review.`);
  }
  return normalized;
}

function resolveSchemaPath() {
  const resolved = schemaCandidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error('Review schema file not found.');
  }
  return resolved;
}

function resolveCodexCommand() {
  const pathEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((value) => value.toLowerCase())
      : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `codex${extension}`);
      if (existsSync(candidate)) return candidate;
    }

    const directPath = path.join(entry, 'codex');
    if (existsSync(directPath)) return directPath;
  }

  throw new Error(
    'codex command not found in PATH. Install Codex CLI or run this from an environment where codex is available.',
  );
}

function spawnCodexProcess(commandPath, args) {
  const baseOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)) {
    const commandLine = [commandPath, ...args]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(' ');
    return spawn(commandLine, {
      ...baseOptions,
      shell: true,
    });
  }

  return spawn(commandPath, args, baseOptions);
}

function summarizeEvent(payload) {
  if (payload.type === 'thread.started') {
    return payload.thread_id
      ? `[run-codex-review] thread started: ${payload.thread_id}`
      : '[run-codex-review] thread started';
  }
  if (payload.type === 'turn.started') return '[run-codex-review] turn started';

  const item = payload.item;
  if (!item || typeof item !== 'object') return null;

  if (payload.type === 'item.started') {
    if (item.type === 'command_execution') {
      return `[run-codex-review] command started: ${compact(String(item.command ?? ''))}`;
    }
    return `[run-codex-review] ${item.type ?? 'item'} started`;
  }

  if (payload.type === 'item.completed') {
    if (item.type === 'command_execution') {
      return `[run-codex-review] command completed (exit ${item.exit_code ?? '?'})`;
    }
    if (item.type === 'agent_message') {
      return `[run-codex-review] agent message: ${compact(String(item.text ?? ''))}`;
    }
    return `[run-codex-review] ${item.type ?? 'item'} completed`;
  }

  return null;
}

function looksResettable(text) {
  return [
    /session .*not found/i,
    /unknown session/i,
    /invalid session/i,
    /failed to load session/i,
    /unable to resume/i,
    /could not resume/i,
  ].some((pattern) => pattern.test(text));
}

function validateStructuredOutput(data, schema) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

  const required = new Set(schema.required ?? []);
  const keys = Object.keys(data);
  if (keys.length !== required.size || keys.some((key) => !required.has(key))) {
    return false;
  }

  if (!schema.properties?.verdict?.enum?.includes(data.verdict)) return false;
  if (typeof data.summary !== 'string') return false;
  if (typeof data.confidence !== 'number' || Number.isNaN(data.confidence)) return false;

  const confidenceSchema = schema.properties?.confidence ?? {};
  if (data.confidence < (confidenceSchema.minimum ?? -Infinity)) return false;
  if (data.confidence > (confidenceSchema.maximum ?? Infinity)) return false;

  if (!Array.isArray(data.issues)) return false;

  const issueSchema = schema.properties?.issues?.items ?? {};
  const issueRequired = new Set(issueSchema.required ?? []);
  for (const issue of data.issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return false;
    const issueKeys = Object.keys(issue);
    if (
      issueKeys.length !== issueRequired.size ||
      issueKeys.some((key) => !issueRequired.has(key))
    ) {
      return false;
    }
    if (!issueSchema.properties?.severity?.enum?.includes(issue.severity)) return false;
    for (const key of issueRequired) {
      if (key !== 'severity' && typeof issue[key] !== 'string') return false;
    }
  }

  return true;
}

async function saveDebugFile(filePath, content) {
  if (!debugDir) return;
  await fs.mkdir(debugDir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function isEventLine(line) {
  return line.trim().startsWith('{') && line.includes('"type"');
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatPreviousIssues(previousPayload) {
  if (!previousPayload?.issues?.length) return '- No prior issues were recorded.';
  return previousPayload.issues
    .map(
      (issue, index) =>
        `${index + 1}. [${issue.severity}] ${issue.location}: ${issue.problem}`,
    )
    .join('\n');
}

function formatScopeDelta(scopeDelta) {
  if (!scopeDelta) return '- No scoped file changes were captured.';
  const lines = [];
  const pushGroup = (label, values) => {
    if (!values.length) return;
    lines.push(`- ${label}: ${values.join(', ')}`);
  };
  pushGroup('Changed files', scopeDelta.changed ?? []);
  pushGroup('New files', scopeDelta.added ?? []);
  pushGroup('Removed files', scopeDelta.removed ?? []);
  return lines.length > 0 ? lines.join('\n') : '- No scoped file changes detected.';
}

function extractSectionBlock(promptText, header) {
  const lines = promptText.split(/\r?\n/);
  const headerLine = `${header}:`;
  const startIndex = lines.findIndex((line) => line.trim() === headerLine);
  if (startIndex === -1) return '';

  const collected = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed && /^[A-Za-z][\w -]*:$/.test(trimmed)) break;
    collected.push(line);
  }
  return collected.join('\n').trim();
}

function normalizeAdjudicationBlock(promptText) {
  const block = extractSectionBlock(promptText, 'Parent-Adjudication');
  if (!block) return '';
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
  return lines.join('\n');
}

function buildResumePrompt(
  promptText,
  previousPayload = null,
  scopeDelta = null,
  adjudicationBlock = '',
) {
  const priorVerdictBlock = previousPayload
    ? `Previous review verdict:
${JSON.stringify(previousPayload)}

Previous issues:
${formatPreviousIssues(previousPayload)}

Scoped file changes since that verdict:
${formatScopeDelta(scopeDelta)}

Parent adjudication for the previous issues:
${adjudicationBlock || '- No parent adjudication was provided.'}

Re-review instructions:
- Re-evaluate the current files, not the prior verdict.
- Treat previous issues as claims to verify, not defaults to repeat.
- Treat the parent adjudication as authoritative about which issues were accepted, rejected, or deferred.
- Only repeat a previous issue if it still exists in the current files.
- Keep any new findings inside the same scoped files.`
    : '';

  return `Return only a JSON object with this exact shape:
{"verdict":"APPROVED"|"NEEDS_CHANGES","confidence":0..1,"summary":"string","issues":[{"severity":"critical"|"major"|"minor","location":"string","problem":"string","suggestion":"string"}]}

Do not include markdown fences or any prose before/after the JSON.

${priorVerdictBlock}

${promptText}`;
}

function buildCanonicalPrompt(promptText, sessionKey) {
  const header = `Session-Key: ${sessionKey}`;
  const scopeGuard = `Review scope rules:
- Treat files explicitly listed in the prompt as the primary scope.
- Read only the minimum adjacent files needed to verify a claim.
- Do not broaden into repo-wide exploration unless the prompt explicitly asks for it.
- Decision Records and plan files must be limited to the paths named in the prompt.
- If the provided scope is insufficient, say so in the JSON summary instead of guessing from unrelated files.`;
  if (/^\s*Session-Key\s*:/im.test(promptText)) {
    return promptText.replace(/^\s*Session-Key\s*:\s*.*$/im, `${header}\n${scopeGuard}`);
  }
  return `${header}\n${scopeGuard}\n\n${promptText.trimStart()}`;
}

function unique(values) {
  return [...new Set(values)];
}

function extractScopedFilePaths(promptText) {
  const matches = promptText.match(
    /(?:\/[^\s:)]+|(?:\.[A-Za-z0-9_./-]+|[A-Za-z0-9_./-]+)\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sh|yml|yaml))/g,
  ) ?? [];
  const filePaths = [];
  for (const match of matches) {
    const cleaned = match.replace(/[),.:;]+$/g, '');
    const candidate = path.isAbsolute(cleaned) ? cleaned : path.resolve(repoRoot, cleaned);
    if (existsSync(candidate)) {
      filePaths.push(path.normalize(candidate));
    }
  }
  return unique(filePaths);
}

async function hashFile(filePath) {
  const content = await fs.readFile(filePath);
  return createHash('sha1').update(content).digest('hex');
}

async function snapshotScopedFiles(filePaths) {
  const snapshots = {};
  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      snapshots[filePath] = {
        sha1: await hashFile(filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch {}
  }
  return snapshots;
}

function diffScopedSnapshots(previousSnapshots = {}, currentSnapshots = {}) {
  const previousPaths = new Set(Object.keys(previousSnapshots));
  const currentPaths = new Set(Object.keys(currentSnapshots));
  const changed = [];
  const unchanged = [];
  const added = [];
  const removed = [];

  for (const filePath of currentPaths) {
    if (!previousPaths.has(filePath)) {
      added.push(filePath);
      continue;
    }
    if (previousSnapshots[filePath]?.sha1 === currentSnapshots[filePath]?.sha1) {
      unchanged.push(filePath);
    } else {
      changed.push(filePath);
    }
  }

  for (const filePath of previousPaths) {
    if (!currentPaths.has(filePath)) {
      removed.push(filePath);
    }
  }

  return { changed, unchanged, added, removed };
}

const sessionKey = requireSessionKey(rawSessionKey);
const sessionFile = path.join(stateDir, `codex-${reviewType}-${sessionKey}.session`);
const activeFile = path.join(stateDir, `codex-${reviewType}-${sessionKey}.active.json`);
const runToken = `${Date.now()}-${process.pid}`;

async function runCodex(
  commandPath,
  schemaPath,
  promptText,
  sessionId = null,
  previousPayload = null,
  scopeDelta = null,
  adjudicationBlock = '',
) {
  const args = [
    '-a',
    'never',
    '-C',
    repoRoot,
    'exec',
  ];

  if (model) {
    args.splice(args.indexOf('exec'), 0, '-m', model);
  }

  if (reasoningEffort) {
    args.splice(args.indexOf('exec'), 0, '-c', `model_reasoning_effort="${reasoningEffort}"`);
  }

  if (sessionId) {
    args.push('resume', '--json', sessionId, '-');
  } else {
    args.push('--json', '--output-schema', schemaPath, '-');
  }

  const child = spawnCodexProcess(commandPath, args);
  child.stdin.end(
    sessionId
      ? buildResumePrompt(promptText, previousPayload, scopeDelta, adjudicationBlock)
      : promptText,
  );

  const chunks = [];
  let lastSummary = '[run-codex-review] waiting for first event';

  const heartbeat = setInterval(() => {
    process.stderr.write(`[run-codex-review] still running; last event: ${lastSummary}\n`);
  }, 15000);

  const timeout = setTimeout(() => {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }

    child.kill('SIGKILL');
  }, timeoutSeconds * 1000);

  const onChunk = (buffer) => {
    const text = buffer.toString();
    chunks.push(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line);
        const summary = summarizeEvent(payload);
        if (payload.type === 'thread.started' && typeof payload.thread_id === 'string') {
          void fs.writeFile(sessionFile, `${payload.thread_id}\n`, 'utf8');
          void writeJsonFile(activeFile, {
            pid: process.pid,
            reviewType,
            sessionKey,
            runToken,
            threadId: payload.thread_id,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        if (summary) {
          lastSummary = summary;
          process.stderr.write(`${summary}\n`);
        }
      } catch {
        lastSummary = `[run-codex-review] non-json output observed: ${compact(line)}`;
        process.stderr.write(`${lastSummary}\n`);
      }
    }
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  clearInterval(heartbeat);
  clearTimeout(timeout);

  return {
    exitCode: exitCode ?? 1,
    logText: chunks.join(''),
  };
}

function extractThreadId(logText) {
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      if (payload.type === 'thread.started' && typeof payload.thread_id === 'string') {
        return payload.thread_id;
      }
    } catch {}
  }
  return '';
}

function extractLastAgentMessage(logText) {
  let lastText = '';
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      if (
        payload.type === 'item.completed' &&
        payload.item?.type === 'agent_message' &&
        typeof payload.item.text === 'string'
      ) {
        lastText = payload.item.text;
      }
    } catch {}
  }
  return lastText;
}

function extractStructuredOutput(logText, schema) {
  const candidates = [];
  const lastAgentMessage = extractLastAgentMessage(logText);
  if (lastAgentMessage) {
    candidates.push(lastAgentMessage);
  }

  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (isEventLine(line)) continue;
    candidates.push(line);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (validateStructuredOutput(parsed, schema)) {
        return { parsed, message: candidate };
      }
    } catch {}
  }

  return { parsed: null, message: lastAgentMessage };
}

async function emitFailureSummary(context, logText, sessionKeyForLog) {
  const patterns = [
    ['rate-limit', /rate limit|429|quota/i],
    ['capacity', /capacity/i],
    ['network', /ENOTFOUND|EAI_AGAIN|Temporary failure in name resolution|Could not resolve host|Name or service not known|network is unreachable/i],
    ['session', /session .*not found|unknown session|invalid session|failed to load session|unable to resume|could not resume/i],
    ['timeout', /timed out after \d+s/i],
    ['local-config', /command not found|schema file not found|structured json/i],
  ];
  const matchedPattern = patterns.find(([, pattern]) => pattern.test(logText));
  const category = matchedPattern?.[0] ?? 'unknown';
  process.stderr.write(`[run-codex-review] ${context} (${category})\n`);

  const candidateLines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isEventLine(line));
  const preferredLines = matchedPattern
    ? candidateLines.filter((line) => matchedPattern[1].test(line))
    : [];
  const detailLines = (preferredLines.length > 0 ? preferredLines : candidateLines).slice(-2);
  for (const line of detailLines) {
    process.stderr.write(`[run-codex-review] detail: ${compact(line, 160)}\n`);
  }

  if (debugDir) {
    process.stderr.write(
      `[run-codex-review] raw log saved to ${path.join(debugDir, `${reviewType}-${sessionKeyForLog}-log.jsonl`)}\n`,
    );
  }
}

const promptText = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(chunks.join('')));
  process.stdin.on('error', reject);
});

if (!promptText.trim()) {
  console.error('Review prompt must be provided on stdin.');
  process.exit(2);
}

const schemaPath = resolveSchemaPath();
await fs.access(schemaPath);
await fs.mkdir(stateDir, { recursive: true });

const canonicalPromptText = buildCanonicalPrompt(promptText, sessionKey);
const resultFile = path.join(stateDir, `codex-${reviewType}-${sessionKey}.result.json`);
const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
const codexCommand = resolveCodexCommand();
const scopedFiles = extractScopedFilePaths(promptText);
const scopedSnapshots = await snapshotScopedFiles(scopedFiles);
const parentAdjudication = normalizeAdjudicationBlock(promptText);

await saveDebugFile(
  path.join(debugDir ?? stateDir, `${reviewType}-${sessionKey}-prompt.txt`),
  canonicalPromptText,
);

async function finalizeRun(result) {
  const threadId = extractThreadId(result.logText);
  if (threadId) {
    await fs.writeFile(sessionFile, `${threadId}\n`, 'utf8');
  }

  const { parsed, message } = extractStructuredOutput(result.logText, schema);
  await saveDebugFile(
    path.join(debugDir ?? stateDir, `${reviewType}-${sessionKey}-log.jsonl`),
    result.logText,
  );
  await saveDebugFile(
    path.join(debugDir ?? stateDir, `${reviewType}-${sessionKey}-message.txt`),
    message ?? '',
  );

  return parsed;
}

async function waitForExistingResult() {
  const deadline = Date.now() + concurrentWaitSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const currentActive = await readJsonFile(activeFile);
      const existingResult = await readJsonFile(resultFile);
      if (
        existingResult?.status === 'completed' &&
        existingResult.payload &&
        existingResult.runToken &&
        existingResult.runToken === currentActive.runToken
      ) {
        process.stdout.write(`${JSON.stringify(existingResult.payload)}\n`);
        return true;
      }
      if (
        existingResult?.status === 'failed' &&
        existingResult.runToken &&
        existingResult.runToken === currentActive.runToken
      ) {
        process.stderr.write(
          `[run-codex-review] previous run failed: ${existingResult.context ?? 'review failed'}\n`,
        );
        return false;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function claimActiveRun() {
  try {
    const current = await readJsonFile(activeFile);
    if (isPidRunning(current.pid)) {
      process.stderr.write(
        `[run-codex-review] review already running for ${reviewType}/${sessionKey} (pid ${current.pid})\n`,
      );
      if (current.threadId) {
        await fs.writeFile(sessionFile, `${current.threadId}\n`, 'utf8');
        process.stderr.write(`[run-codex-review] active thread: ${current.threadId}\n`);
      }
      const reused = await waitForExistingResult();
      if (reused) {
        process.exit(0);
      }
      process.stderr.write(
        '[run-codex-review] wait for the active run to finish, then re-run with the same session-key\n',
      );
      process.exit(4);
    }
    await fs.rm(activeFile, { force: true });
  } catch {}

  let threadId = '';
  try {
    threadId = (await fs.readFile(sessionFile, 'utf8')).trim();
  } catch {}

  await writeJsonFile(activeFile, {
    pid: process.pid,
    reviewType,
    sessionKey,
    runToken,
    threadId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function recordResult(status, payload = {}) {
  let activeState = null;
  try {
    activeState = await readJsonFile(activeFile);
  } catch {}
  let threadId = activeState?.threadId ?? '';
  if (!threadId) {
    try {
      threadId = (await fs.readFile(sessionFile, 'utf8')).trim();
    } catch {}
  }

  await writeJsonFile(resultFile, {
    status,
    completedAt: new Date().toISOString(),
    threadId,
    runToken: activeState?.runToken ?? runToken,
    prompt: canonicalPromptText,
    scopedFiles,
    scopedSnapshots,
    parentAdjudication,
    ...payload,
  });
}

async function runFresh() {
  const result = await runCodex(codexCommand, schemaPath, canonicalPromptText);
  const parsed = await finalizeRun(result);
  if (result.exitCode === 0 && parsed) {
    await recordResult('completed', { payload: parsed });
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
    return true;
  }
  await fs.rm(sessionFile, { force: true });
  await recordResult('failed', {
    context: 'fresh review failed; inspect the saved log for details',
  });
  await emitFailureSummary('fresh review failed; inspect the saved log for details', result.logText, sessionKey);
  return false;
}

await claimActiveRun();

try {
  let previousResult = null;
  try {
    previousResult = await readJsonFile(resultFile);
  } catch {}
  const previousPayload = previousResult?.status === 'completed' ? previousResult.payload : null;
  const previousSnapshots = previousResult?.scopedSnapshots ?? {};
  const previousAdjudication = parentAdjudication;
  const scopeDelta = diffScopedSnapshots(previousSnapshots, scopedSnapshots);
  const shouldResume = !freshOnly;

  if (shouldResume) {
    try {
      const sessionId = (await fs.readFile(sessionFile, 'utf8')).trim();
      if (sessionId) {
        const result = await runCodex(
          codexCommand,
          schemaPath,
          canonicalPromptText,
          sessionId,
          previousPayload,
          scopeDelta,
          previousAdjudication,
        );
        const parsed = await finalizeRun(result);
        if (result.exitCode === 0 && parsed) {
          await recordResult('completed', { payload: parsed });
          process.stdout.write(`${JSON.stringify(parsed)}\n`);
          process.exit(0);
        }
        if (looksResettable(result.logText)) {
          await fs.rm(sessionFile, { force: true });
          if (await runFresh()) {
            process.exit(0);
          }
          process.exit(1);
        }

        if (!parsed) {
          await recordResult('failed', {
            context: 'resume returned non-structured output; keep the same session-key and retry',
          });
          await emitFailureSummary(
            'resume returned non-structured output; inspect the saved log and retry the same session-key',
            result.logText,
            sessionKey,
          );
          process.exit(1);
        }

        await recordResult('failed', {
          context: 'resume failed; inspect the saved log for details',
        });
        await emitFailureSummary('resume failed; inspect the saved log for details', result.logText, sessionKey);
        process.exit(1);
      }
    } catch {}
  }

  if (await runFresh()) {
    process.exit(0);
  }
} finally {
  try {
    const current = await readJsonFile(activeFile);
    if (current?.pid === process.pid) {
      await fs.rm(activeFile, { force: true });
    }
  } catch {}
}

process.exit(1);
