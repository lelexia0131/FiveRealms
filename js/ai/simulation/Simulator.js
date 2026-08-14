/*
模块职责
作为 SearchState 模拟的唯一正式 facade，负责世界克隆、动作分派与共享运行时协调。

上游
AiPlanner、AiValueSimulationQuery 与兼容 AiSimulator 重导出。

下游
Response、Combat、CardEffect、SkillEffect 与 Status simulation components。

状态边界
只克隆并写入 SearchState；不持有或修改真实 GameState。

信息边界
只消费过滤后的可见状态、合法记忆与 Belief 概率，不读取隐藏实体牌或未来牌堆。

架构约束
不得拥有 Policy、Value 或 Domain 公式；旧 AiSimulator 不得保留第二套算法。
*/
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  expectedBranchValue,
  getAvailabilityBranches,
  getAvailabilityStateBranches,
  getValueBranches,
  joinProbabilityStateBranches,
  mergeProbabilityStateBranches,
  probabilityEventPartition,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260814-ai-simulation-engine";
import { cloneSearchState } from "../state/SearchState.js?build=20260814-ai-simulation-engine";

import { clampProbability } from "./SimulationSupport.js?build=20260814-ai-simulation-engine";
import { withResponseSimulation } from "./ResponseSimulation.js?build=20260814-ai-simulation-engine";
import { withCombatSimulation } from "./CombatSimulation.js?build=20260814-ai-simulation-engine";
import { withCardEffectSimulation } from "./CardEffectSimulation.js?build=20260814-ai-simulation-engine";
import { withSkillEffectSimulation } from "./SkillEffectSimulation.js?build=20260814-ai-simulation-engine";
import { withStatusSimulation } from "./StatusSimulation.js?build=20260814-ai-simulation-engine";

class SimulatorCore {
  /*
  功能
  创建只拥有独立 SearchState 根世界的轻量模拟器。

  调用方
  AiPlanner、模拟器测试与性能基准。

  输入
  不含 Game 引用的合法 SearchState 根快照。

  输出
  新的 AiSimulator 实例并完成既有兼容摘要初始化。

  读取状态
  仅输入 SearchState。

  写入状态
  实例 initial 与递归结算守卫。

  调用函数
  cloneSearchState、各 initialize 兼容初始化器。

  边界与不变量
  构造过程不得回读 GameState，初始世界不得与根快照共享可变状态。
  */
  constructor(visibleState) {
    this.initial = cloneSearchState(visibleState);
    this.initializeEquipmentBaselines(this.initial);
    this.initializeAssaultSummaries(this.initial);
    this.initializeBlockCountDistributions(this.initial);
    this.initializeCounterCountDistributions(this.initial);
    this.initializeMomentumBranches(this.initial);
    // root 结算模拟守卫：目标级 root 的 apply 群伤循环会再次调用 counterDesire，避免递归。
    this._simulatingRootResolution = false;
  }

