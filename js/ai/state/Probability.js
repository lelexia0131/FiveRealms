/*
模块职责
提供 SearchState 概率分支的规范化、联合、投影与资源可用性纯函数。

上游
ActionGenerator、Simulator、领域评分模块、概率兼容外观与状态契约测试。

下游
无。

状态边界
只读普通概率分支并返回新分支，不读写 GameState 或 SearchState 实体。

信息边界
只处理调用方提供的概率、条件与普通状态字段，不引入隐藏信息来源。

架构约束
不得包含卡牌、技能或角色规则；领域概率模型必须由上层构造后传入。
*/

export const PROBABILITY_EPSILON = 1e-12;

/*
功能
把任意数值压缩为合法概率。

调用方
概率分区与资源可用性工具。

输入
可转为数值的概率候选值。

输出
零到一之间的有限数值。

读取状态
无。

写入状态
无。

调用函数
Number、Math.min、Math.max。

边界与不变量
非数值按零处理。
*/
export function clampProbability(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/*
功能
生成公开装备世界条件的稳定键。

调用方
Simulator 与装备相关评分。

输入
玩家 ID 与装备定义 ID。

输出
稳定的条件字符串。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
相同实体组合必须生成相同键。
*/
export function equipmentConditionKey(playerId, definitionId) {
  return `equipment:${playerId}:${definitionId}`;
}

/*
功能
生成猎杀标记世界条件的稳定键。

调用方
Simulator 与猎杀相关评分。

输入
来源玩家 ID 与目标玩家 ID。

输出
稳定的条件字符串。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
相同来源目标组合必须生成相同键。
*/
export function huntMarkConditionKey(sourceId, targetId) {
  return `huntMark:${sourceId}:${targetId}`;
}

/*
功能
按条件键排序以获得确定性的世界条件对象。

调用方
所有概率分支合并与签名函数。

输入
条件键值普通对象。

输出
键顺序稳定的新对象。

读取状态
无。

写入状态
无。

调用函数
Object.entries、localeCompare。

边界与不变量
不得修改输入条件对象。
*/
export function normalizeConditions(conditions = {}) {
  return Object.fromEntries(
    Object.entries(conditions).sort(([left], [right]) => left.localeCompare(right))
  );
}

/*
功能
为规范化世界条件生成稳定比较签名。

调用方
mergeProbabilityBranches。

输入
条件键值对象。

输出
稳定 JSON 字符串。

读取状态
无。

写入状态
无。

调用函数
normalizeConditions、JSON.stringify。

边界与不变量
键顺序不同但语义相同的条件必须得到同一签名。
*/
function conditionSignature(conditions) {
  return JSON.stringify(normalizeConditions(conditions));
}

/*
功能
判断两个世界条件是否不存在同键冲突。

调用方
joinProbabilityStateBranches、partitionAvailabilityBranches。

输入
两个条件键值对象。

输出
兼容返回 true，否则 false。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
任一侧缺少某键不构成冲突，同键不同值才冲突。
*/
export function conditionsCompatible(left = {}, right = {}) {
  return Object.entries(left).every(([key, value]) => right[key] === undefined || right[key] === value);
}

/*
功能
提取概率分支中除概率和条件外的普通状态字段并稳定排序。

调用方
状态分支合并、联合与签名。

输入
概率状态分支。

输出
新的状态字段对象。

读取状态
无。

写入状态
无。

调用函数
Object.entries、localeCompare。

边界与不变量
不得修改原分支，概率与条件不得进入状态签名。
*/
function branchState(branch = {}) {
  return Object.fromEntries(Object.entries(branch)
    .filter(([key]) => key !== "probability" && key !== "conditions")
    .sort(([left], [right]) => left.localeCompare(right)));
}

/*
功能
为条件和资源状态均规范化的完整分支生成稳定签名。

调用方
mergeProbabilityStateBranches。

输入
完整概率状态分支。

输出
稳定 JSON 字符串。

读取状态
无。

写入状态
无。

调用函数
normalizeConditions、branchState、JSON.stringify。

边界与不变量
只有条件和所有状态字段均相同的分支才共享签名。
*/
function stateSignature(branch) {
  return JSON.stringify({
    conditions:normalizeConditions(branch?.conditions),
    state:branchState(branch)
  });
}

/*
功能
判断两个完整状态分支能否处于同一搜索世界。

调用方
joinProbabilityStateBranches。

输入
已联合基础分支与候选分支。

输出
条件和同名状态字段均兼容时返回 true。

读取状态
无。

写入状态
无。

调用函数
conditionsCompatible、branchState。

边界与不变量
同名状态字段取值冲突必须拒绝联合。
*/
function stateBranchesCompatible(base, candidate) {
  if (!conditionsCompatible(base.conditions, candidate.conditions)) return false;
  const baseState = branchState(base);
  const candidateState = branchState(candidate);
  return Object.entries(baseState).every(([key, value]) => (
    candidateState[key] === undefined || Object.is(candidateState[key], value)
  ));
}

/*
功能
合并条件集合完全相同的概率质量。

调用方
资源可用性与条件分区工具。

输入
只需 probability 与 conditions 的分支数组。

输出
条件唯一且概率为正的新分支数组。

读取状态
无。

写入状态
无。

调用函数
normalizeConditions、conditionSignature。

边界与不变量
非正或低于误差阈值的质量丢弃，输入分支不被修改。
*/
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
  return [...merged.values()];
}

