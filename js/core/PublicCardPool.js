/**
 * 互利的公开牌池。依赖 Deck、AI 选牌器和 UI；展示中的实体独立于抽牌、弃牌
 * 与判定区。这里负责公开选取和合法记忆，不处理其他隐藏手牌选择。
 */
export class PublicCardPool {
  constructor(game) { this.game = game; this.cards = []; }

  reveal(count) {
    this.cards = [];
    for (let index = 0; index < count; index += 1) {
      const card = this.game.state.deck.drawOne();
      if (!card) break;
      this.cards.push(card);
    }
    this.game.state.publicCardPool = this.cards;
    this.game.ui.showPublicPool?.(this.cards);
    return this.cards;
  }

  async draft(source) {
    const living = this.game.seatOrderFrom(source, true);
    for (const player of living) {
      if (!this.cards.length || this.game.state.isGameOver) break;
      let card = null;
      if (player.controllerType === "human") card = await this.game.ui.requestPublicCard?.(player, this.cards);
      else card = this.game.aiController.cardSelector.choosePublicCard(player, this.cards);
      if (!this.cards.includes(card)) card = this.cards[0];
      this.cards.splice(this.cards.indexOf(card), 1);
      player.hand.push(card);
      player.bumpHandVersion();
      for (const viewer of this.game.state.players) if (viewer.id !== player.id) this.game.rememberPrivateCard(viewer, player, card);
      this.game.log(`${player.name}从互利牌池选择了「${card.name}」。`);
      this.game.ui.render(this.game);
    }
    for (const card of this.cards.splice(0)) this.game.state.deck.discard(card);
    this.game.state.publicCardPool = [];
    this.game.ui.hidePublicPool?.();
  }

  cleanup() { this.cards = []; this.game.state.publicCardPool = []; }
}
