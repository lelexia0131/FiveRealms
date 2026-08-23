/*
模块职责
提供 SearchState 概率分支的规范化、联合、投影与资源可用性纯函数。

上游
ActionGenerator、Simulator、领域评分模块、概率正式组合入口与状态契约测试。

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

export const PROBABILITY_CLASSIFICATION = Object.freeze({
  EXACT:"EXACT",
  BELIEF_PROBABILITY:"BELIEF PROBABILITY",
  MONTE_CARLO_ESTIMATE:"MONTE CARLO ESTIMATE",
  POLICY_HEURISTIC:"POLICY HEURISTIC",
  EXPECTED_VALUE:"EXPECTED VALUE, NOT PROBABILITY"
});

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
无。

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
localeCompare。

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
mergeProbabilityBranchesWithCheckpoint。

输入
已经规范化的条件键值对象。

输出
稳定 JSON 字符串。

读取状态
无。

写入状态
无。

调用函数
JSON.stringify。

边界与不变量
调用方必须先完成本次 operation 的唯一一次条件规范化；本函数不得重复排序。
*/
function conditionSignature(conditions) {
  return JSON.stringify(conditions);
}

/*
功能
判断两个世界条件是否不存在同键冲突。

调用方
joinProbabilityStateBranches。

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
localeCompare。

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
为已经规范化的条件和资源状态生成稳定签名。

调用方
mergeProbabilityStateBranchesWithCheckpoint。

输入
规范化条件与已排序状态字段。

输出
稳定 JSON 字符串。

读取状态
无。

写入状态
无。

调用函数
JSON.stringify。

边界与不变量
调用方必须传入本次 operation 已经规范化的局部结果，避免为签名重复解析分支；
只有条件和所有状态字段均相同的分支才共享签名。
*/
function stateSignatureFromNormalizedParts(conditions, state) {
  return JSON.stringify({
    conditions,
    state
  });
}

/*
功能
为一次状态 join 局部提取已合并分支的条件、状态与兼容比较条目。

调用方
joinProbabilityStateBranchesWithCheckpoint。

输入
已经过当前 partition merge、字段顺序稳定的概率状态分支。

输出
只在本次 join operation 内使用的预计算普通对象。

读取状态
无。

写入状态
无。

调用函数
Object.entries。

边界与不变量
不得修改或跨 operation 缓存输入分支；merge 已完成的排序不得在 join 内重复执行。
*/
function prepareProbabilityStateBranch(branch) {
  const { probability, conditions, ...state } = branch;
  return {
    probability,
    conditions,
    conditionEntries:Object.entries(conditions),
    state,
    stateEntries:Object.entries(state)
  };
}

