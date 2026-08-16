/**
 * Application Judgment Workflow 的 legacy compatibility façade。
 * 防御判定、延迟状态判定、seal/lightning resolution 的 authority 已迁至
 * js/application/judgment/；本文件只做 Game collaborator 适配与方法转发。
 */
import { createJudgmentWorkflow } from "../application/judgment/JudgmentWorkflow.js?build=20260816-fr-arch-14-runtime-closure";
import { createStatusResolutionWorkflow } from "../application/judgment/StatusResolutionWorkflow.js?build=20260816-fr-arch-14-runtime-closure";

/*
功能
为本局 JudgmentWorkflow 构造显式 Game collaborator 依赖。

调用方
JudgmentSystem constructor。

输入
Game composition root。

输出
dependencies object。

读取状态
无。

写入状态
game.state.currentJudgment 的 legacy projection setter。

调用函数
无。

边界与不变量
Application 不持有 Game；currentJudgment 为单向 projection。
*/
function buildGameJudgmentWorkflowDependencies(game) {
  return {
    getState: () => game.state,
    isSessionValid: (gameId) => game.isSessionValid(gameId),
    emitEvent: (type, payload) => game.eventBus.emit(type, payload),
    drawJudgmentCard: () => {
      const card = game.state.deck.drawToJudgment(game.state);
      game.syncDeckAliases();
      return card;
    },
    syncDeckAliases: () => game.syncDeckAliases(),
    moveJudgmentToDiscard: (card) => game.state.deck.finishJudgmentToDiscard(game.state, card),
    moveJudgmentToHand: (card, player) => game.state.deck.finishJudgmentToHand(game.state, card, player),
    observeJudgmentCard: (viewer, owner, card) => game.rememberPrivateCard(viewer, owner, card),
    presentation: game.presentationPort,
    setCurrentJudgmentProjection: (value) => { game.state.currentJudgment = value; }
  };
}

/*
功能
为本局 StatusResolutionWorkflow 构造显式 Game collaborator 依赖。

调用方
JudgmentSystem constructor。

输入
Game composition root 与已组合 JudgmentWorkflow。

输出
dependencies object。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
seal/lightning 不重新实现 counter/judgment/damage；只调用既有 Application workflow。
*/
function buildGameStatusResolutionDependencies(game, workflow) {
  return {
    getState: () => game.state,
    isSessionValid: (gameId) => game.isSessionValid(gameId),
    askForStatusCounter: (...args) => game.responseSystem.askForStatusCounter(...args),
    judgeSeal: (...args) => workflow.judgeSeal(...args),
    judgeLightning: (...args) => workflow.judgeLightning(...args),
    damage: (...args) => game.combatWorkflow.damage(...args),
    presentation: game.presentationPort
  };
}

export class JudgmentSystem {
  /*
  功能
  创建 legacy JudgmentSystem façade 并组合 Application Judgment/Status workflows。

  调用方
  Game constructor。

  输入
  game。

  输出
  JudgmentSystem façade。

  读取状态
  无。

  写入状态
  无；运行时经 Application workflows。

  调用函数
  buildGameJudgmentWorkflowDependencies、createJudgmentWorkflow、buildGameStatusResolutionDependencies、createStatusResolutionWorkflow。

  边界与不变量
  不含第二份 judgment/status workflow；所有方法只转发。
  */
  constructor(game) {
    this.game = game;
    this.workflow = createJudgmentWorkflow(buildGameJudgmentWorkflowDependencies(game));
    this.statusWorkflow = createStatusResolutionWorkflow(buildGameStatusResolutionDependencies(game, this.workflow));
  }

  /*
  功能
  转发 Application JudgmentWorkflow.judgeDefense。

  调用方
  Application CombatWorkflow。

  输入
  attacker、defender 与 attackContext。

  输出
  judgment result。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.judgeDefense。

  边界与不变量
  无第二份 workflow。
  */
  judgeDefense(...args) { return this.workflow.judgeDefense(...args); }
  /*
  功能
  转发 Application JudgmentWorkflow.judgeDelayedStatus。

  调用方
  status workflow 与 legacy callers。

  输入
  holder 与 options。

  输出
  judgment result。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.judgeDelayedStatus。

  边界与不变量
  无第二份 workflow。
  */
  judgeDelayedStatus(...args) { return this.workflow.judgeDelayedStatus(...args); }
  /*
  功能
  转发 Application JudgmentWorkflow.judgeLightning。

  调用方
  status workflow 与 legacy callers。

  输入
  holder 与 context。

  输出
  judgment result。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.judgeLightning。

  边界与不变量
  无第二份 workflow。
  */
  judgeLightning(...args) { return this.workflow.judgeLightning(...args); }
  /*
  功能
  转发 Application JudgmentWorkflow.judgeSeal。

  调用方
  status workflow 与 legacy callers。

  输入
  holder 与 context。

  输出
  judgment result。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.judgeSeal。

  边界与不变量
  无第二份 workflow。
  */
  judgeSeal(...args) { return this.workflow.judgeSeal(...args); }
  /*
  功能
  转发 Application StatusResolutionWorkflow.resolveSeal。

  调用方
  Game beforeStatusResolve trigger bridge。

  输入
  holder 与 status。

  输出
  Promise。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.statusWorkflow.resolveSeal。

  边界与不变量
  seal workflow authority 单一。
  */
  resolveSeal(...args) { return this.statusWorkflow.resolveSeal(...args); }
  /*
  功能
  转发 Application StatusResolutionWorkflow.resolveLightning。

  调用方
  Game beforeStatusResolve trigger bridge。

  输入
  holder 与 status。

  输出
  Promise。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.statusWorkflow.resolveLightning。

  边界与不变量
  lightning workflow authority 单一。
  */
  resolveLightning(...args) { return this.statusWorkflow.resolveLightning(...args); }
}
