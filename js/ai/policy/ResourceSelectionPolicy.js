/*
模块职责
拥有 AI 弃牌、支付资源与手牌/装备区域选择的局部策略。

上游
AIController、CardSelectionPolicy、Simulator 与正式边界。

下游
value/CardValue 与 TransferPolicy 的共享未知牌期望常量。

状态边界
只读调用方提供的玩家、卡牌、合法候选与 Belief 计数，不修改任何对象。

信息边界
未知手牌只以数量和剩余定义计数参与期望，不读取未知实体的真实 definitionId。

架构约束
不执行规则、不生成合法集合、不依赖 Planner/Controller/UI，也不构造 Simulator。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import {
  getBaseCardAiValue,
  getEquipmentKeepValueDeduction,
  getRoleCardAiValue
} from "../value/CardValue.js";
import { UNKNOWN_HAND_EXPECTED_VALUE } from "./TransferPolicy.js";

export const RESPONSE_SURVIVAL_BONUS_DANGER = 1;
export const RESPONSE_SURVIVAL_BONUS_LETHAL = 2;
// 该值只表示资源选择中的技能门槛策略选择权，不是概率、State/Final Utility 或单位换算。
export const SKILL_THRESHOLD_POLICY_BONUS = 4;

/*
功能
计算单张手牌在自主弃牌场景下的保留价值。

调用方
rankDiscardCandidates、Simulator 与直接策略测试。

输入
资源拥有者、合法候选卡和距离/装备上下文。

输出
数值保留价值；越低越应优先弃置。

读取状态
只读玩家公开资源、卡牌定义与 CardValue。

写入状态
无。

调用函数
getRoleCardAiValue、getEquipmentKeepValueDeduction。

边界与不变量
不改变既有分数、同分语义或角色牌值；只评估调用方已允许的候选。
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
按保留价值升序排列弃牌候选。

调用方
chooseDiscardCandidates 与直接策略测试。

输入
玩家、合法卡牌数组与弃牌上下文。

输出
新的已排序卡牌数组。

读取状态
只读输入卡牌与玩家公开字段。

写入状态
无；不修改原数组。

调用函数
getDiscardKeepValue。

边界与不变量
同价值保持输入顺序，保证真实选择与模拟消费确定性一致。
*/
export function rankDiscardCandidates(player, cards, context = {}) {
  return [...cards].sort((left, right) => (
    getDiscardKeepValue(player, left, context) - getDiscardKeepValue(player, right, context)
  ));
}

/*
功能
选择指定数量的最低保留价值弃牌候选。

调用方
ResourceSelectionPolicy.chooseDiscards、正式边界 与测试。

输入
玩家、合法卡牌、数量与弃牌上下文。

输出
应优先弃置的卡牌数组。

读取状态
只读输入。

写入状态
无。

调用函数
rankDiscardCandidates。

边界与不变量
数量向下取整并限制为非负，不制造或解析实体牌。
*/
export function chooseDiscardCandidates(player, cards, count, context = {}) {
  return rankDiscardCandidates(player, cards, context)
    .slice(0, Math.max(0, Math.floor(Number(count) || 0)));
}

/*
功能
计算一张合法已知资源在破坏或掠夺选择中的效用。

调用方
getResourceUnknownUtility、chooseBestResourceHandCandidate、chooseResourceZone。

输入
用途、行动者、资源拥有者与合法已知 definitionId。

输出
既有资源策略效用。

读取状态
只读双方角色/阵营与 CardValue。

写入状态
无。

调用函数
getRoleCardAiValue。

边界与不变量
只接受 destroy/plunder；CardValue 公式仍由 value 层唯一拥有。
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
计算未知手牌位置在破坏或掠夺中的 Belief 期望效用。

调用方
chooseBestResourceHandCandidate 与 CardSelectionPolicy。

输入
用途、双方公开身份和可选剩余牌计数。

输出
动态加权期望；无有效计数时返回既有固定期望。

读取状态
只读 Belief remaining counts 与 CardValue。

写入状态
无。

调用函数
getResourceDefinitionUtility。

边界与不变量
不接收未知实体 definitionId；无计数回退值保持 destroy=4、敌方 plunder=8、同阵营 plunder=0。
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
在合法已知手牌候选与一个聚合未知候选之间选择最高效用者。

调用方
CardSelectionPolicy、Simulator 与直接策略测试。

输入
用途、双方公开信息、合法已知候选、未知数量与 Belief 计数。

输出
known/unknown 选择描述或 null。

读取状态
只读输入候选与剩余牌计数。

写入状态
无。

调用函数
getResourceDefinitionUtility、getResourceUnknownUtility。

边界与不变量
未知严格高于最佳已知才胜出；同分保持已知优先且未知输出不含实体身份。
*/
export function chooseBestResourceHandCandidate({
  purpose,
  actor,
  owner,
  knownCards,
  unknownCount,
  remainingCardCounts
}) {
  const knownList = Array.isArray(knownCards) ? knownCards : [];
  const hasUnknown = Number(unknownCount) > 0;
  let best = null;
  for (const entry of knownList) {
    const utility = getResourceDefinitionUtility(purpose, actor, owner, entry.definitionId);
    if (!best || utility > best.utility) {
      best = {
        selectionKind: "known",
        cardId: entry.cardId,
        definitionId: entry.definitionId,
        utility
      };
    }
  }
  if (!best && hasUnknown) {
    return {
      selectionKind: "unknown",
      cardId: null,
      definitionId: null,
      utility: getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts)
    };
  }
  if (best && hasUnknown) {
    const unknownUtility = getResourceUnknownUtility(
      purpose,
      actor,
      owner,
      remainingCardCounts
    );
    if (unknownUtility > best.utility) {
      return {
        selectionKind: "unknown",
        cardId: null,
        definitionId: null,
        utility: unknownUtility
      };
    }
  }
  return best;
}

