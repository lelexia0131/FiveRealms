/**
 * 角色卡牌价值统一入口。
 *
 * 保存全局基础值与稀疏角色差值，并由已接入的 AI 决策模块调用。
 * 不修改卡牌配置或游戏状态。
 * 价值模型：全局基础 aiValue + 稀疏角色差值；未配置的组合自动回退 0。
 * 后续新增角色或卡牌时，未配置差值即可立即使用基础值。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260813-human-response-indefinite";
import { GENERAL_BY_ID, GENERAL_DEFINITIONS } from "../config/generalConfig.js?build=20260813-human-response-indefinite";

/**
 * 角色 × 卡牌稀疏差值表。
 *
 * 当前保存正式稀疏角色差值：只记录非零项，未配置组合自动回退 0。
 * 新角色和新卡牌不要求立即配置差值；禁止写入完整矩阵。
 * 未来添加角色条目时，必须同时 Object.freeze 该角色的嵌套差值对象。
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

/**
 * 获取全局基础 aiValue。
 *
 * @param {string} definitionId 卡牌 definitionId
 * @param {Object} [cardDefinitions] 测试注入用卡牌定义集合，默认 CARD_DEFINITIONS
 * @returns {number} 全局基础 aiValue
 */
export function getBaseCardAiValue(definitionId, cardDefinitions = CARD_DEFINITIONS) {
  const definition = cardDefinitions[definitionId];
  if (!definition || !Number.isFinite(definition.aiValue)) {
    throw new Error(`getBaseCardAiValue 未知卡牌 ID：${definitionId}`);
  }
  return definition.aiValue;
}

/**
 * 获取角色对某张卡牌的有效 aiValue。
 *
 * 有效值 = 全局基础 aiValue + (角色差值 ?? 0)。
 * 未知角色 ID 或未知卡牌 ID 必须抛错，禁止把拼写错误静默当作中性组合。
 *
 * @param {string} generalId 角色 ID（GENERAL_DEFINITIONS 中的 id）
 * @param {string} definitionId 卡牌 definitionId
 * @param {Object} [options] 测试注入用配置
 * @param {Object} [options.cardDefinitions] 默认 CARD_DEFINITIONS
 * @param {Array} [options.generalDefinitions] 仅测试注入；省略时生产默认使用 GENERAL_BY_ID 常数时间查询
 * @param {Object} [options.deltas] 默认 ROLE_CARD_VALUE_DELTAS
 * @returns {number} 角色有效 aiValue
 */
export function getRoleCardAiValue(generalId, definitionId, options = {}) {
  const {
    cardDefinitions = CARD_DEFINITIONS,
    generalDefinitions,
    deltas = ROLE_CARD_VALUE_DELTAS
  } = options ?? {};
  const knownGeneral = generalDefinitions === undefined
    ? Object.hasOwn(GENERAL_BY_ID, generalId)
    : Array.isArray(generalDefinitions) && generalDefinitions.some((general) => general?.id === generalId);
  if (!knownGeneral) {
    throw new Error(`getRoleCardAiValue 未知角色 ID：${generalId}`);
  }
  const base = getBaseCardAiValue(definitionId, cardDefinitions);
  const roleDeltas = deltas?.[generalId];
  const hasExplicitDelta = roleDeltas !== null && typeof roleDeltas === "object"
    && Object.hasOwn(roleDeltas, definitionId);
  if (!hasExplicitDelta) return base;
  const delta = roleDeltas[definitionId];
  if (!Number.isInteger(delta) || delta < -2 || delta > 2) {
    throw new Error(
      `getRoleCardAiValue 非法差值：角色 ${generalId}，卡牌 ${definitionId}，差值 ${String(delta)}`
    );
  }
  return base + delta;
}

