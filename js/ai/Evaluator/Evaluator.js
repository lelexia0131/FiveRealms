/*
模块职责
唯一拥有价值聚合、响应意愿、transition/final utility、诊断 terms 与候选比较语义。

上游
Controller、Searcher、Worker composition、Simulator 的窄决策注入与测试。

下游
内部 StateValue/CardValue、Domain card rules 与 canonical Probability facade。

状态边界
只读 Fact/World、canonical Action、plain DecisionContext 和显式传入的领域值；不持有 Game，不写状态。

信息边界
只使用公开字段、合法概率摘要与 viewer 自身的可见卡牌身份。

架构约束
唯一聚合并公开 StateValue/CardValue primitive；不得导入 Simulator、Searcher 或 Controller，反事实只消费 Simulator 已构造的 World。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getRecoverHealAmount } from "../../domain/rules/card/CardEffectRules.js";
import { getAliveRing } from "../../domain/rules/distance/DistanceRules.js";
import {
  getMaxEnergy as getDomainMaxEnergy,
  getTurnEnergyBreakdown as getDomainTurnEnergyBreakdown
} from "../../domain/rules/team/TeamRules.js";
import { hasFactStatus, projectRulePlayers } from "../Event/Fact.js";
import {
  PROBABILITY_EPSILON,
  buildRadarJudgmentProbabilities,
  cardAvailability,
  clampProbability,
  hypergeometricProbabilityAtLeast,
  probabilityFromCurrentCounts,
  queryCurrentCardCounts,
  queryPlayerHandProbability,
  sealOutcomeProbabilities,
  statusPresence,
  tacticJudgmentProbability
} from "../Event/Probability/Probability.js";
import {
  RESOURCE_MATERIAL_SCALE,
  assessGlobalBenefit,
  cardPlayerValueTerms,
  getBaseCardAiValue,
  getDiscardKeepValue,
  getEquipmentKeepValueDeduction,
  getResourceDefinitionUtility,
  getResourceUnknownUtility,
  getRoleCardAiValue,
  getTransferCardValue,
  getUnknownTransferCardValue,
  getUnknownAcquisitionUtility,
  mutualBenefitDraftValues,
  roleCardDelta,
  skillThresholdOptionPolicyValue
} from "./CardValue.js";
import {
  ENERGY_STATE_WEIGHT,
  HP_VALUE,
  exposureComponents,
  incomingExposure,
  sealTeamBurden,
  statePlayerValueTerms,
  statePointsToUtility,
  threatScore,
  turnOpportunityValue
} from "./StateValue.js";

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
动作前 World、观察者、目标与实际新增揭示数量。

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
export function privatePeekInformationValue(state, actor, target, actualNewRevealCount) {
  const knownExpectedCount = (target?.knownCards ?? [])
    .reduce((sum, entry) => sum + cardAvailability(entry), 0);
  const unknownCount = Math.max(0, (Number(target?.handCount) || 0) - knownExpectedCount);
  const revealed = Math.min(Math.max(0, Number(actualNewRevealCount) || 0), unknownCount);
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
  let decisionWeightedUncertainty;
  if (target.battleTeam !== actor.battleTeam) {
    decisionWeightedUncertainty = Object.keys(chances).reduce((sum, definitionId) => {
      const chance = chances[definitionId];
      return sum + chance * (1 - chance) * relevance[definitionId];
    }, 0);
  } else {
    const assaultUncertainty = chances.assault * (1 - chances.assault);
    const survivalUncertainty = Math.max(
      chances.block * (1 - chances.block),
      chances.recover * (1 - chances.recover),
      chances.counter * (1 - chances.counter)
    );
    // 三类生存资源回答同一个自保问题，只取最大不确定性，避免重复计算同一信息需求。
    decisionWeightedUncertainty = assaultUncertainty * relevance.assault
      + survivalUncertainty * relevance.block;
  }
  return unknownCount * identityEntropy * (revealed / unknownCount) * decisionWeightedUncertainty;
}

/*
功能
从 before/after World 与 canonical Action 直接派生不属于物理 State Value 的转移选项点数。

调用方
Evaluator.evaluateTransition。

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
  const cardId = action?.cardId ?? null;
  if (!cardId || !player) return 0;
  const beforeActor = beforeState.players.find((entry) => entry.id === player.id) ?? player;
  const heldCard = (beforeActor.hand ?? []).find((entry) => (
    entry.id === action.cardInstanceId
  ));
  const executionProbability = cardAvailability(heldCard);
  const effectScale = clampProbability(executionProbability * resolutionScale);
  if (cardId === "scout") {
    const target = beforeState.players.find((entry) => entry.id === action.targetIds?.[0]);
    if (!target?.alive) return 0;
    const revealLimit = CARD_DEFINITIONS.scout.maxRevealCount;
    const actualNewRevealCount = Math.min(
      revealLimit,
      Math.max(0, action.selection?.unknownCount ?? 0)
    );
    return privatePeekInformationValue(
      beforeState,
      beforeActor,
      target,
      actualNewRevealCount
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

/*
功能
返回所有响应入口共用且只计一次的反制牌机会成本。

调用方
Evaluator 的 Counter、延迟状态与全体受益响应意愿方法。

输入
无。

输出
冻结的 counter.aiValue × 0.35。

读取状态
CARD_DEFINITIONS.counter。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
这是既定局部策略近似，只用于确定响应选择，不进入最终 Transition Value；配对世界不得重复扣除。
*/
export function counterOpportunityCost() {
  return getBaseCardAiValue("counter") * 0.35;
}

/*
功能
用统一资源与生存语义判断是否愿意格挡。

调用方
runtime shouldRespond 与 planning decidePlanningBlock。

输入
响应者/目标、入射伤害、可用格挡数、所需数量与小队事实。

输出
确定的格挡意愿。

读取状态
只读传入玩家公开字段。

写入状态
无。

调用函数
无。

边界与不变量
合法容量不足先拒绝；其余 lethal/low HP/资源充足/小队规则在 planning 与 runtime 完全共用。
*/
function blockWillingness({
  responder,
  target,
  incomingDamage,
  availableBlocks,
  requiredBlocks,
  isSmallTeam
}) {
  if (!responder?.alive || !target?.alive) return false;
  if (availableBlocks < requiredBlocks) return false;
  const lethal = incomingDamage - target.shield >= target.hp;
  const lowHp = target.hp <= 2;
  const blocksAreAbundant = availableBlocks * 2 >= responder.handCount;
  return Boolean(isSmallTeam || lethal || lowHp || blocksAreAbundant);
}

/*
功能
用统一 STAY/AID 比较合同判断护援意愿。

调用方
runtime shouldUseGuardianAid 与 planning decidePlanningGuardianAid。

输入
响应者/目标、伤害、配对价值与未来护援库存价值。

输出
AID 严格优于保留额度时为 true。

读取状态
只读 plain data/scalars。

写入状态
无。

调用函数
无。

边界与不变量
所有合法守卫与严格阈值只存在于此处；planning 可提供有界近似值，但不能改写比较规则。
*/
function guardianAidWillingness({
  responder,
  target,
  amount,
  stayValue,
  aidValue,
  futureInventory
}) {
  if (!responder?.alive || !target?.alive || responder.id === target.id) return false;
  if (responder.battleTeam !== target.battleTeam || !responder.handCount) return false;
  if (amount <= 0 || responder.guardianAidUsed) return false;
  return (aidValue - stayValue) > Math.min(HP_VALUE, futureInventory);
}

/*
功能
从两条救援路径各自提供的事实计算唯一一组共同价值项。

调用方
planning decidePlanningDyingRescue 与 runtime assessDyingRescue。

输入
响应者、目标、存活队友数、当前可用 Recover 与本路径已解析的救援成功概率。

输出
strategic、actionValue、defeat risk、survival、opportunity cost 与 expected value。

读取状态
只读 plain player facts 与 CardValue/Domain 常量。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
planning 可提供 resource probability，runtime 可提供更精确事实；共同权重和运算顺序只能在此定义。
*/
function dyingRescueValueTerms({
  responder,
  target,
  aliveTeamCount,
  availableRecover,
  rescueSuccessProbability
}) {
  const strategic = (target.roleTags ?? []).some(
    (tag) => ["support", "healer", "damage", "control", "tank"].includes(tag)
  );
  const actionValue = target.handCount * 1.25
    + target.energy * 1.1
    + (target.equipmentDefinitionId ? 2 : 0)
    + (strategic ? 3 : 0);
  const immediateDefeatRisk = aliveTeamCount <= 2;
  const lastRecoverPenalty = availableRecover <= 1 ? (responder.hp <= 2 ? 3 : 1.5) : 0;
  const survivalValue = HP_VALUE + actionValue + (immediateDefeatRisk ? 8 : 0);
  const recoverOpportunityCost = getBaseCardAiValue("recover") * 0.35
    + lastRecoverPenalty;
  const expectedRescueValue = rescueSuccessProbability * survivalValue
    - recoverOpportunityCost;
  return {
    strategic,
    actionValue,
    immediateDefeatRisk,
    survivalValue,
    recoverOpportunityCost,
    expectedRescueValue
  };
}

/*
功能
用统一救援 assessment 合同判断是否支付 Recover。

调用方
runtime shouldRespond 与 planning decidePlanningDyingRescue。

输入
响应者/目标、可用 Recover、确定失败事实、期望救援值与强制救人配置。

输出
确定的救援意愿。

读取状态
只读 plain data/scalars。

写入状态
无。

调用函数
无。

边界与不变量
敌方、无容量和确定必败始终拒绝；自救和配置强制救真人保持既有优先级。
*/
function dyingRescueWillingness({
  responder,
  target,
  availableRecover,
  guaranteedImpossible,
  expectedRescueValue,
  forceAiRescueHuman
}) {
  if (!responder?.alive || !target?.alive) return false;
  if (target.battleTeam !== responder.battleTeam) return false;
  if (!(availableRecover > 0) || guaranteedImpossible) return false;
  if (target.id === responder.id) return true;
  if (forceAiRescueHuman
    && responder.controllerType === "ai"
    && target.controllerType === "human") return true;
  return expectedRescueValue > 0;
}

/*
功能
用统一收益成本比较判断动态反制意愿。

调用方
planningCounterDecision 与 runtime shouldRespond。

输入
取消 root 效果的收益。

输出
有限收益严格超过 Counter 机会成本时为 true。

读取状态
只读数值。

写入状态
无。

调用函数
counterOpportunityCost。

边界与不变量
planning 近似和 runtime paired Worlds 只能改变 gain 来源，不能复制或改变比较阈值。
*/
function dynamicCounterWillingness(gain) {
  return Number.isFinite(gain) && gain > counterOpportunityCost();
}

/*
功能
根据全体受益价值与反制链 parity 作出确定反制选择。

调用方
Evaluator 响应意愿方法与直接价值测试。

输入
显式 assessment 查询、公开玩家、响应者阵营、root 定义和链上下文。

输出
非全体受益牌返回 null；否则返回布尔决定。

读取状态
只读公开玩家、Probability current counts 与 assessment 纯结果。

写入状态
无。

调用函数
assessment 查询、counterOpportunityCost。

边界与不变量
偶数 depth 表示 root 生效；首层队友非负收益保护与既有严格成本比较保持不变。
*/
function globalBenefitCounterDecision(
  assessGlobalBenefitQuery,
  players,
  battleTeam,
  definitionId,
  options = {}
) {
  const { rootSourceId = null, counterDepth = 0, remainingCardCounts = null } = options ?? {};
  const assessment = assessGlobalBenefitQuery(
    players,
    battleTeam,
    definitionId,
    rootSourceId,
    remainingCardCounts
  );
  if (!assessment) return null;
  const resolvesAtStay = (counterDepth % 2) === 0;
  const stay = resolvesAtStay ? assessment.netBenefit : 0;
  const flip = resolvesAtStay ? 0 : assessment.netBenefit;
  if (counterDepth === 0 && rootSourceId) {
    const rootSource = (players ?? []).find((player) => player?.id === rootSourceId);
    if (rootSource?.battleTeam === battleTeam && (assessment.allyBenefit ?? 0) >= 0) {
      return false;
    }
  }
  return (flip - stay) > counterOpportunityCost();
}

/*
功能
把 canonical resource selection 投影为 State Value 使用的单个资源存量分。

调用方
planningDynamicCounterGain 的 Plunder/Destroy/Transfer 有界 gain。

输入
资源持有者、canonical selection 与当前 viewer ID。

输出
与 State Value 手牌/装备存量同尺度的非负分值。

读取状态
CardValue canonical player terms 与 selection 的公开或合法已知 identity。

写入状态
无。

调用函数
cardPlayerValueTerms。

边界与不变量
unknown hand 只使用公开 hand-count 单位；不得猜测 definitionId 或把完整资源 preference 当作 State Value。
*/
function selectedResourceStateValue(player, selection, viewerId) {
  if (!player || !selection) return 0;
  if (selection.zone === "hand") {
    const projection = cardPlayerValueTerms({
      ...player,
      handCount:1,
      hand:selection.definitionId
        ? [{ definitionId:selection.definitionId, availability:1 }]
        : [],
      equipmentDefinitionId:null,
      equipmentRetentionProbability:0
    }, viewerId);
    return projection.handCount + projection.handRoleDelta;
  }
  const definitionId = selection.definitionId ?? player.equipmentDefinitionId ?? null;
  if (selection.zone !== "equipment" || !definitionId) return 0;
  const projection = cardPlayerValueTerms({
    ...player,
    handCount:0,
    hand:[],
    equipmentDefinitionId:definitionId,
    equipmentRetentionProbability:1
  }, viewerId);
  return projection.equipmentDelta + projection.equipmentRoleDelta;
}

/*
功能
用与真实响应相同的价值单位估算规划世界中取消一张 root 战术的收益。

调用方
planningCounterDecision 与直接价值测试。

输入
只读 World、响应者、施放者、root 卡牌、目标和可选资源选择。

输出
以现有 HP_VALUE、手牌、能量和状态尺度表示的非规格化收益。

读取状态
仅输入 World 的公开字段与 canonical ProbabilityState。

写入状态
无。

调用函数
queryPlayerHandProbability、cardAvailability、selectedResourceStateValue。

边界与不变量
这是既有规划价值近似；不得读取隐藏实体牌，不得改动 family、常量或分支顺序。
*/
export function planningDynamicCounterGain(
  state,
  responder,
  actor,
  card,
  targets,
  selection = null
) {
  const definitionId = card?.definitionId;
  if (!definitionId) return 0;
  const team = responder.battleTeam;
  const actorEnemy = actor?.battleTeam !== team;
  if (!actorEnemy) return 0;
  const target = (targets ?? []).find((entry) => entry?.id)
    ? state.players.find((player) => player.id === targets[0].id) : null;
  /*
  功能
  判断公开玩家是否具有可被资源类战术影响的资源。

  调用方
  planningDynamicCounterGain。

  输入
  只读 World player。

  输出
  是否具有公开手牌数量或装备。

  读取状态
  公开资源摘要。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不得读取未知手牌 definitionId。
  */
  const hasResource = (player) => Number(player?.handCount ?? 0) > 0
    || Boolean(player?.equipmentDefinitionId);
  /*
  功能
  判断公开合法记忆中是否存在突袭身份。

  调用方
  planningDynamicCounterGain。

  输入
  只读 World player。

  输出
  是否具有合法已知突袭。

  读取状态
  knownCards 合法记忆。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不得读取未知手牌 definitionId。
  */
  const knownAssault = (player) => Array.isArray(player?.knownCards)
    && player.knownCards.some((entry) => entry.definitionId === "assault");

  switch (definitionId) {
    case "shockwave": {
      if (!target?.alive) return 0;
      const blockChance = queryPlayerHandProbability(
        state.probabilityState, target, "block"
      ).probability;
      return HP_VALUE * (1 - blockChance) * (Number(target.shield) >= 1 ? 0 : 1);
    }
    case "provoke": {
      if (!target?.alive) return 0;
      return queryPlayerHandProbability(
        state.probabilityState, target, "assault"
      ).probability > 0 ? 1.1 : HP_VALUE;
    }
    case "duel": {
      if (!target?.alive) return 0;
      return HP_VALUE * (queryPlayerHandProbability(
        state.probabilityState, target, "assault"
      ).probability > 0 ? 0.5 : 1);
    }
    case "scout": {
      if (!target?.alive) return 0;
      const knownCount = Array.isArray(target.knownCards)
        ? target.knownCards.reduce((sum, entry) => sum + cardAvailability(entry), 0)
        : 0;
      const unknownCount = Math.max(0, Number(target.handCount) - knownCount);
      const info = Math.min(2, unknownCount) * 0.35;
      return actorEnemy ? info : -info;
    }
    case "harvest": return actorEnemy ? 2 * 1.1 : -2 * 1.1;
    case "charge": return actorEnemy ? 1.2 : -1.2;
    case "exposeWeakness": return actorEnemy ? 1.5 : -1.5;
    case "plunder": {
      if (!target?.alive || !hasResource(target)) return 0;
      if (selection?.zone) {
        const selected = {
          ...selection,
          definitionId:selection.definitionId
            ?? (selection.zone === "equipment" ? target.equipmentDefinitionId : null)
        };
        return selectedResourceStateValue(target, selected, responder.id)
          + (selection.zone === "hand"
              ? selectedResourceStateValue(actor, selected, responder.id)
              : 1.1);
      }
      const threat = actorEnemy && knownAssault(target) ? HP_VALUE : 0;
      return actorEnemy ? 2.2 + threat : -(2.2 + threat);
    }
    case "destroy": {
      if (!target?.alive || !hasResource(target)) return 0;
      if (selection?.zone) {
        return selectedResourceStateValue(target, {
          ...selection,
          definitionId:selection.definitionId
            ?? (selection.zone === "equipment" ? target.equipmentDefinitionId : null)
        }, responder.id);
      }
      const threat = !actorEnemy && knownAssault(target) ? HP_VALUE : 0;
      return (target.battleTeam === team ? 1.1 + threat : 1.1) * (actorEnemy ? 1 : -1);
    }
    case "transfer": {
      const from = state.players.find((player) => player.id === selection?.sourceId) ?? null;
      const receiver = state.players.find((player) => player.id === selection?.receiverId) ?? null;
      const fromValue = selectedResourceStateValue(from, selection, responder.id);
      const receiverValue = selectedResourceStateValue(receiver, selection, responder.id);
      return (from?.battleTeam === team ? fromValue : -fromValue)
        + (receiver?.battleTeam === team ? -receiverValue : receiverValue);
    }
    case "counter": return getBaseCardAiValue("counter");
    case "seal": return actorEnemy ? 2.8 : -2.8;
    case "lightning": return actorEnemy ? 2.8 : -2.8;
    case "leverage": {
      if (!target?.alive) return 0;
      return actorEnemy && target.equipmentDefinitionId ? 2 : -2;
    }
    default: return 0;
  }
}

