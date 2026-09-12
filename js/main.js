/**
 * 页面入口：创建 UIManager，并通过最终 composition root 创建/替换单局应用。
 */
import { MATCH_MODE } from "./application/match/MatchMode.js";
import { createNetworkFlow } from "./composition/createNetworkFlow.js";
import { createGameApplication } from "./composition/createGameApplication.js";
import { UIManager } from "./ui/UIManager.js";
import { HistoryStatsManager } from "./ui/history/HistoryStatsManager.js";
import { Debug } from "./utils/debug.js";

const historyStatsManager = new HistoryStatsManager();
const ui = new UIManager({ historyStatsManager });
let game = null;
let networkFlow = null;

/*
功能
在 MVP 终局结果确定后保存真人历史，并把 Store 新增结果提交给本局成就展示。

调用方
MatchApplication 的 onMatchResult callback。

输入
冻结 MatchResult 与真人 playerId。

输出
保存与本局成就会话更新完成的 Promise。

读取状态
HistoryStatsManager 与 UIManager 当前 Match 会话。

写入状态
history_data.json；成功后写 UIManager 本局成就会话，失败仅写诊断日志。

调用函数
HistoryStatsManager.recordMatchResult、UIManager.presentMatchAchievementUnlocks、Debug.log。

边界与不变量
不得重新计算评分、胜负、MVP 或 criteria；只有永久写入成功的新记录能进入本局会话；失败不得阻断终局展示和下一局流程。
*/
async function recordHistoryMatchResult(matchResult, humanPlayerId) {
  try {
    const archive = await historyStatsManager.recordMatchResult(matchResult, humanPlayerId);
    ui.presentMatchAchievementUnlocks(
      archive.newlyUnlockedAchievements,
      archive.achievements.cards
    );
  } catch (error) {
    Debug.log("History", "历史档案保存失败", error);
  }
}

/*
功能
销毁旧局并创建一局尚未选择编队方式的新征召流程。

调用方
开始、重新征召和下一局按钮 callback。

输入
无。

输出
无返回值。

读取状态
当前 game、UI aiSpeed 与新局首位玩家阵营。

写入状态
销毁旧 game、替换模块级 game 并切换 UI owner/编队方式屏幕。

调用函数
MatchApplication.dispose/setAiSpeed、createGameApplication、UIManager.attachGame/showSquadSelection。

边界与不变量
必须先 dispose 旧局；新局 UI owner 在任何异步流程启动前完成绑定。
*/
function startRecruitment() {
  game?.dispose();
  game = createGameApplication(ui, Math.random, { onMatchResult: recordHistoryMatchResult });
  ui.attachGame(game);
  game.setAiSpeed(ui.aiSpeed);
  ui.showSquadSelection();
}

/*
功能
销毁当前对局并返回首页。

调用方
NetworkFlow 模式页返回按钮 callback。

输入
无。

输出
无返回值。

读取状态
当前 game 与 UI session owner。

写入状态
销毁并解绑当前未开始的 game，切换 UI 到首页。

调用函数
MatchApplication.dispose、UIManager.attachGame/showStart。

边界与不变量
返回不会提交临时编队选择；再次点击开启本局时由 startRecruitment 创建全新对局。
*/
function returnToStart() {
  game?.dispose();
  game = null;
  ui.attachGame(null);
  ui.showStart();
}

/*
功能
把已确认的 Network setup 装入现有 Match 并初始化本地 UI。

调用方
NetworkFlow 游戏准备 callback。

输入
本地投影 setup 与 NetworkSession。

输出
无。

读取状态
UI aiSpeed 与 controlRouter 的本地真人身份。

写入状态
game 与 UI owner。

调用函数
createGameApplication、prepareNetworkMatch、showGame、controlRouter.humanPlayer。

边界与不变量
不发牌或启动回合；只由后续 MATCH_START 调用 startPreparedMatch。
*/
function prepareNetworkMatch(setup, networkSession) {
  game = createGameApplication(ui, Math.random, { mode: MATCH_MODE.NETWORK, networkSession });
  ui.attachGame(game);
  game.setAiSpeed(ui.aiSpeed);
  game.prepareNetworkMatch(setup);
  ui.showGame(game);
  ui.setMusicTeam(game.controlRouter.humanPlayer().battleTeam);
}

