/*
模块职责
唯一拥有破势准备侧、既有层消费侧及 provenance（价值来源记录）的 counterfactual（反事实对照世界）配对项。

上游
CandidateMaterializer 与破势边际回归测试。

下游
Simulator、State Value、深层动作生成与合法隐藏世界采样。

状态边界
只读 SearchState；所有反事实写入独立克隆或由 Simulator 返回的新状态。

信息边界
隐藏信息只来自注入的合法采样能力，不读取 GameState 或 Controller。

架构约束
baseline（基线世界）与 boosted（只增强被测因素的世界）必须成对；本模块只产生破势数值项、先验和来源记录，不拥有同层时机、最终价值、束裁剪或同分裁决。
*/

import {
  PROBABILITY_EPSILON,
  clampProbability,
  totalBranchProbability
} from "../state/Probability.js?build=20260815-shadow-agent-p1-slot";

export class CounterfactualTerms {
  /*
  功能
  绑定破势反事实、深层生成与隐藏世界能力。

  调用方
  AIController 组合根与 Planner 正式边界。

  输入
  evaluator、generateFromVisible、sampleHiddenWorlds 与隐藏样本数。

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
    generateFromVisible,
    sampleHiddenWorlds,
    hiddenSampleCount
  } = {}) {
    const services = { evaluator };
    const capabilities = { generateFromVisible, sampleHiddenWorlds };
    for (const [name, service] of Object.entries(services)) {
      if (!service) throw new TypeError(`CounterfactualTerms 缺少依赖：${name}`);
    }
    for (const [name, capability] of Object.entries(capabilities)) {
      if (typeof capability !== "function") {
        throw new TypeError(`CounterfactualTerms 缺少依赖：${name}`);
      }
    }
    this.evaluator = evaluator;
    this.generateFromVisible = generateFromVisible;
    this.sampleHiddenWorlds = sampleHiddenWorlds;
    this.hiddenSampleCount = hiddenSampleCount;
  }

  /*
  功能
  为一次根搜索冻结隐藏样本、回合开始时已有破势层的来源记录与动态目标诊断基线。

  调用方
  CandidateMaterializer.createContext。

  输入
  行动者、根 SearchState 与根动作集合。

  输出
  当前搜索唯一的领域 transition context。

  读取状态
  行动者过滤状态与合法隐藏世界采样能力。

  写入状态
  消耗既有采样随机序列，创建独立诊断 Set。

  调用函数
  sampleHiddenWorlds。

  边界与不变量
  每次 plan 只采样一次；样本数量和根动作扫描顺序保持不变。
  */
  createContext(player, visibleState, rootActions) {
    const rootActor = visibleState.players.find((entry) => entry.id === player.id);
    const rootAssaultTargets = new Set(
      rootActions
        .filter((action) => action.card?.definitionId === "assault")
        .map((action) => action.targets?.[0]?.id)
    );
    return {
      hiddenWorlds:this.sampleHiddenWorlds(
        player,
        visibleState,
        this.hiddenSampleCount
      ),
      rootProvenance:rootActor?.exposeWeaknessStacks ?? 0,
      rootAssaultTargets,
      discoveredDynamicTarget:false
    };
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
    if (action.card?.definitionId === "assault"
      && !context.rootAssaultTargets.has(action.targets?.[0]?.id)) {
      context.discoveredDynamicTarget = true;
    }
  }

  /*
  功能
  计算隐藏世界格挡对突袭候选的既有搜索先验调整。

  调用方
  CandidateMaterializer.materialize。

  输入
  候选动作与当前搜索领域 context。

  输出
  仅用于 pruneScore 的数值 prior。

  读取状态
  已冻结隐藏样本与目标标识。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  系数 -1.5、样本分母与零样本行为保持不变，不进入 final value。
  */
  hiddenPrior(action, context) {
    const hiddenWorlds = context.hiddenWorlds;
    if (action.card?.definitionId !== "assault" || !hiddenWorlds.length) return 0;
    const targetId = action.targets?.[0]?.id;
    if (!targetId) return 0;
    return -1.5 * hiddenWorlds.filter(
      (world) => world[targetId]?.includes("block")
    ).length / hiddenWorlds.length;
  }

