/*
模块职责
统一拥有一次搜索的时间、节点、停止原因与结构计数。

上游
Planner 与搜索预算回归测试。

下游
RUNTIME_POLICY 默认时间配置与注入时钟。

状态边界
只修改当前 SearchBudget 实例的计数和停止原因，不读取 SearchState。

信息边界
不读取动作、玩家、卡牌、技能或隐藏信息。

架构约束
TIME 是正常 wall-clock 截止的唯一权威；节点预算只统计已经完成候选物化的 SearchNode，node mode 不读取时间截止；不得把模拟调用折算成节点成本。
*/
import { AI_RUNTIME_POLICY } from "../policy/AiRuntimePolicy.js";

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
  RUNTIME_POLICY 默认时间预算和注入时钟。

  写入状态
  初始化开始时间、预算、计数与空 stopReason。

  调用函数
  now。

  边界与不变量
  只有大于等于一的有限节点预算生效；节点模式不以墙钟终止。
  */
  constructor({ timeBudget = null, nodeBudget = null, now = null } = {}) {
    this.probabilityDiagnosticDeadlineComparable = typeof now !== "function";
    this.now = typeof now === "function"
      ? now
      : () => globalThis.performance?.now?.() ?? Date.now();
    const configuredTime = timeBudget == null ? Number.NaN : Number(timeBudget);
    this.timeBudget = Number.isFinite(configuredTime)
      ? Math.max(0, configuredTime)
      : AI_RUNTIME_POLICY.searchTimeBudgetMs;
    const configuredNodes = Number(nodeBudget);
    this.nodeBudget = Number.isFinite(configuredNodes) && configuredNodes >= 1
      ? Math.floor(configuredNodes)
      : null;
    this.started = this.now();
    this.expandedNodes = 0;
    this.simulationCalls = 0;
    this.cloneCalls = 0;
    this.probabilityOperations = 0;
    this.cooperativeProbabilityOperations = 0;
    this.rawProbabilityOperations = 0;
    this.rawProbabilityOperationsAfterTime = 0;
    this.abortedCooperativeProbabilityOperations = 0;
    this.probabilityWorldBranches = 0;
    this.largestCooperativeProbabilityOperation = null;
    this.largestRawProbabilityOperation = null;
    this.lastProbabilityOperation = null;
    this.rawProbabilityDeadlineCrossings = [];
    this.responseBranches = 0;
    this.counterfactualCalls = 0;
    this.stateUtilityCalls = 0;
    this.actionGenerationPhysicalCandidates = 0;
    this.actionGenerationUniqueCandidates = 0;
    this.actionGenerationPreparedCandidates = 0;
    this.probabilityPreparations = 0;
    this.conditionBranches = 0;
    this.executionWorldBranches = 0;
    this.yieldCount = 0;
    this.stopReason = null;
    this.rootSafetyCompletion = null;
    this.rootSafetyCandidateActive = false;
    this.rootSafetyExpandedNodes = 0;
    this.rootSafetySimulationCalls = 0;
    this.lastObservedAt = this.started;
    this.deadlineCrossedAt = null;
    this.deadlineCrossedWork = null;
    this.activePreparation = null;
    this.preparations = [];
    this.currentWorkInterruption = new Error("AI search current work interrupted");
    this.lastFinishedPreparation = null;
    this.partialCandidateRegistered = 0;
    this.rootCandidatesStarted = 0;
    this.rootCandidatesStartedAfterTime = 0;
  }

  /*
  功能
  截取当前搜索工作计数，供单次候选 preparation 诊断计算增量。

  调用方
  beginPreparation、finishPreparation 与 deadline 首次观察点。

  输入
  无。

  输出
  simulation/response/probability/condition/execution work 的普通对象。

  读取状态
  当前 SearchBudget 结构计数。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  快照只描述已发生工作，不读取动作语义，也不参与预算或候选选择。
  */
  workSnapshot() {
    return {
      simulationCalls:this.simulationCalls,
      cloneCalls:this.cloneCalls,
      probabilityOperations:this.probabilityOperations,
      probabilityWorldBranches:this.probabilityWorldBranches,
      responseBranches:this.responseBranches,
      probabilityPreparations:this.probabilityPreparations,
      conditionBranches:this.conditionBranches,
      executionWorldBranches:this.executionWorldBranches
    };
  }

  /*
  功能
  计算两个工作快照之间的非负计数增量。

  调用方
  finishPreparation。

  输入
  较早与较晚的 SearchBudget work snapshot。

  输出
  各工作计数的非负差值。

  读取状态
  无。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  诊断计数只能递增；非法或缺失字段按零处理。
  */
  workDelta(before = {}, after = {}) {
    const delta = {};
    for (const key of [
      "simulationCalls",
      "cloneCalls",
      "probabilityOperations",
      "probabilityWorldBranches",
      "responseBranches",
      "probabilityPreparations",
      "conditionBranches",
      "executionWorldBranches"
    ]) {
      delta[key] = Math.max(0, (Number(after[key]) || 0) - (Number(before[key]) || 0));
    }
    return delta;
  }

  /*
  功能
  记录一个候选 preparation 开始时的预算时间与工作基线。

  调用方
  Planner 在 Simulator.apply 前。

  输入
  当前搜索深度。

  输出
  preparation 的一基索引。

  读取状态
  lastObservedAt、当前工作计数与已有 preparation 数。

  写入状态
  activePreparation。

  调用函数
  workSnapshot。

  边界与不变量
  同时只允许一个 Planner candidate preparation；不读取动作或 SearchState。
  */
  beginPreparation(depth) {
    if (this.activePreparation) {
      throw new Error("SearchBudget preparation 已经开始");
    }
    this.activePreparation = {
      index:this.preparations.length + 1,
      depth,
      startedAt:this.nodeBudget === null ? this.lastObservedAt : null,
      work:this.workSnapshot()
    };
    this.lastFinishedPreparation = null;
    return this.activePreparation.index;
  }

  /*
  功能
  完成当前候选 preparation 诊断，并在候选边界观察 TIME。

  调用方
  Planner 在完整候选登记或 partial work 丢弃前。

  输入
  preparation 是否完整完成。

  输出
  本次 preparation 的只读诊断记录；没有活动 preparation 时返回 null。

  读取状态
  activePreparation、预算时钟、deadline 与工作计数。

  写入状态
  lastObservedAt、TIME 首次观察、preparations 与 activePreparation。

  调用函数
  now、workSnapshot、workDelta。

  边界与不变量
  该时钟读取替代下一个候选前的同一预算检查；完整候选即使轻微越界仍可登记，partial work 永不登记。
  */
  finishPreparation(completed) {
    const active = this.activePreparation;
    if (!active) return null;
    const endedAt = this.nodeBudget === null ? this.now() : null;
    if (endedAt !== null) {
      this.lastObservedAt = endedAt;
      if (this.stopReason === null && endedAt - this.started >= this.timeBudget) {
        this.stopReason = SEARCH_STOP_REASON.TIME;
        this.deadlineCrossedAt = endedAt;
        this.deadlineCrossedWork = this.workSnapshot();
      }
    }
    const finishedWork = this.workSnapshot();
    const deadline = this.nodeBudget === null ? this.started + this.timeBudget : null;
    const record = Object.freeze({
      index:active.index,
      depth:active.depth,
      completed:Boolean(completed),
      startedAt:active.startedAt,
      endedAt,
      durationMs:endedAt === null || active.startedAt === null
        ? null
        : Math.max(0, endedAt - active.startedAt),
      deadlineCrossed:Boolean(
        deadline !== null
        && active.startedAt < deadline
        && endedAt >= deadline
      ),
      deadlineCrossedElapsedMs:this.deadlineCrossedAt === null
        ? null
        : Math.max(0, this.deadlineCrossedAt - this.started),
      deadlineOverrunMs:deadline === null || endedAt < deadline
        ? 0
        : Math.max(0, endedAt - deadline),
      work:this.workDelta(active.work, finishedWork),
      workAfterDeadlineObservation:this.deadlineCrossedWork
        ? this.workDelta(this.deadlineCrossedWork, finishedWork)
        : this.workDelta(finishedWork, finishedWork)
    });
    this.preparations.push(record);
    this.activePreparation = null;
    this.lastFinishedPreparation = record;
    return record;
  }

  /*
  功能
  在已证实的长同步循环内执行 TIME/NODE/CANCEL cooperative checkpoint。

  调用方
  Simulation 与概率世界联合的细粒度工作边界。

  输入
  无。

  输出
  未中断时返回 true；中断时抛出本 SearchBudget 独占的 unwind signal。

  读取状态
  当前预算、停止原因与根安全授权。

  写入状态
  首次过期时写入 TIME/NODE stopReason。

  调用函数
  shouldAbortCurrentWork。

  边界与不变量
  signal 只允许由拥有该 SearchBudget 的 Planner 捕获；不得把 partial action、world 或 state 登记为候选。
  */
  checkpointCurrentWork() {
    if (!this.shouldAbortCurrentWork()) return true;
    throw this.currentWorkInterruption;
  }

  /*
  功能
  判断异常是否为本次搜索的 cooperative unwind signal。

  调用方
  Planner candidate preparation boundary。

  输入
  捕获的任意异常。

  输出
  仅对象身份与当前 signal 相同时返回 true。

  读取状态
  currentWorkInterruption。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不按 message/code 吞掉真实错误；不同 SearchBudget 的 signal 不能互相匹配。
  */
  isCurrentWorkInterruption(error) {
    return error === this.currentWorkInterruption;
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
  节点模式不读取时钟；已开始的不可中断物化可以轻微越过时间预算，并在下一检查点以 TIME 保留完整 best-seen。
  */
  shouldStop() {
    if (this.stopReason !== null) return true;
    if (this.nodeBudget !== null) {
      if (this.expandedNodes < this.nodeBudget) return false;
      this.stopReason = SEARCH_STOP_REASON.NODE;
      return true;
    }
    this.lastObservedAt = this.now();
    if (this.lastObservedAt - this.started < this.timeBudget) return false;
    this.stopReason = SEARCH_STOP_REASON.TIME;
    this.deadlineCrossedAt = this.lastObservedAt;
    this.deadlineCrossedWork = this.workSnapshot();
    return true;
  }

  /*
  功能
  在一次候选内部的可中断工作边界判断是否应立即回退。

  调用方
  CounterfactualTerms 的隐藏世界、后续动作与配对模拟循环。

  输入
  无。

  输出
  时间/取消已停止时返回 true；NODE 根安全候选仍在正式授权内时返回 false。

  读取状态
  stopReason 与 rootSafetyCandidateActive。

  写入状态
  尚未停止时可通过 shouldStop 首次写入 TIME/NODE。

  调用函数
  shouldStop。

  边界与不变量
  TIME 一经观察必须穿透当前昂贵循环；NODE 的显式 depth-1 根安全授权保持既有结构语义。
  */
  shouldAbortCurrentWork() {
    if (this.rootSafetyCandidateActive && this.stopReason === SEARCH_STOP_REASON.NODE) {
      return false;
    }
    return this.shouldStop();
  }

  /*
  功能
  在主搜索已因 NODE 停止后，申请一次有界的根安全补评估。

  调用方
  Planner 根候选首轮收束。

  输入
  评估深度与当前尚未完成的根候选数。

  输出
  SearchBudget 允许该阶段返回 true，否则返回 false。

  读取状态
  stopReason 与已有 rootSafetyCompletion。

  写入状态
  最多写入一次 depth=1 的候选数上限。

  调用函数
  无。

  边界与不变量
  只有已观察到的 NODE 可授权；只授权一次 depth=1，上限冻结为申请时的剩余根数。
  TIME 只允许返回 deadline 前已经完整物化的 incumbent，绝不授权新的 root simulation。
  SearchBudget 不读取根动作内容，也不授权深层、beam 或隐藏采样。
  */
  requestRootSafetyCompletion({ depth, candidateCount } = {}) {
    const requestedCount = Number(candidateCount);
    if (this.stopReason !== SEARCH_STOP_REASON.NODE || depth !== 1 || this.rootSafetyCompletion
      || !Number.isFinite(requestedCount) || requestedCount < 1) return false;
    this.rootSafetyCompletion = {
      depth:1,
      candidateLimit:Math.floor(requestedCount),
      startedCandidates:0,
      completedCandidates:0
    };
    return true;
  }

  /*
  功能
  从已授权的根安全阶段领取一个 depth-1 候选物化名额。

  调用方
  Planner 在每个剩余根动作的 apply 之前。

  输入
  当前候选深度。

  输出
  尚有 depth-1 名额时返回 true，否则返回 false。

  读取状态
  rootSafetyCompletion 授权与当前活动候选。

  写入状态
  startedCandidates 加一并标记当前候选正在物化。

  调用函数
  无。

  边界与不变量
  同时只能有一个候选占用名额；深度不等于一或已达冻结上限时拒绝。
  */
  beginRootSafetyCandidate(depth) {
    const completion = this.rootSafetyCompletion;
    if (!completion || this.rootSafetyCandidateActive || depth !== completion.depth
      || completion.startedCandidates >= completion.candidateLimit) return false;
    completion.startedCandidates += 1;
    this.rootSafetyCandidateActive = true;
    return true;
  }

  /*
  功能
  释放未完成的根安全候选名额，避免异常或中断后残留活动状态。

  调用方
  Planner 的候选物化中断路径。

  输入
  无。

  输出
  先前存在活动候选时返回 true，否则返回 false。

  读取状态
  rootSafetyCandidateActive。

  写入状态
  只把 rootSafetyCandidateActive 复位为 false。

  调用函数
  无。

  边界与不变量
  不把未完整物化的候选计为 completed/expanded，也不返还已经领取的名额。
  */
  abortRootSafetyCandidate() {
    if (!this.rootSafetyCandidateActive) return false;
    this.rootSafetyCandidateActive = false;
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
    if (this.lastFinishedPreparation && !this.lastFinishedPreparation.completed) {
      this.partialCandidateRegistered += 1;
    }
    this.lastFinishedPreparation = null;
    this.expandedNodes += 1;
    if (this.rootSafetyCandidateActive) {
      this.rootSafetyExpandedNodes += 1;
      this.rootSafetyCompletion.completedCandidates += 1;
      this.rootSafetyCandidateActive = false;
    }
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
    const observed = Math.max(0, Number(count) || 0);
    this.simulationCalls += observed;
    if (this.rootSafetyCandidateActive) this.rootSafetySimulationCalls += observed;
    return this.simulationCalls;
  }

  /*
  功能
  记录一次完整 SearchState 克隆实际开始执行。

  调用方
  Simulator 构造与 clone 的 SearchBudget checkpoint 之后。

  输入
  可选克隆次数。

  输出
  更新后的 cloneCalls。

  读取状态
  当前 cloneCalls。

  写入状态
  累加有限非负克隆次数。

  调用函数
  无。

  边界与不变量
  只能在 clone 前预算检查通过后记录；诊断不改变停止、状态或候选选择。
  */
  observeClone(count = 1) {
    this.cloneCalls += Math.max(0, Number(count) || 0);
    return this.cloneCalls;
  }

  /*
  功能
  记录一次已完整返回的 cooperative probability join/project/merge 及其输出世界数。

  调用方
  ActionGenerator 与 Simulator 的高分支概率工作边界。

  输入
  本次完整输出的世界数量，以及可选 cooperative/raw timing 诊断记录。

  输出
  更新后的 probabilityOperations。

  读取状态
  当前 probability work 计数。

  写入状态
  probabilityOperations 与 cooperative/raw 对应计数加一，累加非负输出世界数并保留最大操作。

  调用函数
  无。

  边界与不变量
  cooperative abort 的 partial 结果不得进入完整计数；计数不改变概率代数、预算或搜索排序。
  */
  observeProbabilityWork(worldCount = 0, details = null) {
    this.probabilityOperations += 1;
    this.probabilityWorldBranches += Math.max(0, Number(worldCount) || 0);
    const mode = details?.mode === "raw" ? "raw" : "cooperative";
    if (mode === "raw") this.rawProbabilityOperations += 1;
    else this.cooperativeProbabilityOperations += 1;
    if (details) this.recordProbabilityOperation(details);
    return this.probabilityOperations;
  }

  /*
  功能
  建立一次概率操作的纯数字诊断起点，不推进 SearchBudget 的预算时钟。

  调用方
  Simulator 的 cooperative 与严格有界 raw probability wrapper。

  输入
  operation 名称、输入世界数与 cooperative/raw 模式。

  输出
  供 finishProbabilityOperation 使用的普通诊断 token。

  读取状态
  当前 deadline、lastObservedAt 与 stopReason。

  写入状态
  raw 操作在已观察 TIME 后仍被启动时累加违规计数。

  调用函数
  performance.now 或 Date.now。

  边界与不变量
  诊断时钟不得调用注入的预算 now，避免改变确定性测试或 TIME 观察次数；不记录 state/world 内容。
  */
  beginProbabilityOperation(operation, inputWorldCount = 0, mode = "cooperative") {
    const normalizedMode = mode === "raw" ? "raw" : "cooperative";
    if (normalizedMode === "raw" && this.stopReason === SEARCH_STOP_REASON.TIME) {
      this.rawProbabilityOperationsAfterTime += 1;
    }
    const startMs = globalThis.performance?.now?.() ?? Date.now();
    return Object.freeze({
      operation:String(operation || "probability"),
      mode:normalizedMode,
      startMs,
      deadlineRemainingMs:this.nodeBudget === null
        && this.probabilityDiagnosticDeadlineComparable
        ? Math.max(0, this.started + this.timeBudget - this.lastObservedAt)
        : null,
      inputWorldCount:Math.max(0, Number(inputWorldCount) || 0),
      startedAfterTime:this.stopReason === SEARCH_STOP_REASON.TIME
    });
  }

  /*
  功能
  完成一次概率操作诊断，并只为完整结果登记正式 probability work。

  调用方
  Simulator probability wrapper 的正常返回与 cooperative interruption 路径。

  输入
  begin token、输出世界数与本次操作是否完整完成。

  输出
  只含 operation/timing/count 的冻结诊断记录。

  读取状态
  当前预算模式与 token。

  写入状态
  完整操作计数、最大操作记录、raw deadline crossing 或 cooperative abort 计数。

  调用函数
  observeProbabilityWork、recordProbabilityOperation、performance.now 或 Date.now。

  边界与不变量
  partial cooperative 结果不得增加 probabilityOperations/worldBranches；诊断不参与取消、概率或搜索排序。
  */
  finishProbabilityOperation(token, outputWorldCount = 0, completed = true) {
    if (!token) return null;
    const endMs = globalThis.performance?.now?.() ?? Date.now();
    const durationMs = Math.max(0, endMs - token.startMs);
    const record = Object.freeze({
      operation:token.operation,
      mode:token.mode,
      startMs:token.startMs,
      endMs,
      deadlineRemainingMs:token.deadlineRemainingMs,
      durationMs,
      crossedDeadline:Boolean(
        token.deadlineRemainingMs !== null
        && token.deadlineRemainingMs > 0
        && durationMs >= token.deadlineRemainingMs
      ),
      inputWorldCount:token.inputWorldCount,
      outputWorldCount:Math.max(0, Number(outputWorldCount) || 0),
      completed:Boolean(completed)
    });
    if (completed) this.observeProbabilityWork(record.outputWorldCount, record);
    else {
      this.abortedCooperativeProbabilityOperations += token.mode === "cooperative" ? 1 : 0;
      this.recordProbabilityOperation(record);
    }
    return record;
  }

  /*
  功能
  保留 cooperative/raw 各自耗时最大的数字诊断，并单列 raw deadline crossing。

  调用方
  observeProbabilityWork 与 finishProbabilityOperation 的中断路径。

  输入
  完整概率操作诊断记录。

  输出
  无返回值。

  读取状态
  当前最大操作与 raw crossing 列表。

  写入状态
  最大操作引用与 rawProbabilityDeadlineCrossings。

  调用函数
  无。

  边界与不变量
  只保留数字和 operation 名称，不保留 state/world；同耗时保持先出现的记录。
  */
  recordProbabilityOperation(record) {
    this.lastProbabilityOperation = record;
    const property = record.mode === "raw"
      ? "largestRawProbabilityOperation"
      : "largestCooperativeProbabilityOperation";
    if (!this[property] || record.durationMs > this[property].durationMs) {
      this[property] = record;
    }
    if (record.mode === "raw" && record.crossedDeadline) {
      this.rawProbabilityDeadlineCrossings.push(record);
    }
  }

  /*
  功能
  记录 Planner 实际开始物化一个新的根候选。

  调用方
  Planner 在每个 root candidate preparation 之前。

  输入
  无。

  输出
  更新后的 rootCandidatesStarted。

  读取状态
  当前 stopReason。

  写入状态
  根启动总数；若 TIME 已被观察则同时记录违规诊断。

  调用函数
  无。

  边界与不变量
  本方法只观察 Planner 已决定开始的 root；不得自行授权 root 或改变 stopReason。
  */
  observeRootCandidateStarted() {
    this.rootCandidatesStarted += 1;
    if (this.stopReason === SEARCH_STOP_REASON.TIME) {
      this.rootCandidatesStartedAfterTime += 1;
    }
    return this.rootCandidatesStarted;
  }

  /*
  功能
  记录响应模拟实际产出的条件分支数量。

  调用方
  ResponseSimulation 的 card-scope、block 与 target-scope 响应边界。

  输入
  本次产生的非负分支数。

  输出
  更新后的 responseBranches。

  读取状态
  当前 responseBranches。

  写入状态
  累加有限非负分支数。

  调用函数
  无。

  边界与不变量
  仅作 work diagnostics，不改变概率、响应决策、预算或搜索排序。
  */
  observeResponseBranches(count = 0) {
    this.responseBranches += Math.max(0, Number(count) || 0);
    return this.responseBranches;
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
  记录深层动作生成在等价去重前后的候选数与实际概率准备工作量。

  调用方
  ActionGenerator.generateFromVisible。

  输入
  单个完整 preparation 或一次生成汇总的 physical/unique/prepared candidate 数，
  以及实际 condition/execution branch 数。

  输出
  累计完成的 probability preparation 次数。

  读取状态
  当前动作生成诊断计数。

  写入状态
  累加动作生成候选、概率准备与条件世界计数。

  调用函数
  无。

  边界与不变量
  单个 preparation 完成后立即记录其 world work，保证 deadline 快照不把此前完成工作误记到 TIME 之后；
  只记录已经发生的工作，不参与 TIME/NODE、候选合法性、概率或排序；
  prepared 少于 unique 可能来自概率为零的合法过滤，不得解释为预算中止。
  */
  observeActionGeneration({
    physicalCandidates = 0,
    uniqueCandidates = 0,
    preparedCandidates = 0,
    probabilityPreparations = 0,
    conditionBranches = 0,
    executionWorldBranches = 0
  } = {}) {
    const physical = Math.max(0, Number(physicalCandidates) || 0);
    const unique = Math.max(0, Number(uniqueCandidates) || 0);
    const prepared = Math.max(0, Number(preparedCandidates) || 0);
    this.actionGenerationPhysicalCandidates += physical;
    this.actionGenerationUniqueCandidates += unique;
    this.actionGenerationPreparedCandidates += prepared;
    this.probabilityPreparations += Math.max(0, Number(probabilityPreparations) || 0);
    this.conditionBranches += Math.max(0, Number(conditionBranches) || 0);
    this.executionWorldBranches += Math.max(0, Number(executionWorldBranches) || 0);
    return this.probabilityPreparations;
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
    if (this.nodeBudget === null) this.lastObservedAt = this.now();
    const finishedWork = this.workSnapshot();
    return {
      started:this.started,
      deadline:this.nodeBudget === null ? this.started + this.timeBudget : null,
      elapsedMs:this.lastObservedAt - this.started,
      deadlineCrossedAt:this.deadlineCrossedAt,
      deadlineOverrunMs:this.nodeBudget === null
        ? Math.max(0, this.lastObservedAt - (this.started + this.timeBudget))
        : 0,
      timeBudget:this.timeBudget,
      nodeBudget:this.nodeBudget,
      expandedNodes:this.expandedNodes,
      simulationCalls:this.simulationCalls,
      cloneCalls:this.cloneCalls,
      probabilityOperations:this.probabilityOperations,
      cooperativeProbabilityOperations:this.cooperativeProbabilityOperations,
      rawProbabilityOperations:this.rawProbabilityOperations,
      rawProbabilityOperationsAfterTime:this.rawProbabilityOperationsAfterTime,
      abortedCooperativeProbabilityOperations:this.abortedCooperativeProbabilityOperations,
      probabilityWorldBranches:this.probabilityWorldBranches,
      largestCooperativeProbabilityOperation:this.largestCooperativeProbabilityOperation,
      largestRawProbabilityOperation:this.largestRawProbabilityOperation,
      lastProbabilityOperation:this.lastProbabilityOperation,
      rawProbabilityDeadlineCrossings:[...this.rawProbabilityDeadlineCrossings],
      responseBranches:this.responseBranches,
      counterfactualCalls:this.counterfactualCalls,
      stateUtilityCalls:this.stateUtilityCalls,
      actionGenerationPhysicalCandidates:this.actionGenerationPhysicalCandidates,
      actionGenerationUniqueCandidates:this.actionGenerationUniqueCandidates,
      actionGenerationPreparedCandidates:this.actionGenerationPreparedCandidates,
      probabilityPreparations:this.probabilityPreparations,
      conditionBranches:this.conditionBranches,
      executionWorldBranches:this.executionWorldBranches,
      yieldCount:this.yieldCount,
      rootSafetyExpandedNodes:this.rootSafetyExpandedNodes,
      rootSafetySimulationCalls:this.rootSafetySimulationCalls,
      preparations:[...this.preparations],
      workAfterDeadline:this.deadlineCrossedWork
        ? this.workDelta(this.deadlineCrossedWork, finishedWork)
        : this.workDelta(finishedWork, finishedWork),
      partialCandidateRegistered:this.partialCandidateRegistered,
      rootCandidatesStarted:this.rootCandidatesStarted,
      rootCandidatesStartedAfterTime:this.rootCandidatesStartedAfterTime,
      stopReason:this.stopReason
    };
  }
}
