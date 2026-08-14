import { GAME_CONFIG } from "../config/gameConfig.js?build=20260814-spirit-medic-heal-economics";
import { createId } from "../utils/helpers.js?build=20260814-spirit-medic-heal-economics";
import { getAiDelay } from "../utils/aiTiming.js?build=20260814-spirit-medic-heal-economics";
import { RuleEngine } from "./RuleEngine.js?build=20260814-spirit-medic-heal-economics";

const RESPONSE_DEFINITION = Object.freeze({ block:"block", counter:"counter" });

export const RESPONSE_STATUS = Object.freeze({
  USED:"used",
  DECLINED:"declined",
  CANCELLED:"cancelled",
  UNAVAILABLE:"unavailable",
  INVALID:"invalid"
});

const responseResult = (status, payload = {}) => Object.freeze({ status, ...payload });
export const isCancelledResponse = (result) => result?.status === RESPONSE_STATUS.CANCELLED;

function normalizeDecision(decision) {
  if (decision?.status === RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.USED, { cardId:decision.cardId ?? null });
  if (decision?.status === RESPONSE_STATUS.CANCELLED) return responseResult(RESPONSE_STATUS.CANCELLED);
  if (decision?.status === RESPONSE_STATUS.DECLINED) return responseResult(RESPONSE_STATUS.DECLINED);
  return responseResult(decision ? RESPONSE_STATUS.USED : RESPONSE_STATUS.DECLINED);
}

const responsePlayerName = (responder, player) => player?.id === responder?.id ? "你" : (player?.name ?? "未知角色");
const publicPlayerName = (responder, playerId, playerName) => playerId === responder?.id ? "你" : (playerName ?? "未知角色");
const publicPlayerContext = (player) => player ? Object.freeze({
  id:player.id,
  name:player.name,
  controllerType:player.controllerType,
  battleTeam:player.battleTeam,
  hp:player.hp,
  maxHp:player.maxHp,
  shield:player.shield,
  energy:player.energy,
  alive:player.alive
}) : null;

function responseTargetName(responder, context = {}) {
  if (context.targetLabel) return context.targetLabel;
  const targets = (context.targets ?? []).filter(Boolean);
  if (targets.length) return targets.map((target) => responsePlayerName(responder, target)).join("、");
  return context.target ? responsePlayerName(responder, context.target) : "";
}

const textFragment = (text) => Object.freeze({ type:"text", text:String(text) });

const playerFragment = (player, text, battleTeam) => {
  if (!player?.id) return textFragment(text ?? "未知角色");
  return Object.freeze({
    type:"player",
    text:String(text ?? player.name ?? "未知角色"),
    playerId:player.id,
    battleTeam:battleTeam ?? player.battleTeam
  });
};

/** 返回目标角色的展示片段；与 responseTargetName 使用同一数据源，不解析 eventText。 */
function responseTargetFragments(responder, context = {}) {
  if (context.targetLabel) return [textFragment(context.targetLabel)];
  const targets = (context.targets ?? []).filter(Boolean);
  const list = targets.length ? targets : (context.target ? [context.target] : []);
  const fragments = [];
  list.forEach((target, index) => {
    if (index > 0) fragments.push(textFragment("、"));
    const display = responsePlayerName(responder, target);
    fragments.push(display === "你" ? textFragment("你") : playerFragment(target, display));
  });
  return fragments;
}

/** 延迟状态事件只以当前状态持有者和状态本身为主体，不借用普通出牌 source。 */
function delayedStatusEventFragments(responder, context = {}) {
  const delayedStatus = context.delayedStatusContext ?? (context.statusCounterContext
    ? {
        ownerId:context.statusCounterContext.holderId,
        ownerName:context.statusCounterContext.holderName,
        ownerBattleTeam:context.statusCounterContext.holderBattleTeam,
        statusId:context.statusCounterContext.statusId,
        statusName:context.statusCounterContext.statusName,
        event:"beforeJudgment"
      }
    : null);
  if (!delayedStatus) return null;
  const ownerDisplay = publicPlayerName(
    responder, delayedStatus.ownerId, delayedStatus.ownerName
  );
  const ownerFragment = ownerDisplay === "你"
    ? textFragment("你的")
    : playerFragment(
        { id:delayedStatus.ownerId, name:delayedStatus.ownerName },
        `${delayedStatus.ownerName}的`,
        delayedStatus.ownerBattleTeam
      );
  const eventSuffix = delayedStatus.event === "judgmentSuccess"
    ? delayedStatus.statusId === "lightning"
      ? "判定成功，被「闪电」击中。"
      : "判定成功。"
    : delayedStatus.event === "judgmentFailure"
      ? "判定未生效。"
      : "即将判定。";
  return [ownerFragment, textFragment(`「${delayedStatus.statusName}」${eventSuffix}`)];
}

