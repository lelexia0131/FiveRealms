/**
 * 真人多阶段交互控制器。只把公开玩家 ID 或不透明隐藏 token 放入 DOM，并将
 * 最终公开意图交回 Application action workflow；不修改生命、能量、手牌、装备、状态或胜负。
 */
import { escapeHtml, hiddenCardBackTemplate, hiddenKnownCardTemplate } from "./templates.js";
import { createHiddenSelectionView } from "./handVisibility.js";
import { isCardSelectionValid, toggleCardSelection } from "./selectionUtils.js";
import { ActionLegality } from "../application/action/ActionLegality.js";
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js";
import { presentCard } from "../adapters/ui/CardPresentationDefinitions.js";

const EQUIPMENT_OPTION_TOKEN = "public-equipment";

/*
功能
把隐藏选择槽位渲染为只含不透明 token 的安全 HTML。

调用方
InteractionController.requestHiddenCards 与隐藏信息 UI 测试。

输入
隐藏 selection 及可选的已脱敏展示槽位。

输出
隐藏牌按钮 HTML 字符串。

读取状态
selection.tokens 或传入 slots 的合法展示事实。

写入状态
无。

调用函数
hiddenKnownCardTemplate、hiddenCardBackTemplate。

边界与不变量
未知槽位不得包含实体 ID、定义或牌面；DOM 只接收不透明 token。
*/
export function hiddenSelectionMarkup(selection, slots = null) {
  const displaySlots = slots ?? selection.tokens.map((entry) => ({ token:entry.token, known:false }));
  return displaySlots.map((slot) => slot.known
    ? hiddenKnownCardTemplate(slot, slot.token, { zone:slot.zone })
    : hiddenCardBackTemplate({ token:slot.token, compact:true })
  ).join("");
}

/*
功能
把公开装备槽位稳定排列在隐藏手牌槽位之前。

调用方
InteractionController.requestZoneCard 与区域选牌展示回归测试。

输入
按装备区原顺序生成的公开装备槽位，以及按 token 原顺序生成的手牌槽位。

输出
装备在前、手牌在后的新槽位数组。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不排序、不修改输入数组，也不读取任何隐藏手牌牌面；两个区域各自保持稳定顺序。
*/
export function orderZoneSelectionSlots(equipmentSlots, handSlots) {
  return [...equipmentSlots, ...handSlots];
}

/** 多阶段真人选择器。只把公开 ID 或不透明令牌交给 DOM。 */
export class InteractionController {
  /*
  功能
  创建真人多阶段选择控制器。

  调用方
  UIManager 构造函数。

  输入
  UIManager 展示能力。

  输出
  InteractionController 实例。

  读取状态
  无。

  写入状态
  保存 ui 并初始化 pending。

  调用函数
  无。

  边界与不变量
  同一控制器至多持有一个待结算交互。
  */
  constructor(ui) { this.ui = ui; this.pending = null; }

  /*
  功能
  绑定隐藏选择、确认与取消的事件委托。

  调用方
  UIManager.bindEvents。

  输入
  响应面板根 DOM 元素。

  输出
  无返回值。

  读取状态
  DOM 点击目标与 pending。

  写入状态
  通过 toggleHidden、confirm 或 cancel 更新当前交互。

  调用函数
  toggleHidden、confirm、cancel。

  边界与不变量
  只消费本根元素内带协议 data attribute 的点击。
  */
  bind(root) {
    root.addEventListener("click", (event) => {
      const hidden = event.target.closest("[data-hidden-token]");
      if (hidden) this.toggleHidden(hidden.dataset.hiddenToken);
      const confirm = event.target.closest("[data-interaction-confirm]");
      if (confirm) this.confirm();
      const cancel = event.target.closest("[data-interaction-cancel]");
      if (cancel) this.cancel();
    });
  }

