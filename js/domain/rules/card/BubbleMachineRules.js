/*
模块职责
唯一拥有「泡泡机」回合开始触发 predicate 的纯规则决定；不拥有护盾写入、事件发布、日志或监听注册。

上游
application/trigger BubbleMachineTrigger 与 tests。

下游
无。

状态边界
只读 primitive facts；不写状态。

信息边界
不读取 AI、UI 或隐藏手牌。

架构约束
不得依赖 Game、application、adapters 或 EventDispatcher；不得创建第二套回合生命周期。
*/

/*
功能
判断泡泡机是否应在装备者自己的回合开始触发。

调用方
Application BubbleMachineTrigger。

输入
回合开始角色的存活、装备定义与当前护盾事实。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只允许存活、实际装备 bubbleMachine 且护盾严格为零的角色触发。
*/
export function canTriggerBubbleMachine({
  ownerAlive,
  equipmentDefinitionId,
  currentShield
}) {
  return Boolean(
    ownerAlive
    && equipmentDefinitionId === "bubbleMachine"
    && Number(currentShield) === 0
  );
}
