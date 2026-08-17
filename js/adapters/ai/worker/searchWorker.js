/*
模块职责
Dedicated Browser Worker entry：只接收 SEARCH/CANCEL data-only message，调用共享 runSearchRequest 并返回 RESULT/ERROR。

上游
SearchWorkerClient 与浏览器 Worker runtime。

下游
WorkerSearchRuntime。

状态边界
只写 Worker 局部 activeRequestId/cancelled；不写 GameState。

信息边界
不读取 DOM/Game/真实 entities；所有 payload 必须 structured-clone-safe。

架构约束
不得 import composition、application、UI/Audio 或 Domain transitions；不得使用 Math.random。
*/
import { runSearchRequest } from "./WorkerSearchRuntime.js?build=20260817-architecture-closure-final";

/*
功能
创建独立 Worker message protocol handler。

调用方
Worker entry 与 protocol tests。

输入
{ postMessage } 注入能力。

输出
{ handleMessage }。

读取状态
无。

写入状态
handler 局部 activeRequestId/cancelled。

调用函数
无。

边界与不变量
每个 handler 独立；不共享跨 Worker 状态。
*/
export function createSearchWorkerMessageHandler({ postMessage }) {
  let activeRequestId = null;
  let cancelled = false;

/*
功能
处理 main thread 发来的 Worker message。

调用方
self.onmessage。

输入
{ type, requestId, request }。

输出
无直接返回；postMessage RESULT/ERROR。

读取状态
activeRequestId/cancelled。

写入状态
activeRequestId/cancelled。

调用函数
runSearchRequest、postMessage。

边界与不变量
一个 requestId 只允许一个 terminal outcome；CANCEL 后不返回可执行 result。
*/
async function handleMessage(message) {
  const type = message?.type;
  const requestId = message?.requestId ?? null;
  if (type === "CANCEL") {
    if (activeRequestId === requestId) cancelled = true;
    return;
  }
  if (type !== "SEARCH" || !requestId || !message.request) {
    postMessage({ type:"ERROR", requestId:requestId ?? null, workerError:"unknown or malformed Worker message" });
    return;
  }
  if (activeRequestId !== null) {
    postMessage({ type:"ERROR", requestId, workerError:"another search is already active" });
    return;
  }
  activeRequestId = requestId;
  cancelled = false;
  try {
    const outcome = await runSearchRequest(message.request, {
      now: () => globalThis.performance?.now?.() ?? Date.now(),
      yieldControl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return !cancelled;
      }
    });
    if (cancelled) {
      postMessage({ type:"ERROR", requestId, workerError:"cancelled" });
    } else {
      postMessage({ type:"RESULT", requestId, outcome });
    }
  } catch (error) {
    postMessage({
      type:"ERROR",
      requestId,
      workerError:error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (activeRequestId === requestId) activeRequestId = null;
    cancelled = false;
  }
}

  return { handleMessage };
}

if (typeof self !== "undefined") {
  const handler = createSearchWorkerMessageHandler({ postMessage: (data) => self.postMessage(data) });
  self.onmessage = (event) => { handler.handleMessage(event.data); };
}
