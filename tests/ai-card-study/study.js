
/**
 * 卡牌价值测定研究编排器。
 *
 * 用法：
 *   node tests/ai-card-study/study.js corpus [games] [workers] [budget]
 *   node tests/ai-card-study/study.js experiment [workers] [budget]
 *   node tests/ai-card-study/study.js windows [workers] [budget]
 *   node tests/ai-card-study/study.js aggregate
 *   node tests/ai-card-study/study.js all [workers] [budget]
 *
 * 所有阶段可断点续跑：进度记录在 data/progress.json，成对行追加到 data/pairs-*.jsonl。
 */
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads";
import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SEED_BASE,
  GOLDEN_RATIO_32,
  DEFAULT_NODE_BUDGET,
  DEFAULT_MAX_ROUNDS
} from "./lib/harness.js";
import { TrackedRng } from "./lib/rng.js";
import { runDirUrl } from "./lib/runPaths.js";
import { CHARACTER_DEFINITIONS } from "../../js/domain/definitions/characters/CharacterDefinitions.js";

let DATA_DIR = new URL("./data/", import.meta.url);
const WORKERS_DEFAULT = 24;

function seedFor(kind, index, base = DEFAULT_SEED_BASE) {
  return (base ^ (index * GOLDEN_RATIO_32)) >>> 0;
}

