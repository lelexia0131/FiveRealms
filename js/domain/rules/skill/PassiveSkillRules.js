/*
模块职责
唯一拥有被动技能 WHEN/IF 的纯 predicate facts；不拥有 EventDispatcher、listener、effect workflow、response、choice、mutation 或 presentation。

上游
application/trigger PassiveSkillTriggerRegistry 与 tests。

下游
Domain StatusRules/TurnRules。

状态边界
只读传入的 Domain Player/Event facts；不写状态。

信息边界
可读取 hand.length 作为公开事实；不得读取、遍历或检查隐藏手牌的 definition、category、identity 等内容；不读取 controllerType、AI/UI。

架构约束
不得依赖 Game/application/adapters/EventDispatcher；不得 await、emit、随机、mutation。
*/
import { PASSIVE_SKILL_DEFINITIONS } from "../../definitions/skills/SkillDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { isHuntMarkExpired } from "../status/StatusRules.js?build=20260818-skill-rules-locality-refactor";

/*
功能
决定 passive trigger canTriggerMomentumCategory 纯 predicate。

调用方
canTriggerMomentumCategory consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerMomentumCategory(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && !owner.turnFlags.categoriesUsed.has(event.card?.category));
}

/*
功能
决定 passive trigger shouldAddMomentumDamage 纯 predicate。

调用方
shouldAddMomentumDamage consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldAddMomentumDamage(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && event.card?.definitionId === "assault" && owner.turnFlags.momentum > 0);
}

/*
功能
决定 passive trigger shouldConsumeMomentum 纯 predicate。

调用方
shouldConsumeMomentum consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldConsumeMomentum(owner, event) {
  return Boolean(event?.source?.id === owner.id && event.actualAmount > 0
    && event.metadata?.consumeMomentum);
}

/*
功能
决定 passive trigger shouldResetMomentumAtTurnEnd 纯 predicate。

调用方
shouldResetMomentumAtTurnEnd consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldResetMomentumAtTurnEnd() { return true; }

/*
功能
决定 passive trigger canTriggerGuardianAid 纯 predicate。

调用方
canTriggerGuardianAid consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerGuardianAid(owner, event) {
  return Boolean(owner?.alive && event?.target?.alive && owner.id !== event.target.id
    && owner.battleTeam === event.target.battleTeam
    && !owner.turnFlags.guardianAidUsed && owner.hand.length && event.amount > 0);
}

/*
功能
决定 passive trigger shouldResetRejuvenationAtTurnStart 纯 predicate。

调用方
shouldResetRejuvenationAtTurnStart consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldResetRejuvenationAtTurnStart() { return true; }

/*
功能
决定 passive trigger canTriggerRejuvenation 纯 predicate。

调用方
canTriggerRejuvenation consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerRejuvenation(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && event.target?.battleTeam === owner.battleTeam && event.actualAmount > 0
    && (owner.turnFlags.rejuvenationTriggerCount ?? 0)
    < PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn);
}

/*
功能
决定 passive trigger canTriggerSpyGapAfterDamage 纯 predicate。

调用方
canTriggerSpyGapAfterDamage consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerSpyGapAfterDamage(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id && event.target?.alive
    && event.target.battleTeam !== owner.battleTeam && event.actualAmount > 0
    && !owner.turnFlags.spyGapTriggered);
}

/*
功能
决定 passive trigger canRevealSpyGap 纯 predicate。

调用方
canRevealSpyGap consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canRevealSpyGap(owner, target) {
  return Boolean(owner?.alive && target?.alive && target.hp > 0
    && target.battleTeam !== owner.battleTeam
    && !owner.turnFlags.spyGapTriggered && target.hand.length);
}

/*
功能
决定 passive trigger shouldQueueSpyGapOnDying 纯 predicate。

调用方
shouldQueueSpyGapOnDying consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldQueueSpyGapOnDying(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id && event.target?.alive
    && event.target.battleTeam !== owner.battleTeam && event.actualAmount > 0
    && !owner.turnFlags.spyGapTriggered && event.target.hp <= 0);
}

/*
功能
决定 passive trigger canTriggerSpyGapOnRescue 纯 predicate。

调用方
canTriggerSpyGapOnRescue consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerSpyGapOnRescue(owner, event) {
  return Boolean(owner?.turnFlags?.spyGapPendingTargetIds?.has?.(event.target?.id));
}

/*
功能
决定 passive trigger shouldRemoveSpyGapPendingOnDead 纯 predicate。

调用方
shouldRemoveSpyGapPendingOnDead consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldRemoveSpyGapPendingOnDead(owner, event) {
  return Boolean(event?.target?.id && owner?.turnFlags?.spyGapPendingTargetIds?.has?.(event.target.id));
}

/*
功能
决定 passive trigger canTriggerEmber 纯 predicate。

调用方
canTriggerEmber consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerEmber(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && event.target?.battleTeam !== owner.battleTeam && event.actualAmount > 0 && event.card);
}

/*
功能
决定 passive trigger shouldIgnoreEmberDuplicate 纯 predicate。

调用方
shouldIgnoreEmberDuplicate consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldIgnoreEmberDuplicate(owner, event) {
  return owner?.gameFlags?.lastEmberResolutionId === event?.resolutionId;
}

/*
功能
决定 passive trigger shouldAdvanceTrackingClock 纯 predicate。

调用方
shouldAdvanceTrackingClock consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldAdvanceTrackingClock(owner, event) {
  return event?.player?.id === owner.id;
}

/*
功能
决定 passive trigger canTriggerTrackingTarget 纯 predicate。

调用方
canTriggerTrackingTarget consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerTrackingTarget(owner, event) {
  const target = event?.targets?.[0];
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && event.card?.definitionId === "assault" && target
    && target.battleTeam !== owner.battleTeam
    && owner.turnFlags.trackingTargetIds.size
    < PASSIVE_SKILL_DEFINITIONS.tracking.maxTargetsPerTurn
    && !owner.turnFlags.trackingTargetIds.has(target.id));
}

/*
功能
决定 passive trigger shouldCleanupExpiredHuntMarks 纯 predicate。

调用方
shouldCleanupExpiredHuntMarks consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldCleanupExpiredHuntMarks(owner, event) {
  return event?.player?.id === owner.id;
}

/*
功能
决定 passive trigger isHuntMarkExpiredForOwner 纯 predicate。

调用方
isHuntMarkExpiredForOwner consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function isHuntMarkExpiredForOwner(mark, owner) {
  return isHuntMarkExpired(mark, owner?.gameFlags?.trackingTurnNumber ?? 0);
}

/*
功能
决定 passive trigger canTriggerGamble 纯 predicate。

调用方
canTriggerGamble consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerGamble(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && event.card?.category === "tactic" && !owner.turnFlags.gambleTriggered);
}

/*
功能
决定 passive trigger shouldAddAllInDamage 纯 predicate。

调用方
shouldAddAllInDamage consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldAddAllInDamage(owner, event) {
  return Boolean(owner?.alive && event?.source?.id === owner.id
    && event.card?.definitionId === "assault" && owner.statuses.allIn);
}

/*
功能
决定 passive trigger shouldConsumeAllIn 纯 predicate。

调用方
shouldConsumeAllIn consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function shouldConsumeAllIn(owner, event) {
  if (!owner?.statuses?.allIn) return false;
  const assaultFinishedWithoutDamage = event.card?.definitionId === "assault"
    && ["block", "defenseDevice"].includes(event.preventedBy);
  return Boolean(event.source?.id === owner.id
    && (event.metadata?.consumeAssaultBonus || assaultFinishedWithoutDamage));
}

/*
功能
决定 passive trigger canTriggerCoordination 纯 predicate。

调用方
canTriggerCoordination consumers。

输入
按 signature 传入的事实。

输出
按 signature 返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持纯决定，不写状态。
*/
export function canTriggerCoordination(owner, event) {
  return Boolean(owner?.alive && event.resolved === true && event.source?.id === owner.id
    && !owner.turnFlags.coordinationTriggered
    && (event.effectiveTargets ?? []).some((target) => target?.alive && target.id !== owner.id
      && target.battleTeam === owner.battleTeam));
}
