/**
 * AI 合法动作生成器。真实根节点依赖 RuleEngine，深层节点使用同一 RuleEngine
 * 读取过滤快照；不评分、不执行动作，也不接触其他玩家真实手牌。
 */
import { RuleEngine } from "../core/RuleEngine.js?build=20260730-equipment-control-v26";
import { ACTIVE_SKILLS, getActiveSkill } from "../generals/skillRegistry.js?build=20260730-equipment-control-v26";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260730-equipment-control-v26";

/** 生成当前真实局面与模拟后续局面的合法动作。 */
export class AiActionGenerator {
  constructor(game) { this.game = game; }

  chooseVisibleTransferPlan(game, actor, card) {
    const plans = [];
    for (const from of RuleEngine.getTransferSources(game, actor, card)) {
      for (const receiver of RuleEngine.getTransferReceivers(game, actor, from, card)) {
        if (from.equipmentDefinitionId) {
          const moved = CARD_DEFINITIONS[from.equipmentDefinitionId]?.aiValue ?? 0;
          const replaced = CARD_DEFINITIONS[receiver.equipmentDefinitionId]?.aiValue ?? 0;
          plans.push({
            sourceId:from.id, receiverId:receiver.id, zone:"equipment",
            score:(from.battleTeam === actor.battleTeam ? -moved : moved)
              + (receiver.battleTeam === actor.battleTeam ? moved - replaced : replaced - moved)
          });
        }
        if ((from.handCount ?? 0) > 0) {
          let score = (from.battleTeam === actor.battleTeam ? -4 : 4)
            + (receiver.battleTeam === actor.battleTeam ? 4 : -4);
          if (from.battleTeam === actor.battleTeam && receiver.battleTeam !== actor.battleTeam) score -= 8;
          if (from.battleTeam === actor.battleTeam && receiver.battleTeam === actor.battleTeam) {
            score += Math.min(
              Math.max(0, from.handCount - Math.max(0, from.hp)),
              Math.max(0, Math.max(0, receiver.hp) - receiver.handCount)
            ) * 4;
          }
          plans.push({ sourceId:from.id, receiverId:receiver.id, zone:"hand", score });
        }
      }
    }
    return plans.sort((a, b) => b.score - a.score)[0] ?? null;
  }

  generate(player) {
    const actions = [];
    for (const card of player.hand) {
      if (!RuleEngine.canPlayCard(this.game, player, card).ok) continue;
      const targets = RuleEngine.getCardTargets(this.game, player, card);
      if (card.definitionId === "transfer") {
        const sources = RuleEngine.getTransferSources(this.game, player, card)
          .filter((from) => RuleEngine.getTransferReceivers(this.game, player, from, card).length);
        const selection = this.game.aiController.cardSelector.chooseTransferCombination(player, card, sources);
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
    if (skill?.canUse(this.game, player).ok) {
      const targets = RuleEngine.getSkillTargets(this.game, player, skill);
      if (skill.targetType === "none" || skill.targetType === "allEnemies") actions.push({ type:"skill", skill, targets });
      else for (const target of targets) actions.push({ type:"skill", skill, targets:[target] });
    }
    actions.push({ type:"end" });
    return actions;
  }

  /** 从过滤快照重新生成深层动作；动态距离只使用快照中的实时 aliveRing。 */
  generateFromVisible(state, playerId) {
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
      const card = { ...definition, id:held.id };
      if (card.definitionId === "assault") {
        if (actor.attackUsed >= actor.attackLimit) continue;
        for (const target of RuleEngine.getCardTargets(simulationGame, actor, card)) actions.push({ type:"card", card, targets:[target] });
        continue;
      }
      if (card.definitionId === "recover" && (actor.hp >= actor.maxHp || (actor.recoverLimit !== null && actor.recoverUsed >= actor.recoverLimit))) continue;
      if (card.definitionId === "charge" && actor.energy >= actor.maxEnergy) continue;
      if (card.definitionId === "transfer") {
        const selection = this.chooseVisibleTransferPlan(simulationGame, actor, card);
        if (selection) actions.push({ type:"card", card, targets:[], selection });
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
    if (skill && !actor.activeSkillUsed && actor.energy >= skill.cost) {
      const allies = alive.filter((player) => player.id !== actor.id && player.battleTeam === actor.battleTeam);
      let targets = [];
      if (["barrier","resonance"].includes(skill.id)) targets = allies;
      else if (skill.id === "symbiosis") targets = allies.filter((player) => player.hp < player.maxHp);
      else if (skill.id === "stealSkill") targets = RuleEngine.getSkillTargets(simulationGame, actor, skill);
      else if (skill.id === "hunt") targets = enemies.filter((player) => player.huntMarkSourceId === actor.id);
      if (["none","allEnemies"].includes(skill.targetType)) actions.push({ type:"skill", skill, targets:skill.targetType === "allEnemies" ? enemies : [] });
      else for (const target of targets) actions.push({ type:"skill", skill, targets:[target] });
    }
    actions.push({ type:"end" });
    return actions;
  }
}