  /*
  功能
  收集卡牌公开多阶段意图，不预选后续隐藏牌。

  调用方
  UIManager.requestCardFlow、ActionWorkflow 真人出牌入口。

  输入
  当前 MatchApplication、行动者、卡牌与第一阶段目标。

  输出
  公开 ID 组成的意图对象；取消或过期会话返回 null。

  读取状态
  当前 session、公开玩家/装备与 ActionLegality 查询。

  写入状态
  仅写 UI 的目标选择与确认状态。

  调用函数
  UIManager.requestTarget、requestConfirmation 与 ActionLegality。

  边界与不变量
  隐藏手牌/区域选择由后续 HiddenCardChoiceWorkflow 经 ChoicePort 发起；await 后必须复核 session 和实体身份。
  */
  async requestCardFlow(game, actor, card, initialTargets) {
    const gameId = game.state.gameId;
    if (!game.isSessionValid(gameId)) return null;
    if (card.definitionId === "leverage") {
      // 项目当前每人只有一个公开装备槽，故装备阶段可按规则自动选中唯一真实实例。
      const firstTargets = ActionLegality.getLeverageFirstTargets(game, actor);
      const firstTarget = await this.ui.requestTarget(firstTargets, "选择一名有装备且有可选第二目标的其他角色", {
        source:actor, card, confirmSelection:true, stepTitle:"借势 · 第一目标"
      });
      if (!game.isSessionValid(gameId) || !firstTarget) return null;
      const equipment = firstTarget.equipment;
      if (!equipment?.id || !ActionLegality.getLeverageFirstTargets(game, actor).includes(firstTarget)) return null;

      const secondTargets = ActionLegality.getAssaultTargetCandidates(game, firstTarget);
      const secondTarget = await this.ui.requestTarget(secondTargets, "选择其攻击范围内的一名其他角色", {
        source:firstTarget, card:CARD_DEFINITIONS.assault, confirmSelection:true, stepTitle:"借势 · 第二目标"
      });
      if (!game.isSessionValid(gameId) || !secondTarget) return null;
      if (firstTarget.equipment !== equipment || equipment.id == null
        || !ActionLegality.getAssaultTargetCandidates(game, firstTarget).includes(secondTarget)) return null;

      const confirmed = await this.requestConfirmation(
        "借势 · 确认",
        `${actor.name}要求${firstTarget.name}对${secondTarget.name}使用「突袭」；若拒绝，${actor.name}将获得其「${equipment.name}」。`
      );
      if (!confirmed || !game.isSessionValid(gameId)) return null;
      return {
        firstTargetId:firstTarget.id,
        equipmentCardId:equipment.id,
        equipmentDefinitionId:equipment.definitionId,
        secondTargetId:secondTarget.id
      };
    }
    if (card.definitionId === "transfer") {
      const sources = ActionLegality.getTransferSources(game, actor, card).filter((from) => ActionLegality.getTransferReceivers(game, actor, from, card).length);
      const source = await this.ui.requestTarget(sources, "转移：选择距离1内的牌来源", { source:actor, card });
      if (!game.isSessionValid(gameId)) return null;
      if (!source) return null;
      const receivers = ActionLegality.getTransferReceivers(game, actor, source, card);
      const receiver = await this.ui.requestTarget(receivers, "转移：选择距离1内的接收者", { source:actor, card });
      if (!game.isSessionValid(gameId)) return null;
      if (!receiver) return null;
      return { sourceId:source.id, receiverId:receiver.id };
    }
    if (["plunder","destroy"].includes(card.definitionId)) {
      const target = initialTargets[0];
      if (!target) return null;
      return {};
    }
    if (card.definitionId === "scout") {
      const target = initialTargets[0];
      if (!target) return null;
      return {};
    }
    return {};
  }

