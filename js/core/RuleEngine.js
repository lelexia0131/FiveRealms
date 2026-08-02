import { DistanceSystem } from "./DistanceSystem.js?build=20260801-hunter-tracking-v53";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260801-hunter-tracking-v53";

/** UI、AI 与核心共享的唯一主动合法性入口。 */
export class RuleEngine {
  static isPlayerInGame(game, player) {
    return Boolean(player?.alive && game?.state?.players?.some((entry) => entry === player && entry.alive));
  }

  /**
   * 普通突袭的实时合法目标列表。借势只复用本入口，不复制距离、阵营或次数规则。
   * requireUsage 关闭时仅用于底层目标展示；默认同时检查当前突袭次数。
   */
  static getLegalAssaultTargets(game, source, { requireUsage = true } = {}) {
    if (!this.isPlayerInGame(game, source)) return [];
    const attackUsed = source.turnFlags?.attackUsed ?? source.attackUsed ?? 0;
    const attackLimit = source.turnFlags?.attackLimit ?? source.attackLimit ?? 0;
    if (requireUsage && attackUsed >= attackLimit) return [];
    return this.getCardTargets(game, source, CARD_DEFINITIONS.assault);
  }

  /** 借势响应使用真实手牌突袭；只放宽“必须轮到本人出牌”，其余规则完全保留。 */
  static canUseForcedAssault(game, source, card, target) {
    if (!this.isPlayerInGame(game, source)) return { ok:false, reason:"角色已阵亡或离场" };
    if (!card || card.definitionId !== "assault" || !source.hand?.includes(card)) return { ok:false, reason:"突袭已不在手中" };
    if (card.usageMode === "response" || card.targetType === "responseOnly") return { ok:false, reason:"该牌不能主动使用" };
    const attackUsed = source.turnFlags?.attackUsed ?? source.attackUsed ?? 0;
    const attackLimit = source.turnFlags?.attackLimit ?? source.attackLimit ?? 0;
    if (attackUsed >= attackLimit) return { ok:false, reason:"本回合突袭次数已用尽" };
    if (!this.getLegalAssaultTargets(game, source).includes(target)) return { ok:false, reason:"目标不再是合法突袭目标" };
    return { ok:true, reason:"" };
  }

  static getUsableAssaultCards(game, source, target) {
    return (source?.hand ?? []).filter((card) => this.canUseForcedAssault(game, source, card, target).ok);
  }

  /** 第一目标必须拥有真实装备实例，并且当前仍存在普通突袭合法目标。 */
  static getLeverageFirstTargets(game, cardUser) {
    return game.state.players.filter((player) => player !== cardUser
      && this.isPlayerInGame(game, player)
      && Boolean(player.equipment?.id)
      && this.getLegalAssaultTargets(game, player).length > 0);
  }
  static transferableHandCount(player, excludedCardIds = null) {
    if (Array.isArray(player?.hand)) return player.hand.filter((held) => !excludedCardIds?.has(held.id)).length;
    return Math.max(0, Number(player?.handCount ?? 0));
  }

  static hasHandOrEquipment(player, excludedCardIds = null) {
    return Boolean(this.transferableHandCount(player, excludedCardIds) > 0 || player?.equipment || player?.equipmentDefinitionId);
  }

  static isWithinCardEffectRange(game, source, target, card) {
    if (!source || !target || !target.alive) return false;
    if (source.id === target.id) return true;
    if (card?.ignoresDistance || card?.effectRange == null) return true;
    return DistanceSystem.getDistance(game, source, target) <= card.effectRange;
  }

  static getTransferSources(game, source, card, excludedCardIds = null) {
    const exclusions = excludedCardIds ?? (card?.definitionId === "transfer" && card?.id ? new Set([card.id]) : null);
    return game.state.players.filter((player) => player.alive && this.transferableHandCount(player, exclusions) > 0 && this.isWithinCardEffectRange(game, source, player, card));
  }

