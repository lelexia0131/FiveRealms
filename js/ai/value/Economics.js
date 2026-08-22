/*
模块职责
唯一拥有 State Value 原始点数到最终 HP-equivalent utility 的换算与共享经济尺度。

上游
Evaluator、FrontierValue、Simulator 与响应策略。

下游
无；只使用显式输入与稳定数值常量。

状态边界
只读传入的可见玩家和动作；不读取 Game，也不写任何状态。

信息边界
只使用公开或已过滤的 SearchState 字段和显式规则能力。

架构约束
不得收纳搜索先验或无状态依据的 final flow；已进入 after-state 的价值不得再次成为 economic term。
*/

export const RESOURCE_MATERIAL_SCALE = 0.25;
export const HP_VALUE = 5;
export const ENERGY_STATE_WEIGHT = 1.2;

/*
功能
把内部 State Value 点数转换为最终 HP-equivalent utility。

调用方
TransitionValue、FrontierValue、ValueLedger、Search Prior 归一化与单位正式测试。

输入
以 HP_VALUE 点代表一生命值的有限 State Value 点数。

输出
最终 utility；一单位严格等于一生命值的状态价值。

读取状态
HP_VALUE。

写入状态
无。

调用函数
无。

边界与不变量
这是由 HP 基线推导的单位换算，不是经验缩放；Final Utility 项最多转换一次；
Search Prior 若消费它，只能作为不进入 final 的 beam heuristic 输入归一化。
*/
export function statePointsToUtility(points) {
  return (Number(points) || 0) / HP_VALUE;
}

/*
功能
返回当前 transition 中 after-state 无法表达的动作流量。

调用方
TransitionValue 与正式边界。

输入
候选动作、真实 actor 执行视图与过滤后的 before state。

输出
当前没有额外 final flow，因此返回零 HP-equivalent utility。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
结束动作的弃牌已在 after-state，聚能与技能可用性由能量存量和后续 transition 表达；不得重复奖励。
*/
export function actionEconomicValue(action, player, visible) {
  void action;
  void player;
  void visible;
  return 0;
}

/*
功能
计算充能桩下一回合有效能量的状态价值。

调用方
value/Evaluator。

输入
显式注入的队伍能量规则能力与可见玩家。

输出
按装备保留概率折算的未来状态点数。

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
  return retention * baseValue;
}
