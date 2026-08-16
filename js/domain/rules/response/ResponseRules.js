/*
模块职责
唯一拥有响应资格、格挡需求、反制资格与响应座次顺序的纯规则语义；不拥有 async window、UI、payment 或 nested chain workflow。

上游
ResponseSystem 与 tests。

下游
无。

状态边界
只读传入 facts；不写状态。

信息边界
不读取 AI/UI/隐藏信息。

架构约束
不得依赖 application/adapters/AI/UI/Game runtime；不得 await、emit、随机。
*/

/*
功能
决定一次可格挡攻击需要几张格挡。

调用方
ResponseSystem.askForBlock。

输入
source equipmentDefinitionId 与 damage facts。

输出
1 或 2。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
军火库对突袭/震荡为 2。
*/
export function getRequiredBlockCount(sourceEquipmentDefinitionId, isAssaultDamage = false) {
  return isAssaultDamage && sourceEquipmentDefinitionId === "battleDevice" ? 2 : 1;
}

/*
功能
决定一次伤害是否属于突袭/震荡格挡加重语义。

调用方
ResponseSystem.askForBlock 与 tests。

输入
card 与 damageType。

输出
布尔值。

读取状态
card.subtypes 与 damageType。

写入状态
无。

调用函数
无。

边界与不变量
突袭与震荡视为 assault damage；卡牌缺失为 false。
*/
export function isAssaultDamage(card, damageType) {
  return Boolean(card?.subtypes?.includes("assault") && ["normal", "area"].includes(damageType));
}

/*
功能
决定是否进入格挡请求窗口。

调用方
ResponseSystem.askForBlock 与 tests。

输入
canBlock 与 amount。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不可格挡或非正伤害不请求。
*/
export function isBlockResponseAvailable(canBlock, amount) {
  return Boolean(canBlock && amount > 0);
}

/*
功能
返回响应类型对应的卡牌定义 ID。

调用方
ResponseSystem.requestCardResponse 与 tests。

输入
响应类型。

输出
定义 ID 或 null。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
block/counter 是当前响应类型全集。
*/
export function getResponseCardDefinitionId(type) {
  if (type === "block") return "block";
  if (type === "counter") return "counter";
  return null;
}

/*
功能
决定已选择响应牌数量是否满足要求。

调用方
ResponseSystem.requestCardResponse 与 tests。

输入
availableCount 与 requiredCount。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只比较数量；实体区校验由 workflow 保留。
*/
export function hasSufficientResponseCards(availableCount, requiredCount) {
  return availableCount >= requiredCount;
}

/*
功能
决定响应者是否具备基本响应资格。

调用方
ResponseSystem.requestCardResponse 与 tests。

输入
responder。

输出
布尔值。

读取状态
alive。

写入状态
无。

调用函数
无。

边界与不变量
不含 controllerType/human/AI 判断。
*/
export function isResponderEligible(responder) {
  return Boolean(responder?.alive);
}

/*
功能
决定延迟状态反制的响应顺序：状态持有者最先，其余按座次顺时针。

调用方
ResponseSystem.askForStatusCounter 与 tests。

输入
players 投影与 holder id。

输出
玩家 ID 数组，从 holder 开始。

读取状态
alive/seatIndex/id。

写入状态
无。

调用函数
getCounterResponderOrder。

边界与不变量
只包含存活玩家；holder 不在 players 时返回空。
*/
export function getStatusCounterResponderOrder(players, holderId) {
  const holder = players.find((player) => player.id === holderId);
  if (!holder?.alive) return [];
  const following = getCounterResponderOrder(players, holderId)
    .filter((id) => players.find((player) => player.id === id)?.alive);
  return [holderId, ...following];
}

/*
功能
判断战术牌是否可被反制。

调用方
ResponseSystem.askForCounter。

输入
card category 与 counterable。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只有可反制战术牌。
*/
export function isCounterEligible(category, counterable) {
  return category === "tactic" && counterable !== false;
}

/*
功能
判断濒死救援者资格。

调用方
ResponseSystem.requestDyingRescue。

输入
rescuer/target alive、hp 与阵营。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
仅同阵营存活救援。
*/
export function isDyingRescueEligible(rescuer, target) {
  return Boolean(rescuer?.alive && target?.alive && target.hp <= 0 && rescuer.battleTeam === target.battleTeam);
}

/*
功能
决定普通反制响应者顺序。

调用方
ResponseSystem 与 tests。

输入
players 投影与 sourceId。

输出
玩家 ID 数组，从 source 下一座位开始。

读取状态
seatIndex。

写入状态
无。

调用函数
无。

边界与不变量
不含 source。
*/
export function getCounterResponderOrder(players, sourceId) {
  const source = players.find((player) => player.id === sourceId);
  if (!source) return [];
  const ordered = [];
  for (let offset = 1; offset < players.length; offset += 1) {
    ordered.push(players[(source.seatIndex + offset) % players.length].id);
  }
  return ordered.filter((id) => id !== sourceId);
}