/*
功能
在确定规划世界中比较反制收益与成本并返回响应意愿。

调用方
Evaluator.decidePlanningCounter 与直接价值测试。

输入
World、响应上下文、全体受益查询、root guard 与动态收益查询。

输出
确定的 respond / do-not-respond 布尔值。

读取状态
输入状态的 canonical Counter capacity、阵营与 root 上下文。

写入状态
无。

调用函数
globalBenefitCounterDecision、queryPlayerHandProbability、counterOpportunityCost、dynamicCounterGain。

边界与不变量
先处理全体受益，再执行递归守卫和无容量短路；价值分数不得作为随机响应概率。
*/
export function planningCounterDecision(
  state,
  responder,
  actor,
  card,
  targets,
  selection,
  { assessGlobalBenefit:assessGlobalBenefitQuery, simulatingRootResolution = false, dynamicCounterGain }
) {
  const globalDecision = globalBenefitCounterDecision(
    assessGlobalBenefitQuery,
    state.players,
    responder.battleTeam,
    card.definitionId,
    {
      rootSourceId:actor?.id ?? null,
      counterDepth:0,
      remainingCardCounts:queryCurrentCardCounts(state.probabilityState)
    }
  );
  if (globalDecision !== null) return globalDecision;
  if (simulatingRootResolution) return false;
  const hasCounter = queryPlayerHandProbability(
    state.probabilityState, responder, "counter"
  ).probability > 0;
  if (!hasCounter) return false;
  const gain = dynamicCounterGain(state, responder, actor, card, targets, selection);
  return dynamicCounterWillingness(gain);
}

/*
功能
按单卡保留价值稳定排列弃牌候选。

调用方
chooseDiscardCandidates 与直接价值测试。

输入
玩家、合法卡牌数组与公开弃牌上下文。

输出
新的保留价值升序数组。

读取状态
CardValue 单卡 primitive。

写入状态
无；不修改输入数组。

调用函数
getDiscardKeepValue。

边界与不变量
同分保持输入顺序；本函数拥有最终排序而不拥有单卡价值公式。
*/
export function rankDiscardCandidates(player, cards, context = {}) {
  return [...cards].sort((left, right) => (
    getDiscardKeepValue(player, left, context) - getDiscardKeepValue(player, right, context)
  ));
}

/*
功能
从合法卡牌候选中选择指定数量的最低保留价值实体。

调用方
  Controller、AI runtime 与测试。

输入
玩家、合法卡牌、数量与公开弃牌上下文。

输出
按稳定顺序选择的卡牌数组。

读取状态
CardValue 单卡 primitive。

写入状态
无。

调用函数
rankDiscardCandidates。

边界与不变量
数量向下取整并限制为非负；不解析匿名实体或移动卡牌。
*/
export function chooseDiscardCandidates(player, cards, count, context = {}) {
  return rankDiscardCandidates(player, cards, context)
    .slice(0, Math.max(0, Math.floor(Number(count) || 0)));
}

/*
功能
从自己合法手牌中按角色 CardValue 稳定选择最低价值实体 ID。

调用方
Controller hidden-card runtime resolution。

输入
当前玩家与已过滤实体候选。

输出
最低价值 cardId 或 null。

读取状态
CardValue 角色 primitive。

写入状态
无。

调用函数
getRoleCardAiValue。

边界与不变量
同分保持输入位置；只比较调用方合法提供的已知实体。
*/
export function chooseLowestRoleCardId(player, cards) {
  let best = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const card of cards ?? []) {
    const value = getRoleCardAiValue(player.characterId, card.definitionId);
    if (value < bestValue) {
      best = card;
      bestValue = value;
    }
  }
  return best?.id ?? null;
}

/*
功能
从合法记忆覆盖的候选位置中按全局 CardValue 稳定选择最低价值实体 ID。

调用方
Controller 的 scout/spy-gap 与默认隐藏选择。

输入
cardId→definitionId 合法记忆映射和已过滤实体候选。

输出
最低合法已知 cardId 或 null。

读取状态
CardValue 基础 primitive。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
不读取没有合法记忆的实体 definitionId；同分保持输入位置。
*/
export function chooseLowestKnownCardId(known, cards) {
  let best = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const card of cards ?? []) {
    const definitionId = known?.[card.id];
    if (!definitionId) continue;
    const value = getBaseCardAiValue(definitionId);
    if (value < bestValue) {
      best = card;
      bestValue = value;
    }
  }
  return best?.id ?? null;
}

export const MIN_TRANSFER_UTILITY = 0.5;
const HUMAN_ALLY_HAND_PROTECTION = 7;
const MIN_ENEMY_REDISTRIBUTION_THREAT_GAP = 4;
const MIN_ENEMY_REDISTRIBUTION_UTILITY = 5;

/*
功能
计算排除指定实体后的一名玩家手牌期望数量。

调用方
Evaluator 的转移资源与组合评估。

输入
过滤后的 World 玩家与可选排除 ID 集合。

输出
非负手牌期望数量。

读取状态
玩家 hand/handCount 与卡牌 availability。

写入状态
无。

调用函数
cardAvailability。

边界与不变量
没有实体 hand 的玩家只使用公开 handCount；不得从未知手牌读取 definitionId。
*/
function transferHandCount(player, excludedCardIds = null) {
  if (Array.isArray(player?.hand)) {
    return player.hand
      .filter((card) => !excludedCardIds?.has(card.id))
      .reduce((sum, card) => sum + cardAvailability(card), 0);
  }
  return Math.max(0, Number(player?.handCount ?? 0));
}

/*
功能
把一张资源从来源移到接收者的双方阵营价值组合为局部转移效用。

调用方
evaluateTransferSelection。

输入
行动者、来源、接收者及该资源对双方的 CardValue primitive。

输出
三种 AI 战略方向的既有效用；己方来源到敌方接收者返回负无穷。

读取状态
battleTeam 与 id。

写入状态
无。

调用函数
无。

边界与不变量
该方向限制是 AI preference，不是 Domain legality，也不得在执行边界再次检查。
*/
function transferResourceUtility(actor, from, receiver, sourceValue, receiverValue) {
  if (!actor || !from || !receiver || from.id === receiver.id) {
    return Number.NEGATIVE_INFINITY;
  }
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;
  if (sourceIsAlly && !receiverIsAlly) return Number.NEGATIVE_INFINITY;
  if (sourceIsAlly && receiverIsAlly) return receiverValue - sourceValue;
  if (!sourceIsAlly && receiverIsAlly) return sourceValue + receiverValue;
  return sourceValue - receiverValue;
}

/*
功能
把过滤后的玩家状态归一化为 StateValue threat primitive 可消费的转移视图。

调用方
transferEnemyThreatGap。

输入
World 玩家。

输出
不含未知牌定义的公开 threat view。

读取状态
公开生命、资源、状态、角色标签与手牌数量。

写入状态
无。

调用函数
transferHandCount。

边界与不变量
保留 player ID 以维持近期攻击者记忆语义。
*/
function transferThreatView(player) {
  return {
    id:player?.id,
    alive:Boolean(player?.alive),
    battleTeam:player?.battleTeam,
    hp:Number(player?.hp ?? 0),
    maxHp:Number(player?.maxHp ?? player?.hp ?? 0),
    shield:Number(player?.shield ?? 0),
    energy:Number(player?.energy ?? 0),
    handCount:transferHandCount(player),
    statuses:Array.isArray(player?.statuses)
      ? player.statuses
      : Object.keys(player?.statuses ?? {}),
    roleTags:player?.roleTags ?? [],
    tags:player?.tags ?? []
  };
}

/*
功能
计算敌方来源相对敌方接收者的公开威胁差。

调用方
evaluateTransferSelection。

输入
行动者、来源与接收者 World 玩家。

输出
StateValue threat primitive 差值。

读取状态
公开玩家字段与行动者合法近期攻击者记忆。

写入状态
无。

调用函数
threatScore、transferThreatView。

边界与不变量
不读取任一未知手牌定义。
*/
function transferEnemyThreatGap(actor, from, receiver) {
  const memory = actor?.aiMemory ?? {};
  return threatScore(transferThreatView(actor), transferThreatView(from), memory)
    - threatScore(transferThreatView(actor), transferThreatView(receiver), memory);
}

/*
功能
对一个已由 Generator 枚举的 source/receiver/resource 选择计算完整转移 preference。

调用方
Evaluator.evaluateTransferAction。

输入
行动者、来源、接收者、canonical Action selection、排除 ID 与 remaining-card counts。

输出
包含冻结分数、资源身份和稳定比较字段的局部候选记录。

读取状态
CardValue primitive、公开关系/容量、StateValue threat primitive 与控制器类型。

写入状态
无。

调用函数
transferResourceUtility、getTransferCardValue、getUnknownTransferCardValue、transferEnemyThreatGap。

边界与不变量
不生成合法组合；策略门槛保持冻结，且 preference 不重复加进 State delta。
*/
function evaluateTransferSelection({
  actor,
  from,
  receiver,
  selection,
  excludedCardIds = null,
  remainingCardCounts = null
}) {
  const invalid = {
    sourceId:from?.id ?? selection?.sourceId ?? null,
    sourceSeatIndex:from?.seatIndex ?? 0,
    receiverId:receiver?.id ?? selection?.receiverId ?? null,
    selectionKind:selection?.selectionKind ?? null,
    cardId:selection?.cardId ?? null,
    definitionId:selection?.definitionId ?? null,
    knownCardIds:selection?.knownCardIds ?? [],
    availableUnknownCount:selection?.availableUnknownCount ?? 0,
    expectedValue:null,
    score:Number.NEGATIVE_INFINITY
  };
  if (!actor || !from || !receiver || from.id === receiver.id
    || selection?.zone !== "hand" || transferHandCount(from, excludedCardIds) <= 0) {
    return Object.freeze(invalid);
  }
  let sourceValue;
  let receiverValue;
  if (selection.selectionKind === "known" && selection.definitionId) {
    sourceValue = getTransferCardValue(selection.definitionId, from);
    receiverValue = getTransferCardValue(selection.definitionId, receiver);
  } else if (selection.selectionKind === "unknown") {
    sourceValue = getUnknownTransferCardValue(from, remainingCardCounts);
    receiverValue = getUnknownTransferCardValue(receiver, remainingCardCounts);
  } else {
    return Object.freeze(invalid);
  }
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;
  let score = transferResourceUtility(actor, from, receiver, sourceValue, receiverValue);
  const fromLimit = Math.max(0, Number(from.hp ?? 0));
  const receiverLimit = Math.max(0, Number(receiver.hp ?? 0));
  const sourceOverflow = Math.max(0, transferHandCount(from, excludedCardIds) - fromLimit);
  const receiverSpace = Math.max(
    0,
    receiverLimit - transferHandCount(receiver, excludedCardIds)
  );
  if (sourceIsAlly && receiverIsAlly) score += Math.min(sourceOverflow, receiverSpace) * 4;
  if (!sourceIsAlly && sourceOverflow > 0) score -= Math.min(sourceOverflow, 2) * 2;
  if (receiverIsAlly && receiverSpace === 0) score -= receiverValue * 0.75;
  if (!receiverIsAlly && receiverSpace === 0) score += 1;
  if (sourceIsAlly && from.controllerType === "human") score -= HUMAN_ALLY_HAND_PROTECTION;
  if (!sourceIsAlly && !receiverIsAlly) {
    if (transferEnemyThreatGap(actor, from, receiver)
      < MIN_ENEMY_REDISTRIBUTION_THREAT_GAP
      || score < MIN_ENEMY_REDISTRIBUTION_UTILITY) {
      score = Number.NEGATIVE_INFINITY;
    }
  }
  return Object.freeze({
    ...invalid,
    expectedValue:receiverValue,
    score
  });
}

/*
功能
按旧分数与稳定键比较两个 Transfer preference。

调用方
Evaluator.compareCandidates。

输入
两个 evaluateTransferSelection 结果。

输出
left 更优返回正数，right 更优返回负数，完全等价返回零。

读取状态
候选 score、source seat、receiver ID 与资源身份。

写入状态
无。

调用函数
String.localeCompare。

边界与不变量
顺序保持 score 降序、source seat 升序、receiver ID 升序、known 优先、card ID 升序。
*/
function compareTransferPreferences(left, right) {
  if (left.score !== right.score) return left.score > right.score ? 1 : -1;
  if (left.sourceSeatIndex !== right.sourceSeatIndex) {
    return left.sourceSeatIndex < right.sourceSeatIndex ? 1 : -1;
  }
  const receiverOrder = String(right.receiverId ?? "").localeCompare(
    String(left.receiverId ?? "")
  );
  if (receiverOrder) return receiverOrder;
  if (left.selectionKind !== right.selectionKind) {
    return left.selectionKind === "known" ? 1 : -1;
  }
  return String(right.cardId ?? "").localeCompare(String(left.cardId ?? ""));
}

const FUTURE_DISCOUNT = 0.65;
const MIN_TURN_TIMING_FACTOR = 0.7;
const TURN_TIMING_STEP = 0.1;

/*
功能
计算当前行动者之后到目标行动前隔着的存活角色数量。

调用方
turnTimingFactor 与直接先验测试。

输入
过滤状态、行动者与目标。

输出
非负间隔数；非法或同一角色返回 Infinity。

读取状态
公开存活座次环。

写入状态
无。

调用函数
Domain getAliveRing。

边界与不变量
只描述座次时机，不判断封印合法性或修改真实回合顺序。
*/
export function turnOrderGap(state, actor, target) {
  if (!actor?.alive || !target?.alive || actor.id === target.id) return Infinity;
  const ring = getAliveRing(projectRulePlayers(state?.players ?? []));
  const actorIndex = ring.findIndex((player) => player.id === actor.id);
  const targetIndex = ring.findIndex((player) => player.id === target.id);
  if (actorIndex < 0 || targetIndex < 0 || ring.length < 2) return Infinity;
  const forwardSteps = (targetIndex - actorIndex + ring.length) % ring.length;
  return forwardSteps > 0 ? forwardSteps - 1 : Infinity;
}

/*
功能
把封印目标距离其下次行动的座次间隔转换为温和先验折扣。

调用方
sealUseValue 与直接先验测试。

输入
过滤状态、行动者与目标。

输出
0.7 到 1 之间的时机因子。

读取状态
turnOrderGap 的公开座次结果。

写入状态
无。

调用函数
turnOrderGap。

边界与不变量
下一位为一，每多隔一人扣零点一，最低保持既有零点七。
*/
export function turnTimingFactor(state, actor, target) {
  const gap = turnOrderGap(state, actor, target);
  return Number.isFinite(gap)
    ? Math.max(MIN_TURN_TIMING_FACTOR, 1 - gap * TURN_TIMING_STEP)
    : MIN_TURN_TIMING_FACTOR;
}

/*
功能
计算主动使用封印的基础牌值与未来跳过出牌阶段收益。

调用方
搜索先验.actionUtility 与直接先验测试。

输入
行动者、目标与过滤后的 World。

输出
封印候选的搜索先验；非法目标返回既有负五十。

读取状态
封印领域概率、目标机会价值和公开座次。

写入状态
无。

调用函数
Fact.hasFactStatus、Probability.sealOutcomeProbabilities、turnOpportunityValue、turnTimingFactor。

边界与不变量
只为候选展开排序；既有基础值、0.65 折扣与座次因子不得进入 final transition；概率在消费点惰性查询。
*/
export function sealUseValue(actor, target, state) {
  if (!actor?.alive || !target?.alive
    || target.battleTeam === actor.battleTeam || hasFactStatus(target, "sealed")) {
    return -50;
  }
  const futureTarget = {
    ...target,
    statuses:[...new Set([...(Array.isArray(target.statuses) ? target.statuses : []), "sealed"])],
    sealedStatusProbability:1
  };
  const skipAction = sealOutcomeProbabilities(state, futureTarget).skipAction;
  return getBaseCardAiValue("seal")
    + skipAction * turnOpportunityValue(target, state) * FUTURE_DISCOUNT
      * turnTimingFactor(state, actor, target);
}

