import { GAME_CONFIG } from "../config/gameConfig.js?build=20260814-guardian-aid-discard";
import { globalBenefitCounterDesire, dynamicRootFlipGain, counterOpportunityCost } from "./AiGlobalBenefit.js?build=20260814-guardian-aid-discard";
import { createAiVisibleState } from "./AiVisibleState.js?build=20260814-guardian-aid-discard";
import { AiSimulator } from "./AiSimulator.js?build=20260814-guardian-aid-discard";
import { HP_VALUE } from "./AiEconomics.js?build=20260814-guardian-aid-discard";
import {
  hasLightning,
  nextLightningReceiver
} from "./lightningScoring.js?build=20260814-guardian-aid-discard";
import { hasSeal, tacticJudgmentProbability, turnOpportunityValue } from "./sealScoring.js?build=20260814-guardian-aid-discard";

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
      // 反制决策围绕最终 root outcome：嵌套反制时当前 card 是上一张反制，root 定义与
      // 来源必须来自链上下文（首张反制时 root 就是当前 card/source）。反制链深度决定
      // 当前 parity 下 root 最终生效还是被取消，由 globalBenefitCounterDesire / 统一
      // 动态 root 估值比较 stay/flip 两个世界，真实响应与规划模拟共用同一判断。
      const rootId = context.rootCard?.definitionId ?? context.card?.definitionId;
      // 真实反制链上下文以 rootSourceId（字符串）透传 root source；首张反制时回退当前 source。
      const rootSourceId = context.rootSourceId ?? context.rootSource?.id ?? context.source?.id ?? null;
      const globalBenefitDesire = globalBenefitCounterDesire(
        this.game.state.players,
        responder.battleTeam,
        rootId,
        {
          rootSourceId,
          counterDepth: context.counterDepth ?? 0,
          remainingCardCounts: this.knowledge.remainingCounts(responder)
        }
      );
      if (globalBenefitDesire !== null) return globalBenefitDesire > 0;
      // counter root 只出现在"状态判定（封印/闪电）反制的反反制"窗口：root 本身是一张
      // 反制牌，其效果是取消一次状态判定，而该窗口不携带状态上下文，无法进入动态 root
      // 效果估值。保持既有状态反制路径的意愿（按当前被反制卡价值），不纳入经济比较。
      if (rootId === "counter") {
        const sourceEnemy = context.source?.battleTeam !== responder.battleTeam;
        return sourceEnemy ? (context.card?.aiValue ?? 0) >= 7 : false;
      }
      // 其余可反制牌统一走动态 root 估值：按"当前响应链消耗后的实时状态"模拟 root 结算
      // 的 stay/flip 两世界经济差，只有收益超过反制牌机会成本才反制。
      return this.dynamicRootCounterDecision(responder, context);
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
    if (type === "skill") return this.shouldUseGuardianAid(responder, context);
    return false;
  }

  /**
   * 护援响应决策：比较"不使用护援"（STAY）与"使用护援"（AID）两个真实 after-state
   * 的团队状态价值，只在 AID 严格更优时才弃牌。此前 `(context.amount ?? 1) > 0`
   * 等价于"合法即自动护援"，会无脑消耗唯一额度与手牌；这里改成边际比较后，
   * 护盾可吸收、目标健康且后续还有更高暴露时都会选择保留额度与手牌。
   *
   * 复用统一模拟器：STAY 世界按 id 排除本守誓者（额度与手牌保留、伤害原样通过），
   * AID 世界让其自然护援（伤害-1、弃1牌、额度消耗），其余守誓者在两个世界自然结算。
   * 格挡/雷达已在真实伤害链中先于 beforeDamage 完成，因此这里固定 canBlock:false。
   */
  shouldUseGuardianAid(responder, context) {
    const target = context.target;
    // 与 skillRegistry.guardianAid 的 beforeDamage 硬守卫一致，先满足真实合法性再比较。
    if (!responder?.alive || !target?.alive || responder.id === target.id) return false;
    if (responder.battleTeam !== target.battleTeam) return false;
    if (!responder.hand?.length) return false;
    const amount = Math.max(0, Number(context.amount) || 0);
    if (amount <= 0) return false;
    if ((responder.turnFlags.guardianAidUsed ? 1 : 0) >= 1) return false;

    const remainingCardCounts = this.knowledge.remainingCounts(responder);
    const visible = createAiVisibleState(responder.id, this.game.state, remainingCardCounts);
    const simulator = new AiSimulator(visible);
    const stayState = simulator.clone();
    const aidState = simulator.clone();
    const stayTarget = stayState.players.find((player) => player.id === target.id);
    const aidTarget = aidState.players.find((player) => player.id === target.id);
    const staySource = context.source ? stayState.players.find((player) => player.id === context.source.id) : null;
    const aidSource = context.source ? aidState.players.find((player) => player.id === context.source.id) : null;
    simulator.applyDamage(stayState, staySource, stayTarget, amount, {
      canBlock:false,
      excludedGuardianIds:new Set([responder.id])
    });
    simulator.applyDamage(aidState, aidSource, aidTarget, amount, { canBlock:false });

    const stayValue = this.evaluator.stateUtility(stayState, responder.id);
    const aidValue = this.evaluator.stateUtility(aidState, responder.id);

    // 剩余额度未来价值：护援每全局回合仅一次，且每次都要弃一张手牌。若目标后续
    // 仍面临未兑现的攻击库存（futureInventory，来自 exposureComponents 的敌方未来
    // 突袭压力），现在消耗唯一额度就放弃了在更高暴露伤害上再护援一次的机会。这里用
    // "未来攻击库存中至多可再被护援抵消的那部分"近似额度机会成本，只乘 HP_VALUE 单价，
    // 不引入无条件角色常数。futureInventory 是期望压力而非确定伤害，且不含格挡/护盾
    // 抵消，故该值偏保守——只会让低价值伤害放弃唯一额度，不会误拒阵亡/濒死伤害。
    const visibleTarget = visible.players.find((player) => player.id === target.id);
    const { futureInventory } = this.evaluator.exposureComponents(visible, visibleTarget);
    const quotaFutureValue = Math.min(HP_VALUE, futureInventory);

    return (aidValue - stayValue) > quotaFutureValue;
  }

  /** 闪电状态反制：比较不反制继续判定的团队期望与反制转移后的团队期望加反制牌机会成本。 */
  shouldCounterLightning(responder, context) {
    const statusContext = context.statusCounterContext;
    const holder = this.game.state.players.find((player) => player.id === statusContext?.holderId && player.alive);
    if (!holder || !hasLightning(holder)) return false;
    const remainingCardCounts = this.knowledge.remainingCounts(responder);
    const state = createAiVisibleState(responder.id, this.game.state, remainingCardCounts);
    const visibleHolder = state.players.find((player) => player.id === holder.id);
    const noCounterBurden = this.evaluator.lightningTeamBurden(
      state, visibleHolder, responder.id
    );
    const receiver = nextLightningReceiver(this.game.state.players, holder);
    const visibleReceiver = state.players.find((player) => player.id === receiver?.id);
    const withCounterBurden = visibleReceiver
      ? this.evaluator.lightningTransferredBurden(
          state, visibleHolder, visibleReceiver, responder.id
        )
      : 0;
    // 反制牌机会成本与全体受益/动态 root 反制共用同一统一入口，只计一次。
    const counterCost = counterOpportunityCost();
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
    // 反制牌机会成本与全体受益/动态 root 反制共用同一统一入口，只计一次。
    const counterCost = counterOpportunityCost();
    return preventedBurden > counterCost;
  }

  /**
   * 其余可反制牌的统一反制决策入口。基于"当前响应链实际消耗资源后的实时状态"构建
   * 可见状态与模拟器，交给 dynamicRootFlipGain 做 stay/flip 经济比较。每个反制窗口
   * 只构建一次可见状态，不做完整搜索。
   */
  dynamicRootCounterDecision(responder, context) {
    const rootCard = context.rootCard ?? context.card;
    if (!rootCard?.definitionId || rootCard.category !== "tactic") return false;
    const rootSourceId = context.rootSourceId ?? context.rootSource?.id ?? context.source?.id ?? null;
    const counterDepth = context.counterDepth ?? 0;
    const rootTargetIds = Array.isArray(context.rootTargetIds) ? context.rootTargetIds : [];
    const remainingCardCounts = this.knowledge.remainingCounts(responder);
    const visible = createAiVisibleState(responder.id, this.game.state, remainingCardCounts);
    const simulator = new AiSimulator(visible);
    const gain = dynamicRootFlipGain(
      this.evaluator, simulator, visible, responder.id, rootCard, rootSourceId, counterDepth, rootTargetIds, {
        publicTransferContext:context.publicTransferContext ?? null
      }
    );
    if (gain === null) return false;
    return gain > counterOpportunityCost();
  }
}
