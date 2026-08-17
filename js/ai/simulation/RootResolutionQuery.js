/*
模块职责
以配对反事实对照模拟一张 root 战术生效或取消时的 State Value 差。

上游
ValueSimulationQuery 与固定响应回归测试。

下游
注入的 Simulator、StateValue 与 domain/GlobalBenefitModel。

状态边界
只通过注入 Simulator 写独立 SearchState 克隆，不修改输入状态或真实 GameState。

信息边界
只消费响应时刻的过滤状态、公开目标和显式选择，不读取隐藏实体牌。

架构约束
这是有界 Simulation query；不构造 Simulator、不决定响应策略、不拥有最终价值公式。
*/
import { isGlobalBenefitCard } from "../domain/GlobalBenefitModel.js?build=20260817-architecture-closure-final";

export const TARGET_SCOPE_CARDS = new Set(["shockwave", "provoke"]);

/*
功能
为目标级群体战术构造只保留当前目标效果的配对基线。

调用方
dynamicRootFlipGain。

输入
Simulator capability、SearchState、root 来源 ID 与公开目标。

输出
独立的收敛 SearchState。

读取状态
玩家阵营、存活状态和目标 ID。

写入状态
只写 Simulator clone 中非目标敌人的 alive 与目标反制容量。

调用函数
Simulator.clone。

边界与不变量
base 与 resolved 两世界共享同一收敛基线；非目标固定死亡价值必须在差值中抵消。
*/
export function buildTargetScopedBase(simulator, state, rootSourceId, targets) {
  const reduced = simulator.clone(state);
  const source = reduced.players.find((player) => player.id === rootSourceId);
  const targetIds = new Set(targets.map((target) => target.id));
  for (const player of reduced.players) {
    if (player.id === rootSourceId || targetIds.has(player.id)) continue;
    if (source && player.battleTeam !== source.battleTeam) player.alive = false;
  }
  for (const player of reduced.players) {
    if (!targetIds.has(player.id)) continue;
    player.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
    player.counterProbability = 0;
  }
  return reduced;
}

/*
功能
把转移或借势的公开 root 上下文投影为 Simulator action selection。

调用方
resolveRootState。

输入
root 卡、公开目标与规划/真实响应上下文。

输出
选择描述；无选择机制时为 null。

读取状态
显式 selection、公开转移来源/接收者与目标 ID。

写入状态
无。

调用函数
无。

边界与不变量
真实响应侧不携带隐藏牌身份；规划侧已有合法身份时保持原字段。
*/
function buildRootSelection(rootCard, targets, options = {}) {
  const rootId = rootCard?.definitionId;
  if (rootId === "transfer") {
    const planned = options.selection ?? null;
    if (planned?.sourceId && planned?.receiverId) {
      return {
        sourceId:planned.sourceId,
        receiverId:planned.receiverId,
        zone:planned.zone ?? "hand",
        selectionKind:planned.selectionKind ?? null,
        cardId:planned.cardId ?? null,
        definitionId:planned.definitionId ?? null
      };
    }
    const context = options.publicTransferContext ?? null;
    if (!context?.fromPlayerId || !context?.receiverPlayerId) return null;
    return {
      sourceId:context.fromPlayerId,
      receiverId:context.receiverPlayerId,
      zone:context.zone ?? "hand"
    };
  }
  if (rootId === "leverage") {
    return {
      firstTargetId:targets[0]?.id ?? null,
      secondTargetId:targets[1]?.id ?? null
    };
  }
  return null;
}

/*
功能
从当前响应状态模拟 root 战术确定生效后的 after-state。

调用方
dynamicRootFlipGain。

输入
Simulator capability、SearchState、root 卡/来源/目标与公开选择上下文。

输出
root 效果已结算的独立 SearchState。

读取状态
当前响应资源状态和显式 root 上下文。

写入状态
临时写 Simulator 递归守卫，并通过 apply 写独立克隆。

调用函数
buildRootSelection、Simulator.apply。

边界与不变量
root 卡资源已在真实响应链沉没，因此 restoreActorHand 抵消 apply 的重复手牌成本；counterable=false 防止二次概率化。
*/
export function resolveRootState(
  simulator,
  state,
  rootCard,
  rootSourceId,
  targets,
  options = {}
) {
  const previousSimulating = simulator._simulatingRootResolution ?? false;
  simulator._simulatingRootResolution = true;
  try {
    const action = {
      type:"card",
      card:{
        ...rootCard,
        id:`root-sim:${rootCard.id ?? rootCard.definitionId}`,
        counterable:false
      },
      targets,
      selection:buildRootSelection(rootCard, targets, options),
      restoreActorHand:true
    };
    return simulator.apply(state, action, rootSourceId);
  } finally {
    simulator._simulatingRootResolution = previousSimulating;
  }
}

/*
功能
计算追加一张反制翻转 root 结局带来的 State Value 增量。

调用方
ValueSimulationQuery 与直接响应反事实测试。

输入
StateValue、Simulator capability、响应状态、响应者、root 卡/来源/深度/目标上下文。

输出
全体受益或非法 root 为 null；否则返回 flip 世界减 stay 世界的价值。

读取状态
过滤后的当前响应状态与实时目标。

写入状态
仅由 Simulator 写独立克隆。

调用函数
isGlobalBenefitCard、buildTargetScopedBase、resolveRootState、StateValue.stateUtility。

边界与不变量
两世界只改变 root 是否生效；保持相同响应容量、隐藏信息、概率世界和其他状态。
*/
export function dynamicRootFlipGain(
  stateValue,
  simulator,
  state,
  responderId,
  rootCard,
  rootSourceId,
  counterDepth,
  rootTargetIds,
  options = {}
) {
  const definitionId = rootCard?.definitionId;
  if (!definitionId || rootCard.category !== "tactic" || isGlobalBenefitCard(definitionId)) {
    return null;
  }
  const actor = state.players.find((player) => player.id === rootSourceId);
  if (!actor?.alive) return 0;
  const targets = (rootTargetIds ?? [])
    .map((id) => state.players.find((player) => player.id === id))
    .filter((target) => target?.alive);
  const resolvesAtStay = (counterDepth % 2) === 0;
  const baseState = TARGET_SCOPE_CARDS.has(definitionId)
    ? buildTargetScopedBase(simulator, state, rootSourceId, targets)
    : state;
  const resolvedState = resolveRootState(
    simulator,
    baseState,
    rootCard,
    rootSourceId,
    targets,
    options
  );
  const baseValue = stateValue.stateUtility(baseState, responderId);
  const resolvedValue = stateValue.stateUtility(resolvedState, responderId);
  const rootEffectValue = resolvedValue - baseValue;
  return resolvesAtStay ? -rootEffectValue : rootEffectValue;
}
