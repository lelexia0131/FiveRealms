/*
模块职责
拥有 History achievements namespace 的 schema、迁移、首次解锁与安全 ViewModel 投影。

上游
HistoryStatsManager 与 AchievementView。

下游
同一 history_data.json 持久化对象。

状态边界
只操作传入的历史快照副本，不访问 GameState、DOM 或 localStorage。

信息边界
未解锁隐藏成就的 ViewModel 不包含真实条件与描述。

架构约束
首次解锁时间只写一次；duo/trio 记录彼此独立。
*/
import { ACHIEVEMENT_DEFINITIONS, sortAchievements } from "./AchievementRegistry.js";

export const ACHIEVEMENT_SCHEMA_VERSION = 2;

/*
功能
创建版本化的空成就命名空间。

调用方
HistoryStatsManager 初始化与旧档案迁移。

输入
无。

输出
可写的成就 schema 对象。

读取状态
ACHIEVEMENT_SCHEMA_VERSION。

写入状态
无。

调用函数
无。

边界与不变量
长期完成局数独立保存；全部 streak 按二人/三人分桶，records 只保存首次解锁时间。
*/
export function createEmptyAchievementData() {
  return {
    schemaVersion: ACHIEVEMENT_SCHEMA_VERSION,
    records: {},
    completedMatches: 0,
    streaks: {
      duo: { win: 0, maxWin: 0, mvp: 0, maxMvp: 0, lostMvp: 0, maxLostMvp: 0 },
      trio: { win: 0, maxWin: 0, mvp: 0, maxMvp: 0, lostMvp: 0, maxLostMvp: 0 }
    }
  };
}

/*
功能
从旧档案保留的最近终局记录重建按模式分桶的败方 MVP 连续值。

调用方
normalizeAchievementData 的 schema v1 迁移分支。

输入
按最新到最旧排列且已规范化的 recent records。

输出
duo/trio 各自当前与最近记录范围内最高的败方 MVP 连续值。

读取状态
record.teammateCharacterIds、won 与 isMvp。

写入状态
无。

调用函数
Array.reverse、Math.max。

边界与不变量
另一模式的对局不打断当前模式；无法确认模式的旧记录会同时截断两个桶，避免迁移产生虚假连续次数。
*/
function rebuildLegacyLostMvpStreaks(records) {
  const rebuilt = {
    duo: { lostMvp: 0, maxLostMvp: 0 },
    trio: { lostMvp: 0, maxLostMvp: 0 }
  };
  for (const record of [...records].reverse()) {
    const teammateCount = Array.isArray(record.teammateCharacterIds)
      ? record.teammateCharacterIds.length
      : null;
    const scope = teammateCount === 1 ? "duo" : teammateCount === 2 ? "trio" : null;
    if (!scope) {
      rebuilt.duo.lostMvp = 0;
      rebuilt.trio.lostMvp = 0;
      continue;
    }
    const target = rebuilt[scope];
    target.lostMvp = record.won === false && record.isMvp === true ? target.lostMvp + 1 : 0;
    target.maxLostMvp = Math.max(target.maxLostMvp, target.lostMvp);
  }
  return rebuilt;
}

