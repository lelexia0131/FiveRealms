/*
模块职责
单局应用的唯一 composition root：创建状态、适配器与 Application workflows，并暴露 UI/测试使用的应用边界。

上游
main.js、headless tests 与 balance harness。

下游
Application、Domain、AI 与 concrete adapters。

状态边界
只创建 MatchState 并装配显式能力；业务写入由 Application workflows 与 Domain transitions 拥有。

信息边界
真人/AI 私密选择只经 choice 与 knowledge adapters；composition 不读取未知牌进行决策。

架构约束
不得重新拥有动作、响应、濒死、判定、资源或规则公式；不得增加第二套业务 boundary 或 Game shell class。
*/
import { RUNTIME_POLICY } from "../application/policy/RuntimePolicy.js?build=20260818-skill-rules-locality-refactor";
import { AI_RUNTIME_POLICY } from "../ai/policy/AiRuntimePolicy.js?build=20260818-skill-rules-locality-refactor";
import { TEAM_PRESENTATION } from "../adapters/ui/PresentationMetadata.js?build=20260818-skill-rules-locality-refactor";
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { createId } from "../utils/helpers.js?build=20260818-skill-rules-locality-refactor";
import { EventDispatcher } from "../application/messaging/EventDispatcher.js?build=20260818-skill-rules-locality-refactor";
import { Player } from "../application/match/Player.js?build=20260818-skill-rules-locality-refactor";
import { Deck } from "../application/match/Deck.js?build=20260818-skill-rules-locality-refactor";
import { TeamAssignment } from "../application/match/TeamAssignment.js?build=20260818-skill-rules-locality-refactor";
import { CharacterSelection } from "../application/match/CharacterSelection.js?build=20260818-skill-rules-locality-refactor";
import { createTeamRuleQueries } from "../application/match/TeamRuleQueries.js?build=20260818-skill-rules-locality-refactor";
import { ActionLegality } from "../application/action/ActionLegality.js?build=20260818-skill-rules-locality-refactor";
import { createResponseWorkflow } from "../application/response/ResponseWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { MatchLogAdapter } from "../adapters/ui/MatchLogAdapter.js?build=20260818-skill-rules-locality-refactor";
import { canUseActiveSkill, getActiveSkill, getActiveSkillCost } from "../application/action/SkillRuntime.js?build=20260818-skill-rules-locality-refactor";
import { AIController } from "../ai/AiController.js?build=20260818-skill-rules-locality-refactor";
import { hashSearchSeed, SearchRng } from "../ai/search/SearchRng.js?build=20260818-skill-rules-locality-refactor";
import { createSearchExecutor } from "../adapters/ai/worker/createSearchExecutor.js?build=20260818-skill-rules-locality-refactor";
import { CleanupManager } from "../utils/CleanupManager.js?build=20260818-skill-rules-locality-refactor";
import { getAiDelay } from "../utils/aiTiming.js?build=20260818-skill-rules-locality-refactor";
import { Debug } from "../utils/debug.js?build=20260818-skill-rules-locality-refactor";
import { createDyingWorkflow } from "../application/combat/DyingWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createJudgmentWorkflow } from "../application/judgment/JudgmentWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createStatusResolutionWorkflow } from "../application/judgment/StatusResolutionWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { HiddenCardSelectionAdapter } from "../adapters/ui/HiddenCardSelectionAdapter.js?build=20260818-skill-rules-locality-refactor";
import { createHiddenCardChoiceWorkflow } from "../application/action/HiddenCardChoiceWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createChoiceBoundary } from "./createChoiceBoundary.js?build=20260818-skill-rules-locality-refactor";
import { createRandomPort } from "../application/ports/RandomPort.js?build=20260818-skill-rules-locality-refactor";
import { createGamePresentationAdapter } from "../adapters/ui/GamePresentationAdapter.js?build=20260818-skill-rules-locality-refactor";
import { createPlayerStatisticsDiagnosticsAdapter } from "../adapters/diagnostics/PlayerStatisticsDiagnosticsAdapter.js?build=20260818-skill-rules-locality-refactor";
import { createRecentAggressorsObservationAdapter } from "../adapters/ai/RecentAggressorsObservationAdapter.js?build=20260818-skill-rules-locality-refactor";
import { createCombatWorkflow } from "../application/combat/CombatWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createMatchWorkflow } from "../application/match/MatchWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createTurnWorkflow } from "../application/turn/TurnWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createActionWorkflow } from "../application/action/ActionWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createCardRuntime } from "../application/action/CardRuntime.js?build=20260818-skill-rules-locality-refactor";
import { getActionLogMessage as getActionLogMessageFromRuntime, getActionTargetLabel as getActionTargetLabelFromRuntime, resolveActionDisplayTargets, shouldSuppressUseLog as shouldSuppressUseLogFromRuntime } from "../application/action/ActionPresentation.js?build=20260818-skill-rules-locality-refactor";
import { createCardIntentRuntime } from "../application/action/CardIntentRuntime.js?build=20260818-skill-rules-locality-refactor";
import { isTransferExecutionAllowed } from "../adapters/ai/TransferExecutionPolicyAdapter.js?build=20260818-skill-rules-locality-refactor";
import { createCardEffectRuntime } from "../application/action/CardEffectRuntime.js?build=20260818-skill-rules-locality-refactor";
import { createSkillEffectRuntime } from "../application/action/SkillEffectRuntime.js?build=20260818-skill-rules-locality-refactor";
import { createPassiveSkillTriggerRegistry } from "../application/trigger/PassiveSkillTriggerRegistry.js?build=20260818-skill-rules-locality-refactor";
import { createRecycleDeviceTrigger } from "../application/trigger/RecycleDeviceTrigger.js?build=20260818-skill-rules-locality-refactor";
import { createGlobalTriggerRegistry } from "../application/trigger/GlobalTriggerRegistry.js?build=20260818-skill-rules-locality-refactor";
import { PublicCardPoolWorkflow } from "../application/action/PublicCardPoolWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createResourceWorkflow } from "../application/action/ResourceWorkflow.js?build=20260818-skill-rules-locality-refactor";
import { createCardKnowledgeAdapter } from "../adapters/ai/CardKnowledgeAdapter.js?build=20260818-skill-rules-locality-refactor";
import { createMatchState } from "../domain/state/model/MatchState.js?build=20260818-skill-rules-locality-refactor";
import { getCurrentActor, getAllies as getAlliesFromState, getEnemies as getEnemiesFromState, getSeatOrderFrom } from "../domain/state/queries/MatchQueries.js?build=20260818-skill-rules-locality-refactor";
import { addTrackingTarget, markCategoryUsed, setGuardianAidUsed, setKillRewardGranted, setLastEmberResolutionId, setMomentum, setSpyGapPendingTargetIds, setTrackingTurnNumber } from "../domain/state/transitions/RuleUsageTransitions.js?build=20260818-skill-rules-locality-refactor";