/*
功能
汇总概率分支的非负质量。

调用方
可用性投影、测试与概率调用方。

输入
概率分支数组。

输出
非负概率质量总和。

读取状态
无。

写入状态
无。

调用函数
Number、Math.max。

边界与不变量
非法概率按零处理，不擅自归一化。
*/
export function totalBranchProbability(branches = []) {
  return branches.reduce(
    (sum, branch) => sum + Math.max(0, Number(branch?.probability) || 0),
    0
  );
}

/*
功能
合并条件集合与资源状态都完全相同的概率质量。

调用方
完整状态联合、投影与资源状态读取。

输入
包含 probability、conditions 和普通状态字段的分支数组。

输出
完整签名唯一且概率为正的新分支数组。

读取状态
无。

写入状态
无。

调用函数
branchState、normalizeConditions、stateSignature。

边界与不变量
状态不同的世界不得因条件相同而合并。
*/
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
  return [...merged.values()].filter((branch) => branch.probability > PROBABILITY_EPSILON);
}

/*
功能
联合多个完整概率分区并正确条件化共享世界条件。

调用方
Simulator 与多资源联合评分、状态契约测试。

输入
零个或多个完整概率状态分区。

输出
条件与同名状态字段兼容的联合分支数组。

读取状态
无。

写入状态
无。

调用函数
mergeProbabilityStateBranches、stateBranchesCompatible、branchState、normalizeConditions。

边界与不变量
共享条件只条件化一次，独立条件才相乘，同名状态冲突必须排除。
*/
export function joinProbabilityStateBranches(...partitions) {
  let joined = [{ probability:1, conditions:{} }];
  for (const rawPartition of partitions.filter(Array.isArray)) {
    const partition = mergeProbabilityStateBranches(rawPartition);
    if (!partition.length) return [];
    const next = [];
    for (const base of joined) {
      const compatibleBranches = partition.filter((candidate) => stateBranchesCompatible(base, candidate));
      const denominator = compatibleBranches.reduce(
        (sum, branch) => sum + Math.max(0, Number(branch.probability) || 0),
        0
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

/*
功能
把完整世界分区投影为调用方选择的资源状态并按完整签名合并。

调用方
Simulator 概率状态转换与领域评分。

输入
世界分支数组与不产生副作用的状态投影函数。

输出
携带原概率条件的新状态分区。

读取状态
无。

写入状态
无。

调用函数
projector、mergeProbabilityStateBranches。

边界与不变量
投影不得改变世界概率和条件，输入世界不被修改。
*/
export function projectProbabilityStateBranches(worldBranches, projector) {
  return mergeProbabilityStateBranches((worldBranches ?? []).map((world) => ({
    ...projector(world),
    probability:world.probability,
    conditions:world.conditions
  })));
}

/*
功能
读取资源数值字段的完整概率分支并提供确定性回退。

调用方
Simulator 与价值计算模块。

输入
资源对象、字段名与回退值。

输出
规范化数值状态分支数组。

读取状态
resource 对应 Branches 字段。

写入状态
无。

调用函数
mergeProbabilityStateBranches、Number。

边界与不变量
缺失或空分支时返回一个概率为一的 amount 回退分支。
*/
export function getValueBranches(resource, field, fallbackValue = 0) {
  const branches = Array.isArray(resource?.[`${field}Branches`])
    ? resource[`${field}Branches`]
    : null;
  if (branches?.length) return mergeProbabilityStateBranches(branches);
  return [{ probability:1, conditions:{}, amount:Number(fallbackValue) || 0 }];
}

/*
功能
计算概率状态分支中指定数值字段的未归一期望。

调用方
Simulator 与价值计算模块。

输入
概率分支数组与数值字段名。

输出
概率乘数值的总和。

读取状态
无。

写入状态
无。

调用函数
Number。

边界与不变量
非法概率或数值按零处理，不擅自补足缺失概率质量。
*/
export function expectedBranchValue(branches = [], field = "amount") {
  return branches.reduce(
    (sum, branch) => sum + (Number(branch?.probability) || 0) * (Number(branch?.[field]) || 0),
    0
  );
}

/*
功能
构造带稳定条件键的完整二元事件分区。

调用方
Simulator 与领域概率状态构造器。

输入
条件键、事件概率与事件状态字段名。

输出
一至两个概率分支。

读取状态
无。

写入状态
无。

调用函数
clampProbability。

边界与不变量
确定性概率不制造冗余条件，非确定分支概率和为一。
*/
export function probabilityEventPartition(key, probability, stateField = "occurs") {
  const chance = clampProbability(probability);
  if (chance <= PROBABILITY_EPSILON) return [{ probability:1, conditions:{}, [stateField]:false }];
  if (chance >= 1 - PROBABILITY_EPSILON) return [{ probability:1, conditions:{}, [stateField]:true }];
  return [
    { probability:chance, conditions:{ [key]:"yes" }, [stateField]:true },
    { probability:1 - chance, conditions:{ [key]:"no" }, [stateField]:false }
  ];
}

/*
功能
读取卡牌或次数槽仍可用世界的兼容概率视图。

调用方
ActionGenerator、Simulator 与分区工具。

输入
资源对象与缺失字段时的可用概率。

输出
条件唯一的可用概率分支数组。

读取状态
resource.availabilityBranches。

写入状态
无。

调用函数
mergeProbabilityBranches、clampProbability。

边界与不变量
每个资源独占自身可用分支，返回新数组且不修改资源。
*/
export function getAvailabilityBranches(resource, fallbackProbability = 1) {
  if (Array.isArray(resource?.availabilityBranches)) {
    return mergeProbabilityBranches(resource.availabilityBranches);
  }
  const probability = clampProbability(fallbackProbability);
  return probability > PROBABILITY_EPSILON ? [{ probability, conditions:{} }] : [];
}

/*
功能
读取资源包含可用与不可用世界的完整状态分区。

调用方
ActionGenerator、Simulator 与资源状态转换。

输入
资源对象、完整状态字段名与回退概率。

输出
规范化的 available 布尔状态分区。

读取状态
资源完整状态或兼容可用分支。

写入状态
无。

调用函数
mergeProbabilityStateBranches、getAvailabilityBranches、totalBranchProbability。

边界与不变量
兼容视图缺失的概率质量必须显式补成不可用世界。
*/
export function getAvailabilityStateBranches(
  resource,
  stateProperty = "availabilityStateBranches",
  fallbackProbability = 1
) {
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

/*
功能
从完整资源状态分区投影出仍可用世界的兼容视图。

调用方
Simulator 资源消费流程。

输入
包含 available 布尔字段的完整分支数组。

输出
只含概率和条件的合并可用分支。

读取状态
无。

写入状态
无。

调用函数
mergeProbabilityBranches。

边界与不变量
不可用世界必须排除，剩余质量不得重新归一化。
*/
export function availableBranchesFromState(branches = []) {
  return mergeProbabilityBranches(branches
    .filter((branch) => branch.available)
    .map(({ probability, conditions }) => ({ probability, conditions })));
}

/*
功能
创建表示公开条件存在与不存在的完整二元匹配分区。

调用方
Simulator 条件消费流程。

输入
条件键、存在概率以及两侧是否匹配当前动作。

输出
概率为正的二元条件分支。

读取状态
无。

写入状态
无。

调用函数
clampProbability。

边界与不变量
分支总质量为一，极端概率只保留有质量的世界。
*/
export function binaryConditionPartition(key, presentProbability, presentMatches = true, absentMatches = false) {
  const probability = clampProbability(presentProbability);
  return [
    { probability, conditions:{ [key]:"present" }, matches:presentMatches },
    { probability:1 - probability, conditions:{ [key]:"absent" }, matches:absentMatches }
  ].filter((branch) => branch.probability > PROBABILITY_EPSILON);
}

/*
功能
用完整世界条件分区细分资源可用质量为匹配与保留两部分。

调用方
Simulator 条件化资源消费。

输入
资源可用分支与带 matches 字段的完整条件分区。

输出
分别合并的 matching 和 remaining 概率分支。

读取状态
无。

写入状态
无。

调用函数
getAvailabilityBranches、conditionsCompatible、normalizeConditions、mergeProbabilityBranches。

边界与不变量
共享条件只做条件化不重复相乘，匹配与保留质量共同覆盖原可用质量。
*/
export function partitionAvailabilityBranches(availabilityBranches, conditionPartition) {
  const available = getAvailabilityBranches({ availabilityBranches }, 0);
  const worlds = (conditionPartition?.length ? conditionPartition : [
    { probability:1, conditions:{}, matches:true }
  ]).filter((branch) => (Number(branch?.probability) || 0) > PROBABILITY_EPSILON);
  const matching = [];
  const remaining = [];

  for (const availableBranch of available) {
    const compatibleWorlds = worlds.filter((world) => (
      conditionsCompatible(availableBranch.conditions, world.conditions ?? {})
    ));
    const denominator = compatibleWorlds.reduce(
      (sum, world) => sum + (Number(world.probability) || 0),
      0
    );
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
