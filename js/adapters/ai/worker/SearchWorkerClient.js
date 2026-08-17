/*
模块职责
Main-thread Dedicated AI Worker client：负责 Worker 创建、SEARCH/CANCEL transport、hard watchdog 与 terminal promise；不执行任何 search/domain 逻辑。

上游
Game composition / createSearchExecutor。

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
创建 Dedicated Browser Worker client。

调用方
createSearchExecutor。

输入
Worker URL。

输出
{ transport, search, cancel, dispose }。

读取状态
无。

写入状态
Worker 引用与 pending map。

调用函数
Worker、addEventListener、postMessage、terminate、setTimeout。

边界与不变量
一个 requestId 只 settle 一次；duplicate RESULT ignored；watchdog 高于 search deadline 且只终止失控 Worker；terminate 后重建下一次 Worker。
*/
export function createSearchWorkerClient(workerUrl) {
  let worker = null;
  let pending = null;
  let disposed = false;
  let watchdogTimer = null;

  /*
  功能
  创建并接线一个新的 Dedicated Worker。

  调用方
  createSearchWorkerClient 初始化与 watchdog 重建。

  输入
  无。

  输出
  无返回值；更新闭包 worker。

  读取状态
  workerUrl。

  写入状态
  worker 与事件监听。

  调用函数
  Worker、addEventListener。

  边界与不变量
  old Worker 不共享 pending；重建后仍只接受当前 requestId。
  */
  const spawnWorker = () => {
    worker = new Worker(workerUrl, { type:"module" });
    worker.addEventListener("message", (event) => {
      const message = event.data ?? {};
      if (disposed || !pending || message.requestId !== pending.requestId) return;
      if (message.type === "RESULT") {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
        pending.resolve(message.outcome);
        pending = null;
      } else if (message.type === "ERROR") {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
        pending.reject(new Error(message.workerError ?? "AI Worker error"));
        pending = null;
      }
    });
    worker.addEventListener("error", (event) => {
      settleError(new Error(event.message || "AI Worker crashed"));
      // Worker error 后该实例不可继续复用；立即重建，下一次搜索不需要先撞 watchdog。
      worker.terminate();
      if (!disposed) spawnWorker();
    });
    worker.addEventListener("messageerror", () => {
      settleError(new Error("AI Worker message deserialization failed"));
      worker.terminate();
      if (!disposed) spawnWorker();
    });
  };

  /*
  功能
  以错误结算当前 pending search promise。

  调用方
  cancel/dispose/watchdog/error handlers。

  输入
  Error。

  输出
  无。

  读取状态
  pending 与 watchdogTimer。

  写入状态
  pending 清空并 reject。

  调用函数
  clearTimeout。

  边界与不变量
  一个 promise 只 settle 一次。
  */
  const settleError = (error) => {
    if (!pending) return;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    pending.reject(error);
    pending = null;
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
    AIController。

    输入
    SearchRequest。

    输出
    Promise<WorkerSearchOutcome>；in-flight/watchdog/cancel/dispose 时 reject。

    读取状态
    disposed/pending/request.searchConfig.hardWatchdogMs。

    写入状态
    pending 与 watchdogTimer。

    调用函数
    worker.postMessage、setTimeout。

    边界与不变量
    同一 client 同时只允许一个 in-flight search；watchdog 只终止失控 Worker 并重建。
    */
    search(request) {
      if (disposed) return Promise.reject(new Error("AI Worker disposed"));
      if (pending) return Promise.reject(new Error("another AI search is in-flight"));
      return new Promise((resolve, reject) => {
        pending = { requestId:request.requestId, resolve, reject };
        try {
          worker.postMessage({ type:"SEARCH", requestId:request.requestId, request });
        } catch (error) {
          // structuredClone/Worker 发送失败必须清空 pending，否则下一次合法搜索会被
          // “another AI search is in-flight”永久误伤；本路径不执行任何同线程 fallback。
          settleError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const watchdogMs = Number(request.searchConfig?.hardWatchdogMs);
        if (Number.isFinite(watchdogMs) && watchdogMs > 0) {
          watchdogTimer = setTimeout(() => {
            try {
              worker.postMessage({ type:"CANCEL", requestId:request.requestId });
            } catch { /* worker 已不可用，settleError 仍必须收束 pending。 */ }
            settleError(new Error("AI search hard watchdog"));
            worker.terminate();
            if (!disposed) spawnWorker();
          }, watchdogMs);
        }
      });
    },
    /*
    功能
    取消指定 in-flight Worker search。

    调用方
    AIController/Game lifecycle。

    输入
    requestId。

    输出
    无。

    读取状态
    pending。

    写入状态
    pending reject 并清空。

    调用函数
    worker.postMessage、settleError。

    边界与不变量
    不终止 healthy Worker；cancelled promise 永不 resolve outcome。
    */
    cancel(requestId) {
      if (!pending || pending.requestId !== requestId) return;
      try {
        worker.postMessage({ type:"CANCEL", requestId });
      } catch { /* postMessage 失败时仍按取消收束，不留下悬挂 pending。 */ }
      settleError(new Error("AI search cancelled"));
    },
    /*
    功能
    终止 Worker 并取消 in-flight search。

    调用方
    Game.dispose。

    输入
    无。

    输出
    无。

    读取状态
    disposed/pending/watchdogTimer。

    写入状态
    pending reject、timer 清理、Worker terminate。

    调用函数
    clearTimeout、settleError、worker.terminate。

    边界与不变量
    dispose 后不再接受新 search。
    */
    dispose() {
      disposed = true;
      clearTimeout(watchdogTimer);
      settleError(new Error("AI Worker disposed"));
      worker.terminate();
    }
  });
}
