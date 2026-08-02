/**
 * AI 实体选牌策略。处理弃牌、公共牌和隐藏位置；已知实体可定向选择，未知牌只能
 * 按位置/随机源选择，绝不能通过 owner.hand 中的 definitionId 偷看后再决定位置。
 */
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260802-ai-planner-v54";
import { RuleEngine } from "../core/RuleEngine.js?build=20260802-ai-planner-v54";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260802-ai-planner-v54";
import { buildTransferCandidates, chooseBestPositiveTransfer } from "./transferScoring.js?build=20260802-ai-planner-v54";

/** 未知手牌只按位置采样，绝不按真实定义筛选。 */
export class AiCardSelector {
  constructor(game, knowledge) { this.game = game; this.knowledge = knowledge; }

  chooseHiddenCards(actor, owner, count, excludedCardIds = null) {
    const selected = [];
    const known = actor.aiMemory.knownCardsByPlayer[owner.id] ?? {};
    const cards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    while (selected.length < count && cards.length) {
      let index = -1;
      if (actor.id === owner.id) {
        index = cards.reduce((best, card, current) => card.aiValue < cards[best].aiValue ? current : best, 0);
      } else {
        const knownCards = cards.map((card, current) => ({ card, current, definitionId:known[card.id] }))
          .filter((entry) => entry.definitionId)
          .sort((a, b) => (CARD_DEFINITIONS[a.definitionId]?.aiValue ?? 4) - (CARD_DEFINITIONS[b.definitionId]?.aiValue ?? 4));
        index = knownCards[0]?.current ?? Math.floor(this.game.random() * cards.length);
      }
      selected.push(cards.splice(Math.max(0, index), 1)[0]);
    }
    return selected;
  }

  /** 装备是公开信息；未知手牌仍只按既有不透明位置策略选择。 */
  chooseZoneCard(actor, owner) {
    if (!owner?.alive) return null;
    if (owner.equipment && (!owner.hand.length || (actor.id !== owner.id && owner.equipment.aiValue >= 7))) {
      return { card:owner.equipment, zone:"equipment" };
    }
    const [card] = this.chooseHiddenCards(actor, owner, 1);
    return card ? { card, zone:"hand" } : owner.equipment ? { card:owner.equipment, zone:"equipment" } : null;
  }

  chooseTransferSource(actor, candidates) {
    return this.chooseTransferCombination(actor, CARD_DEFINITIONS.transfer, candidates)?.source ?? null;
  }
  chooseTransferReceiver(actor, from, candidates) {
    const plan = this.chooseTransferCombination(actor, CARD_DEFINITIONS.transfer, [from], new Set(candidates.map((player) => player.id)));
    return candidates.find((player) => player.id === plan?.receiverId) ?? null;
  }

  /** 联合评估来源、接收者和手牌；未知牌只使用数量、上限压力与合法已知概率。 */
  chooseTransferCombination(actor, card, sources, allowedReceiverIds = null, excludedCardIds = null) {
    const candidates = buildTransferCandidates({
      actor, sources, allowedReceiverIds, excludedCardIds,
      getReceivers:(from) => RuleEngine.getTransferReceivers(this.game, actor, from, card)
    });
    return chooseBestPositiveTransfer(candidates);
  }
  choosePublicCard(player, cards) { return [...cards].sort((a,b) => b.aiValue - a.aiValue)[0] ?? null; }
  chooseDiscards(player, count) {
    const enemies = this.game.getEnemies(player);
    const stranded = enemies.length > 0 && !enemies.some((enemy) => DistanceSystem.inAttackRange(this.game, player, enemy));
    const value = (card) => {
      let score = card.aiValue;
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
