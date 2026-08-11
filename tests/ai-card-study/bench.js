/**
 * 基准与克隆验证脚本。
 * 用法：node tests/ai-card-study/bench.js [games] [workers]
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_SEED_BASE,
  GOLDEN_RATIO_32,
  DEFAULT_NODE_BUDGET,
  DEFAULT_MAX_ROUNDS,
  initGame,
  cloneGame,
  runGame,
  stateFingerprint,
  fingerprintsEqual
} from "./lib/harness.js";

async function runOneBench(index, config) {
  const startedAt = performance.now();
  const seed = (config.seedBase ^ (index * GOLDEN_RATIO_32)) >>> 0;
  const { game, rng } = await initGame({ seed, nodeBudget: config.nodeBudget });
  if (config.hiddenSamples && config.hiddenSamples > 0) {
    const knowledge = game.aiController.knowledge;
    const originalSample = knowledge.sampleHiddenWorlds.bind(knowledge);
    knowledge.sampleHiddenWorlds = (viewer, visibleState, count) => (
      originalSample(viewer, visibleState, Math.min(config.hiddenSamples, count))
    );
  }
  const result = await runGame(game, { maxRounds: config.maxRounds });
  result.durationMs = performance.now() - startedAt;
  result.seed = seed;
  game.dispose();
  return result;
}

async function runCloneValidation(config) {
  const index = config.validationIndex ?? 3;
  const seed = (config.seedBase ^ (index * GOLDEN_RATIO_32)) >>> 0;
  const { game, rng } = await initGame({ seed, nodeBudget: config.nodeBudget });
  let forkAtTurn = 1;
  let forkState = null;
  let forkRng = null;
  let turnCounter = 0;
  const result = await runGame(game, {
    maxRounds: config.maxRounds,
    onTurnStart: async (g, player, turn) => {
      turnCounter = turn;
      if (turn === forkAtTurn) {
        forkState = stateFingerprint(g);
        forkRng = rng.snapshot();
        return "stop";
      }
      return null;
    }
  });
  if (!forkState) throw new Error("克隆验证未找到分叉点");

  const left = cloneGame(game, forkRng);
  const right = cloneGame(game, forkRng);
  if (!fingerprintsEqual(stateFingerprint(left), stateFingerprint(right))) {
    throw new Error("克隆左右指纹不一致");
  }
  if (!fingerprintsEqual(stateFingerprint(left), forkState)) {
    throw new Error("克隆指纹与原始状态不一致");
  }
  const leftResult = await runGame(left, { maxRounds: config.maxRounds });
  const rightResult = await runGame(right, { maxRounds: config.maxRounds });
  left.dispose();
  right.dispose();
  game.dispose();
  return {
    seed,
    forkAtTurn,
    left: leftResult,
    right: rightResult,
    identical: leftResult.winnerTeam === rightResult.winnerTeam
      && leftResult.rounds === rightResult.rounds
      && leftResult.turns === rightResult.turns
      && leftResult.stalled === rightResult.stalled
  };
}

if (isMainThread) {
  const games = Number(process.argv[2] ?? 12);
  const workers = Number(process.argv[3] ?? 4);
  const nodeBudget = Number(process.argv[4] ?? DEFAULT_NODE_BUDGET);
  const config = {
    seedBase: DEFAULT_SEED_BASE,
    nodeBudget,
    hiddenSamples: Number(process.env.STUDY_HIDDEN_SAMPLES ?? 0),
    maxRounds: DEFAULT_MAX_ROUNDS,
    validationIndex: 7
  };
  const startedAt = performance.now();
  const queue = Array.from({ length: games }, (_, index) => index);
  let cursor = 0;
  const results = [];
  let validation = null;

  const runPool = () => new Promise((resolve, reject) => {
    let active = 0;
    const spawn = () => {
      if (cursor >= queue.length) return;
      const index = queue[cursor++];
      active += 1;
      const worker = new Worker(new URL(import.meta.url), { workerData: { role: "bench-worker", index, config } });
      worker.on("message", (message) => {
        if (message?.type === "result") results.push(message.result);
        if (message?.type === "validation") validation = message.result;
        worker.terminate().then(() => {
          active -= 1;
          if (cursor < queue.length) spawn();
          else if (active === 0) resolve();
        });
      });
      worker.on("error", reject);
    };
    for (let i = 0; i < Math.min(workers, queue.length); i += 1) spawn();
  });

  await runPool();
  const validationWorker = new Worker(new URL(import.meta.url), {
    workerData: { role: "validation-worker", config }
  });
  validationWorker.on("message", (message) => {
    if (message?.type === "validation") validation = message.result;
    validationWorker.terminate().then(async () => {
      const elapsed = performance.now() - startedAt;
      const completed = results.filter((result) => !result.stalled);
      const avgMs = results.reduce((sum, result) => sum + result.durationMs, 0) / results.length;
      const rounds = results.map((result) => result.rounds).sort((a, b) => a - b);
      const p = (q) => rounds[Math.floor(q * (rounds.length - 1))];
      console.log(JSON.stringify({
        games: results.length,
        wallSeconds: +(elapsed / 1000).toFixed(2),
        gamesPerSecond: +(results.length / (elapsed / 1000)).toFixed(2),
        avgMsPerGame: +avgMs.toFixed(1),
        medianMs: +[...results.map((r) => r.durationMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)].toFixed(1),
        stalls: results.filter((result) => result.stalled).length,
        winners: results.reduce((acc, result) => { acc[result.winnerTeam ?? "none"] = (acc[result.winnerTeam ?? "none"] ?? 0) + 1; return acc; }, {}),
        rounds: { min: rounds[0], median: p(0.5), p90: p(0.9), max: rounds[rounds.length - 1] },
        validation
      }, null, 2));
    });
  });
  validationWorker.on("error", (error) => { console.error(error); process.exitCode = 1; });
} else if (workerData?.role === "bench-worker") {
  runOneBench(workerData.index, workerData.config).then((result) => {
    parentPort.postMessage({ type: "result", result });
  }).catch((error) => {
    parentPort.postMessage({ type: "result", result: { error: String(error?.stack ?? error), stalled: true, winnerTeam: null, rounds: 0, turns: 0, durationMs: 0 } });
  });
} else if (workerData?.role === "validation-worker") {
  runCloneValidation(workerData.config).then((result) => {
    parentPort.postMessage({ type: "validation", result });
  }).catch((error) => {
    parentPort.postMessage({ type: "validation", result: { error: String(error?.stack ?? error), identical: false } });
  });
}
