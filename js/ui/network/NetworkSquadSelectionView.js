import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { NETWORK_STATE as S } from "../../network/NetworkLobbyState.js";
import { formatNetworkAddress } from "../../network/NetworkProtocol.js";
import { networkParticipantLabel } from "../../network/NetworkSetup.js";
import { candidateCardTemplate, escapeHtml } from "../templates.js";
import { TEAM_PRESENTATION } from "../../adapters/ui/PresentationMetadata.js";

const STATUS = Object.freeze({
  [S.CREATING]: "正在创建房间", [S.JOINING]: "正在连接房间",
  [S.WAITING_PEER]: "等待房间信息", [S.SELECTING]: "请选择角色与席位",
  [S.WAITING_REMOTE]: "已确认 · 等待 Host 开始",
  [S.LOADING_GAME]: "房间已锁定 · 等待成员就绪", [S.IN_GAME]: "游戏已就绪",
  [S.DISCONNECTED]: "连接已断开"
});

/*
功能
从多人房间 authority 渲染征召、成员和 Host 管理操作。

调用方
NetworkFlow。

输入
session snapshot 与本地表单 draft。

输出
转义后的 HTML。

读取状态
成员 selection、稳定 ordinal、地址、capacity 和 canStart。

写入状态
无。

调用函数
candidateCardTemplate、networkParticipantLabel、formatNetworkAddress、escapeHtml。

边界与不变量
UI 不计算房间人数或决定权限；禁用其他真人已占用的角色及席位。
*/

export function renderNetworkSquadSelectionView(snapshot, draft = {}) {
  const editable = snapshot.state === S.SELECTING && !snapshot.localReady;
  const isHost = snapshot.role === "HOST";
  const participants = Object.values(snapshot.participants ?? {});
  const others = participants.filter((participant) => participant.participantId !== snapshot.participantId);
  const selected = { ...snapshot.localSelection, ...draft };
  const info = snapshot.connectionInfo;
  const connectionCard = isHost && !snapshot.locked ? `<div class="network-connection-card">
    <p class="eyebrow">连接地址</p>
    ${info ? `<code class="network-connection-address">${escapeHtml(info.host)}:${escapeHtml(info.port)}</code>
      <p>将此连接地址发送给要加入的玩家。</p>
      <button class="ghost-button" type="button" data-network-action="copy-address">复制连接地址</button>
      <p class="network-copy-status" data-network-copy-status role="status"></p>`
      : "<p>连接地址将在网络服务启动后显示</p>"}
  </div>` : "";
  const members = participants.map((participant) => `<div class="network-member">
    <strong>${escapeHtml(networkParticipantLabel(participant))}</strong>
    <span>${escapeHtml(formatNetworkAddress(participant.remoteAddress))}</span>
    <small>${participant.connected ? participant.ready ? "已确认" : "选择中" : "已离线"}</small>
    ${isHost && participant.role === "GUEST" && participant.connected ? `<button class="ghost-button" type="button" data-network-action="kick" data-participant-id="${escapeHtml(participant.participantId)}">踢出</button>` : ""}
  </div>`).join("");
  const capacity = isHost && !snapshot.locked ? `<div class="network-capacity" aria-label="真人人数上限"><span>真人上限</span>
    ${[2, 3, 4, 5].map((count) => `<button class="ghost-button" type="button" data-network-action="capacity" data-capacity="${count}" aria-pressed="${snapshot.maxHumanCount === count}" ${count < snapshot.currentHumanCount ? "disabled" : ""}>${count}</button>`).join("")}</div>` : "";
  const cards = snapshot.candidates.map((id, index) => {
    const occupied = others.some((participant) => participant.selection?.characterId === id);
    let card = candidateCardTemplate(CHARACTER_BY_ID[id], index);
    card = card.replace('class="candidate-card"', `class="candidate-card${selected.characterId === id ? " network-selected" : ""}"`);
    return card.replace("data-character-id=", `${editable && !occupied ? "" : "disabled"} aria-pressed="${selected.characterId === id}" data-character-id=`);
  }).join("");
  const seats = snapshot.seats.map((seat, index) => {
    const owner = others.find((participant) => participant.selection?.seatId === seat.seatId);
    return `<button type="button" class="network-seat ${seat.teamId}" data-network-seat="${escapeHtml(seat.seatId)}"
      aria-pressed="${selected.seatId === seat.seatId}" ${!editable || owner ? "disabled" : ""}>
      <span>${TEAM_PRESENTATION[seat.teamId].name}</span><strong>席位 ${index + 1}</strong>
      <small>${owner ? escapeHtml(networkParticipantLabel(owner)) : selected.seatId === seat.seatId ? "你的席位" : "可选择"}</small></button>`;
  }).join("");
  return `<div class="network-squad"><header class="selection-header">
    <div><p class="eyebrow">多人征召 · ${isHost ? "房主" : "房间成员"}</p><h2>选择你的角色与席位</h2></div>
    <div class="network-room-status"><strong>房间 ${snapshot.currentHumanCount ?? 0} / ${snapshot.maxHumanCount ?? 2}</strong>
    <span class="network-status" role="status">${STATUS[snapshot.state] ?? ""}</span></div></header>
    <div class="network-room-info">${connectionCard}<div class="network-members">${members}${capacity}</div></div>
    ${cards ? `<div class="candidate-grid">${cards}</div><div class="network-seat-row" aria-label="阵营与席位">${seats}</div>`
      : `<div class="network-waiting"><h3>${STATUS[snapshot.state] ?? ""}</h3></div>`}
    <footer class="network-squad-footer"><button class="ghost-button" type="button" data-network-action="cancel">取消并返回</button>
      <p class="network-notice" role="status">${escapeHtml(snapshot.error ?? "晨星 2 席 · 暮影 3 席 · 剩余席位由电脑角色补齐")}</p>
      <button class="primary-button" type="button" data-network-action="confirm" ${!editable || !snapshot.localSelection || selected.characterId !== snapshot.localSelection.characterId || selected.seatId !== snapshot.localSelection.seatId ? "disabled" : ""}>${snapshot.localReady ? "已确认" : "确认角色与席位"}</button>
      ${isHost ? `<button class="primary-button" type="button" data-network-action="start" ${snapshot.canStart ? "" : "disabled"}>开始游戏</button>` : ""}
    </footer></div>`;
}
