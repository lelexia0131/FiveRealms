/**
 * AI Benchmark 核心：Scenario 注册、执行、评分与聚合。
 *
 * 评分原则：
 * - 每个 Scenario 由"专家评分函数"给出 0.00 ~ 1.00 的质量分；
 * - 质量分评价的是 AI 在给定局面下的行为（生成/选择/目标），不是源码复杂度；
 * - 每个模块内平均质量 × 模块满分，九个模块总和严格为 1000。
 */
import {
  makeGame, runAiDecision, describeAction, disposeGame, hashSeed
} from "./helpers.mjs";
import { agentModule } from "./baseline.mjs";

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

/** Agent 标识。 */
export const AGENTS = Object.freeze({
  production: "production",
  greedy: "greedy",
  random: "random"
});

export const AGENT_LABELS = Object.freeze({
  production: "Production AI",
  greedy: "Greedy / D1",
  random: "Random Legal"
});

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
    expectedClass: scenario.expectedClass ?? null,
    difficulty: scenario.difficulty ?? "basic",
    discrimination: scenario.discrimination ?? "legality",
    adversarial: scenario.adversarial ?? null
  });
}

export function listScenarios() {
  return [...scenarioRegistry];
}

/** 对单个 Scenario 执行 runs 次并聚合（支持多 Agent）。 */
export async function runScenario(scenario, runOptions = {}) {
  const agentIds = runOptions.agents ?? [AGENTS.production];
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
      const legalActions = game.aiController.getActionCandidates(
        game.state.players.find((p) => p.id === prepared.options?.actorId)
      );
      const player = game.state.players.find((p) => p.id === prepared.options?.actorId);
      const gradeContext = { legalActions, player, game, runIndex, seeds: scenario.seeds };
      // Random Expected（精确枚举）：grade 只依赖 action/target，不执行动作，
      // 因此可对全部合法动作求平均得到均匀随机的期望质量。
      let randomExpectedQuality = null;
      if (legalActions.length) {
        const grades = legalActions.map((action) => {
          const gradeResult = scenario.grade({ ...gradeContext, action, stats: null });
          return Math.max(0, Math.min(1, Number(gradeResult?.score ?? 0)));
        });
        randomExpectedQuality = grades.reduce((sum, value) => sum + value, 0) / grades.length;
      }
      const agentRuns = {};
      for (const agentId of agentIds) {
        let action;
        let stats = null;
        if (agentId === AGENTS.production) {
          const decision = await runAiDecision(game, prepared.options?.actorId);
          action = decision.action;
          stats = decision.stats;
        } else if (agentId === AGENTS.greedy) {
          action = agentModule.selectGreedy(game, prepared.options?.actorId);
        } else {
          const random = runOptions.randomForRun
            ? runOptions.randomForRun(runSeed, runIndex)
            : (() => 0.42);
          action = agentModule.selectRandomLegal(game, prepared.options?.actorId, random);
        }
        const gradeResult = scenario.grade({ ...gradeContext, action, stats });
        agentRuns[agentId] = {
          quality: Math.max(0, Math.min(1, Number(gradeResult?.score ?? 0))),
          reason: gradeResult?.reason ?? "",
          action: describeAction(action),
          stats
        };
      }
      results.push({
        runIndex,
        seed: scenario.seeds[runIndex],
        agents: agentRuns,
        randomExpectedQuality,
        legalActionCount: legalActions.length,
        depth: agentRuns[AGENTS.production]?.stats?.depth ?? 1,
        expanded: agentRuns[AGENTS.production]?.stats?.expanded ?? 0,
        elapsedMs: agentRuns[AGENTS.production]?.stats?.elapsedMs ?? 0,
        bestSequence: agentRuns[AGENTS.production]?.stats?.bestSequence ?? []
      });
    } finally {
      disposeGame(game);
    }
  }

  const agentQuality = {};
  for (const agentId of agentIds) {
    const values = results.map((result) => result.agents[agentId]?.quality ?? 0);
    agentQuality[agentId] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  const stability = results.length > 1
    ? results.filter((result) => {
        const values = agentIds.map((agentId) => result.agents[agentId]?.quality ?? 0);
        const max = Math.max(...values);
        return values.some((value) => value >= Math.max(0.5, max - 0.35));
      }).length / results.length
    : 1;
  const isStabilityDiagnostic = scenario.category === STABILITY_DIAGNOSTIC_CATEGORY;
  const score = isStabilityDiagnostic ? 0 : (agentQuality[AGENTS.production] ?? 0);
  const randomExpectedQuality = results.length
    ? results.reduce((sum, result) => sum + (result.randomExpectedQuality ?? 0), 0) / results.length
    : 0;

  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    depth: scenario.depth,
    family: scenario.family,
    expectedClass: scenario.expectedClass,
    difficulty: scenario.difficulty,
    discrimination: scenario.discrimination,
    adversarial: scenario.adversarial,
    runs: scenario.runs,
    seeds: scenario.seeds,
    quality: agentQuality[AGENTS.production] ?? 0,
    agentQuality,
    randomExpectedQuality,
    legalActionCounts: results.map((result) => result.legalActionCount ?? 0),
    score,
    stability,
    results,
    errors: results.filter((result) => (result.agents[AGENTS.production]?.quality ?? 0) <= 0.05)
      .map((result) => result.agents[AGENTS.production]?.reason ?? "")
  };
}

