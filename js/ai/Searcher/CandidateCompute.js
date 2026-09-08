/*
模块职责
物化单个 canonical candidate 的 Simulator Worlds 和 Evaluator receipt，Local 与 Compute Worker 共用唯一实现。

上游
Searcher 与 Controller candidate composition。

下游
注入的 Simulator、Generator 与 Evaluator facade。

状态边界
只写独立候选 World 与局部计算计数。

信息边界
隐藏样本只接收 Coordinator 已准备的普通数据；不采样。

架构约束
不拥有 traversal、Budget、RNG、Beam、END finalize 或 winner；计算必须完整返回或抛错。
*/
import { assertCompleteTransitionTerms } from "../Evaluator/Evaluator.js";

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
创建仅记录计算事件的接收器。

调用方
CandidateCompute.compute。

输入
无。

输出
只含 observer 能力的接收器与 data-only events。

读取状态
无。

写入状态
候选局部 events。

调用函数
performance.now。

边界与不变量
没有时钟预算、停止检查、节点计数或 RNG 能力。
*/
function createWorkReceipt() {
  const events = [];
  const work = { events };
  for (const name of ["observeSimulation", "observeClone", "observeProbabilityWork", "observeResponseBranches", "observeCounterfactual", "observeActionGeneration"]) {
/*
功能
记录一个已完成计算观察事件。

调用方
Simulator、Generator 与候选计算。

输入
原 observer 的数字参数或普通诊断数据。

输出
无。

读取状态
闭包中的事件名。

写入状态
当前候选 events。

调用函数
Array.push。

边界与不变量
只运输观察，不调用 SearchBudget。
*/
    work[name] = (...args) => { events.push({ name, args }); };
  }
/*
功能
记录概率操作的计时起点。

调用方
Simulator.runProbabilityOperation。

输入
operation、输入世界数与模式。

输出
普通数字 token。

读取状态
诊断墙钟。

写入状态
无。

调用函数
searchDiagnosticNow。

边界与不变量
不读取 deadline 或预算。
*/
  work.beginProbabilityOperation = (operation, inputWorldCount, mode) => ({ operation, inputWorldCount, mode, startMs:searchDiagnosticNow() });
/*
功能
记录完整概率操作与工作量。

调用方
Simulator.runProbabilityOperation。

输入
token、输出世界数和完成标志。

输出
无。

读取状态
token 与诊断墙钟。

写入状态
候选 events。

调用函数
searchDiagnosticNow、observeProbabilityWork。

边界与不变量
普通错误继续抛出，不返回部分结果。
*/
  work.finishProbabilityOperation = (token, outputWorldCount, completed) => {
    if (!completed) return;
    const endMs = searchDiagnosticNow();
    work.observeProbabilityWork(outputWorldCount, { ...token, endMs, durationMs:Math.max(0, endMs - token.startMs), outputWorldCount, completed:true, deadlineRemainingMs:null, crossedDeadline:false });
  };
  return work;
}

