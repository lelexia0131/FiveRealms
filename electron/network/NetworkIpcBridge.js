const { LanHostTransport } = require("./LanHostTransport");
const { LanClientTransport } = require("./LanClientTransport");
const { MAX_QUEUE_BYTES, MAX_QUEUE_MESSAGES, MAX_CONNECTION_PENDING_MESSAGES,
  MAX_CONNECTION_PENDING_BYTES, MAX_TOTAL_CONNECTIONS, HANDSHAKE_TIMEOUT_MS, isIdentity } = require("./TransportProtocol");

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

  /*
  功能
  注册 renderer 生命周期及总队列、连接记账。

  调用方
  Electron 主进程窗口装配。

  输入
  受信任 webContents 与页面 URL。

  输出
  无；重复注册或已关闭抛错。

  读取状态
  bridge.disposed、owners。

  写入状态
  owner、navigation/gone/destroyed 监听器。

  调用函数
  webContents.on、reset、detach。

  边界与不变量
  连接预算归 owner 所有；导航和 renderer 退出必须清空整个 endpoint。
  */
  attach(webContents, url) {
    if (this.disposed || this.owners.has(webContents)) throw new Error("Network IPC 已注册或关闭");
    const owner = { webContents, origin: new URL(url).origin, token: null, transport: null,
      connections: new Map(),
      admissions: new Set(),
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

  /*
  功能
  关闭当前 endpoint 并清除所有排队和连接状态。

  调用方
  窗口生命周期、command close、错误清理。

  输入
  当前 renderer owner。

  输出
  无。

  读取状态
  owner.transport。

  写入状态
  token、queue、flight、计时器、pending 和 admission 记录。

  调用函数
  retire、clearTimeout。

  边界与不变量
  仅 endpoint 生命周期使用；单 Guest 超限不得调用。
  */
  reset(owner) {
    owner.token = null;
    owner.roomId = null;
    owner.subscribed = false;
    owner.queue = [];
    owner.bytes = 0;
    owner.connections.clear();
    owner.admissions.clear();
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

  /*
  功能
  验证 renderer 来源并执行传输命令或串行消费确认。

  调用方
  唯一 IPC command handler。

  输入
  IPC event、带 token 的命令。

  输出
  异步命令结果；非法来源或失效连接抛错。

  读取状态
  授权页面、owner token、flight。

  写入状态
  Transport 生命周期与当前 flight 的消费记账。

  调用函数
  authorized、resolveConnection、release、reset、flush。

  边界与不变量
  ACK 仅释放匹配 flight；只有 PEER_CONNECTED 的 ACK 能绑定 participant，普通消息不得重绑。
  */
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
      if (owner.flight.admission) {
        owner.transport?.resolveConnection(owner.flight.connectionId, request.result);
        if (!request.result?.ok) owner.admissions.delete(owner.flight.connectionId);
      }
      this.release(owner, owner.flight);
      owner.bytes -= owner.flight.bytes;
      owner.flight = null;
      clearTimeout(owner.timer);
      owner.timer = null;
      this.flush(owner);
    } else throw new Error("未知 Network IPC 操作");
  }

  /*
  功能
  在总 IPC 串行队列中按认证来源实施接收预算。

  调用方
  Host/Client Transport 的 onEvent。

  输入
  owner、generation token 与 Transport 注入事件。

  输出
  无；违规连接事件被丢弃并关闭该连接。

  读取状态
  owner 总队列、flight 和连接 pending。

  写入状态
  队列、字节数、pending 与 admission 生命周期。

  调用函数
  failConnection、discardConnectionQueue、fail、flush。

  边界与不变量
  普通消息预留离房通知空间；Guest 超限只关闭自身，endpoint 故障仍由 fail 处理。
  */
  enqueue(owner, token, value) {
    if (owner.token !== token || owner.terminal || this.disposed) return;
    if (!owner.roomId && value.sender === "CAPABILITY") owner.roomId = value.roomId;
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const connectionId = owner.transport instanceof LanHostTransport ? value.connectionId : null;
    const item = { value, bytes, connectionId };
    if (connectionId) {
      const disconnected = value.sender === "CAPABILITY" && value.type === "DISCONNECTED";
      if (disconnected) {
        this.discardConnectionQueue(owner, connectionId);
        // 尚未投递的入房事件已撤销，renderer 不曾拥有该成员，无需再排一条离房事件。
        if (!owner.admissions.delete(connectionId)) return;
      }
      const pending = owner.connections.get(connectionId) ?? { messages: 0, bytes: 0 };
      if (!disconnected && (pending.messages >= MAX_CONNECTION_PENDING_MESSAGES
        || pending.bytes + bytes > MAX_CONNECTION_PENDING_BYTES)) {
        this.failConnection(owner, connectionId);
        return;
      }
      // 总预算仍然保留并为离房通知预留空间；拒绝当前来源，绝不为新连接驱逐其它 Guest。
      const messageLimit = MAX_QUEUE_MESSAGES - (disconnected ? 0 : MAX_TOTAL_CONNECTIONS);
      const byteLimit = MAX_QUEUE_BYTES - (disconnected ? 0 : MAX_TOTAL_CONNECTIONS * 1024);
      if (owner.bytes + bytes > byteLimit || owner.queue.length + Number(Boolean(owner.flight)) >= messageLimit) {
        this.failConnection(owner, connectionId);
        return;
      }
      pending.messages += 1;
      pending.bytes += bytes;
      owner.connections.set(connectionId, pending);
    }
    if (owner.bytes + bytes > MAX_QUEUE_BYTES || owner.queue.length + Number(Boolean(owner.flight)) >= MAX_QUEUE_MESSAGES) {
      this.fail(owner, "Transport IPC 接收队列超过上限");
      return;
    }
    owner.queue.push(item);
    owner.bytes += bytes;
    this.flush(owner);
  }

  /*
  功能
  撤销已消费或已丢弃消息的单连接待处理记账。

  调用方
  command ack、failConnection。

  输入
  owner 与携带连接来源的队列项。

  输出
  无。

  读取状态
  owner.connections。

  写入状态
  指定连接 pending messages/bytes，归零即删除。

  调用函数
  Map.delete。

  边界与不变量
  排队与 flight 都计入预算，每条消息只释放一次。
  */
  release(owner, item) {
    const pending = owner.connections.get(item.connectionId);
    if (!pending) return;
    pending.messages -= 1;
    pending.bytes -= item.bytes;
    if (!pending.messages) owner.connections.delete(item.connectionId);
  }

  /*
  功能
  丢弃违规连接尚未投递的消息并关闭该 socket。

  调用方
  enqueue。

  输入
  owner、Transport 认证 connectionId。

  输出
  无。

  读取状态
  总串行队列与指定来源。

  写入状态
  仅该连接 queued 记账及 socket 生命周期。

  调用函数
  release、LanHostTransport.closeConnection。

  边界与不变量
  已发送 flight 仍等待原 ACK 或 endpoint timeout；关闭后仍交付 DISCONNECTED，使游戏侧执行既有接管。
  */
  failConnection(owner, connectionId) {
    this.discardConnectionQueue(owner, connectionId);
    owner.transport?.closeConnection(connectionId, "Transport connection IPC 接收队列超过上限");
  }

  /*
  功能
  删除指定连接未交付的普通事件，保留已经排队的离房通知。

  调用方
  failConnection、enqueue DISCONNECTED。

  输入
  owner、connectionId。

  输出
  无。

  读取状态
  owner.queue 的来源与事件类型。

  写入状态
  总队列及连接字节和消息记账。

  调用函数
  release。

  边界与不变量
  flight 无法撤回；其它连接的排队顺序不变。
  */
  discardConnectionQueue(owner, connectionId) {
    const retained = [];
    for (const item of owner.queue) {
      if (item.connectionId !== connectionId || (item.value.sender === "CAPABILITY" && item.value.type === "DISCONNECTED")) { retained.push(item); continue; }
      owner.bytes -= item.bytes;
      this.release(owner, item);
    }
    owner.queue = retained;
  }

  /*
  功能
  终止失效 renderer endpoint 并排队一次终端错误。

  调用方
  无连接来源的队列故障、消费超时。

  输入
  owner 与错误说明。

  输出
  无。

  读取状态
  owner.transport 和 roomId。

  写入状态
  整个 endpoint 的 transport、queue、flight、计时器和连接记账。

  调用函数
  retire、flush。

  边界与不变量
  只用于 endpoint 故障；不能用于某个 Guest 的预算超限。
  */
  fail(owner, message) {
    this.retire(owner.transport);
    owner.transport = null;
    owner.terminal = true;
    owner.queue = [];
    owner.bytes = 0;
    owner.connections.clear();
    owner.admissions.clear();
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

  /*
  功能
  向 renderer 串行投递一个事件并等待原 ACK。

  调用方
  enqueue、subscribe、ack。

  输入
  owner。

  输出
  无。

  读取状态
  订阅状态、flight、queue。

  写入状态
  flight、admissions、serial 和消费超时计时器。

  调用函数
  webContents.send、fail、reset。

  边界与不变量
  移到 flight 不释放预算；发送失败或一直不 ACK 是 endpoint 故障。
  只有 Host 入站连接需要 admission，Guest 的连接完成通知仅确认消费。
  */
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
    owner.flight = { id: ++owner.serial, bytes: item.bytes, connectionId: item.connectionId,
      admission: owner.transport instanceof LanHostTransport
        && item.value.sender === "CAPABILITY" && item.value.type === "PEER_CONNECTED" };
    if (owner.flight.admission) owner.admissions.add(item.connectionId);
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
