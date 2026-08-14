/*
模块职责
派生闪电状态、装备判定概率、存活座位传播环与最终命中分布。

上游
ActionGenerator、Simulator、ResponseBoundary 与 ValueSimulationQuery。

下游
RuleEngine、卡牌定义配置与 state/Probability。

状态边界
只读过滤玩家和剩余牌计数，返回仅含普通值与玩家 ID 的独立结果。

信息边界
不实例化判定牌、不读取敌方隐藏牌面；缺失计数时使用正式初始牌堆构成。

架构约束
本模型不是 Game authority；RuleEngine 是真实状态与接收者规则权威，真实状态移动/伤害仍由 Game 卡牌生命周期负责。不得依赖 Controller、Planner、Simulator、Evaluator、UI 或 value 层。
*/
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../../config/cardConfig.js?build=20260814-ai-code-hygiene-final";
import { RuleEngine } from "../../core/RuleEngine.js?build=20260814-ai-code-hygiene-final";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  mergeProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260814-ai-code-hygiene-final";

/*
功能
判断过滤玩家是否持有闪电状态。

调用方
传播链、正式边界与直接领域测试。

输入
真实 Player 或过滤玩家摘要。

输出
布尔值。

读取状态
玩家 statuses。

写入状态
无。

调用函数
RuleEngine.hasStatus。

边界与不变量
状态含义以 RuleEngine 为权威，本函数不复制写入规则。
*/
export function hasLightning(player) {
  return RuleEngine.hasStatus(player, "lightning");
}

/*
功能
返回玩家闪电状态的完整互斥概率分区。

调用方
ActionGenerator、Simulator 与直接领域测试。

输入
过滤玩家摘要。

输出
规范化的新状态分支数组。

读取状态
lightningStatusStateBranches 或确定性 statuses。

写入状态
无。

调用函数
mergeProbabilityStateBranches、RuleEngine.hasStatus。

边界与不变量
缺少概率分支时退化为概率一的确定状态；输出不复用输入分支对象。
*/
export function getLightningStatusStateBranches(player) {
  if (Array.isArray(player?.lightningStatusStateBranches) && player.lightningStatusStateBranches.length) {
    return mergeProbabilityStateBranches(
      player.lightningStatusStateBranches.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        present:Boolean(branch.present)
      }))
    );
  }
  return [{ probability:1, conditions:{}, present:hasLightning(player) }];
}

/*
功能
计算玩家持有闪电状态的总概率。

调用方
Simulator、Value simulation query 与直接领域测试。

输入
过滤玩家摘要。

输出
零到一的概率。

读取状态
闪电状态分支。

写入状态
无。

调用函数
getLightningStatusStateBranches、totalBranchProbability、clampProbability。

边界与不变量
结果始终有限并位于零到一。
*/
export function lightningPresenceProbability(player) {
  return clampProbability(totalBranchProbability(
    getLightningStatusStateBranches(player).filter((branch) => branch.present)
  ));
}

/*
功能
统计公开剩余判定池中的装备牌数量与合法牌总数。

调用方
equipmentJudgmentProbability、buildLightningHitDistribution。

输入
可选剩余牌计数。

输出
新的 equipment/total 数值对象。

读取状态
CARD_DEFINITIONS 与剩余牌计数。

写入状态
无。

调用函数
无。

边界与不变量
忽略非法定义与非正计数，不修改输入；缺失计数时使用正式初始牌堆。
*/
function judgmentCategoryCounts(remainingCardCounts = null) {
  if (remainingCardCounts && typeof remainingCardCounts === "object" && !Array.isArray(remainingCardCounts)) {
    let equipment = 0;
    let total = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      const value = Number(count);
      if (!Number.isFinite(value) || value <= 0) continue;
      const definition = CARD_DEFINITIONS[definitionId];
      if (!definition) continue;
      total += value;
      if (definition.category === "equipment") equipment += value;
    }
    return { equipment, total };
  }
  const equipmentTotal = Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "equipment")
    .reduce((sum, definition) => sum + definition.count, 0);
  return { equipment:equipmentTotal, total:TOTAL_CARD_COUNT };
}