/**
 * 装备牌在手牌中的边际保留价值折损。
 *
 * 语义：当前已装备时，保留并未来装备该牌只会产生 replacement / redundancy 的净状态变化，
 * 而不是重新获得一次完整装备价值；与 AiEvaluator 行动评分中的边际装备价值共用同一语义。
 * 返回值为应从保留价值中扣除的折损，无已装备牌时返回 0。
 *
 * @param {string|null} generalId 角色 ID（可空）
 * @param {string} newDefinitionId 手中装备牌 definitionId
 * @param {string|null} equippedDefinitionId 当前已装备牌 definitionId
 * @param {number} [retention=1] 旧装备保留概率
 * @param {Object} [options] 测试注入用配置
 * @param {Object} [options.cardDefinitions] 默认 CARD_DEFINITIONS
 * @param {Array} [options.generalDefinitions] 默认 GENERAL_DEFINITIONS
 * @param {Object} [options.deltas] 默认 ROLE_CARD_VALUE_DELTAS
 * @returns {number} 边际折损（0 表示无已装备牌）
 */
export function getEquipmentKeepValueDeduction(
  generalId,
  newDefinitionId,
  equippedDefinitionId,
  retention = 1,
  options = {}
) {
  if (!equippedDefinitionId) return 0;
  const cardDefinitions = options.cardDefinitions ?? CARD_DEFINITIONS;
  const oldValue = generalId
    ? getRoleCardAiValue(generalId, equippedDefinitionId, options)
    : (cardDefinitions[equippedDefinitionId]?.aiValue ?? 0);
  const deduction = oldValue * Math.max(0, Number(retention) || 0);
  return equippedDefinitionId === newDefinitionId ? deduction + 4 : deduction;
}

/**
 * 校验稀疏差值表。
 *
 * 动态读取 GENERAL_DEFINITIONS 与 CARD_DEFINITIONS（或测试注入集合）：
 * - 每个角色 ID 必须存在；
 * - 每个卡牌 ID 必须存在；
 * - 每个差值必须是 -2..+2 的有限整数；
 * - 未配置的角色与卡牌完全合法，空表完全合法；
 * - 已删除或改名后遗留的条目必须校验失败。
 *
 * @param {Object} [deltas] 待校验差值表，默认 ROLE_CARD_VALUE_DELTAS
 * @param {Object} [options] 测试注入用配置
 * @param {Object} [options.cardDefinitions] 默认 CARD_DEFINITIONS
 * @param {Array} [options.generalDefinitions] 默认 GENERAL_DEFINITIONS
 * @returns {string[]} 错误信息数组；空数组表示合法
 */
export function validateRoleCardValueDeltas(deltas = ROLE_CARD_VALUE_DELTAS, options = {}) {
  const {
    cardDefinitions = CARD_DEFINITIONS,
    generalDefinitions = GENERAL_DEFINITIONS
  } = options ?? {};
  if (deltas === null || typeof deltas !== "object" || Array.isArray(deltas)) {
    return ["角色差值表必须是对象"];
  }
  const generalIds = new Set(
    Array.isArray(generalDefinitions) ? generalDefinitions.map((general) => general?.id) : []
  );
  const errors = [];
  for (const [generalId, roleDeltas] of Object.entries(deltas)) {
    if (!generalIds.has(generalId)) {
      errors.push(`未知角色 ID：${generalId}`);
      continue;
    }
    if (roleDeltas === null || typeof roleDeltas !== "object" || Array.isArray(roleDeltas)) {
      errors.push(`角色 ${generalId} 的差值必须是对象`);
      continue;
    }
    for (const [definitionId, delta] of Object.entries(roleDeltas)) {
      if (!Object.hasOwn(cardDefinitions, definitionId)) {
        errors.push(`未知卡牌 ID：${definitionId}（角色 ${generalId}）`);
        continue;
      }
      if (!Number.isInteger(delta)) {
        errors.push(`卡牌 ${definitionId}（角色 ${generalId}）的差值必须是有限整数，实际：${String(delta)}`);
        continue;
      }
      if (delta < -2 || delta > 2) {
        errors.push(`卡牌 ${definitionId}（角色 ${generalId}）的差值超出 -2..+2：${delta}`);
      }
    }
  }
  return errors;
}
