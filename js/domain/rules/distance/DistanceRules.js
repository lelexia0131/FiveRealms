/*
模块职责
唯一拥有 FiveRealms 确定性距离语义：存活环、基础距离、装备方向修正与最小距离。

上游
DistanceRules 的 deterministic boundary、ActionLegality 与 tests。

下游
CardDefinitions。

状态边界
只读玩家公开座位/存活/装备定义 ID；不写状态。

信息边界
不认识 equipmentRetentionProbability、SearchState、AI probability 或隐藏信息。

架构约束
不得依赖 application/adapters/AI/UI/Game runtime；不得采样随机。
固定装备距离修正数值（望远镜 -1 / 屏障 +1）由 CardDefinitions 唯一拥有。
*/
import { CARD_DEFINITIONS } from "../../definitions/cards/CardDefinitions.js";

/*
功能
返回按 seatIndex 升序的存活玩家。

调用方
DistanceRules 与 tests。

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
DistanceRules 与 tests。

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
计算 deterministic 方向性距离：来源装备 outgoing 修正、目标装备 incoming 修正，下限 1。

调用方
DistanceRules 与 tests。

输入
players、source、target 与显式装备定义 ID。

输出
非负整数或 Infinity。

读取状态
getBaseDistance、CARD_DEFINITIONS 与 equipmentDefinitionId。

写入状态
无。

调用函数
getBaseDistance。

边界与不变量
只接受已投影的确定性装备事实；装备固定修正数值从 CardDefinitions 读取。
*/
export function getDistance(players, source, target, sourceEquipmentDefinitionId = null, targetEquipmentDefinitionId = null) {
  let distance = getBaseDistance(players, source, target);
  if (!Number.isFinite(distance) || distance === 0) return distance;
  const sourceModifier = CARD_DEFINITIONS[sourceEquipmentDefinitionId]?.outgoingDistanceModifier ?? 0;
  const targetModifier = CARD_DEFINITIONS[targetEquipmentDefinitionId]?.incomingDistanceModifier ?? 0;
  distance += sourceModifier;
  distance += targetModifier;
  return Math.max(1, distance);
}
