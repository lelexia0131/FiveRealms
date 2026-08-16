/*
模块职责
唯一拥有 generic Application Action orchestration：卡牌使用 pipeline、主动技能使用 pipeline、human inbound commands、action locks、resolution identity 与 failure cleanup；不拥有 cardId-specific/skillId-specific rule semantics。

上游
core/Game legacy façade、Application Turn AI orchestration 与 main/UI command boundary。

下游
Domain transitions、Application Response/Combat、legacy legality/card-skill collaborators 与 Ports/Adapters。

状态边界
actionLocked/interactionLocked/pendingHumanPlayEnd/resolutionOwners/resolutionSerial 由本 workflow 唯一拥有；game.state.resolutionSerial 仅单向 projection。

信息边界
不读取 concrete UI/AI/DOM；不直接写 statistics/aiMemory。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、Planner、SearchState、cardRegistry/skillRegistry 或 concrete adapters。
*/
import { createTargetChoiceRequest } from "../choice/TargetChoiceRequest.js?build=20260816-fr-arch-14-runtime-closure";
import { getCurrentActor } from "../../domain/state/queries/MatchQueries.js?build=20260816-fr-arch-14-runtime-closure";
import { recordActiveSkillUse } from "../../domain/state/transitions/RuleUsageTransitions.js?build=20260816-fr-arch-14-runtime-closure";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "emitEvent", "presentation", "diagnostics",
  "responseSystem", "cardRuntime", "canPlayCard", "getCardTargets", "moveHandToResolving",
  "finishResolvingToDiscard", "isCardCommittedToDiscard", "isCardCommittedToEquipment",
  "cleanupFailedResolution", "clearSelection", "getActionDisplayTargets",
  "getActionTargetLabel", "skillRuntime", "getSkillTargets", "getHumanPlayer", "choiceCoordinator",
  "choiceContexts", "requestCardFlow", "resolveHumanPlayEnd", "createId",
  "setResolutionSerialProjection"
];

