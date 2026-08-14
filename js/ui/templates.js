import { TEAM_CONFIG } from "../config/gameConfig.js?build=20260814-guardian-aid-certain-hand";
import { GENERAL_DEFINITIONS } from "../config/generalConfig.js?build=20260814-guardian-aid-certain-hand";

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[character]);

/** 统一的纯牌背。未知牌不包含名称、序号、说明、图片或可见文字。 */
export function hiddenCardBackTemplate(options = {}) {
  const selectable = Boolean(options.token);
  const tag = selectable ? "button" : "span";
  const tokenAttribute = selectable ? ` type="button" data-hidden-token="${escapeHtml(options.token)}" aria-label="选择一张隐藏卡牌" aria-pressed="${Boolean(options.selected)}"` : ' aria-hidden="true"';
  const classes = ["hidden-card-back", options.compact ? "is-compact" : "", options.selected ? "is-selected" : ""].filter(Boolean).join(" ");
  return `<${tag} class="${classes}"${tokenAttribute}><i aria-hidden="true"></i></${tag}>`;
}

const image = (src, alt, className) => `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false">`;

const LONG_DESCRIPTION_THRESHOLD = 38;
const SKILL_NAMES = new Set(GENERAL_DEFINITIONS.flatMap(
  (general) => [general.activeName, general.passiveName].filter(Boolean)
));
const VERY_LONG_DESCRIPTION_THRESHOLD = 48;

/** 真人手牌与已知对手牌共用的确定性规则文字长度分类。 */
export function cardDescriptionClass(description) {
  const length = String(description ?? "").length;
  if (length >= VERY_LONG_DESCRIPTION_THRESHOLD) return "is-description-very-long";
  if (length >= LONG_DESCRIPTION_THRESHOLD) return "is-description-long";
  return "";
}

