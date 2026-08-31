/*
模块职责
为真实 Action execution 提供原位 checkpoint/commit/rollback；统一恢复 MatchState、实体对象、牌区容器与各 workflow owner 的私有运行状态。

上游
Application ActionWorkflow 与 composition root。

下游
显式 transaction participants 与 RandomPort transaction capability。

状态边界
只快照调用方明确传入的可变对象图；日志只记录追加边界；rollback 原位恢复既有对象和容器身份，不创建第二份 authoritative state。

信息边界
不读取 AI World、UI、隐藏牌策略或领域定义；只保存当前真实对象引用和值。

架构约束
不得解释 HP、energy、status、牌区或技能字段；新增可变字段必须自动随对象图或其 owner checkpoint 恢复。
*/

// 该类型保留 AggregateError.errors，同时让上层无需解析错误文案即可禁止继续 fallback。
export class ActionRollbackError extends AggregateError {}

/*
功能
捕获一组真实可变根对象的通用原位恢复记录。

调用方
createActionTransaction。

输入
roots 是 MatchState、Action runtime 等明确属于本次真实 Action 的可变根对象；excludedLog 是不得递归进入的 append-only 日志数组。

输出
按对象身份记录的数组、Map、Set 与普通对象快照。

读取状态
roots 可达且未被排除的全部非冻结 own enumerable data。

写入状态
无。

调用函数
Object.keys、Object.isFrozen、Map、Set。

边界与不变量
快照保留原对象引用并处理循环；冻结对象与 excludedLog 视为不可变叶子，函数与 primitive 按值保留。
*/
function captureMutableGraph(roots, excludedLog = null) {
  const records = [];
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)
      || value === excludedLog || Object.isFrozen(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      const items = [...value];
      records.push({ kind:"array", target:value, items });
      pending.push(...items);
      continue;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()];
      records.push({ kind:"map", target:value, entries });
      for (const [key, entry] of entries) pending.push(key, entry);
      continue;
    }
    if (value instanceof Set) {
      const items = [...value];
      records.push({ kind:"set", target:value, items });
      pending.push(...items);
      continue;
    }
    const entries = Object.keys(value).map((key) => [key, value[key]]);
    records.push({ kind:"object", target:value, entries });
    for (const [, entry] of entries) pending.push(entry);
  }
  return records;
}

/*
功能
把通用对象图记录原位恢复到 checkpoint 时的值和引用关系。

调用方
Action transaction rollback。

输入
captureMutableGraph 返回的 records。

输出
无。

读取状态
每条记录中的原对象引用、键、值与容器顺序。

写入状态
原位恢复数组、Map、Set 与普通对象 own enumerable data。

调用函数
Array、Map、Set 与 Reflect mutation primitives。

边界与不变量
不替换根、Player、Deck、Card 或既有容器身份；Action 期间新增的 own enumerable 字段会被删除。
*/
function restoreMutableGraph(records) {
  for (const record of records) {
    if (record.kind === "array") {
      record.target.length = 0;
      for (const item of record.items) record.target.push(item);
      continue;
    }
    if (record.kind === "map") {
      record.target.clear();
      for (const [key, value] of record.entries) record.target.set(key, value);
      continue;
    }
    if (record.kind === "set") {
      record.target.clear();
      for (const item of record.items) record.target.add(item);
      continue;
    }
    const originalKeys = new Set(record.entries.map(([key]) => key));
    for (const key of Object.keys(record.target)) {
      if (!originalKeys.has(key) && !Reflect.deleteProperty(record.target, key)) {
        throw new TypeError(`Action rollback 无法删除字段 ${key}`);
      }
    }
    for (const [key, value] of record.entries) {
      if (!Reflect.set(record.target, key, value)) {
        throw new TypeError(`Action rollback 无法恢复字段 ${key}`);
      }
    }
  }
}

