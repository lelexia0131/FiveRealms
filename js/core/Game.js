/**
 * 本文件是对局编排器，连接配置、牌堆、事件、响应、卡牌、技能、AI 和 UI。
 * 它负责所有状态变化的唯一入口与完整回合循环；UI 只能调用公开交互方法，不能直接改生命或手牌。
 * 每次重新开始会创建新 Game，并调用 dispose 清理本实例的监听器、延迟和 Promise。
 */
import { GAME_CONFIG, TEAM_CONFIG } from "../config/gameConfig.js?build=20260731-shade-svg-kill-v30";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260731-shade-svg-kill-v30";
import { createId, clamp } from "../utils/helpers.js?build=20260731-shade-svg-kill-v30";
import { EventBus } from "./EventBus.js?build=20260731-shade-svg-kill-v30";
import { Player } from "./Player.js?build=20260731-shade-svg-kill-v30";
import { Deck } from "./Deck.js?build=20260731-shade-svg-kill-v30";
import { TeamManager } from "./TeamManager.js?build=20260731-shade-svg-kill-v30";
import { GeneralSelection } from "./GeneralSelection.js?build=20260731-shade-svg-kill-v30";
import { RuleEngine } from "./RuleEngine.js?build=20260731-shade-svg-kill-v30";
import { ResponseSystem, RESPONSE_STATUS, isCancelledResponse } from "./ResponseSystem.js?build=20260731-shade-svg-kill-v30";
import { GameLogger } from "./GameLogger.js?build=20260731-shade-svg-kill-v30";
import { resolveCardEffect } from "../cards/cardRegistry.js?build=20260731-shade-svg-kill-v30";
import { registerPassiveSkills, getActiveSkill } from "../generals/skillRegistry.js?build=20260731-shade-svg-kill-v30";
import { AIController } from "../ai/AIController.js?build=20260731-shade-svg-kill-v30";
import { CleanupManager } from "../utils/CleanupManager.js?build=20260731-shade-svg-kill-v30";
import { getAiDelay } from "../utils/aiTiming.js?build=20260731-shade-svg-kill-v30";
import { Debug } from "../utils/debug.js?build=20260731-shade-svg-kill-v30";
import { TeamRuleService } from "./TeamRuleService.js?build=20260731-shade-svg-kill-v30";
import { DyingSystem } from "./DyingSystem.js?build=20260731-shade-svg-kill-v30";
import { JudgmentSystem } from "./JudgmentSystem.js?build=20260731-shade-svg-kill-v30";
import { CardSelectionSystem } from "./CardSelectionSystem.js?build=20260731-shade-svg-kill-v30";
import { PublicCardPool } from "./PublicCardPool.js?build=20260731-shade-svg-kill-v30";
import { HpLossSystem } from "./HpLossSystem.js?build=20260731-shade-svg-kill-v30";

/** 生成纯展示用的公开目标文案，不参与卡牌合法性或结算。 */
function actionTargetLabel(game, source, cardOrSkill, targets = [], selection = null) {
  const uniqueTargets = [...new Map(
    targets.filter((target) => target?.id && target?.name).map((target) => [target.id, target])
  ).values()];
  if (uniqueTargets.length) {
    return uniqueTargets
      .map((target) => target.id === source.id ? `${target.name}（自己）` : target.name)
      .join("、");
  }
  if (cardOrSkill?.definitionId === "transfer" && selection?.sourceId && selection?.receiverId) {
    const from = game.state.players.find((player) => player.id === selection.sourceId);
    const receiver = game.state.players.find((player) => player.id === selection.receiverId);
    if (from && receiver) return `来源 ${from.name} → 接收 ${receiver.name}`;
  }
  return "";
}

export class Game {
  /**
   * @param {Object} ui UIManager 实例。
   * @param {()=>number} random 可替换随机源，自动测试可传入确定序列。
   */
  constructor(ui, random = Math.random) {
    this.random = random;
    this.cleanupManager = new CleanupManager();
    this.generalSelection = new GeneralSelection(random);
    const deck = new Deck(random);
    this.state = {
      gameId: createId("game"), players: [], deck, discardPile: deck.discardPile,
      resolvingCards: deck.resolvingCards, currentPlayerIndex: -1, startingPlayerIndex: -1,
      currentRound: GAME_CONFIG.initialRound, phase: "idle", pendingAction: null,
      pendingResponses: [], activeEffects: [], selectedGeneralId: null, winnerTeam: null,
      publicCardPool: [], currentJudgment: null, dyingContext: null,
      isGameOver: false, isDisposed: false, logs: [], debugHistory: [], resolutionSerial: 0
    };
    this.uiManager = ui;
    this.ui = ui.createGameSession?.(this) ?? ui;
    this.eventBus = new EventBus(() => this.isSessionValid(this.state.gameId));
    this.logger = new GameLogger(this.state, this.ui);
    this.responseSystem = new ResponseSystem(this);
    this.teamRules = new TeamRuleService(this);
    this.cardSelectionSystem = new CardSelectionSystem(this);
    this.dyingSystem = new DyingSystem(this);
    this.judgmentSystem = new JudgmentSystem(this);
    this.hpLossSystem = new HpLossSystem(this);
    this.publicCardPool = new PublicCardPool(this);
    this.aiController = new AIController(this);
    this.candidates = [];
    this.actionLocked = false;
    this.interactionLocked = false;
    this.pendingHumanPlayEnd = false;
    this.animationFastMode = GAME_CONFIG.animationFastMode;
    this.simulationMode = GAME_CONFIG.simulationMode;
    this.aiReplanAfterEveryAction = GAME_CONFIG.aiReplanAfterEveryAction;
    this.aiRandomnessRange = GAME_CONFIG.aiRandomnessRange;
    this.aiDifficultyMultiplier = GAME_CONFIG.aiDifficultyMultiplier;
    this.loopPromise = null;
  }

  /** 当前行动角色；索引尚未设置时返回 null。 */
  get currentPlayer() {
    return this.state.players[this.state.currentPlayerIndex] ?? null;
  }

  /** 切换展示节奏；只影响可清理等待与 CSS 动画，不改变规则或 AI 评分。 */
  setAnimationFastMode(enabled) {
    this.animationFastMode = Boolean(enabled);
    this.ui.setFastMode?.(this.animationFastMode);
    return this.animationFastMode;
  }

  /**
   * 生成新阵营与四名候选角色。此时不会发牌或启动回合。
   * @returns {Array<Object>} 候选角色配置。
   */
  startSelection() {
    if (this.state.isDisposed) return [];
    const teams = TeamManager.assignTeams(this.random);
    this.state.players = teams.map((battleTeam, seatIndex) => new Player({
      id: createId("player"), seatIndex, battleTeam, controllerType: seatIndex === 0 ? "human" : "ai"
    }));
    for (const player of this.state.players) player.maxEnergy = this.teamRules.getMaxEnergy(player);
    this.candidates = this.generalSelection.createCandidates();
    this.eventBus.emit("teamAssigned", { type: "teamAssigned", players: this.state.players });
    return this.candidates;
  }

