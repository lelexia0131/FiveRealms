import { escapeHtml } from "../templates.js";

/*
功能
渲染联机入口或加入房间页面。

调用方
network 页面 coordinator。

输入
join 表示加入表单，error 为用户提示。

输出
安全 HTML。

读取状态
无。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
地址只是 capability 输入，不在页面实现连接。
*/
export function renderNetworkEntryView({ join = false, error = "" } = {}) {
  return `<div class="network-menu"><header><h2>${join ? "加入房间" : "多人游玩"}</h2><p class="network-intro">两位真人，五个席位。阵营由你选择。</p></header>
    ${join ? `<form class="network-join" data-network-form>
      <label for="network-address">房间地址 / 房间信息</label>
      <input id="network-address" name="address" required maxlength="240" autocomplete="off" placeholder="输入房主提供的房间信息">
      <button class="primary-button" type="submit">连接</button>
    </form>` : `<div class="network-mode-grid">
      <button class="network-mode-card" type="button" data-network-action="create"><span class="network-mode-symbol" aria-hidden="true">⌂</span><span class="eyebrow">发起征召</span><strong>创建房间</strong><span>建立房间<br>等待另一名玩家加入</span></button>
      <button class="network-mode-card network-mode-dusk" type="button" data-network-action="join"><span class="network-mode-symbol" aria-hidden="true">↗</span><span class="eyebrow">赴约同行</span><strong>加入房间</strong><span>输入房间信息<br>加入同一场征召</span></button>
    </div>`}
    <p class="network-notice" role="status">${escapeHtml(error || "当前版本尚未开放网络连接。")}</p>
    <button type="button" class="ghost-button" data-network-action="${join ? "entry" : "mode"}">返回</button></div>`;
}
