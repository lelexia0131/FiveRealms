/**
 * Game 是 temporary legacy compatibility façade / runtime shell。
 * Match/Turn/Action/Combat/Response/Judgment 与 Card/Skill rule/runtime authority 已迁到 js/application + js/domain；
 * 本文件只保留 FR-ARCH-11 EventBus compatibility、FR-ARCH-12/13 AI legacy wiring、
 * zone movement/query façades 与 FR-ARCH-15 shell cleanup 前必要的 temporary composition。
 */
import { GAME_CONFIG, TEAM_CONFIG } from "../config/gameConfig.js?build=20260815-shadow-agent-p1-slot";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260815-shadow-agent-p1-slot";
import { createId, clamp } from "../utils/helpers.js?build=20260815-shadow-agent-p1-slot";
import { EventBus } from "./EventBus.js?build=20260815-shadow-agent-p1-slot";
import { Player } from "./Player.js?build=20260815-shadow-agent-p1-slot";
import { Deck } from "./Deck.js?build=20260815-shadow-agent-p1-slot";
import { TeamManager } from "./TeamManager.js?build=20260815-shadow-agent-p1-slot";
import { GeneralSelection } from "./GeneralSelection.js?build=20260815-shadow-agent-p1-slot";
import { RuleEngine } from "./RuleEngine.js?build=20260815-shadow-agent-p1-slot";
import { ResponseSystem, RESPONSE_STATUS, isCancelledResponse } from "./ResponseSystem.js?build=20260815-shadow-agent-p1-slot";
import { GameLogger } from "./GameLogger.js?build=20260815-shadow-agent-p1-slot";
import { getActiveSkill, getActiveSkillCost } from "../generals/skillRegistry.js?build=20260815-shadow-agent-p1-slot";
import { AIController } from "../ai/AiController.js?build=20260815-shadow-agent-p1-slot";
import { CleanupManager } from "../utils/CleanupManager.js?build=20260815-shadow-agent-p1-slot";
import { getAiDelay } from "../utils/aiTiming.js?build=20260815-shadow-agent-p1-slot";
import { Debug } from "../utils/debug.js?build=20260815-shadow-agent-p1-slot";
import { TeamRuleService } from "./TeamRuleService.js?build=20260815-shadow-agent-p1-slot";
import { DyingSystem } from "./DyingSystem.js?build=20260815-shadow-agent-p1-slot";
import { JudgmentSystem } from "./JudgmentSystem.js?build=20260815-shadow-agent-p1-slot";
import { CardSelectionSystem } from "./CardSelectionSystem.js?build=20260815-shadow-agent-p1-slot";
import { createGameChoiceBoundary } from "./GameChoiceRouter.js?build=20260815-shadow-agent-p1-slot";
import { createRandomPort } from "../application/ports/RandomPort.js?build=20260815-shadow-agent-p1-slot";
import { createGamePresentationAdapter } from "../adapters/ui/GamePresentationAdapter.js?build=20260815-shadow-agent-p1-slot";
import { createPlayerStatisticsDiagnosticsAdapter } from "../adapters/diagnostics/PlayerStatisticsDiagnosticsAdapter.js?build=20260815-shadow-agent-p1-slot";
import { createRecentAggressorsObservationAdapter } from "../adapters/ai/RecentAggressorsObservationAdapter.js?build=20260815-shadow-agent-p1-slot";
import { createCombatWorkflow } from "../application/combat/CombatWorkflow.js?build=20260815-shadow-agent-p1-slot";
import { createMatchWorkflow } from "../application/match/MatchWorkflow.js?build=20260815-shadow-agent-p1-slot";
import { createTurnWorkflow } from "../application/turn/TurnWorkflow.js?build=20260815-shadow-agent-p1-slot";
import { createActionWorkflow } from "../application/action/ActionWorkflow.js?build=20260815-shadow-agent-p1-slot";
import { createCardRuntime } from "../application/action/CardRuntime.js?build=20260815-shadow-agent-p1-slot";
import { getActionLogMessage as getActionLogMessageFromRuntime, getActionTargetLabel as getActionTargetLabelFromRuntime, shouldSuppressUseLog as shouldSuppressUseLogFromRuntime } from "../application/action/ActionPresentation.js?build=20260815-shadow-agent-p1-slot";
import { createCardIntentRuntime } from "../application/action/CardIntentRuntime.js?build=20260815-shadow-agent-p1-slot";
import { isTransferExecutionAllowed } from "../adapters/ai/TransferExecutionPolicyAdapter.js?build=20260815-shadow-agent-p1-slot";
import { createCardEffectRuntime } from "../application/action/CardEffectRuntime.js?build=20260815-shadow-agent-p1-slot";
import { createSkillEffectRuntime } from "../application/action/SkillEffectRuntime.js?build=20260815-shadow-agent-p1-slot";
import { createPassiveSkillTriggerRegistry } from "../application/trigger/PassiveSkillTriggerRegistry.js?build=20260815-shadow-agent-p1-slot";
import { createRecycleDeviceTrigger } from "../application/trigger/RecycleDeviceTrigger.js?build=20260815-shadow-agent-p1-slot";
import { createGlobalTriggerRegistry } from "../application/trigger/GlobalTriggerRegistry.js?build=20260815-shadow-agent-p1-slot";
import { PublicCardPool } from "./PublicCardPool.js?build=20260815-shadow-agent-p1-slot";
import { HpLossSystem } from "./HpLossSystem.js?build=20260815-shadow-agent-p1-slot";
import { createMatchState } from "../domain/state/model/MatchState.js?build=20260815-shadow-agent-p1-slot";
import { getCurrentActor, getAllies as getAlliesFromState, getEnemies as getEnemiesFromState, getSeatOrderFrom } from "../domain/state/queries/MatchQueries.js?build=20260815-shadow-agent-p1-slot";
import { getCardZoneOccurrences as getCardZoneOccurrencesFromState, isCardCommittedToDiscard as isCardCommittedToDiscardInState, isCardCommittedToEquipment as isCardCommittedToEquipmentInState } from "../domain/state/queries/ZoneQueries.js?build=20260815-shadow-agent-p1-slot";
import { appendCardToZone, commitEquipmentReplacement, discardEquipment, moveCardBetweenZones, moveCardsAtomically, moveEquipmentToHand, purgeCardToDiscard, removeCardFromZone } from "../domain/state/transitions/ZoneTransitions.js?build=20260815-shadow-agent-p1-slot";
import { changeEnergy } from "../domain/state/transitions/ResourceTransitions.js?build=20260815-shadow-agent-p1-slot";
import { addTrackingTarget, markCategoryUsed, setGuardianAidUsed, setKillRewardGranted, setLastEmberResolutionId, setMomentum, setSpyGapPendingTargetIds, setTrackingTurnNumber } from "../domain/state/transitions/RuleUsageTransitions.js?build=20260815-shadow-agent-p1-slot";
import { bumpHandVersion } from "../domain/state/transitions/PlayerStateTransitions.js?build=20260815-shadow-agent-p1-slot";

/*
功能
为中央结算卡生成纯展示 displayTargets。

调用方
Game composition 的 Application Action collaborator。

输入
game、source、cardOrSkill 与 targets。

输出
展示目标数组或 null。

读取状态
targetType 与存活敌人。

写入状态
无。

调用函数
game.getEnemies。

边界与不变量
不进入业务 targets、规则判断或 AI。
*/
function resolveActionDisplayTargets(game, source, cardOrSkill, targets = []) {
  if (targets.length) return targets;
  if (cardOrSkill?.targetType === "allEnemies") {
    return game.getEnemies(source).map((target) => ({ id: target.id, name: target.name }));
  }
  if (cardOrSkill?.targetType === "none") {
    return [{ id: source.id, name: source.name, isSelf: true }];
  }
  return null;
}

