import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const READ_ONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'grep', 'blame', 'shortlog', 'rev-parse',
  'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'name-rev', 'describe',
  'merge-base', 'diff-files', 'diff-index', 'diff-tree', 'check-ignore',
  'check-attr', 'count-objects', 'fsck', 'remote', 'reflog', 'tag', 'branch',
]);

const DENIED_GIT = new Set([
  'add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'cherry-pick',
  'revert', 'reset', 'restore', 'checkout', 'switch', 'clean', 'stash',
  'worktree', 'submodule', 'init', 'clone', 'apply', 'am', 'mv', 'rm',
]);

const SAFE_FILTERS = new Set([
  'rg', 'grep', 'awk', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr',
  'diff', 'find', 'pwd',
]);

const SAFE_POWERSHELL = new Set([
  'get-content', 'select-string', 'get-item', 'get-childitem', 'test-path',
  'resolve-path', 'measure-object', 'select-object', 'format-list',
  'format-table', 'out-string',
]);

function result(risk, reason) {
  return { risk, reason };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function requestId(input) {
  const payload = canonical({
    session_id: input.session_id || '',
    tool_name: input.tool_name || '',
    tool_input: input.tool_input || {},
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export function redact(value, key = '') {
  if (/(authorization|token|api[-_]?key|secret|password|cookie)/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1<redacted>')
    .replace(/((?:api[-_]?key|auth[-_]?token|access[-_]?token|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi, '$1<redacted>')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '<redacted-key>');
}

function normalizeRoot(root) {
  return path.resolve(root || process.cwd());
}

function normalizeCandidate(candidate, root) {
  const text = String(candidate || '').trim().replace(/^['"]|['"]$/g, '');
  return path.resolve(root, text || '.');
}

function isWithin(candidate, root) {
  const resolvedRoot = normalizeRoot(root).toLowerCase();
  const resolved = normalizeCandidate(candidate, root).toLowerCase();
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function isSensitive(text) {
  const normalized = String(text || '').replaceAll('\\', '/').toLowerCase();
  return /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube)(\/|$)/.test(normalized)
    || /(^|\/)(\.env(?:\.|$)|credentials?\.json$|secrets?\.json$)/.test(normalized)
    || /(?:id_rsa|id_ed25519|authorization|auth[_-]?token|api[_-]?key)/.test(normalized);
}

function splitShell(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (quote) {
      current += char;
      if (char === quote && command[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      if (current.trim()) parts.push(current.trim());
      parts.push(char + next);
      current = '';
      index += 1;
      continue;
    }
    if (char === '|' || char === ';') {
      if (current.trim()) parts.push(current.trim());
      parts.push(char);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((part) => !['|', '||', '&&', ';'].includes(part));
}

function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote && segment[index - 1] !== '\\') quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) tokens.push(current), current = '';
    } else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandName(token) {
  return path.basename(String(token || '')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

function findGitAction(tokens) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (commandName(tokens[index]) !== 'git') continue;
    const action = String(tokens[index + 1] || '').toLowerCase();
    if (DENIED_GIT.has(action)) return action;
  }
  return null;
}

function classifyGit(tokens) {
  const action = String(tokens[1] || '').toLowerCase();
  if (DENIED_GIT.has(action)) return result('deny', `Git write operation "git ${action}" is forbidden.`);
  if (!READ_ONLY_GIT.has(action)) return result('review', `Unknown or non-read-only Git operation "git ${action}" requires Supervisor review.`);
  if (action === 'branch') {
    const allowed = tokens.slice(2).every((token) => /^(-a|-r|-v|-vv|--list|--show-current|--contains|--merged|--no-merged|--format(?:=.*)?)$/.test(token) || !token.startsWith('-'));
    if (!allowed) return result('review', 'Git branch arguments are not provably read-only.');
  }
  if (action === 'remote' && !['', '-v', 'get-url'].includes(String(tokens[2] || '').toLowerCase())) {
    return result('review', 'Git remote operation is not provably read-only.');
  }
  if (action === 'tag' && tokens.slice(2).some((token) => /^-[dasm]/i.test(token))) return result('deny', 'Git tag mutation is forbidden.');
  return result('allow', `Read-only Git operation "git ${action}".`);
}

function containsOutsideAbsolutePath(tokens, root) {
  for (const token of tokens.slice(1)) {
    const cleaned = token.replace(/^[<>]+/, '');
    if (/^[A-Za-z]:[\\/]/.test(cleaned) && !isWithin(cleaned, root)) return cleaned;
  }
  return null;
}

function classifyPython(tokens, root) {
  const codeIndex = tokens.findIndex((token) => token === '-c');
  if (codeIndex < 0 || !tokens[codeIndex + 1]) return result('review', 'Only bounded Python -c analysis can be auto-approved.');
  const code = tokens[codeIndex + 1];
  if (/(subprocess|os\.(?:system|remove|unlink|rename|replace)|shutil|socket|requests|urllib|httpx|eval\s*\(|exec\s*\(|__import__|write_(?:text|bytes)|\.unlink\s*\(|\.rename\s*\(|\.replace\s*\(|open\s*\([^)]*,\s*['"](?:w|a|x))/i.test(code)) {
    return result('review', 'Python code contains execution, network, or write-capable operations.');
  }
  const drivePaths = code.match(/[A-Za-z]:[\\/][^'"\s)]+/g) || [];
  if (drivePaths.some((candidate) => !isWithin(candidate, root))) return result('deny', 'Python analysis references a path outside FiveRealms.');
  return result('allow', 'Bounded local Python read-only analysis.');
}

function classifyNode(tokens, root) {
  if (tokens.length === 2 && ['--version', '-v'].includes(tokens[1])) return result('allow', 'Node version check.');
  if (tokens[1] === '--check' && tokens[2] && isWithin(tokens[2], root) && !isSensitive(tokens[2])) return result('allow', 'Node syntax check inside FiveRealms.');
  const script = tokens.find((token, index) => index > 0 && !token.startsWith('-'));
  if (!script) return result('review', 'Inline or unbounded Node execution requires Supervisor review.');
  const resolved = normalizeCandidate(script, root);
  const relative = path.relative(normalizeRoot(root), resolved).replaceAll('\\', '/');
  if (!isWithin(resolved, root)) return result('deny', 'Node script is outside FiveRealms.');
  if (relative.startsWith('temp/') || relative.startsWith('tests/')) return result('allow', `Project-local Node script under ${relative.split('/')[0]}/.`);
  return result('review', 'Node script outside tests/ or temp/ requires Supervisor review.');
}

function classifyNpm(tokens) {
  const action = String(tokens[1] || '').toLowerCase();
  if (action === 'test') return result('allow', 'Existing npm test entry.');
  if (action === 'run' && /^test(?::|$)/.test(String(tokens[2] || ''))) return result('allow', 'Existing npm test:* entry.');
  if (['install', 'i', 'ci', 'uninstall', 'remove', 'update', 'publish', 'version', 'exec'].includes(action)) return result('review', `Dependency or package mutation "npm ${action}" requires Supervisor review.`);
  return result('review', `npm ${action || '<none>'} is outside the automatic test allowlist.`);
}

function classifySegment(segment, root) {
  if (/`|\$\(|\b(?:eval|invoke-expression)\b/i.test(segment)) return result('review', 'Shell expansion or dynamic evaluation requires Supervisor review.');
  if (/(^|[^2])>(?!&1)/.test(segment)) return result('review', 'Output redirection requires Supervisor review.');
  const cleaned = segment.replace(/\s+2>&1\s*/g, ' ').trim();
  const tokens = tokenize(cleaned);
  if (!tokens.length) return result('allow', 'Empty shell segment.');
  const deniedGit = findGitAction(tokens);
  if (deniedGit) return result('deny', `Git write operation "git ${deniedGit}" is forbidden, including through wrappers.`);
  if (isSensitive(cleaned)) return result('deny', 'Command references credentials, secrets, or a sensitive path.');
  const outside = containsOutsideAbsolutePath(tokens, root);
  if (outside) return result('review', `Command references path outside FiveRealms: ${outside}`);
  const name = commandName(tokens[0]);
  if (name === 'git') return classifyGit(tokens);
  if (SAFE_FILTERS.has(name)) {
    if (name === 'find' && tokens.some((token) => /^-exec/i.test(token))) return result('review', 'find -exec requires Supervisor review.');
    if (name === 'awk' && /\bsystem\s*\(/i.test(cleaned)) return result('review', 'awk system() requires Supervisor review.');
    return result('allow', `Read-only filter/search command "${name}".`);
  }
  if (name === 'node') return classifyNode(tokens, root);
  if (['python', 'python3', 'py'].includes(name)) return classifyPython(tokens, root);
  if (name === 'npm') return classifyNpm(tokens);
  if (SAFE_POWERSHELL.has(name)) {
    if (/[{}]/.test(cleaned)) return result('review', 'PowerShell script blocks require Supervisor review.');
    return result('allow', `Simple read-only PowerShell command "${name}".`);
  }
  if (['rm', 'rmdir', 'remove-item', 'del', 'erase'].includes(name)) {
    const normalized = cleaned.replaceAll('\\', '/').toLowerCase();
    if (/(-rf|-fr|-recurse).*(fiverealms(?:\/|$)|\/js\/|\/tests\/|\/index\.html)/.test(normalized)) return result('deny', 'Recursive deletion of the repository or formal project files is forbidden.');
    return result('review', 'Deletion requires Supervisor review, including temporary files.');
  }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod'].includes(name)) {
    if (/\s(?:-d|--data|--upload-file|-f|--form|-method\s+(?:post|put|patch))\b/i.test(cleaned)) return result('deny', 'Potential upload or mutating network request is forbidden.');
    return result('review', 'Network access requires Supervisor review.');
  }
  if (['ssh', 'scp', 'sftp', 'rsync'].includes(name)) return result('deny', 'Remote shell or file transfer is forbidden.');
  if (['powershell', 'pwsh', 'cmd', 'bash', 'sh'].includes(name)) return result('review', 'Nested shell execution requires Supervisor review.');
  if (name === 'npx') return result('review', 'npx may download or execute packages and requires Supervisor review.');
  return result('review', `Command "${name}" is not on the deterministic automatic allowlist.`);
}

function classifyCommand(command, root) {
  const text = String(command || '').trim();
  if (!text) return result('review', 'Empty shell command.');
  const segments = splitShell(text);
  let reviewReason = null;
  for (const segment of segments) {
    const classification = classifySegment(segment, root);
    if (classification.risk === 'deny') return classification;
    if (classification.risk === 'review' && !reviewReason) reviewReason = classification.reason;
  }
  return reviewReason ? result('review', reviewReason) : result('allow', 'Every shell segment is deterministically read-only and project-local.');
}

function classifyPathTool(toolName, toolInput, root) {
  const candidate = toolInput.file_path || toolInput.path || toolInput.notebook_path || '';
  if (!candidate) return result('review', `${toolName} has no path that can be verified.`);
  if (isSensitive(candidate)) return result('deny', `${toolName} targets credentials, secrets, or a sensitive path.`);
  if (!isWithin(candidate, root)) return result(toolName === 'Read' ? 'review' : 'deny', `${toolName} targets a path outside FiveRealms.`);
  const resolved = normalizeCandidate(candidate, root);
  const relative = path.relative(normalizeRoot(root), resolved).replaceAll('\\', '/');
  if (relative === '.git' || relative.startsWith('.git/')) return result('deny', `${toolName} targets protected Git metadata.`);
  if (relative.startsWith('.claude/') || relative.startsWith('.agents/skills/claude-supervisor/')) {
    return result(toolName === 'Read' ? 'allow' : 'deny', `${toolName} targets protected Supervisor or Claude configuration.`);
  }
  if (toolName === 'Read') return result('allow', 'Project-local non-sensitive read.');
  if (fs.existsSync(resolved)) return result('allow', 'Edit of an existing project file; task scope remains enforced by Codex review.');
  if (relative.startsWith('tests/') || relative.startsWith('temp/')) return result('allow', 'New test or temporary debug file inside the approved project area.');
  return result('review', 'Creating a new formal project file requires Supervisor review.');
}

export function classifyTool(input, projectRoot = input.cwd || process.cwd()) {
  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  const root = normalizeRoot(projectRoot);
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(toolName)) return classifyPathTool(toolName, toolInput, root);
  if (['Glob', 'Grep'].includes(toolName)) {
    const candidate = toolInput.path || root;
    if (isSensitive(candidate)) return result('deny', `${toolName} targets a sensitive path.`);
    if (!isWithin(candidate, root)) return result('review', `${toolName} targets a path outside FiveRealms.`);
    return result('allow', `Project-local ${toolName.toLowerCase()}.`);
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') return classifyCommand(toolInput.command, root);
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return result('review', 'Network access requires Supervisor review.');
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return result('review', `${toolName} requires Codex mediation in non-interactive mode.`);
  if (toolName === 'Agent') return result('review', 'Worker subagent creation requires Supervisor review.');
  if (toolName.startsWith('mcp__')) return result('review', 'MCP tool use requires Supervisor review unless explicitly approved.');
  return result('review', `Tool "${toolName || '<unknown>'}" is not on the deterministic automatic allowlist.`);
}

/*
 * 功能：判断一次 Worker 改动是否触发生产 JavaScript 质量门禁。
 * 调用方：Stop hook、policy 自测。
 * 输入：相对仓库根目录的变更文件路径数组。
 * 输出：存在 js 目录下 JavaScript/ES Module 变更时返回 true。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：Array.some、String.replaceAll。
 * 边界与不变量：测试、工具和 Supervisor 自身不冒充浏览器生产代码。
 */
export function requiresCodeQuality(changedFiles = []) {
  return changedFiles.some((name) => /^js\/.*\.(?:js|mjs|cjs)$/i.test(String(name).replaceAll('\\', '/')));
}

/*
 * 功能：确认 Worker 的命令证据中已执行 changed 模式代码质量检查。
 * 调用方：Stop hook、policy 自测。
 * 输入：已记录的 Shell 命令字符串数组。
 * 输出：存在受支持的质量检查命令时返回 true。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：Array.some、String.replaceAll。
 * 边界与不变量：必须显式包含 --changed，--all 或 self-test 不能替代本次变更检查。
 */
export function hasChangedCodeQualityEvidence(commands = []) {
  return commands.some((command) => {
    const normalized = String(command).replaceAll('\\', '/');
    return /(?:\bnpm(?:\.cmd)?\s+run\s+check:code-quality\s+--\s+--changed(?:\s|$)|\bnode(?:\.exe)?\s+(?:\.\/)?tools\/check-code-quality\.mjs\s+--changed(?:\s|$))/i.test(normalized);
  });
}
