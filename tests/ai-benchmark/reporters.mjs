/**
 * 终端报告（v0.3）：多 Agent 标定、能力增益、模块对比、决策质量、
 * Greedy saturation 警告、难度分层、对抗题统计、规划诊断与最终结论。
 * 所有结论均来自实际 Scenario 结果。
 */
import { levelForScore, CATEGORIES, AGENTS, AGENT_LABELS, qualityLevel } from "./benchmark.mjs";

const pct = (value) => `${(value * 100).toFixed(0)}%`;

const AGENT_ORDER = [AGENTS.random, AGENTS.greedy, AGENTS.production];

function moduleLines(categoryScores) {
  const entries = Object.values(categoryScores);
  const width = Math.max(...entries.map((entry) => entry.label.length));
  return entries.map((entry) => {
    const label = entry.label.padEnd(width);
    return `  ${label}  ${entry.score.toFixed(0).padStart(3)} / ${entry.max}`;
  });
}

function strengthLines(categoryScores, results) {
  const strongCategories = Object.values(categoryScores)
    .filter((entry) => entry.scenarioCount > 0 && entry.quality >= 0.75)
    .sort((left, right) => right.quality - left.quality);
  if (!strongCategories.length) return ["  （暂无模块达到 75% 质量线）"];
  return strongCategories.map((entry) => {
    const top = [...entry.scenarios].sort((left, right) => right.score - left.score)[0];
    return `  - ${entry.label}: ${(entry.quality * 100).toFixed(0)}% 质量（${entry.scenarioCount} 个 Scenario，代表：${top?.name ?? "-"}）`;
  });
}

function weaknessLines(categoryScores, results) {
  const weakCategories = Object.values(categoryScores)
    .filter((entry) => entry.scenarioCount > 0 && entry.quality < 0.6)
    .sort((left, right) => left.quality - right.quality);
  const weakScenarios = results
    .filter((result) => result.category !== "stability" && result.score < 0.5)
    .sort((left, right) => left.score - right.score);
  if (!weakCategories.length && !weakScenarios.length) {
    return ["  （本版未发现明显弱点模块）"];
  }
  const lines = [];
  for (const entry of weakCategories) {
    lines.push(`  - ${entry.label}: 仅 ${(entry.quality * 100).toFixed(0)}% 质量（${entry.scenarioCount} 个 Scenario）`);
  }
  for (const scenario of weakScenarios.slice(0, 12)) {
    lines.push(`    · ${scenario.name}: ${(scenario.score * 100).toFixed(0)} 分 — ${scenario.results?.[0]?.agents?.[AGENTS.production]?.reason ?? ""}`);
  }
  return lines;
}

function keyDeductionLines(results, limit = 8) {
  const worst = results
    .filter((result) => result.category !== "stability")
    .sort((left, right) => left.score - right.score).slice(0, limit);
  if (!worst.length) return ["  （无 Scenario 数据）"];
  return worst.map((scenario) => {
    const category = CATEGORIES[scenario.category];
    return `  - [${category?.label ?? scenario.category}] ${scenario.name}`
      + `：${(scenario.score * 100).toFixed(0)} 分`
      + (scenario.results?.[0]?.agents?.[AGENTS.production]?.reason ? `（${scenario.results[0].agents[AGENTS.production].reason}）` : "");
  });
}

function depthLines(depthStats) {
  return ["D1", "D2", "D3", "D4"].map((key) => {
    const entry = depthStats[key] ?? { count: 0, pass: 0, rate: 0 };
    return `  ${key}-set: ${pct(entry.rate)}（${entry.pass}/${entry.count} 个达标 Scenario）`;
  });
}

function scenarioSummaryLines(results, limit = 10) {
  const strong = results.filter((result) => result.score >= 0.7).sort((left, right) => right.score - left.score);
  const weak = results.filter((result) => result.category !== "stability" && result.score < 0.5)
    .sort((left, right) => left.score - right.score);
  const lines = ["  强项 Scenario："];
  for (const scenario of strong.slice(0, limit)) {
    lines.push(`    + ${scenario.name} (${(scenario.score * 100).toFixed(0)})`);
  }
  lines.push("  弱项 Scenario：");
  for (const scenario of weak.slice(0, limit)) {
    lines.push(`    - ${scenario.name} (${(scenario.score * 100).toFixed(0)})`);
  }
  return lines;
}

