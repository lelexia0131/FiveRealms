/*
模块职责
唯一拥有跨价值模块共享的经济尺度，以及 after-state 无法表达的既有 final flow 公式。

上游
Evaluator、TransitionValue、SearchPrior、Simulator 与响应策略。

下游
无；只使用显式输入与稳定数值常量。

状态边界
只读传入的可见玩家和动作；不读取 Game，也不写任何状态。

信息边界
只使用公开或已过滤的 SearchState 字段和显式规则能力。

架构约束
不得收纳搜索先验或领域魔法数字；已进入 after-state 的价值不得再次成为 economic term。
*/

import { hasPassiveSkill } from "../state/RuleProjection.js?build=20260816-fr-arch-14-runtime-closure";

export const STATE_DELTA_SCALE = 0.08;
export const HP_VALUE = 5;
export const ENERGY_STATE_WEIGHT = 1.2;
export const SKILL_THRESHOLD_OPTION_VALUE = 4;
export const END_OPPORTUNITY_CAP = 0.8;

/*
功能
计算 after-state 无法表达的既有动作经济流。

调用方
TransitionValue 与正式边界。

输入
候选动作、真实 actor 执行视图与过滤后的 before state。

输出
未缩放 economic value。

读取状态
只读 before state 中的手牌、连势、能量与主动技能门槛。

写入状态
无。

调用函数
无。

边界与不变量
仅保留 end 机会成本与聚能跨技能门槛选择权；二者是 LEGACY FINAL FLOW，不得加入静态牌值。
*/
export function actionEconomicValue(action, player, visible) {
  const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
  if (action.type === "end") {
    const remainingCards = actor.handCount ?? actor.hand?.length ?? player.hand.length;
    if (hasPassiveSkill(actor, "momentum") && (actor.momentum ?? 0) > 0) return 0;
    return remainingCards > 0 ? -END_OPPORTUNITY_CAP : 0;
  }
  if (action.type === "skill") return 0;
  const card = action.card;
  if (card?.definitionId === "charge") {
    return (actor.activeSkillId && !actor.activeSkillUsed && actor.energy < actor.activeSkillCost
      && actor.energy + 1 >= actor.activeSkillCost) ? SKILL_THRESHOLD_OPTION_VALUE : 0;
  }
  return 0;
}

/*
功能
计算充能桩下一回合有效能量与技能门槛选择权的状态价值。

调用方
value/Evaluator。

输入
显式注入的队伍能量规则能力与可见玩家。

输出
按装备保留概率折算的未来状态价值。

读取状态
只读玩家能量、装备、主动技能成本和显式规则查询结果。

写入状态
无。

调用函数
getMaxEnergy、getTurnEnergyBreakdown。

边界与不变量
只比较下一回合有无充能桩两个配对世界；除装备外的角色、队伍和当前能量必须相同。
*/
export function energyDeviceFutureUtility(rules = {}, player) {
  if (player?.equipmentDefinitionId !== "energyDevice" || !player?.battleTeam) return 0;
  if (typeof rules.getMaxEnergy !== "function" || typeof rules.getTurnEnergyBreakdown !== "function") return 0;
  const retention = player.equipmentRetentionProbability
    ?? (player.equipmentDefinitionId ? 1 : 0);
  if (retention <= 0) return 0;
  const ruleStub = { battleTeam: player.battleTeam };
  const cap = Math.max(0, Number(rules.getMaxEnergy(ruleStub)) || 0);
  const withoutBreakdown = rules.getTurnEnergyBreakdown(ruleStub);
  const withBreakdown = rules.getTurnEnergyBreakdown({
    ...ruleStub,
    equipment: { definitionId: "energyDevice" }
  });
  const currentEnergy = Math.max(0, Number(player.energy) || 0);
  const withoutGain = Number(withoutBreakdown.baseAmount) + Number(withoutBreakdown.teamBonus);
  const withGain = Number(withBreakdown.baseAmount) + Number(withBreakdown.teamBonus)
    + Number(withBreakdown.equipmentBonus);
  const withoutEnergy = Math.min(cap, currentEnergy + withoutGain);
  const withEnergy = Math.min(cap, currentEnergy + withGain);
  const effectiveGain = Math.max(0, withEnergy - withoutEnergy);
  const baseValue = effectiveGain * ENERGY_STATE_WEIGHT;
  const skillCost = Math.max(0, Number(player.activeSkillCost) || 0);
  const skillLimit = Math.max(0, Number(player.activeSkillLimit) || 0);
  let optionValue = 0;
  if (player.activeSkillId && skillCost > 0 && skillLimit > 0) {
    const withAffordableUses = Math.min(skillLimit, Math.floor(withEnergy / skillCost));
    const withoutAffordableUses = Math.min(skillLimit, Math.floor(withoutEnergy / skillCost));
    const additionalUses = withAffordableUses - withoutAffordableUses;
    optionValue = Math.max(0, additionalUses) * SKILL_THRESHOLD_OPTION_VALUE;
  }
  return retention * (baseValue + optionValue);
}
