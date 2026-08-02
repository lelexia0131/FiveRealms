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
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability);
    if (executionProbability <= 0) return next;
    const effectEventWorlds = card.counterScope === "target"
      ? cardEventWorlds
      : this.gateEventWorlds(next, cardEventWorlds,
        this.tacticResolutionChance(next, actor, card, abstractAction.targets ?? []),
        `counter:${card.id ?? card.definitionId}`);
    const scale = this.eventProbability(effectEventWorlds);

    switch (card.definitionId) {
      case "recover":
        this.healFrom(actor, actor, 1 * scale);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - executionProbability);
        break;
      case "charge": this.changeEnergy(next, actor, 1, effectEventWorlds); break;
      case "shield": if (target?.alive && target.battleTeam === actor.battleTeam) this.changeShield(next, target, 1, effectEventWorlds); break;
      case "harvest": actor.handCount += 2 * scale; break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          attackUseSlot:abstractAction.attackUseSlot
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetWorlds = this.gateEventWorlds(next, effectEventWorlds,
            this.targetResolutionChance(next, actor, card, player), `target-counter:${card.id}:${player.id}`);
          this.applyDamage(next, actor, player, 1, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:targetWorlds
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
          player.handCount = Math.max(0, player.handCount - response * eventProbability);
          player.expectedAssaultCount = Math.max(0, (player.expectedAssaultCount ?? 0) - response * eventProbability);
          this.applyDamage(next, actor, player, 1, {
            canBlock:false,
            deviceAttack:false,
            eventBranches:this.gateEventWorlds(next, targetWorlds,
              1 - response, `provoke-response:${card.id}:${player.id}`)
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
        const existenceProbability = this.getSimulatedEquipmentProbability(first);
        const desiredUseWorlds = this.gateEventWorlds(next, effectEventWorlds,
          assaultAvailable * willingness, `leverage-assault:${card.id}:${first.id}`);
        const consumedAttack = this.consumeAttackUse(next, first, desiredUseWorlds);
        const actualUseWorlds = consumedAttack.eventWorlds;
        const effectiveUseProbability = this.eventProbability(actualUseWorlds);
        const effectiveDeclineProbability = Math.min(existenceProbability, Math.max(0, scale - effectiveUseProbability));
        first.handCount = Math.max(0, first.handCount - effectiveUseProbability);
        first.expectedAssaultCount = Math.max(0, (first.expectedAssaultCount ?? 0) - effectiveUseProbability);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, actualUseWorlds, {
          sourceEquipmentConditional:true,
          attackUseConsumed:true
        });
        actor.handCount += effectiveDeclineProbability;
        actor.expectedEquipmentGain = (actor.expectedEquipmentGain ?? 0) + equipmentValue * effectiveDeclineProbability;
        this.setSimulatedEquipment(first, first.equipmentDefinitionId, existenceProbability - effectiveDeclineProbability);
        break;
      }
      case "plunder":
        if (target) this.takeResourceToHand(actor, target, scale);
        break;
      case "transfer": {
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? null;
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? null;
        if (source && receiver && (source.handCount ?? 0) > 0 && abstractAction.selection?.zone !== "equipment") {
          source.handCount = Math.max(0, source.handCount - scale);
          receiver.handCount += scale;
        }
        break;
      }
      case "destroy": if (target) this.destroyResource(target, scale); break;
      case "duel": if (target) this.applyDuel(next, actor, target, scale); break;
      case "mutualBenefit": for (const player of next.players) if (player.alive) player.handCount += scale; break;
      case "symbiosis": for (const player of next.players) if (player.alive) this.healFrom(actor, player, scale); break;
      default:
        if (card.category === "equipment") this.setSimulatedEquipment(actor, card.definitionId, executionProbability);
        break;
    }
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
    if (source.generalId === "shade-agent" && target.alive && target.hp > 0
      && target.battleTeam !== source.battleTeam && (target.handCount ?? 0) > 0) {
      const oldTriggeredProbability = clampProbability(source.spyGapTriggeredProbability
        ?? (source.spyGapTriggered ? 1 : 0));
      const triggerProbability = (1 - oldTriggeredProbability) * chance;
      source.spyGapTriggeredProbability = unionProbability(oldTriggeredProbability, chance);
      source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
      source.expectedInformationGain = (source.expectedInformationGain ?? 0)
        + Math.min(2, target.handCount) * triggerProbability;
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
    const momentum = source.generalId === "blade-walker" ? (source.momentum ?? 0) : 0;
    const damageOutcome = {};
    const damage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0) + momentum;
    const expectedDamageAfterGuardianAid = this.simulateGuardianAid(state, target, damage * chance, chance);
    const conditionalDamageAfterGuardianAid = expectedDamageAfterGuardianAid / chance;
    this.applyDamage(state, source, target, conditionalDamageAfterGuardianAid, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:assaultWorlds,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    this.simulateCategoryUse(source, "basic", chance, lifeDamageChance);
    this.simulateAssaultAfterDamage(state, source, target, lifeDamageChance, damageOutcome.lifeDamageBranches);
    return lifeDamageChance;
  }

  takeResourceToHand(actor, target, scale = 1) {
    const takeEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (takeEquipment) {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const transferProbability = existenceProbability * Math.max(0, Math.min(1, scale));
      this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - transferProbability);
      actor.handCount += transferProbability;
    } else {
      target.handCount = Math.max(0, (target.handCount ?? 0) - scale);
      actor.handCount += scale;
    }
  }

  destroyResource(target, scale = 1) {
    const destroyEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (destroyEquipment) {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      this.setSimulatedEquipment(target, target.equipmentDefinitionId,
        existenceProbability * (1 - Math.max(0, Math.min(1, scale))));
    } else target.handCount = Math.max(0, (target.handCount ?? 0) - scale);
  }

  tacticResolutionChance(state, actor, card, targets = []) {
    if (card.category !== "tactic" || card.counterable === false) return 1;
    return state.players.filter((player) => player.alive && player.id !== actor.id)
      .reduce((chance, player) => chance * (1 - (player.counterProbability ?? 0) * this.counterDesire(state, player, actor, card, targets)), 1);
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
      actor.handCount += joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * branch.energyAmount : 0)
      ), 0);
      actor.assaultBonus = (actor.assaultBonus ?? 0) + joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * Math.min(1, branch.energyAmount * .3) : 0)
      ), 0);
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
      this.stealResourceToHand(actor, target, chance);
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
  stealResourceToHand(actor, target, scale = 1) {
    const chance = clampProbability(scale);
    const handCount = Math.max(0, target.handCount ?? 0);
    const existenceProbability = this.getSimulatedEquipmentProbability(target);
    if ((!handCount && !existenceProbability) || chance <= 0) return;
    const equipmentLossProbability = existenceProbability / (handCount + 1) * chance;
    const handLoss = handCount > 0 ? (1 - existenceProbability / (handCount + 1)) * chance : 0;
    const gainProbability = (handCount > 0 ? 1 : existenceProbability) * chance;
    actor.handCount = (actor.handCount ?? 0) + gainProbability;
    target.handCount = Math.max(0, handCount - handLoss);
    this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - equipmentLossProbability);
  }

  applyDuel(state, actor, target, scale) {
    const actorAssaults = actor.expectedAssaultCount ?? (actor.hand ?? []).filter((card) => card.definitionId === "assault").length;
    const targetAssaults = target.expectedAssaultCount ?? 0;
    const loser = targetAssaults <= actorAssaults ? target : actor;
    const spent = Math.min(actorAssaults, targetAssaults + (loser.id === actor.id ? 0 : 1));
    actor.handCount = Math.max(0, actor.handCount - spent * scale);
    target.handCount = Math.max(0, target.handCount - Math.min(targetAssaults, actorAssaults + (loser.id === target.id ? 0 : 1)) * scale);
    this.applyDamage(state, loser.id === target.id ? actor : target, loser, 1, {
      canBlock:false,
      eventProbability:scale
    });
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
    const battleProbability = clampProbability(attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    const normalBlockChance = clampProbability(target.blockProbability ?? 0);
    const twoBlockChance = clampProbability(target.twoBlockProbability ?? 0);
    const blockChance = options.canBlock
      ? battleProbability * twoBlockChance + (1 - battleProbability) * normalBlockChance
      : 0;
    let passChance = 1 - blockChance;
    const defenseProbability = options.deviceAttack
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = blockChance;
    let expectedBlockSpend = options.canBlock
      ? battleProbability * twoBlockChance * 2 + (1 - battleProbability) * normalBlockChance
      : 0;
    let expectedJudgmentGain = 0;
    if (defenseProbability > 0) {
      const judgmentProbabilities = options.radarJudgmentProbabilities ?? {};
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
    }
    target.handCount = Math.max(0, (target.handCount ?? 0)
      + eventProbability * expectedJudgmentGain
      - eventProbability * expectedBlockSpend);
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
    if (options.outcome) {
      options.outcome.lifeDamageBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
        occurs:hpDamageFor(branch) > PROBABILITY_EPSILON
      }));
      options.outcome.lifeDamageChance = this.eventProbability(options.outcome.lifeDamageBranches);
      options.outcome.blockedByCardChance = eventProbability * blockedByCardChance;
    }
    target.hp -= actualDamage;
    this.resolveFatal(state, target, attacker);
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
    const allies = state.players.filter((player) => player.alive && player.battleTeam === target.battleTeam)
      .sort((a,b) => (a.id === target.id ? -1 : b.id === target.id ? 1 : a.seatIndex - b.seatIndex));
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
      if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
        attacker.handCount = (attacker.handCount ?? 0) + GAME_CONFIG.killRewardDrawCount;
      }
      return;
    }
    let remaining = need;
    let healingApplied = 0;
    for (const rescuer of allies) {
      if (remaining <= 0) break;
      let available = rescuer.expectedRecoverCount ?? 0;
      let spent = 0;
      if (available > 0 && rejuvenationBonus(rescuer) > 0) {
        const firstCard = Math.min(1, available);
        const firstHealing = firstCard * 2;
        spent += firstCard;
        available -= firstCard;
        remaining -= firstHealing;
        healingApplied += firstHealing;
        rescuer.rejuvenationUsed = true;
        rescuer.handCount = (rescuer.handCount ?? 0) + firstCard;
      }
      const regularSpent = Math.min(Math.max(0, remaining), available);
      spent += regularSpent;
      remaining -= regularSpent;
      healingApplied += regularSpent;
      rescuer.expectedRecoverCount = Math.max(0, (rescuer.expectedRecoverCount ?? 0) - spent);
      rescuer.handCount = Math.max(0, rescuer.handCount - spent);
      if (rescuer.hand) {
        let remove = Math.ceil(spent);
        rescuer.hand = rescuer.hand.filter((card) => card.definitionId !== "recover" || remove-- <= 0);
      }
    }
    target.hp = Math.min(target.maxHp, target.hp + healingApplied);
    target.survivalChance = 1;
    target.alive = true;
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