function finalAssessment(categoryScores, results) {
  const byQuality = Object.values(categoryScores)
    .filter((entry) => entry.scenarioCount > 0)
    .sort((left, right) => right.quality - left.quality);
  const strongest = byQuality[0];
  const weakest = byQuality.at(-1);
  const failures = results.filter((result) => result.category !== "stability" && result.score < 0.5);
  const failureReasons = {};
  for (const result of failures) {
    const key = CATEGORIES[result.category]?.label ?? result.category;
    failureReasons[key] = (failureReasons[key] ?? 0) + 1;
  }
  const topIssues = Object.entries(failureReasons)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([label, count]) => `${label} ${count} 个`);

  const parts = [];
  if (strongest) parts.push(`当前 AI 主要强在${strongest.label}（模块质量 ${(strongest.quality * 100).toFixed(0)}%）。`);
  if (weakest && weakest.quality < 0.6) {
    parts.push(`主要弱在${weakest.label}（模块质量仅 ${(weakest.quality * 100).toFixed(0)}%）。`);
  }
  if (topIssues.length) {
    parts.push(`最影响总分的 3~5 个问题集中在：${topIssues.join("、")}。`);
  } else {
    parts.push("本版未发现集中在某一模块的系统性失败。");
  }
  return parts.join("\n");
}

/** 三 Agent 总分表。 */
function agentCalibrationLines(agentScores) {
  return AGENT_ORDER.map((agentId) => (
    `  ${AGENT_LABELS[agentId].padEnd(14)} ${agentScores[agentId].toFixed(0).padStart(4)} / 1000`
  ));
}

function agentCalibrationCorrectedLines(agentScores, chanceCorrected, randomExpectedTotal, agentCategoryScores, randomExpectedByCategory) {
  const randomLine = `  ${"Random Legal Expected".padEnd(14)} ${randomExpectedTotal.toFixed(0).padStart(4)} raw`;
  const greedy = `  ${"Greedy / D1".padEnd(14)} ${agentScores[AGENTS.greedy].toFixed(0).padStart(4)} raw / ${chanceCorrected.greedyTotal.toFixed(0).padStart(4)} corrected`;
  const production = `  ${"Production AI".padEnd(14)} ${agentScores[AGENTS.production].toFixed(0).padStart(4)} raw / ${chanceCorrected.productionTotal.toFixed(0).padStart(4)} corrected`;
  return [randomLine, greedy, production];
}

/** 能力增益。 */
function capabilityLiftLines(lift) {
  return [
    `  Random → Greedy      +${lift.randomToGreedy.toFixed(0)}`,
    `  Greedy → Production  +${lift.greedyToProduction.toFixed(0)}`,
    `  Random → Production  +${lift.randomToProduction.toFixed(0)}`
  ];
}

/** 模块三 Agent 对比表。 */
function moduleComparisonLines(agentCategoryScores) {
  const width = Math.max(...Object.values(CATEGORIES).map((category) => category.label.length));
  const header = `  ${"Module".padEnd(width)}  Random  Greedy  Production`;
  const rows = Object.values(CATEGORIES).map((category) => {
    const scores = AGENT_ORDER.map((agentId) => {
      const entry = agentCategoryScores[agentId]?.[category.id];
      return entry ? entry.score.toFixed(0).padStart(3) : "  - ";
    });
    return `  ${category.label.padEnd(width)}  ${scores.join("    ")}`;
  });
  return [header, ...rows];
}

