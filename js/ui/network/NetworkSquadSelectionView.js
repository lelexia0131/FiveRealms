import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { NETWORK_STATE as S } from "../../network/NetworkLobbyState.js";
import { candidateCardTemplate, escapeHtml } from "../templates.js";
import { TEAM_PRESENTATION } from "../../adapters/ui/PresentationMetadata.js";

const STATUS = Object.freeze({
  [S.CREATING]: "正在创建房间", [S.JOINING]: "正在连接房间",
  [S.WAITING_PEER]: "等待另一名玩家连接", [S.SELECTING]: "对方已连接",
  [S.WAITING_REMOTE]: "已确认 · 等待另一名玩家",
  [S.LOADING_GAME]: "双方已准备 · 等待进入游戏", [S.IN_GAME]: "双方游戏已就绪",
  [S.DISCONNECTED]: "连接已断开"
});

/*
功能
渲染双方共用的征召页，只读取本地候选投影。

调用方
NetworkFlow。

输入
NetworkSession.snapshot 与本地表单 draft。

输出
安全 HTML。

读取状态
本地候选 ID、席位、Ready 和状态。

写入状态
无。

调用函数
candidateCardTemplate、escapeHtml。

边界与不变量
没有另外四名角色的 DOM；等待连接、已确认和断线时禁止选择。
*/
export function renderNetworkSquadSelectionView(snapshot, draft = {}) {
  const editable = snapshot.state === S.SELECTING;
  const selected = { ...snapshot.localSelection, ...draft };
  const cards = snapshot.candidates.map((id, index) => {
    let card = candidateCardTemplate(CHARACTER_BY_ID[id], index);
    card = card.replace('class="candidate-card"', `class="candidate-card${selected.characterId === id ? " network-selected" : ""}"`);
    return card.replace('data-character-id=', `${editable ? "" : "disabled"} aria-pressed="${selected.characterId === id}" data-character-id=`);
  }).join("");
  const seats = snapshot.seats.map((seat, index) => {
    const occupied = snapshot.remoteSelection?.seatId === seat.seatId;
    return `<button type="button" class="network-seat ${seat.teamId}" data-network-seat="${escapeHtml(seat.seatId)}"
      aria-pressed="${selected.seatId === seat.seatId}" ${!editable || occupied ? "disabled" : ""}>
      <span>${TEAM_PRESENTATION[seat.teamId].name}</span><strong>席位 ${index + 1}</strong><small>${occupied ? "对方已选择" : selected.seatId === seat.seatId ? "你的席位" : "可选择"}</small></button>`;
  }).join("");
  return `<div class="network-squad"><header class="selection-header"><div><p class="eyebrow">双人征召 · ${snapshot.role === "HOST" ? "房主" : "加入方"}</p><h2>选择你的角色与席位</h2></div>
    <span class="network-status" role="status">${STATUS[snapshot.state] ?? ""}</span></header>
    ${cards ? `<div class="candidate-grid">${cards}</div><div class="network-seat-row" aria-label="阵营与席位">${seats}</div>`
      : `<div class="network-waiting"><span class="network-wait-sigil" aria-hidden="true">✧</span><h3>${STATUS[snapshot.state]}</h3><p>双方连接后，开启各自的四名角色征召。</p></div>`}
    <footer class="network-squad-footer"><button class="ghost-button" type="button" data-network-action="cancel">取消并返回</button>
      <p class="network-notice" role="status">${escapeHtml(snapshot.error ?? "晨星 2 席 · 暮影 3 席 · 剩余席位由电脑角色补齐")}</p>
      <button class="primary-button" type="button" data-network-action="confirm" ${!editable || !snapshot.localSelection || selected.characterId !== snapshot.localSelection.characterId || selected.seatId !== snapshot.localSelection.seatId ? "disabled" : ""}>${snapshot.localReady ? "已确认" : "确认角色与席位"}</button>
    </footer></div>`;
}
