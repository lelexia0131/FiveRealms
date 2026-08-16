/**
 * Application Dying Workflow 的 legacy compatibility façade。
 * queue/active/dyingContext 的真实 owner 已迁至 js/application/combat/DyingWorkflow.js；
 * 本文件只做 Game collaborator 适配与方法转发。
 */
import { createId } from "../utils/helpers.js?build=20260816-legacy-recovery";
import { createDyingWorkflow } from "../application/combat/DyingWorkflow.js?build=20260816-legacy-recovery";

/*
功能
为本局 DyingWorkflow 构造显式 Game collaborator 依赖。

调用方
DyingSystem constructor。

输入
Game composition root。

输出
dependencies object。

读取状态
无。

写入状态
game.state.dyingContext 的 legacy projection setter。

调用函数
无。

边界与不变量
不构造第二份 workflow；Application 不持有 Game。
*/
function buildGameDyingWorkflowDependencies(game) {
  return {
    getState: () => game.state,
    isSessionValid: (gameId) => game.isSessionValid(gameId),
    emitEvent: (type, payload) => game.eventBus.emit(type, payload),
    requestDyingRescue: (...args) => game.responseSystem.requestDyingRescue(...args),
    heal: (...args) => game.heal(...args),
    discardCardFromHand: (...args) => game.discardCardFromHand(...args),
    drawCards: (...args) => game.drawCards(...args),
    syncDeckAliases: () => game.syncDeckAliases(),
    requestHumanPlayEndForDefeat: (target) => game.requestHumanPlayEndForDefeat(target),
    checkVictory: () => game.checkVictory(),
    createId,
    presentation: game.presentationPort,
    setDyingContextProjection: (value) => { game.state.dyingContext = value; }
  };
}

export class DyingSystem {
  /*
  功能
  创建 legacy DyingSystem façade 并组合 Application DyingWorkflow。

  调用方
  Game constructor。

  输入
  game。

  输出
  DyingSystem façade。

  读取状态
  无。

  写入状态
  无；运行时经 Application workflow。

  调用函数
  buildGameDyingWorkflowDependencies、createDyingWorkflow。

  边界与不变量
  不含第二份 dying workflow；所有方法只转发。
  */
  constructor(game) {
    this.game = game;
    this.workflow = createDyingWorkflow(buildGameDyingWorkflowDependencies(game));
  }

  /*
  功能
  转发 Application DyingWorkflow.enter。

  调用方
  CombatWorkflow 与 legacy callers。

  输入
  target、source 与 context。

  输出
  enter 结果。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.enter。

  边界与不变量
  无第二份 workflow。
  */
  enter(...args) { return this.workflow.enter(...args); }
  /*
  功能
  转发 Application DyingWorkflow.resolve。

  调用方
  legacy callers。

  输入
  target、source 与 context。

  输出
  resolve 结果。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.resolve。

  边界与不变量
  无第二份 workflow。
  */
  resolve(...args) { return this.workflow.resolve(...args); }
  /*
  功能
  转发 Application DyingWorkflow.rescueOrder。

  调用方
  ResponseBoundary 与 legacy callers。

  输入
  target。

  输出
  ordered players。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.rescueOrder。

  边界与不变量
  座位公式由 Domain Response Rule 唯一拥有。
  */
  rescueOrder(...args) { return this.workflow.rescueOrder(...args); }
  /*
  功能
  转发 Application DyingWorkflow.kill。

  调用方
  legacy tests。

  输入
  target 与 source。

  输出
  session validity。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.kill。

  边界与不变量
  无第二份 workflow。
  */
  kill(...args) { return this.workflow.kill(...args); }
  /*
  功能
  转发 Application DyingWorkflow death-coupled huntMark cleanup。

  调用方
  Game playerDead trigger bridge。

  输入
  dead source id。

  输出
  无。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.cleanupHuntMarksForSource。

  边界与不变量
  具体状态语义由 Domain Status Rule 唯一拥有。
  */
  cleanupHuntMarksForSource(...args) { return this.workflow.cleanupHuntMarksForSource(...args); }
  /*
  功能
  转发 Application DyingWorkflow.cleanup。

  调用方
  Game.dispose。

  输入
  无。

  输出
  无。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.cleanup。

  边界与不变量
  无第二份 lifecycle。
  */
  cleanup() { return this.workflow.cleanup(); }

  /*
  功能
  暴露 Application DyingWorkflow active 标志。

  调用方
  legacy observers。

  输入
  无。

  输出
  active boolean。

  读取状态
  Application workflow。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  façade 不缓存第二份 active。
  */
  get active() { return this.workflow.active; }
  /*
  功能
  暴露 Application DyingWorkflow 的只读队列快照。

  调用方
  legacy observers。

  输入
  无。

  输出
  冻结 queue snapshot。

  读取状态
  Application workflow。

  写入状态
  无。

  调用函数
  this.workflow.queueSnapshot。

  边界与不变量
  façade 不缓存第二份 queue；不暴露可变 owner queue。
  */
  get queueSnapshot() { return this.workflow.queueSnapshot; }
}
