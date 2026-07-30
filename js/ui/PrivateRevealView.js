/**
 * 仅真人可见的临时情报层。关闭时立即清空牌面 DOM；本模块不写公开日志、
 * 不保存 AI 记忆，也不修改任何游戏状态。
 */
import { escapeHtml } from "./templates.js?build=20260730-tabletop-hands-v15";

export class PrivateRevealView {
  constructor(element) { this.element = element; this.pending = null; }
  show(title, cards = []) {
    if (!cards.length) { this.element.textContent = title; this.element.classList.remove("is-hidden"); return Promise.resolve(); }
    return new Promise((resolve) => {
      this.pending = resolve;
      this.element.innerHTML = `<div class="response-title"><strong>${escapeHtml(title)}</strong><span>仅你可见</span></div><div class="private-card-grid">${cards.map((card) => `<article class="private-card" style="--card-accent:${escapeHtml(card.accent)}"><img src="${escapeHtml(card.art)}" alt=""><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.description)}</small></article>`).join("")}</div><button class="primary-button" type="button" data-close-private>收起情报</button>`;
      this.element.classList.remove("is-hidden");
      this.element.querySelector("[data-close-private]").addEventListener("click", () => this.hide(), { once:true });
    });
  }
  hide() { const resolve = this.pending; this.pending = null; this.element.classList.add("is-hidden"); this.element.innerHTML = ""; resolve?.(); }
}
