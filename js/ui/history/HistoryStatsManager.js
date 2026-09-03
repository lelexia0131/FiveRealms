/*
模块职责
唯一拥有长期历史档案的初始化、MatchResult 转换、累计统计与查询投影。

上游
main 的对局结束回调与 HistoryArchiveView。

下游
同源历史文件接口与角色领域定义。

状态边界
只读最终 MatchResult；只写独立 history_data.json 对应的历史快照。

信息边界
只保存真人玩家已经公开的终局身份、队友、胜负、评分、回合、MVP 与 Match Performance 最终事实。

架构约束
不得读取 GameState、MatchPerformanceTracker 或 AI；View 不得绕过本模块访问文件接口。
*/
import { CHARACTER_DEFINITIONS } from "../../domain/definitions/characters/CharacterDefinitions.js";
import {
  buildAchievementViewModels,
  createEmptyAchievementData,
  normalizeAchievementData,
  recordAchievementUnlock
} from "./achievements/AchievementStore.js";
import { evaluateMatchAchievements } from "./achievements/AchievementTracker.js";

const HISTORY_VERSION = 1;
const HISTORY_ENDPOINT = "/api/history";
const RECENT_RECORD_LIMIT = 10;
const TEAM_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "dawn", name: "晨星" }),
  Object.freeze({ id: "dusk", name: "暮影" })
]);

/*
功能
创建符合当前版本的空白历史文件数据。

调用方
HistoryStatsManager 初始化与历史测试。

输入
无。

输出
可写的 version 1 历史数据对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只包含持久化 schema 字段；派生的总胜率与传奇纪录不写入文件。
*/
export function createEmptyHistoryData() {
  return {
    version: HISTORY_VERSION,
    summary: {
      totalMatches: 0,
      wins: 0,
      losses: 0,
      mvpCount: 0,
      highestScore: 0,
      highestRounds: 0,
      totalScore: 0,
      totalRounds: 0,
      currentWinStreak: 0,
      maxWinStreak: 0
    },
    characters: {},
    teams: {},
    achievements: {
      ...createEmptyAchievementData(),
      companions: {},
      highestSingleMatchDamage: null,
      highestSingleMatchKills: null,
      highestSingleMatchSupport: null,
      highestSingleMatchDamageTaken: null
    },
    records: []
  };
}

/*
功能
把任意数值输入收束为历史统计可接受的非负有限数。

调用方
normalizeHistoryData 与 recordMatchResult。

输入
待规范化值与是否保留小数。

输出
非负有限整数或数值。

读取状态
无。

写入状态
无。

调用函数
Number、Math.max、Math.round。

边界与不变量
非法值归零；计数不得为负，评分可保留计算器给出的有限小数。
*/
function nonNegativeNumber(value, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return integer ? Math.max(0, Math.round(number)) : Math.max(0, number);
}

/*
功能
规范化只在新终局记录中存在的非负事实，并保留旧档案的未知语义。

调用方
normalizeHistoryData 与 recordMatchResult。

输入
可能缺失的数值与是否要求整数。

输出
已知时返回非负有限数，缺失或非法时返回 null。

读取状态
无。

写入状态
无。

调用函数
Number、Number.isFinite、Math.max、Math.round。

边界与不变量
旧记录缺字段不能归零；真实终局中的零仍必须保留为有效纪录。
*/
function optionalNonNegativeNumber(value, integer = false) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return integer ? Math.max(0, Math.round(number)) : Math.max(0, number);
}

/*
功能
根据胜场与使用次数生成持久化和查询共用的百分比。

调用方
normalizeHistoryData、recordMatchResult 与 buildArchiveData。

输入
非负胜场数与对局数。

输出
保留一位小数的 0 到 100 百分比。

读取状态
无。

写入状态
无。

调用函数
Math.round。

边界与不变量
零场记录胜率固定为零；View 不得再次计算。
*/
function calculateWinRate(wins, matches) {
  if (!matches) return 0;
  return Math.round((wins / matches) * 1000) / 10;
}

