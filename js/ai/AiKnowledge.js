/**
 * AI 私有知识与未知牌概率。只减去自己手牌、公开区域和本人合法窥探记忆；
 * 不读取其他 AI 记忆、未来牌堆或敌方真实牌面。实体离手后由 Game 立即失效记忆。
 */
import { CARD_COUNTS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260805-ai-hidden-world-sampling-v85";

/** 用公开牌、自己手牌和合法私有记忆估算未知牌概率。 */
export class AiKnowledge {
  constructor(game) { this.game = game; }

  knownCards(viewer, ownerId) {
    const records = viewer.aiMemory.knownCardsByPlayer[ownerId] ?? {};
    return Object.entries(records).map(([cardId, definitionId]) => ({ cardId, definitionId }));
  }

  /**
   * 当前 viewer 合法可见信息下的剩余卡牌实例计数。
   *
   * 扣除 viewer 自己的手牌、弃牌堆、结算区、判定区、所有公开装备、
   * 公开牌池以及 viewer 自己的合法记忆；每次调用返回新对象。
   */
  remainingCounts(viewer) {
    const remaining = { ...CARD_COUNTS };
    const seenIds = new Set();
    const consume = (entry) => {
      if (!entry || typeof entry.definitionId !== "string") return;
      if (!Object.hasOwn(remaining, entry.definitionId)) return;
      const entityId = entry.id ?? entry.cardId ?? null;
      if (entityId !== null) {
        if (seenIds.has(entityId)) return;
        seenIds.add(entityId);
      }
      remaining[entry.definitionId] = Math.max(0, remaining[entry.definitionId] - 1);
    };
    (viewer?.hand ?? []).forEach(consume);
    (this.game?.state?.deck?.discardPile ?? []).forEach(consume);
    (this.game?.state?.deck?.resolvingCards ?? []).forEach(consume);
    (this.game?.state?.deck?.judgmentZone ?? []).forEach(consume);
    (this.game?.state?.players ?? []).forEach((player) => {
      if (player?.equipment) consume(player.equipment);
    });
    (this.game?.state?.publicCardPool ?? []).forEach(consume);
    Object.entries(viewer?.aiMemory?.knownCardsByPlayer ?? {}).forEach(([, records]) => {
      Object.entries(records ?? {}).forEach(([cardId, definitionId]) => {
        consume({ cardId, definitionId });
      });
    });
    return remaining;
  }

  probability(viewer, definitionId) {
    if (!Object.hasOwn(CARD_COUNTS, definitionId)) return 0;
    const remaining = this.remainingCounts(viewer);
    const total = Object.values(remaining).reduce((sum, count) => sum + count, 0);
    if (total <= 0) return 0;
    return remaining[definitionId] / total;
  }

  invalidate(viewer, ownerId, cardId) { delete viewer.aiMemory.knownCardsByPlayer[ownerId]?.[cardId]; }
  totalCards() { return TOTAL_CARD_COUNT; }

  sampleHiddenWorlds(viewer, visibleState, count) {
    const rootCounts = visibleState.remainingCardCounts;
    if (!rootCounts || typeof rootCounts !== "object" || Array.isArray(rootCounts)) {
      throw new Error("sampleHiddenWorlds 需要合法的可见剩余牌计数快照");
    }
    const pickFrom = (remaining) => {
      const entries = Object.entries(remaining).filter(([, value]) => Number.isFinite(value) && value > 0);
      const total = entries.reduce((sum, [, value]) => sum + value, 0);
      if (total <= 0) throw new Error("隐藏世界抽样失败：未知位置超过该世界可用剩余牌数");
      let roll = this.game.random() * total;
      for (const [definitionId, countValue] of entries) {
        if (roll < countValue) {
          remaining[definitionId] = countValue - 1;
          return definitionId;
        }
        roll -= countValue;
      }
      const [definitionId, countValue] = entries.at(-1);
      remaining[definitionId] = countValue - 1;
      return definitionId;
    };
    return Array.from({ length:count }, () => {
      const remaining = { ...rootCounts };
      return Object.fromEntries(visibleState.players.filter((player) => player.id !== viewer.id).map((player) => {
        const known = new Map((player.knownCards ?? []).map((entry) => [entry.cardId, entry.definitionId]));
        const unknownCount = Math.max(0, player.handCount - known.size);
        const sampled = [];
        for (let index = 0; index < unknownCount; index += 1) sampled.push(pickFrom(remaining));
        return [player.id, [...known.values(), ...sampled]];
      }));
    });
  }
}
