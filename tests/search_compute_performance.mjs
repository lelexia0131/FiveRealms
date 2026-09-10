// 手动性能回归入口：复用正确性 fixture，保留 fixed-work 与 soft TIME 的可重跑证据；不用于速度门禁或 Balance。
import { writeFile } from "node:fs/promises";
import { makeThreadPool } from "./compute_worker_test.mjs";
import { makeComputeSearchRequest } from "./search_compute_fixture.mjs";
import { executeSearchRequest, createCandidateCompute } from "../js/ai/Controller.js";

const request = makeComputeSearchRequest();
const rows = [];
for (const size of [1, 2, 4]) {
  const pool = makeThreadPool(size);
  try {
    // 同一固定 Search 预热；不调参数、不执行对局。
    await executeSearchRequest({ ...request, searchConfig:{ ...request.searchConfig, nodeBudget:23 } }, { candidateExecutor:pool });
    const fixedStartedAt = performance.now();
    const fixed = await executeSearchRequest(request, { candidateExecutor:pool });
    const fixedWallMs = performance.now() - fixedStartedAt;
    rows.push({ mode:"NODE", poolSize:size, wallClockMs:fixedWallMs, candidates:pool.stats.completed,
      nodes:fixed.stats.expanded, candidatesPerSecond:pool.stats.completed * 1000 / fixedWallMs,
      postMessageMs:pool.stats.postMessageMs, transportAndSchedulingMs:Math.max(0, pool.stats.roundTripMs - pool.stats.computeMs) });
    console.log(`${size} Workers fixed NODE: ${fixedWallMs.toFixed(1)} ms, ${pool.stats.completed} candidates, ${fixed.stats.expanded} nodes`);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const timeRequest = { ...request, searchConfig:{ ...request.searchConfig, nodeBudget:null } };
      const startedAt = performance.now();
      const result = await executeSearchRequest(timeRequest, { candidateExecutor:pool });
      const wallClockMs = performance.now() - startedAt;
      const row = {
        mode:"TIME", poolSize:size, repeat:repeat + 1, wallClockMs,
        candidates:pool.stats.completed, nodes:result.stats.expanded,
        candidatesPerSecond:pool.stats.completed * 1000 / wallClockMs,
        postMessageMs:pool.stats.postMessageMs,
        transportAndSchedulingMs:Math.max(0, pool.stats.roundTripMs - pool.stats.computeMs),
        initializationMs:pool.stats.initializationMs,
        peakInFlight:pool.stats.peakInFlight,
        stopReason:result.searchStopReason,
        selectedRootIndex:result.selectedRootIndex
      };
      rows.push(row);
      console.log(`${size} Workers #${repeat + 1}: ${wallClockMs.toFixed(1)} ms, candidates ${row.candidates}, nodes ${row.nodes}, ${row.candidatesPerSecond.toFixed(2)} candidates/s, postMessage ${row.postMessageMs.toFixed(2)} ms, transport+scheduling ${row.transportAndSchedulingMs.toFixed(2)} ms`);
    }
  } finally { pool.dispose(); }
}

const computer = createCandidateCompute({ world:request.world, difficultyMultiplier:request.searchConfig.difficultyMultiplier });
const input = {
  action:request.rootActions[0], beforeState:request.world, player:request.world.players[0], depth:1,
  remainingProvenance:computer.evaluator.initialTransitionProvenance(request.world.players[0], request.world), hiddenWorlds:[]
};
const receipt = computer.compute(input);
let inputCloneMs = 0;
let receiptCloneMs = 0;
for (let index = 0; index < 10; index += 1) {
  const before = performance.now();
  structuredClone(input);
  const middle = performance.now();
  structuredClone(receipt);
  inputCloneMs += middle - before;
  receiptCloneMs += performance.now() - middle;
}
const clone = { inputCloneMs:inputCloneMs / 10, receiptCloneMs:receiptCloneMs / 10 };
console.log(`structuredClone sample: input ${clone.inputCloneMs.toFixed(3)} ms, receipt ${clone.receiptCloneMs.toFixed(3)} ms`);
await writeFile(new URL("./search-compute-performance.json", import.meta.url), JSON.stringify({
  purpose:"历史性能对照基线：固定完整工作量与 soft TIME 的差异；由 search_compute_performance.mjs 手动重跑，不作为机器速度断言。",
  fixture:"search_compute_fixture.mjs", timeBudgetMs:request.searchConfig.timeBudgetMs,
  clock:"Node performance.now; real worker_threads; warm workers; no speed assertion", rows, clone
}, null, 2) + "\n");
