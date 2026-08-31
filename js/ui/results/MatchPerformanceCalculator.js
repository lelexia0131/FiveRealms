import {
  MATCH_PERFORMANCE_DIMENSIONS,
  MATCH_PERFORMANCE_POLICY
} from "./MatchPerformancePolicy.js";

/*
功能
读取玩家开局阵营人数对应的六维标准值。

调用方
calculatePerformance。

输入
initialTeamSize 与既定 Match Performance policy。

输出
该玩家所属二人队或三人队的冻结标准对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
标准只按开局阵营人数选择；不接受结算时存活人数替代。
*/
export function getPerformanceThresholds(initialTeamSize, policy = MATCH_PERFORMANCE_POLICY) {
  const thresholds = policy.thresholdsByTeamSize[initialTeamSize];
  if (!thresholds) throw new RangeError(`不支持的开局阵营人数：${initialTeamSize}`);
  return thresholds;
}

/*
功能
按玩家有效回合读取本局回合系数。

调用方
calculatePerformance 与纯公式测试。

输入
effectiveRounds 与既定 Match Performance policy。

输出
一至十三回合返回固定表值；十四回合起在一的基础上逐回合增加 0.01。

读取状态
无。

写入状态
无。

调用函数
Math.floor、Math.max。

边界与不变量
有效回合按至少一回合处理；十四回合后的增量不封顶。
*/
export function getRoundMultiplier(effectiveRounds, policy = MATCH_PERFORMANCE_POLICY) {
  const rounds = Math.max(1, Math.floor(Number(effectiveRounds) || 0));
  if (rounds >= policy.incrementalRoundMultiplierFrom) {
    return 1 + (rounds - policy.incrementalRoundMultiplierFrom + 1)
      * policy.roundMultiplierIncrement;
  }
  return policy.roundMultiplierByEffectiveRound[rounds];
}

/*
功能
按胜方、结算存活状态与首次单人残局快照计算玩家个人胜局系数。

调用方
calculatePerformance 与纯公式测试。

输入
包含 initialTeamSize、won、aliveAtEnd 与 clutchEnemyCount 的 rawStats，以及既定 policy。

输出
失败或阵亡获胜返回一；存活获胜返回普通或对应残局系数。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
残局系数只归属于完成胜局的存活玩家；未知或不匹配的残局人数按普通存活胜局处理。
*/
export function getVictoryMultiplier(rawStats, policy = MATCH_PERFORMANCE_POLICY) {
  if (!rawStats.won || !rawStats.aliveAtEnd) return 1;
  return policy.clutchVictoryMultipliersByTeamSize[rawStats.initialTeamSize]
    ?.[rawStats.clutchEnemyCount] ?? policy.aliveVictoryMultiplier;
}

/*
功能
把独立的贡献事实合成为可正可负的贡献总量。

调用方
calculatePerformance。

输入
contributionFacts 的七项真实结算累计。

输出
队友获牌、敌方失牌、保护次数与封印贡献之和减去敌方获牌数。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
敌方获牌是唯一负项；不得在雷达归零前丢失负贡献。
*/
export function calculateContributionTotal(contributionFacts = {}) {
  return (Number(contributionFacts.allyCardsGranted) || 0)
    + (Number(contributionFacts.enemyCardsPlundered) || 0)
    + (Number(contributionFacts.enemyCardsDestroyed) || 0)
    + (Number(contributionFacts.enemyCardsTransferred) || 0)
    + (Number(contributionFacts.allyResourceActionsProtected) || 0)
    + (Number(contributionFacts.sealContribution) || 0)
    - (Number(contributionFacts.enemyCardsGranted) || 0);
}

/*
功能
把六维原始表现转换为以标准表现为一的雷达比例。

调用方
calculatePerformance 与雷达图测试。

输入
六维 raw 值、开局阵营人数与既定 policy。

输出
冻结的六维非负比例对象。

读取状态
无。

写入状态
无。

调用函数
getPerformanceThresholds。

边界与不变量
只保护零下限，绝不把超过标准的比例截断为一。
*/
export function normalizeForRadar(raw, initialTeamSize, policy = MATCH_PERFORMANCE_POLICY) {
  const thresholds = getPerformanceThresholds(initialTeamSize, policy);
  return Object.freeze(Object.fromEntries(MATCH_PERFORMANCE_DIMENSIONS.map((key) => [
    key,
    Math.max(0, Number(raw[key]) || 0) / thresholds[key]
  ])));
}

/*
功能
从单名玩家的只读累计事实计算六维、单项分、基础分、回合修正和最终分。

调用方
createMatchResultViewModel 与纯公式测试。

输入
包含 totals、effectiveRounds、initialTeamSize、胜负与残局快照的 rawStats。

输出
冻结的玩家表现派生对象。

读取状态
无。

写入状态
无。

调用函数
getPerformanceThresholds、getRoundMultiplier、getVictoryMultiplier、calculateContributionTotal、normalizeForRadar。

边界与不变量
有效回合至少为一；贡献事实保留正负净值，但用于评分的每回合贡献最低为零；回合与胜局系数都不改变 raw、ratio 或单项分。
*/
export function calculatePerformance(rawStats, policy = MATCH_PERFORMANCE_POLICY) {
  const totals = rawStats.totals;
  const effectiveRounds = Math.max(1, Number(rawStats.effectiveRounds) || 0);
  const contributionTotal = calculateContributionTotal(rawStats.contributionFacts);
  const raw = Object.freeze({
    firepower: (totals.enemyHpDamage + totals.enemyKills * policy.killBonus) / effectiveRounds,
    support: (
      totals.allyHealing
      + totals.allyRescueHealing * policy.rescueMultiplier
      + totals.allyMitigation
      + totals.allyShieldAbsorbed
    ) / effectiveRounds,
    activity: totals.cardsPlayed / effectiveRounds,
    skill: totals.skillEnergySpent / effectiveRounds,
    control: totals.enemyControls / effectiveRounds,
    contribution: Math.max(0, contributionTotal / effectiveRounds)
  });
  const thresholds = getPerformanceThresholds(rawStats.initialTeamSize, policy);
  const ratios = normalizeForRadar(raw, rawStats.initialTeamSize, policy);
  const scores = Object.freeze(Object.fromEntries(MATCH_PERFORMANCE_DIMENSIONS.map((key) => [
    key,
    (Number(raw[key]) || 0) / thresholds[key] * 100
  ])));
  const baseScore = MATCH_PERFORMANCE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0);
  const roundMultiplier = getRoundMultiplier(effectiveRounds, policy);
  const victoryMultiplier = getVictoryMultiplier(rawStats, policy);
  return Object.freeze({
    ...rawStats,
    contributionTotal,
    raw,
    ratios,
    scores,
    baseScore,
    roundMultiplier,
    victoryMultiplier,
    finalScore: baseScore * roundMultiplier * victoryMultiplier
  });
}
