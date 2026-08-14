/**
 * AI 自主弃牌的共享保留价值评分（keep value）。
 *
 * 真实支付（AiCardSelector.chooseDiscards）与护援反事实（AiSimulator 的
 * guardian aid 确定性弃牌）必须共用同一份评分，避免两套相似规则再次漂移。
 * 纯计算：不修改 state、不访问隐藏敌方手牌、不调用随机数、不依赖 UI。
 * 分数越低，越应被优先弃置。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260814-spirit-medic-heal-economics";
import { getEquipmentKeepValueDeduction, getRoleCardAiValue } from "./roleCardValue.js?build=20260814-spirit-medic-heal-economics";

/** 低生命时即时响应牌（usageMode "response"）的边际生存价值；按危险程度分档，非绝对规则。 */
export const RESPONSE_SURVIVAL_BONUS_DANGER = 1;
export const RESPONSE_SURVIVAL_BONUS_LETHAL = 2;

/**
 * 计算单张手牌在“自主弃牌”场景下的保留价值。
 *
 * @param {Object} player 拥有者（真实玩家或模拟可见快照玩家）
 * @param {Object} card 手牌实体；模拟快照中的牌可只带 definitionId，
 *   类别与用法由卡牌表补齐，保证与真实牌对象同一评分语义
 * @param {Object} [context] 合法弃牌上下文：
 *   - stranded: 所有敌人都在攻击范围外时，突袭的保留价值上升
 *   - equippedDefinitionId: 当前已装备牌，用于装备替换/冗余边际
 *   - equipmentRetentionProbability: 旧装备仍保留的概率（模拟概率分支）
 */
export function getDiscardKeepValue(player, card, context = {}) {
  const definition = CARD_DEFINITIONS[card?.definitionId] ?? {};
  const category = card?.category ?? definition.category;
  const usageMode = card?.usageMode ?? definition.usageMode;
  let score = getRoleCardAiValue(player?.generalId, card.definitionId);
  if (category === "equipment") {
    score -= getEquipmentKeepValueDeduction(
      player?.generalId,
      card.definitionId,
      context.equippedDefinitionId ?? null,
      context.equipmentRetentionProbability ?? 1
    );
  }
  if ((player?.hp ?? 0) <= 2 && usageMode === "response") {
    score += (player?.hp ?? 0) <= 1 ? RESPONSE_SURVIVAL_BONUS_LETHAL : RESPONSE_SURVIVAL_BONUS_DANGER;
  }
  if (context.stranded && card.definitionId === "assault") score += 5;
  if ((player?.hp ?? 0) >= (player?.maxHp ?? 0) && card.definitionId === "recover") score -= 2;
  if ((player?.hp ?? 0) <= 2 && card.definitionId === "recover") score += 7;
  if ((player?.hp ?? 0) <= 2 && card.definitionId === "block") score += 6;
  if (card.definitionId === "symbiosis") score -= 5;
  return score;
}

/** 按保留价值升序排列候选弃牌；同价值保持原顺序，便于两侧确定性复现。 */
export function rankDiscardCandidates(player, cards, context = {}) {
  return [...cards].sort((left, right) => (
    getDiscardKeepValue(player, left, context) - getDiscardKeepValue(player, right, context)
  ));
}

/** 选出应优先弃置的 count 张牌。 */
export function chooseDiscardCandidates(player, cards, count, context = {}) {
  return rankDiscardCandidates(player, cards, context).slice(0, Math.max(0, Math.floor(Number(count) || 0)));
}
