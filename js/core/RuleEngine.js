import { DistanceSystem } from "./DistanceSystem.js?build=20260814-guardian-aid-discard";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260814-guardian-aid-discard";

/** UI、AI 与核心共享的唯一主动合法性入口。 */
export class RuleEngine {
  static isPlayerInGame(game, player) {
    return Boolean(player?.alive && game?.state?.players?.some((entry) => entry === player && entry.alive));
  }

  /** 统一状态检查：真实 Player 使用 statuses 对象，AI 可见/模拟状态使用 statuses 字符串数组。 */
  static hasStatus(player, statusId) {
    if (!player || !statusId) return false;
    if (Array.isArray(player.statuses)) return player.statuses.includes(statusId);
    return Boolean(player.statuses?.[statusId]);
  }

  /** 从当前持有者下一座位开始顺时针查找下一名合法闪电接收者；找不到其他合法接收者时兜底返回当前持有者自己。 */
  static nextLightningReceiver(players, holder) {
    if (!holder?.alive || !Array.isArray(players) || !players.length) return null;
    for (let offset = 1; offset < players.length; offset += 1) {
      const candidate = players[(holder.seatIndex + offset) % players.length];
      if (candidate?.alive && candidate.id !== holder.id && !this.hasStatus(candidate, "lightning")) return candidate;
    }
    return holder;
  }

  /**
   * 借势第二目标的实时候选：只要求存活、不是第一目标本人，且第一目标到
   * 第二目标的距离满足第一目标的攻击范围。不得检查阵营、手牌或突袭次数；
   * 这些条件属于后续响应与结算阶段。
   */
  static getAssaultTargetCandidates(game, source) {
    if (!this.isPlayerInGame(game, source)) return [];
    return game.state.players.filter((player) => player.alive
      && player.id !== source.id
      && DistanceSystem.inAttackRange(game, source, player));
  }

  /** 普通突袭的实时合法目标列表：兼容旧调用，仍包含距离、阵营、装备、技能和状态规则，不读取手牌或次数。 */
  static getLegalAssaultTargets(game, source) {
    if (!this.isPlayerInGame(game, source)) return [];
    return this.getCardTargets(game, source, CARD_DEFINITIONS.assault);
  }

  /** 借势选择阶段的兼容别名：第二目标只受距离限制。 */
  static getLeverageAssaultTargets(game, source) {
    return this.getAssaultTargetCandidates(game, source);
  }

  /** 普通突袭与借势响应共用的次数快照，额外次数统一体现在 attackLimit 中。 */
  static getAssaultUsage(source) {
    return Object.freeze({
      used:Number(source?.turnFlags?.attackUsed ?? source?.attackUsed ?? 0),
      limit:Number(source?.turnFlags?.attackLimit ?? source?.attackLimit ?? 0)
    });
  }

  /**
   * 实际使用突袭的统一入口。借势通过 allowOutOfTurn 放宽行动者和阶段要求，
   * 并通过 ignoreAttackLimit 忽略第一目标已用突袭次数；其余检查与普通主动突袭相同。
   */
  static canActuallyUseAssault(game, source, card, target = null, { allowOutOfTurn = false, ignoreAttackLimit = false } = {}) {
    if (!this.isPlayerInGame(game, source)) return { ok:false, reason:"角色已阵亡或离场" };
    if (!card || card.definitionId !== "assault" || !source.hand?.includes(card)) return { ok:false, reason:"突袭已不在手中" };
    if (card.usageMode === "response" || card.targetType === "responseOnly") return { ok:false, reason:"该牌不能主动使用" };
    if (!allowOutOfTurn && (game.state.phase !== "play" || game.currentPlayer?.id !== source.id)) {
      return { ok:false, reason:"现在不是你的出牌阶段" };
    }
    if (!ignoreAttackLimit) {
      const usage = this.getAssaultUsage(source);
      if (usage.used >= usage.limit) return { ok:false, reason:"本回合突袭次数已用尽" };
    }
    const candidates = this.getLegalAssaultTargets(game, source);
    if (target && !candidates.includes(target)) return { ok:false, reason:"目标不再是合法突袭目标" };
    if (!target && !candidates.length) return { ok:false, reason:"攻击距离内没有敌人" };
    return { ok:true, reason:"" };
  }

  /** 借势响应的兼容入口：只放宽不在本人出牌阶段，且忽略第一目标已用突袭次数。 */
  static canUseForcedAssault(game, source, card, target) {
    return this.canActuallyUseAssault(game, source, card, target, { allowOutOfTurn:true, ignoreAttackLimit:true });
  }

  static getUsableAssaultCards(game, source, target) {
    return (source?.hand ?? []).filter((card) => this.canUseForcedAssault(game, source, card, target).ok);
  }

  /** 第一目标必须拥有真实装备实例，并且至少存在一个距离合法的借势第二目标。 */
  static getLeverageFirstTargets(game, cardUser) {
    return game.state.players.filter((player) => player !== cardUser
      && this.isPlayerInGame(game, player)
      && Boolean(player.equipment?.id)
      && this.getAssaultTargetCandidates(game, player).length > 0);
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
    return DistanceSystem.getRangeLegalityProbability(game, source, target, card.effectRange) > 0;
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
      case "singleUnsealedEnemy": return enemies.filter((target) => !this.hasStatus(target, "sealed"));
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
      const assaultLegality = this.canActuallyUseAssault(game, source, card);
      if (!assaultLegality.ok) return assaultLegality;
    }
    if (card.definitionId === "recover") {
      const limit = source.turnFlags.recoverLimit;
      if (source.hp >= source.maxHp) return { ok:false, reason:"生命已满" };
      if (limit !== null && source.turnFlags.recoverUsed >= limit) return { ok:false, reason:"本回合调息次数已用尽" };
    }
    if (card.definitionId === "charge" && source.energy >= source.maxEnergy) return { ok:false, reason:"能量已经充满" };
    if (card.definitionId === "lightning" && this.hasStatus(source, "lightning")) return { ok:false, reason:"已处于闪电状态，不能再次使用闪电" };
    if (card.targetType === "otherWithCards" && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有可选择手牌的其他角色" };
    if (card.targetType === "otherWithCardsOrEquipment" && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"范围内没有可选择手牌或装备的其他角色" };
    if (card.targetType === "singleAlly" && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有可选择的存活队友" };
    if (["singleEnemy","singleEnemyInRange","singleUnsealedEnemy","allEnemies"].includes(card.targetType) && !this.getCardTargets(game, source, card).length) return { ok:false, reason:"没有合法敌方目标" };
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
    if (skillId === "barrier") candidates = alive.filter((player) => player.battleTeam === source.battleTeam);
    else if (skillId === "resonance") candidates = alive.filter((player) => player.battleTeam === source.battleTeam);
    else if (skillId === "symbiosis") candidates = alive.filter((player) => player.battleTeam === source.battleTeam && player.hp < player.maxHp);
    else if (skillId === "stealSkill") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && this.hasHandOrEquipment(player));
    else if (skillId === "hunt") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && player.statuses.huntMark?.sourceId === source.id);
    if (skill.rangeRule === "attack") return candidates.filter((target) => DistanceSystem.getRangeLegalityProbability(game, source, target, source.attackRange) > 0);
    if (skill.rangeRule === "fixed") return candidates.filter((target) => DistanceSystem.getRangeLegalityProbability(game, source, target, skill.range) > 0);
    if (["unlimited", "ally"].includes(skill.rangeRule)) return candidates;
    return skill.rangeRule === "self" && candidates.includes(source) ? [source] : [];
  }
}
