import { TEAM_CONFIG } from "../config/gameConfig.js?build=20260730-response-v3";

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[character]);

const image = (src, alt, className) => `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false">`;

export function candidateCardTemplate(general, index) {
  return `<article class="candidate-card" style="--candidate-order:${index}">
    <div class="candidate-art">${image(general.portrait, `${general.name}半身像`, "candidate-portrait")}<span class="candidate-index">候选 0${index + 1}</span></div>
    <div class="candidate-body">
      <div class="candidate-name-row"><div><small>${escapeHtml(general.loreFaction)}</small><h3>${escapeHtml(general.name)}</h3></div><span class="hp-chip" aria-label="${general.maxHp}点生命">生命 ${general.maxHp}</span></div>
      <div class="tag-row">${general.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      <p class="character-description">${escapeHtml(general.description)}</p>
      <div class="candidate-skills">
        <div class="skill-copy"><h4><span>被动 · ${escapeHtml(general.passiveName)}</span><small>持续</small></h4><p>${escapeHtml(general.passiveDescription)}</p></div>
        <div class="skill-copy"><h4><span>主动 · ${escapeHtml(general.activeName)}</span><small>${general.activeCost} 能量</small></h4><p>${escapeHtml(general.activeDescription)}</p></div>
      </div>
      <button class="primary-button candidate-select" type="button" data-general-id="${escapeHtml(general.id)}">选择 ${escapeHtml(general.name)}</button>
    </div>
  </article>`;
}

export function equipmentSlotTemplate(player, isHuman = false) {
  if (!player.equipment) {
    return `<div class="equipment-slot is-empty" tabindex="0" aria-label="装备槽为空">
      <span class="equipment-outline" aria-hidden="true"></span><div><strong>装备槽</strong><small>尚未装备</small></div>
      <span class="equipment-tooltip" role="tooltip">打出装备牌后会放入这里，并持续提供公开效果。</span>
    </div>`;
  }
  const equipment = player.equipment;
  const summaries = { energyDevice:"回合能量额外+1", recycleDevice:"首次战术后摸1张", defenseDevice:"受突袭前公开判定", battleDevice:"突袭需2张格挡" };
  const stateLabels = { energyDevice:"持续供能", recycleDevice:"待触发", defenseDevice:"待判定", battleDevice:"强化中" };
  const triggered = equipment.definitionId === "recycleDevice" && Boolean(player.turnFlags?.recycleDeviceTriggered);
  const stateLabel = triggered ? "已触发" : stateLabels[equipment.definitionId] ?? "生效中";
  return `<div class="equipment-slot is-equipped ${triggered ? "is-triggered" : "is-ready"}" tabindex="0" aria-label="装备：${escapeHtml(equipment.name)}，${escapeHtml(stateLabel)}">
    <img class="equipment-icon" src="${escapeHtml(equipment.icon || equipment.art)}" alt="" aria-hidden="true">
    <div class="equipment-copy"><strong>${escapeHtml(equipment.name)}</strong><small>${isHuman ? escapeHtml(equipment.description) : escapeHtml(summaries[equipment.definitionId] ?? equipment.description)}</small></div>
    <span class="equipment-state">${escapeHtml(stateLabel)}</span>
    <span class="equipment-tooltip" role="tooltip"><strong>${escapeHtml(equipment.name)}</strong>${escapeHtml(equipment.description)}<em>${escapeHtml(stateLabel)}</em></span>
  </div>`;
}

function lifeCells(player) {
  return Array.from({ length: player.maxHp }, (_, index) => `<span class="life-cell ${index < player.hp ? "is-full" : "is-empty"}" aria-hidden="true"></span>`).join("");
}

