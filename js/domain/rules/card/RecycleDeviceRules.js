/*
模块职责
唯一拥有「回收站」装备触发 predicate 的纯规则决定；不拥有 draw、presentation、trigger registration 或 mutation。

上游
application/trigger RecycleDeviceTrigger 与 tests。

下游
CardDefinitions。

状态边界
只读 primitive facts；不写状态。

信息边界
不读取 AI/UI/hidden hand。

架构约束
不得依赖 Game/application/adapters/EventDispatcher；不得 await、emit、随机。
「回收站」固定数值（triggerDrawCount / maxUsesPerTurn）由 CardDefinitions 唯一拥有。
*/
import { CARD_DEFINITIONS } from "../../definitions/cards/CardDefinitions.js?build=20260817-architecture-closure-final";

/*
功能
判断回收站是否可触发。

调用方
Application Trigger。

输入
owner facts、current actor id、card category/usageMode 与 usage count。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
旧触发条件逐项保留：owner 存活且当前行动者、装备为 recycleDevice、战术牌主动使用、次数未达到 CardDefinitions.recycleDevice.maxUsesPerTurn。
*/
export function canTriggerRecycleDevice({
  ownerAlive,
  currentActorId,
  ownerId,
  equipmentDefinitionId,
  cardCategory,
  cardUsageMode,
  useCount = 0
}) {
  return Boolean(
    ownerAlive
    && currentActorId === ownerId
    && equipmentDefinitionId === "recycleDevice"
    && cardCategory === "tactic"
    && cardUsageMode === "active"
    && Number(useCount) < CARD_DEFINITIONS.recycleDevice.maxUsesPerTurn
  );
}
