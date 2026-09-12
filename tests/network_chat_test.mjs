import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { NetworkSession } from "../js/network/NetworkSession.js";
import { NETWORK_EVENT as E, NETWORK_ROLE as R } from "../js/network/NetworkProtocol.js";
import { NETWORK_STATE as S } from "../js/network/NetworkLobbyState.js";
import { NetworkChatView } from "../js/ui/network/NetworkChatView.js";
import { NetworkGameView } from "../js/ui/network/NetworkGameView.js";
import { UIManager } from "../js/ui/UIManager.js";
import { CHARACTER_BY_ID } from "../js/domain/definitions/characters/CharacterDefinitions.js";
import { MatchLogAdapter } from "../js/adapters/ui/MatchLogAdapter.js";
import { createActionTransaction } from "../js/application/action/ActionTransaction.js";
import { createRandomPort } from "../js/application/ports/RandomPort.js";

const require = createRequire(import.meta.url);
const { NetworkIpcBridge } = require("../electron/network/NetworkIpcBridge.js");
const { LanHostTransport } = require("../electron/network/LanHostTransport.js");

/*
功能
等待真实网络和 IPC 消费到达可观察边界。

调用方
聊天 Transport 集成测试。

输入
同步断言条件。

输出
满足条件完成；超过五秒抛错。

读取状态
真实 Transport 和会话 fixture。

写入状态
无。

调用函数
setImmediate、performance.now。

边界与不变量
不使用固定 sleep 推测消息到达。
*/
async function until(predicate, detail = "聊天链路未到达预期状态") {
  const end = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < end, detail);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/*
功能
把正式 preload capability 绑定到真实 IPC bridge 的 Electron 环境替身。

调用方
真实聊天链路测试。

输入
bridge 和正式 preload 源码。

输出
capability、IPC 记录与一次性报文篡改入口。

读取状态
preload 中原有 token/ACK/订阅逻辑。

写入状态
仅测试 webContents、ipcRenderer 和 VM 沙箱。

调用函数
NetworkIpcBridge.attach/command、runInNewContext。

边界与不变量
只替换 Electron 宿主对象；preload、IPC 校验、Transport 与会话均执行生产实现。
*/
function preloadEndpoint(bridge, source) {
  const wc = new EventEmitter(), ipcRenderer = new EventEmitter();
  const endpoint = { sent: [], incoming: [], tamper: null };
  wc.mainFrame = { url: "http://127.0.0.1:3000/index.html" };
  wc.isDestroyed = () => false;
  wc.send = (channel, packet) => {
    endpoint.incoming.push(structuredClone(packet.event));
    ipcRenderer.emit(channel, {}, structuredClone(packet));
  };
  bridge.attach(wc, wc.mainFrame.url);
  ipcRenderer.invoke = (_channel, raw) => {
    const request = structuredClone(raw);
    if (request.op === "send") {
      if (endpoint.tamper) { endpoint.tamper(request.envelope); endpoint.tamper = null; }
      endpoint.sent.push(structuredClone(request.envelope));
    }
    return bridge.command({ sender: wc, senderFrame: wc.mainFrame }, request);
  };
  runInNewContext(source, {
    require: (name) => {
      assert.equal(name, "electron");
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, capability) => { endpoint.capability = capability; } } };
    },
    crypto: globalThis.crypto, window: { addEventListener() {} }
  }, { filename: "electron/preload.js" });
  endpoint.owner = bridge.owners.get(wc);
  return endpoint;
}

