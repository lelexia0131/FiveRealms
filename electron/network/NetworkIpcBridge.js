const { LanHostTransport } = require("./LanHostTransport");
const { LanClientTransport } = require("./LanClientTransport");
const { MAX_QUEUE_BYTES, MAX_QUEUE_MESSAGES, HANDSHAKE_TIMEOUT_MS, isIdentity } = require("./TransportProtocol");

const COMMAND_CHANNEL = "five-realms:network:command";
const EVENT_CHANNEL = "five-realms:network:event";

class NetworkIpcBridge {
  constructor(ipcMain) {
    this.ipcMain = ipcMain;
    this.owners = new Map();
    this.retiring = new Set();
    this.disposed = false;
    ipcMain.handle(COMMAND_CHANNEL, (event, request) => this.command(event, request));
  }

  attach(webContents, url) {
    if (this.disposed || this.owners.has(webContents)) throw new Error("Network IPC 已注册或关闭");
    const owner = { webContents, origin: new URL(url).origin, token: null, transport: null,
      queue: [], bytes: 0, subscribed: false, flight: null, serial: 0, timer: null, terminal: false };
    owner.onNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.reset(owner);
    };
    owner.onGone = () => this.reset(owner);
    owner.onDestroyed = () => this.detach(owner);
    webContents.on("did-start-navigation", owner.onNavigation);
    webContents.on("render-process-gone", owner.onGone);
    webContents.once("destroyed", owner.onDestroyed);
    this.owners.set(webContents, owner);
  }

  retire(transport) {
    if (!transport) return;
    const closing = transport.close();
    this.retiring.add(closing);
    void closing.finally(() => this.retiring.delete(closing));
  }

  reset(owner) {
    owner.token = null;
    owner.roomId = null;
    owner.subscribed = false;
    owner.queue = [];
    owner.bytes = 0;
    owner.flight = null;
    owner.terminal = false;
    clearTimeout(owner.timer);
    owner.timer = null;
    this.retire(owner.transport);
    owner.transport = null;
  }

  detach(owner) {
    this.reset(owner);
    const wc = owner.webContents;
    wc.off("did-start-navigation", owner.onNavigation);
    wc.off("render-process-gone", owner.onGone);
    wc.off("destroyed", owner.onDestroyed);
    this.owners.delete(wc);
  }

  authorized(event) {
    const owner = this.owners.get(event.sender);
    if (this.disposed || !owner || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("拒绝 Network IPC 来源");
    }
    const url = new URL(event.senderFrame.url);
    if (url.origin !== owner.origin || !["/", "/index.html"].includes(url.pathname)) throw new Error("拒绝 Network IPC 页面");
    return owner;
  }

  async command(event, request) {
    const owner = this.authorized(event);
    if (!request || !isIdentity(request.token)) throw new Error("无效 Network IPC 请求");
    const { op, token } = request;
    if (op === "createRoom" || op === "joinRoom") {
      this.reset(owner);
      owner.token = token;
      await Promise.all([...this.retiring]);
      if (this.disposed || owner.token !== token) throw new Error("连接请求已取消");
      const transport = op === "createRoom"
        ? new LanHostTransport({ onEvent: (value) => this.enqueue(owner, token, value) })
        : new LanClientTransport({ onEvent: (value) => this.enqueue(owner, token, value) });
      owner.transport = transport;
      try {
        const result = op === "createRoom"
          ? await transport.createRoom({ roomId: request.roomId })
          : await transport.joinRoom({ host: request.host, port: request.port });
        if (owner.token !== token) throw new Error("连接请求已取消");
        owner.roomId = result.roomId;
        return result;
      } catch (error) {
        if (owner.token === token) this.reset(owner);
        else this.retire(transport);
        throw error;
      }
    }
    if (owner.token !== token) {
      if (["close", "ack", "unsubscribe"].includes(op)) return;
      throw new Error("旧 Network connection 已失效");
    }
    if (op === "close") {
      this.reset(owner);
      await Promise.all([...this.retiring]);
    } else if (op === "send") {
      if (!owner.transport || owner.terminal) throw new Error("Transport 连接已关闭");
      owner.transport.send(request.envelope);
    } else if (op === "subscribe") {
      owner.subscribed = true;
      this.flush(owner);
    } else if (op === "unsubscribe") {
      owner.subscribed = false;
    } else if (op === "ack") {
      if (owner.flight?.id !== request.id) return;
      if (owner.flight.connectionId) owner.transport?.resolveConnection(owner.flight.connectionId, request.result);
      owner.bytes -= owner.flight.bytes;
      owner.flight = null;
      clearTimeout(owner.timer);
      owner.timer = null;
      this.flush(owner);
    } else throw new Error("未知 Network IPC 操作");
  }

  enqueue(owner, token, value) {
    if (owner.token !== token || owner.terminal || this.disposed) return;
    if (!owner.roomId && value.sender === "CAPABILITY") owner.roomId = value.roomId;
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (owner.bytes + bytes > MAX_QUEUE_BYTES || owner.queue.length + Number(Boolean(owner.flight)) >= MAX_QUEUE_MESSAGES) {
      this.fail(owner, "Transport IPC 接收队列超过上限");
      return;
    }
    owner.queue.push({ value, bytes });
    owner.bytes += bytes;
    this.flush(owner);
  }

  fail(owner, message) {
    this.retire(owner.transport);
    owner.transport = null;
    owner.terminal = true;
    owner.queue = [];
    owner.bytes = 0;
    owner.flight = null;
    clearTimeout(owner.timer);
    owner.timer = null;
    // A failed renderer IPC channel ends this endpoint, not one Guest connection.
    const value = { type: "ERROR", sender: "CAPABILITY", roomId: owner.roomId,
      payload: { message } };
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    owner.queue.push({ value, bytes });
    owner.bytes = bytes;
    this.flush(owner);
  }

  flush(owner) {
    if (!owner.token || (!owner.queue.length && !owner.flight)) return;
    if (!owner.timer) {
      owner.timer = setTimeout(() => {
        owner.timer = null;
        if (owner.terminal) this.reset(owner);
        else this.fail(owner, "Transport IPC 消费超时");
      }, HANDSHAKE_TIMEOUT_MS);
      owner.timer.unref();
    }
    if (!owner.subscribed || owner.flight || !owner.queue.length) return;
    const item = owner.queue.shift();
    owner.flight = { id: ++owner.serial, bytes: item.bytes,
      connectionId: item.value.sender === "CAPABILITY" && item.value.type === "PEER_CONNECTED"
        ? item.value.connectionId : null };
    try {
      owner.webContents.send(EVENT_CHANNEL, { token: owner.token, id: owner.flight.id, event: item.value });
    } catch { this.reset(owner); }
  }

  dispose() {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.ipcMain.removeHandler(COMMAND_CHANNEL);
    for (const owner of [...this.owners.values()]) this.detach(owner);
    this.disposing = Promise.all([...this.retiring]).then(() => {});
    return this.disposing;
  }
}

module.exports = { NetworkIpcBridge, COMMAND_CHANNEL, EVENT_CHANNEL };
