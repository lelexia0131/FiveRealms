/**
 * 封印的 AI 共享纯计算：只读取过滤后的状态、反制概率与剩余牌类别计数，
 * 不实例化匿名判定牌，也不修改 remainingCardCounts 根先验。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260814-ai-policy-domain";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260814-ai-policy-domain";
import {
  PROBABILITY_EPSILON,
  clampProbability
} from "./state/Probability.js?build=20260814-ai-policy-domain";
import {
  hasSeal,
  sealOutcomeProbabilities
} from "./domain/SealModel.js?build=20260814-ai-policy-domain";

export {
  getSealStatusStateBranches,
  hasSeal,
  sealCounterProbability,
  sealOutcomeProbabilities,
  sealPresenceProbability,
  tacticJudgmentProbability
} from "./domain/SealModel.js?build=20260814-ai-policy-domain";
export {
  sealDelayCost,
  sealEarlyUsePenalty
} from "./search/SealTiming.js?build=20260814-ai-policy-domain";

const FUTURE_DISCOUNT = 0.65;
const MIN_TURN_TIMING_FACTOR = 0.7;
const TURN_TIMING_STEP = 0.1;

const availableCardCount = (cards, definitionId) => (Array.isArray(cards) ? cards : [])
  .filter((card) => card?.definitionId === definitionId)
  .reduce((sum, card) => {
    if (Array.isArray(card.availabilityStateBranches)) {
      return sum + card.availabilityStateBranches
        .filter((branch) => branch.available)
        .reduce((total, branch) => total + (Number(branch.probability) || 0), 0);
    }
    if (Array.isArray(card.availabilityBranches)) {
      return sum + card.availabilityBranches
        .reduce((total, branch) => total + (Number(branch.probability) || 0), 0);
    }
    return sum + 1;
  }, 0);

const expectedAssaultResources = (player) => {
  const known = availableCardCount(player?.hand, "assault")
    + availableCardCount(player?.knownCards, "assault");
  return Math.max(0, Number(player?.expectedAssaultCount ?? known) || 0);
};

const nextTurnEnergyBranches = (player) => {
  const current = Math.max(0, Number(player?.energy) || 0);
  const baseGain = Math.max(0, Number(player?.turnEnergyGainWithoutEquipment ?? 1) || 0);
  const equipmentGain = Math.max(0, Number(player?.energyDeviceTurnEnergyGain ?? 1) || 0);
  const cap = Math.max(current, Number(player?.maxEnergy) || current + baseGain + equipmentGain);
  const withoutEquipment = Math.min(cap, current + baseGain);
  if (player?.equipmentDefinitionId !== "energyDevice") {
    return [{ probability:1, energy:withoutEquipment }];
  }
  const retained = clampProbability(player?.equipmentRetentionProbability ?? 1);
  if (retained <= PROBABILITY_EPSILON) return [{ probability:1, energy:withoutEquipment }];
  const withEquipment = Math.min(cap, current + baseGain + equipmentGain);
  if (retained >= 1 - PROBABILITY_EPSILON || withEquipment === withoutEquipment) {
    return [{ probability:1, energy:withEquipment }];
  }
  return [
    { probability:1 - retained, energy:withoutEquipment },
    { probability:retained, energy:withEquipment }
  ];
};

const nextTurnBaseAttackLimit = (player) => {
  const configured = Number(player?.nextTurnBaseAttackLimit);
  if (Number.isFinite(configured)) return Math.max(0, configured);
  const current = Number(player?.attackLimit);
  return Number.isFinite(current) ? Math.max(0, current) : 1;
};

const expectedUsableFromInventory = (inventory, limit, extraAttackProbability) => {
  const count = Math.max(0, Number(inventory) || 0);
  const baseUses = Math.min(count, limit);
  const extraUses = Math.min(1, Math.max(0, count - limit));
  return baseUses + extraUses * extraAttackProbability;
};

/** 从当前行动者之后计算目标前还隔着多少名存活角色。 */
export function turnOrderGap(state, actor, target) {
  if (!actor?.alive || !target?.alive || actor.id === target.id) return Infinity;
  const ring = DistanceSystem.getAliveRing({ state:{ players:state?.players ?? [] } });
  const actorIndex = ring.findIndex((player) => player.id === actor.id);
  const targetIndex = ring.findIndex((player) => player.id === target.id);
  if (actorIndex < 0 || targetIndex < 0 || ring.length < 2) return Infinity;
  const forwardSteps = (targetIndex - actorIndex + ring.length) % ring.length;
  return forwardSteps > 0 ? forwardSteps - 1 : Infinity;
}

/** 下一位为1；每多隔一名存活角色温和折扣0.1，最低保留0.7。 */
export function turnTimingFactor(state, actor, target) {
  const gap = turnOrderGap(state, actor, target);
  return Number.isFinite(gap)
    ? Math.max(MIN_TURN_TIMING_FACTOR, 1 - gap * TURN_TIMING_STEP)
    : MIN_TURN_TIMING_FACTOR;
}

