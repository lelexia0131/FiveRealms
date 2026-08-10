/**
 * 公共判定展示。只渲染核心已公开的判定牌；牌区移动和判定结果由
 * JudgmentSystem 负责，重开时 UIManager 会清空本视图。
 */
import { escapeHtml } from "./templates.js?build=20260810-discard-marginal-value-v152";
export class JudgmentView {
  constructor(element) { this.element = element; }
  show(player, card, context = {}) {
    const delayedStatus = context.delayedStatusContext;
    const heading = delayedStatus
      ? `${delayedStatus.ownerName}的「${delayedStatus.statusName}」正在判定`
      : `防御判定 · ${player.name}`;
    this.element.innerHTML = `<span>${escapeHtml(heading)}</span><img src="${escapeHtml(card.art)}" alt="${escapeHtml(card.name)}"><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.categoryName)}</small>`;
    this.element.classList.remove("is-hidden");
  }
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; }
}
