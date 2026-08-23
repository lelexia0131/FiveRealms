/*
模块职责
唯一拥有匿名物理牌槽、有限池条件推理、匿名牌移动以及兼容摘要投影。

上游
BeliefState、SearchState、ResponseSimulation、CardEffectSimulation 与只读领域查询。

下游
state/Probability 的条件分支代数。

状态边界
HiddenPoolState 是唯一可变 hidden-card probability state；玩家摘要只是由本模块生成的投影。

信息边界
只消费公开手牌数量、合法已知身份与 Remaining Knowledge；未观察身份在同次 mutation 内边缘化。

架构约束
物理槽只存于 slotsByBucket；不得按牌种或动作复制状态/API，不得保存 identity event history。
*/
import {
  getAvailabilityStateBranches,
  joinProbabilityStateBranches,
  projectProbabilityStateBranches
} from "./Probability.js";

export const HIDDEN_POOL_DEFINITION_IDS = Object.freeze([
  "recover", "block", "counter", "assault"
]);
export const HIDDEN_POOL_DRAW_BUCKET = "outside/drawPool";
export const HIDDEN_POOL_REMOVED_BUCKET = "outside/removed";

/*
功能
计算无重复组合数，供有限池 DP 与超几何分布共享。

调用方
hypergeometricCountDistribution、runFinitePoolDP。

输入
非负总体数与选择数。

输出
组合数；越界返回零。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
利用 k 与 n-k 对称性缩短乘法链，不使用阶乘避免不必要溢出。
*/
export function combination(total, selected) {
  if (selected < 0 || selected > total) return 0;
  const count = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= count; index += 1) {
    result = result * (total - count + index) / index;
  }
  return result;
}

/*
功能
计算单桶目标牌数量的精确无放回超几何分布。

调用方
ResponsePolicy 的窄先验、数学回归与 HiddenPool oracle。

输入
总体、目标实例、抽取槽位、已知目标偏移。

输出
冻结的 `{count, probability}` 分布。

读取状态
无。

写入状态
无。

调用函数
combination。

边界与不变量
从合法 kMin 开始递推；样本超过总体时只允许确定空总体，否则抛错。
*/
export function hypergeometricCountDistribution(
  populationSize,
  successCount,
  draws,
  offset = 0
) {
  const population = Math.max(0, Math.floor(Number(populationSize) || 0));
  const successes = Math.max(0, Math.min(population, Math.floor(Number(successCount) || 0)));
  const sampleSize = Math.max(0, Math.floor(Number(draws) || 0));
  const knownOffset = Math.max(0, Math.floor(Number(offset) || 0));
  if (sampleSize > population) {
    if (population === 0 && successes === 0) {
      return Object.freeze([Object.freeze({ count:knownOffset, probability:1 })]);
    }
    throw new RangeError(`超几何抽样数量 ${sampleSize} 超过总体 ${population}`);
  }
  const denominator = combination(population, sampleSize);
  if (denominator <= 0) {
    return Object.freeze([Object.freeze({ count:knownOffset, probability:1 })]);
  }
  const minimum = Math.max(0, sampleSize - (population - successes));
  const maximum = Math.min(sampleSize, successes);
  const branches = [];
  let probability = combination(successes, minimum)
    * combination(population - successes, sampleSize - minimum)
    / denominator;
  for (let count = minimum; count <= maximum; count += 1) {
    if (probability > 0) branches.push({ count:knownOffset + count, probability });
    if (count < maximum) {
      probability *= (successes - count) / (count + 1)
        * (sampleSize - count) / (population - successes - sampleSize + count + 1);
    }
  }
  const total = branches.reduce((sum, branch) => sum + branch.probability, 0);
  return Object.freeze(branches.map((branch) => Object.freeze({
    count:branch.count,
    probability:branch.probability / total
  })));
}

