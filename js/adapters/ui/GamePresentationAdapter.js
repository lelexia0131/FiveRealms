/*
模块职责
把 Application PresentationPort 的 data-only semantic DTO bridge 到本局 UIManager session；只拥有 FR-ARCH-8 已证明的 concrete UI mapping，不拥有 application presentation policy。

上游
Game temporary composition root。

下游
application/ports/PresentationPort 与 UIManager。

状态边界
只写 legacy UI/presentation state；不写 Domain state。

信息边界
通过 playerId/card DTO 读取公开展示字段；不构造 Application workflow。

架构约束
不得依赖 Game class、AIController、SoundManager 或其它 adapter 实现；不 import Application workflow。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260816-legacy-recovery";
import { createPresentationPort } from "../../application/ports/PresentationPort.js?build=20260816-legacy-recovery";

/*
功能
创建单局 concrete PresentationPort UI adapter。

调用方
Game temporary composition root。

输入
log、getPlayerById、ui 与 renderTarget 能力。

输出
冻结 PresentationPort。

读取状态
getPlayerById 与静态卡牌展示定义。

写入状态
只写 UIManager 展示状态。

调用函数
createPresentationPort、ui.showJudgment、ui.showDying、ui.setCurrentCard、ui.playLightningHit、ui.queueFeedback、ui.render。

边界与不变量
Application 传入 data-only DTO；本 adapter 负责映射回 legacy UI 调用，不新增 UI 行为。
*/
export function createGamePresentationAdapter({ log, getPlayerById, getCardById, ui, renderTarget }) {
  if (typeof log !== "function" || typeof getPlayerById !== "function"
    || typeof getCardById !== "function" || !ui || !renderTarget) {
    throw new TypeError("GamePresentationAdapter 缺少 log/getPlayerById/getCardById/ui/renderTarget capability");
  }
  return createPresentationPort({
    log: (message, kind = "normal") => log(message, kind),
    showDamageFeedback: (playerId, amount) => ui.queueFeedback?.("damage", playerId, amount),
    showShieldFeedback: (playerId, amount) => ui.queueFeedback?.("shield", playerId, amount),
    showHealFeedback: (playerId, amount) => ui.queueFeedback?.("heal", playerId, amount),
    showDying: ({ playerId, need, currentHp }) => {
      const player = getPlayerById(playerId);
      if (!player) return;
      ui.showDying?.(player, { targetId: playerId, need, currentHp });
    },
    hideDying: () => ui.hideDying?.(),
    showJudgment: ({ playerId, card, delayedStatusContext }) => {
      const player = getPlayerById(playerId);
      if (!player || !card) return;
      ui.showJudgment?.(
        player,
        { name: card.name, categoryName: card.categoryName, art: card.art },
        delayedStatusContext ? { delayedStatusContext } : {}
      );
    },
    hideJudgment: () => ui.hideJudgment?.(),
    showCurrentEffect: ({ statusId, label, holderName }) => {
      const card = CARD_DEFINITIONS[statusId];
      if (!card) return;
      ui.setCurrentCard?.(card, label, holderName);
    },
    showLightningHit: (playerId) => ui.playLightningHit?.(playerId),
    showCurrentAction: ({ cardId, skillName, sourceLabel, targetLabel, displayTargets }) => {
      const card = cardId ? getCardById(cardId) : null;
      const displayCard = skillName ?? card;
      if (!displayCard) return;
      ui.setCurrentCard?.(displayCard, sourceLabel, targetLabel ?? "", displayTargets ?? null);
    },
    playActionCue: (kind) => ui.playSound?.(kind === "skill" ? "skill" : "playCard"),
    setPrompt: (message, handHint = "") => ui.setPrompt?.(message, handHint),
    showThinking: ({ playerId, message }) => {
      const player = getPlayerById(playerId);
      if (!player) return;
      ui.setThinking?.(true, player, message);
    },
    clearThinking: () => ui.setThinking?.(false),
    isThinkingActive: () => ui.thinkingPlayerId != null,
    showGameOver: (winnerTeam, humanWon) => ui.showGameOver?.(winnerTeam, humanWon),
    showPrivateReveal: ({ title, cardIds }) => {
      const cards = (cardIds ?? []).map((cardId) => getCardById(cardId)).filter(Boolean);
      return ui.showPrivateReveal?.(title, cards);
    },
    showDuel: ({ playerId, opponentId }) => {
      const player = getPlayerById(playerId);
      const opponent = getPlayerById(opponentId);
      if (player && opponent) ui.showDuel?.(player, opponent);
    },
    hideDuel: () => ui.hideDuel?.(),
    refresh: () => ui.render(renderTarget)
  });
}
