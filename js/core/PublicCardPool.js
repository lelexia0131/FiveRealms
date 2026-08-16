/**
 * 互利的公开牌池。依赖 Deck、AI 选牌器和 UI；展示中的实体独立于抽牌、弃牌
 * 与判定区。这里负责公开选取和合法记忆，不处理其他隐藏手牌选择。
 */
import { createId } from "../utils/helpers.js?build=20260815-shadow-agent-p1-slot";
import { createPublicCardChoiceRequest } from "../application/choice/PublicCardChoiceRequest.js?build=20260815-shadow-agent-p1-slot";
import { setPublicCardPool } from "../domain/state/transitions/MatchStateTransitions.js?build=20260815-shadow-agent-p1-slot";
import { appendCardToZone, moveCardBetweenZones, moveCardsAtomically } from "../domain/state/transitions/ZoneTransitions.js?build=20260815-shadow-agent-p1-slot";
import { bumpHandVersion } from "../domain/state/transitions/PlayerStateTransitions.js?build=20260815-shadow-agent-p1-slot";

export class PublicCardPool {
  constructor(game) { this.game = game; this.cards = []; }

  /*
  功能
  揭示指定数量的公开牌池卡并提交 publicCardPool 引用。

  调用方
  cardRegistry.mutualBenefit。

  输入
  count。

  输出
  本次公开的 Card 数组。

  读取状态
  Deck 牌堆。

  写入状态
  publicCardPool 经 MatchStateTransition。

  调用函数
  setPublicCardPool、Deck.drawOne。

  边界与不变量
  不执行轮选。
  */
  reveal(count) {
    if (!this.game.isSessionValid(this.game.state.gameId) || this.game.state.isGameOver) return [];
    this.cards = [];
    for (let index = 0; index < count; index += 1) {
      const card = this.game.state.deck.drawOne(this.game.state);
      if (!card) break;
      appendCardToZone(this.game.state, this.cards, card);
    }
    this.game.syncDeckAliases();
    setPublicCardPool(this.game.state, this.cards);
    this.game.ui.showPublicPool?.(this.cards);
    return this.cards;
  }

  /*
  功能
  按存活座次完成公开牌池轮选并清理剩余牌。

  调用方
  互利卡牌真实结算。

  输入
  发起轮选的 Player。

  输出
  完成返回 true；会话失效或游戏结束返回 false。

  读取状态
  当前 GameState、公开牌池、UI 与 AIController 公开选牌门面。

  写入状态
  玩家手牌、合法记忆、公开牌池、弃牌堆与 UI。

  调用函数
  Game.seatOrderFrom、UI.requestPublicCard、AIController.choosePublicCard、Deck.discard。

  边界与不变量
  真人的无效选择会在有效会话内重开；AI 无效返回安全退化为当前首牌。
  */
  async draft(source) {
    const gameId = this.game.state.gameId;
    const living = this.game.seatOrderFrom(source, true).filter((player) => player.alive);
    for (const player of living) {
      if (!this.game.isSessionValid(gameId) || this.game.state.isGameOver) return false;
      if (!this.cards.length) break;
      if (!player.alive) continue;
      let card = null;
      if (player.controllerType === "human") {
        while (!card && this.cards.length && player.alive) {
          const offeredCards = [...this.cards];
          card = await this.#requestPublicCardChoice(player, offeredCards);
          if (!this.game.isSessionValid(gameId) || this.game.state.isGameOver) return false;
          // 有效对局中的意外 null 或过期选择不能中止整张互利，重新请求当前角色选择。
          if (!card || !this.cards.includes(card)) card = null;
        }
      } else card = await this.#requestPublicCardChoice(player, this.cards);
      if (!this.game.isSessionValid(gameId) || this.game.state.isGameOver) return false;
      if (!player.alive) continue;
      if (!this.cards.length) break;
      if (!this.cards.includes(card)) {
        if (player.controllerType === "human") continue;
        card = this.cards[0];
      }
      if (!card) continue;
      if (!this.cards.includes(card)) continue;
      moveCardBetweenZones(this.game.state, this.cards, player.hand, card);
      bumpHandVersion(this.game.state, player);
      for (const viewer of this.game.state.players) if (viewer.id !== player.id) this.game.rememberPrivateCard(viewer, player, card);
      this.game.log(`${player.name}从互利牌池选择了「${card.name}」。`);
      this.game.ui.render(this.game);
      this.game.ui.showPublicPool?.(this.cards);
    }
    if (!this.game.isSessionValid(gameId)) return false;
    if (this.cards.length) moveCardsAtomically(
      this.game.state,
      this.cards,
      this.game.state.deck.discardPile,
      [...this.cards]
    );
    setPublicCardPool(this.game.state, []);
    this.game.ui.hidePublicPool?.();
    return true;
  }

  /*
  功能
  通过注入 Choice boundary 请求一次公开牌池选择，并保留实体重验证。

  调用方
  draft。

  输入
  player 与 offeredCards。

  输出
  选中的 Card entity 或 null。

  读取状态
  Game stateVersion 与公开牌池实体。

  写入状态
  choiceContexts registry 仅在本方法调用期间保存 legacy bridge context。

  调用函数
  createPublicCardChoiceRequest、game.choiceCoordinator.request。

  边界与不变量
  ChoiceRequest 只含公开 card id/definition；返回后仍由 draft 复核实体仍在 this.cards。
  */
  async #requestPublicCardChoice(player, offeredCards) {
    const requestId = createId("public-card-choice");
    this.game.choiceContexts?.set(requestId, { player, cards: offeredCards });
    try {
      const result = await this.game.choiceCoordinator.request(createPublicCardChoiceRequest({
        requestId,
        actorId: player.id,
        gameId: this.game.state.gameId,
        stateVersion: this.game.state.stateVersion,
        offeredCards
      }));
      if (result.status !== "selected") return null;
      return offeredCards.find((card) => card.id === result.selectedIds[0]) ?? null;
    } finally {
      this.game.choiceContexts?.delete(requestId);
    }
  }

  /*
  功能
  清空公开牌池本地数组并提交空 publicCardPool。

  调用方
  Game.dispose 与重新征召。

  输入
  无。

  输出
  无返回值。

  读取状态
  this.cards 与 game.state。

  写入状态
  publicCardPool 经 MatchStateTransition。

  调用函数
  setPublicCardPool。

  边界与不变量
  不移动实体牌到弃牌堆。
  */
  cleanup() { this.cards = []; setPublicCardPool(this.game.state, []); }
}
