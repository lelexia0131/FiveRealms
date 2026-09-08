import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ComputeWorkerPool } from "../js/adapters/ai/worker/ComputeWorkerPool.js";
import {
  SEARCH_RESULT_STATUS,
  createSearchEngine,
  executeDecisionRequest,
  executeSearchRequest
} from "../js/ai/Controller.js";
import { deriveCurrentCardCounts } from "../js/ai/Event/Fact.js";
import { Rng } from "../js/ai/Searcher/Rng.js";
import { createInitialWorld } from "../js/ai/Simulator/World.js";
import { CARD_DEFINITIONS } from "../js/domain/definitions/cards/CardDefinitions.js";
import { setCurrentRound as transitionSetCurrentRound, setMatchPhase as transitionSetMatchPhase } from "../js/domain/state/transitions/MatchStateTransitions.js";
import { setAlive as transitionSetAlive } from "../js/domain/state/transitions/PlayerStateTransitions.js";
import { changeShield as transitionChangeShield } from "../js/domain/state/transitions/ResourceTransitions.js";
import { makeComputeSearchRequest } from "./search_compute_fixture.mjs";

/*
功能
把真实 Node Worker Threads 的 transport 接到生产 ComputeWorkerPool。

调用方
定向测试与性能 probe。

输入
poolSize。

输出
使用正式 compute entry 的池。

读取状态
无。

写入状态
测试拥有的 Worker 生命周期。

调用函数
Worker、ComputeWorkerPool。

边界与不变量
只适配 transport，不复制 candidate 计算。
*/
export function makeThreadPool(poolSize) {
  return new ComputeWorkerPool({ poolSize, workerFactory:() => {
    const worker = new Worker(new URL("./compute_worker_thread.mjs", import.meta.url));
    return {
      postMessage:message => worker.postMessage(message),
      terminate:() => worker.terminate(),
      addEventListener(type, callback) {
        worker.on(type, value => callback(type === "message" ? { data:value } : value));
      }
    };
  } });
}

/*
功能
生成纯 candidate receipt 的稳定指纹。

调用方
抽取前后等价与 canonical completion 测试。

输入
纯 candidate。

输出
SHA256 字符串。

读取状态
完整 candidate 数据。

写入状态
无。

调用函数
JSON.stringify、createHash。

边界与不变量
保留 -Infinity；不包含 timing 或 transport 数据。
*/
function receiptHash(candidate) {
  return createHash("sha256").update(JSON.stringify(candidate, (_, value) => value === -Infinity ? "-Infinity" : value)).digest("hex");
}

/*
功能
提取与调度耗时无关的 Search 语义和必要工作计数。

调用方
NODE deterministic 测试。

输入
executeSearchRequest 返回值。

输出
可做深相等的动作、RNG、coverage 和计数。

读取状态
result stats。

写入状态
无。

调用函数
Object.fromEntries。

边界与不变量
不忽略 winner、顺序、预算或实际 World 工作差异。
*/
function deterministicResult(result) {
  const fields = ["expanded", "stopReason", "bestSequence", "bestValueScore", "completedRootCandidateCount", "completedChildCandidateCount", "hiddenSamples", "simulationCalls", "cloneCalls", "probabilityOperations", "probabilityWorldBranches"];
  return {
    action:result.action, selectedRootIndex:result.selectedRootIndex, rngAfter:result.rngAfter,
    stats:Object.fromEntries(fields.map(key => [key, result.stats[key]]))
  };
}

/*
功能
提供可控制乱序与异常的消息 transport。

调用方
Pool queue/lifecycle 定向测试。

输入
无。

输出
workers 记录与 factory。

读取状态
无。

写入状态
测试 messages、listeners 与 terminated。

调用函数
queueMicrotask。

边界与不变量
只模拟 transport，正式 Search 语义另由真实 Worker 测试证明。
*/
function controlledTransport() {
  const workers = [];
  return { workers, factory:() => {
    const listeners = {};
    const worker = {
      messages:[], terminated:false,
      addEventListener:(type, listener) => { listeners[type] = listener; },
      postMessage(message) {
        this.messages.push(message);
        if (message.type === "INIT") queueMicrotask(() => this.reply(message, "READY"));
      },
      reply(message, type = "RESULT", receipt = null) {
        listeners.message({ data:{ ...message, type, receipt:receipt ?? { canonicalIndex:message.canonicalIndex, timing:{ durationMs:1 } } } });
      },
      fail() { listeners.error({ message:"injected worker failure" }); },
      terminate() { this.terminated = true; }
    };
    workers.push(worker);
    return worker;
  } };
}

