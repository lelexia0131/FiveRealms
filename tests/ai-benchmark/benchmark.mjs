/**
 * AI Benchmark 核心：Scenario 注册、执行、评分与聚合。
 *
 * 评分原则：
 * - 每个 Scenario 由"专家评分函数"给出 0.00 ~ 1.00 的质量分；
 * - 质量分评价的是 AI 在给定局面下的行为（生成/选择/目标），不是源码复杂度；
 * - 每个模块内平均质量 × 模块满分，九个模块总和严格为 1000。
 */
import { makeGame, runAiDecision, describeAction, disposeGame, hashSeed } from "./helpers.mjs";

export const CATEGORIES = Object.freeze({
  // 基础能力：只证明"知道规则 / 会使用 / 动作合法"，权重被刻意压低。
  basicRules: { id: "basicRules", label: "Basic Rules & Legality", max: 40 },
  basicCards: { id: "basicCards", label: "Basic Card Knowledge", max: 50 },
  basicSkills: { id: "basicSkills", label: "Basic Skill Knowledge", max: 50 },
  // 智能能力：时机、价值、边界、协同、规划、概率。
  resources: { id: "resources", label: "Numerical & Resource Reasoning", max: 110 },
  board: { id: "board", label: "Board / Threat Reasoning", max: 120 },
  synergy: { id: "synergy", label: "Card-Skill Synergy", max: 140 },
  combos: { id: "combos", label: "Tactics & Action Ordering", max: 170 },
  probability: { id: "probability", label: "Hidden Info & Probability", max: 110 },
  planning: { id: "planning", label: "Multi-step Planning", max: 180 },
  counterfactual: { id: "counterfactual", label: "Counterfactual Adaptation", max: 30 }
});

export const CATEGORY_TOTAL = Object.values(CATEGORIES).reduce((sum, category) => sum + category.max, 0);

/** 稳定性模块不再计入总分；作为独立诊断输出。 */
export const STABILITY_DIAGNOSTIC_CATEGORY = "stability";

if (CATEGORY_TOTAL !== 1000) {
  throw new Error(`AI Benchmark 总分必须为 1000，当前配置为 ${CATEGORY_TOTAL}`);
}

const scenarioRegistry = [];

/**
 * 注册一个 Scenario。
 *
 * @param {Object} scenario
 * @param {string} scenario.id 唯一 ID（用于种子与报告）
 * @param {string} scenario.name 显示名
 * @param {keyof CATEGORIES} scenario.category 模块
 * @param {number} [scenario.depth] 规划深度级别 1~4（诊断用）
 * @param {number} [scenario.runs] 重复运行次数（稳定性场景）
 * @param {Function} scenario.setup 返回 { players, options }
 * @param {Function} scenario.grade 返回 { score, reason }；接收
 *   { action, legalActions, stats, player, game, runIndex, seeds }
 */
export function registerScenario(scenario) {
  if (!scenario?.id || !scenario?.name || !scenario?.category || !scenario?.setup || !scenario?.grade) {
    throw new Error(`Scenario 定义不完整：${scenario?.id ?? "<unknown>"}`);
  }
  if (!CATEGORIES[scenario.category] && scenario.category !== STABILITY_DIAGNOSTIC_CATEGORY) {
    throw new Error(`Scenario ${scenario.id} 使用了未知模块：${scenario.category}`);
  }
  const runs = Math.max(1, Math.floor(Number(scenario.runs) || 1));
  const seeds = Array.from({ length: runs }, (_, index) => hashSeed(`${scenario.id}:${index}`));
  scenarioRegistry.push({
    ...scenario,
    runs,
    seeds,
    baseSeed: hashSeed(scenario.id),
    depth: Math.max(1, Math.min(4, Number(scenario.depth) || 1)),
    family: scenario.family ?? null,
    expectedClass: scenario.expectedClass ?? null
  });
}

export function listScenarios() {
  return [...scenarioRegistry];
}

