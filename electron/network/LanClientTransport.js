const net = require("node:net");
const { TcpPeer } = require("./TcpPeer");

class LanClientTransport {
  constructor({ onEvent, ...timing }) {
    this.onEvent = onEvent;
    this.timing = timing;
    this.peer = null;
    this.stopped = false;
    this.closing = null;
  }

  async joinRoom(endpoint) {
    const { normalizeNetworkEndpoint } = await import("../../js/network/NetworkProtocol.js");
    if (this.peer || this.stopped) return Promise.reject(new Error("Transport 已使用"));
    endpoint = normalizeNetworkEndpoint(endpoint);
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.peer = new TcpPeer(socket, {
        ...this.timing, role: "GUEST",
        onConnected: (peer) => {
          resolve({ roomId: peer.roomId });
          this.onEvent?.({ type: "PEER_CONNECTED", sender: "CAPABILITY", roomId: peer.roomId, payload: {} });
        },
        onEnvelope: (envelope) => { if (!this.stopped) this.onEvent?.(envelope); },
        onClosed: (message, connected) => {
          socket.off("connect", this.onConnect);
          reject(new Error(message));
          if (!this.stopped && connected) {
            this.onEvent?.({ type: "DISCONNECTED", sender: "CAPABILITY", roomId: this.peer.roomId,
              payload: { message, code: this.peer.reasonCode } });
          }
          this.stopped = true;
          this.onEvent = null;
        }
      });
      this.onConnect = () => {
        try { this.peer.startClient(); } catch (error) { void this.peer.close(error.message); }
      };
      socket.once("connect", this.onConnect);
      try { socket.connect({ ...endpoint, family: 4 }); }
      catch (error) { void this.peer.close(error.message); }
    });
  }

  send(envelope) {
    if (this.stopped || !this.peer) throw new Error("Host 尚未连接");
    this.peer.send(envelope);
  }

  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.onEvent = null;
    if (this.peer) this.peer.socket.off("connect", this.onConnect);
    this.closing = this.peer?.close() ?? Promise.resolve();
    return this.closing;
  }
}

module.exports = { LanClientTransport };
