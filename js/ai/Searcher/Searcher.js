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
import {
  assertCompleteTransitionTerms,
  isValidFinalUtility
} from "../Evaluator/Evaluator.js";
import { actionIntentKey, actionSearchKey } from "../Generator/Action.js";

/*
功能
读取只服务搜索性能诊断的单调墙钟。

调用方
Searcher candidate/value/counterfactual 诊断与 SearchBudget operation 诊断。

输入
无。

输出
高精度毫秒时间；不支持 performance 时回退 Date.now。

读取状态
globalThis.performance。

写入状态
无。

调用函数
performance.now、Date.now。

边界与不变量
不得调用注入的预算时钟，避免诊断改变确定性 TIME/NODE 观察次数或搜索选择。
*/
function searchDiagnosticNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/*
功能
验证一次根搜索的 canonical Action 跨层 contract。

调用方
  Searcher.search。

输入
当前行动者，以及 Generator/Controller 提供的 root Actions。

输出
唯一 canonical END；违反 invariant 时抛出 TypeError。

读取状态
只读 player.id 与 Action type/actorId。

写入状态
无。

调用函数
Array.find/filter。

边界与不变量
合法出牌状态必须非空、所有 root 都属于当前行动者，并且恰有一个 canonical END；
这里只验证跨层 contract，不重新定义 Generator legality。
*/
function validateRootActionContract(player, rootActions) {
  if (!Array.isArray(rootActions) || rootActions.length === 0) {
    throw new TypeError("Searcher root invariant 失败：rootActions 必须非空");
  }
  if (!player || typeof player.id !== "string" || !player.id
    || rootActions.some((action) => action?.actorId !== player.id)) {
    throw new TypeError("Searcher root invariant 失败：所有 root Actions 必须属于当前行动者");
  }
  const endActions = rootActions.filter((action) => action?.type === "end");
  if (endActions.length !== 1) {
    throw new TypeError(
      "Searcher root invariant 失败：rootActions 必须且只能包含一个 canonical END"
    );
  }
  return endActions[0];
}

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
    pattern,
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
      pattern
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
    this.candidateTimingCount = 0;
    this.slowestCandidateTimings = [];
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
considerIncumbent 与 prune。

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
  记录一次 candidate 完整或中断物化的纯数字耗时，并只保留最慢条目。

  调用方
  materializeCandidate。

  输入
  canonical Action、深度、完成状态、阶段耗时与工作计数差值。

  输出
  无。

  读取状态
  当前 candidateTimingCount 与最慢条目。

  写入状态
  candidateTimingCount 加一；slowestCandidateTimings 保持最多八项。

  调用函数
  Array.sort/slice、Object.freeze。

  边界与不变量
  只保存 canonical Action 引用和数字，不保存 World；诊断不得影响候选完整性、排序或预算。
  */
  recordCandidateTiming(record) {
    this.candidateTimingCount += 1;
    this.slowestCandidateTimings = [...this.slowestCandidateTimings, Object.freeze(record)]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 8);
  }

  /*
  功能
  把已完成 Final Utility 的根候选转换为可参与 incumbent 收束的根节点。

  调用方
  search 的根 beam 构造。

  输入
  已物化根候选、Pattern proposals 与根 World。

  输出
  根节点数组。

  读取状态
  候选 Final Utility、prior、provenance、diagnostics 与 Pattern 状态。

  写入状态
  无。

  调用函数
  pruneScore、advancePatternState。

  边界与不变量
  输入只允许完整候选；该投影不重新验证或重算价值。
  */
  buildRootNodes(rootCandidates, patternProposals, world) {
    return rootCandidates.map((candidate) => {
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
  记录一个由单一候选边界隔离的 candidate-local fault。

  调用方
  materializeCandidate 与 materializeSiblingCandidates。

  输入
  失败的 canonical Action、故障阶段与原始异常。

  输出
  冻结的 data-only candidate fault diagnostics。

  读取状态
  本次搜索已记录的 candidateFaults。

  写入状态
  仅向本次搜索的 candidateFaults 追加诊断；不修改 SearchBudget stopReason。

  调用函数
  Object.freeze。

  边界与不变量
  只有输入 World 不变且失败候选没有登记的工作才可在此隔离；
  SearchBudget、root set、共享构造与全局搜索结构异常不得走本路径。
  */
  recordCandidateFault(action, stage, error) {
    const fault = Object.freeze({
      action,
      stage,
      name:error instanceof Error ? error.name : "Error",
      message:error instanceof Error ? error.message : String(error)
    });
    this.candidateFaults ??= [];
    this.candidateFaults.push(fault);
    return fault;
  }

  /*
  功能
  执行一次 cooperative yield，并把 false 结果收束为 CANCELLED。

  调用方
  根候选与深层候选完成后的让步边界。

  输入
  当前 SearchBudget 与 gameId。

  输出
  可继续搜索返回 true；取消返回 false；普通异常向 search outer boundary 抛出。

  读取状态
  注入的 yieldControl。

  写入状态
  SearchBudget.stopReason。

  调用函数
  yieldControl、SearchBudget.cancel。

  边界与不变量
  false 是正常 cooperative cancellation；ordinary exception 不在局部转换为正常控制流。
  */
  async continueAfterYield(budget, gameId) {
    if (await this.yieldControl(gameId)) return true;
    budget.cancel();
    return false;
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
  执行并记录一次 Searcher 显式发起的 StateValue 查询。

  调用方
  bestFollowUpUtility。

  输入
  World、viewer ID、已准备的 lightning outcome sets 与可选 SearchBudget。

  输出
  Evaluator.stateUtility 返回的 State points。

  读取状态
  Evaluator 与输入 World。

  写入状态
  只写 SearchBudget stateUtility 计数/耗时。

  调用函数
  Evaluator.stateUtility、SearchBudget.observeStateUtility、searchDiagnosticNow。

  边界与不变量
  诊断时钟不进入值公式；一次调用只计一次，异常仍保留已消耗耗时。
  */
  evaluateStateUtility(state, viewerId, lightningOutcomeSets, searchBudget = null) {
    const startedAt = searchDiagnosticNow();
    try {
      return this.evaluator.stateUtility(state, viewerId, lightningOutcomeSets);
    } finally {
      searchBudget?.observeStateUtility?.(
        Math.max(0, searchDiagnosticNow() - startedAt)
      );
    }
  }

  /*
  功能
  把一次已经模拟完成的 canonical Action 组装为完整可比较搜索候选。

  调用方
  materializeCandidate。

  输入
  动作前后 World、行动者、深度、provenance、Simulator、上下文、诊断开关与 SearchBudget。

  输出
  单一候选估值记录；X 技能另带由 Simulator 构造的同 World E+1 完整 StateDelta。

  读取状态
  Searcher 反事实项、Evaluator 与搜索上下文。

  写入状态
  只写独立候选记录和显式诊断。

  调用函数
  materializeValueTerms、Simulator.buildSkillEnergyCounterfactualWorlds、
  Evaluator.evaluateTransition/transitionDelta/frontierResidual/composeSearchPrior。

  边界与不变量
  Searcher 只机械组装各 owner 的结果；X 技能 World clone、能量替换与技能结算全部归 Simulator，
  Searcher 不写 World、不定义 value formula；调用方必须 finalize 后才能登记候选。
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
    const beforeLightningOutcomeSets = simulator.buildLightningOutcomeSets(beforeState);
    const afterLightningOutcomeSets = simulator.buildLightningOutcomeSets(afterState);
    const resolutionScale = this.getResolutionScale(
      action,
      beforeState,
      player.id,
      simulator
    );
    const baseTerms = assertCompleteTransitionTerms(this.evaluator.evaluateTransition({
      action,
      player,
      beforeState,
      afterState,
      depth,
      resolutionScale,
      materializedTransitionOptionPoints:terms.adaptiveInformationOptionPoints ?? 0,
      beforeLightningOutcomeSets,
      afterLightningOutcomeSets
    }));
    let nextEnergyStateDelta = null;
    if (Number.isFinite(baseTerms.xSkillNextEnergy)) {
      const currentEnergy = Math.max(
        0,
        Number(beforeState.players.find((entry) => entry.id === player.id)?.energy) || 0
      );
      if (baseTerms.xSkillNextEnergy === currentEnergy) {
        nextEnergyStateDelta = baseTerms.stateDelta;
      } else {
        searchBudget?.checkpointCurrentWork?.();
        searchBudget?.observeSimulation();
        const counterfactual = simulator.buildSkillEnergyCounterfactualWorlds(
          beforeState,
          action,
          baseTerms.xSkillNextEnergy
        );
        searchBudget?.checkpointCurrentWork?.();
        const counterfactualStartedAt = searchDiagnosticNow();
        try {
          nextEnergyStateDelta = this.evaluator.transitionDelta(
            counterfactual.beforeWorld,
            counterfactual.afterWorld,
            player.id,
            simulator.buildLightningOutcomeSets(counterfactual.beforeWorld),
            simulator.buildLightningOutcomeSets(counterfactual.afterWorld)
          );
        } finally {
          searchBudget?.observeCounterfactual(
            2,
            Math.max(0, searchDiagnosticNow() - counterfactualStartedAt)
          );
        }
        searchBudget?.checkpointCurrentWork?.();
      }
    }
    const completeTerms = assertCompleteTransitionTerms({
      ...baseTerms,
      nextEnergyStateDelta
    });
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
      baseTerms:completeTerms,
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
      prior
    };
  }

  /*
  功能
  让 Evaluator 为一个已经完整模拟和估值的候选产生唯一 Final Utility。

  调用方
  materializeSiblingCandidates。

  输入
  已物化候选，以及 END 所需的完整 sibling 候选集合。

  输出
  带合法 transitionValue 的完整候选；Evaluator contract 失败时抛错。

  读取状态
  候选命名 value terms 与完整 sibling transition terms。

  写入状态
  无；返回新的完整候选记录。

  调用函数
  Evaluator.endOpportunityPoints、composeTransitionValue、isValidFinalUtility。

  边界与不变量
  Searcher 不定义数值公式；END 只能接收同 parent 的全部完整 sibling terms；
  非法 Final Utility 是当前 candidate fault，不能登记为 complete candidate。
  */
  finalizeCandidate(candidate, siblingCandidates = []) {
    const endOpportunityPoints = candidate.action?.type === "end"
      ? this.evaluator.endOpportunityPoints(
          candidate.baseTerms,
          siblingCandidates.map((sibling) => ({
            actionType:sibling.action?.type ?? null,
            transitionTerms:sibling.baseTerms,
            nextEnergyStateDelta:sibling.nextEnergyStateDelta
          }))
        )
      : 0;
    const transitionValue = this.evaluator.composeTransitionValue({
      baseTransition:candidate.baseTransition,
      frontierValue:candidate.frontierValue,
      endOpportunityPoints
    });
    if (!isValidFinalUtility(transitionValue)) {
      throw new TypeError("Evaluator 必须返回合法 Final Utility");
    }
    return { ...candidate, transitionValue };
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
  物化一个普通候选的 Simulator、Evaluator 与 finalize 链。

  调用方
  materializeSiblingCandidates。

  输入
  canonical Action、父 World、行动者、深度、provenance、Simulator、搜索上下文与诊断选项。

  输出
  完整候选；预算中断返回 null，ordinary candidate fault 向 search 边界抛出。

  读取状态
  Simulator、Evaluator 与 SearchBudget 工作计数。

  写入状态
  只更新工作计数、candidate fault 与纯数字阶段耗时 diagnostics；普通故障不恢复搜索。

  调用函数
  Simulator.apply、evaluateCandidate、finalizeCandidate、recordCandidateFault、recordCandidateTiming。

  边界与不变量
  candidate atomicity 只保证 partial candidate 不得登记，不代表 candidate 不可中断；
  safe checkpoint 的 TIME/NODE signal 会 unwind 当前未完成 candidate，且不记录 candidate fault；
  ordinary candidate fault 必须终止本次搜索，不能把缺失候选的空间当成正式比较集合；
  END 必须由 sibling group 在完整上下文中单独 finalize。
  */
  materializeCandidate({
    action,
    beforeState,
    player,
    depth,
    remainingProvenance,
    simulator,
    context,
    collectDiagnostics,
    budget
  }) {
    const startedAt = searchDiagnosticNow();
    const workBefore = {
      simulationCalls:budget.simulationCalls,
      cloneCalls:budget.cloneCalls,
      probabilityOperations:budget.probabilityOperations,
      probabilityWorldBranches:budget.probabilityWorldBranches,
      stateUtilityCalls:budget.stateUtilityCalls,
      stateUtilityDurationMs:budget.stateUtilityDurationMs ?? 0,
      counterfactualCalls:budget.counterfactualCalls,
      counterfactualDurationMs:budget.counterfactualDurationMs ?? 0,
      actionGenerationPhysicalCandidates:budget.actionGenerationPhysicalCandidates,
      actionGenerationUniqueCandidates:budget.actionGenerationUniqueCandidates
    };
    let mainSimulatorApplyMs = 0;
    let valueMaterializationMs = 0;
    let completed = false;
    try {
      budget.observeSimulation();
      const applyStartedAt = searchDiagnosticNow();
      let state;
      try {
        state = simulator.apply(beforeState, action);
      } finally {
        mainSimulatorApplyMs = Math.max(0, searchDiagnosticNow() - applyStartedAt);
      }
      const valueStartedAt = searchDiagnosticNow();
      let candidate;
      try {
        candidate = this.evaluateCandidate({
          action,
          beforeState,
          afterState:state,
          player,
          depth,
          remainingProvenance,
          simulator,
          context,
          collectDiagnostics,
          searchBudget:budget
        });
      } finally {
        valueMaterializationMs = Math.max(0, searchDiagnosticNow() - valueStartedAt);
      }
      const result = action.type === "end" ? candidate : this.finalizeCandidate(candidate);
      completed = true;
      return result;
    } catch (error) {
      if (budget.isCurrentWorkInterruption(error)) return null;
      const fault = this.recordCandidateFault(action, "materialize", error);
      const candidateError = new Error(
        `Searcher candidate materialize fault [${actionSearchKey(action)}]: ${fault.message}`
      );
      candidateError.name = "CandidateMaterializationError";
      throw candidateError;
    } finally {
      this.recordCandidateTiming({
        action,
        depth,
        completed,
        durationMs:Math.max(0, searchDiagnosticNow() - startedAt),
        mainSimulatorApplyMs,
        valueMaterializationMs,
        simulationCalls:budget.simulationCalls - workBefore.simulationCalls,
        cloneCalls:budget.cloneCalls - workBefore.cloneCalls,
        probabilityOperations:budget.probabilityOperations - workBefore.probabilityOperations,
        probabilityWorldBranches:budget.probabilityWorldBranches - workBefore.probabilityWorldBranches,
        stateUtilityCalls:budget.stateUtilityCalls - workBefore.stateUtilityCalls,
        stateUtilityDurationMs:(budget.stateUtilityDurationMs ?? 0)
          - workBefore.stateUtilityDurationMs,
        counterfactualCalls:budget.counterfactualCalls - workBefore.counterfactualCalls,
        counterfactualDurationMs:(budget.counterfactualDurationMs ?? 0)
          - workBefore.counterfactualDurationMs,
        actionGenerationPhysicalCandidates:budget.actionGenerationPhysicalCandidates
          - workBefore.actionGenerationPhysicalCandidates,
        actionGenerationUniqueCandidates:budget.actionGenerationUniqueCandidates
          - workBefore.actionGenerationUniqueCandidates
      });
    }
  }

  /*
  功能
  把完整物化的子候选连接到父搜索节点。

调用方
search 的逐层 beam expansion。

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
  只连接已经完整物化并完成 sibling terms 的候选；Pattern metadata 不得改变 final value。
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
      (proposal) => this.pattern.matchesStep(proposal, stepIndex, action, state)
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
  把可完成 non-END baseline、Pattern-guided roots 与既有搜索先验顺序进行公平交错。

  调用方
  search 的 root scheduling 阶段。

  输入
  已去重合法 roots、行动者、根 World 与有界 proposals。

  输出
  多 root 时先排可独立完成的 non-END，再最多提升其中一个 guided root；唯一 END 正常保留。

  读取状态
  搜索先验 score、Action type 与 canonical Action keys。

  写入状态
  无。

  调用函数
  schedulingScore、actionIntentKey、actionSearchKey。

  边界与不变量
  END 有 siblings 时必须位于 non-END 之后，避免把 sibling-incomplete END 当作首个 baseline；
  Pattern 只有一个 non-END 正向提升位，其他 proposals 不得挤占 ordinary coverage。
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
    const baselineOrder = [
      ...scheduled.filter((entry) => entry.action?.type !== "end"),
      ...scheduled.filter((entry) => entry.action?.type === "end")
    ];
    if (!proposals.length) return baselineOrder.map((entry) => entry.action);
    const promotableEntries = baselineOrder.filter(
      (entry) => entry.action?.type !== "end" || baselineOrder.length === 1
    );
    let promotedEntry = null;
    for (const proposal of proposals) {
      promotedEntry = promotableEntries.find(
        (entry) => this.pattern.matchesStep(proposal, 0, entry.action, state)
      ) ?? null;
      if (promotedEntry) break;
    }
    if (!promotedEntry) return baselineOrder.map((entry) => entry.action);
    return [
      promotedEntry.action,
      ...baselineOrder.filter((entry) => entry !== promotedEntry).map((entry) => entry.action)
    ];
  }

  /*
  功能
  在昂贵深层物化前按现有 搜索先验 与 semantic key 稳定排列 legal children。

  调用方
  search 的逐层 beam expansion。

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
        this.pattern.matchesStep(proposal, stepIndex, action, state)
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
  失败候选不会形成节点，因此不得登记；同一 proposal 只计一次。
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
search 的 root 与逐层 beam 完整节点登记点。

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
  按既定调度顺序完整物化同一 parent 的候选，并在候选边界执行预算与取消检查。

  调用方
  search 的 root 与逐层 beam expansion。

  输入
  同 parent 的 canonical Actions、父 World/provenance、行动者、深度、Simulator、预算、
  搜索上下文、结构、会话 ID，以及此前是否已有完整 incumbent。

  输出
  完整 candidates，以及 stopped/cancelled 状态。

  读取状态
  Simulator、Evaluator、SearchBudget 与 yieldControl。

  写入状态
  只更新完整节点工作计数和 candidate fault diagnostics；普通故障直接上抛。

  调用函数
  materializeCandidate、finalizeCandidate、SearchBudget.shouldStop/observeNode、continueAfterYield。

  边界与不变量
  TIME/NODE 可在候选边界阻止新工作，也可经 safe checkpoint unwind 未完成 candidate；
  candidate atomicity 只保证 partial candidate 不得进入完整候选或 incumbent；
  END 只有在全部 canonical siblings 都成功物化时才可 finalize；candidate fault 不得静默丢失当前候选后继续比较。
  */
  async materializeSiblingCandidates({
    actions,
    parentState,
    parentProvenance,
    depth,
    player,
    simulator,
    budget,
    context,
    structure,
    gameId,
    collectDiagnostics = false,
    hasIncumbent = false
  }) {
    const completeCandidates = [];
    const materializedCandidates = [];
    let endCandidate = null;
    let attemptedAll = true;
    for (const action of actions) {
      if ((hasIncumbent || completeCandidates.length > 0) && budget.shouldStop()) {
        attemptedAll = false;
        break;
      }
      const candidate = this.materializeCandidate({
        action,
        beforeState:parentState,
        player,
        depth,
        remainingProvenance:parentProvenance,
        simulator,
        context,
        collectDiagnostics,
        budget
      });
      if (!candidate) continue;
      candidate.completedAtWorkCount = budget.simulationCalls;
      materializedCandidates.push(candidate);
      if (action.type === "end") {
        endCandidate = candidate;
      } else {
        completeCandidates.push(candidate);
        budget.observeNode();
      }
      if (budget.expandedNodes > 0
        && budget.expandedNodes % structure.yieldEvery === 0) {
        budget.observeYield();
        if (!(await this.continueAfterYield(budget, gameId))) {
          return { candidates:completeCandidates, stopped:true, cancelled:true };
        }
      }
    }
    if (attemptedAll && endCandidate && materializedCandidates.length === actions.length) {
      try {
        const completeEnd = this.finalizeCandidate(endCandidate, materializedCandidates);
        completeEnd.completedAtWorkCount = budget.simulationCalls;
        completeCandidates.push(completeEnd);
        budget.observeNode();
      } catch (error) {
        const fault = this.recordCandidateFault(endCandidate.action, "finalize", error);
        const candidateError = new Error(
          `Searcher candidate finalize fault [${actionSearchKey(endCandidate.action)}]: ${fault.message}`
        );
        candidateError.name = "CandidateMaterializationError";
        throw candidateError;
      }
    }
    return {
      candidates:completeCandidates,
      stopped:budget.stopReason !== null || !attemptedAll,
      cancelled:budget.stopReason === "CANCELLED"
    };
  }

  /*
  功能
  统一记录完成、预算中断或取消后的最优搜索序列与搜索诊断。

  调用方
  search 的正常收束和 yield 取消路径。

  输入
  SearchBudget、结构配置、完整 incumbent、context、根诊断条目与本次搜索工作诊断。

  输出
  只返回完整 incumbent Action；任何停止原因下零完整 incumbent 都返回 null。

  读取状态
  budget 计数、候选序列、root/work diagnostics 与 bounded counterfactual context diagnostics。

  写入状态
  lastSequence 与 lastSearchStats。

  调用函数
  describeSequence、SearchBudget.diagnostics。

  边界与不变量
  统计只描述已完成的搜索工作；失败候选永远不能成为返回 Action。
  */
  recordResult({
    budget,
    structure,
    choice,
    context,
    rootLedgers,
    workDiagnostics
  }) {
    const budgetStats = budget.diagnostics();
    this.lastSequence = this.describeSequence(
      [...(choice?.sequence ?? [])]
    );
    const hiddenSamples = context.unknownHandEstimate?.sampleCount ?? 0;
    this.lastSearchStats = {
      elapsedMs:budgetStats.elapsedMs,
      deadlineMs:budgetStats.deadline,
      configuredDeadline:budgetStats.deadline,
      deadlineCrossedAt:budgetStats.deadlineCrossedAt,
      timeObservedAtMs:budgetStats.timeObservedAtMs,
      searchReturnAtMs:budgetStats.searchReturnAtMs,
      deadlineOverrunMs:budgetStats.deadlineOverrunMs,
      expanded:budgetStats.expandedNodes,
      depth:Math.max(1, choice?.sequence.length ?? 1),
      beamWidth:structure.beamWidth,
      budgetType:budgetStats.nodeBudget === null ? "time" : "nodes",
      timeBudget:budgetStats.timeBudget,
      nodeBudget:budgetStats.nodeBudget,
      stopReason:budgetStats.stopReason,
      candidateFaults:Object.freeze([...(this.candidateFaults ?? [])]),
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
      counterfactualDurationMs:budgetStats.counterfactualDurationMs,
      stateUtilityCalls:budgetStats.stateUtilityCalls,
      stateUtilityDurationMs:budgetStats.stateUtilityDurationMs,
      candidateTimingCount:this.candidateTimingCount,
      slowestCandidateTimings:Object.freeze([...this.slowestCandidateTimings]),
      actionGenerationPhysicalCandidates:budgetStats.actionGenerationPhysicalCandidates,
      actionGenerationUniqueCandidates:budgetStats.actionGenerationUniqueCandidates,
      yieldCount:budgetStats.yieldCount,
      hiddenSamples,
      bestSequence:this.lastSequence,
      bestRemainingProvenance:choice?.remainingHistory ?? [],
      bestValueScore:choice?.valueScore ?? null,
      physicalRootCount:workDiagnostics.rootCandidateCount,
      uniqueRootCount:workDiagnostics.uniqueRootCandidateCount,
      rootCandidateCount:workDiagnostics.rootCandidateCount,
      uniqueRootCandidateCount:workDiagnostics.uniqueRootCandidateCount,
      equivalentRootCandidatesEliminated:workDiagnostics.equivalentRootCandidatesEliminated,
      firstScheduledRootIndex:workDiagnostics.firstScheduledRootIndex,
      ...(workDiagnostics.scheduledRootOrder
        ? { scheduledRootOrder:workDiagnostics.scheduledRootOrder }
        : {}),
      completedRootCandidateCount:workDiagnostics.completedRootCandidateCount,
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
      rootLedgers
    };
    return choice?.action ?? null;
  }

  /*
  功能
  在固定时间或节点预算内执行经典 best-so-far beam search。

  调用方
  Controller.executeSearchRequest 与搜索回归测试。

  输入
  行动者、canonical World、canonical root Actions 与可选会话/诊断上下文。

  输出
  Evaluator 选出的最佳完整 root Action；root coverage 未完成时返回 null，
  其它 root invariant failure 继续抛出。

  读取状态
  World、Pattern proposals、Generator、Simulator、Evaluator 与 SearchBudget。

  写入状态
  lastSearchStats、lastSequence 与完整候选工作诊断。

  调用函数
  validateRootActions、deduplicateActions、Pattern.match、materializeSiblingCandidates、
  buildRootNodes、buildChildNode、prune、considerIncumbent、recordResult。

  边界与不变量
  root contract 只在入口验证一次；TIME/NODE 可在候选边界或 candidate 内 safe checkpoint 停止；
  candidate atomicity 只保证 partial candidate 不得登记，不禁止 cooperative interruption；
  candidate fault 与共享结构异常都直接上抛，不能形成缺失候选的正式空间；
  所有 canonical roots 完整物化并完成 END sibling terms 前，不登记任何正式 root incumbent；
  END 只有全部同 parent canonical siblings 完整时才可比较；
  Pattern 只调度，Evaluator comparator 是唯一 winner authority。
  */
  async search(player, world, rootActions, options = {}) {
    this.comparisonActor = player;
    this.comparisonWorld = world;
    this.lastSequence = [];
    this.lastSearchStats = null;
    this.candidateFaults = [];
    this.candidateTimingCount = 0;
    this.slowestCandidateTimings = [];
    validateRootActionContract(player, rootActions);

    const budget = this.searchBudgetFactory();
    const structure = this.structure();
    const uniqueRootActions = this.deduplicateActions(rootActions);
    const rootCandidateCount = Math.max(
      rootActions.length,
      Number.isFinite(Number(options.rootCandidateCount))
        ? Math.floor(Number(options.rootCandidateCount))
        : rootActions.length
    );
    const patternMatch = this.pattern.match({
      player,
      state:world,
      legalActions:uniqueRootActions,
      structure
    });
    const patternProposals = patternMatch.proposals ?? [];
    const scheduledRootActions = this.scheduleRootActions(
      uniqueRootActions,
      player,
      world,
      patternProposals
    );
    const context = this.createContext(player, world);
    const simulator = this.simulatorFactory({ searchBudget:budget });
    const workDiagnostics = {
      rootCandidateCount,
      uniqueRootCandidateCount:uniqueRootActions.length,
      equivalentRootCandidatesEliminated:Math.max(
        0,
        rootCandidateCount - uniqueRootActions.length
      ),
      firstScheduledRootIndex:rootActions.indexOf(scheduledRootActions[0]),
      scheduledRootOrder:options.collectAiDecisionDiagnostics
        ? [...scheduledRootActions]
        : null,
      completedRootCandidateCount:0,
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
      firstDepth2AtWorkCount:null
    };
    const rootLedgers = [];
    let bestSeenCandidate = null;

    const rootResult = await this.materializeSiblingCandidates({
      actions:scheduledRootActions,
      parentState:world,
      parentProvenance:context.rootProvenance,
      depth:1,
      player,
      simulator,
      budget,
      context,
      structure,
      gameId:options.gameId,
      collectDiagnostics:Boolean(options.collectAiDecisionDiagnostics),
      hasIncumbent:false
    });
    const rootCandidates = rootResult.candidates;
    workDiagnostics.completedRootCandidateCount = rootCandidates.length;
    if (rootResult.stopped) {
      return this.recordResult({
        budget,
        structure,
        choice:null,
        context,
        rootLedgers,
        workDiagnostics
      });
    }
    if (!rootCandidates.length) {
      if (budget.stopReason === SEARCH_STOP_REASON.TIME
        || budget.stopReason === SEARCH_STOP_REASON.NODE) {
        return this.recordResult({
          budget,
          structure,
          choice:null,
          context,
          rootLedgers,
          workDiagnostics
        });
      }
      throw new Error("Searcher root invariant 失败：所有 root candidates 均发生 candidate fault");
    }
    workDiagnostics.depthReached = 1;
    if (options.collectAiDecisionDiagnostics) {
      rootLedgers.push(...rootCandidates.map((candidate) => this.diagnosticEntry(candidate)));
    }

    const rootNodes = this.buildRootNodes(rootCandidates, patternProposals, world);
    for (const node of rootNodes) {
      this.observeCompletedPatterns(node, workDiagnostics);
      bestSeenCandidate = this.considerIncumbent(
        bestSeenCandidate,
        node,
        workDiagnostics
      );
    }
    let activeBeam = this.prune(rootNodes, structure.beamWidth);
    searchDepth:
    for (let depth = 2; depth <= structure.depth; depth += 1) {
      if (activeBeam.every((node) => node.terminal)) break;
      const nextNodes = [];
      for (const node of activeBeam) {
        if (budget.shouldStop()) break searchDepth;
        if (node.terminal) {
          nextNodes.push({ ...node, pruneScore:node.valueScore, searchCredit:0 });
          continue;
        }
        const generated = this.generateActions(node.state, player.id, budget);
        const followActions = this.scheduleChildActions(
          generated,
          player,
          node.state,
          node.activePatternProposals,
          depth - 1
        );
        workDiagnostics.childBranches += followActions.length;
        for (const proposal of node.activePatternProposals ?? []) {
          const resolvable = followActions.some((action) => (
            this.pattern.matchesStep(proposal, depth - 1, action, node.state)
          ));
          if (resolvable
            || workDiagnostics.completedPatternProposalKeys.has(proposal.semanticKey)
            || workDiagnostics.abortedPatternProposalKeys.has(proposal.semanticKey)) continue;
          workDiagnostics.abortedPatternProposalKeys.add(proposal.semanticKey);
          workDiagnostics.abortedPatternCount += 1;
        }
        const childResult = await this.materializeSiblingCandidates({
          actions:followActions,
          parentState:node.state,
          parentProvenance:node.remainingProvenance,
          depth,
          player,
          simulator,
          budget,
          context,
          structure,
          gameId:options.gameId,
          hasIncumbent:true
        });
        const childNodes = childResult.candidates.map(
          (candidate) => this.buildChildNode(node, candidate, depth)
        );
        workDiagnostics.completedChildCandidateCount += childNodes.length;
        if (childNodes.length) {
          workDiagnostics.depthReached = Math.max(workDiagnostics.depthReached, depth);
          workDiagnostics.firstDepth2AtWorkCount ??= depth === 2
            ? childNodes[0].completedAtWorkCount
            : null;
        }
        for (const childNode of childNodes) {
          this.observeCompletedPatterns(childNode, workDiagnostics);
          bestSeenCandidate = this.considerIncumbent(
            bestSeenCandidate,
            childNode,
            workDiagnostics
          );
        }
        nextNodes.push(...childNodes);
        if (childResult.stopped) break searchDepth;
      }
      if (!nextNodes.length) break;
      activeBeam = this.prune(nextNodes, structure.beamWidth);
    }

    budget.complete();
    return this.recordResult({
      budget,
      structure,
      choice:bestSeenCandidate,
      context,
      rootLedgers,
      workDiagnostics
    });
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
    searchBudget?.checkpointCurrentWork?.();
    const candidates = this.generateActions(state, actorId, searchBudget);
    let best = -Infinity;
    for (const candidate of candidates) {
      searchBudget?.checkpointCurrentWork?.();
      searchBudget?.observeSimulation();
      const after = simulator.apply(state, candidate);
      searchBudget?.checkpointCurrentWork?.();
      const utility = this.evaluateStateUtility(
        after,
        actorId,
        simulator.buildLightningOutcomeSets(after),
        searchBudget
      );
      if (utility > best) best = utility;
    }
    return Number.isFinite(best)
      ? best
      : this.evaluateStateUtility(
          state,
          actorId,
          simulator.buildLightningOutcomeSets(state),
          searchBudget
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
    searchBudget?.checkpointCurrentWork?.();
    const baselineBest = this.bestFollowUpUtility(afterState, actorId, simulator, searchBudget);
    const informedBestValues = [];
    for (const world of handSamples) {
      searchBudget?.checkpointCurrentWork?.();
      const specializedBefore = simulator.specializeHiddenWorld(beforeState, world, actorId);
      searchBudget?.observeSimulation();
      const specializedAfter = simulator.apply(specializedBefore, action);
      searchBudget?.checkpointCurrentWork?.();
      const informedBest = this.bestFollowUpUtility(
        specializedAfter,
        actorId,
        simulator,
        searchBudget
      );
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
    const { baselineWorld, boostedWorld } = simulator.buildExposeMarginalWorlds(
      afterState,
      actorId,
      addedStacks
    );
    searchBudget?.checkpointCurrentWork?.();
    const candidates = this.generateActions(afterState, actorId, searchBudget);
    let best = 0;
    for (const candidate of candidates) {
      if (!this.evaluator.realizesExposeMarginal(candidate)) continue;
      searchBudget?.checkpointCurrentWork?.();
      searchBudget?.observeSimulation();
      const base = simulator.apply(baselineWorld, candidate);
      searchBudget?.checkpointCurrentWork?.();
      searchBudget?.observeSimulation();
      const boosted = simulator.apply(boostedWorld, candidate);
      searchBudget?.checkpointCurrentWork?.();
      const counterfactualStartedAt = searchDiagnosticNow();
      let marginal;
      try {
        marginal = this.evaluator.positiveWorldMarginal(
          base,
          boosted,
          actorId,
          simulator.buildLightningOutcomeSets(base),
          simulator.buildLightningOutcomeSets(boosted)
        );
      } finally {
        searchBudget?.observeCounterfactual(
          2,
          Math.max(0, searchDiagnosticNow() - counterfactualStartedAt)
        );
      }
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
    const { baselineWorld, boostedWorld } = simulator.buildAssaultStackWorlds(
      currentState,
      actorId,
      marginalStacks
    );
    searchBudget?.checkpointCurrentWork?.();
    searchBudget?.observeSimulation();
    const boosted = simulator.apply(boostedWorld, action);
    searchBudget?.checkpointCurrentWork?.();
    searchBudget?.observeSimulation();
    const baseline = simulator.apply(baselineWorld, action);
    searchBudget?.checkpointCurrentWork?.();
    const counterfactualStartedAt = searchDiagnosticNow();
    try {
      return this.evaluator.positiveWorldMarginal(
        baseline,
        boosted,
        actorId,
        simulator.buildLightningOutcomeSets(baseline),
        simulator.buildLightningOutcomeSets(boosted)
      );
    } finally {
      searchBudget?.observeCounterfactual(
        2,
        Math.max(0, searchDiagnosticNow() - counterfactualStartedAt)
      );
    }
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
    const assaultStacksCredit = this.evaluateCurrentActionMarginal(
      beforeState,
      action,
      actorId,
      remainingProvenance,
      simulator,
      searchBudget
    );
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
// CANCELLED 表示会话让步检测到取消。共享异常直接上抛，不伪装成搜索停止原因。
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
    this.counterfactualDurationMs = 0;
    this.stateUtilityCalls = 0;
    this.stateUtilityDurationMs = 0;
    this.actionGenerationPhysicalCandidates = 0;
    this.actionGenerationUniqueCandidates = 0;
    this.yieldCount = 0;
    this.stopReason = null;
    this.lastObservedAt = this.started;
    this.deadlineCrossedAt = null;
    this.currentWorkInterruption = new Error("AI search current work interrupted");
  }

  /*
  功能
  判断异常是否为当前 SearchBudget 发出的 cooperative interruption signal。

  调用方
  materializeCandidate 的 candidate-local 异常边界。

  输入
  任意捕获的异常对象。

  输出
  当前预算 signal 返回 true，否则返回 false。

  读取状态
  当前 SearchBudget 的 interruption signal。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只识别同一 SearchBudget 实例的 signal，不把普通异常误判为控制流。
  */
  isCurrentWorkInterruption(error) {
    return error === this.currentWorkInterruption;
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
  当前预算与停止原因。

  写入状态
  首次过期时写入 TIME/NODE stopReason。

  调用函数
  shouldStop。

  边界与不变量
  signal 只允许由拥有该 SearchBudget 的 Searcher 捕获；不得把 partial action 或 World 登记为候选。
  */
  checkpointCurrentWork() {
    if (!this.shouldStop()) return true;
    throw this.currentWorkInterruption;
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
  节点模式不读取时钟；已开始物化可在 safe checkpoint cooperative unwind，
  无 checkpoint 的单段工作才可能轻微越过时间预算；已完成 incumbent 必须保留。
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
    this.expandedNodes += 1;
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
  记录一次完整配对反事实查询及其 stateUtility 调用/耗时。

  调用方
  Searcher 反事实项。

  输入
  本次反事实内的 stateUtility 调用数与整段 value comparison 耗时。

  输出
  更新后的 counterfactualCalls。

  读取状态
  当前反事实与 stateUtility 计数。

  写入状态
  counterfactualCalls 加一并累加 counterfactual/stateUtility 调用与耗时。

  调用函数
  无。

  边界与不变量
  只观察既有 paired-world 查询，不改变调用次数或 value 公式。
  */
  observeCounterfactual(stateUtilityCalls = 0, durationMs = 0) {
    this.counterfactualCalls += 1;
    this.stateUtilityCalls += Math.max(0, Number(stateUtilityCalls) || 0);
    const duration = Math.max(0, Number(durationMs) || 0);
    this.counterfactualDurationMs += duration;
    this.stateUtilityDurationMs += duration;
    return this.counterfactualCalls;
  }

  /*
  功能
  记录一次 Searcher 显式 StateValue 查询的调用与耗时。

  调用方
  Searcher.evaluateStateUtility。

  输入
  非负墙钟耗时。

  输出
  更新后的 stateUtilityCalls。

  读取状态
  当前 StateValue 诊断计数。

  写入状态
  stateUtilityCalls 加一并累加 duration。

  调用函数
  无。

  边界与不变量
  只统计已经实际发起的查询；不参与搜索、预算或 Final Utility。
  */
  observeStateUtility(durationMs = 0) {
    this.stateUtilityCalls += 1;
    this.stateUtilityDurationMs += Math.max(0, Number(durationMs) || 0);
    return this.stateUtilityCalls;
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
    return {
      started:this.started,
      deadline:this.nodeBudget === null ? this.started + this.timeBudget : null,
      elapsedMs:this.lastObservedAt - this.started,
      deadlineCrossedAt:this.deadlineCrossedAt,
      timeObservedAtMs:this.deadlineCrossedAt === null
        ? null
        : Math.max(0, this.deadlineCrossedAt - this.started),
      searchReturnAtMs:Math.max(0, this.lastObservedAt - this.started),
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
      counterfactualDurationMs:this.counterfactualDurationMs,
      stateUtilityCalls:this.stateUtilityCalls,
      stateUtilityDurationMs:this.stateUtilityDurationMs,
      actionGenerationPhysicalCandidates:this.actionGenerationPhysicalCandidates,
      actionGenerationUniqueCandidates:this.actionGenerationUniqueCandidates,
      yieldCount:this.yieldCount,
      stopReason:this.stopReason
    };
  }
}
