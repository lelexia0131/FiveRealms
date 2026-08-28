/*
模块职责
唯一拥有 World 上的 beam search、Pattern 调度、frontier、root coverage、预算检查与 incumbent 维护。

上游
Controller、WorkerSearchRuntime 与搜索回归测试。

下游
注入的 Pattern、Simulator/SearchBudget 工厂、Evaluator facade 与动作生成/让步能力。

状态边界
只读输入 World，所有分支写入由 simulatorFactory 创建的独立 Simulator 承担。

信息边界
Searcher 不读取 GameState 或领域隐藏事实；合法候选与全部数值项来自显式注入的能力和唯一归属者。

架构约束
不得定义合法性、transition、Final Utility 或最终偏好；只能调用 Evaluator comparator 机械维护 incumbent。
*/
import {
  PROBABILITY_CLASSIFICATION
} from "../Event/Probability/Probability.js";
import { actionIntentKey, actionSearchKey } from "../Generator/Action.js";

export class Searcher {
  /*
  功能
  创建只依赖正式搜索归属模块与窄运行能力的 Searcher。

  调用方
  共享搜索组合 与正式边界。

  输入
  Evaluator、Pattern、搜索配置、
  Simulator/SearchBudget factory、候选去重、深层生成与可取消让步能力。

  输出
  可执行 search 的 Searcher。

  读取状态
  无。

  写入状态
  实例依赖、最近搜索统计与仅供搜索诊断的最优序列。

  调用函数
  无。

  边界与不变量
  不接收 Game、Controller、领域归属模块或具体 Simulator 类；随机只能通过其它探索能力使用，不能改变最终 winner。
  */
  constructor({
    evaluator,
    patternMatcher,
    getResolutionScale,
    config,
    simulatorFactory,
    searchBudgetFactory,
    deduplicateActions,
    generateActions,
    sampleUnknownHands,
    yieldControl
  } = {}) {
    const services = {
      evaluator,
      patternMatcher
    };
    const capabilities = {
      getResolutionScale,
      simulatorFactory,
      searchBudgetFactory,
      deduplicateActions,
      generateActions,
      sampleUnknownHands,
      yieldControl
    };
    for (const [name, service] of Object.entries(services)) {
      if (!service) throw new TypeError(`Searcher 缺少依赖：${name}`);
    }
    for (const [name, capability] of Object.entries(capabilities)) {
      if (typeof capability !== "function") {
        throw new TypeError(`Searcher 缺少依赖：${name}`);
      }
    }
    if (!config || typeof config !== "object") {
      throw new TypeError("Searcher 缺少依赖：config");
    }
    Object.assign(this, services);
    Object.assign(this, capabilities);
    this.config = Object.freeze({ ...config });
    this.hiddenSampleCount = this.config.hiddenSamples;
    this.lastSearchStats = null;
    this.lastSequence = [];
    this.comparisonActor = null;
    this.comparisonWorld = null;
  }

  /*
  功能
  返回本次搜索的稳定结构配置。

  调用方
  search。

  输入
  无。

  输出
  depth、beamWidth、hiddenSamples 与 yieldEvery。

  读取状态
  构造时冻结的 config。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只解释搜索结构，不读取或扩大预算。
  */
  structure() {
    return {
      depth:this.config.depth,
      beamWidth:this.config.beamWidth,
      hiddenSamples:this.config.hiddenSamples,
      yieldEvery:this.config.yieldEvery
    };
  }

  /*
  功能
  组合 Final Utility 与只用于探索裁剪的 prior。

  调用方
  buildChildNode 与 search 的根节点构造。

  输入
  valueScore、prior 与真实深度。

  输出
  仅用于 beam membership 的 pruneScore。

  读取状态
  无。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  prior 只能改变搜索顺序和有限 beam，不得写回 Final Utility。
  */
  pruneScore(valueScore, prior, depth) {
    return valueScore + prior / depth;
  }

  /*
  功能
  机械保留候选集合中由 Evaluator comparator 判定的 incumbent。

  调用方
  considerIncumbent、selectProgressiveSpine、search root safety 与最终收束。

  输入
  只含完整物化节点的候选数组。

  输出
  最优完整节点；空数组返回 null。

  读取状态
  注入的 Evaluator comparator。

  写入状态
  无。

  调用函数
  compareCandidates。

  边界与不变量
  Searcher 不解释为什么候选更优；完全等价时保留原顺序。
  */
  bestCandidate(candidates) {
    return (candidates ?? []).reduce((best, node) => {
      if (!best) return node;
      return this.evaluator.compareCandidates(
        node,
        best,
        this.comparisonActor,
        this.comparisonWorld
      ) > 0 ? node : best;
    }, null);
  }

  /*
  功能
  把已完成 Final Utility 的根候选转换为可参与 incumbent 收束的根节点。

  调用方
  search 的正常根 beam 构造与根阶段取消收束。

  输入
  已物化根候选、Pattern proposals 与根 World。

  输出
  只包含 transitionValue 已完成候选的根节点数组。

  读取状态
  候选 Final Utility、prior、provenance、diagnostics 与 Pattern 状态。

  写入状态
  无。

  调用函数
  pruneScore、advancePatternState。

  边界与不变量
  incomplete END 或其它 partial candidate 永远不会生成节点；该投影不重新比较或重算价值。
  */
  buildRootNodes(rootCandidates, patternProposals, world) {
    return rootCandidates
      .filter((candidate) => candidate.transitionValue !== null)
      .map((candidate) => {
        const valueScore = candidate.transitionValue;
        return {
          action:candidate.action,
          state:candidate.state,
          comparisonTerms:candidate.comparisonTerms,
          terminal:candidate.terminal,
          valueScore,
          pruneScore:this.pruneScore(valueScore, candidate.prior, 1),
          searchCredit:candidate.searchCredit,
          sequence:[candidate.action],
          remainingProvenance:candidate.remainingProvenance,
          remainingHistory:[candidate.remainingProvenance],
          candidateLedger:candidate.candidateLedger,
          frontierResidual:candidate.frontierResidual,
          completedAtWorkCount:candidate.completedAtWorkCount,
          ...this.advancePatternState(patternProposals, candidate.action, 0, [], world)
        };
      });
  }

  /*
  功能
  按探索分数截取有限 beam，同时保留当前 Evaluator incumbent。

  调用方
  search 的根层与逐深度扩展。

  输入
  完整候选数组与 beamWidth。

  输出
  不超过 beamWidth 的新数组。

  读取状态
  pruneScore、searchCredit 与 Evaluator comparator。

  写入状态
  无。

  调用函数
  bestCandidate。

  边界与不变量
  不修改输入数组；prior 不能把当前已证明的 Final Utility incumbent 完全挤出 beam。
  */
  prune(candidates, beamWidth) {
    const ordered = [...(candidates ?? [])].sort((left, right) => (
      right.pruneScore - left.pruneScore
    ));
    const beam = ordered.slice(0, beamWidth);
    const incumbent = this.bestCandidate(ordered);
    if (beam.length && incumbent && !beam.includes(incumbent)) {
      let replacementIndex = beam.length - 1;
      while (replacementIndex >= 0 && beam[replacementIndex].searchCredit > 0) {
        replacementIndex -= 1;
      }
      beam[replacementIndex < 0 ? beam.length - 1 : replacementIndex] = incumbent;
    }
    return beam;
  }

