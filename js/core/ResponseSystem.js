import { GAME_CONFIG } from "../config/gameConfig.js";
import { createId } from "../utils/helpers.js";
import { getAiDelay } from "../utils/aiTiming.js";

const RESPONSE_DEFINITION = Object.freeze({ block:"block", counter:"counter" });

/** 卡牌响应、强制弃置和濒死救援的可清理异步入口。 */
export class ResponseSystem {
  constructor(game) { this.game = game; this.activeRequestIds = new Set(); }

  async waitForDecision(responder, request, label, context, cards) {
    if (responder.controllerType === "human") return Boolean(await this.game.ui.requestResponse(request, label));
    this.game.ui.setThinking(true, responder, `正在考虑是否${label}`);
    const waited = await this.game.cleanupManager.delay(getAiDelay(this.game, "response"));
    let use = false;
    if (waited) use = this.game.aiController.responsePolicy.shouldRespond(responder, request.type, context, cards);
    this.game.ui.setThinking(false);
    if (waited && !use) this.game.ui.setPrompt(`${responder.name}放弃${label}。`);
    return waited && use;
  }

  async requestCardResponse(responder, type, context, requiredCount = 1) {
    const gameId = this.game.state.gameId;
    const definitionId = RESPONSE_DEFINITION[type];
    const cards = responder.hand.filter((card) => card.definitionId === definitionId).slice(0, requiredCount);
    if (cards.length < requiredCount || !responder.alive || this.game.state.isGameOver) return [];
    const request = { id:createId("response"), type, sourcePlayerId:context.source?.id ?? null, targetPlayerId:responder.id,
      cardId:context.card?.id ?? null, legalCardIds:cards.map((card) => card.id), requiredCount,
      legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    const label = type === "block" ? (requiredCount === 2 ? "使用2张格挡" : "格挡") : "反制";
    const use = await this.waitForDecision(responder, request, label, context, cards);
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive && cards.every((card) => responder.hand.includes(card));
    this.finishRequest(request.id);
    if (!use || !valid) return [];
    for (const card of cards) await this.game.discardCardFromHand(responder, card, `响应·${card.name}`);
    if (type === "counter") {
      this.game.ui.setCurrentCard?.(cards[0], responder.name, `反制「${context.card?.name ?? "战术牌"}」`);
      this.game.log(`${responder.name}使用了「反制」，作用对象：「${context.card?.name ?? "战术牌"}」。`, "important");
    } else {
      this.game.log(`${responder.name}同时使用${cards.length}张格挡。`, "important");
    }
    return cards;
  }

  async askForBlock(source, target, context) {
    if (!context.canBlock || context.amount <= 0) return false;
    const isAssault = context.card?.subtypes?.includes("assault") && ["normal", "area"].includes(context.damageType);
    const required = isAssault && source?.equipment?.definitionId === "battleDevice" ? 2 : 1;
    const cards = await this.requestCardResponse(target, "block", { source, target, ...context }, required);
    return cards.length === required;
  }

  async askForCounter(source, card, targets) {
    if (card.category !== "tactic" || !card.counterable) return false;
    for (const responder of this.game.seatOrderFrom(source, false)) {
      if (!responder.alive || responder.id === source.id) continue;
      const [counterCard] = await this.requestCardResponse(responder, "counter", { source, target:targets[0] ?? null, card }, 1);
      if (!counterCard) continue;
      // 反制牌已经从手牌移入弃牌堆，因此递归链必然受实体牌数量限制，不会无限循环。
      const counterWasCountered = await this.askForCounter(responder, counterCard, [source]);
      if (counterWasCountered) {
        this.game.log(`${responder.name}的「反制」被后续反制抵消。`, "important");
        return false;
      }
      return true;
    }
    return false;
  }

  async requestDyingRescue(rescuer, target, card) {
    if (!rescuer?.alive || !target?.alive || target.hp > 0 || rescuer.battleTeam !== target.battleTeam ||
      !rescuer.hand.includes(card) || card.definitionId !== "recover") return null;
    const gameId = this.game.state.gameId;
    const request = { id:createId("dying-response"), type:"dyingRescue", sourcePlayerId:rescuer.id, targetPlayerId:target.id,
      cardId:null, legalCardIds:[card.id], requiredCount:1, legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      need:1 - target.hp, currentHp:target.hp };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    let use;
    const aiSelfRescue = rescuer.controllerType === "ai" && rescuer.id === target.id;
    const forcedHumanRescue =
      (this.game.forceAiRescueHuman ?? GAME_CONFIG.forceAiRescueHuman) &&
      rescuer.controllerType === "ai" &&
      target.controllerType === "human" &&
      rescuer.id !== target.id &&
      rescuer.battleTeam === target.battleTeam;

    if (aiSelfRescue) {
      use = true;
    } else if (forcedHumanRescue) {
      this.game.ui.setThinking(true, rescuer, `正在准备救援${target.name}`);
      const waited = await this.game.cleanupManager.delay(getAiDelay(this.game, "response"));
      this.game.ui.setThinking(false);
      if (!waited) {
        this.finishRequest(request.id);
        return null;
      }
      // 强制队友规则在等待结束后固定使用调息，不进入 AI 效用评分。
      use = true;
    } else {
      use = await this.waitForDecision(rescuer, request, `用调息救援${target.name}`, { target, source:rescuer, card }, [card]);
    }
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) &&
      rescuer.alive && target.alive && target.hp <= 0 &&
      rescuer.battleTeam === target.battleTeam && rescuer.hand.includes(card);
    this.finishRequest(request.id);
    if (!use || !valid) return null;
    await this.game.discardCardFromHand(rescuer, card, `救援${target.name}`);
    return card;
  }

  async requestAssaultDiscard(responder, reason, context = {}) {
    const card = responder.hand.find((entry) => entry.definitionId === "assault");
    if (!card || !responder.alive) return null;
    const request = { id:createId("assault-discard"), type:"assaultDiscard", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:[card.id], requiredCount:1,
      legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true };
    this.activeRequestIds.add(request.id); this.game.state.pendingResponses.push(request);
    const use = await this.waitForDecision(responder, request, reason, context, [card]);
    const valid = this.activeRequestIds.has(request.id) && responder.alive && responder.hand.includes(card);
    this.finishRequest(request.id);
    if (!use || !valid) return null;
    await this.game.discardCardFromHand(responder, card, reason);
    return card;
  }

  async requestSkillResponse(responder, skillId, label, context) {
    if (!responder.alive || this.game.state.isGameOver) return false;
    const request = { id:createId("skill-response"), type:"skill", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:[], legalSkillIds:[skillId],
      requiredCount:0, timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true };
    this.activeRequestIds.add(request.id); this.game.state.pendingResponses.push(request);
    const use = await this.waitForDecision(responder, request, label, context, []);
    const valid = this.activeRequestIds.has(request.id) && responder.alive;
    this.finishRequest(request.id);
    return use && valid;
  }

  finishRequest(id) {
    this.activeRequestIds.delete(id);
    this.game.state.pendingResponses = this.game.state.pendingResponses.filter((request) => request.id !== id);
  }
  cleanup() { this.activeRequestIds.clear(); this.game.state.pendingResponses = []; }
}
