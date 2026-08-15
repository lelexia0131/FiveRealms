/*
模块职责
统一拥有一次搜索的时间、节点、停止原因与结构计数。

上游
Planner 与搜索预算回归测试。

下游
GAME_CONFIG 默认时间配置与注入时钟。

状态边界
只修改当前 SearchBudget 实例的计数和停止原因，不读取 SearchState。

信息边界
不读取动作、玩家、卡牌、技能或隐藏信息。

架构约束
节点预算只统计已经完成候选物化的 SearchNode；不得把模拟调用折算成节点成本。
*/
import { GAME_CONFIG } from "../../config/gameConfig.js?build=20260815-ai-residue-cleanup-final";

// COMPLETE 表示自然完成；TIME/NODE 分别表示时间或完整节点预算耗尽；
// CANCELLED 表示会话让步检测到取消。停止原因只决定收束方式，不修改候选价值。
export const SEARCH_STOP_REASON = Object.freeze({
  COMPLETE:"COMPLETE",
  TIME:"TIME",
  NODE:"NODE",
  CANCELLED:"CANCELLED"
});

export class SearchBudget {
  /*
  功能
  创建一次搜索独占的预算状态与结构计数器。

  调用方
  AIController 注入 Planner 的 searchBudgetFactory 与直接预算测试。

  输入
  可选时间预算、节点预算和单调时钟能力。

  输出
  尚未停止的 SearchBudget 实例。

  读取状态
  GAME_CONFIG 默认时间预算和注入时钟。

  写入状态
  初始化开始时间、预算、计数与空 stopReason。

  调用函数
  now。

  边界与不变量
  只有大于等于一的有限节点预算生效；节点模式不以墙钟终止。
  */
  constructor({ timeBudget = null, nodeBudget = null, now = null } = {}) {
    this.now = typeof now === "function"
      ? now
      : () => globalThis.performance?.now?.() ?? Date.now();
    const configuredTime = timeBudget == null ? Number.NaN : Number(timeBudget);
    this.timeBudget = Number.isFinite(configuredTime)
      ? Math.max(0, configuredTime)
      : GAME_CONFIG.aiSearchTimeBudgetMs;
    const configuredNodes = Number(nodeBudget);
    this.nodeBudget = Number.isFinite(configuredNodes) && configuredNodes >= 1
      ? Math.floor(configuredNodes)
      : null;
    this.started = this.now();
    this.expandedNodes = 0;
    this.simulationCalls = 0;
    this.counterfactualCalls = 0;
    this.stateUtilityCalls = 0;
    this.yieldCount = 0;
    this.stopReason = null;
  }

  /*
  功能
  在继续展开前判断是否触发当前搜索预算。

  调用方
  Planner 根动作、节点、深度循环的继续边界。

  输入
  无。

  输出
  已停止返回 true，否则返回 false。

  读取状态
  nodeBudget、expandedNodes、timeBudget、started 与当前时钟。

  写入状态
  首次触发时写入 NODE 或 TIME stopReason。

  调用函数
  now。

  边界与不变量
  节点模式不读取时钟；已完成的一个不可中断物化可以轻微越过时间预算。
  */
  shouldStop() {
    if (this.stopReason !== null) return true;
    if (this.nodeBudget !== null) {
      if (this.expandedNodes < this.nodeBudget) return false;
      this.stopReason = SEARCH_STOP_REASON.NODE;
      return true;
    }
    if (this.now() - this.started < this.timeBudget) return false;
    this.stopReason = SEARCH_STOP_REASON.TIME;
    return true;
  }

  /*
  功能
  记录一个候选已完成全部物化并可登记为 SearchNode。

  调用方
  Planner 在 CandidateMaterializer 返回后。

  输入
  无。

  输出
  更新后的 expandedNodes。

  读取状态
  当前 expandedNodes。

  写入状态
  expandedNodes 加一。

  调用函数
  无。

  边界与不变量
  不完整 apply、base transition 或尚未返回的反事实不得计为节点。
  */
  observeNode() {
    this.expandedNodes += 1;
    return this.expandedNodes;
  }

