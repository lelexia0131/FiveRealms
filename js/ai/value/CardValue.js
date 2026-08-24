/*
模块职责
唯一拥有 card/resource Policy Value primitives，包括静态值、角色差量、保留折损、弃置、获得与匿名期望。

上游
Evaluator、State Value 与 Search Prior。

下游
稳定卡牌和角色配置。

状态边界
只读传入的卡牌、角色与可见状态字段；不写任何状态。

信息边界
只使用公开配置、自己卡牌、合法记忆、过滤后的 known identity 或聚合 Belief counts。

架构约束
不得选择最终候选、导入 Evaluator/Simulator 或执行资源 transition；静态值不得直接成为最终 Transition Value。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { CHARACTER_BY_ID, CHARACTER_DEFINITIONS } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { HP_VALUE } from "./Economics.js";

export const UNKNOWN_HAND_EXPECTED_VALUE = 4;
export const RESPONSE_SURVIVAL_BONUS_DANGER = 1;
export const RESPONSE_SURVIVAL_BONUS_LETHAL = 2;
// 该值只表示资源选择中的技能门槛策略选择权，不是概率、State/Final Utility 或单位换算。
export const SKILL_THRESHOLD_POLICY_BONUS = 4;

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
  defenseDevice: 9,
  battleDevice: 9,
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
    defenseDevice: 1,
    battleDevice: -1,
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
    defenseDevice: 1,
    battleDevice: -1,
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
    recycleDevice: 1
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
  const value = definition?.aiValue ?? (cardDefinitions === CARD_DEFINITIONS
    ? CARD_AI_VALUES[definitionId]
    : undefined);
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
有效剩余池的加权单卡值；缺少有效计数时返回 canonical 固定期望四。

读取状态
只读聚合 Belief counts 与单卡转移资源值。

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
校验稀疏角色卡牌差量表的引用和值域。

调用方
启动期配置检查与测试。

输入
待校验差量表及可选角色、卡牌配置。

输出
错误信息数组；空数组表示合法。

读取状态
只读稳定角色与卡牌配置。

写入状态
无。

调用函数
无。

边界与不变量
空表合法；未知引用和超出 -2..2 的非整数差量必须报告。
*/
export function validateRoleCardValueDeltas(deltas = ROLE_CARD_VALUE_DELTAS, options = {}) {
  const {
    cardDefinitions = CARD_DEFINITIONS,
    characterDefinitions = CHARACTER_DEFINITIONS
  } = options ?? {};
  if (deltas === null || typeof deltas !== "object" || Array.isArray(deltas)) {
    return ["角色差值表必须是对象"];
  }
  const characterIds = new Set(
    Array.isArray(characterDefinitions) ? characterDefinitions.map((character) => character?.id) : []
  );
  const errors = [];
  for (const [characterId, roleDeltas] of Object.entries(deltas)) {
    if (!characterIds.has(characterId)) {
      errors.push(`未知角色 ID：${characterId}`);
      continue;
    }
    if (roleDeltas === null || typeof roleDeltas !== "object" || Array.isArray(roleDeltas)) {
      errors.push(`角色 ${characterId} 的差值必须是对象`);
      continue;
    }
    for (const [definitionId, delta] of Object.entries(roleDeltas)) {
      if (!Object.hasOwn(cardDefinitions, definitionId)) {
        errors.push(`未知卡牌 ID：${definitionId}（角色 ${characterId}）`);
        continue;
      }
      if (!Number.isInteger(delta)) {
        errors.push(`卡牌 ${definitionId}（角色 ${characterId}）的差值必须是有限整数，实际：${String(delta)}`);
        continue;
      }
      if (delta < -2 || delta > 2) {
        errors.push(`卡牌 ${definitionId}（角色 ${characterId}）的差值超出 -2..+2：${delta}`);
      }
    }
  }
  return errors;
}

/*
功能
计算角色卡牌价值相对全局基础值的身份差量。

调用方
Evaluator、SearchPrior 与正式边界。

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
读取具体可见卡牌条目的剩余可用概率。

调用方
Evaluator、FrontierValue 与正式边界。

输入
可见卡牌或概率卡牌条目。

输出
零到一语义的现有概率总和；无分支时返回一。

读取状态
只读卡牌当前 availability 标量。

写入状态
无。

调用函数
无。

边界与不变量
不得读取未过滤的敌方手牌身份，也不得重建 availability branch hierarchy。
*/
export function cardAvailability(card) {
  return Math.max(0, Math.min(1, Number(card?.availability ?? 1) || 0));
}

/*
功能
把打出一张牌的现有机会成本拆成互斥的诊断分量。

调用方
Value ownership 诊断、测试与正式边界。

输入
卡牌条目与其当前持有者的可见状态。

输出
generic、specific、futureOption 与 responseCapacity 分解。

读取状态
只读持有者生命、装备、手牌与设备使用次数。

写入状态
无。

调用函数
roleCardDelta。

边界与不变量
本结果仅作诊断，不进入最终 transition value；手牌减少已经由 state delta 计价。
*/
export function cardOpportunityCost(card, player) {
  const definitionId = card?.definitionId ?? null;
  const generic = 1.1;
  const specific = definitionId ? roleCardDelta(player?.characterId, definitionId) : 0;
  const recoverOption = definitionId === "recover"
    ? Math.max(0, Math.min(1, Math.max(0, (player?.maxHp ?? 0) - (player?.hp ?? 0)))) * HP_VALUE
    : 0;
  const recycleOption = definitionId
    && player?.equipmentDefinitionId === "recycleDevice"
    && Array.isArray(player?.hand)
    && player.hand.some((entry) => entry.definitionId === definitionId
      && entry.category === "tactic" && entry.counterable !== false)
    ? Math.max(0, 2 - (player.recycleDeviceUses ?? 0)) * 1.1
      * Math.max(0, Number(player.equipmentRetentionProbability) || 1)
    : 0;
  return {
    definitionId,
    generic,
    specific,
    futureOption: { recover: recoverOption, recycle: recycleOption },
    responseCapacity: {
      block: definitionId === "block" ? 1 : 0,
      counter: definitionId === "counter" ? 1 : 0,
      recover: definitionId === "recover" ? 1 : 0
    }
  };
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
计算匿名手牌资源在破坏或掠夺中的 Belief 期望价值。

调用方
Evaluator 的资源候选估值。

输入
用途、双方公开身份和可选 remaining counts。

输出
动态加权期望；无有效计数时返回冻结固定期望。

读取状态
只读 Belief remaining counts。

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
Belief remaining counts；允许为 null。

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
计算观察者对自己或他人一张手牌的合法单卡期望价值。

调用方
AIController/测试的 card value 查询边界。

输入
观察者、资源拥有者与真实 Card token。

输出
自己手牌的角色值、合法记忆的基础值，或匿名固定期望。

读取状态
观察者自己的 definitionId 或合法 aiMemory。

写入状态
无。

调用函数
getRoleCardAiValue、getBaseCardAiValue。

边界与不变量
其他玩家未知实体的 definitionId 永不读取；unknown token 只返回聚合期望。
*/
export function getObservedCardValue(actor, owner, card) {
  if (actor.id === owner.id) {
    return getRoleCardAiValue(actor.characterId, card.definitionId);
  }
  const definitionId = actor.aiMemory?.knownCardsByPlayer?.[owner.id]?.[card.id] ?? null;
  return definitionId
    ? getBaseCardAiValue(definitionId)
    : UNKNOWN_HAND_EXPECTED_VALUE;
}
