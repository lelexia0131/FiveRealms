/*
模块职责
唯一拥有 generic finite-pool sufficient state、精确分布、条件后验、消费、mutation 与当前池查询数学。

上游
Probability public facade。

下游
无。

状态边界
读写调用方提供的 finite-pool state；只保存当前 counts、total 与匿名槽充分统计。

信息边界
只处理调用方提供的 identity/category token 和当前容量，不读取业务定义或隐藏实体。

架构约束
不得依赖 Branch、业务模型、Generator、Simulator 或 Evaluator；不得保存历史 identity genealogy。
*/

const POOL_EPSILON = 1e-12;
const probabilityMemo = new WeakMap();

/*
功能
把 Pool 内部数值压缩为合法概率。

调用方
finite-pool query、conditioning 与 mutation。

输入
可转为数值的概率。

输出
零到一的有限概率。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
非数值按零处理；该 helper 不暴露为业务 contract。
*/
function clampPoolProbability(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/*
功能
汇总 Pool 内部局部分布的非负概率质量。

调用方
hypergeometric normalization。

输入
含 probability 的局部分布。

输出
非负质量总和。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不解释 payload 或擅自归一化。
*/
function poolProbabilityMass(branches = []) {
  return branches.reduce(
    (sum, branch) => sum + Math.max(0, Number(branch?.probability) || 0),
    0
  );
}

/*
功能
计算有限集合的无重复组合数。

调用方
hypergeometricCountDistribution、multinomialWeight。

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
使用 k 与 n-k 对称性缩短乘法链，不使用阶乘。
*/
function combination(total, selected) {
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
计算单桶目标数量的精确无放回超几何分布。

调用方
queryProbability 的无约束快速路径、business facade。

输入
总体、目标实例、抽取槽位与确定已知偏移。

输出
归一的 `{count, probability}` 分布。

读取状态
无。

写入状态
无。

调用函数
combination。

边界与不变量
只枚举合法 count 0..min(K,n)，不枚举 hidden hand identity。
*/
function hypergeometricCountDistribution(
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
    throw new RangeError(`超几何抽样数量 ${sampleSize} 超过总体 ${population}`);
  }
  if (sampleSize === 0 || population === 0) {
    return [{ count:knownOffset, probability:1 }];
  }
  const denominator = combination(population, sampleSize);
  const minimum = Math.max(0, sampleSize - (population - successes));
  const maximum = Math.min(sampleSize, successes);
  const distribution = [];
  let probability = combination(successes, minimum)
    * combination(population - successes, sampleSize - minimum)
    / denominator;
  for (let count = minimum; count <= maximum; count += 1) {
    if (probability > POOL_EPSILON) {
      distribution.push({ count:knownOffset + count, probability });
    }
    if (count < maximum) {
      probability *= (successes - count) / (count + 1)
        * (sampleSize - count) / (population - successes - sampleSize + count + 1);
    }
  }
  const total = poolProbabilityMass(distribution);
  return distribution.map((branch) => ({
    count:branch.count,
    probability:branch.probability / total
  }));
}

/*
功能
计算有限牌池中至少拥有指定总数目标牌的尾概率。

调用方
business facade 与局部概率查询。

输入
总体、目标实例、匿名槽、所需总数与确定已知偏移。

输出
零到一的精确尾概率。

读取状态
无。

写入状态
无。

调用函数
hypergeometricCountDistribution。

边界与不变量
不使用二项独立近似；offset 已满足 required 时直接返回一。
*/
export function hypergeometricProbabilityAtLeast(
  populationSize,
  successCount,
  draws,
  required,
  offset = 0
) {
  if (required <= offset) return 1;
  return hypergeometricCountDistribution(
    populationSize,
    successCount,
    draws,
    offset
  ).reduce((sum, branch) => sum + (branch.count >= required ? branch.probability : 0), 0);
}

/*
功能
从当前确定计数查询下一匿名牌的定义概率。

调用方
ResponseBoundary 等根状态窄查询。

输入
definitionId 到当前实例数的确定 Fact 与目标 definitionId。

输出
零到一的概率。

读取状态
只读调用方计数。

写入状态
无。

调用函数
无。

边界与不变量
空池或未知定义返回零；本函数不读取 GameState。
*/
export function probabilityFromCurrentCounts(currentCardCounts, definitionId) {
  if (!currentCardCounts || !Object.hasOwn(currentCardCounts, definitionId)) return 0;
  const total = Object.values(currentCardCounts).reduce(
    (sum, count) => sum + Math.max(0, Number(count) || 0),
    0
  );
  return total > 0
    ? clampPoolProbability((Number(currentCardCounts[definitionId]) || 0) / total)
    : 0;
}

/*
功能
计算无放回有限池中首次成功落到循环槽位的概率分布。

调用方
Probability facade 的延迟状态判定分布查询。

输入
当前总体、成功容量与正整数循环槽位数。

输出
只含 hop 与 probability 的首次成功分布；没有成功容量时为空。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
每次失败后总体减一，成功容量保持到首次命中；不使用独立 Bernoulli 或保存抽取 genealogy。
*/
export function cyclicFirstSuccessDistribution(total, successes, cycleLength) {
  let remainingTotal = Math.max(0, Math.floor(Number(total) || 0));
  const successCount = Math.max(
    0,
    Math.min(remainingTotal, Math.floor(Number(successes) || 0))
  );
  const slots = Math.max(0, Math.floor(Number(cycleLength) || 0));
  if (remainingTotal <= 0 || successCount <= 0 || slots <= 0) return [];
  const probabilities = Array.from({ length:slots }, () => 0);
  let reachProbability = 1;
  let drawIndex = 0;
  while (remainingTotal > 0 && reachProbability > POOL_EPSILON) {
    const hitProbability = successCount / remainingTotal;
    probabilities[drawIndex % slots] += reachProbability * hitProbability;
    reachProbability *= 1 - hitProbability;
    remainingTotal -= 1;
    drawIndex += 1;
  }
  return probabilities.map((probability, hop) => ({
    hop,
    probability
  })).filter((branch) => branch.probability > POOL_EPSILON);
}

/*
功能
从调用方提供的 identity counts 与分类器创建局部 finite-pool sequence state。

调用方
finitePoolSequence。

输入
identity 到容量的当前计数，以及把 identity 映射为 outcome key 的纯 classifier。

输出
唯一包含 counts、initialCounts 与 total 的局部 pool。

读取状态
无。

写入状态
无。

调用函数
classifier。

边界与不变量
非法/非正容量和 null outcome 被忽略；pool 只存在于本次 query，不进入 ProbabilityState 或 World。
*/
function createSequencePool(initialCounts = {}, classifier) {
  const counts = {};
  let total = 0;
  for (const [identity, rawCount] of Object.entries(initialCounts ?? {})) {
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count <= 0) continue;
    const outcome = classifier(identity);
    if (outcome == null) continue;
    const key = String(outcome);
    counts[key] = (counts[key] ?? 0) + count;
    total += count;
  }
  return {
    counts,
    initialCounts:counts,
    total
  };
}

