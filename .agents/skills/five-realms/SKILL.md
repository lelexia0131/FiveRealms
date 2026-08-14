---
name: five-realms
description: Work safely on FiveRealms bugs, architecture, tests, and quality gates.
---

# FiveRealms

Use this Skill for repository work in `D:/FiveRealms`. The project documents remain authoritative; this Skill routes the workflow without duplicating them.

## Start

1. Read the user request and `AGENTS.md` completely.
2. Declare the task mode: BUGFIX, ARCHITECTURE/QUALITY, BALANCE, or DOCUMENTATION.
3. Read `docs/architecture/CODE_STANDARD.md` before code changes. For AI architecture work, also read `docs/architecture/AI_ENGINE.md`. Read `test.md` when tests are added/changed or Balance work is requested.
4. Confirm `deepseek-fixes` with read-only Git commands and record the initial dirty worktree. Stop on another branch; never switch it.
5. State assumptions, stage boundary, success criteria, and a short verifiable plan.

## Work

- Preserve user changes and make only task-traceable edits.
- In BUGFIX mode, follow the direct player/AI legality and settlement chain before changing code.
- In ARCHITECTURE/QUALITY mode, preserve behavior, document source/target ownership, and stop at the authorized migration stage.
- Use Function Header v1 and module headers exactly as defined in `CODE_STANDARD.md` for touched production code.
- Never install dependencies, access unrelated external data, change system/tool configuration, or perform Git writes.
- Update the shared `?build=` identifier only when browser-loaded HTML/CSS/JavaScript/ES Modules change.

## Verify and report

Run directly relevant tests, the available full suite when required, build consistency for browser resource changes, `npm run check:code-quality -- --changed` for production JavaScript changes, final diff inspection, and `git diff --check`. Report only actual results, unverified items, scope, dependency/install status, and Git-write status. Leave commit, push, and merge to the user.
