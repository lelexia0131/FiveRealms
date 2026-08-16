/*
模块职责
唯一拥有 Application Match setup/victory/lifecycle sequencing：selection setup、general confirmation、initial state preparation、initial dealing、starting actor、match-start continuation 与 victory commit。

上游
core/Game legacy façade 与 main composition root。

下游
Domain TeamRules/TurnRules/transitions、Application Turn loop capability、Application Combat/Dying/Judgment façades 与 Ports/Adapters。

状态边界
pre-live setup 字段经显式 one-shot collaborator 写入；live Domain 字段只经 transitions；stateVersion 保持 authoritative。

信息边界
不读取 concrete UI/AI/DOM；controllerType 仅作为 participant metadata 用于 Player 构造。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventBus runtime、Planner 或 concrete adapters。
*/
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js?build=20260816-legacy-recovery";
import {
  getInitialHandCount, getMaxEnergy, getTeamSize, getWinningTeam
} from "../../domain/rules/team/TeamRules.js?build=20260816-legacy-recovery";
import { createRoundUsageState, createTurnUsageState } from "../../domain/rules/turn/TurnRules.js?build=20260816-legacy-recovery";
import { setCurrentPlayerIndex, setGameOver, setMatchPhase, setWinnerTeam } from "../../domain/state/transitions/MatchStateTransitions.js?build=20260816-legacy-recovery";
import { applyGeneralDefinition } from "../../domain/state/transitions/PlayerStateTransitions.js?build=20260816-legacy-recovery";
import { resetRoundFlags, resetTurnFlags } from "../../domain/state/transitions/RuleUsageTransitions.js?build=20260816-legacy-recovery";
import { createGameOverFact, createGameStartFact } from "../../domain/events/MatchEvents.js?build=20260816-legacy-recovery";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "createId", "createPlayer", "assignTeams",
  "createCandidates", "assignAiGenerals", "emitEvent", "log", "getTeamName",
  "registerGlobalRules", "registerPassiveSkills", "buildDeck", "syncDeckAliases",
  "getTeamRules", "drawCards", "render", "startTurnLoop", "setRoster", "setMaxEnergy",
  "setStartingPlayerIndex", "setSelectedGeneralId", "publishFact",
  "responseCleanup", "cancelPendingInteractions", "showGameOver",
  "markDisposed", "resetActionLocks", "cleanupManagerCleanup",
  "cardSelectionCleanup", "dyingCleanup", "publicCardPoolCleanup", "eventBusClear",
  "traceError", "getRandom"
];

