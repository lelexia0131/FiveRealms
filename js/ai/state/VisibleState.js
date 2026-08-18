/*
模块职责
把 GameState 投影为只含公开事实与观察者自身私有信息的不可变 VisibleState。

上游
AI 状态组合入口、状态契约测试。

下游
无。

状态边界
只读 GameState，创建新的 VisibleState 快照。

信息边界
允许公开区域与观察者自己的手牌；禁止敌方未知手牌与 AI 记忆。

架构约束
不得计算概率、价值、搜索分支，也不得保留 Game 或 Player 引用。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getCharacterRoleTags } from "../policy/CharacterRoleMetadata.js";

/*
功能
创建不可变的普通值数组，切断快照与 GameState 集合的引用。

调用方
createVisibleState、projectVisiblePlayer。

输入
只含普通值或已投影对象的数组。

输出
新的冻结数组。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
输入内容必须已完成信息过滤，不负责深层投影。
*/
function freezeList(values) {
  return Object.freeze([...values]);
}

/*
功能
把合法可见卡牌压缩为不含运行时反向引用的实体标识。

调用方
createVisibleState、projectVisiblePlayer。

输入
公开卡牌或观察者自己的手牌实体。

输出
冻结的卡牌 ID 与定义 ID 对象。

读取状态
卡牌 id、definitionId。

写入状态
无。

调用函数
无。

边界与不变量
不得复制牌面之外的可变运行时字段。
*/
function projectVisibleCard(card) {
  return Object.freeze({ id:card.id, definitionId:card.definitionId });
}

/*
功能
把单个玩家投影为公开事实，并只为观察者本人携带手牌牌面。

调用方
createVisibleState。

输入
观察者 ID 与 GameState 中的 Player。

输出
冻结的 VisibleState 玩家记录。

读取状态
Player 身份、公开属性、回合标记、状态与本人手牌。

写入状态
无。

调用函数
projectVisibleCard、freezeList。

边界与不变量
非观察者只暴露 handCount，绝不访问其手牌定义进行投影。
*/
function projectVisiblePlayer(viewerId, player) {
  const activeSkillId = player.character.activeSkillIds[0] ?? null;
  const activeSkillUses = player.turnFlags.activeSkillUseCounts?.[activeSkillId] ?? 0;
  const activeSkillLimit = ACTIVE_SKILL_DEFINITIONS[activeSkillId]?.limitPerTurn ?? 1;
  return Object.freeze({
    id:player.id,
    seatIndex:player.seatIndex,
    name:player.name,
    controllerType:player.controllerType,
    battleTeam:player.battleTeam,
    characterId:player.characterId,
    tags:freezeList([]),
    roleTags:freezeList(getCharacterRoleTags(player.characterId)),
    hp:player.hp,
    maxHp:player.maxHp,
    shield:player.shield,
    energy:player.energy,
    maxEnergy:player.maxEnergy,
    attackRange:player.attackRange,
    attackUsed:player.turnFlags.attackUsed,
    attackLimit:player.turnFlags.attackLimit,
    recoverUsed:player.turnFlags.recoverUsed,
    recoverLimit:player.turnFlags.recoverLimit,
    momentum:player.turnFlags.momentum ?? 0,
    categoriesUsed:freezeList(player.turnFlags.categoriesUsed ?? []),
    gambleTriggered:Boolean(player.turnFlags.gambleTriggered),
    coordinationTriggered:Boolean(player.turnFlags.coordinationTriggered),
    rejuvenationTriggerCount:player.turnFlags.rejuvenationTriggerCount ?? 0,
    exposeWeaknessStacks:player.statuses.exposeWeakness?.stacks ?? 0,
    assaultBonus:player.statuses.allIn?.assaultBonus ?? 0,
    activeSkillId,
    activeSkillUses,
    activeSkillLimit,
    activeSkillUsed:activeSkillUses >= activeSkillLimit,
    recycleDeviceUses:player.turnFlags.recycleDeviceUses ?? 0,
    trackingTargetIds:freezeList(player.turnFlags.trackingTargetIds ?? []),
    trackingUses:player.turnFlags.trackingTargetIds?.size ?? 0,
    huntMarkSourceId:player.statuses.huntMark?.sourceId ?? null,
    alive:player.alive,
    handCount:player.hand.length,
    hand:player.id === viewerId ? freezeList(player.hand.map(projectVisibleCard)) : undefined,
    equipmentDefinitionId:player.equipment?.definitionId ?? null,
    statuses:freezeList(Object.keys(player.statuses))
  });
}

/*
功能
创建指定观察者的不可变 VisibleState 快照。

调用方
createStateContracts、状态契约测试。

输入
合法玩家 ID 与当前 GameState。

输出
不含敌方未知信息、概率和搜索字段的冻结快照；观察者缺失时抛错。

读取状态
GameState 回合、牌区公开计数、公开卡牌与玩家事实。

写入状态
无。

调用函数
projectVisibleCard、projectVisiblePlayer、freezeList。

边界与不变量
投影结果不得因敌方未知手牌定义变化而变化，也不得保留 GameState 引用。
*/
export function createVisibleState(viewerId, state) {
  if (!state.players.some((player) => player.id === viewerId)) {
    throw new Error("AI 可见状态缺少观察者");
  }
  return Object.freeze({
    gameId:state.gameId,
    currentRound:state.currentRound,
    phase:state.phase,
    deckCount:state.deck.cards.length,
    discardCount:state.deck.discardPile.length,
    discardDefinitionIds:freezeList(state.deck.discardPile.map((card) => card.definitionId)),
    judgmentDefinitionIds:freezeList(state.deck.judgmentZone.map((card) => card.definitionId)),
    publicPool:freezeList((state.publicCardPool ?? []).map(projectVisibleCard)),
    players:freezeList(state.players.map((player) => projectVisiblePlayer(viewerId, player)))
  });
}
