/*
模块职责
把 VisibleState、Knowledge、Belief 与已注入领域派生值组合成可克隆的扁平 SearchState。

上游
AI 状态组合入口、Simulator 与状态契约测试。

下游
无。

状态边界
只读不可变状态契约，创建搜索根快照或完全独立的可变克隆。

信息边界
只组合已过滤的公开事实、合法记忆和 Belief，不得访问 GameState。

架构约束
不得计算领域规则或价值；搜索所需扁平字段只在此处组装，克隆不得回读 Game。
*/

const CATEGORIES = Object.freeze(["basic", "tactic", "equipment"]);

/*
功能
创建带空条件集的确定性概率状态分支。

调用方
createSearchPlayer、projectSearchCard。

输入
需要写入分支的状态字段对象。

输出
概率为一的单分支数组。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
确定性初始状态必须只有一个空条件世界。
*/
function certainStateBranch(stateFields) {
  return [{ probability:1, conditions:{}, ...stateFields }];
}

/*
功能
为搜索中的合法已知卡牌附加独立的可用性概率状态。

调用方
createSearchPlayer。

输入
VisibleState 本人卡牌或 Knowledge 已知牌记录。

输出
带完整资源状态与可用分支投影的新卡牌记录。

读取状态
卡牌实体与定义 ID。

写入状态
无。

调用函数
certainStateBranch。

边界与不变量
每张牌初始时恰有一个概率为一的可用世界，且不保留输入对象引用。
*/
function projectSearchCard(card) {
  return {
    ...card,
    availabilityBranches:[{ probability:1, conditions:{} }],
    availabilityStateBranches:certainStateBranch({ available:true })
  };
}

/*
功能
为一名玩家组合 Planner 与 Simulator 所需的扁平 SearchState 记录。

调用方
createSearchState。

输入
VisibleState 玩家、对应 Knowledge/Belief、观察者 ID 与已注入领域派生值。

输出
冻结的 SearchState 玩家根记录，内部概率分支供克隆后变更。

读取状态
VisibleState、Knowledge、BeliefState 与 derivedPlayersById。

写入状态
无。

调用函数
certainStateBranch、projectSearchCard。

边界与不变量
只组装一次搜索记录；不得在此重新计算规则、概率或价值。
*/
function createSearchPlayer(visiblePlayer, knownCards, beliefPlayer, viewerId, derivedPlayer) {
  const categoriesUsed = visiblePlayer.categoriesUsed;
  const activeSkillUses = visiblePlayer.activeSkillUses;
  const activeSkillLimit = visiblePlayer.activeSkillLimit;
  const huntMarkSourceId = visiblePlayer.huntMarkSourceId;
  return Object.freeze({
    ...visiblePlayer,
    shieldBranches:certainStateBranch({ amount:visiblePlayer.shield }),
    energyBranches:certainStateBranch({ amount:visiblePlayer.energy }),
    turnEnergyGainWithoutEquipment:derivedPlayer.turnEnergyGainWithoutEquipment,
    energyDeviceTurnEnergyGain:derivedPlayer.energyDeviceTurnEnergyGain,
    nextTurnBaseAttackLimit:derivedPlayer.nextTurnBaseAttackLimit,
    attackUseSlots:Array.from(
      { length:Math.max(0, visiblePlayer.attackLimit) },
      (_, index) => certainStateBranch({ available:index >= visiblePlayer.attackUsed })
    ),
    momentumBranches:certainStateBranch({ amount:visiblePlayer.momentum }),
    categoryUsedProbabilities:Object.fromEntries(CATEGORIES.map((category) => [
      category,
      categoriesUsed.includes(category) ? 1 : 0
    ])),
    categoryUsedStateBranchesByCategory:Object.fromEntries(CATEGORIES.map((category) => [
      category,
      certainStateBranch({ used:categoriesUsed.includes(category) })
    ])),
    guardianAidUsedProbability:derivedPlayer.guardianAidUsed ? 1 : 0,
    spyGapTriggeredProbability:derivedPlayer.spyGapTriggered ? 1 : 0,
    gambleTriggeredProbability:visiblePlayer.gambleTriggered ? 1 : 0,
    coordinationTriggeredProbability:visiblePlayer.coordinationTriggered ? 1 : 0,
    activeSkillCost:derivedPlayer.activeSkillCost,
    activeSkillAvailabilityBranches:Array.from(
      { length:Math.max(0, activeSkillLimit - activeSkillUses) },
      () => [{ probability:1, conditions:{} }]
    ),
    activeSkillUseSlots:Array.from(
      { length:Math.max(0, activeSkillLimit) },
      (_, index) => certainStateBranch({ available:index >= activeSkillUses })
    ),
    huntMarkProbability:huntMarkSourceId ? 1 : 0,
    huntMarkProbabilities:huntMarkSourceId ? { [huntMarkSourceId]:1 } : {},
    huntMarkStateBranchesBySource:huntMarkSourceId
      ? { [huntMarkSourceId]:certainStateBranch({ marked:true }) }
      : {},
    expectedInformationGain:0,
    hand:visiblePlayer.id === viewerId ? visiblePlayer.hand.map(projectSearchCard) : undefined,
    knownCards:visiblePlayer.id === viewerId ? undefined : knownCards.map(projectSearchCard),
    equipmentRetentionProbability:visiblePlayer.equipmentDefinitionId ? 1 : 0,
    initialEquipmentValue:derivedPlayer.initialEquipmentValue,
    initialEquipmentRoleDelta:derivedPlayer.initialEquipmentRoleDelta,
    expectedEquipmentGain:0,
    expectedEquipmentRoleDelta:0,
    expectedRecoverCount:beliefPlayer.expectedRecoverCount,
    blockProbability:beliefPlayer.blockProbability,
    twoBlockProbability:beliefPlayer.twoBlockProbability,
    blockCountDistribution:beliefPlayer.blockCountDistribution.map((branch) => ({ ...branch })),
    counterCountDistribution:beliefPlayer.counterCountDistribution.map((branch) => ({ ...branch })),
    counterProbability:beliefPlayer.counterProbability,
    expectedAssaultCount:beliefPlayer.expectedAssaultCount,
    assaultResponseProbability:beliefPlayer.assaultResponseProbability,
    assaultCountDistribution:beliefPlayer.assaultCountDistribution.map((branch) => ({ ...branch }))
  });
}

