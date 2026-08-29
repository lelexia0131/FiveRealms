/*
模块职责
Dedicated Browser Worker entry：接收 SEARCH/CANCEL data-only message，调用共享 runSearchRequest，并返回 HEARTBEAT 与唯一 RESULT/ERROR terminal。

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
import { runSearchRequest } from "./WorkerSearchRuntime.js";

/*
功能
创建独立 Worker message protocol handler。

调用方
Worker entry 与 protocol tests。

输入
{ postMessage } 注入能力。

输出
{ handleMessage }；搜索运行期间 HEARTBEAT 与 terminal 共用 requestId。

读取状态
无。

写入状态
handler 局部 activeRequestId/cancelled。

调用函数
无。

边界与不变量
每个 handler 独立；不共享跨 Worker 状态；heartbeat 只证明当前 Worker 仍在执行，不表示搜索完成。
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
runSearchRequest、postMessage、setTimeout。

边界与不变量
一个 requestId 只允许一个 terminal outcome；HEARTBEAT 可重复且不清理请求；CANCEL 后只运输 Searcher 已完成的 incumbent，Main Thread 仍负责状态验收。
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
  const watchdogMs = Number(message.request.searchConfig?.hardWatchdogMs);
  const heartbeatIntervalMs = Number.isFinite(watchdogMs) && watchdogMs > 0
    ? Math.max(1, watchdogMs / 4)
    : 0;
  let lastHeartbeatAt = Number.NEGATIVE_INFINITY;

  /*
  功能
  为当前 request 发送经过节流的 Worker liveness heartbeat。

  调用方
  handleMessage 初始接收、runtimeNow 与 yieldToWorkerEventLoop。

  输入
  是否强制发送，以及可选已读取的单调时间。

  输出
  已发送返回 true；仍在节流窗口内返回 false。

  读取状态
  requestId、heartbeatIntervalMs 与 lastHeartbeatAt。

  写入状态
  lastHeartbeatAt。

  调用函数
  postMessage、performance.now、Date.now。

  边界与不变量
  heartbeat 不携带搜索结果或进度，不改变 SearchBudget；同步搜索检查点可直接 postMessage，无需等待 Worker timer 回调。
  */
  function reportHeartbeat(force = false, observedAt = null) {
    const now = Number.isFinite(Number(observedAt))
      ? Number(observedAt)
      : globalThis.performance?.now?.() ?? Date.now();
    if (!force && heartbeatIntervalMs > 0 && now - lastHeartbeatAt < heartbeatIntervalMs) {
      return false;
    }
    postMessage({ type:"HEARTBEAT", requestId });
    lastHeartbeatAt = now;
    return true;
  }

  /*
  功能
  读取 SearchBudget 的单调时钟并在同步工作检查点报告 Worker liveness。

  调用方
  runSearchRequest 注入的 runtime control。

  输入
  无。

  输出
  当前单调毫秒时间。

  读取状态
  global performance/Date 时钟。

  写入状态
  可能经 reportHeartbeat 更新 lastHeartbeatAt。

  调用函数
  reportHeartbeat、performance.now、Date.now。

  边界与不变量
  返回值仍是 SearchBudget 的原始时钟；liveness side-channel 不修改预算数值或停止原因。
  */
  function runtimeNow() {
    const now = globalThis.performance?.now?.() ?? Date.now();
    reportHeartbeat(false, now);
    return now;
  }

  /*
  功能
  在 Searcher cooperative yield 处让出 Worker 事件循环并报告 liveness/cancellation。

  调用方
  runSearchRequest 注入的 runtime control。

  输入
  无。

  输出
  request 仍活动返回 true；收到 CANCEL 返回 false。

  读取状态
  cancelled。

  写入状态
  可能经 reportHeartbeat 更新 lastHeartbeatAt。

  调用函数
  reportHeartbeat、setTimeout。

  边界与不变量
  heartbeat 在让步前即可运输；让步后必须重新读取 cancellation，不能把 CANCEL 延迟到下一轮搜索。
  */
  async function yieldToWorkerEventLoop() {
    reportHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    reportHeartbeat();
    return !cancelled;
  }

  try {
    reportHeartbeat(true);
    const outcome = await runSearchRequest(message.request, {
      now:runtimeNow,
      yieldControl:yieldToWorkerEventLoop
    });
    postMessage({ type:"RESULT", requestId, outcome });
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
