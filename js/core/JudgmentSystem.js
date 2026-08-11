import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260811-offensive-exposure-v168";

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
    this.game.log(`${defender.name}的「雷达」判定为「${card.name}」（${card.categoryName}）。`, "important");
    await this.game.eventBus.emit("judgmentRevealed", { type:"judgmentRevealed", attacker, defender, card, attackContext });
    if (!this.game.isSessionValid(gameId)) return { handled:false, immune:false, cancelled:true };
    let result;
    if (card.category === "tactic") {
      this.game.state.deck.finishJudgmentToDiscard(card);
      this.game.log(`${defender.name}的「雷达」生效，此次攻击无效。`, "important");
      result = { handled:true, immune:true, category:"tactic" };
    } else if (card.category === "basic") {
      this.game.state.deck.finishJudgmentToHand(card, defender);
      defender.bumpHandVersion();
      for (const viewer of this.game.state.players) if (viewer.id !== defender.id) this.game.rememberPrivateCard(viewer, defender, card);
      this.game.log(`${defender.name}获得判定牌，此次攻击继续结算。`);
      result = { handled:true, immune:false, category:"basic" };
    } else {
      this.game.state.deck.finishJudgmentToDiscard(card);
      this.game.log(`${defender.name}的「雷达」未生效，判定牌进入弃牌堆，此次攻击继续结算。`, "important");
      result = { handled:true, immune:false, category:"equipment" };
    }
    this.game.state.currentJudgment = null;
    this.game.ui.hideJudgment?.();
    if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
    this.game.syncDeckAliases();
    this.game.ui.render(this.game);
    return result;
  }

  /** 延迟战术状态的公共判定：按权威 category 比较，判定牌最终一律进入弃牌堆。 */
  async judgeDelayedStatus(holder, options = {}) {
    const {
      statusId,
      statusName,
      triggerCategory,
      context = {},
      logReveal = true,
      triggerMessage = null,
      statusCard = null
    } = options;
    const gameId = this.game.state.gameId;
    if (!this.game.isSessionValid(gameId)) return { handled:false, triggered:false, cancelled:true };
    if (!holder?.alive || !this.game.state.players.some((entry) => entry === holder && entry.alive)) return { handled:false, triggered:false };
    const card = this.game.state.deck.drawToJudgment();
    this.game.syncDeckAliases();
    if (!card) {
      this.game.log(`没有可翻开的判定牌，「${statusName}」结算顺延。`);
      return { handled:false, triggered:false };
    }
    const categoryLabel = card.category === "basic" ? "基础牌"
      : card.category === "tactic" ? "战术牌"
        : card.category === "equipment" ? "装备牌" : card.categoryName;
    const previousPhase = this.game.state.phase;
    this.game.state.phase = "judgment";
    this.game.state.currentJudgment = { card, defenderId:holder.id, attackerId:null, statusId };
    if (statusCard) this.game.ui.setCurrentCard?.(
      statusCard, "判定中", holder.name
    );
    this.game.ui.showJudgment?.(holder, card, {
      delayedStatusContext:{
        ownerId:holder.id,
        ownerName:holder.name,
        ownerBattleTeam:holder.battleTeam,
        statusId,
        statusName,
        event:"judging"
      }
    });
    if (logReveal) this.game.log(`${holder.name}的「${statusName}」判定为「${card.name}」，为${categoryLabel}。`, "important");
    const revealEvent = {
      type:"judgmentRevealed", attacker:null, defender:holder, card, statusId, statusContext:context
    };
    if (statusId === "lightning") revealEvent.lightningContext = context;
    if (statusId === "sealed") revealEvent.sealContext = context;
    await this.game.eventBus.emit("judgmentRevealed", revealEvent);
    if (!this.game.isSessionValid(gameId)) return { handled:false, triggered:false, cancelled:true };
    const triggered = card.category === triggerCategory;
    this.game.state.deck.finishJudgmentToDiscard(card);
    if (triggered && triggerMessage) this.game.log(triggerMessage(holder, card), "important");
    this.game.state.currentJudgment = null;
    this.game.ui.hideJudgment?.();
    if (!this.game.state.isGameOver) this.game.state.phase = previousPhase;
    this.game.syncDeckAliases();
    this.game.ui.render(this.game);
    return { handled:true, triggered, category:card.category, card };
  }

  async judgeLightning(holder, context = {}) {
    return this.judgeDelayedStatus(holder, {
      statusId:"lightning",
      statusName:"闪电",
      triggerCategory:"equipment",
      context,
      triggerMessage:(target) => `${target.name}的「闪电」判定成功，被「闪电」击中。`,
      statusCard:CARD_DEFINITIONS.lightning
    });
  }

  async judgeSeal(holder, context = {}) {
    return this.judgeDelayedStatus(holder, {
      statusId:"sealed",
      statusName:"封印",
      triggerCategory:"tactic",
      context,
      logReveal:false,
      statusCard:CARD_DEFINITIONS.seal
    });
  }
}