/*
功能
创建一次由 ActionWorkflow 拥有的真实 Action transaction。

调用方
ActionWorkflow.playCard、ActionWorkflow.useActiveSkill。

输入
可变 roots、append-only logs、拥有私有运行状态的 participants 与可回放 RandomPort。

输出
冻结的 { commit, rollback } transaction handle。

读取状态
roots 对象图、logs 当前长度、participant checkpoint 与 RandomPort 当前逻辑位置。

写入状态
commit 只关闭 checkpoint；rollback 原位恢复全部 roots/participants、把 logs 截回 Action 开始边界并回放本次随机读取。

调用函数
captureMutableGraph、restoreMutableGraph、participant checkpoint API、RandomPort transaction API。

边界与不变量
transaction 必须严格嵌套且至多结束一次；logs 在 Action 内只能追加，历史条目不进入深度 checkpoint；
失败不按领域字段逐项恢复，成功不改变既有结算顺序。
*/
export function createActionTransaction({ roots, logs, participants = [], randomPort }) {
  if (!Array.isArray(roots) || !roots.length) throw new TypeError("ActionTransaction 需要可变 roots");
  if (!Array.isArray(logs)) throw new TypeError("ActionTransaction 需要 logs 数组");
  if (!randomPort?.beginTransaction || !randomPort?.commitTransaction || !randomPort?.rollbackTransaction) {
    throw new TypeError("ActionTransaction 需要 transactional RandomPort");
  }
  const logBoundary = { target:logs, length:logs.length };
  const graphRecords = captureMutableGraph(roots, logBoundary.target);
  const participantRecords = [];
  for (const participant of participants) {
    if (!participant?.captureActionCheckpoint || !participant?.restoreActionCheckpoint) {
      throw new TypeError("ActionTransaction participant 缺少 checkpoint API");
    }
    participantRecords.push({ participant, snapshot:participant.captureActionCheckpoint() });
  }
  const randomToken = randomPort.beginTransaction();
  let active = true;

  /*
  功能
  提交当前 Action transaction。

  调用方
  ActionWorkflow 在真实 Action 全部步骤成功后。

  输入
  无。

  输出
  首次提交返回 true；已结束返回 false。

  读取状态
  transaction active 与 RandomPort transaction stack。

  写入状态
  关闭 RandomPort frame 与当前 transaction。

  调用函数
  randomPort.commitTransaction。

  边界与不变量
  只允许严格后进先出提交；不再次写 GameState。
  */
  function commit() {
    if (!active) return false;
    randomPort.commitTransaction(randomToken);
    active = false;
    return true;
  }

  /*
  功能
  回滚当前 Action transaction。

  调用方
  ActionWorkflow 的 false、session cancellation 与异常路径。

  输入
  无。

  输出
  首次回滚返回 true；已结束返回 false。

  读取状态
  graph/log/participant checkpoints 与 RandomPort frame。

  写入状态
  原位恢复真实对象图、日志追加边界、各 owner 私有状态和随机逻辑位置。

  调用函数
  restoreMutableGraph、participant.restoreActionCheckpoint、randomPort.rollbackTransaction。

  边界与不变量
  所有 owner 都会被尝试恢复；日志只删除本次 Action 追加的尾部，历史条目及顺序保持原样；
  任一恢复失败时以 AggregateError 明确暴露，不能静默留下半回滚状态。
  */
  function rollback() {
    if (!active) return false;
    const errors = [];
    try { restoreMutableGraph(graphRecords); } catch (error) { errors.push(error); }
    for (const { participant, snapshot } of participantRecords) {
      try { participant.restoreActionCheckpoint(snapshot); } catch (error) { errors.push(error); }
    }
    try { logBoundary.target.length = logBoundary.length; } catch (error) { errors.push(error); }
    try { randomPort.rollbackTransaction(randomToken); } catch (error) { errors.push(error); }
    active = false;
    if (errors.length) throw new ActionRollbackError(errors, "真实 Action rollback 未完整恢复");
    return true;
  }

  return Object.freeze({ commit, rollback });
}
