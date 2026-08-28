/*
模块职责
唯一拥有 Application Turn Workflow：回合循环、六阶段顺序、失败恢复、轮次推进、AI play-phase orchestration 与弃牌阶段 sequencing；不拥有 card/skill resolver 或 AI search policy。

上游
composition boundary 与 Application Match continuation。

下游
Domain TeamRules/TurnRules/transitions、Application Action/Combat/Response 能力与 Ports/Adapters。

状态边界
不直接写 Domain fields；phase/round/current/flags 经 transitions；presentation 经 PresentationPort。

信息边界
不读取 concrete UI/AI/DOM；controllerType 仅用于 human/AI play-phase 参与者策略。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、AI search internals、AI World 或 concrete adapters。
*/
import { getDrawCountFromRules, getTeamRules, getTurnEnergyBreakdownFromRules } from "../../domain/rules/team/TeamRules.js";
import {
  calculateNextActorIndex, createGlobalTurnReactiveState, createRoundUsageState,
  createTurnUsageState, shouldSkipActionPhase
} from "../../domain/rules/turn/TurnRules.js";
import { createDiscardChoiceRequest } from "../choice/DiscardChoiceRequest.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";
import { setCurrentPlayerIndex, setCurrentRound, setMatchPhase } from "../../domain/state/transitions/MatchStateTransitions.js";
import { resetGlobalTurnReactiveFlags, resetRoundFlags, resetTurnFlags } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "emitEvent", "presentation", "diagnostics", "runTurn",
  "gainEnergy", "drawCards", "cleanupDefeatedZones", "delay", "getAiDelay", "now",
  "sampleAiDecisionWindow", "getRemainingAiDecisionDelay",
  "getTeamRules", "waitForHumanPlayEnd", "runAiPlayPhase", "choiceCoordinator",
  "choiceContexts", "createId",
  "selectAction", "playCard", "useActiveSkill", "getAiMaxActions",
  "getActionTargetLabel", "resetActionLocks", "discardCardFromHand",
  "cancelPendingInteractions"
];

