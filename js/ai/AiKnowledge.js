/**
 * AI 私有知识与未知牌概率。只减去自己手牌、公开区域和本人合法窥探记忆；
 * 不读取其他 AI 记忆、未来牌堆或敌方真实牌面。实体离手后由 Game 立即失效记忆。
 */
import { CARD_COUNTS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260804-role-card-selection-v68";

/** 用公开牌、自己手牌和合法私有记忆估算未知牌概率。 */
export class AiKnowledge {
  constructor(game) { this.game = game; }

  knownCards(viewer, ownerId) {
    const records = viewer.aiMemory.knownCardsByPlayer[ownerId] ?? {};
    return Object.entries(records).map(([cardId, definitionId]) => ({ cardId, definitionId }));
  }

  probability(viewer, definitionId) {
    const remaining = { ...CARD_COUNTS };
    const seenIds = new Set();
    const consume = (entry) => {
      if (!entry?.definitionId || seenIds.has(entry.id ?? entry.cardId)) return;
      seenIds.add(entry.id ?? entry.cardId);
      remaining[entry.definitionId] = Math.max(0, (remaining[entry.definitionId] ?? 0) - 1);
    };
    viewer.hand.forEach(consume);
    this.game.state.deck.discardPile.forEach(consume);
    this.game.state.deck.resolvingCards.forEach(consume);
    this.game.state.deck.judgmentZone.forEach(consume);
    this.game.state.players.forEach((player) => { if (player.equipment) consume(player.equipment); });
    Object.values(viewer.aiMemory.knownCardsByPlayer).forEach((records) => Object.entries(records).forEach(([cardId, id]) => consume({ cardId, definitionId:id })));
    const unknown = Math.max(1, Object.values(remaining).reduce((sum, count) => sum + count, 0));
    return (remaining[definitionId] ?? 0) / unknown;
  }

  invalidate(viewer, ownerId, cardId) { delete viewer.aiMemory.knownCardsByPlayer[ownerId]?.[cardId]; }
  totalCards() { return TOTAL_CARD_COUNT; }

  sampleHiddenWorlds(viewer, visibleState, count) {
    const ids = Object.keys(CARD_COUNTS);
    const weights = ids.map((id) => this.probability(viewer, id));
    const pick = () => {
      let roll = this.game.random() * weights.reduce((sum, weight) => sum + weight, 0);
      for (let index = 0; index < ids.length; index += 1) { roll -= weights[index]; if (roll <= 0) return ids[index]; }
      return ids.at(-1);
    };
    return Array.from({ length:count }, () => Object.fromEntries(visibleState.players.filter((player) => player.id !== viewer.id).map((player) => {
      const known = new Map((player.knownCards ?? []).map((entry) => [entry.cardId, entry.definitionId]));
      const unknownCount = Math.max(0, player.handCount - known.size);
      return [player.id, [...known.values(), ...Array.from({ length:unknownCount }, pick)]];
    })));
  }
}
