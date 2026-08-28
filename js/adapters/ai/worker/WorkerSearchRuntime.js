/*
模块职责
在 Worker-safe runtime 中执行一次 SearchRequest，返回 data-only WorkerSearchOutcome；这是 production Worker 与 headless test transport 共享的唯一 search execution entry。

上游
Dedicated Worker entry、headless local executor 与测试。

下游
public Searcher facade。

状态边界
只写 Worker 本地 World/RNG/Searcher 诊断；不写 GameState 或 Main Thread 状态。

信息边界
只消费 SearchRequest；不读取 Game/Application/UI/DOM/真实 hidden entities。

架构约束
不得 import composition、application、UI/Audio/DOM 或 Domain transitions；不得使用 Math.random。
*/
import {
  createWorkerSearchOutcome,
  executeSearchRequest
} from "../../../ai/Controller.js";

/*
功能
执行一次 Worker-safe search request。

调用方
searchWorker onmessage、LocalSearchExecutor 与纯 runtime 测试。

输入
SearchRequest 与 { yieldControl, now } runtime control。

  输出
  WorkerSearchOutcome；CANCELLED/FAULT 可同时携带中断前完整 incumbent 与 diagnostics，Worker error 无 canonical Action，
  成功时 stats 含 Worker 墙钟耗时与 workerReturned=true。

读取状态
request.world/searchConfig/rng/rootActions。

写入状态
Worker 本地 rng/searcher/simulator 状态。

调用函数
Rng.restore、consume canonical root Action、createSearchEngine、Searcher.search、createWorkerSearchOutcome。

边界与不变量
rngAfter 必须存在；Searcher 已收束的 fault 不得清空 action；只有 Searcher 无法产生 provisional action 的异常才产生 workerError。
*/
export async function runSearchRequest(request, runtimeControl = {}) {
  const workerStartedAt = globalThis.performance?.now?.() ?? Date.now();
  try {
    const result = await executeSearchRequest(request, runtimeControl);
    const workerFinishedAt = globalThis.performance?.now?.() ?? Date.now();
    return createWorkerSearchOutcome({ request,
      ...result,
      stats:{
        ...result.stats,
        workerSearchMs:Math.max(0, workerFinishedAt - workerStartedAt),
        workerReturned:true
      }
    });
  } catch (error) {
    return createWorkerSearchOutcome({ request,
      action:null,
      searchFault:{
        name:error instanceof Error ? error.name : "Error",
        message:error instanceof Error ? error.message : String(error)
      },
      rngAfter:request.rng,
      workerError:error instanceof Error ? error.message : String(error)
    });
  }
}
