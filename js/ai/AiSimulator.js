/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260814-guardian-aid-certain-hand";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260814-guardian-aid-certain-hand";
import { RuleEngine } from "../core/RuleEngine.js?build=20260814-guardian-aid-certain-hand";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260814-guardian-aid-certain-hand";
import { ACTIVE_SKILLS, getActiveSkillCost } from "../generals/skillRegistry.js?build=20260814-guardian-aid-certain-hand";
import { getLightningStatusStateBranches, lightningPresenceProbability } from "./lightningScoring.js?build=20260814-guardian-aid-certain-hand";
import { getSealStatusStateBranches, sealPresenceProbability } from "./sealScoring.js?build=20260814-guardian-aid-certain-hand";
import {
  counterOpportunityCost,
  globalBenefitCounterDesire,
  mutualBenefitDraftValues
} from "./AiGlobalBenefit.js?build=20260814-guardian-aid-certain-hand";
import { HP_VALUE } from "./AiEconomics.js?build=20260814-guardian-aid-certain-hand";
import { chooseBestResourceHandCandidate, chooseResourceZone } from "./resourceSelectionValue.js?build=20260814-guardian-aid-certain-hand";
import { getBaseCardAiValue, getRoleCardAiValue } from "./roleCardValue.js?build=20260814-guardian-aid-certain-hand";
import { getDiscardKeepValue } from "./discardScoring.js?build=20260814-guardian-aid-certain-hand";
import {
  PROBABILITY_EPSILON,
  RADAR_BASIC_DEFINITIONS as RADAR_BASIC_DEFINITION_IDS,
  availableBranchesFromState,
  buildRadarJudgmentProbabilities,
  expectedBranchValue,
  getAvailabilityBranches,
  getAvailabilityStateBranches,
  getValueBranches,
  joinProbabilityStateBranches,
  mergeProbabilityStateBranches,
  probabilityEventPartition,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "./AiProbabilityBranches.js?build=20260814-guardian-aid-certain-hand";

const BASIC_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0);
const EQUIPMENT_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment").reduce((sum, card) => sum + card.count, 0);
const BLOCK_CARD_COUNT = CARD_DEFINITIONS.block.count;
const OTHER_BASIC_CARD_COUNT = BASIC_CARD_COUNT - BLOCK_CARD_COUNT;
const fixedCardDensity = (definitionId) => (CARD_DEFINITIONS[definitionId]?.count ?? 0) / TOTAL_CARD_COUNT;

const remainingCardDensity = (remainingCardCounts, definitionId) => {
  if (!remainingCardCounts || typeof remainingCardCounts !== "object" || Array.isArray(remainingCardCounts)) {
    return fixedCardDensity(definitionId);
  }
  let total = 0;
  for (const count of Object.values(remainingCardCounts)) {
    if (Number.isFinite(count)) total += Math.max(0, count);
  }
  if (total <= 0) return 0;
  const count = Number(remainingCardCounts[definitionId]);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.max(0, Math.min(1, count / total));
};

const fixedRadarJudgmentProbabilities = () => ({
  block: BLOCK_CARD_COUNT / TOTAL_CARD_COUNT,
  otherBasic: OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT,
  equipment: EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT
});

const remainingRadarJudgmentProbabilities = (remainingCardCounts) => {
  if (!remainingCardCounts || typeof remainingCardCounts !== "object" || Array.isArray(remainingCardCounts)) {
    return fixedRadarJudgmentProbabilities();
  }
  const positiveCounts = {};
  let total = 0;
  for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) continue;
    positiveCounts[definitionId] = value;
    total += value;
  }
  if (total <= 0) return { block:0, otherBasic:0, equipment:0 };
  let block = 0;
  let otherBasic = 0;
  let equipment = 0;
  for (const [definitionId, count] of Object.entries(positiveCounts)) {
    const definition = CARD_DEFINITIONS[definitionId];
    if (!definition) continue;
    if (definitionId === "block") block += count;
    else if (definition.category === "basic") otherBasic += count;
    else if (definition.category === "equipment") equipment += count;
  }
  return {
    block: Math.max(0, Math.min(1, block / total)),
    otherBasic: Math.max(0, Math.min(1, otherBasic / total)),
    equipment: Math.max(0, Math.min(1, equipment / total))
  };
};
const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const unionProbability = (oldProbability, newProbability) => 1
  - (1 - clampProbability(oldProbability)) * (1 - clampProbability(newProbability));

export class AiSimulator {
  constructor(visibleState) {
    this.initial = structuredClone(visibleState);
    this.initializeEquipmentBaselines(this.initial);
    this.initializeAssaultSummaries(this.initial);
    this.initializeBlockCountDistributions(this.initial);
    this.initializeCounterCountDistributions(this.initial);
    this.initializeMomentumBranches(this.initial);
    // root 结算模拟守卫：目标级 root 的 apply 群伤循环会再次调用 counterDesire，避免递归。
    this._simulatingRootResolution = false;
  }

  clone(state = this.initial) {
    const cloned = structuredClone(state);
    this.initializeEquipmentBaselines(cloned);
    this.initializeBlockCountDistributions(cloned);
    this.initializeCounterCountDistributions(cloned);
    this.initializeMomentumBranches(cloned);
    this.syncActiveSkillCosts(cloned);
    return cloned;
  }

  /** 连势必须保留防御结果的条件键；只存期望标量会让后续突袭把加伤摊到错误世界。 */
  initializeMomentumBranches(state) {
    for (const player of state?.players ?? []) {
      if (player.generalId !== "blade-walker") continue;
      if (!Array.isArray(player.momentumBranches) || !player.momentumBranches.length) {
        player.momentumBranches = [{
          probability:1,
          conditions:{},
          amount:Math.max(0, Math.min(GAME_CONFIG.momentumMaxStacks, Number(player.momentum) || 0))
        }];
      }
      this.syncMomentumSummary(player);
      player.categoryUsedStateBranchesByCategory ??= {};
      player.categoryUsedProbabilities ??= {};
      player.categoriesUsed ??= [];
      for (const category of ["basic", "tactic", "equipment"]) {
        if (!Array.isArray(player.categoryUsedStateBranchesByCategory[category])
          || !player.categoryUsedStateBranchesByCategory[category].length) {
          const usedProbability = clampProbability(player.categoryUsedProbabilities[category]
            ?? (player.categoriesUsed.includes(category) ? 1 : 0));
          player.categoryUsedStateBranchesByCategory[category] = usedProbability <= PROBABILITY_EPSILON
            ? [{ probability:1, conditions:{}, used:false }]
            : usedProbability >= 1 - PROBABILITY_EPSILON
              ? [{ probability:1, conditions:{}, used:true }]
              : [
                  { probability:usedProbability, conditions:{}, used:true },
                  { probability:1 - usedProbability, conditions:{}, used:false }
                ];
        }
        this.syncCategoryUsedSummary(player, category);
      }
    }
  }

  syncMomentumSummary(player) {
    player.momentumBranches = projectProbabilityStateBranches(
      getValueBranches(player, "momentum", player.momentum),
      (branch) => ({
        amount:Math.max(0, Math.min(GAME_CONFIG.momentumMaxStacks, Number(branch.amount) || 0))
      })
    );
    player.momentum = expectedBranchValue(player.momentumBranches);
    return player.momentumBranches;
  }

  syncCategoryUsedSummary(player, category) {
    const branches = mergeProbabilityStateBranches(
      player.categoryUsedStateBranchesByCategory?.[category] ?? []
    );
    player.categoryUsedStateBranchesByCategory[category] = branches;
    const probability = totalBranchProbability(branches.filter((branch) => branch.used));
    player.categoryUsedProbabilities[category] = probability;
    const index = player.categoriesUsed.indexOf(category);
    if (probability >= 1 - PROBABILITY_EPSILON && index < 0) player.categoriesUsed.push(category);
    else if (probability < 1 - PROBABILITY_EPSILON && index >= 0) player.categoriesUsed.splice(index, 1);
    return branches;
  }

  /** 克隆或结算后按当前技能定义重新同步每个玩家的主动技能成本，供后续动作与机会成本评估共用。 */
  syncActiveSkillCosts(state) {
    for (const player of state?.players ?? []) {
      const skill = ACTIVE_SKILLS[player.activeSkillId];
      if (skill) player.activeSkillCost = getActiveSkillCost(state, player, skill);
    }
  }

  initializeEquipmentBaselines(state) {
    for (const player of state?.players ?? []) {
      if (!Object.hasOwn(player, "initialEquipmentValue")) {
        player.initialEquipmentValue = player.equipmentDefinitionId
          ? (CARD_DEFINITIONS[player.equipmentDefinitionId]?.aiValue ?? 7)
          : 0;
      }
      if (!Object.hasOwn(player, "initialEquipmentRoleDelta")) {
        player.initialEquipmentRoleDelta = player.equipmentDefinitionId
          ? this.equipmentRoleDelta(player, player.equipmentDefinitionId)
          : 0;
      }
    }
  }

  /** 角色对装备卡牌相对全局基础值的差量；缺少 generalId 或 definitionId 时回退 0。 */
  equipmentRoleDelta(player, definitionId) {
    if (!player?.generalId || !definitionId) return 0;
    return getRoleCardAiValue(player.generalId, definitionId) - getBaseCardAiValue(definitionId);
  }

  initializeAssaultSummaries(state) {
    for (const player of state?.players ?? []) this.syncAssaultSummary(player);
  }

