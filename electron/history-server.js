const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_HISTORY_BYTES = 1024 * 1024;
const HISTORY_VERSION = 1;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0"
};
const STATIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable"
};

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": JSON_CONTENT_TYPE,
  ".svg": "image/svg+xml",
  ".wav": "audio/wav"
});

async function writeHistoryAtomically(targetPath, content) {
  const directory = path.dirname(targetPath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = await fs.promises.open(temporaryPath, "wx", 0o600);
    await descriptor.writeFile(content);
    await descriptor.sync();
    await descriptor.close();
    descriptor = null;
    await fs.promises.rename(temporaryPath, targetPath);
  } catch (error) {
    if (descriptor !== null) await descriptor.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sendResponse(response, statusCode, body, contentType = JSON_CONTENT_TYPE) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    ...NO_CACHE_HEADERS,
    "Content-Type": contentType,
    "Content-Length": payload.length
  });
  response.end(payload);
}

function sendJson(response, statusCode, payload) {
  sendResponse(response, statusCode, JSON.stringify(payload), JSON_CONTENT_TYPE);
}

function readRequestBody(request) {
  const contentLengthHeader = request.headers["content-length"];
  if (contentLengthHeader === undefined) {
    request.resume();
    return Promise.reject(Object.assign(new Error("history payload size rejected"), { statusCode: 413 }));
  }
  const normalizedContentLength = String(contentLengthHeader).trim();
  if (!/^[+-]?\d+$/.test(normalizedContentLength)) {
    request.resume();
    return Promise.reject(Object.assign(new Error("invalid content length"), { statusCode: 400 }));
  }
  const contentLength = Number(normalizedContentLength);
  if (contentLength <= 0 || contentLength > MAX_HISTORY_BYTES) {
    request.resume();
    return Promise.reject(Object.assign(new Error("history payload size rejected"), { statusCode: 413 }));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received > MAX_HISTORY_BYTES) {
        rejected = true;
        request.resume();
        reject(Object.assign(new Error("history payload size rejected"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks, received));
    });
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function parseHistoryPayload(body) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    const error = new Error("invalid history json");
    error.statusCode = 400;
    throw error;
  }

  const requiredKeys = ["version", "summary", "characters", "teams", "records"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.version !== HISTORY_VERSION || requiredKeys.some((key) => !(key in payload))) {
    const error = new Error("unsupported history schema");
    error.statusCode = 400;
    throw error;
  }
  return payload;
}

function safeStaticPath(rootDirectory, requestPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(rootDirectory, relativePath);
  const root = path.resolve(rootDirectory);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${path.sep}`)) return null;
  return resolvedPath;
}

function createHistoryServer({ rootDirectory, historyPath, host = "127.0.0.1", port = 0, logger = console, logRequests = false }) {
  if (!rootDirectory || !historyPath) throw new TypeError("history server requires rootDirectory and historyPath");
  let closed = false;
  let closing = null;

  const logRequest = (method, requestPath, statusCode) => {
    if (logRequests) logger.info(`${method} ${requestPath} -> ${statusCode}`);
  };

  const server = http.createServer(async (request, response) => {
    let requestPath;
    try {
      requestPath = new URL(request.url ?? "/", `http://${host}`).pathname;
      if (requestPath === "/api/history/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        logRequest(request.method, requestPath, 200);
        return;
      }

      if (requestPath === "/api/history" && request.method === "GET") {
        if (!await fileExists(historyPath)) {
          sendJson(response, 404, { error: "history archive not found" });
          logRequest(request.method, requestPath, 404);
          return;
        }
        const body = await fs.promises.readFile(historyPath);
        sendResponse(response, 200, body);
        logRequest(request.method, requestPath, 200);
        return;
      }

      if (requestPath === "/api/history" && request.method === "PUT") {
        let body;
        try {
          body = await readRequestBody(request);
        } catch (error) {
          const statusCode = error.statusCode ?? 500;
          sendJson(response, statusCode, { error: error.message });
          logRequest(request.method, requestPath, statusCode);
          return;
        }
        let payload;
        try {
          payload = parseHistoryPayload(body);
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, { error: error.message });
          logRequest(request.method, requestPath, error.statusCode ?? 400);
          return;
        }
        const serialized = `${JSON.stringify(payload, null, 2)}\n`;
        const createOnly = (request.headers["if-none-match"] ?? "").trim() === "*";
        if (createOnly && await fileExists(historyPath)) {
          sendJson(response, 412, { error: "history archive already exists" });
          logRequest(request.method, requestPath, 412);
          return;
        }
        try {
          await writeHistoryAtomically(historyPath, Buffer.from(serialized, "utf8"));
        } catch (error) {
          sendJson(response, 500, { error: error.message });
          logRequest(request.method, requestPath, 500);
          return;
        }
        sendJson(response, 200, { ok: true });
        logRequest(request.method, requestPath, 200);
        return;
      }

      if (requestPath.startsWith("/api/history")) {
        sendJson(response, 404, { error: "unknown endpoint" });
        logRequest(request.method, requestPath, 404);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 404, { error: "unknown endpoint" });
        logRequest(request.method, requestPath, 404);
        return;
      }

      const filePath = safeStaticPath(rootDirectory, requestPath);
      const projectHistoryPath = path.resolve(rootDirectory, "history_data.json");
      if (!filePath || filePath === projectHistoryPath || filePath === path.resolve(historyPath)) {
        sendJson(response, 404, { error: "not found" });
        logRequest(request.method, requestPath, 404);
        return;
      }
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        stat = null;
      }
      if (!stat?.isFile()) {
        sendJson(response, 404, { error: "not found" });
        logRequest(request.method, requestPath, 404);
        return;
      }
      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      response.writeHead(200, {
        ...STATIC_CACHE_HEADERS,
        "Content-Type": contentType,
        "Content-Length": stat.size
      });
      if (request.method === "HEAD") response.end();
      else response.end(await fs.promises.readFile(filePath));
      logRequest(request.method, requestPath, 200);
    } catch (error) {
      logger.error(`History server request failed: ${request.method} ${requestPath}`, error);
      if (!response.headersSent) sendJson(response, 500, { error: error.message });
      else response.destroy(error);
    }
  });

  return {
    server,
    get url() {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("history server is not listening");
      return `http://${host}:${address.port}/`;
    },
    get address() {
      return server.address();
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          if (logRequests) {
            logger.info(`History server listening: ${this.url}`);
            logger.info(`History data path: ${historyPath}`);
          }
          resolve(this);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      server.closeAllConnections?.();
      closing = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else {
            closed = true;
            resolve();
          }
        });
      });
      return closing;
    }
  };
}

module.exports = {
  HISTORY_VERSION,
  MAX_HISTORY_BYTES,
  createHistoryServer,
  parseHistoryPayload,
  writeHistoryAtomically
};