/** 运行指定（或全部）Scenario，返回聚合结果。 */
export async function runBenchmark({
  categories = null,
  verbose = false,
  onScenario = null,
  nodeBudget = null,
  globalSeed = null,
  agents = [AGENTS.production, AGENTS.greedy, AGENTS.random],
  randomForRun = null
} = {}) {
  const scenarios = listScenarios().filter((scenario) => (
    !categories || categories.has(scenario.category)
  ));
  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, { nodeBudget, globalSeed, agents, randomForRun });
    results.push(result);
    onScenario?.(result);
  }
  return aggregateResults(results);
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
    const classResults = withClass.map((scenario) => {
      const chosenClass = classifyAction(scenario.results?.[0]?.agents?.[AGENTS.production]?.action);
      return { scenario, chosenClass, hit: chosenClass === scenario.expectedClass };
    });
    const classHit = classResults.filter((entry) => entry.hit).length;
    const avgQuality = variants.reduce((sum, scenario) => sum + scenario.score, 0) / variants.length;
    familyStats.push({
      family: group.family,
      variants: variants.length,
      classAware: withClass.length,
      classHit,
      classHitRate: withClass.length ? classHit / withClass.length : 0,
      avgQuality,
      boundary: classifyBoundary(classResults)
    });
  }

  // ---- 多 Agent 聚合 ----
  const agentIds = Object.keys(AGENTS);
  const agentScores = {}; // agent -> 总分
  const agentCategoryScores = {}; // agent -> categoryId -> { score, quality }
  const agentMistakeCounts = {}; // agent -> level -> count
  for (const agentId of agentIds) {
    agentScores[agentId] = 0;
    agentCategoryScores[agentId] = {};
    agentMistakeCounts[agentId] = {};
  }
  for (const result of scoredResults) {
    const category = CATEGORIES[result.category];
    if (!category) continue;
    for (const agentId of agentIds) {
      const quality = result.agentQuality?.[agentId] ?? 0;
      const bucket = agentCategoryScores[agentId][result.category] ??= { sum: 0, count: 0 };
      bucket.sum += quality;
      bucket.count += 1;
      const level = qualityLevel(quality);
      agentMistakeCounts[agentId][level] = (agentMistakeCounts[agentId][level] ?? 0) + 1;
    }
  }
  for (const agentId of agentIds) {
    for (const [categoryId, bucket] of Object.entries(agentCategoryScores[agentId])) {
      const category = CATEGORIES[categoryId];
      const quality = bucket.sum / bucket.count;
      agentCategoryScores[agentId][categoryId] = {
        quality,
        score: quality * category.max,
        scenarioCount: bucket.count
      };
      agentScores[agentId] += quality * category.max;
    }
  }

  // 能力增益。
  const capabilityLift = {
    randomToGreedy: agentScores[AGENTS.greedy] - agentScores[AGENTS.random],
    greedyToProduction: agentScores[AGENTS.production] - agentScores[AGENTS.greedy],
    randomToProduction: agentScores[AGENTS.production] - agentScores[AGENTS.random]
  };

  // Greedy saturation（按模块）：Greedy / Production。
  const greedySaturation = {};
  for (const [categoryId, entry] of Object.entries(agentCategoryScores[AGENTS.production])) {
    const greedy = agentCategoryScores[AGENTS.greedy][categoryId];
    greedySaturation[categoryId] = entry.score > 0
      ? (greedy?.score ?? 0) / entry.score
      : 0;
  }
  greedySaturation.total = agentScores[AGENTS.production] > 0
    ? agentScores[AGENTS.greedy] / agentScores[AGENTS.production]
    : 0;

  // 难度分层（不同 Agent 的通过率）。
  const difficultyStats = {};
  for (const difficulty of ["basic", "intermediate", "advanced", "expert"]) {
    const matching = scoredResults.filter((result) => result.difficulty === difficulty);
    difficultyStats[difficulty] = {
      count: matching.length,
      agents: Object.fromEntries(agentIds.map((agentId) => [
        agentId,
        matching.length
          ? matching.filter((result) => (result.agentQuality?.[agentId] ?? 0) >= 0.7).length / matching.length
          : 0
      ]))
    };
  }

  // 对抗题分类统计。
  const adversarialStats = {};
  for (const result of scoredResults) {
    if (!result.adversarial) continue;
    const entry = adversarialStats[result.adversarial] ??= { count: 0, agents: {} };
    entry.count += 1;
    for (const agentId of agentIds) {
      entry.agents[agentId] ??= { pass: 0 };
      if ((result.agentQuality?.[agentId] ?? 0) >= 0.7) entry.agents[agentId].pass += 1;
    }
  }
  for (const entry of Object.values(adversarialStats)) {
    for (const [agentId, value] of Object.entries(entry.agents)) {
      value.rate = entry.count ? value.pass / entry.count : 0;
    }
  }

  // Planning Lift over D1（按场景集合）。
  const planningLift = computePlanningLift(scoredResults, agentIds);

  // ---- Chance-Corrected Scoring ----
  // C = (P - R) / (1 - R)，其中 P=Agent raw quality，R=Random Legal Expected。
  // R >= 0.99 的场景无区分度，不参与 corrected 计分（仍参与 raw）。
  const chanceCorrected = computeChanceCorrected(scoredResults);

  // ---- Planner Effectiveness Audit ----
  const plannerAudit = computePlannerAudit(scoredResults);

  // ---- Chance Floor 分布 ----
  const chanceFloorDistribution = { "0.00-0.20": 0, "0.20-0.40": 0, "0.40-0.60": 0, "0.60-0.80": 0, "0.80-1.00": 0 };
  const chanceFloorSummary = { mean: 0, median: 0, over50: 0, over70: 0, over90: 0, highScenarios: [] };
  const floors = scoredResults.map((result) => result.randomExpectedQuality ?? 0);
  if (floors.length) {
    chanceFloorSummary.mean = floors.reduce((sum, value) => sum + value, 0) / floors.length;
    const sorted = [...floors].sort((a, b) => a - b);
    chanceFloorSummary.median = sorted[Math.floor(sorted.length / 2)];
    for (const result of scoredResults) {
      const floor = result.randomExpectedQuality ?? 0;
      const key = floor < 0.2 ? "0.00-0.20" : floor < 0.4 ? "0.20-0.40" : floor < 0.6 ? "0.40-0.60" : floor < 0.8 ? "0.60-0.80" : "0.80-1.00";
      chanceFloorDistribution[key] += 1;
      if (floor >= 0.5) chanceFloorSummary.over50 += 1;
      if (floor >= 0.7) chanceFloorSummary.over70 += 1;
      if (floor >= 0.9) chanceFloorSummary.over90 += 1;
    }
    chanceFloorSummary.highScenarios = scoredResults
      .filter((result) => (result.randomExpectedQuality ?? 0) >= 0.5)
      .sort((a, b) => (b.randomExpectedQuality ?? 0) - (a.randomExpectedQuality ?? 0))
      .slice(0, 12)
      .map((result) => ({
        id: result.id,
        name: result.name,
        floor: result.randomExpectedQuality,
        category: result.category,
        legalActions: Math.max(...(result.legalActionCounts ?? [1]))
      }));
  }

  // Random Legal Expected 总分（精确枚举，seed 无关）。
  let randomExpectedTotal = 0;
  const randomExpectedByCategory = {};
  for (const result of scoredResults) {
    const category = CATEGORIES[result.category];
    if (!category) continue;
    const floor = result.randomExpectedQuality ?? 0;
    const bucket = randomExpectedByCategory[result.category] ??= { sum: 0, count: 0 };
    bucket.sum += floor;
    bucket.count += 1;
  }
  for (const [categoryId, bucket] of Object.entries(randomExpectedByCategory)) {
    const category = CATEGORIES[categoryId];
    const quality = bucket.sum / bucket.count;
    randomExpectedByCategory[categoryId] = { score: quality * category.max, quality, scenarioCount: bucket.count };
    randomExpectedTotal += quality * category.max;
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
    agentScores,
    agentCategoryScores,
    capabilityLift,
    greedySaturation,
    difficultyStats,
    adversarialStats,
    agentMistakeCounts,
    planningLift,
    chanceCorrected,
    plannerAudit,
    chanceFloorDistribution,
    chanceFloorSummary,
    randomExpectedTotal,
    randomExpectedByCategory
  };
}

