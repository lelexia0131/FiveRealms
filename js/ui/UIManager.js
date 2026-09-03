/**
 * DOM 渲染与真人意图入口。这里只提交卡牌 ID、目标和按钮意图，不修改生命、能量、手牌或胜负。
 */
import { PHASE_PRESENTATION, TEAM_PRESENTATION } from "../adapters/ui/PresentationMetadata.js";
import { ActionLegality } from "../application/action/ActionLegality.js";
import { canUseActiveSkill, getActiveSkill } from "../application/action/SkillRuntime.js";
import {
  candidateCardTemplate, emptyResolvingCardTemplate, escapeHtml, formatLogEntry, handCardTemplate,
  playerPanelTemplate, resolvingCardTemplate, skillDetailsTemplate, thinkingTemplate
} from "./templates.js";
import { AnimationController } from "./animationController.js";
import { InteractionController } from "./InteractionController.js";
import { PublicPoolView } from "./PublicPoolView.js";
import { PrivateRevealView } from "./PrivateRevealView.js";
import { JudgmentView } from "./JudgmentView.js";
import { createOpponentHandView } from "./handVisibility.js";
import { restoreHorizontalCardScroll } from "./horizontalCardScroll.js";
import { toggleCardSelection } from "./selectionUtils.js";
import { SoundManager } from "../audio/SoundManager.js";
import { normalizeAiSpeed, readAiSpeedPreference, writeAiSpeedPreference } from "../utils/aiTiming.js";
import { TEAM_ASSIGNMENT_MODE } from "../application/match/TeamAssignmentMode.js";
import { MatchMvpResultView } from "./results/MatchMvpResultView.js";
import { RulebookView } from "./RulebookView.js";
import { HistoryArchiveView } from "./history/HistoryArchiveView.js";

const TEAM_ASSIGNMENT_PRESENTATION = Object.freeze({
  [TEAM_ASSIGNMENT_MODE.TWO]: Object.freeze({
    eyebrow: "晨星 · 角色征召",
    title: "二人小队征召",
    copy: "选择你的角色 · 你将拥有 1 名队友",
    preview: "二人小队",
    detail: "1 名队友 · 对抗 3 名敌人"
  }),
  [TEAM_ASSIGNMENT_MODE.THREE]: Object.freeze({
    eyebrow: "暮影 · 角色征召",
    title: "三人小队征召",
    copy: "选择你的角色 · 你将拥有 2 名队友",
    preview: "三人小队",
    detail: "2 名队友 · 对抗 2 名敌人"
  }),
  [TEAM_ASSIGNMENT_MODE.RANDOM]: Object.freeze({
    eyebrow: "命运 · 角色征召",
    title: "随机征召",
    copy: "选择你的角色 · 阵营规模将在本局随机决定",
    preview: "随机分配",
    detail: "随机加入二人或三人阵营"
  })
});

// 5px 区分指针微小抖动与明确拖拽；2px 只吸收滚动尺寸的子像素误差。
const CARD_DRAG_THRESHOLD_PX = 5;
const HORIZONTAL_CARD_SCROLL_SELECTOR = ".human-hand, .opponent-hand-strip, .hidden-card-grid, .private-card-grid, .tableau-cards";
const LOG_BOTTOM_TOLERANCE_PX = 2;
const FEEDBACK_SOUND_BY_TYPE = Object.freeze({
  draw: "draw",
  damage: "hit",
  heal: "heal",
  shield: "shield",
  discard: "discard"
});

/*
功能
判断响应请求是否拥有足够合法卡牌 ID 可提交。

调用方
renderResponseRequest 与响应 UI 测试。

输入
data-only response request。

输出
requiredCount 为零或合法 ID 数量足够时返回 true。

读取状态
request.requiredCount、legalCardIds。

写入状态
无。

调用函数
Math.max、Number。

边界与不变量
非法 requiredCount 按零处理；不读取或解析 Card 实体。
*/
export function canSubmitResponse(request) {
  const requiredCount = Math.max(0, Number(request?.requiredCount) || 0);
  return requiredCount === 0 || (request?.legalCardIds?.length ?? 0) >= requiredCount;
}

/*
功能
取得主动技能按钮的安全展示名称。

调用方
UIManager.renderControls 与 UI 测试。

输入
可选技能定义。

输出
技能名或缺省“主动技能”。

读取状态
skill.name。

写入状态
无。

调用函数
无。

边界与不变量
只读取定义展示字段，不调用技能运行时方法。
*/
export const skillButtonLabel = (skill) => skill?.name ?? "主动技能";

