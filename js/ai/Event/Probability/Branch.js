/*
模块职责
唯一拥有与业务无关的 probability branch 规范化、合并、相交、投影、边际化与质量代数。

上游
Probability public facade。

下游
无。

状态边界
只读局部 branch 数组并返回独立结果；不读取或修改 ProbabilityState、World 或 finite pool。

信息边界
只理解 probability、conditions 与附加 payload，不解释任何业务身份。

架构约束
不得依赖 Pool、业务定义、搜索、模拟或价值模块；局部索引不得写入持久状态。
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
无。

边界与不变量
非数值按零处理。
*/
export function clampProbability(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/*
功能
读取可见或概率卡牌条目的当前可用概率。

调用方
Evaluator、Simulator、Resource、Response 与直接概率测试。

输入
带可选 availability 标量的卡牌摘要。

输出
零到一的可用概率；缺失标量时为一。

读取状态
只读卡牌 availability。

写入状态
无。

调用函数
clampProbability。

边界与不变量
这是唯一 card availability normalization；不读取隐藏实体或构造分支层级。
*/
export function cardAvailability(card) {
  return clampProbability(card?.availability ?? 1);
}

/*
功能
计算两个已确认独立的事件至少发生一次的概率。

调用方
Simulator 的同一被动由两个独立触发来源推进时。

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
Probability facade consumer 的单 action 惰性概率查询。

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
Probability facade consumer、business facade/Value/Search 概率状态消费者与测试。

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
Probability facade consumer 的局部动态事件、资源状态查询与 business facade 的已知实体查询。

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
同键冲突通过倒排索引减少 compatibility predicate work，但每个 base 仍会过滤当前 partition indices，
因此最坏候选扫描保持 O(A×B)；局部索引在查询结束后立即释放。
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
Probability facade consumer、business facade 与局部资源概率查询。

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
Probability facade consumer 的长局部事件查询。

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
Probability facade consumer 概率状态转换与领域评分。

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
计算概率状态分支中指定数值字段的未归一期望。

调用方
Probability facade consumer 与价值计算模块。

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
Probability facade consumer 与领域概率状态构造器。

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
Probability facade consumer、Probability facade consumer 与分区工具。

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
Probability facade consumer、Probability facade consumer 与资源状态转换。

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
Probability facade consumer 资源消费流程。

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
Probability facade consumer 条件消费流程。

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
