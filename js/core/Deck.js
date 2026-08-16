/**
 * 本文件根据 cardConfig 创建实体牌堆，并管理抽牌、弃牌、结算区与重洗。
 * 它依赖卡牌配置和随机工具，不负责合法性、日志或卡牌效果。
 * 所有在手牌、装备区或 resolvingCards 中的卡都不会进入重洗来源。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260815-shadow-agent-p1-slot";
import { createDeckZoneState } from "../domain/state/model/ZoneState.js?build=20260815-shadow-agent-p1-slot";
import { appendCardToZone, commitDeckBuild, commitReshuffle, moveCardBetweenZones, removeCardFromZone, takeTopCard } from "../domain/state/transitions/ZoneTransitions.js?build=20260815-shadow-agent-p1-slot";
import { createId, shuffled } from "../utils/helpers.js?build=20260815-shadow-agent-p1-slot";
import { Debug } from "../utils/debug.js?build=20260815-shadow-agent-p1-slot";

export class Deck {
  /*
  功能
  创建 Deck runtime 并组合 Domain zone state 初始数组。

  调用方
  Game constructor 与测试 fixture。

  输入
  可替换随机源。

  输出
  初始化完成的 Deck 实例。

  读取状态
  Domain ZoneState 初始 shape。

  写入状态
  Deck 字段。

  调用函数
  createDeckZoneState。

  边界与不变量
  四个牌区数组保持 Domain factory 提供的同一身份；reshuffleCount 是 diagnostics/test observability legacy extension；随机源不属于 Domain state。
  */
  constructor(random = Math.random) {
    this.random = random;
    const zoneState = createDeckZoneState();
    this.cards = zoneState.cards;
    this.discardPile = zoneState.discardPile;
    this.resolvingCards = zoneState.resolvingCards;
    this.judgmentZone = zoneState.judgmentZone;
    this.reshuffleCount = 0;
  }

  /*
  功能
  根据集中配置创建实体牌并执行 Fisher-Yates 洗牌。

  调用方
  Game.confirmGeneral 与测试。

  输入
  authoritative state。

  输出
  创建的卡牌总数。

  读取状态
  CARD_DEFINITIONS 与随机源。

  写入状态
  Deck 四区经 atomic ZoneTransition。

  调用函数
  shuffled、commitDeckBuild。

  边界与不变量
  createId 与 random 调用顺序不变。
  */
  build(state) {
    this.reshuffleCount = 0;
    const builtCards = [];
    for (const definition of Object.values(CARD_DEFINITIONS)) {
      for (let count = 0; count < definition.count; count += 1) {
        builtCards.push({ ...definition, id: createId("card") });
      }
    }
    const shuffledCards = shuffled(builtCards, this.random);
    commitDeckBuild(state, this, shuffledCards, [], [], []);
    Debug.log("Deck", `创建并洗牌 ${this.cards.length} 张`);
    return this.cards.length;
  }

  /*
  功能
  抽取一张牌；空牌堆时先重洗弃牌堆。

  调用方
  Game/PublicCardPool/Judgment workflow。

  输入
  authoritative state。

  输出
  抽到的 Card entity 或 null。

  读取状态
  cards/discardPile 与随机源。

  写入状态
  cards 经 ZoneTransition；reshuffle 经 atomic commit。

  调用函数
  reshuffle、takeTopCard。

  边界与不变量
  RNG 调用顺序不变。
  */
  drawOne(state) {
    if (!this.cards.length) this.reshuffle(state);
    return takeTopCard(state, this.cards);
  }

  /*
  功能
  将弃牌堆洗回抽牌堆。

  调用方
  drawOne 与测试。

  输入
  authoritative state。

  输出
  是否实际重洗。

  读取状态
  discardPile 与随机源。

  写入状态
  cards/discardPile 经 atomic ZoneTransition；reshuffleCount 只作 diagnostics。

  调用函数
  shuffled、commitReshuffle。

  边界与不变量
  结算区不参与；RNG 调用顺序不变。
  */
  reshuffle(state) {
    if (!this.discardPile.length) return false;
    const shuffledCards = shuffled(this.discardPile, this.random);
    commitReshuffle(state, this, shuffledCards);
    this.reshuffleCount += 1;
    Debug.log("Deck", `重洗后牌堆 ${this.cards.length} 张`);
    return true;
  }

  /*
  功能
  将一张已离开手牌的卡放入结算区。

  调用方
  Game.moveHandToResolving 与 draw workflow。

  输入
  authoritative state 与 Card entity。

  输出
  追加成功返回 true。

  读取状态
  当前牌区数组。

  写入状态
  resolvingCards 经 ZoneTransition。

  调用函数
  appendCardToZone。

  边界与不变量
  同一实例不会重复加入；调用方保留校验。
  */
  beginResolve(state, card) {
    if (!card || this.cards.includes(card) || this.discardPile.includes(card)
      || this.resolvingCards.includes(card) || this.judgmentZone.includes(card)) return false;
    appendCardToZone(state, this.resolvingCards, card);
    return true;
  }

  /*
  功能
  将结算区卡提交到弃牌堆。

  调用方
  Game.finishResolvingToDiscard。

  输入
  authoritative state 与 Card entity。

  输出
  提交成功返回 true。

  读取状态
  resolvingCards 与 discardPile。

  写入状态
  两牌区经 ZoneTransition。

  调用函数
  moveCardBetweenZones。

  边界与不变量
  装备牌仍由 equip 路径处理。
  */
  finishResolveToDiscard(state, card) {
    const index = this.resolvingCards.indexOf(card);
    if (index < 0 || this.discardPile.includes(card)) return false;
    moveCardBetweenZones(state, this.resolvingCards, this.discardPile, card);
    return true;
  }

  /*
  功能
  从结算区移除将要进入装备区的牌。

  调用方
  Game.equipCard。

  输入
  authoritative state 与 Card entity。

  输出
  移除成功返回 true。

  读取状态
  resolvingCards。

  写入状态
  resolvingCards 经 ZoneTransition。

  调用函数
  removeCardFromZone。

  边界与不变量
  不处理装备槽写入。
  */
  finishResolveToEquipment(state, card) {
    if (this.resolvingCards.indexOf(card) < 0) return false;
    removeCardFromZone(state, this.resolvingCards, card);
    return true;
  }

  /*
  功能
  将公开弃置或被替换的牌加入弃牌堆。

  调用方
  Game 与 PublicCardPool。

  输入
  authoritative state 与 Card entity。

  输出
  追加成功返回 true。

  读取状态
  discardPile/resolvingCards/judgmentZone。

  写入状态
  discardPile 经 ZoneTransition。

  调用函数
  appendCardToZone。

  边界与不变量
  重复实例校验保持不变。
  */
  discard(state, card) {
    if (!card || this.discardPile.includes(card) || this.resolvingCards.includes(card) || this.judgmentZone.includes(card)) return false;
    appendCardToZone(state, this.discardPile, card);
    return true;
  }

  /*
  功能
  从牌堆抽取一张牌并放入独立判定区。

  调用方
  JudgmentSystem。

  输入
  authoritative state。

  输出
  判定 Card entity 或 null。

  读取状态
  牌堆与判定区。

  写入状态
  judgmentZone 经 ZoneTransition。

  调用函数
  drawOne、appendCardToZone。

  边界与不变量
  不处理判定结果。
  */
  drawToJudgment(state) {
    const card = this.drawOne(state);
    if (!card) return null;
    appendCardToZone(state, this.judgmentZone, card);
    return card;
  }

  /*
  功能
  将判定区卡提交到弃牌堆。

  调用方
  JudgmentSystem。

  输入
  authoritative state 与 Card entity。

  输出
  提交成功返回 true。

  读取状态
  judgmentZone 与 discardPile。

  写入状态
  两牌区经 ZoneTransition。

  调用函数
  moveCardBetweenZones。

  边界与不变量
  不解释判定结果。
  */
  finishJudgmentToDiscard(state, card) {
    const index = this.judgmentZone.indexOf(card);
    if (index < 0) return false;
    moveCardBetweenZones(state, this.judgmentZone, this.discardPile, card);
    return true;
  }

  /*
  功能
  将判定区卡提交到指定玩家手牌。

  调用方
  JudgmentSystem。

  输入
  authoritative state、Card entity 与 Player。

  输出
  提交成功返回 true。

  读取状态
  judgmentZone 与 player.hand。

  写入状态
  两牌区经 ZoneTransition。

  调用函数
  moveCardBetweenZones。

  边界与不变量
  不负责 handVersion 或知识失效。
  */
  finishJudgmentToHand(state, card, player) {
    const index = this.judgmentZone.indexOf(card);
    if (index < 0) return false;
    moveCardBetweenZones(state, this.judgmentZone, player.hand, card);
    return true;
  }
}
