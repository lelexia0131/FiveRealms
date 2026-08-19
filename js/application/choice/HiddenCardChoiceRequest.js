/*
模块职责
构建隐藏手牌与手牌/装备区域选择的 data-only ChoiceRequest；候选只使用 opaque token 或公开 ID。

上游
HiddenCardChoiceWorkflow。

下游
application/ports/ChoicePort 与 Human/AI peer adapters。

状态边界
不读写真 GameState；不写状态。

信息边界
不得包含 Player/Card 实体或隐藏牌 definitionId；只携带参与者、拥有者、token、数量与提示等 primitive facts。

架构约束
不得依赖 concrete UI/AI、Game runtime、Domain transition 或隐藏选择 adapter。
*/

const HIDDEN_CHOICE_MODES = new Set(["hand", "zone"]);

/*
功能
创建隐藏手牌或区域选择的 data-only ChoiceRequest。

调用方
HiddenCardChoiceWorkflow。

输入
requestId、actorId、ownerId、gameId、stateVersion、mode、maximum、exact、prompt 与 opaque optionIds。

输出
冻结的 hiddenCard ChoiceRequest。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
options 不含牌面定义；zone 模式允许公开装备由 adapter 私有上下文重绑，取消始终合法。
*/
export function createHiddenCardChoiceRequest({
  requestId,
  actorId,
  ownerId,
  gameId,
  stateVersion,
  mode,
  maximum,
  exact,
  prompt,
  optionIds = []
}) {
  if (!requestId || !actorId || !ownerId || !gameId || !HIDDEN_CHOICE_MODES.has(mode)) {
    throw new TypeError("hiddenCard ChoiceRequest 缺少 requestId/actorId/ownerId/gameId 或 mode 非法");
  }
  const requiredCount = Math.max(0, Math.floor(Number(maximum) || 0));
  return Object.freeze({
    requestId,
    kind: "hiddenCard",
    actorId,
    gameId,
    stateVersion,
    options: Object.freeze(optionIds
      .filter((optionId) => typeof optionId === "string")
      .map((optionId) => Object.freeze({ optionId }))),
    constraints: Object.freeze({
      requiredCount,
      exact: Boolean(exact),
      mode
    }),
    canDecline: true,
    context: Object.freeze({
      ownerId,
      prompt: typeof prompt === "string" ? prompt : ""
    })
  });
}