/*
功能
销毁并解绑当前 Match。

调用方
NetworkFlow navigation 与断线。

输入
无。

输出
无。

读取状态
game。

写入状态
game 与 UI owner。

调用函数
dispose、attachGame。

边界与不变量
重复调用安全，不写历史。
*/
function disposeCurrentMatch() {
  game?.dispose();
  game = null;
  ui.attachGame(null);
}

/*
功能
进入正式游玩方式选择页。

调用方
开始本局、单人编队返回与 Network 重新征召。

输入
无。

输出
无。

读取状态
networkFlow。

写入状态
页面 lifecycle。

调用函数
networkFlow.show。

边界与不变量
NetworkFlow 在模块装配时创建，但首页在用户名持久化成功前保持隐藏；该入口只切换既有流程页面。
*/
function showPlayModeSelection() {
  networkFlow.show();
}

/*
功能
按当前 Match mode 处理重新征召。

调用方
UI restart。

输入
无。

输出
无。

读取状态
game.mode。

写入状态
当前 Match lifecycle。

调用函数
showPlayModeSelection、startRecruitment。

边界与不变量
单人重新征召仍直达既有编队选择；Network 关闭旧房间。
*/
function restartRecruitment() {
  if (game?.mode === MATCH_MODE.NETWORK || ui.networkPresentation) showPlayModeSelection();
  else startRecruitment();
}

/*
功能
在结算后进入对应模式的下一局选角。

调用方
UI 下一局按钮。

输入
无。

输出
无。

读取状态
game.mode 与 Guest 展示会话。

写入状态
经既有模式入口更新 Match 生命周期。

调用函数
NetworkSession.nextMatch、startRecruitment。

边界与不变量
多人只提交回组选角意图，不调用离房导航；单人沿用重新征召。
*/
function playAgain() {
  if (game?.mode === MATCH_MODE.NETWORK || ui.networkPresentation) networkFlow.session.nextMatch();
  else startRecruitment();
}

networkFlow = createNetworkFlow({
  ui,
  capability: globalThis.fiveRealmsNetworkCapability ?? null,
  onSingleplayer: startRecruitment,
  onHome: returnToStart,
  onPrepareMatch: prepareNetworkMatch,
  onStartMatch: () => game.startPreparedMatch(),
  onDisposeMatch: disposeCurrentMatch
});

ui.setCallbacks({
  onStart: showPlayModeSelection,
  onRestart: restartRecruitment,
  onPlayAgain: playAgain,
  onNetworkClick: (event) => networkFlow?.handleClick?.(event),
  onNetworkSubmit: (event) => networkFlow?.handleSubmit?.(event),
  onNetworkPaste: (event) => networkFlow?.handlePaste?.(event),
  onNetworkInput: (event) => networkFlow?.handleInput?.(event),
  onSubmitUsername: submitUsername,
  onBackToStart: showPlayModeSelection,
  onBackToSquadSelection: startRecruitment,
  /*
  功能
  锁定本次编队方式并进入角色选择界面。

  调用方
  UIManager 编队方式卡片点击 callback。

  输入
  teamAssignmentMode，来自三张原生选项卡的公开 mode 值。

  输出
  无返回值。

  读取状态
  当前 game 与 MatchWorkflow 征召状态。

  写入状态
  MatchWorkflow teamAssignmentMode/candidates 与角色选择 UI。

  调用函数
  MatchApplication.startSelection、UIManager.showSelection。

  边界与不变量
  模式只能在当前未销毁的新局选择一次；此时不得提前生成阵营。
  */
  onSelectTeamAssignmentMode(teamAssignmentMode) {
    if (!game || game.state.isDisposed || game.matchWorkflow.teamAssignmentMode) return;
    const candidates = game.startSelection(teamAssignmentMode);
    ui.showSelection(candidates, teamAssignmentMode);
  },
  /*
  功能
  确认真人角色并启动当前对局。

  调用方
  UIManager 候选角色点击 callback。

  输入
  被点击的 characterId。

  输出
  对局确认流程完成的 Promise。

  读取状态
  当前 game、selectedCharacterId 与 UI session owner。

  写入状态
  展示当前对局并由 MatchWorkflow 完成角色确认/开局；失败时更新提示。

  调用函数
  UIManager.showGame/isGameAttached/setPrompt、MatchApplication.confirmCharacter、Debug.log。

  边界与不变量
  重复选择被拒绝；异步失败只能更新仍是当前 UI owner 的同一局。
  */
  async onSelectCharacter(characterId) {
    if (!game || game.state.selectedCharacterId) return;
    const selectedGame = game;
    ui.showGame(selectedGame);
    try {
      const confirmed = await selectedGame.confirmCharacter(characterId);
      if (confirmed && game === selectedGame && ui.isGameAttached(selectedGame)) {
        ui.setMusicTeam(selectedGame.state.players[0].battleTeam);
      }
    } catch (error) {
      Debug.log("Main", "对局初始化失败", error);
      if (game === selectedGame && ui.isGameAttached(selectedGame)) {
        ui.setPrompt("对局初始化失败，请重新征召。", "可点击右上角重新征召");
      }
    }
  },
  onCard: (cardId) => ui.networkPresentation ? networkFlow?.guestIntent?.("card", cardId) : game?.handleHumanCard(cardId),
  onSkill: () => ui.networkPresentation ? networkFlow?.guestIntent?.("skill") : game?.handleHumanSkill(),
  onEndPlay: () => ui.networkPresentation ? networkFlow?.guestIntent?.("end") : game?.requestEndHumanPlay(),
  onChangeAiSpeed: (speed) => game?.setAiSpeed(speed)
});

