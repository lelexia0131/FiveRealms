/**
 * 终端报告：直接输出评分摘要、优势/弱点、关键扣分、规划深度与最终结论。
 * 所有结论均来自实际 Scenario 结果，不输出套话。
 */
import { levelForScore, CATEGORIES } from "./benchmark.mjs";

const pct = (value) => `${(value * 100).toFixed(0)}%`;

/** 模块分数行（按满分降序对齐）。 */
function moduleLines(categoryScores) {
  const entries = Object.values(categoryScores);
  const width = Math.max(...entries.map((entry) => entry.label.length));
  return entries.map((entry) => {
    const label = entry.label.padEnd(width);
    return `  ${label}  ${entry.score.toFixed(0).padStart(3)} / ${entry.max}`;
  });
}

/** 优势：模块质量 >= 0.75，且列出代表 Scenario。 */
function strengthLines(categoryScores, results) {
  const strongCategories = Object.values(categoryScores)
    .filter((entry) => entry.scenarioCount > 0 && entry.quality >= 0.75)
    .sort((left, right) => right.quality - left.quality);
  if (!strongCategories.length) return ["  （暂无模块达到 75% 质量线）"];
  return strongCategories.map((entry) => {
    const top = [...entry.scenarios].sort((left, right) => right.quality - left.quality)[0];
    return `  - ${entry.label}: ${(entry.quality * 100).toFixed(0)}% 质量（${entry.scenarioCount} 个 Scenario，代表：${top?.name ?? "-"}）`;
  });
}

/** 弱点：模块质量 < 0.6，并列出失败 Scenario。 */
function weaknessLines(categoryScores, results) {
  const weakCategories = Object.values(categoryScores)
    .filter((entry) => entry.scenarioCount > 0 && entry.quality < 0.6)
    .sort((left, right) => left.quality - right.quality);
  const weakScenarios = results
    .filter((result) => result.category !== "stability")
    .filter((result) => result.score < 0.5)
    .sort((left, right) => left.score - right.score);
  if (!weakCategories.length && !weakScenarios.length) {
    return ["  （本版未发现明显弱点模块）"];
  }
  const lines = [];
  for (const entry of weakCategories) {
    lines.push(`  - ${entry.label}: 仅 ${(entry.quality * 100).toFixed(0)}% 质量（${entry.scenarioCount} 个 Scenario）`);
  }
  for (const scenario of weakScenarios.slice(0, 12)) {
    lines.push(`    · ${scenario.name}: ${(scenario.score * 100).toFixed(0)} 分 — ${scenario.results?.[0]?.reason ?? ""}`);
  }
  return lines;
}

/** 关键扣分：质量最低的 Scenario（可追溯到具体局面）。 */
function keyDeductionLines(results, limit = 8) {
  const worst = results
    .filter((result) => result.category !== "stability")
    .sort((left, right) => left.score - right.score).slice(0, limit);
  if (!worst.length) return ["  （无 Scenario 数据）"];
  return worst.map((scenario) => {
    const category = CATEGORIES[scenario.category];
    return `  - [${category?.label ?? scenario.category}] ${scenario.name}`
      + `：${(scenario.score * 100).toFixed(0)} 分`
      + (scenario.results?.[0]?.reason ? `（${scenario.results[0].reason}）` : "");
  });
}

/** 规划深度诊断。 */
function depthLines(depthStats) {
  return ["D1", "D2", "D3", "D4"].map((key) => {
    const entry = depthStats[key] ?? { count: 0, pass: 0, rate: 0 };
    return `  ${key}: ${pct(entry.rate)}（${entry.pass}/${entry.count} 个达标 Scenario）`;
  });
}

