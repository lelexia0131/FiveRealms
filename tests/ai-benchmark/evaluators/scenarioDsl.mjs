/**
 * Scenario 评分 DSL：把"AI 实际选择"映射为 0~1 质量分。
 *
 * 使用离散等级而非虚假连续精度：
 *   Optimal     1.00  明确最优或等价最优
 *   Strong      0.80  强决策（小损失）
 *   Acceptable  0.60  可接受（明显但合理的损失）
 *   Poor        0.35  次优/错误顺序
 *   Severe      0.15  严重误判（如必被反制仍打战术牌）
 *   Catastrophic 0.00 非法/灾难性
 */

export const QUALITY = Object.freeze({
  OPTIMAL: 1.0,
  STRONG: 0.7,
  ACCEPTABLE: 0.5,
  POOR: 0.25,
  SEVERE: 0.1,
  CATASTROPHIC: 0.0
});

export const quality = (level, reason) => ({ score: level, reason });

export const isCard = (action, definitionId) => Boolean(
  action?.type === "card" && (action.card?.definitionId ?? action.cardId) === definitionId
);

export const isSkill = (action, skillId) => Boolean(
  action?.type === "skill" && (action.skill?.id ?? action.cardId) === skillId
);

export const isEnd = (action) => action?.type === "end";

export const targetIds = (action) => {
  if (Array.isArray(action?.targetIds)) return action.targetIds;
  return (action?.targets ?? []).map((target) => target?.id ?? target).filter((id) => id != null);
};

export const targetsInclude = (action, playerId) => targetIds(action).includes(playerId);

export const targetsOnly = (action, playerId) => (
  targetIds(action).length === 1 && targetIds(action)[0] === playerId
);

/** 依据 action 与备选答案表给分。 */
export function gradeByAction(action, answers, fallback = 0.2) {
  for (const answer of answers) {
    const { match, score, reason } = answer;
    if (match(action)) {
      return { score, reason };
    }
  }
  return { score: fallback, reason: `未命中任何预期动作（选择了 ${describeActionShort(action)}）` };
}

export function describeActionShort(action) {
  if (!action) return "null";
  if (action.type === "end") return "结束出牌";
  const cardLabel = action.type === "card"
    ? (action.card?.definitionId ?? action.cardId)
    : (action.skill?.id ?? action.cardId);
  if (action.type === "skill") return `技能:${cardLabel}`;
  const targets = Array.isArray(action.targetIds)
    ? action.targetIds
    : (action.targets ?? []).map((target) => target?.id ?? target).filter((id) => id != null);
  return `${cardLabel}->[${targets.join(",")}]`;
}

/** 常见答案构造器。 */
export const playCard = (definitionId, { target = null, anyTarget = false, score = 1, reason = "" } = {}) => ({
  match: (action) => {
    if (!isCard(action, definitionId)) return false;
    if (anyTarget) return targetIds(action).length > 0;
    if (target === null) return targetIds(action).length === 0;
    return targetsOnly(action, target);
  },
  score,
  reason
});

export const playSkill = (skillId, { target = null, anyTarget = false, score = 1, reason = "" } = {}) => ({
  match: (action) => {
    if (!isSkill(action, skillId)) return false;
    if (anyTarget) return targetIds(action).length > 0;
    if (target === null) return targetIds(action).length === 0;
    return targetsOnly(action, target);
  },
  score,
  reason
});

export const endTurn = (score = 1, reason = "") => ({
  match: (action) => isEnd(action),
  score,
  reason
});

/** 任意卡牌匹配（例如“使用了某张牌但目标不限”）。 */
export const anyCard = (score = 1, reason = "") => ({
  match: (action) => action?.type === "card",
  score,
  reason
});