/*
功能
从匿名槽与 Remaining Knowledge 创建唯一 HiddenPoolState。

调用方
BeliefState 根构造与测试 fixture。

输入
各玩家匿名槽、剩余定义计数与可选牌池外桶名。

输出
可直接克隆或推进的 canonical HiddenPoolState。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
slotsByBucket 只存一份；未分配槽归 drawPool，tracked categories 外统一归 other。
*/
export function createHiddenPoolState({ slotsByBucket = {}, cardCounts = {} } = {}) {
  const playerSlots = Object.fromEntries(Object.entries(slotsByBucket).map(([bucketId, value]) => [
    bucketId,
    Math.max(0, Math.floor(Number(value) || 0))
  ]));
  const assigned = Object.values(playerSlots).reduce((sum, count) => sum + count, 0);
  const counted = Object.values(cardCounts).reduce(
    (sum, value) => sum + Math.max(0, Math.floor(Number(value) || 0)), 0
  );
  const populationSize = Math.max(assigned, counted);
  const canonicalSlots = {
    ...playerSlots,
    [HIDDEN_POOL_DRAW_BUCKET]:Math.max(0, populationSize - assigned),
    [HIDDEN_POOL_REMOVED_BUCKET]:0
  };
  const trackedCounts = Object.fromEntries(HIDDEN_POOL_DEFINITION_IDS.map((definitionId) => [
    definitionId,
    Math.max(0, Math.min(populationSize, Math.floor(Number(cardCounts[definitionId]) || 0)))
  ]));
  const trackedTotal = Object.values(trackedCounts).reduce((sum, count) => sum + count, 0);
  const weightsByDefinition = Object.fromEntries(HIDDEN_POOL_DEFINITION_IDS.map((definitionId) => [
    definitionId,
    Object.fromEntries(Object.entries(canonicalSlots).map(([bucketId, count]) => [
      bucketId,
      Array.from({ length:count + 1 }, () => 1)
    ]))
  ]));
  const marginalsByDefinition = Object.fromEntries(HIDDEN_POOL_DEFINITION_IDS.map((definitionId) => [
    definitionId,
    Object.fromEntries(Object.entries(canonicalSlots).map(([bucketId, count]) => [
      bucketId,
      hypergeometricCountDistribution(
        populationSize,
        trackedCounts[definitionId],
        count
      )
    ]))
  ]));
  return {
    version:1,
    populationSize,
    slotsByBucket:canonicalSlots,
    cardCounts:{
      ...trackedCounts,
      other:Math.max(0, populationSize - trackedTotal)
    },
    correlationMode:"finite-pool",
    marginalsByDefinition,
    weightsByDefinition
  };
}

/*
功能
执行单 definition 的有限池卷积并返回指定桶边际。

调用方
queryHiddenPool。

输入
HiddenPoolState、definitionId、可选目标桶与局部权重覆盖。

输出
分区质量、归一数量分布和实际 DP 状态计数。

读取状态
共享 slotsByBucket、definition card count 与紧凑桶权重。

写入状态
无。

调用函数
combination。

边界与不变量
逐桶只保留累计成功数 0..K；时间 O(P·N²)、工作空间 O(N)，不枚举玩家 allocation vector。
*/
function runFinitePoolDP(state, definitionId, bucketId = null, weightOverrides = null) {
  const slots = state?.slotsByBucket ?? {};
  const successCount = Math.max(0, Math.floor(Number(state?.cardCounts?.[definitionId]) || 0));
  const weights = state?.weightsByDefinition?.[definitionId] ?? {};
  const targetSlots = bucketId === null ? 0 : Math.max(0, Number(slots[bucketId]) || 0);
  const targetWeights = bucketId === null
    ? [1]
    : (weightOverrides?.[bucketId] ?? weights[bucketId] ?? [1]);
  const raw = [];
  let dpStates = 0;
  for (let targetCount = 0; targetCount <= Math.min(targetSlots, successCount); targetCount += 1) {
    const targetWeight = Math.max(0, Number(targetWeights[targetCount]) || 0);
    if (targetWeight <= 0) continue;
    let totals = [1];
    for (const [currentBucketId, rawSlots] of Object.entries(slots)) {
      if (currentBucketId === bucketId) continue;
      const bucketSlots = Math.max(0, Math.floor(Number(rawSlots) || 0));
      const bucketWeights = weightOverrides?.[currentBucketId]
        ?? weights[currentBucketId]
        ?? Array.from({ length:bucketSlots + 1 }, () => 1);
      const next = Array.from({ length:Math.min(successCount, totals.length - 1 + bucketSlots) + 1 }, () => 0);
      for (let prior = 0; prior < totals.length; prior += 1) {
        for (let count = 0; count <= Math.min(bucketSlots, successCount - prior); count += 1) {
          dpStates += 1;
          const weight = Math.max(0, Number(bucketWeights[count]) || 0);
          if (totals[prior] > 0 && weight > 0) {
            next[prior + count] += totals[prior] * combination(bucketSlots, count) * weight;
          }
        }
      }
      totals = next;
    }
    const remainder = successCount - targetCount;
    const mass = (totals[remainder] ?? 0)
      * combination(targetSlots, targetCount)
      * targetWeight;
    if (mass > 0) raw.push({ count:targetCount, probability:mass });
  }
  const mass = raw.reduce((sum, branch) => sum + branch.probability, 0);
  const distribution = mass > 0
    ? raw.map((branch) => ({ count:branch.count, probability:branch.probability / mass }))
    : [{ count:0, probability:1 }];
  return { mass, distribution, dpStates };
}

