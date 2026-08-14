import assert from 'node:assert/strict';
import {
  claudeModelArgs,
  normalizeWorkerModel,
  parseWorkerModelArgv,
  resolveWorkerModel,
  selectWorkerProfile,
  workerSystemPrompt,
} from './supervisor.mjs';

const provider = {
  baseUrl: 'http://127.0.0.1:15721',
  sonnetModel: 'deepseek-v4-flash',
  opusModel: 'deepseek-v4-pro',
};

const flash = resolveWorkerModel('flash', provider);
assert.deepEqual(flash, { workerProfile: 'flash', claudeAlias: 'sonnet', mappedModel: 'deepseek-v4-flash' });
assert.deepEqual(claudeModelArgs(flash), ['--model', 'sonnet']);
assert.notDeepEqual(claudeModelArgs(flash), ['--model', 'opus']);
assert.ok(!claudeModelArgs(flash).includes('opus'));

const pro = resolveWorkerModel('pro', provider);
assert.deepEqual(pro, { workerProfile: 'pro', claudeAlias: 'opus', mappedModel: 'deepseek-v4-pro' });
assert.deepEqual(claudeModelArgs(pro), ['--model', 'opus']);

assert.throws(
  () => resolveWorkerModel('flash', { ...provider, sonnetModel: 'claude-sonnet-4' }),
  /Flash worker requires Sonnet/,
);
assert.throws(
  () => resolveWorkerModel('pro', { ...provider, opusModel: 'claude-opus-4' }),
  /Pro worker requires Opus/,
);

assert.equal(selectWorkerProfile({ requestedWorkerModel: null, resume: false, storedWorkerProfile: null }), 'flash');
assert.equal(selectWorkerProfile({ requestedWorkerModel: null, resume: true, storedWorkerProfile: 'pro' }), 'pro');
assert.equal(selectWorkerProfile({ requestedWorkerModel: 'pro', resume: true, storedWorkerProfile: 'pro' }), 'pro');
assert.equal(selectWorkerProfile({ requestedWorkerModel: null, resume: true, storedWorkerProfile: 'flash' }), 'flash');
assert.equal(selectWorkerProfile({ requestedWorkerModel: null, resume: true, storedWorkerProfile: null }), 'flash');
assert.throws(
  () => selectWorkerProfile({ requestedWorkerModel: 'pro', resume: true, storedWorkerProfile: 'flash' }),
  /refusing to resume/,
);
assert.throws(
  () => selectWorkerProfile({ requestedWorkerModel: 'pro', resume: true, storedWorkerProfile: null }),
  /refusing to resume/,
);

assert.deepEqual(parseWorkerModelArgv(['start', 'task.txt', '--worker-model', 'pro']), {
  rest: ['start', 'task.txt'],
  requestedWorkerModel: 'pro',
});
assert.deepEqual(parseWorkerModelArgv(['start', 'task.txt']), {
  rest: ['start', 'task.txt'],
  requestedWorkerModel: null,
});
assert.equal(normalizeWorkerModel('PRO'), 'pro');
assert.throws(() => normalizeWorkerModel('opus'), /Unknown worker model/);

const workerPrompt = workerSystemPrompt();
assert.match(workerPrompt, /ARCHITECTURE\/QUALITY/);
assert.match(workerPrompt, /docs\/architecture\/CODE_STANDARD\.md/);
assert.match(workerPrompt, /docs\/architecture\/AI_ENGINE\.md/);
assert.match(workerPrompt, /check:code-quality -- --changed/);

console.log('supervisor tests passed: model mapping, guards, resume freeze, CLI parsing, task modes, architecture docs, and quality gate prompt');
