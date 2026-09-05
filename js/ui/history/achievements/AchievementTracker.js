/*
模块职责
消费冻结 MatchResult 的结构化事实，更新模式化连续记录并返回本场应写入的成就。

上游
MatchPerformanceTracker/MatchResultViewModel 与 HistoryStatsManager。

下游
AchievementStore 的 records/streaks。

状态边界
只读取最终结果与传入的 streak 快照，不操作 DOM 或 GameState。

信息边界
不解析日志、不读取 UI 文本、不重新计算 MVP 或评分。

架构约束
判定是长期 milestone observer；所有数值事实来自现有 Match Performance 结果。
*/
import { ACHIEVEMENT_DEFINITIONS } from "./AchievementRegistry.js";

/*
功能
从最终玩家事实确定本场成就所属队伍规模。

调用方
updateAchievementStreaks、evaluateMatchAchievements。

输入
MatchResult 中的玩家结果。

输出
duo 或 trio scope。

读取状态
player.initialTeamSize、player.teamSize、teammateCharacterIds。

写入状态
无。

调用函数
Number。

边界与不变量
只有明确三人规模才返回 trio，缺省规模按二人处理。
*/
function modeScope(player) {
  const size = Number(player?.initialTeamSize ?? player?.teamSize ?? (player?.teammateCharacterIds?.length ?? 1) + 1);
  return size === 3 ? "trio" : "duo";
}

/*
功能
取得玩家的结构化成就事实。

调用方
meets。

输入
MatchResult 中的玩家结果。

输出
achievementFacts 对象或空对象。

读取状态
player.achievementFacts。

写入状态
无。

调用函数
无。

边界与不变量
只读取 MatchPerformanceTracker 已记录的事实，不从日志或 UI 推断。
*/
function factsFor(player) {
  return player?.achievementFacts ?? {};
}

/*
功能
更新当前队伍规模的胜利、MVP 与败方 MVP 连续记录。

调用方
evaluateMatchAchievements。

输入
已有 streak、真人最终结果。

输出
更新后的 streak 与本场模式 scope。

读取状态
player.won、player.isMvp、initialTeamSize。

写入状态
传入 streak 的对应模式桶。

调用函数
Math.max。

边界与不变量
各类中断只清零当前模式对应记录；二人/三人记录互不混合。
*/
export function updateAchievementStreaks(streaks, player) {
  const scope = modeScope(player);
  const target = streaks[scope] ?? (streaks[scope] = {
    win: 0, maxWin: 0, mvp: 0, maxMvp: 0, lostMvp: 0, maxLostMvp: 0
  });
  target.win = player?.won ? target.win + 1 : 0;
  target.mvp = player?.isMvp ? target.mvp + 1 : 0;
  target.lostMvp = player?.won === false && player?.isMvp === true ? target.lostMvp + 1 : 0;
  target.maxWin = Math.max(target.maxWin, target.win);
  target.maxMvp = Math.max(target.maxMvp, target.mvp);
  target.maxLostMvp = Math.max(target.maxLostMvp, target.lostMvp);
  return { scope, streak: target };
}