  /*
  功能
  创建一个与输入和兄弟分支隔离的可变 SearchState 模拟世界。

  调用方
  AiPlanner 搜索节点展开、Simulator 内部反事实分支与测试。

  输入
  可选 SearchState；缺省使用模拟器初始世界。

  输出
  完成兼容摘要同步的独立 SearchState 克隆。

  读取状态
  仅输入或实例 initial SearchState。

  写入状态
  仅写新克隆的初始化字段。

  调用函数
  cloneSearchState、既有初始化器、syncActiveSkillCosts。

  边界与不变量
  不得回读 GameState，任何写入不得污染输入、initial 或其他克隆。
  */
  clone(state = this.initial) {
    const cloned = cloneSearchState(state);
    this.initializeEquipmentBaselines(cloned);
    this.initializeBlockCountDistributions(cloned);
    this.initializeCounterCountDistributions(cloned);
    this.initializeMomentumBranches(cloned);
    this.syncActiveSkillCosts(cloned);
    return cloned;
  }































































  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 nextProbabilityEventKey。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  nextProbabilityEventKey(state, label = "event") {
    state.probabilityEventCounter = Math.max(0, Number(state.probabilityEventCounter) || 0) + 1;
    return `simulation:${label}:${state.probabilityEventCounter}`;
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 getEventWorlds。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  getEventWorlds(state, probability = 1, suppliedBranches = null, label = "event") {
    if (Array.isArray(suppliedBranches) && suppliedBranches.length) {
      return projectProbabilityStateBranches(suppliedBranches, (branch) => ({
        occurs:Boolean(branch.occurs ?? branch.executes)
      }));
    }
    return probabilityEventPartition(
      this.nextProbabilityEventKey(state, label),
      probability,
      "occurs"
    );
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 gateEventWorlds。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  gateEventWorlds(state, eventWorlds, chance, label = "gate") {
    const probability = clampProbability(chance);
    if (probability >= 1 - PROBABILITY_EPSILON) return eventWorlds;
    if (probability <= PROBABILITY_EPSILON) {
      return projectProbabilityStateBranches(eventWorlds, () => ({ occurs:false }));
    }
    const gate = probabilityEventPartition(
      this.nextProbabilityEventKey(state, label), probability, "gateOccurs"
    );
    return projectProbabilityStateBranches(
      joinProbabilityStateBranches(eventWorlds, gate),
      (branch) => ({ occurs:Boolean(branch.occurs && branch.gateOccurs) })
    );
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 eventProbability。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  eventProbability(eventWorlds) {
    return totalBranchProbability((eventWorlds ?? []).filter((branch) => branch.occurs));
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 updateEnergyFromWorlds。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  updateEnergyFromWorlds(player, worldBranches, transformer) {
    const energy = getValueBranches(player, "energy", player.energy).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      energyAmount:branch.amount
    }));
    const joined = joinProbabilityStateBranches(energy, worldBranches);
    player.energyBranches = projectProbabilityStateBranches(joined, (branch) => ({
      amount:Math.max(0, Math.min(player.maxEnergy ?? Infinity,
        Number(transformer(branch.energyAmount, branch)) || 0))
    }));
    player.energy = expectedBranchValue(player.energyBranches);
    return joined;
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 changeEnergy。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  changeEnergy(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "energy");
    return this.updateEnergyFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 updateShieldFromWorlds。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  updateShieldFromWorlds(player, worldBranches, transformer) {
    const shield = getValueBranches(player, "shield", player.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const joined = joinProbabilityStateBranches(shield, worldBranches);
    player.shieldBranches = projectProbabilityStateBranches(joined, (branch) => ({
      amount:Math.max(0, Number(transformer(branch.shieldAmount, branch)) || 0)
    }));
    player.shield = expectedBranchValue(player.shieldBranches);
    return joined;
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 changeShield。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  changeShield(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "shield");
    return this.updateShieldFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 ensureAttackUseSlots。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  ensureAttackUseSlots(player) {
    if (Array.isArray(player.attackUseSlots)) return player.attackUseSlots;
    const hasLimit = Number.isFinite(Number(player.attackLimit));
    const used = Math.max(0, Number(player.attackUsed) || 0);
    const limit = hasLimit ? Math.max(0, Math.ceil(Number(player.attackLimit))) : Math.max(1, Math.ceil(used + 1));
    player.attackUseSlots = Array.from({ length:limit }, (_, index) => [{
      probability:1,
      conditions:{},
      available:index >= Math.ceil(used)
    }]);
    return player.attackUseSlots;
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 ensureSkillUseSlots。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  ensureSkillUseSlots(player, skill) {
    if (Array.isArray(player.activeSkillUseSlots)) return player.activeSkillUseSlots;
    if (Array.isArray(player.activeSkillAvailabilityBranches)) {
      player.activeSkillUseSlots = player.activeSkillAvailabilityBranches.map((availabilityBranches) => (
        getAvailabilityStateBranches({ availabilityBranches })
      ));
      return player.activeSkillUseSlots;
    }
    const uses = Math.max(0, Number(player.activeSkillUses ?? (player.activeSkillUsed ? 1 : 0)) || 0);
    const limit = Math.max(0, Math.ceil(Number(player.activeSkillLimit ?? skill?.limitPerTurn ?? 1) || 0));
    player.activeSkillUseSlots = Array.from({ length:limit }, (_, index) => [{
      probability:1,
      conditions:{},
      available:index >= Math.ceil(uses)
    }]);
    return player.activeSkillUseSlots;
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 consumeSlot。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  consumeSlot(state, slots, desiredEventWorlds, preferredIndex = null, label = "slot") {
    const indexes = preferredIndex == null
      ? slots.map((_, index) => index)
      : [preferredIndex];
    let best = null;
    for (const index of indexes) {
      const slot = slots[index];
      if (!Array.isArray(slot)) continue;
      const slotState = mergeProbabilityStateBranches(slot).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        slotAvailable:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(desiredEventWorlds, slotState);
      const actualWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(branch.occurs && branch.slotAvailable)
      }));
      const executionProbability = this.eventProbability(actualWorlds);
      if (executionProbability <= PROBABILITY_EPSILON
        || (best && executionProbability <= best.executionProbability + PROBABILITY_EPSILON)) continue;
      best = { index, joined, eventWorlds:actualWorlds, executionProbability };
    }
    if (best) {
      slots[best.index] = projectProbabilityStateBranches(best.joined, (branch) => ({
        available:Boolean(branch.slotAvailable && !(branch.occurs && branch.slotAvailable))
      }));
      return { index:best.index, eventWorlds:best.eventWorlds };
    }
    return {
      index:null,
      eventWorlds:projectProbabilityStateBranches(desiredEventWorlds, () => ({ occurs:false }))
    };
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 consumeAttackUse。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  consumeAttackUse(state, player, desiredEventWorlds, preferredIndex = null) {
    const slots = this.ensureAttackUseSlots(player);
    const consumed = this.consumeSlot(state, slots, desiredEventWorlds, preferredIndex,
      `attack-slot:${player.id}`);
    const probability = this.eventProbability(consumed.eventWorlds);
    player.attackAvailabilityBranches = slots.map(availableBranchesFromState);
    player.attackUsed = (player.attackUsed ?? 0) + probability;
    return consumed;
  }

  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 apply。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  apply(state, abstractAction, viewerId) {
    const next = this.clone(state);
    if (next.playPhaseEnded) return next;
    const actor = next.players.find((player) => player.id === viewerId);
    if (abstractAction.type === "end") {
      if (actor?.generalId === "blade-walker") {
        actor.momentumBranches = [{ probability:1, conditions:{}, amount:0 }];
        actor.momentum = 0;
      }
      next.playPhaseEnded = true;
      return next;
    }
    if (!actor) return next;
    if (abstractAction.type === "skill") {
      const desiredWorlds = this.getEventWorlds(next,
        abstractAction.executionProbability ?? 1,
        abstractAction.executionWorldBranches,
        `skill:${abstractAction.skill?.id ?? "unknown"}`);
      const skillSlots = this.ensureSkillUseSlots(actor, abstractAction.skill);
      const consumed = this.consumeSlot(next, skillSlots, desiredWorlds,
        abstractAction.skillUseSlot, `skill-slot:${abstractAction.skill?.id ?? "unknown"}`);
      const skillEventWorlds = consumed.eventWorlds;
      const executionProbability = this.eventProbability(skillEventWorlds);
      if (executionProbability <= 0) return next;
      const skillLimit = actor.activeSkillLimit ?? abstractAction.skill?.limitPerTurn ?? 1;
      actor.activeSkillAvailabilityBranches = skillSlots.map(availableBranchesFromState);
      actor.activeSkillUses = Math.min(skillLimit,
        (actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0)) + executionProbability);
      actor.activeSkillUsed = actor.activeSkillUses >= skillLimit - PROBABILITY_EPSILON;
      this.applySkill(next, actor, abstractAction, skillEventWorlds);
      this.syncActiveSkillCosts(next);
      return next;
    }
    const card = abstractAction.card;
    if (!card) return next;
    const assaultAvailabilityBeforeUse = card.definitionId === "assault"
      ? clampProbability(actor.assaultResponseProbability)
      : 0;
    const target = next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
    const heldCard = (actor.hand ?? []).find((entry) => entry.id === card.id) ?? null;
    const availabilityBranches = getAvailabilityBranches(heldCard ?? card);
    const cardProbability = totalBranchProbability(availabilityBranches);
    const desiredCardWorlds = this.getEventWorlds(next,
      abstractAction.executionProbability ?? cardProbability,
      abstractAction.executionWorldBranches,
      `card:${card.id ?? card.definitionId}`);
    let cardEventWorlds = desiredCardWorlds;
    if (heldCard) {
      const availabilityState = getAvailabilityStateBranches(heldCard).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        cardAvailable:Boolean(branch.available)
      }));
      const joined = joinProbabilityStateBranches(desiredCardWorlds, availabilityState);
      cardEventWorlds = projectProbabilityStateBranches(joined, (branch) => ({
        occurs:Boolean(branch.occurs && branch.cardAvailable)
      }));
      heldCard.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.cardAvailable && !(branch.occurs && branch.cardAvailable))
      }));
      heldCard.availabilityBranches = availableBranchesFromState(heldCard.availabilityStateBranches);
      const remainingProbability = totalBranchProbability(heldCard.availabilityBranches);
      actor.hand = remainingProbability > 0 ? actor.hand : actor.hand.filter((entry) => entry.id !== card.id);
    }
    const executionProbability = this.eventProbability(cardEventWorlds);
    if (card.definitionId === "assault" && assaultAvailabilityBeforeUse > PROBABILITY_EPSILON) {
      this.consumeAssaultForOpportunity(actor,
        Math.min(1, executionProbability / assaultAvailabilityBeforeUse));
    }
    // restoreActorHand：root 效果估值专用。当前状态中 root 卡牌已经打出（资源已沉没），
    // 结算模拟时把这张卡的打出成本还原再扣，使资源账目净变化为 0，只体现 root 效果价值。
    const handRestore = abstractAction.restoreActorHand && executionProbability > PROBABILITY_EPSILON ? 1 : 0;
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability + handRestore);
    if (executionProbability <= 0) return next;
    // card-scope 的取消概率与容量消费必须使用同一份 responder 评估；两者之间没有
    // 状态变化，因此重复计算 counterDesire 只会增加开销，不会提供新信息。
    const cardScopeCounterEvaluation = card.category === "tactic"
      && card.counterable !== false && card.counterScope !== "target"
      ? this.evaluateCardScopeCounterResponses(
        next, actor, card, abstractAction.targets ?? [], abstractAction.selection ?? null
      )
      : null;
    const effectEventWorlds = card.counterScope === "target"
      ? cardEventWorlds
      : this.gateEventWorlds(
        next,
        cardEventWorlds,
        cardScopeCounterEvaluation?.resolutionChance ?? 1,
        `counter:${card.id ?? card.definitionId}`
      );
    const scale = this.eventProbability(effectEventWorlds);
    // 反制容量双算修复：card-scope 战术的效果已由 tacticResolutionChance 按
    // counterProbability×desire 概率折算，但旧实现不消费反制容量，同一张反制会被
    // "取消本次战术"与"封印反制"等未来预期重复计价。这里按边际取消
    // 概率实际消费反制容量：容量耗尽后 counterProbability / sealCounterProbability
    // 等未来预期自然归零，不再出现 realized + expected 针对同一张反制并存。
    if (card.category === "tactic" && card.counterable !== false && card.counterScope !== "target") {
      this.consumeCountersForCardScope(
        next,
        actor,
        card,
        abstractAction.targets ?? [],
        abstractAction.selection ?? null,
        cardScopeCounterEvaluation
      );
    }
    return this.applyCardEffect(next, actor, abstractAction, {
      card,
      target,
      cardEventWorlds,
      effectEventWorlds,
      executionProbability,
      scale
    });
  }

































































  /*
  功能
  执行 Simulator facade 的共享生命周期步骤 seatOrderFrom。

  调用方
  Simulator facade、已组合的 simulation components 与历史兼容测试。

  输入
  独立 SearchState、动作描述或显式概率世界。

  输出
  新 SearchState、事件世界或共享资源摘要。

  读取状态
  只读输入 SearchState 与显式 action/probability data。

  写入状态
  只写独立 SearchState clone 或 facade 实例局部守卫。

  调用函数
  state/Probability、cloneSearchState 与已组合 component 方法。

  边界与不变量
  不得读取 Game/UI/Controller；不得重复 clone、apply 或具体效果算法。
  */
  seatOrderFrom(state, source, includeSource = false) {
    const players = state?.players ?? [];
    const seatCount = Math.max(1, players.length);
    const sourceSeat = Number(source?.seatIndex) || 0;
    return players.filter((player) => player.alive && (includeSource || player.id !== source.id))
      .sort((left, right) => {
        const leftDistance = ((Number(left.seatIndex) || 0) - sourceSeat + seatCount) % seatCount;
        const rightDistance = ((Number(right.seatIndex) || 0) - sourceSeat + seatCount) % seatCount;
        return leftDistance - rightDistance;
      });
  }





































  /** 五种进入手牌的基础判定定义；战术与装备可聚合，基础牌必须各自成支。 */



















}

export class Simulator extends withStatusSimulation(
  withSkillEffectSimulation(
    withCardEffectSimulation(withCombatSimulation(withResponseSimulation(SimulatorCore)))
  )
) {}