  /*
  功能
  按停止原因返回最终完整候选。

  调用方
  search 收束阶段。

  输入
  stopReason、完整 final beam 与全局 best-seen candidate。

  输出
  COMPLETE 时返回 Evaluator incumbent；TIME/NODE/CANCELLED 返回中断前的全局完整 incumbent。

  读取状态
  注入的 Evaluator comparator。

  写入状态
  无。

  调用函数
  bestCandidate。

  边界与不变量
  随机数和 near-tie 只能影响探索顺序，不能改变 final winner；partial candidate 永不参与。
  */
  selectFinal({ stopReason, completedCandidates, bestSeenCandidate }) {
    if (stopReason === "COMPLETE") return this.bestCandidate(completedCandidates);
    if (["TIME", "NODE", "CANCELLED"].includes(stopReason)) return bestSeenCandidate;
    return null;
  }

  /*
  功能
  计算动作在昂贵 materialization 前的廉价探索顺序分数。

  调用方
  scheduleRootActions 与 scheduleChildActions。

  输入
  canonical Action、行动者与当前 World。

  输出
  有限调度分数。

  读取状态
  Evaluator 的搜索调度值。

  写入状态
  无。

  调用函数
  Evaluator.rootSchedulingScore。

  边界与不变量
  只改变探索顺序，不进入 Final Utility 或候选 prior。
  */
  schedulingScore(action, player, state) {
    const score = this.evaluator.rootSchedulingScore(action, player, state);
    return Number.isFinite(score) || score === Number.NEGATIVE_INFINITY ? score : 0;
  }

  /*
  功能
  创建一次搜索共用的有界反事实上下文。

  调用方
  search。

  输入
  行动者与根 World。

  输出
  本次搜索共用的反事实上下文。

  读取状态
  根 World 的 ProbabilityState、玩家与 Evaluator provenance。

  写入状态
  只创建本次搜索的懒采样缓存容器。

  调用函数
  Evaluator.initialTransitionProvenance。

  边界与不变量
  每次 search 只创建一次，不作为线性 World middle layer。
  */
  createContext(player, state) {
    return {
      viewer:player,
      probabilityState:state.probabilityState,
      probabilityPlayers:state.players,
      unknownHandEstimate:null,
      rootProvenance:this.evaluator.initialTransitionProvenance(player, state)
    };
  }

  /*
  功能
  为 diagnostics 中已识别的响应消费构造配对 World，并交给 Evaluator 计算归属价值。

  调用方
  evaluateCandidate 的显式 diagnostics 路径。

  输入
  before/after World、canonical Action、viewer、Simulator 与响应 attribution 描述。

  输出
  带纯 evaluation 结果的 attribution 数组。

  读取状态
  Evaluator 描述的移除项与 Simulator transition。

  写入状态
  只写 Simulator 返回的独立反事实 World。

  调用函数
  Simulator.buildResponseCounterfactualWorlds/buildLightningOutcomeSets、Evaluator.evaluateResponseCounterfactual。

  边界与不变量
  Searcher 只编排 transition/value owner；响应价值只作诊断，不参与 final value。
  */
  evaluateResponseAttributions(before, action, after, viewerId, simulator) {
    const descriptions = this.evaluator.describeResponseAttributions(
      before,
      action,
      after,
      viewerId
    );
    return descriptions.map((description) => {
      const worlds = simulator.buildResponseCounterfactualWorlds(
        before,
        action,
        description.responderId,
        description.remove,
        after
      );
      const actualLightningOutcomeSets = simulator.buildLightningOutcomeSets(
        worlds.actualWorld
      );
      const counterfactualLightningOutcomeSets = simulator.buildLightningOutcomeSets(
        worlds.counterfactualWorld
      );
      return {
        ...description,
        evaluation:this.evaluator.evaluateResponseCounterfactual(
          worlds.actualWorld,
          worlds.counterfactualWorld,
          description.responderId,
          viewerId,
          actualLightningOutcomeSets,
          counterfactualLightningOutcomeSets
        )
      };
    });
  }

  /*
  功能
  把一次已经模拟完成的 canonical Action 组装为完整可比较搜索候选。

  调用方
  根、root safety 与深层 candidate preparation。

  输入
  动作前后 World、行动者、深度、provenance、Simulator、上下文、诊断开关与 SearchBudget。

  输出
  完整候选；X 技能另带同 World 下 E+1 的完整 StateDelta；反事实中断时返回 null。

  读取状态
  Searcher 反事实项、Evaluator 与搜索上下文。

  写入状态
  只写独立候选记录和显式诊断。

  调用函数
  materializeValueTerms、Simulator.clone/apply、
  Evaluator.evaluateTransition/transitionDelta/frontierResidual/composeSearchPrior。

  边界与不变量
  Searcher 只机械组装各 owner 的结果；X 技能反事实仅 clone 同一 before World 并替换行动者能量，
  不模拟回合、摸牌或敌方行动；不定义 value formula，partial candidate 不得返回。
  */
  evaluateCandidate({
    action,
    beforeState,
    afterState,
    player,
    depth,
    remainingProvenance,
    simulator,
    context,
    collectDiagnostics = false,
    searchBudget = null
  }) {
    const terms = this.materializeValueTerms({
      beforeState,
      afterState,
      action,
      actorId:player.id,
      depth,
      remainingProvenance,
      simulator,
      context,
      searchBudget
    });
    if (terms === null) return null;
    const beforeLightningOutcomeSets = simulator.buildLightningOutcomeSets(beforeState);
    const afterLightningOutcomeSets = simulator.buildLightningOutcomeSets(afterState);
    const resolutionScale = this.getResolutionScale(
      action,
      beforeState,
      player.id,
      simulator
    );
    const baseTerms = this.evaluator.evaluateTransition({
      action,
      player,
      beforeState,
      afterState,
      depth,
      resolutionScale,
      materializedTransitionOptionPoints:terms.adaptiveInformationOptionPoints ?? 0,
      beforeLightningOutcomeSets,
      afterLightningOutcomeSets
    });
    let nextEnergyStateDelta = null;
    if (Number.isFinite(baseTerms.xSkillNextEnergy)) {
      const currentEnergy = Math.max(
        0,
        Number(beforeState.players.find((entry) => entry.id === player.id)?.energy) || 0
      );
      if (baseTerms.xSkillNextEnergy === currentEnergy) {
        nextEnergyStateDelta = baseTerms.stateDelta;
      } else {
        searchBudget?.observeSimulation();
        // 反事实与当前候选共用同一 before World，只替换该技能结算时的能量。
        const counterfactualBefore = simulator.clone(beforeState);
        const counterfactualActor = counterfactualBefore.players.find(
          (entry) => entry.id === player.id
        );
        counterfactualActor.energy = baseTerms.xSkillNextEnergy;
        const counterfactualAfter = simulator.apply(counterfactualBefore, action);
        if (this.isInterrupted(searchBudget)) return null;
        nextEnergyStateDelta = this.evaluator.transitionDelta(
          counterfactualBefore,
          counterfactualAfter,
          player.id,
          simulator.buildLightningOutcomeSets(counterfactualBefore),
          simulator.buildLightningOutcomeSets(counterfactualAfter)
        );
        searchBudget?.observeCounterfactual(2);
      }
    }
    const responseAttributions = collectDiagnostics
      ? this.evaluateResponseAttributions(
          beforeState,
          action,
          afterState,
          player.id,
          simulator
        )
      : [];
    const candidateLedger = collectDiagnostics
      ? this.evaluator.computeCandidateLedger(
          beforeState,
          action,
          afterState,
          player.id,
          true,
          beforeLightningOutcomeSets,
          afterLightningOutcomeSets,
          responseAttributions
        )
      : null;
    const responseNet = (candidateLedger?.responses ?? [])
      .reduce((sum, response) => sum + (response.netValue ?? 0), 0);
    const terminal = Boolean(afterState.playPhaseEnded);
    const frontierResidual = terminal
      ? this.evaluator.frontierResidual(afterState, player.id)
      : null;
    const frontierValue = this.evaluator.terminalFrontierValue(frontierResidual, terminal);
    const lightningOutcomeWorlds = this.evaluator.requiresActionLightningOutcomes(action)
      ? simulator.buildLightningOutcomeWorlds(
          beforeState,
          beforeState.players.find((entry) => entry.id === player.id) ?? player,
          1
        )
      : [];
    const searchPrior = this.evaluator.composeSearchPrior({
      action,
      player,
      state:beforeState,
      lightningOutcomeWorlds,
      searchBudget,
      hiddenWorlds:this.evaluator.requiresHiddenWorldPrior(action)
        ? this.getUnknownHandEstimate(context).worlds
        : [],
      exposeMarginal:terms.exposeMarginal,
      assaultStacksCredit:terms.assaultStacksCredit
    });
    const { domainPrior, searchCredit, prior } = searchPrior;
    return {
      action,
      state:afterState,
      comparisonTerms:this.evaluator.resourceSelectionPreference?.(
        action,
        player,
        beforeState,
        afterState
      ) ?? null,
      terminal,
      baseTerms,
      nextEnergyStateDelta,
      baseTransition:baseTerms.baseTransition,
      exposeMarginal:terms.exposeMarginal,
      assaultStacksCredit:terms.assaultStacksCredit,
      remainingProvenance:terms.nextProvenance,
      candidateLedger,
      responseNet,
      frontierResidual,
      frontierValue,
      domainPrior,
      searchCredit,
      prior,
      transitionValue:null
    };
  }

