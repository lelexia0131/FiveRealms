/**
 * Recovery runner for the 7 >3600s metric jobs of the v117 formal study.
 *
 * Split execution, composite-equivalent semantics:
 *   - every control/arm job replays the same seed to the same targetTurn
 *   - takes TrackedRng snapshot + StudyRandom (Math.random / Date.now) snapshot
 *     at the same split point as the original composite runStateJob
 *   - hold arms reproduce the original extra-card serial so card IDs match
 *   - control result is computed once per (state, metric) and shared by arms
 *
 * Usage:
 *   node tools/recovery.js controls [--workers N] [--budget N] [--timeoutMs N]
 *   node tools/recovery.js arms     [--workers N] [--budget N] [--timeoutMs N]
 *   node tools/recovery.js validate --states <validation-list.json> [--workers N]
 */
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { CARD_DEFINITIONS } from "../../../js/domain/definitions/cards/CardDefinitions.js";
import {
  initGame,
  cloneGame,
  runGame,
  structuralFingerprint,
  classifyState,
  addExtraCardToHand,
  takeCardFromDeckToHand,
  drawOneToHand,
  discardCardFromHand,
  setSyntheticCardSerial
} from "../lib/harness.js";
import {
  installJobRandom,
  uninstallJobRandom,
  getStudyRandom
} from "../lib/studyRandom.js";
import { runDirFromEnv, runDirUrl } from "../lib/runPaths.js";

const RUN_BASE = runDirUrl(runDirFromEnv());
const DATA_DIR = RUN_BASE ? new URL("data/", RUN_BASE) : new URL("../data/", import.meta.url);
const RECOVERY_DIR = RUN_BASE ? new URL("recovery/", RUN_BASE) : new URL("../recovery/", import.meta.url);
const ALL_CARD_IDS = Object.keys(CARD_DEFINITIONS);
const WORKERS_DEFAULT = 24;
const NODE_BUDGET_DEFAULT = 1000;
const MAX_ROUNDS_DEFAULT = 250;
const CONTROL_TIMEOUT_DEFAULT = 14400000;
const ARM_TIMEOUT_DEFAULT = 3600000;

const MISSING_JOBS = [
  { metricId: "1381319458:2:acquire", stateId: "1381319458:2", seed: 1381319458, turn: 2, metric: "acquire" },
  { metricId: "2240520505:15:acquire", stateId: "2240520505:15", seed: 2240520505, turn: 15, metric: "acquire" },
  { metricId: "1559427479:2:hold", stateId: "1559427479:2", seed: 1559427479, turn: 2, metric: "hold" },
  { metricId: "1559427479:2:acquire", stateId: "1559427479:2", seed: 1559427479, turn: 2, metric: "acquire" },
  { metricId: "2819038158:2:hold", stateId: "2819038158:2", seed: 2819038158, turn: 2, metric: "hold" },
  { metricId: "2124433950:10:acquire", stateId: "2124433950:10", seed: 2124433950, turn: 10, metric: "acquire" },
  { metricId: "3709616095:1:hold", stateId: "3709616095:1", seed: 3709616095, turn: 1, metric: "hold" }
];

function parseCli(argv) {
  const cli = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        cli[key] = next;
        index += 1;
      } else cli[key] = "1";
    } else {
      cli.positional ??= [];
      cli.positional.push(token);
    }
  }
  return cli;
}