  /** 初始化或保留每个玩家的格挡数量分布；分布是后续 blockProbability 的唯一来源。 */
  initializeBlockCountDistributions(state) {
    for (const player of state?.players ?? []) {
      if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
        player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, state?.remainingCardCounts ?? null);
      }
      this.syncBlockSummary(player);
    }
  }

  /** 为缺少分布的旧快照/测试状态构造兼容初始分布；生产可见状态始终自带分布。 */
  buildInitialBlockCountDistribution(player, remainingCardCounts = null) {
    const explicit = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ].filter((card) => card?.definitionId === "block")
      .reduce((sum, card) => sum + this.cardAvailability(card), 0);
    if (explicit > PROBABILITY_EPSILON
      && Math.abs(Number(player.handCount ?? 0) - explicit) < PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, blockCount:Math.max(0, Math.round(explicit)) }];
    }
    if (explicit > PROBABILITY_EPSILON) {
      return this.cardEstimateDistribution(player, "block", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, blockCount:branch.count }));
    }
    if (player.blockProbability == null) {
      return this.cardEstimateDistribution(player, "block", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, blockCount:branch.count }));
    }
    const blockProbability = clampProbability(player.blockProbability ?? 0);
    const twoBlockProbability = clampProbability(player.twoBlockProbability ?? 0);
    if (blockProbability <= PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, blockCount:0 }];
    }
    if (twoBlockProbability >= 1 - PROBABILITY_EPSILON) {
      const count = Math.max(2, Math.ceil(Number(player.handCount) || 0));
      return [{ probability:1, conditions:{}, blockCount:count }];
    }
    const branches = [
      { probability:Math.max(0, 1 - blockProbability), conditions:{}, blockCount:0 },
      { probability:Math.max(0, blockProbability - twoBlockProbability), conditions:{}, blockCount:1 },
      { probability:twoBlockProbability, conditions:{}, blockCount:2 }
    ].filter((branch) => branch.probability > PROBABILITY_EPSILON);
    const total = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return total > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / total }))
      : [{ probability:1, conditions:{}, blockCount:0 }];
  }

  /** 把格挡数量分布同步为 blockProbability / twoBlockProbability，并规范化分布。 */
  syncBlockSummary(player) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = [{ probability:1, conditions:{}, blockCount:0 }];
    }
    const branches = mergeProbabilityStateBranches(
      player.blockCountDistribution.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        blockCount:Math.max(0, Math.floor(Number(branch.blockCount ?? branch.count) || 0))
      }))
    );
    player.blockCountDistribution = branches;
    player.blockProbability = branches.reduce(
      (sum, branch) => sum + (branch.blockCount >= 1 ? branch.probability : 0), 0
    );
    player.twoBlockProbability = branches.reduce(
      (sum, branch) => sum + (branch.blockCount >= 2 ? branch.probability : 0), 0
    );
    return branches;
  }

  /** 返回可用于 joinProbabilityStateBranches 的格挡数量状态分支。 */
  getBlockCountBranches(player, remainingCardCounts = null) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    return this.syncBlockSummary(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      blockCount:branch.blockCount
    }));
  }

  /**
   * 构造每个条件世界中的确定格挡数量。
   * 只统计 hand / knownCards 中 definitionId === "block" 的身份，
   * 按 availabilityStateBranches 逐张累加，不修改状态、不生成新随机事件。
   */
  getKnownBlockCountBranches(player) {
    const cards = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "block") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "block") : [])
    ];
    let branches = [{ probability:1, conditions:{}, knownBlockCount:0 }];
    for (const card of cards) {
      const availabilityState = getAvailabilityStateBranches(card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(branches, availabilityState);
      branches = projectProbabilityStateBranches(joined, (branch) => ({
        knownBlockCount:branch.knownBlockCount + (branch.available ? 1 : 0)
      }));
    }
    return branches;
  }

  /** 确保玩家拥有合法格挡分布；已有分布不会被覆盖。 */
  ensureBlockCountDistribution(player, remainingCardCounts = null) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    return this.syncBlockSummary(player);
  }

  /** 初始化或保留每个玩家的反制数量分布；分布是后续 counterProbability 的唯一来源。 */
  initializeCounterCountDistributions(state) {
    for (const player of state?.players ?? []) {
      if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
        player.counterCountDistribution = this.buildInitialCounterCountDistribution(
          player, state?.remainingCardCounts ?? null
        );
      }
      this.syncCounterSummary(player);
    }
  }

  /** 为缺少反制分布的旧快照/测试状态构造兼容初始分布。 */
  buildInitialCounterCountDistribution(player, remainingCardCounts = null) {
    if (Array.isArray(player.hand)) {
      // 当前 AI 自己拥有完整 hand：反制数量可直接由具体身份确定，不再按根密度估算。
      const explicitCount = player.hand.filter((card) => card?.definitionId === "counter")
        .reduce((sum, card) => sum + this.cardAvailability(card), 0);
      return [{ probability:1, conditions:{}, counterCount:Math.max(0, Math.round(explicitCount)) }];
    }
    const explicit = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ].filter((card) => card?.definitionId === "counter")
      .reduce((sum, card) => sum + this.cardAvailability(card), 0);
    if (explicit > PROBABILITY_EPSILON
      && Math.abs(Number(player.handCount ?? 0) - explicit) < PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, counterCount:Math.max(0, Math.round(explicit)) }];
    }
    if (explicit > PROBABILITY_EPSILON) {
      return this.cardEstimateDistribution(player, "counter", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, counterCount:branch.count }));
    }
    if (player.counterProbability == null) {
      return this.cardEstimateDistribution(player, "counter", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, counterCount:branch.count }));
    }
    const counterProbability = clampProbability(player.counterProbability ?? 0);
    if (counterProbability <= PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, counterCount:0 }];
    }
    const branches = [
      { probability:Math.max(0, 1 - counterProbability), conditions:{}, counterCount:0 },
      { probability:counterProbability, conditions:{}, counterCount:1 }
    ].filter((branch) => branch.probability > PROBABILITY_EPSILON);
    const total = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return total > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / total }))
      : [{ probability:1, conditions:{}, counterCount:0 }];
  }

  /** 把反制数量分布同步为 counterProbability（P(count >= 1)），并规范化分布。 */
  syncCounterSummary(player) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
    }
    const branches = mergeProbabilityStateBranches(
      player.counterCountDistribution.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        counterCount:Math.max(0, Math.floor(Number(branch.counterCount ?? branch.count) || 0))
      }))
    );
    player.counterCountDistribution = branches;
    const counterProbability = Math.max(0, Math.min(1, branches.reduce(
      (sum, branch) => sum + (branch.counterCount >= 1 ? branch.probability : 0), 0
    )));
    player.counterProbability = counterProbability >= 1 - PROBABILITY_EPSILON
      ? 1
      : counterProbability <= PROBABILITY_EPSILON ? 0 : counterProbability;
    return branches;
  }

  /** 返回可用于 joinProbabilityStateBranches 的反制数量状态分支。 */
  getCounterCountBranches(player, remainingCardCounts = null) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    return this.syncCounterSummary(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      counterCount:branch.counterCount
    }));
  }

  /** 构造每个条件世界中的确定反制数量；只统计 counter 身份可用性，不生成新随机事件。 */
  getKnownCounterCountBranches(player) {
    const cards = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "counter") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "counter") : [])
    ];
    let branches = [{ probability:1, conditions:{}, knownCounterCount:0 }];
    for (const card of cards) {
      const availabilityState = getAvailabilityStateBranches(card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(branches, availabilityState);
      branches = projectProbabilityStateBranches(joined, (branch) => ({
        knownCounterCount:branch.knownCounterCount + (branch.available ? 1 : 0)
      }));
    }
    return branches;
  }

  /** 确保玩家拥有合法反制分布；已有分布不会被覆盖。 */
  ensureCounterCountDistribution(player, remainingCardCounts = null) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    return this.syncCounterSummary(player);
  }

  /** 手牌清空后反制容量与身份必须同步归零，避免“count>0 但无牌可持”的幽灵状态。 */
  clearCountersWhenHandEmpty(player) {
    if (!player || (player.handCount ?? 0) > PROBABILITY_EPSILON) return;
    player.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
    if (Array.isArray(player.hand)) {
      player.hand = player.hand.filter((card) => card.definitionId !== "counter");
    }
    if (Array.isArray(player.knownCards)) {
      player.knownCards = player.knownCards.filter((entry) => entry.definitionId !== "counter");
    }
    this.syncCounterSummary(player);
  }

  /** 在实际获得确定反制的世界中，让反制数量 +1。 */
  addKnownCounterToDistribution(state, player, gainWorlds) {
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(counterState, partition);
    player.counterCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      counterCount:branch.counterCount + (branch.gained ? 1 : 0)
    }));
    this.syncCounterSummary(player);
  }

  /** 匿名反制容量转移：只按来源共享世界为接收者 +1，不加入根先验、不创建身份。 */
  addTransferredCounterCapacity(state, player, transferWorlds) {
    if (!player || !Array.isArray(transferWorlds) || !transferWorlds.length) return;
    this.addKnownCounterToDistribution(state, player, transferWorlds);
  }

  /** 在实际失去确定反制的世界中，让反制数量 -1，且不低于 0。 */
  removeKnownCounterFromDistribution(state, player, removalWorlds) {
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = removalWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      removed:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(counterState, partition);
    player.counterCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      counterCount:Math.max(0, branch.counterCount - (branch.removed ? 1 : 0))
    }));
    this.syncCounterSummary(player);
  }

  /** 只为真正新增的匿名牌叠加一次根先验，不对旧手牌重新抽样。 */
  addOneUnknownCardToCounterDistribution(state, player, gainWorlds) {
    const density = remainingCardDensity(state?.remainingCardCounts, "counter");
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(counterState, partition);
    const outcomes = [];
    for (const branch of joined) {
      if (branch.gained && density > 0) {
        outcomes.push({
          probability:branch.probability * (1 - density),
          conditions:branch.conditions,
          counterCount:branch.counterCount
        });
        outcomes.push({
          probability:branch.probability * density,
          conditions:branch.conditions,
          counterCount:branch.counterCount + 1
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:branch.counterCount
        });
      }
    }
    player.counterCountDistribution = mergeProbabilityStateBranches(outcomes);
    this.syncCounterSummary(player);
  }

  /**
   * 统一匿名摸牌入口：只增加 handCount，并对每张真正新获得的匿名牌叠加一次
   * 反制根先验。整数张数复用同一个“摸牌事件是否发生”世界（同发生同不发生）；
   * 非整数期望通过事件 gate 表示“是否获得最后一张”，不增加半张牌容量。
   * amount 也可以传函数：按每个条件世界各自应摸张数摸牌，摸牌数与对应的
   * energyAmount/发动条件世界保持关联，不能用全局期望值重新独立抽样。
   * @returns {number} 实际获得的期望牌数
   */
  gainUnknownCardsWithCounterState(state, player, amount, eventWorlds = null, label = "unknown-draw") {
    if (!player) return 0;
    if (typeof amount !== "function" && amount <= PROBABILITY_EPSILON) return 0;
    const worlds = Array.isArray(eventWorlds) && eventWorlds.length
      ? eventWorlds
      : this.getEventWorlds(state, 1, null, label);
    const eventMass = this.eventProbability(worlds);
    if (eventMass <= PROBABILITY_EPSILON) return 0;
    if (typeof amount === "function") {
      const remainingByBranch = worlds.map((branch) => (
        branch.occurs ? Math.max(0, Number(amount(branch)) || 0) : 0
      ));
      let gained = 0;
      while (remainingByBranch.some((remaining) => remaining > PROBABILITY_EPSILON)) {
        const cardWorlds = [];
        for (let index = 0; index < worlds.length; index += 1) {
          const branch = worlds[index];
          const remaining = remainingByBranch[index];
          if (remaining <= PROBABILITY_EPSILON) {
            cardWorlds.push({ ...branch, occurs:false });
            continue;
          }
          const cardProbability = Math.min(1, remaining);
          if (cardProbability >= 1 - PROBABILITY_EPSILON) {
            cardWorlds.push({ ...branch, occurs:true });
          } else {
            const gate = probabilityEventPartition(
              this.nextProbabilityEventKey(state, `${label}:branch-card`),
              cardProbability,
              "gateOccurs"
            );
            for (const gated of joinProbabilityStateBranches([branch], gate)) {
              cardWorlds.push({ ...gated, occurs:Boolean(gated.gateOccurs) });
            }
          }
        }
        const cardGain = this.eventProbability(cardWorlds);
        if (cardGain <= PROBABILITY_EPSILON) break;
        player.handCount = (player.handCount ?? 0) + cardGain;
        this.addOneUnknownCardToCounterDistribution(state, player, cardWorlds);
        gained += cardGain;
        for (let index = 0; index < remainingByBranch.length; index += 1) {
          remainingByBranch[index] -= Math.min(1, remainingByBranch[index]);
        }
      }
      return gained;
    }
    let remaining = Math.max(0, Number(amount) || 0);
    let gained = 0;
    while (remaining > PROBABILITY_EPSILON) {
      const cardProbability = Math.min(1, remaining);
      const gateChance = Math.min(1, cardProbability / eventMass);
      const cardWorlds = gateChance >= 1 - PROBABILITY_EPSILON
        ? worlds
        : this.gateEventWorlds(state, worlds, gateChance, `${label}:card`);
      const cardGain = this.eventProbability(cardWorlds);
      if (cardGain <= PROBABILITY_EPSILON) break;
      player.handCount = (player.handCount ?? 0) + cardGain;
      this.addOneUnknownCardToCounterDistribution(state, player, cardWorlds);
      gained += cardGain;
      remaining -= cardProbability;
    }
    return gained;
  }

  /** 在实际获得确定格挡的世界中，让格挡数量 +1。 */
  addKnownBlockToDistribution(state, player, gainWorlds) {
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(blockState, partition);
    player.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:branch.blockCount + (branch.gained ? 1 : 0)
    }));
    this.syncBlockSummary(player);
  }

  /** 在实际失去确定格挡的世界中，让格挡数量 -1，且不低于 0。 */
  removeKnownBlockFromDistribution(state, player, removalWorlds) {
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = removalWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      removed:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(blockState, partition);
    player.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:Math.max(0, branch.blockCount - (branch.removed ? 1 : 0))
    }));
    this.syncBlockSummary(player);
  }

  /** 只为真正新增的匿名牌叠加一次根先验，不对旧手牌重新抽样。 */
  addOneUnknownCardToBlockDistribution(state, player, gainWorlds) {
    const density = remainingCardDensity(state?.remainingCardCounts, "block");
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(blockState, partition);
    const outcomes = [];
    for (const branch of joined) {
      if (branch.gained && density > 0) {
        outcomes.push({
          probability:branch.probability * (1 - density),
          conditions:branch.conditions,
          blockCount:branch.blockCount
        });
        outcomes.push({
          probability:branch.probability * density,
          conditions:branch.conditions,
          blockCount:branch.blockCount + 1
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:branch.blockCount
        });
      }
    }
    player.blockCountDistribution = mergeProbabilityStateBranches(outcomes);
    this.syncBlockSummary(player);
  }

  /**
   * 从当前格挡分布中按无放回条件概率移除匿名牌。
   * 只返回“实际移除”的世界，来源与接收者可共享同一组 blockRemoved 条件。
   */
  removeUnknownCardsFromBlockDistribution(
    state,
    player,
    expectedAmount,
    unknownCount,
    eventWorlds = null,
    label = "unknown-removal",
    adjustHandCount = true
  ) {
    this.ensureBlockCountDistribution(player, state?.remainingCardCounts ?? null);
    const unknown = Math.max(0, Number(unknownCount) || 0);
    const spent = Math.min(
      Math.max(0, Number(expectedAmount) || 0),
      unknown,
      Math.max(0, Number(player.handCount) || 0)
    );
    if (spent <= PROBABILITY_EPSILON || unknown <= 0) return { removed:0, identityWorlds:[] };
    const eventProbabilityValue = Array.isArray(eventWorlds) && eventWorlds.length
      ? this.eventProbability(eventWorlds)
      : 1;
    const removalProbability = eventProbabilityValue > 0
      ? Math.min(1, spent / eventProbabilityValue)
      : 0;
    let removalWorlds;
    if (Array.isArray(eventWorlds) && eventWorlds.length) {
      // 在效果世界内部按 spent 缩放“实际移除”事件，保证返回的移除期望等于 spent。
      removalWorlds = this.gateEventWorlds(state, eventWorlds, removalProbability, `${label}:gate`);
    } else {
      removalWorlds = probabilityEventPartition(
        this.nextProbabilityEventKey(state, label),
        removalProbability,
        "occurs"
      );
    }
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const knownState = this.getKnownBlockCountBranches(player);
    const joined = joinProbabilityStateBranches(blockState, removalWorlds, knownState);
    const outcomes = [];
    for (const branch of joined) {
      const total = branch.blockCount;
      const known = branch.knownBlockCount;
      const anonymousBlocks = Math.max(0, Math.min(unknown, total - known));
      const occurs = Boolean(branch.occurs);
      if (occurs && anonymousBlocks > 0) {
        const removalChance = Math.min(1, anonymousBlocks / unknown);
        outcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          blockCount:Math.max(0, total - 1),
          occurs:true,
          blockRemoved:true
        });
        outcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          blockCount:total,
          occurs:true,
          blockRemoved:false
        });
      } else if (occurs) {
        // 移除事件发生，但该世界没有匿名格挡可移除，移除的是匿名非格挡。
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:total,
          occurs:true,
          blockRemoved:false
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:total,
          occurs:false,
          blockRemoved:false
        });
      }
    }
    player.blockCountDistribution = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        blockCount:branch.blockCount
      }))
    );
    this.syncBlockSummary(player);
    const identityWorlds = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.occurs,
        blockRemoved:branch.blockRemoved
      }))
    );
    let removed = totalBranchProbability(identityWorlds.filter((branch) => branch.occurs));
    if (Math.abs(removed - spent) <= PROBABILITY_EPSILON * 1e3) removed = spent;
    if (adjustHandCount) player.handCount = Math.max(0, (player.handCount ?? 0) - removed);
    return { removed, identityWorlds };
  }

  /**
   * 从当前反制分布中按无放回条件概率移除匿名牌。
   * 与格挡移除共享同一组“实际移除”条件世界；只更新反制容量，不重复扣减 handCount。
   * @returns {{removed:number, identityWorlds:Array}} 实际移除的反制期望与带 counterRemoved 的世界。
   */
  removeUnknownCardsFromCounterDistribution(
    state,
    player,
    expectedAmount,
    unknownCount,
    eventWorlds = null,
    label = "unknown-counter-removal",
    adjustHandCount = true
  ) {
    this.ensureCounterCountDistribution(player, state?.remainingCardCounts ?? null);
    const unknown = Math.max(0, Number(unknownCount) || 0);
    const spent = Math.min(
      Math.max(0, Number(expectedAmount) || 0),
      unknown,
      Math.max(0, Number(player.handCount) || 0)
    );
    if (spent <= PROBABILITY_EPSILON || unknown <= 0) return { removed:0, identityWorlds:[] };
    const eventProbabilityValue = Array.isArray(eventWorlds) && eventWorlds.length
      ? this.eventProbability(eventWorlds)
      : 1;
    const removalProbability = eventProbabilityValue > 0
      ? Math.min(1, spent / eventProbabilityValue)
      : 0;
    let removalWorlds;
    if (Array.isArray(eventWorlds) && eventWorlds.length) {
      removalWorlds = this.gateEventWorlds(state, eventWorlds, removalProbability, `${label}:gate`);
    } else {
      removalWorlds = probabilityEventPartition(
        this.nextProbabilityEventKey(state, label),
        removalProbability,
        "occurs"
      );
    }
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const knownState = this.getKnownCounterCountBranches(player);
    const joined = joinProbabilityStateBranches(counterState, removalWorlds, knownState);
    const outcomes = [];
    for (const branch of joined) {
      const total = branch.counterCount;
      const known = branch.knownCounterCount;
      const anonymousCounters = Math.max(0, Math.min(unknown, total - known));
      const occurs = Boolean(branch.occurs);
      if (occurs && anonymousCounters > 0) {
        const removalChance = Math.min(1, anonymousCounters / unknown);
        outcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          counterCount:Math.max(0, total - 1),
          occurs:true,
          counterRemoved:true
        });
        outcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          counterCount:total,
          occurs:true,
          counterRemoved:false
        });
      } else if (occurs) {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:total,
          occurs:true,
          counterRemoved:false
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:total,
          occurs:false,
          counterRemoved:false
        });
      }
    }
    player.counterCountDistribution = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        counterCount:branch.counterCount
      }))
    );
    this.syncCounterSummary(player);
    const identityWorlds = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.occurs,
        counterRemoved:branch.counterRemoved
      }))
    );
    let removed = totalBranchProbability(identityWorlds.filter((branch) => branch.occurs));
    if (Math.abs(removed - spent) <= PROBABILITY_EPSILON * 1e3) removed = spent;
    if (adjustHandCount) player.handCount = Math.max(0, (player.handCount ?? 0) - removed);
    return { removed, identityWorlds };
  }

  /** 匿名牌转移：来源与接收者共享同一组“是否格挡/反制”条件世界。 */
  transferUnknownBlockCapacity(state, source, receiver, effectWorlds, unknownCount) {
    const { removed, identityWorlds } = this.removeUnknownCardsFromBlockDistribution(
      state,
      source,
      this.eventProbability(effectWorlds),
      unknownCount,
      effectWorlds,
      "transfer-unknown",
      false
    );
    if (removed <= PROBABILITY_EPSILON) return 0;
    this.downgradePartialKnownCardsAfterRandomLoss(source);
    const blockState = this.getBlockCountBranches(receiver, state?.remainingCardCounts ?? null);
    const joined = joinProbabilityStateBranches(blockState, identityWorlds);
    receiver.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:branch.blockCount + (branch.occurs && branch.blockRemoved ? 1 : 0)
    }));
    this.syncBlockSummary(receiver);
    const counterRemoval = this.removeUnknownCardsFromCounterDistribution(
      state,
      source,
      removed,
      unknownCount,
      identityWorlds,
      "transfer-unknown-counter",
      false
    );
    source.handCount = Math.max(0, (source.handCount ?? 0) - removed);
    this.clearCountersWhenHandEmpty(source);
    const counterState = this.getCounterCountBranches(receiver, state?.remainingCardCounts ?? null);
    const joinedCounter = joinProbabilityStateBranches(counterState, counterRemoval.identityWorlds);
    receiver.counterCountDistribution = projectProbabilityStateBranches(joinedCounter, (branch) => ({
      counterCount:branch.counterCount + (branch.occurs && branch.counterRemoved ? 1 : 0)
    }));
    this.syncCounterSummary(receiver);
    receiver.handCount = (receiver.handCount ?? 0) + removed;
    this.syncCardEstimates(source, state?.remainingCardCounts);
    this.syncCardEstimates(receiver, state?.remainingCardCounts);
    return removed;
  }

  nextProbabilityEventKey(state, label = "event") {
    state.probabilityEventCounter = Math.max(0, Number(state.probabilityEventCounter) || 0) + 1;
    return `simulation:${label}:${state.probabilityEventCounter}`;
  }

  getEventWorlds(state, probability = 1, suppliedBranches = null, label = "event") {
    if (Array.isArray(suppliedBranches) && suppliedBranches.length) {
      return projectProbabilityStateBranches(suppliedBranches, (branch) => ({
        occurs:Boolean(branch.occurs ?? branch.executes)
      }));
    }
    return probabilityEventPartition(
      this.nextProbabilityEventKey(state, label),
      probability,
      "occurs"
    );
  }

  gateEventWorlds(state, eventWorlds, chance, label = "gate") {
    const probability = clampProbability(chance);
    if (probability >= 1 - PROBABILITY_EPSILON) return eventWorlds;
    if (probability <= PROBABILITY_EPSILON) {
      return projectProbabilityStateBranches(eventWorlds, () => ({ occurs:false }));
    }
    const gate = probabilityEventPartition(
      this.nextProbabilityEventKey(state, label), probability, "gateOccurs"
    );
    return projectProbabilityStateBranches(
      joinProbabilityStateBranches(eventWorlds, gate),
      (branch) => ({ occurs:Boolean(branch.occurs && branch.gateOccurs) })
    );
  }

  eventProbability(eventWorlds) {
    return totalBranchProbability((eventWorlds ?? []).filter((branch) => branch.occurs));
  }

  updateEnergyFromWorlds(player, worldBranches, transformer) {
    const energy = getValueBranches(player, "energy", player.energy).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      energyAmount:branch.amount
    }));
    const joined = joinProbabilityStateBranches(energy, worldBranches);
    player.energyBranches = projectProbabilityStateBranches(joined, (branch) => ({
      amount:Math.max(0, Math.min(player.maxEnergy ?? Infinity,
        Number(transformer(branch.energyAmount, branch)) || 0))
    }));
    player.energy = expectedBranchValue(player.energyBranches);
    return joined;
  }

  changeEnergy(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "energy");
    return this.updateEnergyFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

  updateShieldFromWorlds(player, worldBranches, transformer) {
    const shield = getValueBranches(player, "shield", player.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const joined = joinProbabilityStateBranches(shield, worldBranches);
    player.shieldBranches = projectProbabilityStateBranches(joined, (branch) => ({
      amount:Math.max(0, Number(transformer(branch.shieldAmount, branch)) || 0)
    }));
    player.shield = expectedBranchValue(player.shieldBranches);
    return joined;
  }

  changeShield(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "shield");
    return this.updateShieldFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

  ensureAttackUseSlots(player) {
    if (Array.isArray(player.attackUseSlots)) return player.attackUseSlots;
    const hasLimit = Number.isFinite(Number(player.attackLimit));
    const used = Math.max(0, Number(player.attackUsed) || 0);
    const limit = hasLimit ? Math.max(0, Math.ceil(Number(player.attackLimit))) : Math.max(1, Math.ceil(used + 1));
    player.attackUseSlots = Array.from({ length:limit }, (_, index) => [{
      probability:1,
      conditions:{},
      available:index >= Math.ceil(used)
    }]);
    return player.attackUseSlots;
  }

  ensureSkillUseSlots(player, skill) {
    if (Array.isArray(player.activeSkillUseSlots)) return player.activeSkillUseSlots;
    if (Array.isArray(player.activeSkillAvailabilityBranches)) {
      player.activeSkillUseSlots = player.activeSkillAvailabilityBranches.map((availabilityBranches) => (
        getAvailabilityStateBranches({ availabilityBranches })
      ));
      return player.activeSkillUseSlots;
    }
    const uses = Math.max(0, Number(player.activeSkillUses ?? (player.activeSkillUsed ? 1 : 0)) || 0);
    const limit = Math.max(0, Math.ceil(Number(player.activeSkillLimit ?? skill?.limitPerTurn ?? 1) || 0));
    player.activeSkillUseSlots = Array.from({ length:limit }, (_, index) => [{
      probability:1,
      conditions:{},
      available:index >= Math.ceil(uses)
    }]);
    return player.activeSkillUseSlots;
  }

  consumeSlot(state, slots, desiredEventWorlds, preferredIndex = null, label = "slot") {
    const indexes = preferredIndex == null
      ? slots.map((_, index) => index)
      : [preferredIndex];
    let best = null;
    for (const index of indexes) {
      const slot = slots[index];
      if (!Array.isArray(slot)) continue;
      const slotState = mergeProbabilityStateBranches(slot).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        slotAvailable:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(desiredEventWorlds, slotState);
      const actualWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(branch.occurs && branch.slotAvailable)
      }));
      const executionProbability = this.eventProbability(actualWorlds);
      if (executionProbability <= PROBABILITY_EPSILON
        || (best && executionProbability <= best.executionProbability + PROBABILITY_EPSILON)) continue;
      best = { index, joined, eventWorlds:actualWorlds, executionProbability };
    }
    if (best) {
      slots[best.index] = projectProbabilityStateBranches(best.joined, (branch) => ({
        available:Boolean(branch.slotAvailable && !(branch.occurs && branch.slotAvailable))
      }));
      return { index:best.index, eventWorlds:best.eventWorlds };
    }
    return {
      index:null,
      eventWorlds:projectProbabilityStateBranches(desiredEventWorlds, () => ({ occurs:false }))
    };
  }

  consumeAttackUse(state, player, desiredEventWorlds, preferredIndex = null) {
    const slots = this.ensureAttackUseSlots(player);
    const consumed = this.consumeSlot(state, slots, desiredEventWorlds, preferredIndex,
      `attack-slot:${player.id}`);
    const probability = this.eventProbability(consumed.eventWorlds);
    player.attackAvailabilityBranches = slots.map(availableBranchesFromState);
    player.attackUsed = (player.attackUsed ?? 0) + probability;
    return consumed;
  }

  apply(state, abstractAction, viewerId) {
    const next = this.clone(state);
    if (next.playPhaseEnded) return next;
    const actor = next.players.find((player) => player.id === viewerId);
    if (abstractAction.type === "end") {
      if (actor?.generalId === "blade-walker") {
        actor.momentumBranches = [{ probability:1, conditions:{}, amount:0 }];
        actor.momentum = 0;
      }
      next.playPhaseEnded = true;
      return next;
    }
    if (!actor) return next;
    if (abstractAction.type === "skill") {
      const desiredWorlds = this.getEventWorlds(next,
        abstractAction.executionProbability ?? 1,
        abstractAction.executionWorldBranches,
        `skill:${abstractAction.skill?.id ?? "unknown"}`);
      const skillSlots = this.ensureSkillUseSlots(actor, abstractAction.skill);
      const consumed = this.consumeSlot(next, skillSlots, desiredWorlds,
        abstractAction.skillUseSlot, `skill-slot:${abstractAction.skill?.id ?? "unknown"}`);
      const skillEventWorlds = consumed.eventWorlds;
      const executionProbability = this.eventProbability(skillEventWorlds);
      if (executionProbability <= 0) return next;
      const skillLimit = actor.activeSkillLimit ?? abstractAction.skill?.limitPerTurn ?? 1;
      actor.activeSkillAvailabilityBranches = skillSlots.map(availableBranchesFromState);
      actor.activeSkillUses = Math.min(skillLimit,
        (actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0)) + executionProbability);
      actor.activeSkillUsed = actor.activeSkillUses >= skillLimit - PROBABILITY_EPSILON;
      this.applySkill(next, actor, abstractAction, skillEventWorlds);
      this.syncActiveSkillCosts(next);
      return next;
    }
    const card = abstractAction.card;
    if (!card) return next;
    const assaultAvailabilityBeforeUse = card.definitionId === "assault"
      ? clampProbability(actor.assaultResponseProbability)
      : 0;
    const target = next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
    const heldCard = (actor.hand ?? []).find((entry) => entry.id === card.id) ?? null;
    const availabilityBranches = getAvailabilityBranches(heldCard ?? card);
    const cardProbability = totalBranchProbability(availabilityBranches);
    const desiredCardWorlds = this.getEventWorlds(next,
      abstractAction.executionProbability ?? cardProbability,
      abstractAction.executionWorldBranches,
      `card:${card.id ?? card.definitionId}`);
    let cardEventWorlds = desiredCardWorlds;
    if (heldCard) {
      const availabilityState = getAvailabilityStateBranches(heldCard).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        cardAvailable:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(desiredCardWorlds, availabilityState);
      cardEventWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(branch.occurs && branch.cardAvailable)
      }));
      heldCard.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.cardAvailable && !(branch.occurs && branch.cardAvailable))
      }));
      heldCard.availabilityBranches = availableBranchesFromState(heldCard.availabilityStateBranches);
      const remainingProbability = totalBranchProbability(heldCard.availabilityBranches);
      actor.hand = remainingProbability > 0 ? actor.hand : actor.hand.filter((entry) => entry.id !== card.id);
    }
    const executionProbability = this.eventProbability(cardEventWorlds);
    if (card.definitionId === "assault" && assaultAvailabilityBeforeUse > PROBABILITY_EPSILON) {
      this.consumeAssaultForOpportunity(actor,
        Math.min(1, executionProbability / assaultAvailabilityBeforeUse));
    }
    // restoreActorHand：root 效果估值专用。当前状态中 root 卡牌已经打出（资源已沉没），
    // 结算模拟时把这张卡的打出成本还原再扣，使资源账目净变化为 0，只体现 root 效果价值。
    const handRestore = abstractAction.restoreActorHand && executionProbability > PROBABILITY_EPSILON ? 1 : 0;
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability + handRestore);
    if (executionProbability <= 0) return next;
    // card-scope 的取消概率与容量消费必须使用同一份 responder 评估；两者之间没有
    // 状态变化，因此重复计算 counterDesire 只会增加开销，不会提供新信息。
    const cardScopeCounterEvaluation = card.category === "tactic"
      && card.counterable !== false && card.counterScope !== "target"
      ? this.evaluateCardScopeCounterResponses(
        next, actor, card, abstractAction.targets ?? [], abstractAction.selection ?? null
      )
      : null;
    const effectEventWorlds = card.counterScope === "target"
      ? cardEventWorlds
      : this.gateEventWorlds(
        next,
        cardEventWorlds,
        cardScopeCounterEvaluation?.resolutionChance ?? 1,
        `counter:${card.id ?? card.definitionId}`
      );
    const scale = this.eventProbability(effectEventWorlds);
    // 反制容量双算修复：card-scope 战术的效果已由 tacticResolutionChance 按
    // counterProbability×desire 概率折算，但旧实现不消费反制容量，同一张反制会被
    // "取消本次战术"与"封印反制"等未来预期重复计价。这里按边际取消
    // 概率实际消费反制容量：容量耗尽后 counterProbability / sealCounterProbability
    // 等未来预期自然归零，不再出现 realized + expected 针对同一张反制并存。
    if (card.category === "tactic" && card.counterable !== false && card.counterScope !== "target") {
      this.consumeCountersForCardScope(
        next,
        actor,
        card,
        abstractAction.targets ?? [],
        abstractAction.selection ?? null,
        cardScopeCounterEvaluation
      );
    }
    const cardDamageContext = { cardDamage:true, emberTriggeredProbabilities:{} };
    let coordinationProbability = 0;
    let coordinationTargets = [];

    switch (card.definitionId) {
      case "recover":
        this.healFrom(next, actor, actor, 1 * scale);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - executionProbability);
        break;
      case "charge": this.changeEnergy(next, actor, 1, effectEventWorlds); break;
      case "shield":
        if (target?.alive && target.battleTeam === actor.battleTeam) {
          this.changeShield(next, target, 1, effectEventWorlds);
          coordinationProbability = scale;
          coordinationTargets = [target];
        }
        break;
      case "harvest":
        this.gainUnknownCardsWithCounterState(next, actor, 2, effectEventWorlds, "harvest-draw");
        break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "lightning": {
        const oldLightningBranches = getLightningStatusStateBranches(actor);
        const joinedLightning = joinProbabilityStateBranches(oldLightningBranches, effectEventWorlds);
        actor.lightningStatusStateBranches = projectProbabilityStateBranches(joinedLightning, (branch) => ({
          present:Boolean(branch.present || branch.occurs)
        }));
        const lightningPresence = lightningPresenceProbability(actor);
        actor.lightningStatusProbability = lightningPresence;
        actor.statuses ??= [];
        if (lightningPresence >= 1 - PROBABILITY_EPSILON) {
          if (!actor.statuses.includes("lightning")) actor.statuses.push("lightning");
        } else {
          actor.statuses = actor.statuses.filter((status) => status !== "lightning");
        }
        break;
      }
      case "seal": {
        if (!target?.alive || target.battleTeam === actor.battleTeam) break;
        const oldSealBranches = getSealStatusStateBranches(target);
        const joinedSeal = joinProbabilityStateBranches(oldSealBranches, effectEventWorlds);
        target.sealedStatusStateBranches = projectProbabilityStateBranches(joinedSeal, (branch) => ({
          present:Boolean(branch.present || branch.occurs)
        }));
        const sealPresence = sealPresenceProbability(target);
        target.sealedStatusProbability = sealPresence;
        target.statuses ??= [];
        if (sealPresence >= 1 - PROBABILITY_EPSILON) {
          if (!target.statuses.includes("sealed")) target.statuses.push("sealed");
        } else {
          target.statuses = target.statuses.filter((status) => status !== "sealed");
        }
        break;
      }
      case "scout": {
        if (!target?.alive) break;
        const knownExpectedCount = (target.knownCards ?? [])
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        const unknownCount = Math.max(0, (Number(target.handCount) || 0) - knownExpectedCount);
        const informationGain = Math.min(2, unknownCount);
        actor.expectedInformationGain = (actor.expectedInformationGain ?? 0) + informationGain * scale;
        coordinationProbability = scale;
        coordinationTargets = [target];
        break;
      }
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          attackUseSlot:abstractAction.attackUseSlot,
          damageContext:cardDamageContext
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDesire(next, player, actor, card, [player])
          );
          this.applyDamage(next, actor, player, 1, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:counterResponse.effectPassWorlds,
            damageContext:cardDamageContext
          });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDesire(next, player, actor, card, [player])
          );
          const targetWorlds = counterResponse.effectPassWorlds;
          const response = player.assaultResponseProbability ?? 0;
          const eventProbability = this.eventProbability(targetWorlds);
          const spent = this.consumeAssaultForOpportunity(player, eventProbability);
          player.handCount = Math.max(0, player.handCount - spent);
          this.consumeKnownCardsFromHand(next, player, "assault", spent);
          this.applyDamage(next, actor, player, 1, {
            canBlock:false,
            deviceAttack:false,
            eventBranches:this.gateEventWorlds(next, targetWorlds,
              1 - response, `provoke-response:${card.id}:${player.id}`),
            damageContext:cardDamageContext
          });
        }
        break;
      case "leverage": {
        const first = next.players.find((player) => player.id === abstractAction.selection?.firstTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
        const second = next.players.find((player) => player.id === abstractAction.selection?.secondTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[1]?.id);
        if (!first?.alive || !second?.alive || !first.equipmentDefinitionId) break;
        // 借势第二目标选择只按距离，但实际打出突袭必须满足普通突袭完整目标合法性。
        const simulationGame = { state:{ players:next.players } };
        const canActuallyTargetWithAssault = RuleEngine.getLegalAssaultTargets(simulationGame, first)
          .some((candidate) => candidate.id === second.id);
        // 候选组合从不因手牌估计或次数删除；实际使用必须消费第一目标自己的次数槽。
        const assaultAvailable = canActuallyTargetWithAssault
          ? Math.max(0, Math.min(1, first.assaultResponseProbability ?? 0))
          : 0;
        const equipmentValue = CARD_DEFINITIONS[first.equipmentDefinitionId]?.aiValue ?? 7;
        const friendlyFirePenalty = second.battleTeam === first.battleTeam ? .55 : 0;
        const defenseRisk = Math.min(.9, second.equipmentDefinitionId === "defenseDevice"
          ? (second.blockProbability ?? remainingCardDensity(next.remainingCardCounts, "block"))
          : (second.blockProbability ?? 0));
        const targetValue = second.battleTeam === first.battleTeam
          ? -0.35 - (second.hp <= 2 ? .15 : 0)
          : .3 + (second.hp <= 2 ? .15 : 0);
        const conserveAssaultPenalty = (first.expectedAssaultCount ?? 0) <= .75 ? .18 : 0;
        const willingness = Math.max(.08, Math.min(.97,
          .42 + equipmentValue * .04 + targetValue - friendlyFirePenalty - defenseRisk * .2
          - conserveAssaultPenalty));
        const existenceProbability = this.getSimulatedEquipmentProbability(first);
        const desiredUseWorlds = this.gateEventWorlds(next, effectEventWorlds,
          assaultAvailable * willingness, `leverage-assault:${card.id}:${first.id}`);
        this.ensureAttackUseSlots(first);
        const actualUseWorlds = desiredUseWorlds;
        const effectiveUseProbability = this.eventProbability(actualUseWorlds);
        first.attackUsed = (first.attackUsed ?? 0) + effectiveUseProbability;
        if (effectiveUseProbability > PROBABILITY_EPSILON) first.attackUseSlots = undefined;
        const effectiveDeclineProbability = Math.min(existenceProbability, Math.max(0, scale - effectiveUseProbability));
        const assaultOpportunity = assaultAvailable > PROBABILITY_EPSILON
          ? Math.min(1, effectiveUseProbability / assaultAvailable)
          : 0;
        const assaultSpent = this.consumeAssaultForOpportunity(first, assaultOpportunity);
        first.handCount = Math.max(0, first.handCount - assaultSpent);
        this.consumeKnownCardsFromHand(next, first, "assault", assaultSpent);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, actualUseWorlds, {
          sourceEquipmentConditional:true,
          attackUseConsumed:true,
          damageContext:cardDamageContext
        });
        actor.handCount += effectiveDeclineProbability;
        actor.expectedEquipmentGain = (actor.expectedEquipmentGain ?? 0) + equipmentValue * effectiveDeclineProbability;
        actor.expectedEquipmentRoleDelta = (actor.expectedEquipmentRoleDelta ?? 0)
          + this.equipmentRoleDelta(actor, first.equipmentDefinitionId) * effectiveDeclineProbability;
        this.setSimulatedEquipment(first, first.equipmentDefinitionId, existenceProbability - effectiveDeclineProbability);
        coordinationProbability = scale;
        coordinationTargets = [first, second];
        break;
      }
      case "plunder": {
        const plundered = target
          ? this.takeResourceToHand(
              next, actor, target, effectEventWorlds, `plunder:${card.id ?? card.definitionId}`
            )
          : 0;
        if (plundered > PROBABILITY_EPSILON) {
          coordinationProbability = plundered;
          coordinationTargets = [target];
        }
        break;
      }
      case "transfer": {
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? null;
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? null;
        if (source && receiver && (source.handCount ?? 0) > 0 && abstractAction.selection?.zone !== "equipment") {
          const selection = abstractAction.selection ?? {};
          const transferCardId = card?.id ?? null;
          const excludedTransferCard = transferCardId ? new Set([transferCardId]) : null;
          const transferred = selection.selectionKind === "known"
            ? this.transferKnownCardIdentity(next, source, receiver, {
                cardId:selection.cardId ?? null,
                definitionId:selection.definitionId ?? null
              }, effectEventWorlds, receiver.id === actor.id, excludedTransferCard)
            : this.transferUnknownCardIdentity(next, source, receiver,
                effectEventWorlds,
                selection.availableUnknownCount != null && Number.isFinite(Number(selection.availableUnknownCount))
                  ? Math.max(0, Number(selection.availableUnknownCount))
                  : this.availableUnknownCountFor(source, excludedTransferCard));
          coordinationProbability = transferred;
          coordinationTargets = [source, receiver];
        }
        break;
      }
      case "counter":
        coordinationProbability = scale;
        coordinationTargets = abstractAction.targets ?? [];
        break;
      case "destroy": {
        const destroyed = target
          ? this.destroyResource(
              next, actor, target, effectEventWorlds, `destroy:${card.id ?? card.definitionId}`
            )
          : 0;
        if (destroyed > PROBABILITY_EPSILON) {
          coordinationProbability = destroyed;
          coordinationTargets = [target];
        }
        break;
      }
      case "duel": if (target) this.applyDuel(next, actor, target, scale, cardDamageContext); break;
      case "mutualBenefit": {
        coordinationTargets = next.players.filter((player) => player.alive);
        coordinationProbability = scale;
        // 互利按真实公开选牌顺序估值：从施放者开始逐个存活角色从预期剩余牌池选走自己
        // 角色价值最高的牌并消耗一张；后手只能从剩余集合选，顺序优势来自可选集合逐步
        // 缩小。规划阶段牌未翻开，禁止读取真实未来牌堆或 RNG，只能用公共剩余牌计数做
        // 确定性期望。
        const draftValues = mutualBenefitDraftValues(next.players, actor, next?.remainingCardCounts ?? null);
        for (const player of coordinationTargets) {
          this.gainUnknownCardsWithCounterState(next, player, 1, effectEventWorlds, "mutual-benefit-draw");
          // 把本次选牌期望价值记入角色状态：owner ledger 据此区分"己方先选/敌方先选"
          // 两种座位排列，后手因可选集合缩小而自然更低，不引入座位奖励常数。
          player.mutualBenefitDraftValue = (player.mutualBenefitDraftValue ?? 0)
            + (draftValues[player.id] ?? 0) * scale;
        }
        break;
      }
      case "symbiosis": {
        const targets = this.seatOrderFrom(next, actor, true);
        coordinationTargets = targets.filter((player) => player.hp < player.maxHp);
        coordinationProbability = scale;
        for (const player of targets) this.healFrom(next, actor, player, scale);
        break;
      }
      default:
        if (card.category === "equipment") this.setSimulatedEquipment(actor, card.definitionId, executionProbability);
        break;
    }
    this.simulateGamble(next, actor, card, executionProbability);
    this.simulateCoordination(next, actor, coordinationTargets, coordinationProbability);
    const recycleProbability = executionProbability * this.getSimulatedEquipmentProbability(actor, "recycleDevice");
    if (card.category === "tactic" && recycleProbability > 0) {
      const remainingUses = Math.max(0, 2 - (actor.recycleDeviceUses ?? 0));
      const triggerProbability = Math.min(recycleProbability, remainingUses);
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + triggerProbability;
      if (triggerProbability > PROBABILITY_EPSILON) {
        const recycleWorlds = this.getEventWorlds(
          next, triggerProbability, null, `recycle-draw:${card.id ?? card.definitionId}`
        );
        this.gainUnknownCardsWithCounterState(next, actor, triggerProbability, recycleWorlds, "recycle-draw");
      }
    }
    if (actor.generalId === "blade-walker" && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(next, actor, category, cardEventWorlds);
    }
    this.syncActiveSkillCosts(next);
    return next;
  }

  /** AI 模拟中装备定义与存在概率的唯一写入口；换装固定重置为完整的新装备。 */
  setSimulatedEquipment(player, definitionId, probability = 1) {
    const normalized = Math.max(0, Math.min(1, Number(probability) || 0));
    if (!definitionId || normalized === 0) {
      player.equipmentDefinitionId = null;
      player.equipmentRetentionProbability = 0;
      return;
    }
    player.equipmentDefinitionId = definitionId;
    player.equipmentRetentionProbability = normalized;
  }

  getSimulatedEquipmentProbability(player, definitionId = null) {
    if (!player?.equipmentDefinitionId || (definitionId && player.equipmentDefinitionId !== definitionId)) return 0;
    return Math.max(0, Math.min(1, Number(player.equipmentRetentionProbability ?? 1) || 0));
  }

  /** 读取抽象牌或已知牌条目的剩余可用概率；字段缺失时按完整可用 1。 */
  cardAvailability(card) {
    const stateBranches = Array.isArray(card?.availabilityStateBranches)
      ? card.availabilityStateBranches
      : null;
    if (stateBranches) {
      return totalBranchProbability(stateBranches.filter((branch) => branch.available));
    }
    if (Array.isArray(card?.availabilityBranches)) {
      return totalBranchProbability(card.availabilityBranches);
    }
    return 1;
  }

  /** 将标量或已有世界统一为带条件键的效果世界；目标移除与行动者获得必须复用同一数组。 */
  normalizeResourceEffectWorlds(state, resolution, label) {
    if (Array.isArray(resolution) && resolution.length) return resolution;
    const probability = Math.max(0, Math.min(1, Number(resolution) || 0));
    return this.getEventWorlds(state, probability, null, label);
  }

  /** 生成仅用于模拟的唯一卡牌 ID，避免与真实实体 ID 冲突。 */
  nextSimulatedCardId(state, definitionId) {
    state.simulatedCardCounter = Math.max(0, Number(state.simulatedCardCounter) || 0) + 1;
    return `simulated-resource:${state.simulatedCardCounter}:${definitionId}`;
  }

  /** 在目标 knownCards 中按 cardId + definitionId 查找条目。 */
  findKnownCardEntry(target, cardId, definitionId) {
    if (!Array.isArray(target?.knownCards) || !cardId || !definitionId) return null;
    return target.knownCards.find((entry) => (
      entry?.cardId === cardId && entry?.definitionId === definitionId
    )) ?? null;
  }

  /** 将一张已知身份或模拟身份的抽象牌加入玩家手牌，可用性来自 acquisitionWorlds 的 occurs 分支。 */
  addSimulatedCardToHand(state, player, cardIdentity, acquisitionWorlds) {
    if (!player || !cardIdentity?.definitionId || !Array.isArray(acquisitionWorlds)) return 0;
    const acquired = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs)
    }));
    const acquisitionProbability = totalBranchProbability(acquired.filter((branch) => branch.available));
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    const id = cardIdentity.id ?? this.nextSimulatedCardId(state, cardIdentity.definitionId);
    player.hand ??= [];
    // 先基于加入前的身份初始化反制分布，避免旧快照把新身份计入初始分布后重复 +1。
    this.ensureCounterCountDistribution(player, state?.remainingCardCounts ?? null);
    player.hand.push({
      id,
      definitionId: cardIdentity.definitionId,
      availabilityBranches: availableBranchesFromState(acquired),
      availabilityStateBranches: acquired
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
    if (cardIdentity.definitionId === "block") this.addKnownBlockToDistribution(state, player, acquired);
    if (cardIdentity.definitionId === "counter") this.addKnownCounterToDistribution(state, player, acquired);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return acquisitionProbability;
  }

  /** 计算来源在当前可见表示中的未知聚合数量；可选排除正在使用的转移牌。 */
  availableUnknownCountFor(player, excludedCardIds = null) {
    if (!player) return 0;
    if (Array.isArray(player.hand)) {
      const cards = player.hand.filter((card) => !excludedCardIds?.has(card.id));
      const certainKnownCount = cards.filter((card) => this.cardAvailability(card) >= 1 - PROBABILITY_EPSILON).length;
      const concreteExpected = cards.reduce((sum, card) => sum + this.cardAvailability(card), 0);
      return Math.max(0, concreteExpected - certainKnownCount);
    }
    const { unknownCount } = this.buildSimulatedKnownCards(player);
    return Math.max(0, unknownCount);
  }

  /** 定位来源中的已知转移实体：自己手牌按 id，其他玩家 knownCards 按 cardId+definitionId。 */
  findTransferCardEntry(source, cardId, definitionId) {
    if (!cardId || !definitionId) return null;
    if (Array.isArray(source?.hand)) {
      return source.hand.find((card) => card?.id === cardId && card?.definitionId === definitionId) ?? null;
    }
    return this.findKnownCardEntry(source, cardId, definitionId);
  }

  /** 只给其他玩家写入合法已知身份；绝不创建其完整 hand。 */
  addSimulatedKnownCard(state, player, identity, acquisitionWorlds) {
    if (!player || !identity?.cardId || !identity?.definitionId || !Array.isArray(acquisitionWorlds)) return 0;
    const acquired = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs)
    }));
    const acquisitionProbability = totalBranchProbability(acquired.filter((branch) => branch.available));
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    this.ensureCounterCountDistribution(player, state?.remainingCardCounts ?? null);
    const sameCardId = (player.knownCards ?? []).find((entry) => entry?.cardId === identity.cardId) ?? null;
    if (sameCardId && sameCardId.definitionId !== identity.definitionId) {
      throw new Error(`addSimulatedKnownCard 同 cardId 不同 definitionId：${identity.cardId}`);
    }
    const existing = sameCardId;
    if (existing) {
      if (existing.definitionId !== identity.definitionId) {
        throw new Error(`addSimulatedKnownCard 同 cardId 不同 definitionId：${identity.cardId}`);
      }
      const oldState = getAvailabilityStateBranches(existing);
      const oldProbability = this.cardAvailability(existing);
      const newState = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
        newAvailable:Boolean(branch.occurs)
      }));
      const merged = joinProbabilityStateBranches(oldState, newState);
      const mergedState = projectProbabilityStateBranches(merged, (branch) => ({
        available:Boolean(branch.available || branch.newAvailable)
      }));
      existing.availabilityStateBranches = mergedState;
      existing.availabilityBranches = availableBranchesFromState(mergedState);
      const addedProbability = Math.max(0,
        totalBranchProbability(mergedState.filter((branch) => branch.available)) - oldProbability);
      if (addedProbability > PROBABILITY_EPSILON) {
        player.handCount = (player.handCount ?? 0) + addedProbability;
        if (identity.definitionId === "block") {
          const addedWorlds = projectProbabilityStateBranches(merged, (branch) => ({
            occurs:Boolean(branch.newAvailable && !branch.available)
          }));
          this.addKnownBlockToDistribution(state, player, addedWorlds);
        }
        if (identity.definitionId === "counter") {
          const addedWorlds = projectProbabilityStateBranches(merged, (branch) => ({
            occurs:Boolean(branch.newAvailable && !branch.available)
          }));
          this.addKnownCounterToDistribution(state, player, addedWorlds);
        }
      }
      this.syncCardEstimates(player, state?.remainingCardCounts);
      return addedProbability;
    }
    player.knownCards ??= [];
    player.knownCards.push({
      cardId:identity.cardId,
      definitionId:identity.definitionId,
      availabilityBranches:availableBranchesFromState(acquired),
      availabilityStateBranches:acquired
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
    if (identity.definitionId === "block") this.addKnownBlockToDistribution(state, player, acquired);
    if (identity.definitionId === "counter") this.addKnownCounterToDistribution(state, player, acquired);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return acquisitionProbability;
  }

  /** 已知转移：同一 joined branches 决定来源剩余与接收者获得，身份不在同世界双存。 */
  transferKnownCardIdentity(state, source, receiver, identity, effectWorlds, receiverIsActor, excludedCardIds = null) {
    const entry = (!excludedCardIds?.has(identity.cardId))
      ? this.findTransferCardEntry(source, identity.cardId, identity.definitionId)
      : null;
    if (!entry || this.cardAvailability(entry) < 1 - PROBABILITY_EPSILON) {
      return this.transferUnknownCardIdentity(state, source, receiver,
        effectWorlds, this.availableUnknownCountFor(source, excludedCardIds));
    }
    const availabilityState = getAvailabilityStateBranches(entry);
    const joined = joinProbabilityStateBranches(effectWorlds, availabilityState);
    const remainingState = projectProbabilityStateBranches(joined, (branch) => ({
      available:Boolean(branch.available && !branch.occurs)
    }));
    const acquisitionWorlds = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:Boolean(branch.available && branch.occurs)
    }));
    const transferProbability = this.eventProbability(acquisitionWorlds);
    if (transferProbability <= PROBABILITY_EPSILON) return 0;
    if (identity.definitionId === "block") {
      this.removeKnownBlockFromDistribution(state, source, acquisitionWorlds);
    }
    if (identity.definitionId === "counter") {
      this.removeKnownCounterFromDistribution(state, source, acquisitionWorlds);
    }
    entry.availabilityStateBranches = remainingState;
    entry.availabilityBranches = availableBranchesFromState(remainingState);
    const remainingProbability = totalBranchProbability(entry.availabilityBranches);
    if (Array.isArray(source.hand)) {
      if (remainingProbability <= PROBABILITY_EPSILON) {
        source.hand = source.hand.filter((card) => card.id !== identity.cardId);
      }
    } else if (Array.isArray(source.knownCards)) {
      if (remainingProbability <= PROBABILITY_EPSILON) {
        source.knownCards = source.knownCards.filter((item) => item !== entry);
      }
    }
    source.handCount = Math.max(0, (source.handCount ?? 0) - transferProbability);
    this.syncCardEstimates(source, state?.remainingCardCounts);
    if (receiverIsActor) {
      return this.addSimulatedCardToHand(state, receiver, {
        id:identity.cardId,
        definitionId:identity.definitionId
      }, acquisitionWorlds);
    }
    return this.addSimulatedKnownCard(state, receiver, identity, acquisitionWorlds);
  }

  /** 未知转移：来源与接收者共享同一组匿名牌身份条件。 */
  transferUnknownCardIdentity(state, source, receiver, effectWorlds, availableUnknownCount) {
    return this.transferUnknownBlockCapacity(state, source, receiver, effectWorlds, availableUnknownCount);
  }

  /** 按具体牌与未知聚合重建四类派生摘要；只用于定向已知牌转移/移除与装备入手路径。 */
  cardEstimateDistribution(player, definitionId, remainingCardCounts = null) {
    const explicitEntries = Array.isArray(player.hand)
      ? player.hand.filter((card) => card?.definitionId === definitionId)
      : Array.isArray(player.knownCards)
        ? player.knownCards.filter((entry) => entry?.definitionId === definitionId)
        : [];
    const explicitExpectedCount = explicitEntries.reduce(
      (sum, card) => sum + this.cardAvailability(card), 0
    );
    const handCount = Math.max(0, Number(player.handCount) || 0);
    const unknownExpectedCount = Math.max(0, handCount - explicitExpectedCount);
    const wholeSlots = Math.floor(unknownExpectedCount);
    const fractionalSlot = unknownExpectedCount - wholeSlots;
    const density = remainingCardDensity(remainingCardCounts, definitionId);
    let distribution = [{ count:0, probability:1 }];
    const convolve = (probability) => {
      const next = [];
      for (const branch of distribution) {
        next.push({ count:branch.count, probability:branch.probability * (1 - probability) });
        next.push({ count:branch.count + 1, probability:branch.probability * probability });
      }
      distribution = next;
    };
    for (const card of explicitEntries) convolve(this.cardAvailability(card));
    for (let slot = 0; slot < wholeSlots; slot += 1) convolve(density);
    if (fractionalSlot > PROBABILITY_EPSILON) convolve(fractionalSlot * density);
    const maxCount = Math.max(0, Math.ceil(handCount));
    const merged = new Map();
    for (const branch of distribution) {
      const count = Math.max(0, Math.min(maxCount, Math.floor(Number(branch?.count) || 0)));
      const probability = Math.max(0, Number(branch?.probability) || 0);
      if (probability <= PROBABILITY_EPSILON) continue;
      merged.set(count, (merged.get(count) ?? 0) + probability);
    }
    if (!merged.size) return [{ count:0, probability:1 }];
    const total = [...merged.values()].reduce((sum, probability) => sum + probability, 0);
    return [...merged.entries()]
      .sort(([left], [right]) => left - right)
      .map(([count, probability]) => ({ count, probability:probability / total }));
  }

  syncCardEstimates(player, remainingCardCounts = null) {
    if (!player) return;
    const expectation = (distribution) => distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability, 0
    );
    const atLeast = (distribution, required) => distribution.reduce(
      (sum, branch) => sum + (branch.count >= required ? branch.probability : 0), 0
    );
    const recoverDistribution = this.cardEstimateDistribution(player, "recover", remainingCardCounts);
    const assaultDistribution = this.cardEstimateDistribution(player, "assault", remainingCardCounts);
    player.expectedRecoverCount = expectation(recoverDistribution);
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    this.syncBlockSummary(player);
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    this.syncCounterSummary(player);
    player.assaultCountDistribution = assaultDistribution;
    player.expectedAssaultCount = expectation(assaultDistribution);
    player.assaultResponseProbability = atLeast(assaultDistribution, 1);
  }

  /**
   * 从模拟可见状态整理合法已知手牌与未知数量。
   * 身份数量超过聚合手牌时保守回退：剩余期望手牌全部按未知聚合处理，不猜测哪张已知牌消失。
   */
  buildSimulatedKnownCards(target) {
    const knownCards = Array.isArray(target.knownCards) ? target.knownCards : [];
    const handCount = Math.max(0, Number(target.handCount) || 0);
    const certainKnown = knownCards.filter((entry) => this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON);
    const certainKnownCount = certainKnown.length;
    if (certainKnownCount > handCount + PROBABILITY_EPSILON) {
      return { knownCards: [], unknownCount: handCount };
    }
    return { knownCards: certainKnown, unknownCount: Math.max(0, handCount - certainKnownCount) };
  }

  /** 模拟破坏/掠夺的抽象资源选择；用于 destroy 与 plunder，不读取 target.hand。 */
  chooseSimulatedResourceSelection(state, actor, target, purpose) {
    const { knownCards, unknownCount } = this.buildSimulatedKnownCards(target);
    const handCandidate = chooseBestResourceHandCandidate({
      purpose,
      actor,
      owner: target,
      knownCards,
      unknownCount,
      remainingCardCounts: state?.remainingCardCounts ?? null
    });
    const equipmentDefinitionId = this.getSimulatedEquipmentProbability(target) > PROBABILITY_EPSILON
      ? (target.equipmentDefinitionId ?? null)
      : null;
    const selection = chooseResourceZone({
      purpose,
      actor,
      owner: target,
      handCandidate,
      equipmentDefinitionId
    });
    if (!selection) return null;
    // 仅供模拟器未知消费使用；不修改资源选择模块的公共语义
    return { ...selection, availableUnknownCount: unknownCount };
  }

  /** 从 AI 自己的具体模拟手牌中同步消费响应牌；部分期望消费会保留对应可用概率。 */
  consumeKnownCardsFromHand(state, player, definitionId, expectedAmount) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    if (!Array.isArray(player?.hand) || remaining <= PROBABILITY_EPSILON) return;
    for (const card of [...player.hand]) {
      if (card.definitionId !== definitionId || remaining <= PROBABILITY_EPSILON) continue;
      const availabilityState = getAvailabilityStateBranches(card);
      const availableProbability = totalBranchProbability(
        availabilityState.filter((branch) => branch.available)
      );
      if (availableProbability <= PROBABILITY_EPSILON) continue;
      const spendProbability = Math.min(availableProbability, remaining);
      const spendWorlds = this.getEventWorlds(state, spendProbability / availableProbability, null,
        `response-card:${player.id}:${card.id}`);
      const joined = joinProbabilityStateBranches(availabilityState, spendWorlds);
      card.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.available && !branch.occurs)
      }));
      card.availabilityBranches = availableBranchesFromState(card.availabilityStateBranches);
      if (totalBranchProbability(card.availabilityBranches) <= PROBABILITY_EPSILON) {
        player.hand = player.hand.filter((entry) => entry.id !== card.id);
      }
      remaining -= spendProbability;
    }
  }

  /**
  * 在包含“已格挡/未格挡”的完整世界分区中消费确定格挡身份。
   * 这里只更新 hand / knownCards 的身份可用性，不修改 handCount 或 blockCountDistribution；
   * 总格挡容量由 blockCountDistribution 统一扣减，避免两个入口重复计数。
   */
  consumeBlockIdentities(state, player, blockWorlds, excludedCardIds = null) {
    if (!player || !Array.isArray(blockWorlds) || !blockWorlds.length) return;
    const candidates = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "block") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "block") : [])
    ].filter((card) => !excludedCardIds?.has(card.id ?? card.cardId));
    if (!candidates.length) return;
    let remainingWorlds = blockWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      remaining:branch.blockUsed
        ? Math.max(0, Number(branch.requiredCount) || 1)
        : 0
    }));
    for (const card of candidates) {
      const availabilityState = getAvailabilityStateBranches(card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(remainingWorlds, availabilityState);
      if (!joined.length) break;
      const usedWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        used:Boolean(branch.available && branch.remaining > 0),
        remaining:Math.max(0, Number(branch.remaining) - (branch.available && branch.remaining > 0 ? 1 : 0))
      }));
      card.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.available && !(branch.available && branch.remaining > 0))
      }));
      card.availabilityBranches = availableBranchesFromState(card.availabilityStateBranches);
      if (totalBranchProbability(card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(player.hand)) player.hand = player.hand.filter((entry) => entry !== card);
        if (Array.isArray(player.knownCards)) player.knownCards = player.knownCards.filter((entry) => entry !== card);
      }
      remainingWorlds = usedWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        remaining:branch.remaining
      }));
      if (!remainingWorlds.some((branch) => branch.remaining > 0 && branch.probability > PROBABILITY_EPSILON)) break;
    }
  }

  normalizeAssaultCountDistribution(player, rawDistribution = null) {
    let source = Array.isArray(rawDistribution) && rawDistribution.length
      ? rawDistribution
      : null;
    if (!source && Array.isArray(player?.hand)
      && (player.hand.length > 0 || !(Number(player.expectedAssaultCount) > 0))) {
      source = [{ count:0, probability:1 }];
      for (const card of player.hand.filter((entry) => entry.definitionId === "assault")) {
        const availability = clampProbability(totalBranchProbability(getAvailabilityBranches(card)));
        const next = [];
        for (const branch of source) {
          next.push({ count:branch.count, probability:branch.probability * (1 - availability) });
          next.push({ count:branch.count + 1, probability:branch.probability * availability });
        }
        source = next;
      }
    }
    if (!source) {
      const expected = Math.max(0, Number(player?.expectedAssaultCount) || 0);
      const response = clampProbability(player?.assaultResponseProbability
        ?? (expected > 0 ? 1 : 0));
      if (response <= PROBABILITY_EPSILON || expected <= PROBABILITY_EPSILON) {
        source = [{ count:0, probability:1 }];
      } else {
        const conditionalMean = Math.max(1, expected / response);
        const lower = Math.floor(conditionalMean);
        const upper = Math.ceil(conditionalMean);
        const upperWeight = conditionalMean - lower;
        source = [
          { count:0, probability:1 - response },
          { count:lower, probability:response * (1 - upperWeight) },
          { count:upper, probability:response * upperWeight }
        ];
      }
    }
    const maxCount = Math.max(0, Math.ceil(Number(player?.handCount) || 0));
    const merged = new Map();
    for (const branch of source) {
      const count = Math.max(0, Math.min(maxCount, Math.floor(Number(branch?.count) || 0)));
      const probability = Math.max(0, Number(branch?.probability) || 0);
      if (probability <= PROBABILITY_EPSILON) continue;
      merged.set(count, (merged.get(count) ?? 0) + probability);
    }
    if (!merged.size) return [{ count:0, probability:1 }];
    const total = [...merged.values()].reduce((sum, probability) => sum + probability, 0);
    return [...merged.entries()]
      .sort(([left], [right]) => left - right)
      .map(([count, probability]) => ({ count, probability:probability / total }));
  }

  syncAssaultSummary(player, distribution = null) {
    const normalized = this.normalizeAssaultCountDistribution(
      player,
      distribution ?? player?.assaultCountDistribution
    );
    player.assaultCountDistribution = normalized;
    player.expectedAssaultCount = normalized.reduce(
      (sum, branch) => sum + branch.count * branch.probability, 0
    );
    player.assaultResponseProbability = normalized.reduce(
      (sum, branch) => sum + (branch.count > 0 ? branch.probability : 0), 0
    );
    return normalized;
  }

  consumeAssaultForOpportunity(player, opportunityProbability = 1) {
    const chance = clampProbability(opportunityProbability);
    const distribution = this.syncAssaultSummary(player);
    const remaining = [];
    let expectedSpent = 0;
    for (const branch of distribution) {
      if (branch.count <= 0 || chance <= PROBABILITY_EPSILON) {
        remaining.push(branch);
        continue;
      }
      remaining.push({ count:branch.count, probability:branch.probability * (1 - chance) });
      remaining.push({ count:branch.count - 1, probability:branch.probability * chance });
      expectedSpent += branch.probability * chance;
    }
    this.syncAssaultSummary(player, remaining);
    return expectedSpent;
  }

  /**
   * 聚合随机消费后对部分概率 knownCards 做保守身份降级。
   * 完整确定条目保留；零概率与部分概率条目移除（其概率质量已包含在 handCount 中，转为未知聚合）。
   * @returns {boolean} knownCards 是否发生变化
   */
  downgradePartialKnownCardsAfterRandomLoss(player) {
    if (!Array.isArray(player?.knownCards)) return false;
    const retained = player.knownCards.filter((entry) => (
      (entry.definitionId === "block" && this.cardAvailability(entry) > PROBABILITY_EPSILON)
      || this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON
    ));
    const changed = retained.length !== player.knownCards.length;
    if (changed) player.knownCards = retained;
    return changed;
  }

  /**
   * 资源专用未知消费：只消费 availableUnknownCount 范围内的未知聚合数量，
   * 不按整手牌比例侵蚀完整确定 known；消费后始终重算摘要。
   * @returns {number} 实际消费的期望数量
   */
  consumeUnknownResourceCard(state, player, expectedAmount, availableUnknownCount, eventWorlds = null) {
    if (!player) return 0;
    const spent = Math.min(
      Math.max(0, Number(expectedAmount) || 0),
      Math.max(0, Number(availableUnknownCount) || 0),
      Math.max(0, Number(player.handCount) || 0)
    );
    if (spent <= PROBABILITY_EPSILON) return 0;
    const { removed, identityWorlds } = this.removeUnknownCardsFromBlockDistribution(
      state,
      player,
      spent,
      availableUnknownCount,
      eventWorlds,
      "unknown-resource-loss",
      false
    );
    this.removeUnknownCardsFromCounterDistribution(
      state,
      player,
      removed,
      availableUnknownCount,
      identityWorlds,
      "unknown-counter-resource-loss",
      false
    );
    player.handCount = Math.max(0, (player.handCount ?? 0) - removed);
    this.clearCountersWhenHandEmpty(player);
    this.downgradePartialKnownCardsAfterRandomLoss(player);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return removed;
  }

  /**
   * 从整副手牌中随机移除一张：hand / knownCards 身份与匿名桶组成互斥候选池。
   * 一次移除只可能选中一个候选，并返回本次实际移除的期望数量。
   */
  removeOneRandomCardFromHand(state, player, spend, options = {}) {
    const amount = Math.min(
      Math.max(0, Number(spend) || 0),
      Math.max(0, Number(player.handCount) || 0)
    );
    if (amount <= PROBABILITY_EPSILON || !player) return 0;
    const explicitCards = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ];
    const explicitExpected = explicitCards.reduce(
      (sum, card) => sum + this.cardAvailability(card), 0
    );
    const expectedUnknown = Math.max(0, (Number(player.handCount) || 0) - explicitExpected);
    const candidates = [
      ...(Array.isArray(player.hand) ? player.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON)
        .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:card.definitionId })) : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards
        .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON)
        .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:entry.definitionId })) : [])
    ];
    if (!candidates.length && expectedUnknown <= PROBABILITY_EPSILON) return 0;

    let anonymousState = Array.isArray(player.anonymousCountBranches) && player.anonymousCountBranches.length
      ? mergeProbabilityStateBranches(player.anonymousCountBranches)
      : null;
    if (anonymousState) {
      const anonymousExpected = anonymousState.reduce(
        (sum, branch) => sum + branch.probability * (Number(branch.anonymousCount) || 0), 0
      );
      if (Math.abs(anonymousExpected - expectedUnknown) > PROBABILITY_EPSILON) anonymousState = null;
    }
    if (!anonymousState) {
      player.anonymousCountBranches = [{ probability:1, conditions:{}, anonymousCount:expectedUnknown }];
      anonymousState = player.anonymousCountBranches;
    }

    const removalWorlds = probabilityEventPartition(
      this.nextProbabilityEventKey(state, "random-hand-removal"),
      Math.min(1, amount),
      "occurs"
    );
    const candidatePartitions = candidates.map((candidate, index) => (
      getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        [`c${index}`]:Boolean(branch.available)
      }))
    ));
    const anonymousPartition = anonymousState.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      anonymousCount:Math.max(0, Number(branch.anonymousCount) || 0)
    }));
    const joined = joinProbabilityStateBranches(
      removalWorlds, ...candidatePartitions, anonymousPartition
    );
    const selectionKey = this.nextProbabilityEventKey(state, "random-hand-selection");
    const outcomes = [];
    for (const branch of joined) {
      const occurs = Boolean(branch.occurs);
      const available = candidates.map((_, index) => Boolean(branch[`c${index}`]));
      const knownCount = available.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const anonymousCount = Math.max(0, Number(branch.anonymousCount) || 0);
      const total = knownCount + anonymousCount;
      if (!occurs || total <= PROBABILITY_EPSILON) {
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:"none" },
          selectedIndex:-1,
          anonymousSelected:false,
          anonymousCount
        });
        continue;
      }
      for (let index = 0; index < candidates.length; index += 1) {
        if (available[index]) {
          outcomes.push({
            probability:branch.probability / total,
            conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[index].key}` },
            selectedIndex:index,
            anonymousSelected:false,
            anonymousCount
          });
        }
      }
      outcomes.push({
        probability:branch.probability * (anonymousCount / total),
        conditions:{ ...branch.conditions, [selectionKey]:"anonymous" },
        selectedIndex:-1,
        anonymousSelected:true,
        anonymousCount
      });
    }

    const selectionPartition = mergeProbabilityStateBranches(outcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const availabilityState = getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedAvailability = joinProbabilityStateBranches(availabilityState, selectionPartition);
      candidate.card.availabilityStateBranches = projectProbabilityStateBranches(
        joinedAvailability,
        (branch) => ({ available:Boolean(branch.available && !(branch.selectedIndex === index)) })
      );
      candidate.card.availabilityBranches = availableBranchesFromState(candidate.card.availabilityStateBranches);
      if (totalBranchProbability(candidate.card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(player.hand)) player.hand = player.hand.filter((card) => card !== candidate.card);
        if (Array.isArray(player.knownCards)) player.knownCards = player.knownCards.filter((entry) => entry !== candidate.card);
      }
    }

    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const knownState = this.getKnownBlockCountBranches(player);
    const joinedBlock = joinProbabilityStateBranches(blockState, knownState, selectionPartition);
    const blockOutcomes = [];
    for (const branch of joinedBlock) {
      const totalBlocks = Math.max(0, Math.floor(Number(branch.blockCount) || 0));
      const knownBlocks = Math.max(0, Math.floor(Number(branch.knownBlockCount) || 0));
      const selectedIndex = Number.isFinite(Number(branch.selectedIndex)) ? Number(branch.selectedIndex) : -1;
      if (branch.anonymousSelected) {
        const anonymousCount = Math.max(0, Number(branch.anonymousCount) || 0);
        const anonymousBlocks = Math.max(0, Math.min(anonymousCount, totalBlocks - knownBlocks));
        const removalChance = anonymousCount > PROBABILITY_EPSILON
          ? Math.min(1, anonymousBlocks / anonymousCount)
          : 0;
        blockOutcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          blockCount:Math.max(0, totalBlocks - 1)
        });
        blockOutcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          blockCount:totalBlocks
        });
      } else if (selectedIndex >= 0 && candidates[selectedIndex]?.definitionId === "block") {
        blockOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:Math.max(0, totalBlocks - 1)
        });
      } else {
        blockOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:totalBlocks
        });
      }
    }
    player.blockCountDistribution = mergeProbabilityStateBranches(blockOutcomes);
    this.syncBlockSummary(player);

    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const knownCounterState = this.getKnownCounterCountBranches(player);
    const joinedCounter = joinProbabilityStateBranches(counterState, knownCounterState, selectionPartition);
    const counterOutcomes = [];
    for (const branch of joinedCounter) {
      const totalCounters = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const knownCounters = Math.max(0, Math.floor(Number(branch.knownCounterCount) || 0));
      const selectedIndex = Number.isFinite(Number(branch.selectedIndex)) ? Number(branch.selectedIndex) : -1;
      if (branch.anonymousSelected) {
        const anonymousCount = Math.max(0, Number(branch.anonymousCount) || 0);
        const anonymousCounters = Math.max(0, Math.min(anonymousCount, totalCounters - knownCounters));
        const removalChance = anonymousCount > PROBABILITY_EPSILON
          ? Math.min(1, anonymousCounters / anonymousCount)
          : 0;
        counterOutcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          counterCount:Math.max(0, totalCounters - 1),
          counterRemoved:true
        });
        counterOutcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          counterCount:totalCounters,
          counterRemoved:false
        });
      } else if (selectedIndex >= 0 && candidates[selectedIndex]?.definitionId === "counter") {
        counterOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:Math.max(0, totalCounters - 1),
          counterRemoved:true
        });
      } else {
        counterOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:totalCounters,
          counterRemoved:false
        });
      }
    }
    const counterRemovedPartition = mergeProbabilityStateBranches(
      counterOutcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:Boolean(branch.counterRemoved)
      }))
    );
    if (options.result && counterRemovedPartition.length) {
      options.result.counterRemovedWorlds.push(counterRemovedPartition);
    }
    player.counterCountDistribution = mergeProbabilityStateBranches(
      counterOutcomes.map(({ probability, conditions, counterCount }) => ({
        probability, conditions, counterCount
      }))
    );
    this.syncCounterSummary(player);

    const joinedAnonymous = joinProbabilityStateBranches(anonymousPartition, selectionPartition);
    player.anonymousCountBranches = projectProbabilityStateBranches(joinedAnonymous, (branch) => ({
      anonymousCount:Math.max(0, (Number(branch.anonymousCount) || 0) - (branch.anonymousSelected ? 1 : 0))
    }));

    if (Array.isArray(player.hand)) {
      player.hand = player.hand.filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON);
    }
    if (Array.isArray(player.knownCards)) {
      player.knownCards = player.knownCards.filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON);
    }
    player.handCount = Math.max(0, (player.handCount ?? 0) - amount);
    this.clearCountersWhenHandEmpty(player);
    return amount;
  }

  consumeRandomHandCards(state, player, expectedAmount, options = {}) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    let totalSpent = 0;
    const result = options.result ?? null;
    while (remaining > PROBABILITY_EPSILON && (player.handCount ?? 0) > PROBABILITY_EPSILON) {
      const handBefore = Math.max(PROBABILITY_EPSILON, Number(player.handCount) || 0);
      const spend = Math.min(1, remaining, handBefore);
      const distribution = this.syncAssaultSummary(player);
      const next = [];
      for (const branch of distribution) {
        const assaultLossChance = clampProbability(spend * branch.count / handBefore);
        next.push({ count:branch.count, probability:branch.probability * (1 - assaultLossChance) });
        if (branch.count > 0) next.push({ count:branch.count - 1, probability:branch.probability * assaultLossChance });
      }
      this.syncAssaultSummary(player, next);
      this.removeOneRandomCardFromHand(state, player, spend, result ? { result } : {});
      remaining -= spend;
      totalSpent += spend;
    }
    return totalSpent;
  }

  /** 由 AI 自主选择弃牌时的共享上下文：距离 stranded 与装备边际与真实 chooseDiscards 等价。 */
  buildDiscardKeepValueContext(state, player) {
    const enemies = state.players.filter((entry) => entry.alive && entry.battleTeam !== player.battleTeam);
    const stranded = enemies.length > 0
      && !enemies.some((enemy) => DistanceSystem.inAttackRange({ state }, player, enemy));
    return {
      stranded,
      equippedDefinitionId: player.equipmentDefinitionId ?? null,
      equipmentRetentionProbability: player.equipmentRetentionProbability ?? 1
    };
  }

  /**
   * 护援确定性弃牌的前置守卫：只有具体手牌全部 100% 确定存在，且具体身份数量
   * 与 handCount 完全一致（无匿名/未知容量）时，才允许按共享保留价值智能选牌；
   * 概率/部分身份手牌必须回退随机期望消费。
   */
  hasCompleteCertainHand(player) {
    if (!Array.isArray(player?.hand) || !player.hand.length) return false;
    const allCertain = player.hand.every(
      (card) => this.cardAvailability(card) >= 1 - PROBABILITY_EPSILON
    );
    if (!allCertain) return false;
    return Math.abs(
      Math.max(0, Number(player.handCount) || 0) - player.hand.length
    ) <= PROBABILITY_EPSILON;
  }

  /**
   * 按共享保留价值定向消费已知手牌：护援反事实中 responder 自己的手牌身份合法可见，
   * 因此应选择最低 keep-value 的牌，而不是把已知手牌当作随机损失。
   * 只用于明确由 AI 自主选牌支付的路径；真正随机的弃牌/未知损失仍走 consumeRandomHandCards。
   */
  consumeChosenHandCard(state, player, spend, options = {}) {
    let remaining = Math.max(0, Number(spend) || 0);
    let totalSpent = 0;
    const result = options.result ?? null;
    while (remaining > PROBABILITY_EPSILON && (player.handCount ?? 0) > PROBABILITY_EPSILON) {
      const context = this.buildDiscardKeepValueContext(state, player);
      const candidates = player.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON)
        .sort((left, right) => (
          getDiscardKeepValue(player, left, context) - getDiscardKeepValue(player, right, context)
        ));
      if (!candidates.length) break;
      const chosen = candidates[0];
      const availableProbability = this.cardAvailability(chosen);
      const spent = Math.min(1, remaining, availableProbability);
      const spendWorlds = this.getEventWorlds(
        state,
        Math.min(1, spent / availableProbability),
        null,
        `guardian-aid-discard:${player.id}:${chosen.id}`
      );
      const removalPartition = spendWorlds.map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        removed: Boolean(branch.occurs)
      }));
      const availabilityState = getAvailabilityStateBranches(chosen).map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        available: Boolean(branch.available)
      }));
      const joinedAvailability = joinProbabilityStateBranches(availabilityState, removalPartition);
      chosen.availabilityStateBranches = projectProbabilityStateBranches(joinedAvailability, (branch) => ({
        available: Boolean(branch.available && !branch.removed)
      }));
      chosen.availabilityBranches = availableBranchesFromState(chosen.availabilityStateBranches);
      if (chosen.definitionId === "block") this.removeKnownBlockFromDistribution(state, player, spendWorlds);
      if (chosen.definitionId === "counter") this.removeKnownCounterFromDistribution(state, player, spendWorlds);
      if (chosen.definitionId === "assault") {
        const assaultState = this.syncAssaultSummary(player).map((branch) => ({
          probability: branch.probability,
          conditions: branch.conditions,
          count: branch.count
        }));
        const joinedAssault = joinProbabilityStateBranches(assaultState, removalPartition);
        player.assaultCountDistribution = projectProbabilityStateBranches(joinedAssault, (branch) => ({
          count: Math.max(0, branch.count - (branch.removed && branch.count > 0 ? 1 : 0))
        }));
        this.syncAssaultSummary(player);
      }
      if (chosen.definitionId === "recover") {
        player.expectedRecoverCount = Math.max(
          0,
          (player.expectedRecoverCount ?? 0) - this.eventProbability(spendWorlds)
        );
      }
      if (Array.isArray(player.hand)) {
        player.hand = player.hand.filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON);
      }
      player.handCount = Math.max(0, (player.handCount ?? 0) - spent);
      this.clearCountersWhenHandEmpty(player);
      if (result) {
        result.guardianAidDiscards ??= [];
        result.guardianAidDiscards.push({
          cardId: chosen.id ?? null,
          definitionId: chosen.definitionId
        });
      }
      remaining -= spent;
      totalSpent += spent;
    }
    return totalSpent;
  }

  /**
   * 连势与类别首次使用都沿用动作/伤害的完整条件世界。命中生命时先消费旧连势，
   * 随后的 cardUsed 若是该类别首次使用再获得1层；未命中世界保留旧层并正常叠层。
   */
  simulateCategoryUse(state, player, category, useResolution = 1, lifeDamageResolution = null) {
    if (!category || player?.generalId !== "blade-walker") return 0;
    this.initializeMomentumBranches({ players:[player] });
    const useWorlds = Array.isArray(useResolution)
      ? this.getEventWorlds(state, 1, useResolution, `momentum-use:${player.id}:${category}`)
      : this.getEventWorlds(state, clampProbability(useResolution), null,
        `momentum-use:${player.id}:${category}`);
    const lifeDamageWorlds = Array.isArray(lifeDamageResolution)
      ? this.getEventWorlds(state, 1, lifeDamageResolution,
        `momentum-life-damage:${player.id}:${category}`)
      : this.getEventWorlds(state, clampProbability(lifeDamageResolution), null,
        `momentum-life-damage:${player.id}:${category}`);
    const momentumState = this.syncMomentumSummary(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      momentumAmount:branch.amount
    }));
    const categoryState = this.syncCategoryUsedSummary(player, category).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      categoryUsed:Boolean(branch.used)
    }));
    const joined = joinProbabilityStateBranches(
      momentumState,
      categoryState,
      useWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        cardUsed:Boolean(branch.occurs)
      })),
      lifeDamageWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        lifeDamage:Boolean(branch.occurs)
      }))
    );
    const firstUseProbability = totalBranchProbability(
      joined.filter((branch) => branch.cardUsed && !branch.categoryUsed)
    );
    player.momentumBranches = projectProbabilityStateBranches(joined, (branch) => {
      if (!branch.cardUsed) return { amount:branch.momentumAmount };
      const retained = branch.lifeDamage ? 0 : branch.momentumAmount;
      return {
        amount:Math.min(GAME_CONFIG.momentumMaxStacks,
          retained + (!branch.categoryUsed ? 1 : 0))
      };
    });
    player.categoryUsedStateBranchesByCategory[category] = projectProbabilityStateBranches(
      joined,
      (branch) => ({ used:Boolean(branch.categoryUsed || branch.cardUsed) })
    );
    this.syncMomentumSummary(player);
    this.syncCategoryUsedSummary(player, category);
    return firstUseProbability;
  }

  simulateGamble(state, actor, card, useProbability) {
    if (actor?.generalId !== "fate-gambler" || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const gambleWorlds = this.getEventWorlds(state, triggerProbability, null, "gamble-draw");
      this.gainUnknownCardsWithCounterState(
        state, actor, triggerProbability * GAME_CONFIG.gamblerDrawChance, gambleWorlds, "gamble-draw"
      );
    }
    return triggerProbability;
  }

  simulateCoordination(state, actor, effectiveTargets, resolutionProbability) {
    if (actor?.generalId !== "resonance-tuner") return 0;
    if (!(effectiveTargets ?? []).some((target) => target?.alive && target.id !== actor.id
      && target.battleTeam === actor.battleTeam)) return 0;
    const oldProbability = clampProbability(actor.coordinationTriggeredProbability
      ?? (actor.coordinationTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, resolutionProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.coordinationTriggeredProbability = newProbability;
    actor.coordinationTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const coordinationWorlds = this.getEventWorlds(state, triggerProbability, null, "coordination-draw");
      this.gainUnknownCardsWithCounterState(
        state, actor, triggerProbability, coordinationWorlds, "coordination-draw"
      );
    }
    return triggerProbability;
  }

  seatOrderFrom(state, source, includeSource = false) {
    const players = state?.players ?? [];
    const seatCount = Math.max(1, players.length);
    const sourceSeat = Number(source?.seatIndex) || 0;
    return players.filter((player) => player.alive && (includeSource || player.id !== source.id))
      .sort((left, right) => {
        const leftDistance = ((Number(left.seatIndex) || 0) - sourceSeat + seatCount) % seatCount;
        const rightDistance = ((Number(right.seatIndex) || 0) - sourceSeat + seatCount) % seatCount;
        return leftDistance - rightDistance;
      });
  }

  /** 目标指定阶段的猎印概率使用联合概率；同一猎手每回合最多留下两次猎印。 */
  simulateTracking(state, source, target, eventWorlds) {
    if (source.generalId !== "trail-hunter" || target.battleTeam === source.battleTeam) return;
    source.trackingTargetIds ??= [];
    // 同一敌人本回合只能触发一次；猎杀移除标记也不会返还该次追踪额度。
    if (source.trackingTargetIds.includes(target.id)) return;
    source.trackingUses ??= source.trackingTargetIds.length;
    target.huntMarkProbabilities ??= {};
    const oldProbability = clampProbability(target.huntMarkProbabilities[source.id]
      ?? (target.huntMarkSourceId === source.id ? 1 : 0));
    const remainingUses = Math.max(0, 2 - source.trackingUses);
    const limitedEventWorlds = this.eventProbability(eventWorlds) <= remainingUses + PROBABILITY_EPSILON
      ? eventWorlds
      : this.gateEventWorlds(state, eventWorlds,
        remainingUses / this.eventProbability(eventWorlds), `tracking-limit:${source.id}:${target.id}`);
    const existingBranches = target.huntMarkStateBranchesBySource?.[source.id]
      ?? probabilityEventPartition(
        this.nextProbabilityEventKey(state, `hunt-mark-existing:${source.id}:${target.id}`),
        oldProbability,
        "marked"
      );
    const joined = joinProbabilityStateBranches(existingBranches, limitedEventWorlds);
    const markState = projectProbabilityStateBranches(joined, (branch) => ({
      marked:Boolean(branch.marked || branch.occurs)
    }));
    const markProbability = totalBranchProbability(markState.filter((branch) => branch.marked));
    const gainedProbability = Math.max(0, markProbability - oldProbability);
    target.huntMarkStateBranchesBySource ??= {};
    target.huntMarkStateBranchesBySource[source.id] = markState;
    target.huntMarkProbabilities[source.id] = markProbability;
    target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities).map(clampProbability));
    source.trackingUses += gainedProbability;
    if (markProbability >= 1 - Number.EPSILON && !source.trackingTargetIds.includes(target.id)) {
      source.trackingTargetIds.push(target.id);
      target.huntMarkSourceId = source.id;
      if (Array.isArray(target.statuses) && !target.statuses.includes("huntMark")) target.statuses.push("huntMark");
    }
  }

  /**
   * 护援只作用于通过雷达与格挡的伤害世界，并在护盾前计算弃牌与每轮次数的期望代价。
   * excludedGuardianIds 让调用方（护援响应决策）在 STAY 世界按 id 排除某位守誓者，
   * 使其拒绝护援、额度与手牌保留，而不为此另建第二套防御模拟。
   * 当守护者拥有完整且 100% 确定的手牌身份时，按共享保留价值确定性弃掉最低
   * keep-value 的牌；概率/匿名/身份不完整的手牌仍走随机期望消费。
   */
  simulateGuardianAid(state, target, incomingDamage, eventProbability, excludedGuardianIds = null, options = {}) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) return Math.max(0, incomingDamage);
    const conditionalReduction = Math.min(1, incomingDamage / probability);
    let remainingTriggerProbability = probability;
    let expectedReduction = 0;
    for (const guardian of state.players) {
      if (remainingTriggerProbability <= PROBABILITY_EPSILON) break;
      if (excludedGuardianIds?.has(guardian.id)) continue;
      if (!guardian.alive || guardian.generalId !== "oath-warden" || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const oldUsedProbability = clampProbability(guardian.guardianAidUsedProbability
        ?? (guardian.guardianAidUsed ? 1 : 0));
      const handAvailability = Math.min(1, Math.max(0, Number(guardian.handCount) || 0));
      const triggerProbability = remainingTriggerProbability * (1 - oldUsedProbability) * handAvailability;
      if (triggerProbability <= 0) continue;
      if (this.hasCompleteCertainHand(guardian)) {
        this.consumeChosenHandCard(state, guardian, triggerProbability, options);
      } else {
        this.consumeRandomHandCards(state, guardian, triggerProbability);
      }
      guardian.guardianAidUsedProbability = clampProbability(oldUsedProbability + triggerProbability);
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - Number.EPSILON;
      expectedReduction += triggerProbability * conditionalReduction;
      remainingTriggerProbability = Math.max(0, remainingTriggerProbability - triggerProbability);
    }
    return Math.max(0, incomingDamage - expectedReduction);
  }

  /** 统一处理实际生命伤害后的角色收益。 */
  simulateAfterLifeDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null, damageContext = {}) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target) return;
    if (damageContext.cardDamage && source.generalId === "ember-magus"
      && target.battleTeam !== source.battleTeam) {
      damageContext.emberTriggeredProbabilities ??= {};
      const oldProbability = clampProbability(damageContext.emberTriggeredProbabilities[source.id]);
      const newProbability = unionProbability(oldProbability, chance);
      damageContext.emberTriggeredProbabilities[source.id] = newProbability;
      damageContext.emberBaseEnergyBranches ??= {};
      damageContext.emberBaseEnergyBranches[source.id] ??= getValueBranches(source, "energy", source.energy);
      if (newProbability > oldProbability + PROBABILITY_EPSILON) {
        const triggerWorlds = oldProbability <= PROBABILITY_EPSILON && lifeDamageBranches
          ? lifeDamageBranches
          : probabilityEventPartition(
            this.nextProbabilityEventKey(state, `ember-resolution:${source.id}`),
            newProbability,
            "occurs"
          );
        const baseEnergy = damageContext.emberBaseEnergyBranches[source.id].map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          baseEnergyAmount:branch.amount
        }));
        const joined = joinProbabilityStateBranches(baseEnergy, triggerWorlds);
        source.energyBranches = projectProbabilityStateBranches(joined, (branch) => ({
          amount:Math.max(0, Math.min(source.maxEnergy ?? Infinity,
            branch.baseEnergyAmount + (branch.occurs ? 1 : 0)))
        }));
        source.energy = expectedBranchValue(source.energyBranches);
      }
    }
  }

  /** 濒死救援结算后再结算窥隙，避免目标获救后继续存活时被漏算。 */
  simulateSpyGapAfterLifeDamage(state, source, target, lifeDamageProbability) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target?.alive || target.hp <= 0
      || target.battleTeam === source.battleTeam || (target.handCount ?? 0) <= 0
      || source.generalId !== "shade-agent") return;
    const oldTriggeredProbability = clampProbability(source.spyGapTriggeredProbability
      ?? (source.spyGapTriggered ? 1 : 0));
    const triggerProbability = (1 - oldTriggeredProbability) * chance;
    source.spyGapTriggeredProbability = unionProbability(oldTriggeredProbability, chance);
    source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
    source.expectedInformationGain = (source.expectedInformationGain ?? 0)
      + Math.min(2, target.handCount) * triggerProbability;
  }

  simulateAssaultAfterDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null) {
    return this.simulateAfterLifeDamage(state, source, target, lifeDamageProbability,
      lifeDamageBranches, { cardDamage:true, emberTriggeredProbabilities:{} });
  }

  /** 普通突袭与借势响应共用同一次数槽、伤害与后续收益结算入口。 */
  simulateAssault(state, source, target, resolution = 1, options = {}) {
    const desiredWorlds = Array.isArray(resolution)
      ? this.getEventWorlds(state, 1, resolution, `assault:${source.id}:${target.id}`)
      : this.getEventWorlds(state, clampProbability(resolution), null, `assault:${source.id}:${target.id}`);
    const tracksAttackSlots = Array.isArray(source.attackUseSlots) || Number.isFinite(Number(source.attackLimit));
    const assaultWorlds = options.attackUseConsumed || !tracksAttackSlots
      ? desiredWorlds
      : this.consumeAttackUse(state, source, desiredWorlds, options.attackUseSlot).eventWorlds;
    const chance = this.eventProbability(assaultWorlds);
    if (!chance || !source?.alive || !target?.alive) return 0;
    if (!tracksAttackSlots && !options.attackUseConsumed) {
      source.attackUsed = (source.attackUsed ?? 0) + chance;
    }
    this.simulateTracking(state, source, target, assaultWorlds);
    const momentumBranches = source.generalId === "blade-walker"
      ? this.syncMomentumSummary(source)
      : [{ probability:1, conditions:{}, amount:0 }];
    const damageOutcome = {};
    const baseDamage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0);
    const damageBranches = momentumBranches.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      amount:baseDamage + branch.amount
    }));
    const damage = expectedBranchValue(damageBranches);
    this.applyDamage(state, source, target, damage, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:assaultWorlds,
      amountBranches:damageBranches,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined,
      damageContext:options.damageContext ?? { cardDamage:true, emberTriggeredProbabilities:{} }
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    this.simulateCategoryUse(
      state, source, "basic", assaultWorlds, damageOutcome.lifeDamageBranches ?? null
    );
    return lifeDamageChance;
  }

  takeResourceToHand(state, actor, target, resolution = 1, label = "plunder-resource") {
    if (!Array.isArray(state?.players)) {
      resolution = target ?? 1;
      target = actor;
      actor = state;
      state = { players:[actor, target] };
    }
    const effectWorlds = this.normalizeResourceEffectWorlds(state, resolution, label);
    const selection = this.chooseSimulatedResourceSelection(state, actor, target, "plunder");
    if (!selection) return 0;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const equipmentTransferWorlds = this.gateEventWorlds(
        state,
        effectWorlds,
        existenceProbability,
        `equipment-transfer:${target.id ?? "unknown"}:${selection.definitionId}`
      );
      const transferProbability = this.eventProbability(equipmentTransferWorlds);
      if (transferProbability > PROBABILITY_EPSILON) {
        this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - transferProbability);
        this.addSimulatedCardToHand(state, actor, { definitionId: selection.definitionId }, equipmentTransferWorlds);
      }
      return transferProbability;
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON) {
        const acquisitionProbability = this.eventProbability(effectWorlds);
        if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
        if (selection.definitionId === "block") {
          this.removeKnownBlockFromDistribution(state, target, effectWorlds);
        }
        if (selection.definitionId === "counter") {
          this.removeKnownCounterFromDistribution(state, target, effectWorlds);
        }
        entry.availabilityStateBranches = projectProbabilityStateBranches(effectWorlds, (branch) => ({
          available:Boolean(!branch.occurs)
        }));
        entry.availabilityBranches = availableBranchesFromState(entry.availabilityStateBranches);
        if (totalBranchProbability(entry.availabilityBranches) <= PROBABILITY_EPSILON) {
          target.knownCards = target.knownCards.filter((item) => item !== entry);
        }
        target.handCount = Math.max(0, (target.handCount ?? 0) - acquisitionProbability);
        this.syncCardEstimates(target, state?.remainingCardCounts);
        this.addSimulatedCardToHand(state, actor, {
          id: selection.cardId,
          definitionId: selection.definitionId
        }, effectWorlds);
        return acquisitionProbability;
      }
      const transferred = this.consumeRandomHandCards(state, target, this.eventProbability(effectWorlds));
      actor.handCount = (actor.handCount ?? 0) + transferred;
      return transferred;
    } else if (selection.zone === "hand") {
      return this.transferUnknownBlockCapacity(
        state,
        target,
        actor,
        effectWorlds,
        selection.availableUnknownCount
      );
    }
    return 0;
  }

  /**
   * 同步破坏的手牌/装备区域选择；确定已知牌按 cardId 定向移除，
   * 部分概率保留互补可用分支，未知牌继续走聚合随机消耗。
   */
  destroyResource(state, actor, target, resolution = 1, label = "destroy-resource") {
    if (!Array.isArray(state?.players)) {
      throw new Error("destroyResource 需要 state、actor、target、scale 完整签名");
    }
    const effectWorlds = this.normalizeResourceEffectWorlds(state, resolution, label);
    const selection = this.chooseSimulatedResourceSelection(state, actor, target, "destroy");
    if (!selection) return 0;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const removalProbability = existenceProbability * this.eventProbability(effectWorlds);
      this.setSimulatedEquipment(target, target.equipmentDefinitionId,
        existenceProbability * (1 - this.eventProbability(effectWorlds)));
      return removalProbability;
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON) {
        const removalProbability = this.eventProbability(effectWorlds);
        if (removalProbability <= PROBABILITY_EPSILON) return 0;
        if (selection.definitionId === "block") {
          this.removeKnownBlockFromDistribution(state, target, effectWorlds);
        }
        if (selection.definitionId === "counter") {
          this.removeKnownCounterFromDistribution(state, target, effectWorlds);
        }
        entry.availabilityStateBranches = projectProbabilityStateBranches(effectWorlds, (branch) => ({
          available:Boolean(!branch.occurs)
        }));
        entry.availabilityBranches = availableBranchesFromState(entry.availabilityStateBranches);
        if (totalBranchProbability(entry.availabilityBranches) <= PROBABILITY_EPSILON) {
          target.knownCards = target.knownCards.filter((item) => item !== entry);
        }
        target.handCount = Math.max(0, (target.handCount ?? 0) - removalProbability);
        this.syncCardEstimates(target, state?.remainingCardCounts);
        return removalProbability;
      }
      return this.consumeRandomHandCards(state, target, this.eventProbability(effectWorlds));
    } else if (selection.zone === "hand") {
      return this.consumeUnknownResourceCard(
        state,
        target,
        this.eventProbability(effectWorlds),
        selection.availableUnknownCount,
        effectWorlds
      );
    }
    return 0;
  }

  tacticResolutionChance(state, actor, card, targets = [], selection = null) {
    if (card.category !== "tactic" || card.counterable === false) return 1;
    return this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection).resolutionChance;
  }

  /**
   * 同一 card-scope transition 的响应评估快照。
   *
   * responder 顺序严格沿用 state.players；effectiveProbability 同时决定边际取消概率
   * 与对应玩家的期望容量消费。结果只在当前 apply 调用内传递，不跨状态缓存。
   */
  evaluateCardScopeCounterResponses(state, actor, card, targets = [], selection = null) {
    const contenders = [];
    let resolutionChance = 1;
    for (const player of state.players) {
      if (!player.alive || player.id === actor.id) continue;
      const counterProbability = clampProbability(player.counterProbability ?? 0);
      const desire = this.counterDesire(state, player, actor, card, targets, selection);
      const effectiveProbability = clampProbability(counterProbability * desire);
      contenders.push({ player, counterProbability, desire, effectiveProbability });
      resolutionChance *= 1 - effectiveProbability;
    }
    return { resolutionChance, contenders };
  }

  /**
   * card-scope 战术的反制容量消费（反制容量双算修复）。
   *
   * 按"第一个成功反制者"把取消概率归属到对应敌人，并按边际概率扣减其反制容量：
   *   marginal(e) = Π_{f before e}(1 - p_f) × p_e，p_e = counterProbability_e × desire_e
   * 消费量守恒：Σ marginal(e) = 1 - Π(1 - p_e) = 取消概率（与 tacticResolutionChance 一致）。
   * 只消费实际可能反制的玩家（p > 0）；与 tacticResolutionChance 使用相同的响应顺序。
   */
  consumeCountersForCardScope(state, actor, card, targets, selection = null, responseEvaluation = null) {
    const evaluation = responseEvaluation
      ?? this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection);
    let notYetCancelled = 1;
    for (const { player, effectiveProbability } of evaluation.contenders) {
      const p = effectiveProbability;
      if (p <= PROBABILITY_EPSILON) continue;
      const marginal = notYetCancelled * p;
      if (marginal > PROBABILITY_EPSILON) {
        this.consumeExpectedCounters(state, player, marginal);
      }
      notYetCancelled *= 1 - p;
      if (notYetCancelled <= PROBABILITY_EPSILON) break;
    }
  }

  /**
   * 按期望数量消费一名玩家的反制容量（card-scope 概率近似中的"反制实际使用"）。
   *
   * 只扣减反制数量分布（counterCountDistribution → counterProbability）：这是
   * counterProbability 与 sealCounterProbability 的唯一来源，扣减后未来反制预期
   * 自然归零，消除"取消战术"与"封印反制"对同一张反制的重复计价。
   *
   * 不改动 handCount 与具体反制身份：card-scope 的反制本就是概率近似（敌手未必
   * 真持有反制卡），泛用手牌资源与具体身份由 target-scope 的真实消费路径处理，
   * 避免在这里对概率近似事件产生与真实消费重复的资源/身份记账。
   *
   * 期望扣减守恒：在 counterCount>=1 的世界内按条件概率 amount / P(count>=1)
   * 消费 1 张，总期望扣减恰等于 amount，且不会在无反制的世界浪费移除。
   */
  consumeExpectedCounters(state, player, expectedAmount) {
    const amount = Math.min(Math.max(0, Number(expectedAmount) || 0), 1);
    if (amount <= PROBABILITY_EPSILON || !player) return 0;
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const existence = counterState.reduce((sum, branch) => sum + (branch.counterCount >= 1 ? branch.probability : 0), 0);
    if (existence <= PROBABILITY_EPSILON) return 0;
    const conditional = Math.min(1, amount / existence);
    if (conditional <= PROBABILITY_EPSILON) return 0;
    const gate = probabilityEventPartition(
      this.nextProbabilityEventKey(state, `card-scope-counter:${player.id}`), conditional, "counterUsed"
    );
    const joined = joinProbabilityStateBranches(counterState, gate);
    player.counterCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      counterCount: Boolean(branch.counterUsed) && branch.counterCount >= 1
        ? Math.max(0, branch.counterCount - 1)
        : branch.counterCount
    }));
    this.syncCounterSummary(player);
    return totalBranchProbability(projectProbabilityStateBranches(joined, (branch) => ({
      occurs: Boolean(branch.counterUsed) && branch.counterCount >= 1
    })).filter((branch) => branch.occurs));
  }

  targetResolutionChance(state, actor, card, target) {
    if (card.category !== "tactic" || card.counterable === false || card.counterScope !== "target") return 1;
    return 1 - (target.counterProbability ?? 0) * this.counterDesire(state, target, actor, card, [target]);
  }

  counterDesire(state, responder, actor, card, targets, selection = null) {
    // 全体受益牌共用真实响应策略的 root-outcome 判断：actor 即 root source，规划模拟
    // 中只评估首张反制（depth=0），其余与真实策略同语义。
    const globalBenefitDesire = globalBenefitCounterDesire(state.players, responder.battleTeam, card.definitionId, {
      rootSourceId: actor?.id ?? null,
      counterDepth: 0,
      remainingCardCounts: state?.remainingCardCounts ?? null
    });
    if (globalBenefitDesire !== null) return globalBenefitDesire;
    // root 结算模拟内部（resolveRootState 的嵌套 apply）不再评估二次反制，直接返回 0，
    // 避免目标级 root 的群伤循环与动态估值相互递归。
    if (this._simulatingRootResolution) return 0;
    // 没有反制容量时意愿必为 0：避免对无牌玩家重复构建 root 效果估值（昂贵且无意义）。
    // 容量以 counterCountDistribution（可能条件分布）与 counterProbability 任一为准。
    const hasCounter = (responder.counterCountDistribution ?? [])
      .some((branch) => (branch.counterCount ?? 0) >= 1 && (branch.probability ?? 0) > 0)
      || (responder.counterProbability ?? 0) > 0;
    if (!hasCounter) return 0;
    // 其余真实可反制牌统一走 dynamic root-outcome 经济比较：反制意愿 = clamp(gain / cost)。
    // 这是把真实侧布尔经济决策投影为规划概率的唯一映射，不再使用 card.aiValue / target team
    // 拼成的第二套启发式；规划与真实响应从同一 root 效果价值来源取值。
    const gain = this.dynamicCounterGain(state, responder, actor, card, targets, selection);
    if (!Number.isFinite(gain)) return 0;
    return clampProbability(gain / counterOpportunityCost());
  }

  /**
   * 规划侧 dynamic root 估值（depth=0，root 生效 → 反制即取消，gain = -rootEffectValue）。
   *
   * 与真实侧 dynamicRootFlipGain 使用同一 root 效果价值来源（同一经济单位与 stay/flip
   * 语义）。规划搜索热路径会以高频率调用本函数，不能承担真实侧"克隆完整状态 + apply +
   * 全量 stateUtility"的代价，因此这里提供同一经济语义的轻量估值：直接按当前可见状态的
   * 字段计算各 effect family 的效果价值（手牌×1.1、HP×HP_VALUE、信息×0.35、能量×1.2、
   * 层数×1.5 与角色身份差量，均与 AiEvaluator.playerValueTerms 同单位），并保留资源牌
   * 剥夺敌方攻击能力带来的威胁折算。它是对真实侧 rootEffectValue 的轻量近似，不是另一
   * 套决策模型；是否反制的总决策仍统一为 clamp(gain / cost)。
   */
  dynamicCounterGain(state, responder, actor, card, targets, selection = null) {
    const definitionId = card?.definitionId;
    if (!definitionId) return 0;
    const team = responder.battleTeam;
    const actorEnemy = actor?.battleTeam !== team;
    // 队友打出的卡牌对所有 family 的收益都为负（反制只会让己方更差），desire 必为 0；
    // 这里直接短路，避免为半数响应者重复走 switch（规划热路径开销）。
    if (!actorEnemy) return 0;
    const target = (targets ?? []).find((entry) => entry?.id)
      ? state.players.find((player) => player.id === targets[0].id) : null;
    const hasResource = (player) => Number(player?.handCount ?? 0) > 0 || Boolean(player?.equipmentDefinitionId);
    const knownAssault = (player) => Array.isArray(player?.knownCards)
      && player.knownCards.some((entry) => entry.definitionId === "assault");

    switch (definitionId) {
      case "shockwave": {
        // 目标级反制：防止对当前目标 1 点可格挡伤害（盾吸收、格挡概率折算）。
        if (!target?.alive) return 0;
        const blockChance = Math.min(1, Number(target.blockProbability) || 0);
        return HP_VALUE * (1 - blockChance) * (Number(target.shield) >= 1 ? 0 : 1);
      }
      case "provoke": {
        // 无突袭可出则受 1 伤；有突袭则消耗突袭（价值在此处不高于反制成本）。
        if (!target?.alive) return 0;
        return (Number(target.assaultResponseProbability) || 0) > 0 ? 1.1 : HP_VALUE;
      }
      case "duel": {
        if (!target?.alive) return 0;
        // 决斗中双方轮流突袭，先放弃者受 1 伤；目标无突袭时更可能受伤。
        return HP_VALUE * ((Number(target.assaultResponseProbability) || 0) > 0 ? 0.5 : 1);
      }
      case "scout": {
        if (!target?.alive) return 0;
        const knownCount = Array.isArray(target.knownCards) ? target.knownCards.length : 0;
        const unknownCount = Math.max(0, Number(target.handCount) - knownCount);
        const info = Math.min(2, unknownCount) * 0.35;
        return actorEnemy ? info : -info;
      }
      case "harvest":
        return actorEnemy ? 2 * 1.1 : -2 * 1.1;
      case "charge":
        return actorEnemy ? 1.2 : -1.2;
      case "exposeWeakness":
        return actorEnemy ? 1.5 : -1.5;
      case "plunder": {
        if (!target?.alive || !hasResource(target)) return 0;
        // 目标失去 1 张、施放者获得 1 张（generic 双方各 1.1）；若拿走的是已知突袭，
        // 敌方施放者的攻击威胁上升，折算 HP_VALUE 威胁价值。
        const threat = actorEnemy && knownAssault(target) ? HP_VALUE : 0;
        return actorEnemy ? 2.2 + threat : -(2.2 + threat);
      }
      case "destroy": {
        if (!target?.alive || !hasResource(target)) return 0;
        // 目标失去 1 张（generic 1.1）；目标是己方且其已知突袭被毁时威胁下降。
        const threat = !actorEnemy && knownAssault(target) ? HP_VALUE : 0;
        return (target.battleTeam === team ? 1.1 + threat : 1.1) * (actorEnemy ? 1 : -1);
      }
      case "transfer": {
        // 转移把 1 张手牌从来源移到接收者：generic 双方各 1.1，方向由施放者阵营决定。
        return actorEnemy ? 2.2 : -2.2;
      }
      case "seal":
        return actorEnemy ? 2.8 : -2.8;
      case "lightning":
        return actorEnemy ? 2.8 : -2.8;
      case "leverage":
        // 借势的收益取决于第一目标是否仍持有装备与合法突袭目标；此处只估算装备转移价值。
        if (!target?.alive) return 0;
        return actorEnemy && target.equipmentDefinitionId ? 2 : -2;
      default:
        // 所有真实可反制战术牌都在上方 family 中显式建模；未建模的新卡安全回退为 0，
        // 不允许回退到 aiValue / target team 拼启发式（统一经济比较才是唯一决策来源）。
        return 0;
    }
  }

  applySkill(state, actor, action, eventWorlds) {
    const skill = action.skill;
    const target = state.players.find((player) => player.id === action.targets?.[0]?.id);
    const chance = this.eventProbability(eventWorlds);
    if (!skill || chance <= 0) return;
    if (skill.id === "allIn") {
      const joined = this.updateEnergyFromWorlds(actor, eventWorlds, (amount, branch) => (
        branch.occurs ? 0 : amount
      ));
      this.gainUnknownCardsWithCounterState(
        state,
        actor,
        (branch) => (branch.occurs ? Math.max(0, branch.energyAmount - 1) : 0),
        joined,
        "allIn-draw"
      );
      const currentAssaultBonus = actor.assaultBonus ?? 0;
      const joinedExpectedValue = joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * Math.min(1, branch.energyAmount * .25) : 0)
      ), 0);
      actor.assaultBonus = currentAssaultBonus + joinedExpectedValue * (1 - currentAssaultBonus);
      return;
    }
    const energyCost = action.energyCost ?? getActiveSkillCost(state, actor, skill);
    this.changeEnergy(state, actor, -energyCost, eventWorlds);
    if (skill.id === "breakArmy") {
      const attackSlots = this.ensureAttackUseSlots(actor);
      attackSlots.push(projectProbabilityStateBranches(eventWorlds, (branch) => ({
        available:Boolean(branch.occurs)
      })));
      actor.attackLimit = (actor.attackLimit ?? attackSlots.length - 1) + chance;
      actor.attackAvailabilityBranches = attackSlots.map(availableBranchesFromState);
    }
    else if (skill.id === "barrier" && target) {
      this.changeShield(state, target, 1, eventWorlds);
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(state, actor, target, chance);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, 1, { canBlock:true, eventBranches:eventWorlds });
      }
    } else if (skill.id === "hunt" && target) {
      target.huntMarkProbabilities ??= {};
      const oldMarkProbability = clampProbability(target.huntMarkProbabilities[actor.id]
        ?? (target.huntMarkSourceId === actor.id ? 1 : 0));
      const consumedMarkProbability = Math.min(oldMarkProbability, chance);
      const markBranches = target.huntMarkStateBranchesBySource?.[actor.id];
      if (Array.isArray(markBranches)) {
        const markedState = markBranches.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          marked:Boolean(branch.marked)
        }));
        const joinedMarks = joinProbabilityStateBranches(markedState, eventWorlds);
        target.huntMarkStateBranchesBySource[actor.id] = projectProbabilityStateBranches(
          joinedMarks,
          (branch) => ({ marked:Boolean(branch.marked && !branch.occurs) })
        );
        target.huntMarkProbabilities[actor.id] = totalBranchProbability(
          target.huntMarkStateBranchesBySource[actor.id].filter((branch) => branch.marked)
        );
      } else {
        target.huntMarkProbabilities[actor.id] = Math.max(0, oldMarkProbability - consumedMarkProbability);
      }
      target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities ?? {}).map(clampProbability));
      const fullMarkSource = Object.entries(target.huntMarkProbabilities)
        .find(([, probability]) => clampProbability(probability) >= 1 - Number.EPSILON)?.[0] ?? null;
      target.huntMarkSourceId = fullMarkSource;
      if (Array.isArray(target.statuses) && !fullMarkSource) {
        target.statuses = target.statuses.filter((status) => status !== "huntMark");
      }
      const outcome = {};
      this.applyDamage(state, actor, target, 2, {
        canBlock:true,
        eventBranches:consumedMarkProbability >= chance - PROBABILITY_EPSILON
          ? eventWorlds
          : this.gateEventWorlds(state, eventWorlds,
            chance > 0 ? consumedMarkProbability / chance : 0,
            `hunt-mark:${actor.id}:${target.id}`),
        outcome
      });
      if ((outcome.blockedByCardChance ?? 0) > PROBABILITY_EPSILON) {
        this.gainUnknownCardsWithCounterState(
          state, actor, outcome.blockedByCardChance, null, "hunt-blocked-draw"
        );
      }
    } else if (skill.id === "resonance" && target) {
      this.gainUnknownCardsWithCounterState(state, target, 1, eventWorlds, "resonance-draw");
    }
  }

  /** 窃取所得资源只增加手牌；目标仅有装备时，模拟中明确移除装备且不替换施术者装备。 */
  stealResourceToHand(state, actor, target, scale = 1) {
    if (!Array.isArray(state?.players)) {
      scale = target ?? 1;
      target = actor;
      actor = state;
      state = { players:[actor, target] };
    }
    const chance = clampProbability(scale);
    const handCount = Math.max(0, target.handCount ?? 0);
    const existenceProbability = this.getSimulatedEquipmentProbability(target);
    if ((!handCount && !existenceProbability) || chance <= 0) return;
    const equipmentLossProbability = existenceProbability / (handCount + 1) * chance;
    const handLoss = handCount > 0 ? (1 - existenceProbability / (handCount + 1)) * chance : 0;
    const gainProbability = (handCount > 0 ? 1 : existenceProbability) * chance;
    actor.handCount = (actor.handCount ?? 0) + gainProbability;
    const result = { counterRemovedWorlds: [] };
    this.consumeRandomHandCards(state, target, handLoss, { result });
    // 只有实际窃取到目标手牌且该手牌是反制的世界才转移反制容量；
    // 复用来源随机失牌已经决定的 counterRemoved 世界，不重新按根先验猜测。
    for (const partition of result.counterRemovedWorlds) {
      this.addTransferredCounterCapacity(state, actor, partition);
    }
    this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - equipmentLossProbability);
  }

  applyDuel(state, actor, target, scale, damageContext = { cardDamage:true, emberTriggeredProbabilities:{} }) {
    const resolutionProbability = clampProbability(scale);
    const actorDistribution = this.syncAssaultSummary(actor);
    const targetDistribution = this.syncAssaultSummary(target);
    const actorRemaining = new Map();
    const targetRemaining = new Map();
    const addBranch = (map, count, probability) => {
      if (probability <= PROBABILITY_EPSILON) return;
      map.set(count, (map.get(count) ?? 0) + probability);
    };
    for (const branch of actorDistribution) addBranch(
      actorRemaining, branch.count, branch.probability * (1 - resolutionProbability)
    );
    for (const branch of targetDistribution) addBranch(
      targetRemaining, branch.count, branch.probability * (1 - resolutionProbability)
    );

    let actorLoseProbability = 0;
    let targetLoseProbability = 0;
    let expectedActorSpent = 0;
    let expectedTargetSpent = 0;
    for (const actorBranch of actorDistribution) {
      for (const targetBranch of targetDistribution) {
        const probability = actorBranch.probability * targetBranch.probability * resolutionProbability;
        if (probability <= PROBABILITY_EPSILON) continue;
        const actorCount = actorBranch.count;
        const targetCount = targetBranch.count;
        const targetLoses = targetCount <= actorCount;
        const actorSpent = Math.min(actorCount, targetCount);
        const targetSpent = Math.min(targetCount, actorCount + 1);
        expectedActorSpent += probability * actorSpent;
        expectedTargetSpent += probability * targetSpent;
        if (targetLoses) targetLoseProbability += probability;
        else actorLoseProbability += probability;
        addBranch(actorRemaining, actorCount - actorSpent, probability);
        addBranch(targetRemaining, targetCount - targetSpent, probability);
      }
    }

    const toDistribution = (map) => [...map.entries()].map(([count, probability]) => ({ count, probability }));
    const actorRemainingDistribution = this.syncAssaultSummary(actor, toDistribution(actorRemaining));
    const targetRemainingDistribution = this.syncAssaultSummary(target, toDistribution(targetRemaining));
    actor.handCount = Math.max(0, actor.handCount - expectedActorSpent);
    target.handCount = Math.max(0, target.handCount - expectedTargetSpent);
    this.consumeKnownCardsFromHand(state, actor, "assault", expectedActorSpent);
    this.consumeKnownCardsFromHand(state, target, "assault", expectedTargetSpent);
    this.applyDamage(state, target, actor, 1, {
      canBlock:false,
      eventProbability:actorLoseProbability,
      damageContext
    });
    this.applyDamage(state, actor, target, 1, {
      canBlock:false,
      eventProbability:targetLoseProbability,
      damageContext
    });
    return {
      actorLoseProbability,
      targetLoseProbability,
      expectedActorSpent,
      expectedTargetSpent,
      actorRemainingDistribution,
      targetRemainingDistribution
    };
  }

  /** 五种进入手牌的基础判定定义；战术与装备可聚合，基础牌必须各自成支。 */
  static get RADAR_BASIC_DEFINITIONS() {
    return RADAR_BASIC_DEFINITION_IDS;
  }

  /**
   * 构造单一互斥雷达结果分区：noRadar / noJudgment / tactic / equipment /
   * basic:assault / basic:recover / basic:block / basic:charge / basic:shield。
   * 所有结果共享同一个条件键，不同结果值互斥，概率合计为 1。
   * 默认概率来自 remainingCardCounts（只读）；override 兼容
   * { block, otherBasic, equipment }，其中 otherBasic 按剩余密度拆分到四种非格挡基础牌。
   */
  buildRadarOutcomePartition(state, defenseProbability, overrideProbabilities = null) {
    const defense = clampProbability(defenseProbability);
    const {
      tactic: tacticProbability,
      equipment: equipmentProbability,
      basic: basicProbabilities,
      hasJudgmentPool
    } = buildRadarJudgmentProbabilities(state?.remainingCardCounts ?? null, overrideProbabilities);

    const key = this.nextProbabilityEventKey(state, "radar-outcome");
    const branches = [];
    const noRadarProbability = 1 - defense;
    if (noRadarProbability > PROBABILITY_EPSILON) {
      branches.push({
        probability:noRadarProbability,
        conditions:{ [key]:"noRadar" },
        radarOutcome:"noRadar",
        responseAllowed:true,
        immuneByRadar:false
      });
    }
    if (defense > PROBABILITY_EPSILON) {
      const pushOutcome = (outcome, probability, responseAllowed, immuneByRadar) => {
        const chance = probability * defense;
        if (chance > PROBABILITY_EPSILON) {
          branches.push({
            probability:chance,
            conditions:{ [key]:outcome },
            radarOutcome:outcome,
            responseAllowed,
            immuneByRadar
          });
        }
      };
      if (!hasJudgmentPool) {
        pushOutcome("noJudgment", 1, true, false);
      } else {
        pushOutcome("tactic", tacticProbability, false, true);
        pushOutcome("equipment", equipmentProbability, true, false);
        for (const definitionId of AiSimulator.RADAR_BASIC_DEFINITIONS) {
          pushOutcome(`basic:${definitionId}`, basicProbabilities[definitionId], true, false);
        }
      }
    }
    const branchTotal = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return branchTotal > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / branchTotal }))
      : [{ probability:1, conditions:{ [key]:"noRadar" }, radarOutcome:"noRadar", responseAllowed:true, immuneByRadar:false }];
  }

  /**
   * 统一格挡响应结算：在包含 occurs / requiredCount / responseAllowed / immuneByRadar
   * 的攻击世界中，只有真正满足数量且允许响应的世界才消费格挡。
   * 复用 B1a 的 blockCountDistribution + consumeBlockIdentities 逻辑，
   * 并返回带 blockedByCard / passes 的完整攻击结果分区供伤害结算直接使用。
   */
  consumeBlockResponseWorlds(state, target, attackWorlds, options = {}) {
    const blockState = this.getBlockCountBranches(target, state?.remainingCardCounts ?? null);
    const preJudgmentPartition = Array.isArray(options.preJudgmentBlockState)
      && options.preJudgmentBlockState.length
      ? options.preJudgmentBlockState.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          preBlockCount:branch.blockCount
        }))
      : null;
    const joined = preJudgmentPartition
      ? joinProbabilityStateBranches(attackWorlds, blockState, preJudgmentPartition)
      : joinProbabilityStateBranches(attackWorlds, blockState);
    const responseMatches = (branch) => Boolean(
      branch.occurs
      && branch.responseAllowed !== false
      && !branch.immuneByRadar
      && branch.blockCount >= branch.requiredCount
    );
    const consumedBranches = joined.filter(responseMatches);
    const blockedProbability = totalBranchProbability(consumedBranches);
    const expectedBlockSpend = consumedBranches.reduce(
      (sum, branch) => sum + branch.probability * branch.requiredCount, 0
    );
    const remainingBlockBranches = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:responseMatches(branch)
        ? Math.max(0, branch.blockCount - branch.requiredCount)
        : branch.blockCount
    }));
    target.blockCountDistribution = remainingBlockBranches;
    this.syncBlockSummary(target);
    const identityWorlds = joined.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      requiredCount:branch.requiredCount,
      blockUsed:responseMatches(branch)
    }));
    const judgmentBlockCard = options.judgmentBlockCard ?? null;
    const excludedCardIds = judgmentBlockCard
      ? new Set([judgmentBlockCard.id ?? judgmentBlockCard.cardId])
      : null;
    this.consumeBlockIdentities(state, target, identityWorlds, excludedCardIds);
    if (judgmentBlockCard && preJudgmentPartition) {
      // 判定牌追加在手牌末尾：原匿名格挡容量足够时，判定格挡身份必须保留；
      // 只有判定前总格挡不足 requiredCount 的世界才真正消费判定格挡。
      const judgmentConsumedWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(
          responseMatches(branch)
          && branch.preBlockCount < branch.requiredCount
        )
      }));
      const judgmentAvailability = getAvailabilityStateBranches(judgmentBlockCard).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedJudgment = joinProbabilityStateBranches(judgmentAvailability, judgmentConsumedWorlds);
      judgmentBlockCard.availabilityStateBranches = projectProbabilityStateBranches(joinedJudgment, (branch) => ({
        available:Boolean(branch.available && !branch.occurs)
      }));
      judgmentBlockCard.availabilityBranches = availableBranchesFromState(
        judgmentBlockCard.availabilityStateBranches
      );
      if (totalBranchProbability(judgmentBlockCard.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(target.hand)) target.hand = target.hand.filter((card) => card !== judgmentBlockCard);
        if (Array.isArray(target.knownCards)) target.knownCards = target.knownCards.filter((entry) => entry !== judgmentBlockCard);
      }
    }
    target.handCount = Math.max(0, (target.handCount ?? 0) - expectedBlockSpend);
    const outcomeWorlds = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:Boolean(branch.occurs),
      radarOutcome:branch.radarOutcome ?? null,
      requiredCount:branch.requiredCount,
      immuneByRadar:Boolean(branch.immuneByRadar),
      blockedByCard:responseMatches(branch),
      passes:Boolean(branch.occurs && !branch.immuneByRadar && !responseMatches(branch))
    }));
    return { outcomeWorlds, blockedProbability, expectedBlockSpend };
  }

  /**
   * 目标级反制响应：在 effectWorlds × desire × counterCountDistribution 上建立
   * 互斥反制选择分区。只有实际使用反制的世界才消费数量、身份与 handCount；
   * 返回包含 effectOccurs / counterWilling / counterAvailable / counterAttempted /
   * counterConsumed / effectCancelled / effectPasses / responderId 的完整结果世界。
   * 当前 B1c 固定 effectCancelled = counterAttempted；后续 B1d 可在 counterAttempted
   * 世界上叠加“该反制是否被反制”。
   */
  consumeTargetCounterResponseWorlds(state, target, effectWorlds, desire, options = {}) {
    if (!target) {
      const emptyOutcome = projectProbabilityStateBranches(effectWorlds, (branch) => ({
        effectOccurs:Boolean(branch.occurs),
        counterWilling:false,
        counterAvailable:false,
        counterAttempted:false,
        counterConsumed:false,
        effectCancelled:false,
        effectPasses:Boolean(branch.occurs),
        responderId:null
      }));
      return {
        outcomeWorlds:emptyOutcome,
        effectPassWorlds:effectWorlds,
        counterAttemptedWorlds:projectProbabilityStateBranches(effectWorlds, () => ({ occurs:false }))
      };
    }
    const desireChance = clampProbability(Number(desire) || 0);
    const desireKey = this.nextProbabilityEventKey(state, `counter-desire:${target.id ?? "unknown"}`);
    const desirePartition = desireChance >= 1 - PROBABILITY_EPSILON
      ? [{ probability:1, conditions:{}, willing:true }]
      : desireChance <= PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, willing:false }]
        : [
            { probability:desireChance, conditions:{ [desireKey]:"yes" }, willing:true },
            { probability:1 - desireChance, conditions:{ [desireKey]:"no" }, willing:false }
          ];
    const counterState = this.getCounterCountBranches(target, state?.remainingCardCounts ?? null);
    const knownCounterState = this.getKnownCounterCountBranches(target);
    const candidates = [
      ...(Array.isArray(target.hand) ? target.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON && card.definitionId === "counter")
        .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:"counter" })) : []),
      ...(Array.isArray(target.knownCards) ? target.knownCards
        .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON && entry.definitionId === "counter")
        .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:"counter" })) : [])
    ];
    const candidatePartitions = candidates.map((candidate, index) => (
      getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        [`c${index}`]:Boolean(branch.available)
      }))
    ));
    const joined = joinProbabilityStateBranches(
      effectWorlds, desirePartition, counterState, knownCounterState, ...candidatePartitions
    );
    const selectionKey = this.nextProbabilityEventKey(state, `counter-selection:${target.id ?? "unknown"}`);
    const outcomes = [];
    for (const branch of joined) {
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const knownCount = Math.max(0, Math.floor(Number(branch.knownCounterCount) || 0));
      const anonymousCount = Math.max(0, counterCount - knownCount);
      const available = candidates.map((_, index) => Boolean(branch[`c${index}`]));
      const availableCount = available.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const attempted = effectOccurs && willing && counterCount >= 1;
      if (!attempted) {
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:"none" },
          selectedIndex:-1,
          anonymousSelected:false
        });
        continue;
      }
      if (Array.isArray(target.hand)) {
        // 当前 AI 自己：按真实手牌顺序选择第一张可用反制，不随机选择。
        const firstIndex = available.indexOf(true);
        if (firstIndex < 0) {
          outcomes.push({
            probability:branch.probability,
            conditions:{ ...branch.conditions, [selectionKey]:"none" },
            selectedIndex:-1,
            anonymousSelected:false
          });
          continue;
        }
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[firstIndex].key}` },
          selectedIndex:firstIndex,
          anonymousSelected:false
        });
        continue;
      }
      // 其他玩家：已知反制身份与匿名反制桶交换对称互斥选择。
      const total = availableCount + anonymousCount;
      for (let index = 0; index < candidates.length; index += 1) {
        if (available[index]) {
          outcomes.push({
            probability:branch.probability / total,
            conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[index].key}` },
            selectedIndex:index,
            anonymousSelected:false
          });
        }
      }
      if (anonymousCount > 0) {
        outcomes.push({
          probability:branch.probability * (anonymousCount / total),
          conditions:{ ...branch.conditions, [selectionKey]:"anonymous" },
          selectedIndex:-1,
          anonymousSelected:true
        });
      }
    }

    const selectionPartition = mergeProbabilityStateBranches(outcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const availabilityState = getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedAvailability = joinProbabilityStateBranches(availabilityState, selectionPartition);
      candidate.card.availabilityStateBranches = projectProbabilityStateBranches(
        joinedAvailability,
        (branch) => ({ available:Boolean(branch.available && !(branch.selectedIndex === index)) })
      );
      candidate.card.availabilityBranches = availableBranchesFromState(candidate.card.availabilityStateBranches);
      if (totalBranchProbability(candidate.card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(target.hand)) target.hand = target.hand.filter((card) => card !== candidate.card);
        if (Array.isArray(target.knownCards)) target.knownCards = target.knownCards.filter((entry) => entry !== candidate.card);
      }
    }

    // 数量与 handCount 只在 counterAttempted 世界扣减；身份选择只决定具体删哪张。
    const attemptedPartition = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:Boolean(
        branch.occurs
        && branch.willing
        && Math.max(0, Math.floor(Number(branch.counterCount) || 0)) >= 1
      )
    }));
    const currentCounterState = this.getCounterCountBranches(target, state?.remainingCardCounts ?? null);
    const joinedCount = joinProbabilityStateBranches(currentCounterState, attemptedPartition);
    target.counterCountDistribution = projectProbabilityStateBranches(joinedCount, (branch) => ({
      counterCount:Math.max(0, branch.counterCount - (branch.occurs ? 1 : 0))
    }));
    this.syncCounterSummary(target);
    const attemptedProbability = this.eventProbability(attemptedPartition);
    target.handCount = Math.max(0, (target.handCount ?? 0) - attemptedProbability);

    const outcomeWorlds = projectProbabilityStateBranches(joined, (branch) => {
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const attempted = effectOccurs && willing && counterCount >= 1;
      return {
        effectOccurs,
        counterWilling:willing,
        counterAvailable:counterCount >= 1,
        counterAttempted:attempted,
        counterConsumed:attempted,
        effectCancelled:attempted,
        effectPasses:Boolean(effectOccurs && !attempted),
        responderId:target.id ?? null
      };
    });
    return {
      outcomeWorlds,
      effectPassWorlds:projectProbabilityStateBranches(outcomeWorlds, (branch) => ({
        occurs:branch.effectPasses
      })),
      counterAttemptedWorlds:projectProbabilityStateBranches(outcomeWorlds, (branch) => ({
        occurs:branch.counterAttempted
      }))
    };
  }

  applyDamage(state, attacker, target, amount, options = {}) {
    if (!target.alive || amount <= 0) {
      if (options.outcome) {
        options.outcome.lifeDamageChance = 0;
        options.outcome.blockedByCardChance = 0;
      }
      return 0;
    }
    const eventWorlds = this.getEventWorlds(state,
      options.eventProbability ?? 1,
      options.eventBranches,
      `damage-event:${attacker?.id ?? "unknown"}:${target.id}`);
    const eventProbability = this.eventProbability(eventWorlds);
    if (eventProbability <= 0) return 0;
    const amountState = (Array.isArray(options.amountBranches) && options.amountBranches.length
      ? mergeProbabilityStateBranches(options.amountBranches)
      : [{ probability:1, conditions:{}, amount }]).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      damageAmount:Math.max(0, Number(branch.amount) || 0)
    }));
    const battleProbability = clampProbability(options.deviceAttack
      && attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    // 雷达按统一“需要打出格挡”语义生效：只要本次伤害可格挡（options.canBlock），
    // 目标装备 defenseDevice 时就进入雷达判定路径，不再依赖 assault/shock 牌名白名单。
    const defenseProbability = options.canBlock
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = 0;
    let expectedBlockSpend = 0;
    let passChance = 1;
    let attackOutcomeWorlds = null;
    if (defenseProbability > 0) {
      // 雷达路径：单一互斥结果分区，判定身份、格挡消费与伤害通过共用同一组条件世界。
      const radarOutcomePartition = this.buildRadarOutcomePartition(
        state, defenseProbability, options.radarJudgmentProbabilities
      );
      const battleKey = this.nextProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:2 }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:1 }]
          : [
              { probability:battleProbability, conditions:{ [battleKey]:"yes" }, requiredCount:2 },
              { probability:1 - battleProbability, conditions:{ [battleKey]:"no" }, requiredCount:1 }
            ];
      const baseWorlds = joinProbabilityStateBranches(
        eventWorlds, radarOutcomePartition, requiredPartition
      ).map((branch) => ({
        ...branch,
        responseAllowed:Boolean(options.canBlock) && branch.responseAllowed !== false
      }));
      // 先基于判定前的身份保存格挡容量：既避免旧快照在判定身份加入后才
      // 用“全部已知”捷径重建分布并重复计数，也用于决定判定格挡是否被消费。
      // 无条件的匿名容量分支在这里显式键化，使判定格挡身份、判定前容量和
      // 最终 blockCount 在后续世界中保持同一条件关联。
      const preJudgmentKey = this.nextProbabilityEventKey(state, "pre-judgment-blocks");
      const preJudgmentBlockState = this.getBlockCountBranches(
        target, state?.remainingCardCounts ?? null
      ).map((branch, index) => ({
        probability:branch.probability,
        conditions:{ ...branch.conditions, [preJudgmentKey]:`v${index}` },
        blockCount:branch.blockCount
      }));
      target.blockCountDistribution = preJudgmentBlockState;
      this.syncBlockSummary(target);
      let judgmentBlockCard = null;
      // 基础判定牌先加入身份：判定得到的格挡可以立即用于本次响应。
      for (const definitionId of AiSimulator.RADAR_BASIC_DEFINITIONS) {
        const acquisitionWorlds = projectProbabilityStateBranches(baseWorlds, (branch) => ({
          occurs:Boolean(branch.occurs && branch.radarOutcome === `basic:${definitionId}`)
        }));
        if (this.eventProbability(acquisitionWorlds) <= PROBABILITY_EPSILON) continue;
        const simulatedId = this.nextSimulatedCardId(state, definitionId);
        if (Array.isArray(target.hand)) {
          this.addSimulatedCardToHand(state, target, { id:simulatedId, definitionId }, acquisitionWorlds);
          if (definitionId === "block") {
            judgmentBlockCard = target.hand.find((card) => card.id === simulatedId) ?? null;
          }
        } else {
          this.addSimulatedKnownCard(state, target, { cardId:simulatedId, definitionId }, acquisitionWorlds);
          if (definitionId === "block") {
            judgmentBlockCard = target.knownCards.find((entry) => entry.cardId === simulatedId) ?? null;
          }
        }
      }
      const response = this.consumeBlockResponseWorlds(state, target, baseWorlds, {
        preJudgmentBlockState,
        judgmentBlockCard
      });
      attackOutcomeWorlds = response.outcomeWorlds;
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, response.blockedProbability / eventProbability)
        : 0;
    } else if (options.canBlock) {
      // 非雷达路径：格挡数量分布与本次伤害事件世界联合，只有同时发生且数量足够的
      // 世界才消费格挡；消费张数由军火库条件决定（1 或 2）。
      const battleKey = this.nextProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:2 }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:1 }]
          : [
              { probability:battleProbability, conditions:{ [battleKey]:"yes" }, requiredCount:2 },
              { probability:1 - battleProbability, conditions:{ [battleKey]:"no" }, requiredCount:1 }
            ];
      const blockState = this.getBlockCountBranches(target, state?.remainingCardCounts ?? null);
      const blockWorlds = joinProbabilityStateBranches(eventWorlds, requiredPartition, blockState);
      const consumedBranches = blockWorlds.filter(
        (branch) => branch.occurs && branch.blockCount >= branch.requiredCount
      );
      const blockedProbability = totalBranchProbability(consumedBranches);
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, blockedProbability / eventProbability)
        : 0;
      passChance = Math.max(0, Math.min(1, 1 - blockedByCardChance));
      expectedBlockSpend = consumedBranches.reduce(
        (sum, branch) => sum + branch.probability * branch.requiredCount, 0
      );
      const remainingBlockBranches = projectProbabilityStateBranches(blockWorlds, (branch) => ({
        blockCount: branch.occurs && branch.blockCount >= branch.requiredCount
          ? Math.max(0, branch.blockCount - branch.requiredCount)
          : branch.blockCount
      }));
      target.blockCountDistribution = remainingBlockBranches;
      this.syncBlockSummary(target);
      const identityWorlds = blockWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        requiredCount:branch.requiredCount,
        blockUsed:Boolean(branch.occurs && branch.blockCount >= branch.requiredCount)
      }));
      this.consumeBlockIdentities(state, target, identityWorlds);
      target.handCount = Math.max(0, (target.handCount ?? 0) - expectedBlockSpend);
    }
    const damagePassProbability = attackOutcomeWorlds
      ? totalBranchProbability(attackOutcomeWorlds.filter((branch) => branch.occurs && branch.passes))
      : eventProbability * passChance;
    let aidReductionPerPass = 0;
    if (damagePassProbability > PROBABILITY_EPSILON) {
      const passWorlds = attackOutcomeWorlds
        ?? joinProbabilityStateBranches(eventWorlds, probabilityEventPartition(
          this.nextProbabilityEventKey(state, `damage-pass-aid:${attacker?.id ?? "unknown"}:${target.id}`),
          passChance,
          "passes"
        ));
      const incomingExpectedDamage = joinProbabilityStateBranches(passWorlds, amountState)
        .reduce((sum, branch) => (
          sum + (branch.occurs && branch.passes ? branch.probability * branch.damageAmount : 0)
        ), 0);
      const aidedExpectedDamage = this.simulateGuardianAid(
        state, target, incomingExpectedDamage, damagePassProbability, options.excludedGuardianIds, options
      );
      aidReductionPerPass = Math.max(0,
        (incomingExpectedDamage - aidedExpectedDamage) / damagePassProbability);
    }
    const shieldState = getValueBranches(target, "shield", target.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const damageWorlds = attackOutcomeWorlds
      ? joinProbabilityStateBranches(attackOutcomeWorlds, shieldState, amountState)
      : joinProbabilityStateBranches(eventWorlds, probabilityEventPartition(
          this.nextProbabilityEventKey(state, `damage-pass:${attacker?.id ?? "unknown"}:${target.id}`),
          passChance,
          "passes"
        ), shieldState, amountState);
    const effectiveDamageFor = (branch) => Math.max(0, branch.damageAmount - aidReductionPerPass);
    const hpDamageFor = (branch) => branch.occurs && branch.passes
      ? Math.max(0, effectiveDamageFor(branch) - branch.shieldAmount)
      : 0;
    target.shieldBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
      amount:branch.occurs && branch.passes
        ? Math.max(0, branch.shieldAmount - effectiveDamageFor(branch))
        : branch.shieldAmount
    }));
    target.shield = expectedBranchValue(target.shieldBranches);
    const actualDamage = damageWorlds.reduce((sum, branch) => (
      sum + branch.probability * hpDamageFor(branch)
    ), 0);
    const lifeDamageBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
      occurs:hpDamageFor(branch) > PROBABILITY_EPSILON
    }));
    const lifeDamageChance = this.eventProbability(lifeDamageBranches);
    if (options.outcome) {
      options.outcome.lifeDamageBranches = lifeDamageBranches;
      options.outcome.lifeDamageChance = lifeDamageChance;
      options.outcome.blockedByCardChance = eventProbability * blockedByCardChance;
    }
    target.hp -= actualDamage;
    this.simulateAfterLifeDamage(state, attacker, target, lifeDamageChance,
      lifeDamageBranches, options.damageContext ?? {});
    this.resolveFatal(state, target, attacker);
    this.simulateSpyGapAfterLifeDamage(state, attacker, target, lifeDamageChance);
    return actualDamage;
  }

  applyHpLoss(state, target, amount) {
    if (!target.alive || amount <= 0) return;
    target.hp -= amount;
    this.resolveFatal(state, target);
  }

  /**
   * 闪电判中复用统一伤害模拟：不可格挡，因此雷达和格挡不会介入；护援在护盾前、
   * 护盾吸收、调息救援与死亡清理都继续走 applyDamage 的正式 AI 语义。
   */
  applyLightningHit(state, targetId) {
    const next = this.clone(state);
    const target = next.players.find((player) => player.id === targetId);
    if (!target?.alive) return next;
    // 真实结算在伤害前已消费命中的闪电；分支 after-state 也必须清除此状态，
    // 否则后续评估会把已经兑现的风险继续留在场上。
    if (Array.isArray(target.statuses)) {
      target.statuses = target.statuses.filter((statusId) => statusId !== "lightning");
    } else if (target.statuses) {
      delete target.statuses.lightning;
    }
    target.lightningStatusStateBranches = [{ probability:1, conditions:{}, present:false }];
    target.lightningStatusProbability = 0;
    this.applyDamage(next, null, target, 3, { canBlock:false });
    return next;
  }

  resolveFatal(state, target, attacker = null) {
    if (target.hp > 0 || !target.alive) return;
    const need = 1 - target.hp;
    const seatCount = Math.max(1, state.players.length);
    const targetSeat = Number(target.seatIndex) || 0;
    const allies = state.players.filter((player) => player.alive && player.battleTeam === target.battleTeam)
      .sort((a,b) => {
        if (a.id === target.id) return -1;
        if (b.id === target.id) return 1;
        const aDistance = ((Number(a.seatIndex) || 0) - targetSeat + seatCount) % seatCount;
        const bDistance = ((Number(b.seatIndex) || 0) - targetSeat + seatCount) % seatCount;
        return aDistance - bDistance;
      });
    const capacity = allies.reduce((sum, player) => sum + (player.expectedRecoverCount ?? 0), 0);
    target.survivalChance = Math.min(1, capacity / need);
    if (capacity < need) {
      target.alive = false;
      target.hp = 0;
      target.exposeWeaknessStacks = 0;
      target.assaultBonus = 0;
      target.huntMarkSourceId = null;
      target.huntMarkProbability = 0;
      target.huntMarkProbabilities = {};
      target.momentum = 0;
      target.momentumBranches = [{ probability:1, conditions:{}, amount:0 }];
      target.statuses = [];
      target.handCount = 0;
      target.hand = [];
      target.expectedAssaultCount = 0;
      target.assaultCountDistribution = [{ count:0, probability:1 }];
      target.expectedRecoverCount = 0;
      target.assaultResponseProbability = 0;
      target.blockProbability = 0;
      target.twoBlockProbability = 0;
      target.counterProbability = 0;
      target.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
      if (Array.isArray(target.knownCards)) {
        target.knownCards = target.knownCards.filter((entry) => entry.definitionId !== "counter");
      }
      this.setSimulatedEquipment(target, null, 0);
      this.clearHuntMarksBySource(state, target.id);
      if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
        this.gainUnknownCardsWithCounterState(
          state, attacker, GAME_CONFIG.killRewardDrawCount, null, "kill-reward-draw"
        );
      }
      return;
    }
    let remaining = need;
    let healingApplied = 0;
    const totalRecover = allies.reduce((sum, rescuer) => sum + Math.max(0, rescuer.expectedRecoverCount ?? 0), 0);
    const maxRounds = Math.max(1, Math.ceil(totalRecover));
    let rounds = 0;
    while (remaining > PROBABILITY_EPSILON && rounds < maxRounds) {
      let usedThisRound = false;
      for (const rescuer of allies) {
        if (remaining <= PROBABILITY_EPSILON) break;
        const available = Math.max(0, rescuer.expectedRecoverCount ?? 0);
        if (available <= PROBABILITY_EPSILON) continue;
        const canRejuvenate = rescuer.generalId === "spirit-medic"
          && (rescuer.rejuvenationTriggerCount ?? 0) < 2;
        const healingPerCard = 1;
        const spent = Math.min(1, available);
        if (spent <= PROBABILITY_EPSILON) continue;
        const healing = spent * healingPerCard;
        usedThisRound = true;
        remaining -= healing;
        healingApplied += healing;
        rescuer.expectedRecoverCount = Math.max(0, available - spent);
        rescuer.handCount = Math.max(0, (rescuer.handCount ?? 0) - spent);
        if (canRejuvenate) {
          this.gainUnknownCardsWithCounterState(state, rescuer, spent, null, "rejuvenation-rescue-draw");
          rescuer.rejuvenationTriggerCount = (rescuer.rejuvenationTriggerCount ?? 0) + 1;
        }
        this.consumeKnownCardsFromHand(state, rescuer, "recover", spent);
        this.simulateCoordination(state, rescuer, [target], spent);
      }
      rounds += 1;
      if (!usedThisRound) break;
    }
    target.hp = Math.min(target.maxHp, target.hp + healingApplied);
    target.survivalChance = 1;
    target.alive = true;
  }

  clearHuntMarksBySource(state, sourceId) {
    for (const player of state.players ?? []) {
      if (player.huntMarkProbabilities) delete player.huntMarkProbabilities[sourceId];
      if (player.huntMarkStateBranchesBySource) delete player.huntMarkStateBranchesBySource[sourceId];
      const probabilities = Object.values(player.huntMarkProbabilities ?? {}).map(clampProbability);
      player.huntMarkProbability = probabilities.length ? Math.max(...probabilities) : 0;
      if (player.huntMarkSourceId === sourceId) player.huntMarkSourceId = null;
      if (Array.isArray(player.statuses) && player.huntMarkProbability <= PROBABILITY_EPSILON) {
        player.statuses = player.statuses.filter((status) => status !== "huntMark");
      }
    }
  }

  heal(target, amount) {
    if (target.alive && amount > 0) target.hp = Math.min(target.maxHp, target.hp + amount);
  }

  /** 模拟由角色发起的治疗；灵医首次实际治疗己方时同步计算回春的摸牌收益。 */
  healFrom(state, source, target, amount) {
    if (!target?.alive || target.hp >= target.maxHp || amount <= 0) return;
    const beforeHp = target.hp;
    this.heal(target, amount);
    const actualAmount = Math.max(0, target.hp - beforeHp);
    if (source?.generalId === "spirit-medic" && source.battleTeam === target.battleTeam
      && (source.rejuvenationTriggerCount ?? 0) < 2) {
      const triggerWeight = Math.min(1, actualAmount);
      if (triggerWeight <= PROBABILITY_EPSILON) return;
      source.rejuvenationTriggerCount = (source.rejuvenationTriggerCount ?? 0) + 1;
      this.gainUnknownCardsWithCounterState(state, source, triggerWeight, null, "rejuvenation-draw");
    }
  }
}