/*
功能
把已持久化的本地用户名作为 displayName 交给 NetworkFlow，并进入主界面。

调用方
bootstrap 的已有档案分支与 submitUsername 的保存成功分支。

输入
已通过 HistoryStatsManager 校验并落盘的用户名。

输出
无返回值。

读取状态
networkFlow.session。

写入状态
NetworkSession displayName 与首页。

调用函数
NetworkSession.setDisplayName、UIManager.showStart。

边界与不变量
username 只在此处转换为 displayName 并进入 participant metadata；不得参与身份、权限或路由；NetworkFlow 仍只创建一次。
*/
function enterMain(username) {
  networkFlow.session.setDisplayName(username);
  ui.showStart();
}

/*
功能
校验并等待用户名真实落盘，成功后才进入主界面。

调用方
UIManager 用户名表单 submit callback。

输入
表单原始用户名字符串。

输出
保存与界面切换完成的 Promise。

读取状态
HistoryStatsManager 当前历史快照与 storage。

写入状态
成功时仅写 profile.username 并进入主界面；失败时保留在填写页并展示错误。

调用函数
HistoryStatsManager.saveUsername、UIManager.setUsernamePending/setUsernameError、enterMain、Debug.log。

边界与不变量
必须 await storage 成功；保存失败、内存快照不变且不得提前创建 NetworkFlow 或进入首页。
*/
async function submitUsername(rawUsername) {
  ui.setUsernamePending(true);
  try {
    const username = await historyStatsManager.saveUsername(rawUsername);
    ui.setUsernamePending(false);
    enterMain(username);
  } catch (error) {
    Debug.log("Profile", "用户名保存失败", error);
    ui.setUsernameError(error?.message || "用户名保存失败，请重试。");
    ui.setUsernamePending(false);
  }
}

/*
功能
读取历史档案并按 profile.username 决定首次填写还是直接进入主界面。

调用方
模块底部 bootstrap 启动。

输入
无。

输出
无返回值；异步完成启动分流。

读取状态
HistoryStatsManager 初始化结果与 profile.username。

写入状态
缺失档案时由 HistoryStatsManager 条件创建空档；UI 切换填写页或首页。

调用函数
UIManager.setCallbacks/showUsernameSetup/setUsernameError、HistoryStatsManager.initialize/hasUsername/getUsername、enterMain、Debug.log。

边界与不变量
旧档案没有合法 profile.username 时必须停留在填写页；已有合法 username 时不得询问；初始化失败只展示错误，不伪造主界面。
*/
async function bootstrap() {
  try {
    await historyStatsManager.initialize();
  } catch (error) {
    Debug.log("History", "历史档案初始化失败", error);
    ui.showUsernameSetup();
    ui.setUsernameError("无法读取历史档案，请确认本地服务正常后重试。");
    return;
  }

  if (!historyStatsManager.hasUsername()) {
    ui.showUsernameSetup();
    return;
  }

  enterMain(historyStatsManager.getUsername());
}

void bootstrap();
