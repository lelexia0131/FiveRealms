/*
模块职责
唯一拥有破势准备侧、既有层消费侧及 provenance（价值来源记录）的 counterfactual（反事实对照世界）配对项。

上游
CandidateMaterializer 与破势边际回归测试。

下游
Simulator、State Value、深层动作生成与合法匿名手牌采样。

状态边界
只读 World；所有反事实写入独立克隆或由 Simulator 返回的新状态。

信息边界
隐藏信息只在实际需要时由注入的合法 Probability 采样能力惰性读取，不读取 GameState 或 Controller。

架构约束
baseline（基线世界）与 boosted（只增强被测因素的世界）必须成对；本模块只产生破势数值项、先验和来源记录，不拥有同层时机、最终价值、束裁剪或同分裁决。
*/

import {
  PROBABILITY_CLASSIFICATION,
  PROBABILITY_EPSILON,
  clampProbability,
  mutateProbability,
  totalBranchProbability
} from "../state/Probability.js";

export class CounterfactualTerms {
  /*
  功能
  绑定破势反事实、深层生成与隐藏世界能力。

  调用方
  AIController 组合根与 Planner 正式边界。

  输入
  evaluator、generate、sampleUnknownHands 与隐藏样本数。

  输出
  破势反事实 term producer 实例。

  读取状态
  保存显式依赖引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接收 Game、Controller、TransitionValue 或 SearchPolicy。
  */
  constructor({
    evaluator,
    generateActions,
    sampleUnknownHands,
    hiddenSampleCount
  } = {}) {
    const services = { evaluator };
    const capabilities = { generateActions, sampleUnknownHands };
    for (const [name, service] of Object.entries(services)) {
      if (!service) throw new TypeError(`CounterfactualTerms 缺少依赖：${name}`);
    }
    for (const [name, capability] of Object.entries(capabilities)) {
      if (typeof capability !== "function") {
        throw new TypeError(`CounterfactualTerms 缺少依赖：${name}`);
      }
    }
    this.evaluator = evaluator;
    this.generateActions = generateActions;
    this.sampleUnknownHands = sampleUnknownHands;
    this.hiddenSampleCount = hiddenSampleCount;
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
  为一次根搜索记录当前 Probability 查询输入、已有破势层来源与动态目标诊断基线。

  调用方
  CandidateMaterializer.createContext。

  输入
  行动者、根 World 与根动作集合。

  输出
  当前搜索唯一的领域 transition context；匿名手牌样本尚未计算。

  读取状态
  行动者过滤状态与当前 ProbabilityState。

  写入状态
  只创建当前查询输入和独立诊断 Set。

  调用函数
  无。

  边界与不变量
  进入搜索前不得预采样；首次真实隐藏查询才创建一次本 calculation memo。
  */
  createContext(player, visibleState, rootActions) {
    const rootActor = visibleState.players.find((entry) => entry.id === player.id);
    const rootAssaultTargets = new Set(
      rootActions
        .filter((action) => action.cardId === "assault")
        .map((action) => action.targetIds?.[0])
    );
    return {
      viewer:player,
      probabilityState:visibleState.probabilityState,
      probabilityPlayers:visibleState.players,
      unknownHandEstimate:null,
      rootProvenance:rootActor?.exposeWeaknessStacks ?? 0,
      rootAssaultTargets,
      discoveredDynamicTarget:false
    };
  }

  /*
  功能
  在第一个真实隐藏牌查询点惰性创建并复用本次 calculation 的匿名手牌样本。

  调用方
  hiddenPrior、evaluateSpyGapInformationValue。

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
  记录深层生成是否发现根集合以外的突袭目标。

  调用方
  CandidateMaterializer.observeCandidate。

  输入
  候选动作与当前搜索领域 context。

  输出
  无。

  读取状态
  动作定义与首目标标识。

  写入状态
  只可能把 discoveredDynamicTarget 从 false 置为 true。

  调用函数
  无。

  边界与不变量
  该字段只用于诊断，不参与分数、排序或裁剪。
  */
  observeCandidate(action, context) {
    if (action.cardId === "assault"
      && !context.rootAssaultTargets.has(action.targetIds?.[0])) {
      context.discoveredDynamicTarget = true;
    }
  }

  /*
  功能
  惰性估算匿名手牌格挡对突袭候选的既有搜索先验调整。

  调用方
  CandidateMaterializer.materialize。

  输入
  候选动作与当前搜索领域 context。

  输出
  仅用于 pruneScore 的数值 prior。

  读取状态
  当前 Probability 查询输入与目标标识。

  写入状态
  getUnknownHandEstimate。

  调用函数
  无。

  边界与不变量
  系数 -1.5、样本分母与零样本行为保持不变，不进入 final value。
  */
  hiddenPrior(action, context) {
    if (action.cardId !== "assault") return 0;
    const handSamples = this.getUnknownHandEstimate(context).worlds;
    if (!handSamples.length) return 0;
    const targetId = action.targetIds?.[0];
    if (!targetId) return 0;
    return -1.5 * handSamples.filter(
      (world) => world[targetId]?.includes("block")
    ).length / handSamples.length;
  }

  /*
  功能
  判断一次模拟 transition 是否新触发了影客窥隙。

  调用方
  candidateTerms 的信息价值分支。

  输入
  before/after World 与候选动作。

  输出
  新触发时返回被观察者 ID，否则返回 null。

  读取状态
  双方 spyGapTriggeredProbability、characterId 与 lastSpyGapTargetId。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只有本回合尚未触发的边际概率才构成新信息；重复触发返回 null。
  */
  newlyTriggeredSpyGapTarget(beforeState, afterState, actorId) {
    const beforeActor = beforeState?.players?.find((player) => player.id === actorId);
    const afterActor = afterState?.players?.find((player) => player.id === actorId);
    if (afterActor?.characterId !== "shade-agent") return null;
    const beforeProbability = clampProbability(beforeActor?.spyGapTriggeredProbability
      ?? (beforeActor?.spyGapTriggered ? 1 : 0));
    const afterProbability = clampProbability(afterActor?.spyGapTriggeredProbability
      ?? (afterActor?.spyGapTriggered ? 1 : 0));
    if (afterProbability - beforeProbability <= PROBABILITY_EPSILON) return null;
    return afterActor.lastSpyGapTargetId ?? null;
  }

  /*
  功能
  为隐藏世界采样构造敌方手牌完全确定的 World 分支。

  调用方
  evaluateSpyGapInformationValue。

  输入
  before World、一个隐藏世界、viewer ID 与复用 Simulator。

  输出
  已重建响应摘要的独立确定世界。

  读取状态
  before State 的公开字段与隐藏世界定义。

  写入状态
  只写新克隆；将其他玩家 knownCards/handCount 绑定到采样定义。

  调用函数
  structuredClone、Simulator.clone。

  边界与不变量
  不得回读真实未知手牌；viewer 自身手牌保持原状态。
  */
  specializeHiddenWorld(beforeState, world, actorId, simulator) {
    const specialized = structuredClone(beforeState);
    for (const player of specialized.players ?? []) {
      if (player.id === actorId) continue;
      const definitions = world?.[player.id] ?? [];
      const beforePlayer = beforeState.players.find((entry) => entry.id === player.id);
      const certainKnownCount = (beforePlayer?.knownCards ?? []).filter((entry) => {
        return Number(entry.availability ?? 1) >= 1 - PROBABILITY_EPSILON;
      }).length;
      for (const definitionId of definitions.slice(certainKnownCount)) {
        mutateProbability(specialized.probabilityState, {
          type:"REMOVE",
          sourceBucketId:player.id,
          definitionId
        });
      }
      player.knownCards = definitions.map((definitionId, index) => ({
        cardId:`revealed:${player.id}:${index}`,
        definitionId,
        availability:1
      }));
      player.hand = undefined;
      player.handCount = definitions.length;
    }
    return simulator.clone(specialized);
  }

  /*
  功能
  枚举一个状态的后续合法候选并返回其中最高的状态效用。

  调用方
  evaluateSpyGapInformationValue。

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
      const utility = this.evaluator.stateUtility(after, actorId, searchBudget);
      if (utility > best) best = utility;
    }
    if (this.isInterrupted(searchBudget)) return null;
    return Number.isFinite(best)
      ? best
      : this.evaluator.stateUtility(state, actorId, searchBudget);
  }

  /*
  功能
  用惰性匿名手牌采样估算窥隙信息的自适应选择价值。

  调用方
  candidateTerms 的根层信息价值分支。

  输入
  before/after、viewer ID、复用 Simulator、领域 context 与可选搜索预算。

  输出
  非负的 raw information option value；无样本或目标缺失时为零。

  读取状态
  context 当前 Probability 查询输入、afterState 后续候选与 stateUtility。

  写入状态
  只写 Simulator 返回的独立世界。

  调用函数
  specializeHiddenWorld、bestFollowUpUtility。

  边界与不变量
  E[max utility] - max E[utility] 只允许非负；该值描述“知道后可改选”的增量，不是固定窥探奖励。
  */
  evaluateSpyGapInformationValue(beforeState, afterState, action, actorId, simulator, context, searchBudget = null) {
    const targetId = this.newlyTriggeredSpyGapTarget(beforeState, afterState, actorId);
    if (!targetId) return 0;
    const handSamples = this.getUnknownHandEstimate(context).worlds;
    if (!handSamples.length) return 0;
    if (this.isInterrupted(searchBudget)) return null;
    const baselineBest = this.bestFollowUpUtility(afterState, actorId, simulator, searchBudget);
    if (baselineBest === null) return null;
    let informedTotal = 0;
    for (const world of handSamples) {
      if (this.isInterrupted(searchBudget)) return null;
      const specializedBefore = this.specializeHiddenWorld(beforeState, world, actorId, simulator);
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
      informedTotal += informedBest;
    }
    return Math.max(0, informedTotal / handSamples.length - baselineBest);
  }

  /*
  功能
  用真实模拟计算新增一层破势对下一次合法突袭的最大正边际。

  调用方
  candidateTerms 与领域边际测试。

  输入
  动作前后 World、行动者 ID、复用 Simulator 与可选 SearchBudget。

  输出
  下一次突袭的最大非负效用增量。

  读取状态
  输入 World、深层动作生成能力与 evaluator。

  写入状态
  只写 Simulator 返回的独立反事实状态。

  调用函数
  generate、Simulator.apply、evaluator.stateUtility。

  边界与不变量
  baseline 只回退本动作新增层数；同一合法突袭的 paired worlds 仅改变被测层数；
  nested State Value 查询继承同一 SearchBudget。
  */
  evaluateExposeMarginal(beforeState, afterState, actorId, simulator, searchBudget = null) {
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    const addedStacks = (afterActor?.exposeWeaknessStacks ?? 0)
      - (beforeActor?.exposeWeaknessStacks ?? 0);
    if (!(addedStacks > 0)) return 0;
    if (this.isInterrupted(searchBudget)) return null;
    const baselineState = structuredClone(afterState);
    const baselineActor = baselineState.players.find((entry) => entry.id === actorId);
    baselineActor.exposeWeaknessStacks = Math.max(
      0,
      (baselineActor.exposeWeaknessStacks ?? 0) - addedStacks
    );
    const candidates = this.generateActions(afterState, actorId, searchBudget);
    let best = 0;
    for (const candidate of candidates) {
      if (candidate.card?.definitionId !== "assault") continue;
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeSimulation();
      const base = simulator.apply(baselineState, candidate);
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeSimulation();
      const boosted = simulator.apply(afterState, candidate);
      if (this.isInterrupted(searchBudget)) return null;
      searchBudget?.observeCounterfactual(2);
      const marginal = this.evaluator.transitionDelta(
        base,
        boosted,
        actorId,
        searchBudget
      );
      if (marginal > best) best = marginal;
    }
    return best;
  }

  /*
  功能
  计算回合开始时已有破势层在同一突袭动作上的消费侧配对反事实边际。

  调用方
  candidateTerms 与领域边际测试。

  输入
  当前 World、突袭动作、行动者 ID、剩余旧层、复用 Simulator 与可选 SearchBudget。

  输出
  非负旧层消费信用。

  读取状态
  当前过滤状态与回合开始时已有层的来源记录。

  写入状态
  只写两个独立克隆及 Simulator 返回状态。

  调用函数
  Simulator.apply、evaluator.stateUtility。

  边界与不变量
  paired worlds 只改变 exposeWeaknessStacks；负边际仍截为零；
  nested State Value 查询继承同一 SearchBudget。
  */
  evaluateAssaultStacksMarginal(
    currentState,
    action,
    actorId,
    remainingRootExposeStacks,
    simulator,
    searchBudget = null
  ) {
    if (!(remainingRootExposeStacks > 0)) return 0;
    if (this.isInterrupted(searchBudget)) return null;
    const boostedState = structuredClone(currentState);
    const baselineState = structuredClone(currentState);
    const boostedActor = boostedState.players.find((entry) => entry.id === actorId);
    const baselineActor = baselineState.players.find((entry) => entry.id === actorId);
    boostedActor.exposeWeaknessStacks = remainingRootExposeStacks;
    baselineActor.exposeWeaknessStacks = 0;
    searchBudget?.observeSimulation();
    const boosted = simulator.apply(boostedState, action);
    if (this.isInterrupted(searchBudget)) return null;
    searchBudget?.observeSimulation();
    const baseline = simulator.apply(baselineState, action);
    if (this.isInterrupted(searchBudget)) return null;
    searchBudget?.observeCounterfactual(2);
    const marginal = this.evaluator.transitionDelta(
      baseline,
      boosted,
      actorId,
      searchBudget
    );
    return marginal > 0 ? marginal : 0;
  }

  /*
  功能
  按真实模拟前后层数保留比例推进回合开始时已有层的来源记录。

  调用方
  candidateTerms 与 provenance 回归测试。

  输入
  before/after World、行动者 ID 与当前剩余旧层。

  输出
  下一节点的剩余旧层期望量。

  读取状态
  行动者前后 exposeWeaknessStacks。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只由消费动作调用；新获得层数不进入回合开始时已有层的来源记录。
  */
  advanceRemainingRootExposeStacks(
    beforeState,
    afterState,
    actorId,
    remainingRootStacks
  ) {
    if (!(remainingRootStacks > 0)) return 0;
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    const beforeStacks = beforeActor?.exposeWeaknessStacks ?? 0;
    const afterStacks = afterActor?.exposeWeaknessStacks ?? 0;
    if (!(beforeStacks > 0)) return 0;
    const retainRatio = Math.max(0, afterStacks / beforeStacks);
    return Math.max(0, remainingRootStacks * retainRatio);
  }

  /*
  功能
  为单个候选产生领域边际与下一节点 provenance。

  调用方
  CandidateMaterializer.materialize。

  输入
  before/after、动作、行动者、搜索深度、回合开始时已有层的来源记录与 Simulator。

  输出
  exposeMarginal、assaultStacksCredit 与 remainingProvenance。

  读取状态
  候选动作定义及配对反事实所需过滤状态。

  写入状态
  仅通过反事实辅助函数写独立状态。

  调用函数
  evaluateExposeMarginal、evaluateAssaultStacksMarginal、advanceRemainingRootExposeStacks。

  边界与不变量
  破势边际只作为 Search Prior 的原始状态效用差，不进入 final value；
  窥隙信息项是有限隐藏世界采样得到的 Monte Carlo 价值估计，不得解释为 continuation 概率；
  只在真实执行后会立即重规划的根动作估算该选择价值，避免深层反事实递归枚举隐藏世界。
  */
  candidateTerms({
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
    const exposeMarginal = action.cardId === "exposeWeakness"
      ? this.evaluateExposeMarginal(
          beforeState,
          afterState,
          actorId,
          simulator,
          searchBudget
        )
      : 0;
    if (exposeMarginal === null) return null;
    const assaultStacksCredit = action.cardId === "assault"
      ? this.evaluateAssaultStacksMarginal(
          beforeState,
          action,
          actorId,
          remainingProvenance,
          simulator,
          searchBudget
        )
      : 0;
    if (assaultStacksCredit === null) return null;
    const nextProvenance = action.cardId === "assault"
      ? this.advanceRemainingRootExposeStacks(
          beforeState,
          afterState,
          actorId,
          remainingProvenance
        )
      : remainingProvenance;
    const spyGapInformationValue = depth === 1
      ? this.evaluateSpyGapInformationValue(
          beforeState,
          afterState,
          action,
          actorId,
          simulator,
          context,
          searchBudget
        )
      : 0;
    if (spyGapInformationValue === null) return null;
    return {
      exposeMarginal,
      assaultStacksCredit,
      spyGapInformationValue,
      nextProvenance
    };
  }

}
