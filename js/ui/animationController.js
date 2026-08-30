import { CARD_PRESENTATION } from "../adapters/ui/CardPresentationDefinitions.js";

/** 闪电采样约 3.2 秒；视觉在 3 秒自然收束，避免声音尾部结束后仍残留强光。 */
export const LIGHTNING_HIT_DURATION_MS = 3000;

const DAMAGE_FEEDBACK_DURATION_MS = 360;
const RESOLUTION_VFX_DURATION_MS = 800;
const HUNT_HIT_DURATION_MS = 720;
const BURNING_FIELD_HIT_DURATION_MS = 880;
const GUARDIAN_AID_DURATION_MS = 680;
const POSITIVE_RESOLUTION_VFX_DURATION_MS = 1000;
const RESOLUTION_VFX_CLEANUP_BUFFER_MS = 60;
const NUMERIC_FEEDBACK_TYPES = new Set(["damage", "mitigation", "heal", "energy", "shield"]);
const SEQUENTIAL_DAMAGE_VFX = new Set(["burning-field"]);
const RESOLUTION_VFX_DURATION_BY_EFFECT = Object.freeze({
  hunt: HUNT_HIT_DURATION_MS,
  "burning-field": BURNING_FIELD_HIT_DURATION_MS,
  "guardian-aid": GUARDIAN_AID_DURATION_MS
});
const POSITIVE_VFX_ART_BY_EFFECT = Object.freeze({
  heal: CARD_PRESENTATION.recover.glyph,
  energy: CARD_PRESENTATION.charge.glyph,
  shield: CARD_PRESENTATION.shield.glyph
});

/** 将 Presentation adapter 提交的公开事件映射为短暂 CSS 反馈；本类从不修改任何游戏状态。 */
export class AnimationController {
  /*
  功能
  创建公开 UI 反馈队列与闪电动画生命周期容器。

  调用方
  UIManager 构造函数。

  输入
  可选的 feedback 实际展示回调。

  输出
  AnimationController 实例。

  读取状态
  无。

  写入状态
  初始化 pending、逐目标技能反馈、闪电/伤害生命周期、结算 overlay 集合与展示回调。

  调用函数
  Map 构造器。

  边界与不变量
  动画状态只属于 DOM 展示，不得修改对局状态；回调只在对应 feedback 实际开始展示时调用一次。
  */
  constructor(onFeedbackPresented = null) {
    this.pending = [];
    this.activeLightning = new Map();
    this.lightningSerial = 0;
    this.activeDamageFeedback = new Map();
    this.damageFeedbackSerial = 0;
    this.activeResolutionEffects = new Set();
    this.sequentialDamageFeedback = [];
    this.sequentialDamageTimer = null;
    this.onFeedbackPresented = typeof onFeedbackPresented === "function" ? onFeedbackPresented : null;
  }

  /*
  功能
  把一项公开反馈登记到下次 render 后的刷新队列。

  调用方
  UIManager.queueFeedback。

  输入
  反馈类型、可选玩家 ID、可选数值与 presentation 视觉变体。

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
  queue(type, playerId = null, amount = null, variant = null) {
    this.pending.push({ type, playerId, amount, variant });
  }

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
  启动或重启指定人物框的统一生命伤害震动。

  调用方
  flush 消费 damage feedback 时。

  输入
  公开玩家 ID 与当前文档根节点。

  输出
  成功挂载受击动画时返回 true，否则返回 false。

  读取状态
  activeDamageFeedback 与 damageFeedbackSerial。

  写入状态
  替换该玩家的震动生命周期并登记清理 timer。

  调用函数
  removeDamageFeedback、attachDamageFeedback、setTimeout。

  边界与不变量
  只有真实生命伤害反馈进入本入口；重复伤害重启动画且不改变布局。
  */
  startDamageFeedback(playerId, root = globalThis.document) {
    if (!playerId || !root) return false;
    this.removeDamageFeedback(playerId);
    const token = ++this.damageFeedbackSerial;
    const entry = {
      token,
      expiresAt:Date.now() + DAMAGE_FEEDBACK_DURATION_MS,
      panel:null,
      timer:setTimeout(
        () => this.removeDamageFeedback(playerId, token),
        DAMAGE_FEEDBACK_DURATION_MS
      )
    };
    entry.timer?.unref?.();
    this.activeDamageFeedback.set(playerId, entry);
    this.attachDamageFeedback(playerId, entry, root);
    return Boolean(entry.panel);
  }

