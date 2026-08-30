import { escapeHtml } from "../templates.js";
import {
  MATCH_PERFORMANCE_DIMENSIONS,
  MATCH_PERFORMANCE_LABELS
} from "./MatchPerformancePolicy.js";
import { createRadarChartMarkup } from "./MatchMvpRadarChart.js";

/*
功能
按结算 UI 精度格式化有限数值。

调用方
MatchMvpResultView 的排名、明细与 MVP 展示。

输入
数值与小数位数。

输出
固定精度字符串。

读取状态
无。

写入状态
无。

调用函数
Number.toFixed。

边界与不变量
只负责显示精度，不参与评分计算。
*/
function formatNumber(value, digits) {
  return (Number(value) || 0).toFixed(digits);
}

export class MatchMvpResultView {
  /*
  功能
  创建结果排名、玩家选择和雷达详情 View。

  调用方
  UIManager constructor。

  输入
  MVP 结果根元素。

  输出
  已绑定单一 click listener 的 View 实例。

  读取状态
  无。

  写入状态
  root、viewModel 与 selectedPlayerId。

  调用函数
  Element.addEventListener。

  边界与不变量
  根元素缺失的测试/headless 环境保持 no-op；监听器只绑定一次。
  */
  constructor(root) {
    this.root = root ?? null;
    this.viewModel = null;
    this.selectedPlayerId = null;
    this.handleClick = this.handleClick.bind(this);
    this.root?.addEventListener?.("click", this.handleClick);
  }

  /*
  功能
  清空上一局不可变结果与当前选择。

  调用方
  UIManager.attachGame。

  输入
  无。

  输出
  无返回值。

  读取状态
  root。

  写入状态
  root markup、viewModel 与 selectedPlayerId。

  调用函数
  无。

  边界与不变量
  不触碰游戏状态或重新订阅事件。
  */
  reset() {
    this.viewModel = null;
    this.selectedPlayerId = null;
    if (this.root) this.root.innerHTML = "";
  }

  /*
  功能
  一次性渲染全场排名骨架并默认选中 MVP。

  调用方
  UIManager.showMatchPerformance。

  输入
  immutable MatchResultViewModel。

  输出
  无返回值。

  读取状态
  viewModel players。

  写入状态
  root markup、viewModel 与 selectedPlayerId。

  调用函数
  escapeHtml、formatNumber、renderSelection。

  边界与不变量
  排名只使用已派生结果，不在 DOM 层重新评分或排序；重复名称不生成第二行 DOM。
  */
  render(viewModel) {
    if (!this.root || !viewModel?.players?.length) return;
    this.viewModel = viewModel;
    this.selectedPlayerId = viewModel.defaultSelectedPlayerId;
    const mvp = viewModel.players[0];
    const rows = viewModel.players.map((player) => `<button class="match-mvp-ranking-row" type="button"
      data-match-performance-player-id="${escapeHtml(player.playerId)}" aria-pressed="false">
      ${player.isMvp ? '<span class="match-mvp-ranking-watermark" aria-hidden="true">MVP</span>' : ""}
      <span class="match-mvp-rank">${player.rank}</span>
      <span class="match-mvp-player-copy"><strong>${escapeHtml(player.primaryName)}</strong>${player.secondaryLabel ? `<small>${escapeHtml(player.secondaryLabel)}</small>` : ""}</span>
      <span class="match-mvp-score">${formatNumber(player.finalScore, 1)}</span>
    </button>`).join("");
    this.root.innerHTML = `<header class="match-mvp-hero">
      <span class="match-mvp-hero-watermark" aria-hidden="true">MVP</span>
      <div class="match-mvp-hero-player"><strong>${escapeHtml(mvp.primaryName)}</strong>${mvp.secondaryLabel ? `<span>${escapeHtml(mvp.secondaryLabel)}</span>` : ""}</div>
      <b class="match-mvp-hero-score">${formatNumber(mvp.finalScore, 1)}</b>
    </header>
    <div class="match-mvp-layout">
      <section class="match-mvp-ranking" aria-label="全场表现排名"><h3>全场表现排名</h3>${rows}</section>
      <section class="match-mvp-detail" data-match-performance-detail aria-live="polite"></section>
    </div>`;
    this.renderSelection();
  }

  /*
  功能
  响应排名按钮点击并切换当前玩家详情。

  调用方
  root click listener。

  输入
  DOM click event。

  输出
  无返回值。

  读取状态
  viewModel 与点击目标 data attribute。

  写入状态
  selectedPlayerId 与选中详情 DOM。

  调用函数
  Element.closest、renderSelection。

  边界与不变量
  只能选择当前 immutable ViewModel 中的玩家；不重新计算比赛统计。
  */
  handleClick(event) {
    const button = event.target?.closest?.("[data-match-performance-player-id]");
    const playerId = button?.dataset?.matchPerformancePlayerId;
    if (!playerId || !this.viewModel?.players.some((player) => player.playerId === playerId)) return;
    this.selectedPlayerId = playerId;
    this.renderSelection();
  }

  /*
  功能
  用当前 selectedPlayerId 更新按钮状态、雷达图和数值明细。

  调用方
  render 与 handleClick。

  输入
  无。

  输出
  无返回值。

  读取状态
  immutable viewModel 与 selectedPlayerId。

  写入状态
  ranking button class/aria 与 detail markup。

  调用函数
  createRadarChartMarkup、formatNumber、escapeHtml。

  边界与不变量
  雷达只读取原始 ratios；回合与胜局系数只显示在最终分区域。
  */
  renderSelection() {
    if (!this.root || !this.viewModel) return;
    const selected = this.viewModel.players.find(
      (player) => player.playerId === this.selectedPlayerId
    ) ?? this.viewModel.players[0];
    for (const button of this.root.querySelectorAll?.("[data-match-performance-player-id]") ?? []) {
      const active = button.dataset.matchPerformancePlayerId === selected.playerId;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const detail = this.root.querySelector?.("[data-match-performance-detail]");
    if (!detail) return;
    const rows = MATCH_PERFORMANCE_DIMENSIONS.map((key) => `<div class="match-mvp-stat-row">
      <span>${MATCH_PERFORMANCE_LABELS[key]}</span>
      <b>${formatNumber(selected.raw[key], 2)}</b>
      <strong>${formatNumber(selected.scores[key], 1)}</strong>
    </div>`).join("");
    detail.innerHTML = `<header><div><small>当前查看</small><strong>${escapeHtml(selected.primaryName)}</strong></div><span>第 ${selected.rank} 名</span></header>
      <div class="match-mvp-radar-wrap">${createRadarChartMarkup(selected.ratios)}</div>
      <div class="match-mvp-stat-table"><div class="match-mvp-stat-heading"><span>维度</span><b>原始</b><strong>得分</strong></div>${rows}</div>
      <footer class="match-mvp-totals">
        <span>基础得分 <b>${formatNumber(selected.baseScore, 1)}</b></span>
        <span>回合系数 <b>×${formatNumber(selected.roundMultiplier, 2)}</b></span>
        <span>胜局系数 <b>×${formatNumber(selected.victoryMultiplier, 2)}</b></span>
        <strong>最终得分 ${formatNumber(selected.finalScore, 1)}</strong>
      </footer>`;
  }
}
