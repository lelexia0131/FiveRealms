/*
模块职责
把安全投影和 Host 请求连接到唯一正式 UI，无 gameplay HTML。

上游
NetworkFlow。

下游
NetworkPresentationAdapter 与 UIManager。

状态边界
只读 projection，写 UI 临时选择；不持有 MatchState。

信息边界
未知牌仅使用 Host 的 opaque token。

架构约束
不创建 Application、GameLoop、AI、Worker 或 ActionWorkflow，不运行规则。
*/
import { presentNetworkGame } from "../../adapters/ui/NetworkPresentationAdapter.js";
import { orderZoneSelectionSlots } from "../InteractionController.js";

export class NetworkGameView {
  /*
  功能
  绑定 Guest 的正式展示会话。

  调用方
  NetworkFlow。

  输入
  ui 与协议 submit callback。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  本地展示与请求引用。

  调用函数
  无。

  边界与不变量
  不创建权威对象；ui.game 保持 null。
  */

  constructor({ ui, submit }) {
    this.ui = ui;
    this.submit = submit;
    this.projection = null;
    this.players = [];
    this.request = null;
    this.revision = null;
    this.promptRevision = null;
    this.logIds = [];
    this.submitted = false;
    this.disposed = false;
  }

  /*
  功能
  用新快照与请求驱动正式 UI。

  调用方
  Channel subscription。

  输入
  projection、projectionRevision、requests。

  输出
  无返回值。

  读取状态
  旧请求与展示版本。

  写入状态
  本地 UI 展示状态。

  调用函数
  showGame、render、presentEvent、presentDecision。

  边界与不变量
  切换请求取消旧交互；同一快照不重复反馈，迟到 Promise 不得回答新请求。
  */

  update({ projection, projectionRevision, requests }) {
    if (this.disposed || !projection) return;
    const first = !this.projection;
    if (first) {
      this.ui.showGame(null);
      this.ui.networkPresentation = this;
      this.ui.matchMvpResultView.reset();
      for (const button of this.ui.elements.ai_speed_control?.querySelectorAll("[data-ai-speed]") ?? []) button.disabled = true;
    }
    this.projection = projection;
    const request = requests[0] ?? null;
    const changed = request?.requestId !== this.request?.requestId;
    if (changed) {
      this.request = request;
      this.submitted = false;
      this.ui.cancelChoiceInteractions({ preserveEmptyPrivateReveal: true });
    }
    this.render();
    const prompt = projection.display?.prompt;
    if (prompt && prompt.revision !== this.promptRevision) {
      this.promptRevision = prompt.revision;
      this.ui.setPrompt(prompt.message, prompt.handHint);
    }
    if (first) this.ui.setMusicTeam(this.model.human.battleTeam);
    if (projectionRevision == null || projectionRevision !== this.revision) {
      this.revision = projectionRevision;
      this.presentEvent(projection.presentation);
      this.syncLogs();
    }
    if (projection.isGameOver) this.ui.showGameOver(projection.winnerTeam, this.model.human.battleTeam === projection.winnerTeam);
    if (changed && request) void this.presentDecision(request);
  }

  /*
  功能
  用 presentation model 重绘正式战场。

  调用方
  update 与 UIManager 本地选择重绘。

  输入
  无。

  输出
  无返回值。

  读取状态
  projection、请求与 UI 临时状态。

  写入状态
  DOM 和本地 model。

  调用函数
  presentNetworkGame、renderBattlefield、renderPresentedHand、renderPresentedControls。

  边界与不变量
  主要 DOM 与 Host 共用；不创建第二套 Network 页面。
  */

  render() {
    if (this.disposed || !this.projection) return false;
    this.model = presentNetworkGame(this.projection, this.submitted ? null : this.request, this.ui);
    this.players = this.model.players;
    const preserve = this.ui.horizontalCardScrollGameId === this.projection.gameId;
    this.ui.renderBattlefield(this.model.battlefield);
    this.ui.renderPresentedHand(this.model.hand, preserve);
    this.ui.renderPresentedControls(this.model.controls);
    this.ui.horizontalCardScrollGameId = this.projection.gameId;
    if (!this.ui.publicPoolView.pending) {
      if (this.projection.publicCards.length) this.ui.showPublicPool(this.projection.publicCards);
      else this.ui.hidePublicPool();
    }
    this.ui.animationController.flush(globalThis.document);
    return true;
  }

