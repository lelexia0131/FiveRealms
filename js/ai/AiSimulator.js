/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260801-transfer-hand-only-v37";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260801-transfer-hand-only-v37";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260801-transfer-hand-only-v37";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260801-transfer-hand-only-v37";

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
    if (abstractAction.type === "end") {
      next.playPhaseEnded = true;
      return next;
    }
    const actor = next.players.find((player) => player.id === viewerId);
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
        this.heal(actor, 1 * scale);
        actor.recoverUsed += 1;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - 1);
        break;
      case "charge": actor.energy = Math.min(actor.maxEnergy, actor.energy + 1); break;
      case "shield": if (target?.alive && target.battleTeam === actor.battleTeam) target.shield = (target.shield ?? 0) + 1; break;
      case "harvest": actor.handCount += 2 * scale; break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "assault":
        if (target) this.applyDamage(next, actor, target, 1 + (actor.exposeWeaknessStacks ?? 0) + (actor.assaultBonus ?? 0), { canBlock:true, deviceAttack:true });
        actor.exposeWeaknessStacks = 0;
        actor.assaultBonus = 0;
        actor.attackUsed += 1;
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
      case "symbiosis": for (const player of next.players) if (player.alive) this.heal(player, scale); break;
      default:
        if (card.category === "equipment") actor.equipmentDefinitionId = card.definitionId;
        break;
    }
    if (card.category === "tactic" && actor.equipmentDefinitionId === "recycleDevice" && (actor.recycleDeviceUses ?? 0) < 2) {
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + 1;
      actor.handCount += 1;
    }
    return next;
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
      this.heal(target, 1);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(actor, target);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) this.applyDamage(state, actor, enemy, 1, { canBlock:false });
    } else if (skill.id === "hunt" && target) {
      target.huntMarkSourceId = null;
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
    if (!target.alive || amount <= 0) return;
    const requiresTwoBlocks = attacker.equipmentDefinitionId === "battleDevice";
    const blockChance = options.canBlock ? (requiresTwoBlocks ? (target.twoBlockProbability ?? 0) : (target.blockProbability ?? 0)) : 0;
    let pending = amount * (1 - blockChance);
    let directLoss = 0;
    if (options.deviceAttack && target.equipmentDefinitionId === "defenseDevice") {
      const judgmentBlockChance = BLOCK_CARD_COUNT / TOTAL_CARD_COUNT;
      const otherBasicChance = OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT;
      const basicChance = BASIC_CARD_COUNT / TOTAL_CARD_COUNT;
      const equipmentChance = EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT;
      const passChance = !options.canBlock
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
    const absorbed = Math.min(target.shield ?? 0, pending);
    target.shield = Math.max(0, (target.shield ?? 0) - absorbed);
    target.hp -= Math.max(0, pending - absorbed) + directLoss;
    this.resolveFatal(state, target, attacker);
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
    const capacity = allies.reduce((sum, player) => sum + (player.expectedRecoverCount ?? 0), 0);
    target.survivalChance = Math.min(1, capacity / need);
    if (capacity < need) {
      target.alive = false;
      target.hp = 0;
      if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
        attacker.handCount = (attacker.handCount ?? 0) + GAME_CONFIG.killRewardDrawCount;
      }
      return;
    }
    let remaining = need;
    for (const rescuer of allies) {
      if (remaining <= 0) break;
      const spent = Math.min(remaining, rescuer.expectedRecoverCount ?? 0);
      rescuer.expectedRecoverCount = Math.max(0, (rescuer.expectedRecoverCount ?? 0) - spent);
      rescuer.handCount = Math.max(0, rescuer.handCount - spent);
      if (rescuer.hand) {
        let remove = Math.ceil(spent);
        rescuer.hand = rescuer.hand.filter((card) => card.definitionId !== "recover" || remove-- <= 0);
      }
      remaining -= spent;
    }
    target.hp = 1;
    target.survivalChance = 1;
    target.alive = true;
  }

  heal(target, amount) {
    if (target.alive && amount > 0) target.hp = Math.min(target.maxHp, target.hp + amount);
  }
}
