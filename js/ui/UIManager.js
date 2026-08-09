/**
 * DOM 渲染与真人意图入口。这里只提交卡牌 ID、目标和按钮意图，不修改生命、能量、手牌或胜负。
 */
import { TEAM_CONFIG, PHASE_NAMES } from "../config/gameConfig.js?build=20260809-healer-tuner-balance-v136";
import { RuleEngine } from "../core/RuleEngine.js?build=20260809-healer-tuner-balance-v136";
import { getActiveSkill } from "../generals/skillRegistry.js?build=20260809-healer-tuner-balance-v136";
import {
  candidateCardTemplate, emptyResolvingCardTemplate, escapeHtml, formatLogEntry, handCardTemplate,
  playerPanelTemplate, resolvingCardTemplate, skillDetailsTemplate, thinkingTemplate
} from "./templates.js?build=20260809-healer-tuner-balance-v136";
import { AnimationController } from "./animationController.js?build=20260809-healer-tuner-balance-v136";
import { InteractionController } from "./InteractionController.js?build=20260809-healer-tuner-balance-v136";
import { PublicPoolView } from "./PublicPoolView.js?build=20260809-healer-tuner-balance-v136";
import { PrivateRevealView } from "./PrivateRevealView.js?build=20260809-healer-tuner-balance-v136";
import { JudgmentView } from "./JudgmentView.js?build=20260809-healer-tuner-balance-v136";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260809-healer-tuner-balance-v136";
import { createOpponentHandView } from "./handVisibility.js?build=20260809-healer-tuner-balance-v136";
import { toggleCardSelection } from "./selectionUtils.js?build=20260809-healer-tuner-balance-v136";
import { SoundManager } from "../audio/SoundManager.js?build=20260809-healer-tuner-balance-v136";

export function canSubmitResponse(request) {
  const requiredCount = Math.max(0, Number(request?.requiredCount) || 0);
  return requiredCount === 0 || (request?.legalCardIds?.length ?? 0) >= requiredCount;
}

export const skillButtonLabel = (skill) => skill?.name ?? "主动技能";

/** 渲染响应事件；优先使用结构化片段，缺失或异常时回退整段转义文本。 */
function renderResponseEvent(presentation, eventText) {
  const fragments = presentation?.eventFragments;
  if (!Array.isArray(fragments) || !fragments.length) return escapeHtml(eventText);
  let markup = "";
  for (const fragment of fragments) {
    if (!fragment || typeof fragment.text !== "string") return escapeHtml(eventText);
    if (fragment.type === "player") {
      let className = "response-player-name";
      if (fragment.battleTeam === "dawn") className += " team-dawn";
      else if (fragment.battleTeam === "dusk") className += " team-dusk";
      const playerIdAttribute = typeof fragment.playerId === "string"
        ? ` data-player-id="${escapeHtml(fragment.playerId)}"`
        : "";
      markup += `<strong class="${className}"${playerIdAttribute}>${escapeHtml(fragment.text)}</strong>`;
    } else {
      markup += escapeHtml(fragment.text);
    }
  }
  return markup;
}

const CANCELLED_ASYNC_RESULTS = Object.freeze({
  requestTarget:null,
  requestDiscard:Object.freeze([]),
  requestResponse:Object.freeze({ status:"cancelled" }),
  waitForHumanPlayEnd:false,
  requestPublicCard:null,
  requestCardFlow:null,
  requestHiddenCards:Object.freeze([]),
  requestZoneCard:null,
  showPrivateReveal:false
});

