/*
模块职责
Main-thread Dedicated AI Worker client：负责 Worker 创建、SEARCH/CANCEL transport、hard watchdog 与 terminal promise；不执行任何 search/domain 逻辑。

上游
MatchApplication composition / createSearchExecutor。

下游
searchWorker.js。

状态边界
只写 client 局部 pending promise 与 Worker 引用；不写 GameState。

信息边界
只 transport data-only SearchRequest/WorkerSearchOutcome。

架构约束
不得 import composition、application、UI/Audio；不提供同线程 search fallback。
*/

/*
功能
读取 Dedicated Worker transport diagnostics 使用的单调墙钟。

调用方
createSearchWorkerClient.search。

输入
无。

输出
当前高精度毫秒时间；运行时不支持 performance 时回退 Date.now。

读取状态
globalThis.performance。

写入状态
无。

调用函数
performance.now、Date.now。

边界与不变量
只测量同步 postMessage 返回时间，不参与 watchdog 或搜索预算。
*/
function transportNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/*
功能
创建 Dedicated Browser Worker client。

调用方
createSearchExecutor。

输入
Worker URL 与可选 timer capability；默认使用 globalThis.setTimeout/clearTimeout。

输出
{ transport, search, lifecycle diagnostics, cancel, dispose }。

读取状态
无。

写入状态
Worker 引用与 pending map。

调用函数
Worker、addEventListener、postMessage、terminate、scheduleTimeout、cancelTimeout。

边界与不变量
一个 requestId 只 settle 一次；duplicate RESULT ignored；正常 TIME/NODE 复用已空闲 Worker，cancel/watchdog 终止仍占用请求的实例并只重建一次。
*/
export function createSearchWorkerClient(workerUrl, timers = {}) {
  const scheduleTimeout = typeof timers.setTimeout === "function"
    ? timers.setTimeout
    : globalThis.setTimeout;
  const cancelTimeout = typeof timers.clearTimeout === "function"
    ? timers.clearTimeout
    : globalThis.clearTimeout;
  let worker = null;
  let pending = null;
  let disposed = false;
  let watchdogTimer = null;
  let lastTransportDiagnostics = null;
  const liveWorkers = new Set();
  const lifecycle = {
    workerCreated:0,
    workerTerminated:0,
    searchStarted:0,
    searchCompleted:0,
    searchTimedOut:0,
    searchCancelled:0,
    searchWatchdog:0,
    searchFaulted:0,
    orphanSearchCount:0
  };

  /*
  功能
  终止一个仍存活的 Worker 实例并维护唯一生命周期计数。

  调用方
  cancel、dispose、watchdog、error/messageerror recovery。

  输入
  要终止的 Worker 实例。

  输出
  首次终止返回 true；已终止或空实例返回 false。

  读取状态
  liveWorkers 与当前 worker。

  写入状态
  liveWorkers、worker 与 workerTerminated。

  调用函数
  Worker.terminate。

  边界与不变量
  同一实例只计数和 terminate 一次；终止旧实例不得触碰已经重建的新 Worker。
  */
  const terminateWorker = (target) => {
    if (!target || !liveWorkers.has(target)) return false;
    liveWorkers.delete(target);
    if (worker === target) worker = null;
    target.terminate();
    lifecycle.workerTerminated += 1;
    return true;
  };

  /*
  功能
  结算当前 pending search 的生命周期计数并释放 in-flight 占用。

  调用方
  Worker RESULT/ERROR、cancel、watchdog、dispose 与 transport error。

  输入
  terminal kind、可选 outcome/error。

  输出
  成功结算返回 true；没有 pending 时返回 false。

  读取状态
  pending 与 watchdogTimer。

  写入状态
  pending、watchdogTimer 与 search lifecycle counters。

  调用函数
  cancelTimeout、pending.resolve/reject。

  边界与不变量
  一个 request 只减少一次 active search；迟到消息和重复 terminal 不得再次计数或 settle。
  */
  const settlePending = (kind, payload) => {
    if (!pending) return false;
    const current = pending;
    cancelTimeout(watchdogTimer);
    watchdogTimer = null;
    pending = null;
    if (kind === "TIME") lifecycle.searchTimedOut += 1;
    else if (kind === "CANCELLED") lifecycle.searchCancelled += 1;
    else if (kind === "WATCHDOG") lifecycle.searchWatchdog += 1;
    else if (kind === "FAULT") lifecycle.searchFaulted += 1;
    else lifecycle.searchCompleted += 1;
    if (kind === "RESULT" || kind === "TIME") current.resolve(payload);
    else current.reject(payload);
    return true;
  };

  /*
  功能
  创建并接线一个新的 Dedicated Worker。

  调用方
  createSearchWorkerClient 初始化与 watchdog 重建。

  输入
  无。

  输出
  新 Worker 实例；disposed 时返回 null。

  读取状态
  workerUrl。

  写入状态
  worker、liveWorkers、workerCreated 与事件监听。

  调用函数
  Worker、addEventListener。

  边界与不变量
  old Worker 不共享 pending；事件必须同时匹配当前 Worker 实例与 requestId，迟到消息不得命中新请求。
  */
  const spawnWorker = () => {
    if (disposed) return null;
    const spawned = new Worker(workerUrl, { type:"module" });
    worker = spawned;
    liveWorkers.add(spawned);
    lifecycle.workerCreated += 1;
    spawned.addEventListener("message", (event) => {
      const message = event.data ?? {};
      if (spawned !== worker || disposed || !pending
        || pending.worker !== spawned || message.requestId !== pending.requestId) return;
      if (message.type === "RESULT") {
        const kind = message.outcome?.searchStopReason === "TIME"
          ? "TIME"
          : message.outcome?.searchStopReason === "CANCELLED"
            ? "CANCELLED"
            : "RESULT";
        settlePending(
          kind === "CANCELLED" && message.outcome?.action ? "RESULT" : kind,
          kind === "CANCELLED" && !message.outcome?.action
            ? new Error("AI search cancelled")
            : message.outcome
        );
      } else if (message.type === "ERROR") {
        settlePending("FAULT", new Error(message.workerError ?? "AI Worker error"));
      }
    });
    spawned.addEventListener("error", (event) => {
      if (spawned !== worker) return;
      settlePending("FAULT", new Error(event.message || "AI Worker crashed"));
      // Worker error 后该实例不可继续复用；立即重建，下一次搜索不需要先撞 watchdog。
      terminateWorker(spawned);
      if (!disposed) spawnWorker();
    });
    spawned.addEventListener("messageerror", () => {
      if (spawned !== worker) return;
      settlePending("FAULT", new Error("AI Worker message deserialization failed"));
      terminateWorker(spawned);
      if (!disposed) spawnWorker();
    });
    return spawned;
  };

  // 初始 Worker 必须与 watchdog 重建路径走同一 wiring；否则首个 SEARCH 没有
  // message/error listener，只能等 hard watchdog 误杀一次后才恢复。
  spawnWorker();

  return Object.freeze({
    transport:"dedicated-worker",
    /*
    功能
    向 Worker 发送一个 SEARCH 请求并返回 terminal outcome promise。

    调用方
    Controller。

    输入
    SearchRequest。

    输出
    Promise<WorkerSearchOutcome>；in-flight/watchdog/cancel/dispose 时 reject。

    读取状态
    disposed/pending/request.searchConfig.hardWatchdogMs。

    写入状态
    pending、watchdogTimer 与最近一次同步 postMessage 诊断。

    调用函数
    worker.postMessage、scheduleTimeout。

    边界与不变量
    同一 client 同时只允许一个 in-flight search；TIME/NODE outcome 不得被 transport 降级为 CANCEL，hard watchdog 才终止失控 Worker并重建。
    */
    search(request) {
      if (disposed) return Promise.reject(new Error("AI Worker disposed"));
      if (pending) return Promise.reject(new Error("another AI search is in-flight"));
      return new Promise((resolve, reject) => {
        const occupiedWorker = worker;
        pending = { requestId:request.requestId, resolve, reject, worker:occupiedWorker };
        lifecycle.searchStarted += 1;
        const postMessageStartedAt = transportNow();
        try {
          occupiedWorker.postMessage({ type:"SEARCH", requestId:request.requestId, request });
        } catch (error) {
          lastTransportDiagnostics = Object.freeze({
            requestId:request.requestId,
            postMessageMs:Math.max(0, transportNow() - postMessageStartedAt)
          });
          // structuredClone/Worker 发送失败必须清空 pending，否则下一次合法搜索会被
          // “another AI search is in-flight”永久误伤；本路径不执行任何同线程 fallback。
          settlePending("FAULT", error instanceof Error ? error : new Error(String(error)));
          return;
        }
        lastTransportDiagnostics = Object.freeze({
          requestId:request.requestId,
          postMessageMs:Math.max(0, transportNow() - postMessageStartedAt)
        });
        const watchdogMs = Number(request.searchConfig?.hardWatchdogMs);
        if (Number.isFinite(watchdogMs) && watchdogMs > 0) {
          watchdogTimer = scheduleTimeout(() => {
            if (!pending || pending.requestId !== request.requestId
              || pending.worker !== occupiedWorker) return;
            try {
              occupiedWorker.postMessage({ type:"CANCEL", requestId:request.requestId });
            } catch { /* worker 已不可用，settlePending 仍必须收束 pending。 */ }
            settlePending("WATCHDOG", new Error("AI search hard watchdog"));
            terminateWorker(occupiedWorker);
            if (!disposed) spawnWorker();
          }, watchdogMs);
        }
      });
    },
    /*
    功能
    返回最近一次 SEARCH 同步 postMessage 的 transport 诊断。

    调用方
    Controller.selectAction diagnostics。

    输入
    无。

    输出
    { requestId, postMessageMs } 的隔离副本；尚未发送时返回 null。

    读取状态
    lastTransportDiagnostics。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    不暴露 pending/Worker 引用；计时不得改变 promise、watchdog 或消息契约。
    */
    getLastTransportDiagnostics() {
      return lastTransportDiagnostics ? { ...lastTransportDiagnostics } : null;
    },
    /*
    功能
    返回 Dedicated Worker/search 生命周期诊断的隔离快照。

    调用方
    runtime diagnostics 与 focused lifecycle regression。

    输入
    无。

    输出
    Worker/search terminal counters、active counts 与当前 requestId。

    读取状态
    lifecycle、liveWorkers 与 pending。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    不暴露 Worker/promise 引用；activeSearchCount 只由当前 pending 占用定义。
    */
    getLifecycleDiagnostics() {
      return {
        ...lifecycle,
        activeWorkerCount:liveWorkers.size,
        activeSearchCount:pending ? 1 : 0,
        requestId:pending?.requestId ?? null
      };
    },
    /*
    功能
    取消指定 in-flight Worker search。

    调用方
    Controller/MatchApplication lifecycle。

    输入
    requestId。

    输出
    无。

    读取状态
    pending。

    写入状态
    pending reject 并清空。

    调用函数
    Worker.postMessage、settlePending、terminateWorker、spawnWorker。

    边界与不变量
    只有匹配当前 pending request 的 cancel 才终止并重建其 Worker；cancelled promise 永不 resolve outcome，旧实例迟到消息不得结算新请求。
    */
    cancel(requestId) {
      if (!pending || pending.requestId !== requestId) return;
      const occupiedWorker = pending.worker;
      try {
        occupiedWorker.postMessage({ type:"CANCEL", requestId });
      } catch { /* postMessage 失败时仍按取消收束，不留下悬挂 pending。 */ }
      settlePending("CANCELLED", new Error("AI search cancelled"));
      // CANCEL 可能排在一个长同步 preparation 后才被 Worker 事件循环处理；
      // 先终止仍占用该 request 的实例，才能保证 decision 返回后没有 orphan CPU work。
      terminateWorker(occupiedWorker);
      if (!disposed) spawnWorker();
    },
    /*
    功能
    终止 Worker 并取消 in-flight search。

    调用方
    MatchApplication.dispose。

    输入
    无。

    输出
    无。

    读取状态
    disposed/pending/watchdogTimer。

    写入状态
    pending reject、timer 清理、Worker terminate。

    调用函数
    cancelTimeout、settlePending、terminateWorker。

    边界与不变量
    dispose 后不再接受新 search。
    */
    dispose() {
      disposed = true;
      cancelTimeout(watchdogTimer);
      if (pending) settlePending("CANCELLED", new Error("AI Worker disposed"));
      for (const liveWorker of [...liveWorkers]) terminateWorker(liveWorker);
    }
  });
}
