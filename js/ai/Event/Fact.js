/*
模块职责
唯一保存 AI 当前确定知道的公开事实、自身私有事实、合法实体记忆与由这些事实推出的当前牌池计数。

上游
Controller、World、Generator、Simulator、Evaluator 与直接事实测试。

下游
Domain Definitions/Status/Turn Rules 与 canonical seat roster contract。

状态边界
只读当前 GameState 并创建不可变 Fact；不保留 service、class 或第二份缓存。

信息边界
允许公开区域、观察者自己的手牌和观察者已有的合法 card-id 记忆；禁止读取敌方未知牌面。

架构约束
不得保存概率、期望、响应倾向、搜索世界或规则合法性；未知信息只能作为 Probability 的输入边界。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { assertCanonicalSeatRoster } from "../../domain/state/queries/SeatRosterContract.js";
import { hasStatus } from "../../domain/rules/status/StatusRules.js";
import { createAttackUsage } from "../../domain/rules/turn/TurnRules.js";

const CARD_COUNTS = RULESET_DEFINITION.deckComposition;
const CHARACTER_ROLE_TAGS = Object.freeze({
  "blade-walker": Object.freeze(["damage", "attacker"]),
  "oath-warden": Object.freeze(["tank", "support"]),
  "spirit-medic": Object.freeze(["support", "healer"]),
  "shade-agent": Object.freeze(["control", "utility"]),
  "ember-magus": Object.freeze(["damage", "caster"]),
  "trail-hunter": Object.freeze(["damage", "control"]),
  "fate-gambler": Object.freeze(["damage", "resource"]),
  "resonance-tuner": Object.freeze(["support", "control"])
});

/*
功能
返回角色公开身份可确定的 AI 战术标签。

调用方
Fact 玩家投影、Controller runtime 玩家视图与直接契约测试。

输入
角色 ID。

输出
独立标签数组；未知角色为空数组。

读取状态
模块内冻结角色标签表。

写入状态
无。

调用函数
无。

边界与不变量
标签只来自公开角色身份，不包含评分、概率或隐藏信息。
*/
export function getCharacterRoleTags(characterId) {
  return [...(CHARACTER_ROLE_TAGS[characterId] ?? [])];
}

/*
功能
归一化真实 Player 的 statuses 对象或 World 的 statusIds 数组。

调用方
projectRulePlayer。

输入
玩家摘要。

输出
冻结状态 ID 数组。

读取状态
player.statuses 或 player.statusIds。

写入状态
无。

调用函数
Object.keys。

边界与不变量
只读取确定状态 ID，不解释概率状态。
*/
function getStatusIds(player) {
  if (Array.isArray(player?.statuses)) return Object.freeze([...player.statuses]);
  if (Array.isArray(player?.statusIds)) return Object.freeze([...player.statusIds]);
  return Object.freeze(Object.keys(player?.statuses ?? {}));
}

/*
功能
读取公开手牌数量。

调用方
projectRulePlayer 与 transfer projection。

输入
玩家摘要。

输出
非负手牌数量。

读取状态
player.hand 或 player.handCount。

写入状态
无。

调用函数
无。

边界与不变量
只投影确定数量；不得读取未知牌定义。
*/
function getProjectedHandCount(player) {
  if (Array.isArray(player?.hand)) return player.hand.length;
  return Math.max(0, Number(player?.handCount ?? 0) || 0);
}

