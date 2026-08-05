/**
 * AI 实体选牌策略。处理弃牌、公共牌和隐藏位置；已知实体可定向选择，未知牌只能
 * 按位置/随机源选择，绝不能通过 owner.hand 中的 definitionId 偷看后再决定位置。
 */
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260805-ai-remaining-density-v84";
import { RuleEngine } from "../core/RuleEngine.js?build=20260805-ai-remaining-density-v84";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260805-ai-remaining-density-v84";
import { buildTransferCandidates, chooseBestPositiveTransfer, chooseTransferHandCandidate, UNKNOWN_HAND_EXPECTED_VALUE } from "./transferScoring.js?build=20260805-ai-remaining-density-v84";
import { getRoleCardAiValue } from "./roleCardValue.js?build=20260805-ai-remaining-density-v84";
import {
  chooseBestResourceHandCandidate,
  chooseResourceZone,
  getResourceDefinitionUtility,
  getResourceUnknownUtility
} from "./resourceSelectionValue.js?build=20260805-ai-remaining-density-v84";

const globalKnownValue = (definitionId) => CARD_DEFINITIONS[definitionId]?.aiValue ?? UNKNOWN_HAND_EXPECTED_VALUE;

/** 把真实手牌实体整理为共享模块可用的手牌候选（仅合法记忆或自己手牌）。 */
const buildResourceHandCandidate = (actor, owner, card, purpose, remainingCardCounts = null) => {
  const definitionId = actor.id === owner.id
    ? card.definitionId
    : (actor.aiMemory.knownCardsByPlayer[owner.id]?.[card.id] ?? null);
  if (definitionId) {
    return {
      selectionKind: "known",
      cardId: card.id,
      definitionId,
      utility: getResourceDefinitionUtility(purpose, actor, owner, definitionId)
    };
  }
  return {
    selectionKind: "unknown",
    cardId: null,
    definitionId: null,
    utility: getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts)
  };
};

/** 未知手牌只按位置采样，绝不按真实定义筛选。 */
export class AiCardSelector {
  constructor(game, knowledge) { this.game = game; this.knowledge = knowledge; }

  chooseHiddenCards(actor, owner, count, excludedCardIds = null, context = null, resourceCounts = null) {
    const selected = [];
    const known = actor.aiMemory.knownCardsByPlayer[owner.id] ?? {};
    const cards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const purpose = context?.purpose ?? null;
    const remainingCardCounts = resourceCounts !== null
      ? resourceCounts
      : ((purpose === "transfer" || purpose === "destroy" || purpose === "plunder")
        ? (this.knowledge?.remainingCounts?.(actor) ?? null)
        : null);
    while (selected.length < count && cards.length) {
      let index = -1;
      if (purpose === "transfer") {
        const candidate = chooseTransferHandCandidate(actor, owner, context?.receiver, excludedCardIds, remainingCardCounts);
        if (!candidate) return selected;
        if (candidate.selectionKind === "known") {
          index = cards.findIndex((card) => card.id === candidate.cardId);
        } else {
          const unknownIndices = [];
          for (let current = 0; current < cards.length; current += 1) {
            if (!known[cards[current].id]) unknownIndices.push(current);
          }
          index = unknownIndices[Math.floor(this.game.random() * unknownIndices.length)] ?? 0;
        }
        if (index < 0) return selected;
      } else if (actor.id === owner.id) {
        index = cards.reduce((best, card, current) => (
          getRoleCardAiValue(actor.generalId, card.definitionId)
            < getRoleCardAiValue(actor.generalId, cards[best].definitionId) ? current : best
        ), 0);
      } else if (purpose === "scout" || purpose === "spy-gap") {
        index = this.peekIndex(known, cards);
      } else if (purpose === "destroy" || purpose === "plunder") {
        const knownCards = [];
        for (let current = 0; current < cards.length; current += 1) {
          const definitionId = known[cards[current].id];
          if (definitionId) knownCards.push({ cardId: cards[current].id, definitionId });
        }
        const candidate = chooseBestResourceHandCandidate({
          purpose,
          actor,
          owner,
          knownCards,
          unknownCount: cards.length - knownCards.length,
          remainingCardCounts
        });
        if (!candidate) return selected;
        if (candidate.selectionKind === "known") {
          index = cards.findIndex((card) => card.id === candidate.cardId);
        } else {
          const unknownIndices = [];
          for (let current = 0; current < cards.length; current += 1) {
            if (!known[cards[current].id]) unknownIndices.push(current);
          }
          index = unknownIndices[Math.floor(this.game.random() * unknownIndices.length)] ?? 0;
        }
        if (index < 0) return selected;
      } else {
        const knownCards = cards.map((card, current) => ({ card, current, definitionId:known[card.id] }))
          .filter((entry) => entry.definitionId)
          .sort((a, b) => (CARD_DEFINITIONS[a.definitionId]?.aiValue ?? UNKNOWN_HAND_EXPECTED_VALUE) - (CARD_DEFINITIONS[b.definitionId]?.aiValue ?? UNKNOWN_HAND_EXPECTED_VALUE));
        index = knownCards[0]?.current ?? Math.floor(this.game.random() * cards.length);
      }
      selected.push(cards.splice(Math.max(0, index), 1)[0]);
    }
    return selected;
  }