/*
功能
把结构化响应事件片段渲染为安全 HTML。

调用方
UIManager.renderResponseRequest。

输入
响应 presentation 与纯文本 fallback。

输出
转义后的响应事件标记。

读取状态
presentation.eventFragments 的公开文本、玩家 ID 与阵营。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
任一片段结构异常时整段回退转义文本；阵营 class 只接受 dawn/dusk。
*/
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
  /*
  功能
  绑定页面元素并创建所有浏览器展示/交互子视图。

  调用方
  main bootstrap。

  输入
  可选 HistoryStatsManager；页面元素使用当前 document/window。

  输出
  UIManager 实例。

  读取状态
  页面 DOM、窗口宽度与已持久化声音偏好。

  写入状态
  初始化元素引用、交互状态、声音、动画、历史数据展示边界和各 View，并绑定事件。

  调用函数
  SoundManager、AnimationController、InteractionController、各 View 构造器、bindEvents、setAiSpeed。

  边界与不变量
  UI 只提交 ID/token/intent，不直接修改权威游戏状态。
  */
  constructor({ historyStatsManager = null } = {}) {
    this.elements = Object.fromEntries([
      "start-screen", "history-archive-screen", "squad-selection-screen", "selection-screen", "game-screen", "start-button", "history-button", "rules-button",
      "squad-mode-grid", "back-to-start-button", "back-to-squad-button", "candidate-grid", "selection-eyebrow", "selection-title", "selection-copy", "team-preview",
      "status-metrics", "restart-button", "cpu-grid", "human-panel", "human-hand", "hand-hint",
      "thinking-indicator", "current-card", "action-prompt", "private-reveal", "response-panel",
      "public-pool-view", "judgment-view", "dying-view", "duel-view",
      "skill-button", "end-play-button", "discard-confirm-button", "cancel-interaction-button",
      "log-panel", "battle-layout", "log-toggle-button", "ai-speed-control",
      "log-list", "log-count", "skill-details-overlay", "game-over-overlay", "game-over-title", "game-over-copy",
      "match-mvp-result", "play-again-button", "rulebook-overlay"
    ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
    this.callbacks = {};
    this.sound = new SoundManager();
    this.audioButtons = [...document.querySelectorAll("[data-audio-toggle]")];
    this.musicVolumeInputs = [...document.querySelectorAll("[data-music-volume]")];
    this.sfxVolumeInputs = [...document.querySelectorAll("[data-sfx-volume]")];
    this.game = null;
    this.targetState = null;
    this.discardState = null;
    this.responseState = null;
    this.playEndState = null;
    this.privateRevealToken = 0;
    this.thinkingPlayerId = null;
    this.thinkingMessage = "正在思考";
    this.skillDetailsTrigger = null;
    this.aiSpeed = readAiSpeedPreference();
    this.logCollapsed = false;
    this.logFollowingBottom = true;
    this.horizontalCardDragRoot = null;
    this.horizontalCardDragState = null;
    this.horizontalCardDragSuppressClick = false;
    this.horizontalCardScrollGameId = null;
    this.animationController = new AnimationController((feedback) => this.playFeedbackSound(feedback));
    this.interactionController = new InteractionController(this);
    this.publicPoolView = new PublicPoolView(this.elements.public_pool_view, () => this.playSound("select"));
    this.privateRevealView = new PrivateRevealView(this.elements.private_reveal);
    this.judgmentView = new JudgmentView(this.elements.judgment_view);
    this.matchMvpResultView = new MatchMvpResultView(this.elements.match_mvp_result);
    this.historyArchiveView = new HistoryArchiveView(
      this.elements.history_archive_screen,
      historyStatsManager,
      () => this.hideHistoryArchive()
    );
    this.rulebookView = new RulebookView(
      this.elements.rulebook_overlay,
      this.elements.rules_button,
      () => this.playSound("select")
    );
    this.viewportWasNarrow = window.innerWidth < 1280;
    this.bindEvents();
    this.setAiSpeed(this.aiSpeed);
  }

  /*
  功能
  注册页面级用户意图回调。

  调用方
  main bootstrap。

  输入
  onStart/onRestart/onCard/onSkill 等回调集合。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  替换 callbacks。

  调用函数
  无。

  边界与不变量
  UI 事件只经这些回调进入 Application composition。
  */
  setCallbacks(callbacks) { this.callbacks = callbacks; }

  /*
  功能
  切换共享 UI 的当前对局所有权。

  调用方
  main 创建新对局、showGame。

  输入
  当前 MatchApplication 或 null。

  输出
  新的 game 绑定。

  读取状态
  旧 game 绑定。

  写入状态
  必要时取消旧交互并更新 this.game。

  调用函数
  cancelPendingInteractions。

  边界与不变量
  普通 render 不得改变绑定；更换实例前必须收束旧局 Promise。
  */
  attachGame(game) {
    const changed = this.game !== game;
    if (this.game && changed) this.cancelPendingInteractions();
    this.game = game ?? null;
    if (changed) this.matchMvpResultView?.reset();
    return this.game;
  }

  /*
  功能
  判断给定对局是否仍拥有共享 UI。

  调用方
  createGameSession proxy 与 render。

  输入
  待校验 MatchApplication。

  输出
  实例相同、未销毁且 gameId 一致时返回 true。

  读取状态
  this.game 与双方 state 生命周期字段。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  仅对象相同不足以证明会话有效，必须同时校验 disposed 和 gameId。
  */
  isGameAttached(game) {
    return Boolean(game && this.game === game && !game.state?.isDisposed &&
      game.state?.gameId && this.game.state.gameId === game.state.gameId);
  }

  /*
  功能
  为单局创建带所有权校验的 UI session 门面。

  调用方
  createGameApplication composition root。

  输入
  门面绑定的 MatchApplication。

  输出
  转发当前会话调用并拒绝旧会话写入的 Proxy。

  读取状态
  UIManager 当前 game 绑定与 CANCELLED_ASYNC_RESULTS。

  写入状态
  当前会话调用可写 UI；旧会话本身不写状态。

  调用函数
  isGameAttached、Reflect.get 与原 UIManager 方法。

  边界与不变量
  旧局异步请求必须得到确定取消结果；仅当前 owner 可执行 cancelPendingInteractions。
  */
  createGameSession(game) {
    const manager = this;
    return new Proxy(manager, {
      /*
      功能
      按会话所有权解析并包装 UIManager 属性访问。

      调用方
      createGameSession 返回的 Proxy 内部 [[Get]]。

      输入
      Proxy target 与属性键。

      输出
      原值、会话辅助能力或带 stale-session 拒绝的函数包装。

      读取状态
      manager.game、绑定 game 生命周期与取消结果表。

      写入状态
      仅有效包装函数可写 UI。

      调用函数
      Reflect.get、isGameAttached、Function.apply。

      边界与不变量
      stale session 不得调用同步 UI 写入；异步入口返回与既有契约同形的取消值。
      */
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

  /*
  功能
  绑定页面级输入事件并路由到 UI 状态或 Application callbacks。

  调用方
  UIManager 构造函数。

  输入
  无；使用已绑定 DOM 元素。

  输出
  无返回值。

  读取状态
  elements、audioButtons、musicVolumeInputs、sfxVolumeInputs 与当前交互状态。

  写入状态
  注册 DOM/window/document listeners。

  调用函数
  UIManager 交互方法、InteractionController.bind 与 callbacks。

  边界与不变量
  事件处理只提交公开 ID/意图；不得直接执行游戏规则或权威 mutation。
  */
  bindEvents() {
    this.updateAudioButtons();
    let audioInteractionUnlocked = false;
    /*
    功能
    在页面首次有效交互时解锁当前音频上下文。

    调用方
    bindEvents 注册的 pointerdown、keydown 与 click 监听。

    输入
    浏览器用户交互事件（事件内容不参与判断）。

    输出
    无返回值。

    读取状态
    audioInteractionUnlocked 与 SoundManager。

    写入状态
    首次调用标记解锁已提交，并异步请求 SoundManager.unlock。

    调用函数
    SoundManager.unlock。

    边界与不变量
    多种事件类型共享一次性标记；解锁不得依赖说明书或某个特定按钮。
    */
    const unlockAudioOnInteraction = () => {
      if (audioInteractionUnlocked) return;
      audioInteractionUnlocked = true;
      void this.sound.unlock();
    };
    for (const eventName of ["pointerdown", "keydown", "click"]) {
      document.addEventListener(eventName, unlockAudioOnInteraction, { capture: true, once: true });
    }
    for (const button of this.audioButtons) button.addEventListener("click", () => this.toggleAudio());
    for (const input of this.musicVolumeInputs) input.addEventListener("input", () => this.setMusicVolume(input.value));
    for (const input of this.sfxVolumeInputs) input.addEventListener("input", () => this.setSfxVolume(input.value));
    this.elements.start_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onStart?.(); });
    this.elements.history_button?.addEventListener("click", () => { this.playSound("select"); void this.showHistoryArchive(); });
    this.elements.back_to_start_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onBackToStart?.(); });
    this.elements.back_to_squad_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onBackToSquadSelection?.(); });
    this.elements.restart_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onRestart?.(); });
    this.elements.play_again_button.addEventListener("click", () => { this.playSound("select"); this.callbacks.onRestart?.(); });
    this.elements.squad_mode_grid.addEventListener("click", (event) => this.handleSquadModeClick(event));
    this.elements.candidate_grid.addEventListener("click", (event) => this.handleCharacterCandidateClick(event));
    this.bindHorizontalCardDrag(this.elements.game_screen);
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
    this.elements.log_list.addEventListener("scroll", () => this.handleLogScroll());
    window.addEventListener("resize", () => this.handleViewportResize());
    this.elements.ai_speed_control?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ai-speed]");
      if (!button) return;
      this.playSound("select");
      this.callbacks.onChangeAiSpeed?.(Number(button.dataset.aiSpeed));
    });
    this.elements.skill_details_overlay.addEventListener("click", (event) => {
      if (event.target === this.elements.skill_details_overlay || event.target.closest("[data-skill-dialog-close]")) this.hideSkillDetails();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") this.hideSkillDetails(); });
  }

  /*
  功能
  把一次有效编队方式卡牌点击路由为一次选择音效和一次 Application intent。

  调用方
  bindEvents 注册的 squad_mode_grid click listener。

  输入
  浏览器 click event。

  输出
  无返回值。

  读取状态
  点击目标、按钮可用状态与 callbacks。

  写入状态
  请求播放一次 cardSelect SFX，并提交一次公开编队 mode。

  调用函数
  playSound、callbacks.onSelectTeamAssignmentMode。

  边界与不变量
  非卡牌、disabled 或 aria-disabled 按钮不得播放或提交；一次事件至多触发一次。
  */
  handleSquadModeClick(event) {
    const button = event.target.closest("[data-team-assignment-mode]");
    if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") return;
    this.playSound("cardSelect");
    this.callbacks.onSelectTeamAssignmentMode?.(button.dataset.teamAssignmentMode);
  }

  /*
  功能
  把一次有效角色候选卡牌点击路由为一次选择音效和一次 Application intent。

  调用方
  bindEvents 注册的 candidate_grid click listener。

  输入
  浏览器 click event。

  输出
  无返回值。

  读取状态
  点击目标、按钮可用状态与 callbacks。

  写入状态
  请求播放一次 cardSelect SFX，并提交一次公开角色 ID。

  调用函数
  playSound、callbacks.onSelectCharacter。

  边界与不变量
  非卡牌、disabled 或 aria-disabled 按钮不得播放或提交；一次事件至多触发一次。
  */
  handleCharacterCandidateClick(event) {
    const button = event.target.closest("[data-character-id]");
    if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") return;
    this.playSound("cardSelect");
    this.callbacks.onSelectCharacter?.(button.dataset.characterId);
  }

  /*
  功能
  返回开始屏幕并清理上一局可见记录。

  调用方
  main bootstrap 的初始展示。

  输入
  无。

  输出
  无返回值。

  读取状态
  页面屏幕元素与 SoundManager。

  写入状态
  选择首页/说明书 BGM、清空日志并切换屏幕可见性。

  调用函数
  SoundManager.playMenuMusic、clearLog。

  边界与不变量
  只清理 UI，不销毁或创建 MatchApplication。
  */
  showStart() {
    this.sound.playMenuMusic();
    this.clearLog();
    this.elements.start_screen.classList.remove("is-hidden");
    this.elements.history_archive_screen?.classList.add("is-hidden");
    this.elements.squad_selection_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
  }

  /*
  功能
  经现有顶层屏幕生命周期进入独立历史档案馆并请求最新查询数据。

  调用方
  首页历史档案馆按钮。

  输入
  无。

  输出
  档案页面加载完成的 Promise。

  读取状态
  页面屏幕元素、SoundManager 与 HistoryArchiveView。

  写入状态
  仅切换顶层 screen 显隐并渲染档案页。

  调用函数
  SoundManager.playMenuMusic、HistoryArchiveView.show。

  边界与不变量
  不创建、销毁或修改 MatchApplication；从首页进入时战斗流程保持未启动。
  */
  async showHistoryArchive() {
    this.sound.playMenuMusic();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.squad_selection_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
    this.elements.history_archive_screen.classList.remove("is-hidden");
    await this.historyArchiveView.show();
  }

  /*
  功能
  离开历史档案馆并恢复主页面。

  调用方
  HistoryArchiveView 返回按钮 callback。

  输入
  无。

  输出
  无返回值。

  读取状态
  HistoryArchiveView。

  写入状态
  收束档案页并切换到首页。

  调用函数
  HistoryArchiveView.hide、showStart。

  边界与不变量
  返回不写历史数据，也不启动征召或对局。
  */
  hideHistoryArchive() {
    this.historyArchiveView.hide();
    this.showStart();
  }

  /*
  功能
  展示独立的编队方式选择界面。

  调用方
  main 的首次开始、重新征召与下一局 workflow。

  输入
  无。

  输出
  无返回值。

  读取状态
  页面屏幕元素与 SoundManager。

  写入状态
  选择选编队 BGM、清理旧交互/日志/选角 DOM 并仅显示编队方式屏幕。

  调用函数
  SoundManager.playSquadSelectionMusic、cancelPendingInteractions、resetCurrentCard、clearLog。

  边界与不变量
  只展示选择入口，不保存模式或解析阵营规模；隐藏的候选与编队预览不得残留上一轮内容。
  */
  showSquadSelection() {
    this.sound.playSquadSelectionMusic();
    this.cancelPendingInteractions();
    this.resetCurrentCard();
    this.clearLog();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.history_archive_screen?.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
    this.elements.squad_selection_screen.classList.remove("is-hidden");
    this.elements.game_over_overlay.classList.add("is-hidden");
    this.elements.team_preview.innerHTML = "";
    this.elements.candidate_grid.innerHTML = "";
  }

  /*
  功能
  展示当前编队方式的角色候选选择屏幕。

  调用方
  MatchWorkflow.startSelection 经 session UI。

  输入
  公开角色候选数组与 teamAssignmentMode。

  输出
  无返回值。

  读取状态
  候选 presentation 与页面屏幕元素。

  写入状态
  清理旧交互/日志/结算牌，写入模式上下文与候选 DOM。

  调用函数
  SoundManager.playSquadSelectionMusic、cancelPendingInteractions、candidateCardTemplate。

  边界与不变量
  只展示公开候选和已确认 mode；真人阵营尚未解析，不得提前启动阵营 BGM。
  */
  showSelection(candidates, teamAssignmentMode) {
    const presentation = TEAM_ASSIGNMENT_PRESENTATION[teamAssignmentMode];
    if (!presentation) throw new TypeError(`未知编队方式：${teamAssignmentMode}`);
    this.sound.playSquadSelectionMusic();
    this.cancelPendingInteractions();
    this.resetCurrentCard();
    this.clearLog();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.history_archive_screen?.classList.add("is-hidden");
    this.elements.squad_selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.remove("is-hidden");
    this.elements.game_over_overlay.classList.add("is-hidden");
    this.elements.selection_eyebrow.textContent = presentation.eyebrow;
    this.elements.selection_title.textContent = presentation.title;
    this.elements.selection_copy.textContent = presentation.copy;
    this.elements.team_preview.innerHTML = `<span>当前编队</span><strong>${presentation.preview}</strong><small>${presentation.detail}</small>`;
    this.elements.candidate_grid.innerHTML = candidates.map(candidateCardTemplate).join("");
  }

  /*
  功能
  绑定并展示已创建的对局主界面。

  调用方
  MatchWorkflow.confirmCharacter 经 session UI。

  输入
  当前 MatchApplication。

  输出
  无返回值。

  读取状态
  game.state 玩家角色与当前窗口宽度。

  写入状态
  停止准备阶段 BGM，更新 UI owner、主屏显隐、日志折叠与结算牌 DOM。

  调用函数
  SoundManager.stopMusic、attachGame、resetCurrentCard、clearLog、setLogCollapsed、render。

  边界与不变量
  仅全部角色已确认后执行首帧 render。
  */
  showGame(game) {
    this.sound.stopMusic();
    this.attachGame(game);
    this.resetCurrentCard();
    this.clearLog();
    this.elements.start_screen.classList.add("is-hidden");
    this.elements.history_archive_screen?.classList.add("is-hidden");
    this.elements.squad_selection_screen.classList.add("is-hidden");
    this.elements.selection_screen.classList.add("is-hidden");
    this.elements.game_screen.classList.remove("is-hidden");
    this.setLogCollapsed(window.innerWidth < 1280);
    this.viewportWasNarrow = window.innerWidth < 1280;
    if (game.state.players.length && game.state.players.every((player) => player.character)) this.render(game);
  }

  /*
  功能
  在视口跨入窄布局时自动折叠对局日志。

  调用方
  window resize listener。

  输入
  无。

  输出
  无返回值。

  读取状态
  window.innerWidth、viewportWasNarrow 与 game-screen 可见性。

  写入状态
  更新 viewportWasNarrow，必要时折叠日志。

  调用函数
  setLogCollapsed。

  边界与不变量
  只在从宽变窄且主界面可见时自动折叠，不覆盖同宽区间内用户选择。
  */
  handleViewportResize() {
    const isNarrow = window.innerWidth < 1280;
    if (isNarrow && !this.viewportWasNarrow && !this.elements.game_screen.classList.contains("is-hidden")) {
      this.setLogCollapsed(true);
    }
    this.viewportWasNarrow = isNarrow;
  }

  /*
  功能
  兼容 UI 调用生成单个角色候选模板。

  调用方
  UI 渲染测试与历史页面入口。

  输入
  角色定义与候选序号。

  输出
  候选卡 HTML。

  读取状态
  角色公开 presentation。

  写入状态
  无。

  调用函数
  candidateCardTemplate。

  边界与不变量
  不读取或修改对局状态。
  */
  candidateTemplate(character, index) { return candidateCardTemplate(character, index); }

  /*
  功能
  从当前公开对局状态重绘主战场界面。

  调用方
  Application presentation 调用及 UI 交互状态变更。

  输入
  当前 UI owner MatchApplication；缺省为 this.game。

  输出
  完成渲染返回 true；无效/未初始化会话返回 false。

  读取状态
  game.state 公开字段、ActionLegality 展示查询、UI 临时选择状态及当前卡牌区域 scrollLeft。

  写入状态
  更新状态指标、玩家面板、手牌、控件、动画 DOM 与本对局滚动上下文 ID。

  调用函数
  isGameAttached、playerPanelTemplate、createOpponentHandView、restoreHorizontalCardScroll、renderHand、renderControls、AnimationController.flush。

  边界与不变量
  对手未知手牌只能经脱敏 ViewModel；真人阵亡后不生成任何距离展示事实；
  同一 gameId 按玩家 ID 独立恢复位置，新对局不得继承旧位置。
  */
  render(game = this.game) {
    if (!this.isGameAttached(game) || !game.state.players.length || !game.state.players[0].character) return false;
    const state = game.state;
    const human = state.players[0];
    const preserveCardScroll = this.horizontalCardScrollGameId === state.gameId;
    const opponentHandScroll = new Map();
    if (preserveCardScroll) {
      for (const panel of this.elements.cpu_grid.querySelectorAll?.("[data-player-id]") ?? []) {
        const scroller = panel.querySelector?.(".opponent-hand-strip");
        if (scroller) opponentHandScroll.set(panel.dataset.playerId, scroller.scrollLeft);
      }
    }
    const dawnAlive = state.players.filter((player) => player.alive && player.battleTeam === "dawn").length;
    const duskAlive = state.players.filter((player) => player.alive && player.battleTeam === "dusk").length;
    const metrics = [
      ["轮次", `第 ${state.currentRound} 轮`, "round"], ["当前角色", game.currentPlayer?.name ?? "—", "active"],
      ["阶段", PHASE_PRESENTATION[state.phase] ?? state.phase, "phase"], ["阵营", `晨 ${dawnAlive} · 暮 ${duskAlive}`, "teams"],
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
      distanceInfo: human.alive ? ActionLegality.describeDistance(game, targetSource, player) : null,
      distanceState: human.alive ? this.getDistanceState(targetSource, player) : null,
      opponentHandSlots: createOpponentHandView(human, player)
    })).join("");
    for (const panel of this.elements.cpu_grid.querySelectorAll?.("[data-player-id]") ?? []) {
      if (!opponentHandScroll.has(panel.dataset.playerId)) continue;
      restoreHorizontalCardScroll(
        panel.querySelector?.(".opponent-hand-strip"), opponentHandScroll.get(panel.dataset.playerId)
      );
    }
    this.elements.human_panel.innerHTML = playerPanelTemplate(human, {
      ...targetOptions, isHuman: true, isCurrent: game.currentPlayer?.id === human.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(human.id)),
      isSelectedTarget: this.targetState?.selected?.id === human.id,
      isThinking: this.thinkingPlayerId === human.id,
      distanceInfo:human.alive && this.targetState && targetSource.id !== human.id ? ActionLegality.describeDistance(game, targetSource, human) : null,
      distanceState:human.alive && this.targetState && targetSource.id !== human.id ? this.getDistanceState(targetSource, human) : null
    });
    this.renderHand(game, human, { preserveScroll: preserveCardScroll });
    this.renderControls(game, human);
    this.animationController.flush(document);
    this.horizontalCardScrollGameId = state.gameId;
    return true;
  }

  /*
  功能
  生成单个玩家面板的兼容展示模板。

  调用方
  UI 渲染测试与历史局部渲染入口。

  输入
  待展示玩家、真人玩家与是否真人席位。

  输出
  玩家面板 HTML。

  读取状态
  当前 game、targetState、thinkingPlayerId 与合法手牌知识。

  写入状态
  无。

  调用函数
  playerPanelTemplate、createOpponentHandView。

  边界与不变量
  非真人手牌必须先转换为脱敏槽位，不得直接渲染实体牌。
  */
  playerTemplate(player, human, isHuman) {
    return playerPanelTemplate(player, {
      humanTeam: human.battleTeam, isHuman, isCurrent: this.game?.currentPlayer?.id === player.id,
      isLegalTarget: Boolean(this.targetState?.legalIds.has(player.id)), isTargeting: Boolean(this.targetState),
      isSelectedTarget: this.targetState?.selected?.id === player.id,
      isThinking: this.thinkingPlayerId === player.id,
      opponentHandSlots: isHuman ? null : createOpponentHandView(human, player)
    });
  }

  /*
  功能
  判断是否存在会阻塞普通真人操作的 UI/Application 交互。

  调用方
  renderHand、renderControls 与 UI 交互测试。

  输入
  无。

  输出
  任一目标、弃牌、响应、隐藏选择或 Application 锁存在时返回 true。

  读取状态
  targetState、discardState、responseState、InteractionController.pending 与 game.interactionLocked。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只聚合既有锁状态，不创建新的业务锁。
  */
  isInteractionActive() {
    return Boolean(this.targetState || this.discardState || this.responseState || this.interactionController?.pending || this.game?.interactionLocked);
  }

  /*
  功能
  生成目标面板的公开距离/阵营/突袭可达提示。

  调用方
  render。

  输入
  距离源玩家与目标玩家。

  输出
  中文距离状态文本。

  读取状态
  target.alive、双方阵营、targetState.card 与当前 game。

  写入状态
  无。

  调用函数
  ActionLegality.getDistance。

  边界与不变量
  提示只描述规则查询结果，不自行决定目标合法性。
  */
  getDistanceState(source, target) {
    if (!target.alive) return "已阵亡";
    const distance = ActionLegality.getDistance(this.game, source, target);
    if (target.battleTeam === source.battleTeam) return `距离 ${distance}`;
    const card = this.targetState?.meta?.card;
    if (card?.definitionId === "assault") return distance <= source.attackRange ? `距离 ${distance} · 可突袭` : `距离 ${distance} · 超出攻击范围`;
    return `距离 ${distance}`;
  }

  /*
  功能
  渲染真人手牌并按当前交互状态标记可用和选中状态。

  调用方
  render。

  输入
  当前 MatchApplication、真人 Player 与是否保留同一对局滚动位置。

  输出
  无返回值。

  读取状态
  human.hand、discardState、targetState 来源卡、交互锁、当前 scrollLeft 与 ActionLegality.canPlayCard。

  写入状态
  更新真人手牌和提示 DOM。

  调用函数
  isInteractionActive、ActionLegality.canPlayCard、handCardTemplate、restoreHorizontalCardScroll。

  边界与不变量
  牌的可用性必须来自合法性查询；目标选择期间来源牌持续保持选中，状态清空后同步取消；
  同一 gameId 才保留位置，新对局首帧从初始位置开始。
  */
  renderHand(game, human, { preserveScroll = true } = {}) {
    const inDiscard = Boolean(this.discardState);
    const blockedByInteraction = this.isInteractionActive();
    const hand = this.elements.human_hand;
    const previousScrollLeft = preserveScroll ? hand.scrollLeft : 0;
    hand.innerHTML = human.hand.map((card) => {
      const playable = ActionLegality.canPlayCard(game, human, card).ok;
      const selected = this.discardState?.selectedIds.has(card.id)
        || this.targetState?.meta?.card?.id === card.id;
      const disabled = !inDiscard && (!playable || blockedByInteraction || game.actionLocked);
      return handCardTemplate(card, { selected, disabled });
    }).join("") || '<div class="empty-hand"><span aria-hidden="true">◇</span><strong>手牌为空</strong><small>下一次摸牌会从牌堆飞入这里</small></div>';
    restoreHorizontalCardScroll(hand, previousScrollLeft);
    if (this.discardState) this.elements.hand_hint.textContent = `已选 ${this.discardState.selectedIds.size} / ${this.discardState.count}`;
    else if (!this.targetState) this.elements.hand_hint.textContent = `${human.hand.length}张手牌`;
  }

  /*
  功能
  按当前回合、交互锁和主动技能合法性刷新真人操作按钮。

  调用方
  render 在每次界面刷新时调用。

  输入
  game 为当前 MatchApplication；human 为真人 Player。

  输出
  无返回值。

  读取状态
  读取对局阶段、当前角色、结束状态、动作锁、真人存活状态与 UI 交互状态。

  写入状态
  只更新控制按钮的文字、禁用状态和显隐 class，不写游戏状态。

  调用函数
  isInteractionActive、getActiveSkill、canUseActiveSkill、skillButtonLabel、classList.toggle。

  边界与不变量
  Skill 定义保持纯数据；按钮合法性必须经 SkillRuntime 判断，不能调用定义对象上的运行时方法。
  */
  renderControls(game, human) {
    const humanPlay = game.currentPlayer?.id === human.id && game.state.phase === "play" && human.alive && !game.state.isGameOver;
    const interaction = this.isInteractionActive();
    const skill = getActiveSkill(human);
    const skillLegal = skill ? canUseActiveSkill(game, human, skill).ok : false;
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

  /*
  功能
  在稳定对局根节点上幂等注册横向卡牌容器的委托拖动事件。

  调用方
  bindEvents 与 UI 回归测试。

  输入
  包含全部静态及动态卡牌区域的 game-screen 根节点。

  输出
  首次绑定返回 true；同一根节点重复绑定返回 false。

  读取状态
  horizontalCardDragRoot。

  写入状态
  horizontalCardDragRoot 及 root/window 事件监听器。

  调用函数
  handleHorizontalCardPointerDown、handleHorizontalCardPointerMove、handleHorizontalCardPointerEnd、handleHorizontalCardClick、handleHorizontalCardNativeStart。

  边界与不变量
  事件委托必须覆盖动态 innerHTML；click 使用 capture 阶段以先于各选择 View 消费拖后误点。
  */
  bindHorizontalCardDrag(root) {
    if (this.horizontalCardDragRoot === root) return false;
    this.horizontalCardDragRoot = root;
    root.addEventListener("pointerdown", (event) => this.handleHorizontalCardPointerDown(event));
    root.addEventListener("pointermove", (event) => this.handleHorizontalCardPointerMove(event));
    root.addEventListener("click", (event) => this.handleHorizontalCardClick(event), true);
    root.addEventListener("selectstart", (event) => this.handleHorizontalCardNativeStart(event), true);
    root.addEventListener("dragstart", (event) => this.handleHorizontalCardNativeStart(event), true);
    window.addEventListener("pointerup", (event) => this.handleHorizontalCardPointerEnd(event));
    window.addEventListener("pointercancel", (event) => this.handleHorizontalCardPointerEnd(event));
    return true;
  }

  /*
  功能
  记录任一溢出横向卡牌容器的拖动起点。

  调用方
  game-screen 委托 pointerdown listener。

  输入
  主指针按下事件。

  输出
  无返回值。

  读取状态
  事件目标所属卡牌容器的滚动宽度、可视宽度与 scrollLeft。

  写入状态
  horizontalCardDragState、horizontalCardDragSuppressClick。

  调用函数
  Element.closest。

  边界与不变量
  只接受鼠标左键/主指针且仅在内容溢出时启动；阈值前不捕获指针，以保留卡牌原生 click 目标。
  */
  handleHorizontalCardPointerDown(event) {
    if (event.button !== 0) return;
    this.horizontalCardDragSuppressClick = false;
    const container = event.target.closest(HORIZONTAL_CARD_SCROLL_SELECTOR);
    if (!container || container.scrollWidth <= container.clientWidth) return;
    this.horizontalCardDragState = {
      container,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: container.scrollLeft,
      dragged: false
    };
  }

  /*
  功能
  把超过阈值的横向指针移动转换为当前卡牌容器滚动。

  调用方
  game-screen 委托 pointermove listener。

  输入
  当前指针移动事件。

  输出
  无返回值。

  读取状态
  horizontalCardDragState 的容器、指针、起始坐标与起始 scrollLeft。

  写入状态
  当前容器 scrollLeft、拖动 class、dragged 与 horizontalCardDragSuppressClick。

  调用函数
  Math.abs、setPointerCapture、preventDefault。

  边界与不变量
  小于等于 5px 的移动仍视为点击；向左拖增加 scrollLeft，且只有明确拖动后才捕获指针并抑制 click。
  */
  handleHorizontalCardPointerMove(event) {
    const state = this.horizontalCardDragState;
    if (!state || state.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - state.startX;
    if (!state.dragged && Math.abs(deltaX) <= CARD_DRAG_THRESHOLD_PX) return;
    if (!state.dragged) {
      state.dragged = true;
      this.horizontalCardDragSuppressClick = true;
      state.container.classList.add("is-dragging");
      state.container.setPointerCapture?.(event.pointerId);
    }
    state.container.scrollLeft = state.startScrollLeft - deltaX;
    event.preventDefault();
  }

  /*
  功能
  结束当前卡牌容器拖动并保留本次 click 抑制结论。

  调用方
  window pointerup/pointercancel listener。

  输入
  结束当前指针的事件。

  输出
  无返回值。

  读取状态
  horizontalCardDragState 及其容器。

  写入状态
  清空 horizontalCardDragState、移除拖动 class，并同步 horizontalCardDragSuppressClick。

  调用函数
  releasePointerCapture。

  边界与不变量
  只结束同一 pointerId；未超过阈值时不得抑制随后卡牌 click。
  */
  handleHorizontalCardPointerEnd(event) {
    const state = this.horizontalCardDragState;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.dragged) {
      state.container.classList.remove("is-dragging");
      if (!state.container.hasPointerCapture || state.container.hasPointerCapture(event.pointerId)) {
        state.container.releasePointerCapture?.(event.pointerId);
      }
    }
    this.horizontalCardDragSuppressClick = state.dragged;
    this.horizontalCardDragState = null;
  }

  /*
  功能
  在 capture 阶段消费明确拖动后产生的合成 click。

  调用方
  game-screen 委托 click capture listener。

  输入
  DOM click 事件。

  输出
  无返回值。

  读取状态
  horizontalCardDragSuppressClick 与事件目标所属卡牌容器。

  写入状态
  消费后清空 horizontalCardDragSuppressClick。

  调用函数
  Element.closest、preventDefault、stopPropagation。

  边界与不变量
  普通点击与非卡牌容器点击不得被拦截；拖动只抑制紧随其后的同类容器 click。
  */
  handleHorizontalCardClick(event) {
    if (!this.horizontalCardDragSuppressClick || !event.target.closest(HORIZONTAL_CARD_SCROLL_SELECTOR)) return;
    this.horizontalCardDragSuppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  /*
  功能
  阻止横向卡牌交互建立浏览器原生文字选区或拖放会话。

  调用方
  game-screen 委托 selectstart/dragstart capture listener。

  输入
  原生 selectstart 或 dragstart 事件。

  输出
  无返回值。

  读取状态
  horizontalCardDragState 与事件目标所属卡牌容器。

  写入状态
  无。

  调用函数
  Element.closest、preventDefault。

  边界与不变量
  潜在拖动从卡牌容器开始后，即使指针移到相邻面板也继续阻止选区；无卡牌交互时不得影响页面其他文本。
  */
  handleHorizontalCardNativeStart(event) {
    const withinScroller = event.target.closest?.(HORIZONTAL_CARD_SCROLL_SELECTOR);
    if (!withinScroller && !this.horizontalCardDragState) return;
    event.preventDefault();
  }

  /*
  功能
  处理真人手牌点击并路由为弃牌选择或出牌意图。

  调用方
  bindEvents 注册的 human_hand click listener。

  输入
  DOM 点击事件。

  输出
  无返回值。

  读取状态
  卡牌 data attribute、discardState 与按钮 disabled 标记。

  写入状态
  弃牌模式切换 selectedIds；普通模式只调用 onCard callback。

  调用函数
  toggleCardSelection、render、callbacks.onCard。

  边界与不变量
  普通模式不得提交禁用卡牌；拖后 click 由 game-screen capture 边界消费；只向 Application 提交公开 cardId。
  */
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

  /*
  功能
  处理玩家面板点击并路由为技能详情或目标选择。

  调用方
  bindEvents 注册的玩家区域 click/keydown listener。

  输入
  DOM 事件。

  输出
  无返回值。

  读取状态
  game.state.players、targetState 合法 ID 与选择元数据。

  写入状态
  更新 targetState.selected 或结算目标 Promise；也可展示技能详情。

  调用函数
  showSkillDetails、renderTargetConfirmation、render、playSound。

  边界与不变量
  目标必须来自本次 players 且 ID 在 legalIds；不在 UI 重算游戏规则。
  */
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

  /*
  功能
  展示指定角色的公开技能详情并管理焦点。

  调用方
  handlePlayerClick 与 UI 测试。

  输入
  已选将玩家与可选触发元素。

  输出
  成功展示返回 true；无角色返回 false。

  读取状态
  player.character 的公开定义。

  写入状态
  skillDetailsTrigger、overlay DOM、显隐与焦点。

  调用函数
  skillDetailsTemplate、DOM focus。

  边界与不变量
  只展示定义信息；关闭后应把焦点还给仍连接的触发元素。
  */
  showSkillDetails(player, trigger = null) {
    if (!player?.character) return false;
    this.skillDetailsTrigger = trigger;
    this.elements.skill_details_overlay.innerHTML = skillDetailsTemplate(player);
    this.elements.skill_details_overlay.classList.remove("is-hidden");
    this.elements.skill_details_overlay.querySelector("[data-skill-dialog-close]")?.focus();
    return true;
  }

  /*
  功能
  关闭技能详情并恢复触发元素焦点。

  调用方
  overlay 点击、Escape 键与 cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  skillDetailsTrigger 与 overlay。

  写入状态
  清空 overlay 和 trigger 引用。

  调用函数
  trigger.focus。

  边界与不变量
  触发元素已断开时不得尝试恢复焦点。
  */
  hideSkillDetails() {
    this.elements.skill_details_overlay.classList.add("is-hidden");
    this.elements.skill_details_overlay.innerHTML = "";
    const trigger = this.skillDetailsTrigger;
    this.skillDetailsTrigger = null;
    if (trigger?.focus && trigger.isConnected !== false) trigger.focus();
  }

  /*
  功能
  请求真人从已给定合法玩家集合中选择目标。

  调用方
  UiChoiceAdapter 与 InteractionController 多阶段流程。

  输入
  合法玩家实体数组、提示与仅用于展示/确认的元数据。

  输出
  解析为所选玩家实体或取消时 null 的 Promise。

  读取状态
  当前 UI owner 与玩家公开字段。

  写入状态
  建立 targetState、提示和目标高亮 DOM。

  调用函数
  cancelTarget、setPrompt、renderTargetConfirmation、render。

  边界与不变量
  空候选立即返回 null；UI 只能从传入 players 中按 ID 选择。
  */
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

  /*
  功能
  渲染需要二次确认的目标选择摘要。

  调用方
  requestTarget 与 handlePlayerClick。

  输入
  无；读取当前 targetState。

  输出
  无返回值。

  读取状态
  targetState 的 prompt、selected 与展示元数据。

  写入状态
  response_panel HTML 与可见类。

  调用函数
  escapeHtml。

  边界与不变量
  未开启 confirmSelection 时不渲染；所有动态文本必须转义。
  */
  renderTargetConfirmation() {
    if (!this.targetState?.meta?.confirmSelection) return;
    const selectedName = this.targetState.selected?.name ?? "尚未选择";
    this.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(this.targetState.meta.stepTitle ?? "选择目标")}</strong><span>${escapeHtml(selectedName)}</span></div><div class="response-copy"><p class="response-event">${escapeHtml(this.targetState.prompt)}</p></div><div class="response-actions"><button class="primary-button" type="button" data-target-confirm${this.targetState.selected ? "" : " disabled aria-disabled=\"true\""}>确认选择</button><button class="ghost-button" type="button" data-target-cancel>取消</button></div>`;
    this.elements.response_panel.classList.remove("is-hidden");
  }

  /*
  功能
  确认二次选择的目标并结束请求。

  调用方
  response_panel 的 target confirm 点击。

  输入
  无。

  输出
  无返回值。

  读取状态
  targetState.confirmSelection、selected 与 resolve。

  写入状态
  清空 targetState 和确认 DOM，结算请求并重绘。

  调用函数
  targetState.resolve、render。

  边界与不变量
  未选择合法目标时不得结算；状态先清空再调用 resolve 防止重入。
  */
  confirmTarget() {
    if (!this.targetState?.meta?.confirmSelection || !this.targetState.selected) return;
    const { resolve, selected } = this.targetState;
    this.targetState = null;
    this.elements.response_panel.classList.add("is-hidden");
    this.elements.response_panel.innerHTML = "";
    resolve(selected);
    if (this.game) this.render(this.game);
  }

  /*
  功能
  取消当前目标选择并以 null 结束请求。

  调用方
  新 requestTarget、取消按钮与 cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  targetState.resolve。

  写入状态
  清空 targetState 和确认 DOM并重绘。

  调用函数
  targetState.resolve、render。

  边界与不变量
  无请求时为 no-op；每个目标 Promise 只结算一次。
  */
  cancelTarget() {
    if (!this.targetState) return;
    const resolve = this.targetState.resolve;
    this.targetState = null;
    this.elements.response_panel.classList.add("is-hidden");
    this.elements.response_panel.innerHTML = "";
    resolve(null);
    if (this.game) this.render(this.game);
  }

  /*
  功能
  请求真人从自己手牌中精确选择指定数量的弃牌。

  调用方
  UiChoiceAdapter discard 请求。

  输入
  玩家实体、弃牌数量与公开提示。

  输出
  解析为所选 Card 实体数组的 Promise。

  读取状态
  player.hand。

  写入状态
  建立 discardState 并更新提示/手牌 DOM。

  调用函数
  setPrompt、render。

  边界与不变量
  只登记选择，不移动卡牌；实体重验和实际弃牌由 Application/Domain 完成。
  */
  requestDiscard(player, count, prompt) {
    return new Promise((resolve) => {
      this.discardState = { player, count, selectedIds: new Set(), resolve };
      this.setPrompt(prompt, `还需选择${count}张`);
      this.render(this.game);
    });
  }

  /*
  功能
  确认数量正确的弃牌选择并结束请求。

  调用方
  bindEvents 注册的弃牌确认按钮。

  输入
  无。

  输出
  无返回值。

  读取状态
  discardState 与 player 当前 hand。

  写入状态
  清空 discardState、结算 Promise 并重绘。

  调用函数
  Array.filter、discardState.resolve、render。

  边界与不变量
  数量不符时不得结算；返回实体必须仍在当前手牌中。
  */
  confirmDiscard() {
    if (!this.discardState || this.discardState.selectedIds.size !== this.discardState.count) return;
    const state = this.discardState;
    const cards = state.player.hand.filter((card) => state.selectedIds.has(card.id));
    this.discardState = null;
    state.resolve(cards);
    this.render(this.game);
  }

  /*
  功能
  展示真人响应窗口并等待使用、放弃、取消或可选超时。

  调用方
  UiChoiceAdapter response 请求。

  输入
  data-only response request 与按钮标签。

  输出
  解析为 response choice result 的 Promise。

  读取状态
  request presentation/timeout 与当前 responseState。

  写入状态
  替换 responseState、倒计时 timer 和响应面板 DOM。

  调用函数
  resolveResponse、renderResponseRequest、CleanupManager.delay、render。

  边界与不变量
  当前单机 null timeout 无限等待；新请求先取消旧请求，请求 ID 防止旧闭包结算新窗口。
  */
  requestResponse(request, label) {
    if (this.responseState) this.resolveResponse({ status:"cancelled" });
    return new Promise((resolve) => {
      // null 是当前单机模式的无限等待；正有限值保留未来限时模式的原倒计时与 fallback。
      const timeoutEnabled = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0;
      const deadline = timeoutEnabled ? Date.now() + request.timeoutMs : null;
      /*
      功能
      以一次响应选择收束当前同 ID 的 UI 窗口。

      调用方
      resolveResponse 与 requestResponse 超时路径。

      输入
      布尔决定或结构化 response result。

      输出
      无返回值。

      读取状态
      responseState.request.id、interval 与当前 game。

      写入状态
      清理 timer、responseState 和响应面板并结算外层 Promise。

      调用函数
      window.clearInterval、resolve、render。

      边界与不变量
      只结算创建本闭包的 request.id；布尔兼容值转换为既有 status 形状。
      */
      const settle = (choice) => {
        if (!this.responseState || this.responseState.request.id !== request.id) return;
        if (this.responseState.interval !== null) window.clearInterval(this.responseState.interval);
        this.responseState = null;
        this.elements.response_panel.classList.add("is-hidden");
        this.elements.response_panel.innerHTML = "";
        resolve(typeof choice === "object" ? choice : { status:choice ? "used" : "declined" });
        if (this.game) this.render(this.game);
      };
      /*
      功能
      刷新有限响应窗口的倒计时文本。

      调用方
      requestResponse 初次展示与 200ms interval。

      输入
      无；闭包捕获 deadline。

      输出
      无返回值。

      读取状态
      当前时间与 response_panel countdown 元素。

      写入状态
      countdown 文本。

      调用函数
      Date.now、Math.ceil。

      边界与不变量
      显示值不得小于零；无限等待模式不创建该 interval。
      */
      const update = () => {
        const node = this.elements.response_panel.querySelector(".countdown");
        if (node) node.textContent = `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s`;
      };
      const interval = timeoutEnabled ? window.setInterval(update, 200) : null;
      this.responseState = { request, resolve: settle, interval, deadline, label, selectedCardIds:new Set() };
      UIManager.prototype.renderResponseRequest.call(this);
      this.elements.response_panel.classList.remove("is-hidden");
      if (timeoutEnabled) {
        this.game.cleanupManager.delay(request.timeoutMs).then((completed) => {
          if (completed) settle({ status:"declined" });
        });
        update();
      }
      this.render(this.game);
    });
  }

  /*
  功能
  从当前 responseState 渲染公开响应说明和可用按钮。

  调用方
  requestResponse 与 toggleResponseCard。

  输入
  无。

  输出
  无返回值。

  读取状态
  responseState.request、presentation、label 与 deadline。

  写入状态
  response_panel HTML。

  调用函数
  canSubmitResponse、renderResponseEvent、escapeHtml。

  边界与不变量
  只渲染 data-only presentation；不足 requiredCount 时使用按钮必须禁用。
  */
  renderResponseRequest() {
    const state = this.responseState;
    if (!state) return;
    const { request, label } = state;
    const presentation = request.presentation ?? {};
    const canUse = canSubmitResponse(request);
    const eventText = presentation.eventText ?? "当前有一项行动等待你的响应。";
    const responseText = presentation.responseText ?? "你可以改变即将发生的结算。";
    const availabilityText = presentation.availabilityText ?? "";
    const countdown = Number.isFinite(state.deadline)
      ? `<span class="countdown">${Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))}s</span>`
      : "";
    this.elements.response_panel.innerHTML = `<div class="response-title"><strong>响应窗口</strong>${countdown}</div><div class="response-copy"><p class="response-event">${renderResponseEvent(presentation, eventText)}</p><p class="response-requirement">${escapeHtml(responseText)}</p>${availabilityText ? `<p class="response-availability ${canUse ? "is-ready" : "is-insufficient"}">${escapeHtml(availabilityText)}</p>` : ""}</div><div class="response-actions"><button class="primary-button" data-response-choice="use"${canUse ? "" : ' disabled aria-disabled="true"'}>${escapeHtml(presentation.buttonLabel ?? label)}</button><button class="ghost-button" data-response-choice="decline">${escapeHtml(presentation.declineLabel ?? "放弃响应")}</button></div>`;
  }

  /*
  功能
  切换借势响应中显式选择的一张合法突袭牌 ID。

  调用方
  response_panel 的响应牌点击处理。

  输入
  被点击 cardId。

  输出
  无返回值。

  读取状态
  responseState request type 与 legalCardIds。

  写入状态
  更新 selectedCardIds 并重绘响应面板。

  调用函数
  toggleCardSelection、renderResponseRequest。

  边界与不变量
  只接受 leverageAssault 请求中列出的公开合法 ID，选择上限为一。
  */
  toggleResponseCard(cardId) {
    const state = this.responseState;
    if (!state || state.request.type !== "leverageAssault" || !state.request.legalCardIds.includes(cardId)) return;
    state.selectedCardIds = toggleCardSelection(state.selectedCardIds, cardId, 1);
    UIManager.prototype.renderResponseRequest.call(this);
  }

  /*
  功能
  结束当前响应窗口并把实体选择 ID 交还 Choice adapter。

  调用方
  响应窗口使用/放弃按钮与 cancelPendingInteractions。

  输入
  布尔使用决定，或 cancelled 等既有响应结果对象。

  输出
  无返回值。

  读取状态
  this.responseState 中的 request、selectedCardIds 与 resolve callback。

  写入状态
  通过 responseState.resolve 结束当前 UI 响应 Promise。

  调用函数
  responseState.resolve。

  边界与不变量
  借势返回显式勾选 ID；普通响应按当前请求顺序返回 requiredCount 个合法 ID，不接触 Card entity。
  */
  resolveResponse(choice) {
    const responseState = this.responseState;
    const selectedIds = responseState?.request.type === "leverageAssault"
      ? [...responseState.selectedCardIds]
      : (responseState?.request.legalCardIds ?? []).slice(0, responseState?.request.requiredCount ?? 0);
    const result = typeof choice === "object"
      ? choice
      : { status:choice ? "used" : "declined", selectedIds:choice ? selectedIds : [] };
    this.responseState?.resolve(result);
  }
  /*
  功能
  转发卡牌公开多阶段意图请求。

  调用方
  ActionWorkflow 经 session UI。

  输入
  InteractionController.requestCardFlow 的参数。

  输出
  公开卡牌意图或取消结果的 Promise。

  读取状态
  interactionController。

  写入状态
  由 InteractionController 管理临时 UI 交互。

  调用函数
  InteractionController.requestCardFlow。

  边界与不变量
  只转发公开选择阶段；隐藏选择由 ChoicePort 后续请求。
  */
  requestCardFlow(...args) { return this.interactionController.requestCardFlow(...args); }
  /*
  功能
  转发真人隐藏 token 选择请求。

  调用方
  UiChoiceAdapter。

  输入
  InteractionController.requestHiddenCards 的参数。

  输出
  token 数组或取消结果的 Promise。

  读取状态
  interactionController。

  写入状态
  由 InteractionController 管理 pending 和 DOM。

  调用函数
  InteractionController.requestHiddenCards。

  边界与不变量
  UIManager 不解析 token，也不接收未知牌定义。
  */
  requestHiddenCards(...args) { return this.interactionController.requestHiddenCards(...args); }
  /*
  功能
  转发真人隐藏手牌/公开装备区域选择请求。

  调用方
  UiChoiceAdapter。

  输入
  InteractionController.requestZoneCard 的参数。

  输出
  区域选择或取消结果的 Promise。

  读取状态
  interactionController。

  写入状态
  由 InteractionController 管理临时 selection 和 DOM。

  调用函数
  InteractionController.requestZoneCard。

  边界与不变量
  返回值只含区域、opaque token 或公开装备 ID。
  */
  requestZoneCard(...args) { return this.interactionController.requestZoneCard(...args); }
  /*
  功能
  等待真人显式结束当前出牌阶段。

  调用方
  TurnWorkflow 真人回合入口。

  输入
  当前 gameId。

  输出
  结束按钮解析 true、清理解析 false 的 Promise。

  读取状态
  当前 UI owner。

  写入状态
  建立 playEndState 并重绘控件。

  调用函数
  render。

  边界与不变量
  gameId 绑定本次等待，旧会话按钮不能结束新局回合。
  */
  waitForHumanPlayEnd(gameId) { return new Promise((resolve) => { this.playEndState = { gameId, resolve }; this.render(this.game); }); }

  /*
  功能
  以当前 gameId 结束真人出牌阶段等待。

  调用方
  main onEndPlay callback。

  输入
  触发结束的 gameId。

  输出
  无返回值。

  读取状态
  playEndState.gameId 与 resolve。

  写入状态
  清空 playEndState、结算 true 并重绘。

  调用函数
  playEndState.resolve、render。

  边界与不变量
  ID 不匹配时不得结算当前等待。
  */
  resolveHumanPlayEnd(gameId) {
    if (!this.playEndState || this.playEndState.gameId !== gameId) return;
    const resolve = this.playEndState.resolve;
    this.playEndState = null;
    resolve(true);
    this.render(this.game);
  }

  /*
  功能
  更新行动提示和可选手牌辅助提示。

  调用方
  Application presentation、requestTarget/requestDiscard 与 setThinking。

  输入
  主提示文本与可选 handHint。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  action_prompt 和必要时 hand_hint 文本。

  调用函数
  DOM textContent。

  边界与不变量
  空 handHint 保留当前手牌提示，不写 innerHTML。
  */
  setPrompt(message, handHint = "") {
    this.elements.action_prompt.textContent = message;
    if (handHint) this.elements.hand_hint.textContent = handHint;
  }

  /*
  功能
  切换 AI 思考指示并同步行动提示可见性。

  调用方
  TurnWorkflow 经 PresentationPort。

  输入
  是否思考、玩家实体或名称，以及公开思考摘要。

  输出
  无返回值。

  读取状态
  game.state.players 与当前主界面状态。

  写入状态
  thinkingPlayerId/message、指示器和 action_prompt DOM。

  调用函数
  thinkingTemplate、render。

  边界与不变量
  思考摘要只展示已由 Application 公开的信息，不暴露搜索状态或隐藏牌。
  */
  setThinking(isThinking, playerOrName = "电脑角色", message = "正在思考") {
    const player = typeof playerOrName === "object" ? playerOrName : this.game?.state.players.find((entry) => entry.name === playerOrName);
    this.thinkingPlayerId = isThinking ? player?.id ?? null : null;
    this.thinkingMessage = message;
    this.elements.thinking_indicator.classList.toggle("is-hidden", !isThinking);
    // 思考指示已经包含完整行动和目标，避免下方 action-prompt 重复显示同一信息。
    this.elements.action_prompt.classList.toggle("is-hidden", isThinking);
    if (isThinking) this.elements.thinking_indicator.innerHTML = thinkingTemplate(player, message);
    if (this.game?.state.players[0]?.character) this.render(this.game);
  }

  /*
  功能
  在中央结算区展示当前卡牌或技能及公开目标。

  调用方
  ActionPresentation 经 PresentationPort。

  输入
  牌实体或技能名、来源、目标标签与可选结构化目标。

  输出
  无返回值。

  读取状态
  传入公开 presentation 数据。

  写入状态
  current_card HTML 与进入动画 class。

  调用函数
  resolvingCardTemplate。

  边界与不变量
  只展示已进入结算流程的公开事实；重启动画不改变结算时序。
  */
  setCurrentCard(cardOrName, source, targetLabel = "", displayTargets = null) {
    this.elements.current_card.innerHTML = resolvingCardTemplate(
      cardOrName, source, targetLabel, displayTargets
    );
    this.elements.current_card.classList.remove("is-entering");
    void this.elements.current_card.offsetWidth;
    this.elements.current_card.classList.add("is-entering");
  }

  /*
  功能
  将中央结算区恢复为空闲占位。

  调用方
  showSelection、showGame 与 ActionPresentation 清理。

  输入
  无。

  输出
  无返回值。

  读取状态
  current_card 元素。

  写入状态
  清除进入 class 并替换为空模板。

  调用函数
  emptyResolvingCardTemplate。

  边界与不变量
  只清理展示，不移动 resolving zone 卡牌。
  */
  resetCurrentCard() {
    this.elements.current_card.classList.remove("is-entering");
    this.elements.current_card.innerHTML = emptyResolvingCardTemplate();
  }

  /*
  功能
  展示私密情报并在有牌时等待真人关闭。

  调用方
  GamePresentationAdapter.showPrivateReveal。

  输入
  标题与仅真人可见的牌实体数组。

  输出
  PrivateRevealView 的等待结果。

  读取状态
  privateRevealView 与当前 game.cleanupManager。

  写入状态
  私密展示 DOM；无牌提示登记 3.2 秒自动隐藏。

  调用函数
  PrivateRevealView.show/hide、CleanupManager.delay。

  边界与不变量
  无牌提示不阻塞 workflow；有牌时必须由关闭或清理收束。
  */
  showPrivateReveal(title, cards = []) {
    const shown = this.privateRevealView.show(title, cards);
    if (!cards.length) this.game?.cleanupManager.delay(3200).then((completed) => {
      if (completed && !this.privateRevealView.pending) this.privateRevealView.hide();
    });
    return shown;
  }
  /*
  功能
  展示只读公开牌池。

  调用方
  GamePresentationAdapter.showPublicPool。

  输入
  当前公开牌数组。

  输出
  无返回值。

  读取状态
  publicPoolView。

  写入状态
  公开牌池 DOM。

  调用函数
  PublicPoolView.show。

  边界与不变量
  不创建选择 Promise，不移动牌实体。
  */
  showPublicPool(cards) { this.publicPoolView.show(cards); }
  /*
  功能
  请求真人从公开牌池确认一张牌。

  调用方
  UiChoiceAdapter publicCard 请求。

  输入
  当前玩家与公开牌数组。

  输出
  所选牌实体或取消结果的 Promise。

  读取状态
  publicPoolView。

  写入状态
  由 PublicPoolView 管理 pending 和 DOM。

  调用函数
  PublicPoolView.request。

  边界与不变量
  选择结果必须来自传入公开数组。
  */
  requestPublicCard(player, cards) { return this.publicPoolView.request(player, cards); }
  /*
  功能
  隐藏只读公开牌池展示。

  调用方
  GamePresentationAdapter.hidePublicPool。

  输入
  无。

  输出
  无返回值。

  读取状态
  publicPoolView。

  写入状态
  清空公开牌池 DOM。

  调用函数
  PublicPoolView.hide。

  边界与不变量
  不应替代 cancel 收束活跃选择 Promise。
  */
  hidePublicPool() { this.publicPoolView.hide(); }
  /*
  功能
  展示公开判定牌。

  调用方
  GamePresentationAdapter.showJudgment。

  输入
  判定玩家、公开牌与展示上下文。

  输出
  无返回值。

  读取状态
  judgmentView。

  写入状态
  判定视图 DOM。

  调用函数
  JudgmentView.show。

  边界与不变量
  不计算判定或移动牌。
  */
  showJudgment(player, card, context = {}) { this.judgmentView.show(player, card, context); }
  /*
  功能
  清空公共判定视图。

  调用方
  GamePresentationAdapter.hideJudgment 与清理流程。

  输入
  无。

  输出
  无返回值。

  读取状态
  judgmentView。

  写入状态
  清空判定 DOM。

  调用函数
  JudgmentView.hide。

  边界与不变量
  不影响判定 workflow 状态。
  */
  hideJudgment() { this.judgmentView.hide(); }
  /*
  功能
  展示公开濒死状态和所需恢复量。

  调用方
  GamePresentationAdapter.showDying。

  输入
  濒死目标与公开 hp/need 上下文。

  输出
  无返回值。

  读取状态
  target.name 与 context。

  写入状态
  dying_view HTML 与可见类。

  调用函数
  escapeHtml。

  边界与不变量
  只展示已公开结算状态，不决定救援顺序。
  */
  showDying(target, context) {
    this.elements.dying_view.innerHTML = `<strong>${escapeHtml(target.name)}濒死</strong><span>当前生命 ${context.currentHp}</span><b>还需恢复${context.need}点生命</b>`;
    this.elements.dying_view.classList.remove("is-hidden");
  }
  /*
  功能
  清空濒死展示。

  调用方
  GamePresentationAdapter.hideDying 与清理流程。

  输入
  无。

  输出
  无返回值。

  读取状态
  dying_view。

  写入状态
  隐藏并清空 dying_view。

  调用函数
  DOM classList。

  边界与不变量
  不修改目标 alive/hp 状态。
  */
  hideDying() { this.elements.dying_view.classList.add("is-hidden"); this.elements.dying_view.innerHTML = ""; }
  /*
  功能
  展示当前决斗出牌方与对手。

  调用方
  GamePresentationAdapter.showDuel。

  输入
  当前响应者与决斗对手。

  输出
  无返回值。

  读取状态
  双方公开名称。

  写入状态
  duel_view HTML 与可见类。

  调用函数
  escapeHtml。

  边界与不变量
  不决定响应顺序或是否有突袭牌。
  */
  showDuel(current, opponent) { this.elements.duel_view.innerHTML = `<strong>决斗</strong><span>${escapeHtml(current.name)}需打出突袭</span><small>对手：${escapeHtml(opponent.name)}</small>`; this.elements.duel_view.classList.remove("is-hidden"); }
  /*
  功能
  清空决斗展示。

  调用方
  GamePresentationAdapter.hideDuel 与清理流程。

  输入
  无。

  输出
  无返回值。

  读取状态
  duel_view。

  写入状态
  隐藏并清空 duel_view。

  调用函数
  DOM classList。

  边界与不变量
  不结束或取消 response workflow。
  */
  hideDuel() { this.elements.duel_view.classList.add("is-hidden"); this.elements.duel_view.innerHTML = ""; }

  /*
  功能
  把一条结构化公开日志追加到可滚动列表。

  调用方
  MatchLogAdapter.add。

  输入
  已公开日志 entry 与当前日志总数。

  输出
  无返回值。

  读取状态
  entry.kind/fragments、log_list 与滚动事件维护的 logFollowingBottom。

  写入状态
  追加日志 DOM、更新计数；跟随模式下只写最大 scrollTop 请求。

  调用函数
  formatLogEntry、updateLogCount。

  边界与不变量
  动态内容必须经结构化日志格式器转义；不得在 append 后读取 scrollHeight 强制同步 layout；
  用户上滚后的阅读位置由浏览器保持，只有滚动事件确认跟随时才请求滚到底部；不得写入 AI 私密信息。
  */
  appendLog(entry, count) {
    const list = this.elements.log_list;
    const node = document.createElement("div");
    node.className = `log-entry ${entry.kind === "normal" ? "" : `is-${entry.kind}`}`;
    node.innerHTML = formatLogEntry(entry);
    list.append(node);
    this.updateLogCount(count);
    if (this.logFollowingBottom !== false) list.scrollTop = Number.MAX_SAFE_INTEGER;
  }

  /*
  功能
  把可见日志裁回 Action 开始时的尾部边界并同步计数。

  调用方
  ActionTransaction 经 composition 注入的日志展示恢复回调。

  输入
  rollback 后 state.logs 的日志数量。

  输出
  无返回值。

  读取状态
  log_list 当前尾部节点数量。

  写入状态
  仅删除超出边界的日志尾部 DOM 节点，并更新 log_count。

  调用函数
  DOM removeChild、updateLogCount。

  边界与不变量
  不重建或替换边界内节点，历史日志的内容、顺序和 DOM 对象身份保持不变。
  */
  restoreLogBoundary(count) {
    const list = this.elements.log_list;
    while (list.children.length > count) list.removeChild(list.lastElementChild);
    this.updateLogCount(count);
  }

  /*
  功能
  在用户滚动日志时更新后续追加是否继续跟随底部。

  调用方
  bindEvents 注册的 log_list scroll listener。

  输入
  无。

  输出
  无返回值。

  读取状态
  log_list 当前 scrollHeight、scrollTop 与 clientHeight。

  写入状态
  logFollowingBottom。

  调用函数
  无。

  边界与不变量
  layout 读取只发生在滚动事件边界，不得回到每条日志 append 的热路径。
  */
  handleLogScroll() {
    const list = this.elements.log_list;
    this.logFollowingBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      <= LOG_BOTTOM_TOLERANCE_PX;
  }

  /*
  功能
  清空可见对局日志并重置计数。

  调用方
  showStart、showSelection、showGame。

  输入
  无。

  输出
  无返回值。

  读取状态
  log_list。

  写入状态
  清空日志 DOM、滚动位置与计数展示。

  调用函数
  updateLogCount。

  边界与不变量
  只清理 DOM，不修改 state.logs 的权威记录。
  */
  clearLog() {
    this.elements.log_list.innerHTML = "";
    this.elements.log_list.scrollTop = 0;
    this.logFollowingBottom = true;
    this.updateLogCount(0);
  }

  /*
  功能
  规范化并同步公开日志数量的文本和无障碍标签。

  调用方
  appendLog、clearLog。

  输入
  候选日志数量。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  log_count 的 textContent、title 与 aria-label。

  调用函数
  Number、Math.trunc、Math.max。

  边界与不变量
  非有限或负数显示为零，不改变真实日志集合。
  */
  updateLogCount(count) {
    const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
    const label = `${safeCount} 条`;
    this.elements.log_count.textContent = label;
    this.elements.log_count.title = `共 ${safeCount} 条对局记录`;
    this.elements.log_count.setAttribute("aria-label", `共 ${safeCount} 条对局记录`);
  }

  /*
  功能
  非阻塞请求播放命名音效。

  调用方
  UI 事件与展示反馈入口。

  输入
  SoundManager 支持的音效名称。

  输出
  无返回值。

  读取状态
  sound。

  写入状态
  由 SoundManager 管理音频节点与节流状态。

  调用函数
  SoundManager.play。

  边界与不变量
  音频失败不得阻塞 UI 或游戏 workflow。
  */
  playSound(name) { void this.sound.play(name); }

  /*
  功能
  从同一公开判中事件同时启动雷击声音和人物框电弧。

  调用方
  GamePresentationAdapter.playLightningHit。

  输入
  被命中的公开玩家 ID。

  输出
  无返回值。

  读取状态
  sound 与 animationController。

  写入状态
  创建雷击音频节点和闪电动画生命周期。

  调用函数
  playSound、AnimationController.startLightning。

  边界与不变量
  声音与视觉从同一入口触发；反馈不得改变判定或伤害状态。
  */
  playLightningHit(playerId) {
    this.playSound("lightning");
    this.animationController.startLightning(playerId, globalThis.document);
  }

  /*
  功能
  启动雷达战术判定成功的绿色扫描反馈。

  调用方
  GamePresentationAdapter.showRadarSuccess。

  输入
  被判定玩家的公开 ID。

  输出
  无返回值。

  读取状态
  sound、animationController 与当前文档。

  写入状态
  通过 SoundManager 创建一次成功音效，并创建或替换该玩家的雷达成功 overlay。

  调用函数
  playSound、AnimationController.startRadarSuccess。

  边界与不变量
  UI 只负责展示已经由 Application 判定 workflow 确认的成功语义，不解析牌名或日志。
  */
  playRadarSuccess(playerId) {
    this.playSound("radarSuccess");
    this.animationController.startRadarSuccess(playerId, globalThis.document);
  }

  /*
  功能
  选择或停止当前阵营 BGM。

  调用方
  GamePresentationAdapter.setMusicTeam 与选将界面。

  输入
  阵营 ID。

  输出
  无返回值。

  读取状态
  sound。

  写入状态
  由 SoundManager 更新 BGM 调度状态。

  调用函数
  SoundManager.setMusicTeam。

  边界与不变量
  UI 不解释阵营音乐 profile。
  */
  setMusicTeam(team) { this.sound.setMusicTeam(team); }

  /*
  功能
  切换声音开关并刷新全部音频控件。

  调用方
  bindEvents 的音频按钮 listener。

  输入
  无。

  输出
  切换完成的 Promise。

  读取状态
  sound.enabled。

  写入状态
  SoundManager 开关与音频按钮 DOM。

  调用函数
  SoundManager.setEnabled、updateAudioButtons。

  边界与不变量
  必须等待浏览器音频解锁/切换后再同步按钮状态。
  */
  async toggleAudio() {
    await this.sound.setEnabled(!this.sound.enabled);
    this.updateAudioButtons();
  }

  /*
  功能
  同步声音开关和音乐音量控件的可见/无障碍状态。

  调用方
  bindEvents 初始化、toggleAudio、setMusicVolume。

  输入
  无。

  输出
  无返回值。

  读取状态
  sound.enabled、sound.musicVolume、sound.sfxVolume 与控件集合。

  写入状态
  音频按钮属性/标签及音量输入值。

  调用函数
  DOM attribute API。

  边界与不变量
  百分比只用于展示，不反向修改 SoundManager。
  */
  updateAudioButtons() {
    for (const button of this.audioButtons) {
      button.setAttribute("aria-pressed", String(this.sound.enabled));
      button.setAttribute("aria-label", this.sound.enabled ? "关闭声音" : "开启声音");
      const label = button.querySelector("span");
      if (label) label.textContent = this.sound.enabled ? "声音：开" : "声音：关";
    }
    const musicPercentage = String(Math.round(this.sound.musicVolume * 100));
    for (const input of this.musicVolumeInputs) {
      input.value = musicPercentage;
      input.setAttribute("aria-valuetext", `${musicPercentage}%`);
    }
    const sfxPercentage = String(Math.round(this.sound.sfxVolume * 100));
    for (const input of this.sfxVolumeInputs) {
      input.value = sfxPercentage;
      input.setAttribute("aria-valuetext", `${sfxPercentage}%`);
    }
  }

  /*
  功能
  将百分比输入转换为 SoundManager 音量并刷新控件。

  调用方
  bindEvents 的音乐音量 input listener。

  输入
  0 至 100 的控件值。

  输出
  无返回值。

  读取状态
  sound。

  写入状态
  SoundManager.musicVolume 与控件 DOM。

  调用函数
  SoundManager.setMusicVolume、updateAudioButtons。

  边界与不变量
  UI 百分比必须除以 100 后交给归一化音量边界。
  */
  setMusicVolume(value) {
    this.sound.setMusicVolume(Number(value) / 100);
    this.updateAudioButtons();
  }

  /*
  功能
  将百分比输入转换为 SoundManager 音效总音量并刷新控件。

  调用方
  bindEvents 的音效音量 input listener。

  输入
  0 至 100 的控件值。

  输出
  无返回值。

  读取状态
  sound。

  写入状态
  SoundManager.sfxVolume 与控件 DOM。

  调用函数
  SoundManager.setSfxVolume、updateAudioButtons。

  边界与不变量
  UI 百分比必须除以 100 后交给归一化音量边界。
  */
  setSfxVolume(value) {
    this.sound.setSfxVolume(Number(value) / 100);
    this.updateAudioButtons();
  }

  /*
  功能
  在一项公开 feedback 实际开始展示时播放其对应通用音效。

  调用方
  AnimationController 的 onFeedbackPresented 回调。

  输入
  已开始展示的 data-only feedback。

  输出
  无返回值。

  读取状态
  FEEDBACK_SOUND_BY_TYPE。

  写入状态
  由 SoundManager 管理音频节点与节流状态。

  调用函数
  playSound。

  边界与不变量
  每项实际展示至多触发一次声音；无对应声音的 feedback 保持静音。
  */
  playFeedbackSound(feedback) {
    const soundName = FEEDBACK_SOUND_BY_TYPE[feedback?.type];
    if (soundName) this.playSound(soundName);
  }

  /*
  功能
  排队公开视觉反馈，等待 AnimationController 在实际展示时同步触发音效。

  调用方
  GamePresentationAdapter.queueFeedback。

  输入
  反馈类型、可选玩家 ID、数值与 presentation 视觉变体。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  AnimationController.pending。

  调用函数
  AnimationController.queue。

  边界与不变量
  只消费公开 primitive；入队不得提前播放或重复播放声音，反馈与声音不能改变真实结算顺序。
  */
  queueFeedback(type, playerId = null, amount = null, variant = null) {
    this.animationController.queue(type, playerId, amount, variant);
  }

  /*
  功能
  更新 AI 可观察思考速度档位。

  调用方
  main onChangeAiSpeed callback。

  输入
  速度值；只允许 1、2、3。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  aiSpeed、速度按钮的 aria-pressed 状态与持久化偏好。

  调用函数
  normalizeAiSpeed、writeAiSpeedPreference 与 DOM attribute API。

  边界与不变量
  只更新用户选择的时间窗口档位；Application 在后续 decision 采样窗口，UI 不持有 Searcher budget、搜索结果或规则。
  */
  setAiSpeed(speed) {
    this.aiSpeed = writeAiSpeedPreference(normalizeAiSpeed(speed));
    for (const button of this.elements.ai_speed_control?.querySelectorAll("[data-ai-speed]") ?? []) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.aiSpeed) === this.aiSpeed));
    }
    return this.aiSpeed;
  }

  /*
  功能
  切换对局日志面板折叠状态。

  调用方
  日志按钮、showGame 与 handleViewportResize。

  输入
  是否折叠。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  logCollapsed、布局 class 与按钮无障碍属性。

  调用函数
  DOM classList/attribute API。

  边界与不变量
  只改变布局展示，不清除日志内容。
  */
  setLogCollapsed(collapsed) {
    this.logCollapsed = Boolean(collapsed);
    this.elements.log_panel.classList.toggle("is-collapsed", this.logCollapsed);
    this.elements.battle_layout.classList.toggle("log-collapsed", this.logCollapsed);
    this.elements.log_toggle_button.setAttribute("aria-expanded", String(!this.logCollapsed));
    this.elements.log_toggle_button.setAttribute("aria-label", this.logCollapsed ? "展开对局记录" : "折叠对局记录");
  }

  /*
  功能
  将 immutable MatchResultViewModel 交给独立 MVP 结果 View 一次性渲染。

  调用方
  MatchPerformanceSidecar 的 gameOver listener。

  输入
  已完成评分和排序的 MatchResultViewModel，以及当前绑定对局的参与者元数据。

  输出
  无返回值。

  读取状态
  matchMvpResultView 与当前对局玩家的 controllerType/id。

  写入状态
  MVP 结果区域 DOM 与默认选择。

  调用函数
  Array.find、MatchMvpResultView.render。

  边界与不变量
  本人 ID 只作为展示上下文传给 View；不写入 MVP 结果，不修改游戏状态，也不重新评分或排序。
  */
  showMatchPerformance(viewModel) {
    const humanPlayerId = this.game?.state?.players?.find(
      (player) => player.controllerType === "human"
    )?.id ?? null;
    this.matchMvpResultView.render(viewModel, humanPlayerId);
  }

  /*
  功能
  展示对局胜负结果 overlay。

  调用方
  MatchWorkflow.finishGame 经 PresentationPort。

  输入
  胜方阵营 ID 与真人阵营是否获胜。

  输出
  无返回值。

  读取状态
  TEAM_PRESENTATION 与公开胜负事实。

  写入状态
  game-over 标题、说明和 overlay 可见类。

  调用函数
  DOM textContent/classList。

  边界与不变量
  只展示已由 Domain/Application 确认的 winnerTeam，不自行计算胜负。
  */
  showGameOver(winnerTeam, humanWon) {
    this.elements.game_over_title.textContent = humanWon ? "你的阵营获胜" : "你的阵营落败";
    this.elements.game_over_copy.textContent = `${TEAM_PRESENTATION[winnerTeam].name}存活到了最后。${humanWon ? "这场联结与应变赢得了终局。" : "重新征召旅者，下一局仍会有全新的阵营与牌序。"}`;
    this.elements.game_over_overlay.classList.remove("is-hidden");
  }

  /*
  功能
  收束所有待处理 UI 交互并清空瞬态展示。

  调用方
  attachGame、showSelection、MatchWorkflow.dispose 经 session UI。

  输入
  无。

  输出
  无返回值。

  读取状态
  target/discard/response/playEnd、各子 View pending 与瞬态 DOM。

  写入状态
  所有 UI pending 以契约取消值结算，清理动画/overlay/提示状态。

  调用函数
  各 resolve、AnimationController.clear、InteractionController.cancel、各 View hide/cancel。

  边界与不变量
  销毁/重开不得遗留 Promise、timer 或私密 DOM；不修改权威游戏状态。
  */
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
