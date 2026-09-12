import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LanHostTransport } = require("../electron/network/LanHostTransport.js");
const { LanClientTransport } = require("../electron/network/LanClientTransport.js");
const { NetworkIpcBridge } = require("../electron/network/NetworkIpcBridge.js");
const { TcpPeer } = require("../electron/network/TcpPeer.js");
const protocol = require("../electron/network/TransportProtocol.js");

/*
功能
等待真实 socket/IPC 回调满足断言前置条件。

调用方
Transport 回归测试。

输入
同步条件及错误说明。

输出
满足条件后完成；超过两秒抛错。

读取状态
测试 fixture。

写入状态
无。

调用函数
setImmediate。

边界与不变量
只等待可观察结果，不用固定 sleep 猜测消息到达顺序。
*/
async function until(predicate, message = "Transport condition") {
  const end = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < end, message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/*
功能
创建三个经真实 TCP 握手并绑定身份的 Guest。

调用方
Transport 回归测试。

输入
可选 Host 事件消费者。

输出
Host、clients、事件记录与清理函数。

读取状态
本地 loopback socket。

写入状态
仅测试房间和事件记录。

调用函数
LanHostTransport、LanClientTransport。

边界与不变量
使用临时端口；所有连接在 finally 中关闭。
*/
async function roomFixture(consume = null) {
  const events = [], clients = [], received = [[], [], []];
  const host = new LanHostTransport({ host: "127.0.0.1", port: 0, onEvent: (event) => {
    events.push(event);
    if (event.type === "PEER_CONNECTED") host.resolveConnection(event.connectionId,
      { ok: true, participantId: `guest-${events.filter((item) => item.type === "PEER_CONNECTED").length}` });
    consume?.(event);
  } });
  await host.createRoom({ roomId: "test-room" });
  try {
    for (let index = 0; index < 3; index += 1) {
      const client = new LanClientTransport({ onEvent: (event) => received[index].push(event) });
      clients.push(client);
      await client.joinRoom({ host: "127.0.0.1", port: host.server.address().port });
      await until(() => [...host.connections.values()].filter((entry) => entry.participantId).length === index + 1);
    }
  } catch (error) { await host.close(); await Promise.all(clients.map((client) => client.close())); throw error; }
  return { host, clients, events, received,
    close: async () => { await host.close(); await Promise.all(clients.map((client) => client.close())); } };
}

/*
功能
为 admission 和心跳构造只模拟 socket 生命周期的替身。

调用方
Transport admission/rate 测试。

输入
remoteAddress。

输出
具有销毁通知与写入记录的 socket。

读取状态
无。

写入状态
仅测试 socket。

调用函数
EventEmitter、queueMicrotask。

边界与不变量
不替代多人隔离测试中的真实 TCP 收发。
*/
function testSocket(remoteAddress) {
  const socket = new EventEmitter();
  Object.assign(socket, { remoteAddress, destroyed: false, writableLength: 0, writes: [],
    setNoDelay() {}, write(data) { this.writes.push(data); },
    destroy() { if (this.destroyed) return; this.destroyed = true; queueMicrotask(() => this.emit("close")); },
    end() { this.destroy(); } });
  return socket;
}

/*
功能
验证违规 Guest 关闭后另外两端继续真实定向往返。

调用方
IPC 与 envelope 超限回归。

输入
三 Guest TCP fixture。

输出
验证完成。

读取状态
真实 Transport 事件与客户端接收记录。

写入状态
仅测试 PROBE/REPLY 消息。

调用函数
send、until。

边界与不变量
同时检查双向消息交付，不能只检查 connections Map。
*/
async function assertOtherGuestsLive(room) {
  for (const index of [1, 2]) room.clients[index].send({ type: "SURVIVOR", payload: { index } });
  await until(() => room.events.filter((event) => event.type === "SURVIVOR").length === 2);
  for (const index of [1, 2]) room.host.send({ type: "SURVIVOR_REPLY", recipientParticipantId: `guest-${index + 1}`, payload: { index } });
  await until(() => [1, 2].every((index) => room.received[index].some((event) => event.type === "SURVIVOR_REPLY")));
  assert.equal(room.host.stopped, false);
  assert.equal(room.clients[1].stopped, false);
  assert.equal(room.clients[2].stopped, false);
}

/*
功能
在既有 Network 区域注册 Electron Transport 与 IPC 回归。

调用方
tests/run.mjs。

输入
canonical runner 的 test 注册函数。

输出
无。

读取状态
Transport 资源预算与测试 fixture。

写入状态
仅 runner 的测试列表。

调用函数
roomFixture、testSocket、assertOtherGuestsLive、until。

边界与不变量
不启动 Electron UI 或 Balance；真实网络仅使用本地临时端口，所有连接均在 finally 关闭。
*/
export function registerNetworkTransportTests(test) {
  for (const failure of ["timeout", "renderer-gone", "send-failed"]) {
    test(`Network·Transport：${failure}仍按endpoint故障关闭全部连接并清空记账`, async () => {
      const bridge = new NetworkIpcBridge({ handle() {}, removeHandler() {} });
      const wc = new EventEmitter();
      wc.mainFrame = { url: "http://127.0.0.1:3000/index.html" };
      wc.isDestroyed = () => false;
      wc.send = () => { if (failure === "send-failed") throw new Error("renderer 消失"); };
      bridge.attach(wc, wc.mainFrame.url);
      const owner = bridge.owners.get(wc);
      const room = await roomFixture();
      Object.assign(owner, { token: "test-token", roomId: "test-room", transport: room.host, subscribed: true });
      const connectionId = [...room.host.connections.keys()][0];
      try {
        if (failure === "timeout") {
          const originalSetTimeout = globalThis.setTimeout;
          let onTimeout;
          try {
            globalThis.setTimeout = (callback, delay) => {
              assert.equal(delay, protocol.HANDSHAKE_TIMEOUT_MS);
              onTimeout = callback;
              return { unref() {} };
            };
            bridge.enqueue(owner, owner.token, { type: "PROBE", sender: "GUEST", connectionId });
          } finally { globalThis.setTimeout = originalSetTimeout; }
          onTimeout();
          assert.equal(owner.terminal, true);
        } else {
          bridge.enqueue(owner, owner.token, { type: "PROBE", sender: "GUEST", connectionId });
          if (failure === "renderer-gone") wc.emit("render-process-gone");
        }
        await until(() => room.clients.every((client) => client.stopped));
        assert.equal(room.host.stopped, true);
        assert.equal(owner.transport, null);
        assert.equal(owner.connections.size, 0);
        assert.equal(owner.admissions.size, 0);
      } finally { await bridge.dispose(); await room.close(); }
    });
  }

  test("Network·Transport：已排队但未投递的握手关闭不留下幽灵入房或离房事件", async () => {
    const bridge = new NetworkIpcBridge({ handle() {}, removeHandler() {} });
    const wc = new EventEmitter(); wc.send = () => {};
    bridge.attach(wc, "http://127.0.0.1:3000");
    const owner = bridge.owners.get(wc);
    const transport = new LanHostTransport({ onEvent: (event) => bridge.enqueue(owner, "test-token", event) });
    Object.assign(owner, { token: "test-token", roomId: "test-room", transport });
    transport.roomId = "test-room";
    const socket = testSocket("127.0.0.1");
    transport.accept(socket);
    const connection = [...transport.connections.values()][0];
    connection.peer.connected = true;
    try {
      bridge.enqueue(owner, owner.token, { type: "PEER_CONNECTED", sender: "CAPABILITY", connectionId: connection.connectionId });
      assert.equal(owner.queue.length, 1);
      await connection.peer.close();
      assert.equal(owner.queue.length, 0);
      assert.equal(owner.bytes, 0);
      assert.equal(owner.connections.size, 0);
      assert.equal(owner.terminal, false);
    } finally { await bridge.dispose(); }
  });

  for (const budget of ["messages", "bytes"]) {
    test(`Network·Transport：单Guest IPC ${budget}超限只关闭自己且B/C继续真实收发`, async () => {
      const bridge = new NetworkIpcBridge({ handle() {}, removeHandler() {} });
      const wc = new EventEmitter();
      wc.mainFrame = { url: "http://127.0.0.1:3000/index.html" };
      wc.isDestroyed = () => false;
      const delivered = [];
      wc.send = (_channel, packet) => delivered.push(packet);
      bridge.attach(wc, wc.mainFrame.url);
      const owner = bridge.owners.get(wc);
      const room = await roomFixture((event) => bridge.enqueue(owner, "test-token", event));
      Object.assign(owner, { token: "test-token", roomId: "test-room", transport: room.host, subscribed: true });
      for (const connectionId of room.host.connections.keys()) owner.admissions.add(connectionId);
      try {
        const payload = budget === "bytes" ? { text: "x".repeat(300000) } : {};
        const count = budget === "bytes" ? 5 : protocol.MAX_CONNECTION_PENDING_MESSAGES + 2;
        for (let index = 0; index < count; index += 1) room.clients[0].send({ type: "FLOOD", payload });
        await until(() => room.clients[0].stopped, "A socket 必须真实关闭");
        assert.equal(owner.transport, room.host);
        assert.equal(owner.terminal, false);
        assert.ok(owner.bytes <= protocol.MAX_QUEUE_BYTES);
        const flightId = owner.flight.id;
        const event = { sender: wc, senderFrame: wc.mainFrame };
        await bridge.command(event, { op: "ack", token: owner.token, id: flightId - 1 });
        assert.equal(owner.flight.id, flightId, "旧 ACK 不释放当前 flight");
        while (owner.flight) await bridge.command(event, { op: "ack", token: owner.token, id: owner.flight.id });
        await until(() => delivered.some((packet) => packet.event.type === "DISCONNECTED"));
        assert.equal(owner.connections.size, 0);
        // 被投递的旧事件仍可能生成迟到回复，不能把已关闭目标升级成整端故障。
        await bridge.command(event, { op: "send", token: owner.token, envelope: { type: "LATE", recipientParticipantId: "guest-1" } });
        await assertOtherGuestsLive(room);
        while (owner.flight) await bridge.command(event, { op: "ack", token: owner.token, id: owner.flight.id });
        assert.equal(delivered.filter((packet) => packet.event.type === "SURVIVOR").length, 2, "B/C 消息必须继续穿过 renderer IPC");
        assert.equal(owner.bytes, 0);
        assert.equal(owner.connections.size, 0);
      } finally { await bridge.dispose(); await room.close(); }
    });
  }

  test("Network·Transport：正常burst通过而恶意envelope只断A且B/C继续真实收发", async () => {
    const room = await roomFixture();
    try {
      for (let index = 0; index < 40; index += 1) room.clients[0].send({ type: "NORMAL", payload: { index } });
      await until(() => room.events.filter((event) => event.type === "NORMAL").length === 40);
      assert.equal(room.clients[0].stopped, false);
      for (let index = 0; index < protocol.ENVELOPE_BURST + 1; index += 1) room.clients[0].send({ type: "FLOOD" });
      await until(() => room.clients[0].stopped);
      assert.ok(room.events.some((event) => event.type === "DISCONNECTED" && /速率/.test(event.payload.message)));
      await assertOtherGuestsLive(room);
    } finally { await room.close(); }
  });

  test("Network·Transport：heartbeat不消耗envelope预算且token随时间恢复", async () => {
    const socket = testSocket("127.0.0.1");
    let envelopes = 0;
    const peer = new TcpPeer(socket, { role: "HOST", roomId: "test-room", onConnected() {},
      onEnvelope() { envelopes += 1; }, onClosed() {} });
    peer.connected = true;
    try {
      for (let index = 1; index <= 300; index += 1) {
        peer.receive({ kind: "ping", sessionId: peer.sessionId, nonce: index });
        peer.pendingPing = index;
        peer.receive({ kind: "pong", sessionId: peer.sessionId, nonce: index });
      }
      for (let index = 0; index < protocol.ENVELOPE_BURST; index += 1) peer.receive({ kind: "envelope", sessionId: peer.sessionId, envelope: {} });
      assert.equal(envelopes, protocol.ENVELOPE_BURST);
      assert.equal(peer.closing, false);
      peer.envelopeUpdatedAt -= 1000;
      for (let index = 0; index < protocol.ENVELOPES_PER_SECOND; index += 1) peer.receive({ kind: "envelope", sessionId: peer.sessionId, envelope: {} });
      assert.equal(peer.closing, false);
      peer.receive({ kind: "envelope", sessionId: peer.sessionId, envelope: {} });
      assert.equal(peer.closing, true);
    } finally { await peer.close(); }
  });

  for (const kind of ["remote", "pending", "total"]) {
    test(`Network·Transport：${kind} admission拒绝新增socket且释放后预算恢复`, async () => {
      const host = new LanHostTransport({ onEvent() {} });
      host.roomId = "test-room";
      const limit = kind === "remote" ? protocol.MAX_CONNECTIONS_PER_REMOTE
        : kind === "pending" ? protocol.MAX_PENDING_HANDSHAKES : protocol.MAX_TOTAL_CONNECTIONS;
      const sockets = [];
      try {
        for (let index = 0; index < limit; index += 1) {
          const socket = testSocket(kind === "remote" ? "::ffff:10.0.0.1" : `10.0.0.${index + 1}`);
          sockets.push(socket); host.accept(socket);
          if (kind === "total") [...host.connections.values()].at(-1).peer.connected = true;
        }
        const extra = testSocket(kind === "remote" ? "10.0.0.1" : "10.0.1.1");
        host.accept(extra);
        assert.equal(extra.destroyed, true);
        assert.ok(sockets.every((socket) => !socket.destroyed));
        assert.equal(host.stopped, false);
        await [...host.connections.values()][0].peer.close();
        assert.equal(host.connections.size, limit - 1);
        const replacement = testSocket(kind === "remote" ? "10.0.0.1" : "10.0.1.1");
        host.accept(replacement);
        assert.equal(replacement.destroyed, false);
        assert.equal(host.connections.size, limit);
      } finally { await host.close(); assert.equal(host.connections.size, 0); }
    });
  }

  test("Network·Transport：真实TCP定向往返且Socket覆盖伪造sender与connectionId", async () => {
    const room = await roomFixture();
    try {
      for (const [index, client] of room.clients.entries()) {
        client.send({ type: "PROBE", sender: "CAPABILITY", connectionId: "spoof", payload: { index } });
      }
      await until(() => room.events.filter((event) => event.type === "PROBE").length === 3);
      for (const event of room.events.filter((entry) => entry.type === "PROBE")) {
        assert.equal(event.sender, "GUEST");
        assert.notEqual(event.connectionId, "spoof");
        room.host.send({ type: "REPLY", recipientParticipantId: `guest-${event.payload.index + 1}`, payload: event.payload });
      }
      await until(() => room.received.every((events) => events.some((event) => event.type === "REPLY")));
      room.received.forEach((events, index) => assert.deepEqual(events.filter((event) => event.type === "REPLY").map((event) => event.payload.index), [index]));
    } finally { await room.close(); }
  });

  test("Network·Transport：frame保留原尺寸限制并拒绝损坏JSON和超大长度", () => {
    const { FrameDecoder, encodeFrame, MAX_PAYLOAD_BYTES } = protocol;
    const received = [];
    const decoder = new FrameDecoder((value) => received.push(value));
    const frame = encodeFrame({ message: "中文" });
    for (const byte of frame) decoder.push(Buffer.from([byte]));
    assert.deepEqual(received, [{ message: "中文" }]);
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_PAYLOAD_BYTES + 1);
    assert.throws(() => new FrameDecoder(() => {}).push(oversized), /长度/);
    assert.throws(() => new FrameDecoder(() => {}).push(Buffer.from([0, 0, 0, 1, 123])));
    assert.throws(() => encodeFrame({ text: "x".repeat(MAX_PAYLOAD_BYTES) }), /上限/);
    decoder.close();
  });
}
