/**
 * 本文件集中管理延迟任务，使重新开始时旧异步流程能够立即失效并得到明确返回值。
 * 它不决定游戏规则；UI 等待交互的清理由 UIManager 自己负责。
 */

export class CleanupManager {
  /*
  功能
  创建一组可统一取消的延迟任务容器。

  调用方
  MatchApplication composition root。

  输入
  无。

  输出
  CleanupManager 实例。

  读取状态
  无。

  写入状态
  初始化 pending 集合与 disposed 标记。

  调用函数
  Set 构造器。

  边界与不变量
  实例一旦 cleanup 即永久失效，不得复用于新对局。
  */
  constructor() {
    /** @type {Set<{timer:number, resolve:Function}>} */
    this.pending = new Set();
    this.disposed = false;
  }

  /*
  功能
  创建可由本容器统一取消的延迟。

  调用方
  Application workflow、UI 响应超时与 AI 展示时延。

  输入
  等待毫秒数。

  输出
  自然到期时解析为 true，cleanup 或已销毁时解析为 false 的 Promise。

  读取状态
  disposed 与 pending。

  写入状态
  在 pending 中登记并在到期时移除定时任务。

  调用函数
  globalThis.setTimeout。

  边界与不变量
  每个 Promise 只结算一次；取消不能遗留活跃 timer。
  */
  delay(milliseconds) {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = { timer: 0, resolve };
      entry.timer = globalThis.setTimeout(() => {
        this.pending.delete(entry);
        resolve(!this.disposed);
      }, milliseconds);
      this.pending.add(entry);
    });
  }

  /*
  功能
  取消全部待处理延迟并使等待者以 false 结束。

  调用方
  MatchWorkflow.dispose。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending 定时任务集合。

  写入状态
  disposed 设为 true 并清空 pending。

  调用函数
  globalThis.clearTimeout 与各任务 resolve。

  边界与不变量
  cleanup 可重复调用；所有未完成等待都必须得到明确取消结果。
  */
  cleanup() {
    this.disposed = true;
    for (const entry of this.pending) {
      globalThis.clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }
}