/** 忽略本回合已用次数，按新回合重置后的能量条件估算主动技能可用概率。 */
export function futureSkillReadinessProbability(player) {
  const skillId = player?.activeSkillId;
  const skillCost = Math.max(0, Number(player?.activeSkillCost) || 0);
  const skillLimit = Math.max(0, Number(player?.activeSkillLimit) || 0);
  if (!skillId || skillCost <= 0 || skillLimit <= 0) return 0;
  return clampProbability(nextTurnEnergyBranches(player)
    .filter((branch) => branch.energy + PROBABILITY_EPSILON >= skillCost)
    .reduce((sum, branch) => sum + branch.probability, 0));
}

/** 主动技能当前或经过下一次正常能量阶段后可发动时的行动威胁。 */
export function skillReadinessThreat(player) {
  const readiness = futureSkillReadinessProbability(player);
  if (readiness <= PROBABILITY_EPSILON) return 0;
  const currentEnergy = Math.max(0, Number(player?.energy) || 0);
  const skillCost = Math.max(0, Number(player?.activeSkillCost) || 0);
  return readiness * (2 + (currentEnergy >= skillCost ? 0.5 : 0));
}

/** 攻击库存先受新回合基础次数限制；破军仅在未来可发动的概率世界增加一次容量。 */
export function expectedUsableAssaultsNextTurn(player) {
  const limit = nextTurnBaseAttackLimit(player);
  const extraAttackProbability = player?.activeSkillId === "breakArmy"
    ? futureSkillReadinessProbability(player)
    : 0;
  const distribution = Array.isArray(player?.assaultCountDistribution)
    ? player.assaultCountDistribution.filter((branch) => (
      Number.isFinite(Number(branch?.count)) && Number(branch?.probability) > 0
    ))
    : [];
  const total = distribution.reduce((sum, branch) => sum + Number(branch.probability), 0);
  if (total > PROBABILITY_EPSILON) {
    return distribution.reduce((sum, branch) => (
      sum + Number(branch.probability)
        * expectedUsableFromInventory(branch.count, limit, extraAttackProbability)
    ), 0) / total;
  }
  return expectedUsableFromInventory(
    expectedAssaultResources(player), limit, extraAttackProbability
  );
}

/** 实际可使用机会是主要价值；上限外库存只保留较小的稳定性边际。 */
export function assaultThreat(player) {
  const inventory = expectedAssaultResources(player);
  const usable = expectedUsableAssaultsNextTurn(player);
  const reserve = Math.max(0, inventory - usable);
  return usable * 1.25 + Math.min(2, reserve) * 0.25;
}

/** 攻击职责只放大实际攻击资源；资源接近0时不会产生固定角色排名。 */
export function roleThreatSynergy(player) {
  const resources = Math.min(3, expectedUsableAssaultsNextTurn(player));
  if (resources <= PROBABILITY_EPSILON) return 0;
  const attackTags = (player?.roleTags ?? [])
    .filter((tag) => ["damage", "attacker", "caster", "hunter"].includes(tag)).length;
  return resources * Math.min(0.75, attackTags * 0.3);
}

/** 只让攻击型装备按其存在概率放大已有攻击资源。 */
export function equipmentThreatSynergy(player) {
  const definition = CARD_DEFINITIONS[player?.equipmentDefinitionId];
  if (!definition?.subtypes?.includes("attack")) return 0;
  const resources = Math.min(3, expectedUsableAssaultsNextTurn(player));
  return resources * 0.75 * clampProbability(player?.equipmentRetentionProbability ?? 1);
}

export function turnOpportunityValue(player) {
  const hand = Math.max(0, Number(player?.handCount ?? player?.hand?.length ?? 0) || 0);
  const energy = Math.max(0, Number(player?.energy ?? 0) || 0);
  const generalResources = Math.min(2.5, hand * 0.25 + energy * 0.35);
  return 6 + generalResources + skillReadinessThreat(player) + assaultThreat(player)
    + roleThreatSynergy(player) + equipmentThreatSynergy(player);
}

/** 从 viewerTeam 视角返回封印导致跳过出牌阶段的期望团队负担。 */
export function sealTeamBurden(state, holder, viewerTeam) {
  if (!holder?.alive) return 0;
  const skipAction = sealOutcomeProbabilities(state, holder).skipAction;
  if (skipAction <= PROBABILITY_EPSILON) return 0;
  const sign = holder.battleTeam === viewerTeam ? 1 : -1;
  return skipAction * turnOpportunityValue(holder) * sign;
}

/** 主动使用封印的价值：基础牌值加未来未被反制且判定生效时的出牌机会收益。 */
export function sealUseValue(actor, target, state) {
  if (!actor?.alive || !target?.alive || target.battleTeam === actor.battleTeam || hasSeal(target)) return -50;
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
