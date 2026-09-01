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
只保存真人玩家已经公开的终局身份、阵营、胜负、评分、回合与 MVP 事实。

架构约束
不得读取 GameState、MatchPerformanceTracker 或 AI；View 不得绕过本模块访问文件接口。
*/
import { CHARACTER_DEFINITIONS } from "../../domain/definitions/characters/CharacterDefinitions.js";

const HISTORY_VERSION = 1;
const HISTORY_ENDPOINT = "/api/history";
const MAX_RECENT_RECORDS = 50;
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
      totalRounds: 0
    },
    characters: {},
    teams: {},
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
  empty.records = Array.isArray(source.records)
    ? source.records.slice(0, MAX_RECENT_RECORDS).filter((record) => record && typeof record === "object").map((record) => ({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
      characterId: typeof record.characterId === "string" ? record.characterId : "",
      characterName: typeof record.characterName === "string" ? record.characterName : "未知旅者",
      teamId: record.teamId === "dusk" ? "dusk" : "dawn",
      won: Boolean(record.won),
      score: nonNegativeNumber(record.score),
      rounds: nonNegativeNumber(record.rounds, true),
      isMvp: Boolean(record.isMvp)
    }))
    : [];
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
把持久化快照投影成 View 可直接展示且无需计算的数据。

调用方
HistoryStatsManager.getArchiveData。

输入
规范化历史数据。

输出
含总体胜率、全部角色/阵营与传奇纪录的冻结查询对象。

读取状态
角色定义、阵营定义与历史累计。

写入状态
无。

调用函数
calculateWinRate。

边界与不变量
所有当前角色和两个阵营即使零场也必须出现；最佳胜率只在有使用记录的角色中产生。
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
  const usedCharacters = characters.filter((character) => character.matches > 0);
  const usageOrder = [...usedCharacters].sort((left, right) => right.matches - left.matches
    || right.wins - left.wins || left.definitionIndex - right.definitionIndex);
  const winRateOrder = [...usedCharacters].sort((left, right) => right.winRate - left.winRate
    || right.matches - left.matches || right.wins - left.wins || left.definitionIndex - right.definitionIndex);
  const teams = TEAM_DEFINITIONS.map((definition) => ({
    ...definition,
    matches: nonNegativeNumber(data.teams[definition.id]?.matches, true),
    wins: nonNegativeNumber(data.teams[definition.id]?.wins, true),
    winRate: nonNegativeNumber(data.teams[definition.id]?.winRate)
  }));
  return Object.freeze({
    version: data.version,
    summary: Object.freeze({
      ...data.summary,
      winRate: calculateWinRate(data.summary.wins, data.summary.totalMatches)
    }),
    characters: Object.freeze(characters.map((entry) => Object.freeze(entry))),
    teams: Object.freeze(teams.map((entry) => Object.freeze(entry))),
    achievements: Object.freeze({
      highestScore: data.summary.highestScore,
      highestRounds: data.summary.highestRounds,
      mvpCount: data.summary.mvpCount,
      mostUsedCharacter: usageOrder[0]?.name ?? "尚待落笔",
      bestWinRateCharacter: winRateOrder[0]?.name ?? "尚待落笔"
    }),
    records: Object.freeze(data.records.map((record) => Object.freeze({ ...record })))
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
  storage.read/write、normalizeHistoryData、createEmptyHistoryData、buildArchiveData。

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
  storage.read/write、normalizeHistoryData、createEmptyHistoryData、JSON.stringify。

  边界与不变量
  只有确认为不存在时才创建空档；初始保存失败仍提供空白内存档案，损坏或未来版本档案不得被静默覆盖。
  */
  async loadData() {
    const stored = await this.storage.read();
    if (stored === null || stored === undefined) {
      const empty = createEmptyHistoryData();
      this.data = empty;
      try {
        await this.storage.write(`${JSON.stringify(empty, null, 2)}\n`);
      } catch {
        // 旧版静态服务没有 PUT 能力时仍允许浏览空卷册；进程重启后后续终局写入会再次尝试保存。
      }
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
  首次调用可能初始化档案。

  调用函数
  initialize、buildArchiveData。

  边界与不变量
  不暴露可变持久化对象；胜率和传奇纪录在数据层完成。
  */
  async getArchiveData() {
    if (!this.data) await this.initialize();
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
  summary、真人角色、真人阵营、最近记录、内存档案与 history_data.json。

  调用函数
  initialize、normalizeHistoryData、calculateWinRate、storage.write、buildArchiveData。

  边界与不变量
  只接受存在于最终结果中的真人；不重算评分、胜负或 MVP；文件失败仍保留本次会话内存档案并向调用方报告。
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
    next.summary.totalMatches += 1;
    next.summary.wins += player.won ? 1 : 0;
    next.summary.losses += player.won ? 0 : 1;
    next.summary.mvpCount += player.isMvp ? 1 : 0;
    next.summary.highestScore = Math.max(next.summary.highestScore, score);
    next.summary.highestRounds = Math.max(next.summary.highestRounds, rounds);
    next.summary.totalScore += score;
    next.summary.totalRounds += rounds;

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

    next.records.unshift({
      timestamp: this.now().toISOString(),
      characterId: player.characterId,
      characterName: player.characterName,
      teamId: player.teamId,
      won: Boolean(player.won),
      score,
      rounds,
      isMvp: Boolean(player.isMvp)
    });
    next.records = next.records.slice(0, MAX_RECENT_RECORDS);
    this.data = next;
    await this.storage.write(`${JSON.stringify(next, null, 2)}\n`);
    return buildArchiveData(this.data);
  }
}
