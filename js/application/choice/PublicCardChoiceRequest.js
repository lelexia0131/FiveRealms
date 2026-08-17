/*
模块职责
构建公开牌池轮选 family 的 data-only ChoiceRequest；公开牌内容可进入 request，但绝不携带 Card 实体。

上游
PublicCardPoolWorkflow。

下游
application/ports/ChoicePort 与 peer adapters。

状态边界
不读写真 GameState；不写状态。

信息边界
只包含公开的 cardId/definitionId/name/category 与 primitive constraints。

架构约束
不得依赖 UI/AI/Audio/Diagnostics、Game runtime、EventDispatcher 或 Domain mutation。
*/

/*
功能
创建 publicCard ChoiceRequest。

调用方
PublicCardPoolWorkflow.draft。

输入
requestId、actorId、gameId、stateVersion 与 offeredCards facts。

输出
冻结的 discriminated publicCard ChoiceRequest。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
optionId 使用真实公开 card id；options 只含公开字段。
*/
export function createPublicCardChoiceRequest({
  requestId,
  actorId,
  gameId,
  stateVersion,
  offeredCards
}) {
  if (!requestId || !actorId || !gameId) {
    throw new TypeError("publicCard ChoiceRequest 缺少 requestId/actorId/gameId");
  }
  return Object.freeze({
    requestId,
    kind: "publicCard",
    actorId,
    gameId,
    stateVersion,
    options: Object.freeze((offeredCards ?? []).map((entry) => Object.freeze({
      optionId: entry.id,
      definitionId: entry.definitionId,
      name: entry.name,
      category: entry.category ?? null
    }))),
    constraints: Object.freeze({ requiredCount: 1 }),
    canDecline: false,
    context: Object.freeze({})
  });
}
