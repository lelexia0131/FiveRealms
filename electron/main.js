const { app, BrowserWindow, Menu, screen, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHistoryServer } = require("./history-server");
const { NetworkIpcBridge } = require("./network/NetworkIpcBridge");

const PAGE_ZOOM_FACTOR = 0.75;
const DEFAULT_CONTENT_WIDTH = 1280;
const DEFAULT_CONTENT_HEIGHT = 760;
const MIN_CONTENT_WIDTH = 1000;
const MIN_CONTENT_HEIGHT = 650;
const WINDOW_ICON_PATH = path.join(__dirname, "..", "assets", "ui", "five-realms.ico");
const PERFORMANCE_DIAGNOSTICS = process.env.FIVE_REALMS_PERF_DIAGNOSTICS === "1";
const HTTP_ACCESS_LOG = process.env.FIVE_REALMS_HTTP_ACCESS_LOG === "1";
const GPU_DIAGNOSTICS = process.argv.includes("--gpu-diagnostics");
const GPU_INFO_TIMEOUT_MS = 5000;
const GPU_FINAL_STATUS_DELAY_MS = 3000;

let mainWindow = null;
let historyServer = null;
let networkBridge = null;
let isQuitting = false;
let gpuDiagnosticsLogPath = null;
let gpuDiagnosticsWrite = Promise.resolve();
let gpuCrashCount = 0;
let gpuInfoUpdateCount = 0;
let gpuInfoSampleCount = 0;

function logGpuDiagnostic(eventName, details = {}) {
  if (!GPU_DIAGNOSTICS) return;

  const entry = {
    timestamp: new Date().toISOString(),
    event: eventName,
    ...details
  };
  const line = `${JSON.stringify(entry)}\n`;
  console.info(`[electron-gpu] ${line.trim()}`);

  if (!gpuDiagnosticsLogPath) return;
  gpuDiagnosticsWrite = gpuDiagnosticsWrite
    .catch(() => {})
    .then(() => fs.appendFile(gpuDiagnosticsLogPath, line, "utf8"))
    .catch((error) => {
      console.error("GPU diagnostics log write failed:", error);
    });
}

async function getCompleteGpuInfo() {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`GPU info request timed out after ${GPU_INFO_TIMEOUT_MS}ms`)),
      GPU_INFO_TIMEOUT_MS
    );
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => app.getGPUInfo("complete")),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function logGpuStatus(eventName) {
  if (!GPU_DIAGNOSTICS) return;

  const details = { gpuCrashCount, gpuInfoSampleCount:++gpuInfoSampleCount };
  try {
    details.featureStatus = app.getGPUFeatureStatus();
  } catch (error) {
    details.featureStatusError = String(error);
  }
  try {
    details.gpuInfo = await getCompleteGpuInfo();
  } catch (error) {
    details.gpuInfoError = String(error);
  }
  logGpuDiagnostic(eventName, details);
}

async function initializeGpuDiagnostics() {
  if (!GPU_DIAGNOSTICS) return;

  gpuDiagnosticsLogPath = path.join(app.getPath("userData"), "gpu-diagnostics.log");
  gpuDiagnosticsWrite = fs.writeFile(gpuDiagnosticsLogPath, "", "utf8");
  logGpuDiagnostic("started", {
    commandLine: process.argv,
    logPath: gpuDiagnosticsLogPath
  });
  await gpuDiagnosticsWrite;
}

async function startGpuDiagnostics() {
  await initializeGpuDiagnostics();
  await logGpuStatus("ready");
}

async function logFinalGpuStatus() {
  logGpuDiagnostic("gpu-final-status", {
    hardwareAccelerationExplicitlyDisabledByApp:false,
    featureStatus:app.getGPUFeatureStatus(),
    gpuInfoUpdateCount,
    gpuCrashCount
  });
}

function scheduleFinalGpuStatus() {
  const timeoutId = setTimeout(() => {
    void logFinalGpuStatus().catch((error) => {
      console.error("GPU final status sampling failed:", error);
      logGpuDiagnostic("gpu-final-status-error", {
        error:String(error),
        gpuInfoUpdateCount,
        gpuCrashCount
      });
    });
  }, GPU_FINAL_STATUS_DELAY_MS);
  timeoutId.unref?.();
}

if (GPU_DIAGNOSTICS) {
  app.on("child-process-gone", (event, details) => {
    if (details.type !== "GPU" && details.serviceName !== "GPU") return;
    if (details.reason === "crashed") gpuCrashCount += 1;
    logGpuDiagnostic("child-process-gone", { details, gpuCrashCount });
  });
  app.on("gpu-info-update", () => {
    gpuInfoUpdateCount += 1;
    logGpuDiagnostic("gpu-info-update", { gpuInfoUpdateCount, gpuCrashCount });
  });
}

