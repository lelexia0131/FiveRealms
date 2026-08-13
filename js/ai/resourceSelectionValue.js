/**
 * 破坏与掠夺共享资源选择纯模块。
 *
 * 是以下语义的单一来源：
 * - 破坏定义牌价值（目标角色损失）；
 * - 破坏未知牌价值；
 * - 掠夺定义牌双角色效用；
 * - 掠夺未知牌效用；
 * - 已知牌与未知牌之间的稳定选择；
 * - 手牌与装备之间的稳定选择。
 *
 * 本模块不读取游戏状态、不修改传入对象、不调用随机数、不生成真实卡牌实体、
 * 不读取未知牌定义，也不包含角色差值副本。
 */
import { getRoleCardAiValue } from "./roleCardValue.js?build=20260813-human-response-indefinite";
import { UNKNOWN_HAND_EXPECTED_VALUE } from "./transferScoring.js?build=20260813-human-response-indefinite";

/**
 * 某张已知定义在破坏/掠夺中的价值。
 *
 * destroy：owner（被破坏者）角色价值。
 * plunder 敌方：actor（获得牌者）角色价值 + owner 角色价值。
 * plunder 同阵营（防御性语义）：actor 角色价值 - owner 角色价值。
 */
export function getResourceDefinitionUtility(purpose, actor, owner, definitionId) {
  if (purpose === "destroy") {
    return getRoleCardAiValue(owner.generalId, definitionId);
  }
  if (purpose === "plunder") {
    const actorValue = getRoleCardAiValue(actor.generalId, definitionId);
    const ownerValue = getRoleCardAiValue(owner.generalId, definitionId);
    return owner.battleTeam === actor.battleTeam ? actorValue - ownerValue : actorValue + ownerValue;
  }
  throw new Error(`getResourceDefinitionUtility 非法 purpose：${String(purpose)}`);
}

/**
 * 未知手牌在破坏/掠夺中的价值。
 *
 * destroy：4；plunder 敌方：8（4+4）；plunder 同阵营：0（4-4）。
 * 传入 remainingCardCounts 时按剩余实例数量计算角色相关动态期望；
 * 无有效计数时回退上述固定值。
 */
export function getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts = null) {
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
  if (purpose === "destroy") {
    return UNKNOWN_HAND_EXPECTED_VALUE;
  }
  if (purpose === "plunder") {
    return owner.battleTeam === actor.battleTeam ? 0 : UNKNOWN_HAND_EXPECTED_VALUE * 2;
  }
  throw new Error(`getResourceUnknownUtility 非法 purpose：${String(purpose)}`);
}

/**
 * 在已知手牌候选与未知候选之间选择最高效用者。
 *
 * knownCards 的顺序就是稳定顺序；未知只有在严格高于最佳已知时才胜出，
 * 同分保持已知优先（与现有 extremeIndex 的严格 > 语义一致）。
 *
 * @returns {{selectionKind:"known"|"unknown", cardId:string|null, definitionId:string|null, utility:number}|null}
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
    const unknownUtility = getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts);
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

/**
 * 在手牌候选与公开装备之间选择区域。
 *
 * 同分（handUtility >= equipmentUtility）时选择手牌。
 *
 * @returns {{zone:"hand"|"equipment", selectionKind:"known"|"unknown"|"equipment", cardId:string|null, definitionId:string|null, utility:number}|null}
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