const BURNING_FIELD_SEARCH_PRIOR = 8;
// 这些权重只维持有限 beam 的相对探索顺序，不是单位换算，也不得进入 Final Utility。
const STATE_UTILITY_PRIOR_WEIGHT = 0.4;

const END_PRIOR_PENALTY = 0.8;
const SKILL_THRESHOLD_PRIOR_BONUS = 4;
const END_SKILL_SAFETY_WEIGHT = 1;
const TEAM_SAFETY_TERM_KEYS = Object.freeze([
  "danger",
  "hp2Risk",
  "rescueOutlook",
  "hp",
  "shield",
  "markThreat",
  "residualExposureValue"
]);
const TEAM_DANGER_TERM_KEYS = Object.freeze(
  TEAM_SAFETY_TERM_KEYS.filter((key) => key !== "hp")
);

/*
功能
估算 root 目标可被资源动作分支处理的公开资源数量。

调用方
搜索先验.rootSchedulingScore。

输入
过滤玩家摘要或根动作携带的公开目标。

输出
手牌数量加至多一个装备资源的非负数量。

读取状态
目标 handCount/hand 与 equipmentDefinitionId/equipment。

写入状态
无。

调用函数
无。

边界与不变量
只用于廉价分支工作估算，不读取隐藏牌身份或生成资源选择。
*/
function rootSchedulingResourceCount(entry) {
  return (entry?.handCount ?? entry?.hand?.length ?? 0)
    + (entry?.equipmentDefinitionId || entry?.equipment ? 1 : 0);
}

export class Evaluator {
  /*
  功能
  绑定状态估值所需的稳定规则查询能力。

  调用方
  Controller 组合根（统一组装依赖的位置） 与纯价值测试。

  输入
  可选根 World、getMaxEnergy/getTurnEnergyBreakdown 显式规则函数与难度查询。

  输出
  不持有 Game 的纯状态评估器实例。

  读取状态
  仅保存规则函数引用。

  写入状态
  写入实例的不可变依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Simulator、Searcher 或 Controller；Worker 缺显式回调时只从根 World 调用 Domain 能量规则。
  */
  constructor({
    world = null,
    getMaxEnergy = null,
    getTurnEnergyBreakdown = null,
    getDifficultyMultiplier = () => 1,
    forceAiRescueHuman = true
  } = {}) {
    const energyState = world ? { players:world.players } : null;
    this.energyRules = Object.freeze({
      getMaxEnergy:typeof getMaxEnergy === "function"
        ? getMaxEnergy
        : (energyState ? (player) => getDomainMaxEnergy(energyState, player) : null),
      getTurnEnergyBreakdown:typeof getTurnEnergyBreakdown === "function"
        ? getTurnEnergyBreakdown
        : (energyState
            ? (player) => getDomainTurnEnergyBreakdown(energyState, player)
            : null)
    });
    this.getDifficultyMultiplier = getDifficultyMultiplier;
    this.forceAiRescueHuman = Boolean(forceAiRescueHuman);
  }

  /*
  功能
  从公开合法牌池中按领取或换装后的最大 StateValue 边际稳定选择实体 ID。

  调用方
  Controller.choosePublicCard。

  输入
  当前玩家、公开卡牌、领取前 World，以及 Simulator 为每张牌准备的领取/可选换装 Worlds。

  输出
  最大真实状态边际的 cardId；空牌池或缺少合法 outcome 时返回 null。

  读取状态
  领取前后 World 的正式 StateValue，以及当前装备和手牌状态。

  写入状态
  无。

  调用函数
  stateUtility。

  边界与不变量
  Simulator 唯一构造状态；Evaluator 只比较已准备 Worlds；装备可保留在手牌或替换当前槽位，
  重复装备不被硬禁；同分保持公开池原始顺序，静态 CardValue 不再代替边际状态。
  */
  choosePublicCardId(player, cards, beforeState, receiptOutcomes) {
    if (!player || !beforeState || !Array.isArray(cards) || cards.length === 0) return null;
    const outcomesByCardId = new Map(
      (receiptOutcomes ?? []).map((outcome) => [outcome.cardId, outcome])
    );
    const beforeValue = this.stateUtility(beforeState, player.id);
    let bestCardId = null;
    let bestMarginal = Number.NEGATIVE_INFINITY;
    for (const card of cards) {
      const outcome = outcomesByCardId.get(card.id);
      const worlds = Array.isArray(outcome?.worlds) ? outcome.worlds : [];
      const marginal = worlds.reduce((maximum, world) => Math.max(
        maximum,
        this.stateUtility(world, player.id) - beforeValue
      ), Number.NEGATIVE_INFINITY);
      if (marginal > bestMarginal) {
        bestCardId = card.id;
        bestMarginal = marginal;
      }
    }
    return bestCardId;
  }

  /*
  功能
  计算破军新增一次攻击容量在当前手牌中的展开优先级。

  调用方
  actionUtility 与正式边界。

  输入
  actor 的过滤后状态。

  输出
  可兑现额外容量乘角色突袭静态值的 prior。

  读取状态
  只读突袭概率手牌与剩余攻击次数分支。

  写入状态
  无。

  调用函数
  CardValue 静态入口。

  边界与不变量
  只用于搜索展开，不能进入 final transition。
  */
  breakArmyUtility(actor) {
    const assaultCount = (actor.hand ?? [])
      .filter((card) => card.definitionId === "assault")
      .reduce((sum, card) => sum + cardAvailability(card), 0);
    const availableAttackUses = Math.max(
      0,
      (Number(actor.attackLimit ?? actor.turnFlags?.attackLimit) || 0)
        - (Number(actor.attackUsed ?? actor.turnFlags?.attackUsed) || 0)
    );
    const redeemableExtraCapacity = Math.min(
      1,
      Math.max(0, assaultCount - availableAttackUses)
    );
    const assaultSearchValue = actor.characterId
      ? getRoleCardAiValue(actor.characterId, "assault")
      : getBaseCardAiValue("assault");
    return redeemableExtraCapacity * assaultSearchValue;
  }

  /*
  功能
  为窥探候选提供廉价的决策相关性排序代理。

  调用方
  actionUtility 的 scout 分支。

  输入
  窥探使用者、被查看目标与过滤后 World。

  输出
  零到一的排序相关性；只用于 prior。

  读取状态
  使用者合法已知手牌、目标 resource probability、生命与公开威胁。

  写入状态
  无。

  调用函数
  cardAvailability、StateValue incomingExposure primitive。

  边界与不变量
  只用关键资源的最大二项分布方差作轻量代理，不复制正式 VOI 求和；
  不读装备或隐藏牌面，不以敌友身份给固定加减分。
  */
  scoutDecisionRelevance(actor, target, visible) {
    const decisionDefinitions = (actor?.hand ?? [])
      .filter((entry) => cardAvailability(entry) > 0)
      .map((entry) => entry)
      .filter((definition) => !definition.subtypes?.includes("information"));
    const offensiveDecision = Math.min(1, Math.max(
      0,
      queryPlayerHandProbability(
        visible.probabilityState, actor, "assault"
      ).expected,
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
    const assaultProbability = queryPlayerHandProbability(
      visible.probabilityState, target, "assault"
    ).probability;
    const blockProbability = queryPlayerHandProbability(
      visible.probabilityState, target, "block"
    ).probability;
    const counterProbability = queryPlayerHandProbability(
      visible.probabilityState, target, "counter"
    ).probability;
    const assaultUncertainty = assaultProbability * (1 - assaultProbability) / 0.25;
    const blockUncertainty = blockProbability * (1 - blockProbability) / 0.25;
    const counterUncertainty = counterProbability * (1 - counterProbability) / 0.25;

    if (target.battleTeam !== actor.battleTeam) {
      const teamThreatRelevance = (visible?.players ?? [])
        .filter((player) => player.alive && player.battleTeam === actor.battleTeam)
        .reduce((highest, player) => Math.max(
          highest,
          Math.min(1, Math.max(
            0,
            (player.maxHp > 0 ? (player.maxHp - player.hp) / player.maxHp : 0)
              + incomingExposure(visible, player) / HP_VALUE
          ))
        ), 0);
      return Math.min(1, Math.max(
        blockUncertainty * offensiveDecision,
        counterUncertainty * tacticDecision,
        assaultUncertainty * Math.max(teamThreatRelevance, protectionDecision)
      ));
    }

    const allySurvivalRelevance = Math.min(1, Math.max(
      0,
      (target.maxHp > 0 ? (target.maxHp - target.hp) / target.maxHp : 0)
        + incomingExposure(visible, target) / HP_VALUE
    )) * protectionDecision;
    const enemyKillRelevance = (visible?.players ?? [])
      .filter((player) => player.alive && player.battleTeam !== actor.battleTeam)
      .reduce((highest, player) => Math.max(
        highest,
        player.maxHp > 0 ? Math.min(1, Math.max(0, (player.maxHp - player.hp) / player.maxHp)) : 0
      ), 0);
    return Math.min(1, Math.max(
      allySurvivalRelevance * Math.max(
        blockUncertainty,
        counterUncertainty
      ),
      enemyKillRelevance * Math.max(offensiveDecision, tacticDecision) * assaultUncertainty
    ));
  }

  /*
  功能
  计算昂贵 root materialization 前的廉价、确定性探索顺序分数。

  调用方
  Searcher root scheduling。

  输入
  根候选动作、行动者与过滤后的根 World。

输出
  由有界机会收益除以估算分支工作得到的有限调度密度；end 始终排在合法 non-end 后。

  读取状态
  只读卡牌/角色静态值、公开阵营、目标 HP/资源、行动者能量门槛与现成 selection。

  写入状态
  无。

  调用函数
  CardValue 静态入口、getEquipmentKeepValueDeduction。

  边界与不变量
  不调用 Simulator、hidden-world query、Seal/Lightning/GlobalBenefit 动态模型或大型概率操作；
  所有动作类别共用同一密度尺度，不设置类别 tier；
  本分数不进入 Evaluator Final Utility、beam prior 或 COMPLETE 最终比较。
  */
  rootSchedulingScore(action, player, visible) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") return Number.NEGATIVE_INFINITY;
    const target = visible.players.find((entry) => entry.id === action.targetIds?.[0]) ?? null;
    if (action.type === "skill") {
      const skill = ACTIVE_SKILL_DEFINITIONS[action.skillId] ?? null;
      const missingHp = target ? Math.max(0, target.maxHp - target.hp) : 0;
      const skillScores = {
        breakArmy: actor.characterId
          ? getRoleCardAiValue(actor.characterId, "assault")
          : getBaseCardAiValue("assault"),
        barrier:missingHp,
        symbiosis:missingHp,
        stealSkill:5 + Math.min(4, rootSchedulingResourceCount(target)),
        burningField:BURNING_FIELD_SEARCH_PRIOR,
        hunt:7 + (target?.hp <= 2 ? 7 : 0),
        allIn:Math.max(0, actor.energy - 1) * 3,
        resonance:5 + (target?.handCount <= 1 ? 3 : 0)
      };
      const branchingWork = skill?.targetType === "enemyWithCardsOrEquipment"
        ? 1 + rootSchedulingResourceCount(target)
        : 1;
      const density = (Number(skillScores[action.skillId] ?? 4) || 0) / branchingWork;
      return density / (1 + Math.abs(density));
    }
    const card = CARD_DEFINITIONS[action.cardId] ?? null;
    if (!card?.definitionId) return 0;
    let score = actor.characterId
      ? getRoleCardAiValue(actor.characterId, card.definitionId)
      : (Number.isFinite(card.aiValue)
        ? card.aiValue
        : getBaseCardAiValue(card.definitionId));
    if (target) {
      const enemy = target.battleTeam !== actor.battleTeam;
      if (card.subtypes?.includes("attack") || card.definitionId === "duel") {
        const missingHp = Math.max(0, target.maxHp - target.hp);
        score += enemy
          ? missingHp * 3 + (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0)
          : -12;
        if (enemy && card.counterable === false && Number(card.baseDamage) > 0) {
          score += Number(card.baseDamage) * HP_VALUE;
        }
      }
      if (["plunder", "destroy"].includes(card.definitionId)) {
        const equipmentWeight = target.equipmentDefinitionId || target.equipment
          ? (card.definitionId === "plunder" ? 1 : 2)
          : 0;
        score += Math.min(
          5,
          (target.handCount ?? target.hand?.length ?? 0) + equipmentWeight
        );
        if (!enemy) score -= 30;
      }
    }
    if (card.definitionId === "charge") {
      score += Math.max(0, actor.maxEnergy - actor.energy) * 1.5
        + (actor.activeSkillId && !actor.activeSkillUsed
          && actor.energy < actor.activeSkillCost
          && actor.energy + 1 >= actor.activeSkillCost
          ? SKILL_THRESHOLD_PRIOR_BONUS
          : 0);
    }
    if (card.definitionId === "transfer") {
      const selectionScore = Number(action.selection?.score);
      if (Number.isFinite(selectionScore)) score = selectionScore;
    }
    const equippedDefinitionId = actor.equipmentDefinitionId
      ?? actor.equipment?.definitionId
      ?? null;
    if (card.category === "equipment" && equippedDefinitionId) {
      score -= getEquipmentKeepValueDeduction(
        actor.characterId ?? null,
        card.definitionId,
        equippedDefinitionId,
        actor.equipmentRetentionProbability ?? 1
      );
    }
    const targets = (action.targetIds ?? []).map((targetId) => (
      visible.players.find((entry) => entry.id === targetId)
    )).filter(Boolean);
    let branchingWork = 1;
    if (card.subtypes?.includes("hidden-selection")) {
      const sourceId = action.selection?.sourceId;
      const resourceOwner = sourceId
        ? visible.players.find((entry) => entry.id === sourceId)
        : target;
      branchingWork += rootSchedulingResourceCount(resourceOwner);
    }
    if (card.subtypes?.includes("attack")) {
      branchingWork += targets.reduce((sum, entry) => {
        const block = queryPlayerHandProbability(
          visible.probabilityState, entry, "block"
        );
        return sum + block.probability + queryPlayerHandProbability(
          visible.probabilityState, entry, "block", 2
        ).probability;
      }, 0);
    }
    if (card.counterable) {
      const responders = card.counterScope === "target"
        ? targets
        : visible.players.filter((entry) => (
            entry.alive && entry.battleTeam !== actor.battleTeam
          ));
      branchingWork += 1 + responders.reduce((sum, entry) => sum
        + queryPlayerHandProbability(
          visible.probabilityState, entry, "counter"
        ).probability, 0);
    }
    if (!Number.isFinite(score)) return 0;
    const density = score / branchingWork;
    // 所有动作类别共用同一有界机会密度尺度；类别本身不构成探索优先级，
    // 否则 basic/tactic/equipment 的固定分层会掩盖实际收益与分支成本。
    return density / (1 + Math.abs(density));
  }

  /*
  功能
  计算动作在 beam pruning/ranking 中的既有静态与上下文 prior。

  调用方
  Searcher pruneScore、正式边界与测试。

  输入
  候选动作、真实 player 执行视图、过滤状态与显式 options。

  输出
  仅用于搜索顺序的数值 prior。

  读取状态
  只读公开动作、合法记忆、可见状态及闪电生命周期查询结果。

  写入状态
  无；闪电查询只写自身缓存。

  调用函数
  CardValue、StateValue threat primitive、sealUseValue、assessGlobalBenefit 与 lightningLifecycleValue。

  边界与不变量
  静态牌值、目标焦点和领域启发式绝不进入 valueScore；已在 after-state 的收益这里只能作展开偏置。
  闪电生命周期只消费调用方准备完成的 outcome Worlds，不得调用或保存 Simulator。
  */
  actionUtility(action, player, visible, options = {}) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") {
      const remainingCards = actor.handCount ?? actor.hand?.length ?? player.hand.length;
      return remainingCards > 0 ? -END_PRIOR_PENALTY : 0;
    }
    if (action.type === "skill") {
      const target = visible.players.find((entry) => entry.id === action.targetIds?.[0]) ?? null;
      const missing = target ? Math.max(0, target.maxHp - target.hp) : 0;
      const values = {
        breakArmy: this.breakArmyUtility(actor),
        barrier: 0,
        symbiosis: 0,
        stealSkill: 5 + Math.min(
          4,
          (target?.handCount ?? 0) + (target?.equipmentDefinitionId ? 1 : 0)
        ),
        burningField: 0,
        hunt: 7 + (target?.hp <= 2 ? 7 : 0),
        allIn: Math.max(0, actor.energy - 1) * 3
          + Math.min(1, actor.energy * 0.25) * (1 - (actor.assaultBonus ?? 0)) * 4,
        resonance: 5 + (target?.handCount <= 1 ? 3 : 0)
      };
      let value = values[action.skillId] ?? 4;
      if (["stealSkill", "hunt"].includes(action.skillId)) {
        value += this.threatPriority(actor, target, player.aiMemory, 1);
      }
      return value;
    }
    const card = CARD_DEFINITIONS[action.cardId] ?? null;
    if (!card) return 0;
    const identityDelta = roleCardDelta(actor?.characterId, card?.definitionId);
    let value = actor?.characterId && card?.definitionId
      ? getRoleCardAiValue(actor.characterId, card.definitionId)
      : (Number.isFinite(card?.aiValue)
        ? card.aiValue
        : (card?.definitionId ? getBaseCardAiValue(card.definitionId) : 0));
    if (card.definitionId === "lightning") {
      value = getBaseCardAiValue(card.definitionId)
        + statePointsToUtility(this.lightningLifecycleValue(
          visible,
          options.lightningOutcomeWorlds ?? [],
          actor.id
        )) * STATE_UTILITY_PRIOR_WEIGHT
        + identityDelta;
    }
    const target = visible.players.find((entry) => entry.id === action.targetIds?.[0]) ?? null;
    if (card.definitionId === "seal") {
      value = sealUseValue(actor, target, visible, options.searchBudget ?? null)
        + identityDelta;
    }
    if (target) {
      const enemy = target.battleTeam !== player.battleTeam;
      if (card.subtypes.includes("attack") || card.definitionId === "duel") {
        const focus = (target.maxHp - target.hp) * 3
          + (target.hp <= 2 ? 5 : 0)
          + (target.hp <= 1 ? 8 : 0);
        if (enemy && card.definitionId === "assault") {
          value += (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        } else if (enemy && !["assault", "shockwave"].includes(card.definitionId)) {
          value += 3 + focus;
        } else if (!enemy) {
          value -= 12;
        }
      }
      if (["plunder", "destroy"].includes(card.definitionId)) {
        const equipmentValue = target.equipmentDefinitionId || target.equipment
          ? (card.definitionId === "plunder" ? 1 : 2)
          : 0;
        value += Math.min(
          5,
          (target.hand?.length ?? target.handCount ?? 0) + equipmentValue
        );
      }
      if (card.definitionId === "scout") {
        const knownExpectedCount = (target.knownCards ?? [])
          .reduce((sum, entry) => sum + cardAvailability(entry), 0);
        const unknownCount = Math.max(
          0,
          (target.hand?.length ?? target.handCount ?? 0) - knownExpectedCount
        );
        const revealLimit = Math.max(1, Number(card.maxRevealCount) || 1);
        const actualNewRevealCount = Math.min(
          revealLimit,
          Math.max(0, action.selection?.unknownCount ?? 0)
        );
        const revealCoverage = Math.min(actualNewRevealCount, unknownCount) / revealLimit;
        value += getBaseCardAiValue(card.definitionId)
          * revealCoverage
          * this.scoutDecisionRelevance(actor, target, visible);
      }
      if (!enemy && ["plunder", "destroy"].includes(card.definitionId)) value -= 30;
      if (enemy && ["assault", "duel", "plunder", "destroy"].includes(card.definitionId)) {
        value += this.threatPriority(
          actor,
          target,
          player.aiMemory,
          ["assault", "duel"].includes(card.definitionId) ? 1 : 0
        );
      }
    }
    if (card.definitionId === "charge") {
      value += (actor.maxEnergy - actor.energy) * 1.5
        + (actor.activeSkillId && !actor.activeSkillUsed
          && actor.energy < actor.activeSkillCost
          && actor.energy + 1 >= actor.activeSkillCost
          ? SKILL_THRESHOLD_PRIOR_BONUS
          : 0);
    }
    if (card.definitionId === "provoke") {
      value += visible.players
        .filter((enemy) => enemy.alive && enemy.battleTeam !== actor.battleTeam)
        .reduce(
          (sum, enemy) => sum + (1 - queryPlayerHandProbability(
            visible.probabilityState, enemy, "assault"
          ).probability) * 3,
          0
        );
    }
    if (card.definitionId === "duel" && target) {
      value += (queryPlayerHandProbability(
        visible.probabilityState, actor, "assault"
      ).expected - queryPlayerHandProbability(
        visible.probabilityState, target, "assault"
      ).expected) * 2;
    }
    if (card.definitionId === "transfer") value += Number(action.selection?.score ?? 0);
    if (card.definitionId === "symbiosis") {
      const net = this.symbiosisNetFromState(actor, visible);
      value = (net > 0 ? 8 + net : -9 + net) + identityDelta;
    }
    const equippedDefinitionId = actor.equipmentDefinitionId
      ?? actor.equipment?.definitionId
      ?? null;
    if (card.category === "equipment" && equippedDefinitionId) {
      value -= getEquipmentKeepValueDeduction(
        actor?.characterId ?? null,
        card.definitionId,
        equippedDefinitionId,
        actor.equipmentRetentionProbability ?? 1
      );
    }
    return value;
  }

