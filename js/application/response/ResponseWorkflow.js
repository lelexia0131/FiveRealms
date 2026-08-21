/*
模块职责
拥有 Application Response Workflow：response window、responder iteration、block/counter/nested-chain/status-counter、dying-rescue response window、forced assault window、request lifecycle、cancellation、timeout 输入、payment orchestration 与 result normalization。

上游
Application action、combat、dying 与 composition command consumers。

下游
Domain ResponseRules、Choice application modules、ResponsePresentation 与注入的 adapter collaborators。

状态边界
不直接写 Domain state；真实 commit 只经注入 payment callback（最终 ZoneTransitions）。

信息边界
不直接读取 UI/AI/DOM；不新增隐藏信息。

架构约束
不得依赖 UIManager/AIController/SoundManager/DOM/Debug 或 concrete adapters；不得 import Game runtime。
*/
import {
  getCounterResponderOrder, getRequiredBlockCount, getResponseCardDefinitionId,
  getStatusCounterResponderOrder, isAssaultDamage,
  hasSufficientResponseCards, isBlockResponseAvailable, isCounterEligible,
  isDyingRescueEligible, isResponderEligible
} from "../../domain/rules/response/ResponseRules.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";
import { createResponseChoiceRequest } from "../choice/ResponseChoiceRequest.js";
import {
  shouldForceAiRescueHuman, shouldForceAiSelfRescue, shouldPreferExplicitSelection,
  shouldRejectResponseWithoutLegalOptions
} from "./ParticipantPolicy.js";
import { buildResponsePresentation, publicPlayerContext } from "./ResponsePresentation.js";
import { RESPONSE_STATUS, createResponseWorkflowResult, isCancelledResponse } from "./ResponseResult.js";

/*
功能
仅凭玩家可见的手牌数量判断卡牌响应是否必然无法满足数量要求。

调用方
ResponseWorkflow 的格挡、反制、调息救援与突袭响应入口。

输入
响应者投影与当前窗口要求的响应牌数量。

输出
公开手牌数不足时返回 true，否则返回 false。

读取状态
responder.hand.length 这一公开数量事实；不读取 card id、definitionId 或牌面。

写入状态
无。

调用函数
无。

边界与不变量
false 不代表实际可响应；只要仍有足够未知手牌，就必须继续原有 timing boundary。
*/
function isCardResponseImpossibleFromPublicInfo(responder, requiredCount) {
  return responder.hand.length < Math.max(0, Number(requiredCount) || 0);
}

