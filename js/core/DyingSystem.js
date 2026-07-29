/**
 * 负生命值濒死与循环救援。依赖 ResponseSystem、EventBus 和 Game 的移动/胜负入口；
 * 救援顺序为本人，然后从本人下一座位起的存活队友。实例随 Game 创建，并在
 * dispose 时清空队列；它不负责普通伤害、护盾或调息的主动使用。
 */
export class DyingSystem {
  constructor(game) { this.game = game; this.active = false; this.queue = []; }

  async enter(target, source = null, context = {}) {
    if (!target?.alive || target.hp > 0 || this.game.state.isGameOver) return target?.hp > 0;
    if (this.active) {
      if (!this.queue.some((entry) => entry.target.id === target.id)) this.queue.push({ target, source, context });
      return false;
    }
    this.active = true;
    this.queue.push({ target, source, context });
    let rescued = false;
    try {
      while (this.queue.length && !this.game.state.isGameOver) {
        const entry = this.queue.shift();
        if (entry.target.alive && entry.target.hp <= 0) rescued = await this.resolve(entry.target, entry.source, entry.context);
      }
      return rescued;
    } finally {
      this.active = false;
      if (!this.game.state.isGameOver && this.game.state.phase === "dying") this.game.state.phase = context.previousPhase ?? "play";
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
    this.game.log(`${target.name}进入濒死，需要${1 - target.hp}张调息才能获救。`, "important");
    await this.game.eventBus.emit("playerDying", { type:"playerDying", target, source, need:1 - target.hp, context });
    this.game.ui.showDying?.(target, this.game.state.dyingContext);

    while (target.alive && target.hp <= 0 && this.game.isSessionValid(gameId)) {
      let usedThisRound = false;
      const order = this.rescueOrder(target);
      for (const rescuer of order) {
        if (target.hp >= 1 || !target.alive || this.game.state.isGameOver) break;
        const cards = rescuer.hand.filter((card) => card.definitionId === "recover");
        if (!cards.length) continue;
        const use = await this.game.responseSystem.requestDyingRescue(rescuer, target, cards[0]);
        if (!this.game.isSessionValid(gameId)) return false;
        if (!use) continue;
        usedThisRound = true;
        await this.game.heal(rescuer, target, 1, { card:use, reason:"dyingRescue", isDyingRescue:true });
        this.game.state.dyingContext = { targetId:target.id, need:Math.max(0, 1 - target.hp), currentHp:target.hp };
        this.game.log(`${rescuer.name}使用调息救援${target.name}，其生命变为${target.hp}。`, "heal");
        await this.game.eventBus.emit("dyingRescueUsed", { type:"dyingRescueUsed", target, rescuer, card:use, currentHp:target.hp });
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
      if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
      return true;
    }
    await this.kill(target, source);
    return false;
  }

  async kill(target, source) {
    if (!target.alive) return false;
    target.alive = false;
    this.game.ui.render(this.game);
    this.game.log(`${target.name}救援失败，阵亡。`, "important");
    for (const card of [...target.hand]) await this.game.discardCardFromHand(target, card, "阵亡清理");
    if (target.equipment) {
      const equipment = target.equipment;
      target.equipment = null;
      this.game.state.deck.discard(equipment);
      this.game.log(`${target.name}的装备「${equipment.name}」随阵亡进入弃牌堆。`);
    }
    this.game.syncDeckAliases();
    await this.game.eventBus.emit("playerDead", { type:"playerDead", target, source });
    await this.game.checkVictory();
    return true;
  }

  cleanup() { this.queue = []; this.active = false; }
}
