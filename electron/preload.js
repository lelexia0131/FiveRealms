const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed preload cannot require local modules. These are fixed private IPC names.
const COMMAND_CHANNEL = "five-realms:network:command";
const EVENT_CHANNEL = "five-realms:network:event";
let token = null;
let listener = null;
let attached = false;

function invoke(op, fields = {}, connection = token) {
  return ipcRenderer.invoke(COMMAND_CHANNEL, { ...fields, op, token: connection });
}

function report(error, connection) {
  if (token !== connection || !listener) return;
  listener({ type: "ERROR", sender: "CAPABILITY", roomId, payload: { message: error.message } });
}

let roomId = null;
function receive(_ipcEvent, packet) {
  if (!packet || packet.token !== token || !listener) return;
  const connection = token;
  let result;
  try { result = listener(packet.event); }
  finally { void invoke("ack", { id: packet.id, result }, connection).catch((error) => report(error, connection)); }
}

function detach() {
  if (attached) ipcRenderer.removeListener(EVENT_CHANNEL, receive);
  attached = false;
  listener = null;
}

async function open(op, fields) {
  close();
  const connection = crypto.randomUUID();
  token = connection;
  try {
    const result = await invoke(op, fields, connection);
    if (token !== connection) throw new Error("连接请求已取消");
    roomId = result.roomId;
    return result;
  } catch (error) {
    if (token === connection) close();
    throw error;
  }
}

function close() {
  const connection = token;
  token = null;
  roomId = null;
  detach();
  if (connection) return invoke("close", {}, connection).catch(() => {});
  return Promise.resolve();
}

contextBridge.exposeInMainWorld("fiveRealmsNetworkCapability", Object.freeze({
  createRoom: ({ roomId }) => open("createRoom", { roomId }),
  joinRoom: ({ host, port }) => open("joinRoom", { host, port }),
  send: (envelope) => {
    const connection = token;
    // Admission publishes synchronously. Queue its sends after the callback's ACK
    // so main binds the returned participantId before routing the first snapshot.
    return Promise.resolve().then(() => invoke("send", { envelope }, connection));
  },
  subscribe: (receiveEvent) => {
    if (typeof receiveEvent !== "function" || !token) throw new Error("无效 Network 订阅");
    if (listener) throw new Error("Network capability 只允许一个当前订阅");
    const connection = token;
    listener = receiveEvent;
    ipcRenderer.on(EVENT_CHANNEL, receive);
    attached = true;
    void invoke("subscribe", {}, connection).catch((error) => report(error, connection));
    return () => {
      if (token !== connection || listener !== receiveEvent) return;
      detach();
      void invoke("unsubscribe", {}, connection).catch(() => {});
    };
  },
  close
}));
window.addEventListener("unload", () => { void close(); }, { once: true });
