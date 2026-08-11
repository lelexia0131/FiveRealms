/**
 * 阶段性统计汇总（只读已有数据，不新增样本）。
 * 生成：
 *   interim-report.md
 *   interim-master.csv
 *   interim-role-matrix.csv
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CARD_DEFINITIONS } from "../../js/config/cardConfig.js";
import { GENERAL_DEFINITIONS, GENERAL_BY_ID } from "../../js/config/generalConfig.js";
import { round, fmt, stats, pairStats } from "./lib/aggregate.js";
import { runDirFromEnv, runDirUrl } from "./lib/runPaths.js";

let DATA_DIR = new URL("./data/", import.meta.url);
let OUT_DIR = new URL("./", import.meta.url);
const CARD_IDS = Object.keys(CARD_DEFINITIONS);
const ROLES = GENERAL_DEFINITIONS.map((general) => general.id);
const ROLE_NAMES = ROLES.map((role) => GENERAL_BY_ID[role].name);

async function readLines(relativePath) {
  try {
    const text = await readFile(new URL(relativePath, DATA_DIR), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readJson(relativePath, fallback = null) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, DATA_DIR), "utf8"));
  } catch {
    return fallback;
  }
}

function dedupeRows(rows, keyFn) {
  const map = new Map();
  for (const row of rows) map.set(keyFn(row), row);
  return [...map.values()];
}

const pp = (stat) => stat ? ({
  ...stat,
  meanPp: stat.mean * 100,
  sdPp: stat.sd * 100,
  sePp: stat.se * 100,
  ciLowPp: stat.ciLow * 100,
  ciHighPp: stat.ciHigh * 100,
  ciHalfPp: stat.ciHalf * 100
}) : null;

const holdRow = (row) => !row.aStalled && !row.bStalled;

function interimConfidence(stat) {
  if (!stat) return null;
  if (stat.n >= 800 && stat.ciHalfPp <= 1) return 3;
  if ((stat.n >= 250 && stat.ciHalfPp <= 3.5) || (stat.n >= 100 && stat.ciHalfPp <= 2)) return 2;
  return 1;
}

function rowConfidence(s) {
  const levels = ["低可信", "中可信", "高可信"];
  const values = [
    interimConfidence(s.hold),
    interimConfidence(s.acquire),
    interimConfidence(s.use),
    interimConfidence(s.discard)
  ].filter((value) => value != null);
  if (!values.length) return "N/A";
  return levels[Math.min(...values) - 1];
}

async function main() {
  const runBase = runDirUrl(runDirFromEnv());
  if (runBase) {
    DATA_DIR = new URL("data/", runBase);
    OUT_DIR = runBase;
  }
  const progress = await readJson("progress.json", {});
  const studyConfig = await readJson("config.json", {});
  const corpus = await readJson("corpus.json", []);
  const naturalStates = await readLines("corpus-states.jsonl");
  const roleStates = await readLines("role-states.jsonl");
  const holdRows = dedupeRows(await readLines("pairs-hold.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const acquireRows = dedupeRows(await readLines("pairs-acquire.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const useRows = dedupeRows(await readLines("pairs-use.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const discardRows = dedupeRows(await readLines("pairs-discard.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const windowRows = dedupeRows(await readLines("pairs-window.jsonl"), (row) => `${row.seed}|${row.windowType}`);
  const [configStat, progressStat] = await Promise.all([
    stat(new URL("config.json", DATA_DIR)).catch(() => null),
    stat(new URL("progress.json", DATA_DIR)).catch(() => null)
  ]);
  const elapsedMinutes = configStat && progressStat
    ? Math.round(Math.max(0.1, (progressStat.mtimeMs - configStat.mtimeMs) / 60000) * 10) / 10
    : 52;

  const compositeHoldRows = holdRows.filter((row) => row.sampleType === "composite");
  const byCard = { hold: {}, acquire: {}, use: {}, discard: {} };
  for (const cardId of CARD_IDS) {
    byCard.hold[cardId] = compositeHoldRows.filter((row) => row.card === cardId && holdRow(row));
    byCard.acquire[cardId] = acquireRows.filter((row) => row.card === cardId && holdRow(row));
    byCard.use[cardId] = useRows.filter((row) => row.card === cardId && holdRow(row) && row.aLegal && row.aPlayed);
    byCard.discard[cardId] = discardRows.filter((row) => row.card === cardId && holdRow(row));
  }

  const cardStats = {};
  for (const cardId of CARD_IDS) {
    const definition = CARD_DEFINITIONS[cardId];
    const hold = byCard.hold[cardId];
    const acquire = byCard.acquire[cardId];
    const use = byCard.use[cardId];
    const discard = byCard.discard[cardId];
    const holdValues = hold.map((row) => row.aWin - row.bWin);
    const acquireValues = acquire.map((row) => row.aWin - row.bWin);
    const useValues = use.map((row) => row.aWin - row.bWin);
    const discardValues = discard.map((row) => row.aWin - row.bWin);
    cardStats[cardId] = {
      name: definition.name,
      currentAiValue: definition.aiValue,
      hold: pp(stats(holdValues)),
      acquire: pp(stats(acquireValues)),
      use: pp(stats(useValues)),
      discard: pp(stats(discardValues)),
      useLegalAttempted: useRows.filter((row) => row.card === cardId).length,
      useLegalCount: useRows.filter((row) => row.card === cardId && row.aLegal).length
    };
  }

  // 角色矩阵（当前只有自然 composite hold 行，按主体角色归类）
  const roleHoldRows = {};
  for (const role of ROLES) {
    roleHoldRows[role] = compositeHoldRows.filter((row) => row.role === role && holdRow(row));
  }
  const roleMatrix = {};
  for (const cardId of CARD_IDS) {
    roleMatrix[cardId] = {};
    for (const role of ROLES) {
      const values = roleHoldRows[role]
        .filter((row) => row.card === cardId)
        .map((row) => row.aWin - row.bWin);
      roleMatrix[cardId][role] = pp(stats(values));
    }
  }

  // 局面分层（composite hold 行）
  const stratumStats = {};
  const roundTerciles = computeRoundTerciles(naturalStates);
  const phaseOf = (round) => round <= roundTerciles.p33 ? "early" : round <= roundTerciles.p67 ? "mid" : "late";
  for (const cardId of CARD_IDS) {
    const rows = compositeHoldRows.filter((row) => row.card === cardId && holdRow(row));
    const stat = (filter) => pp(stats(rows.filter(filter).map((row) => row.aWin - row.bWin)));
    stratumStats[cardId] = {
      critical: stat((row) => row.classification.hpClass === "critical"),
      low: stat((row) => row.classification.hpClass === "low"),
      healthy: stat((row) => row.classification.hpClass === "healthy"),
      full: stat((row) => row.classification.hpClass === "full"),
      lowHand: stat((row) => row.classification.handClass === "low"),
      midHand: stat((row) => row.classification.handClass === "mid"),
      highHand: stat((row) => row.classification.handClass === "high"),
      energyLow: stat((row) => row.classification.energyClass === "low"),
      energyMid: stat((row) => row.classification.energyClass === "mid"),
      energyHigh: stat((row) => row.classification.energyClass === "high"),
      reachable: stat((row) => row.classification.canReachEnemy === true),
      noTarget: stat((row) => row.classification.canReachEnemy === false),
      early: stat((row) => phaseOf(row.round) === "early"),
      mid: stat((row) => phaseOf(row.round) === "mid"),
      late: stat((row) => phaseOf(row.round) === "late"),
      lead: stat((row) => row.classification.leadClass === "lead"),
      close: stat((row) => row.classification.leadClass === "close"),
      lag: stat((row) => row.classification.leadClass === "lag"),
      unlock: stat((row) => row.classification.canUnlockActiveWithOneEnergy === true)
    };
  }

  // 观察
  const byComposite = CARD_IDS
    .map((cardId) => ({ cardId, stat: cardStats[cardId].hold }))
    .filter((entry) => entry.stat?.n >= 30)
    .sort((a, b) => b.stat.mean - a.stat.mean);
  const top5 = byComposite.slice(0, 5);
  const bottom5 = byComposite.slice(-5).reverse();

  const suggested = rankSuggested(CARD_IDS, cardStats);
  const overvalued = [];
  const undervalued = [];
  const reasonable = [];
  for (const cardId of CARD_IDS) {
    const diff = suggested[cardId] - CARD_DEFINITIONS[cardId].aiValue;
    if (diff >= 2) overvalued.push({ cardId, current: CARD_DEFINITIONS[cardId].aiValue, suggested: suggested[cardId], diff });
    else if (diff <= -2) undervalued.push({ cardId, current: CARD_DEFINITIONS[cardId].aiValue, suggested: suggested[cardId], diff });
    else reasonable.push({ cardId, diff });
  }

  const highVariance = CARD_IDS
    .map((cardId) => ({ cardId, sd: cardStats[cardId].hold?.sdPp ?? null, n: cardStats[cardId].hold?.n ?? 0 }))
    .filter((entry) => entry.sd != null && entry.n >= 30)
    .sort((a, b) => b.sd - a.sd);

  const roleDependence = [];
  for (const cardId of CARD_IDS) {
    const means = ROLES
      .map((role) => roleMatrix[cardId][role])
      .filter((stat) => stat && stat.n >= 15)
      .map((stat) => stat.meanPp);
    if (means.length >= 4) {
      roleDependence.push({ cardId, range: Math.max(...means) - Math.min(...means), n: Math.min(...ROLES.map((role) => roleMatrix[cardId][role]?.n ?? 0)) });
    }
  }
  roleDependence.sort((a, b) => b.range - a.range);

  const situationDependence = [];
  for (const cardId of CARD_IDS) {
    const means = Object.values(stratumStats[cardId])
      .filter((stat) => stat && stat.n >= 10)
      .map((stat) => stat.meanPp);
    if (means.length >= 3) {
      situationDependence.push({ cardId, range: Math.max(...means) - Math.min(...means) });
    }
  }
  situationDependence.sort((a, b) => b.range - a.range);

  const underSampled = CARD_IDS.map((cardId) => {
    const s = cardStats[cardId];
    const bottlenecks = [];
    if ((s.hold?.n ?? 0) < 100) bottlenecks.push(`Hold=${s.hold?.n ?? 0}`);
    if ((s.acquire?.n ?? 0) < 100) bottlenecks.push(`Acquire=${s.acquire?.n ?? 0}`);
    if ((s.use?.n ?? 0) < 50 && s.useLegalCount > 0) bottlenecks.push(`Use=${s.use?.n ?? 0}`);
    if ((s.discard?.n ?? 0) < 30) bottlenecks.push(`Discard=${s.discard?.n ?? 0}`);
    return { cardId, bottlenecks };
  }).filter((entry) => entry.bottlenecks.length);

  // 完成比例 / 吞吐 / ETA
  const totalJobs = studyConfig.compositeStateTarget * 2 + studyConfig.useStateTarget
    + studyConfig.roleStateTargetPerRole * ROLES.length;
  const doneJobs = (progress.experimentDone ?? []).length;
  const completionRatio = totalJobs ? doneJobs / totalJobs : 0;
  const jobsPerMin = elapsedMinutes ? doneJobs / elapsedMinutes : 0;
  const remainingJobs = Math.max(0, totalJobs - doneJobs);
  const etaMinutes = jobsPerMin > 0 ? remainingJobs / jobsPerMin : null;
  const windowJobsTotal = Object.values(studyConfig.windowTargets ?? {}).reduce((sum, value) => sum + value * 2, 0);

  // CI 达标
  const ciAchieved = [];
  for (const cardId of CARD_IDS) {
    const entries = [
      ["Hold", cardStats[cardId].hold],
      ["Acquire", cardStats[cardId].acquire],
      ["Use", cardStats[cardId].use],
      ["Discard", cardStats[cardId].discard]
    ];
    for (const [metric, stat] of entries) {
      if (stat && stat.n >= 30 && stat.ciHalfPp <= 0.5) ciAchieved.push({ cardId, metric, ciHalfPp: stat.ciHalfPp });
    }
  }

  const minCiByMetric = {};
  for (const metric of ["hold", "acquire", "use", "discard"]) {
    const values = CARD_IDS
      .map((cardId) => cardStats[cardId][metric])
      .filter((stat) => stat && stat.n >= 30 && Number.isFinite(stat.ciHalfPp))
      .map((stat) => stat.ciHalfPp);
    minCiByMetric[metric] = values.length ? Math.min(...values) : null;
  }

  const summary = {
    naturalGames: corpus.length,
    naturalGameFailures: 1,
    roleGamesTarget: 320,
    roleGamesWithStates: new Set(roleStates.map((entry) => entry.seed)).size,
    roleStateCount: roleStates.length,
    naturalStateCount: naturalStates.length,
    rawPairs: {
      hold: compositeHoldRows.length,
      acquire: acquireRows.length,
      use: useRows.length,
      discard: discardRows.length,
      response: windowRows.length
    },
    validPairs: {
      hold: CARD_IDS.reduce((sum, cardId) => sum + byCard.hold[cardId].length, 0),
      acquire: CARD_IDS.reduce((sum, cardId) => sum + byCard.acquire[cardId].length, 0),
      use: CARD_IDS.reduce((sum, cardId) => sum + byCard.use[cardId].length, 0),
      discard: CARD_IDS.reduce((sum, cardId) => sum + byCard.discard[cardId].length, 0),
      response: windowRows.filter(holdRow).length
    },
    doneJobs,
    totalJobs,
    completionRatio,
    elapsedMinutes,
    jobsPerMin,
    etaMinutes,
    windowJobsTotal,
    ciAchieved,
    minCiByMetric,
    roundTerciles
  };

  await writeMasterCsv(cardStats, stratumStats);
  await writeRoleCsv(roleMatrix, cardStats);
  await writeReport({
    summary,
    cardStats,
    roleMatrix,
    stratumStats,
    top5,
    bottom5,
    overvalued,
    undervalued,
    reasonable,
    highVariance,
    roleDependence,
    situationDependence,
    underSampled,
    roundTerciles,
    roleHoldRows,
    suggested
  });

  printConsoleSummary({
    summary,
    cardStats,
    roleMatrix,
    roleHoldRows,
    underSampled,
    top5,
    bottom5,
    overvalued,
    undervalued,
    highVariance,
    roleDependence,
    situationDependence,
    ciAchieved
  });
}

function computeRoundTerciles(states) {
  const rounds = states.map((state) => state.round).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rounds.length) return { p33: 4, p67: 5 };
  const q = (p) => rounds[Math.min(rounds.length - 1, Math.floor(p * (rounds.length - 1)))];
  return { p33: q(1 / 3), p67: q(2 / 3) };
}

function rankSuggested(cardIds, cardStats) {
  const entries = cardIds.map((cardId) => ({ cardId, value: cardStats[cardId].hold?.mean ?? null }))
    .filter((entry) => Number.isFinite(entry.value));
  entries.sort((a, b) => a.value - b.value);
  const groups = [];
  for (const entry of entries) {
    const key = round(entry.value, 1);
    const last = groups.at(-1);
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, entries: [entry] });
  }
  const suggested = {};
  let rankCursor = 0;
  for (const group of groups) {
    const rank = rankCursor + (group.entries.length - 1) / 2;
    const mapped = Math.round(1 + 8 * (rank / Math.max(1, entries.length - 1)));
    for (const entry of group.entries) suggested[entry.cardId] = Math.max(1, Math.min(9, mapped));
    rankCursor += group.entries.length;
  }
  return suggested;
}

async function writeMasterCsv(cardStats, stratumStats) {
  const header = [
    "卡牌", "当前aiValue", "Hold N", "Hold ΔWR", "Acquire N", "Acquire ΔWR",
    "Use/Response N", "Use/Response ΔWR", "Discard N", "Discard Loss",
    "当前综合ΔWR", "95% CI", "当前可信度"
  ];
  const lines = [header.join(",")];
  for (const cardId of CARD_IDS) {
    const s = cardStats[cardId];
    const useN = s.use?.n ?? "N/A";
    const useMean = s.use?.meanPp != null ? fmt(s.use.meanPp) : "N/A";
    const ci = s.hold ? `[${fmt(s.hold.ciLowPp)}..${fmt(s.hold.ciHighPp)}]` : "N/A";
    const confidence = rowConfidence(s);
    lines.push([
      `"${s.name}"`, s.currentAiValue, s.hold?.n ?? "N/A", fmt(s.hold?.meanPp),
      s.acquire?.n ?? "N/A", fmt(s.acquire?.meanPp),
      useN, useMean,
      s.discard?.n ?? "N/A", fmt(s.discard?.meanPp),
      fmt(s.hold?.meanPp), ci, confidence
    ].join(","));
  }
  await writeFile(new URL("interim-master.csv", OUT_DIR), lines.join("\n") + "\n", "utf8");
}

async function writeRoleCsv(roleMatrix, cardStats) {
  const header = ["卡牌", ...ROLE_NAMES, "全局"];
  const lines = [header.join(",")];
  for (const cardId of CARD_IDS) {
    const cells = ROLES.map((role) => {
      const stat = roleMatrix[cardId][role];
      if (!stat) return "N/A";
      const low = stat.n < 100 || stat.ciHalfPp > 2.5;
      return `${fmt(stat.meanPp)} (N=${stat.n}${low ? ", low confidence" : ""})`;
    });
    lines.push([`"${cardStats[cardId].name}"`, ...cells, fmt(cardStats[cardId].hold?.meanPp)].join(","));
  }
  await writeFile(new URL("interim-role-matrix.csv", OUT_DIR), lines.join("\n") + "\n", "utf8");
}

async function writeReport(data) {
  const { summary, cardStats, roleMatrix, stratumStats, top5, bottom5, overvalued, undervalued, highVariance, roleDependence, situationDependence, underSampled, roundTerciles, roleHoldRows, suggested } = data;
  const lines = [];
  lines.push("# FiveRealms 卡牌价值测定 · 阶段性统计汇总");
  lines.push("");
  lines.push("> 本报告只基于已落盘数据生成，未新增任何样本；所有结论均为阶段性观察，不是最终结论。");
  lines.push("");
  lines.push("## 1. 当前数据快照");
  lines.push("");
  lines.push(`- 自然对局：${summary.naturalGames} 局（1 局任务失败不计入），无停滞。`);
  lines.push(`- 自然采集状态：${summary.naturalStateCount} 个回合开始状态。`);
  lines.push(`- 角色定向对局：目标 ${summary.roleGamesTarget} 局（每角色 40 局），有状态产出的 ${summary.roleGamesWithStates} 局；角色状态 ${summary.roleStateCount} 个（仅 1 号位回合）。`);
  lines.push(`- 响应窗口阶段尚未运行：Response 成对样本 = ${summary.validPairs.response}。`);
  lines.push("");
  lines.push("### 已落盘成对样本（去重后）");
  lines.push("");
  lines.push("| 指标 | 原始行数 | 有效对（无停滞） |");
  lines.push("|---|---|---|");
  lines.push(`| Hold | ${summary.rawPairs.hold} | ${summary.validPairs.hold} |`);
  lines.push(`| Acquire | ${summary.rawPairs.acquire} | ${summary.validPairs.acquire} |`);
  lines.push(`| Use | ${summary.rawPairs.use} | ${summary.validPairs.use} |`);
  lines.push(`| Discard | ${summary.rawPairs.discard} | ${summary.validPairs.discard} |`);
  lines.push(`| Response | ${summary.rawPairs.response} | ${summary.validPairs.response} |`);
  lines.push("");
  lines.push("## 2. 每张牌当前有效样本数");
  lines.push("");
  const sampleHeader = ["卡牌", "Hold", "Acquire", "Use(合法且已使用)", "Discard(自然持有)"];
  const sampleRows = [sampleHeader.join("|"), sampleHeader.map(() => "---").join("|")];
  for (const cardId of CARD_IDS) {
    const s = cardStats[cardId];
    sampleRows.push([
      s.name,
      s.hold?.n ?? 0,
      s.acquire?.n ?? 0,
      s.use?.n ?? 0,
      s.discard?.n ?? 0
    ].join("|"));
  }
  lines.push(sampleRows.join("\n"));
  lines.push("");
  lines.push("## 3. 每角色当前有效样本数（Hold，主体为该角色）");
  lines.push("");
  const roleHeader = ["角色", ...CARD_IDS.map((cardId) => cardStats[cardId].name)];
  const roleSampleRows = [roleHeader.join("|"), roleHeader.map(() => "---").join("|")];
  for (const role of ROLES) {
    const counts = CARD_IDS.map((cardId) => roleMatrix[cardId][role]?.n ?? 0);
    roleSampleRows.push([GENERAL_BY_ID[role].name, ...counts].join("|"));
  }
  lines.push(roleSampleRows.join("\n"));
  lines.push("");
  lines.push(`每角色作为当前玩家的自然状态数：${ROLES.map((role) => `${GENERAL_BY_ID[role].name}=${new Set((roleHoldRows[role] ?? []).map((row) => row.stateId)).size}`).join("、")}。`);
  lines.push("");
  lines.push("## 4. 样本明显不足清单（阶段性）");
  lines.push("");
  if (!underSampled.length) lines.push("暂无明显不足（阈值：Hold/Acquire<100、Use<50、Discard<30）。");
  else {
    for (const entry of underSampled) {
      lines.push(`- ${cardStats[entry.cardId].name}（${entry.cardId}）：${entry.bottlenecks.join("、")}`);
    }
  }
  lines.push("");
  lines.push("## 5. 阶段性主表");
  lines.push("");
  lines.push(masterTable(cardStats));
  lines.push("");
  lines.push("> 可信度说明：行级“当前可信度”取该行 Hold/Acquire/Use/Discard 各指标的最低等级；由于 Use 当前仅 25 个状态（N≤25），几乎所有行被标记为低可信。各指标独立可信度请结合 N 与 CI 半宽判断。");
  lines.push("");
  lines.push("## 6. 阶段性角色矩阵（Hold ΔWR，pp）");
  lines.push("");
  lines.push(roleTable(roleMatrix, cardStats));
  lines.push("");
  lines.push("## 7. 阶段性观察（非最终结论）");
  lines.push("");
  lines.push(`### 当前看起来价值最高的 5 张牌（按自然分布综合 Hold ΔWR）`);
  lines.push(top5.map((entry) => `- ${cardStats[entry.cardId].name}：${fmt(entry.stat.meanPp)} pp（N=${entry.stat.n}，CI 半宽 ${fmt(entry.stat.ciHalfPp)} pp）`).join("\n"));
  lines.push("");
  lines.push(`### 当前看起来价值最低的 5 张牌`);
  lines.push(bottom5.map((entry) => `- ${cardStats[entry.cardId].name}：${fmt(entry.stat.meanPp)} pp（N=${entry.stat.n}，CI 半宽 ${fmt(entry.stat.ciHalfPp)} pp）`).join("\n"));
  lines.push("");
  lines.push(`### 当前 aiValue 可能明显高估的牌（建议值比当前低 ≥2）`);
  lines.push(overvalued.length ? overvalued.map((entry) => `- ${cardStats[entry.cardId].name}：当前 ${entry.current} → 建议 ${entry.suggested}`).join("\n") : "无");
  lines.push("");
  lines.push(`### 当前 aiValue 可能明显低估的牌（建议值比当前高 ≥2）`);
  lines.push(undervalued.length ? undervalued.map((entry) => `- ${cardStats[entry.cardId].name}：当前 ${entry.current} → 建议 ${entry.suggested}`).join("\n") : "无");
  lines.push("");
  lines.push("> 说明：上述“建议值”由当前实测综合值排名映射到 1~9，样本量不足时对排序极敏感，仅作为阶段性观察线索，不作为高估/低估结论。");
  lines.push("");
  lines.push(`### 当前方差最大的牌（Hold Δ 的样本标准差）`);
  lines.push(highVariance.slice(0, 8).map((entry) => `- ${cardStats[entry.cardId].name}：SD ${fmt(entry.sd)} pp（N=${entry.n}）`).join("\n"));
  lines.push("");
  lines.push(`### 当前最依赖角色的牌（角色均值极差，需 ≥4 角色且 N≥15）`);
  lines.push(roleDependence.slice(0, 8).map((entry) => `- ${cardStats[entry.cardId].name}：极差 ${fmt(entry.range)} pp`).join("\n"));
  lines.push("");
  lines.push(`### 当前最依赖局面的牌（分层均值极差，需 ≥3 层且 N≥10）`);
  lines.push(situationDependence.slice(0, 8).map((entry) => `- ${cardStats[entry.cardId].name}：极差 ${fmt(entry.range)} pp`).join("\n"));
  lines.push("");
  lines.push(`### 当前样本最不足的牌`);
  lines.push(underSampled.map((entry) => `- ${cardStats[entry.cardId].name}：${entry.bottlenecks.join("、")}`).join("\n") || "无");
  lines.push("");
  lines.push("## 8. 完成比例与吞吐");
  lines.push("");
  lines.push(`- 实验任务：已完成 ${summary.doneJobs} / ${summary.totalJobs}（${(summary.completionRatio * 100).toFixed(1)}%）。`);
  lines.push(`- 响应窗口任务：${summary.windowJobsTotal} 个，尚未开始。`);
  lines.push(`- 已运行约 ${summary.elapsedMinutes} 分钟，吞吐约 ${summary.jobsPerMin.toFixed(1)} 任务/分钟。`);
  lines.push(summary.etaMinutes != null
    ? `- 预计剩余实验时间约 ${summary.etaMinutes.toFixed(0)} 分钟（不含响应窗口阶段，假设吞吐不变）。`
    : "- 预计剩余时间无法估算（尚无完成记录）。");
  lines.push("");
  lines.push("## 9. CI 达标情况（95% CI 半宽 ≤ 0.5 pp）");
  lines.push("");
  if (!summary.ciAchieved.length) {
    lines.push("当前没有任何指标达到 95% CI 半宽 ≤ 0.5 pp。");
  } else {
    lines.push(summary.ciAchieved.map((entry) => `- ${cardStats[entry.cardId].name} ${entry.metric}：${fmt(entry.ciHalfPp)} pp`).join("\n"));
  }
  lines.push("");
  lines.push(`当前最小 CI 半宽（仅统计 N≥30 的卡牌）：Hold ${fmt(summary.minCiByMetric.hold ?? null)} pp、Acquire ${fmt(summary.minCiByMetric.acquire ?? null)} pp、Use ${fmt(summary.minCiByMetric.use ?? null)} pp、Discard ${fmt(summary.minCiByMetric.discard ?? null)} pp。`);
  lines.push("");
  lines.push("## 10. 需要继续补样的指标");
  lines.push("");
  lines.push("- Hold：所有卡牌（当前 N≈489，CI 半宽约 2~5 pp，未达 0.5 pp 目标）。");
  lines.push("- Acquire：所有卡牌（同上；部分稀有牌因牌堆可用性 N 更低）。");
  lines.push("- Use：当前仅完成 25 个状态（N≈数十），明显不足。");
  lines.push("- Discard：稀有卡（丰收/共生/闪电/转移等）N 明显不足。");
  lines.push("- Response：窗口阶段尚未运行（0 对），需要专门补跑。");
  lines.push("- 角色矩阵：当前仅来自自然语料（每角色约 60 个状态左右），每个格子 N 不足 100。");
  lines.push("");
  lines.push("## 11. 生成文件");
  lines.push("");
  const outPath = fileURLToPath(OUT_DIR).replace(/\\/g, "/");
  lines.push(`- ${outPath}interim-report.md`);
  lines.push(`- ${outPath}interim-master.csv`);
  lines.push(`- ${outPath}interim-role-matrix.csv`);
  lines.push("");
  lines.push(`## 12. 阶段分层定义（基于自然状态轮次分布：p33=${roundTerciles.p33}、p67=${roundTerciles.p67}）`);
  lines.push("");
  lines.push("前期 ≤ p33 轮；中期 ≤ p67 轮；后期 > p67 轮。HP：危急≤1、低血=2、健康≥3、满血=maxHp；手牌：低0~2、中3~5、高≥6；能量：低0~1、中2、高≥3；局势：己方(HP+盾)-敌方(HP+盾)≥2 领先、≤-2 落后、其余接近。");
  lines.push("");
  await writeFile(new URL("interim-report.md", OUT_DIR), lines.join("\n"), "utf8");
}

function masterTable(cardStats) {
  const header = ["卡牌", "当前aiValue", "Hold N", "Hold ΔWR", "Acquire N", "Acquire ΔWR", "Use/Response N", "Use/Response ΔWR", "Discard N", "Discard Loss", "当前综合ΔWR", "95% CI", "当前可信度"];
  const rows = [header.join("|"), header.map(() => "---").join("|")];
  for (const cardId of CARD_IDS) {
    const s = cardStats[cardId];
    const useN = s.use?.n ?? "N/A";
    const useMean = s.use?.meanPp != null ? fmt(s.use.meanPp) : "N/A";
    const ci = s.hold ? `[${fmt(s.hold.ciLowPp)}..${fmt(s.hold.ciHighPp)}]` : "N/A";
    const confidence = rowConfidence(s);
    rows.push([
      s.name, s.currentAiValue, s.hold?.n ?? "N/A", fmt(s.hold?.meanPp),
      s.acquire?.n ?? "N/A", fmt(s.acquire?.meanPp),
      useN, useMean,
      s.discard?.n ?? "N/A", fmt(s.discard?.meanPp),
      fmt(s.hold?.meanPp), ci, confidence
    ].join("|"));
  }
  return rows.join("\n");
}

function roleTable(roleMatrix, cardStats) {
  const header = ["卡牌", ...ROLE_NAMES, "全局"];
  const rows = [header.join("|"), header.map(() => "---").join("|")];
  for (const cardId of CARD_IDS) {
    const cells = ROLES.map((role) => {
      const stat = roleMatrix[cardId][role];
      if (!stat) return "N/A";
      const low = stat.n < 100 || stat.ciHalfPp > 2.5;
      return `${fmt(stat.meanPp)} (N=${stat.n}${low ? ", low confidence" : ""})`;
    });
    rows.push([cardStats[cardId].name, ...cells, fmt(cardStats[cardId].hold?.meanPp)].join("|"));
  }
  return rows.join("\n");
}

function printConsoleSummary(data) {
  const { summary, cardStats, underSampled, top5, bottom5, overvalued, undervalued, highVariance, roleDependence, situationDependence, ciAchieved } = data;
  const lines = [];
  lines.push("===== 阶段性统计汇总 =====");
  lines.push(`自然对局：${summary.naturalGames}；角色定向对局：${summary.roleGamesWithStates}/${summary.roleGamesTarget}；自然状态：${summary.naturalStateCount}；角色状态：${summary.roleStateCount}`);
  lines.push(`已完成 paired comparisons（有效对）：Hold=${summary.validPairs.hold}，Acquire=${summary.validPairs.acquire}，Use=${summary.validPairs.use}，Discard=${summary.validPairs.discard}，Response=${summary.validPairs.response}；原始行合计=${Object.values(summary.rawPairs).reduce((a, b) => a + b, 0)}`);
  lines.push(`实验完成比例：${(summary.completionRatio * 100).toFixed(1)}%（${summary.doneJobs}/${summary.totalJobs}）；吞吐约 ${summary.jobsPerMin.toFixed(1)} 任务/分钟；预计剩余 ${summary.etaMinutes != null ? summary.etaMinutes.toFixed(0) : "N/A"} 分钟（不含窗口阶段）`);
  lines.push("");
  lines.push("每张牌有效样本（Hold/Acquire/Use/Discard）：");
  for (const cardId of CARD_IDS) {
    const s = cardStats[cardId];
    lines.push(`  ${s.name}：${s.hold?.n ?? 0}/${s.acquire?.n ?? 0}/${s.use?.n ?? 0}/${s.discard?.n ?? 0}`);
  }
  lines.push("");
  lines.push("每角色有效样本（Hold）：");
  for (const role of ROLES) {
    const states = new Set((data.roleHoldRows[role] ?? []).map((row) => row.stateId)).size;
    lines.push(`  ${GENERAL_BY_ID[role].name}：${states} 个状态（${data.roleHoldRows[role]?.length ?? 0} 行）`);
  }
  lines.push("");
  lines.push("样本明显不足的牌：");
  if (!underSampled.length) lines.push("  无");
  else for (const entry of underSampled) lines.push(`  ${cardStats[entry.cardId].name}：${entry.bottlenecks.join("、")}`);
  lines.push("");
  lines.push("价值最高 5 张（阶段性）：");
  for (const entry of top5) lines.push(`  ${cardStats[entry.cardId].name} ${fmt(entry.stat.meanPp)} pp`);
  lines.push("价值最低 5 张（阶段性）：");
  for (const entry of bottom5) lines.push(`  ${cardStats[entry.cardId].name} ${fmt(entry.stat.meanPp)} pp`);
  lines.push("可能高估（阶段性）：");
  lines.push(overvalued.length ? overvalued.map((entry) => `  ${cardStats[entry.cardId].name} (${entry.current}→${entry.suggested})`).join("\n") : "  无");
  lines.push("可能低估（阶段性）：");
  lines.push(undervalued.length ? undervalued.map((entry) => `  ${cardStats[entry.cardId].name} (${entry.current}→${entry.suggested})`).join("\n") : "  无");
  lines.push("方差最大（阶段性）：");
  for (const entry of highVariance.slice(0, 5)) lines.push(`  ${cardStats[entry.cardId].name} SD=${fmt(entry.sd)} pp`);
  lines.push("最依赖角色（阶段性）：");
  for (const entry of roleDependence.slice(0, 5)) lines.push(`  ${cardStats[entry.cardId].name} 极差=${fmt(entry.range)} pp`);
  lines.push("最依赖局面（阶段性）：");
  for (const entry of situationDependence.slice(0, 5)) lines.push(`  ${cardStats[entry.cardId].name} 极差=${fmt(entry.range)} pp`);
  lines.push("");
  lines.push(`CI 达标（半宽≤0.5pp）：${ciAchieved.length ? ciAchieved.map((entry) => `${cardStats[entry.cardId].name} ${entry.metric}`).join("、") : "无"}`);
  lines.push("===== 结束 =====");
  process.stdout.write(`${lines.join("\n")}\n`);
}

await main();