/*
功能
把真实 Player 或 World 玩家投影为 Domain Rule canonical fact。

调用方
AI 的 Domain Rule consumers。

输入
玩家公开摘要。

输出
冻结的 Domain Rule player fact。

读取状态
公开身份、资源、装备与状态字段。

写入状态
无。

调用函数
getStatusIds、getProjectedHandCount。

边界与不变量
这是确定性事实投影，不读取 aiMemory、隐藏牌定义或概率。
*/
export function projectRulePlayer(player) {
  return Object.freeze({
    id:player?.id,
    seatIndex:player?.seatIndex,
    alive:Boolean(player?.alive),
    battleTeam:player?.battleTeam,
    hp:Number(player?.hp) || 0,
    maxHp:Number(player?.maxHp) || 0,
    shield:Number(player?.shield) || 0,
    energy:Number(player?.energy) || 0,
    maxEnergy:Number(player?.maxEnergy) || 0,
    attackRange:Number(player?.attackRange ?? 1) || 1,
    handCount:getProjectedHandCount(player),
    equipmentDefinitionId:player?.equipment?.definitionId ?? player?.equipmentDefinitionId ?? null,
    huntMarkSourceId:player?.statuses?.huntMark?.sourceId ?? player?.huntMarkSourceId ?? null,
    statusIds:getStatusIds(player)
  });
}

/*
功能
投影携带可转移手牌数量的 Domain Rule 玩家事实。

调用方
Generator transfer legality。

输入
玩家数组与排除实体 ID 集合。

输出
冻结的玩家事实数组。

读取状态
确定玩家字段与可见实体 ID。

写入状态
无。

调用函数
projectRulePlayer。

边界与不变量
只派生数量 primitive，不选择资源或解释转移价值。
*/
export function projectTransferRulePlayers(players, excludedCardIds = null) {
  const excluded = excludedCardIds ?? new Set();
  return Object.freeze((players ?? []).map((player) => {
    const fact = projectRulePlayer(player);
    if (!Array.isArray(player?.hand)) return fact;
    return Object.freeze({
      ...fact,
      transferableHandCount:player.hand.filter(
        (card) => Boolean(card?.id) && !excluded.has(card.id)
      ).length
    });
  }));
}

/*
功能
按调用方顺序投影 Domain Rule 玩家事实。

调用方
Card、Skill、Combat、Distance 与 Seal rule consumers。

输入
玩家数组。

输出
冻结的玩家事实数组。

读取状态
确定玩家字段。

写入状态
无。

调用函数
projectRulePlayer。

边界与不变量
保持输入顺序；需要座位契约的调用方必须使用 projectCanonicalSeatRoster。
*/
export function projectRulePlayers(players) {
  return Object.freeze((players ?? []).map((player) => projectRulePlayer(player)));
}

/*
功能
投影 Domain 座位规则要求的完整 canonical roster。

调用方
状态、响应与伤害座位顺序规则。

输入
玩家数组。

输出
保留真实 seatIndex 的冻结事实数组。

读取状态
确定玩家座位与公开事实。

写入状态
无。

调用函数
projectRulePlayer、assertCanonicalSeatRoster。

边界与不变量
不排序、过滤或重编号；非法 roster 必须 fail fast。
*/
export function projectCanonicalSeatRoster(players) {
  const projected = Object.freeze((players ?? []).map((player) => projectRulePlayer(player)));
  assertCanonicalSeatRoster(projected);
  return projected;
}

/*
功能
判断公开角色是否拥有指定被动技能。

调用方
Simulator 的 passive trigger 分支。

输入
玩家摘要与技能 ID。

输出
布尔值。

读取状态
Domain CharacterDefinitions 与公开 characterId。

写入状态
无。

调用函数
无。

边界与不变量
角色到技能映射只由 Domain definition 决定。
*/
export function hasPassiveSkill(player, skillId) {
  return Boolean(
    player?.characterId
    && CHARACTER_BY_ID[player.characterId]?.passiveSkillIds?.includes(skillId)
  );
}

/*
功能
把真实 turnFlags 或 World 使用标量归一化为 Domain attack usage。

调用方
Generator root/deep legality 与 Simulator queries。

输入
玩家摘要。

输出
Domain canonical attack usage。

读取状态
确定 attackUsed/attackLimit。

写入状态
无。

调用函数
createAttackUsage。

边界与不变量
只投影事实，不复制攻击合法性公式。
*/
export function projectAttackUsage(player) {
  const turnFlags = player?.turnFlags;
  return createAttackUsage(
    turnFlags?.attackUsed ?? player?.attackUsed ?? 0,
    turnFlags?.attackLimit ?? player?.attackLimit ?? 0
  );
}

