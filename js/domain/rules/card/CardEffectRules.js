/*
模块职责
唯一拥有卡牌效果的纯 deterministic effect facts：静态数值与依赖状态的简单数值决定；不拥有 async sequencing、movement、response、choice、presentation 或 mutation。

上游
CardEffectRuntime 与 tests。

下游
Domain StatusRules。

状态边界
只读传入 facts；不写状态。

信息边界
不读取 hidden card 内容、AI、UI。

架构约束
不得依赖 Game/application/adapters/EventBus；不得 await、emit、随机、mutation。
*/

import { getExposeWeaknessStacks } from "../status/StatusRules.js?build=20260815-shadow-agent-p1-slot";

/*
功能
返回突袭基础伤害。

调用方
CardEffectRuntime.assault。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
破势额外伤害由 getAssaultDamageBonus 决定。
*/
export function getAssaultBaseDamage() { return 1; }

/*
功能
返回调息治疗量。

调用方
CardEffectRuntime.recover。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getRecoverHealAmount() { return 1; }

/*
功能
返回聚能能量获取量。

调用方
CardEffectRuntime.charge。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getChargeEnergyAmount() { return 1; }

/*
功能
返回护盾牌护盾量。

调用方
CardEffectRuntime.shield。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getShieldAmount() { return 1; }

/*
功能
决定破势新增层数。

调用方
CardEffectRuntime.exposeWeakness。

输入
当前状态详情。

输出
下一层数。

读取状态
statusDetail.stacks。

写入状态
无。

调用函数
getExposeWeaknessStacks。

边界与不变量
层数叠加。
*/
export function getNextExposeWeaknessStacks(statusDetail) {
  return getExposeWeaknessStacks(statusDetail) + 1;
}

/*
功能
返回震荡每目标伤害。

调用方
CardEffectRuntime.shockwave。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getShockwaveDamage() { return 1; }

/*
功能
返回挑衅失败伤害。

调用方
CardEffectRuntime.provoke。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getProvokeDamage() { return 1; }

/*
功能
返回丰收摸牌数。

调用方
CardEffectRuntime.harvest。

输入
无。

输出
2。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getHarvestDrawCount() { return 2; }

/*
功能
返回决斗失败伤害。

调用方
CardEffectRuntime.duel。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getDuelDamage() { return 1; }

/*
功能
返回互利展示数量。

调用方
CardEffectRuntime.mutualBenefit。

输入
aliveCount。

输出
aliveCount。

读取状态
无。

写入状态
无。

调用函数
Math.max。

边界与不变量
纯事实投影。
*/
export function getMutualBenefitRevealCount(aliveCount) {
  return Math.max(0, Number(aliveCount) || 0);
}

/*
功能
返回共生每目标治疗量。

调用方
CardEffectRuntime.symbiosis。

输入
无。

输出
1。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
固定事实。
*/
export function getSymbiosisHealAmount() { return 1; }