/*
功能
按 participant metadata 选择私密窥牌实体并隐藏 concrete UI/AI branch。

调用方
Game composition 的 CardIntentRuntime dependency。

输入
viewer、owner、maximum、reason 与 aiContext。

输出
有效 Card 数组。

读取状态
CardSelectionSystem/UI/AIController。

写入状态
短期 hidden selection session cleanup。

调用函数
createHiddenSelection、requestHiddenCards、resolveConfirmedTokens、clearSelection、chooseHiddenCards。

边界与不变量
真人使用 resolveConfirmedTokens 保留旧 handVersion 语义；AI 走 adapter hidden policy。
*/
async function choosePrivateHandPeekCards(game, viewer, owner, maximum, reason, aiContext) {
  if (viewer.controllerType !== "human") {
    return game.aiController.chooseHiddenCards(viewer, owner, maximum, null, aiContext);
  }
  const hidden = game.cardSelectionSystem.createHiddenSelection(owner);
  try {
    const tokens = await game.ui.requestHiddenCards?.(hidden, maximum, reason, { exact: false, viewer, owner });
    if (!game.isSessionValid(game.state.gameId) || !viewer.alive || !owner.alive) return [];
    return game.cardSelectionSystem.resolveConfirmedTokens(tokens, owner, hidden.selectionId, maximum);
  } finally {
    game.cardSelectionSystem.clearSelection(hidden.selectionId);
  }
}

