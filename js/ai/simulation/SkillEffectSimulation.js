/*
模块职责
镜像全部主动技能的能量、次数、资源和效果结算。

上游
Simulator 正式模拟门面。

下游
Card/Combat/Response/Status 组件、Domain Skill Definitions/Rules 与 Probability。

状态边界
只修改 Simulator 门面提供的独立 World 副本。

信息边界
只消费动作携带的合法技能、目标和执行世界。

架构约束
不生成技能动作、不决定是否使用技能、不复制技能价值或规则合法性。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import {
  decideAllInDrawCount,
  decideAllInEnterChance,
  getSkillCost
} from "../../domain/rules/skill/SkillRules.js";
import {
  PROBABILITY_EPSILON,
  clampProbability
} from "../state/Probability/Probability.js";
import { getRangeConditionBranches } from "../state/DistanceProbabilityBranches.js";

/*
功能
把 Base class 与 SkillEffectSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把 SkillEffectSimulation 方法加入正式模拟门面。

输入
已经包含上一层模拟能力的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增 主动技能资源和效果方法 的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withSkillEffectSimulation = (Base) => class SkillEffectSimulation extends Base {
  /*
  功能
  按技能费用与显式使用世界同步主动技能次数、可用概率和摘要字段。

  调用方
  Simulator 构造/clone 与 CardEffectSimulation 的装备变化：刷新装备可能影响的技能费用。

  输入
  独立 World。

  输出
  无返回值；每名拥有正式主动技能的玩家费用已同步。

  读取状态
  players、activeSkillId 与 Domain SkillRules 所需公开规则字段。

  写入状态
  player.activeSkillCost。

  调用函数
  getSkillCost。

  边界与不变量
  只更新费用摘要，不消费能量、次数或动作；技能定义不存在时保持原字段。
  */
  syncActiveSkillCosts(state) {
    for (const player of state?.players ?? []) {
      const skill = ACTIVE_SKILL_DEFINITIONS[player.activeSkillId] ?? null;
      if (skill) player.activeSkillCost = getSkillCost(skill, player, state?.players ?? []);
    }
  }

  /*
  功能
  在当前 transition 调用栈内解析主动技能的目标、能量与次数条件。

  调用方
  Simulator.apply 的技能分派。

  输入
  独立 World、行动者、canonical Action 与正式技能定义。

  输出
  本次技能实际发生/不发生的有界局部分区。

  读取状态
  当前能量、技能使用次数、猎印概率与距离装备概率。

  写入状态
  只消费本次技能次数的局部槽位；不把分区写回 World 或 Action。

  调用函数
  getRangeConditionBranches、ensureSkillUseSlots、consumeSlot。

  边界与不变量
  当前技能至多涉及一个目标的两项距离装备变量和固定技能次数上限；分区有界，
  结算后立即边缘化为 World 当前值，不形成持久 execution world。
  */
  buildSkillExecutionWorlds(state, actor, action, skill) {
    const target = state.players.find((player) => player.id === action.targetIds?.[0]);
    let conditionBranches = [{ probability:1, conditions:{}, matches:true }];
    if (skill.id === "hunt") {
      const markProbability = clampProbability(
        target?.huntMarkProbabilities?.[actor.id]
          ?? (target?.huntMarkSourceId === actor.id ? 1 : 0)
      );
      conditionBranches = this.getEventWorlds(
        state,
        markProbability,
        null,
        `hunt-mark:${actor.id}:${target?.id ?? "unknown"}`
      ).map((branch) => ({ ...branch, matches:Boolean(branch.occurs) }));
    } else if (skill.rangeRule === "attack" || skill.rangeRule === "fixed") {
      conditionBranches = getRangeConditionBranches({ state }, {
        source:actor,
        target,
        range:skill.rangeRule === "attack" ? actor.attackRange : skill.range
      });
    }
    const minimumEnergy = skill.id === "allIn" ? 1 : action.energyCost;
    const energyState = [{
      probability:1,
      conditions:{},
      energyAmount:Number(actor.energy) || 0
    }];
    const joined = this.intersectProbabilityWork(
      [conditionBranches, energyState],
      "SkillEffectSimulation.buildSkillExecutionWorlds:conditions"
    );
    const desiredWorlds = this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(branch.matches && branch.energyAmount >= minimumEnergy)
    }), "SkillEffectSimulation.buildSkillExecutionWorlds:desired");
    return this.consumeSlot(
      state,
      this.ensureSkillUseSlots(actor, skill),
      desiredWorlds,
      `skill-slot:${skill.id}`
    ).eventWorlds;
  }

  /*
  功能
  按技能标识分派主动效果，在独立 World 中结算资源、目标和状态变化。

  调用方
  Simulator.apply：在技能次数槽与执行世界确定后结算主动技能。

  输入
  独立 World、行动者、已合法的技能动作与实际执行事件世界。

  输出
  无返回值；对应技能的资源、目标和状态效果已推进。

  读取状态
  ACTIVE_SKILL_DEFINITIONS、技能目标、能量/次数槽、猎印与相关战斗资源。

  写入状态
  能量、技能次数、护盾/生命、手牌、猎印及委托组件产生的效果字段。

  调用函数
  decideAllInDrawCount、decideAllInEnterChance、getSkillCost、changeEnergy、consume/ensure slot 辅助函数、changeShield、healFrom、stealResourceToHand、applyDamage、gainUnknownCardsWithCounterState。

  边界与不变量
  技能分派顺序、费用、目标和随机/概率分支不在此重新决定；每个执行世界只消费一次技能容量。
  */
  applySkill(state, actor, action, eventWorlds) {
    const skill = ACTIVE_SKILL_DEFINITIONS[action.skillId] ?? null;
    const target = state.players.find((player) => player.id === action.targetIds?.[0]);
    const chance = this.eventProbability(eventWorlds);
    if (!skill || chance <= 0) return;
    if (skill.id === "allIn") {
      const joined = this.updateEnergyFromWorlds(actor, eventWorlds, (amount, branch) => (
        branch.occurs ? 0 : amount
      ));
      this.gainUnknownCardsWithCounterState(
        state,
        actor,
        (branch) => (branch.occurs ? decideAllInDrawCount(branch.energyAmount) : 0),
        joined,
        "allIn-draw"
      );
      const currentAssaultBonus = actor.assaultBonus ?? 0;
      const joinedExpectedValue = joined.reduce((sum, branch) => (
        sum + (branch.occurs
          ? branch.probability * decideAllInEnterChance(branch.energyAmount)
          : 0)
      ), 0);
      actor.assaultBonus = currentAssaultBonus + joinedExpectedValue * (1 - currentAssaultBonus);
      return;
    }
    const energyCost = action.energyCost ?? getSkillCost(skill, actor, state?.players ?? []);
    this.changeEnergy(state, actor, -energyCost, eventWorlds);
    if (skill.id === "breakArmy") {
      actor.attackLimit = (actor.attackLimit ?? 0)
        + chance * ACTIVE_SKILL_DEFINITIONS.breakArmy.attackLimitBonus;
    }
    else if (skill.id === "barrier" && target) {
      this.changeShield(state, target, ACTIVE_SKILL_DEFINITIONS.barrier.shieldAmount, eventWorlds);
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(state, actor, target, chance * ACTIVE_SKILL_DEFINITIONS.symbiosis.healAmount);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, ACTIVE_SKILL_DEFINITIONS.burningField.damageAmount, { canBlock:true, eventBranches:eventWorlds });
      }
    } else if (skill.id === "hunt" && target) {
      target.huntMarkProbabilities ??= {};
      const oldMarkProbability = clampProbability(target.huntMarkProbabilities[actor.id]
        ?? (target.huntMarkSourceId === actor.id ? 1 : 0));
      const consumedMarkProbability = Math.min(oldMarkProbability, chance);
      target.huntMarkProbabilities[actor.id] = Math.max(
        0,
        oldMarkProbability - consumedMarkProbability
      );
      target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities ?? {}).map(clampProbability));
      const fullMarkSource = Object.entries(target.huntMarkProbabilities)
        .find(([, probability]) => clampProbability(probability) >= 1 - Number.EPSILON)?.[0] ?? null;
      target.huntMarkSourceId = fullMarkSource;
      if (Array.isArray(target.statuses) && !fullMarkSource) {
        target.statuses = target.statuses.filter((status) => status !== "huntMark");
      }
      const outcome = {};
      this.applyDamage(state, actor, target, ACTIVE_SKILL_DEFINITIONS.hunt.damageAmount, {
        canBlock:true,
        eventBranches:consumedMarkProbability >= chance - PROBABILITY_EPSILON
          ? eventWorlds
          : this.gateEventWorlds(state, eventWorlds,
            chance > 0 ? consumedMarkProbability / chance : 0,
            `hunt-mark:${actor.id}:${target.id}`),
        outcome
      });
      if ((outcome.blockedByCardChance ?? 0) > PROBABILITY_EPSILON) {
        this.gainUnknownCardsWithCounterState(
          state,
          actor,
          outcome.blockedByCardChance * ACTIVE_SKILL_DEFINITIONS.hunt.blockedRewardDraw,
          null,
          "hunt-blocked-draw"
        );
      }
    } else if (skill.id === "resonance" && target) {
      this.gainUnknownCardsWithCounterState(
        state, target, ACTIVE_SKILL_DEFINITIONS.resonance.drawCount, eventWorlds, "resonance-draw"
      );
    }
  }
};
