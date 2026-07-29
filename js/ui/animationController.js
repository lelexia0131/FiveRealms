/** 将 Game 提交的公开事件映射为短暂 CSS 反馈；本类从不修改任何游戏状态。 */
export class AnimationController {
  constructor() { this.pending = []; }

  queue(type, playerId = null, amount = null) { this.pending.push({ type, playerId, amount }); }

  flush(root = document) {
    for (const feedback of this.pending.splice(0)) {
      const panel = feedback.playerId ? root.querySelector(`[data-player-id="${CSS.escape(feedback.playerId)}"]`) : null;
      const target = panel || root.querySelector(".command-deck");
      if (!target) continue;
      target.classList.add(`feedback-${feedback.type}`);
      target.addEventListener("animationend", () => target.classList.remove(`feedback-${feedback.type}`), { once: true });
      if (feedback.amount && ["damage", "heal", "energy", "shield"].includes(feedback.type)) {
        const floating = document.createElement("span");
        floating.className = `floating-feedback is-${feedback.type}`;
        floating.textContent = `${feedback.type === "damage" ? "−" : "+"}${feedback.amount}`;
        floating.addEventListener("animationend", () => floating.remove(), { once: true });
        target.append(floating);
      }
    }
  }

  clear() { this.pending.length = 0; }
}
