import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact } from './policy.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDirectory);
const settingsPath = path.join(skillRoot, 'assets', 'settings.json');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const DEFAULT_WORKER_PROFILE = 'flash';

const WORKER_PROFILES = {
  flash: { claudeAlias: 'sonnet', mappedModel: 'deepseek-v4-flash', label: 'Sonnet' },
  pro: { claudeAlias: 'opus', mappedModel: 'deepseek-v4-pro', label: 'Opus' },
};

function normalizeWorkerModel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized !== 'flash' && normalized !== 'pro') {
    throw new Error(`Unknown worker model "${value}". Expected flash or pro.`);
  }
  return normalized;
}

function selectWorkerProfile({ requestedWorkerModel, resume, storedWorkerProfile }) {
  const frozenProfile = storedWorkerProfile || DEFAULT_WORKER_PROFILE;
  if (resume && requestedWorkerModel && requestedWorkerModel !== frozenProfile) {
    throw new Error(`Session is fixed to worker model "${frozenProfile}"; refusing to resume as "${requestedWorkerModel}". Start a new Supervisor session to change the worker model.`);
  }
  return requestedWorkerModel || (resume && frozenProfile) || DEFAULT_WORKER_PROFILE;
}

function resolveWorkerModel(workerModel, provider) {
  const profile = WORKER_PROFILES[workerModel];
  if (!profile) throw new Error(`Unknown worker model "${workerModel}". Expected flash or pro.`);
  const providerKey = workerModel === 'flash' ? 'sonnetModel' : 'opusModel';
  const actual = String(provider?.[providerKey] || '').trim();
  if (actual.toLowerCase() !== profile.mappedModel) {
    throw new Error(`${workerModel === 'flash' ? 'Flash' : 'Pro'} worker requires ${profile.label} → ${profile.mappedModel} mapping, found ${actual || '<missing>'}.`);
  }
  return { workerProfile: workerModel, claudeAlias: profile.claudeAlias, mappedModel: profile.mappedModel };
}

function claudeModelArgs(selection) {
  return ['--model', selection.claudeAlias];
}

function parseWorkerModelArgv(args) {
  let requestedWorkerModel = null;
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--worker-model') {
      if (requestedWorkerModel !== null) throw new Error('--worker-model was specified more than once.');
      const value = args[index + 1];
      if (!value) throw new Error('--worker-model requires a value: flash or pro.');
      requestedWorkerModel = normalizeWorkerModel(value);
      index += 1;
    } else if (arg.startsWith('--worker-model=')) {
      if (requestedWorkerModel !== null) throw new Error('--worker-model was specified more than once.');
      requestedWorkerModel = normalizeWorkerModel(arg.slice('--worker-model='.length));
    } else {
      rest.push(arg);
    }
  }
  return { rest, requestedWorkerModel };
}

function projectRoot() {
  const root = path.resolve(process.cwd());
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  if (branch !== 'deepseek-fixes') fail(`Expected branch deepseek-fixes, found ${branch || '<detached>'}.`);
  return root;
}

function runtimeRoot(root) {
  return path.join(root, '.claude', 'claude-supervisor');
}

function sessionRoot(root, sessionId) {
  return path.join(runtimeRoot(root), 'sessions', sessionId);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function findClaude() {
  const output = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
  const candidate = output.split(/\r?\n/).find((line) => line.trim().toLowerCase().endsWith('.exe'));
  if (!candidate) fail('claude.exe was not found on PATH.');
  return path.resolve(candidate.trim());
}

function findUserSettings(claudePath) {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, '.claude', 'settings.json'));
  let cursor = path.dirname(claudePath);
  while (path.dirname(cursor) !== cursor) {
    candidates.push(path.join(cursor, '.claude', 'settings.json'));
    cursor = path.dirname(cursor);
  }
  return [...new Set(candidates)].find((candidate) => fs.existsSync(candidate));
}

