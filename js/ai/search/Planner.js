/*
模块职责
在 SearchState 上编排 beam search（束搜索：每层只保留固定数量候选）并返回最佳根动作与稳定计划序列。

上游
AIController 组合根与搜索回归测试。

下游
注入的 PatternMatcher、Simulator/SearchBudget 工厂、CandidateMaterializer、SearchPolicy 与动作生成/让步能力。

状态边界
只读输入 SearchState，所有分支写入由 simulatorFactory 创建的独立 Simulator 承担。

信息边界
Planner 不读取 GameState 或领域隐藏事实；合法候选与全部数值项来自显式注入的能力和唯一归属者。

架构约束
只理解根动作、搜索节点、深度、束、搜索前沿、预算、停止原因、分数、终止状态与 best-seen candidate（搜索过程中已经完整计算出的最佳候选）。
*/

export class Planner {
  /*
  功能
  创建只依赖正式搜索归属模块与窄运行能力的 Planner。

  调用方
  AIController 的组合根（统一组装依赖的位置）与正式边界。

  输入
  CandidateMaterializer、PatternMatcher、SearchPolicy、Simulator/SearchBudget factory、候选去重、
  深层生成与可取消让步能力。

  输出
  可执行 plan 的 Planner。

  读取状态
  无。

  写入状态
  实例依赖、最近搜索统计与计划序列。

  调用函数
  无。

  边界与不变量
  不接收 Game、Controller、领域归属模块或具体 Simulator 类。
  */
  constructor({
    candidateMaterializer,
    patternMatcher,
    searchPolicy,
    simulatorFactory,
    searchBudgetFactory,
    deduplicateActions,
    generateFromVisible,
    yieldControl
  } = {}) {
    const services = { candidateMaterializer, patternMatcher, searchPolicy };
    const capabilities = {
      simulatorFactory,
      searchBudgetFactory,
      deduplicateActions,
      generateFromVisible,
      yieldControl
    };
    for (const [name, service] of Object.entries(services)) {
      if (!service) throw new TypeError(`Planner 缺少依赖：${name}`);
    }
    for (const [name, capability] of Object.entries(capabilities)) {
      if (typeof capability !== "function") {
        throw new TypeError(`Planner 缺少依赖：${name}`);
      }
    }
    Object.assign(this, services);
    Object.assign(this, capabilities);
    this.lastSearchStats = null;
    this.lastPlannedSequence = [];
  }

  /*
  功能
  在单一原子边界内执行候选 apply/materialize，并统一丢弃 cooperative interruption 的 partial work。

  调用方
  plan 的根、根安全与深层候选循环。

  输入
  当前 SearchBudget、搜索深度与返回 { state, candidate } 的同步 preparation。

  输出
  完整 preparation 结果；预算 signal 中断时返回 null；其他错误原样抛出。

  读取状态
  SearchBudget 当前停止原因与 preparation 诊断。

  写入状态
  仅更新 SearchBudget preparation 诊断；候选状态由注入 preparation 创建。

  调用函数
  SearchBudget.beginPreparation/finishPreparation/isCurrentWorkInterruption、prepare。

  边界与不变量
  只有完整 candidate 才标记 completed；任何 partial SearchState/world 都随异常栈回退且不得进入 best-seen。
  */
  prepareCandidate(budget, depth, prepare) {
    budget.beginPreparation(depth);
    try {
      const prepared = prepare();
      budget.finishPreparation(Boolean(prepared?.candidate));
      return prepared;
    } catch (error) {
      budget.finishPreparation(false);
      if (budget.isCurrentWorkInterruption?.(error)) return null;
      throw error;
    }
  }

  /*
  功能
  把完整物化的子候选连接到父搜索节点。

  调用方
  plan 的 progressive depth-2 缓存、spine 与常规深层展开。

  输入
  父节点、完整子候选与当前深度。

  输出
  继承根动作、累计价值、序列、provenance 与纯调度 Pattern metadata 的完整搜索节点。

  读取状态
  SearchPolicy 的 pruneScore 公式、父/子候选字段与父节点 Pattern prefix。

  写入状态
  无。

  调用函数
  SearchPolicy.pruneScore、advancePatternState。

  边界与不变量
  只连接已经完整物化并完成 sibling terms 的候选；Pattern metadata 不得登记 partial state 或改变 final value。
  */
  buildChildNode(node, candidate, depth) {
    const valueScore = node.valueScore + candidate.transitionValue;
    const patternState = this.advancePatternState(
      node.activePatternProposals,
      candidate.action,
      depth - 1,
      node.completedPatternIds
    );
    return {
      action:node.action,
      state:candidate.state,
      terminal:candidate.terminal,
      valueScore,
      pruneScore:this.searchPolicy.pruneScore(valueScore, candidate.prior, depth),
      searchCredit:candidate.searchCredit,
      sequence:[...node.sequence, candidate.action],
      remainingProvenance:candidate.remainingProvenance,
      remainingHistory:[
        ...node.remainingHistory,
        candidate.remainingProvenance
      ],
      frontierResidual:candidate.frontierResidual,
      completedAtWorkCount:candidate.completedAtWorkCount,
      ...patternState
    };
  }

  /*
  功能
  按 Pattern proposal 的语义前缀推进搜索节点上的纯调度 metadata。

  调用方
  root node 构造与 buildChildNode。

  输入
  尚在匹配的 proposals、当前动作、零基 step 索引与此前已完成的 Pattern IDs。

  输出
  仍可继续的 proposals、本步新完成 proposals 和继承后的完成 Pattern IDs。

  读取状态
  CandidateMaterializer 的 ActionDescriptor semantic key。

  写入状态
  无。

  调用函数
  CandidateMaterializer.childSchedulingKey。

  边界与不变量
  metadata 不进入 value/prune score；只有当前完整节点动作匹配完整 proposal step 时才可完成 Pattern。
  */
  advancePatternState(proposals, action, stepIndex, completedPatternIds = []) {
    const actionKey = this.candidateMaterializer.childSchedulingKey(action);
    const matched = (proposals ?? []).filter(
      (proposal) => proposal.stepKeys[stepIndex] === actionKey
    );
    const newlyCompletedPatternProposals = matched.filter(
      (proposal) => proposal.stepKeys.length === stepIndex + 1
    );
    return {
      activePatternProposals:matched.filter(
        (proposal) => proposal.stepKeys.length > stepIndex + 1
      ),
      newlyCompletedPatternProposals,
      completedPatternIds:[...new Set([
        ...completedPatternIds,
        ...newlyCompletedPatternProposals.map((proposal) => proposal.patternId)
      ])]
    };
  }

