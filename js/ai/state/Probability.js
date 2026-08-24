/*
模块职责
唯一拥有当前未知信息的有限池状态、匿名物理槽、惰性查询、条件后验与动态事件概率代数。

上游
StateContracts、ActionGenerator、Simulator、领域概率模型、Policy 与 Worker 搜索入口。

下游
Domain Card/Ruleset facts 只由调用方以当前确定计数传入；本模块不复制规则。

状态边界
ProbabilityState 只保存当前匿名槽组与当前有限池充分统计；动态事件函数只读分支并返回局部结果。

信息边界
只消费 Fact 提供的确定计数、匿名槽位与明确观察；不得读取未知实体定义。

架构约束
历史事件、identity genealogy 与 World identity 不得进入 ProbabilityState；相同当前物理统计必须立即合并。
*/

export const PROBABILITY_EPSILON = 1e-12;

export const PROBABILITY_CLASSIFICATION = Object.freeze({
  EXACT:"EXACT",
  CURRENT_STATE_PROBABILITY:"CURRENT STATE PROBABILITY",
  MONTE_CARLO_ESTIMATE:"MONTE CARLO ESTIMATE",
  POLICY_HEURISTIC:"POLICY HEURISTIC",
  EXPECTED_VALUE:"EXPECTED VALUE, NOT PROBABILITY"
});

const PROBABILITY_DEFINITION_IDS = Object.freeze([
  "recover", "block", "counter", "assault"
]);
export const PROBABILITY_DRAW_BUCKET = "outside/drawPool";

const probabilityMemo = new WeakMap();

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
计算两个已确认独立的事件至少发生一次的概率。

调用方
StatusSimulation 的同一被动由两个独立触发来源推进时。

输入
两个零到一的独立事件概率。

输出
至少一个事件发生的零到一概率。

读取状态
无。

写入状态
无。

调用函数
clampProbability。