/** 模块 Raw / Random Floor / Corrected 对比。 */
function moduleCorrectedLines(agentCategoryScores, chanceCorrected, randomExpectedByCategory) {
  const width = Math.max(...Object.values(CATEGORIES).map((category) => category.label.length));
  const header = `  ${"Module".padEnd(width)}  Random  GreedyRaw  ProdRaw  GreedyCorr  ProdCorr`;
  const rows = Object.values(CATEGORIES).map((category) => {
    const random = randomExpectedByCategory[category.id];
    const greedy = agentCategoryScores[AGENTS.greedy]?.[category.id];
    const production = agentCategoryScores[AGENTS.production]?.[category.id];
    const corrected = chanceCorrected.moduleCorrected[category.id];
    return `  ${category.label.padEnd(width)}`
      + `  ${(random?.score ?? 0).toFixed(0).padStart(3)}`
      + `  ${(greedy?.score ?? 0).toFixed(0).padStart(4)}`
      + `  ${(production?.score ?? 0).toFixed(0).padStart(4)}`
      + `  ${(corrected?.greedyScore ?? 0).toFixed(0).padStart(5)}`
      + `  ${(corrected?.productionScore ?? 0).toFixed(0).padStart(5)}`;
  });
  return [header, ...rows];
}

/** 决策质量分布。 */
function decisionQualityLines(agentMistakeCounts) {
  const levels = ["Optimal", "Strong", "Acceptable", "Poor", "Severe", "Catastrophic"];
  const lines = [];
  for (const agentId of AGENT_ORDER) {
    const counts = agentMistakeCounts[agentId] ?? {};
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0) || 1;
    const parts = levels.map((level) => {
      const count = counts[level] ?? 0;
      return `${level}: ${pct(count / total)}`;
    });
    const severeCatastrophic = ((counts.Severe ?? 0) + (counts.Catastrophic ?? 0)) / total;
    lines.push(`  ${AGENT_LABELS[agentId].padEnd(14)} ${parts.join("  ")}`);
    lines.push(`  ${"".padEnd(14)} Severe + Catastrophic: ${pct(severeCatastrophic)}`);
  }
  return lines;
}

/** Greedy saturation 警告。 */
function saturationWarningLines(greedySaturation, agentCategoryScores) {
  const warnings = [];
  for (const [categoryId, saturation] of Object.entries(greedySaturation)) {
    if (categoryId === "total") continue;
    const category = CATEGORIES[categoryId];
    if (!category) continue;
    if (saturation > 0.8 && (agentCategoryScores[AGENTS.production]?.[categoryId]?.score ?? 0) > 0) {
      warnings.push(`  - ${category.label}: Greedy/Production = ${(saturation * 100).toFixed(0)}%（区分度不足，逐题原因见报告）`);
    }
  }
  if (!warnings.length) warnings.push("  （无明显 Greedy 饱和模块）");
  return warnings;
}

/** 难度分层通过率。 */
function difficultyLines(difficultyStats) {
  const lines = [];
  for (const [difficulty, entry] of Object.entries(difficultyStats)) {
    if (!entry.count) continue;
    const rates = AGENT_ORDER.map((agentId) => `${AGENT_LABELS[agentId].split(" ")[0]}:${pct(entry.agents[agentId] ?? 0)}`);
    lines.push(`  ${difficulty.padEnd(12)} ${entry.count} 题  ${rates.join("  ")}`);
  }
  return lines;
}

/** 对抗题统计。 */
function adversarialLines(adversarialStats) {
  const labels = {
    "immediate-reward": "Immediate Reward Trap",
    "resource": "Resource Trap",
    "buff-waste": "Buff Waste Trap",
    "response-bait": "Response Bait",
    "target": "Target Trap",
    "healing": "Healing Trap",
    "cross-turn": "Cross-turn Trap",
    "setup": "Setup / Combo"
  };
  const entries = Object.entries(adversarialStats);
  if (!entries.length) return ["  （无对抗题）"];
  return entries.map(([type, entry]) => {
    const rates = AGENT_ORDER.map((agentId) => `${AGENT_LABELS[agentId].split(" ")[0]}:${pct(entry.agents[agentId]?.rate ?? 0)}`);
    return `  ${(labels[type] ?? type).padEnd(24)} ${entry.count} 题  ${rates.join("  ")}`;
  });
}

