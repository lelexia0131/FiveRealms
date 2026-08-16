/**
 * Application Response Workflow 的 legacy compatibility façade。
 * 所有 response workflow authority 已迁至 js/application/response/ResponseWorkflow.js；
 * 本文件只做 Game collaborator 适配与方法转发。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260815-shadow-agent-p1-slot";
import { createId } from "../utils/helpers.js?build=20260815-shadow-agent-p1-slot";
import { getAiDelay } from "../utils/aiTiming.js?build=20260815-shadow-agent-p1-slot";
import { RuleEngine } from "./RuleEngine.js?build=20260815-shadow-agent-p1-slot";
import { createResponseWorkflow } from "../application/response/ResponseWorkflow.js?build=20260815-shadow-agent-p1-slot";
import { buildResponsePresentation } from "../application/response/ResponsePresentation.js?build=20260815-shadow-agent-p1-slot";
import { RESPONSE_STATUS, isCancelledResponse } from "../application/response/ResponseResult.js?build=20260815-shadow-agent-p1-slot";

export { buildResponsePresentation, RESPONSE_STATUS, isCancelledResponse };

export class ResponseSystem {
  /*
  功能
  创建 legacy ResponseSystem façade 并组合 Application Response Workflow。

  调用方
  Game 构造函数。

  输入
  game、choiceCoordinator 与 choiceContexts。

  输出
  ResponseSystem façade。

  读取状态
  无。

  写入状态
  无；运行时经 Application workflow。

  调用函数
  createResponseWorkflow。

  边界与不变量
  不包含第二份 response workflow；所有方法只转发。
  */
  constructor(game, choiceCoordinator = null, choiceContexts = null) {
    this.game = game;
    this.workflow = createResponseWorkflow({
      choiceCoordinator,
      choiceContexts,
      getState: () => game.state,
      isSessionValid: (gameId) => game.isSessionValid(gameId),
      pushPendingResponse: (request) => game.state.pendingResponses.push(request),
      removePendingResponse: (id) => {
        if (!game.state.isDisposed) {
          game.state.pendingResponses = game.state.pendingResponses.filter((request) => request.id !== id);
        }
      },
      clearPendingResponses: () => { game.state.pendingResponses = []; },
      payCardsFromHandAtomically: (...args) => game.payCardsFromHandAtomically(...args),
      setCurrentCard: (...args) => game.ui.setCurrentCard?.(...args),
      log: (message, kind = "normal") => game.log(message, kind),
      emitCardUsed: (payload) => game.eventBus.emit("cardUsed", payload),
      getForceAiRescueHuman: () => game.forceAiRescueHuman ?? GAME_CONFIG.forceAiRescueHuman,
      setThinking: (isThinking, player, message) => game.ui.setThinking(isThinking, player, message),
      delayResponse: async () => game.cleanupManager.delay(getAiDelay(game, "response")),
      getUsableAssaultCards: (responder, target) => RuleEngine.getUsableAssaultCards(game, responder, target),
      canUseForcedAssault: (responder, card, target) => RuleEngine.canUseForcedAssault(game, responder, card, target),
      getResponseTimeoutMs: () => GAME_CONFIG.responseTimeoutMs,
      createId
    });
  }

/*
功能
转发 Application ResponseWorkflow.waitForDecision。

调用方
response workflow methods。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.waitForDecision。

边界与不变量
本文件无第二份 workflow。
*/
  waitForDecision(...args) { return this.workflow.waitForDecision(...args); }
/*
功能
转发 Application ResponseWorkflow.requestCardResponse。

调用方
response workflow methods。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.requestCardResponse。

边界与不变量
本文件无第二份 workflow。
*/
  requestCardResponse(...args) { return this.workflow.requestCardResponse(...args); }
/*
功能
转发 Application ResponseWorkflow.askForBlock。

调用方
Game.damage。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.askForBlock。

边界与不变量
本文件无第二份 workflow。
*/
  askForBlock(...args) { return this.workflow.askForBlock(...args); }
/*
功能
转发 Application ResponseWorkflow.emitResolvedCounterUse。

调用方
Application workflow。

输入
原 ResponseSystem 参数。

输出
event emission。

读取状态
无。

写入状态
无。

调用函数
this.workflow.emitResolvedCounterUse。

边界与不变量
本文件无第二份 workflow。
*/
  emitResolvedCounterUse(...args) { return this.workflow.emitResolvedCounterUse(...args); }
/*
功能
转发 Application ResponseWorkflow.askForCounter。

调用方
Game.playCard 与 cardRegistry。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.askForCounter。

边界与不变量
本文件无第二份 workflow。
*/
  askForCounter(...args) { return this.workflow.askForCounter(...args); }
/*
功能
转发 Application ResponseWorkflow.askForStatusCounter。

调用方
Game 延迟状态 workflow。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.askForStatusCounter。

边界与不变量
本文件无第二份 workflow。
*/
  askForStatusCounter(...args) { return this.workflow.askForStatusCounter(...args); }
/*
功能
转发 Application ResponseWorkflow.requestDyingRescue。

调用方
DyingSystem。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.requestDyingRescue。

边界与不变量
Dying workflow 本体仍 deferred。
*/
  requestDyingRescue(...args) { return this.workflow.requestDyingRescue(...args); }
/*
功能
转发 Application ResponseWorkflow.requestAssaultDiscard。

调用方
cardRegistry 决斗/挑衅 workflow。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.requestAssaultDiscard。

边界与不变量
本文件无第二份 workflow。
*/
  requestAssaultDiscard(...args) { return this.workflow.requestAssaultDiscard(...args); }
/*
功能
转发 Application ResponseWorkflow.requestLeverageAssault。

调用方
Game leverage workflow。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.requestLeverageAssault。

边界与不变量
本文件无第二份 workflow。
*/
  requestLeverageAssault(...args) { return this.workflow.requestLeverageAssault(...args); }
/*
功能
转发 Application ResponseWorkflow.requestSkillResponse。

调用方
skillRegistry。

输入
原 ResponseSystem 参数。

输出
ResponseWorkflowResult。

读取状态
无。

写入状态
无。

调用函数
this.workflow.requestSkillResponse。

边界与不变量
本文件无第二份 workflow。
*/
  requestSkillResponse(...args) { return this.workflow.requestSkillResponse(...args); }
/*
功能
转发 Application ResponseWorkflow.finishRequest。

调用方
response workflow methods。

输入
request id。

输出
无。

读取状态
无。

写入状态
无。

调用函数
this.workflow.finishRequest。

边界与不变量
本文件无第二份 lifecycle。
*/
  finishRequest(...args) { return this.workflow.finishRequest(...args); }
/*
功能
转发 Application ResponseWorkflow.cleanup。

调用方
Game dispose/restart。

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
本文件无第二份 lifecycle。
*/
  cleanup() { return this.workflow.cleanup(); }
}
