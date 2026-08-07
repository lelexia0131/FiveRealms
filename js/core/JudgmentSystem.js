/**
 * 雷达的公开判定流程。依赖 Deck、EventBus 与 UI 展示；
 * 判定牌先进入独立判定区再去手牌或弃牌堆，绝不能在处理中参与重洗。
 */
export class JudgmentSystem {
  constructor(game) { this.game = game; }

  async judgeDefense(attacker, defender, attackContext) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId)) return { handled:false, immune:false, cancelled:true };
    if (defender.equipment?.definitionId !== "defenseDevice") return { handled:false, immune:false };
    const card = this.game.state.deck.drawToJudgment();
    this.game.syncDeckAliases();
    if (!card) return { handled:false, immune:false };
    const previousPhase = this.game.state.phase;
    this.game.state.phase = "judgment";
    this.game.state.currentJudgment = { card, defenderId:defender.id, attackerId:attacker?.id ?? null };
    this.game.ui.showJudgment?.(defender, card);
    this.game.log(`${defender.name}的雷达判定为「${card.name}」（${card.categoryName}）。`, "important");
    await this.game.eventBus.emit("judgmentRevealed", { type:"judgmentRevealed", attacker, defender, card, attackContext });
    if (!this.game.isSessionValid(gameId)) return { handled:false, immune:false, cancelled:true };
    let result;
    if (card.category === "tactic") {
      this.game.state.deck.finishJudgmentToDiscard(card);
      this.game.log(`战术判定令${defender.name}免疫此次突袭。`, "important");
      result = { handled:true, immune:true, category:"tactic" };
    } else if (card.category === "basic") {
      this.game.state.deck.finishJudgmentToHand(card, defender);
      defender.bumpHandVersion();
      for (const viewer of this.game.state.players) if (viewer.id !== defender.id) this.game.rememberPrivateCard(viewer, defender, card);
      this.game.log(`${defender.name}获得了判定牌，原突袭继续。`);
      result = { handled:true, immune:false, category:"basic" };
    } else {
      this.game.state.deck.finishJudgmentToDiscard(card);
      this.game.log(`装备判定失败，判定牌进入弃牌堆；${defender.name}不直接失去生命，原突袭继续。`, "important");
      result = { handled:true, immune:false, category:"equipment" };
    }
    this.game.state.currentJudgment = null;
    this.game.ui.hideJudgment?.();
    if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
    this.game.syncDeckAliases();
    this.game.ui.render(this.game);
    return result;
  }

  /**
   * 闪电状态判定：翻开一张判定牌并公开展示，判定牌最终一律进入弃牌堆。
   * 触发条件只按卡牌类别判断（equipment），不枚举具体装备 definitionId。
   * @returns {Promise<{handled:boolean, triggered:boolean, category:string|null, cancelled?:boolean}>}
   */
  async judgeLightning(holder, context = {}) {
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId)) return { handled:false, triggered:false, cancelled:true };
    if (!holder?.alive || !this.game.state.players.some((entry) => entry === holder && entry.alive)) return { handled:false, triggered:false };
    const card = this.game.state.deck.drawToJudgment();
    this.game.syncDeckAliases();
    if (!card) {
      this.game.log(`没有可翻开的判定牌，「闪电」结算顺延。`);
      return { handled:false, triggered:false };
    }
    const categoryLabel = card.category === "basic" ? "基础牌"
      : card.category === "tactic" ? "战术牌"
        : card.category === "equipment" ? "装备牌" : card.categoryName;
    const previousPhase = this.game.state.phase;
    this.game.state.phase = "judgment";
    this.game.state.currentJudgment = { card, defenderId:holder.id, attackerId:null, statusId:"lightning" };
    this.game.ui.showJudgment?.(holder, card);
    this.game.log(`${holder.name}的「闪电」判定为「${card.name}」，为${categoryLabel}。`, "important");
    await this.game.eventBus.emit("judgmentRevealed", {
      type:"judgmentRevealed", attacker:null, defender:holder, card, statusId:"lightning", lightningContext:context
    });
    if (!this.game.isSessionValid(gameId)) return { handled:false, triggered:false, cancelled:true };
    const triggered = card.category === "equipment";
    this.game.state.deck.finishJudgmentToDiscard(card);
    if (triggered) this.game.log(`${holder.name}的「闪电」判定触发。`, "important");
    this.game.state.currentJudgment = null;
    this.game.ui.hideJudgment?.();
    if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
    this.game.syncDeckAliases();
    this.game.ui.render(this.game);
    return { handled:true, triggered, category:card.category, card };
  }
}
