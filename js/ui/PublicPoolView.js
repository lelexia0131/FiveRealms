/**
 * 互利公开牌池视图。只渲染公开牌并返回被点击的实体 ID，不移动卡牌；
 * pending Promise 只允许在重开、销毁或游戏结束时由 UIManager 收束；
 * 正常互利结算必须由当前存活角色确认一张牌。
 */
import { publicPoolCardTemplate } from "./templates.js";
import { restoreHorizontalCardScroll } from "./horizontalCardScroll.js";
import { isCardSelectionValid, toggleCardSelection } from "./selectionUtils.js";

export class PublicPoolView {
  /*
  功能
  绑定公开牌池容器及选择反馈能力。

  调用方
  UIManager 构造函数。

  输入
  牌池 DOM 元素与可选点击反馈回调。

  输出
  PublicPoolView 实例。

  读取状态
  无。

  写入状态
  保存 element、onSelect 并初始化 pending。

  调用函数
  无。

  边界与不变量
  视图不移动牌实体，同一时刻至多存在一个选择请求。
  */
  constructor(element, onSelect = null) { this.element = element; this.pending = null; this.onSelect = onSelect; }
  /*
  功能
  渲染当前公开牌池及可选的确认控件。

  调用方
  UIManager.showPublicPool 与 PublicPoolView.request/handler。

  输入
  公开牌数组及 interactive、selectedId 展示选项。

  输出
  无返回值。

  读取状态
  公开卡牌 presentation 字段、pending 与当前 tableau scrollLeft。

  写入状态
  element 内容、可见类及同一请求内的 tableau scrollLeft。

  调用函数
  publicPoolCardTemplate、restoreHorizontalCardScroll。

  边界与不变量
  只把公开实体 ID 放入 DOM；仅 pending 同一请求重绘时保留位置，新请求从初始位置开始。
  */
  show(cards, options = {}) {
    const selectedId = options.selectedId ?? null;
    const previousScroller = this.pending ? this.element.querySelector?.(".tableau-cards") : null;
    const previousScrollLeft = previousScroller?.scrollLeft ?? 0;
    this.element.innerHTML = `<div class="tableau-title">互利公开牌池</div><div class="tableau-cards">${cards.map((card) => publicPoolCardTemplate(card, { selected:card.id === selectedId })).join("")}</div>${options.interactive ? `<div class="tableau-actions"><button class="primary-button" type="button" data-public-confirm${selectedId ? "" : " disabled"}>确定</button></div>` : ""}`;
    if (previousScroller) {
      restoreHorizontalCardScroll(this.element.querySelector?.(".tableau-cards"), previousScrollLeft);
    }
    this.element.classList.remove("is-hidden");
  }
  /*
  功能
  请求真人从公开牌池确认一张牌。

  调用方
  UIManager.requestPublicCard、UiChoiceAdapter。

  输入
  当前选择玩家与按座次流程提供的公开牌数组。

  输出
  解析为所选牌实体或取消时 null 的 Promise。

  读取状态
  element 事件与当前公开牌数组。

  写入状态
  pending 请求及牌池选择 DOM。

  调用函数
  cancel、show、settle。

  边界与不变量
  只允许确认一张仍在本次 cards 中的实体；新请求先取消旧请求。
  */
  request(player, cards) {
    this.cancel();
    const selected = new Set();
    this.show(cards, { interactive:true });
    return new Promise((resolve) => {
      /*
      功能
      处理本次公开牌池的选择切换与确认点击。

      调用方
      当前 request 注册的 element click listener。

      输入
      DOM 点击事件。

      输出
      无返回值。

      读取状态
      pending.selected 与本次公开 cards。

      写入状态
      pending.selected 或通过 settle 结束请求。

      调用函数
      toggleCardSelection、isCardSelectionValid、show、settle。

      边界与不变量
      非法确认保持等待；返回实体必须来自本次公开牌数组。
      */
      const handler = (event) => {
        const cardButton = event.target.closest("[data-public-card-id]");
        if (cardButton) {
          this.onSelect?.();
          const next = toggleCardSelection(this.pending?.selected, cardButton.dataset.publicCardId, 1);
          if (this.pending) this.pending.selected = next;
          this.show(cards, { interactive:true, selectedId:[...next][0] ?? null });
          return;
        }
        if (!event.target.closest("[data-public-confirm]") || !isCardSelectionValid(this.pending?.selected, 1, true)) return;
        this.onSelect?.();
        const selectedId = [...this.pending.selected][0];
        this.settle(cards.find((card) => card.id === selectedId) ?? null);
      };
      this.element.addEventListener("click", handler);
      this.pending = { resolve, handler, selected, playerId:player.id };
    });
  }
  /*
  功能
  结束当前公开牌池请求并交回选择结果。

  调用方
  公开牌池确认 handler 与 cancel。

  输入
  所选公开牌实体或 null。

  输出
  无返回值。

  读取状态
  pending 请求。

  写入状态
  清空 pending、移除事件监听并隐藏视图。

  调用函数
  removeEventListener、hide、pending.resolve。

  边界与不变量
  无 pending 时为 no-op；请求 Promise 只结算一次。
  */
  settle(card) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.element.removeEventListener("click", pending.handler);
    this.hide();
    pending.resolve(card);
  }
  /*
  功能
  清空并隐藏公开牌池视图。

  调用方
  settle、UIManager.hidePublicPool 与展示流程清理。

  输入
  无。

  输出
  无返回值。

  读取状态
  element。

  写入状态
  element 内容与可见类。

  调用函数
  DOM classList。

  边界与不变量
  不结算 pending；有请求时必须由 cancel/settle 收束。
  */
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; }
  /*
  功能
  取消当前公开牌选择，或在空闲时仅隐藏视图。

  调用方
  新 request 与 UIManager.cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending。

  写入状态
  有请求时以 null 结算并清理视图。

  调用函数
  settle 或 hide。

  边界与不变量
  取消必须解除 click listener，不能遗留未完成 Promise。
  */
  cancel() { if (this.pending) this.settle(null); else this.hide(); }
}
