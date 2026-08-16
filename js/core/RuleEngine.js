import { DistanceSystem } from "./DistanceSystem.js?build=20260815-shadow-agent-p1-slot";
import { hasStatus as hasStatusFromRule, nextLightningReceiverId } from "../domain/rules/status/StatusRules.js?build=20260815-shadow-agent-p1-slot";
import { getSkillTargetIds } from "../domain/rules/skill/SkillRules.js?build=20260815-shadow-agent-p1-slot";
import { createAttackUsage, hasAttackUseRemaining, hasRecoverUseRemaining, isActorTurn } from "../domain/rules/turn/TurnRules.js?build=20260815-shadow-agent-p1-slot";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260815-shadow-agent-p1-slot";
import {
  canActuallyUseAssault as decideAssaultLegality, canPlayCard as decideCardLegality,
  findPlayerFact, getAssaultTargetIds, getCardTargetIds, getLeverageFirstTargetIds,
  getTransferReceiverIds, getTransferSourceIds
} from "../domain/rules/card/CardRules.js?build=20260815-shadow-agent-p1-slot";

/** UI、AI 与核心共享的唯一主动合法性入口。 */
export class RuleEngine {
  /*
  功能
  把真实或 AI filtered players 投影为 Domain Card Rule canonical facts。

  调用方
  RuleEngine card/skill adapters。

  输入
  game。

  输出
  冻结 canonical player facts 数组。

  读取状态
  game.state.players 或 game.players。

  写入状态
  无。

  调用函数
  Object.keys。

  边界与不变量
  dual-schema statuses 只在本 adapter 归一化。
  */
  static getCardRulePlayers(game, { includeHand = true } = {}) {
    const players = game?.state?.players ?? game?.players ?? [];
    return players.map((player) => Object.freeze({
      id: player.id,
      seatIndex: player.seatIndex,
      alive: player.alive,
      battleTeam: player.battleTeam,
      hp: Number(player.hp) || 0,
      maxHp: Number(player.maxHp) || 0,
      shield: Number(player.shield) || 0,
      energy: Number(player.energy) || 0,
      maxEnergy: Number(player.maxEnergy) || 0,
      attackRange: Number(player.attackRange ?? 1) || 1,
      handCount: includeHand
        ? (Array.isArray(player.hand) ? player.hand.length : Math.max(0, Number(player.handCount) || 0))
        : 0,
      equipmentDefinitionId: player.equipment?.definitionId ?? player.equipmentDefinitionId ?? null,
      huntMarkSourceId: !Array.isArray(player.statuses) && player.statuses?.huntMark?.sourceId
        ? player.statuses.huntMark.sourceId
        : null,
      statusIds: Object.freeze(Array.isArray(player.statuses)
        ? player.statuses
        : Object.keys(player.statuses ?? {}))
    }));
  }

  static isPlayerInGame(game, player) {
    return Boolean(player?.alive && game?.state?.players?.some((entry) => entry === player && entry.alive));
  }

  /** 统一状态检查：真实 Player 使用 statuses 对象，AI 可见/模拟状态使用 statuses 字符串数组。 */
  /*
  功能
  判断真实或过滤玩家是否具有指定状态。

  调用方
  合法性、目标与测试。

  输入
  player 与 statusId。

  输出
  布尔值。

  读取状态
  player.statuses 或 statusIds。

  写入状态
  无。

  调用函数
  hasStatusFromRule。

  边界与不变量
  legacy dual-schema 仅作 adapter。
  */
  static hasStatus(player, statusId) {
    if (!player || !statusId) return false;
    if (Array.isArray(player.statuses)) return hasStatusFromRule({ statusIds: player.statuses }, statusId);
    return hasStatusFromRule({ statusIds: Object.keys(player.statuses ?? {}) }, statusId);
  }

  /** 从当前持有者下一座位开始顺时针查找下一名合法闪电接收者；找不到其他合法接收者时兜底返回当前持有者自己。 */
  /*
  功能
  返回下一名合法闪电接收者。

  调用方
  Game 状态 workflow 与 tests。

  输入
  players 与 holder。

  输出
  接收 Player 或 holder。

  读取状态
  players 存活/座位/状态。

  写入状态
  无。

  调用函数
  nextLightningReceiverId。

  边界与不变量
  legacy 投影只在本 facade。
  */
  static nextLightningReceiver(players, holder) {
    if (!holder?.alive || !Array.isArray(players) || !players.length) return null;
    const projected = players.map((player) => ({
      id: player.id,
      seatIndex: player.seatIndex,
      alive: player.alive,
      statusIds: Array.isArray(player.statuses)
        ? player.statuses
        : Object.keys(player.statuses ?? {})
    }));
    const receiverId = nextLightningReceiverId(projected, holder.id);
    return players.find((player) => player.id === receiverId) ?? holder;
  }