  /**
   * 确认真选角色、分配电脑角色、构建牌堆和启动异步回合循环。
   * @param {string} generalId 候选角色 ID。
   * @returns {Promise<void>} 完成初始牌发放后返回；循环会继续在后台等待人类操作。
   */
  async confirmGeneral(generalId) {
    const gameId = this.state.gameId;
    const selected = this.candidates.find((general) => general.id === generalId);
    if (!selected || this.state.selectedGeneralId) throw new Error("角色选择无效或已确认");
    const human = this.state.players[0];
    human.applyGeneral(selected);
    this.state.selectedGeneralId = selected.id;
    const aiPlayers = this.state.players.slice(1);
    const smallTeamId = ["dawn","dusk"].find((team) => this.teamRules.getTeamSize(team) === GAME_CONFIG.smallTeamSize);
    const assigned = this.generalSelection.assignAiGenerals(aiPlayers, selected.id, smallTeamId);
    aiPlayers.forEach((player, index) => player.applyGeneral(assigned[index]));

    this.registerGlobalRules();
    registerPassiveSkills(this);
    this.state.deck.build();
    this.syncDeckAliases();
    for (const player of this.state.players) {
      player.resetTurnFlags(this.teamRules.getRules(player));
      player.resetRoundFlags();
      await this.drawCards(player, this.teamRules.getInitialHandCount(player), "初始发牌");
      if (!this.isSessionValid(gameId)) return false;
    }
    this.state.startingPlayerIndex = Math.floor(this.random() * this.state.players.length);
    this.state.currentPlayerIndex = this.state.startingPlayerIndex;
    await this.eventBus.emit("generalSelected", { type: "generalSelected", player: human, general: selected });
    if (!this.isSessionValid(gameId)) return false;
    await this.eventBus.emit("gameStart", { type: "gameStart", game: this });
    if (!this.isSessionValid(gameId)) return false;

    const dawnCount = TeamManager.teamSize(this.state.players, "dawn");
    const duskCount = TeamManager.teamSize(this.state.players, "dusk");
    this.log(`本局晨星阵营有${dawnCount}名角色，暮影阵营有${duskCount}名角色。`, "important");
    this.log(`你选择了${human.name}，你的阵营是${TEAM_CONFIG[human.battleTeam].name}。`, "important");
    this.log(`电脑角色为${aiPlayers.map((player) => player.name).join("、")}。`);
    this.log(`${this.currentPlayer.name}获得首个行动回合。`, "important");
    this.ui.render(this);
    this.loopPromise = this.runGameLoop();
    return true;
  }

  /** 注册装备与状态等不属于特定角色的事件规则。 */
  registerGlobalRules() {
    this.eventBus.on("cardUsed", "global:recycleDevice", async (event) => {
      const owner = event.source;
      if (!owner.alive || this.currentPlayer?.id !== owner.id || owner.equipment?.definitionId !== "recycleDevice"
        || event.card.category !== "tactic" || event.card.usageMode !== "active" || (owner.turnFlags.recycleDeviceUses ?? 0) >= 2) return;
      owner.turnFlags.recycleDeviceUses = (owner.turnFlags.recycleDeviceUses ?? 0) + 1;
      this.log(`${owner.name}的回收站启动（${owner.turnFlags.recycleDeviceUses}/2），摸1张牌。`);
      await this.drawCards(owner, 1, "回收站");
    });
  }

  /**
   * 持续运行轮次直到胜负或销毁。每次 await 后都会校验 gameId，防止旧循环污染新局。
   * @returns {Promise<void>}
   */
  async runGameLoop() {
    const gameId = this.state.gameId;
    this.log(`第${this.state.currentRound}轮开始。`, "important");
    for (const player of this.state.players) player.resetRoundFlags();
    await this.eventBus.emit("roundStart", { type: "roundStart", round: this.state.currentRound });
    if (!this.isSessionValid(gameId)) return;
    while (this.isSessionValid(gameId) && !this.state.isGameOver) {
      const player = this.currentPlayer;
      if (player?.alive) await this.takeTurn(player, gameId);
      if (!this.isSessionValid(gameId) || this.state.isGameOver) break;
      await this.advanceTurn();
    }
  }