/** Scenario 摘要：强/弱名单。 */
function scenarioSummaryLines(results, limit = 10) {
  const strong = results.filter((result) => result.score >= 0.7).sort((left, right) => right.score - left.score);
  const weak = results.filter((result) => result.score < 0.5).sort((left, right) => left.score - right.score);
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

/** 最终结论：基于模块质量与失败模式的中文总结。 */
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

/** 生成完整终端报告。 */
export function formatReport(aggregate, { verbose = false, seed = null, nodeBudget = null, durationMs = 0 } = {}) {
  const { total, categoryScores, results, scoredResults, stabilityDiagnostics, depthStats, searchStats, familyStats, baseline } = aggregate;
  const lines = [];
  lines.push("FiveRealms AI Benchmark");
  lines.push("================================");
  lines.push("");
  lines.push(`Total Score: ${total.toFixed(0)} / 1000`);
  lines.push(`Level: ${levelForScore(total)}`);
  lines.push("");
  lines.push(...moduleLines(categoryScores));
  lines.push("");
  lines.push("Reference Scale (目标标尺，非实测)");
  lines.push("--------------------------------");
  lines.push("  ~800  Experienced human target");
  lines.push("  ~850  Strong player target");
  lines.push("  ~900  Expert target");
  lines.push("  930+  Very strong AI");
  lines.push("");
  lines.push("Discrimination Reference (脚本基线，不计分)");
  lines.push("--------------------------------");
  if (baseline?.hasBaseline) {
    lines.push(`  Script Baseline Total: ${baseline.total.toFixed(0)} / 1000（会规则/会发动技能，但无战术规划）`);
    lines.push(`  真实 AI 与脚本基线分差：${(total - baseline.total).toFixed(0)} 分（区分度参考）`);
    const planningDepth1 = baseline.scenarioResults?.filter((result) => result.category === "planning" && result.depth1Quality != null) ?? [];
    if (planningDepth1.length) {
      const depth1Avg = planningDepth1.reduce((sum, result) => sum + result.depth1Quality, 0) / planningDepth1.length;
      const planningActual = categoryScores.planning?.quality ?? 0;
      lines.push(`  Planning 深度消融：Depth-1 贪心质量 ${(depth1Avg * 100).toFixed(0)}% vs 真实 AI ${(planningActual * 100).toFixed(0)}%`);
    }
  } else {
    lines.push("  （未启用脚本基线）");
  }
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
  lines.push("Counterfactual Families");
  lines.push("--------------------------------");
  if (familyStats?.length) {
    for (const family of familyStats) {
      lines.push(`  ${family.family}: ${family.variants} 个变体，`
        + `类别敏感 ${(family.classHitRate * 100).toFixed(0)}%`
        + `（${family.classHit}/${family.classAware}），平均质量 ${(family.avgQuality * 100).toFixed(0)}%`);
    }
  } else {
    lines.push("  （无反事实 Family 数据）");
  }
  lines.push("");
  lines.push("Planning Depth");
  lines.push("--------------------------------");
  lines.push(...depthLines(depthStats));
  lines.push("");
  lines.push("Stability Diagnostics（不计分）");
  lines.push("--------------------------------");
  if (stabilityDiagnostics?.length) {
    const avgStability = stabilityDiagnostics.reduce((sum, scenario) => sum + (scenario.stability ?? 1), 0) / stabilityDiagnostics.length;
    const avgQuality = stabilityDiagnostics.reduce((sum, scenario) => sum + scenario.quality, 0) / stabilityDiagnostics.length;
    lines.push(`  决策稳定性 ${(avgStability * 100).toFixed(0)}% · 平均质量 ${(avgQuality * 100).toFixed(0)}%`);
    for (const scenario of stabilityDiagnostics) {
      lines.push(`    - ${scenario.name}: 稳定性 ${((scenario.stability ?? 1) * 100).toFixed(0)}%（${scenario.runs} runs）`);
    }
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
  lines.push(`Search Diagnostics: ${searchStats.scenarios} 次决策，平均扩展 ${searchStats.expanded / Math.max(1, searchStats.scenarios)} 节点，`
    + `平均搜索深度 ${searchStats.avgDepth.toFixed(1)}，AI 决策耗时约 ${(searchStats.elapsedMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("Final Assessment");
  lines.push("--------------------------------");
  lines.push(finalAssessment(categoryScores, results));
  lines.push("");
  lines.push(`运行信息：seed=${seed || "default"}${nodeBudget ? `，node-budget=${nodeBudget}` : ""}，耗时 ${(durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

/** 简要摘要（供命令行输出复用）。 */
export function formatBrief(aggregate) {
  const { total, categoryScores } = aggregate;
  const lines = [`Total Score: ${total.toFixed(0)} / 1000`, ""];
  lines.push(...moduleLines(categoryScores));
  return lines.join("\n");
}