/*
功能
组合四层状态契约为现有搜索链可直接消费的 SearchState 根快照。

调用方
createStateContracts、状态契约测试。

输入
VisibleState、Knowledge、BeliefState 与按玩家 ID 注入的领域派生值。

输出
冻结外壳的扁平 SearchState，供 Planner 读取和 Simulator 克隆。

读取状态
三个不可变状态契约与派生值表。

写入状态
无。

调用函数
createSearchPlayer。

边界与不变量
SearchState 不持有 Game 引用；字段形状由状态契约保持稳定。
*/
export function createSearchState(visibleState, knowledgeState, beliefState, derivedPlayersById = {}) {
  return Object.freeze({
    gameId:visibleState.gameId,
    currentRound:visibleState.currentRound,
    phase:visibleState.phase,
    playPhaseEnded:false,
    remainingCardCounts:beliefState.remainingCardCounts,
    deckCount:visibleState.deckCount,
    discardCount:visibleState.discardCount,
    discardDefinitionIds:visibleState.discardDefinitionIds,
    judgmentDefinitionIds:visibleState.judgmentDefinitionIds,
    publicPool:visibleState.publicPool,
    players:Object.freeze(visibleState.players.map((player) => createSearchPlayer(
      player,
      knowledgeState.knownCardsByPlayer[player.id] ?? [],
      beliefState.playersById[player.id],
      knowledgeState.viewerId,
      derivedPlayersById[player.id] ?? {}
    )))
  });
}

/*
功能
为一次搜索分支创建与根快照完全隔离的可变 SearchState。

调用方
Simulator 构造、clone 与状态契约测试。

输入
不含 Game 或类实例引用的 SearchState 普通对象图。

输出
可独立写入的深克隆。

读取状态
仅输入 SearchState。

写入状态
无。

调用函数
structuredClone。

边界与不变量
不得访问 GameState；任一克隆写入不得污染根快照或兄弟分支。
*/
export function cloneSearchState(searchState) {
  return structuredClone(searchState);
}
