/**
 * 真人多阶段交互控制器。只把公开玩家 ID 或不透明隐藏 token 放入 DOM，并将
 * 最终意图交回 Game；不修改生命、能量、手牌、装备、状态或胜负。
 */
import { escapeHtml, hiddenCardBackTemplate } from "./templates.js?build=20260730-tabletop-hands-v25";
import { createHiddenSelectionView } from "./handVisibility.js?build=20260730-tabletop-hands-v25";
import { isCardSelectionValid, toggleCardSelection } from "./selectionUtils.js?build=20260730-tabletop-hands-v25";

export function hiddenSelectionMarkup(selection, slots = null) {
  const displaySlots = slots ?? selection.tokens.map((entry) => ({ token:entry.token, known:false }));
  return displaySlots.map((slot) => slot.known
    ? `<button type="button" class="hidden-known-card" data-hidden-token="${escapeHtml(slot.token)}" aria-label="选择已知手牌${escapeHtml(slot.name)}" aria-pressed="false"><img src="${escapeHtml(slot.art)}" alt="" aria-hidden="true"><strong>${escapeHtml(slot.name)}</strong></button>`
    : hiddenCardBackTemplate({ token:slot.token })
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
    if (card.definitionId === "transfer") {
      const sources = game.state.players.filter((player) => player.alive && player.hand.length > 0);
      const source = await this.ui.requestTarget(sources, "转移：选择手牌来源");
      if (!source) return null;
      const receivers = game.state.players.filter((player) => player.alive && player.id !== source.id);
      const receiver = await this.ui.requestTarget(receivers, "转移：选择接收者");
      if (!receiver) return null;
      if (source.id === actor.id) return { sourceId:source.id, receiverId:receiver.id };
      const hidden = game.cardSelectionSystem.createHiddenSelection(source);
      const slots = createHiddenSelectionView(actor, source, hidden);
      const tokens = await this.requestHiddenCards(hidden, 1, "转移：选择1张隐藏手牌", { exact:true, slots });
      return tokens?.length ? { sourceId:source.id, receiverId:receiver.id, tokens, selectionId:hidden.selectionId } : null;
    }
    if (["scout","plunder","destroy"].includes(card.definitionId)) {
      const target = initialTargets[0];
      if (!target) return null;
      const hidden = game.cardSelectionSystem.createHiddenSelection(target);
      const count = card.definitionId === "scout" ? Math.min(2, target.hand.length) : 1;
      const slots = createHiddenSelectionView(actor, target, hidden);
      const tokens = await this.requestHiddenCards(hidden, count, `${card.name}：选择${card.definitionId === "scout" ? "至多2" : "1"}张隐藏手牌`, { exact:card.definitionId !== "scout", slots });
      return tokens?.length ? { tokens, selectionId:hidden.selectionId } : null;
    }
    return {};
  }

  requestHiddenCards(selection, count, prompt, options = {}) {
    this.cancel();
    return new Promise((resolve) => {
      const selected = new Set();
      const slots = options.slots ?? createHiddenSelectionView(options.viewer, options.owner, selection);
      this.pending = { type:"hidden", selection, count, exact:Boolean(options.exact), selected, resolve };
      this.ui.elements.response_panel.innerHTML = `<div class="response-title"><strong>${escapeHtml(prompt)}</strong><span>${selection.tokens.length} 张</span></div>
        <p>隐藏卡牌只携带临时令牌，确认时核心会重新校验手牌版本。</p>
        <div class="hidden-card-grid">${hiddenSelectionMarkup(selection, slots)}</div>
        <div class="response-actions"><button class="primary-button" type="button" data-interaction-confirm disabled>确认选择</button><button class="ghost-button" type="button" data-interaction-cancel>取消</button></div>`;
      this.ui.elements.response_panel.classList.remove("is-hidden");
      if (this.ui.game) this.ui.render(this.ui.game);
    });
  }

  toggleHidden(token) {
    if (this.pending?.type !== "hidden") return;
    this.pending.selected = toggleCardSelection(this.pending.selected, token, this.pending.count);
    for (const button of this.ui.elements.response_panel.querySelectorAll("[data-hidden-token]")) {
      const active = this.pending.selected.has(button.dataset.hiddenToken);
      button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active));
    }
    const confirm = this.ui.elements.response_panel.querySelector("[data-interaction-confirm]");
    if (confirm) confirm.disabled = !isCardSelectionValid(this.pending.selected, this.pending.count, this.pending.exact);
  }

  confirm() { if (this.pending) this.settle([...this.pending.selected]); }
  cancel() { if (this.pending) this.settle(null); }
  settle(value) {
    const current = this.pending;
    if (!current) return;
    this.pending = null;
    this.ui.elements.response_panel.classList.add("is-hidden");
    this.ui.elements.response_panel.innerHTML = "";
    if (value === null) this.ui.game?.cardSelectionSystem.clearSelection(current.selection.selectionId);
    current.resolve(value);
    if (this.ui.game) this.ui.render(this.ui.game);
  }
}