/*
功能
按 AI 搜索分类注册多 Compute Worker 定向测试。

调用方
tests/run.mjs。

输入
默认 test、慢速 slowTest 注册函数，以及 run.mjs 已有的共享 fixture。

输出
无。

读取状态
固定基线与正式 Search 模块。

写入状态
默认与慢速测试注册表、独立 Worker 和隔离 Game fixture。

调用函数
createSearchEngine、executeSearchRequest、ComputeWorkerPool、registerSlowWorkerTests。

边界与不变量
不运行 Balance，不输出大段 JSON；slowTest 只改变入口分层，所有 Worker 和 timer 必须清理。
*/
export function registerComputeWorkerTests(test, slowTest, gameFixtures) {
  test("AI·Compute Worker：隐藏样本准备跨过 deadline 时不 admission 或派发", async () => {
    const request = makeComputeSearchRequest();
    request.searchConfig = { ...request.searchConfig, nodeBudget:null };
    const transport = controlledTransport();
    const pool = new ComputeWorkerPool({ poolSize:2, workerFactory:transport.factory });
    let clock = 0;
    const { searcher } = createSearchEngine(request, Rng.restore(request.rng), {
      candidateExecutor:pool, now:() => clock
    });
    const sample = searcher.sampleUnknownHands;
    searcher.evaluator.requiresHiddenWorldPrior = () => true;
    searcher.sampleUnknownHands = input => {
      const result = sample(input);
      clock = request.searchConfig.timeBudgetMs;
      return result;
    };
    try {
      await pool.start({});
      const pending = searcher.search(request.world.players[0], request.world, request.rootActions);
      const terminal = pending.catch(() => null);
      try {
        assert.equal(pool.stats.dispatched, 0);
        assert.equal(await pending, null);
        assert.equal(searcher.lastSearchStats.expanded, 0);
        assert.equal(searcher.lastSearchStats.stopReason, "TIME");
      } finally {
        pool.dispose();
        await terminal;
      }
    } finally { pool.dispose(); }
  });

  test("AI·Compute Worker：短 TIME 限制更多 admission 与 coverage，最后 atomic 批次跨期仍报告 TIME", async () => {
    for (const size of [1, 2, 4]) {
      const counts = [];
      for (const mode of ["short", "long", "final-tail"]) {
        const request = makeComputeSearchRequest();
        const timeBudgetMs = mode === "long" ? 1800 : 900;
        request.searchConfig = { ...request.searchConfig, nodeBudget:null, depth:1, timeBudgetMs };
        const transport = controlledTransport();
        const pool = new ComputeWorkerPool({ poolSize:size, workerFactory:transport.factory });
        let clock = 0;
        const { searcher } = createSearchEngine(request, Rng.restore(request.rng), {
          candidateExecutor:pool, now:() => clock
        });
        let settled = false;
        try {
          await pool.start({});
          const pending = searcher.search(request.world.players[0], request.world, request.rootActions);
          const terminal = pending.finally(() => { settled = true; });
          terminal.catch(() => {});
          try {
            const replied = new Set();
            for (let step = 0; step < 100 && !settled; step += 1) {
              await new Promise(resolve => setImmediate(resolve));
              const before = pool.stats.dispatched;
              const expired = clock >= timeBudgetMs;
              for (const worker of transport.workers) {
                const message = worker.messages.at(-1);
                if (message.type !== "COMPUTE" || replied.has(message)) continue;
                const receipt = searcher.candidateCompute.compute(message.input);
                clock = mode === "final-tail"
                  ? (before === request.rootActions.length ? timeBudgetMs + 300 : 0)
                  : clock + 300;
                worker.reply(message, "RESULT", receipt);
                replied.add(message);
              }
              await new Promise(resolve => setImmediate(resolve));
              if (expired) assert.equal(pool.stats.dispatched, before);
              assert.ok(pool.workers.filter(slot => slot.pending).length <= size);
            }
            assert.equal(settled, true, "在途 candidate 必须收口");
            const action = await terminal;
            const stats = searcher.lastSearchStats;
            assert.equal(stats.stopReason, "TIME", `${mode}, pool ${size}`);
            assert.equal(stats.timeoutObserved, true);
            assert.equal(stats.configuredDeadline, timeBudgetMs);
            assert.ok(stats.timeObservedAtMs >= timeBudgetMs);
            assert.ok(stats.searchReturnAtMs >= stats.timeObservedAtMs);
            assert.ok(pool.stats.peakInFlight <= size);
            assert.equal(pool.stats.completed, pool.stats.dispatched);
            assert.equal(pool.batch, null);
            assert.ok(pool.workers.every(slot => slot.pending === null));
            if (mode === "final-tail") {
              assert.ok(action);
              assert.equal(stats.completedRootCandidateCount, request.rootActions.length);
              assert.ok(stats.deadlineOverrunMs > 0);
            } else counts.push({ admitted:pool.stats.dispatched, coverage:stats.completedRootCandidateCount });
          } finally {
            pool.dispose();
            await terminal.catch(() => {});
          }
        } finally { pool.dispose(); }
      }
      assert.ok(counts[0].admitted < counts[1].admitted, `pool ${size} admission`);
      assert.ok(counts[0].coverage < counts[1].coverage, `pool ${size} coverage`);
    }
  });

  slowTest("AI·Compute Worker：pure compute 抽取与封板基线逐候选等价", async () => {
    const baseline = JSON.parse(await readFile(new URL("./search-compute-baseline.json", import.meta.url), "utf8"));
    const request = makeComputeSearchRequest();
    const rng = Rng.restore(request.rng);
    const { searcher } = createSearchEngine(request, rng);
    const receipts = [];
    const compute = searcher.candidateCompute.compute.bind(searcher.candidateCompute);
    searcher.candidateCompute.compute = input => {
      const receipt = compute(input);
      receipts.push(receiptHash(receipt.candidate));
      return receipt;
    };
    const action = await searcher.search(request.world.players[0], request.world, request.rootActions);
    assert.deepEqual(receipts, baseline.receipts);
    assert.deepEqual(deterministicResult({ action, selectedRootIndex:request.rootActions.indexOf(action), rngAfter:rng.snapshot(), stats:searcher.lastSearchStats }), {
      action:baseline.action, selectedRootIndex:baseline.selectedRootIndex, rngAfter:baseline.rngAfter, stats:baseline.stats
    });
  });

  slowTest("AI·Compute Worker：真实 poolSize 1/2/4 NODE、coverage、World 与 RNG 一致", async () => {
    const request = makeComputeSearchRequest();
    for (const nodeBudget of [1, 8, 9, 23, 1000]) {
      request.searchConfig = { ...request.searchConfig, nodeBudget };
      const local = deterministicResult(await executeSearchRequest(request));
      for (const size of [1, 2, 4]) {
        const pool = makeThreadPool(size);
        try {
          const result = await executeSearchRequest(request, { candidateExecutor:pool });
          assert.deepEqual(deterministicResult(result), local, `NODE ${nodeBudget}, pool ${size}`);
          assert.ok(pool.stats.peakInFlight <= size);
          assert.equal(pool.batch, null);
          assert.ok(pool.workers.every(slot => slot.pending === null));
        } finally {
          pool.dispose();
          assert.equal(pool.workers.length, 0);
        }
      }
    }
  });

  test("AI·Compute Worker：乱序 C/A/D/B 按 canonical index join", async () => {
    const transport = controlledTransport();
    const pool = new ComputeWorkerPool({ poolSize:4, workerFactory:transport.factory });
    try {
      await pool.start({});
      const pending = pool.runBatch({ batchId:1, count:4, admit:index => ({ index }) });
      for (const index of [2, 0, 3, 1]) transport.workers[index].reply(transport.workers[index].messages.at(-1));
      assert.deepEqual((await pending).map(result => result.canonicalIndex), [0, 1, 2, 3]);
    } finally { pool.dispose(); }
  });

  test("AI·Compute Worker：TIME dispatch admission 仅占空闲 slot 且截止后不派发", async () => {
    for (const size of [1, 2, 4]) {
      const transport = controlledTransport();
      const pool = new ComputeWorkerPool({ poolSize:size, workerFactory:transport.factory });
      let expired = false;
      const admitted = [];
      try {
        await pool.start({});
        const pending = pool.runBatch({ batchId:1, count:20, admit:index => {
          if (expired) return null;
          admitted.push(index);
          return { index };
        } });
        assert.equal(admitted.length, size);
        expired = true;
        for (const worker of transport.workers) worker.reply(worker.messages.at(-1));
        assert.equal((await pending).length, size);
        assert.equal(admitted.length, size);
        assert.equal(pool.stats.peakInFlight, size);
      } finally { pool.dispose(); }
    }
  });

  test("AI·Compute Worker：真实 Search END 早完成仍等待 required sibling 且乱序不改 winner/RNG", async () => {
    const request = makeComputeSearchRequest();
    request.searchConfig = { ...request.searchConfig, depth:1 };
    const expected = deterministicResult(await executeSearchRequest(request));
    const transport = controlledTransport();
    const pool = new ComputeWorkerPool({ poolSize:4, workerFactory:transport.factory });
    const rng = Rng.restore(request.rng);
    const { searcher } = createSearchEngine(request, rng, { candidateExecutor:pool });
    let finalized = 0;
    const finalize = searcher.evaluator.finalizeEndTransition.bind(searcher.evaluator);
    searcher.evaluator.finalizeEndTransition = input => { finalized += 1; return finalize(input); };
    try {
      await pool.start({});
      const pending = searcher.search(request.world.players[0], request.world, request.rootActions);
      let held = null;
      let completedEnd = false;
      const replied = new Set();
      // 保留 index 1，其余三个 slot 动态完成后续任务，故意让 END 先返回。
      for (let step = 0; step < 100 && !completedEnd; step += 1) {
        await new Promise(resolve => setImmediate(resolve));
        for (const worker of transport.workers) {
          const message = worker.messages.at(-1);
          if (message.type !== "COMPUTE" || replied.has(message)) continue;
          if (message.canonicalIndex === 1) { held = { worker, message }; continue; }
          const receipt = searcher.candidateCompute.compute(message.input);
          worker.reply(message, "RESULT", receipt);
          replied.add(message);
          if (message.input.action.type === "end") completedEnd = true;
        }
      }
      assert.ok(held);
      assert.equal(completedEnd, true);
      assert.equal(finalized, 0);
      held.worker.reply(held.message, "RESULT", searcher.candidateCompute.compute(held.message.input));
      const action = await pending;
      assert.equal(finalized, 1);
      assert.deepEqual(deterministicResult({ action, selectedRootIndex:request.rootActions.indexOf(action), rngAfter:rng.snapshot(), stats:searcher.lastSearchStats }), expected);
    } finally { pool.dispose(); }
  });

  test("AI·Compute Worker：真实 Search TIME 在 admission 后完成 atomic 尾部且不再采样或派发", async () => {
    for (const size of [1, 2, 4]) {
      const request = makeComputeSearchRequest();
      request.searchConfig = { ...request.searchConfig, nodeBudget:null };
      const transport = controlledTransport();
      const pool = new ComputeWorkerPool({ poolSize:size, workerFactory:transport.factory });
      let expired = false;
      const rng = Rng.restore(request.rng);
      const { searcher } = createSearchEngine(request, rng, {
        candidateExecutor:pool, now:() => expired ? request.searchConfig.timeBudgetMs : 0
      });
      try {
        await pool.start({});
        const pending = searcher.search(request.world.players[0], request.world, request.rootActions);
        const first = transport.workers[0].messages.at(-1);
        transport.workers[0].reply(first, "RESULT", searcher.candidateCompute.compute(first.input));
        await new Promise(resolve => setImmediate(resolve));
        const admitted = pool.stats.dispatched;
        const rngBeforeTail = rng.snapshot();
        assert.equal(admitted, size + 1);
        expired = true;
        for (const worker of transport.workers) {
          const message = worker.messages.at(-1);
          worker.reply(message, "RESULT", searcher.candidateCompute.compute(message.input));
        }
        assert.equal(await pending, null);
        assert.equal(pool.stats.dispatched, admitted);
        assert.equal(searcher.lastSearchStats.expanded, admitted);
        assert.equal(searcher.lastSearchStats.stopReason, "TIME");
        assert.equal(searcher.lastSearchStats.candidateFaults.length, 0);
        assert.deepEqual(rng.snapshot(), rngBeforeTail);
        assert.ok(pool.stats.peakInFlight <= size);
      } finally { pool.dispose(); }
    }
  });

  slowTest("AI·Compute Worker：真实 Worker compute ERROR 通过现有 Search fault contract 传播", async () => {
    const request = makeComputeSearchRequest();
    const pool = makeThreadPool(2);
    const runBatch = pool.runBatch.bind(pool);
    pool.runBatch = options => runBatch({ ...options, admit:index => {
      const input = options.admit(index);
      return input ? { ...input, beforeState:null } : null;
    } });
    try {
      const { runSearchRequest } = await import("../js/adapters/ai/worker/WorkerSearchRuntime.js");
      const result = await runSearchRequest(request, { candidateExecutor:pool });
      assert.equal(result.action, null);
      assert.ok(result.searchFault);
      assert.match(result.searchFault.message, /candidate materialize fault/);
      assert.equal(pool.batch, null);
      assert.equal(pool.workers.length, 0);
    } finally { pool.dispose(); }
  });

  test("AI·Compute Worker：cancel/stale/dispose/error 清空 pending 且不接收旧结果", async () => {
    const transport = controlledTransport();
    const pool = new ComputeWorkerPool({ poolSize:2, workerFactory:transport.factory });
    await pool.start({});
    const oldWorkers = [...transport.workers];
    const oldSlots = [...pool.workers];
    const cancelled = pool.runBatch({ batchId:1, count:4, admit:index => ({ index }) });
    const rejected = assert.rejects(cancelled, /cancelled/);
    pool.cancel();
    assert.equal(pool.workers.length, 0);
    assert.ok(oldSlots.every(slot => slot.pending === null));
    assert.ok(oldWorkers.every(worker => worker.terminated));
    // 不等待旧 batch 的 catch/finally；旧 generation 的清理也不能终止新 Worker。
    await pool.start({});
    await rejected;
    const current = pool.runBatch({ batchId:1, count:2, admit:index => ({ index }) });
    for (const worker of oldWorkers) { worker.reply(worker.messages.at(-1)); worker.fail(); }
    assert.equal(pool.stats.completed, 0);
    for (const worker of transport.workers.slice(2)) worker.reply(worker.messages.at(-1));
    assert.equal((await current).length, 2);
    const failed = pool.runBatch({ batchId:2, count:2, admit:index => ({ index }) });
    const failedSlots = [...pool.workers];
    const failure = assert.rejects(failed, /injected worker failure/);
    transport.workers.at(-1).fail();
    await failure;
    assert.equal(pool.batch, null);
    assert.equal(pool.workers.length, 0);
    assert.ok(failedSlots.every(slot => slot.pending === null));
    await pool.start({});
    const disposed = pool.runBatch({ batchId:3, count:2, admit:index => ({ index }) });
    const disposedSlots = [...pool.workers];
    const disposal = assert.rejects(disposed, /disposed/);
    pool.dispose();
    await disposal;
    assert.ok(transport.workers.every(worker => worker.terminated));
    assert.equal(pool.workers.length, 0);
    assert.equal(pool.batch, null);
    assert.ok(disposedSlots.every(slot => slot.pending === null));
  });

  test("AI·Compute Worker：只有完成进度续期 heartbeat，停滞 atomic 仍受 hard watchdog 保护", async () => {
    const { createSearchWorkerMessageHandler } = await import("../js/adapters/ai/worker/searchWorker.js");
    const transport = controlledTransport();
    const pool = new ComputeWorkerPool({ poolSize:2, workerFactory:transport.factory });
    const messages = [];
    const request = makeComputeSearchRequest();
    const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const previousInterval = globalThis.setInterval;
    const previousClear = globalThis.clearInterval;
    let clock = 100;
    let tick;
    let cleared = false;
    Object.defineProperty(globalThis, "performance", { configurable:true, value:{ now:() => clock } });
    globalThis.setInterval = callback => { tick = callback; return 1; };
    globalThis.clearInterval = () => { cleared = true; };
    const handler = createSearchWorkerMessageHandler({ postMessage:message => messages.push(message), candidateExecutor:pool });
    const pending = handler.handleMessage({ type:"SEARCH", requestId:request.requestId, request });
    try {
      await new Promise(resolve => setImmediate(resolve));
      const initial = messages.filter(message => message.type === "HEARTBEAT").length;
      clock += request.searchConfig.hardWatchdogMs;
      tick();
      assert.equal(messages.filter(message => message.type === "HEARTBEAT").length, initial,
        "Coordinator timer 存活不能替代 compute 进度");
      // 单独注入 transport 的已完成计数，验证乱序回执尚未 canonical join 时的 liveness。
      pool.stats.completed += 1;
      tick();
      assert.equal(messages.filter(message => message.type === "HEARTBEAT").length, initial + 1);
      clock += request.searchConfig.hardWatchdogMs;
      tick();
      assert.equal(messages.filter(message => message.type === "HEARTBEAT").length, initial + 1,
        "停滞后不得无限续期 hard watchdog");
    } finally {
      handler.dispose();
      await pending;
      Object.defineProperty(globalThis, "performance", previousPerformance);
      globalThis.setInterval = previousInterval;
      globalThis.clearInterval = previousClear;
    }
    assert.equal(cleared, true);
    assert.equal(pool.workers.length, 0);
    assert.equal(pool.batch, null);
  });

  test("AI·Compute Worker：Coordinator requestId cancel/dispose 与 pending startup 不泄漏", async () => {
    const { createSearchWorkerMessageHandler } = await import("../js/adapters/ai/worker/searchWorker.js");
    const transport = controlledTransport();
    const pool = new ComputeWorkerPool({ poolSize:2, workerFactory:transport.factory });
    const messages = [];
    const handler = createSearchWorkerMessageHandler({ postMessage:message => messages.push(message), candidateExecutor:pool });
    const request = makeComputeSearchRequest();
    const first = handler.handleMessage({ type:"SEARCH", requestId:request.requestId, request });
    await new Promise(resolve => setImmediate(resolve));
    await handler.handleMessage({ type:"CANCEL", requestId:"stale-id" });
    assert.equal(pool.workers.length, 2);
    await handler.handleMessage({ type:"CANCEL", requestId:request.requestId });
    await first;
    const outcome = messages.find(message => message.type === "RESULT").outcome;
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.searchStopReason, "CANCELLED");
    assert.equal(outcome.searchFault ?? null, null);
    assert.equal(pool.workers.length, 0);
    assert.equal(pool.batch, null);
    const second = handler.handleMessage({ type:"SEARCH", requestId:"next-request", request:{ ...request, requestId:"next-request" } });
    handler.dispose();
    await second;
    assert.equal(messages.some(message => message.requestId === "next-request" && ["RESULT", "ERROR"].includes(message.type)), false);
    assert.ok(transport.workers.every(worker => worker.terminated));
    assert.equal(pool.workers.length, 0);
    assert.equal(pool.batch, null);
  });

  registerSlowWorkerTests(slowTest, gameFixtures);
}

