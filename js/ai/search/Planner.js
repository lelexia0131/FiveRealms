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
  CandidateMaterializer、SearchPolicy、Simulator/SearchBudget factory、深层生成与可取消让步能力。

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
    generateFromVisible,
    yieldControl
  } = {}) {
    const services = { candidateMaterializer, searchPolicy };
    const capabilities = {
      simulatorFactory,
      searchBudgetFactory,
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
  统一记录完成、预算中断或取消后的计划序列与搜索诊断。

  调用方
  plan 的正常收束和 yield 取消路径。

  输入
  SearchBudget、结构配置、候选、context 与根诊断条目。

  输出
  选择动作；无选择或取消时返回终止动作。

  读取状态
  budget 计数、候选序列与 CandidateMaterializer 的 context diagnostics。

  写入状态
  lastPlannedSequence 与 lastSearchStats。

  调用函数
  CandidateMaterializer.describeSequence/contextDiagnostics、SearchBudget.diagnostics。

  边界与不变量
  统计只描述实际执行；不得根据 stopReason 改写候选价值或补造节点。
  */
  recordResult({ budget, structure, choice, context, rootLedgers }) {
    this.lastPlannedSequence = this.candidateMaterializer.describeSequence(
      [...(choice?.sequence ?? [])]
    );
    const budgetStats = budget.diagnostics();
    const contextStats = this.candidateMaterializer.contextDiagnostics(context);
    this.lastSearchStats = {
      elapsedMs:budgetStats.elapsedMs,
      expanded:budgetStats.expandedNodes,
      depth:Math.max(1, choice?.sequence.length ?? 1),
      beamWidth:structure.beamWidth,
      budgetType:budgetStats.nodeBudget === null ? "time" : "nodes",
      timeBudget:budgetStats.timeBudget,
      nodeBudget:budgetStats.nodeBudget,
      stopReason:budgetStats.stopReason,
      simulationCalls:budgetStats.simulationCalls,
      counterfactualCalls:budgetStats.counterfactualCalls,
      stateUtilityCalls:budgetStats.stateUtilityCalls,
      yieldCount:budgetStats.yieldCount,
      discoveredDynamicTarget:contextStats.discoveredDynamicTarget,
      hiddenSamples:contextStats.hiddenSamples,
      bestSequence:this.lastPlannedSequence,
      bestRemainingProvenance:choice?.remainingHistory ?? [],
      bestValueScore:choice?.valueScore ?? null,
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
  一个候选完整物化并完成同层转移项后，才可登记为 best-seen candidate；TIME/NODE 绝不从未完整物化的搜索前沿重选；
  根层已完整物化的终止动作可作为安全基线；只有全部 non-end 根动作都已比较时才能补算未物化的 end，
  避免预算一面强制执行真实负收益动作，一面让 end 越过未比较的 card sibling。
  */
  async plan(player, visibleState, rootActions, options = {}) {
    this.lastPlannedSequence = [];
    const collectDiagnostics = Boolean(options.collectAiDecisionDiagnostics);
    const budget = this.searchBudgetFactory();
    const structure = this.searchPolicy.structure();
    // 每次规划只从组合根注入的工厂创建一个 Simulator，所有节点复用该生命周期。
    const simulator = this.simulatorFactory(visibleState);
    const context = this.candidateMaterializer.createContext(
      player,
      visibleState,
      rootActions
    );

    const rootCandidates = [];
    const rootLedgers = [];
    for (const action of rootActions) {
      // 与既有根语义一致：空结果时至少尝试第一个动作；之后只在新的原子物化前检查预算。
      if (rootCandidates.length && budget.shouldStop()) break;
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
      rootCandidates.push(candidate);
      budget.observeNode();
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
            rootLedgers
          });
        }
      }
    }

    // 同层转移项是 SearchNode 最终价值的一部分；完成它之后候选才具备 best-seen 资格。
    this.candidateMaterializer.finalizeSiblings(rootCandidates, 1);
    const beam = rootCandidates.map((candidate) => {
      const valueScore = candidate.transitionValue;
      return {
        action:candidate.action,
        state:candidate.state,
        terminal:candidate.terminal,
        valueScore,
        pruneScore:this.searchPolicy.pruneScore(valueScore, candidate.prior, 1),
        sequence:[candidate.action],
        remainingProvenance:candidate.remainingProvenance,
        remainingHistory:[candidate.remainingProvenance],
        candidateLedger:candidate.candidateLedger,
        frontierResidual:candidate.frontierResidual
      };
    });
    let activeBeam = this.searchPolicy.prune(beam, structure.beamWidth);
    let bestSeenCandidate = this.searchPolicy.bestByValue(beam) ?? activeBeam[0];

    for (let depth = 2; depth <= structure.depth; depth += 1) {
      if (budget.shouldStop() || activeBeam.every((node) => node.terminal)) break;
      const candidates = [];
      for (const node of activeBeam) {
        if (budget.shouldStop()) break;
        if (node.terminal) {
          candidates.push({ ...node, pruneScore:node.valueScore });
          continue;
        }
        const followActions = this.generateFromVisible(node.state, player.id);
        const nodeCandidates = [];
        for (const action of followActions) {
          if (budget.shouldStop()) break;
          this.candidateMaterializer.observeCandidate(action, context);
          budget.observeSimulation();
          const state = simulator.apply(node.state, action, player.id);
          nodeCandidates.push(this.candidateMaterializer.materialize({
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
          }));
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
                rootLedgers
              });
            }
          }
        }
        this.candidateMaterializer.finalizeSiblings(nodeCandidates, depth);
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
            sequence:[...node.sequence, candidate.action],
            remainingProvenance:candidate.remainingProvenance,
            remainingHistory:[
              ...node.remainingHistory,
              candidate.remainingProvenance
            ],
            frontierResidual:candidate.frontierResidual
          };
          candidates.push(nextNode);
          if (!bestSeenCandidate || valueScore > bestSeenCandidate.valueScore) {
            bestSeenCandidate = nextNode;
          }
        }
        if (budget.shouldStop()) break;
      }
      if (!candidates.length) break;
      activeBeam = this.searchPolicy.prune(candidates, structure.beamWidth);
    }

    budget.complete();
    let choice = this.searchPolicy.selectFinal({
      stopReason:budget.stopReason,
      completedCandidates:activeBeam,
      bestSeenCandidate
    });

    // 根终止动作是已由规则提供的安全基线。已物化的 end 可在任何停止原因下参与比较；
    // 未物化的 end 只有在全部 non-end 根动作都已比较后才能恢复，不能越过同样未物化的 card 候选。
    const rootTerminalAction = this.candidateMaterializer.findTerminalAction(rootActions);
    if (rootTerminalAction) {
      const materializedRootActions = new Set(rootCandidates.map((candidate) => candidate.action));
      const allNonTerminalRootsMaterialized = rootActions.every((action) => (
        this.candidateMaterializer.findTerminalAction([action])
        || materializedRootActions.has(action)
      ));
      const terminalInFinalBeam = activeBeam.find(
        (node) => this.candidateMaterializer.findTerminalAction([node.action])
      );
      const materializedRootTerminal = budget.stopReason === "COMPLETE"
        ? null
        : beam.find(
            (node) => this.candidateMaterializer.findTerminalAction([node.action])
          );
      let terminalChoice = terminalInFinalBeam ?? materializedRootTerminal;
      if (!terminalChoice && allNonTerminalRootsMaterialized) {
        budget.observeSimulation();
        const terminalState = simulator.apply(
          visibleState,
          rootTerminalAction,
          player.id
        );
        const fallback = this.candidateMaterializer.terminalFallback({
          action:rootTerminalAction,
          beforeState:visibleState,
          afterState:terminalState,
          player,
          siblingCandidates:rootCandidates,
          remainingProvenance:context.rootProvenance,
          simulator,
          context
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
        choice = terminalChoice;
      }
    }

    return this.recordResult({
      budget,
      structure,
      choice,
      context,
      rootLedgers
    });
  }
}