  /*
  功能
  记录一次 Simulator apply 调用。

  调用方
  Planner 主物化与 CounterfactualTerms 配对模拟。

  输入
  可选调用次数。

  输出
  更新后的 simulationCalls。

  读取状态
  当前 simulationCalls。

  写入状态
  增加非负有限调用次数。

  调用函数
  无。

  边界与不变量
  该计数只作诊断，不参与 node budget 或候选评分。
  */
  observeSimulation(count = 1) {
    this.simulationCalls += Math.max(0, Number(count) || 0);
    return this.simulationCalls;
  }

  /*
  功能
  记录一次完整配对反事实查询及其 stateUtility 调用。

  调用方
  CounterfactualTerms。

  输入
  本次反事实内的 stateUtility 调用数。

  输出
  更新后的 counterfactualCalls。

  读取状态
  当前反事实与 stateUtility 计数。

  写入状态
  counterfactualCalls 加一并累加 stateUtilityCalls。

  调用函数
  无。

  边界与不变量
  只观察既有 paired-world 查询，不改变调用次数或 value 公式。
  */
  observeCounterfactual(stateUtilityCalls = 0) {
    this.counterfactualCalls += 1;
    this.stateUtilityCalls += Math.max(0, Number(stateUtilityCalls) || 0);
    return this.counterfactualCalls;
  }

  /*
  功能
  记录 Planner 为保持界面响应而执行的一次让步。

  调用方
  Planner yield 边界。

  输入
  无。

  输出
  更新后的 yieldCount。

  读取状态
  当前 yieldCount。

  写入状态
  yieldCount 加一。

  调用函数
  无。

  边界与不变量
  计数不影响让步频率或取消判断。
  */
  observeYield() {
    this.yieldCount += 1;
    return this.yieldCount;
  }

  /*
  功能
  在搜索自然穷尽当前深度/前沿后标记正常完成。

  调用方
  Planner 收束阶段。

  输入
  无。

  输出
  最终 stopReason。

  读取状态
  当前 stopReason。

  写入状态
  尚未停止时写入 COMPLETE。

  调用函数
  无。

  边界与不变量
  已经记录的 TIME、NODE 或 CANCELLED 不得被 COMPLETE 覆盖。
  */
  complete() {
    if (this.stopReason === null) this.stopReason = SEARCH_STOP_REASON.COMPLETE;
    return this.stopReason;
  }

  /*
  功能
  标记会话让步检测到的搜索取消。

  调用方
  Planner yieldControl 返回 false 的路径。

  输入
  无。

  输出
  CANCELLED。

  读取状态
  无。

  写入状态
  stopReason 写为 CANCELLED。

  调用函数
  无。

  边界与不变量
  取消优先于此前尚未观察到的预算状态，且不再选择未完整物化的搜索前沿。
  */
  cancel() {
    this.stopReason = SEARCH_STOP_REASON.CANCELLED;
    return this.stopReason;
  }

  /*
  功能
  返回一次搜索预算与结构计数的只读诊断快照。

  调用方
  Planner.lastSearchStats 组装与预算测试。

  输入
  无。

  输出
  包含 stopReason、预算、耗时和结构计数的普通对象。

  读取状态
  当前实例全部预算字段和时钟。

  写入状态
  无。

  调用函数
  now。

  边界与不变量
  expandedNodes 不是 CPU work units；各计数不参与搜索决策。
  */
  diagnostics() {
    return {
      elapsedMs:this.now() - this.started,
      timeBudget:this.timeBudget,
      nodeBudget:this.nodeBudget,
      expandedNodes:this.expandedNodes,
      simulationCalls:this.simulationCalls,
      counterfactualCalls:this.counterfactualCalls,
      stateUtilityCalls:this.stateUtilityCalls,
      yieldCount:this.yieldCount,
      stopReason:this.stopReason
    };
  }
}
