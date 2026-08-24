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
import { cardAvailability, getBaseCardAiValue, roleCardDelta } from "./CardValue.js";
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
  ResourceValueQuery：把长期资产先验与当前已兑现装备效果分离。

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
  Final Utility 公式与迁移前完全相同；depth 只作诊断，不缩放价值；Search Prior 不得进入。
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
    return {
      economic,
      resolutionScale,
      immediate,
      stateDelta,
      stateDeltaValue,
      transitionOptionPoints,
      transitionOptionValue,
      depth,
      baseTransition:immediate + stateDeltaValue + transitionOptionValue
    };
  }

  /*
  功能
  按 Final Utility 与唯一机器精度同分语义比较两个完整候选。

  调用方
  Searcher incumbent、beam protection 与 final selection。

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
  Final Utility 始终先比较；只在机器精度同分时稳定优先 skill-root；
  Searcher、Pattern、Search Prior 与随机数不得定义另一套偏好。
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
