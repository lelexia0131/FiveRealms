/*
模块职责
渲染征途成就卡阵、解锁提示、终局列表与唯一详情弹窗。

上游
HistoryArchiveView 与 UIManager。

下游
档案页、对局提示、终局 DOM 与 AchievementStore 提供的安全 ViewModel。

状态边界
只保存当前安全 ViewModel、Toast 队列和弹窗触发按钮，不读写 History 或 GameState。

信息边界
只能展示 ViewModel 已包含字段；未解锁隐藏成就无法从本模块取得真实条件。

架构约束
卡片正面不显示文字；档案卡、Toast 与终局行始终打开同一个详情弹窗。
*/
import { escapeHtml } from "../../templates.js";

const ACHIEVEMENT_TOAST_DURATION_MS = 4800;

/*
功能
把内部状态名转换为 CSS 使用的连字符类名。

调用方
renderProgressCrest、renderAchievementCard、openDetail。

输入
LOCKED、PARTIAL、COMPLETE 或 HIDDEN_LOCKED。

输出
小写且不含下划线的状态片段。

读取状态
无。

写入状态
无。

调用函数
String.replaceAll。

边界与不变量
只改变呈现类名，不改变 ViewModel 中的业务状态值。
*/
function statusClass(status) {
  return String(status ?? "").toLowerCase().replaceAll("_", "-");
}

/*
功能
把内部等级转换为不会撞上全局隐藏工具类的 CSS 片段。

调用方
renderAchievementCard、openDetail。

输入
成就 tier。

输出
common、rare、epic、legendary 或 hidden-tier。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
hidden-tier 只表达神秘等级；真正控制可见性的业务状态仍由 is-hidden-locked 表达。
*/
function tierClass(tier) {
  return tier === "hidden" ? "hidden-tier" : String(tier ?? "");
}

/*
功能
把首次解锁 ISO 时间格式化为档案日期。

调用方
renderScopeStatus。

输入
ISO 时间字符串或 null。

输出
中文年月日或“尚未铭刻”。

读取状态
浏览器中文区域格式。

写入状态
无。

调用函数
Date、Intl.DateTimeFormat。

边界与不变量
不展示无效时间；格式化不改变持久化精度。
*/
function formatUnlockDate(timestamp) {
  if (!timestamp) return "尚未铭刻";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "尚未铭刻";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "long", day: "numeric"
  }).format(date);
}

/*
功能
渲染二人/三人或专属成就的视觉进度纹章。

调用方
卡片与详情弹窗渲染。

输入
安全成就 ViewModel 与可选大尺寸标志。

输出
不含数字文本的纹章 HTML。

读取状态
teamScope 与 unlocked。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
专属成就只有真实存在的一侧；完成后按完整强度呈现。
*/
function renderProgressCrest(item, large = false) {
  const supportsDuo = item.teamScope !== "trio";
  const supportsTrio = item.teamScope !== "duo";
  const duoClass = supportsDuo ? (item.unlocked.duo ? " is-lit" : "") : " is-placeholder";
  const trioClass = supportsTrio ? (item.unlocked.trio ? " is-lit" : "") : " is-placeholder";
  const stateLabel = item.status === "COMPLETE" ? "征途完整铭刻" : item.status === "PARTIAL" ? "征途部分铭刻" : "征途尚未铭刻";
  return `<span class="achievement-crest${large ? " is-large" : ""} is-${escapeHtml(statusClass(item.status))}" role="img" aria-label="${stateLabel}">
    <i class="crest-wing crest-duo${duoClass}"></i>
    <i class="crest-core"></i>
    <i class="crest-wing crest-trio${trioClass}"></i>
  </span>`;
}

