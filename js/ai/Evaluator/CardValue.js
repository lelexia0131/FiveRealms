/*
模块职责
唯一拥有 card/resource Evaluator Value primitives，包括静态值、角色差量、保留折损、弃置、获得与匿名期望。

上游
Evaluator public facade 与直接 primitive 契约测试。

下游
稳定卡牌和角色配置。

状态边界
只读传入的卡牌、角色与可见状态字段；不写任何状态。

信息边界
只使用公开配置、自己卡牌、合法记忆、过滤后的 known identity 或聚合 finite-pool counts。

架构约束
不得选择最终候选、导入 Evaluator/Simulator 或执行资源 transition；静态值不得直接成为最终 Transition Value。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { calculateHealAmount } from "../../domain/rules/combat/CombatRules.js";
import { cardAvailability } from "../Event/Probability/Probability.js";

// BaseAiValue 与 RoleDelta 共同表达静态卡牌资产时，只能由本常量统一换算为 State points。
export const RESOURCE_MATERIAL_SCALE = 0.4;
// 没有有效 finite-pool 信息时，匿名牌基础价值只能回退到本期望。
export const UNKNOWN_HAND_EXPECTED_VALUE = 5.8;
export const HAND_COUNT_VALUE = 1.1;
const RESPONSE_SURVIVAL_BONUS_DANGER = 1;
const RESPONSE_SURVIVAL_BONUS_LETHAL = 2;
// 该值只表示资源选择中的技能门槛策略选择权，不是概率、State/Final Utility 或单位换算。
const SKILL_THRESHOLD_POLICY_BONUS = 4;

export const CARD_AI_VALUES = Object.freeze({
  assault: 4,
  recover: 6,
  block: 5,
  charge: 5,
  shield: 7,
  scout: 5,
  transfer: 7,
  exposeWeakness: 6,
  shockwave: 8,
  provoke: 8,
  leverage: 7,
  plunder: 7,
  destroy: 6,
  counter: 8,
  harvest: 8,
  duel: 6,
  mutualBenefit: 6,
  symbiosis: 5,
  seal: 7,
  lightning: 3,
  energyDevice: 7,
  recycleDevice: 8,
  bubbleMachine: 7,
  defenseDevice: 9,
  battleDevice: 9,
  assaultMagazine: 8,
  telescope: 8,
  barrierDevice: 9
});

/*
角色 × 卡牌差值只记录非零项，未配置组合自动回退零；新角色和新卡牌不需要补完整矩阵。
新增角色条目必须同时冻结嵌套差值对象，避免运行期改写静态价值。
*/
export const ROLE_CARD_VALUE_DELTAS = Object.freeze({
  "blade-walker": Object.freeze({
    assault: 2,
    block: -1,
    charge: -1,
    scout: 1,
    exposeWeakness: 1,
    shockwave: 1,
    provoke: 1,
    leverage: 1,
    plunder: 1,
    destroy: 1,
    duel: -1,
    symbiosis: -1,
    energyDevice: -1,
    defenseDevice: -1,
    battleDevice: 2,
    assaultMagazine: 2,
    telescope: 1,
    barrierDevice: -1
  }),

  "oath-warden": Object.freeze({
    assault: -1,
    recover: 1,
    block: 1,
    shield: 1,
    transfer: 1,
    exposeWeakness: -1,
    shockwave: -1,
    provoke: -1,
    plunder: 1,
    counter: 1,
    harvest: 1,
    duel: -1,
    mutualBenefit: -1,
    symbiosis: 1,
    recycleDevice: -1,
    bubbleMachine: 2,
    defenseDevice: 1,
    battleDevice: -1,
    assaultMagazine: -1,
    telescope: -1,
    barrierDevice: 1
  }),

  "spirit-medic": Object.freeze({
    assault: -1,
    recover: 2,
    block: 1,
    charge: 2,
    shield: 1,
    transfer: 1,
    exposeWeakness: -1,
    shockwave: -1,
    provoke: -1,
    plunder: -1,
    counter: 1,
    harvest: 1,
    duel: -1,
    symbiosis: 2,
    energyDevice: 1,
    recycleDevice: -1,
    bubbleMachine: -1,
    defenseDevice: 1,
    battleDevice: -1,
    assaultMagazine: -1,
    telescope: -1,
    barrierDevice: 1
  }),

  "shade-agent": Object.freeze({
    recover: 1,
    block: 1,
    charge: 2,
    scout: -1,
    exposeWeakness: 1,
    destroy: -1,
    duel: 1,
    seal: -1,
    energyDevice: 1,
    bubbleMachine: 1,
    battleDevice: 1,
    telescope: 1
  }),

  "ember-magus": Object.freeze({
    recover: 1,
    block: 1,
    charge: 1,
    scout: -2,
    transfer: -1,
    shockwave: 1,
    provoke: 1,
    counter: -1,
    symbiosis: -1,
    seal: 1,
    energyDevice: 1,
    recycleDevice: 1,
    assaultMagazine: 1
  }),

  "trail-hunter": Object.freeze({
    assault: 2,
    block: -1,
    charge: 1,
    scout: -1,
    exposeWeakness: 1,
    leverage: 1,
    plunder: 1,
    destroy: 1,
    counter: -1,
    symbiosis: -1,
    seal: 1,
    energyDevice: 1,
    recycleDevice: -1,
    defenseDevice: -1,
    battleDevice: 1,
    assaultMagazine: 2,
    telescope: 1,
    barrierDevice: -1
  }),

  "fate-gambler": Object.freeze({
    assault: 1,
    block: -1,
    charge: 1,
    transfer: -1,
    exposeWeakness: 1,
    shockwave: 1,
    provoke: 1,
    plunder: 1,
    counter: -1,
    harvest: 1,
    duel: 1,
    mutualBenefit: 1,
    symbiosis: -1,
    energyDevice: 1,
    recycleDevice: 1,
    defenseDevice: -1,
    battleDevice: 1,
    assaultMagazine: 1,
    barrierDevice: -1
  }),

  "resonance-tuner": Object.freeze({
    assault: -1,
    block: 1,
    charge: 2,
    shield: 1,
    scout: 1,
    transfer: 2,
    exposeWeakness: -1,
    leverage: 2,
    plunder: 2,
    destroy: 1,
    counter: 2,
    harvest: 1,
    duel: -1,
    mutualBenefit: 2,
    symbiosis: 1,
    seal: -1,
    recycleDevice: 1,
    bubbleMachine: 1,
    defenseDevice: 1,
    battleDevice: -1,
    telescope: 1,
    barrierDevice: 1
  })
});