  /** 窥探/窥隙：优先从未知位置随机采样，未知耗尽后按已知低价值补足。 */
  peekIndex(known, cards) {
    const unknownIndices = [];
    for (let current = 0; current < cards.length; current += 1) {
      if (!known[cards[current].id]) unknownIndices.push(current);
    }
    if (unknownIndices.length) {
      return unknownIndices[Math.floor(this.game.random() * unknownIndices.length)];
    }
    const knownCards = cards
      .map((card, current) => ({ card, current, definitionId:known[card.id] }))
      .filter((entry) => entry.definitionId)
      .sort((a, b) => (CARD_DEFINITIONS[a.definitionId]?.aiValue ?? UNKNOWN_HAND_EXPECTED_VALUE) - (CARD_DEFINITIONS[b.definitionId]?.aiValue ?? UNKNOWN_HAND_EXPECTED_VALUE));
    return knownCards[0]?.current ?? 0;
  }

  /** 已知/未知混合时按价值方向选一个位置；未知位置只按固定期望值参与，不读真实牌面。 */
  extremeIndex(known, cards, direction, knownValueForDefinition = globalKnownValue, unknownValue = UNKNOWN_HAND_EXPECTED_VALUE) {
    const knownEntries = [];
    const unknownIndices = [];
    for (let current = 0; current < cards.length; current += 1) {
      const definitionId = known[cards[current].id];
      if (definitionId) {
        knownEntries.push({ current, value:knownValueForDefinition(definitionId) });
      } else {
        unknownIndices.push(current);
      }
    }
    if (!knownEntries.length) return unknownIndices[Math.floor(this.game.random() * unknownIndices.length)] ?? 0;
    const bestKnown = knownEntries.reduce((best, entry) => (
      direction === "highest" ? (entry.value > best.value ? entry : best) : (entry.value < best.value ? entry : best)
    ), knownEntries[0]);
    const unknownWins = unknownIndices.length > 0
      && (direction === "highest" ? unknownValue > bestKnown.value : unknownValue < bestKnown.value);
    if (unknownWins) return unknownIndices[Math.floor(this.game.random() * unknownIndices.length)];
    return bestKnown.current;
  }

