/**
 * 本文件独立计算公开威胁值，供 AI 目标评分使用。
 * 它只接受 AiVisibleState 中的公开字段，不读取敌方具体手牌，避免真人被硬编码优先攻击。
 */

export class ThreatCalculator {
  /**
   * 计算一个存活敌人的威胁。低血击杀、手牌、能量、攻击/恢复标签与近期仇恨都会加分。
   * @param {Object} viewer AI 自己的可见条目。
   * @param {Object} target 敌方可见条目。
   * @param {Object} memory AI 私有记忆，只含合法观察信息与近期伤害来源。
   * @param {number} expectedDamage 当前行动预计伤害。
   * @returns {number} 越高越值得优先处理。
   */
  static calculate(viewer, target, memory, expectedDamage = 1) {
    if (!target.alive || target.battleTeam === viewer.battleTeam) return -Infinity;
    let score = (target.maxHp - target.hp) * 2.5 + target.handCount * 1.4 + target.energy * 2;
    if (target.tags.includes("进攻") || target.tags.includes("群攻") || target.tags.includes("爆发")) score += 4;
    if (target.tags.includes("恢复") || target.tags.includes("辅助") || target.tags.includes("保护")) score += 3;
    if (target.hp + target.shield <= expectedDamage) score += 24;
    if (target.statuses.includes("exposed") || target.statuses.includes("huntMark")) score += 4;
    score += (memory.recentAggressors[target.id] ?? 0) * 2;
    return score;
  }
}
