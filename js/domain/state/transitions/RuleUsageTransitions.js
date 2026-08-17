/*
模块职责
拥有玩家回合/技能/被动触发/追踪/游戏标记的 root-aware 原子写操作；不拥有任何具体规则语义。

上游
match application、Player、application card runtime、application skill runtime、DyingWorkflow 的 commit boundary。

下游
无。

状态边界
只修改传入 state.stateVersion 与 Player.turnFlags/roundFlags/gameFlags。

信息边界
不读取 AI、UI、事件或隐藏信息。

架构约束
不得依赖 Game/EventDispatcher/UI/AI/application/adapters；不得包含 cardId/skillId/statusId 规则分支。
*/
import { bumpStateVersion } from "./StateVersion.js?build=20260817-architecture-closure-final";

/*
功能
重置玩家回合级使用状态。

调用方
Game.takeTurn 与测试 fixture。

输入
state、Player 与 team rules。

输出
无返回值。

读取状态
state.stateVersion 与 player.turnFlags。

写入状态
player.turnFlags；重置内容变化时 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
具体规则字段由调用方规则决定；transition 不解释字段。
*/
export function resetTurnFlags(state, player, decidedTurnFlags) {
  player.turnFlags = decidedTurnFlags;
  bumpStateVersion(state);
}

/*
功能
提交已决定的 global-turn reactive 字段集合。

调用方
match application.takeTurn 与 Player boundary。

输入
state、Player 与已决定 reactive 对象。

输出
无返回值。

读取状态
state.stateVersion 与 player.turnFlags。

写入状态
player.turnFlags 的 reactive 字段；bump 一次。

调用函数
bumpStateVersion。

边界与不变量
规则字段由 TurnRule 决定；transition 只提交。
*/
export function resetGlobalTurnReactiveFlags(state, player, decidedReactiveState) {
  Object.assign(player.turnFlags, decidedReactiveState);
  bumpStateVersion(state);
}

/*
功能
提交已决定的轮级标记对象。

调用方
Game.runGameLoop/advanceTurn 与测试 fixture。

输入
state、Player 与已决定 roundFlags。

输出
无返回值。

读取状态
state.stateVersion 与 player.roundFlags。

写入状态
player.roundFlags；原对象有键时 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
规则字段由 TurnRule 决定；transition 只提交。
*/
export function resetRoundFlags(state, player, decidedRoundFlags) {
  const previous = player.roundFlags;
  player.roundFlags = decidedRoundFlags;
  if (Object.keys(previous).length > 0) bumpStateVersion(state);
}

/*
功能
递增本回合突袭使用次数。

调用方
CardRuntime assault resolver。

输入
state、Player 与增量。

输出
新值。

读取状态
state.stateVersion 与 player.turnFlags.attackUsed。

写入状态
attackUsed；增量非 0 时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定何时合法。
*/
export function incrementAttackUsed(state, player, delta = 1) {
  player.turnFlags.attackUsed += delta;
  if (delta !== 0) bumpStateVersion(state);
  return player.turnFlags.attackUsed;
}

/*
功能
递增本回合突袭上限。

调用方
breakArmy execute。

输入
state、Player 与增量。

输出
新值。

读取状态
state.stateVersion 与 player.turnFlags.attackLimit。

写入状态
attackLimit；增量非 0 时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定技能效果。
*/
export function incrementAttackLimit(state, player, delta) {
  player.turnFlags.attackLimit += delta;
  if (delta !== 0) bumpStateVersion(state);
  return player.turnFlags.attackLimit;
}

/*
功能
递增本回合调息使用次数。

调用方
CardRuntime recover resolver。

输入
state、Player 与增量。

输出
新值。

读取状态
state.stateVersion 与 player.turnFlags.recoverUsed。

写入状态
recoverUsed；增量非 0 时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定何时合法。
*/
export function incrementRecoverUsed(state, player, delta = 1) {
  player.turnFlags.recoverUsed += delta;
  if (delta !== 0) bumpStateVersion(state);
  return player.turnFlags.recoverUsed;
}