  /*
  功能
  把 Pattern-guided roots 与既有 SearchPrior root 顺序进行公平交错。

  调用方
  plan 的 root scheduling 阶段。

  输入
  已去重合法 roots、行动者、根 SearchState 与有界 proposals。

  输出
  最多提升一个最高优先级 guided root，其余 roots 保持现有 SearchPrior 顺序。

  读取状态
  CandidateMaterializer root scheduling score/key。

  写入状态
  无。

  调用函数
  CandidateMaterializer.rootSchedulingScore/rootSchedulingKey/schedulingSecondaryKey。

  边界与不变量
  空 proposal 必须严格保留既有顺序；Pattern 只有一个正向提升位，其他 proposals 不得挤占 ordinary coverage。
  */
  scheduleRootActions(actions, player, state, proposals = []) {
    const scheduled = (actions ?? []).map((action) => ({
      action,
      score:this.candidateMaterializer.rootSchedulingScore(action, player, state),
      key:this.candidateMaterializer.rootSchedulingKey(action),
      secondaryKey:this.candidateMaterializer.schedulingSecondaryKey?.(action)
        ?? this.candidateMaterializer.rootSchedulingKey(action)
    })).sort((left, right) => {
      if (left.score !== right.score) return left.score > right.score ? -1 : 1;
      const intentOrder = left.key.localeCompare(right.key);
      if (intentOrder !== 0) return intentOrder;
      return left.secondaryKey.localeCompare(right.secondaryKey);
    });
    if (!proposals.length) return scheduled.map((entry) => entry.action);
    let promotedEntry = null;
    for (const proposal of proposals) {
      const key = proposal.stepKeys[0];
      promotedEntry = scheduled.find((entry) => entry.key === key) ?? null;
      if (promotedEntry) break;
    }
    if (!promotedEntry) return scheduled.map((entry) => entry.action);
    return [
      promotedEntry.action,
      ...scheduled.filter((entry) => entry !== promotedEntry).map((entry) => entry.action)
    ];
  }

  /*
  功能
  在昂贵深层物化前按现有 SearchPrior 与 semantic key 稳定排列 legal children。

  调用方
  materializeChildCandidates。

  输入
  当前合法动作、行动者、生成这些动作的 post-state 与按 proposal 顺序排列的 guided semantic keys。

  输出
  guided intent 优先、其余动作按现有 SearchPrior/coarse intent/search-semantic secondary key 排列的新数组。

  读取状态
  CandidateMaterializer 提供的 child scheduling score/key。

  写入状态
  无。

  调用函数
  CandidateMaterializer.childSchedulingScore/childSchedulingKey/schedulingSecondaryKey。

  边界与不变量
  只改变探索顺序，不改变合法集合、Final Utility 或 incumbent 规则；
  guided 与普通同分都不得读取 hand index 或 card instance ID；同 intent 的执行分支必须稳定排序。
  */
  scheduleChildActions(actions, player, state, guidedStepKeys = []) {
    const guidedRanks = new Map();
    for (const [index, key] of guidedStepKeys.entries()) {
      if (!guidedRanks.has(key)) guidedRanks.set(key, index);
    }
    return (actions ?? []).map((action) => ({
      action,
      score:this.candidateMaterializer.childSchedulingScore(action, player, state),
      key:this.candidateMaterializer.childSchedulingKey(action),
      secondaryKey:this.candidateMaterializer.schedulingSecondaryKey?.(action)
        ?? this.candidateMaterializer.childSchedulingKey(action)
    })).sort((left, right) => {
      const leftRank = guidedRanks.get(left.key) ?? Number.POSITIVE_INFINITY;
      const rightRank = guidedRanks.get(right.key) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
      if (left.score !== right.score) return left.score > right.score ? -1 : 1;
      const intentOrder = left.key.localeCompare(right.key);
      if (intentOrder !== 0) return intentOrder;
      return left.secondaryKey.localeCompare(right.secondaryKey);
    }).map((entry) => entry.action);
  }

  /*
  功能
  只为首次完整形成的 Pattern proposal 登记完成诊断。

  调用方
  plan 在完整 root/child node 建立后。

  输入
  完整搜索节点与本次搜索工作诊断。

  输出
  无。

  读取状态
  节点的 newlyCompletedPatternProposals。

  写入状态
  completedPatternProposalKeys 与 completedPatternCount。

  调用函数
  Set.has/add。

  边界与不变量
  partial candidate 不会形成节点，因此不得登记；同一 proposal 经 cache 复用时只计一次。
  */
  observeCompletedPatterns(node, workDiagnostics) {
    for (const proposal of node.newlyCompletedPatternProposals ?? []) {
      if (workDiagnostics.completedPatternProposalKeys.has(proposal.semanticKey)) continue;
      workDiagnostics.completedPatternProposalKeys.add(proposal.semanticKey);
      workDiagnostics.completedPatternCount += 1;
    }
  }

  /*
  功能
  用唯一 SearchPolicy incumbent 规则比较一个完整节点并同步工作诊断。

  调用方
  plan 的 root、progressive 与 beam 完整节点登记点。

  输入
  当前 incumbent、完整节点和本次搜索工作诊断。

  输出
  SearchPolicy 选择后的唯一 incumbent。

  读取状态
  节点 valueScore、完成工作计数与 Pattern 完成 metadata。

  写入状态
  incumbent 及 Pattern incumbent 更新计数。

  调用函数
  SearchPolicy.bestByValue。

  边界与不变量
  Pattern metadata 不参与比较；只有完整 Pattern node 按既有 valueScore 真正推翻 incumbent 时才记录更新。
  */
  considerIncumbent(bestSeenCandidate, node, workDiagnostics) {
    const nextBest = this.searchPolicy.bestByValue(
      [bestSeenCandidate, node].filter(Boolean)
    );
    if (nextBest !== bestSeenCandidate) {
      workDiagnostics.incumbentUpdateCount += 1;
      workDiagnostics.firstCompletedIncumbentAtWorkCount ??= node.completedAtWorkCount;
      workDiagnostics.finalIncumbentAtWorkCount = node.completedAtWorkCount;
      if (node.newlyCompletedPatternProposals?.length) {
        workDiagnostics.patternIncumbentUpdateCount += 1;
      }
    }
    return nextBest;
  }