  /*
  功能
  把仍有效的统一伤害震动挂到当前 render 后的人物框。

  调用方
  startDamageFeedback 与 flush 的重挂载路径。

  输入
  玩家 ID、震动生命周期条目与文档根节点。

  输出
  无返回值。

  读取状态
  条目到期时间与当前人物框 DOM。

  写入状态
  人物框 feedback-damage class、持续时间变量与 entry.panel。

  调用函数
  playerPanel、classList 与 style API。

  边界与不变量
  render 替换人物框时只续接剩余时长，不延长真实反馈生命周期。
  */
  attachDamageFeedback(playerId, entry, root) {
    const panel = this.playerPanel(root, playerId);
    if (!panel) return;
    const remaining = Math.max(1, entry.expiresAt - Date.now());
    entry.panel?.classList?.remove("feedback-damage");
    entry.panel?.style?.removeProperty?.("--damage-feedback-duration");
    panel.classList.remove("feedback-damage");
    panel.style?.setProperty?.("--damage-feedback-duration", `${remaining}ms`);
    void panel.offsetWidth;
    panel.classList.add("feedback-damage");
    entry.panel = panel;
  }

  /*
  功能
  清除指定玩家当前或指定 token 的统一伤害震动。

  调用方
  startDamageFeedback、到期 timer 与 clear。

  输入
  玩家 ID 与可选生命周期 token。

  输出
  无返回值。

  读取状态
  activeDamageFeedback 中对应条目。

  写入状态
  清除 timer、人物框 class/变量与 Map 条目。

  调用函数
  clearTimeout、classList 与 style API。

  边界与不变量
  token 不匹配时不得清除更新后的连续受击动画。
  */
  removeDamageFeedback(playerId, token = null) {
    const entry = this.activeDamageFeedback.get(playerId);
    if (!entry || (token !== null && entry.token !== token)) return;
    clearTimeout(entry.timer);
    entry.panel?.classList?.remove("feedback-damage");
    entry.panel?.style?.removeProperty?.("--damage-feedback-duration");
    this.activeDamageFeedback.delete(playerId);
  }

  /*
  功能
  将需要逐目标展示的技能伤害加入 FIFO，并在空闲时立即播放队首。

  调用方
  flush 消费焚场 damage feedback 时。

  输入
  data-only damage feedback 与当前文档根节点。

  输出
  无返回值。

  读取状态
  sequentialDamageTimer。

  写入状态
  sequentialDamageFeedback。

  调用函数
  playNextSequentialDamageFeedback。

  边界与不变量
  队列只控制展示先后；不得延迟或重排权威伤害、日志和事件结算。
  */
  enqueueSequentialDamageFeedback(feedback, root) {
    this.sequentialDamageFeedback.push({ feedback, root });
    if (this.sequentialDamageTimer === null) this.playNextSequentialDamageFeedback();
  }

  /*
  功能
  播放一个逐目标技能伤害反馈，并在其视觉生命周期结束后推进下一项。

  调用方
  enqueueSequentialDamageFeedback 与自身 timer。

  输入
  无；读取 FIFO 队首保存的 feedback 与文档根节点。

  输出
  无返回值。

  读取状态
  sequentialDamageFeedback、技能 VFX 时长映射与 onFeedbackPresented。

  写入状态
  启动结算 overlay、受伤震动与 sequentialDamageTimer。

  调用函数
  startResolutionEffect、startDamageFeedback、onFeedbackPresented、setTimeout。

  边界与不变量
  同一时刻只启动一个逐目标技能反馈；下一项必须等待当前效果完整收束；
  展示回调必须属于当前队首，不得由下一轮推进代替触发。
  */
  playNextSequentialDamageFeedback() {
    const entry = this.sequentialDamageFeedback.shift();
    if (!entry) {
      this.sequentialDamageTimer = null;
      return;
    }
    const effectStarted = this.startResolutionEffect(entry.feedback, entry.root);
    const damageStarted = this.startDamageFeedback(entry.feedback.playerId, entry.root);
    if (effectStarted || damageStarted) this.onFeedbackPresented?.(entry.feedback);
    const duration = RESOLUTION_VFX_DURATION_BY_EFFECT[entry.feedback.variant]
      ?? RESOLUTION_VFX_DURATION_MS;
    this.sequentialDamageTimer = setTimeout(() => {
      this.sequentialDamageTimer = null;
      this.playNextSequentialDamageFeedback();
    }, duration);
    this.sequentialDamageTimer?.unref?.();
  }