/*
功能
把磁盘内容迁移为当前 version 1 的完整安全快照。

调用方
HistoryStatsManager.loadData。

输入
从存储读取并解析的未知对象。

输出
可继续累计的 version 1 历史数据。

读取状态
当前 schema 常量。

写入状态
无。

调用函数
createEmptyHistoryData、nonNegativeNumber、calculateWinRate。

边界与不变量
高于当前版本的数据拒绝读取；缺失字段补默认值，未知角色键原样保留以免丢档。
*/
function normalizeHistoryData(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return createEmptyHistoryData();
  const version = nonNegativeNumber(source.version, true) || HISTORY_VERSION;
  if (version > HISTORY_VERSION) throw new Error(`历史档案版本 ${version} 高于当前支持版本 ${HISTORY_VERSION}`);
  const empty = createEmptyHistoryData();
  const summarySource = source.summary && typeof source.summary === "object" ? source.summary : {};
  for (const key of Object.keys(empty.summary)) {
    empty.summary[key] = nonNegativeNumber(summarySource[key], key !== "highestScore" && key !== "totalScore");
  }
  empty.summary.currentWinStreak = Math.min(empty.summary.currentWinStreak, empty.summary.maxWinStreak);
  for (const [characterId, value] of Object.entries(source.characters ?? {})) {
    if (!value || typeof value !== "object") continue;
    const matches = nonNegativeNumber(value.matches, true);
    const wins = Math.min(matches, nonNegativeNumber(value.wins, true));
    empty.characters[characterId] = {
      matches,
      wins,
      winRate: calculateWinRate(wins, matches),
      mvpCount: nonNegativeNumber(value.mvpCount, true),
      highestScore: nonNegativeNumber(value.highestScore),
      totalScore: nonNegativeNumber(value.totalScore)
    };
  }
  for (const [teamId, value] of Object.entries(source.teams ?? {})) {
    if (!value || typeof value !== "object") continue;
    const matches = nonNegativeNumber(value.matches, true);
    const wins = Math.min(matches, nonNegativeNumber(value.wins, true));
    empty.teams[teamId] = { matches, wins, winRate: calculateWinRate(wins, matches) };
  }
  const normalizedRecords = Array.isArray(source.records)
    ? source.records.filter((record) => record && typeof record === "object").map((record) => ({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
      characterId: typeof record.characterId === "string" ? record.characterId : "",
      characterName: typeof record.characterName === "string" ? record.characterName : "未知旅者",
      teamId: record.teamId === "dusk" ? "dusk" : "dawn",
      teammateCharacterIds: Array.isArray(record.teammateCharacterIds)
        ? record.teammateCharacterIds.filter((characterId) => typeof characterId === "string" && characterId)
        : null,
      won: Boolean(record.won),
      score: nonNegativeNumber(record.score),
      rounds: nonNegativeNumber(record.rounds, true),
      isMvp: Boolean(record.isMvp),
      damage: optionalNonNegativeNumber(record.damage),
      kills: optionalNonNegativeNumber(record.kills, true),
      support: optionalNonNegativeNumber(record.support),
      damageTaken: optionalNonNegativeNumber(record.damageTaken)
    }))
    : [];
  const achievementSource = source.achievements && typeof source.achievements === "object"
    ? source.achievements
    : {};
  const normalizedAchievements = normalizeAchievementData(achievementSource);
  empty.achievements.schemaVersion = normalizedAchievements.schemaVersion;
  empty.achievements.records = normalizedAchievements.records;
  empty.achievements.streaks = normalizedAchievements.streaks;
  const companionSource = achievementSource.companions && typeof achievementSource.companions === "object"
    ? achievementSource.companions
    : null;
  if (companionSource) {
    for (const [characterId, value] of Object.entries(companionSource)) {
      if (typeof characterId !== "string" || !characterId) continue;
      const matches = nonNegativeNumber(value?.matches ?? value, true);
      if (matches) empty.achievements.companions[characterId] = { matches };
    }
  } else {
    for (const record of normalizedRecords) {
      if (!Array.isArray(record.teammateCharacterIds)) continue;
      for (const characterId of new Set(record.teammateCharacterIds)) {
        const companion = empty.achievements.companions[characterId] ?? { matches: 0 };
        companion.matches += 1;
        empty.achievements.companions[characterId] = companion;
      }
    }
  }
  for (const [achievementKey, recordKey] of [
    ["highestSingleMatchDamage", "damage"],
    ["highestSingleMatchKills", "kills"],
    ["highestSingleMatchSupport", "support"],
    ["highestSingleMatchDamageTaken", "damageTaken"]
  ]) {
    const storedValue = optionalNonNegativeNumber(achievementSource[achievementKey], recordKey === "kills");
    empty.achievements[achievementKey] = storedValue ?? highestKnownRecordValue(normalizedRecords, recordKey);
  }
  empty.records = normalizedRecords.slice(0, RECENT_RECORD_LIMIT);
  return empty;
}