/*
功能
把旧档案中的成就字段迁移为当前版本。

调用方
HistoryStatsManager.normalizeHistoryData。

输入
未知 achievements 值与已规范化的最近终局记录。

输出
包含当前 schemaVersion、records、长期累计字段与 streaks 的安全对象。

读取状态
旧成就对象、最近终局记录与当前 schema。

写入状态
无。

调用函数
createEmptyAchievementData、rebuildLegacyLostMvpStreaks、Number、Object.entries。

边界与不变量
schema v1 的全局败方 MVP 值只按可证明的最近终局事实迁移；非法时间戳被丢弃。
*/
export function normalizeAchievementData(source, recentRecords = []) {
  const empty = createEmptyAchievementData();
  if (!source || typeof source !== "object" || Array.isArray(source)) return empty;
  const schemaVersion = Number(source.schemaVersion) || 1;
  if (schemaVersion > ACHIEVEMENT_SCHEMA_VERSION) {
    throw new Error(`成就档案版本 ${schemaVersion} 高于当前支持版本 ${ACHIEVEMENT_SCHEMA_VERSION}`);
  }
  for (const [achievementId, value] of Object.entries(source.records ?? {})) {
    if (!value || typeof value !== "object") continue;
    const record = {};
    for (const scope of ["duo", "trio"]) {
      const unlockedAt = value[scope]?.unlockedAt;
      if (typeof unlockedAt === "string" && !Number.isNaN(new Date(unlockedAt).getTime())) {
        record[scope] = { unlockedAt };
      }
    }
    if (Object.keys(record).length) empty.records[achievementId] = record;
  }
  const completedMatches = Number(source.completedMatches);
  if (Number.isFinite(completedMatches) && completedMatches >= 0) {
    empty.completedMatches = Math.floor(completedMatches);
  }
  for (const scope of ["duo", "trio"]) {
    const stored = source.streaks?.[scope] ?? {};
    const streak = empty.streaks[scope];
    for (const key of Object.keys(streak)) {
      const value = Number(stored[key]);
      if (Number.isFinite(value) && value >= 0) streak[key] = Math.floor(value);
    }
    streak.maxWin = Math.max(streak.maxWin, streak.win);
    streak.maxMvp = Math.max(streak.maxMvp, streak.mvp);
    streak.maxLostMvp = Math.max(streak.maxLostMvp, streak.lostMvp);
  }
  if (schemaVersion < 2) {
    const rebuilt = rebuildLegacyLostMvpStreaks(recentRecords);
    for (const scope of ["duo", "trio"]) Object.assign(empty.streaks[scope], rebuilt[scope]);
  }
  return empty;
}

/*
功能
在指定成就/队伍范围写入首次解锁时间。

调用方
AchievementTracker 与 HistoryStatsManager.recordMatchResult。

输入
成就 records、成就 ID、队伍 scope 与 ISO 时间。

输出
本次是否产生了新的解锁记录。

读取状态
records[achievementId][scope]。

写入状态
只在缺少 unlockedAt 时写入。

调用函数
无。

边界与不变量
重复达成永远不覆盖首次时间。
*/
export function recordAchievementUnlock(records, achievementId, scope, unlockedAt) {
  if (!records || !achievementId || !["duo", "trio"].includes(scope)) return false;
  const existing = records[achievementId]?.[scope]?.unlockedAt;
  if (existing) return false;
  if (!records[achievementId]) records[achievementId] = {};
  records[achievementId][scope] = { unlockedAt };
  return true;
}

/*
功能
把内部成就定义和持久化记录投影为卡片 ViewModel。

调用方
AchievementView 与 HistoryArchiveView。

输入
成就 records 与可选当前事实进度。

输出
按稳定顺序排列的安全 ViewModel 数组。

读取状态
ACHIEVEMENT_DEFINITIONS、records。

写入状态
无。

调用函数
sortAchievements、Object.freeze。

边界与不变量
隐藏且未解锁时不带真实 criteria/description；普通成就可带完整条件。
*/
export function buildAchievementViewModels({ records = {}, progress = {} } = {}) {
  return Object.freeze(sortAchievements(ACHIEVEMENT_DEFINITIONS).map((definition) => {
    const record = records[definition.id] ?? {};
    const unlocked = {
      duo: Boolean(record.duo?.unlockedAt),
      trio: Boolean(record.trio?.unlockedAt)
    };
    const supportedScopes = definition.teamScope === "duo" ? ["duo"] : definition.teamScope === "trio" ? ["trio"] : ["duo", "trio"];
    const doneCount = supportedScopes.filter((scope) => unlocked[scope]).length;
    const status = doneCount === 0 ? (definition.hidden ? "HIDDEN_LOCKED" : "LOCKED") : (doneCount === supportedScopes.length ? "COMPLETE" : "PARTIAL");
    if (definition.hidden && doneCount === 0) {
      return Object.freeze({
        id: definition.id, tier: definition.tier, hidden: true, title: "未铭刻的征途",
        description: "一段尚未解读的神秘记录。", artwork: definition.artwork,
        teamScope: definition.teamScope, order: definition.order, status,
        progress: Object.freeze({ ...progress[definition.id] }), unlocked: Object.freeze(unlocked)
      });
    }
    return Object.freeze({
      id: definition.id, tier: definition.tier, hidden: definition.hidden,
      title: definition.title, description: definition.description, criteria: definition.criteria,
      artwork: definition.artwork, teamScope: definition.teamScope, order: definition.order,
      status, progress: Object.freeze({ ...progress[definition.id] }), unlocked: Object.freeze(unlocked),
      unlockedAt: Object.freeze({ duo: record.duo?.unlockedAt ?? null, trio: record.trio?.unlockedAt ?? null })
    });
  }));
}
