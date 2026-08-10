import { GAME_CONFIG } from "../config/gameConfig.js?build=20260810-guardian-aid-turn-v161";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260810-guardian-aid-turn-v161";
import { createAiVisibleState } from "./AiVisibleState.js?build=20260810-guardian-aid-turn-v161";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260810-guardian-aid-turn-v161";
import {
  hasLightning,
  lightningTeamBurden,
  lightningTransferredBurden,
  nextLightningReceiver
} from "./lightningScoring.js?build=20260810-guardian-aid-turn-v161";
import { hasSeal, tacticJudgmentProbability, turnOpportunityValue } from "./sealScoring.js?build=20260810-guardian-aid-turn-v161";

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

  /** 格挡早于 beforeDamage；这里只读预览公开且确定的突袭加伤，不触发任何伤害监听器。 */
  knownPendingAssaultBonus(context) {
    const source = context.source;
    if (!source?.alive || context.card?.definitionId !== "assault") return 0;
    const passiveSkillIds = source.general?.passiveSkillIds ?? [];
    let bonus = 0;
    if (passiveSkillIds.includes("momentum")) {
      bonus += Math.max(0, Number(source.turnFlags?.momentum) || 0);
    }
    if (passiveSkillIds.includes("gamble")) {
      bonus += Math.max(0, Number(source.statuses?.allIn?.assaultBonus) || 0);
    }
    return bonus;
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
      const incoming = Math.max(0, Number(context.amount ?? 1) || 0)
        + this.knownPendingAssaultBonus(context);
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
      if (context.statusCounterContext) {
        return context.statusCounterContext.statusId === "sealed"
          ? this.shouldCounterSeal(responder, context)
          : this.shouldCounterLightning(responder, context);
      }
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

  /** 闪电状态反制：比较不反制继续判定的团队期望与反制转移后的团队期望加反制牌机会成本。 */
  shouldCounterLightning(responder, context) {
    const statusContext = context.statusCounterContext;
    const holder = this.game.state.players.find((player) => player.id === statusContext?.holderId && player.alive);
    if (!holder || !hasLightning(holder)) return false;
    const remainingCardCounts = this.knowledge.remainingCounts(responder);
    const state = { players:this.game.state.players, remainingCardCounts };
    const noCounterBurden = lightningTeamBurden(state, holder, responder.battleTeam);
    const receiver = nextLightningReceiver(this.game.state.players, holder);
    const withCounterBurden = receiver
      ? lightningTransferredBurden(state, receiver, responder.battleTeam)
      : 0;
    const counterCost = (CARD_DEFINITIONS.counter.aiValue ?? 8) * 0.35;
    return withCounterBurden + counterCost < noCounterBurden;
  }

  /** 封印状态反制：仅为己方解除未来 skip-action 风险，并计入反制牌机会成本。 */
  shouldCounterSeal(responder, context) {
    const statusContext = context.statusCounterContext;
    const holder = this.game.state.players.find((player) => player.id === statusContext?.holderId && player.alive);
    if (!holder || !hasSeal(holder) || holder.battleTeam !== responder.battleTeam) return false;
    const remainingCardCounts = this.knowledge.remainingCounts(responder);
    const skipProbability = 1 - tacticJudgmentProbability(remainingCardCounts);
    const preventedBurden = skipProbability * turnOpportunityValue(holder);
    const counterCost = (CARD_DEFINITIONS.counter.aiValue ?? 8) * 0.35;
    return preventedBurden > counterCost;
  }
}