export function candidateCardTemplate(general, index) {
  const activeCostLabel = general.activeSkillIds?.[0] === "allIn"
    ? "X 能量"
    : general.activeCostText ?? `${general.activeCost ?? 0} 能量`;
  return `<article class="candidate-card" style="--candidate-order:${index}">
    <div class="candidate-art">${image(general.portrait, `${general.name}半身像`, "candidate-portrait")}<span class="candidate-index">候选 0${index + 1}</span></div>
    <div class="candidate-body">
      <div class="candidate-name-row"><div><small>${escapeHtml(general.loreFaction)}</small><h3>${escapeHtml(general.name)}</h3></div><div class="candidate-badges"><span class="candidate-stat-badge energy-chip" aria-label="能量 ${general.initialEnergy}">能量 ${general.initialEnergy}</span><span class="candidate-stat-badge hp-chip" aria-label="${general.maxHp}点生命">生命 ${general.maxHp}</span></div></div>
      <div class="tag-row">${general.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      <p class="character-description">${escapeHtml(general.description)}</p>
      <div class="candidate-skills">
        <div class="skill-copy"><h4><span>主动 · ${escapeHtml(general.activeName)}</span><small>${escapeHtml(activeCostLabel)}</small></h4><p>${escapeHtml(general.activeDescription)}</p></div>
        <div class="skill-copy"><h4><span>被动 · ${escapeHtml(general.passiveName)}</span><small>持续</small></h4><p>${escapeHtml(general.passiveDescription)}</p></div>
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
  const summaries = { energyDevice:"回合能量额外+1", recycleDevice:"战术后摸1张·每回合2次", defenseDevice:"需要格挡时公开判定", battleDevice:"突袭需2张格挡", telescope:"对外距离-1", barrierDevice:"他人对你距离+1" };
  const stateLabels = { energyDevice:"持续供能", recycleDevice:"待回收", defenseDevice:"待判定", battleDevice:"强化中", telescope:"观测中", barrierDevice:"屏障展开" };
  const recycleUses = player.turnFlags?.recycleDeviceUses ?? 0;
  const triggered = equipment.definitionId === "recycleDevice" && recycleUses >= 2;
  const stateLabel = equipment.definitionId === "recycleDevice" ? `${recycleUses}/2` : stateLabels[equipment.definitionId] ?? "生效中";
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

export function opponentHandStripTemplate(slots = []) {
  const cards = slots.map((slot) => {
    if (!slot.known) return hiddenCardBackTemplate({ compact:true });
    const descriptionClass = cardDescriptionClass(slot.description);
    return `<span class="opponent-card-slot is-known frame-${escapeHtml(slot.frameStyle)}" style="--card-accent:${escapeHtml(slot.accent)}" tabindex="0" title="${escapeHtml(`${slot.categoryName}：${slot.description}`)}" aria-label="已知手牌：${escapeHtml(slot.name)}，${escapeHtml(slot.categoryName)}，${escapeHtml(slot.description)}"><span class="card-topline"><span class="card-name">${escapeHtml(slot.name)}</span><span class="card-category">${escapeHtml(slot.categoryName)}</span></span><span class="card-art"><img src="${escapeHtml(slot.art)}" alt="" aria-hidden="true"><span class="card-crest"><img src="${escapeHtml(slot.icon)}" alt="" aria-hidden="true"></span></span><span class="card-rules ${descriptionClass}"><span class="card-description">${escapeHtml(slot.description)}</span><span class="card-flavor">${escapeHtml(slot.flavorText)}</span></span></span>`;
  }).join("");
  return `<div class="opponent-hand-region"><div class="opponent-hand-strip" aria-label="该角色手牌">${cards}</div></div>`;
}

export function skillDetailsTemplate(player) {
  const general = player?.general ?? {};
  const activeId = general.activeSkillIds?.[0] ?? null;
  const activeCost = activeId === "allIn"
    ? "至少1点；发动时消耗全部能量"
    : general.activeCostText ?? `${general.activeCost ?? 0}点能量`;
  const activeLimit = `每回合限发动${general.activeLimitPerTurn ?? 1}次`;
  const active = general.activeName ? `<section class="skill-detail-section is-active"><div class="skill-detail-heading"><span>主动技能</span><strong>${escapeHtml(general.activeName)}</strong></div><p>${escapeHtml(general.activeDescription)}</p><dl><div><dt>能量消耗</dt><dd>${escapeHtml(activeCost)}</dd></div><div><dt>次数限制</dt><dd>${escapeHtml(activeLimit)}</dd></div></dl></section>` : '<section class="skill-detail-empty">无主动技能</section>';
  const passive = general.passiveName ? `<section class="skill-detail-section is-passive"><div class="skill-detail-heading"><span>被动技能</span><strong>${escapeHtml(general.passiveName)}</strong></div><p>${escapeHtml(general.passiveDescription)}</p><dl><div><dt>发动条件</dt><dd>${escapeHtml(general.passiveTriggerText ?? "满足技能公开条件")}</dd></div><div><dt>触发限制</dt><dd>${escapeHtml(general.passiveLimitText ?? "依技能配置触发")}</dd></div></dl></section>` : '<section class="skill-detail-empty">无被动技能</section>';
  return `<div class="skill-dialog-card" role="document"><button type="button" class="skill-dialog-close" data-skill-dialog-close aria-label="关闭技能详情">×</button><header><img src="${escapeHtml(general.portrait)}" alt="${escapeHtml(player.name)}肖像"><div><small>${escapeHtml(player.loreFaction)}</small><h2 id="skill-details-title">${escapeHtml(player.name)} · 技能详情</h2><span>${escapeHtml(TEAM_CONFIG[player.battleTeam]?.name ?? "")}</span></div></header><div class="skill-dialog-scroll">${active}${passive}</div></div>`;
}

export function playerPanelTemplate(player, options = {}) {
  const { humanTeam = player.battleTeam, isHuman = false, isCurrent = false, isLegalTarget = false, isSelectedTarget = false, isTargeting = false, isThinking = false, distanceInfo = null, distanceState = null, opponentHandSlots = null } = options;
  const relationship = isHuman ? "is-self" : player.battleTeam === humanTeam ? "is-ally" : "is-enemy";
  const statuses = player.alive ? [
    player.statuses?.exposeWeakness ? [`破势 ${player.statuses.exposeWeakness.stacks}`, "danger"] : null,
    player.statuses?.huntMark ? ["猎印", "mark"] : null,
    player.statuses?.sealed ? ["封印", "danger"] : null,
    player.statuses?.lightning ? ["闪电", "danger"] : null,
    player.statuses?.allIn ? ["孤注", "danger"] : null,
    player.turnFlags?.momentum > 0 ? [`连势 ${player.turnFlags.momentum}`, "mark"] : null,
    player.hp <= 0 && player.alive ? [`濒死 · 需${1 - player.hp}调息`, "danger"] : null
  ].filter(Boolean) : [];
  const statusSummary = statuses.length ? statuses.map(([label]) => label).join(" · ") : "—";
  const statusText = isThinking ? "正在思考" : isCurrent ? "正在行动" : player.alive ? "等待行动" : "已阵亡";
  const showDistance = Boolean(player.alive && distanceInfo);
  return `<article class="player-seat ${isHuman ? "human-seat" : "cpu-seat"} team-${escapeHtml(player.battleTeam)} ${relationship} ${isCurrent ? "is-active" : ""} ${isLegalTarget ? "target-legal" : ""} ${isSelectedTarget ? "target-selected" : ""} ${isTargeting && !isLegalTarget ? "target-illegal" : ""} ${isThinking ? "is-thinking" : ""} ${player.alive ? "" : "is-dead"}" data-player-id="${escapeHtml(player.id)}" tabindex="${isLegalTarget ? "0" : "-1"}" aria-label="${escapeHtml(player.name)}，${TEAM_CONFIG[player.battleTeam].name}，生命${player.hp}点，能量${player.energy}点，手牌${player.hand.length}张，状态${escapeHtml(statusSummary === "—" ? "无" : statusSummary)}${showDistance ? `，距离${distanceInfo.distance}` : ""}">
    <button type="button" class="seat-portrait-wrap" data-skill-player-id="${escapeHtml(player.id)}" aria-label="查看${escapeHtml(player.name)}的技能">
      ${image(player.general.portrait, `${player.name}肖像`, "seat-portrait")}
      <span class="team-emblem" aria-label="${TEAM_CONFIG[player.battleTeam].name}">${player.battleTeam === "dawn" ? "晨" : "暮"}</span>
      ${!player.alive ? `<span class="death-stamp"><b>${escapeHtml(player.general.glyph)}</b> 阵亡</span>` : ""}
    </button>
    <div class="seat-main">
      <div class="seat-heading"><button type="button" class="seat-name-button" data-skill-player-id="${escapeHtml(player.id)}"><strong>${escapeHtml(player.name)}${isHuman ? " · 你" : ""}</strong><small>${escapeHtml(player.loreFaction)}</small></button><span class="turn-state"><i aria-hidden="true"></i>${statusText}</span></div>
      <div class="vitals">
        <div class="life-readout"><span class="life-label">生命</span><div class="life-cells">${lifeCells(player)}</div><strong>${player.hp}<small>/${player.maxHp}</small></strong></div>
        <div class="resource-pills"><span class="resource-pill energy"><small>能量</small><strong>${player.energy}/${player.maxEnergy}</strong></span><span class="resource-pill shield"><small>护盾</small><strong>${player.shield}</strong></span><span class="resource-pill hand-count"><small>手牌</small><strong>${player.hand.length}</strong></span></div>
      </div>
      <div class="range-readout ${showDistance ? "" : "is-status-only"}"><span class="panel-status" title="状态：${escapeHtml(statusSummary === "—" ? "无" : statusSummary)}"><small>状态</small><b>${escapeHtml(statusSummary)}</b></span>${showDistance ? `<strong>${escapeHtml(distanceState ?? `距离 ${distanceInfo.distance}`)}</strong><small>射程 ${distanceInfo.range}</small>` : ""}</div>
      ${equipmentSlotTemplate(player, isHuman)}
    </div>
    ${!isHuman ? opponentHandStripTemplate(opponentHandSlots ?? Array.from({ length:player.hand.length }, () => ({ known:false }))) : ""}
  </article>`;
}

function cardFaceTemplate(card) {
  const descriptionClass = cardDescriptionClass(card.description);
  return `<span class="card-topline"><span class="card-name">${escapeHtml(card.name)}</span><span class="card-category">${escapeHtml(card.categoryName)}</span></span>
    <span class="card-art"><img src="${escapeHtml(card.art)}" alt="" aria-hidden="true" draggable="false"><span class="card-crest"><img src="${escapeHtml(card.icon)}" alt="" aria-hidden="true"></span></span>
    <span class="card-rules ${descriptionClass}"><span class="card-description">${escapeHtml(card.description)}</span><span class="card-flavor">${escapeHtml(card.flavorText)}</span></span>`;
}

export function handCardTemplate(card, options = {}) {
  const selected = Boolean(options.selected);
  const disabled = Boolean(options.disabled);
  const cardIdAttribute = options.response ? "data-response-card-id" : "data-card-id";
  return `<button class="hand-card frame-${escapeHtml(card.frameStyle)} ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}" style="--card-accent:${escapeHtml(card.accent)}" type="button" ${cardIdAttribute}="${escapeHtml(card.id)}" data-disabled="${disabled}" aria-disabled="${disabled}" aria-pressed="${selected}">
    ${cardFaceTemplate(card)}
  </button>`;
}

/** 私密展示复用真人手牌的完整牌面，但不暴露可用于交互的实体 card.id。 */
export function privateCardTemplate(card) {
  return `<article class="hand-card private-card frame-${escapeHtml(card.frameStyle)}" style="--card-accent:${escapeHtml(card.accent)}" aria-label="${escapeHtml(`${card.name}，${card.categoryName}，${card.description}`)}">
    ${cardFaceTemplate(card)}
  </article>`;
}

/** 隐藏选择中的已知牌使用标准牌面，只向 DOM 写入不透明选择 token。 */
export function hiddenKnownCardTemplate(card, token, options = {}) {
  const zoneLabel = options.zone === "equipment" ? "装备" : "已知手牌";
  const zoneClass = options.zone === "equipment" ? " is-equipment-option" : "";
  return `<button type="button" class="hand-card hidden-known-card frame-${escapeHtml(card.frameStyle)}${zoneClass}" style="--card-accent:${escapeHtml(card.accent)}" data-hidden-token="${escapeHtml(token)}" aria-label="选择${zoneLabel}${escapeHtml(card.name)}" aria-pressed="false">
    ${cardFaceTemplate(card)}
  </button>`;
}

/** 公开牌池复用标准牌面；公开实体 ID 仅用于本池的选择确认。 */
export function publicPoolCardTemplate(card, options = {}) {
  const selected = Boolean(options.selected);
  return `<button type="button" class="hand-card tableau-card frame-${escapeHtml(card.frameStyle)} ${selected ? "is-selected" : ""}" style="--card-accent:${escapeHtml(card.accent)}" data-public-card-id="${escapeHtml(card.id)}" aria-label="选择${escapeHtml(card.name)}" aria-pressed="${selected}">
    ${cardFaceTemplate(card)}
  </button>`;
}

export function resolvingCardTemplate(cardOrName, source = "结算区", targetLabel = "", displayTargets = null) {
  const displayTargetMarkup = Array.isArray(displayTargets) && displayTargets.length
    ? displayTargets.map((target) => {
        const targetName = typeof target === "string" ? target : target?.name ?? "";
        const selfSuffix = target && typeof target === "object" && target.isSelf ? "（自己）" : "";
        return escapeHtml(`${targetName}${selfSuffix}`);
      }).join("、")
    : "";
  const targetMarkup = targetLabel
    ? `<span class="resolving-target"><b>作用对象</b>${escapeHtml(targetLabel)}</span>`
    : displayTargetMarkup
      ? `<span class="resolving-target"><b>作用对象</b>${displayTargetMarkup}</span>`
      : "";
  if (typeof cardOrName === "object" && cardOrName) {
    return `<div class="resolving-card frame-${escapeHtml(cardOrName.frameStyle)}" style="--card-accent:${escapeHtml(cardOrName.accent)}">
      <img src="${escapeHtml(cardOrName.art)}" alt="" aria-hidden="true"><div><small>${escapeHtml(source)}</small><strong>${escapeHtml(cardOrName.name)}</strong><span class="resolving-kind">${escapeHtml(cardOrName.categoryName)}</span>${targetMarkup}</div>
    </div>`;
  }
  return `<div class="resolving-card is-skill"><span class="skill-sigil" aria-hidden="true">✦</span><div><small>${escapeHtml(source)}</small><strong>${escapeHtml(cardOrName)}</strong><span class="resolving-kind">角色技能</span>${targetMarkup}</div></div>`;
}

export function emptyResolvingCardTemplate() {
  return `<div class="resolving-card is-empty"><span class="skill-sigil" aria-hidden="true">◇</span><div><small>中央结算区</small><strong>等待第一张牌</strong><span>行动会在这里公开展示</span></div></div>`;
}

export function thinkingTemplate(player, message) {
  return `<img src="${escapeHtml(player?.general?.portrait || "")}" alt="" aria-hidden="true"><div><strong>${escapeHtml(player?.name || "电脑角色")}</strong><span>${escapeHtml(message || "正在思考")}</span></div><i class="thinking-dots" aria-label="思考中"><b></b><b></b><b></b></i>`;
}

export function formatLogMessage(message) {
  return escapeHtml(message)
    .replace(/(发动|触发|因)?「([^」]+)」(状态)?/g, (_match, verb = "", name, suffix = "") => {
      const isSkillContext = SKILL_NAMES.has(name)
        && (verb === "发动" || verb === "触发" || (verb === "因" && !suffix));
      if (isSkillContext) {
        return `${verb}<strong class="log-skill-name">「${name}」</strong>${suffix}`;
      }
      return `${verb}「<strong class="log-card-name">${name}</strong>」${suffix}`;
    })
    .replace(/(\d+)(点伤害)/g, "<strong class=\"log-damage-value\">$1</strong>$2")
    .replace(/(恢复)(\d+)(点生命)/g, "$1<strong class=\"log-heal-value\">$2</strong>$3");
}

/** 渲染结构化日志；角色 token 的阵营类只来自 battleTeam，所有文本都先转义。 */
export function formatLogEntry(entry) {
  const fragments = Array.isArray(entry?.fragments) ? entry.fragments : [{ type:"text", text:entry?.message ?? "" }];
  return fragments.map((fragment) => {
    if (fragment.type !== "player") return formatLogMessage(fragment.text);
    const teamClass = fragment.battleTeam === "dawn" || fragment.battleTeam === "dusk"
      ? ` team-${fragment.battleTeam}`
      : "";
    return `<strong class="log-player-name${teamClass}" data-player-id="${escapeHtml(fragment.playerId)}">${escapeHtml(fragment.text)}</strong>`;
  }).join("");
}