/*
功能
计算下一张判定牌为装备牌的概率。

调用方
正式边界与直接领域测试。

输入
可选剩余牌计数。

输出
零到一的概率。

读取状态
公开剩余判定池类别数量。

写入状态
无。

调用函数
judgmentCategoryCounts。

边界与不变量
空池返回零，输入保持只读。
*/
export function equipmentJudgmentProbability(remainingCardCounts = null) {
  const { equipment, total } = judgmentCategoryCounts(remainingCardCounts);
  return total > 0 ? Math.max(0, Math.min(1, equipment / total)) : 0;
}

/*
功能
返回真实规则确定的下一名闪电接收者 ID。

调用方
ResponseBoundary 与直接领域测试。

输入
座位顺序玩家数组与当前持有者。

输出
下一接收者 ID；不存在时为 null。

读取状态
alive、seatIndex、id 与 lightning status。

写入状态
无。

调用函数
RuleEngine.nextLightningReceiver。

边界与不变量
接收者规则以 RuleEngine 为权威；输出不得持有 Player 引用。
*/
export function nextLightningReceiverId(players, holder) {
  return RuleEngine.nextLightningReceiver(players, holder)?.id ?? null;
}

/*
功能
构造闪电在当前存活座位环的一圈合法持有者 ID 顺序。

调用方
buildLightningHitDistribution、正式边界与直接领域测试。

输入
座位顺序玩家数组与初始持有者。

输出
以初始持有者开头的新 ID 数组。

读取状态
玩家 alive、seatIndex、id 与 lightning status。

写入状态
无。

调用函数
hasLightning。

边界与不变量
跳过死亡者和已有闪电者；输出不含 Player 引用且最多包含每名玩家一次。
*/
export function buildLightningPropagationChainIds(players, initialHolder) {
  if (!initialHolder?.alive || !Array.isArray(players) || !players.length) return [];
  const chainIds = [initialHolder.id];
  const count = players.length;
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = players[(initialHolder.seatIndex + offset) % count];
    if (!candidate?.alive || candidate.id === initialHolder.id) continue;
    if (hasLightning(candidate)) continue;
    chainIds.push(candidate.id);
  }
  return chainIds;
}

/*
功能
按无放回判定与存活座位环计算闪电最终命中各持有者的概率。

调用方
ValueSimulationQuery、正式边界与直接领域测试。

输入
含 players/remainingCardCounts 的过滤状态与初始持有者。

输出
只含 holderId、hop、probability 的独立结果数组。

读取状态
公开剩余牌类别计数与合法持有者座位环。

写入状态
无。

调用函数
buildLightningPropagationChainIds、judgmentCategoryCounts。

边界与不变量
有装备牌且链非空时概率质量为一；无装备牌时为空，不猜测重洗；输出不含 Game/Player 引用。
*/
export function buildLightningHitDistribution(state, initialHolder) {
  const chainIds = buildLightningPropagationChainIds(state?.players, initialHolder);
  const counts = judgmentCategoryCounts(state?.remainingCardCounts);
  if (!chainIds.length || counts.equipment <= PROBABILITY_EPSILON || counts.total <= 0) return [];
  const outcomeProbability = new Map(chainIds.map((holderId) => [holderId, 0]));
  let remainingTotal = counts.total;
  let reachProbability = 1;
  let drawIndex = 0;
  while (remainingTotal > 0 && reachProbability > PROBABILITY_EPSILON) {
    const hitProbability = Math.max(0, Math.min(1, counts.equipment / remainingTotal));
    const holderId = chainIds[drawIndex % chainIds.length];
    outcomeProbability.set(
      holderId,
      (outcomeProbability.get(holderId) ?? 0) + reachProbability * hitProbability
    );
    reachProbability *= 1 - hitProbability;
    remainingTotal -= 1;
    drawIndex += 1;
  }
  return chainIds.map((holderId, hop) => ({
    holderId,
    hop,
    probability:outcomeProbability.get(holderId) ?? 0
  })).filter((outcome) => outcome.probability > PROBABILITY_EPSILON);
}
