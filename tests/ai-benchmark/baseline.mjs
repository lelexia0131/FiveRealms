/**
 * 多级 Agent 定义（v0.3）。
 *
 * 三个标准 Agent 必须在完全相同的 Scenario、完全相同的局面构造、
 * 完全相同的可见信息下运行，并使用完全相同的评分函数：
 *
 * 1. Random Legal：
 *    - 只读取生产合法动作集合（AiActionGenerator.getLegalActions）；
 *    - 从合法动作中均匀随机选择（deterministic seed）；
 *    - 禁止调用生产 evaluator、simulator、planner 或任何估值函数。
 *
 * 2. Greedy / One-Step：
 *    - 允许使用生产 AiEvaluator + AiSimulator；
 *    - 只做"当前状态 → 每个合法动作 → 一步评估"；
 *    - 禁止调用 AiPlanner / AIController.selectAction（无搜索、无前瞻）。
 *
 * 3. Production AI：
 *    - AIController → AiPlanner → AiSimulator → AiEvaluator 原样调用；
 *    - 不修改生产代码。
 *
 * 信息公平：三个 Agent 都通过 game.aiController.getLegalActions 获得
 * 同一合法动作集合；Greedy 通过生产 createAiVisibleState 获得与
 * Production 完全一致的可见快照。
 */
import { makeRandom, runGreedyDepth1 } from "./helpers.mjs";

/** 创建 seeded 随机源。 */
export function createSeededRandom(seed) {
  return makeRandom(seed);
}

/** Random Legal：从合法动作中均匀随机选一个。 */
export function selectRandomLegal(game, playerId = null, random = Math.random) {
  const player = game.state.players.find((entry) => entry.id === (playerId ?? game.state.players[game.state.currentPlayerIndex]?.id));
  if (!player) return { type: "end" };
  const legal = game.aiController.getLegalActions(player);
  if (!legal.length) return { type: "end" };
  const index = Math.floor(random() * legal.length);
  return legal[Math.min(index, legal.length - 1)];
}

/** Greedy / One-Step：生产 evaluator 的一步贪心，无搜索。 */
export function selectGreedy(game, playerId = null) {
  return runGreedyDepth1(game, playerId);
}

/** 生产 AI：经由 run.mjs 使用 runAiDecision 调用，不在此重复实现。 */

/** 供 run.mjs 使用的统一入口。 */
export const agentModule = { selectRandomLegal, selectGreedy };
