/**
 * AI 团队效用评估器。只读取公开或过滤后的字段并返回分数，不生成、执行动作，
 * 不写 GameState；权重修改会影响阵营平衡，之后必须重跑 200 局模拟。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260810-global-turn-reactive-v150";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260810-global-turn-reactive-v150";
import { buildRadarJudgmentProbabilities } from "./AiProbabilityBranches.js?build=20260810-global-turn-reactive-v150";
import { ThreatCalculator } from "./ThreatCalculator.js?build=20260810-global-turn-reactive-v150";
import { assessGlobalBenefit } from "./AiGlobalBenefit.js?build=20260810-global-turn-reactive-v150";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260810-global-turn-reactive-v150";
import { getBaseCardAiValue, getRoleCardAiValue } from "./roleCardValue.js?build=20260810-global-turn-reactive-v150";
import { lightningTeamBurden, lightningUseValue } from "./lightningScoring.js?build=20260810-global-turn-reactive-v150";
import {
  sealEarlyUsePenalty, sealTeamBurden, sealUseValue
} from "./sealScoring.js?build=20260810-global-turn-reactive-v150";

/** stateUtility 中每点能量的单位价值；充能桩未来有效能量复用同一语义，不另设常数。 */
const ENERGY_STATE_WEIGHT = 1.2;
/** 额外 1 点能量跨过主动技能成本门槛时的选择权价值；与聚能现有启发式保持一致。 */
const SKILL_THRESHOLD_OPTION_VALUE = 4;

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

  /** 敌方攻击暴露：距离可达概率 × 公开威胁强度；只读公开/模拟合法字段，不读取隐藏手牌身份。 */
  incomingExposure(state, player) {
    let exposure = 0;
    for (const enemy of state.players) {
      if (!enemy?.alive || enemy.battleTeam === player.battleTeam || enemy.id === player.id) continue;
      const rangeProbability = DistanceSystem.getRangeLegalityProbability(
        { state }, enemy, player, enemy.attackRange ?? 1
      );
      if (rangeProbability <= 0) continue;
      const handCount = Math.max(0, Number(enemy.handCount ?? enemy.hand?.length ?? 0));
      const energy = Math.max(0, Number(enemy.energy ?? 0));
      // 威胁强度：基准1点突袭 + 公开手牌/能量折算的潜在攻击资源，再按 stateUtility 每点 hp=5 权重换算。
      const expectedDamage = 1 + Math.min(3, handCount) * .5 + Math.min(2, energy) * .3;
      exposure += expectedDamage * 5 * rangeProbability;
    }
    return exposure;
  }

  /** 雷达动态免伤：当前攻击暴露 × 雷达存在概率 × 判定为战术牌的条件概率；只对 defenseDevice 的真实规则生效。 */
  radarMitigationUtility(exposure, player, tacticJudgmentProbability) {
    if (player?.equipmentDefinitionId !== "defenseDevice") return 0;
    const retention = player.equipmentRetentionProbability ?? 1;
    return exposure * retention * tacticJudgmentProbability;
  }

  /**
   * 充能桩下一回合有效能量与技能选择权的动态价值。
   *
   * 只对 energyDevice 产生；按真实规则（TeamRuleService）计算两个反事实世界的
   * 下一回合开始能量，不修改任何状态，也不预测未来摸牌、目标或猎印。
   * 当前回合已使用的技能次数不会影响下一回合容量：主动技能均在自己回合开始
   * 时随 resetTurnFlags 重置。
   */
  energyDeviceFutureUtility(player) {
    if (player?.equipmentDefinitionId !== "energyDevice" || !player?.battleTeam || !this.game?.teamRules) return 0;
    const retention = player.equipmentRetentionProbability
      ?? (player.equipmentDefinitionId ? 1 : 0);
    if (retention <= 0) return 0;
    const ruleStub = { battleTeam: player.battleTeam };
    const cap = Math.max(0, Number(this.game.teamRules.getMaxEnergy(ruleStub)) || 0);
    const withoutBreakdown = this.game.teamRules.getTurnEnergyBreakdown(ruleStub);
    const withBreakdown = this.game.teamRules.getTurnEnergyBreakdown({
      ...ruleStub,
      equipment: { definitionId: "energyDevice" }
    });
    const currentEnergy = Math.max(0, Number(player.energy) || 0);
    const withoutGain = Number(withoutBreakdown.baseAmount) + Number(withoutBreakdown.teamBonus);
    const withGain = Number(withBreakdown.baseAmount) + Number(withBreakdown.teamBonus)
      + Number(withBreakdown.equipmentBonus);
    const withoutEnergy = Math.min(cap, currentEnergy + withoutGain);
    const withEnergy = Math.min(cap, currentEnergy + withGain);
    const effectiveGain = Math.max(0, withEnergy - withoutEnergy);
    const baseValue = effectiveGain * ENERGY_STATE_WEIGHT;
    const skillCost = Math.max(0, Number(player.activeSkillCost) || 0);
    const skillLimit = Math.max(0, Number(player.activeSkillLimit) || 0);
    let optionValue = 0;
    if (player.activeSkillId && skillCost > 0 && skillLimit > 0) {
      const affordableUses = (energy) => Math.min(skillLimit, Math.floor(energy / skillCost));
      const additionalUses = affordableUses(withEnergy) - affordableUses(withoutEnergy);
      optionValue = Math.max(0, additionalUses) * SKILL_THRESHOLD_OPTION_VALUE;
    }
    return retention * (baseValue + optionValue);
  }

  stateUtility(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) return -Infinity;
    const radarTacticProbability = buildRadarJudgmentProbabilities(state?.remainingCardCounts ?? null).tactic;
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
      const exposure = this.incomingExposure(state, player);
      const radarMitigation = this.radarMitigationUtility(exposure, player, radarTacticProbability);
      const energyDeviceFuture = this.energyDeviceFutureUtility(player);
      score += sign * (danger + rescueOutlook + player.hp * 5 + player.shield * 2 + player.energy * ENERGY_STATE_WEIGHT
        + player.handCount * 1.1 + handRoleDelta + (player.exposeWeaknessStacks ?? 0) * 1.5
        + equipmentDelta * .25 + equipmentRoleDelta * .25
        + (player.expectedInformationGain ?? 0) * .35 - markThreat * 1.5 - exposure + radarMitigation
        + energyDeviceFuture)
      - lightningTeamBurden(state, player, viewer.battleTeam)
      - sealTeamBurden(state, player, viewer.battleTeam);
    }
    return score;
  }

  actionUtility(action, player, visible, options = {}) {
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
        allIn: Math.max(0, actor.energy - 1) * 3
          + Math.min(1, actor.energy * .25) * (1 - (actor.assaultBonus ?? 0)) * 4,
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
    if (card.definitionId === "lightning") {
      value = lightningUseValue(actor, visible) + roleDelta;
    }
    const actionTarget = action.targets?.[0];
    const target = visible.players.find((entry) => entry.id === actionTarget?.id) ?? actionTarget;
    if (card.definitionId === "seal") {
      value = sealUseValue(actor, target, visible) + roleDelta;
      if (Array.isArray(options.availableActions)) {
        const alternatives = options.availableActions.filter((candidate) => (
          candidate !== action
          && candidate.type !== "end"
          && candidate.card?.definitionId !== "seal"
        ));
        const bestImmediateAlternative = alternatives.reduce((best, candidate) => (
          Math.max(best, this.actionUtility(candidate, player, visible)
            * (candidate.executionProbability ?? 1))
        ), -Infinity);
        value -= sealEarlyUsePenalty(bestImmediateAlternative);
      }
    }
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
    if (card.definitionId === "charge") value += (actor.maxEnergy - actor.energy) * 1.5 + (actor.activeSkillId && !actor.activeSkillUsed && actor.energy + 1 >= actor.activeSkillCost ? SKILL_THRESHOLD_OPTION_VALUE : 0);
    if (card.definitionId === "shield" && target) value += (target.hp <= 1 ? 6 : target.hp <= 2 ? 3 : 0) + Math.max(0, 2 - (target.shield ?? 0));
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
    if (card.category === "equipment" && equippedDefinitionId) {
      const oldValue = actor?.generalId
        ? getRoleCardAiValue(actor.generalId, equippedDefinitionId)
        : (CARD_DEFINITIONS[equippedDefinitionId]?.aiValue ?? 0);
      const oldRetention = actor.equipmentRetentionProbability ?? (oldValue ? 1 : 0);
      // 边际装备价值：新装备角色价值 - 旧装备按保留概率折算的期望价值；同款换装保留原有 -4 调整。
      value -= oldValue * oldRetention;
      if (equippedDefinitionId === card.definitionId) value -= 4;
    }
    return value;
  }

  symbiosisNet(player) {
    return this.symbiosisNetFromState(player, this.game.state);
  }

  symbiosisNetFromState(player, state) {
    return (assessGlobalBenefit(state.players, player.battleTeam, "symbiosis")?.netBenefit ?? 0) * 4;
  }
}