function getInitialContentSize() {
  const { width: workAreaWidth, height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;

  return {
    width: Math.max(MIN_CONTENT_WIDTH, Math.min(DEFAULT_CONTENT_WIDTH, Math.floor(workAreaWidth * 0.75))),
    height: Math.max(MIN_CONTENT_HEIGHT, Math.min(DEFAULT_CONTENT_HEIGHT, Math.floor(workAreaHeight * 0.75)))
  };
}

function isPageZoomShortcut(input) {
  if (input.type !== "keyDown" || !input.control || input.alt) return false;

  return ["Equal", "NumpadAdd", "Minus", "NumpadSubtract", "Digit0", "Numpad0"].includes(input.code)
    || ["+", "=", "-", "0"].includes(input.key);
}

function createMainWindow(url) {
  const { width, height } = getInitialContentSize();

  mainWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    backgroundColor: "#eee8da",
    autoHideMenuBar: true,
    icon: WINDOW_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const { webContents } = mainWindow;
  networkBridge.attach(webContents, url);
  let documentLoadCount = 0;
  let zoomSetCount = 0;
  const logPerformanceEvent = (eventName, details = {}) => {
    if (!PERFORMANCE_DIAGNOSTICS) return;
    console.info(`[electron-perf] ${JSON.stringify({
      timestamp:new Date().toISOString(),
      event:eventName,
      url:webContents.getURL(),
      documentLoadCount,
      rendererReloadCount:Math.max(0, documentLoadCount - 1),
      zoomSetCount,
      ...details
    })}`);
  };

  if (PERFORMANCE_DIAGNOSTICS) {
    webContents.on("did-start-loading", () => logPerformanceEvent("did-start-loading"));
    webContents.on("did-stop-loading", () => logPerformanceEvent("did-stop-loading"));
    webContents.on("dom-ready", () => logPerformanceEvent("dom-ready"));
    webContents.on("did-navigate", (event, navigationUrl) => logPerformanceEvent("did-navigate", { navigationUrl }));
    webContents.on("did-navigate-in-page", (event, navigationUrl, isMainFrame) => {
      logPerformanceEvent("did-navigate-in-page", { navigationUrl, isMainFrame });
    });
    webContents.on("zoom-changed", (event, zoomDirection) => logPerformanceEvent("zoom-changed", { zoomDirection }));
    webContents.on("render-process-gone", (event, details) => logPerformanceEvent("render-process-gone", details));
    mainWindow.on("unresponsive", () => logPerformanceEvent("unresponsive"));
    mainWindow.on("responsive", () => logPerformanceEvent("responsive"));
  }
  if (GPU_DIAGNOSTICS) {
    webContents.on("render-process-gone", (event, details) => {
      logGpuDiagnostic("render-process-gone", { details });
    });
  }

  // A new document receives the browser-tested page zoom exactly once after loading.
  webContents.on("did-finish-load", () => {
    documentLoadCount += 1;
    logPerformanceEvent("did-finish-load");
    if (webContents.isDestroyed()) return;
    const previousZoomFactor = webContents.getZoomFactor();
    webContents.setZoomFactor(PAGE_ZOOM_FACTOR);
    zoomSetCount += 1;
    logPerformanceEvent("setZoomFactor", { previousZoomFactor, zoomFactor:PAGE_ZOOM_FACTOR });
  });
  webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) console.error(`Renderer load failed (${errorCode}): ${errorDescription} ${validatedURL}`);
  });
  webContents.on("before-input-event", (event, input) => {
    if (isPageZoomShortcut(input)) {
      event.preventDefault();
      logPerformanceEvent("zoom-shortcut-blocked", { code:input.code, key:input.key });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void webContents.loadURL(url).catch((error) => {
    console.error("Renderer load rejected:", error);
  });
}

async function startDesktopApp() {
  const rootDirectory = path.join(__dirname, "..");
  const userDataPath = app.getPath("userData");
  const historyPath = path.join(userDataPath, "history_data.json");
  historyServer = createHistoryServer({ rootDirectory, historyPath, logRequests:HTTP_ACCESS_LOG });
  await historyServer.listen();
  networkBridge = new NetworkIpcBridge(ipcMain);
  createMainWindow(historyServer.url);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(historyServer.url);
  });
}

app.whenReady().then(async () => {
  // The desktop build does not expose Chromium's page-zoom menu commands.
  Menu.setApplicationMenu(null);
  await startDesktopApp();
  if (GPU_DIAGNOSTICS) {
    void startGpuDiagnostics().catch((error) => {
      console.error("GPU diagnostics failed:", error);
      logGpuDiagnostic("diagnostics-error", { error:String(error) });
    });
    scheduleFinalGpuStatus();
  }
}).catch((error) => {
  console.error("FiveRealms startup failed:", error);
  app.quit();
});

app.on("will-quit", (event) => {
  if ((!historyServer && !networkBridge) || isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  const server = historyServer;
  const bridge = networkBridge;
  historyServer = null;
  networkBridge = null;
  // Resume quitting after Electron has finished the prevented will-quit dispatch.
  Promise.all([bridge?.dispose(), server?.close()]).then(() => setImmediate(() => app.quit())).catch((error) => {
    console.error("Desktop transport shutdown failed:", error);
    setImmediate(() => app.quit());
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

module.exports = {
  PAGE_ZOOM_FACTOR,
  getInitialContentSize,
  isPageZoomShortcut
};
