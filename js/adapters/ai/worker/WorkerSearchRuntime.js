/*
模块职责
在 Worker-safe runtime 中执行一次 SearchRequest，返回 data-only WorkerSearchOutcome；这是 production Worker 与 headless test transport 共享的唯一 search execution entry。

上游
Dedicated Worker entry、headless local executor 与测试。

下游
SearchEngineFactory、RootSearchAction、Planner、ActionDescriptor 与 WorkerSearchOutcome。

状态边界
只写 Worker 本地 SearchState/RNG/Planner 诊断；不写 GameState 或 Main Thread 状态。

信息边界
只消费 SearchRequest；不读取 Game/Application/UI/DOM/真实 hidden entities。

架构约束
不得 import core/Game、application、UI/Audio/DOM 或 Domain transitions；不得使用 Math.random。
*/
import { describeAction } from "../../../ai/search/ActionDescriptor.js?build=20260816-legacy-recovery";
import { rehydrateRootSearchAction } from "../../../ai/search/RootSearchAction.js?build=20260816-legacy-recovery";
import { SearchRng } from "../../../ai/search/SearchRng.js?build=20260816-legacy-recovery";
import { createSearchEngine } from "./SearchEngineFactory.js?build=20260816-legacy-recovery";
import { createWorkerSearchOutcome } from "../../../ai/search/WorkerSearchOutcome.js?build=20260816-legacy-recovery";

/*
功能
执行一次 Worker-safe search request。

调用方
searchWorker onmessage、LocalSearchExecutor 与纯 runtime 测试。

输入
SearchRequest 与 { yieldControl, now } runtime control。

输出
WorkerSearchOutcome；Worker error 时返回 workerError outcome 且无 actionDescriptor。

读取状态
request.searchState/searchConfig/rng/rootSearchActions。

写入状态
Worker 本地 rng/planner/simulator 状态。

调用函数
SearchRng.restore、rehydrateRootSearchAction、createSearchEngine、Planner.plan、describeAction、createWorkerSearchOutcome。

边界与不变量
rngAfter 必须存在；cancelled/error 不返回可执行 descriptor；root action rehydrate 失败只产生 workerError。
*/
export async function runSearchRequest(request, runtimeControl = {}) {
  let rng;
  try {
    rng = SearchRng.restore(request.rng);
    const actor = request.searchState.players.find((player) => player.id === request.actorId) ?? null;
    if (!actor) throw new Error(`Worker SearchState 缺少 actor：${request.actorId}`);
    const rootActions = request.rootSearchActions.map(
      (record) => rehydrateRootSearchAction(record, request.searchState, actor)
    );
    const engine = createSearchEngine(request, rng, runtimeControl);
    const action = await engine.planner.plan(
      actor,
      request.searchState,
      rootActions,
      { gameId:request.gameId }
    );
    const cancelled = engine.planner.lastSearchStats?.stopReason === "CANCELLED";
    return createWorkerSearchOutcome({
      request,
      actionDescriptor:cancelled ? null : describeAction(action),
      plannedSequenceDescriptors:cancelled ? [] : engine.planner.lastPlannedSequence,
      stats:engine.planner.lastSearchStats,
      searchStopReason:engine.planner.lastSearchStats?.stopReason ?? null,
      rngAfter:rng.snapshot(),
      cancelled
    });
  } catch (error) {
    return createWorkerSearchOutcome({
      request,
      actionDescriptor:null,
      plannedSequenceDescriptors:[],
      stats:null,
      searchStopReason:null,
      rngAfter:rng ? rng.snapshot() : null,
      cancelled:false,
      workerError:error instanceof Error ? error.message : String(error)
    });
  }
}
