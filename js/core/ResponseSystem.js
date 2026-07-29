/**
 * 本文件实现统一的 Promise 响应窗口，依赖 UI、AI 与规则引擎。
 * 格挡、转移、反制和护援都通过这里等待，避免每张牌各自绑定按钮。
 * 每次返回前都会检查 gameId、角色存活和请求唯一状态；重新开始时 UI 与 CleanupManager 会解除旧等待。
 */
import { GAME_CONFIG } from "../config/gameConfig.js";
import { RuleEngine } from "./RuleEngine.js";
import { createId } from "../utils/helpers.js";
import { Debug } from "../utils/debug.js";

const RESPONSE_CARD = Object.freeze({ block: "block", redirect: "redirect", counter: "counter" });

export class ResponseSystem {
  /** @param {import("./Game.js").Game} game 当前对局。 */
  constructor(game) {
    this.game = game;
    this.activeRequestIds = new Set();
  }

  /**
   * 向单名角色发起卡牌响应。真人显示倒计时，电脑使用过滤后的公开状态评分。
   * @param {Player} responder 响应者。
   * @param {"block"|"redirect"|"counter"} type 响应类型。
   * @param {Object} context 伤害或卡牌上下文。
   * @returns {Promise<boolean>} 是否成功使用响应牌。
   */
  async requestCardResponse(responder, type, context) {
    const gameId = this.game.state.gameId;
    const definitionId = RESPONSE_CARD[type];
    const card = responder.findCard(definitionId);
    if (!card || !responder.alive || this.game.state.isGameOver) return false;
    const request = {
      id: createId("response"),
      type,
      sourcePlayerId: context.source?.id ?? null,
      targetPlayerId: responder.id,
      cardId: context.card?.id ?? null,
      legalCardIds: [card.id],
      legalSkillIds: [],
      timeoutMs: GAME_CONFIG.responseTimeoutMs,
      allowDecline: true
    };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    Debug.log("Response", `创建 ${type} 响应`, request);

    let use = false;
    if (responder.controllerType === "human") {
      use = Boolean(await this.game.ui.requestResponse(request, card.name));
    } else {
      const waited = await this.game.cleanupManager.delay(GAME_CONFIG.aiResponseDelayMs);
      if (waited) use = this.game.aiController.shouldRespond(responder, type, context);
    }

    const stillValid = this.activeRequestIds.has(request.id)
      && this.game.isSessionValid(gameId)
      && responder.alive
      && responder.hand.includes(card);
    this.finishRequest(request.id);
    if (!use || !stillValid) return false;
    await this.game.discardCardFromHand(responder, card, `响应·${card.name}`);
    this.game.log(`${responder.name}使用了${card.name}。`, "important");
    return true;
  }

  /**
   * 向角色发起护援技能响应。发动后的具体弃牌由技能监听器完成。
   * @returns {Promise<boolean>} 是否选择发动。
   */
  async requestSkillResponse(responder, skillId, label, context) {
    if (!responder.alive || this.game.state.isGameOver) return false;
    const gameId = this.game.state.gameId;
    const request = {
      id: createId("response"), type: "skill", sourcePlayerId: context.source?.id ?? null,
      targetPlayerId: responder.id, cardId: context.card?.id ?? null,
      legalCardIds: [], legalSkillIds: [skillId], timeoutMs: GAME_CONFIG.responseTimeoutMs, allowDecline: true
    };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    let use = false;
    if (responder.controllerType === "human") use = Boolean(await this.game.ui.requestResponse(request, label));
    else {
      const waited = await this.game.cleanupManager.delay(GAME_CONFIG.aiResponseDelayMs);
      if (waited) use = this.game.aiController.shouldRespond(responder, "guardianAid", context);
    }
    const stillValid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive;
    this.finishRequest(request.id);
    return use && stillValid;
  }

  /**
   * 处理可格挡伤害，格挡成功返回减伤点数。
   * @returns {Promise<number>} 0 或 1。
   */
  async askForBlock(source, target, context) {
    if (!context.canBlock || context.amount <= 0) return 0;
    return (await this.requestCardResponse(target, "block", { source, target, ...context })) ? 1 : 0;
  }

  /**
   * 依座位顺序询问施牌者的敌人是否反制。首个成功响应立即终止，不实现反制的反反制。
   * @returns {Promise<boolean>} 战术牌是否被取消。
   */
  async askForCounter(source, card, targets) {
    if (card.category !== "tactic") return false;
    const responders = this.game.state.players.filter((player) => player.alive && player.id !== source.id && player.battleTeam !== source.battleTeam);
    for (const responder of responders) {
      if (await this.requestCardResponse(responder, "counter", { source, target: targets[0] ?? null, card })) return true;
    }
    return false;
  }

  /**
   * 询问单体目标是否使用转移，并返回替换后的目标。仅处理标记 canBeRedirected 的战术牌。
   * @returns {Promise<Player>} 原目标或新目标。
   */
  async askForRedirect(source, target, card) {
    if (!card.canBeRedirected || !target?.alive) return target;
    const alternatives = RuleEngine.getCardTargets(this.game, source, card).filter((player) => player.id !== target.id && player.id !== source.id);
    if (!alternatives.length || !target.findCard("redirect")) return target;
    const use = await this.requestCardResponse(target, "redirect", { source, target, card, alternatives });
    if (!use || this.game.state.isGameOver) return target;
    let redirected = null;
    if (target.controllerType === "human") {
      redirected = await this.game.ui.requestTarget(alternatives, `选择${card.name}的新目标`);
    } else {
      redirected = this.game.aiController.chooseRedirectTarget(target, alternatives, source);
    }
    if (!redirected?.alive || !alternatives.includes(redirected)) return target;
    this.game.log(`${target.name}将${card.name}转移给了${redirected.name}。`, "important");
    return redirected;
  }

  /** 移除一个请求并刷新状态；同一 ID 再次完成不会产生效果。 */
  finishRequest(requestId) {
    this.activeRequestIds.delete(requestId);
    this.game.state.pendingResponses = this.game.state.pendingResponses.filter((request) => request.id !== requestId);
    Debug.log("Response", `结束 ${requestId}`);
  }

  /** 使所有旧请求失效；对局销毁时调用。 */
  cleanup() {
    this.activeRequestIds.clear();
    this.game.state.pendingResponses = [];
  }
}