/** 对单个 Scenario 执行 runs 次并聚合。 */
export async function runScenario(scenario, runOptions = {}) {
  const results = [];
  for (let runIndex = 0; runIndex < scenario.runs; runIndex += 1) {
    // 默认使用固定 Scenario seed（可重复）；--seed 会通过 globalSeed 混合进去。
    const globalSeed = Number(runOptions.globalSeed) || 0;
    const runSeed = globalSeed
      ? hashSeed(`${scenario.id}:${runIndex}:g${globalSeed}`)
      : scenario.seeds[runIndex];
    const prepared = scenario.setup({ runIndex, seeds: scenario.seeds, seed: runSeed });
    const game = makeGame(prepared, {
      nodeBudget: runOptions.nodeBudget ?? null,
      seed: runSeed
    });
    try {
      const decision = await runAiDecision(game, prepared.options?.actorId);
      const gradeResult = scenario.grade({
        action: decision.action,
        legalActions: decision.legalActions,
        stats: decision.stats,
        player: decision.player,
        game,
        runIndex,
        seeds: scenario.seeds
      });
      const quality = Number(gradeResult?.score ?? 0);
      results.push({
        runIndex,
        seed: scenario.seeds[runIndex],
        quality: Math.max(0, Math.min(1, quality)),
        reason: gradeResult?.reason ?? "",
        action: describeAction(decision.action),
        depth: decision.stats?.depth ?? 1,
        expanded: decision.stats?.expanded ?? 0,
        elapsedMs: decision.stats?.elapsedMs ?? 0,
        bestSequence: decision.stats?.bestSequence ?? [],
        baselineAction: null
      });
    } finally {
      disposeGame(game);
    }
  }

  const quality = results.reduce((sum, result) => sum + result.quality, 0) / results.length;
  const bestQuality = Math.max(...results.map((result) => result.quality));
  const worstQuality = Math.min(...results.map((result) => result.quality));
  const stability = results.length > 1
    ? results.filter((result) => result.quality >= Math.max(0.5, bestQuality - 0.35)).length / results.length
    : 1;
  // 稳定性模块：最终得分 = 平均质量 × 一致性（防止“每局都好但每次选择都不同”刷分）。
  const isStabilityDiagnostic = scenario.category === STABILITY_DIAGNOSTIC_CATEGORY;
  const score = isStabilityDiagnostic ? 0 : quality;

  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    depth: scenario.depth,
    family: scenario.family,
    expectedClass: scenario.expectedClass,
    runs: scenario.runs,
    seeds: scenario.seeds,
    quality,
    score,
    stability,
    bestQuality,
    worstQuality,
    results,
    errors: results.filter((result) => result.quality <= 0.05).map((result) => result.reason)
  };
}

/** 运行指定（或全部）Scenario，返回聚合结果。 */
export async function runBenchmark({ categories = null, verbose = false, onScenario = null, nodeBudget = null, globalSeed = null, baselineModule = null } = {}) {
  const scenarios = listScenarios().filter((scenario) => (
    !categories || categories.has(scenario.category)
  ));
  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, { nodeBudget, globalSeed });
    results.push(result);
    onScenario?.(result);
  }
  const aggregate = aggregateResults(results);
  if (baselineModule) {
    const baselineResults = [];
    for (const scenario of scenarios) {
      if (scenario.category === STABILITY_DIAGNOSTIC_CATEGORY) continue;
      const prepared = scenario.setup({ runIndex: 0, seeds: scenario.seeds, seed: scenario.seeds[0] });
      const game = makeGame(prepared, { nodeBudget, seed: scenario.seeds[0] });
      try {
        const baselineAction = baselineModule.selectGreedy(game, prepared.options?.actorId);
        const depth1Action = baselineModule.selectGreedyDepth1
          ? baselineModule.selectGreedyDepth1(game, prepared.options?.actorId)
          : null;
        const legalForGrade = game.aiController.getLegalActions(game.state.players.find((p) => p.id === prepared.options?.actorId));
        const playerForGrade = game.state.players.find((p) => p.id === prepared.options?.actorId);
        const gradeResult = scenario.grade({
          action: baselineAction,
          legalActions: legalForGrade,
          stats: null,
          player: playerForGrade,
          game,
          runIndex: 0,
          seeds: scenario.seeds
        });
        const depth1Grade = depth1Action ? scenario.grade({
          action: depth1Action,
          legalActions: legalForGrade,
          stats: null,
          player: playerForGrade,
          game,
          runIndex: 0,
          seeds: scenario.seeds
        }) : null;
        baselineResults.push({
          id: scenario.id,
          category: scenario.category,
          quality: Math.max(0, Math.min(1, Number(gradeResult?.score ?? 0))),
          action: describeAction(baselineAction),
          depth1Quality: depth1Grade ? Math.max(0, Math.min(1, Number(depth1Grade.score ?? 0))) : null
        });
      } finally {
        disposeGame(game);
      }
    }
    // 直接按模块汇总脚本基线得分（不经过 aggregateResults，避免结构混用）。
    const baselineByCategory = {};
    for (const entry of baselineResults) {
      const bucket = baselineByCategory[entry.category] ??= { sum: 0, count: 0 };
      bucket.sum += entry.quality;
      bucket.count += 1;
    }
    let baselineTotal = 0;
    const baselineCategoryScores = {};
    for (const [categoryId, bucket] of Object.entries(baselineByCategory)) {
      const category = CATEGORIES[categoryId];
      if (!category) continue;
      const qualityValue = bucket.sum / bucket.count;
      baselineCategoryScores[categoryId] = {
        label: category.label,
        max: category.max,
        quality: qualityValue,
        score: qualityValue * category.max,
        scenarioCount: bucket.count
      };
      baselineTotal += qualityValue * category.max;
    }
    aggregate.baseline.total = baselineTotal;
    aggregate.baseline.categoryScores = baselineCategoryScores;
    aggregate.baseline.scenarioResults = baselineResults;
    aggregate.baseline.hasBaseline = true;
  }
  return aggregate;
}