  /*
  功能
  把正式出牌、技能和 END 转成 Host 有限选项。

  调用方
  NetworkFlow/main callbacks。

  输入
  card/skill/end 和可选 cardId。

  输出
  无返回值。

  读取状态
  Host 请求 options。

  写入状态
  通过 answer 发送意图。

  调用函数
  answer。

  边界与不变量
  不按标签猜动作，不提交未授权选项。
  */

  intent(kind, cardId = null) {
    if (this.request?.kind !== "player-intent") return;
    const option = this.request.options.find((entry) => entry.intent === kind && (kind !== "card" || entry.card?.id === cardId));
    if (option) this.answer(this.request, [option.optionId]);
  }

  /*
  功能
  把 Host 决策交给现有正式交互控件。

  调用方
  update。

  输入
  白名单 request。

  输出
  无返回值。

  读取状态
  可见牌、公开玩家和 opaque 选项。

  写入状态
  仅 UI 选择状态。

  调用函数
  UIManager requestTarget/requestDiscard/requestResponse、PublicPoolView、InteractionController。

  边界与不变量
  只处理一个 Host 请求，不计算目标或规则，不创建 ActionWorkflow。
  */

  async presentDecision(request) {
    if (request.kind === "player-intent") return;
    const ui = this.ui;
    const allowed = new Set(request.options.map((option) => option.optionId));
    let ids = null;
    if (request.kind === "target") {
      const player = await ui.requestTarget(this.players.filter((entry) => allowed.has(entry.id)), request.label,
        { confirmSelection: true, canDecline: request.canDecline, card: request.card, targetDisplay: request.targetDisplay });
      ids = player ? [player.id] : null;
    } else if (request.kind === "discard") {
      const cards = await ui.requestDiscard(this.model.human, request.max, request.label);
      ids = cards?.map((card) => card.id);
    } else if (request.kind === "response") {
      const response = await ui.requestResponse({
        id: request.requestId, type: request.response?.type,
        legalCardIds: [...allowed], requiredCount: request.max,
        allowDecline: request.canDecline, timeoutMs: null,
        presentation: request.response ?? { eventText: request.label }
      }, request.label);
      // 正式响应按钮允许借势直接确认而不勾牌；沿用 Host 给定顺序，交回对应有限选项。
      ids = response?.status === "used"
        ? response.selectedIds?.length ? response.selectedIds : [...allowed].slice(0, request.max)
        : null;
    } else if (request.kind === "publicCard") {
      const card = await ui.requestPublicCard(this.model.human, request.options.map((option) => option.card));
      ids = card ? [card.id] : null;
    } else if (request.kind === "hiddenCard") {
      const displaySlots = request.options.map((option) => option.card
        ? { ...option.card, known: true, token: option.optionId, zone: option.zone }
        : { token: option.optionId, known: false, zone: option.zone });
      const slots = orderZoneSelectionSlots(
        displaySlots.filter((slot) => slot.zone === "equipment"),
        displaySlots.filter((slot) => slot.zone !== "equipment")
      );
      ids = await ui.interactionController.requestHiddenCards(
        { tokens: request.options.map((option) => ({ token: option.optionId })) },
        request.max, request.label, { exact: request.min === request.max, slots, canDecline: request.canDecline }
      );
    } else if (request.kind === "private-reveal") {
      await ui.showPrivateReveal(request.label, request.cards ?? []);
      ids = [request.options[0].optionId];
    } else if (request.kind === "card-flow") {
      const players = this.players;
      const firstIds = new Set(request.options.map((option) => option.targetIds[0]));
      const selection = await ui.interactionController.requestPresentedCardFlow(
        players.find((player) => player.id === request.actorId), request.card, [], {
          isActive: () => this.request === request && !this.disposed,
          firstTargets: () => players.filter((player) => firstIds.has(player.id)),
          secondTargets: (first) => players.filter((player) => request.options.some(
            (option) => option.targetIds[0] === first.id && option.targetIds[1] === player.id
          )),
          targetDisplay: (source) => request.flowDisplay[source.id]
        }
      );
      const selected = selection && request.options.find((option) =>
        option.targetIds[0] === (selection.firstTargetId ?? selection.sourceId)
        && option.targetIds[1] === (selection.secondTargetId ?? selection.receiverId));
      ids = selected ? [selected.optionId] : null;
    }
    this.answer(request, ids);
  }