/** 只包含公开名称与数量的响应展示数据；UI 不接收任何隐藏牌内容。 */
export function buildResponsePresentation(responder, type, context = {}, requiredCount = 1, availableCount = 0, fallbackLabel = "响应") {
  const actionName = context.card?.name ?? context.actionName ?? "伤害";
  let eventFragments = delayedStatusEventFragments(responder, context);
  let sourceFragment = null;
  if (!eventFragments) {
    const sourceName = responsePlayerName(responder, context.source);
    sourceFragment = sourceName === "你"
      ? textFragment("你")
      : playerFragment(context.source, sourceName);
    eventFragments = [sourceFragment];
    if (context.card?.targetType !== "self") {
      const targetFragments = responseTargetFragments(responder, context);
      if (targetFragments.length) {
        eventFragments.push(textFragment("对"));
        eventFragments.push(...targetFragments);
      }
    }
    eventFragments.push(textFragment(`使用了「${actionName}」。`));
  }
  let responseText = `你可以进行${fallbackLabel}。`;
  let responseCardName = fallbackLabel;
  let buttonLabel = fallbackLabel;

  if (type === "block") {
    responseCardName = "格挡";
    buttonLabel = requiredCount > 1 ? `使用${requiredCount}张「格挡」` : "格挡";
    responseText = `你需要打出${requiredCount}张「格挡」。`;
  } else if (type === "counter") {
    responseCardName = "反制";
    buttonLabel = "反制";
    if (context.statusCounterContext) {
      const statusCounter = context.statusCounterContext;
      const statusName = statusCounter.statusName;
      if (statusCounter.counterOutcome === "cancel") {
        responseText = `是否使用「反制」，取消本次判定并解除「${statusName}」？`;
      } else {
        responseText = `是否使用「反制」，取消本次判定并转移「${statusName}」？`;
      }
    } else if (context.card?.definitionId === "transfer" && context.publicTransferContext) {
      const transfer = context.publicTransferContext;
      const fromDisplay = publicPlayerName(responder, transfer.fromPlayerId, transfer.fromName);
      const receiverDisplay = publicPlayerName(responder, transfer.receiverPlayerId, transfer.receiverName);
      eventFragments = [
        sourceFragment,
        textFragment("准备将"),
        fromDisplay === "你"
          ? textFragment("你")
          : playerFragment({ id:transfer.fromPlayerId, name:transfer.fromName }, transfer.fromName, transfer.fromBattleTeam),
        textFragment(`的${transfer.safeItemLabel}转移给`),
        receiverDisplay === "你"
          ? textFragment("你")
          : playerFragment({ id:transfer.receiverPlayerId, name:transfer.receiverName }, transfer.receiverName, transfer.receiverBattleTeam),
        textFragment("。")
      ];
      responseText = "你可以使用「反制」取消这次转移。";
    } else if (context.card?.definitionId === "counter" && context.counteredCardName) {
      eventFragments = [
        sourceFragment,
        textFragment("对"),
        ...responseTargetFragments(responder, context),
        textFragment(`打出的「${context.counteredCardName}」使用了「反制」。`)
      ];
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
      eventFragments = [
        sourceFragment,
        textFragment("向"),
        ...responseTargetFragments(responder, context),
        textFragment("发起了「决斗」。")
      ];
      responseText = "现在轮到你打出1张「突袭」。";
    } else {
      responseText = "你需要打出1张「突袭」。";
    }
  } else if (type === "leverageAssault") {
    responseCardName = "突袭";
    buttonLabel = "使用「突袭」";
    eventFragments = [
      sourceFragment,
      textFragment("对你使用了「借势」，要求你对"),
      ...responseTargetFragments(responder, context),
      textFragment("使用「突袭」。")
    ];
    responseText = `你可以使用1张「突袭」；若拒绝，对方将获得你的「${context.equipment?.name ?? "指定装备"}」。`;
  } else if (type === "dyingRescue") {
    responseCardName = "调息";
    buttonLabel = "使用「调息」";
    eventFragments = [
      ...responseTargetFragments(responder, context),
      textFragment("已进入濒死状态。")
    ];
    responseText = "现在轮到你使用「调息」进行救援。";
  } else if (type === "skill") {
    responseCardName = context.responseName ?? fallbackLabel;
    buttonLabel = context.buttonLabel ?? fallbackLabel;
    responseText = `你可以发动「${responseCardName}」。`;
  }

  let availabilityText = "";
  if (requiredCount > 0) {
    if (responseCardName === "反制" && availableCount === 0) {
      availabilityText = "你没有可用的「反制」，只能放弃响应。";
    } else if (availableCount < requiredCount) {
      const heldText = availableCount > 0 ? `只有${availableCount}张` : "没有";
      const unavailableAction = type === "block" ? "格挡"
        : type === "dyingRescue" ? "救援"
          : type === "assaultDiscard" || type === "leverageAssault" ? "使用「突袭」" : "完成响应";
      availabilityText = `需要${requiredCount}张「${responseCardName}」，你当前${heldText}，无法${unavailableAction}。`;
    } else {
      availabilityText = `需要${requiredCount}张「${responseCardName}」，当前有${availableCount}张。`;
    }
  }
  const eventText = eventFragments.map((fragment) => fragment.text).join("");
  return Object.freeze({
    eventText,
    eventFragments:Object.freeze(eventFragments.map((fragment) => Object.freeze(fragment))),
    responseText, availabilityText, responseCardName, buttonLabel, requiredCount, availableCount
  });
}

