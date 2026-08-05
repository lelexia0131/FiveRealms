import { getBaseCardAiValue, getRoleCardAiValue } from "./roleCardValue.js?build=20260805-transfer-role-scoring-v80";
import { ThreatCalculator } from "./ThreatCalculator.js?build=20260805-transfer-role-scoring-v80";

export const MIN_TRANSFER_UTILITY = 0.5;
export const UNKNOWN_HAND_EXPECTED_VALUE = 4;
const HUMAN_ALLY_HAND_PROTECTION = 7;
/** 敌方→敌方重分配专用门槛：威胁差或总分低于该值都禁止。 */
const MIN_ENEMY_REDISTRIBUTION_THREAT_GAP = 4;
const MIN_ENEMY_REDISTRIBUTION_UTILITY = 5;

const handCount = (player, excludedCardIds = null) => Array.isArray(player?.hand)
  ? player.hand.filter((card) => !excludedCardIds?.has(card.id)).length
  : Math.max(0, Number(player?.handCount ?? 0));

function knownHandDefinitionIds(actor, owner, excludedCardIds = null) {
  if (!actor || !owner) return [];
  if (actor.id === owner.id) return (actor.hand ?? []).filter((card) => !excludedCardIds?.has(card.id)).map((card) => card.definitionId).filter(Boolean);
  if (Array.isArray(owner.knownCards)) return owner.knownCards.filter((card) => !excludedCardIds?.has(card.cardId)).map((card) => card.definitionId).filter(Boolean);
  return Object.entries(actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {}).filter(([cardId]) => !excludedCardIds?.has(cardId)).map(([, definitionId]) => definitionId).filter(Boolean);
}

/** 已知实体候选统一入口：真实自己手牌 / 快照 knownCards / 合法 aiMemory。 */
function knownHandCandidateEntries(actor, owner, excludedCardIds = null) {
  if (actor.id === owner.id) {
    return (owner.hand ?? [])
      .filter((card) => !excludedCardIds?.has(card.id))
      .map((card) => ({ cardId:card.id, definitionId:card.definitionId }))
      .filter((entry) => entry.definitionId);
  }
  if (Array.isArray(owner.knownCards)) {
    return owner.knownCards
      .filter((card) => !excludedCardIds?.has(card.cardId))
      .map((card) => ({ cardId:card.cardId, definitionId:card.definitionId }))
      .filter((entry) => entry.definitionId);
  }
  return Object.entries(actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {})
    .filter(([cardId]) => !excludedCardIds?.has(cardId))
    .map(([cardId, definitionId]) => ({ cardId, definitionId }))
    .filter((entry) => entry.definitionId);
}

/** 统一基础值入口：generalId 缺失时回退全局基础值，非空非法 generalId 保持抛错。 */
function roleOrBaseCardAiValue(player, definitionId) {
  return player?.generalId
    ? getRoleCardAiValue(player.generalId, definitionId)
    : getBaseCardAiValue(definitionId);
}

/**
 * 手牌预计价值：已知实体使用持牌角色情境价值，未知位置按动态期望参与极值；
 * 与 AiCardSelector 的实际选牌方向共用同一规则。
 */
export function expectedHandValue(actor, owner, direction = "lowest", excludedCardIds = null, remainingCardCounts = null) {
  const definitionIds = knownHandDefinitionIds(actor, owner, excludedCardIds);
  const knownValues = definitionIds
    .map((definitionId) => cardSituationValue(definitionId, owner))
    .filter(Number.isFinite);
  const unknownCount = Math.max(0, handCount(owner, excludedCardIds) - definitionIds.length);
  const unknownValue = expectedUnknownSituationValue(owner, remainingCardCounts);
  const candidates = [...knownValues];
  for (let index = 0; index < unknownCount; index += 1) candidates.push(unknownValue);
  if (!candidates.length) return UNKNOWN_HAND_EXPECTED_VALUE;
  return direction === "highest" ? Math.max(...candidates) : Math.min(...candidates);
}

/**
 * 已知牌对该角色的情境价值；只复用公开/过滤字段与 AiEvaluator 同类简单修正，
 * 不读取隐藏手牌，也不建立完整卡牌评估器。
 */