  static getTransferReceivers(game, source, from, card) {
    return game.state.players.filter((player) => player.alive && player.id !== from?.id && this.isWithinCardEffectRange(game, source, player, card));
  }

  static getCardTargets(game, source, card) {
    const alive = game.state.players.filter((player) => player.alive);
    const enemies = alive.filter((player) => player.battleTeam !== source.battleTeam);
    switch (card.targetType) {
      case "singleEnemyInRange": return enemies.filter((target) => DistanceSystem.inAttackRange(game, source, target, card));
      case "singleEnemy": return enemies;
      case "otherWithCards": return alive.filter((player) => player.id !== source.id && player.hand.length > 0);
      case "otherWithCardsOrEquipment": return alive.filter((player) => player.id !== source.id && this.hasHandOrEquipment(player) && this.isWithinCardEffectRange(game, source, player, card));
      case "anyWithCards": return alive.filter((player) => player.hand.length > 0);
      case "singleAlly": return alive.filter((player) => player.battleTeam === source.battleTeam);
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
      if (!this.getLegalAssaultTargets(game, source).length) return { ok:false, reason:"攻击距离内没有敌人" };
    }
    if (card.definitionId === "recover") {
      const limit = source.turnFlags.recoverLimit;
      if (source.hp >= source.maxHp) return { ok:false, reason:"生命已满" };
      if (limit !== null && source.turnFlags.recoverUsed >= limit) return { ok:false, reason:"本回合调息次数已用尽" };
    }
    if (card.definitionId === "charge" && source.energy >= source.maxEnergy) return { ok:false, reason:"能量已经充满" };
    if (card.targetType === "otherWithCards" && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有可选择手牌的其他角色" };
    if (card.targetType === "otherWithCardsOrEquipment" && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"范围内没有可选择手牌或装备的其他角色" };
    if (card.targetType === "singleAlly" && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有可选择的存活队友" };
    if (["singleEnemy","singleEnemyInRange","allEnemies"].includes(card.targetType) && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有合法敌方目标" };
    if (card.definitionId === "transfer") {
      const sources = this.getTransferSources(game, source, card);
      if (!sources.some((from) => this.getTransferReceivers(game, source, from, card).length)) return { ok:false, reason:"距离1内没有可转移手牌的来源和接收者" };
    }
    if (card.definitionId === "leverage" && !this.getLeverageFirstTargets(game, source).length) {
      return { ok:false, reason:"没有装备区有真实装备且能够突袭的其他角色" };
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
    if (card.targetType === "otherWithCardsOrEquipment" && target?.alive && target.id !== source.id) {
      const distance = DistanceSystem.getDistance(game, source, target);
      if (!card.ignoresDistance && card.effectRange != null && distance > card.effectRange) return { ok:false, reason:`距离${distance}，超过效果范围${card.effectRange}`, distance, range:card.effectRange };
    }
    return { ok:false, reason:"不是合法目标" };
  }

  static getSkillTargets(game, source, skill) {
    if (!skill?.rangeRule) return [];
    const skillId = skill.id;
    const alive = game.state.players.filter((player) => player.alive);
    let candidates = [];
    if (["barrier", "resonance"].includes(skillId)) candidates = alive.filter((player) => player.id !== source.id && player.battleTeam === source.battleTeam);
    else if (skillId === "symbiosis") candidates = alive.filter((player) => player.battleTeam === source.battleTeam && player.hp < player.maxHp);
    else if (skillId === "stealSkill") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && this.hasHandOrEquipment(player));
    else if (skillId === "hunt") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && player.statuses.huntMark?.sourceId === source.id);
    if (skill.rangeRule === "attack") return candidates.filter((target) => DistanceSystem.getDistance(game, source, target) <= source.attackRange);
    if (skill.rangeRule === "fixed") return candidates.filter((target) => DistanceSystem.getDistance(game, source, target) <= skill.range);
    if (["unlimited", "ally"].includes(skill.rangeRule)) return candidates;
    return skill.rangeRule === "self" && candidates.includes(source) ? [source] : [];
  }
}