  /*
  功能
  从显式状态计算互利全局收益的搜索 prior。

  调用方
  actionUtility 与正式边界。

  输入
  actor 与过滤后的状态。

  输出
  assessGlobalBenefit 净收益乘既有缩放四。

  读取状态
  只读传入状态的公开玩家字段。

  写入状态
  无。

  调用函数
  assessGlobalBenefit。

  边界与不变量
  属于 SEARCH_PRIOR/POLICY_VALUE，不进入最终 transition。
  */
  symbiosisNetFromState(player, state) {
    return (assessGlobalBenefit(
      state.players,
      player.battleTeam,
      "symbiosis"
    )?.netBenefit ?? 0) * 4;
  }

  /*
  功能
  返回只服务当前层 beam pruning 的临时搜索信用。

  调用方
  Searcher pruneScore 与正式边界。

  输入
  动作、player 与 visible state。

  输出
  焚场返回既有八点 prior，其余返回零。

  读取状态
  只读动作技能 ID。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  BURNING_FIELD_SEARCH_PRIOR 是剪枝经验值，不是游戏价值，绝不进入 final valueScore。
  */
  actionSearchPrior(action, player, visible) {
    if (action.skillId === "burningField") return BURNING_FIELD_SEARCH_PRIOR;
    return 0;
  }

  /*
  功能
  判断一个候选是否需要匿名手牌样本来计算隐藏格挡搜索先验。

  调用方
  Searcher 的 generic hidden-world orchestration。

  输入
  canonical Action。

  输出
  仅突袭候选返回 true。

  读取状态
  只读 Action identity。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  该判断只控制 SEARCH_PRIOR 输入物化，不改变候选合法性或 Final Utility。
  */
  requiresHiddenWorldPrior(action) {
    return action?.cardId === "assault";
  }

  /*
  功能
  从匿名手牌样本计算突袭候选的既有格挡风险先验。

  调用方
  composeSearchPrior。

  输入
  canonical Action 与 Probability 产生的匿名手牌样本。

  输出
  仅用于 pruneScore 的数值 prior。

  读取状态
  目标 ID 与样本中的匿名定义数组。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  系数 -1.5、样本分母和零样本行为保持不变；不得进入 Final Utility。
  */
  hiddenWorldPrior(action, hiddenWorlds = []) {
    if (!this.requiresHiddenWorldPrior(action) || !hiddenWorlds.length) return 0;
    const targetId = action.targetIds?.[0];
    if (!targetId) return 0;
    return -1.5 * hiddenWorlds.filter(
      (world) => world[targetId]?.includes("block")
    ).length / hiddenWorlds.length;
  }

  /*
  功能
  判断一个候选是否需要为搜索先验构造闪电 outcome Worlds。

  调用方
  Searcher 的 generic value-input materialization。

  输入
  canonical Action。

  输出
  仅闪电候选返回 true。

  读取状态
  只读 Action identity。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只声明 Evaluator 的输入需求；World 构造仍由 Simulator 完成。
  */
  requiresActionLightningOutcomes(action) {
    return action?.cardId === "lightning";
  }

  /*
  功能
  组合一次候选仅用于探索顺序的全部搜索先验。

  调用方
  Searcher.evaluateCandidate。

  输入
  canonical Action、行动者、动作前 World、Simulator 已准备的闪电 outcome Worlds、预算与反事实数值项。

  输出
  domainPrior、searchCredit 与完整 prior。

  读取状态
  只读传入 World、Action 与显式数值项。

  写入状态
  无。

  调用函数
  actionUtility、actionSearchPrior、statePointsToUtility。

  边界与不变量
  该结果只用于 beam pruning；既有 0.4 权重与加法顺序不得进入 Final Utility。
  */
  composeSearchPrior({
    action,
    player,
    state,
    lightningOutcomeWorlds = [],
    searchBudget = null,
    hiddenWorlds = [],
    exposeMarginal = 0,
    assaultStacksCredit = 0
  }) {
    const hiddenPrior = this.hiddenWorldPrior(action, hiddenWorlds);
    const domainPrior = statePointsToUtility(
      exposeMarginal + assaultStacksCredit
    ) * STATE_UTILITY_PRIOR_WEIGHT;
    const searchCredit = this.actionSearchPrior(action, player, state);
    const prior = hiddenPrior
      + this.actionUtility(action, player, state, {
        searchBudget,
        lightningOutcomeWorlds
      })
      + searchCredit
      + domainPrior;
    return { domainPrior, searchCredit, prior };
  }

  /*
  功能
  识别一次 transition 是否需要自适应信息搜索，并返回被观察者。

  调用方
  Searcher 的 generic adaptive-information orchestration。

  输入
  before/after Worlds、canonical Action 与 actor ID。

  输出
  需要物化自适应信息时返回目标 ID，否则返回 null。

  读取状态
  Action identity、双方窥隙概率、角色与最后目标字段。

  写入状态
  无。

  调用函数
  clampProbability。

  边界与不变量
  具体角色与技能识别只能封装在 Evaluator；重复触发始终返回 null。
  */
  adaptiveInformationTarget(beforeState, afterState, action, actorId) {
    if (action?.cardId !== "assault") return null;
    const beforeActor = beforeState?.players?.find((player) => player.id === actorId);
    const afterActor = afterState?.players?.find((player) => player.id === actorId);
    if (afterActor?.characterId !== "shade-agent") return null;
    const beforeProbability = clampProbability(beforeActor?.spyGapTriggeredProbability
      ?? (beforeActor?.spyGapTriggered ? 1 : 0));
    const afterProbability = clampProbability(afterActor?.spyGapTriggeredProbability
      ?? (afterActor?.spyGapTriggered ? 1 : 0));
    if (afterProbability - beforeProbability <= PROBABILITY_EPSILON) return null;
    return afterActor.lastSpyGapTargetId ?? null;
  }

  /*
  功能
  把未知身份条件下的最佳后续值组合为自适应信息选项点数。

  调用方
  Searcher 完成 generic hidden-world/follow-up traversal 后。

  输入
  未观察基线最佳值与每个条件世界的观察后最佳值。

  输出
  非负 raw transition-option points。

  读取状态
  只读传入数值。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  公式冻结为 E[max utility] - max E[utility]；空样本与负边际返回零。
  */
  adaptiveInformationOptionPoints(baselineBest, informedBestValues) {
    if (!Number.isFinite(baselineBest) || !informedBestValues?.length) return 0;
    const informedTotal = informedBestValues.reduce((sum, value) => sum + value, 0);
    return Math.max(0, informedTotal / informedBestValues.length - baselineBest);
  }

  /*
  功能
  返回一次破势候选新增加、可供后续突袭比较的层数。

  调用方
  Searcher 的 generic paired-world marginal orchestration。

  输入
  canonical Action、before/after Worlds 与 actor ID。

  输出
  正新增层数；其它候选返回零。

  读取状态
  Action identity 与 actor 的 exposeWeaknessStacks。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只识别本 transition 新增层，既有层不重复进入该边际。
  */
  exposeMarginalStackDelta(action, beforeState, afterState, actorId) {
    if (action?.cardId !== "exposeWeakness") return 0;
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    return Math.max(
      0,
      (afterActor?.exposeWeaknessStacks ?? 0) - (beforeActor?.exposeWeaknessStacks ?? 0)
    );
  }

  /*
  功能
  判断一个后续候选是否能兑现破势层的边际价值。

  调用方
  Searcher 的 generic follow-up candidate traversal。

  输入
  canonical Action。

  输出
  仅突袭返回 true。

  读取状态
  只读 Action identity。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  这是 Evaluator 价值域筛选，不改变 Generator 合法候选集合。
  */
  realizesExposeMarginal(action) {
    return action?.cardId === "assault";
  }

  /*
  功能
  返回当前动作可兑现的回合初始破势 provenance 数量。

  调用方
  Searcher 的 generic current-action marginal orchestration。

  输入
  canonical Action 与剩余 provenance。

  输出
  突袭返回非负剩余层，其它动作返回零。

  读取状态
  只读 Action identity 和数值。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  新获得的层不属于回合初始 provenance；负数始终归零。
  */
  assaultMarginalStackCount(action, remainingProvenance) {
    return action?.cardId === "assault"
      ? Math.max(0, Number(remainingProvenance) || 0)
      : 0;
  }

  /*
  功能
  读取一次搜索开始时可被后续突袭兑现的破势 provenance。

  调用方
  Searcher 创建 calculation-local context。

  输入
  root actor 与 canonical World。

  输出
  actor 当前非负 exposeWeaknessStacks。

  读取状态
  World 中与 actor ID 对应的玩家。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只在搜索入口冻结一次；后续新增层不回写为 root provenance。
  */
  initialTransitionProvenance(actor, state) {
    const rootActor = state?.players?.find((entry) => entry.id === actor?.id);
    return Math.max(0, Number(rootActor?.exposeWeaknessStacks) || 0);
  }

  /*
  功能
  从 Simulator 已构造的 paired Worlds 计算非负状态价值边际。

  调用方
  Searcher 的 follow-up 与 current-action marginal orchestration。

  输入
  baseline/boosted Worlds、viewer ID 及两侧已构造闪电 outcome sets。

  输出
  非负 raw State Value delta。

  读取状态
  只读 paired Worlds 与 outcome Worlds。

  写入状态
  无。

  调用函数
  transitionDelta。

  边界与不变量
  两侧必须只在被测破势层上不同；负边际按既有语义截为零。
  */
  positiveWorldMarginal(
    baselineWorld,
    boostedWorld,
    viewerId,
    baselineLightningOutcomeSets = [],
    boostedLightningOutcomeSets = []
  ) {
    return Math.max(0, this.transitionDelta(
      baselineWorld,
      boostedWorld,
      viewerId,
      baselineLightningOutcomeSets,
      boostedLightningOutcomeSets
    ));
  }

  /*
  功能
  按真实 transition 前后层数推进回合初始破势 provenance。

  调用方
  Searcher candidate materialization。

  输入
  canonical Action、before/after Worlds、actor ID 与当前剩余 provenance。

  输出
  下一节点的非负剩余 provenance。

  读取状态
  Action identity 与 actor 前后 exposeWeaknessStacks。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只有突袭消费 provenance；保留比例沿用既有浮点运算，新获得层不会混入旧来源。
  */
  advanceTransitionProvenance(action, beforeState, afterState, actorId, remainingProvenance) {
    if (action?.cardId !== "assault") return remainingProvenance;
    if (!(remainingProvenance > 0)) return 0;
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    const beforeStacks = beforeActor?.exposeWeaknessStacks ?? 0;
    const afterStacks = afterActor?.exposeWeaknessStacks ?? 0;
    if (!(beforeStacks > 0)) return 0;
    return Math.max(0, remainingProvenance * Math.max(0, afterStacks / beforeStacks));
  }
  /*
  功能
  计算一个 Generator 已完整枚举的 canonical Transfer Action 的冻结 contextual preference。

  调用方
  evaluateTransition、main-thread/Worker 一致性测试。

  输入
  canonical Action、行动者与动作前 World。

  输出
  含 score、稳定比较字段和资源身份的只读 preference。

  读取状态
  World 玩家、Probability current counts 与 Action.selection。

  写入状态
  无。

  调用函数
  evaluateTransferSelection、queryCurrentCardCounts。

  边界与不变量
  只评价 Generator 已给出的合法 Action；unknown selection 不得携带或读取 definitionId。
  */
  evaluateTransferAction(action, actor, state) {
    const stateActor = state?.players?.find((player) => player.id === actor?.id) ?? actor;
    const selection = action?.selection ?? null;
    const from = state?.players?.find((player) => player.id === selection?.sourceId) ?? null;
    const receiver = state?.players?.find(
      (player) => player.id === selection?.receiverId
    ) ?? null;
    const excludedCardIds = action?.cardInstanceId
      ? new Set([action.cardInstanceId])
      : null;
    const remainingCardCounts = state?.probabilityState
      ? queryCurrentCardCounts(state.probabilityState)
      : state?.remainingCardCounts ?? null;
    if (action?.type !== "card" || action?.cardId !== "transfer") {
      return evaluateTransferSelection({
        actor:null,
        from:null,
        receiver:null,
        selection:null
      });
    }
    return evaluateTransferSelection({
      actor:stateActor,
      from,
      receiver,
      selection,
      excludedCardIds,
      remainingCardCounts
    });
  }