/*
功能
读取过滤玩家当前确定持有的 canonical Domain status fact。

调用方
Probability status-presence query、Controller、Evaluator 与 Generator。

输入
真实或过滤玩家，以及 Domain status ID。

输出
确定存在返回 true，否则 false。

读取状态
玩家公开 statuses。

写入状态
无。

调用函数
RuleProjection.projectRulePlayer、Domain StatusRules.hasStatus。

边界与不变量
只解释确定事实；概率存在必须由 Probability facade 组合，不能在本函数降级为布尔猜测。
*/
export function hasFactStatus(player, statusId) {
  return hasStatus(projectRulePlayer(player), statusId);
}

/*
功能
冻结一份已经完成信息过滤的普通值列表。

调用方
createFact、projectFactPlayer、projectKnownCards。

输入
普通值或已投影对象数组。

输出
与输入集合隔离的冻结数组。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
本函数不承担信息过滤；调用方必须先移除不可见字段。
*/
function freezeList(values) {
  return Object.freeze([...values]);
}

/*
功能
把一张确定可见的牌投影为稳定实体事实。

调用方
createFact、projectFactPlayer。

输入
公开牌或观察者自己的牌实体。

输出
冻结的 id 与 definitionId 事实。

读取状态
卡牌实体标识与定义标识。

写入状态
无。

调用函数
无。

边界与不变量
只有调用方已经确定可见的牌才能进入；不得携带运行时反向引用。
*/
function projectFactCard(card) {
  return Object.freeze({ id:card.id, definitionId:card.definitionId });
}

/*
功能
复制观察者对指定持有者仍然有效的确定实体记忆。

调用方
createFact、Fact.knownCards。

输入
观察者与持有者 ID。

输出
冻结的 cardId、definitionId 事实数组。

读取状态
观察者 aiMemory.knownCardsByPlayer。

写入状态
无。

调用函数
freezeList。

边界与不变量
不检查或读取持有者真实手牌；记忆有效性由真实资源移动入口维护。
*/
function projectKnownCards(viewer, ownerId) {
  const records = viewer?.aiMemory?.knownCardsByPlayer?.[ownerId] ?? {};
  return freezeList(Object.entries(records).map(([cardId, definitionId]) => Object.freeze({
    cardId,
    definitionId
  })));
}

/*
功能
投影一名玩家当前确定公开的状态，并只为观察者本人附带私有手牌事实。

调用方
createFact。

输入
观察者 ID 与真实 Player。

输出
冻结的玩家 Fact 记录。

读取状态
玩家身份、公开资源、公开装备/状态、回合标记及观察者本人手牌。

写入状态
无。

调用函数
projectFactCard、freezeList、getCharacterRoleTags。

边界与不变量
非观察者只读取 hand.length；不得遍历或投影其手牌定义。
*/
function projectFactPlayer(viewerId, player) {
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
    passiveSkillIds:freezeList(player.character.passiveSkillIds ?? []),
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
    hand:player.id === viewerId ? freezeList(player.hand.map(projectFactCard)) : undefined,
    equipmentDefinitionId:player.equipment?.definitionId ?? null,
    statuses:freezeList(Object.keys(player.statuses))
  });
}