/*
功能
通过唯一 Pool consumption path 扣减一个物理 outcome capacity。

调用方
finitePoolSequence。

输入
当前局部 pool 与 distribution branch 指定的 consumeKey。

输出
容量与 total 各减一的新 pool。

读取状态
当前 pool counts、initialCounts 与 total。

写入状态
无。

调用函数
无。

边界与不变量
不存在或已耗尽 key 立即失败；synthetic outcome 必须使用 null consumeKey，不能进入本函数。
*/
function consumeSequencePool(pool, consumeKey) {
  const available = pool.counts[consumeKey] ?? 0;
  if (available <= POOL_EPSILON || pool.total <= POOL_EPSILON) {
    throw new RangeError(`finite-pool outcome 已耗尽：${consumeKey}`);
  }
  return {
    counts:{ ...pool.counts, [consumeKey]:available - 1 },
    initialCounts:pool.initialCounts,
    total:pool.total - 1
  };
}

/*
功能
按 caller 提供的逐槽 distribution 推进 generic finite-pool without-replacement sequence。

调用方
Probability facade 的 business-facing sequence query。

输入
初始 identity counts、槽数、identity classifier 与逐槽 distribution callback。

输出
只含 probability 与 outcomes 的最终序列分布；内部 pool 已立即投影移除。

读取状态
每个局部 world 的唯一 pool。

写入状态
无。

调用函数
createSequencePool、distributionForSlot、consumeSequencePool。

边界与不变量
physical outcome 必须提供 consumeKey 并走唯一扣减路径；null consumeKey 表示 synthetic/non-physical；
不 clone World、不保存历史 genealogy，也不解释任何业务 outcome。
*/
export function finitePoolSequence({
  initialCounts = {},
  slotCount = 0,
  classifyOutcome,
  distributionForSlot
} = {}) {
  if (typeof classifyOutcome !== "function" || typeof distributionForSlot !== "function") {
    throw new TypeError("finitePoolSequence 缺少 classifier/distribution callback");
  }
  const count = Math.max(0, Math.floor(Number(slotCount) || 0));
  if (count <= 0) return [{ probability:1, outcomes:[] }];
  const initialPool = createSequencePool(initialCounts, classifyOutcome);
  let worlds = [{ probability:1, outcomes:[], pool:initialPool }];
  for (let slot = 0; slot < count; slot += 1) {
    worlds = worlds.flatMap((world) => (
      distributionForSlot(world.pool, slot).map((branch) => ({
        probability:world.probability * branch.probability,
        outcomes:[...world.outcomes, branch.outcome],
        pool:branch.consumeKey == null
          ? world.pool
          : consumeSequencePool(world.pool, String(branch.consumeKey))
      }))
    ));
  }
  return worlds.map(({ probability, outcomes }) => ({ probability, outcomes }));
}

