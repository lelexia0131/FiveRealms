/**
 * AI 合法动作生成器。真实根节点依赖 RuleEngine，深层节点使用同一 RuleEngine
 * 读取过滤快照；不评分、不执行动作，也不接触其他玩家真实手牌。
 */
import { RuleEngine } from "../core/RuleEngine.js?build=20260802-resource-branches-v57";
import { ACTIVE_SKILLS, getActiveSkill } from "../generals/skillRegistry.js?build=20260802-resource-branches-v57";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260802-resource-branches-v57";
import { buildTransferCandidates, chooseBestPositiveTransfer } from "./transferScoring.js?build=20260802-resource-branches-v57";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260802-resource-branches-v57";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  binaryConditionPartition,
  getAvailabilityStateBranches,
  getValueBranches,
  huntMarkConditionKey,
  joinProbabilityStateBranches,
  mergeProbabilityBranches,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "./AiProbabilityBranches.js?build=20260802-resource-branches-v57";

/** 生成当前真实局面与模拟后续局面的合法动作。 */
export class AiActionGenerator {
  constructor(game) { this.game = game; }

  expectedAvailableAssaults(actor) {
    return (actor.hand ?? []).filter((card) => card.definitionId === "assault")
      .reduce((sum, card) => sum + totalBranchProbability(getAvailabilityStateBranches(card)
        .filter((branch) => branch.available)), 0);
  }

  expectedAvailableAttackUses(actor) {
    const slots = Array.isArray(actor.attackUseSlots)
      ? actor.attackUseSlots
      : null;
    if (slots) {
      return slots.reduce((sum, slot) => sum + totalBranchProbability(
        (slot ?? []).filter((branch) => branch.available)
      ), 0);
    }
    const limit = Number(actor.attackLimit ?? actor.turnFlags?.attackLimit) || 0;
    const used = Number(actor.attackUsed ?? actor.turnFlags?.attackUsed) || 0;
    return Math.max(0, limit - used);
  }

  canBenefitFromBreakArmy(actor) {
    return this.expectedAvailableAssaults(actor)
      > this.expectedAvailableAttackUses(actor) + PROBABILITY_EPSILON;
  }

  chooseVisibleTransferPlan(game, actor, card) {
    const sources = RuleEngine.getTransferSources(game, actor, card);
    const excludedCardIds = card.id ? new Set([card.id]) : null;
    return chooseBestPositiveTransfer(buildTransferCandidates({
      actor, sources, excludedCardIds,
      getReceivers:(from) => RuleEngine.getTransferReceivers(game, actor, from, card)
    }));
  }

  generate(player) {
    const actions = [];
    for (const card of player.hand) {
      if (!RuleEngine.canPlayCard(this.game, player, card).ok) continue;
      const targets = RuleEngine.getCardTargets(this.game, player, card);
      if (card.definitionId === "leverage") {
        for (const firstTarget of RuleEngine.getLeverageFirstTargets(this.game, player)) {
          for (const secondTarget of RuleEngine.getAssaultTargetCandidates(this.game, firstTarget)) {
            actions.push({
              type:"card",
              card,
              targets:[firstTarget, secondTarget],
              selection:{
                firstTargetId:firstTarget.id,
                equipmentCardId:firstTarget.equipment.id,
                secondTargetId:secondTarget.id
              }
            });
          }
        }
        continue;
      }
      if (card.definitionId === "transfer") {
        const sources = RuleEngine.getTransferSources(this.game, player, card)
          .filter((from) => RuleEngine.getTransferReceivers(this.game, player, from, card).length);
        const selection = this.game.aiController.cardSelector.chooseTransferCombination(player, card, sources, null, new Set([card.id]));
        if (selection) actions.push({ type:"card", card, targets:[], selection });
        continue;
      }
      if (["singleEnemy", "singleEnemyInRange", "singleAlly", "otherWithCards", "otherWithCardsOrEquipment"].includes(card.targetType)) {
        const aiTargets = ["destroy","plunder"].includes(card.definitionId)
          ? targets.filter((target) => target.battleTeam !== player.battleTeam)
          : targets;
        for (const target of aiTargets) actions.push({ type:"card", card, targets:[target] });
      } else actions.push({ type:"card", card, targets:card.targetType === "allEnemies" || card.targetType === "allLiving" ? targets : [] });
    }
    const skill = getActiveSkill(player);
    if (skill?.canUse(this.game, player).ok
      && (skill.id !== "breakArmy" || this.canBenefitFromBreakArmy(player))) {
      const targets = RuleEngine.getSkillTargets(this.game, player, skill);
      if (skill.targetType === "none" || skill.targetType === "allEnemies") actions.push({ type:"skill", skill, targets });
      else for (const target of targets) actions.push({ type:"skill", skill, targets:[target] });
    }
    actions.push({ type:"end" });
    return actions;
  }