function runPool(workers, jobs, handlerName, {
  jobTimeoutMs = 3600000,
  checkpointEvery = 0,
  collectResults = true,
  onResult = null,
  onFailure = null,
  onCheckpoint = null,
  onJobEnd = null
} = {}) {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    let active = 0;
    let completed = 0;
    const results = [];
    const failures = [];
    const maybeResolve = () => {
      if (cursor < jobs.length || active !== 0) return;
      if (onCheckpoint && (checkpointEvery <= 0 || completed % checkpointEvery !== 0)) {
        onCheckpoint({
          completed,
          active,
          pending: Math.max(0, jobs.length - cursor),
          final: true
        });
      }
      resolve({ results, failures });
    };
    const settleJob = () => {
      completed += 1;
      if (onCheckpoint && checkpointEvery > 0 && completed % checkpointEvery === 0) {
        onCheckpoint({
          completed,
          active,
          pending: Math.max(0, jobs.length - cursor),
          final: false
        });
      }
    };
    const spawn = () => {
      if (cursor >= jobs.length) {
        maybeResolve();
        return;
      }
      const job = jobs[cursor++];
      active += 1;
      const startedAt = performance.now();
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { role: "job-worker", handler: handlerName, job }
      });
      let finished = false;
      const timer = jobTimeoutMs > 0
        ? setTimeout(() => {
          if (finished) return;
          finished = true;
          failures.push({ jobId: job?.jobId, message: "job-timeout" });
          if (onFailure) onFailure({ jobId: job?.jobId, message: "job-timeout" });
          if (onJobEnd) onJobEnd(job, { status: "timeout", wallMs: performance.now() - startedAt });
          worker.terminate().then(() => {
            active -= 1;
            settleJob();
            if (cursor < jobs.length) spawn();
            else maybeResolve();
          });
        }, jobTimeoutMs)
        : null;
      const settle = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
      };
      worker.on("message", (message) => {
        if (finished) return;
        settle();
        if (message?.type === "result") {
          if (collectResults) results.push(message.payload);
          if (onResult) onResult(message.payload);
          if (onJobEnd) onJobEnd(job, {
            status: message.payload?.kind === "ok" || message.payload?.kind === "unavailable" || message.payload?.kind === "not-held"
              ? "completed"
              : "error",
            wallMs: performance.now() - startedAt
          });
        }
        if (message?.type === "error") {
          const failure = message.payload;
          failures.push(failure);
          if (onFailure) onFailure(failure);
          if (onJobEnd) onJobEnd(job, { status: "error", wallMs: performance.now() - startedAt });
        }
        worker.terminate().then(() => {
          active -= 1;
          settleJob();
          if (cursor < jobs.length) spawn();
          else maybeResolve();
        });
      });
      worker.on("error", (error) => {
        if (finished) return;
        settle();
        const failure = { jobId: job?.jobId, message: String(error?.stack ?? error) };
        failures.push(failure);
        if (onFailure) onFailure(failure);
        if (onJobEnd) onJobEnd(job, { status: "error", wallMs: performance.now() - startedAt });
        worker.terminate().then(() => {
          active -= 1;
          settleJob();
          if (cursor < jobs.length) spawn();
          else maybeResolve();
        });
      });
    };
    for (let i = 0; i < Math.min(workers, jobs.length); i += 1) spawn();
  });
}

async function readJson(relativePath, fallback = null) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, DATA_DIR), "utf8"));
  } catch {
    return fallback;
  }
}

