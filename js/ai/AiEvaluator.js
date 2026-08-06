/**
 * AI 团队效用评估器。只读取公开或过滤后的字段并返回分数，不生成、执行动作，
 * 不写 GameState；权重修改会影响阵营平衡，之后必须重跑 200 局模拟。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260806-ai-allin-counter-v96";
import { ThreatCalculator } from "./ThreatCalculator.js?build=20260806-ai-allin-counter-v96";
import { assessGlobalBenefit } from "./AiGlobalBenefit.js?build=20260806-ai-allin-counter-v96";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260806-ai-allin-counter-v96";
import { getBaseCardAiValue, getRoleCardAiValue } from "./roleCardValue.js?build=20260806-ai-allin-counter-v96";

export class AiEvaluator {
  constructor(game) { this.game = game; }

  /** 角色对某张卡牌相对全局基础值的差量；缺少 generalId 或 definitionId 时回退 0。 */
  roleCardDelta(generalId, definitionId) {
    if (!generalId || !definitionId) return 0;
    return getRoleCardAiValue(generalId, definitionId) - getBaseCardAiValue(definitionId);
  }

  /** 具体手牌的剩余可用概率：优先读取 availabilityStateBranches，其次 availabilityBranches。 */
  cardAvailability(card) {
    const stateBranches = Array.isArray(card?.availabilityStateBranches)
      ? card.availabilityStateBranches
      : null;
    if (stateBranches) {
      return stateBranches
        .filter((branch) => branch.available)
        .reduce((sum, branch) => sum + (Number(branch.probability) || 0), 0);
    }
    if (Array.isArray(card?.availabilityBranches)) {
      return card.availabilityBranches.reduce((sum, branch) => sum + (Number(branch.probability) || 0), 0);
    }
    return 1;
  }

  breakArmyUtility(actor) {
    const assaultCount = (actor.hand ?? []).filter((card) => card.definitionId === "assault")
      .reduce((sum, card) => sum + (Array.isArray(card.availabilityBranches)
        ? card.availabilityBranches.reduce((total, branch) => total + (Number(branch.probability) || 0), 0)
        : 1), 0);
    const availableAttackUses = Array.isArray(actor.attackUseSlots)
      ? actor.attackUseSlots.reduce((sum, slot) => sum + (slot ?? []).reduce((total, branch) => (
          total + (branch.available ? Number(branch.probability) || 0 : 0)
        ), 0), 0)
      : Math.max(0, (Number(actor.attackLimit ?? actor.turnFlags?.attackLimit) || 0)
        - (Number(actor.attackUsed ?? actor.turnFlags?.attackUsed) || 0));
    return assaultCount > availableAttackUses + Number.EPSILON ? 8 : -4;
  }

  threatPriority(viewer, target, memory, expectedDamage = 1) {
    const multiplier = Math.max(0, Number(this.game.aiDifficultyMultiplier ?? GAME_CONFIG.aiDifficultyMultiplier) || 0);
    if (!multiplier || !target || target.battleTeam === viewer.battleTeam) return 0;
    return ThreatCalculator.calculate(viewer, target, memory, expectedDamage) * 0.12 * multiplier;
  }

  stateUtility(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) return -Infinity;
    let score = 0;
    for (const player of state.players) {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      if (!player.alive) {
        score += sign * -28;
        continue;
      }
      const danger = player.hp <= 1 ? -7 : 0;
      const rescueOutlook = player.survivalChance === undefined ? 0 : (player.survivalChance - 0.5) * 8;
      const equipmentValue = player.equipmentDefinitionId ? (CARD_DEFINITIONS[player.equipmentDefinitionId]?.aiValue ?? 7) : 0;
      const initialEquipmentValue = player.initialEquipmentValue ?? equipmentValue;
      const equipmentDelta = equipmentValue * (player.equipmentRetentionProbability ?? (equipmentValue ? 1 : 0))
        - initialEquipmentValue
        + (player.expectedEquipmentGain ?? 0);
      const currentEquipmentRoleDelta = player.equipmentDefinitionId
        ? this.roleCardDelta(player.generalId, player.equipmentDefinitionId)
        : 0;
      const initialEquipmentRoleDelta = Number.isFinite(player.initialEquipmentRoleDelta)
        ? player.initialEquipmentRoleDelta
        : currentEquipmentRoleDelta;
      const equipmentRoleDelta = currentEquipmentRoleDelta
          * (player.equipmentRetentionProbability ?? (currentEquipmentRoleDelta ? 1 : 0))
        - initialEquipmentRoleDelta
        + (player.expectedEquipmentRoleDelta ?? 0);
      const handRoleDelta = player.id === viewerId
        ? (player.hand ?? []).reduce((sum, card) => (
            sum + this.roleCardDelta(player.generalId, card?.definitionId) * this.cardAvailability(card)
          ), 0)
        : 0;
      const markThreat = Object.entries(player.huntMarkProbabilities ?? {}).reduce((sum, [sourceId, probability]) => {
        const source = state.players.find((entry) => entry.id === sourceId);
        return sum + (source?.battleTeam !== player.battleTeam ? Number(probability) || 0 : 0);
      }, 0);
      score += sign * (danger + rescueOutlook + player.hp * 5 + player.shield * 2 + player.energy * 1.2
        + player.handCount * 1.1 + handRoleDelta + (player.exposeWeaknessStacks ?? 0) * 1.5
        + equipmentDelta * .25 + equipmentRoleDelta * .25
        + (player.expectedInformationGain ?? 0) * .35 - markThreat * 1.5);
    }
    return score;
  }

  actionUtility(action, player, visible) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") {
      const remainingCards = actor.handCount ?? actor.hand?.length ?? player.hand.length;
      return remainingCards > 0 ? -0.8 : 0;
    }
    if (action.type === "skill") {
      const actionTarget = action.targets?.[0];
      const target = visible.players.find((entry) => entry.id === actionTarget?.id) ?? actionTarget;
      const enemies = visible.players.filter((entry) => entry.alive && entry.battleTeam !== actor.battleTeam);
      const missing = target ? Math.max(0, target.maxHp - target.hp) : 0;
      const values = {
        breakArmy: this.breakArmyUtility(actor),
        barrier: 4 + (target?.hp <= 2 ? 4 : 0),
        symbiosis: missing * 4,
        stealSkill: 5 + Math.min(4, (target?.handCount ?? 0) + (target?.equipmentDefinitionId ? 1 : 0)),
        burningField: enemies.reduce((sum, enemy) => sum + 2 + (enemy.hp <= 1 ? 8 : 0), 0),
        hunt: 7 + (target?.hp <= 2 ? 7 : 0),
        allIn: actor.energy * 3 + Math.min(1, actor.energy * .3) * (1 - (actor.assaultBonus ?? 0)) * 4,
        resonance: 5 + (target?.handCount <= 1 ? 3 : 0)
      };
      let value = values[action.skill.id] ?? 4;
      if (["stealSkill","hunt"].includes(action.skill.id)) value += this.threatPriority(actor, target, player.aiMemory, 1);
      return value;
    }
    const card = action.card;
    const roleDelta = this.roleCardDelta(actor?.generalId, card?.definitionId);
    let value = actor?.generalId && card?.definitionId
      ? getRoleCardAiValue(actor.generalId, card.definitionId)
      : (card.aiValue ?? 0);
    const actionTarget = action.targets?.[0];
    const target = visible.players.find((entry) => entry.id === actionTarget?.id) ?? actionTarget;
    if (target) {
      const enemy = target.battleTeam !== player.battleTeam;
      if (card.subtypes.includes("attack") || card.definitionId === "duel") {
        const focus = (target.maxHp - target.hp) * 3 + (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        value += enemy ? 3 + focus : -12;
      }
      if (["plunder","destroy","scout"].includes(card.definitionId)) {
        const equipmentValue = target.equipmentDefinitionId || target.equipment ? (card.definitionId === "plunder" ? 1 : 2) : 0;
        value += Math.min(5, (target.hand?.length ?? target.handCount ?? 0) + equipmentValue);
      }
      if (!enemy && ["plunder","destroy"].includes(card.definitionId)) value -= 30;
      if (!enemy && card.definitionId === "scout") value -= actor.activeSkillId === "resonance" ? 5 : 12;
      if (enemy && ["assault","duel","plunder","destroy","scout"].includes(card.definitionId)) {
        value += this.threatPriority(actor, target, player.aiMemory, ["assault","duel"].includes(card.definitionId) ? 1 : 0);
      }
    }
    if (card.definitionId === "recover") value += (actor.maxHp - actor.hp) * 4;
    if (card.definitionId === "charge") value += (actor.maxEnergy - actor.energy) * 1.5 + (actor.activeSkillId && !actor.activeSkillUsed && actor.energy + 1 >= actor.activeSkillCost ? 4 : 0);
    if (card.definitionId === "shield" && target) value += (target.hp <= 1 ? 6 : target.hp <= 2 ? 3 : 0) + Math.max(0, 2 - (target.shield ?? 0));
    if (card.definitionId === "exposeWeakness") value += (actor.hand ?? []).filter((entry) => entry.definitionId === "assault").length * 2;
    if (card.definitionId === "shockwave") value += visible.players.filter((enemy) => enemy.alive && enemy.battleTeam !== actor.battleTeam && enemy.hp <= 1).length * 7;
    if (card.definitionId === "provoke") value += visible.players.filter((enemy) => enemy.alive && enemy.battleTeam !== actor.battleTeam).reduce((sum, enemy) => sum + (1 - (enemy.assaultResponseProbability ?? 0)) * 3, 0);
    // 借势造成的伤害、手牌与装备变化已经由 AiSimulator 写入后继状态，统一交给 stateUtility 计分。
    if (card.definitionId === "duel" && target) value += ((actor.expectedAssaultCount ?? 0) - (target.expectedAssaultCount ?? 0)) * 2;
    if (card.definitionId === "transfer") value += Number(action.selection?.score ?? 0);
    if (card.definitionId === "symbiosis") {
      const net = this.symbiosisNetFromState(actor, visible);
      value = (net > 0 ? 8 + net : -9 + net) + roleDelta;
    }
    const equippedDefinitionId = actor.equipmentDefinitionId ?? actor.equipment?.definitionId ?? null;
    if (card.category === "equipment" && equippedDefinitionId === card.definitionId) value -= 4;
    return value;
  }

  symbiosisNet(player) {
    return this.symbiosisNetFromState(player, this.game.state);
  }

  symbiosisNetFromState(player, state) {
    return (assessGlobalBenefit(state.players, player.battleTeam, "symbiosis")?.netBenefit ?? 0) * 4;
  }
}