/*
功能
渲染一张无可见文字的正方形成就卡。

调用方
AchievementView.renderSection。

输入
单项安全成就 ViewModel。

输出
可键盘激活的 button HTML。

读取状态
插画、tier、status 与安全标题。

写入状态
无。

调用函数
renderProgressCrest、escapeHtml。

边界与不变量
真实名称、条件、描述和日期都不进入卡面；隐藏锁定项的 aria-label 也只使用安全名称。
*/
function renderAchievementCard(item) {
  return `<button class="achievement-card is-${escapeHtml(tierClass(item.tier))} is-${escapeHtml(statusClass(item.status))}" type="button" data-achievement-id="${escapeHtml(item.id)}" aria-label="查看成就：${escapeHtml(item.title)}">
    <img src="${escapeHtml(item.artwork)}" alt="" aria-hidden="true">
    <span class="achievement-card-shade" aria-hidden="true"></span>
    <span class="achievement-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    ${renderProgressCrest(item)}
  </button>`;
}

/*
功能
渲染一条本局新解锁成就的紧凑终局行。

调用方
AchievementView.renderMatchUnlockList。

输入
已解锁的安全成就 ViewModel。

输出
带 tier class、插画和既有进度纹章的按钮 HTML。

读取状态
item 的标题、插画、tier、status 与 unlocked。

写入状态
无。

调用函数
renderProgressCrest、tierClass、statusClass、escapeHtml。

边界与不变量
不显示 tier 文本或 criteria；点击意图只通过 data-achievement-id 暴露。
*/
function renderMatchUnlockRow(item) {
  return `<button class="match-achievement-row is-${escapeHtml(tierClass(item.tier))} is-${escapeHtml(statusClass(item.status))}" type="button" data-achievement-id="${escapeHtml(item.id)}" aria-label="查看成就：${escapeHtml(item.title)}">
    <span class="match-achievement-art"><img src="${escapeHtml(item.artwork)}" alt="" aria-hidden="true"></span>
    <strong>${escapeHtml(item.title)}</strong>
    ${renderProgressCrest(item)}
  </button>`;
}

/*
功能
渲染当前队首条解锁记录的非阻塞 Toast。

调用方
AchievementView.showNextToast。

输入
已解锁的安全成就 ViewModel。

输出
带 tier class、插画、标题和既有进度纹章的按钮 HTML。

读取状态
item 的标题、插画、tier、status 与 unlocked。

写入状态
无。

调用函数
renderProgressCrest、tierClass、statusClass、escapeHtml。

边界与不变量
不渲染 criteria 或 description；同一时刻只由调用方挂载一条。
*/
function renderUnlockToast(item) {
  return `<button class="achievement-unlock-toast is-${escapeHtml(tierClass(item.tier))} is-${escapeHtml(statusClass(item.status))}" type="button" data-achievement-id="${escapeHtml(item.id)}" aria-label="查看新解锁成就：${escapeHtml(item.title)}">
    <img src="${escapeHtml(item.artwork)}" alt="" aria-hidden="true">
    <span class="achievement-unlock-copy"><small>征途铭刻</small><strong>${escapeHtml(item.title)}</strong></span>
    ${renderProgressCrest(item)}
  </button>`;
}

/*
功能
渲染详情中的单个队伍首次铭刻状态。

调用方
AchievementView.openDetail。

输入
队伍标签、解锁时间与是否完成。

输出
卷宗式状态 HTML。

读取状态
无。

写入状态
无。

调用函数
formatUnlockDate、escapeHtml。

边界与不变量
未完成时不生成日期；二人和三人时间独立显示。
*/
function renderScopeStatus(label, timestamp, unlocked) {
  return `<div class="achievement-scope-status${unlocked ? " is-unlocked" : ""}">
    <i aria-hidden="true"></i><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatUnlockDate(timestamp))}</strong>
  </div>`;
}

