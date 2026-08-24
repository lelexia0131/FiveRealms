/*
模块职责
把战术动作的反制结算世界投影为 Evaluator 所需的单一 resolution scale。

上游
Searcher candidate evaluation。

下游
Simulator 的 card-scope 与 target-scope 响应查询。

状态边界
只读 World 与动作，不修改概率世界。

信息边界
只消费动作已携带的公开目标和过滤后的玩家状态。

架构约束
不得组合价值、生成候选、决定响应策略或读取 Game。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";

/*
功能
查询战术动作在当前过滤状态中的既有结算比例。

调用方
Searcher 交给 Evaluator.evaluateTransition 的延迟查询。

输入
动作、before World、行动者 ID 与复用 Simulator。

输出
零到一之间的既有结算比例。

读取状态
动作战术元数据、公开目标与过滤玩家状态。

写入状态
无。

调用函数
  Simulator.targetResolutionChance、Simulator.evaluateCardScopeCounterResponses。

边界与不变量
target scope 按存活目标算术平均；非反制战术恒为一，调用次数保持原有延迟查询语义。
*/
export function tacticResolutionScale(action, state, actorId, simulator) {
  const card = CARD_DEFINITIONS[action.cardId] ?? null;
  if (card?.category !== "tactic" || card.counterable === false) return 1;
  const actor = state.players.find((entry) => entry.id === actorId);
  if (!actor) return 1;
  if (card.counterScope === "target") {
    const targetIds = new Set(action.targetIds ?? []);
    const aliveTargets = state.players.filter(
      (entry) => targetIds.has(entry.id) && entry.alive
    );
    if (!aliveTargets.length) return 0;
    const total = aliveTargets.reduce((sum, target) => (
      sum + simulator.targetResolutionChance(state, actor, card, target)
    ), 0);
    return total / aliveTargets.length;
  }
  const mappedTargets = (action.targetIds ?? [])
    .map((targetId) => state.players.find((entry) => entry.id === targetId))
    .filter(Boolean);
  return simulator.evaluateCardScopeCounterResponses(
    state,
    actor,
    card,
    mappedTargets
  ).resolutionChance;
}