/*
功能
读取卡牌定义中的全局静态基础价值。

调用方
弃牌、资源选择、搜索先验与直接价值查询入口。

输入
卡牌定义 ID 与可选的测试定义表。

输出
有限数值；未知或无合法价值的定义抛出异常。

读取状态
只读稳定卡牌配置。

写入状态
无。

调用函数
无。

边界与不变量
静态卡牌价值只服务保留、策略与搜索先验，不直接成为最终 transition value。
*/
export function getBaseCardAiValue(definitionId, cardDefinitions = CARD_DEFINITIONS) {
  const definition = cardDefinitions[definitionId];
  const value = CARD_AI_VALUES[definitionId];
  if (!definition || !Number.isFinite(value)) {
    throw new Error(`getBaseCardAiValue 未知卡牌 ID：${definitionId}`);
  }
  return value;
}

/*
功能
以全局基础值加稀疏角色差量计算角色卡牌价值。

调用方
卡片保留、资源选择、搜索先验与状态身份差量。

输入
角色 ID、卡牌定义 ID 与可选测试配置。

输出
角色有效静态价值；未知 ID 或非法差量抛出异常。

读取状态
只读稳定角色与卡牌配置。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
未配置组合回退零差量；差量必须为 -2..2 的整数，且结果不直接进入最终 transition value。
*/
export function getRoleCardAiValue(characterId, definitionId, options = {}) {
  const {
    cardDefinitions = CARD_DEFINITIONS,
    characterDefinitions,
    deltas = ROLE_CARD_VALUE_DELTAS
  } = options ?? {};
  const knownCharacter = characterDefinitions === undefined
    ? Object.hasOwn(CHARACTER_BY_ID, characterId)
    : Array.isArray(characterDefinitions) && characterDefinitions.some((character) => character?.id === characterId);
  if (!knownCharacter) {
    throw new Error(`getRoleCardAiValue 未知角色 ID：${characterId}`);
  }
  const base = getBaseCardAiValue(definitionId, cardDefinitions);
  const roleDeltas = deltas?.[characterId];
  const hasExplicitDelta = roleDeltas !== null && typeof roleDeltas === "object"
    && Object.hasOwn(roleDeltas, definitionId);
  if (!hasExplicitDelta) return base;
  const delta = roleDeltas[definitionId];
  if (!Number.isInteger(delta) || delta < -2 || delta > 2) {
    throw new Error(
      `getRoleCardAiValue 非法差值：角色 ${characterId}，卡牌 ${definitionId}，差值 ${String(delta)}`
    );
  }
  return base + delta;
}

