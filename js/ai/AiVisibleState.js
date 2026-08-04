/**
 * 本文件建立 AI 合法可见状态，依赖完整 GameState 但会过滤其他角色的手牌内容。
 * AIController 必须通过此视图评估敌人；即使完整状态在同一内存中，也不能读取隐藏牌定义。
 * 技能合法窥见的牌只以 knownCardDefinitionIds 暴露，不会写入公开日志。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260804-public-pool-alias-sync-v61";

const probabilityAtLeast = (trials, probability, required) => {
  if (required <= 0) return 1;
  if (trials < required || probability <= 0) return 0;
  let below = 0;
  for (let successes = 0; successes < required; successes += 1) {
    let combinations = 1;
    for (let index = 1; index <= successes; index += 1) combinations = combinations * (trials - index + 1) / index;
    below += combinations * probability ** successes * (1 - probability) ** (trials - successes);
  }
  return Math.max(0, Math.min(1, 1 - below));
};

const binomialCountDistribution = (trials, probability, offset = 0) => {
  const count = Math.max(0, Math.floor(Number(trials) || 0));
  const chance = Math.max(0, Math.min(1, Number(probability) || 0));
  if (!count || chance <= 0) return [{ count:Math.max(0, offset), probability:1 }];
  if (chance >= 1) return [{ count:Math.max(0, offset + count), probability:1 }];
  const branches = [];
  let combinations = 1;
  for (let successes = 0; successes <= count; successes += 1) {
    if (successes > 0) combinations = combinations * (count - successes + 1) / successes;
    branches.push({
      count:Math.max(0, offset + successes),
      probability:combinations * chance ** successes * (1 - chance) ** (count - successes)
    });
  }
  const total = branches.reduce((sum, branch) => sum + branch.probability, 0);
  return branches.map((branch) => ({ ...branch, probability:branch.probability / total }));
};

const estimateCard = (viewer, player, definitionId) => {
  if (player.id === viewer.id) {
    const count = player.hand.filter((card) => card.definitionId === definitionId).length;
    return {
      expected:count,
      atLeastOne:count > 0 ? 1 : 0,
      atLeastTwo:count > 1 ? 1 : 0,
      distribution:[{ count, probability:1 }]
    };
  }
  const known = Object.values(viewer.aiMemory.knownCardsByPlayer[player.id] ?? {});
  const knownCount = known.filter((id) => id === definitionId).length;
  const unknownCount = Math.max(0, player.hand.length - known.length);
  const density = (CARD_DEFINITIONS[definitionId]?.count ?? 0) / TOTAL_CARD_COUNT;
  return {
    expected: knownCount + unknownCount * density,
    atLeastOne: knownCount > 0 ? 1 : probabilityAtLeast(unknownCount, density, 1),
    atLeastTwo: knownCount >= 2 ? 1 : probabilityAtLeast(unknownCount, density, 2 - knownCount),
    distribution:binomialCountDistribution(unknownCount, density, knownCount)
  };
};

/**
 * 创建指定 AI 的只读快照。
 * @param {string} viewerId 观察者玩家 ID。
 * @param {Object} state 完整游戏状态。
 * @returns {Object} 不含他人具体手牌对象的可见状态。
 */