边界与不变量
相关事件必须用条件分区相交，不能调用本函数；本函数不创建或保存概率世界。
*/
export function independentUnionProbability(left, right) {
  return 1 - (1 - clampProbability(left)) * (1 - clampProbability(right));
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
function normalizeConditions(conditions = {}) {
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
ActionGenerator 的单 action 惰性概率查询。

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
单 action/response 的局部概率查询。

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
为一个当前事件分区建立按 condition/state 键和值索引的冲突表。

调用方
intersectProbabilityStateBranchesWithCheckpoint。

输入
已经规范化的当前事件分区。

输出
分支数组、全部下标以及按字段和值索引的下标集合。

读取状态
无。

写入状态
无。

调用函数
branchState。

边界与不变量
索引只在一次局部查询中存在；不得写入 World 或成为历史 event tree。
*/
function indexCurrentEventPartition(partition) {
  const branches = partition.map((branch) => ({
    probability:branch.probability,
    conditions:branch.conditions ?? {},
    state:branchState(branch)
  }));
  const indices = branches.map((_, index) => index);
  const fields = new Map();
  /*
  功能
  把一个当前分支下标登记到字段值倒排索引。

  调用方
  indexCurrentEventPartition 的 condition/state 遍历。

  输入
  字段名、当前值与分支下标。

  输出
  无。

  读取状态
  闭包 fields。

  写入状态
  更新本次查询局部倒排索引。

  调用函数
  JSON.stringify。

  边界与不变量
  索引生命周期不超过本次事件相交，不得写入持久 ProbabilityState。
  */
  const indexValue = (field, value, branchIndex) => {
    let values = fields.get(field);
    if (!values) {
      values = new Map();
      fields.set(field, values);
    }
    const signature = JSON.stringify(value);
    const entries = values.get(signature) ?? [];
    entries.push(branchIndex);
    values.set(signature, entries);
  };
  branches.forEach((branch, branchIndex) => {
    Object.entries(branch.conditions).forEach(([key, value]) => {
      indexValue(`condition:${key}`, value, branchIndex);
    });
    Object.entries(branch.state).forEach(([key, value]) => {
      indexValue(`state:${key}`, value, branchIndex);
    });
  });
  return { branches, indices, fields };
}

/*
功能
用当前事件键索引相交多个概率分区，并只物化实际兼容结果。

调用方
Simulator 的局部动态事件、资源状态查询与 Domain 的已知实体查询。

输入
当前事件分区数组与可选 cooperative checkpoint。

输出
完整的当前事件交集；中断返回 null。

读取状态
只读本次查询的条件、状态和值索引。

写入状态
无。

调用函数
mergeProbabilityStateBranchesWithCheckpoint、indexCurrentEventPartition。

边界与不变量
同键冲突通过倒排索引直接排除，不执行 A branches × B branches 的 compatibility scan；
独立事件只产生数学上必须返回的输出项，局部索引在查询结束后立即释放。
*/
function intersectProbabilityStateBranchesWithCheckpoint(partitions, checkpoint = null) {
  let intersection = [{ probability:1, conditions:{} }];
  for (const rawPartition of partitions.filter(Array.isArray)) {
    if (checkpoint?.() === false) return null;
    const partition = mergeProbabilityStateBranchesWithCheckpoint(rawPartition, checkpoint);
    if (partition === null) return null;
    if (!partition.length) return [];
    const indexed = indexCurrentEventPartition(partition);
    const next = [];
    for (let baseIndex = 0; baseIndex < intersection.length; baseIndex += 1) {
      if (baseIndex % 32 === 0 && checkpoint?.() === false) return null;
      const base = intersection[baseIndex];
      const baseState = branchState(base);
      const conflicts = new Set();
      /*
      功能
      用倒排字段值索引收集与当前基础分支冲突的候选下标。

      调用方
      intersectProbabilityStateBranchesWithCheckpoint 的单个基础分支。

      输入
      规范字段名与当前基础值。

      输出
      无。

      读取状态
      indexed.fields。

      写入状态
      只更新本次基础分支的 conflicts 集合。

      调用函数
      JSON.stringify。

      边界与不变量
      只枚举实际冲突索引；不得恢复逐候选 compatibility predicate scan。
      */
      const collectConflicts = (field, value) => {
        const values = indexed.fields.get(field);
        if (!values) return;
        const matching = JSON.stringify(value);
        for (const [signature, branchIndices] of values) {
          if (signature === matching) continue;
          branchIndices.forEach((branchIndex) => conflicts.add(branchIndex));
        }
      };
      Object.entries(base.conditions ?? {}).forEach(([key, value]) => {
        collectConflicts(`condition:${key}`, value);
      });
      Object.entries(baseState).forEach(([key, value]) => {
        collectConflicts(`state:${key}`, value);
      });
      const compatibleIndices = indexed.indices.filter((branchIndex) => !conflicts.has(branchIndex));
      const denominator = compatibleIndices.reduce(
        (sum, branchIndex) => sum + indexed.branches[branchIndex].probability,
        0
      );
      if (denominator <= PROBABILITY_EPSILON) continue;
      for (let outputIndex = 0; outputIndex < compatibleIndices.length; outputIndex += 1) {
        if (outputIndex % 32 === 0 && checkpoint?.() === false) return null;
        const candidate = indexed.branches[compatibleIndices[outputIndex]];
        next.push({
          ...baseState,
          ...candidate.state,
          probability:base.probability * candidate.probability / denominator,
          conditions:{ ...(base.conditions ?? {}), ...candidate.conditions }
        });
      }
    }
    intersection = mergeProbabilityStateBranchesWithCheckpoint(next, checkpoint);
    if (intersection === null) return null;
  }
  return intersection;
}

/*
功能
按当前事件键索引相交多个概率状态分区。

调用方
Simulator、Domain 与局部资源概率查询。

输入
零个或多个当前事件分区。

输出
实际兼容的交集分支。

读取状态
无。

写入状态
无。

调用函数
intersectProbabilityStateBranchesWithCheckpoint。

边界与不变量
本函数不保存 event history，也不提供通用 compatibility Cartesian join。
*/
export function intersectProbabilityStateBranches(...partitions) {
  return intersectProbabilityStateBranchesWithCheckpoint(partitions);
}

/*
功能
在同一搜索 checkpoint 下按事件索引相交概率状态。

调用方
Simulator 的长局部事件查询。

输入
当前事件分区数组与 checkpoint。

输出
完整交集；中断时返回 null。

读取状态
无。

写入状态
无。

调用函数
intersectProbabilityStateBranchesWithCheckpoint。

边界与不变量
partial 结果不得返回或进入持久状态。
*/
export function intersectProbabilityStateBranchesCooperatively(
  partitions = [],
  checkpoint = null
) {
  return intersectProbabilityStateBranchesWithCheckpoint(partitions, checkpoint);
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
单 response 的局部概率查询。

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
  return [{
    probability:1,
    conditions:{},
    amount:Number(resource?.[field] ?? fallbackValue) || 0
  }];
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
读取卡牌当前 availability 标量的局部概率视图。

调用方
ActionGenerator、Simulator 与分区工具。

输入
资源对象与缺失字段时的可用概率。

输出
条件唯一的可用概率分支数组。

读取状态
resource.availability 当前值。

写入状态
无。

调用函数
mergeProbabilityBranches、clampProbability。

边界与不变量
返回值只用于当前查询，不写回资源或 ProbabilityState。
*/
export function getAvailabilityBranches(resource, fallbackProbability = 1) {
  const probability = clampProbability(resource?.availability ?? fallbackProbability);
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
资源当前 availability 标量。

写入状态
无。

调用函数
mergeProbabilityStateBranches、getAvailabilityBranches、totalBranchProbability。

边界与不变量
当前可用质量之外的概率必须显式补成不可用世界；结果只存在于调用栈。
*/
export function getAvailabilityStateBranches(
  resource,
  fallbackProbability = 1
) {
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
queryProbability 的无约束快速路径、ResponsePolicy。

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
    if (probability > PROBABILITY_EPSILON) {
      distribution.push({ count:knownOffset + count, probability });
    }
    if (count < maximum) {
      probability *= (successes - count) / (count + 1)
        * (sampleSize - count) / (population - successes - sampleSize + count + 1);
    }
  }
  const total = totalBranchProbability(distribution);
  return distribution.map((branch) => ({
    count:branch.count,
    probability:branch.probability / total
  }));
}

/*
功能
计算有限牌池中至少拥有指定总数目标牌的尾概率。

调用方
ResponsePolicy 与局部概率查询。

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
    ? clampProbability((Number(currentCardCounts[definitionId]) || 0) / total)
    : 0;
}

/*
功能
规范一个匿名槽组，确保身份约束只由当前允许集合决定。

调用方
createProbabilityState、canonicalizeProbabilityFactor、mutation helpers。

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
      .filter((definitionId) => PROBABILITY_DEFINITION_IDS.includes(definitionId))
      .sort((left, right) => left.localeCompare(right))
  };
}

/*
功能
按当前 bucket 与允许身份集合合并匿名物理槽组。

调用方
createProbabilityState、mergeProbabilityFactors、mutation helpers。

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
createProbabilityState、mutateProbability、conditionProbability。

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
    if (probability <= PROBABILITY_EPSILON) continue;
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
  if (total <= PROBABILITY_EPSILON) return [];
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
StateContracts。

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
export function createProbabilityState(fact) {
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
      canonicalSlotGroup(PROBABILITY_DRAW_BUCKET, Math.max(0, populationSize - assigned))
    ]
  };
  return {
    classification:PROBABILITY_CLASSIFICATION.CURRENT_STATE_PROBABILITY,
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
CombatSimulation 的死亡清理与只读资源边界。

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
CardEffectSimulation 的随机手牌选择。

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
queryProbability、observedMutationTransitions、conditionProbability。

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
    distribution:total > PROBABILITY_EPSILON
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
State projection、ResponseSimulation、SealModel 与 Value/Policy 局部查询。

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
      .filter((branch) => branch.probability > PROBABILITY_EPSILON)
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
    probability:clampProbability(probability),
    slotProbability:slots > 0 ? clampProbability(expected / slots) : 0,
    dpStates:baseResult.dpStates
  };
}

/*
功能
查询指定匿名桶下一张物理牌属于一组定义的精确概率。

调用方
Radar、Lightning 与 Seal 的当前判定牌类别查询。

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
  return clampProbability(probability);
}

/*
功能
把“当前桶中确定没有某牌种”的观察写回充分统计后验。

调用方
RootResolutionQuery 与 ValueSimulationQuery 的配对反事实。

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
export function conditionProbability(state, condition = {}) {
  if (condition.maximum !== 0 || !PROBABILITY_DEFINITION_IDS.includes(condition.definitionId)) {
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
    if (probability <= PROBABILITY_EPSILON) continue;
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
  return clampProbability(evidence);
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
mutateProbability。

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
mutateProbability 的响应支付与已观察身份移出。

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
    if (expected > PROBABILITY_EPSILON) candidates.push({ index, expected });
    expectedInSource += expected;
  });
  if (expectedInSource <= PROBABILITY_EPSILON) return [];
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
mutateProbability 的匿名 REMOVE。

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
    if (expected <= PROBABILITY_EPSILON) continue;
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
CardEffectSimulation、ResponseSimulation、CombatSimulation。

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
export function mutateProbability(state, mutation = {}) {
  if (mutation.type === "CONDITION") {
    conditionProbability(state, mutation);
    return state;
  }
  const sourceBucketId = String(mutation.sourceBucketId
    ?? (mutation.type === "ADD" ? PROBABILITY_DRAW_BUCKET : ""));
  const targetBucketId = String(mutation.targetBucketId
    ?? (mutation.type === "REMOVE" ? "observed/removal" : ""));
  if (!sourceBucketId || !targetBucketId || sourceBucketId === targetBucketId) return state;
  const steps = Math.max(1, Math.floor(Number(mutation.count) || 1));
  const occurrence = clampProbability(mutation.probability ?? 1);
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
      if (unchanged > PROBABILITY_EPSILON) {
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

/*
功能
计算当前已知实体资源中可用实体数量的局部分布。

调用方
queryHandProbability、probabilityAnyAvailable。

输入
当前确定属于同一定义的实体资源数组。

输出
只在本次查询存在的 count distribution。

读取状态
各实体当前 availability 标量。

写入状态
无。

调用函数
getAvailabilityStateBranches、intersectProbabilityStateBranches、projectProbabilityStateBranches。

边界与不变量
每个实体最多贡献一；共享动态 event key 通过索引条件化一次，结果不写回持久 ProbabilityState。
*/
function availableResourceCountDistribution(resources = []) {
  let distribution = [{ probability:1, conditions:{}, count:0 }];
  for (const resource of resources) {
    const availability = getAvailabilityStateBranches(resource).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      available:Boolean(branch.available)
    }));
    distribution = projectProbabilityStateBranches(
      intersectProbabilityStateBranches(distribution, availability),
      (branch) => ({ count:branch.count + (branch.available ? 1 : 0) })
    );
  }
  return distribution;
}