/** 卡牌响应、强制弃置和濒死救援的可清理异步入口。 */
export class ResponseSystem {
  constructor(game) { this.game = game; this.activeRequestIds = new Set(); }

  async waitForDecision(responder, request, label, context, cards) {
    const gameId = this.game.state.gameId;
    if (responder.controllerType === "human") {
      const decision = normalizeDecision(await this.game.ui.requestResponse(request, label));
      return this.game.isSessionValid(gameId) ? decision : responseResult(RESPONSE_STATUS.CANCELLED);
    }
    this.game.ui.setThinking(true, responder, `正在考虑是否${label}`);
    const waited = await this.game.cleanupManager.delay(getAiDelay(this.game, "response"));
    if (!waited || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
    let use = false;
    use = this.game.aiController.responsePolicy.shouldRespond(responder, request.type, context, cards);
    this.game.ui.setThinking(false);
    // 借势的所有拒绝原因只在最终结算处统一公开，不能用中间提示暴露 AI 手牌。
    if (!use && request.type !== "leverageAssault") this.game.ui.setPrompt(`${responder.name}放弃${label}。`);
    return responseResult(use ? RESPONSE_STATUS.USED : RESPONSE_STATUS.DECLINED);
  }

  async requestCardResponse(responder, type, context, requiredCount = 1) {
    const gameId = this.game.state.gameId;
    const definitionId = RESPONSE_DEFINITION[type];
    const availableCards = responder.hand.filter((card) => card.definitionId === definitionId);
    const cardsToUse = availableCards.slice(0, requiredCount);
    if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    if (!responder.alive || this.game.state.isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    // 规则轮到真人响应时始终显示窗口；AI 没牌仍立即跳过。
    if (availableCards.length < requiredCount && responder.controllerType !== "human") return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    const fallbackLabel = type === "block" ? (requiredCount === 2 ? "使用2张「格挡」" : "格挡") : "反制";
    const request = { id:createId("response"), type, sourcePlayerId:context.source?.id ?? null, targetPlayerId:responder.id,
      cardId:context.card?.id ?? null, legalCardIds:availableCards.map((card) => card.id), requiredCount,
      legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      presentation:buildResponsePresentation(responder, type, context, requiredCount, availableCards.length, fallbackLabel) };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    const label = request.presentation.buttonLabel;
    const decision = await this.waitForDecision(responder, request, label, context, availableCards);
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive &&
      cardsToUse.length === requiredCount && cardsToUse.every((card) => responder.hand.includes(card));
    this.finishRequest(request.id);
    if (isCancelledResponse(decision) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { cards:[] });
    if (!valid) return responseResult(RESPONSE_STATUS.INVALID, { cards:[] });
    const payment = await this.game.payCardsFromHandAtomically(
      responder,
      cardsToUse,
      `响应·${type === "block" ? "格挡" : "反制"}`,
      { silent:true, expectedCount:requiredCount }
    );
    if (payment.status === RESPONSE_STATUS.CANCELLED || !this.game.isSessionValid(gameId)) {
      return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    }
    if (payment.status !== RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.INVALID, { cards:[] });
    if (type === "counter") {
      const targetSuffix = context.targetScoped ? `（仅取消对${responder.name}的效果）` : "";
      const delayedStatus = context.delayedStatusContext;
      const counterTarget = delayedStatus
        ? `${delayedStatus.ownerName}的「${delayedStatus.statusName}」判定`
        : `「${context.card?.name ?? "战术牌"}」${targetSuffix}`;
      this.game.ui.setCurrentCard?.(cardsToUse[0], responder.name, `反制${counterTarget}`);
    } else {
      this.game.log(cardsToUse.length === 1
        ? `${responder.name}使用了「格挡」。`
        : `${responder.name}同时使用了${cardsToUse.length}张「格挡」。`, "important");
    }
    return responseResult(RESPONSE_STATUS.USED, { cards:cardsToUse });
  }

  async askForBlock(source, target, context) {
    if (!context.canBlock || context.amount <= 0) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    const isAssault = context.card?.subtypes?.includes("assault") && ["normal", "area"].includes(context.damageType);
    const required = isAssault && source?.equipment?.definitionId === "battleDevice" ? 2 : 1;
    return this.requestCardResponse(target, "block", { source, target, ...context }, required);
  }

  /** 响应牌只在整条反制链确认其最终生效后，才公开本次真实关联的存活角色。 */
  async emitResolvedCounterUse(responder, counterCard, relatedPlayers = []) {
    const seen = new Set();
    const effectiveTargets = [];
    for (const related of relatedPlayers) {
      const player = this.game.state.players.find((candidate) => candidate.id === related?.id);
      if (!player?.alive || seen.has(player.id)) continue;
      seen.add(player.id);
      effectiveTargets.push(player);
    }
    await this.game.eventBus.emit("cardUsed", {
      type:"cardUsed",
      source:responder,
      card:counterCard,
      targets:effectiveTargets,
      effectiveTargets,
      cancelled:false,
      resolved:true,
      resolutionId:createId("counter-resolution"),
      usageContext:"response"
    });
  }

  async askForCounter(source, card, targets, chainContext = {}) {
    const gameId = this.game.state.gameId;
    if (card.category !== "tactic" || !card.counterable) return responseResult(RESPONSE_STATUS.UNAVAILABLE);
    const responders = chainContext.responders ?? this.game.seatOrderFrom(source, false);
    // 反制链上下文：把 root card、root source 与当前深度透传给每一层的 AI 决策。
    // root=0 表示当前被反制的是 root 本身；每追加一层反制深度 +1。AI 按 depth 奇偶
    // 判断最终 root 生效/取消，再决定是否追加反制；这里只透传，不改变响应顺序、
    // 合法性或人类响应窗口。
    const rootCard = chainContext.rootCard ?? card;
    const rootSourceId = chainContext.rootSourceId ?? source.id;
    const counterDepth = chainContext.counterDepth ?? 0;
    // 首层 root 目标 = 根牌原始目标的 id 列表；嵌套层继续保留透传。rootTargetIds 描述
    // root 的目标（估值时从当前状态重新解析，可能已死亡/清空资源），与"当前被反制对象"
    // 是两个概念，不得混淆。
    const rootTargetIds = chainContext.rootTargetIds !== undefined
      ? chainContext.rootTargetIds
      : targets.map((target) => target?.id).filter(Boolean);
    for (const responder of responders) {
      if (!responder.alive || responder.id === source.id) continue;
      const publicSource = publicPlayerContext(source);
      const publicTargets = targets.map(publicPlayerContext).filter(Boolean);
      const publicTransferContext = chainContext.publicTransferContext ?? null;
      const enrichedTransferContext = publicTransferContext
        ? Object.freeze({
            ...publicTransferContext,
            fromBattleTeam:this.game.state.players.find((player) => player.id === publicTransferContext.fromPlayerId)?.battleTeam,
            receiverBattleTeam:this.game.state.players.find((player) => player.id === publicTransferContext.receiverPlayerId)?.battleTeam
          })
        : null;
      const response = await this.requestCardResponse(responder, "counter", {
        source:publicSource, target:publicTargets[0] ?? null, targets:publicTargets, card,
        counteredCardName:chainContext.targetCard?.name ?? null,
        targetScoped:Boolean(chainContext.targetScoped),
        publicTransferContext:enrichedTransferContext,
        publicSelectionContext:chainContext.publicSelectionContext ?? null,
        // root outcome 决策上下文：只读，供 AI 评价最终 root 结局，不影响展示与合法性。
        rootCard,
        rootSourceId,
        counterDepth,
        rootTargetIds
      }, 1);
      if (isCancelledResponse(response) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const [counterCard] = response.cards ?? [];
      if (response.status !== RESPONSE_STATUS.USED || !counterCard) continue;
      const cancelledTarget = chainContext.targetScoped
        ? `对${targets[0]?.name ?? responder.name}的效果`
        : "的效果";
      this.game.log(`${responder.name}对${source.name}的「${card.name}」使用了「反制」，取消了「${card.name}」${cancelledTarget}。`, "important");
      // 反制牌已经从手牌移入弃牌堆，因此递归链必然受实体牌数量限制，不会无限循环。
      // 嵌套层只透传 root outcome 链上下文（root card、root source、深度、root 目标）；
      // targetScoped、responders 等针对"当前被反制牌"的字段在本层即消费完毕，不向下一层泄漏。
      const counterWasCountered = await this.askForCounter(responder, counterCard, [source], {
        targetCard:card, rootCard, rootSourceId, counterDepth:counterDepth + 1, rootTargetIds
      });
      if (isCancelledResponse(counterWasCountered) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      if (counterWasCountered.status === RESPONSE_STATUS.USED) {
        return responseResult(RESPONSE_STATUS.DECLINED);
      }
      await this.emitResolvedCounterUse(
        responder, counterCard, [source, ...(chainContext.relatedTargets ?? targets)]
      );
      if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      return responseResult(RESPONSE_STATUS.USED, { card:counterCard });
    }
    return responseResult(RESPONSE_STATUS.DECLINED);
  }

  /**
   * 延迟战术状态判定前的独立反制窗口。响应者从当前状态持有者本人开始，再按顺时针询问其余存活玩家；
   * 反制成功则返回 USED，反制被反制或无人响应则返回 DECLINED。
   * 不构造虚构实体牌，也不走普通 askForCounter 的排除施放者逻辑。
   */
  async askForStatusCounter(holder, context = {}) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId) || !holder?.alive || this.game.state.isGameOver) return responseResult(RESPONSE_STATUS.DECLINED);
    const statusName = context.statusName;
    const responders = [holder, ...this.game.seatOrderFrom(holder, false)].filter((player) => player.alive);
    for (const responder of responders) {
      if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const delayedStatusContext = Object.freeze({
        ownerId:holder.id,
        ownerName:holder.name,
        ownerBattleTeam:holder.battleTeam,
        statusId:context.statusId,
        statusName,
        event:"beforeJudgment"
      });
      const response = await this.requestCardResponse(responder, "counter", {
        source:null,
        target:null,
        targets:[],
        card:null,
        delayedStatusContext,
        statusCounterContext:{
          holderId:holder.id,
          holderName:holder.name,
          holderBattleTeam:holder.battleTeam,
          statusId:context.statusId,
          statusName,
          counterOutcome:context.counterOutcome,
          originPlayerId:context.originPlayerId ?? null
        }
      }, 1);
      if (isCancelledResponse(response) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const [counterCard] = response.cards ?? [];
      if (response.status !== RESPONSE_STATUS.USED || !counterCard) continue;
      this.game.log(`${responder.name}对${holder.name}的「${statusName}」使用了「反制」。`, "important");
      const counterWasCountered = await this.askForCounter(responder, counterCard, [holder], { targetCard:null, statusCounterChain:true });
      if (isCancelledResponse(counterWasCountered) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      if (counterWasCountered.status === RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.DECLINED);
      await this.emitResolvedCounterUse(responder, counterCard, [holder]);
      if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      return responseResult(RESPONSE_STATUS.USED, { card:counterCard });
    }
    return responseResult(RESPONSE_STATUS.DECLINED);
  }

  async requestDyingRescue(rescuer, target, card) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!rescuer?.alive || !target?.alive || target.hp > 0 || rescuer.battleTeam !== target.battleTeam ||
      this.game.state.isGameOver) return responseResult(this.game.state.isDisposed ? RESPONSE_STATUS.CANCELLED : RESPONSE_STATUS.UNAVAILABLE, { card:null });
    const availableCards = rescuer.hand.filter((entry) => entry.definitionId === "recover");
    const legalCard = card?.definitionId === "recover" && rescuer.hand.includes(card) ? card : (availableCards[0] ?? null);
    if (!availableCards.length && rescuer.controllerType !== "human") return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    const request = { id:createId("dying-response"), type:"dyingRescue", sourcePlayerId:rescuer.id, targetPlayerId:target.id,
      cardId:null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1, legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      need:1 - target.hp, currentHp:target.hp,
      presentation:buildResponsePresentation(rescuer, "dyingRescue", { target }, 1, availableCards.length, "使用「调息」") };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    let decision;
    const aiSelfRescue = rescuer.controllerType === "ai" && rescuer.id === target.id;
    const forcedHumanRescue =
      (this.game.forceAiRescueHuman ?? GAME_CONFIG.forceAiRescueHuman) &&
      rescuer.controllerType === "ai" &&
      target.controllerType === "human" &&
      rescuer.id !== target.id &&
      rescuer.battleTeam === target.battleTeam;

    if (aiSelfRescue) {
      decision = responseResult(RESPONSE_STATUS.USED);
    } else if (forcedHumanRescue) {
      this.game.ui.setThinking(true, rescuer, `正在准备救援${target.name}`);
      const waited = await this.game.cleanupManager.delay(getAiDelay(this.game, "response"));
      this.game.ui.setThinking(false);
      if (!waited) {
        this.finishRequest(request.id);
        return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
      }
      // 强制队友规则在等待结束后固定使用调息，不进入 AI 效用评分。
      decision = responseResult(RESPONSE_STATUS.USED);
    } else {
      decision = await this.waitForDecision(rescuer, request, request.presentation.buttonLabel, { target, source:rescuer, card:legalCard }, availableCards);
    }
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) &&
      rescuer.alive && target.alive && target.hp <= 0 &&
      rescuer.battleTeam === target.battleTeam && legalCard && rescuer.hand.includes(legalCard);
    this.finishRequest(request.id);
    if (isCancelledResponse(decision) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { card:null });
    if (!valid) return responseResult(RESPONSE_STATUS.INVALID, { card:null });
    const payment = await this.game.payCardsFromHandAtomically(
      rescuer, [legalCard], `救援${target.name}`, { silent:true, expectedCount:1 }
    );
    if (payment.status === RESPONSE_STATUS.CANCELLED || !this.game.isSessionValid(gameId)) {
      return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    }
    return payment.status === RESPONSE_STATUS.USED
      ? responseResult(RESPONSE_STATUS.USED, { card:legalCard })
      : responseResult(RESPONSE_STATUS.INVALID, { card:null });
  }

