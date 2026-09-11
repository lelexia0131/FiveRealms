const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { TcpPeer } = require("./TcpPeer");
const { connectionInfo, isIdentity } = require("./TransportProtocol");

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

  accept(socket) {
    if (this.stopped) {
      socket.on("error", () => {});
      socket.once("close", () => socket.removeAllListeners());
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    const connection = { connectionId, remoteAddress: socket.remoteAddress, participantId: null, rejected: false };
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

  send(envelope) {
    if (this.stopped) throw new Error("Transport 连接已关闭");
    const active = [...this.connections.values()].filter((entry) => entry.participantId
      && entry.peer.connected && !entry.peer.closing && !entry.peer.socket.destroyed);
    if (envelope.recipientParticipantId != null) {
      const target = active.find((entry) => entry.participantId === envelope.recipientParticipantId);
      if (!target) throw new Error("目标 Guest 尚未连接");
      // Existing game-side kick authority emits a targeted DISCONNECTED envelope.
      if (envelope.type === "DISCONNECTED") this.rejectConnection(target, "KICKED", envelope.payload?.message ?? "已被 Host 移出房间");
      else target.peer.send(envelope);
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