/*
功能
按 Card identity 在 legacy runtime 全部规则区域中查找实体。

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
    game.publicCardPool?.cards
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

export class Game {
  /*
  功能
  创建一局 Game 并组合 Domain MatchState 与 legacy application/session 扩展状态。

  调用方
  main.js 与测试 fixture。

  输入
  UI 实例、可替换随机源与可选 { choicePort } 注入项。

  输出
  已完成 service 组合但尚未发牌/启动的 Game 实例。

  读取状态
  无既有状态。

  写入状态
  写入 Game services、Domain MatchState 组合与 legacy 扩展字段。

  调用函数
  createMatchState、CleanupManager、GeneralSelection、Deck、各 core service 与 AIController 构造。

  边界与不变量
  领域字段值只来自 createMatchState；gameId/isDisposed/logs/pendingResponses 等保持 legacy 扩展；stateVersion 保持 authoritative。
  */
  constructor(ui, random = Math.random, options = {}) {
    this.randomPort = createRandomPort({ next: () => random() });
    this.random = () => this.randomPort.next();
    this.cleanupManager = new CleanupManager();
    this.generalSelection = new GeneralSelection(this.random);
    const deck = new Deck(this.random);
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
      selectedGeneralId: null,
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
    this.eventBus = new EventBus(() => this.isSessionValid(this.state.gameId), (channel, message, data) => Debug.log(channel, message, data));
    this.logger = new GameLogger(this.state, this.ui);
    this.choiceContexts = new Map();
    this.teamRules = new TeamRuleService(this);
    this.aiController = new AIController(this);
    const choiceBoundary = createGameChoiceBoundary(this, this.choiceContexts, options.choicePort ?? null);
    this.choicePort = choiceBoundary.choicePort;
    this.choiceCoordinator = choiceBoundary.choiceCoordinator;
    this.responseSystem = new ResponseSystem(this, this.choiceCoordinator, this.choiceContexts);
    this.cardSelectionSystem = new CardSelectionSystem(this);
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
      askForBlock: (...args) => this.responseSystem.askForBlock(...args),
      judgeDefense: (...args) => this.judgmentSystem
        ? this.judgmentSystem.judgeDefense(...args)
        : Promise.resolve({ handled: false, immune: false }),
      enterDying: (...args) => this.dyingSystem
        ? this.dyingSystem.enter(...args)
        : Promise.resolve(false),
      emitEvent: (type, payload) => this.eventBus.emit(type, payload),
      createId,
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      observeDamage: (...args) => aiObservation.observeDamage(...args)
    });
    this.judgmentSystem = new JudgmentSystem(this);
    this.dyingSystem = new DyingSystem(this);
    this.hpLossSystem = new HpLossSystem(this);
    this.publicCardPool = new PublicCardPool(this);
    this.animationFastMode = GAME_CONFIG.animationFastMode;
    this.simulationMode = GAME_CONFIG.simulationMode;
    this.aiReplanAfterEveryAction = GAME_CONFIG.aiReplanAfterEveryAction;
    this.aiRandomnessRange = GAME_CONFIG.aiRandomnessRange;
    this.aiDifficultyMultiplier = GAME_CONFIG.aiDifficultyMultiplier;
    this.aiMaxActionsPerTurn = GAME_CONFIG.aiMaxActionsPerTurn;
    /*
    功能
    按 playerId 返回 legacy Player 引用。

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
      onEvent: (eventName, key, handler) => this.eventBus.on(eventName, key, handler),
      getState: () => this.state,
      cleanupHuntMarksForSource: (sourceId) => this.dyingSystem.cleanupHuntMarksForSource(sourceId),
      resolveSeal: (holder, status) => this.judgmentSystem.resolveSeal(holder, status),
      resolveLightning: (holder, status) => this.judgmentSystem.resolveLightning(holder, status)
    });
    this.recycleDeviceTrigger = createRecycleDeviceTrigger({
      onEvent: (eventName, key, handler) => this.eventBus.on(eventName, key, handler),
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      drawCards: (...args) => this.drawCards(...args)
    });
    this.passiveTriggerRegistry = createPassiveSkillTriggerRegistry({
      onEvent: (eventName, key, handler) => this.eventBus.on(eventName, key, handler),
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      random: () => this.random(),
      responseSystem: this.responseSystem,
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
      responseSystem: this.responseSystem,
      publicCardPool: this.publicCardPool,
      resolveLeverage: (...args) => this.cardIntentRuntime.resolveLeverage(...args),
      getCardTargets: (source, card) => RuleEngine.getCardTargets(this, source, card),
      getTransferSources: (source, card) => RuleEngine.getTransferSources(this, source, card),
      getTransferReceivers: (source, from, card) => RuleEngine.getTransferReceivers(this, source, from, card),
      diagnostics: this.diagnosticsPort,
      random: () => this.random(),
      createId
    });
    this.cardIntentRuntime = createCardIntentRuntime({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      responseSystem: this.responseSystem,
      playCard: (...args) => this.actionWorkflow.playCard(...args),
      moveEquipmentToHand: (...args) => this.moveEquipmentToHand(...args),
      getTransferSources: (source, card, excludedCardIds) => RuleEngine.getTransferSources(this, source, card, excludedCardIds),
      getTransferReceivers: (source, from, card) => RuleEngine.getTransferReceivers(this, source, from, card),
      getCardTargets: (source, card) => RuleEngine.getCardTargets(this, source, card),
      getLeverageFirstTargets: (source) => RuleEngine.getLeverageFirstTargets(this, source),
      getAssaultTargetCandidates: (source) => RuleEngine.getAssaultTargetCandidates(this, source),
      isTransferExecutionAllowed,
      chooseTransferCombination: (...args) => this.aiController.chooseTransferCombination(...args),
      chooseHiddenCards: (...args) => this.chooseHiddenCards(...args),
      choosePlayerZoneCard: (...args) => this.choosePlayerZoneCard(...args),
      choosePrivatePeekCards: (...args) => choosePrivateHandPeekCards(this, ...args),
      requestHiddenCards: (...args) => this.ui.requestHiddenCards?.(...args),
      createHiddenSelection: (...args) => this.cardSelectionSystem.createHiddenSelection(...args),
      resolveConfirmedTokens: (...args) => this.cardSelectionSystem.resolveConfirmedTokens(...args),
      clearSelection: (...args) => this.cardSelectionSystem.clearSelection(...args)
    });
    this.cardRuntime = createCardRuntime({
      getState: () => this.state,
      canPlayCard: (source, card) => RuleEngine.canPlayCard(this, source, card),
      canUseForcedAssault: (source, card, target) => RuleEngine.canUseForcedAssault(this, source, card, target),
      getCardTargets: (source, card) => RuleEngine.getCardTargets(this, source, card),
      getAssaultTargetCandidates: (source) => RuleEngine.getAssaultTargetCandidates(this, source),
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
      emitEvent: (type, payload) => this.eventBus.emit(type, payload),
      presentation: this.presentationPort,
      diagnostics: this.diagnosticsPort,
      responseSystem: this.responseSystem,
      cardRuntime: this.cardRuntime,
      canPlayCard: (source, card) => RuleEngine.canPlayCard(this, source, card),
      getCardTargets: (source, card) => RuleEngine.getCardTargets(this, source, card),
      moveHandToResolving: (...args) => this.moveHandToResolving(...args),
      finishResolvingToDiscard: (...args) => this.finishResolvingToDiscard(...args),
      isCardCommittedToDiscard: (card) => this.isCardCommittedToDiscard(card),
      isCardCommittedToEquipment: (player, card) => this.isCardCommittedToEquipment(player, card),
      cleanupFailedResolution: (...args) => this.cleanupFailedResolution(...args),
      clearSelection: (selectionId) => this.cardSelectionSystem.clearSelection(selectionId),
      getActionDisplayTargets: (source, cardOrSkill, targets) => resolveActionDisplayTargets(this, source, cardOrSkill, targets),
      getActionTargetLabel: (source, cardOrSkill, targets, selection) => getActionTargetLabelFromRuntime(this.state, source, cardOrSkill, targets, selection),
      skillRuntime: {
        getActiveSkill: (source) => getActiveSkill(source),
        getCost: (source, skill) => getActiveSkillCost(this, source, skill),
        canUse: (source, skill, cost = null) => skill.canUse(this, source, cost ?? getActiveSkillCost(this, source, skill)),
        execute: (skill, source, targets, context) => skill.execute(this, source, targets, context)
      },
      getSkillTargets: (source, skill) => RuleEngine.getSkillTargets(this, source, skill),
      getHumanPlayer: () => this.state.players[0],
      choiceCoordinator: this.choiceCoordinator,
      choiceContexts: this.choiceContexts,
      requestCardFlow: (...args) => this.ui.requestCardFlow?.(...args),
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
      emitEvent: (type, payload) => this.eventBus.emit(type, payload),
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
      getAiBeamWidth: () => GAME_CONFIG.aiBeamWidth,
      resetActionLocks: () => this.actionWorkflow.resetLocks(),
      discardCardFromHand: (...args) => this.discardCardFromHand(...args),
      cancelPendingInteractions: () => this.ui.cancelPendingInteractions?.()
    });
    this.matchWorkflow = createMatchWorkflow({
      getState: () => this.state,
      isSessionValid: (gameId) => this.isSessionValid(gameId),
      createId,
      createPlayer: (options) => new Player(options),
      assignTeams: () => TeamManager.assignTeams(this.random),
      createCandidates: () => this.generalSelection.createCandidates(),
      assignAiGenerals: (...args) => this.generalSelection.assignAiGenerals(...args),
      emitEvent: (type, payload) => this.eventBus.emit(type, payload),
      log: (message, kind) => this.log(message, kind),
      getTeamName: (team) => TEAM_CONFIG[team].name,
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
      setSelectedGeneralId: (value) => { this.state.selectedGeneralId = value; },
      publishFact: (eventName, fact) => this.eventBus.publishFact(eventName, fact),
      responseCleanup: () => this.responseSystem.cleanup(),
      cancelPendingInteractions: () => this.ui.cancelPendingInteractions?.(),
      showGameOver: (winnerTeam, humanWon) => this.presentationPort.showGameOver(winnerTeam, humanWon),
      markDisposed: () => { this.state.isDisposed = true; },
      resetActionLocks: () => this.actionWorkflow.resetLocks(),
      cleanupManagerCleanup: () => this.cleanupManager.cleanup(),
      cardSelectionCleanup: () => this.cardSelectionSystem.cleanup(),
      dyingCleanup: () => this.dyingSystem.cleanup(),
      publicCardPoolCleanup: () => this.publicCardPool.cleanup(),
      eventBusClear: () => this.eventBus.clear(),
      traceError: (channel, message, error) => this.diagnosticsPort.reportWorkflowError(channel, message, error),
      getRandom: () => this.random()
    });
    Object.defineProperty(this, "leverageResolutionIds", {
      get: () => this.cardIntentRuntime.getLeverageResolutionIdsSnapshot(),
      configurable: false
    });
    this.loopPromise = null;
  }

  /*
  功能
  返回当前行动角色。

  调用方
  Game workflow 与 UI。

  输入
  无。

  输出
  当前 Player 或 null。

  读取状态
  this.state。

  写入状态
  无。

  调用函数
  getCurrentActor。

  边界与不变量
  只转发 Domain query，不改变索引语义。
  */
  get currentPlayer() {
    return getCurrentActor(this.state);
  }

  /*
  功能
  返回 Application MatchWorkflow 当前候选角色数组。

  调用方
  legacy tests/observers。

  输入
  无。

  输出
  候选数组。

  读取状态
  Application Match state。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只读 projection；不缓存第二份 candidates。
  */
  get candidates() {
    return this.matchWorkflow.candidates;
  }

  /** 切换展示节奏；只影响可清理等待与 CSS 动画，不改变规则或 AI 评分。 */
  setAnimationFastMode(enabled) {
    this.animationFastMode = Boolean(enabled);
    this.ui.setFastMode?.(this.animationFastMode);
    return this.animationFastMode;
  }

  /*
  功能
  转发 Application MatchWorkflow.startSelection。

  调用方
  main.js 与测试 fixture。

  输入
  无。

  输出
  候选角色数组。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.matchWorkflow.startSelection。

  边界与不变量
  pre-live setup authority 在 Application Match；Game 不重复组队公式。
  */
  startSelection() {
    return this.matchWorkflow.startSelection();
  }

  /*
  功能
  转发 Application MatchWorkflow.confirmGeneral。

  调用方
  main.js。

  输入
  candidate generalId。

  输出
  true/false 或抛错。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.matchWorkflow.confirmGeneral。

  边界与不变量
  角色确认与初始发牌 authority 在 Application Match。
  */
  async confirmGeneral(generalId) {
    return this.matchWorkflow.confirmGeneral(generalId);
  }

  /*
  功能
  注册装备与延迟状态等不属于特定角色的事件规则。

  调用方
  Game confirmGeneral 与测试 fixture。

  输入
  无。

  输出
  无返回值。

  读取状态
  this.state、responseSystem、judgmentSystem、RuleEngine。

  写入状态
  监听器注册；状态写入经 StatusTransition。

  调用函数
  EventBus.on、setStatus、removeStatus、setMatchPhase 相关 workflow。

  边界与不变量
  规则决定仍留在本方法；Domain transition 只提交写入。
  */
  registerGlobalRules() {
    this.recycleDeviceTrigger.register();
    this.globalTriggerRegistry.register();
  }

  /*
  功能
  转发 Application TurnWorkflow.runGameLoop。

  调用方
  Application MatchWorkflow start continuation。

  输入
  无。

  输出
  loop promise。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.turnWorkflow.runGameLoop。

  边界与不变量
  turn loop algorithm authority 在 Application Turn。
  */
  async runGameLoop() {
    return this.turnWorkflow.runGameLoop();
  }

  /*
  功能
  转发 Application TurnWorkflow.takeTurn。

  调用方
  runGameLoop 与 tests。

  输入
  player 与 gameId。

  输出
  Promise。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.turnWorkflow.takeTurn。

  边界与不变量
  六阶段 algorithm authority 在 Application Turn。
  */
  async takeTurn(player, gameId) {
    return this.turnWorkflow.takeTurn(player, gameId);
  }

  /*
  功能
  转发 Application TurnWorkflow.takeAiPlayPhase。

  调用方
  Application TurnWorkflow.takeTurn。

  输入
  player 与 gameId。

  输出
  Promise。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.turnWorkflow.takeAiPlayPhase。

  边界与不变量
  AI play-phase orchestration authority 在 Application Turn。
  */
  async takeAiPlayPhase(player, gameId) {
    return this.turnWorkflow.takeAiPlayPhase(player, gameId);
  }

  /*
  功能
  转发 Application TurnWorkflow.handleDiscardPhase。

  调用方
  Application TurnWorkflow.takeTurn。

  输入
  player 与 gameId。

  输出
  Promise。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.turnWorkflow.handleDiscardPhase。

  边界与不变量
  discard sequencing authority 在 Application Turn。
  */
  async handleDiscardPhase(player, gameId) {
    return this.turnWorkflow.handleDiscardPhase(player, gameId);
  }

  /*
  功能
  转发 Application TurnWorkflow.advanceTurn。

  调用方
  Application TurnWorkflow.runGameLoop。

  输入
  无。

  输出
  Promise。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.turnWorkflow.advanceTurn。

  边界与不变量
  轮次推进 formula authority 在 Domain TurnRules。
  */
  async advanceTurn() {
    return this.turnWorkflow.advanceTurn();
  }

  /*
  功能
  转发 CardIntentRuntime.prepareTransferIntent。

  调用方
  CardRuntime legacy façade 与 tests。

  输入
  source、card 与 selection。

  输出
  frozen intent/publicContext 或 null。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.cardIntentRuntime.prepareTransferIntent。

  边界与不变量
  card-specific preparation authority 在 Application CardIntentRuntime。
  */
  async prepareTransferIntent(source, card, selection = null) {
    return this.cardIntentRuntime.prepareTransferIntent(source, card, selection);
  }

  /*
  功能
  转发 CardIntentRuntime.prepareLeverageIntent。

  调用方
  CardRuntime legacy façade 与 tests。

  输入
  source 与 selection。

  输出
  frozen intent 或 null。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.cardIntentRuntime.prepareLeverageIntent。

  边界与不变量
  card-specific preparation authority 在 Application CardIntentRuntime。
  */
  prepareLeverageIntent(source, selection = null) {
    return this.cardIntentRuntime.prepareLeverageIntent(source, selection);
  }

  /*
  功能
  转发 CardIntentRuntime.preparePrivateCardSelectionIntent。

  调用方
  CardRuntime legacy façade。

  输入
  source、card、targets 与 selection。

  输出
  frozen intent/publicContext 或 null。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.cardIntentRuntime.preparePrivateCardSelectionIntent。

  边界与不变量
  hidden selection authority 保持 FR-ARCH-6 store。
  */
  async preparePrivateCardSelectionIntent(source, card, targets, selection = null) {
    return this.cardIntentRuntime.preparePrivateCardSelectionIntent(source, card, targets, selection);
  }

  /*
  功能
  转发 CardIntentRuntime.preparePrivateHandPeekIntent。

  调用方
  Application passive trigger。

  输入
  viewer、owner、count 与 reason。

  输出
  frozen intent 或 null。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.cardIntentRuntime.preparePrivateHandPeekIntent。

  边界与不变量
  hidden peek authority 在 Application CardIntentRuntime。
  */
  async preparePrivateHandPeekIntent(viewer, owner, count, reason) {
    return this.cardIntentRuntime.preparePrivateHandPeekIntent(viewer, owner, count, reason);
  }

  /*
  功能
  转发 CardIntentRuntime.resolvePrivateHandPeekIntent。

  调用方
  Application passive trigger。

  输入
  viewer 与 intent。

  输出
  有效 cards。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.cardIntentRuntime.resolvePrivateHandPeekIntent。

  边界与不变量
  不泄漏 hidden entity。
  */
  resolvePrivateHandPeekIntent(viewer, intent) {
    return this.cardIntentRuntime.resolvePrivateHandPeekIntent(viewer, intent);
  }

  /*
  功能
  转发 CardIntentRuntime.resolveLeverage。

  调用方
  CardEffectRuntime legacy effect resolver 与 tests。

  输入
  source、card、intent 与 resolutionId。

  输出
  resolved boolean。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.cardIntentRuntime.resolveLeverage。

  边界与不变量
  leverage resolution authority 在 Application CardIntentRuntime。
  */
  async resolveLeverage(source, card, intent, resolutionId) {
    return this.cardIntentRuntime.resolveLeverage(source, card, intent, resolutionId);
  }

  /*
  功能
  转发 Application ActionWorkflow.playCard。

  调用方
  Application Turn AI orchestration、human command 与 tests。

  输入
  source、card、requestedTargets、selection 与 options。

  输出
  Promise<boolean>。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.playCard。

  边界与不变量
  generic card action pipeline authority 在 Application Action；card-specific prep 仍由本文件 legacy collaborator 提供。
  */
  async playCard(source, card, requestedTargets = [], selection = null, options = {}) {
    return this.actionWorkflow.playCard(source, card, requestedTargets, selection, options);
  }

  /*
  功能
  转发 Application ActionWorkflow.useActiveSkill。

  调用方
  Application Turn AI orchestration、human command 与 tests。

  输入
  source、skillId 与 targets。

  输出
  Promise<boolean>。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.useActiveSkill。

  边界与不变量
  generic skill action pipeline authority 在 Application Action；skill-specific rule 仍 legacy。
  */
  async useActiveSkill(source, skillId, targets = []) {
    return this.actionWorkflow.useActiveSkill(source, skillId, targets);
  }

  /*
  功能
  转发 Application ActionWorkflow.handleHumanCard。

  调用方
  main/UI command boundary。

  输入
  cardId。

  输出
  Promise<boolean>。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.handleHumanCard。

  边界与不变量
  human inbound command authority 在 Application Action。
  */
  async handleHumanCard(cardId) {
    return this.actionWorkflow.handleHumanCard(cardId);
  }

  /*
  功能
  转发 Application ActionWorkflow.handleHumanSkill。

  调用方
  main/UI command boundary。

  输入
  无。

  输出
  Promise<boolean>。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.handleHumanSkill。

  边界与不变量
  human inbound command authority 在 Application Action。
  */
  async handleHumanSkill() {
    return this.actionWorkflow.handleHumanSkill();
  }

  /*
  功能
  转发 Application ActionWorkflow.requestEndHumanPlay。

  调用方
  main/UI command boundary。

  输入
  无。

  输出
  boolean。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.requestEndHumanPlay。

  边界与不变量
  end-play command authority 在 Application Action。
  */
  requestEndHumanPlay() {
    return this.actionWorkflow.requestEndHumanPlay();
  }

  /*
  功能
  转发 Application ActionWorkflow.requestHumanPlayEndForDefeat。

  调用方
  Application DyingWorkflow death commit。

  输入
  player。

  输出
  boolean。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.requestHumanPlayEndForDefeat。

  边界与不变量
  human defeat release authority 在 Application Action。
  */
  requestHumanPlayEndForDefeat(player) {
    return this.actionWorkflow.requestHumanPlayEndForDefeat(player);
  }

  /*
  功能
  转发 Application ActionWorkflow.flushPendingHumanPlayEnd。

  调用方
  action finally paths。

  输入
  无。

  输出
  boolean。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.actionWorkflow.flushPendingHumanPlayEnd。

  边界与不变量
  pendingHumanPlayEnd authority 在 Application Action。
  */
  flushPendingHumanPlayEnd() {
    return this.actionWorkflow.flushPendingHumanPlayEnd();
  }

  /*
  功能
  转发 Application Combat Workflow.damage。

  调用方
  Card/Skill resolvers 与闪电规则。

  输入
  source、target、amount 与 context。

  输出
  实际扣除的生命值。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.combatWorkflow.damage。

  边界与不变量
  本 façade 不含第二份伤害 workflow；Application Combat 是唯一 authority。
  */
  async damage(source, target, amount, context = {}) {
    return this.combatWorkflow.damage(source, target, amount, context);
  }

  /*
  功能
  转发 Application Combat Workflow.heal。

  调用方
  Card/Skill resolvers 与 DyingWorkflow。

  输入
  source、target、amount 与 context。

  输出
  实际治疗量。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.combatWorkflow.heal。

  边界与不变量
  本 façade 不含第二份治疗 workflow；Application Combat 是唯一 authority。
  */
  async heal(source, target, amount, context = {}) {
    return this.combatWorkflow.heal(source, target, amount, context);
  }

  /*
  功能
  统一能量获取入口，经事件修正后提交能量变化。

  调用方
  turn flow 与卡牌/技能效果。

  输入
  player、amount 与 context。

  输出
  实际能量变化量。

  读取状态
  Game state 与 EventBus。

  写入状态
  energy 经 ResourceTransition。

  调用函数
  changeEnergy、EventBus.emit。

  边界与不变量
  事件顺序不变。
  */
  async gainEnergy(player, amount, context = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !player?.alive || this.state.isGameOver) return 0;
    const event = { type: "beforeGainEnergy", player, amount, reason: context.reason ?? "效果", card: context.card ?? null, skill: context.skill ?? null, cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeGainEnergy", event);
    if (!this.isSessionValid(gameId)) return 0;
    if (event.cancelled) return 0;
    const actualAmount = changeEnergy(this.state, player, event.amount);
    if (actualAmount > 0) {
      const message = event.reason === "回合开始"
        ? `${player.name}在回合开始时获得${actualAmount}点能量。`
        : event.reason === "聚能"
          ? `${player.name}使用「聚能」，获得${actualAmount}点能量。`
          : event.reason === "余烬"
            ? `${player.name}触发「余烬」，获得${actualAmount}点能量。`
            : `${player.name}通过${event.reason}获得${actualAmount}点能量。`;
      this.log(message);
      this.ui.queueFeedback?.("energy", player.id, actualAmount);
    }
    await this.eventBus.emit("afterGainEnergy", { ...event, type: "afterGainEnergy", actualAmount });
    if (!this.isSessionValid(gameId)) return actualAmount;
    this.ui.render(this);
    return actualAmount;
  }

  /** 兼容旧技能入口：生命不大于0时进入完整濒死流程。 */
  async killPlayer(target, source) {
    return this.dyingSystem.enter(target, source);
  }

  /*
  功能
  转发 Application MatchWorkflow.checkVictory。

  调用方
  Application Combat death continuation 与 tests。

  输入
  无。

  输出
  winnerTeam 或 null。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.matchWorkflow.checkVictory。

  边界与不变量
  胜利决定 formula authority 在 Domain TeamRules。
  */
  async checkVictory() {
    return this.matchWorkflow.checkVictory();
  }

  /*
  功能
  抽指定数量的牌并逐张触发移动事件。

  调用方
  turn flow 与卡牌/技能效果。

  输入
  player、count、reason 与 options。

  输出
  实际抽牌数。

  读取状态
  Game state、Deck 与 EventBus。

  写入状态
  牌区经 ZoneTransition；handVersion 经 PlayerStateTransition。

  调用函数
  Deck.drawOne/beginResolve/finishResolveToEquipment、appendCardToZone、bumpHandVersion。

  边界与不变量
  before/after 事件与 knowledge 失效顺序不变。
  */
  async drawCards(player, count, reason = "摸牌", options = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !player?.alive || this.state.isGameOver) return 0;
    let drawn = 0;
    for (let index = 0; index < count; index += 1) {
      const card = this.state.deck.drawOne(this.state);
      this.syncDeckAliases();
      if (!card) break;
      // 跨 beforeCardMove 等待期间先放入受管结算区，避免 dispose 时实体牌悬空。
      if (!this.state.deck.beginResolve(this.state, card)) break;
      this.syncDeckAliases();
      const move = { type: "beforeCardMove", card, from: "deck", to: "hand", player, reason, cancelled: false };
      await this.eventBus.emit("beforeCardMove", move);
      if (!this.isSessionValid(gameId)) return drawn;
      if (move.cancelled) {
        this.state.deck.finishResolveToEquipment(this.state, card);
        appendCardToZone(this.state, this.state.deck.cards, card);
        this.syncDeckAliases();
        continue;
      }
      if (!this.state.deck.finishResolveToEquipment(this.state, card)) return drawn;
      appendCardToZone(this.state, player.hand, card);
      bumpHandVersion(this.state, player);
      this.invalidateCardKnowledge(card.id, player.id);
      drawn += 1;
      await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
      if (!this.isSessionValid(gameId)) return drawn;
    }
    if (drawn) {
      if (!options.silent) this.log(`${player.name}摸了${drawn}张牌。`);
      this.ui.queueFeedback?.("draw", player.id, drawn);
    }
    this.ui.render(this);
    return drawn;
  }

  /*
  功能
  从玩家手牌公开弃置一张牌。

  调用方
  弃牌阶段、效果与 cleanup。

  输入
  player、card、reason 与 options。

  输出
  是否成功移动。

  读取状态
  Game state 与 EventBus。

  写入状态
  手牌与弃牌堆经 ZoneTransition；handVersion 经 PlayerStateTransition。

  调用函数
  moveCardBetweenZones、bumpHandVersion。

  边界与不变量
  事件与日志顺序不变。
  */
  async discardCardFromHand(player, card, reason = "弃置", options = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const index = player.hand.indexOf(card);
    if (index < 0) return false;
    const move = { type: "beforeCardMove", card, from: "hand", to: "discard", player, reason, cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled) return false;
    moveCardBetweenZones(this.state, player.hand, this.state.deck.discardPile, card);
    bumpHandVersion(this.state, player);
    this.invalidateCardKnowledge(card.id, player.id);
    this.syncDeckAliases();
    if (!options.silent) this.log(`${player.name}因${options.logReason ?? reason}弃置了「${card.name}」。`);
    this.ui.queueFeedback?.("discard", player.id);
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /*
  功能
  原子支付一组手牌。

  调用方
  ResponseSystem 与 direct tests。

  输入
  player、cards、reason 与 options。

  输出
  USED/INVALID/CANCELLED 结果。

  读取状态
  Game state 与 EventBus。

  写入状态
  手牌与弃牌堆经一次 atomic ZoneTransition；handVersion 经 PlayerStateTransition。

  调用函数
  moveCardsAtomically、bumpHandVersion。

  边界与不变量
  所有 before 成功后才 group commit。
  */
  async payCardsFromHandAtomically(player, cards, reason = "响应支付", options = {}) {
    const gameId = this.state.gameId;
    const selected = Array.isArray(cards) ? [...cards] : [];
    const expectedCount = options.expectedCount ?? selected.length;
    const invalid = () => Object.freeze({ status:RESPONSE_STATUS.INVALID, cards:[] });
    const cancelled = () => Object.freeze({ status:RESPONSE_STATUS.CANCELLED, cards:[] });
    if (!this.isSessionValid(gameId)) return cancelled();
    if (!player?.alive || this.state.isGameOver || expectedCount <= 0 || selected.length !== expectedCount) return invalid();
    if (new Set(selected).size !== selected.length
      || new Set(selected.map((card) => card?.id)).size !== selected.length
      || selected.some((card) => !card?.id)) return invalid();

    const canCommit = () => selected.every((card) => player.hand.includes(card)
      && !this.state.deck.cards.includes(card)
      && !this.state.deck.discardPile.includes(card)
      && !this.state.deck.resolvingCards.includes(card)
      && !this.state.deck.judgmentZone.includes(card)
      && !(this.state.publicCardPool ?? []).includes(card)
      && !this.state.players.some((owner) => owner.equipment === card));
    if (!canCommit()) return invalid();

    const moves = selected.map((card) => ({
      type:"beforeCardMove", card, from:"hand", to:"discard", player, reason, cancelled:false,
      atomicGroupSize:selected.length
    }));
    for (const move of moves) {
      await this.eventBus.emit("beforeCardMove", move);
      if (!this.isSessionValid(gameId)) return cancelled();
      if (move.cancelled || !canCommit()) return invalid();
    }
    if (!this.isSessionValid(gameId)) return cancelled();
    if (!canCommit()) return invalid();

    if (!moveCardsAtomically(this.state, player.hand, this.state.deck.discardPile, selected)) return invalid();
    bumpHandVersion(this.state, player);
    for (const card of selected) {
      this.invalidateCardKnowledge(card.id, player.id);
    }
    this.syncDeckAliases();
    if (!options.silent) {
      const label = selected.length === 1 ? `「${selected[0].name}」` : `${selected.length}张牌`;
      this.log(`${player.name}因${reason}弃置了${label}。`);
    }
    this.ui.queueFeedback?.("discard", player.id, selected.length);
    for (const move of moves) {
      await this.eventBus.emit("afterCardMove", { ...move, type:"afterCardMove" });
      if (!this.isSessionValid(gameId)) return cancelled();
    }
    this.ui.render(this);
    return Object.freeze({ status:RESPONSE_STATUS.USED, cards:Object.freeze([...selected]) });
  }

  /*
  功能
  在两名玩家间移动实体手牌。

  调用方
  转移/掠夺/窃取 workflow。

  输入
  from、to、card 与 reason。

  输出
  是否成功移动。

  读取状态
  Game state 与 EventBus。

  写入状态
  手牌经 ZoneTransition；handVersion 经 PlayerStateTransition。

  调用函数
  moveCardBetweenZones、bumpHandVersion。

  边界与不变量
  知识追踪与事件顺序不变。
  */
  async moveCardBetweenHands(from, to, card, reason) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !from?.alive || !to?.alive || this.state.isGameOver) return false;
    const index = from.hand.indexOf(card);
    if (index < 0) return false;
    const move = { type: "beforeCardMove", card, from: "hand", to: "hand", fromPlayer: from, player: to, reason, cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled) return false;
    const trackingViewers = this.state.players.filter((viewer) => viewer.id === from.id || this.isCardKnownTo(viewer, from, card));
    moveCardBetweenZones(this.state, from.hand, to.hand, card);
    bumpHandVersion(this.state, from);
    bumpHandVersion(this.state, to);
    this.invalidateCardKnowledge(card.id, from.id);
    for (const viewer of trackingViewers) {
      if (viewer.id !== to.id) this.rememberPrivateCard(viewer, to, card);
    }
    this.ui.queueFeedback?.("draw", to.id, 1);
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /*
  功能
  将公开装备从装备区移入另一名角色手牌。

  调用方
  掠夺/窃取/借势 workflow。

  输入
  from、to、card 与 reason。

  输出
  是否成功移动。

  读取状态
  Game state 与 EventBus。

  写入状态
  装备与手牌经 atomic ZoneTransition；handVersion 经 PlayerStateTransition。

  调用函数
  moveEquipmentToHand、bumpHandVersion。

  边界与不变量
  知识追踪与事件顺序不变。
  */
  async moveEquipmentToHand(from, to, card, reason) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !from?.alive || !to?.alive || from.equipment !== card || this.state.isGameOver) return false;
    const move = { type:"beforeCardMove", card, from:"equipment", to:"hand", fromPlayer:from, player:to, reason, cancelled:false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled || from.equipment !== card) return false;
    moveEquipmentToHand(this.state, from, to, card);
    bumpHandVersion(this.state, to);
    this.invalidateCardKnowledge(card.id, from.id);
    for (const viewer of this.state.players) if (viewer.id !== to.id) this.rememberPrivateCard(viewer, to, card);
    this.ui.queueFeedback?.("draw", to.id, 1);
    await this.eventBus.emit("afterCardMove", { ...move, type:"afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /*
  功能
  从装备区公开弃置实体装备。

  调用方
  破坏与 cleanup workflow。

  输入
  player、card 与 reason。

  输出
  是否成功移动。

  读取状态
  Game state 与 EventBus。

  写入状态
  装备与弃牌堆经 atomic ZoneTransition。

  调用函数
  discardEquipment。

  边界与不变量
  事件顺序不变。
  */
  async discardEquipment(player, card, reason = "弃置装备") {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !player?.alive || player.equipment !== card) return false;
    const move = { type:"beforeCardMove", card, from:"equipment", to:"discard", player, reason, cancelled:false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled || player.equipment !== card) return false;
    discardEquipment(this.state, player, card, this.state.deck.discardPile);
    this.invalidateCardKnowledge(card.id, player.id);
    this.syncDeckAliases();
    this.ui.queueFeedback?.("discard", player.id);
    await this.eventBus.emit("afterCardMove", { ...move, type:"afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /*
  功能
  将主动牌由手牌移入结算区。

  调用方
  playCard。

  输入
  player、card 与 resolutionId。

  输出
  是否成功移动。

  读取状态
  Game state 与 EventBus。

  写入状态
  手牌与结算区经 ZoneTransition；handVersion 经 PlayerStateTransition。

  调用函数
  beginResolve、removeCardFromZone、bumpHandVersion。

  边界与不变量
  实体引用与事件顺序不变。
  */
  async moveHandToResolving(player, card, resolutionId = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    if (player.hand.indexOf(card) < 0) return false;
    if (resolutionId && this.actionWorkflow.getResolutionOwner(card)) return false;
    const move = { type: "beforeCardMove", card, from: "hand", to: "resolving", player, reason: "使用", cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled) return false;
    // 移动事件可能改变手牌，提交前重新按实体引用确认；beginResolve 失败时手牌必须保持原状。
    if (player.hand.indexOf(card) < 0 || !this.state.deck.beginResolve(this.state, card)) return false;
    removeCardFromZone(this.state, player.hand, card);
    bumpHandVersion(this.state, player);
    this.invalidateCardKnowledge(card.id, player.id);
    if (resolutionId) this.actionWorkflow.claimResolution(card, resolutionId);
    this.syncDeckAliases();
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    return this.isSessionValid(gameId);
  }

  /*
  功能
  令结算完成的牌进入弃牌堆。

  调用方
  playCard。

  输入
  card 与 resolutionId。

  输出
  是否成功提交。

  读取状态
  Game state 与 EventBus。

  写入状态
  结算区与弃牌堆经 ZoneTransition。

  调用函数
  Deck.finishResolveToDiscard。

  边界与不变量
  事件顺序与区域唯一性不变。
  */
  async finishResolvingToDiscard(card, resolutionId = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    if (resolutionId && !this.actionWorkflow.ownsResolution(card, resolutionId)) return false;
    if (!this.state.deck.resolvingCards.includes(card)) return false;
    const move = { type: "beforeCardMove", card, from: "resolving", to: "discard", reason: "结算完成", cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled || (resolutionId && !this.actionWorkflow.ownsResolution(card, resolutionId))) return false;
    const discarded = this.state.deck.finishResolveToDiscard(this.state, card);
    if (!discarded) return false;
    this.syncDeckAliases();
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    return this.state.deck.discardPile.includes(card) && !this.state.deck.resolvingCards.includes(card);
  }

  /*
  功能
  将装置放入唯一装备槽。

  调用方
  cardRegistry 装备 resolver。

  输入
  player、card 与 resolutionId。

  输出
  是否成功装备。

  读取状态
  Game state 与 EventBus。

  写入状态
  装备替换经 atomic ZoneTransition。

  调用函数
  commitEquipmentReplacement。

  边界与不变量
  最后预检后无 await 地原子提交。
  */
  async equipCard(player, card, resolutionId = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    /*
    功能
    判断结算牌是否由当前 resolution 拥有。

    调用方
    equipCard。

    输入
    无。

    输出
    布尔值。

    读取状态
    actionWorkflow resolution owner。

    写入状态
    无。

    调用函数
    actionWorkflow.ownsResolution。

    边界与不变量
    不暴露 mutable Map。
    */
    const ownsResolution = () => !resolutionId || this.actionWorkflow.ownsResolution(card, resolutionId);
    const canCommitNew = () => ownsResolution()
      && this.state.deck.resolvingCards.includes(card)
      && !this.state.deck.cards.includes(card)
      && !this.state.deck.discardPile.includes(card)
      && !this.state.deck.judgmentZone.includes(card)
      && !(this.state.publicCardPool ?? []).includes(card)
      && !this.state.players.some((owner) => owner.hand.includes(card) || owner.equipment === card);
    if (!canCommitNew()) return false;
    const equipMove = { type: "beforeCardMove", card, from: "resolving", to: "equipment", player, reason: "装备", cancelled: false };
    await this.eventBus.emit("beforeCardMove", equipMove);
    if (!this.isSessionValid(gameId)) return false;
    if (equipMove.cancelled || !canCommitNew()) return false;

    const old = player.equipment;
    const replaceMove = old
      ? { type: "beforeCardMove", card: old, from: "equipment", to: "discard", player, reason: "替换装备", cancelled: false }
      : null;
    const oldRemainsValid = () => !old || (player.equipment === old
      && !this.state.deck.cards.includes(old)
      && !this.state.deck.discardPile.includes(old)
      && !this.state.deck.resolvingCards.includes(old)
      && !this.state.deck.judgmentZone.includes(old)
      && !(this.state.publicCardPool ?? []).includes(old)
      && !this.state.players.some((owner) => owner.hand.includes(old) || (owner !== player && owner.equipment === old)));
    if (replaceMove) {
      await this.eventBus.emit("beforeCardMove", replaceMove);
      if (!this.isSessionValid(gameId) || replaceMove.cancelled) return false;
    }

    // 从最后一次预检到提交之间不再 await，旧装备和新装备作为一个不可分割状态切换。
    if (!canCommitNew() || !oldRemainsValid()) return false;
    if (!commitEquipmentReplacement(
      this.state, player, card, old, this.state.deck.resolvingCards, this.state.deck.discardPile
    )) return false;
    this.syncDeckAliases();
    if (replaceMove) {
      await this.eventBus.emit("afterCardMove", { ...replaceMove, type: "afterCardMove" });
      this.log(`${player.name}的「${old.name}」被替换并进入弃牌堆。`);
    }
    this.log(`${player.name}装备了「${card.name}」。`, "important");
    this.ui.queueFeedback?.("equip", player.id);
    await this.eventBus.emit("afterCardMove", { ...equipMove, type: "afterCardMove" });
    return player.equipment === card && !this.state.deck.resolvingCards.includes(card);
  }

  /*
  功能
  返回实体牌在所有规则区域中的实际出现位置。

  调用方
  playCard 提交校验、cleanup 与 tests。

  输入
  Card entity。

  输出
  zone label 数组；重复引用逐次计数。

  读取状态
  this.state 的 deck 区域、publicCardPool 与 Player hand/equipment。

  写入状态
  无。

  调用函数
  getCardZoneOccurrencesFromState。

  边界与不变量
  只转发 Domain query，zone 枚举顺序与 label 格式不变。
  */
  getCardZoneOccurrences(card) {
    return getCardZoneOccurrencesFromState(this.state, card);
  }

  /*
  功能
  判断实体牌是否唯一处于弃牌堆。

  调用方
  playCard 提交校验与 tests。

  输入
  Card entity。

  输出
  布尔值。

  读取状态
  Domain zone query。

  写入状态
  无。

  调用函数
  isCardCommittedToDiscardInState。

  边界与不变量
  与迁移前判定完全一致。
  */
  isCardCommittedToDiscard(card) {
    return isCardCommittedToDiscardInState(this.state, card);
  }

  /*
  功能
  判断实体牌是否唯一处于指定玩家装备槽。

  调用方
  equipCard 提交校验与 tests。

  输入
  Player 与 Card entity。

  输出
  布尔值。

  读取状态
  Domain zone query。

  写入状态
  无。

  调用函数
  isCardCommittedToEquipmentInState。

  边界与不变量
  与迁移前判定完全一致。
  */
  isCardCommittedToEquipment(player, card) {
    return isCardCommittedToEquipmentInState(this.state, player, card);
  }

  /*
  功能
  失败结算的内部兜底，把未提交实体规范化到弃牌堆。

  调用方
  playCard finally。

  输入
  card、reason 与 resolutionId。

  输出
  是否清理成功。

  读取状态
  resolutionOwners 与所有牌区。

  写入状态
  牌区经 atomic ZoneTransition；受影响 handVersion 经 PlayerStateTransition。

  调用函数
  purgeCardToDiscard、bumpHandVersion。

  边界与不变量
  不触发事件或日志。
  */
  cleanupFailedResolution(card, reason = null, resolutionId = null) {
    if (!card || (resolutionId && !this.actionWorkflow.ownsResolution(card, resolutionId))) return false;
    if (!resolutionId && !this.state.deck.resolvingCards.includes(card)) return false;
    const affectedHands = this.state.players.filter((player) => player.hand.includes(card));
    const zones = [
      this.state.deck.cards,
      this.state.deck.discardPile,
      this.state.deck.resolvingCards,
      this.state.deck.judgmentZone
    ];
    const extraZones = [
      this.state.publicCardPool ?? [],
      ...(this.publicCardPool?.cards && this.publicCardPool.cards !== this.state.publicCardPool
        ? [this.publicCardPool.cards]
        : [])
    ];
    purgeCardToDiscard(
      this.state,
      card,
      zones,
      this.state.players,
      extraZones,
      this.state.deck.discardPile
    );
    for (const player of affectedHands) bumpHandVersion(this.state, player);
    this.actionWorkflow.releaseResolution(card);
    this.syncDeckAliases();
    Debug.log("Game", `已清理失败结算实体 ${card.id ?? "unknown"}`, reason ?? undefined);
    return this.state.deck.discardPile.filter((entry) => entry === card).length === 1
      && !this.state.deck.resolvingCards.includes(card);
  }

  /*
  功能
  返回某角色的存活敌人。

  调用方
  Card/Skill runtime、AI 与 UI。

  输入
  当前 Player。

  输出
  真实 Player 引用数组，保持 state.players 顺序。

  读取状态
  this.state。

  写入状态
  无。

  调用函数
  getEnemiesFromState。

  边界与不变量
  只转发 Domain query；不复制或排序 Player。
  */
  getEnemies(player) {
    return getEnemiesFromState(this.state, player);
  }

  /*
  功能
  返回某角色含自身在内的存活同阵营角色。

  调用方
  Card/Skill runtime、AI 与 UI。

  输入
  当前 Player。

  输出
  真实 Player 引用数组，保持 state.players 顺序。

  读取状态
  this.state。

  写入状态
  无。

  调用函数
  getAlliesFromState。

  边界与不变量
  保留当前“allies 含 source 自身”语义。
  */
  getAllies(player) {
    return getAlliesFromState(this.state, player);
  }

  /*
  功能
  守住阵亡角色牌区不变量。

  调用方
  advanceTurn。

  输入
  无。

  输出
  无返回值。

  读取状态
  Game state。

  写入状态
  手牌/装备经已有 version-aware transitions。

  调用函数
  discardCardFromHand、discardEquipment。

  边界与不变量
  不改变事件顺序。
  */
  async cleanupDefeatedZones() {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return;
    for (const player of this.state.players) {
      if (player.alive) continue;
      for (const card of [...player.hand]) {
        await this.discardCardFromHand(player, card, "阵亡区域清理");
        if (!this.isSessionValid(gameId)) return;
      }
      if (player.equipment) {
        discardEquipment(this.state, player, player.equipment, this.state.deck.discardPile);
      }
    }
    this.syncDeckAliases();
  }

  /*
  功能
  从指定角色下一座位开始，按环形座位顺序返回角色。

  调用方
  Card/Skill/Response workflow 与测试。

  输入
  source Player 与 includeSource。

  输出
  真实 Player 引用数组。

  读取状态
  this.state。

  写入状态
  无。

  调用函数
  getSeatOrderFrom。

  边界与不变量
  includeSource=true 时 source 排首位；环形语义与迁移前一致。
  */
  seatOrderFrom(source, includeSource = false) {
    return getSeatOrderFrom(this.state, source, includeSource);
  }

  /** 令所有观察者关于已离开原手牌的实体牌记忆立即失效。 */
  invalidateCardKnowledge(cardId, ownerId) {
    for (const player of this.state.players) {
      const known = player.aiMemory?.knownCardsByPlayer?.[ownerId];
      if (known) delete known[cardId];
    }
  }

  rememberPrivateCard(viewer, owner, card) {
    const bucket = viewer.aiMemory.knownCardsByPlayer[owner.id] ??= {};
    bucket[card.id] = card.definitionId;
  }

  isCardKnownTo(viewer, owner, card) {
    if (!viewer || !owner || !card) return false;
    if (viewer.id === owner.id && owner.hand.includes(card)) return true;
    return viewer.aiMemory?.knownCardsByPlayer?.[owner.id]?.[card.id] === card.definitionId;
  }

  cardLabelForHuman(owner, card) {
    const human = this.state.players.find((player) => player.controllerType === "human") ?? this.state.players[0];
    return this.isCardKnownTo(human, owner, card) ? `「${card.name}」` : "1张手牌";
  }

  /*
  功能
  在真人令牌选择与 AI 隐藏位置策略之间统一选择手牌实体。

  调用方
  掠夺、破坏、转移、窥牌与其他隐藏手牌流程。

  输入
  行动者、持有者、数量、提示、可选选择描述、排除集合与 AI 用途上下文。

  输出
  已去重且仍在合法位置的实体牌数组。

  读取状态
  当前 GameState、CardSelectionSystem、UI 与 AIController 隐藏选择门面。

  写入状态
  创建或清理短期选择令牌，AI 路径可能消费随机源。

  调用函数
  CardSelectionSystem、UI.requestHiddenCards、AIController.chooseHiddenCards。

  边界与不变量
  真人选择按令牌和实体 ID 复核；AI 未知牌不得按真实定义筛选。
  */
  async chooseHiddenCards(actor, owner, count, reason, selection = null, excludedCardIds = null, aiContext = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return [];
    const eligibleCards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const maximum = Math.min(count, eligibleCards.length);
    if (!maximum) {
      if (selection?.selectionId) this.cardSelectionSystem.clearSelection(selection.selectionId);
      return [];
    }
    if (selection?.tokens?.length) {
      if (!selection.selectionId) return [];
      const uniqueTokens = [...new Set(selection.tokens)].slice(0, maximum);
      const resolved = uniqueTokens.map((token) => this.cardSelectionSystem.resolveToken(token, owner, selection.selectionId))
        .filter((card) => card && !excludedCardIds?.has(card.id));
      const cards = [...new Map(resolved.map((card) => [card.id, card])).values()];
      if (selection.selectionId) this.cardSelectionSystem.clearSelection(selection.selectionId);
      return cards;
    }
    if (actor.controllerType === "human") {
      const hidden = this.cardSelectionSystem.createHiddenSelection(owner, eligibleCards);
      const tokens = await this.ui.requestHiddenCards?.(hidden, maximum, reason, { exact:true, viewer:actor, owner });
      if (!this.isSessionValid(gameId)) return [];
      const uniqueTokens = [...new Set(tokens ?? [])].slice(0, maximum);
      const resolved = uniqueTokens.map((token) => this.cardSelectionSystem.resolveToken(token, owner, hidden.selectionId))
        .filter((card) => card && !excludedCardIds?.has(card.id));
      const cards = [...new Map(resolved.map((card) => [card.id, card])).values()];
      this.cardSelectionSystem.clearSelection(hidden.selectionId);
      return cards;
    }
    return this.aiController.chooseHiddenCards(actor, owner, maximum, excludedCardIds, aiContext);
  }

  /*
  功能
  在目标隐藏手牌与公开装备之间选择一个资源实体。

  调用方
  掠夺、破坏和其他区域资源流程。

  输入
  行动者、持有者、提示、可选选择描述、排除集合与 AI 用途上下文。

  输出
  带 card 和 zone 的选择；无合法资源时为 null。

  读取状态
  当前 GameState、CardSelectionSystem、UI 与 AIController 区域选择门面。

  写入状态
  可能创建或清理短期选择令牌。

  调用函数
  chooseHiddenCards、UI.requestZoneCard、AIController.chooseZoneCard。

  边界与不变量
  核心始终重新验证实体仍在原区域；AI 未知手牌不得按真实定义比较。
  */
  async choosePlayerZoneCard(actor, owner, reason, selection = null, excludedCardIds = null, aiContext = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return null;
    const eligibleHandCount = owner?.hand?.filter((card) => !excludedCardIds?.has(card.id)).length ?? 0;
    if (!owner?.alive || (!eligibleHandCount && !owner.equipment)) return null;
    if (selection?.zone === "equipment") {
      if (!selection.selectionId || !this.cardSelectionSystem.isSelectionActive(selection.selectionId, owner)) return null;
      const equipment = owner.equipment;
      const chosen = equipment && equipment.id === selection.equipmentCardId ? { card:equipment, zone:"equipment" } : null;
      this.cardSelectionSystem.clearSelection(selection.selectionId);
      return chosen;
    }
    if (selection?.tokens?.length) {
      const [card] = await this.chooseHiddenCards(actor, owner, 1, reason, selection, excludedCardIds);
      if (!this.isSessionValid(gameId)) return null;
      return card ? { card, zone:"hand" } : null;
    }
    if (actor.controllerType === "human") {
      const requested = await this.ui.requestZoneCard?.(this, actor, owner, reason, excludedCardIds);
      if (!this.isSessionValid(gameId)) return null;
      return requested ? this.choosePlayerZoneCard(actor, owner, reason, requested, excludedCardIds) : null;
    }
    return this.aiController.chooseZoneCard(actor, owner, aiContext, excludedCardIds);
  }

  /** 统一添加公开日志。 */
  log(message, kind = "normal") {
    if (!this.isSessionValid(this.state.gameId)) return null;
    return this.logger.add(message, kind);
  }

  /** 同步状态中的便捷别名，避免牌堆重洗替换数组后旧引用失效。 */
  syncDeckAliases() {
    this.state.discardPile = this.state.deck.discardPile;
    this.state.resolvingCards = this.state.deck.resolvingCards;
    this.state.judgmentZone = this.state.deck.judgmentZone;
  }

  /** 校验异步回调仍属于本局且游戏未销毁。 */
  isSessionValid(gameId) {
    const ownsUi = typeof this.ui?.isSessionCurrent !== "function" || this.ui.isSessionCurrent();
    return !this.state.isDisposed && this.state.gameId === gameId && ownsUi;
  }

  /*
  功能
  转发 Application MatchWorkflow.dispose。

  调用方
  main restart 与 tests。

  输入
  无。

  输出
  无。

  读取状态
  无额外状态。

  写入状态
  无额外写入。

  调用函数
  this.matchWorkflow.dispose。

  边界与不变量
  match lifecycle authority 在 Application Match；EventBus concrete cleanup 仍经 collaborator。
  */
  dispose() {
    return this.matchWorkflow.dispose();
  }
}

// 对外导出用于 UI 说明与测试，业务代码仍通过 RuleEngine 检查合法性。
export { CARD_DEFINITIONS, RuleEngine };