/*
功能
用统一数据查询某牌种在桶、桶组或单槽中的后验。

调用方
BeliefState、ResponseSimulation、SealModel、摘要投影与 oracle 测试。

输入
HiddenPoolState 与 definitionId、bucketId/groupBucketIds、count predicate。

输出
数量分布、期望、谓词概率、单槽成功率和 DP 状态数。

读取状态
canonical HiddenPoolState。

写入状态
无。

调用函数
runFinitePoolDP。

边界与不变量
definition 是数据；查询不创建持久条件、身份事件或牌种专用分支。
*/
export function queryHiddenPool(state, query = {}) {
  const definitionId = query.definitionId;
  if (!HIDDEN_POOL_DEFINITION_IDS.includes(definitionId)) {
    return { distribution:[{ count:0, probability:1 }], expected:0, probability:0, slotProbability:0, dpStates:0 };
  }
  const bucketId = query.bucketId ?? null;
  const storedMarginal = bucketId === null
    ? null
    : state?.marginalsByDefinition?.[definitionId]?.[bucketId];
  const result = Array.isArray(storedMarginal) && storedMarginal.length
    ? { mass:1, distribution:storedMarginal, dpStates:0 }
    : runFinitePoolDP(state, definitionId, bucketId);
  const predicate = typeof query.predicate === "function"
    ? query.predicate
    : (count) => count >= Math.max(0, Math.floor(Number(query.minimum) || 1));
  let probability = result.distribution.reduce(
    (sum, branch) => sum + (predicate(branch.count) ? branch.probability : 0), 0
  );
  let dpStates = result.dpStates;
  if (Array.isArray(query.groupBucketIds)) {
    if (state?.correlationMode === "finite-pool") {
      const overrides = {};
      for (const groupId of new Set(query.groupBucketIds)) {
        const count = Math.max(0, Number(state?.slotsByBucket?.[groupId]) || 0);
        const original = state?.weightsByDefinition?.[definitionId]?.[groupId] ?? [1];
        overrides[groupId] = Array.from({ length:count + 1 }, (_, index) => (
          index === 0 ? Math.max(0, Number(original[0]) || 0) : 0
        ));
      }
      const none = runFinitePoolDP(state, definitionId, null, overrides);
      const total = runFinitePoolDP(state, definitionId);
      dpStates += none.dpStates + total.dpStates;
      probability = total.mass > 0 ? Math.max(0, Math.min(1, 1 - none.mass / total.mass)) : 0;
    } else {
      probability = 1 - [...new Set(query.groupBucketIds)].reduce((none, groupId) => {
        const group = queryHiddenPool(state, { definitionId, bucketId:groupId });
        return none * (1 - group.probability);
      }, 1);
    }
  }
  const expected = result.distribution.reduce(
    (sum, branch) => sum + branch.count * branch.probability, 0
  );
  const slots = Math.max(0, Number(state?.slotsByBucket?.[bucketId]) || 0);
  return {
    distribution:result.distribution,
    expected,
    probability,
    slotProbability:slots > 0 ? Math.max(0, Math.min(1, expected / slots)) : 0,
    dpStates
  };
}

