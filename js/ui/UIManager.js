/**
 * 本文件负责所有 DOM 渲染与真人交互 Promise，依赖配置、合法性规则和技能注册表。
 * UI 只提交卡牌 ID、目标或按钮意图，绝不直接修改生命、手牌、能量与胜负。
 * 重新开始时 cancelPendingInteractions 会清理倒计时和所有未完成 Promise，避免旧点击影响新局。
 */
import { TEAM_CONFIG, PHASE_NAMES } from "../config/gameConfig.js";
import { RuleEngine } from "../core/RuleEngine.js";
import { getActiveSkill } from "../generals/skillRegistry.js";

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

export class UIManager {
  constructor() {
    this.elements = Object.fromEntries([
      "start-screen", "selection-screen", "game-screen", "start-button", "candidate-grid", "team-preview",
      "status-metrics", "restart-button", "cpu-grid", "human-panel", "human-hand", "hand-hint",
      "thinking-indicator", "current-card", "action-prompt", "private-reveal", "response-panel",
      "skill-button", "end-play-button", "discard-confirm-button", "cancel-interaction-button",
      "log-list", "log-count", "game-over-overlay", "game-over-title", "game-over-copy", "play-again-button"
    ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
    this.callbacks = {};
    this.game = null;
    this.targetState = null;
    this.discardState = null;
    this.responseState = null;
    this.playEndState = null;
    this.privateRevealTimer = null;
    this.bindEvents();
  }

  /** 设置页面按钮回调。控制器在 main.js 中只绑定一次。 */
  setCallbacks(callbacks) { this.callbacks = callbacks; }

  /** 绑定事件委托。动态卡牌与角色面板不会反复注册监听器。 */
  bindEvents() {
    this.elements.start_button.addEventListener("click", () => this.callbacks.onStart?.());
    this.elements.restart_button.addEventListener("click", () => this.callbacks.onRestart?.());
    this.elements.play_again_button.addEventListener("click", () => this.callbacks.onRestart?.());
    this.elements.candidate_grid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-general-id]");
      if (button) this.callbacks.onSelectGeneral?.(button.dataset.generalId);
    });
    this.elements.human_hand.addEventListener("click", (event) => this.handleHandClick(event));
    this.elements.cpu_grid.addEventListener("click", (event) => this.handlePlayerClick(event));
    this.elements.human_panel.addEventListener("click", (event) => this.handlePlayerClick(event));
    this.elements.skill_button.addEventListener("click", () => this.callbacks.onSkill?.());
    this.elements.end_play_button.addEventListener("click", () => this.callbacks.onEndPlay?.());
    this.elements.discard_confirm_button.addEventListener("click", () => this.confirmDiscard());
    this.elements.cancel_interaction_button.addEventListener("click", () => this.cancelTarget());
    this.elements.response_panel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-response-choice]");
      if (button) this.resolveResponse(button.dataset.responseChoice === "use");
    });
  }

  /** 切回封面并隐藏所有对局层。 */
  showStart() {
    this.elements.start_screen.classList.remove("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
  }

  /** 显示四名候选角色。battleTeam 只用于提前告知真人本局公开阵营。 */
  showSelection(candidates, battleTeam) {
    this.cancelPendingInteractions();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.remove("is-hidden");
    this.elements.game_over_overlay.classList.add("is-hidden");
    this.elements.team_preview.innerHTML = `你的本局阵营：<strong>${TEAM_CONFIG[battleTeam].name}</strong>`;
    this.elements.candidate_grid.innerHTML = candidates.map((general, index) => this.candidateTemplate(general, index)).join("");
  }

  /** 显示对局主界面并清空旧日志 DOM。 */
  showGame(game) {
    this.game = game;
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.remove("is-hidden");
    this.elements.log_list.innerHTML = "";
    this.elements.log_count.textContent = "0";
    // 角色配置要在 confirmGeneral 中完成；这里仅切换场景，避免用尚未分配角色的座位渲染面板。
    if (game.state.players.every((player) => player.general)) this.render(game);
  }

  /** 构造一张候选角色卡，仅使用配置中的公开文本。 */
  candidateTemplate(general, index) {
    return `<article class="candidate-card" data-glyph="${escapeHtml(general.glyph)}">
      <span class="candidate-index">CANDIDATE · 0${index + 1}</span>
      <div class="candidate-avatar" aria-hidden="true">${escapeHtml(general.glyph)}</div>
      <div class="candidate-name-row"><h3>${escapeHtml(general.name)}</h3><span class="hp-chip">♥ ${general.maxHp}</span></div>
      <div class="tag-row">${general.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      <p class="character-description">${escapeHtml(general.description)}</p>
      <div class="skill-copy"><h4><span>被动 · ${escapeHtml(general.passiveName)}</span><small>持续</small></h4><p>${escapeHtml(general.passiveDescription)}</p></div>
      <div class="skill-copy"><h4><span>主动 · ${escapeHtml(general.activeName)}</span><small>${general.activeCost} 能量</small></h4><p>${escapeHtml(general.activeDescription)}</p></div>
      <button class="primary-button" type="button" data-general-id="${general.id}">选择 ${escapeHtml(general.name)}</button>
    </article>`;
  }

  /**
   * 从 GameState 重绘公开面板和真人手牌。电脑手牌只渲染数量，具体牌不会出现在 DOM。
   */
  render(game) {
    this.game = game;
    if (!game?.state.players.length || game.state.isDisposed) return;
    const state = game.state;
    const human = state.players[0];
    const dawnAlive = state.players.filter((player) => player.alive && player.battleTeam === "dawn").length;
    const duskAlive = state.players.filter((player) => player.alive && player.battleTeam === "dusk").length;
    this.elements.status_metrics.innerHTML = [
      ["ROUND", `第 ${state.currentRound} 轮`], ["ACTIVE", game.currentPlayer?.name ?? "—"],
      ["PHASE", PHASE_NAMES[state.phase] ?? state.phase], ["TEAMS", `晨 ${dawnAlive} · 暮 ${duskAlive}`],
      ["DECK", state.deck.cards.length], ["DISCARD", state.deck.discardPile.length]
    ].map(([label, value]) => `<span class="metric"><small>${label}</small><strong>${escapeHtml(value)}</strong></span>`).join("");
    this.elements.cpu_grid.innerHTML = state.players.slice(1).map((player) => this.playerTemplate(player, human, false)).join("");
    this.elements.human_panel.innerHTML = this.playerTemplate(human, human, true);
    this.renderHand(game, human);
    this.renderControls(game, human);
  }

  /** 生成角色公开面板；只显示 hand.length，从不插入电脑卡牌对象。 */
  playerTemplate(player, human, isHuman) {
    const current = this.game.currentPlayer?.id === player.id;
    const relationship = player.id === human.id ? "" : player.battleTeam === human.battleTeam ? "is-ally" : "is-enemy";
    const legal = this.targetState?.legalIds.has(player.id);
    const statuses = [
      player.statuses.exposed ? "破绽" : null,
      player.statuses.huntMark ? "猎印" : null,
      player.shield ? `护盾 ${player.shield}` : null
    ].filter(Boolean);
    return `<article class="${isHuman ? "human-panel" : "cpu-card"} team-${player.battleTeam} ${relationship} ${current ? "is-active" : ""} ${player.alive ? "" : "is-dead"} ${legal ? "target-legal" : ""}" data-player-id="${player.id}" aria-label="${escapeHtml(player.name)}">
      <div class="character-top"><div class="mini-avatar">${escapeHtml(player.general.glyph)}</div><div class="character-name"><strong>${escapeHtml(player.name)}${isHuman ? " · 你" : ""}</strong><small>${escapeHtml(player.loreFaction)}</small></div><span class="team-badge ${player.battleTeam}">${TEAM_CONFIG[player.battleTeam].shortName}</span></div>
      <div class="hp-bar"><span style="width:${clampedPercent(player.hp, player.maxHp)}%"></span></div>
      <div class="resource-grid"><span class="resource"><small>生命</small><strong>${player.hp} / ${player.maxHp}</strong></span><span class="resource"><small>能量</small><strong>${player.energy} / ${player.maxEnergy}</strong></span><span class="resource"><small>护盾</small><strong>${player.shield}</strong></span><span class="resource"><small>手牌</small><strong>${player.hand.length}</strong></span></div>
      <div class="status-row">${statuses.length ? statuses.map((status) => `<span class="status-chip">${status}</span>`).join("") : '<span class="status-chip">状态稳定</span>'}</div>
      <div class="equipment-line">装备：${player.equipment ? escapeHtml(player.equipment.name) : "空槽"}</div>
      ${isHuman ? `<p class="character-description">${escapeHtml(player.general.description)}</p><div class="skill-copy"><h4>${escapeHtml(player.general.passiveName)}</h4><p>${escapeHtml(player.general.passiveDescription)}</p></div>` : ""}
    </article>`;
  }

  /** 只渲染真人真实手牌，并根据当前交互模式标记可用/已选。 */
  renderHand(game, human) {
    const inDiscard = Boolean(this.discardState);
    const blockedByInteraction = Boolean(this.targetState || this.responseState);
    this.elements.human_hand.innerHTML = human.hand.map((card) => {
      const playable = RuleEngine.canPlayCard(game, human, card).ok;
      const selected = this.discardState?.selectedIds.has(card.id);
      const disabled = inDiscard ? false : (!playable || blockedByInteraction || game.actionLocked);
      return `<button class="hand-card ${selected ? "is-selected" : ""}" type="button" data-card-id="${card.id}" data-category="${escapeHtml(card.categoryName)}" ${disabled ? "disabled" : ""}>
        <h3>${escapeHtml(card.name)}</h3><p>${escapeHtml(card.description)}</p><span class="card-tags">${card.subtypes.map(escapeHtml).join(" · ")}</span>
      </button>`;
    }).join("") || '<p class="character-description">手牌区空空如也。</p>';
    if (this.discardState) this.elements.hand_hint.textContent = `已选 ${this.discardState.selectedIds.size} / ${this.discardState.count}`;
    else if (!this.targetState) this.elements.hand_hint.textContent = `${human.hand.length} 张 · 可用牌保持高亮`;
  }

  /** 刷新技能、结束与弃牌按钮状态。 */
  renderControls(game, human) {
    const humanPlay = game.currentPlayer?.id === human.id && game.state.phase === "play" && human.alive && !game.state.isGameOver;
    const interaction = Boolean(this.targetState || this.discardState || this.responseState);
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

  /** 手牌点击在弃牌模式下切换选择，否则提交给 Game。 */
  handleHandClick(event) {
    const button = event.target.closest("[data-card-id]");
    if (!button) return;
    const cardId = button.dataset.cardId;
    if (this.discardState) {
      if (this.discardState.selectedIds.has(cardId)) this.discardState.selectedIds.delete(cardId);
      else if (this.discardState.selectedIds.size < this.discardState.count) this.discardState.selectedIds.add(cardId);
      this.render(this.game);
      return;
    }
    this.callbacks.onCard?.(cardId);
  }

  /** 仅在 requestTarget 激活时接受合法角色面板点击。 */
  handlePlayerClick(event) {
    const panel = event.target.closest("[data-player-id]");
    if (!panel || !this.targetState?.legalIds.has(panel.dataset.playerId)) return;
    const target = this.targetState.players.find((player) => player.id === panel.dataset.playerId) ?? null;
    const resolve = this.targetState.resolve;
    this.targetState = null;
    this.elements.cancel_interaction_button.classList.add("is-hidden");
    resolve(target);
    this.render(this.game);
  }

  /**
   * 高亮合法目标并等待点击。取消或重新开始返回 null。
   * @returns {Promise<Object|null>}
   */
  requestTarget(players, prompt) {
    if (!players.length) return Promise.resolve(null);
    this.cancelTarget();
    return new Promise((resolve) => {
      this.targetState = { players, legalIds: new Set(players.map((player) => player.id)), resolve };
      this.setPrompt(prompt, "可选目标正在发光");
      this.render(this.game);
    });
  }

  /** 取消当前目标选择并令等待者得到 null。 */
  cancelTarget() {
    if (!this.targetState) return;
    const resolve = this.targetState.resolve;
    this.targetState = null;
    resolve(null);
    if (this.game) this.render(this.game);
  }

  /**
   * 进入强制弃牌模式，直到选择数量准确并确认。
   * @returns {Promise<Array<Object>>} 所选实体牌；清理时返回空数组。
   */
  requestDiscard(player, count, prompt) {
    return new Promise((resolve) => {
      this.discardState = { player, count, selectedIds: new Set(), resolve };
      this.setPrompt(prompt, `还需选择 ${count} 张`);
      this.render(this.game);
    });
  }

  /** 完成弃牌选择。UI 不移动卡牌，只把实体引用交回 Game。 */
  confirmDiscard() {
    if (!this.discardState || this.discardState.selectedIds.size !== this.discardState.count) return;
    const state = this.discardState;
    const cards = state.player.hand.filter((card) => state.selectedIds.has(card.id));
    this.discardState = null;
    state.resolve(cards);
    this.render(this.game);
  }

  /**
   * 显示统一响应面板与倒计时。快速多次点击和超时只会结算一次。
   * @returns {Promise<boolean>} 是否使用响应。
   */
  requestResponse(request, label) {
    if (this.responseState) this.resolveResponse(false);
    return new Promise((resolve) => {
      const deadline = Date.now() + request.timeoutMs;
      const settle = (choice) => {
        if (!this.responseState || this.responseState.request.id !== request.id) return;
        window.clearInterval(this.responseState.interval);
        window.clearTimeout(this.responseState.timeout);
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
      this.responseState = { request, resolve: settle, interval: window.setInterval(update, 200), timeout: window.setTimeout(() => settle(false), request.timeoutMs) };
      this.elements.response_panel.innerHTML = `<div class="response-title">响应窗口 · <span class="countdown">${Math.ceil(request.timeoutMs / 1000)}s</span></div><div class="response-actions"><button class="primary-button" data-response-choice="use">${escapeHtml(label)}</button><button class="ghost-button" data-response-choice="decline">不使用</button></div>`;
      this.elements.response_panel.classList.remove("is-hidden");
      update();
      this.render(this.game);
    });
  }

  /** 完成当前响应；超时后按钮已失效，不会再次调用旧 resolver。 */
  resolveResponse(choice) { this.responseState?.resolve(choice); }

  /** 等待真人点击结束出牌；同局只保留一个等待者。 */
  waitForHumanPlayEnd(gameId) {
    return new Promise((resolve) => { this.playEndState = { gameId, resolve }; this.render(this.game); });
  }

  /** 仅解析匹配 gameId 的出牌阶段等待，防止旧局按钮结束新回合。 */
  resolveHumanPlayEnd(gameId) {
    if (!this.playEndState || this.playEndState.gameId !== gameId) return;
    const resolve = this.playEndState.resolve;
    this.playEndState = null;
    resolve(true);
    this.render(this.game);
  }

  /** 设置中央操作提示与手牌提示。 */
  setPrompt(message, handHint = "") {
    this.elements.action_prompt.textContent = message;
    if (handHint) this.elements.hand_hint.textContent = handHint;
  }

  /** 显示或隐藏电脑思考状态。 */
  setThinking(isThinking, name = "电脑") {
    this.elements.thinking_indicator.classList.toggle("is-hidden", !isThinking);
    if (isThinking) this.elements.thinking_indicator.lastChild.textContent = ` ${name}正在推演`;
  }

  /** 显示当前牌或技能，不改变结算状态。 */
  setCurrentCard(name, source) {
    this.elements.current_card.innerHTML = `<span class="current-card-icon">◇</span><div><small>${escapeHtml(source)}</small><strong>${escapeHtml(name)}</strong></div>`;
  }

  /** 短暂显示仅真人可见的窥隙结果，不写公开日志。 */
  showPrivateReveal(message) {
    window.clearTimeout(this.privateRevealTimer);
    this.elements.private_reveal.textContent = message;
    this.elements.private_reveal.classList.remove("is-hidden");
    this.privateRevealTimer = window.setTimeout(() => this.elements.private_reveal.classList.add("is-hidden"), 3200);
  }

  /** 追加一条公开日志并自动滚动到底部。 */
  appendLog(entry, count) {
    const node = document.createElement("div");
    node.className = `log-entry ${entry.kind === "normal" ? "" : `is-${entry.kind}`}`;
    node.textContent = entry.message;
    this.elements.log_list.append(node);
    this.elements.log_count.textContent = String(count);
    this.elements.log_list.scrollTop = this.elements.log_list.scrollHeight;
  }

  /** 显示胜负遮罩。 */
  showGameOver(winnerTeam, humanWon) {
    this.elements.game_over_title.textContent = humanWon ? "你的阵营获胜" : "你的阵营落败";
    this.elements.game_over_copy.textContent = `${TEAM_CONFIG[winnerTeam].name}存活到了最后。${humanWon ? "这场联结与应变赢得了终局。" : "重新征召旅者，下一局仍会有全新的阵营与牌序。"}`;
    this.elements.game_over_overlay.classList.remove("is-hidden");
  }

  /**
   * 清理目标、弃牌、响应、出牌等待与私密展示。所有 Promise 都获得安全的取消结果。
   */
  cancelPendingInteractions() {
    if (this.targetState) { const resolve = this.targetState.resolve; this.targetState = null; resolve(null); }
    if (this.discardState) { const resolve = this.discardState.resolve; this.discardState = null; resolve([]); }
    if (this.responseState) this.responseState.resolve(false);
    if (this.playEndState) { const resolve = this.playEndState.resolve; this.playEndState = null; resolve(false); }
    window.clearTimeout(this.privateRevealTimer);
    this.elements.private_reveal.classList.add("is-hidden");
    this.elements.response_panel.classList.add("is-hidden");
  }
}

function clampedPercent(value, maximum) {
  return maximum > 0 ? Math.max(0, Math.min(100, value / maximum * 100)) : 0;
}
