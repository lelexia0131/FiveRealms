export const PROBABILITY_EPSILON = 1e-12;

export const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/** 装备条件键只描述公开模拟世界，不拥有或消耗装备本身。 */
export const equipmentConditionKey = (playerId, definitionId) => `equipment:${playerId}:${definitionId}`;

export const huntMarkConditionKey = (sourceId, targetId) => `huntMark:${sourceId}:${targetId}`;

export const normalizeConditions = (conditions = {}) => Object.fromEntries(
  Object.entries(conditions).sort(([left], [right]) => left.localeCompare(right))
);

const conditionSignature = (conditions) => JSON.stringify(normalizeConditions(conditions));

export const conditionsCompatible = (left = {}, right = {}) => Object.entries(left).every(([key, value]) => (
  right[key] === undefined || right[key] === value
));

const compatible = conditionsCompatible;

const branchState = (branch = {}) => Object.fromEntries(Object.entries(branch)
  .filter(([key]) => key !== "probability" && key !== "conditions")
  .sort(([left], [right]) => left.localeCompare(right)));

const stateSignature = (branch) => JSON.stringify({
  conditions:normalizeConditions(branch?.conditions),
  state:branchState(branch)
});

const sortBranches = (branches) => [...branches].sort((left, right) => (
  stateSignature(left).localeCompare(stateSignature(right))
));

/** 合并同一条件集合的概率质量；调用方仍拥有返回的新分支数组。 */
export function mergeProbabilityBranches(branches = []) {
  const merged = new Map();
  for (const branch of branches) {
    const probability = Math.max(0, Number(branch?.probability) || 0);
    if (probability <= PROBABILITY_EPSILON) continue;
    const conditions = normalizeConditions(branch.conditions);
    const signature = conditionSignature(conditions);
    const current = merged.get(signature);
    if (current) current.probability += probability;
    else merged.set(signature, { probability, conditions });
  }
  return sortBranches(merged.values());
}

export const totalBranchProbability = (branches = []) => branches.reduce(
  (sum, branch) => sum + Math.max(0, Number(branch?.probability) || 0), 0
);

/** 只合并条件集合与资源状态都完全相同的分支。 */
export function mergeProbabilityStateBranches(branches = []) {
  const merged = new Map();
  for (const rawBranch of branches) {
    const probability = Math.max(0, Number(rawBranch?.probability) || 0);
    if (probability <= PROBABILITY_EPSILON) continue;
    const branch = {
      ...branchState(rawBranch),
      probability,
      conditions:normalizeConditions(rawBranch?.conditions)
    };
    const signature = stateSignature(branch);
    const current = merged.get(signature);
    if (current) current.probability += probability;
    else merged.set(signature, branch);
  }
  return sortBranches([...merged.values()].filter((branch) => branch.probability > PROBABILITY_EPSILON));
}

/**
 * 联合多个完整概率分区。共享条件会按条件概率相交，互不相关的条件才相乘。
 * 各分区的状态字段名必须唯一；同名且取值冲突的分支会被视为不兼容。
 */
export function joinProbabilityStateBranches(...partitions) {
  let joined = [{ probability:1, conditions:{} }];
  for (const rawPartition of partitions.filter(Array.isArray)) {
    const partition = mergeProbabilityStateBranches(rawPartition);
    if (!partition.length) return [];
    const next = [];
    for (const base of joined) {
      const compatibleBranches = partition.filter((candidate) => {
        if (!compatible(base.conditions, candidate.conditions)) return false;
        const baseState = branchState(base);
        const candidateState = branchState(candidate);
        return Object.entries(baseState).every(([key, value]) => (
          candidateState[key] === undefined || Object.is(candidateState[key], value)
        ));
      });
      const denominator = compatibleBranches.reduce(
        (sum, branch) => sum + Math.max(0, Number(branch.probability) || 0), 0
      );
      if (denominator <= PROBABILITY_EPSILON) continue;
      for (const candidate of compatibleBranches) {
        next.push({
          ...branchState(base),
          ...branchState(candidate),
          probability:base.probability * candidate.probability / denominator,
          conditions:normalizeConditions({ ...base.conditions, ...candidate.conditions })
        });
      }
    }
    joined = mergeProbabilityStateBranches(next);
  }
  return joined;
}

/** 将完整世界分区投影为资源分支，并按严格的“条件+资源值”规则合并。 */
export function projectProbabilityStateBranches(worldBranches, projector) {
  return mergeProbabilityStateBranches((worldBranches ?? []).map((world) => ({
    ...projector(world),
    probability:world.probability,
    conditions:world.conditions
  })));
}