/*
功能
把当前数量证据写入 canonical 桶权重并立即归一为充分统计。

调用方
ResponseSimulation 的响应判定、HiddenPool oracle 与 mutateHiddenPool。

输入
可变 HiddenPoolState、definitionId、bucketId 与 count 范围/predicate。

输出
证据发生前的条件概率。

读取状态
当前桶权重与 queryHiddenPool 后验。

写入状态
只写指定 definition/bucket 的紧凑 count weights。

调用函数
queryHiddenPool。

边界与不变量
不保存条件事件或操作历史；零质量证据留下全零权重，让调用方明确处理不可能世界。
*/
export function conditionHiddenPool(state, condition = {}) {
  const definitionId = condition.definitionId;
  const bucketId = condition.bucketId;
  const slots = Math.max(0, Number(state?.slotsByBucket?.[bucketId]) || 0);
  const weights = state?.weightsByDefinition?.[definitionId]?.[bucketId];
  if (!Array.isArray(weights)) return 0;
  const minimum = Math.max(0, Math.floor(Number(condition.minimum) || 0));
  const maximum = condition.maximum == null
    ? slots
    : Math.min(slots, Math.floor(Number(condition.maximum) || 0));
  const predicate = typeof condition.predicate === "function"
    ? condition.predicate
    : (count) => count >= minimum && count <= maximum;
  const probability = queryHiddenPool(state, { definitionId, bucketId, predicate }).probability;
  state.weightsByDefinition[definitionId][bucketId] = weights.map(
    (weight, count) => predicate(count) ? weight : 0
  );
  const marginal = state.marginalsByDefinition?.[definitionId]?.[bucketId] ?? [];
  const filtered = marginal.filter((branch) => predicate(branch.count));
  const total = filtered.reduce((sum, branch) => sum + branch.probability, 0);
  state.marginalsByDefinition[definitionId][bucketId] = total > 0
    ? filtered.map((branch) => ({ ...branch, probability:branch.probability / total }))
    : [{ count:0, probability:1 }];
  return probability;
}

/*
功能
按 MOVE/REMOVE/ADD/OBSERVE/CONDITION 数据变更匿名物理槽并边缘化未观察身份。

调用方
CardEffectSimulation、ResponseSimulation 与 HiddenPool mutation oracle。

输入
可变 HiddenPoolState 和 mutation 数据；count 默认为一。

输出
同一 HiddenPoolState，供调用方继续查询和投影。

读取状态
共享槽、各牌种桶权重与可选已观察 definitionId。

写入状态
slotsByBucket 与受影响桶权重；不写玩家摘要。

调用函数
conditionHiddenPool、queryHiddenPool。

边界与不变量
每次只移动真实槽一次；未知身份逐牌种边缘化且不生成 identity branch，状态大小不随操作次数指数增长。
*/
export function mutateHiddenPool(state, mutation = {}) {
  if (mutation.type === "CONDITION") {
    conditionHiddenPool(state, mutation);
    return state;
  }
  const sourceId = mutation.sourceBucketId
    ?? (mutation.type === "ADD" ? HIDDEN_POOL_DRAW_BUCKET : null);
  const targetId = mutation.targetBucketId
    ?? (mutation.type === "REMOVE" ? HIDDEN_POOL_REMOVED_BUCKET : null);
  const steps = Math.max(0, Math.floor(Number(mutation.count) || 1));
  const eventProbability = Math.max(0, Math.min(1, Number(mutation.probability ?? 1) || 0));
  if (!sourceId || !targetId || sourceId === targetId) return state;
  for (const bucketId of [sourceId, targetId]) {
    state.slotsByBucket[bucketId] ??= 0;
    for (const definitionId of HIDDEN_POOL_DEFINITION_IDS) {
      state.weightsByDefinition[definitionId][bucketId] ??= [1];
      state.marginalsByDefinition[definitionId][bucketId] ??= [{ count:0, probability:1 }];
    }
  }
  for (let step = 0; step < steps; step += 1) {
    const sourceSlots = Math.max(0, Number(state.slotsByBucket[sourceId]) || 0);
    const targetSlots = Math.max(0, Number(state.slotsByBucket[targetId]) || 0);
    if (sourceSlots <= 0) break;
    for (const definitionId of HIDDEN_POOL_DEFINITION_IDS) {
      const source = state.marginalsByDefinition[definitionId][sourceId] ?? [{ count:0, probability:1 }];
      const target = state.marginalsByDefinition[definitionId][targetId] ?? [{ count:0, probability:1 }];
      const observed = typeof mutation.definitionId === "string";
      const success = mutation.definitionId === definitionId;
      const expected = source.reduce(
        (sum, branch) => sum + branch.count * branch.probability, 0
      );
      const selectedIdentityProbability = observed
        ? (success ? 1 : 0)
        : (sourceSlots > 0 ? Math.max(0, Math.min(1, expected / sourceSlots)) : 0);
      const sourceMass = new Map();
      for (const branch of source) {
        const selected = observed
          ? (success ? eventProbability * (expected > 0 ? branch.count / expected : 0) : 0)
          : eventProbability * branch.count / sourceSlots;
        sourceMass.set(branch.count, (sourceMass.get(branch.count) ?? 0)
          + branch.probability * (1 - selected));
        if (branch.count > 0) {
          sourceMass.set(branch.count - 1, (sourceMass.get(branch.count - 1) ?? 0)
            + branch.probability * selected);
        }
      }
      const moved = eventProbability * selectedIdentityProbability;
      const targetMass = new Map();
      for (const branch of target) {
        targetMass.set(branch.count, (targetMass.get(branch.count) ?? 0)
          + branch.probability * (1 - moved));
        targetMass.set(branch.count + 1, (targetMass.get(branch.count + 1) ?? 0)
          + branch.probability * moved);
      }
      state.marginalsByDefinition[definitionId][sourceId] = [...sourceMass]
        .map(([count, probability]) => ({ count, probability }))
        .filter((branch) => branch.probability > 0)
        .sort((left, right) => left.count - right.count);
      state.marginalsByDefinition[definitionId][targetId] = [...targetMass]
        .map(([count, probability]) => ({ count, probability }))
        .filter((branch) => branch.probability > 0)
        .sort((left, right) => left.count - right.count);
    }
    state.slotsByBucket[sourceId] = Math.max(0, sourceSlots - eventProbability);
    state.slotsByBucket[targetId] = targetSlots + eventProbability;
    state.correlationMode = "marginalized";
  }
  return state;
}

