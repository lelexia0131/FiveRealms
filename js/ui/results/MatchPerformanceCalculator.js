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
按玩家有效回合读取固定的样本时长衰退系数。

调用方
calculatePerformance 与纯公式测试。

输入
effectiveRounds 与既定 Match Performance policy。

输出
一至十回合的固定表值；十一回合及以上返回一。

读取状态
无。

写入状态
无。

调用函数
Math.floor、Math.max。

边界与不变量
有效回合按至少一回合处理；系数不依赖全场总轮数或其他玩家。
*/
export function getRoundDecayMultiplier(effectiveRounds, policy = MATCH_PERFORMANCE_POLICY) {
  const rounds = Math.max(1, Math.floor(Number(effectiveRounds) || 0));
  if (rounds >= policy.fullRoundDecayFrom) return 1;
  return policy.roundDecayByEffectiveRound[rounds];
}

/*
功能
把独立的团队牌资源事实合成为可正可负的贡献总量。

调用方
calculatePerformance。

输入
contributionFacts 的六项真实资源变化累计。

输出
队友获牌、敌方失牌和保护次数之和减去敌方获牌数。

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
包含 totals、effectiveRounds、initialTeamSize 与 aliveAtEnd 的 rawStats。

输出
冻结的玩家表现派生对象。

读取状态
无。

写入状态
无。

调用函数
getPerformanceThresholds、getRoundDecayMultiplier、calculateContributionTotal、normalizeForRadar。

边界与不变量
有效回合至少为一；贡献分允许为负而雷达贡献最低为零；回合与存活倍率都不改变 raw、ratio 或单项分。
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
    skill: totals.activeSkillsUsed / effectiveRounds,
    control: totals.enemyControls / effectiveRounds,
    contribution: contributionTotal / effectiveRounds
  });
  const thresholds = getPerformanceThresholds(rawStats.initialTeamSize, policy);
  const ratios = normalizeForRadar(raw, rawStats.initialTeamSize, policy);
  const scores = Object.freeze(Object.fromEntries(MATCH_PERFORMANCE_DIMENSIONS.map((key) => [
    key,
    (Number(raw[key]) || 0) / thresholds[key] * 100
  ])));
  const baseScore = MATCH_PERFORMANCE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0);
  const roundDecayMultiplier = getRoundDecayMultiplier(effectiveRounds, policy);
  const survivalMultiplier = rawStats.aliveAtEnd ? policy.survivalMultiplier : 1;
  return Object.freeze({
    ...rawStats,
    contributionTotal,
    raw,
    ratios,
    scores,
    baseScore,
    roundDecayMultiplier,
    survivalMultiplier,
    finalScore: baseScore * roundDecayMultiplier * survivalMultiplier
  });
}
