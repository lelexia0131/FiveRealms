/**
 * 本文件根据 cardConfig 创建实体牌堆，并管理抽牌、弃牌、结算区与重洗。
 * 它依赖卡牌配置和随机工具，不负责合法性、日志或卡牌效果。
 * 所有在手牌、装备区或 resolvingCards 中的卡都不会进入重洗来源。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260810-guardian-aid-turn-v161";
import { createId, shuffled } from "../utils/helpers.js?build=20260810-guardian-aid-turn-v161";
import { Debug } from "../utils/debug.js?build=20260810-guardian-aid-turn-v161";

export class Deck {
  constructor(random = Math.random) {
    this.random = random;
    /** @type {Array<Object>} */ this.cards = [];
    /** @type {Array<Object>} */ this.discardPile = [];
    /** @type {Array<Object>} */ this.resolvingCards = [];
    /** @type {Array<Object>} */ this.judgmentZone = [];
    this.reshuffleCount = 0;
  }

  /**
   * 根据集中配置创建唯一实例并执行 Fisher-Yates 洗牌；新对局只调用一次。
   * @returns {number} 创建的卡牌总数。
   */
  build() {
    this.cards = [];
    this.discardPile = [];
    this.resolvingCards = [];
    this.judgmentZone = [];
    this.reshuffleCount = 0;
    for (const definition of Object.values(CARD_DEFINITIONS)) {
      for (let count = 0; count < definition.count; count += 1) {
        this.cards.push({ ...definition, id: createId("card") });
      }
    }
    this.cards = shuffled(this.cards, this.random);
    Debug.log("Deck", `创建并洗牌 ${this.cards.length} 张`);
    return this.cards.length;
  }

  /**
   * 抽取一张牌。牌堆为空时仅重洗弃牌堆；若两者都空则安全返回 null。
   * @returns {Object|null} 抽到的实体牌。
   */
  drawOne() {
    if (!this.cards.length) this.reshuffle();
    return this.cards.pop() ?? null;
  }

  /** 将弃牌堆洗回抽牌堆，结算区不会参与；返回是否实际重洗。 */
  reshuffle() {
    if (!this.discardPile.length) return false;
    this.cards = shuffled(this.discardPile, this.random);
    this.discardPile = [];
    this.reshuffleCount += 1;
    Debug.log("Deck", `重洗后牌堆 ${this.cards.length} 张`);
    return true;
  }

  /** 将一张已离开手牌的卡放入结算区；同一实例不会重复加入。 */
  beginResolve(card) {
    if (!card || this.cards.includes(card) || this.discardPile.includes(card)
      || this.resolvingCards.includes(card) || this.judgmentZone.includes(card)) return false;
    this.resolvingCards.push(card);
    return true;
  }

  /** 从结算区移除卡并放入弃牌堆；装备牌应改由 equip 完成而不调用此方法。 */
  finishResolveToDiscard(card) {
    const index = this.resolvingCards.indexOf(card);
    if (index < 0 || this.discardPile.includes(card)) return false;
    this.resolvingCards.splice(index, 1);
    this.discardPile.push(card);
    return true;
  }

  /** 从结算区移除将要进入装备区的牌，不加入弃牌堆。 */
  finishResolveToEquipment(card) {
    const index = this.resolvingCards.indexOf(card);
    if (index < 0) return false;
    this.resolvingCards.splice(index, 1);
    return true;
  }

  /** 将公开弃置或被替换的牌加入弃牌堆；重复实例会被拒绝。 */
  discard(card) {
    if (!card || this.discardPile.includes(card) || this.resolvingCards.includes(card) || this.judgmentZone.includes(card)) return false;
    this.discardPile.push(card);
    return true;
  }

  drawToJudgment() {
    const card = this.drawOne();
    if (!card) return null;
    this.judgmentZone.push(card);
    return card;
  }

  finishJudgmentToDiscard(card) {
    const index = this.judgmentZone.indexOf(card);
    if (index < 0) return false;
    this.judgmentZone.splice(index, 1);
    this.discardPile.push(card);
    return true;
  }

  finishJudgmentToHand(card, player) {
    const index = this.judgmentZone.indexOf(card);
    if (index < 0) return false;
    this.judgmentZone.splice(index, 1);
    player.hand.push(card);
    return true;
  }
}
