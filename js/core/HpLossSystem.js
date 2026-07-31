/**
 * 处理“失去生命”而非伤害。依赖 Game、EventBus 与 DyingSystem；它会修改生命，
 * 但故意绕过护盾、格挡和雷达。普通伤害必须继续使用 Game.damage()。
 */
export class HpLossSystem {
  constructor(game) { this.game = game; }

  async lose(player, amount, context = {}) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId) || !player?.alive || this.game.state.isGameOver || amount <= 0) return 0;
    const event = { type:"beforeHpLoss", player, amount:Math.max(0, amount), reason:context.reason ?? "效果", source:context.source ?? null, card:context.card ?? null, cancelled:false };
    await this.game.eventBus.emit("beforeHpLoss", event);
    if (!this.game.isSessionValid(gameId)) return 0;
    if (event.cancelled || event.amount <= 0) return 0;
    player.hp -= event.amount;
    player.statistics.damageTaken += event.amount;
    this.game.log(`${player.name}因${event.reason}失去${event.amount}点生命，当前生命${player.hp}。`, "damage");
    this.game.ui.queueFeedback?.("damage", player.id, event.amount);
    await this.game.eventBus.emit("afterHpLoss", { ...event, type:"afterHpLoss", actualAmount:event.amount });
    if (!this.game.isSessionValid(gameId)) return event.amount;
    if (player.hp <= 0 && player.alive) await this.game.dyingSystem.enter(player, event.source, context);
    if (!this.game.isSessionValid(gameId)) return event.amount;
    this.game.ui.render(this.game);
    return event.amount;
  }
}
