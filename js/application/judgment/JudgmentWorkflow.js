/*
模块职责
唯一拥有 Application Judgment Workflow：防御判定与延迟状态判定的 draw/show/reveal/destination/phase-restore sequencing；currentJudgment 是 Application state 的单向 projection。

上游
Application status-resolution workflow 与 composition judgment command。

下游
Domain JudgmentRules、Domain transitions、PresentationPort 与注入的 AI knowledge collaborator。

状态边界
不直接写 phase/currentJudgment/handVersion；commit 经 Domain transitions；currentJudgment projection 经注入 setter。

信息边界
不读取 concrete UI/AI/DOM；AI knowledge 更新只经窄 collaborator。

架构约束
不得依赖 MatchApplication、UIManager、AiController、SoundManager、EventDispatcher runtime、混合配置模块或 concrete adapters。
*/
import { decideDefenseJudgmentOutcome, decideDelayedStatusJudgmentOutcome } from "../../domain/rules/judgment/JudgmentRules.js?build=20260818-skill-rules-locality-refactor";
import { setMatchPhase } from "../../domain/state/transitions/MatchStateTransitions.js?build=20260818-skill-rules-locality-refactor";
import { bumpHandVersion } from "../../domain/state/transitions/PlayerStateTransitions.js?build=20260818-skill-rules-locality-refactor";

const REQUIRED_DEPENDENCIES = [
  "getState",
  "isSessionValid",
  "emitEvent",
  "drawJudgmentCard",
  "syncDeckAliases",
  "moveJudgmentToDiscard",
  "moveJudgmentToHand",
  "observeJudgmentCard",
  "presentation",
  "setCurrentJudgmentProjection"
];