export class UIManager {
  constructor() {
    this.elements = Object.fromEntries([
      "start-screen", "selection-screen", "game-screen", "start-button", "candidate-grid", "team-preview",
      "status-metrics", "restart-button", "cpu-grid", "human-panel", "human-hand", "hand-hint",
      "thinking-indicator", "current-card", "action-prompt", "private-reveal", "response-panel",
      "public-pool-view", "judgment-view", "dying-view", "duel-view",
      "skill-button", "end-play-button", "discard-confirm-button", "cancel-interaction-button",
      "log-panel", "battle-layout", "log-toggle-button", "fast-mode-button",
      "log-list", "log-count", "skill-details-overlay", "game-over-overlay", "game-over-title", "game-over-copy", "play-again-button"
    ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
    this.callbacks = {};
    this.sound = new SoundManager();
    this.audioButtons = [...document.querySelectorAll("[data-audio-toggle]")];
    this.musicVolumeInputs = [...document.querySelectorAll("[data-music-volume]")];
    this.game = null;
    this.targetState = null;
    this.discardState = null;
    this.responseState = null;
    this.playEndState = null;
    this.privateRevealToken = 0;
    this.thinkingPlayerId = null;
    this.thinkingMessage = "正在思考";
    this.skillDetailsTrigger = null;
    this.fastMode = false;
    this.logCollapsed = false;
    this.animationController = new AnimationController();
    this.interactionController = new InteractionController(this);
    this.publicPoolView = new PublicPoolView(this.elements.public_pool_view, () => this.playSound("select"));
    this.privateRevealView = new PrivateRevealView(this.elements.private_reveal);
    this.judgmentView = new JudgmentView(this.elements.judgment_view);
    this.viewportWasNarrow = window.innerWidth < 1280;
    this.bindEvents();
  }

  setCallbacks(callbacks) { this.callbacks = callbacks; }

  /** 切换共享 UI 的当前对局所有权；普通 render 永远不能改变该绑定。 */
  attachGame(game) {
    if (this.game && this.game !== game) this.cancelPendingInteractions();
    this.game = game ?? null;
    return this.game;
  }

  isGameAttached(game) {
    return Boolean(game && this.game === game && !game.state?.isDisposed &&
      game.state?.gameId && this.game.state.gameId === game.state.gameId);
  }

  /**
   * 为单局创建带所有权校验的 UI 门面。旧局恢复执行后，所有同步 UI 写入都会
   * 被忽略，异步请求则立即得到可终止的取消结果。
   */
  createGameSession(game) {
    const manager = this;
    return new Proxy(manager, {
      get(target, property) {
        if (property === "attachedGame") return game;
        if (property === "isSessionCurrent") return () => manager.isGameAttached(game);
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          const ownsUi = manager.game === game;
          const allowCleanup = property === "cancelPendingInteractions" && ownsUi;
          if (!allowCleanup && !manager.isGameAttached(game)) {
            if (Object.hasOwn(CANCELLED_ASYNC_RESULTS, property)) {
              return Promise.resolve(CANCELLED_ASYNC_RESULTS[property]);
            }
            return undefined;
          }
          return value.apply(target, args);
        };
      }
    });
  }

  bindEvents() {
    this.updateAudioButtons();
    for (const button of this.audioButtons) button.addEventListener("click", () => this.toggleAudio());
    for (const input of this.musicVolumeInputs) input.addEventListener("input", () => this.setMusicVolume(input.value));
    this.elements.start_button.addEventListener("click", () => { void this.sound.unlock(); this.playSound("select"); this.callbacks.onStart?.(); });
    this.elements.restart_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onRestart?.(); });
    this.elements.play_again_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onRestart?.(); });
    this.elements.candidate_grid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-general-id]");
      if (button) { this.playSound("select"); this.callbacks.onSelectGeneral?.(button.dataset.generalId); }
    });
    this.elements.human_hand.addEventListener("click", (event) => this.handleHandClick(event));
    this.elements.cpu_grid.addEventListener("wheel", (event) => {
      const strip = event.target.closest(".opponent-hand-strip");
      if (!strip || strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive:false });
    for (const zone of [this.elements.cpu_grid, this.elements.human_panel]) {
      zone.addEventListener("click", (event) => this.handlePlayerClick(event));
      zone.addEventListener("keydown", (event) => {
        if (!this.targetState || !["Enter", " "].includes(event.key) || event.target.closest("button, a, input, select, textarea, summary")) return;
        if (!event.target.closest("[data-player-id]")) return;
        event.preventDefault();
        this.handlePlayerClick(event);
      });
    }
    this.elements.skill_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onSkill?.(); });
    this.elements.end_play_button.addEventListener("click", () => this.callbacks.onEndPlay?.());
    this.elements.discard_confirm_button.addEventListener("click", () => { this.playSound("select"); this.confirmDiscard(); });
    this.elements.cancel_interaction_button.addEventListener("click", () => { this.playSound("select"); this.cancelTarget(); });
    this.elements.response_panel.addEventListener("click", (event) => {
      const responseCard = event.target.closest("[data-response-card-id]");
      if (responseCard) { this.playSound("select"); this.toggleResponseCard(responseCard.dataset.responseCardId); return; }
      const targetConfirm = event.target.closest("[data-target-confirm]");
      if (targetConfirm) { this.playSound("select"); this.confirmTarget(); return; }
      const targetCancel = event.target.closest("[data-target-cancel]");
      if (targetCancel) { this.playSound("select"); this.cancelTarget(); return; }
      const button = event.target.closest("[data-response-choice]");
      if (button) { this.playSound("select"); this.resolveResponse(button.dataset.responseChoice === "use"); }
    });
    this.interactionController.bind(this.elements.response_panel);
    this.elements.log_toggle_button.addEventListener("click", () => this.setLogCollapsed(!this.logCollapsed));
    window.addEventListener("resize", () => this.handleViewportResize());
    this.elements.fast_mode_button.addEventListener("click", () => this.callbacks.onToggleFastMode?.(!this.fastMode));
    this.elements.skill_details_overlay.addEventListener("click", (event) => {
      if (event.target === this.elements.skill_details_overlay || event.target.closest("[data-skill-dialog-close]")) this.hideSkillDetails();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") this.hideSkillDetails(); });
  }

  showStart() {
    this.sound.stopMusic();
    this.clearLog();
    this.elements.start_screen.classList.remove("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
  }

  showSelection(candidates, battleTeam) {
    this.sound.setMusicTeam(battleTeam);
    this.cancelPendingInteractions();
    this.resetCurrentCard();
    this.clearLog();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.remove("is-hidden");
    this.elements.game_over_overlay.classList.add("is-hidden");
    this.elements.team_preview.innerHTML = `<span>你的本局阵营</span><strong class="team-${battleTeam}">${TEAM_CONFIG[battleTeam].name}</strong>`;
    this.elements.candidate_grid.innerHTML = candidates.map(candidateCardTemplate).join("");
  }

  showGame(game) {
    this.attachGame(game);
    this.resetCurrentCard();
    this.clearLog();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.remove("is-hidden");
    this.setLogCollapsed(window.innerWidth < 1280);
    this.viewportWasNarrow = window.innerWidth < 1280;
    if (game.state.players.every((player) => player.general)) this.render(game);
  }

  handleViewportResize() {
    const isNarrow = window.innerWidth < 1280;
    if (isNarrow && !this.viewportWasNarrow && !this.elements.game_screen.classList.contains("is-hidden")) {
      this.setLogCollapsed(true);
    }
    this.viewportWasNarrow = isNarrow;
  }

  candidateTemplate(general, index) { return candidateCardTemplate(general, index); }

  render(game = this.game) {
    if (!this.isGameAttached(game) || !game.state.players.length || !game.state.players[0].general) return false;
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
    const targetSource = this.targetState?.meta?.source ?? human;
    this.elements.cpu_grid.innerHTML = state.players.slice(1).map((player) => playerPanelTemplate(player, {
      ...targetOptions, isCurrent: game.currentPlayer?.id === player.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(player.id)),
      isSelectedTarget: this.targetState?.selected?.id === player.id,
      isThinking: this.thinkingPlayerId === player.id,
      distanceInfo: DistanceSystem.describe(game, targetSource, player),
      distanceState: this.getDistanceState(targetSource, player),
      opponentHandSlots: createOpponentHandView(human, player)
    })).join("");
    this.elements.human_panel.innerHTML = playerPanelTemplate(human, {
      ...targetOptions, isHuman: true, isCurrent: game.currentPlayer?.id === human.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(human.id)),
      isSelectedTarget: this.targetState?.selected?.id === human.id,
      isThinking: this.thinkingPlayerId === human.id,
      distanceInfo:this.targetState && targetSource.id !== human.id ? DistanceSystem.describe(game, targetSource, human) : null,
      distanceState:this.targetState && targetSource.id !== human.id ? this.getDistanceState(targetSource, human) : null
    });
    this.renderHand(game, human);
    this.renderControls(game, human);
    this.animationController.flush(document);
    return true;
  }

  playerTemplate(player, human, isHuman) {
    return playerPanelTemplate(player, {
      humanTeam: human.battleTeam, isHuman, isCurrent: this.game?.currentPlayer?.id === player.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(player.id)), isTargeting: Boolean(this.targetState),
      isSelectedTarget: this.targetState?.selected?.id === player.id,
      isThinking: this.thinkingPlayerId === player.id,
      opponentHandSlots: isHuman ? null : createOpponentHandView(human, player)
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
    else if (!this.targetState) this.elements.hand_hint.textContent = `${human.hand.length}张 · 不可用的牌仍可聚焦查看`;
  }

  renderControls(game, human) {
    const humanPlay = game.currentPlayer?.id === human.id && game.state.phase === "play" && human.alive && !game.state.isGameOver;
    const interaction = this.isInteractionActive();
    const skill = getActiveSkill(human);
    const skillLegal = skill?.canUse(game, human).ok ?? false;
    this.elements.skill_button.textContent = skillButtonLabel(skill);
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
      this.playSound("select");
      this.discardState.selectedIds = toggleCardSelection(this.discardState.selectedIds, cardId, this.discardState.count);
      this.render(this.game);
      return;
    }
    this.callbacks.onCard?.(cardId);
  }

  handlePlayerClick(event) {
    // 目标选择期间，角色区域点击优先用于选择目标。
    const skillTrigger = event.target.closest("[data-skill-player-id]");
    if (skillTrigger && !this.targetState) {
      const player = this.game?.state.players.find((entry) => entry.id === skillTrigger.dataset.skillPlayerId);
      if (player) this.showSkillDetails(player, skillTrigger);
      return;
    }
    const panel = event.target.closest("[data-player-id]");
    if (!panel) return;
    if (this.targetState) {
      if (!this.targetState.legalIds.has(panel.dataset.playerId)) return;
      const target = this.targetState.players.find((player) => player.id === panel.dataset.playerId) ?? null;
      this.playSound?.("select");
      if (this.targetState.meta?.confirmSelection) {
        this.targetState.selected = target;
        this.renderTargetConfirmation();
        this.render(this.game);
        return;
      }
      const resolve = this.targetState.resolve;
      this.targetState = null;
      resolve(target);
      this.render(this.game);
      return;
    }
  }

  showSkillDetails(player, trigger = null) {
    if (!player?.general) return false;
    this.skillDetailsTrigger = trigger;
    this.elements.skill_details_overlay.innerHTML = skillDetailsTemplate(player);
    this.elements.skill_details_overlay.classList.remove("is-hidden");
    this.elements.skill_details_overlay.querySelector("[data-skill-dialog-close]")?.focus();
    return true;
  }

  hideSkillDetails() {
    this.elements.skill_details_overlay.classList.add("is-hidden");
    this.elements.skill_details_overlay.innerHTML = "";
    const trigger = this.skillDetailsTrigger;
    this.skillDetailsTrigger = null;
    if (trigger?.focus && trigger.isConnected !== false) trigger.focus();
  }

  requestTarget(players, prompt, meta = {}) {
    if (!players.length) return Promise.resolve(null);
    this.cancelTarget();
    return new Promise((resolve) => {
      this.targetState = { players, legalIds: new Set(players.map((player) => player.id)), resolve, meta, prompt, selected:null };
      this.setPrompt(prompt, "可选目标带有金色指示环");
      if (meta.confirmSelection) this.renderTargetConfirmation();
      this.render(this.game);
    });
  }

  renderTargetConfirmation() {
    if (!this.targetState?.meta?.confirmSelection) return;
    const selectedName = this.targetState.selected?.name ?? "尚未选择";
    this.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(this.targetState.meta.stepTitle ?? "选择目标")}</strong><span>${escapeHtml(selectedName)}</span></div><div class="response-copy"><p class="response-event">${escapeHtml(this.targetState.prompt)}</p></div><div class="response-actions"><button class="primary-button" type="button" data-target-confirm${this.targetState.selected ? "" : " disabled aria-disabled=\"true\""}>确认选择</button><button class="ghost-button" type="button" data-target-cancel>取消</button></div>`;
    this.elements.response_panel.classList.remove("is-hidden");
  }

  confirmTarget() {
    if (!this.targetState?.meta?.confirmSelection || !this.targetState.selected) return;
    const { resolve, selected } = this.targetState;
    this.targetState = null;
    this.elements.response_panel.classList.add("is-hidden");
    this.elements.response_panel.innerHTML = "";
    resolve(selected);
    if (this.game) this.render(this.game);
  }

  cancelTarget() {
    if (!this.targetState) return;
    const resolve = this.targetState.resolve;
    this.targetState = null;
    this.elements.response_panel.classList.add("is-hidden");
    this.elements.response_panel.innerHTML = "";
    resolve(null);
    if (this.game) this.render(this.game);
  }

  requestDiscard(player, count, prompt) {
    return new Promise((resolve) => {
      this.discardState = { player, count, selectedIds: new Set(), resolve };
      this.setPrompt(prompt, `还需选择${count}张`);
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
    if (this.responseState) this.resolveResponse({ status:"cancelled" });
    return new Promise((resolve) => {
      const deadline = Date.now() + request.timeoutMs;
      const settle = (choice) => {
        if (!this.responseState || this.responseState.request.id !== request.id) return;
        window.clearInterval(this.responseState.interval);
        this.responseState = null;
        this.elements.response_panel.classList.add("is-hidden");
        this.elements.response_panel.innerHTML = "";
        resolve(typeof choice === "object" ? choice : { status:choice ? "used" : "declined" });
        if (this.game) this.render(this.game);
      };
      const update = () => {
        const node = this.elements.response_panel.querySelector(".countdown");
        if (node) node.textContent = `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s`;
      };
      const interval = window.setInterval(update, 200);
      this.responseState = { request, resolve: settle, interval, deadline, label, selectedCardIds:new Set() };
      UIManager.prototype.renderResponseRequest.call(this);
      this.elements.response_panel.classList.remove("is-hidden");
      this.game.cleanupManager.delay(request.timeoutMs).then((completed) => {
        if (completed) settle({ status:"declined" });
      });
      update();
      this.render(this.game);
    });
  }

  renderResponseRequest() {
    const state = this.responseState;
    if (!state) return;
    const { request, label } = state;
    const presentation = request.presentation ?? {};
    const canUse = canSubmitResponse(request);
    const eventText = presentation.eventText ?? "当前有一项行动等待你的响应。";
    const responseText = presentation.responseText ?? "你可以改变即将发生的结算。";
    const availabilityText = presentation.availabilityText ?? "";
    const seconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    this.elements.response_panel.innerHTML = `<div class="response-title"><strong>响应窗口</strong><span class="countdown">${seconds}s</span></div><div class="response-copy"><p class="response-event">${renderResponseEvent(presentation, eventText)}</p><p class="response-requirement">${escapeHtml(responseText)}</p>${availabilityText ? `<p class="response-availability ${canUse ? "is-ready" : "is-insufficient"}">${escapeHtml(availabilityText)}</p>` : ""}</div><div class="response-actions"><button class="primary-button" data-response-choice="use"${canUse ? "" : ' disabled aria-disabled="true"'}>${escapeHtml(presentation.buttonLabel ?? label)}</button><button class="ghost-button" data-response-choice="decline">${escapeHtml(presentation.declineLabel ?? "放弃响应")}</button></div>`;
  }

  toggleResponseCard(cardId) {
    const state = this.responseState;
    if (!state || state.request.type !== "leverageAssault" || !state.request.legalCardIds.includes(cardId)) return;
    state.selectedCardIds = toggleCardSelection(state.selectedCardIds, cardId, 1);
    UIManager.prototype.renderResponseRequest.call(this);
  }

  resolveResponse(choice) {
    const selectedCardId = this.responseState?.selectedCardIds?.values().next().value ?? null;
    const result = typeof choice === "object" ? choice : { status:choice ? "used" : "declined", cardId:choice ? selectedCardId : null };
    this.responseState?.resolve(result);
  }
  requestCardFlow(...args) { return this.interactionController.requestCardFlow(...args); }
  requestHiddenCards(...args) { return this.interactionController.requestHiddenCards(...args); }
  requestZoneCard(...args) { return this.interactionController.requestZoneCard(...args); }
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
    // 思考指示已经包含完整行动和目标，避免下方 action-prompt 重复显示同一信息。
    this.elements.action_prompt.classList.toggle("is-hidden", isThinking);
    if (isThinking) this.elements.thinking_indicator.innerHTML = thinkingTemplate(player, message);
    if (this.game?.state.players[0]?.general) this.render(this.game);
  }

  setCurrentCard(cardOrName, source, targetLabel = "", displayTargets = null) {
    this.elements.current_card.innerHTML = resolvingCardTemplate(
      cardOrName, source, targetLabel, displayTargets
    );
    this.elements.current_card.classList.remove("is-entering");
    void this.elements.current_card.offsetWidth;
    this.elements.current_card.classList.add("is-entering");
  }

  resetCurrentCard() {
    this.elements.current_card.classList.remove("is-entering");
    this.elements.current_card.innerHTML = emptyResolvingCardTemplate();
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
  showJudgment(player, card, context = {}) { this.judgmentView.show(player, card, context); }
  hideJudgment() { this.judgmentView.hide(); }
  showDying(target, context) {
    this.elements.dying_view.innerHTML = `<strong>${escapeHtml(target.name)}濒死</strong><span>当前生命 ${context.currentHp}</span><b>还需恢复${context.need}点生命</b>`;
    this.elements.dying_view.classList.remove("is-hidden");
  }
  hideDying() { this.elements.dying_view.classList.add("is-hidden"); this.elements.dying_view.innerHTML = ""; }
  showDuel(current, opponent) { this.elements.duel_view.innerHTML = `<strong>决斗</strong><span>${escapeHtml(current.name)}需打出突袭</span><small>对手：${escapeHtml(opponent.name)}</small>`; this.elements.duel_view.classList.remove("is-hidden"); }
  hideDuel() { this.elements.duel_view.classList.add("is-hidden"); this.elements.duel_view.innerHTML = ""; }

  appendLog(entry, count) {
    const node = document.createElement("div");
    node.className = `log-entry ${entry.kind === "normal" ? "" : `is-${entry.kind}`}`;
    node.innerHTML = formatLogEntry(entry);
    this.elements.log_list.append(node);
    this.updateLogCount(count);
    this.elements.log_list.scrollTop = this.elements.log_list.scrollHeight;
  }

  clearLog() {
    this.elements.log_list.innerHTML = "";
    this.elements.log_list.scrollTop = 0;
    this.updateLogCount(0);
  }

  updateLogCount(count) {
    const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
    const label = `${safeCount} 条`;
    this.elements.log_count.textContent = label;
    this.elements.log_count.title = `共 ${safeCount} 条对局记录`;
    this.elements.log_count.setAttribute("aria-label", `共 ${safeCount} 条对局记录`);
  }

  playSound(name) { void this.sound.play(name); }

  setMusicTeam(team) { this.sound.setMusicTeam(team); }

  async toggleAudio() {
    await this.sound.setEnabled(!this.sound.enabled);
    this.updateAudioButtons();
  }

  updateAudioButtons() {
    for (const button of this.audioButtons) {
      button.setAttribute("aria-pressed", String(this.sound.enabled));
      button.setAttribute("aria-label", this.sound.enabled ? "关闭声音" : "开启声音");
      const label = button.querySelector("span");
      if (label) label.textContent = this.sound.enabled ? "声音：开" : "声音：关";
    }
    const percentage = String(Math.round(this.sound.musicVolume * 100));
    for (const input of this.musicVolumeInputs) {
      input.value = percentage;
      input.setAttribute("aria-valuetext", `${percentage}%`);
    }
  }

  setMusicVolume(value) {
    this.sound.setMusicVolume(Number(value) / 100);
    this.updateAudioButtons();
  }

  queueFeedback(type, playerId = null, amount = null) {
    this.animationController.queue(type, playerId, amount);
    const soundByFeedback = { draw:"draw", damage:"hit", heal:"heal", shield:"shield", discard:"discard" };
    if (soundByFeedback[type]) this.playSound(soundByFeedback[type]);
  }

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
    if (this.responseState) this.responseState.resolve({ status:"cancelled" });
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
    this.hideSkillDetails();
    this.elements.private_reveal.classList.add("is-hidden");
    this.elements.response_panel.classList.add("is-hidden");
    this.elements.response_panel.innerHTML = "";
    this.elements.thinking_indicator.classList.add("is-hidden");
    this.elements.action_prompt.classList.remove("is-hidden");
  }
}
