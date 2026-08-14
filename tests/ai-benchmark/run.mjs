/**
 * FiveRealms AI Benchmark 入口。
 *
 * 默认：node ./tests/ai-benchmark/run.mjs
 * npm： npm run test:ai
 *
 * 可选参数：
 *   --seed <number>        随机种子（默认固定）
 *   --node-budget <number> AI 搜索节点预算（默认 800）
 *   --category <id>        只运行指定模块（如 combos / probability）
 *   --verbose              输出完整 Scenario 摘要
 *   --full                 额外运行少量完整对局诊断（不计入评分）
 *   --output <path>        将 JSON 结果写入 reports/（可选，默认不写文件）
 */
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { makeRandom, createHeadlessUi } from "./helpers.mjs";
import {
  runBenchmark, aggregateResults, listScenarios, CATEGORIES, AGENTS
} from "./benchmark.mjs";
import { formatReport } from "./reporters.mjs";
import { createSeededRandom } from "./baseline.mjs";

import "./scenarios/rules.mjs";
import "./scenarios/cards.mjs";
import "./scenarios/skills.mjs";
import "./scenarios/resources.mjs";
import "./scenarios/combos.mjs";
import "./scenarios/board.mjs";
import "./scenarios/probability.mjs";
import "./scenarios/planning.mjs";
import "./scenarios/stability.mjs";
import "./scenarios/counterfactualFamilies.mjs";
import "./scenarios/hardScenarios.mjs";
import "./scenarios/bladeWalker.mjs";
import "./scenarios/oathWarden.mjs";
import "./scenarios/spiritMedic.mjs";

function parseCli(argv) {
  const parsed = {
    seed: 0,
    nodeBudget: 800,
    category: null,
    verbose: false,
    full: false,
    output: null,
    calibration: false,
    chanceAudit: false,
    plannerAudit: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--seed" && value != null) { parsed.seed = Number(value) >>> 0; index += 1; }
    else if (token === "--node-budget" && value != null) { parsed.nodeBudget = Math.max(50, Math.floor(Number(value) || 800)); index += 1; }
    else if (token === "--category" && value != null) { parsed.category = value; index += 1; }
    else if (token === "--verbose") parsed.verbose = true;
    else if (token === "--full") parsed.full = true;
    else if (token === "--calibration") parsed.calibration = true;
    else if (token === "--chance-audit") parsed.chanceAudit = true;
    else if (token === "--planner-audit") parsed.plannerAudit = true;
    else if (token === "--output" && value != null) { parsed.output = value; index += 1; }
    else if (token === "--help" || token === "-h") {
      console.log("用法：node ./tests/ai-benchmark/run.mjs [--seed N] [--node-budget N] [--category id] [--verbose] [--full] [--calibration] [--chance-audit] [--planner-audit] [--output path]");
      process.exit(0);
    } else {
      console.error(`未知参数：${token}（使用 --help 查看用法）`);
      process.exit(2);
    }
  }
  return parsed;
}

function normalizeSeed(seed) {
  // 默认 0 = 使用每个 Scenario 的固定种子（修改 AI 前后可比）；
  // --seed N 用于显式比较不同随机样本。
  return seed;
}