/*
功能
创建四名真人与一个 AI 席位的聊天 authority fixture。

调用方
聊天协议和 UI 回归。

输入
无。

输出
会话、事件记录、认证连接上行与可推进单调时钟。

读取状态
正式 Session 候选与席位。

写入状态
隔离会话及临时 performance.now。

调用函数
NetworkSession.open/select/confirm/start/gameReady。

边界与不变量
只替代 Transport 交付，不跳过房间权威；调用方 finally 必须 close 恢复时钟。
*/
async function chatRoom() {
  const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 10000;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  const sessions = [], receivers = [], events = [], received = [[], [], [], []];
  let roomId;
  const capability = (index) => ({
    createRoom: async (room) => { roomId = room.roomId; return room; },
    joinRoom: async () => ({ roomId }),
    subscribe: (receive) => { receivers[index] = receive; return () => { receivers[index] = null; }; },
    send: (event) => {
      events.push(structuredClone(event));
      if (index) receivers[0]?.({ ...structuredClone(event), connectionId: `connection-${index}`, sender: R.GUEST });
      else {
        const participant = sessions[0].snapshot().participants[event.recipientParticipantId];
        const guest = Number(participant?.connectionId?.split("-")[1]);
        if (guest > 0) receivers[guest]?.({ ...structuredClone(event), sender: R.HOST });
      }
    },
    close() {}
  });
  try {
    sessions.push(new NetworkSession({ capability: capability(0), random: () => .25, displayName: "房主" }));
    await sessions[0].open(R.HOST);
    sessions[0].setMaxHumanCount(4);
    for (let index = 1; index < 4; index += 1) {
      sessions.push(new NetworkSession({ capability: capability(index), displayName: `玩家${index}` }));
      await sessions[index].open(R.GUEST, { host: "fixture", port: 12345 });
      receivers[0]({ type: E.PEER_CONNECTED, sender: "CAPABILITY", roomId, connectionId: `connection-${index}` });
    }
    const snapshot = sessions[0].snapshot();
    const seats = [...snapshot.seats.filter((seat) => seat.teamId === "dawn"), ...snapshot.seats.filter((seat) => seat.teamId === "dusk")];
    sessions.forEach((session, index) => {
      session.select({ ...seats[index], characterId: snapshot.candidates[index] });
      session.confirm();
      session.subscribeChat((event) => received[index].push(event));
    });
    assert.equal(sessions[0].start().ok, true);
    sessions.forEach((session) => session.gameReady());
    assert.ok(sessions.every((session) => session.snapshot().state === S.IN_GAME));
  } catch (error) {
    sessions.forEach((session) => session.close());
    if (originalNow) Object.defineProperty(performance, "now", originalNow); else delete performance.now;
    throw error;
  }
  return { sessions, received, events, roomId,
    advance: (ms) => { now += ms; },
    raw: (index, payload, fields = {}) => receivers[0]({ type: E.CHAT_SEND, sender: R.GUEST, roomId,
      sequence: 10000 + events.length, connectionId: `connection-${index}`, payload, ...fields }),
    close() {
      sessions.forEach((session) => session.close());
      if (originalNow) Object.defineProperty(performance, "now", originalNow); else delete performance.now;
    }
  };
}

