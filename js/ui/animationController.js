/** 闪电采样约 3.2 秒；视觉在 3 秒自然收束，避免声音尾部结束后仍残留强光。 */
export const LIGHTNING_HIT_DURATION_MS = 3000;

/** 将 Game 提交的公开事件映射为短暂 CSS 反馈；本类从不修改任何游戏状态。 */
export class AnimationController {
  constructor() {
    this.pending = [];
    this.activeLightning = new Map();
    this.lightningSerial = 0;
  }

  queue(type, playerId = null, amount = null) { this.pending.push({ type, playerId, amount }); }

  /**
   * 电弧 overlay 按人物框的可视矩形挂到页面层并向外扩展，不参与布局也不接收指针
   * 事件，因此人物框自身的 overflow 不会把分叉和火花裁成规则边框。重复命中会先
   * 清理旧实例再建立新生命周期；render 替换人物框 DOM 后，flush 会按剩余时长
   * 重新挂载，因此响应框或濒死流程中的重绘不会提前截断动画。
   */
  startLightning(playerId, root = globalThis.document) {
    if (!playerId || !root) return;
    this.removeLightning(playerId);
    const token = ++this.lightningSerial;
    const entry = {
      token,
      expiresAt:Date.now() + LIGHTNING_HIT_DURATION_MS,
      overlay:null,
      stopFollowing:null,
      timer:setTimeout(() => this.removeLightning(playerId, token), LIGHTNING_HIT_DURATION_MS)
    };
    entry.timer?.unref?.();
    this.activeLightning.set(playerId, entry);
    this.attachLightning(playerId, entry, root);
  }

  playerPanel(root, playerId) {
    const escape = globalThis.CSS?.escape ?? ((value) => String(value).replaceAll('"', '\\"'));
    return root.querySelector(`[data-player-id="${escape(playerId)}"]`);
  }

