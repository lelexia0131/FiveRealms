import { GAME_CONFIG } from "../config/gameConfig.js?build=20260815-card-estimate-parity-fix";
import { createId } from "../utils/helpers.js?build=20260815-card-estimate-parity-fix";

/**
 * 负生命值濒死与循环救援。依赖 ResponseSystem、EventBus 和 Game 的移动/胜负入口；
 * 救援顺序为本人，然后从本人下一座位起的存活队友。实例随 Game 创建，并在
 * dispose 时清空队列；它不负责普通伤害、护盾或调息的主动使用。
 */
export class DyingSystem {
  constructor(game) { this.game = game; this.active = false; this.queue = []; }

  async enter(target, source = null, context = {}) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId) || !target?.alive || target.hp > 0 || this.game.state.isGameOver) return target?.hp > 0;
    if (this.active) {
      if (!this.queue.some((entry) => entry.target.id === target.id)) this.queue.push({ target, source, context });
      return false;
    }
    const entryPhase = this.game.state.phase;
    this.active = true;
    this.queue.push({ target, source, context });
    let rescued = false;
    try {
      while (this.queue.length && !this.game.state.isGameOver && this.game.isSessionValid(gameId)) {
        const entry = this.queue.shift();
        if (entry.target.alive && entry.target.hp <= 0) rescued = await this.resolve(entry.target, entry.source, entry.context);
        if (!this.game.isSessionValid(gameId)) return false;
      }
      return rescued;
    } finally {
      this.active = false;
      if (this.game.isSessionValid(gameId) && !this.game.state.isGameOver && this.game.state.phase === "dying") this.game.state.phase = entryPhase;
    }
  }

  rescueOrder(target) {
    const players = this.game.state.players;
    const allies = [];
    for (let offset = 1; offset < players.length; offset += 1) {
      const candidate = players[(target.seatIndex + offset) % players.length];
      if (candidate.alive && candidate.battleTeam === target.battleTeam) allies.push(candidate);
    }
    return [target, ...allies];
  }

  async resolve(target, source, context) {
    const gameId = this.game.state.gameId;
    const previousPhase = this.game.state.phase;
    const before = { type:"beforePlayerDying", target, source, context, cancelled:false };
    await this.game.eventBus.emit("beforePlayerDying", before);
    if (!this.game.isSessionValid(gameId)) return false;
    if (before.cancelled) {
      if (target.alive && target.hp <= 0) {
        target.hp = 1;
        this.game.log(`${target.name}的濒死被取消，生命恢复到1点以保持存活状态。`, "heal");
        this.game.ui.queueFeedback?.("heal", target.id, 1);
        this.game.ui.render(this.game);
      }
      return target.hp > 0;
    }
    if (target.hp > 0 || !target.alive) return target.hp > 0;
    this.game.state.phase = "dying";
    this.game.state.dyingContext = { targetId:target.id, need:1 - target.hp, currentHp:target.hp };
    this.game.log(`${target.name}进入濒死，还需恢复${1 - target.hp}点生命才能脱离濒死。`, "important");
    await this.game.eventBus.emit("playerDying", { type:"playerDying", target, source, need:1 - target.hp, context });
    if (!this.game.isSessionValid(gameId)) return false;
    this.game.ui.showDying?.(target, this.game.state.dyingContext);

    while (target.alive && target.hp <= 0 && this.game.isSessionValid(gameId)) {
      let usedThisRound = false;
      const order = this.rescueOrder(target);
      for (const rescuer of order) {
        if (target.hp >= 1 || !target.alive || this.game.state.isGameOver) break;
        const cards = rescuer.hand.filter((card) => card.definitionId === "recover");
        // 合法真人即使没有调息也应看到本次救援响应；AI 无牌会在响应系统立即跳过。
        const response = await this.game.responseSystem.requestDyingRescue(rescuer, target, cards[0] ?? null);
        if (!this.game.isSessionValid(gameId)) return false;
        if (response.status === "cancelled") return false;
        if (response.status !== "used" || !response.card) continue;
        usedThisRound = true;
        const healed = await this.game.heal(rescuer, target, 1, {
          card:response.card, reason:"dyingRescue", isDyingRescue:true, silentLog:true,
          resultLog:() => `${rescuer.name}使用「调息」救援${target.name}，使其恢复至${target.hp}点生命。`
        });
        if (!this.game.isSessionValid(gameId)) return false;
        this.game.state.dyingContext = { targetId:target.id, need:Math.max(0, 1 - target.hp), currentHp:target.hp };
        if (target.hp <= 0) this.game.log(`${target.name}仍处于濒死，还需恢复${1 - target.hp}点生命。`, "important");
        await this.game.eventBus.emit("dyingRescueUsed", { type:"dyingRescueUsed", target, rescuer, card:response.card, currentHp:target.hp });
        if (!this.game.isSessionValid(gameId)) return false;
        if (healed > 0) {
          await this.game.eventBus.emit("cardUsed", {
            type:"cardUsed",
            source:rescuer,
            card:response.card,
            targets:[target],
            effectiveTargets:[target],
            cancelled:false,
            resolved:true,
            resolutionId:createId("rescue-resolution"),
            usageContext:"dyingRescue"
          });
          if (!this.game.isSessionValid(gameId)) return false;
        }
        this.game.ui.showDying?.(target, this.game.state.dyingContext);
        this.game.ui.render(this.game);
      }
      if (!usedThisRound) break;
    }

    this.game.state.dyingContext = null;
    this.game.ui.hideDying?.();
    if (target.hp >= 1) {
      this.game.log(`${target.name}脱离濒死。`, "heal");
      await this.game.eventBus.emit("playerRescued", { type:"playerRescued", target, source });
      if (!this.game.isSessionValid(gameId)) return false;
      if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
      return true;
    }
    await this.kill(target, source);
    if (!this.game.isSessionValid(gameId)) return false;
    if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
    return false;
  }

  async kill(target, source) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId) || !target.alive) return false;
    target.hp = 0;
    target.alive = false;
    target.statuses = {};
    if (target.turnFlags) {
      target.turnFlags.momentum = 0;
      target.turnFlags.skipActionPhase = false;
    }
    this.game.requestHumanPlayEndForDefeat?.(target);
    this.game.ui.render(this.game);
    this.game.log(`${target.name}救援失败，阵亡。`, "important");
    for (const card of [...target.hand]) {
      await this.game.discardCardFromHand(target, card, "阵亡清理", { silent:true });
      if (!this.game.isSessionValid(gameId)) return false;
    }
    if (target.equipment) {
      const equipment = target.equipment;
      target.equipment = null;
      this.game.state.deck.discard(equipment);
      this.game.log(`${target.name}的装备「${equipment.name}」随阵亡进入弃牌堆。`);
    }
    this.game.syncDeckAliases();
    await this.game.eventBus.emit("playerDead", { type:"playerDead", target, source });
    if (!this.game.isSessionValid(gameId)) return false;
    if (!target.gameFlags.killRewardGranted && source?.alive && source.battleTeam !== target.battleTeam) {
      target.gameFlags.killRewardGranted = true;
      const drawn = await this.game.drawCards(source, GAME_CONFIG.killRewardDrawCount, "击杀奖励", { silent:true });
      if (!this.game.isSessionValid(gameId)) return false;
      this.game.log(`${source.name}击杀了${target.name}，额外摸了${drawn}张牌。`, "important");
      await this.game.eventBus.emit("enemyKilled", { type:"enemyKilled", source, target, drawn });
      if (!this.game.isSessionValid(gameId)) return false;
    }
    await this.game.checkVictory();
    return this.game.isSessionValid(gameId);
  }

  cleanup() { this.queue = []; this.active = false; }
}