/** Chance-Corrected 聚合：按场景求 C，再按模块平均（R>=0.99 场景排除）。 */
function computeChanceCorrected(scoredResults) {
  const valid = scoredResults.filter((result) => (result.randomExpectedQuality ?? 0) < 0.99);
  const correctedScenarios = valid.map((result) => {
    const floor = result.randomExpectedQuality ?? 0;
    const correctedFor = (agentId) => {
      const raw = result.agentQuality?.[agentId] ?? 0;
      if (floor >= 0.99) return null;
      const denominator = 1 - floor;
      if (denominator <= 1e-9) return null;
      const corrected = (raw - floor) / denominator;
      return { raw, corrected, belowChance: raw < floor - 1e-9 };
    };
    return {
      id: result.id,
      category: result.category,
      difficulty: result.difficulty,
      floor,
      greedy: correctedFor(AGENTS.greedy),
      production: correctedFor(AGENTS.production)
    };
  });

  const byModule = {};
  for (const entry of correctedScenarios) {
    const bucket = byModule[entry.category] ??= { sumGreedy: 0, sumProduction: 0, count: 0 };
    if (entry.greedy && entry.greedy.corrected != null) bucket.sumGreedy += Math.max(0, entry.greedy.corrected);
    if (entry.production && entry.production.corrected != null) bucket.sumProduction += Math.max(0, entry.production.corrected);
    bucket.count += 1;
  }

  let greedyTotal = 0;
  let productionTotal = 0;
  const moduleCorrected = {};
  for (const [categoryId, bucket] of Object.entries(byModule)) {
    const category = CATEGORIES[categoryId];
    if (!category) continue;
    const greedyAvg = bucket.count ? bucket.sumGreedy / bucket.count : 0;
    const productionAvg = bucket.count ? bucket.sumProduction / bucket.count : 0;
    moduleCorrected[categoryId] = {
      label: category.label,
      max: category.max,
      greedyScore: greedyAvg * category.max,
      productionScore: productionAvg * category.max,
      scenarioCount: bucket.count
    };
    greedyTotal += greedyAvg * category.max;
    productionTotal += productionAvg * category.max;
  }

  const belowChance = correctedScenarios.filter((entry) => entry.production?.belowChance);
  return {
    greedyTotal,
    productionTotal,
    moduleCorrected,
    belowChanceCount: belowChance.length,
    belowChanceScenarios: belowChance
      .map((entry) => ({
        id: entry.id,
        category: entry.category,
        floor: entry.floor,
        productionRaw: entry.production?.raw,
        difference: (entry.production?.raw ?? 0) - entry.floor
      }))
      .sort((a, b) => a.difference - b.difference)
      .slice(0, 10),
    excludedNoDiscrimination: scoredResults.length - valid.length
  };
}

