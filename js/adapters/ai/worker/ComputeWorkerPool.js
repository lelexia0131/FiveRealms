/*
模块职责
在 Coordinator 内管理最多四个纯计算 Worker 和单个 FIFO sibling 队列。

上游
searchWorker protocol 与定向测试。

下游
computeWorker message protocol。

状态边界
只拥有 transport pending、generation、batch/index 和 Worker 生命周期。

信息边界
只运输已过滤的普通数据，不采样或解释 World。

架构约束
不拥有 Searcher、Budget、RNG、Beam 或 winner；admission 必须回调 Searcher。
*/
export class ComputeWorkerPool {
  /*
  功能
  配置有界 Worker 池，实际 Worker 在 start 时创建。

  调用方
  Coordinator protocol 与测试。

  输入
  poolSize（1 至 4）与可注入 Worker factory。

  输出
  可 start/runBatch/cancel/dispose 的池。

  读取状态
  无。

  写入状态
  当前池的 transport 和诊断字段。

  调用函数
  无。

  边界与不变量
  不创建本地 retry，不接受搜索配置或预算能力。
  */
  constructor({ poolSize = 4, workerFactory = null } = {}) {
    this.poolSize = Math.max(1, Math.min(4, Math.floor(Number(poolSize) || 1)));
    this.workerFactory = workerFactory ?? (() => new Worker(new URL("./computeWorker.js", import.meta.url), { type:"module" }));
    this.workers = [];
    this.generation = 0;
    this.batch = null;
    this.disposed = false;
    this.stats = { dispatched:0, completed:0, peakInFlight:0, postMessageMs:0, roundTripMs:0, computeMs:0 };
  }

  /*
  功能
  初始化当前搜索的纯计算组合并等待 Worker 就绪。

  调用方
  executeSearchRequest 的预算创建之前。

  输入
  仅 root World 与 difficultyMultiplier 的普通 composition 数据。

  输出
  全部 Worker ready；任何初始化错误拒绝本次搜索。

  读取状态
  当前 Worker 与 disposed。

  写入状态
  新 generation、Worker 和 pending。

  调用函数
  workerFactory、send、cancel。

  边界与不变量
  旧 generation 必须先结束；初始化不消费 SearchBudget。
  */
  async start(composition) {
    if (this.disposed) throw new Error("Compute pool disposed");
    if (this.batch || this.workers.some(slot => slot.pending)) throw new Error("Compute batch already active");
    const startedAt = performance.now();
    this.generation += 1;
    const generation = this.generation;
    this.stats = { dispatched:0, completed:0, peakInFlight:0, postMessageMs:0, roundTripMs:0, computeMs:0 };
    try {
      while (this.workers.length < this.poolSize) {
        const worker = this.workerFactory();
        const slot = { worker, pending:null };
        this.workers.push(slot);
        worker.addEventListener("message", event => this.receive(slot, event.data));
        worker.addEventListener("error", event => this.workerError(slot, event.message || "Compute Worker error"));
        worker.addEventListener("messageerror", () => this.workerError(slot, "Compute Worker messageerror"));
      }
      await Promise.all(this.workers.map(slot => this.send(slot, {
        type:"INIT", generation:this.generation, batchId:0, canonicalIndex:-1, composition
      })));
      this.stats.initializationMs = performance.now() - startedAt;
      this.stats.roundTripMs = 0;
      this.stats.postMessageMs = 0;
    } catch (error) {
      if (this.generation === generation) this.cancel(error);
      throw error;
    }
  }