export function cardSituationValue(definitionId, player) {
  const base = roleOrBaseCardAiValue(player, definitionId);
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
    const missingEnergy = Math.max(0, Number(player?.maxEnergy ?? player?.energy ?? 0) - Number(player?.energy ?? 0));
    value += Math.min(2, missingEnergy);
    const activeSkillId = player?.activeSkillId ?? player?.general?.activeSkillIds?.[0] ?? null;
    const activeSkillCost = Number(player?.activeSkillCost ?? player?.general?.activeCost ?? 0);
    const activeSkillUses = Number(player?.activeSkillUses ?? player?.turnFlags?.activeSkillUseCounts?.[activeSkillId] ?? 0);
    const activeSkillLimit = Number(player?.activeSkillLimit ?? player?.general?.activeLimitPerTurn ?? 0);
    if (activeSkillId && activeSkillLimit > 0 && activeSkillUses < activeSkillLimit
      && activeSkillCost > 0 && Number(player?.energy ?? 0) + 1 >= activeSkillCost) value += 2;
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

/** 未知手牌按剩余实例计数加权的角色情境期望；无有效计数时回退固定值 4。 */
function expectedUnknownSituationValue(player, remainingCardCounts) {
  if (remainingCardCounts !== null && typeof remainingCardCounts === "object"
    && !Array.isArray(remainingCardCounts)) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      weightedSum += count * cardSituationValue(definitionId, player);
      totalWeight += count;
    }
    if (totalWeight > 0) return weightedSum / totalWeight;
  }
  return UNKNOWN_HAND_EXPECTED_VALUE;
}

function transferCardUtility(sourceIsAlly, receiverIsAlly, sourceValue, receiverValue) {
  if (sourceIsAlly && receiverIsAlly) return receiverValue - sourceValue;
  if (!sourceIsAlly && receiverIsAlly) return sourceValue + receiverValue;
  if (!sourceIsAlly && !receiverIsAlly) return sourceValue - receiverValue;
  return Number.NEGATIVE_INFINITY;
}

/**
 * 共享逐牌候选决策：评分与执行都调用它，保证选中同一张已知牌或同一类未知候选。
 * 未知候选只输出聚合描述，不携带真实 cardId/definitionId。
 */
export function chooseTransferHandCandidate(actor, from, receiver, excludedCardIds = null, remainingCardCounts = null) {
  if (!actor || !from || !receiver) return null;
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;
  if (sourceIsAlly && !receiverIsAlly) return null;
  const knownEntries = knownHandCandidateEntries(actor, from, excludedCardIds);
  const unknownCount = Math.max(0, handCount(from, excludedCardIds) - knownEntries.length);
  const scored = knownEntries.map((entry) => {
    const sourceValue = cardSituationValue(entry.definitionId, from);
    const receiverValue = cardSituationValue(entry.definitionId, receiver);
    return {
      selectionKind:"known",
      cardId:entry.cardId,
      definitionId:entry.definitionId,
      expectedValue:receiverValue,
      utility:transferCardUtility(sourceIsAlly, receiverIsAlly, sourceValue, receiverValue)
    };
  });
  if (unknownCount > 0) {
    const sourceUnknownValue = expectedUnknownSituationValue(from, remainingCardCounts);
    const receiverUnknownValue = expectedUnknownSituationValue(receiver, remainingCardCounts);
    scored.push({
      selectionKind:"unknown",
      cardId:null,
      definitionId:null,
      expectedValue:receiverUnknownValue,
      utility:transferCardUtility(sourceIsAlly, receiverIsAlly, sourceUnknownValue, receiverUnknownValue)
    });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.utility - a.utility
    || (a.selectionKind === "known" ? 0 : 1) - (b.selectionKind === "known" ? 0 : 1)
    || String(a.cardId ?? "").localeCompare(String(b.cardId ?? "")));
  return scored[0];
}

