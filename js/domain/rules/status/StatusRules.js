/*
模块职责
唯一拥有状态存在性与闪电下一持有者的纯规则语义；不拥有生命周期 workflow、伤害、判定或响应。

上游
RuleEngine、Game status workflow 与 tests。

下游
STATUS_DEFINITIONS。

状态边界
只读玩家投影的 statusIds/seatIndex/alive；不写状态。

信息边界
不读取 AI probability、SearchState 或隐藏信息。

架构约束
不得依赖 application/adapters/AI/UI/Game runtime；不得随机、await、emit。
*/
import { STATUS_DEFINITIONS } from "../../definitions/statuses/StatusDefinitions.js?build=20260816-legacy-recovery";
import { assertCanonicalSeatRoster } from "../../state/queries/SeatRosterContract.js?build=20260816-legacy-recovery";

/*
功能
判断玩家投影是否拥有指定状态。

调用方
RuleEngine 与 tests。

输入
Rule Player 投影与 statusId。

输出
布尔值。

读取状态
player.statusIds。

写入状态
无。

调用函数
Array.includes。

边界与不变量
identity 来自 STATUS_DEFINITIONS 语义但不强制 catalog 完整性。
*/
export function hasStatus(player, statusId) {
  return Boolean(statusId && player?.statusIds?.includes(statusId));
}

/*
功能
读取「破势」状态详情中的层数。

调用方
cardRegistry assault resolver 与 tests。

输入
exposeWeakness 状态详情或 null。

输出
非负整数层数。

读取状态
状态详情。

写入状态
无。

调用函数
无。

边界与不变量
缺失按 0；层数可叠加。
*/
export function getExposeWeaknessStacks(statusDetail) {
  return Math.max(0, Number(statusDetail?.stacks ?? 0) || 0);
}

/*
功能
判断「破势」是否可被一次突袭消耗。

调用方
cardRegistry assault resolver 与 tests。

输入
exposeWeakness 状态详情或 null。

输出
布尔值。

读取状态
状态详情。

写入状态
无。

调用函数
getExposeWeaknessStacks。

边界与不变量
层数大于 0 才可消耗。
*/
export function isExposeWeaknessConsumable(statusDetail) {
  return getExposeWeaknessStacks(statusDetail) > 0;
}

/*
功能
读取「孤注」状态提供的突袭伤害加成。

调用方
skillRegistry gamble passive 与 tests。

输入
allIn 状态详情或 null。

输出
非负整数。

读取状态
状态详情。

写入状态
无。

调用函数
无。

边界与不变量
不可叠加；缺失按 0。
*/
export function getAllInAssaultBonus(statusDetail) {
  return Math.max(0, Number(statusDetail?.assaultBonus ?? 0) || 0);
}

/*
功能
判断「猎印」是否在指定追踪回合已经到期。

调用方
skillRegistry tracking cleanup 与 tests。

输入
huntMark 状态详情与当前追踪回合。

输出
布尔值。

读取状态
状态详情。

写入状态
无。

调用函数
无。

边界与不变量
expireAtTurnEnd <= 当前回合时到期。
*/
export function isHuntMarkExpired(statusDetail, currentTrackingTurn) {
  return Number(statusDetail?.expireAtTurnEnd ?? Number.POSITIVE_INFINITY)
    <= Number(currentTrackingTurn);
}

/*
功能
决定闪电状态的下一名合法持有者 ID。

调用方
Game status workflow 与 RuleEngine。

输入
Rule Player 投影数组与当前 holder id。

输出
下一 holder id，无他人时返回当前 holder id。

读取状态
alive/seatIndex/id/statusIds。

写入状态
无。

调用函数
hasStatus。

边界与不变量
跳过死亡与已闪电者；未找到时回绕 holder。
*/
export function nextLightningReceiverId(players, holderId) {
  assertCanonicalSeatRoster(players);
  const holder = players.find((player) => player.id === holderId);
  if (!holder?.alive) return holderId;
  for (let offset = 1; offset < players.length; offset += 1) {
    const candidate = players[(holder.seatIndex + offset) % players.length];
    if (candidate?.alive && candidate.id !== holder.id && !hasStatus(candidate, "lightning")) {
      return candidate.id;
    }
  }
  return holder.id;
}

/*
功能
判断猎印是否因留下者死亡而到期。

调用方
Application DyingWorkflow death cleanup 与 tests。

输入
huntMark 状态详情与死亡来源 ID。

输出
布尔值。

读取状态
状态详情 sourceId。

写入状态
无。

调用函数
无。

边界与不变量
只比较 sourceId；其它状态不受影响。
*/
export function isHuntMarkSourceExpired(statusDetail, deadSourceId) {
  return Boolean(deadSourceId && statusDetail?.sourceId === deadSourceId);
}

/*
功能
返回 StatusDefinitions 中已存在的状态 ID。

调用方
tests 与未来 rules。

输入
statusId。

输出
状态定义或 null。

读取状态
STATUS_DEFINITIONS。

写入状态
无。

调用函数
无。

边界与不变量
不创建第二份 catalog。
*/
export function getStatusDefinition(statusId) {
  return STATUS_DEFINITIONS[statusId] ?? null;
}