export function createAiVisibleState(viewerId, state) {
  const viewer = state.players.find((player) => player.id === viewerId);
  if (!viewer) throw new Error("AI 可见状态缺少观察者");
  return Object.freeze({
    gameId: state.gameId,
    currentRound: state.currentRound,
    phase: state.phase,
    playPhaseEnded: false,
    deckCount: state.deck.cards.length,
    discardCount: state.deck.discardPile.length,
    discardDefinitionIds: state.deck.discardPile.map((card) => card.definitionId),
    judgmentDefinitionIds: state.deck.judgmentZone.map((card) => card.definitionId),
    publicPool: (state.publicCardPool ?? []).map((card) => ({ id:card.id, definitionId:card.definitionId })),
    players: state.players.map((player) => {
      const recoverEstimate = estimateCard(viewer, player, "recover");
      const blockEstimate = estimateCard(viewer, player, "block");
      const counterEstimate = estimateCard(viewer, player, "counter");
      const assaultEstimate = estimateCard(viewer, player, "assault");
      const activeSkillId = player.general.activeSkillIds[0] ?? null;
      const activeSkillUses = player.turnFlags.activeSkillUseCounts?.[activeSkillId] ?? 0;
      const activeSkillLimit = player.general.activeLimitPerTurn ?? 1;
      return Object.freeze({
      id: player.id,
      seatIndex: player.seatIndex,
      name: player.name,
      controllerType: player.controllerType,
      battleTeam: player.battleTeam,
      generalId: player.generalId,
      tags: [...player.general.tags],
      roleTags: [...(player.general.roleTags ?? [])],
      hp: player.hp,
      maxHp: player.maxHp,
      shield: player.shield,
      shieldBranches:[{ probability:1, conditions:{}, amount:player.shield }],
      energy: player.energy,
      energyBranches:[{ probability:1, conditions:{}, amount:player.energy }],
      maxEnergy: player.maxEnergy,
      attackRange: player.attackRange,
      attackUsed: player.turnFlags.attackUsed,
      attackLimit: player.turnFlags.attackLimit,
      attackUseSlots:Array.from(
        { length:Math.max(0, player.turnFlags.attackLimit) },
        (_, index) => [{
          probability:1,
          conditions:{},
          available:index >= player.turnFlags.attackUsed
        }]
      ),
      recoverUsed: player.turnFlags.recoverUsed,
      recoverLimit: player.turnFlags.recoverLimit,
      momentum: player.turnFlags.momentum ?? 0,
      categoriesUsed: [...(player.turnFlags.categoriesUsed ?? [])],
      categoryUsedProbabilities: Object.fromEntries(["basic","tactic","equipment"]
        .map((category) => [category, player.turnFlags.categoriesUsed?.has(category) ? 1 : 0])),
      guardianAidUsedProbability: player.roundFlags.guardianAidUsed ? 1 : 0,
      spyGapTriggeredProbability: player.turnFlags.spyGapTriggered ? 1 : 0,
      gambleTriggered: Boolean(player.turnFlags.gambleTriggered),
      gambleTriggeredProbability: player.turnFlags.gambleTriggered ? 1 : 0,
      coordinationTriggered: Boolean(player.turnFlags.coordinationTriggered),
      coordinationTriggeredProbability: player.turnFlags.coordinationTriggered ? 1 : 0,
      rejuvenationUsed: Boolean(player.turnFlags.rejuvenationUsed),
      exposeWeaknessStacks: player.statuses.exposeWeakness?.stacks ?? 0,
      assaultBonus: player.statuses.allIn?.assaultBonus ?? 0,
      activeSkillId,
      activeSkillCost: player.general.activeCost ?? 0,
      activeSkillUses,
      activeSkillLimit,
      activeSkillUsed: activeSkillUses >= activeSkillLimit,
      activeSkillAvailabilityBranches:Array.from(
        { length:Math.max(0, activeSkillLimit - activeSkillUses) },
        () => [{ probability:1, conditions:{} }]
      ),
      activeSkillUseSlots:Array.from(
        { length:Math.max(0, activeSkillLimit) },
        (_, index) => [{
          probability:1,
          conditions:{},
          available:index >= activeSkillUses
        }]
      ),
      recycleDeviceUses: player.turnFlags.recycleDeviceUses ?? 0,
      trackingTargetIds: [...(player.turnFlags.trackingTargetIds ?? [])],
      trackingUses: player.turnFlags.trackingTargetIds?.size ?? 0,
      huntMarkSourceId: player.statuses.huntMark?.sourceId ?? null,
      huntMarkProbability: player.statuses.huntMark ? 1 : 0,
      huntMarkProbabilities: player.statuses.huntMark
        ? { [player.statuses.huntMark.sourceId]:1 }
        : {},
      huntMarkStateBranchesBySource:player.statuses.huntMark
        ? { [player.statuses.huntMark.sourceId]:[{ probability:1, conditions:{}, marked:true }] }
        : {},
      expectedInformationGain: 0,
      alive: player.alive,
      handCount: player.hand.length,
      hand: player.id === viewerId ? player.hand.map((card) => ({
        id:card.id,
        definitionId:card.definitionId,
        availabilityBranches:[{ probability:1, conditions:{} }],
        availabilityStateBranches:[{ probability:1, conditions:{}, available:true }]
      })) : undefined,
      knownCards: player.id === viewerId ? undefined : Object.entries(viewer.aiMemory.knownCardsByPlayer[player.id] ?? {}).map(([cardId, definitionId]) => ({ cardId, definitionId })),
      equipmentDefinitionId: player.equipment?.definitionId ?? null,
      equipmentRetentionProbability: player.equipment ? 1 : 0,
      initialEquipmentValue: player.equipment ? (CARD_DEFINITIONS[player.equipment.definitionId]?.aiValue ?? 7) : 0,
      expectedEquipmentGain: 0,
      statuses: Object.keys(player.statuses),
      expectedRecoverCount: recoverEstimate.expected,
      blockProbability: blockEstimate.atLeastOne,
      twoBlockProbability: blockEstimate.atLeastTwo,
      counterProbability: counterEstimate.atLeastOne,
      expectedAssaultCount: assaultEstimate.expected,
      assaultResponseProbability: assaultEstimate.atLeastOne,
      assaultCountDistribution: assaultEstimate.distribution
    });
    })
  });
}
