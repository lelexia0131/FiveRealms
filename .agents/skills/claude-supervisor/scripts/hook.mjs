import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyTool,
  hasChangedCodeQualityEvidence,
  redact,
  requestId,
  requiresCodeQuality,
} from './policy.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

function sessionRoot(projectRoot, sessionId) {
  return path.join(projectRoot, '.claude', 'claude-supervisor', 'sessions', sessionId);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function appendJsonLine(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(redact(value))}\n`, 'utf8');
}

function approvalPath(projectRoot, sessionId, id) {
  return path.join(sessionRoot(projectRoot, sessionId), 'approvals', `${id}.json`);
}

function pendingPath(projectRoot, sessionId, id) {
  return path.join(sessionRoot(projectRoot, sessionId), 'pending', `${id}.json`);
}

function approvalExists(projectRoot, input, id) {
  const filePath = approvalPath(projectRoot, input.session_id, id);
  if (!fs.existsSync(filePath)) return false;
  try {
    const approval = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return approval.requestId === id && approval.sessionId === input.session_id;
  } catch {
    return false;
  }
}

function consumeApproval(projectRoot, input, id) {
  if (!approvalExists(projectRoot, input, id)) return false;
  fs.unlinkSync(approvalPath(projectRoot, input.session_id, id));
  return true;
}

function recordPending(projectRoot, input, classification, id) {
  const filePath = pendingPath(projectRoot, input.session_id, id);
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(redact({
    requestId: id,
    sessionId: input.session_id,
    createdAt: new Date().toISOString(),
    toolName: input.tool_name,
    toolInput: input.tool_input,
    reason: classification.reason,
  }), null, 2), 'utf8');
}

function statusSnapshot(projectRoot) {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const entries = {};
  for (const item of output.split('\0').filter(Boolean)) {
    const status = item.slice(0, 2);
    const name = item.slice(3).split(' -> ').at(-1);
    const filePath = path.join(projectRoot, name);
    let hash = '<missing>';
    try {
      const stat = fs.statSync(filePath);
      hash = stat.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : '<directory>';
    } catch {}
    entries[name.replaceAll('\\', '/')] = { status, hash };
  }
  return entries;
}

function changedSinceBaseline(projectRoot, sessionId) {
  const baselinePath = path.join(sessionRoot(projectRoot, sessionId), 'baseline.json');
  if (!fs.existsSync(baselinePath)) return [];
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const current = statusSnapshot(projectRoot);
  const names = new Set([...Object.keys(baseline.status || {}), ...Object.keys(current)]);
  return [...names].filter((name) => JSON.stringify(baseline.status?.[name]) !== JSON.stringify(current[name])).sort();
}

function evidence(projectRoot, sessionId) {
  const logPath = path.join(sessionRoot(projectRoot, sessionId), 'hooks.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      if (event.event !== 'PostToolUse' || !['Bash', 'PowerShell'].includes(event.toolName)) return [];
      return [String(event.command || '')];
    } catch {
      return [];
    }
  });
}

/*
 * 功能：在 Worker 停止前核对 diff、测试、质量门禁和结构化报告证据。
 * 调用方：Claude Code Stop hook 入口。
 * 输入：项目根目录与 Stop hook 输入。
 * 输出：证据齐全返回 null，否则返回最多两次的阻止决定。
 * 读取状态：session baseline、hook evidence、当前 Git 工作区。
 * 写入状态：session.json 的 stopBlocks 与 hooks.jsonl。
 * 调用函数：changedSinceBaseline、evidence、requiresCodeQuality。
 * 边界与不变量：只做机械门禁；不替代 Supervisor 的语义验收，也不执行 Git 写操作。
 */
function handleStop(projectRoot, input) {
  const statePath = path.join(sessionRoot(projectRoot, input.session_id), 'session.json');
  let state = { stopBlocks: 0, maxStopBlocks: 2 };
  if (fs.existsSync(statePath)) state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  if (input.stop_hook_active || state.stopBlocks >= state.maxStopBlocks) {
    appendJsonLine(path.join(sessionRoot(projectRoot, input.session_id), 'hooks.jsonl'), {
      at: new Date().toISOString(), event: 'Stop', allowedByLoopGuard: true,
    });
    return null;
  }
  const changed = changedSinceBaseline(projectRoot, input.session_id);
  if (!changed.length) return null;
  const commands = evidence(projectRoot, input.session_id);
  const missing = [];
  if (!commands.some((command) => /\bgit\s+diff(?:\s|$)/i.test(command))) missing.push('inspect the final git diff');
  if (!commands.some((command) => /\bgit\s+diff\s+--check(?:\s|$)/i.test(command))) missing.push('run git diff --check');
  if (!commands.some((command) => /(?:\bnpm(?:\.cmd)?\s+(?:test|run\s+test(?::\S*)?)|\bnode(?:\.exe)?\s+(?:\.\/)?tests\/)/i.test(command.replaceAll('\\', '/')))) {
    missing.push('run a directly relevant existing test');
  }
  if (requiresCodeQuality(changed) && !hasChangedCodeQualityEvidence(commands)) {
    missing.push('run npm run check:code-quality -- --changed for production JavaScript changes');
  }
  if (!/\[supervisor-report\]/i.test(String(input.last_assistant_message || ''))) {
    missing.push('finish with [supervisor-report] and list root cause, changed files, tests, and unverified items');
  }
  if (!missing.length) return null;
  state.stopBlocks += 1;
  ensureDirectory(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  return {
    decision: 'block',
    reason: `Supervisor completion gate: ${missing.join('; ')}. Changed since baseline: ${changed.join(', ')}. Do not perform Git writes.`,
  };
}

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.stderr.write('Invalid hook JSON input.\n');
  process.exit(2);
}

const projectRoot = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const eventName = input.hook_event_name;
const logPath = path.join(sessionRoot(projectRoot, input.session_id || 'unknown'), 'hooks.jsonl');

if (eventName === 'PreToolUse' || eventName === 'PermissionRequest') {
  const classification = classifyTool(input, projectRoot);
  const id = requestId(input);
  appendJsonLine(logPath, {
    at: new Date().toISOString(), event: eventName, requestId: id,
    toolName: input.tool_name, toolInput: input.tool_input, classification,
  });
  const approved = classification.risk === 'review' && approvalExists(projectRoot, input, id);
  if (approved) {
    if (eventName === 'PermissionRequest') consumeApproval(projectRoot, input, id);
    if (eventName === 'PreToolUse') {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'allow',
        permissionDecisionReason: `One-time Supervisor approval ${id}.`,
      }}));
    } else {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'allow' },
      }}));
    }
  } else if (classification.risk === 'allow') {
    if (eventName === 'PreToolUse') {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'allow',
        permissionDecisionReason: classification.reason,
      }}));
    } else {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'allow' },
      }}));
    }
  } else if (classification.risk === 'deny') {
    if (eventName === 'PreToolUse') {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: classification.reason,
      }}));
    } else {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: classification.reason, interrupt: false },
      }}));
    }
  } else if (eventName === 'PreToolUse') {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `Supervisor review required (${id}): ${classification.reason}`,
    }}));
  } else {
    recordPending(projectRoot, input, classification, id);
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny', interrupt: false,
        message: `Supervisor review required (${id}): ${classification.reason} Do not work around this denial; report it and wait for a supervised resume.`,
      },
    }}));
  }
} else if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
  consumeApproval(projectRoot, input, requestId(input));
  const responseText = input.tool_response === undefined ? undefined : JSON.stringify(redact(input.tool_response)).slice(0, 2000);
  appendJsonLine(logPath, {
    at: new Date().toISOString(), event: eventName, toolName: input.tool_name,
    command: input.tool_input?.command,
    filePath: input.tool_input?.file_path || input.tool_input?.path,
    responseSummary: responseText,
    error: input.error,
  });
} else if (eventName === 'Stop') {
  const decision = handleStop(projectRoot, input);
  appendJsonLine(logPath, {
    at: new Date().toISOString(), event: 'Stop', blocked: Boolean(decision),
    stopHookActive: Boolean(input.stop_hook_active),
  });
  if (decision) console.log(JSON.stringify(decision));
}