async function readRecoveryJson(relativePath, fallback = null) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, RECOVERY_DIR), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeRecoveryJson(relativePath, value) {
  await writeFile(new URL(relativePath, RECOVERY_DIR), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonl(relativePath) {
  try {
    const text = await readFile(new URL(relativePath, DATA_DIR), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function appendJsonl(relativePath, rows, root = DATA_DIR) {
  if (!rows?.length) return;
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await appendFile(new URL(relativePath, root), text, "utf8");
}

async function updateProgress(progress) {
  await writeFile(new URL("progress.json", DATA_DIR), `${JSON.stringify(progress)}\n`, "utf8");
}

async function replayToTurn(job) {
  const { seed, targetTurn, nodeBudget, maxRounds, expectedFingerprint, roleOverride = null } = job;
  const { game, rng } = await initGame({ seed, roleOverride, nodeBudget });
  let found = false;
  await runGame(game, {
    maxRounds,
    onTurnStart: async (g, player, turn) => {
      if (turn === targetTurn) {
        found = true;
        return "stop";
      }
      return null;
    }
  });
  if (!found) {
    game.dispose();
    return { ok: false, reason: "turn-not-found" };
  }
  const fp = structuralFingerprint(game);
  if (JSON.stringify(fp) !== JSON.stringify(expectedFingerprint)) {
    game.dispose();
    return { ok: false, reason: "fingerprint-mismatch" };
  }
  const subject = game.currentPlayer;
  const rngState = rng.snapshot();
  const studyRandom = getStudyRandom();
  const mathState = studyRandom ? studyRandom.snapshot() : null;
  const restoreMath = () => {
    if (mathState !== null && studyRandom) studyRandom.restore(mathState);
  };
  return { ok: true, game, rngState, restoreMath, subject };
}

async function runControl(job) {
  const startedAt = performance.now();
  const replay = await replayToTurn(job);
  if (!replay.ok) {
    return {
      kind: "error",
      metricId: job.metricId,
      stateId: job.stateId,
      metric: job.metric,
      message: replay.reason,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
  const { game, rngState, restoreMath, subject } = replay;
  let result;
  if (job.metric === "acquire") {
    restoreMath();
    const control = cloneGame(game, rngState);
    const controlSubject = control.state.players.find((player) => player.id === subject.id);
    const drawSuccess = await drawOneToHand(control, controlSubject);
    if (!drawSuccess) {
      control.dispose();
      game.dispose();
      return {
        kind: "error",
        metricId: job.metricId,
        stateId: job.stateId,
        metric: job.metric,
        message: "draw-failed",
        durationMs: Math.round(performance.now() - startedAt)
      };
    }
    result = await runGame(control, { maxRounds: job.maxRounds });
    control.dispose();
  } else {
    restoreMath();
    const control = cloneGame(game, rngState);
    result = await runGame(control, { maxRounds: job.maxRounds });
    control.dispose();
  }
  game.dispose();
  return {
    kind: "ok",
    metricId: job.metricId,
    stateId: job.stateId,
    metric: job.metric,
    winnerTeam: result.winnerTeam,
    rounds: result.rounds,
    stalled: result.stalled,
    durationMs: Math.round(performance.now() - startedAt)
  };
}

async function runArm(job) {
  const startedAt = performance.now();
  const replay = await replayToTurn(job);
  if (!replay.ok) {
    return {
      kind: "error",
      metricId: job.metricId,
      stateId: job.stateId,
      metric: job.metric,
      card: job.card,
      message: replay.reason,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
  const { game, rngState, restoreMath, subject } = replay;
  const control = job.control ?? null;
  if (!control) {
    game.dispose();
    return {
      kind: "error",
      metricId: job.metricId,
      stateId: job.stateId,
      metric: job.metric,
      card: job.card,
      message: "control-result-missing",
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
  const base = {
    stateId: job.metricId,
    seed: job.seed,
    sampleType: "composite",
    role: subject.characterId,
    battleTeam: subject.battleTeam,
    round: game.state.currentRound,
    seat: subject.seatIndex,
    classification: classifyState(game, subject)
  };
  const controlWin = control.winnerTeam === subject.battleTeam ? 1 : 0;
  let row = null;

  if (job.metric === "hold") {
    restoreMath();
    setSyntheticCardSerial(job.cardIndex + 1);
    const arm = cloneGame(game, rngState);
    const armSubject = arm.state.players.find((player) => player.id === subject.id);
    addExtraCardToHand(arm, armSubject, job.card);
    const armResult = await runGame(arm, { maxRounds: job.maxRounds });
    arm.dispose();
    row = {
      ...base,
      metric: "hold",
      card: job.card,
      aWin: armResult.winnerTeam === subject.battleTeam ? 1 : 0,
      bWin: controlWin,
      aStalled: armResult.stalled,
      bStalled: control.stalled,
      aRounds: armResult.rounds,
      bRounds: control.rounds
    };
  } else if (job.metric === "acquire") {
    restoreMath();
    const arm = cloneGame(game, rngState);
    const armSubject = arm.state.players.find((player) => player.id === subject.id);
    const taken = takeCardFromDeckToHand(arm, armSubject, job.card);
    if (!taken) {
      arm.dispose();
      game.dispose();
      return {
        kind: "unavailable",
        metricId: job.metricId,
        stateId: job.stateId,
        metric: job.metric,
        card: job.card,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }
    const armResult = await runGame(arm, { maxRounds: job.maxRounds });
    arm.dispose();
    row = {
      ...base,
      metric: "acquire",
      card: job.card,
      aWin: armResult.winnerTeam === subject.battleTeam ? 1 : 0,
      bWin: controlWin,
      aStalled: armResult.stalled,
      bStalled: control.stalled,
      aRounds: armResult.rounds,
      bRounds: control.rounds
    };
  } else if (job.metric === "discard") {
    restoreMath();
    const arm = cloneGame(game, rngState);
    const armSubject = arm.state.players.find((player) => player.id === subject.id);
    const held = armSubject.hand.find((entry) => entry.definitionId === job.card);
    if (!held) {
      arm.dispose();
      game.dispose();
      return {
        kind: "not-held",
        metricId: job.metricId,
        stateId: job.stateId,
        metric: job.metric,
        card: job.card,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }
    await discardCardFromHand(arm, armSubject, held);
    const armResult = await runGame(arm, { maxRounds: job.maxRounds });
    arm.dispose();
    row = {
      ...base,
      metric: "discard",
      card: job.card,
      aWin: controlWin,
      bWin: armResult.winnerTeam === subject.battleTeam ? 1 : 0,
      aStalled: control.stalled,
      bStalled: armResult.stalled,
      aRounds: control.rounds,
      bRounds: armResult.rounds
    };
  }

  game.dispose();
  return {
    kind: "ok",
    metricId: job.metricId,
    stateId: job.stateId,
    metric: job.metric,
    card: job.card,
    row,
    durationMs: Math.round(performance.now() - startedAt)
  };
}

function jobWithFingerprint(job, corpusByKey) {
  const record = corpusByKey.get(job.stateId);
  if (!record) throw new Error(`corpus record missing for ${job.stateId}`);
  return {
    ...job,
    targetTurn: job.turn,
    roleOverride: null,
    expectedFingerprint: record.fingerprint,
    nodeBudget: NODE_BUDGET_DEFAULT,
    maxRounds: MAX_ROUNDS_DEFAULT
  };
}

async function loadCorpusByKey() {
  const records = await readJsonl("corpus-states.jsonl");
  const map = new Map();
  for (const record of records) {
    if (record.roleOverride != null) continue;
    map.set(`${record.seed}:${record.turn}`, record);
  }
  return map;
}

async function phaseControls(config) {
  await mkdir(RECOVERY_DIR, { recursive: true });
  const corpusByKey = await loadCorpusByKey();
  const jobs = MISSING_JOBS.map((job) => ({
    jobId: `control:${job.metricId}`,
    metricId: job.metricId,
    stateId: job.stateId,
    seed: job.seed,
    turn: job.turn,
    metric: job.metric,
    ...jobWithFingerprint(job, corpusByKey)
  }));
  process.stderr.write(`[recovery] controls: ${jobs.length} jobs\n`);
  const { results, failures } = await runPool(config.workers, jobs, "runControl", {
    jobTimeoutMs: config.controlTimeoutMs,
    onJobEnd: (job, info) => {
      appendJsonl("control-runtime.jsonl", [{
        metricId: job.metricId,
        stateId: job.stateId,
        metric: job.metric,
        status: info.status,
        wallMs: Math.round(info.wallMs)
      }], RECOVERY_DIR).catch(() => {});
    }
  });
  const controlMap = {};
  for (const result of results) controlMap[result.metricId] = result;
  for (const failure of failures) {
    controlMap[failure.jobId.replace(/^control:/, "")] = {
      kind: "error",
      message: failure.message
    };
  }
  await writeRecoveryJson("control-results.json", controlMap);
  process.stderr.write(`[recovery] controls done: ok=${results.length} failures=${failures.length}\n`);
  for (const result of results) {
    process.stderr.write(`[recovery] control ${result.metricId} ${result.kind === "ok" ? `winner=${result.winnerTeam} rounds=${result.rounds} stalled=${result.stalled} durationMs=${result.durationMs}` : `error=${result.message}`}\n`);
  }
}

function buildArmJobs(corpusByKey, controlMap) {
  const jobs = [];
  for (const job of MISSING_JOBS) {
    const control = controlMap[job.metricId];
    if (!control || control.kind !== "ok") {
      throw new Error(`control result missing for ${job.metricId}`);
    }
    const controlRef = { winnerTeam: control.winnerTeam, rounds: control.rounds, stalled: control.stalled };
    if (job.metric === "hold") {
      ALL_CARD_IDS.forEach((card, cardIndex) => {
        jobs.push({
          ...jobWithFingerprint(job, corpusByKey),
          jobId: `${job.metricId}:${card}:hold`,
          metricId: job.metricId,
          stateId: job.stateId,
          seed: job.seed,
          turn: job.turn,
          metric: "hold",
          card,
          cardIndex,
          control: controlRef
        });
      });
      ALL_CARD_IDS.forEach((card) => {
        jobs.push({
          ...jobWithFingerprint(job, corpusByKey),
          jobId: `${job.metricId}:${card}:discard`,
          metricId: job.metricId,
          stateId: job.stateId,
          seed: job.seed,
          turn: job.turn,
          metric: "discard",
          card,
          control: controlRef
        });
      });
    } else {
      ALL_CARD_IDS.forEach((card) => {
        jobs.push({
          ...jobWithFingerprint(job, corpusByKey),
          jobId: `${job.metricId}:${card}:acquire`,
          metricId: job.metricId,
          stateId: job.stateId,
          seed: job.seed,
          turn: job.turn,
          metric: "acquire",
          card,
          control: controlRef
        });
      });
    }
  }
  return jobs;
}

async function phaseArms(config) {
  await mkdir(RECOVERY_DIR, { recursive: true });
  const corpusByKey = await loadCorpusByKey();
  const controlMap = await readRecoveryJson("control-results.json", {});
  const jobs = buildArmJobs(corpusByKey, controlMap);
  const progress = await readJson("progress.json", {});
  const done = new Set(progress.experimentDone ?? []);
  const existingKeys = new Set();
  for (const pairFile of ["pairs-hold.jsonl", "pairs-acquire.jsonl", "pairs-discard.jsonl"]) {
    const text = await readFile(new URL(pairFile, DATA_DIR), "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      existingKeys.add(`${row.stateId}|${row.card}|${row.metric}`);
    }
  }
  const pendingMetricIds = new Set(MISSING_JOBS.map((job) => job.metricId));
  const bucket = { hold: [], acquire: [], discard: [], errors: [] };
  const runtimeRows = [];
  const armRuntimeRows = [];
  const availability = [];
  let appendedHold = 0;
  let appendedAcquire = 0;
  let appendedDiscard = 0;
  const completedArms = new Map();
  for (const job of MISSING_JOBS) completedArms.set(job.metricId, { rows: 0, arms: 0 });

  const flush = async () => {
    const newHold = bucket.hold.splice(0).filter((row) => {
      const key = `${row.stateId}|${row.card}|${row.metric}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    const newAcquire = bucket.acquire.splice(0).filter((row) => {
      const key = `${row.stateId}|${row.card}|${row.metric}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    const newDiscard = bucket.discard.splice(0).filter((row) => {
      const key = `${row.stateId}|${row.card}|${row.metric}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    await appendJsonl("pairs-hold.jsonl", newHold);
    await appendJsonl("pairs-acquire.jsonl", newAcquire);
    await appendJsonl("pairs-discard.jsonl", newDiscard);
    await appendJsonl("job-runtime.jsonl", runtimeRows.splice(0));
    appendedHold += newHold.length;
    appendedAcquire += newAcquire.length;
    appendedDiscard += newDiscard.length;
    progress.experimentDone = [...done];
    await updateProgress(progress);
  };

  const onResult = (result) => {
    if (result?.kind === "ok" && result.row) {
      bucket[result.row.metric] ??= [];
      bucket[result.row.metric].push(result.row);
      const entry = completedArms.get(result.metricId);
      if (entry) entry.rows += 1;
    } else if (result?.kind === "unavailable") {
      availability.push({ stateId: result.stateId, card: result.card, available: false });
    } else if (result?.kind === "not-held") {
      // no row, not an error
    } else if (result?.kind === "error") {
      bucket.errors.push(result);
    }
    const entry = completedArms.get(result?.metricId);
    if (entry) entry.arms += 1;
  };

  const onJobEnd = (job, info) => {
    runtimeRows.push({
      metricId: job.metricId,
      stateId: job.stateId,
      metric: job.metric,
      card: job.card,
      status: info.status,
      wallMs: Math.round(info.wallMs)
    });
    armRuntimeRows.push({
      metricId: job.metricId,
      stateId: job.stateId,
      metric: job.metric,
      card: job.card,
      status: info.status,
      wallMs: Math.round(info.wallMs)
    });
  };

  const checkpointEvery = Math.max(25, Math.min(100, Math.ceil(jobs.length / 40)));
  let settled = 0;
  const startedAt = performance.now();
  const onCheckpoint = async (info) => {
    settled = info.completed;
    await flush();
    const doneCount = [...done].length;
    process.stderr.write(`[recovery arms] ${settled}/${jobs.length} active=${info.active}/${config.workers} pending=${info.pending} done=${doneCount}/2000 elapsed=${((performance.now() - startedAt) / 1000).toFixed(0)}s\n`);
  };

  const { results, failures } = await runPool(config.workers, jobs, "runArm", {
    jobTimeoutMs: config.armTimeoutMs,
    collectResults: true,
    onResult: (result) => {
      onResult(result);
      if (result?.metricId && result?.kind !== "error") {
        const entry = completedArms.get(result.metricId);
        if (entry && entry.arms === expectedArmsFor(result.metricId)) {
          done.add(result.metricId);
        }
      }
    },
    onFailure: (failure) => bucket.errors.push(failure),
    onCheckpoint,
    onJobEnd
  });

  // mark done for fully recovered metrics after final flush
  for (const job of MISSING_JOBS) {
    const entry = completedArms.get(job.metricId);
    if (entry && entry.arms === expectedArmsFor(job.metricId)) done.add(job.metricId);
  }
  await flush();
  await appendJsonl("arm-runtime.jsonl", armRuntimeRows, RECOVERY_DIR);
  await writeRecoveryJson("recovery-errors.json", bucket.errors);
  if (availability.length) {
    await appendJsonl("availability.jsonl", availability, RECOVERY_DIR);
  }
  process.stderr.write(`[recovery arms] done: holdRows=${appendedHold} acquireRows=${appendedAcquire} discardRows=${appendedDiscard} errors=${bucket.errors.length}\n`);
}

function expectedArmsFor(metricId) {
  const job = MISSING_JOBS.find((entry) => entry.metricId === metricId);
  return job?.metric === "hold" ? 50 : 25;
}

async function phaseValidate(config, statesPath) {
  await mkdir(RECOVERY_DIR, { recursive: true });
  const corpusByKey = await loadCorpusByKey();
  const states = JSON.parse(await readFile(pathToFileURL(statesPath), "utf8"));
  const controlJobs = states.map((entry) => ({
    jobId: `control:${entry.metricId}`,
    metricId: entry.metricId,
    stateId: entry.stateId,
    seed: entry.seed,
    turn: entry.turn,
    metric: entry.metric,
    ...jobWithFingerprint(entry, corpusByKey)
  }));
  const { results: controlResults, failures: controlFailures } = await runPool(config.workers, controlJobs, "runControl", {
    jobTimeoutMs: config.armTimeoutMs
  });
  for (const failure of controlFailures ?? []) {
    process.stderr.write(`[recovery validate] control failure: ${JSON.stringify(failure)}\n`);
  }
  if (controlResults.length !== controlJobs.length) {
    process.stderr.write(`[recovery validate] control results missing: got ${controlResults.length}/${controlJobs.length}\n`);
  }
  const controlMap = {};
  for (const result of controlResults) controlMap[result.metricId] = result;
  for (const [metricId, result] of Object.entries(controlMap)) {
    if (result?.kind !== "ok") {
      process.stderr.write(`[recovery validate] control non-ok ${metricId}: ${JSON.stringify(result)}\n`);
    }
  }
  const armJobs = [];
  for (const entry of states) {
    const control = controlMap[entry.metricId];
    if (!control || control.kind !== "ok") throw new Error(`validation control failed: ${entry.metricId}`);
    const controlRef = { winnerTeam: control.winnerTeam, rounds: control.rounds, stalled: control.stalled };
    ALL_CARD_IDS.forEach((card, cardIndex) => {
      armJobs.push({
        ...jobWithFingerprint(entry, corpusByKey),
        jobId: `${entry.metricId}:${card}:${entry.metric}`,
        metricId: entry.metricId,
        stateId: entry.stateId,
        seed: entry.seed,
        turn: entry.turn,
        metric: entry.metric,
        card,
        cardIndex,
        control: controlRef
      });
      if (entry.metric === "hold") {
        armJobs.push({
          ...jobWithFingerprint(entry, corpusByKey),
          jobId: `${entry.metricId}:${card}:discard`,
          metricId: entry.metricId,
          stateId: entry.stateId,
          seed: entry.seed,
          turn: entry.turn,
          metric: "discard",
          card,
          control: controlRef
        });
      }
    });
  }
  const { results: armResults, failures: armFailures } = await runPool(config.workers, armJobs, "runArm", {
    jobTimeoutMs: config.armTimeoutMs
  });
  const splitRows = [];
  for (const result of armResults) {
    if (result?.kind === "ok" && result.row) splitRows.push(result.row);
  }
  const expected = await readJsonl("pairs-hold.jsonl");
  expected.push(...await readJsonl("pairs-acquire.jsonl"));
  expected.push(...await readJsonl("pairs-discard.jsonl"));
  const metricIds = new Set(states.map((entry) => entry.metricId));
  const expectedByKey = new Map();
  for (const row of expected) {
    if (!metricIds.has(row.stateId)) continue;
    expectedByKey.set(`${row.stateId}|${row.card}|${row.metric}`, row);
  }
  const splitByKey = new Map();
  for (const row of splitRows) splitByKey.set(`${row.stateId}|${row.card}|${row.metric}`, row);
  const keys = new Set([...expectedByKey.keys(), ...splitByKey.keys()]);
  const comparisons = [];
  let mismatch = 0;
  for (const key of keys) {
    const exp = expectedByKey.get(key);
    const got = splitByKey.get(key);
    let match = false;
    let diffFields = [];
    if (exp && got && JSON.stringify(exp) === JSON.stringify(got)) {
      match = true;
    } else if (exp && got) {
      const fields = new Set([...Object.keys(exp), ...Object.keys(got)]);
      for (const field of fields) {
        if (JSON.stringify(exp[field]) !== JSON.stringify(got[field])) diffFields.push(field);
      }
    }
    if (!match) mismatch += 1;
    comparisons.push({ key, expected: exp ?? null, split: got ?? null, match, diffFields });
  }
  await writeRecoveryJson("split-equivalence-validation.json", {
    states: states.map((entry) => ({ metricId: entry.metricId, stateId: entry.stateId, metric: entry.metric })),
    rowsExpected: expectedByKey.size,
    rowsSplit: splitByKey.size,
    rowsCompared: keys.size,
    mismatch,
    armFailures: armFailures.map((failure) => failure.jobId),
    comparisons
  });
  process.stderr.write(`[recovery validate] expected=${expectedByKey.size} split=${splitByKey.size} compared=${keys.size} mismatch=${mismatch}\n`);
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const command = cli.positional?.[0];
  const workers = Number(cli.workers ?? WORKERS_DEFAULT);
  const config = {
    workers,
    controlTimeoutMs: Number(cli.controlTimeoutMs ?? CONTROL_TIMEOUT_DEFAULT),
    armTimeoutMs: Number(cli.armTimeoutMs ?? ARM_TIMEOUT_DEFAULT)
  };
  if (command === "controls") {
    await phaseControls(config);
  } else if (command === "arms") {
    await phaseArms(config);
  } else if (command === "validate") {
    if (!cli.states) throw new Error("validate requires --states <json>");
    await phaseValidate(config, cli.states);
  } else {
    process.stderr.write(`unknown recovery command: ${command}\n`);
    process.exitCode = 1;
  }
}

async function workerMain() {
  const { handler, job } = workerData;
  const savedRandom = installJobRandom(job);
  try {
    const payload = handler === "runControl" ? await runControl(job) : await runArm(job);
    parentPort.postMessage({ type: "result", payload });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      payload: { jobId: job?.jobId, message: String(error?.stack ?? error) }
    });
  } finally {
    uninstallJobRandom(savedRandom);
  }
}

if (isMainThread) {
  await main();
} else {
  await workerMain();
}
