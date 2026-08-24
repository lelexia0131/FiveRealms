/*
模块职责
在 Worker-safe runtime 中执行一次 SearchRequest，返回 data-only WorkerSearchOutcome；这是 production Worker 与 headless test transport 共享的唯一 search execution entry。

上游
Dedicated Worker entry、headless local executor 与测试。

下游
SearchEngineFactory 与 Searcher。

状态边界
只写 Worker 本地 World/RNG/Searcher 诊断；不写 GameState 或 Main Thread 状态。

信息边界
只消费 SearchRequest；不读取 Game/Application/UI/DOM/真实 hidden entities。

架构约束
不得 import composition、application、UI/Audio/DOM 或 Domain transitions；不得使用 Math.random。
*/
import { SearchRng } from "../../../ai/search/SearchRng.js";
import { createSearchEngine } from "./SearchEngineFactory.js";
import { createWorkerSearchOutcome } from "../../../ai/search/WorkerSearchOutcome.js";

/*
功能
执行一次 Worker-safe search request。

调用方
searchWorker onmessage、LocalSearchExecutor 与纯 runtime 测试。

输入
SearchRequest 与 { yieldControl, now } runtime control。

  输出
  WorkerSearchOutcome；Worker error 时返回 workerError outcome 且无 actionDescriptor，
  成功时 stats 含 Worker 墙钟耗时与 workerReturned=true。

读取状态
request.world/searchConfig/rng/rootActions。

写入状态
Worker 本地 rng/searcher/simulator 状态。

调用函数
SearchRng.restore、consume canonical root Action、createSearchEngine、Searcher.search、createWorkerSearchOutcome。

边界与不变量
rngAfter 必须存在；cancelled/error 不返回可执行 descriptor；root action rehydrate 失败只产生 workerError。
*/
export async function runSearchRequest(request, runtimeControl = {}) {
  let rng;
  const workerStartedAt = globalThis.performance?.now?.() ?? Date.now();
  try {
    rng = SearchRng.restore(request.rng);
    const actor = request.world.players.find((player) => player.id === request.actorId) ?? null;
    if (!actor) throw new Error(`Worker World 缺少 actor：${request.actorId}`);
    const rootActions = request.rootActions;
    const engine = createSearchEngine(request, rng, runtimeControl);
    const action = await engine.searcher.search(
      actor,
      request.world,
      rootActions,
      {
        gameId:request.gameId,
        rootCandidateCount:rootActions.length
      }
    );
    const cancelled = engine.searcher.lastSearchStats?.stopReason === "CANCELLED";
    const workerFinishedAt = globalThis.performance?.now?.() ?? Date.now();
    return createWorkerSearchOutcome({
      request,
      action:cancelled ? null : action,
      plannedActions:cancelled ? [] : engine.searcher.lastSequence,
      stats:{
        ...engine.searcher.lastSearchStats,
        workerSearchMs:Math.max(0, workerFinishedAt - workerStartedAt),
        workerReturned:true
      },
      searchStopReason:engine.searcher.lastSearchStats?.stopReason ?? null,
      rngAfter:rng.snapshot(),
      cancelled
    });
  } catch (error) {
    return createWorkerSearchOutcome({
      request,
      action:null,
      plannedActions:[],
      stats:null,
      searchStopReason:null,
      rngAfter:rng ? rng.snapshot() : null,
      cancelled:false,
      workerError:error instanceof Error ? error.message : String(error)
    });
  }
}