  /*
  功能
  在现有 beam 内优先选择仍有 Pattern continuation 的 progressive spine。

  调用方
  plan 的逐深度 progressive traversal。

  输入
  当前完整 beam nodes。

  输出
  最高 proposal explorationPriority 的可继续节点；没有 guidance 时返回既有 value best。

  读取状态
  节点 activePatternProposals 与 SearchPolicy value 比较。

  写入状态
  无。

  调用函数
  SearchPolicy.bestByValue。

  边界与不变量
  只改变下一份预算花在哪里，不改变 beam membership、valueScore 或 final selection。
  */
  selectProgressiveSpine(nodes) {
    const available = (nodes ?? []).filter((node) => !node.terminal);
    const guided = available.map((node) => ({
      node,
      proposal:[...(node.activePatternProposals ?? [])].sort((left, right) => {
        if (left.explorationPriority !== right.explorationPriority) {
          return left.explorationPriority > right.explorationPriority ? -1 : 1;
        }
        return left.semanticKey.localeCompare(right.semanticKey);
      })[0] ?? null
    })).filter((entry) => entry.proposal).sort((left, right) => {
      if (left.proposal.explorationPriority !== right.proposal.explorationPriority) {
        return left.proposal.explorationPriority > right.proposal.explorationPriority ? -1 : 1;
      }
      return left.proposal.semanticKey.localeCompare(right.proposal.semanticKey);
    });
    return guided[0]?.node ?? this.searchPolicy.bestByValue(available);
  }

