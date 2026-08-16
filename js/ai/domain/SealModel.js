/*
模块职责
派生封印状态、判定类别、团队反制输入与先反制后判定的生命周期概率；本模块是 AI probabilistic/search model，不是 Repository Domain Rule authority。

上游
ActionGenerator、Simulator、ResponseBoundary 与 Seal value 查询。

下游
Domain StatusRules、Domain Card/Ruleset Definitions 与 state/Probability。

状态边界
只读过滤玩家、反制概率和剩余牌计数，返回独立普通值。

信息边界
不实例化判定牌、不读取隐藏牌面；缺失计数时使用 RulesetDefinition 正式初始牌堆构成。

架构约束
确定性状态存在由 Domain StatusRules 解释；本模型只拥有封印概率生命周期。不得包含回合机会价值、封印负担、使用价值或搜索延迟，也不得依赖 Controller、Planner、Simulator、Evaluator、UI 或 value 层。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js?build=20260815-shadow-agent-p1-slot";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js?build=20260815-shadow-agent-p1-slot";
import { hasStatus } from "../../domain/rules/status/StatusRules.js?build=20260815-shadow-agent-p1-slot";
import { projectRulePlayer } from "../state/RuleProjection.js?build=20260815-shadow-agent-p1-slot";
import {
  clampProbability,
  mergeProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260815-shadow-agent-p1-slot";

/*
功能
判断过滤玩家是否持有封印状态。

调用方
状态分支、正式边界与直接领域测试。

输入
真实 Player 或过滤玩家摘要。

输出
布尔值。

读取状态
玩家 statuses。

写入状态
无。

调用函数
Domain StatusRules.hasStatus。

边界与不变量
状态含义以 Domain StatusRules 为权威，本函数不复制写入规则。
*/
export function hasSeal(player) {
  return hasStatus(projectRulePlayer(player), "sealed");
}

/*
功能
返回玩家封印状态的完整互斥概率分区。

调用方
ActionGenerator、Simulator 与直接领域测试。

输入
过滤玩家摘要。

输出
规范化的新状态分支数组。

读取状态
sealedStatusStateBranches 或确定性 statuses。

写入状态
无。

调用函数
mergeProbabilityStateBranches、hasSeal。

边界与不变量
缺少概率分支时退化为概率一的确定状态；输出不复用输入分支对象。
*/
export function getSealStatusStateBranches(player) {
  if (Array.isArray(player?.sealedStatusStateBranches) && player.sealedStatusStateBranches.length) {
    return mergeProbabilityStateBranches(
      player.sealedStatusStateBranches.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        present:Boolean(branch.present)
      }))
    );
  }
  return [{ probability:1, conditions:{}, present:hasSeal(player) }];
}

/*
功能
计算玩家持有封印状态的总概率。

调用方
Simulator、value adapter 与直接领域测试。

输入
过滤玩家摘要。

输出
零到一的概率。

读取状态
封印状态分支。

写入状态
无。

调用函数
getSealStatusStateBranches、totalBranchProbability、clampProbability。

边界与不变量
结果始终有限并位于零到一。
*/
export function sealPresenceProbability(player) {
  return clampProbability(totalBranchProbability(
    getSealStatusStateBranches(player).filter((branch) => branch.present)
  ));
}

/*
功能
计算公开剩余判定池中战术牌的概率。

调用方
sealOutcomeProbabilities、ResponseBoundary 与直接领域测试。

输入
可选剩余牌计数。

输出
零到一的概率。

读取状态
CARD_DEFINITIONS、TOTAL_CARD_COUNT 与公开剩余牌计数。

写入状态
无。

调用函数
clampProbability。

边界与不变量
忽略非法定义与非正计数，不修改输入；缺失计数时回退正式初始牌堆。
*/
export function tacticJudgmentProbability(remainingCardCounts = null) {
  const triggerCategory = CARD_DEFINITIONS.seal.judgmentTriggerCategory;
  if (remainingCardCounts && typeof remainingCardCounts === "object" && !Array.isArray(remainingCardCounts)) {
    let tactic = 0;
    let total = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      const value = Number(count);
      if (!Number.isFinite(value) || value <= 0) continue;
      const definition = CARD_DEFINITIONS[definitionId];
      if (!definition) continue;
      total += value;
      if (definition.category === triggerCategory) tactic += value;
    }
    return total > 0 ? clampProbability(tactic / total) : 0;
  }
  const deckComposition = RULESET_DEFINITION.deckComposition;
  const tacticTotal = Object.entries(deckComposition)
    .filter(([definitionId]) => CARD_DEFINITIONS[definitionId]?.category === triggerCategory)
    .reduce((sum, [, count]) => sum + count, 0);
  const total = Object.values(deckComposition).reduce((sum, count) => sum + count, 0);
  return total > 0 ? tacticTotal / total : 0;
}

/*
功能
估算封印触发时持有者阵营至少拥有一张反制的概率。

调用方
sealOutcomeProbabilities、正式边界与直接领域测试。

输入
过滤状态与封印持有者。

输出
零到一的团队反制概率。

读取状态
存活同阵营玩家的 counterProbability。

写入状态
无。

调用函数
clampProbability。

边界与不变量
不同队友的公开反制容量概率沿用既有独立近似；死亡持有者返回零。
*/
export function sealCounterProbability(state, holder) {
  if (!holder?.alive) return 0;
  const noCounter = (state?.players ?? [])
    .filter((player) => player.alive && player.battleTeam === holder.battleTeam)
    .reduce((probability, player) => probability * (1 - clampProbability(player.counterProbability ?? 0)), 1);
  return clampProbability(1 - noCounter);
}

/*
功能
汇总封印先反制、未反制再判定且最终清除的互斥生命周期概率。

调用方
value adapter、正式边界与直接领域测试。

输入
过滤状态与封印持有者。

输出
冻结的 present/countered/judgment/success/skipAction/cleared 概率对象。

读取状态
封印存在概率、团队反制概率与剩余判定池类别概率。

写入状态
无。

调用函数
sealPresenceProbability、sealCounterProbability、tacticJudgmentProbability。

边界与不变量
countered、success、skipAction 互斥且总和等于 present；状态无论判定结果均清除。
*/
export function sealOutcomeProbabilities(state, holder) {
  const present = sealPresenceProbability(holder);
  const counter = sealCounterProbability(state, holder);
  const tactic = tacticJudgmentProbability(state?.remainingCardCounts);
  const judgment = present * (1 - counter);
  return Object.freeze({
    present,
    countered:present * counter,
    judgment,
    success:judgment * tactic,
    skipAction:judgment * (1 - tactic),
    cleared:present
  });
}
