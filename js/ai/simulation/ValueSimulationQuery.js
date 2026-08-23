/*
模块职责
承接价值计算上游仍需模拟的闪电生命周期与响应反事实查询。

上游
AIController、状态价值适配器、ValueLedger 与正式边界。

下游
Simulator、闪电概率 辅助函数 与纯 value/Evaluator。

状态边界
只克隆并写入 SearchState；不持有或修改真实 GameState。

信息边界
只接受过滤后的状态和合法概率摘要，不读取 Game 隐藏手牌。

架构约束
本模块只做有界 simulation query，不搜索、不生成动作，也不拥有最终价值组合公式。
*/
import { buildRadarJudgmentProbabilities } from "../domain/RadarModel.js";
import { Simulator } from "./Simulator.js";
import {
  buildLightningHitDistribution,
  lightningPresenceProbability
} from "../domain/LightningModel.js";
import { dynamicRootFlipGain as evaluateDynamicRootFlipGain } from "./RootResolutionQuery.js";
import { HP_VALUE } from "../value/Economics.js";
import { conditionHiddenPool, projectHiddenSummaries } from "../state/HiddenPool.js";

export class ValueSimulationQuery {
  /*
  功能
  绑定闪电查询所需的纯 owner material evaluator 并建立状态缓存。

  调用方
  AIController 组合根（统一组装依赖的位置）。

  输入
  不含 Simulator 的 value/Evaluator，以及可选 Simulator factory。

  输出
  可复用的有界模拟查询实例。

  读取状态
  保存纯 evaluator 与 Simulator factory 引用。

  写入状态
  初始化实例级 WeakMap 缓存。

  调用函数
  WeakMap。

  边界与不变量
  缓存仅以 SearchState 对象生命周期为界，不跨状态对象复用结果；组合根 factory 保证嵌套资源效果使用正式 query 语义。
  */
  constructor(
    evaluator,
    simulatorFactory = (state, runtime = {}) => new Simulator(state, {
      searchBudget:runtime.searchBudget ?? null
    })
  ) {
    this.evaluator = evaluator;
    this.simulatorFactory = simulatorFactory;
    this.lightningLifecycleCache = new WeakMap();
  }

  /*
  功能
  在 nested value simulation 开始或循环推进前观察父搜索预算。

  调用方
  本类所有会 clone、structuredClone 或通过 simulatorFactory 创建 Simulator 的查询。

  输入
  可选父 SearchBudget。

  输出
  可继续时返回 true；停止时抛出父预算独占的 cooperative unwind signal。

  读取状态
  传入 SearchBudget。

  写入状态
  SearchBudget 首次过期时写入停止原因。

  调用函数
  SearchBudget.checkpointCurrentWork。

  边界与不变量
  不创建第二套预算；无父预算的执行边界查询保持原完整语义。
  */
  checkpointSearchWork(searchBudget) {
    return searchBudget?.checkpointCurrentWork?.() ?? true;
  }

  /*
  功能
  计算一枚闪电完整生命周期对每个 owner 的预期经济变化。

  调用方
  lightningLifecycleValue、ValueLedger 与正式边界。

  输入
  状态、初始 holder、viewer ID、可选存在概率覆盖与父 SearchBudget。

  输出
  player ID 到未签名 owner delta 的 Map。

  读取状态
  只读 SearchState、剩余牌计数与存活座位环。

  写入状态
  仅写本查询实例的 WeakMap 缓存；模拟写入独立克隆。

  调用函数
  SearchBudget checkpoint、buildLightningHitDistribution、Simulator.applyLightningHit、Evaluator.ownerMaterialValue。

  边界与不变量
  每个分支除最终命中 holder 外保持同一基线；不把 unresolved lifecycle 再加入 frontier；
  nested Simulator 必须继承父 SearchBudget。
  */
  lightningLifecycleOwnerDeltas(
    state,
    initialHolder,
    viewerId,
    presenceOverride = null,
    searchBudget = null
  ) {
    if (!state || !initialHolder?.alive) return new Map();
    let stateCache = this.lightningLifecycleCache.get(state);
    if (!stateCache) {
      stateCache = new Map();
      this.lightningLifecycleCache.set(state, stateCache);
    }
    const presence = presenceOverride == null
      ? lightningPresenceProbability(initialHolder)
      : Math.max(0, Math.min(1, Number(presenceOverride) || 0));
    const cacheKey = `${initialHolder.id}:${viewerId}:${presence}`;
    if (stateCache.has(cacheKey)) return stateCache.get(cacheKey);
    const deltas = new Map(state.players.map((player) => [player.id, 0]));
    if (presence <= 0) {
      stateCache.set(cacheKey, deltas);
      return deltas;
    }
    this.checkpointSearchWork(searchBudget);
    const distribution = buildLightningHitDistribution(state, initialHolder);
    const beforeRadar = buildRadarJudgmentProbabilities(
      state?.remainingCardCounts ?? null
    ).tactic;
    const beforeValues = new Map(state.players.map((player) => [
      player.id,
      this.evaluator.ownerMaterialValue(state, player, viewerId, beforeRadar)
    ]));
    const simulator = this.simulatorFactory(state, { searchBudget });
    for (const outcome of distribution) {
      this.checkpointSearchWork(searchBudget);
      const after = simulator.applyLightningHit(state, outcome.holderId);
      const afterRadar = buildRadarJudgmentProbabilities(
        after?.remainingCardCounts ?? null
      ).tactic;
      for (const afterPlayer of after.players) {
        const delta = this.evaluator.ownerMaterialValue(
          after,
          afterPlayer,
          viewerId,
          afterRadar
        ) - (beforeValues.get(afterPlayer.id) ?? 0);
        deltas.set(
          afterPlayer.id,
          (deltas.get(afterPlayer.id) ?? 0) + presence * outcome.probability * delta
        );
      }
    }
    stateCache.set(cacheKey, deltas);
    return deltas;
  }

