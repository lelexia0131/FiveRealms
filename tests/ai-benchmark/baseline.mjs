/**
 * 脚本级（Legal/Script）基线 Agent。
 *
 * 目的：作为 Benchmark 区分度参照。该 Agent：
 * - 只做合法动作（沿用生产 AiActionGenerator 的合法列表）；
 * - 使用一组固定的、无规划深度的即时启发式选择动作；
 * - 不读取被测 AI 的 evaluator / 搜索统计。
 *
 * 它不代表"最低分"，而代表"会规则、会发动技能、但没有战术/规划"的脚本 AI。
 */
import { runGreedyDepth1 } from "./helpers.mjs";

/** 固定启发式：给合法动作一个即时价值分（无前瞻）。 */
function immediateValue(action, game, player) {
  if (action?.type === "end") return 0;
  if (action?.type === "skill") {
    const skillId = action.skill?.id;
    const target = action.targets?.[0];
    if (skillId === "hunt" && target) return 30 + Math.max(0, 4 - target.hp) * 2;
    if (skillId === "burningField") return 10 + game.getEnemies(player).length * 4;
    if (skillId === "symbiosis" && target) return 8 + Math.max(0, target.maxHp - target.hp) * 3;
    if (skillId === "barrier" && target) return 6 + (target.hp <= 2 ? 6 : 0);
    if (skillId === "resonance" && target) return 6;
    if (skillId === "stealSkill" && target) return 8 + (target.equipment ? 5 : 0);
    if (skillId === "allIn") return 4 + Math.max(0, player.energy - 1) * 2;
    if (skillId === "breakArmy") return 5;
    return 4;
  }
  const card = action.card;
  const target = action.targets?.[0];
  if (card?.definitionId === "assault") {
    if (target) return 20 + Math.max(0, 4 - target.hp) * 3;
    return 8;
  }
  if (card?.definitionId === "charge") return 6;
  if (card?.definitionId === "exposeWeakness") return 6;
  if (card?.definitionId === "recover" && target) return 6 + Math.max(0, target.maxHp - target.hp) * 2;
  if (card?.definitionId === "shield" && target) return 6 + (target.hp <= 2 ? 6 : 0);
  if (card?.definitionId === "shockwave") return 6 + game.getEnemies(player).length * 3;
  if (card?.definitionId === "harvest") return 6;
  if (card?.definitionId === "provoke") return 6;
  if (card?.definitionId === "seal" && target) return 8;
  if (card?.definitionId === "duel" && target) return 5;
  if (card?.definitionId === "plunder" && target) return 7 + (target.equipment ? 4 : 0);
  if (card?.definitionId === "destroy" && target) return 7 + (target.equipment ? 3 : 0);
  if (card?.definitionId === "telescope" || card?.definitionId === "energyDevice") return 6;
  return 3;
}

/** 脚本基线选择：从合法动作中挑即时价值最高者（贪心、无规划）。 */
export function selectGreedy(game, playerId = null) {
  const player = game.state.players.find((entry) => entry.id === (playerId ?? game.state.players[game.state.currentPlayerIndex]?.id));
  if (!player) return { type: "end" };
  const legal = game.aiController.getLegalActions(player);
  let best = null;
  let bestValue = -Infinity;
  for (const action of legal) {
    const value = immediateValue(action, game, player);
    if (value > bestValue) {
      bestValue = value;
      best = action;
    }
  }
  return best ?? { type: "end" };
}

/** 生产 evaluator 的 Depth-1 贪心（无前瞻），用于深度消融诊断。 */
export function selectGreedyDepth1(game, playerId = null) {
  return runGreedyDepth1(game, playerId);
}

/** 供 run.mjs 使用的统一入口。 */
export const baselineModule = { selectGreedy, selectGreedyDepth1 };
