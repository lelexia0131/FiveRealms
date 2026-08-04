import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260804-target-selection-v58";

export const MIN_TRANSFER_UTILITY = 0.5;
const UNKNOWN_HAND_EXPECTED_VALUE = 4;
const HUMAN_ALLY_HAND_PROTECTION = 7;

const handCount = (player, excludedCardIds = null) => Array.isArray(player?.hand)
  ? player.hand.filter((card) => !excludedCardIds?.has(card.id)).length
  : Math.max(0, Number(player?.handCount ?? 0));

function knownHandDefinitionIds(actor, owner, excludedCardIds = null) {
  if (!actor || !owner) return [];
  if (actor.id === owner.id) return (actor.hand ?? []).filter((card) => !excludedCardIds?.has(card.id)).map((card) => card.definitionId).filter(Boolean);
  if (Array.isArray(owner.knownCards)) return owner.knownCards.filter((card) => !excludedCardIds?.has(card.cardId)).map((card) => card.definitionId).filter(Boolean);
  return Object.entries(actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {}).filter(([cardId]) => !excludedCardIds?.has(cardId)).map(([, definitionId]) => definitionId).filter(Boolean);
}

function expectedTransferHandValue(actor, owner, excludedCardIds = null) {
  const knownValues = knownHandDefinitionIds(actor, owner, excludedCardIds)
    .map((definitionId) => CARD_DEFINITIONS[definitionId]?.aiValue)
    .filter(Number.isFinite);
  // 已知实体可以定向选择其中的低价值牌；其余牌仍只采用固定期望值。
  return knownValues.length ? Math.min(...knownValues) : UNKNOWN_HAND_EXPECTED_VALUE;
}

/** 只读取公开局面、观察者自身手牌和合法记忆的纯转移评分。 */
export function scoreTransferCombination({ actor, from, receiver, zone, excludedCardIds = null }) {
  if (!actor || !from || !receiver || from.id === receiver.id) return Number.NEGATIVE_INFINITY;
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;

  if (zone !== "hand" || handCount(from, excludedCardIds) <= 0) return Number.NEGATIVE_INFINITY;
  const movedValue = expectedTransferHandValue(actor, from, excludedCardIds);
  const fromLimit = Math.max(0, Number(from.hp ?? 0));
  const receiverLimit = Math.max(0, Number(receiver.hp ?? 0));
  const sourceOverflow = Math.max(0, handCount(from, excludedCardIds) - fromLimit);
  const receiverSpace = Math.max(0, receiverLimit - handCount(receiver, excludedCardIds));
  let score = (sourceIsAlly ? -movedValue : movedValue)
    + (receiverIsAlly ? movedValue : -movedValue);

  if (sourceIsAlly && receiverIsAlly) score += Math.min(sourceOverflow, receiverSpace) * 4;
  if (!sourceIsAlly && sourceOverflow > 0) score -= Math.min(sourceOverflow, 2) * 2;
  if (receiverIsAlly && receiverSpace === 0) score -= movedValue * 0.75;
  if (!receiverIsAlly && receiverSpace === 0) score += 1;
  if (sourceIsAlly && !receiverIsAlly) score -= 8;
  if (sourceIsAlly && from.controllerType === "human") score -= HUMAN_ALLY_HAND_PROTECTION;
  return score;
}

/** 使用调用方提供的 RuleEngine 接收者集合构建同一结构的真实/可见候选。 */
export function buildTransferCandidates({ actor, sources, getReceivers, allowedReceiverIds = null, excludedCardIds = null }) {
  const candidates = [];
  for (const from of sources ?? []) {
    const receivers = (getReceivers(from) ?? []).filter((receiver) =>
      !allowedReceiverIds || allowedReceiverIds.has(receiver.id));
    for (const receiver of receivers) {
      if (handCount(from, excludedCardIds) > 0) {
        candidates.push({
          sourceId:from.id, sourceSeatIndex:from.seatIndex, receiverId:receiver.id, zone:"hand",
          score:scoreTransferCombination({ actor, from, receiver, zone:"hand", excludedCardIds })
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