function buildConfig(cli) {
  const workers = Number(cli.positional?.[1] ?? cli.workers ?? WORKERS_DEFAULT);
  const nodeBudget = Number(cli.positional?.[2] ?? cli.budget ?? DEFAULT_NODE_BUDGET);
  const env = process.env;
  return {
    workers,
    nodeBudget,
    maxRounds: DEFAULT_MAX_ROUNDS,
    corpusGames: Number(env.FIVE_REALMS_STUDY_CORPUS_GAMES ?? 240),
    roleGamesPerRole: Number(env.FIVE_REALMS_STUDY_ROLE_GAMES_PER_ROLE ?? 40),
    compositeStateTarget: Number(env.FIVE_REALMS_STUDY_COMPOSITE_STATES ?? 500),
    roleStateTargetPerRole: Number(env.FIVE_REALMS_STUDY_ROLE_STATES ?? 120),
    useStateTarget: Number(env.FIVE_REALMS_STUDY_USE_STATES ?? 250),
    jobTimeoutMs: Number(env.FIVE_REALMS_STUDY_JOB_TIMEOUT_MS ?? cli.timeoutMs ?? 180000),
    manifestPath: env.FIVE_REALMS_STUDY_MANIFEST ?? cli.manifest ?? null,
    phaseLabel: env.FIVE_REALMS_STUDY_PHASE_LABEL ?? "Main",
    runDir: env.FIVE_REALMS_STUDY_RUN_DIR ?? cli["run-dir"] ?? null,
    windowTargets: env.FIVE_REALMS_STUDY_WINDOW_TARGETS
      ? JSON.parse(env.FIVE_REALMS_STUDY_WINDOW_TARGETS)
      : { block: 500, counter: 500, statusCounter: 300, dying: 500 }
  };
}

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
  jobTimeoutMs = 180000,
  checkpointEvery = 0,
  collectResults = true,
  onResult = null,
  onFailure = null,
  onCheckpoint = null,
  onJobStart = null,
  onJobEnd = null
} = {}) {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    let active = 0;
    let completed = 0;
    const results = [];
    const failures = [];
    let flushChain = Promise.resolve();
    const maybeResolve = () => {
      if (cursor < jobs.length || active !== 0) return;
      if (onCheckpoint && (checkpointEvery <= 0 || completed % checkpointEvery !== 0)) {
        flushChain = flushChain.then(() => onCheckpoint({
          completed,
          active,
          pending: Math.max(0, jobs.length - cursor),
          final: true
        }));
      }
      flushChain = flushChain.then(() => resolve({ results, failures }));
    };
    const settleJob = (job) => {
      completed += 1;
      if (onCheckpoint && checkpointEvery > 0 && completed % checkpointEvery === 0) {
        flushChain = flushChain.then(() => onCheckpoint({
          completed,
          active,
          pending: Math.max(0, jobs.length - cursor),
          final: false
        }));
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
      if (onJobStart) onJobStart(job);
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
            settleJob(job);
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
            status: message.payload?.kind === "ok" ? "completed" : "error",
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
          settleJob(job);
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
          settleJob(job);
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

async function writeJson(relativePath, value) {
  await writeFile(new URL(relativePath, DATA_DIR), `${JSON.stringify(value)}\n`, "utf8");
}

async function appendRows(relativePath, rows) {
  if (!rows?.length) return;
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await appendFile(new URL(relativePath, DATA_DIR), text, "utf8");
}

async function updateProgress(progress) {
  await writeJson("progress.json", progress);
}

async function loadProgress() {
  return await readJson("progress.json", {});
}

async function phaseCorpus(config, progress) {
  const startedAt = performance.now();
  const jobs = [];
  for (let index = 0; index < config.corpusGames; index += 1) {
    jobs.push({
      jobId: `natural:${index}`,
      kind: "corpus",
      index,
      seed: seedFor("natural", index),
      roleOverride: null,
      nodeBudget: config.nodeBudget,
      maxRounds: config.maxRounds
    });
  }
  const done = new Set(progress.corpusDone ?? []);
  const pending = jobs.filter((job) => !done.has(job.jobId));
  process.stderr.write(`[study] 自然语料：${jobs.length} 局，待跑 ${pending.length} 局\n`);
  const { results, failures } = await runPool(config.workers, pending, "runCorpusJob");
  const gameRows = [];
  const stateRows = [];
  for (const result of results) {
    if (result?.gameResult) gameRows.push({ index: result.index, seed: result.seed, ...result.gameResult });
    for (const state of result?.states ?? []) stateRows.push(state);
    done.add(result?.index !== undefined ? `natural:${result.index}` : "");
  }
  process.stderr.write(`[study] 自然语料：${gameRows.length} 局完成，失败 ${failures.length}，耗时 ${((performance.now() - startedAt) / 1000).toFixed(1)}s\n`);
  const oldGames = await readJson("corpus.json", []);
  await appendRows("corpus-states.jsonl", stateRows);
  await writeJson("corpus.json", [...oldGames, ...gameRows]);
  progress.corpusDone = [...done];
  await updateProgress(progress);

  const roleJobs = [];
  let roleIndex = 0;
  for (const character of CHARACTER_DEFINITIONS) {
    for (let i = 0; i < config.roleGamesPerRole; i += 1) {
      roleJobs.push({
        jobId: `role:${character.id}:${i}`,
        kind: "corpus",
        index: roleIndex,
        seed: seedFor("role", roleIndex),
        roleOverride: character.id,
        nodeBudget: config.nodeBudget,
        maxRounds: config.maxRounds
      });
      roleIndex += 1;
    }
  }
  const roleDone = new Set(progress.roleCorpusDone ?? []);
  const rolePending = roleJobs.filter((job) => !roleDone.has(job.jobId));
  process.stderr.write(`[study] 角色语料：${roleJobs.length} 局，待跑 ${rolePending.length} 局\n`);
  const rolePool = await runPool(config.workers, rolePending, "runCorpusJob");
  const roleStateRows = [];
  for (const result of rolePool.results) {
    for (const state of result?.states ?? []) roleStateRows.push(state);
    if (result?.index !== undefined) roleDone.add(`role:${result.roleOverride ?? "?"}:${result.index % config.roleGamesPerRole}`);
  }
  await appendRows("role-states.jsonl", roleStateRows);
  progress.roleCorpusDone = [...roleDone];
  await updateProgress(progress);
  process.stderr.write(`[study] 角色语料完成：${roleStateRows.length} 个状态，失败 ${rolePool.failures.length}，耗时 ${((performance.now() - startedAt) / 1000).toFixed(1)}s\n`);
}

async function readStateLines(relativePath) {
  try {
    const text = await readFile(new URL(relativePath, DATA_DIR), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function sampleUniform(records, target, keyFn) {
  const used = new Set();
  const out = [];
  const rng = new TrackedRng(0x51ab3f7d);
  for (let attempt = 0; attempt < records.length * 4 && out.length < target; attempt += 1) {
    const index = Math.floor(rng.next() * records.length);
    const record = records[index];
    const key = keyFn(record);
    if (used.has(key)) continue;
    used.add(key);
    out.push(record);
  }
  return out;
}

async function readManifest(config) {
  const url = String(config.manifestPath).startsWith("file:")
    ? new URL(config.manifestPath)
    : pathToFileURL(config.manifestPath);
  const text = await readFile(url, "utf8");
  const entries = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error(`manifest must be an array: ${config.manifestPath}`);
  return entries;
}

function buildManifestJobs(config, naturalStates, manifestEntries) {
  const byKey = new Map();
  for (const record of naturalStates) {
    if (record.roleOverride != null) continue;
    const key = `${record.seed}:${record.turn}`;
    if (byKey.has(key)) throw new Error(`duplicate corpus stateId: ${key}`);
    byKey.set(key, record);
  }
  const seen = new Set();
  const missing = [];
  const composite = [];
  for (const entry of manifestEntries) {
    const key = String(entry.stateId ?? "");
    if (seen.has(key)) throw new Error(`duplicate manifest stateId: ${key}`);
    seen.add(key);
    const record = byKey.get(key);
    if (!record) {
      missing.push(key);
      continue;
    }
    if (entry.fingerprint && JSON.stringify(entry.fingerprint) !== JSON.stringify(record.fingerprint)) {
      throw new Error(`manifest fingerprint mismatch: ${key}`);
    }
    composite.push(record);
  }
  if (missing.length) throw new Error(`manifest states not found in corpus: ${missing.length}`);
  const jobs = [];
  const stateIdFor = (record, metric) => `${record.seed}:${record.turn}:${metric}`;
  for (const record of composite) {
    jobs.push({
      jobId: stateIdFor(record, "hold"),
      kind: "state",
      metric: "hold",
      stateId: stateIdFor(record, "hold"),
      sampleType: "composite",
      seed: record.seed,
      roleOverride: record.roleOverride ?? null,
      targetTurn: record.turn,
      nodeBudget: config.nodeBudget,
      maxRounds: config.maxRounds,
      expectedFingerprint: record.fingerprint
    });
    jobs.push({
      jobId: stateIdFor(record, "acquire"),
      kind: "state",
      metric: "acquire",
      stateId: stateIdFor(record, "acquire"),
      sampleType: "composite",
      seed: record.seed,
      roleOverride: record.roleOverride ?? null,
      targetTurn: record.turn,
      nodeBudget: config.nodeBudget,
      maxRounds: config.maxRounds,
      expectedFingerprint: record.fingerprint
    });
  }
  return {
    jobs,
    composite,
    manifestMeta: {
      count: manifestEntries.length,
      unique: seen.size,
      duplicates: 0,
      missing: missing.length
    }
  };
}

function printPlanSummary(config, jobs, manifestEntries) {
  const holdJobs = jobs.filter((job) => job.metric === "hold").length;
  const acquireJobs = jobs.filter((job) => job.metric === "acquire").length;
  process.stderr.write(`[study] planned states = ${manifestEntries.length}\n`);
  process.stderr.write(`[study] planned Hold jobs = ${holdJobs}\n`);
  process.stderr.write(`[study] planned Acquire jobs = ${acquireJobs}\n`);
  process.stderr.write(`[study] total metric jobs = ${jobs.length}\n`);
  const counts = new Map();
  for (const job of jobs) {
    const key = `${job.seed}:${job.targetTurn}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const manifestIds = new Set(manifestEntries.map((entry) => String(entry.stateId)));
  const missing = [...manifestIds].filter((id) => !counts.has(id));
  const extra = [...counts.keys()].filter((id) => !manifestIds.has(id));
  const oddMetricCount = [...counts.values()].filter((count) => count !== 2).length;
  process.stderr.write(`[study] runner planned state IDs vs manifest: missing=${missing.length} extra=${extra.length} duplicates=0 oddMetricCount=${oddMetricCount}\n`);
}

async function phasePlan(config) {
  const naturalStates = await readStateLines("corpus-states.jsonl");
  if (!config.manifestPath) {
    process.stderr.write(`[study] plan requires --manifest\n`);
    return;
  }
  const manifestEntries = await readManifest(config);
  const { jobs } = buildManifestJobs(config, naturalStates, manifestEntries);
  printPlanSummary(config, jobs, manifestEntries);
}

async function phaseExperimentFromManifest(config, progress, naturalStates, roleStates) {
  const startedAt = performance.now();
  const manifestEntries = await readManifest(config);
  const { jobs, manifestMeta } = buildManifestJobs(config, naturalStates, manifestEntries);
  printPlanSummary(config, jobs, manifestEntries);
  process.stderr.write(`[study] 语料状态：自然 ${naturalStates.length}，角色 ${roleStates.length}；manifest ${manifestMeta.count} 条\n`);

  const done = new Set(progress.experimentDone ?? []);
  const pending = jobs.filter((job) => !done.has(job.jobId));
  process.stderr.write(`[study] 实验任务：${jobs.length} 个，待跑 ${pending.length} 个\n`);
  const bucket = { hold: [], acquire: [], use: [], discard: [], errors: [] };
  const runtimeRows = [];
  let processed = 0;
  let appendedHold = 0;
  let appendedAcquire = 0;
  let appendedUse = 0;
  let appendedDiscard = 0;
  const checkpointEvery = Math.max(25, Math.min(100, Math.ceil(pending.length / 40)));
  const flush = async ({ active, pending: pendingCount } = {}) => {
    const newRows = {
      hold: bucket.hold.splice(0),
      acquire: bucket.acquire.splice(0),
      use: bucket.use.splice(0),
      discard: bucket.discard.splice(0)
    };
    const newRuntimeRows = runtimeRows.splice(0);
    await appendRows("pairs-hold.jsonl", newRows.hold);
    await appendRows("pairs-acquire.jsonl", newRows.acquire);
    await appendRows("pairs-use.jsonl", newRows.use);
    await appendRows("pairs-discard.jsonl", newRows.discard);
    await appendRows("job-runtime.jsonl", newRuntimeRows);
    appendedHold += newRows.hold.length;
    appendedAcquire += newRows.acquire.length;
    appendedUse += newRows.use.length;
    appendedDiscard += newRows.discard.length;
    progress.experimentDone = [...done];
    await updateProgress(progress);
    const elapsedSec = (performance.now() - startedAt) / 1000;
    const holdDone = [...done].filter((id) => id.endsWith(":hold")).length;
    const acquireDone = [...done].filter((id) => id.endsWith(":acquire")).length;
    const timeoutCount = bucket.errors.filter((entry) => entry?.message === "job-timeout").length;
    const jobsPerSec = processed > 0 ? (processed / Math.max(1, elapsedSec)).toFixed(2) : "0";
    process.stderr.write(`[Formal 1000 · ${config.phaseLabel}] completed metrics: ${processed}/${pending.length} Hold done: ${holdDone} Acquire done: ${acquireDone} timeout/slow: ${timeoutCount} active workers: ${active ?? "?"}/${config.workers} pending: ${pendingCount} elapsed: ${elapsedSec.toFixed(0)}s jobs/s: ${jobsPerSec} Hold pair rows: ${appendedHold} Acquire pair rows: ${appendedAcquire} errors: ${bucket.errors.length}\n`);
  };
  await runPool(config.workers, pending, "runStateJob", {
    jobTimeoutMs: config.jobTimeoutMs,
    checkpointEvery,
    collectResults: false,
    onResult: (result) => {
      if (result?.kind === "ok") {
        for (const row of result.rows ?? []) {
          bucket[row.metric] ??= [];
          bucket[row.metric].push(row);
        }
        done.add(result.stateId);
      } else {
        bucket.errors.push(result);
        done.add(result.stateId);
      }
    },
    onFailure: (failure) => bucket.errors.push(failure),
    onCheckpoint: (info) => {
      processed = info.completed;
      return flush(info);
    },
    onJobStart: () => {},
    onJobEnd: (job, info) => {
      runtimeRows.push({
        metricId: job.stateId,
        stateId: job.stateId,
        metric: job.metric,
        status: info.status,
        wallMs: Math.round(info.wallMs)
      });
    }
  });
  await flush();
  await writeJson("experiment-errors.json", bucket.errors);
  await updateProgress(progress);
  process.stderr.write(`[study] 实验完成：hold=${appendedHold} acquire=${appendedAcquire} use=${appendedUse} discard=${appendedDiscard}，错误 ${bucket.errors.length}\n`);
}

async function phaseExperiment(config, progress) {
  const startedAt = performance.now();
  const naturalStates = await readStateLines("corpus-states.jsonl");
  const roleStates = await readStateLines("role-states.jsonl");
  if (config.manifestPath) return await phaseExperimentFromManifest(config, progress, naturalStates, roleStates);
  process.stderr.write(`[study] 语料状态：自然 ${naturalStates.length}，角色 ${roleStates.length}\n`);

  const composite = sampleUniform(
    naturalStates.filter((record) => record.roleOverride == null),
    config.compositeStateTarget,
    (record) => `${record.seed}:${record.turn}`
  );
  const useStates = sampleUniform(
    composite,
    config.useStateTarget,
    (record) => `${record.seed}:${record.turn}`
  );
  const roleTargets = {};
  for (const character of CHARACTER_DEFINITIONS) {
    roleTargets[character.id] = sampleUniform(
      roleStates.filter((record) => record.roleOverride === character.id && record.characterId === character.id),
      config.roleStateTargetPerRole,
      (record) => `${record.seed}:${record.turn}`
    );
  }

  const jobs = [];
  const stateIdFor = (record, metric) => `${record.seed}:${record.turn}:${metric}`;
  for (const record of composite) {
    jobs.push({
      jobId: stateIdFor(record, "hold"),
      kind: "state",
      metric: "hold",
      stateId: stateIdFor(record, "hold"),
      sampleType: "composite",
      seed: record.seed,
      roleOverride: record.roleOverride ?? null,
      targetTurn: record.turn,
      nodeBudget: config.nodeBudget,
      maxRounds: config.maxRounds,
      expectedFingerprint: record.fingerprint
    });
    jobs.push({
      jobId: stateIdFor(record, "acquire"),
      kind: "state",
      metric: "acquire",
      stateId: stateIdFor(record, "acquire"),
      sampleType: "composite",
      seed: record.seed,
      roleOverride: record.roleOverride ?? null,
      targetTurn: record.turn,
      nodeBudget: config.nodeBudget,
      maxRounds: config.maxRounds,
      expectedFingerprint: record.fingerprint
    });
  }
  for (const record of useStates) {
    jobs.push({
      jobId: stateIdFor(record, "use"),
      kind: "state",
      metric: "use",
      stateId: stateIdFor(record, "use"),
      sampleType: "composite",
      seed: record.seed,
      roleOverride: record.roleOverride ?? null,
      targetTurn: record.turn,
      nodeBudget: config.nodeBudget,
      maxRounds: config.maxRounds,
      expectedFingerprint: record.fingerprint
    });
  }
  for (const character of CHARACTER_DEFINITIONS) {
    for (const record of roleTargets[character.id]) {
      jobs.push({
        jobId: stateIdFor(record, `hold:${character.id}`),
        kind: "state",
        metric: "hold",
        stateId: stateIdFor(record, `hold:${character.id}`),
        sampleType: `role:${character.id}`,
        seed: record.seed,
        roleOverride: character.id,
        targetTurn: record.turn,
        nodeBudget: config.nodeBudget,
        maxRounds: config.maxRounds,
        expectedFingerprint: record.fingerprint
      });
    }
  }

  const done = new Set(progress.experimentDone ?? []);
  const pending = jobs.filter((job) => !done.has(job.jobId));
  process.stderr.write(`[study] 实验任务：${jobs.length} 个，待跑 ${pending.length} 个\n`);
  const bucket = { hold: [], acquire: [], use: [], discard: [], errors: [] };
  const runtimeRows = [];
  let processed = 0;
  let appendedHold = 0;
  let appendedAcquire = 0;
  let appendedUse = 0;
  let appendedDiscard = 0;
  const checkpointEvery = Math.max(25, Math.min(100, Math.ceil(pending.length / 40)));
  const flush = async ({ active, pending: pendingCount } = {}) => {
    const newRows = {
      hold: bucket.hold.splice(0),
      acquire: bucket.acquire.splice(0),
      use: bucket.use.splice(0),
      discard: bucket.discard.splice(0)
    };
    const newRuntimeRows = runtimeRows.splice(0);
    await appendRows("pairs-hold.jsonl", newRows.hold);
    await appendRows("pairs-acquire.jsonl", newRows.acquire);
    await appendRows("pairs-use.jsonl", newRows.use);
    await appendRows("pairs-discard.jsonl", newRows.discard);
    await appendRows("job-runtime.jsonl", newRuntimeRows);
    appendedHold += newRows.hold.length;
    appendedAcquire += newRows.acquire.length;
    appendedUse += newRows.use.length;
    appendedDiscard += newRows.discard.length;
    progress.experimentDone = [...done];
    await updateProgress(progress);
    const workerText = active === undefined
      ? ""
      : ` active=${active}/${config.workers} pending=${pendingCount}`;
    process.stderr.write(`[study] 实验进度 ${processed}/${pending.length}${workerText}，已落盘 hold=${appendedHold} acquire=${appendedAcquire} use=${appendedUse} discard=${appendedDiscard}，耗时 ${((performance.now() - startedAt) / 1000).toFixed(0)}s\n`);
  };
  await runPool(config.workers, pending, "runStateJob", {
    jobTimeoutMs: 180000,
    checkpointEvery,
    collectResults: false,
    onResult: (result) => {
      if (result?.kind === "ok") {
        for (const row of result.rows ?? []) {
          bucket[row.metric] ??= [];
          bucket[row.metric].push(row);
        }
        done.add(result.stateId);
      } else {
        bucket.errors.push(result);
        done.add(result.stateId);
      }
    },
    onFailure: (failure) => bucket.errors.push(failure),
    onCheckpoint: (info) => {
      processed = info.completed;
      return flush(info);
    },
    onJobStart: () => {},
    onJobEnd: (job, info) => {
      runtimeRows.push({
        metricId: job.stateId,
        stateId: job.stateId,
        metric: job.metric,
        status: info.status,
        wallMs: Math.round(info.wallMs)
      });
    }
  });
  await flush();
  await writeJson("experiment-errors.json", bucket.errors);
  await updateProgress(progress);
  process.stderr.write(`[study] 实验完成：hold=${appendedHold} acquire=${appendedAcquire} use=${appendedUse} discard=${appendedDiscard}，错误 ${bucket.errors.length}\n`);
}

async function phaseWindows(config, progress) {
  const startedAt = performance.now();
  const done = new Set(progress.windowsDone ?? []);
  const jobs = [];
  let windowIndex = 0;
  for (const [windowType, target] of Object.entries(config.windowTargets)) {
    for (let i = 0; i < target * 2; i += 1) {
      jobs.push({
        jobId: `window:${windowType}:${i}`,
        kind: "window",
        windowType,
        seed: seedFor(`window:${windowType}`, windowIndex),
        nodeBudget: config.nodeBudget,
        maxRounds: config.maxRounds
      });
      windowIndex += 1;
    }
  }
  const pending = jobs.filter((job) => !done.has(job.jobId));
  process.stderr.write(`[study] 响应窗口任务：${jobs.length} 个，待跑 ${pending.length} 个\n`);
  const bucket = [];
  const summary = Object.fromEntries(Object.keys(config.windowTargets).map((key) => [key, { jobs: 0, pairs: 0, noWindow: 0 }]));
  let processed = 0;
  const batchSize = Math.max(24, Math.ceil(pending.length / 30));
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const { results, failures } = await runPool(config.workers, batch, "runWindowJobDispatch");
    const newRows = [];
    for (const result of results) {
      if (result?.jobId) done.add(result.jobId);
      const type = result?.windowType ?? "unknown";
      summary[type] ??= { jobs: 0, pairs: 0, noWindow: 0 };
      summary[type].jobs += 1;
      if (result?.kind === "pair") {
        bucket.push(result.row);
        newRows.push(result.row);
        summary[type].pairs += 1;
      } else if (result?.kind === "no-window") summary[type].noWindow += 1;
    }
    for (const failure of failures) {
      if (failure?.jobId) done.add(failure.jobId);
    }
    processed += batch.length;
    await appendRows("pairs-window.jsonl", newRows);
    await writeJson("window-summary.json", summary);
    progress.windowsDone = [...done];
    await updateProgress(progress);
    if (processed % Math.max(1, Math.floor(pending.length / 10)) === 0 || offset + batchSize >= pending.length) {
      process.stderr.write(`[study] 窗口进度 ${processed}/${pending.length}，已得 ${bucket.length} 对，耗时 ${((performance.now() - startedAt) / 1000).toFixed(0)}s\n`);
    }
  }
  await updateProgress(progress);
  process.stderr.write(`[study] 窗口完成：${bucket.length} 对，耗时 ${((performance.now() - startedAt) / 1000).toFixed(1)}s\n`);
}

async function phaseAggregate(config, progress) {
  const { aggregate } = await import("./lib/aggregate.js");
  await aggregate({ runDir: config.runDir });
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const phase = cli.positional?.[0] ?? cli.phase ?? "all";
  const config = buildConfig(cli);
  const runBase = runDirUrl(config.runDir);
  if (runBase) DATA_DIR = new URL("data/", runBase);
  if (cli.plan) {
    await phasePlan(config);
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeJson("config.json", {
    nodeBudget: config.nodeBudget,
    workers: config.workers,
    maxRounds: config.maxRounds,
    jobTimeoutMs: config.jobTimeoutMs,
    corpusGames: config.corpusGames,
    roleGamesPerRole: config.roleGamesPerRole,
    compositeStateTarget: config.compositeStateTarget,
    roleStateTargetPerRole: config.roleStateTargetPerRole,
    useStateTarget: config.useStateTarget,
    windowTargets: config.windowTargets
  });
  const progress = await loadProgress();

  if (phase === "corpus") {
    await phaseCorpus(config, progress);
  } else if (phase === "experiment") {
    await phaseExperiment(config, progress);
  } else if (phase === "windows") {
    await phaseWindows(config, progress);
  } else if (phase === "aggregate") {
    await phaseAggregate(config, progress);
  } else if (phase === "all") {
    await phaseCorpus(config, progress);
    await phaseExperiment(config, progress);
    await phaseWindows(config, progress);
    await phaseAggregate(config, progress);
  } else {
    process.stderr.write(`未知阶段：${phase}\n`);
    process.exitCode = 1;
  }
}

async function workerMain() {
  const { handler, job } = workerData;
  const jobs = await import("./lib/jobs.js");
  const { installJobRandom, uninstallJobRandom } = await import("./lib/studyRandom.js");
  const savedRandom = installJobRandom(job);
  try {
    const payload = await jobs[handler](job);
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
