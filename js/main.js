/**
 * 页面入口：创建 UIManager，并通过最终 composition root 创建/替换单局应用。
 */
import { createGameApplication } from "./composition/createGameApplication.js";
import { UIManager } from "./ui/UIManager.js";
import { HistoryStatsManager } from "./ui/history/HistoryStatsManager.js";
import { Debug } from "./utils/debug.js";

const historyStatsManager = new HistoryStatsManager();
const ui = new UIManager({ historyStatsManager });
let game = null;

/*
功能
在 MVP 终局结果确定后把真人一行提交给长期历史档案。

调用方
MatchApplication 的 onMatchResult callback。

输入
冻结 MatchResult 与真人 playerId。

输出
保存尝试完成的 Promise。

读取状态
HistoryStatsManager。

写入状态
history_data.json；失败仅写诊断日志。

调用函数
HistoryStatsManager.recordMatchResult、Debug.log。

边界与不变量
不得重新计算评分、胜负或 MVP；档案写入失败不得阻断终局展示和下一局流程。
*/
async function recordHistoryMatchResult(matchResult, humanPlayerId) {
  try {
    await historyStatsManager.recordMatchResult(matchResult, humanPlayerId);
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
销毁未完成的征召并返回首页。

调用方
UIManager 编队页返回主界面按钮 callback。

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

ui.setCallbacks({
  onStart: startRecruitment,
  onRestart: startRecruitment,
  onBackToStart: returnToStart,
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
  onCard: (cardId) => game?.handleHumanCard(cardId),
  onSkill: () => game?.handleHumanSkill(),
  onEndPlay: () => game?.requestEndHumanPlay(),
  onChangeAiSpeed: (speed) => game?.setAiSpeed(speed)
});

ui.showStart();
void historyStatsManager.initialize().catch((error) => Debug.log("History", "历史档案初始化失败", error));
