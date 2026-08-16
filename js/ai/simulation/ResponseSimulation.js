/*
模块职责
镜像 SearchState 中的格挡、反制、护援与响应资源容量，不拥有响应策略。

上游
Simulator 正式模拟门面与 Combat/Card/Status 模拟组件。

下游
state/Probability、正式 ResponsePolicy、GlobalBenefit assessment 与共享 simulation runtime。

状态边界
只修改 Simulator 门面提供的独立 SearchState 副本及其概率分支。

信息边界
未知手牌只按合法 knownCards、handCount 与 remaining counts 建模。

架构约束
不得读取 Game/UI/Controller/Planner，不得复制 Policy、Value 或真实规则实现。
*/
import { PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js?build=20260815-shadow-agent-p1-slot";
import { getCounterResponderOrder, isCounterEligible } from "../../domain/rules/response/ResponseRules.js?build=20260815-shadow-agent-p1-slot";
import { hasPassiveSkill, projectCanonicalSeatRoster } from "../state/RuleProjection.js?build=20260815-shadow-agent-p1-slot";
import { assessGlobalBenefit } from "../value/GlobalBenefitValue.js?build=20260815-shadow-agent-p1-slot";
import { planningCounterDesire, planningDynamicCounterGain } from "../policy/ResponsePolicy.js?build=20260815-shadow-agent-p1-slot";
import { PROBABILITY_EPSILON, availableBranchesFromState, expectedBranchValue, getAvailabilityBranches, getAvailabilityStateBranches, getValueBranches, joinProbabilityStateBranches, mergeProbabilityStateBranches, probabilityEventPartition, projectProbabilityStateBranches, totalBranchProbability } from "../state/Probability.js?build=20260815-shadow-agent-p1-slot";
import { clampProbability, remainingCardDensity, unionProbability } from "./SimulationSupport.js?build=20260815-shadow-agent-p1-slot";

/*
功能
把 Base class 与 ResponseSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把响应资源方法加入正式模拟门面。

输入
已经包含共享概率运行时的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增格挡、反制与护援方法的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withResponseSimulation = (Base) => class ResponseSimulation extends Base {
  /*
  功能
  为全部玩家建立格挡数量与已知格挡身份分布，作为后续响应消费的唯一初始状态。

  调用方
  Simulator 构造与 clone：在任何伤害响应前建立全员格挡容量。

  输入
  独立 SearchState。

  输出
  无返回值；每名玩家的正式格挡分布和摘要已存在。

  读取状态
  players 的 hand/knownCards、handCount、existing block 分布与 remaining counts。

  写入状态
  缺失的 blockCountDistribution、blockProbability 与 twoBlockProbability。

  调用函数
  buildInitialBlockCountDistribution、syncBlockSummary。

  边界与不变量
  已有分布只规范不重采样；每名玩家的确定身份和匿名容量只能计入一次。
  */
  initializeBlockCountDistributions(state) {
    for (const player of state?.players ?? []) {
      if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
        player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, state?.remainingCardCounts ?? null);
      }
      this.syncBlockSummary(player);
    }
  }

  /*
  功能
  合并已知格挡身份与未知手牌密度，构造玩家初始格挡数量概率分布。

  调用方
  initialize/get/syncCardEstimates：在正式格挡分布缺失时建立根分布。

  输入
  玩家过滤摘要与可选 remainingCardCounts。

  输出
  新的 blockCount 概率分支数组。

  读取状态
  合法 hand/knownCards availability、handCount、公开派生的格挡概率与未知池密度。

  写入状态
  无。

  调用函数
  cardAvailability、cardEstimateDistribution。

  边界与不变量
  确定身份优先；未知部分只用 Belief 密度，分支总质量必须归一。
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

  /*
  功能
  规范格挡数量分支，并同步期望数量、可响应概率与已知身份摘要。

  调用方
  格挡初始化、获得、失去与消费路径：把正式分布投影为兼容摘要。

  输入
  玩家摘要。

  输出
  规范化后的 blockCount 概率分支数组。

  读取状态
  player.blockCountDistribution。

  写入状态
  blockCountDistribution、blockProbability 与 twoBlockProbability。

  调用函数
  mergeProbabilityStateBranches。

  边界与不变量
  概率和至少一/两张摘要必须来自同一分布，不得单独调整。
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

  /*
  功能
  返回玩家的正式格挡数量分支；缺失时从当前合法信息建立一次。

  调用方
  Combat、CardEffect 与 ResponseSimulation：取得可与当前条件世界连接的格挡容量。

  输入
  玩家摘要与可选 remainingCardCounts。

  输出
  不与内部数组共享条目的 blockCount 分支数组。

  读取状态
  已有 blockCountDistribution 或合法根信息。

  写入状态
  仅在分布缺失时写正式 block 分布及派生摘要。

  调用函数
  buildInitialBlockCountDistribution、syncBlockSummary。

  边界与不变量
  一次建立后复用同一容量世界；读取不得额外抽样未知手牌。
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

  /*
  功能
  按已知格挡卡身份构造确定的格挡数量分支，不推测未知牌面。

  调用方
  随机失牌、格挡身份消费与雷达响应：区分确定身份和匿名容量。

  输入
  玩家自己的 hand 或合法 knownCards 表示。

  输出
  knownBlockCount 的完整条件分支数组。

  读取状态
  所有已知格挡身份的 availabilityStateBranches。

  写入状态
  无。

  调用函数
  getAvailabilityStateBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  只统计确定身份；匿名格挡容量不在这里推测或补齐。
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

  /*
  功能
  确保玩家拥有完整格挡容量分布并同步所有派生摘要。

  调用方
  未知格挡获得/失去路径：在修改容量前确保正式分布存在。

  输入
  玩家摘要与可选 remainingCardCounts。

  输出
  规范化后的内部格挡分布。

  读取状态
  已有分布或合法根信息。

  写入状态
  仅在缺失时建立并同步 block 摘要。

  调用函数
  buildInitialBlockCountDistribution、syncBlockSummary。

  边界与不变量
  不得覆盖已推进的条件分支或重新应用根概率。
  */
  ensureBlockCountDistribution(player, remainingCardCounts = null) {
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    return this.syncBlockSummary(player);
  }

  /*
  功能
  为全部玩家建立反制数量与已知反制身份分布，作为锦囊响应消费的唯一初始状态。

  调用方
  Simulator 构造与 clone：在任何战术响应前建立全员反制容量。

  输入
  独立 SearchState。

  输出
  无返回值；每名玩家的正式反制分布和摘要已存在。

  读取状态
  players 的 hand/knownCards、handCount、existing counter 分布与 remaining counts。

  写入状态
  缺失的 counterCountDistribution 与 counterProbability。

  调用函数
  buildInitialCounterCountDistribution、syncCounterSummary。

  边界与不变量
  已有分布只规范不重采样；同一确定身份和匿名容量只能计入一次。
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

  /*
  功能
  合并已知反制身份与未知手牌密度，构造玩家初始反制数量概率分布。

  调用方
  initialize/get/syncCardEstimates：在正式反制分布缺失时建立根分布。

  输入
  玩家过滤摘要与可选 remainingCardCounts。

  输出
  新的 counterCount 概率分支数组。

  读取状态
  合法 hand/knownCards availability、handCount、公开反制摘要与未知池密度。

  写入状态
  无。

  调用函数
  cardAvailability、cardEstimateDistribution。

  边界与不变量
  确定身份优先；未知部分只用 Belief 密度，分支总质量必须归一。
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

  /*
  功能
  规范反制数量分支，并同步期望数量、可响应概率与已知身份摘要。

  调用方
  反制初始化、获得、失去与消费路径：把正式分布投影为响应概率。

  输入
  玩家摘要。

  输出
  规范化后的 counterCount 概率分支数组。

  读取状态
  player.counterCountDistribution。

  写入状态
  counterCountDistribution 与 counterProbability。

  调用函数
  mergeProbabilityStateBranches。

  边界与不变量
  counterProbability 必须由 count>=1 的同一分布投影，不能独立增减。
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

  /*
  功能
  返回玩家的正式反制数量分支；缺失时从当前合法信息建立一次。

  调用方
  Card/Response/Value 模拟：取得可与当前条件世界连接的反制容量。

  输入
  玩家摘要与可选 remainingCardCounts。

  输出
  不与内部数组共享条目的 counterCount 分支数组。

  读取状态
  已有 counterCountDistribution 或合法根信息。

  写入状态
  仅在分布缺失时写正式 counter 分布及派生摘要。

  调用函数
  buildInitialCounterCountDistribution、syncCounterSummary。

  边界与不变量
  一次建立后复用同一容量世界；读取不得额外抽样未知手牌。
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

  /*
  功能
  按已知反制卡身份构造确定的反制数量分支，不推测未知牌面。

  调用方
  随机失牌与目标反制身份选择：区分确定反制身份和匿名容量。

  输入
  玩家自己的 hand 或合法 knownCards 表示。

  输出
  knownCounterCount 的完整条件分支数组。

  读取状态
  所有已知反制身份的 availabilityStateBranches。

  写入状态
  无。

  调用函数
  getAvailabilityStateBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  只统计确定身份；匿名反制容量不在这里推测。
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

  /*
  功能
  确保玩家拥有完整反制容量分布并同步所有派生摘要。

  调用方
  已知/未知反制获得与转移路径：在修改容量前确保正式分布存在。

  输入
  玩家摘要与可选 remainingCardCounts。

  输出
  规范化后的内部反制分布。

  读取状态
  已有分布或合法根信息。

  写入状态
  仅在缺失时建立并同步 counter 摘要。

  调用函数
  buildInitialCounterCountDistribution、syncCounterSummary。

  边界与不变量
  不得覆盖已推进的条件分支或重新应用根概率。
  */
  ensureCounterCountDistribution(player, remainingCardCounts = null) {
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    return this.syncCounterSummary(player);
  }

  /*
  功能
  当手牌确定为空时清零反制身份与容量分支，阻止过期概率继续响应。

  调用方
  任意失牌路径：手牌确定归零后清除过期反制身份和容量。

  输入
  玩家摘要。

  输出
  无返回值；非空手牌不变化。

  读取状态
  handCount、hand/knownCards 与 counter 分布。

  写入状态
  空手时写零 counterCountDistribution，移除反制身份并同步 counterProbability。

  调用函数
  syncCounterSummary。

  边界与不变量
  只在 handCount 确定为零时清理；不能因期望手牌偏低提前删除概率身份。
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

  /*
  功能
  在获得已知反制卡的条件世界中增加反制容量并登记真实卡牌身份。

  调用方
  确定反制摸牌、转移与雷达获得路径：增加同一世界中的反制容量。

  输入
  SearchState、玩家与获得条件世界。

  输出
  无返回值；反制数量分布已加一并同步。

  读取状态
  当前 counterCountDistribution 与 remaining counts。

  写入状态
  counterCountDistribution 与 counterProbability。

  调用函数
  getCounterCountBranches、Probability 连接/投影 辅助函数、syncCounterSummary。

  边界与不变量
  只在 gainWorlds 的获得分支加一；身份写入由调用方拥有，不能在这里再加 handCount。
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

  /*
  功能
  把转移牌携带的反制容量按同一转移世界加入接收者分布。

  调用方
  CardEffectSimulation.stealResourceToHand：把来源已确认丢失反制的世界交给接收者。

  输入
  SearchState、接收者与来源产生的 transferWorlds。

  输出
  无返回值；有效转移世界中的反制容量已增加。

  读取状态
  接收者当前反制分布。

  写入状态
  接收者 counterCountDistribution 与 counterProbability。

  调用函数
  addKnownCounterToDistribution。

  边界与不变量
  必须复用来源随机失牌的原条件世界，不得按平均密度重新猜测。
  */
  addTransferredCounterCapacity(state, player, transferWorlds) {
    if (!player || !Array.isArray(transferWorlds) || !transferWorlds.length) return;
    this.addKnownCounterToDistribution(state, player, transferWorlds);
  }

  /*
  功能
  在已知反制卡离手世界中移除其身份并扣减对应反制容量。

  调用方
  确定反制打出、弃置、破坏与转移路径：扣减对应世界中的容量。

  输入
  SearchState、玩家与身份离手条件世界。

  输出
  无返回值；反制数量分布已减一并同步。

  读取状态
  当前 counterCountDistribution 与 remaining counts。

  写入状态
  counterCountDistribution 与 counterProbability。

  调用函数
  getCounterCountBranches、Probability 连接/投影 辅助函数、syncCounterSummary。

  边界与不变量
  只在 removalWorlds 中减一且不低于零；具体身份由调用方消费，不能重复扣 handCount。
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

  /*
  功能
  按未知牌池反制密度把一次未知摸牌卷积进反制数量分布。

  调用方
  gainUnknownCardsWithCounterState：为一次未知摸牌卷积反制命中。

  输入
  SearchState、玩家与该张牌实际获得世界。

  输出
  无返回值；counterCountDistribution 已加入未知命中分支。

  读取状态
  当前反制分布与 remainingCardCounts 中 counter 密度。

  写入状态
  counterCountDistribution 与 counterProbability。

  调用函数
  remainingCardDensity、getCounterCountBranches、Probability 连接/合并 辅助函数。

  边界与不变量
  未知牌只有密度含义，不创建反制实体；发生/未命中质量必须保留。
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

  /*
  功能
  逐张推进未知摸牌、剩余密度和反制容量，使无放回抽取保持一致。

  调用方
  摸牌、奖励与技能效果入口：逐张推进无放回未知牌及响应容量。

  输入
  SearchState、玩家、非负期望张数、可选条件世界与事件标签。

  输出
  实际获得的期望手牌数量。

  读取状态
  handCount、remainingCardCounts、block/counter 分布和调用方事件世界。

  写入状态
  handCount、remainingCardCounts、block/counter/card estimates。

  调用函数
  addOneUnknownCardToBlockDistribution、addOneUnknownCardToCounterDistribution、Probability 事件 辅助函数。

  边界与不变量
  每张未知牌按更新后的剩余池密度推进；block 与 counter 必须共享同一抽牌身份世界。
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

  /*
  功能
  在获得已知格挡卡的条件世界中增加格挡容量并登记真实卡牌身份。

  调用方
  确定格挡摸牌、雷达获得与转移路径：增加同一世界中的格挡容量。

  输入
  SearchState、玩家与获得条件世界。

  输出
  无返回值；格挡分布与派生摘要已同步。

  读取状态
  当前 blockCountDistribution 与 remaining counts。

  写入状态
  blockCountDistribution、blockProbability 与 twoBlockProbability。

  调用函数
  getBlockCountBranches、Probability 连接/投影 辅助函数、syncBlockSummary。

  边界与不变量
  只在 gainWorlds 的获得分支加一；身份和 handCount 由调用方写入。
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

  /*
  功能
  在已知格挡卡离手世界中移除其身份并扣减对应格挡容量。

  调用方
  确定格挡打出、弃置、破坏与转移路径：扣减对应世界中的容量。

  输入
  SearchState、玩家与身份离手条件世界。

  输出
  无返回值；格挡分布与派生摘要已同步。

  读取状态
  当前 blockCountDistribution 与 remaining counts。

  写入状态
  blockCountDistribution、blockProbability 与 twoBlockProbability。

  调用函数
  getBlockCountBranches、Probability 连接/投影 辅助函数、syncBlockSummary。

  边界与不变量
  只在 removalWorlds 中减一且不低于零；具体身份与 handCount 由调用方统一消费。
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

  /*
  功能
  按未知牌池格挡密度把一次未知摸牌卷积进格挡数量分布。

  调用方
  gainUnknownCardsWithCounterState：为一次未知摸牌卷积格挡命中。

  输入
  SearchState、玩家与该张牌实际获得世界。

  输出
  无返回值；blockCountDistribution 已加入未知命中分支。

  读取状态
  当前格挡分布与 remainingCardCounts 中 block 密度。

  写入状态
  blockCountDistribution、blockProbability 与 twoBlockProbability。

  调用函数
  remainingCardDensity、getBlockCountBranches、Probability 连接/合并 辅助函数。

  边界与不变量
  未知牌只有密度含义，不创建格挡实体；发生/未命中质量必须保留。
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

  /*
  功能
  按条件化失去数量从未知格挡容量中抽样扣减，并保持概率质量守恒。

  调用方
  CardEffectSimulation 的未知失牌与转移：从匿名手牌中扣减格挡容量。

  输入
  SearchState、玩家、期望移除量、匿名容量、可选事件世界/标签与 handCount 更新选项。

  输出
  包含实际 removed 与共享 identityWorlds 的新对象。

  读取状态
  block 总容量、knownBlockCount、handCount 与匿名选择条件。

  写入状态
  blockCountDistribution、block 摘要，以及可选 handCount。

  调用函数
  getBlockCountBranches、getKnownBlockCountBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  匿名身份选择必须与给定失牌世界相交；返回的 identityWorlds 供 counter 扣减复用。
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

  /*
  功能
  按条件化失去数量从未知反制容量中抽样扣减，并保持概率质量守恒。

  调用方
  CardEffectSimulation 的未知失牌与转移：复用身份世界扣减反制容量。

  输入
  SearchState、玩家、实际移除量、匿名容量、来自 block 路径的 identityWorlds 与更新选项。

  输出
  实际扣减后的期望移除量。

  读取状态
  counter 总容量、knownCounterCount 与共享匿名选择条件。

  写入状态
  counterCountDistribution、counterProbability，以及可选 handCount。

  调用函数
  getCounterCountBranches、getKnownCounterCountBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  不得重新抽取匿名牌身份；必须复用 block 路径决定的同一失牌世界。
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

  /*
  功能
  在同一转移世界中耦合来源格挡容量减少与接收者容量增加。

  调用方
  CardEffectSimulation 的未知手牌转移/掠夺：同步来源和接收者的匿名响应容量。

  输入
  SearchState、来源、接收者、效果世界与来源匿名容量。

  输出
  实际转移的期望手牌数量。

  读取状态
  来源 block/counter 分布、双方 handCount 与 remaining counts。

  写入状态
  双方 handCount、block/counter 分布及派生摘要。

  调用函数
  removeUnknownCardsFromBlockDistribution、removeUnknownCardsFromCounterDistribution、响应容量增加 辅助函数。

  边界与不变量
  来源减一与接收者加一共享同一 transfer world；未知牌不产生 definitionId。
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

  /*
  功能
  将实际格挡世界映射到可用已知身份并消费每张卡至多一次。

  调用方
  CombatSimulation 与 consumeBlockResponseWorlds：把已决定的格挡消费映射到具体合法身份。

  输入
  SearchState、玩家、含 requiredCount/blockUsed 的格挡世界与可选排除 ID。

  输出
  无返回值；相交世界中的已知格挡身份已消费。

  读取状态
  hand/knownCards availability 与 blockWorlds。

  写入状态
  卡牌 availability，并在质量归零时移出身份数组。

  调用函数
  getAvailabilityStateBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  每个世界按稳定身份顺序消费所需张数；排除的雷达判定牌由调用方单独处理。
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

  /*
  功能
  按守护者意愿、可用格挡与目标伤害世界结算护援及其资源消耗。

  调用方
  CombatSimulation.applyDamage：在伤害穿过响应后结算守护援助。

  输入
  SearchState、受保护目标、入射期望伤害、事件概率、排除守护者与伤害选项。

  输出
  护援后剩余的期望伤害量。

  读取状态
  存活盟友、守护技能可用性、格挡/手牌资源与正式 Policy 意愿。

  写入状态
  守护者格挡/手牌/响应分布及可选伤害 outcome。

  调用函数
  seatOrderFrom、ResponsePolicy query、consumeChosenHandCard/consumeRandomHandCards。

  边界与不变量
  护援按座次和可用资源依次结算；每名守护者每个伤害世界最多响应一次。
  */
  simulateGuardianAid(state, target, incomingDamage, eventProbability, excludedGuardianIds = null, options = {}) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) return Math.max(0, incomingDamage);
    const conditionalReduction = Math.min(
      PASSIVE_SKILL_DEFINITIONS.guardianAid.damageReduction,
      incomingDamage / probability
    );
    let remainingTriggerProbability = probability;
    let expectedReduction = 0;
    for (const guardian of state.players) {
      if (remainingTriggerProbability <= PROBABILITY_EPSILON) break;
      if (excludedGuardianIds?.has(guardian.id)) continue;
      if (!guardian.alive || !hasPassiveSkill(guardian, "guardianAid") || guardian.id === target.id
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
  汇总整张锦囊经过各反制响应后的最终生效概率。

  调用方
  TacticResolutionQuery 与 Simulator.apply：取得整张 card-scope 战术的最终生效概率。

  输入
  SearchState、行动者、卡牌、目标列表与可选 selection。

  输出
  所有卡牌级反制链结算后的零到一生效概率。

  读取状态
  响应者 counter 分布、座次、阵营与正式反制意愿查询。

  写入状态
  无。

  调用函数
  evaluateCardScopeCounterResponses。

  边界与不变量
  本函数只查询，不消费反制；实际消费必须使用同一次 responseEvaluation。
  */
  tacticResolutionChance(state, actor, card, targets = [], selection = null) {
    if (!isCounterEligible(card.category, card.counterable)) return 1;
    return this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection).resolutionChance;
  }

  /*
  功能
  按座次评估卡牌级反制链，返回每名响应者的条件消费世界。

  调用方
  tacticResolutionChance、consumeCountersForCardScope 与 Simulator.apply：冻结一次卡牌级反制链。

  输入
  SearchState、行动者、战术牌、目标列表与可选 selection。

  输出
  包含 resolutionChance 和每名响应者条件消费世界的独立对象。

  读取状态
  存活座次、counterProbability 与正式 counterDesire 结果。

  写入状态
  无。

  调用函数
  seatOrderFrom、counterDesire、Probability 事件 辅助函数。

  边界与不变量
  链顺序和奇偶翻转只计算一次；返回结果不得修改任何响应容量。
  */
  evaluateCardScopeCounterResponses(state, actor, card, targets = [], selection = null) {
    const contenders = [];
    let resolutionChance = 1;
    const roster = projectCanonicalSeatRoster(state.players);
    const responderOrder = getCounterResponderOrder(roster, actor.id);
    for (const responderId of responderOrder) {
      const player = state.players.find((entry) => entry.id === responderId);
      if (!player?.alive || player.id === actor.id) continue;
      const counterProbability = clampProbability(player.counterProbability ?? 0);
      const desire = this.counterDesire(state, player, actor, card, targets, selection);
      const effectiveProbability = clampProbability(counterProbability * desire);
      contenders.push({ player, counterProbability, desire, effectiveProbability });
      resolutionChance *= 1 - effectiveProbability;
    }
    return { resolutionChance, contenders };
  }

  /*
  功能
  依据已评估的卡牌级反制链消费对应玩家的反制容量与身份。

  调用方
  Simulator.apply：在卡牌级反制生效概率确定后兑现同一链的资源消耗。

  输入
  SearchState、行动者、战术牌、目标/selection 与可选已冻结 responseEvaluation。

  输出
  实际消费的期望反制总量。

  读取状态
  响应链的 per-player 消费世界与各玩家反制分布。

  写入状态
  响应者 counterCountDistribution、counterProbability、handCount 与确定反制身份。

  调用函数
  evaluateCardScopeCounterResponses、consumeExpectedCounters、consumeKnownCardsFromHand。

  边界与不变量
  必须消费用于 resolutionChance 的同一链；不得再次调用意愿查询造成二次随机或双计。
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

  /*
  功能
  从玩家反制数量分布中扣除给定期望消耗量并同步摘要。

  调用方
  consumeCountersForCardScope：从单名响应者容量中兑现至多一张期望反制。

  输入
  SearchState、响应者与零到一期望消耗。

  输出
  实际消费的反制概率质量。

  读取状态
  counterCountDistribution 与 remaining counts。

  写入状态
  counterCountDistribution 与 counterProbability。

  调用函数
  getCounterCountBranches、probabilityEventPartition、syncCounterSummary。

  边界与不变量
  只在存在反制的世界扣一张；本函数不选择具体身份或改变 handCount。
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
  计算单个目标经过目标级反制后的最终生效概率。

  调用方
  TacticResolutionQuery 与目标级卡牌效果：估算单个目标是否通过反制。

  输入
  SearchState、行动者、卡牌与目标。

  输出
  目标效果最终生效概率；非目标级可反制战术返回一。

  读取状态
  目标 counterProbability 与正式 counterDesire。

  写入状态
  无。

  调用函数
  counterDesire。

  边界与不变量
  只做概率查询，不消费反制；实际目标响应由 consumeTargetCounterResponseWorlds 结算。
  */
  targetResolutionChance(state, actor, card, target) {
    if (!isCounterEligible(card.category, card.counterable) || card.counterScope !== "target") return 1;
    return 1 - (target.counterProbability ?? 0) * this.counterDesire(state, target, actor, card, [target]);
  }

  /*
  功能
  根据阵营关系、效果价值与当前状态计算响应者反制意愿。

  调用方
  card-scope 与 target-scope 响应查询：请求正式 ResponsePolicy 的规划反制意愿。

  输入
  SearchState、响应者、行动者、卡牌、目标列表与可选 selection。

  输出
  零到一的局部反制意愿。

  读取状态
  公开/过滤状态、全体受益 assessment 与 root 递归守卫。

  写入状态
  无。

  调用函数
  planningCounterDesire、dynamicCounterGain。

  边界与不变量
  Simulation 不复制策略公式；root 递归守卫只阻止重复反事实，不改变普通响应。
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
  比较反制前后状态价值，计算当前响应在此世界中的动态收益。

  调用方
  planningCounterDesire：需要比较反制前后 root 结局时请求有界价值增量。

  输入
  SearchState、响应者、行动者、卡牌、目标列表与可选 selection。

  输出
  反制翻转相对不反制的纯价值差。

  读取状态
  只读传入过滤状态和公开 root context。

  写入状态
  无。

  调用函数
  planningDynamicCounterGain。

  边界与不变量
  本入口不修改当前 SearchState；具体配对模拟由正式查询 owner 隔离。
  */
  dynamicCounterGain(state, responder, actor, card, targets, selection = null) {
    return planningDynamicCounterGain(state, responder, actor, card, targets, selection);
  }

  /*
  功能
  将攻击世界与格挡容量、意愿和身份相交，返回命中与格挡后的互斥世界。

  调用方
  CombatSimulation.applyDamage：把已确定攻击世界与格挡容量和雷达结果联合。

  输入
  SearchState、目标、攻击世界及可选判定前格挡/判定牌身份。

  输出
  outcomeWorlds、blockedProbability 与 expectedBlockSpend。

  读取状态
  block 分布、已知身份、requiredCount、雷达免疫与 responseAllowed 条件。

  写入状态
  blockCountDistribution/摘要、格挡身份 availability 与 handCount。

  调用函数
  getBlockCountBranches、consumeBlockIdentities、Probability 连接/投影 辅助函数。

  边界与不变量
  格挡选择、容量扣减和身份消费共享同一世界；雷达判定格挡只有补足缺口时才消费。
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
    判断一条响应资源分支与攻击世界条件是否兼容，避免跨世界重复消费。

    调用方
    consumeBlockResponseWorlds：在同一条件世界判断是否真正打出格挡。

    输入
    含攻击发生、响应允许、雷达免疫、blockCount 与 requiredCount 的联合分支。

    输出
    该分支是否消费格挡并阻止伤害。

    读取状态
    仅闭包当前联合分支。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    必须同时发生、允许响应、未被雷达免疫且容量足够；不能跨条件世界借用格挡。
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

  /*
  功能
  将目标效果世界与反制容量和意愿相交，消费资源并返回最终生效世界。

  调用方
  CardEffectSimulation 的 target-scope 战术：兑现单目标反制尝试。

  输入
  SearchState、目标、效果世界、已计算意愿与可选响应选项。

  输出
  完整 outcomeWorlds、最终 effectPassWorlds 与 counterAttemptedWorlds。

  读取状态
  目标 counter/knownCounter 分布、确定身份 availability 与效果/意愿条件。

  写入状态
  counterCountDistribution/摘要、反制身份 availability、hand/knownCards 与 handCount。

  调用函数
  getCounterCountBranches、getKnownCounterCountBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  意愿、容量、具体身份选择和效果取消必须条件耦合；每个目标世界最多消费一张反制。
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
