/*
模块职责
唯一把动作前状态、动作与动作后状态组合为 Transition Value（一次动作带来的最终搜索价值）。

上游
Planner 与价值等价测试。

下游
运行时 State Value、Probability 与既有 Card/Threat/GlobalBenefit Value primitives。

状态边界
只读 before/after World；不写状态、不生成或执行动作。

信息边界
只使用过滤后的状态、显式行动者/观察者，以及调用层提供的概率、领域和前沿数值。

架构约束
不读取 Game/Controller，不搜索、不决定束裁剪或同分裁决，也绝不消费仅用于剪枝的 SearchPrior。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  probabilityFromCurrentCounts,
  queryCurrentCardCounts,
  queryPlayerHandProbability
} from "../state/Probability.js";
import {
  cardAvailability,
  getBaseCardAiValue,
  roleCardDelta
} from "../value/CardValue.js";
import {
  HP_VALUE,
  RESOURCE_MATERIAL_SCALE,
  statePointsToUtility
} from "../value/Economics.js";
import { mutualBenefitDraftValues } from "../value/GlobalBenefitValue.js";
import { incomingExposure } from "../value/ThreatValue.js";

/*
功能
按当前可见决策机会计算四类私密信息的敌我目标相关性。

调用方
privatePeekInformationValue。

输入
当前 World、窥探使用者与被查看目标。

输出
assault、block、recover、counter 四类资源的零到一相关性。

读取状态
使用者合法手牌、Probability、目标生命与公开攻击暴露。

写入状态
无。

调用函数
cardAvailability、queryPlayerHandProbability、incomingExposure、clampProbability。

边界与不变量
敌友关系只决定当前决策可用性，不提供固定奖励；不得读取真实未知牌面。
*/
function privatePeekDecisionRelevance(state, actor, target) {
  const decisionDefinitions = (actor?.hand ?? [])
    .filter((entry) => cardAvailability(entry) > PROBABILITY_EPSILON)
    .map((entry) => CARD_DEFINITIONS[entry.definitionId] ?? entry)
    .filter((definition) => !definition.subtypes?.includes("information"));
  const offensiveDecision = clampProbability(Math.max(
    queryPlayerHandProbability(state.probabilityState, actor, "assault").expected,
    decisionDefinitions.some((definition) => definition.subtypes?.some(
      (subtype) => ["attack", "damage", "attack-buff"].includes(subtype)
    )) ? 1 : 0
  ));
  const tacticDecision = decisionDefinitions.some((definition) => (
    definition.category === "tactic" && definition.counterable !== false
  )) ? 1 : 0;
  const protectionDecision = decisionDefinitions.some((definition) => (
    definition.subtypes?.some(
      (subtype) => ["defense", "response", "rescue", "support"].includes(subtype)
    ) || definition.targetType === "multiStage"
  )) ? 1 : 0;
  if (target.battleTeam !== actor.battleTeam) {
    const targetKillRelevance = target.maxHp > 0
      ? clampProbability((target.maxHp - target.hp) / target.maxHp)
      : 0;
    const teamThreatRelevance = (state?.players ?? [])
      .filter((player) => player.alive && player.battleTeam === actor.battleTeam)
      .reduce((highest, player) => Math.max(
        highest,
        clampProbability(
          (player.maxHp > 0 ? Math.max(0, player.maxHp - player.hp) / player.maxHp : 0)
            + incomingExposure(state, player) / HP_VALUE
        )
      ), 0);
    return {
      assault:Math.max(teamThreatRelevance, protectionDecision),
      block:offensiveDecision,
      recover:offensiveDecision * targetKillRelevance,
      counter:tacticDecision
    };
  }
  const allySurvivalRelevance = clampProbability(
    (target.maxHp > 0 ? Math.max(0, target.maxHp - target.hp) / target.maxHp : 0)
      + incomingExposure(state, target) / HP_VALUE
  ) * protectionDecision;
  const enemyKillRelevance = (state?.players ?? [])
    .filter((player) => player.alive && player.battleTeam !== actor.battleTeam)
    .reduce((highest, player) => Math.max(
      highest,
      player.maxHp > 0 ? clampProbability((player.maxHp - player.hp) / player.maxHp) : 0
    ), 0);
  return {
    assault:enemyKillRelevance * Math.max(offensiveDecision, tacticDecision),
    block:allySurvivalRelevance,
    recover:allySurvivalRelevance,
    counter:allySurvivalRelevance
  };
}