  /*
  功能
  让 Evaluator 为同层完整候选组合唯一 Final Utility。

  调用方
  根、root safety 与深层 sibling materialization 完成点。

  输入
  已物化候选数组与同 parent 的完整 legal Action 集合。

  输出
  同一数组。

  读取状态
  候选命名 value terms 与 X 技能已结算的 E+1 StateDelta。

  写入状态
  只写候选 transitionValue；任一 sibling 不完整时 END 保持 null。

  调用函数
  Evaluator.endOpportunityPoints、composeTransitionValue。

  边界与不变量
  Searcher 只确认全部 sibling 完整并提供同 parent 的完整 transition terms；
  普通/X skill state-value opportunity、discard relief、END opportunity 与 Final Utility 公式全部由 Evaluator 聚合；
  partial sibling 集合不得给 END 赋值，responseNet 只作诊断。
  */
  finalizeCandidates(candidates, siblingActions = candidates.map((entry) => entry.action)) {
    const siblingContextComplete = siblingActions.every((siblingAction) => (
      candidates.some((candidate) => candidate.action === siblingAction)
    ));
    const siblingTransitionTerms = candidates.map((candidate) => ({
      actionType:candidate.action?.type ?? null,
      transitionTerms:candidate.baseTerms,
      nextEnergyStateDelta:candidate.nextEnergyStateDelta
    }));
    for (const candidate of candidates) {
      if (candidate.action?.type === "end" && !siblingContextComplete) {
        candidate.transitionValue = null;
        continue;
      }
      const endOpportunityPoints = candidate.action?.type === "end"
        ? this.evaluator.endOpportunityPoints(
            candidate.baseTerms,
            siblingTransitionTerms
          )
        : 0;
      candidate.transitionValue = this.evaluator.composeTransitionValue({
        baseTransition:candidate.baseTransition,
        frontierValue:candidate.frontierValue,
        endOpportunityPoints
      });
    }
    return candidates;
  }

  /*
  功能
  构造根候选的稳定诊断条目。

  调用方
  search diagnostics path。

  输入
  含 Evaluator 诊断 的完整候选。

  输出
  canonical Action、投影、响应与 frontier 数值。

  读取状态
  candidateLedger。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只在 diagnostics 开启时调用，不参与评分。
  */
  diagnosticEntry(candidate) {
    return {
      action:candidate.action,
      projected:candidate.candidateLedger.projected,
      responses:candidate.candidateLedger.responses,
      responseNet:candidate.responseNet,
      frontierValue:candidate.frontierValue
    };
  }

  /*
  功能
  截断 canonical Action 序列中 end 之后不会执行的尾部。

  调用方
  recordResult。

  输入
  canonical Action 序列。

  输出
  新的截断数组。

  读取状态
  Action.type。

  写入状态
  无。

  调用函数
  Array.findIndex/slice。

  边界与不变量
  首个 end 保留；不投影、不复制 Action，也不重建 selection。
  */
  describeSequence(sequence) {
    const terminalIndex = sequence.findIndex((action) => action?.type === "end");
    return terminalIndex >= 0 ? sequence.slice(0, terminalIndex + 1) : [...sequence];
  }