  /*
  功能
  判断一次模拟 transition 是否新触发了影客窥隙。

  调用方
  candidateTerms 的信息价值分支。

  输入
  before/after SearchState 与候选动作。

  输出
  新触发时返回被观察者 ID，否则返回 null。

  读取状态
  双方 spyGapTriggeredProbability、generalId 与 lastSpyGapTargetId。

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
    if (afterActor?.generalId !== "shade-agent") return null;
    const beforeProbability = clampProbability(beforeActor?.spyGapTriggeredProbability
      ?? (beforeActor?.spyGapTriggered ? 1 : 0));
    const afterProbability = clampProbability(afterActor?.spyGapTriggeredProbability
      ?? (afterActor?.spyGapTriggered ? 1 : 0));
    if (afterProbability - beforeProbability <= PROBABILITY_EPSILON) return null;
    return afterActor.lastSpyGapTargetId ?? null;
  }

  /*
  功能
  为隐藏世界采样构造敌方手牌完全确定的 SearchState 分支。

  调用方
  evaluateSpyGapInformationValue。

  输入
  before SearchState、一个隐藏世界、viewer ID 与复用 Simulator。

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
    const remainingCounts = specialized.remainingCardCounts
      ? { ...specialized.remainingCardCounts }
      : null;
    for (const player of specialized.players ?? []) {
      if (player.id === actorId) continue;
      const definitions = world?.[player.id] ?? [];
      const beforePlayer = beforeState.players.find((entry) => entry.id === player.id);
      const certainKnownCount = (beforePlayer?.knownCards ?? []).filter((entry) => {
        const branches = entry.availabilityStateBranches ?? entry.availabilityBranches;
        if (!Array.isArray(branches)) return true;
        return totalBranchProbability(
          branches.filter((branch) => branch.available !== false)
        ) >= 1 - PROBABILITY_EPSILON;
      }).length;
      if (remainingCounts) {
        for (const definitionId of definitions.slice(certainKnownCount)) {
          if (Number.isFinite(remainingCounts[definitionId])) {
            remainingCounts[definitionId] = Math.max(0, (remainingCounts[definitionId] ?? 0) - 1);
          }
        }
      }
      player.knownCards = definitions.map((definitionId, index) => ({
        cardId:`revealed:${player.id}:${index}`,
        definitionId,
        availabilityBranches:[{ probability:1, conditions:{} }]
      }));
      player.hand = undefined;
      player.handCount = definitions.length;
      delete player.anonymousCountBranches;
      delete player.blockCountDistribution;
      delete player.counterCountDistribution;
      delete player.assaultCountDistribution;
    }
    if (remainingCounts) specialized.remainingCardCounts = remainingCounts;
    return simulator.clone(specialized);
  }

  /*
  功能
  枚举一个状态的后续合法候选并返回其中最高的状态效用。

  调用方
  evaluateSpyGapInformationValue。

  输入
  SearchState、viewer ID、复用 Simulator 与可选搜索预算。

  输出
  最佳后续状态效用；没有候选时返回当前状态效用。

  读取状态
  generateFromVisible、Simulator.apply 与 evaluator.stateUtility。

  写入状态
  只写 Simulator 返回的独立后续状态。

  调用函数
  generateFromVisible、simulator.apply、evaluator.stateUtility。

  边界与不变量
  每个候选从同一输入状态独立模拟；end 候选保持生成顺序参与同分。
  */
  bestFollowUpUtility(state, actorId, simulator, searchBudget = null) {
    const candidates = this.generateFromVisible(state, actorId);
    let best = -Infinity;
    for (const candidate of candidates) {
      searchBudget?.observeSimulation();
      const after = simulator.apply(state, candidate, actorId);
      const utility = this.evaluator.stateUtility(after, actorId);
      if (utility > best) best = utility;
    }
    return Number.isFinite(best) ? best : this.evaluator.stateUtility(state, actorId);
  }

  /*
  功能
  用隐藏世界采样估算窥隙信息的自适应选择价值。

  调用方
  candidateTerms 的根层信息价值分支。

  输入
  before/after、viewer ID、复用 Simulator、领域 context 与可选搜索预算。

  输出
  非负的 raw information option value；无样本或目标缺失时为零。

  读取状态
  context.hiddenWorlds、afterState 后续候选与 stateUtility。

  写入状态
  只写 Simulator 返回的独立世界。

  调用函数
  specializeHiddenWorld、bestFollowUpUtility。

  边界与不变量
  E[max utility] - max E[utility] 只允许非负；该值描述“知道后可改选”的增量，不是固定窥探奖励。
  */
  evaluateSpyGapInformationValue(beforeState, afterState, action, actorId, simulator, context, searchBudget = null) {
    const targetId = this.newlyTriggeredSpyGapTarget(beforeState, afterState, actorId);
    if (!targetId || !context?.hiddenWorlds?.length) return 0;
    const baselineBest = this.bestFollowUpUtility(afterState, actorId, simulator, searchBudget);
    let informedTotal = 0;
    for (const world of context.hiddenWorlds) {
      const specializedBefore = this.specializeHiddenWorld(beforeState, world, actorId, simulator);
      searchBudget?.observeSimulation();
      const specializedAfter = simulator.apply(specializedBefore, action, actorId);
      informedTotal += this.bestFollowUpUtility(specializedAfter, actorId, simulator, searchBudget);
    }
    return Math.max(0, informedTotal / context.hiddenWorlds.length - baselineBest);
  }