/*
功能
规范一个匿名槽组，确保身份约束只由当前允许集合决定。

调用方
createFinitePoolState、canonicalizeProbabilityFactor、mutation helpers。

输入
bucketId、槽数与排除定义集合。

输出
可按当前物理语义排序和合并的普通槽组。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
槽数必须是整数；排除集合按定义排序，不保存产生约束的历史事件。
*/
function canonicalSlotGroup(bucketId, count, excludedDefinitions = []) {
  return {
    bucketId:String(bucketId),
    count:Math.max(0, Math.floor(Number(count) || 0)),
    excludedDefinitions:[...new Set(excludedDefinitions)]
      .filter((definitionId) => typeof definitionId === "string")
      .sort((left, right) => left.localeCompare(right))
  };
}

/*
功能
按当前 bucket 与允许身份集合合并匿名物理槽组。

调用方
createFinitePoolState、mergeProbabilityFactors、mutation helpers。

输入
槽组数组。

输出
稳定排序且没有零槽或重复语义组的新数组。

读取状态
无。

写入状态
无。

调用函数
canonicalSlotGroup。

边界与不变量
组身份只取决于当前 bucket 和 excludedDefinitions；历史 operation label 不进入签名。
*/
function canonicalizeSlotGroups(groups = []) {
  const merged = new Map();
  for (const rawGroup of groups) {
    const group = canonicalSlotGroup(
      rawGroup?.bucketId,
      rawGroup?.count,
      rawGroup?.excludedDefinitions
    );
    if (group.count <= 0) continue;
    const signature = `${group.bucketId}|${group.excludedDefinitions.join(",")}`;
    const current = merged.get(signature);
    if (current) current.count += group.count;
    else merged.set(signature, group);
  }
  return [...merged.values()].sort((left, right) => (
    left.bucketId.localeCompare(right.bucketId)
      || left.excludedDefinitions.join(",").localeCompare(right.excludedDefinitions.join(","))
  ));
}

