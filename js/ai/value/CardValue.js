/*
模块职责
唯一拥有 Policy Value（用于选择/保留而非最终结算的策略价值）所需的卡牌静态基础值、角色差量、装备保留折损与机会成本公式。

上游
价值评估、弃牌、资源选择、转移策略、模拟器与搜索先验。

下游
稳定卡牌和角色配置。

状态边界
只读传入的卡牌、角色与可见状态字段；不写任何状态。

信息边界
只使用公开配置、当前角色自己的卡牌或已经过滤的可见卡牌条目。

架构约束
静态卡片值不得直接成为最终 Transition Value；状态存量只可经 State Value 的前后差进入最终价值，所有调用路径必须复用本模块的唯一公式。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260816-legacy-recovery";
import { GENERAL_BY_ID, GENERAL_DEFINITIONS } from "../../config/generalConfig.js?build=20260816-legacy-recovery";
import { HP_VALUE } from "./Economics.js?build=20260816-legacy-recovery";

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
  if (!definition || !Number.isFinite(definition.aiValue)) {
    throw new Error(`getBaseCardAiValue 未知卡牌 ID：${definitionId}`);
  }
  return definition.aiValue;
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
export function roleCardDelta(generalId, definitionId) {
  if (!generalId || !definitionId) return 0;
  return getRoleCardAiValue(generalId, definitionId) - getBaseCardAiValue(definitionId);
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
只读卡牌概率分支。

写入状态
无。

调用函数
无。

边界与不变量
优先 availabilityStateBranches；不得读取未过滤的敌方手牌身份。
*/
export function cardAvailability(card) {
  const stateBranches = Array.isArray(card?.availabilityStateBranches)
    ? card.availabilityStateBranches
    : null;
  if (stateBranches) {
    return stateBranches
      .filter((branch) => branch.available)
      .reduce((sum, branch) => sum + (Number(branch.probability) || 0), 0);
  }
  if (Array.isArray(card?.availabilityBranches)) {
    return card.availabilityBranches.reduce(
      (sum, branch) => sum + (Number(branch.probability) || 0), 0
    );
  }
  return 1;
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
  const specific = definitionId ? roleCardDelta(player?.generalId, definitionId) : 0;
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
