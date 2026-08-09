/**
 * 封印的 AI 共享纯计算：只读取过滤后的状态、反制概率与剩余牌类别计数，
 * 不实例化匿名判定牌，也不修改 remainingCardCounts 根先验。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260809-lightning-hit-copy-v122";
import { RuleEngine } from "../core/RuleEngine.js?build=20260809-lightning-hit-copy-v122";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  mergeProbabilityStateBranches,
  totalBranchProbability
} from "./AiProbabilityBranches.js?build=20260809-lightning-hit-copy-v122";

const FUTURE_DISCOUNT = 0.65;

export function hasSeal(player) {
  return RuleEngine.hasStatus(player, "sealed");
}

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

export function sealPresenceProbability(player) {
  return clampProbability(totalBranchProbability(
    getSealStatusStateBranches(player).filter((branch) => branch.present)
  ));
}

/** 战术牌剩余数量 / 剩余未知牌总数；缺少动态计数时回退正式初始牌堆。 */
export function tacticJudgmentProbability(remainingCardCounts = null) {
  if (remainingCardCounts && typeof remainingCardCounts === "object" && !Array.isArray(remainingCardCounts)) {
    let tactic = 0;
    let total = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      const value = Number(count);
      if (!Number.isFinite(value) || value <= 0) continue;
      const definition = CARD_DEFINITIONS[definitionId];
      if (!definition) continue;
      total += value;
      if (definition.category === "tactic") tactic += value;
    }
    return total > 0 ? clampProbability(tactic / total) : 0;
  }
  const tacticTotal = Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "tactic")
    .reduce((sum, definition) => sum + definition.count, 0);
  return TOTAL_CARD_COUNT > 0 ? tacticTotal / TOTAL_CARD_COUNT : 0;
}

/** 估算封印触发时，持有者或其存活队友至少拥有一张反制的概率。 */
export function sealCounterProbability(state, holder) {
  if (!holder?.alive) return 0;
  const noCounter = (state?.players ?? [])
    .filter((player) => player.alive && player.battleTeam === holder.battleTeam)
    .reduce((probability, player) => probability * (1 - clampProbability(player.counterProbability ?? 0)), 1);
  return clampProbability(1 - noCounter);
}

export function turnOpportunityValue(player) {
  const hand = Math.max(0, Number(player?.handCount ?? player?.hand?.length ?? 0) || 0);
  const energy = Math.max(0, Number(player?.energy ?? 0) || 0);
  return 6 + Math.min(4, hand * 0.4 + energy * 0.6);
}

/**
 * 封印未来触发的互斥概率摘要：先反制，未反制才判定；两种判定分支均消费状态。
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

/** 从 viewerTeam 视角返回封印导致失去行动阶段的期望团队负担。 */
export function sealTeamBurden(state, holder, viewerTeam) {
  if (!holder?.alive) return 0;
  const skipAction = sealOutcomeProbabilities(state, holder).skipAction;
  if (skipAction <= PROBABILITY_EPSILON) return 0;
  const sign = holder.battleTeam === viewerTeam ? 1 : -1;
  return skipAction * turnOpportunityValue(holder) * sign;
}

/** 主动使用封印的价值：基础牌值加未来未被反制且判定失败时的行动机会收益。 */
export function sealUseValue(actor, target, state) {
  if (!actor?.alive || !target?.alive || target.battleTeam === actor.battleTeam || hasSeal(target)) return -50;
  const futureTarget = {
    ...target,
    statuses:[...new Set([...(Array.isArray(target.statuses) ? target.statuses : []), "sealed"])],
    sealedStatusStateBranches:[{ probability:1, conditions:{}, present:true }]
  };
  const skipAction = sealOutcomeProbabilities(state, futureTarget).skipAction;
  return (CARD_DEFINITIONS.seal?.aiValue ?? 7)
    + skipAction * turnOpportunityValue(target) * FUTURE_DISCOUNT;
}
