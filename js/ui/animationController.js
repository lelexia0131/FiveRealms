/** 闪电采样约 3.2 秒；视觉在 3 秒自然收束，避免声音尾部结束后仍残留强光。 */
export const LIGHTNING_HIT_DURATION_MS = 3000;

/** 将 Presentation adapter 提交的公开事件映射为短暂 CSS 反馈；本类从不修改任何游戏状态。 */
export class AnimationController {
  /*
  功能
  创建公开 UI 反馈队列与闪电动画生命周期容器。

  调用方
  UIManager 构造函数。

  输入
  无。

  输出
  AnimationController 实例。

  读取状态
  无。

  写入状态
  初始化 pending、activeLightning 与序号。

  调用函数
  Map 构造器。

  边界与不变量
  动画状态只属于 DOM 展示，不得修改对局状态。
  */
  constructor() {
    this.pending = [];
    this.activeLightning = new Map();
    this.lightningSerial = 0;
  }

  /*
  功能
  把一项公开反馈登记到下次 render 后的刷新队列。

  调用方
  UIManager.queueFeedback。

  输入
  反馈类型、可选玩家 ID 与可选数值。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  追加 pending 条目。

  调用函数
  Array.push。

  边界与不变量
  只保存公开 primitive，不保留玩家实体。
  */
  queue(type, playerId = null, amount = null) { this.pending.push({ type, playerId, amount }); }

  /*
  功能
  为指定玩家启动可跨 DOM 重绘续接的闪电命中动画。

  调用方
  UIManager.playLightningHit 与 flush 中的 lightning 反馈。

  输入
  公开玩家 ID 与可选文档根节点。

  输出
  无返回值。

  读取状态
  activeLightning、lightningSerial 与当前时间。

  写入状态
  替换该玩家的 activeLightning 条目并登记清理 timer。

  调用函数
  removeLightning、attachLightning、setTimeout。

  边界与不变量
  重复命中先清旧实例；overlay 不参与布局，render 替换人物框后按剩余时长重新挂载。
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

  /*
  功能
  在给定 DOM 根中查找公开玩家 ID 对应的人物面板。

  调用方
  attachLightning。

  输入
  DOM 根节点与玩家 ID。

  输出
  匹配的人物面板元素或 null。

  读取状态
  globalThis.CSS.escape 能力。

  写入状态
  无。

  调用函数
  root.querySelector。

  边界与不变量
  玩家 ID 必须转义后才能拼入选择器。
  */
  playerPanel(root, playerId) {
    const escape = globalThis.CSS?.escape ?? ((value) => String(value).replaceAll('"', '\\"'));
    return root.querySelector(`[data-player-id="${escape(playerId)}"]`);
  }

  /*
  功能
  把仍有效的闪电生命周期挂载到当前人物面板 DOM。

  调用方
  startLightning 与 flush 的重挂载路径。

  输入
  玩家 ID、activeLightning 条目与文档根节点。

  输出
  无返回值。

  读取状态
  条目到期时间、当前 DOM 面板矩形与窗口滚动位置。

  写入状态
  overlay DOM、panel 样式以及条目的跟随清理函数。

  调用函数
  playerPanel、DOM/SVG 创建与事件监听 API。

  边界与不变量
  缺少面板时保持生命周期等待重挂载；旧 overlay 和 resize/scroll listener 必须先清理。
  */
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
      /*
      功能
      让页面层闪电 overlay 跟随人物面板的当前可视矩形。

      调用方
      attachLightning 初次挂载及窗口 resize/scroll listener。

      输入
      无；闭包捕获 panel、overlay 与 overflow。

      输出
      无返回值。

      读取状态
      panel.getBoundingClientRect。

      写入状态
      overlay 的定位 CSS 变量。

      调用函数
      getBoundingClientRect、style.setProperty。

      边界与不变量
      只更新展示坐标，不改变页面布局或对局状态。
      */
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

  /*
  功能
  清除指定玩家当前或指定 token 的闪电动画。

  调用方
  startLightning、到期 timer、animationend、flush 与 clear。

  输入
  玩家 ID 与可选生命周期 token。

  输出
  无返回值。

  读取状态
  activeLightning 中对应条目。

  写入状态
  移除 timer、监听器、DOM、面板样式与 Map 条目。

  调用函数
  clearTimeout 与条目清理能力。

  边界与不变量
  token 不匹配时不得清除更新后的动画实例。
  */
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

  /*
  功能
  在一次 UI render 后提交普通反馈并续接活跃闪电动画。

  调用方
  UIManager.render。

  输入
  当前文档根节点。

  输出
  无返回值。

  读取状态
  pending 队列、activeLightning 与当前 DOM。

  写入状态
  消费 pending，创建短暂反馈 DOM，并更新过期/断连的闪电条目。

  调用函数
  startLightning、attachLightning、removeLightning 与 DOM animation API。

  边界与不变量
  pending 每项只消费一次；DOM 重绘不得延长闪电原到期时间。
  */
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

  /*
  功能
  清空全部待提交反馈和活跃闪电生命周期。

  调用方
  UIManager.cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending 与 activeLightning。

  写入状态
  清空 pending 并移除所有闪电条目和 DOM。

  调用函数
  removeLightning。

  边界与不变量
  重开或销毁后不得遗留 timer、listener 或 overlay。
  */
  clear() {
    this.pending.length = 0;
    for (const playerId of [...this.activeLightning.keys()]) this.removeLightning(playerId);
  }
}
