/**
 * 本文件集中管理延迟任务，使重新开始时旧异步流程能够立即失效并得到明确返回值。
 * 它不决定游戏规则；UI 等待交互的清理由 UIManager 自己负责。
 */

export class CleanupManager {
  constructor() {
    /** @type {Set<{timer:number, resolve:Function}>} */
    this.pending = new Set();
    this.disposed = false;
  }

  /**
   * 创建可取消延迟。正常结束返回 true，cleanup 后返回 false。
   * @param {number} milliseconds 等待毫秒数。
   * @returns {Promise<boolean>} 是否自然完成。
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

  /** 清除全部延迟并令等待者返回 false；重新开始时必须调用。 */
  cleanup() {
    this.disposed = true;
    for (const entry of this.pending) {
      globalThis.clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }
}