export function playerPanelTemplate(player, options = {}) {
  const { humanTeam = player.battleTeam, isHuman = false, isCurrent = false, isLegalTarget = false, isTargeting = false, isThinking = false, distanceInfo = null, distanceState = null } = options;
  const relationship = isHuman ? "is-self" : player.battleTeam === humanTeam ? "is-ally" : "is-enemy";
  const statuses = [
    player.statuses?.exposeWeakness ? [`破势 ${player.statuses.exposeWeakness.stacks}`, "danger"] : null,
    player.statuses?.huntMark ? ["猎印", "mark"] : null,
    player.shield ? [`护盾 ${player.shield}`, "shield"] : null,
    player.hp <= 0 && player.alive ? [`濒死 · 需${1 - player.hp}调息`, "danger"] : null,
    player.turnFlags?.recycleDeviceTriggered ? ["回收已触发", "mark"] : null
  ].filter(Boolean);
  const statusText = isThinking ? "正在思考" : isCurrent ? "正在行动" : player.alive ? "等待行动" : "已阵亡";
  return `<article class="player-seat ${isHuman ? "human-seat" : "cpu-seat"} team-${escapeHtml(player.battleTeam)} ${relationship} ${isCurrent ? "is-active" : ""} ${isLegalTarget ? "target-legal" : ""} ${isTargeting && !isLegalTarget ? "target-illegal" : ""} ${isThinking ? "is-thinking" : ""} ${player.alive ? "" : "is-dead"}" data-player-id="${escapeHtml(player.id)}" tabindex="${isLegalTarget ? "0" : "-1"}" aria-label="${escapeHtml(player.name)}，${TEAM_CONFIG[player.battleTeam].name}，生命${player.hp}点，能量${player.energy}点，手牌${player.hand.length}张${distanceInfo ? `，座位${distanceInfo.seat}，距离${distanceInfo.distance}` : ""}">
    <div class="seat-portrait-wrap">
      ${image(player.general.portrait, `${player.name}肖像`, "seat-portrait")}
      <span class="team-emblem" aria-label="${TEAM_CONFIG[player.battleTeam].name}">${player.battleTeam === "dawn" ? "晨" : "暮"}</span>
      ${!player.alive ? `<span class="death-stamp"><b>${escapeHtml(player.general.glyph)}</b> 阵亡</span>` : ""}
    </div>
    <div class="seat-main">
      <div class="seat-heading"><div><strong>${escapeHtml(player.name)}${isHuman ? " · 你" : ""}</strong><small>${escapeHtml(player.loreFaction)}</small></div><span class="turn-state"><i aria-hidden="true"></i>${statusText}</span></div>
      <div class="vitals">
        <div class="life-readout"><span class="life-label">生命</span><div class="life-cells">${lifeCells(player)}</div><strong>${player.hp}<small>/${player.maxHp}</small></strong></div>
        <div class="resource-pills"><span class="resource-pill energy"><small>能量</small><strong>${player.energy}/${player.maxEnergy}</strong></span><span class="resource-pill shield"><small>护盾</small><strong>${player.shield}</strong></span><span class="resource-pill hand-count"><small>手牌</small><strong>${player.hand.length}</strong></span></div>
      </div>
      <div class="status-row">${statuses.length ? statuses.map(([label, kind]) => `<span class="status-chip is-${kind}">${label}</span>`).join("") : '<span class="status-chip is-steady">状态稳定</span>'}</div>
      ${distanceInfo ? `<div class="range-readout"><span>座位 ${distanceInfo.seat}</span><strong>${escapeHtml(distanceState ?? `距离 ${distanceInfo.distance}`)}</strong><small>${player.alive ? `射程 ${distanceInfo.range}` : "已离开距离环"}</small></div>` : ""}
      ${isHuman ? `<div class="turn-usage"><span>突袭 ${player.turnFlags.attackUsed}/${player.turnFlags.attackLimit}</span><span>调息 ${player.turnFlags.recoverUsed}/${player.turnFlags.recoverLimit === null ? "∞" : player.turnFlags.recoverLimit}</span></div>` : ""}
      ${equipmentSlotTemplate(player, isHuman)}
      ${isHuman ? `<details class="character-details" open><summary>角色能力</summary><p>${escapeHtml(player.general.description)}</p><div class="skill-summary"><strong>${escapeHtml(player.general.passiveName)}</strong><span>${escapeHtml(player.general.passiveDescription)}</span></div></details>` : ""}
    </div>
  </article>`;
}

export function handCardTemplate(card, options = {}) {
  const selected = Boolean(options.selected);
  const disabled = Boolean(options.disabled);
  const tags = card.subtypes.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  return `<button class="hand-card frame-${escapeHtml(card.frameStyle)} ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}" style="--card-accent:${escapeHtml(card.accent)}" type="button" data-card-id="${escapeHtml(card.id)}" data-disabled="${disabled}" aria-disabled="${disabled}" aria-pressed="${selected}">
    <span class="card-topline"><span class="card-name">${escapeHtml(card.name)}</span><span class="card-category">${escapeHtml(card.categoryName)}</span></span>
    <span class="card-art"><img src="${escapeHtml(card.art)}" alt="" aria-hidden="true" draggable="false"><span class="card-crest"><img src="${escapeHtml(card.icon)}" alt="" aria-hidden="true"></span></span>
    <span class="card-rules"><span class="card-description">${escapeHtml(card.description)}</span><span class="card-flavor">${escapeHtml(card.flavorText)}</span></span>
    <span class="card-tags">${tags}</span>
  </button>`;
}

export function resolvingCardTemplate(cardOrName, source = "结算区", targetLabel = "") {
  const targetMarkup = targetLabel
    ? `<span class="resolving-target"><b>作用对象</b>${escapeHtml(targetLabel)}</span>`
    : "";
  if (typeof cardOrName === "object" && cardOrName) {
    return `<div class="resolving-card frame-${escapeHtml(cardOrName.frameStyle)}" style="--card-accent:${escapeHtml(cardOrName.accent)}">
      <img src="${escapeHtml(cardOrName.art)}" alt="" aria-hidden="true"><div><small>${escapeHtml(source)}</small><strong>${escapeHtml(cardOrName.name)}</strong><span class="resolving-kind">${escapeHtml(cardOrName.categoryName)}</span>${targetMarkup}</div>
    </div>`;
  }
  return `<div class="resolving-card is-skill"><span class="skill-sigil" aria-hidden="true">✦</span><div><small>${escapeHtml(source)}</small><strong>${escapeHtml(cardOrName)}</strong><span class="resolving-kind">角色技能</span>${targetMarkup}</div></div>`;
}

export function thinkingTemplate(player, message) {
  return `<img src="${escapeHtml(player?.general?.portrait || "")}" alt="" aria-hidden="true"><div><strong>${escapeHtml(player?.name || "电脑角色")}</strong><span>${escapeHtml(message || "正在思考")}</span></div><i class="thinking-dots" aria-label="思考中"><b></b><b></b><b></b></i>`;
}

export function formatLogMessage(message) {
  return escapeHtml(message)
    .replace(/「([^」]+)」/g, "「<strong class=\"log-card-name\">$1</strong>」")
    .replace(/(\d+)(点伤害)/g, "<strong class=\"log-damage-value\">$1</strong>$2")
    .replace(/(恢复)(\d+)(点生命)/g, "$1<strong class=\"log-heal-value\">$2</strong>$3");
}