  /*
  功能
  从 viewer 视角投影一枚闪电整个流转生命周期的预期局面变化。

  调用方
  状态价值适配器、SearchPrior、响应策略与正式边界。

  输入
  状态、初始 holder、viewer ID、可选存在概率覆盖与父 SearchBudget。

  输出
  viewer 团队视角的闪电生命周期值。

  读取状态
  只读存活玩家和队伍关系。

  写入状态
  无；底层查询只写缓存。

  调用函数
  lightningLifecycleOwnerDeltas。

  边界与不变量
  owner delta 只在此施加敌我符号，保持当前玩家顺序的浮点累加顺序。
  */
  lightningLifecycleValue(
    state,
    initialHolder,
    viewerId,
    presenceOverride = null,
    searchBudget = null
  ) {
    const viewer = state?.players?.find((player) => player.id === viewerId);
    if (!viewer) return 0;
    const deltas = this.lightningLifecycleOwnerDeltas(
      state,
      initialHolder,
      viewerId,
      presenceOverride,
      searchBudget
    );
    return state.players.reduce((sum, player) => {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      return sum + sign * (deltas.get(player.id) ?? 0);
    }, 0);
  }

  /*
  功能
  计算一枚闪电对 viewer 阵营造成的预期负担。

  调用方
  ResponseBoundary 与正式边界。

  输入
  状态、holder、viewer ID、可选存在概率与父 SearchBudget。

  输出
  生命周期价值的相反数。

  读取状态
  与 lightningLifecycleValue 相同。

  写入状态
  无。

  调用函数
  lightningLifecycleValue。

  边界与不变量
  只改变表示符号，不新增任何价值项。
  */
  lightningTeamBurden(state, holder, viewerId, presenceOverride = null, searchBudget = null) {
    return -this.lightningLifecycleValue(
      state,
      holder,
      viewerId,
      presenceOverride,
      searchBudget
    );
  }

  /*
  功能
  计算状态反制把同一枚闪电转交 receiver 后的阵营负担。

  调用方
  ResponseBoundary 与正式边界。

  输入
  状态、旧 holder、新 receiver、viewer ID 与父 SearchBudget。

  输出
  过渡态中的闪电阵营负担。

  读取状态
  只读并克隆传入状态。

  写入状态
  仅修改独立克隆中的旧 holder 闪电状态。

  调用函数
  SearchBudget checkpoint、structuredClone、lightningTeamBurden。

  边界与不变量
  必须先移除旧 holder 再计算新流转环，不能把同一枚闪电当作两个占位。
  */
  lightningTransferredBurden(state, holder, receiver, viewerId, searchBudget = null) {
    if (!state || !holder || !receiver) return 0;
    this.checkpointSearchWork(searchBudget);
    const transferred = structuredClone(state);
    const previous = transferred.players.find((player) => player.id === holder.id);
    const nextHolder = transferred.players.find((player) => player.id === receiver.id);
    if (!previous || !nextHolder) return 0;
    if (Array.isArray(previous.statuses)) {
      previous.statuses = previous.statuses.filter((statusId) => statusId !== "lightning");
    } else if (previous.statuses) {
      delete previous.statuses.lightning;
    }
    previous.lightningStatusStateBranches = [{ probability: 1, conditions: {}, present: false }];
    previous.lightningStatusProbability = 0;
    return this.lightningTeamBurden(transferred, nextHolder, viewerId, 1, searchBudget);
  }

