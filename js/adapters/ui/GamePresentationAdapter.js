/*
模块职责
把 Application PresentationPort 的 data-only semantic DTO bridge 到本局 UIManager session；只拥有 concrete UI mapping，不拥有 Application presentation policy。

上游
composition root。

下游
application/ports/PresentationPort 与 UIManager。

状态边界
只写 UI/presentation state；不写 Domain state。

信息边界
通过 playerId/card DTO 读取公开展示字段；不构造 Application workflow。

架构约束
不得依赖 Game class、AIController、SoundManager 或其它 adapter 实现；不 import Application workflow。
*/
import { presentCard } from "./CardPresentationDefinitions.js";
import { createPresentationPort } from "../../application/ports/PresentationPort.js";

const RESOLUTION_VFX_BY_EFFECT_ID = Object.freeze({
  assault: "slash",
  shockwave: "explosion",
  provoke: "red-impact",
  duel: "cross-slash",
  hunt: "hunt",
  burningField: "burning-field",
  guardianAid: "guardian-aid"
});

/*
功能
创建单局 concrete PresentationPort UI adapter。

调用方
composition root。

输入
log、getPlayerById、getCardById、ui 与 renderTarget 能力。

输出
冻结 PresentationPort。

读取状态
getPlayerById、getCardById 与静态卡牌展示定义。

写入状态
只写 UIManager 展示状态。

调用函数
createPresentationPort、UIManager 的语义展示方法与 render。

边界与不变量
Application 传入 data-only DTO；伤害与减伤从同一 descriptor map 选择平级视觉变体；
本 adapter 只映射 UI 调用，不决定结算是否生效。
*/
export function createGamePresentationAdapter({ log, getPlayerById, getCardById, ui, renderTarget }) {
  if (typeof log !== "function" || typeof getPlayerById !== "function"
    || typeof getCardById !== "function" || !ui || !renderTarget) {
    throw new TypeError("GamePresentationAdapter 缺少 log/getPlayerById/getCardById/ui/renderTarget capability");
  }
  return createPresentationPort({
    log: (message, kind = "normal") => log(message, kind),
    showDamageFeedback: (playerId, amount, effectDefinitionId) => ui.queueFeedback?.(
      "damage",
      playerId,
      amount,
      RESOLUTION_VFX_BY_EFFECT_ID[effectDefinitionId] ?? null
    ),
    showMitigationFeedback: (playerId, amount, effectDefinitionId) => ui.queueFeedback?.(
      "mitigation",
      playerId,
      amount,
      RESOLUTION_VFX_BY_EFFECT_ID[effectDefinitionId] ?? null
    ),
    showShieldFeedback: (playerId, amount, mode) => ui.queueFeedback?.("shield", playerId, amount, mode),
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
        card,
        delayedStatusContext ? { delayedStatusContext } : {}
      );
    },
    hideJudgment: () => ui.hideJudgment?.(),
    showCurrentEffect: ({ statusId, label, holderName }) => {
      const card = presentCard(statusId);
      if (!card) return;
      ui.setCurrentCard?.(card, label, holderName);
    },
    showRadarSuccess: (playerId) => ui.playRadarSuccess?.(playerId),
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
    showPublicCardPool: ({ cardIds }) => {
      const cards = (cardIds ?? []).map((cardId) => getCardById(cardId)).filter(Boolean);
      ui.showPublicPool?.(cards);
    },
    hidePublicCardPool: () => ui.hidePublicPool?.(),
    refresh: () => ui.render(renderTarget)
  });
}
