/*
模块职责
构建 discard family 的 data-only ChoiceRequest；不拥有弃牌规则、UI/AI mechanism 或 card movement。

上游
application/turn TurnWorkflow。

下游
application/ports/ChoicePort 与 peer adapters。

状态边界
只接收手牌 cardIds 与 primitive facts，不写状态。

信息边界
不包含 Card/Player 实体；option 只使用 cardId。

架构约束
不得依赖 Game runtime、UI/AI、EventDispatcher、Domain transitions 或 concrete adapters。
*/

/*
功能
创建 discard ChoiceRequest。

调用方
TurnWorkflow.handleDiscardPhase。

输入
requestId、actorId、gameId、stateVersion、handCardIds、requiredCount、label 与 handLimit。

输出
冻结的 discriminated discard ChoiceRequest。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
kind 固定为 discard；canDecline false；requiredCount 为正整数。
*/
export function createDiscardChoiceRequest({
  requestId,
  actorId,
  gameId,
  stateVersion,
  handCardIds,
  requiredCount,
  label,
  handLimit
}) {
  if (!requestId || !actorId || !gameId) {
    throw new TypeError("discard ChoiceRequest 缺少 requestId/actorId/gameId");
  }
  return Object.freeze({
    requestId,
    kind: "discard",
    actorId,
    gameId,
    stateVersion,
    options: Object.freeze((handCardIds ?? []).map((optionId) => Object.freeze({ optionId }))),
    constraints: Object.freeze({ requiredCount: Math.max(0, Number(requiredCount) || 0) }),
    canDecline: false,
    context: Object.freeze({
      label: label ?? "",
      handLimit: Math.max(0, Number(handLimit) || 0)
    })
  });
}
