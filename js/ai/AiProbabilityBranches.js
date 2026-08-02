const EPSILON = 1e-12;

export const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/** 装备条件键只描述公开模拟世界，不拥有或消耗装备本身。 */
export const equipmentConditionKey = (playerId, definitionId) => `equipment:${playerId}:${definitionId}`;

export const huntMarkConditionKey = (sourceId, targetId) => `huntMark:${sourceId}:${targetId}`;

const normalizeConditions = (conditions = {}) => Object.fromEntries(
  Object.entries(conditions).sort(([left], [right]) => left.localeCompare(right))
);

const conditionSignature = (conditions) => JSON.stringify(normalizeConditions(conditions));

const compatible = (left, right) => Object.entries(left).every(([key, value]) => (
  right[key] === undefined || right[key] === value
));

/** 合并同一条件集合的概率质量；调用方仍拥有返回的新分支数组。 */
export function mergeProbabilityBranches(branches = []) {
  const merged = new Map();
  for (const branch of branches) {
    const probability = Math.max(0, Number(branch?.probability) || 0);
    if (probability <= EPSILON) continue;
    const conditions = normalizeConditions(branch.conditions);
    const signature = conditionSignature(conditions);
    const current = merged.get(signature);
    if (current) current.probability += probability;
    else merged.set(signature, { probability, conditions });
  }
  return [...merged.values()];
}

export const totalBranchProbability = (branches = []) => branches.reduce(
  (sum, branch) => sum + Math.max(0, Number(branch?.probability) || 0), 0
);

/**
 * 每张抽象卡牌（或技能次数槽）独占自己的可用分支；后续消费总是保留
 * 互斥条件下尚未使用的概率质量。
 */
export function getAvailabilityBranches(resource, fallbackProbability = 1) {
  if (Array.isArray(resource?.availabilityBranches)) {
    return mergeProbabilityBranches(resource.availabilityBranches);
  }
  const probability = clampProbability(fallbackProbability);
  return probability > EPSILON ? [{ probability, conditions:{} }] : [];
}

/** 创建一个完整二元条件分区；matches 表示动作在该世界分支是否成立。 */
export function binaryConditionPartition(key, presentProbability, presentMatches = true, absentMatches = false) {
  const probability = clampProbability(presentProbability);
  return [
    { probability, conditions:{ [key]:'present' }, matches:presentMatches },
    { probability:1 - probability, conditions:{ [key]:'absent' }, matches:absentMatches }
  ].filter((branch) => branch.probability > EPSILON);
}

/**
 * 用完整世界条件分区细分资源可用分支。相同条件只做条件化，不会把望远镜等
 * 共享条件的概率重复相乘；matching 是本动作消费的质量，remaining 归原资源所有。
 */
export function partitionAvailabilityBranches(availabilityBranches, conditionPartition) {
  const available = getAvailabilityBranches({ availabilityBranches }, 0);
  const worlds = (conditionPartition?.length ? conditionPartition : [
    { probability:1, conditions:{}, matches:true }
  ]).filter((branch) => (Number(branch?.probability) || 0) > EPSILON);
  const matching = [];
  const remaining = [];

  for (const availableBranch of available) {
    const compatibleWorlds = worlds.filter((world) => compatible(availableBranch.conditions, world.conditions ?? {}));
    const denominator = compatibleWorlds.reduce((sum, world) => sum + (Number(world.probability) || 0), 0);
    if (denominator <= EPSILON) {
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
