/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260802-probability-branches-v56";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260802-probability-branches-v56";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260802-probability-branches-v56";
import { getAvailabilityBranches, totalBranchProbability } from "./AiProbabilityBranches.js?build=20260802-probability-branches-v56";

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
      const executionProbability = clampProbability(abstractAction.executionProbability ?? 1);
      if (executionProbability <= 0) return next;
      const skillUses = actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0);
      const skillLimit = actor.activeSkillLimit ?? abstractAction.skill?.limitPerTurn ?? 1;
      actor.activeSkillAvailabilityBranches ??= Array.from(
        { length:Math.max(0, Math.ceil(skillLimit - skillUses)) },
        () => [{ probability:1, conditions:{} }]
      );
      if (abstractAction.skillUseSlot != null && actor.activeSkillAvailabilityBranches[abstractAction.skillUseSlot]) {
        actor.activeSkillAvailabilityBranches[abstractAction.skillUseSlot]
          = structuredClone(abstractAction.remainingSkillAvailabilityBranches ?? []);
      }
      this.applySkill(next, actor, abstractAction, executionProbability);
      return next;
    }
    const card = abstractAction.card;
    if (!card) return next;
    const target = next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
    const heldCard = (actor.hand ?? []).find((entry) => entry.id === card.id) ?? null;
    const availabilityBranches = getAvailabilityBranches(heldCard ?? card);
    const cardProbability = totalBranchProbability(availabilityBranches);
    const executionProbability = Math.max(0, Math.min(cardProbability,
      Number(abstractAction.executionProbability ?? cardProbability) || 0));
    if (heldCard) {
      const remainingBranches = abstractAction.remainingAvailabilityBranches
        ? structuredClone(abstractAction.remainingAvailabilityBranches)
        : (cardProbability - executionProbability > Number.EPSILON
          ? [{ probability:cardProbability - executionProbability, conditions:{} }]
          : []);
      heldCard.availabilityBranches = remainingBranches;
      const remainingProbability = totalBranchProbability(remainingBranches);
      actor.hand = remainingProbability > 0 ? actor.hand : actor.hand.filter((entry) => entry.id !== card.id);
    }
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability);
    if (executionProbability <= 0) return next;
    const scale = executionProbability * (card.counterScope === "target"
      ? 1
      : this.tacticResolutionChance(next, actor, card, abstractAction.targets ?? []));

    switch (card.definitionId) {
      case "recover":
        this.healFrom(actor, actor, 1 * scale);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - executionProbability);
        break;
      case "charge": actor.energy = Math.min(actor.maxEnergy, actor.energy + scale); break;
      case "shield": if (target?.alive && target.battleTeam === actor.battleTeam) target.shield = (target.shield ?? 0) + scale; break;
      case "harvest": actor.handCount += 2 * scale; break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "assault":
        if (target) this.simulateAssault(next, actor, target, executionProbability);
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetScale = scale * this.targetResolutionChance(next, actor, card, player);
          this.applyDamage(next, actor, player, 1, { canBlock:true, deviceAttack:true, eventProbability:targetScale });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetScale = this.targetResolutionChance(next, actor, card, player);
          const response = player.assaultResponseProbability ?? 0;
          const eventProbability = scale * targetScale;
          player.handCount = Math.max(0, player.handCount - response * eventProbability);
          player.expectedAssaultCount = Math.max(0, (player.expectedAssaultCount ?? 0) - response * eventProbability);
          this.applyDamage(next, actor, player, 1, {
            canBlock:false,
            deviceAttack:false,
            eventProbability:(1 - response) * eventProbability
          });
        }
        break;
      case "leverage": {
        const first = next.players.find((player) => player.id === abstractAction.selection?.firstTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
        const second = next.players.find((player) => player.id === abstractAction.selection?.secondTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[1]?.id);
        if (!first?.alive || !second?.alive || !first.equipmentDefinitionId) break;
        // 候选组合从不因手牌估计或次数删除；这些因素只影响实际使用的连续概率。
        const usageAvailable = Number(first.attackUsed ?? 0) < Number(first.attackLimit ?? 0) ? 1 : 0;
        const assaultAvailable = Math.max(0, Math.min(1, first.assaultResponseProbability ?? 0)) * usageAvailable;
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
        const effectiveUseProbability = scale * assaultAvailable * willingness;
        const effectiveDeclineProbability = Math.min(existenceProbability, Math.max(0, scale - effectiveUseProbability));
        first.handCount = Math.max(0, first.handCount - effectiveUseProbability);
        first.expectedAssaultCount = Math.max(0, (first.expectedAssaultCount ?? 0) - effectiveUseProbability);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, effectiveUseProbability, { sourceEquipmentConditional:true });
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
  simulateTracking(source, target, chance) {
    if (source.generalId !== "trail-hunter" || target.battleTeam === source.battleTeam) return;
    source.trackingTargetIds ??= [];
    // 同一敌人本回合只能触发一次；猎杀移除标记也不会返还该次追踪额度。
    if (source.trackingTargetIds.includes(target.id)) return;
    source.trackingUses ??= source.trackingTargetIds.length;
    target.huntMarkProbabilities ??= {};
    const oldProbability = clampProbability(target.huntMarkProbabilities[source.id]
      ?? (target.huntMarkSourceId === source.id ? 1 : 0));
    const mergedProbability = unionProbability(oldProbability, chance);
    const remainingUses = Math.max(0, 2 - source.trackingUses);
    const gainedProbability = Math.min(remainingUses, Math.max(0, mergedProbability - oldProbability));
    const markProbability = oldProbability + gainedProbability;
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
  simulateAssaultAfterDamage(source, target, lifeDamageProbability) {
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
      const room = Math.max(0, (source.maxEnergy ?? source.energy ?? 0) - (source.energy ?? 0));
      source.energy = (source.energy ?? 0) + Math.min(room, chance);
    }
  }

  /** 普通突袭与借势响应共用的期望结算入口；概率仅缩放是否真正打出，防御和伤害仍走统一模拟。 */
  simulateAssault(state, source, target, resolutionChance = 1, options = {}) {
    const chance = clampProbability(resolutionChance);
    if (!chance || !source?.alive || !target?.alive) return 0;
    this.simulateTracking(source, target, chance);
    const momentum = source.generalId === "blade-walker" ? (source.momentum ?? 0) : 0;
    const damageOutcome = {};
    const damage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0) + momentum;
    const expectedDamageAfterGuardianAid = this.simulateGuardianAid(state, target, damage * chance, chance);
    const conditionalDamageAfterGuardianAid = expectedDamageAfterGuardianAid / chance;
    this.applyDamage(state, source, target, conditionalDamageAfterGuardianAid, {
      canBlock:true,
      deviceAttack:true,
      eventProbability:chance,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    source.attackUsed = (source.attackUsed ?? 0) + chance;
    this.simulateCategoryUse(source, "basic", chance, lifeDamageChance);
    this.simulateAssaultAfterDamage(source, target, lifeDamageChance);
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

  applySkill(state, actor, action, executionProbability = 1) {
    const skill = action.skill;
    const target = state.players.find((player) => player.id === action.targets?.[0]?.id);
    const chance = clampProbability(executionProbability);
    const skillUses = actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0);
    const skillLimit = actor.activeSkillLimit ?? skill.limitPerTurn ?? 1;
    if (!skill || chance <= 0 || skillUses >= skillLimit) return;
    actor.activeSkillUses = Math.min(skillLimit, skillUses + chance);
    actor.activeSkillUsed = actor.activeSkillUses >= skillLimit - Number.EPSILON;
    if (skill.id === "allIn") {
      const energy = actor.energy;
      actor.energy = Math.max(0, actor.energy - energy * chance);
      actor.handCount += energy * chance;
      actor.assaultBonus = (actor.assaultBonus ?? 0) + Math.min(1, energy * .3) * chance;
      return;
    }
    actor.energy = Math.max(0, actor.energy - skill.cost * chance);
    if (skill.id === "breakArmy") actor.attackLimit += chance;
    else if (skill.id === "barrier" && target) {
      target.shield = (target.shield ?? 0) + chance;
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(actor, target, chance);
      if (target.id !== actor.id) this.healFrom(actor, actor, chance);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, 1, { canBlock:false, eventProbability:chance });
      }
    } else if (skill.id === "hunt" && target) {
      target.huntMarkProbabilities ??= {};
      const oldMarkProbability = clampProbability(target.huntMarkProbabilities[actor.id]
        ?? (target.huntMarkSourceId === actor.id ? 1 : 0));
      const consumedMarkProbability = Math.min(oldMarkProbability, chance);
      target.huntMarkProbabilities[actor.id] = Math.max(0, oldMarkProbability - consumedMarkProbability);
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
        eventProbability:consumedMarkProbability,
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
    const eventProbability = clampProbability(options.eventProbability ?? 1);
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
    const pending = amount * eventProbability * passChance;
    if (options.outcome) {
      options.outcome.lifeDamageChance = (target.shield ?? 0) < amount
        ? eventProbability * passChance
        : 0;
      options.outcome.blockedByCardChance = eventProbability * blockedByCardChance;
    }
    const absorbed = Math.min(target.shield ?? 0, pending);
    target.shield = Math.max(0, (target.shield ?? 0) - absorbed);
    const actualDamage = Math.max(0, pending - absorbed);
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
