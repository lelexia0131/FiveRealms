/**
 * 本文件是对局编排器，连接配置、牌堆、事件、响应、卡牌、技能、AI 和 UI。
 * 它负责所有状态变化的唯一入口与完整回合循环；UI 只能调用公开交互方法，不能直接改生命或手牌。
 * 每次重新开始会创建新 Game，并调用 dispose 清理本实例的监听器、延迟和 Promise。
 */
import { GAME_CONFIG, TEAM_CONFIG } from "../config/gameConfig.js";
import { CARD_DEFINITIONS } from "../config/cardConfig.js";
import { createId, clamp } from "../utils/helpers.js";
import { EventBus } from "./EventBus.js";
import { Player } from "./Player.js";
import { Deck } from "./Deck.js";
import { TeamManager } from "./TeamManager.js";
import { GeneralSelection } from "./GeneralSelection.js";
import { RuleEngine } from "./RuleEngine.js";
import { ResponseSystem } from "./ResponseSystem.js";
import { GameLogger } from "./GameLogger.js";
import { resolveCardEffect } from "../cards/cardRegistry.js";
import { registerPassiveSkills, getActiveSkill } from "../generals/skillRegistry.js";
import { AIController } from "../ai/AIController.js";
import { CleanupManager } from "../utils/CleanupManager.js";
import { getAiDelay } from "../utils/aiTiming.js";
import { Debug } from "../utils/debug.js";

export class Game {
  /**
   * @param {Object} ui UIManager 实例。
   * @param {()=>number} random 可替换随机源，自动测试可传入确定序列。
   */
  constructor(ui, random = Math.random) {
    this.ui = ui;
    this.random = random;
    this.eventBus = new EventBus();
    this.cleanupManager = new CleanupManager();
    this.generalSelection = new GeneralSelection(random);
    const deck = new Deck(random);
    this.state = {
      gameId: createId("game"), players: [], deck, discardPile: deck.discardPile,
      resolvingCards: deck.resolvingCards, currentPlayerIndex: -1, startingPlayerIndex: -1,
      currentRound: GAME_CONFIG.initialRound, phase: "idle", pendingAction: null,
      pendingResponses: [], activeEffects: [], selectedGeneralId: null, winnerTeam: null,
      isGameOver: false, isDisposed: false, logs: [], debugHistory: [], resolutionSerial: 0
    };
    this.logger = new GameLogger(this.state, ui);
    this.responseSystem = new ResponseSystem(this);
    this.aiController = new AIController(this);
    this.candidates = [];
    this.actionLocked = false;
    this.animationFastMode = GAME_CONFIG.animationFastMode;
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
    const teams = TeamManager.assignTeams(this.random);
    this.state.players = teams.map((battleTeam, seatIndex) => new Player({
      id: createId("player"), seatIndex, battleTeam, controllerType: seatIndex === 0 ? "human" : "ai"
    }));
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
    const selected = this.candidates.find((general) => general.id === generalId);
    if (!selected || this.state.selectedGeneralId) throw new Error("角色选择无效或已确认");
    const human = this.state.players[0];
    human.applyGeneral(selected);
    this.state.selectedGeneralId = selected.id;
    const aiPlayers = this.state.players.slice(1);
    const assigned = this.generalSelection.assignAiGenerals(aiPlayers, selected.id);
    aiPlayers.forEach((player, index) => player.applyGeneral(assigned[index]));

    this.registerGlobalRules();
    registerPassiveSkills(this);
    this.state.deck.build();
    this.syncDeckAliases();
    for (const player of this.state.players) {
      player.resetTurnFlags();
      player.resetRoundFlags();
      const bonus = TeamManager.teamSize(this.state.players, player.battleTeam) === GAME_CONFIG.smallTeamSize ? GAME_CONFIG.smallTeamBonusCards : 0;
      await this.drawCards(player, GAME_CONFIG.initialHandCount + bonus, "初始发牌");
    }
    this.state.startingPlayerIndex = Math.floor(this.random() * this.state.players.length);
    this.state.currentPlayerIndex = this.state.startingPlayerIndex;
    await this.eventBus.emit("generalSelected", { type: "generalSelected", player: human, general: selected });
    await this.eventBus.emit("gameStart", { type: "gameStart", game: this });

    const dawnCount = TeamManager.teamSize(this.state.players, "dawn");
    const duskCount = TeamManager.teamSize(this.state.players, "dusk");
    this.log(`本局晨星阵营有${dawnCount}名角色，暮影阵营有${duskCount}名角色。`, "important");
    this.log(`你选择了${human.name}，你的阵营是${TEAM_CONFIG[human.battleTeam].name}。`, "important");
    this.log(`电脑角色为${aiPlayers.map((player) => player.name).join("、")}。`);
    this.log(`${this.currentPlayer.name}获得首个行动回合。`, "important");
    this.ui.render(this);
    this.loopPromise = this.runGameLoop();
  }

