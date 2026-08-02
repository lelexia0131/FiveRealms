/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260801-hunter-tracking-v53";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260801-hunter-tracking-v53";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260801-hunter-tracking-v53";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260801-hunter-tracking-v53";

const BASIC_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0);
const EQUIPMENT_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment").reduce((sum, card) => sum + card.count, 0);
const BLOCK_CARD_COUNT = CARD_DEFINITIONS.block.count;
const OTHER_BASIC_CARD_COUNT = BASIC_CARD_COUNT - BLOCK_CARD_COUNT;

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
      this.applySkill(next, actor, abstractAction);
      return next;
    }
    const card = abstractAction.card;
    if (!card) return next;
    const target = next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
    actor.hand = (actor.hand ?? []).filter((entry) => entry.id !== card.id);
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - 1);
    const scale = card.counterScope === "target" ? 1 : this.tacticResolutionChance(next, actor, card, abstractAction.targets ?? []);

    switch (card.definitionId) {
      case "recover":
        this.healFrom(actor, actor, 1 * scale);
        actor.recoverUsed += 1;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - 1);
        break;
      case "charge": actor.energy = Math.min(actor.maxEnergy, actor.energy + 1); break;
      case "shield": if (target?.alive && target.battleTeam === actor.battleTeam) target.shield = (target.shield ?? 0) + 1; break;
      case "harvest": actor.handCount += 2 * scale; break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "assault":
        if (target) this.simulateAssault(next, actor, target, 1);
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetScale = this.targetResolutionChance(next, actor, card, player);
          this.applyDamage(next, actor, player, targetScale, { canBlock:true, deviceAttack:true });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetScale = this.targetResolutionChance(next, actor, card, player);
          const response = player.assaultResponseProbability ?? 0;
          player.handCount = Math.max(0, player.handCount - response * targetScale);
          player.expectedAssaultCount = Math.max(0, (player.expectedAssaultCount ?? 0) - response * targetScale);
          this.applyDamage(next, actor, player, (1 - response) * targetScale, { canBlock:false, deviceAttack:false });
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
        const useProbability = scale * assaultAvailable * willingness;
        first.handCount = Math.max(0, first.handCount - useProbability);
        first.expectedAssaultCount = Math.max(0, (first.expectedAssaultCount ?? 0) - useProbability);
        this.simulateAssault(next, first, second, useProbability);
        const declineProbability = Math.max(0, scale - useProbability);
        actor.handCount += declineProbability;
        actor.expectedEquipmentGain = (actor.expectedEquipmentGain ?? 0) + equipmentValue * declineProbability;
        const priorRetention = first.equipmentRetentionProbability ?? 1;
        first.equipmentRetentionProbability = Math.max(0, priorRetention * (1 - declineProbability));
        break;
      }
      case "plunder":
        if (target) this.takeResourceToHand(actor, target, scale);
        break;
      case "transfer": {
        const game = { state:{ players:next.players } };
        const inRange = (player) => DistanceSystem.getDistance(game, actor, player) <= 1;
        const resources = next.players.filter((player) => player.alive && inRange(player) && (player.handCount ?? 0) > 0);
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? resources.sort((a,b) => b.handCount - a.handCount)[0];
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? next.players.filter((player) => player.alive && player.id !== source?.id && inRange(player)).sort((a,b) => a.handCount - b.handCount)[0];
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
        if (card.category === "equipment") actor.equipmentDefinitionId = card.definitionId;
        break;
    }
    if (card.category === "tactic" && actor.equipmentDefinitionId === "recycleDevice" && (actor.recycleDeviceUses ?? 0) < 2) {
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + 1;
      actor.handCount += 1;
    }
    if (actor.generalId === "blade-walker" && actor.alive) {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      actor.categoriesUsed ??= [];
      const gainsMomentum = category && !actor.categoriesUsed.includes(category) ? 1 : 0;
      if (gainsMomentum) actor.categoriesUsed.push(category);
      if (gainsMomentum) {
        actor.momentum = Math.min(GAME_CONFIG.momentumMaxStacks, (actor.momentum ?? 0) + gainsMomentum);
      }
    }
    return next;
  }

  /** 普通突袭与借势响应共用的期望结算入口；概率仅缩放是否真正打出，防御和伤害仍走统一模拟。 */
  simulateAssault(state, source, target, resolutionChance = 1) {
    const chance = Math.max(0, Math.min(1, resolutionChance));
    if (!chance || !source?.alive || !target?.alive) return 0;
    if (source.generalId === "trail-hunter" && target.battleTeam !== source.battleTeam) {
      source.trackingTargetIds ??= [];
      target.huntMarkProbability = Math.min(1, (target.huntMarkProbability ?? 0) + chance);
      if (chance === 1 && source.trackingTargetIds.length < 2 && !source.trackingTargetIds.includes(target.id)) {
        source.trackingTargetIds.push(target.id);
        target.huntMarkSourceId = source.id;
        if (Array.isArray(target.statuses) && !target.statuses.includes("huntMark")) target.statuses.push("huntMark");
      }
    }
    const momentum = source.generalId === "blade-walker" ? (source.momentum ?? 0) : 0;
    const damageOutcome = {};
    const damage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0) + momentum;
    this.applyDamage(state, source, target, damage * chance, { canBlock:true, deviceAttack:true, outcome:damageOutcome });
    const lifeDamageChance = chance * (damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    source.attackUsed = (source.attackUsed ?? 0) + chance;
    if (source.generalId === "blade-walker") {
      source.categoriesUsed ??= [];
      const gainsMomentum = source.categoriesUsed.includes("basic") ? 0 : chance;
      if (chance === 1 && !source.categoriesUsed.includes("basic")) source.categoriesUsed.push("basic");
      const hitMomentum = Math.min(GAME_CONFIG.momentumMaxStacks, gainsMomentum);
      const missMomentum = Math.min(GAME_CONFIG.momentumMaxStacks, (source.momentum ?? 0) + gainsMomentum);
      source.momentum = hitMomentum * lifeDamageChance + missMomentum * (1 - lifeDamageChance);
    }
    return lifeDamageChance;
  }

  takeResourceToHand(actor, target, scale = 1) {
    const takeEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (takeEquipment && scale >= .5) {
      target.equipmentDefinitionId = null;
      actor.handCount += scale;
    } else {
      target.handCount = Math.max(0, (target.handCount ?? 0) - scale);
      actor.handCount += scale;
    }
  }

  destroyResource(target, scale = 1) {
    const destroyEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (destroyEquipment && scale >= .5) target.equipmentDefinitionId = null;
    else target.handCount = Math.max(0, (target.handCount ?? 0) - scale);
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

  applySkill(state, actor, action) {
    const skill = action.skill;
    const target = state.players.find((player) => player.id === action.targets?.[0]?.id);
    const skillUses = actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0);
    const skillLimit = actor.activeSkillLimit ?? skill.limitPerTurn ?? 1;
    if (!skill || skillUses >= skillLimit) return;
    actor.activeSkillUses = skillUses + 1;
    actor.activeSkillUsed = actor.activeSkillUses >= skillLimit;
    if (skill.id === "allIn") {
      const energy = actor.energy;
      actor.energy = 0;
      actor.handCount += energy;
      actor.assaultBonus = Math.min(1, energy * .3);
      return;
    }
    actor.energy = Math.max(0, actor.energy - skill.cost);
    if (skill.id === "breakArmy") actor.attackLimit += 1;
    else if (skill.id === "barrier" && target) {
      target.shield = (target.shield ?? 0) + 1;
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(actor, target, 1);
      if (target.id !== actor.id) this.healFrom(actor, actor, 1);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(actor, target);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) this.applyDamage(state, actor, enemy, 1, { canBlock:false });
    } else if (skill.id === "hunt" && target) {
      target.huntMarkSourceId = null;
      if (Array.isArray(target.statuses)) target.statuses = target.statuses.filter((status) => status !== "huntMark");
      actor.handCount += target.blockProbability ?? 0;
      this.applyDamage(state, actor, target, 2, { canBlock:true });
    } else if (skill.id === "resonance" && target) target.handCount += 2;
  }

  /** 窃取所得资源只增加手牌；目标仅有装备时，模拟中明确移除装备且不替换施术者装备。 */
  stealResourceToHand(actor, target) {
    const handCount = Math.max(0, target.handCount ?? 0);
    const hasEquipment = Boolean(target.equipmentDefinitionId);
    const candidateCount = handCount + (hasEquipment ? 1 : 0);
    if (!candidateCount) return;
    actor.handCount = (actor.handCount ?? 0) + 1;
    if (!handCount && hasEquipment) {
      target.equipmentDefinitionId = null;
      return;
    }
    // 混合候选用期望手牌损失表示；装备不会被错误赋给施术者或立即提供装备效果。
    target.handCount = Math.max(0, handCount - handCount / candidateCount);
  }

  applyDuel(state, actor, target, scale) {
    const actorAssaults = actor.expectedAssaultCount ?? (actor.hand ?? []).filter((card) => card.definitionId === "assault").length;
    const targetAssaults = target.expectedAssaultCount ?? 0;
    const loser = targetAssaults <= actorAssaults ? target : actor;
    const spent = Math.min(actorAssaults, targetAssaults + (loser.id === actor.id ? 0 : 1));
    actor.handCount = Math.max(0, actor.handCount - spent * scale);
    target.handCount = Math.max(0, target.handCount - Math.min(targetAssaults, actorAssaults + (loser.id === target.id ? 0 : 1)) * scale);
    this.applyDamage(state, loser.id === target.id ? actor : target, loser, scale, { canBlock:false });
  }

  applyDamage(state, attacker, target, amount, options = {}) {
    if (!target.alive || amount <= 0) {
      if (options.outcome) options.outcome.lifeDamageChance = 0;
      return 0;
    }
    const requiresTwoBlocks = attacker.equipmentDefinitionId === "battleDevice";
    const blockChance = options.canBlock ? (requiresTwoBlocks ? (target.twoBlockProbability ?? 0) : (target.blockProbability ?? 0)) : 0;
    let passChance = 1 - blockChance;
    let pending = amount * passChance;
    let directLoss = 0;
    if (options.deviceAttack && target.equipmentDefinitionId === "defenseDevice") {
      const judgmentBlockChance = BLOCK_CARD_COUNT / TOTAL_CARD_COUNT;
      const otherBasicChance = OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT;
      const basicChance = BASIC_CARD_COUNT / TOTAL_CARD_COUNT;
      const equipmentChance = EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT;
      passChance = !options.canBlock
        ? basicChance + equipmentChance
        : requiresTwoBlocks
          ? equipmentChance + judgmentBlockChance * (1 - (target.blockProbability ?? 0)) + otherBasicChance * (1 - (target.twoBlockProbability ?? 0))
          : equipmentChance + otherBasicChance * (1 - (target.blockProbability ?? 0));
      const responseChance = options.canBlock ? Math.max(0, basicChance - passChance) : 0;
      target.handCount += basicChance;
      target.handCount = Math.max(0, target.handCount - responseChance * (requiresTwoBlocks ? 2 : 1));
      pending = amount * passChance;
    } else {
      target.handCount = Math.max(0, target.handCount - blockChance * (requiresTwoBlocks ? 2 : 1));
    }
    if (options.outcome) options.outcome.lifeDamageChance = (target.shield ?? 0) < amount ? passChance : 0;
    const absorbed = Math.min(target.shield ?? 0, pending);
    target.shield = Math.max(0, (target.shield ?? 0) - absorbed);
    const actualDamage = Math.max(0, pending - absorbed) + directLoss;
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