function providerEnvironment(claudePath) {
  const userSettingsPath = findUserSettings(claudePath);
  if (!userSettingsPath) fail('Claude user settings were not found; refusing to fall back to a different provider.');
  const settings = JSON.parse(fs.readFileSync(userSettingsPath, 'utf8'));
  const provider = settings.env || {};
  const baseUrl = String(provider.ANTHROPIC_BASE_URL || '');
  const token = String(provider.ANTHROPIC_AUTH_TOKEN || provider.ANTHROPIC_API_KEY || '');
  const sonnetModel = String(provider.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME || '');
  const opusModel = String(provider.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME || '');
  let parsed;
  try { parsed = new URL(baseUrl); } catch { fail('Claude provider base URL is missing or invalid.'); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) fail('Claude provider is not the expected local CCSwitch endpoint.');
  if (!token) fail('Claude provider token is missing; refusing to change authentication.');
  return {
    env: { ...process.env, ...Object.fromEntries(Object.entries(provider).map(([key, value]) => [key, String(value)])) },
    summary: { settingsPath: userSettingsPath, baseUrl: `${parsed.protocol}//${parsed.host}`, sonnetModel, opusModel },
  };
}

function statusSnapshot(root) {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  const entries = {};
  for (const item of output.split('\0').filter(Boolean)) {
    const status = item.slice(0, 2);
    const name = item.slice(3).split(' -> ').at(-1);
    const filePath = path.join(root, name);
    let hash = '<missing>';
    try {
      const stat = fs.statSync(filePath);
      hash = stat.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : '<directory>';
    } catch {}
    entries[name.replaceAll('\\', '/')] = { status, hash };
  }
  return entries;
}

function changedSinceBaseline(root, sessionId) {
  const baselinePath = path.join(sessionRoot(root, sessionId), 'baseline.json');
  if (!fs.existsSync(baselinePath)) return [];
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const current = statusSnapshot(root);
  const names = new Set([...Object.keys(baseline.status || {}), ...Object.keys(current)]);
  return [...names].filter((name) => JSON.stringify(baseline.status?.[name]) !== JSON.stringify(current[name])).sort();
}

function writeBaseline(root, sessionId) {
  const directory = sessionRoot(root, sessionId);
  ensureDirectory(directory);
  const baseline = {
    createdAt: new Date().toISOString(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    status: statusSnapshot(root),
  };
  fs.writeFileSync(path.join(directory, 'baseline.json'), JSON.stringify(baseline, null, 2), 'utf8');
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify({
    sessionId, createdAt: baseline.createdAt, iterations: 0, stopBlocks: 0, maxStopBlocks: 2,
  }, null, 2), 'utf8');
}

