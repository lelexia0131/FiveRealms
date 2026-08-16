/*
模块职责
唯一拥有伤害/护盾吸收/治疗上限与濒死谓词的纯战斗语义；不拥有 response、dying workflow 或 mutation。

上游
Game.damage/heal 与 tests。

下游
无。

状态边界
只读数值输入；不写状态。

信息边界
不读取 AI/UI/隐藏信息。

架构约束
不得依赖 application/adapters/Game runtime；不得 await、emit、随机。
*/

/*
功能
计算护盾吸收量。

调用方
Game.damage。

输入
shield 与 amount。

输出
非负整数吸收量。

读取状态
无。

写入状态
无。

调用函数
Math.min。

边界与不变量
不超过盾与伤害的最小值。
*/
export function calculateShieldAbsorption(shield, amount) {
  return Math.min(shield, amount);
}

/*
功能
计算扣除护盾后的生命伤害。

调用方
Game.damage。

输入
amount 与 shieldAbsorbed。

输出
非负整数。

读取状态
无。

写入状态
无。

调用函数
Math.max。

边界与不变量
允许 0。
*/
export function calculateHpDamage(amount, shieldAbsorbed) {
  return Math.max(0, amount - shieldAbsorbed);
}

/*
功能
判断目标是否进入濒死。

调用方
Game.damage。

输入
hp 与 alive。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
hp <= 0 且仍存活才为 true；已阵亡不重复判定。
*/
export function isDying(hp, alive) {
  return hp <= 0 && alive;
}

/*
功能
计算一次伤害应用后的护盾吸收、生命伤害、剩余生命与濒死结论。

调用方
Game.damage 与 tests。

输入
伤害量、当前护盾与当前生命。

输出
冻结的 { shieldAbsorbed, hpDamage, remainingHp, dying }。

读取状态
无。

写入状态
无。

调用函数
calculateShieldAbsorption、calculateHpDamage、isDying。

边界与不变量
允许负 HP 与 overkill 语义；zero damage 返回 0/0。
*/
export function calculateDamageResult(amount, shield, hp) {
  const shieldAbsorbed = calculateShieldAbsorption(shield, amount);
  const hpDamage = calculateHpDamage(amount, shieldAbsorbed);
  const remainingHp = hp - hpDamage;
  return Object.freeze({ shieldAbsorbed, hpDamage, remainingHp, dying:isDying(remainingHp, true) });
}

/*
功能
判断一次真实死亡是否满足击杀奖励资格。

调用方
Application DyingWorkflow 与 tests。

输入
target facts 与 source facts。

输出
布尔值。

读取状态
rewardGranted、alive 与 battleTeam facts。

写入状态
无。

调用函数
无。

边界与不变量
奖励只能授予一次；来源必须存活且敌对；击杀者可为空。
*/
export function isKillRewardEligible(targetFacts, sourceFacts) {
  return Boolean(
    !targetFacts?.rewardGranted
    && sourceFacts?.alive
    && sourceFacts.battleTeam !== targetFacts?.battleTeam
  );
}

/*
功能
计算治疗实际量。

调用方
Game.heal。

输入
请求量、最大生命与当前生命。

输出
实际治疗量。

读取状态
无。

写入状态
无。

调用函数
Math.min。

边界与不变量
满血为 0。
*/
export function calculateHealAmount(amount, maxHp, hp) {
  return Math.min(amount, maxHp - hp);
}
