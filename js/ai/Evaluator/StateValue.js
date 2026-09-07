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
import { canPlayCard } from "../../domain/rules/card/CardRules.js";
import { getRequiredBlockCount } from "../../domain/rules/response/ResponseRules.js";
import { getEffectiveAttackLimit } from "../../domain/rules/team/TeamRules.js";
import {
  PROBABILITY_EPSILON,
  buildRadarJudgmentProbabilities,
  buildRadarJudgmentSequenceProbabilities,
  clampProbability,
  getRangeConditionBranches,
  queryCurrentCardCounts,
  queryPlayerHandProbability,
  sealOutcomeProbabilities
} from "../Event/Probability/Probability.js";

export const HP_VALUE = 5;
export const ENERGY_STATE_WEIGHT = 1.2;

/*
功能
把内部 State Value 点数转换为最终 HP-equivalent utility。

调用方
Evaluator transition/END/diagnostics、搜索先验归一化与单位正式测试。

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
Evaluator.statePlayerValueTerms。

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
function energyDeviceFutureUtility(rules = {}, player) {
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

const DANGER_VALUE = 7;
const DEATH_VALUE = 28;
const SHIELD_RESERVE_WEIGHT = 2;
const SHIELD_PROTECTION_WEIGHT = 0.5;
export const HP3_RISK_WEIGHT = 0.2;
export const HP2_RISK_WEIGHT = 0.6;
const ACTIVE_TACTIC_DEFINITIONS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "tactic"
      && definition.usageMode !== "response")
);
const RESPONSE_TACTIC_DEFINITIONS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "tactic"
      && definition.usageMode === "response")
);
const DEVICE_ATTACK_DEFINITIONS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.subtypes?.includes("assault")
      && Number(definition.baseDamage ?? definition.perTargetDamage) > 0
      && ["singleEnemyInRange", "allEnemies"].includes(definition.targetType))
);

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
    return [{ probability: 1, energy: withoutEquipment }];
  }
  const retained = clampProbability(player?.equipmentRetentionProbability ?? 1);
  if (retained <= PROBABILITY_EPSILON) return [{ probability: 1, energy: withoutEquipment }];
  const withEquipment = Math.min(cap, current + baseGain + equipmentGain);
  if (retained >= 1 - PROBABILITY_EPSILON || withEquipment === withoutEquipment) {
    return [{ probability: 1, energy: withEquipment }];
  }
  return [
    { probability: 1 - retained, energy: withoutEquipment },
    { probability: retained, energy: withEquipment }
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
计算给定库存、基础次数、装备保留分支与一次临时额外容量概率下的期望可兑现数量。

调用方
expectedUsableAssaultsNextTurn。

输入
库存数量、基础上限、额外一次攻击概率、装备次数加成与装备保留概率。

输出
非负期望使用数量。

读取状态
无。

写入状态
无。

调用函数
clampProbability。

边界与不变量
装备存在时先扩充基础容量；破军额外容量最多兑现一张且只在库存超过对应容量时生效。
*/
const expectedUsableFromInventory = (
  inventory,
  limit,
  extraAttackProbability,
  equipmentAttackLimitBonus = 0,
  equipmentRetentionProbability = 0
) => {
  const count = Math.max(0, Number(inventory) || 0);
  const baseUses = Math.min(count, limit);
  const extraUses = Math.min(1, Math.max(0, count - limit));
  const withoutEquipment = baseUses + extraUses * extraAttackProbability;
  const equippedLimit = limit + Math.max(0, Number(equipmentAttackLimitBonus) || 0);
  const equippedBaseUses = Math.min(count, equippedLimit);
  const equippedExtraUses = Math.min(1, Math.max(0, count - equippedLimit));
  const withEquipment = equippedBaseUses + equippedExtraUses * extraAttackProbability;
  const retention = clampProbability(equipmentRetentionProbability);
  return (1 - retention) * withoutEquipment + retention * withEquipment;
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
沿用既有 3 与 0.5 尺度，不代表真实技能效果价值。
*/
export function skillReadinessThreat(player) {
  const readiness = futureSkillReadinessProbability(player);
  if (readiness <= PROBABILITY_EPSILON) return 0;
  const currentEnergy = Math.max(0, Number(player?.energy) || 0);
  const skillCost = Math.max(0, Number(player?.activeSkillCost) || 0);
  return readiness * (3 + (currentEnergy >= skillCost ? 0.5 : 0));
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
攻击次数、当前装备公开加成/保留概率、破军可用概率与突袭库存分布。

写入状态
无。

调用函数
getEffectiveAttackLimit、futureSkillReadinessProbability、expectedUsableFromInventory。

边界与不变量
装备保留世界先把公开加成叠到阵营基础次数；破军再在未来可发动的概率世界增加一次容量。
*/
export function expectedUsableAssaultsNextTurn(player, state) {
  const limit = nextTurnBaseAttackLimit(player);
  const equippedLimit = getEffectiveAttackLimit(limit, player?.equipmentDefinitionId);
  const equipmentAttackLimitBonus = equippedLimit - limit;
  const equipmentRetentionProbability = equipmentAttackLimitBonus > 0
    ? clampProbability(player?.equipmentRetentionProbability ?? 1)
    : 0;
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
      * expectedUsableFromInventory(
        branch.count,
        limit,
        extraAttackProbability,
        equipmentAttackLimitBonus,
        equipmentRetentionProbability
      )
    ), 0) / total;
  }
  return expectedUsableFromInventory(
    expectedAssaultResources(player, state),
    limit,
    extraAttackProbability,
    equipmentAttackLimitBonus,
    equipmentRetentionProbability
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
sealTeamBurden、Evaluator 搜索先验与直接价值测试。

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
计算一个存活敌人的公开目标优先级分。

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
export function targetPriorityScore(viewer, target, memory, expectedDamage = 1) {
  if (!target.alive || target.battleTeam === viewer.battleTeam) return -Infinity;
  const roleTags = target.roleTags ?? [];
  const displayTags = target.tags ?? [];
  const statuses = target.statuses ?? [];
  let score = ((target.maxHp ?? 0) - (target.hp ?? 0)) * 2.5;
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
按 Domain 卡牌目标语义计算一个攻击者对指定目标的 device-attack 机会数。

调用方
expectedBlockDemand、battleDeviceFutureUtility。

输入
canonical World、攻击者、其全部存活敌对目标与指定目标下标。

输出
会读取 source equipment Block requirement 的非负期望攻击次数。

读取状态
CardDefinitions 的 assault subtype、伤害字段与 targetType，突袭上限、finite-pool 库存及共享距离世界。

写入状态
无。

调用函数
expectedUsableAssaultsNextTurn、queryPlayerHandProbability、assaultRangeAllocation。

边界与不变量
受军火库影响的来源集合只从正式定义语义派生；单目标攻击按距离分配库存，
全体攻击对每个目标各形成一次 demand，不能在消费者中另列 assault/shockwave 名称。
*/
function expectedDeviceAttackCount(state, attacker, targets, targetIndex) {
  return DEVICE_ATTACK_DEFINITIONS.reduce((sum, definition) => {
    if (definition.targetType === "singleEnemyInRange") {
      const { assaultAllocation } = assaultRangeAllocation(
        state,
        attacker,
        targets,
        targetIndex
      );
      return sum + expectedUsableAssaultsNextTurn(attacker, state) * assaultAllocation;
    }
    if (definition.targetType === "allEnemies") {
      return sum + queryPlayerHandProbability(
        state.probabilityState,
        attacker,
        definition.definitionId
      ).expected;
    }
    return sum;
  }, 0);
}

/*
功能
汇总一名目标与单次伤害直接相关的生命、防御和危险状态价值。

调用方
expectedDamageStateLoss。

输入
目标玩家与同一 World 已计算的残余攻击暴露。

输出
可为负的防御状态点数。

读取状态
目标 alive、hp、shield 与现有危险边界。

写入状态
无。

调用函数
lowHpThreatRiskTerms、shieldStateValue。

边界与不变量
阵亡严格返回现有死亡值；不包含材料、RoleDelta 或任何攻击来源价值。
*/
function defensiveStateValue(player, residualExposure) {
  if (!player.alive) return -DEATH_VALUE;
  const { hp3Risk, hp2Risk } = lowHpThreatRiskTerms(player, residualExposure);
  return player.hp * HP_VALUE
    + (player.hp <= 1 ? -DANGER_VALUE : 0)
    + hp3Risk
    + hp2Risk
    + shieldStateValue(player, residualExposure);
}

/*
功能
计算一次未被 Block 抵消的伤害对目标当前防御状态的边际损失。

调用方
expectedDefenseCost。

输入
canonical World 与存活目标。

输出
生命、危险、护盾和互斥低血风险共同形成的非负 State points。

读取状态
目标生命/护盾、当前攻击暴露、雷达保留概率与当前判定池。

写入状态
无。

调用函数
incomingExposure、radarMitigationUtility、defensiveStateValue。

边界与不变量
只构造局部数据反事实，不修改 World；伤害先消耗护盾，否则减少一点生命，致死时使用现有死亡值。
*/
function expectedDamageStateLoss(state, target) {
  const radarTacticProbability = buildRadarJudgmentProbabilities(
    queryCurrentCardCounts(state?.probabilityState)
  ).tactic;
  const exposure = incomingExposure(state, target);
  const residualExposure = Math.max(
    0,
    exposure - radarMitigationUtility(exposure, target, radarTacticProbability)
  );
  const after = Math.max(0, Number(target.shield) || 0) > 0
    ? { ...target, shield:Math.max(0, Number(target.shield) - 1) }
    : {
        ...target,
        hp:Math.max(0, Number(target.hp) - 1),
        alive:Number(target.hp) > 1
      };
  return Math.max(
    0,
    defensiveStateValue(target, residualExposure)
      - defensiveStateValue(after, residualExposure)
  );
}

/*
功能
在确定的有效需求和雷达判定结果下计算目标的防御成本。

调用方
expectedDefenseCost。

输入
Block 数量分布、有效需求、判得的额外 Block 数、单张 Block 价值与命中伤害价值。

输出
Block 足够时扣除同次 Radar 获得量后的净手牌损失，或不足时的伤害价值期望。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
Block 不足时不会浪费手牌；雷达判得的 Block 与原手牌共同满足同一个真实需求，
其获得与同次支付必须按 before/after HandState 净额计算。
*/
function defenseCostForRequirement(
  blockDistribution,
  requiredCount,
  gainedBlockCount,
  blockSpendValue,
  damageValue
) {
  const demand = Math.max(0, Math.floor(Number(requiredCount) || 0));
  if (demand === 0) return 0;
  return blockDistribution.reduce((sum, branch) => {
    const available = Math.max(0, Number(branch.count) || 0) + gainedBlockCount;
    const realizedHandLoss = Math.max(0, demand - gainedBlockCount);
    const cost = available >= demand ? realizedHandLoss * blockSpendValue : damageValue;
    return sum + Math.max(0, Number(branch.probability) || 0) * cost;
  }, 0);
}

/*
功能
计算一个真实 Block demand 对攻击方产生的期望防御成本。

调用方
battleDeviceFutureUtility、assaultInventoryOpportunityValue 与直接 primitive 测试。

输入
canonical World、目标、Domain 给出的 requiredCount 与该目标单张 Block 的完整资源价值。

输出
目标受伤或足额支付 Block 的期望 State points。

读取状态
目标 Block finite-pool 分布、雷达装备保留、无放回逐需求判定结果与当前防御状态。

写入状态
无。

调用函数
queryPlayerHandProbability、buildRadarJudgmentSequenceProbabilities、expectedDamageStateLoss。

边界与不变量
需求数量只来自 Domain；Radar 每个 demand 使用 canonical sequence authority 独立判定，
战术结果免除对应需求、基础 Block 可参与同次防御；其它判定摸牌价值由 RadarFuture 单独拥有。
*/
export function expectedDefenseCost(state, target, requiredCount, blockSpendValue) {
  const demand = Math.max(0, Math.floor(Number(requiredCount) || 0));
  if (!target?.alive || demand === 0) return 0;
  const spendValue = Math.max(0, Number(blockSpendValue) || 0);
  const damageValue = expectedDamageStateLoss(state, target);
  const blockDistribution = queryPlayerHandProbability(
    state.probabilityState,
    target,
    "block"
  ).distribution;
  const withoutRadar = defenseCostForRequirement(
    blockDistribution,
    demand,
    0,
    spendValue,
    damageValue
  );
  const radarRetention = target.equipmentDefinitionId === "defenseDevice"
    ? clampProbability(target.equipmentRetentionProbability ?? 1)
    : 0;
  if (radarRetention <= PROBABILITY_EPSILON) return withoutRadar;
  const maximumDemand = Math.max(
    getRequiredBlockCount(null, true),
    getRequiredBlockCount("battleDevice", true)
  );
  const sequences = buildRadarJudgmentSequenceProbabilities(
    queryCurrentCardCounts(state.probabilityState),
    demand,
    maximumDemand
  );
  const withRadar = sequences.reduce((sum, branch) => {
    const outcomes = branch.outcomes ?? [];
    const waived = outcomes.filter((outcome) => outcome === "tactic").length;
    const gainedBlocks = outcomes.filter((outcome) => outcome === "basic:block").length;
    return sum + branch.probability * defenseCostForRequirement(
      blockDistribution,
      demand - waived,
      gainedBlocks,
      spendValue,
      damageValue
    );
  }, 0);
  return (1 - radarRetention) * withoutRadar + radarRetention * withRadar;
}

/*
功能
计算指定突袭库存和次数上限在当前目标防御世界中的可兑现机会价值。

调用方
assaultMagazineFutureUtility 与直接 primitive 测试。

输入
攻击者、canonical World 与按目标 ID 提供的单张 Block 实际手牌 StateValue。

输出
距离分配、Block/Radar 和目标生存状态共同形成的非负 State points。

读取状态
突袭 finite-pool 分布、有效攻击上限、共享距离条件世界与各目标防御分布。

写入状态
无。

调用函数
expectedDeviceAttackCount、expectedDefenseCost、getRequiredBlockCount。

边界与不变量
同一有限库存按共享距离世界只分配一次；本 primitive 不乘装备保留概率，
备用弹夹的保留分支已经由 expectedUsableAssaultsNextTurn 内部处理。
*/
export function assaultInventoryOpportunityValue(
  player,
  state,
  blockSpendValueByPlayerId = {}
) {
  if (!player?.alive) return 0;
  const usable = expectedUsableAssaultsNextTurn(player, state);
  if (usable <= PROBABILITY_EPSILON) return 0;
  const targets = (state.players ?? []).filter((target) => (
    target?.alive && target.id !== player.id && target.battleTeam !== player.battleTeam
  ));
  const requirement = getRequiredBlockCount(null, true);
  return targets.reduce((sum, target, targetIndex) => {
    const { assaultAllocation } = assaultRangeAllocation(
      state,
      player,
      targets,
      targetIndex
    );
    if (assaultAllocation <= PROBABILITY_EPSILON) return sum;
    return sum + usable * assaultAllocation * expectedDefenseCost(
      state,
      target,
      requirement,
      blockSpendValueByPlayerId[target.id]
    );
  }, 0);
}

/*
功能
计算军火库把真实受影响攻击从普通 Block demand 提升后的未来边际。

调用方
statePlayerValueTerms。

输入
持有者、canonical World 与按目标 ID 提供的单张 Block 实际手牌 StateValue。

输出
按装备保留概率折算的 assault/shockwave 防御成本差。

读取状态
突袭/震荡 finite-pool、共享距离、目标 Block/Radar 分布与 Domain Block demand。

写入状态
无。

调用函数
expectedUsableAssaultsNextTurn、assaultRangeAllocation、expectedDefenseCost、getRequiredBlockCount。

边界与不变量
只覆盖由正式卡牌定义派生的 device attack；不在消费者按动作名称特判，
装备保留只乘一次，目标 Radar 的额外判定摸牌收益仍由目标 RadarFuture 唯一计价。
*/
function battleDeviceFutureUtility(player, state, blockSpendValueByPlayerId = {}) {
  if (!player?.alive || player.equipmentDefinitionId !== "battleDevice") return 0;
  const retention = clampProbability(player.equipmentRetentionProbability ?? 1);
  if (retention <= PROBABILITY_EPSILON) return 0;
  const ordinaryRequirement = getRequiredBlockCount(null, true);
  const battleRequirement = getRequiredBlockCount("battleDevice", true);
  const targets = (state.players ?? []).filter((target) => (
    target?.alive && target.id !== player.id && target.battleTeam !== player.battleTeam
  ));
  const marginal = targets.reduce((sum, target, targetIndex) => {
    const attackCount = expectedDeviceAttackCount(state, player, targets, targetIndex);
    if (attackCount <= PROBABILITY_EPSILON) return sum;
    const spendValue = blockSpendValueByPlayerId[target.id];
    const ordinary = expectedDefenseCost(state, target, ordinaryRequirement, spendValue);
    const battle = expectedDefenseCost(state, target, battleRequirement, spendValue);
    return sum + attackCount * (battle - ordinary);
  }, 0);
  return retention * marginal;
}

/*
功能
判断一张当前持有的主动战术在下一次自己出牌机会中是否具备真实合法目标与状态。

调用方
expectedActiveTacticCount。

输入
canonical World、持有者与正式 CardDefinition。

输出
Domain canPlayCard 判定的布尔合法性。

读取状态
存活玩家、距离、资源区、状态与卡牌目标/使用规则。

写入状态
无。

调用函数
canPlayCard。

边界与不变量
只把未来自己出牌机会投影为 play phase；不绕过目标、状态或资源合法性，
也不把 response-only tactic 当作主动牌。
*/
function isFutureActiveTacticLegal(state, player, definition) {
  return canPlayCard({
    players:state.players ?? [],
    sourceId:player.id,
    currentPlayerId:player.id,
    phase:"play",
    card:definition,
    inHand:true,
    assaultUsage:{ used:0, limit:0 },
    recoverUsed:0,
    recoverLimit:null
  }).ok;
}

/*
功能
计算一名玩家当前已拥有或概率拥有且未来可主动使用的战术数量。

调用方
expectedRecycleTriggerCount。

输入
canonical World、玩家与是否只统计可反制战术。

输出
finite-pool/known availability 加权的非负期望数量。

读取状态
正式战术定义、Domain 合法性与玩家 Probability hand bucket。

写入状态
无。

调用函数
isFutureActiveTacticLegal、queryPlayerHandProbability。

边界与不变量
不读取敌方隐藏实体身份；每个 definition 的数量来自同一 Probability authority，
只用于期望数量加和，不创建联合隐藏世界。
*/
function expectedActiveTacticCount(state, player, counterableOnly = false) {
  return ACTIVE_TACTIC_DEFINITIONS.reduce((sum, definition) => {
    if ((counterableOnly && !definition.counterable)
      || !isFutureActiveTacticLegal(state, player, definition)) return sum;
    return sum + queryPlayerHandProbability(
      state.probabilityState,
      player,
      definition.definitionId
    ).expected;
  }, 0);
}

/*
功能
计算持有者当前响应型战术在本 global turn 的可兑现数量。

调用方
expectedRecycleTriggerCount。

输入
canonical World 与回收站持有者。

输出
响应型战术库存与其他玩家可反制主动战术机会的较小值。

读取状态
响应战术 finite-pool/known availability，以及其他存活玩家的合法主动战术机会。

写入状态
无。

调用函数
queryPlayerHandProbability、expectedActiveTacticCount。

边界与不变量
以主动战术作为响应链根，避免凭空递归 Counter-against-Counter；
不假定 handCount 全部可响应，也不读取未知 definitionId。
*/
function expectedResponseTacticCount(state, player) {
  const responseInventory = RESPONSE_TACTIC_DEFINITIONS.reduce((sum, definition) => (
    sum + queryPlayerHandProbability(
      state.probabilityState,
      player,
      definition.definitionId
    ).expected
  ), 0);
  if (responseInventory <= PROBABILITY_EPSILON) return 0;
  const counterableOpportunities = (state.players ?? []).reduce((sum, source) => {
    if (!source?.alive || source.id === player.id) return sum;
    return sum + expectedActiveTacticCount(state, source, true);
  }, 0);
  return Math.min(responseInventory, counterableOpportunities);
}

/*
功能
计算回收站在当前 global turn 尚可由已有/概率战术牌兑现的补牌次数。

调用方
recycleDeviceFutureUtility。

输入
canonical World 与装备持有者。

输出
不超过 Definition 上限剩余额度的非负期望触发次数。

读取状态
CardDefinitions 战术类别、当前 finite-pool/known availability 与 recycleDeviceUses。

写入状态
无。

调用函数
expectedActiveTacticCount、expectedResponseTacticCount。

边界与不变量
只查询当前已经拥有或概率拥有的战术牌；不把本 Future 预计摸到的新牌递归作为下一次触发来源，
也不使用 handCount 假定匿名牌全部是战术。
*/
function expectedRecycleTriggerCount(state, player) {
  const remainingUses = Math.max(
    0,
    Number(CARD_DEFINITIONS.recycleDevice.maxUsesPerTurn)
      - Math.max(0, Number(player.recycleDeviceUses) || 0)
  );
  if (remainingUses <= PROBABILITY_EPSILON) return 0;
  const expectedTactics = expectedActiveTacticCount(state, player)
    + expectedResponseTacticCount(state, player);
  return Math.min(remainingUses, expectedTactics);
}

/*
功能
计算回收站当前 global turn 尚未兑现的动态补牌 Future Utility。

调用方
statePlayerValueTerms。

输入
canonical World、持有者与 Evaluator 注入的单次摸牌完整期望价值。

输出
保留概率、剩余触发数、Definition 摸牌数与每次摸牌价值的乘积。

读取状态
装备、recycleDeviceUses、finite-pool tactic availability 与 CardDefinitions 固定规则。

写入状态
无。

调用函数
expectedRecycleTriggerCount、clampProbability。

边界与不变量
装备保留只乘一次；已由 Simulator 兑现的摸牌留在 hand state，已消耗额度从 Future 同步扣除。
*/
function recycleDeviceFutureUtility(state, player, expectedDrawGain) {
  if (!player?.alive || player.equipmentDefinitionId !== "recycleDevice") return 0;
  const retention = clampProbability(player.equipmentRetentionProbability ?? 1);
  if (retention <= PROBABILITY_EPSILON) return 0;
  return retention
    * expectedRecycleTriggerCount(state, player)
    * Math.max(0, Number(CARD_DEFINITIONS.recycleDevice.triggerDrawCount) || 0)
    * Math.max(0, Number(expectedDrawGain) || 0);
}

/*
功能
计算备用弹夹相对同一 World 无装备效果时新增的突袭库存兑现价值。

调用方
statePlayerValueTerms。

输入
canonical World、持有者与按目标 ID 提供的单张 Block 完整资源价值。

输出
with/without assaultMagazine 攻击库存机会价值的非负差。

读取状态
expectedUsableAssaultsNextTurn 内的库存、基础上限、装备保留与破军概率，以及目标防御世界。

写入状态
无。

调用函数
assaultInventoryOpportunityValue。

边界与不变量
without 反事实只移除备用弹夹效果；retention 已在 with primitive 内部处理，禁止再次相乘。
*/
function assaultMagazineFutureUtility(state, player, blockSpendValueByPlayerId = {}) {
  if (!player?.alive || player.equipmentDefinitionId !== "assaultMagazine") return 0;
  const withMagazine = assaultInventoryOpportunityValue(
    player,
    state,
    blockSpendValueByPlayerId
  );
  const withoutMagazine = assaultInventoryOpportunityValue(
    { ...player, equipmentDefinitionId:null, equipmentRetentionProbability:0 },
    state,
    blockSpendValueByPlayerId
  );
  return Math.max(0, withMagazine - withoutMagazine);
}

/*
功能
把敌方攻击暴露拆成当前威胁、未来突袭库存与能量压力。

调用方
StateValue 的 incomingExposure、statePlayerValueTerms，以及 Evaluator 的
decidePlanningGuardianAid、guardianAidValues。

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
按所有真实可格挡攻击来源估算指定玩家下一行动周期的 Block demand 数量。

调用方
radarFutureUtility 与直接价值测试。

输入
canonical World 与被评估玩家。

输出
普通突袭、震荡、焚场和猎杀产生的非负期望 Block demand。

读取状态
敌方突袭/震荡 finite-pool 分布、距离联合世界、装备保留、主动技能能量与猎印状态。

写入状态
无。

调用函数
expectedDeviceAttackCount、futureSkillReadinessProbability、getRequiredBlockCount。

边界与不变量
军火库只把 definition-derived device attack 的每次需求提升到规则 authority 给出的数量；焚场和猎杀恒用普通需求。
每类来源只按自身真实目标语义计入，不因雷达身份追加固定分数。
*/
export function expectedBlockDemand(state, player) {
  if (!player?.alive) return 0;
  let demand = 0;
  const ordinaryRequirement = getRequiredBlockCount(null, true);
  const battleRequirement = getRequiredBlockCount("battleDevice", true);
  for (const enemy of state.players ?? []) {
    if (!enemy?.alive || enemy.id === player.id || enemy.battleTeam === player.battleTeam) continue;
    const victims = state.players.filter((victim) => (
      victim?.alive && victim.id !== enemy.id && victim.battleTeam !== enemy.battleTeam
    ));
    const targetIndex = victims.findIndex((victim) => victim.id === player.id);
    if (targetIndex < 0) continue;
    const battleRetention = enemy.equipmentDefinitionId === "battleDevice"
      ? clampProbability(enemy.equipmentRetentionProbability ?? 1)
      : 0;
    const deviceAttackRequirement = ordinaryRequirement
      + battleRetention * (battleRequirement - ordinaryRequirement);
    demand += expectedDeviceAttackCount(state, enemy, victims, targetIndex)
      * deviceAttackRequirement;
    const skillReadiness = futureSkillReadinessProbability(enemy);
    if (enemy.activeSkillId === "burningField") demand += skillReadiness;
    if (enemy.activeSkillId === "hunt") {
      const markProbability = clampProbability(
        player.huntMarkProbabilities?.[enemy.id]
          ?? (player.huntMarkSourceId === enemy.id ? 1 : 0)
      );
      demand += skillReadiness * markProbability;
    }
  }
  return Math.max(0, demand);
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
function radarMitigationUtility(exposure, player, tacticJudgmentProbability) {
  if (player?.equipmentDefinitionId !== "defenseDevice") return 0;
  const retention = player.equipmentRetentionProbability ?? 1;
  return exposure * retention * tacticJudgmentProbability;
}

/*
功能
把真实 Block demand 与 canonical 判定结果转换为雷达长期功能价值。

调用方
statePlayerValueTerms。

输入
World、雷达持有者、战术判定概率，以及 Evaluator 提供的单次 Block/基础牌手牌状态价值。

输出
ExpectedBlockDemand × ExpectedUtilityPerJudgment 的非负 State points。

读取状态
装备定义/保留概率与 expectedBlockDemand 所需公开/Probability facts。

写入状态
无。

调用函数
expectedBlockDemand、clampProbability。

边界与不变量
不拥有 CardValue 或第二套概率；战术只免除一次需求，全部基础牌（含 Block）收益已按定义概率加权；
判得 Block 后是否在同一次防御中消费只由 Simulator/Response 的真实支付状态决定；
多格挡需求通过 demand 数量自然产生多次判定机会。
*/
function radarFutureUtility(
  state,
  player,
  tacticJudgmentProbability,
  radarFutureInputs
) {
  if (player?.equipmentDefinitionId !== "defenseDevice" || !radarFutureInputs) return 0;
  const retention = clampProbability(player.equipmentRetentionProbability ?? 1);
  const utilityPerJudgment = clampProbability(tacticJudgmentProbability)
      * Math.max(0, Number(radarFutureInputs.avoidedBlockDemandValue) || 0)
    + Math.max(0, Number(radarFutureInputs.expectedBasicCardGainValue) || 0);
  return retention * expectedBlockDemand(state, player) * utilityPerJudgment;
}

/*
功能
计算生命恰为三或二时共用 ThreatDamage 的互斥风险状态分项。

调用方
Evaluator 与直接价值查询。

输入
玩家与排除 viewer 自身资源联动后的残余暴露。

输出
同时包含 hp3Risk 与 hp2Risk 的对象，其中至多一项为有界负值。

读取状态
只读存活和当前生命。

写入状态
无。

调用函数
无。

边界与不变量
仅 HP=3 或 HP=2 且有威胁时生效；两项按当前生命互斥，且共用同一 ThreatDamage。
*/
function lowHpThreatRiskTerms(player, bufferResidualExposure) {
  const empty = { hp3Risk:0, hp2Risk:0 };
  if (!player?.alive || ![2, 3].includes(player.hp)) return empty;
  const threatDamage = Math.max(0, bufferResidualExposure) / HP_VALUE;
  if (threatDamage <= 1e-9) return empty;
  const risk = -Math.min(1, threatDamage) * DANGER_VALUE
    * (player.hp === 3 ? HP3_RISK_WEIGHT : HP2_RISK_WEIGHT);
  return player.hp === 3
    ? { hp3Risk:risk, hp2Risk:0 }
    : { hp3Risk:0, hp2Risk:risk };
}

/*
功能
计算一个阵营共享且不可重复消费的调息救援储备状态值。

调用方
Evaluator 的 State Value 聚合与团队 diagnostic ledger。

输入
canonical World、battleTeam、同一次 State Value 遍历已得到的逐玩家 HP2Risk Map，
以及不计入需求的 viewer ID。

输出
该阵营的非负 RescueReserve State points。

读取状态
存活成员生命、合法 ProbabilityState 调息期望容量与已计算的 HP2Risk。

写入状态
无。

调用函数
queryPlayerHandProbability、clampProbability。

边界与不变量
需求只统计 viewer 的存活队友，容量仍统计包括 viewer 在内的整个存活团队；
HP=2 威胁必须从既有 HP2Risk 恢复，禁止再次计算 exposure；
同一份团队容量最多覆盖一次总需求，超过需求的调息不继续增加本项价值。
*/
export function teamRescueReserve(
  state,
  battleTeam,
  hp2RiskByPlayer,
  demandExcludedPlayerId
) {
  const team = (state?.players ?? []).filter((player) => (
    player?.alive && player.battleTeam === battleTeam
  ));
  let demand = 0;
  for (const player of team) {
    if (player.id === demandExcludedPlayerId) continue;
    if (player.hp <= 1) {
      demand += 1;
    } else if (player.hp === 2) {
      const threat = clampProbability(
        -Math.min(0, Number(hp2RiskByPlayer?.get(player.id)) || 0)
          / (DANGER_VALUE * HP2_RISK_WEIGHT)
      );
      demand += 0.5 + 0.5 * threat;
    }
  }
  if (demand <= 0) return 0;
  const capacity = team.reduce((sum, player) => (
    sum + queryPlayerHandProbability(
      state.probabilityState,
      player,
      "recover"
    ).expected
  ), 0);
  if (capacity <= 0) return 0;
  const effectiveCapacity = Math.min(capacity, demand);
  return 8 * demand * effectiveCapacity / (demand + effectiveCapacity);
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
function shieldStateValue(player, residualExposure) {
  const shield = Math.max(0, Number(player.shield) || 0);
  if (!shield || !player?.alive) return 0;
  const reserve = SHIELD_RESERVE_WEIGHT * Math.min(shield, 1);
  const threatPoints = Math.max(0, residualExposure) / HP_VALUE;
  const absorbed = Math.min(shield, threatPoints);
  const hpProtection = absorbed * HP_VALUE;
  const lifePremium = player.hp === 1 ? DEATH_VALUE - HP_VALUE
    : player.hp === 2 ? DANGER_VALUE - HP_VALUE
      : 0;
  const lifeProtection = Math.min(1, absorbed) * lifePremium * SHIELD_PROTECTION_WEIGHT;
  return reserve + hpProtection + lifeProtection;
}

/*
功能
计算泡泡机尚未兑现的下一次自己回合第一层普通护盾状态价值。

调用方
statePlayerValueTerms。

输入
玩家与已扣除雷达减免的残余暴露。

输出
按现有装备保留概率折算的非负未来状态点数。

读取状态
只读玩家存活、装备、当前护盾与 equipmentRetentionProbability。

写入状态
无。

调用函数
shieldStateValue、clampProbability。

边界与不变量
当前已有护盾时恒为零；只比较同一快照的 ShieldValue(1)-ShieldValue(0)，
不复制护盾公式、不加入静态装备价值，也不预测触发前的攻击或护盾消耗。
*/
function bubbleMachineFutureUtility(player, residualExposure) {
  if (!player?.alive
    || player.equipmentDefinitionId !== "bubbleMachine"
    || Number(player.shield) !== 0) return 0;
  const retention = clampProbability(player.equipmentRetentionProbability ?? 1);
  if (retention <= PROBABILITY_EPSILON) return 0;
  const nextShield = CARD_DEFINITIONS.bubbleMachine.turnShieldGain;
  const futureShieldValue = shieldStateValue({ ...player, shield: nextShield }, residualExposure);
  const currentShieldValue = shieldStateValue(player, residualExposure);
  return retention * Math.max(0, futureShieldValue - currentShieldValue);
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
过滤 World、玩家、viewer ID、雷达战术概率、稳定能量规则 capability，
以及 Evaluator 注入的装备资源价值输入。

输出
death 与不含 hand/equipment intrinsic asset 的 terms。

读取状态
生命、生存、能量、护盾、状态、威胁与装备产生的状态后果。

写入状态
无。

调用函数
Probability、Threat primitives 与各装备 Future Utility。

边界与不变量
不得拥有手牌或装备资产公式；雷达只消费 Evaluator 已计算的实际手牌状态值与 canonical Probability；
Final StateValue 不包含技能 readiness，也不得恢复按当前能量线性计分；
所有装备 Future 只表示尚未兑现的独立未来状态后果；普通手牌 Base material 不属于 StateValue，
HandCount 与合法 HandRoleDelta 通过 Evaluator 的唯一 primitive 计入 Future。
*/
export function statePlayerValueTerms(
  state,
  player,
  viewerId,
  radarTacticProbability,
  energyRules = {},
  equipmentFutureInputs = null
) {
  if (!player.alive) return { death: -DEATH_VALUE, terms: {} };
  const danger = player.hp <= 1 ? -DANGER_VALUE : 0;
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
  const lowHpRisk = lowHpThreatRiskTerms(player, bufferResidualExposure);
  return {
    death: 0,
    terms: {
      danger,
      ...lowHpRisk,
      hp: player.hp * HP_VALUE,
      shield,
      bubbleMachineFuture: bubbleMachineFutureUtility(player, residualExposure),
      battleDeviceFuture: battleDeviceFutureUtility(
        player,
        state,
        equipmentFutureInputs?.blockSpendValueByPlayerId
      ),
      recycleDeviceFuture: recycleDeviceFutureUtility(
        state,
        player,
        equipmentFutureInputs?.expectedDrawGain
      ),
      assaultMagazineFuture: assaultMagazineFutureUtility(
        state,
        player,
        equipmentFutureInputs?.blockSpendValueByPlayerId
      ),
      stacks: (player.exposeWeaknessStacks ?? 0) * 3,
      markThreat: -markThreat * 2,
      residualExposureValue: -residualExposure,
      radarFuture: radarFutureUtility(
        state,
        player,
        radarTacticProbability,
        equipmentFutureInputs?.radar
      ),
      energyDeviceFuture: energyDeviceFutureUtility(energyRules, player)
    }
  };
}
