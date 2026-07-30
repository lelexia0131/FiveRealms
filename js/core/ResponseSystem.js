import { GAME_CONFIG } from "../config/gameConfig.js?build=20260730-tabletop-hands-v25";
import { createId } from "../utils/helpers.js?build=20260730-tabletop-hands-v25";
import { getAiDelay } from "../utils/aiTiming.js?build=20260730-tabletop-hands-v25";

const RESPONSE_DEFINITION = Object.freeze({ block:"block", counter:"counter" });

const responsePlayerName = (responder, player) => player?.id === responder?.id ? "你" : (player?.name ?? "未知角色");

function responseTargetName(responder, context = {}) {
  if (context.targetLabel) return context.targetLabel;
  const targets = (context.targets ?? []).filter(Boolean);
  if (targets.length) return targets.map((target) => responsePlayerName(responder, target)).join("、");
  return context.target ? responsePlayerName(responder, context.target) : "";
}

/** 只包含公开名称与数量的响应展示数据；UI 不接收任何隐藏牌内容。 */
export function buildResponsePresentation(responder, type, context = {}, requiredCount = 1, availableCount = 0, fallbackLabel = "响应") {
  const sourceName = responsePlayerName(responder, context.source);
  const targetName = responseTargetName(responder, context);
  const actionName = context.card?.name ?? context.actionName ?? "伤害";
  let eventText = targetName
    ? `${sourceName}对${targetName}使用了「${actionName}」。`
    : `${sourceName}使用了「${actionName}」。`;
  let responseText = `你可以进行${fallbackLabel}。`;
  let responseCardName = fallbackLabel;
  let buttonLabel = fallbackLabel;

  if (type === "block") {
    responseCardName = "格挡";
    buttonLabel = requiredCount > 1 ? `使用${requiredCount}张格挡` : "格挡";
    responseText = `你需要打出 ${requiredCount} 张格挡。`;
  } else if (type === "counter") {
    responseCardName = "反制";
    buttonLabel = "反制";
    if (context.card?.definitionId === "counter" && context.counteredCardName) {
      eventText = `${sourceName}对${targetName}打出的「${context.counteredCardName}」使用了「反制」。`;
      responseText = "你可以继续使用「反制」。";
    } else {
      responseText = context.targetScoped
        ? `你可以使用「反制」，仅取消「${actionName}」对你的效果；其他目标仍会继续结算。`
        : "你可以使用「反制」。";
    }
  } else if (type === "assaultDiscard") {
    responseCardName = "突袭";
    buttonLabel = "打出突袭";
    if (context.card?.definitionId === "duel") {
      eventText = `${sourceName}向${targetName}发起了「决斗」。`;
      responseText = "现在轮到你打出 1 张突袭。";
    } else {
      responseText = "你需要打出 1 张突袭。";
    }
  } else if (type === "dyingRescue") {
    responseCardName = "调息";
    buttonLabel = "使用调息";
    eventText = `${responsePlayerName(responder, context.target)}已进入濒死状态。`;
    responseText = "现在轮到你使用「调息」进行救援。";
  } else if (type === "skill") {
    responseCardName = context.responseName ?? fallbackLabel;
    buttonLabel = context.buttonLabel ?? fallbackLabel;
    responseText = `你可以发动「${responseCardName}」。`;
  }

  let availabilityText = "";
  if (requiredCount > 0) {
    if (responseCardName === "反制" && availableCount === 0) availabilityText = "你当前没有反制，但仍可查看并放弃响应。";
    else {
      availabilityText = `需要 ${requiredCount} 张${responseCardName}，当前 ${availableCount} 张`;
      availabilityText += availableCount < requiredCount ? "；当前数量不足，你仍可查看并放弃响应。" : "。";
    }
  }
  return Object.freeze({ eventText, responseText, availabilityText, responseCardName, buttonLabel, requiredCount, availableCount });
}

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
    const availableCards = responder.hand.filter((card) => card.definitionId === definitionId);
    const cardsToUse = availableCards.slice(0, requiredCount);
    if (!responder.alive || this.game.state.isGameOver) return [];
    // 规则轮到真人响应时始终显示窗口；AI 没牌仍立即跳过。
    if (availableCards.length < requiredCount && responder.controllerType !== "human") return [];
    const fallbackLabel = type === "block" ? (requiredCount === 2 ? "使用2张格挡" : "格挡") : "反制";
    const request = { id:createId("response"), type, sourcePlayerId:context.source?.id ?? null, targetPlayerId:responder.id,
      cardId:context.card?.id ?? null, legalCardIds:availableCards.map((card) => card.id), requiredCount,
      legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      presentation:buildResponsePresentation(responder, type, context, requiredCount, availableCards.length, fallbackLabel) };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    const label = request.presentation.buttonLabel;
    const use = await this.waitForDecision(responder, request, label, context, availableCards);
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive &&
      cardsToUse.length === requiredCount && cardsToUse.every((card) => responder.hand.includes(card));
    this.finishRequest(request.id);
    if (!use || !valid) return [];
    for (const card of cardsToUse) await this.game.discardCardFromHand(responder, card, `响应·${card.name}`);
    if (type === "counter") {
      const targetSuffix = context.targetScoped ? `（仅取消对${responder.name}的效果）` : "";
      this.game.ui.setCurrentCard?.(cardsToUse[0], responder.name, `反制「${context.card?.name ?? "战术牌"}」${targetSuffix}`);
      this.game.log(`${responder.name}使用了「反制」，作用对象：「${context.card?.name ?? "战术牌"}」${targetSuffix}。`, "important");
    } else {
      this.game.log(`${responder.name}同时使用${cardsToUse.length}张格挡。`, "important");
    }
    return cardsToUse;
  }

  async askForBlock(source, target, context) {
    if (!context.canBlock || context.amount <= 0) return false;
    const isAssault = context.card?.subtypes?.includes("assault") && ["normal", "area"].includes(context.damageType);
    const required = isAssault && source?.equipment?.definitionId === "battleDevice" ? 2 : 1;
    const cards = await this.requestCardResponse(target, "block", { source, target, ...context }, required);
    return cards.length === required;
  }

  async askForCounter(source, card, targets, chainContext = {}) {
    if (card.category !== "tactic" || !card.counterable) return false;
    const responders = chainContext.responders ?? this.game.seatOrderFrom(source, false);
    for (const responder of responders) {
      if (!responder.alive || responder.id === source.id) continue;
      const [counterCard] = await this.requestCardResponse(responder, "counter", {
        source, target:targets[0] ?? null, targets, card,
        counteredCardName:chainContext.targetCard?.name ?? null,
        targetScoped:Boolean(chainContext.targetScoped)
      }, 1);
      if (!counterCard) continue;
      // 反制牌已经从手牌移入弃牌堆，因此递归链必然受实体牌数量限制，不会无限循环。
      const counterWasCountered = await this.askForCounter(responder, counterCard, [source], { targetCard:card });
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
      this.game.state.isGameOver) return null;
    const availableCards = rescuer.hand.filter((entry) => entry.definitionId === "recover");
    const legalCard = card?.definitionId === "recover" && rescuer.hand.includes(card) ? card : (availableCards[0] ?? null);
    if (!availableCards.length && rescuer.controllerType !== "human") return null;
    const gameId = this.game.state.gameId;
    const request = { id:createId("dying-response"), type:"dyingRescue", sourcePlayerId:rescuer.id, targetPlayerId:target.id,
      cardId:null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1, legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      need:1 - target.hp, currentHp:target.hp,
      presentation:buildResponsePresentation(rescuer, "dyingRescue", { target }, 1, availableCards.length, "使用调息") };
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
      use = await this.waitForDecision(rescuer, request, request.presentation.buttonLabel, { target, source:rescuer, card:legalCard }, availableCards);
    }
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) &&
      rescuer.alive && target.alive && target.hp <= 0 &&
      rescuer.battleTeam === target.battleTeam && legalCard && rescuer.hand.includes(legalCard);
    this.finishRequest(request.id);
    if (!use || !valid) return null;
    await this.game.discardCardFromHand(rescuer, legalCard, `救援${target.name}`);
    return legalCard;
  }

  async requestAssaultDiscard(responder, reason, context = {}) {
    const gameId = this.game.state.gameId;
    const availableCards = responder.hand.filter((entry) => entry.definitionId === "assault");
    const cardToUse = availableCards[0] ?? null;
    if (!responder.alive || this.game.state.isGameOver || (!availableCards.length && responder.controllerType !== "human")) return null;
    const presentation = buildResponsePresentation(responder, "assaultDiscard", context, 1, availableCards.length, reason);
    const request = { id:createId("assault-discard"), type:"assaultDiscard", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1,
      legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true, presentation };
    this.activeRequestIds.add(request.id); this.game.state.pendingResponses.push(request);
    const use = await this.waitForDecision(responder, request, presentation.buttonLabel, context, availableCards);
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive && cardToUse && responder.hand.includes(cardToUse);
    this.finishRequest(request.id);
    if (!use || !valid) return null;
    await this.game.discardCardFromHand(responder, cardToUse, reason);
    return cardToUse;
  }

  async requestSkillResponse(responder, skillId, responseName, context) {
    if (!responder.alive || this.game.state.isGameOver) return false;
    const buttonLabel = `发动${responseName}`;
    const request = { id:createId("skill-response"), type:"skill", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:[], legalSkillIds:[skillId],
      requiredCount:0, timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      presentation:buildResponsePresentation(responder, "skill", { ...context, responseName, buttonLabel }, 0, 0, buttonLabel) };
    this.activeRequestIds.add(request.id); this.game.state.pendingResponses.push(request);
    const use = await this.waitForDecision(responder, request, buttonLabel, context, []);
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
