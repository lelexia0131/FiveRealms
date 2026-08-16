/*
模块职责
拥有 Application Response Workflow：response window、responder iteration、block/counter/nested-chain/status-counter、dying-rescue response window、forced assault window、request lifecycle、cancellation、timeout 输入、payment orchestration 与 result normalization。

上游
core/ResponseSystem legacy façade 与 Game/cardRegistry/skillRegistry/DyingSystem response workflow consumers。

下游
Domain ResponseRules、Choice application modules、ResponsePresentation 与注入的 legacy compatibility collaborators。

状态边界
不直接写 Domain state；真实 commit 只经注入 payment callback（最终 ZoneTransitions）。

信息边界
不直接读取 UI/AI/DOM；不新增隐藏信息。

架构约束
不得依赖 UIManager/AIController/SoundManager/DOM/Debug 或 concrete adapters；不得 import Game runtime。
*/
import {
  getCounterResponderOrder, getRequiredBlockCount, getResponseCardDefinitionId,
  getStatusCounterResponderOrder, hasSufficientResponseCards, isAssaultDamage,
  isBlockResponseAvailable, isCounterEligible, isDyingRescueEligible, isResponderEligible
} from "../../domain/rules/response/ResponseRules.js?build=20260816-fr-arch-14-runtime-closure";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js?build=20260816-fr-arch-14-runtime-closure";
import { createResponseChoiceRequest } from "../choice/ResponseChoiceRequest.js?build=20260816-fr-arch-14-runtime-closure";
import { shouldForceAiRescueHuman, shouldForceAiSelfRescue, shouldPreferExplicitSelection, shouldRejectLeverageWithoutCards, shouldShowResponseWindowWithoutCards } from "./ParticipantPolicy.js?build=20260816-fr-arch-14-runtime-closure";
import { buildResponsePresentation, publicPlayerContext } from "./ResponsePresentation.js?build=20260816-fr-arch-14-runtime-closure";
import { RESPONSE_STATUS, createResponseWorkflowResult, isCancelledResponse } from "./ResponseResult.js?build=20260816-fr-arch-14-runtime-closure";