  /*
  功能
  从一个完整父状态生成并原子物化当前深度的全部直接子候选。

  调用方
  plan 的最高调度 root 预展开、progressive spine 与常规 beam 展开。

  输入
  父状态/provenance、深度、行动者、Simulator、SearchBudget、搜索上下文、结构、
  当前 Pattern proposals、是否只推进可解析 guided step、可选的同父 expansion cache、
  单次新增上限和工作诊断。

  输出
  可恢复 expansion cache，以及会话是否在 yield 时取消。

  读取状态
  注入的深层动作生成、CandidateMaterializer、SearchBudget 与 yieldControl。

  写入状态
  SearchBudget 工作计数、搜索上下文诊断与 workDiagnostics 深度/分支/Pattern 中断计数。

  调用函数
  generateFromVisible、scheduleChildActions、prepareCandidate、Simulator.apply、
  CandidateMaterializer.materialize/finalizeSiblings、yieldControl。

  边界与不变量
  cooperative interruption 只丢弃当前 partial child；cache 只含完整候选和未消费的 semantic action 顺序；
  Pattern 下一步只从当前 post-state legal actions 语义解析；有界 early expansion 后必须从同一 cache 继续，
  不能重复生成或物化已完成 child，也不能把中断的 Pattern prefix 标记为完成。
  */
  async materializeChildCandidates({
    parentState,
    parentProvenance,
    depth,
    player,
    simulator,
    budget,
    context,
    structure,
    options,
    activePatternProposals = [],
    guidedContinuationOnly = false,
    resumeExpansion = null,
    maxNewCandidates = Number.POSITIVE_INFINITY,
    workDiagnostics
  }) {
    const guidedStepKeys = activePatternProposals.map(
      (proposal) => proposal.stepKeys[depth - 1]
    ).filter(Boolean);
    const followActions = resumeExpansion?.actions ?? this.scheduleChildActions(
      this.generateFromVisible(parentState, player.id, budget),
      player,
      parentState,
      guidedStepKeys
    );
    if (!resumeExpansion) workDiagnostics.childBranches += followActions.length;
    const candidates = [...(resumeExpansion?.candidates ?? [])];
    let nextActionIndex = resumeExpansion?.nextActionIndex ?? 0;
    let newCandidateCount = 0;
    const requestedCandidateLimit = Number.isFinite(maxNewCandidates)
      ? Math.max(0, Math.floor(maxNewCandidates))
      : Number.POSITIVE_INFINITY;
    const firstActionKey = followActions[nextActionIndex]
      ? this.candidateMaterializer.childSchedulingKey(followActions[nextActionIndex])
      : null;
    const candidateLimit = guidedContinuationOnly
      && !guidedStepKeys.includes(firstActionKey)
      ? 0
      : requestedCandidateLimit;
    while (nextActionIndex < followActions.length && newCandidateCount < candidateLimit) {
      if (budget.shouldStop()) break;
      const action = followActions[nextActionIndex];
      this.candidateMaterializer.observeCandidate(action, context);
      const prepared = this.prepareCandidate(budget, depth, () => {
        budget.observeSimulation();
        const state = simulator.apply(parentState, action, player.id);
        const candidate = this.candidateMaterializer.materialize({
          action,
          beforeState:parentState,
          afterState:state,
          player,
          depth,
          remainingProvenance:parentProvenance,
          simulator,
          context,
          collectDiagnostics:false,
          searchBudget:budget
        });
        return { state, candidate };
      });
      const candidate = prepared?.candidate ?? null;
      if (!candidate) {
        workDiagnostics.abortedCandidateCount += 1;
        const actionKey = this.candidateMaterializer.childSchedulingKey(action);
        for (const proposal of activePatternProposals) {
          if (proposal.stepKeys[depth - 1] !== actionKey
            || workDiagnostics.completedPatternProposalKeys.has(proposal.semanticKey)
            || workDiagnostics.abortedPatternProposalKeys.has(proposal.semanticKey)) continue;
          workDiagnostics.abortedPatternProposalKeys.add(proposal.semanticKey);
          workDiagnostics.abortedPatternCount += 1;
        }
        break;
      }
      candidate.completedAtWorkCount = budget.simulationCalls;
      candidates.push(candidate);
      nextActionIndex += 1;
      newCandidateCount += 1;
      budget.observeNode();
      workDiagnostics.completedChildCandidateCount += 1;
      workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, depth);
      if (depth === 2) {
        workDiagnostics.firstDepth2AtWorkCount ??= candidate.completedAtWorkCount;
      }
      if (budget.expandedNodes % structure.yieldEvery === 0) {
        budget.observeYield();
        if (!(await this.yieldControl(options.gameId))) {
          budget.cancel();
          return {
            actions:followActions,
            candidates:[],
            nextActionIndex,
            complete:false,
            cancelled:true
          };
        }
      }
    }
    this.candidateMaterializer.finalizeSiblings(candidates);
    return {
      actions:followActions,
      candidates,
      nextActionIndex,
      complete:nextActionIndex >= followActions.length,
      cancelled:false
    };
  }

  /*
  功能
  统一记录完成、预算中断或取消后的计划序列与搜索诊断。

  调用方
  plan 的正常收束和 yield 取消路径。

  输入
  SearchBudget、结构配置、完整候选、provisional root、context、根诊断条目与本次搜索工作诊断。

  输出
  返回完整候选动作；TIME/NODE 零完整 root 时返回明确标记的 provisional root；取消仍返回终止动作。

  读取状态
  budget 计数、候选序列、root/work diagnostics 与 CandidateMaterializer 的 context diagnostics。

  写入状态
  lastPlannedSequence 与 lastSearchStats。

  调用函数
  CandidateMaterializer.describeSequence/contextDiagnostics、SearchBudget.diagnostics。

  边界与不变量
  统计只描述实际执行；provisional root 不得写入计划序列、best value 或完整候选计数。
  */
  recordResult({
    budget,
    structure,
    choice,
    provisionalRootFallback = null,
    context,
    rootLedgers,
    workDiagnostics
  }) {
    const budgetStats = budget.diagnostics();
    const provisionalFallbackUsed = !choice
      && workDiagnostics.completedRootCandidateCount === 0
      && ["TIME", "NODE"].includes(budgetStats.stopReason)
      && Boolean(provisionalRootFallback);
    const provisionalFallbackReason = provisionalFallbackUsed
      ? `NO_COMPLETED_ROOT_${budgetStats.stopReason}`
      : null;
    const provisionalFallbackAction = provisionalFallbackUsed
      ? this.candidateMaterializer.describeAction(provisionalRootFallback)
      : null;
    this.lastPlannedSequence = this.candidateMaterializer.describeSequence(
      [...(choice?.sequence ?? [])]
    );
    const contextStats = this.candidateMaterializer.contextDiagnostics(context);
    const slowestPreparation = budgetStats.preparations.reduce((slowest, entry) => (
      !slowest || entry.durationMs > slowest.durationMs ? entry : slowest
    ), null);
    const deadlineCrossingPreparation = budgetStats.preparations.find(
      (entry) => entry.deadlineCrossed
    ) ?? null;
    this.lastSearchStats = {
      elapsedMs:budgetStats.elapsedMs,
      deadlineMs:budgetStats.deadline,
      configuredDeadline:budgetStats.deadline,
      deadlineCrossedAt:budgetStats.deadlineCrossedAt,
      deadlineOverrunMs:budgetStats.deadlineOverrunMs,
      expanded:budgetStats.expandedNodes,
      depth:Math.max(1, choice?.sequence.length ?? 1),
      beamWidth:structure.beamWidth,
      budgetType:budgetStats.nodeBudget === null ? "time" : "nodes",
      timeBudget:budgetStats.timeBudget,
      nodeBudget:budgetStats.nodeBudget,
      stopReason:budgetStats.stopReason,
      timeoutObserved:budgetStats.stopReason === "TIME",
      simulationCalls:budgetStats.simulationCalls,
      simulatorTransitions:budgetStats.simulationCalls,
      cloneCalls:budgetStats.cloneCalls,
      probabilityOperations:budgetStats.probabilityOperations,
      cooperativeProbabilityOperations:budgetStats.cooperativeProbabilityOperations,
      rawProbabilityOperations:budgetStats.rawProbabilityOperations,
      rawProbabilityOperationsAfterTime:budgetStats.rawProbabilityOperationsAfterTime,
      abortedCooperativeProbabilityOperations:budgetStats.abortedCooperativeProbabilityOperations,
      probabilityWorldBranches:budgetStats.probabilityWorldBranches,
      largestCooperativeProbabilityOperation:budgetStats.largestCooperativeProbabilityOperation,
      largestRawProbabilityOperation:budgetStats.largestRawProbabilityOperation,
      largestProbabilityOperation:[
        budgetStats.largestCooperativeProbabilityOperation,
        budgetStats.largestRawProbabilityOperation
      ].filter(Boolean).reduce((largest, operation) => (
        !largest || operation.durationMs > largest.durationMs ? operation : largest
      ), null),
      lastProbabilityOperation:budgetStats.lastProbabilityOperation,
      rawProbabilityDeadlineCrossings:budgetStats.rawProbabilityDeadlineCrossings,
      responseBranches:budgetStats.responseBranches,
      counterfactualCalls:budgetStats.counterfactualCalls,
      stateUtilityCalls:budgetStats.stateUtilityCalls,
      actionGenerationPhysicalCandidates:budgetStats.actionGenerationPhysicalCandidates,
      actionGenerationUniqueCandidates:budgetStats.actionGenerationUniqueCandidates,
      actionGenerationPreparedCandidates:budgetStats.actionGenerationPreparedCandidates,
      probabilityPreparations:budgetStats.probabilityPreparations,
      conditionBranches:budgetStats.conditionBranches,
      executionWorldBranches:budgetStats.executionWorldBranches,
      yieldCount:budgetStats.yieldCount,
      rootSafetyExpandedNodes:budgetStats.rootSafetyExpandedNodes,
      rootSafetySimulationCalls:budgetStats.rootSafetySimulationCalls,
      preparationCount:budgetStats.preparations.length,
      slowestPreparation,
      deadlineCrossingPreparation,
      workAfterDeadline:budgetStats.workAfterDeadline,
      partialCandidateRegistered:budgetStats.partialCandidateRegistered,
      rootCandidatesStarted:budgetStats.rootCandidatesStarted,
      rootCandidatesStartedAfterTime:budgetStats.rootCandidatesStartedAfterTime,
      discoveredDynamicTarget:contextStats.discoveredDynamicTarget,
      hiddenSamples:contextStats.hiddenSamples,
      bestSequence:this.lastPlannedSequence,
      bestRemainingProvenance:choice?.remainingHistory ?? [],
      bestValueScore:choice?.valueScore ?? null,
      physicalRootCount:workDiagnostics.rootCandidateCount,
      uniqueRootCount:workDiagnostics.uniqueRootCandidateCount,
      rootCandidateCount:workDiagnostics.rootCandidateCount,
      uniqueRootCandidateCount:workDiagnostics.uniqueRootCandidateCount,
      equivalentRootCandidatesEliminated:workDiagnostics.equivalentRootCandidatesEliminated,
      scheduledRootOrder:workDiagnostics.scheduledRootOrder,
      completedRootCandidateCount:workDiagnostics.completedRootCandidateCount,
      abortedRootCandidateCount:workDiagnostics.abortedRootCandidateCount,
      abortedCandidateCount:workDiagnostics.abortedCandidateCount,
      childBranches:workDiagnostics.childBranches,
      completedChildCandidateCount:workDiagnostics.completedChildCandidateCount,
      incumbentUpdateCount:workDiagnostics.incumbentUpdateCount,
      firstCompletedIncumbentAtWorkCount:workDiagnostics.firstCompletedIncumbentAtWorkCount,
      finalIncumbentAtWorkCount:workDiagnostics.finalIncumbentAtWorkCount,
      matchedPatternCount:workDiagnostics.matchedPatternCount,
      patternProposalCount:workDiagnostics.patternProposalCount,
      completedPatternCount:workDiagnostics.completedPatternCount,
      abortedPatternCount:workDiagnostics.abortedPatternCount,
      patternIncumbentUpdateCount:workDiagnostics.patternIncumbentUpdateCount,
      selectedPatternId:choice?.completedPatternIds?.[0] ?? null,
      depthReached:workDiagnostics.depthReached,
      firstDepth2AtWorkCount:workDiagnostics.firstDepth2AtWorkCount,
      provisionalFallbackUsed,
      provisionalFallbackReason,
      provisionalFallbackAction,
      activeRoot:workDiagnostics.activeRoot,
      rootWork:workDiagnostics.rootWork,
      rootLedgers
    };
    return choice?.action
      ?? (provisionalFallbackUsed ? provisionalRootFallback : null)
      ?? { type:"end" };
  }

  /*
  功能
  在固定时间或节点预算内执行有限深度束搜索并选择根动作。

  调用方
  AIController.selectAction 与搜索回归测试。

  输入
  行动者、根 SearchState、根候选动作与可选会话/诊断上下文。

  输出
  当前最佳完整根动作；TIME/NODE 零完整 root 时返回已标记的合法 provisional root，取消时安全终止。

  读取状态
  SearchState、PatternMatcher proposal、显式搜索归属模块、动作生成、预算与会话能力。

  写入状态
  lastSearchStats、lastPlannedSequence 与注入能力的既有随机/让步序列。

  调用函数
  PatternMatcher.match、simulatorFactory、searchBudgetFactory、CandidateMaterializer root scheduling/materialization、
  SearchPolicy、generateFromVisible、yieldControl。

  边界与不变量
  root 在昂贵物化前按 SearchPrior 廉价分数和稳定语义键排序，不得依赖 card instance ID 或 hand index；
  Pattern 只可正向安排 guided root/continuation，ordinary challenger 必须先获得 root coverage；
  每个 continuation 从当前 post-state legal actions 解析，Pattern metadata 不进入 value 或 final incumbent rule；
  progressive 只缓存完整子候选；常规逐层 beam 必须复用或补齐原有展开，COMPLETE 仍只从标准 final beam 选择；
  一个候选完整物化并完成同层转移项后，才可登记为 best-seen candidate；TIME/NODE 绝不执行未物化动作；
  TIME/NODE 零完整 root 时只可返回调度最高的合法 non-end provisional root，且不得登记成 candidate/计划；
  根层已物化 end 可作为安全基线；未物化 end 只有在所有 non-end roots 都已比较且全为负时才能补算。
  NODE 中断且已知候选全为负时，只通过 SearchBudget 授权剩余 roots 的有限 depth-1 安全阶段；
  TIME 只返回 deadline 前已经完整 materialize 的 incumbent，绝不启动未物化 root；
  TIME 下任何进入隐藏世界、后续候选或 paired simulation 的 root 必须 cooperative abort，
  安全阶段不得继续束搜索、深层扩展或随机选择。
  */
  async plan(player, visibleState, rootActions, options = {}) {
    this.lastPlannedSequence = [];
    const collectDiagnostics = Boolean(options.collectAiDecisionDiagnostics);
    const budget = this.searchBudgetFactory();
    const structure = this.searchPolicy.structure();
    const uniqueRootActions = this.deduplicateActions(rootActions);
    const patternMatch = this.patternMatcher.match({
      player,
      state:visibleState,
      legalActions:uniqueRootActions,
      structure
    });
    const patternProposals = patternMatch.proposals ?? [];
    const scheduledRootActions = this.scheduleRootActions(
      uniqueRootActions,
      player,
      visibleState,
      patternProposals
    );
    const provisionalRootFallback = scheduledRootActions.find(
      (action) => !this.candidateMaterializer.findTerminalAction([action])
    ) ?? this.candidateMaterializer.findTerminalAction(scheduledRootActions)
      ?? { type:"end" };
    const context = this.candidateMaterializer.createContext(
      player,
      visibleState,
      scheduledRootActions
    );
    const requestedRootCandidateCount = Number(options.rootCandidateCount);
    const rootCandidateCount = Number.isFinite(requestedRootCandidateCount)
      ? Math.max(rootActions.length, Math.floor(requestedRootCandidateCount))
      : rootActions.length;
    const workDiagnostics = {
      rootCandidateCount,
      uniqueRootCandidateCount:uniqueRootActions.length,
      equivalentRootCandidatesEliminated:Math.max(0, rootCandidateCount - uniqueRootActions.length),
      completedRootCandidateCount:0,
      abortedRootCandidateCount:0,
      abortedCandidateCount:0,
      childBranches:0,
      completedChildCandidateCount:0,
      incumbentUpdateCount:0,
      firstCompletedIncumbentAtWorkCount:null,
      finalIncumbentAtWorkCount:null,
      matchedPatternCount:patternMatch.matchedPatternCount ?? 0,
      patternProposalCount:patternProposals.length,
      completedPatternCount:0,
      abortedPatternCount:0,
      patternIncumbentUpdateCount:0,
      completedPatternProposalKeys:new Set(),
      abortedPatternProposalKeys:new Set(),
      depthReached:0,
      firstDepth2AtWorkCount:null,
      scheduledRootOrder:scheduledRootActions.map(
        (action) => this.candidateMaterializer.describeAction(action)
      ),
      activeRoot:null,
      rootWork:[]
    };

    // hidden-world context 之后重新观察预算；TIME 已到时不得再启动 root clone 或分布初始化。
    if (budget.shouldStop()) {
      return this.recordResult({
        budget,
        structure,
        choice:null,
        provisionalRootFallback,
        context,
        rootLedgers:[],
        workDiagnostics
      });
    }
    let simulator;
    try {
      // 每次规划只从组合根注入的工厂创建一个 Simulator，所有节点复用该生命周期。
      simulator = this.simulatorFactory(visibleState, { searchBudget:budget });
    } catch (error) {
      if (!budget.isCurrentWorkInterruption?.(error)) throw error;
      return this.recordResult({
        budget,
        structure,
        choice:null,
        provisionalRootFallback,
        context,
        rootLedgers:[],
        workDiagnostics
      });
    }

    const rootCandidates = [];
    const rootLedgers = [];
    const progressiveDepth2Expansions = new Map();
    // early depth 前先填满现有 root beam 的可用覆盖位；roots 超过 beamWidth 时
    // 仍只覆盖一个 beam，而不会退化为“全部 roots 完成后才进入 depth 2”。
    const earlyProgressiveRootCoverage = Math.min(
      structure.beamWidth,
      uniqueRootActions.length
    );
    for (const action of scheduledRootActions) {
      // 与既有根语义一致：空结果时至少尝试第一个动作；之后只在新的原子物化前检查预算。
      if (rootCandidates.length && budget.shouldStop()) break;
      const rootDescriptor = this.candidateMaterializer.describeAction(action);
      const rootWorkStarted = budget.simulationCalls;
      workDiagnostics.activeRoot = rootDescriptor;
      budget.observeRootCandidateStarted?.();
      const prepared = this.prepareCandidate(budget, 1, () => {
        budget.observeSimulation();
        const state = simulator.apply(visibleState, action, player.id);
        const candidate = this.candidateMaterializer.materialize({
          action,
          beforeState:visibleState,
          afterState:state,
          player,
          depth:1,
          remainingProvenance:context.rootProvenance,
          simulator,
          context,
          collectDiagnostics,
          searchBudget:budget
        });
        return { state, candidate };
      });
      const state = prepared?.state ?? null;
      const candidate = prepared?.candidate ?? null;
      if (!candidate) {
        workDiagnostics.abortedRootCandidateCount += 1;
        workDiagnostics.abortedCandidateCount += 1;
        workDiagnostics.rootWork.push({
          action:rootDescriptor,
          completed:false,
          simulatorTransitions:budget.simulationCalls - rootWorkStarted
        });
        budget.abortRootSafetyCandidate?.();
        break;
      }
      candidate.completedAtWorkCount = budget.simulationCalls;
      rootCandidates.push(candidate);
      budget.observeNode();
      workDiagnostics.completedRootCandidateCount += 1;
      workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, 1);
      workDiagnostics.activeRoot = null;
      workDiagnostics.rootWork.push({
        action:rootDescriptor,
        completed:true,
        simulatorTransitions:budget.simulationCalls - rootWorkStarted
      });
      if (collectDiagnostics) {
        rootLedgers.push(this.candidateMaterializer.diagnosticEntry(candidate));
      }
      if (!progressiveDepth2Expansions.size
        && structure.depth >= 2
        && workDiagnostics.completedRootCandidateCount === earlyProgressiveRootCoverage
        && !budget.shouldStop()) {
        const progressiveRoot = rootCandidates.find((entry) => !entry.terminal);
        if (!progressiveRoot) continue;
        const rootPatternState = this.advancePatternState(
          patternProposals,
          progressiveRoot.action,
          0
        );
        const expansion = await this.materializeChildCandidates({
          parentState:progressiveRoot.state,
          parentProvenance:progressiveRoot.remainingProvenance,
          depth:2,
          player,
          simulator,
          budget,
          context,
          structure,
          options,
          activePatternProposals:rootPatternState.activePatternProposals,
          guidedContinuationOnly:Boolean(rootPatternState.activePatternProposals.length),
          maxNewCandidates:1,
          workDiagnostics
        });
        if (expansion.cancelled) {
          return this.recordResult({
            budget,
            structure,
            choice:null,
            provisionalRootFallback,
            context,
            rootLedgers,
            workDiagnostics
          });
        }
        progressiveDepth2Expansions.set(progressiveRoot.action, expansion);
      }
      if (budget.expandedNodes % structure.yieldEvery === 0) {
        budget.observeYield();
        if (!(await this.yieldControl(options.gameId))) {
          budget.cancel();
          return this.recordResult({
            budget,
            structure,
            choice:null,
            provisionalRootFallback,
            context,
            rootLedgers,
            workDiagnostics
          });
        }
      }
    }

    // 同层转移项是 SearchNode 最终价值的一部分；完成它之后候选才具备 best-seen 资格。
    this.candidateMaterializer.finalizeSiblings(rootCandidates);
    const initiallyMaterializedRootActions = new Set(
      rootCandidates.map((candidate) => candidate.action)
    );
    const unmaterializedNonTerminalRoots = scheduledRootActions.filter((action) => (
      !this.candidateMaterializer.findTerminalAction([action])
      && !initiallyMaterializedRootActions.has(action)
    ));
    const rootTerminalAction = this.candidateMaterializer.findTerminalAction(scheduledRootActions);
    const unmaterializedRootTerminal = rootTerminalAction
      && !initiallyMaterializedRootActions.has(rootTerminalAction);
    const bestMaterializedNonTerminalRoot = rootCandidates
      .filter((candidate) => !this.candidateMaterializer.findTerminalAction([candidate.action]))
      .reduce((best, candidate) => (
        !best || candidate.transitionValue > best.transitionValue ? candidate : best
      ), null);
    const remainingRootSafetyCount = unmaterializedNonTerminalRoots.length
      + (unmaterializedRootTerminal ? 1 : 0);
    const rootSafetyNeeded = (
      unmaterializedNonTerminalRoots.length > 0
        && !(bestMaterializedNonTerminalRoot?.transitionValue >= 0)
    ) || (
      unmaterializedRootTerminal
        && bestMaterializedNonTerminalRoot?.transitionValue < 0
    );
    const rootSafetyCompletionGranted = rootSafetyNeeded
      && remainingRootSafetyCount > 0
      && typeof budget.requestRootSafetyCompletion === "function"
      && budget.requestRootSafetyCompletion({
        depth:1,
        candidateCount:remainingRootSafetyCount
      });
    if (rootSafetyCompletionGranted) {
      // SearchBudget 冻结当前剩余根数并逐个授权；Planner 只编排已授权的
      // depth-1 物化，不建立新 beam、深层循环或采样上下文。
      for (const action of unmaterializedNonTerminalRoots) {
        if (!budget.beginRootSafetyCandidate?.(1)) break;
        const rootDescriptor = this.candidateMaterializer.describeAction(action);
        const rootWorkStarted = budget.simulationCalls;
        workDiagnostics.activeRoot = rootDescriptor;
        budget.observeRootCandidateStarted?.();
        const prepared = this.prepareCandidate(budget, 1, () => {
          budget.observeSimulation();
          const state = simulator.apply(visibleState, action, player.id);
          const candidate = this.candidateMaterializer.materialize({
            action,
            beforeState:visibleState,
            afterState:state,
            player,
            depth:1,
            remainingProvenance:context.rootProvenance,
            simulator,
            context,
            collectDiagnostics,
            searchBudget:budget
          });
          return { state, candidate };
        });
        const state = prepared?.state ?? null;
        const candidate = prepared?.candidate ?? null;
        if (!candidate) {
          workDiagnostics.abortedRootCandidateCount += 1;
          workDiagnostics.abortedCandidateCount += 1;
          workDiagnostics.rootWork.push({
            action:rootDescriptor,
            completed:false,
            simulatorTransitions:budget.simulationCalls - rootWorkStarted
          });
          budget.abortRootSafetyCandidate?.();
          continue;
        }
        candidate.completedAtWorkCount = budget.simulationCalls;
        rootCandidates.push(candidate);
        budget.observeNode();
        workDiagnostics.completedRootCandidateCount += 1;
        workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, 1);
        workDiagnostics.activeRoot = null;
        workDiagnostics.rootWork.push({
          action:rootDescriptor,
          completed:true,
          simulatorTransitions:budget.simulationCalls - rootWorkStarted
        });
        if (collectDiagnostics) {
          rootLedgers.push(this.candidateMaterializer.diagnosticEntry(candidate));
        }
      }
      this.candidateMaterializer.finalizeSiblings(rootCandidates);
    }
    const beam = rootCandidates.map((candidate) => {
      const valueScore = candidate.transitionValue;
      return {
        action:candidate.action,
        state:candidate.state,
        terminal:candidate.terminal,
        valueScore,
        pruneScore:this.searchPolicy.pruneScore(valueScore, candidate.prior, 1),
        searchCredit:candidate.searchCredit,
        sequence:[candidate.action],
        remainingProvenance:candidate.remainingProvenance,
        remainingHistory:[candidate.remainingProvenance],
        candidateLedger:candidate.candidateLedger,
        frontierResidual:candidate.frontierResidual,
        completedAtWorkCount:candidate.completedAtWorkCount,
        ...this.advancePatternState(patternProposals, candidate.action, 0)
      };
    });
    for (const node of beam) this.observeCompletedPatterns(node, workDiagnostics);
    let activeBeam = this.searchPolicy.prune(beam, structure.beamWidth);
    let bestSeenCandidate = null;
    for (const node of beam) {
      bestSeenCandidate = this.considerIncumbent(
        bestSeenCandidate,
        node,
        workDiagnostics
      );
    }
    bestSeenCandidate ??= activeBeam[0];

    const progressiveNodesByDepth = new Map([[2, new Map()]]);
    for (const [rootAction, expansion] of progressiveDepth2Expansions) {
      const parent = beam.find((node) => node.action === rootAction);
      if (!parent) continue;
      const childNodes = expansion.candidates.map(
        (candidate) => this.buildChildNode(parent, candidate, 2)
      );
      progressiveNodesByDepth.get(2).set(parent, { ...expansion, childNodes });
      for (const childNode of childNodes) {
        this.observeCompletedPatterns(childNode, workDiagnostics);
        bestSeenCandidate = this.considerIncumbent(
          bestSeenCandidate,
          childNode,
          workDiagnostics
        );
      }
    }

    // 先沿当前 fully-materialized best 节点推进一条 spine，再执行标准逐层 beam。
    // 每层结果按父节点身份缓存；父节点进入常规 beam 时直接复用，因此 COMPLETE
    // 仍覆盖原有逐层候选，而 TIME 不必等同层所有 sibling 完成后才看见下一层。
    let progressiveSpine = this.selectProgressiveSpine(activeBeam);
    for (let depth = 2;
      progressiveSpine && depth <= structure.depth && !budget.shouldStop();
      depth += 1) {
      workDiagnostics.activeRoot = this.candidateMaterializer.describeAction(
        progressiveSpine.action
      );
      let depthCache = progressiveNodesByDepth.get(depth);
      if (!depthCache) {
        depthCache = new Map();
        progressiveNodesByDepth.set(depth, depthCache);
      }
      const cachedExpansion = depthCache.get(progressiveSpine) ?? null;
      let childNodes = cachedExpansion?.childNodes ?? null;
      let childCandidates = cachedExpansion?.candidates ?? null;
      if (!childNodes) {
        const expansion = await this.materializeChildCandidates({
          parentState:progressiveSpine.state,
          parentProvenance:progressiveSpine.remainingProvenance,
          depth,
          player,
          simulator,
          budget,
          context,
          structure,
          options,
          activePatternProposals:progressiveSpine.activePatternProposals,
          guidedContinuationOnly:Boolean(progressiveSpine.activePatternProposals?.length),
          maxNewCandidates:progressiveSpine.activePatternProposals?.length
            ? 1
            : Number.POSITIVE_INFINITY,
          workDiagnostics
        });
        if (expansion.cancelled) break;
        childCandidates = expansion.candidates;
        childNodes = childCandidates.map(
          (candidate) => this.buildChildNode(progressiveSpine, candidate, depth)
        );
        depthCache.set(progressiveSpine, { ...expansion, childNodes });
      }
      for (const childNode of childNodes) {
        this.observeCompletedPatterns(childNode, workDiagnostics);
        bestSeenCandidate = this.considerIncumbent(
          bestSeenCandidate,
          childNode,
          workDiagnostics
        );
      }
      progressiveSpine = this.selectProgressiveSpine(childNodes);
      workDiagnostics.activeRoot = null;
    }

    for (let depth = 2; depth <= structure.depth; depth += 1) {
      if (budget.shouldStop() || activeBeam.every((node) => node.terminal)) break;
      const candidates = [];
      for (const node of activeBeam) {
        if (budget.shouldStop()) break;
        if (node.terminal) {
          candidates.push({ ...node, pruneScore:node.valueScore, searchCredit:0 });
          continue;
        }
        workDiagnostics.activeRoot = this.candidateMaterializer.describeAction(node.action);
        const depthCache = progressiveNodesByDepth.get(depth) ?? new Map();
        if (!progressiveNodesByDepth.has(depth)) {
          progressiveNodesByDepth.set(depth, depthCache);
        }
        const cachedExpansion = depthCache.get(node) ?? null;
        if (cachedExpansion?.complete) {
          candidates.push(...cachedExpansion.childNodes);
          workDiagnostics.activeRoot = null;
          continue;
        }
        const previousCandidateCount = cachedExpansion?.candidates.length ?? 0;
        const expansion = await this.materializeChildCandidates({
          parentState:node.state,
          parentProvenance:node.remainingProvenance,
          depth,
          player,
          simulator,
          budget,
          context,
          structure,
          options,
          activePatternProposals:node.activePatternProposals,
          resumeExpansion:cachedExpansion,
          workDiagnostics
        });
        if (expansion.cancelled) {
          return this.recordResult({
            budget,
            structure,
            choice:null,
            provisionalRootFallback,
            context,
            rootLedgers,
            workDiagnostics
          });
        }
        const childNodes = [
          ...(cachedExpansion?.childNodes ?? []),
          ...expansion.candidates.slice(previousCandidateCount).map(
            (candidate) => this.buildChildNode(node, candidate, depth)
          )
        ];
        depthCache.set(node, { ...expansion, childNodes });
        candidates.push(...childNodes);
        for (let index = previousCandidateCount; index < childNodes.length; index += 1) {
          const nextNode = childNodes[index];
          this.observeCompletedPatterns(nextNode, workDiagnostics);
          bestSeenCandidate = this.considerIncumbent(
            bestSeenCandidate,
            nextNode,
            workDiagnostics
          );
        }
        if (budget.shouldStop()) break;
        workDiagnostics.activeRoot = null;
      }
      if (!candidates.length) break;
      activeBeam = this.searchPolicy.prune(candidates, structure.beamWidth);
    }

    budget.complete();
    const materializedRootActions = new Set(rootCandidates.map((candidate) => candidate.action));
    let choice = this.searchPolicy.selectFinal({
      stopReason:budget.stopReason,
      completedCandidates:activeBeam,
      bestSeenCandidate
    });

    // 已物化 end 可在任何停止原因下比较；未物化 end 只有在全部 non-end
    // 根动作都已物化后才能恢复，不得越过同样未比较的 card/skill sibling。
    if (rootTerminalAction) {
      const allNonTerminalRootsMaterialized = scheduledRootActions.every((action) => (
        this.candidateMaterializer.findTerminalAction([action])
        || materializedRootActions.has(action)
      ));
      const allMaterializedNonTerminalRootsNegative = rootCandidates
        .filter((candidate) => !this.candidateMaterializer.findTerminalAction([candidate.action]))
        .every((candidate) => candidate.transitionValue < 0);
      const terminalInFinalBeam = activeBeam.find(
        (node) => this.candidateMaterializer.findTerminalAction([node.action])
      );
      const materializedRootTerminal = budget.stopReason === "COMPLETE"
        ? null
        : beam.find(
            (node) => this.candidateMaterializer.findTerminalAction([node.action])
          );
      let terminalChoice = terminalInFinalBeam ?? materializedRootTerminal;
      if (!terminalChoice && allNonTerminalRootsMaterialized
        && allMaterializedNonTerminalRootsNegative
        && rootSafetyCompletionGranted
        && budget.beginRootSafetyCandidate?.(1)) {
        const rootDescriptor = this.candidateMaterializer.describeAction(rootTerminalAction);
        const rootWorkStarted = budget.simulationCalls;
        workDiagnostics.activeRoot = rootDescriptor;
        budget.observeRootCandidateStarted?.();
        const prepared = this.prepareCandidate(budget, 1, () => {
          budget.observeSimulation();
          const state = simulator.apply(
            visibleState,
            rootTerminalAction,
            player.id
          );
          const candidate = this.candidateMaterializer.terminalFallback({
            action:rootTerminalAction,
            beforeState:visibleState,
            afterState:state,
            player,
            siblingCandidates:rootCandidates,
            remainingProvenance:context.rootProvenance,
            simulator,
            context,
            searchBudget:budget
          });
          return { state, candidate };
        });
        const terminalState = prepared?.state ?? null;
        const fallback = prepared?.candidate ?? null;
        if (!fallback) {
          budget.abortRootSafetyCandidate?.();
          return this.recordResult({
            budget,
            structure,
            choice,
            provisionalRootFallback,
            context,
            rootLedgers,
            workDiagnostics
          });
        }
        budget.observeNode();
        workDiagnostics.completedRootCandidateCount += 1;
        workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, 1);
        workDiagnostics.activeRoot = null;
        workDiagnostics.rootWork.push({
          action:rootDescriptor,
          completed:true,
          simulatorTransitions:budget.simulationCalls - rootWorkStarted
        });
        terminalChoice = {
          action:rootTerminalAction,
          state:terminalState,
          terminal:true,
          valueScore:fallback.transitionValue,
          pruneScore:fallback.transitionValue,
          sequence:[rootTerminalAction],
          remainingHistory:[],
          frontierResidual:fallback.frontierResidual
        };
      }
      if (terminalChoice && (!choice || terminalChoice.valueScore > choice.valueScore)) {
        workDiagnostics.incumbentUpdateCount += 1;
        workDiagnostics.firstCompletedIncumbentAtWorkCount ??= budget.simulationCalls;
        workDiagnostics.finalIncumbentAtWorkCount = budget.simulationCalls;
        choice = terminalChoice;
      }
    }

    return this.recordResult({
      budget,
      structure,
      choice,
      provisionalRootFallback,
      context,
      rootLedgers,
      workDiagnostics
    });
  }
}
