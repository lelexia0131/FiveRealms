/*
模块职责
唯一拥有 Application Match setup/victory/lifecycle sequencing：selection setup、character confirmation、initial state preparation、initial dealing、starting actor、match-start continuation 与 victory commit。

上游
composition boundary 与 main composition root。

下游
Domain TeamRules/TurnRules/transitions、Application Turn/Combat/Dying/Judgment capabilities 与 Ports/Adapters。

状态边界
pre-live setup 字段经显式 one-shot collaborator 写入；live Domain 字段只经 transitions；stateVersion 保持 authoritative。

信息边界
不读取 concrete UI/AI/DOM；controllerType 仅作为 participant metadata 用于 Player 构造。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime、AI search internals 或 concrete adapters。
*/
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import {
  getInitialHandCount, getMaxEnergy, getTeamSize, getWinningTeam
} from "../../domain/rules/team/TeamRules.js";
import { createRoundUsageState, createTurnUsageState } from "../../domain/rules/turn/TurnRules.js";
import { setCurrentPlayerIndex, setGameOver, setMatchPhase, setWinnerTeam } from "../../domain/state/transitions/MatchStateTransitions.js";
import { applyCharacterDefinition } from "../../domain/state/transitions/PlayerStateTransitions.js";
import { resetRoundFlags, resetTurnFlags } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { createGameOverFact, createGameStartFact } from "../../domain/events/MatchEvents.js";
import { TEAM_ASSIGNMENT_MODES } from "./TeamAssignmentMode.js";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "createId", "createPlayer", "assignTeams",
  "createCandidates", "assignAiCharacters", "emitEvent", "log", "getTeamName",
  "registerGlobalRules", "registerPassiveSkills", "buildDeck", "syncDeckAliases",
  "getTeamRules", "drawCards", "render", "startTurnLoop", "setRoster", "setMaxEnergy",
  "setStartingPlayerIndex", "setSelectedCharacterId", "publishFact",
  "responseCleanup", "cancelPendingInteractions", "showGameOver",
  "markDisposed", "resetActionLocks", "cleanupManagerCleanup",
  "hiddenCardSelectionCleanup", "dyingCleanup", "publicCardPoolCleanup", "eventDispatcherClear",
  "traceError", "getRandom"
];

