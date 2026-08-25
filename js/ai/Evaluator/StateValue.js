/*
模块职责
唯一拥有非卡牌 World-state 价值 primitive，包括生命、生存、能量、护盾、状态、威胁与团队局面。

上游
Evaluator public facade 与直接 primitive 契约测试。

下游
Domain Card Definitions 与 canonical Probability facade。

状态边界
只读 canonical World；不构造或修改任何 transition World。

信息边界
只使用公开字段、合法概率摘要与已过滤记忆，不读取敌方隐藏实体身份。

架构约束
不得拥有卡牌资产价值、最终 utility 聚合或候选比较；不得 import CardValue 或 Simulator。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  getRangeConditionBranches,
  queryPlayerHandProbability,
  sealOutcomeProbabilities
} from "../Event/Probability/Probability.js";

export const HP_VALUE = 5;
const ENERGY_STATE_WEIGHT = 1.2;

/*
功能
把内部 State Value 点数转换为最终 HP-equivalent utility。

调用方
Evaluator transition/frontier/diagnostics、搜索先验归一化与单位正式测试。

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
搜索先验若消费它，只能作为不进入 final 的 beam heuristic 输入归一化。
*/
export function statePointsToUtility(points) {
  return (Number(points) || 0) / HP_VALUE;
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

export const DANGER_VALUE = 7;
const DEATH_VALUE = 28;
const SHIELD_RESERVE_WEIGHT = 2;
const SHIELD_PROTECTION_WEIGHT = 0.5;
export const HP_RISK_OPTION_WEIGHT = 0.05;

/*
功能
读取玩家当前突袭库存的正式期望摘要，并在缺失时从合法已知卡牌回退。

调用方
expectedUsableAssaultsNextTurn 与 assaultThreat。

输入
过滤后的玩家状态。

输出
非负期望突袭库存。

读取状态
expectedAssaultCount、自己手牌与合法 knownCards。

写入状态
无。

调用函数
queryPlayerHandProbability。

边界与不变量
不会用 handCount 猜测未知牌定义；正式摘要存在时保持其概率含义。
*/
const expectedAssaultResources = (player, state) => queryPlayerHandProbability(
  state.probabilityState, player, "assault"
).expected;

/*
功能
把当前能量、回合增益与能量装置保留概率投影为下一回合能量分支。

调用方
futureSkillReadinessProbability。

输入
过滤后的玩家状态。

输出
互斥的 probability/energy 分支。

读取状态
当前能量、能量上限、基础/装备增益与装备保留概率。

写入状态
无。

调用函数
clampProbability。

边界与不变量
分支概率质量为一，能量始终受现有上限限制。
*/
const nextTurnEnergyBranches = (player) => {
  const current = Math.max(0, Number(player?.energy) || 0);
  const baseGain = Math.max(0, Number(player?.turnEnergyGainWithoutEquipment ?? 1) || 0);
  const equipmentGain = Math.max(0, Number(player?.energyDeviceTurnEnergyGain ?? 1) || 0);
  const cap = Math.max(current, Number(player?.maxEnergy) || current + baseGain + equipmentGain);
  const withoutEquipment = Math.min(cap, current + baseGain);
  if (player?.equipmentDefinitionId !== "energyDevice") {
    return [{ probability:1, energy:withoutEquipment }];
  }
  const retained = clampProbability(player?.equipmentRetentionProbability ?? 1);
  if (retained <= PROBABILITY_EPSILON) return [{ probability:1, energy:withoutEquipment }];
  const withEquipment = Math.min(cap, current + baseGain + equipmentGain);
  if (retained >= 1 - PROBABILITY_EPSILON || withEquipment === withoutEquipment) {
    return [{ probability:1, energy:withEquipment }];
  }
  return [
    { probability:1 - retained, energy:withoutEquipment },
    { probability:retained, energy:withEquipment }
  ];
};

/*
功能
读取下一回合基础攻击次数；输入未提供该字段时回退当前次数或一。

调用方
expectedUsableAssaultsNextTurn。

输入
过滤后的玩家状态。

输出
非负基础攻击次数。

读取状态
nextTurnBaseAttackLimit 与 attackLimit。

写入状态
无。

调用函数
无。

边界与不变量
不包含破军额外容量，额外容量必须按独立概率项组合。
*/
const nextTurnBaseAttackLimit = (player) => {
  const configured = Number(player?.nextTurnBaseAttackLimit);
  if (Number.isFinite(configured)) return Math.max(0, configured);
  const current = Number(player?.attackLimit);
  return Number.isFinite(current) ? Math.max(0, current) : 1;
};

/*
功能
计算给定库存、基础次数与一次额外容量概率下的期望可兑现数量。

调用方
expectedUsableAssaultsNextTurn。

输入
库存数量、基础上限与额外一次攻击概率。

输出
非负期望使用数量。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
额外容量最多兑现一张且只在库存超过基础上限时生效。
*/
const expectedUsableFromInventory = (inventory, limit, extraAttackProbability) => {
  const count = Math.max(0, Number(inventory) || 0);
  const baseUses = Math.min(count, limit);
  const extraUses = Math.min(1, Math.max(0, count - limit));
  return baseUses + extraUses * extraAttackProbability;
};

/*
功能
估算角色在下一次正常能量阶段后可发动主动技能的概率。

调用方
skillReadinessThreat 与 expectedUsableAssaultsNextTurn。

输入
过滤后的玩家状态。

输出
零到一之间的技能可用概率。

读取状态
当前能量、装备保留概率、能量上限与主动技能成本/次数。

写入状态
无。

调用函数
nextTurnEnergyBranches、clampProbability。

边界与不变量
忽略本回合已用次数并按新回合重置后的合法能量条件估算。
*/
export function futureSkillReadinessProbability(player) {
  const skillId = player?.activeSkillId;
  const skillCost = Math.max(0, Number(player?.activeSkillCost) || 0);
  const skillLimit = Math.max(0, Number(player?.activeSkillLimit) || 0);
  if (!skillId || skillCost <= 0 || skillLimit <= 0) return 0;
  return clampProbability(nextTurnEnergyBranches(player)
    .filter((branch) => branch.energy + PROBABILITY_EPSILON >= skillCost)
    .reduce((sum, branch) => sum + branch.probability, 0));
}

/*
功能
把主动技能当前或下一能量阶段的可用性转换为行动威胁值。

调用方
turnOpportunityValue 与直接价值测试。

输入
过滤后的玩家状态。

输出
非负技能准备威胁。

读取状态
技能可用概率、当前能量与技能成本。

写入状态
无。

调用函数
futureSkillReadinessProbability。

边界与不变量
沿用既有 2 与 0.5 尺度，不代表真实技能效果价值。
*/
export function skillReadinessThreat(player) {
  const readiness = futureSkillReadinessProbability(player);
  if (readiness <= PROBABILITY_EPSILON) return 0;
  const currentEnergy = Math.max(0, Number(player?.energy) || 0);
  const skillCost = Math.max(0, Number(player?.activeSkillCost) || 0);
  return readiness * (2 + (currentEnergy >= skillCost ? 0.5 : 0));
}

/*
功能
估算下一回合攻击次数与库存共同允许兑现的突袭数量。

调用方
assaultThreat、roleThreatSynergy 与 equipmentThreatSynergy。

输入
过滤后的玩家状态及其突袭数量分布。

输出
非负期望可用突袭数。

读取状态
攻击次数、破军可用概率与突袭库存分布。

写入状态
无。

调用函数
futureSkillReadinessProbability、expectedUsableFromInventory。

边界与不变量
先受基础次数限制；破军只在未来可发动的概率世界增加一次容量。
*/
export function expectedUsableAssaultsNextTurn(player, state) {
  const limit = nextTurnBaseAttackLimit(player);
  const extraAttackProbability = player?.activeSkillId === "breakArmy"
    ? futureSkillReadinessProbability(player)
    : 0;
  const distribution = queryPlayerHandProbability(
    state.probabilityState, player, "assault"
  ).distribution;
  const total = distribution.reduce((sum, branch) => sum + Number(branch.probability), 0);
  if (total > PROBABILITY_EPSILON) {
    return distribution.reduce((sum, branch) => (
      sum + Number(branch.probability)
        * expectedUsableFromInventory(branch.count, limit, extraAttackProbability)
    ), 0) / total;
  }
  return expectedUsableFromInventory(
    expectedAssaultResources(player, state), limit, extraAttackProbability
  );
}

/*
功能
把可兑现突袭和上限外储备转换为攻击库存威胁。

调用方
turnOpportunityValue 与直接价值测试。

输入
过滤后的玩家状态。

输出
非负突袭威胁值。

读取状态
期望库存与下一回合可用突袭数。

写入状态
无。

调用函数
expectedUsableAssaultsNextTurn。

边界与不变量
可使用机会是主要价值；上限外库存只保留既有较小稳定性边际。
*/
export function assaultThreat(player, state) {
  const inventory = expectedAssaultResources(player, state);
  const usable = expectedUsableAssaultsNextTurn(player, state);
  const reserve = Math.max(0, inventory - usable);
  return usable * 1.25 + Math.min(2, reserve) * 0.25;
}

/*
功能
按攻击职责标签放大已有且可兑现的攻击资源。

调用方
turnOpportunityValue 与直接价值测试。

输入
过滤后的玩家状态。

输出
非负角色职责威胁增量。

读取状态
可用突袭数与公开 roleTags。

写入状态
无。

调用函数
expectedUsableAssaultsNextTurn。

边界与不变量
没有攻击资源时返回零，不能凭角色身份产生固定排名。
*/
export function roleThreatSynergy(player, state) {
  const resources = Math.min(3, expectedUsableAssaultsNextTurn(player, state));
  if (resources <= PROBABILITY_EPSILON) return 0;
  const attackTags = (player?.roleTags ?? [])
    .filter((tag) => ["damage", "attacker", "caster", "hunter"].includes(tag)).length;
  return resources * Math.min(0.75, attackTags * 0.3);
}

/*
功能
按攻击型装备的保留概率放大已有攻击资源。

调用方
turnOpportunityValue 与直接价值测试。

输入
过滤后的玩家状态。

输出
非负装备协同威胁增量。

读取状态
装备定义、保留概率与可用突袭数。

写入状态
无。

调用函数
expectedUsableAssaultsNextTurn、clampProbability。

边界与不变量
非攻击型装备或无攻击资源时不会产生协同价值。
*/
export function equipmentThreatSynergy(player, state) {
  const definition = CARD_DEFINITIONS[player?.equipmentDefinitionId];
  if (!definition?.subtypes?.includes("attack")) return 0;
  const resources = Math.min(3, expectedUsableAssaultsNextTurn(player, state));
  return resources * 0.75 * clampProbability(player?.equipmentRetentionProbability ?? 1);
}

/*
功能
汇总手牌、能量、技能准备和攻击资源，估算被封印跳过出牌阶段的机会价值。

调用方
SealValue、SealPrior 与 ResponseBoundary。

输入
过滤后的玩家状态。

输出
非负出牌阶段机会价值。

读取状态
公开手牌数量、能量、技能与攻击威胁项。

写入状态
无。

调用函数
skillReadinessThreat、assaultThreat、roleThreatSynergy、equipmentThreatSynergy。

边界与不变量
各项及运算顺序保持既有封印价值尺度，不进入通用攻击暴露公式。
*/
export function turnOpportunityValue(player, state) {
  const hand = Math.max(0, Number(player?.handCount ?? player?.hand?.length ?? 0) || 0);
  const energy = Math.max(0, Number(player?.energy ?? 0) || 0);
  const characterResources = Math.min(2.5, hand * 0.25 + energy * 0.35);
  return 6 + characterResources + skillReadinessThreat(player) + assaultThreat(player, state)
    + roleThreatSynergy(player, state) + equipmentThreatSynergy(player, state);
}

/*
功能
计算一个存活敌人的公开目标威胁分。

调用方
Evaluator 搜索先验与转移策略。

输入
viewer、目标可见条目、合法记忆与当前行动预计伤害。

输出
越高越值得优先处理的策略值；非敌方返回负无穷。

读取状态
只读可见角色字段与近期攻击者记忆。

写入状态
无。

调用函数
无。

边界与不变量
不读取敌方具体手牌；本值属于 POLICY_VALUE，不进入最终 transition。
*/
export function threatScore(viewer, target, memory, expectedDamage = 1) {
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

/*
功能
在共享距离装备条件世界中，把一名敌人的有限突袭库存按可到达敌对目标均摊，
并返回指定目标的边际可达概率与库存兑现质量。

调用方
exposureComponents。

输入
World、攻击敌人、该敌人全部存活敌对目标与待评估目标下标。

输出
包含 rangeProbability 与 assaultAllocation 的新对象。

读取状态
只读存活、队伍、攻击距离与望远镜/屏障装置保留概率。

写入状态
无。

调用函数
getRangeConditionBranches。

边界与不变量
全部目标一次枚举共享条件世界；每个世界中一张突袭库存只被可到达目标均分一次，
全部不可达世界不分配；不得把 marginal 概率当作独立世界再次相乘。
*/
function assaultRangeAllocation(state, enemy, targets, targetIndex) {
  const branches = getRangeConditionBranches(
    { state },
    targets.map((target) => ({
      source: enemy,
      target,
      range: enemy.attackRange ?? 1
    })),
    { includeRequirementMatches: true }
  );
  let rangeProbability = 0;
  let allocation = 0;
  for (const branch of branches) {
    const targetReachable = Boolean(branch.requirementMatches?.[targetIndex]);
    if (targetReachable) rangeProbability += branch.probability;
    const reachableCount = (branch.requirementMatches ?? []).reduce(
      (sum, matches) => sum + (matches ? 1 : 0),
      0
    );
    if (targetReachable && reachableCount > 0) {
      allocation += branch.probability / reachableCount;
    }
  }
  return { rangeProbability, assaultAllocation: allocation };
}

/*
功能
把敌方攻击暴露拆成当前威胁、未来突袭库存与能量压力。

调用方
Evaluator 的 frontier 诊断与响应判断。

输入
过滤后的状态与被评估玩家。

输出
三个可加和分量及逐敌人分解。

读取状态
只读存活、队伍、距离、突袭概率摘要与能量。

写入状态
无。

调用函数
assaultRangeAllocation。

边界与不变量
三个分量之和恒等于既有 incoming exposure；不得用 raw handCount 推断敌方突袭身份。
同一张突袭牌不得同时计入当前威胁与未来库存，且同一库存按联合距离条件世界分摊，
避免对每个目标重复计全额，也不得对概率距离二次折损。
*/
export function exposureComponents(state, player) {
  const perEnemy = [];
  let currentThreat = 0;
  let futureInventory = 0;
  let energyPressure = 0;
  for (const enemy of state.players) {
    if (!enemy?.alive || enemy.battleTeam === player.battleTeam || enemy.id === player.id) continue;
    const victims = state.players.filter((victim) => (
      victim?.alive && victim.battleTeam !== enemy.battleTeam && victim.id !== enemy.id
    ));
    if (!victims.length) continue;
    const targetIndex = victims.findIndex((victim) => victim.id === player.id);
    if (targetIndex < 0) continue;
    const { rangeProbability, assaultAllocation } = assaultRangeAllocation(
      state, enemy, victims, targetIndex
    );
    if (rangeProbability <= 0) continue;
    const energy = Math.max(0, Number(enemy.energy ?? 0));
    const assault = queryPlayerHandProbability(
      state.probabilityState, enemy, "assault"
    );
    const expectedAssault = assault.expected;
    const response = assault.probability;
    // 同一张突袭牌不能同时充当“本次响应”和“下回合库存”：
    // 第一张（response 概率质量）已按当前威胁计满，未来库存只计超出响应保留的期望数量。
    const futureCount = Math.min(3, Math.max(0, expectedAssault - response));
    // current 与 future 使用同一联合条件世界分摊质量：marginal 概率只决定能量压力，
    // 不能再次乘入已分摊的有限突袭库存。
    const current = response * HP_VALUE * assaultAllocation;
    const future = futureCount * 0.5 * HP_VALUE * assaultAllocation;
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
Evaluator 与直接价值查询。

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
Evaluator 与直接价值查询。

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
Evaluator 与直接价值查询。

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
function hp2ThreatRiskValue(player, bufferResidualExposure) {
  if (!player?.alive || player.hp !== 2) return 0;
  const threatDamage = Math.max(0, bufferResidualExposure) / HP_VALUE;
  if (threatDamage <= 1e-9) return 0;
  return -Math.min(1, threatDamage) * DANGER_VALUE * HP_RISK_OPTION_WEIGHT;
}

/*
功能
计算护盾在储备和当前残余威胁下的统一状态价值。

调用方
Evaluator 与直接价值查询。

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

/*
功能
从 viewer 阵营视角计算封印跳过出牌阶段的期望团队负担。

调用方
Evaluator state aggregation、diagnostics 与响应 willingness。

输入
canonical World、封印持有者与 viewer 阵营。

输出
带阵营符号的期望负担值。

读取状态
封印结算概率与持有者非卡牌行动机会价值。

写入状态
无。

调用函数
sealOutcomeProbabilities、turnOpportunityValue。

边界与不变量
盟友负担为正、敌方负担为负；概率在消费点惰性查询且只计一次。
*/
export function sealTeamBurden(state, holder, viewerTeam) {
  if (!holder?.alive) return 0;
  const skipAction = sealOutcomeProbabilities(state, holder).skipAction;
  if (skipAction <= PROBABILITY_EPSILON) return 0;
  const sign = holder.battleTeam === viewerTeam ? 1 : -1;
  return skipAction * turnOpportunityValue(holder, state) * sign;
}

/*
功能
生成单个存活玩家的非卡牌 World-state 价值分项。

调用方
Evaluator.playerValueTerms。

输入
过滤 World、玩家、viewer ID、雷达战术概率与稳定能量规则 capability。

输出
death 与不含 hand/equipment intrinsic asset 的 terms。

读取状态
生命、生存、能量、护盾、状态、威胁、队伍救援容量与装备产生的状态后果。

写入状态
无。

调用函数
Probability、Threat primitives 与 energyDeviceFutureUtility。

边界与不变量
不得计算手牌或装备资产价值；energyDeviceFuture 只表示装备造成的独立未来能量状态后果。
*/
export function statePlayerValueTerms(
  state,
  player,
  viewerId,
  radarTacticProbability,
  energyRules = {}
) {
  if (!player.alive) return { death:-DEATH_VALUE, terms:{} };
  const danger = player.hp <= 1 ? -DANGER_VALUE : 0;
  let rescueOutlook = 0;
  if (player.hp <= 1) {
    const rescueCapacity = state.players
      .filter((rescuer) => rescuer.alive && rescuer.battleTeam === player.battleTeam)
      .reduce((sum, rescuer) => (
        sum + queryPlayerHandProbability(
          state.probabilityState,
          rescuer,
          "recover"
        ).expected
      ), 0);
    if (rescueCapacity > 0) {
      const requiredRecovery = Math.max(1, 1 - player.hp);
      const rescueCoverage = Math.min(1, rescueCapacity / requiredRecovery);
      rescueOutlook = (rescueCoverage - 0.5) * 8;
    }
  }
  const markThreat = Object.entries(player.huntMarkProbabilities ?? {}).reduce(
    (sum, [sourceId, probability]) => {
      const source = state.players.find((entry) => entry.id === sourceId);
      return sum + (source?.battleTeam !== player.battleTeam ? Number(probability) || 0 : 0);
    },
    0
  );
  const {
    currentThreat,
    futureInventory,
    energyPressure,
    perEnemy
  } = exposureComponents(state, player);
  const exposure = currentThreat + futureInventory + energyPressure;
  const radarMitigation = radarMitigationUtility(exposure, player, radarTacticProbability);
  const residualExposure = Math.max(0, exposure - radarMitigation);
  const shield = shieldStateValue(player, residualExposure);
  const bufferExposure = (perEnemy ?? [])
    .filter((entry) => entry.enemyId !== viewerId)
    .reduce((sum, entry) => (
      sum + entry.currentThreat + entry.futureInventory + entry.energyPressure
    ), 0);
  const bufferResidualExposure = Math.max(
    0,
    bufferExposure - radarMitigationUtility(bufferExposure, player, radarTacticProbability)
  );
  return {
    death:0,
    terms:{
      danger,
      hp2Risk:hp2ThreatRiskValue(player, bufferResidualExposure),
      rescueOutlook,
      hp:player.hp * HP_VALUE,
      shield,
      energy:Math.max(0, Number(player.energy) || 0) * ENERGY_STATE_WEIGHT,
      stacks:(player.exposeWeaknessStacks ?? 0) * 1.5,
      markThreat:-markThreat * 1.5,
      currentThreat:-currentThreat,
      futureInventory:-futureInventory,
      energyPressure:-energyPressure,
      radar:radarMitigation,
      energyDeviceFuture:energyDeviceFutureUtility(energyRules, player)
    }
  };
}