  /*
  功能
  发送当前 slot 的唯一消息并保存 exact identity pending。

  调用方
  start 与 runSlot。

  输入
  空闲 slot 与 INIT/COMPUTE 消息。

  输出
  对应 READY/RESULT 的 Promise。

  读取状态
  Worker 引用。

  写入状态
  slot.pending 与 postMessage timing。

  调用函数
  Worker.postMessage、performance.now。

  边界与不变量
  一个 slot 最多一个 pending；发送错误必须 reject 并由 pool 终止全部工作。
  */
  send(slot, message) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      slot.pending = { ...message, resolve, reject, startedAt };
      try {
        slot.worker.postMessage(message);
        this.stats.postMessageMs += performance.now() - startedAt;
      } catch (error) {
        slot.pending = null;
        reject(error);
      }
    });
  }

  /*
  功能
  只接收当前 generation/batch/index 的唯一 terminal。

  调用方
  Worker message listener。

  输入
  来源 slot 与 data-only message。

  输出
  无；resolve 或 reject 当前 pending。

  读取状态
  slot.pending 与 generation。

  写入状态
  pending 清零与 transport timing。

  调用函数
  pending.resolve/reject、cancel。

  边界与不变量
  stale/duplicate 消息不能进入新搜索；真实 ERROR 不得返回部分结果。
  */
  receive(slot, message) {
    const pending = slot.pending;
    if (!pending || message.generation !== this.generation
      || message.generation !== pending.generation || message.batchId !== pending.batchId
      || message.canonicalIndex !== pending.canonicalIndex) return;
    if (message.type === "ERROR") {
      const error = new Error(message.error?.message || "Compute Worker error");
      error.name = message.error?.name || "Error";
      error.canonicalIndex = pending.canonicalIndex;
      this.cancel(error);
      return;
    }
    if (message.type !== (pending.type === "INIT" ? "READY" : "RESULT")) {
      this.cancel(new Error("Malformed Compute Worker terminal"));
      return;
    }
    slot.pending = null;
    this.stats.roundTripMs += performance.now() - pending.startedAt;
    if (pending.type === "COMPUTE" && message.receipt) {
      this.stats.completed += 1;
      this.stats.computeMs += message.receipt.timing.durationMs;
    }
    pending.resolve(message.receipt);
  }

  /*
  功能
  把 canonical sibling batch 放入唯一 FIFO 队列并按 index join。

  调用方
  Searcher.materializeSiblingCandidates。

  输入
  batchId、候选数量与由 Searcher 持有的 admit 回调。

  输出
  canonical index 顺序的完整 receipt 前缀。

  读取状态
  空闲 Worker 与 generation。

  写入状态
  当前 batch、FIFO cursor 与 transport counts。

  调用函数
  runSlot、Promise.all、cancel。

  边界与不变量
  admit 只在真正空闲 slot 派发时调用；完成顺序不改变返回顺序，ERROR 不返回部分前缀。
  */
  async runBatch({ batchId, count, startIndex = 0, admit, join = null }) {
    if (this.disposed || !this.workers.length) throw new Error("Compute pool unavailable");
    if (this.batch) throw new Error("Compute batch already active");
    const batch = { batchId, count, startIndex, admit, join, joined:0, joinChain:Promise.resolve(), cursor:startIndex, stopped:false, receipts:[], generation:this.generation };
    this.batch = batch;
    try {
      await Promise.all(this.workers.map(slot => this.runSlot(slot, batch)));
      return batch.receipts;
    } catch (error) {
      if (this.batch === batch) this.cancel(error);
      throw error;
    } finally {
      if (this.batch === batch) this.batch = null;
    }
  }

  /*
  功能
  让一个空闲 Worker 动态领取 FIFO 下一项。

  调用方
  runBatch。

  输入
  Worker slot 与当前 batch。

  输出
  队列耗尽或 admission 停止时完成。

  读取状态
  batch.cursor、generation 与 Searcher admission 回调。

  写入状态
  FIFO cursor、canonical receipt slot 与派发计数。

  调用函数
  batch.admit、send。

  边界与不变量
  在途 atomic candidate 不超过 poolSize；本函数不得判断 TIME/NODE。
  */
  async runSlot(slot, batch) {
    while (!batch.stopped && batch.cursor < batch.count && this.batch === batch) {
      const canonicalIndex = batch.cursor;
      const input = batch.admit(canonicalIndex);
      if (!input) { batch.stopped = true; break; }
      batch.cursor += 1;
      this.stats.dispatched += 1;
      const promise = this.send(slot, {
        type:"COMPUTE", generation:batch.generation, batchId:batch.batchId, canonicalIndex, input
      });
      this.stats.peakInFlight = Math.max(this.stats.peakInFlight, this.workers.filter(entry => entry.pending).length);
      batch.receipts[canonicalIndex - batch.startIndex] = await promise;
      batch.joinChain = batch.joinChain.then(() => this.joinReady(batch));
      await batch.joinChain;
    }
  }

  /*
  功能
  把已连续完成的 canonical receipt 前缀交回 Searcher。

  调用方
  runSlot 的串行 join chain。

  输入
  当前 batch。

  输出
  前缀处理结束的 Promise。

  读取状态
  receipts 与 joined index。

  写入状态
  joined cursor；Searcher 返回取消时停止 FIFO dispatch。

  调用函数
  batch.join。

  边界与不变量
  只运输完整前缀，不解释节点、END、预算或 comparator。
  */
  async joinReady(batch) {
    if (!batch.join || this.batch !== batch) return;
    while (batch.receipts[batch.joined]) {
      const index = batch.joined++;
      if (!(await batch.join(batch.receipts[index], index + batch.startIndex))) {
        batch.stopped = true;
        batch.join = null;
        return;
      }
    }
  }

  /*
  功能
  传播当前 Worker 的基础设施错误。

  调用方
  error/messageerror listener。

  输入
  来源 slot 和错误文本。

  输出
  无。

  读取状态
  当前存活 slot 集合。

  写入状态
  当前 generation 生命周期。

  调用函数
  cancel。

  边界与不变量
  已终止 Worker 的迟到错误不得取消新的搜索。
  */
  workerError(slot, message) {
    if (this.workers.includes(slot)) this.cancel(new Error(message));
  }

  /*
  功能
  拒绝全部 pending 并终止当前纯计算 generation。

  调用方
  CANCEL、dispose 与 Worker/transport error。

  输入
  明确取消或故障异常。

  输出
  无。

  读取状态
  当前 Worker 和 pending。

  写入状态
  generation、batch、workers 与所有 pending。

  调用函数
  Worker.terminate、pending.reject。

  边界与不变量
  不 retry，不输出 END/PASS；旧结果和旧 listener 不得影响下一 generation。
  */
  cancel(error = null) {
    if (!error) {
      error = new Error("Compute search cancelled");
      error.computeCancelled = true;
    }
    this.generation += 1;
    if (this.batch) this.batch.stopped = true;
    this.batch = null;
    const workers = this.workers;
    this.workers = [];
    for (const slot of workers) {
      const pending = slot.pending;
      slot.pending = null;
      slot.worker.terminate();
      pending?.reject(error);
    }
  }

  /*
  功能
  永久释放池及其 Worker/pending。

  调用方
  Coordinator dispose 与测试清理。

  输入
  无。

  输出
  无。

  读取状态
  当前池。

  写入状态
  disposed 与所有生命周期资源。

  调用函数
  cancel。

  边界与不变量
  重复 dispose 安全；释放后不得再派发。
  */
  dispose() {
    this.disposed = true;
    const error = new Error("Compute pool disposed");
    error.computeCancelled = true;
    this.cancel(error);
  }
}
