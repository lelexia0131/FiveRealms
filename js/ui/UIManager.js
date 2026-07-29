/**
 * DOM 渲染与真人意图入口。这里只提交卡牌 ID、目标和按钮意图，不修改生命、能量、手牌或胜负。
 */
import { TEAM_CONFIG, PHASE_NAMES } from "../config/gameConfig.js";
import { RuleEngine } from "../core/RuleEngine.js";
import { getActiveSkill } from "../generals/skillRegistry.js";
import {
  candidateCardTemplate, escapeHtml, formatLogMessage, handCardTemplate,
  playerPanelTemplate, resolvingCardTemplate, thinkingTemplate
} from "./templates.js";
import { AnimationController } from "./animationController.js";
import { InteractionController } from "./InteractionController.js";
import { PublicPoolView } from "./PublicPoolView.js";
import { PrivateRevealView } from "./PrivateRevealView.js";
import { JudgmentView } from "./JudgmentView.js";
import { DistanceSystem } from "../core/DistanceSystem.js";

export class UIManager {
  constructor() {
    this.elements = Object.fromEntries([
      "start-screen", "selection-screen", "game-screen", "start-button", "candidate-grid", "team-preview",
      "status-metrics", "restart-button", "cpu-grid", "human-panel", "human-hand", "hand-hint",
      "thinking-indicator", "current-card", "action-prompt", "private-reveal", "response-panel",
      "public-pool-view", "judgment-view", "dying-view", "duel-view",
      "skill-button", "end-play-button", "discard-confirm-button", "cancel-interaction-button",
      "log-panel", "battle-layout", "log-toggle-button", "fast-mode-button",
      "log-list", "log-count", "game-over-overlay", "game-over-title", "game-over-copy", "play-again-button"
    ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
    this.callbacks = {};
    this.game = null;
    this.targetState = null;
    this.discardState = null;
    this.responseState = null;
    this.playEndState = null;
    this.privateRevealToken = 0;
    this.thinkingPlayerId = null;
    this.thinkingMessage = "正在思考";
    this.fastMode = false;
    this.logCollapsed = false;
    this.animationController = new AnimationController();
    this.interactionController = new InteractionController(this);
    this.publicPoolView = new PublicPoolView(this.elements.public_pool_view);
    this.privateRevealView = new PrivateRevealView(this.elements.private_reveal);
    this.judgmentView = new JudgmentView(this.elements.judgment_view);
    this.bindEvents();
  }

  setCallbacks(callbacks) { this.callbacks = callbacks; }

  bindEvents() {
    this.elements.start_button.addEventListener("click", () => this.callbacks.onStart?.());
    this.elements.restart_button.addEventListener("click", () => this.callbacks.onRestart?.());
    this.elements.play_again_button.addEventListener("click", () => this.callbacks.onRestart?.());
    this.elements.candidate_grid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-general-id]");
      if (button) this.callbacks.onSelectGeneral?.(button.dataset.generalId);
    });
    this.elements.human_hand.addEventListener("click", (event) => this.handleHandClick(event));
    for (const zone of [this.elements.cpu_grid, this.elements.human_panel]) {
      zone.addEventListener("click", (event) => this.handlePlayerClick(event));
      zone.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); this.handlePlayerClick(event); }
      });
    }
    this.elements.skill_button.addEventListener("click", () => this.callbacks.onSkill?.());
    this.elements.end_play_button.addEventListener("click", () => this.callbacks.onEndPlay?.());
    this.elements.discard_confirm_button.addEventListener("click", () => this.confirmDiscard());
    this.elements.cancel_interaction_button.addEventListener("click", () => this.cancelTarget());
    this.elements.response_panel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-response-choice]");
      if (button) this.resolveResponse(button.dataset.responseChoice === "use");
    });
    this.interactionController.bind(this.elements.response_panel);
    this.elements.log_toggle_button.addEventListener("click", () => this.setLogCollapsed(!this.logCollapsed));
    this.elements.fast_mode_button.addEventListener("click", () => this.callbacks.onToggleFastMode?.(!this.fastMode));
  }

  showStart() {
    this.elements.start_screen.classList.remove("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
  }

  showSelection(candidates, battleTeam) {
    this.cancelPendingInteractions();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.remove("is-hidden");
    this.elements.game_over_overlay.classList.add("is-hidden");
    this.elements.team_preview.innerHTML = `<span>你的本局阵营</span><strong class="team-${battleTeam}">${TEAM_CONFIG[battleTeam].name}</strong>`;
    this.elements.candidate_grid.innerHTML = candidates.map(candidateCardTemplate).join("");
  }

  showGame(game) {
    this.game = game;
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.remove("is-hidden");
    this.elements.log_list.innerHTML = "";
    this.elements.log_count.textContent = "0";
    this.setLogCollapsed(window.innerWidth < 1280);
    if (game.state.players.every((player) => player.general)) this.render(game);
  }

  candidateTemplate(general, index) { return candidateCardTemplate(general, index); }

  render(game) {
    this.game = game;
    if (!game?.state.players.length || game.state.isDisposed || !game.state.players[0].general) return;
    const state = game.state;
    const human = state.players[0];
    const dawnAlive = state.players.filter((player) => player.alive && player.battleTeam === "dawn").length;
    const duskAlive = state.players.filter((player) => player.alive && player.battleTeam === "dusk").length;
    const metrics = [
      ["轮次", `第 ${state.currentRound} 轮`, "round"], ["当前角色", game.currentPlayer?.name ?? "—", "active"],
      ["阶段", PHASE_NAMES[state.phase] ?? state.phase, "phase"], ["阵营", `晨 ${dawnAlive} · 暮 ${duskAlive}`, "teams"],
      ["牌堆", state.deck.cards.length, "deck"], ["弃牌", state.deck.discardPile.length, "discard"]
    ];
    this.elements.status_metrics.innerHTML = metrics.map(([label, value, key]) => `<span class="metric metric-${key}" data-pile="${key}"><small>${label}</small><strong>${escapeHtml(value)}</strong></span>`).join("");
    const targetOptions = { humanTeam: human.battleTeam, isTargeting: Boolean(this.targetState) };
    this.elements.cpu_grid.innerHTML = state.players.slice(1).map((player) => playerPanelTemplate(player, {
      ...targetOptions, isCurrent: game.currentPlayer?.id === player.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(player.id)), isThinking: this.thinkingPlayerId === player.id,
      distanceInfo: DistanceSystem.describe(game, human, player),
      distanceState: this.getDistanceState(human, player)
    })).join("");
    this.elements.human_panel.innerHTML = playerPanelTemplate(human, {
      ...targetOptions, isHuman: true, isCurrent: game.currentPlayer?.id === human.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(human.id)), isThinking: this.thinkingPlayerId === human.id
    });
    this.renderHand(game, human);
    this.renderControls(game, human);
    this.animationController.flush(document);
  }

  playerTemplate(player, human, isHuman) {
    return playerPanelTemplate(player, {
      humanTeam: human.battleTeam, isHuman, isCurrent: this.game?.currentPlayer?.id === player.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(player.id)), isTargeting: Boolean(this.targetState),
      isThinking: this.thinkingPlayerId === player.id
    });
  }

  isInteractionActive() {
    return Boolean(this.targetState || this.discardState || this.responseState || this.interactionController?.pending || this.game?.interactionLocked);
  }

  getDistanceState(source, target) {
    if (!target.alive) return "已阵亡";
    const distance = DistanceSystem.getDistance(this.game, source, target);
    if (target.battleTeam === source.battleTeam) return `距离 ${distance} · 同阵营`;
    const card = this.targetState?.meta?.card;
    if (card?.definitionId === "assault") return distance <= source.attackRange ? `距离 ${distance} · 可突袭` : `距离 ${distance} · 超出攻击范围`;
    return `距离 ${distance}`;
  }

  renderHand(game, human) {
    const inDiscard = Boolean(this.discardState);
    const blockedByInteraction = this.isInteractionActive();
    this.elements.human_hand.innerHTML = human.hand.map((card) => {
      const playable = RuleEngine.canPlayCard(game, human, card).ok;
      const selected = this.discardState?.selectedIds.has(card.id);
      const disabled = !inDiscard && (!playable || blockedByInteraction || game.actionLocked);
      return handCardTemplate(card, { selected, disabled });
    }).join("") || '<div class="empty-hand"><span aria-hidden="true">◇</span><strong>手牌为空</strong><small>下一次摸牌会从牌堆飞入这里</small></div>';
    if (this.discardState) this.elements.hand_hint.textContent = `已选 ${this.discardState.selectedIds.size} / ${this.discardState.count}`;
    else if (!this.targetState) this.elements.hand_hint.textContent = `${human.hand.length} 张 · 不可用的牌仍可聚焦查看`;
  }

  renderControls(game, human) {
    const humanPlay = game.currentPlayer?.id === human.id && game.state.phase === "play" && human.alive && !game.state.isGameOver;
    const interaction = this.isInteractionActive();
    const skill = getActiveSkill(human);
    const skillLegal = skill?.canUse(game, human).ok ?? false;
    this.elements.skill_button.textContent = skill ? `${skill.name} · ${skill.id === "allIn" ? "全部" : skill.cost} 能量` : "主动技能";
    this.elements.skill_button.disabled = !humanPlay || !skillLegal || interaction || game.actionLocked;
    this.elements.end_play_button.disabled = !humanPlay || interaction || game.actionLocked;
    this.elements.discard_confirm_button.classList.toggle("is-hidden", !this.discardState);
    this.elements.cancel_interaction_button.classList.toggle("is-hidden", !this.targetState);
    if (this.discardState) {
      this.elements.discard_confirm_button.disabled = this.discardState.selectedIds.size !== this.discardState.count;
      this.elements.discard_confirm_button.textContent = `确认弃牌 ${this.discardState.selectedIds.size}/${this.discardState.count}`;
    }
  }

  handleHandClick(event) {
    const button = event.target.closest("[data-card-id]");
    if (!button || (button.dataset.disabled === "true" && !this.discardState)) return;
    const cardId = button.dataset.cardId;
    if (this.discardState) {
      if (this.discardState.selectedIds.has(cardId)) this.discardState.selectedIds.delete(cardId);
      else if (this.discardState.selectedIds.size < this.discardState.count) this.discardState.selectedIds.add(cardId);
      this.render(this.game);
      return;
    }
    this.callbacks.onCard?.(cardId);
  }

  handlePlayerClick(event) {
    const panel = event.target.closest("[data-player-id]");
    if (!panel || !this.targetState?.legalIds.has(panel.dataset.playerId)) return;
    const target = this.targetState.players.find((player) => player.id === panel.dataset.playerId) ?? null;
    const resolve = this.targetState.resolve;
    this.targetState = null;
    resolve(target);
    this.render(this.game);
  }

  requestTarget(players, prompt, meta = {}) {
    if (!players.length) return Promise.resolve(null);
    this.cancelTarget();
    return new Promise((resolve) => {
      this.targetState = { players, legalIds: new Set(players.map((player) => player.id)), resolve, meta };
      this.setPrompt(prompt, "可选目标带有金色指示环");
      this.render(this.game);
    });
  }

  cancelTarget() {
    if (!this.targetState) return;
    const resolve = this.targetState.resolve;
    this.targetState = null;
    resolve(null);
    if (this.game) this.render(this.game);
  }

  requestDiscard(player, count, prompt) {
    return new Promise((resolve) => {
      this.discardState = { player, count, selectedIds: new Set(), resolve };
      this.setPrompt(prompt, `还需选择 ${count} 张`);
      this.render(this.game);
    });
  }

  confirmDiscard() {
    if (!this.discardState || this.discardState.selectedIds.size !== this.discardState.count) return;
    const state = this.discardState;
    const cards = state.player.hand.filter((card) => state.selectedIds.has(card.id));
    this.discardState = null;
    state.resolve(cards);
    this.render(this.game);
  }

  requestResponse(request, label) {
    if (this.responseState) this.resolveResponse(false);
    return new Promise((resolve) => {
      const deadline = Date.now() + request.timeoutMs;
      const settle = (choice) => {
        if (!this.responseState || this.responseState.request.id !== request.id) return;
        window.clearInterval(this.responseState.interval);
        this.responseState = null;
        this.elements.response_panel.classList.add("is-hidden");
        this.elements.response_panel.innerHTML = "";
        resolve(choice);
        if (this.game) this.render(this.game);
      };
      const update = () => {
        const node = this.elements.response_panel.querySelector(".countdown");
        if (node) node.textContent = `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s`;
      };
      const interval = window.setInterval(update, 200);
      this.responseState = { request, resolve: settle, interval };
      this.elements.response_panel.innerHTML = `<div class="response-title"><strong>响应窗口</strong><span class="countdown">${Math.ceil(request.timeoutMs / 1000)}s</span></div><p>现在可以改变即将发生的结算。</p><div class="response-actions"><button class="primary-button" data-response-choice="use">${escapeHtml(label)}</button><button class="ghost-button" data-response-choice="decline">放弃响应</button></div>`;
      this.elements.response_panel.classList.remove("is-hidden");
      this.game.cleanupManager.delay(request.timeoutMs).then((completed) => { if (completed) settle(false); });
      update();
      this.render(this.game);
    });
  }

  resolveResponse(choice) { this.responseState?.resolve(choice); }
  waitForHumanPlayEnd(gameId) { return new Promise((resolve) => { this.playEndState = { gameId, resolve }; this.render(this.game); }); }

  resolveHumanPlayEnd(gameId) {
    if (!this.playEndState || this.playEndState.gameId !== gameId) return;
    const resolve = this.playEndState.resolve;
    this.playEndState = null;
    resolve(true);
    this.render(this.game);
  }

  setPrompt(message, handHint = "") {
    this.elements.action_prompt.textContent = message;
    if (handHint) this.elements.hand_hint.textContent = handHint;
  }

  setThinking(isThinking, playerOrName = "电脑角色", message = "正在思考") {
    const player = typeof playerOrName === "object" ? playerOrName : this.game?.state.players.find((entry) => entry.name === playerOrName);
    this.thinkingPlayerId = isThinking ? player?.id ?? null : null;
    this.thinkingMessage = message;
    this.elements.thinking_indicator.classList.toggle("is-hidden", !isThinking);
    if (isThinking) this.elements.thinking_indicator.innerHTML = thinkingTemplate(player, message);
    if (this.game?.state.players[0]?.general) this.render(this.game);
  }

  setCurrentCard(cardOrName, source) {
    this.elements.current_card.innerHTML = resolvingCardTemplate(cardOrName, source);
    this.elements.current_card.classList.remove("is-entering");
    void this.elements.current_card.offsetWidth;
    this.elements.current_card.classList.add("is-entering");
  }

  showPrivateReveal(title, cards = []) {
    const shown = this.privateRevealView.show(title, cards);
    if (!cards.length) this.game?.cleanupManager.delay(3200).then((completed) => {
      if (completed && !this.privateRevealView.pending) this.privateRevealView.hide();
    });
    return shown;
  }
  showPublicPool(cards) { this.publicPoolView.show(cards); }
  requestPublicCard(player, cards) { return this.publicPoolView.request(player, cards); }
  hidePublicPool() { this.publicPoolView.hide(); }
  showJudgment(player, card) { this.judgmentView.show(player, card); }
  showDying(target, context) {
    this.elements.dying_view.innerHTML = `<strong>${escapeHtml(target.name)}濒死</strong><span>当前生命 ${context.currentHp}</span><b>还需 ${context.need} 张调息</b>`;
    this.elements.dying_view.classList.remove("is-hidden");
  }
  hideDying() { this.elements.dying_view.classList.add("is-hidden"); this.elements.dying_view.innerHTML = ""; }
  showDuel(current, opponent) { this.elements.duel_view.innerHTML = `<strong>决斗</strong><span>${escapeHtml(current.name)}需打出突袭</span><small>对手：${escapeHtml(opponent.name)}</small>`; this.elements.duel_view.classList.remove("is-hidden"); }
  hideDuel() { this.elements.duel_view.classList.add("is-hidden"); this.elements.duel_view.innerHTML = ""; }

  appendLog(entry, count) {
    const node = document.createElement("div");
    node.className = `log-entry ${entry.kind === "normal" ? "" : `is-${entry.kind}`}`;
    node.innerHTML = formatLogMessage(entry.message);
    this.elements.log_list.append(node);
    this.elements.log_count.textContent = String(count);
    this.elements.log_list.scrollTop = this.elements.log_list.scrollHeight;
  }

  queueFeedback(type, playerId = null, amount = null) { this.animationController.queue(type, playerId, amount); }

  setFastMode(enabled) {
    this.fastMode = Boolean(enabled);
    document.body.classList.toggle("fast-mode", this.fastMode);
    this.elements.fast_mode_button.setAttribute("aria-pressed", String(this.fastMode));
    this.elements.fast_mode_button.querySelector("span").textContent = this.fastMode ? "快速动画：开" : "快速动画：关";
  }

  setLogCollapsed(collapsed) {
    this.logCollapsed = Boolean(collapsed);
    this.elements.log_panel.classList.toggle("is-collapsed", this.logCollapsed);
    this.elements.battle_layout.classList.toggle("log-collapsed", this.logCollapsed);
    this.elements.log_toggle_button.setAttribute("aria-expanded", String(!this.logCollapsed));
    this.elements.log_toggle_button.setAttribute("aria-label", this.logCollapsed ? "展开对局记录" : "折叠对局记录");
  }

  showGameOver(winnerTeam, humanWon) {
    this.elements.game_over_title.textContent = humanWon ? "你的阵营获胜" : "你的阵营落败";
    this.elements.game_over_copy.textContent = `${TEAM_CONFIG[winnerTeam].name}存活到了最后。${humanWon ? "这场联结与应变赢得了终局。" : "重新征召旅者，下一局仍会有全新的阵营与牌序。"}`;
    this.elements.game_over_overlay.classList.remove("is-hidden");
  }

  cancelPendingInteractions() {
    if (this.targetState) { const resolve = this.targetState.resolve; this.targetState = null; resolve(null); }
    if (this.discardState) { const resolve = this.discardState.resolve; this.discardState = null; resolve([]); }
    if (this.responseState) this.responseState.resolve(false);
    if (this.playEndState) { const resolve = this.playEndState.resolve; this.playEndState = null; resolve(false); }
    this.privateRevealToken += 1;
    this.thinkingPlayerId = null;
    this.animationController.clear();
    this.interactionController.cancel();
    this.publicPoolView.cancel();
    this.privateRevealView.hide();
    this.judgmentView.hide();
    this.hideDying();
    this.hideDuel();
    this.elements.private_reveal.classList.add("is-hidden");
    this.elements.response_panel.classList.add("is-hidden");
    this.elements.thinking_indicator.classList.add("is-hidden");
  }
}
