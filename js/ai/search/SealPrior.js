/*
模块职责
拥有主动使用封印时的未来出牌机会搜索先验与座次折扣。

上游
SearchPrior 与直接搜索先验测试。

下游
domain/SealModel、value/ThreatValue、DistanceSystem 与卡牌配置。

状态边界
只读过滤后的 SearchState 与候选目标，不写状态。

信息边界
只消费公开座次、封印状态和合法判定概率摘要。

架构约束
返回值只用于 SEARCH_PRIOR；不得进入 State Value、TransitionValue 或 sibling timing。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260814-ai-code-hygiene-final";
import { DistanceSystem } from "../../core/DistanceSystem.js?build=20260814-ai-code-hygiene-final";
import { hasSeal, sealOutcomeProbabilities } from "../domain/SealModel.js?build=20260814-ai-code-hygiene-final";
import { turnOpportunityValue } from "../value/ThreatValue.js?build=20260814-ai-code-hygiene-final";

const FUTURE_DISCOUNT = 0.65;
const MIN_TURN_TIMING_FACTOR = 0.7;
const TURN_TIMING_STEP = 0.1;

/*
功能
计算当前行动者之后到目标行动前隔着的存活角色数量。

调用方
turnTimingFactor 与直接先验测试。

输入
过滤状态、行动者与目标。

输出
非负间隔数；非法或同一角色返回 Infinity。

读取状态
公开存活座次环。

写入状态
无。

调用函数
DistanceSystem.getAliveRing。

边界与不变量
只描述座次时机，不判断封印合法性或修改真实回合顺序。
*/
export function turnOrderGap(state, actor, target) {
  if (!actor?.alive || !target?.alive || actor.id === target.id) return Infinity;
  const ring = DistanceSystem.getAliveRing({ state:{ players:state?.players ?? [] } });
  const actorIndex = ring.findIndex((player) => player.id === actor.id);
  const targetIndex = ring.findIndex((player) => player.id === target.id);
  if (actorIndex < 0 || targetIndex < 0 || ring.length < 2) return Infinity;
  const forwardSteps = (targetIndex - actorIndex + ring.length) % ring.length;
  return forwardSteps > 0 ? forwardSteps - 1 : Infinity;
}

/*
功能
把封印目标距离其下次行动的座次间隔转换为温和先验折扣。

调用方
sealUseValue 与直接先验测试。

输入
过滤状态、行动者与目标。

输出
0.7 到 1 之间的时机因子。

读取状态
turnOrderGap 的公开座次结果。

写入状态
无。

调用函数
turnOrderGap。

边界与不变量
下一位为一，每多隔一人扣零点一，最低保持既有零点七。
*/
export function turnTimingFactor(state, actor, target) {
  const gap = turnOrderGap(state, actor, target);
  return Number.isFinite(gap)
    ? Math.max(MIN_TURN_TIMING_FACTOR, 1 - gap * TURN_TIMING_STEP)
    : MIN_TURN_TIMING_FACTOR;
}

/*
功能
计算主动使用封印的基础牌值与未来跳过出牌阶段收益。

调用方
SearchPrior.actionUtility 与直接先验测试。

输入
行动者、目标与过滤后的 SearchState。

输出
封印候选的搜索先验；非法目标返回既有负五十。

读取状态
封印领域概率、目标机会价值和公开座次。

写入状态
无。

调用函数
hasSeal、sealOutcomeProbabilities、turnOpportunityValue、turnTimingFactor。

边界与不变量
只为候选展开排序；既有基础值、0.65 折扣与座次因子不得进入 final transition。
*/
export function sealUseValue(actor, target, state) {
  if (!actor?.alive || !target?.alive
    || target.battleTeam === actor.battleTeam || hasSeal(target)) {
    return -50;
  }
  const futureTarget = {
    ...target,
    statuses:[...new Set([...(Array.isArray(target.statuses) ? target.statuses : []), "sealed"])],
    sealedStatusStateBranches:[{ probability:1, conditions:{}, present:true }]
  };
  const skipAction = sealOutcomeProbabilities(state, futureTarget).skipAction;
  return (CARD_DEFINITIONS.seal?.aiValue ?? 7)
    + skipAction * turnOpportunityValue(target) * FUTURE_DISCOUNT
      * turnTimingFactor(state, actor, target);
}
