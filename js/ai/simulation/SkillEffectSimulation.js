/*
模块职责
镜像全部主动技能的能量、次数、资源和效果结算。

上游
Simulator facade。

下游
Card/Combat/Response/Status components、主动技能配置与 Probability。

状态边界
只修改 facade 提供的独立 SearchState clone。

信息边界
只消费动作携带的合法技能、目标和执行世界。

架构约束
不生成技能动作、不决定是否使用技能、不复制技能价值或规则合法性。
*/
import {
  ACTIVE_SKILLS,
  getActiveSkillCost
} from "../../generals/skillRegistry.js?build=20260814-ai-simulation-engine";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  joinProbabilityStateBranches,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260814-ai-simulation-engine";
import { clampProbability } from "./SimulationSupport.js?build=20260814-ai-simulation-engine";

/*
功能
把 Base class 与 SkillEffectSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator 模块加载期的唯一组件组合表达式。

输入
承载上一层方法的 Base class。

输出
增加本组件方法的派生 class。

读取状态
不读取运行时状态。

写入状态
不写 SearchState；只在模块加载时创建 class。

调用函数
JavaScript class inheritance。

边界与不变量
每个组件只组合一次，不得在搜索 node 或 action 中创建额外实例。
*/
export const withSkillEffectSimulation = (Base) => class SkillEffectSimulation extends Base {
  /** 克隆或结算后按当前技能定义重新同步每个玩家的主动技能成本，供后续动作与机会成本评估共用。 */
  /*
  功能
  推进主动技能效果步骤 syncActiveSkillCosts。

  调用方
  Simulator facade 与 skill characterization 测试。

  输入
  独立 SearchState、技能 action 与执行世界。

  输出
  更新后的技能资源、次数、状态或 combat result。

  读取状态
  只读 ACTIVE_SKILLS、目标与 SearchState skill slots。

  写入状态
  只写独立 SearchState 的 energy、skill slots 和技能效果字段。

  调用函数
  Card/Combat/Response/Status components 与 state/Probability。

  边界与不变量
  不决定是否使用技能，不改变 cost、limit、目标或策略阈值。
  */
  syncActiveSkillCosts(state) {
    for (const player of state?.players ?? []) {
      const skill = ACTIVE_SKILLS[player.activeSkillId];
      if (skill) player.activeSkillCost = getActiveSkillCost(state, player, skill);
    }
  }

  /*
  功能
  推进主动技能效果步骤 applySkill。

  调用方
  Simulator facade 与 skill characterization 测试。

  输入
  独立 SearchState、技能 action 与执行世界。

  输出
  更新后的技能资源、次数、状态或 combat result。

  读取状态
  只读 ACTIVE_SKILLS、目标与 SearchState skill slots。

  写入状态
  只写独立 SearchState 的 energy、skill slots 和技能效果字段。

  调用函数
  Card/Combat/Response/Status components 与 state/Probability。

  边界与不变量
  不决定是否使用技能，不改变 cost、limit、目标或策略阈值。
  */
  applySkill(state, actor, action, eventWorlds) {
    const skill = action.skill;
    const target = state.players.find((player) => player.id === action.targets?.[0]?.id);
    const chance = this.eventProbability(eventWorlds);
    if (!skill || chance <= 0) return;
    if (skill.id === "allIn") {
      const joined = this.updateEnergyFromWorlds(actor, eventWorlds, (amount, branch) => (
        branch.occurs ? 0 : amount
      ));
      this.gainUnknownCardsWithCounterState(
        state,
        actor,
        (branch) => (branch.occurs ? Math.max(0, branch.energyAmount - 1) : 0),
        joined,
        "allIn-draw"
      );
      const currentAssaultBonus = actor.assaultBonus ?? 0;
      const joinedExpectedValue = joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * Math.min(1, branch.energyAmount * .25) : 0)
      ), 0);
      actor.assaultBonus = currentAssaultBonus + joinedExpectedValue * (1 - currentAssaultBonus);
      return;
    }
    const energyCost = action.energyCost ?? getActiveSkillCost(state, actor, skill);
    this.changeEnergy(state, actor, -energyCost, eventWorlds);
    if (skill.id === "breakArmy") {
      const attackSlots = this.ensureAttackUseSlots(actor);
      attackSlots.push(projectProbabilityStateBranches(eventWorlds, (branch) => ({
        available:Boolean(branch.occurs)
      })));
      actor.attackLimit = (actor.attackLimit ?? attackSlots.length - 1) + chance;
      actor.attackAvailabilityBranches = attackSlots.map(availableBranchesFromState);
    }
    else if (skill.id === "barrier" && target) {
      this.changeShield(state, target, 1, eventWorlds);
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(state, actor, target, chance);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, 1, { canBlock:true, eventBranches:eventWorlds });
      }
    } else if (skill.id === "hunt" && target) {
      target.huntMarkProbabilities ??= {};
      const oldMarkProbability = clampProbability(target.huntMarkProbabilities[actor.id]
        ?? (target.huntMarkSourceId === actor.id ? 1 : 0));
      const consumedMarkProbability = Math.min(oldMarkProbability, chance);
      const markBranches = target.huntMarkStateBranchesBySource?.[actor.id];
      if (Array.isArray(markBranches)) {
        const markedState = markBranches.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          marked:Boolean(branch.marked)
        }));
        const joinedMarks = joinProbabilityStateBranches(markedState, eventWorlds);
        target.huntMarkStateBranchesBySource[actor.id] = projectProbabilityStateBranches(
          joinedMarks,
          (branch) => ({ marked:Boolean(branch.marked && !branch.occurs) })
        );
        target.huntMarkProbabilities[actor.id] = totalBranchProbability(
          target.huntMarkStateBranchesBySource[actor.id].filter((branch) => branch.marked)
        );
      } else {
        target.huntMarkProbabilities[actor.id] = Math.max(0, oldMarkProbability - consumedMarkProbability);
      }
      target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities ?? {}).map(clampProbability));
      const fullMarkSource = Object.entries(target.huntMarkProbabilities)
        .find(([, probability]) => clampProbability(probability) >= 1 - Number.EPSILON)?.[0] ?? null;
      target.huntMarkSourceId = fullMarkSource;
      if (Array.isArray(target.statuses) && !fullMarkSource) {
        target.statuses = target.statuses.filter((status) => status !== "huntMark");
      }
      const outcome = {};
      this.applyDamage(state, actor, target, 2, {
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
          state, actor, outcome.blockedByCardChance, null, "hunt-blocked-draw"
        );
      }
    } else if (skill.id === "resonance" && target) {
      this.gainUnknownCardsWithCounterState(state, target, 1, eventWorlds, "resonance-draw");
    }
  }
};