/*
功能
在合法手牌候选与公开装备候选之间选择资源区域。

调用方
CardSelectionPolicy、Simulator 与直接策略测试。

输入
用途、双方公开信息、手牌候选和装备 definitionId。

输出
hand/equipment 选择描述或 null。

读取状态
只读显式候选与 CardValue。

写入状态
无。

调用函数
getResourceDefinitionUtility。

边界与不变量
同分时保持手牌优先；只返回描述，不移动或解析真实实体。
*/
export function chooseResourceZone({
  purpose,
  actor,
  owner,
  handCandidate,
  equipmentDefinitionId
}) {
  const handUtility = handCandidate ? handCandidate.utility : null;
  let equipmentChoice = null;
  if (equipmentDefinitionId) {
    equipmentChoice = {
      zone: "equipment",
      selectionKind: "equipment",
      cardId: null,
      definitionId: equipmentDefinitionId,
      utility: getResourceDefinitionUtility(purpose, actor, owner, equipmentDefinitionId)
    };
  }
  if (handUtility !== null && (equipmentChoice === null || handUtility >= equipmentChoice.utility)) {
    return {
      zone: "hand",
      selectionKind: handCandidate.selectionKind,
      cardId: handCandidate.cardId ?? null,
      definitionId: handCandidate.definitionId ?? null,
      utility: handUtility
    };
  }
  return equipmentChoice;
}

/*
功能
计算掠夺后接收方获得一张匿名牌的基础资产期望。

调用方
buildResourceCandidates。

输入
Belief remaining counts；允许为 null。

输出
基础 CardValue 的加权期望；无有效计数时返回既有未知期望。

读取状态
只读 remaining counts 与 CardValue。

写入状态
无。

调用函数
getBaseCardAiValue。

边界与不变量
只计算匿名资源期望，不读取实体牌或角色私有身份。
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
buildResourceCandidates。

输入
资源行动者、原持有者与公开装备 definitionId。

输出
行动者视角的 Resource Selection Policy 点数；敌方损失为正，同阵营损失为负。

读取状态
只读双方阵营，以及原持有者的能量、回合能量增益和主动技能门槛摘要。

写入状态
无。

调用函数
无。

边界与不变量
只恢复既有技能门槛选择权 4 点；调用方按资源实际应用质量缩放。
该值不是概率、State Utility、Final Utility 或单位换算，也不得进入 transition final value。
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
把装备、合法确定手牌与一个匿名手牌槽整理为资源反事实候选。

调用方
ResourceSelectionPolicy.buildCandidates、CardSelectionBoundary 与 CardEffectSimulation。

输入
用途、双方公开字段、确定 known cards、匿名数量、装备定义与 Belief counts。

输出
按 known、unknown、equipment 稳定顺序排列的候选数组。

读取状态
只读显式身份、匿名容量、CardValue 与 remaining counts。

写入状态
无。

调用函数
getResourceDefinitionUtility、getResourceUnknownUtility、getUnknownAcquisitionUtility。

边界与不变量
known 保留 cardId+definitionId；unknown 不携带二者且最多一个；公开装备最多一个。
*/
export function buildResourceCandidates({
  purpose,
  actor,
  owner,
  knownCards,
  unknownCount,
  equipmentDefinitionId,
  remainingCardCounts
}) {
  const candidates = [];
  for (const entry of Array.isArray(knownCards) ? knownCards : []) {
    candidates.push({
      zone: "hand",
      selectionKind: "known",
      cardId: entry.cardId,
      definitionId: entry.definitionId,
      staticUtility: getResourceDefinitionUtility(purpose, actor, owner, entry.definitionId),
      acquisitionUtility: purpose === "plunder"
        ? getBaseCardAiValue(entry.definitionId)
        : 0
    });
  }
  if (Number(unknownCount) > 0) {
    candidates.push({
      zone: "hand",
      selectionKind: "unknown",
      cardId: null,
      definitionId: null,
      staticUtility: getResourceUnknownUtility(
        purpose, actor, owner, remainingCardCounts
      ),
      acquisitionUtility: purpose === "plunder"
        ? getUnknownAcquisitionUtility(remainingCardCounts)
        : 0
    });
  }
  if (equipmentDefinitionId) {
    candidates.push({
      zone: "equipment",
      selectionKind: "equipment",
      cardId: null,
      definitionId: equipmentDefinitionId,
      staticUtility: getResourceDefinitionUtility(
        purpose, actor, owner, equipmentDefinitionId
      ),
      acquisitionUtility: purpose === "plunder"
        ? getBaseCardAiValue(equipmentDefinitionId)
        : 0,
      skillThresholdOption: skillThresholdOptionPolicyValue(
        actor, owner, equipmentDefinitionId
      )
    });
  }
  return candidates;
}

