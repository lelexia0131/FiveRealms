/*
模块职责
唯一拥有 State Value、Transition Value、terminal frontier 与候选比较语义。

上游
StateValue runtime adapter、Searcher、ValueLedger 与测试。

下游
Economics、CardValue、ThreatValue、GlobalBenefitValue、封印 value 与 canonical Probability。

状态边界
只读 Fact/World、canonical Action 和显式传入的领域值；不持有 Game，不写状态。

信息边界
只使用公开字段、合法概率摘要与 viewer 自身的可见卡牌身份。

架构约束
不得导入或构造 Simulator、Searcher、Controller；不得搜索、生成动作或消费 Search Prior。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import {
  PROBABILITY_EPSILON,
  buildRadarJudgmentProbabilities,
  clampProbability,
  probabilityFromCurrentCounts,
  queryCurrentCardCounts,
  queryPlayerHandProbability
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
import { mutualBenefitDraftValues } from "./GlobalBenefitValue.js";
import {
  DANGER_VALUE,
  DEATH_VALUE,
  exposureComponents,
  hp2ThreatRiskValue,
  incomingExposure,
  radarMitigationUtility,
  shieldStateValue,
  ThreatCalculator
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
  把公开目标威胁转换为唯一的目标 preference primitive。

  调用方
  SearchPrior exploration 与 ResponseBoundary leverage decision context。

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