  /*
  功能
  返回借势第二目标候选。

  调用方
  RuleEngine card adapter 与 tests。

  输入
  game 与 source。

  输出
  Player 数组。

  读取状态
  alive/attackRange/equipment facts。

  写入状态
  无。

  调用函数
  getCardRulePlayers、getAssaultTargetIds。

  边界与不变量
  不检查阵营、手牌或突袭次数。
  */
  static getAssaultTargetCandidates(game, source) {
    if (!this.isPlayerInGame(game, source)) return [];
    const players = this.getCardRulePlayers(game, { includeHand:false });
    const sourceFact = findPlayerFact(players, source.id);
    const ids = getAssaultTargetIds(players, sourceFact);
    return (game.state?.players ?? game.players ?? []).filter((player) => ids.includes(player.id));
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

  /*
  功能
  返回普通突袭与借势响应共用的次数快照。

  调用方
  canActuallyUseAssault、AI 搜索与 tests。

  输入
  source。

  输出
  冻结的 { used, limit } 整数。

  读取状态
  source.turnFlags 或 legacy flat usage facts。

  写入状态
  无。

  调用函数
  getAttackUsage。

  边界与不变量
  额外次数统一体现在 limit；legacy dual-schema 归一化只发生在本 facade。
  */
  static getAssaultUsage(source) {
    const turnFlags = source?.turnFlags;
    const raw = turnFlags?.attackUsed !== undefined || turnFlags?.attackLimit !== undefined
      ? turnFlags
      : source;
    return createAttackUsage(raw?.attackUsed, raw?.attackLimit);
  }

  /*
  功能
  判断突袭牌在指定放宽条件下是否仍可实际使用。

  调用方
  canPlayCard、借势响应与 tests。

  输入
  game、source、card、target 与放宽选项。

  输出
  { ok, reason }。

  读取状态
  Game 玩家/阶段、手牌实体、突袭次数与合法目标。

  写入状态
  无。

  调用函数
  isPlayerInGame、getAssaultUsage、hasAttackUseRemaining、getLegalAssaultTargets。

  边界与不变量
  次数额度由 Domain Turn Rule 决定；forced assault 仍放宽出牌阶段并忽略首目标次数。
  */
  static canActuallyUseAssault(game, source, card, target = null, { allowOutOfTurn = false, ignoreAttackLimit = false } = {}) {
    const players = this.getCardRulePlayers(game);
    const sourceFact = findPlayerFact(players, source?.id);
    const usage = source ? this.getAssaultUsage(source) : { used:0, limit:0 };
    const decision = decideAssaultLegality({
      players,
      sourceId: source?.id,
      currentPlayerId: game.currentPlayer?.id ?? game.state?.currentPlayerId ?? null,
      phase: game.state?.phase ?? game.phase ?? "idle",
      card,
      inHand: Boolean(source?.hand?.includes(card) || source?.hand?.some?.((entry) => entry?.id === card?.id)),
      targetId: target?.id ?? null,
      usage,
      allowOutOfTurn,
      ignoreAttackLimit
    });
    return decision.ok || target
      ? decision
      : { ok: false, reason: decision.reason || "攻击距离内没有敌人" };
  }

  /** 借势响应的兼容入口：只放宽不在本人出牌阶段，且忽略第一目标已用突袭次数。 */
  static canUseForcedAssault(game, source, card, target) {
    return this.canActuallyUseAssault(game, source, card, target, { allowOutOfTurn:true, ignoreAttackLimit:true });
  }

  static getUsableAssaultCards(game, source, target) {
    return (source?.hand ?? []).filter((card) => this.canUseForcedAssault(game, source, card, target).ok);
  }

  /*
  功能
  返回借势第一目标候选。

  调用方
  canPlayCard 与 tests。

  输入
  game 与 cardUser。

  输出
  Player 数组。

  读取状态
  alive/equipment 与第二目标候选。

  写入状态
  无。

  调用函数
  getCardRulePlayers、getLeverageFirstTargetIds。

  边界与不变量
  第一目标必须持有真实装备实例。
  */
  static getLeverageFirstTargets(game, cardUser) {
    const players = this.getCardRulePlayers(game, { includeHand:false });
    const sourceFact = findPlayerFact(players, cardUser?.id);
    const ids = getLeverageFirstTargetIds(players, sourceFact);
    return (game.state?.players ?? game.players ?? []).filter((player) => ids.includes(player.id));
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

  /*
  功能
  返回可转移来源。

  调用方
  CardIntentRuntime 与 tests。

  输入
  game、source、card 与 excludedCardIds。

  输出
  Player 数组。

  读取状态
  alive/handCount/range facts。

  写入状态
  无。

  调用函数
  getCardRulePlayers、getTransferSourceIds。

  边界与不变量
  excluded transfer card 不计入来源手牌。
  */
  static getTransferSources(game, source, card, excludedCardIds = null) {
    const original = game.state?.players ?? game.players ?? [];
    const exclusions = excludedCardIds ?? (card?.definitionId === "transfer" && card?.id ? new Set([card.id]) : null);
    const players = this.getCardRulePlayers(game).map((fact) => {
      const player = original.find((entry) => entry.id === fact.id);
      return Object.freeze({
        ...fact,
        handCount: player ? this.transferableHandCount(player, exclusions) : fact.handCount
      });
    });
    const sourceFact = findPlayerFact(players, source?.id);
    const ids = getTransferSourceIds(players, sourceFact, card, exclusions);
    return original.filter((player) => ids.includes(player.id));
  }

  /*
  功能
  返回转移接收者。

  调用方
  CardIntentRuntime 与 tests。

  输入
  game、source、from 与 card。

  输出
  Player 数组。

  读取状态
  alive/range facts。

  写入状态
  无。

  调用函数
  getCardRulePlayers、getTransferReceiverIds。

  边界与不变量
  排除 from 自身。
  */
  static getTransferReceivers(game, source, from, card) {
    const players = this.getCardRulePlayers(game);
    const sourceFact = findPlayerFact(players, source?.id);
    const fromFact = findPlayerFact(players, from?.id);
    const ids = getTransferReceiverIds(players, sourceFact, fromFact, card);
    return (game.state?.players ?? game.players ?? []).filter((player) => ids.includes(player.id));
  }

  /*
  功能
  返回卡牌合法目标。

  调用方
  card rules consumers。

  输入
  game、source 与 card。

  输出
  Player 数组。

  读取状态
  canonical card rule facts。

  写入状态
  无。

  调用函数
  getCardRulePlayers、getCardTargetIds。

  边界与不变量
  目标 formula 由 Domain CardRules 唯一拥有。
  */
  static getCardTargets(game, source, card) {
    const players = this.getCardRulePlayers(game);
    const sourceFact = findPlayerFact(players, source?.id);
    const ids = getCardTargetIds(players, sourceFact, card);
    return (game.state?.players ?? game.players ?? []).filter((player) => ids.includes(player.id));
  }

  /*
  功能
  判断主动卡牌在真实对局中是否合法可出。

  调用方
  Game.playCard、AI 执行边界与 tests。

  输入
  game、source 与 card。

  输出
  { ok, reason }。

  读取状态
  Game 阶段/当前行动者、手牌实体、资源与状态。

  写入状态
  无。

  调用函数
  canActuallyUseAssault、hasRecoverUseRemaining、hasStatus、getCardTargets 等。

  边界与不变量
  调息额度由 Domain Turn Rule 决定；具体卡牌目标规则仍属 cardRegistry/deferred。
  */
  static canPlayCard(game, source, card) {
    const usage = this.getAssaultUsage(source);
    const transferSourceIds = card?.definitionId === "transfer"
      ? this.getTransferSources(game, source, card).map((player) => player.id)
      : null;
    return decideCardLegality({
      players: this.getCardRulePlayers(game),
      sourceId: source?.id,
      currentPlayerId: game.currentPlayer?.id ?? game.state?.currentPlayerId ?? null,
      phase: game.state?.phase ?? game.phase ?? "idle",
      card,
      inHand: Boolean(source?.hand?.includes(card) || source?.hand?.some?.((entry) => entry?.id === card?.id)),
      assaultUsage: usage,
      recoverUsed: source?.turnFlags?.recoverUsed ?? source?.recoverUsed ?? 0,
      recoverLimit: source?.turnFlags?.recoverLimit ?? source?.recoverLimit ?? null,
      transferSourceIds
    });
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

  /*
  功能
  返回技能合法目标。

  调用方
  ActionWorkflow/skillRegistry 与 tests。

  输入
  game、source 与 skill。

  输出
  Player 数组。

  读取状态
  canonical skill rule facts。

  写入状态
  无。

  调用函数
  getCardRulePlayers、getSkillTargetIds。

  边界与不变量
  目标 formula 由 Domain SkillRules 唯一拥有。
  */
  static getSkillTargets(game, source, skill) {
    if (!skill?.rangeRule) return [];
    const players = this.getCardRulePlayers(game);
    const ids = getSkillTargetIds(players, source?.id, skill);
    return (game.state?.players ?? game.players ?? []).filter((player) => ids.includes(player.id));
  }
}
