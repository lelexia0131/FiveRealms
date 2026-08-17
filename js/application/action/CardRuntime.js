/*
模块职责
拥有 card-specific Application action planning 与 effective-target 决策；把 generic ActionWorkflow 与 transfer/leverage/private-selection 等具体卡牌语义隔离。不拥有 Domain Card Rule 或通用 action lifecycle。

上游
composition boundary 与 application/action ActionWorkflow。

下游
ActionLegality/card preparation collaborators、application/action/effect collaborator 与 Domain rules。

状态边界
不写 Domain state；仅组合调用栈中的 action plan facts。

信息边界
private intent 只存在于当前调用栈；公开 context 不含 hidden Card entity。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime 或 concrete adapters。
*/
const REQUIRED_DEPENDENCIES = [
  "getState", "canPlayCard", "canUseForcedAssault", "getCardTargets",
  "getAssaultTargetCandidates", "prepareTransferIntent", "prepareLeverageIntent",
  "preparePrivateCardSelectionIntent", "resolveCardEffect", "getActionTargetLabel",
  "getActionLogMessage", "shouldSuppressUseLog"
];

/*
功能
创建 card-specific Application runtime capability。

调用方
composition root。

输入
显式注入的 legality/preparation/effect/presentation collaborators。

输出
冻结 { prepareCardAction, resolveCardAction, getEffectiveTargets }。

读取状态
无。

写入状态
内部无持久状态。

调用函数
无。

边界与不变量
ActionWorkflow 不得包含具体 card ID；本模块才允许解释 card.definitionId。
*/
export function createCardRuntime(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`CardRuntime 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  /*
  功能
  规划一次具体卡牌 action，返回 generic ActionWorkflow 可消费的 action plan。

  调用方
  ActionWorkflow.playCard。

  输入
  source、card、requestedTargets、selection 与 options。

  输出
  { legality, forcedAssault, legalTargets, targets, preparedTransfer, preparedLeverage, preparedPrivateSelection, targetLabel, useLogMessage }。

  读取状态
  legality/preparation collaborators 与 card facts。

  写入状态
  无。

  调用函数
  canPlayCard、canUseForcedAssault、getCardTargets、getAssaultTargetCandidates、prepareTransferIntent、prepareLeverageIntent、preparePrivateCardSelectionIntent、getActionTargetLabel、getActionLogMessage。

  边界与不变量
  具体卡牌分支只在本模块出现；返回 data-only plan，不执行 zone move。
  */
  async function prepareCardAction(source, card, requestedTargets = [], selection = null, options = {}) {
    const state = runtime.getState();
    const forcedAssault = options.usageContext === "leverageAssault" && card?.definitionId === "assault";
    const legality = forcedAssault
      ? runtime.canUseForcedAssault(source, card, requestedTargets[0])
      : runtime.canPlayCard(source, card);
    let targets = requestedTargets;
    const legalTargets = forcedAssault
      ? runtime.getAssaultTargetCandidates(source)
      : runtime.getCardTargets(source, card);
    if (card.targetType === "self") targets = [source];
    if (card.targetType === "allEnemies") targets = legalTargets;
    if (card.targetType === "allLiving") targets = legalTargets;
    if (!["none", "self", "allEnemies", "allLiving", "multiStage"].includes(card.targetType)
      && (!targets[0] || !legalTargets.includes(targets[0]))) {
      return { legality: legality.ok ? { ok:false, reason:"目标非法" } : legality, forcedAssault, legalTargets, targets };
    }
    const preparedTransfer = card.definitionId === "transfer"
      ? await runtime.prepareTransferIntent(source, card, selection)
      : null;
    const preparedLeverage = card.definitionId === "leverage"
      ? runtime.prepareLeverageIntent(source, selection)
      : null;
    const needsPrivateSelection = ["scout", "plunder", "destroy"].includes(card.definitionId);
    const preparedPrivateSelection = needsPrivateSelection
      ? await runtime.preparePrivateCardSelectionIntent(source, card, targets, selection)
      : null;
    if (card.definitionId === "transfer" && !preparedTransfer) return { legality: { ok:false, reason:"转移准备失败" }, forcedAssault, legalTargets, targets };
    if (card.definitionId === "leverage" && !preparedLeverage) return { legality: { ok:false, reason:"借势准备失败" }, forcedAssault, legalTargets, targets };
    if (needsPrivateSelection && !preparedPrivateSelection) return { legality: { ok:false, reason:"私密选择失败" }, forcedAssault, legalTargets, targets };
    if (preparedLeverage) targets = [preparedLeverage.firstTarget, preparedLeverage.secondTarget];
    const targetLabel = preparedTransfer
      ? `来源 ${preparedTransfer.publicContext.fromName} → 接收 ${preparedTransfer.publicContext.receiverName}`
      : preparedLeverage
        ? `${preparedLeverage.firstTarget.name} → ${preparedLeverage.secondTarget.name}`
        : runtime.getActionTargetLabel(source, card, targets, selection);
    let useLogMessage = null;
    if (preparedTransfer) {
      const publicContext = preparedTransfer.publicContext;
      const receiverLabel = publicContext.receiverPlayerId === source.id ? "自己" : publicContext.receiverName;
      useLogMessage = `${source.name}使用了「${card.name}」，准备将${publicContext.fromName}的${publicContext.safeItemLabel}转移给${receiverLabel}。`;
    } else if (preparedLeverage) {
      useLogMessage = `${source.name}对${preparedLeverage.firstTarget.name}使用「借势」，要求其对${preparedLeverage.secondTarget.name}使用「突袭」；若拒绝，${source.name}将获得其「${preparedLeverage.equipmentCard.name}」。`;
    } else if (card.category !== "equipment" && !runtime.shouldSuppressUseLog(card.definitionId)) {
      useLogMessage = runtime.getActionLogMessage(source, card, targets);
    }
    return Object.freeze({
      legality,
      forcedAssault,
      legalTargets,
      targets,
      preparedTransfer: preparedTransfer ?? null,
      preparedLeverage: preparedLeverage ?? null,
      preparedPrivateSelection: preparedPrivateSelection ?? null,
      targetLabel,
      useLogMessage,
      gameId: state.gameId
    });
  }

  /*
  功能
  调用 card effect resolver。

  调用方
  ActionWorkflow.playCard。

  输入
  source、card、targets、selection、resolutionId 与 action plan。

  输出
  effect result。

  读取状态
  无。

  写入状态
  无。

  调用函数
  resolveCardEffect。

  边界与不变量
  不复制 resolver；只转发 plan 中的 private intents。
  */
  async function resolveCardAction(source, card, targets, selection, resolutionId, plan) {
    return runtime.resolveCardEffect(source, card, targets, {
      resolutionId,
      selection,
      privateTransferIntent: plan.preparedTransfer?.privateIntent ?? null,
      privateCardSelectionIntent: plan.preparedPrivateSelection?.privateIntent ?? null,
      privateLeverageIntent: plan.preparedLeverage
    });
  }

  /*
  功能
  计算 cardUsed 的有效目标，屏蔽具体卡牌语义。

  调用方
  ActionWorkflow.playCard。

  输入
  state、source、card、targets、resolved 与 effectResult/plan。

  输出
  effectiveTargets 数组。

  读取状态
  effectResult.effectiveTargets 与 card facts。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  mutualBenefit/transfer/leverage 等具体语义只在这里解释；否则沿用 effectResult 或原 targets。
  */
  function getEffectiveTargets(state, source, card, targets, resolved, effectResult, plan) {
    if (!resolved) return [];
    if (Array.isArray(effectResult?.effectiveTargets)) return effectResult.effectiveTargets;
    if (card.definitionId === "transfer") {
      return [plan.preparedTransfer.privateIntent.from, plan.preparedTransfer.privateIntent.receiver];
    }
    if (card.definitionId === "leverage") {
      return [plan.preparedLeverage.firstTarget, plan.preparedLeverage.secondTarget];
    }
    if (card.definitionId === "mutualBenefit") return state.players.filter((player) => player.alive);
    return targets;
  }

  return Object.freeze({ prepareCardAction, resolveCardAction, getEffectiveTargets });
}
