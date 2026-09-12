import { NETWORK_EVENT as E, NETWORK_CHAT_MAX_LENGTH } from "../../network/NetworkProtocol.js";
import { NETWORK_STATE as S } from "../../network/NetworkLobbyState.js";
import { networkParticipantLabel } from "../../network/NetworkSetup.js";
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";

export class NetworkChatView {
  /*
  功能
  绑定多人日志底栏和当前会话的聊天展示偏好。

  调用方
  createNetworkFlow。

  输入
  正式 UI 与唯一 NetworkSession。

  输出
  聊天展示对象。

  读取状态
  日志面板 DOM。

  写入状态
  当前会话 mute、pending 和 DOM 监听器。

  调用函数
  session.subscribe/subscribeChat、update、receive、handleKeydown、changeMute。

  边界与不变量
  不持有游戏状态或第二套身份；生命周期与 NetworkFlow 一致，单人时隐藏。
  */
  constructor({ ui, session }) {
    this.ui = ui;
    this.session = session;
    this.root = ui.elements?.log_panel?.querySelector("#network-chat") ?? null;
    this.input = this.root?.querySelector("[data-chat-input]");
    this.status = this.root?.querySelector("[data-chat-status]");
    this.muted = new Set();
    this.muteAll = false;
    this.pending = false;
    this.roomId = null;
    this.root?.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.root?.addEventListener("change", (event) => this.changeMute(event));
    session.subscribe((snapshot) => this.update(snapshot));
    session.subscribeChat((event) => this.receive(event));
  }

  /*
  功能
  按正式 roster 更新屏蔽菜单及输入可用状态。

  调用方
  NetworkSession subscription。

  输入
  当前只读 session snapshot。

  输出
  无。

  读取状态
  participant connected/kicked、roomId 和会话阶段。

  写入状态
  本地 snapshot、mute 集合和底栏 DOM。

  调用函数
  renderRoster、refreshInput。

  边界与不变量
  新会话重置偏好；同会话保留屏蔽，离开的成员移除，新成员不默认屏蔽。
  */
  update(snapshot) {
    if (this.roomId !== snapshot.roomId) {
      this.roomId = snapshot.roomId;
      this.muted.clear();
      this.muteAll = false;
      this.pending = false;
      if (this.input) this.input.value = "";
      if (this.status) this.status.textContent = "";
      const muteAll = this.root?.querySelector("[data-chat-mute-all]");
      if (muteAll) muteAll.checked = false;
    }
    this.snapshot = snapshot;
    const others = Object.values(snapshot.participants).filter((participant) =>
      participant.connected && !participant.kicked && participant.participantId !== snapshot.participantId);
    const ids = new Set(others.map((participant) => participant.participantId));
    for (const id of this.muted) if (!ids.has(id)) this.muted.delete(id);
    this.renderRoster(others);
    if (this.root) this.root.hidden = ![S.LOADING_GAME, S.IN_GAME].includes(snapshot.state);
    if (snapshot.state !== S.IN_GAME) this.pending = false;
    this.refreshInput();
  }