/*
功能
生成当前有限池充分状态的稳定身份。

调用方
mergeProbabilityFactors、currentProbabilitySignature。

输入
一个不含历史事件的物理概率 factor。

输出
只含当前卡牌计数与当前匿名槽组的 JSON 签名。

读取状态
无。

写入状态
无。

调用函数
canonicalizeSlotGroups。

边界与不变量
概率质量、缓存版本、operation 次数和事件 label 不得进入签名。
*/
function probabilityFactorSignature(factor) {
  const cardCounts = Object.fromEntries(Object.entries(factor.cardCounts ?? {})
    .sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({
    populationSize:factor.populationSize,
    cardCounts,
    slotGroups:canonicalizeSlotGroups(factor.slotGroups)
  });
}

/*
功能
把等价的当前物理充分状态立即合并并归一概率质量。

调用方
createFinitePoolState、mutateFinitePool、conditionFinitePool。

输入
Probability factor 数组。

输出
按当前物理签名唯一的归一 factor 数组。

读取状态
无。

写入状态
无。

调用函数
probabilityFactorSignature、canonicalizeSlotGroups。

边界与不变量
两条历史只要当前牌池与匿名槽相同就必须合并；历史长度不影响输出数量。
*/
function mergeProbabilityFactors(factors = []) {
  const merged = new Map();
  for (const rawFactor of factors) {
    const probability = Math.max(0, Number(rawFactor?.probability) || 0);
    if (probability <= POOL_EPSILON) continue;
    const factor = {
      probability,
      populationSize:Math.max(0, Math.floor(Number(rawFactor.populationSize) || 0)),
      cardCounts:{ ...rawFactor.cardCounts },
      slotGroups:canonicalizeSlotGroups(rawFactor.slotGroups)
    };
    const signature = probabilityFactorSignature(factor);
    const current = merged.get(signature);
    if (current) current.probability += probability;
    else merged.set(signature, factor);
  }
  const total = [...merged.values()].reduce((sum, factor) => sum + factor.probability, 0);
  if (total <= POOL_EPSILON) return [];
  return [...merged.values()]
    .sort((left, right) => probabilityFactorSignature(left)
      .localeCompare(probabilityFactorSignature(right)))
    .map((factor) => ({
      ...factor,
      probability:factor.probability / total
    }));
}

/*
功能
从 Fact 创建唯一的当前 ProbabilityState。

调用方
  Probability.createProbabilityState。

输入
包含 players、knownCardsByPlayer、viewerId 与 currentCardCounts 的当前 Fact。

输出
只有一个当前物理 factor 的 ProbabilityState。

读取状态
Fact 的匿名手牌槽与当前有限牌池计数。

写入状态
无。

调用函数
canonicalSlotGroup、mergeProbabilityFactors。

边界与不变量
每个物理匿名槽只出现一次；未分配槽归 drawPool；不得创建 hidden allocation/world history。
*/
export function createFinitePoolState(fact, options = {}) {
  const currentCardCounts = { ...(fact?.currentCardCounts ?? {}) };
  const populationSize = Object.values(currentCardCounts).reduce(
    (sum, count) => sum + Math.max(0, Math.floor(Number(count) || 0)),
    0
  );
  const playerGroups = (fact?.players ?? []).map((player) => {
    const knownCount = player.id === fact.viewerId
      ? (player.hand?.length ?? 0)
      : (fact.knownCardsByPlayer?.[player.id]?.length ?? 0);
    return canonicalSlotGroup(
      player.id,
      player.id === fact.viewerId
        ? 0
        : Math.max(0, Math.floor(Number(player.handCount) || 0) - knownCount)
    );
  });
  const assigned = playerGroups.reduce((sum, group) => sum + group.count, 0);
  const factor = {
    probability:1,
    populationSize,
    cardCounts:currentCardCounts,
    slotGroups:[
      ...playerGroups,
      canonicalSlotGroup(options.drawBucketId, Math.max(0, populationSize - assigned))
    ]
  };
  return {
    classification:options.classification,
    factors:mergeProbabilityFactors([factor])
  };
}

/*
功能
返回 ProbabilityState 当前充分统计的稳定签名。

调用方
本次 AI calculation 的 memo key 与必要动态事件键。

输入
ProbabilityState。

输出
只由当前 factor 及其概率质量构成的字符串。

读取状态
ProbabilityState factors。

写入状态
无。

调用函数
probabilityFactorSignature。

边界与不变量
签名不包含 mutation 次数或历史 label；相同当前状态必须得到同一签名。
*/
export function currentProbabilitySignature(state) {
  return JSON.stringify((state?.factors ?? []).map((factor) => ({
    probability:factor.probability,
    state:probabilityFactorSignature(factor)
  })));
}

/*
功能
惰性投影当前状态混合中的 definition 实例期望计数。

调用方
仍接受定义计数的窄 Domain/Policy 查询。

输入
ProbabilityState。

输出
新的 definitionId 到期望实例数对象。

读取状态
当前 factors 的 cardCounts 与概率质量。

写入状态
无。

调用函数
无。

边界与不变量
该对象只是调用栈局部查询结果，不得写回 World 形成第二份持久概率摘要。
*/
export function queryCurrentCardCounts(state) {
  const counts = {};
  const definitions = new Set((state?.factors ?? []).flatMap(
    (factor) => Object.keys(factor.cardCounts ?? {})
  ));
  definitions.forEach((definitionId) => {
    counts[definitionId] = (state?.factors ?? []).reduce(
      (sum, factor) => sum + factor.probability * (Number(factor.cardCounts[definitionId]) || 0),
      0
    );
  });
  return counts;
}

/*
功能
查询当前状态混合中指定桶的期望匿名物理槽数。

调用方
business facade 的死亡清理与只读资源边界。

输入
ProbabilityState 与 bucketId。

输出
非负期望槽数。

读取状态
当前 factors 的整数 slotGroups 与概率质量。

写入状态
无。

调用函数
无。

边界与不变量
每个 factor 内槽数始终为整数；只有跨当前物理状态混合后的摘要允许为小数。
*/
export function expectedAnonymousSlots(state, bucketId) {
  const target = String(bucketId);
  return (state?.factors ?? []).reduce((sum, factor) => (
    sum + factor.probability * factor.slotGroups.reduce(
      (slots, group) => slots + (group.bucketId === target ? group.count : 0),
      0
    )
  ), 0);
}

/*
功能
查询当前状态混合中指定桶的匿名物理槽数量分布。

调用方
business facade 的随机手牌选择。

输入
ProbabilityState 与 bucketId。

输出
归一的 `{count, probability}` 分布。

读取状态
当前 factors 的整数 slotGroups。

写入状态
无。

调用函数
无。

边界与不变量
分布只由当前物理槽数决定；玩家对象不得保存第二份 anonymousCountBranches。
*/
export function queryAnonymousSlotDistribution(state, bucketId) {
  const target = String(bucketId);
  const massByCount = new Map();
  for (const factor of state?.factors ?? []) {
    const count = factor.slotGroups.reduce(
      (sum, group) => sum + (group.bucketId === target ? group.count : 0),
      0
    );
    massByCount.set(count, (massByCount.get(count) ?? 0) + factor.probability);
  }
  return [...massByCount.entries()]
    .map(([count, probability]) => ({ count, probability }))
    .sort((left, right) => left.count - right.count);
}

/*
功能
计算一个桶内多类别分配的多项式组合权重。

调用方
constrainedCountDistribution。

输入
桶槽数与各显式类别数量；剩余槽属于 other。

输出
该数量向量的组合权重。

读取状态
无。

写入状态
无。

调用函数
combination。

边界与不变量
所有类别共享同一物理槽，因而不能分别计算后再相乘。
*/
function multinomialWeight(slots, counts) {
  let remaining = slots;
  let weight = 1;
  for (const count of counts) {
    weight *= combination(remaining, count);
    remaining -= count;
  }
  return weight;
}

/*
功能
枚举一个当前槽组对相关牌种的合法数量向量。

调用方
constrainedCountDistribution 的有限池 DP。

输入
槽组、相关定义全局上界与 other 上界。

输出
携带 counts、other 与多项式权重的局部分配数组。

读取状态
槽组当前 excludedDefinitions。

写入状态
无。

调用函数
multinomialWeight。

边界与不变量
枚举维度只来自当前受查询/排除约束的牌种，禁止枚举具体牌身份。
*/
function enumerateGroupAllocations(group, definitions, categoryCounts, otherCount) {
  const allocations = [];
  const counts = Array.from({ length:definitions.length }, () => 0);
  /*
  功能
  递归枚举当前槽组在相关牌种维度上的合法数量向量。

  调用方
  enumerateGroupAllocations。

  输入
  当前牌种索引与尚未分配的物理槽数。

  输出
  无。

  读取状态
  group exclusions、definitions、categoryCounts 与 otherCount。

  写入状态
  回溯 counts，并向 allocations 追加完整向量。

  调用函数
  multinomialWeight。

  边界与不变量
  递归深度最多为当前查询相关牌种数，不枚举具体卡牌身份。
  */
  const visit = (index, slotsLeft) => {
    if (index >= definitions.length) {
      if (slotsLeft <= otherCount) {
        allocations.push({
          counts:[...counts],
          other:slotsLeft,
          weight:multinomialWeight(group.count, [...counts, slotsLeft])
        });
      }
      return;
    }
    const maximum = group.excludedDefinitions.includes(definitions[index])
      ? 0
      : Math.min(slotsLeft, categoryCounts[index]);
    for (let count = 0; count <= maximum; count += 1) {
      counts[index] = count;
      visit(index + 1, slotsLeft - count);
    }
    counts[index] = 0;
  };
  visit(0, group.count);
  return allocations;
}

/*
功能
在当前匿名槽排除约束下计算目标牌在指定槽组集合中的精确数量分布。

调用方
queryProbability、observedMutationTransitions、conditionFinitePool。

输入
单个当前 physical factor、目标 definitionId 与槽组选择谓词。

输出
归一 count distribution 及 DP 状态数。

读取状态
factor cardCounts 与 canonical slotGroups。

写入状态
无。

调用函数
hypergeometricCountDistribution、enumerateGroupAllocations、multinomialWeight。

边界与不变量
无排除约束时使用闭式超几何；存在约束时执行多类别稀疏 DP，所有牌种共享同一槽容量。
*/
function constrainedCountDistribution(factor, definitionId, selectsGroup) {
  const groups = factor.slotGroups.filter((group) => group.count > 0);
  const selectedSlots = groups.reduce(
    (sum, group) => sum + (selectsGroup(group) ? group.count : 0),
    0
  );
  const hasExclusions = groups.some((group) => group.excludedDefinitions.length > 0);
  if (!hasExclusions) {
    return {
      distribution:hypergeometricCountDistribution(
        factor.populationSize,
        factor.cardCounts[definitionId] ?? 0,
        selectedSlots
      ),
      dpStates:0
    };
  }
  const relevant = new Set([definitionId]);
  groups.forEach((group) => group.excludedDefinitions.forEach((excluded) => relevant.add(excluded)));
  const definitions = [...relevant].sort((left, right) => left.localeCompare(right));
  const targetIndex = definitions.indexOf(definitionId);
  const categoryCounts = definitions.map(
    (definition) => Math.max(0, Math.floor(Number(factor.cardCounts[definition]) || 0))
  );
  const otherCount = Math.max(
    0,
    factor.populationSize - categoryCounts.reduce((sum, count) => sum + count, 0)
  );
  const grouped = new Map();
  groups.forEach((group) => {
    const queried = selectsGroup(group);
    const signature = `${queried ? "query" : "rest"}|${group.excludedDefinitions.join(",")}`;
    const current = grouped.get(signature);
    if (current) current.count += group.count;
    else grouped.set(signature, { ...group, queried });
  });
  const workGroups = [...grouped.values()].sort((left, right) => left.count - right.count);
  const finalGroup = workGroups.pop();
  let dp = new Map([[JSON.stringify([...categoryCounts.map(() => 0), 0]), 1]]);
  let processedSlots = 0;
  let dpStates = 0;
  for (const group of workGroups) {
    const allocations = enumerateGroupAllocations(group, definitions, categoryCounts, otherCount);
    const next = new Map();
    for (const [signature, mass] of dp) {
      const values = JSON.parse(signature);
      const used = values.slice(0, definitions.length);
      const queryCount = values.at(-1);
      const usedOther = processedSlots - used.reduce((sum, count) => sum + count, 0);
      for (const allocation of allocations) {
        dpStates += 1;
        const nextUsed = used.map((count, index) => count + allocation.counts[index]);
        if (nextUsed.some((count, index) => count > categoryCounts[index])) continue;
        if (usedOther + allocation.other > otherCount) continue;
        const nextQuery = queryCount + (group.queried ? allocation.counts[targetIndex] : 0);
        const key = JSON.stringify([...nextUsed, nextQuery]);
        next.set(key, (next.get(key) ?? 0) + mass * allocation.weight);
      }
    }
    processedSlots += group.count;
    dp = next;
  }
  const raw = new Map();
  for (const [signature, mass] of dp) {
    const values = JSON.parse(signature);
    const used = values.slice(0, definitions.length);
    const queryCount = values.at(-1);
    const remaining = categoryCounts.map((count, index) => count - used[index]);
    const usedOther = processedSlots - used.reduce((sum, count) => sum + count, 0);
    const remainingOther = otherCount - usedOther;
    if (remaining.some((count, index) => (
      count < 0 || finalGroup.excludedDefinitions.includes(definitions[index]) && count > 0
    ))) continue;
    if (remainingOther < 0) continue;
    if (remaining.reduce((sum, count) => sum + count, remainingOther) !== finalGroup.count) continue;
    const finalWeight = multinomialWeight(finalGroup.count, [...remaining, remainingOther]);
    const totalQueryCount = queryCount + (finalGroup.queried ? remaining[targetIndex] : 0);
    raw.set(totalQueryCount, (raw.get(totalQueryCount) ?? 0) + mass * finalWeight);
  }
  const total = [...raw.values()].reduce((sum, mass) => sum + mass, 0);
  return {
    distribution:total > POOL_EPSILON
      ? [...raw.entries()].map(([count, mass]) => ({ count, probability:mass / total }))
        .sort((left, right) => left.count - right.count)
      : [],
    dpStates
  };
}

/*
功能
惰性查询当前有限牌池中的单桶、桶组或数量谓词概率。

调用方
State projection、business facade、business facade 与 Value/Policy 局部查询。

输入
ProbabilityState 以及 definitionId、bucketId/groupBucketIds、minimum 或 predicate。

输出
当前后验 count distribution、期望、谓词概率、单槽概率与 DP 状态数。

读取状态
ProbabilityState 当前 factors；同 state+query 可读取本次计算 memo。

写入状态
只写 WeakMap 计算缓存，不写 ProbabilityState。

调用函数
constrainedCountDistribution。

边界与不变量
查询不创建 hidden world universe；memo 不进入序列化状态，也不保存历史路径。
*/
export function queryProbability(state, query = {}) {
  const definitionId = query.definitionId;
  if (typeof definitionId !== "string" || !(state?.factors ?? []).some(
    (factor) => Object.hasOwn(factor.cardCounts ?? {}, definitionId)
  )) {
    return { distribution:[{ count:0, probability:1 }], expected:0, probability:0, slotProbability:0, dpStates:0 };
  }
  const bucketIds = new Set(Array.isArray(query.groupBucketIds)
    ? query.groupBucketIds.map(String)
    : query.bucketId == null ? [] : [String(query.bucketId)]);
  const cacheKey = `${definitionId}|${[...bucketIds].sort().join(",")}`;
  let memo = probabilityMemo.get(state);
  if (!memo) {
    memo = new Map();
    probabilityMemo.set(state, memo);
  }
  let baseResult = memo.get(cacheKey);
  if (!baseResult) {
    const massByCount = new Map();
    let dpStates = 0;
    for (const factor of state?.factors ?? []) {
      const result = constrainedCountDistribution(
        factor,
        definitionId,
        (group) => bucketIds.has(group.bucketId)
      );
      dpStates += result.dpStates;
      for (const branch of result.distribution) {
        massByCount.set(
          branch.count,
          (massByCount.get(branch.count) ?? 0) + factor.probability * branch.probability
        );
      }
    }
    const distribution = [...massByCount.entries()]
      .map(([count, probability]) => ({ count, probability }))
      .filter((branch) => branch.probability > POOL_EPSILON)
      .sort((left, right) => left.count - right.count);
    baseResult = { distribution, dpStates };
    memo.set(cacheKey, baseResult);
  }
  const predicate = typeof query.predicate === "function"
    ? query.predicate
    : (count) => count >= Math.max(0, Math.floor(Number(query.minimum) || 1));
  const probability = baseResult.distribution.reduce(
    (sum, branch) => sum + (predicate(branch.count) ? branch.probability : 0),
    0
  );
  const expected = baseResult.distribution.reduce(
    (sum, branch) => sum + branch.count * branch.probability,
    0
  );
  const slots = (state?.factors ?? []).reduce((sum, factor) => (
    sum + factor.probability * factor.slotGroups.reduce(
      (factorSlots, group) => factorSlots + (bucketIds.has(group.bucketId) ? group.count : 0),
      0
    )
  ), 0);
  return {
    distribution:baseResult.distribution,
    expected,
    probability:clampPoolProbability(probability),
    slotProbability:slots > 0 ? clampPoolProbability(expected / slots) : 0,
    dpStates:baseResult.dpStates
  };
}

/*
功能
查询指定匿名桶下一张物理牌属于一组定义的精确概率。

调用方
business facade、business facade 与 business facade 的当前判定牌类别查询。

输入
ProbabilityState、bucketId 与 definitionId 集合。

输出
零到一的类别概率。

读取状态
各当前 factor 的有限池后验与桶槽数。

写入状态
无。

调用函数
constrainedCountDistribution。

边界与不变量
先在每个当前 factor 内计算 `E[category count / slots]` 再按 factor 质量求和；
不得用跨 factor 的期望计数比值代替条件概率。
*/
export function queryCardCategoryProbability(state, bucketId, definitionIds = []) {
  const targetBucketId = String(bucketId);
  const definitions = [...new Set(definitionIds)].filter((definitionId) => (
    typeof definitionId === "string"
  ));
  let probability = 0;
  for (const factor of state?.factors ?? []) {
    const slots = factor.slotGroups.reduce(
      (sum, group) => sum + (group.bucketId === targetBucketId ? group.count : 0),
      0
    );
    if (slots <= 0) continue;
    let expected = 0;
    for (const definitionId of definitions) {
      if (!Object.hasOwn(factor.cardCounts ?? {}, definitionId)) continue;
      const result = constrainedCountDistribution(
        factor,
        definitionId,
        (group) => group.bucketId === targetBucketId
      );
      expected += result.distribution.reduce(
        (sum, branch) => sum + branch.count * branch.probability,
        0
      );
    }
    probability += factor.probability * expected / slots;
  }
  return clampPoolProbability(probability);
}

/*
功能
把“当前桶中确定没有某牌种”的观察写回充分统计后验。

调用方
business facade 与 business facade 的配对反事实。

输入
可变 ProbabilityState、definitionId、bucketId 与 maximum=0 条件。

输出
观察发生前的条件概率。

读取状态
当前 finite-pool factors。

写入状态
只更新当前槽组允许集合并立即按物理签名合并。

调用函数
constrainedCountDistribution、mergeProbabilityFactors。

边界与不变量
不保存 condition event 或 genealogy；同一排除条件重复应用不会增加状态维度。
*/
export function conditionFinitePool(state, condition = {}, allowedDefinitionIds = []) {
  if (condition.maximum !== 0 || (allowedDefinitionIds.length > 0 && !allowedDefinitionIds.includes(condition.definitionId))) {
    throw new RangeError("Probability 当前条件写入只接受 bucket count = 0 的确定观察");
  }
  const bucketId = String(condition.bucketId);
  const conditioned = [];
  let evidence = 0;
  for (const factor of state?.factors ?? []) {
    const result = constrainedCountDistribution(
      factor,
      condition.definitionId,
      (group) => group.bucketId === bucketId
    );
    const probability = result.distribution.reduce(
      (sum, branch) => sum + (branch.count === 0 ? branch.probability : 0),
      0
    );
    evidence += factor.probability * probability;
    if (probability <= POOL_EPSILON) continue;
    conditioned.push({
      ...factor,
      probability:factor.probability * probability,
      slotGroups:factor.slotGroups.map((group) => (
        group.bucketId === bucketId
          ? canonicalSlotGroup(group.bucketId, group.count, [
              ...group.excludedDefinitions,
              condition.definitionId
            ])
          : { ...group, excludedDefinitions:[...group.excludedDefinitions] }
      ))
    });
  }
  state.factors = mergeProbabilityFactors(conditioned);
  probabilityMemo.delete(state);
  return clampPoolProbability(evidence);
}

/*
功能
克隆一个当前物理 factor，供单次 mutation 构造新状态。

调用方
anonymousMutationTransitions、observedMutationTransitions。

输入
Probability factor。

输出
不共享 cardCounts/slotGroups 的普通副本。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
概率质量由调用方设置；副本不携带操作历史。
*/
function cloneProbabilityFactor(factor) {
  return {
    ...factor,
    cardCounts:{ ...factor.cardCounts },
    slotGroups:factor.slotGroups.map((group) => ({
      ...group,
      excludedDefinitions:[...group.excludedDefinitions]
    }))
  };
}

/*
功能
按当前槽组约束移动一张未观察身份的匿名物理牌。

调用方
mutateFinitePool。

输入
单 factor、来源桶与目标桶。

输出
按当前来源槽组选择概率加权的 factor transitions。

读取状态
来源当前物理槽组数量。

写入状态
只写返回 factor 的槽组数量。

调用函数
cloneProbabilityFactor、canonicalSlotGroup、canonicalizeSlotGroups。

边界与不变量
同一物理槽只移动一次；槽携带当前允许身份集合，不产生牌种 identity branches。
*/
function anonymousMutationTransitions(factor, sourceBucketId, targetBucketId) {
  const sourceGroups = factor.slotGroups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => group.bucketId === sourceBucketId && group.count > 0);
  const sourceSlots = sourceGroups.reduce((sum, entry) => sum + entry.group.count, 0);
  if (sourceSlots <= 0) return [];
  return sourceGroups.map(({ group, index }) => {
    const next = cloneProbabilityFactor(factor);
    next.slotGroups[index].count -= 1;
    next.slotGroups.push(canonicalSlotGroup(
      targetBucketId,
      1,
      group.excludedDefinitions
    ));
    next.slotGroups = canonicalizeSlotGroups(next.slotGroups);
    return { weight:group.count / sourceSlots, factor:next };
  });
}