/** 将 Scenario 结果聚合为模块分数与诊断。 */
export function aggregateResults(results) {
  const stabilityDiagnostics = results.filter((result) => result.category === STABILITY_DIAGNOSTIC_CATEGORY);
  const scoredResults = results.filter((result) => result.category !== STABILITY_DIAGNOSTIC_CATEGORY);

  const byCategory = {};
  for (const category of Object.values(CATEGORIES)) {
    byCategory[category.id] = { ...category, scenarios: [], score: 0 };
  }
  for (const result of scoredResults) {
    byCategory[result.category]?.scenarios.push(result);
  }

  const categoryScores = {};
  let total = 0;
  for (const [categoryId, entry] of Object.entries(byCategory)) {
    const scenarios = entry.scenarios;
    const quality = scenarios.length
      ? scenarios.reduce((sum, scenario) => sum + scenario.score, 0) / scenarios.length
      : 0;
    const score = quality * entry.max;
    categoryScores[categoryId] = {
      ...entry,
      quality,
      score,
      scenarioCount: scenarios.length
    };
    total += score;
  }

  // 规划深度诊断：按 D1~D4 级别统计达标比例（quality >= 0.7）。
  const depthStats = {};
  for (let depth = 1; depth <= 4; depth += 1) {
    const matching = scoredResults.filter((result) => result.depth === depth);
    depthStats[`D${depth}`] = matching.length
      ? {
          count: matching.length,
          pass: matching.filter((result) => result.score >= 0.7).length,
          rate: matching.filter((result) => result.score >= 0.7).length / matching.length
        }
      : { count: 0, pass: 0, rate: 0 };
  }

  // 搜索诊断汇总（仅诊断，不直接评分）。
  const searchStats = scoredResults.reduce((acc, result) => {
    const runs = result.results ?? [];
    acc.scenarios += runs.length;
    for (const run of runs) {
      acc.expanded += Number(run.expanded ?? 0) || 0;
      acc.elapsedMs += Number(run.elapsedMs ?? 0) || 0;
      acc.avgDepth += Number(run.depth ?? 1) || 1;
    }
    return acc;
  }, { scenarios: 0, expanded: 0, elapsedMs: 0, avgDepth: 0 });
  if (searchStats.scenarios) searchStats.avgDepth /= searchStats.scenarios;

  // 反事实 Family 诊断：同一 family 下，AI 是否在关键变量变化时调整行为。
  const familyGroups = new Map();
  for (const result of scoredResults) {
    if (!result.family) continue;
    if (!familyGroups.has(result.family)) {
      familyGroups.set(result.family, { family: result.family, scenarios: [] });
    }
    familyGroups.get(result.family).scenarios.push(result);
  }
  const familyStats = [];
  for (const group of familyGroups.values()) {
    const variants = group.scenarios;
    const withClass = variants.filter((scenario) => scenario.expectedClass);
    const classHit = withClass.filter((scenario) => {
      const chosenClass = classifyAction(scenario.results?.[0]?.action);
      return chosenClass === scenario.expectedClass;
    }).length;
    const avgQuality = variants.reduce((sum, scenario) => sum + scenario.score, 0) / variants.length;
    familyStats.push({
      family: group.family,
      variants: variants.length,
      classAware: withClass.length,
      classHit,
      classHitRate: withClass.length ? classHit / withClass.length : 0,
      avgQuality
    });
  }

  // 基线（脚本级贪心）诊断：如果提供 baseline 结果，计算其得分用于区分度说明。
  const baselineByCategory = {};
  for (const result of scoredResults) {
    const entry = baselineByCategory[result.category] ??= { scenarios: 0, qualitySum: 0 };
    entry.scenarios += 1;
    entry.qualitySum += Number(result.baselineQuality ?? 0);
  }
  let baselineTotal = 0;
  const baselineCategoryScores = {};
  for (const [categoryId, entry] of Object.entries(baselineByCategory)) {
    const category = CATEGORIES[categoryId];
    const quality = entry.scenarios ? entry.qualitySum / entry.scenarios : 0;
    baselineCategoryScores[categoryId] = {
      label: category.label,
      max: category.max,
      quality,
      score: quality * category.max,
      scenarioCount: entry.scenarios
    };
    baselineTotal += quality * category.max;
  }

  return {
    total,
    categoryScores,
    results,
    scoredResults,
    stabilityDiagnostics,
    depthStats,
    searchStats,
    familyStats,
    baseline: {
      total: baselineTotal,
      categoryScores: baselineCategoryScores,
      hasBaseline: scoredResults.some((result) => result.baselineAction != null)
    }
  };
}

/** 依据动作类型把 AI 选择映射为“行为类别”，用于反事实 Family 的适应度判断。 */
export function classifyAction(action) {
  if (!action) return "end";
  if (action.type === "end") return "end";
  if (action.type === "skill") return `skill:${action.cardId}`;
  return `card:${action.cardId}`;
}

/** 将总分映射到目标水平标尺。 */
export function levelForScore(total) {
  if (total >= 960) return "Extremely strong AI";
  if (total >= 930) return "Very strong AI";
  if (total >= 900) return "Expert-level";
  if (total >= 850) return "Strong-player level";
  if (total >= 800) return "Experienced-player level";
  if (total >= 700) return "Developing AI";
  if (total >= 600) return "Basic AI";
  return "Weak AI";
}