/*
功能
从已经完成 after-state 估值的资源候选中选择最高上下文收益项。

调用方
ResourceSelectionPolicy.chooseContextual、CardSelectionBoundary 与 CardEffectSimulation。

输入
ResourceValueQuery 返回的候选数组。

输出
最佳候选描述或 null。

读取状态
只读 contextualUtility 与 staticUtility。

写入状态
无。

调用函数
无。

边界与不变量
上下文收益是第一权威；仅在数值同分时使用静态值，最终仍保持 known、unknown、equipment 输入顺序。
*/
export function chooseContextualResourceCandidate(candidates) {
  let best = null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!Number.isFinite(candidate?.contextualUtility)) continue;
    if (!best
      || candidate.contextualUtility > best.contextualUtility + 1e-9
      || (Math.abs(candidate.contextualUtility - best.contextualUtility) <= 1e-9
        && candidate.staticUtility > best.staticUtility)) {
      best = candidate;
    }
  }
  return best ? { ...best, utility: best.contextualUtility } : null;
}

export class ResourceSelectionPolicy {
  /*
  功能
  通过正式 Policy 实例暴露弃牌选择。

  调用方
  AIController 与 CardSelectionPolicy。

  输入
  玩家、合法卡牌、数量与上下文。

  输出
  选中的合法候选卡牌数组。

  读取状态
  只读输入。

  写入状态
  无。

  调用函数
  chooseDiscardCandidates。

  边界与不变量
  实例不持有 Game、State 或随机源。
  */
  chooseDiscards(player, cards, count, context = {}) {
    return chooseDiscardCandidates(player, cards, count, context);
  }

  /*
  功能
  通过正式 Policy 实例选择资源手牌候选。

  调用方
  CardSelectionPolicy。

  输入
  已经合法过滤的资源决策上下文。

  输出
  known/unknown 选择描述或 null。

  读取状态
  只读输入。

  写入状态
  无。

  调用函数
  chooseBestResourceHandCandidate。

  边界与不变量
  未知选择不暴露 cardId 或 definitionId。
  */
  chooseHandCandidate(context) {
    return chooseBestResourceHandCandidate(context);
  }

  /*
  功能
  通过正式 Policy 实例在手牌与装备区之间选择。

  调用方
  CardSelectionPolicy。

  输入
  已经合法过滤的区域决策上下文。

  输出
  区域选择描述或 null。

  读取状态
  只读输入。

  写入状态
  无。

  调用函数
  chooseResourceZone。

  边界与不变量
  不执行真实资源移动。
  */
  chooseZone(context) {
    return chooseResourceZone(context);
  }

  /*
  功能
  通过正式 Policy 实例构造资源反事实候选。

  调用方
  CardSelectionBoundary 与 CardEffectSimulation。

  输入
  已合法过滤且不含隐藏定义的资源上下文。

  输出
  known/unknown/equipment 候选数组。

  读取状态
  只读输入。

  写入状态
  无。

  调用函数
  buildResourceCandidates。

  边界与不变量
  不读取 Game，不执行 mutation，也不启动反事实模拟。
  */
  buildCandidates(context) {
    return buildResourceCandidates(context);
  }

  /*
  功能
  通过正式 Policy 实例比较已完成上下文估值的资源候选。

  调用方
  CardSelectionBoundary 与 CardEffectSimulation。

  输入
  ResourceValueQuery 结果数组。

  输出
  最佳候选描述或 null。

  读取状态
  只读输入。

  写入状态
  无。

  调用函数
  chooseContextualResourceCandidate。

  边界与不变量
  Policy 不构造 Simulator；静态 CardValue 只处理上下文同分。
  */
  chooseContextual(candidates) {
    return chooseContextualResourceCandidate(candidates);
  }
}
