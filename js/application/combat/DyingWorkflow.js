/*
模块职责
唯一拥有 Application Dying Workflow：reentrant queue、entry phase restoration、救援轮转、rescue response boundary、死亡 commit/cleanup、击杀奖励与死亡耦合状态清理。

上游
Application CombatWorkflow 与 composition damage command。

下游
Domain CombatRules/ResponseRules/StatusRules/transitions、Application Response rescue window、Application Combat heal、PresentationPort 与注入的 card-zone/match continuation collaborators。

状态边界
active queue 与 dyingContext 是 Application workflow state；Domain commit 只经 transitions；game.state.dyingContext 仅单向 projection。

信息边界
不读取 concrete UI/AI/DOM；rescue order 从 Domain 规则取得。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime 或 concrete adapters。
*/
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { isDying, isKillRewardEligible } from "../../domain/rules/combat/CombatRules.js";
import { getDyingRescueResponderOrder } from "../../domain/rules/response/ResponseRules.js";
import { isHuntMarkSourceExpired } from "../../domain/rules/status/StatusRules.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";
import { setMatchPhase } from "../../domain/state/transitions/MatchStateTransitions.js";
import { setAlive } from "../../domain/state/transitions/PlayerStateTransitions.js";
import { setHp } from "../../domain/state/transitions/ResourceTransitions.js";
import { setKillRewardGranted, setMomentum, setSkipActionPhase } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { clearStatuses, removeStatus } from "../../domain/state/transitions/StatusTransitions.js";
import { discardEquipment } from "../../domain/state/transitions/ZoneTransitions.js";

const REQUIRED_DEPENDENCIES = [
  "getState",
  "isSessionValid",
  "emitEvent",
  "requestDyingRescue",
  "heal",
  "discardCardFromHand",
  "drawCards",
  "syncDeckAliases",
  "requestHumanPlayEndForDefeat",
  "checkVictory",
  "createId",
  "presentation",
  "setDyingContextProjection"
];