  /*
  功能
  呈现一次真人隐藏手牌或公开装备的区域选择。

  调用方
  UIManager.requestZoneCard、UiChoiceAdapter hiddenCard 请求。

  输入
  当前 MatchApplication、观察者、区域所有者、提示及排除实体 ID。

  输出
  选中区域及 token/装备 ID；取消或过期返回 null。

  读取状态
  当前 session、owner 手牌/装备与隐藏选择 adapter。

  写入状态
  创建临时隐藏 selection 并更新交互 DOM。

  调用函数
  HiddenCardSelectionAdapter、createHiddenSelectionView、presentCard、requestHiddenCards。

  边界与不变量
  未知手牌只以 token 呈现；公开装备使用固定 UI token 并排在手牌前，返回前必须复核 gameId。
  */
  async requestZoneCard(game, actor, owner, prompt, excludedCardIds = null) {
    const gameId = game.state.gameId;
    if (!game.isSessionValid(gameId)) return null;
    const eligibleHand = owner?.hand?.filter((card) => !excludedCardIds?.has(card.id)) ?? [];
    if (!eligibleHand.length && !owner?.equipment) return null;
    const hidden = game.hiddenCardSelection.createHiddenSelection(owner, eligibleHand);
    const handSlots = createHiddenSelectionView(actor, owner, hidden);
    const equipmentSlots = [];
    if (owner.equipment) {
      const { name, categoryName, description, art, icon, accent, frameStyle, flavorText } = presentCard(owner.equipment);
      equipmentSlots.push({ token:EQUIPMENT_OPTION_TOKEN, known:true, zone:"equipment", name, categoryName, description, art, icon, accent, frameStyle, flavorText });
    }
    const slots = orderZoneSelectionSlots(equipmentSlots, handSlots);
    const selected = await this.requestHiddenCards(hidden, 1, prompt, { exact:true, slots, totalCount:slots.length });
    if (!game.isSessionValid(gameId)) return null;
    if (!selected?.length) return null;
    if (selected[0] === EQUIPMENT_OPTION_TOKEN) return { zone:"equipment", equipmentCardId:owner.equipment?.id ?? null, selectionId:hidden.selectionId };
    return { zone:"hand", tokens:selected, selectionId:hidden.selectionId };
  }

