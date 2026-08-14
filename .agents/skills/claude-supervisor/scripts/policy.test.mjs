import assert from 'node:assert/strict';
import path from 'node:path';
import {
  classifyTool,
  hasChangedCodeQualityEvidence,
  redact,
  requestId,
  requiresCodeQuality,
} from './policy.mjs';

const root = path.resolve('D:\\FiveRealms');
const fixture = (tool_name, tool_input) => ({ session_id: '00000000-0000-4000-8000-000000000000', cwd: root, tool_name, tool_input });

const cases = [
  ['working directory', fixture('Bash', { command: 'pwd' }), 'allow'],
  ['git status', fixture('Bash', { command: 'git status --short' }), 'allow'],
  ['safe pipeline', fixture('Bash', { command: 'node temp/barrier-audit/debug-state.mjs 2>&1 | head -80' }), 'allow'],
  ['awk read', fixture('Bash', { command: "awk 'NR < 20 { print }' AGENTS.md" }), 'allow'],
  ['python read analysis', fixture('Bash', { command: "python -c \"from pathlib import Path; print(Path('AGENTS.md').read_text(encoding='utf-8')[:20])\"" }), 'allow'],
  ['PowerShell read pipeline', fixture('PowerShell', { command: 'Get-Content AGENTS.md | Select-String Git' }), 'allow'],
  ['Git reset through shell', fixture('Bash', { command: 'powershell -Command git reset --hard' }), 'deny'],
  ['Git push', fixture('Bash', { command: 'git push origin deepseek-fixes' }), 'deny'],
  ['SSH key read', fixture('Read', { file_path: 'C:\\Users\\lelexia\\.ssh\\id_ed25519' }), 'deny'],
  ['network request', fixture('Bash', { command: 'curl https://example.com' }), 'review'],
  ['package install', fixture('Bash', { command: 'npm install example' }), 'review'],
  ['complex PowerShell', fixture('PowerShell', { command: 'Get-ChildItem | ForEach-Object { $_.FullName }' }), 'review'],
  ['new source file', fixture('Write', { file_path: path.join(root, 'js', 'new-worker-file.js'), content: '' }), 'review'],
  ['existing source edit', fixture('Edit', { file_path: path.join(root, 'package.json'), old_string: 'x', new_string: 'y' }), 'allow'],
  ['recursive repository delete', fixture('PowerShell', { command: 'Remove-Item -Recurse -Force D:\\FiveRealms' }), 'deny'],
  ['temp delete', fixture('PowerShell', { command: 'Remove-Item temp\\debug.mjs' }), 'review'],
];

for (const [name, input, expected] of cases) assert.equal(classifyTool(input, root).risk, expected, name);
const firstId = requestId(cases[0][1]);
assert.equal(firstId, requestId(cases[0][1]), 'request IDs must be stable');
assert.notEqual(firstId, requestId(cases[1][1]), 'different requests need different IDs');
const redacted = redact({ authorization: 'Bearer abc', nested: { api_key: 'secret' }, text: 'token=abcdef' });
assert.equal(redacted.authorization, '<redacted>');
assert.equal(redacted.nested.api_key, '<redacted>');
assert.match(redacted.text, /<redacted>/);
assert.equal(requiresCodeQuality(['docs/architecture/AI_ENGINE.md']), false);
assert.equal(requiresCodeQuality(['js/ai/AiPlanner.js']), true);
assert.equal(hasChangedCodeQualityEvidence(['npm run check:code-quality -- --changed']), true);
assert.equal(hasChangedCodeQualityEvidence(['npm run check:code-quality -- --self-test']), false);
console.log(`policy tests passed: ${cases.length} classifications plus request-id, redaction, and code-quality gate checks`);