/*
功能
查询当前确定身份资源中至少一个仍可用的概率。

调用方
SealModel 的团队已知 Counter 查询。

输入
当前确定身份资源数组。

输出
零到一的局部事件概率。

读取状态
资源 availability 状态。

写入状态
无。

调用函数
availableResourceCountDistribution、totalBranchProbability。

边界与不变量
不构造所有隐藏牌世界；临时分支上界只由当前实体资源数与当前动态条件数决定。
*/
export function probabilityAnyAvailable(resources = []) {
  return clampProbability(totalBranchProbability(
    availableResourceCountDistribution(resources).filter((branch) => branch.count >= 1)
  ));
}

/*
功能
惰性查询一名玩家当前手牌中某定义的完整数量分布。

调用方
Response/Combat/Card Simulation、SearchPrior 与 Value 的真实未知消费点。

输入
ProbabilityState、玩家匿名 bucketId、当前确定身份资源、definitionId 与数量阈值。

输出
count distribution、期望和达到阈值的概率。

读取状态
当前有限池 factor 与确定身份 availability。

写入状态
无。

调用函数
queryProbability、availableResourceCountDistribution、mergeProbabilityStateBranches。

边界与不变量
匿名槽与确定身份是互斥物理集合；临时卷积在查询结束后释放，不写入玩家或 ProbabilityState。
*/
export function queryHandProbability(state, query = {}) {
  const definitionId = query.definitionId;
  const anonymous = queryProbability(state, {
    definitionId,
    bucketId:query.bucketId
  }).distribution;
  const known = availableResourceCountDistribution(
    (query.knownResources ?? []).filter((entry) => entry?.definitionId === definitionId)
  );
  const combined = [];
  const outputCount = anonymous.length * known.length;
  for (let index = 0; index < outputCount; index += 1) {
    const anonymousBranch = anonymous[Math.floor(index / known.length)];
    const knownBranch = known[index % known.length];
    combined.push({
      count:anonymousBranch.count + knownBranch.count,
      probability:anonymousBranch.probability * knownBranch.probability,
      conditions:knownBranch.conditions ?? {}
    });
  }
  const distribution = mergeProbabilityStateBranches(combined)
    .sort((left, right) => left.count - right.count);
  const minimum = Math.max(0, Math.floor(Number(query.minimum) || 1));
  return {
    distribution,
    expected:distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability,
      0
    ),
    probability:clampProbability(totalBranchProbability(
      distribution.filter((branch) => branch.count >= minimum)
    ))
  };
}

