/*
模块职责
唯一拥有响应意愿、State Value、Transition Value、terminal frontier 与候选比较语义。

上游
AIController、Simulator composition、StateValue runtime adapter、Searcher、ValueLedger 与测试。

下游
Economics、CardValue、ThreatValue、GlobalBenefitValue、Domain card rules、封印 value 与 canonical Probability。

状态边界
只读 Fact/World、canonical Action、plain DecisionContext 和显式传入的领域值；不持有 Game，不写状态。

信息边界
只使用公开字段、合法概率摘要与 viewer 自身的可见卡牌身份。

架构约束
不得导入或构造 Simulator、Searcher、Controller；不得搜索、生成动作、执行响应 transition 或消费 Search Prior。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { getRecoverHealAmount } from "../../domain/rules/card/CardEffectRules.js";
import {
  PROBABILITY_EPSILON,
  buildRadarJudgmentProbabilities,
  clampProbability,
  hypergeometricProbabilityAtLeast,
  probabilityFromCurrentCounts,
  queryCurrentCardCounts,
  queryPlayerHandProbability,
  tacticJudgmentProbability
} from "../state/Probability/Probability.js";
import { sealTeamBurden } from "./SealValue.js";
import {
  cardAvailability,
  getBaseCardAiValue,
  getDiscardKeepValue,
  getResourceDefinitionUtility,
  getResourceUnknownUtility,
  getRoleCardAiValue,
  getTransferCardValue,
  getUnknownTransferCardValue,
  getUnknownAcquisitionUtility,
  roleCardDelta,
  skillThresholdOptionPolicyValue
} from "./CardValue.js";
import {
  ENERGY_STATE_WEIGHT,
  HP_VALUE,
  RESOURCE_MATERIAL_SCALE,
  energyDeviceFutureUtility,
  statePointsToUtility
} from "./Economics.js";
import { assessGlobalBenefit, mutualBenefitDraftValues } from "./GlobalBenefitValue.js";
import {
  DANGER_VALUE,
  DEATH_VALUE,
  exposureComponents,
  hp2ThreatRiskValue,
  incomingExposure,
  radarMitigationUtility,
  shieldStateValue,
  ThreatCalculator,
  turnOpportunityValue
} from "./ThreatValue.js";

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

/*
功能
返回所有响应入口共用且只计一次的反制牌机会成本。

调用方
Evaluator 响应意愿方法与 GlobalBenefitValue 价值边界。

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
export function globalBenefitCounterDecision(
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
queryPlayerHandProbability、cardAvailability。

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
  void selection;
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
      const threat = actorEnemy && knownAssault(target) ? HP_VALUE : 0;
      return actorEnemy ? 2.2 + threat : -(2.2 + threat);
    }
    case "destroy": {
      if (!target?.alive || !hasResource(target)) return 0;
      const threat = !actorEnemy && knownAssault(target) ? HP_VALUE : 0;
      return (target.battleTeam === team ? 1.1 + threat : 1.1) * (actorEnemy ? 1 : -1);
    }
    case "transfer": return actorEnemy ? 2.2 : -2.2;
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
  if (!Number.isFinite(gain)) return false;
  return gain > counterOpportunityCost();
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
Evaluator.resolveDiscardCandidates、AI runtime 与测试。

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
从合法已知手牌候选与一个聚合匿名候选中选择最高资源效用项。

调用方
Evaluator resource resolution 与直接测试。

输入
用途、双方公开信息、known candidates、匿名数量与 Belief counts。

输出
known/unknown 选择描述或 null。

读取状态
CardValue 的 known/unknown resource primitives。

写入状态
无。

调用函数
getResourceDefinitionUtility、getResourceUnknownUtility。

边界与不变量
匿名严格高于最佳已知才胜出；同分保持已知和输入顺序，unknown 不含实体身份。
*/
export function chooseBestResourceHandCandidate({
  purpose,
  actor,
  owner,
  knownCards,
  unknownCount,
  remainingCardCounts
}) {
  const knownList = Array.isArray(knownCards) ? knownCards : [];
  const hasUnknown = Number(unknownCount) > 0;
  let best = null;
  for (const entry of knownList) {
    const utility = getResourceDefinitionUtility(purpose, actor, owner, entry.definitionId);
    if (!best || utility > best.utility) {
      best = {
        selectionKind:"known",
        cardId:entry.cardId,
        definitionId:entry.definitionId,
        utility
      };
    }
  }
  if (!best && hasUnknown) {
    return {
      selectionKind:"unknown",
      cardId:null,
      definitionId:null,
      utility:getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts)
    };
  }
  if (best && hasUnknown) {
    const unknownUtility = getResourceUnknownUtility(
      purpose, actor, owner, remainingCardCounts
    );
    if (unknownUtility > best.utility) {
      return {
        selectionKind:"unknown",
        cardId:null,
        definitionId:null,
        utility:unknownUtility
      };
    }
  }
  return best;
}

/*
功能
在合法手牌候选与公开装备候选之间执行稳定资源区域比较。

调用方
Evaluator resource resolution 与直接测试。

输入
用途、双方公开信息、手牌候选和装备 definitionId。

输出
hand/equipment 选择描述或 null。

读取状态
CardValue resource primitive。

写入状态
无。

调用函数
getResourceDefinitionUtility。

边界与不变量
同分手牌优先；不移动或解析真实实体。
*/
export function chooseResourceZone({
  purpose,
  actor,
  owner,
  handCandidate,
  equipmentDefinitionId
}) {
  const handUtility = handCandidate ? handCandidate.utility : null;
  const equipmentChoice = equipmentDefinitionId ? {
    zone:"equipment",
    selectionKind:"equipment",
    cardId:null,
    definitionId:equipmentDefinitionId,
    utility:getResourceDefinitionUtility(purpose, actor, owner, equipmentDefinitionId)
  } : null;
  if (handUtility !== null && (equipmentChoice === null || handUtility >= equipmentChoice.utility)) {
    return {
      zone:"hand",
      selectionKind:handCandidate.selectionKind,
      cardId:handCandidate.cardId ?? null,
      definitionId:handCandidate.definitionId ?? null,
      utility:handUtility
    };
  }
  return equipmentChoice;
}