/*
功能
在观察到具体定义后消费来源桶中的一张匿名物理牌。

调用方
mutateFinitePool 的响应支付与已观察身份移出。

输入
单 factor、来源桶与已观察 definitionId。

输出
按该定义实际位于各当前槽组的后验权重生成 transitions。

读取状态
当前 finite-pool 后验与来源槽组。

写入状态
返回 factor 的槽组、总体与对应定义计数各减一。

调用函数
constrainedCountDistribution、cloneProbabilityFactor、canonicalizeSlotGroups。

边界与不变量
观察身份后卡牌退出匿名池；所有牌种共享同一槽，因此同一牌不可能同时消费为两种定义。
*/
function observedMutationTransitions(factor, sourceBucketId, definitionId) {
  const candidates = [];
  let expectedInSource = 0;
  factor.slotGroups.forEach((group, index) => {
    if (group.bucketId !== sourceBucketId || group.count <= 0) return;
    const result = constrainedCountDistribution(
      factor,
      definitionId,
      (entry) => entry === group
    );
    const expected = result.distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability,
      0
    );
    if (expected > POOL_EPSILON) candidates.push({ index, expected });
    expectedInSource += expected;
  });
  if (expectedInSource <= POOL_EPSILON) return [];
  return candidates.map(({ index, expected }) => {
    const next = cloneProbabilityFactor(factor);
    next.slotGroups[index].count -= 1;
    next.slotGroups = canonicalizeSlotGroups(next.slotGroups);
    next.populationSize = Math.max(0, next.populationSize - 1);
    next.cardCounts[definitionId] = Math.max(0, (next.cardCounts[definitionId] ?? 0) - 1);
    return { weight:expected / expectedInSource, factor:next };
  });
}