  /*
  功能
  汇总当前状态中所有独立闪电对指定 owner 的未兑现变化。

  调用方
  ValueLedger 与正式边界。

  输入
  状态、owner ID、viewer ID 与父 SearchBudget。

  输出
  未签名 owner delta 总和。

  读取状态
  只读存活 holder 与闪电存在概率。

  写入状态
  无；底层查询只写缓存。

  调用函数
  lightningLifecycleOwnerDeltas、lightningPresenceProbability。

  边界与不变量
  每枚独立闪电恰好计一次，按状态玩家顺序累加。
  */
  lightningOwnerDelta(state, ownerId, viewerId, searchBudget = null) {
    let total = 0;
    for (const holder of state.players) {
      if (!holder?.alive || lightningPresenceProbability(holder) <= 0) continue;
      this.checkpointSearchWork(searchBudget);
      total += this.lightningLifecycleOwnerDeltas(
        state,
        holder,
        viewerId,
        null,
        searchBudget
      ).get(ownerId) ?? 0;
    }
    return total;
  }

  /*
  功能
  为纯 Evaluator 生成当前状态中按 holder 顺序排列的闪电生命周期值。

  调用方
  StateValue。

  输入
  状态、viewer ID 与父 SearchBudget。

  输出
  只包含存在概率大于零 holder 的纯数值数组。

  读取状态
  只读存活 holder 与闪电概率状态。

  写入状态
  无；底层查询只写缓存。

  调用函数
  lightningLifecycleValue、lightningPresenceProbability。

  边界与不变量
  顺序必须与旧 stateUtility 的 holder 循环一致，以保持浮点运算顺序。
  */
  lightningValues(state, viewerId, searchBudget = null) {
    const values = [];
    for (const holder of state.players) {
      if (holder?.alive && lightningPresenceProbability(holder) > 0) {
        this.checkpointSearchWork(searchBudget);
        values.push(this.lightningLifecycleValue(state, holder, viewerId, null, searchBudget));
      }
    }
    return values;
  }

  /*
  功能
  为护援 Policy 构造 STAY/AID 两个配对模拟世界并返回纯价值结果。

  调用方
  ResponseBoundary 正式边界 注入的 guardianAidValues query。

  输入
  过滤状态、守誓者/目标/来源 ID、伤害量、完整 State Value 入口与父 SearchBudget。

  输出
  `{stayValue, aidValue, futureInventory}` 原始 Policy state points 对象。

  读取状态
  只读传入 SearchState 与公开伤害上下文。

  写入状态
  只修改两个独立 Simulator clone。

  调用函数
  SearchBudget checkpoint、Simulator.clone/applyDamage、stateValue.stateUtility、Evaluator.exposureComponents。

  边界与不变量
  STAY 只排除指定守誓者，AID 走既有模拟护援；State Value 与 futureInventory
  均保持 Policy state points，不在查询出口往返换算；固定 canBlock:false 且不修改真实 GameState；
  nested Simulator 必须继承父 SearchBudget。
  */
  guardianAidValues(
    state,
    responderId,
    targetId,
    sourceId,
    amount,
    stateValue,
    searchBudget = null
  ) {
    this.checkpointSearchWork(searchBudget);
    const simulator = this.simulatorFactory(state, { searchBudget });
    const stayState = simulator.clone();
    const aidState = simulator.clone();
    const stayTarget = stayState.players.find((player) => player.id === targetId);
    const aidTarget = aidState.players.find((player) => player.id === targetId);
    const staySource = sourceId
      ? stayState.players.find((player) => player.id === sourceId)
      : null;
    const aidSource = sourceId
      ? aidState.players.find((player) => player.id === sourceId)
      : null;
    simulator.applyDamage(stayState, staySource, stayTarget, amount, {
      canBlock: false,
      excludedGuardianIds: new Set([responderId])
    });
    simulator.applyDamage(aidState, aidSource, aidTarget, amount, { canBlock: false });
    const visibleTarget = state.players.find((player) => player.id === targetId);
    const { futureInventory } = this.evaluator.exposureComponents(state, visibleTarget);
    return {
      stayValue: stateValue.stateUtility(stayState, responderId, searchBudget),
      aidValue: stateValue.stateUtility(aidState, responderId, searchBudget),
      futureInventory
    };
  }