/*
功能
注册聊天 authority、路由和输入边界回归。

调用方
tests/run.mjs 的 Network 区域。

输入
canonical test 注册函数。

输出
无。

读取状态
无。

写入状态
runner 测试集合。

调用函数
chatRoom、NetworkSession。

边界与不变量
不运行游戏循环或平衡评估。
*/
export function registerNetworkChatTests(test) {
  test("Network·聊天：正式preload与IPC及真实TCP保持队内隔离、身份认证和关闭输入", async () => {
    const source = await readFile(new URL("../electron/preload.js", import.meta.url), "utf8");
    const bridge = new NetworkIpcBridge({ handle() {}, removeHandler() {} });
    const endpoints = Array.from({ length: 4 }, () => preloadEndpoint(bridge, source));
    const sessions = endpoints.map((endpoint, index) => new NetworkSession({ capability: endpoint.capability,
      displayName: `真人${index}`, random: () => .25 }));
    const received = [[], [], [], []];
    const oldCreate = LanHostTransport.prototype.createRoom;
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => element() };
    try {
      // 仅替换监听配置，真正建房、握手、preload ACK 和 participant 绑定照常运行。
      LanHostTransport.prototype.createRoom = function (room) {
        this.port = 0; this.host = "127.0.0.1";
        return oldCreate.call(this, room);
      };
      await sessions[0].open(R.HOST);
      LanHostTransport.prototype.createRoom = oldCreate;
      sessions[0].setMaxHumanCount(4);
      const port = endpoints[0].owner.transport.server.address().port;
      for (let index = 1; index < 4; index += 1) {
        await sessions[index].open(R.GUEST, { host: "127.0.0.1", port });
        await until(() => sessions[index].snapshot().state === S.SELECTING, `Guest ${index} 必须完成 IPC 入房`);
      }
      const snapshot = sessions[0].snapshot();
      const seats = [...snapshot.seats.filter((seat) => seat.teamId === "dawn"), ...snapshot.seats.filter((seat) => seat.teamId === "dusk")];
      for (let index = 0; index < 4; index += 1) {
        sessions[index].select({ ...seats[index], characterId: snapshot.candidates[index] });
        await until(() => sessions[index].snapshot().localSelection?.characterId === snapshot.candidates[index]);
        sessions[index].confirm();
        await until(() => sessions[index].snapshot().localReady);
        sessions[index].subscribeChat((event) => received[index].push(event));
      }
      assert.equal(sessions[0].start().ok, true);
      await until(() => sessions.every((session) => session.snapshot().state === S.LOADING_GAME));
      sessions.forEach((session) => session.gameReady());
      await until(() => sessions.every((session) => session.snapshot().state === S.IN_GAME));
      const guestUi = chatUi(sessions[1]);
      assert.equal(guestUi.input.disabled, false);
      sessions[1].sendChat("all", "真实链路ALL");
      await until(() => received.every((events) => events.some((event) => event.payload.text === "真实链路ALL")));
      sessions[0].sendChat("team", "Host队内");
      sessions[2].sendChat("team", "Guest队内");
      await until(() => received[1].some((event) => event.payload.text === "Host队内")
        && received[3].some((event) => event.payload.text === "Guest队内"));
      assert.ok(received[0].some((event) => event.payload.text === "Host队内"));
      assert.ok(received[2].some((event) => event.payload.text === "Guest队内"));
      assert.ok([2, 3].every((index) => !endpoints[index].incoming.some((event) => event.payload?.text === "Host队内")));
      assert.ok([0, 1].every((index) => !received[index].some((event) => event.payload.text === "Guest队内")));
      sessions[3].send(E.CHAT_SEND, { scope: "all", text: "字".repeat(51) });
      await until(() => received[3].some((event) => event.payload.code === "CHAT_INVALID"));
      endpoints[3].tamper = (envelope) => {
        envelope.sender = "CAPABILITY";
        envelope.connectionId = endpoints[0].owner.transport.connections.keys().next().value;
        envelope.nickname = "假名";
        envelope.characterId = "假角色";
        envelope.teamId = "dawn";
      };
      sessions[3].sendChat("all", "连接不能冒充");
      await until(() => received[0].some((event) => event.payload.text === "连接不能冒充"));
      const message = received[0].find((event) => event.payload.text === "连接不能冒充").payload;
      assert.equal(message.senderParticipantId, sessions[3].snapshot().participantId);
      assert.equal(message.senderNickname, "真人3");
      assert.equal(message.teamId, "dusk");
      assert.equal(message.characterId, sessions[3].snapshot().localSelection.characterId);
      const upstream = endpoints[0].incoming.find((event) => event.payload?.text === "连接不能冒充");
      assert.equal(upstream.sender, R.GUEST);
      assert.equal(upstream.connectionId, sessions[0].snapshot().participants[message.senderParticipantId].connectionId);
      assert.ok(endpoints[1].sent.some((event) => event.type === E.CHAT_SEND));
      sessions[0].close();
      await until(() => sessions.slice(1).every((session) => session.snapshot().state === S.DISCONNECTED));
      assert.equal(guestUi.input.disabled, true);
      assert.equal(sessions[1].sendChat("all", "关闭后").ok, false);
    } finally {
      LanHostTransport.prototype.createRoom = oldCreate;
      sessions.forEach((session) => session.close());
      await bridge.dispose();
      if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
  });

  for (const sender of [0, 1, 2]) for (const scope of ["all", "team"]) {
    test(`Network·聊天：${sender === 0 ? "Host" : `Guest${sender}`} ${scope}按正式队伍路由且包含发送者`, async () => {
      const room = await chatRoom();
      try {
        room.sessions[sender].sendChat(scope, " 大家好！ ");
        for (let index = 0; index < 4; index += 1) {
          const expected = scope === "all" || (index < 2) === (sender < 2);
          assert.equal(room.received[index].length, expected ? 1 : 0);
          if (expected) {
            const message = room.received[index][0];
            assert.equal(message.type, E.CHAT_MESSAGE);
            assert.equal(message.payload.text, "大家好！");
            assert.equal(message.payload.senderParticipantId, room.sessions[sender].snapshot().participantId);
          }
        }
        if (sender) {
          const up = room.events.findLast((event) => event.type === E.CHAT_SEND);
          assert.deepEqual(up.payload, { scope, text: "大家好！" });
          assert.equal(Object.hasOwn(up, "participantId"), false);
        }
        const routes = room.events.filter((event) => event.type === E.CHAT_MESSAGE);
        assert.ok(routes.every((event) => event.recipientParticipantId));
      } finally { room.close(); }
    });
  }

  for (const [label, text, valid] of [["50字", "字".repeat(50), true], ["51字", "字".repeat(51), false],
    ["空串", "", false], ["纯空格", " \t \n ", false], ["超长首尾空格", ` ${"字".repeat(50)} `, false],
    ["非字符串", 123, false]]) {
    test(`Network·聊天：Host独立校验${label}`, async () => {
      const room = await chatRoom();
      try {
        room.raw(1, { scope: "all", text });
        assert.equal(room.received[1][0].type, valid ? E.CHAT_MESSAGE : E.CHAT_REJECTED);
        assert.equal(room.received[0].length, valid ? 1 : 0);
        assert.equal(room.received[2].length, valid ? 1 : 0);
        assert.equal(room.received[3].length, valid ? 1 : 0);
      } finally { room.close(); }
    });
  }

  for (const field of ["senderId", "participantId", "senderParticipantId", "nickname", "senderNickname", "characterId", "teamId"]) {
    test(`Network·聊天：Guest payload伪造${field}被拒绝且不广播`, async () => {
      const room = await chatRoom();
      try {
        room.raw(1, { scope: "team", text: "冒充", [field]: "spoof" });
        assert.equal(room.received[1][0].type, E.CHAT_REJECTED);
        assert.deepEqual([room.received[0], room.received[2], room.received[3]], [[], [], []]);
      } finally { room.close(); }
    });
  }

  test("Network·聊天：envelope身份伪造与非认证连接不能通过Host入口", async () => {
    const room = await chatRoom();
    try {
      assert.equal(room.raw(1, { scope: "all", text: "冒充" }, { participantId: room.sessions[2].snapshot().participantId }), false);
      assert.equal(room.raw(1, { scope: "all", text: "冒充" }, { connectionId: "unknown" }), false);
      assert.equal(room.raw(1, { scope: "all", text: "冒充" }, { type: E.CHAT_MESSAGE }), false);
      assert.ok(room.received.every((events) => events.length === 0));
      room.raw(1, { scope: "all", text: "真实身份" }, { nickname: "spoof", teamId: "dusk", characterId: "spoof" });
      const sender = room.sessions[1].snapshot();
      const message = room.received[0][0].payload;
      assert.equal(message.senderNickname, "玩家1");
      assert.equal(message.teamId, "dawn");
      assert.equal(message.characterId, sender.localSelection.characterId);
    } finally { room.close(); }
  });

  for (const index of [0, 1]) {
    test(`Network·聊天：${index ? "Guest" : "Host"}冷却按participant计时且恰好一秒恢复`, async () => {
      const room = await chatRoom();
      try {
        room.sessions[index].sendChat("all", "第一条");
        room.advance(999);
        room.sessions[index].sendChat("team", "太快");
        assert.equal(room.received[index].at(-1).payload.code, "CHAT_RATE_LIMITED");
        assert.equal(room.events.filter((event) => event.type === E.CHAT_MESSAGE && event.payload.text === "太快").length, 0);
        room.advance(1);
        room.sessions[index].sendChat("all", "第二条");
        assert.equal(room.received[index].at(-1).payload.text, "第二条");
      } finally { room.close(); }
    });
  }

  test("Network·聊天：重名成员冷却独立且改昵称不能重置自己的冷却", async () => {
    const room = await chatRoom();
    try {
      room.sessions[1].setDisplayName("同名");
      room.sessions[2].setDisplayName("同名");
      room.sessions[1].send(E.PARTICIPANT_HELLO, { displayName: "同名" });
      room.sessions[2].send(E.PARTICIPANT_HELLO, { displayName: "同名" });
      room.sessions[1].sendChat("all", "A");
      room.sessions[2].sendChat("all", "B");
      assert.deepEqual(room.received[0].map((event) => event.payload.text), ["A", "B"]);
      assert.ok(room.received[0].every((event) => event.payload.senderNickname === "同名"));
      room.sessions[1].setDisplayName("改名");
      room.sessions[1].send(E.PARTICIPANT_HELLO, { displayName: "改名" });
      room.sessions[1].sendChat("all", "再发");
      assert.equal(room.received[1].at(-1).payload.code, "CHAT_RATE_LIMITED");
    } finally { room.close(); }
  });

  test("Network·聊天：无效范围不广播且非法消息不消耗合法消息冷却", async () => {
    const room = await chatRoom();
    try {
      room.raw(1, { scope: "enemies", text: "错误范围" });
      room.raw(1, { scope: "all", text: "合法" });
      assert.equal(room.received[1][0].type, E.CHAT_REJECTED);
      assert.equal(room.received[0][0].payload.text, "合法");
    } finally { room.close(); }
  });
}