  /*
  功能
  用真实模拟计算新增一层破势对下一次合法突袭的最大正边际。

  调用方
  candidateTerms 与领域边际测试。

  输入
  动作前后 SearchState、行动者 ID 与复用 Simulator。

  输出
  下一次突袭的最大非负效用增量。

  读取状态
  输入 SearchState、深层动作生成能力与 evaluator。

  写入状态
  只写 Simulator 返回的独立反事实状态。

  调用函数
  generateFromVisible、Simulator.apply、evaluator.stateUtility。

  边界与不变量
  baseline 只回退本动作新增层数；同一合法突袭的 paired worlds 仅改变被测层数。
  */
  evaluateExposeMarginal(beforeState, afterState, actorId, simulator, searchBudget = null) {
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    const addedStacks = (afterActor?.exposeWeaknessStacks ?? 0)
      - (beforeActor?.exposeWeaknessStacks ?? 0);
    if (!(addedStacks > 0)) return 0;
    const baselineState = structuredClone(afterState);
    const baselineActor = baselineState.players.find((entry) => entry.id === actorId);
    baselineActor.exposeWeaknessStacks = Math.max(
      0,
      (baselineActor.exposeWeaknessStacks ?? 0) - addedStacks
    );
    const candidates = this.generateFromVisible(afterState, actorId);
    let best = 0;
    for (const candidate of candidates) {
      if (candidate.card?.definitionId !== "assault") continue;
      searchBudget?.observeSimulation(2);
      const base = simulator.apply(baselineState, candidate, actorId);
      const boosted = simulator.apply(afterState, candidate, actorId);
      searchBudget?.observeCounterfactual(2);
      const marginal = this.evaluator.stateUtility(boosted, actorId)
        - this.evaluator.stateUtility(base, actorId);
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
  当前 SearchState、突袭动作、行动者 ID、剩余旧层与复用 Simulator。

  输出
  非负旧层消费信用。

  读取状态
  当前过滤状态与回合开始时已有层的来源记录。

  写入状态
  只写两个独立克隆及 Simulator 返回状态。

  调用函数
  Simulator.apply、evaluator.stateUtility。

  边界与不变量
  paired worlds 只改变 exposeWeaknessStacks；负边际仍截为零。
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
    const boostedState = structuredClone(currentState);
    const baselineState = structuredClone(currentState);
    const boostedActor = boostedState.players.find((entry) => entry.id === actorId);
    const baselineActor = baselineState.players.find((entry) => entry.id === actorId);
    boostedActor.exposeWeaknessStacks = remainingRootExposeStacks;
    baselineActor.exposeWeaknessStacks = 0;
    searchBudget?.observeSimulation(2);
    const boosted = simulator.apply(boostedState, action, actorId);
    const baseline = simulator.apply(baselineState, action, actorId);
    searchBudget?.observeCounterfactual(2);
    const marginal = this.evaluator.stateUtility(boosted, actorId)
      - this.evaluator.stateUtility(baseline, actorId);
    return marginal > 0 ? marginal : 0;
  }

  /*
  功能
  按真实模拟前后层数保留比例推进回合开始时已有层的来源记录。

  调用方
  candidateTerms 与 provenance 回归测试。

  输入
  before/after SearchState、行动者 ID 与当前剩余旧层。

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
  before/after、动作、行动者、深度、回合开始时已有层的来源记录与 Simulator。

  输出
  exposeMarginal、assaultStacksCredit 与 remainingProvenance。

  读取状态
  候选动作定义及配对反事实所需过滤状态。

  写入状态
  仅通过反事实辅助函数写独立状态。

  调用函数
  evaluateExposeMarginal、evaluateAssaultStacksMarginal、advanceRemainingRootExposeStacks。

  边界与不变量
  两项边际在深层各除 depth 一次；根层 depth=1 保持原值。
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
    const exposeMarginal = action.card?.definitionId === "exposeWeakness"
      ? this.evaluateExposeMarginal(
          beforeState,
          afterState,
          actorId,
          simulator,
          searchBudget
        ) / depth
      : 0;
    const assaultStacksCredit = action.card?.definitionId === "assault"
      ? this.evaluateAssaultStacksMarginal(
          beforeState,
          action,
          actorId,
          remainingProvenance,
          simulator,
          searchBudget
        ) / depth
      : 0;
    const nextProvenance = action.card?.definitionId === "assault"
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
    return {
      exposeMarginal,
      assaultStacksCredit,
      spyGapInformationValue,
      nextProvenance
    };
  }

}
