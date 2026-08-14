/*
模块职责
唯一拥有目标威胁、攻击暴露、雷达减免、护盾与低生命风险的价值 primitive。

上游
Evaluator、SearchPrior、响应策略、转移策略与兼容入口。

下游
DistanceSystem 与 value/Economics 的生命尺度。

状态边界
只读传入的 VisibleState/SearchState；不写状态，不启动模拟。

信息边界
只使用公开字段、概率摘要与合法的近期攻击者记忆，不读取敌方隐藏手牌身份。

架构约束
威胁公式只能在本模块出现；状态 primitive 可被 Evaluator 组合，但不得独立追加到 final transition。
*/
import { DistanceSystem } from "../../core/DistanceSystem.js?build=20260814-ai-value-ownership";
import { HP_VALUE } from "./Economics.js?build=20260814-ai-value-ownership";

export const DANGER_VALUE = 7;
export const DEATH_VALUE = 28;
export const SHIELD_RESERVE_WEIGHT = 2;
export const SHIELD_PROTECTION_WEIGHT = 0.5;
export const HP_RISK_OPTION_WEIGHT = 0.05;

export class ThreatCalculator {
  /*
  功能
  计算一个存活敌人的公开目标威胁分。

  调用方
  SearchPrior、转移策略与兼容入口。

  输入
  viewer、目标可见条目、合法记忆与当前行动预计伤害。

  输出
  越高越值得优先处理的策略值；非敌方返回负无穷。

  读取状态
  只读可见角色字段与近期攻击者记忆。

  写入状态
  无。

  调用函数
  Array.some。

  边界与不变量
  不读取敌方具体手牌；本值属于 POLICY_VALUE，不进入最终 transition。
  */
  static calculate(viewer, target, memory, expectedDamage = 1) {
    if (!target.alive || target.battleTeam === viewer.battleTeam) return -Infinity;
    const roleTags = target.roleTags ?? [];
    const displayTags = target.tags ?? [];
    const statuses = target.statuses ?? [];
    const handCount = target.handCount ?? target.hand?.length ?? 0;
    let score = ((target.maxHp ?? 0) - (target.hp ?? 0)) * 2.5
      + handCount * 1.4 + (target.energy ?? 0) * 2;
    if (roleTags.some((tag) => ["damage", "attacker", "caster", "hunter"].includes(tag))
      || displayTags.some((tag) => ["输出", "群攻", "爆发", "突破"].includes(tag))) score += 4;
    if (roleTags.some((tag) => ["support", "healer", "tank", "protector", "control"].includes(tag))
      || displayTags.some((tag) => ["防护", "恢复", "辅助", "控制", "过牌"].includes(tag))) score += 3;
    if ((target.hp ?? 0) + (target.shield ?? 0) <= expectedDamage) score += 24;
    if (statuses.includes("exposed") || statuses.includes("exposeWeakness") || statuses.includes("huntMark")) score += 4;
    score += (memory?.recentAggressors?.[target.id] ?? 0) * 2;
    return score;
  }
}

/*
功能
把敌方攻击暴露拆成当前威胁、未来突袭库存与能量压力。

调用方
Evaluator、FrontierValue、响应策略与兼容入口。

输入
过滤后的状态与被评估玩家。

输出
三个可加和分量及逐敌人分解。

读取状态
只读存活、队伍、距离、突袭概率摘要与能量。

写入状态
无。

调用函数
DistanceSystem.getRangeLegalityProbability。

边界与不变量
三个分量之和恒等于既有 incoming exposure；不得用 raw handCount 推断敌方突袭身份。
*/
export function exposureComponents(state, player) {
  const perEnemy = [];
  let currentThreat = 0;
  let futureInventory = 0;
  let energyPressure = 0;
  for (const enemy of state.players) {
    if (!enemy?.alive || enemy.battleTeam === player.battleTeam || enemy.id === player.id) continue;
    const rangeProbability = DistanceSystem.getRangeLegalityProbability(
      { state }, enemy, player, enemy.attackRange ?? 1
    );
    if (rangeProbability <= 0) continue;
    const energy = Math.max(0, Number(enemy.energy ?? 0));
    const expectedAssault = Math.max(0, Number(enemy.expectedAssaultCount ?? 0));
    const response = Math.max(0, Math.min(1, Number(enemy.assaultResponseProbability) || 0));
    const current = response * HP_VALUE * rangeProbability;
    const future = Math.min(3, expectedAssault) * 0.5 * HP_VALUE * rangeProbability;
    const energyTerm = Math.min(2, energy) * 0.3 * HP_VALUE * rangeProbability;
    currentThreat += current;
    futureInventory += future;
    energyPressure += energyTerm;
    perEnemy.push({
      enemyId: enemy.id,
      rangeProbability,
      currentThreat: current,
      futureInventory: future,
      energyPressure: energyTerm
    });
  }
  return { currentThreat, futureInventory, energyPressure, perEnemy };
}