/*
功能
创建 Application Match Workflow。

调用方
core/Game legacy façade composition。

输入
显式注入的 setup/transition/card-zone/match-start/lifecycle collaborators。

输出
冻结 { startSelection, confirmGeneral, checkVictory, dispose }。

读取状态
无。

写入状态
内部 preLiveSetup 状态；经注入 setup commits 与 Domain transitions。

调用函数
getTeamSize、getInitialHandCount、getMaxEnergy、getWinningTeam、applyGeneralDefinition、resetTurnFlags、resetRoundFlags、setCurrentPlayerIndex、setWinnerTeam、setGameOver、setMatchPhase。

边界与不变量
pre-live roster/maxEnergy/startingPlayerIndex 写入不 bump stateVersion；live 开始后拒绝再次 setup commit。
*/
export function createMatchWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`MatchWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  let preLiveSetup = {
    rosterCommitted: false,
    maxEnergyCommitted: false,
    startingPlayerIndexCommitted: false
  };
  let liveAuthoritativeMatch = false;
  let candidates = [];

  /*
  功能
  校验并执行一个 pre-live setup 写入。

  调用方
  startSelection 与 confirmGeneral。

  输入
  写入阶段 key 与 write 函数。

  输出
  write 返回值。

  读取状态
  preLiveSetup 与 liveAuthoritativeMatch。

  写入状态
  preLiveSetup 标记。

  调用函数
  无。

  边界与不变量
  live 开始后任何 setup 写入抛错；不提供 generic version bypass。
  */
  function commitPreLiveSetup(key, write) {
    if (liveAuthoritativeMatch) {
      throw new Error(`Match live 开始后禁止执行 pre-live setup：${key}`);
    }
    const value = write();
    preLiveSetup = { ...preLiveSetup, [key]: true };
    return value;
  }

  /*
  功能
  生成阵营、玩家花名册与四名候选角色。

  调用方
  Game.startSelection legacy façade。

  输入
  无。

  输出
  候选角色数组。

  读取状态
  Game state 与 random capability。

  写入状态
  pre-live roster/maxEnergy/candidates。

  调用函数
  assignTeams、createPlayer、getMaxEnergy、createCandidates、emitEvent。

  边界与不变量
  controllerType 是 Application participant metadata；真人固定 seat 0；RNG call order 不变。
  */
  function startSelection() {
    const state = runtime.getState();
    if (state.isDisposed) return [];
    const teams = runtime.assignTeams();
    const roster = teams.map((battleTeam, seatIndex) => runtime.createPlayer({
      id: runtime.createId("player"),
      seatIndex,
      battleTeam,
      controllerType: seatIndex === 0 ? "human" : "ai"
    }));
    commitPreLiveSetup("rosterCommitted", () => runtime.setRoster(roster));
    for (const player of state.players) {
      commitPreLiveSetup("maxEnergyCommitted", () => {
        runtime.setMaxEnergy(player, getMaxEnergy({ players: state.players }, player));
      });
    }
    candidates = runtime.createCandidates();
    runtime.emitEvent("teamAssigned", { type: "teamAssigned", players: state.players });
    return candidates;
  }

  /*
  功能
  确认真选角色、分配电脑角色、准备牌堆与初始手牌、选择首发并启动回合循环。

  调用方
  Game.confirmGeneral legacy façade。

  输入
  candidate generalId。

  输出
  true；session 失效返回 false；无效选择抛错。

  读取状态
  candidates、players、random、team rules 与 deck。

  写入状态
  pre-live startingPlayerIndex 经 one-shot commit；其余 Domain 写入经 transitions。

  调用函数
  applyGeneralDefinition、registerGlobalRules、registerPassiveSkills、buildDeck、resetTurnFlags、resetRoundFlags、drawCards、setCurrentPlayerIndex、emitEvent、startTurnLoop。

  边界与不变量
  初始事件/抽牌顺序与旧 confirmGeneral 完全一致；每个 await 保留 session 检查。
  */
  async function confirmGeneral(generalId) {
    const state = runtime.getState();
    const gameId = state.gameId;
    const selected = candidates.find((general) => general.id === generalId);
    if (!selected || state.selectedGeneralId) throw new Error("角色选择无效或已确认");
    const human = state.players[0];
    applyGeneralDefinition(state, human, selected);
    human.general = selected;
    runtime.setSelectedGeneralId(selected.id);
    const aiPlayers = state.players.slice(1);
    const smallTeamId = ["dawn", "dusk"].find((team) => getTeamSize({ players: state.players }, team) === RULESET_DEFINITION.smallTeamSize);
    const assigned = runtime.assignAiGenerals(aiPlayers, selected.id, smallTeamId);
    aiPlayers.forEach((player, index) => {
      applyGeneralDefinition(state, player, assigned[index]);
      player.general = assigned[index];
    });

    runtime.registerGlobalRules();
    runtime.registerPassiveSkills();
    runtime.buildDeck();
    runtime.syncDeckAliases();
    for (const player of state.players) {
      resetTurnFlags(state, player, createTurnUsageState(runtime.getTeamRules(player)));
      resetRoundFlags(state, player, createRoundUsageState());
      await runtime.drawCards(player, getInitialHandCount({ players: state.players }, player), "初始发牌", { silent: true });
      if (!runtime.isSessionValid(gameId)) return false;
    }
    commitPreLiveSetup("startingPlayerIndexCommitted", () => {
      const startingIndex = Math.floor(runtime.getRandom() * state.players.length);
      runtime.setStartingPlayerIndex(startingIndex);
    });
    setCurrentPlayerIndex(state, state.startingPlayerIndex);
    liveAuthoritativeMatch = true;
    await runtime.emitEvent("generalSelected", { type: "generalSelected", player: human, general: selected });
    if (!runtime.isSessionValid(gameId)) return false;
    await runtime.publishFact("gameStart", createGameStartFact({
      gameId,
      stateVersion: state.stateVersion,
      humanPlayerId: human.id,
      selectedGeneralId: selected.id
    }));
    if (!runtime.isSessionValid(gameId)) return false;

    const dawnCount = getTeamSize({ players: state.players }, "dawn");
    const duskCount = getTeamSize({ players: state.players }, "dusk");
    runtime.log(`本局晨星阵营有${dawnCount}名角色，暮影阵营有${duskCount}名角色。`, "important");
    runtime.log(`你选择了${human.name}，你的阵营是${runtime.getTeamName(human.battleTeam)}。`, "important");
    runtime.log(`电脑角色为${aiPlayers.map((player) => player.name).join("、")}。`);
    const currentActor = state.players[state.currentPlayerIndex];
    runtime.log(`${currentActor.name}获得首个行动回合。`, "important");
    runtime.render();
    runtime.startTurnLoop();
    return true;
  }

  /*
  功能
  查询 Domain winner rule 并提交胜利 workflow。

  调用方
  Game.checkVictory legacy façade 与 Application Combat death continuation。

  输入
  无。

  输出
  winnerTeam 或 null。

  读取状态
  Game state 存活阵营。

  写入状态
  winnerTeam/isGameOver/phase 经 Domain transitions。

  调用函数
  getWinningTeam、setWinnerTeam、setGameOver、setMatchPhase、responseCleanup、cancelPendingInteractions、emitEvent、showGameOver。

  边界与不变量
  不重复 dawnAlive/duskAlive formula；session/game-over 分支与旧实现一致。
  */
  async function checkVictory() {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || state.isGameOver) return state.winnerTeam;
    const winnerTeam = getWinningTeam(state);
    if (!winnerTeam) return null;
    setWinnerTeam(state, winnerTeam);
    setGameOver(state, true);
    setMatchPhase(state, "gameOver");
    runtime.responseCleanup();
    runtime.cancelPendingInteractions();
    runtime.log(`${runtime.getTeamName(winnerTeam)}消灭了全部敌人，获得胜利！`, "important");
    await runtime.publishFact("gameOver", createGameOverFact({
      gameId,
      stateVersion: state.stateVersion,
      winnerTeam
    }));
    if (!runtime.isSessionValid(gameId)) return null;
    runtime.render();
    runtime.showGameOver(winnerTeam, state.players[0].battleTeam === winnerTeam);
    return winnerTeam;
  }

  /*
  功能
  终止本局并清理延迟、响应、事件、UI Promise 与 workflow owner 队列。

  调用方
  Game.dispose legacy façade。

  输入
  无。

  输出
  无。

  读取状态
  state.isDisposed。

  写入状态
  legacy isDisposed/action lock projections 与各 service cleanup。

  调用函数
  markDisposed、resetActionLocks、cleanupManagerCleanup、responseCleanup、cardSelectionCleanup、dyingCleanup、publicCardPoolCleanup、eventBusClear、cancelPendingInteractions、traceError。

  边界与不变量
  重复 dispose 直接返回；EventBus concrete cleanup 仍属 FR-ARCH-11，这里只经 collaborator。
  */
  function dispose() {
    const state = runtime.getState();
    if (state.isDisposed) return;
    runtime.markDisposed();
    runtime.resetActionLocks();
    runtime.cleanupManagerCleanup();
    runtime.responseCleanup();
    runtime.cardSelectionCleanup();
    runtime.dyingCleanup();
    runtime.publicCardPoolCleanup();
    runtime.eventBusClear();
    runtime.cancelPendingInteractions();
    runtime.traceError("Game", `清理对局 ${state.gameId}`);
  }

  return Object.freeze({
    /*
    功能
    返回当前 pre-live setup 标记。

    调用方
    tests 与 architecture diagnostics。

    输入
    无。

    输出
    冻结 setup facts snapshot。

    读取状态
    preLiveSetup。

    写入状态
    无。

    调用函数
    Object.freeze。

    边界与不变量
    只读事实 snapshot；修改返回对象不影响内部 setup 标记。
    */
    get preLiveSetup() { return Object.freeze({ ...preLiveSetup }); },
    /*
    功能
    返回 live authoritative match 是否已开始。

    调用方
    tests 与 architecture diagnostics。

    输入
    无。

    输出
    布尔值。

    读取状态
    liveAuthoritativeMatch。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    从 starting actor commit 起为 true。
    */
    get liveAuthoritativeMatch() { return liveAuthoritativeMatch; },
    /*
    功能
    返回当前候选角色数组。

    调用方
    legacy observers。

    输入
    无。

    输出
    冻结候选数组 snapshot。

    读取状态
    candidates。

    写入状态
    无。

    调用函数
    Array.slice、Object.freeze。

    边界与不变量
    修改返回数组不影响 confirmGeneral lookup。
    */
    get candidates() { return Object.freeze(candidates.slice()); },
    startSelection,
    confirmGeneral,
    checkVictory,
    dispose
  });
}
