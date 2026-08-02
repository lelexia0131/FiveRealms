/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260802-resource-branches-v57";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260802-resource-branches-v57";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260802-resource-branches-v57";
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
} from "./AiProbabilityBranches.js?build=20260802-resource-branches-v57";

const BASIC_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0);
const EQUIPMENT_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment").reduce((sum, card) => sum + card.count, 0);
const BLOCK_CARD_COUNT = CARD_DEFINITIONS.block.count;
const OTHER_BASIC_CARD_COUNT = BASIC_CARD_COUNT - BLOCK_CARD_COUNT;
const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const unionProbability = (oldProbability, newProbability) => 1
  - (1 - clampProbability(oldProbability)) * (1 - clampProbability(newProbability));

export class AiSimulator {
  constructor(visibleState) { this.initial = structuredClone(visibleState); }

  clone(state = this.initial) { return structuredClone(state); }

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

  splitEventWorldsByChance(state, eventWorlds, chanceForBranch, label = "branch-gate") {
    const key = this.nextProbabilityEventKey(state, label);
    const split = [];
    for (const branch of eventWorlds) {
      const chance = branch.occurs ? clampProbability(chanceForBranch(branch)) : 0;
      if (chance > PROBABILITY_EPSILON) split.push({
        ...branch, probability:branch.probability * chance,
        conditions:{ ...branch.conditions, [key]:"yes" }, occurs:true
      });
      if (chance < 1 - PROBABILITY_EPSILON) split.push({
        ...branch, probability:branch.probability * (1 - chance),
        conditions:{ ...branch.conditions, [key]:"no" }, occurs:false
      });
    }
    return projectProbabilityStateBranches(split, (branch) => ({ occurs:branch.occurs }));
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

  getNumericStateBranches(player, property, fallback = 0) {
    const branches = player?.[property];
    if (Array.isArray(branches) && branches.length) return mergeProbabilityStateBranches(branches);
    return [{ probability:1, conditions:{}, amount:Number(fallback) || 0 }];
  }

  updateNumericStateFromWorlds(player, property, fallback, worldBranches, transformer, summaryProperty = null) {
    const field = `${property}Amount`;
    const resource = this.getNumericStateBranches(player, property, fallback).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      [field]:branch.amount
    }));
    const joined = joinProbabilityStateBranches(resource, worldBranches);
    player[property] = projectProbabilityStateBranches(joined, (branch) => ({
      amount:Math.max(0, Number(transformer(branch[field], branch)) || 0)
    }));
    if (summaryProperty) player[summaryProperty] = expectedBranchValue(player[property]);
    return joined;
  }

  getBooleanStateBranches(player, property, fallback = false) {
    const branches = player?.[property];
    if (Array.isArray(branches) && branches.length) return mergeProbabilityStateBranches(branches);
    return [{ probability:1, conditions:{}, used:Boolean(fallback) }];
  }

  updateBooleanStateFromWorlds(player, property, fallback, worldBranches, transformer) {
    const resource = this.getBooleanStateBranches(player, property, fallback).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceUsed:Boolean(branch.used)
    }));
    const joined = joinProbabilityStateBranches(resource, worldBranches);
    player[property] = projectProbabilityStateBranches(joined, (branch) => ({
      used:Boolean(transformer(branch.resourceUsed, branch))
    }));
    return joined;
  }

  ensureHpBranches(player) {
    if (Array.isArray(player.hpBranches) && player.hpBranches.length) {
      return mergeProbabilityStateBranches(player.hpBranches);
    }
    player.hpBranches = [{
      probability:1,
      conditions:{},
      amount:Math.max(0, Number(player.hp) || 0),
      alive:player.alive !== false
    }];
    return player.hpBranches;
  }

  syncHpSummary(player) {
    player.hpBranches = mergeProbabilityStateBranches(player.hpBranches);
    player.aliveProbability = totalBranchProbability(player.hpBranches.filter((branch) => branch.alive));
    player.deathProbability = Math.max(0, 1 - player.aliveProbability);
    player.survivalChance = player.aliveProbability;
    player.hp = player.hpBranches.reduce((sum, branch) => (
      sum + branch.probability * (branch.alive ? Math.max(0, Number(branch.amount) || 0) : 0)
    ), 0);
    // 概率存活角色继续留在近似座位环中；动作本身再与 alive 分支相交。
    player.alive = player.aliveProbability > PROBABILITY_EPSILON;
  }

  ensureHandResourceBranches(player) {
    if (Array.isArray(player.handResourceBranches) && player.handResourceBranches.length) {
      return mergeProbabilityStateBranches(player.handResourceBranches);
    }
    if (Array.isArray(player.hand)) {
      const counts = {
        blockCount:0,
        counterCount:0,
        assaultCount:0,
        recoverCount:0,
        otherCount:0
      };
      for (const card of player.hand) {
        const type = ["block", "counter", "assault", "recover"].includes(card.definitionId)
          ? `${card.definitionId}Count`
          : "otherCount";
        counts[type] += 1;
      }
      player.handResourceBranches = [{
        probability:1,
        conditions:{},
        handCount:player.hand.length,
        ...counts
      }];
      this.syncHandResourceSummary(player);
      return player.handResourceBranches;
    }
    const handCount = Math.max(0, Number(player.handCount ?? player.hand?.length) || 0);
    const blockOne = clampProbability(player.blockProbability ?? 0);
    const blockTwo = Math.min(blockOne, clampProbability(player.twoBlockProbability ?? 0));
    const blockKey = `hiddenHand:${player.id}:blockCount`;
    const block = blockOne <= PROBABILITY_EPSILON
      ? [{ probability:1, conditions:{}, blockCount:0 }]
      : blockTwo >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, blockCount:2 }]
        : [
          { probability:1 - blockOne, conditions:{ [blockKey]:"0" }, blockCount:0 },
          { probability:blockOne - blockTwo, conditions:{ [blockKey]:"1" }, blockCount:1 },
          { probability:blockTwo, conditions:{ [blockKey]:"2+" }, blockCount:2 }
        ];
    const countPartition = (field, expected, probability = null) => {
      const value = probability == null
        ? Math.max(0, Math.min(handCount, Number(expected) || 0))
        : clampProbability(probability);
      const lower = Math.floor(value), upper = Math.ceil(value), key = `hiddenHand:${player.id}:${field}`;
      if (lower === upper) return [{ probability:1, conditions:{}, [field]:lower }];
      return [
        { probability:upper - value, conditions:{ [key]:String(lower) }, [field]:lower },
        { probability:value - lower, conditions:{ [key]:String(upper) }, [field]:upper }
      ];
    };
    const partitions = [
      ["blockCount", block],
      ["counterCount", countPartition("counterCount", 0, player.counterProbability ?? 0)],
      ["assaultCount", countPartition("assaultCount", player.expectedAssaultCount ?? 0)],
      ["recoverCount", countPartition("recoverCount", player.expectedRecoverCount ?? 0)]
    ];
    const distributions = partitions.map(([field, branches]) => {
      let cumulative = 0;
      return [field, branches.filter((branch) => branch.probability > PROBABILITY_EPSILON)
        .map((branch) => {
          cumulative += branch.probability;
          return { upper:cumulative, value:branch[field] };
        })];
    });
    const breakpoints = [...new Set([0, 1,
      ...distributions.flatMap(([, entries]) => entries.map((entry) => entry.upper))])]
      .filter((value) => value >= 0 && value <= 1)
      .sort((left, right) => left - right);
    player.handResourceBranches = breakpoints.slice(0, -1).map((lower, index) => {
      const upper = breakpoints[index + 1], midpoint = (lower + upper) / 2;
      const counts = Object.fromEntries(distributions.map(([field, entries]) => [
        field,
        entries.find((entry) => midpoint <= entry.upper + PROBABILITY_EPSILON)?.value ?? 0
      ]));
      return {
        probability:upper - lower,
        conditions:{ [`hiddenHand:${player.id}:resourceWorld`]:String(index) },
        handCount,
        blockCount:counts.blockCount,
        counterCount:Math.min(handCount, counts.counterCount),
        assaultCount:Math.min(handCount, counts.assaultCount),
        recoverCount:Math.min(handCount, counts.recoverCount),
        otherCount:Math.max(0, handCount - counts.blockCount - counts.counterCount
          - counts.assaultCount - counts.recoverCount)
      };
    });
    this.syncHandResourceSummary(player);
    return player.handResourceBranches;
  }

  syncHandResourceSummary(player) {
    player.handResourceBranches = mergeProbabilityStateBranches(player.handResourceBranches);
    const expected = (field) => player.handResourceBranches.reduce((sum, branch) => (
      sum + branch.probability * Math.max(0, Number(branch[field]) || 0)
    ), 0);
    const chance = (predicate) => totalBranchProbability(player.handResourceBranches.filter(predicate));
    player.handCount = expected("handCount");
    player.blockProbability = chance((branch) => branch.handCount >= 1 && branch.blockCount >= 1);
    player.twoBlockProbability = chance((branch) => branch.handCount >= 2 && branch.blockCount >= 2);
    player.counterProbability = chance((branch) => branch.handCount >= 1 && branch.counterCount >= 1);
    player.expectedAssaultCount = expected("assaultCount");
    player.assaultResponseProbability = chance((branch) => branch.handCount >= 1 && branch.assaultCount >= 1);
    player.expectedRecoverCount = expected("recoverCount");
  }

  updateHandResourceFromWorlds(player, worldBranches, transformer) {
    const resource = this.ensureHandResourceBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceHandCount:branch.handCount,
      resourceBlockCount:branch.blockCount,
      resourceCounterCount:branch.counterCount,
      resourceAssaultCount:branch.assaultCount,
      resourceRecoverCount:branch.recoverCount,
      resourceOtherCount:branch.otherCount
    }));
    const joined = joinProbabilityStateBranches(resource, worldBranches);
    player.handResourceBranches = projectProbabilityStateBranches(joined, (branch) => {
      const current = {
        handCount:branch.resourceHandCount,
        blockCount:branch.resourceBlockCount,
        counterCount:branch.resourceCounterCount,
        assaultCount:branch.resourceAssaultCount,
        recoverCount:branch.resourceRecoverCount,
        otherCount:branch.resourceOtherCount
      };
      const next = transformer(current, branch) ?? current;
      return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, Math.max(0, Number(value) || 0)]));
    });
    this.syncHandResourceSummary(player);
    return joined;
  }

  consumeHandType(player, worldBranches, type, required = 1) {
    const field = `${type}Count`;
    const resource = this.ensureHandResourceBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceHandCount:branch.handCount,
      resourceBlockCount:branch.blockCount,
      resourceCounterCount:branch.counterCount,
      resourceAssaultCount:branch.assaultCount,
      resourceRecoverCount:branch.recoverCount,
      resourceOtherCount:branch.otherCount
    }));
    const joined = joinProbabilityStateBranches(resource, worldBranches);
    const resourceField = `resource${field[0].toUpperCase()}${field.slice(1)}`;
    const canConsume = (branch) => Boolean(branch.occurs
      && branch.resourceHandCount >= required
      && branch[resourceField] >= required);
    const actualWorlds = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:canConsume(branch)
    }));
    player.handResourceBranches = projectProbabilityStateBranches(joined, (branch) => {
      const consumed = canConsume(branch);
      const result = {
        handCount:branch.resourceHandCount - (consumed ? required : 0),
        blockCount:branch.resourceBlockCount,
        counterCount:branch.resourceCounterCount,
        assaultCount:branch.resourceAssaultCount,
        recoverCount:branch.resourceRecoverCount,
        otherCount:branch.resourceOtherCount
      };
      if (consumed) result[field] -= required;
      return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Math.max(0, value)]));
    });
    this.syncHandResourceSummary(player);
    return actualWorlds;
  }

  addHandResource(player, worldBranches, type = "other", count = 1) {
    const field = `${type}Count`;
    this.updateHandResourceFromWorlds(player, worldBranches, (resource, branch) => {
      if (!branch.occurs) return resource;
      const added = typeof count === "function" ? count(resource, branch) : count;
      return {
        ...resource,
        handCount:resource.handCount + added,
        [field]:(resource[field] ?? 0) + added
      };
    });
  }

  consumePlayedCard(player, worldBranches, definitionId) {
    const type = ["block", "counter", "assault", "recover"].includes(definitionId)
      ? definitionId
      : "other";
    return this.consumeHandType(player, worldBranches, type, 1);
  }

  handTypeAvailabilityWorlds(player, worldBranches, type, required = 1) {
    const field = `${type}Count`;
    const resource = this.ensureHandResourceBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceHandCount:branch.handCount,
      resourceTypeCount:branch[field] ?? 0
    }));
    return projectProbabilityStateBranches(
      joinProbabilityStateBranches(worldBranches, resource),
      (branch) => ({
        occurs:Boolean(branch.occurs && branch.resourceHandCount >= required
          && branch.resourceTypeCount >= required)
      })
    );
  }

  /** Consume the same physical/abstract hand slot only in worlds where the event actually occurs. */
  takeHandResource(state, player, worldBranches, label = "take") {
    const resource = this.ensureHandResourceBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceHandCount:branch.handCount,
      resourceBlockCount:branch.blockCount,
      resourceCounterCount:branch.counterCount,
      resourceAssaultCount:branch.assaultCount,
      resourceRecoverCount:branch.recoverCount,
      resourceOtherCount:branch.otherCount
    }));
    const joined = joinProbabilityStateBranches(resource, worldBranches);
    const selections = [];
    const key = this.nextProbabilityEventKey(state, `hand-pick:${label}:${player.id}`);
    for (const branch of joined) {
      if (!branch.occurs || branch.resourceHandCount < 1) {
        selections.push({ ...branch, selectedType:null });
        continue;
      }
      const weighted = ["block", "counter", "assault", "recover", "other"]
        .map((type) => [type, Math.max(0, Number(branch[`resource${type[0].toUpperCase()}${type.slice(1)}Count`]) || 0)])
        .filter(([, count]) => count > PROBABILITY_EPSILON);
      const total = weighted.reduce((sum, [, count]) => sum + count, 0);
      if (total <= PROBABILITY_EPSILON) {
        selections.push({ ...branch, selectedType:"other" });
        continue;
      }
      if (weighted.length === 1) {
        selections.push({ ...branch, selectedType:weighted[0][0] });
        continue;
      }
      for (const [type, count] of weighted) selections.push({
        ...branch,
        probability:branch.probability * count / total,
        conditions:{ ...branch.conditions, [key]:type },
        selectedType:type
      });
    }
    const selectedWorlds = mergeProbabilityStateBranches(selections);
    player.handResourceBranches = projectProbabilityStateBranches(selectedWorlds, (branch) => {
      const current = {
        handCount:branch.resourceHandCount,
        blockCount:branch.resourceBlockCount,
        counterCount:branch.resourceCounterCount,
        assaultCount:branch.resourceAssaultCount,
        recoverCount:branch.resourceRecoverCount,
        otherCount:branch.resourceOtherCount
      };
      if (!branch.selectedType) return current;
      const field = `${branch.selectedType}Count`;
      return { ...current, handCount:current.handCount - 1, [field]:current[field] - 1 };
    });
    this.syncHandResourceSummary(player);
    return projectProbabilityStateBranches(selectedWorlds, (branch) => ({
      occurs:Boolean(branch.occurs && branch.selectedType),
      selectedType:branch.selectedType
    }));
  }

  receiveSelectedHandResource(player, selectedWorlds) {
    const resource = this.ensureHandResourceBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceHandCount:branch.handCount,
      resourceBlockCount:branch.blockCount,
      resourceCounterCount:branch.counterCount,
      resourceAssaultCount:branch.assaultCount,
      resourceRecoverCount:branch.recoverCount,
      resourceOtherCount:branch.otherCount
    }));
    const joined = joinProbabilityStateBranches(resource, selectedWorlds);
    player.handResourceBranches = projectProbabilityStateBranches(joined, (branch) => {
      const result = {
        handCount:branch.resourceHandCount,
        blockCount:branch.resourceBlockCount,
        counterCount:branch.resourceCounterCount,
        assaultCount:branch.resourceAssaultCount,
        recoverCount:branch.resourceRecoverCount,
        otherCount:branch.resourceOtherCount
      };
      if (branch.occurs && branch.selectedType) {
        result.handCount += 1;
        result[`${branch.selectedType}Count`] += 1;
      }
      return result;
    });
    this.syncHandResourceSummary(player);
  }

  ensureEquipmentStateBranches(player) {
    if (Array.isArray(player.equipmentStateBranches) && player.equipmentStateBranches.length) {
      return mergeProbabilityStateBranches(player.equipmentStateBranches);
    }
    const definitionId = player.equipmentDefinitionId ?? null;
    const probability = definitionId ? clampProbability(player.equipmentRetentionProbability ?? 1) : 0;
    const key = `equipment:${player.id}:${definitionId ?? "none"}`;
    player.equipmentStateBranches = probability > PROBABILITY_EPSILON && probability < 1 - PROBABILITY_EPSILON
      ? [
        { probability, conditions:{ [key]:"present" }, definitionId, present:true },
        { probability:1 - probability, conditions:{ [key]:"absent" }, definitionId:null, present:false }
      ]
      : [{ probability:1, conditions:{}, definitionId:probability ? definitionId : null, present:Boolean(probability) }];
    return player.equipmentStateBranches;
  }

  syncEquipmentSummary(player) {
    player.equipmentStateBranches = mergeProbabilityStateBranches(player.equipmentStateBranches);
    const definitions = new Map();
    for (const branch of player.equipmentStateBranches) if (branch.present && branch.definitionId) {
      definitions.set(branch.definitionId, (definitions.get(branch.definitionId) ?? 0) + branch.probability);
    }
    const [definitionId, probability] = [...definitions.entries()].sort((left, right) => right[1] - left[1])[0] ?? [null, 0];
    player.equipmentDefinitionId = definitionId;
    player.equipmentRetentionProbability = probability;
  }

  updateEquipmentFromWorlds(player, worldBranches, transformer) {
    const equipment = this.ensureEquipmentStateBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      equipmentDefinition:branch.definitionId,
      equipmentPresent:Boolean(branch.present)
    }));
    const joined = joinProbabilityStateBranches(equipment, worldBranches);
    player.equipmentStateBranches = projectProbabilityStateBranches(joined, (branch) => {
      const next = transformer({
        definitionId:branch.equipmentDefinition,
        present:branch.equipmentPresent
      }, branch);
      return { definitionId:next.definitionId ?? null, present:Boolean(next.present && next.definitionId) };
    });
    this.syncEquipmentSummary(player);
    return joined;
  }

  getEquipmentPresenceBranches(player, definitionId, stateField = "equipmentPresent") {
    return this.ensureEquipmentStateBranches(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      [stateField]:Boolean(branch.present && branch.definitionId === definitionId)
    }));
  }

  ensureRecycleUseSlots(player) {
    if (Array.isArray(player.recycleUseSlots)) return player.recycleUseSlots;
    const used = Math.max(0, Number(player.recycleDeviceUses) || 0);
    const whole = Math.floor(used), fraction = used - whole;
    player.recycleUseSlots = Array.from({ length:2 }, (_, index) => {
      if (index < whole) return [{ probability:1, conditions:{}, available:false }];
      if (index > whole || fraction <= PROBABILITY_EPSILON) {
        return [{ probability:1, conditions:{}, available:true }];
      }
      const key = `legacyRecycleUse:${player.id}:${index}`;
      return [
        { probability:1 - fraction, conditions:{ [key]:"available" }, available:true },
        { probability:fraction, conditions:{ [key]:"used" }, available:false }
      ];
    });
    return player.recycleUseSlots;
  }

  ensureAttackUseSlots(player) {
    if (Array.isArray(player.attackUseSlots)) return player.attackUseSlots;
    const hasLimit = Number.isFinite(Number(player.attackLimit));
    const used = Math.max(0, Number(player.attackUsed) || 0);
    const limit = hasLimit ? Math.max(0, Math.ceil(Number(player.attackLimit))) : Math.max(1, Math.ceil(used + 1));
    const whole = Math.floor(used), fraction = used - whole;
    player.attackUseSlots = Array.from({ length:limit }, (_, index) => {
      if (index < whole) return [{ probability:1, conditions:{}, available:false }];
      if (index > whole || fraction <= PROBABILITY_EPSILON) {
        return [{ probability:1, conditions:{}, available:true }];
      }
      const key = `legacyAttackUse:${player.id}:${index}`;
      return [
        { probability:1 - fraction, conditions:{ [key]:"available" }, available:true },
        { probability:fraction, conditions:{ [key]:"used" }, available:false }
      ];
    });
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
    const whole = Math.floor(uses), fraction = uses - whole;
    player.activeSkillUseSlots = Array.from({ length:limit }, (_, index) => {
      if (index < whole) return [{ probability:1, conditions:{}, available:false }];
      if (index > whole || fraction <= PROBABILITY_EPSILON) {
        return [{ probability:1, conditions:{}, available:true }];
      }
      const key = `legacySkillUse:${player.id}:${skill?.id ?? "active"}:${index}`;
      return [
        { probability:1 - fraction, conditions:{ [key]:"available" }, available:true },
        { probability:fraction, conditions:{ [key]:"used" }, available:false }
      ];
    });
    return player.activeSkillUseSlots;
  }

  consumeSlot(state, slots, desiredEventWorlds, preferredIndex = null, label = "slot") {
    const indexes = preferredIndex == null
      ? slots.map((_, index) => index)
      : [preferredIndex];
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
      if (this.eventProbability(actualWorlds) <= PROBABILITY_EPSILON) continue;
      slots[index] = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.slotAvailable && !(branch.occurs && branch.slotAvailable))
      }));
      return { index, eventWorlds:actualWorlds };
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
    // Capture the pre-play hand before the concrete card may be removed from the visible hand array.
    this.ensureHandResourceBranches(actor);
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
    if (executionProbability <= 0) return next;
    this.consumePlayedCard(actor, cardEventWorlds, card.definitionId);
    const effectEventWorlds = card.counterScope === "target"
      ? cardEventWorlds
      : this.resolveCounterWorlds(next, actor, card, abstractAction.targets ?? [], cardEventWorlds);
    const scale = this.eventProbability(effectEventWorlds);

    switch (card.definitionId) {
      case "recover":
        this.healFrom(next, actor, actor, 1, effectEventWorlds);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        break;
      case "charge": this.changeEnergy(next, actor, 1, effectEventWorlds); break;
      case "shield": if (target?.alive && target.battleTeam === actor.battleTeam) this.changeShield(next, target, 1, effectEventWorlds); break;
      case "harvest": this.addHandResource(actor, effectEventWorlds, "other", 2); break;
      case "exposeWeakness":
        this.updateNumericStateFromWorlds(actor, "exposeWeaknessBranches",
          actor.exposeWeaknessStacks ?? 0, effectEventWorlds,
          (amount, branch) => amount + (branch.occurs ? 1 : 0), "exposeWeaknessStacks");
        break;
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          attackUseSlot:abstractAction.attackUseSlot
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetWorlds = this.resolveTargetCounterWorlds(next, actor, card, player, effectEventWorlds);
          this.applyDamage(next, actor, player, 1, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:targetWorlds
          });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetWorlds = this.resolveTargetCounterWorlds(next, actor, card, player, effectEventWorlds);
          const responseWorlds = this.consumeHandType(player, targetWorlds, "assault", 1);
          const responseState = projectProbabilityStateBranches(responseWorlds, (branch) => ({
            responded:Boolean(branch.occurs)
          }));
          const damageWorlds = projectProbabilityStateBranches(
            joinProbabilityStateBranches(targetWorlds, responseState),
            (branch) => ({ occurs:Boolean(branch.occurs && !branch.responded) })
          );
          this.applyDamage(next, actor, player, 1, {
            canBlock:false,
            deviceAttack:false,
            eventBranches:damageWorlds
          });
        }
        break;
      case "leverage": {
        const first = next.players.find((player) => player.id === abstractAction.selection?.firstTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
        const second = next.players.find((player) => player.id === abstractAction.selection?.secondTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[1]?.id);
        if (!first?.alive || !second?.alive || !first.equipmentDefinitionId) break;
        // 候选组合从不因手牌估计或次数删除；实际使用必须消费第一目标自己的次数槽。
        const assaultAvailable = Math.max(0, Math.min(1, first.assaultResponseProbability ?? 0));
        const equipmentValue = CARD_DEFINITIONS[first.equipmentDefinitionId]?.aiValue ?? 7;
        const friendlyFirePenalty = second.battleTeam === first.battleTeam ? .55 : 0;
        const defenseRisk = Math.min(.9, second.equipmentDefinitionId === "defenseDevice"
          ? Math.max(second.blockProbability ?? 0, BLOCK_CARD_COUNT / TOTAL_CARD_COUNT)
          : (second.blockProbability ?? 0));
        const targetValue = second.battleTeam === first.battleTeam
          ? -0.35 - (second.hp <= 2 ? .15 : 0)
          : .3 + (second.hp <= 2 ? .15 : 0);
        const conserveAssaultPenalty = (first.expectedAssaultCount ?? 0) <= .75 ? .18 : 0;
        const willingness = Math.max(.08, Math.min(.97,
          .42 + equipmentValue * .04 + targetValue - friendlyFirePenalty - defenseRisk * .2
          - conserveAssaultPenalty));
        const willingWorlds = this.gateEventWorlds(next, effectEventWorlds,
          willingness, `leverage-assault:${card.id}:${first.id}`);
        const desiredUseWorlds = this.handTypeAvailabilityWorlds(first, willingWorlds, "assault", 1);
        const consumedAttack = this.consumeAttackUse(next, first, desiredUseWorlds);
        const actualUseWorlds = this.consumeHandType(first, consumedAttack.eventWorlds, "assault", 1);
        const effectiveUseProbability = this.eventProbability(actualUseWorlds);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, actualUseWorlds, {
          sourceEquipmentConditional:true,
          attackUseConsumed:true
        });
        const used = projectProbabilityStateBranches(actualUseWorlds,
          (branch) => ({ leverageAccepted:Boolean(branch.occurs) }));
        const equipment = this.getEquipmentPresenceBranches(first,
          first.equipmentDefinitionId, "leverageEquipmentPresent");
        const declineWorlds = projectProbabilityStateBranches(
          joinProbabilityStateBranches(effectEventWorlds, used, equipment),
          (branch) => ({ occurs:Boolean(branch.occurs && !branch.leverageAccepted
            && branch.leverageEquipmentPresent) })
        );
        const effectiveDeclineProbability = this.eventProbability(declineWorlds);
        this.updateEquipmentFromWorlds(first, declineWorlds, (current, branch) => (
          branch.occurs ? { definitionId:null, present:false } : current
        ));
        this.addHandResource(actor, declineWorlds);
        actor.expectedEquipmentGain = (actor.expectedEquipmentGain ?? 0)
          + equipmentValue * effectiveDeclineProbability;
        break;
      }
      case "plunder":
        if (target) this.takeResourceToHand(next, actor, target, effectEventWorlds);
        break;
      case "transfer": {
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? null;
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? null;
        if (source && receiver && (source.handCount ?? 0) > 0 && abstractAction.selection?.zone !== "equipment") {
          const selected = this.takeHandResource(next, source, effectEventWorlds,
            `transfer:${card.id ?? card.definitionId}`);
          this.receiveSelectedHandResource(receiver, selected);
        }
        break;
      }
      case "destroy": if (target) this.destroyResource(next, target, effectEventWorlds); break;
      case "duel": if (target) this.applyDuel(next, actor, target, effectEventWorlds); break;
      case "mutualBenefit": for (const player of next.players) if (player.alive) this.addHandResource(player, effectEventWorlds); break;
      case "symbiosis": for (const player of next.players) if (player.alive) this.healFrom(next, actor, player, 1, effectEventWorlds); break;
      default:
        if (card.category === "equipment") this.updateEquipmentFromWorlds(actor, cardEventWorlds,
          (equipment, branch) => branch.occurs
            ? { definitionId:card.definitionId, present:true }
            : equipment);
        break;
    }
    if (card.category === "tactic") {
      const legacyRecycleUses = Math.max(0, Number(actor.recycleDeviceUses) || 0);
      const legacyFractionalRecycle = !Array.isArray(actor.recycleUseSlots)
        && Math.abs(legacyRecycleUses - Math.round(legacyRecycleUses)) > PROBABILITY_EPSILON;
      const equipment = this.getEquipmentPresenceBranches(actor, "recycleDevice", "recyclePresent");
      const desiredRecycle = projectProbabilityStateBranches(
        joinProbabilityStateBranches(cardEventWorlds, equipment),
        (branch) => ({ occurs:Boolean(branch.occurs && branch.recyclePresent) })
      );
      if (legacyFractionalRecycle) {
        // Convert an old scalar-only snapshot once; normal snapshots always carry concrete slots.
        const desiredProbability = this.eventProbability(desiredRecycle);
        const triggerProbability = Math.min(desiredProbability, Math.max(0, 2 - legacyRecycleUses));
        const consumed = this.gateEventWorlds(next, cardEventWorlds,
          executionProbability > 0 ? triggerProbability / executionProbability : 0,
          `legacy-recycle-slot:${actor.id}`);
        actor.recycleDeviceUses = legacyRecycleUses + triggerProbability;
        actor.recycleUseSlots = Array.from({ length:2 }, (_, index) => [{
          probability:1, conditions:{}, available:index >= Math.ceil(actor.recycleDeviceUses)
        }]);
        this.addHandResource(actor, consumed);
      } else {
      const slots = this.ensureRecycleUseSlots(actor);
      const consumed = this.consumeSlot(next, slots, desiredRecycle, null,
        `recycle-slot:${actor.id}`).eventWorlds;
      actor.recycleDeviceUses = slots.reduce((sum, slot) => sum
        + totalBranchProbability(slot.filter((branch) => !branch.available)), 0);
      this.addHandResource(actor, consumed);
      }
    }
    if (actor.generalId === "blade-walker" && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(actor, category, cardEventWorlds);
    }
    return next;
  }

  /** AI 模拟中装备定义与存在概率的唯一写入口；换装固定重置为完整的新装备。 */
  setSimulatedEquipment(player, definitionId, probability = 1) {
    const normalized = Math.max(0, Math.min(1, Number(probability) || 0));
    if (!definitionId || normalized === 0) {
      player.equipmentStateBranches = [{ probability:1, conditions:{}, definitionId:null, present:false }];
      this.syncEquipmentSummary(player);
      return;
    }
    const key = `equipment:${player.id ?? "unknown"}:${definitionId}`;
    player.equipmentStateBranches = normalized >= 1 - PROBABILITY_EPSILON
      ? [{ probability:1, conditions:{}, definitionId, present:true }]
      : [
        { probability:normalized, conditions:{ [key]:"present" }, definitionId, present:true },
        { probability:1 - normalized, conditions:{ [key]:"absent" }, definitionId:null, present:false }
      ];
    this.syncEquipmentSummary(player);
  }

  getSimulatedEquipmentProbability(player, definitionId = null) {
    if (!player) return 0;
    return totalBranchProbability(this.ensureEquipmentStateBranches(player).filter((branch) => (
      branch.present && branch.definitionId && (!definitionId || branch.definitionId === definitionId)
    )));
  }

  /** 连势按“该类别此前已使用”的概率累计，避免多个部分概率动作重复获得完整首次收益。 */
  simulateCategoryUseLegacy(player, category, useProbability = 1, lifeDamageProbability = 0) {
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

  /** 目标指定阶段的猎印概率使用联合概率；同一猎手每回合最多留下两次猎印。 */
  simulateCategoryUse(player, category, useWorlds = 1, lifeDamageWorlds = null) {
    if (!category || player?.generalId !== "blade-walker") return 0;
    const worlds = Array.isArray(useWorlds)
      ? useWorlds
      : probabilityEventPartition(`legacy-category:${player.id}:${category}`,
        clampProbability(useWorlds), "occurs");
    const hit = Array.isArray(lifeDamageWorlds)
      ? projectProbabilityStateBranches(lifeDamageWorlds,
        (branch) => ({ lifeDamage:Boolean(branch.occurs) }))
      : [{ probability:1, conditions:{}, lifeDamage:false }];
    player.categoriesUsed ??= [];
    player.categoryUsedProbabilities ??= {};
    player.categoryUseStateBranches ??= {};
    const existingCategory = player.categoryUseStateBranches[category]
      ?? [{ probability:1, conditions:{}, used:player.categoriesUsed.includes(category) }];
    const categoryState = mergeProbabilityStateBranches(existingCategory).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      categoryUsed:Boolean(branch.used)
    }));
    const momentum = this.getNumericStateBranches(player, "momentumBranches", player.momentum).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      momentumAmount:branch.amount
    }));
    const joined = joinProbabilityStateBranches(worlds, hit, categoryState, momentum);
    const resolved = mergeProbabilityStateBranches(joined.map((branch) => {
      let momentumAmount = branch.momentumAmount;
      if (branch.occurs && branch.lifeDamage) momentumAmount = 0;
      const firstUse = Boolean(branch.occurs && !branch.categoryUsed);
      if (firstUse) momentumAmount = Math.min(GAME_CONFIG.momentumMaxStacks, momentumAmount + 1);
      return { ...branch, probability:branch.probability, momentumAmount,
        categoryUsed:Boolean(branch.categoryUsed || branch.occurs), firstUse };
    }));
    player.momentumBranches = projectProbabilityStateBranches(resolved,
      (branch) => ({ amount:branch.momentumAmount }));
    player.momentum = expectedBranchValue(player.momentumBranches);
    player.categoryUseStateBranches[category] = projectProbabilityStateBranches(resolved,
      (branch) => ({ used:branch.categoryUsed }));
    const newUsedProbability = totalBranchProbability(
      player.categoryUseStateBranches[category].filter((branch) => branch.used)
    );
    player.categoryUsedProbabilities[category] = newUsedProbability;
    if (newUsedProbability >= 1 - PROBABILITY_EPSILON && !player.categoriesUsed.includes(category)) {
      player.categoriesUsed.push(category);
    }
    return totalBranchProbability(resolved.filter((branch) => branch.firstUse));
  }

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
  applyGuardianAidToDamageWorlds(state, target, damageWorlds) {
    let remaining = damageWorlds;
    for (const guardian of state.players) {
      if (!guardian.alive || guardian.generalId !== "oath-warden" || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const used = this.getBooleanStateBranches(guardian, "guardianAidStateBranches",
        guardian.guardianAidUsed).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        guardianUsed:Boolean(branch.used)
      }));
      const alive = this.ensureHpBranches(guardian).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        guardianAlive:Boolean(branch.alive)
      }));
      const hand = this.ensureHandResourceBranches(guardian).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        guardianHandCount:branch.handCount
      }));
      const desired = projectProbabilityStateBranches(
        joinProbabilityStateBranches(remaining, used, alive, hand),
        (branch) => ({ occurs:Boolean(branch.occurs && branch.amount > 0
          && !branch.guardianUsed && branch.guardianAlive && branch.guardianHandCount > 0) })
      );
      const actual = this.takeHandResource(state, guardian, desired,
        `guardian-aid:${guardian.id}:${target.id}`);
      this.updateBooleanStateFromWorlds(guardian, "guardianAidStateBranches",
        guardian.guardianAidUsed, actual,
        (wasUsed, branch) => Boolean(wasUsed || branch.occurs));
      guardian.guardianAidUsedProbability = totalBranchProbability(
        guardian.guardianAidStateBranches.filter((branch) => branch.used)
      );
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - PROBABILITY_EPSILON;
      const aided = projectProbabilityStateBranches(actual,
        (branch) => ({ guardianAided:Boolean(branch.occurs) }));
      remaining = projectProbabilityStateBranches(
        joinProbabilityStateBranches(remaining, aided),
        (branch) => ({ occurs:branch.occurs,
          amount:Math.max(0, branch.amount - (branch.guardianAided ? 1 : 0)) })
      );
    }
    return remaining;
  }

  simulateGuardianAid(state, target, incomingDamage, eventProbability) {
    let remainingDamage = Math.max(0, incomingDamage);
    for (const guardian of state.players) {
      if (remainingDamage <= 0) break;
      if (!guardian.alive || guardian.generalId !== "oath-warden" || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const oldUsedProbability = clampProbability(guardian.guardianAidUsedProbability
        ?? (guardian.guardianAidUsed ? 1 : 0));
      const handAvailability = Math.min(1, Math.max(0, Number(guardian.handCount) || 0));
      const triggerProbability = Math.min(remainingDamage,
        clampProbability(eventProbability) * (1 - oldUsedProbability) * handAvailability);
      if (triggerProbability <= 0) continue;
      guardian.handCount = Math.max(0, guardian.handCount - triggerProbability);
      guardian.guardianAidUsedProbability = clampProbability(oldUsedProbability + triggerProbability);
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - Number.EPSILON;
      remainingDamage = Math.max(0, remainingDamage - triggerProbability);
    }
    return remainingDamage;
  }

  /** 突袭造成生命伤害后的角色收益只在实际伤害分支触发。 */
  simulateAssaultAfterDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target) return;
    if (source.generalId === "shade-agent" && target.battleTeam !== source.battleTeam) {
      const worlds = lifeDamageBranches
        ?? this.getEventWorlds(state, chance, null, `spy-gap:${source.id}:${target.id}`);
      const used = this.getBooleanStateBranches(source, "spyGapStateBranches",
        source.spyGapTriggered).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        spyGapUsed:Boolean(branch.used)
      }));
      const hp = this.ensureHpBranches(target).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        spyTargetAlive:Boolean(branch.alive), spyTargetHp:branch.amount
      }));
      const hand = this.ensureHandResourceBranches(target).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        spyTargetHandCount:branch.handCount
      }));
      const resolved = joinProbabilityStateBranches(worlds, used, hp, hand).map((branch) => ({
        ...branch,
        triggers:Boolean(branch.occurs && !branch.spyGapUsed && branch.spyTargetAlive
          && branch.spyTargetHp > 0 && branch.spyTargetHandCount > 0)
      }));
      source.spyGapStateBranches = projectProbabilityStateBranches(resolved, (branch) => ({
        used:Boolean(branch.spyGapUsed || branch.triggers)
      }));
      source.spyGapTriggeredProbability = totalBranchProbability(
        source.spyGapStateBranches.filter((branch) => branch.used)
      );
      source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - PROBABILITY_EPSILON;
      source.expectedInformationGain = (source.expectedInformationGain ?? 0)
        + resolved.reduce((sum, branch) => sum + (branch.triggers
          ? branch.probability * Math.min(2, branch.spyTargetHandCount) : 0), 0);
    }
    if (source.generalId === "ember-magus" && target.battleTeam !== source.battleTeam) {
      const worlds = lifeDamageBranches
        ?? this.getEventWorlds(state, chance, null, `ember-energy:${source.id}:${target.id}`);
      this.changeEnergy(state, source, 1, worlds);
    }
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
    const expose = this.getNumericStateBranches(source, "exposeWeaknessBranches",
      source.exposeWeaknessStacks ?? 0).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions, exposeAmount:branch.amount
    }));
    const bonus = this.getNumericStateBranches(source, "assaultBonusBranches",
      source.assaultBonus ?? 0).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions, assaultBonusAmount:branch.amount
    }));
    const momentum = this.getNumericStateBranches(source, "momentumBranches",
      source.generalId === "blade-walker" ? source.momentum ?? 0 : 0).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions, momentumAmount:branch.amount
    }));
    let damageWorlds = projectProbabilityStateBranches(
      joinProbabilityStateBranches(assaultWorlds, expose, bonus, momentum),
      (branch) => ({ occurs:Boolean(branch.occurs),
        amount:1 + branch.exposeAmount + branch.assaultBonusAmount + branch.momentumAmount })
    );
    damageWorlds = this.applyGuardianAidToDamageWorlds(state, target, damageWorlds);
    const damageOutcome = {};
    this.applyDamage(state, source, target, damageWorlds, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:damageWorlds,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    this.updateNumericStateFromWorlds(source, "exposeWeaknessBranches",
      source.exposeWeaknessStacks ?? 0, assaultWorlds,
      (amount, branch) => branch.occurs ? 0 : amount, "exposeWeaknessStacks");
    this.updateNumericStateFromWorlds(source, "assaultBonusBranches",
      source.assaultBonus ?? 0, assaultWorlds,
      (amount, branch) => branch.occurs ? 0 : amount, "assaultBonus");
    this.simulateCategoryUse(source, "basic", assaultWorlds, damageOutcome.lifeDamageBranches);
    this.simulateAssaultAfterDamage(state, source, target, lifeDamageChance, damageOutcome.lifeDamageBranches);
    return lifeDamageChance;
  }

  takeResourceToHand(state, actor, target, eventWorlds) {
    if (!Array.isArray(state?.players)) {
      const legacyActor = state, legacyTarget = actor, probability = target;
      state = { players:[legacyActor, legacyTarget] };
      actor = legacyActor;
      target = legacyTarget;
      eventWorlds = this.getEventWorlds(state, probability ?? 1, null, "legacy-plunder");
    }
    const takeEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (takeEquipment) {
      const definitionId = target.equipmentDefinitionId;
      const equipment = this.getEquipmentPresenceBranches(target, definitionId, "takeEquipmentPresent");
      const actual = projectProbabilityStateBranches(
        joinProbabilityStateBranches(eventWorlds, equipment),
        (branch) => ({ occurs:Boolean(branch.occurs && branch.takeEquipmentPresent) })
      );
      this.updateEquipmentFromWorlds(target, actual, (current, branch) => (
        branch.occurs ? { definitionId:null, present:false } : current
      ));
      this.addHandResource(actor, actual);
    } else {
      const selected = this.takeHandResource(state, target, eventWorlds, "plunder");
      this.receiveSelectedHandResource(actor, selected);
    }
  }

  destroyResource(state, target, eventWorlds) {
    if (!Array.isArray(state?.players)) {
      const legacyTarget = state, probability = target;
      state = { players:[legacyTarget] };
      target = legacyTarget;
      eventWorlds = this.getEventWorlds(state, probability ?? 1, null, "legacy-destroy");
    }
    const destroyEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (destroyEquipment) {
      const definitionId = target.equipmentDefinitionId;
      const equipment = this.getEquipmentPresenceBranches(target, definitionId, "destroyEquipmentPresent");
      const actual = projectProbabilityStateBranches(
        joinProbabilityStateBranches(eventWorlds, equipment),
        (branch) => ({ occurs:Boolean(branch.occurs && branch.destroyEquipmentPresent) })
      );
      this.updateEquipmentFromWorlds(target, actual, (current, branch) => (
        branch.occurs ? { definitionId:null, present:false } : current
      ));
    } else this.takeHandResource(state, target, eventWorlds, "destroy");
  }

  tacticResolutionChance(state, actor, card, targets = []) {
    if (card.category !== "tactic" || card.counterable === false) return 1;
    return state.players.filter((player) => player.alive && player.id !== actor.id)
      .reduce((chance, player) => chance * (1 - (player.counterProbability ?? 0) * this.counterDesire(state, player, actor, card, targets)), 1);
  }

  resolveCounterWorlds(state, actor, card, targets, eventWorlds, responders = null) {
    if (card.category !== "tactic" || card.counterable === false) return eventWorlds;
    const eligible = responders ?? state.players.filter((player) => player.alive && player.id !== actor.id);
    let remaining = eventWorlds;
    for (const responder of eligible) {
      const desire = this.counterDesire(state, responder, actor, card, targets);
      if (desire <= PROBABILITY_EPSILON) continue;
      const desired = this.gateEventWorlds(state, remaining, desire,
        `counter-desire:${card.id ?? card.definitionId}:${responder.id}`);
      const countered = this.consumeHandType(responder, desired, "counter", 1);
      const renamed = projectProbabilityStateBranches(countered, (branch) => ({
        countered:Boolean(branch.occurs)
      }));
      remaining = projectProbabilityStateBranches(
        joinProbabilityStateBranches(remaining, renamed),
        (branch) => ({ occurs:Boolean(branch.occurs && !branch.countered) })
      );
    }
    return remaining;
  }

  resolveTargetCounterWorlds(state, actor, card, target, eventWorlds) {
    if (card.counterScope !== "target") return eventWorlds;
    return this.resolveCounterWorlds(state, actor, card, [target], eventWorlds, [target]);
  }

  targetResolutionChance(state, actor, card, target) {
    if (card.counterScope !== "target") return 1;
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
      const spentWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(branch.occurs), spentEnergy:branch.occurs ? branch.energyAmount : 0
      }));
      this.addHandResource(actor, spentWorlds, "other", (_resource, branch) => branch.spentEnergy);
      const bonusWorlds = this.splitEventWorldsByChance(state, spentWorlds,
        (branch) => Math.min(1, branch.spentEnergy * .3), `all-in-bonus:${actor.id}`);
      this.updateNumericStateFromWorlds(actor, "assaultBonusBranches", actor.assaultBonus ?? 0,
        bonusWorlds, (amount, branch) => amount + (branch.occurs ? 1 : 0), "assaultBonus");
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
      this.healFrom(state, actor, target, 1, eventWorlds);
      if (target.id !== actor.id) this.healFrom(state, actor, actor, 1, eventWorlds);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, eventWorlds);
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
      this.addHandResource(actor, outcome.blockedByCardBranches
        ?? this.getEventWorlds(state, outcome.blockedByCardChance ?? 0, null,
          `hunt-block-reward:${actor.id}:${target.id}`));
    } else if (skill.id === "resonance" && target) this.addHandResource(target, eventWorlds, "other", 2);
  }

  /** 窃取所得资源只增加手牌；目标仅有装备时，模拟中明确移除装备且不替换施术者装备。 */
  stealResourceToHand(state, actor, target, eventWorlds = null) {
    if (!Array.isArray(state?.players)) {
      const legacyActor = state, legacyTarget = actor, probability = target;
      state = { players:[legacyActor, legacyTarget] };
      actor = legacyActor;
      target = legacyTarget;
      eventWorlds = this.getEventWorlds(state, probability ?? 1, null, "legacy-steal");
    }
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, `steal:${actor.id}:${target.id}`);
    const hand = this.ensureHandResourceBranches(target).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      resourceHandCount:branch.handCount, resourceBlockCount:branch.blockCount,
      resourceCounterCount:branch.counterCount, resourceAssaultCount:branch.assaultCount,
      resourceRecoverCount:branch.recoverCount, resourceOtherCount:branch.otherCount
    }));
    const equipment = this.ensureEquipmentStateBranches(target).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      stealEquipmentDefinition:branch.definitionId,
      stealEquipmentPresent:Boolean(branch.present)
    }));
    const joined = joinProbabilityStateBranches(worlds, hand, equipment);
    const selectionKey = this.nextProbabilityEventKey(state, `steal-pick:${actor.id}:${target.id}`);
    const selections = [];
    for (const branch of joined) {
      const types = ["block", "counter", "assault", "recover", "other"]
        .map((type) => [type, Math.max(0, Number(branch[`resource${type[0].toUpperCase()}${type.slice(1)}Count`]) || 0)])
        .filter(([, count]) => count > PROBABILITY_EPSILON);
      if (branch.stealEquipmentPresent) types.push(["equipment", 1]);
      const total = types.reduce((sum, [, count]) => sum + count, 0);
      if (!branch.occurs || total <= PROBABILITY_EPSILON) {
        selections.push({ ...branch, selectedType:null });
        continue;
      }
      if (types.length === 1) {
        selections.push({ ...branch, selectedType:types[0][0] });
        continue;
      }
      for (const [type, count] of types) selections.push({
        ...branch,
        probability:branch.probability * count / total,
        conditions:{ ...branch.conditions, [selectionKey]:type },
        selectedType:type
      });
    }
    const selected = mergeProbabilityStateBranches(selections);
    target.handResourceBranches = projectProbabilityStateBranches(selected, (branch) => {
      const result = { handCount:branch.resourceHandCount, blockCount:branch.resourceBlockCount,
        counterCount:branch.resourceCounterCount, assaultCount:branch.resourceAssaultCount,
        recoverCount:branch.resourceRecoverCount, otherCount:branch.resourceOtherCount };
      if (branch.selectedType && branch.selectedType !== "equipment") {
        result.handCount -= 1; result[`${branch.selectedType}Count`] -= 1;
      }
      return result;
    });
    this.syncHandResourceSummary(target);
    target.equipmentStateBranches = projectProbabilityStateBranches(selected, (branch) => ({
      definitionId:branch.selectedType === "equipment" ? null : branch.stealEquipmentDefinition,
      present:Boolean(branch.stealEquipmentPresent && branch.selectedType !== "equipment")
    }));
    this.syncEquipmentSummary(target);
    const gained = projectProbabilityStateBranches(selected, (branch) => ({
      occurs:Boolean(branch.selectedType),
      selectedType:branch.selectedType === "equipment" ? "other" : branch.selectedType
    }));
    this.receiveSelectedHandResource(actor, gained);
  }

  applyDuel(state, actor, target, scale) {
    const eventWorlds = Array.isArray(scale)
      ? scale
      : this.getEventWorlds(state, clampProbability(scale), null, `duel:${actor.id}:${target.id}`);
    const actorHand = this.ensureHandResourceBranches(actor).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      actorHandCount:branch.handCount, actorBlockCount:branch.blockCount,
      actorCounterCount:branch.counterCount, actorAssaultCount:branch.assaultCount,
      actorRecoverCount:branch.recoverCount, actorOtherCount:branch.otherCount
    }));
    const targetHand = this.ensureHandResourceBranches(target).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      targetHandCount:branch.handCount, targetBlockCount:branch.blockCount,
      targetCounterCount:branch.counterCount, targetAssaultCount:branch.assaultCount,
      targetRecoverCount:branch.recoverCount, targetOtherCount:branch.otherCount
    }));
    const resolved = mergeProbabilityStateBranches(
      joinProbabilityStateBranches(eventWorlds, actorHand, targetHand).map((branch) => {
        if (!branch.occurs) return { ...branch, loserId:null };
        const loserId = branch.targetAssaultCount <= branch.actorAssaultCount ? target.id : actor.id;
        const actorSpent = Math.min(branch.actorAssaultCount,
          branch.targetAssaultCount + (loserId === target.id ? 1 : 0));
        const targetSpent = Math.min(branch.targetAssaultCount,
          branch.actorAssaultCount + (loserId === actor.id ? 1 : 0));
        return { ...branch, probability:branch.probability, loserId,
          actorHandCount:branch.actorHandCount - actorSpent,
          actorAssaultCount:branch.actorAssaultCount - actorSpent,
          targetHandCount:branch.targetHandCount - targetSpent,
          targetAssaultCount:branch.targetAssaultCount - targetSpent };
      })
    );
    actor.handResourceBranches = projectProbabilityStateBranches(resolved, (branch) => ({
      handCount:branch.actorHandCount, blockCount:branch.actorBlockCount,
      counterCount:branch.actorCounterCount, assaultCount:branch.actorAssaultCount,
      recoverCount:branch.actorRecoverCount, otherCount:branch.actorOtherCount
    }));
    target.handResourceBranches = projectProbabilityStateBranches(resolved, (branch) => ({
      handCount:branch.targetHandCount, blockCount:branch.targetBlockCount,
      counterCount:branch.targetCounterCount, assaultCount:branch.targetAssaultCount,
      recoverCount:branch.targetRecoverCount, otherCount:branch.targetOtherCount
    }));
    this.syncHandResourceSummary(actor); this.syncHandResourceSummary(target);
    for (const loser of [actor, target]) {
      const damageWorlds = projectProbabilityStateBranches(resolved, (branch) => ({
        occurs:branch.loserId === loser.id
      }));
      const source = loser.id === target.id ? actor : target;
      this.applyDamage(state, source, loser, 1, { canBlock:false, eventBranches:damageWorlds });
    }
  }

  applyDamage(state, attacker, target, amount, options = {}) {
    if (!target.alive || (!Array.isArray(amount) && amount <= 0)) {
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
    const legacyBlockChance = clampProbability(target.blockProbability ?? 0);
    const legacyTwoBlockChance = clampProbability(target.twoBlockProbability ?? 0);
    const legacyInconsistentHand = (Number(target.handCount) || 0) + PROBABILITY_EPSILON
      < legacyBlockChance;
    const legacyHandCount = Math.max(0, Number(target.handCount) || 0);
    const battleState = options.attackerEquipmentProbability === 1
      ? [{ probability:1, conditions:{}, battlePresent:true }]
      : this.getEquipmentPresenceBranches(attacker, "battleDevice", "battlePresent");
    const defenseState = options.deviceAttack
      ? this.getEquipmentPresenceBranches(target, "defenseDevice", "defensePresent")
      : [{ probability:1, conditions:{}, defensePresent:false }];
    const judgmentProbabilities = options.radarJudgmentProbabilities ?? {};
    const judgment = {
      block:clampProbability(judgmentProbabilities.block ?? BLOCK_CARD_COUNT / TOTAL_CARD_COUNT),
      other:clampProbability(judgmentProbabilities.otherBasic ?? OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT),
      equipment:clampProbability(judgmentProbabilities.equipment ?? EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT)
    };
    judgment.tactic = Math.max(0, 1 - judgment.block - judgment.other - judgment.equipment);
    const judgmentTotal = Object.values(judgment).reduce((sum, value) => sum + value, 0) || 1;
    const judgmentKey = this.nextProbabilityEventKey(state,
      `radar:${attacker?.id ?? "unknown"}:${target.id}`);
    const defenseAndJudgment = [];
    for (const defenseBranch of defenseState) {
      if (!defenseBranch.defensePresent) {
        defenseAndJudgment.push({ ...defenseBranch, judgmentKind:"none" });
        continue;
      }
      for (const [kind, probability] of Object.entries(judgment)) {
        if (probability <= PROBABILITY_EPSILON) continue;
        defenseAndJudgment.push({
          ...defenseBranch,
          probability:defenseBranch.probability * probability / judgmentTotal,
          conditions:{ ...defenseBranch.conditions, [judgmentKey]:kind },
          judgmentKind:kind
        });
      }
    }
    const handState = this.ensureHandResourceBranches(target).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      resourceHandCount:branch.handCount,
      resourceBlockCount:branch.blockCount,
      resourceCounterCount:branch.counterCount,
      resourceAssaultCount:branch.assaultCount,
      resourceRecoverCount:branch.recoverCount,
      resourceOtherCount:branch.otherCount
    }));
    const shieldState = getValueBranches(target, "shield", target.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const hpState = this.ensureHpBranches(target).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      hpAmount:branch.amount,
      hpAlive:Boolean(branch.alive)
    }));
    const amountState = Array.isArray(amount)
      ? projectProbabilityStateBranches(amount, (branch) => ({ damageAmount:Math.max(0, Number(branch.amount) || 0) }))
      : [{ probability:1, conditions:{}, damageAmount:Math.max(0, Number(amount) || 0) }];
    const joined = joinProbabilityStateBranches(eventWorlds, battleState, defenseAndJudgment,
      handState, shieldState, hpState, amountState);
    const resolved = mergeProbabilityStateBranches(joined.map((branch) => {
      let handCount = branch.resourceHandCount;
      let blockCount = branch.resourceBlockCount;
      let otherCount = branch.resourceOtherCount;
      const active = Boolean(branch.occurs && branch.hpAlive);
      let radarPrevented = false;
      if (active && branch.defensePresent) {
        if (branch.judgmentKind === "tactic") radarPrevented = true;
        else if (branch.judgmentKind === "block") { handCount += 1; blockCount += 1; }
        else if (branch.judgmentKind === "other") { handCount += 1; otherCount += 1; }
      }
      const requiredBlocks = branch.battlePresent ? 2 : 1;
      const blocked = Boolean(active && !radarPrevented && options.canBlock
        && blockCount >= requiredBlocks);
      if (blocked) { handCount = Math.max(0, handCount - requiredBlocks); blockCount -= requiredBlocks; }
      const passes = Boolean(active && !radarPrevented && !blocked);
      const absorbed = passes ? Math.min(branch.shieldAmount, branch.damageAmount) : 0;
      const hpDamage = passes ? Math.max(0, branch.damageAmount - absorbed) : 0;
      return {
        ...branch,
        probability:branch.probability,
        resolvedHandCount:handCount,
        resolvedBlockCount:blockCount,
        resolvedOtherCount:otherCount,
        blocked,
        passes,
        shieldAfter:branch.shieldAmount - absorbed,
        hpAfter:branch.hpAmount - hpDamage,
        hpDamage,
        lifeDamaged:hpDamage > PROBABILITY_EPSILON
      };
    }));
    target.handResourceBranches = projectProbabilityStateBranches(resolved, (branch) => ({
      handCount:branch.resolvedHandCount,
      blockCount:branch.resolvedBlockCount,
      counterCount:branch.resourceCounterCount,
      assaultCount:branch.resourceAssaultCount,
      recoverCount:branch.resourceRecoverCount,
      otherCount:branch.resolvedOtherCount
    }));
    this.syncHandResourceSummary(target);
    if (legacyInconsistentHand && options.deviceAttack) {
      // Some hand-authored legacy search fixtures provide block odds with handCount=0.
      // Resource branches remain authoritative; only retain their historical scalar evaluator value.
      const battleProbability = totalBranchProbability(battleState.filter((branch) => branch.battlePresent));
      const defenseProbability = totalBranchProbability(defenseState.filter((branch) => branch.defensePresent));
      const normalBlockChance = legacyBlockChance;
      const twoBlockChance = legacyTwoBlockChance;
      const basicChance = judgment.block + judgment.other;
      const normalSpent = options.canBlock
        ? judgment.block + (judgment.other + judgment.equipment) * normalBlockChance : 0;
      const battleSpent = options.canBlock
        ? 2 * (judgment.block * normalBlockChance
          + (judgment.other + judgment.equipment) * twoBlockChance) : 0;
      const expectedSpent = (1 - defenseProbability)
        * (battleProbability * twoBlockChance * 2 + (1 - battleProbability) * normalBlockChance)
        + defenseProbability * (battleProbability * battleSpent + (1 - battleProbability) * normalSpent);
      target.handCount = Math.max(0, legacyHandCount
        + eventProbability * defenseProbability * basicChance
        - eventProbability * expectedSpent);
    }
    target.shieldBranches = projectProbabilityStateBranches(resolved, (branch) => ({ amount:branch.shieldAfter }));
    target.shield = expectedBranchValue(target.shieldBranches);
    target.hpBranches = projectProbabilityStateBranches(resolved, (branch) => ({
      amount:branch.hpAfter,
      alive:branch.hpAlive
    }));
    const actualDamage = resolved.reduce((sum, branch) => sum + branch.probability * branch.hpDamage, 0);
    if (options.outcome) {
      options.outcome.lifeDamageBranches = projectProbabilityStateBranches(resolved, (branch) => ({ occurs:branch.lifeDamaged }));
      options.outcome.lifeDamageChance = this.eventProbability(options.outcome.lifeDamageBranches);
      options.outcome.blockedByCardBranches = projectProbabilityStateBranches(resolved, (branch) => ({
        occurs:branch.blocked
      }));
      options.outcome.blockedByCardChance = totalBranchProbability(resolved.filter((branch) => branch.blocked));
    }
    this.resolveFatal(state, target, attacker);
    return actualDamage;
  }

  applyHpLoss(state, target, amount, eventWorlds = null) {
    if (!target.alive || amount <= 0) return;
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, `hp-loss:${target.id}`);
    const hp = this.ensureHpBranches(target).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      hpAmount:branch.amount, hpAlive:Boolean(branch.alive)
    }));
    target.hpBranches = projectProbabilityStateBranches(
      joinProbabilityStateBranches(hp, worlds),
      (branch) => ({
        amount:branch.occurs && branch.hpAlive ? branch.hpAmount - amount : branch.hpAmount,
        alive:branch.hpAlive
      })
    );
    this.resolveFatal(state, target);
  }

  resolveFatal(state, target, attacker = null) {
    if (!target.alive) return;
    let targetWorlds = this.ensureHpBranches(target).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      hpAmount:branch.amount,
      hpAlive:Boolean(branch.alive)
    }));
    if (!targetWorlds.some((branch) => branch.hpAlive && branch.hpAmount <= 0)) {
      this.syncHpSummary(target);
      return;
    }
    const allies = state.players.filter((player) => player.alive && player.battleTeam === target.battleTeam)
      .sort((a,b) => (a.id === target.id ? -1 : b.id === target.id ? 1 : a.seatIndex - b.seatIndex));
    const criticalMass = totalBranchProbability(targetWorlds.filter((branch) => branch.hpAlive && branch.hpAmount <= 0));
    const conditionalNeed = criticalMass > PROBABILITY_EPSILON
      ? targetWorlds.reduce((sum, branch) => sum + (branch.hpAlive && branch.hpAmount <= 0
        ? branch.probability * (1 - branch.hpAmount) : 0), 0) / criticalMass
      : 0;
    const estimatedRescueCapacity = allies.reduce((sum, player) => sum
      + Math.max(0, Number(player.expectedRecoverCount) || 0)
      + (player.generalId === "spirit-medic" && !player.rejuvenationUsed
        ? Math.min(1, Math.max(0, Number(player.expectedRecoverCount) || 0)) : 0), 0);
    const legacyRescuePotential = conditionalNeed > 0
      ? Math.min(1, estimatedRescueCapacity / conditionalNeed)
      : 0;
    for (const rescuer of allies) {
      const rescuerHp = this.ensureHpBranches(rescuer).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        rescuerHpAlive:Boolean(branch.alive)
      }));
      const hand = this.ensureHandResourceBranches(rescuer).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        rescueHandCount:branch.handCount, rescueBlockCount:branch.blockCount,
        rescueCounterCount:branch.counterCount, rescueAssaultCount:branch.assaultCount,
        rescueRecoverCount:branch.recoverCount, rescueOtherCount:branch.otherCount
      }));
      const rejuvenation = this.getBooleanStateBranches(rescuer, "rejuvenationStateBranches",
        rescuer.rejuvenationUsed).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        rejuvenationUsed:Boolean(branch.used)
      }));
      const joined = joinProbabilityStateBranches(targetWorlds, rescuerHp, hand, rejuvenation);
      const resolved = mergeProbabilityStateBranches(joined.map((branch) => {
        let hpAmount = branch.hpAmount;
        let recoverCount = branch.rescueRecoverCount;
        let handCount = branch.rescueHandCount;
        let otherCount = branch.rescueOtherCount;
        let rejuvenationUsed = branch.rejuvenationUsed;
        let remaining = branch.hpAlive && hpAmount <= 0 ? 1 - hpAmount : 0;
        let spent = 0;
        if (remaining > 0 && branch.rescuerHpAlive && recoverCount > 0) {
          if (rescuer.generalId === "spirit-medic" && !rejuvenationUsed) {
            spent += 1; recoverCount -= 1; handCount -= 1;
            hpAmount += 2; remaining -= 2; rejuvenationUsed = true;
            handCount += 1; otherCount += 1;
          }
          const regularSpent = Math.min(recoverCount, Math.max(0, Math.ceil(remaining)));
          spent += regularSpent; recoverCount -= regularSpent; handCount -= regularSpent;
          hpAmount += regularSpent;
        }
        return { ...branch, probability:branch.probability, hpAmount,
          rescueHandCount:handCount, rescueRecoverCount:recoverCount,
          rescueOtherCount:otherCount, rejuvenationUsed, rescueSpent:spent };
      }));
      targetWorlds = projectProbabilityStateBranches(resolved, (branch) => ({
        hpAmount:branch.hpAmount, hpAlive:branch.hpAlive
      }));
      rescuer.handResourceBranches = projectProbabilityStateBranches(resolved, (branch) => ({
        handCount:branch.rescueHandCount, blockCount:branch.rescueBlockCount,
        counterCount:branch.rescueCounterCount, assaultCount:branch.rescueAssaultCount,
        recoverCount:branch.rescueRecoverCount, otherCount:branch.rescueOtherCount
      }));
      this.syncHandResourceSummary(rescuer);
      rescuer.rejuvenationStateBranches = projectProbabilityStateBranches(resolved, (branch) => ({
        used:branch.rejuvenationUsed
      }));
      rescuer.rejuvenationUsed = totalBranchProbability(
        rescuer.rejuvenationStateBranches.filter((branch) => branch.used)
      ) >= 1 - PROBABILITY_EPSILON;
    }
    const finalWorlds = targetWorlds.map((branch) => ({
      ...branch,
      died:Boolean(branch.hpAlive && branch.hpAmount <= 0),
      finalAlive:Boolean(branch.hpAlive && branch.hpAmount > 0)
    }));
    const deathWorlds = projectProbabilityStateBranches(finalWorlds, (branch) => ({ occurs:branch.died }));
    target.hpBranches = projectProbabilityStateBranches(finalWorlds, (branch) => ({
      amount:branch.finalAlive ? Math.min(target.maxHp, branch.hpAmount) : 0,
      alive:branch.finalAlive
    }));
    this.syncHpSummary(target);
    if (target.aliveProbability <= PROBABILITY_EPSILON && legacyRescuePotential > 0) {
      // Keep the historical evaluator hint separate from exact alive/death probabilities.
      target.survivalChance = legacyRescuePotential;
    }
    if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
      const attackerAlive = this.ensureHpBranches(attacker).map((branch) => ({
        probability:branch.probability, conditions:branch.conditions,
        attackerAlive:Boolean(branch.alive)
      }));
      const rewardWorlds = projectProbabilityStateBranches(
        joinProbabilityStateBranches(deathWorlds, attackerAlive),
        (branch) => ({ occurs:Boolean(branch.occurs && branch.attackerAlive) })
      );
      this.addHandResource(attacker, rewardWorlds, "other", GAME_CONFIG.killRewardDrawCount);
    }
    if (target.aliveProbability <= PROBABILITY_EPSILON) {
      target.exposeWeaknessStacks = 0;
      target.assaultBonus = 0;
      target.huntMarkSourceId = null;
      target.huntMarkProbability = 0;
      target.huntMarkProbabilities = {};
      target.momentum = 0;
      target.statuses = [];
    }
  }

  heal(target, amount) {
    if (!target.alive || amount <= 0) return;
    target.hpBranches = this.ensureHpBranches(target).map((branch) => ({
      ...branch,
      amount:branch.alive ? Math.min(target.maxHp, branch.amount + amount) : branch.amount
    }));
    this.syncHpSummary(target);
  }

  /** 模拟由角色发起的治疗；灵医首次治疗己方时同步计算回春的治疗与摸牌收益。 */
  healFrom(state, source, target, amount, eventWorlds = null) {
    if (!target?.alive || amount <= 0) return;
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, `heal:${source?.id}:${target.id}`);
    const hp = this.ensureHpBranches(target).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      healHpAmount:branch.amount, healHpAlive:Boolean(branch.alive)
    }));
    const rejuvenation = this.getBooleanStateBranches(source, "rejuvenationStateBranches",
      source.rejuvenationUsed).map((branch) => ({
      probability:branch.probability, conditions:branch.conditions,
      rejuvenationUsed:Boolean(branch.used)
    }));
    const joined = joinProbabilityStateBranches(worlds, hp, rejuvenation);
    const resolved = mergeProbabilityStateBranches(joined.map((branch) => {
      const heals = Boolean(branch.occurs && branch.healHpAlive && branch.healHpAmount < target.maxHp);
      const triggers = Boolean(heals && source?.generalId === "spirit-medic"
        && source.battleTeam === target.battleTeam && !branch.rejuvenationUsed);
      return { ...branch, probability:branch.probability,
        healHpAmount:heals ? Math.min(target.maxHp, branch.healHpAmount + amount + (triggers ? 1 : 0)) : branch.healHpAmount,
        rejuvenationUsed:Boolean(branch.rejuvenationUsed || triggers), rejuvenationTriggered:triggers };
    }));
    target.hpBranches = projectProbabilityStateBranches(resolved, (branch) => ({
      amount:branch.healHpAmount, alive:branch.healHpAlive
    }));
    this.syncHpSummary(target);
    source.rejuvenationStateBranches = projectProbabilityStateBranches(resolved, (branch) => ({
      used:branch.rejuvenationUsed
    }));
    source.rejuvenationUsed = totalBranchProbability(
      source.rejuvenationStateBranches.filter((branch) => branch.used)
    ) >= 1 - PROBABILITY_EPSILON;
    this.addHandResource(source, projectProbabilityStateBranches(resolved, (branch) => ({
      occurs:branch.rejuvenationTriggered
    })));
  }
}
