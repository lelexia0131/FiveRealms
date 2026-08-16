/**
 * 页面入口与当前 minimal composition root：创建 UIManager 并管理每局 Game。
 * FR-ARCH-9 后 Match/Turn/Action/Combat/Response/Judgment workflow 已在 js/application；
 * AIController 仍依赖 Game、UIManager.createGameSession 仍需要 Game 实例，因此 concrete adapter
 * wiring 暂时保留在 Game shell，待 FR-ARCH-12/13 收敛 AI boundary 与 FR-ARCH-15 shell removal。
 */
import { Game } from "./core/Game.js?build=20260815-shadow-agent-p1-slot";
import { UIManager } from "./ui/UIManager.js?build=20260815-shadow-agent-p1-slot";
import { Debug } from "./utils/debug.js?build=20260815-shadow-agent-p1-slot";

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
