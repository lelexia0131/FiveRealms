/*
模块职责
定义搜索、Worker 与真实执行共同消费的唯一 Action 数据契约及其稳定身份。

上游
Generator、Searcher、Pattern、Controller、Worker search runtime 与 TurnWorkflow。

下游
无。

状态边界
只读传入的普通值并创建不可变 Action；不读取或修改 World/GameState。

信息边界
只保存 Generator 已确认的 actor、卡牌/技能、目标与选择，不查询隐藏信息。

架构约束
不得创建 descriptor/search/simulation action 变体；生产模块必须直接传递和消费同一个 Action。
*/

const ACTION_TYPES = new Set(["card", "skill", "end"]);

/*
功能
递归复制并冻结 Action 中允许的普通数据。

调用方
createAction。

输入
selection、conditions 或其他仅含普通值的数据。

输出
与输入隔离的冻结普通值。

读取状态
无。

写入状态
无。

调用函数
自身递归调用。

边界与不变量
不得接受函数、Map、Set 或类实例；数组顺序属于动作语义，不能重排。
*/
function freezeData(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeData));
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Action 只接受普通 data");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, freezeData(child)])
  ));
}

/*
功能
创建所有生产模块共同消费的 canonical Action。

调用方
Generator 与安全终止路径。

输入
动作类型、actor ID、卡牌/技能身份、完整目标 ID、selection 与能量费用。

输出
冻结且 structured-clone-safe 的 Action。

读取状态
无。

写入状态
无。

调用函数
freezeData。

边界与不变量
card 需要 definition 与 instance identity；skill 需要 skillId；end 不携带目标或选择；
Generator 创建后任何消费者都不得补 target、selection、合法性或另一种 Action shape。
*/
export function createAction({
  type,
  actorId,
  cardId = null,
  cardInstanceId = null,
  skillId = null,
  targetIds = [],
  selection = null,
  energyCost = null
}) {
  if (!ACTION_TYPES.has(type)) throw new TypeError(`未知 Action type：${type}`);
  if (typeof actorId !== "string" || !actorId) throw new TypeError("Action 缺少 actorId");
  if (type === "card" && (typeof cardId !== "string" || !cardId)) {
    throw new TypeError("card Action 缺少 cardId");
  }
  if (type === "skill" && (typeof skillId !== "string" || !skillId)) {
    throw new TypeError("skill Action 缺少 skillId");
  }
  const actionTargetIds = type === "end" ? [] : [...targetIds];
  return Object.freeze({
    type,
    actorId,
    cardId:type === "card" ? cardId : null,
    cardInstanceId:type === "card" ? cardInstanceId : null,
    skillId:type === "skill" ? skillId : null,
    targetIds:Object.freeze(actionTargetIds),
    selection:type === "end" ? null : freezeData(selection),
    energyCost:type === "skill" && Number.isFinite(Number(energyCost))
      ? Number(energyCost)
      : null
  });
}

/*
功能
为 Action 或 Pattern step 生成不含实体 instance 的稳定意图键。

调用方
Pattern 与普通搜索调度。

输入
canonical Action 或静态 Pattern step。

输出
稳定 JSON 字符串。

读取状态
输入的 type、definition/skill、targetIds 与 selection。

写入状态
无。

调用函数
JSON.stringify。

边界与不变量
Pattern 只比较意图；不得把实体手牌顺序混入意图身份。
*/
export function actionIntentKey(action) {
  const type = action?.type ?? null;
  const cardId = type === "skill"
    ? action?.skillId ?? action?.cardId ?? null
    : action?.cardId ?? null;
  const targetIds = Array.isArray(action?.targetIds) ? action.targetIds : [];
  return JSON.stringify({
    type,
    cardId,
    targetIds,
    selection:action?.selection ?? null
  });
}

/*
功能
为搜索去重生成忽略 card instance、保留完整意图语义的稳定键。

调用方
Generator 与 Searcher 的 secondary scheduling。

输入
canonical Action。

输出
稳定 JSON 字符串。

读取状态
Action 全部搜索语义。

写入状态
无。

调用函数
JSON.stringify。

边界与不变量
相同定义的物理卡实例可共享搜索代表；目标、selection 与费用不得丢失。
*/
export function actionSearchKey(action) {
  return JSON.stringify({
    type:action.type,
    actorId:action.actorId,
    cardId:action.cardId,
    skillId:action.skillId,
    targetIds:action.targetIds,
    selection:action.selection,
    energyCost:action.energyCost
  });
}

/*
功能
判断两个 Action 是否具有完全相同的可执行身份。

调用方
Controller request acceptance。

输入
两个 canonical Action。

输出
完全一致返回 true。

读取状态
Action 普通数据。

写入状态
无。

调用函数
JSON.stringify。

边界与不变量
比较包含 card instance；不得进行部分 selection 匹配或重新生成合法动作。
*/
export function sameAction(left, right) {
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}
