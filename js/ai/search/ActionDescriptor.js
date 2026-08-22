/*
模块职责
把搜索动作投影为不含运行时实体引用的稳定动作描述。

上游
Planner、AIController 重绑边界与搜索测试。

下游
无。

状态边界
只读传入动作，不读取或修改 Game/SearchState。

信息边界
只投影动作已经携带的公开标识与选择字段，不查询隐藏信息。

架构约束
不得执行合法性检查、访问 Game 或按领域规则重新解释动作。
*/

/*
功能
递归规范动作描述中的数组和普通对象属性顺序。

调用方
schedulingKey。

输入
动作描述中的普通 data 值。

输出
属性顺序稳定且不共享可变容器的新值。

读取状态
无。

写入状态
无。

调用函数
自身递归调用。

边界与不变量
不得删除 selection 语义或重排数组；只规范普通对象键顺序。
*/
function normalizeDescriptorValue(value) {
  if (Array.isArray(value)) return value.map(normalizeDescriptorValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalizeDescriptorValue(value[key])])
  );
}

/*
功能
把动作中的实体引用转换为稳定的搜索描述。

调用方
Planner 计划序列、诊断账本与 AIController 当前实体重绑。

输入
搜索候选动作。

输出
只含动作类型、定义/实例标识、目标标识和稳定选择字段的对象。

读取状态
只读 action。

写入状态
无。

调用函数
无。

边界与不变量
带 source/receiver/zone 的资源转移选择只保留重绑所需字段；其余选择保持现有浅复制语义。
*/
export function describeAction(action) {
  const transferSelection = action.selection
    && "sourceId" in action.selection
    && "receiverId" in action.selection
    && "zone" in action.selection;
  const selection = action.selection
    ? transferSelection
      ? {
          sourceId:action.selection.sourceId,
          receiverId:action.selection.receiverId,
          zone:action.selection.zone
        }
      : { ...action.selection }
    : null;
  return {
    type: action.type,
    cardId: action.card?.definitionId ?? action.skill?.id ?? null,
    cardInstanceId: action.card?.id ?? null,
    targetId: action.targets?.[0]?.id ?? null,
    targetIds: (action.targets ?? []).map((target) => target.id),
    selection
  };
}

/*
功能
为 root scheduling 生成不依赖实体手牌排列的稳定搜索语义键。

调用方
CandidateMaterializer.rootSchedulingKey。

输入
搜索候选动作。

输出
由 type、definition/skill、目标顺序与 selection 构成的稳定字符串。

读取状态
只读 action 已携带的公开搜索语义。

写入状态
无。

调用函数
describeAction、normalizeDescriptorValue、JSON.stringify。

边界与不变量
不得包含 card instance ID 或 hand index；目标数组顺序和 selection 必须保留。
*/
export function schedulingKey(action) {
  const descriptor = describeAction(action);
  return JSON.stringify(normalizeDescriptorValue({
    type:descriptor.type,
    cardId:descriptor.cardId,
    targetIds:descriptor.targetIds,
    selection:descriptor.selection
  }));
}

export const ActionDescriptor = Object.freeze({
  describe:describeAction,
  schedulingKey
});
