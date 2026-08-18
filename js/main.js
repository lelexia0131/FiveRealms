/**
 * 页面入口：创建 UIManager，并通过最终 composition root 创建/替换单局应用。
 */
import { createGameApplication } from "./composition/createGameApplication.js?build=20260818-skill-rules-locality-refactor";
import { UIManager } from "./ui/UIManager.js?build=20260818-skill-rules-locality-refactor";
import { Debug } from "./utils/debug.js?build=20260818-skill-rules-locality-refactor";

const ui = new UIManager();
let game = null;

/*
功能
执行 startSelection 对应的 main 职责。

调用方
本模块内部流程及显式公开边界。

输入
函数签名声明的参数。

输出
函数实现声明的返回值。

读取状态
仅函数体显式读取的参数、模块或实例状态。

写入状态
仅执行函数体显式声明的写入；查询路径不写状态。

调用函数
仅调用函数体中显式列出的依赖。

边界与不变量
遵守模块头定义的 ownership、状态与信息边界。
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
  执行 onSelectCharacter 对应的 main 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
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