  /** 注册装备与状态等不属于特定角色的事件规则。 */
  registerGlobalRules() {
    this.eventBus.on("beforeDamage", "global:exposed", (event) => {
      if (!event.target?.statuses.exposed || event.amount <= 0) return;
      event.amount += event.target.statuses.exposed.stacks ?? 1;
      delete event.target.statuses.exposed;
      this.log(`${event.target.name}的破绽被触发，伤害增加1点。`, "damage");
    });
    this.eventBus.on("cardUsed", "global:coreDevice", async (event) => {
      const owner = event.source;
      if (!owner.alive || !owner.equipment || owner.equipment.definitionId !== "coreDevice" || event.card.category !== "tactic" || owner.turnFlags.coreDeviceTriggered) return;
      owner.turnFlags.coreDeviceTriggered = true;
      this.log(`${owner.name}的核心装置启动，摸1张牌。`);
      await this.drawCards(owner, 1, "核心装置");
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
    this.state.phase = "turnStart";
    player.resetTurnFlags();
    if (player.statuses.temporaryShield) {
      player.shield = 0;
      delete player.statuses.temporaryShield;
      this.log(`${player.name}的临时护盾在回合开始时消散。`);
    }
    this.log(`${player.name}的回合开始。`, "important");
    await this.eventBus.emit("turnStart", { type: "turnStart", player });
    this.ui.render(this);

    this.state.phase = "status";
    const statusEvent = { type: "beforeStatusResolve", player, cancelled: false };
    await this.eventBus.emit("beforeStatusResolve", statusEvent);
    await this.eventBus.emit("afterStatusResolve", { ...statusEvent, type: "afterStatusResolve" });
    if (!this.isSessionValid(gameId) || !player.alive || this.state.isGameOver) return;

    this.state.phase = "draw";
    const drawEvent = { type: "beforeDraw", player, count: GAME_CONFIG.defaultDrawCount, cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeDraw", drawEvent);
    if (!drawEvent.cancelled) await this.drawCards(player, Math.max(0, drawEvent.count), "回合摸牌");
    await this.eventBus.emit("afterDraw", { ...drawEvent, type: "afterDraw" });
    if (!this.isSessionValid(gameId) || !player.alive || this.state.isGameOver) return;

    this.state.phase = "play";
    await this.eventBus.emit("playPhaseStart", { type: "playPhaseStart", player });
    this.ui.render(this);
    if (player.controllerType === "human") {
      this.ui.setPrompt("你的出牌阶段：选择手牌、发动技能，或结束出牌。", "从手牌中选择可用牌");
      await this.ui.waitForHumanPlayEnd(gameId);
    } else {
      await this.takeAiPlayPhase(player, gameId);
    }
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return;
    await this.eventBus.emit("playPhaseEnd", { type: "playPhaseEnd", player });

    this.state.phase = "discard";
    await this.handleDiscardPhase(player, gameId);
    if (!this.isSessionValid(gameId) || this.state.isGameOver) return;

    this.state.phase = "turnEnd";
    await this.eventBus.emit("turnEnd", { type: "turnEnd", player });
    this.log(`${player.name}的回合结束。`);
    this.ui.render(this);
  }

  /** AI 先公开思考，再取样可清理等待，随后公开行动意图并执行。 */
  async takeAiPlayPhase(player, gameId) {
    this.ui.setPrompt(`${player.name}进入出牌阶段，正在观察战场。`, "电脑正在行动");
    this.ui.setThinking(true, player, "正在观察战场与可用资源");
    if (!(await this.cleanupManager.delay(getAiDelay(this, "initial")))) {
      this.ui.setThinking(false);
      return;
    }
    for (let count = 0; count < GAME_CONFIG.aiMaxActionsPerTurn; count += 1) {
      if (!this.isSessionValid(gameId) || this.state.isGameOver || !player.alive) break;
      const action = this.aiController.selectAction(player);
      if (action.type === "end") {
        this.ui.setPrompt(`${player.name}准备结束出牌阶段。`);
        this.ui.setThinking(true, player, "正在收束回合");
        await this.cleanupManager.delay(getAiDelay(this, "end"));
        break;
      }
      const actionName = action.type === "card" ? `准备使用「${action.card.name}」` : `准备发动「${action.skill.name}」`;
      this.ui.setPrompt(`${player.name}${actionName}。`);
      this.ui.setThinking(true, player, actionName);
      if (!(await this.cleanupManager.delay(getAiDelay(this, "action")))) break;
      this.ui.setThinking(false);
      if (action.type === "card") await this.playCard(player, action.card, action.targets);
      else if (action.type === "skill") await this.useActiveSkill(player, action.skill.id, action.targets);
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
    for (const card of cards.slice(0, required)) await this.discardCardFromHand(player, card, "弃牌阶段");
  }

  /** 移动到下一名存活角色，并在经过首发座位时开始新轮。 */
  async advanceTurn() {
    let wrapped = false;
    let next = this.state.currentPlayerIndex;
    for (let step = 0; step < this.state.players.length; step += 1) {
      next = (next + 1) % this.state.players.length;
      if (next === this.state.startingPlayerIndex) wrapped = true;
      if (this.state.players[next].alive) break;
    }
    if (wrapped) {
      await this.eventBus.emit("roundEnd", { type: "roundEnd", round: this.state.currentRound });
      this.state.currentRound += 1;
      for (const player of this.state.players) player.resetRoundFlags();
      this.log(`第${this.state.currentRound}轮开始。`, "important");
      await this.eventBus.emit("roundStart", { type: "roundStart", round: this.state.currentRound });
    }
    this.state.currentPlayerIndex = next;
  }

  /**
   * 使用一张主动牌。卡牌从手牌先进入结算区，完成或取消后才进入弃牌堆/装备区。
   * @returns {Promise<boolean>} 是否实际开始结算。
   */
  async playCard(source, card, requestedTargets = []) {
    const legality = RuleEngine.canPlayCard(this, source, card);
    if (!legality.ok || this.actionLocked) return false;
    let targets = requestedTargets;
    const legalTargets = RuleEngine.getCardTargets(this, source, card);
    if (card.targetType === "self") targets = [source];
    if (card.targetType === "allEnemies") targets = legalTargets;
    if (!["none", "self", "allEnemies"].includes(card.targetType) && (!targets[0] || !legalTargets.includes(targets[0]))) return false;

    this.actionLocked = true;
    const resolutionId = `${this.state.gameId}:resolution:${++this.state.resolutionSerial}`;
    try {
      await this.moveHandToResolving(source, card);
      this.ui.setCurrentCard(card, source.name);
      this.log(`${source.name}使用了「${card.name}」${targets[0] && card.targetType !== "self" ? `，目标是${targets[0].name}` : ""}。`);
      const useEvent = await this.eventBus.emit("beforeCardUse", { type: "beforeCardUse", source, card, targets, cancelled: false, metadata: {}, resolutionId });
      let cancelledBeforeResolve = useEvent.cancelled;
      if (!cancelledBeforeResolve && targets.length) {
        const targetEvent = { type: "targetSelected", source, card, targets, cancelled: false, metadata: {}, resolutionId };
        await this.eventBus.emit("targetSelected", targetEvent);
        targets = targetEvent.targets;
      }
      if (!cancelledBeforeResolve && targets.length === 1 && card.canBeRedirected) targets = [await this.responseSystem.askForRedirect(source, targets[0], card)];
      const resolveEvent = { type: "beforeCardResolve", source, card, targets, cancelled: false, metadata: {}, resolutionId };
      if (!cancelledBeforeResolve) await this.eventBus.emit("beforeCardResolve", resolveEvent);
      targets = resolveEvent.targets;
      cancelledBeforeResolve ||= resolveEvent.cancelled;
      const countered = !cancelledBeforeResolve && await this.responseSystem.askForCounter(source, card, targets);
      let destination = "discard";
      if (countered || cancelledBeforeResolve) {
        this.log(`「${card.name}」的效果被取消。`, "important");
      } else {
        destination = (await resolveCardEffect(this, source, card, targets, { resolutionId })).destination;
      }
      if (destination === "discard") await this.finishResolvingToDiscard(card);
      source.statistics.cardsPlayed += 1;
      await this.eventBus.emit("cardUsed", { type: "cardUsed", source, card, targets, cancelled: countered || cancelledBeforeResolve, resolutionId });
      this.ui.render(this);
      return true;
    } finally {
      this.actionLocked = false;
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
    const skill = getActiveSkill(source);
    if (!skill || skill.id !== skillId || this.actionLocked) return false;
    const legality = skill.canUse(this, source);
    if (!legality.ok) return false;
    const legalTargets = RuleEngine.getSkillTargets(this, source, skill.id);
    if (!["none", "allEnemies"].includes(skill.targetType) && (!targets[0] || !legalTargets.includes(targets[0]))) return false;
    this.actionLocked = true;
    source.turnFlags.activeSkillsUsed.add(skill.id);
    try {
      this.ui.setCurrentCard(skill.name, `${source.name} · 技能`);
      await skill.execute(this, source, targets);
      this.ui.render(this);
      return true;
    } finally {
      this.actionLocked = false;
      if (!this.state.isGameOver && source.controllerType === "human" && this.state.phase === "play") {
        this.ui.setPrompt("技能结算完成，继续出牌或结束阶段。", "选择一张可用手牌");
      }
      this.ui.render(this);
    }
  }

  /** 真人点击手牌的入口；若需要目标则等待统一目标选择。 */
  async handleHumanCard(cardId) {
    const human = this.state.players[0];
    const card = human.hand.find((entry) => entry.id === cardId);
    if (!card || this.currentPlayer?.id !== human.id || this.state.phase !== "play") return false;
    const legality = RuleEngine.canPlayCard(this, human, card);
    if (!legality.ok) { this.ui.setPrompt(legality.reason); return false; }
    const legalTargets = RuleEngine.getCardTargets(this, human, card);
    let targets = [];
    if (!["none", "self", "allEnemies"].includes(card.targetType)) {
      const target = await this.ui.requestTarget(legalTargets, `为「${card.name}」选择目标`);
      if (!target) return false;
      targets = [target];
    }
    return this.playCard(human, card, targets);
  }

  /** 真人点击主动技能的入口；统一请求合法目标。 */
  async handleHumanSkill() {
    const human = this.state.players[0];
    const skill = getActiveSkill(human);
    if (!skill || !skill.canUse(this, human).ok) return false;
    const legalTargets = RuleEngine.getSkillTargets(this, human, skill.id);
    let targets = [];
    if (!["none", "allEnemies"].includes(skill.targetType)) {
      const target = await this.ui.requestTarget(legalTargets, `为「${skill.name}」选择目标`);
      if (!target) return false;
      targets = [target];
    }
    return this.useActiveSkill(human, skill.id, targets);
  }

  /** 真人结束出牌阶段；仅在自己的出牌阶段有效。 */
  requestEndHumanPlay() {
    const human = this.state.players[0];
    if (this.currentPlayer?.id !== human.id || this.state.phase !== "play" || this.actionLocked) return false;
    this.ui.resolveHumanPlayEnd(this.state.gameId);
    return true;
  }

  /**
   * 对目标造成伤害。beforeDamage 可修改数值，之后依次经过格挡、护盾、生命、afterDamage 和阵亡。
   * @returns {Promise<number>} 实际扣除的生命值。
   */
  async damage(source, target, amount, context = {}) {
    if (!target?.alive || this.state.isGameOver) return 0;
    const metadata = {};
    const event = {
      type: "beforeDamage", source, target, amount: Math.max(0, amount), card: context.card ?? null,
      skill: context.skill ?? null, damageType: context.damageType ?? "normal", canBlock: context.canBlock ?? false,
      cancelled: false, metadata, resolutionId: context.resolutionId ?? createId("skill-resolution")
    };
    await this.eventBus.emit("beforeDamage", event);
    if (event.cancelled || event.amount <= 0 || !target.alive) return 0;
    const blocked = await this.responseSystem.askForBlock(source, target, event);
    event.amount = Math.max(0, event.amount - blocked);
    if (blocked) this.log(`${target.name}格挡了1点伤害。`, "important");
    const shieldAbsorbed = Math.min(target.shield, event.amount);
    target.shield -= shieldAbsorbed;
    const hpDamage = Math.min(target.hp, Math.max(0, event.amount - shieldAbsorbed));
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
    if (target.hp <= 0 && target.alive) await this.killPlayer(target, source);
    this.ui.render(this);
    return hpDamage;
  }

  /** 统一治疗入口，允许 beforeHeal 修改数值并限制到最大生命。 */
  async heal(source, target, amount, context = {}) {
    if (!target?.alive || target.hp >= target.maxHp || this.state.isGameOver) return 0;
    const event = { type: "beforeHeal", source, target, amount: Math.max(0, amount), card: context.card ?? null, skill: context.skill ?? null, cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeHeal", event);
    if (event.cancelled) return 0;
    const actualAmount = Math.min(event.amount, target.maxHp - target.hp);
    target.hp += actualAmount;
    if (source) source.statistics.healingDone += actualAmount;
    if (actualAmount) { this.log(`${target.name}恢复${actualAmount}点生命。`, "heal"); this.ui.queueFeedback?.("heal", target.id, actualAmount); }
    await this.eventBus.emit("afterHeal", { ...event, type: "afterHeal", actualAmount });
    this.ui.render(this);
    return actualAmount;
  }

  /** 统一能量获取入口，经过事件修正并限制在 maxEnergy。 */
  async gainEnergy(player, amount, context = {}) {
    const event = { type: "beforeGainEnergy", player, amount, reason: context.reason ?? "效果", card: context.card ?? null, skill: context.skill ?? null, cancelled: false, metadata: {} };
    await this.eventBus.emit("beforeGainEnergy", event);
    if (event.cancelled) return 0;
    const actualAmount = player.changeEnergy(event.amount);
    if (actualAmount > 0) { this.log(`${player.name}通过${event.reason}获得${actualAmount}点能量。`); this.ui.queueFeedback?.("energy", player.id, actualAmount); }
    await this.eventBus.emit("afterGainEnergy", { ...event, type: "afterGainEnergy", actualAmount });
    this.ui.render(this);
    return actualAmount;
  }

  /** 将生命为零的角色标记阵亡并立即检查胜负。 */
  async killPlayer(target, source) {
    const event = { type: "beforePlayerDying", target, source, cancelled: false };
    await this.eventBus.emit("beforePlayerDying", event);
    if (event.cancelled || target.hp > 0) return false;
    target.alive = false;
    target.hp = 0;
    this.log(`${TEAM_CONFIG[target.battleTeam].name}的${target.name}阵亡。`, "important");
    await this.eventBus.emit("playerDead", { type: "playerDead", target, source });
    await this.checkVictory();
    return true;
  }

  /** 若一个阵营无存活者，结束游戏、停止旧交互并显示结果。 */
  async checkVictory() {
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
    this.ui.render(this);
    this.ui.showGameOver(winnerTeam, this.state.players[0].battleTeam === winnerTeam);
    return winnerTeam;
  }

  /** 抽指定数量的牌并逐张触发移动事件；电脑日志只公开数量。 */
  async drawCards(player, count, reason = "摸牌") {
    let drawn = 0;
    for (let index = 0; index < count; index += 1) {
      const card = this.state.deck.drawOne();
      this.syncDeckAliases();
      if (!card) break;
      const move = { type: "beforeCardMove", card, from: "deck", to: "hand", player, reason, cancelled: false };
      await this.eventBus.emit("beforeCardMove", move);
      if (move.cancelled) { this.state.deck.cards.push(card); continue; }
      player.hand.push(card);
      drawn += 1;
      await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    }
    if (drawn) { this.log(`${player.name}摸了${drawn}张牌。`); this.ui.queueFeedback?.("draw", player.id, drawn); }
    this.ui.render(this);
    return drawn;
  }

  /** 从玩家手牌公开弃置一张牌；返回是否成功移动。 */
  async discardCardFromHand(player, card, reason = "弃置") {
    const index = player.hand.indexOf(card);
    if (index < 0) return false;
    const move = { type: "beforeCardMove", card, from: "hand", to: "discard", player, reason, cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (move.cancelled) return false;
    player.hand.splice(index, 1);
    this.state.deck.discard(card);
    this.syncDeckAliases();
    this.log(`${player.name}因${reason}弃置了「${card.name}」。`);
    this.ui.queueFeedback?.("discard", player.id);
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    this.ui.render(this);
    return true;
  }

  /** 在两名玩家间移动实体手牌；只公开最终牌名，不暴露其余隐藏牌。 */
  async moveCardBetweenHands(from, to, card, reason) {
    const index = from.hand.indexOf(card);
    if (index < 0) return false;
    const move = { type: "beforeCardMove", card, from: "hand", to: "hand", fromPlayer: from, player: to, reason, cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (move.cancelled) return false;
    from.hand.splice(index, 1);
    to.hand.push(card);
    this.ui.queueFeedback?.("draw", to.id, 1);
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
    this.ui.render(this);
    return true;
  }

  /** 将主动牌由手牌移入结算区；防止快速点击重复使用同一实体牌。 */
  async moveHandToResolving(player, card) {
    const index = player.hand.indexOf(card);
    if (index < 0) throw new Error("卡牌已不在手中");
    const move = { type: "beforeCardMove", card, from: "hand", to: "resolving", player, reason: "使用", cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (move.cancelled) throw new Error("卡牌移动被取消");
    player.hand.splice(index, 1);
    if (!this.state.deck.beginResolve(card)) throw new Error("卡牌重复进入结算区");
    this.syncDeckAliases();
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
  }

  /** 令结算完成的牌进入弃牌堆。 */
  async finishResolvingToDiscard(card) {
    const move = { type: "beforeCardMove", card, from: "resolving", to: "discard", reason: "结算完成", cancelled: false };
    await this.eventBus.emit("beforeCardMove", move);
    if (!move.cancelled) this.state.deck.finishResolveToDiscard(card);
    this.syncDeckAliases();
    await this.eventBus.emit("afterCardMove", { ...move, type: "afterCardMove" });
  }

  /** 将核心装置放入唯一装备槽，并公开弃置被替换装备。 */
  async equipCard(player, card) {
    const equipMove = { type: "beforeCardMove", card, from: "resolving", to: "equipment", player, reason: "装备", cancelled: false };
    await this.eventBus.emit("beforeCardMove", equipMove);
    if (equipMove.cancelled) return false;
    if (player.equipment) {
      const old = player.equipment;
      player.equipment = null;
      const replaceMove = { type: "beforeCardMove", card: old, from: "equipment", to: "discard", player, reason: "替换装备", cancelled: false };
      await this.eventBus.emit("beforeCardMove", replaceMove);
      this.state.deck.discard(old);
      await this.eventBus.emit("afterCardMove", { ...replaceMove, type: "afterCardMove" });
      this.log(`${player.name}替换并弃置了旧核心装置。`);
    }
    this.state.deck.finishResolveToEquipment(card);
    player.equipment = card;
    this.syncDeckAliases();
    this.log(`${player.name}装备了核心装置。`, "important");
    this.ui.queueFeedback?.("equip", player.id);
    await this.eventBus.emit("afterCardMove", { ...equipMove, type: "afterCardMove" });
    return true;
  }

  /** 返回某角色的存活敌人。 */
  getEnemies(player) { return this.state.players.filter((other) => other.alive && other.battleTeam !== player.battleTeam); }
  /** 返回某角色含自身在内的存活同阵营角色。 */
  getAllies(player) { return this.state.players.filter((other) => other.alive && other.battleTeam === player.battleTeam); }

  /** 统一添加公开日志。 */
  log(message, kind = "normal") { return this.logger.add(message, kind); }

  /** 同步状态中的便捷别名，避免牌堆重洗替换数组后旧引用失效。 */
  syncDeckAliases() {
    this.state.discardPile = this.state.deck.discardPile;
    this.state.resolvingCards = this.state.deck.resolvingCards;
  }

  /** 校验异步回调仍属于本局且游戏未销毁。 */
  isSessionValid(gameId) {
    return !this.state.isDisposed && this.state.gameId === gameId;
  }

  /**
   * 终止本局并清理延迟、响应、事件与 UI Promise。旧异步逻辑会收到 false/null 后自然退出。
   */
  dispose() {
    if (this.state.isDisposed) return;
    this.state.isDisposed = true;
    this.cleanupManager.cleanup();
    this.responseSystem.cleanup();
    this.eventBus.clear();
    this.ui.cancelPendingInteractions();
    Debug.log("Game", `清理对局 ${this.state.gameId}`);
  }
}

// 对外导出用于 UI 说明与测试，业务代码仍通过 RuleEngine 检查合法性。
export { CARD_DEFINITIONS, RuleEngine };