/*
功能
创建 Application Judgment Workflow。

调用方
composition root。

输入
显式注入的 state/session/event/deck-movement/AI-knowledge/presentation/projection collaborators。

输出
冻结 { judgeDefense, judgeDelayedStatus, judgeLightning, judgeSeal }。

读取状态
无。

写入状态
内部 currentJudgment；Domain phase/handVersion/zone commit 经 transitions 或 deck collaborator。

调用函数
decideDefenseJudgmentOutcome、decideDelayedStatusJudgmentOutcome、setMatchPhase、bumpHandVersion。

边界与不变量
判定牌先入判定区；destination 由 Domain Rule 决定；cancelled/session-invalid 的 phase 恢复语义不变。
*/
export function createJudgmentWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`JudgmentWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  let currentJudgment = null;

  /*
  功能
  设置当前判定 projection 并同步 game.state.currentJudgment。

  调用方
  judgeDefense 与 judgeDelayedStatus。

  输入
  judgment projection 或 null。

  输出
  无。

  读取状态
  无。

  写入状态
  currentJudgment 与 projection。

  调用函数
  runtime.setCurrentJudgmentProjection。

  边界与不变量
  是 Application state，不 bump stateVersion；单向写入。
  */
  function setJudgmentProjection(value) {
    currentJudgment = value;
    runtime.setCurrentJudgmentProjection(value);
  }

  /*
  功能
  执行雷达防御判定 workflow 并提交判定区移动与 phase 写入。

  调用方
  Application Combat damage。

  输入
  attacker、defender 与 attackContext。

  输出
  旧形状 { handled, immune, category } 或 cancelled。

  读取状态
  defender 装备、判定区与 session。

  写入状态
  phase 经 MatchStateTransition；牌区经 deck collaborator；handVersion 经 PlayerStateTransition。

  调用函数
  drawJudgmentCard、setMatchPhase、showJudgment、emitEvent、decideDefenseJudgmentOutcome、moveJudgmentToDiscard、moveJudgmentToHand、bumpHandVersion、observeJudgmentCard。

  边界与不变量
  判定牌进入独立判定区；basic 进入守方手牌并更新知识；phase/currentJudgment 恢复顺序不变。
  */
  async function judgeDefense(attacker, defender, attackContext) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId)) return { handled: false, immune: false, cancelled: true };
    if (defender.equipment?.definitionId !== "defenseDevice") return { handled: false, immune: false };
    const card = runtime.drawJudgmentCard();
    if (!card) return { handled: false, immune: false };
    const previousPhase = state.phase;
    setMatchPhase(state, "judgment");
    setJudgmentProjection({ card, defenderId: defender.id, attackerId: attacker?.id ?? null });
    runtime.presentation.showJudgment({
      playerId: defender.id,
      card: { name: card.name, categoryName: card.categoryName, art: card.art },
      delayedStatusContext: null
    });
    runtime.presentation.log(`${defender.name}的「雷达」判定为「${card.name}」（${card.categoryName}）。`, "important");
    await runtime.emitEvent("judgmentRevealed", { type: "judgmentRevealed", attacker, defender, card, attackContext });
    if (!runtime.isSessionValid(gameId)) return { handled: false, immune: false, cancelled: true };
    const outcome = decideDefenseJudgmentOutcome(card.category);
    if (outcome.destination === "hand") {
      runtime.moveJudgmentToHand(card, defender);
      bumpHandVersion(state, defender);
      for (const viewer of state.players) {
        if (viewer.id !== defender.id) runtime.observeJudgmentCard(viewer, defender, card);
      }
      runtime.presentation.log(`${defender.name}获得判定牌，此次攻击继续结算。`);
    } else {
      runtime.moveJudgmentToDiscard(card);
      if (outcome.immune) {
        runtime.presentation.log(`${defender.name}的「雷达」生效，此次攻击无效。`, "important");
      } else {
        runtime.presentation.log(`${defender.name}的「雷达」未生效，判定牌进入弃牌堆，此次攻击继续结算。`, "important");
      }
    }
    setJudgmentProjection(null);
    runtime.presentation.hideJudgment();
    if (!state.isGameOver) setMatchPhase(state, previousPhase);
    runtime.syncDeckAliases();
    runtime.presentation.refresh();
    return { handled: outcome.handled, immune: outcome.immune, category: outcome.category };
  }

  /*
  功能
  执行延迟状态的公共判定 workflow。

  调用方
  judgeLightning、judgeSeal 与 status-resolution workflow。

  输入
  holder 与 options。

  输出
  旧形状 { handled, triggered, category, card }。

  读取状态
  holder 状态、判定区与 session。

  写入状态
  phase 经 MatchStateTransition；判定区经 deck collaborator。

  调用函数
  drawJudgmentCard、setMatchPhase、showJudgment、emitEvent、decideDelayedStatusJudgmentOutcome、moveJudgmentToDiscard。

  边界与不变量
  延迟判定牌总是公开后进入弃牌堆；showJudgment/hideJudgment/phase restore 顺序不变。
  */
  async function judgeDelayedStatus(holder, options = {}) {
    const {
      statusId,
      statusName,
      triggerCategory,
      context = {},
      logReveal = true,
      triggerMessage = null,
      statusDefinitionId = null
    } = options;
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId)) return { handled: false, triggered: false, cancelled: true };
    if (!holder?.alive || !state.players.some((entry) => entry === holder && entry.alive)) return { handled: false, triggered: false };
    const card = runtime.drawJudgmentCard();
    if (!card) {
      runtime.presentation.log(`没有可翻开的判定牌，「${statusName}」结算顺延。`);
      return { handled: false, triggered: false };
    }
    const categoryLabel = card.category === "basic" ? "基础牌"
      : card.category === "tactic" ? "战术牌"
        : card.category === "equipment" ? "装备牌" : card.categoryName;
    const previousPhase = state.phase;
    setMatchPhase(state, "judgment");
    setJudgmentProjection({ card, defenderId: holder.id, attackerId: null, statusId });
    if (statusDefinitionId) {
      runtime.presentation.showCurrentEffect({
        statusId: statusDefinitionId,
        label: "判定中",
        holderName: holder.name
      });
    }
    runtime.presentation.showJudgment({
      playerId: holder.id,
      card: { name: card.name, categoryName: card.categoryName, art: card.art },
      delayedStatusContext: {
        ownerId: holder.id,
        ownerName: holder.name,
        ownerBattleTeam: holder.battleTeam,
        statusId,
        statusName,
        event: "judging"
      }
    });
    if (logReveal) runtime.presentation.log(`${holder.name}的「${statusName}」判定为「${card.name}」，为${categoryLabel}。`, "important");
    const revealEvent = {
      type: "judgmentRevealed", attacker: null, defender: holder, card, statusId, statusContext: context
    };
    if (statusId === "lightning") revealEvent.lightningContext = context;
    if (statusId === "sealed") revealEvent.sealContext = context;
    await runtime.emitEvent("judgmentRevealed", revealEvent);
    if (!runtime.isSessionValid(gameId)) return { handled: false, triggered: false, cancelled: true };
    const outcome = decideDelayedStatusJudgmentOutcome(card.category, triggerCategory);
    runtime.moveJudgmentToDiscard(card);
    if (outcome.triggered && triggerMessage) runtime.presentation.log(triggerMessage(holder, card), "important");
    setJudgmentProjection(null);
    runtime.presentation.hideJudgment();
    if (!state.isGameOver) setMatchPhase(state, previousPhase);
    runtime.syncDeckAliases();
    runtime.presentation.refresh();
    return { handled: true, triggered: outcome.triggered, category: card.category, card };
  }

  /*
  功能
  执行闪电延迟判定。

  调用方
  status-resolution workflow 与 boundary。

  输入
  holder 与 context。

  输出
  judgeDelayedStatus 结果。

  读取状态
  无。

  写入状态
  无。

  调用函数
  judgeDelayedStatus。

  边界与不变量
  判定成功触发装备牌；判定中展示闪电牌语义。
  */
  async function judgeLightning(holder, context = {}) {
    return judgeDelayedStatus(holder, {
      statusId: "lightning",
      statusName: "闪电",
      triggerCategory: "equipment",
      context,
      triggerMessage: (target) => `${target.name}的「闪电」判定成功，被「闪电」击中。`,
      statusDefinitionId: "lightning"
    });
  }

  /*
  功能
  执行封印延迟判定。

  调用方
  status-resolution workflow 与 boundary。

  输入
  holder 与 context。

  输出
  judgeDelayedStatus 结果。

  读取状态
  无。

  写入状态
  无。

  调用函数
  judgeDelayedStatus。

  边界与不变量
  封印公开日志由外层 workflow 保留；判定成功表示战术牌未生效。
  */
  async function judgeSeal(holder, context = {}) {
    return judgeDelayedStatus(holder, {
      statusId: "sealed",
      statusName: "封印",
      triggerCategory: "tactic",
      context,
      logReveal: false,
      statusDefinitionId: "seal"
    });
  }

  return Object.freeze({
    /*
    功能
    返回当前判定上下文。

    调用方
    observers。

    输入
    无。

    输出
    currentJudgment 或 null。

    读取状态
    currentJudgment。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    game.state.currentJudgment 只允许单向 projection。
    */
    get currentJudgment() { return currentJudgment; },
    judgeDefense,
    judgeDelayedStatus,
    judgeLightning,
    judgeSeal,
    setCurrentJudgmentProjection: setJudgmentProjection
  });
}
