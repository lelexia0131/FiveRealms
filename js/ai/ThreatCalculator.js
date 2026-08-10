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
    const roleTags = target.roleTags ?? [];
    const displayTags = target.tags ?? [];
    const statuses = target.statuses ?? [];
    const handCount = target.handCount ?? target.hand?.length ?? 0;
    let score = ((target.maxHp ?? 0) - (target.hp ?? 0)) * 2.5 + handCount * 1.4 + (target.energy ?? 0) * 2;
    if (roleTags.some((tag) => ["damage","attacker","caster","hunter"].includes(tag)) || displayTags.some((tag) => ["输出","群攻","爆发","突破"].includes(tag))) score += 4;
    if (roleTags.some((tag) => ["support","healer","tank","protector","control"].includes(tag)) || displayTags.some((tag) => ["防护","恢复","辅助","控制","过牌"].includes(tag))) score += 3;
    if ((target.hp ?? 0) + (target.shield ?? 0) <= expectedDamage) score += 24;
    if (statuses.includes("exposed") || statuses.includes("exposeWeakness") || statuses.includes("huntMark")) score += 4;
    score += (memory?.recentAggressors?.[target.id] ?? 0) * 2;
    return score;
  }
}