/*
功能
创建 Application Response Workflow。

调用方
composition root。

输入
显式注入的 choice、presentation、session、payment 与 rule boundary collaborators。

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
    isAiDyingRescueGuaranteedImpossible,
    setThinking,
    delayResponse,
    getUsableAssaultCards,
    canUseForcedAssault,
    getResponseTimeoutMs,
    createId,
    now
  } = dependencies;
  if (!choiceCoordinator || !getState || !isSessionValid || !payCardsFromHandAtomically
    || !getResponseTimeoutMs || !createId || !now) {
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
  规范化的 USED、DECLINED 或 CANCELLED 结果；USED 保留完整 selectedIds。

  读取状态
  当前会话、UI、CleanupManager 与 AIController 响应门面。

  写入状态
  UI 思考与提示状态。

  调用函数
  UI.requestResponse、AIController.shouldRespond、responseResult。

  边界与不变量
  会话失效必须返回取消；选择实体 ID 不得在此截断或替换。
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
        return responseResult(RESPONSE_STATUS.USED, { selectedIds:choice.selectedIds });
      }
      if (choice.status === "declined") return responseResult(RESPONSE_STATUS.DECLINED);
      return responseResult(RESPONSE_STATUS.CANCELLED);
    } finally {
      choiceContexts?.delete(request.id);
    }
  }

  /*
  功能
  为不经过 AI policy 的固定响应结果补齐与普通 AI 响应相同的 elapsed-aware presentation pacing。

  调用方
  requestDyingRescue 的 AI 自救与强制救援分支。

  输入
  响应者、gameId、thinking 文案与同步 decision factory。

  输出
  factory 生成的 ResponseWorkflowResult；等待取消或会话失效时返回 CANCELLED。

  读取状态
  Application session 与注入 clock。

  写入状态
  thinking presentation state。

  调用函数
  decisionFactory、runtime.delayResponse、responseResult。

  边界与不变量
  固定策略只绕过效用评分，不得绕过可观察思考下限；真实 elapsed 必须从剩余等待中扣除。
  */
  async function waitForFixedAiDecision(responder, gameId, message, decisionFactory) {
    runtime.setThinking(true, responder, message);
    const startedAt = runtime.now();
    try {
      const decision = decisionFactory();
      if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
      const waited = await runtime.delayResponse({
        elapsedMs:Math.max(0, runtime.now() - startedAt)
      });
      return waited && runtime.isSessionValid(gameId)
        ? decision
        : responseResult(RESPONSE_STATUS.CANCELLED);
    } finally {
      runtime.setThinking(false);
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
  规范化 USED/DECLINED/CANCELLED/INVALID/UNAVAILABLE 结果。

  读取状态
  responder 当前手牌实体、Application session 与响应请求注册表。

  写入状态
  pendingResponses、UI thinking/prompt 与经支付 transition 的手牌。

  调用函数
  isCardResponseImpossibleFromPublicInfo、getResponseCardDefinitionId、isResponderEligible、waitForDecision、finishRequest、payCardsFromHandAtomically。

  边界与不变量
  公开手牌数已不足时直接结束；否则真人合法实体不足时不得创建 pending/UI 请求，AI 候选不足仍经过 timing boundary。
  只按返回的唯一 selectedIds 从当前手牌重绑实体；数量、合法集合、会话或实体位置任一失效都不得支付。
  */
  async function requestCardResponse(responder, type, context, requiredCount = 1) {
    const gameId = runtime.getState().gameId;
    const definitionId = getResponseCardDefinitionId(type);
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    if (!isResponderEligible(responder) || runtime.getState().isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    if (isCardResponseImpossibleFromPublicInfo(responder, requiredCount)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    }
    const availableCards = responder.hand.filter((card) => card.definitionId === definitionId);
    const lacksRequiredCards = !hasSufficientResponseCards(availableCards.length, requiredCount);
    if (lacksRequiredCards && shouldRejectResponseWithoutLegalOptions(responder)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    }
    // AI 即使没有足够牌也必须经过同一 decision/timing boundary，最后再恢复 unavailable，
    // 避免玩家通过响应耗时推断 AI 手牌数量。
    const unavailableAfterTiming = lacksRequiredCards;
    const fallbackLabel = type === "block" ? (requiredCount === 2 ? "使用2张「格挡」" : "格挡") : "反制";
    const request = { id:runtime.createId("response"), type, sourcePlayerId:context.source?.id ?? null, targetPlayerId:responder.id,
      cardId:context.card?.id ?? null, legalCardIds:availableCards.map((card) => card.id), requiredCount,
      legalSkillIds:[], timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true,
      presentation:buildResponsePresentation(responder, type, context, requiredCount, availableCards.length, fallbackLabel) };
    activeRequestIds.add(request.id);
    runtime.pushPendingResponse(request);
    const label = request.presentation.buttonLabel;
    const decision = await waitForDecision(responder, request, label, context, availableCards);
    const selectedIds = decision.selectedIds ?? [];
    const uniqueSelectedIds = new Set(selectedIds);
    const cardsToUse = selectedIds.map((selectedId) => (
      responder.hand.find((card) => card.id === selectedId) ?? null
    ));
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) && isResponderEligible(responder) &&
      selectedIds.length === requiredCount && uniqueSelectedIds.size === selectedIds.length &&
      selectedIds.every((selectedId) => request.legalCardIds.includes(selectedId)) && cardsToUse.every(Boolean);
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { cards:[] });
    if (unavailableAfterTiming) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
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
  取得一次伤害当前需要满足的权威格挡数量。

  调用方
  CombatWorkflow.damage、askForBlock。

  输入
  伤害来源与含 card/damageType 的响应上下文。

  输出
  Domain Response Rule 决定的正整数格挡需求。

  读取状态
  source 当前装备与 context 的伤害事实。

  写入状态
  无。

  调用函数
  getRequiredBlockCount、isAssaultDamage。

  边界与不变量
  军火库等效果只能通过 Domain 拥有的格挡需求数量组合，不在 workflow 按装备名分支。
  */
  function getBlockRequirement(source, context) {
    return getRequiredBlockCount(
      source?.equipment?.definitionId ?? null,
      isAssaultDamage(context.card, context.damageType)
    );
  }

  /*
  功能
  请求格挡响应。

  调用方
  CombatWorkflow.damage。

  输入
  source、target 与 context。

  输出
  规范化响应结果。

  读取状态
  MatchState、响应策略与 UI/AI boundary。

  写入状态
  经支付 transition。

  调用函数
  getBlockRequirement、requestCardResponse。

  边界与不变量
  格挡需求由 Domain Rule 决定；雷达已免除的需求由 CombatWorkflow 通过 requiredBlockCount 传入。
  */
  async function askForBlock(source, target, context) {
    if (!isBlockResponseAvailable(context.canBlock, context.amount)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
    }
    const required = context.requiredBlockCount ?? getBlockRequirement(source, context);
    if (required <= 0) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { cards:[] });
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
  ActionWorkflow.playCard 与状态反制 workflow。

  输入
  source、card、targets 与 chainContext。

  输出
  USED/DECLINED/CANCELLED/INVALID/UNAVAILABLE。

  读取状态
  MatchState、响应策略与 UI/AI boundary。

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
  StatusResolutionWorkflow 延迟状态判定。

  输入
  holder 与 context。

  输出
  USED/DECLINED/CANCELLED。

  读取状态
  Application session、RuleStateView 座次与响应策略。

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
  DyingWorkflow。

  输入
  rescuer、target 与可选 recover card。

  输出
  USED/DECLINED/CANCELLED。

  读取状态
  MatchState、响应策略与 UI/AI boundary。

  写入状态
  经支付 transition。

  调用函数
  isDyingRescueEligible、isCardResponseImpossibleFromPublicInfo、waitForDecision、payCardsFromHandAtomically。

  边界与不变量
  救援资格由 Domain Rule 决定；公开空手时直接结束，否则真人没有合法调息时不创建窗口，AI 仍保留 timing boundary。
  */
  async function requestDyingRescue(rescuer, target, card) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!isDyingRescueEligible(rescuer, target) || runtime.getState().isGameOver) {
      return responseResult(runtime.getState().isDisposed ? RESPONSE_STATUS.CANCELLED : RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    if (isCardResponseImpossibleFromPublicInfo(rescuer, 1)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const availableCards = rescuer.hand.filter((entry) => entry.definitionId === "recover");
    const legalCard = card?.definitionId === "recover" && rescuer.hand.includes(card) ? card : (availableCards[0] ?? null);
    const lacksRequiredCards = !hasSufficientResponseCards(availableCards.length, 1);
    if (lacksRequiredCards && shouldRejectResponseWithoutLegalOptions(rescuer)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const unavailableAfterTiming = lacksRequiredCards;
    const request = { id:runtime.createId("dying-response"), type:"dyingRescue", sourcePlayerId:rescuer.id, targetPlayerId:target.id,
      cardId:null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1, legalSkillIds:[], timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true,
      need:1 - target.hp, currentHp:target.hp,
      presentation:buildResponsePresentation(rescuer, "dyingRescue", { target }, 1, availableCards.length, "使用「调息」") };
    activeRequestIds.add(request.id);
    runtime.pushPendingResponse(request);
    let decision;
    const aiSelfRescue = shouldForceAiSelfRescue(rescuer, target);
    const forcedHumanRescue = shouldForceAiRescueHuman(rescuer, target, runtime.getForceAiRescueHuman());
    const mustDeclineGuaranteedImpossible = (aiSelfRescue || forcedHumanRescue)
      && runtime.isAiDyingRescueGuaranteedImpossible?.(rescuer, target) === true;

    if ((aiSelfRescue || forcedHumanRescue) && !mustDeclineGuaranteedImpossible) {
      decision = await waitForFixedAiDecision(
        rescuer,
        gameId,
        `正在准备救援${target.name}`,
        () => responseResult(unavailableAfterTiming ? RESPONSE_STATUS.UNAVAILABLE : RESPONSE_STATUS.USED)
      );
    } else if (mustDeclineGuaranteedImpossible) {
      decision = responseResult(RESPONSE_STATUS.DECLINED);
    } else {
      decision = await waitForDecision(rescuer, request, request.presentation.buttonLabel, { target, source:rescuer, card:legalCard }, availableCards);
    }
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) &&
      isDyingRescueEligible(rescuer, target) && legalCard && rescuer.hand.includes(legalCard);
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (unavailableAfterTiming) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
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
  ResponseWorkflow 决斗/借势窗口。

  输入
  responder、reason 与 context。

  输出
  USED/DECLINED/CANCELLED/INVALID。

  读取状态
  responder 存活、手牌实体、Application session 与响应策略。

  写入状态
  pendingResponses、UI 思考与经支付 transition 的手牌。

  调用函数
  isResponderEligible、isCardResponseImpossibleFromPublicInfo、waitForDecision、finishRequest、payCardsFromHandAtomically。

  边界与不变量
  响应类型与资格由 Domain Rule 决定；公开空手时直接结束，否则真人没有合法突袭时不创建窗口，AI 仍保留 timing boundary。
  */
  async function requestAssaultDiscard(responder, reason, context = {}) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!isResponderEligible(responder) || runtime.getState().isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    if (isCardResponseImpossibleFromPublicInfo(responder, 1)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const availableCards = responder.hand.filter((entry) => entry.definitionId === "assault");
    const cardToUse = availableCards[0] ?? null;
    const lacksRequiredCards = !hasSufficientResponseCards(availableCards.length, 1);
    if (lacksRequiredCards && shouldRejectResponseWithoutLegalOptions(responder)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const unavailableAfterTiming = lacksRequiredCards;
    const presentation = buildResponsePresentation(responder, "assaultDiscard", context, 1, availableCards.length, reason);
    const request = { id:runtime.createId("assault-discard"), type:"assaultDiscard", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:responder.id, cardId:context.card?.id ?? null, legalCardIds:availableCards.map((entry) => entry.id), requiredCount:1,
      legalSkillIds:[], timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true, presentation };
    activeRequestIds.add(request.id); runtime.pushPendingResponse(request);
    const decision = await waitForDecision(responder, request, presentation.buttonLabel, context, availableCards);
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId) && isResponderEligible(responder) && cardToUse && responder.hand.includes(cardToUse);
    finishRequest(request.id);
    if (isCancelledResponse(decision) || !runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (unavailableAfterTiming) return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
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
  执行借势强制突袭 response window；确认后返回同一实体，由 ActionWorkflow.playCard 走普通突袭流程。

  调用方
  CardIntentRuntime leverage workflow。

  输入
  responder、target 与 context。

  输出
  USED/DECLINED/CANCELLED/INVALID/UNAVAILABLE。

  读取状态
  responder/target、合法突袭实体与 session。

  写入状态
  pendingResponses 与 choice registry；不在此消费牌。

  调用函数
  isCardResponseImpossibleFromPublicInfo、buildResponsePresentation、waitForDecision、runtime.canUseForcedAssault。

  边界与不变量
  公开空手时直接结束；否则真人无合法突袭不创建窗口，AI 仍经 timing decorator 等待，避免手牌侧信道。
  */
  async function requestLeverageAssault(responder, target, context = {}) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED, { card:null });
    if (!responder?.alive || !target?.alive || runtime.getState().isGameOver) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    if (isCardResponseImpossibleFromPublicInfo(responder, 1)) {
      return responseResult(RESPONSE_STATUS.UNAVAILABLE, { card:null });
    }
    const availableCards = runtime.getUsableAssaultCards(responder, target);
    if (!hasSufficientResponseCards(availableCards.length, 1)
      && shouldRejectResponseWithoutLegalOptions(responder)) {
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
      ? (decision.selectedIds?.[0] ?? availableCards[0]?.id)
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
  SkillRuntime 护援入口。

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
  actor 始终是 responder；targetPlayerId 必须指向 context.target，skill 效果仍由 SkillRuntime 执行。
  */
  async function requestSkillResponse(responder, skillId, responseName, context) {
    const gameId = runtime.getState().gameId;
    if (!runtime.isSessionValid(gameId)) return responseResult(RESPONSE_STATUS.CANCELLED);
    if (!responder.alive || !context.target?.alive || responder.id === context.target.id
      || runtime.getState().isGameOver) return responseResult(RESPONSE_STATUS.UNAVAILABLE);
    const buttonLabel = `发动「${responseName}」`;
    const request = { id:runtime.createId("skill-response"), type:"skill", sourcePlayerId:context.source?.id ?? null,
      targetPlayerId:context.target?.id ?? responder.id, cardId:context.card?.id ?? null, legalCardIds:[], legalSkillIds:[skillId],
      requiredCount:0, timeoutMs:runtime.getResponseTimeoutMs(), allowDecline:true,
      presentation:buildResponsePresentation(responder, "skill", { ...context, responseName, buttonLabel }, 0, 0, buttonLabel) };
    activeRequestIds.add(request.id); runtime.pushPendingResponse(request);
    const decision = await waitForDecision(responder, request, buttonLabel, context, []);
    const valid = activeRequestIds.has(request.id) && runtime.isSessionValid(gameId)
      && responder.alive && context.target.alive && responder.id !== context.target.id;
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
  MatchWorkflow.dispose/restart。

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
    getBlockRequirement,
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