  /*
  功能
  发送一次有效选择并等待 Host 刷新。

  调用方
  intent 与 presentDecision。

  输入
  原请求、optionId 数组或 null 放弃。

  输出
  无返回值。

  读取状态
  当前关联、数量与选项约束。

  写入状态
  submitted 与 Network 消息。

  调用函数
  submit、render。

  边界与不变量
  拒绝过期、重复或非法选择；不修改 projection。
  */

  answer(request, ids) {
    if (this.disposed || this.request !== request || this.submitted) return;
    if (ids == null && !request.canDecline) return;
    if (ids && (ids.length < request.min || ids.length > request.max
      || ids.some((id) => !request.options.some((option) => option.optionId === id)))) return;
    this.submitted = true;
    this.render();
    this.submit(request.requestId, { status: ids == null ? "declined" : "selected", selectedIds: ids ?? [] });
  }

  /*
  功能
  把公开事件转发到正式反馈和结果组件。

  调用方
  update 新快照。

  输入
  白名单 presentation。

  输出
  无返回值。

  读取状态
  公开玩家与事件字段。

  写入状态
  反馈、结算、濒死、决斗与结果 DOM。

  调用函数
  UIManager 对应展示方法。

  边界与不变量
  不推断伤害或胜负；私密揭示只经专属 request。
  */

  presentEvent(event) {
    if (!event) return;
    const ui = this.ui;
    const player = this.players.find((entry) => entry.id === event.playerId);
    if (event.kind === "feedback") ui.queueFeedback(event.effect, event.playerId, event.amount, event.variant);
    else if (event.kind === "action-cue") ui.playSound(event.cue);
    else if (event.kind === "action") ui.setCurrentCard(event.skillName ?? event.card, event.source, event.targetLabel, event.displayTargets);
    else if (event.kind === "thinking") { ui.setThinking(Boolean(player), player, event.message); this.render(); }
    else if (event.kind === "judgment" && player) ui.showJudgment(player, event.card, { delayedStatusContext: event.delayedStatus });
    else if (event.kind === "dying" && player) ui.showDying(player, { currentHp: event.currentHp, need: event.need });
    else if (event.kind === "vfx") {
      if (event.view === "playRadarSuccess") ui.playRadarSuccess(event.playerId);
      if (event.view === "playLightningHit") ui.playLightningHit(event.playerId);
    }
    else if (event.kind === "duel" && player) {
      const opponent = this.players.find((entry) => entry.id === event.opponentId);
      if (opponent) ui.showDuel(player, opponent);
    } else if (event.kind === "clear") {
      if (event.view === "hideJudgment") ui.hideJudgment();
      if (event.view === "hideDying") ui.hideDying();
      if (event.view === "hideDuel") ui.hideDuel();
      if (event.view === "resetCurrentCard") ui.resetCurrentCard();
    } else if (event.kind === "result") ui.matchMvpResultView.render(event.result, this.projection.viewerId, "");
    ui.animationController.flush(globalThis.document);
  }

  /*
  功能
  向正式日志组件增量写入安全公开日志。

  调用方
  update。

  输入
  无。

  输出
  无返回值。

  读取状态
  display.logs 与已显示 ID。

  写入状态
  日志 DOM 和本地 ID。

  调用函数
  clearLog、appendLog。

  边界与不变量
  回滚时重建，同一快照不重复追加。
  */

  syncLogs() {
    const logs = this.projection.display?.logs ?? [];
    if (this.logIds.some((id, index) => logs[index]?.id !== id)) {
      this.ui.clearLog();
      this.logIds = [];
    }
    for (let index = this.logIds.length; index < logs.length; index += 1) this.ui.appendLog(logs[index], index + 1);
    this.logIds = logs.map((entry) => entry.id);
  }

  /*
  功能
  解绑 Guest 并清理待答控件和私密 DOM。

  调用方
  NetworkFlow 离房、断线、重开。

  输入
  无。

  输出
  无返回值。

  读取状态
  UI 展示所有权。

  写入状态
  UI 生命周期。

  调用函数
  cancelPendingInteractions。

  边界与不变量
  先失效再取消 Promise，离房不提交迟到回答。
  */

  dispose() {
    this.disposed = true;
    this.request = null;
    if (this.ui.networkPresentation === this) {
      this.ui.networkPresentation = null;
      this.ui.cancelPendingInteractions();
      for (const button of this.ui.elements.ai_speed_control?.querySelectorAll("[data-ai-speed]") ?? []) button.disabled = false;
    }
  }
}