  /*
  功能
  在单一原子边界内执行候选 apply/materialize，并统一丢弃 cooperative interruption 的 partial work。

  调用方
  search 的根、根安全与深层候选循环。

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
  只有完整 candidate 才标记 completed；任何 partial World/world 都随异常栈回退且不得进入 best-seen。
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
  search 的 progressive depth-2 缓存、spine 与常规深层展开。

  输入
  父节点、完整子候选与当前深度。

  输出
  继承根动作、累计价值、序列、provenance 与纯调度 Pattern metadata 的完整搜索节点。

  读取状态
  Searcher 的 pruneScore mechanics、父/子候选字段与父节点 Pattern prefix。

  写入状态
  无。

  调用函数
  pruneScore、advancePatternState。

  边界与不变量
  只连接已经完整物化并完成 sibling terms 的候选；Pattern metadata 不得登记 partial state 或改变 final value。
  */
  buildChildNode(node, candidate, depth) {
    const valueScore = node.valueScore + candidate.transitionValue;
    const patternState = this.advancePatternState(
      node.activePatternProposals,
      candidate.action,
      depth - 1,
      node.completedPatternIds,
      node.state
    );
    return {
      action:node.action,
      state:candidate.state,
      comparisonTerms:node.comparisonTerms ?? null,
      terminal:candidate.terminal,
      valueScore,
      pruneScore:this.pruneScore(valueScore, candidate.prior, depth),
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
  尚在匹配的 proposals、当前动作、零基 step 索引、此前已完成的 Pattern IDs 与动作生成时的 World。

  输出
  仍可继续的 proposals、本步新完成 proposals 和继承后的完成 Pattern IDs。

  读取状态
  Pattern 的 exact/selector step contract 与只读 World assertions。

  写入状态
  无。

  调用函数
  Pattern.matchesStep。

  边界与不变量
  metadata 不进入 value/prune score；只有当前完整节点动作匹配完整 proposal step 时才可完成 Pattern。
  */
  advancePatternState(
    proposals,
    action,
    stepIndex,
    completedPatternIds = [],
    state = null
  ) {
    const matched = (proposals ?? []).filter(
      (proposal) => this.patternMatcher.matchesStep(proposal, stepIndex, action, state)
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
  把 Pattern-guided roots 与既有 搜索先验 root 顺序进行公平交错。

  调用方
  search 的 root scheduling 阶段。

  输入
  已去重合法 roots、行动者、根 World 与有界 proposals。

  输出
  最多提升一个最高优先级 guided root，其余 roots 保持现有 搜索先验 顺序。

  读取状态
  搜索先验 score 与 canonical Action keys。

  写入状态
  无。

  调用函数
  schedulingScore、actionIntentKey、actionSearchKey。

  边界与不变量
  空 proposal 必须严格保留既有顺序；Pattern 只有一个正向提升位，其他 proposals 不得挤占 ordinary coverage。
  */
  scheduleRootActions(actions, player, state, proposals = []) {
    const scheduled = (actions ?? []).map((action) => ({
      action,
      score:this.schedulingScore(action, player, state),
      key:actionIntentKey(action),
      secondaryKey:actionSearchKey(action)
    })).sort((left, right) => {
      if (left.score !== right.score) return left.score > right.score ? -1 : 1;
      const intentOrder = left.key.localeCompare(right.key);
      if (intentOrder !== 0) return intentOrder;
      return left.secondaryKey.localeCompare(right.secondaryKey);
    });
    if (!proposals.length) return scheduled.map((entry) => entry.action);
    let promotedEntry = null;
    for (const proposal of proposals) {
      promotedEntry = scheduled.find(
        (entry) => this.patternMatcher.matchesStep(proposal, 0, entry.action, state)
      ) ?? null;
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
  在昂贵深层物化前按现有 搜索先验 与 semantic key 稳定排列 legal children。

  调用方
  materializeChildCandidates。

  输入
  当前合法动作、行动者、生成这些动作的 post-state、按优先级排列的 canonical Pattern proposals，
  以及当前零基 step index。

  输出
  guided intent 优先、其余动作按现有 搜索先验/coarse intent/search-semantic secondary key 排列的新数组。

  读取状态
  搜索先验 score 与 canonical Action keys。

  写入状态
  无。

  调用函数
  schedulingScore、actionIntentKey、actionSearchKey。

  边界与不变量
  只改变探索顺序，不改变合法集合、Final Utility 或 incumbent 规则；
  guided 与普通同分都不得读取 hand index 或 card instance ID；同 intent 的执行分支必须稳定排序。
  */
  scheduleChildActions(actions, player, state, proposals = [], stepIndex = 0) {
    return (actions ?? []).map((action) => ({
      action,
      score:this.schedulingScore(action, player, state),
      key:actionIntentKey(action),
      guidedRank:proposals.findIndex((proposal) => (
        this.patternMatcher.matchesStep(proposal, stepIndex, action, state)
      )),
      secondaryKey:actionSearchKey(action)
    })).sort((left, right) => {
      const leftRank = left.guidedRank >= 0
        ? left.guidedRank
        : Number.POSITIVE_INFINITY;
      const rightRank = right.guidedRank >= 0
        ? right.guidedRank
        : Number.POSITIVE_INFINITY;
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
  search 在完整 root/child node 建立后。

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
  用注入的 Evaluator comparator 比较一个完整节点并同步工作诊断。

  调用方
  search 的 root、progressive 与 beam 完整节点登记点。

  输入
  当前 incumbent、完整节点和本次搜索工作诊断。

  输出
  Evaluator comparator 选择后的唯一 incumbent。

  读取状态
  节点 valueScore、完成工作计数与 Pattern 完成 metadata。

  写入状态
  incumbent 及 Pattern incumbent 更新计数。

  调用函数
  bestCandidate。

  边界与不变量
  Pattern metadata 不参与比较；只有完整 Pattern node 按既有 valueScore 真正推翻 incumbent 时才记录更新。
  */
  considerIncumbent(bestSeenCandidate, node, workDiagnostics) {
    const nextBest = this.bestCandidate(
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
  search 的逐深度 progressive traversal。

  输入
  当前完整 beam nodes。

  输出
  最高 proposal explorationPriority 的可继续节点；没有 guidance 时返回既有 value best。

  读取状态
  节点 activePatternProposals 与 Evaluator comparator。

  写入状态
  无。

  调用函数
  bestCandidate。

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
    return guided[0]?.node ?? this.bestCandidate(available);
  }

  /*
  功能
  从一个完整父状态生成并原子物化当前深度的全部直接子候选。

  调用方
  search 的最高调度 root 预展开、progressive spine 与常规 beam 展开。

  输入
  父状态/provenance、深度、行动者、Simulator、SearchBudget、搜索上下文、结构、
  当前 Pattern proposals、是否只推进可解析 guided step、可选的同父 expansion cache、
  单次新增上限和工作诊断。

  输出
  可恢复 expansion cache，以及会话是否在 yield 时取消。

  读取状态
  注入的深层动作生成、Evaluator、Searcher 反事实项、SearchBudget 与 yieldControl。

  写入状态
  SearchBudget 工作计数、搜索上下文诊断与 workDiagnostics 深度/分支/Pattern 中断计数。

  调用函数
  generateActions、scheduleChildActions、prepareCandidate、Simulator.apply、
  evaluateCandidate、finalizeCandidates、yieldControl。

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
    const resumedCandidates = [...(resumeExpansion?.candidates ?? [])];
    let followActions;
    try {
      followActions = resumeExpansion?.actions ?? this.scheduleChildActions(
        this.generateActions(parentState, player.id, budget),
        player,
        parentState,
        activePatternProposals,
        depth - 1
      );
    } catch (error) {
      if (!budget.isCurrentWorkInterruption?.(error)) throw error;
      // 深层 Generator 与 candidate preparation 使用同一 cooperative abort 语义；
      // 中断只能丢弃当前未完成 child，不能把已经完成的 root incumbent 升级成 Worker fault。
      workDiagnostics.abortedCandidateCount += 1;
      return {
        actions:resumeExpansion?.actions ?? [],
        candidates:resumedCandidates,
        completeCandidateCount:resumedCandidates.filter(
          (candidate) => candidate.transitionValue !== null
        ).length,
        nextActionIndex:resumeExpansion?.nextActionIndex ?? 0,
        complete:false,
        cancelled:false
      };
    }
    if (!resumeExpansion) workDiagnostics.childBranches += followActions.length;
    if (!resumeExpansion) {
      for (const proposal of activePatternProposals) {
        const resolvable = followActions.some(
          (action) => this.patternMatcher.matchesStep(
            proposal,
            depth - 1,
            action,
            parentState
          )
        );
        if (resolvable
          || workDiagnostics.completedPatternProposalKeys.has(proposal.semanticKey)
          || workDiagnostics.abortedPatternProposalKeys.has(proposal.semanticKey)) continue;
        workDiagnostics.abortedPatternProposalKeys.add(proposal.semanticKey);
        workDiagnostics.abortedPatternCount += 1;
      }
    }
    const candidates = resumedCandidates;
    let nextActionIndex = resumeExpansion?.nextActionIndex ?? 0;
    let newCandidateCount = 0;
    const requestedCandidateLimit = Number.isFinite(maxNewCandidates)
      ? Math.max(0, Math.floor(maxNewCandidates))
      : Number.POSITIVE_INFINITY;
    const firstAction = followActions[nextActionIndex] ?? null;
    const firstActionMatchesGuidance = firstAction !== null
      && activePatternProposals.some((proposal) => this.patternMatcher.matchesStep(
        proposal,
        depth - 1,
        firstAction,
        parentState
      ));
    const candidateLimit = guidedContinuationOnly
      && !firstActionMatchesGuidance
      ? 0
      : requestedCandidateLimit;
    while (nextActionIndex < followActions.length && newCandidateCount < candidateLimit) {
      if (budget.shouldStop()) break;
      const action = followActions[nextActionIndex];
      const prepared = this.prepareCandidate(budget, depth, () => {
        budget.observeSimulation();
        const state = simulator.apply(parentState, action);
        const candidate = this.evaluateCandidate({
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
        for (const proposal of activePatternProposals) {
          if (!this.patternMatcher.matchesStep(
            proposal,
            depth - 1,
            action,
            parentState
          )
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
    this.finalizeCandidates(candidates, followActions);
    const completeCandidateCount = candidates.filter(
      (candidate) => candidate.transitionValue !== null
    ).length;
    const previousCompleteCandidateCount = resumeExpansion?.completeCandidateCount ?? 0;
    const newlyCompletedCandidateCount = Math.max(
      0,
      completeCandidateCount - previousCompleteCandidateCount
    );
    workDiagnostics.completedChildCandidateCount += newlyCompletedCandidateCount;
    if (newlyCompletedCandidateCount > 0) {
      workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, depth);
      if (depth === 2) {
        const firstComplete = candidates.find((candidate) => candidate.transitionValue !== null);
        workDiagnostics.firstDepth2AtWorkCount ??= firstComplete?.completedAtWorkCount ?? null;
      }
    }
    return {
      actions:followActions,
      candidates,
      completeCandidateCount,
      nextActionIndex,
      complete:nextActionIndex >= followActions.length,
      cancelled:false
    };
  }

  /*
  功能
  统一记录完成、预算中断或取消后的最优搜索序列与搜索诊断。

  调用方
  search 的正常收束和 yield 取消路径。

  输入
  SearchBudget、结构配置、完整候选、provisional root、context、根诊断条目与本次搜索工作诊断。

  输出
  返回完整候选动作；TIME/NODE 零完整 root 时返回明确标记的 provisional root；
  CANCELLED 已有完整 incumbent 时保留该动作，否则返回 null。

  读取状态
  budget 计数、候选序列、root/work diagnostics 与 bounded counterfactual context diagnostics。

  写入状态
  lastSequence 与 lastSearchStats。

  调用函数
  describeSequence、SearchBudget.diagnostics。

  边界与不变量
  统计只描述已完成的搜索工作；provisional root 不得写入 bestSequence、best value 或完整候选计数。
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
      ? provisionalRootFallback
      : null;
    this.lastSequence = this.describeSequence(
      [...(choice?.sequence ?? [])]
    );
    const hiddenSamples = context.unknownHandEstimate?.sampleCount ?? 0;
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
      hiddenSamples,
      bestSequence:this.lastSequence,
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
      ?? null;
  }

  /*
  功能
  在固定时间或节点预算内执行有限深度束搜索并选择根动作。

  调用方
  Controller.selectAction 与搜索回归测试。

  输入
  行动者、根 World、根候选动作与可选会话/诊断上下文。

  输出
  当前最佳完整根动作；TIME/NODE 零完整 root 时返回不受 Pattern promotion 影响的合法 provisional root；
  CANCELLED 只保留中断前已完整物化的 incumbent。

  读取状态
  World、Pattern proposal、显式搜索归属模块、动作生成、预算与会话能力。

  写入状态
  lastSearchStats、lastSequence 与注入能力的既有随机/让步序列。

  调用函数
  Pattern.match、simulatorFactory、searchBudgetFactory、Searcher candidate scheduling/evaluation、
  Searcher mechanics、generate、yieldControl。

  边界与不变量
  root 在昂贵物化前按 搜索先验 廉价分数和稳定语义键排序，不得依赖 card instance ID 或 hand index；
  Pattern 只可正向安排 guided root/continuation，ordinary challenger 必须先获得 root coverage；
  每个 continuation 从当前 post-state legal actions 解析，Pattern metadata 不进入 value 或 final incumbent rule；
  progressive 只缓存完整子候选；常规逐层 beam 必须复用或补齐原有展开，COMPLETE 仍只从标准 final beam 选择；
  一个候选完整物化并完成同层转移项后，才可登记为 best-seen candidate；未物化动作不得伪装成完整 incumbent；
  TIME/NODE 零完整 root 时，结束不会强制弃牌则优先返回合法 terminal；已知会强制弃牌时才退回基础调度首个 non-end；
  Pattern promotion 不得把未完整物化的 guided root 变成实际选择；provisional fallback 不登记成 candidate/计划；
  根层已物化 end 可作为安全基线；未物化 end 只有在所有 non-end roots 都已比较且全为负时才能补算。
  NODE/TIME 中断后只返回已完整物化的 incumbent，不再启动剩余 root 或 END 的安全补评估；
  CANCELLED 同样不得清空已有完整 incumbent；外部 session/state acceptance 仍由 Controller 决定是否可执行；
  TIME 只返回 deadline 前已经完整 materialize 的 incumbent，绝不启动未物化 root；
  TIME 下任何进入隐藏世界、后续候选或 paired simulation 的 root 必须 cooperative abort，
  安全阶段不得继续束搜索、深层扩展或随机选择。
  */
  async search(player, world, rootActions, options = {}) {
    this.comparisonActor = player;
    this.comparisonWorld = world;
    this.lastSequence = [];
    const collectDiagnostics = Boolean(options.collectAiDecisionDiagnostics);
    const budget = this.searchBudgetFactory();
    const structure = this.structure();
    const uniqueRootActions = this.deduplicateActions(rootActions);
    const patternMatch = this.patternMatcher.match({
      player,
      state:world,
      legalActions:uniqueRootActions,
      structure
    });
    const patternProposals = patternMatch.proposals ?? [];
    const ordinaryRootActions = this.scheduleRootActions(
      uniqueRootActions,
      player,
      world
    );
    const scheduledRootActions = this.scheduleRootActions(
      uniqueRootActions,
      player,
      world,
      patternProposals
    );
    const rootTerminalAction = ordinaryRootActions.find((action) => action?.type === "end");
    const visiblePlayer = world.players?.find((entry) => entry.id === player.id) ?? player;
    const visibleHandCount = Number(
      visiblePlayer.handCount ?? visiblePlayer.hand?.length ?? player.hand?.length ?? 0
    );
    const terminalForcesDiscard = visibleHandCount > Math.max(0, Number(visiblePlayer.hp) || 0);
    const ordinaryNonTerminalFallback = ordinaryRootActions.find(
      (action) => action?.type !== "end"
    );
    const provisionalRootFallback = terminalForcesDiscard
      ? ordinaryNonTerminalFallback ?? rootTerminalAction
      : rootTerminalAction ?? ordinaryNonTerminalFallback
      ?? null;
    const context = this.createContext(
      player,
      world
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
        (action) => action
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
      simulator = this.simulatorFactory({ searchBudget:budget });
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
      const rootDescriptor = action;
      const rootWorkStarted = budget.simulationCalls;
      workDiagnostics.activeRoot = rootDescriptor;
      budget.observeRootCandidateStarted?.();
      const prepared = this.prepareCandidate(budget, 1, () => {
        budget.observeSimulation();
        const state = simulator.apply(world, action);
        const candidate = this.evaluateCandidate({
          action,
          beforeState:world,
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
      this.finalizeCandidates(rootCandidates, scheduledRootActions);
      workDiagnostics.completedRootCandidateCount = rootCandidates.filter(
        (entry) => entry.transitionValue !== null
      ).length;
      if (workDiagnostics.completedRootCandidateCount > 0) {
        workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, 1);
      }
      workDiagnostics.activeRoot = null;
      workDiagnostics.rootWork.push({
        action:rootDescriptor,
        completed:candidate.transitionValue !== null,
        simulatorTransitions:budget.simulationCalls - rootWorkStarted
      });
      if (!progressiveDepth2Expansions.size
        && structure.depth >= 2
        && workDiagnostics.completedRootCandidateCount === earlyProgressiveRootCoverage
        && !budget.shouldStop()) {
        const progressiveRoot = rootCandidates.find((entry) => !entry.terminal);
        if (!progressiveRoot) continue;
        const rootPatternState = this.advancePatternState(
          patternProposals,
          progressiveRoot.action,
          0,
          [],
          world
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
            choice:this.bestCandidate(this.buildRootNodes(
              rootCandidates,
              patternProposals,
              world
            )),
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
            choice:this.bestCandidate(this.buildRootNodes(
              rootCandidates,
              patternProposals,
              world
            )),
            provisionalRootFallback,
            context,
            rootLedgers,
            workDiagnostics
          });
        }
      }
    }

    // 同层转移项是 SearchNode 最终价值的一部分；完成它之后候选才具备 best-seen 资格。
    this.finalizeCandidates(rootCandidates, scheduledRootActions);
    const initiallyMaterializedRootActions = new Set(
      rootCandidates.map((candidate) => candidate.action)
    );
    const unmaterializedNonTerminalRoots = scheduledRootActions.filter((action) => (
      action?.type !== "end"
      && !initiallyMaterializedRootActions.has(action)
    ));
    const unmaterializedRootTerminal = rootTerminalAction
      && !initiallyMaterializedRootActions.has(rootTerminalAction);
    const materializedNonTerminalRoots = rootCandidates
      .filter((candidate) => candidate.action?.type !== "end");
    const bestMaterializedNonTerminal = this.bestCandidate(
      materializedNonTerminalRoots
    );
    const remainingRootSafetyCount = unmaterializedNonTerminalRoots.length
      + (unmaterializedRootTerminal ? 1 : 0);
    const unresolvedRootTerminal = rootCandidates.some((candidate) => (
      candidate.action?.type === "end" && candidate.transitionValue === null
    ));
    const rootSafetyNeeded = !unresolvedRootTerminal && ((
      unmaterializedNonTerminalRoots.length > 0
        && !(bestMaterializedNonTerminal?.transitionValue >= 0)
    ) || (
      unmaterializedRootTerminal
        && bestMaterializedNonTerminal?.transitionValue < 0
    ));
    const rootSafetyCompletionGranted = budget.stopReason === null
      && rootSafetyNeeded
      && remainingRootSafetyCount > 0
      && typeof budget.requestRootSafetyCompletion === "function"
      && budget.requestRootSafetyCompletion({
        depth:1,
        candidateCount:remainingRootSafetyCount
      });
    if (rootSafetyCompletionGranted) {
      // SearchBudget 冻结当前剩余根数并逐个授权；Searcher 只编排已授权的
      // depth-1 物化，不建立新 beam、深层循环或采样上下文。
      for (const action of unmaterializedNonTerminalRoots) {
        if (!budget.beginRootSafetyCandidate?.(1)) break;
        const rootDescriptor = action;
        const rootWorkStarted = budget.simulationCalls;
        workDiagnostics.activeRoot = rootDescriptor;
        budget.observeRootCandidateStarted?.();
        const prepared = this.prepareCandidate(budget, 1, () => {
          budget.observeSimulation();
          const state = simulator.apply(world, action);
          const candidate = this.evaluateCandidate({
            action,
            beforeState:world,
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
        this.finalizeCandidates(rootCandidates, scheduledRootActions);
        workDiagnostics.completedRootCandidateCount = rootCandidates.filter(
          (entry) => entry.transitionValue !== null
        ).length;
        if (workDiagnostics.completedRootCandidateCount > 0) {
          workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, 1);
        }
        workDiagnostics.activeRoot = null;
        workDiagnostics.rootWork.push({
          action:rootDescriptor,
          completed:candidate.transitionValue !== null,
          simulatorTransitions:budget.simulationCalls - rootWorkStarted
        });
      }
      this.finalizeCandidates(rootCandidates, scheduledRootActions);
    }
    for (const rootWork of workDiagnostics.rootWork) {
      const materialized = rootCandidates.find((candidate) => candidate.action === rootWork.action);
      if (materialized) rootWork.completed = materialized.transitionValue !== null;
    }
    workDiagnostics.completedRootCandidateCount = rootCandidates.filter(
      (candidate) => candidate.transitionValue !== null
    ).length;
    if (collectDiagnostics) {
      rootLedgers.push(...rootCandidates
        .filter((candidate) => candidate.transitionValue !== null)
        .map((candidate) => this.diagnosticEntry(candidate)));
    }
    const beam = this.buildRootNodes(rootCandidates, patternProposals, world);
    for (const node of beam) this.observeCompletedPatterns(node, workDiagnostics);
    let activeBeam = this.prune(beam, structure.beamWidth);
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
      const childNodes = expansion.candidates
        .filter((candidate) => candidate.transitionValue !== null)
        .map(
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
      workDiagnostics.activeRoot = progressiveSpine.action;
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
        childNodes = childCandidates
          .filter((candidate) => candidate.transitionValue !== null)
          .map(
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
        workDiagnostics.activeRoot = node.action;
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
        const previousChildNodeCount = cachedExpansion?.childNodes.length ?? 0;
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
            choice:bestSeenCandidate,
            provisionalRootFallback,
            context,
            rootLedgers,
            workDiagnostics
          });
        }
        const childNodes = [
          ...(cachedExpansion?.childNodes ?? []),
          ...expansion.candidates
            .slice(previousCandidateCount)
            .filter((candidate) => candidate.transitionValue !== null)
            .map((candidate) => this.buildChildNode(node, candidate, depth))
        ];
        depthCache.set(node, { ...expansion, childNodes });
        candidates.push(...childNodes);
        for (let index = previousChildNodeCount; index < childNodes.length; index += 1) {
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
      activeBeam = this.prune(candidates, structure.beamWidth);
    }

    budget.complete();
    const materializedRootActions = new Set(rootCandidates.map((candidate) => candidate.action));
    let choice = this.selectFinal({
      stopReason:budget.stopReason,
      completedCandidates:activeBeam,
      bestSeenCandidate
    });

    // 已物化 end 可在任何停止原因下比较；未物化 end 只有在全部 non-end
    // 根动作都已物化后才能恢复，不得越过同样未比较的 card/skill sibling。
    if (rootTerminalAction) {
      const allNonTerminalRootsMaterialized = scheduledRootActions.every((action) => (
        action?.type === "end"
        || materializedRootActions.has(action)
      ));
      const allMaterializedNonTerminalRootsNegative = rootCandidates
        .filter((candidate) => candidate.action?.type !== "end")
        .every((candidate) => candidate.transitionValue < 0);
      const terminalInFinalBeam = activeBeam.find(
        (node) => node.action?.type === "end"
      );
      const materializedRootTerminal = budget.stopReason === "COMPLETE"
        ? null
        : beam.find(
            (node) => node.action?.type === "end"
          );
      let terminalChoice = terminalInFinalBeam ?? materializedRootTerminal;
      if (!terminalChoice && allNonTerminalRootsMaterialized
        && allMaterializedNonTerminalRootsNegative
        && rootSafetyCompletionGranted
        && budget.beginRootSafetyCandidate?.(1)) {
        const rootDescriptor = rootTerminalAction;
        const rootWorkStarted = budget.simulationCalls;
        workDiagnostics.activeRoot = rootDescriptor;
        budget.observeRootCandidateStarted?.();
        const prepared = this.prepareCandidate(budget, 1, () => {
          budget.observeSimulation();
          const state = simulator.apply(
            world,
            rootTerminalAction
          );
          const candidate = this.evaluateCandidate({
            action:rootTerminalAction,
            beforeState:world,
            afterState:state,
            player,
            depth:1,
            remainingProvenance:context.rootProvenance,
            simulator,
            context,
            collectDiagnostics:false,
            searchBudget:budget
          });
          if (candidate) this.finalizeCandidates(
            [...rootCandidates, candidate],
            scheduledRootActions
          );
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
      const bestFinalChoice = terminalChoice
        ? this.bestCandidate([choice, terminalChoice].filter(Boolean))
        : choice;
      if (terminalChoice && bestFinalChoice === terminalChoice && choice !== terminalChoice) {
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

  /*
  功能
  在昂贵反事实的原子工作边界查询 cooperative search abort。

  调用方
  后续动作、隐藏世界、破势配对模拟循环。

  输入
  可选 SearchBudget。

  输出
  TIME/NODE/CANCELLED 要求当前工作回退时返回 true。

  读取状态
  SearchBudget stop reason、时间或节点状态。

  写入状态
  尚未停止时可由 SearchBudget 首次观察并写入停止原因。

  调用函数
  SearchBudget.shouldAbortCurrentWork/shouldStop。

  边界与不变量
  无预算的直接价值测试保持完整计算；本模块不自行解释预算数值或修改候选价值。
  */
  isInterrupted(searchBudget) {
    if (!searchBudget) return false;
    if (typeof searchBudget.shouldAbortCurrentWork === "function") {
      return searchBudget.shouldAbortCurrentWork();
    }
    return typeof searchBudget.shouldStop === "function" && searchBudget.shouldStop();
  }

  /*
  功能
  在第一个真实隐藏牌查询点惰性创建并复用本次 calculation 的匿名手牌样本。

  调用方
  Evaluator 声明需要 hidden Worlds 的 generic value-input orchestration。

  输入
  当前搜索领域 context。

  输出
  显式 MONTE_CARLO_ESTIMATE 契约。

  读取状态
  context 当前 ProbabilityState、过滤玩家与注入采样能力。

  写入状态
  只写 context.unknownHandEstimate 计算缓存。

  调用函数
  sampleUnknownHands。

  边界与不变量
  缓存生命周期只覆盖一次 plan；不得进入 World、ProbabilityState 或跨决策持久树。
  */
  getUnknownHandEstimate(context) {
    if (!context.unknownHandEstimate) {
      const estimate = this.sampleUnknownHands({
        viewerId:context.viewer.id,
        probabilityState:context.probabilityState,
        players:context.probabilityPlayers,
        sampleCount:this.hiddenSampleCount
      });
      if (estimate?.classification !== PROBABILITY_CLASSIFICATION.MONTE_CARLO_ESTIMATE
        || !Array.isArray(estimate.worlds)
        || estimate.sampleCount !== estimate.worlds.length) {
        throw new TypeError("匿名手牌采样必须返回显式 MONTE CARLO ESTIMATE 契约");
      }
      context.unknownHandEstimate = estimate;
    }
    return context.unknownHandEstimate;
  }

  /*
  功能
  枚举一个状态的后续合法候选并返回其中最高的状态效用。

  调用方
  evaluateAdaptiveInformationValue。

  输入
  World、viewer ID、复用 Simulator 与可选搜索预算。

  输出
  最佳后续状态效用；没有候选时返回当前状态效用。

  读取状态
  generate、Simulator.apply 与 evaluator.stateUtility。

  写入状态
  只写 Simulator 返回的独立后续状态。

  调用函数
  generate、simulator.apply、evaluator.stateUtility。

  边界与不变量
  每个候选从同一输入状态独立模拟；end 候选保持生成顺序参与同分；
  nested State Value 查询继承同一 SearchBudget。
  */
  bestFollowUpUtility(state, actorId, simulator, searchBudget = null) {
    if (this.isInterrupted(searchBudget)) return null;
    const candidates = this.generateActions(state, actorId, searchBudget);
    let best = -Infinity;
    for (const candidate of candidates) {
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeSimulation();
      const after = simulator.apply(state, candidate);
      if (this.isInterrupted(searchBudget)) return null;
      const utility = this.evaluator.stateUtility(
        after,
        actorId,
        simulator.buildLightningOutcomeSets(after)
      );
      if (utility > best) best = utility;
    }
    if (this.isInterrupted(searchBudget)) return null;
    return Number.isFinite(best)
      ? best
      : this.evaluator.stateUtility(
          state,
          actorId,
          simulator.buildLightningOutcomeSets(state)
        );
  }

  /*
  功能
  编排一次由 Evaluator 声明的自适应信息价值查询。

  调用方
  materializeValueTerms 的根层信息价值分支。

  输入
  before/after、viewer ID、复用 Simulator、领域 context 与可选搜索预算。

  输出
  Evaluator 返回的非负 raw information option value；无样本或目标缺失时为零。

  读取状态
  context 当前 Probability 查询输入、afterState 后续候选与 Evaluator value requests。

  写入状态
  只写 Simulator 返回的独立世界。

  调用函数
  Evaluator.adaptiveInformationTarget、specializeHiddenWorld、bestFollowUpUtility、
  Evaluator.adaptiveInformationOptionPoints。

  边界与不变量
  Searcher 只执行通用隐藏世界和后续候选遍历；身份识别与 E[max]-max(E) 公式只属于 Evaluator。
  */
  evaluateAdaptiveInformationOptionPoints(beforeState, afterState, action, actorId, simulator, context, searchBudget = null) {
    const targetId = this.evaluator.adaptiveInformationTarget(
      beforeState,
      afterState,
      action,
      actorId
    );
    if (!targetId) return 0;
    const handSamples = this.getUnknownHandEstimate(context).worlds;
    if (!handSamples.length) return 0;
    if (this.isInterrupted(searchBudget)) return null;
    const baselineBest = this.bestFollowUpUtility(afterState, actorId, simulator, searchBudget);
    if (baselineBest === null) return null;
    const informedBestValues = [];
    for (const world of handSamples) {
      if (this.isInterrupted(searchBudget)) return null;
      const specializedBefore = simulator.specializeHiddenWorld(beforeState, world, actorId);
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeSimulation();
      const specializedAfter = simulator.apply(specializedBefore, action);
      if (this.isInterrupted(searchBudget)) return null;
      const informedBest = this.bestFollowUpUtility(
        specializedAfter,
        actorId,
        simulator,
        searchBudget
      );
      if (informedBest === null) return null;
      informedBestValues.push(informedBest);
    }
    return this.evaluator.adaptiveInformationOptionPoints(baselineBest, informedBestValues);
  }

  /*
  功能
  遍历 Evaluator 指定的后续候选并比较 Simulator paired Worlds。

  调用方
  materializeValueTerms 与领域边际测试。

  输入
  动作前后 World、canonical Action、行动者 ID、复用 Simulator 与可选 SearchBudget。

  输出
  Evaluator 返回的最大非负效用增量。

  读取状态
  输入 Worlds、Generator、Simulator 与 Evaluator value requests。

  写入状态
  只写 Simulator 返回的独立反事实状态。

  调用函数
  Evaluator.exposeMarginalStackDelta/realizesExposeMarginal/positiveWorldMarginal、generate、Simulator.apply。

  边界与不变量
  Searcher 不识别具体牌；paired worlds 只改变被测层数，nested value 查询继承同一 SearchBudget。
  */
  evaluateFollowUpMarginal(
    beforeState,
    afterState,
    action,
    actorId,
    simulator,
    searchBudget = null
  ) {
    const addedStacks = this.evaluator.exposeMarginalStackDelta(
      action,
      beforeState,
      afterState,
      actorId
    );
    if (!(addedStacks > 0)) return 0;
    if (this.isInterrupted(searchBudget)) return null;
    const { baselineWorld, boostedWorld } = simulator.buildExposeMarginalWorlds(
      afterState,
      actorId,
      addedStacks
    );
    const candidates = this.generateActions(afterState, actorId, searchBudget);
    let best = 0;
    for (const candidate of candidates) {
      if (!this.evaluator.realizesExposeMarginal(candidate)) continue;
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeSimulation();
      const base = simulator.apply(baselineWorld, candidate);
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeSimulation();
      const boosted = simulator.apply(boostedWorld, candidate);
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeCounterfactual(2);
      const marginal = this.evaluator.positiveWorldMarginal(
        base,
        boosted,
        actorId,
        simulator.buildLightningOutcomeSets(base),
        simulator.buildLightningOutcomeSets(boosted)
      );
      if (marginal > best) best = marginal;
    }
    return best;
  }

  /*
  功能
  为 Evaluator 声明的当前动作 provenance 构造并比较 paired Worlds。

  调用方
  materializeValueTerms 与领域边际测试。

  输入
  当前 World、canonical Action、行动者 ID、剩余 provenance、复用 Simulator 与可选 SearchBudget。

  输出
  Evaluator 返回的非负 provenance 消费信用。

  读取状态
  当前过滤状态、Evaluator value request 与回合开始时的来源记录。

  写入状态
  只写两个独立克隆及 Simulator 返回状态。

  调用函数
  Evaluator.assaultMarginalStackCount/positiveWorldMarginal、Simulator.apply。

  边界与不变量
  Searcher 不识别具体牌；paired worlds 只改变 exposeWeaknessStacks，nested value 查询继承同一 SearchBudget。
  */
  evaluateCurrentActionMarginal(
    currentState,
    action,
    actorId,
    remainingRootExposeStacks,
    simulator,
    searchBudget = null
  ) {
    const marginalStacks = this.evaluator.assaultMarginalStackCount(
      action,
      remainingRootExposeStacks
    );
    if (!(marginalStacks > 0)) return 0;
    if (this.isInterrupted(searchBudget)) return null;
    const { baselineWorld, boostedWorld } = simulator.buildAssaultStackWorlds(
      currentState,
      actorId,
      marginalStacks
    );
    searchBudget?.observeSimulation();
    const boosted = simulator.apply(boostedWorld, action);
    if (this.isInterrupted(searchBudget)) return null;
    searchBudget?.observeSimulation();
    const baseline = simulator.apply(baselineWorld, action);
    if (this.isInterrupted(searchBudget)) return null;
    searchBudget?.observeCounterfactual(2);
    return this.evaluator.positiveWorldMarginal(
      baseline,
      boosted,
      actorId,
      simulator.buildLightningOutcomeSets(baseline),
      simulator.buildLightningOutcomeSets(boosted)
    );
  }

  /*
  功能
  为单个候选物化 Evaluator 请求的领域价值输入与下一节点 provenance。

  调用方
  Searcher.evaluateCandidate。

  输入
  before/after、动作、行动者、搜索深度、回合开始时已有层的来源记录与 Simulator。

  输出
  exposeMarginal、assaultStacksCredit、information value 与 remainingProvenance。

  读取状态
  Evaluator value requests 及配对反事实所需过滤状态。

  写入状态
  仅通过反事实辅助函数写独立状态。

  调用函数
  evaluateFollowUpMarginal、evaluateCurrentActionMarginal、evaluateAdaptiveInformationOptionPoints 与 Evaluator provenance。

  边界与不变量
  Searcher 不读取具体牌或角色 identity；所有业务识别和价值公式都由 Evaluator 返回；
  信息项只在根层物化，避免深层反事实递归枚举隐藏世界。
  */
  materializeValueTerms({
    beforeState,
    afterState,
    action,
    actorId,
    depth,
    remainingProvenance,
    simulator,
    context = null,
    searchBudget = null
  }) {
    const exposeMarginal = this.evaluateFollowUpMarginal(
      beforeState,
      afterState,
      action,
      actorId,
      simulator,
      searchBudget
    );
    if (exposeMarginal === null) return null;
    const assaultStacksCredit = this.evaluateCurrentActionMarginal(
      beforeState,
      action,
      actorId,
      remainingProvenance,
      simulator,
      searchBudget
    );
    if (assaultStacksCredit === null) return null;
    const nextProvenance = this.evaluator.advanceTransitionProvenance(
      action,
      beforeState,
      afterState,
      actorId,
      remainingProvenance
    );
    const adaptiveInformationOptionPoints = depth === 1
      ? this.evaluateAdaptiveInformationOptionPoints(
          beforeState,
          afterState,
          action,
          actorId,
          simulator,
          context,
          searchBudget
        )
      : 0;
    if (adaptiveInformationOptionPoints === null) return null;
    return {
      exposeMarginal,
      assaultStacksCredit,
      adaptiveInformationOptionPoints,
      nextProvenance
    };
  }
}

const DEFAULT_SEARCH_TIME_BUDGET_MS = 900;

// COMPLETE 表示自然完成；TIME/NODE 分别表示时间或完整节点预算耗尽；
// CANCELLED 表示会话让步检测到取消。停止原因只决定收束方式，不修改候选价值。
const SEARCH_STOP_REASON = Object.freeze({
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
  共享搜索组合 与直接预算测试。

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
      : DEFAULT_SEARCH_TIME_BUDGET_MS;
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
  simulation/response/probability work 的普通对象。

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
      responseBranches:this.responseBranches
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
      "responseBranches"
    ]) {
      delta[key] = Math.max(0, (Number(after[key]) || 0) - (Number(before[key]) || 0));
    }
    return delta;
  }

  /*
  功能
  记录一个候选 preparation 开始时的预算时间与工作基线。

  调用方
  Searcher 在 Simulator.apply 前。

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
  同时只允许一个 Searcher candidate preparation；不读取动作或 World。
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
  Searcher 在完整候选登记或 partial work 丢弃前。

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
  signal 只允许由拥有该 SearchBudget 的 Searcher 捕获；不得把 partial action 或 World 登记为候选。
  */
  checkpointCurrentWork() {
    if (!this.shouldAbortCurrentWork()) return true;
    throw this.currentWorkInterruption;
  }

  /*
  功能
  判断异常是否为本次搜索的 cooperative unwind signal。

  调用方
  Searcher candidate preparation boundary。

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
  Searcher 根动作、节点、深度循环的继续边界。

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
  Searcher 反事实项 的隐藏世界、后续动作与配对模拟循环。

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
  Searcher 根候选首轮收束。

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
  Searcher 在每个剩余根动作的 apply 之前。

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
  Searcher 的候选 evaluation 中断路径。

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
  Searcher 在完整候选 evaluation 返回后。

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
  Searcher 主 evaluation 与 Searcher 反事实项 配对模拟。

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
  记录一次完整 World 克隆实际开始执行。

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
  Generator 与 Simulator 的高分支概率工作边界。

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
  记录 Searcher 实际开始 evaluation 一个新的根候选。

  调用方
  Searcher 在每个 root candidate preparation 之前。

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
  本方法只观察 Searcher 已决定开始的 root；不得自行授权 root 或改变 stopReason。
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
  Response 的 card-scope、block 与 target-scope 响应边界。

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
  Searcher 反事实项。

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
  记录动作生成在等价去重前后的候选数。

  调用方
  Generator.generate。

  输入
  一次生成汇总的 physical/unique candidate 数。

  输出
  累计 unique candidate 数。

  读取状态
  当前动作生成诊断计数。

  写入状态
  累加动作生成候选计数。

  调用函数
  无。

  边界与不变量
  只记录已经生成的动作数量，不参与 TIME/NODE、候选合法性、概率或排序；
  Simulator 的局部 transition alternatives 由 probability operation 诊断单独计数。
  */
  observeActionGeneration({
    physicalCandidates = 0,
    uniqueCandidates = 0
  } = {}) {
    const physical = Math.max(0, Number(physicalCandidates) || 0);
    const unique = Math.max(0, Number(uniqueCandidates) || 0);
    this.actionGenerationPhysicalCandidates += physical;
    this.actionGenerationUniqueCandidates += unique;
    return this.actionGenerationUniqueCandidates;
  }

  /*
  功能
  记录 Searcher 为保持界面响应而执行的一次让步。

  调用方
  Searcher yield 边界。

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
  Searcher 收束阶段。

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
  Searcher yieldControl 返回 false 的路径。

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
  Searcher.lastSearchStats 组装与预算测试。

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
