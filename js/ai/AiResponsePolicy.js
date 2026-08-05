import { GAME_CONFIG } from "../config/gameConfig.js?build=20260805-response-team-color-v83";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260805-response-team-color-v83";
import { createAiVisibleState } from "./AiVisibleState.js?build=20260805-response-team-color-v83";

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
    const recoverDensity = this.knowledge.probability(responder, "recover");
    const futureExpectedRecover = later.reduce((sum, player) => {
      const known = responder.aiMemory.knownCardsByPlayer[player.id] ?? {};
      const knownRecover = Object.values(known).filter((definitionId) => definitionId === "recover").length;
      const unknownCards = Math.max(0, player.hand.length - Object.keys(known).length);
      return sum + knownRecover + unknownCards * recoverDensity;
    }, 0);
    const remainingAfterThisCard = Math.max(0, need - 1);
    const aliveTeam = this.game.state.players.filter((player) => player.alive && player.battleTeam === target.battleTeam);
    const roleTags = target.general?.roleTags ?? [];
    const strategic = roleTags.some((tag) => ["support", "healer", "damage", "control", "tank"].includes(tag));
    const actionValue = target.hand.length * 1.25 + target.energy * 1.1 + (target.equipment ? 2 : 0) + (strategic ? 3 : 0);
    const immediateDefeatRisk = aliveTeam.length <= 2;
    const likelyFollowUp = futureExpectedRecover > 0;
    const lastRecoverPenalty = ownRecover === 1 ? (responder.hp <= 2 ? 3 : 1.5) : 0;
    const score = 3 + actionValue + (immediateDefeatRisk ? 8 : 0) + (likelyFollowUp ? 4 : 0) + (ownRecover > 1 ? 3 : 0) - lastRecoverPenalty - remainingAfterThisCard;
    return { need, ownRecover, recoverDensity, futureExpectedRecover, remainingAfterThisCard, strategic, immediateDefeatRisk, likelyFollowUp, actionValue, score };
  }

  shouldRespond(responder, type, context, cards = []) {
    const target = context.target ?? responder;
    if (type === "dyingRescue") {
      if (target.id === responder.id) return true;
      if (target.battleTeam !== responder.battleTeam) return false;
      // 第二层保障；默认流程会在 ResponseSystem 中更早执行硬规则并绕过本策略。
      if (
        (this.game.forceAiRescueHuman ?? GAME_CONFIG.forceAiRescueHuman) &&
        responder.controllerType === "ai" &&
        target.controllerType === "human"
      ) return true;
      const assessment = this.assessDyingRescue(responder, target);
      if (!assessment.ownRecover) return false;
      return assessment.immediateDefeatRisk || assessment.likelyFollowUp || assessment.strategic || assessment.ownRecover > 1 || assessment.score > 0;
    }
    if (type === "block") {
      const incoming = context.amount ?? 1;
      const lethal = incoming - target.shield >= target.hp;
      const availableBlocks = cards.length;
      const requiredBlocks = Math.max(1, context.requiredCount ?? 1);
      const canPay = availableBlocks >= requiredBlocks;
      if (!canPay) return false;
      const lowHp = target.hp <= 2;
      const blocksAreAbundant = availableBlocks * 2 >= responder.hand.length;
      if (this.game.teamRules.isSmallTeam(responder)) return true;
      return lethal || lowHp || blocksAreAbundant;
    }
    if (type === "counter") {
      const sourceEnemy = context.source?.battleTeam !== responder.battleTeam;
      const id = context.card?.definitionId;
      const globalBenefitDesire = globalBenefitCounterDesire(this.game.state.players, responder.battleTeam, id);
      if (globalBenefitDesire !== null) return globalBenefitDesire > 0;
      const teamSwing = ["shockwave","provoke","duel"].includes(id);
      if (sourceEnemy && this.game.teamRules.isSmallTeam(responder)) return teamSwing || (context.card?.aiValue ?? 0) >= 5;
      return sourceEnemy ? teamSwing || (context.card?.aiValue ?? 0) >= 7 : false;
    }
    if (type === "assaultDiscard") {
      if (context.card?.definitionId === "provoke") return responder.hp <= 2 || responder.hand.length > 2;
      if (context.card?.definitionId === "duel") return true;
      return responder.hp <= 2 || responder.hand.filter((card) => card.definitionId === "assault").length > 1;
    }
    if (type === "leverageAssault") {
      if (!cards.length || !target?.alive) return false;
      const enemyTarget = target.battleTeam !== responder.battleTeam;
      // 借势响应同样只能依据 AI 可见快照评分，不能把真实手牌或内部状态对象交给评估器。
      const visible = createAiVisibleState(responder.id, this.game.state);
      const visibleResponder = visible.players.find((player) => player.id === responder.id);
      const visibleTarget = visible.players.find((player) => player.id === target.id);
      const threat = enemyTarget && visibleResponder && visibleTarget
        ? this.evaluator.threatPriority(visibleResponder, visibleTarget, responder.aiMemory, 1)
        : 0;
      const attackBenefit = enemyTarget
        ? 4 + threat + Math.max(0, target.maxHp - target.hp) * 1.5 + (target.hp <= 1 ? 5 : 0)
        : -10;
      const equipmentValue = Number(context.equipment?.aiValue ?? 5);
      const assaultCount = cards.length;
      const assaultCost = assaultCount <= 1 ? 4.5 : 2.5;
      // 只用公开手牌数与未知牌密度估算防御，不读取目标真实手牌牌面。
      const blockRisk = Math.min(.85, (target.hand?.length ?? 0) * this.knowledge.probability(responder, "block"));
      const score = attackBenefit + equipmentValue * 1.05 - assaultCost - blockRisk * 2.5;
      return score > 0;
    }
    if (type === "skill") return (context.amount ?? 1) > 0;
    return false;
  }
}
