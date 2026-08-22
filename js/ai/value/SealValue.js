/*
模块职责
把封印领域的跳过出牌概率转换为 State Value 中唯一的团队负担项。

上游
Evaluator 与 ValueLedger。

下游
domain/SealModel 与 value/ThreatValue。

状态边界
只读过滤后的 SearchState 与封印持有者，不写状态。

信息边界
只使用公开封印状态和合法剩余牌概率摘要。

架构约束
只拥有 STATE_VALUE 投影；不拥有封印概率、搜索先验或 sibling timing。
*/
import { sealOutcomeProbabilities } from "../domain/SealModel.js";
import {
  PROBABILITY_EPSILON,
  joinProbabilityStateBranchesCooperatively
} from "../state/Probability.js";
import { turnOpportunityValue } from "./ThreatValue.js";

/*
功能
为 State Value 的封印负担构造继承父搜索预算的 cooperative join 能力。

调用方
sealTeamBurden。

输入
可选父 SearchBudget。

输出
无预算时返回 undefined；有预算时返回兼容 SealModel 注入签名的 join 函数。

读取状态
SearchBudget 当前停止原因与 deadline。

写入状态
SearchBudget 首次过期时写入停止原因。

调用函数
joinProbabilityStateBranchesCooperatively、SearchBudget.checkpointCurrentWork。

边界与不变量
只提供 cooperative unwind；正常完成结果必须与 Domain raw join 完全一致。
*/
function sealValueJoinCapability(searchBudget) {
  if (!searchBudget) return undefined;
  return (...partitions) => joinProbabilityStateBranchesCooperatively(
    partitions,
    () => searchBudget.checkpointCurrentWork()
  );
}

/*
功能
从 viewer 阵营视角计算封印导致跳过出牌阶段的期望团队负担。

调用方
Evaluator.stateUtility 与 ValueLedger.ownerStateLedger。

输入
过滤状态、封印持有者、viewer 阵营与可选父 SearchBudget。

输出
带阵营符号的期望负担值。

读取状态
封印结算概率与持有者出牌机会价值。

写入状态
无。

调用函数
sealOutcomeProbabilities、sealValueJoinCapability、turnOpportunityValue。

边界与不变量
盟友负担为正、敌方负担为负，调用方统一以减法计入 State Value；
父搜索存在时团队反制 join 必须 cooperative abort 整个 partial candidate。
*/
export function sealTeamBurden(state, holder, viewerTeam, searchBudget = null) {
  if (!holder?.alive) return 0;
  const skipAction = sealOutcomeProbabilities(
    state,
    holder,
    sealValueJoinCapability(searchBudget)
  ).skipAction;
  if (skipAction <= PROBABILITY_EPSILON) return 0;
  const sign = holder.battleTeam === viewerTeam ? 1 : -1;
  return skipAction * turnOpportunityValue(holder) * sign;
}
