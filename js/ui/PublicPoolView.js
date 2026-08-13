/**
 * 互利公开牌池视图。只渲染公开牌并返回被点击的实体 ID，不移动卡牌；
 * pending Promise 只允许在重开、销毁或游戏结束时由 UIManager 收束；
 * 正常互利结算必须由当前存活角色确认一张牌。
 */
import { publicPoolCardTemplate } from "./templates.js?build=20260813-human-response-indefinite";
import { isCardSelectionValid, toggleCardSelection } from "./selectionUtils.js?build=20260813-human-response-indefinite";

export class PublicPoolView {
  constructor(element, onSelect = null) { this.element = element; this.pending = null; this.onSelect = onSelect; }
  show(cards, options = {}) {
    const selectedId = options.selectedId ?? null;
    this.element.innerHTML = `<div class="tableau-title">互利公开牌池</div><div class="tableau-cards">${cards.map((card) => publicPoolCardTemplate(card, { selected:card.id === selectedId })).join("")}</div>${options.interactive ? `<div class="tableau-actions"><button class="primary-button" type="button" data-public-confirm${selectedId ? "" : " disabled"}>确定</button></div>` : ""}`;
    this.element.classList.remove("is-hidden");
  }
  request(player, cards) {
    this.cancel();
    const selected = new Set();
    this.show(cards, { interactive:true });
    return new Promise((resolve) => {
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
  settle(card) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.element.removeEventListener("click", pending.handler);
    this.hide();
    pending.resolve(card);
  }
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; }
  cancel() { if (this.pending) this.settle(null); else this.hide(); }
}