/*
功能
创建 Application Response Workflow。

调用方
core/ResponseSystem legacy façade。

输入
显式注入的 choice、presentation、session、payment 与 legacy rule facade collaborators。

输出
冻结 response workflow API。

读取状态
无。

写入状态
内部 activeRequestIds 与经注入 collaborators 的 session presentation state。

调用函数
buildResponsePresentation、createResponseChoiceRequest、Domain ResponseRules、createRuleStateView。

边界与不变量
不持有 Game 引用；responseTimeoutMs 只作为 Application policy 输入；不新增全局 stale reject。
*/
export function createResponseWorkflow(dependencies) {
  const {
    choiceCoordinator,
    choiceContexts,
    getState,
    isSessionValid,
    pushPendingResponse,
    removePendingResponse,
    clearPendingResponses,
    payCardsFromHandAtomically,
    setCurrentCard,
    log,
    emitCardUsed,
    getForceAiRescueHuman,
    setThinking,
    delayResponse,
    getUsableAssaultCards,
    canUseForcedAssault,
    getResponseTimeoutMs,
    createId
  } = dependencies;
  if (!choiceCoordinator || !getState || !isSessionValid || !payCardsFromHandAtomically
    || !getResponseTimeoutMs || !createId) {
    throw new TypeError("ResponseWorkflow 缺少必要 collaborator");
  }
  const runtime = dependencies;
  const activeRequestIds = new Set();
  const responseResult = createResponseWorkflowResult;

/*
  功能
  等待真人响应或通过 AI 门面取得响应决策。

  调用方
  各类卡牌、弃置、技能与濒死响应入口。

  输入
  响应者、请求、显示标签、公开上下文与合法候选牌。

  输出
  规范化的 USED、DECLINED 或 CANCELLED 结果。

  读取状态
  当前会话、UI、CleanupManager 与 AIController 响应门面。

  写入状态
  UI 思考与提示状态。

  调用函数
  UI.requestResponse、AIController.shouldRespond、responseResult。

  边界与不变量
  会话失效必须返回取消；AI 放弃借势时不得用中间提示泄漏手牌。
  */
  async function waitForDecision(responder, request, label, context, cards) {
    const choiceRequest = createResponseChoiceRequest({
      requestId: request.id,
      actorId: responder.id,
      gameId: runtime.getState().gameId,
      stateVersion: runtime.getState().stateVersion,
      responseType: request.type,
      requiredCount: request.requiredCount,
      legalCardIds: request.legalCardIds,
      label,
      context: {
        sourcePlayerId: request.sourcePlayerId,
        targetPlayerId: request.targetPlayerId,
        cardId: request.cardId,
        timeoutMs: request.timeoutMs,
        presentation: request.presentation
      }
    });
    choiceContexts?.set(request.id, { responder, cards, context, label });
    try {
      const choice = await choiceCoordinator.request(choiceRequest);
      if (choice.status === "selected") {
        return responseResult(RESPONSE_STATUS.USED, { cardId:choice.selectedIds[0] ?? null });
      }
      if (choice.status === "declined") return responseResult(RESPONSE_STATUS.DECLINED);
      return responseResult(RESPONSE_STATUS.CANCELLED);
    } finally {
      choiceContexts?.delete(request.id);
    }
  }

  /*
  功能
  请求指定响应类型、校验响应者与手牌实体并执行原子支付。

  调用方
  askForBlock、askForCounter、askForStatusCounter 与 requestDyingRescue。

  输入
  responder、type、context 与 requiredCount。

  输出
  规范化 USED/DECLINED/CANCELLED/INVALID 结果。

  读取状态
  responder 存活、手牌实体、Game 会话与响应请求注册表。

  写入状态
  pendingResponses、UI thinking/prompt 与经支付 transition 的手牌。

  调用函数
  getResponseCardDefinitionId、isResponderEligible、hasSufficientResponseCards、waitForDecision、finishRequest、payCardsFromHandAtomically。

  边界与不变量
  responseTimeoutMs 仍属 legacy runtime policy；响应类型映射与资格由 Domain Rule 决定。
  */
  async function requestCardResponse(responder, type, context, requiredCount = 1) {
    const gameId = runtime.getState().gameId;
    const definitionId = getResponseCardDefinitionId(type);
    const availableCards = responder.hand.filter((card) => card.definitionId === definitionId);
    const cardsToUse = availableCards.slice(0, requiredCount);
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    if (!isResponderEligible(responder) || runtime.getState().isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    // 规则轮到真人响应时始终显示窗口；AI 没牌仍立即跳过。
    if (availableCards.length < requiredCount && !shouldShowResponseWindowWithoutCards(responder)) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    const fallbackLabel = type === "block" ? (requiredCount === 2 ? "使用2张「格挡」" : "格挡") : "反制";
    const request = { id:runtime.createId("response"), type, sourcePlayerId:context.source?.id ?? null, targetPlayerId:responder.id,
      cardId:context.card?.id ?? null, legalCardIds:availableCards.map((card) => card.id), requiredCount,
      legalSkillIds:[], timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true,
      presentation:buildResponsePresentation(responder, type, context, requiredCount, availableCards.length, fallbackLabel) };
    activeRequestIds.add(request.id);
    runtime.pushPendingResponse(request);
    const label = request.presentation.buttonLabel;
    const decision = await waitForDecision(responder, request, label, context, availableCards);
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) && isResponderEligible(responder) &&
      hasSufficientResponseCards(cardsToUse.length, requiredCount) && cardsToUse.every((card) => responder.hand.includes(card));
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { cards:[] });
    if (!valid) return responseResult(RESPONSE_STATUS.INVALID, { cards:[] });
    const payment = await runtime.payCardsFromHandAtomically(
      responder,
      cardsToUse,
      `响应·${type === "block" ? "格挡" : "反制"}`,
      { silent:true, expectedCount:requiredCount }
    );
    if (payment.status === RESPONSE_STATUS.CANCELLED || !runtime.isSessionValid(gameId)) {
      return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    }
    if (payment.status !== RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.INVALID, { cards:[] });
    if (type === "counter") {
      const targetSuffix = context.targetScoped ? `（仅取消对${responder.name}的效果）` : "";
      const delayedStatus = context.delayedStatusContext;
      const counterTarget = delayedStatus
        ? `${delayedStatus.ownerName}的「${delayedStatus.statusName}」判定`
        : `「${context.card?.name ?? "战术牌"}」${targetSuffix}`;
      runtime.setCurrentCard(cardsToUse[0], responder.name, `反制${counterTarget}`);
    } else {
      runtime.log(cardsToUse.length === 1
        ? `${responder.name}使用了「格挡」。`
        : `${responder.name}同时使用了${cardsToUse.length}张「格挡」。`, "important");
    }
    return responseResult(RESPONSE_STATUS.USED, { cards:cardsToUse });
  }

  /*
  功能
  请求格挡响应。

  调用方
  Game.damage。

  输入
  source、target 与 context。

  输出
  规范化响应结果。

  读取状态
  Game state、响应策略与 UI/AI boundary。

  写入状态
  经支付 transition。

  调用函数
  getRequiredBlockCount、requestCardResponse。

  边界与不变量
  格挡需求由 Domain Rule 决定。
  */
  async function askForBlock(source, target, context) {
    if (!isBlockResponseAvailable(context.canBlock, context.amount)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    }
    const required = getRequiredBlockCount(
      source?.equipment?.definitionId ?? null,
      isAssaultDamage(context.card, context.damageType)
    );
    return requestCardResponse(target, "block", { source, target, ...context }, required);
  }

  /*
  功能
  在反制链最终生效后发布 cardUsed 并公开真实关联的存活角色。

  调用方
  askForCounter 与 askForStatusCounter。

  输入
  responder、counterCard 与 relatedPlayers。

  输出
  Promise<event emission>。

  读取状态
  runtime state.players。

  写入状态
  经 runtime.emitCardUsed 发布事件。

  调用函数
  runtime.emitCardUsed、runtime.createId。

  边界与不变量
  只公开存活且去重玩家；反制牌实体保留原引用。
  */
  async function emitResolvedCounterUse(responder, counterCard, relatedPlayers = []) {
    const seen = new Set();
    const effectiveTargets = [];
    for (const related of relatedPlayers) {
      const player = runtime.getState().players.find((candidate) => candidate.id === related?.id);
      if (!player?.alive || seen.has(player.id)) continue;
      seen.add(player.id);
      effectiveTargets.push(player);
    }
    await runtime.emitCardUsed( {
      type:"cardUsed",
      source:responder,
      card:counterCard,
      targets:effectiveTargets,
      effectiveTargets,
      cancelled:false,
      resolved:true,
      resolutionId:runtime.createId("counter-resolution"),
      usageContext:"response"
    });
  }

  /*
  功能
  执行反制链响应编排。

  调用方
  Game.playCard 与状态反制 workflow。

  输入
  source、card、targets 与 chainContext。

  输出
  USED/DECLINED/CANCELLED。

  读取状态
  Game state、响应策略与 UI/AI boundary。

  写入状态
  经支付 transition。

  调用函数
  isCounterEligible、seatOrderFrom、requestCardResponse。

  边界与不变量
  反制资格由 Domain Rule 决定；嵌套链 workflow 保留。
  */
  async function askForCounter(source, card, targets, chainContext = {}) {
    const gameId = runtime.getState().gameId;
    if (!isCounterEligible(card.category, card.counterable)) return responseResult(RESPONSE_STATUS.UNAVAILABLE);
    const responderIds = chainContext.responders
      ? chainContext.responders.map((responder) => responder.id)
      : (() => {
          const view = createRuleStateView(runtime.getState());
          return getCounterResponderOrder(view.players(), source.id);
        })();
    const responders = responderIds
      .map((id) => runtime.getState().players.find((player) => player.id === id))
      .filter(Boolean);
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
            fromBattleTeam:runtime.getState().players.find((player) => player.id === publicTransferContext.fromPlayerId)?.battleTeam,
            receiverBattleTeam:runtime.getState().players.find((player) => player.id === publicTransferContext.receiverPlayerId)?.battleTeam
          })
        : null;
      const response = await requestCardResponse(responder, "counter", {
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
      if (isCancelledResponse(response) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const [counterCard] = response.cards ?? [];
      if (response.status !== RESPONSE_STATUS.USED || !counterCard) continue;
      const cancelledTarget = chainContext.targetScoped
        ? `对${targets[0]?.name ?? responder.name}的效果`
        : "的效果";
      runtime.log(`${responder.name}对${source.name}的「${card.name}」使用了「反制」，取消了「${card.name}」${cancelledTarget}。`, "important");
      // 反制牌已经从手牌移入弃牌堆，因此递归链必然受实体牌数量限制，不会无限循环。
      // 嵌套层只透传 root outcome 链上下文（root card、root source、深度、root 目标）；
      // targetScoped、responders 等针对"当前被反制牌"的字段在本层即消费完毕，不向下一层泄漏。
      const counterWasCountered = await askForCounter(responder, counterCard, [source], {
        targetCard:card, rootCard, rootSourceId, counterDepth:counterDepth + 1, rootTargetIds
      });
      if (isCancelledResponse(counterWasCountered) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      if (counterWasCountered.status === RESPONSE_STATUS.USED) {
        return responseResult(RESPONSE_STATUS.DECLINED);
      }
      await emitResolvedCounterUse(
        responder, counterCard, [source, ...(chainContext.relatedTargets ?? targets)]
      );
      if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      return responseResult(RESPONSE_STATUS.USED, { card:counterCard });
    }
    return responseResult(RESPONSE_STATUS.DECLINED);
  }

  /*
  功能
  编排延迟战术状态判定前的独立反制窗口。

  调用方
  Game 延迟状态判定 workflow。

  输入
  holder 与 context。

  输出
  USED/DECLINED/CANCELLED。

  读取状态
  Game 会话、RuleStateView 座次与响应策略。

  写入状态
  经 requestCardResponse/payCardsFromHandAtomically 支付反制牌。

  调用函数
  createRuleStateView、getStatusCounterResponderOrder、requestCardResponse、askForCounter、emitResolvedCounterUse。

  边界与不变量
  响应者顺序由 Domain Rule 决定；状态持有者最先，其余存活玩家顺时针。
  */
  async function askForStatusCounter(holder, context = {}) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId) || !isResponderEligible(holder) || runtime.getState().isGameOver) return responseResult(RESPONSE_STATUS.DECLINED);
    const statusName = context.statusName;
    const view = createRuleStateView(runtime.getState());
    const responderIds = getStatusCounterResponderOrder(view.players(), holder.id);
    const responders = responderIds
      .map((id) => runtime.getState().players.find((player) => player.id === id))
      .filter(Boolean);
    for (const responder of responders) {
      if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const delayedStatusContext = Object.freeze({
        ownerId:holder.id,
        ownerName:holder.name,
        ownerBattleTeam:holder.battleTeam,
        statusId:context.statusId,
        statusName,
        event:"beforeJudgment"
      });
      const response = await requestCardResponse(responder, "counter", {
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
      if (isCancelledResponse(response) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const [counterCard] = response.cards ?? [];
      if (response.status !== RESPONSE_STATUS.USED || !counterCard) continue;
      runtime.log(`${responder.name}对${holder.name}的「${statusName}」使用了「反制」。`, "important");
      const counterWasCountered = await askForCounter(responder, counterCard, [holder], { targetCard:null, statusCounterChain:true });
      if (isCancelledResponse(counterWasCountered) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      if (counterWasCountered.status === RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.DECLINED);
      await emitResolvedCounterUse(responder, counterCard, [holder]);
      if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      return responseResult(RESPONSE_STATUS.USED, { card:counterCard });
    }
    return responseResult(RESPONSE_STATUS.DECLINED);
  }

  /*
  功能
  请求濒死救援响应。

  调用方
  DyingSystem。

  输入
  rescuer、target 与可选 recover card。

  输出
  USED/DECLINED/CANCELLED。

  读取状态
  Game state、响应策略与 UI/AI boundary。

  写入状态
  经支付 transition。

  调用函数
  isDyingRescueEligible、waitForDecision、payCardsFromHandAtomically。

  边界与不变量
  救援资格由 Domain Rule 决定。
  */
  async function requestDyingRescue(rescuer, target, card) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!isDyingRescueEligible(rescuer, target) || runtime.getState().isGameOver) {
      return responseResult(runtime.getState().isDisposed ? RESPONSE_STATUS.CANCELLED : RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const availableCards = rescuer.hand.filter((entry) => entry.definitionId === "recover");
    const legalCard = card?.definitionId === "recover" && rescuer.hand.includes(card) ? card : (availableCards[0] ?? null);
    if (!availableCards.length && !shouldShowResponseWindowWithoutCards(rescuer)) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    const request = { id:runtime.createId("dying-response"), type:"dyingRescue", sourcePlayerId:rescuer.id, targetPlayerId:target.id,
      cardId:null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1, legalSkillIds:[], timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true,
      need:1 - target.hp, currentHp:target.hp,
      presentation:buildResponsePresentation(rescuer, "dyingRescue", { target }, 1, availableCards.length, "使用「调息」") };
    activeRequestIds.add(request.id);
    runtime.pushPendingResponse(request);
    let decision;
    const aiSelfRescue = shouldForceAiSelfRescue(rescuer, target);
    const forcedHumanRescue = shouldForceAiRescueHuman(rescuer, target, runtime.getForceAiRescueHuman());

    if (aiSelfRescue) {
      decision = responseResult(RESPONSE_STATUS.USED);
    } else if (forcedHumanRescue) {
      runtime.setThinking(true, rescuer, `正在准备救援${target.name}`);
      const waited = await runtime.delayResponse();
      runtime.setThinking(false);
      if (!waited) {
        finishRequest(request.id);
        return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
      }
      // 强制队友规则在等待结束后固定使用调息，不进入 AI 效用评分。
      decision = responseResult(RESPONSE_STATUS.USED);
    } else {
      decision = await waitForDecision(rescuer, request, request.presentation.buttonLabel, { target, source:rescuer, card:legalCard }, availableCards);
    }
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) &&
      isDyingRescueEligible(rescuer, target) && legalCard && rescuer.hand.includes(legalCard);
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { card:null });
    if (!valid) return responseResult(RESPONSE_STATUS.INVALID, { card:null });
    const payment = await runtime.payCardsFromHandAtomically(
      rescuer, [legalCard], `救援${target.name}`, { silent:true, expectedCount:1 }
    );
    if (payment.status === RESPONSE_STATUS.CANCELLED || !runtime.isSessionValid(gameId)) {
      return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    }
    return payment.status === RESPONSE_STATUS.USED
      ? responseResult(RESPONSE_STATUS.USED, { card:legalCard })
      : responseResult(RESPONSE_STATUS.INVALID, { card:null });
  }

  /*
  功能
  请求强制打出一张突袭作为响应。

  调用方
  Game 决斗/借势 response workflow。

  输入
  responder、reason 与 context。

  输出
  USED/DECLINED/CANCELLED/INVALID。

  读取状态
  responder 存活、手牌实体、Game 会话与响应策略。

  写入状态
  pendingResponses、UI 思考与经支付 transition 的手牌。

  调用函数
  isResponderEligible、waitForDecision、finishRequest、payCardsFromHandAtomically。

  边界与不变量
  响应类型与资格由 Domain Rule 决定；human/AI 选择仍属 workflow。
  */
  async function requestAssaultDiscard(responder, reason, context = {}) {
    const gameId = runtime.getState().gameId;
    const availableCards = responder.hand.filter((entry) => entry.definitionId === "assault");
    const cardToUse = availableCards[0] ?? null;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!isResponderEligible(responder) || runtime.getState().isGameOver || (!availableCards.length && !shouldShowResponseWindowWithoutCards(responder))) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    const presentation = buildResponsePresentation(responder, "assaultDiscard", context, 1, availableCards.length, reason);
    const request = { id:runtime.createId("assault-discard"), type:"assaultDiscard", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1,
      legalSkillIds:[], timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true, presentation };
    activeRequestIds.add(request.id); runtime.pushPendingResponse(request);
    const decision = await waitForDecision(responder, request, presentation.buttonLabel, context, availableCards);
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) && isResponderEligible(responder) && cardToUse && responder.hand.includes(cardToUse);
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { card:null });
    if (!valid) return responseResult(RESPONSE_STATUS.INVALID, { card:null });
    const payment = await runtime.payCardsFromHandAtomically(
      responder, [cardToUse], reason, { silent:true, expectedCount:1 }
    );
    if (payment.status === RESPONSE_STATUS.CANCELLED || !runtime.isSessionValid(gameId)) {
      return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    }
    if (payment.status !== RESPONSE_STATUS.USED) return responseResult(RESPONSE_STATUS.INVALID, { card:null });
    if (context.card?.definitionId === "duel") {
      runtime.log(`${responder.name}在决斗中打出了「突袭」。`, "important");
    } else if (context.card?.definitionId === "provoke") {
      runtime.log(`${responder.name}打出了「突袭」回应挑衅。`, "important");
    } else {
      runtime.log(`${responder.name}打出了「突袭」。`, "important");
    }
    return responseResult(RESPONSE_STATUS.USED, { card:cardToUse });
  }

  /*
  功能
  执行借势强制突袭 response window；确认后返回同一实体，由 Game.playCard 走普通突袭流程。

  调用方
  Game leverage workflow。

  输入
  responder、target 与 context。

  输出
  USED/DECLINED/CANCELLED/INVALID/UNAVAILABLE。

  读取状态
  responder/target、合法突袭实体与 session。

  写入状态
  pendingResponses 与 choice registry；不在此消费牌。

  调用函数
  buildResponsePresentation、waitForDecision、runtime.canUseForcedAssault。

  边界与不变量
  真人无合法突袭不创建窗口；AI 仍经 timing decorator 等待，避免手牌侧信道。
  */
  async function requestLeverageAssault(responder, target, context = {}) {
    const gameId = runtime.getState().gameId;
    const availableCards = runtime.getUsableAssaultCards(responder, target);
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!responder?.alive || !target?.alive || runtime.getState().isGameOver) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    if (!availableCards.length && shouldRejectLeverageWithoutCards(responder)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const presentation = {
      ...buildResponsePresentation(responder, "leverageAssault", { ...context, target }, 1, availableCards.length, "使用「突袭」"),
      declineLabel:"拒绝"
    };
    const request = {
      id:runtime.createId("leverage-assault"),
      type:"leverageAssault",
      sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id,
      forcedTargetPlayerId:target.id,
      cardId:context.card?.id ?? null,
      legalCardIds:availableCards.map((entry) => entry.id),
      requiredCount:1,
      legalSkillIds:[],
      timeoutMs:runtime.getResponseTimeoutMs(),
      allowDecline:true,
      presentation
    };
    activeRequestIds.add(request.id);
    runtime.pushPendingResponse(request);
    const decision = await waitForDecision(responder, request, presentation.buttonLabel, { ...context, target }, availableCards);
    const selectedId = shouldPreferExplicitSelection(responder)
      ? (decision.cardId ?? availableCards[0]?.id)
      : availableCards[0]?.id;
    const selectedCard = availableCards.find((entry) => entry.id === selectedId) ?? null;
    const valid = activeRequestIds.has(request.id)
      && runtime.isSessionValid(gameId)
      && selectedCard
      && runtime.canUseForcedAssault(responder, selectedCard, target).ok;
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status, { card:null });
    return valid
      ? responseResult(RESPONSE_STATUS.USED, { card:selectedCard })
      : responseResult(RESPONSE_STATUS.INVALID, { card:null });
  }

  /*
  功能
  执行技能响应窗口并返回 workflow result。

  调用方
  skillRegistry 护援入口。

  输入
  responder、skillId、responseName 与 context。

  输出
  USED/DECLINED/CANCELLED/INVALID。

  读取状态
  responder 与 session。

  写入状态
  pendingResponses 与 choice registry。

  调用函数
  buildResponsePresentation、waitForDecision、finishRequest。

  边界与不变量
  skill 效果仍由 skillRegistry 执行。
  */
  async function requestSkillResponse(responder, skillId, responseName, context) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
    if (!responder.alive || runtime.getState().isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE);
    const buttonLabel = `发动「${responseName}」`;
    const request = { id:runtime.createId("skill-response"), type:"skill", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:[], legalSkillIds:[skillId],
      requiredCount:0, timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true,
      presentation:buildResponsePresentation(responder, "skill", { ...context, responseName, buttonLabel }, 0, 0, buttonLabel) };
    activeRequestIds.add(request.id); runtime.pushPendingResponse(request);
    const decision = await waitForDecision(responder, request, buttonLabel, context, []);
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) && responder.alive;
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
    if (decision.status !== RESPONSE_STATUS.USED) return responseResult(decision.status);
    return responseResult(valid ? RESPONSE_STATUS.USED : RESPONSE_STATUS.INVALID);
  }

  /*
  功能
  完成或移除一个 active response request。

  调用方
  ResponseWorkflow 各 request 方法。

  输入
  request id。

  输出
  无。

  读取状态
  activeRequestIds 与 runtime state.isDisposed。

  写入状态
  activeRequestIds 与 runtime.pendingResponses。

  调用函数
  runtime.removePendingResponse。

  边界与不变量
  disposed 时不触碰 pendingResponses。
  */
  function finishRequest(id) {
    activeRequestIds.delete(id);
    if (!runtime.getState().isDisposed) runtime.removePendingResponse(id);
  }
  /*
  功能
  清空全部 active response request 与 pending responses。

  调用方
  Game dispose/restart。

  输入
  无。

  输出
  无。

  读取状态
  activeRequestIds。

  写入状态
  activeRequestIds 与 runtime.pendingResponses。

  调用函数
  runtime.clearPendingResponses。

  边界与不变量
  只清理 Application response session，不写 Domain state。
  */
  function cleanup() { activeRequestIds.clear(); runtime.clearPendingResponses(); }
  return Object.freeze({
    waitForDecision,
    requestCardResponse,
    askForBlock,
    emitResolvedCounterUse,
    askForCounter,
    askForStatusCounter,
    requestDyingRescue,
    requestAssaultDiscard,
    requestLeverageAssault,
    requestSkillResponse,
    finishRequest,
    cleanup
  });
}
