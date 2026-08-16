/**
 * 处理“失去生命”而非伤害。依赖 Game、EventBus 与 DyingSystem；它会修改生命，
 * 但故意绕过护盾、格挡和雷达。普通伤害必须继续使用 Game.damage()。
 */
import { changeHp } from "../domain/state/transitions/ResourceTransitions.js?build=20260815-shadow-agent-p1-slot";
import { isDying } from "../domain/rules/combat/CombatRules.js?build=20260815-shadow-agent-p1-slot";

export class HpLossSystem {
  constructor(game) { this.game = game; }

  /*
  功能
  执行失去生命 workflow，提交已决定的 HP 写入并进入濒死流程。

  调用方
  tests 与未来效果路径。

  输入
  player、amount 与 context。

  输出
  实际失去生命量。

  读取状态
  Game session、EventBus 与 DyingSystem。

  写入状态
  player.hp 经 ResourceTransition。

  调用函数
  changeHp、EventBus.emit、dyingSystem.enter。

  边界与不变量
  绕过盾/格挡/雷达的既有语义不变。
  */
  async lose(player, amount, context = {}) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId) || !player?.alive || this.game.state.isGameOver || amount <= 0) return 0;
    const event = { type:"beforeHpLoss", player, amount:Math.max(0, amount), reason:context.reason ?? "效果", source:context.source ?? null, card:context.card ?? null, cancelled:false };
    await this.game.eventBus.emit("beforeHpLoss", event);
    if (!this.game.isSessionValid(gameId)) return 0;
    if (event.cancelled || event.amount <= 0) return 0;
    changeHp(this.game.state, player, -event.amount);
    player.statistics.damageTaken += event.amount;
    this.game.log(`${player.name}因${event.reason}失去${event.amount}点生命，当前生命${player.hp}。`, "damage");
    this.game.ui.queueFeedback?.("damage", player.id, event.amount);
    await this.game.eventBus.emit("afterHpLoss", { ...event, type:"afterHpLoss", actualAmount:event.amount });
    if (!this.game.isSessionValid(gameId)) return event.amount;
    if (isDying(player.hp, player.alive)) await this.game.dyingSystem.enter(player, event.source, context);
    if (!this.game.isSessionValid(gameId)) return event.amount;
    this.game.ui.render(this.game);
    return event.amount;
  }
}
