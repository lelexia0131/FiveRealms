/*
模块职责
统一真人令牌选择与 AI 隐藏资源选择，并在每次异步返回后重新验证会话和实体位置。

上游
composition root、CardIntentRuntime。

下游
HiddenCardSelectionAdapter、Human/AI choice capabilities。

状态边界
只读 MatchState；短期 token/session 写入由 HiddenCardSelectionAdapter 拥有。

信息边界
真人只接收 opaque token；AI 选择能力自行遵守隐藏信息视图，workflow 不按未知牌定义筛选。

架构约束
不得依赖 concrete UI/AI 模块、DOM、Domain transition 或卡牌效果规则。
*/

/*
功能
创建隐藏手牌与玩家区域选择 workflow。

调用方
composition root。

输入
状态/session query、token adapter 以及 Human/AI 选择 capabilities。

输出
冻结的 { chooseHiddenCards, choosePlayerZoneCard }。

读取状态
当前 MatchState、Player hand/equipment 与 token session。

写入状态
仅通过 hiddenSelection 创建或清理 token session。

调用函数
requestHiddenCards、requestZoneCard、chooseAiHiddenCards、chooseAiZoneCard。

边界与不变量
所有返回实体都必须仍位于原区域；异步边界后必须重新校验 session；未知手牌不按真实定义比较。
*/
export function createHiddenCardChoiceWorkflow(runtime) {
  /*
  功能
  在真人令牌选择与 AI 隐藏位置策略之间统一选择手牌实体。

  调用方
  CardIntentRuntime、choosePlayerZoneCard 与测试。

  输入
  行动者、持有者、数量、提示、可选选择描述、排除集合与 AI 用途上下文。

  输出
  已去重且仍在持有者手牌中的实体牌数组。

  读取状态
  当前 MatchState、持有者手牌与 token session。

  写入状态
  通过 hiddenSelection 创建或清理 token session。

  调用函数
  requestHiddenCards、chooseAiHiddenCards、HiddenCardSelectionAdapter methods。

  边界与不变量
  真人选择只按 token/实体 ID 复核；异步返回后重新验证当前对局。
  */
  async function chooseHiddenCards(actor, owner, count, reason, selection = null, excludedCardIds = null, aiContext = null) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return [];
    const eligibleCards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const maximum = Math.min(count, eligibleCards.length);
    if (!maximum) {
      if (selection?.selectionId) runtime.hiddenSelection.clearSelection(selection.selectionId);
      return [];
    }
    if (selection?.tokens?.length) {
      if (!selection.selectionId) return [];
      const uniqueTokens = [...new Set(selection.tokens)].slice(0, maximum);
      const resolved = uniqueTokens.map((token) => runtime.hiddenSelection.resolveToken(token, owner, selection.selectionId))
        .filter((card) => card && !excludedCardIds?.has(card.id));
      const cards = [...new Map(resolved.map((card) => [card.id, card])).values()];
      runtime.hiddenSelection.clearSelection(selection.selectionId);
      return cards;
    }
    if (actor.controllerType === "human") {
      const hidden = runtime.hiddenSelection.createHiddenSelection(owner, eligibleCards);
      const tokens = await runtime.requestHiddenCards(hidden, maximum, reason, { exact:true, viewer:actor, owner });
      if (!runtime.isSessionValid(gameId)) return [];
      const uniqueTokens = [...new Set(tokens ?? [])].slice(0, maximum);
      const resolved = uniqueTokens.map((token) => runtime.hiddenSelection.resolveToken(token, owner, hidden.selectionId))
        .filter((card) => card && !excludedCardIds?.has(card.id));
      const cards = [...new Map(resolved.map((card) => [card.id, card])).values()];
      runtime.hiddenSelection.clearSelection(hidden.selectionId);
      return cards;
    }
    return runtime.chooseAiHiddenCards(actor, owner, maximum, excludedCardIds, aiContext);
  }

  /*
  功能
  在目标隐藏手牌与公开装备之间选择一个仍有效的资源实体。

  调用方
  CardIntentRuntime 与测试。

  输入
  行动者、持有者、提示、可选选择描述、排除集合与 AI 用途上下文。

  输出
  { card, zone } 或 null。

  读取状态
  当前 MatchState、持有者手牌/装备与 token session。

  写入状态
  通过 hiddenSelection 清理已完成的 token session。

  调用函数
  chooseHiddenCards、requestZoneCard、chooseAiZoneCard。

  边界与不变量
  装备必须仍与提交的 equipmentCardId 一致；手牌选择继续走 opaque token 复核。
  */
  async function choosePlayerZoneCard(actor, owner, reason, selection = null, excludedCardIds = null, aiContext = null) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return null;
    const eligibleHandCount = owner?.hand?.filter((card) => !excludedCardIds?.has(card.id)).length ?? 0;
    if (!owner?.alive || (!eligibleHandCount && !owner.equipment)) return null;
    if (selection?.zone === "equipment") {
      if (!selection.selectionId || !runtime.hiddenSelection.isSelectionActive(selection.selectionId, owner)) return null;
      const equipment = owner.equipment;
      const chosen = equipment && equipment.id === selection.equipmentCardId ? { card:equipment, zone:"equipment" } : null;
      runtime.hiddenSelection.clearSelection(selection.selectionId);
      return chosen;
    }
    if (selection?.tokens?.length) {
      const [card] = await chooseHiddenCards(actor, owner, 1, reason, selection, excludedCardIds);
      if (!runtime.isSessionValid(gameId)) return null;
      return card ? { card, zone:"hand" } : null;
    }
    if (actor.controllerType === "human") {
      const requested = await runtime.requestZoneCard(actor, owner, reason, excludedCardIds);
      if (!runtime.isSessionValid(gameId)) return null;
      return requested ? choosePlayerZoneCard(actor, owner, reason, requested, excludedCardIds) : null;
    }
    return runtime.chooseAiZoneCard(actor, owner, aiContext, excludedCardIds);
  }

  /*
  功能
  为私密窥牌请求选择仍有效的手牌实体。

  调用方
  CardIntentRuntime。

  输入
  查看者、持有者、最大数量、提示与 AI 用途上下文。

  输出
  有效 Card 数组。

  读取状态
  当前 session、双方 alive 与持有者 handVersion。

  写入状态
  真人路径创建并最终清理 token session。

  调用函数
  requestHiddenCards、chooseAiHiddenCards、resolveConfirmedTokens。

  边界与不变量
  真人可少选；AI 路径由 adapter policy 选择；finally 必须清理 token session。
  */
  async function choosePrivateHandPeekCards(viewer, owner, maximum, reason, aiContext) {
    if (viewer.controllerType !== "human") {
      return runtime.chooseAiHiddenCards(viewer, owner, maximum, null, aiContext);
    }
    const hidden = runtime.hiddenSelection.createHiddenSelection(owner);
    try {
      const tokens = await runtime.requestHiddenCards(hidden, maximum, reason, { exact:false, viewer, owner });
      if (!runtime.isSessionValid(runtime.getState().gameId) || !viewer.alive || !owner.alive) return [];
      return runtime.hiddenSelection.resolveConfirmedTokens(tokens, owner, hidden.selectionId, maximum);
    } finally {
      runtime.hiddenSelection.clearSelection(hidden.selectionId);
    }
  }

  return Object.freeze({ chooseHiddenCards, choosePlayerZoneCard, choosePrivateHandPeekCards });
}
