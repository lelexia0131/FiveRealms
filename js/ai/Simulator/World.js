/*
模块职责
把确定 Fact、唯一 ProbabilityState 与已注入领域派生值组合成 canonical World。

上游
Controller、Generator、Searcher、Simulator、Evaluator 与状态契约测试。

下游
Fact、Probability facade 与 Domain Team/Skill Rules。

状态边界
根 World 不可变；Simulator 只推进完全隔离的可变 clone。

信息边界
确定当前状态使用普通字段；未知有限池只保存在 probabilityState，查询结果不写回 World。

架构约束
不得保存 hp/shield/energy/availability/slot 等独立 branch arrays，不得复制 Probability sufficient state。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getSkillCost } from "../../domain/rules/skill/SkillRules.js";
import {
  getAttackLimitFromRules,
  getTeamRules,
  getTurnEnergyBreakdownFromRules
} from "../../domain/rules/team/TeamRules.js";
import { createFact } from "../Event/Fact.js";
import { createProbabilityState } from "../Event/Probability/Probability.js";

/*
功能
集中计算 canonical World 所需的领域派生字段。

调用方
createInitialWorld。

输入
当前 GameState。

输出
按玩家 ID 索引的冻结派生值表。

读取状态
玩家回合标记、公开装备、角色技能与 Domain Team/Skill Rules。

写入状态
无。

调用函数
Domain TeamRules、SkillRules.getSkillCost。

边界与不变量
只在 Game→World 边界投影已存在的领域规则，不重写规则或价值语义。
*/
function createDerivedPlayersById(state) {
  return Object.fromEntries(state.players.map((player) => {
    const activeSkillId = player.character.activeSkillIds[0] ?? null;
    const activeSkill = ACTIVE_SKILL_DEFINITIONS[activeSkillId] ?? null;
    const teamRules = getTeamRules({ players:state.players }, player);
    const energyBreakdown = getTurnEnergyBreakdownFromRules(
      teamRules,
      player.equipment?.definitionId ?? null
    );
    const energyDeviceBreakdown = getTurnEnergyBreakdownFromRules(teamRules, "energyDevice");
    return [player.id, Object.freeze({
      turnEnergyGainWithoutEquipment:energyBreakdown.baseAmount + energyBreakdown.teamBonus,
      energyDeviceTurnEnergyGain:energyDeviceBreakdown.equipmentBonus,
      nextTurnBaseAttackLimit:getAttackLimitFromRules(teamRules),
      guardianAidUsed:Boolean(player.turnFlags.guardianAidUsed),
      spyGapTriggered:Boolean(player.turnFlags.spyGapTriggered),
      activeSkillCost:getSkillCost(activeSkill, player, state.players)
    })];
  }));
}

/*
功能
为一张确定身份牌创建 World 中的当前资源记录。

调用方
createWorldPlayer。

输入
Fact 的可见牌或合法记忆。

输出
带当前 availability 标量的新记录。

读取状态
卡牌 ID 与 definitionId。

写入状态
无。

调用函数
无。

边界与不变量
availability 是当前 World 值；随机 transition alternatives 只能在调用栈局部存在。
*/
function createWorldCard(card) {
  return { ...card, availability:1 };
}

/*
功能
把一名 Fact 玩家与已注入领域结果组合为 World 玩家。

调用方
createWorld。

输入
Fact 玩家、合法已知牌、观察者 ID 与 derived player 字段。

输出
不含独立概率分支数组的玩家普通对象。

读取状态
Fact 与 derived player。

写入状态
无。

调用函数
createWorldCard。

边界与不变量
确定资源只存一个当前值；有限池未知量由 World.probabilityState 惰性查询，不写摘要副本。
*/
function createWorldPlayer(factPlayer, knownCards, viewerId, derivedPlayer) {
  return {
    ...factPlayer,
    turnEnergyGainWithoutEquipment:derivedPlayer.turnEnergyGainWithoutEquipment,
    energyDeviceTurnEnergyGain:derivedPlayer.energyDeviceTurnEnergyGain,
    nextTurnBaseAttackLimit:derivedPlayer.nextTurnBaseAttackLimit,
    guardianAidUsed:Boolean(derivedPlayer.guardianAidUsed),
    spyGapTriggered:Boolean(derivedPlayer.spyGapTriggered),
    activeSkillCost:derivedPlayer.activeSkillCost,
    hand:factPlayer.id === viewerId ? factPlayer.hand.map(createWorldCard) : undefined,
    knownCards:factPlayer.id === viewerId ? undefined : knownCards.map(createWorldCard),
    equipmentRetentionProbability:factPlayer.equipmentDefinitionId ? 1 : 0,
    aliveProbability:factPlayer.alive ? 1 : 0,
    hpSummaryClassification:"EXACT"
  };
}

/*
功能
创建 Searcher、Simulator、Policy 与 Value 共同消费的 canonical World 根快照。

调用方
createInitialWorld 与状态契约测试。

输入
Fact、唯一 ProbabilityState 与按玩家 ID 注入的领域派生值。

输出
冻结外壳的 data-only World。

读取状态
不可变 Fact、ProbabilityState 与 derived players。

写入状态
无。

调用函数
createWorldPlayer。

边界与不变量
World 不持有 Game/Player 引用；probabilityState 是未知有限池的唯一充分状态；不得持久化其查询摘要。
*/
export function createWorld(fact, probabilityState, derivedPlayersById = {}) {
  const world = {
    gameId:fact.gameId,
    currentRound:fact.currentRound,
    phase:fact.phase,
    playPhaseEnded:false,
    probabilityState,
    deckCount:fact.deckCount,
    discardCount:fact.discardCount,
    discardDefinitionIds:fact.discardDefinitionIds,
    judgmentDefinitionIds:fact.judgmentDefinitionIds,
    publicPool:fact.publicPool,
    players:fact.players.map((player) => createWorldPlayer(
      player,
      fact.knownCardsByPlayer[player.id] ?? [],
      fact.viewerId,
      derivedPlayersById[player.id] ?? {}
    ))
  };
  world.players.forEach(Object.freeze);
  world.players = Object.freeze(world.players);
  return Object.freeze(world);
}

/*
功能
为一次搜索 transition 创建与输入完全隔离的可变 World。

调用方
Simulator 构造、clone、反事实查询与状态契约测试。

输入
不含运行时引用的 canonical World。

输出
可独立写入的深克隆。

读取状态
仅输入 World。

写入状态
无。

调用函数
structuredClone。

边界与不变量
任何写入不得污染根或兄弟 World；不得在 clone 时创建概率摘要或 branch hierarchy。
*/
export function cloneWorld(world) {
  return structuredClone(world);
}

/*
功能
从真实 GameState 创建唯一 canonical World。

调用方
Controller、Worker request 构造、测试与 study harness。

输入
观察者 ID、GameState 与可选合法剩余牌计数。

输出
canonical World。

读取状态
由 createFact、createProbabilityState 与 createWorld 统一读取。

写入状态
无。

调用函数
createFact、createProbabilityState、createWorld、createDerivedPlayersById。

边界与不变量
不得复制 Fact、Probability、Search 或 Evaluation 状态层级。
*/
export function createInitialWorld(viewerId, state, currentCardCounts = null) {
  const fact = createFact(viewerId, state, currentCardCounts);
  const probabilityState = createProbabilityState(fact);
  return createWorld(fact, probabilityState, createDerivedPlayersById(state));
}
