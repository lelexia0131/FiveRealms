/**
 * 本文件是页面入口，只负责连接 UIManager 与每局新建的 Game。
 * 它不实现卡牌、AI 或技能规则；重新开始时必须先 dispose 旧局，再创建新 gameId。
 */
import { Game } from "./core/Game.js?build=20260805-ai-hidden-world-sampling-v85";
import { UIManager } from "./ui/UIManager.js?build=20260805-ai-hidden-world-sampling-v85";
import { Debug } from "./utils/debug.js?build=20260805-ai-hidden-world-sampling-v85";

const ui = new UIManager();
let game = null;

function startSelection() {
  game?.dispose();
  game = new Game(ui);
  ui.attachGame(game);
  game.setAnimationFastMode(ui.fastMode);
  const candidates = game.startSelection();
  ui.showSelection(candidates, game.state.players[0].battleTeam);
}

ui.setCallbacks({
  onStart: startSelection,
  onRestart: startSelection,
  async onSelectGeneral(generalId) {
    if (!game || game.state.selectedGeneralId) return;
    const selectedGame = game;
    ui.showGame(selectedGame);
    try {
      await selectedGame.confirmGeneral(generalId);
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
