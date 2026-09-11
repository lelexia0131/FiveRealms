const os = require("node:os");
const PROTOCOL_VERSION = 1;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 4 * MAX_PAYLOAD_BYTES;
const MAX_QUEUE_MESSAGES = 128;
const HANDSHAKE_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 12000;

function connectionInfo(port, interfaces = os.networkInterfaces()) {
  const byAddress = new Map();

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (
        !entry ||
        (entry.family !== "IPv4" && entry.family !== 4) ||
        entry.internal ||
        entry.address.startsWith("127.") ||
        entry.address === "0.0.0.0"
      ) {
        continue;
      }

      const current = byAddress.get(entry.address);

      const candidate = {
        host: entry.address,
        port,
        interfaceName,
        kind: /tailscale/i.test(interfaceName) ? "tailscale" : "lan"
      };

      // Prefer an explicitly named Tailscale adapter if Windows exposes
      // the same address more than once.
      if (
        !current ||
        (candidate.kind === "tailscale" && current.kind !== "tailscale")
      ) {
        byAddress.set(entry.address, candidate);
      }
    }
  }

  const addresses = [...byAddress.values()];

  addresses.sort(
    (a, b) =>
      Number(b.kind === "tailscale") -
      Number(a.kind === "tailscale") ||
      a.interfaceName.localeCompare(b.interfaceName) ||
      a.host.localeCompare(b.host)
  );

  return addresses.length
    ? {
      host: addresses[0].host,
      port,
      addresses
    }
    : null;
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function encodeFrame(value) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("无效 Transport JSON");

  const length = Buffer.byteLength(json, "utf8");
  if (!length || length > MAX_PAYLOAD_BYTES) {
    throw new Error("Transport payload 超过上限");
  }

  const frame = Buffer.allocUnsafe(length + 4);
  frame.writeUInt32BE(length, 0);
  frame.write(json, 4, "utf8");

  return frame;
}

// Retain at most one validated frame, including across arbitrary TCP data chunks.
class FrameDecoder {
  constructor(receive) {
    this.receive = receive;
    this.header = Buffer.alloc(4);
    this.headerBytes = 0;
    this.body = null;
    this.bodyBytes = 0;
    this.closed = false;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  push(chunk) {
    let offset = 0;

    try {
      while (!this.closed && offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(
            4 - this.headerBytes,
            chunk.length - offset
          );

          chunk.copy(
            this.header,
            this.headerBytes,
            offset,
            offset + count
          );

          this.headerBytes += count;
          offset += count;

          if (this.headerBytes < 4) continue;

          const length = this.header.readUInt32BE(0);

          if (!length || length > MAX_PAYLOAD_BYTES) {
            throw new Error("非法 Transport frame 长度");
          }

          this.body = Buffer.allocUnsafe(length);
        }

        const count = Math.min(
          this.body.length - this.bodyBytes,
          chunk.length - offset
        );

        chunk.copy(
          this.body,
          this.bodyBytes,
          offset,
          offset + count
        );

        this.bodyBytes += count;
        offset += count;

        if (this.bodyBytes !== this.body.length) continue;

        const value = JSON.parse(
          this.decoder.decode(this.body)
        );

        this.body = null;
        this.bodyBytes = 0;
        this.headerBytes = 0;

        this.receive(value);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.closed = true;
    this.body = null;
    this.header = null;
    this.receive = null;
  }
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_PAYLOAD_BYTES,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_MESSAGES,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  connectionInfo,
  isIdentity,
  encodeFrame,
  FrameDecoder
};