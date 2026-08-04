/**
 * 雷达判定展示。只渲染核心已公开的判定牌；牌区移动和判定结果由
 * JudgmentSystem 负责，重开时 UIManager 会清空本视图。
 */
import { escapeHtml } from "./templates.js?build=20260804-plunder-sim-zone-v73";
export class JudgmentView {
  constructor(element) { this.element = element; }
  show(player, card) {
    this.element.innerHTML = `<span>防御判定 · ${escapeHtml(player.name)}</span><img src="${escapeHtml(card.art)}" alt="${escapeHtml(card.name)}"><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.categoryName)}</small>`;
    this.element.classList.remove("is-hidden");
  }
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; }
}