/*
功能
创建浏览器环境下固定端点的历史文件读写适配器。

调用方
HistoryStatsManager constructor 默认路径。

输入
fetch 实现与同源历史端点。

输出
具有 read/write 方法的存储适配器。

读取状态
同源 /api/history 响应。

写入状态
通过 PUT 覆盖根目录 history_data.json。

调用函数
fetch、Response.json。

边界与不变量
404 表示尚无档案并交给 Manager 初始化；其他非成功响应必须抛错。
*/
function createHttpHistoryStorage(fetchImpl, endpoint) {
  return {
    /*
    功能
    从固定同源端点读取历史 JSON。

    调用方
    HistoryStatsManager.loadData。

    输入
    无。

    输出
    解析后的对象、缺档时的 null 或失败异常。

    读取状态
    同源历史端点。

    写入状态
    无。

    调用函数
    fetch、Response.json。

    边界与不变量
    只有 HTTP 404 代表未初始化；其他失败不得伪装成空档。
    */
    async read() {
      const response = await fetchImpl(endpoint, { method: "GET", cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`读取历史档案失败：HTTP ${response.status}`);
      return response.json();
    },
    /*
    功能
    仅在历史文件仍不存在时创建初始空档。

    调用方
    HistoryStatsManager.loadData。

    输入
    完整 version 1 JSON 字符串。

    输出
    创建成功返回 true；并发期间文件已出现返回 false；其他失败抛错。

    读取状态
    同源服务中的 history_data.json 是否存在。

    写入状态
    仅在缺档时创建根目录 history_data.json。

    调用函数
    fetch。

    边界与不变量
    If-None-Match 条件必须由 server 在写锁内判断，绝不以空档覆盖已存在档案。
    */
    async create(json) {
      const response = await fetchImpl(endpoint, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "If-None-Match": "*"
        },
        body: json
      });
      if (response.status === 412) return false;
      if (!response.ok) throw new Error(`创建历史档案失败：HTTP ${response.status}`);
      return true;
    },
    /*
    功能
    把 Manager 生成的完整 JSON 保存到固定同源端点。

    调用方
    HistoryStatsManager.loadData 与 recordMatchResult。

    输入
    完整 version 1 JSON 字符串。

    输出
    保存成功时完成的 Promise，失败时抛错。

    读取状态
    无。

    写入状态
    同源服务映射的根目录 history_data.json。

    调用函数
    fetch。

    边界与不变量
    只使用固定 endpoint，不接受调用方提供文件路径。
    */
    async write(json) {
      const response = await fetchImpl(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: json
      });
      if (!response.ok) throw new Error(`保存历史档案失败：HTTP ${response.status}`);
    }
  };
}

/*
功能
从持久化同行累计中选出与真人同阵营场次最多的角色。

调用方
buildArchiveData。

输入
已规范化的 companions 累计对象。

输出
含 characterId、characterName 与 matches 的同行纪录；没有已知队友事实时返回 null。

读取状态
角色定义顺序与名称。

写入状态
无。

调用函数
Object.entries、Array.sort、CHARACTER_DEFINITIONS.find/findIndex。

边界与不变量
计数由 recordMatchResult 保证同一场同一角色至多累计一次；并列按角色定义顺序、再按 ID 排序，刷新后结果稳定。
*/
function findMostFrequentCompanion(companions) {
  const [winner] = Object.entries(companions).map(([characterId, value]) => (
    [characterId, nonNegativeNumber(value?.matches, true)]
  )).filter(([, matches]) => matches > 0).sort(([leftId, leftMatches], [rightId, rightMatches]) => {
    if (rightMatches !== leftMatches) return rightMatches - leftMatches;
    const leftIndex = CHARACTER_DEFINITIONS.findIndex((definition) => definition.id === leftId);
    const rightIndex = CHARACTER_DEFINITIONS.findIndex((definition) => definition.id === rightId);
    const stableLeftIndex = leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const stableRightIndex = rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return stableLeftIndex - stableRightIndex || leftId.localeCompare(rightId);
  });
  if (!winner) return null;
  const [characterId, matches] = winner;
  const definition = CHARACTER_DEFINITIONS.find((entry) => entry.id === characterId);
  return {
    characterId,
    characterName: definition?.name ?? "未知旅者",
    matches
  };
}

