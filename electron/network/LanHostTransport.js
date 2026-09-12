const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { TcpPeer } = require("./TcpPeer");
const { connectionInfo, isIdentity, MAX_TOTAL_CONNECTIONS, MAX_PENDING_HANDSHAKES,
  MAX_CONNECTIONS_PER_REMOTE } = require("./TransportProtocol");

class LanHostTransport {
  constructor({ onEvent, port, host = "0.0.0.0", ...timing }) {
    this.onEvent = onEvent;
    this.port = port;
    this.host = host;
    this.timing = timing;
    this.server = null;
    this.connections = new Map();
    this.closing = null;
    this.stopped = false;
  }

  async createRoom({ roomId }) {
    const { NETWORK_DEFAULT_PORT } = await import("../../js/network/NetworkProtocol.js");
    if (this.server || this.stopped || !isIdentity(roomId)) throw new Error("无效房间或 Transport 已使用");
    this.roomId = roomId;
    const server = this.server = net.createServer((socket) => this.accept(socket));
    this.listenAbort = new AbortController();
    this.onServerError = (error) => {
      if (!this.stopped) {
        this.rejectListen?.(error);
        this.rejectListen = null;
        this.emit("ERROR", error.message);
        void this.close();
      }
    };
    server.on("error", this.onServerError);
    await new Promise((resolve, reject) => {
      this.rejectListen = reject;
      const done = () => {
        this.rejectListen = null;
        this.onListening = null;
        resolve();
      };
      this.onListening = done;
      server.once("listening", done);
      try { server.listen({ port: this.port ?? NETWORK_DEFAULT_PORT, host: this.host, signal: this.listenAbort.signal }); }
      catch (error) { this.onServerError(error); }
    });
    if (this.stopped) throw new Error("房间创建已取消");
    return { roomId, connectionInfo: connectionInfo(server.address().port) };
  }

  emit(type, message) {
    this.onEvent?.({ type, sender: "CAPABILITY", roomId: this.roomId, payload: message ? { message } : {} });
  }

