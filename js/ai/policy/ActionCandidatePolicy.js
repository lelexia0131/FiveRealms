/*
模块职责
拥有 AI 对已通过规则合法性检查的动作和目标做局部候选过滤的战略约束。

上游
AIController 与 ActionGenerator。

下游
state/Probability。

状态边界
只读真实或过滤玩家摘要，不生成、执行或结算动作。

信息边界
只使用公开状态、观察者自身手牌与 SearchState availability，不读取敌方未知牌面。

架构约束
不调用 Domain CardRules 定义合法性，不依赖 Planner/Controller/UI，也不构造 Simulator。
*/
import {
  PROBABILITY_EPSILON,
  getAvailabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260816-legacy-recovery";

export class ActionCandidatePolicy {
  /*
  功能
  计算行动者手中预计可用的突袭数量。

  调用方
  canBenefitFromBreakArmy。

  输入
  真实玩家或 SearchState actor。

  输出
  可用突袭概率质量总和。

  读取状态
  自己手牌与 availability 状态分支。

  写入状态
  无。

  调用函数
  getAvailabilityStateBranches、totalBranchProbability。

  边界与不变量
  只读取行动者自己的合法手牌身份。
  */
  expectedAvailableAssaults(actor) {
    return (actor.hand ?? [])
      .filter((card) => card.definitionId === "assault")
      .reduce((sum, card) => sum + totalBranchProbability(
        getAvailabilityStateBranches(card).filter((branch) => branch.available)
      ), 0);
  }

  /*
  功能
  计算行动者预计仍可使用的普通攻击次数槽。

  调用方
  canBenefitFromBreakArmy。

  输入
  真实玩家或 SearchState actor。

  输出
  可用次数概率质量总和。

  读取状态
  attackUseSlots 或公开 attackLimit/attackUsed。

  写入状态
  无。

  调用函数
  totalBranchProbability。

  边界与不变量
  有离散槽时不再从摘要重复推导。
  */
  expectedAvailableAttackUses(actor) {
    const slots = Array.isArray(actor.attackUseSlots) ? actor.attackUseSlots : null;
    if (slots) {
      return slots.reduce((sum, slot) => sum + totalBranchProbability(
        (slot ?? []).filter((branch) => branch.available)
      ), 0);
    }
    const limit = Number(actor.attackLimit ?? actor.turnFlags?.attackLimit) || 0;
    const used = Number(actor.attackUsed ?? actor.turnFlags?.attackUsed) || 0;
    return Math.max(0, limit - used);
  }

  /*
  功能
  判断破军增加一次攻击容量是否有可兑现的额外突袭。

  调用方
  ActionGenerator 根/深层技能候选过滤。

  输入
  行动者公开/过滤状态。

  输出
  有严格正的额外库存时为 true。

  读取状态
  自己手牌与攻击次数槽。

  写入状态
  无。

  调用函数
  expectedAvailableAssaults、expectedAvailableAttackUses。

  边界与不变量
  这是 AI 零收益过滤，不改变真实技能合法性。
  */
  canBenefitFromBreakArmy(actor) {
    return this.expectedAvailableAssaults(actor)
      > this.expectedAvailableAttackUses(actor) + PROBABILITY_EPSILON;
  }

  /*
  功能
  判断孤注是否处于既有确定零收益场景。

  调用方
  ActionGenerator 根/深层技能候选过滤。

  输入
  行动者公开/过滤状态。

  输出
  已有完整孤注且能量不超过一时为 true。

  读取状态
  allIn 状态、assaultBonus 与 energy。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  部分概率状态不被误判；真人合法性不受影响。
  */
  isZeroBenefitAllIn(actor) {
    const hasCompleteStatus = Boolean(actor?.statuses?.allIn)
      || Number(actor?.assaultBonus) >= 1 - PROBABILITY_EPSILON;
    return hasCompleteStatus && Number(actor?.energy) <= 1;
  }

  /*
  功能
  应用 3v1 主动闪电的唯一 AI 战略硬禁令。

  调用方
  ActionGenerator 根/深层卡牌候选过滤与直接测试。

  输入
  当前玩家数组与行动者。

  输出
  行动者阵营恰为三名存活、敌方恰为一名存活时为 true。

  读取状态
  只读 alive 与 battleTeam。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  这是不可被 HP、Expected Value 或 Search Prior 覆盖的 hard constraint；唯一 owner 在本方法。
  */
  isLightningStrategicallyForbidden(players, actor) {
    const alive = (players ?? []).filter((player) => player.alive);
    const allies = alive.filter(
      (player) => player.battleTeam === actor?.battleTeam
    ).length;
    const enemies = alive.length - allies;
    return allies === 3 && enemies === 1;
  }

  /*
  功能
  从 Domain CardRules 已确认合法的卡牌目标中应用既有敌我候选偏好。

  调用方
  ActionGenerator 根/深层卡牌枚举。

  输入
  卡牌、行动者与合法目标数组。

  输出
  新的 AI policy candidate target 数组。

  读取状态
  card definitionId 与双方 battleTeam。

  写入状态
  无；不修改合法目标数组。

  调用函数
  无。

  边界与不变量
  destroy/plunder 只保留敌方；其他牌原样保留。被过滤目标仍是游戏规则上的合法目标。
  */
  filterCardTargets(card, actor, legalTargets) {
    if (!["destroy", "plunder"].includes(card?.definitionId)) return legalTargets;
    return legalTargets.filter((target) => target.battleTeam !== actor.battleTeam);
  }
}
