/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260806-ai-block-consumption-v90";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260806-ai-block-consumption-v90";
import { RuleEngine } from "../core/RuleEngine.js?build=20260806-ai-block-consumption-v90";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260806-ai-block-consumption-v90";
import { chooseBestResourceHandCandidate, chooseResourceZone } from "./resourceSelectionValue.js?build=20260806-ai-block-consumption-v90";
import { getBaseCardAiValue, getRoleCardAiValue } from "./roleCardValue.js?build=20260806-ai-block-consumption-v90";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  expectedBranchValue,
  getAvailabilityBranches,
  getAvailabilityStateBranches,
  getValueBranches,
  joinProbabilityStateBranches,
  mergeProbabilityStateBranches,
  probabilityEventPartition,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "./AiProbabilityBranches.js?build=20260806-ai-block-consumption-v90";

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
  }

  clone(state = this.initial) {
    const cloned = structuredClone(state);
    this.initializeEquipmentBaselines(cloned);
    this.initializeAssaultSummaries(cloned);
    this.initializeBlockCountDistributions(cloned);
    return cloned;
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

  /** 匿名牌转移：来源与接收者共享同一组“是否格挡”条件世界。 */
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
    source.handCount = Math.max(0, (source.handCount ?? 0) - removed);
    const blockState = this.getBlockCountBranches(receiver, state?.remainingCardCounts ?? null);
    const joined = joinProbabilityStateBranches(blockState, identityWorlds);
    receiver.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:branch.blockCount + (branch.occurs && branch.blockRemoved ? 1 : 0)
    }));
    this.syncBlockSummary(receiver);
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
      if (actor?.generalId === "blade-walker") actor.momentum = 0;
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
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability);
    if (executionProbability <= 0) return next;
    const effectEventWorlds = card.counterScope === "target"
      ? cardEventWorlds
      : this.gateEventWorlds(next, cardEventWorlds,
        this.tacticResolutionChance(next, actor, card, abstractAction.targets ?? []),
        `counter:${card.id ?? card.definitionId}`);
    const scale = this.eventProbability(effectEventWorlds);
    const cardDamageContext = { cardDamage:true, emberTriggeredProbabilities:{} };
    let coordinationProbability = 0;
    let coordinationTargets = [];

    switch (card.definitionId) {
      case "recover":
        this.healFrom(actor, actor, 1 * scale);
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
      case "harvest": actor.handCount += 2 * scale; break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "scout": {
        if (!target?.alive) break;
        const knownExpectedCount = (target.knownCards ?? [])
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        const unknownCount = Math.max(0, (Number(target.handCount) || 0) - knownExpectedCount);
        const informationGain = Math.min(2, unknownCount);
        actor.expectedInformationGain = (actor.expectedInformationGain ?? 0) + informationGain * scale;
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
          const targetWorlds = this.gateEventWorlds(next, effectEventWorlds,
            this.targetResolutionChance(next, actor, card, player), `target-counter:${card.id}:${player.id}`);
          this.applyDamage(next, actor, player, 1, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:targetWorlds,
            damageContext:cardDamageContext
          });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetScale = this.targetResolutionChance(next, actor, card, player);
          const response = player.assaultResponseProbability ?? 0;
          const targetWorlds = this.gateEventWorlds(next, effectEventWorlds,
            targetScale, `target-counter:${card.id}:${player.id}`);
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
      case "plunder":
        if (target) this.takeResourceToHand(next, actor, target, effectEventWorlds, `plunder:${card.id ?? card.definitionId}`);
        break;
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
          coordinationTargets = [receiver];
        }
        break;
      }
      case "destroy": if (target) this.destroyResource(next, actor, target, effectEventWorlds, `destroy:${card.id ?? card.definitionId}`); break;
      case "duel": if (target) this.applyDuel(next, actor, target, scale, cardDamageContext); break;
      case "mutualBenefit": {
        coordinationTargets = next.players.filter((player) => player.alive);
        coordinationProbability = scale;
        for (const player of coordinationTargets) player.handCount += scale;
        break;
      }
      case "symbiosis": {
        coordinationTargets = this.seatOrderFrom(next, actor, true);
        coordinationProbability = scale;
        for (const player of coordinationTargets) this.healFrom(actor, player, scale);
        break;
      }
      default:
        if (card.category === "equipment") this.setSimulatedEquipment(actor, card.definitionId, executionProbability);
        break;
    }
    this.simulateGamble(actor, card, executionProbability);
    this.simulateCoordination(actor, coordinationTargets, coordinationProbability);
    const recycleProbability = executionProbability * this.getSimulatedEquipmentProbability(actor, "recycleDevice");
    if (card.category === "tactic" && recycleProbability > 0) {
      const remainingUses = Math.max(0, 2 - (actor.recycleDeviceUses ?? 0));
      const triggerProbability = Math.min(recycleProbability, remainingUses);
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + triggerProbability;
      actor.handCount += triggerProbability;
    }
    if (actor.generalId === "blade-walker" && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(actor, category, executionProbability);
    }
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
    player.hand.push({
      id,
      definitionId: cardIdentity.definitionId,
      availabilityBranches: availableBranchesFromState(acquired),
      availabilityStateBranches: acquired
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
    if (cardIdentity.definitionId === "block") this.addKnownBlockToDistribution(state, player, acquired);
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
    const counterDistribution = this.cardEstimateDistribution(player, "counter", remainingCardCounts);
    const assaultDistribution = this.cardEstimateDistribution(player, "assault", remainingCardCounts);
    player.expectedRecoverCount = expectation(recoverDistribution);
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    this.syncBlockSummary(player);
    player.counterProbability = atLeast(counterDistribution, 1);
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
  consumeBlockIdentities(state, player, blockWorlds) {
    if (!player || !Array.isArray(blockWorlds) || !blockWorlds.length) return;
    const candidates = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "block") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "block") : [])
    ];
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
    const { removed } = this.removeUnknownCardsFromBlockDistribution(
      state,
      player,
      spent,
      availableUnknownCount,
      eventWorlds,
      "unknown-resource-loss"
    );
    this.downgradePartialKnownCardsAfterRandomLoss(player);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return removed;
  }

  /**
   * 从整副手牌中随机移除一张：hand / knownCards 身份与匿名桶组成互斥候选池。
   * 一次移除只可能选中一个候选，并返回本次实际移除的期望数量。
   */
  removeOneRandomCardFromHand(state, player, spend) {
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
    return amount;
  }

  consumeRandomHandCards(state, player, expectedAmount) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    let totalSpent = 0;
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
      this.removeOneRandomCardFromHand(state, player, spend);
      remaining -= spend;
      totalSpent += spend;
    }
    return totalSpent;
  }

  /** 连势按“该类别此前已使用”的概率累计，避免多个部分概率动作重复获得完整首次收益。 */
  simulateCategoryUse(player, category, useProbability = 1, lifeDamageProbability = 0) {
    if (!category || player?.generalId !== "blade-walker") return 0;
    const chance = clampProbability(useProbability);
    const lifeDamageChance = Math.min(chance, clampProbability(lifeDamageProbability));
    player.categoriesUsed ??= [];
    player.categoryUsedProbabilities ??= {};
    const oldUsedProbability = clampProbability(player.categoryUsedProbabilities[category]
      ?? (player.categoriesUsed.includes(category) ? 1 : 0));
    const newUsedProbability = unionProbability(oldUsedProbability, chance);
    const firstUseProbability = Math.max(0, newUsedProbability - oldUsedProbability);
    player.categoryUsedProbabilities[category] = newUsedProbability;
    if (newUsedProbability >= 1 - Number.EPSILON && !player.categoriesUsed.includes(category)) {
      player.categoriesUsed.push(category);
    }

    const currentMomentum = Math.max(0, Number(player.momentum) || 0);
    const unusedProbability = 1 - oldUsedProbability;
    const firstUseOnHit = lifeDamageChance * unusedProbability;
    const firstUseWithoutHit = Math.max(0, chance - lifeDamageChance) * unusedProbability;
    const nonHitGain = Math.min(1, Math.max(0, GAME_CONFIG.momentumMaxStacks - currentMomentum));
    // 命中生命时旧连势先被消耗，随后本次首次类别仍会积累1层；未命中分支只补足剩余层数。
    player.momentum = Math.min(GAME_CONFIG.momentumMaxStacks,
      currentMomentum * (1 - lifeDamageChance) + firstUseOnHit + firstUseWithoutHit * nonHitGain);
    return firstUseProbability;
  }

  simulateGamble(actor, card, useProbability) {
    if (actor?.generalId !== "fate-gambler" || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    actor.handCount = (actor.handCount ?? 0) + triggerProbability * GAME_CONFIG.gamblerDrawChance;
    return triggerProbability;
  }

  simulateCoordination(actor, effectiveTargets, resolutionProbability) {
    if (actor?.generalId !== "resonance-tuner") return 0;
    if (!(effectiveTargets ?? []).some((target) => target?.alive && target.id !== actor.id
      && target.battleTeam === actor.battleTeam)) return 0;
    const oldProbability = clampProbability(actor.coordinationTriggeredProbability
      ?? (actor.coordinationTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, resolutionProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.coordinationTriggeredProbability = newProbability;
    actor.coordinationTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    actor.handCount = (actor.handCount ?? 0) + triggerProbability;
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

  /** 护援在格挡、雷达和护盾之前减少伤害，并同步计算一次弃牌与每轮次数的期望代价。 */
  simulateGuardianAid(state, target, incomingDamage, eventProbability) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) return Math.max(0, incomingDamage);
    const conditionalReduction = Math.min(1, incomingDamage / probability);
    let remainingTriggerProbability = probability;
    let expectedReduction = 0;
    for (const guardian of state.players) {
      if (remainingTriggerProbability <= PROBABILITY_EPSILON) break;
      if (!guardian.alive || guardian.generalId !== "oath-warden" || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const oldUsedProbability = clampProbability(guardian.guardianAidUsedProbability
        ?? (guardian.guardianAidUsed ? 1 : 0));
      const handAvailability = Math.min(1, Math.max(0, Number(guardian.handCount) || 0));
      const triggerProbability = remainingTriggerProbability * (1 - oldUsedProbability) * handAvailability;
      if (triggerProbability <= 0) continue;
      this.consumeRandomHandCards(state, guardian, triggerProbability);
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
    const momentum = source.generalId === "blade-walker" ? (source.momentum ?? 0) : 0;
    const damageOutcome = {};
    const damage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0) + momentum;
    this.applyDamage(state, source, target, damage, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:assaultWorlds,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined,
      damageContext:options.damageContext ?? { cardDamage:true, emberTriggeredProbabilities:{} }
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    this.simulateCategoryUse(source, "basic", chance, lifeDamageChance);
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
    if (!selection) return;
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
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON) {
        const acquisitionProbability = this.eventProbability(effectWorlds);
        if (acquisitionProbability <= PROBABILITY_EPSILON) return;
        if (selection.definitionId === "block") {
          this.removeKnownBlockFromDistribution(state, target, effectWorlds);
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
        return;
      }
      const transferred = this.consumeRandomHandCards(state, target, this.eventProbability(effectWorlds));
      actor.handCount = (actor.handCount ?? 0) + transferred;
    } else if (selection.zone === "hand") {
      this.transferUnknownBlockCapacity(
        state,
        target,
        actor,
        effectWorlds,
        selection.availableUnknownCount
      );
    }
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
    if (!selection) return;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      this.setSimulatedEquipment(target, target.equipmentDefinitionId,
        existenceProbability * (1 - this.eventProbability(effectWorlds)));
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON) {
        const removalProbability = this.eventProbability(effectWorlds);
        if (removalProbability <= PROBABILITY_EPSILON) return;
        if (selection.definitionId === "block") {
          this.removeKnownBlockFromDistribution(state, target, effectWorlds);
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
        return;
      }
      this.consumeRandomHandCards(state, target, this.eventProbability(effectWorlds));
    } else if (selection.zone === "hand") {
      this.consumeUnknownResourceCard(
        state,
        target,
        this.eventProbability(effectWorlds),
        selection.availableUnknownCount,
        effectWorlds
      );
    }
  }

  tacticResolutionChance(state, actor, card, targets = []) {
    if (card.category !== "tactic" || card.counterable === false) return 1;
    return state.players.filter((player) => player.alive && player.id !== actor.id)
      .reduce((chance, player) => chance * (1 - (player.counterProbability ?? 0) * this.counterDesire(state, player, actor, card, targets)), 1);
  }

  targetResolutionChance(state, actor, card, target) {
    if (card.category !== "tactic" || card.counterable === false || card.counterScope !== "target") return 1;
    return 1 - (target.counterProbability ?? 0) * this.counterDesire(state, target, actor, card, [target]);
  }

  counterDesire(state, responder, actor, card, targets) {
    const sourceEnemy = responder.battleTeam !== actor.battleTeam;
    const target = state.players.find((player) => player.id === targets[0]?.id);
    const globalBenefitDesire = globalBenefitCounterDesire(state.players, responder.battleTeam, card.definitionId);
    if (globalBenefitDesire !== null) return globalBenefitDesire;
    if (["shockwave","provoke"].includes(card.definitionId)) return sourceEnemy ? 1 : 0;
    if (card.definitionId === "duel") return target?.battleTeam === responder.battleTeam ? 0.9 : sourceEnemy ? 0.35 : 0;
    if (["scout","plunder","destroy"].includes(card.definitionId) && target) {
      if (target.battleTeam === responder.battleTeam) return sourceEnemy ? 1 : 0.75;
      return sourceEnemy ? 0.25 : 0;
    }
    if (card.definitionId === "transfer") return sourceEnemy ? 0.45 : 0.15;
    return sourceEnemy ? ((card.aiValue ?? 0) >= 7 ? 0.8 : 0.45) : 0;
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
      actor.handCount += joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * branch.energyAmount : 0)
      ), 0);
      const currentAssaultBonus = actor.assaultBonus ?? 0;
      const joinedExpectedValue = joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * Math.min(1, branch.energyAmount * .3) : 0)
      ), 0);
      actor.assaultBonus = currentAssaultBonus + joinedExpectedValue * (1 - currentAssaultBonus);
      return;
    }
    this.changeEnergy(state, actor, -(Number(skill.cost) || 0), eventWorlds);
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
      this.healFrom(actor, target, chance);
      if (target.id !== actor.id) this.healFrom(actor, actor, chance);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, 1, { canBlock:false, eventBranches:eventWorlds });
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
      actor.handCount += outcome.blockedByCardChance ?? 0;
    } else if (skill.id === "resonance" && target) target.handCount += 2 * chance;
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
    this.consumeRandomHandCards(state, target, handLoss);
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
    const aidedExpectedDamage = this.simulateGuardianAid(
      state, target, amount * eventProbability, eventProbability
    );
    amount = aidedExpectedDamage / eventProbability;
    if (amount <= PROBABILITY_EPSILON) {
      if (options.outcome) {
        options.outcome.lifeDamageBranches = projectProbabilityStateBranches(
          eventWorlds, () => ({ occurs:false })
        );
        options.outcome.lifeDamageChance = 0;
        options.outcome.blockedByCardChance = 0;
      }
      return 0;
    }
    const battleProbability = clampProbability(options.deviceAttack
      && attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    const defenseProbability = options.deviceAttack
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = 0;
    let expectedBlockSpend = 0;
    let expectedJudgmentGain = 0;
    let passChance = 1;
    if (defenseProbability > 0) {
      // B1b 范围：雷达路径保持原行为，本任务不修改雷达判定与雷达格挡身份。
      const normalBlockChance = clampProbability(target.blockProbability ?? 0);
      const twoBlockChance = clampProbability(target.twoBlockProbability ?? 0);
      const blockChance = options.canBlock
        ? battleProbability * twoBlockChance + (1 - battleProbability) * normalBlockChance
        : 0;
      passChance = 1 - blockChance;
      blockedByCardChance = blockChance;
      expectedBlockSpend = options.canBlock
        ? battleProbability * twoBlockChance * 2 + (1 - battleProbability) * normalBlockChance
        : 0;
      const judgmentProbabilities = {
        ...remainingRadarJudgmentProbabilities(state?.remainingCardCounts),
        ...(options.radarJudgmentProbabilities ?? {})
      };
      const judgmentBlockChance = clampProbability(
        judgmentProbabilities.block ?? BLOCK_CARD_COUNT / TOTAL_CARD_COUNT
      );
      const otherBasicChance = clampProbability(
        judgmentProbabilities.otherBasic ?? OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT
      );
      const basicChance = judgmentBlockChance + otherBasicChance;
      const equipmentChance = clampProbability(
        judgmentProbabilities.equipment ?? EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT
      );
      const normalRadarPass = !options.canBlock
        ? basicChance + equipmentChance
        : (otherBasicChance + equipmentChance) * (1 - normalBlockChance);
      const battleRadarPass = !options.canBlock
        ? basicChance + equipmentChance
        : judgmentBlockChance * (1 - normalBlockChance)
          + (otherBasicChance + equipmentChance) * (1 - twoBlockChance);
      const radarPass = battleProbability * battleRadarPass + (1 - battleProbability) * normalRadarPass;
      passChance = (1 - defenseProbability) * passChance + defenseProbability * radarPass;
      const noRadarSpent = options.canBlock
        ? battleProbability * twoBlockChance * 2 + (1 - battleProbability) * normalBlockChance
        : 0;
      const normalRadarSpent = options.canBlock
        ? judgmentBlockChance + (otherBasicChance + equipmentChance) * normalBlockChance
        : 0;
      const battleRadarSpent = options.canBlock
        ? 2 * (judgmentBlockChance * normalBlockChance
          + (otherBasicChance + equipmentChance) * twoBlockChance)
        : 0;
      const radarSpent = battleProbability * battleRadarSpent + (1 - battleProbability) * normalRadarSpent;
      const normalRadarBlocked = options.canBlock
        ? judgmentBlockChance + (otherBasicChance + equipmentChance) * normalBlockChance
        : 0;
      const battleRadarBlocked = options.canBlock
        ? judgmentBlockChance * normalBlockChance
          + (otherBasicChance + equipmentChance) * twoBlockChance
        : 0;
      const radarBlocked = battleProbability * battleRadarBlocked
        + (1 - battleProbability) * normalRadarBlocked;
      blockedByCardChance = (1 - defenseProbability) * blockChance + defenseProbability * radarBlocked;
      expectedBlockSpend = (1 - defenseProbability) * noRadarSpent + defenseProbability * radarSpent;
      expectedJudgmentGain = defenseProbability * basicChance;
      target.handCount = Math.max(0, (target.handCount ?? 0)
        + eventProbability * expectedJudgmentGain
        - eventProbability * expectedBlockSpend);
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
    const passPartition = probabilityEventPartition(
      this.nextProbabilityEventKey(state, `damage-pass:${attacker?.id ?? "unknown"}:${target.id}`),
      passChance,
      "passes"
    );
    const shieldState = getValueBranches(target, "shield", target.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const damageWorlds = joinProbabilityStateBranches(eventWorlds, passPartition, shieldState);
    const hpDamageFor = (branch) => branch.occurs && branch.passes
      ? Math.max(0, amount - branch.shieldAmount)
      : 0;
    target.shieldBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
      amount:branch.occurs && branch.passes
        ? Math.max(0, branch.shieldAmount - amount)
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
    const rejuvenationBonus = (player) => player.generalId === "spirit-medic" && !player.rejuvenationUsed
      ? Math.min(1, player.expectedRecoverCount ?? 0)
      : 0;
    const capacity = allies.reduce((sum, player) => sum + (player.expectedRecoverCount ?? 0) + rejuvenationBonus(player), 0);
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
      this.setSimulatedEquipment(target, null, 0);
      this.clearHuntMarksBySource(state, target.id);
      if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
        attacker.handCount = (attacker.handCount ?? 0) + GAME_CONFIG.killRewardDrawCount;
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
        const canRejuvenate = rejuvenationBonus(rescuer) > 0;
        const healingPerCard = canRejuvenate ? 2 : 1;
        const spent = Math.min(1, available);
        if (spent <= PROBABILITY_EPSILON) continue;
        const healing = spent * healingPerCard;
        usedThisRound = true;
        remaining -= healing;
        healingApplied += healing;
        rescuer.expectedRecoverCount = Math.max(0, available - spent);
        rescuer.handCount = Math.max(0, (rescuer.handCount ?? 0) - spent + (canRejuvenate ? spent : 0));
        if (canRejuvenate) rescuer.rejuvenationUsed = true;
        this.consumeKnownCardsFromHand(state, rescuer, "recover", spent);
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

  /** 模拟由角色发起的治疗；灵医首次治疗己方时同步计算回春的治疗与摸牌收益。 */
  healFrom(source, target, amount) {
    if (!target?.alive || target.hp >= target.maxHp || amount <= 0) return;
    let finalAmount = amount;
    if (source?.generalId === "spirit-medic" && source.battleTeam === target.battleTeam && !source.rejuvenationUsed) {
      const triggerWeight = Math.min(1, amount);
      source.rejuvenationUsed = true;
      source.handCount = (source.handCount ?? 0) + triggerWeight;
      finalAmount += triggerWeight;
    }
    this.heal(target, finalAmount);
  }
}