/*
功能
计算一张已知牌对指定持有者的转移资源价值。

调用方
Evaluator 的转移候选评估。

输入
卡牌定义 ID 与过滤后的玩家公开状态。

输出
基础/角色价值叠加当前生命、能量、护盾与攻击额度后的资源值。

读取状态
稳定 Card/Skill Definitions 与玩家公开资源字段。

写入状态
无。

调用函数
getRoleCardAiValue、getBaseCardAiValue。

边界与不变量
本值只描述单张资源对一个持有者的局部用途，不解释双方关系、转移门槛或最终候选胜者。
*/
export function getTransferCardValue(definitionId, player) {
  const base = player?.characterId
    ? getRoleCardAiValue(player.characterId, definitionId)
    : getBaseCardAiValue(definitionId);
  const hp = Number(player?.hp ?? player?.maxHp ?? 0);
  const maxHp = Number(player?.maxHp ?? hp);
  const shield = Number(player?.shield ?? 0);
  const missingHp = Math.max(0, maxHp - hp);
  let value = base;
  if (definitionId === "recover") {
    if (hp >= maxHp) value -= 2;
    if (hp <= 2) value += 7;
    value += Math.min(2, missingHp);
  } else if (definitionId === "block") {
    if (hp <= 2) value += 6;
  } else if (definitionId === "charge") {
    const missingEnergy = Math.max(
      0,
      Number(player?.maxEnergy ?? player?.energy ?? 0) - Number(player?.energy ?? 0)
    );
    value += Math.min(2, missingEnergy);
    const activeSkillId = player?.activeSkillId
      ?? player?.character?.activeSkillIds?.[0]
      ?? null;
    const activeSkill = ACTIVE_SKILL_DEFINITIONS[activeSkillId] ?? null;
    const activeSkillCost = Number(player?.activeSkillCost ?? activeSkill?.cost ?? 0);
    const activeSkillUses = Number(
      player?.activeSkillUses
      ?? player?.turnFlags?.activeSkillUseCounts?.[activeSkillId]
      ?? 0
    );
    const activeSkillLimit = Number(player?.activeSkillLimit ?? activeSkill?.limitPerTurn ?? 0);
    if (activeSkillId && activeSkillLimit > 0 && activeSkillUses < activeSkillLimit
      && activeSkillCost > 0 && Number(player?.energy ?? 0) + 1 >= activeSkillCost) {
      value += 2;
    }
  } else if (definitionId === "shield") {
    if (hp <= 2) value += 3;
    if (shield >= 2) value -= 2;
  } else if (definitionId === "assault") {
    const attackLimit = Number(player?.attackLimit ?? player?.turnFlags?.attackLimit ?? 0);
    const attackUsed = Number(player?.attackUsed ?? player?.turnFlags?.attackUsed ?? 0);
    if (attackLimit > 0 && attackUsed < attackLimit) value += 1;
  }
  return value;
}