/** Chance Floor 分布。 */
function chanceFloorLines(distribution, summary) {
  const lines = [
    `  Mean Random Floor: ${(summary.mean * 100).toFixed(1)}%   Median: ${(summary.median * 100).toFixed(1)}%`,
    `  R >= 0.50: ${summary.over50}   R >= 0.70: ${summary.over70}   R >= 0.90: ${summary.over90}`,
    "  分布："
  ];
  for (const [range, count] of Object.entries(distribution)) {
    lines.push(`    ${range}: ${count} 个 Scenario`);
  }
  lines.push("  最高 Chance Floor Scenario：");
  for (const scenario of summary.highScenarios ?? []) {
    lines.push(`    ${scenario.id}: R=${(scenario.floor * 100).toFixed(0)}%（${scenario.legalActions} 个合法动作）`);
  }
  return lines;
}

/** Planner Effectiveness 表。 */
function plannerEffectivenessLines(plannerAudit) {
  const lines = [];
  for (const [groupName, entry] of Object.entries(plannerAudit.byGroup)) {
    lines.push(`  ${groupName.padEnd(14)} ${entry.count} 题  Wins:${(entry.winRate * 100).toFixed(0).padStart(3)}%`
      + `  No Lift:${((1 - entry.winRate - entry.regressionRate) * 100).toFixed(0).padStart(3)}%`
      + `  Regressions:${(entry.regressionRate * 100).toFixed(0).padStart(3)}%`
      + `  净提升:${entry.netLiftPp >= 0 ? "+" : ""}${entry.netLiftPp.toFixed(1)}pp`);
  }
  return lines;
}

function plannerTopLines(entries, label) {
  if (!entries?.length) return [`  ${label}：无`];
  return entries.map((entry) => (
    `  ${entry.id} [${entry.category}${entry.adversarial ? `/${entry.adversarial}` : ""}]`
    + ` G=${(entry.greedy * 100).toFixed(0)} P=${(entry.production * 100).toFixed(0)}`
    + ` Δ=${entry.difference >= 0 ? "+" : ""}${(entry.difference * 100).toFixed(0)}`
    + `（G:${entry.greedyAction?.cardId ?? "end"} → P:${entry.productionAction?.cardId ?? "end"}）`
  ));
}

function plannerDifficultyLines(plannerAudit) {
  return Object.entries(plannerAudit.byDifficulty).map(([difficulty, entry]) => (
    `  ${difficulty.padEnd(12)} ${entry.count} 题  Greedy:${(entry.greedyQuality * 100).toFixed(0)}%`
    + `  Production:${(entry.productionQuality * 100).toFixed(0)}%`
    + `  Planner Lift:${entry.plannerLiftPp >= 0 ? "+" : ""}${entry.plannerLiftPp.toFixed(1)}pp`
    + (difficulty === "expert" && entry.plannerLiftPp <= 0 ? "  ← 醒目标记：Expert 上 Planner 无增益" : "")
  ));
}