  /*
  功能
  请求真人从隐藏槽位中选择限定数量的 token。

  调用方
  requestZoneCard 与 UiChoiceAdapter。

  输入
  隐藏 selection、最大数量、提示及 exact/slots/viewer/owner 展示选项。

  输出
  解析为 token 数组或取消时 null 的 Promise。

  读取状态
  selection 安全槽位与 UI response_panel。

  写入状态
  pending 选择状态及响应面板 DOM。

  调用函数
  cancel、createHiddenSelectionView、hiddenSelectionMarkup、UIManager.render。

  边界与不变量
  新请求先收束旧请求；DOM 不得接收未知牌的实体或定义信息。
  */
  requestHiddenCards(selection, count, prompt, options = {}) {
    this.cancel();
    return new Promise((resolve) => {
      const selected = new Set();
      const slots = options.slots ?? createHiddenSelectionView(options.viewer, options.owner, selection);
      this.pending = { type:"hidden", selection, count, exact:Boolean(options.exact), selected, resolve };
      this.ui.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(prompt)}</strong><span>${options.totalCount ?? selection.tokens.length}张</span></div>
        <div class="hidden-card-grid">${hiddenSelectionMarkup(selection, slots)}</div>
        <div class="response-actions"><button class="primary-button" type="button" data-interaction-confirm disabled>确认选择</button><button class="ghost-button" type="button" data-interaction-cancel>取消</button></div>`;
      this.ui.elements.response_panel.classList.remove("is-hidden");
      if (this.ui.game) this.ui.render(this.ui.game);
    });
  }

  /*
  功能
  请求真人确认或取消已汇总的公开多阶段意图。

  调用方
  requestCardFlow 的借势流程。

  输入
  对话标题与公开摘要。

  输出
  解析为 true 或取消时 null 的 Promise。

  读取状态
  UI response_panel。

  写入状态
  pending 确认状态及响应面板 DOM。

  调用函数
  cancel、escapeHtml、UIManager.render。

  边界与不变量
  摘要必须只含公开信息；新请求先取消旧请求。
  */
  requestConfirmation(title, summary) {
    this.cancel();
    return new Promise((resolve) => {
      this.pending = { type:"confirm", resolve };
      this.ui.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(title)}</strong><span>三项选择已完成</span></div><div class="response-copy"><p class="response-event">${escapeHtml(summary)}</p><p class="response-requirement">确认后才会消耗「借势」并进入响应。</p></div><div class="response-actions"><button class="primary-button" type="button" data-interaction-confirm>确认使用</button><button class="ghost-button" type="button" data-interaction-cancel>取消</button></div>`;
      this.ui.elements.response_panel.classList.remove("is-hidden");
      if (this.ui.game) this.ui.render(this.ui.game);
    });
  }

  /*
  功能
  切换当前隐藏 token 并同步确认按钮状态。

  调用方
  bind 注册的隐藏牌点击处理。

  输入
  被点击的不透明 token。

  输出
  无返回值。

  读取状态
  pending 的 count、exact 与 selected。

  写入状态
  pending.selected 以及槽位和确认按钮 DOM 状态。

  调用函数
  toggleCardSelection、isCardSelectionValid、UIManager.playSound。

  边界与不变量
  仅 hidden 类型 pending 可处理；不得解析 token 或读取真实卡牌。
  */
  toggleHidden(token) {
    if (this.pending?.type !== "hidden") return;
    this.ui.playSound?.("select");
    this.pending.selected = toggleCardSelection(this.pending.selected, token, this.pending.count);
    for (const button of this.ui.elements.response_panel.querySelectorAll("[data-hidden-token]")) {
      const active = this.pending.selected.has(button.dataset.hiddenToken);
      button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active));
    }
    const confirm = this.ui.elements.response_panel.querySelector("[data-interaction-confirm]");
    if (confirm) confirm.disabled = !isCardSelectionValid(this.pending.selected, this.pending.count, this.pending.exact);
  }

  /*
  功能
  以当前选择或确认值完成待处理交互。

  调用方
  bind 注册的确认按钮处理。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending 类型与 selected。

  写入状态
  通过 settle 清空 pending。

  调用函数
  settle。

  边界与不变量
  无 pending 时为 no-op；hidden 结果只返回 token 数组。
  */
  confirm() {
    if (!this.pending) return;
    this.settle(this.pending.type === "confirm" ? true : [...this.pending.selected]);
  }
  /*
  功能
  取消当前真人交互。

  调用方
  bind、新交互启动与 UIManager.cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending。

  写入状态
  通过 settle 清空 pending。

  调用函数
  settle。

  边界与不变量
  无 pending 时为 no-op；取消结果统一为 null。
  */
  cancel() { if (this.pending) this.settle(null); }
  /*
  功能
  收束当前交互并清理临时隐藏选择和 DOM。

  调用方
  confirm、cancel。

  输入
  交互结果；null 表示取消。

  输出
  无返回值。

  读取状态
  pending、UIManager 当前 game 与 response_panel。

  写入状态
  清空 pending、响应面板 DOM；取消时清理隐藏 selection。

  调用函数
  HiddenCardSelectionAdapter.clearSelection、pending.resolve、UIManager.render。

  边界与不变量
  pending 先清空再回调，避免重入重复结算；取消不得遗留 opaque token session。
  */
  settle(value) {
    const current = this.pending;
    if (!current) return;
    this.pending = null;
    this.ui.elements.response_panel.classList.add("is-hidden");
    this.ui.elements.response_panel.innerHTML = "";
    if (value === null && current.selection?.selectionId) this.ui.game?.hiddenCardSelection.clearSelection(current.selection.selectionId);
    current.resolve(value);
    if (this.ui.game) this.ui.render(this.ui.game);
  }
}