/*
功能
判断两个完整状态分支能否处于同一搜索世界。

调用方
joinProbabilityStateBranches。

输入
已局部预计算的基础分支与候选分支。

输出
条件和同名状态字段均兼容时返回 true。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
同名条件或状态字段取值冲突必须拒绝联合；不得在 base × candidate 比较中重新枚举字段。
*/
function stateBranchesCompatible(base, candidate) {
  if (!base.conditionEntries.every(([key, value]) => (
    candidate.conditions[key] === undefined || candidate.conditions[key] === value
  ))) return false;
  return base.stateEntries.every(([key, value]) => (
    candidate.state[key] === undefined || Object.is(candidate.state[key], value)
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
function mergeProbabilityBranchesWithCheckpoint(branches = [], checkpoint = null) {
  const merged = new Map();
  for (let index = 0; index < branches.length; index += 1) {
    if (index % 32 === 0 && checkpoint?.() === false) return null;
    const branch = branches[index];
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
mergeProbabilityBranchesWithCheckpoint。

边界与不变量
普通调用不启用 cooperative interruption，保持既有合并顺序和概率语义。
*/
export function mergeProbabilityBranches(branches = []) {
  return mergeProbabilityBranchesWithCheckpoint(branches);
}

/*
功能
在 cooperative checkpoint 保护下合并纯条件概率分支。

调用方
ActionGenerator 的单 action probability preparation。

输入
概率分支数组与返回 false 表示中断的 checkpoint。

输出
完整合并结果；checkpoint 返回 false 时返回 null，绝不返回部分结果。

读取状态
无。

写入状态
无。

调用函数
mergeProbabilityBranchesWithCheckpoint、checkpoint。

边界与不变量
每 32 个输入世界检查一次；正常路径与 mergeProbabilityBranches 完全等价。
*/
export function mergeProbabilityBranchesCooperatively(branches = [], checkpoint = null) {
  return mergeProbabilityBranchesWithCheckpoint(branches, checkpoint);
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
无。

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
branchState、normalizeConditions、stateSignatureFromNormalizedParts。

边界与不变量
状态不同的世界不得因条件相同而合并。
*/
function mergeProbabilityStateBranchesWithCheckpoint(branches = [], checkpoint = null) {
  const merged = new Map();
  for (let index = 0; index < branches.length; index += 1) {
    if (index % 32 === 0 && checkpoint?.() === false) return null;
    const rawBranch = branches[index];
    const probability = Math.max(0, Number(rawBranch?.probability) || 0);
    if (probability <= PROBABILITY_EPSILON) continue;
    const state = branchState(rawBranch);
    const conditions = normalizeConditions(rawBranch?.conditions);
    const branch = {
      ...state,
      probability,
      conditions
    };
    const signature = stateSignatureFromNormalizedParts(conditions, state);
    const current = merged.get(signature);
    if (current) current.probability += probability;
    else merged.set(signature, branch);
  }
  return [...merged.values()].filter((branch) => branch.probability > PROBABILITY_EPSILON);
}

/*
功能
合并条件与状态完全相同的概率质量。

调用方
Simulator、Domain/Value/Search 概率状态消费者与测试。

输入
包含 probability、conditions 和普通状态字段的分支数组。

输出
完整签名唯一且概率为正的新分支数组。

读取状态
无。

写入状态
无。

调用函数
mergeProbabilityStateBranchesWithCheckpoint。

边界与不变量
普通调用不启用 cooperative interruption，保持既有同步概率代数。
*/
export function mergeProbabilityStateBranches(branches = []) {
  return mergeProbabilityStateBranchesWithCheckpoint(branches);
}

/*
功能
在 cooperative checkpoint 保护下合并完整概率状态分支。

调用方
已证实会形成长同步尾巴的 Search Action/Response probability preparation。

输入
概率状态分支数组与返回 false 表示中断的 checkpoint。

输出
完整合并结果；checkpoint 返回 false 时返回 null，绝不返回部分结果。

读取状态
无。

写入状态
无。

调用函数
mergeProbabilityStateBranchesWithCheckpoint、checkpoint。

边界与不变量
每 32 个输入世界检查一次；正常路径与 mergeProbabilityStateBranches 的顺序、签名和概率代数完全相同。
*/
export function mergeProbabilityStateBranchesCooperatively(branches = [], checkpoint = null) {
  return mergeProbabilityStateBranchesWithCheckpoint(branches, checkpoint);
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
mergeProbabilityStateBranches、prepareProbabilityStateBranch、stateBranchesCompatible、normalizeConditions。

边界与不变量
共享条件只条件化一次，独立条件才相乘，同名状态冲突必须排除。
*/
function joinProbabilityStateBranchesWithCheckpoint(partitions, checkpoint = null) {
  let joined = [{ probability:1, conditions:{} }];
  for (const rawPartition of partitions.filter(Array.isArray)) {
    if (checkpoint?.() === false) return null;
    const partition = mergeProbabilityStateBranchesWithCheckpoint(rawPartition, checkpoint);
    if (partition === null) return null;
    if (!partition.length) return [];
    const preparedJoined = joined.map(prepareProbabilityStateBranch);
    const preparedPartition = partition.map(prepareProbabilityStateBranch);
    const next = [];
    for (let baseIndex = 0; baseIndex < preparedJoined.length; baseIndex += 1) {
      if (baseIndex % 32 === 0 && checkpoint?.() === false) return null;
      const base = preparedJoined[baseIndex];
      const compatibleBranches = [];
      let denominator = 0;
      for (let partitionIndex = 0; partitionIndex < preparedPartition.length; partitionIndex += 1) {
        if (partitionIndex % 32 === 0 && checkpoint?.() === false) return null;
        const candidate = preparedPartition[partitionIndex];
        if (!stateBranchesCompatible(base, candidate)) continue;
        compatibleBranches.push(candidate);
        denominator += Math.max(0, Number(candidate.probability) || 0);
      }
      if (denominator <= PROBABILITY_EPSILON) continue;
      for (let candidateIndex = 0; candidateIndex < compatibleBranches.length; candidateIndex += 1) {
        if (candidateIndex % 32 === 0 && checkpoint?.() === false) return null;
        const candidate = compatibleBranches[candidateIndex];
        next.push({
          ...base.state,
          ...candidate.state,
          probability:base.probability * candidate.probability / denominator,
          conditions:{ ...base.conditions, ...candidate.conditions }
        });
      }
    }
    joined = mergeProbabilityStateBranchesWithCheckpoint(next, checkpoint);
    if (joined === null) return null;
  }
  return joined;
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
joinProbabilityStateBranchesWithCheckpoint。

边界与不变量
普通调用不启用 cooperative interruption，保持既有同步概率代数与输出顺序。
*/
export function joinProbabilityStateBranches(...partitions) {
  return joinProbabilityStateBranchesWithCheckpoint(partitions);
}

/*
功能
在 cooperative checkpoint 保护下联合多个完整概率分区。

调用方
已证实会形成长同步尾巴的 Search Action/Response probability preparation。

输入
概率分区数组与返回 false 表示中断的 checkpoint。

输出
完整联合世界；checkpoint 返回 false 时返回 null，绝不返回部分世界。

读取状态
无。

写入状态
无。

调用函数
joinProbabilityStateBranchesWithCheckpoint、checkpoint。

边界与不变量
共享条件代数、兼容过滤和输出顺序与普通 join 完全一致；中断只丢弃当前未完成联合。
*/
export function joinProbabilityStateBranchesCooperatively(partitions = [], checkpoint = null) {
  return joinProbabilityStateBranchesWithCheckpoint(partitions, checkpoint);
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
在 cooperative checkpoint 保护下投影并合并概率世界。

调用方
已证实会形成长同步尾巴的 Search Response probability preparation。

输入
完整世界、纯 projector 与返回 false 表示中断的 checkpoint。

输出
完整投影分区；checkpoint 返回 false 时返回 null，绝不返回部分投影。

读取状态
无。

写入状态
无。

调用函数
projector、mergeProbabilityStateBranchesWithCheckpoint、checkpoint。

边界与不变量
每 32 个世界检查一次；正常路径保持原投影顺序、概率与条件签名。
*/
export function projectProbabilityStateBranchesCooperatively(
  worldBranches,
  projector,
  checkpoint = null
) {
  const projected = [];
  const worlds = worldBranches ?? [];
  for (let index = 0; index < worlds.length; index += 1) {
    if (index % 32 === 0 && checkpoint?.() === false) return null;
    const world = worlds[index];
    projected.push({
      ...projector(world),
      probability:world.probability,
      conditions:world.conditions
    });
  }
  return mergeProbabilityStateBranchesWithCheckpoint(projected, checkpoint);
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
mergeProbabilityStateBranches。

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
无。

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