/*
功能
读取一个新增单局事实在全部已知历史中的最高值。

调用方
buildArchiveData。

输入
已规范化 records 与 damage/kills/support/damageTaken 字段名。

输出
至少一场记录具有该事实时返回最高非负数，否则返回 null。

读取状态
历史记录字段。

写入状态
无。

调用函数
Array.map/filter、Math.max。

边界与不变量
旧记录的 null 不参与比较；真实零值必须作为已知纪录返回。
*/
function highestKnownRecordValue(records, key) {
  const values = records.map((record) => record[key]).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

/*
功能
把持久化快照投影成 View 可直接展示且无需计算的数据。

调用方
HistoryStatsManager.getArchiveData。

输入
规范化历史数据。

输出
含总体胜率、全部角色/阵营与五项传奇纪录的冻结查询对象。

读取状态
角色定义、阵营定义与历史累计。

写入状态
无。

调用函数
calculateWinRate。

边界与不变量
所有当前角色和两个阵营即使零场也必须出现；传奇纪录只使用 records 中已知的最终事实。
*/
function buildArchiveData(data) {
  const characters = CHARACTER_DEFINITIONS.map((definition, definitionIndex) => {
    const stats = data.characters[definition.id] ?? {};
    return {
      id: definition.id,
      name: definition.name,
      loreFaction: definition.loreFaction,
      definitionIndex,
      matches: nonNegativeNumber(stats.matches, true),
      wins: nonNegativeNumber(stats.wins, true),
      winRate: nonNegativeNumber(stats.winRate),
      mvpCount: nonNegativeNumber(stats.mvpCount, true),
      highestScore: nonNegativeNumber(stats.highestScore),
      totalScore: nonNegativeNumber(stats.totalScore)
    };
  });
  const teams = TEAM_DEFINITIONS.map((definition) => ({
    ...definition,
    matches: nonNegativeNumber(data.teams[definition.id]?.matches, true),
    wins: nonNegativeNumber(data.teams[definition.id]?.wins, true),
    winRate: nonNegativeNumber(data.teams[definition.id]?.winRate)
  }));
  const mostFrequentCompanion = findMostFrequentCompanion(data.achievements.companions);
  return Object.freeze({
    version: data.version,
    summary: Object.freeze({
      ...data.summary,
      winRate: calculateWinRate(data.summary.wins, data.summary.totalMatches)
    }),
    characters: Object.freeze(characters.map((entry) => Object.freeze(entry))),
    teams: Object.freeze(teams.map((entry) => Object.freeze(entry))),
    achievements: Object.freeze({
      cards: buildAchievementViewModels({ records: data.achievements.records }),
      streaks: Object.freeze({
        duo: Object.freeze({ ...data.achievements.streaks.duo }),
        trio: Object.freeze({ ...data.achievements.streaks.trio })
      }),
      mostFrequentCompanion: mostFrequentCompanion ? Object.freeze(mostFrequentCompanion) : null,
      highestSingleMatchDamage: data.achievements.highestSingleMatchDamage,
      highestSingleMatchKills: data.achievements.highestSingleMatchKills,
      highestSingleMatchSupport: data.achievements.highestSingleMatchSupport,
      highestSingleMatchDamageTaken: data.achievements.highestSingleMatchDamageTaken
    }),
    records: Object.freeze(data.records.map((record) => Object.freeze({
      ...record,
      teammateCharacterIds: Array.isArray(record.teammateCharacterIds)
        ? Object.freeze([...record.teammateCharacterIds])
        : null
    })))
  });
}

export class HistoryStatsManager {
  /*
  功能
  创建长期历史档案的数据边界。

  调用方
  main bootstrap 与历史统计测试。

  输入
  可选 storage、fetch、endpoint 与 now 注入。

  输出
  HistoryStatsManager 实例。

  读取状态
  无。

  写入状态
  初始化存储适配器、时钟与内存快照。

  调用函数
  createHttpHistoryStorage。

  边界与不变量
  默认适配器只能访问固定同源端点；测试可注入等价文件存储而不改变累计逻辑。
  */
  constructor({ storage = null, fetchImpl = globalThis.fetch, endpoint = HISTORY_ENDPOINT, now = () => new Date() } = {}) {
    if (!storage && typeof fetchImpl !== "function") throw new TypeError("HistoryStatsManager 需要 fetch 或 storage");
    this.storage = storage ?? createHttpHistoryStorage(fetchImpl.bind(globalThis), endpoint);
    this.now = now;
    this.data = null;
    this.initializationPromise = null;
  }

  /*
  功能
  读取已有档案，或在文件不存在时写入空白档案。

  调用方
  main bootstrap、getArchiveData 与 recordMatchResult。

  输入
  无。

  输出
  初始化完成后可直接展示的历史查询对象。

  读取状态
  storage 与当前初始化状态。

  写入状态
  this.data；缺失文件时写入 version 1 空档。

  调用函数
  storage.read/create/write、normalizeHistoryData、createEmptyHistoryData、buildArchiveData。

  边界与不变量
  并发初始化共享同一 Promise；读取失败不伪造已初始化状态，后续可重试。
  */
  async initialize() {
    if (this.data) return buildArchiveData(this.data);
    if (!this.initializationPromise) {
      this.initializationPromise = this.loadData().finally(() => { this.initializationPromise = null; });
    }
    await this.initializationPromise;
    return buildArchiveData(this.data);
  }

  /*
  功能
  执行一次实际读取，并在缺档时完成初始保存。

  调用方
  initialize。

  输入
  无。

  输出
  无返回值；异步完成表示内存与文件均已就绪。

  读取状态
  storage。

  写入状态
  this.data 与可能的新 history_data.json。

  调用函数
  storage.read/create/write、normalizeHistoryData、createEmptyHistoryData、JSON.stringify。

  边界与不变量
  只有确认为不存在且条件创建成功时才提交空档；并发出现的已有文件必须重新读取，任何写入失败不得伪装为内存成功。
  */
  async loadData() {
    const stored = await this.storage.read();
    if (stored === null || stored === undefined) {
      const empty = createEmptyHistoryData();
      const json = `${JSON.stringify(empty, null, 2)}\n`;
      let created = true;
      if (typeof this.storage.create === "function") created = await this.storage.create(json);
      else await this.storage.write(json);
      if (created) {
        this.data = empty;
        return;
      }
      const concurrent = await this.storage.read();
      if (concurrent === null || concurrent === undefined) {
        throw new Error("历史档案条件创建冲突后仍无法读取文件");
      }
      const concurrentParsed = typeof concurrent === "string" ? JSON.parse(concurrent) : concurrent;
      this.data = normalizeHistoryData(concurrentParsed);
      return;
    }
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    this.data = normalizeHistoryData(parsed);
  }

  /*
  功能
  返回 View 可直接渲染的当前历史档案。

  调用方
  HistoryArchiveView 与历史测试。

  输入
  无。

  输出
  冻结的历史查询对象 Promise。

  读取状态
  this.data 与 storage 初始化状态。

  写入状态
  每次调用都以磁盘读取结果刷新 this.data。

  调用函数
  loadData、buildArchiveData。

  边界与不变量
  不依赖旧 JS 内存作为查询 authority；不暴露可变持久化对象，胜率和传奇纪录在数据层完成。
  */
  async getArchiveData() {
    if (this.initializationPromise) await this.initializationPromise;
    await this.loadData();
    return buildArchiveData(this.data);
  }

  /*
  功能
  从最终 MatchResult 取出真人一行并恰好累计一场长期历史。

  调用方
  main 的 MVP 结算完成回调与历史测试。

  输入
  已完成评分/MVP 排名的 MatchResult 与真人 playerId。

  输出
  保存完成后的冻结历史查询对象。

  读取状态
  当前历史快照、最终 MatchResult 与注入时钟。

  写入状态
  summary、真人角色、真人阵营、同行/传奇累计、最近 records、history_data.json 与成功后的内存档案。

  调用函数
  initialize、normalizeHistoryData、calculateWinRate、optionalNonNegativeNumber、storage.write、buildArchiveData。

  边界与不变量
  只接受存在于最终结果中的真人；不重算评分、胜负、MVP、队友身份或战斗统计；文件写入成功前不得让查询看到未持久化记录。
  */
  async recordMatchResult(matchResult, humanPlayerId) {
    if (!this.data) await this.initialize();
    const player = matchResult?.players?.find((entry) => entry.playerId === humanPlayerId);
    if (!player) throw new TypeError("MatchResult 中缺少真人玩家终局结果");
    if (!player.characterId || !player.characterName || !["dawn", "dusk"].includes(player.teamId)) {
      throw new TypeError("MatchResult 真人行缺少角色或阵营终局字段");
    }
    const next = normalizeHistoryData(this.data);
    const score = nonNegativeNumber(player.finalScore);
    const rounds = nonNegativeNumber(player.effectiveRounds, true);
    const teammateCharacterIds = Array.isArray(player.teammateCharacterIds)
      ? player.teammateCharacterIds.filter((characterId) => typeof characterId === "string" && characterId)
      : [];
    const unlockedAt = this.now().toISOString();
    const achievementResult = evaluateMatchAchievements(matchResult, humanPlayerId, next.achievements.streaks);
    for (const achievementId of achievementResult.unlocked) {
      recordAchievementUnlock(next.achievements.records, achievementId, achievementResult.scope, unlockedAt);
    }
    next.summary.totalMatches += 1;
    next.summary.wins += player.won ? 1 : 0;
    next.summary.losses += player.won ? 0 : 1;
    next.summary.mvpCount += player.isMvp ? 1 : 0;
    next.summary.highestScore = Math.max(next.summary.highestScore, score);
    next.summary.highestRounds = Math.max(next.summary.highestRounds, rounds);
    next.summary.totalScore += score;
    next.summary.totalRounds += rounds;
    if (player.won) {
      next.summary.currentWinStreak += 1;
      next.summary.maxWinStreak = Math.max(next.summary.maxWinStreak, next.summary.currentWinStreak);
    } else {
      next.summary.currentWinStreak = 0;
    }

    const character = next.characters[player.characterId] ?? {
      matches: 0, wins: 0, winRate: 0, mvpCount: 0, highestScore: 0, totalScore: 0
    };
    character.matches += 1;
    character.wins += player.won ? 1 : 0;
    character.winRate = calculateWinRate(character.wins, character.matches);
    character.mvpCount += player.isMvp ? 1 : 0;
    character.highestScore = Math.max(character.highestScore, score);
    character.totalScore += score;
    next.characters[player.characterId] = character;

    const team = next.teams[player.teamId] ?? { matches: 0, wins: 0, winRate: 0 };
    team.matches += 1;
    team.wins += player.won ? 1 : 0;
    team.winRate = calculateWinRate(team.wins, team.matches);
    next.teams[player.teamId] = team;

    for (const characterId of new Set(teammateCharacterIds)) {
      const companion = next.achievements.companions[characterId] ?? { matches: 0 };
      companion.matches += 1;
      next.achievements.companions[characterId] = companion;
    }
    const singleMatchAchievements = {
      highestSingleMatchDamage: optionalNonNegativeNumber(player.combatStats?.totalDamage),
      highestSingleMatchKills: optionalNonNegativeNumber(player.totals?.enemyKills, true),
      highestSingleMatchSupport: optionalNonNegativeNumber(player.combatStats?.support),
      highestSingleMatchDamageTaken: optionalNonNegativeNumber(player.combatStats?.damageTaken)
    };
    for (const [key, value] of Object.entries(singleMatchAchievements)) {
      if (value !== null) next.achievements[key] = Math.max(next.achievements[key] ?? 0, value);
    }

    next.records.unshift({
      timestamp: unlockedAt,
      characterId: player.characterId,
      characterName: player.characterName,
      teamId: player.teamId,
      teammateCharacterIds,
      won: Boolean(player.won),
      score,
      rounds,
      isMvp: Boolean(player.isMvp),
      damage: optionalNonNegativeNumber(player.combatStats?.totalDamage),
      kills: optionalNonNegativeNumber(player.totals?.enemyKills, true),
      support: optionalNonNegativeNumber(player.combatStats?.support),
      damageTaken: optionalNonNegativeNumber(player.combatStats?.damageTaken)
    });
    next.records.length = Math.min(next.records.length, RECENT_RECORD_LIMIT);
    await this.storage.write(`${JSON.stringify(next, null, 2)}\n`);
    this.data = next;
    return buildArchiveData(this.data);
  }
}
