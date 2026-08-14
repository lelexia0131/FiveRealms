---
name: claude-supervisor
description: Delegate FiveRealms coding tasks to the local Claude Code CLI while Codex supervises safety, progress, corrections, resume turns, tests, and final acceptance. Use when the user says to hand a FiveRealms bug or implementation task to Claude Code, asks Codex to supervise Claude/DeepSeek, or invokes $claude-supervisor. Do not use for ordinary Codex-only work or for Git publishing.
---

# Claude Supervisor

Use the deterministic runner in `scripts/supervisor.mjs`. Keep Codex as the decision-maker and final reviewer; Claude Code is only the worker.

## Start a task

1. Read the user request and `AGENTS.md`, determine the task mode, and state assumptions and success criteria. Read `test.md` for test organization or Balance work. Read `docs/architecture/CODE_STANDARD.md` before code changes and `docs/architecture/AI_ENGINE.md` for AI architecture work.
2. Confirm branch `deepseek-fixes` and record the current dirty worktree. Treat all pre-existing changes as user-owned.
3. Put only the worker task text in an ignored file under `.claude/claude-supervisor/tasks/`.
4. Run `node .agents/skills/claude-supervisor/scripts/supervisor.mjs start <task-file> [--worker-model flash|pro]`.
5. Capture the printed session ID. The runner refuses a non-`deepseek-fixes` branch, uses the existing CCSwitch provider mapping, and never falls back to another login.

## Worker model

The Supervisor always controls which Claude Code alias the Worker uses. It never changes Codex's own model or any global Claude configuration.

- `flash` -> Claude alias `sonnet` -> upstream `deepseek-v4-flash`
- `pro` -> Claude alias `opus` -> upstream `deepseek-v4-pro`

Start a Flash Worker (also the default when no model is specified):

```
node .agents/skills/claude-supervisor/scripts/supervisor.mjs start <task-file> --worker-model flash
```

Start a Pro Worker:

```
node .agents/skills/claude-supervisor/scripts/supervisor.mjs start <task-file> --worker-model pro
```

When the user explicitly asks for Flash, DS Flash, DeepSeek Flash, or V4 Flash, or says to let Flash / CC use Flash, pass `--worker-model flash`. When they explicitly ask for Pro, DS Pro, DeepSeek Pro, or V4 Pro, or say to let Pro / CC use Pro, pass `--worker-model pro`. If the user does not specify a model, use `flash`; do not silently upgrade based on task complexity or Codex's own model.

Each Supervisor session freezes its Worker profile in `session.json`. A resume keeps that profile; a mismatched `--worker-model` on resume is refused, and changing the model requires a new session.

## Review and resume

Follow detail on demand, not detail by default: do not consume Claude's full stream. The runner saves the complete redacted stream locally and prints only compact Supervisor events. Normally read only:

- the Supervisor compact result (exit code, changed files, tool/test/pending counts, compact report)
- the saved final report via `report <session-id>`
- pending review requests via `pending <session-id>`
- the repository diff and the test evidence actually needed for acceptance

Read `stream.redacted.jsonl` under `.claude/claude-supervisor/sessions/<session-id>/` only on demand: when Claude failed, the report is contradictory, you suspect the root cause, test evidence is insufficient, a permission dispute needs context, or a resume needs prior context. Use `tail <session-id> [count]` for the most recent events.

Use `node .agents/skills/claude-supervisor/scripts/supervisor.mjs status <session-id>` for compact state. Runtime state is under `.claude/claude-supervisor/sessions/<session-id>/` and is ignored by Git.

Write a focused correction prompt under `.claude/claude-supervisor/tasks/`, then run `node .agents/skills/claude-supervisor/scripts/supervisor.mjs resume <session-id> <correction-file>`. The runner permits at most four total Claude turns. A correction must preserve the original task mode and stage boundary unless the user explicitly changes them.

## Decide a review-class request

The hook writes uncertain requests to `pending/` and denies the first attempt. Never approve Git writes, dependency installation, provider/authentication changes, forbidden network access, secret access, uploads, or task-scope expansion.

Only when the exact request is safe and authorized, run `node .agents/skills/claude-supervisor/scripts/supervisor.mjs approve <session-id> <request-id>`, then resume with an instruction to retry exactly that request. Approval is bound to the session and exact tool input, and is consumed on use.

## Finish

Independently verify what matters: the compact result and saved report, files changed since the runner baseline, necessary key source lines, actual test results, architecture stage boundaries, and the original user request. Do not re-read everything Claude already read; dig into the full stream or logs only when evidence is missing or contradictory. Run required tests and Git read-only checks yourself. For production JavaScript changes, require `npm run check:code-quality -- --changed`. Do not commit, stage, push, restore, reset, clean, stash, switch, merge, or rebase. Report actual evidence and unverified items.

The Stop hook performs only mechanical checks and can block at most twice. It does not replace Codex's semantic acceptance review.

