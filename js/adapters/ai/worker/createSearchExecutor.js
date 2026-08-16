/*
模块职责
按 runtime environment 选择 AI search transport：browser production 使用 Dedicated Worker，Node/headless 使用同一 runSearchRequest 的 local transport。

上游
Game composition root。

下游
SearchWorkerClient、LocalSearchExecutor。

状态边界
只创建 executor；不写 GameState。

信息边界
不读取 search payload。

架构约束
不得 import core/Game/application/UI/Audio；browser production 不提供同线程 search fallback。
*/
import { createLocalSearchExecutor } from "./LocalSearchExecutor.js?build=20260816-legacy-recovery";
import { createSearchWorkerClient } from "./SearchWorkerClient.js?build=20260816-legacy-recovery";

/*
功能
创建 AI search executor。

调用方
Game 构造函数。

输入
{ explicitExecutor, forceLocal } 选项。

输出
search executor object。

读取状态
  globalThis.Worker/window/document。

写入状态
无。

调用函数
createSearchWorkerClient、createLocalSearchExecutor。

边界与不变量
  显式 executor 优先；browser 缺少 Worker 时 fail fast；Node headless 使用 local transport。
*/
export function createSearchExecutor({ explicitExecutor = null, forceLocal = false } = {}) {
  if (explicitExecutor) return explicitExecutor;
  if (!forceLocal && typeof globalThis.Worker === "function") {
    // 从当前模块的 ?build= 查询继承同一构建标识，避免 production Worker 文件
    // 被浏览器缓存成旧版本；浏览器无 Worker 时仍只允许 explicit local transport。
    const build = new URL(import.meta.url).searchParams.get("build");
    const workerUrl = new URL(`./searchWorker.js${build ? `?build=${build}` : ""}`, import.meta.url);
    return createSearchWorkerClient(workerUrl);
  }
  const isBrowserRuntime = typeof globalThis.window === "object"
    && typeof globalThis.document === "object";
  if (!forceLocal && isBrowserRuntime) {
    throw new Error("当前浏览器不支持 Dedicated Worker；AI 搜索不能回退到主线程");
  }
  return createLocalSearchExecutor();
}