  attachLightning(playerId, entry, root) {
    const panel = this.playerPanel(root, playerId);
    if (!panel) return;
    const remaining = Math.max(1, entry.expiresAt - Date.now());
    entry.stopFollowing?.();
    entry.stopFollowing = null;
    entry.panel?.classList?.remove("has-lightning-hit");
    entry.overlay?.remove?.();
    for (const old of panel.querySelectorAll?.(".lightning-hit-overlay") ?? []) old.remove();
    const doc = root.ownerDocument ?? root;
    const overlay = doc.createElement("span");
    overlay.className = "lightning-hit-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.setProperty("--lightning-hit-duration", `${remaining}ms`);
    const rect = panel.getBoundingClientRect?.();
    if (rect && doc.body) {
      const overflow = 10;
      const position = () => {
        const current = panel.getBoundingClientRect();
        overlay.style.setProperty("--lightning-left", `${current.left - overflow}px`);
        overlay.style.setProperty("--lightning-top", `${current.top - overflow}px`);
        overlay.style.setProperty("--lightning-width", `${current.width + overflow * 2}px`);
        overlay.style.setProperty("--lightning-height", `${current.height + overflow * 2}px`);
      };
      position();
      const view = doc.defaultView;
      view?.addEventListener?.("resize", position);
      view?.addEventListener?.("scroll", position, true);
      entry.stopFollowing = () => {
        view?.removeEventListener?.("resize", position);
        view?.removeEventListener?.("scroll", position, true);
      };
    } else {
      overlay.classList.add("is-panel-local");
    }

    const impact = doc.createElement("i");
    impact.className = "lightning-impact-flash";
    overlay.append(impact);

    const bolts = [
      ["top-a", "horizontal", "M2 16 L11 7 L18 15 L28 3 L38 17 L49 8 L59 14 L70 2 L80 16 L91 7 L98 13", "M28 3 L21 -9 L13 -14 M70 2 L79 -8 L91 -10"],
      ["top-b", "horizontal", "M1 12 L13 5 L22 16 L34 7 L46 14 L57 3 L69 16 L82 6 L99 12", "M34 7 L29 -6 L19 -11 M82 6 L91 -5 L102 -3"],
      ["right", "vertical", "M12 1 L4 13 L16 23 L6 34 L15 47 L3 58 L14 70 L5 82 L12 99", "M6 34 L-8 27 L-14 17 M14 70 L-5 62 L-12 67"],
      ["bottom", "horizontal", "M1 13 L12 5 L21 16 L32 4 L43 15 L55 7 L66 17 L77 3 L88 14 L99 8", "M32 4 L25 -8 L15 -11 M77 3 L87 -7 L99 -4"],
      ["left", "vertical", "M9 1 L16 12 L4 24 L14 35 L3 48 L16 60 L5 71 L14 84 L8 99", "M14 35 L-5 27 L-12 17 M5 71 L-8 63 L-14 68"],
      ["impact", "diagonal", "M42 -8 L26 8 L35 18 L16 31 L25 42 L6 58 L20 68 L4 84 L13 106", "M16 31 L2 25 L-8 29 M20 68 L39 58 L51 62"]
    ];
    for (const [name, orientation, pathData, branchData] of bolts) {
      const svg = doc.createElementNS?.("http://www.w3.org/2000/svg", "svg")
        ?? doc.createElement("svg");
      svg.setAttribute("class", `lightning-bolt bolt-${name} is-${orientation}`);
      svg.setAttribute("viewBox", orientation === "vertical" ? "0 0 20 100" : orientation === "diagonal" ? "0 0 56 100" : "0 0 100 20");
      svg.setAttribute("preserveAspectRatio", "none");
      for (const className of ["lightning-bolt-glow", "lightning-bolt-core"]) {
        const path = doc.createElementNS?.("http://www.w3.org/2000/svg", "path")
          ?? doc.createElement("path");
        path.setAttribute("class", className);
        path.setAttribute("d", pathData);
        svg.append(path);
      }
      const branch = doc.createElementNS?.("http://www.w3.org/2000/svg", "path")
        ?? doc.createElement("path");
      branch.setAttribute("class", "lightning-bolt-branch");
      branch.setAttribute("d", branchData);
      svg.append(branch);
      overlay.append(svg);
    }
    for (let index = 1; index <= 10; index += 1) {
      const spark = doc.createElement("i");
      spark.className = `lightning-spark spark-${index}`;
      overlay.append(spark);
    }
    overlay.addEventListener("animationend", (event) => {
      if (event.target === overlay && event.animationName === "lightningHitLifetime") {
        this.removeLightning(playerId, entry.token);
      }
    });
    panel.style?.setProperty?.("--lightning-hit-duration", `${remaining}ms`);
    panel.classList.add("has-lightning-hit");
    (rect && doc.body ? doc.body : panel).append(overlay);
    entry.panel = panel;
    entry.overlay = overlay;
  }

  removeLightning(playerId, token = null) {
    const entry = this.activeLightning.get(playerId);
    if (!entry || (token !== null && entry.token !== token)) return;
    clearTimeout(entry.timer);
    entry.stopFollowing?.();
    entry.panel?.classList?.remove("has-lightning-hit");
    entry.panel?.style?.removeProperty?.("--lightning-hit-duration");
    entry.overlay?.remove?.();
    this.activeLightning.delete(playerId);
  }

  flush(root = document) {
    for (const feedback of this.pending.splice(0)) {
      if (feedback.type === "lightning") {
        this.startLightning(feedback.playerId, root);
        continue;
      }
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
    for (const [playerId, entry] of this.activeLightning) {
      if (entry.expiresAt <= Date.now()) this.removeLightning(playerId, entry.token);
      else if (!entry.overlay?.isConnected || !entry.panel?.isConnected) {
        this.attachLightning(playerId, entry, root);
      }
    }
  }

  clear() {
    this.pending.length = 0;
    for (const playerId of [...this.activeLightning.keys()]) this.removeLightning(playerId);
  }
}
