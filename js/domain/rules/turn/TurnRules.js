/*
模块职责
唯一拥有回合使用状态、global-turn reactive 状态与纯回合推进的规则决定；不执行 workflow 或 mutation。

上游
Game、Player 测试 façade、RuleUsageTransitions 调用方与 tests。

下游
无。

状态边界
只读玩家与回合 facts，返回 decided state/value；不写状态。

信息边界
不读取 controllerType、aiMemory、AI、UI 或隐藏信息。

架构约束
不得依赖 application/adapters/AI/UI/Game runtime；不得 await、emit、随机。
*/

/*
功能
创建 actor-turn usage state 的决定值。

调用方
Game.takeTurn 与 tests。

输入
teamRules。

输出
完整 turnFlags 决定对象。

读取状态
teamRules。

写入状态
无。

调用函数
无。

边界与不变量
所有 reset 字段由本规则唯一决定。
*/
export function createTurnUsageState(teamRules = null) {
  return {
    attackUsed: 0,
    attackLimit: teamRules?.attackLimitPerTurn ?? 1,
    recoverUsed: 0,
    recoverLimit: teamRules ? teamRules.recoverLimitPerTurn : null,
    categoriesUsed: new Set(),
    momentum: 0,
    activeSkillsUsed: new Set(),
    activeSkillUseCounts: {},
    recycleDeviceUses: 0,
    guardianAidUsed: false,
    coordinationTriggered: false,
    gambleTriggered: false,
    rejuvenationTriggerCount: 0,
    spyGapTriggered: false,
    spyGapPendingTargetIds: new Set(),
    trackingTargetIds: new Set(),
    skipActionPhase: false
  };
}

/*
功能
创建 global-turn reactive 字段的决定值。

调用方
Game.takeTurn 与 tests。

输入
无。

输出
reactive 决定对象。

读取状态
无。

写入状态
无。

调用函数
createTurnUsageState。

边界与不变量
不含 actor-turn 字段。
*/
export function createGlobalTurnReactiveState() {
  return {
    categoriesUsed: new Set(),
    momentum: 0,
    guardianAidUsed: false,
    coordinationTriggered: false,
    gambleTriggered: false,
    rejuvenationTriggerCount: 0,
    spyGapTriggered: false,
    spyGapPendingTargetIds: new Set(),
    trackingTargetIds: new Set()
  };
}

/*
功能
创建轮级 usage state 的决定值。

调用方
Game 轮末重置与 tests。

输入
无。

输出
空轮级标记对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
当前规则没有持久轮级字段；该决定值仍由 Turn Rule 唯一拥有。
*/
export function createRoundUsageState() {
  return {};
}

/*
功能
创建 Domain Turn Rule 唯一的 canonical attack usage 事实。

调用方
RuleEngine facade 与 tests。

输入
已决定 used 与 limit。

输出
冻结的 { used, limit }。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
canonical shape 只有 used/limit；legacy attackUsed/attackLimit 必须在 RuleEngine facade 归一化。
*/
export function createAttackUsage(used, limit) {
  return Object.freeze({
    used: Math.max(0, Number(used) || 0),
    limit: Math.max(0, Number(limit) || 0)
  });
}

/*
功能
校验并读取 canonical attack usage facts。

调用方
RuleEngine facade、hasAttackUseRemaining 与 tests。

输入
canonical { used, limit } 对象。

输出
{ used, limit } 整数。

读取状态
usage 对象。

写入状态
无。

调用函数
无。

边界与不变量
只接受 used/limit 单一 Domain-facing shape；legacy attackUsed/attackLimit 直接传入会抛 TypeError。
*/
export function getAttackUsage(usage) {
  if (!usage || !Number.isFinite(Number(usage.used)) || !Number.isFinite(Number(usage.limit))) {
    throw new TypeError("TurnRules attack usage 只接受 canonical { used, limit }");
  }
  return {
    used: Math.max(0, Number(usage.used) || 0),
    limit: Math.max(0, Number(usage.limit) || 0)
  };
}

/*
功能
决定突袭次数是否仍有可用额度。

调用方
RuleEngine facade 与 tests。

输入
canonical usage facts 或已读取的 used/limit。

输出
布尔值。

读取状态
usage 对象。

写入状态
无。

调用函数
getAttackUsage。

边界与不变量
used < limit 才可用；limit 为 0 时不可用。
*/
export function hasAttackUseRemaining(usage) {
  const { used, limit } = getAttackUsage(usage);
  return used < limit;
}

/*
功能
决定调息次数是否仍有可用额度。

调用方
RuleEngine facade 与 tests。

输入
recoverUsed 与 recoverLimit。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
recoverLimit 为 null 表示无限；满血等其它前置由 workflow 组合。
*/
export function hasRecoverUseRemaining(recoverUsed, recoverLimit) {
  return recoverLimit === null || recoverLimit === undefined
    || Number(recoverUsed) < Number(recoverLimit);
}

/*
功能
读取主动技能在本回合已使用次数。

调用方
skillRegistry facade 与 tests。

输入
canonical turn usage 与 skillId。

输出
整数次数。

读取状态
usage.activeSkillUseCounts 与 usage.activeSkillsUsed。

写入状态
无。

调用函数
无。

边界与不变量
优先以 counts 为 authority；只有旧 Set 时按 1 次解释。
*/
export function getActiveSkillUseCount(usage, skillId) {
  const recorded = usage?.activeSkillUseCounts?.[skillId];
  if (recorded !== undefined) return Math.max(0, Number(recorded) || 0);
  return usage?.activeSkillsUsed?.has?.(skillId) ? 1 : 0;
}

/*
功能
决定主动技能是否仍有本回合使用额度。

调用方
skillRegistry facade 与 tests。

输入
已使用次数与每回合上限。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
上限缺失按 1 解释。
*/
export function hasActiveSkillUseRemaining(used, limitPerTurn) {
  return Number(used) < (limitPerTurn ?? 1);
}

/*
功能
决定指定角色是否处于自己的出牌阶段。

调用方
RuleEngine/skillRegistry facade 与 tests。

输入
phase、currentPlayerId 与 sourceId。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
phase 必须为 play；不读取 Game 实例。
*/
export function isActorTurn(phase, currentPlayerId, sourceId) {
  return phase === "play" && currentPlayerId === sourceId;
}

/*
功能
决定角色是否应跳过出牌阶段。

调用方
Game.takeTurn facade 与 tests。

输入
canonical turn usage。

输出
布尔值。

读取状态
skipActionPhase。

写入状态
无。

调用函数
无。

边界与不变量
只解释已决定的标记。
*/
export function shouldSkipActionPhase(usage) {
  return Boolean(usage?.skipActionPhase);
}

/*
功能
决定从当前索引开始的下一名存活玩家并判断是否经过起始座位。

调用方
Game.advanceTurn 与 tests。

输入
players、currentIndex 与 startingIndex。

输出
{ nextIndex, wrapped }。

读取状态
alive 与索引。

写入状态
无。

调用函数
无。

边界与不变量
不推进轮次；只做纯决定。
*/
export function calculateNextActorIndex(players, currentIndex, startingIndex) {
  let next = currentIndex;
  let wrapped = false;
  for (let step = 0; step < players.length; step += 1) {
    next = (next + 1) % players.length;
    if (next === startingIndex) wrapped = true;
    if (players[next].alive) break;
  }
  return { nextIndex: next, wrapped };
}
