/**
 * 真人多阶段交互控制器。只把公开玩家 ID 或不透明隐藏 token 放入 DOM，并将
 * 最终意图交回 Game；不修改生命、能量、手牌、装备、状态或胜负。
 */
import { escapeHtml, hiddenCardBackTemplate, hiddenKnownCardTemplate } from "./templates.js?build=20260814-ai-controller-di";
import { createHiddenSelectionView } from "./handVisibility.js?build=20260814-ai-controller-di";
import { isCardSelectionValid, toggleCardSelection } from "./selectionUtils.js?build=20260814-ai-controller-di";
import { RuleEngine } from "../core/RuleEngine.js?build=20260814-ai-controller-di";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260814-ai-controller-di";

const EQUIPMENT_OPTION_TOKEN = "public-equipment";

export function hiddenSelectionMarkup(selection, slots = null) {
  const displaySlots = slots ?? selection.tokens.map((entry) => ({ token:entry.token, known:false }));
  return displaySlots.map((slot) => slot.known
    ? hiddenKnownCardTemplate(slot, slot.token, { zone:slot.zone })
    : hiddenCardBackTemplate({ token:slot.token, compact:true })
  ).join("");
}

/** 多阶段真人选择器。只把公开 ID 或不透明令牌交给 DOM。 */
export class InteractionController {
  constructor(ui) { this.ui = ui; this.pending = null; }

  bind(root) {
    root.addEventListener("click", (event) => {
      const hidden = event.target.closest("[data-hidden-token]");
      if (hidden) this.toggleHidden(hidden.dataset.hiddenToken);
      const confirm = event.target.closest("[data-interaction-confirm]");
      if (confirm) this.confirm();
      const cancel = event.target.closest("[data-interaction-cancel]");
      if (cancel) this.cancel();
    });
  }

  async requestCardFlow(game, actor, card, initialTargets) {
    const gameId = game.state.gameId;
    if (!game.isSessionValid(gameId)) return null;
    if (card.definitionId === "leverage") {
      // 项目当前每人只有一个公开装备槽，故装备阶段可按规则自动选中唯一真实实例。
      const firstTargets = RuleEngine.getLeverageFirstTargets(game, actor);
      const firstTarget = await this.ui.requestTarget(firstTargets, "选择一名有装备且有可选第二目标的其他角色", {
        source:actor, card, confirmSelection:true, stepTitle:"借势 · 第一目标"
      });
      if (!game.isSessionValid(gameId) || !firstTarget) return null;
      const equipment = firstTarget.equipment;
      if (!equipment?.id || !RuleEngine.getLeverageFirstTargets(game, actor).includes(firstTarget)) return null;

      const secondTargets = RuleEngine.getAssaultTargetCandidates(game, firstTarget);
      const secondTarget = await this.ui.requestTarget(secondTargets, "选择其攻击范围内的一名其他角色", {
        source:firstTarget, card:CARD_DEFINITIONS.assault, confirmSelection:true, stepTitle:"借势 · 第二目标"
      });
      if (!game.isSessionValid(gameId) || !secondTarget) return null;
      if (firstTarget.equipment !== equipment || equipment.id == null
        || !RuleEngine.getAssaultTargetCandidates(game, firstTarget).includes(secondTarget)) return null;

      const confirmed = await this.requestConfirmation(
        "借势 · 确认",
        `${actor.name}要求${firstTarget.name}对${secondTarget.name}使用「突袭」；若拒绝，${actor.name}将获得其「${equipment.name}」。`
      );
      if (!confirmed || !game.isSessionValid(gameId)) return null;
      return {
        firstTargetId:firstTarget.id,
        equipmentCardId:equipment.id,
        secondTargetId:secondTarget.id
      };
    }
    if (card.definitionId === "transfer") {
      const sources = RuleEngine.getTransferSources(game, actor, card).filter((from) => RuleEngine.getTransferReceivers(game, actor, from, card).length);
      const source = await this.ui.requestTarget(sources, "转移：选择距离1内的牌来源", { source:actor, card });
      if (!game.isSessionValid(gameId)) return null;
      if (!source) return null;
      const receivers = RuleEngine.getTransferReceivers(game, actor, source, card);
      const receiver = await this.ui.requestTarget(receivers, "转移：选择距离1内的接收者", { source:actor, card });
      if (!game.isSessionValid(gameId)) return null;
      if (!receiver) return null;
      const selected = await this.requestHandCard(game, actor, source, "转移：选择1张手牌", new Set([card.id]));
      if (!game.isSessionValid(gameId)) return null;
      return selected ? { sourceId:source.id, receiverId:receiver.id, ...selected } : null;
    }
    if (["plunder","destroy"].includes(card.definitionId)) {
      const target = initialTargets[0];
      if (!target) return null;
      return this.requestZoneCard(game, actor, target, `${card.name}：选择1张手牌或装备牌`);
    }
    if (card.definitionId === "scout") {
      const target = initialTargets[0];
      if (!target) return null;
      const hidden = game.cardSelectionSystem.createHiddenSelection(target);
      const count = Math.min(2, target.hand.length);
      const slots = createHiddenSelectionView(actor, target, hidden);
      const tokens = await this.requestHiddenCards(hidden, count, `${card.name}：选择至多2张隐藏手牌`, { exact:false, slots });
      if (!game.isSessionValid(gameId)) return null;
      return tokens?.length ? { tokens, selectionId:hidden.selectionId } : null;
    }
    return {};
  }

