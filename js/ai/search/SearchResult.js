/*
模块职责
拥有跨 AI search boundary 的 data-only result envelope；真实实体 rebind 与 legality 仍由 main-thread boundary 执行。

上游
AIController 与未来 Worker boundary。

下游
AIController acceptance boundary、TurnWorkflow 只经门面消费 action。

状态边界
只保存冻结普通值；不写 GameState。

信息边界
只保存 Action/计划描述与诊断，不保存真实 Card/Player/World/Simulator。

架构约束
不得 import Game/Application/Domain transitions；不得返回函数或 mutable candidate。
*/
export const SEARCH_RESULT_STATUS = Object.freeze({
  ACCEPTED:"ACCEPTED",
  STALE_VERSION:"STALE_VERSION",
  INVALID_SESSION:"INVALID_SESSION",
  INVALID_ACTOR:"INVALID_ACTOR",
  INVALID_PHASE:"INVALID_PHASE",
  INVALID_ACTION:"INVALID_ACTION",
  FALLBACK:"FALLBACK",
  CANCELLED:"CANCELLED"
});

/*
功能
把 Planner 动作与计划投影为 entity-free SearchResult envelope。

调用方
AIController.acceptSearchResult 与 SearchResult 契约测试。

输入
request、actionDescriptor、plannedSequenceDescriptors、stats、acceptance 状态与 rngAfter。

输出
冻结 data-only SearchResult；descriptor 不再二次投影。

读取状态
只读输入 action。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不保存 raw action、Player、Card 或 World；plannedSequenceDescriptors 必须已是 Action。
*/
export function createSearchResult({
  request,
  action = null,
  plannedActions = [],
  stats = null,
  status,
  rejectionReason = null,
  rngAfter = null
}) {
  return Object.freeze({
    requestId:request.requestId,
    gameId:request.gameId,
    stateVersion:request.stateVersion,
    actorId:request.actorId,
    status,
    rejectionReason,
    action,
    plannedActions:Object.freeze((plannedActions ?? []).map(
      (plannedAction) => plannedAction
    )),
    stats:stats ? Object.freeze({ ...stats }) : null,
    rngAfter:rngAfter ? Object.freeze({ ...rngAfter }) : null
  });
}

/*
功能
验证 SearchResult envelope 不含运行时实体或函数。

调用方
SearchResult 契约测试与 boundary assertion。

输入
SearchResult。

输出
违反项数组。

读取状态
只读结果对象图。

写入状态
无。

调用函数
Object.entries。

边界与不变量
不接受 World/Simulator/真实 Card/Player；stats 只允许普通诊断值。
*/
export function searchResultViolations(result) {
  const violations = [];
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "function") violations.push(`function:${key}`);
    if (value && typeof value === "object") {
      if (value.constructor?.name === "Card" || value.constructor?.name === "Player" || value.constructor?.name === "Game") {
        violations.push(`entity:${key}`);
      }
      if (key !== "action" && key !== "plannedActions" && value.players) {
        violations.push(`searchState:${key}`);
      }
    }
  }
  return violations;
}
