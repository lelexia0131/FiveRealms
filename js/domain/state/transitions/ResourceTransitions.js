/*
模块职责
拥有能量、生命与护盾的 root-aware 通用原子写操作；不拥有任何卡牌/技能/伤害规则语义。

上游
Game、HpLossSystem、DyingSystem、cardRegistry、skillRegistry 的 legacy commit façade。

下游
无。

状态边界
只修改传入 state.stateVersion 与 Player primitive resource 字段。

信息边界
不读取卡牌、技能、AI 或隐藏信息。

架构约束
不得依赖 Game/EventBus/UI/AI/application/adapters；不得出现 cardId/skillId/statusId 规则分支。
*/
import { bumpStateVersion } from "./StateVersion.js?build=20260816-legacy-recovery";
import { clamp } from "../../../utils/helpers.js?build=20260816-legacy-recovery";

/*
功能
按当前能量上限安全变更能量并返回实际变化量。

调用方
Game.gainEnergy、技能 execute 与直接测试。

输入
authoritative state、Player 与能量增量。

输出
实际能量变化量。

读取状态
state.stateVersion、player.energy、player.maxEnergy。

写入状态
player.energy；实际变化时 bump stateVersion。

调用函数
clamp、bumpStateVersion。

边界与不变量
no-op 返回 0 且不 bump；不触发事件、不记录日志。
*/
export function changeEnergy(state, player, amount) {
  const previous = player.energy;
  player.energy = clamp(player.energy + amount, 0, player.maxEnergy);
  const actual = player.energy - previous;
  if (actual !== 0) bumpStateVersion(state);
  return actual;
}

/*
功能
对玩家生命执行已决定的整数增量。

调用方
Game.damage、Game.heal、HpLossSystem、DyingSystem 与直接测试。

输入
state、Player 与生命增量。

输出
变更后的生命值。

读取状态
state.stateVersion、player.hp。

写入状态
player.hp；delta 非 0 时 bump。

调用函数
bumpStateVersion。

边界与不变量
不 clamp 到 maxHp，也不判断 alive；当前负生命/濒死语义由 workflow 继续拥有。
*/
export function changeHp(state, player, delta) {
  player.hp += delta;
  if (delta !== 0) bumpStateVersion(state);
  return player.hp;
}

/*
功能
将玩家生命设置为已决定的精确值。

调用方
DyingSystem cancel/kill 与直接测试。

输入
state、Player 与目标生命值。

输出
写入后的生命值。

读取状态
state.stateVersion、player.hp。

写入状态
player.hp；值变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
只写 primitive；不触发 dying/救援/胜利。
*/
export function setHp(state, player, value) {
  if (player.hp === value) return value;
  player.hp = value;
  bumpStateVersion(state);
  return player.hp;
}

/*
功能
对玩家护盾执行已决定的整数增量。

调用方
Game.damage、cardRegistry、skillRegistry 与直接测试。

输入
state、Player 与护盾增量。

输出
变更后的护盾值。

读取状态
state.stateVersion、player.shield。

写入状态
player.shield；delta 非 0 时 bump。

调用函数
bumpStateVersion。

边界与不变量
允许负值变化；是否消耗护盾由外部 workflow 决定。
*/
export function changeShield(state, player, delta) {
  player.shield += delta;
  if (delta !== 0) bumpStateVersion(state);
  return player.shield;
}
