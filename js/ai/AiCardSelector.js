/**
 * AI 实体选牌策略。处理弃牌、公共牌和隐藏位置；已知实体可定向选择，未知牌只能
 * 按位置/随机源选择，绝不能通过 owner.hand 中的 definitionId 偷看后再决定位置。
 */
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260730-tabletop-hands-v25";

/** 未知手牌只按位置采样，绝不按真实定义筛选。 */
export class AiCardSelector {
  constructor(game, knowledge) { this.game = game; this.knowledge = knowledge; }

  chooseHiddenCards(actor, owner, count) {
    const selected = [];
    const known = actor.aiMemory.knownCardsByPlayer[owner.id] ?? {};
    const cards = [...owner.hand];
    while (selected.length < count && cards.length) {
      let index = -1;
      if (actor.id === owner.id) {
        index = cards.reduce((best, card, current) => card.aiValue < cards[best].aiValue ? current : best, 0);
      } else {
        const knownIndex = cards.findIndex((card) => known[card.id]);
        index = knownIndex >= 0 ? knownIndex : Math.floor(this.game.random() * cards.length);
      }
      selected.push(cards.splice(Math.max(0, index), 1)[0]);
    }
    return selected;
  }

  chooseTransferSource(actor, candidates) {
    const allies = candidates.filter((player) => player.battleTeam === actor.battleTeam);
    const enemies = candidates.filter((player) => player.battleTeam !== actor.battleTeam);
    return enemies.sort((a,b) => b.hand.length - a.hand.length)[0] ?? allies.sort((a,b) => b.hand.length - a.hand.length)[0] ?? null;
  }
  chooseTransferReceiver(actor, from, candidates) {
    return candidates.filter((player) => player.battleTeam === actor.battleTeam).sort((a,b) => a.hand.length - b.hand.length)[0]
      ?? candidates.find((player) => player.id !== from?.id) ?? null;
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
