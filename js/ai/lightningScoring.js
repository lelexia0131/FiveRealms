/**
 * 闪电的 AI 共享纯计算：状态检查、剩余装备类别概率、下一接收者查找与期望负担。
 * 只读取公开/过滤后的字段，不实例化匿名判定牌，不修改 remainingCardCounts 根先验。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260814-spirit-medic-heal-economics";
import { RuleEngine } from "../core/RuleEngine.js?build=20260814-spirit-medic-heal-economics";
import { PROBABILITY_EPSILON, clampProbability, mergeProbabilityStateBranches, totalBranchProbability } from "./AiProbabilityBranches.js?build=20260814-spirit-medic-heal-economics";

export function hasLightning(player) {
  return RuleEngine.hasStatus(player, "lightning");
}

/** 返回玩家闪电状态的完整概率分区；无概率分支时回退为确定性状态。 */
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
  return [{ probability:1, conditions:{}, present:RuleEngine.hasStatus(player, "lightning") }];
}

/** 返回 P(lightning present)，范围 [0,1]。 */
export function lightningPresenceProbability(player) {
  return clampProbability(totalBranchProbability(
    getLightningStatusStateBranches(player).filter((branch) => branch.present)
  ));
}

/** 返回当前可见剩余牌中的装备牌数与总数；无动态计数时回退初始牌库构成。 */
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

/** 剩余装备类别概率：装备牌剩余数量 / 剩余未知牌总数；无动态计数时回退固定初始密度。 */
export function equipmentJudgmentProbability(remainingCardCounts = null) {
  const { equipment, total } = judgmentCategoryCounts(remainingCardCounts);
  return total > 0 ? Math.max(0, Math.min(1, equipment / total)) : 0;
}

export function nextLightningReceiver(players, holder) {
  return RuleEngine.nextLightningReceiver(players, holder);
}

/**
 * 构造一枚移动闪电当前可达的一圈持有者顺序。真实规则没有最大流转次数，
 * 因此这里只列一圈；无限次绕环的命中概率由 buildLightningHitDistribution
 * 解析求和，而不是把一圈误当成状态自然终止。
 */
export function buildLightningPropagationChain(players, initialHolder) {
  if (!initialHolder?.alive || !Array.isArray(players) || !players.length) return [];
  const chain = [initialHolder];
  const count = players.length;
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = players[(initialHolder.seatIndex + offset) % count];
    if (!candidate?.alive || candidate.id === initialHolder.id) continue;
    if (hasLightning(candidate)) continue;
    chain.push(candidate);
  }
  return chain;
}

/**
 * 当前座位环稳定时，返回闪电最终命中每名 holder 的概率。判定牌离开牌堆后
 * 才进入弃牌堆，因此连续未命中会逐张消耗非装备牌；这里按剩余类别数量做
 * 无放回传播，直到第一张装备牌命中，并把每次未命中后的下一次判定交给真实
 * 顺时针 holder。顺序因此会直接改变风险分布，且无需任意跳数折扣或最大步数。
 * 若当前可见剩余牌没有装备牌，不猜测后续玩家出牌与重洗造成的新构成。
 */
export function buildLightningHitDistribution(state, initialHolder) {
  const chain = buildLightningPropagationChain(state?.players, initialHolder);
  const counts = judgmentCategoryCounts(state?.remainingCardCounts);
  if (!chain.length || counts.equipment <= PROBABILITY_EPSILON || counts.total <= 0) return [];
  const outcomeProbability = new Map(chain.map((holder) => [holder.id, 0]));
  let remainingTotal = counts.total;
  let reachProbability = 1;
  let drawIndex = 0;
  while (remainingTotal > 0 && reachProbability > PROBABILITY_EPSILON) {
    const hitProbability = Math.max(0, Math.min(1, counts.equipment / remainingTotal));
    const holder = chain[drawIndex % chain.length];
    outcomeProbability.set(
      holder.id,
      (outcomeProbability.get(holder.id) ?? 0) + reachProbability * hitProbability
    );
    reachProbability *= 1 - hitProbability;
    remainingTotal -= 1;
    drawIndex += 1;
  }
  return chain.map((holder, hop) => ({
    holder,
    hop,
    probability:outcomeProbability.get(holder.id) ?? 0
  })).filter((outcome) => outcome.probability > PROBABILITY_EPSILON);
}
