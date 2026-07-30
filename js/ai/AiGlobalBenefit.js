const GLOBAL_BENEFIT_CARDS = new Set(["mutualBenefit", "symbiosis"]);

function benefitForPlayer(player, definitionId) {
  if (definitionId === "mutualBenefit") return 1;
  if (definitionId === "symbiosis") {
    return Math.min(1, Math.max(0, (player.maxHp ?? 0) - (player.hp ?? 0)));
  }
  return 0;
}

/**
 * 只依据当前可见局面评估全体受益牌，不读取隐藏手牌。
 * 互利按双方存活人数计算获得牌的总量；共生按双方本次能实际恢复的生命总量计算。
 */
export function assessGlobalBenefit(players, battleTeam, definitionId) {
  if (!GLOBAL_BENEFIT_CARDS.has(definitionId)) return null;
  const result = {
    allyAliveCount:0,
    enemyAliveCount:0,
    allyBenefit:0,
    enemyBenefit:0,
    netBenefit:0
  };
  for (const player of players ?? []) {
    if (!player?.alive) continue;
    const allied = player.battleTeam === battleTeam;
    const benefit = benefitForPlayer(player, definitionId);
    if (allied) {
      result.allyAliveCount += 1;
      result.allyBenefit += benefit;
    } else {
      result.enemyAliveCount += 1;
      result.enemyBenefit += benefit;
    }
  }
  result.netBenefit = result.allyBenefit - result.enemyBenefit;
  return result;
}

export function globalBenefitCounterDesire(players, battleTeam, definitionId) {
  const assessment = assessGlobalBenefit(players, battleTeam, definitionId);
  if (!assessment) return null;
  return assessment.netBenefit < 0 ? 1 : 0;
}