export class AchievementView {
  /*
  功能
  创建征途成就 View 并安装档案、Toast 与唯一详情弹窗交互。

  调用方
  HistoryArchiveView constructor。

  输入
  历史档案页根节点，以及可选的全局弹窗、Toast 容器和逐条展示 callback。

  输出
  AchievementView 实例。

  读取状态
  root.ownerDocument 与 options 中的 modalRoot/toastRoot。

  写入状态
  items、Toast 队列、lastTrigger、onToastShown 与 click/keydown/animation listener。

  调用函数
  handleClick、handleToastClick、handleToastAnimationEnd、handleKeydown。

  边界与不变量
  全部档案卡只共用一个 root listener；Toast 容器只挂一个 listener；所有入口共用 modalRoot 中的一份弹窗；
  展示 callback 只在一条 Toast 真正挂载时调用一次。
  */
  constructor(root, { modalRoot = root, toastRoot = null, onToastShown = null } = {}) {
    this.root = root;
    this.modalRoot = modalRoot;
    this.toastRoot = toastRoot;
    this.onToastShown = typeof onToastShown === "function" ? onToastShown : null;
    this.items = [];
    this.lastTrigger = null;
    this.toastQueue = [];
    this.currentToast = null;
    this.toastTimer = null;
    this.document = root?.ownerDocument ?? globalThis.document;
    this.root?.addEventListener("click", (event) => this.handleClick(event));
    if (this.modalRoot && this.modalRoot !== this.root) {
      this.modalRoot.addEventListener?.("click", (event) => this.handleModalClick(event));
    }
    this.toastRoot?.addEventListener?.("click", (event) => this.handleToastClick(event));
    this.toastRoot?.addEventListener?.("animationend", (event) => this.handleToastAnimationEnd(event));
    this.document?.addEventListener?.("keydown", (event) => this.handleKeydown(event));
  }

