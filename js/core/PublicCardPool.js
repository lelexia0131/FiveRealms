/**
 * 互利的公开牌池。依赖 Deck、AI 选牌器和 UI；展示中的实体独立于抽牌、弃牌
 * 与判定区。这里负责公开选取和合法记忆，不处理其他隐藏手牌选择。
 */
export class PublicCardPool {
  constructor(game) { this.game = game; this.cards = []; }

  reveal(count) {
    if (!this.game.isSessionValid(this.game.state.gameId) || this.game.state.isGameOver) return [];
    this.cards = [];
    for (let index = 0; index < count; index += 1) {
      const card = this.game.state.deck.drawOne();
      if (!card) break;
      this.cards.push(card);
    }
    this.game.syncDeckAliases();
    this.game.state.publicCardPool = this.cards;
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
          card = await this.game.ui.requestPublicCard?.(player, offeredCards);
          if (!this.game.isSessionValid(gameId) || this.game.state.isGameOver) return false;
          // 有效对局中的意外 null 或过期选择不能中止整张互利，重新请求当前角色选择。
          if (!card || !this.cards.includes(card)) card = null;
        }
      } else card = this.game.aiController.choosePublicCard(player, this.cards);
      if (!this.game.isSessionValid(gameId) || this.game.state.isGameOver) return false;
      if (!player.alive) continue;
      if (!this.cards.length) break;
      if (!this.cards.includes(card)) {
        if (player.controllerType === "human") continue;
        card = this.cards[0];
      }
      if (!card) continue;
      const cardIndex = this.cards.indexOf(card);
      if (cardIndex < 0) continue;
      this.cards.splice(cardIndex, 1);
      player.hand.push(card);
      player.bumpHandVersion();
      for (const viewer of this.game.state.players) if (viewer.id !== player.id) this.game.rememberPrivateCard(viewer, player, card);
      this.game.log(`${player.name}从互利牌池选择了「${card.name}」。`);
      this.game.ui.render(this.game);
      this.game.ui.showPublicPool?.(this.cards);
    }
    if (!this.game.isSessionValid(gameId)) return false;
    for (const card of this.cards.splice(0)) this.game.state.deck.discard(card);
    this.game.state.publicCardPool = [];
    this.game.ui.hidePublicPool?.();
    return true;
  }

  cleanup() { this.cards = []; this.game.state.publicCardPool = []; }
}