/** Planner Effectiveness：逐场景比较 Production vs Greedy 质量。 */
function computePlannerAudit(scoredResults) {
  const compare = (result) => {
    const greedy = result.agentQuality?.[AGENTS.greedy] ?? 0;
    const production = result.agentQuality?.[AGENTS.production] ?? 0;
    if (production > greedy + 1e-9) return "win";
    if (production < greedy - 1e-9) return "regression";
    return "neutral";
  };
  const groups = {
    all: scoredResults,
    intelligent: scoredResults.filter((result) => !["basicRules", "basicCards", "basicSkills"].includes(result.category)),
    planning: scoredResults.filter((result) => result.category === "planning"),
    adversarial: scoredResults.filter((result) => result.adversarial),
    "cross-turn": scoredResults.filter((result) => result.adversarial === "cross-turn"),
    "response-bait": scoredResults.filter((result) => result.adversarial === "response-bait"),
    setup: scoredResults.filter((result) => ["setup", "immediate-reward"].includes(result.adversarial))
  };
  const byGroup = {};
  for (const [groupName, scenarios] of Object.entries(groups)) {
    const wins = scenarios.filter((result) => compare(result) === "win").length;
    const regressions = scenarios.filter((result) => compare(result) === "regression").length;
    const neutral = scenarios.length - wins - regressions;
    const netLift = scenarios.length
      ? (scenarios.reduce((sum, result) => sum + ((result.agentQuality?.[AGENTS.production] ?? 0) - (result.agentQuality?.[AGENTS.greedy] ?? 0)), 0)
        / scenarios.length * 100)
      : 0;
    byGroup[groupName] = {
      count: scenarios.length,
      wins,
      neutral,
      regressions,
      winRate: scenarios.length ? wins / scenarios.length : 0,
      regressionRate: scenarios.length ? regressions / scenarios.length : 0,
      netLiftPp: netLift
    };
  }
  const byDifficulty = {};
  for (const difficulty of ["basic", "intermediate", "advanced", "expert"]) {
    const scenarios = scoredResults.filter((result) => result.difficulty === difficulty);
    byDifficulty[difficulty] = scenarios.length
      ? {
          count: scenarios.length,
          greedyQuality: scenarios.reduce((sum, result) => sum + (result.agentQuality?.[AGENTS.greedy] ?? 0), 0) / scenarios.length,
          productionQuality: scenarios.reduce((sum, result) => sum + (result.agentQuality?.[AGENTS.production] ?? 0), 0) / scenarios.length,
          plannerLiftPp: (scenarios.reduce((sum, result) => sum + ((result.agentQuality?.[AGENTS.production] ?? 0) - (result.agentQuality?.[AGENTS.greedy] ?? 0)), 0)
            / scenarios.length * 100)
        }
      : { count: 0, greedyQuality: 0, productionQuality: 0, plannerLiftPp: 0 };
  }
  const comparisons = scoredResults.map((result) => ({
    id: result.id,
    name: result.name,
    category: result.category,
    difficulty: result.difficulty,
    adversarial: result.adversarial ?? null,
    greedy: result.agentQuality?.[AGENTS.greedy] ?? 0,
    production: result.agentQuality?.[AGENTS.production] ?? 0,
    difference: (result.agentQuality?.[AGENTS.production] ?? 0) - (result.agentQuality?.[AGENTS.greedy] ?? 0),
    status: compare(result),
    greedyAction: result.results?.[0]?.agents?.[AGENTS.greedy]?.action ?? null,
    productionAction: result.results?.[0]?.agents?.[AGENTS.production]?.action ?? null
  }));
  return {
    byGroup,
    byDifficulty,
    comparisons,
    topWins: comparisons.filter((entry) => entry.status === "win").sort((a, b) => b.difference - a.difference).slice(0, 8),
    topRegressions: comparisons.filter((entry) => entry.status === "regression").sort((a, b) => a.difference - b.difference).slice(0, 10)
  };
}