/*
功能
从动作前 World 估算一次私密查看减少的决策不确定性。

调用方
deriveTransitionOptionPoints 与直接 Value 测试。

输入
动作前 World、观察者、目标与最大揭示数量。

输出
非负 raw information option points；完全已知或空手时为零。

读取状态
目标 handCount/knownCards、Probability 当前有限池与公开战斗状态。

写入状态
无。

调用函数
privatePeekDecisionRelevance、cardAvailability、Probability 查询。

边界与不变量
身份熵只是容量上限，必须乘当前决策相关性；期望数量不得冒充事件概率。
*/
export function privatePeekInformationValue(state, actor, target, revealCount) {
  const knownExpectedCount = (target?.knownCards ?? [])
    .reduce((sum, entry) => sum + cardAvailability(entry), 0);
  const unknownCount = Math.max(0, (Number(target?.handCount) || 0) - knownExpectedCount);
  const revealed = Math.min(Math.max(0, Number(revealCount) || 0), unknownCount);
  if (revealed <= PROBABILITY_EPSILON) return 0;
  const currentCounts = queryCurrentCardCounts(state?.probabilityState);
  const identityEntropy = Object.keys(CARD_DEFINITIONS).reduce((sum, definitionId) => {
    const density = probabilityFromCurrentCounts(currentCounts, definitionId);
    return density > PROBABILITY_EPSILON ? sum - density * Math.log2(density) : sum;
  }, 0);
  const chances = Object.fromEntries(["assault", "block", "recover", "counter"].map(
    (definitionId) => [
      definitionId,
      queryPlayerHandProbability(state.probabilityState, target, definitionId).probability
    ]
  ));
  const relevance = privatePeekDecisionRelevance(state, actor, target);
  const decisionWeightedUncertainty = Object.keys(chances).reduce((sum, definitionId) => {
    const chance = chances[definitionId];
    return sum + chance * (1 - chance) * relevance[definitionId];
  }, 0);
  return unknownCount * identityEntropy * (revealed / unknownCount) * decisionWeightedUncertainty;
}

/*
功能
从 before/after World 与 canonical Action 直接派生不属于物理 State Value 的转移选项点数。

调用方
TransitionValue.evaluateBase。

输入
动作、行动者、before/after World 与战术结算比例。

输出
窥探信息、借势获得装备和互利座次选择的 raw State points 总和。

读取状态
动作前后装备保留、合法手牌、Probability 当前有限池与团队关系。

写入状态
无。

调用函数
privatePeekInformationValue、CardValue、mutualBenefitDraftValues。

边界与不变量
只评价 Action 已明确的 transition；借势获得量必须由真实装备保留差反推，
不得把 value 写回 World；Scout/互利只乘一次卡牌可用性与结算比例。
*/
function deriveTransitionOptionPoints(action, player, beforeState, afterState, resolutionScale) {
  const cardId = action?.cardId ?? action?.card?.definitionId ?? null;
  if (!cardId || !player) return 0;
  const beforeActor = beforeState.players.find((entry) => entry.id === player.id) ?? player;
  const heldCard = (beforeActor.hand ?? []).find((entry) => (
    entry.id === action.cardInstanceId || entry.id === action.card?.id
  ));
  const executionProbability = action.execution?.restoreActorHand && !heldCard
    ? 1
    : cardAvailability(heldCard);
  const effectScale = clampProbability(executionProbability * resolutionScale);
  if (cardId === "scout") {
    const target = beforeState.players.find((entry) => entry.id === action.targetIds?.[0]);
    if (!target?.alive) return 0;
    return privatePeekInformationValue(
      beforeState,
      beforeActor,
      target,
      CARD_DEFINITIONS.scout.maxRevealCount
    ) * effectScale * 0.35;
  }
  if (cardId === "leverage") {
    const firstId = action.selection?.firstTargetId ?? action.targetIds?.[0];
    const beforeFirst = beforeState.players.find((entry) => entry.id === firstId);
    const afterFirst = afterState.players.find((entry) => entry.id === firstId);
    const equipmentDefinitionId = beforeFirst?.equipmentDefinitionId ?? null;
    if (!equipmentDefinitionId || afterFirst?.equipmentDefinitionId !== equipmentDefinitionId) return 0;
    const beforeRetention = clampProbability(beforeFirst.equipmentRetentionProbability ?? 1);
    const afterRetention = clampProbability(afterFirst.equipmentRetentionProbability ?? 0);
    const acquired = Math.max(0, beforeRetention - afterRetention);
    return (getBaseCardAiValue(equipmentDefinitionId)
      + roleCardDelta(beforeActor.characterId, equipmentDefinitionId))
      * acquired * RESOURCE_MATERIAL_SCALE;
  }
  if (cardId === "mutualBenefit") {
    const draftValues = mutualBenefitDraftValues(
      beforeState.players,
      beforeActor,
      queryCurrentCardCounts(beforeState.probabilityState)
    );
    return beforeState.players.reduce((sum, recipient) => {
      if (!recipient.alive) return sum;
      const sign = recipient.battleTeam === beforeActor.battleTeam ? 1 : -1;
      return sum + sign * (draftValues[recipient.id] ?? 0) * effectScale;
    }, 0);
  }
  return 0;
}

