/*
模块职责
提供 Node/headless test 专用的 local search transport；它只调用与 Dedicated Worker 完全相同的 runSearchRequest，不复制 Searcher/Simulator。

上游
MatchApplication composition 在无 browser Worker 的 headless environment 注入。

下游
runSearchRequest。

状态边界
只写 executor 自身的 in-flight AbortController；不写 GameState。

信息边界
只转发 data-only SearchRequest。

架构约束
不得 import composition/application/UI/Audio；browser production 不得自动静默使用本 executor。
*/
import { runSearchRequest } from "./WorkerSearchRuntime.js";

/*
功能
创建 headless local search executor。

调用方
createSearchExecutor 与测试。

输入
无。

输出
{ transport, search, cancel, dispose }。

读取状态
无。

写入状态
executor 局部 controller。

调用函数
runSearchRequest、setTimeout。

边界与不变量
cancelled search 仍返回 runSearchRequest 的 cancelled outcome；不会从主线程直接执行 Searcher。
*/
export function createLocalSearchExecutor() {
  let controller = null;
  return Object.freeze({
    transport:"headless-local",
    /*
    功能
    以 local transport 执行一次 WorkerSearchRuntime.search。

    调用方
    Controller 与测试。

    输入
    SearchRequest 与可选 signal。

    输出
    Promise<WorkerSearchOutcome>；hard watchdog/session cancel 可 reject。

    读取状态
    无。

    写入状态
    executor 局部 controller。

    调用函数
    runSearchRequest、setTimeout。

    边界与不变量
    与 browser Worker 共享同一 runSearchRequest；正常时间模式由 SearchBudget.TIME 收束，节点模式由 NODE 自然收束；
    local transport 无法终止同步 work，显式 NODE 诊断不得用 Promise race 伪造提前结果；不直接运行 Searcher。
    */
    async search(request, options = {}) {
      controller = options.signal instanceof AbortController
        ? options.signal
        : new AbortController();
      const signal = controller.signal;
      const watchdogMs = Number(request.searchConfig?.hardWatchdogMs);
      const nodeBudget = Number(request.searchConfig?.nodeBudget);
      const work = runSearchRequest(request, {
        now: () => globalThis.performance?.now?.() ?? Date.now(),
        yieldControl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return !signal.aborted;
        }
      });
      if (Number.isFinite(nodeBudget) && nodeBudget >= 1) return work;
      if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) return work;
      return Promise.race([
        work,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            controller.abort();
            reject(new Error("AI search hard watchdog"));
          }, watchdogMs);
          work.finally(() => clearTimeout(timer));
        })
      ]);
    },
    /*
    功能
    取消当前 in-flight local search。

    调用方
    Controller 生命周期。

    输入
    无。

    输出
    无。

    读取状态
    executor 局部 controller。

    写入状态
    controller abort。

    调用函数
    AbortController.abort。

    边界与不变量
    只取消 local transport，不写 GameState。
    */
    cancel() {
      controller?.abort();
    },
    /*
    功能
    终止 local executor 的 in-flight search。

    调用方
    MatchApplication.dispose。

    输入
    无。

    输出
    无。

    读取状态
    executor 局部 controller。

    写入状态
    controller abort 并清空。

    调用函数
    AbortController.abort。

    边界与不变量
    dispose 后不再保留 transport 状态。
    */
    dispose() {
      controller?.abort();
      controller = null;
    }
  });
}