/**
 * Counterfactual 决策边界质量。
 * 只有当 family 内存在"应当改变行为"的变体梯度时才有意义：
 * - Correct adaptation：所有变体行为类别均符合预期；
 * - Partial adaptation：部分变体符合（敏感但不完整）；
 * - No adaptation：预期应变化但 AI 全程不变；
 * - Erratic adaptation：行为类别乱跳（对无关变化过度敏感）；
 * - N/A：变体不足或没有类别梯度。
 */
function classifyBoundary(classResults) {
  if (classResults.length < 2) return "N/A";
  const distinctExpected = new Set(classResults.map((entry) => entry.scenario.expectedClass)).size;
  if (distinctExpected < 2) return "N/A";
  const hitCount = classResults.filter((entry) => entry.hit).length;
  const distinctChosen = new Set(classResults.map((entry) => entry.chosenClass)).size;
  if (hitCount === classResults.length) return "Correct adaptation";
  if (hitCount === 0) return distinctChosen === 1 ? "No adaptation" : "Erratic adaptation";
  return distinctChosen > 2 ? "Erratic adaptation" : "Partial adaptation";
}

/** 质量分 -> 离散等级。 */
export function qualityLevel(quality) {
  if (quality >= 1.0 - 1e-9) return "Optimal";
  if (quality >= 0.7) return "Strong";
  if (quality >= 0.5) return "Acceptable";
  if (quality >= 0.25) return "Poor";
  if (quality > 0) return "Severe";
  return "Catastrophic";
}

/** Planning Lift：真实 AI 与 Greedy/D1 在指定题集上的质量差（百分点）。 */
function computePlanningLift(scoredResults, agentIds) {
  const sets = {
    all: scoredResults,
    planning: scoredResults.filter((result) => result.category === "planning"),
    adversarialPlanning: scoredResults.filter((result) => result.adversarial && result.discrimination === "planning")
  };
  const result = {};
  for (const [key, scenarios] of Object.entries(sets)) {
    result[key] = scenarios.length
      ? (scenarios.reduce((sum, s) => sum + (s.agentQuality?.[AGENTS.production] ?? 0), 0)
        - scenarios.reduce((sum, s) => sum + (s.agentQuality?.[AGENTS.greedy] ?? 0), 0))
        / scenarios.length * 100
      : 0;
  }
  return result;
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