/*
功能
构造可观察日志节点和聊天事件冒泡的最小 DOM。

调用方
聊天 UI 测试。

输入
无。

输出
元素替身。

读取状态
无。

写入状态
仅测试元素属性、children 和 listeners。

调用函数
无。

边界与不变量
innerHTML 只作字符串记录；正文断言直接读取 textContent，并检查没有创建注入节点。
*/
function element() {
  return { children: [], dataset: {}, value: "", textContent: "", innerHTML: "", disabled: false, checked: false,
    listeners: {}, scrollTop: 0,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    removeChild(node) { const index = this.children.indexOf(node); assert.ok(index >= 0); this.children.splice(index, 1); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    matches(selector) { return selector === this.selector; },
    setAttribute() {}
  };
}

/*
功能
绑定正式聊天 View 与 UIManager 日志方法到可控 DOM。

调用方
聊天 UI 回归。

输入
真实 NetworkSession。

输出
view、ui 和输入/菜单/日志元素。

读取状态
正式会话。

写入状态
测试 UI DOM。

调用函数
NetworkChatView、UIManager。

边界与不变量
只替代 DOM，不替代屏蔽、发送、着色或回滚实现。
*/
function chatUi(session) {
  const root = element(), list = element();
  const parts = Object.fromEntries(["input", "status", "scope", "roster", "mute-all"].map((name) => [`[data-chat-${name}]`, element()]));
  root.querySelector = (selector) => parts[selector];
  parts["[data-chat-scope]"].value = "all";
  parts["[data-chat-mute-all]"].selector = "[data-chat-mute-all]";
  const ui = { elements: { log_panel: { querySelector: () => root }, log_list: list },
    appendLog: UIManager.prototype.appendLog, appendChatLog: UIManager.prototype.appendChatLog,
    restoreLogBoundary: UIManager.prototype.restoreLogBoundary, updateLogCount(count) { this.count = count; } };
  const view = new NetworkChatView({ ui, session });
  return { ui, view, root, list, input: parts["[data-chat-input]"], status: parts["[data-chat-status]"],
    roster: parts["[data-chat-roster]"], muteAll: parts["[data-chat-mute-all]"] };
}

/*
功能
为 UI 回归提供四端会话、正式聊天 View 和可清理 document 替身。

调用方
registerNetworkChatUiTests。

输入
异步或同步测试回调。

输出
测试完成 Promise。

读取状态
原 document。

写入状态
临时 document 和隔离会话。

调用函数
chatRoom、chatUi。

边界与不变量
finally 恢复 document、时钟并关闭所有会话。
*/
async function withChatUi(run) {
  const room = await chatRoom();
  const previous = globalThis.document;
  globalThis.document = { createElement: () => element() };
  try { await run(room, chatUi(room.sessions[0]), chatUi(room.sessions[1])); }
  finally { room.close(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
}

/*
功能
注册日志展示层聊天、输入隔离和本地屏蔽回归。

调用方
tests/run.mjs 的 UI 日志区域。

输入
canonical test 注册函数。

输出
无。

读取状态
无。

写入状态
runner 测试集合。

调用函数
withChatUi、正式日志和事务入口。

边界与不变量
以真实 authority 回显驱动 UI；不创建生产测试抽象。
*/
export function registerNetworkChatUiTests(test) {
  test("UI·聊天：大厅新真人动态加入名单且旧屏蔽保持，新会话清空偏好", async () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: () => element() };
    const session = new NetworkSession({ random: () => .25 });
    try {
      const local = chatUi(session);
      assert.equal(local.root.hidden, true);
      await session.open(R.HOST);
      session.setMaxHumanCount(4);
      const first = session.addParticipant({ connectionId: "A", displayName: "甲" }).participantId;
      local.view.muted.add(first);
      const second = session.addParticipant({ connectionId: "B", displayName: "乙" }).participantId;
      assert.equal(local.roster.children.length, 2);
      assert.ok(local.view.muted.has(first));
      assert.equal(local.view.muted.has(second), false);
      assert.equal(local.roster.children[0].children[0].checked, true);
      assert.equal(local.roster.children[1].children[0].checked, false);
      session.close();
      await session.open(R.HOST);
      assert.equal(local.view.muted.size, 0);
      assert.equal(local.view.muteAll, false);
      assert.equal(local.root.hidden, true);
    } finally {
      session.close();
      if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
    }
  });

  test("UI·聊天：多人底栏包含50字输入与范围菜单且折叠时隐藏", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const css = await readFile(new URL("../css/network.css", import.meta.url), "utf8");
    assert.match(html, /id="network-chat"[^>]*hidden/);
    assert.match(html, /data-chat-input[^>]*maxlength="50"/);
    assert.match(html, /value="all">ALL/);
    assert.match(html, /value="team">队内/);
    assert.match(css, /\.network-chat\[hidden\], \.log-panel\.is-collapsed \.network-chat \{ display: none/);
    await withChatUi((_room, host) => assert.equal(host.root.hidden, false));
  });

  test("UI·聊天：屏蔽多个真人只过滤其新聊天且不影响系统日志或Host广播", () => withChatUi((room, host) => {
    host.view.muted.add(room.sessions[1].snapshot().participantId);
    host.view.muted.add(room.sessions[3].snapshot().participantId);
    room.sessions[1].sendChat("all", "隐藏B");
    room.sessions[2].sendChat("all", "显示C");
    room.sessions[3].sendChat("all", "隐藏D");
    host.ui.appendLog({ kind: "normal", message: "系统消息" }, 1);
    assert.equal(host.list.children.length, 2);
    assert.equal(host.list.children[0].children[1].textContent, "：显示C");
    assert.equal(host.list.children[1].innerHTML, "系统消息");
    assert.equal(room.received[0].length, 3, "屏蔽不影响网络交付");
    assert.equal(room.events.filter((event) => event.type === E.CHAT_MESSAGE).length, 9);
  }));

  test("UI·聊天：屏蔽所有人仍显示自己且复选框偏好不发送网络消息", () => withChatUi((room, host) => {
    const before = room.events.length;
    host.muteAll.checked = true;
    host.root.listeners.change({ target: host.muteAll });
    const checkbox = host.roster.children[0].children[0];
    checkbox.checked = true;
    host.root.listeners.change({ target: checkbox });
    assert.equal(room.events.length, before);
    room.sessions[1].sendChat("all", "别人的话");
    room.sessions[0].sendChat("all", "自己的话");
    assert.equal(host.list.children.length, 1);
    assert.equal(host.list.children[0].children[1].textContent, "：自己的话");
  }));

  test("UI·聊天：名单只含其它真人并按离开与新会话更新", () => withChatUi((room, host) => {
    assert.equal(room.sessions[0].snapshot().matchSetup.players.filter((player) => player.controller.type === "AI").length, 1);
    assert.equal(host.roster.children.length, 3);
    const own = room.sessions[0].snapshot().participantId;
    assert.ok(host.roster.children.every((label) => label.children[0].dataset.chatMuteParticipant !== own));
    const removed = room.sessions[1].snapshot().participantId;
    host.view.muted.add(removed);
    room.sessions[0].markParticipantDisconnected(removed);
    assert.equal(host.roster.children.length, 2);
    assert.equal(host.view.muted.has(removed), false);
    room.sessions[0].close();
    assert.equal(host.root.hidden, true);
    assert.equal(host.input.disabled, true);
    assert.equal(host.roster.children.length, 0);
  }));

  test("UI·聊天：角色昵称安全转义且姓名复用现有队伍颜色而正文为纯文本", () => withChatUi((room, host) => {
    const session = room.sessions[1];
    session.setDisplayName("<img src=x>");
    session.send(E.PARTICIPANT_HELLO, { displayName: "<img src=x>" });
    const text = "<script>alert(1)</script>「突袭」1点伤害";
    session.sendChat("all", text);
    const [sender, body] = host.list.children[0].children;
    const character = CHARACTER_BY_ID[session.snapshot().localSelection.characterId].name;
    assert.ok(sender.innerHTML.includes(`${character}（&lt;img src=x&gt;）`));
    assert.match(sender.innerHTML, /log-player-name team-dawn/);
    assert.equal(body.className, "log-chat-text");
    assert.equal(body.textContent, `：${text}`);
    assert.equal(body.innerHTML, "");
    assert.equal(body.children.length, 0);
    room.sessions[2].sendChat("all", "暮影");
    assert.match(host.list.children[1].children[0].innerHTML, /log-player-name team-dusk/);
  }));

  test("UI·聊天：Enter仅发送聊天并成功后清空，限流保留输入而提示不进日志", () => withChatUi((room, host, guest) => {
    guest.input.value = "你好";
    let prevented = 0, stopped = 0;
    const event = { target: guest.input, key: "Enter", preventDefault() { prevented += 1; }, stopPropagation() { stopped += 1; } };
    const before = room.events.length;
    guest.root.listeners.keydown(event);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(guest.input.value, "");
    assert.ok(room.events.slice(before).every((entry) => [E.CHAT_SEND, E.CHAT_MESSAGE].includes(entry.type)));
    guest.input.value = "太快";
    guest.root.listeners.keydown(event);
    assert.equal(guest.input.value, "太快");
    assert.equal(guest.status.textContent, "发送过于频繁");
    assert.equal(guest.list.children.length, 1);
    assert.equal(host.list.children.length, 1);
    assert.equal(guest.input.readOnly, false);
  }));

  test("UI·聊天：IME确认和长按Enter不发送，JS拒绝绕过maxlength的输入", () => withChatUi((room, host) => {
    const before = room.events.length;
    const event = { target: host.input, key: "Enter", preventDefault() {}, stopPropagation() {} };
    host.input.value = "中文";
    host.root.listeners.keydown({ ...event, isComposing: true });
    host.root.listeners.keydown({ ...event, repeat: true });
    for (const text of ["", "   ", "字".repeat(51)]) {
      host.input.value = text;
      host.root.listeners.keydown(event);
    }
    assert.equal(room.events.length, before);
    host.input.value = "字".repeat(50);
    host.root.listeners.keydown(event);
    assert.equal(host.input.value, "");
    assert.equal(host.list.children[0].children[1].textContent, `：${"字".repeat(50)}`);
  }));

  test("UI·聊天：Guest断线和Host关闭后禁止继续发送且输入disabled", () => withChatUi((room, host, guest) => {
    room.sessions[1].disconnect();
    assert.equal(guest.input.disabled, true);
    assert.equal(room.sessions[1].sendChat("all", "离线" ).ok, false);
    room.sessions[0].close();
    assert.equal(host.input.disabled, true);
    assert.equal(room.sessions[0].sendChat("all", "关闭" ).ok, false);
    const before = room.events.length;
    guest.view.send(); host.view.send();
    assert.equal(room.events.length, before);
  }));

  test("UI·聊天：Action事务只裁游戏日志，交错聊天和DOM身份均保留", () => withChatUi((room, host) => {
    const state = { players: [], logs: [] };
    const adapter = new MatchLogAdapter(state, host.ui);
    adapter.add("历史");
    room.sessions[1].sendChat("all", "之前聊天");
    const historical = [...host.list.children];
    const transaction = createActionTransaction({ roots: [state], logs: state.logs,
      randomPort: createRandomPort({ next: () => .25 }), restoreLogPresentation: (count) => host.ui.restoreLogBoundary(count) });
    adapter.add("撤销一");
    room.sessions[2].sendChat("all", "事务中聊天");
    const during = host.list.children.at(-1);
    adapter.add("撤销二");
    room.sessions[3].sendChat("all", "尾部聊天");
    const tail = host.list.children.at(-1);
    assert.equal(state.logs.length, 3);
    assert.equal(host.ui.gameLogNodes.length, 3);
    transaction.rollback();
    assert.equal(state.logs.length, 1);
    assert.equal(host.ui.count, 1);
    assert.deepEqual(host.list.children, [...historical, during, tail]);
    assert.equal(host.ui.gameLogNodes.length, 1);
    adapter.add("恢复后的游戏日志");
    assert.equal(host.list.children.at(-1).innerHTML, "恢复后的游戏日志");
    assert.equal(state.logs.length, 2);
  }));

  test("UI·聊天：Guest增量回滚与完整日志恢复均不删除聊天", () => withChatUi((room, _host, guest) => {
    const view = new NetworkGameView({ ui: guest.ui, submit() {} });
    view.projection = { display: { logs: [{ id: "1", message: "旧记录" }] } };
    view.syncLogs();
    room.sessions[2].sendChat("all", "保留聊天");
    const chat = guest.list.children.at(-1);
    view.projection = { display: { logSync: { start: 0, entries: [{ id: "2", message: "增量恢复" }] } } };
    view.syncLogs();
    assert.equal(guest.list.children[0], chat);
    view.projection = { display: { logs: [{ id: "3", message: "完整恢复" }] } };
    view.syncLogs();
    assert.equal(guest.list.children[0], chat);
    assert.equal(guest.list.children[1].innerHTML, "完整恢复");
    assert.equal(guest.list.children.length, 2);
  }));
}
