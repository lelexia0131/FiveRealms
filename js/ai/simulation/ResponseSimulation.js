/*
模块职责
镜像 SearchState 中的格挡、反制、护援与响应资源容量，不拥有响应策略。

上游
Simulator facade 与 Combat/Card/Status simulation components。

下游
state/Probability、正式 ResponsePolicy、GlobalBenefit assessment 与共享 simulation runtime。

状态边界
只修改 facade 提供的独立 SearchState clone 及其概率分支。

信息边界
未知手牌只按合法 knownCards、handCount 与 remaining counts 建模。

架构约束
不得读取 Game/UI/Controller/Planner，不得复制 Policy、Value 或真实规则实现。
*/
import { assessGlobalBenefit } from "../AiGlobalBenefit.js?build=20260814-ai-simulation-engine";
import { planningCounterDesire, planningDynamicCounterGain } from "../policy/ResponsePolicy.js?build=20260814-ai-simulation-engine";
import { PROBABILITY_EPSILON, availableBranchesFromState, expectedBranchValue, getAvailabilityBranches, getAvailabilityStateBranches, getValueBranches, joinProbabilityStateBranches, mergeProbabilityStateBranches, probabilityEventPartition, projectProbabilityStateBranches, totalBranchProbability } from "../state/Probability.js?build=20260814-ai-simulation-engine";
import { clampProbability, remainingCardDensity, unionProbability } from "./SimulationSupport.js?build=20260814-ai-simulation-engine";