/** 生成完整终端报告。 */
export function formatReport(aggregate, { verbose = false, seed = null, nodeBudget = null, durationMs = 0 } = {}) {
  const {
    total, categoryScores, results, stabilityDiagnostics, depthStats, searchStats,
    familyStats, agentScores, agentCategoryScores, capabilityLift, greedySaturation,
    difficultyStats, adversarialStats, agentMistakeCounts, planningLift,
    chanceCorrected, plannerAudit, chanceFloorDistribution, chanceFloorSummary,
    randomExpectedTotal, randomExpectedByCategory
  } = aggregate;
  const lines = [];
  lines.push("FiveRealms AI Competency Benchmark v0.4");
  lines.push("================================");
  lines.push("");
  lines.push("Production AI");
  lines.push("--------------------------------");
  lines.push(`  Raw Score                ${total.toFixed(0)} / 1000`);
  lines.push(`  Chance-Corrected Score   ${chanceCorrected.productionTotal.toFixed(0)} / 1000`);
  lines.push(`Level: ${levelForScore(total)}`);
  lines.push("");
  lines.push("Agent Calibration");
  lines.push("--------------------------------");
  lines.push(...agentCalibrationCorrectedLines(agentScores, chanceCorrected, randomExpectedTotal, agentCategoryScores, randomExpectedByCategory));
  lines.push("");
  lines.push("Random Baseline Stability");
  lines.push("--------------------------------");
  lines.push("  Random Legal Expected 通过精确枚举合法动作计算（不依赖随机抽样）");
  lines.push(`  Random Sample Agent 单次抽样得分：${agentScores[AGENTS.random].toFixed(0)} / 1000（诊断用）`);
  lines.push(`  无区分度排除（R>=0.99）：${chanceCorrected.excludedNoDiscrimination} 个 Scenario`);
  lines.push("");
  lines.push("Capability Lift");
  lines.push("--------------------------------");
  lines.push("  Raw Lift（历史可比）：");
  lines.push(...capabilityLiftLines(capabilityLift));
  lines.push("  Chance-Corrected Lift：");
  lines.push(`    Random baseline → Greedy     ${chanceCorrected.greedyTotal.toFixed(0)}（corrected）`);
  lines.push(`    Greedy → Production          +${(chanceCorrected.productionTotal - chanceCorrected.greedyTotal).toFixed(0)}（corrected）`);
  lines.push("");
  lines.push("Module Comparison");
  lines.push("--------------------------------");
  lines.push(...moduleComparisonLines(agentCategoryScores));
  lines.push("");
  lines.push("Module Scores (Random Floor / Raw / Corrected)");
  lines.push("--------------------------------");
  lines.push(...moduleCorrectedLines(agentCategoryScores, chanceCorrected, randomExpectedByCategory));
  lines.push("");
  lines.push("Decision Quality");
  lines.push("--------------------------------");
  lines.push(...decisionQualityLines(agentMistakeCounts));
  lines.push("");
  lines.push("Adversarial Performance");
  lines.push("--------------------------------");
  lines.push(...adversarialLines(adversarialStats));
  lines.push("");
  lines.push("Difficulty Pass Rate (>= 70%)");
  lines.push("--------------------------------");
  lines.push(...difficultyLines(difficultyStats));
  const difficultyCount = Object.values(difficultyStats).reduce((sum, entry) => sum + (entry?.count ?? 0), 0);
  lines.push(`  难度统计合计：${difficultyCount} 个计分/带标签 Scenario`
    + ` + ${stabilityDiagnostics?.length ?? 0} 个 stability diagnostic = ${difficultyCount + (stabilityDiagnostics?.length ?? 0)} 个总执行 Scenario`);
  lines.push("");
  lines.push("Planner Effectiveness");
  lines.push("--------------------------------");
  lines.push(...plannerEffectivenessLines(plannerAudit));
  lines.push("");
  lines.push("Planner Lift by Difficulty");
  lines.push("--------------------------------");
  lines.push(...plannerDifficultyLines(plannerAudit));
  lines.push("");
  lines.push("Top Planner Wins");
  lines.push("--------------------------------");
  lines.push(...plannerTopLines(plannerAudit.topWins, "Wins"));
  lines.push("");
  lines.push("Top Planner Regressions");
  lines.push("--------------------------------");
  lines.push(...plannerTopLines(plannerAudit.topRegressions, "Regressions"));
  lines.push("");
  lines.push("Module Scores (Production)");
  lines.push("--------------------------------");
  lines.push(...moduleLines(categoryScores));
  lines.push("");
  lines.push("Reference Scale — NOT human calibrated");
  lines.push("--------------------------------");
  lines.push("  ~800  Reference target (NOT measured from humans)");
  lines.push("  ~850  Reference target (NOT measured from humans)");
  lines.push("  ~900  Reference target (NOT measured from humans)");
  lines.push("  930+  Reference target (NOT measured from humans)");
  lines.push("");
  lines.push("Strengths");
  lines.push("--------------------------------");
  lines.push(...strengthLines(categoryScores, results));
  lines.push("");
  lines.push("Weaknesses");
  lines.push("--------------------------------");
  lines.push(...weaknessLines(categoryScores, results));
  lines.push("");
  lines.push("Key Findings / Deductions");
  lines.push("--------------------------------");
  lines.push(...keyDeductionLines(results));
  lines.push("");
  lines.push("Chance Floor");
  lines.push("--------------------------------");
  lines.push(...chanceFloorLines(chanceFloorDistribution, chanceFloorSummary));
  lines.push("");
  lines.push("Below Random Expectation");
  lines.push("--------------------------------");
  lines.push(`  Production below random expectation: ${chanceCorrected.belowChanceCount} / ${scoredResultsCount(results)}`);
  for (const scenario of chanceCorrected.belowChanceScenarios ?? []) {
    lines.push(`    ${scenario.id}: P=${(scenario.productionRaw * 100).toFixed(0)} R=${(scenario.floor * 100).toFixed(0)} P-R=${((scenario.difference) * 100).toFixed(0)}`);
  }
  lines.push("");
  lines.push("Counterfactual Families");
  lines.push("--------------------------------");
  if (familyStats?.length) {
    for (const family of familyStats) {
      lines.push(`  ${family.family}: ${family.variants} 个变体，`
        + `类别敏感 ${(family.classHitRate * 100).toFixed(0)}%`
        + `（${family.classHit}/${family.classAware}），平均质量 ${(family.avgQuality * 100).toFixed(0)}%，`
        + `边界：${family.boundary ?? "N/A"}`);
    }
  } else {
    lines.push("  （无反事实 Family 数据）");
  }
  lines.push("");
  lines.push("Planning Diagnostics");
  lines.push("--------------------------------");
  lines.push("  Planning Scenario Set Pass Rate（不同题集，不保证严格单调）：");
  lines.push(...depthLines(depthStats));
  lines.push(`  Planning Lift over D1（All intelligent）: +${planningLift.all.toFixed(1)} pp`);
  lines.push(`  Planning Lift over D1（Planning set）:    +${planningLift.planning.toFixed(1)} pp`);
  lines.push(`  Planning Lift over D1（Adversarial set）:  +${planningLift.adversarialPlanning.toFixed(1)} pp`);
  lines.push("");
  lines.push("Calibration Warnings");
  lines.push("--------------------------------");
  lines.push(...saturationWarningLines(greedySaturation, agentCategoryScores));
  lines.push("");
  lines.push("Stability Diagnostics（不计分）");
  lines.push("--------------------------------");
  if (stabilityDiagnostics?.length) {
    const avgStability = stabilityDiagnostics.reduce((sum, scenario) => sum + (scenario.stability ?? 1), 0) / stabilityDiagnostics.length;
    lines.push(`  决策稳定性 ${(avgStability * 100).toFixed(0)}%`);
  } else {
    lines.push("  （无稳定性诊断数据）");
  }
  lines.push("");
  if (verbose) {
    lines.push("Scenario Summary");
    lines.push("--------------------------------");
    lines.push(...scenarioSummaryLines(results));
    lines.push("");
  }
  lines.push(`Search Diagnostics: ${searchStats.scenarios} 次决策，平均扩展 ${(searchStats.expanded / Math.max(1, searchStats.scenarios)).toFixed(1)} 节点，`
    + `平均搜索深度 ${searchStats.avgDepth.toFixed(1)}，AI 决策耗时约 ${(searchStats.elapsedMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("Final Assessment");
  lines.push("--------------------------------");
  lines.push(finalAssessment(categoryScores, results));
  lines.push("");
  lines.push(`运行信息：seed=${seed || "default"}${nodeBudget ? `，node-budget=${nodeBudget}` : ""}，耗时 ${(durationMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("说明：Total Score 仅代表当前 Benchmark Scenario 集上的能力分；");
  lines.push("Human Calibration 尚未完成，不能据此推断人类等级。");
  return lines.join("\n");
}

function scoredResultsCount(results) {
  return results.filter((result) => result.category !== "stability").length;
}
