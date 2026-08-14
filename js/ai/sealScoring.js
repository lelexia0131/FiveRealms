/**
 * 封印的 AI 共享纯计算：只读取过滤后的状态、反制概率与剩余牌类别计数，
 * 不实例化匿名判定牌，也不修改 remainingCardCounts 根先验。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260814-guardian-aid-discard";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260814-guardian-aid-discard";
import { RuleEngine } from "../core/RuleEngine.js?build=20260814-guardian-aid-discard";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  mergeProbabilityStateBranches,
  totalBranchProbability
} from "./AiProbabilityBranches.js?build=20260814-guardian-aid-discard";

const FUTURE_DISCOUNT = 0.65;
const MIN_TURN_TIMING_FACTOR = 0.7;
const TURN_TIMING_STEP = 0.1;
/** 封印软性后置 penalty 的既有合理上限：timing cost 不无限放大。 */
const SEAL_EARLY_USE_CAP = 3;

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

/** 从 viewerTeam 视角返回封印导致跳过出牌阶段的期望团队负担。 */
export function sealTeamBurden(state, holder, viewerTeam) {
  if (!holder?.alive) return 0;
  const skipAction = sealOutcomeProbabilities(state, holder).skipAction;
  if (skipAction <= PROBABILITY_EPSILON) return 0;
  const sign = holder.battleTeam === viewerTeam ? 1 : -1;
  return skipAction * turnOpportunityValue(holder) * sign;
}

/**
 * 把“最佳非封印即时动作已除 depth 的 base transition（S = U/d）”按真实搜索
 * depth 折算为封印软性后置的 delayCost：现在先封印会令该动作从 depth d 延迟到
 * d+1，损失 U/d - U/(d+1) = S/(d+1)。由 AiPlanner 在物化同层候选后调用，
 * 保证正式测试可直接覆盖生产路径的 depth 关系（depth=1 → /2、depth=2 → /3）。
 */
export function sealDelayCost(alternativeTransitionScore, depth) {
  return Number(alternativeTransitionScore) / (Number(depth) + 1);
}

/**
 * 封印软性后置的通用 timing helper：把 delayCost 转成 penalty。
 *
 * delayCost 由 sealDelayCost 按真实 depth 计算（S/(d+1)）。非正或非法 delayCost
 * 返回 0，只对 timing cost 设既有合理上限。不读取 recover/shield/assault、
 * hp/missingHp 或 card definitions，也不与 seal.aiValue 重新比较。
 */
export function sealEarlyUsePenalty(delayCost) {
  const cost = Number(delayCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return Math.min(SEAL_EARLY_USE_CAP, cost);
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