  /*
  功能
  从 Searcher 已物化的 before/after World 计算 Destroy/Plunder 资源选择偏好。

  调用方
  Searcher.evaluateCandidate。

  输入
  canonical Action、行动者与动作前后 World。

  输出
  contextualUtility、staticUtility 与稳定 selection identity；非资源动作返回 null。

  读取状态
  Action.selection、双方公开 World、Probability current counts 与 CardValue primitive。

  写入状态
  无。

  调用函数
  transitionDelta、cardPlayerValueTerms、getResourceDefinitionUtility、
  getResourceUnknownUtility、getUnknownAcquisitionUtility、skillThresholdOptionPolicyValue。

  边界与不变量
  不构造或克隆 World；复用 Searcher 已完成的唯一 transition。contextual 公式保持既有
  state delta、装备材料、掠夺获得材料与充能桩门槛项的单位和顺序。
  */
  resourceSelectionPreference(action, player, beforeState, afterState) {
    const purpose = action?.cardId;
    if (!["destroy", "plunder"].includes(purpose)) return null;
    const selection = action.selection ?? null;
    const actor = beforeState.players.find((entry) => entry.id === player?.id) ?? player;
    const ownerId = action.targetIds?.[0] ?? null;
    const owner = beforeState.players.find((entry) => entry.id === ownerId) ?? null;
    const afterOwner = afterState.players.find((entry) => entry.id === ownerId) ?? null;
    const afterActor = afterState.players.find((entry) => entry.id === actor?.id) ?? null;
    if (!actor || !owner || !afterOwner || !afterActor || !selection) return null;
    let appliedProbability = 0;
    if (selection.zone === "equipment") {
      appliedProbability = clampProbability(
        (owner.equipmentRetentionProbability ?? (owner.equipmentDefinitionId ? 1 : 0))
          - (afterOwner.equipmentRetentionProbability ?? 0)
      );
    } else if (selection.zone === "hand") {
      appliedProbability = clampProbability(
        Math.max(0, Number(owner.handCount) || 0)
          - Math.max(0, Number(afterOwner.handCount) || 0)
      );
    }
    if (appliedProbability <= PROBABILITY_EPSILON) {
      return Object.freeze({
        contextualUtility:Number.NEGATIVE_INFINITY,
        staticUtility:Number.NEGATIVE_INFINITY,
        zone:selection.zone,
        selectionKind:selection.selectionKind,
        cardId:selection.cardId ?? null
      });
    }
    const remainingCardCounts = queryCurrentCardCounts(beforeState.probabilityState);
    const staticUtility = selection.selectionKind === "unknown"
      ? getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts)
      : getResourceDefinitionUtility(purpose, actor, owner, selection.definitionId);
    const acquisitionUtility = purpose !== "plunder"
      ? 0
      : (selection.selectionKind === "unknown"
          ? getUnknownAcquisitionUtility(remainingCardCounts)
          : getBaseCardAiValue(selection.definitionId));
    const thresholdOption = selection.zone === "equipment"
      ? skillThresholdOptionPolicyValue(actor, owner, selection.definitionId)
      : 0;
    const beforePlayers = new Map(beforeState.players.map((entry) => [entry.id, entry]));
    const equipmentMaterialDelta = afterState.players.reduce((sum, afterPlayer) => {
      const beforePlayer = beforePlayers.get(afterPlayer.id);
      if (!beforePlayer) return sum;
      const beforeTerms = cardPlayerValueTerms(beforePlayer, beforePlayer.id);
      const afterTerms = cardPlayerValueTerms(afterPlayer, afterPlayer.id);
      const localDelta = afterTerms.equipmentDelta
        + afterTerms.equipmentRoleDelta
        - beforeTerms.equipmentDelta
        - beforeTerms.equipmentRoleDelta;
      return sum + (afterPlayer.battleTeam === actor.battleTeam ? localDelta : -localDelta);
    }, 0);
    const rawStateDelta = this.transitionDelta(beforeState, afterState, actor.id);
    return Object.freeze({
      contextualUtility:rawStateDelta - equipmentMaterialDelta
        + acquisitionUtility * RESOURCE_MATERIAL_SCALE * appliedProbability
        + thresholdOption * appliedProbability,
      staticUtility,
      zone:selection.zone,
      selectionKind:selection.selectionKind,
      cardId:selection.cardId ?? null
    });
  }

  /*
  功能
  为搜索模拟提供一次确定的战术反制意愿。

  调用方
  Simulator composition 注入的 decideCounter capability。

  输入
  World、响应者、行动者、卡牌、目标、selection 与 root recursion guard。

  输出
  确定的 respond / do-not-respond 布尔值。

  读取状态
  公开 World、canonical Probability 与 GlobalBenefit value。

  写入状态
  无。

  调用函数
  planningCounterDecision、planningDynamicCounterGain、assessGlobalBenefit。

  边界与不变量
  价值比较必须在 Evaluator 内结束；Simulator 只能消费 boolean，不能把 heuristic 当概率。
  */
  decidePlanningCounter(
    state,
    responder,
    actor,
    card,
    targets,
    selection = null,
    { simulatingRootResolution = false } = {}
  ) {
    return planningCounterDecision(state, responder, actor, card, targets, selection, {
      assessGlobalBenefit,
      simulatingRootResolution,
      dynamicCounterGain:planningDynamicCounterGain
    });
  }

  /*
  功能
  用唯一借势公式决定第一目标是否愿意把现有装备换成一次突袭。

  调用方
  Simulator composition 注入的 decideLeverageAssault capability。

  输入
  World、第一目标、第二目标与可选 runtime 精确事实。

  输出
  确定的愿意/拒绝布尔值。

  读取状态
  planning 从 Probability 读取突袭容量/格挡概率；runtime 可注入已解析的精确或估算事实。

  写入状态
  无。

  调用函数
  getBaseCardAiValue、queryPlayerHandProbability。

  边界与不变量
  planning/runtime 只能改变事实精度；价值项、系数和 0.5 阈值只在本方法定义，返回值不是自然概率。
  */
  decideLeverageAssault(state, first, second, facts = null) {
    const assaultExpected = facts?.assaultExpected ?? queryPlayerHandProbability(
      state.probabilityState,
      first,
      "assault"
    ).expected;
    const blockProbability = facts?.blockProbability ?? queryPlayerHandProbability(
      state.probabilityState,
      second,
      "block"
    ).probability;
    const equipmentDefinitionId = facts?.equipmentDefinitionId
      ?? first.equipmentDefinitionId;
    const equipmentValue = getBaseCardAiValue(equipmentDefinitionId);
    const friendlyFirePenalty = second.battleTeam === first.battleTeam ? 0.55 : 0;
    const defenseRisk = Math.min(0.9, clampProbability(blockProbability));
    const targetValue = second.battleTeam === first.battleTeam
      ? -0.35 - (second.hp <= 2 ? 0.15 : 0)
      : 0.3 + (second.hp <= 2 ? 0.15 : 0);
    const conserveAssaultPenalty = Math.max(0, Number(assaultExpected) || 0) <= 0.75
      ? 0.18
      : 0;
    const willingness = 0.42 + equipmentValue * 0.04 + targetValue
      - friendlyFirePenalty - defenseRisk * 0.2 - conserveAssaultPenalty;
    return willingness >= 0.5;
  }

  /*
  功能
  用与真实响应相同的格挡意愿合同评估规划世界。

  调用方
  Response.consumeBlockResponseWorlds。

  输入
  当前 World、目标、单条攻击/容量联合分支与显式 availableBlocks/requiredBlocks。

  输出
  与 runtime Block willingness 相同的确定布尔值。

  读取状态
  当前联合分支的伤害、格挡容量与队伍公开事实。

  写入状态
  无。

  调用函数
  blockWillingness。

  边界与不变量
  planning 只消费调用方当前分支的真实容量，不得从整个 distribution 取最大/平均值；
  threshold 只能由 blockWillingness 定义。
  */
  decidePlanningBlock(state, target, attackWorlds, options = {}) {
    const availableBlocks = Math.max(0, Number(options.availableBlocks) || 0);
    const requirements = (attackWorlds ?? [])
      .filter((branch) => branch.occurs && Number(branch.requiredCount) > 0)
      .map((branch) => Number(branch.requiredCount));
    const requiredBlocks = Math.max(
      1,
      Number(options.requiredBlocks)
        || (requirements.length ? Math.min(...requirements) : 1)
    );
    const incomingDamage = Math.max(
      0,
      Number(options.incomingDamage) || 0,
      ...(attackWorlds ?? []).map((branch) => Number(branch.damageAmount) || 0)
    );
    const isSmallTeam = state.players.filter((player) => (
      player.alive && player.battleTeam === target.battleTeam
    )).length <= 2;
    return blockWillingness({
      responder:target,
      target,
      incomingDamage,
      availableBlocks,
      requiredBlocks,
      isSmallTeam
    });
  }

  /*
  功能
  用与真实响应相同的 STAY/AID 合同评估规划护援。

  调用方
  Response.simulateGuardianAid。

  输入
  当前 World、守护者、被保护目标与伤害上下文。

  输出
  由同一 guardianAidWillingness primitive 导出的确定布尔值。

  读取状态
  无；资格、额度和资源容量由 Simulator/Probability 判断。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  planning 允许使用有界 mitigation/payment 近似，但资格、额度和严格阈值只由共享 primitive 定义。
  */
  decidePlanningGuardianAid(state, guardian, target, context = {}) {
    const amount = Math.max(0, Number(context.incomingDamage) || 0);
    const triggerProbability = clampProbability(context.triggerProbability ?? 1);
    const conditionalReduction = Math.max(
      0,
      Number(context.conditionalReduction) || 0
    );
    const mitigationValue = conditionalReduction * triggerProbability * HP_VALUE;
    const paymentValue = triggerProbability * 1.1;
    const { futureInventory } = exposureComponents(state, target);
    return guardianAidWillingness({
      responder:guardian,
      target,
      amount,
      stayValue:0,
      aidValue:mitigationValue - paymentValue,
      futureInventory
    });
  }

  /*
  功能
  用与真实响应相同的救援 assessment 合同评估规划救援。

  调用方
  Damage.resolveFatal。

  输入
  当前 World、救援者、濒死目标与当前轮次容量上下文。

  输出
  由同一 dyingRescueWillingness primitive 导出的确定布尔值。

  读取状态
  无；Recover capacity 与救援顺序分别由 Probability 和 Domain Rules 判断。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  planning 使用 canonical Probability 的有界 team capacity，不得复制敌友、自救、强制真人救援或必败规则。
  */
  decidePlanningDyingRescue(state, rescuer, target, context = {}) {
    const availableRecover = Math.max(0, Number(context.available) || 0);
    const need = Math.max(1, Number(context.need) || 1);
    const team = state.players.filter((player) => (
      player.alive && player.battleTeam === target.battleTeam
    ));
    const teamRecover = team.reduce((sum, player) => sum + queryPlayerHandProbability(
      state.probabilityState,
      player,
      "recover"
    ).expected, 0);
    const guaranteedImpossible = teamRecover * getRecoverHealAmount() < need;
    const rescueSuccessProbability = Math.min(1, teamRecover * getRecoverHealAmount() / need);
    const { expectedRescueValue } = dyingRescueValueTerms({
      responder:rescuer,
      target,
      aliveTeamCount:team.length,
      availableRecover,
      rescueSuccessProbability
    });
    return dyingRescueWillingness({
      responder:rescuer,
      target,
      availableRecover,
      guaranteedImpossible,
      expectedRescueValue,
      forceAiRescueHuman:this.forceAiRescueHuman
    });
  }

  /*
  功能
  计算借势 runtime 响应可知的格挡风险事实。

  调用方
  Controller.buildResponseDecisionContext 的 leverageMetrics 预计算。

  输入
  目标公开视图与 current remaining counts。

  输出
  `{blockRisk}` 纯数值。

  读取状态
  公开目标 handCount 与 Probability current counts。

  写入状态
  无。

  调用函数
  probabilityFromCurrentCounts。

  边界与不变量
  Controller 只提供 runtime-bound fact；本方法不拥有借势价值项、系数或阈值。
  */
  leverageResponseMetrics(target, remainingCardCounts) {
    const blockRisk = Math.min(
      0.85,
      target.handCount * probabilityFromCurrentCounts(remainingCardCounts, "block")
    );
    return { blockRisk };
  }

  /*
  功能
  把 canonical Seal probability 与回合机会价值组合为状态反制纯价值项。

  调用方
  Controller.buildResponseDecisionContext 的 sealCounterTerms 预计算。

  输入
  已绑定的 holder World player、完整 World 与 current remaining counts。

  输出
  `{valid:true, preventedBurden}`。

  读取状态
  canonical Probability 判定池与公开回合机会事实。

  写入状态
  无。

  调用函数
  tacticJudgmentProbability、turnOpportunityValue。

  边界与不变量
  状态/阵营合法性由 Controller 先判断；此处只拥有 Value 组合且不修改状态。
  */
  sealCounterTerms(holder, world, remainingCardCounts) {
    const skipProbability = 1 - tacticJudgmentProbability(remainingCardCounts);
    return {
      valid:true,
      preventedBurden:skipProbability * turnOpportunityValue(holder, world)
    };
  }

  /*
  功能
  评估一次己方濒死救援的资源与后续救援价值。

  调用方
  shouldRespond、Controller.assessDyingRescue 与直接价值测试。

  输入
  已过滤 responder/target、救援顺序、自己手牌定义、合法记忆和剩余牌计数。

  输出
  冻结字段的救援容量、成功概率与期望价值 assessment object。

  读取状态
  plain DecisionContext 的公开/合法信息与 canonical Probability math。

  写入状态
  无。

  调用函数
  hypergeometricProbabilityAtLeast、getBaseCardAiValue、getRecoverHealAmount。

  边界与不变量
  未知手牌只按公开 handCount、合法记忆与 Remaining Knowledge 无放回估算；确定必败保持硬拒绝。
  */
  assessDyingRescue({
    responder,
    target,
    rescueOrder,
    responderHandDefinitionIds,
    knownCardsByPlayer,
    recoverDensity = null,
    remainingCardCounts
  }) {
    const need = Math.max(1, 1 - target.hp);
    const recoverHealAmount = getRecoverHealAmount();
    const ownRecover = responderHandDefinitionIds
      .filter((definitionId) => definitionId === "recover").length;
    const knownRecoverCapacity = rescueOrder.reduce((sum, player) => {
      if (player.id === responder.id) return sum + ownRecover;
      const known = knownCardsByPlayer[player.id] ?? {};
      return sum + Object.values(known)
        .filter((definitionId) => definitionId === "recover").length;
    }, 0);
    const unknownRecoverSlots = rescueOrder.reduce((sum, player) => {
      if (player.id === responder.id) return sum;
      const known = knownCardsByPlayer[player.id] ?? {};
      return sum + Math.max(0, player.handCount - Object.keys(known).length);
    }, 0);
    const remainingRecoverCount = Number(remainingCardCounts?.recover);
    const unknownRecoverCapacity = Number.isFinite(remainingRecoverCount)
      ? Math.min(unknownRecoverSlots, Math.max(0, remainingRecoverCount))
      : unknownRecoverSlots;
    const knownFeasibleRecovery = knownRecoverCapacity * recoverHealAmount;
    const maximumFeasibleRecovery = (
      knownRecoverCapacity + unknownRecoverCapacity
    ) * recoverHealAmount;
    const guaranteedImpossible = maximumFeasibleRecovery < need;
    const guaranteedSurvivable = knownFeasibleRecovery >= need;
    const requiredRecoverCount = Math.ceil(need / recoverHealAmount);
    const unknownRecoveryRequired = Math.max(0, requiredRecoverCount - knownRecoverCapacity);
    const remainingPopulation = Object.values(remainingCardCounts ?? {}).reduce(
      (sum, count) => sum + (Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0),
      0
    );
    const rescueSuccessProbability = guaranteedImpossible || remainingPopulation <= 0
      ? 0
      : hypergeometricProbabilityAtLeast(
          remainingPopulation,
          Math.max(0, remainingRecoverCount),
          unknownRecoverSlots,
          unknownRecoveryRequired
        );
    const expectedUnknownRecover = remainingPopulation > 0
      ? unknownRecoverSlots * Math.max(0, remainingRecoverCount) / remainingPopulation
      : 0;
    const futureExpectedRecover = Math.max(0, knownRecoverCapacity - 1)
      + expectedUnknownRecover;
    const remainingAfterThisCard = Math.max(0, need - recoverHealAmount);
    const aliveTeam = rescueOrder.filter(
      (player) => player.alive && player.battleTeam === target.battleTeam
    );
    const valueTerms = dyingRescueValueTerms({
      responder,
      target,
      aliveTeamCount:aliveTeam.length,
      availableRecover:ownRecover,
      rescueSuccessProbability
    });
    const resolvedRecoverDensity = recoverDensity
      ?? probabilityFromCurrentCounts(remainingCardCounts, "recover");
    return {
      need,
      ownRecover,
      recoverDensity:resolvedRecoverDensity,
      futureExpectedRecover,
      knownFeasibleRecovery,
      maximumFeasibleRecovery,
      unknownRecoverCapacity,
      unknownRecoveryRequired,
      guaranteedImpossible,
      guaranteedSurvivable,
      rescueSuccessProbability,
      remainingAfterThisCard,
      ...valueTerms,
      score:valueTerms.expectedRescueValue
    };
  }

  /*
  功能
  从公开突袭上下文读取当前确定的角色加伤预览。

  调用方
  shouldRespond 的 block 分支与 Controller 专项入口。

  输入
  已过滤 source 和公开 card。

  输出
  非负已知加伤。

  读取状态
  source passive IDs、momentum 与 allIn assaultBonus。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不触发 beforeDamage 或任何真实监听器。
  */
  knownPendingAssaultBonus(context) {
    const source = context.source;
    if (!source?.alive || context.card?.definitionId !== "assault") return 0;
    let bonus = 0;
    if ((source.passiveSkillIds ?? []).includes("momentum")) {
      bonus += Math.max(0, Number(source.momentum) || 0);
    }
    if ((source.passiveSkillIds ?? []).includes("gamble")) {
      bonus += Math.max(0, Number(source.assaultBonus) || 0);
    }
    return bonus;
  }

  /*
  功能
  判断一次合法响应窗口是否值得使用给定响应资源。

  调用方
  Controller runtime response boundary 与直接价值测试。

  输入
  plain DecisionContext，含 responseType、canonical World/player、合法响应数量与预物化 value inputs。

  输出
  是否响应的确定布尔值。

  读取状态
  只读 DecisionContext 中的普通数据、标量与预物化 Worlds。

  写入状态
  无；查询只操作独立 World clone。

  调用函数
  assessDyingRescue、knownPendingAssaultBonus、状态/guardian/dynamic query。

  边界与不变量
  Evaluator 不投影真实状态、不执行 transition；确定必败硬拒绝与既有阈值保持不变。
  */
  shouldRespond(decision) {
    const {
      responder,
      responseType:type,
      context,
      availableResponseCount = 0,
      players,
      rescueOrder,
      responderHandDefinitionIds,
      knownCardsByPlayer,
      recoverDensity,
      remainingCardCounts,
      isSmallTeam,
      forceAiRescueHuman,
      leverageMetrics,
      world,
      guardianAidWorlds,
      lightningCounterWorlds,
      sealCounterTerms,
      rootFlipWorlds,
      counterSelection = null
    } = decision;
    const target = context.target ?? responder;
    if (type === "dyingRescue") {
      if (target.battleTeam !== responder.battleTeam) return false;
      const assessment = this.assessDyingRescue({
        responder,
        target,
        rescueOrder,
        responderHandDefinitionIds,
        knownCardsByPlayer,
        recoverDensity,
        remainingCardCounts
      });
      return dyingRescueWillingness({
        responder,
        target,
        availableRecover:assessment.ownRecover,
        guaranteedImpossible:assessment.guaranteedImpossible,
        expectedRescueValue:assessment.expectedRescueValue,
        forceAiRescueHuman
      });
    }
    if (type === "block") {
      const incoming = Math.max(0, Number(context.amount ?? 1) || 0)
        + this.knownPendingAssaultBonus(context);
      const availableBlocks = availableResponseCount;
      const requiredBlocks = Math.max(1, context.requiredCount ?? 1);
      return blockWillingness({
        responder,
        target,
        incomingDamage:incoming,
        availableBlocks,
        requiredBlocks,
        isSmallTeam
      });
    }
    if (type === "counter") {
      if (context.statusCounterContext) {
        return context.statusCounterContext.statusId === "sealed"
          ? this.shouldCounterSeal(sealCounterTerms ?? { valid:false, preventedBurden:0 })
          : this.shouldCounterLightning(lightningCounterWorlds
              ? this.lightningCounterTerms(
                  world,
                  lightningCounterWorlds.stayOutcomeSet,
                  lightningCounterWorlds.transferredWorld,
                  lightningCounterWorlds.transferredOutcomeSet,
                  responder.id
                )
              : { valid:false, noCounterBurden:0, withCounterBurden:0 });
      }
      const rootId = context.rootCard?.definitionId ?? context.card?.definitionId;
      const rootSourceId = context.rootSourceId
        ?? context.rootSource?.id
        ?? context.source?.id
        ?? null;
      const globalDecision = globalBenefitCounterDecision(
        assessGlobalBenefit,
        players,
        responder.battleTeam,
        rootId,
        {
          rootSourceId,
          counterDepth:context.counterDepth ?? 0,
          remainingCardCounts
        }
      );
      if (globalDecision !== null) return globalDecision;
      const gain = rootFlipWorlds
        ? this.dynamicRootFlipGain(
            rootFlipWorlds,
            responder.id,
            rootFlipWorlds.baseLightningOutcomeSets,
            rootFlipWorlds.resolvedLightningOutcomeSets
          )
        : planningDynamicCounterGain(
            world,
            responder,
            context.rootSource ?? context.source,
            { definitionId:rootId },
            (context.rootTargetIds ?? []).map((targetId) => (
              world.players.find((player) => player.id === targetId)
            )).filter(Boolean),
            counterSelection
          );
      return dynamicCounterWillingness(gain);
    }
    if (type === "assaultDiscard") {
      if (context.card?.definitionId === "provoke") {
        return responder.hp <= 2 || responder.handCount > 2;
      }
      if (context.card?.definitionId === "duel") return true;
      const assaultCount = responderHandDefinitionIds
        .filter((definitionId) => definitionId === "assault").length;
      return responder.hp <= 2 || assaultCount > 1;
    }
    if (type === "leverageAssault") {
      if (!availableResponseCount || !target?.alive || !leverageMetrics) return false;
      return this.decideLeverageAssault(world, responder, target, {
        assaultExpected:availableResponseCount,
        blockProbability:leverageMetrics.blockRisk,
        equipmentDefinitionId:context.equipment?.definitionId
          ?? responder.equipmentDefinitionId
      });
    }
    if (type === "skill") return this.shouldUseGuardianAid(decision);
    return false;
  }

  /*
  功能
  比较护援 STAY/AID 配对世界和唯一额度的未来机会成本。

  调用方
  shouldRespond 的 skill 分支。

  输入
  公开合法上下文和 Simulator 已预物化的 Guardian paired Worlds。

  输出
  AID 严格更优时为 true。

  读取状态
  公开响应者/目标字段与纯数值 query result。

  写入状态
  无。

  调用函数
  guardianAidValues。

  边界与不变量
  硬守卫与真实技能一致；严格比较和 HP_VALUE 尺度不变。
  */
  shouldUseGuardianAid(decision) {
    const { responder, context, world, guardianAidWorlds } = decision;
    const target = context.target;
    const amount = Math.max(0, Number(context.amount) || 0);
    if (!guardianAidWorlds) return false;
    const { stayValue, aidValue, futureInventory } = this.guardianAidValues(
      world,
      responder.id,
      target.id,
      guardianAidWorlds.stayWorld,
      guardianAidWorlds.aidWorld,
      guardianAidWorlds.stayLightningOutcomeSets,
      guardianAidWorlds.aidLightningOutcomeSets
    );
    return guardianAidWillingness({
      responder,
      target,
      amount,
      stayValue,
      aidValue,
      futureInventory
    });
  }

  /*
  功能
  根据 Lightning Domain 与 Value query 的纯结果判断是否反制状态。

  调用方
  shouldRespond 的 lightning status counter 分支。

  输入
  `{valid, noCounterBurden, withCounterBurden}`。

  输出
  转移后负担加成本严格低于不反制负担时为 true。

  读取状态
  只读纯数值 Domain/Value 结果。

  写入状态
  无。

  调用函数
  counterOpportunityCost。

  边界与不变量
  不建传播分布、不修改 holder，反制成本只计一次。
  */
  shouldCounterLightning({ valid, noCounterBurden, withCounterBurden }) {
    if (!valid) return false;
    return withCounterBurden + counterOpportunityCost() < noCounterBurden;
  }

  /*
  功能
  根据 Seal Domain/Value 纯结果判断是否反制状态。

  调用方
  shouldRespond 的 sealed status counter 分支。

  输入
  `{valid, preventedBurden}`。

  输出
  己方有效封印负担严格超过反制成本时为 true。

  读取状态
  只读纯数值 Domain/Value 结果。

  写入状态
  无。

  调用函数
  counterOpportunityCost。

  边界与不变量
  不计算判定池或状态生命周期；这些由调用方纯查询提供。
  */
  shouldCounterSeal({ valid, preventedBurden }) {
    return valid && preventedBurden > counterOpportunityCost();
  }

  /*
  功能
  把公开目标威胁转换为唯一的目标 preference primitive。

  调用方
  搜索先验 exploration 与 Controller leverage decision context。

  输入
  viewer、target、合法记忆与预计伤害。

  输出
  非负难度缩放 preference；非敌方或零倍率返回零。

  读取状态
  注入的难度倍率与公开目标事实。

  写入状态
  无。

  调用函数
  threatScore。

  边界与不变量
  这是唯一 target preference 语义；Searcher/Controller/Policy 不得复制公式，且本值不直接进入 Final Utility。
  */
  threatPriority(viewer, target, memory, expectedDamage = 1) {
    const multiplier = Math.max(
      0,
      Number(this.getDifficultyMultiplier?.() ?? 1) || 0
    );
    if (!multiplier || !target || target.battleTeam === viewer.battleTeam) return 0;
    return threatScore(viewer, target, memory, expectedDamage) * 0.12 * multiplier;
  }

  /*
  功能
  聚合单个玩家互斥的 StateValue 与 CardValue 分项。

  调用方
  stateUtility、diagnostic terms 与闪电生命周期查询。

  输入
  canonical World、玩家、viewer ID 与雷达战术判定概率。

  输出
  death 与完整但不重复的 terms 分解。

  读取状态
  StateValue 的非卡牌状态 primitive 与 CardValue 的卡牌/装备资产 primitive。

  写入状态
  无。

  调用函数
  statePlayerValueTerms、cardPlayerValueTerms。

  边界与不变量
  Final aggregation 只在 Evaluator；hand/equipment intrinsic 不得进入 StateValue，非卡牌后果不得进入 CardValue。
  */
  playerValueTerms(state, player, viewerId, radarTacticProbability) {
    const stateTerms = statePlayerValueTerms(
      state,
      player,
      viewerId,
      radarTacticProbability,
      this.energyRules
    );
    if (stateTerms.death) return stateTerms;
    return {
      death:0,
      terms:{
        ...stateTerms.terms,
        ...cardPlayerValueTerms(player, viewerId)
      }
    };
  }

  /*
  功能
  汇总单个 owner 在不含延迟状态负担时的经济总值。

  调用方
  闪电生命周期 simulation query。

  输入
  状态、owner、viewer ID 与雷达概率。

  输出
  未施加团队符号的 owner material value。

  读取状态
  与 playerValueTerms 相同。

  写入状态
  无。

  调用函数
  playerValueTerms。

  边界与不变量
  不包含封印与闪电自身 burden，避免生命周期查询递归调用 stateUtility。
  */
  ownerMaterialValue(state, player, viewerId, radarTacticProbability) {
    const { death, terms } = this.playerValueTerms(
      state,
      player,
      viewerId,
      radarTacticProbability
    );
    return death + Object.values(terms).reduce((sum, value) => sum + value, 0);
  }

  /*
  功能
  计算同一 owner 在两个 World 中的材料状态价值差。

  调用方
  Simulator/Evaluator composition 的闪电生命周期分支。

  输入
  before/after World、owner ID、viewer ID 与两侧雷达战术概率。

  输出
  after owner material points 减 before owner material points。

  读取状态
  两个 World 中同一 owner 的公开材料与威胁状态。

  写入状态
  无。

  调用函数
  ownerMaterialValue。

  边界与不变量
  只比较同一 owner；团队符号与闪电概率权重由调用方各施加一次。
  */
  ownerMaterialDelta(
    before,
    after,
    ownerId,
    viewerId,
    beforeRadarTacticProbability,
    afterRadarTacticProbability
  ) {
    const beforeOwner = before.players.find((player) => player.id === ownerId);
    const afterOwner = after.players.find((player) => player.id === ownerId);
    if (!beforeOwner || !afterOwner) return 0;
    return this.ownerMaterialValue(
      after,
      afterOwner,
      viewerId,
      afterRadarTacticProbability
    ) - this.ownerMaterialValue(
      before,
      beforeOwner,
      viewerId,
      beforeRadarTacticProbability
    );
  }

  /*
  功能
  在一次 StateValue 聚合中同时产出完整状态点、队伍安全点与有界队伍危险。

  调用方
  stateUtility、evaluateTransition。

  输入
  canonical World、viewer ID，以及调用层已准备的闪电与可选封印纯数值。

  输出
  包含 statePoints、teamSafetyPoints 与零到一 teamDanger 的新对象。

  读取状态
  只读 World、StateValue/CardValue 分项与显式领域值。

  写入状态
  无。

  调用函数
  playerValueTerms、sealTeamBurden、lightningLifecycleValue、statePointsToUtility、clampProbability。

  边界与不变量
  Safety 只投影现有生命、防护、救援和威胁分项；不含能量、手牌、装备资产或普通经济项。
  Danger 取队伍成员最大负向安全压力，并只用既有 HP-equivalent 尺度归一化。
  */
  stateValueSnapshot(state, viewerId, lightningOutcomeSets = [], sealValues = null) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) {
      return { statePoints:Number.NEGATIVE_INFINITY, teamSafetyPoints:0, teamDanger:1 };
    }
    const radarTacticProbability = buildRadarJudgmentProbabilities(
      queryCurrentCardCounts(state.probabilityState)
    ).tactic;
    let statePoints = 0;
    let teamSafetyPoints = 0;
    let teamDanger = 0;
    for (let playerIndex = 0; playerIndex < state.players.length; playerIndex += 1) {
      const player = state.players[playerIndex];
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      const { death, terms } = this.playerValueTerms(
        state,
        player,
        viewerId,
        radarTacticProbability
      );
      statePoints += sign * (death + Object.values(terms).reduce(
        (sum, value) => sum + value,
        0
      )) - (Array.isArray(sealValues)
        ? Number(sealValues[playerIndex]) || 0
        : sealTeamBurden(state, player, viewer.battleTeam));
      if (sign < 0) continue;
      teamSafetyPoints += death + TEAM_SAFETY_TERM_KEYS.reduce(
        (sum, key) => sum + (Number(terms[key]) || 0),
        0
      );
      const dangerPoints = Math.max(0, -(death + TEAM_DANGER_TERM_KEYS.reduce(
        (sum, key) => sum + (Number(terms[key]) || 0),
        0
      )));
      teamDanger = Math.max(
        teamDanger,
        clampProbability(statePointsToUtility(dangerPoints))
      );
    }
    for (const outcomeSet of lightningOutcomeSets) {
      statePoints += this.lightningLifecycleValue(state, outcomeSet, viewerId);
    }
    return { statePoints, teamSafetyPoints, teamDanger };
  }

  /*
  功能
把状态与调用层已计算的闪电、封印值转换为唯一团队 State Value。

  调用方
  Evaluator transition/frontier/diagnostic 方法与纯边界测试。

  输入
过滤后的状态、viewer ID，以及按 holder 顺序排列的闪电与可选封印纯数值。

  输出
  viewer 团队视角的原始 State Value points；找不到 viewer 时返回负无穷。

  读取状态
  只读公开资源、合法概率摘要和传入的领域值。

  写入状态
  无。

  调用函数
  stateValueSnapshot。

  边界与不变量
闪电与搜索期封印值由调用层以 State points 传入；无封印数组的独立调用保持 raw Domain 默认；
本函数始终保留原始 State Value points，
  只有进入 Final Utility 的边界才执行 HP-equivalent 换算。
  */
  stateUtility(state, viewerId, lightningOutcomeSets = [], sealValues = null) {
    return this.stateValueSnapshot(
      state,
      viewerId,
      lightningOutcomeSets,
      sealValues
    ).statePoints;
  }

  /*
  功能
  计算两个 canonical World 在同一观察者视角下的唯一状态价值差。

  调用方
  Searcher、Controller 的配对 transition 编排与 Evaluator 内部纯比较。

  输入
  before/after World、viewer ID，以及 Simulator 为两侧准备的闪电 outcome 集合。

  输出
  after State Value points 减 before State Value points。

  读取状态
  两个 World 与其已完成的闪电 outcome World。

  写入状态
  无。

  调用函数
  stateUtility。

  边界与不变量
  运算顺序固定为 after-before；Evaluator 只比较已准备的 World，不构造 transition。
  */
  transitionDelta(
    before,
    after,
    viewerId,
    beforeLightningOutcomeSets = [],
    afterLightningOutcomeSets = []
  ) {
    return this.stateUtility(after, viewerId, afterLightningOutcomeSets)
      - this.stateUtility(before, viewerId, beforeLightningOutcomeSets);
  }

  /*
  功能
  计算 canonical Action 的 state delta、transition option 与基础 Final Utility。

  调用方
  Searcher candidate evaluation path。

  输入
  动作、actor、before/after、horizon depth、上游已计算的 resolution scale
  与 Searcher 物化的 generic transition-option points。

  输出
  各命名 term 与 baseTransition 的普通对象。

  读取状态
  只读 before/after World 与 Evaluator state aggregation。

  写入状态
  无。

  调用函数
  deriveTransitionOptionPoints、StateValue.transitionDelta、statePointsToUtility。

  边界与不变量
  BaseTransition 只由 StateDeltaValue 与 TransitionOptionValue 构成；低于冻结门槛的 Transfer 只失去竞争资格；
  depth 只作诊断，不缩放价值，search-prior terms 不得进入；手牌溢出只作为后续同层真实状态比较输入，
  不在本函数产生固定 END 或卡牌分数。
  */
  evaluateTransition({
    action,
    player,
    beforeState,
    afterState,
    depth = 1,
    resolutionScale = 1,
    materializedTransitionOptionPoints = 0,
    beforeLightningOutcomeSets = [],
    afterLightningOutcomeSets = []
  }) {
    const effectResolutionScale = ["scout", "mutualBenefit"].includes(action.cardId)
      ? resolutionScale
      : 1;
    const beforeSnapshot = this.stateValueSnapshot(
      beforeState,
      player.id,
      beforeLightningOutcomeSets
    );
    const afterSnapshot = this.stateValueSnapshot(
      afterState,
      player.id,
      afterLightningOutcomeSets
    );
    const stateDelta = afterSnapshot.statePoints - beforeSnapshot.statePoints;
    const stateDeltaValue = statePointsToUtility(stateDelta);
    const transitionOptionPoints = deriveTransitionOptionPoints(
      action,
      player,
      beforeState,
      afterState,
      effectResolutionScale
    ) + materializedTransitionOptionPoints;
    const transitionOptionValue = statePointsToUtility(transitionOptionPoints);
    const transferEvaluation = action?.type === "card" && action?.cardId === "transfer"
      ? this.evaluateTransferAction(action, player, beforeState)
      : null;
    const transferCompetitive = transferEvaluation === null
      || transferEvaluation.score >= MIN_TRANSFER_UTILITY;
    const beforeActor = beforeState.players.find(
      (entry) => entry.id === player.id
    ) ?? player;
    const afterActor = afterState.players.find(
      (entry) => entry.id === player.id
    ) ?? beforeActor;
    const discardOpportunityInputs = {
      beforeOverflow:Math.max(
        0,
        (Number(beforeActor.handCount) || 0) - Math.max(0, Number(beforeActor.hp) || 0)
      ),
      afterOverflow:Math.max(
        0,
        (Number(afterActor.handCount) || 0) - Math.max(0, Number(afterActor.hp) || 0)
      ),
      stateDelta
    };
    let endOpportunityInputs = null;
    if (action?.type === "end") {
      const maxEnergy = Math.max(
        0,
        Number(this.energyRules.getMaxEnergy?.(beforeActor)) || 0
      );
      const energyBreakdown = this.energyRules.getTurnEnergyBreakdown?.(beforeActor) ?? {};
      endOpportunityInputs = {
        energy:Math.max(0, Number(beforeActor.energy) || 0),
        turnEnergyGain:Math.max(
          0,
          (Number(energyBreakdown.baseAmount) || 0)
            + (Number(energyBreakdown.teamBonus) || 0)
            + (Number(energyBreakdown.equipmentBonus) || 0)
        ),
        maxEnergy,
        activeSkillCost:Math.max(0, Number(beforeActor.activeSkillCost) || 0),
        hasActiveSkill:Boolean(beforeActor.activeSkillId)
      };
    }
    return {
      resolutionScale:effectResolutionScale,
      stateDelta,
      stateDeltaValue,
      transitionOptionPoints,
      transitionOptionValue,
      depth,
      safetyBeforePoints:beforeSnapshot.teamSafetyPoints,
      safetyAfterPoints:afterSnapshot.teamSafetyPoints,
      dangerBefore:beforeSnapshot.teamDanger,
      discardOpportunityInputs,
      endOpportunityInputs,
      baseTransition:transferCompetitive
        ? stateDeltaValue + transitionOptionValue
        : Number.NEGATIVE_INFINITY
    };
  }

  /*
  功能
  从同一次 transition evaluation 的 safety-only 投影计算技能当步安全改善。

  调用方
  endOpportunityPoints。

  输入
  Evaluator.evaluateTransition 返回的完整命名 terms。

  输出
  非负 State Value points。

  读取状态
  transition terms 中的 before/after safety points。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不读取完整 state delta；能量、手牌、装备、普通经济与 continuation 收益不会进入。
  */
  skillSafetyRelief(transitionTerms) {
    return Math.max(
      0,
      (Number(transitionTerms?.safetyAfterPoints) || 0)
        - (Number(transitionTerms?.safetyBeforePoints) || 0)
    );
  }

  /*
  功能
  计算某个同层动作相对直接 END 所兑现的强制弃牌状态机会。

  调用方
  endOpportunityPoints。

  输入
  END 与一个非 END sibling 的完整 transition terms。

  输出
  非负 StateValue points relief。

  读取状态
  两个候选的动作前后手牌溢出量与 Raw StateDelta。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只有 END 确实触发弃牌且 sibling 通过真实 HP/手牌变化完全消除同一溢出时才产生机会；
  数值严格取两个已物化状态差的正向差，不读取牌名、CardValue 或固定奖励。
  */
  endDiscardOpportunityRelief(endTerms, siblingTerms) {
    const end = endTerms?.discardOpportunityInputs;
    const sibling = siblingTerms?.discardOpportunityInputs;
    if (!end || !sibling || end.beforeOverflow <= 0 || end.afterOverflow !== 0) return 0;
    if (sibling.beforeOverflow !== end.beforeOverflow || sibling.afterOverflow > 0) return 0;
    return Math.max(0, sibling.stateDelta - end.stateDelta);
  }

  /*
  功能
  从同 parent 的完整 sibling transition terms 聚合 END 的全部机会惩罚点数。

  调用方
  Searcher.finalizeCandidates 在 skill sibling 完整后请求 END Final Utility。

  输入
  END transition terms，以及带 actionType 与 transitionTerms 的完整 sibling terms 数组。

  输出
  Pf、Ps 与 Pd 相加后的非负 StateValue penalty points。

  读取状态
  sibling 的 safety、强制弃牌状态差，以及 END 的能量和危险输入。

  写入状态
  无。

  调用函数
  skillSafetyRelief、endDiscardOpportunityRelief、endEnergyOpportunityPenalty。

  边界与不变量
  Searcher 只提供完整集合；M* 与 Pd 的最大值及 Pf + Ps + Pd 仅在 Evaluator 聚合；
  sibling 顺序不得改变结果，单项公式、单位换算和零 sibling 行为保持不变。
  */
  endOpportunityPoints(endTransitionTerms, siblingTransitionTerms = []) {
    const maximumSkillSafetyRelief = siblingTransitionTerms
      .filter((sibling) => sibling?.actionType === "skill")
      .reduce((maximum, sibling) => Math.max(
        maximum,
        this.skillSafetyRelief(sibling.transitionTerms)
      ), 0);
    const maximumDiscardOpportunityRelief = siblingTransitionTerms
      .filter((sibling) => sibling?.actionType !== "end")
      .reduce((maximum, sibling) => Math.max(
        maximum,
        this.endDiscardOpportunityRelief(
          endTransitionTerms,
          sibling.transitionTerms
        )
      ), 0);
    return this.endEnergyOpportunityPenalty(
      endTransitionTerms,
      maximumSkillSafetyRelief,
      maximumDiscardOpportunityRelief
    );
  }

  /*
  功能
  计算 END 的能量溢出、已完整技能 sibling 安全机会与强制弃牌状态机会惩罚。

  调用方
  endOpportunityPoints。

  输入
  END transition terms，以及同一 Evaluator 聚合出的最大 skill safety relief 与 discard opportunity relief。

  输出
  三类互斥来源相加后的非负 StateValue penalty points。

  读取状态
  Evaluator 已物化的能量规则输入、队伍危险、safety relief 与 discard relief scalars。

  写入状态
  无。

  调用函数
  clampProbability。

  边界与不变量
  λ 唯一由 Evaluator 的 END_SKILL_SAFETY_WEIGHT 拥有；maxEnergy<=0、无主动技能或当前能量不足费用时 readiness 为零；
  discard relief 已由 endDiscardOpportunityRelief 从真实状态差得出，不再缩放或读取 CardValue；
  无合法 sibling 由最大 relief 为零自然表达；调用方不得在 Evaluator 外部重复聚合。
  */
  endEnergyOpportunityPenalty(
    transitionTerms,
    maximumSkillSafetyRelief = 0,
    maximumDiscardOpportunityRelief = 0
  ) {
    const inputs = transitionTerms?.endOpportunityInputs;
    const discardOpportunityPoints = Math.max(
      0,
      Number(maximumDiscardOpportunityRelief) || 0
    );
    if (!inputs || inputs.maxEnergy <= 0) return discardOpportunityPoints;
    const overflowPoints = ENERGY_STATE_WEIGHT * Math.max(
      0,
      inputs.energy + inputs.turnEnergyGain - inputs.maxEnergy
    );
    let readiness = 0;
    if (inputs.hasActiveSkill && inputs.energy >= inputs.activeSkillCost) {
      const denominator = inputs.maxEnergy - inputs.activeSkillCost + 1;
      readiness = (
        (inputs.energy - inputs.activeSkillCost + 1) / denominator
      ) ** 2;
    }
    const lostSkillPoints = END_SKILL_SAFETY_WEIGHT
      * readiness
      * clampProbability(Number(transitionTerms.dangerBefore) || 0)
      * Math.max(0, Number(maximumSkillSafetyRelief) || 0);
    return overflowPoints + lostSkillPoints + discardOpportunityPoints;
  }

  /*
  功能
  按根 Transfer 冻结偏好、Final Utility 与限定同分规则比较两个完整候选。

  调用方
  Searcher incumbent、beam protection 与 final selection。

  输入
  含 valueScore 或 transitionValue 的两个完整候选。

  输出
  left 更优返回正数，right 更优返回负数，完全等价返回零。

  读取状态
  候选根 Transfer preference、Final Utility 与 canonical root Action/selection。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  两个根 Transfer 先保持旧 contextual winner；Transfer 与其它动作仍比较 Final Utility；
  Final Utility 已在 tolerance 内同分且目标相同时，Scout 只按实际新增揭示数确定顺序，随后才稳定优先 skill-root；
  Searcher、Pattern、search-prior terms 与随机数不得定义另一套偏好。
  */
  compareCandidates(left, right, actor = null, rootWorld = null) {
    if (left?.action?.cardId === "transfer" && right?.action?.cardId === "transfer") {
      const leftPreference = this.evaluateTransferAction(left.action, actor, rootWorld);
      const rightPreference = this.evaluateTransferAction(right.action, actor, rootWorld);
      const transferOrder = compareTransferPreferences(
        leftPreference,
        rightPreference
      );
      if (transferOrder) return transferOrder;
    }
    const sameResourceChoice = ["destroy", "plunder"].includes(left?.action?.cardId)
      && left.action.cardId === right?.action?.cardId
      && left.action.cardInstanceId === right.action.cardInstanceId
      && left.action.targetIds?.[0] === right.action.targetIds?.[0];
    if (sameResourceChoice && left.comparisonTerms && right.comparisonTerms) {
      const contextualDifference = left.comparisonTerms.contextualUtility
        - right.comparisonTerms.contextualUtility;
      if (Math.abs(contextualDifference) > 1e-9) return contextualDifference;
      const staticDifference = left.comparisonTerms.staticUtility
        - right.comparisonTerms.staticUtility;
      if (staticDifference) return staticDifference;
    }
    const leftValue = Number(left?.valueScore ?? left?.transitionValue);
    const rightValue = Number(right?.valueScore ?? right?.transitionValue);
    if (leftValue !== rightValue && (!Number.isFinite(leftValue) || !Number.isFinite(rightValue))) {
      return leftValue > rightValue ? 1 : -1;
    }
    const difference = leftValue - rightValue;
    const tolerance = Number.EPSILON * Math.max(
      1,
      Math.abs(leftValue),
      Math.abs(rightValue)
    );
    if (Math.abs(difference) > tolerance) return difference;
    const sameScoutTarget = left?.action?.cardId === "scout"
      && right?.action?.cardId === "scout"
      && left.action.targetIds?.[0] === right.action.targetIds?.[0];
    if (sameScoutTarget) {
      const revealLimit = CARD_DEFINITIONS.scout.maxRevealCount;
      const leftRevealCount = Math.min(
        revealLimit,
        Math.max(0, left.action.selection?.unknownCount ?? 0)
      );
      const rightRevealCount = Math.min(
        revealLimit,
        Math.max(0, right.action.selection?.unknownCount ?? 0)
      );
      if (leftRevealCount !== rightRevealCount) return leftRevealCount - rightRevealCount;
    }
    if (left?.action?.type === "skill" && right?.action?.type === "card") return 1;
    if (left?.action?.type === "card" && right?.action?.type === "skill") return -1;
    return 0;
  }

  /*
  功能
  把基础转移与 terminal held option 组合为唯一 Final Transition Utility。

  调用方
  Searcher sibling finalization；END opportunity 已由 endOpportunityPoints 完整聚合。

  输入
  HP-equivalent base/frontier value 与 Evaluator 计算的 END opportunity State points。

  输出
  当前候选的 Final Utility。

  读取状态
  无。

  写入状态
  无。

  调用函数
  statePointsToUtility。

  边界与不变量
  responseNet 已包含在 state delta 中而不再相加；END opportunity points 只在此执行一次单位换算；
  search-prior terms 与 Pattern 不进入公式。
  */
  composeTransitionValue({
    baseTransition,
    frontierValue = 0,
    endOpportunityPoints = 0
  }) {
    return baseTransition + frontierValue - statePointsToUtility(endOpportunityPoints);
  }

  /*
  功能
  计算 terminal/frontier 状态尚未兑现的威胁库存与持有选项表示。

  调用方
  Searcher candidate evaluation path。

  输入
  World 与 viewer ID。

  输出
  futureInventory、held.recover/recycle 与 total；viewer 无效时返回 null。

  读取状态
  viewer 自身生命、手牌、装备与公开威胁摘要。

  写入状态
  无。

  调用函数
  exposureComponents、cardAvailability。

  边界与不变量
  futureInventory 只作诊断；held option 只允许 terminal 一次进入 Final Utility。
  */
  frontierResidual(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer || !viewer.alive) return null;
    const { futureInventory, energyPressure } = exposureComponents(state, viewer);
    const recoverCards = (viewer.hand ?? [])
      .filter((card) => card.definitionId === "recover")
      .reduce((sum, card) => sum + cardAvailability(card), 0);
    const recover = recoverCards > 0
      ? Math.max(
          0,
          Math.min(recoverCards, Math.max(0, viewer.maxHp - viewer.hp))
        ) * HP_VALUE
      : 0;
    const recycle = viewer.equipmentDefinitionId === "recycleDevice"
      ? Math.max(0, 2 - (viewer.recycleDeviceUses ?? 0))
        * Math.min(
          1,
          (viewer.hand ?? []).filter(
            (card) => card.category === "tactic" && card.counterable !== false
          ).length
        )
        * 1.1
        * Math.max(0, Number(viewer.equipmentRetentionProbability) || 1)
      : 0;
    const futureInventoryTotal = futureInventory + energyPressure;
    return {
      futureInventory:futureInventoryTotal,
      held:{ recover, recycle },
      total:futureInventoryTotal + recover + recycle
    };
  }

  /*
  功能
  把 frontier 表示转换为 terminal held option utility。

  调用方
  Searcher candidate evaluation path。

  输入
  frontierResidual 返回的表示与是否 terminal。

  输出
  terminal 时 recover+recycle 的 HP-equivalent utility，否则为零。

  读取状态
  residual held fields。

  写入状态
  无。

  调用函数
  statePointsToUtility。

  边界与不变量
  futureInventory 已在 State Value 中表达，不能在此重复进入 Final Utility。
  */
  terminalFrontierValue(residual, terminal) {
    if (!terminal || !residual) return 0;
    return statePointsToUtility(
      (residual.held?.recover ?? 0) + (residual.held?.recycle ?? 0)
    );
  }

  /*
  功能
  计算一枚闪电完整生命周期对每个 owner 的预期经济变化。

  调用方
  lightningLifecycleValue、Evaluator 诊断 与正式边界。

  输入
  Simulator 已准备的基线 World、闪电 outcome Worlds 与 viewer ID。

  输出
  player ID 到未签名 owner delta 的 Map。

  读取状态
  只读 World、剩余牌计数与存活座位环。

  写入状态
  无。

  调用函数
  ownerMaterialDelta、Probability judgment projection。

  边界与不变量
  每个分支都必须由 Simulator 从同一基线构造；不把 unresolved lifecycle 再加入 frontier。
  */
  lightningLifecycleOwnerDeltas(
    state,
    outcomeSet,
    viewerId
  ) {
    if (!state) return new Map();
    const deltas = new Map(state.players.map((player) => [player.id, 0]));
    if (!outcomeSet || outcomeSet.presence <= 0) return deltas;
    const beforeRadar = buildRadarJudgmentProbabilities(
      queryCurrentCardCounts(state.probabilityState)
    ).tactic;
    for (const outcome of outcomeSet.outcomes ?? []) {
      const after = outcome.world;
      const afterRadar = buildRadarJudgmentProbabilities(
        queryCurrentCardCounts(after.probabilityState)
      ).tactic;
      for (const afterPlayer of after.players) {
        const delta = this.ownerMaterialDelta(
          state,
          after,
          afterPlayer.id,
          viewerId,
          beforeRadar,
          afterRadar
        );
        deltas.set(
          afterPlayer.id,
          (deltas.get(afterPlayer.id) ?? 0)
            + outcomeSet.presence * outcome.probability * delta
        );
      }
    }
    return deltas;
  }

  /*
  功能
  从 viewer 视角投影一枚闪电整个流转生命周期的预期局面变化。

  调用方
  Evaluator State Value、搜索先验、响应意愿与正式边界。

  输入
  基线 World、Simulator 已准备的 outcome set 与 viewer ID。

  输出
  viewer 团队视角的闪电生命周期值。

  读取状态
  只读存活玩家和队伍关系。

  写入状态
  无。

  调用函数
  lightningLifecycleOwnerDeltas。

  边界与不变量
  owner delta 只在此施加敌我符号，保持当前玩家顺序的浮点累加顺序。
  */
  lightningLifecycleValue(
    state,
    outcomeSet,
    viewerId
  ) {
    const viewer = state?.players?.find((player) => player.id === viewerId);
    if (!viewer) return 0;
    const deltas = this.lightningLifecycleOwnerDeltas(
      state,
      outcomeSet,
      viewerId
    );
    return state.players.reduce((sum, player) => {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      return sum + sign * (deltas.get(player.id) ?? 0);
    }, 0);
  }

  /*
  功能
  计算一枚闪电对 viewer 阵营造成的预期负担。

  调用方
  Controller response runtime boundary 与正式价值边界。

  输入
  基线 World、Simulator 已准备的 outcome set 与 viewer ID。

  输出
  生命周期价值的相反数。

  读取状态
  与 lightningLifecycleValue 相同。

  写入状态
  无。

  调用函数
  lightningLifecycleValue。

  边界与不变量
  只改变表示符号，不新增任何价值项。
  */
  lightningTeamBurden(state, outcomeSet, viewerId) {
    return -this.lightningLifecycleValue(state, outcomeSet, viewerId);
  }

  /*
  功能
  计算状态反制把同一枚闪电转交 receiver 后的阵营负担。

  调用方
  Controller response runtime boundary 与正式价值边界。

  输入
  Simulator 已构造的传递 World、对应 outcome set 与 viewer ID。

  输出
  过渡态中的闪电阵营负担。

  读取状态
  只读传入 World。

  写入状态
  无。

  调用函数
  lightningTeamBurden。

  边界与不变量
  必须先移除旧 holder 再计算新流转环，不能把同一枚闪电当作两个占位。
  */
  lightningTransferredBurden(transferredWorld, outcomeSet, viewerId) {
    if (!transferredWorld || !outcomeSet) return 0;
    return this.lightningTeamBurden(transferredWorld, outcomeSet, viewerId);
  }

  /*
  功能
  返回闪电状态反制 STAY/TRANSFER 两个世界的纯负担项。

  调用方
  shouldRespond 对 Controller 已预物化 Lightning Worlds 的比较。

  输入
  当前 World、STAY/TRANSFER outcome sets、可空传递 World 与 viewer ID。

  输出
  `{valid:true, noCounterBurden, withCounterBurden}`。

  读取状态
  当前闪电生命周期与传递后的独立克隆。

  写入状态
  无。

  调用函数
  lightningTeamBurden、lightningTransferredBurden。

  边界与不变量
  Controller 只绑定实体；两个价值世界只在本查询中各计算一次，不修改真实 World。
  */
  lightningCounterTerms(
    state,
    stayOutcomeSet,
    transferredWorld,
    transferredOutcomeSet,
    viewerId
  ) {
    return {
      valid:true,
      noCounterBurden:this.lightningTeamBurden(
        state,
        stayOutcomeSet,
        viewerId
      ),
      withCounterBurden:transferredWorld && transferredOutcomeSet
        ? this.lightningTransferredBurden(
            transferredWorld,
            transferredOutcomeSet,
            viewerId
          )
        : 0
    };
  }

  /*
  功能
  汇总当前状态中所有独立闪电对指定 owner 的未兑现变化。

  调用方
  Evaluator 诊断 与正式边界。

  输入
  状态、Simulator 已准备的所有闪电 outcome sets、owner ID 与 viewer ID。

  输出
  未签名 owner delta 总和。

  读取状态
  只读存活 holder 与闪电存在概率。

  写入状态
  无。

  调用函数
  lightningLifecycleOwnerDeltas、Probability.statusPresence。

  边界与不变量
  每枚独立闪电恰好计一次，按状态玩家顺序累加。
  */
  lightningOwnerDelta(state, outcomeSets, ownerId, viewerId) {
    let total = 0;
    for (const outcomeSet of outcomeSets ?? []) {
      total += this.lightningLifecycleOwnerDeltas(
        state,
        outcomeSet,
        viewerId
      ).get(ownerId) ?? 0;
    }
    return total;
  }

  /*
  功能
  比较 Simulator 已构造的护援 STAY/AID 配对 World。

  调用方
  shouldUseGuardianAid 对 Controller 已预物化 Guardian Worlds 的比较。

  输入
  基线 World、守誓者/目标 ID、STAY/AID Worlds 与各自闪电 outcomes。

  输出
  `{stayValue, aidValue, futureInventory}` 原始 Policy state points 对象。

  读取状态
  只读传入 World 与公开伤害上下文。

  写入状态
  无。

  调用函数
  stateUtility、exposureComponents。

  边界与不变量
  STAY/AID 必须由 Simulator 以同一基线和固定 canBlock:false 构造；State Value 与
  futureInventory 均保持 Policy state points，不在查询出口往返换算。
  */
  guardianAidValues(
    state,
    responderId,
    targetId,
    stayWorld,
    aidWorld,
    stayLightningOutcomeSets = [],
    aidLightningOutcomeSets = []
  ) {
    const visibleTarget = state.players.find((player) => player.id === targetId);
    const { futureInventory } = exposureComponents(state, visibleTarget);
    return {
      stayValue:this.stateUtility(stayWorld, responderId, stayLightningOutcomeSets),
      aidValue:this.stateUtility(aidWorld, responderId, aidLightningOutcomeSets),
      futureInventory
    };
  }

  /*
  功能
  比较 Simulator 已构造的 root STAY/RESOLVE Worlds，返回反制翻转价值增量。

  调用方
  shouldRespond 对 Controller 已预物化 root flip Worlds 的比较。

  输入
  Simulator root Worlds、响应者 ID 与两侧闪电 outcomes。

  输出
  FLIP-STAY 数值；全体受益牌返回 null。

  读取状态
  只读当前 World 与 root 公开上下文。

  写入状态
  无。

  调用函数
  transitionDelta。

  边界与不变量
  两个 Worlds 必须只在被测 root resolution 上不同；Evaluator 不构造或修改 World。
  */
  dynamicRootFlipGain(
    rootWorlds,
    responderId,
    baseLightningOutcomeSets = [],
    resolvedLightningOutcomeSets = []
  ) {
    if (!rootWorlds) return null;
    const rootEffectValue = this.transitionDelta(
      rootWorlds.baseWorld,
      rootWorlds.resolvedWorld,
      responderId,
      baseLightningOutcomeSets,
      resolvedLightningOutcomeSets
    );
    return rootWorlds.resolvesAtStay ? -rootEffectValue : rootEffectValue;
  }

  /*
  功能
  比较实际响应世界与只移除指定响应能力的配对反事实世界。

  调用方
  Evaluator 诊断。

  输入
  Simulator 已构造的实际/反事实 Worlds、defender/viewer ID 与两侧闪电 outcomes。

  输出
  grossAvoided、ownerValue 与 viewer projected value。

  读取状态
  只读 before/after 和指定响应概率字段。

  写入状态
  无。

  调用函数
  transitionDelta。

  边界与不变量
  反事实只改变正在测量的响应能力；其他资源、概率条件与实体身份必须由 Simulator 保持配对。
  */
  evaluateResponseCounterfactual(
    actualWorld,
    counterfactualWorld,
    defenderId,
    viewerId,
    actualLightningOutcomeSets = [],
    counterfactualLightningOutcomeSets = []
  ) {
    if (!actualWorld || !counterfactualWorld) {
      return { grossAvoided:0, ownerValue:0, projected:0 };
    }
    const actualDefender = actualWorld.players.find((player) => player.id === defenderId);
    const counterfactualDefender = counterfactualWorld.players.find(
      (player) => player.id === defenderId
    );
    const grossAvoided = Math.max(
      0,
      (actualDefender?.hp ?? 0) - (counterfactualDefender?.hp ?? 0)
    ) * HP_VALUE;
    const ownerValue = this.transitionDelta(
      counterfactualWorld,
      actualWorld,
      defenderId,
      counterfactualLightningOutcomeSets,
      actualLightningOutcomeSets
    );
    const projected = this.transitionDelta(
      counterfactualWorld,
      actualWorld,
      viewerId,
      counterfactualLightningOutcomeSets,
      actualLightningOutcomeSets
    );
    return { grossAvoided, ownerValue, projected };
  }

  /*
  功能
  把一次 state transition 分解到每个 owner 的互斥价值类别。

  调用方
  computeCandidateLedger、正式边界 与价值归属测试。

  输入
  before、after、viewer ID 与可选闪电结果 Worlds。

  输出
  包含 owners 和未签名 owner total 的账本。

  读取状态
  只读共享 state primitive、封印 burden 与闪电 owner delta。

  写入状态
  无；闪电查询只写自身缓存。

  调用函数
  Evaluator.playerValueTerms、sealTeamBurden、lightningOwnerDelta。

  边界与不变量
  每个字段只归属于一个 owner；团队符号只在 projectOwnerLedger 施加；
  Evaluator 只消费上游已准备的闪电结果 Worlds。
  */
  ownerStateLedger(
    before,
    after,
    viewerId,
    beforeLightningOutcomeSets = [],
    afterLightningOutcomeSets = []
  ) {
    const radarTactic = buildRadarJudgmentProbabilities(
      queryCurrentCardCounts(after.probabilityState)
    ).tactic;
    const viewer = after.players.find((player) => player.id === viewerId)
      ?? before.players.find((player) => player.id === viewerId);
    const beforePlayers = new Map(before.players.map((player) => [player.id, player]));
    const owners = [];
    for (const afterPlayer of after.players) {
      const beforePlayer = beforePlayers.get(afterPlayer.id);
      if (!beforePlayer) continue;
      const relation = afterPlayer.battleTeam === viewer.battleTeam
        ? (afterPlayer.id === viewerId ? "self" : "ally")
        : "enemy";
      const beforeTerms = this.playerValueTerms(
        before,
        beforePlayer,
        viewerId,
        radarTactic
      );
      const afterTerms = this.playerValueTerms(
        after,
        afterPlayer,
        viewerId,
        radarTactic
      );
      const beforeBurden = {
        lightning: this.lightningOwnerDelta(
          before,
          beforeLightningOutcomeSets,
          beforePlayer.id,
          viewerId
        ),
        seal: sealTeamBurden(before, beforePlayer, viewer.battleTeam)
      };
      const afterBurden = {
        lightning: this.lightningOwnerDelta(
          after,
          afterLightningOutcomeSets,
          afterPlayer.id,
          viewerId
        ),
        seal: sealTeamBurden(after, afterPlayer, viewer.battleTeam)
      };
      const fields = {};
      for (const key of new Set([
        ...Object.keys(beforeTerms.terms),
        ...Object.keys(afterTerms.terms)
      ])) {
        fields[key] = (afterTerms.terms[key] ?? 0) - (beforeTerms.terms[key] ?? 0);
      }
      fields.death = afterTerms.death - beforeTerms.death;
      fields.lightning = afterBurden.lightning - beforeBurden.lightning;
      fields.seal = afterBurden.seal - beforeBurden.seal;
      const total = Object.values(fields).reduce((sum, value) => sum + value, 0);
      owners.push({
        playerId: afterPlayer.id,
        relation,
        total,
        generic: { handCount: fields.handCount ?? 0, energy: fields.energy ?? 0 },
        material: {
          hp: fields.hp ?? 0,
          shield: fields.shield ?? 0,
          hp2Risk: fields.hp2Risk ?? 0,
          info: fields.info ?? 0,
          stacks: fields.stacks ?? 0,
          equipmentDelta: fields.equipmentDelta ?? 0,
          energyDeviceFuture: fields.energyDeviceFuture ?? 0,
          death: fields.death ?? 0
        },
        threat: {
          markThreat: fields.markThreat ?? 0,
          residualExposureValue: fields.residualExposureValue ?? 0
        },
        specific: {
          handRoleDelta: fields.handRoleDelta ?? 0,
          equipmentRole: fields.equipmentRoleDelta ?? 0
        },
        outcome: {
          danger: fields.danger ?? 0,
          rescueOutlook: fields.rescueOutlook ?? 0
        },
        teamBurden: {
          lightning: fields.lightning ?? 0,
          seal: fields.seal ?? 0
        }
      });
    }
    const total = owners.reduce((sum, owner) => sum + owner.total, 0);
    return { perspectiveId: viewerId, owners, total };
  }

  /*
  功能
  把 owner-local ledger 投影为 viewer 的 self、ally、enemy 与 total。

  调用方
  computeCandidateLedger、正式边界 与测试。

  输入
  owner ledger 与 viewer ID。

  输出
  敌方收益取反后的团队视角投影。

  读取状态
  只读账本对象。

  写入状态
  无。

  调用函数
  statePointsToUtility。

  边界与不变量
  projected.total 是显式 Final Utility 诊断，必须等于同一 before/after 原始 State points
  delta 经 statePointsToUtility 的单次边界换算。
  */
  projectOwnerLedger(ledger, viewerId) {
    const self = ledger.owners.find((owner) => owner.playerId === viewerId);
    const allies = ledger.owners.filter((owner) => owner.relation === "ally");
    const enemies = ledger.owners.filter((owner) => owner.relation === "enemy");
    const selfValue = statePointsToUtility(self?.total ?? 0);
    const allyValue = statePointsToUtility(
      allies.reduce((sum, owner) => sum + owner.total, 0)
    );
    const enemyValue = statePointsToUtility(
      enemies.reduce((sum, owner) => sum + owner.total, 0)
    );
    return {
      perspectiveId: viewerId,
      self: selfValue,
      ally: allyValue,
      enemy: enemyValue,
      total: selfValue + allyValue - enemyValue
    };
  }

  /*
  功能
  识别一次 transition 中实际消费的 block、counter 与 rescue。

  调用方
  Searcher 的诊断编排。

  输入
  before、动作、after 与 viewer ID。

  输出
  需要构造配对反事实的 attribution 描述数组。

  读取状态
  只读响应概率、手牌计数与恢复容量。

  写入状态
  无。

  调用函数
  queryPlayerHandProbability。

  边界与不变量
  只识别归属与移除项，不构造 World、不计算价值；描述只服务 diagnostics。
  */
  describeResponseAttributions(before, action, after, viewerId) {
    if (!action) return [];
    const beforeById = new Map(before.players.map((player) => [player.id, player]));
    const actorId = viewerId;
    const attributions = [];
    for (const player of after.players) {
      if (player.id === actorId || !player.alive) continue;
      const beforePlayer = beforeById.get(player.id);
      if (!beforePlayer) continue;
      const blockDropped = queryPlayerHandProbability(
        before.probabilityState, beforePlayer, "block"
      ).probability - queryPlayerHandProbability(
        after.probabilityState, player, "block"
      ).probability > 1e-9;
      const counterDropped = queryPlayerHandProbability(
        before.probabilityState, beforePlayer, "counter"
      ).probability - queryPlayerHandProbability(
        after.probabilityState, player, "counter"
      ).probability > 1e-9;
      if (blockDropped || counterDropped) {
        attributions.push({
          kind: blockDropped && counterDropped
            ? "blockAndCounter"
            : blockDropped ? "block" : "counter",
          responderId: player.id,
          protectedId: player.id,
          remove:{ removeBlock:blockDropped, removeCounter:counterDropped },
          resourceSpent: Math.max(
            0,
            (beforePlayer.handCount ?? 0) - (player.handCount ?? 0)
          ) * 1.1
        });
      }
    }
    for (const rescuer of after.players) {
      if (rescuer.id === actorId || !rescuer.alive) continue;
      const beforeRescuer = beforeById.get(rescuer.id);
      if (!beforeRescuer) continue;
      const recoverSpent = queryPlayerHandProbability(
        before.probabilityState, beforeRescuer, "recover"
      ).expected - queryPlayerHandProbability(
        after.probabilityState, rescuer, "recover"
      ).expected;
      if (recoverSpent > 1e-9) {
        attributions.push({
          kind: "rescue",
          responderId: rescuer.id,
          protectedId: null,
          remove:{ removeRecover:true },
          resourceSpent:recoverSpent * 1.1
        });
      }
    }
    return attributions;
  }

  /*
  功能
  把 Searcher 已完成的响应配对比较组装为诊断 ledger。

  调用方
  computeCandidateLedger。

  输入
  含 attribution 与 grossAvoided/ownerValue/projected 的纯比较结果。

  输出
  `{ responses }` 诊断对象。

  读取状态
  只读传入结果。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  响应值已包含在 state delta 中，仅作 owner attribution，不能再次加进 final value。
  */
  computeResponseLedger(attributions = []) {
    return {
      responses:attributions.map(({ evaluation = {}, remove, ...attribution }) => ({
        ...attribution,
        grossAvoided:evaluation.grossAvoided ?? 0,
        ownerValue:evaluation.ownerValue ?? 0,
        netValue:evaluation.projected ?? 0
      }))
    };
  }

  /*
  功能
  构造根候选的 owner、projection 与 response 诊断账本。

  调用方
  Searcher 的显式 diagnostics 路径与测试。

  输入
  before、动作、after、viewer ID、是否计算响应反事实与可选父 SearchBudget。

  输出
  ownerLedger、projected 与 responses。

  读取状态
  只读过滤后的 before/after。

  写入状态
  无。

  调用函数
  ownerStateLedger、projectOwnerLedger、computeResponseLedger。

  边界与不变量
  生产 diagnostics 关闭时不得调用本方法；返回字段不参与候选评分。
  */
  computeCandidateLedger(
    before,
    action,
    after,
    viewerId,
    includeResponse,
    beforeLightningOutcomeSets = [],
    afterLightningOutcomeSets = [],
    responseAttributions = []
  ) {
    const ownerLedger = this.ownerStateLedger(
      before,
      after,
      viewerId,
      beforeLightningOutcomeSets,
      afterLightningOutcomeSets
    );
    const projected = this.projectOwnerLedger(ownerLedger, viewerId);
    const responses = includeResponse
      ? this.computeResponseLedger(responseAttributions).responses
      : [];
    return { ownerLedger, projected, responses };
  }
}
