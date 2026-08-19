/**
 * 互利的公开牌池。依赖 Deck、ChoiceCoordinator 和 PresentationPort；展示中的实体
 * 独立于抽牌、弃牌与判定区。这里负责公开选取和合法记忆，不处理其他隐藏手牌选择。
 */
import { createId } from "../../utils/helpers.js";
import { createPublicCardChoiceRequest } from "../choice/PublicCardChoiceRequest.js";
import { setPublicCardPool } from "../../domain/state/transitions/MatchStateTransitions.js";
import { appendCardToZone, moveCardBetweenZones, moveCardsAtomically } from "../../domain/state/transitions/ZoneTransitions.js";
import { bumpHandVersion } from "../../domain/state/transitions/PlayerStateTransitions.js";

export class PublicCardPoolWorkflow {
  /*
  功能
  创建并初始化 PublicCardPoolWorkflow 实例。

  调用方
  createGameApplication composition root。

  输入
  仅含 state、session、choice、knowledge、seat order 与 PresentationPort 的 runtime capabilities。

  输出
  初始化完成的 PublicCardPoolWorkflow 实例。

  读取状态
  注入的 runtime capabilities。

  写入状态
  初始化本地公开牌池数组。

  调用函数
  无。

  边界与不变量
  不持有 concrete UI 或整局 Application 对象；展示只能经过 PresentationPort。
  */
  constructor(runtime) { this.runtime = runtime; this.cards = []; }

  /*
  功能
  揭示指定数量的公开牌池卡并提交 publicCardPool 引用。

  调用方
  CardEffectRuntime 的互利结算入口。

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
  不执行轮选；PresentationPort 只接收公开 card ID，不接收 Card entity。
  */
  reveal(count) {
    if (!this.runtime.isSessionValid(this.runtime.getState().gameId) || this.runtime.getState().isGameOver) return [];
    this.cards = [];
    for (let index = 0; index < count; index += 1) {
      const card = this.runtime.getState().deck.drawOne(this.runtime.getState());
      if (!card) break;
      appendCardToZone(this.runtime.getState(), this.cards, card);
    }
    this.runtime.syncDeckAliases();
    setPublicCardPool(this.runtime.getState(), this.cards);
    this.runtime.presentation.showPublicCardPool({ cardIds:this.cards.map((card) => card.id) });
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
  当前 MatchState、公开牌池与 Choice/Presentation ports。

  写入状态
  玩家手牌、合法记忆、公开牌池、弃牌堆与 presentation state。

  调用函数
  seatOrderFrom、ChoiceCoordinator、PresentationPort 与 ZoneTransitions。

  边界与不变量
  真人的无效选择会在有效会话内重开；AI 无效返回安全退化为当前首牌；牌池展示只跨边界传 ID。
  */
  async draft(source) {
    const gameId = this.runtime.getState().gameId;
    const living = this.runtime.seatOrderFrom(source, true).filter((player) => player.alive);
    for (const player of living) {
      if (!this.runtime.isSessionValid(gameId) || this.runtime.getState().isGameOver) return false;
      if (!this.cards.length) break;
      if (!player.alive) continue;
      let card = null;
      if (player.controllerType === "human") {
        while (!card && this.cards.length && player.alive) {
          const offeredCards = [...this.cards];
          card = await this.#requestPublicCardChoice(player, offeredCards);
          if (!this.runtime.isSessionValid(gameId) || this.runtime.getState().isGameOver) return false;
          // 有效对局中的意外 null 或过期选择不能中止整张互利，重新请求当前角色选择。
          if (!card || !this.cards.includes(card)) card = null;
        }
      } else card = await this.#requestPublicCardChoice(player, this.cards);
      if (!this.runtime.isSessionValid(gameId) || this.runtime.getState().isGameOver) return false;
      if (!player.alive) continue;
      if (!this.cards.length) break;
      if (!this.cards.includes(card)) {
        if (player.controllerType === "human") continue;
        card = this.cards[0];
      }
      if (!card) continue;
      if (!this.cards.includes(card)) continue;
      moveCardBetweenZones(this.runtime.getState(), this.cards, player.hand, card);
      bumpHandVersion(this.runtime.getState(), player);
      for (const viewer of this.runtime.getState().players) if (viewer.id !== player.id) this.runtime.rememberPrivateCard(viewer, player, card);
      this.runtime.log(`${player.name}从互利牌池选择了「${card.name}」。`);
      this.runtime.presentation.refresh();
      this.runtime.presentation.showPublicCardPool({ cardIds:this.cards.map((entry) => entry.id) });
    }
    if (!this.runtime.isSessionValid(gameId)) return false;
    if (this.cards.length) moveCardsAtomically(
      this.runtime.getState(),
      this.cards,
      this.runtime.getState().deck.discardPile,
      [...this.cards]
    );
    setPublicCardPool(this.runtime.getState(), []);
    this.runtime.presentation.hidePublicCardPool();
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
  MatchState.stateVersion 与公开牌池实体。

  写入状态
  choiceContexts registry 仅在本方法调用期间保存 bridge context。

  调用函数
  createPublicCardChoiceRequest、game.choiceCoordinator.request。

  边界与不变量
  ChoiceRequest 只含公开 card id/definition；返回后仍由 draft 复核实体仍在 this.cards。
  */
  async #requestPublicCardChoice(player, offeredCards) {
    const requestId = createId("public-card-choice");
    this.runtime.choiceContexts?.set(requestId, { player, cards: offeredCards });
    try {
      const result = await this.runtime.choiceCoordinator.request(createPublicCardChoiceRequest({
        requestId,
        actorId: player.id,
        gameId: this.runtime.getState().gameId,
        stateVersion: this.runtime.getState().stateVersion,
        offeredCards
      }));
      if (result.status !== "selected") return null;
      return offeredCards.find((card) => card.id === result.selectedIds[0]) ?? null;
    } finally {
      this.runtime.choiceContexts?.delete(requestId);
    }
  }

  /*
  功能
  清空公开牌池本地数组并提交空 publicCardPool。

  调用方
  MatchWorkflow.dispose 与重新征召。

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
  cleanup() { this.cards = []; setPublicCardPool(this.runtime.getState(), []); }
}