/*
功能
汇总被评估玩家的三个攻击暴露分量。

调用方
Evaluator 与兼容入口。

输入
过滤后的状态与玩家。

输出
非负攻击暴露总值。

读取状态
与 exposureComponents 相同。

写入状态
无。

调用函数
exposureComponents。

边界与不变量
只做加和，不新增权重或额外威胁来源。
*/
export function incomingExposure(state, player) {
  const { currentThreat, futureInventory, energyPressure } = exposureComponents(state, player);
  return currentThreat + futureInventory + energyPressure;
}

/*
功能
计算防御装置在当前暴露下的雷达减免价值。

调用方
Evaluator 与兼容入口。

输入
暴露值、玩家与战术牌判定概率。

输出
按装备保留概率和判定概率折算的减免值。

读取状态
只读装备定义与保留概率。

写入状态
无。

调用函数
无。

边界与不变量
仅 defenseDevice 生效；减免由 Evaluator 与护盾共享，不能重复抵扣同一暴露。
*/
export function radarMitigationUtility(exposure, player, tacticJudgmentProbability) {
  if (player?.equipmentDefinitionId !== "defenseDevice") return 0;
  const retention = player.equipmentRetentionProbability ?? 1;
  return exposure * retention * tacticJudgmentProbability;
}

/*
功能
计算生命恰为二且存在残余威胁时的有界风险状态值。

调用方
Evaluator 与兼容入口。

输入
玩家与排除 viewer 自身资源联动后的残余暴露。

输出
零或有界负风险值。

读取状态
只读存活和当前生命。

写入状态
无。

调用函数
无。

边界与不变量
仅 HP=2 且有威胁时生效，上限严格使用既有 danger 与风险权重。
*/
export function hp2ThreatRiskValue(player, bufferResidualExposure) {
  if (!player?.alive || player.hp !== 2) return 0;
  const threatDamage = Math.max(0, bufferResidualExposure) / HP_VALUE;
  if (threatDamage <= 1e-9) return 0;
  return -Math.min(1, threatDamage) * DANGER_VALUE * HP_RISK_OPTION_WEIGHT;
}

/*
功能
计算护盾在储备和当前残余威胁下的统一状态价值。

调用方
Evaluator 与兼容入口。

输入
玩家与已扣除雷达减免的残余暴露。

输出
非负护盾状态价值。

读取状态
只读玩家护盾、生命与存活状态。

写入状态
无。

调用函数
无。

边界与不变量
第一点盾保留储备价值，其余价值受可见威胁容量限制；不得再次完整计入伤害避免收益。
*/
export function shieldStateValue(player, residualExposure) {
  const shield = Math.max(0, Number(player.shield) || 0);
  if (!shield || !player?.alive) return 0;
  const reserve = SHIELD_RESERVE_WEIGHT * Math.min(shield, 1);
  const threatPoints = Math.max(0, residualExposure) / HP_VALUE;
  const absorbed = Math.min(shield, threatPoints);
  const hpProtection = absorbed * HP_VALUE * SHIELD_PROTECTION_WEIGHT;
  const lifePremium = player.hp === 1 ? DEATH_VALUE - HP_VALUE
    : player.hp === 2 ? DANGER_VALUE - HP_VALUE
      : 0;
  const lifeProtection = Math.min(1, absorbed) * lifePremium * SHIELD_PROTECTION_WEIGHT;
  return reserve + hpProtection + lifeProtection;
}
