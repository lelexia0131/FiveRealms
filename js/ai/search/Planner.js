/*
模块职责
在 SearchState 上编排 beam search（束搜索：每层只保留固定数量候选）并返回最佳根动作与稳定计划序列。

上游
AIController 组合根与搜索回归测试。

下游
注入的 Simulator/SearchBudget 工厂、CandidateMaterializer、SearchPolicy 与动作生成/让步能力。

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
  CandidateMaterializer、SearchPolicy、Simulator/SearchBudget factory、候选去重、深层生成与可取消让步能力。

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
    searchPolicy,
    simulatorFactory,
    searchBudgetFactory,
    deduplicateActions,
    generateFromVisible,
    yieldControl
  } = {}) {
    const services = { candidateMaterializer, searchPolicy };
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
  统一记录完成、预算中断或取消后的计划序列与搜索诊断。

  调用方
  plan 的正常收束和 yield 取消路径。

  输入
  SearchBudget、结构配置、候选、context、根诊断条目与本次搜索工作诊断。

  输出
  选择动作；无选择或取消时返回终止动作。

  读取状态
  budget 计数、候选序列、root/work diagnostics 与 CandidateMaterializer 的 context diagnostics。

  写入状态
  lastPlannedSequence 与 lastSearchStats。

  调用函数
  CandidateMaterializer.describeSequence/contextDiagnostics、SearchBudget.diagnostics。

  边界与不变量
  统计只描述实际执行；不得根据 stopReason 改写候选价值或补造节点。
  */
  recordResult({ budget, structure, choice, context, rootLedgers, workDiagnostics }) {
    this.lastPlannedSequence = this.candidateMaterializer.describeSequence(
      [...(choice?.sequence ?? [])]
    );
    const budgetStats = budget.diagnostics();
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
      rootCandidateCount:workDiagnostics.rootCandidateCount,
      uniqueRootCandidateCount:workDiagnostics.uniqueRootCandidateCount,
      equivalentRootCandidatesEliminated:workDiagnostics.equivalentRootCandidatesEliminated,
      completedRootCandidateCount:workDiagnostics.completedRootCandidateCount,
      abortedRootCandidateCount:workDiagnostics.abortedRootCandidateCount,
      abortedCandidateCount:workDiagnostics.abortedCandidateCount,
      childBranches:workDiagnostics.childBranches,
      incumbentUpdateCount:workDiagnostics.incumbentUpdateCount,
      firstCompletedIncumbentAtWorkCount:workDiagnostics.firstCompletedIncumbentAtWorkCount,
      finalIncumbentAtWorkCount:workDiagnostics.finalIncumbentAtWorkCount,
      activeRoot:workDiagnostics.activeRoot,
      rootWork:workDiagnostics.rootWork,
      rootLedgers
    };
    return choice?.action ?? { type:"end" };
  }

  /*
  功能
  在固定时间或节点预算内执行有限深度束搜索并选择根动作。

  调用方
  AIController.selectAction 与搜索回归测试。

  输入
  行动者、根 SearchState、根候选动作与可选会话/诊断上下文。

  输出
  当前最佳根动作；取消或无候选时安全返回终止动作。

  读取状态
  SearchState、显式搜索归属模块、动作生成、预算与会话能力。

  写入状态
  lastSearchStats、lastPlannedSequence 与注入能力的既有随机/让步序列。

  调用函数
  simulatorFactory、searchBudgetFactory、CandidateMaterializer、SearchPolicy、generateFromVisible、yieldControl。

  边界与不变量
  一个候选完整物化并完成同层转移项后，才可登记为 best-seen candidate；TIME/NODE 绝不执行未物化动作；
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
    const context = this.candidateMaterializer.createContext(
      player,
      visibleState,
      uniqueRootActions
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
      incumbentUpdateCount:0,
      firstCompletedIncumbentAtWorkCount:null,
      finalIncumbentAtWorkCount:null,
      activeRoot:null,
      rootWork:[]
    };

    // hidden-world context 之后重新观察预算；TIME 已到时不得再启动 root clone 或分布初始化。
    if (budget.shouldStop()) {
      return this.recordResult({
        budget,
        structure,
        choice:null,
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
        context,
        rootLedgers:[],
        workDiagnostics
      });
    }

    const rootCandidates = [];
    const rootLedgers = [];
    for (const action of uniqueRootActions) {
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
      workDiagnostics.activeRoot = null;
      workDiagnostics.rootWork.push({
        action:rootDescriptor,
        completed:true,
        simulatorTransitions:budget.simulationCalls - rootWorkStarted
      });
      if (collectDiagnostics) {
        rootLedgers.push(this.candidateMaterializer.diagnosticEntry(candidate));
      }
      if (budget.expandedNodes % structure.yieldEvery === 0) {
        budget.observeYield();
        if (!(await this.yieldControl(options.gameId))) {
          budget.cancel();
          return this.recordResult({
            budget,
            structure,
            choice:null,
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
    const unmaterializedNonTerminalRoots = uniqueRootActions.filter((action) => (
      !this.candidateMaterializer.findTerminalAction([action])
      && !initiallyMaterializedRootActions.has(action)
    ));
    const rootTerminalAction = this.candidateMaterializer.findTerminalAction(uniqueRootActions);
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
        completedAtWorkCount:candidate.completedAtWorkCount
      };
    });
    let activeBeam = this.searchPolicy.prune(beam, structure.beamWidth);
    let bestSeenCandidate = null;
    for (const node of beam) {
      const nextBest = this.searchPolicy.bestByValue(
        [bestSeenCandidate, node].filter(Boolean)
      );
      if (nextBest !== bestSeenCandidate) {
        workDiagnostics.incumbentUpdateCount += 1;
        workDiagnostics.firstCompletedIncumbentAtWorkCount ??= node.completedAtWorkCount;
        workDiagnostics.finalIncumbentAtWorkCount = node.completedAtWorkCount;
      }
      bestSeenCandidate = nextBest;
    }
    bestSeenCandidate ??= activeBeam[0];

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
        const followActions = this.generateFromVisible(node.state, player.id, budget);
        workDiagnostics.childBranches += followActions.length;
        const nodeCandidates = [];
        for (const action of followActions) {
          if (budget.shouldStop()) break;
          this.candidateMaterializer.observeCandidate(action, context);
          const prepared = this.prepareCandidate(budget, depth, () => {
            budget.observeSimulation();
            const state = simulator.apply(node.state, action, player.id);
            const candidate = this.candidateMaterializer.materialize({
              action,
              beforeState:node.state,
              afterState:state,
              player,
              depth,
              remainingProvenance:node.remainingProvenance,
              simulator,
              context,
              collectDiagnostics:false,
              searchBudget:budget
            });
            return { state, candidate };
          });
          const state = prepared?.state ?? null;
          const candidate = prepared?.candidate ?? null;
          if (!candidate) {
            workDiagnostics.abortedCandidateCount += 1;
            break;
          }
          candidate.completedAtWorkCount = budget.simulationCalls;
          nodeCandidates.push(candidate);
          budget.observeNode();
          if (budget.expandedNodes % structure.yieldEvery === 0) {
            budget.observeYield();
            if (!(await this.yieldControl(options.gameId))) {
              budget.cancel();
              return this.recordResult({
                budget,
                structure,
                choice:null,
                context,
                rootLedgers,
                workDiagnostics
              });
            }
          }
        }
        this.candidateMaterializer.finalizeSiblings(nodeCandidates);
        for (const candidate of nodeCandidates) {
          const valueScore = node.valueScore + candidate.transitionValue;
          const nextNode = {
            action:node.action,
            state:candidate.state,
            terminal:candidate.terminal,
            valueScore,
            pruneScore:this.searchPolicy.pruneScore(
              valueScore,
              candidate.prior,
              depth
            ),
            searchCredit:candidate.searchCredit,
            sequence:[...node.sequence, candidate.action],
            remainingProvenance:candidate.remainingProvenance,
            remainingHistory:[
              ...node.remainingHistory,
              candidate.remainingProvenance
            ],
            frontierResidual:candidate.frontierResidual
          };
          candidates.push(nextNode);
          const nextBest = this.searchPolicy.bestByValue([
            bestSeenCandidate,
            nextNode
          ].filter(Boolean));
          if (nextBest !== bestSeenCandidate) {
            workDiagnostics.incumbentUpdateCount += 1;
            workDiagnostics.firstCompletedIncumbentAtWorkCount ??= candidate.completedAtWorkCount;
            workDiagnostics.finalIncumbentAtWorkCount = candidate.completedAtWorkCount;
          }
          bestSeenCandidate = nextBest;
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
      const allNonTerminalRootsMaterialized = uniqueRootActions.every((action) => (
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
            context,
            rootLedgers,
            workDiagnostics
          });
        }
        budget.observeNode();
        workDiagnostics.completedRootCandidateCount += 1;
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
      context,
      rootLedgers,
      workDiagnostics
    });
  }
}