/*
功能
创建 Application Action Workflow。

调用方
core/Game legacy façade composition。

输入
显式注入的 legality/preparation/zone/response/skill/presentation/participant collaborators。

输出
冻结 { playCard, useActiveSkill, handleHumanCard, handleHumanSkill, requestEndHumanPlay, requestHumanPlayEndForDefeat, flushPendingHumanPlayEnd, state }。

读取状态
无。

写入状态
actionRuntime state；resolutionSerial projection 经注入 setter；Domain writes 经 transitions/collaborators。

调用函数
getCurrentActor、recordActiveSkillUse。

边界与不变量
旧 playCard/useActiveSkill/human command 的 await、lock、finally、event、destination 与 cleanup 顺序逐点保留。
*/
export function createActionWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`ActionWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  const actionRuntime = {
    actionLocked: false,
    interactionLocked: false,
    pendingHumanPlayEnd: false,
    resolutionSerial: 0,
    resolutionOwners: new Map()
  };

  /*
  功能
  生成递增的 resolutionId 并同步 legacy game.state.resolutionSerial projection。

  调用方
  playCard。

  输入
  无。

  输出
  新 resolutionId。

  读取状态
  actionRuntime.resolutionSerial。

  写入状态
  actionRuntime.resolutionSerial 与 legacy projection。

  调用函数
  setResolutionSerialProjection。

  边界与不变量
  是 Application action state，不 bump stateVersion。
  */
  function nextResolutionId() {
    actionRuntime.resolutionSerial += 1;
    runtime.setResolutionSerialProjection(actionRuntime.resolutionSerial);
    return `${runtime.getState().gameId}:resolution:${actionRuntime.resolutionSerial}`;
  }

  /*
  功能
  设置 action lock。

  调用方
  Game temporary reset collaborator 与 tests。

  输入
  布尔值。

  输出
  无。

  读取状态
  actionRuntime.actionLocked。

  写入状态
  actionRuntime.actionLocked。

  调用函数
  无。

  边界与不变量
  不提供任意字段写入 API。
  */
  function setActionLocked(value) {
    actionRuntime.actionLocked = Boolean(value);
  }

  /*
  功能
  设置 interaction lock。

  调用方
  Game temporary reset collaborator 与 tests。

  输入
  布尔值。

  输出
  无。

  读取状态
  actionRuntime.interactionLocked。

  写入状态
  actionRuntime.interactionLocked。

  调用函数
  无。

  边界与不变量
  不提供任意字段写入 API。
  */
  function setInteractionLocked(value) {
    actionRuntime.interactionLocked = Boolean(value);
  }

  /*
  功能
  设置 pendingHumanPlayEnd 标记。

  调用方
  Game temporary reset collaborator 与 tests。

  输入
  布尔值。

  输出
  无。

  读取状态
  actionRuntime.pendingHumanPlayEnd。

  写入状态
  actionRuntime.pendingHumanPlayEnd。

  调用函数
  无。

  边界与不变量
  不提供任意字段写入 API。
  */
  function setPendingHumanPlayEnd(value) {
    actionRuntime.pendingHumanPlayEnd = Boolean(value);
  }

  /*
  功能
  清空全部 action runtime locks。

  调用方
  Game turn/action reset collaborator。

  输入
  无。

  输出
  无。

  读取状态
  actionRuntime。

  写入状态
  actionRuntime locks。

  调用函数
  setActionLocked、setInteractionLocked、setPendingHumanPlayEnd。

  边界与不变量
  是唯一全量 reset 入口；不触碰 resolution owners。
  */
  function resetLocks() {
    setActionLocked(false);
    setInteractionLocked(false);
    setPendingHumanPlayEnd(false);
  }

  /*
  功能
  返回只读 action runtime snapshot。

  调用方
  Game compatibility accessors 与 tests。

  输入
  无。

  输出
  冻结 { actionLocked, interactionLocked, pendingHumanPlayEnd }。

  读取状态
  actionRuntime。

  写入状态
  无。

  调用函数
  Object.freeze。

  边界与不变量
  不返回 internal mutable object。
  */
  function getActionStateSnapshot() {
    return Object.freeze({
      actionLocked: actionRuntime.actionLocked,
      interactionLocked: actionRuntime.interactionLocked,
      pendingHumanPlayEnd: actionRuntime.pendingHumanPlayEnd
    });
  }

  /*
  功能
  查询 resolution owner。

  调用方
  Game zone helpers 与 ActionWorkflow finally。

  输入
  card 与 resolutionId。

  输出
  布尔值。

  读取状态
  actionRuntime.resolutionOwners。

  写入状态
  无。

  调用函数
  Map.get。

  边界与不变量
  只做 identity 查询。
  */
  function ownsResolution(card, resolutionId) {
    return Boolean(resolutionId && actionRuntime.resolutionOwners.get(card) === resolutionId);
  }

  /*
  功能
  记录卡牌实体 resolution owner。

  调用方
  Game moveHandToResolving。

  输入
  card 与 resolutionId。

  输出
  是否 claim 成功。

  读取状态
  actionRuntime.resolutionOwners。

  写入状态
  actionRuntime.resolutionOwners。

  调用函数
  Map.has/Map.set。

  边界与不变量
  已有 owner 时返回 false，不覆盖。
  */
  function claimResolution(card, resolutionId) {
    if (!card || !resolutionId || actionRuntime.resolutionOwners.has(card)) return false;
    actionRuntime.resolutionOwners.set(card, resolutionId);
    return true;
  }

  /*
  功能
  读取卡牌实体 resolution owner ID。

  调用方
  Game zone helpers 与 ActionWorkflow finally。

  输入
  card。

  输出
  resolutionId 或 null。

  读取状态
  actionRuntime.resolutionOwners。

  写入状态
  无。

  调用函数
  Map.get。

  边界与不变量
  不暴露 Map。
  */
  function getResolutionOwner(card) {
    return actionRuntime.resolutionOwners.get(card) ?? null;
  }

  /*
  功能
  释放卡牌实体 resolution owner。

  调用方
  ActionWorkflow finally。

  输入
  card。

  输出
  是否删除。

  读取状态
  actionRuntime.resolutionOwners。

  写入状态
  actionRuntime.resolutionOwners。

  调用函数
  Map.delete。

  边界与不变量
  不暴露 Map。
  */
  function releaseResolution(card) {
    return actionRuntime.resolutionOwners.delete(card);
  }

  /*
  功能
  返回 resolution owners 的只读快照 Map。

  调用方
  Game compatibility accessors 与 legacy test harness。

  输入
  无。

  输出
  new Map snapshot。

  读取状态
  actionRuntime.resolutionOwners。

  写入状态
  无。

  调用函数
  Map。

  边界与不变量
  修改返回 Map 不影响 owner Map。
  */
  function getResolutionOwnersSnapshot() {
    return new Map(actionRuntime.resolutionOwners);
  }

  /*
  功能
  返回 resolution owners 数量。

  调用方
  legacy tests。

  输入
  无。

  输出
  整数。

  读取状态
  actionRuntime.resolutionOwners.size。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不暴露 Map。
  */
  function getResolutionOwnerCount() {
    return actionRuntime.resolutionOwners.size;
  }

  /*
  功能
  执行通用卡牌使用 workflow。

  调用方
  AI play phase、human command 与 legacy tests。

  输入
  source、card、requestedTargets、selection 与 options。

  输出
  Promise<是否实际开始结算>。

  读取状态
  Game state、legacy legality/preparation/card-zone collaborators 与 session。

  写入状态
  卡牌经 zone collaborators；card-specific resolution 经 legacy resolver；generic locks/owners 经 actionRuntime。

  调用函数
  canPlayCard、canUseForcedAssault、getCardTargets、prepareTransferIntent、prepareLeverageIntent、preparePrivateCardSelectionIntent、moveHandToResolving、emitEvent、responseSystem、resolveCardEffect、finishResolvingToDiscard、isCardCommittedToDiscard、isCardCommittedToEquipment、cleanupFailedResolution、diagnostics.recordCardPlayed。

  边界与不变量
  借势嵌套锁豁免、counter/cancel/destination/failure cleanup 与旧 playCard 完全一致。
  */
  async function playCard(source, card, requestedTargets = [], selection = null, options = {}) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || state.isGameOver) return false;
    const plan = await runtime.cardRuntime.prepareCardAction(source, card, requestedTargets, selection, options);
    if (!runtime.isSessionValid(gameId)) return false;
    if (!plan.legality.ok || (actionRuntime.actionLocked && !plan.forcedAssault)) return false;
    let targets = plan.targets;
    const preparedTransfer = plan.preparedTransfer;
    const preparedLeverage = plan.preparedLeverage;
    const preparedPrivateSelection = plan.preparedPrivateSelection;

    const previousActionLocked = actionRuntime.actionLocked;
    actionRuntime.actionLocked = true;
    const resolutionId = nextResolutionId();
    let completed = false;
    let enteredResolving = false;
    let destinationCommitted = false;
    let expectedDestination = card.category === "equipment" ? "equipment" : "discard";
    let failureReason = null;
    try {
      let moved = false;
      try {
        moved = await runtime.moveHandToResolving(source, card, resolutionId);
      } finally {
        enteredResolving = ownsResolution(card, resolutionId);
      }
      if (!moved) return false;
      if (!runtime.isSessionValid(gameId)) return false;
      const targetLabel = plan.targetLabel;
      runtime.presentation.showCurrentAction({
        cardId: card.id,
        sourceLabel: source.name,
        targetLabel,
        displayTargets: runtime.getActionDisplayTargets(source, card, targets)
      });
      runtime.presentation.playActionCue("card");
      if (plan.useLogMessage) runtime.presentation.log(plan.useLogMessage);
      const useEvent = await runtime.emitEvent("beforeCardUse", { type: "beforeCardUse", source, card, targets, cancelled: false, metadata: {}, resolutionId });
      if (!runtime.isSessionValid(gameId)) return false;
      let cancelledBeforeResolve = useEvent.cancelled;
      if (!cancelledBeforeResolve && targets.length) {
        const targetEvent = { type: "targetSelected", source, card, targets, cancelled: false, metadata: {}, resolutionId };
        await runtime.emitEvent("targetSelected", targetEvent);
        if (!runtime.isSessionValid(gameId)) return false;
        targets = targetEvent.targets;
      }
      const resolveEvent = { type: "beforeCardResolve", source, card, targets, cancelled: false, metadata: {}, resolutionId };
      if (!cancelledBeforeResolve) await runtime.emitEvent("beforeCardResolve", resolveEvent);
      if (!runtime.isSessionValid(gameId)) return false;
      targets = resolveEvent.targets;
      cancelledBeforeResolve ||= resolveEvent.cancelled;
      const counterResult = !cancelledBeforeResolve && card.counterScope !== "target"
        ? await runtime.responseSystem.askForCounter(source, card, targets, {
          publicTransferContext: preparedTransfer?.publicContext ?? null,
          publicSelectionContext: preparedPrivateSelection?.publicContext ?? null,
          relatedTargets: preparedTransfer
            ? [preparedTransfer.privateIntent.from, preparedTransfer.privateIntent.receiver]
            : targets
        })
        : { status: "unavailable" };
      if (!runtime.isSessionValid(gameId) || counterResult.status === "cancelled") return false;
      const countered = counterResult?.status === "used";
      let destination = "discard";
      let effectResolved = false;
      let effectEffectiveTargets = null;
      if (cancelledBeforeResolve) {
        runtime.presentation.log(`「${card.name}」的效果被取消。`, "important");
      } else if (!countered) {
        const effectResult = await runtime.cardRuntime.resolveCardAction(source, card, targets, selection, resolutionId, plan);
        if (!runtime.isSessionValid(gameId)) return false;
        destination = effectResult.destination;
        effectResolved = effectResult.resolved ?? true;
        effectEffectiveTargets = Array.isArray(effectResult.effectiveTargets)
          ? effectResult.effectiveTargets
          : null;
      }
      expectedDestination = destination;
      if (destination === "discard") {
        const discarded = await runtime.finishResolvingToDiscard(card, resolutionId);
        destinationCommitted = discarded && runtime.isCardCommittedToDiscard(card);
        if (!destinationCommitted) throw new Error("结算牌未能进入弃牌堆");
      } else if (destination === "equipment") {
        destinationCommitted = runtime.isCardCommittedToEquipment(source, card);
        if (!destinationCommitted) throw new Error("装备牌未能进入装备区");
      } else {
        throw new Error("未知的卡牌结算目标区域");
      }
      if (!runtime.isSessionValid(gameId)) return false;
      const resolved = !countered && !cancelledBeforeResolve && effectResolved;
      const effectiveTargets = runtime.cardRuntime.getEffectiveTargets(
        state, source, card, targets, resolved, { effectiveTargets: effectEffectiveTargets }, plan
      );
      await runtime.emitEvent("cardUsed", {
        type: "cardUsed", source, card, targets, effectiveTargets,
        cancelled: !resolved, resolved, resolutionId
      });
      if (!runtime.isSessionValid(gameId)) return false;
      runtime.diagnostics.recordCardPlayed({ sourceId: source.id });
      if (selection?.selectionId) runtime.clearSelection(selection.selectionId);
      runtime.presentation.refresh();
      completed = true;
      return true;
    } catch (error) {
      failureReason = error;
      throw error;
    } finally {
      if (enteredResolving) {
        destinationCommitted = expectedDestination === "discard"
          ? runtime.isCardCommittedToDiscard(card)
          : expectedDestination === "equipment"
            ? runtime.isCardCommittedToEquipment(source, card)
            : false;
        if (!destinationCommitted && ownsResolution(card, resolutionId)) {
          runtime.cleanupFailedResolution(card, failureReason, resolutionId);
        } else if (destinationCommitted && ownsResolution(card, resolutionId)) {
          releaseResolution(card);
        }
      }
      if (selection?.selectionId) runtime.clearSelection(selection.selectionId);
      actionRuntime.actionLocked = previousActionLocked;
      if (!previousActionLocked && source.controllerType !== "human") {
        actionRuntime.interactionLocked = false;
        if (runtime.presentation.isThinkingActive()) runtime.presentation.clearThinking();
      }
      flushPendingHumanPlayEnd();
      if (completed && !previousActionLocked && !state.isGameOver && source.alive && source.controllerType === "human"
        && getCurrentActor(state)?.id === source.id && state.phase === "play") {
        runtime.presentation.setPrompt("继续出牌，或结束本次出牌阶段。", "选择一张可用手牌");
      }
      runtime.presentation.refresh();
    }
  }

  /*
  功能
  执行通用主动技能使用 workflow。

  调用方
  AI play phase、human command 与 legacy tests。

  输入
  source、skillId 与 targets。

  输出
  Promise<boolean>。

  读取状态
  Game state、legacy skill runtime 与 session。

  写入状态
  active skill usage 经 RuleUsageTransition；资源经 legacy skill execute。

  调用函数
  recordActiveSkillUse、skillRuntime、getSkillTargets。

  边界与不变量
  技能规则由 legacy skill runtime 决定，transition 只提交；finally 顺序与旧 useActiveSkill 一致。
  */
  async function useActiveSkill(source, skillId, targets = []) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || state.isGameOver) return false;
    const skill = runtime.skillRuntime.getActiveSkill(source);
    if (!skill || skill.id !== skillId || actionRuntime.actionLocked) return false;
    const energyCost = runtime.skillRuntime.getCost(source, skill);
    const legality = runtime.skillRuntime.canUse(source, skill, energyCost);
    if (!legality.ok) return false;
    const legalTargets = runtime.getSkillTargets(source, skill);
    if (!["none", "allEnemies"].includes(skill.targetType) && (!targets[0] || !legalTargets.includes(targets[0]))) return false;
    actionRuntime.actionLocked = true;
    recordActiveSkillUse(state, source, skill.id);
    try {
      const targetLabel = runtime.getActionTargetLabel(source, skill, targets);
      runtime.presentation.showCurrentAction({
        skillName: skill.name,
        sourceLabel: `${source.name} · 技能`,
        targetLabel,
        displayTargets: runtime.getActionDisplayTargets(source, skill, targets)
      });
      runtime.presentation.playActionCue("skill");
      await runtime.skillRuntime.execute(skill, source, targets, {
        resolutionId: runtime.createId("skill-resolution"), energyCost
      });
      if (!runtime.isSessionValid(gameId)) return false;
      runtime.presentation.refresh();
      return true;
    } finally {
      actionRuntime.actionLocked = false;
      if (source.controllerType !== "human") {
        actionRuntime.interactionLocked = false;
        if (runtime.presentation.isThinkingActive()) runtime.presentation.clearThinking();
      }
      flushPendingHumanPlayEnd();
      if (!state.isGameOver && source.controllerType === "human" && state.phase === "play") {
        runtime.presentation.setPrompt("技能结算完成，继续出牌或结束阶段。", "选择一张可用手牌");
      }
      runtime.presentation.refresh();
    }
  }

  /*
  功能
  处理真人点击手牌 command 并请求有限目标/卡牌流程选择。

  调用方
  main/UI command boundary。

  输入
  cardId。

  输出
  Promise<boolean>。

  读取状态
  human hand、current actor、phase、locks 与 legacy legality。

  写入状态
  interactionLocked；真实执行经 playCard。

  调用函数
  canPlayCard、getCardTargets、requestTarget、requestCardFlow、playCard。

  边界与不变量
  current actor/phase/lock/session 验证与旧 handleHumanCard 一致。
  */
  async function handleHumanCard(cardId) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId)) return false;
    const human = runtime.getHumanPlayer();
    const card = human.hand.find((entry) => entry.id === cardId);
    if (!card || getCurrentActor(state)?.id !== human.id || state.phase !== "play"
      || actionRuntime.actionLocked || actionRuntime.interactionLocked) return false;
    const legality = runtime.canPlayCard(human, card);
    if (!legality.ok) { runtime.presentation.setPrompt(legality.reason); return false; }
    actionRuntime.interactionLocked = true;
    runtime.presentation.refresh();
    try {
      const legalTargets = runtime.getCardTargets(human, card);
      let targets = [];
      if (!["none", "self", "allEnemies", "allLiving", "multiStage"].includes(card.targetType)) {
        const targetRequestId = runtime.createId("target-choice");
        const targetRequest = createTargetChoiceRequest({
          requestId: targetRequestId,
          actorId: human.id,
          gameId,
          stateVersion: state.stateVersion,
          targets: legalTargets,
          label: `为「${card.name}」选择目标`,
          sourcePlayerId: human.id,
          cardId: card.id
        });
        runtime.choiceContexts.set(targetRequestId, {
          players: legalTargets,
          prompt: `为「${card.name}」选择目标`,
          meta: { source: human, card }
        });
        let targetDecision;
        try {
          targetDecision = await runtime.choiceCoordinator.request(targetRequest);
        } finally {
          runtime.choiceContexts.delete(targetRequestId);
        }
        if (!runtime.isSessionValid(gameId)) return false;
        if (targetDecision.status !== "selected") return false;
        const target = legalTargets.find((entry) => entry.id === targetDecision.selectedIds?.[0]) ?? null;
        if (!target) return false;
        targets = [target];
      }
      let selection = null;
      if (card.selectionFlow?.length) selection = await runtime.requestCardFlow(human, card, targets);
      if (!runtime.isSessionValid(gameId)) return false;
      if (card.selectionFlow?.length && !selection) return false;
      return await playCard(human, card, targets, selection);
    } finally {
      actionRuntime.interactionLocked = false;
      flushPendingHumanPlayEnd();
      runtime.presentation.refresh();
    }
  }

  /*
  功能
  处理真人主动技能 command 并请求有限目标选择。

  调用方
  main/UI command boundary。

  输入
  无。

  输出
  Promise<boolean>。

  读取状态
  human active skill、current actor、phase、locks 与 legacy skill runtime。

  写入状态
  interactionLocked；真实执行经 useActiveSkill。

  调用函数
  skillRuntime、getSkillTargets、requestTarget、useActiveSkill。

  边界与不变量
  skill legality/lock/session 验证与旧 handleHumanSkill 一致。
  */
  async function handleHumanSkill() {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId)) return false;
    const human = runtime.getHumanPlayer();
    const skill = runtime.skillRuntime.getActiveSkill(human);
    if (!skill || actionRuntime.actionLocked || actionRuntime.interactionLocked
      || !runtime.skillRuntime.canUse(human, skill).ok) return false;
    actionRuntime.interactionLocked = true;
    runtime.presentation.refresh();
    try {
      const legalTargets = runtime.getSkillTargets(human, skill);
      let targets = [];
      if (!["none", "allEnemies"].includes(skill.targetType)) {
        const targetRequestId = runtime.createId("skill-target-choice");
        const targetRequest = createTargetChoiceRequest({
          requestId: targetRequestId,
          actorId: human.id,
          gameId,
          stateVersion: state.stateVersion,
          targets: legalTargets,
          label: `为「${skill.name}」选择目标`,
          sourcePlayerId: human.id
        });
        runtime.choiceContexts.set(targetRequestId, {
          players: legalTargets,
          prompt: `为「${skill.name}」选择目标`,
          meta: {}
        });
        let targetDecision;
        try {
          targetDecision = await runtime.choiceCoordinator.request(targetRequest);
        } finally {
          runtime.choiceContexts.delete(targetRequestId);
        }
        if (!runtime.isSessionValid(gameId)) return false;
        if (targetDecision.status !== "selected") return false;
        const target = legalTargets.find((entry) => entry.id === targetDecision.selectedIds?.[0]) ?? null;
        if (!target) return false;
        targets = [target];
      }
      return await useActiveSkill(human, skill.id, targets);
    } finally {
      actionRuntime.interactionLocked = false;
      flushPendingHumanPlayEnd();
      runtime.presentation.refresh();
    }
  }

  /*
  功能
  处理真人结束出牌 command。

  调用方
  main/UI command boundary。

  输入
  无。

  输出
  是否受理。

  读取状态
  current actor、phase 与 action locks。

  写入状态
  无。

  调用函数
  resolveHumanPlayEnd。

  边界与不变量
  仅当前真人 play phase 且无锁时受理。
  */
  function requestEndHumanPlay() {
    const state = runtime.getState();
    const human = runtime.getHumanPlayer();
    if (getCurrentActor(state)?.id !== human.id || state.phase !== "play"
      || actionRuntime.actionLocked || actionRuntime.interactionLocked) return false;
    runtime.resolveHumanPlayEnd(state.gameId);
    return true;
  }

  /*
  功能
  标记当前真人已阵亡并等待 action/interaction 锁释放后结束出牌等待。

  调用方
  Application DyingWorkflow death commit。

  输入
  player。

  输出
  是否立即释放。

  读取状态
  human identity/current actor 与 action locks。

  写入状态
  pendingHumanPlayEnd。

  调用函数
  flushPendingHumanPlayEnd。

  边界与不变量
  旧 human defeat release 语义不变。
  */
  function requestHumanPlayEndForDefeat(player) {
    const human = runtime.getHumanPlayer();
    if (!player || player.id !== human?.id || player.controllerType !== "human"
      || getCurrentActor(runtime.getState())?.id !== player.id) return false;
    actionRuntime.pendingHumanPlayEnd = true;
    return flushPendingHumanPlayEnd();
  }

  /*
  功能
  在核心结算锁与 UI 交互锁均释放后结束真人出牌等待。

  调用方
  playCard/useActiveSkill finally 与 requestHumanPlayEndForDefeat。

  输入
  无。

  输出
  是否释放。

  读取状态
  pendingHumanPlayEnd/actionLocked/interactionLocked/isDisposed。

  写入状态
  pendingHumanPlayEnd 与 UI promise resolution。

  调用函数
  resolveHumanPlayEnd。

  边界与不变量
  不抢跑回合循环；disposed 时只清标记。
  */
  function flushPendingHumanPlayEnd() {
    const state = runtime.getState();
    if (!actionRuntime.pendingHumanPlayEnd) return false;
    if (state.isDisposed) {
      actionRuntime.pendingHumanPlayEnd = false;
      return false;
    }
    if (actionRuntime.actionLocked || actionRuntime.interactionLocked) return false;
    actionRuntime.pendingHumanPlayEnd = false;
    runtime.resolveHumanPlayEnd(state.gameId);
    return true;
  }

  return Object.freeze({
    playCard,
    useActiveSkill,
    handleHumanCard,
    handleHumanSkill,
    requestEndHumanPlay,
    requestHumanPlayEndForDefeat,
    flushPendingHumanPlayEnd,
    setActionLocked,
    setInteractionLocked,
    setPendingHumanPlayEnd,
    resetLocks,
    getActionStateSnapshot,
    ownsResolution,
    claimResolution,
    getResolutionOwner,
    releaseResolution,
    getResolutionOwnersSnapshot,
    getResolutionOwnerCount
  });
}