/*
功能
把 Base class 与 ResponseSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator 模块加载期的唯一组件组合表达式。

输入
承载上一层方法的 Base class。

输出
增加本组件方法的派生 class。

读取状态
不读取运行时状态。

写入状态
不写 SearchState；只在模块加载时创建 class。

调用函数
JavaScript class inheritance。

边界与不变量
每个组件只组合一次，不得在搜索 node 或 action 中创建额外实例。
*/
export const withResponseSimulation = (Base) => class ResponseSimulation extends Base {
  /** 初始化或保留每个玩家的格挡数量分布；分布是后续 blockProbability 的唯一来源。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 initializeBlockCountDistributions。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  initializeBlockCountDistributions(state) {
    for (const player of state?.players ?? []) {
      if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
        player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, state?.remainingCardCounts ?? null);
      }
      this.syncBlockSummary(player);
    }
  }

  /** 为缺少分布的旧快照/测试状态构造兼容初始分布；生产可见状态始终自带分布。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 buildInitialBlockCountDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  buildInitialBlockCountDistribution(player, remainingCardCounts = null) {
    const explicit = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ].filter((card) => card?.definitionId === "block")
      .reduce((sum, card) => sum + this.cardAvailability(card), 0);
    if (explicit > PROBABILITY_EPSILON
      && Math.abs(Number(player.handCount ?? 0) - explicit) < PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, blockCount:Math.max(0, Math.round(explicit)) }];
    }
    if (explicit > PROBABILITY_EPSILON) {
      return this.cardEstimateDistribution(player, "block", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, blockCount:branch.count }));
    }
    if (player.blockProbability == null) {
      return this.cardEstimateDistribution(player, "block", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, blockCount:branch.count }));
    }
    const blockProbability = clampProbability(player.blockProbability ?? 0);
    const twoBlockProbability = clampProbability(player.twoBlockProbability ?? 0);
    if (blockProbability <= PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, blockCount:0 }];
    }
    if (twoBlockProbability >= 1 - PROBABILITY_EPSILON) {
      const count = Math.max(2, Math.ceil(Number(player.handCount) || 0));
      return [{ probability:1, conditions:{}, blockCount:count }];
    }
    const branches = [
      { probability:Math.max(0, 1 - blockProbability), conditions:{}, blockCount:0 },
      { probability:Math.max(0, blockProbability - twoBlockProbability), conditions:{}, blockCount:1 },
      { probability:twoBlockProbability, conditions:{}, blockCount:2 }
    ].filter((branch) => branch.probability > PROBABILITY_EPSILON);
    const total = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return total > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / total }))
      : [{ probability:1, conditions:{}, blockCount:0 }];
  }

  /** 把格挡数量分布同步为 blockProbability / twoBlockProbability，并规范化分布。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 syncBlockSummary。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  syncBlockSummary(player) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = [{ probability:1, conditions:{}, blockCount:0 }];
    }
    const branches = mergeProbabilityStateBranches(
      player.blockCountDistribution.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        blockCount:Math.max(0, Math.floor(Number(branch.blockCount ?? branch.count) || 0))
      }))
    );
    player.blockCountDistribution = branches;
    player.blockProbability = branches.reduce(
      (sum, branch) => sum + (branch.blockCount >= 1 ? branch.probability : 0), 0
    );
    player.twoBlockProbability = branches.reduce(
      (sum, branch) => sum + (branch.blockCount >= 2 ? branch.probability : 0), 0
    );
    return branches;
  }

  /** 返回可用于 joinProbabilityStateBranches 的格挡数量状态分支。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 getBlockCountBranches。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  getBlockCountBranches(player, remainingCardCounts = null) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    return this.syncBlockSummary(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      blockCount:branch.blockCount
    }));
  }

  /**
   * 构造每个条件世界中的确定格挡数量。
   * 只统计 hand / knownCards 中 definitionId === "block" 的身份，
   * 按 availabilityStateBranches 逐张累加，不修改状态、不生成新随机事件。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 getKnownBlockCountBranches。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  getKnownBlockCountBranches(player) {
    const cards = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "block") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "block") : [])
    ];
    let branches = [{ probability:1, conditions:{}, knownBlockCount:0 }];
    for (const card of cards) {
      const availabilityState = getAvailabilityStateBranches(card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(branches, availabilityState);
      branches = projectProbabilityStateBranches(joined, (branch) => ({
        knownBlockCount:branch.knownBlockCount + (branch.available ? 1 : 0)
      }));
    }
    return branches;
  }

  /** 确保玩家拥有合法格挡分布；已有分布不会被覆盖。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 ensureBlockCountDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  ensureBlockCountDistribution(player, remainingCardCounts = null) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    return this.syncBlockSummary(player);
  }

  /** 初始化或保留每个玩家的反制数量分布；分布是后续 counterProbability 的唯一来源。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 initializeCounterCountDistributions。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  initializeCounterCountDistributions(state) {
    for (const player of state?.players ?? []) {
      if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
        player.counterCountDistribution = this.buildInitialCounterCountDistribution(
          player, state?.remainingCardCounts ?? null
        );
      }
      this.syncCounterSummary(player);
    }
  }

  /** 为缺少反制分布的旧快照/测试状态构造兼容初始分布。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 buildInitialCounterCountDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  buildInitialCounterCountDistribution(player, remainingCardCounts = null) {
    if (Array.isArray(player.hand)) {
      // 当前 AI 自己拥有完整 hand：反制数量可直接由具体身份确定，不再按根密度估算。
      const explicitCount = player.hand.filter((card) => card?.definitionId === "counter")
        .reduce((sum, card) => sum + this.cardAvailability(card), 0);
      return [{ probability:1, conditions:{}, counterCount:Math.max(0, Math.round(explicitCount)) }];
    }
    const explicit = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ].filter((card) => card?.definitionId === "counter")
      .reduce((sum, card) => sum + this.cardAvailability(card), 0);
    if (explicit > PROBABILITY_EPSILON
      && Math.abs(Number(player.handCount ?? 0) - explicit) < PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, counterCount:Math.max(0, Math.round(explicit)) }];
    }
    if (explicit > PROBABILITY_EPSILON) {
      return this.cardEstimateDistribution(player, "counter", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, counterCount:branch.count }));
    }
    if (player.counterProbability == null) {
      return this.cardEstimateDistribution(player, "counter", remainingCardCounts)
        .map((branch) => ({ probability:branch.probability, conditions:{}, counterCount:branch.count }));
    }
    const counterProbability = clampProbability(player.counterProbability ?? 0);
    if (counterProbability <= PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, counterCount:0 }];
    }
    const branches = [
      { probability:Math.max(0, 1 - counterProbability), conditions:{}, counterCount:0 },
      { probability:counterProbability, conditions:{}, counterCount:1 }
    ].filter((branch) => branch.probability > PROBABILITY_EPSILON);
    const total = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return total > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / total }))
      : [{ probability:1, conditions:{}, counterCount:0 }];
  }

  /** 把反制数量分布同步为 counterProbability（P(count >= 1)），并规范化分布。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 syncCounterSummary。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  syncCounterSummary(player) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
    }
    const branches = mergeProbabilityStateBranches(
      player.counterCountDistribution.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        counterCount:Math.max(0, Math.floor(Number(branch.counterCount ?? branch.count) || 0))
      }))
    );
    player.counterCountDistribution = branches;
    const counterProbability = Math.max(0, Math.min(1, branches.reduce(
      (sum, branch) => sum + (branch.counterCount >= 1 ? branch.probability : 0), 0
    )));
    player.counterProbability = counterProbability >= 1 - PROBABILITY_EPSILON
      ? 1
      : counterProbability <= PROBABILITY_EPSILON ? 0 : counterProbability;
    return branches;
  }

  /** 返回可用于 joinProbabilityStateBranches 的反制数量状态分支。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 getCounterCountBranches。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  getCounterCountBranches(player, remainingCardCounts = null) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    return this.syncCounterSummary(player).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      counterCount:branch.counterCount
    }));
  }

  /** 构造每个条件世界中的确定反制数量；只统计 counter 身份可用性，不生成新随机事件。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 getKnownCounterCountBranches。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  getKnownCounterCountBranches(player) {
    const cards = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "counter") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "counter") : [])
    ];
    let branches = [{ probability:1, conditions:{}, knownCounterCount:0 }];
    for (const card of cards) {
      const availabilityState = getAvailabilityStateBranches(card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(branches, availabilityState);
      branches = projectProbabilityStateBranches(joined, (branch) => ({
        knownCounterCount:branch.knownCounterCount + (branch.available ? 1 : 0)
      }));
    }
    return branches;
  }

  /** 确保玩家拥有合法反制分布；已有分布不会被覆盖。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 ensureCounterCountDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  ensureCounterCountDistribution(player, remainingCardCounts = null) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    return this.syncCounterSummary(player);
  }

  /** 手牌清空后反制容量与身份必须同步归零，避免“count>0 但无牌可持”的幽灵状态。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 clearCountersWhenHandEmpty。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  clearCountersWhenHandEmpty(player) {
    if (!player || (player.handCount ?? 0) > PROBABILITY_EPSILON) return;
    player.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
    if (Array.isArray(player.hand)) {
      player.hand = player.hand.filter((card) => card.definitionId !== "counter");
    }
    if (Array.isArray(player.knownCards)) {
      player.knownCards = player.knownCards.filter((entry) => entry.definitionId !== "counter");
    }
    this.syncCounterSummary(player);
  }

  /** 在实际获得确定反制的世界中，让反制数量 +1。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 addKnownCounterToDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  addKnownCounterToDistribution(state, player, gainWorlds) {
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(counterState, partition);
    player.counterCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      counterCount:branch.counterCount + (branch.gained ? 1 : 0)
    }));
    this.syncCounterSummary(player);
  }

  /** 匿名反制容量转移：只按来源共享世界为接收者 +1，不加入根先验、不创建身份。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 addTransferredCounterCapacity。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  addTransferredCounterCapacity(state, player, transferWorlds) {
    if (!player || !Array.isArray(transferWorlds) || !transferWorlds.length) return;
    this.addKnownCounterToDistribution(state, player, transferWorlds);
  }

  /** 在实际失去确定反制的世界中，让反制数量 -1，且不低于 0。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 removeKnownCounterFromDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  removeKnownCounterFromDistribution(state, player, removalWorlds) {
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = removalWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      removed:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(counterState, partition);
    player.counterCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      counterCount:Math.max(0, branch.counterCount - (branch.removed ? 1 : 0))
    }));
    this.syncCounterSummary(player);
  }

  /** 只为真正新增的匿名牌叠加一次根先验，不对旧手牌重新抽样。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 addOneUnknownCardToCounterDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  addOneUnknownCardToCounterDistribution(state, player, gainWorlds) {
    const density = remainingCardDensity(state?.remainingCardCounts, "counter");
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(counterState, partition);
    const outcomes = [];
    for (const branch of joined) {
      if (branch.gained && density > 0) {
        outcomes.push({
          probability:branch.probability * (1 - density),
          conditions:branch.conditions,
          counterCount:branch.counterCount
        });
        outcomes.push({
          probability:branch.probability * density,
          conditions:branch.conditions,
          counterCount:branch.counterCount + 1
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:branch.counterCount
        });
      }
    }
    player.counterCountDistribution = mergeProbabilityStateBranches(outcomes);
    this.syncCounterSummary(player);
  }

  /**
   * 统一匿名摸牌入口：只增加 handCount，并对每张真正新获得的匿名牌叠加一次
   * 反制根先验。整数张数复用同一个“摸牌事件是否发生”世界（同发生同不发生）；
   * 非整数期望通过事件 gate 表示“是否获得最后一张”，不增加半张牌容量。
   * amount 也可以传函数：按每个条件世界各自应摸张数摸牌，摸牌数与对应的
   * energyAmount/发动条件世界保持关联，不能用全局期望值重新独立抽样。
   * @returns {number} 实际获得的期望牌数
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 gainUnknownCardsWithCounterState。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  gainUnknownCardsWithCounterState(state, player, amount, eventWorlds = null, label = "unknown-draw") {
    if (!player) return 0;
    if (typeof amount !== "function" && amount <= PROBABILITY_EPSILON) return 0;
    const worlds = Array.isArray(eventWorlds) && eventWorlds.length
      ? eventWorlds
      : this.getEventWorlds(state, 1, null, label);
    const eventMass = this.eventProbability(worlds);
    if (eventMass <= PROBABILITY_EPSILON) return 0;
    if (typeof amount === "function") {
      const remainingByBranch = worlds.map((branch) => (
        branch.occurs ? Math.max(0, Number(amount(branch)) || 0) : 0
      ));
      let gained = 0;
      while (remainingByBranch.some((remaining) => remaining > PROBABILITY_EPSILON)) {
        const cardWorlds = [];
        for (let index = 0; index < worlds.length; index += 1) {
          const branch = worlds[index];
          const remaining = remainingByBranch[index];
          if (remaining <= PROBABILITY_EPSILON) {
            cardWorlds.push({ ...branch, occurs:false });
            continue;
          }
          const cardProbability = Math.min(1, remaining);
          if (cardProbability >= 1 - PROBABILITY_EPSILON) {
            cardWorlds.push({ ...branch, occurs:true });
          } else {
            const gate = probabilityEventPartition(
              this.nextProbabilityEventKey(state, `${label}:branch-card`),
              cardProbability,
              "gateOccurs"
            );
            for (const gated of joinProbabilityStateBranches([branch], gate)) {
              cardWorlds.push({ ...gated, occurs:Boolean(gated.gateOccurs) });
            }
          }
        }
        const cardGain = this.eventProbability(cardWorlds);
        if (cardGain <= PROBABILITY_EPSILON) break;
        player.handCount = (player.handCount ?? 0) + cardGain;
        this.addOneUnknownCardToCounterDistribution(state, player, cardWorlds);
        gained += cardGain;
        for (let index = 0; index < remainingByBranch.length; index += 1) {
          remainingByBranch[index] -= Math.min(1, remainingByBranch[index]);
        }
      }
      return gained;
    }
    let remaining = Math.max(0, Number(amount) || 0);
    let gained = 0;
    while (remaining > PROBABILITY_EPSILON) {
      const cardProbability = Math.min(1, remaining);
      const gateChance = Math.min(1, cardProbability / eventMass);
      const cardWorlds = gateChance >= 1 - PROBABILITY_EPSILON
        ? worlds
        : this.gateEventWorlds(state, worlds, gateChance, `${label}:card`);
      const cardGain = this.eventProbability(cardWorlds);
      if (cardGain <= PROBABILITY_EPSILON) break;
      player.handCount = (player.handCount ?? 0) + cardGain;
      this.addOneUnknownCardToCounterDistribution(state, player, cardWorlds);
      gained += cardGain;
      remaining -= cardProbability;
    }
    return gained;
  }

  /** 在实际获得确定格挡的世界中，让格挡数量 +1。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 addKnownBlockToDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  addKnownBlockToDistribution(state, player, gainWorlds) {
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(blockState, partition);
    player.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:branch.blockCount + (branch.gained ? 1 : 0)
    }));
    this.syncBlockSummary(player);
  }

  /** 在实际失去确定格挡的世界中，让格挡数量 -1，且不低于 0。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 removeKnownBlockFromDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  removeKnownBlockFromDistribution(state, player, removalWorlds) {
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = removalWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      removed:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(blockState, partition);
    player.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:Math.max(0, branch.blockCount - (branch.removed ? 1 : 0))
    }));
    this.syncBlockSummary(player);
  }

  /** 只为真正新增的匿名牌叠加一次根先验，不对旧手牌重新抽样。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 addOneUnknownCardToBlockDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  addOneUnknownCardToBlockDistribution(state, player, gainWorlds) {
    const density = remainingCardDensity(state?.remainingCardCounts, "block");
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const partition = gainWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      gained:Boolean(branch.occurs ?? branch.available)
    }));
    const joined = joinProbabilityStateBranches(blockState, partition);
    const outcomes = [];
    for (const branch of joined) {
      if (branch.gained && density > 0) {
        outcomes.push({
          probability:branch.probability * (1 - density),
          conditions:branch.conditions,
          blockCount:branch.blockCount
        });
        outcomes.push({
          probability:branch.probability * density,
          conditions:branch.conditions,
          blockCount:branch.blockCount + 1
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:branch.blockCount
        });
      }
    }
    player.blockCountDistribution = mergeProbabilityStateBranches(outcomes);
    this.syncBlockSummary(player);
  }

  /**
   * 从当前格挡分布中按无放回条件概率移除匿名牌。
   * 只返回“实际移除”的世界，来源与接收者可共享同一组 blockRemoved 条件。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 removeUnknownCardsFromBlockDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  removeUnknownCardsFromBlockDistribution(
    state,
    player,
    expectedAmount,
    unknownCount,
    eventWorlds = null,
    label = "unknown-removal",
    adjustHandCount = true
  ) {
    this.ensureBlockCountDistribution(player, state?.remainingCardCounts ?? null);
    const unknown = Math.max(0, Number(unknownCount) || 0);
    const spent = Math.min(
      Math.max(0, Number(expectedAmount) || 0),
      unknown,
      Math.max(0, Number(player.handCount) || 0)
    );
    if (spent <= PROBABILITY_EPSILON || unknown <= 0) return { removed:0, identityWorlds:[] };
    const eventProbabilityValue = Array.isArray(eventWorlds) && eventWorlds.length
      ? this.eventProbability(eventWorlds)
      : 1;
    const removalProbability = eventProbabilityValue > 0
      ? Math.min(1, spent / eventProbabilityValue)
      : 0;
    let removalWorlds;
    if (Array.isArray(eventWorlds) && eventWorlds.length) {
      // 在效果世界内部按 spent 缩放“实际移除”事件，保证返回的移除期望等于 spent。
      removalWorlds = this.gateEventWorlds(state, eventWorlds, removalProbability, `${label}:gate`);
    } else {
      removalWorlds = probabilityEventPartition(
        this.nextProbabilityEventKey(state, label),
        removalProbability,
        "occurs"
      );
    }
    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const knownState = this.getKnownBlockCountBranches(player);
    const joined = joinProbabilityStateBranches(blockState, removalWorlds, knownState);
    const outcomes = [];
    for (const branch of joined) {
      const total = branch.blockCount;
      const known = branch.knownBlockCount;
      const anonymousBlocks = Math.max(0, Math.min(unknown, total - known));
      const occurs = Boolean(branch.occurs);
      if (occurs && anonymousBlocks > 0) {
        const removalChance = Math.min(1, anonymousBlocks / unknown);
        outcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          blockCount:Math.max(0, total - 1),
          occurs:true,
          blockRemoved:true
        });
        outcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          blockCount:total,
          occurs:true,
          blockRemoved:false
        });
      } else if (occurs) {
        // 移除事件发生，但该世界没有匿名格挡可移除，移除的是匿名非格挡。
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:total,
          occurs:true,
          blockRemoved:false
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:total,
          occurs:false,
          blockRemoved:false
        });
      }
    }
    player.blockCountDistribution = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        blockCount:branch.blockCount
      }))
    );
    this.syncBlockSummary(player);
    const identityWorlds = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.occurs,
        blockRemoved:branch.blockRemoved
      }))
    );
    let removed = totalBranchProbability(identityWorlds.filter((branch) => branch.occurs));
    if (Math.abs(removed - spent) <= PROBABILITY_EPSILON * 1e3) removed = spent;
    if (adjustHandCount) player.handCount = Math.max(0, (player.handCount ?? 0) - removed);
    return { removed, identityWorlds };
  }

  /**
   * 从当前反制分布中按无放回条件概率移除匿名牌。
   * 与格挡移除共享同一组“实际移除”条件世界；只更新反制容量，不重复扣减 handCount。
   * @returns {{removed:number, identityWorlds:Array}} 实际移除的反制期望与带 counterRemoved 的世界。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 removeUnknownCardsFromCounterDistribution。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  removeUnknownCardsFromCounterDistribution(
    state,
    player,
    expectedAmount,
    unknownCount,
    eventWorlds = null,
    label = "unknown-counter-removal",
    adjustHandCount = true
  ) {
    this.ensureCounterCountDistribution(player, state?.remainingCardCounts ?? null);
    const unknown = Math.max(0, Number(unknownCount) || 0);
    const spent = Math.min(
      Math.max(0, Number(expectedAmount) || 0),
      unknown,
      Math.max(0, Number(player.handCount) || 0)
    );
    if (spent <= PROBABILITY_EPSILON || unknown <= 0) return { removed:0, identityWorlds:[] };
    const eventProbabilityValue = Array.isArray(eventWorlds) && eventWorlds.length
      ? this.eventProbability(eventWorlds)
      : 1;
    const removalProbability = eventProbabilityValue > 0
      ? Math.min(1, spent / eventProbabilityValue)
      : 0;
    let removalWorlds;
    if (Array.isArray(eventWorlds) && eventWorlds.length) {
      removalWorlds = this.gateEventWorlds(state, eventWorlds, removalProbability, `${label}:gate`);
    } else {
      removalWorlds = probabilityEventPartition(
        this.nextProbabilityEventKey(state, label),
        removalProbability,
        "occurs"
      );
    }
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const knownState = this.getKnownCounterCountBranches(player);
    const joined = joinProbabilityStateBranches(counterState, removalWorlds, knownState);
    const outcomes = [];
    for (const branch of joined) {
      const total = branch.counterCount;
      const known = branch.knownCounterCount;
      const anonymousCounters = Math.max(0, Math.min(unknown, total - known));
      const occurs = Boolean(branch.occurs);
      if (occurs && anonymousCounters > 0) {
        const removalChance = Math.min(1, anonymousCounters / unknown);
        outcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          counterCount:Math.max(0, total - 1),
          occurs:true,
          counterRemoved:true
        });
        outcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          counterCount:total,
          occurs:true,
          counterRemoved:false
        });
      } else if (occurs) {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:total,
          occurs:true,
          counterRemoved:false
        });
      } else {
        outcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:total,
          occurs:false,
          counterRemoved:false
        });
      }
    }
    player.counterCountDistribution = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        counterCount:branch.counterCount
      }))
    );
    this.syncCounterSummary(player);
    const identityWorlds = mergeProbabilityStateBranches(
      outcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.occurs,
        counterRemoved:branch.counterRemoved
      }))
    );
    let removed = totalBranchProbability(identityWorlds.filter((branch) => branch.occurs));
    if (Math.abs(removed - spent) <= PROBABILITY_EPSILON * 1e3) removed = spent;
    if (adjustHandCount) player.handCount = Math.max(0, (player.handCount ?? 0) - removed);
    return { removed, identityWorlds };
  }

  /** 匿名牌转移：来源与接收者共享同一组“是否格挡/反制”条件世界。 */
  /*
  功能
  推进响应概率、容量或资源身份步骤 transferUnknownBlockCapacity。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  transferUnknownBlockCapacity(state, source, receiver, effectWorlds, unknownCount) {
    const { removed, identityWorlds } = this.removeUnknownCardsFromBlockDistribution(
      state,
      source,
      this.eventProbability(effectWorlds),
      unknownCount,
      effectWorlds,
      "transfer-unknown",
      false
    );
    if (removed <= PROBABILITY_EPSILON) return 0;
    this.downgradePartialKnownCardsAfterRandomLoss(source);
    const blockState = this.getBlockCountBranches(receiver, state?.remainingCardCounts ?? null);
    const joined = joinProbabilityStateBranches(blockState, identityWorlds);
    receiver.blockCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:branch.blockCount + (branch.occurs && branch.blockRemoved ? 1 : 0)
    }));
    this.syncBlockSummary(receiver);
    const counterRemoval = this.removeUnknownCardsFromCounterDistribution(
      state,
      source,
      removed,
      unknownCount,
      identityWorlds,
      "transfer-unknown-counter",
      false
    );
    source.handCount = Math.max(0, (source.handCount ?? 0) - removed);
    this.clearCountersWhenHandEmpty(source);
    const counterState = this.getCounterCountBranches(receiver, state?.remainingCardCounts ?? null);
    const joinedCounter = joinProbabilityStateBranches(counterState, counterRemoval.identityWorlds);
    receiver.counterCountDistribution = projectProbabilityStateBranches(joinedCounter, (branch) => ({
      counterCount:branch.counterCount + (branch.occurs && branch.counterRemoved ? 1 : 0)
    }));
    this.syncCounterSummary(receiver);
    receiver.handCount = (receiver.handCount ?? 0) + removed;
    this.syncCardEstimates(source, state?.remainingCardCounts);
    this.syncCardEstimates(receiver, state?.remainingCardCounts);
    return removed;
  }

  /**
  * 在包含“已格挡/未格挡”的完整世界分区中消费确定格挡身份。
   * 这里只更新 hand / knownCards 的身份可用性，不修改 handCount 或 blockCountDistribution；
   * 总格挡容量由 blockCountDistribution 统一扣减，避免两个入口重复计数。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 consumeBlockIdentities。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  consumeBlockIdentities(state, player, blockWorlds, excludedCardIds = null) {
    if (!player || !Array.isArray(blockWorlds) || !blockWorlds.length) return;
    const candidates = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "block") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "block") : [])
    ].filter((card) => !excludedCardIds?.has(card.id ?? card.cardId));
    if (!candidates.length) return;
    let remainingWorlds = blockWorlds.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      remaining:branch.blockUsed
        ? Math.max(0, Number(branch.requiredCount) || 1)
        : 0
    }));
    for (const card of candidates) {
      const availabilityState = getAvailabilityStateBranches(card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(remainingWorlds, availabilityState);
      if (!joined.length) break;
      const usedWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        used:Boolean(branch.available && branch.remaining > 0),
        remaining:Math.max(0, Number(branch.remaining) - (branch.available && branch.remaining > 0 ? 1 : 0))
      }));
      card.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.available && !(branch.available && branch.remaining > 0))
      }));
      card.availabilityBranches = availableBranchesFromState(card.availabilityStateBranches);
      if (totalBranchProbability(card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(player.hand)) player.hand = player.hand.filter((entry) => entry !== card);
        if (Array.isArray(player.knownCards)) player.knownCards = player.knownCards.filter((entry) => entry !== card);
      }
      remainingWorlds = usedWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        remaining:branch.remaining
      }));
      if (!remainingWorlds.some((branch) => branch.remaining > 0 && branch.probability > PROBABILITY_EPSILON)) break;
    }
  }

  /**
   * 护援只作用于通过雷达与格挡的伤害世界，并在护盾前计算弃牌与每轮次数的期望代价。
   * excludedGuardianIds 让调用方（护援响应决策）在 STAY 世界按 id 排除某位守誓者，
   * 使其拒绝护援、额度与手牌保留，而不为此另建第二套防御模拟。
   * 当守护者拥有完整且 100% 确定的手牌身份时，按共享保留价值确定性弃掉最低
   * keep-value 的牌；概率/匿名/身份不完整的手牌仍走随机期望消费。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 simulateGuardianAid。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  simulateGuardianAid(state, target, incomingDamage, eventProbability, excludedGuardianIds = null, options = {}) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) return Math.max(0, incomingDamage);
    const conditionalReduction = Math.min(1, incomingDamage / probability);
    let remainingTriggerProbability = probability;
    let expectedReduction = 0;
    for (const guardian of state.players) {
      if (remainingTriggerProbability <= PROBABILITY_EPSILON) break;
      if (excludedGuardianIds?.has(guardian.id)) continue;
      if (!guardian.alive || guardian.generalId !== "oath-warden" || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const oldUsedProbability = clampProbability(guardian.guardianAidUsedProbability
        ?? (guardian.guardianAidUsed ? 1 : 0));
      const handAvailability = Math.min(1, Math.max(0, Number(guardian.handCount) || 0));
      const triggerProbability = remainingTriggerProbability * (1 - oldUsedProbability) * handAvailability;
      if (triggerProbability <= 0) continue;
      if (this.hasCompleteCertainHand(guardian)) {
        this.consumeChosenHandCard(state, guardian, triggerProbability, options);
      } else {
        this.consumeRandomHandCards(state, guardian, triggerProbability);
      }
      guardian.guardianAidUsedProbability = clampProbability(oldUsedProbability + triggerProbability);
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - Number.EPSILON;
      expectedReduction += triggerProbability * conditionalReduction;
      remainingTriggerProbability = Math.max(0, remainingTriggerProbability - triggerProbability);
    }
    return Math.max(0, incomingDamage - expectedReduction);
  }

  /*
  功能
  推进响应概率、容量或资源身份步骤 tacticResolutionChance。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  tacticResolutionChance(state, actor, card, targets = [], selection = null) {
    if (card.category !== "tactic" || card.counterable === false) return 1;
    return this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection).resolutionChance;
  }

  /**
   * 同一 card-scope transition 的响应评估快照。
   *
   * responder 顺序严格沿用 state.players；effectiveProbability 同时决定边际取消概率
   * 与对应玩家的期望容量消费。结果只在当前 apply 调用内传递，不跨状态缓存。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 evaluateCardScopeCounterResponses。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  evaluateCardScopeCounterResponses(state, actor, card, targets = [], selection = null) {
    const contenders = [];
    let resolutionChance = 1;
    for (const player of state.players) {
      if (!player.alive || player.id === actor.id) continue;
      const counterProbability = clampProbability(player.counterProbability ?? 0);
      const desire = this.counterDesire(state, player, actor, card, targets, selection);
      const effectiveProbability = clampProbability(counterProbability * desire);
      contenders.push({ player, counterProbability, desire, effectiveProbability });
      resolutionChance *= 1 - effectiveProbability;
    }
    return { resolutionChance, contenders };
  }

  /**
   * card-scope 战术的反制容量消费（反制容量双算修复）。
   *
   * 按"第一个成功反制者"把取消概率归属到对应敌人，并按边际概率扣减其反制容量：
   *   marginal(e) = Π_{f before e}(1 - p_f) × p_e，p_e = counterProbability_e × desire_e
   * 消费量守恒：Σ marginal(e) = 1 - Π(1 - p_e) = 取消概率（与 tacticResolutionChance 一致）。
   * 只消费实际可能反制的玩家（p > 0）；与 tacticResolutionChance 使用相同的响应顺序。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 consumeCountersForCardScope。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  consumeCountersForCardScope(state, actor, card, targets, selection = null, responseEvaluation = null) {
    const evaluation = responseEvaluation
      ?? this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection);
    let notYetCancelled = 1;
    for (const { player, effectiveProbability } of evaluation.contenders) {
      const p = effectiveProbability;
      if (p <= PROBABILITY_EPSILON) continue;
      const marginal = notYetCancelled * p;
      if (marginal > PROBABILITY_EPSILON) {
        this.consumeExpectedCounters(state, player, marginal);
      }
      notYetCancelled *= 1 - p;
      if (notYetCancelled <= PROBABILITY_EPSILON) break;
    }
  }

  /**
   * 按期望数量消费一名玩家的反制容量（card-scope 概率近似中的"反制实际使用"）。
   *
   * 只扣减反制数量分布（counterCountDistribution → counterProbability）：这是
   * counterProbability 与 sealCounterProbability 的唯一来源，扣减后未来反制预期
   * 自然归零，消除"取消战术"与"封印反制"对同一张反制的重复计价。
   *
   * 不改动 handCount 与具体反制身份：card-scope 的反制本就是概率近似（敌手未必
   * 真持有反制卡），泛用手牌资源与具体身份由 target-scope 的真实消费路径处理，
   * 避免在这里对概率近似事件产生与真实消费重复的资源/身份记账。
   *
   * 期望扣减守恒：在 counterCount>=1 的世界内按条件概率 amount / P(count>=1)
   * 消费 1 张，总期望扣减恰等于 amount，且不会在无反制的世界浪费移除。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 consumeExpectedCounters。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  consumeExpectedCounters(state, player, expectedAmount) {
    const amount = Math.min(Math.max(0, Number(expectedAmount) || 0), 1);
    if (amount <= PROBABILITY_EPSILON || !player) return 0;
    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const existence = counterState.reduce((sum, branch) => sum + (branch.counterCount >= 1 ? branch.probability : 0), 0);
    if (existence <= PROBABILITY_EPSILON) return 0;
    const conditional = Math.min(1, amount / existence);
    if (conditional <= PROBABILITY_EPSILON) return 0;
    const gate = probabilityEventPartition(
      this.nextProbabilityEventKey(state, `card-scope-counter:${player.id}`), conditional, "counterUsed"
    );
    const joined = joinProbabilityStateBranches(counterState, gate);
    player.counterCountDistribution = projectProbabilityStateBranches(joined, (branch) => ({
      counterCount: Boolean(branch.counterUsed) && branch.counterCount >= 1
        ? Math.max(0, branch.counterCount - 1)
        : branch.counterCount
    }));
    this.syncCounterSummary(player);
    return totalBranchProbability(projectProbabilityStateBranches(joined, (branch) => ({
      occurs: Boolean(branch.counterUsed) && branch.counterCount >= 1
    })).filter((branch) => branch.occurs));
  }

  /*
  功能
  推进响应概率、容量或资源身份步骤 targetResolutionChance。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  targetResolutionChance(state, actor, card, target) {
    if (card.category !== "tactic" || card.counterable === false || card.counterScope !== "target") return 1;
    return 1 - (target.counterProbability ?? 0) * this.counterDesire(state, target, actor, card, [target]);
  }

  /*
  功能
  推进响应概率、容量或资源身份步骤 counterDesire。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  counterDesire(state, responder, actor, card, targets, selection = null) {
    return planningCounterDesire(state, responder, actor, card, targets, selection, {
      assessGlobalBenefit,
      simulatingRootResolution:this._simulatingRootResolution,
      dynamicCounterGain:(...args) => this.dynamicCounterGain(...args)
    });
  }

  /*
  功能
  推进响应概率、容量或资源身份步骤 dynamicCounterGain。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  dynamicCounterGain(state, responder, actor, card, targets, selection = null) {
    return planningDynamicCounterGain(state, responder, actor, card, targets, selection);
  }

  /**
   * 统一格挡响应结算：在包含 occurs / requiredCount / responseAllowed / immuneByRadar
   * 的攻击世界中，只有真正满足数量且允许响应的世界才消费格挡。
   * 复用 B1a 的 blockCountDistribution + consumeBlockIdentities 逻辑，
   * 并返回带 blockedByCard / passes 的完整攻击结果分区供伤害结算直接使用。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 consumeBlockResponseWorlds。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  consumeBlockResponseWorlds(state, target, attackWorlds, options = {}) {
    const blockState = this.getBlockCountBranches(target, state?.remainingCardCounts ?? null);
    const preJudgmentPartition = Array.isArray(options.preJudgmentBlockState)
      && options.preJudgmentBlockState.length
      ? options.preJudgmentBlockState.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          preBlockCount:branch.blockCount
        }))
      : null;
    const joined = preJudgmentPartition
      ? joinProbabilityStateBranches(attackWorlds, blockState, preJudgmentPartition)
      : joinProbabilityStateBranches(attackWorlds, blockState);
    /*
    功能
    推进响应概率、容量或资源身份步骤 responseMatches。

    调用方
    Simulator、Combat/Card/Status components 与响应 characterization 测试。

    输入
    独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

    输出
    更新后的响应分支、容量、身份或效果通过世界。

    读取状态
    只读 SearchState 的 known/unknown response summaries 与 remaining counts。

    写入状态
    只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

    调用函数
    state/Probability、正式 ResponsePolicy query 与共享资源 helper。

    边界与不变量
    同一响应资源只能消费一次；不得在此重新决定是否值得响应。
    */
    const responseMatches = (branch) => Boolean(
      branch.occurs
      && branch.responseAllowed !== false
      && !branch.immuneByRadar
      && branch.blockCount >= branch.requiredCount
    );
    const consumedBranches = joined.filter(responseMatches);
    const blockedProbability = totalBranchProbability(consumedBranches);
    const expectedBlockSpend = consumedBranches.reduce(
      (sum, branch) => sum + branch.probability * branch.requiredCount, 0
    );
    const remainingBlockBranches = projectProbabilityStateBranches(joined, (branch) => ({
      blockCount:responseMatches(branch)
        ? Math.max(0, branch.blockCount - branch.requiredCount)
        : branch.blockCount
    }));
    target.blockCountDistribution = remainingBlockBranches;
    this.syncBlockSummary(target);
    const identityWorlds = joined.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      requiredCount:branch.requiredCount,
      blockUsed:responseMatches(branch)
    }));
    const judgmentBlockCard = options.judgmentBlockCard ?? null;
    const excludedCardIds = judgmentBlockCard
      ? new Set([judgmentBlockCard.id ?? judgmentBlockCard.cardId])
      : null;
    this.consumeBlockIdentities(state, target, identityWorlds, excludedCardIds);
    if (judgmentBlockCard && preJudgmentPartition) {
      // 判定牌追加在手牌末尾：原匿名格挡容量足够时，判定格挡身份必须保留；
      // 只有判定前总格挡不足 requiredCount 的世界才真正消费判定格挡。
      const judgmentConsumedWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(
          responseMatches(branch)
          && branch.preBlockCount < branch.requiredCount
        )
      }));
      const judgmentAvailability = getAvailabilityStateBranches(judgmentBlockCard).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedJudgment = joinProbabilityStateBranches(judgmentAvailability, judgmentConsumedWorlds);
      judgmentBlockCard.availabilityStateBranches = projectProbabilityStateBranches(joinedJudgment, (branch) => ({
        available:Boolean(branch.available && !branch.occurs)
      }));
      judgmentBlockCard.availabilityBranches = availableBranchesFromState(
        judgmentBlockCard.availabilityStateBranches
      );
      if (totalBranchProbability(judgmentBlockCard.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(target.hand)) target.hand = target.hand.filter((card) => card !== judgmentBlockCard);
        if (Array.isArray(target.knownCards)) target.knownCards = target.knownCards.filter((entry) => entry !== judgmentBlockCard);
      }
    }
    target.handCount = Math.max(0, (target.handCount ?? 0) - expectedBlockSpend);
    const outcomeWorlds = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:Boolean(branch.occurs),
      radarOutcome:branch.radarOutcome ?? null,
      requiredCount:branch.requiredCount,
      immuneByRadar:Boolean(branch.immuneByRadar),
      blockedByCard:responseMatches(branch),
      passes:Boolean(branch.occurs && !branch.immuneByRadar && !responseMatches(branch))
    }));
    return { outcomeWorlds, blockedProbability, expectedBlockSpend };
  }

  /**
   * 目标级反制响应：在 effectWorlds × desire × counterCountDistribution 上建立
   * 互斥反制选择分区。只有实际使用反制的世界才消费数量、身份与 handCount；
   * 返回包含 effectOccurs / counterWilling / counterAvailable / counterAttempted /
   * counterConsumed / effectCancelled / effectPasses / responderId 的完整结果世界。
   * 当前 B1c 固定 effectCancelled = counterAttempted；后续 B1d 可在 counterAttempted
   * 世界上叠加“该反制是否被反制”。
   */
  /*
  功能
  推进响应概率、容量或资源身份步骤 consumeTargetCounterResponseWorlds。

  调用方
  Simulator、Combat/Card/Status components 与响应 characterization 测试。

  输入
  独立 SearchState、响应者、效果世界及显式 Policy 意愿结果。

  输出
  更新后的响应分支、容量、身份或效果通过世界。

  读取状态
  只读 SearchState 的 known/unknown response summaries 与 remaining counts。

  写入状态
  只写独立 SearchState 中的 hand、block/counter distributions 和响应额度。

  调用函数
  state/Probability、正式 ResponsePolicy query 与共享资源 helper。

  边界与不变量
  同一响应资源只能消费一次；不得在此重新决定是否值得响应。
  */
  consumeTargetCounterResponseWorlds(state, target, effectWorlds, desire, options = {}) {
    if (!target) {
      const emptyOutcome = projectProbabilityStateBranches(effectWorlds, (branch) => ({
        effectOccurs:Boolean(branch.occurs),
        counterWilling:false,
        counterAvailable:false,
        counterAttempted:false,
        counterConsumed:false,
        effectCancelled:false,
        effectPasses:Boolean(branch.occurs),
        responderId:null
      }));
      return {
        outcomeWorlds:emptyOutcome,
        effectPassWorlds:effectWorlds,
        counterAttemptedWorlds:projectProbabilityStateBranches(effectWorlds, () => ({ occurs:false }))
      };
    }
    const desireChance = clampProbability(Number(desire) || 0);
    const desireKey = this.nextProbabilityEventKey(state, `counter-desire:${target.id ?? "unknown"}`);
    const desirePartition = desireChance >= 1 - PROBABILITY_EPSILON
      ? [{ probability:1, conditions:{}, willing:true }]
      : desireChance <= PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, willing:false }]
        : [
            { probability:desireChance, conditions:{ [desireKey]:"yes" }, willing:true },
            { probability:1 - desireChance, conditions:{ [desireKey]:"no" }, willing:false }
          ];
    const counterState = this.getCounterCountBranches(target, state?.remainingCardCounts ?? null);
    const knownCounterState = this.getKnownCounterCountBranches(target);
    const candidates = [
      ...(Array.isArray(target.hand) ? target.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON && card.definitionId === "counter")
        .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:"counter" })) : []),
      ...(Array.isArray(target.knownCards) ? target.knownCards
        .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON && entry.definitionId === "counter")
        .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:"counter" })) : [])
    ];
    const candidatePartitions = candidates.map((candidate, index) => (
      getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        [`c${index}`]:Boolean(branch.available)
      }))
    ));
    const joined = joinProbabilityStateBranches(
      effectWorlds, desirePartition, counterState, knownCounterState, ...candidatePartitions
    );
    const selectionKey = this.nextProbabilityEventKey(state, `counter-selection:${target.id ?? "unknown"}`);
    const outcomes = [];
    for (const branch of joined) {
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const knownCount = Math.max(0, Math.floor(Number(branch.knownCounterCount) || 0));
      const anonymousCount = Math.max(0, counterCount - knownCount);
      const available = candidates.map((_, index) => Boolean(branch[`c${index}`]));
      const availableCount = available.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const attempted = effectOccurs && willing && counterCount >= 1;
      if (!attempted) {
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:"none" },
          selectedIndex:-1,
          anonymousSelected:false
        });
        continue;
      }
      if (Array.isArray(target.hand)) {
        // 当前 AI 自己：按真实手牌顺序选择第一张可用反制，不随机选择。
        const firstIndex = available.indexOf(true);
        if (firstIndex < 0) {
          outcomes.push({
            probability:branch.probability,
            conditions:{ ...branch.conditions, [selectionKey]:"none" },
            selectedIndex:-1,
            anonymousSelected:false
          });
          continue;
        }
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[firstIndex].key}` },
          selectedIndex:firstIndex,
          anonymousSelected:false
        });
        continue;
      }
      // 其他玩家：已知反制身份与匿名反制桶交换对称互斥选择。
      const total = availableCount + anonymousCount;
      for (let index = 0; index < candidates.length; index += 1) {
        if (available[index]) {
          outcomes.push({
            probability:branch.probability / total,
            conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[index].key}` },
            selectedIndex:index,
            anonymousSelected:false
          });
        }
      }
      if (anonymousCount > 0) {
        outcomes.push({
          probability:branch.probability * (anonymousCount / total),
          conditions:{ ...branch.conditions, [selectionKey]:"anonymous" },
          selectedIndex:-1,
          anonymousSelected:true
        });
      }
    }

    const selectionPartition = mergeProbabilityStateBranches(outcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const availabilityState = getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedAvailability = joinProbabilityStateBranches(availabilityState, selectionPartition);
      candidate.card.availabilityStateBranches = projectProbabilityStateBranches(
        joinedAvailability,
        (branch) => ({ available:Boolean(branch.available && !(branch.selectedIndex === index)) })
      );
      candidate.card.availabilityBranches = availableBranchesFromState(candidate.card.availabilityStateBranches);
      if (totalBranchProbability(candidate.card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(target.hand)) target.hand = target.hand.filter((card) => card !== candidate.card);
        if (Array.isArray(target.knownCards)) target.knownCards = target.knownCards.filter((entry) => entry !== candidate.card);
      }
    }

    // 数量与 handCount 只在 counterAttempted 世界扣减；身份选择只决定具体删哪张。
    const attemptedPartition = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:Boolean(
        branch.occurs
        && branch.willing
        && Math.max(0, Math.floor(Number(branch.counterCount) || 0)) >= 1
      )
    }));
    const currentCounterState = this.getCounterCountBranches(target, state?.remainingCardCounts ?? null);
    const joinedCount = joinProbabilityStateBranches(currentCounterState, attemptedPartition);
    target.counterCountDistribution = projectProbabilityStateBranches(joinedCount, (branch) => ({
      counterCount:Math.max(0, branch.counterCount - (branch.occurs ? 1 : 0))
    }));
    this.syncCounterSummary(target);
    const attemptedProbability = this.eventProbability(attemptedPartition);
    target.handCount = Math.max(0, (target.handCount ?? 0) - attemptedProbability);

    const outcomeWorlds = projectProbabilityStateBranches(joined, (branch) => {
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const attempted = effectOccurs && willing && counterCount >= 1;
      return {
        effectOccurs,
        counterWilling:willing,
        counterAvailable:counterCount >= 1,
        counterAttempted:attempted,
        counterConsumed:attempted,
        effectCancelled:attempted,
        effectPasses:Boolean(effectOccurs && !attempted),
        responderId:target.id ?? null
      };
    });
    return {
      outcomeWorlds,
      effectPassWorlds:projectProbabilityStateBranches(outcomeWorlds, (branch) => ({
        occurs:branch.effectPasses
      })),
      counterAttemptedWorlds:projectProbabilityStateBranches(outcomeWorlds, (branch) => ({
        occurs:branch.counterAttempted
      }))
    };
  }
};