  async requestZoneCard(game, actor, owner, prompt, excludedCardIds = null) {
    const gameId = game.state.gameId;
    if (!game.isSessionValid(gameId)) return null;
    const eligibleHand = owner?.hand?.filter((card) => !excludedCardIds?.has(card.id)) ?? [];
    if (!eligibleHand.length && !owner?.equipment) return null;
    const hidden = game.cardSelectionSystem.createHiddenSelection(owner, eligibleHand);
    const slots = createHiddenSelectionView(actor, owner, hidden);
    if (owner.equipment) {
      const { name, categoryName, description, art, icon, accent, frameStyle, flavorText } = owner.equipment;
      slots.push({ token:EQUIPMENT_OPTION_TOKEN, known:true, zone:"equipment", name, categoryName, description, art, icon, accent, frameStyle, flavorText });
    }
    const selected = await this.requestHiddenCards(hidden, 1, prompt, { exact:true, slots, totalCount:slots.length });
    if (!game.isSessionValid(gameId)) return null;
    if (!selected?.length) return null;
    if (selected[0] === EQUIPMENT_OPTION_TOKEN) return { zone:"equipment", equipmentCardId:owner.equipment?.id ?? null, selectionId:hidden.selectionId };
    return { zone:"hand", tokens:selected, selectionId:hidden.selectionId };
  }

  /** 转移专用：只呈现隐藏手牌槽位，不把公开装备加入候选。 */
  async requestHandCard(game, actor, owner, prompt, excludedCardIds = null) {
    const gameId = game.state.gameId;
    if (!game.isSessionValid(gameId)) return null;
    const eligibleHand = owner?.hand?.filter((card) => !excludedCardIds?.has(card.id)) ?? [];
    if (!eligibleHand.length) return null;
    const hidden = game.cardSelectionSystem.createHiddenSelection(owner, eligibleHand);
    const slots = createHiddenSelectionView(actor, owner, hidden);
    const selected = await this.requestHiddenCards(hidden, 1, prompt, { exact:true, slots, totalCount:slots.length });
    if (!game.isSessionValid(gameId)) return null;
    if (!selected?.length) return null;
    return { zone:"hand", tokens:selected, selectionId:hidden.selectionId };
  }

  requestHiddenCards(selection, count, prompt, options = {}) {
    this.cancel();
    return new Promise((resolve) => {
      const selected = new Set();
      const slots = options.slots ?? createHiddenSelectionView(options.viewer, options.owner, selection);
      this.pending = { type:"hidden", selection, count, exact:Boolean(options.exact), selected, resolve };
      this.ui.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(prompt)}</strong><span>${options.totalCount ?? selection.tokens.length}张</span></div>
        <div class="hidden-card-grid">${hiddenSelectionMarkup(selection, slots)}</div>
        <div class="response-actions"><button class="primary-button" type="button" data-interaction-confirm disabled>确认选择</button><button class="ghost-button" type="button" data-interaction-cancel>取消</button></div>`;
      this.ui.elements.response_panel.classList.remove("is-hidden");
      if (this.ui.game) this.ui.render(this.ui.game);
    });
  }

  requestConfirmation(title, summary) {
    this.cancel();
    return new Promise((resolve) => {
      this.pending = { type:"confirm", resolve };
      this.ui.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(title)}</strong><span>三项选择已完成</span></div><div class="response-copy"><p class="response-event">${escapeHtml(summary)}</p><p class="response-requirement">确认后才会消耗「借势」并进入响应。</p></div><div class="response-actions"><button class="primary-button" type="button" data-interaction-confirm>确认使用</button><button class="ghost-button" type="button" data-interaction-cancel>取消</button></div>`;
      this.ui.elements.response_panel.classList.remove("is-hidden");
      if (this.ui.game) this.ui.render(this.ui.game);
    });
  }

  toggleHidden(token) {
    if (this.pending?.type !== "hidden") return;
    this.ui.playSound?.("select");
    this.pending.selected = toggleCardSelection(this.pending.selected, token, this.pending.count);
    for (const button of this.ui.elements.response_panel.querySelectorAll("[data-hidden-token]")) {
      const active = this.pending.selected.has(button.dataset.hiddenToken);
      button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active));
    }
    const confirm = this.ui.elements.response_panel.querySelector("[data-interaction-confirm]");
    if (confirm) confirm.disabled = !isCardSelectionValid(this.pending.selected, this.pending.count, this.pending.exact);
  }

  confirm() {
    if (!this.pending) return;
    this.settle(this.pending.type === "confirm" ? true : [...this.pending.selected]);
  }
  cancel() { if (this.pending) this.settle(null); }
  settle(value) {
    const current = this.pending;
    if (!current) return;
    this.pending = null;
    this.ui.elements.response_panel.classList.add("is-hidden");
    this.ui.elements.response_panel.innerHTML = "";
    if (value === null && current.selection?.selectionId) this.ui.game?.cardSelectionSystem.clearSelection(current.selection.selectionId);
    current.resolve(value);
    if (this.ui.game) this.ui.render(this.ui.game);
  }
}