  /** 装备是公开信息；掠夺/破坏按预计价值比较，未知手牌仍只按既有不透明位置策略选择。 */
  chooseZoneCard(actor, owner, context = null, excludedCardIds = null) {
    if (!owner?.alive) return null;
    const purpose = context?.purpose ?? null;
    if (purpose === "plunder" || purpose === "destroy") {
      const remainingCardCounts = this.knowledge?.remainingCounts?.(actor) ?? null;
      const [card] = this.chooseHiddenCards(actor, owner, 1, excludedCardIds, context, remainingCardCounts);
      const handCandidate = card ? buildResourceHandCandidate(actor, owner, card, purpose, remainingCardCounts) : null;
      const zoneChoice = chooseResourceZone({
        purpose,
        actor,
        owner,
        handCandidate,
        equipmentDefinitionId: owner.equipment?.definitionId ?? null
      });
      if (zoneChoice?.zone === "equipment" && owner.equipment) return { card: owner.equipment, zone: "equipment" };
      if (zoneChoice?.zone === "hand" && card) return { card, zone: "hand" };
      return null;
    }
    if (owner.equipment && (!owner.hand.length || (actor.id !== owner.id && owner.equipment.aiValue >= 7))) {
      return { card:owner.equipment, zone:"equipment" };
    }
    const [card] = this.chooseHiddenCards(actor, owner, 1, excludedCardIds, context);
    return card ? { card, zone:"hand" } : owner.equipment ? { card:owner.equipment, zone:"equipment" } : null;
  }

  /** 仅从合法记忆或自己手牌估值；对他人未知位置只返回固定期望值。 */
  expectedCardValue(actor, owner, card) {
    if (actor.id === owner.id) return getRoleCardAiValue(actor.generalId, card.definitionId);
    const definitionId = actor.aiMemory.knownCardsByPlayer[owner.id]?.[card.id] ?? null;
    return definitionId ? (CARD_DEFINITIONS[definitionId]?.aiValue ?? UNKNOWN_HAND_EXPECTED_VALUE) : UNKNOWN_HAND_EXPECTED_VALUE;
  }

  chooseTransferSource(actor, candidates) {
    const plan = this.chooseTransferCombination(actor, CARD_DEFINITIONS.transfer, candidates);
    return candidates.find((player) => player.id === plan?.sourceId) ?? null;
  }
  chooseTransferReceiver(actor, from, candidates) {
    const plan = this.chooseTransferCombination(actor, CARD_DEFINITIONS.transfer, [from], new Set(candidates.map((player) => player.id)));
    return candidates.find((player) => player.id === plan?.receiverId) ?? null;
  }

  /** 联合评估来源、接收者和手牌；未知牌只使用数量、上限压力与合法已知概率。 */
  chooseTransferCombination(actor, card, sources, allowedReceiverIds = null, excludedCardIds = null) {
    const remainingCardCounts = this.knowledge?.remainingCounts?.(actor) ?? null;
    const candidates = buildTransferCandidates({
      actor, sources, allowedReceiverIds, excludedCardIds, remainingCardCounts,
      getReceivers:(from) => RuleEngine.getTransferReceivers(this.game, actor, from, card)
    });
    return chooseBestPositiveTransfer(candidates);
  }
  choosePublicCard(player, cards) {
    return [...cards].sort((a, b) => (
      getRoleCardAiValue(player.generalId, b.definitionId)
        - getRoleCardAiValue(player.generalId, a.definitionId)
    ))[0] ?? null;
  }
  chooseDiscards(player, count) {
    const enemies = this.game.getEnemies(player);
    const stranded = enemies.length > 0 && !enemies.some((enemy) => DistanceSystem.inAttackRange(this.game, player, enemy));
    const value = (card) => {
      let score = getRoleCardAiValue(player.generalId, card.definitionId);
      if (stranded && card.definitionId === "assault") score += 5;
      if (player.hp >= player.maxHp && card.definitionId === "recover") score -= 2;
      if (player.hp <= 2 && card.definitionId === "recover") score += 7;
      if (player.hp <= 2 && card.definitionId === "block") score += 6;
      if (card.definitionId === "symbiosis") score -= 5;
      return score;
    };
    return [...player.hand].sort((a,b) => value(a) - value(b)).slice(0, count);
  }
}