function appendLog(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(redact(value))}\n`, 'utf8');
}

const TEST_COMMAND = /(?:\bnpm(?:\.cmd)?\s+(?:test|run\s+test(?::\S*)?)|\bnode(?:\.exe)?\s+(?:\.\/)?tests\/)/i;

function hookDecision(value) {
  let parsed;
  try { parsed = JSON.parse(String(value.output || value.stdout || '')); } catch { return null; }
  const spec = parsed && parsed.hookSpecificOutput;
  if (!spec) return null;
  const tool = value.hook_name || value.hook_event || 'hook';
  const idMatch = /\(([0-9a-f]{16})\)/.exec(String(value.output || value.stdout || ''));
  const id = idMatch ? idMatch[1] : '';
  if (spec.hookEventName === 'PreToolUse') {
    if (spec.permissionDecision === 'ask') return { kind: 'pending', tool, id, detail: String(spec.permissionDecisionReason || 'review required').slice(0, 120) };
    if (spec.permissionDecision === 'deny') return { kind: 'deny', tool, id, detail: String(spec.permissionDecisionReason || 'denied').slice(0, 160) };
    return null;
  }
  if (spec.hookEventName === 'PermissionRequest' && spec.decision && spec.decision.behavior === 'deny') {
    const message = String(spec.decision.message || 'denied');
    return /Supervisor review required/i.test(message)
      ? { kind: 'pending', tool, id, detail: message.slice(0, 120) }
      : { kind: 'deny', tool, id, detail: message.slice(0, 160) };
  }
  return null;
}

function handleStreamEvent(value, summary) {
  if (value.type === 'system' && value.subtype === 'init') {
    if (value.model) summary.reportedModel = String(value.model);
    process.stdout.write(`[claude:init] session=${value.session_id || '?'} model=${value.model || '?'}\n`);
  }
  if (value.type === 'system' && value.subtype === 'hook_response') {
    const decision = hookDecision(value);
    if (decision) {
      const seen = decision.kind === 'pending' ? summary.pendingIds : summary.deniedIds;
      if (decision.id) {
        if (seen.has(decision.id)) return;
        seen.add(decision.id);
      }
      process.stdout.write(`[claude:${decision.kind}] ${decision.tool}${decision.id ? ` id=${decision.id}` : ''} ${decision.detail}\n`);
    }
  }
  if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
    for (const block of value.message.content) {
      if (block.type !== 'tool_use') continue;
      summary.toolCounts[block.name] = (summary.toolCounts[block.name] || 0) + 1;
      const command = String(block.input?.command || '');
      if (['Bash', 'PowerShell'].includes(block.name) && TEST_COMMAND.test(command.replaceAll('\\', '/'))) summary.testCommandCount += 1;
    }
  }
  if (value.type === 'result') {
    const parts = [`[claude:result] subtype=${value.subtype || '?'} stop_reason=${value.stop_reason || '?'} error=${Boolean(value.is_error)}`];
    if (typeof value.duration_ms === 'number') parts.push(`duration=${Math.round(value.duration_ms / 1000)}s`);
    process.stdout.write(`${parts.join(' ')}\n`);
  }
}

function readTail(filePath, maxBytes) {
  const size = Math.min(fs.statSync(filePath).size, maxBytes);
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, size, fs.statSync(filePath).size - size);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function extractReport(streamPath) {
  if (!fs.existsSync(streamPath)) return null;
  const tail = readTail(streamPath, 2 * 1024 * 1024);
  const newline = tail.indexOf('\n');
  const lines = (newline >= 0 ? tail.slice(newline + 1) : tail).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('[supervisor-report]')) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === 'result' && typeof value.result === 'string' && value.result.includes('[supervisor-report]')) {
        return value.result.slice(value.result.indexOf('[supervisor-report]')).trim();
      }
      if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
        const text = value.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        if (text.includes('[supervisor-report]')) return text.slice(text.indexOf('[supervisor-report]')).trim();
      }
    } catch {}
  }
  return null;
}

const REPORT_SECTIONS = ['root cause', 'changed files', 'tests', 'unverified', 'scope'];

function stripHeadingMarkers(line) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^(?:[-*]\s*)+/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^\*\*+/, '')
    .trim();
}

function headingRemainder(line) {
  const stripped = stripHeadingMarkers(line);
  const colonIndex = stripped.search(/[:：]/);
  if (colonIndex < 0) return '';
  return stripped.slice(colonIndex + 1).replace(/^\*+\s*/, '').replace(/\*+\s*$/, '').trim();
}

function sectionHeading(line) {
  const stripped = stripHeadingMarkers(line);
  const looksMarked = /^[#*\-0-9]/.test(String(line).trim());
  for (const label of REPORT_SECTIONS) {
    if (!stripped.toLowerCase().startsWith(label)) continue;
    const rest = stripped.slice(label.length).replace(/^[\s*]+/, '');
    if (!rest) return label;
    if (/^[:：（(/]/.test(rest)) return label;
    const colonIndex = rest.search(/[:：]/);
    if (colonIndex >= 0 && colonIndex <= 40) return label;
    if (looksMarked && rest.length <= 40) return label;
  }
  return null;
}

function compactReport(reportText, reportPath) {
  const sections = new Map();
  let current = null;
  for (const raw of String(reportText || '').split(/\r?\n/)) {
    const heading = sectionHeading(raw);
    if (heading) {
      current = heading;
      sections.set(heading, []);
      const remainder = headingRemainder(raw);
      if (remainder) sections.get(heading).push(remainder);
      continue;
    }
    if (current) sections.get(current).push(raw);
  }
  const lines = [`[supervisor:report] saved=${reportPath} chars=${String(reportText || '').length}`];
  for (const label of REPORT_SECTIONS) {
    const body = (sections.get(label) || []).join(' ').replace(/\s+/g, ' ').trim();
    lines.push(`${label}: ${body ? body.slice(0, 180) : '<not stated>'}`);
  }
  return lines.join('\n');
}

function listPending(root, sessionId) {
  const directory = path.join(sessionRoot(root, sessionId), 'pending');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      return { id: String(value.requestId || name.replace(/\.json$/, '')), toolName: String(value.toolName || '?'), reason: String(value.reason || '').slice(0, 120) };
    } catch {
      return { id: name.replace(/\.json$/, ''), toolName: '?', reason: '<unreadable>' };
    }
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/*
 * 功能：构造 FiveRealms Worker 每一轮都必须遵守的固定监督提示。
 * 调用方：runClaude。
 * 输入：无。
 * 输出：传给 Claude Code --append-system-prompt 的字符串。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：Array.join。
 * 边界与不变量：不得覆盖用户任务；必须保留任务模式、阶段边界、权限和 Git 禁令。
 */
function workerSystemPrompt() {
  return [
    'You are the Claude Code worker for FiveRealms. Codex is the Supervisor and final authority.',
    'Read and obey D:/FiveRealms/AGENTS.md. Determine and state BUGFIX, ARCHITECTURE/QUALITY, BALANCE, or DOCUMENTATION mode before changing files.',
    'Read docs/architecture/CODE_STANDARD.md before code changes. For AI architecture work, also read docs/architecture/AI_ENGINE.md. Read test.md when tests are added/changed or Balance work is requested.',
    'Stay on branch deepseek-fixes. Never run Git write operations, install/update dependencies, change provider/authentication, or access unrelated files outside D:/FiveRealms.',
    'Preserve every change that existed before this session. Make only the minimum task-related edits.',
    'If a tool call is denied, do not work around the policy. Explain the denied request and wait for a supervised resume when necessary.',
    'Before finishing a code change, run directly relevant tests, the available full test entry when required, git diff, and git diff --check. Run npm run check:code-quality -- --changed for production JavaScript changes. Handle the shared browser build id when browser-loaded assets change.',
    'Finish with a section headed [supervisor-report] containing: task mode/stage, root cause or architecture finding, changed files, tests with actual results, unverified items, and scope confirmation.',
  ].join('\n');
}

async function runClaude(root, sessionId, prompt, resume, requestedWorkerModel) {
  const claudePath = findClaude();
  const provider = providerEnvironment(claudePath);
  const directory = sessionRoot(root, sessionId);
  const claudeConfigDirectory = path.join(runtimeRoot(root), 'claude-config');
  ensureDirectory(directory);
  ensureDirectory(claudeConfigDirectory);
  const statePath = path.join(directory, 'session.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.iterations >= 4) fail('Supervisor resume limit reached (4 Claude turns). Review manually before continuing.');

  const workerProfile = selectWorkerProfile({
    requestedWorkerModel,
    resume,
    storedWorkerProfile: state.workerProfile,
  });
  const selection = resolveWorkerModel(workerProfile, provider.summary);
  state.workerProfile = selection.workerProfile;
  state.claudeAlias = selection.claudeAlias;
  state.mappedModel = selection.mappedModel;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

  const summary = { toolCounts: {}, testCommandCount: 0, deniedIds: new Set(), pendingIds: new Set(), reportedModel: null };
  const startedAt = Date.now();
  const defaulted = !requestedWorkerModel && !resume;
  process.stdout.write(`[supervisor] session=${sessionId} mode=${resume ? 'resume' : 'start'} provider=${provider.summary.baseUrl} workerProfile=${selection.workerProfile} claudeAlias=${selection.claudeAlias} mappedModel=${selection.mappedModel}${defaulted ? ' default=true' : ''}\n`);
  const args = [
    '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--no-chrome', '--settings', settingsPath, '--setting-sources', 'project,local',
    '--permission-mode', 'default', ...claudeModelArgs(selection), '--append-system-prompt', workerSystemPrompt(),
  ];
  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  args.push(prompt);
  const streamPath = path.join(directory, 'stream.redacted.jsonl');
  const child = spawn(claudePath, args, {
    cwd: root,
    env: {
      ...provider.env,
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      CLAUDE_SUPERVISOR_SESSION_ID: sessionId,
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      try {
        const value = redact(JSON.parse(line));
        appendLog(streamPath, value);
        handleStreamEvent(value, summary);
      } catch {
        appendLog(streamPath, { type: 'unparsed', text: redact(line) });
      }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (stdoutBuffer.trim()) {
    try {
      const value = redact(JSON.parse(stdoutBuffer));
      appendLog(streamPath, value);
      handleStreamEvent(value, summary);
    } catch {
      appendLog(streamPath, { type: 'unparsed', text: redact(stdoutBuffer) });
    }
  }
  if (stderr.trim()) appendLog(path.join(directory, 'errors.redacted.jsonl'), { at: new Date().toISOString(), stderr: redact(stderr) });
  state.iterations += 1;
  state.lastExitCode = exitCode;
  state.lastRunAt = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  const changed = changedSinceBaseline(root, sessionId);
  const pendingItems = listPending(root, sessionId);
  const report = extractReport(streamPath);
  const reportPath = report ? path.join(directory, 'report.txt') : null;
  if (reportPath) fs.writeFileSync(reportPath, report, 'utf8');
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({
    sessionId, runAt: new Date().toISOString(), iterations: state.iterations, exitCode,
    durationMs: Date.now() - startedAt,
    workerProfile: selection.workerProfile,
    claudeAlias: selection.claudeAlias,
    mappedModel: selection.mappedModel,
    reportedModel: summary.reportedModel || null,
    toolCounts: summary.toolCounts, testCommandCount: summary.testCommandCount,
    deniedCount: summary.deniedIds.size, pendingStreamCount: summary.pendingIds.size,
    pendingCount: pendingItems.length,
    reportChars: report ? report.length : 0,
  }, null, 2), 'utf8');
  process.stdout.write(`[supervisor] exit=${exitCode} changedSinceBaseline=${JSON.stringify(changed)}\n`);
  const toolSummary = Object.entries(summary.toolCounts).map(([name, count]) => `${name}=${count}`).join(' ');
  if (toolSummary) process.stdout.write(`[supervisor] tools: ${toolSummary}\n`);
  process.stdout.write(`[supervisor] tests: ${summary.testCommandCount} commands denied: ${summary.deniedIds.size} pending: ${summary.pendingIds.size}\n`);
  for (const item of pendingItems) process.stdout.write(`[supervisor] pending ${item.id} ${item.toolName}: ${item.reason}\n`);
  if (reportPath) process.stdout.write(`${compactReport(report, path.basename(reportPath))}\n`);
  if (stderr.trim()) process.stdout.write('[supervisor] stderr was captured in a redacted local log.\n');
  process.exitCode = Number(exitCode || 0);
}

function readRequiredFile(filePath, label) {
  if (!filePath) fail(`${label} file path is required.`);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) fail(`${label} file does not exist: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8');
}

