/**
 * 本文件建立 AI 合法可见状态，依赖完整 GameState 但会过滤其他角色的手牌内容。
 * AIController 必须通过此视图评估敌人；即使完整状态在同一内存中，也不能读取隐藏牌定义。
 * 技能合法窥见的牌只以 knownCardDefinitionIds 暴露，不会写入公开日志。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260802-resource-branches-v57";

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

const estimateCard = (viewer, player, definitionId) => {
  if (player.id === viewer.id) {
    const count = player.hand.filter((card) => card.definitionId === definitionId).length;
    return { expected:count, atLeastOne:count > 0 ? 1 : 0, atLeastTwo:count > 1 ? 1 : 0 };
  }
  const known = Object.values(viewer.aiMemory.knownCardsByPlayer[player.id] ?? {});
  const knownCount = known.filter((id) => id === definitionId).length;
  const unknownCount = Math.max(0, player.hand.length - known.length);
  const density = (CARD_DEFINITIONS[definitionId]?.count ?? 0) / TOTAL_CARD_COUNT;
  return {
    expected: knownCount + unknownCount * density,
    atLeastOne: knownCount > 0 ? 1 : probabilityAtLeast(unknownCount, density, 1),
    atLeastTwo: knownCount >= 2 ? 1 : probabilityAtLeast(unknownCount, density, 2 - knownCount)
  };
};

const expectedCountPartition = (playerId, field, expected, maximum) => {
  const value = Math.max(0, Math.min(maximum, Number(expected) || 0));
  const lower = Math.floor(value), upper = Math.ceil(value);
  if (lower === upper) return [{ probability:1, conditions:{}, [field]:lower }];
  const key = `hiddenHand:${playerId}:${field}`;
  return [
    { probability:upper - value, conditions:{ [key]:String(lower) }, [field]:lower },
    { probability:value - lower, conditions:{ [key]:String(upper) }, [field]:upper }
  ];
};

const blockCountPartition = (playerId, estimate) => {
  if (estimate.atLeastOne <= Number.EPSILON) {
    return [{ probability:1, conditions:{}, blockCount:0 }];
  }
  if (estimate.atLeastTwo >= 1 - Number.EPSILON) {
    return [{ probability:1, conditions:{}, blockCount:2 }];
  }
  const none = Math.max(0, 1 - estimate.atLeastOne);
  const one = Math.max(0, estimate.atLeastOne - estimate.atLeastTwo);
  const two = Math.max(0, estimate.atLeastTwo);
  const key = `hiddenHand:${playerId}:blockCount`;
  return [
    { probability:none, conditions:{ [key]:"0" }, blockCount:0 },
    { probability:one, conditions:{ [key]:"1" }, blockCount:1 },
    { probability:two, conditions:{ [key]:"2+" }, blockCount:2 }
  ];
};

/** 未知牌只由公开手牌数和牌库密度生成紧凑数量分支，不读取真实牌定义。 */
const createHandResourceBranches = (viewer, player, estimates) => {
  const handCount = player.hand.length;
  if (player.id === viewer.id) {
    const count = (definitionId) => player.hand.filter((card) => card.definitionId === definitionId).length;
    const blockCount = count("block"), counterCount = count("counter");
    const assaultCount = count("assault"), recoverCount = count("recover");
    return [{
      probability:1, conditions:{}, handCount,
      blockCount, counterCount, assaultCount, recoverCount,
      otherCount:Math.max(0, handCount - blockCount - counterCount - assaultCount - recoverCount)
    }];
  }
  const counterPartition = estimates.counter.atLeastOne <= Number.EPSILON
    ? [{ probability:1, conditions:{}, counterCount:0 }]
    : estimates.counter.atLeastOne >= 1 - Number.EPSILON
      ? [{ probability:1, conditions:{}, counterCount:1 }]
      : [
        { probability:1 - estimates.counter.atLeastOne, conditions:{ [`hiddenHand:${player.id}:counterCount`]:"0" }, counterCount:0 },
        { probability:estimates.counter.atLeastOne, conditions:{ [`hiddenHand:${player.id}:counterCount`]:"1+" }, counterCount:1 }
      ];
  const partitions = [
    ["blockCount", blockCountPartition(player.id, estimates.block)],
    ["counterCount", counterPartition],
    ["assaultCount", expectedCountPartition(player.id, "assaultCount", estimates.assault.expected, handCount)],
    ["recoverCount", expectedCountPartition(player.id, "recoverCount", estimates.recover.expected, handCount)]
  ];
  // Hidden definitions are unknowable. Couple marginal count estimates through one
  // public quantile variable: marginals stay exact while branch count grows linearly.
  const distributions = partitions.map(([field, branches]) => {
    let cumulative = 0;
    return [field, branches.filter((branch) => branch.probability > Number.EPSILON).map((branch) => {
      cumulative += branch.probability;
      return { upper:cumulative, value:branch[field] };
    })];
  });
  const breakpoints = [...new Set([0, 1, ...distributions.flatMap(([, entries]) => entries.map((entry) => entry.upper))])]
    .filter((value) => value >= 0 && value <= 1).sort((left, right) => left - right);
  return breakpoints.slice(0, -1).map((lower, index) => {
    const upper = breakpoints[index + 1], midpoint = (lower + upper) / 2;
    const counts = Object.fromEntries(distributions.map(([field, entries]) => [
      field,
      Math.min(handCount, entries.find((entry) => midpoint <= entry.upper + Number.EPSILON)?.value ?? 0)
    ]));
    return {
      probability:upper - lower,
      conditions:{ [`hiddenHand:${player.id}:resourceWorld`]:String(index) },
      handCount,
      ...counts,
      otherCount:Math.max(0, handCount - counts.blockCount - counts.counterCount
        - counts.assaultCount - counts.recoverCount)
    };
  });
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
      const handResourceBranches = createHandResourceBranches(viewer, player, {
        recover:recoverEstimate,
        block:blockEstimate,
        counter:counterEstimate,
        assault:assaultEstimate
      });
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
      hpBranches:[{ probability:1, conditions:{}, amount:player.hp, alive:player.alive }],
      aliveProbability:player.alive ? 1 : 0,
      deathProbability:player.alive ? 0 : 1,
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
      momentumBranches:[{ probability:1, conditions:{}, amount:player.turnFlags.momentum ?? 0 }],
      categoriesUsed: [...(player.turnFlags.categoriesUsed ?? [])],
      categoryUsedProbabilities: Object.fromEntries(["basic","tactic","equipment"]
        .map((category) => [category, player.turnFlags.categoriesUsed?.has(category) ? 1 : 0])),
      categoryUseStateBranches:Object.fromEntries(["basic","tactic","equipment"].map((category) => [
        category,
        [{ probability:1, conditions:{}, used:Boolean(player.turnFlags.categoriesUsed?.has(category)) }]
      ])),
      guardianAidUsedProbability: player.roundFlags.guardianAidUsed ? 1 : 0,
      guardianAidStateBranches:[{ probability:1, conditions:{}, used:Boolean(player.roundFlags.guardianAidUsed) }],
      spyGapTriggeredProbability: player.turnFlags.spyGapTriggered ? 1 : 0,
      spyGapStateBranches:[{ probability:1, conditions:{}, used:Boolean(player.turnFlags.spyGapTriggered) }],
      rejuvenationUsed: Boolean(player.turnFlags.rejuvenationUsed),
      rejuvenationStateBranches:[{ probability:1, conditions:{}, used:Boolean(player.turnFlags.rejuvenationUsed) }],
      exposeWeaknessStacks: player.statuses.exposeWeakness?.stacks ?? 0,
      exposeWeaknessBranches:[{ probability:1, conditions:{}, amount:player.statuses.exposeWeakness?.stacks ?? 0 }],
      assaultBonus: player.statuses.allIn?.assaultBonus ?? 0,
      assaultBonusBranches:[{ probability:1, conditions:{}, amount:player.statuses.allIn?.assaultBonus ?? 0 }],
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
      recycleUseSlots:Array.from({ length:2 }, (_, index) => [{
        probability:1,
        conditions:{},
        available:index >= (player.turnFlags.recycleDeviceUses ?? 0)
      }]),
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
      handResourceBranches,
      hand: player.id === viewerId ? player.hand.map((card) => ({
        id:card.id,
        definitionId:card.definitionId,
        availabilityBranches:[{ probability:1, conditions:{} }],
        availabilityStateBranches:[{ probability:1, conditions:{}, available:true }]
      })) : undefined,
      knownCards: player.id === viewerId ? undefined : Object.entries(viewer.aiMemory.knownCardsByPlayer[player.id] ?? {}).map(([cardId, definitionId]) => ({ cardId, definitionId })),
      equipmentDefinitionId: player.equipment?.definitionId ?? null,
      equipmentRetentionProbability: player.equipment ? 1 : 0,
      equipmentStateBranches:[{
        probability:1,
        conditions:{},
        definitionId:player.equipment?.definitionId ?? null,
        present:Boolean(player.equipment)
      }],
      expectedEquipmentGain: 0,
      statuses: Object.keys(player.statuses),
      expectedRecoverCount: recoverEstimate.expected,
      blockProbability: blockEstimate.atLeastOne,
      twoBlockProbability: blockEstimate.atLeastTwo,
      counterProbability: counterEstimate.atLeastOne,
      expectedAssaultCount: assaultEstimate.expected,
      assaultResponseProbability: assaultEstimate.atLeastOne
    });
    })
  });
}
