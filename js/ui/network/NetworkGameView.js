import { escapeHtml, privateCardTemplate } from "../templates.js";
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { presentCharacter } from "../../adapters/ui/CharacterPresentationDefinitions.js";
import { TEAM_PRESENTATION, PHASE_PRESENTATION } from "../../adapters/ui/PresentationMetadata.js";
import { MatchMvpResultView } from "../results/MatchMvpResultView.js";

export class NetworkGameView {
  /*
功能
创建仅消费安全投影的 Guest 游戏展示与输入视图。

调用方
NetworkFlow Guest 准备。

输入
showPage callback、getRoot 与 submit。

输出
View。

读取状态
无。

写入状态
仅本地选择与显示数据。

调用函数
无。

边界与不变量
不持有 Game/MatchState，不调用规则查询、AI、Worker 或随机源。
*/
  constructor({ showPage, getRoot, submit }) {
    this.showPage = showPage;
    this.getRoot = getRoot;
    this.submit = submit;
    this.projection = null;
    this.requests = [];
    this.selectedIds = [];
    this.requestId = null;
    this.result = null;
    this.resultView = null;
  }

  /*
功能
接收 authoritative viewer projection 和待答请求。

调用方
NetworkGameChannel subscription。

输入
安全 client snapshot。

输出
无。

读取状态
旧 requestId。

写入状态
只更新本地 UI projection、选择和终局展示。

调用函数
render。

边界与不变量
同一请求的重绘保留选择，切换请求清空选择；状态只能从 Host 消息更新。
*/
  update({ projection, requests }) {
    this.projection = projection;
    this.requests = requests;
    const requestId = requests[0]?.requestId ?? null;
    if (requestId !== this.requestId) this.selectedIds = [];
    this.requestId = requestId;
    if (projection?.presentation?.kind === "result") this.result = projection.presentation.result;
    this.render();
  }

  /*
功能
按公开玩家与本人手牌渲染 Guest 游戏页面。

调用方
update、输入选择。

输入
无。

输出
无。

读取状态
viewer projection 和当前 request。

写入状态
DOM。

调用函数
privateCardTemplate、presentCharacter、renderDecision、MatchMvpResultView。

边界与不变量
不知道牌库顺序或敌方隐藏身份；不自行判定胜负、合法性或MVP。
*/
  render() {
    const p = this.projection;
    if (!p) {
      this.showPage('<div class="network-waiting"><h2>等待房主同步战场</h2><p>游戏界面已就绪</p></div><button class="ghost-button" data-network-action="cancel">退出房间</button>');
      return;
    }
    const players = p.players.map((player) => {
      const character = presentCharacter(CHARACTER_BY_ID[player.characterId]);
      return `<article class="network-game-player ${player.playerId === p.currentPlayerId ? "is-current" : ""}">
        <img src="${escapeHtml(character.portrait)}" alt="${escapeHtml(player.name)}">
        <h3>${escapeHtml(player.name)}${player.playerId === p.viewerId ? " · 你" : ""}</h3>
        <p>${TEAM_PRESENTATION[player.teamId].name} · ${player.alive ? "存活" : "已阵亡"}</p>
        <p>生命 ${player.hp}/${player.maxHp} · 能量 ${player.energy}/${player.maxEnergy} · 护盾 ${player.shield}</p>
        <p>手牌 ${player.handCount} 张${player.equipment ? " · 已装备" : ""}</p>
      </article>`;
    }).join("");
    const viewer = p.players.find((player) => player.playerId === p.viewerId);
    const resultLabel = p.isGameOver ? (viewer.teamId === p.winnerTeam ? "你的阵营获胜" : "你的阵营落败") : "";
    const phase = PHASE_PRESENTATION[p.phase] ?? p.phase;
    this.showPage(`<div class="network-game"><header class="selection-header"><div><h2>${resultLabel || "五域战场"}</h2>
      <p>第 ${p.round} 轮 · ${escapeHtml(phase)} · 牌堆 ${p.deckCount} 张</p></div>
      <button class="ghost-button" data-network-action="cancel">退出房间</button></header>
      <div class="network-game-roster">${players}</div>
      <section class="network-game-decision" aria-live="polite">${this.renderDecision()}</section>
      <section><h3>你的手牌 · ${viewer.handCount} 张</h3><div class="network-game-hand">${(viewer.hand ?? []).map(privateCardTemplate).join("")}</div></section>
      <section class="network-game-public"><h3>公开结算</h3><div class="network-game-hand">${p.resolvingCards.map(privateCardTemplate).join("")}</div></section>
      <section data-network-result></section></div>`);
    if (this.result) {
      this.resultView = new MatchMvpResultView(this.getRoot()?.querySelector("[data-network-result]"));
      this.resultView.render(this.result, p.viewerId, "");
    }
  }

  /*
功能
仅渲染 Host 给定的决定选项与数量约束。

调用方
render。

输入
无。

输出
安全标记。

读取状态
当前 request、安全牌面与 selectedIds。

写入状态
无。

调用函数
escapeHtml、privateCardTemplate。

边界与不变量
不使用完整 Match 模拟局面或计算合法目标，隐藏牌仅用 opaque optionId。
*/
  renderDecision() {
    const request = this.requests[0];
    if (!request) return '<p class="network-status">等待其他玩家行动</p>';
    const options = request.options.map((option) => `<button type="button" class="ghost-button" data-network-option="${escapeHtml(option.optionId)}" aria-pressed="${this.selectedIds.includes(option.optionId)}">${escapeHtml(option.label)}</button>`).join("");
    const valid = this.selectedIds.length >= request.min && this.selectedIds.length <= request.max;
    return `<h3>${escapeHtml(request.label)}</h3>
      ${request.cards?.length ? `<div class="network-game-hand">${request.cards.map(privateCardTemplate).join("")}</div>` : ""}
      <div class="network-game-options">${options}</div>
      <button type="button" class="primary-button" data-network-answer="selected" ${valid ? "" : "disabled"}>确认</button>
      ${request.canDecline ? '<button type="button" class="ghost-button" data-network-answer="declined">放弃</button>' : ""}`;
  }

  /*
功能
把 Guest 本地选择提交为关联请求的回答。

调用方
NetworkFlow click dispatch。

输入
click event。

输出
是否已处理。

读取状态
当前请求与选项。

写入状态
本地 selectedIds；提交后等待 Host 更新。

调用函数
submit、render。

边界与不变量
只能选 Host 提供的选项；不修改 client projection 来假装完成结算。
*/
  handleClick(event) {
    const button = event.target.closest("button");
    const request = this.requests[0];
    if (!button || button.disabled || !request) return false;
    const optionId = button.dataset.networkOption;
    if (optionId && request.options.some((option) => option.optionId === optionId)) {
      if (this.selectedIds.includes(optionId)) this.selectedIds = this.selectedIds.filter((id) => id !== optionId);
      else if (request.max === 1) this.selectedIds = [optionId];
      else if (this.selectedIds.length < request.max) this.selectedIds.push(optionId);
      this.render();
      return true;
    }
    const status = button.dataset.networkAnswer;
    if (!status) return false;
    if (status === "declined" && !request.canDecline) return true;
    if (status === "selected" && (this.selectedIds.length < request.min || this.selectedIds.length > request.max)) return true;
    this.submit(request.requestId, { status, selectedIds: status === "selected" ? this.selectedIds : [] });
    return true;
  }
}