/*
功能
计算一个匿名手牌槽对指定持有者的剩余池加权转移价值。

调用方
Evaluator 的匿名转移候选评估。

输入
过滤后的玩家公开状态与可选 remaining-card counts。

输出
有效剩余池的加权单卡值；缺少有效计数时返回 canonical 未知手牌基础期望。

读取状态
只读聚合 finite-pool counts 与单卡转移资源值。

写入状态
无。

调用函数
getTransferCardValue。

边界与不变量
匿名值不绑定 card ID 或 definition identity，不得读取真实隐藏牌面。
*/
export function getUnknownTransferCardValue(player, remainingCardCounts = null) {
  if (remainingCardCounts !== null
    && typeof remainingCardCounts === "object"
    && !Array.isArray(remainingCardCounts)) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      weightedSum += count * getTransferCardValue(definitionId, player);
      totalWeight += count;
    }
    if (totalWeight > 0) return weightedSum / totalWeight;
  }
  return UNKNOWN_HAND_EXPECTED_VALUE;
}

/*
功能
计算已有装备对新装备卡未来保留价值造成的边际折损。

调用方
弃牌、资源选择与搜索先验。

输入
角色、新旧装备定义、旧装备保留概率与可选测试配置。

输出
非负边际折损；没有旧装备时返回零。

读取状态
只读稳定卡牌和角色价值配置。

写入状态
无。

调用函数
getRoleCardAiValue。

边界与不变量
只表达 replacement/redundancy 边际，不重复授予完整装备价值。
*/
export function getEquipmentKeepValueDeduction(
  characterId,
  newDefinitionId,
  equippedDefinitionId,
  retention = 1,
  options = {}
) {
  if (!equippedDefinitionId) return 0;
  const cardDefinitions = options.cardDefinitions ?? CARD_DEFINITIONS;
  const oldValue = characterId
    ? getRoleCardAiValue(characterId, equippedDefinitionId, options)
    : getBaseCardAiValue(equippedDefinitionId, cardDefinitions);
  const deduction = oldValue * Math.max(0, Number(retention) || 0);
  return equippedDefinitionId === newDefinitionId ? deduction + 4 : deduction;
}

/*
功能
计算角色卡牌价值相对全局基础值的身份差量。

调用方
Evaluator、Evaluator search prior 与正式边界。

输入
角色 ID 与卡牌定义 ID。

输出
身份差量；缺少任一 ID 时返回零。

读取状态
只读稳定卡牌与角色配置。

写入状态
无。

调用函数
getRoleCardAiValue、getBaseCardAiValue。

边界与不变量
只返回相对差量，不能被当作完整静态价值再次计分。
*/
export function roleCardDelta(characterId, definitionId) {
  if (!characterId || !definitionId) return 0;
  return getRoleCardAiValue(characterId, definitionId) - getBaseCardAiValue(definitionId);
}

/*
功能
计算一张普通手牌实际进入或离开当前 StateValue 时的存量价值。

调用方
cardPlayerValueTerms、Evaluator 的装备 Future 资源输入与直接公式测试。

输入
手牌持有者、StateValue viewer ID，以及可选的合法已知 definition ID。

输出
一张牌对应的 HandCount 与可见 HandRoleDelta 之和；匿名牌只返回 HandCount。

读取状态
持有者公开身份与 viewer 对该手牌身份的合法可见性。

写入状态
无。

调用函数
roleCardDelta。

边界与不变量
普通手牌不持有 BaseAiValue 材料项；只有 viewer 自己的合法已知身份可产生未缩放的 RoleDelta。
*/
export function realizedHandCardStateValue(player, viewerId, definitionId = null) {
  const visibleRoleDelta = definitionId && player?.id === viewerId
    ? roleCardDelta(player.characterId, definitionId)
    : 0;
  return HAND_COUNT_VALUE + visibleRoleDelta;
}

