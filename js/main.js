/**
 * 页面入口：创建 UIManager，并通过最终 composition root 创建/替换单局应用。
 */
import { createGameApplication } from "./composition/createGameApplication.js";
import { UIManager } from "./ui/UIManager.js";
import { Debug } from "./utils/debug.js";

const ui = new UIManager();
let game = null;

/*
功能
销毁旧局并创建一局新的角色选择流程。

调用方
开始、重新征召和再来一局按钮 callback。

输入
无。

输出
无返回值。

读取状态
当前 game、UI fastMode 与新局首位玩家阵营。

写入状态
销毁旧 game、替换模块级 game 并切换 UI owner/选将屏幕。

调用函数
MatchApplication.dispose/startSelection/setAnimationFastMode、createGameApplication、UIManager.attachGame/showSelection。

边界与不变量
必须先 dispose 旧局；新局 UI owner 在任何异步流程启动前完成绑定。
*/
function startSelection() {
  game?.dispose();
  game = createGameApplication(ui);
  ui.attachGame(game);
  game.setAnimationFastMode(ui.fastMode);
  const candidates = game.startSelection();
  ui.showSelection(candidates, game.state.players[0].battleTeam);
}

ui.setCallbacks({
  onStart: startSelection,
  onRestart: startSelection,
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
      await selectedGame.confirmCharacter(characterId);
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
  onToggleFastMode: (enabled) => game?.setAnimationFastMode(enabled)
});

ui.showStart();
