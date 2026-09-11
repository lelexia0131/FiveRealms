const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { PROTOCOL_VERSION, MAX_QUEUE_BYTES, HANDSHAKE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS, isIdentity, encodeFrame, FrameDecoder } = require("./TransportProtocol");

class TcpPeer {
  constructor(socket, { role, roomId = null, onConnected, onEnvelope, onClosed,
    handshakeTimeout = HANDSHAKE_TIMEOUT_MS, heartbeatInterval = HEARTBEAT_INTERVAL_MS,
    heartbeatTimeout = HEARTBEAT_TIMEOUT_MS }) {
    this.socket = socket;
    this.role = role;
    this.roomId = roomId;
    this.sessionId = role === "HOST" ? randomUUID() : null;
    this.state = "hello";
    this.connected = false;
    this.closing = false;
    this.reason = "对端已断开连接";
    this.onConnected = onConnected;
    this.onEnvelope = onEnvelope;
    this.onClosed = onClosed;
    this.heartbeatInterval = heartbeatInterval;
    this.heartbeatTimeout = heartbeatTimeout;
    this.ping = 0;
    this.pendingPing = null;
    this.heartbeatTimer = null;
    this.rejectTimer = null;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.decoder = new FrameDecoder((value) => this.receive(value));
    this.onData = (chunk) => {
      if (this.closing) return;
      try { this.decoder.push(chunk); } catch (error) { void this.close(error.message); }
    };
    this.onError = (error) => { void this.close(error.message); };
    this.onEnd = () => { void this.close("对端已关闭连接"); };
    this.onClose = () => this.finish();
    socket.setNoDelay(true);
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.once("close", this.onClose);
    this.handshakeTimer = setTimeout(() => this.close("Transport handshake 超时"), handshakeTimeout);
    this.handshakeTimer.unref();
  }

  startClient() {
    if (!this.closing) this.write({ kind: "hello", version: PROTOCOL_VERSION, role: "GUEST", roomId: null, sessionId: null });
  }

  write(frame) {
    if (this.closing || this.socket.destroyed) throw new Error("Transport 连接已关闭");
    try {
      const bytes = encodeFrame(frame);
      if (this.socket.writableLength + bytes.length > MAX_QUEUE_BYTES) throw new Error("Transport 发送队列超过上限");
      this.socket.write(bytes);
    } catch (error) {
      void this.close(error.message);
      throw error;
    }
  }

  reject(message, code) {
    if (this.closing) return;
    try { this.write({ kind: "reject", version: PROTOCOL_VERSION, sessionId: this.sessionId, message, code }); }
    catch { return; }
    this.reason = message;
    this.closing = true;
    this.clearTimers();
    this.decoder.close();
    this.socket.end();
    this.rejectTimer = setTimeout(() => this.socket.destroy(), 250);
    this.rejectTimer.unref();
  }

  receive(frame) {
    if (this.closing) return;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("非法 Transport frame");
    if (this.role === "GUEST" && frame.kind === "reject"
      && (!this.connected || frame.sessionId === this.sessionId)) {
      this.reasonCode = typeof frame.code === "string" ? frame.code.slice(0, 128) : undefined;
      void this.close(typeof frame.message === "string" ? frame.message.slice(0, 256) : "Transport handshake 被拒绝");
      return;
    }
    if (!this.connected) {
      if (frame.version !== PROTOCOL_VERSION) return this.reject("Transport 协议版本不兼容");
      if (this.role === "HOST" && this.state === "hello" && frame.kind === "hello"
        && frame.role === "GUEST" && frame.roomId === null && frame.sessionId === null) {
        this.state = "accept";
        this.write({ kind: "accept", version: PROTOCOL_VERSION, role: "HOST", roomId: this.roomId, sessionId: this.sessionId });
        return;
      }
      if (this.role === "GUEST" && this.state === "hello" && frame.kind === "accept"
        && frame.role === "HOST" && isIdentity(frame.roomId) && isIdentity(frame.sessionId)) {
        this.roomId = frame.roomId;
        this.sessionId = frame.sessionId;
        this.write({ kind: "accept", version: PROTOCOL_VERSION, role: "GUEST", roomId: this.roomId, sessionId: this.sessionId });
        this.activate();
        return;
      }
      if (this.role === "HOST" && this.state === "accept" && frame.kind === "accept"
        && frame.role === "GUEST" && frame.roomId === this.roomId && frame.sessionId === this.sessionId) {
        this.activate();
        return;
      }
      return this.reject("Transport handshake 身份或房间不匹配");
    }
    if (frame.sessionId !== this.sessionId) throw new Error("Transport session 不匹配");
    if (frame.kind === "ping" && Number.isSafeInteger(frame.nonce) && frame.nonce > 0) {
      this.write({ kind: "pong", sessionId: this.sessionId, nonce: frame.nonce });
    } else if (frame.kind === "pong" && this.pendingPing !== null && frame.nonce === this.pendingPing) {
      this.pendingPing = null;
    } else if (frame.kind === "envelope" && frame.envelope && typeof frame.envelope === "object" && !Array.isArray(frame.envelope)) {
      // Socket direction owns identity. Leave all other envelope fields opaque.
      this.onEnvelope({ ...frame.envelope, sender: this.role === "HOST" ? "GUEST" : "HOST" });
    } else throw new Error("非法 Transport 消息");
  }

  activate() {
    this.connected = true;
    this.state = "connected";
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.heartbeatTimer = setInterval(() => {
      if (this.pendingPing !== null) {
        if (performance.now() - this.pingStarted >= this.heartbeatTimeout) void this.close("Transport heartbeat 超时");
        return;
      }
      this.pendingPing = ++this.ping;
      this.pingStarted = performance.now();
      try { this.write({ kind: "ping", sessionId: this.sessionId, nonce: this.pendingPing }); }
      catch { /* write already closes the connection. */ }
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref();
    this.onConnected(this);
  }

  send(envelope) {
    if (!this.connected) throw new Error("Guest 尚未连接");
    this.write({ kind: "envelope", sessionId: this.sessionId, envelope });
  }

  clearTimers() {
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.rejectTimer);
    clearInterval(this.heartbeatTimer);
    this.handshakeTimer = this.rejectTimer = this.heartbeatTimer = null;
  }

  close(message = "本地已关闭连接") {
    if (!this.closing) this.reason = message;
    this.closing = true;
    this.clearTimers();
    this.decoder.close();
    this.socket.destroy();
    return this.closed;
  }

  finish() {
    if (!this.onClosed) return;
    this.closing = true;
    this.clearTimers();
    this.decoder.close();
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onClose);
    const callback = this.onClosed;
    this.onConnected = this.onEnvelope = this.onClosed = null;
    this.resolveClosed();
    callback(this.reason, this.connected);
  }
}

module.exports = { TcpPeer };