/*
功能
从观察者当前确定知道的实体中扣除卡牌实例，得到确定的匿名池计数。

调用方
createFact 与 AI 边界的当前计数查询。

输入
观察者与当前 GameState。

输出
新的 definitionId 到剩余实例数对象。

读取状态
观察者手牌、公开牌区、公开装备及观察者合法实体记忆。

写入状态
无。

调用函数
无。

边界与不变量
同一实体 ID 最多扣除一次；不得读取其他玩家未知手牌或未来牌堆顺序。
*/
export function deriveCurrentCardCounts(viewer, gameState) {
  const remaining = { ...CARD_COUNTS };
  const seenIds = new Set();
  /*
  功能
  从当前确定匿名池计数中消费一个依法可见的实体。

  调用方
  deriveCurrentCardCounts 的公开区域与合法记忆遍历。

  输入
  带 definitionId 及可选实体 ID 的确定牌记录，以及该记录的确定来源类别。

  输出
  无。

  读取状态
  闭包 remaining 与 seenIds。

  写入状态
  扣减闭包计数并登记已消费实体。

  调用函数
  无。

  边界与不变量
  同一实体最多消费一次，非法定义忽略；首次超额消费必须立即暴露来源，不得截断为零。
  */
  const consume = (entry, sourceCategory) => {
    if (!entry || typeof entry.definitionId !== "string") return;
    if (!Object.hasOwn(remaining, entry.definitionId)) return;
    const entityId = entry.id ?? entry.cardId ?? null;
    if (entityId !== null) {
      if (seenIds.has(entityId)) return;
      seenIds.add(entityId);
    }
    const currentRemainingCount = remaining[entry.definitionId];
    if (currentRemainingCount <= 0) {
      throw new RangeError(
        `AI Fact 有限牌池守恒失败：definitionId=${entry.definitionId}, `
        + `currentRemainingCount=${currentRemainingCount}, sourceCategory=${sourceCategory}`
      );
    }
    remaining[entry.definitionId] = currentRemainingCount - 1;
  };
  (viewer?.hand ?? []).forEach((entry) => consume(entry, "viewer-hand"));
  (gameState?.deck?.discardPile ?? []).forEach((entry) => consume(entry, "discard-pile"));
  (gameState?.deck?.resolvingCards ?? []).forEach((entry) => consume(entry, "resolving-cards"));
  (gameState?.deck?.judgmentZone ?? []).forEach((entry) => consume(entry, "judgment-zone"));
  (gameState?.players ?? []).forEach((player) => {
    if (player?.equipment) consume(player.equipment, "public-equipment");
  });
  (gameState?.publicCardPool ?? []).forEach((entry) => consume(entry, "public-card-pool"));
  Object.values(viewer?.aiMemory?.knownCardsByPlayer ?? {}).forEach((records) => {
    Object.entries(records ?? {}).forEach(([cardId, definitionId]) => {
      consume({ cardId, definitionId }, "known-card-memory");
    });
  });
  return remaining;
}

/*
功能
创建 AI 在当前时刻确定知道的唯一不可变 Fact。

调用方
  Simulator/World.createInitialWorld。

输入
观察者 ID、当前 GameState 与可选的已验证当前牌池计数。

输出
公开事实、本人私有事实、合法记忆和当前确定牌池计数的冻结对象。

读取状态
当前 GameState 与观察者 aiMemory。

写入状态
无。

调用函数
projectFactCard、projectFactPlayer、projectKnownCards、deriveCurrentCardCounts。

边界与不变量
Fact 不含任何概率或期望；敌方未知牌换面不得改变输出。
*/
export function createFact(viewerId, state, currentCardCounts = null) {
  const viewer = state.players.find((player) => player.id === viewerId);
  if (!viewer) throw new Error("AI Fact 缺少观察者");
  const players = freezeList(state.players.map((player) => projectFactPlayer(viewerId, player)));
  const knownCardsByPlayer = Object.freeze(Object.fromEntries(players.map((player) => [
    player.id,
    player.id === viewerId ? Object.freeze([]) : projectKnownCards(viewer, player.id)
  ])));
  const counts = currentCardCounts && typeof currentCardCounts === "object"
    && !Array.isArray(currentCardCounts)
    ? { ...currentCardCounts }
    : deriveCurrentCardCounts(viewer, state);
  return Object.freeze({
    viewerId,
    gameId:state.gameId,
    currentRound:state.currentRound,
    phase:state.phase,
    deckCount:state.deck.cards.length,
    discardCount:state.deck.discardPile.length,
    discardDefinitionIds:freezeList(state.deck.discardPile.map((card) => card.definitionId)),
    judgmentDefinitionIds:freezeList(state.deck.judgmentZone.map((card) => card.definitionId)),
    publicPool:freezeList((state.publicCardPool ?? []).map(projectFactCard)),
    players,
    knownCardsByPlayer,
    currentCardCounts:Object.freeze(counts)
  });
}