  /*
  功能
  为 ResponsePolicy 查询追加一张反制翻转 root 结局的纯价值增量。

  调用方
  ResponseBoundary 正式边界 注入的 dynamicRootFlipGain query。

  输入
  当前过滤 response state、响应者/root 信息、目标 ID、公开选择上下文、State Value 与父 SearchBudget。

  输出
  FLIP-STAY 数值；全体受益牌返回 null。

  读取状态
  只读当前 SearchState 与 root 公开上下文。

  写入状态
  只写 Simulator 生成的独立克隆。

  调用函数
  SearchBudget checkpoint、Simulator、GlobalBenefitValue.dynamicRootFlipGain 有界配对查询。

  边界与不变量
  每个响应窗口只构造一个具体 Simulator；Policy 本身不知道或构造 Simulator；
  nested Simulator 必须继承父 SearchBudget。
  */
  dynamicRootFlipGain(
    state,
    responderId,
    rootCard,
    rootSourceId,
    counterDepth,
    rootTargetIds,
    options,
    stateValue,
    searchBudget = null
  ) {
    this.checkpointSearchWork(searchBudget);
    const simulator = this.simulatorFactory(state, { searchBudget });
    return evaluateDynamicRootFlipGain(
      stateValue,
      simulator,
      state,
      responderId,
      rootCard,
      rootSourceId,
      counterDepth,
      rootTargetIds,
      options,
      searchBudget
    );
  }

  /*
  功能
  比较实际响应世界与只移除指定响应能力的配对反事实世界。

  调用方
  ValueLedger。

  输入
  before、动作、actor/defender/viewer ID、移除项、可选 actual after、状态价值入口与父 SearchBudget。

  输出
  grossAvoided、ownerValue 与 viewer projected value。

  读取状态
  只读 before/after 和指定响应概率字段。

  写入状态
  只修改反事实浅克隆及 Simulator 生成的独立 SearchState。

  调用函数
  SearchBudget checkpoint、Simulator.apply、stateValue.stateUtility。

  边界与不变量
  反事实只改变正在测量的响应能力；其他资源、概率条件与实体身份保持配对；
  两个 nested Simulator 必须继承同一个父 SearchBudget。
  */
  responseCounterfactual(
    before,
    action,
    actorId,
    defenderId,
    viewerId,
    opts = {},
    after = null,
    stateValue,
    searchBudget = null
  ) {
    if (!action) return { grossAvoided: 0, ownerValue: 0, projected: 0 };
    this.checkpointSearchWork(searchBudget);
    const simulator = this.simulatorFactory(before, { searchBudget });
    const actualAfter = after ?? simulator.apply(before, action, actorId);
    const counterfactualBefore = simulator.clone(before);
    const defender = counterfactualBefore.players.find((player) => player.id === defenderId);
    for (const [definitionId, remove] of [
      ["block", opts.removeBlock],
      ["counter", opts.removeCounter],
      ["recover", opts.removeRecover]
    ]) {
      if (!remove) continue;
      conditionHiddenPool(counterfactualBefore.hiddenPoolState, {
        type:"CONDITION",
        definitionId,
        bucketId:defenderId,
        maximum:0
      });
      if (Array.isArray(defender?.hand)) {
        defender.hand = defender.hand.filter((card) => card.definitionId !== definitionId);
      }
      if (Array.isArray(defender?.knownCards)) {
        defender.knownCards = defender.knownCards.filter(
          (card) => card.definitionId !== definitionId
        );
      }
    }
    projectHiddenSummaries(counterfactualBefore);
    this.checkpointSearchWork(searchBudget);
    const counterfactualAfter = this.simulatorFactory(
      counterfactualBefore,
      { searchBudget }
    ).apply(
      counterfactualBefore,
      action,
      actorId
    );
    const actualDefender = actualAfter.players.find((player) => player.id === defenderId);
    const counterfactualDefender = counterfactualAfter.players.find(
      (player) => player.id === defenderId
    );
    const grossAvoided = Math.max(
      0,
      (actualDefender?.hp ?? 0) - (counterfactualDefender?.hp ?? 0)
    ) * HP_VALUE;
    const ownerValue = stateValue.stateUtility(actualAfter, defenderId, searchBudget)
      - stateValue.stateUtility(counterfactualAfter, defenderId, searchBudget);
    const projected = stateValue.stateUtility(actualAfter, viewerId, searchBudget)
      - stateValue.stateUtility(counterfactualAfter, viewerId, searchBudget);
    return { grossAvoided, ownerValue, projected };
  }
}