/*
功能
写入 momentum 当前值。

调用方
momentum passive 与 DyingWorkflow cleanup。

输入
state、Player 与新值。

输出
新值。

读取状态
state.stateVersion 与 player.turnFlags.momentum。

写入状态
momentum；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不计算 momentum 规则。
*/
export function setMomentum(state, player, value) {
  if (player.turnFlags.momentum === value) return value;
  player.turnFlags.momentum = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
记录本回合已使用的卡牌类别。

调用方
momentum passive。

输入
state、Player 与 category。

输出
是否新增。

读取状态
state.stateVersion 与 categoriesUsed。

写入状态
categoriesUsed；新增时 bump。

调用函数
bumpStateVersion。

边界与不变量
Set 内容语义由规则决定。
*/
export function markCategoryUsed(state, player, category) {
  const categories = player.turnFlags.categoriesUsed;
  if (categories.has(category)) return false;
  categories.add(category);
  bumpStateVersion(state);
  return true;
}

/*
功能
记录一次主动技能使用。

调用方
Game.useActiveSkill。

输入
state、Player 与 skillId。

输出
新使用次数。

读取状态
state.stateVersion 与 activeSkillsUsed/activeSkillUseCounts。

写入状态
两个字段；仅 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
不解释技能规则，skillId 仅作 key。
*/
export function recordActiveSkillUse(state, player, skillId) {
  player.turnFlags.activeSkillsUsed.add(skillId);
  const next = (player.turnFlags.activeSkillUseCounts[skillId] ?? 0) + 1;
  player.turnFlags.activeSkillUseCounts[skillId] = next;
  bumpStateVersion(state);
  return next;
}

/*
功能
写入回收站触发次数。

调用方
Game recycleDevice rule。

输入
state、Player 与新值。

输出
新值。

读取状态
state.stateVersion 与 recycleDeviceUses。

写入状态
recycleDeviceUses；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定触发条件。
*/
export function setRecycleDeviceUses(state, player, value) {
  if (player.turnFlags.recycleDeviceUses === value) return value;
  player.turnFlags.recycleDeviceUses = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 guardianAidUsed 标记。

调用方
guardianAid passive。

输入
state、Player 与布尔值。

输出
写入值。

读取状态
state.stateVersion 与 guardianAidUsed。

写入状态
guardianAidUsed；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定触发规则。
*/
export function setGuardianAidUsed(state, player, value) {
  if (player.turnFlags.guardianAidUsed === value) return value;
  player.turnFlags.guardianAidUsed = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 coordinationTriggered 标记。

调用方
coordination passive。

输入
state、Player 与布尔值。

输出
写入值。

读取状态
state.stateVersion 与 coordinationTriggered。

写入状态
coordinationTriggered；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定触发规则。
*/
export function setCoordinationTriggered(state, player, value) {
  if (player.turnFlags.coordinationTriggered === value) return value;
  player.turnFlags.coordinationTriggered = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 gambleTriggered 标记。

调用方
gamble passive。

输入
state、Player 与布尔值。

输出
写入值。

读取状态
state.stateVersion 与 gambleTriggered。

写入状态
gambleTriggered；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定触发规则。
*/
export function setGambleTriggered(state, player, value) {
  if (player.turnFlags.gambleTriggered === value) return value;
  player.turnFlags.gambleTriggered = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 rejuvenationTriggerCount。

调用方
rejuvenation passive。

输入
state、Player 与新值。

输出
新值。

读取状态
state.stateVersion 与 rejuvenationTriggerCount。

写入状态
rejuvenationTriggerCount；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定触发规则。
*/
export function setRejuvenationTriggerCount(state, player, value) {
  if ((player.turnFlags.rejuvenationTriggerCount ?? 0) === value) return value;
  player.turnFlags.rejuvenationTriggerCount = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 spyGapTriggered 标记。

调用方
spyGap passive。

输入
state、Player 与布尔值。

输出
写入值。

读取状态
state.stateVersion 与 spyGapTriggered。

写入状态
spyGapTriggered；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定触发规则。
*/
export function setSpyGapTriggered(state, player, value) {
  if (player.turnFlags.spyGapTriggered === value) return value;
  player.turnFlags.spyGapTriggered = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
替换 spyGapPendingTargetIds 集合引用。

调用方
spyGap passive reset 路径。

输入
state、Player 与 Set。

输出
新 Set。

读取状态
state.stateVersion 与 spyGapPendingTargetIds。

写入状态
spyGapPendingTargetIds；引用变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不解释目标规则。
*/
export function setSpyGapPendingTargetIds(state, player, value) {
  if (player.turnFlags.spyGapPendingTargetIds === value) return value;
  player.turnFlags.spyGapPendingTargetIds = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
向 spyGapPendingTargetIds 添加目标。

调用方
spyGap passive。

输入
state、Player 与 targetId。

输出
是否新增。

读取状态
state.stateVersion 与 spyGapPendingTargetIds。

写入状态
Set；新增时 bump。

调用函数
bumpStateVersion。

边界与不变量
不解释目标规则。
*/
export function addSpyGapPendingTarget(state, player, targetId) {
  const set = player.turnFlags.spyGapPendingTargetIds ??= new Set();
  if (set.has(targetId)) return false;
  set.add(targetId);
  bumpStateVersion(state);
  return true;
}

/*
功能
从 spyGapPendingTargetIds 删除目标。

调用方
spyGap passive。

输入
state、Player 与 targetId。

输出
是否删除。

读取状态
state.stateVersion 与 spyGapPendingTargetIds。

写入状态
Set；删除时 bump。

调用函数
bumpStateVersion。

边界与不变量
不解释目标规则。
*/
export function removeSpyGapPendingTarget(state, player, targetId) {
  const set = player.turnFlags.spyGapPendingTargetIds;
  if (!set?.has(targetId)) return false;
  set.delete(targetId);
  bumpStateVersion(state);
  return true;
}

/*
功能
替换 trackingTargetIds 集合引用。

调用方
tracking reset 路径。

输入
state、Player 与 Set。

输出
新 Set。

读取状态
state.stateVersion 与 trackingTargetIds。

写入状态
trackingTargetIds；引用变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不解释追踪规则。
*/
export function setTrackingTargetIds(state, player, value) {
  if (player.turnFlags.trackingTargetIds === value) return value;
  player.turnFlags.trackingTargetIds = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
向 trackingTargetIds 添加目标。

调用方
tracking passive。

输入
state、Player 与 targetId。

输出
是否新增。

读取状态
state.stateVersion 与 trackingTargetIds。

写入状态
Set；新增时 bump。

调用函数
bumpStateVersion。

边界与不变量
不解释追踪规则。
*/
export function addTrackingTarget(state, player, targetId) {
  const set = player.turnFlags.trackingTargetIds;
  if (set.has(targetId)) return false;
  set.add(targetId);
  bumpStateVersion(state);
  return true;
}

/*
功能
写入 skipActionPhase 标记。

调用方
seal rule 与 DyingWorkflow cleanup。

输入
state、Player 与布尔值。

输出
写入值。

读取状态
state.stateVersion 与 skipActionPhase。

写入状态
skipActionPhase；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定封印规则。
*/
export function setSkipActionPhase(state, player, value) {
  if (player.turnFlags.skipActionPhase === value) return value;
  player.turnFlags.skipActionPhase = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 lastEmberResolutionId。

调用方
ember passive。

输入
state、Player 与 resolutionId。

输出
写入值。

读取状态
state.stateVersion 与 gameFlags.lastEmberResolutionId。

写入状态
gameFlags；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定余烬触发规则。
*/
export function setLastEmberResolutionId(state, player, value) {
  if (player.gameFlags.lastEmberResolutionId === value) return value;
  player.gameFlags.lastEmberResolutionId = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 trackingTurnNumber。

调用方
tracking passive。

输入
state、Player 与新值。

输出
新值。

读取状态
state.stateVersion 与 gameFlags.trackingTurnNumber。

写入状态
gameFlags；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定追踪时钟规则。
*/
export function setTrackingTurnNumber(state, player, value) {
  if ((player.gameFlags.trackingTurnNumber ?? 0) === value) return value;
  player.gameFlags.trackingTurnNumber = value;
  bumpStateVersion(state);
  return value;
}

/*
功能
写入 killRewardGranted 标记。

调用方
DyingWorkflow kill reward workflow。

输入
state、Player 与布尔值。

输出
写入值。

读取状态
state.stateVersion 与 gameFlags.killRewardGranted。

写入状态
gameFlags；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不决定击杀奖励规则。
*/
export function setKillRewardGranted(state, player, value) {
  if (player.gameFlags.killRewardGranted === value) return value;
  player.gameFlags.killRewardGranted = value;
  bumpStateVersion(state);
  return value;
}