  /*
  功能
  在创建 TcpPeer 前执行连接总量、地址和握手 admission。

  调用方
  net.Server connection 回调。

  输入
  新 socket 及系统 remoteAddress。

  输出
  无；超限立即销毁当前新 socket。

  读取状态
  connections、peer.connected 与 stopped。

  写入状态
  接受时登记新 connectionId 和 peer，关闭后删除。

  调用函数
  TcpPeer、randomUUID、socket.destroy。

  边界与不变量
  地址来自 socket；IPv4-mapped 地址归一；只拒绝新增连接，不改变已有成员或游戏 authority。
  */
  accept(socket) {
    const remoteAddress = socket.remoteAddress?.replace(/^::ffff:/i, "");
    const connections = [...this.connections.values()];
    if (this.stopped || connections.length >= MAX_TOTAL_CONNECTIONS
      || connections.filter((entry) => !entry.peer.connected).length >= MAX_PENDING_HANDSHAKES
      || connections.filter((entry) => entry.remoteAddress === remoteAddress).length >= MAX_CONNECTIONS_PER_REMOTE) {
      socket.on("error", () => {});
      socket.once("close", () => socket.removeAllListeners());
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    const connection = { connectionId, remoteAddress, participantId: null, rejected: false };
    const active = () => !this.stopped && this.connections.get(connectionId) === connection && !peer.closing;
    const peer = new TcpPeer(socket, {
      ...this.timing, role: "HOST", roomId: this.roomId,
      onConnected: () => {
        if (active()) this.onEvent?.({ type: "PEER_CONNECTED", sender: "CAPABILITY", roomId: this.roomId,
          connectionId, payload: { remoteAddress: connection.remoteAddress } });
      },
      onEnvelope: (envelope) => {
        if (active() && connection.participantId) this.onEvent?.({ ...envelope, connectionId });
      },
      onClosed: (message, connected) => {
        if (!this.connections.delete(connectionId)) return;
        if (connected && !this.stopped && !connection.rejected) this.onEvent?.({ type: "DISCONNECTED",
          sender: "CAPABILITY", roomId: this.roomId, connectionId, payload: { message } });
      }
    });
    connection.peer = peer;
    this.connections.set(connectionId, connection);
  }

  // Only the Host renderer's addParticipant result supplies this routing binding.
  resolveConnection(connectionId, result) {
    const connection = this.connections.get(connectionId);
    if (this.stopped || !connection || connection.peer.closing || connection.participantId) return;
    if (result?.ok === true && isIdentity(result.participantId)
      && ![...this.connections.values()].some((entry) => entry.participantId === result.participantId)) {
      connection.participantId = result.participantId;
      return;
    }
    const code = result?.code === "ROOM_FULL" ? "ROOM_FULL"
      : result?.code === "ROOM_LOCKED" ? "ROOM_LOCKED" : "JOIN_REJECTED";
    this.rejectConnection(connection, code, code === "ROOM_FULL" ? "房间已满"
      : code === "ROOM_LOCKED" ? "房间已锁定" : "加入房间被拒绝");
  }

  rejectConnection(connection, code, message) {
    connection.rejected = true;
    connection.peer.reject(message, code);
  }

  /*
  功能
  关闭超过接收预算的指定连接并保留正常断线通知。

  调用方
  NetworkIpcBridge。

  输入
  Transport 生成的 connectionId 与故障说明。

  输出
  无。

  读取状态
  connections。

  写入状态
  仅指定 TcpPeer 生命周期。

  调用函数
  TcpPeer.close。

  边界与不变量
  不使用入房拒绝的 rejected 标记；已入房 Guest 必须收到既有 DISCONNECTED 处理。
  */
  closeConnection(connectionId, message) {
    void this.connections.get(connectionId)?.peer.close(message);
  }

  /*
  功能
  按 participant 绑定定向发送 Host 消息。

  调用方
  NetworkIpcBridge send。

  输入
  Host renderer envelope。

  输出
  无；整个 transport 已关闭时抛错。

  读取状态
  connections、participantId 与 peer 存活。

  写入状态
  目标连接发送缓冲或关闭状态。

  调用函数
  TcpPeer.send、rejectConnection、TcpPeer.close。

  边界与不变量
  迟到目标或单连接写入失败不得升级成整房 ERROR；私密消息保持定向。
  */
  send(envelope) {
    if (this.stopped) throw new Error("Transport 连接已关闭");
    const active = [...this.connections.values()].filter((entry) => entry.participantId
      && entry.peer.connected && !entry.peer.closing && !entry.peer.socket.destroyed);
    if (envelope.recipientParticipantId != null) {
      const target = active.find((entry) => entry.participantId === envelope.recipientParticipantId);
      // 已投递给 renderer 的旧事件可能晚于该连接关闭；迟到回复不能升级为整端 ERROR。
      if (!target) return;
      // Existing game-side kick authority emits a targeted DISCONNECTED envelope.
      if (envelope.type === "DISCONNECTED") this.rejectConnection(target, "KICKED", envelope.payload?.message ?? "已被 Host 移出房间");
      else {
        try { target.peer.send(envelope); }
        catch (error) { void target.peer.close(error.message); }
      }
      return;
    }
    for (const connection of active) {
      try { connection.peer.send(envelope); }
      catch (error) { void connection.peer.close(error.message); }
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.onEvent = null;
    this.rejectListen?.(new Error("房间创建已取消或监听失败"));
    this.rejectListen = null;
    const server = this.server;
    if (this.onListening) server.off("listening", this.onListening);
    this.onListening = null;
    this.listenAbort?.abort();
    const peers = [...this.connections.values()].map((connection) => connection.peer);
    this.closing = Promise.all([
      ...peers.map((peer) => peer.close()),
      new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => {
          server.off("error", this.onServerError);
          server.removeAllListeners("connection");
          resolve();
        });
      })
    ]).then(() => { this.connections.clear(); });
    return this.closing;
  }
}

module.exports = { LanHostTransport };