  async requestAssaultDiscard(responder, reason, context = {}) {
    const gameId = this.game.state.gameId;
    const availableCards = responder.hand.filter((entry) => entry.definitionId === "assault");
    const cardToUse = availableCards[0] ?? null;
    if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!responder.alive || this.game.state.isGameOver || (!availableCards.length && responder.controllerType !== "human")) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    const presentation = buildResponsePresentation(responder, "assaultDiscard", context, 1, availableCards.length, reason);
    const request = { id:createId("assault-discard"), type:"assaultDiscard", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1,
      legalSkillIds:[], timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true, presentation };
    this.activeRequestIds.add(request.id); this.game.state.pendingResponses.push(request);
    const decision = await this.waitForDecision(responder, request, presentation.buttonLabel, context, availableCards);
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive && cardToUse && responder.hand.includes(cardToUse);
    this.finishRequest(request.id);
    if (isCancelledResponse(decision) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { card:null });
    if (!valid) return responseResult(RESPONSE_STATUS.INVALID, { card:null });
    const payment = await this.game.payCardsFromHandAtomically(
      responder, [cardToUse], reason, { silent:true, expectedCount:1 }
    );
    if (payment.status === RESPONSE_STATUS.CANCELLED || !this.game.isSessionValid(gameId)) {
      return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    }
    if (payment.status !== RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.INVALID, { card:null });
    if (context.card?.definitionId === "duel") {
      this.game.log(`${responder.name}在决斗中打出了「突袭」。`, "important");
    } else if (context.card?.definitionId === "provoke") {
      this.game.log(`${responder.name}打出了「突袭」回应挑衅。`, "important");
    } else {
      this.game.log(`${responder.name}打出了「突袭」。`, "important");
    }
    return responseResult(RESPONSE_STATUS.USED, { card:cardToUse });
  }

  /**
   * 借势响应不在这里消费牌：确认后返回同一实体，由 Game.playCard 进入普通突袭
   * 完整流程。真人没有合法突袭时不创建窗口；AI 仍经过相同思考等待，避免手牌侧信道。
   */
  async requestLeverageAssault(responder, target, context = {}) {
    const gameId = this.game.state.gameId;
    const availableCards = RuleEngine.getUsableAssaultCards(this.game, responder, target);
    if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!responder?.alive || !target?.alive || this.game.state.isGameOver) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    if (!availableCards.length && responder.controllerType === "human") {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const presentation = {
      ...buildResponsePresentation(responder, "leverageAssault", { ...context, target }, 1, availableCards.length, "使用「突袭」"),
      declineLabel:"拒绝"
    };
    const request = {
      id:createId("leverage-assault"),
      type:"leverageAssault",
      sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id,
      forcedTargetPlayerId:target.id,
      cardId:context.card?.id ?? null,
      legalCardIds:availableCards.map((entry) => entry.id),
      requiredCount:1,
      legalSkillIds:[],
      timeoutMs:GAME_CONFIG.responseTimeoutMs,
      allowDecline:true,
      presentation
    };
    this.activeRequestIds.add(request.id);
    this.game.state.pendingResponses.push(request);
    const decision = await this.waitForDecision(responder, request, presentation.buttonLabel, { ...context, target }, availableCards);
    const selectedId = responder.controllerType === "human"
      ? (decision.cardId ?? availableCards[0]?.id)
      : availableCards[0]?.id;
    const selectedCard = availableCards.find((entry) => entry.id === selectedId) ?? null;
    const valid = this.activeRequestIds.has(request.id)
      && this.game.isSessionValid(gameId)
      && selectedCard
      && RuleEngine.canUseForcedAssault(this.game, responder, selectedCard, target).ok;
    this.finishRequest(request.id);
    if (isCancelledResponse(decision) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { card:null });
    return valid
      ? responseResult(RESPONSE_STATUS.USED, { card:selectedCard })
      : responseResult(RESPONSE_STATUS.INVALID, { card:null });
  }

  async requestSkillResponse(responder, skillId, responseName, context) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
    if (!responder.alive || this.game.state.isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE);
    const buttonLabel = `发动「${responseName}」`;
    const request = { id:createId("skill-response"), type:"skill", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:[], legalSkillIds:[skillId],
      requiredCount:0, timeoutMs:GAME_CONFIG.responseTimeoutMs, allowDecline:true,
      presentation:buildResponsePresentation(responder, "skill", { ...context, responseName, buttonLabel }, 0, 0, buttonLabel) };
    this.activeRequestIds.add(request.id); this.game.state.pendingResponses.push(request);
    const decision = await this.waitForDecision(responder, request, buttonLabel, context, []);
    const valid = this.activeRequestIds.has(request.id) && this.game.isSessionValid(gameId) && responder.alive;
    this.finishRequest(request.id);
    if (isCancelledResponse(decision) || !this.game.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status);
    return responseResult(valid ? RESPONSE_STATUS.USED : RESPONSE_STATUS.INVALID);
  }

  finishRequest(id) {
    this.activeRequestIds.delete(id);
    if (!this.game.state.isDisposed) this.game.state.pendingResponses = this.game.state.pendingResponses.filter((request) => request.id !== id);
  }
  cleanup() { this.activeRequestIds.clear(); this.game.state.pendingResponses = []; }
}
