/*
模块职责
把真实 Game/Player 或 AI SearchState 玩家摘要投影为 Domain Rules 可读的 canonical data-only facts。

上游
js/ai/search、js/ai/simulation、js/ai/domain 与 AI 执行边界。

下游
js/domain/rules 与 js/domain/definitions 目录。

状态边界
只读玩家公开字段与调用方显式传入的规则事实，不写状态。

信息边界
不读取敌方隐藏手牌定义、不读取 aiMemory、不构造概率；只做 shape adaptation。

架构约束
禁止在这里计算合法性、目标公式、距离公式或技能语义；Domain Rule 函数是唯一公式 owner。
*/
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js?build=20260817-architecture-closure-final";
import { assertCanonicalSeatRoster } from "../../domain/state/queries/SeatRosterContract.js?build=20260817-architecture-closure-final";
import { createAttackUsage } from "../../domain/rules/turn/TurnRules.js?build=20260817-architecture-closure-final";

/*
功能
归一化真实 Player 的 statuses 对象或 SearchState 的 statusIds 数组。

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
只读取状态 ID，不读取状态详情或概率。
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
有实体 hand 时按长度计数，否则用标量 handCount；排除语义由 Domain CardRules 解释。
*/
function getProjectedHandCount(player) {
  if (Array.isArray(player?.hand)) {
    return player.hand.length;
  }
  return Math.max(0, Number(player?.handCount ?? 0) || 0);
}

/*
功能
把单个真实 Player 或 SearchState 玩家投影为 Domain Rule canonical fact。

调用方
projectRulePlayers 与各 AI rule consumer。

输入
玩家摘要。

输出
冻结的 Domain Rule player fact。

读取状态
玩家公开身份、资源、装备与状态字段。

写入状态
无。

调用函数
getStatusIds。

边界与不变量
不返回实体引用；不读取 controllerType/aiMemory/AI 概率或隐藏手牌。
*/
export function projectRulePlayer(player, _options = {}) {
  return Object.freeze({
    id: player?.id,
    seatIndex: player?.seatIndex,
    alive: Boolean(player?.alive),
    battleTeam: player?.battleTeam,
    hp: Number(player?.hp) || 0,
    maxHp: Number(player?.maxHp) || 0,
    shield: Number(player?.shield) || 0,
    energy: Number(player?.energy) || 0,
    maxEnergy: Number(player?.maxEnergy) || 0,
    attackRange: Number(player?.attackRange ?? 1) || 1,
    handCount: getProjectedHandCount(player),
    equipmentDefinitionId: player?.equipment?.definitionId ?? player?.equipmentDefinitionId ?? null,
    huntMarkSourceId: player?.statuses?.huntMark?.sourceId
      ?? player?.huntMarkSourceId
      ?? null,
    statusIds: getStatusIds(player)
  });
}

/*
功能
把玩家数组投影为携带可转移手牌数量 primitive 的转移 Domain Rule fact 数组。

调用方
ActionGenerator transfer legality 与执行边界。

输入
玩家数组与要排除的卡牌 ID 集合。

输出
冻结的 Domain Rule player fact 数组，已有实体手牌的玩家带 transferableHandCount。

读取状态
players 顺序与可转移手牌身份。

写入状态
无。

调用函数
projectRulePlayer。

边界与不变量
不解释排除规则；排除集合只在边界派生 transferableHandCount，Domain CardRules 只消费数量 primitive。
*/
export function projectTransferRulePlayers(players, excludedCardIds = null) {
  const excluded = excludedCardIds ?? new Set();
  return Object.freeze((players ?? []).map((player) => {
    const fact = projectRulePlayer(player);
    if (!Array.isArray(player?.hand)) return fact;
    return Object.freeze({
      ...fact,
      transferableHandCount: player.hand.filter((card) => Boolean(card?.id) && !excluded.has(card.id)).length
    });
  }));
}

/*
功能
把玩家数组按调用方当前顺序投影为 Domain Rule fact 数组。

调用方
Card/Skill/Combat/Distance rule consumer。

输入
玩家数组。

输出
冻结的 Domain Rule player fact 数组。

读取状态
players 数组顺序。

写入状态
无。

调用函数
projectRulePlayer。

边界与不变量
保持调用方顺序以冻结候选 order；seat-order Domain Rule 应改用 projectCanonicalSeatRoster。
*/
export function projectRulePlayers(players) {
  return Object.freeze((players ?? []).map((player) => projectRulePlayer(player)));
}

/*
功能
把玩家数组投影为 seat-order Domain Rule 要求的 full canonical roster。

调用方
StatusRules.nextLightningReceiverId、ResponseRules seat-order 入口与 AI domain models。

输入
玩家数组。

输出
按输入顺序保留真实 seatIndex 的冻结 Domain Rule fact 数组。

读取状态
players 座位与公开事实。

写入状态
无。

调用函数
projectRulePlayer、assertCanonicalSeatRoster。

边界与不变量
只做 shape adaptation；不重编号、不排序、不过滤 dead player；非 canonical roster 由 Domain contract fail fast。
*/
export function projectCanonicalSeatRoster(players) {
  const projected = Object.freeze((players ?? []).map((player) => projectRulePlayer(player)));
  assertCanonicalSeatRoster(projected);
  return projected;
}

/*
功能
判断玩家角色是否拥有指定被动技能。

调用方
AI simulation 与 policy 的 passive trigger 分支。

输入
玩家摘要与被动技能 ID。

输出
布尔值。

读取状态
Domain CharacterDefinitions 与玩家 characterId。

写入状态
无。

调用函数
无。

边界与不变量
角色→被动技能映射是 Domain static fact；AI 不得按 characterId 字面量重写该映射。
*/
export function hasPassiveSkill(player, skillId) {
  return Boolean(
    player?.characterId
    && CHARACTER_BY_ID[player.characterId]?.passiveSkillIds?.includes(skillId)
  );
}

/*
功能
把真实 turnFlags 或 SearchState 使用标量归一化为 Domain TurnRule canonical attack usage。

调用方
ActionGenerator root/deep legality 与 simulation queries。

输入
玩家摘要。

输出
Domain canonical { used, limit }。

读取状态
turnFlags.attackUsed/attackLimit 或 SearchState 同名标量。

写入状态
无。

调用函数
createAttackUsage。

边界与不变量
只调用 Domain TurnRule 归一化，不复制 used < limit 公式。
*/
export function projectAttackUsage(player) {
  const turnFlags = player?.turnFlags;
  return createAttackUsage(
    turnFlags?.attackUsed ?? player?.attackUsed ?? 0,
    turnFlags?.attackLimit ?? player?.attackLimit ?? 0
  );
}
