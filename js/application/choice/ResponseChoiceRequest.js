/*
模块职责
构建 response family 的 data-only ChoiceRequest；不拥有响应规则、支付或 workflow。

上游
ResponseSystem legacy workflow。

下游
application/ports/ChoicePort 与 peer adapters。

状态边界
只接收已构造的 IDs 与 primitive facts，不写状态。

信息边界
不含 Game/Player/Card 实体引用；presentation 仅允许结构化公开数据。

架构约束
不得依赖 UI/AI/Audio/Diagnostics、Game runtime、EventBus 或 Domain mutation。
*/

/*
功能
创建 response ChoiceRequest。

调用方
ResponseSystem.waitForDecision。

输入
responseId、responderId、gameId、stateVersion、responseType、requiredCount、legalCardIds、label 与公开 context。

输出
冻结的 discriminated response ChoiceRequest。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
kind 固定为 response；optionId 使用字符串 ID；不含函数、Set、Map 或实体引用。
*/
export function createResponseChoiceRequest({
  requestId,
  actorId,
  gameId,
  stateVersion,
  responseType,
  requiredCount,
  legalCardIds,
  label,
  context
}) {
  if (!requestId || !actorId || !gameId || !responseType) {
    throw new TypeError("response ChoiceRequest 缺少 requestId/actorId/gameId/responseType");
  }
  return Object.freeze({
    requestId,
    kind: "response",
    actorId,
    gameId,
    stateVersion,
    options: Object.freeze(
      (legalCardIds ?? []).map((optionId) => Object.freeze({ optionId }))
    ),
    constraints: Object.freeze({
      responseType,
      requiredCount: Math.max(0, Number(requiredCount) || 0)
    }),
    canDecline: true,
    context: Object.freeze({
      label: label ?? "",
      sourcePlayerId: context?.sourcePlayerId ?? null,
      targetPlayerId: context?.targetPlayerId ?? null,
      cardId: context?.cardId ?? null,
      timeoutMs: context?.timeoutMs ?? null,
      presentation: context?.presentation ?? null
    })
  });
}