  /*
  功能
  在人物框坐标上创建不受后续 render 替换影响的短生命周期结算特效。

  调用方
  flush 消费 damage/heal/energy/shield feedback 时。

  输入
  data-only feedback 与当前文档根节点。

  输出
  已创建 overlay 时返回 true，否则返回 false。

  读取状态
  当前人物框矩形、feedback variant 与正向效果的 presentation asset 映射。

  写入状态
  body overlay、fallback timer 与 activeResolutionEffects。

  调用函数
  playerPanel、DOM 创建/定位/事件 API、setTimeout。

  边界与不变量
  overlay 不参与布局且不接收指针；零变化不创建成功效果；mitigation 不伪造伤害或护盾数值；
  多个目标和连续触发各自独立清理。
  */
  startResolutionEffect(feedback, root = globalThis.document) {
    const amount = Number(feedback?.amount);
    if (!feedback?.playerId || !NUMERIC_FEEDBACK_TYPES.has(feedback.type)
      || !Number.isFinite(amount) || amount === 0) return false;
    const panel = this.playerPanel(root, feedback.playerId);
    if (!panel) return false;
    let effectName = null;
    if (feedback.type === "damage") effectName = feedback.variant;
    else if (feedback.type === "mitigation") effectName = feedback.variant;
    else if (feedback.type === "heal" || feedback.type === "energy") effectName = feedback.type;
    else if (feedback.variant === "gain") effectName = "shield";
    const duration = ["heal", "shield", "energy"].includes(effectName)
      ? POSITIVE_RESOLUTION_VFX_DURATION_MS
      : RESOLUTION_VFX_DURATION_BY_EFFECT[effectName] ?? RESOLUTION_VFX_DURATION_MS;

    const doc = root.ownerDocument ?? root;
    const overlay = doc.createElement("span");
    overlay.className = `resolution-vfx-overlay${effectName ? ` is-${effectName}` : ""}`;
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.setProperty("--resolution-vfx-duration", `${duration}ms`);
    const effectArt = POSITIVE_VFX_ART_BY_EFFECT[effectName];
    if (effectArt) {
      const visual = doc.createElement("span");
      visual.className = "positive-vfx-visual";
      const icon = doc.createElement("img");
      icon.className = "positive-vfx-icon";
      icon.setAttribute("src", effectArt);
      icon.setAttribute("alt", "");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("draggable", "false");
      visual.append(icon);
      overlay.append(visual);
    }

    if (feedback.type !== "mitigation") {
      const signedAmount = feedback.type === "damage" ? -Math.abs(amount) : amount;
      const floating = doc.createElement("span");
      floating.className = `floating-feedback is-${feedback.type}`;
      floating.textContent = `${signedAmount < 0 ? "−" : "+"}${Math.abs(signedAmount)}`;
      overlay.append(floating);
    }

    const entry = { overlay, timer:null, cleanup:null };
    const rect = panel.getBoundingClientRect?.();
    if (rect && doc.body) {
      const overflow = 10;
      overlay.style.setProperty("--resolution-vfx-left", `${rect.left - overflow}px`);
      overlay.style.setProperty("--resolution-vfx-top", `${rect.top - overflow}px`);
      overlay.style.setProperty("--resolution-vfx-width", `${rect.width + overflow * 2}px`);
      overlay.style.setProperty("--resolution-vfx-height", `${rect.height + overflow * 2}px`);
      doc.body.append(overlay);
    } else {
      overlay.classList.add("is-panel-local");
      panel.append(overlay);
    }

    /*
    功能
    清理单个结算 overlay 的 timer、DOM 与控制器记录。

    调用方
    overlay 生命周期 animationend、fallback timer 与 clear。

    输入
    无；闭包捕获当前 entry 与 overlay。

    输出
    无返回值。

    读取状态
    entry.timer 与 activeResolutionEffects。

    写入状态
    移除 overlay 和 activeResolutionEffects 条目。

    调用函数
    clearTimeout、Element.remove、Set.delete。

    边界与不变量
    重复调用保持幂等，不影响其他目标或连续触发的 overlay。
    */
    const cleanup = () => {
      clearTimeout(entry.timer);
      overlay.remove();
      this.activeResolutionEffects.delete(entry);
    };
    entry.cleanup = cleanup;
    const lifetimeAnimationName = effectArt ? "positiveVfxLifetime" : "resolutionVfxLifetime";
    overlay.addEventListener("animationend", (event) => {
      if (event.target === overlay && event.animationName === lifetimeAnimationName) cleanup();
    });
    entry.timer = setTimeout(cleanup, duration + RESOLUTION_VFX_CLEANUP_BUFFER_MS);
    entry.timer?.unref?.();
    this.activeResolutionEffects.add(entry);
    return true;
  }

