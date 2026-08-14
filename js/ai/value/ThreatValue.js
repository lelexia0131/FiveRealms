/*
模块职责
唯一拥有目标威胁、攻击暴露、雷达减免、护盾与低生命风险的价值 primitive（供上层组合的基础数值项）。

上游
Evaluator、SearchPrior、响应策略与转移策略。

下游
DistanceSystem 与 value/Economics 的生命尺度。

状态边界
只读传入的 VisibleState/SearchState；不写状态，不启动模拟。

信息边界
只使用公开字段、概率摘要与合法的近期攻击者记忆，不读取敌方隐藏手牌身份。

架构约束
威胁公式只能在本模块出现；基础数值项可被 Evaluator 组合进 State Value，但不得绕过它独立追加到最终 Transition Value。
*/
import { DistanceSystem } from "../../core/DistanceSystem.js?build=20260814-ai-code-hygiene-final";
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260814-ai-code-hygiene-final";
import {
  PROBABILITY_EPSILON,
  clampProbability
} from "../state/Probability.js?build=20260814-ai-code-hygiene-final";
import { HP_VALUE } from "./Economics.js?build=20260814-ai-code-hygiene-final";

export const DANGER_VALUE = 7;
export const DEATH_VALUE = 28;
export const SHIELD_RESERVE_WEIGHT = 2;
export const SHIELD_PROTECTION_WEIGHT = 0.5;
export const HP_RISK_OPTION_WEIGHT = 0.05;

/*
功能
汇总指定定义在已过滤卡牌条目中的期望可用数量。

调用方
expectedAssaultResources。

输入
可见/已知卡牌数组与定义 ID。

输出
非负期望可用数量。

读取状态
availabilityStateBranches 或 availabilityBranches。

写入状态
无。

调用函数
无。

边界与不变量
缺少概率分支的合法已知条目按完整可用一张计算。
*/
const availableCardCount = (cards, definitionId) => (Array.isArray(cards) ? cards : [])
  .filter((card) => card?.definitionId === definitionId)
  .reduce((sum, card) => {
    if (Array.isArray(card.availabilityStateBranches)) {
      return sum + card.availabilityStateBranches
        .filter((branch) => branch.available)
        .reduce((total, branch) => total + (Number(branch.probability) || 0), 0);
    }
    if (Array.isArray(card.availabilityBranches)) {
      return sum + card.availabilityBranches
        .reduce((total, branch) => total + (Number(branch.probability) || 0), 0);
    }
    return sum + 1;
  }, 0);

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
availableCardCount。

边界与不变量
不会用 handCount 猜测未知牌定义；正式摘要存在时保持其概率含义。
*/
const expectedAssaultResources = (player) => {
  const known = availableCardCount(player?.hand, "assault")
    + availableCardCount(player?.knownCards, "assault");
  return Math.max(0, Number(player?.expectedAssaultCount ?? known) || 0);
};

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
export function expectedUsableAssaultsNextTurn(player) {
  const limit = nextTurnBaseAttackLimit(player);
  const extraAttackProbability = player?.activeSkillId === "breakArmy"
    ? futureSkillReadinessProbability(player)
    : 0;
  const distribution = Array.isArray(player?.assaultCountDistribution)
    ? player.assaultCountDistribution.filter((branch) => (
      Number.isFinite(Number(branch?.count)) && Number(branch?.probability) > 0
    ))
    : [];
  const total = distribution.reduce((sum, branch) => sum + Number(branch.probability), 0);
  if (total > PROBABILITY_EPSILON) {
    return distribution.reduce((sum, branch) => (
      sum + Number(branch.probability)
        * expectedUsableFromInventory(branch.count, limit, extraAttackProbability)
    ), 0) / total;
  }
  return expectedUsableFromInventory(
    expectedAssaultResources(player), limit, extraAttackProbability
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
export function assaultThreat(player) {
  const inventory = expectedAssaultResources(player);
  const usable = expectedUsableAssaultsNextTurn(player);
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
export function roleThreatSynergy(player) {
  const resources = Math.min(3, expectedUsableAssaultsNextTurn(player));
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
export function equipmentThreatSynergy(player) {
  const definition = CARD_DEFINITIONS[player?.equipmentDefinitionId];
  if (!definition?.subtypes?.includes("attack")) return 0;
  const resources = Math.min(3, expectedUsableAssaultsNextTurn(player));
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
export function turnOpportunityValue(player) {
  const hand = Math.max(0, Number(player?.handCount ?? player?.hand?.length ?? 0) || 0);
  const energy = Math.max(0, Number(player?.energy ?? 0) || 0);
  const generalResources = Math.min(2.5, hand * 0.25 + energy * 0.35);
  return 6 + generalResources + skillReadinessThreat(player) + assaultThreat(player)
    + roleThreatSynergy(player) + equipmentThreatSynergy(player);
}

export class ThreatCalculator {
  /*
  功能
  计算一个存活敌人的公开目标威胁分。

  调用方
  SearchPrior 与转移策略。

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
Evaluator、FrontierValue 与响应策略。

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