async function runFullGameDiagnostics({ seed, nodeBudget, gameCount = 3 }) {
  const { Game } = await import("../../js/core/Game.js");
  const diagnostics = [];
  for (let index = 0; index < gameCount; index += 1) {
    const game = new Game(createHeadlessUi(), makeRandom((seed ^ 0x9e3779b9) + index * 2654435761 >>> 0));
    game.simulationMode = true;
    game.animationFastMode = true;
    game.aiSearchNodeBudgetOverride = Math.max(200, Math.floor(nodeBudget / 2));
    let failedPlays = 0;
    try {
      const originalPlay = game.playCard.bind(game);
      game.playCard = async (...args) => {
        const ok = await originalPlay(...args);
        if (!ok) failedPlays += 1;
        return ok;
      };
      const originalSkill = game.useActiveSkill.bind(game);
      game.useActiveSkill = async (...args) => {
        const ok = await originalSkill(...args);
        if (!ok) failedPlays += 1;
        return ok;
      };
      const candidates = game.startSelection();
      if (!candidates.length) throw new Error("无可用角色");
      await game.confirmGeneral(candidates[index % candidates.length].id);
      await game.loopPromise;
      diagnostics.push({
        game: index + 1,
        winnerTeam: game.state.winnerTeam ?? null,
        rounds: game.state.currentRound,
        turns: game.state.players.reduce((sum, player) => sum + (player.statistics?.cardsPlayed ?? 0), 0),
        failedPlays
      });
    } catch (error) {
      diagnostics.push({ game: index + 1, error: error?.message ?? String(error) });
    } finally {
      if (!game.state.isDisposed) game.dispose();
    }
  }
  return diagnostics;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const seed = normalizeSeed(cli.seed);
  const started = performance.now();

  const categories = cli.category
    ? new Set([cli.category])
    : null;
  if (categories && ![...categories].every((id) => CATEGORIES[id])) {
    console.error(`未知模块：${cli.category}。可选：${Object.keys(CATEGORIES).join(", ")}`);
    process.exit(2);
  }

  const scenarioCount = listScenarios().filter((scenario) => (
    !categories || categories.has(scenario.category)
  )).length;
  if (!scenarioCount) {
    console.error("没有可运行的 Scenario");
    process.exit(1);
  }

  console.log(`FiveRealms AI Benchmark 启动：seed=${seed || "default"}, node-budget=${cli.nodeBudget}`
    + `${cli.category ? `, category=${cli.category}` : ""}（共 ${scenarioCount} 个 Scenario）`);
  console.log("");

  const randomForRun = (runSeed) => createSeededRandom((runSeed ^ 0x51ed270b) >>> 0);
  const aggregate = await runBenchmark({
    categories,
    nodeBudget: cli.nodeBudget,
    globalSeed: seed,
    agents: cli.calibration
      ? [AGENTS.production, AGENTS.greedy, AGENTS.random]
      : [AGENTS.production, AGENTS.greedy, AGENTS.random],
    randomForRun,
    onScenario: (result) => {
      if (cli.verbose) {
        const categoryLabel = CATEGORIES[result.category]?.id ?? result.category;
        console.log(`  [${categoryLabel}] ${result.name}: ${(result.quality * 100).toFixed(0)} 分`
          + (result.results?.[0]?.agents?.[AGENTS.production]?.reason
            ? ` — ${result.results[0].agents[AGENTS.production].reason}` : ""));
      }
    }
  });

  let fullGameDiagnostics = null;
  if (cli.full) {
    console.log("运行完整对局诊断（不计入评分）...");
    fullGameDiagnostics = await runFullGameDiagnostics({ seed, nodeBudget: cli.nodeBudget });
  }

  const durationMs = performance.now() - started;
  const report = formatReport(aggregate, {
    verbose: cli.verbose,
    chanceAudit: cli.chanceAudit,
    plannerAudit: cli.plannerAudit,
    seed,
    nodeBudget: cli.nodeBudget,
    durationMs
  });
  console.log(report);

  if (fullGameDiagnostics?.length) {
    console.log("");
    console.log("Full Game Diagnostics (辅助观察，不计分)");
    console.log("--------------------------------");
    for (const entry of fullGameDiagnostics) {
      if (entry.error) console.log(`  第 ${entry.game} 局：失败（${entry.error}）`);
      else console.log(`  第 ${entry.game} 局：${entry.winnerTeam ?? "平局"}，${entry.rounds} 轮，失败动作 ${entry.failedPlays} 次`);
    }
  }

  if (cli.output) {
    const outputPath = resolve(cli.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({
      seed,
      nodeBudget: cli.nodeBudget,
      total: aggregate.total,
      categoryScores: Object.fromEntries(Object.entries(aggregate.categoryScores).map(([id, entry]) => [
        id, { label: entry.label, score: entry.score, max: entry.max, scenarioCount: entry.scenarioCount, quality: entry.quality }
      ])),
      scenarios: aggregate.results.map((result) => ({
        id: result.id,
        name: result.name,
        category: result.category,
        quality: result.quality,
        stability: result.stability,
        runs: result.results
      })),
      depthStats: aggregate.depthStats
    }, null, 2), "utf8");
    console.log(`\nJSON 结果已写入：${outputPath}`);
  }
}

main().catch((error) => {
  console.error("AI Benchmark 运行失败：", error);
  process.exit(1);
});