/*
功能
把一张具体牌对指定持有者的静态角色价值换算为 State points 资产价值。

调用方
Evaluator 的装备与明确静态资源资产路径，以及直接公式测试。

输入
可选角色 ID、卡牌 definition ID 与仅供现有 CardValue 测试注入的定义/差量配置。

输出
`(BaseAiValue + RoleDelta) × RESOURCE_MATERIAL_SCALE` 的有限 State points。

读取状态
稳定 CardDefinitions、RoleCardValue delta 与唯一材料尺度。

写入状态
无。

调用函数
getRoleCardAiValue、getBaseCardAiValue。

边界与不变量
只用于静态 card/resource asset；HandRoleDelta、Discard、Transfer、Search Prior 与动态装备 Future 不消费本函数。
*/
export function staticCardAssetValue(characterId, definitionId, options = {}) {
  const roleValue = characterId
    ? getRoleCardAiValue(characterId, definitionId, options)
    : getBaseCardAiValue(definitionId, options.cardDefinitions ?? CARD_DEFINITIONS);
  return roleValue * RESOURCE_MATERIAL_SCALE;
}

/*
功能
计算单张手牌在自主弃牌场景下的保留价值。

调用方
Evaluator 的 discard candidate 比较。

输入
资源拥有者、合法候选卡和距离/装备上下文。

输出
数值保留价值；越低越应优先弃置。

读取状态
只读玩家公开资源、卡牌定义与角色卡牌价值。

写入状态
无。

调用函数
getRoleCardAiValue、getEquipmentKeepValueDeduction。

边界与不变量
只拥有单卡 valuation，不决定候选胜负；数值和角色差量保持冻结。
*/
export function getDiscardKeepValue(player, card, context = {}) {
  const definition = CARD_DEFINITIONS[card?.definitionId] ?? {};
  const category = card?.category ?? definition.category;
  const usageMode = card?.usageMode ?? definition.usageMode;
  let score = getRoleCardAiValue(player?.characterId, card.definitionId);
  if (category === "equipment") {
    score -= getEquipmentKeepValueDeduction(
      player?.characterId,
      card.definitionId,
      context.equippedDefinitionId ?? null,
      context.equipmentRetentionProbability ?? 1
    );
  }
  if ((player?.hp ?? 0) <= 2 && usageMode === "response") {
    score += (player?.hp ?? 0) <= 1
      ? RESPONSE_SURVIVAL_BONUS_LETHAL
      : RESPONSE_SURVIVAL_BONUS_DANGER;
  }
  if (context.stranded && card.definitionId === "assault") score += 5;
  if ((player?.hp ?? 0) >= (player?.maxHp ?? 0) && card.definitionId === "recover") score -= 2;
  if ((player?.hp ?? 0) <= 2 && card.definitionId === "recover") score += 7;
  if ((player?.hp ?? 0) <= 2 && card.definitionId === "block") score += 6;
  if (card.definitionId === "symbiosis") score -= 5;
  return score;
}

/*
功能
计算一张合法已知资源在破坏或掠夺中的卡牌材料价值。

调用方
Evaluator 的资源候选估值。

输入
用途、行动者、资源拥有者与合法已知 definitionId。

输出
冻结的资源 primitive value。

读取状态
双方角色与阵营公开字段。

写入状态
无。

调用函数
getRoleCardAiValue。

边界与不变量
只接受 destroy/plunder；不比较候选、不决定区域或实体。
*/
export function getResourceDefinitionUtility(purpose, actor, owner, definitionId) {
  if (purpose === "destroy") {
    return getRoleCardAiValue(owner.characterId, definitionId);
  }
  if (purpose === "plunder") {
    const actorValue = getRoleCardAiValue(actor.characterId, definitionId);
    const ownerValue = getRoleCardAiValue(owner.characterId, definitionId);
    return owner.battleTeam === actor.battleTeam
      ? actorValue - ownerValue
      : actorValue + ownerValue;
  }
  throw new Error(`getResourceDefinitionUtility 非法 purpose：${String(purpose)}`);
}