export class CandidateCompute {
/*
功能
保存单候选计算的显式 owner 能力。

调用方
Controller 与 Searcher local composition。

输入
evaluator、simulatorFactory 与 generateActions。

输出
纯候选计算实例。

读取状态
无。

写入状态
只读能力引用。

调用函数
无。

边界与不变量
不得注入 RNG 或 Budget。
*/
  constructor({ evaluator, simulatorFactory, generateActions }) {
    Object.assign(this, { evaluator, simulatorFactory, generateActions });
  }
/*
功能
原子物化一个已 admission 的 candidate receipt。

调用方
Searcher local executor、Compute Worker。

输入
data-only Action、父 World、行动者、深度、provenance、hiddenWorlds 与诊断开关。

输出
完整 candidate、工作事件与耗时；计算异常原样抛出。

读取状态
输入数据与显式计算能力。

写入状态
独立 Simulator、World、events。

调用函数
Simulator.apply、evaluateCandidate。

边界与不变量
不 finalize END，不登记节点；不检查预算或采样。
*/
  compute(input) {
    const work = createWorkReceipt();
    const simulator = this.simulatorFactory({ searchBudget:work });
    if (input.lightningCache && simulator.lightningOutcomeCache) {
      simulator.lightningOutcomeCache.set(input.beforeState, new Map(input.lightningCache));
    }
    const startedAt = searchDiagnosticNow();
    work.observeSimulation();
    const state = simulator.apply(input.beforeState, input.action);
    const applyFinishedAt = searchDiagnosticNow();
    const candidate = this.evaluateCandidate({ ...input, afterState:state, simulator, work });
    const finishedAt = searchDiagnosticNow();
    return {
      candidate,
      beforeLightningCache:[...(simulator.lightningOutcomeCache?.get(input.beforeState) ?? [])],
      afterLightningCache:[...(simulator.lightningOutcomeCache?.get(state) ?? [])],
      events:work.events,
      timing:{ action:input.action, depth:input.depth, completed:true, durationMs:finishedAt - startedAt, mainSimulatorApplyMs:applyFinishedAt - startedAt, valueMaterializationMs:finishedAt - applyFinishedAt }
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
  CandidateCompute 只编排 transition/value owner；响应价值只作诊断，不参与 final value。
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
  compute。

  输入
  动作前后 World、行动者、深度、provenance、Simulator、隐藏样本、诊断开关与计算计数接收器。

  输出
  单一候选估值记录；X 技能另带由 Simulator 构造的同 World E+1 完整 StateDelta。

  读取状态
  CandidateCompute 反事实项、Evaluator 与已生成的隐藏样本数据。

  写入状态
  只写独立候选记录和显式诊断。

  调用函数
  materializeValueTerms、Simulator.getTransitionEvaluationWorlds/buildSkillEnergyCounterfactualWorlds、
  Evaluator.evaluateTransition/transitionDelta/composeSearchPrior。

  边界与不变量
  CandidateCompute 只机械组装各 owner 的结果；X 技能 World clone、能量替换与技能结算全部归 Simulator，
  CandidateCompute 不写 World、不定义 value formula；Simulator 已准备的 effect baseline 只透传给 Evaluator；
  调用方必须 finalize 后才能登记候选。
  */
  evaluateCandidate({
    action,
    beforeState,
    afterState,
    player,
    depth,
    remainingProvenance,
    simulator,
    hiddenWorlds = [],
    collectDiagnostics = false,
    work = null
  }) {
    const terms = this.materializeValueTerms({
      beforeState,
      afterState,
      action,
      actorId:player.id,
      remainingProvenance,
      simulator,
      work
    });
    const beforeLightningOutcomeSets = simulator.buildLightningOutcomeSets(beforeState);
    const afterLightningOutcomeSets = simulator.buildLightningOutcomeSets(afterState);
    const transitionEvaluationWorlds = simulator.getTransitionEvaluationWorlds?.(afterState)
      ?? null;
    const baseTerms = assertCompleteTransitionTerms(this.evaluator.evaluateTransition({
      action,
      player,
      beforeState,
      afterState,
      effectBaselineState:transitionEvaluationWorlds?.effectBaselineState ?? null,
      effectResolutionScale:transitionEvaluationWorlds?.effectResolutionScale ?? 1,
      depth,
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
        work?.observeSimulation();
        const counterfactual = simulator.buildSkillEnergyCounterfactualWorlds(
          beforeState,
          action,
          baseTerms.xSkillNextEnergy
        );
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
          work?.observeCounterfactual(
            2,
            Math.max(0, searchDiagnosticNow() - counterfactualStartedAt)
          );
        }
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
      searchBudget:work,
      hiddenWorlds:this.evaluator.requiresHiddenWorldPrior(action)
        ? hiddenWorlds
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
      domainPrior,
      searchCredit,
      prior
    };
  }

  /*
  功能
  遍历 Evaluator 指定的后续候选并比较 Simulator paired Worlds。

  调用方
  materializeValueTerms 与领域边际测试。

  输入
  动作前后 World、canonical Action、行动者 ID、复用 Simulator 与可选 计算计数接收器。

  输出
  Evaluator 返回的最大非负效用增量。

  读取状态
  输入 Worlds、Generator、Simulator 与 Evaluator value requests。

  写入状态
  只写 Simulator 返回的独立反事实状态。

  调用函数
  Evaluator.exposeMarginalStackDelta/realizesExposeMarginal/positiveWorldMarginal、generate、Simulator.apply。

  边界与不变量
  CandidateCompute 不识别具体牌；paired worlds 只改变被测层数，nested value 查询只记录工作量。
  */
  evaluateFollowUpMarginal(
    beforeState,
    afterState,
    action,
    actorId,
    simulator,
    work = null
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
    const candidates = this.generateActions(afterState, actorId, work);
    let best = 0;
    for (const candidate of candidates) {
      if (!this.evaluator.realizesExposeMarginal(candidate)) continue;
      work?.observeSimulation();
      const base = simulator.apply(baselineWorld, candidate);
      work?.observeSimulation();
      const boosted = simulator.apply(boostedWorld, candidate);
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
        work?.observeCounterfactual(
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
  当前 World、canonical Action、行动者 ID、剩余 provenance、复用 Simulator 与可选 计算计数接收器。

  输出
  Evaluator 返回的非负 provenance 消费信用。

  读取状态
  当前过滤状态、Evaluator value request 与回合开始时的来源记录。

  写入状态
  只写两个独立克隆及 Simulator 返回状态。

  调用函数
  Evaluator.assaultMarginalStackCount/positiveWorldMarginal、Simulator.apply。

  边界与不变量
  CandidateCompute 不识别具体牌；paired worlds 只改变 exposeWeaknessStacks，nested value 查询只记录工作量。
  */
  evaluateCurrentActionMarginal(
    currentState,
    action,
    actorId,
    remainingRootExposeStacks,
    simulator,
    work = null
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
    work?.observeSimulation();
    const boosted = simulator.apply(boostedWorld, action);
    work?.observeSimulation();
    const baseline = simulator.apply(baselineWorld, action);
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
      work?.observeCounterfactual(
        2,
        Math.max(0, searchDiagnosticNow() - counterfactualStartedAt)
      );
    }
  }

  /*
  功能
  为单个候选物化 Evaluator 请求的领域价值输入与下一节点 provenance。

  调用方
  CandidateCompute.evaluateCandidate。

  输入
  before/after、动作、行动者、回合开始时已有层的来源记录与 Simulator。

  输出
  exposeMarginal、assaultStacksCredit 与 remainingProvenance。

  读取状态
  Evaluator value requests 及配对反事实所需过滤状态。

  写入状态
  仅通过反事实辅助函数写独立状态。

  调用函数
  evaluateFollowUpMarginal、evaluateCurrentActionMarginal 与 Evaluator provenance。

  边界与不变量
  CandidateCompute 不读取具体牌或角色 identity；所有业务识别和价值公式都由 Evaluator 返回。
  */
  materializeValueTerms({
    beforeState,
    afterState,
    action,
    actorId,
    remainingProvenance,
    simulator,
    work = null
  }) {
    const exposeMarginal = this.evaluateFollowUpMarginal(
      beforeState,
      afterState,
      action,
      actorId,
      simulator,
      work
    );
    const assaultStacksCredit = this.evaluateCurrentActionMarginal(
      beforeState,
      action,
      actorId,
      remainingProvenance,
      simulator,
      work
    );
    const nextProvenance = this.evaluator.advanceTransitionProvenance(
      action,
      beforeState,
      afterState,
      actorId,
      remainingProvenance
    );
    return {
      exposeMarginal,
      assaultStacksCredit,
      nextProvenance
    };
  }
}
