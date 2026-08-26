---
name: five-realms
description: Work safely on FiveRealms bugs, architecture, tests, and quality gates.
---

# FiveRealms

Use this Skill for repository work in `D:/FiveRealms`. The project documents remain authoritative; this Skill routes the workflow without duplicating them.

## Start

1. Read the user request and `AGENTS.md` completely.
2. Declare the task mode: BUGFIX, ARCHITECTURE/QUALITY, DOCUMENTATION, or BALANCE BOUNDARY. BALANCE BOUNDARY means stopping before any balance run, evaluation, or tuning and leaving it to the project owner.
3. Read `docs/architecture/CODE_STANDARD.md` before code changes. For AI architecture work, also read `docs/architecture/AI_ENGINE.md`. Read `test.md` when tests are added/changed or balance-adjacent work is requested, but treat every Balance command there as owner-only documentation.
4. Confirm `deepseek-fixes` with read-only Git commands and record the initial dirty worktree. Stop on another branch; never switch it.
5. State assumptions, stage boundary, success criteria, and a short verifiable plan.

## Work

- Preserve user changes and make only task-traceable edits.
- Never let Codex, Claude, DeepSeek, another AI, or an automated workflow run Balance/self-play/card-study experiments. Only the project owner may run and interpret them.
- Never adjust, probe, search, or fit balance constants, weights, thresholds, multipliers, utility parameters, or similar values from test or research results. AI may only read and use them as fixed rules.
- Correctness, regression, architecture, and performance tests remain allowed, but they must not be expanded into numerical balance evaluation or tuning advice.
- In BUGFIX mode, follow the direct player/AI legality and settlement chain before changing code.
- In ARCHITECTURE/QUALITY mode, preserve behavior, document source/target ownership, and stop at the authorized migration stage.
- Use Function Header v1 and module headers exactly as defined in `CODE_STANDARD.md` for touched production code.
- Never install dependencies, access unrelated external data, change system/tool configuration, or perform Git writes.
- Keep browser-loaded HTML/CSS/JavaScript/ES Module URLs stable; use `tools/dev-server.py` no-cache headers for local development.

## Verify and report

Run directly relevant non-balance tests, the available non-balance full suite when required, the no-cache server smoke test for browser resource changes, `npm run check:code-quality -- --changed` for production JavaScript changes, final diff inspection, and `git diff --check`. Report that Balance was not run and remains for the project owner. Report only actual results, unverified items, scope, dependency/install status, and Git-write status. Leave commit, push, and merge to the user.