  /**
   * 执行角色的六阶段完整回合；真人出牌和弃牌阶段会异步等待 UI。
   * @param {Player} player 行动角色。
   * @param {string} gameId 当前会话标识。
   */
  async takeTurn(player, gameId) {
    if (!this.isSessionValid(gameId) || !player?.alive || this.state.isGameOver) return;
    this.state.phase = "turnStart";
    player.resetTurnFlags(this.teamRules.getRules(player));
    if (player.statuses.temporaryShield) {
      const remaining = Math.min(player.shield, player.statuses.temporaryShield.amount ?? 0);
      player.shield -= remaining;
      delete player.statuses.temporaryShield;
      if (remaining > 0) this.log(`${player.name}的壁垒护盾在回合开始时消散。`);
    }
    this.log(`${player.name}的回合开始。`, "important");
    await this.eventBus.emit("turnStart", { type: "turnStart", player });
    if (!this.isSessionValid(gameId) || !player.alive || this.state.isGameOver) return;
    this.ui.render(this);

    this.state.phase = "status";
    const statusEvent = { type: "beforeStatusResolve", player, cancelled: false };
    await this.eventBus.emit("beforeStatusResolve", statusEvent);
    if (!this.isSessionValid(gameId)) return;
    await this.eventBus.emit("afterStatusResolve", { ...statusEvent, type: "afterStatusResolve" });
    if (!this.isSessionValid(gameId) || !player.alive || this.state.isGameOver) return;

    this.state.phase = "energy";
    const energyParts = this.teamRules.getTurnEnergyBreakdown(player);
    const energyEvent = { type:"beforeTurnEnergyGain", player, ...energyParts, amount:energyParts.baseAmount + energyParts.teamBonus + energyParts.equipmentBonus, cancelled:false, metadata:{} };
    await this.eventBus.emit("beforeTurnEnergyGain", energyEvent);
    if (!this.isSessionValid(gameId)) return;
    let energyGained = 0;
    if (!energyEvent.cancelled) energyGained = await this.gainEnergy(player, Math.max(0, energyEvent.amount), { reason:"回合开始" });
    if (!this.isSessionValid(gameId)) return;
    await this.eventBus.emit("afterTurnEnergyGain", { ...energyEvent, type:"afterTurnEnergyGain", actualAmount:energyGained });
    if (!this.isSessionValid(gameId) || !player.alive || this.state.isGameOver) return;

    this.state.phase = "draw";
    const drawEvent = { type: "beforeDraw", player, count: this.teamRules.getDrawCount(player), cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeDraw", drawEvent);
    if (!this.isSessionValid(gameId)) return;
    if (!drawEvent.cancelled) await this.drawCards(player, Math.max(0, drawEvent.count), "回合摸牌");
    if (!this.isSessionValid(gameId)) return;
    await this.eventBus.emit("afterDraw", { ...drawEvent, type: "afterDraw" });
    if (!this.isSessionValid(gameId) || !player.alive || this.state.isGameOver) return;

    this.state.phase = "play";
    await this.eventBus.emit("playPhaseStart", { type: "playPhaseStart", player });
    if (!this.isSessionValid(gameId)) return;
    this.ui.render(this);
    if (player.controllerType === "human") {
      this.ui.setPrompt("你的出牌阶段：选择手牌、发动技能，或结束出牌。", "从手牌中选择可用牌");
      const completed = await this.ui.waitForHumanPlayEnd(gameId);
      if (!completed || !this.isSessionValid(gameId)) return;
    } else {
      await this.takeAiPlayPhase(player, gameId);
    }
    if (!this.isSessionValid(gameId) || this.state.isGameOver || !player.alive) return;
    await this.eventBus.emit("playPhaseEnd", { type: "playPhaseEnd", player });
    if (!this.isSessionValid(gameId)) return;

    this.state.phase = "discard";
    await this.handleDiscardPhase(player, gameId);
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return;

    this.state.phase = "turnEnd";
    await this.eventBus.emit("turnEnd", { type: "turnEnd", player });
    if (!this.isSessionValid(gameId)) return;
    this.log(`${player.name}的回合结束。`);
    this.ui.render(this);
  }

  /** AI 先公开思考，再取样可清理等待，随后公开行动意图并执行。 */
  async takeAiPlayPhase(player, gameId) {
    this.ui.setPrompt(`${player.name}进入出牌阶段，正在观察战场。`, "电脑正在行动");
    this.ui.setThinking(true, player, "正在观察战场与可用资源");
    const complexPosition = this.aiController.getLegalActions(player).length > GAME_CONFIG.aiBeamWidth;
    if (!(await this.cleanupManager.delay(getAiDelay(this, "initial", { complex:complexPosition })))) {
      return;
    }
    let queuedPlan = [];
    for (let count = 0; count < GAME_CONFIG.aiMaxActionsPerTurn; count += 1) {
      if (!this.isSessionValid(gameId) || this.state.isGameOver || !player.alive) break;
      let searchElapsed = 0;
      let action = null;
      if (!this.aiReplanAfterEveryAction && queuedPlan.length) {
        action = this.aiController.resolvePlannedAction(player, queuedPlan.shift());
        if (!action) queuedPlan = [];
      }
      if (!action) {
        const searchStarted = globalThis.performance?.now?.() ?? Date.now();
        action = await this.aiController.selectAction(player, { gameId });
        if (!this.isSessionValid(gameId)) return;
        searchElapsed = (globalThis.performance?.now?.() ?? Date.now()) - searchStarted;
        if (!this.aiReplanAfterEveryAction) queuedPlan = this.aiController.planner.lastPlannedSequence.slice(1);
      }
      if (action.type === "end") {
        this.ui.setPrompt(`${player.name}准备结束出牌阶段。`);
        this.ui.setThinking(true, player, "正在收束回合");
        await this.cleanupManager.delay(Math.max(0, getAiDelay(this, "end") - searchElapsed));
        if (!this.isSessionValid(gameId)) return;
        break;
      }
      const actionName = action.type === "card" ? `准备使用「${action.card.name}」` : `准备发动「${action.skill.name}」`;
      const targetLabel = actionTargetLabel(this, player, action.type === "card" ? action.card : action.skill, action.targets, action.selection);
      const actionDescription = `${actionName}${targetLabel ? `，作用对象：${targetLabel}` : ""}`;
      this.ui.setThinking(true, player, actionDescription);
      if (!(await this.cleanupManager.delay(Math.max(0, getAiDelay(this, "action") - searchElapsed)))) break;
      this.ui.setThinking(false);
      if (action.type === "card") await this.playCard(player, action.card, action.targets, action.selection ?? null);
      else if (action.type === "skill") await this.useActiveSkill(player, action.skill.id, action.targets);
      if (!this.isSessionValid(gameId)) return;
    }
    this.ui.setThinking(false);
    if (this.isSessionValid(gameId) && !this.state.isGameOver) this.ui.setPrompt(`${player.name}结束了出牌阶段。`);
  }

  /** 处理手牌上限；真人必须选择准确数量，电脑按价值自动弃置。 */
  async handleDiscardPhase(player, gameId) {
    const required = Math.max(0, player.hand.length - Math.max(0, player.hp));
    if (!required) return;
    this.log(`${player.name}需要弃置${required}张牌。`);
    let cards = [];
    if (player.controllerType === "human") cards = await this.ui.requestDiscard(player, required, `手牌上限为${player.hp}，请选择${required}张弃牌`);
    else {
      this.ui.setThinking(true, player, `正在斟酌弃置${required}张牌`);
      if (!(await this.cleanupManager.delay(getAiDelay(this, "discard")))) return;
      cards = this.aiController.chooseDiscards(player, required);
      this.ui.setThinking(false);
    }
    if (!this.isSessionValid(gameId)) return;
    for (const card of cards.slice(0, required)) {
      await this.discardCardFromHand(player, card, "弃牌阶段");
      if (!this.isSessionValid(gameId)) return;
    }
  }

  /** 移动到下一名存活角色，并在经过首发座位时开始新轮。 */
  async advanceTurn() {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return;
    await this.cleanupDefeatedZones();
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return;
    let wrapped = false;
    let next = this.state.currentPlayerIndex;
    for (let step = 0; step < this.state.players.length; step += 1) {
      next = (next + 1) % this.state.players.length;
      if (next === this.state.startingPlayerIndex) wrapped = true;
      if (this.state.players[next].alive) break;
    }
    if (wrapped) {
      await this.eventBus.emit("roundEnd", { type: "roundEnd", round: this.state.currentRound });
      if (!this.isSessionValid(gameId)) return;
      this.state.currentRound += 1;
      for (const player of this.state.players) player.resetRoundFlags();
      this.log(`第${this.state.currentRound}轮开始。`, "important");
      await this.eventBus.emit("roundStart", { type: "roundStart", round: this.state.currentRound });
      if (!this.isSessionValid(gameId)) return;
    }
    this.state.currentPlayerIndex = next;
  }

  /**
   * 在反制窗口前固定转移的来源、接收者和实体牌。私密结算对象与公开响应对象
   * 使用不同引用；AI 的组合计划仍会在这里通过 RuleEngine 复核。
   */
  async prepareTransferIntent(source, card, selection = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return null;
    const excludedCardIds = new Set([card.id]);
    const sources = RuleEngine.getTransferSources(this, source, card, excludedCardIds)
      .filter((from) => RuleEngine.getTransferReceivers(this, source, from, card).length);
    const planned = selection?.sourceId && selection?.receiverId
      ? selection
      : this.aiController.cardSelector.chooseTransferCombination(source, card, sources, null, excludedCardIds);
    const from = this.state.players.find((player) => player.id === planned?.sourceId && player.alive) ?? null;
    const receiver = this.state.players.find((player) => player.id === planned?.receiverId && player.alive) ?? null;
    if (!sources.includes(from) || !RuleEngine.getTransferReceivers(this, source, from, card).includes(receiver)) return null;

    let chosen = null;
    if (source.controllerType === "ai" && planned?.zone === "equipment") {
      chosen = from.equipment && (!planned.equipmentCardId || from.equipment.id === planned.equipmentCardId)
        ? { card:from.equipment, zone:"equipment" }
        : null;
    } else if (source.controllerType === "ai" && planned?.zone === "hand") {
      const [hiddenCard] = this.aiController.cardSelector.chooseHiddenCards(source, from, 1, excludedCardIds);
      chosen = hiddenCard ? { card:hiddenCard, zone:"hand" } : null;
    } else {
      chosen = await this.choosePlayerZoneCard(source, from, "选择要转移的手牌或装备牌", planned, excludedCardIds);
    }
    if (!this.isSessionValid(gameId)) return null;
    if (!chosen || excludedCardIds.has(chosen.card.id)
      || !RuleEngine.getTransferSources(this, source, card, excludedCardIds).includes(from)
      || !RuleEngine.getTransferReceivers(this, source, from, card).includes(receiver)) return null;
    const privateIntent = Object.freeze({ from, receiver, card:chosen.card, zone:chosen.zone });
    const publicContext = Object.freeze({
      fromPlayerId:from.id,
      fromName:from.name,
      receiverPlayerId:receiver.id,
      receiverName:receiver.name,
      zone:chosen.zone,
      safeItemLabel:chosen.zone === "equipment" ? `装备「${chosen.card.name}」` : "1张牌"
    });
    return Object.freeze({ privateIntent, publicContext });
  }

  /**
   * 在反制窗口打开前消费短期隐藏选择令牌，并把结果固化为仅供最终解析器使用的实体意图。
   * 公开上下文只保留玩家、区域与数量；实体牌、定义和名称不会进入响应链。
   */
  async preparePrivateCardSelectionIntent(source, card, targets, selection = null) {
    const gameId = this.state.gameId;
    const target = targets[0] ?? null;
    if (!this.isSessionValid(gameId) || !target?.alive
      || !RuleEngine.getCardTargets(this, source, card).includes(target)) return null;

    try {
      let zone = "hand";
      let cards = [];
      if (card.definitionId === "scout") {
        cards = await this.chooseHiddenCards(
          source,
          target,
          Math.min(2, target.hand.length),
          "选择至多2张手牌进行窥探",
          selection
        );
      } else if (["plunder", "destroy"].includes(card.definitionId)) {
        const chosen = await this.choosePlayerZoneCard(
          source,
          target,
          card.definitionId === "plunder" ? "选择要掠夺的手牌或装备牌" : "选择要破坏的手牌或装备牌",
          selection
        );
        if (chosen) {
          zone = chosen.zone;
          cards = [chosen.card];
        }
      } else return null;

      if (!this.isSessionValid(gameId) || !cards.length
        || !RuleEngine.getCardTargets(this, source, card).includes(target)) return null;
      const uniqueCards = [...new Map(cards.map((entity) => [entity.id, entity])).values()];
      const privateIntent = Object.freeze({
        owner:target,
        zone,
        cards:Object.freeze(uniqueCards),
        selectionId:selection?.selectionId ?? null
      });
      const publicContext = Object.freeze({
        ownerPlayerId:target.id,
        zone,
        selectedCount:uniqueCards.length
      });
      return Object.freeze({ privateIntent, publicContext });
    } finally {
      if (selection?.selectionId) this.cardSelectionSystem.clearSelection(selection.selectionId);
    }
  }

  /**
   * 被动技能的私密窥牌入口：真人复用不透明牌背选择，AI 只按合法记忆或隐藏位置选择。
   * 确认后立即清除 UI token，只把稳定实体意图留在当前异步调用栈中。
   */
  async preparePrivateHandPeekIntent(viewer, owner, count, reason) {
    const gameId = this.state.gameId;
    const maximum = Math.min(Math.max(0, count), owner?.hand?.length ?? 0);
    if (!this.isSessionValid(gameId) || !viewer?.alive || !owner?.alive || !maximum) return null;
    if (viewer.controllerType !== "human") {
      const cards = this.aiController.cardSelector.chooseHiddenCards(viewer, owner, maximum);
      return cards.length ? Object.freeze({ owner, zone:"hand", cards:Object.freeze([...cards]), selectionId:null }) : null;
    }

    const hidden = this.cardSelectionSystem.createHiddenSelection(owner);
    try {
      const tokens = await this.ui.requestHiddenCards?.(hidden, maximum, reason, {
        exact:false, viewer, owner,
        helpText:"隐藏牌只使用临时令牌；确认时核心会重新验证所选实体仍在目标手牌中。"
      });
      if (!this.isSessionValid(gameId) || !viewer.alive || !owner.alive) return null;
      const cards = this.cardSelectionSystem.resolveConfirmedTokens(tokens, owner, hidden.selectionId, maximum);
      return cards.length
        ? Object.freeze({ owner, zone:"hand", cards:Object.freeze(cards), selectionId:hidden.selectionId })
        : null;
    } finally {
      this.cardSelectionSystem.clearSelection(hidden.selectionId);
    }
  }

  /** 结算私密窥牌意图时只保留仍在原角色手牌区的实体。 */
  resolvePrivateHandPeekIntent(viewer, intent) {
    if (!this.isSessionValid(this.state.gameId) || !viewer?.alive || !intent?.owner?.alive || intent.zone !== "hand") return [];
    return intent.cards.filter((card) => intent.owner.hand.includes(card));
  }

  /**
   * 使用一张主动牌。卡牌从手牌先进入结算区，完成或取消后才进入弃牌堆/装备区。
   * @returns {Promise<boolean>} 是否实际开始结算。
   */
  async playCard(source, card, requestedTargets = [], selection = null) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return false;
    const legality = RuleEngine.canPlayCard(this, source, card);
    if (!legality.ok || this.actionLocked) return false;
    let targets = requestedTargets;
    const legalTargets = RuleEngine.getCardTargets(this, source, card);
    if (card.targetType === "self") targets = [source];
    if (card.targetType === "allEnemies") targets = legalTargets;
    if (card.targetType === "allLiving") targets = legalTargets;
    if (!["none", "self", "allEnemies", "allLiving", "multiStage"].includes(card.targetType) && (!targets[0] || !legalTargets.includes(targets[0]))) return false;
    const preparedTransfer = card.definitionId === "transfer"
      ? await this.prepareTransferIntent(source, card, selection)
      : null;
    const needsPrivateSelection = ["scout", "plunder", "destroy"].includes(card.definitionId);
    const preparedPrivateSelection = needsPrivateSelection
      ? await this.preparePrivateCardSelectionIntent(source, card, targets, selection)
      : null;
    if (!this.isSessionValid(gameId)) return false;
    if (card.definitionId === "transfer" && !preparedTransfer) return false;
    if (needsPrivateSelection && !preparedPrivateSelection) return false;

    this.actionLocked = true;
    const resolutionId = `${this.state.gameId}:resolution:${++this.state.resolutionSerial}`;
    try {
      await this.moveHandToResolving(source, card);
      if (!this.isSessionValid(gameId)) return false;
      const targetLabel = preparedTransfer
        ? `来源 ${preparedTransfer.publicContext.fromName} → 接收 ${preparedTransfer.publicContext.receiverName}`
        : actionTargetLabel(this, source, card, targets, selection);
      this.ui.setCurrentCard(card, source.name, targetLabel);
      if (preparedTransfer) {
        const publicContext = preparedTransfer.publicContext;
        this.log(`${source.name}使用了「${card.name}」，准备将${publicContext.fromName}的${publicContext.safeItemLabel}转移给${publicContext.receiverName}。`);
      } else if (card.category !== "equipment") {
        this.log(`${source.name}使用了「${card.name}」${targetLabel ? `，作用对象：${targetLabel}` : ""}。`);
      }
      const useEvent = await this.eventBus.emit("beforeCardUse", { type: "beforeCardUse", source, card, targets, cancelled: false, metadata: {}, resolutionId });
      if (!this.isSessionValid(gameId)) return false;
      let cancelledBeforeResolve = useEvent.cancelled;
      if (!cancelledBeforeResolve && targets.length) {
        const targetEvent = { type: "targetSelected", source, card, targets, cancelled: false, metadata: {}, resolutionId };
        await this.eventBus.emit("targetSelected", targetEvent);
        if (!this.isSessionValid(gameId)) return false;
        targets = targetEvent.targets;
      }
      const resolveEvent = { type: "beforeCardResolve", source, card, targets, cancelled: false, metadata: {}, resolutionId };
      if (!cancelledBeforeResolve) await this.eventBus.emit("beforeCardResolve", resolveEvent);
      if (!this.isSessionValid(gameId)) return false;
      targets = resolveEvent.targets;
      cancelledBeforeResolve ||= resolveEvent.cancelled;
      // 群伤牌使用逐目标反制，由各目标的效果解析负责；这里不能提前取消整张牌。
      const counterResult = !cancelledBeforeResolve && card.counterScope !== "target"
        ? await this.responseSystem.askForCounter(source, card, targets, {
          publicTransferContext:preparedTransfer?.publicContext ?? null,
          publicSelectionContext:preparedPrivateSelection?.publicContext ?? null
        })
        : { status:RESPONSE_STATUS.UNAVAILABLE };
      if (!this.isSessionValid(gameId) || isCancelledResponse(counterResult)) return false;
      const countered = counterResult?.status === RESPONSE_STATUS.USED;
      let destination = "discard";
      let effectResolved = false;
      if (countered || cancelledBeforeResolve) {
        this.log(`「${card.name}」的效果被取消。`, "important");
      } else {
        const effectResult = await resolveCardEffect(this, source, card, targets, {
          resolutionId, selection,
          privateTransferIntent:preparedTransfer?.privateIntent ?? null,
          privateCardSelectionIntent:preparedPrivateSelection?.privateIntent ?? null
        });
        if (!this.isSessionValid(gameId)) return false;
        destination = effectResult.destination;
        effectResolved = effectResult.resolved ?? true;
      }
      if (destination === "discard") await this.finishResolvingToDiscard(card);
      if (!this.isSessionValid(gameId)) return false;
      source.statistics.cardsPlayed += 1;
      const effectiveTargets = preparedTransfer
        ? (effectResolved ? [preparedTransfer.privateIntent.receiver] : [])
        : preparedPrivateSelection && !effectResolved
          ? []
        : card.definitionId === "mutualBenefit"
          ? this.state.players.filter((player) => player.alive)
          : targets;
      const cancelled = countered || cancelledBeforeResolve
        || Boolean((preparedTransfer || preparedPrivateSelection) && !effectResolved);
      await this.eventBus.emit("cardUsed", {
        type:"cardUsed", source, card, targets, effectiveTargets,
        cancelled, resolved:!cancelled && effectResolved, resolutionId
      });
      if (!this.isSessionValid(gameId)) return false;
      if (selection?.selectionId) this.cardSelectionSystem.clearSelection(selection.selectionId);
      this.ui.render(this);
      return true;
    } finally {
      if (selection?.selectionId) this.cardSelectionSystem.clearSelection(selection.selectionId);
      this.actionLocked = false;
      this.flushPendingHumanPlayEnd();
      if (!this.state.isGameOver && source.controllerType === "human" && this.state.phase === "play") {
        this.ui.setPrompt("继续出牌，或结束本次出牌阶段。", "选择一张可用手牌");
      }
      this.ui.render(this);
    }
  }