function printPending(root, sessionId) {
  const directory = path.join(sessionRoot(root, sessionId), 'pending');
  const items = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
  if (!items.length) return process.stdout.write('No pending Supervisor requests.\n');
  for (const name of items) process.stdout.write(`${fs.readFileSync(path.join(directory, name), 'utf8')}\n`);
}

function printStatus(root, sessionId) {
  const directory = sessionRoot(root, sessionId);
  const statePath = path.join(directory, 'session.json');
  if (!fs.existsSync(statePath)) fail(`Session ${sessionId} does not exist.`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  process.stdout.write(`session: ${sessionId}\n`);
  process.stdout.write(`iterations: ${state.iterations || 0} stopBlocks: ${state.stopBlocks || 0}/${state.maxStopBlocks || 2}\n`);
  process.stdout.write(`workerProfile: ${state.workerProfile || 'flash'}\n`);
  process.stdout.write(`claudeAlias: ${state.claudeAlias || 'sonnet'}\n`);
  process.stdout.write(`mappedModel: ${state.mappedModel || 'deepseek-v4-flash'}\n`);
  if (state.lastRunAt) process.stdout.write(`lastRun: ${state.lastRunAt} exit=${state.lastExitCode ?? '?'}\n`);
  process.stdout.write(`changedSinceBaseline: ${JSON.stringify(changedSinceBaseline(root, sessionId))}\n`);
  const summaryPath = path.join(directory, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const toolSummary = Object.entries(summary.toolCounts || {}).map(([name, count]) => `${name}=${count}`).join(' ');
    if (toolSummary) process.stdout.write(`tools: ${toolSummary}\n`);
    const pendingTotal = summary.pendingStreamCount ?? summary.pendingCount ?? 0;
    process.stdout.write(`tests: ${summary.testCommandCount || 0} commands denied: ${summary.deniedCount || 0} pending: ${pendingTotal}\n`);
    if (summary.reportedModel) process.stdout.write(`reportedModel: ${summary.reportedModel}\n`);
  }
  const reportPath = path.join(directory, 'report.txt');
  process.stdout.write(fs.existsSync(reportPath)
    ? `report: ${reportPath} chars=${fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')).reportChars ?? fs.statSync(reportPath).size : fs.statSync(reportPath).size}\n`
    : 'report: <not saved>\n');
  const pendingItems = listPending(root, sessionId);
  if (pendingItems.length) {
    process.stdout.write('pending requests:\n');
    for (const item of pendingItems) process.stdout.write(`  ${item.id} ${item.toolName}: ${item.reason}\n`);
  } else {
    process.stdout.write('pending: none\n');
  }
}

function printReport(root, sessionId) {
  const reportPath = path.join(sessionRoot(root, sessionId), 'report.txt');
  if (!fs.existsSync(reportPath)) fail(`No saved supervisor-report for session ${sessionId}.`);
  const text = fs.readFileSync(reportPath, 'utf8');
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function printTail(root, sessionId, count) {
  const streamPath = path.join(sessionRoot(root, sessionId), 'stream.redacted.jsonl');
  if (!fs.existsSync(streamPath)) fail(`No stream log for session ${sessionId}.`);
  const limit = Math.max(1, Math.min(parseInt(count, 10) || 20, 200));
  const lines = fs.readFileSync(streamPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
  for (const line of lines) process.stdout.write(`${line.slice(0, 4000)}\n`);
}

function approve(root, sessionId, id) {
  const pending = path.join(sessionRoot(root, sessionId), 'pending', `${id}.json`);
  if (!fs.existsSync(pending)) fail(`Pending request ${id} was not found for session ${sessionId}.`);
  const value = JSON.parse(fs.readFileSync(pending, 'utf8'));
  const approval = path.join(sessionRoot(root, sessionId), 'approvals', `${id}.json`);
  ensureDirectory(path.dirname(approval));
  fs.writeFileSync(approval, JSON.stringify({
    requestId: id, sessionId, approvedAt: new Date().toISOString(), singleUse: true,
  }, null, 2), 'utf8');
  fs.unlinkSync(pending);
  process.stdout.write(`Created one-time approval ${id} for ${value.toolName}. Resume the same session and instruct Claude to retry exactly that request.\n`);
}

async function main() {
  let parsed;
  try {
    parsed = parseWorkerModelArgv(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const { rest, requestedWorkerModel } = parsed;
  const [command, first, second] = rest;
  const root = projectRoot();

  if (command === 'start') {
    const prompt = readRequiredFile(first, 'Task');
    const sessionId = crypto.randomUUID();
    writeBaseline(root, sessionId);
    await runClaude(root, sessionId, prompt, false, requestedWorkerModel);
  } else if (command === 'resume') {
    if (!first) fail('Session ID is required.');
    const prompt = readRequiredFile(second, 'Correction prompt');
    await runClaude(root, first, prompt, true, requestedWorkerModel);
  } else {
    if (requestedWorkerModel) fail('--worker-model is only valid for start and resume.');
    if (command === 'pending') {
      if (!first) fail('Session ID is required.');
      printPending(root, first);
    } else if (command === 'approve') {
      if (!first || !second) fail('Session ID and request ID are required.');
      approve(root, first, second);
    } else if (command === 'status') {
      if (!first) fail('Session ID is required.');
      printStatus(root, first);
    } else if (command === 'report') {
      if (!first) fail('Session ID is required.');
      printReport(root, first);
    } else if (command === 'tail') {
      if (!first) fail('Session ID is required.');
      printTail(root, first, second);
    } else {
      fail('Usage: node supervisor.mjs start <task-file> [--worker-model flash|pro] | resume <session-id> <prompt-file> [--worker-model flash|pro] | pending <session-id> | approve <session-id> <request-id> | status <session-id> | report <session-id> | tail <session-id> [count]');
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => fail(error.message));
}

export {
  claudeModelArgs,
  DEFAULT_WORKER_PROFILE,
  normalizeWorkerModel,
  parseWorkerModelArgv,
  resolveWorkerModel,
  selectWorkerProfile,
  workerSystemPrompt,
};