/*
功能
为一次资源反事实整理 known、anonymous 与 equipment 候选及其 CardValue primitives。

调用方
AiController contextual resource orchestration 与直接测试。

输入
用途、双方公开字段、合法 known identities、匿名容量、装备与 Belief counts。

输出
按 known、unknown、equipment 稳定顺序排列的局部候选数组。

读取状态
CardValue resource/acquisition/threshold primitives。

写入状态
无。

调用函数
getResourceDefinitionUtility、getResourceUnknownUtility、getUnknownAcquisitionUtility。

边界与不变量
unknown 最多一个且不携带实体身份；该局部记录不成为跨模块 canonical DTO。
*/
export function buildResourceCandidates({
  purpose,
  actor,
  owner,
  knownCards,
  unknownCount,
  equipmentDefinitionId,
  remainingCardCounts
}) {
  const candidates = [];
  for (const entry of Array.isArray(knownCards) ? knownCards : []) {
    candidates.push({
      zone:"hand",
      selectionKind:"known",
      cardId:entry.cardId,
      definitionId:entry.definitionId,
      staticUtility:getResourceDefinitionUtility(purpose, actor, owner, entry.definitionId),
      acquisitionUtility:purpose === "plunder" ? getBaseCardAiValue(entry.definitionId) : 0
    });
  }
  if (Number(unknownCount) > 0) {
    candidates.push({
      zone:"hand",
      selectionKind:"unknown",
      cardId:null,
      definitionId:null,
      staticUtility:getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts),
      acquisitionUtility:purpose === "plunder"
        ? getUnknownAcquisitionUtility(remainingCardCounts)
        : 0
    });
  }
  if (equipmentDefinitionId) {
    candidates.push({
      zone:"equipment",
      selectionKind:"equipment",
      cardId:null,
      definitionId:equipmentDefinitionId,
      staticUtility:getResourceDefinitionUtility(
        purpose, actor, owner, equipmentDefinitionId
      ),
      acquisitionUtility:purpose === "plunder"
        ? getBaseCardAiValue(equipmentDefinitionId)
        : 0,
      skillThresholdOption:skillThresholdOptionPolicyValue(
        actor, owner, equipmentDefinitionId
      )
    });
  }
  return candidates;
}

/*
功能
从已完成 after-state 估值的资源候选中选择最高上下文收益项。

调用方
AiController contextual resource orchestration 与直接测试。

输入
带 contextualUtility/staticUtility 的候选数组。

输出
最佳候选描述或 null。

读取状态
只读候选分项。

写入状态
无。

调用函数
无。

边界与不变量
上下文收益优先、静态值只破同分，最终保持输入顺序。
*/
export function chooseContextualResourceCandidate(candidates) {
  let best = null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!Number.isFinite(candidate?.contextualUtility)) continue;
    if (!best
      || candidate.contextualUtility > best.contextualUtility + 1e-9
      || (Math.abs(candidate.contextualUtility - best.contextualUtility) <= 1e-9
        && candidate.staticUtility > best.staticUtility)) {
      best = candidate;
    }
  }
  return best ? { ...best, utility:best.contextualUtility } : null;
}

/*
功能
从公开合法牌池中按角色 CardValue 稳定选择最佳实体 ID。

调用方
Evaluator.choosePublicCardId、AIController 与直接测试。

输入
当前玩家和公开卡牌数组。

输出
最佳 cardId 或 null。

读取状态
CardValue 角色 primitive。

写入状态
无。

调用函数
getRoleCardAiValue。

边界与不变量
同分保持公开池原始顺序。
*/
export function choosePublicCardId(player, cards) {
  let best = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const card of cards ?? []) {
    const value = getRoleCardAiValue(player.characterId, card.definitionId);
    if (value > bestValue) {
      best = card;
      bestValue = value;
    }
  }
  return best?.id ?? null;
}