/*
功能
计算匿名手牌资源在破坏或掠夺中的 Probability 期望价值。

调用方
Evaluator 的资源候选估值。

输入
用途、双方公开身份和可选 remaining counts。

输出
动态加权期望；无有效计数时返回冻结固定期望。

读取状态
只读 remaining-card counts。

写入状态
无。

调用函数
getResourceDefinitionUtility。

边界与不变量
不接收未知实体 definitionId；unknown 始终保持聚合表示。
*/
export function getResourceUnknownUtility(
  purpose,
  actor,
  owner,
  remainingCardCounts = null
) {
  if (remainingCardCounts !== null && typeof remainingCardCounts === "object") {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      const utility = getResourceDefinitionUtility(purpose, actor, owner, definitionId);
      weightedSum += count * utility;
      totalWeight += count;
    }
    if (totalWeight > 0) return weightedSum / totalWeight;
  }
  if (purpose === "destroy") return UNKNOWN_HAND_EXPECTED_VALUE;
  if (purpose === "plunder") {
    return owner.battleTeam === actor.battleTeam ? 0 : UNKNOWN_HAND_EXPECTED_VALUE * 2;
  }
  throw new Error(`getResourceUnknownUtility 非法 purpose：${String(purpose)}`);
}

/*
功能
计算接收方获得一张匿名牌的基础材料期望。

调用方
Evaluator 的 plunder candidate 估值。

输入
remaining-card counts；允许为 null。

输出
基础 CardValue 加权期望；无有效计数时返回冻结未知期望。

读取状态
只读 remaining counts 与基础卡值。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
只计算匿名材料 primitive，不绑定或展开隐藏实体身份。
*/
export function getUnknownAcquisitionUtility(remainingCardCounts = null) {
  if (remainingCardCounts !== null && typeof remainingCardCounts === "object") {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      weightedSum += count * getBaseCardAiValue(definitionId);
      totalWeight += count;
    }
    if (totalWeight > 0) return weightedSum / totalWeight;
  }
  return UNKNOWN_HAND_EXPECTED_VALUE;
}

/*
功能
计算移除充能桩时原持有者失去的下一回合技能门槛策略价值。

调用方
Evaluator 的 equipment resource candidate 估值。

输入
资源行动者、原持有者与公开装备 definitionId。

输出
行动者视角的资源 primitive value；敌方损失为正，同阵营损失为负。

读取状态
公开能量、回合能量增益和主动技能门槛摘要。

写入状态
无。

调用函数
无。

边界与不变量
保持冻结的四点门槛选择权；该值不是概率、State Utility 或 Final Utility。
*/
export function skillThresholdOptionPolicyValue(actor, owner, equipmentDefinitionId) {
  if (equipmentDefinitionId !== "energyDevice" || !owner?.activeSkillId) return 0;
  const skillCost = Math.max(0, Number(owner.activeSkillCost) || 0);
  const skillLimit = Math.max(0, Number(owner.activeSkillLimit) || 0);
  if (skillCost <= 0 || skillLimit <= 0) return 0;
  const cap = Math.max(0, Number(owner.maxEnergy) || 0);
  const currentEnergy = Math.max(0, Number(owner.energy) || 0);
  const withoutGain = Math.max(0, Number(owner.turnEnergyGainWithoutEquipment) || 0);
  const equipmentGain = Math.max(0, Number(owner.energyDeviceTurnEnergyGain) || 0);
  const withoutEnergy = Math.min(cap, currentEnergy + withoutGain);
  const withEnergy = Math.min(cap, withoutEnergy + equipmentGain);
  const withoutAffordableUses = Math.min(skillLimit, Math.floor(withoutEnergy / skillCost));
  const withAffordableUses = Math.min(skillLimit, Math.floor(withEnergy / skillCost));
  const localValue = Math.max(0, withAffordableUses - withoutAffordableUses)
    * SKILL_THRESHOLD_POLICY_BONUS;
  return owner.battleTeam === actor?.battleTeam ? -localValue : localValue;
}