/** 把真实 Player 或过滤快照归一化为 ThreatCalculator 可读的公开字段。 */
function threatView(player) {
  return {
    alive:Boolean(player?.alive),
    battleTeam:player?.battleTeam,
    hp:Number(player?.hp ?? 0),
    maxHp:Number(player?.maxHp ?? player?.hp ?? 0),
    shield:Number(player?.shield ?? 0),
    energy:Number(player?.energy ?? 0),
    handCount:handCount(player),
    statuses:Array.isArray(player?.statuses) ? player.statuses : Object.keys(player?.statuses ?? {}),
    roleTags:player?.roleTags ?? player?.general?.roleTags ?? [],
    tags:player?.tags ?? player?.general?.tags ?? []
  };
}

function enemyThreatGap(actor, from, receiver) {
  const memory = actor?.aiMemory ?? {};
  return ThreatCalculator.calculate(threatView(actor), threatView(from), memory)
    - ThreatCalculator.calculate(threatView(actor), threatView(receiver), memory);
}

/** 只读取公开局面、观察者自身手牌和合法记忆的纯转移评分。 */
export function scoreTransferCombination({ actor, from, receiver, zone, excludedCardIds = null, remainingCardCounts = null }) {
  if (!actor || !from || !receiver || from.id === receiver.id) return Number.NEGATIVE_INFINITY;
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;
  if (sourceIsAlly && !receiverIsAlly) return Number.NEGATIVE_INFINITY;

  if (zone !== "hand" || handCount(from, excludedCardIds) <= 0) return Number.NEGATIVE_INFINITY;
  const candidate = chooseTransferHandCandidate(actor, from, receiver, excludedCardIds, remainingCardCounts);
  if (!candidate) return Number.NEGATIVE_INFINITY;
  const fromLimit = Math.max(0, Number(from.hp ?? 0));
  const receiverLimit = Math.max(0, Number(receiver.hp ?? 0));
  const sourceOverflow = Math.max(0, handCount(from, excludedCardIds) - fromLimit);
  const receiverSpace = Math.max(0, receiverLimit - handCount(receiver, excludedCardIds));
  let score = candidate.utility;

  if (sourceIsAlly && receiverIsAlly) score += Math.min(sourceOverflow, receiverSpace) * 4;
  if (!sourceIsAlly && sourceOverflow > 0) score -= Math.min(sourceOverflow, 2) * 2;
  if (receiverIsAlly && receiverSpace === 0) score -= candidate.expectedValue * 0.75;
  if (!receiverIsAlly && receiverSpace === 0) score += 1;
  if (sourceIsAlly && from.controllerType === "human") score -= HUMAN_ALLY_HAND_PROTECTION;
  if (!sourceIsAlly && !receiverIsAlly) {
    if (enemyThreatGap(actor, from, receiver) < MIN_ENEMY_REDISTRIBUTION_THREAT_GAP) return Number.NEGATIVE_INFINITY;
    if (score < MIN_ENEMY_REDISTRIBUTION_UTILITY) return Number.NEGATIVE_INFINITY;
  }
  return score;
}

/** 使用调用方提供的 RuleEngine 接收者集合构建同一结构的真实/可见候选。 */
export function buildTransferCandidates({ actor, sources, getReceivers, allowedReceiverIds = null, excludedCardIds = null, remainingCardCounts = null }) {
  const candidates = [];
  for (const from of sources ?? []) {
    const receivers = (getReceivers(from) ?? []).filter((receiver) =>
      !allowedReceiverIds || allowedReceiverIds.has(receiver.id));
    for (const receiver of receivers) {
      if (handCount(from, excludedCardIds) > 0) {
        candidates.push({
          sourceId:from.id, sourceSeatIndex:from.seatIndex, receiverId:receiver.id, zone:"hand",
          score:scoreTransferCombination({ actor, from, receiver, zone:"hand", excludedCardIds, remainingCardCounts })
        });
      }
    }
  }
  return candidates;
}

export function chooseBestPositiveTransfer(candidates, minimumUtility = MIN_TRANSFER_UTILITY) {
  const best = [...(candidates ?? [])].sort((a, b) => b.score - a.score
    || (a.sourceSeatIndex ?? 0) - (b.sourceSeatIndex ?? 0)
    || String(a.receiverId).localeCompare(String(b.receiverId)))[0];
  return best && best.score >= minimumUtility ? Object.freeze({
    sourceId:best.sourceId,
    receiverId:best.receiverId,
    zone:best.zone,
    score:best.score
  }) : null;
}