  /*
  功能
  在一次 UI render 后提交普通反馈并续接活跃伤害/闪电动画。

  调用方
  UIManager.render。

  输入
  当前文档根节点。

  输出
  无返回值。

  读取状态
  pending、逐目标技能 VFX 类型、activeDamageFeedback、activeLightning、onFeedbackPresented 与当前 DOM。

  写入状态
  消费 pending，排队逐目标技能反馈，创建短暂结算 DOM，并更新过期或断连的伤害/闪电条目。

  调用函数
  enqueueSequentialDamageFeedback、startDamageFeedback、startResolutionEffect、startLightning、onFeedbackPresented 与 DOM animation API。

  边界与不变量
  pending 每项只消费一次；焚场伤害按到达顺序逐个展示；每项展示回调与自己的动画同步且只触发一次；
  mitigation 只展示 variant overlay，不触发受伤震动或数值反馈；新结算 overlay 与负护盾数字不得叠加旧人物框动画；DOM 重绘不得延长闪电原到期时间。
  */
  flush(root = document) {
    for (const feedback of this.pending.splice(0)) {
      if (feedback.type === "lightning") {
        this.startLightning(feedback.playerId, root);
        continue;
      }
      const numericAmount = Number(feedback.amount);
      if (NUMERIC_FEEDBACK_TYPES.has(feedback.type)
        && (!Number.isFinite(numericAmount) || numericAmount === 0)) continue;
      const panel = feedback.playerId ? this.playerPanel(root, feedback.playerId) : null;
      const target = panel || root.querySelector(".command-deck");
      if (!target) continue;
      if (feedback.type === "mitigation") {
        if (this.startResolutionEffect(feedback, root)) this.onFeedbackPresented?.(feedback);
        continue;
      }
      if (feedback.type === "damage" && SEQUENTIAL_DAMAGE_VFX.has(feedback.variant)) {
        this.enqueueSequentialDamageFeedback(feedback, root);
        continue;
      }
      const hasResolutionOverlay = this.startResolutionEffect(feedback, root);
      let didPresent = hasResolutionOverlay;
      // 护盾减少在 overlay 无法定位时仍是数字反馈，不能回退为获得护盾的 outline。
      const isShieldLoss = feedback.type === "shield" && numericAmount < 0;
      if (feedback.type === "damage") {
        didPresent = this.startDamageFeedback(feedback.playerId, root) || didPresent;
      } else if (!hasResolutionOverlay && !isShieldLoss) {
        target.classList.add(`feedback-${feedback.type}`);
        target.addEventListener("animationend", () => target.classList.remove(`feedback-${feedback.type}`), { once: true });
        didPresent = true;
      }
      if (!hasResolutionOverlay && numericAmount && NUMERIC_FEEDBACK_TYPES.has(feedback.type)) {
        const doc = root.ownerDocument ?? root;
        const floating = doc.createElement("span");
        floating.className = `floating-feedback is-${feedback.type}`;
        const signedAmount = feedback.type === "damage" ? -Math.abs(numericAmount) : numericAmount;
        floating.textContent = `${signedAmount < 0 ? "−" : "+"}${Math.abs(signedAmount)}`;
        floating.addEventListener("animationend", () => floating.remove(), { once: true });
        target.append(floating);
        didPresent = true;
      }
      if (didPresent) this.onFeedbackPresented?.(feedback);
    }
    for (const [playerId, entry] of this.activeDamageFeedback) {
      if (entry.expiresAt <= Date.now()) this.removeDamageFeedback(playerId, entry.token);
      else if (!entry.panel?.isConnected) this.attachDamageFeedback(playerId, entry, root);
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
  清空全部待提交反馈、伤害震动、结算 overlay 和闪电生命周期。

  调用方
  UIManager.cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending、逐目标技能反馈、activeDamageFeedback、activeResolutionEffects 与 activeLightning。

  写入状态
  清空 pending/逐目标技能 FIFO，并移除所有活跃反馈条目、timer 和 DOM。

  调用函数
  removeDamageFeedback、结算 overlay cleanup、removeLightning。

  边界与不变量
  重开或销毁后不得遗留 timer、listener 或 overlay。
  */
  clear() {
    this.pending.length = 0;
    this.sequentialDamageFeedback.length = 0;
    clearTimeout(this.sequentialDamageTimer);
    this.sequentialDamageTimer = null;
    for (const playerId of [...this.activeDamageFeedback.keys()]) this.removeDamageFeedback(playerId);
    for (const entry of [...this.activeResolutionEffects]) entry.cleanup?.();
    for (const playerId of [...this.activeLightning.keys()]) this.removeLightning(playerId);
  }
}