/*
功能
按 Card identity 在 runtime 全部规则区域中查找实体。

调用方
Game composition 的 Presentation adapter。

输入
cardId。

输出
Card entity 或 null。

读取状态
state deck zones、players hand/equipment 与 publicCardPool。

写入状态
无。

调用函数
Array.find。

边界与不变量
保持同一 Card 引用；用于把 Application 的 data-only cardId 映射回 UI 既有实体展示契约。
*/
function findCardEntity(game, cardId) {
  if (!cardId) return null;
  const zones = [
    game.state.deck.cards,
    game.state.deck.discardPile,
    game.state.deck.resolvingCards,
    game.state.deck.judgmentZone,
    game.state.publicCardPool ?? [],
    game.publicCardPoolWorkflow?.cards
  ].filter(Boolean);
  for (const zone of zones) {
    const found = zone.find((card) => card.id === cardId);
    if (found) return found;
  }
  for (const player of game.state.players) {
    const fromHand = player.hand.find((card) => card.id === cardId);
    if (fromHand) return fromHand;
    if (player.equipment?.id === cardId) return player.equipment;
  }
  return null;
}

/*
功能
把已构造的 workflows、queries 与 adapters 组合成单局公开 application boundary。

调用方
MatchApplication constructor。

输入
已完成依赖装配的 application 实例。

输出
同一 application 实例。

读取状态
workflow/adapters 与 MatchState。

写入状态
定义只读 projections，并安装直接 capability references。

调用函数
Object.defineProperties、Object.assign。

边界与不变量
只做 public boundary assembly；不复制 workflow、规则或 transition body，直接暴露最终 owner 的 capability。
*/
function assembleApplicationBoundary(application) {
  Object.defineProperties(application, {
    currentPlayer: {
      get: () => getCurrentActor(application.state),
      configurable:false
    },
    candidates: {
      get: () => application.matchWorkflow.candidates,
      configurable:false
    }
  });
  Object.assign(application, {
    /*
    功能
    更新或清理 setAnimationFastMode 对应的 createGameApplication 状态。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    setAnimationFastMode(enabled) {
      application.animationFastMode = Boolean(enabled);
      application.ui.setFastMode?.(application.animationFastMode);
      return application.animationFastMode;
    },
    startSelection:application.matchWorkflow.startSelection,
    confirmCharacter:application.matchWorkflow.confirmCharacter,
    /*
    功能
    执行 registerGlobalRules 对应的 createGameApplication 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    registerGlobalRules() {
      application.recycleDeviceTrigger.register();
      application.globalTriggerRegistry.register();
    },
    runGameLoop:application.turnWorkflow.runGameLoop,
    takeTurn:application.turnWorkflow.takeTurn,
    takeAiPlayPhase:application.turnWorkflow.takeAiPlayPhase,
    handleDiscardPhase:application.turnWorkflow.handleDiscardPhase,
    advanceTurn:application.turnWorkflow.advanceTurn,
    prepareTransferIntent:application.cardIntentRuntime.prepareTransferIntent,
    prepareLeverageIntent:application.cardIntentRuntime.prepareLeverageIntent,
    preparePrivateCardSelectionIntent:application.cardIntentRuntime.preparePrivateCardSelectionIntent,
    preparePrivateHandPeekIntent:application.cardIntentRuntime.preparePrivateHandPeekIntent,
    resolvePrivateHandPeekIntent:application.cardIntentRuntime.resolvePrivateHandPeekIntent,
    resolveLeverage:application.cardIntentRuntime.resolveLeverage,
    playCard:application.actionWorkflow.playCard,
    useActiveSkill:application.actionWorkflow.useActiveSkill,
    handleHumanCard:application.actionWorkflow.handleHumanCard,
    handleHumanSkill:application.actionWorkflow.handleHumanSkill,
    requestEndHumanPlay:application.actionWorkflow.requestEndHumanPlay,
    requestHumanPlayEndForDefeat:application.actionWorkflow.requestHumanPlayEndForDefeat,
    flushPendingHumanPlayEnd:application.actionWorkflow.flushPendingHumanPlayEnd,
    damage:application.combatWorkflow.damage,
    heal:application.combatWorkflow.heal,
    gainEnergy:application.resourceWorkflow.gainEnergy,
    killPlayer:application.dyingWorkflow.enter,
    checkVictory:application.matchWorkflow.checkVictory,
    drawCards:application.resourceWorkflow.drawCards,
    discardCardFromHand:application.resourceWorkflow.discardCardFromHand,
    payCardsFromHandAtomically:application.resourceWorkflow.payCardsFromHandAtomically,
    moveCardBetweenHands:application.resourceWorkflow.moveCardBetweenHands,
    moveEquipmentToHand:application.resourceWorkflow.moveEquipmentToHand,
    discardEquipment:application.resourceWorkflow.discardEquipment,
    moveHandToResolving:application.resourceWorkflow.moveHandToResolving,
    finishResolvingToDiscard:application.resourceWorkflow.finishResolvingToDiscard,
    equipCard:application.resourceWorkflow.equipCard,
    getCardZoneOccurrences:application.resourceWorkflow.getCardZoneOccurrences,
    isCardCommittedToDiscard:application.resourceWorkflow.isCardCommittedToDiscard,
    isCardCommittedToEquipment:application.resourceWorkflow.isCardCommittedToEquipment,
    cleanupFailedResolution:application.resourceWorkflow.cleanupFailedResolution,
    getEnemies:(player) => getEnemiesFromState(application.state, player),
    getAllies:(player) => getAlliesFromState(application.state, player),
    cleanupDefeatedZones:application.resourceWorkflow.cleanupDefeatedZones,
    seatOrderFrom:(source, includeSource = false) => getSeatOrderFrom(application.state, source, includeSource),
    invalidateCardKnowledge:application.cardKnowledge.invalidate,
    rememberPrivateCard:application.cardKnowledge.remember,
    isCardKnownTo:application.cardKnowledge.isKnownTo,
    cardLabelForHuman:application.cardKnowledge.labelForHuman,
    chooseHiddenCards:application.hiddenCardChoiceWorkflow.chooseHiddenCards,
    choosePlayerZoneCard:application.hiddenCardChoiceWorkflow.choosePlayerZoneCard,
    /*
    功能
    执行 log 对应的 createGameApplication 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    log(message, kind = "normal") {
      if (!application.isSessionValid(application.state.gameId)) return null;
      return application.matchLogAdapter.add(message, kind);
    },
    /*
    功能
    更新或清理 syncDeckAliases 对应的 createGameApplication 状态。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    syncDeckAliases() {
      application.state.discardPile = application.state.deck.discardPile;
      application.state.resolvingCards = application.state.deck.resolvingCards;
      application.state.judgmentZone = application.state.deck.judgmentZone;
    },
    /*
    功能
    判断 isSessionValid 对应的 createGameApplication 条件。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    isSessionValid(gameId) {
      const ownsUi = typeof application.ui?.isSessionCurrent !== "function" || application.ui.isSessionCurrent();
      return !application.state.isDisposed && application.state.gameId === gameId && ownsUi;
    },
    /*
    功能
    更新或清理 dispose 对应的 createGameApplication 状态。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    dispose() {
      const result = application.matchWorkflow.dispose();
      application.searchExecutor?.dispose?.();
      return result;
    }
  });
  return application;
}

class MatchApplication {
  /*
  功能
  创建一局 MatchApplication 并组合 Domain MatchState 与 Application session 状态。

  调用方
  main.js 与测试 fixture。

  输入
  UI 实例、可替换真实游戏随机源与可选 choice/search/presentationRandom 注入项。

  输出
  已完成 service 组合但尚未发牌/启动的 Game 实例。

  读取状态
  无既有状态。

  写入状态
  写入 MatchApplication services、Domain MatchState 组合与 session 字段。

  调用函数
  createMatchState、CleanupManager、CharacterSelection、Deck、各 core service 与 AIController 构造。

  边界与不变量
  领域字段值只来自 createMatchState；presentationRandom 不复用真实游戏或 AI search RNG；gameId/isDisposed/logs/pendingResponses 属于 Application session；stateVersion 保持 authoritative。
  */
  constructor(ui, random = Math.random, options = {}) {
    this.randomPort = createRandomPort({ next: () => random() });
    this.random = () => this.randomPort.next();
    this.presentationRandom = typeof options.presentationRandom === "function"
      ? options.presentationRandom
      : Math.random;
    this.cleanupManager = new CleanupManager();
    this.characterSelection = new CharacterSelection(this.random);
    const deck = new Deck(this.random, (channel, message, data) => Debug.log(channel, message, data));
    const matchState = createMatchState({ deck });
    this.state = {
      gameId: createId("game"),
      players: matchState.players,
      deck: matchState.deck,
      discardPile: deck.discardPile,
      resolvingCards: deck.resolvingCards,
      judgmentZone: deck.judgmentZone,
      currentPlayerIndex: matchState.currentPlayerIndex,
      startingPlayerIndex: matchState.startingPlayerIndex,
      currentRound: matchState.currentRound,
      phase: matchState.phase,
      pendingAction: null,
      pendingResponses: [],
      activeEffects: [],
      selectedCharacterId: null,
      winnerTeam: matchState.winnerTeam,
      publicCardPool: matchState.publicCardPool,
      currentJudgment: null,
      dyingContext: null,
      isGameOver: matchState.isGameOver,
      isDisposed: false,
      logs: [],
      debugHistory: [],
      resolutionSerial: 0,
      stateVersion: matchState.stateVersion
    };
    this.uiManager = ui;
    this.ui = ui.createGameSession?.(this) ?? ui;
    this.eventDispatcher = new EventDispatcher(() => this.isSessionValid(this.state.gameId), (channel, message, data) => Debug.log(channel, message, data));
    this.matchLogAdapter = new MatchLogAdapter(this.state, this.ui);
    this.choiceContexts = new Map();
    this.teamRules = createTeamRuleQueries(() => this.state);
    this.cardKnowledge = createCardKnowledgeAdapter(() => this.state.players);
    this.aiRandom = new SearchRng(options.aiSearchSeed ?? hashSearchSeed(this.state.gameId));
    this.searchExecutor = createSearchExecutor({
      explicitExecutor: options.searchExecutor ?? null,
      forceLocal: options.forceLocalSearch === true
    });
    this.aiController = new AIController({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      getMaxEnergy: (player) => this.teamRules.getMaxEnergy(player),
      getTurnEnergyBreakdown: (player) => this.teamRules.getTurnEnergyBreakdown(player),
      getDifficultyMultiplier: () => this.aiDifficultyMultiplier,
      getRandomnessRange: () => this.aiRandomnessRange,
      getSearchTimeBudget: () => this.aiSearchBudgetOverrideMs,
      getSearchNodeBudget: () => this.aiSearchNodeBudgetOverride,
      getEnemies: (player) => this.getEnemies(player),
      getDyingRescueOrder: (target) => this.dyingWorkflow
        ? this.dyingWorkflow.rescueOrder(target)
        : [],
      isSmallTeam: (player) => this.teamRules.isSmallTeam(player),
      getForceAiRescueHuman: () => this.forceAiRescueHuman ?? AI_RUNTIME_POLICY.forceAiRescueHuman,
      getSearchMode: () => this.animationFastMode ? "FAST" : "NORMAL",
      yieldControl: async (gameId) => (
        await this.cleanupManager.delay(0)
      ) && this.isSessionValid(gameId ?? this.state.gameId),
      createId,
      searchRng: this.aiRandom,
      searchExecutor: this.searchExecutor
    });
    const choiceBoundary = createChoiceBoundary({
      state: this.state,
      ui: this.ui,
      choiceContexts: this.choiceContexts,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      shouldRespond: (responder, type, context, cards) => this.aiController.shouldRespond(responder, type, context, cards),
      choosePublicCard: (player, cards) => this.aiController.choosePublicCard(player, cards),
      chooseDiscards: (player, count) => this.aiController.chooseDiscards(player, count),
      cleanupDelay: (ms) => this.cleanupManager.delay(ms),
      getAiResponseDelay: () => getAiDelay(this, "response")
    }, options.choicePort ?? null);
    this.choicePort = choiceBoundary.choicePort;
    this.choiceCoordinator = choiceBoundary.choiceCoordinator;
    this.responseWorkflow = createResponseWorkflow({
      choiceCoordinator:this.choiceCoordinator,
      choiceContexts:this.choiceContexts,
      getState:() => this.state,
      isSessionValid:(gameId) => this.isSessionValid(gameId),
      pushPendingResponse:(request) => this.state.pendingResponses.push(request),
      removePendingResponse:(id) => {
        if (!this.state.isDisposed) this.state.pendingResponses = this.state.pendingResponses.filter((request) => request.id !== id);
      },
      clearPendingResponses:() => { this.state.pendingResponses = []; },
      payCardsFromHandAtomically:(...args) => this.resourceWorkflow.payCardsFromHandAtomically(...args),
      setCurrentCard:(...args) => this.ui.setCurrentCard?.(...args),
      log:(message, kind = "normal") => this.log(message, kind),
      emitCardUsed:(payload) => this.eventDispatcher.emit("cardUsed", payload),
      getForceAiRescueHuman:() => this.forceAiRescueHuman ?? AI_RUNTIME_POLICY.forceAiRescueHuman,
      setThinking:(isThinking, player, message) => this.ui.setThinking(isThinking, player, message),
      delayResponse:async () => this.cleanupManager.delay(getAiDelay(this, "response")),
      getUsableAssaultCards:(responder, target) => ActionLegality.getUsableAssaultCards(this, responder, target),
      canUseForcedAssault:(responder, card, target) => ActionLegality.canUseForcedAssault(this, responder, card, target),
      getResponseTimeoutMs:() => RUNTIME_POLICY.responseTimeoutMs,
      createId
    });
    this.hiddenCardSelection = new HiddenCardSelectionAdapter(() => this.state.players);
    this.hiddenCardChoiceWorkflow = createHiddenCardChoiceWorkflow({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      hiddenSelection: this.hiddenCardSelection,
      requestHiddenCards: (...args) => this.ui.requestHiddenCards?.(...args),
      requestZoneCard: (...args) => this.ui.requestZoneCard?.(this, ...args),
      chooseAiHiddenCards: (...args) => this.aiController.chooseHiddenCards(...args),
      chooseAiZoneCard: (...args) => this.aiController.chooseZoneCard(...args)
    });
    const aiObservation = createRecentAggressorsObservationAdapter();
    this.presentationPort = createGamePresentationAdapter({
      log: (message, kind) => this.log(message, kind),
      getPlayerById: (playerId) => this.state.players.find((player) => player.id === playerId),
      getCardById: (cardId) => findCardEntity(this, cardId),
      ui: this.ui,
      renderTarget: this
    });
    this.diagnosticsPort = createPlayerStatisticsDiagnosticsAdapter({
      getPlayerById: (playerId) => this.state.players.find((player) => player.id === playerId)
    });
    this.combatWorkflow = createCombatWorkflow({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      askForBlock: (...args) => this.responseWorkflow.askForBlock(...args),
      judgeDefense: (...args) => this.judgmentWorkflow
        ? this.judgmentWorkflow.judgeDefense(...args)
        : Promise.resolve({ handled: false, immune: false }),
      enterDying: (...args) => this.dyingWorkflow
        ? this.dyingWorkflow.enter(...args)
        : Promise.resolve(false),
      emitEvent: (type, payload) => this.eventDispatcher.emit(type, payload),
      createId,
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      observeDamage: (...args) => aiObservation.observeDamage(...args)
    });
    const judgmentWorkflow = createJudgmentWorkflow({
      getState:() => this.state,
      isSessionValid:(gameId) => this.isSessionValid(gameId),
      emitEvent:(type, payload) => this.eventDispatcher.emit(type, payload),
      drawJudgmentCard:() => {
        const card = this.state.deck.drawToJudgment(this.state);
        this.syncDeckAliases();
        return card;
      },
      syncDeckAliases:() => this.syncDeckAliases(),
      moveJudgmentToDiscard:(card) => this.state.deck.finishJudgmentToDiscard(this.state, card),
      moveJudgmentToHand:(card, player) => this.state.deck.finishJudgmentToHand(this.state, card, player),
      observeJudgmentCard:(viewer, owner, card) => this.cardKnowledge.remember(viewer, owner, card),
      presentation:this.presentationPort,
      setCurrentJudgmentProjection:(value) => { this.state.currentJudgment = value; }
    });
    const statusWorkflow = createStatusResolutionWorkflow({
      getState:() => this.state,
      isSessionValid:(gameId) => this.isSessionValid(gameId),
      askForStatusCounter:(...args) => this.responseWorkflow.askForStatusCounter(...args),
      judgeSeal:(...args) => judgmentWorkflow.judgeSeal(...args),
      judgeLightning:(...args) => judgmentWorkflow.judgeLightning(...args),
      damage:(...args) => this.combatWorkflow.damage(...args),
      presentation:this.presentationPort
    });
    this.judgmentWorkflow = Object.freeze({
      /*
      功能
      执行 currentJudgment 对应的 createGameApplication 职责。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
      */
      get currentJudgment() { return judgmentWorkflow.currentJudgment; },
      judgeDefense:(...args) => judgmentWorkflow.judgeDefense(...args),
      judgeDelayedStatus:(...args) => judgmentWorkflow.judgeDelayedStatus(...args),
      judgeLightning:(...args) => judgmentWorkflow.judgeLightning(...args),
      judgeSeal:(...args) => judgmentWorkflow.judgeSeal(...args),
      resolveSeal:(...args) => statusWorkflow.resolveSeal(...args),
      resolveLightning:(...args) => statusWorkflow.resolveLightning(...args)
    });
    this.dyingWorkflow = createDyingWorkflow({
      getState:() => this.state,
      isSessionValid:(gameId) => this.isSessionValid(gameId),
      emitEvent:(type, payload) => this.eventDispatcher.emit(type, payload),
      requestDyingRescue:(...args) => this.responseWorkflow.requestDyingRescue(...args),
      heal:(...args) => this.combatWorkflow.heal(...args),
      discardCardFromHand:(...args) => this.resourceWorkflow.discardCardFromHand(...args),
      drawCards:(...args) => this.resourceWorkflow.drawCards(...args),
      syncDeckAliases:() => this.syncDeckAliases(),
      requestHumanPlayEndForDefeat:(target) => this.actionWorkflow.requestHumanPlayEndForDefeat(target),
      checkVictory:() => this.matchWorkflow.checkVictory(),
      createId,
      presentation:this.presentationPort,
      setDyingContextProjection:(value) => { this.state.dyingContext = value; }
    });
    this.animationFastMode = RUNTIME_POLICY.animationFastMode;
    this.simulationMode = RUNTIME_POLICY.simulationMode;
    this.aiReplanAfterEveryAction = AI_RUNTIME_POLICY.replanAfterEveryAction;
    this.aiRandomnessRange = AI_RUNTIME_POLICY.randomnessRange;
    this.aiDifficultyMultiplier = AI_RUNTIME_POLICY.difficultyMultiplier;
    this.aiMaxActionsPerTurn = AI_RUNTIME_POLICY.maxActionsPerTurn;
    this.resourceWorkflow = createResourceWorkflow({
      getState:() => this.state,
      isSessionValid:(gameId) => this.isSessionValid(gameId),
      emitEvent:(type, payload) => this.eventDispatcher.emit(type, payload),
      log:(message, kind) => this.log(message, kind),
      queueFeedback:(...args) => this.ui.queueFeedback?.(...args),
      render:() => this.ui.render(this),
      syncDeckAliases:() => this.syncDeckAliases(),
      knowledge:this.cardKnowledge,
      getActionWorkflow:() => this.actionWorkflow,
      getPublicPoolCards:() => this.publicCardPoolWorkflow?.cards ?? null,
      trace:(channel, message, data) => Debug.log(channel, message, data)
    });
    this.publicCardPoolWorkflow = new PublicCardPoolWorkflow({
      getState:() => this.state,
      isSessionValid:(gameId) => this.isSessionValid(gameId),
      syncDeckAliases:() => this.syncDeckAliases(),
      ui:this.ui,
      seatOrderFrom:(...args) => getSeatOrderFrom(this.state, ...args),
      rememberPrivateCard:(...args) => this.cardKnowledge.remember(...args),
      log:(...args) => this.log(...args),
      renderTarget:() => this,
      choiceContexts:this.choiceContexts,
      choiceCoordinator:this.choiceCoordinator
    });
    /*
    功能
    按 playerId 返回 Application Player 引用。

    调用方
    本构造函数的 adapter wiring。

    输入
    playerId。

    输出
    Player 或 null。

    读取状态
    state.players。

    写入状态
    无。

    调用函数
    Array.find。

    边界与不变量
    只用于 concrete adapter rebind，不供 Application 使用。
    */
    const getPlayerById = (playerId) => this.state.players.find((player) => player.id === playerId);
    this.globalTriggerRegistry = createGlobalTriggerRegistry({
      onEvent: (eventName, key, handler) => this.eventDispatcher.on(eventName, key, handler),
      getState: () => this.state,
      cleanupHuntMarksForSource: (sourceId) => this.dyingWorkflow.cleanupHuntMarksForSource(sourceId),
      resolveSeal: (holder, status) => this.judgmentWorkflow.resolveSeal(holder, status),
      resolveLightning: (holder, status) => this.judgmentWorkflow.resolveLightning(holder, status)
    });
    this.recycleDeviceTrigger = createRecycleDeviceTrigger({
      onEvent: (eventName, key, handler) => this.eventDispatcher.on(eventName, key, handler),
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      drawCards: (...args) => this.drawCards(...args)
    });
    this.passiveTriggerRegistry = createPassiveSkillTriggerRegistry({
      onEvent: (eventName, key, handler) => this.eventDispatcher.on(eventName, key, handler),
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      random: () => this.random(),
      responseWorkflow: this.responseWorkflow,
      discardCardFromHand: (...args) => this.discardCardFromHand(...args),
      drawCards: (...args) => this.drawCards(...args),
      gainEnergy: (...args) => this.gainEnergy(...args),
      preparePrivateHandPeekIntent: (...args) => this.cardIntentRuntime.preparePrivateHandPeekIntent(...args),
      resolvePrivateHandPeekIntent: (...args) => this.cardIntentRuntime.resolvePrivateHandPeekIntent(...args),
      rememberPrivateCard: (...args) => this.rememberPrivateCard(...args),
      choiceCoordinator: this.choiceCoordinator,
      choiceContexts: this.choiceContexts,
      createId
    });
    this.skillEffectRuntime = createSkillEffectRuntime({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      heal: (...args) => this.heal(...args),
      damage: (...args) => this.damage(...args),
      drawCards: (...args) => this.drawCards(...args),
      moveEquipmentToHand: (...args) => this.moveEquipmentToHand(...args),
      moveCardBetweenHands: (...args) => this.moveCardBetweenHands(...args),
      cardLabelForHuman: (...args) => this.cardLabelForHuman(...args),
      getEnemies: (...args) => this.getEnemies(...args),
      random: () => this.random()
    });
    this.cardEffectRuntime = createCardEffectRuntime({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      damage: (...args) => this.damage(...args),
      heal: (...args) => this.heal(...args),
      gainEnergy: (...args) => this.gainEnergy(...args),
      drawCards: (...args) => this.drawCards(...args),
      equipCard: (...args) => this.equipCard(...args),
      moveCardBetweenHands: (...args) => this.moveCardBetweenHands(...args),
      moveEquipmentToHand: (...args) => this.moveEquipmentToHand(...args),
      discardEquipment: (...args) => this.discardEquipment(...args),
      discardCardFromHand: (...args) => this.discardCardFromHand(...args),
      rememberPrivateCard: (...args) => this.rememberPrivateCard(...args),
      cardLabelForHuman: (...args) => this.cardLabelForHuman(...args),
      seatOrderFrom: (...args) => this.seatOrderFrom(...args),
      getEnemies: (...args) => this.getEnemies(...args),
      responseWorkflow: this.responseWorkflow,
      publicCardPool: this.publicCardPoolWorkflow,
      resolveLeverage: (...args) => this.cardIntentRuntime.resolveLeverage(...args),
      getCardTargets: (source, card) => ActionLegality.getCardTargets(this, source, card),
      getTransferSources: (source, card) => ActionLegality.getTransferSources(this, source, card),
      getTransferReceivers: (source, from, card) => ActionLegality.getTransferReceivers(this, source, from, card),
      diagnostics: this.diagnosticsPort,
      random: () => this.random(),
      createId
    });
    this.cardIntentRuntime = createCardIntentRuntime({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      responseWorkflow: this.responseWorkflow,
      playCard: (...args) => this.actionWorkflow.playCard(...args),
      moveEquipmentToHand: (...args) => this.moveEquipmentToHand(...args),
      getTransferSources: (source, card, excludedCardIds) => ActionLegality.getTransferSources(this, source, card, excludedCardIds),
      getTransferReceivers: (source, from, card) => ActionLegality.getTransferReceivers(this, source, from, card),
      getCardTargets: (source, card) => ActionLegality.getCardTargets(this, source, card),
      getLeverageFirstTargets: (source) => ActionLegality.getLeverageFirstTargets(this, source),
      getAssaultTargetCandidates: (source) => ActionLegality.getAssaultTargetCandidates(this, source),
      isTransferExecutionAllowed,
      chooseTransferCombination: (...args) => this.aiController.chooseTransferCombination(...args),
      chooseHiddenCards: (...args) => this.hiddenCardChoiceWorkflow.chooseHiddenCards(...args),
      choosePlayerZoneCard: (...args) => this.hiddenCardChoiceWorkflow.choosePlayerZoneCard(...args),
      choosePrivatePeekCards: (...args) => this.hiddenCardChoiceWorkflow.choosePrivateHandPeekCards(...args),
      requestHiddenCards: (...args) => this.ui.requestHiddenCards?.(...args),
      createHiddenSelection: (...args) => this.hiddenCardSelection.createHiddenSelection(...args),
      resolveConfirmedTokens: (...args) => this.hiddenCardSelection.resolveConfirmedTokens(...args),
      clearSelection: (...args) => this.hiddenCardSelection.clearSelection(...args)
    });
    this.cardRuntime = createCardRuntime({
      getState: () => this.state,
      canPlayCard: (source, card) => ActionLegality.canPlayCard(this, source, card),
      canUseForcedAssault: (source, card, target) => ActionLegality.canUseForcedAssault(this, source, card, target),
      getCardTargets: (source, card) => ActionLegality.getCardTargets(this, source, card),
      getAssaultTargetCandidates: (source) => ActionLegality.getAssaultTargetCandidates(this, source),
      prepareTransferIntent: (...args) => this.cardIntentRuntime.prepareTransferIntent(...args),
      prepareLeverageIntent: (...args) => this.cardIntentRuntime.prepareLeverageIntent(...args),
      preparePrivateCardSelectionIntent: (...args) => this.cardIntentRuntime.preparePrivateCardSelectionIntent(...args),
      resolveCardEffect: (...args) => this.cardEffectRuntime.resolve(...args),
      getActionTargetLabel: (source, cardOrSkill, targets, selection) => getActionTargetLabelFromRuntime(this.state, source, cardOrSkill, targets, selection),
      getActionLogMessage: (source, card, targets) => getActionLogMessageFromRuntime(source, card, targets),
      shouldSuppressUseLog: (definitionId) => shouldSuppressUseLogFromRuntime(definitionId)
    });
    this.actionWorkflow = createActionWorkflow({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      emitEvent: (type, payload) => this.eventDispatcher.emit(type, payload),
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      responseWorkflow: this.responseWorkflow,
      cardRuntime: this.cardRuntime,
      canPlayCard: (source, card) => ActionLegality.canPlayCard(this, source, card),
      getCardTargets: (source, card) => ActionLegality.getCardTargets(this, source, card),
      moveHandToResolving: (...args) => this.moveHandToResolving(...args),
      finishResolvingToDiscard: (...args) => this.finishResolvingToDiscard(...args),
      isCardCommittedToDiscard: (card) => this.isCardCommittedToDiscard(card),
      isCardCommittedToEquipment: (player, card) => this.isCardCommittedToEquipment(player, card),
      cleanupFailedResolution: (...args) => this.cleanupFailedResolution(...args),
      clearSelection: (selectionId) => this.hiddenCardSelection.clearSelection(selectionId),
      getActionDisplayTargets: (source, cardOrSkill, targets) => resolveActionDisplayTargets(this.state, source, cardOrSkill, targets),
      getActionTargetLabel: (source, cardOrSkill, targets, selection) => getActionTargetLabelFromRuntime(this.state, source, cardOrSkill, targets, selection),
      skillRuntime: {
        getActiveSkill: (source) => getActiveSkill(source),
        getCost: (source, skill) => getActiveSkillCost(this, source, skill),
        canUse: (source, skill, cost = null) => canUseActiveSkill(this, source, skill, cost),
        execute: (skill, source, targets, context) => this.skillEffectRuntime.execute(skill, source, targets, context)
      },
      getSkillTargets: (source, skill) => ActionLegality.getSkillTargets(this, source, skill),
      getHumanPlayer: () => this.state.players[0],
      choiceCoordinator: this.choiceCoordinator,
      choiceContexts: this.choiceContexts,
      requestCardFlow: (actor, card, targets) => this.ui.requestCardFlow?.(this, actor, card, targets),
      resolveHumanPlayEnd: (gameId) => this.ui.resolveHumanPlayEnd(gameId),
      createId,
      setResolutionSerialProjection: (value) => { this.state.resolutionSerial = value; }
    });
    Object.defineProperties(this, {
      actionLocked: {
        get: () => this.actionWorkflow.getActionStateSnapshot().actionLocked,
        configurable: false
      },
      interactionLocked: {
        get: () => this.actionWorkflow.getActionStateSnapshot().interactionLocked,
        configurable: false
      },
      pendingHumanPlayEnd: {
        get: () => this.actionWorkflow.getActionStateSnapshot().pendingHumanPlayEnd,
        configurable: false
      },
      resolutionOwners: {
        get: () => this.actionWorkflow.getResolutionOwnersSnapshot(),
        configurable: false
      }
    });
    this.turnWorkflow = createTurnWorkflow({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      emitEvent: (type, payload) => this.eventDispatcher.emit(type, payload),
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      runTurn: (...args) => this.takeTurn(...args),
      gainEnergy: (...args) => this.gainEnergy(...args),
      drawCards: (...args) => this.drawCards(...args),
      cleanupDefeatedZones: () => this.cleanupDefeatedZones(),
      delay: (ms) => this.cleanupManager.delay(ms),
      getAiDelay: (kind, options) => getAiDelay(this, kind, options),
      getTeamRules: (player) => this.teamRules.getRules(player),
      waitForHumanPlayEnd: (gameId) => this.ui.waitForHumanPlayEnd(gameId),
      runAiPlayPhase: (...args) => this.takeAiPlayPhase(...args),
      choiceCoordinator: this.choiceCoordinator,
      choiceContexts: this.choiceContexts,
      createId,
      getActionCandidates: (player) => this.aiController.getActionCandidates(player),
      selectAction: (player, options) => this.aiController.selectAction(player, options),
      resolvePlannedAction: (player, action) => this.aiController.resolvePlannedAction(player, action),
      getPlannedSequence: () => this.aiController.getPlannedSequence(),
      playCard: (...args) => this.actionWorkflow.playCard(...args),
      useActiveSkill: (...args) => this.actionWorkflow.useActiveSkill(...args),
      getAiMaxActions: () => this.aiMaxActionsPerTurn,
      getAiReplanAfterEveryAction: () => this.aiReplanAfterEveryAction,
      getActionTargetLabel: (source, cardOrSkill, targets, selection) => getActionTargetLabelFromRuntime(this.state, source, cardOrSkill, targets, selection),
      getAiBeamWidth: () => AI_RUNTIME_POLICY.beamWidth,
      resetActionLocks: () => this.actionWorkflow.resetLocks(),
      discardCardFromHand: (...args) => this.discardCardFromHand(...args),
      cancelPendingInteractions: () => this.ui.cancelPendingInteractions?.()
    });
    this.matchWorkflow = createMatchWorkflow({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      createId,
      createPlayer: (options) => new Player(options),
      assignTeams: () => TeamAssignment.assignTeams(this.random),
      createCandidates: () => this.characterSelection.createCandidates(),
      assignAiCharacters: (...args) => this.characterSelection.assignAiCharacters(...args),
      emitEvent: (type, payload) => this.eventDispatcher.emit(type, payload),
      log: (message, kind) => this.log(message, kind),
      getTeamName: (team) => TEAM_PRESENTATION[team].name,
      registerGlobalRules: () => this.registerGlobalRules(),
      registerPassiveSkills: () => this.passiveTriggerRegistry.registerForPlayers(this.state.players),
      buildDeck: () => this.state.deck.build(this.state),
      syncDeckAliases: () => this.syncDeckAliases(),
      getTeamRules: (player) => this.teamRules.getRules(player),
      drawCards: (...args) => this.drawCards(...args),
      render: () => this.ui.render(this),
      startTurnLoop: () => { this.loopPromise = this.runGameLoop(); },
      setRoster: (players) => { this.state.players = players; },
      setMaxEnergy: (player, value) => { player.maxEnergy = value; },
      setStartingPlayerIndex: (value) => { this.state.startingPlayerIndex = value; },
      setSelectedCharacterId: (value) => { this.state.selectedCharacterId = value; },
      publishFact: (eventName, fact) => this.eventDispatcher.publishFact(eventName, fact),
      responseCleanup: () => this.responseWorkflow.cleanup(),
      cancelPendingInteractions: () => this.ui.cancelPendingInteractions?.(),
      showGameOver: (winnerTeam, humanWon) => this.presentationPort.showGameOver(winnerTeam, humanWon),
      markDisposed: () => { this.state.isDisposed = true; },
      resetActionLocks: () => this.actionWorkflow.resetLocks(),
      cleanupManagerCleanup: () => this.cleanupManager.cleanup(),
      hiddenCardSelectionCleanup: () => this.hiddenCardSelection.cleanup(),
      dyingCleanup: () => this.dyingWorkflow.cleanup(),
      publicCardPoolCleanup: () => this.publicCardPoolWorkflow.cleanup(),
      eventDispatcherClear: () => this.eventDispatcher.clear(),
      traceError: (channel, message, error) => this.diagnosticsPort.reportWorkflowError(channel, message, error),
      getRandom: () => this.random()
    });
    Object.defineProperty(this, "leverageResolutionIds", {
      get: () => this.cardIntentRuntime.getLeverageResolutionIdsSnapshot(),
      configurable: false
    });
    this.loopPromise = null;
    assembleApplicationBoundary(this);
  }
}

/*
功能
创建一局完成装配但尚未开始征召的应用实例。

调用方
main.js、headless tests 与 balance harness。

输入
UI adapter、真实结算随机源与可选 choice/search/presentation 注入项。

输出
单局应用边界。

读取状态
无既有状态。

写入状态
创建新的 MatchState 与单局 adapter/workflow 实例。

调用函数
MatchApplication constructor。

边界与不变量
每次调用返回隔离的新对局；真实随机、AI 搜索随机和展示随机互不复用。
*/
export function createGameApplication(ui, random = Math.random, options = {}) {
  return new MatchApplication(ui, random, options);
}

// 对外导出用于 UI 说明与测试，业务代码仍通过 ActionLegality 检查合法性。
export { CARD_DEFINITIONS, ActionLegality };