/*
功能
创建 Application Match Workflow。

调用方
composition root。

输入
显式注入的 setup/transition/card-zone/match-start/lifecycle collaborators。

输出
  冻结 { startSelection, confirmCharacter, checkVictory, dispose } 与只读征召状态。

读取状态
无。

写入状态
内部 preLiveSetup 状态；经注入 setup commits 与 Domain transitions。

调用函数
getTeamSize、getInitialHandCount、getMaxEnergy、getWinningTeam、applyCharacterDefinition、resetTurnFlags、resetRoundFlags、setCurrentPlayerIndex、setWinnerTeam、setGameOver、setMatchPhase。

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
  let teamAssignmentMode = null;
  let pendingTeams = null;

  /*
  功能
  校验并执行一个 pre-live setup 写入。

  调用方
  startSelection 与 confirmCharacter。

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
  锁定本次编队方式并生成四名候选角色。

  调用方
  match application.startSelection boundary。

  输入
  teamAssignmentMode，two、three 或 random。

  输出
  候选角色数组。

  读取状态
  MatchState、合法编队方式集合与 match RNG。

  写入状态
  workflow 的 teamAssignmentMode、pendingTeams 与 candidates。

  调用函数
  assignTeams、createCandidates。

  边界与不变量
  每局只能选择一次模式；编队方式在此解析为 pre-live pending team layout，正式 roster 仍只在角色确认后创建；random 保持 assignTeams → createCandidates 的历史 RNG 顺序。
  */
  function startSelection(selectedMode) {
    const state = runtime.getState();
    if (state.isDisposed) return [];
    if (teamAssignmentMode) throw new Error("编队方式已确认，不能重复开始征召");
    if (!TEAM_ASSIGNMENT_MODES.includes(selectedMode)) throw new TypeError(`未知编队方式：${selectedMode}`);
    teamAssignmentMode = selectedMode;
    pendingTeams = runtime.assignTeams(selectedMode);
    candidates = runtime.createCandidates();
    return candidates;
  }

  /*
  功能
  确认真选角色、分配电脑角色、准备牌堆与初始手牌、选择首发并启动回合循环。

  调用方
  match application.confirmCharacter boundary。

  输入
  candidate characterId。

  输出
  true；session 失效返回 false；无效选择抛错。

  读取状态
  teamAssignmentMode、pendingTeams、candidates、team rules 与 deck。

  写入状态
  pre-live startingPlayerIndex 经 one-shot commit；其余 Domain 写入经 transitions。

  调用函数
  createPlayer、getMaxEnergy、applyCharacterDefinition、registerGlobalRules、registerPassiveSkills、buildDeck、resetTurnFlags、resetRoundFlags、drawCards、setCurrentPlayerIndex、emitEvent、startTurnLoop。

  边界与不变量
  使用 startSelection 已解析的 pending team layout；角色确认前不创建正式 roster；每个 await 保留 session 检查。
  */
  async function confirmCharacter(characterId) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!teamAssignmentMode || !pendingTeams) throw new Error("尚未选择编队方式");
    const selected = candidates.find((character) => character.id === characterId);
    if (!selected || state.selectedCharacterId) throw new Error("角色选择无效或已确认");
    const roster = pendingTeams.map((battleTeam, seatIndex) => runtime.createPlayer({
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
    runtime.emitEvent("teamAssigned", { type: "teamAssigned", players: state.players });
    const human = state.players[0];
    applyCharacterDefinition(state, human, selected);
    human.character = selected;
    runtime.setSelectedCharacterId(selected.id);
    const aiPlayers = state.players.slice(1);
    const smallTeamId = ["dawn", "dusk"].find((team) => getTeamSize({ players: state.players }, team) === RULESET_DEFINITION.smallTeamSize);
    const assigned = runtime.assignAiCharacters(aiPlayers, selected.id, smallTeamId);
    aiPlayers.forEach((player, index) => {
      applyCharacterDefinition(state, player, assigned[index]);
      player.character = assigned[index];
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
    await runtime.emitEvent("characterSelected", { type: "characterSelected", player: human, character: selected });
    if (!runtime.isSessionValid(gameId)) return false;
    await runtime.publishFact("gameStart", createGameStartFact({
      gameId,
      stateVersion: state.stateVersion,
      humanPlayerId: human.id,
      selectedCharacterId: selected.id
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
  match application.checkVictory boundary 与 Application Combat death continuation。

  输入
  无。

  输出
  winnerTeam 或 null。

  读取状态
  MatchState 存活阵营。

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
  match application.dispose boundary。

  输入
  无。

  输出
  无。

  读取状态
  state.isDisposed。

  写入状态
  isDisposed/action lock projections 与各 service cleanup。

  调用函数
  markDisposed、resetActionLocks、cleanupManagerCleanup、responseCleanup、cardSelectionCleanup、dyingCleanup、publicCardPoolCleanup、eventBusClear、cancelPendingInteractions、traceError。

  边界与不变量
  重复 dispose 直接返回；EventDispatcher concrete cleanup 只经注入 collaborator 执行。
  */
  function dispose() {
    const state = runtime.getState();
    if (state.isDisposed) return;
    teamAssignmentMode = null;
    pendingTeams = null;
    candidates = [];
    runtime.markDisposed();
    runtime.resetActionLocks();
    runtime.cleanupManagerCleanup();
    runtime.responseCleanup();
    runtime.hiddenCardSelectionCleanup();
    runtime.dyingCleanup();
    runtime.publicCardPoolCleanup();
    runtime.eventDispatcherClear();
    runtime.cancelPendingInteractions();
    runtime.traceError("Game", `清理对局 ${state.gameId}`);
  }

  return Object.freeze({
    /*
    功能
    返回当前征召已选择的编队方式。

    调用方
    main workflow、tests 与 lifecycle diagnostics。

    输入
    无。

    输出
    two、three、random 或尚未选择时的 null。

    读取状态
    teamAssignmentMode。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    仅 startSelection 可设置，dispose 必须重置为 null。
    */
    get teamAssignmentMode() { return teamAssignmentMode; },
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
    observers。

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
    修改返回数组不影响 confirmCharacter lookup。
    */
    get candidates() { return Object.freeze(candidates.slice()); },
    startSelection,
    confirmCharacter,
    checkVictory,
    dispose
  });
}