  /** 从过滤快照重新生成深层动作；动态距离只使用快照中的实时 aliveRing。 */
  generateFromVisible(state, playerId) {
    if (state.playPhaseEnded) return [];
    const actor = state.players.find((player) => player.id === playerId && player.alive);
    if (!actor) return [{ type:"end" }];
    const alive = state.players.filter((player) => player.alive).sort((a,b) => a.seatIndex - b.seatIndex);
    // 深层模拟仍走 RuleEngine → DistanceSystem；传入的是过滤快照，不是完整 GameState。
    const simulationGame = { state:{ players:state.players } };
    const enemies = alive.filter((player) => player.battleTeam !== actor.battleTeam);
    const actions = [];
    for (const held of actor.hand ?? []) {
      const definition = CARD_DEFINITIONS[held.definitionId];
      if (!definition || definition.usageMode === "response") continue;
      const card = { ...definition, ...held, id:held.id };
      if (card.definitionId === "assault") {
        for (const target of RuleEngine.getCardTargets(simulationGame, actor, card)) {
          actions.push({ type:"card", card, targets:[target] });
        }
        continue;
      }
      if (card.definitionId === "recover" && (actor.hp >= actor.maxHp || (actor.recoverLimit !== null && actor.recoverUsed >= actor.recoverLimit))) continue;
      if (card.definitionId === "charge" && actor.energy >= actor.maxEnergy) continue;
      if (card.definitionId === "transfer") {
        const selection = this.chooseVisibleTransferPlan(simulationGame, actor, card);
        if (selection) actions.push({ type:"card", card, targets:[], selection });
        continue;
      }
      if (card.definitionId === "leverage") {
        const firstTargets = alive.filter((firstTarget) => firstTarget.id !== actor.id
          && firstTarget.equipmentDefinitionId
          && (firstTarget.equipmentRetentionProbability ?? 1) > 0
          && RuleEngine.getAssaultTargetCandidates(simulationGame, firstTarget).length > 0);
        for (const firstTarget of firstTargets) {
          for (const secondTarget of RuleEngine.getAssaultTargetCandidates(simulationGame, firstTarget)) {
            actions.push({
              type:"card",
              card,
              targets:[firstTarget, secondTarget],
              selection:{
                firstTargetId:firstTarget.id,
                equipmentCardId:null,
                equipmentDefinitionId:firstTarget.equipmentDefinitionId,
                secondTargetId:secondTarget.id
              }
            });
          }
        }
        continue;
      }
      if (["singleEnemy"].includes(card.targetType)) for (const target of enemies) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "singleAlly") for (const target of RuleEngine.getCardTargets(simulationGame, actor, card)) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "otherWithCards") for (const target of alive.filter((entry) => entry.id !== actor.id && entry.handCount > 0)) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "otherWithCardsOrEquipment") {
        const targets = RuleEngine.getCardTargets(simulationGame, actor, card);
        for (const target of ["destroy","plunder"].includes(card.definitionId)
          ? targets.filter((entry) => entry.battleTeam !== actor.battleTeam)
          : targets) actions.push({ type:"card", card, targets:[target] });
      }
      else actions.push({ type:"card", card, targets:["allEnemies","allLiving"].includes(card.targetType) ? (card.targetType === "allEnemies" ? enemies : alive) : [] });
    }
    const skill = ACTIVE_SKILLS[actor.activeSkillId];
    if (skill
      && !(skill.id === "allIn" && (actor.assaultBonus ?? 0) >= 1 - PROBABILITY_EPSILON)
      && (skill.id !== "breakArmy" || this.canBenefitFromBreakArmy(actor))) {
      const friendlies = alive.filter((player) => player.battleTeam === actor.battleTeam);
      const allies = friendlies.filter((player) => player.id !== actor.id);
      let targets = [];
      if (["barrier","resonance"].includes(skill.id)) targets = allies;
      else if (skill.id === "symbiosis") targets = friendlies.filter((player) => player.hp < player.maxHp);
      else if (skill.id === "stealSkill") targets = RuleEngine.getSkillTargets(simulationGame, actor, skill);
      else if (skill.id === "hunt") targets = enemies.filter((player) => {
        const markBranches = player.huntMarkStateBranchesBySource?.[actor.id];
        if (Array.isArray(markBranches)) {
          return totalBranchProbability(markBranches.filter((branch) => branch.marked)) > PROBABILITY_EPSILON;
        }
        return Math.max(0, Math.min(1, Number(
          player.huntMarkProbabilities?.[actor.id] ?? (player.huntMarkSourceId === actor.id ? 1 : 0)
        ) || 0)) > 0;
      });
      if (["none","allEnemies"].includes(skill.targetType)) actions.push({ type:"skill", skill, targets:skill.targetType === "allEnemies" ? enemies : [] });
      else for (const target of targets) actions.push({ type:"skill", skill, targets:[target] });
    }
    actions.push({ type:"end" });
    return actions.map((action) => this.attachProbabilityBranches(simulationGame, actor, action))
      .filter(Boolean);
  }

  getActionConditionPartition(game, actor, action) {
    if (action.type === "skill") {
      if (action.skill.id === "hunt") {
        const target = action.targets?.[0];
        const markBranches = target?.huntMarkStateBranchesBySource?.[actor.id];
        if (Array.isArray(markBranches) && markBranches.length) {
          return markBranches.map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            matches:Boolean(branch.marked)
          }));
        }
        const markProbability = Math.max(0, Math.min(1, Number(
          target?.huntMarkProbabilities?.[actor.id] ?? (target?.huntMarkSourceId === actor.id ? 1 : 0)
        ) || 0));
        return binaryConditionPartition(huntMarkConditionKey(actor.id, target?.id), markProbability);
      }
      if (action.skill.rangeRule === "attack" || action.skill.rangeRule === "fixed") {
        const target = action.targets?.[0];
        return DistanceSystem.getRangeConditionBranches(game, {
          source:actor,
          target,
          range:action.skill.rangeRule === "attack" ? actor.attackRange : action.skill.range
        });
      }
      return [{ probability:1, conditions:{}, matches:true }];
    }

    const card = action.card;
    if (card.definitionId === "transfer") {
      const source = game.state.players.find((player) => player.id === action.selection?.sourceId);
      const receiver = game.state.players.find((player) => player.id === action.selection?.receiverId);
      return DistanceSystem.getRangeConditionBranches(game, [
        { source:actor, target:source, range:card.effectRange },
        { source:actor, target:receiver, range:card.effectRange }
      ]);
    }
    if (card.definitionId === "leverage") {
      const first = game.state.players.find((player) => player.id === action.selection?.firstTargetId);
      const second = game.state.players.find((player) => player.id === action.selection?.secondTargetId);
      return DistanceSystem.getRangeConditionBranches(game, {
        source:first,
        target:second,
        range:first?.attackRange ?? 1
      }, {
        equipmentRequirements:[{
          player:first,
          definitionId:action.selection?.equipmentDefinitionId,
          present:true
        }]
      });
    }
    const target = action.targets?.[0];
    if (card.definitionId === "assault" && target) {
      return DistanceSystem.getRangeConditionBranches(game, {
        source:actor,
        target,
        range:actor.attackRange ?? 1
      });
    }
    if (!card.ignoresDistance && card.effectRange != null && target) {
      return DistanceSystem.getRangeConditionBranches(game, {
        source:actor,
        target,
        range:card.effectRange
      });
    }
    return [{ probability:1, conditions:{}, matches:true }];
  }

  getAttackUseSlots(actor) {
    if (Array.isArray(actor.attackUseSlots)) return actor.attackUseSlots;
    const limit = Math.max(0, Math.ceil(Number(actor.attackLimit) || 0));
    const used = Math.max(0, Number(actor.attackUsed) || 0);
    return Array.from({ length:limit }, (_, index) => {
      if (index < Math.floor(used)) return [{ probability:1, conditions:{}, available:false }];
      if (index > Math.floor(used) || used === Math.floor(used)) {
        return [{ probability:1, conditions:{}, available:true }];
      }
      const unavailable = used - Math.floor(used);
      return [
        { probability:1 - unavailable, conditions:{}, available:true },
        { probability:unavailable, conditions:{ [`legacyAttackUse:${actor.id}:${index}`]:"used" }, available:false }
      ];
    });
  }

  getSkillUseSlots(actor, skill) {
    if (Array.isArray(actor.activeSkillUseSlots)) return actor.activeSkillUseSlots;
    if (Array.isArray(actor.activeSkillAvailabilityBranches)) {
      return actor.activeSkillAvailabilityBranches.map((availabilityBranches) => (
        getAvailabilityStateBranches({ availabilityBranches })
      ));
    }
    const uses = Math.max(0, Number(actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0)) || 0);
    const limit = Math.max(0, Math.ceil(Number(actor.activeSkillLimit ?? skill.limitPerTurn ?? 1) || 0));
    return Array.from({ length:limit }, (_, index) => [{
      probability:1,
      conditions:{},
      available:index >= Math.ceil(uses)
    }]);
  }

  buildExecutionWorlds(partitions, predicate) {
    return joinProbabilityStateBranches(...partitions).map((branch) => ({
      ...branch,
      executes:Boolean(predicate(branch))
    }));
  }

  summarizeExecution(worlds) {
    const executionBranches = mergeProbabilityBranches(worlds.filter((branch) => branch.executes));
    return { executionBranches, executionProbability:totalBranchProbability(executionBranches) };
  }

  /** 把条件、卡牌、次数槽和数量资源作为完整世界分区联合判断。 */
  attachProbabilityBranches(game, actor, action) {
    if (action.type === "end") return action;
    const conditionBranches = this.getActionConditionPartition(game, actor, action);
    if (action.type === "card") {
      const cardState = getAvailabilityStateBranches(action.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        cardAvailable:branch.available
      }));
      const basePartitions = [conditionBranches, cardState];
      const attackSlots = action.card.definitionId === "assault" ? this.getAttackUseSlots(actor) : [null];
      let bestResult = null;
      for (let attackUseSlot = 0; attackUseSlot < attackSlots.length; attackUseSlot += 1) {
        const attackState = attackSlots[attackUseSlot]?.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          attackSlotAvailable:branch.available
        }));
        const worlds = this.buildExecutionWorlds(
          attackState ? [...basePartitions, attackState] : basePartitions,
          (branch) => branch.matches && branch.cardAvailable && (attackState ? branch.attackSlotAvailable : true)
        );
        const summary = this.summarizeExecution(worlds);
        if (summary.executionProbability <= PROBABILITY_EPSILON) continue;
        const cardAvailabilityStateBranches = projectProbabilityStateBranches(worlds, (branch) => ({
          available:branch.cardAvailable && !branch.executes
        }));
        const result = {
          ...action,
          conditionBranches,
          executionWorldBranches:worlds,
          ...summary,
          remainingAvailabilityStateBranches:cardAvailabilityStateBranches,
          remainingAvailabilityBranches:availableBranchesFromState(cardAvailabilityStateBranches)
        };
        if (attackState) result.attackUseSlot = attackUseSlot;
        if (!bestResult || result.executionProbability > bestResult.executionProbability + PROBABILITY_EPSILON) {
          bestResult = result;
        }
      }
      return bestResult;
    }

    const slots = this.getSkillUseSlots(actor, action.skill);
    const energyState = getValueBranches(actor, "energy", actor.energy).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      energyAmount:branch.amount
    }));
    const minimumEnergy = action.skill.id === "allIn" ? 1 : Number(action.skill.cost) || 0;
    let bestResult = null;
    for (let skillUseSlot = 0; skillUseSlot < slots.length; skillUseSlot += 1) {
      const slotState = slots[skillUseSlot].map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        skillSlotAvailable:branch.available ?? true
      }));
      const worlds = this.buildExecutionWorlds(
        [conditionBranches, slotState, energyState],
        (branch) => branch.matches && branch.skillSlotAvailable && branch.energyAmount >= minimumEnergy
      );
      const summary = this.summarizeExecution(worlds);
      if (summary.executionProbability <= PROBABILITY_EPSILON) continue;
      const skillAvailabilityStateBranches = projectProbabilityStateBranches(worlds, (branch) => ({
        available:branch.skillSlotAvailable && !branch.executes
      }));
      const result = {
        ...action,
        conditionBranches,
        executionWorldBranches:worlds,
        ...summary,
        remainingSkillAvailabilityStateBranches:skillAvailabilityStateBranches,
        remainingSkillAvailabilityBranches:availableBranchesFromState(skillAvailabilityStateBranches),
        skillUseSlot,
      };
      if (!bestResult || result.executionProbability > bestResult.executionProbability + PROBABILITY_EPSILON) {
        bestResult = result;
      }
    }
    return bestResult;
  }
}