/*
功能
注册真实 Worker、完整搜索压力与事件循环响应性的慢速专项回归。

调用方
registerComputeWorkerTests。

输入
slowTest 注册函数与 tests/run.mjs 已有的共享 fixture。

输出
无。

读取状态
固定 Worker/Search 基线、正式角色与卡牌定义。

写入状态
慢速测试注册表、隔离 Game、Worker 和 timer 生命周期。

调用函数
Node Worker、SearchWorkerClient、WorkerSearchRuntime、Controller 与 benchmark helpers。

边界与不变量
只做测试分层，不削弱断言、预算、RNG 或真实跨线程语义；所有 Worker、Game 与 timer 必须清理。
*/
function registerSlowWorkerTests(slowTest, gameFixtures) {
  const {
    CARD_COUNTS,
    buildLocalResponseDecisionContext,
    disposeBenchmarkGame,
    instance,
    makeBenchmarkCard,
    makeBenchmarkGame,
    makeGame,
    makePlayer,
    projectFile,
    runBenchmarkAiDecision
  } = gameFixtures;

  slowTest("AI·搜索压力：守誓者大手牌在真实 900ms 预算返回完整 non-END", async () => {
    const game = makeBenchmarkGame({
      players: [
        {
          id: "stress-oath",
          team: "dawn",
          character: "oath-warden",
          hp: 2,
          energy: 3,
          hand: [
            "assault", "recover", "shield", "shockwave", "provoke",
            "destroy", "plunder", "counter", "block"
          ].map((definitionId, index) => makeBenchmarkCard(
            definitionId,
            `stress-oath-${index}`
          ))
        },
        {
          id: "stress-oath-enemy-a",
          team: "dusk",
          character: "fate-gambler",
          hp: 1,
          hand: [makeBenchmarkCard("block"), makeBenchmarkCard("counter")],
          equipment: makeBenchmarkCard("defenseDevice")
        },
        {
          id: "stress-oath-ally",
          team: "dawn",
          character: "spirit-medic",
          hp: 2,
          hand: [makeBenchmarkCard("recover"), makeBenchmarkCard("counter")]
        },
        {
          id: "stress-oath-enemy-b",
          team: "dusk",
          character: "blade-walker",
          hand: [makeBenchmarkCard("block"), makeBenchmarkCard("counter")]
        },
        {
          id: "stress-oath-enemy-c",
          team: "dusk",
          character: "ember-magus",
          hand: [makeBenchmarkCard("block"), makeBenchmarkCard("counter")]
        }
      ],
      options: { actorId: "stress-oath", seed: 2901 }
    });
    game.aiSearchTimeBudgetOverride = 900;
    try {
      const decision = await runBenchmarkAiDecision(game, "stress-oath");
      assert.ok(decision.legalActions.length >= 10, "大手牌必须形成高 root coverage");
      assert.ok(decision.action);
      assert.notEqual(decision.action.type, "end");
      assert.equal(decision.stats.stopReason, "TIME");
      assert.ok(decision.stats.elapsedMs >= 900);
      assert.ok(decision.stats.completedRootCandidateCount > 0);
      assert.ok(decision.stats.probabilityOperations > 0);
      assert.ok(decision.stats.responseBranches > 0);
      assert.equal(game.aiController.lastSearchResult.status, SEARCH_RESULT_STATUS.ACCEPTED);
      assert.equal(game.aiController.lastWorkerOutcome.workerError, null);
    } finally {
      disposeBenchmarkGame(game);
    }
  });

  slowTest("AI·搜索压力：赌命者大手牌节点不足完整 ROOT 时不返回 partial winner", async () => {
    const game = makeBenchmarkGame({
      players: [
        {
          id: "stress-gambler",
          team: "dawn",
          character: "fate-gambler",
          energy: 3,
          hand: [
            "assault", "assault", "assault", "shockwave", "provoke",
            "harvest", "counter", "block", "recover"
          ].map((definitionId, index) => makeBenchmarkCard(
            definitionId,
            `stress-gambler-${index}`
          ))
        },
        {
          id: "stress-gambler-enemy",
          team: "dusk",
          character: "oath-warden",
          hp: 1,
          hand: [makeBenchmarkCard("block"), makeBenchmarkCard("counter")]
        },
        { id: "stress-gambler-ally", team: "dawn", character: "spirit-medic" },
        { id: "stress-gambler-enemy-b", team: "dusk", character: "blade-walker" },
        { id: "stress-gambler-enemy-c", team: "dusk", character: "ember-magus" }
      ],
      options: { actorId: "stress-gambler", seed: 2902, nodeBudget: 4 }
    });
    try {
      const decision = await runBenchmarkAiDecision(game, "stress-gambler");
      assert.ok(decision.legalActions.length >= 6, "大手牌必须形成多个 canonical roots");
      assert.equal(decision.action, null);
      assert.equal(decision.stats.stopReason, "NODE");
      assert.ok(decision.stats.completedRootCandidateCount > 0);
      assert.ok(
        decision.stats.completedRootCandidateCount < decision.stats.uniqueRootCandidateCount
      );
      assert.deepEqual(decision.stats.bestSequence, []);
      assert.equal(
        game.aiController.lastSearchResult.status,
        SEARCH_RESULT_STATUS.SEARCH_BUDGET_EXHAUSTED
      );
    } finally {
      disposeBenchmarkGame(game);
    }
  });


  /*
  功能
  构造可跨线程复现的资源与 Lightning 固定局面。

  调用方
  AI Worker 决策回归。

  输入
  资源卡定义与是否具有资源持有者的合法已知手牌。

  输出
  独立 Game、角色、公开声明和固定实体 ID。

  读取状态
  正式角色、卡牌定义。

  写入状态
  仅测试 fixture 与 AI 专用 seed。

  调用函数
  makePlayer、makeGame、Rng、rememberPrivateCard。

  边界与不变量
  迁移前基线来自 HEAD 62b9a8c；手牌、装备、Lightning、seed 与候选顺序不得为通过测试而调整。
  */
  function makeWorkerDecisionFixture(definitionId, known = false) {
    const players = ["dawn", "dusk", "dawn", "dusk", "dawn"].map((team, index) => (
      makePlayer(`worker-decision-${index}`, index, team, "ai", index)
    ));
    const [actor, owner, receiver] = players;
    for (const [index, player] of players.entries()) {
      player.hand = ["counter", "assault", "recover", "block", "charge"].map((id, cardIndex) => ({
        ...CARD_DEFINITIONS[id], id: `fixture-${index}-${cardIndex}`
      }));
      player.equipment = { ...CARD_DEFINITIONS[index % 2 ? "defenseDevice" : "barrierDevice"], id: `equipment-${index}` };

    }
    owner.statuses.lightning = { stacks: 1 };

    const { game } = makeGame(players);
    game.aiController.searchRng = new Rng(731);
    const rootCard = { ...CARD_DEFINITIONS[definitionId], id: `root-${definitionId}` };
    if (known) for (const card of owner.hand.slice(0, 3)) game.rememberPrivateCard(actor, owner, card);
    const context = {
      source: actor, rootSource: actor, card: rootCard, rootCard,
      rootTargetIds: definitionId === "transfer" ? [] : [owner.id],
      publicTransferContext: definitionId === "transfer"
        ? { fromPlayerId: owner.id, receiverPlayerId: receiver.id } : null
    };
    return { game, actor, owner, receiver, rootCard, context };
  }

  /*
  功能
  以真实 Node Worker thread 承载浏览器 Worker 的正式协议，检查跨线程结构化克隆和事件循环。

  调用方
  AI·Worker 决策专项回归。

  输入
  无。

  输出
  可按浏览器 Worker 接口构造的测试类；每个实例仅有一条计算线程。

  读取状态
  正式 SearchWorkerMessageHandler 与测试计数 instrumentation。

  写入状态
  测试线程生命周期和最近消息；不修改生产 transport。

  调用函数
  node:worker_threads.Worker。

  边界与不变量
  只模拟 API 接线，计算实际位于另一线程；不得用同线程 protocol double 证明 Renderer 响应性。
  */
  async function nodeDecisionWorkerClass() {
    const { Worker } = await import("node:worker_threads");
    return class {
      constructor() {
        this.thread = new Worker(new URL("./worker_decision_thread.mjs", import.meta.url));
      }
      addEventListener(type, listener) {
        if (type === "message") this.thread.on("message", data => listener({ data }));
        else this.thread.on(type, listener);
      }
      postMessage(message) { this.thread.postMessage(message); }
      terminate() { this.thread.terminate(); }
    };
  }

  slowTest("AI·Worker 决策：真实线程与迁移前资源选择/RNG/World 数量相同且主线程继续运行", async () => {
    const { createSearchWorkerClient } = await import("../js/adapters/ai/worker/SearchWorkerClient.js");
    const reference = JSON.parse(await readFile(projectFile("tests/worker-decision-baseline.json"), "utf8"));
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const WorkerClass = await nodeDecisionWorkerClass();
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkerClass });
    const client = createSearchWorkerClient("searchWorker.js");
    try {
      for (const baseline of reference) {
        const { definitionId, known } = baseline;
        const fixture = makeWorkerDecisionFixture(definitionId, known);
        const { game, actor, owner, receiver, rootCard, context } = fixture;
        game.searchExecutor.dispose();
        const messages = [];
        game.aiController.searchExecutor = {
          async search(request) {
            const captured = structuredClone(request);
            const outcome = await client.search(request);
            messages.push({ request: captured, outcome });
            return outcome;
          },
          getLastTransportDiagnostics: () => client.getLastTransportDiagnostics()
        };
        // 如果 Renderer 边界仍调用了旧重型能力，本测试必须立即失败。
        game.aiController.simulatorFactory = () => { throw new Error("Renderer performed Simulator work"); };
        game.aiController.evaluator.shouldRespond = () => { throw new Error("Renderer evaluated response"); };
        let ticks = 0, maxGapMs = 0, lastTick = performance.now();
        const timer = setInterval(() => {
          const now = performance.now();
          maxGapMs = Math.max(maxGapMs, now - lastTick);
          lastTick = now;
          ticks += 1;
        }, 5);
        try {
          const selected = await game.aiController.choosePostCounterResource(actor, owner, {
            purpose: definitionId, receiver, card: rootCard
          });
          const response = await game.aiController.shouldRespond(owner, "counter", context, [owner.hand[0]]);
          clearInterval(timer);
          assert.ok(ticks > 0, "Worker 计算期间主线程 timer 必须推进");
          assert.equal(messages.length, 2, "每个完整决策只发送一次请求");
          assert.deepEqual(selected.selection, baseline.selection);
          assert.equal(selected.card.id, baseline.cardId);
          assert.ok(owner.hand.includes(selected.card) || owner.equipment === selected.card);
          assert.equal(response, baseline.response);
          assert.deepEqual(messages[0].outcome.testCounts, baseline.resourceCounts);
          assert.deepEqual(messages[1].outcome.testCounts, baseline.responseCounts);
          assert.deepEqual(game.aiController.searchRng.snapshot(), baseline.rngAfter);
          for (const { request, outcome } of messages) {
            assert.deepEqual(await executeDecisionRequest(structuredClone(request)), outcome.decision);
            const world = request.input.world ?? request.input.decision.world;
            for (const player of world.players) {
              if (player.id !== request.actorId) assert.equal(player.hand, undefined);
              assert.equal(player.aiMemory, undefined);
            }
            assert.equal(outcome.rootWorlds, undefined);
          }
        } finally { clearInterval(timer); game.dispose(); }
      }
      const { game, actor, owner, receiver, rootCard } = makeWorkerDecisionFixture("transfer", true);
      game.searchExecutor.dispose();
      const controller = game.aiController;
      controller.searchExecutor = client;
      try {
        const pool = [rootCard, { ...CARD_DEFINITIONS.recover, id: "public-recover" }];
        const world = createInitialWorld(actor.id, game.state, deriveCurrentCardCounts(actor, game.state));
        const expectedId = controller.simulatorFactory().resolvePublicCardChoice(world, actor.id, pool);
        const decision = await buildLocalResponseDecisionContext(controller, owner, "dyingRescue", { target: receiver }, []);
        const expectedRescue = controller.evaluator.assessDyingRescue({
          responder: decision.responder, target: decision.context.target, rescueOrder: decision.rescueOrder,
          responderHandDefinitionIds: decision.responderHandDefinitionIds,
          knownCardsByPlayer: decision.knownCardsByPlayer, recoverDensity: decision.recoverDensity,
          remainingCardCounts: decision.remainingCardCounts
        });
        controller.simulatorFactory = () => { throw new Error("Renderer projected public receipt"); };
        controller.evaluator.assessDyingRescue = () => { throw new Error("Renderer evaluated rescue"); };
        const selected = await controller.choosePublicCard(actor, pool);
        assert.equal(selected.id, expectedId);
        assert.ok(pool.includes(selected));
        assert.deepEqual(await controller.assessDyingRescue(owner, receiver), expectedRescue);
      } finally { game.dispose(); }
      assert.equal(client.getLifecycleDiagnostics().activeSearchCount, 0);
      assert.equal(client.getLifecycleDiagnostics().activeWorkerCount, 1);
    } finally {
      client.dispose();
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
      else delete globalThis.Worker;
    }
  });

  slowTest("AI·Worker 决策：session/version/角色/公开声明失效不绑定、不推进 RNG", async () => {
    for (const change of ["session", "version", "actor", "owner", "receiver", "phase", "round"]) {
      const fixture = makeWorkerDecisionFixture("transfer");
      const { game, actor, owner, receiver, rootCard } = fixture;
      let release, sent;
      game.aiController.searchExecutor = {
        search(request) { sent = request; return new Promise(resolve => { release = resolve; }); }
      };
      const rngBefore = game.aiController.searchRng.snapshot();
      const handIds = game.state.players.map(player => player.hand.map(card => card.id));
      const pending = game.aiController.choosePostCounterResource(actor, owner, { purpose: "transfer", receiver, card: rootCard });
      if (change === "session") game.state.gameId = "replacement-session";
      if (change === "version") transitionChangeShield(game.state, owner, 1);
      if (change === "actor") transitionSetAlive(game.state, actor, false);
      if (change === "owner") transitionSetAlive(game.state, owner, false);
      if (change === "receiver") transitionSetAlive(game.state, receiver, false);
      if (change === "phase") transitionSetMatchPhase(game.state, "discard");
      if (change === "round") transitionSetCurrentRound(game.state, game.state.currentRound + 1);
      release({ requestId: sent.requestId, gameId: sent.gameId, kind: sent.kind, decision: { zone: "hand", selectionKind: "unknown", knownCardIds: [] } });
      assert.equal(await pending, null, change);
      assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.status, "STALE", change);
      assert.deepEqual(game.aiController.searchRng.snapshot(), rngBefore, change);
      assert.deepEqual(game.state.players.map(player => player.hand.map(card => card.id)), handIds, change);
      game.dispose();
    }
  });

  slowTest("AI·Worker 决策：异常传播且错误结果不得降级为 PASS 或 END", async () => {
    const { runSearchRequest } = await import("../js/adapters/ai/worker/WorkerSearchRuntime.js");
    const { createSearchWorkerMessageHandler } = await import("../js/adapters/ai/worker/searchWorker.js");
    const { game, owner, context } = makeWorkerDecisionFixture("plunder");
    let captured;
    game.aiController.searchExecutor = { async search(request) { captured = request; throw new Error("decision computation failed"); } };
    await assert.rejects(game.aiController.shouldRespond(owner, "counter", context, [owner.hand[0]]), /decision computation failed/);
    const invalid = structuredClone(captured);
    invalid.input.decision.world.players = null;
    await assert.rejects(runSearchRequest(invalid));
    const messages = [];
    const handler = createSearchWorkerMessageHandler({ postMessage: message => messages.push(message) });
    await handler.handleMessage({ type: invalid.kind, requestId: invalid.requestId, request: invalid });
    assert.equal(messages.filter(message => message.type === "RESULT").length, 0);
    assert.equal(messages.filter(message => message.type === "ERROR").length, 1);
    game.aiController.searchExecutor = { async search(request) { return { kind: request.kind, requestId: "wrong", gameId: request.gameId, decision: true }; } };
    await assert.rejects(game.aiController.shouldRespond(owner, "counter", context, [owner.hand[0]]), /identity\/shape mismatch/);
    game.aiController.searchExecutor = { async search(request) { return { kind: request.kind, requestId: request.requestId, gameId: request.gameId, decision: "true" }; } };
    await assert.rejects(game.aiController.shouldRespond(owner, "counter", context, [owner.hand[0]]), /identity\/shape mismatch/);
    game.dispose();
  });

  slowTest("AI·Worker 决策：所有 kind 共用取消与销毁且完整决策没有搜索截止时间", async () => {
    const { createSearchWorkerClient } = await import("../js/adapters/ai/worker/SearchWorkerClient.js");
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const workers = [];
    class HeldWorker {
      constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; workers.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated = true; }
      emit(message) { this.listeners.get("message")({ data: message }); }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: HeldWorker });
    const { game, actor, owner, receiver, rootCard, context } = makeWorkerDecisionFixture("transfer");
    game.searchExecutor.dispose();
    const client = createSearchWorkerClient("searchWorker.js", {
      setTimeout: () => { throw new Error("完整决策不得创建 watchdog/deadline"); }
    });
    game.aiController.searchExecutor = client;
    try {
      const calls = [
        () => game.aiController.choosePostCounterResource(actor, owner, { purpose: "transfer", receiver, card: rootCard }),
        () => game.aiController.shouldRespond(owner, "counter", context, [owner.hand[0]]),
        () => game.aiController.assessDyingRescue(owner, receiver),
        () => game.aiController.choosePublicCard(actor, [rootCard])
      ];
      for (const call of calls) {
        const pending = call();
        const occupied = workers.at(-1);
        const message = occupied.messages[0];
        assert.ok(message.request.kind);
        assert.equal(message.request.searchConfig, undefined);
        client.cancel(message.requestId);
        assert.equal(await pending, null);
        assert.equal(occupied.terminated, true);
        assert.equal(client.getLifecycleDiagnostics().activeSearchCount, 0);
        assert.equal(client.getLifecycleDiagnostics().activeWorkerCount, 1);
        const next = call();
        const current = workers.at(-1);
        const currentMessage = current.messages[0];
        let settled = false;
        next.then(() => { settled = true; });
        occupied.emit({ type: "RESULT", requestId: message.requestId, outcome: { kind: message.type, requestId: message.requestId, gameId: message.request.gameId, decision: true } });
        await Promise.resolve();
        assert.equal(settled, false, "旧实例结果不能结算当前 request");
        client.cancel(currentMessage.requestId);
        assert.equal(await next, null);
      }
      const pending = calls[1]();
      client.dispose();
      assert.equal(await pending, null);
      assert.equal(client.getLifecycleDiagnostics().activeWorkerCount, 0);
      assert.equal(client.getLifecycleDiagnostics().activeSearchCount, 0);
    } finally {
      client.dispose(); game.dispose();
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
      else delete globalThis.Worker;
    }
  });

  slowTest("AI·Worker 决策：拒绝改变 Transfer 公开方向或伪造已知牌身份", async () => {
    const { game, actor, owner, receiver, rootCard } = makeWorkerDecisionFixture("transfer");
    try {
      const before = game.aiController.searchRng.snapshot();
      for (const decision of [
        { sourceId: owner.id, receiverId: actor.id, zone: "hand", selectionKind: "unknown", knownCardIds: [] },
        { sourceId: owner.id, receiverId: receiver.id, zone: "hand", selectionKind: "known", cardId: owner.hand[0].id, definitionId: "counter" }
      ]) {
        game.aiController.searchExecutor = { async search(request) { return { kind: request.kind, requestId: request.requestId, gameId: request.gameId, decision }; } };
        await assert.rejects(game.aiController.choosePostCounterResource(actor, owner, {
          purpose: "transfer", receiver, card: rootCard
        }), /invalid canonical resource selection/);
        assert.deepEqual(game.aiController.searchRng.snapshot(), before);
      }
    } finally { game.dispose(); }
  });

  slowTest("AI·Worker 决策：过期响应不得支付 Counter 或继续旧反制链", async () => {
    for (const change of ["version", "dispose"]) {
      const { game, actor, owner, rootCard } = makeWorkerDecisionFixture("plunder");
      let release, notify;
      const sent = new Promise(resolve => { notify = resolve; });
      let requestCount = 0;
      game.aiController.searchExecutor = {
        search(request) {
          requestCount += 1;
          notify(request);
          return new Promise(resolve => { release = resolve; });
        }
      };
      const before = owner.hand.map(card => card.id);
      const pending = game.responseWorkflow.askForCounter(actor, rootCard, [owner], { responders: [owner] });
      const request = await sent;
      if (change === "dispose") game.dispose();
      else transitionChangeShield(game.state, owner, 1);
      release({ requestId: request.requestId, gameId: request.gameId, kind: request.kind, decision: true });
      const result = await pending;
      assert.equal(result.status, "cancelled", change);
      assert.deepEqual(owner.hand.map(card => card.id), before, change);
      assert.equal(game.state.pendingResponses.length, 0);
      assert.equal(requestCount, 1, "过期响应不得进入下一层反制或请求");
      game.dispose();
    }
  });


  /*
  功能
  验证 Worker-safe search runtime 通过 periodic macrotask yield 保持 main thread/heartbeat 可运行。

  调用方
  当前测试。

  输入
  无。

  输出
  无返回值，断言失败时抛错。

  读取状态
  SearchRequest/WorkerSearchRuntime。

  写入状态
  测试 interval 计数器。

  调用函数
  runSearchRequest、setInterval、clearInterval。

  边界与不变量
  不依赖 wall-clock 精确值；只证明搜索期间事件循环可运行。
  */
  async function frArch14MainThreadResponsiveness() {
    const { runSearchRequest } = await import("../js/adapters/ai/worker/WorkerSearchRuntime.js");
    const { createSearchRequest } = await import("../js/ai/Controller.js");
    const actor = makePlayer("heart-actor", 0, "dawn", "ai", 0);
    const enemy = makePlayer("heart-enemy", 1, "dusk", "ai", 1);
    for (let index = 0; index < CARD_COUNTS.exposeWeakness; index += 1) {
      actor.hand.push(instance("exposeWeakness"));
    }
    const { game } = makeGame([actor, enemy]);
    game.aiSearchNodeBudgetOverride = 100;
    const roots = game.aiController.getActionCandidates(actor);
    const request = createSearchRequest({
      requestId: "heartbeat-1",
      gameId: game.state.gameId,
      stateVersion: game.state.stateVersion,
      actorId: actor.id,
      phase: game.state.phase,
      currentRound: game.state.currentRound,
      world: createInitialWorld(actor.id, game.state, { assault: 1, charge: 1 }),
      searchConfig: {
        ...game.aiController.buildSearchConfig(),
        yieldEvery: 1
      },
      rng: game.aiController.searchRng.snapshot(),
      rootActions: roots
    });
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 0);
    try {
      const outcome = await runSearchRequest(request, {
        yieldControl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return true;
        }
      });
      assert.ok(heartbeats > 0, "搜索期间 main thread/heartbeat 必须获得运行机会");
      assert.equal(outcome.workerError, null);
    } finally {
      clearInterval(timer);
      game.dispose();
    }
  }

  slowTest("AI·Worker 响应性：Worker-safe search yield 保持 main-thread heartbeat", frArch14MainThreadResponsiveness);

  /*
  功能
  通过真实 AIController.selectAction 与 SearchWorkerClient 协议边界验证 decision 期间 heartbeat 和 search 生命周期。

  调用方
  AI Worker production-path responsiveness regression。

  输入
  无。

  输出
  无返回值，断言失败时抛错。

  读取状态
  AIController、SearchWorkerClient lifecycle 与 WorkerSearchRuntime outcome。

  写入状态
  临时 global Worker protocol double、独立测试 Game 与 heartbeat timer。

  调用函数
  createSearchWorkerMessageHandler、makeGame、AIController.selectAction、setInterval、clearInterval。

  边界与不变量
  测试必须经过实际 SearchWorkerClient.search；不使用脆弱的固定 heartbeat gap 上限，只证明 decision 生命周期持续让出事件循环且 terminal 后无 active/orphan search。
  */
  async function frArch14ControllerWorkerClientHeartbeat() {
    const { createSearchWorkerMessageHandler } = await import(
      "../js/adapters/ai/worker/searchWorker.js"
    );
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    class ProtocolWorker {
      constructor() {
        this.listeners = new Map();
        this.terminated = false;
        this.handler = createSearchWorkerMessageHandler({
          candidateExecutor: null,
          postMessage: (data) => {
            setTimeout(() => {
              if (!this.terminated) this.emit("message", structuredClone(data));
            }, 0);
          }
        });
      }
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      }
      postMessage(message) {
        if (this.terminated) throw new Error("Worker terminated");
        setTimeout(() => {
          if (!this.terminated) this.handler.handleMessage(structuredClone(message));
        }, 0);
      }
      terminate() { this.terminated = true; this.handler.dispose(); }
      emit(type, data) {
        const event = type === "message" ? { data } : data ?? {};
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: ProtocolWorker
    });
    let game = null;
    let timer = null;
    try {
      const actor = makePlayer("client-heart-actor", 0, "dawn", "ai", 0);
      const enemy = makePlayer("client-heart-enemy", 1, "dusk", "ai", 1);
      for (let index = 0; index < CARD_COUNTS.exposeWeakness; index += 1) {
        actor.hand.push(instance("exposeWeakness"));
      }
      ({ game } = makeGame([actor, enemy]));
      game.aiSearchNodeBudgetOverride = 100;
      const buildSearchConfig = game.aiController.buildSearchConfig.bind(game.aiController);
      game.aiController.buildSearchConfig = (options) => ({
        ...buildSearchConfig(options),
        yieldEvery: 1
      });
      const executor = game.aiController.searchExecutor;
      assert.equal(executor.transport, "dedicated-worker");
      const heartbeatTimes = [];
      timer = setInterval(() => {
        heartbeatTimes.push(globalThis.performance?.now?.() ?? Date.now());
      }, 0);
      const selected = await game.aiController.selectAction(actor, {
        gameId: game.state.gameId
      });
      clearInterval(timer);
      const gaps = heartbeatTimes.slice(1).map((time, index) => time - heartbeatTimes[index]);
      const maxHeartbeatGap = gaps.length ? Math.max(...gaps) : 0;
      const lifecycle = executor.getLifecycleDiagnostics();
      const decision = game.aiController.lastDecisionDiagnostics;
      assert.ok(heartbeatTimes.length > 0,
        "AIController.selectAction → SearchWorkerClient 期间 heartbeat 必须获得执行机会");
      assert.ok(maxHeartbeatGap >= 0);
      assert.equal(lifecycle.searchStarted, 1);
      assert.equal(lifecycle.activeSearchCount, 0);
      assert.equal(lifecycle.activeWorkerCount, 1);
      assert.equal(lifecycle.orphanSearchCount, 0);
      assert.equal(lifecycle.searchCompleted + lifecycle.searchTimedOut, 1);
      assert.ok(decision.preWorkerMs >= 0);
      assert.ok(decision.postMessageMs >= 0);
      assert.ok(decision.workerSearchMs >= 0);
      assert.ok(decision.postWorkerMs >= 0);
      game.dispose();
      assert.equal(executor.getLifecycleDiagnostics().activeWorkerCount, 0);
      game = null;
    } finally {
      if (timer !== null) clearInterval(timer);
      game?.dispose();
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
      else delete globalThis.Worker;
    }
  }

  slowTest("AI·Worker 响应性：真实 selectAction → SearchWorkerClient heartbeat 与 terminal lifecycle", frArch14ControllerWorkerClientHeartbeat);

}