/*
功能
创建 Application Turn Workflow。

调用方
composition root。

输入
显式注入的 phase/event/participant/AI-action/presentation collaborators。

输出
冻结 { runGameLoop, takeTurn, advanceTurn, takeAiPlayPhase, handleDiscardPhase }。

读取状态
无。

写入状态
内部无持久状态；Domain 写入经 transitions。

调用函数
getTeamRules、createTurnUsageState、createGlobalTurnReactiveState、createRoundUsageState、shouldSkipActionPhase、calculateNextActorIndex、setMatchPhase、setCurrentRound、setCurrentPlayerIndex。

边界与不变量
旧 runGameLoop/takeTurn/advanceTurn 的 session、failure recovery、delay(0) yield 与事件顺序逐点保留。
*/
export function createTurnWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`TurnWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  /*
  功能
  返回当前行动玩家的 Domain Rule 投影。

  调用方
  turn phase helpers。

  输入
  state 与真实 Player。

  输出
  Rule projection 或 null。

  读取状态
  state.players。

  写入状态
  无。

  调用函数
  createRuleStateView。

  边界与不变量
  每次调用重新投影，不缓存。
  */
  function ruleProjection(state, player) {
    return createRuleStateView(state).playerById(player.id);
  }

  /*
  功能
  持续运行轮次直到胜负或销毁。

  调用方
  MatchWorkflow start continuation。

  输入
  无。

  输出
  Promise。

  读取状态
  MatchState、当前玩家与 Application session。

  写入状态
  轮次/回合经 Domain transitions。

  调用函数
  takeTurn、advanceTurn、resetRoundFlags、presentation、diagnostics。

  边界与不变量
  初始 roundStart、consecutiveTurnFailures、failureLimit=3、异常 delay(0) yield 与最后安全收束保持旧语义。
  */
  async function runGameLoop() {
    const state = runtime.getState();
    const gameId = state.gameId;
    let consecutiveTurnFailures = 0;
    const failureLimit = 3;
    try {
      runtime.presentation.log(`第${state.currentRound}轮开始。`, "important");
      for (const player of state.players) resetRoundFlags(state, player, createRoundUsageState());
      await runtime.emitEvent("roundStart", { type: "roundStart", round: state.currentRound });
      if (!runtime.isSessionValid(gameId)) return;
      while (runtime.isSessionValid(gameId) && !state.isGameOver) {
        const view = createRuleStateView(state);
        const playerProjection = view.currentActor();
        const player = playerProjection ? state.players.find((entry) => entry.id === playerProjection.id) : null;
        if (!player || !state.players.some((entry) => entry.alive)) {
          runtime.diagnostics.reportWorkflowError("Game", "当前行动角色或存活角色状态无效，安全结束游戏循环");
          break;
        }
        let turnFailed = false;
        try {
          if (player.alive) await runtime.runTurn(player, gameId);
        } catch (error) {
          turnFailed = true;
          consecutiveTurnFailures += 1;
          runtime.diagnostics.reportWorkflowError("Game", `${player.name}的回合执行失败，尝试推进至下一名存活角色`, error);
          runtime.resetActionLocks();
          runtime.presentation.clearThinking();
          runtime.cancelPendingInteractions?.();
        }
        if (!runtime.isSessionValid(gameId) || state.isGameOver) break;
        if (turnFailed) {
          if (consecutiveTurnFailures >= failureLimit) {
            runtime.diagnostics.reportWorkflowError("Game", `连续${failureLimit}个回合执行失败，安全结束游戏循环`);
            break;
          }
          if (!(await runtime.delay(0))) break;
        } else {
          consecutiveTurnFailures = 0;
        }
        await advanceTurn();
      }
    } catch (error) {
      runtime.diagnostics.reportWorkflowError("Game", "游戏循环遇到无法恢复的异常，已安全停止", error);
      runtime.resetActionLocks();
      if (state.gameId === gameId && !state.isDisposed) {
        runtime.presentation.clearThinking();
        runtime.cancelPendingInteractions?.();
      }
    }
  }

  /*
  功能
  执行角色的六阶段完整回合；真人出牌和弃牌阶段经 participant driver 异步等待。

  调用方
  runGameLoop 与 tests。

  输入
  行动 Player 与 gameId。

  输出
  Promise。

  读取状态
  MatchState、Domain Team Rules 与 Application session。

  写入状态
  phase 经 MatchStateTransition；资源经注入 gainEnergy/drawCards。

  调用函数
  setMatchPhase、resetTurnFlags、resetGlobalTurnReactiveFlags、emitEvent、gainEnergy、drawCards、shouldSkipActionPhase、runPlayPhase、handleDiscardPhase。

  边界与不变量
  六阶段顺序与事件顺序不变；每个 await 后保留 session 检查。
  */
  async function takeTurn(player, gameId) {
    const state = runtime.getState();
    if (!runtime.isSessionValid(gameId) || !player?.alive || state.isGameOver) return;
    const projection = ruleProjection(state, player);
    const viewState = { players: createRuleStateView(state).players() };
    setMatchPhase(state, "turnStart");
    resetTurnFlags(state, player, createTurnUsageState(runtime.getTeamRules(player)));
    for (const entry of state.players) resetGlobalTurnReactiveFlags(state, entry, createGlobalTurnReactiveState());
    runtime.presentation.log(`${player.name}的回合开始。`, "important");
    await runtime.emitEvent("turnStart", { type: "turnStart", player });
    if (!runtime.isSessionValid(gameId) || !player.alive || state.isGameOver) return;
    runtime.presentation.refresh();

    setMatchPhase(state, "status");
    const statusEvent = { type: "beforeStatusResolve", player, cancelled: false };
    await runtime.emitEvent("beforeStatusResolve", statusEvent);
    if (!runtime.isSessionValid(gameId)) return;
    await runtime.emitEvent("afterStatusResolve", { ...statusEvent, type: "afterStatusResolve" });
    if (!runtime.isSessionValid(gameId) || !player.alive || state.isGameOver) return;

    setMatchPhase(state, "energy");
    const rules = getTeamRules(viewState, projection);
    const energyParts = getTurnEnergyBreakdownFromRules(rules, player.equipment?.definitionId ?? null);
    const energyEvent = { type: "beforeTurnEnergyGain", player, ...energyParts, amount: energyParts.baseAmount + energyParts.teamBonus + energyParts.equipmentBonus, cancelled: false, metadata: {} };
    await runtime.emitEvent("beforeTurnEnergyGain", energyEvent);
    if (!runtime.isSessionValid(gameId)) return;
    let energyGained = 0;
    if (!energyEvent.cancelled) energyGained = await runtime.gainEnergy(player, Math.max(0, energyEvent.amount), { reason: "回合开始" });
    if (!runtime.isSessionValid(gameId)) return;
    await runtime.emitEvent("afterTurnEnergyGain", { ...energyEvent, type: "afterTurnEnergyGain", actualAmount: energyGained });
    if (!runtime.isSessionValid(gameId) || !player.alive || state.isGameOver) return;

    setMatchPhase(state, "draw");
    const drawCount = getDrawCountFromRules(rules);
    const drawEvent = { type: "beforeDraw", player, count: drawCount, cancelled: false, metadata: {} };
    await runtime.emitEvent("beforeDraw", drawEvent);
    if (!runtime.isSessionValid(gameId)) return;
    if (!drawEvent.cancelled) await runtime.drawCards(player, Math.max(0, drawEvent.count), "回合摸牌");
    if (!runtime.isSessionValid(gameId)) return;
    await runtime.emitEvent("afterDraw", { ...drawEvent, type: "afterDraw" });
    if (!runtime.isSessionValid(gameId) || !player.alive || state.isGameOver) return;

    if (shouldSkipActionPhase(player.turnFlags)) {
      runtime.presentation.log(`${player.name}因「封印」生效，跳过出牌阶段并进入弃牌阶段。`, "important");
    } else {
      setMatchPhase(state, "play");
      await runtime.emitEvent("playPhaseStart", { type: "playPhaseStart", player });
      if (!runtime.isSessionValid(gameId)) return;
      runtime.presentation.refresh();
      if (player.controllerType === "human") {
        runtime.presentation.setPrompt("你的出牌阶段：选择手牌、发动技能，或结束出牌。", "从手牌中选择可用牌");
        const completed = await runtime.waitForHumanPlayEnd(gameId);
        if (!completed || !runtime.isSessionValid(gameId)) return;
      } else {
        await runtime.runAiPlayPhase(player, gameId);
      }
      if (!runtime.isSessionValid(gameId) || state.isGameOver || !player.alive) return;
      await runtime.emitEvent("playPhaseEnd", { type: "playPhaseEnd", player });
      if (!runtime.isSessionValid(gameId)) return;
    }

    setMatchPhase(state, "discard");
    await handleDiscardPhase(player, gameId);
    if (!runtime.isSessionValid(gameId) || state.isGameOver) return;

    setMatchPhase(state, "turnEnd");
    await runtime.emitEvent("turnEnd", { type: "turnEnd", player });
    if (!runtime.isSessionValid(gameId)) return;
    runtime.presentation.log(`${player.name}的回合结束。`);
    runtime.presentation.refresh();
  }

  /*
  功能
  驱动一名 AI 玩家完成当前出牌阶段。

  调用方
  takeTurn。

  输入
  当前行动 Player 与所属 gameId。

  输出
  Promise。

  读取状态
  MatchState、注入 AI action capability、时延配置与 Application session。

  写入状态
  thinking/prompt 经 PresentationPort；真实卡牌/技能经注入 action collaborators。

  调用函数
  selectAction、playCard、useActiveSkill。

  边界与不变量
  每个真实 Action 后必须从最新 World 重新调用 selectAction；每步只采样一个窗口，MAX 作为显式预算，MIN 只补剩余可见等待。
  canonical non-END 的定义、目标、实体或真实结算绑定失败必须显式记录，不能静默伪装成正常 END。
  null 表示 SEARCH_FAILURE，必须中止当前 turn workflow，不能进入战略 END 或强制弃牌阶段。
  */
  async function takeAiPlayPhase(player, gameId) {
    const state = runtime.getState();
    try {
      runtime.presentation.setPrompt(`${player.name}进入出牌阶段，正在观察战场。`, "电脑正在行动");
      runtime.presentation.showThinking({ playerId: player.id, message: "正在观察战场与可用资源" });
      for (let count = 0; count < runtime.getAiMaxActions(); count += 1) {
        if (!runtime.isSessionValid(gameId) || state.isGameOver || !player.alive) break;
        const decisionStartedAt = runtime.now();
        let action = null;
        const decisionWindow = runtime.sampleAiDecisionWindow();
        try {
          action = await runtime.selectAction(player, {
            gameId,
            searchTimeBudgetMs:decisionWindow.maximumMs
          });
        } catch (error) {
          runtime.diagnostics.reportWorkflowError("AI", `${player.name}规划行动失败，已中止当前回合`, error);
          throw error;
        }
        if (!runtime.isSessionValid(gameId)) return;
        if (!action) {
          const searchFailure = new Error("AI Searcher 未返回可验收 Action（SEARCH_FAILURE）");
          runtime.diagnostics.reportWorkflowError(
            "AI",
            `${player.name}规划行动失败，已中止当前回合`,
            searchFailure
          );
          throw searchFailure;
        }
        const decisionElapsedMs = Math.max(0, runtime.now() - decisionStartedAt);
        const remainingSearchDelay = runtime.getRemainingAiDecisionDelay(
          decisionWindow,
          decisionElapsedMs
        );
        if (action.type === "end") {
          runtime.presentation.setPrompt(`${player.name}准备结束出牌阶段。`);
          runtime.presentation.showThinking({ playerId: player.id, message: "正在收束回合" });
          if (!(await runtime.delay(remainingSearchDelay))) return;
          if (!runtime.isSessionValid(gameId)) return;
          break;
        }
        const definition = action.type === "card"
          ? CARD_DEFINITIONS[action.cardId]
          : ACTIVE_SKILL_DEFINITIONS[action.skillId];
        const targets = (action.targetIds ?? [])
          .map((id) => runtime.getState().players.find((entry) => entry.id === id))
          .filter(Boolean);
        if (!definition || targets.length !== (action.targetIds?.length ?? 0)) {
          const bindingError = new Error("AI canonical Action 的定义或目标绑定失败");
          runtime.diagnostics.reportWorkflowError(
            "AI",
            `${player.name}的计划行动绑定失败，提前结束出牌阶段`,
            bindingError
          );
          runtime.presentation.log(`${player.name}的计划行动已失效，本次出牌阶段提前结束。`, "important");
          break;
        }
        const actionName = action.type === "card"
          ? `准备使用「${definition.name}」`
          : `准备发动「${definition.name}」`;
        const targetLabel = runtime.getActionTargetLabel(
          player,
          definition,
          targets,
          action.selection
        );
        const actionDescription = `${actionName}${targetLabel ? `，作用对象：${targetLabel}` : ""}`;
        runtime.presentation.showThinking({ playerId: player.id, message: actionDescription });
        if (!(await runtime.delay(remainingSearchDelay))) return;
        if (!runtime.isSessionValid(gameId)) return;
        runtime.presentation.clearThinking();
        let executed = false;
        try {
          if (action.type === "card") {
            const card = player.hand.find((entry) => entry.id === action.cardInstanceId) ?? null;
            if (!card) throw new Error("AI canonical Action 的实体牌绑定失败");
            executed = await runtime.playCard(player, card, targets, action.selection ?? null);
          } else if (action.type === "skill") {
            executed = await runtime.useActiveSkill(player, action.skillId, targets);
          }
          if (!executed) throw new Error("AI canonical Action 未能开始真实结算");
        } catch (error) {
          runtime.diagnostics.reportWorkflowError("AI", `${player.name}执行行动失败，安全结束出牌阶段`, error);
          runtime.presentation.log(`${player.name}的计划行动执行失败，本次出牌阶段提前结束。`, "important");
          break;
        }
        if (!runtime.isSessionValid(gameId)) return;
      }
      if (runtime.isSessionValid(gameId) && !state.isGameOver) runtime.presentation.setPrompt(`${player.name}结束了出牌阶段。`);
    } finally {
      if (state.gameId === gameId && !state.isDisposed) {
        runtime.resetActionLocks();
        runtime.presentation.clearThinking();
        runtime.presentation.refresh();
      }
    }
  }

  /*
  功能
  处理手牌上限弃牌；真人选择与 AI 选择由注入 participant collaborator 执行。

  调用方
  takeTurn。

  输入
  player 与 gameId。

  输出
  Promise。

  读取状态
  player.hand、hp 与 session。

  写入状态
  手牌经注入 discardCardFromHand 提交。

  调用函数
  requestDiscard、chooseDiscards、getAiDelay、delay、discardCardFromHand。

  边界与不变量
  human/AI 分支是 participant mechanism policy；实际 mechanism 在 composition collaborator；不迁移 discard semantic。
  */
  async function handleDiscardPhase(player, gameId) {
    const required = Math.max(0, player.hand.length - Math.max(0, player.hp));
    if (!required) return;
    runtime.presentation.log(`${player.name}需要弃置${required}张牌。`);
    const requestId = runtime.createId("discard-choice");
    const prompt = `手牌上限为${player.hp}，请选择${required}张弃牌`;
    const choiceRequest = createDiscardChoiceRequest({
      requestId,
      actorId: player.id,
      gameId: runtime.getState().gameId,
      stateVersion: runtime.getState().stateVersion,
      handCardIds: player.hand.map((card) => card.id),
      requiredCount: required,
      label: prompt,
      handLimit: Math.max(0, player.hp)
    });
    runtime.choiceContexts.set(requestId, { player, count: required, prompt });
    let decision;
    try {
      if (player.controllerType === "human") {
        decision = await runtime.choiceCoordinator.request(choiceRequest);
      } else {
        runtime.presentation.showThinking({ playerId: player.id, message: `正在斟酌弃置${required}张牌` });
        const decisionStartedAt = runtime.now();
        try {
          decision = await runtime.choiceCoordinator.request(choiceRequest);
          if (!runtime.isSessionValid(gameId)) return;
          if (!(await runtime.delay(runtime.getAiDelay("discard", {
            elapsedMs:Math.max(0, runtime.now() - decisionStartedAt)
          })))) return;
        } finally {
          runtime.presentation.clearThinking();
        }
      }
    } finally {
      runtime.choiceContexts.delete(requestId);
    }
    if (!runtime.isSessionValid(gameId)) return;
    // 真人取消交互保留原有语义；AI 的弃牌阶段必须收束到手牌上限，
    // 即使 peer adapter 异常返回 cancelled/declined 或 selectedIds 不足，也不能跳过强制弃牌。
    if (decision.status === "cancelled" && player.controllerType === "human") return;
    const cards = (decision.selectedIds ?? [])
      .map((cardId) => player.hand.find((card) => card.id === cardId))
      .filter(Boolean)
      .slice(0, required);
    for (const card of cards) {
      await runtime.discardCardFromHand(player, card, "弃牌阶段");
      if (!runtime.isSessionValid(gameId)) return;
    }
    // AI 不变量兜底只使用当前手牌顺序，不调用 AI 策略；正常 peer 选择成功时这里为空操作。
    if (player.controllerType !== "human") {
      while (player.hand.length > Math.max(0, player.hp)) {
        const fallback = player.hand[0];
        if (!fallback) break;
        const discarded = await runtime.discardCardFromHand(player, fallback, "弃牌阶段");
        if (!runtime.isSessionValid(gameId)) return;
        if (!discarded) break;
      }
    }
  }

  /*
  功能
  清理阵亡牌区并移动到下一名存活角色，经过首发座位时开始新轮。

  调用方
  runGameLoop。

  输入
  无。

  输出
  Promise。

  读取状态
  MatchState 与玩家存活。

  写入状态
  currentRound/currentPlayerIndex 经 Domain transitions。

  调用函数
  cleanupDefeatedZones、calculateNextActorIndex、setCurrentRound、setCurrentPlayerIndex、resetRoundFlags。

  边界与不变量
  next-seat formula 只由 Domain TurnRules 计算；wrapped 顺序与旧 advanceTurn 一致。
  */
  async function advanceTurn() {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || state.isGameOver) return;
    await runtime.cleanupDefeatedZones();
    if (!runtime.isSessionValid(gameId) || state.isGameOver) return;
    const nextTurn = calculateNextActorIndex(
      state.players,
      state.currentPlayerIndex,
      state.startingPlayerIndex
    );
    const next = nextTurn.nextIndex;
    const wrapped = nextTurn.wrapped;
    if (wrapped) {
      await runtime.emitEvent("roundEnd", { type: "roundEnd", round: state.currentRound });
      if (!runtime.isSessionValid(gameId)) return;
      setCurrentRound(state, state.currentRound + 1);
      for (const player of state.players) resetRoundFlags(state, player, createRoundUsageState());
      runtime.presentation.log(`第${state.currentRound}轮开始。`, "important");
      await runtime.emitEvent("roundStart", { type: "roundStart", round: state.currentRound });
      if (!runtime.isSessionValid(gameId)) return;
    }
    setCurrentPlayerIndex(state, next);
  }

  return Object.freeze({ runGameLoop, takeTurn, advanceTurn, takeAiPlayPhase, handleDiscardPhase });
}
