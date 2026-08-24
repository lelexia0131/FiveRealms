/*
模块职责
拥有 Dedicated AI Worker 返回的 data-only outcome contract；Main Thread acceptance 才产生最终 SearchResult status。

上游
WorkerSearchRuntime 与 Worker transport。

下游
AIController.acceptWorkerSearchOutcome。

状态边界
只保存冻结普通值；不写 GameState。

信息边界
只保存 Action/计划描述/stats/rngAfter；不保存真实实体或函数。

架构约束
不得 import Game/Application/Domain transitions；不得声称 ACCEPTED 或 Domain legality。
*/

/*
功能
创建 Worker search outcome。

调用方
WorkerSearchRuntime.runSearchRequest。

输入
request、actionDescriptor、plannedSequenceDescriptors、stats、searchStopReason、rngAfter、cancelled 与 workerError。

输出
冻结 data-only outcome。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
actionDescriptor/plannedSequenceDescriptors 必须是已投影 descriptor；不保存 raw action。
*/
export function createWorkerSearchOutcome({
  request,
  action = null,
  plannedActions = [],
  stats = null,
  searchStopReason = null,
  rngAfter = null,
  cancelled = false,
  workerError = null
}) {
  return Object.freeze({
    requestId:request.requestId,
    gameId:request.gameId,
    stateVersion:request.stateVersion,
    actorId:request.actorId,
    action,
    plannedActions:Object.freeze((plannedActions ?? []).map(
      (plannedAction) => plannedAction
    )),
    stats:stats ? Object.freeze({ ...stats }) : null,
    searchStopReason,
    rngAfter:rngAfter ? Object.freeze({ ...rngAfter }) : null,
    cancelled,
    workerError
  });
}

/*
功能
验证 outcome 是否可被 Main Thread 安全处理。

调用方
Worker transport 与测试。

输入
outcome 与 request。

输出
data-only/request identity violations 数组。

读取状态
无。

写入状态
无。

调用函数
Object.entries。

边界与不变量
未知 requestId、缺失 rngAfter、实体字段或函数字段均 fail safe。
*/
export function workerOutcomeViolations(outcome, request = null) {
  const violations = [];
  if (!outcome || typeof outcome !== "object") return ["outcome-not-object"];
  if (request && outcome.requestId !== request.requestId) violations.push("requestId mismatch");
  if (request && outcome.gameId !== request.gameId) violations.push("gameId mismatch");
  if (request && outcome.stateVersion !== request.stateVersion) violations.push("stateVersion mismatch");
  if (!outcome.rngAfter || typeof outcome.rngAfter.state !== "number") violations.push("rngAfter missing");
  for (const [key, value] of Object.entries(outcome)) {
    if (typeof value === "function") violations.push(`function:${key}`);
  }
  return violations;
}