/*
功能
对一次公开但事前未知的随机移出按定义做局部全概率展开，并立即收敛到当前牌池计数。

调用方
mutateFinitePool 的匿名 REMOVE。

输入
单 factor 与来源桶。

输出
按实际被移出定义和来源槽组加权的当前 factor transitions。

读取状态
当前 finite-pool 后验与来源物理槽数。

写入状态
只写返回 factor 的当前 cardCounts/slotGroups。

调用函数
constrainedCountDistribution、observedMutationTransitions。

边界与不变量
definition outcomes 只在本次计算临时存在；返回状态不保存 operation identity，且同一物理槽只对应一个定义。
*/
function anonymousObservedRemovalTransitions(factor, sourceBucketId) {
  const sourceSlots = factor.slotGroups.reduce(
    (sum, group) => sum + (group.bucketId === sourceBucketId ? group.count : 0),
    0
  );
  if (sourceSlots <= 0) return [];
  const transitions = [];
  for (const definitionId of Object.keys(factor.cardCounts ?? {})) {
    const distribution = constrainedCountDistribution(
      factor,
      definitionId,
      (group) => group.bucketId === sourceBucketId
    ).distribution;
    const expected = distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability,
      0
    );
    if (expected <= POOL_EPSILON) continue;
    const definitionProbability = expected / sourceSlots;
    for (const transition of observedMutationTransitions(
      factor,
      sourceBucketId,
      definitionId
    )) {
      transitions.push({
        weight:definitionProbability * transition.weight,
        factor:transition.factor
      });
    }
  }
  return transitions;
}

