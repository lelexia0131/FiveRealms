/**
 * AI 团队效用评估器。只读取公开或过滤后的字段并返回分数，不生成、执行动作，
 * 不写 GameState；权重修改会影响阵营平衡，之后必须重跑 200 局模拟。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260730-equipment-control-v26";
import { ThreatCalculator } from "./ThreatCalculator.js?build=20260730-equipment-control-v26";
import { assessGlobalBenefit } from "./AiGlobalBenefit.js?build=20260730-equipment-control-v26";

export class AiEvaluator {
  constructor(game) { this.game = game; }

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
      const death = player.alive ? 0 : -28;
      const danger = player.alive && player.hp <= 1 ? -7 : 0;
      const rescueOutlook = player.survivalChance === undefined ? 0 : (player.survivalChance - 0.5) * 8;
      score += sign * (death + danger + rescueOutlook + player.hp * 5 + player.shield * 2 + player.energy * 1.2 + player.handCount * 1.1 + (player.exposeWeaknessStacks ?? 0) * 1.5);
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
        breakArmy: actor.hand?.filter((card) => card.definitionId === "assault").length ? 8 : 2,
        barrier: 4 + (target?.hp <= 2 ? 4 : 0),
        symbiosis: missing * 4,
        stealSkill: 5 + Math.min(4, (target?.handCount ?? 0) + (target?.equipmentDefinitionId ? 2 : 0)),
        burningField: enemies.reduce((sum, enemy) => sum + 2 + (enemy.hp <= 1 ? 8 : 0), 0),
        hunt: 7 + (target?.hp <= 2 ? 7 : 0),
        allIn: Math.min(2, actor.energy) * 3 + (actor.energy >= 3 ? 4 : 0),
        resonance: 5 + (target?.handCount <= 1 ? 3 : 0)
      };
      let value = values[action.skill.id] ?? 4;
      if (["stealSkill","hunt"].includes(action.skill.id)) value += this.threatPriority(actor, target, player.aiMemory, 1);
      return value;
    }
    const card = action.card;
    let value = card.aiValue ?? 0;
    const actionTarget = action.targets?.[0];
    const target = visible.players.find((entry) => entry.id === actionTarget?.id) ?? actionTarget;
    if (target) {
      const enemy = target.battleTeam !== player.battleTeam;
      if (card.subtypes.includes("attack") || card.definitionId === "duel") {
        const focus = (target.maxHp - target.hp) * 3 + (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        value += enemy ? 3 + focus : -12;
      }
      if (["plunder","destroy","scout"].includes(card.definitionId)) value += Math.min(5, (target.hand?.length ?? target.handCount ?? 0) + (target.equipmentDefinitionId || target.equipment ? 2 : 0));
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
    if (card.definitionId === "duel" && target) value += ((actor.expectedAssaultCount ?? 0) - (target.expectedAssaultCount ?? 0)) * 2;
    if (card.definitionId === "symbiosis") {
      const net = this.symbiosisNetFromState(actor, visible);
      value = net > 0 ? 8 + net : -9 + net;
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