/*
功能
从 HiddenPool 和合法已知身份一次性重建全部玩家牌数摘要。

调用方
Simulator 构造/clone 与每次 hidden mutation 之后。

输入
含 hiddenPoolState 与 SearchState players 的可变状态。

输出
同一状态。

读取状态
匿名池后验、viewer hand/合法 knownCards availability。

写入状态
recover/block/counter/assault 分布及其全部派生摘要。

调用函数
queryHiddenPool、Probability availability/join/project。

边界与不变量
这是隐藏概率 summary 的唯一 writer；摘要不可反向修改 HiddenPool，known identity 与匿名槽不得重复计数。
*/
export function projectHiddenSummaries(searchState) {
  const pool = searchState?.hiddenPoolState;
  if (!pool) return searchState;
  for (const player of searchState.players ?? []) {
    const identities = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ];
    for (const definitionId of HIDDEN_POOL_DEFINITION_IDS) {
      const anonymous = queryHiddenPool(pool, { definitionId, bucketId:player.id }).distribution;
      let known = [{ probability:1, conditions:{}, knownCount:0 }];
      for (const card of identities.filter((entry) => entry?.definitionId === definitionId)) {
        const availability = getAvailabilityStateBranches(card).map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions ?? {},
          available:Boolean(branch.available)
        }));
        known = projectProbabilityStateBranches(
          joinProbabilityStateBranches(known, availability),
          (branch) => ({ knownCount:branch.knownCount + (branch.available ? 1 : 0) })
        );
      }
      const distribution = projectProbabilityStateBranches(
        joinProbabilityStateBranches(
          anonymous.map((branch) => ({
            probability:branch.probability,
            conditions:{},
            anonymousCount:branch.count
          })),
          known
        ),
        (branch) => ({ count:branch.anonymousCount + branch.knownCount })
      ).sort((left, right) => left.count - right.count);
      const expected = distribution.reduce(
        (sum, branch) => sum + branch.count * branch.probability, 0
      );
      const atLeastOne = distribution.reduce(
        (sum, branch) => sum + (branch.count >= 1 ? branch.probability : 0), 0
      );
      if (definitionId === "recover") {
        player.recoverCountDistribution = distribution;
        player.expectedRecoverCount = expected;
      } else if (definitionId === "block") {
        player.blockCountDistribution = distribution.map(
          ({ count, ...branch }) => ({ ...branch, blockCount:count })
        );
        player.expectedBlockCount = expected;
        player.blockProbability = atLeastOne;
        player.twoBlockProbability = distribution.reduce(
          (sum, branch) => sum + (branch.count >= 2 ? branch.probability : 0), 0
        );
      } else if (definitionId === "counter") {
        player.counterCountDistribution = distribution.map(
          ({ count, ...branch }) => ({ ...branch, counterCount:count })
        );
        player.counterProbability = atLeastOne;
      } else {
        player.assaultCountDistribution = distribution;
        player.expectedAssaultCount = expected;
        player.assaultResponseProbability = atLeastOne;
      }
    }
  }
  return searchState;
}