/*
功能
判断单项成就是否满足本场最终事实。

调用方
evaluateMatchAchievements。

输入
成就定义、玩家最终结果、对应模式连续记录、长期累计事实与本局全部玩家结果。

输出
满足条件时返回 true。

读取状态
definition.id、player canonical 结果、achievementFacts、streak、persistentFacts 与 MatchResult.players 的 raw.firepower。

写入状态
无。

调用函数
factsFor、Array.includes、Array.every、Number。

边界与不变量
只消费已存在的真实伤害、击杀、救援、装备、闪电、MVP、firepower 与残局事实；不重算 MVP、火力或分数。
*/
function meets(definition, player, streak, persistentFacts, matchResult) {
  const facts = factsFor(player);
  switch (definition.id) {
    case "first_victory": return Boolean(player?.won);
    case "skill_trinity": return (facts.activeSkillUses ?? 0) >= 3;
    case "first_blood": return (player?.totals?.enemyKills ?? 0) >= 1;
    case "rescue_beacon": return (facts.rescueCount ?? 0) >= 1;
    case "mvp_spotlight": return Boolean(player?.isMvp);
    case "matches_ten": return (persistentFacts?.completedMatches ?? 0) >= 10;
    case "full_health": {
      const finalHp = player?.finalHp ?? player?.hp;
      const finalMaxHp = player?.finalMaxHp ?? player?.maxHp;
      return Boolean(player?.aliveAtEnd)
        && Number.isFinite(Number(finalHp))
        && Number.isFinite(Number(finalMaxHp))
        && Number(finalHp) === Number(finalMaxHp);
    }
    case "win_streak_three": return streak.win >= 3;
    case "double_blood": return (player?.totals?.enemyKills ?? 0) >= 2;
    case "rescue_chain": return (facts.rescueCount ?? 0) >= 2;
    case "heavy_blow": return (facts.maxTurnDamage ?? 0) >= 3;
    case "damage_ten": return (player?.combatStats?.totalDamage ?? 0) >= 10;
    case "war_of_attrition": return (player?.combatStats?.damageTaken ?? 0) >= 5;
    case "flawless_victory": return Boolean(player?.won)
      && Boolean(player?.aliveAtEnd)
      && Number.isFinite(facts.teammateDeaths)
      && facts.teammateDeaths === 0;
    case "last_stand_duo": return Boolean(player?.won) && facts.clutchEnemyCounts?.includes?.(2);
    case "self_lightning": return Boolean(facts.selfLightningHit);
    case "single_punch": return (facts.maxSingleAttackDamage ?? 0) >= 3;
    case "last_stand_duo_three": return Boolean(player?.won) && facts.clutchEnemyCounts?.includes?.(3);
    case "executioner_turn": return (facts.maxTurnKills ?? 0) >= 2;
    case "iron_wall_epic": return (player?.combatStats?.damageTaken ?? 0) >= 8;
    case "rescue_master": return (facts.rescueCount ?? 0) >= 3;
    case "ace": return (player?.totals?.enemyKills ?? 0) >= 3;
    case "defeated_mvp": return player?.won === false && player?.isMvp === true;
    case "lightning_conductor": return (facts.lightningDamageTakenHits ?? 0) >= 2;
    case "radar_tactician": return (facts.radarTacticJudgments ?? 0) >= 5;
    case "energy_twenty_five": return (player?.totals?.skillEnergySpent ?? 0) >= 25;
    case "survivor_thirteen": return Number(facts.maxAliveRound ?? 0) > 12;
    case "last_stand_trio": return Boolean(player?.won) && facts.clutchEnemyCounts?.includes?.(2);
    case "score_over_thousand": return Number(player?.finalScore) > 1000;
    case "mvp_streak_ten": return streak.mvp >= 10;
    case "defeated_mvp_streak": return streak.lostMvp >= 2;
    case "serious_punch": return (facts.maxSingleAttackDamage ?? 0) >= 5;
    case "damage_taken_twelve": return (player?.combatStats?.damageTaken ?? 0) >= 12;
    case "card_creator": return (facts.cardsGained ?? 0) > 100;
    case "battle_over_eighteen": return Number(facts.maxAliveRound ?? 0) > 18;
    case "storm_scribe": return (facts.lightningCasts ?? 0) >= 2 && (facts.lightningHits ?? 0) >= 2;
    case "overflowing_grimoire": return (facts.maxHandCount ?? 0) >= 10;
    case "armory_keeper": return (facts.equipmentUses ?? 0) >= 10;
    case "all_rounder": return ["activity", "support", "contribution", "control", "skill", "firepower"]
      .every((dimension) => Number(player?.scores?.[dimension]) >= 100);
    case "accidental_success": {
      const humanFirepower = Number(player?.raw?.firepower);
      return (facts.committedAssaultUses ?? 0) === 0
        && Number.isFinite(humanFirepower)
        && matchResult.players.every((candidate) => candidate.playerId === player.playerId
          || humanFirepower >= Number(candidate?.raw?.firepower));
    }
    default: return false;
  }
}

/*
功能
评估本场真人玩家对应的全部首批成就。

调用方
HistoryStatsManager.recordMatchResult。

输入
冻结 MatchResult、真人 ID、可变 streak 快照与长期累计事实。

输出
满足条件的成就定义及其队伍 scope。

读取状态
MatchResult.players、ACHIEVEMENT_DEFINITIONS。

写入状态
streaks 当前模式桶；长期累计值仅由调用方提供，不在此持久化。

调用函数
updateAchievementStreaks、meets。

边界与不变量
只评估真人最终行；teamScope 不匹配时不会错误解锁另一模式。
*/
export function evaluateMatchAchievements(matchResult, humanPlayerId, streaks, persistentFacts = {}) {
  const player = matchResult?.players?.find((entry) => entry.playerId === humanPlayerId);
  if (!player) return { scope: "duo", unlocked: [], player: null };
  const { scope, streak } = updateAchievementStreaks(streaks, player);
  const unlocked = ACHIEVEMENT_DEFINITIONS.filter((definition) => {
    if (definition.teamScope === "duo" && scope !== "duo") return false;
    if (definition.teamScope === "trio" && scope !== "trio") return false;
    return meets(definition, player, streak, persistentFacts, matchResult);
  }).map((definition) => definition.id);
  return { scope, unlocked, player };
}

export { modeScope };
