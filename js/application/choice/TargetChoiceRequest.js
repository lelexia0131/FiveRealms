/*
模块职责
构建有限 target 选择的 data-only ChoiceRequest；不拥有 target legality、UI/AI mechanism 或 action workflow。

上游
application/action ActionWorkflow。

下游
application/ports/ChoicePort 与 peer adapters。

状态边界
只接收公开 target facts，不写状态。

信息边界
只包含 targetId/name/battleTeam 等公开事实；不携带 Player entity 或 hidden hand。

架构约束
不得依赖 Game runtime、UI/AI、EventBus、Domain transitions 或 concrete adapters。
*/

/*
功能
创建 target ChoiceRequest。

调用方
ActionWorkflow human card/skill command。

输入
requestId、actorId、gameId、stateVersion、targets、label 与 source/card facts。

输出
冻结的 discriminated target ChoiceRequest。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
kind 固定为 target；canDecline false；AI Planner 不走该 Choice。
*/
export function createTargetChoiceRequest({
  requestId,
  actorId,
  gameId,
  stateVersion,
  targets,
  label,
  sourcePlayerId = null,
  cardId = null
}) {
  if (!requestId || !actorId || !gameId) {
    throw new TypeError("target ChoiceRequest 缺少 requestId/actorId/gameId");
  }
  return Object.freeze({
    requestId,
    kind: "target",
    actorId,
    gameId,
    stateVersion,
    options: Object.freeze((targets ?? []).map((target) => Object.freeze({
      optionId: target.id,
      name: target.name ?? "",
      battleTeam: target.battleTeam ?? null
    }))),
    constraints: Object.freeze({ requiredCount: 1 }),
    canDecline: false,
    context: Object.freeze({
      label: label ?? "",
      sourcePlayerId,
      cardId
    })
  });
}
