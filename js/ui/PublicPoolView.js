/**
 * 互利公开牌池视图。只渲染公开牌并返回被点击的实体 ID，不移动卡牌；
 * pending Promise 在取消、重开或游戏结束时必须由 UIManager 收束。
 */
import { escapeHtml } from "./templates.js";

export class PublicPoolView {
  constructor(element) { this.element = element; this.pending = null; }
  show(cards) {
    this.element.innerHTML = `<div class="tableau-title">互利公开牌池</div><div class="tableau-cards">${cards.map((card) => `<button type="button" class="tableau-card" data-public-card-id="${escapeHtml(card.id)}" style="--card-accent:${escapeHtml(card.accent)}"><img src="${escapeHtml(card.art)}" alt=""><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.description)}</small></button>`).join("")}</div>`;
    this.element.classList.remove("is-hidden");
  }
  request(player, cards) {
    this.show(cards);
    return new Promise((resolve) => {
      const handler = (event) => {
        const button = event.target.closest("[data-public-card-id]");
        if (!button) return;
        this.element.removeEventListener("click", handler);
        resolve(cards.find((card) => card.id === button.dataset.publicCardId) ?? null);
      };
      this.element.addEventListener("click", handler);
      this.pending = { resolve, handler };
    });
  }
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; this.pending = null; }
  cancel() { if (!this.pending) return; this.element.removeEventListener("click", this.pending.handler); this.pending.resolve(null); this.hide(); }
}