/*
功能
创建 Application Dying Workflow。

调用方
composition root。

输入
显式注入的 state/session/event/response/heal/card-movement/match-continuation/presentation/projection collaborators。

输出
冻结 { enter, resolve, rescueOrder, kill, cleanup, cleanupHuntMarksForSource }。

读取状态
无。

写入状态
内部 active/queue/currentDyingContext；Domain 写入经 transitions；projection 经注入 setter。

调用函数
createRuleStateView、getDyingRescueResponderOrder、setMatchPhase、setHp、setAlive、clearStatuses、discardEquipment、setKillRewardGranted、setMomentum、setSkipActionPhase、removeStatus。

边界与不变量
队列和 phase restoration 原语义不变；rescue-order formula 不在本层复制。
*/
export function createDyingWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`DyingWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  let active = false;
  const queue = [];
  let currentDyingContext = null;

  /*
  功能
  提交当前濒死上下文并同步 game.state.dyingContext projection。

  调用方
  resolve 与 observers。

  输入
  dying context 或 null。

  输出
  无。

  读取状态
  无。

  写入状态
  currentDyingContext 与 projection。

  调用函数
  runtime.setDyingContextProjection。

  边界与不变量
  Application state；不 bump stateVersion；单向 projection。
  */
  function setDyingContextProjection(value) {
    currentDyingContext = value;
    runtime.setDyingContextProjection(value);
  }

  /*
  功能
  计算濒死救援响应者顺序。

  调用方
  resolve 与 boundary。

  输入
  target。

  输出
  ordered real Player entities。

  读取状态
  state.players。

  写入状态
  无。

  调用函数
  createRuleStateView、getDyingRescueResponderOrder。

  边界与不变量
  self first、顺时针存活队友；座位遍历只由 Domain Rule 负责。
  */
  function rescueOrder(target) {
    const state = runtime.getState();
    const view = createRuleStateView(state);
    const ids = getDyingRescueResponderOrder(view.players(), target.id);
    return ids.map((id) => state.players.find((player) => player.id === id)).filter(Boolean);
  }

  /*
  功能
  将一名生命不大于 0 的角色送入既有濒死队列并进入救援 workflow。

  调用方
  Application Combat damage/loseHp 与 killPlayer。

  输入
  target、可选 source 与 context。

  输出
  是否最终脱离濒死。

  读取状态
  Game session、target 存活与生命。

  写入状态
  active/queue；phase 经 MatchStateTransition；生命经 ResourceTransition。

  调用函数
  resolve、setMatchPhase、setHp。

  边界与不变量
  不决定伤害规则；reentrant 进入时同 target 只入队一次；finally 的 phase restoration 与旧实现一致。
  */
  async function enter(target, source = null, context = {}) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !isDying(target?.hp, target?.alive) || state.isGameOver) return target?.hp > 0;
    if (active) {
      if (!queue.some((entry) => entry.target.id === target.id)) queue.push({ target, source, context });
      return false;
    }
    const entryPhase = state.phase;
    active = true;
    queue.push({ target, source, context });
    let rescued = false;
    try {
      while (queue.length && !state.isGameOver && runtime.isSessionValid(gameId)) {
        const entry = queue.shift();
        if (isDying(entry.target.hp, entry.target.alive)) rescued = await resolve(entry.target, entry.source, entry.context);
        if (!runtime.isSessionValid(gameId)) return false;
      }
      return rescued;
    } finally {
      active = false;
      if (runtime.isSessionValid(gameId) && !state.isGameOver && state.phase === "dying") setMatchPhase(state, entryPhase);
    }
  }

  /*
  功能
  执行单个濒死目标的完整救援响应链并提交救援/死亡 commit。

  调用方
  enter。

  输入
  target、source 与 context。

  输出
  是否成功脱离濒死。

  读取状态
  Game session、玩家手牌、阵营与 response workflow。

  写入状态
  dyingContext 投影、phase/hp/alive/statuses 经 Domain transitions。

  调用函数
  emitEvent、setHp、setMatchPhase、requestDyingRescue、heal、kill、setAlive、clearStatuses。

  边界与不变量
  beforePlayerDying cancel 恢复到 1 的旧语义不变；每轮只要至少一次成功救援且仍濒死就继续新一轮。
  */
  async function resolve(target, source, context) {
    const state = runtime.getState();
    const gameId = state.gameId;
    const previousPhase = state.phase;
    const before = { type: "beforePlayerDying", target, source, context, cancelled: false };
    await runtime.emitEvent("beforePlayerDying", before);
    if (!runtime.isSessionValid(gameId)) return false;
    if (before.cancelled) {
      if (isDying(target.hp, target.alive)) {
        setHp(state, target, 1);
        runtime.presentation.log(`${target.name}的濒死被取消，生命恢复到1点以保持存活状态。`, "heal");
        runtime.presentation.showHealFeedback(target.id, 1);
        runtime.presentation.refresh();
      }
      return target.hp > 0;
    }
    if (!isDying(target.hp, target.alive)) return target.hp > 0;
    setMatchPhase(state, "dying");
    const initialContext = { targetId: target.id, need: 1 - target.hp, currentHp: target.hp };
    setDyingContextProjection(initialContext);
    runtime.presentation.log(`${target.name}进入濒死，还需恢复${1 - target.hp}点生命才能脱离濒死。`, "important");
    await runtime.emitEvent("playerDying", { type: "playerDying", target, source, need: 1 - target.hp, context });
    if (!runtime.isSessionValid(gameId)) return false;
    runtime.presentation.showDying({ playerId: target.id, need: 1 - target.hp, currentHp: target.hp });

    while (isDying(target.hp, target.alive) && runtime.isSessionValid(gameId)) {
      let usedThisRound = false;
      const order = rescueOrder(target);
      for (const rescuer of order) {
        if (target.hp >= 1 || !target.alive || state.isGameOver) break;
        const cards = rescuer.hand.filter((card) => card.definitionId === "recover");
        const response = await runtime.requestDyingRescue(rescuer, target, cards[0] ?? null);
        if (!runtime.isSessionValid(gameId)) return false;
        if (response.status === "cancelled") return false;
        if (response.status !== "used" || !response.card) continue;
        usedThisRound = true;
        const healed = await runtime.heal(rescuer, target, 1, {
          card: response.card, reason: "dyingRescue", isDyingRescue: true, silentLog: true,
          resultLog: () => `${rescuer.name}使用「调息」救援${target.name}，使其恢复至${target.hp}点生命。`
        });
        if (!runtime.isSessionValid(gameId)) return false;
        const updatedContext = { targetId: target.id, need: Math.max(0, 1 - target.hp), currentHp: target.hp };
        setDyingContextProjection(updatedContext);
        if (target.hp <= 0) runtime.presentation.log(`${target.name}仍处于濒死，还需恢复${1 - target.hp}点生命。`, "important");
        await runtime.emitEvent("dyingRescueUsed", { type: "dyingRescueUsed", target, rescuer, card: response.card, currentHp: target.hp });
        if (!runtime.isSessionValid(gameId)) return false;
        if (healed > 0) {
          await runtime.emitEvent("cardUsed", {
            type: "cardUsed",
            source: rescuer,
            card: response.card,
            targets: [target],
            effectiveTargets: [target],
            cancelled: false,
            resolved: true,
            resolutionId: runtime.createId("rescue-resolution"),
            usageContext: "dyingRescue"
          });
          if (!runtime.isSessionValid(gameId)) return false;
        }
        runtime.presentation.showDying({ playerId: target.id, need: Math.max(0, 1 - target.hp), currentHp: target.hp });
        runtime.presentation.refresh();
      }
      if (!usedThisRound) break;
    }

    setDyingContextProjection(null);
    runtime.presentation.hideDying();
    if (target.hp >= 1) {
      runtime.presentation.log(`${target.name}脱离濒死。`, "heal");
      await runtime.emitEvent("playerRescued", { type: "playerRescued", target, source });
      if (!runtime.isSessionValid(gameId)) return false;
      if (!state.isGameOver) setMatchPhase(state, previousPhase);
      return true;
    }
    await kill(target, source);
    if (!runtime.isSessionValid(gameId)) return false;
    if (!state.isGameOver) setMatchPhase(state, previousPhase);
    return false;
  }

  /*
  功能
  提交已决定的阵亡状态、清理手牌/装备并触发死亡事件与奖励 workflow。

  调用方
  resolve。

  输入
  target 与可选击杀者。

  输出
  session 是否仍有效。

  读取状态
  Game session、牌堆、装备与玩家。

  写入状态
  hp/alive/statuses/equipment/usage flags 经 Domain transitions。

  调用函数
  setHp、setAlive、clearStatuses、setMomentum、setSkipActionPhase、discardCardFromHand、discardEquipment、setKillRewardGranted、drawCards、checkVictory。

  边界与不变量
  击杀奖励资格由 Domain Combat Rule 决定；奖励数量由 RulesetDefinition 唯一提供；胜利继续由 Match continuation callback 负责。
  */
  async function kill(target, source) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !target.alive) return false;
    setHp(state, target, 0);
    setAlive(state, target, false);
    clearStatuses(state, target);
    if (target.turnFlags) {
      setMomentum(state, target, 0);
      setSkipActionPhase(state, target, false);
    }
    runtime.requestHumanPlayEndForDefeat?.(target);
    runtime.presentation.refresh();
    runtime.presentation.log(`${target.name}救援失败，阵亡。`, "important");
    for (const card of [...target.hand]) {
      await runtime.discardCardFromHand(target, card, "阵亡清理", { silent: true });
      if (!runtime.isSessionValid(gameId)) return false;
    }
    if (target.equipment) {
      const equipment = target.equipment;
      discardEquipment(state, target, equipment, state.deck.discardPile);
      runtime.presentation.log(`${target.name}的装备「${equipment.name}」随阵亡进入弃牌堆。`);
    }
    runtime.syncDeckAliases();
    await runtime.emitEvent("playerDead", { type: "playerDead", target, source });
    if (!runtime.isSessionValid(gameId)) return false;
    const targetFacts = { rewardGranted: target.gameFlags.killRewardGranted, battleTeam: target.battleTeam };
    const sourceFacts = source ? { alive: source.alive, battleTeam: source.battleTeam } : null;
    if (isKillRewardEligible(targetFacts, sourceFacts)) {
      setKillRewardGranted(state, target, true);
      const drawn = await runtime.drawCards(source, RULESET_DEFINITION.killRewardDrawCount, "击杀奖励", { silent: true });
      if (!runtime.isSessionValid(gameId)) return false;
      runtime.presentation.log(`${source.name}击杀了${target.name}，额外摸了${drawn}张牌。`, "important");
      await runtime.emitEvent("enemyKilled", { type: "enemyKilled", source, target, drawn });
      if (!runtime.isSessionValid(gameId)) return false;
    }
    await runtime.checkVictory();
    return runtime.isSessionValid(gameId);
  }

  /*
  功能
  清理死亡来源留下的全部猎印状态。

  调用方
  playerDead trigger bridge 与 tests。

  输入
  dead source id。

  输出
  无。

  读取状态
  state.players 的 huntMark 状态。

  写入状态
  status 经 StatusTransition；presentation refresh。

  调用函数
  isHuntMarkSourceExpired、removeStatus、presentation.refresh。

  边界与不变量
  只删除 sourceId 匹配的猎印；不迁 trigger engine。
  */
  function cleanupHuntMarksForSource(sourceId) {
    const state = runtime.getState();
    for (const player of state.players) {
      if (isHuntMarkSourceExpired(player.statuses.huntMark, sourceId)) {
        removeStatus(state, player, "huntMark");
      }
    }
    runtime.presentation.refresh();
  }

  /*
  功能
  清空濒死队列与 active 标记。

  调用方
  Game.dispose。

  输入
  无。

  输出
  无。

  读取状态
  无。

  写入状态
  queue/active。

  调用函数
  无。

  边界与不变量
  不清 Domain 状态。
  */
  function cleanup() {
    queue.length = 0;
    active = false;
  }

  return Object.freeze({
    /*
    功能
    返回当前濒死 workflow 是否正在排空队列。

    调用方
    observers。

    输入
    无。

    输出
    布尔值。

    读取状态
    active。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    队列与 active 同时只由本 workflow 修改。
    */
    get active() { return active; },
    /*
    功能
    返回当前濒死队列的只读冻结快照。

    调用方
    observers。

    输入
    无。

    输出
    冻结队列快照数组。

    读取状态
    queue。

    写入状态
    无。

    调用函数
    Array.slice、Object.freeze。

    边界与不变量
    不暴露内部可变数组；快照不随后续 enqueue 变化。
    */
    get queueSnapshot() { return Object.freeze(queue.slice()); },
    /*
    功能
    返回当前濒死上下文。

    调用方
    observers。

    输入
    无。

    输出
    dying context 或 null。

    读取状态
    currentDyingContext。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    game.state.dyingContext 只允许单向 projection。
    */
    get currentDyingContext() { return currentDyingContext; },
    enter,
    resolve,
    rescueOrder,
    kill,
    cleanup,
    cleanupHuntMarksForSource,
  });
}