  /*
  功能
  保存 Store 投影的最新安全成就 ViewModel。

  调用方
  renderSection 与 UIManager.presentMatchAchievementUnlocks。

  输入
  安全成就 ViewModel 数组。

  输出
  规范化后的当前 items。

  读取状态
  无。

  写入状态
  this.items。

  调用函数
  Array.isArray。

  边界与不变量
  不复制或补全隐藏字段；非数组输入清为空集合。
  */
  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    return this.items;
  }

  /*
功能
生成征途成就独立板块 HTML、总体进度条并保存本次安全 ViewModel。

  调用方
  HistoryArchiveView.render。

  输入
  已按稳定顺序排列的成就 ViewModel 数组。

输出
总体进度条与五列卡阵 HTML。

  读取状态
  每项 status。

  写入状态
  this.items。

  调用函数
  renderAchievementCard。

  边界与不变量
  不按 tier 添加可见分组或标题；总体纹章片段不会泄漏隐藏条件。
  */
  renderSection(items) {
    this.setItems(items);
    const completeCount = this.items.filter((item) => item.status === "COMPLETE").length;
    const partialCount = this.items.filter((item) => item.status === "PARTIAL").length;
    const hasProgress = completeCount > 0 || partialCount > 0;
    const journeyState = this.items.length > 0 && completeCount === this.items.length
      ? "is-complete"
      : hasProgress ? "is-active" : "is-quiet";
    const journeyLabel = journeyState === "is-complete"
      ? "总体成就铭刻进度：全部点亮"
      : journeyState === "is-active" ? "总体成就铭刻进度：部分点亮" : "总体成就铭刻进度：尚未点亮";
    const journeySegments = this.items.map((item) => {
      const segmentState = item.status === "COMPLETE" ? " is-lit" : item.status === "PARTIAL" ? " is-partial" : "";
      return `<i class="journey-progress-segment${segmentState}"></i>`;
    }).join("");
    const journeyStateLabel = journeyState === "is-complete"
      ? "完整铭刻"
      : journeyState === "is-active" ? "部分铭刻" : "尚未铭刻";
    return `<section class="history-section history-achievements" aria-labelledby="history-achievements-title">
      <div class="achievement-heading">
        <div class="history-section-heading"><small>JOURNEY INSIGNIA</small><h2 id="history-achievements-title">征途成就</h2><span>每一道亮起的铭痕，都来自一场真实终局</span>
          <div class="achievement-journey-progress ${journeyState}" role="img" aria-label="${journeyLabel}">
            <div class="journey-progress-header"><small>铭刻进度</small><span>${journeyStateLabel}</span></div>
            <div class="journey-progress-track" aria-hidden="true">${journeySegments}</div>
          </div>
        </div>
      </div>
      <div class="achievement-grid">${this.items.map(renderAchievementCard).join("")}</div>
    </section>`;
  }

  /*
  功能
  只按本局 Store 新增记录渲染 MVP 左栏成就列表。

  调用方
  UIManager.showMatchPerformance。

  输入
  仅含 achievementId、teamScope、unlockedAt 的本局运行时记录。

  输出
  紧凑成就行 HTML，或克制空状态 HTML。

  读取状态
  this.items 中的最新 Store ViewModel。

  写入状态
  无。

  调用函数
  renderMatchUnlockRow、Array.find/map/filter。

  边界与不变量
  不扫描 History 或重算 criteria；输出顺序与首次新增记录顺序一致。
  */
  renderMatchUnlockList(unlocks) {
    const rows = (Array.isArray(unlocks) ? unlocks : []).map((unlock) => (
      this.items.find((item) => item.id === unlock?.achievementId) ?? null
    )).filter(Boolean).map(renderMatchUnlockRow).join("");
    return rows || '<div class="match-achievement-empty">本局没有新的征途铭刻</div>';
  }

  /*
  功能
  把 Store 本次真正新增的记录依序加入单条 Toast 队列。

  调用方
  UIManager.presentMatchAchievementUnlocks。

  输入
  仅含 achievementId、teamScope、unlockedAt 的本局运行时记录。

  输出
  无返回值。

  读取状态
  this.items 与当前 Toast 生命周期。

  写入状态
  toastQueue、currentToast 与 Toast DOM。

  调用函数
  Array.find、showNextToast。

  边界与不变量
  不检查 criteria 或 History；没有对应安全 ViewModel 的记录不会进入展示队列。
  */
  enqueueUnlocks(unlocks) {
    for (const unlock of Array.isArray(unlocks) ? unlocks : []) {
      const item = this.items.find((entry) => entry.id === unlock?.achievementId);
      if (item) this.toastQueue.push({ unlock, item });
    }
    this.showNextToast();
  }

  /*
  功能
  在没有活跃 Toast 时展示队首记录并启动约 4.8 秒生命周期。

  调用方
  enqueueUnlocks 与 finishCurrentToast。

  输入
  无。

  输出
  无返回值。

  读取状态
  toastRoot、toastQueue 与 currentToast。

  写入状态
  currentToast、toastRoot.innerHTML 与 toastTimer。

  调用函数
  renderUnlockToast、onToastShown、setTimeout。

  边界与不变量
  活跃 Toast 存在时绝不挂载第二条；每条提示只在挂载后触发一次展示回调；timer 只作为 animationend 的安全兜底。
  */
  showNextToast() {
    if (!this.toastRoot || this.currentToast || !this.toastQueue.length) return;
    this.currentToast = this.toastQueue.shift();
    this.toastRoot.innerHTML = renderUnlockToast(this.currentToast.item);
    this.onToastShown?.(this.currentToast.unlock, this.currentToast.item);
    this.toastTimer = globalThis.setTimeout?.(
      () => this.finishCurrentToast(),
      ACHIEVEMENT_TOAST_DURATION_MS
    ) ?? null;
  }

  /*
  功能
  结束当前 Toast 并立即衔接队列下一条。

  调用方
  Toast animationend、生命周期兜底与新局清理测试。

  输入
  无。

  输出
  无返回值。

  读取状态
  toastTimer、toastRoot 与 toastQueue。

  写入状态
  清空当前 Toast DOM/状态并推进下一条。

  调用函数
  clearTimeout、showNextToast。

  边界与不变量
  animationend 与 timer 重复到达时安全；下一条只在当前 DOM 清空后挂载。
  */
  finishCurrentToast() {
    if (!this.currentToast) return;
    if (this.toastTimer !== null) globalThis.clearTimeout?.(this.toastTimer);
    this.toastTimer = null;
    this.currentToast = null;
    if (this.toastRoot) this.toastRoot.innerHTML = "";
    this.showNextToast();
  }

  /*
  功能
  在新 Match 开始时清空 Toast 队列和活跃提示。

  调用方
  UIManager.attachGame。

  输入
  无。

  输出
  无返回值。

  读取状态
  toastTimer 与 toastRoot。

  写入状态
  toastQueue、currentToast、toastTimer 与 Toast DOM。

  调用函数
  clearTimeout。

  边界与不变量
  只清理运行时展示，不修改永久 records 或当前安全 ViewModel。
  */
  resetUnlockQueue() {
    if (this.toastTimer !== null) globalThis.clearTimeout?.(this.toastTimer);
    this.toastQueue = [];
    this.currentToast = null;
    this.toastTimer = null;
    if (this.toastRoot) this.toastRoot.innerHTML = "";
  }

  /*
  功能
  处理卡片打开、关闭按钮与遮罩关闭。

  调用方
  root click listener。

  输入
  浏览器 click event。

  输出
  无返回值。

  读取状态
  data-achievement-id 与 data-achievement-close。

  写入状态
  弹窗 DOM 与焦点。

  调用函数
  openDetail、closeDetail、Element.closest/matches。

  边界与不变量
  点击弹窗内容不关闭；背景与明确关闭按钮才关闭。
  */
  handleClick(event) {
    const closeButton = event.target.closest?.("button[data-achievement-close]");
    if (closeButton || event.target.matches?.("[data-achievement-overlay]")) {
      this.closeDetail();
      return;
    }
    const card = event.target.closest?.("[data-achievement-id]");
    if (card) this.openDetail(card.dataset.achievementId, card);
  }

  /*
  功能
  在详情弹窗挂载于档案页之外时处理关闭按钮和遮罩点击。

  调用方
  modalRoot click listener。

  输入
  浏览器 click event。

  输出
  无返回值。

  读取状态
  data-achievement-close 与 data-achievement-overlay。

  写入状态
  由 closeDetail 删除唯一弹窗并恢复焦点。

  调用函数
  Element.closest/matches、closeDetail。

  边界与不变量
  弹窗正文点击不关闭；该 listener 不处理档案卡、Toast 或 MVP 行打开意图。
  */
  handleModalClick(event) {
    const closeButton = event.target?.closest?.("button[data-achievement-close]");
    if (closeButton || event.target?.matches?.("[data-achievement-overlay]")) this.closeDetail();
  }

  /*
  功能
  把 Toast 点击转交给现有唯一成就详情弹窗。

  调用方
  toastRoot click listener。

  输入
  浏览器 click event。

  输出
  无返回值。

  读取状态
  data-achievement-id。

  写入状态
  由 openDetail 写入唯一弹窗和焦点。

  调用函数
  Element.closest、openDetail。

  边界与不变量
  不消费或暂停 Toast 队列；无成就按钮时保持 no-op。
  */
  handleToastClick(event) {
    const toast = event.target?.closest?.("[data-achievement-id]");
    if (toast) this.openDetail(toast.dataset.achievementId, toast);
  }

  /*
  功能
  在当前 Toast CSS 动画结束时推进队列。

  调用方
  toastRoot animationend listener。

  输入
  浏览器 AnimationEvent。

  输出
  无返回值。

  读取状态
  event.target class。

  写入状态
  由 finishCurrentToast 清空当前项并推进队列。

  调用函数
  Element.matches、finishCurrentToast。

  边界与不变量
  只响应 Toast 自身动画，子元素或其他动画不得提前出队。
  */
  handleToastAnimationEnd(event) {
    if (event.target?.matches?.(".achievement-unlock-toast")) this.finishCurrentToast();
  }

  /*
  功能
  允许 Escape 关闭当前成就详情。

  调用方
  document keydown listener。

  输入
  KeyboardEvent。

  输出
  无返回值。

  读取状态
  event.key 与弹窗 DOM。

  写入状态
  弹窗 DOM 与焦点。

  调用函数
  closeDetail。

  边界与不变量
  没有打开详情时不拦截页面按键。
  */
  handleKeydown(event) {
    if (event.key === "Escape" && this.modalRoot?.querySelector?.("[data-achievement-overlay]")) this.closeDetail();
  }

  /*
  功能
  用唯一弹窗展示成就的安全详情与分队首次日期。

  调用方
  handleClick。

  输入
  成就 ID 与触发按钮。

  输出
  无返回值。

  读取状态
  this.items 中的安全 ViewModel。

  写入状态
  modalRoot 末尾详情 DOM、lastTrigger 与关闭按钮焦点。

  调用函数
  renderProgressCrest、renderScopeStatus、escapeHtml。

  边界与不变量
  隐藏锁定项不渲染 criteria、真实 description 或日期字段。
  */
  openDetail(achievementId, trigger) {
    const item = this.items.find((entry) => entry.id === achievementId);
    if (!item) return;
    this.closeDetail(false);
    this.lastTrigger = trigger ?? null;
    const hiddenLocked = item.status === "HIDDEN_LOCKED";
    const hiddenNote = hiddenLocked ? `<div class="achievement-hidden-note"><small>档案状态</small><p>这枚徽章尚未被档案馆解读。完成铭刻后，完整记录将回到卷宗。</p></div>` : "";
    const scopes = hiddenLocked ? "" : `<div class="achievement-modal-scopes">
      ${item.teamScope !== "trio" ? renderScopeStatus("二人小队", item.unlockedAt?.duo, item.unlocked.duo) : ""}
      ${item.teamScope !== "duo" ? renderScopeStatus("三人小队", item.unlockedAt?.trio, item.unlocked.trio) : ""}
    </div>`;
    const criteria = hiddenLocked ? "" : `<div class="achievement-criteria"><small>铭刻条件</small><p>${escapeHtml(item.criteria)}</p></div>`;
    this.modalRoot?.insertAdjacentHTML?.("beforeend", `<div class="achievement-modal-overlay" data-achievement-overlay role="dialog" aria-modal="true" aria-labelledby="achievement-detail-title">
      <article class="achievement-modal is-${escapeHtml(tierClass(item.tier))} is-${escapeHtml(statusClass(item.status))}">
        <button class="achievement-modal-close" type="button" data-achievement-close aria-label="关闭成就详情" title="关闭">×</button>
        <div class="achievement-modal-art"><img src="${escapeHtml(item.artwork)}" alt="" aria-hidden="true"><span aria-hidden="true"></span>${renderProgressCrest(item, true)}</div>
        <div class="achievement-modal-copy"><small>JOURNEY RECORD</small><h3 id="achievement-detail-title">${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p>${hiddenNote}${criteria}${scopes}</div>
      </article>
    </div>`);
    this.modalRoot?.querySelector?.("[data-achievement-close]")?.focus?.();
  }

  /*
  功能
  移除当前详情弹窗并可选择恢复触发卡片焦点。

  调用方
  handleClick、handleKeydown、openDetail 与 HistoryArchiveView.hide。

  输入
  restoreFocus 是否恢复焦点。

  输出
  无返回值。

  读取状态
  lastTrigger 与当前 overlay。

  写入状态
  删除 overlay、清空 lastTrigger。

  调用函数
  Element.remove/focus。

  边界与不变量
  重复关闭安全；页面退出时不强制恢复已隐藏卡片焦点。
  */
  closeDetail(restoreFocus = true) {
    this.modalRoot?.querySelector?.("[data-achievement-overlay]")?.remove?.();
    const trigger = this.lastTrigger;
    this.lastTrigger = null;
    if (restoreFocus) trigger?.focus?.();
  }
}
