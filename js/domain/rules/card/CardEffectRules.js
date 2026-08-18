/*
模块职责
唯一拥有卡牌效果的动态规则解释；固定数值事实由 CardDefinitions 唯一拥有，本模块只转发或按运行状态组合。

上游
CardEffectRuntime、AI deterministic simulation 与 tests。

下游
Domain StatusRules 与 CardDefinitions。

状态边界
只读传入 facts；不写状态。

信息边界
不读取 hidden card 内容、AI、UI。

架构约束
不得依赖 Game/application/adapters/EventDispatcher；不得 await、emit、随机、mutation；不得复制 CardDefinitions 固定 literal。
*/

import { CARD_DEFINITIONS } from "../../definitions/cards/CardDefinitions.js";
import { getExposeWeaknessStacks } from "../status/StatusRules.js";

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
export function getAssaultBaseDamage() { return CARD_DEFINITIONS.assault.baseDamage; }

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
export function getRecoverHealAmount() { return CARD_DEFINITIONS.recover.healAmount; }

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
export function getChargeEnergyAmount() { return CARD_DEFINITIONS.charge.energyGain; }

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
export function getShieldAmount() { return CARD_DEFINITIONS.shield.shieldAmount; }

/*
功能
返回窥探牌可查看的最大手牌数。

调用方
CardIntentRuntime 与 CardEffectRuntime。

输入
无。

输出
非负整数。

读取状态
CARD_DEFINITIONS.scout.maxRevealCount。

写入状态
无。

调用函数
无。

边界与不变量
选择阶段和结算阶段必须消费同一权威上限。
*/
export function getScoutMaxRevealCount() { return CARD_DEFINITIONS.scout.maxRevealCount; }

/*
功能
返回闪电判定命中时的伤害值。

调用方
StatusResolutionWorkflow.resolveLightning。

输入
无。

输出
非负数值。

读取状态
CARD_DEFINITIONS.lightning.hitDamage。

写入状态
无。

调用函数
无。

边界与不变量
只返回固定事实，不解释判定或伤害顺序。
*/
export function getLightningHitDamage() { return CARD_DEFINITIONS.lightning.hitDamage; }

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
  return getExposeWeaknessStacks(statusDetail) + CARD_DEFINITIONS.exposeWeakness.stacksGain;
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
export function getShockwaveDamage() { return CARD_DEFINITIONS.shockwave.perTargetDamage; }

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
export function getProvokeDamage() { return CARD_DEFINITIONS.provoke.failDamage; }

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
export function getHarvestDrawCount() { return CARD_DEFINITIONS.harvest.drawCount; }

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
export function getDuelDamage() { return CARD_DEFINITIONS.duel.failDamage; }

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
export function getSymbiosisHealAmount() { return CARD_DEFINITIONS.symbiosis.healAmount; }
