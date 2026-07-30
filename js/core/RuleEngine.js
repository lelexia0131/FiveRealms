import { DistanceSystem } from "./DistanceSystem.js?build=20260730-response-v3";

/** UI、AI 与核心共享的唯一主动合法性入口。 */
export class RuleEngine {
  static getCardTargets(game, source, card) {
    const alive = game.state.players.filter((player) => player.alive);
    const enemies = alive.filter((player) => player.battleTeam !== source.battleTeam);
    switch (card.targetType) {
      case "singleEnemyInRange": return enemies.filter((target) => DistanceSystem.inAttackRange(game, source, target, card));
      case "singleEnemy": return enemies;
      case "otherWithCards": return alive.filter((player) => player.id !== source.id && player.hand.length > 0);
      case "anyWithCards": return alive.filter((player) => player.hand.length > 0);
      case "self": return [source];
      case "allEnemies": return enemies;
      case "allLiving": return alive;
      case "multiStage": return alive;
      case "none": return [];
      default: return [];
    }
  }

  static canPlayCard(game, source, card) {
    if (!source?.alive) return { ok:false, reason:"角色已阵亡" };
    if (game.state.phase !== "play" || game.currentPlayer?.id !== source.id) return { ok:false, reason:"现在不是你的出牌阶段" };
    if (!source.hand.includes(card)) return { ok:false, reason:"这张牌已不在手中" };
    if (card.usageMode === "response" || card.targetType === "responseOnly") return { ok:false, reason:"这张牌只能在对应响应时机使用" };
    if (card.definitionId === "assault") {
      if (source.turnFlags.attackUsed >= source.turnFlags.attackLimit) return { ok:false, reason:"本回合突袭次数已用尽" };
      if (!this.getCardTargets(game, source, card).length) return { ok:false, reason:"攻击距离内没有敌人" };
    }
    if (card.definitionId === "recover") {
      const limit = source.turnFlags.recoverLimit;
      if (source.hp >= source.maxHp) return { ok:false, reason:"生命已满" };
      if (limit !== null && source.turnFlags.recoverUsed >= limit) return { ok:false, reason:"本回合调息次数已用尽" };
    }
    if (card.definitionId === "charge" && source.energy >= source.maxEnergy) return { ok:false, reason:"能量已经充满" };
    if (["otherWithCards"].includes(card.targetType) && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有可选择手牌的其他角色" };
    if (["singleEnemy","singleEnemyInRange","allEnemies"].includes(card.targetType) && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有合法敌方目标" };
    if (card.definitionId === "transfer") {
      const sources = game.state.players.filter((player) => player.alive && player.hand.length > 0);
      if (!sources.length || game.state.players.filter((player) => player.alive).length < 2) return { ok:false, reason:"没有可完成转移的来源和接收者" };
    }
    return { ok:true, reason:"" };
  }

  static targetLegality(game, source, card, target) {
    const legal = this.getCardTargets(game, source, card).includes(target);
    if (legal) return { ok:true, reason:"", ...DistanceSystem.describe(game, source, target) };
    if (card.targetType === "singleEnemyInRange" && target.battleTeam !== source.battleTeam) {
      const distance = DistanceSystem.getDistance(game, source, target);
      return { ok:false, reason:`距离${distance}，超过攻击范围${source.attackRange}`, distance, range:source.attackRange };
    }
    return { ok:false, reason:"不是合法目标" };
  }

  static getSkillTargets(game, source, skill) {
    if (!skill?.rangeRule) return [];
    const skillId = skill.id;
    const alive = game.state.players.filter((player) => player.alive);
    let candidates = [];
    if (["barrier", "resonance"].includes(skillId)) candidates = alive.filter((player) => player.id !== source.id && player.battleTeam === source.battleTeam);
    else if (skillId === "symbiosis") candidates = alive.filter((player) => player.id !== source.id && player.battleTeam === source.battleTeam && player.hp < player.maxHp);
    else if (skillId === "stealSkill") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && player.hand.length > 0);
    else if (skillId === "hunt") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && player.statuses.huntMark?.sourceId === source.id);
    if (skill.rangeRule === "attack") return candidates.filter((target) => DistanceSystem.getDistance(game, source, target) <= source.attackRange);
    if (["unlimited", "ally"].includes(skill.rangeRule)) return candidates;
    return skill.rangeRule === "self" && candidates.includes(source) ? [source] : [];
  }
}