/*
功能
按 MOVE/ADD/REMOVE 数据推进当前匿名物理充分状态。

调用方
business facade、business facade、business facade。

输入
可变 ProbabilityState 与来源/目标、整数 count、发生概率及可选已观察 definitionId。

输出
同一 ProbabilityState。

读取状态
当前 finite-pool factors。

写入状态
替换为 mutation 后按当前物理签名合并的 factors，并清空本次计算 memo。

调用函数
anonymousMutationTransitions、observedMutationTransitions、mergeProbabilityFactors。

边界与不变量
每个 factor 的槽数始终为整数；概率性发生通过当前状态混合表达，历史 operation count 不进入任何 factor。
*/
export function mutateFinitePool(state, mutation = {}, options = {}) {
  if (mutation.type === "CONDITION") {
    conditionFinitePool(state, mutation, options.allowedDefinitionIds);
    return state;
  }
  const sourceBucketId = String(mutation.sourceBucketId
    ?? (mutation.type === "ADD" ? options.drawBucketId : ""));
  const targetBucketId = String(mutation.targetBucketId
    ?? (mutation.type === "REMOVE" ? "observed/removal" : ""));
  if (!sourceBucketId || !targetBucketId || sourceBucketId === targetBucketId) return state;
  const steps = Math.max(1, Math.floor(Number(mutation.count) || 1));
  const occurrence = clampPoolProbability(mutation.probability ?? 1);
  for (let step = 0; step < steps; step += 1) {
    const nextFactors = [];
    for (const factor of state?.factors ?? []) {
      const transitions = typeof mutation.definitionId === "string"
        ? observedMutationTransitions(factor, sourceBucketId, mutation.definitionId)
        : mutation.type === "REMOVE"
          ? anonymousObservedRemovalTransitions(factor, sourceBucketId)
          : anonymousMutationTransitions(factor, sourceBucketId, targetBucketId);
      const transitionMass = transitions.reduce((sum, transition) => sum + transition.weight, 0);
      const unchanged = 1 - occurrence * Math.min(1, transitionMass);
      if (unchanged > POOL_EPSILON) {
        nextFactors.push({ ...cloneProbabilityFactor(factor), probability:factor.probability * unchanged });
      }
      transitions.forEach((transition) => {
        nextFactors.push({
          ...transition.factor,
          probability:factor.probability * occurrence * transition.weight
        });
      });
    }
    state.factors = mergeProbabilityFactors(nextFactors);
  }
  probabilityMemo.delete(state);
  return state;
}
