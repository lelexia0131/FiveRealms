/*
模块职责
在 Worker-safe runtime 中分派完整搜索、响应与资源决策；production Worker 和 headless transport 共用 Controller 的纯计算。

上游
Dedicated Worker entry、headless local executor 与测试。

下游
Controller 组合的 Searcher public search facade。

状态边界
只写 Worker 本地 World/RNG/Searcher 诊断；不写 GameState 或 Main Thread 状态。

信息边界
只消费已过滤的 World 与公开决策输入；不读取 Game/Application/UI/DOM/真实 hidden entities。

架构约束
不得 import composition、application、UI/Audio/DOM 或 Domain transitions；不得使用 Math.random。
*/
import {
  createWorkerSearchOutcome,
  executeDecisionRequest,
  executeSearchRequest
} from "../../../ai/Controller.js";

/*
功能
执行一次 Worker-safe 搜索或完整响应/资源决策请求。

调用方
searchWorker onmessage、LocalSearchExecutor 与纯 runtime 测试。

输入
带 kind 的完整决策请求或 SearchRequest，与 { yieldControl, now } runtime control。

  输出
  WorkerSearchOutcome；CANCELLED 可携带中断前完整 incumbent，global invariant failure 只携带 diagnostics，
  成功时 stats 含 Worker 墙钟耗时与 workerReturned=true。
非搜索请求只返回最终 decision 与 workerComputeMs；真实异常抛给协议层。

读取状态
request.world/searchConfig/rng/rootActions。

写入状态
Worker 本地 rng/searcher/simulator 状态。

调用函数
Rng.restore、consume canonical root Action、createSearchEngine、Searcher.search、createWorkerSearchOutcome。

边界与不变量
搜索 rngAfter 必须存在；未产出完整 Searcher action 的 global invariant failure 只返回 searchFault。
非搜索决策不消耗 RNG，不经过 SearchBudget 或故障降级；workerError 只由 Worker transport/protocol 层产生。
*/
export async function runSearchRequest(request, runtimeControl = {}) {
  const workerStartedAt = globalThis.performance?.now?.() ?? Date.now();
  if (request.kind && request.kind !== "SEARCH") {
    // 资源/响应没有 SearchBudget，也不消耗 RNG；真实计算异常沿 ERROR 运输，不能改写为 PASS/END。
    const decision = await executeDecisionRequest(request, runtimeControl);
    return {
      kind:request.kind,
      requestId:request.requestId,
      gameId:request.gameId,
      decision,
      stats:{ workerComputeMs:Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - workerStartedAt) }
    };
  }
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
      rngAfter:request.rng
    });
  }
}
