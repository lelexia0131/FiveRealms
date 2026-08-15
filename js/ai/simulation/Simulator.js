/*
模块职责
作为 SearchState 模拟的唯一正式门面（统一对外入口），负责世界克隆、动作分派与共享运行时协调。

上游
Planner、ValueSimulationQuery 与模拟器专项测试。

下游
Response、Combat、CardEffect、SkillEffect 与 Status 模拟组件。

状态边界
只克隆并写入 SearchState；不持有或修改真实 GameState。

信息边界
只消费过滤后的可见状态、合法记忆与 Belief 概率，不读取隐藏实体牌或未来牌堆。

架构约束
不得拥有 Policy、Value 或 Domain 公式；所有模拟算法只存在于本目录组件。
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
} from "../state/Probability.js?build=20260815-ai-residue-cleanup-final";
import { cloneSearchState } from "../state/SearchState.js?build=20260815-ai-residue-cleanup-final";

import { clampProbability } from "./SimulationSupport.js?build=20260815-ai-residue-cleanup-final";
import { withResponseSimulation } from "./ResponseSimulation.js?build=20260815-ai-residue-cleanup-final";
import { withCombatSimulation } from "./CombatSimulation.js?build=20260815-ai-residue-cleanup-final";
import { withCardEffectSimulation } from "./CardEffectSimulation.js?build=20260815-ai-residue-cleanup-final";
import { withSkillEffectSimulation } from "./SkillEffectSimulation.js?build=20260815-ai-residue-cleanup-final";
import { withStatusSimulation } from "./StatusSimulation.js?build=20260815-ai-residue-cleanup-final";

class SimulatorCore {
  /*
  功能
  创建只拥有独立 SearchState 根世界的轻量模拟器。

  调用方
  Planner 与有界 Value/Root simulation query：为一次搜索或配对查询创建模拟生命周期。

  输入
  已经过滤且不含 Game 引用的 SearchState 根快照。

  输出
  持有独立 initial 世界的 Simulator 实例。

  读取状态
  只读输入 SearchState。

  写入状态
  实例 initial、概率摘要初始化结果与 root 递归守卫。

  调用函数
  cloneSearchState、各 Simulation 组件初始化器。

  边界与不变量
  构造不得回读 GameState；initial 与输入及其他模拟器实例不共享可变对象。
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
  Planner、RootResolutionQuery、ValueSimulationQuery 与组件内反事实分支：创建兄弟世界。

  输入
  可选 SearchState；缺省为实例 initial。

  输出
  完成必要摘要同步的独立可变 SearchState。

  读取状态
  只读输入状态或实例 initial。

  写入状态
  只写新克隆的装备、响应、势能与技能费用摘要。

  调用函数
  cloneSearchState、组件初始化器与 syncActiveSkillCosts。

  边界与不变量
  不得修改输入或 initial；每个概率分支和兄弟节点必须拥有独立可变状态。
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
  为概率事件分配单调递增的稳定键，使同一事件的互补世界共享条件身份。

  调用方
  getEventWorlds、概率门控和各 Simulation 组件：为新条件事件取得共享身份。

  输入
  当前独立 SearchState 与仅用于诊断的事件标签。

  输出
  新的稳定字符串键。

  读取状态
  SearchState.probabilityEventCounter。

  写入状态
  将 probabilityEventCounter 单调增加一。

  调用函数
  无。

  边界与不变量
  一次调用只分配一个键；同一事件的发生/未发生分支必须复用该键。
  */
  nextProbabilityEventKey(state, label = "event") {
    state.probabilityEventCounter = Math.max(0, Number(state.probabilityEventCounter) || 0) + 1;
    return `simulation:${label}:${state.probabilityEventCounter}`;
  }

  /*
  功能
  把显式分支或单一概率规范化为发生/未发生的完整事件世界分区。

  调用方
  动作分派及所有条件效果组件：把标量概率或调用方分支统一为概率分支（带条件的互斥世界）。

  输入
  独立 SearchState、缺省发生概率、可选 suppliedBranches 与事件标签。

  输出
  规范化的新 occurs 分支数组。

  读取状态
  只读取显式概率输入；生成新事件时读取事件计数。

  写入状态
  仅在生成新事件键时推进 probabilityEventCounter。

  调用函数
  mergeProbabilityStateBranches、probabilityEventPartition、nextProbabilityEventKey。

  边界与不变量
  调用方分支优先且不得被重新采样；新建分区的发生/未发生质量之和必须为一。
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
  将已有事件世界与额外触发门相交，保留联合条件和完整概率质量。

  调用方
  反制、技能与资源效果：在既有条件世界上追加一个独立触发门。

  输入
  SearchState、已有事件分支、零到一的附加 chance 与门标签。

  输出
  保留原条件并追加门条件的 occurs 分支数组。

  读取状态
  只读已有分支；中间概率时读取事件计数。

  写入状态
  仅在需要新门键时推进 probabilityEventCounter。

  调用函数
  joinProbabilityStateBranches、probabilityEventPartition、nextProbabilityEventKey。

  边界与不变量
  chance 为零或一时不得额外创建随机条件；原事件为 false 的世界不能被门重新激活。
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
  汇总事件世界中 occurs 分支的概率质量。

  调用方
  所有 Simulation 组件：把完整事件世界投影为发生概率。

  输入
  包含 probability 与 occurs 的事件分支数组。

  输出
  occurs=true 分支的总概率质量。

  读取状态
  无；只读传入分支。

  写入状态
  无。

  调用函数
  totalBranchProbability。

  边界与不变量
  只汇总已有质量，不归一化、不合并条件，也不改变分支对象。
  */
  eventProbability(eventWorlds) {
    return totalBranchProbability((eventWorlds ?? []).filter((branch) => branch.occurs));
  }

  /*
  功能
  按条件世界变换能量分支，并同步玩家的期望能量摘要。

  调用方
  changeEnergy 与主动技能模拟：按同一条件世界更新能量。

  输入
  目标玩家、事件世界和以当前能量/分支为输入的 transformer。

  输出
  新的完整能量状态分支数组。

  读取状态
  玩家 energyBranches 或确定 energy。

  写入状态
  玩家 energyBranches 与期望 energy 摘要。

  调用函数
  getValueBranches、joinProbabilityStateBranches、projectProbabilityStateBranches、expectedBranchValue。

  边界与不变量
  transformer 只能改变当前分支能量；条件身份和概率质量必须保留。
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
  把确定或条件化的能量增减交给统一分支更新流程。

  调用方
  CardEffectSimulation 与 SkillEffectSimulation：结算确定或条件化能量增减。

  输入
  SearchState、目标玩家、能量 delta 与可选事件世界。

  输出
  无返回值；玩家能量分支和摘要已推进。

  读取状态
  玩家当前能量分支与事件世界。

  写入状态
  玩家 energyBranches 与 energy。

  调用函数
  getEventWorlds、updateEnergyFromWorlds。

  边界与不变量
  能量不得小于零或超过 maxEnergy；未发生世界保持原值。
  */
  changeEnergy(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "energy");
    return this.updateEnergyFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

  /*
  功能
  按条件世界变换护盾分支，并同步玩家的期望护盾摘要。

  调用方
  changeShield：按同一条件世界更新护盾。

  输入
  目标玩家、事件世界和以当前护盾/分支为输入的 transformer。

  输出
  新的完整护盾状态分支数组。

  读取状态
  玩家 shieldBranches 或确定 shield。

  写入状态
  玩家 shieldBranches 与期望 shield 摘要。

  调用函数
  getValueBranches、joinProbabilityStateBranches、projectProbabilityStateBranches、expectedBranchValue。

  边界与不变量
  条件身份与概率质量保持不变；transformer 不得修改其他战斗资源。
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
  把确定或条件化的护盾增减交给统一分支更新流程。

  调用方
  CardEffectSimulation 与 SkillEffectSimulation：结算确定或条件化护盾增减。

  输入
  SearchState、目标玩家、护盾 delta 与可选事件世界。

  输出
  无返回值；玩家护盾分支和摘要已推进。

  读取状态
  玩家当前护盾分支与事件世界。

  写入状态
  玩家 shieldBranches 与 shield。

  调用函数
  getEventWorlds、updateShieldFromWorlds。

  边界与不变量
  护盾不得小于零；未发生世界保持原值。
  */
  changeShield(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "shield");
    return this.updateShieldFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

  /*
  功能
  从正式槽位或次数摘要恢复本回合每次突袭的独立可用世界。

  调用方
  consumeAttackUse、CardEffectSimulation 与破军技能：取得突袭次数资源的完整槽位。

  输入
  行动者 SearchState 摘要。

  输出
  每次突袭容量各自对应的可用状态分支数组。

  读取状态
  attackUseSlots；缺失时读取 attackLimit、attackUsed 与 availability 视图。

  写入状态
  仅在正式槽位缺失时补建 player.attackUseSlots。

  调用函数
  getAvailabilityStateBranches、availableBranchesFromState。

  边界与不变量
  标量次数回退只重建等价槽位；不得合并独立次数或改变部分已用质量。
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
  从正式槽位或技能次数摘要恢复指定主动技能的独立可用世界。

  调用方
  apply：取得当前主动技能次数资源的完整槽位。

  输入
  行动者 SearchState 摘要与正式技能定义。

  输出
  该技能每次容量对应的可用状态分支数组。

  读取状态
  activeSkillUseSlots；缺失时读取技能次数、限制和 availability 视图。

  写入状态
  仅在正式槽位缺失时补建 player.activeSkillUseSlots。

  调用函数
  getAvailabilityStateBranches、availableBranchesFromState。

  边界与不变量
  技能限制为零时不得创建槽位；回退不能增加期望可用次数。
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
  将期望执行世界分配到一个可用槽位，并仅在相交世界中标记该槽已消费。

  调用方
  consumeAttackUse 与 apply 的技能分派：把执行世界绑定到一个次数槽。

  输入
  SearchState、槽位数组、期望执行世界、可选首选槽位和标签。

  输出
  被消费的槽位下标、实际消费世界及其概率。

  读取状态
  各槽位可用状态与 desiredEventWorlds。

  写入状态
  只更新选中槽位在相交世界中的 available 状态。

  调用函数
  joinProbabilityStateBranches、projectProbabilityStateBranches、nextProbabilityEventKey。

  边界与不变量
  每个世界最多消费一个槽位；不兼容条件不能交叉消费，未满足质量原样返回为未执行。
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
  消费一次突袭槽位并同步攻击次数摘要，避免概率世界重复使用同一次数。

  调用方
  CombatSimulation.simulateAssault：在伤害结算前消费一次攻击容量。

  输入
  SearchState、行动者、期望攻击世界与可选槽位下标。

  输出
  实际攻击事件世界、消费概率和槽位下标。

  读取状态
  行动者 attackUseSlots 与攻击次数摘要。

  写入状态
  attackUseSlots、attackAvailabilityBranches、attackUsed 与 attackLimit 摘要。

  调用函数
  ensureAttackUseSlots、consumeSlot、eventProbability。

  边界与不变量
  同一槽位在同一条件世界只能使用一次；摘要必须由槽位重新投影而不能另行扣减。
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
  按动作类型把单个抽象动作分派给已组合的 Simulation 组件并推进独立世界。

  调用方
  Planner、CounterfactualTerms 与有界 simulation query：推进一个已经合法枚举的抽象动作。

  输入
  动作前 SearchState、抽象动作与 viewer ID；动作已经由 ActionGenerator/Policy 选择。

  输出
  独立的动作后 SearchState；输入状态保持不变。

  读取状态
  输入 SearchState、动作描述、执行概率分支与正式卡牌/技能定义。

  写入状态
  只写本次 clone 及 root 递归守卫；具体效果写入委托各 Simulation 组件。

  调用函数
  clone、applySkill、applyCardEffect、响应查询与次数槽 辅助函数。

  边界与不变量
  先 clone 后支付再结算；卡牌级反制容量只消费一次，响应顺序和随机调用顺序不得改变。
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
    // card-scope 战术的生效概率与反制资源消费必须来自同一 responseEvaluation。
    // 这里兑现该评估的边际取消世界，使同一张反制不能既取消当前战术，又保留在
    // counterProbability / sealCounterProbability 中成为未来可用容量。
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
  从给定座位沿真实座次生成循环顺序，可选择是否包含起点。

  调用方
  CardEffectSimulation 的全体受益结算：按真实座次取得接收顺序。

  输入
  SearchState、来源玩家与是否包含来源的布尔选项。

  输出
  按来源之后顺时针排列的存活玩家新数组。

  读取状态
  players 的 alive、id 与 seatIndex。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不修改 players 原数组；同座次输入保持现有稳定顺序，死亡玩家始终排除。
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

}

export class Simulator extends withStatusSimulation(
  withSkillEffectSimulation(
    withCardEffectSimulation(withCombatSimulation(withResponseSimulation(SimulatorCore)))
  )
) {}
