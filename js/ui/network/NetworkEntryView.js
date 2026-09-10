import { escapeHtml } from "../templates.js";
import { NETWORK_DEFAULT_PORT } from "../../network/NetworkProtocol.js";

/*
功能
在粘贴完整连接地址时拆分 Host 和合法端口。

调用方
NetworkFlow 的 paste 委托。

输入
Host 输入框的 clipboard event。

输出
无。

读取状态
剪贴板纯文本与当前表单。

写入状态
仅 Host、Port 输入值及表单验证提示。

调用函数
preventDefault、setCustomValidity。

边界与不变量
只拆分单冒号的 host:port；非法端口保留原文并阻止提交，逐字输入不受影响。
*/
export function handleNetworkHostPaste(event) {
  const host = event.target;
  if (!host.matches('[name="host"]') || !host.form?.matches("[data-network-form]")) return;
  const text = event.clipboardData?.getData("text");
  if (text == null) return;
  const value = text.trim();
  const match = /^([^\s:]+):([^:]+)$/.exec(value);
  if (!match) return;
  event.preventDefault();
  const valid = /^\d+$/.test(match[2]) && Number(match[2]) >= 1 && Number(match[2]) <= 65535;
  host.value = valid ? match[1] : value;
  if (valid) host.form.elements.port.value = String(Number(match[2]));
  host.setCustomValidity(valid ? "" : "端口须为 1–65535 的整数");
  host.form.querySelector("[data-network-form-error]").textContent = host.validationMessage;
}

/*
功能
在手动修改连接信息后清除粘贴校验，并拒绝 Host 中残留的组合地址。

调用方
NetworkFlow input 与 submit 委托。

输入
加入房间表单。

输出
Host 字段是否可提交。

读取状态
Host 文本。

写入状态
Host 自定义校验与错误提示。

调用函数
setCustomValidity。

边界与不变量
不在提交时猜测拆分；合法手填 Host/Port 仍由原 endpoint authority 验证。
*/
export function validateNetworkHost(form) {
  const host = form.elements?.host;
  if (!host) return true;
  const combined = /^[^\s:]+:[^:]+$/.test(host.value.trim());
  host.setCustomValidity(combined ? "请将 IP / 主机名与端口分别填写；端口须为 1–65535 的整数" : "");
  form.querySelector("[data-network-form-error]").textContent = host.validationMessage;
  return !combined;
}

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
  return `<div class="network-menu"><header><h2>${join ? "加入房间" : "多人游玩"}</h2><p class="network-intro">${join ? "请输入房主提供的连接信息。" : "最多五位真人，五个席位。阵营由你选择。"}</p></header>
    ${join ? `<form class="network-join" data-network-form>
      <div class="network-join-fields">
        <label for="network-host">IP 地址 / 主机名
          <input id="network-host" name="host" required maxlength="253" autocomplete="off" spellcheck="false" placeholder="房主的 IP 地址或主机名" aria-describedby="network-join-help network-form-error">
        </label>
        <label for="network-port">端口
          <input id="network-port" name="port" type="number" required min="1" max="65535" step="1" inputmode="numeric" value="${NETWORK_DEFAULT_PORT}" aria-describedby="network-form-error">
        </label>
      </div>
      <p id="network-form-error" class="network-notice" data-network-form-error role="status">${escapeHtml(error)}</p>
      <button class="primary-button" type="submit">连接</button>
    </form>` : `<div class="network-mode-grid">
      <button class="network-mode-card" type="button" data-network-action="create"><span class="network-mode-symbol" aria-hidden="true">⌂</span><span class="eyebrow">发起征召</span><strong>创建房间</strong><span>建立房间<br>邀请玩家加入</span></button>
      <button class="network-mode-card network-mode-dusk" type="button" data-network-action="join"><span class="network-mode-symbol" aria-hidden="true">↗</span><span class="eyebrow">赴约同行</span><strong>加入房间</strong><span>输入房间信息<br>加入同一场征召</span></button>
    </div>`}
    ${!join && error ? `<p class="network-notice" role="status">${escapeHtml(error)}</p>` : ""}
    <button type="button" class="ghost-button" data-network-action="${join ? "entry" : "mode"}">返回</button></div>`;
}