/*
功能
从 canonical World 玩家和唯一 ProbabilityState 惰性查询当前手牌定义数量。

调用方
Simulation、SearchPrior、Policy 与 Value 的响应/资源消费点。

输入
ProbabilityState、World 玩家、definitionId 与最小数量。

输出
当前局部 count distribution、期望数量与达到阈值的概率。

读取状态
玩家自己的 hand 或合法 knownCards，以及 ProbabilityState 匿名桶。

写入状态
无。

调用函数
queryHandProbability。

边界与不变量
查询结果只在调用栈内存在，不得写回 World 或 ProbabilityState。
*/
export function queryPlayerHandProbability(state, player, definitionId, minimum = 1) {
  return queryHandProbability(state, {
    bucketId:player?.id,
    knownResources:[
      ...(Array.isArray(player?.hand) ? player.hand : []),
      ...(Array.isArray(player?.knownCards) ? player.knownCards : [])
    ],
    definitionId,
    minimum
  });
}

/*
功能
按给定响应顺序直接计算首个拥有目标资源的响应者概率。

调用方
ResponseSimulation 的 card-scope Counter 链。

输入
ProbabilityState、definitionId，以及按顺序提供的 bucketId/knownResources 响应者。

输出
每个响应者成为首名可用者的概率和无人可用概率。

读取状态
同一 finite-pool factor 与当前确定身份 availability。

写入状态
无。

调用函数
queryProbability、probabilityAnyAvailable。

边界与不变量
使用 `P(previous none) - P(previous+current none)`，不连接逐玩家边际；
同一有限池实例不可能同时成为两名响应者的牌，结果互斥且总质量为一。
*/
export function queryOrderedFirstResponder(
  state,
  definitionId,
  responders = []
) {
  const probabilities = [];
  const prefixBuckets = [];
  const prefixKnown = [];
  let previousNone = 1;
  for (const responder of responders) {
    prefixBuckets.push(responder.bucketId);
    prefixKnown.push(...(responder.knownResources ?? []));
    const anonymousAny = queryProbability(state, {
      definitionId,
      groupBucketIds:prefixBuckets
    }).probability;
    const knownAny = probabilityAnyAvailable(prefixKnown);
    const currentNone = (1 - anonymousAny) * (1 - knownAny);
    probabilities.push({
      responderId:responder.responderId,
      probability:clampProbability(previousNone - currentNone)
    });
    previousNone = currentNone;
  }
  return {
    responders:probabilities,
    none:clampProbability(previousNone)
  };
}