export function getValueBranches(resource, field, fallbackValue = 0) {
  const branches = Array.isArray(resource?.[`${field}Branches`])
    ? resource[`${field}Branches`]
    : null;
  if (branches?.length) return mergeProbabilityStateBranches(branches);
  return [{ probability:1, conditions:{}, amount:Number(fallbackValue) || 0 }];
}

export const expectedBranchValue = (branches = [], field = "amount") => branches.reduce(
  (sum, branch) => sum + (Number(branch?.probability) || 0) * (Number(branch?.[field]) || 0), 0
);

/** 构造带稳定条件键的完整事件分区。 */
export function probabilityEventPartition(key, probability, stateField = "occurs") {
  const chance = clampProbability(probability);
  if (chance <= PROBABILITY_EPSILON) return [{ probability:1, conditions:{}, [stateField]:false }];
  if (chance >= 1 - PROBABILITY_EPSILON) return [{ probability:1, conditions:{}, [stateField]:true }];
  return [
    { probability:chance, conditions:{ [key]:"yes" }, [stateField]:true },
    { probability:1 - chance, conditions:{ [key]:"no" }, [stateField]:false }
  ];
}

/**
 * 每张抽象卡牌（或技能次数槽）独占自己的可用分支；后续消费总是保留
 * 互斥条件下尚未使用的概率质量。
 */
export function getAvailabilityBranches(resource, fallbackProbability = 1) {
  if (Array.isArray(resource?.availabilityBranches)) {
    return mergeProbabilityBranches(resource.availabilityBranches);
  }
  const probability = clampProbability(fallbackProbability);
  return probability > PROBABILITY_EPSILON ? [{ probability, conditions:{} }] : [];
}

/**
 * 返回卡牌或次数槽的完整可用状态分区。新状态使用 stateProperty 保存完整分区；
 * availabilityBranches 继续作为仅含“仍可用世界”的兼容视图。
 */
export function getAvailabilityStateBranches(resource, stateProperty = "availabilityStateBranches", fallbackProbability = 1) {
  if (Array.isArray(resource?.[stateProperty]) && resource[stateProperty].length) {
    return mergeProbabilityStateBranches(resource[stateProperty]);
  }
  const available = getAvailabilityBranches(resource, fallbackProbability);
  const probability = totalBranchProbability(available);
  if (probability >= 1 - PROBABILITY_EPSILON) {
    return available.map((branch) => ({ ...branch, available:true }));
  }
  return mergeProbabilityStateBranches([
    ...available.map((branch) => ({ ...branch, available:true })),
    { probability:1 - probability, conditions:{}, available:false }
  ]);
}

export const availableBranchesFromState = (branches = []) => mergeProbabilityBranches(
  branches.filter((branch) => branch.available).map(({ probability, conditions }) => ({ probability, conditions }))
);

/** 创建一个完整二元条件分区；matches 表示动作在该世界分支是否成立。 */
export function binaryConditionPartition(key, presentProbability, presentMatches = true, absentMatches = false) {
  const probability = clampProbability(presentProbability);
  return [
    { probability, conditions:{ [key]:'present' }, matches:presentMatches },
    { probability:1 - probability, conditions:{ [key]:'absent' }, matches:absentMatches }
  ].filter((branch) => branch.probability > PROBABILITY_EPSILON);
}

/**
 * 用完整世界条件分区细分资源可用分支。相同条件只做条件化，不会把望远镜等
 * 共享条件的概率重复相乘；matching 是本动作消费的质量，remaining 归原资源所有。
 */
export function partitionAvailabilityBranches(availabilityBranches, conditionPartition) {
  const available = getAvailabilityBranches({ availabilityBranches }, 0);
  const worlds = (conditionPartition?.length ? conditionPartition : [
    { probability:1, conditions:{}, matches:true }
  ]).filter((branch) => (Number(branch?.probability) || 0) > PROBABILITY_EPSILON);
  const matching = [];
  const remaining = [];

  for (const availableBranch of available) {
    const compatibleWorlds = worlds.filter((world) => compatible(availableBranch.conditions, world.conditions ?? {}));
    const denominator = compatibleWorlds.reduce((sum, world) => sum + (Number(world.probability) || 0), 0);
    if (denominator <= PROBABILITY_EPSILON) {
      remaining.push(availableBranch);
      continue;
    }
    for (const world of compatibleWorlds) {
      const probability = availableBranch.probability * (Number(world.probability) || 0) / denominator;
      const branch = {
        probability,
        conditions:normalizeConditions({ ...availableBranch.conditions, ...(world.conditions ?? {}) })
      };
      (world.matches ? matching : remaining).push(branch);
    }
  }

  return {
    matching:mergeProbabilityBranches(matching),
    remaining:mergeProbabilityBranches(remaining)
  };
}