export class TransitionValue {
  /*
  功能
  绑定 State Value 的唯一运行时入口。

  调用方
  AIController 组合根（统一组装依赖的位置） 与直接测试。

  输入
  提供 stateUtility(state, viewerId) 的显式依赖。

  输出
  Final Transition Value 服务实例。

  读取状态
  保存 stateValue 引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Planner、Controller、ActionGenerator 或 SearchPrior。
  */
  constructor(stateValue) {
    this.stateValue = stateValue;
  }

  /*
  功能
  计算一次候选的经济项、state delta 与未加领域修正的 base transition。

  调用方
  Planner 根节点和深层候选展开。

  输入
  动作、actor、before/after、仅作 horizon 诊断的 depth、end 机会成本、resolutionScale 查询函数与父 SearchBudget。

  输出
  包含逐 term 数值和 baseTransition 的不可变语义对象。

  读取状态
  只读 before/after 与 state value。

  写入状态
  无。

  调用函数
  deriveTransitionOptionPoints、StateValue.transitionDelta、getResolutionScale。

  边界与不变量
  只有需要战术 option 的动作读取 resolutionScale；raw State Value delta 在此唯一 Final Utility 边界
  转换为 HP-equivalent utility；depth 只限制 Planner 的搜索 horizon，不得缩放动作价值；
  State Value 内的 nested simulation 必须继承父 SearchBudget。
  */
  evaluateBase({
    action,
    player,
    beforeState,
    afterState,
    depth = 1,
    endOpportunityCost = 0,
    getResolutionScale = () => 1,
    searchBudget = null
  }) {
    const economic = action.type === "end" ? -endOpportunityCost : 0;
    const cardId = action?.cardId ?? action?.card?.definitionId ?? null;
    const resolutionScale = ["scout", "mutualBenefit"].includes(cardId)
      ? getResolutionScale()
      : 1;
    const immediate = economic * resolutionScale;
    const stateDelta = this.stateValue.transitionDelta(
      beforeState,
      afterState,
      player.id,
      searchBudget
    );
    const stateDeltaValue = statePointsToUtility(stateDelta);
    const transitionOptionPoints = deriveTransitionOptionPoints(
      action,
      player,
      beforeState,
      afterState,
      resolutionScale
    );
    const transitionOptionValue = statePointsToUtility(transitionOptionPoints);
    const baseTransition = immediate + stateDeltaValue + transitionOptionValue;
    return {
      economic,
      resolutionScale,
      immediate,
      stateDelta,
      stateDeltaValue,
      transitionOptionPoints,
      transitionOptionValue,
      depth,
      baseTransition
    };
  }

  /*
  功能
  按 Final Utility 与唯一机器精度同分语义比较两个完整候选。

  调用方
  SearchPolicy 的 best、final ordering 与 Planner 的终止候选比较。

  输入
  含 valueScore 或 transitionValue 的两个完整候选。

  输出
  left 更优返回正数，right 更优返回负数，完全等价返回零。

  读取状态
  候选 Final Utility 与 canonical root Action type。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  Final Utility 始终先比较；只在 IEEE machine precision 内优先 skill-root 于 card-root，
  以稳定保留不消耗手牌身份的等价执行顺序；Search Prior、pruneScore 与随机扰动不得进入本比较。
  */
  compareCandidates(left, right) {
    const leftValue = Number(left?.valueScore ?? left?.transitionValue);
    const rightValue = Number(right?.valueScore ?? right?.transitionValue);
    const difference = leftValue - rightValue;
    const tolerance = Number.EPSILON * Math.max(
      1,
      Math.abs(leftValue),
      Math.abs(rightValue)
    );
    if (Math.abs(difference) > tolerance) return difference;
    if (left?.action?.type === "skill" && right?.action?.type === "card") return 1;
    if (left?.action?.type === "card" && right?.action?.type === "skill") return -1;
    return 0;
  }

  /*
  功能
  组合 base transition、terminal frontier 与信息选择价值为最终候选值。

  调用方
  Planner 与直接测试入口。

输入
  HP-equivalent baseTransition/terminal frontier，以及 raw State points 的窥隙信息选择价值。

  输出
  当前候选的最终 Transition Value。

  读取状态
  无；只读取显式数值输入。

  写入状态
  无。

调用函数
  statePointsToUtility。

  边界与不变量
  response 与实际后续效果已包含在 state delta 中故不再相加；Expose/既有破势边际只作 Search Prior，
  不得与后续 after-state 重复进入 final；窥隙项是 raw State points 的 Monte Carlo 信息选择价值，
  在本边界只转换一次且不是概率。
  */
  composeCandidateValue({
    baseTransition,
    frontierValue = 0,
    spyGapInformationValue = 0
  }) {
    return baseTransition + frontierValue
      + statePointsToUtility(spyGapInformationValue);
  }
}
