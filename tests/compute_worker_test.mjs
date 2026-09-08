import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ComputeWorkerPool } from "../js/adapters/ai/worker/ComputeWorkerPool.js";
import { createSearchEngine, executeSearchRequest } from "../js/ai/Controller.js";
import { Rng } from "../js/ai/Searcher/Rng.js";
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
test 注册函数。

输出
无。

读取状态
固定基线与正式 Search 模块。

写入状态
测试注册表与独立 Worker。

调用函数
createSearchEngine、executeSearchRequest、ComputeWorkerPool。

边界与不变量
不运行 Balance，不输出大段 JSON；所有 Worker 必须清理。
*/
export function registerComputeWorkerTests(test) {
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

  test("AI·Compute Worker：pure compute 抽取与封板基线逐候选等价", async () => {
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

  test("AI·Compute Worker：真实 poolSize 1/2/4 NODE、coverage、World 与 RNG 一致", async () => {
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

  test("AI·Compute Worker：真实 Worker compute ERROR 通过现有 Search fault contract 传播", async () => {
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
}
