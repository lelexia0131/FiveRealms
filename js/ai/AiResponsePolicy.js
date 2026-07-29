/**
 * AI 响应效用策略。依赖公开上下文、团队规则与评估器；决定格挡、反制、交牌、
 * 决斗和救援，不消费卡牌。未知信息只能来自传入概率/合法记忆。
 */
export class AiResponsePolicy {
  constructor(game, evaluator, knowledge) { this.game = game; this.evaluator = evaluator; this.knowledge = knowledge; }

  assessDyingRescue(responder, target) {
    const need = Math.max(1, 1 - target.hp);
    const ownRecover = responder.hand.filter((card) => card.definitionId === "recover").length;
    const order = this.game.dyingSystem.rescueOrder(target);
    const responderIndex = order.findIndex((player) => player.id === responder.id);
    const later = responderIndex < 0 ? [] : order.slice(responderIndex + 1);
    const futurePotential = later.reduce((sum, player) => {
      const known = responder.aiMemory.knownCardsByPlayer[player.id] ?? {};
      const knownRecover = Object.values(known).filter((definitionId) => definitionId === "recover").length;
      const unknownCards = Math.max(0, player.hand.length - Object.keys(known).length);
      // 不读取队友真实手牌；有未知手牌时只记作一份“可能贡献”。
      return sum + knownRecover + (unknownCards > 0 ? 1 : 0);
    }, 0);
    const possibleRescues = ownRecover + futurePotential;
    const remainingAfterThisCard = Math.max(0, need - 1);
    const aliveTeam = this.game.state.players.filter((player) => player.alive && player.battleTeam === target.battleTeam);
    const roleTags = target.general?.roleTags ?? [];
    const strategic = roleTags.some((tag) => ["support", "healer", "damage", "control", "tank"].includes(tag));
    const actionValue = target.hand.length * 1.25 + target.energy * 1.1 + (target.equipment ? 2 : 0) + (strategic ? 3 : 0);
    const teamCritical = aliveTeam.length <= 2;
    const lastRecoverPenalty = ownRecover === 1 ? (responder.hp <= 2 ? 3 : 1.5) : 0;
    const cooperationBonus = ownRecover < need && possibleRescues >= need ? 5 : 0;
    const score = 5 + actionValue + (teamCritical ? 7 : 0) + cooperationBonus - lastRecoverPenalty - remainingAfterThisCard * 2;
    return { need, ownRecover, futurePotential, possibleRescues, remainingAfterThisCard, strategic, teamCritical, actionValue, score };
  }

  shouldRespond(responder, type, context, cards = []) {
    const target = context.target ?? responder;
    if (type === "dyingRescue") {
      if (target.id === responder.id) return true;
      if (target.battleTeam !== responder.battleTeam) return false;
      const assessment = this.assessDyingRescue(responder, target);
      if (!assessment.ownRecover || assessment.possibleRescues < assessment.need) return false;
      return assessment.score > 0;
    }
    if (type === "block") {
      const incoming = context.amount ?? 1;
      const lethal = incoming - target.shield >= target.hp;
      if (this.game.teamRules.isSmallTeam(responder)) return true;
      return lethal || target.hp <= 2 || cards.length <= responder.hand.length / 2;
    }
    if (type === "counter") {
      const sourceEnemy = context.source?.battleTeam !== responder.battleTeam;
      const id = context.card?.definitionId;
      if (id === "symbiosis") {
        const net = this.evaluator.symbiosisNet(responder);
        if (net > 0) return false;
        if (net < 0) return true;
      }
      const teamSwing = ["shockwave","provoke","symbiosis","mutualBenefit","duel"].includes(id);
      if (sourceEnemy && this.game.teamRules.isSmallTeam(responder)) return teamSwing || (context.card?.aiValue ?? 0) >= 5;
      return sourceEnemy ? teamSwing || (context.card?.aiValue ?? 0) >= 7 : id === "symbiosis" && this.evaluator.symbiosisNet(responder) < 0;
    }
    if (type === "assaultDiscard") {
      if (context.card?.definitionId === "provoke") return responder.hp <= 2 || responder.hand.length > 2;
      if (context.card?.definitionId === "duel") return true;
      return responder.hp <= 2 || responder.hand.filter((card) => card.definitionId === "assault").length > 1;
    }
    if (type === "skill") return (context.amount ?? 1) > 0;
    return false;
  }
}