/*
功能
从根 ProbabilityState 采样有限个 Monte Carlo 隐藏手牌估计。

调用方
CounterfactualTerms 的根搜索上下文。

输入
观察者 ID、当前 ProbabilityState、过滤玩家、样本数与 Search RNG。

输出
显式 MONTE_CARLO_ESTIMATE 契约。

读取状态
单一未条件化根 factor 与玩家确定 knownCards。

写入状态
只写各样本私有计数副本。

调用函数
random。

边界与不变量
采样不是 exact Probability；每个槽消费一个实例且世界间不共享计数，条件化搜索状态不得进入该根采样入口。
*/
export function sampleProbabilityWorlds({
  viewerId,
  probabilityState,
  players,
  sampleCount,
  random
}) {
  const factors = probabilityState?.factors ?? [];
  if (factors.length !== 1 || factors[0].slotGroups.some(
    (group) => group.excludedDefinitions.length > 0
  )) {
    throw new Error("隐藏世界采样只接受未条件化的当前根 ProbabilityState");
  }
  const factor = factors[0];
  const count = Math.max(0, Math.floor(Number(sampleCount) || 0));
  const worlds = Array.from({ length:count }, () => {
    const remaining = { ...factor.cardCounts };
    /*
    功能
    从单个 Monte Carlo 样本的当前剩余实例中抽取并消费一个定义。

    调用方
    sampleProbabilityWorlds 的匿名槽填充。

    输入
    无；使用闭包 remaining 与 random。

    输出
    抽中的 definitionId。

    读取状态
    当前样本 remaining 与注入 Search RNG。

    写入状态
    当前样本对应定义计数减一。

    调用函数
    random。

    边界与不变量
    每个匿名槽消费一个实例；不同样本不共享 remaining。
    */
    const drawDefinition = () => {
      const entries = Object.entries(remaining).filter(([, value]) => value > 0);
      const total = entries.reduce((sum, [, value]) => sum + value, 0);
      if (total <= 0) throw new Error("隐藏世界抽样槽位超过当前有限牌池");
      let roll = random() * total;
      for (const [definitionId, value] of entries) {
        if (roll < value) {
          remaining[definitionId] -= 1;
          return definitionId;
        }
        roll -= value;
      }
      const definitionId = entries.at(-1)[0];
      remaining[definitionId] -= 1;
      return definitionId;
    };
    return Object.fromEntries((players ?? [])
      .filter((player) => player.id !== viewerId)
      .map((player) => {
        const known = (player.knownCards ?? [])
          .filter((entry) => totalBranchProbability(getAvailabilityBranches(entry)) >= 1 - PROBABILITY_EPSILON)
          .map((entry) => entry.definitionId);
        const anonymousSlots = factor.slotGroups
          .filter((group) => group.bucketId === player.id)
          .reduce((sum, group) => sum + group.count, 0);
        return [
          player.id,
          [...known, ...Array.from({ length:anonymousSlots }, drawDefinition)]
        ];
      }));
  });
  return Object.freeze({
    classification:PROBABILITY_CLASSIFICATION.MONTE_CARLO_ESTIMATE,
    sampleCount:count,
    worlds:Object.freeze(worlds)
  });
}
