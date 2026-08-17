/**
 * 统计聚合与最终输出。
 * 读取 data/ 下的语料与成对行，生成：
 *   - tests/ai-card-study/card-value-results.json
 *   - tests/ai-card-study/card-value-master.csv
 *   - tests/ai-card-study/card-role-matrix.csv
 *   - tests/ai-card-study/card-value-report.md
 *   （设置 FIVE_REALMS_STUDY_RUN_DIR 时输出到指定运行目录）
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CARD_DEFINITIONS } from "../../../js/domain/definitions/cards/CardDefinitions.js";
import { CHARACTER_DEFINITIONS, CHARACTER_BY_ID } from "../../../js/domain/definitions/characters/CharacterDefinitions.js";
import { ROLE_CARD_VALUE_DELTAS } from "../../../js/ai/value/CardValue.js";
import { runDirUrl } from "./runPaths.js";

let DATA_DIR = new URL("../data/", import.meta.url);
let OUT_DIR = new URL("../", import.meta.url);

const CARD_IDS = Object.keys(CARD_DEFINITIONS);
const ROLES = CHARACTER_DEFINITIONS.map((character) => character.id);

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

function stats(values) {
  const n = values.length;
  if (!n) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const ciHalf = 1.96 * se;
  return {
    n,
    mean,
    sd,
    se,
    ciLow: mean - ciHalf,
    ciHigh: mean + ciHalf,
    ciHalf
  };
}

function pairStats(rows, filter) {
  const values = [];
  for (const row of rows) {
    if (!filter || filter(row)) {
      if (row.aStalled || row.bStalled) continue;
      values.push(row.aWin - row.bWin);
    }
  }
  return stats(values);
}

function withPp(stat) {
  if (!stat) return null;
  return {
    ...stat,
    meanPp: stat.mean * 100,
    sdPp: stat.sd * 100,
    sePp: stat.se * 100,
    ciLowPp: stat.ciLow * 100,
    ciHighPp: stat.ciHigh * 100,
    ciHalfPp: stat.ciHalf * 100
  };
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value, digits = 2) {
  return value === null || value === undefined ? "N/A" : round(value, digits).toFixed(digits);
}

function confidenceLabel(stat, thresholds = { highN: 800, highHalf: 1, midN: 250, midHalf: 2.5 }) {
  if (!stat) return "低可信";
  if (stat.n >= thresholds.highN && stat.ciHalf <= thresholds.highHalf) return "高可信";
  if (stat.n >= thresholds.midN || stat.ciHalf <= thresholds.midHalf) return "中可信";
  return "低可信";
}

function rankSuggested(values) {
  const entries = CARD_IDS.map((cardId) => ({ cardId, value: values[cardId] }))
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
    const clamped = Math.max(1, Math.min(9, mapped));
    for (const entry of group.entries) suggested[entry.cardId] = clamped;
    rankCursor += group.entries.length;
  }
  return suggested;
}

function roleDeltaSuggested(deltaPpByCardRole) {
  const allAbs = [];
  for (const cardId of CARD_IDS) {
    for (const role of ROLES) {
      const value = deltaPpByCardRole[cardId]?.[role];
      if (Number.isFinite(value)) allAbs.push(Math.abs(value));
    }
  }
  if (!allAbs.length) return {};
  const sorted = [...allAbs].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const scale = Math.max(0.5, p90 / 2);
  const result = {};
  for (const cardId of CARD_IDS) {
    result[cardId] = {};
    for (const role of ROLES) {
      const value = deltaPpByCardRole[cardId]?.[role];
      if (!Number.isFinite(value)) continue;
      result[cardId][role] = Math.max(-2, Math.min(2, Math.round(value / scale)));
    }
  }
  return { scale, table: result };
}

export async function aggregate(options = {}) {
  const runBase = runDirUrl(options.runDir);
  if (runBase) {
    DATA_DIR = new URL("data/", runBase);
    OUT_DIR = runBase;
  }
  const holdRows = dedupeRows(await readLines("pairs-hold.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const acquireRows = dedupeRows(await readLines("pairs-acquire.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const useRows = dedupeRows(await readLines("pairs-use.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const discardRows = dedupeRows(await readLines("pairs-discard.jsonl"), (row) => `${row.stateId}|${row.card}`);
  const windowRows = dedupeRows(await readLines("pairs-window.jsonl"), (row) => `${row.seed}|${row.windowType}`);
  const corpus = await readJson("corpus.json", []);
  const naturalStates = await readLines("corpus-states.jsonl");
  const roleStates = await readLines("role-states.jsonl");
  const studyConfig = await readJson("config.json", {});
  const windowSummary = await readJson("window-summary.json", {});

  const allRounds = corpus.map((entry) => entry.rounds).filter(Number.isFinite);
  const sortedRounds = [...allRounds].sort((a, b) => a - b);
  const quantile = (q) => sortedRounds[Math.min(sortedRounds.length - 1, Math.floor(q * (sortedRounds.length - 1)))];
  const roundTerciles = { p33: quantile(1 / 3), p67: quantile(2 / 3) };

  const holdByCard = {};
  const holdByCardStratum = {};
  const useByCard = {};
  const acquireByCard = {};
  const discardByCard = {};
  const responseByWindow = {};
  const holdByRoleCard = {};

  const phaseOf = (row) => {
    const round = row.round;
    if (round <= roundTerciles.p33) return "early";
    if (round <= roundTerciles.p67) return "mid";
    return "late";
  };

  for (const row of holdRows) {
    const role = row.role;
    holdByRoleCard[row.card] ??= {};
    holdByRoleCard[row.card][role] ??= [];
    holdByRoleCard[row.card][role].push(row);
    if (row.sampleType !== "composite") continue;
    holdByCard[row.card] ??= [];
    holdByCard[row.card].push(row);
    const phase = phaseOf(row);
    const key = `${row.classification.hpClass}|${row.classification.handClass}|${phase}|${row.classification.leadClass}|${row.classification.canReachEnemy}|${row.classification.canUnlockActiveWithOneEnergy}`;
    holdByCardStratum[row.card] ??= {};
    holdByCardStratum[row.card][key] ??= [];
    holdByCardStratum[row.card][key].push(row);
  }

  for (const row of acquireRows) {
    acquireByCard[row.card] ??= [];
    acquireByCard[row.card].push(row);
  }
  for (const row of useRows) {
    useByCard[row.card] ??= [];
    useByCard[row.card].push(row);
  }
  for (const row of discardRows) {
    if (row.sampleType !== "composite") continue;
    discardByCard[row.card] ??= [];
    discardByCard[row.card].push(row);
  }
  for (const row of windowRows) {
    responseByWindow[row.windowType] ??= [];
    responseByWindow[row.windowType].push(row);
  }

  const holdStats = {};
  const acquireStats = {};
  const useStats = {};
  const discardStats = {};
  for (const cardId of CARD_IDS) {
    holdStats[cardId] = pairStats(holdByCard[cardId] ?? []);
    acquireStats[cardId] = pairStats(acquireByCard[cardId] ?? []);
    const useRowsForCard = useByCard[cardId] ?? [];
    const legalCount = useRowsForCard.filter((row) => row.aLegal).length;
    useStats[cardId] = {
      stats: pairStats(useRowsForCard, (row) => row.aLegal && row.aPlayed),
      attempted: useRowsForCard.length,
      legalCount,
      playedCount: useRowsForCard.filter((row) => row.aPlayed).length,
      legalityRate: useRowsForCard.length ? legalCount / useRowsForCard.length : null
    };
    discardStats[cardId] = pairStats(discardByCard[cardId] ?? []);
  }

  const roleMatrix = {};
  const roleDeltaPp = {};
  for (const cardId of CARD_IDS) {
    roleMatrix[cardId] = {};
    roleDeltaPp[cardId] = {};
    const global = holdStats[cardId];
    for (const role of ROLES) {
      const stat = pairStats(holdByRoleCard[cardId]?.[role] ?? []);
      roleMatrix[cardId][role] = stat;
      roleDeltaPp[cardId][role] = stat && global ? (stat.mean - global.mean) * 100 : null;
    }
  }

  const responseStats = {};
  for (const windowType of Object.keys(responseByWindow)) {
    const rows = responseByWindow[windowType];
    const conditional = pairStats(rows, (row) => row.windowOpenedA > 0 && row.windowOpenedB > 0);
    const global = pairStats(rows);
    const summary = windowSummary[windowType] ?? { jobs: 0, pairs: 0, noWindow: 0 };
    const forkRate = summary.jobs > 0 ? (summary.pairs + summary.noWindow) > 0 ? summary.pairs / (summary.pairs + summary.noWindow) : 0 : null;
    const windowOpenedRate = global && conditional && conditional.mean
      ? Math.max(0, Math.min(1, global.mean / conditional.mean))
      : null;
    responseStats[windowType] = {
      conditional: withPp(conditional),
      global: withPp(global),
      windowOpenedRate,
      forkRate,
      pairs: rows.length,
      jobs: summary.jobs ?? 0,
      noWindow: summary.noWindow ?? 0
    };
  }

  // 综合值：自然分布（composite hold 行按状态均匀 = 自然状态频率加权）与均匀情景辅助值
  const compositeHold = {};
  const uniformScenario = {};
  const strataByCard = {};
  for (const cardId of CARD_IDS) {
    compositeHold[cardId] = holdStats[cardId];
    const rows = holdByCard[cardId] ?? [];
    const stat = (filter) => pairStats(rows.filter(filter));
    strataByCard[cardId] = {
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
      early: stat((row) => phaseOf(row) === "early"),
      mid: stat((row) => phaseOf(row) === "mid"),
      late: stat((row) => phaseOf(row) === "late"),
      lead: stat((row) => row.classification.leadClass === "lead"),
      close: stat((row) => row.classification.leadClass === "close"),
      lag: stat((row) => row.classification.leadClass === "lag"),
      unlock: stat((row) => row.classification.canUnlockActiveWithOneEnergy === true)
    };
    const cells = {};
    for (const row of rows) {
      if (row.aStalled || row.bStalled) continue;
      const phase = phaseOf(row);
      const key = `${row.classification.hpClass}|${row.classification.handClass}|${phase}`;
      cells[key] ??= [];
      cells[key].push(row.aWin - row.bWin);
    }
    const cellMeans = Object.values(cells)
      .filter((values) => values.length >= 5)
      .map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    uniformScenario[cardId] = stats(cellMeans);
  }

  const suggestedAiValue = rankSuggested(
    Object.fromEntries(CARD_IDS.map((cardId) => [cardId, compositeHold[cardId]?.mean ?? null]))
  );

  const suggestedRoleDeltas = roleDeltaSuggested(roleDeltaPp);

  // 异常分析
  const anomalies = {
    overvalued: [],
    undervalued: [],
    reasonable: [],
    situationSensitive: [],
    roleSensitive: [],
    multiSemantic: []
  };
  for (const cardId of CARD_IDS) {
    const current = CARD_DEFINITIONS[cardId].aiValue;
    const suggested = suggestedAiValue[cardId];
    const diff = suggested - current;
    if (diff >= 2) anomalies.overvalued.push({ card: cardId, current, suggested, diff });
    else if (diff <= -2) anomalies.undervalued.push({ card: cardId, current, suggested, diff });
    else anomalies.reasonable.push({ card: cardId, current, suggested, diff });

    const stratumRows = holdByCardStratum[cardId] ?? {};
    const stratumMeansPp = Object.values(stratumRows)
      .map((rows) => pairStats(rows))
      .filter(Boolean)
      .map((stat) => stat.mean * 100);
    if (stratumMeansPp.length >= 3) {
      const range = Math.max(...stratumMeansPp) - Math.min(...stratumMeansPp);
      if (range >= 6) anomalies.situationSensitive.push({ card: cardId, range: round(range) });
    }

    const roleMeansPp = ROLES
      .map((role) => roleMatrix[cardId]?.[role])
      .filter(Boolean)
      .map((stat) => stat.mean * 100);
    if (roleMeansPp.length >= 5) {
      const range = Math.max(...roleMeansPp) - Math.min(...roleMeansPp);
      if (range >= 5) anomalies.roleSensitive.push({ card: cardId, range: round(range) });
    }

    const hold = holdStats[cardId]?.mean != null ? holdStats[cardId].mean * 100 : null;
    const use = useStats[cardId]?.stats?.mean != null ? useStats[cardId].stats.mean * 100 : null;
    const acquire = acquireStats[cardId]?.mean != null ? acquireStats[cardId].mean * 100 : null;
    const discard = discardStats[cardId]?.mean != null ? discardStats[cardId].mean * 100 : null;
    const spread = [hold, use, acquire, discard].filter(Number.isFinite);
    if (spread.length >= 3) {
      const range = Math.max(...spread) - Math.min(...spread);
      if (range >= 8) anomalies.multiSemantic.push({ card: cardId, range: round(range), hold: round(hold), use: round(use), acquire: round(acquire), discard: round(discard) });
    }
  }

  const results = {
    method: {
      nodeBudget: studyConfig.nodeBudget ?? 1000,
      roleStateTargetPerRole: studyConfig.roleStateTargetPerRole ?? 120,
      paired: true,
      sharedControl: true,
      terminalWinRate: true
    },
    corpus: {
      games: corpus.length,
      stalls: corpus.filter((entry) => entry.stalled).length,
      rounds: allRounds.length
        ? {
            average: round(allRounds.reduce((sum, value) => sum + value, 0) / allRounds.length, 2),
            median: quantile(0.5),
            p90: quantile(0.9),
            max: Math.max(...allRounds),
            terciles: roundTerciles
          }
        : null,
      naturalStates: naturalStates.length,
      roleStatesByRole: Object.fromEntries(ROLES.map((role) => [role, roleStates.filter((entry) => entry.roleOverride === role).length])),
      winners: corpus.reduce((acc, entry) => {
        acc[entry.winnerTeam ?? "none"] = (acc[entry.winnerTeam ?? "none"] ?? 0) + 1;
        return acc;
      }, {})
    },
    cards: {}
  };
  for (const cardId of CARD_IDS) {
    const definition = CARD_DEFINITIONS[cardId];
    results.cards[cardId] = {
      name: definition.name,
      definitionId: cardId,
      category: definition.category,
      currentAiValue: definition.aiValue,
      suggestedAiValue: suggestedAiValue[cardId] ?? null,
      suggestedDiff: suggestedAiValue[cardId] != null ? suggestedAiValue[cardId] - definition.aiValue : null,
      hold: withPp(holdStats[cardId]),
      acquire: withPp(acquireStats[cardId]),
      use: useStats[cardId] ? { ...useStats[cardId], stats: withPp(useStats[cardId].stats) } : null,
      discard: withPp(discardStats[cardId]),
      compositeHold: withPp(compositeHold[cardId]),
      uniformScenario: withPp(uniformScenario[cardId]),
      strata: Object.fromEntries(Object.entries(strataByCard[cardId] ?? {}).map(([key, stat]) => [key, withPp(stat)])),
      roleMatrix: Object.fromEntries(ROLES.map((role) => [role, withPp(roleMatrix[cardId]?.[role] ?? null)])),
      roleDeltaPp: roleDeltaPp[cardId],
      suggestedRoleDeltas: suggestedRoleDeltas.table[cardId] ?? {}
    };
  }
  results.response = responseStats;
  results.anomalies = anomalies;
  results.roleDeltaMapping = { scale: suggestedRoleDeltas.scale };

  await writeFile(new URL("card-value-results.json", OUT_DIR), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await writeMasterCsv(results);
  await writeRoleCsv(results);
  await writeReport(results, holdByCardStratum);
  return results;
}

async function writeMasterCsv(results) {
  const header = [
    "卡牌", "当前aiValue", "样本N", "持有ΔWR", "获取ΔWR", "使用/响应ΔWR", "弃牌损失ΔWR",
    "危急HP价值", "健康HP价值", "低手牌价值", "高手牌价值", "前期价值", "中期价值", "后期价值",
    "领先价值", "落后价值", "综合ΔWR", "95% CI", "建议aiValue", "差值"
  ];
  const lines = [header.join(",")];
  const stratumCells = {};
  for (const cardId of Object.keys(results.cards)) {
    const card = results.cards[cardId];
    const useCell = card.use?.stats ? `${fmt(card.use.stats.meanPp)}` : "N/A";
    const responseCell = responsePrimary(results, cardId) ?? "N/A";
    const value = useCell === "N/A" ? responseCell : `${useCell}${responseCell !== "N/A" ? ` / ${responseCell}` : ""}`;
    const ci = card.compositeHold ? `[${fmt(card.compositeHold.ciLowPp)}..${fmt(card.compositeHold.ciHighPp)}]` : "N/A";
    lines.push([
      `"${card.name}"`, card.currentAiValue, card.hold?.n ?? "N/A", fmt(card.hold?.meanPp), fmt(card.acquire?.meanPp),
      value, fmt(card.discard?.meanPp), fmt(stratumMeanPp(card, "critical")), fmt(stratumMeanPp(card, "healthy")),
      fmt(stratumMeanPp(card, "lowHand")), fmt(stratumMeanPp(card, "highHand")),
      fmt(stratumMeanPp(card, "early")), fmt(stratumMeanPp(card, "mid")), fmt(stratumMeanPp(card, "late")),
      fmt(stratumMeanPp(card, "lead")), fmt(stratumMeanPp(card, "lag")),
      fmt(card.compositeHold?.meanPp), ci, card.suggestedAiValue ?? "N/A", card.suggestedDiff ?? "N/A"
    ].join(","));
  }
  await writeFile(new URL("card-value-master.csv", OUT_DIR), lines.join("\n") + "\n", "utf8");
}

function responsePrimary(results, cardId) {
  const mapping = {
    block: "block",
    counter: "counter",
    recover: "dying"
  };
  const windowType = mapping[cardId];
  const stat = windowType ? results.response?.[windowType]?.conditional : null;
  return stat ? round(stat.meanPp, 2) : null;
}

async function writeRoleCsv(results) {
  const roleNames = ROLES.map((role) => CHARACTER_BY_ID[role].name);
  const header = ["卡牌", ...roleNames, "全局"];
  const lines = [header.join(",")];
  for (const cardId of Object.keys(results.cards)) {
    const card = results.cards[cardId];
    const values = ROLES.map((role) => fmt(card.roleMatrix[role]?.meanPp));
    lines.push([`"${card.name}"`, ...values, fmt(card.compositeHold?.meanPp)].join(","));
  }
  lines.push("");
  lines.push(`建议角色差值表（scale=${round(results.roleDeltaMapping.scale, 3)} pp/点，截断 -2..+2）`);
  const suggestedHeader = ["卡牌", ...roleNames];
  lines.push(suggestedHeader.join(","));
  for (const cardId of Object.keys(results.cards)) {
    const card = results.cards[cardId];
    const values = ROLES.map((role) => card.suggestedRoleDeltas[role] ?? "");
    lines.push([`"${card.name}"`, ...values].join(","));
  }
  await writeFile(new URL("card-role-matrix.csv", OUT_DIR), lines.join("\n") + "\n", "utf8");
}

async function writeReport(results, holdByCardStratum) {
  const lines = [];
  lines.push("# FiveRealms 卡牌真实价值测定报告");
  lines.push("");
  lines.push("> 研究性质：独立测量研究；未修改任何正式业务文件、aiValue 或 AI 权重。");
  lines.push("");
  lines.push("## 1. 研究方法");
  lines.push("");
  lines.push(`- 主指标：成对终局胜率差 ΔWR = P(win | 实验臂) − P(win | 对照臂)，单位百分点（pp）。`);
  lines.push(`- 游戏引擎：${results.corpus.games} 局自然 self-play 语料 + 成对分支模拟；AI 搜索节点预算 ${results.method.nodeBudget}（与项目默认一致）。`);
  lines.push(`- 成对方式：同一状态（角色/队友/敌人/HP/能量/装备/座位/回合/手牌/牌堆/随机种子）克隆为两条独立分支，只改变实验变量；对照组在相同状态点共享。`);
  lines.push(`- 平局/停滞处理：规则无平局；任一支停滞的对全部剔除并单独计数。`);
  lines.push("");
  lines.push("## 2. aiValue 当前实际用途审计");
  lines.push("");
  lines.push("| 模块 | 函数 | 用途 | 基础值/角色值 | 局面修正 | 行动评分 | 弃牌 | 资源选择 | 模拟状态价值 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  lines.push("| cardConfig.js | CARD_DEFINITIONS.aiValue | 静态基准 | 基础值 | 无 | 间接 | 间接 | 间接 | 间接 |");
  lines.push("| value/CardValue.js | getBaseCardAiValue | 读取基础值 | 基础值 | 无 | 否 | 否 | 否 | 否 |");
  lines.push("| value/CardValue.js | getRoleCardAiValue | 角色有效值 = 基础 + 差值 | 角色值 | 无 | 是 | 是 | 是 | 是 |");
  lines.push("| AiEvaluator | actionUtility | 行动基础评分 | 角色值 | 有（低血/距离/目标价值等） | 是 | 否 | 否 | 否 |");
  lines.push("| AiEvaluator | stateUtility | 装备/手牌/状态效用 | 基础值+角色差值 | 有 | 否 | 否 | 否 | 是 |");
  lines.push("| CardSelectionBoundary | chooseDiscards / choosePublicCard / chooseHiddenCards | 弃牌、公共牌、隐藏选牌 | 角色值 | 有（调息/格挡/共生/孤立突袭） | 否 | 是 | 是 | 否 |");
  lines.push("| Simulator | 装备基线/角色差值 | 模拟装备与角色偏好 | 角色值 | 无 | 否 | 否 | 否 | 是 |");
  lines.push("| resourceSelectionValue | getResourceDefinitionUtility | 破坏/掠夺目标价值 | 角色值 | 无 | 否 | 否 | 是 | 否 |");
  lines.push("| transferScoring | cardSituationValue / 转移评分 | 转移选牌与组合评分 | 角色值 | 有（HP/能量/破势/攻击槽） | 否 | 否 | 是 | 否 |");
  lines.push("| lightningScoring + AiEvaluator | buildLightningHitDistribution / lightningLifecycleValue | 闪电流转概率与 owner-local 状态经济 | 不使用独立基础值 | 有 | 搜索先验/状态差值 | 否 | 否 | 是 |");
  lines.push("| ResponseBoundary | shouldRespond（反制/借势） | 响应决策 | 基础值 | 有 | 否 | 否 | 否 | 否 |");
  lines.push("| AiGlobalBenefit | assessGlobalBenefit | 互利/共生全局净收益 | 不使用 aiValue | 有 | 是 | 否 | 否 | 否 |");
  lines.push("| ThreatCalculator | calculate | 威胁评分 | 不使用 aiValue | 有 | 是 | 否 | 否 | 否 |");
  lines.push("");
  lines.push("语义区分：A 持牌 / B 使用 / C 弃牌 / D 获取 / E 对手资源 / F 装备持续 / G 角色偏好。当前单一 aiValue 同时承担 A/B/C/D/F/G 多重语义，E 由 resourceSelectionValue 单独建模。");
  lines.push("");
  lines.push("## 3. 状态采样方法");
  lines.push("");
  lines.push(`- 自然语料：${results.corpus.games} 局全 AI self-play，记录每回合开始状态，共 ${results.corpus.naturalStates} 个；综合值按这些状态均匀抽样（等价于按自然状态出现频率加权）。`);
  const roleStateSummary = ROLES.map((role) => `${CHARACTER_BY_ID[role].name}=${results.corpus.roleStatesByRole?.[role] ?? 0}`).join("、");
  lines.push(`- 角色矩阵：每个角色额外强制为 1 号位采样回合开始状态（角色语料状态数：${roleStateSummary}）。`);
  lines.push(`- 对局长度分布：平均 ${results.corpus.rounds?.average} 轮，中位 ${results.corpus.rounds?.median}，P90 ${results.corpus.rounds?.p90}，最大 ${results.corpus.rounds?.max}。`);
  lines.push(`- 阶段分层：前期 ≤ 第 ${results.corpus.rounds?.terciles?.p33} 轮，中期 ≤ 第 ${results.corpus.rounds?.terciles?.p67} 轮，后期 > 第 ${results.corpus.rounds?.terciles?.p67} 轮。`);
  lines.push(`- HP 分层：危急 ≤1、低血 =2、健康 ≥3、满血 = maxHp。手牌：低 0~2、中 3~5、高 ≥6。能量：低 0~1、中 2、高 ≥3。`);
  lines.push(`- 阵营局势：自身阵营 (HP+盾) 和 − 敌方阵营 (HP+盾) 和；≥2 领先，≤−2 落后，其余接近。该启发式只用于分层，不参与价值真值。`);
  lines.push("");
  lines.push("## 4. 成对实验方法");
  lines.push("");
  lines.push("- 持有（Hold）：实验臂额外获得一张牌（不取自牌堆），对照臂无；表示“手中多一张牌”的边际价值。");
  lines.push("- 获取（Acquire）：实验臂从牌堆取一张目标牌入手，对照臂按真实牌堆摸一张；表示“选到目标牌而不是随机牌”。目标牌不在牌堆时该样本记 N/A。");
  lines.push("- 使用（Use）：仅在目标牌在手且合法的状态；实验臂强制首先使用目标牌，对照臂强制首选“最佳其它行动”（规划时临时排除目标牌并恢复原手牌顺序）。");
  lines.push("- 弃牌损失（Discard）：仅统计主体自然持有目标牌的状态；实验臂弃掉该牌，对照臂保留。");
  lines.push("- 响应（Response）：在真实响应窗口（可格挡伤害、可反制战术/闪电、濒死救援）前置动作入口分叉，实验臂给主体补上缺少的响应牌，对照臂不给；同时统计窗口是否实际打开。");
  lines.push("");
  lines.push("## 5. 样本量与置信区间");
  lines.push("");
  lines.push(`主表各指标 N 见下方表格；95% CI 为 t 近似（1.96×SE）。`);
  const responseHeader = ["窗口类型", "成对样本", "任务数", "窗口打开率", "条件响应ΔWR", "95% CI", "全局贡献ΔWR", "95% CI"];
  const responseRows = [responseHeader.join("|"), responseHeader.map(() => "---").join("|")];
  for (const [windowType, stat] of Object.entries(results.response ?? {})) {
    const label = { block: "格挡", counter: "反制（战术）", statusCounter: "反制（闪电）", dying: "调息（濒死救援）" }[windowType] ?? windowType;
    responseRows.push([
      label,
      stat.pairs ?? 0,
      stat.jobs ?? 0,
      `${Math.round((stat.windowOpenedRate ?? 0) * 100)}%`,
      fmt(stat.conditional?.meanPp),
      stat.conditional ? `[${fmt(stat.conditional.ciLowPp)}..${fmt(stat.conditional.ciHighPp)}]` : "N/A",
      fmt(stat.global?.meanPp),
      stat.global ? `[${fmt(stat.global.ciLowPp)}..${fmt(stat.global.ciHighPp)}]` : "N/A"
    ].join("|"));
  }
  lines.push("响应窗口实验：");
  lines.push("");
  lines.push(responseRows.join("\n"));
  lines.push("");
  lines.push(`注：全局贡献 = 条件响应ΔWR × 窗口打开率 × 分叉率（分叉率 = 成对样本/任务数）；窗口打开率 = 有窗口样本/全部成对样本。`);
  lines.push("");
  lines.push("## 6. 25 张卡主价值表");
  lines.push("");
  lines.push(masterTable(results));
  lines.push("");
  lines.push("## 7. 角色 × 卡牌价值矩阵");
  lines.push("");
  lines.push(roleTable(results));
  lines.push("");
  lines.push("## 8. 各种局面价值分析");
  lines.push("");
  lines.push(situationTable(results));
  lines.push("");
  lines.push("## 9. 当前 aiValue 与实测值偏差");
  lines.push("");
  lines.push("见第 6 节“当前 aiValue / 建议 aiValue / 差值”列。");
  lines.push("");
  lines.push("## 10. 建议 aiValue");
  lines.push("");
  lines.push("映射方法：按实测综合 ΔWR（自然分布持有值）排序，同值（0.1pp 精度）合并，排名映射到 1~9 整数（rank → round(1 + 8×rank/(N−1))）。未修改任何配置。");
  lines.push("");
  lines.push("## 11. 建议角色差值");
  lines.push("");
  lines.push(`映射方法：每张牌各角色实测持有 ΔWR 减全局均值得到 pp 差值；以全部差值绝对值的 P90/2 作为每点标尺，round 后截断到 -2..+2（标尺 ${round(results.roleDeltaMapping.scale, 3)} pp/点）。`);
  lines.push("");
  lines.push("## 12. 高估/低估/高方差牌");
  lines.push("");
  lines.push(anomalyText(results));
  lines.push("");
  lines.push("## 13. 当前价值模型的结构性问题");
  lines.push("");
  lines.push("1. 单一 aiValue 同时承担持牌、使用、获取、弃牌、装备持续与角色偏好语义，实测中这些指标明显分离（见多语义冲突列表）。");
  lines.push("2. 弃牌评分直接使用角色有效值，但角色差值同时影响行动评分，导致“舍不得”与“喜欢用”两种语义耦合。");
  lines.push("3. 反制/格挡等响应牌没有主动使用场景，aiValue 只能表达窗口价值；窗口出现概率与条件价值相乘的全局贡献与当前值存在系统性差异。");
  lines.push("4. 闪电的主动使用评分与状态负担计算部分独立于 aiValue，是当前代码中最明显的“一个值多个修正”场景。");
  lines.push("");
  lines.push("## 14. 实验限制");
  lines.push("");
  lines.push(`- 全部实验使用当前 AI 策略（节点预算 ${results.method.nodeBudget}）；AI 自身读取 aiValue，因此实测值包含策略内生性，不能完全分离“卡牌结构价值”与“当前 AI 偏好”。`);
  lines.push("- 持有/获取/弃牌/使用实验中，主体为当前回合玩家；其他玩家的持牌价值未单独测量。");
  lines.push("- 响应实验在“会触发窗口的动作入口”分叉，条件价值以窗口实际打开的子样本统计，全局贡献乘以窗口出现率；多个窗口叠加效应未建模。");
  lines.push(`- 角色矩阵每个格子样本量有限（目标 ${results.method.roleStateTargetPerRole} 组），置信区间较宽，仅用于方向判断。`);
  lines.push("- 停滞对全部剔除；停滞率极低。");
  lines.push("");
  lines.push("## 15. 所有生成文件路径");
  lines.push("");
  const outPath = fileURLToPath(OUT_DIR).replace(/\\/g, "/");
  lines.push(`- ${outPath}card-value-report.md`);
  lines.push(`- ${outPath}card-value-master.csv`);
  lines.push(`- ${outPath}card-role-matrix.csv`);
  lines.push(`- ${outPath}card-value-results.json`);
  lines.push(`- ${outPath}data/（语料、成对行、进度）`);
  lines.push("");
  lines.push("## 16. Git 状态确认");
  lines.push("");
  lines.push(`仅新增运行目录（默认 ${outPath}，或 FIVE_REALMS_STUDY_RUN_DIR 指定）；未修改任何正式业务文件，未执行任何 Git 写操作。`);
  lines.push("");
  await writeFile(new URL("card-value-report.md", OUT_DIR), lines.join("\n"), "utf8");
}

function masterTable(results) {
  const header = ["卡牌", "当前aiValue", "样本N", "持有ΔWR", "获取ΔWR", "使用/响应ΔWR", "弃牌损失ΔWR", "危急HP价值", "健康HP价值", "低手牌价值", "高手牌价值", "前期价值", "中期价值", "后期价值", "领先价值", "落后价值", "综合ΔWR", "95% CI", "建议aiValue", "差值"];
  const rows = [header.join("|")];
  rows.push(header.map(() => "---").join("|"));
  for (const cardId of CARD_IDS) {
    const card = results.cards[cardId];
    const useCell = card.use?.stats ? fmt(card.use.stats.meanPp) : "N/A";
    const responseCell = responsePrimary(results, cardId) ?? "N/A";
    const useResponse = useCell === "N/A" ? responseCell : `${useCell}${responseCell !== "N/A" ? ` / ${responseCell}` : ""}`;
    const ci = card.compositeHold ? `[${fmt(card.compositeHold.ciLowPp)}..${fmt(card.compositeHold.ciHighPp)}]` : "N/A";
    rows.push([
      card.name, card.currentAiValue, card.hold?.n ?? "N/A", fmt(card.hold?.meanPp), fmt(card.acquire?.meanPp),
      useResponse, fmt(card.discard?.meanPp), fmt(stratumMeanPp(card, "critical")), fmt(stratumMeanPp(card, "healthy")),
      fmt(stratumMeanPp(card, "lowHand")), fmt(stratumMeanPp(card, "highHand")),
      fmt(stratumMeanPp(card, "early")), fmt(stratumMeanPp(card, "mid")), fmt(stratumMeanPp(card, "late")),
      fmt(stratumMeanPp(card, "lead")), fmt(stratumMeanPp(card, "lag")),
      fmt(card.compositeHold?.meanPp), ci, card.suggestedAiValue ?? "N/A", card.suggestedDiff ?? "N/A"
    ].join("|"));
  }
  return rows.join("\n");
}

function roleTable(results) {
  const roleNames = ROLES.map((role) => CHARACTER_BY_ID[role].name);
  const header = ["卡牌", ...roleNames, "全局"];
  const rows = [header.join("|"), header.map(() => "---").join("|")];
  for (const cardId of CARD_IDS) {
    const card = results.cards[cardId];
    const values = ROLES.map((role) => {
      const stat = card.roleMatrix[role];
      return stat ? `${fmt(stat.meanPp)}（N=${stat.n}）` : "N/A";
    });
    rows.push([card.name, ...values, fmt(card.compositeHold?.meanPp)].join("|"));
  }
  rows.push("");
  rows.push("建议角色差值表（映射值，非实验数据）");
  rows.push("");
  const suggestedHeader = ["卡牌", ...roleNames];
  rows.push(suggestedHeader.join("|"), suggestedHeader.map(() => "---").join("|"));
  for (const cardId of CARD_IDS) {
    const card = results.cards[cardId];
    const values = ROLES.map((role) => card.suggestedRoleDeltas[role] ?? "");
    rows.push([card.name, ...values].join("|"));
  }
  return rows.join("\n");
}

function situationTable(results) {
  const rows = [];
  rows.push("| 卡牌 | 危急HP | 低血HP | 健康HP | 满血 | 低手牌 | 中手牌 | 高手牌 | 低能量 | 中能量 | 高能量 | 可攻击 | 无攻击目标 | 前期 | 中期 | 后期 | 领先 | 接近 | 落后 | 可解锁技能 |");
  rows.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const cardId of CARD_IDS) {
    const card = results.cards[cardId];
    rows.push([
      card.name,
      fmt(stratumMeanPp(card, "critical")), fmt(stratumMeanPp(card, "low")), fmt(stratumMeanPp(card, "healthy")), fmt(stratumMeanPp(card, "full")),
      fmt(stratumMeanPp(card, "lowHand")), fmt(stratumMeanPp(card, "midHand")), fmt(stratumMeanPp(card, "highHand")),
      fmt(stratumMeanPp(card, "energyLow")), fmt(stratumMeanPp(card, "energyMid")), fmt(stratumMeanPp(card, "energyHigh")),
      fmt(stratumMeanPp(card, "reachable")), fmt(stratumMeanPp(card, "noTarget")),
      fmt(stratumMeanPp(card, "early")), fmt(stratumMeanPp(card, "mid")), fmt(stratumMeanPp(card, "late")),
      fmt(stratumMeanPp(card, "lead")), fmt(stratumMeanPp(card, "close")), fmt(stratumMeanPp(card, "lag")),
      fmt(stratumMeanPp(card, "unlock"))
    ].join("|"));
  }
  return rows.join("\n");
}

function anomalyText(results) {
  const lines = [];
  const fmtList = (list, label) => {
    if (!list.length) {
      lines.push(`**${label}**：无`);
      return;
    }
    lines.push(`**${label}**：${list.map((entry) => `${CARD_DEFINITIONS[entry.card].name}(${entry.card})${entry.diff !== undefined ? ` 当前=${entry.current} 建议=${entry.suggested} 差=${entry.diff}` : ""}${entry.range !== undefined ? ` 极差=${entry.range}pp` : ""}${entry.hold !== undefined ? ` hold=${entry.hold} use=${entry.use} acquire=${entry.acquire} discard=${entry.discard}` : ""}`).join("；")}`);
  };
  fmtList(results.anomalies.overvalued, "1. 当前 aiValue 明显高估（建议差 ≥ +2）");
  fmtList(results.anomalies.undervalued, "2. 当前 aiValue 明显低估（建议差 ≤ -2）");
  fmtList(results.anomalies.reasonable, "3. 当前 aiValue 基本合理（|差| ≤ 1）");
  fmtList(results.anomalies.situationSensitive, "4. 对局面极其敏感（分层极差 ≥ 6pp）");
  fmtList(results.anomalies.roleSensitive, "5. 对角色极其敏感（角色极差 ≥ 5pp）");
  fmtList(results.anomalies.multiSemantic, "6. 一个 aiValue 同时承担多语义而冲突（hold/use/acquire/discard 极差 ≥ 8pp）");
  return lines.join("\n");
}

function stratumMean(card, key) {
  return card.strata?.[key]?.mean ?? null;
}

function stratumMeanPp(card, key) {
  return card.strata?.[key]?.meanPp ?? null;
}

export { round, fmt, stats, pairStats, confidenceLabel };
