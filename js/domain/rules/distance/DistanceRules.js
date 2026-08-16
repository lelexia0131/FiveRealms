/*
模块职责
唯一拥有 FiveRealms 确定性距离语义：存活环、基础距离、装备方向修正与最小距离。

上游
DistanceSystem 的 deterministic façade、RuleEngine 与 tests。

下游
无。

状态边界
只读玩家公开座位/存活/装备定义 ID；不写状态。

信息边界
不认识 equipmentRetentionProbability、SearchState、AI probability 或隐藏信息。

架构约束
不得依赖 application/adapters/AI/UI/Game runtime；不得采样随机。
*/

/*
功能
返回按 seatIndex 升序的存活玩家。

调用方
DistanceSystem 与 tests。

输入
players 数组。

输出
存活玩家数组。

读取状态
alive/seatIndex。

写入状态
无。

调用函数
Array.filter/sort。

边界与不变量
不修改输入数组。
*/
export function getAliveRing(players) {
  return players.filter((player) => player.alive).sort((a, b) => a.seatIndex - b.seatIndex);
}

/*
功能
计算两名存活玩家在压缩存活环上的基础距离。

调用方
DistanceSystem 与 tests。

输入
players、source 与 target。

输出
非负整数或 Infinity。

读取状态
alive/seatIndex/id。

写入状态
无。

调用函数
getAliveRing。

边界与不变量
同玩家为 0；缺失为 Infinity。
*/
export function getBaseDistance(players, source, target) {
  if (!source || !target || !source.alive || !target.alive) return Infinity;
  if (source.id === target.id) return 0;
  const ring = getAliveRing(players);
  const sourceIndex = ring.findIndex((player) => player.id === source.id);
  const targetIndex = ring.findIndex((player) => player.id === target.id);
  if (sourceIndex < 0 || targetIndex < 0) return Infinity;
  const clockwise = Math.abs(sourceIndex - targetIndex);
  return Math.min(clockwise, ring.length - clockwise);
}

/*
功能
计算 deterministic 方向性距离：望远镜 -1，屏障 +1，下限 1。

调用方
DistanceSystem 与 tests。

输入
players、source、target 与显式装备定义 ID。

输出
非负整数或 Infinity。

读取状态
getBaseDistance 与 equipmentDefinitionId。

写入状态
无。

调用函数
getBaseDistance。

边界与不变量
只接受已投影的确定性装备事实。
*/
export function getDistance(players, source, target, sourceEquipmentDefinitionId = null, targetEquipmentDefinitionId = null) {
  let distance = getBaseDistance(players, source, target);
  if (!Number.isFinite(distance) || distance === 0) return distance;
  if (sourceEquipmentDefinitionId === "telescope") distance -= 1;
  if (targetEquipmentDefinitionId === "barrierDevice") distance += 1;
  return Math.max(1, distance);
}