/*
功能
生成单个玩家的卡牌、装备与资源资产价值分项。

调用方
Evaluator.playerValueTerms。

输入
过滤后的玩家与 viewer ID。

输出
只包含 hand/equipment asset terms 的普通对象。

读取状态
玩家公开手牌数量、viewer 的合法 hand/knownCards 身份与公开装备摘要。

写入状态
无。

调用函数
getBaseCardAiValue、roleCardDelta、realizedHandCardStateValue、cardAvailability。

边界与不变量
装备 Base 与 RoleDelta 同属 static asset，分别在这里乘 RESOURCE_MATERIAL_SCALE 恰好一次。
临时以 non-root recipient 作为 viewer 时，只消费其公开确定的 knownCards，不补全或读取未知手牌。
距离、雷达、能量收益等装备后果由 StateValue 另行计算。
*/
export function cardPlayerValueTerms(player, viewerId) {
  const equipmentValue = player.equipmentDefinitionId
    ? getBaseCardAiValue(player.equipmentDefinitionId)
    : 0;
  const retention = player.equipmentRetentionProbability ?? (equipmentValue ? 1 : 0);
  const currentEquipmentRoleDelta = player.equipmentDefinitionId
    ? roleCardDelta(player.characterId, player.equipmentDefinitionId)
    : 0;
  const handRoleDelta = player.id === viewerId
    ? (player.hand ?? player.knownCards ?? []).reduce((sum, card) => (
        sum + (
          realizedHandCardStateValue(player, viewerId, card?.definitionId)
            - HAND_COUNT_VALUE
        ) * cardAvailability(card)
      ), 0)
    : 0;
  return {
    handCount:player.handCount * HAND_COUNT_VALUE,
    handRoleDelta,
    equipmentDelta:equipmentValue * retention * RESOURCE_MATERIAL_SCALE,
    equipmentRoleDelta:currentEquipmentRoleDelta * retention * RESOURCE_MATERIAL_SCALE
  };
}

/*
功能
从指定阵营视角计算共生的盟友、敌方与团队净治疗。

调用方
Evaluator response willingness、Evaluator search prior、Simulation 与 Controller 组合根。

输入
过滤玩家、观察阵营与卡牌定义。

输出
非共生返回 null，否则返回团队计数与受益摘要。

读取状态
玩家公开生命字段与共生治疗量规则。

写入状态
无。

调用函数
calculateHealAmount。

边界与不变量
团队净值等于盟友实际治疗量减敌方实际治疗量。
*/
export function assessGlobalBenefit(
  players,
  battleTeam,
  definitionId
) {
  if (definitionId !== "symbiosis") return null;
  const result = {
    allyAliveCount:0,
    enemyAliveCount:0,
    allyBenefit:0,
    enemyBenefit:0,
    netBenefit:0
  };
  for (const player of (players ?? []).filter((entry) => entry?.alive)) {
    const benefit = calculateHealAmount(
      CARD_DEFINITIONS.symbiosis.healAmount,
      player.maxHp ?? 0,
      player.hp ?? 0
    );
    if (player.battleTeam === battleTeam) {
      result.allyAliveCount += 1;
      result.allyBenefit += benefit;
    } else {
      result.enemyAliveCount += 1;
      result.enemyBenefit += benefit;
    }
  }
  result.netBenefit = result.allyBenefit - result.enemyBenefit;
  return result;
}
