---
name: five-realms
description: Work safely on FiveRealms bugs, architecture, tests, and quality gates.
---

# FiveRealms

Use this Skill for repository work in `D:/FiveRealms`. The project documents remain authoritative; this Skill routes the workflow without duplicating them.

## Start

1. Read the user request and `AGENTS.md` completely.
2. Declare the task mode: BUGFIX, ARCHITECTURE/QUALITY, DOCUMENTATION, or BALANCE BOUNDARY. BALANCE BOUNDARY means stopping before autonomous balance evaluation or tuning, or before any Balance run not explicitly authorized by the project owner in the current task. A mechanical numeric edit does not trigger this boundary when the owner explicitly identifies the parameter and its old and new values.
3. Read `docs/architecture/CODE_STANDARD.md` before code changes. For AI architecture work, also read `docs/architecture/AI_ENGINE.md`. Read `test.md` when tests are added/changed or balance-adjacent work is requested, but do not execute any Balance command there unless the project owner explicitly authorizes it in the current task.
4. Confirm `deepseek-fixes` with read-only Git commands and record the initial dirty worktree. Stop on another branch; never switch it.
5. State assumptions, stage boundary, success criteria, and a short verifiable plan.

## Work

- Preserve user changes and make only task-traceable edits.
- Never autonomously run Balance/self-play/card-study experiments. Run them only when the project owner explicitly authorizes that run in the current task; authorization for a numeric edit does not authorize a Balance run.
- Never autonomously decide, probe, optimize, suggest, search, or fit balance constants, weights, thresholds, multipliers, utility parameters, or similar values from test or research results.
- When the project owner explicitly identifies a parameter and its old and new values in the current task, mechanically apply only that owner-authorized numeric edit without triggering BALANCE BOUNDARY. Do not expand the scope, alter formulas, or adjust adjacent parameters.
- Correctness, regression, architecture, and performance tests remain allowed, but they must not be expanded into numerical balance evaluation or tuning advice.
- In BUGFIX mode, follow the direct player/AI legality and settlement chain before changing code.
- In ARCHITECTURE/QUALITY mode, preserve behavior, document source/target ownership, and stop at the authorized migration stage.
- Use Function Header v1 and module headers exactly as defined in `CODE_STANDARD.md` for touched production code.
- Never install dependencies, access unrelated external data, change system/tool configuration, or perform Git writes.
- Keep browser-loaded HTML/CSS/JavaScript/ES Module URLs stable; use `tools/dev-server.py` no-cache headers for local development.

## Verify and report

Run directly relevant non-balance tests, the available non-balance full suite when required, the no-cache server smoke test for browser resource changes, `npm run check:code-quality -- --changed` for production JavaScript changes, final diff inspection, and `git diff --check`. Run Balance only when the project owner explicitly authorizes it in the current task. Report whether Balance was authorized and whether it actually ran, along with actual results, unverified items, scope, dependency/install status, and Git-write status. Leave commit, push, and merge to the user.