  /**
   * 发动玩家的主动技能。技能接口自行扣能量，Game 负责次数锁和目标二次验证。
   */
  async useActiveSkill(source, skillId, targets = []) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return false;
    const skill = getActiveSkill(source);
    if (!skill || skill.id !== skillId || this.actionLocked) return false;
    const legality = skill.canUse(this, source);
    if (!legality.ok) return false;
    const legalTargets = RuleEngine.getSkillTargets(this, source, skill);
    if (!["none", "allEnemies"].includes(skill.targetType) && (!targets[0] || !legalTargets.includes(targets[0]))) return false;
    this.actionLocked = true;
    source.turnFlags.activeSkillsUsed.add(skill.id);
    source.turnFlags.activeSkillUseCounts[skill.id] = (source.turnFlags.activeSkillUseCounts[skill.id] ?? 0) + 1;
    try {
      const targetLabel = actionTargetLabel(this, source, skill, targets);
      this.ui.setCurrentCard(skill.name, `${source.name} · 技能`, targetLabel);
      await skill.execute(this, source, targets);
      if (!this.isSessionValid(gameId)) return false;
      this.ui.render(this);
      return true;
    } finally {
      this.actionLocked = false;
      this.flushPendingHumanPlayEnd();
      if (!this.state.isGameOver && source.controllerType === "human" && this.state.phase === "play") {
        this.ui.setPrompt("技能结算完成，继续出牌或结束阶段。", "选择一张可用手牌");
      }
      this.ui.render(this);
    }
  }

  /** 真人点击手牌的入口；若需要目标则等待统一目标选择。 */
  async handleHumanCard(cardId) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const human = this.state.players[0];
    const card = human.hand.find((entry) => entry.id === cardId);
    if (!card || this.currentPlayer?.id !== human.id || this.state.phase !== "play" || this.actionLocked || this.interactionLocked) return false;
    const legality = RuleEngine.canPlayCard(this, human, card);
    if (!legality.ok) { this.ui.setPrompt(legality.reason); return false; }
    this.interactionLocked = true;
    this.ui.render(this);
    try {
      const legalTargets = RuleEngine.getCardTargets(this, human, card);
      let targets = [];
      if (!["none", "self", "allEnemies", "allLiving", "multiStage"].includes(card.targetType)) {
        const target = await this.ui.requestTarget(legalTargets, `为「${card.name}」选择目标`, { source:human, card });
        if (!this.isSessionValid(gameId)) return false;
        if (!target) return false;
        targets = [target];
      }
      let selection = null;
      if (card.selectionFlow?.length) selection = await this.ui.requestCardFlow?.(this, human, card, targets);
      if (!this.isSessionValid(gameId)) return false;
      if (card.selectionFlow?.length && !selection) return false;
      return await this.playCard(human, card, targets, selection);
    } finally {
      this.interactionLocked = false;
      this.flushPendingHumanPlayEnd();
      this.ui.render(this);
    }
  }

  /** 真人点击主动技能的入口；统一请求合法目标。 */
  async handleHumanSkill() {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const human = this.state.players[0];
    const skill = getActiveSkill(human);
    if (!skill || this.actionLocked || this.interactionLocked || !skill.canUse(this, human).ok) return false;
    this.interactionLocked = true;
    this.ui.render(this);
    try {
      const legalTargets = RuleEngine.getSkillTargets(this, human, skill);
      let targets = [];
      if (!["none", "allEnemies"].includes(skill.targetType)) {
        const target = await this.ui.requestTarget(legalTargets, `为「${skill.name}」选择目标`);
        if (!this.isSessionValid(gameId)) return false;
        if (!target) return false;
        targets = [target];
      }
      return await this.useActiveSkill(human, skill.id, targets);
    } finally {
      this.interactionLocked = false;
      this.flushPendingHumanPlayEnd();
      this.ui.render(this);
    }
  }

  /** 真人结束出牌阶段；仅在自己的出牌阶段有效。 */
  requestEndHumanPlay() {
    const human = this.state.players[0];
    if (this.currentPlayer?.id !== human.id || this.state.phase !== "play" || this.actionLocked || this.interactionLocked) return false;
    this.ui.resolveHumanPlayEnd(this.state.gameId);
    return true;
  }

  /** 标记当前真人已阵亡；等正在结算的卡牌/技能及交互完整退出后再释放出牌等待。 */
  requestHumanPlayEndForDefeat(player) {
    const human = this.state.players[0];
    if (!player || player.id !== human?.id || player.controllerType !== "human" ||
      this.currentPlayer?.id !== player.id) return false;
    this.pendingHumanPlayEnd = true;
    return this.flushPendingHumanPlayEnd();
  }

  /** 只在核心结算锁与 UI 交互锁均释放后结束真人出牌，避免回合循环抢跑。 */
  flushPendingHumanPlayEnd() {
    if (!this.pendingHumanPlayEnd) return false;
    if (this.state.isDisposed) {
      this.pendingHumanPlayEnd = false;
      return false;
    }
    if (this.actionLocked || this.interactionLocked) return false;
    this.pendingHumanPlayEnd = false;
    this.ui.resolveHumanPlayEnd(this.state.gameId);
    return true;
  }

  /**
   * 对目标造成伤害。beforeDamage 可修改数值，之后依次经过格挡、护盾、生命、afterDamage 和阵亡。
   * @returns {Promise<number>} 实际扣除的生命值。
   */
  async damage(source, target, amount, context = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !target?.alive || this.state.isGameOver) return 0;
    const metadata = {};
    const event = {
      type: "beforeDamage", source, target, amount: Math.max(0, amount), card: context.card ?? null,
      skill: context.skill ?? null, damageType: context.damageType ?? "normal", canBlock: context.canBlock ?? false,
      actionName: context.card?.name ?? context.actionName ?? context.reason ?? "伤害",
      cancelled: false, metadata, resolutionId: context.resolutionId ?? createId("skill-resolution")
    };
    await this.eventBus.emit("beforeDamage", event);
    if (!this.isSessionValid(gameId)) return 0;
    if (event.cancelled || event.amount <= 0 || !target.alive) return 0;
    const isDeviceAttack = context.card?.subtypes?.includes("assault") && ["normal", "area"].includes(event.damageType);
    if (isDeviceAttack) {
      const judgment = await this.judgmentSystem.judgeDefense(source, target, event);
      if (!this.isSessionValid(gameId) || judgment.cancelled) return 0;
      if (judgment.immune || !target.alive || this.state.isGameOver) {
        await this.eventBus.emit("afterDamage", { ...event, type:"afterDamage", actualAmount:0, shieldAbsorbed:0, preventedBy:"defenseDevice" });
        return 0;
      }
    }
    const blockResult = await this.responseSystem.askForBlock(source, target, event);
    if (!this.isSessionValid(gameId) || isCancelledResponse(blockResult)) return 0;
    if (blockResult.status === RESPONSE_STATUS.USED) {
      context.blockedByCard = true;
      await this.eventBus.emit("afterDamage", { ...event, type:"afterDamage", actualAmount:0, shieldAbsorbed:0, preventedBy:"block" });
      if (!this.isSessionValid(gameId)) return 0;
      this.ui.render(this);
      return 0;
    }
    const shieldAbsorbed = Math.min(target.shield, event.amount);
    target.shield -= shieldAbsorbed;
    if (shieldAbsorbed && target.statuses.temporaryShield) {
      target.statuses.temporaryShield.amount = Math.max(0, (target.statuses.temporaryShield.amount ?? 0) - shieldAbsorbed);
      if (target.statuses.temporaryShield.amount === 0) delete target.statuses.temporaryShield;
    }
    const hpDamage = Math.max(0, event.amount - shieldAbsorbed);
    target.hp -= hpDamage;
    target.statistics.damageTaken += hpDamage;
    if (source) {
      source.statistics.damageDealt += hpDamage;
      if (hpDamage > 0 && source.battleTeam !== target.battleTeam) target.aiMemory.recentAggressors[source.id] = (target.aiMemory.recentAggressors[source.id] ?? 0) + hpDamage;
    }
    if (shieldAbsorbed) { this.log(`${target.name}的护盾吸收了${shieldAbsorbed}点伤害。`); this.ui.queueFeedback?.("shield", target.id, shieldAbsorbed); }
    if (hpDamage) { this.log(`${target.name}受到${hpDamage}点伤害，剩余${target.hp}点生命。`, "damage"); this.ui.queueFeedback?.("damage", target.id, hpDamage); }
    else this.log(`${target.name}没有受到生命伤害。`);
    await this.eventBus.emit("afterDamage", { ...event, type: "afterDamage", actualAmount: hpDamage, shieldAbsorbed });
    if (!this.isSessionValid(gameId)) return hpDamage;
    if (target.hp <= 0 && target.alive) await this.dyingSystem.enter(target, source, context);
    if (!this.isSessionValid(gameId)) return hpDamage;
    this.ui.render(this);
    return hpDamage;
  }

  /** 统一治疗入口，允许 beforeHeal 修改数值并限制到最大生命。 */
  async heal(source, target, amount, context = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !target?.alive || target.hp >= target.maxHp || this.state.isGameOver) return 0;
    const event = { type: "beforeHeal", source, target, amount: Math.max(0, amount), card: context.card ?? null, skill: context.skill ?? null,
      reason:context.reason ?? "治疗", isDyingRescue:Boolean(context.isDyingRescue), cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeHeal", event);
    if (!this.isSessionValid(gameId)) return 0;
    if (event.cancelled) return 0;
    const actualAmount = Math.min(event.amount, target.maxHp - target.hp);
    target.hp += actualAmount;
    if (source) source.statistics.healingDone += actualAmount;
    if (actualAmount) {
      if (!context.silentLog) this.log(`${target.name}恢复${actualAmount}点生命。`, "heal");
      this.ui.queueFeedback?.("heal", target.id, actualAmount);
    }
    await this.eventBus.emit("afterHeal", { ...event, type: "afterHeal", actualAmount });
    if (!this.isSessionValid(gameId)) return actualAmount;
    this.ui.render(this);
    return actualAmount;
  }

  /** 统一能量获取入口，经过事件修正并限制在 maxEnergy。 */
  async gainEnergy(player, amount, context = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !player?.alive || this.state.isGameOver) return 0;
    const event = { type: "beforeGainEnergy", player, amount, reason: context.reason ?? "效果", card: context.card ?? null, skill: context.skill ?? null, cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeGainEnergy", event);
    if (!this.isSessionValid(gameId)) return 0;
    if (event.cancelled) return 0;
    const actualAmount = player.changeEnergy(event.amount);
    if (actualAmount > 0) { this.log(`${player.name}通过${event.reason}获得${actualAmount}点能量。`); this.ui.queueFeedback?.("energy", player.id, actualAmount); }
    await this.eventBus.emit("afterGainEnergy", { ...event, type: "afterGainEnergy", actualAmount });
    if (!this.isSessionValid(gameId)) return actualAmount;
    this.ui.render(this);
    return actualAmount;
  }

  /** 兼容旧技能入口：生命不大于0时进入完整濒死流程。 */
  async killPlayer(target, source) {
    return this.dyingSystem.enter(target, source);
  }

  /** 若一个阵营无存活者，结束游戏、停止旧交互并显示结果。 */
  async checkVictory() {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return this.state.winnerTeam;
    const dawnAlive = this.state.players.some((player) => player.alive && player.battleTeam === "dawn");
    const duskAlive = this.state.players.some((player) => player.alive && player.battleTeam === "dusk");
    if (dawnAlive && duskAlive) return null;
    const winnerTeam = dawnAlive ? "dawn" : "dusk";
    this.state.winnerTeam = winnerTeam;
    this.state.isGameOver = true;
    this.state.phase = "gameOver";
    this.responseSystem.cleanup();
    this.ui.cancelPendingInteractions();
    this.log(`${TEAM_CONFIG[winnerTeam].name}消灭了全部敌人，获得胜利！`, "important");
    await this.eventBus.emit("gameOver", { type: "gameOver", winnerTeam });
    if (!this.isSessionValid(gameId)) return null;
    this.ui.render(this);
    this.ui.showGameOver(winnerTeam, this.state.players[0].battleTeam === winnerTeam);
    return winnerTeam;
  }

  /** 抽指定数量的牌并逐张触发移动事件；电脑日志只公开数量。 */
  async drawCards(player, count, reason = "摸牌", options = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !player?.alive || this.state.isGameOver) return 0;
    let drawn = 0;
    for (let index = 0; index < count; index += 1) {
      const card = this.state.deck.drawOne();
      this.syncDeckAliases();
      if (!card) break;
      // 跨 beforeCardMove 等待期间先放入受管结算区，避免 dispose 时实体牌悬空。
      if (!this.state.deck.beginResolve(card)) break;
      this.syncDeckAliases();
      const move = { type: "beforeCardMove", card, from: "deck", to: "hand", player, reason, cancelled: false };
      await this.eventBus.emit("beforeCardMove", move);
      if (!this.isSessionValid(gameId)) return drawn;
      if (move.cancelled) {
        this.state.deck.finishResolveToEquipment(card);
        this.state.deck.cards.push(card);
        this.syncDeckAliases();
        continue;
      }
      if (!this.state.deck.finishResolveToEquipment(card)) return drawn;
      player.hand.push(card);
      player.bumpHandVersion();
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

  /** 从玩家手牌公开弃置一张牌；返回是否成功移动。 */
  async discardCardFromHand(player, card, reason = "弃置", options = {}) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const index = player.hand.indexOf(card);
    if (index < 0) return false;
    const move = { type: "beforeCardMove", card, from: "hand", to: "discard", player, reason, cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled) return false;
    player.hand.splice(index, 1);
    player.bumpHandVersion();
    this.invalidateCardKnowledge(card.id, player.id);
    this.state.deck.discard(card);
    this.syncDeckAliases();
    if (!options.silent) this.log(`${player.name}因${reason}弃置了「${card.name}」。`);
    this.ui.queueFeedback?.("discard", player.id);
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /**
   * 原子支付一组手牌：先完成整组 beforeCardMove 预检，再一次性提交所有区域变化。
   * 返回响应状态，调用方只有在 used 时才能把规则响应视为成功。
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

    const indexes = selected.map((card) => player.hand.indexOf(card)).sort((a, b) => b - a);
    for (const index of indexes) player.hand.splice(index, 1);
    player.bumpHandVersion();
    for (const card of selected) {
      this.invalidateCardKnowledge(card.id, player.id);
      this.state.deck.discard(card);
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

  /** 在两名玩家间移动实体手牌；只公开最终牌名，不暴露其余隐藏牌。 */
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
    from.hand.splice(index, 1);
    to.hand.push(card);
    from.bumpHandVersion();
    to.bumpHandVersion();
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

  /** 将公开装备从装备区移入另一名角色手牌；所有观察者继续知道该实体牌。 */
  async moveEquipmentToHand(from, to, card, reason) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !from?.alive || !to?.alive || from.equipment !== card || this.state.isGameOver) return false;
    const move = { type:"beforeCardMove", card, from:"equipment", to:"hand", fromPlayer:from, player:to, reason, cancelled:false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled || from.equipment !== card) return false;
    from.equipment = null;
    to.hand.push(card);
    to.bumpHandVersion();
    this.invalidateCardKnowledge(card.id, from.id);
    for (const viewer of this.state.players) if (viewer.id !== to.id) this.rememberPrivateCard(viewer, to, card);
    this.ui.queueFeedback?.("draw", to.id, 1);
    await this.eventBus.emit("afterCardMove", { ...move, type:"afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /** 将公开装备直接转移到另一名角色装备区；接收者旧装备按替换规则公开弃置。 */
  async moveEquipmentBetweenPlayers(from, to, card, reason) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !from?.alive || !to?.alive || from.id === to.id || from.equipment !== card || this.state.isGameOver) return false;
    const move = { type:"beforeCardMove", card, from:"equipment", to:"equipment", fromPlayer:from, player:to, reason, cancelled:false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled || from.equipment !== card) return false;
    if (to.equipment) {
      const replaced = to.equipment;
      const replaceMove = { type:"beforeCardMove", card:replaced, from:"equipment", to:"discard", player:to, reason:"转移装备替换", cancelled:false };
      await this.eventBus.emit("beforeCardMove", replaceMove);
      if (!this.isSessionValid(gameId) || replaceMove.cancelled) return false;
      to.equipment = null;
      this.state.deck.discard(replaced);
      await this.eventBus.emit("afterCardMove", { ...replaceMove, type:"afterCardMove" });
      if (!this.isSessionValid(gameId)) return false;
      this.log(`${to.name}的「${replaced.name}」被替换并进入弃牌堆。`);
    }
    from.equipment = null;
    to.equipment = card;
    this.invalidateCardKnowledge(card.id, from.id);
    this.syncDeckAliases();
    this.ui.queueFeedback?.("equip", to.id);
    await this.eventBus.emit("afterCardMove", { ...move, type:"afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.log(`${to.name}装备了「${card.name}」。`, "important");
    this.ui.render(this);
    return true;
  }

  /** 从装备区公开弃置实体装备。 */
  async discardEquipment(player, card, reason = "弃置装备") {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId) || !player?.alive || player.equipment !== card) return false;
    const move = { type:"beforeCardMove", card, from:"equipment", to:"discard", player, reason, cancelled:false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled || player.equipment !== card) return false;
    player.equipment = null;
    this.invalidateCardKnowledge(card.id, player.id);
    this.state.deck.discard(card);
    this.syncDeckAliases();
    this.ui.queueFeedback?.("discard", player.id);
    await this.eventBus.emit("afterCardMove", { ...move, type:"afterCardMove" });
    if (!this.isSessionValid(gameId)) return true;
    this.ui.render(this);
    return true;
  }

  /** 将主动牌由手牌移入结算区；防止快速点击重复使用同一实体牌。 */
  async moveHandToResolving(player, card) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const index = player.hand.indexOf(card);
    if (index < 0) throw new Error("卡牌已不在手中");
    const move = { type: "beforeCardMove", card, from: "hand", to: "resolving", player, reason: "使用", cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (move.cancelled) throw new Error("卡牌移动被取消");
    player.hand.splice(index, 1);
    player.bumpHandVersion();
    this.invalidateCardKnowledge(card.id, player.id);
    if (!this.state.deck.beginResolve(card)) throw new Error("卡牌重复进入结算区");
    this.syncDeckAliases();
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    return this.isSessionValid(gameId);
  }

  /** 令结算完成的牌进入弃牌堆。 */
  async finishResolvingToDiscard(card) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const move = { type: "beforeCardMove", card, from: "resolving", to: "discard", reason: "结算完成", cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!this.isSessionValid(gameId)) return false;
    if (!move.cancelled) this.state.deck.finishResolveToDiscard(card);
    this.syncDeckAliases();
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    return this.isSessionValid(gameId);
  }

  /** 将装置放入唯一装备槽，并公开弃置被替换装备。 */
  async equipCard(player, card) {
    const gameId = this.state.gameId;
    if (!this.isSessionValid(gameId)) return false;
    const equipMove = { type: "beforeCardMove", card, from: "resolving", to: "equipment", player, reason: "装备", cancelled: false };
    await this.eventBus.emit("beforeCardMove", equipMove);
    if (!this.isSessionValid(gameId)) return false;
    if (equipMove.cancelled) return false;
    if (player.equipment) {
      const old = player.equipment;
      player.equipment = null;
      const replaceMove = { type: "beforeCardMove", card: old, from: "equipment", to: "discard", player, reason: "替换装备", cancelled: false };
      await this.eventBus.emit("beforeCardMove", replaceMove);
      if (!this.isSessionValid(gameId) || replaceMove.cancelled) return false;
      this.state.deck.discard(old);
      await this.eventBus.emit("afterCardMove", { ...replaceMove, type: "afterCardMove" });
      if (!this.isSessionValid(gameId)) return false;
      this.log(`${player.name}的「${old.name}」被替换并进入弃牌堆。`);
    }
    this.state.deck.finishResolveToEquipment(card);
    player.equipment = card;
    this.syncDeckAliases();
    this.log(`${player.name}装备了「${card.name}」。`, "important");
    this.ui.queueFeedback?.("equip", player.id);
    await this.eventBus.emit("afterCardMove", { ...equipMove, type: "afterCardMove" });
    return this.isSessionValid(gameId);
  }

  /** 返回某角色的存活敌人。 */
  getEnemies(player) { return this.state.players.filter((other) => other.alive && other.battleTeam !== player.battleTeam); }
  /** 返回某角色含自身在内的存活同阵营角色。 */
  getAllies(player) { return this.state.players.filter((other) => other.alive && other.battleTeam === player.battleTeam); }

  /** 守住区域不变量：阵亡角色不能继续占有会阻塞重洗的手牌或装备。 */
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
        this.state.deck.discard(player.equipment);
        player.equipment = null;
      }
    }
    this.syncDeckAliases();
  }

  /** 从指定角色下一座位开始，按环形座位顺序返回角色；includeSource 为 true 时源角色排在首位。 */
  seatOrderFrom(source, includeSource = false) {
    const players = this.state.players;
    const ordered = includeSource ? [source] : [];
    for (let offset = 1; offset < players.length; offset += 1) ordered.push(players[(source.seatIndex + offset) % players.length]);
    return ordered;
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

  async chooseHiddenCards(actor, owner, count, reason, selection = null, excludedCardIds = null) {
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
    return this.aiController.cardSelector.chooseHiddenCards(actor, owner, maximum, excludedCardIds);
  }

  /** 在隐藏手牌与公开装备之间选择一张；核心始终重新验证所选实体仍在原区域。 */
  async choosePlayerZoneCard(actor, owner, reason, selection = null, excludedCardIds = null) {
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
    return this.aiController.cardSelector.chooseZoneCard(actor, owner);
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

  /**
   * 终止本局并清理延迟、响应、事件与 UI Promise。旧异步逻辑会收到 false/null 后自然退出。
   */
  dispose() {
    if (this.state.isDisposed) return;
    this.state.isDisposed = true;
    this.interactionLocked = false;
    this.pendingHumanPlayEnd = false;
    this.cleanupManager.cleanup();
    this.responseSystem.cleanup();
    this.cardSelectionSystem.cleanup();
    this.dyingSystem.cleanup();
    this.publicCardPool.cleanup();
    this.eventBus.clear();
    this.ui.cancelPendingInteractions();
    Debug.log("Game", `清理对局 ${this.state.gameId}`);
  }
}

// 对外导出用于 UI 说明与测试，业务代码仍通过 RuleEngine 检查合法性。
export { CARD_DEFINITIONS, RuleEngine };