/*
功能
从自己合法手牌中按角色 CardValue 稳定选择最低价值实体 ID。

调用方
AIController hidden-card runtime resolution。

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
AIController 的 scout/spy-gap 与默认隐藏选择。

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

/*
功能
为非 destroy/plunder 的历史 hidden-zone 场景选择手牌或公开装备描述。

调用方
AIController.chooseZoneCard fallback。

输入
行动者、资源拥有者、一个手牌候选与当前装备。

输出
hand/equipment 描述或 null。

读取状态
公开装备 CardValue 与目标手牌数量。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
保持冻结的公开装备七点阈值；不读取隐藏手牌定义。
*/
export function chooseDefaultZoneSelection({ actor, owner, handCard, equipment }) {
  if (equipment && (!owner.hand.length
    || (actor.id !== owner.id && getBaseCardAiValue(equipment.definitionId) >= 7))) {
    return { zone:"equipment", cardId:equipment.id ?? null };
  }
  if (handCard) return { zone:"hand", cardId:handCard.id };
  return equipment ? { zone:"equipment", cardId:equipment.id ?? null } : null;
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
列出观察者确定知道且当前确定可用的转移手牌身份。

调用方
chooseTransferHandCandidateValue。

输入
观察者、资源拥有者与可选排除 ID。

输出
只含 cardId/definitionId 的候选数组。

读取状态
观察者自己的 hand 或 Fact 已过滤的 knownCards。

写入状态
无。

调用函数
cardAvailability。

边界与不变量
部分概率身份与匿名槽都不进入输出，其他玩家真实 hand 从不作为身份来源。
*/
function knownTransferCardEntries(actor, owner, excludedCardIds = null) {
  let cards;
  if (actor?.id === owner?.id) {
    cards = owner?.hand ?? [];
  } else if (Array.isArray(owner?.knownCards)) {
    cards = owner.knownCards;
  } else {
    cards = Object.entries(actor?.aiMemory?.knownCardsByPlayer?.[owner?.id] ?? {})
      .map(([cardId, definitionId]) => ({ cardId, definitionId }));
  }
  return cards
    .filter((card) => !excludedCardIds?.has(card.id ?? card.cardId))
    .filter((card) => cardAvailability(card) >= 1 - PROBABILITY_EPSILON)
    .map((card) => ({
      cardId:card.id ?? card.cardId,
      definitionId:card.definitionId
    }))
    .filter((entry) => entry.cardId && entry.definitionId);
}

/*
功能
把一张资源从来源移到接收者的双方阵营价值组合为局部转移效用。

调用方
chooseTransferHandCandidateValue、evaluateTransferSelection。

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
在已知实体和一个匿名聚合槽之间选择局部转移效用最高的资源。

调用方
Evaluator.chooseTransferHandCandidate、Controller runtime fallback。

输入
行动者、来源、接收者、排除 ID 与 remaining-card counts。

输出
known/unknown 资源描述或 null。

读取状态
过滤后的可见身份、公开手牌数量与 CardValue primitive。

写入状态
无。

调用函数
knownTransferCardEntries、transferHandCount、getTransferCardValue、getUnknownTransferCardValue、transferResourceUtility。

边界与不变量
匿名输出不含 definitionId；同分保持 known 优先，再按 cardId 升序。
*/
function chooseTransferHandCandidateValue(
  actor,
  from,
  receiver,
  excludedCardIds = null,
  remainingCardCounts = null
) {
  const knownEntries = knownTransferCardEntries(actor, from, excludedCardIds);
  const unknownCount = Math.max(
    0,
    transferHandCount(from, excludedCardIds) - knownEntries.length
  );
  const knownCardIds = knownEntries.map((entry) => entry.cardId);
  const candidates = knownEntries.map((entry) => {
    const sourceValue = getTransferCardValue(entry.definitionId, from);
    const receiverValue = getTransferCardValue(entry.definitionId, receiver);
    return {
      selectionKind:"known",
      cardId:entry.cardId,
      definitionId:entry.definitionId,
      expectedValue:receiverValue,
      utility:transferResourceUtility(actor, from, receiver, sourceValue, receiverValue),
      knownCardIds,
      availableUnknownCount:0
    };
  });
  if (unknownCount > 0) {
    const sourceValue = getUnknownTransferCardValue(from, remainingCardCounts);
    const receiverValue = getUnknownTransferCardValue(receiver, remainingCardCounts);
    candidates.push({
      selectionKind:"unknown",
      cardId:null,
      definitionId:null,
      expectedValue:receiverValue,
      utility:transferResourceUtility(actor, from, receiver, sourceValue, receiverValue),
      knownCardIds,
      availableUnknownCount:unknownCount
    });
  }
  candidates.sort((left, right) => right.utility - left.utility
    || (left.selectionKind === "known" ? 0 : 1)
      - (right.selectionKind === "known" ? 0 : 1)
    || String(left.cardId ?? "").localeCompare(String(right.cardId ?? "")));
  return candidates[0] ?? null;
}

/*
功能
把过滤后的玩家状态归一化为 ThreatValue 可消费的转移视图。

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
ThreatValue 差值。

读取状态
公开玩家字段与行动者合法近期攻击者记忆。

写入状态
无。

调用函数
ThreatCalculator.calculate、transferThreatView。

边界与不变量
不读取任一未知手牌定义。
*/
function transferEnemyThreatGap(actor, from, receiver) {
  const memory = actor?.aiMemory ?? {};
  return ThreatCalculator.calculate(transferThreatView(actor), transferThreatView(from), memory)
    - ThreatCalculator.calculate(transferThreatView(actor), transferThreatView(receiver), memory);
}

/*
功能
对一个已由 Generator 枚举的 source/receiver/resource 选择计算完整转移 preference。

调用方
Evaluator.evaluateTransferAction、Evaluator.chooseTransferAction。

输入
行动者、来源、接收者、canonical Action selection、排除 ID 与 remaining-card counts。

输出
包含冻结分数、资源身份和稳定比较字段的局部候选记录。

读取状态
CardValue primitive、公开关系/容量、ThreatValue 与控制器类型。

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
Evaluator.chooseTransferAction、Evaluator.compareCandidates。

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

export class Evaluator {
  /*
  功能
  绑定状态估值所需的稳定规则查询能力。

  调用方
  AIController 组合根（统一组装依赖的位置） 与纯价值测试。

  输入
  getMaxEnergy、getTurnEnergyBreakdown 与 getDifficultyMultiplier 三个显式规则函数。

  输出
  不持有 Game 的纯状态评估器实例。

  读取状态
  仅保存规则函数引用。

  写入状态
  写入实例的不可变依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Simulator、Planner 或 Controller；规则函数只能回答稳定能量规则。
  */
  constructor({
    getMaxEnergy = null,
    getTurnEnergyBreakdown = null,
    getDifficultyMultiplier = () => 1
  } = {}) {
    this.energyRules = Object.freeze({ getMaxEnergy, getTurnEnergyBreakdown });
    this.getDifficultyMultiplier = getDifficultyMultiplier;
  }

  /*
  功能
  在一个 Domain 合法 source/receiver 对的已知实体与匿名聚合槽中选择最高价值资源。

  调用方
  AIController 的 transfer-only runtime entity resolution 与直接价值测试。

  输入
  行动者、来源、接收者、排除实体 ID 与可选 remaining-card counts。

  输出
  known/unknown 资源描述或 null。

  读取状态
  调用方提供的过滤玩家、合法记忆、公开手牌数量与 Belief counts。

  写入状态
  无。

  调用函数
  chooseTransferHandCandidateValue。

  边界与不变量
  不枚举 source/receiver，不解析物理匿名实体，也不读取真实隐藏牌面。
  */
  chooseTransferHandCandidate(
    actor,
    from,
    receiver,
    excludedCardIds = null,
    remainingCardCounts = null
  ) {
    if (!actor || !from || !receiver) return null;
    return chooseTransferHandCandidateValue(
      actor,
      from,
      receiver,
      excludedCardIds,
      remainingCardCounts
    );
  }

  /*
  功能
  计算一个 Generator 已完整枚举的 canonical Transfer Action 的冻结 contextual preference。

  调用方
  evaluateTransition、chooseTransferAction、main-thread/Worker 一致性测试。

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
  从调用方提供的 canonical Transfer Actions 中按冻结 preference 与门槛选择执行描述。

  调用方
  AIController.chooseTransferCombination。

  输入
  合法 Transfer Actions、行动者、当前 World 与最低效用。

  输出
  兼容 Application 的 frozen Action.selection 描述；无达标候选时返回 null。

  读取状态
  evaluateTransferAction 的 contextual preference。

  写入状态
  无。

  调用函数
  evaluateTransferAction、compareTransferPreferences。

  边界与不变量
  不生成候选、不模拟、不解析物理牌；完全等价时保留 Generator 原顺序。
  */
  chooseTransferAction(actions, actor, state, minimumUtility = MIN_TRANSFER_UTILITY) {
    let best = null;
    for (const action of actions ?? []) {
      const preference = this.evaluateTransferAction(action, actor, state);
      if (!best || compareTransferPreferences(preference, best.preference) > 0) {
        best = { action, preference };
      }
    }
    if (!best || best.preference.score < minimumUtility) return null;
    return Object.freeze({
      ...best.action.selection,
      score:best.preference.score,
      expectedValue:best.preference.expectedValue,
      knownCardIds:best.preference.knownCardIds,
      availableUnknownCount:best.preference.availableUnknownCount
    });
  }

  /*
  功能
  把弃牌候选解析为稳定的已选实体数组。

  调用方
  AIController、main-thread/Worker Simulator composition。

  输入
  玩家、合法卡牌、数量与公开弃牌上下文。

  输出
  最低保留价值的卡牌数组。

  读取状态
  CardValue discard primitive。

  写入状态
  无。

  调用函数
  chooseDiscardCandidates。

  边界与不变量
  本方法只决定身份，不移动卡牌；Simulator 必须只消费返回的 ID。
  */
  resolveDiscardCandidates(player, cards, count, context = {}) {
    return chooseDiscardCandidates(player, cards, count, context);
  }

  /*
  功能
  把一次已执行的资源反事实转换为可比较的 contextual candidate value。

  调用方
  AIController.chooseContextualZoneCard。

  输入
  before/after World、行动者、用途、候选、应用概率与 StateValue raw delta。

  输出
  附带 contextual/material/threshold 分项的新候选记录。

  读取状态
  公开装备材料差、候选 CardValue primitives 与冻结资源材料尺度。

  写入状态
  无。

  调用函数
  equipmentMaterialDelta。

  边界与不变量
  不启动 Simulator/StateValue；每个候选的 clone、transition 和 state delta 由 composition 恰好执行一次。
  */
  evaluateResourceTransitionCandidate({
    before,
    after,
    actorId,
    purpose,
    candidate,
    appliedProbability,
    rawStateDelta
  }) {
    if (appliedProbability <= PROBABILITY_EPSILON) {
      return { ...candidate, contextualUtility:-Infinity, appliedProbability:0 };
    }
    const equipmentMaterialDelta = this.equipmentMaterialDelta(before, after, actorId);
    const contextualStateDelta = rawStateDelta - equipmentMaterialDelta;
    const acquisitionMaterial = purpose === "plunder"
      ? candidate.acquisitionUtility * RESOURCE_MATERIAL_SCALE * appliedProbability
      : 0;
    const skillThresholdOption = (Number(candidate.skillThresholdOption) || 0)
      * appliedProbability;
    return {
      ...candidate,
      appliedProbability,
      rawStateDelta,
      equipmentMaterialDelta,
      contextualStateDelta,
      acquisitionMaterial,
      skillThresholdOption,
      contextualUtility:contextualStateDelta + acquisitionMaterial + skillThresholdOption
    };
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
  决定借势第一目标是否愿意把现有装备换成一次突袭。

  调用方
  Simulator composition 注入的 decideLeverageAssault capability。

  输入
  World、第一目标与第二目标。

  输出
  确定的愿意/拒绝布尔值。

  读取状态
  第一目标装备价值、突袭容量、第二目标格挡概率与敌友关系。

  写入状态
  无。

  调用函数
  getBaseCardAiValue、queryPlayerHandProbability。

  边界与不变量
  保留既有 heuristic 的全部输入和 0.5 阈值；返回值不是自然概率。
  */
  decideLeverageAssault(state, first, second) {
    const firstAssault = queryPlayerHandProbability(
      state.probabilityState,
      first,
      "assault"
    );
    const secondBlock = queryPlayerHandProbability(
      state.probabilityState,
      second,
      "block"
    );
    const equipmentValue = getBaseCardAiValue(first.equipmentDefinitionId);
    const friendlyFirePenalty = second.battleTeam === first.battleTeam ? 0.55 : 0;
    const defenseRisk = Math.min(0.9, secondBlock.probability);
    const targetValue = second.battleTeam === first.battleTeam
      ? -0.35 - (second.hp <= 2 ? 0.15 : 0)
      : 0.3 + (second.hp <= 2 ? 0.15 : 0);
    const conserveAssaultPenalty = firstAssault.expected <= 0.75 ? 0.18 : 0;
    const willingness = 0.42 + equipmentValue * 0.04 + targetValue
      - friendlyFirePenalty - defenseRisk * 0.2 - conserveAssaultPenalty;
    return willingness >= 0.5;
  }

  /*
  功能
  显式返回规划世界既有的自动格挡意愿。

  调用方
  ResponseSimulation.consumeBlockResponseWorlds。

  输入
  当前 World、目标、攻击世界与响应选项。

  输出
  固定 true，表示规划镜像沿用迁移前“有容量即格挡”的确定选择。

  读取状态
  无；容量与合法性由 Probability 和 Simulator 分别判断。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  本阶段只显式迁移隐含意愿 owner，不改变既有行为或 Block threshold。
  */
  decidePlanningBlock(state, target, attackWorlds, options = {}) {
    void state;
    void target;
    void attackWorlds;
    void options;
    return true;
  }

  /*
  功能
  显式返回规划世界既有的自动护援意愿。

  调用方
  ResponseSimulation.simulateGuardianAid。

  输入
  当前 World、守护者、被保护目标与伤害上下文。

  输出
  固定 true，表示规划镜像沿用迁移前“合法且有资源即护援”的确定选择。

  读取状态
  无；资格、额度和资源容量由 Simulator/Probability 判断。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  本阶段只显式迁移隐含意愿 owner，不改变护援顺序、资源选择或阈值。
  */
  decidePlanningGuardianAid(state, guardian, target, context = {}) {
    void state;
    void guardian;
    void target;
    void context;
    return true;
  }

  /*
  功能
  显式返回规划世界既有的自动濒死救援意愿。

  调用方
  CombatSimulation.resolveFatal。

  输入
  当前 World、救援者、濒死目标与当前轮次容量上下文。

  输出
  固定 true，表示规划镜像沿用迁移前“合法且有调息即救援”的确定选择。

  读取状态
  无；Recover capacity 与救援顺序分别由 Probability 和 Domain Rules 判断。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  本阶段只显式迁移隐含意愿 owner，不改变多轮救援、死亡清理或奖励。
  */
  decidePlanningDyingRescue(state, rescuer, target, context = {}) {
    void state;
    void rescuer;
    void target;
    void context;
    return true;
  }

  /*
  功能
  计算借势响应所需的目标威胁与格挡风险价值输入。

  调用方
  AIController.buildResponseDecisionContext 的 leverageMetrics 惰性查询。

  输入
  响应者/目标公开视图、合法记忆、World 与 current remaining counts。

  输出
  `{threat, blockRisk}` 纯数值。

  读取状态
  公开目标事实、合法记忆、Probability current counts 与难度倍率。

  写入状态
  无。

  调用函数
  threatPriority、probabilityFromCurrentCounts。

  边界与不变量
  Controller 只提供 runtime-bound facts；0.85 上限和既有乘法顺序保持不变。
  */
  leverageResponseMetrics(responder, target, memory, world, remainingCardCounts) {
    const worldResponder = world.players.find((player) => player.id === responder.id);
    const worldTarget = world.players.find((player) => player.id === target.id);
    const enemyTarget = target.battleTeam !== responder.battleTeam;
    const threat = enemyTarget && worldResponder && worldTarget
      ? this.threatPriority(worldResponder, worldTarget, memory, 1)
      : 0;
    const blockRisk = Math.min(
      0.85,
      target.handCount * probabilityFromCurrentCounts(remainingCardCounts, "block")
    );
    return { threat, blockRisk };
  }

  /*
  功能
  把 canonical Seal probability 与回合机会价值组合为状态反制纯价值项。

  调用方
  AIController.buildResponseDecisionContext 的 sealCounterTerms 惰性查询。

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
  shouldRespond、AIController.assessDyingRescue 与直接价值测试。

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
    const strategic = (target.roleTags ?? []).some(
      (tag) => ["support", "healer", "damage", "control", "tank"].includes(tag)
    );
    const actionValue = target.handCount * 1.25
      + target.energy * 1.1
      + (target.hasEquipment ? 2 : 0)
      + (strategic ? 3 : 0);
    const immediateDefeatRisk = aliveTeam.length <= 2;
    const lastRecoverPenalty = ownRecover === 1 ? (responder.hp <= 2 ? 3 : 1.5) : 0;
    const survivalValue = HP_VALUE + actionValue + (immediateDefeatRisk ? 8 : 0);
    const recoverOpportunityCost = getBaseCardAiValue("recover") * 0.35 + lastRecoverPenalty;
    const expectedRescueValue = rescueSuccessProbability * survivalValue
      - recoverOpportunityCost;
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
      strategic,
      immediateDefeatRisk,
      actionValue,
      survivalValue,
      recoverOpportunityCost,
      expectedRescueValue,
      score:expectedRescueValue
    };
  }

  /*
  功能
  从公开突袭上下文读取当前确定的角色加伤预览。

  调用方
  shouldRespond 的 block 分支与 AIController 专项入口。

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
  AIController runtime response boundary 与直接价值测试。

  输入
  plain DecisionContext，含 responseType、公开玩家、合法 Cards、Probability 与窄查询。

  输出
  是否响应的确定布尔值。

  读取状态
  只读 DecisionContext 和惰性纯查询结果。

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
      cards = [],
      players,
      rescueOrder,
      responderHandDefinitionIds,
      knownCardsByPlayer,
      recoverDensity,
      remainingCardCounts,
      isSmallTeam,
      forceAiRescueHuman,
      leverageMetrics,
      guardianAidValues,
      lightningCounterTerms,
      sealCounterTerms,
      dynamicRootFlipGain
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
      if (!assessment.ownRecover) return false;
      if (assessment.guaranteedImpossible) return false;
      if (target.id === responder.id) return true;
      if (
        forceAiRescueHuman
        && responder.controllerType === "ai"
        && target.controllerType === "human"
      ) return true;
      return assessment.expectedRescueValue > 0;
    }
    if (type === "block") {
      const incoming = Math.max(0, Number(context.amount ?? 1) || 0)
        + this.knownPendingAssaultBonus(context);
      const lethal = incoming - target.shield >= target.hp;
      const availableBlocks = cards.length;
      const requiredBlocks = Math.max(1, context.requiredCount ?? 1);
      if (availableBlocks < requiredBlocks) return false;
      const lowHp = target.hp <= 2;
      const blocksAreAbundant = availableBlocks * 2 >= responder.handCount;
      if (isSmallTeam) return true;
      return lethal || lowHp || blocksAreAbundant;
    }
    if (type === "counter") {
      if (context.statusCounterContext) {
        return context.statusCounterContext.statusId === "sealed"
          ? this.shouldCounterSeal(sealCounterTerms())
          : this.shouldCounterLightning(lightningCounterTerms());
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
      if (rootId === "counter") {
        const sourceEnemy = context.source?.battleTeam !== responder.battleTeam;
        return sourceEnemy && context.card?.definitionId
          ? getBaseCardAiValue(context.card.definitionId) >= 7
          : false;
      }
      const gain = dynamicRootFlipGain();
      return gain !== null && gain > counterOpportunityCost();
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
      if (!cards.length || !target?.alive) return false;
      const metrics = leverageMetrics();
      const enemyTarget = target.battleTeam !== responder.battleTeam;
      const attackBenefit = enemyTarget
        ? 4
          + metrics.threat
          + Math.max(0, target.maxHp - target.hp) * 1.5
          + (target.hp <= 1 ? 5 : 0)
        : -10;
      const equipmentValue = context.equipment?.definitionId
        ? getBaseCardAiValue(context.equipment.definitionId)
        : 5;
      const assaultCost = cards.length <= 1 ? 4.5 : 2.5;
      const score = attackBenefit
        + equipmentValue * 1.05
        - assaultCost
        - metrics.blockRisk * 2.5;
      return score > 0;
    }
    if (type === "skill") return this.shouldUseGuardianAid(decision, guardianAidValues);
    return false;
  }

  /*
  功能
  比较护援 STAY/AID 配对世界和唯一额度的未来机会成本。

  调用方
  shouldRespond 的 skill 分支。

  输入
  公开合法上下文和 guardianAidValues 窄查询。

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
  shouldUseGuardianAid(decision, guardianAidValues) {
    const { responder, context } = decision;
    const target = context.target;
    if (!responder?.alive || !target?.alive || responder.id === target.id) return false;
    if (responder.battleTeam !== target.battleTeam) return false;
    if (!responder.handCount) return false;
    const amount = Math.max(0, Number(context.amount) || 0);
    if (amount <= 0) return false;
    if (responder.guardianAidUsed) return false;
    const { stayValue, aidValue, futureInventory } = guardianAidValues();
    const quotaFutureValue = Math.min(HP_VALUE, futureInventory);
    return (aidValue - stayValue) > quotaFutureValue;
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
  SearchPrior exploration 与 AIController leverage decision context。

  输入
  viewer、target、合法记忆与预计伤害。

  输出
  非负难度缩放 preference；非敌方或零倍率返回零。

  读取状态
  注入的难度倍率与公开目标事实。

  写入状态
  无。

  调用函数
  ThreatCalculator.calculate。

  边界与不变量
  这是唯一 target preference 语义；Searcher/Controller/Policy 不得复制公式，且本值不直接进入 Final Utility。
  */
  threatPriority(viewer, target, memory, expectedDamage = 1) {
    const multiplier = Math.max(
      0,
      Number(this.getDifficultyMultiplier?.() ?? 1) || 0
    );
    if (!multiplier || !target || target.battleTeam === viewer.battleTeam) return 0;
    return ThreatCalculator.calculate(viewer, target, memory, expectedDamage) * 0.12 * multiplier;
  }

  /*
  功能
  生成单个玩家状态价值的未签名共享分项。

  调用方
  stateUtility、ValueLedger 与 lightning simulation query。

  输入
  过滤后的状态、玩家、viewer ID 与雷达战术判定概率。

  输出
  death 与 terms 分解；阵亡角色只返回 death。

  读取状态
  只读公开资源、合法概率摘要、viewer 自身手牌身份与稳定规则查询。

  写入状态
  无。

  调用函数
  queryPlayerHandProbability、CardValue、ThreatValue 与 energyDeviceFutureUtility。

  边界与不变量
  这里不施加团队符号，也不计封印/闪电 burden；同一分项同时供 state value 与 ledger 使用。
  */
  playerValueTerms(state, player, viewerId, radarTacticProbability) {
    if (!player.alive) return { death: -DEATH_VALUE, terms: {} };
    const danger = player.hp <= 1 ? -DANGER_VALUE : 0;
    let rescueOutlook = 0;
    if (player.hp <= 1) {
      const rescueCapacity = state.players
        .filter((rescuer) => rescuer.alive && rescuer.battleTeam === player.battleTeam)
        .reduce((sum, rescuer) => (
          sum + queryPlayerHandProbability(
            state.probabilityState,
            rescuer,
            "recover"
          ).expected
        ), 0);
      if (rescueCapacity > 0) {
        const requiredRecovery = Math.max(1, 1 - player.hp);
        const rescueCoverage = Math.min(1, rescueCapacity / requiredRecovery);
        // 零容量沿用无救援账字段时的中性值；非零容量保留原 coverage 价值曲线。
        rescueOutlook = (rescueCoverage - 0.5) * 8;
      }
    }
    const equipmentValue = player.equipmentDefinitionId
      ? getBaseCardAiValue(player.equipmentDefinitionId)
      : 0;
    const equipmentDelta = equipmentValue
      * (player.equipmentRetentionProbability ?? (equipmentValue ? 1 : 0))
      * RESOURCE_MATERIAL_SCALE;
    const currentEquipmentRoleDelta = player.equipmentDefinitionId
      ? roleCardDelta(player.characterId, player.equipmentDefinitionId)
      : 0;
    const equipmentRoleDelta = currentEquipmentRoleDelta
      * (player.equipmentRetentionProbability ?? (currentEquipmentRoleDelta ? 1 : 0))
      * RESOURCE_MATERIAL_SCALE;
    const handRoleDelta = player.id === viewerId
      ? (player.hand ?? []).reduce((sum, card) => (
          sum + roleCardDelta(player.characterId, card?.definitionId) * cardAvailability(card)
        ), 0)
      : 0;
    const markThreat = Object.entries(player.huntMarkProbabilities ?? {}).reduce(
      (sum, [sourceId, probability]) => {
        const source = state.players.find((entry) => entry.id === sourceId);
        return sum + (source?.battleTeam !== player.battleTeam ? Number(probability) || 0 : 0);
      },
      0
    );
    const {
      currentThreat,
      futureInventory,
      energyPressure,
      perEnemy
    } = exposureComponents(state, player);
    const exposure = currentThreat + futureInventory + energyPressure;
    const radarMitigation = radarMitigationUtility(exposure, player, radarTacticProbability);
    const residualExposure = Math.max(0, exposure - radarMitigation);
    const shield = shieldStateValue(player, residualExposure);
    // hp2 风险排除 viewer 自身对敌方造成的资源联动，避免同一资源消费在 threat 外再记一次。
    const bufferExposure = (perEnemy ?? [])
      .filter((entry) => entry.enemyId !== viewerId)
      .reduce((sum, entry) => (
        sum + entry.currentThreat + entry.futureInventory + entry.energyPressure
      ), 0);
    const bufferResidualExposure = Math.max(
      0,
      bufferExposure - radarMitigationUtility(bufferExposure, player, radarTacticProbability)
    );
    const hp2Risk = hp2ThreatRiskValue(player, bufferResidualExposure);
    const energyDeviceFuture = energyDeviceFutureUtility(this.energyRules, player);
    return {
      death: 0,
      terms: {
        danger,
        hp2Risk,
        rescueOutlook,
        hp: player.hp * HP_VALUE,
        shield,
        energy: Math.max(0, Number(player.energy) || 0) * ENERGY_STATE_WEIGHT,
        handCount: player.handCount * 1.1,
        handRole: handRoleDelta,
        stacks: (player.exposeWeaknessStacks ?? 0) * 1.5,
        equipmentDelta,
        equipmentRoleDelta,
        markThreat: -markThreat * 1.5,
        currentThreat: -currentThreat,
        futureInventory: -futureInventory,
        energyPressure: -energyPressure,
        radar: radarMitigation,
        energyDeviceFuture
      }
    };
  }

  /*
  功能
  投影一次状态变化中静态装备资产与角色装备差量的团队价值贡献。

  调用方
  Controller 资源反事实编排：把长期资产先验与当前已兑现装备效果分离。

  输入
  before/after World 与 viewer ID。

  输出
  已按 self/ally/enemy 符号投影的 equipmentDelta+equipmentRoleDelta 变化。

  读取状态
  只读双方玩家公开装备字段与 StateValue 装备基线字段。

  写入状态
  无。

  调用函数
  playerValueTerms。

  边界与不变量
  只剥离两个静态装备材料项；距离、雷达、能量与其它上下文效果仍保留在完整 StateValue delta 中。
  */
  equipmentMaterialDelta(before, after, viewerId) {
    const viewer = after.players.find((player) => player.id === viewerId)
      ?? before.players.find((player) => player.id === viewerId);
    if (!viewer) return 0;
    const beforePlayers = new Map(before.players.map((player) => [player.id, player]));
    return after.players.reduce((sum, afterPlayer) => {
      const beforePlayer = beforePlayers.get(afterPlayer.id);
      if (!beforePlayer) return sum;
      const beforeTerms = this.playerValueTerms(before, beforePlayer, viewerId, 0).terms;
      const afterTerms = this.playerValueTerms(after, afterPlayer, viewerId, 0).terms;
      const localDelta = (afterTerms.equipmentDelta ?? 0) - (beforeTerms.equipmentDelta ?? 0)
        + (afterTerms.equipmentRoleDelta ?? 0) - (beforeTerms.equipmentRoleDelta ?? 0);
      const sign = afterPlayer.battleTeam === viewer.battleTeam ? 1 : -1;
      return sum + sign * localDelta;
    }, 0);
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
  ValueSimulationQuery 的闪电生命周期分支。

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
把状态与调用层已计算的闪电、封印值转换为唯一团队 State Value。

  调用方
  状态价值运行时适配器与纯边界测试。

  输入
过滤后的状态、viewer ID，以及按 holder 顺序排列的闪电与可选封印纯数值。

  输出
  viewer 团队视角的原始 State Value points；找不到 viewer 时返回负无穷。

  读取状态
  只读公开资源、合法概率摘要和传入的领域值。

  写入状态
  无。

  调用函数
  playerValueTerms、sealTeamBurden、Probability.buildRadarJudgmentProbabilities。

  边界与不变量
闪电与搜索期封印值由调用层以 State points 传入；无封印数组的独立调用保持 raw Domain 默认；
本函数始终保留原始 State Value points，
  只有进入 Final Utility 的边界才执行 HP-equivalent 换算。
  */
  stateUtility(state, viewerId, lightningValues = [], sealValues = null) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) return -Infinity;
    const radarTacticProbability = buildRadarJudgmentProbabilities(
      queryCurrentCardCounts(state.probabilityState)
    ).tactic;
    let score = 0;
    for (let playerIndex = 0; playerIndex < state.players.length; playerIndex += 1) {
      const player = state.players[playerIndex];
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      const { death, terms } = this.playerValueTerms(
        state,
        player,
        viewerId,
        radarTacticProbability
      );
      score += sign * (death + Object.values(terms).reduce((sum, value) => sum + value, 0))
        - (Array.isArray(sealValues)
          ? Number(sealValues[playerIndex]) || 0
          : sealTeamBurden(state, player, viewer.battleTeam));
    }
    for (const value of lightningValues) score += value;
    return score;
  }

  /*
  功能
  计算 canonical Action 的经济项、state delta、transition option 与基础 Final Utility。

  调用方
  Searcher candidate evaluation path。

  输入
  runtime StateValue、动作、actor、before/after、horizon depth、resolution query 与父 SearchBudget。

  输出
  各命名 term 与 baseTransition 的普通对象。

  读取状态
  只读 before/after World 与 runtime StateValue。

  写入状态
  无。

  调用函数
  deriveTransitionOptionPoints、StateValue.transitionDelta、statePointsToUtility。

  边界与不变量
  Final Utility 公式保持不变；低于冻结门槛的 Transfer 只失去竞争资格，preference 不叠加到 state delta；
  depth 只作诊断，不缩放价值，Search Prior 不得进入。
  */
  evaluateTransition({
    stateValue,
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
    const resolutionScale = ["scout", "mutualBenefit"].includes(action.cardId)
      ? getResolutionScale()
      : 1;
    const immediate = economic * resolutionScale;
    const stateDelta = stateValue.transitionDelta(
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
    const transferPreference = action?.type === "card" && action?.cardId === "transfer"
      ? this.evaluateTransferAction(action, player, beforeState)
      : null;
    const transferCompetitive = transferPreference === null
      || transferPreference.score >= MIN_TRANSFER_UTILITY;
    return {
      economic,
      resolutionScale,
      immediate,
      stateDelta,
      stateDeltaValue,
      transitionOptionPoints,
      transitionOptionValue,
      transferPreference,
      depth,
      baseTransition:transferCompetitive
        ? immediate + stateDeltaValue + transitionOptionValue
        : Number.NEGATIVE_INFINITY
    };
  }

  /*
  功能
  按根 Transfer 冻结偏好或 Final Utility 的唯一语义比较两个完整候选。

  调用方
  Searcher incumbent、beam protection 与 final selection。

  输入
  含 valueScore 或 transitionValue 的两个完整候选。

  输出
  left 更优返回正数，right 更优返回负数，完全等价返回零。

  读取状态
  候选根 Transfer preference、Final Utility 与 canonical root Action type。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  两个根 Transfer 先保持旧 contextual winner；Transfer 与其它动作仍比较 Final Utility；
  Final Utility 机器精度同分时稳定优先 skill-root，Searcher、Pattern、Search Prior 与随机数不得定义另一套偏好。
  */
  compareCandidates(left, right) {
    if (left?.transferPreference && right?.transferPreference) {
      const transferOrder = compareTransferPreferences(
        left.transferPreference,
        right.transferPreference
      );
      if (transferOrder) return transferOrder;
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
    if (left?.action?.type === "skill" && right?.action?.type === "card") return 1;
    if (left?.action?.type === "card" && right?.action?.type === "skill") return -1;
    return 0;
  }

  /*
  功能
  把基础转移、terminal held option 与窥隙信息选项组合为唯一 Final Transition Utility。

  调用方
  Searcher sibling finalization。

  输入
  HP-equivalent base/frontier value 与 raw State points 的窥隙选项。

  输出
  当前候选的 Final Utility。

  读取状态
  无。

  写入状态
  无。

  调用函数
  statePointsToUtility。

  边界与不变量
  responseNet 已包含在 state delta 中而不再相加；Search Prior 与 Pattern 不进入公式。
  */
  composeTransitionValue({
    baseTransition,
    frontierValue = 0,
    spyGapInformationValue = 0
  }) {
    return baseTransition + frontierValue
      + statePointsToUtility(spyGapInformationValue);
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
}