  /*
  功能
  为其它在线真人生成本地屏蔽复选框。

  调用方
  update。

  输入
  已排除自己的正式 participant 数组。

  输出
  无。

  读取状态
  muted。

  写入状态
  roster DOM。

  调用函数
  networkParticipantLabel、document.createElement。

  边界与不变量
  AI 不属于 participants；昵称仅作 textContent，不作 key 或 HTML。
  */
  renderRoster(participants) {
    const roster = this.root?.querySelector("[data-chat-roster]");
    if (!roster) return;
    roster.replaceChildren();
    for (const participant of participants) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.chatMuteParticipant = participant.participantId;
      checkbox.checked = this.muted.has(participant.participantId);
      const name = document.createElement("span");
      name.textContent = networkParticipantLabel(participant);
      label.append(checkbox, name);
      roster.append(label);
    }
  }

  /*
  功能
  将复选框选择保存为本端会话展示偏好。

  调用方
  聊天底栏 change listener。

  输入
  checkbox change event。

  输出
  无。

  读取状态
  DOM dataset 和 checked。

  写入状态
  仅 muteAll/muted。

  调用函数
  Set.add/delete。

  边界与不变量
  不发送消息，不改变 Host 路由或系统日志；偏好作用于后续收到的聊天。
  */
  changeMute(event) {
    if (event.target.matches("[data-chat-mute-all]")) this.muteAll = event.target.checked;
    const id = event.target.dataset.chatMuteParticipant;
    if (id) {
      if (event.target.checked) this.muted.add(id);
      else this.muted.delete(id);
    }
  }

  /*
  功能
  在聊天区域隔离快捷键并以 Enter 提交输入。

  调用方
  底栏 keydown listener。

  输入
  浏览器键盘事件。

  输出
  无。

  读取状态
  输入元素、IME composition 与 key repeat。

  写入状态
  事件传播与经 send 提交的聊天。

  调用函数
  preventDefault、stopPropagation、send。

  边界与不变量
  中文输入法确认不发送；所有底栏按键不冒泡到游戏，原生 select/details 键盘仍可用。
  */
  handleKeydown(event) {
    event.stopPropagation();
    if (event.target !== this.input || event.key !== "Enter") return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) this.send();
  }

  /*
  功能
  提交一条前端长度合法的消息并等待 Host 回显。

  调用方
  handleKeydown。

  输入
  无。

  输出
  无。

  读取状态
  input、scope、pending。

  写入状态
  本端 pending 和轻量状态提示。

  调用函数
  session.sendChat、refreshInput。

  边界与不变量
  maxlength 外再校验原始长度；仅 Host 成功回显才清空，拒绝保留正文。
  */
  send() {
    if (!this.input || this.input.disabled || this.pending) return;
    const text = this.input.value;
    if (text.length > NETWORK_CHAT_MAX_LENGTH || !text.trim()) {
      this.status.textContent = "请输入 1–50 个字符";
      return;
    }
    this.pending = true;
    this.status.textContent = "";
    const result = this.session.sendChat(this.root.querySelector("[data-chat-scope]").value, text);
    if (!result.ok) {
      this.pending = false;
      this.status.textContent = result.code === "CHAT_UNAVAILABLE" ? "聊天连接不可用" : "请输入 1–50 个字符";
    }
    this.refreshInput();
  }

  /*
  功能
  按连接及回显等待状态同步输入控件。

  调用方
  update、send、receive。

  输入
  无。

  输出
  无。

  读取状态
  当前 session snapshot 与 pending。

  写入状态
  输入 disabled/readOnly。

  调用函数
  无。

  边界与不变量
  等待回显时只读以保留焦点；断线立即 disabled，不允许假发送。
  */
  refreshInput() {
    if (!this.input) return;
    this.input.disabled = this.snapshot.state !== S.IN_GAME
      || !this.snapshot.participants[this.snapshot.participantId]?.connected;
    this.input.readOnly = this.pending;
  }

  /*
  功能
  处理权威聊天结果并在本端过滤屏蔽成员。

  调用方
  NetworkSession.subscribeChat。

  输入
  已认证 Host CHAT_MESSAGE/CHAT_REJECTED。

  输出
  无。

  读取状态
  本地 participantId、mute 偏好、canonical 角色定义。

  写入状态
  pending、输入值、轻量提示及允许显示的聊天 DOM。

  调用函数
  refreshInput、UIManager.appendChatLog。

  边界与不变量
  自己始终显示；屏蔽不进入网络或游戏日志；正文与身份均取自 Host 回显。
  */
  receive({ type, payload }) {
    if (type === E.CHAT_REJECTED) {
      this.pending = false;
      if (this.status) this.status.textContent = payload.code === "CHAT_RATE_LIMITED" ? "发送过于频繁"
        : payload.code === "CHAT_UNAVAILABLE" ? "聊天连接不可用" : "请输入 1–50 个字符";
      this.refreshInput();
      return;
    }
    if (type !== E.CHAT_MESSAGE) return;
    const own = payload.senderParticipantId === this.snapshot.participantId;
    if (own && this.pending) {
      this.pending = false;
      if (this.input) this.input.value = "";
      if (this.status) this.status.textContent = "";
      this.refreshInput();
    }
    if (!own && (this.muteAll || this.muted.has(payload.senderParticipantId))) return;
    this.ui.appendChatLog(payload, CHARACTER_BY_ID[payload.characterId].name);
  }
}
