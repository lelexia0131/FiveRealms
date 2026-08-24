/*
模块职责
作为 World 模拟的唯一正式门面（统一对外入口），负责世界克隆、动作分派与共享运行时协调。

上游
Planner、ValueSimulationQuery 与模拟器专项测试。

下游
Response、Combat、CardEffect、SkillEffect 与 Status 模拟组件。

状态边界
只克隆并写入 World；不持有或修改真实 GameState。

信息边界
只消费过滤后的可见状态、合法记忆与 Probability 概率，不读取隐藏实体牌或未来牌堆。

架构约束
不得拥有 Policy、Value 或 Domain 公式；所有模拟算法只存在于本目录组件。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  currentProbabilitySignature,
  expectedBranchValue,
  intersectProbabilityStateBranchesCooperatively,
  mergeProbabilityStateBranchesCooperatively,
  probabilityEventPartition,
  projectProbabilityStateBranchesCooperatively,
  totalBranchProbability
} from "../state/Probability.js";
import { cloneWorld } from "../state/World.js";
import { hasPassiveSkill } from "../state/RuleProjection.js";

import { withResponseSimulation } from "./ResponseSimulation.js";
import { withCombatSimulation } from "./CombatSimulation.js";
import { withCardEffectSimulation } from "./CardEffectSimulation.js";
import { withSkillEffectSimulation } from "./SkillEffectSimulation.js";
import { withStatusSimulation } from "./StatusSimulation.js";

class SimulatorCore {
  /*
  功能
  创建只拥有独立 World 根世界的轻量模拟器。

  调用方
  Planner 与有界 Value/Root simulation query：为一次搜索或配对查询创建模拟生命周期。

  输入
  已过滤的 World 根快照，以及可选 SearchBudget 与 ResponsePolicy decision capabilities。

  输出
  持有独立 initial 世界的 Simulator 实例。

  读取状态
  只读输入 World。

  写入状态
  实例 initial、搜索预算、只读 decision capabilities、概率摘要初始化结果与 root 递归守卫。

  调用函数
  cloneWorld、各 Simulation 组件初始化器。

  边界与不变量
  构造不得回读 GameState；Policy capability 只返回 boolean；initial 与输入及其他实例不共享可变对象。
  */
  constructor(visibleState, options = {}) {
    this.searchBudget = options.searchBudget ?? null;
    this.decideCounter = typeof options.decideCounter === "function"
      ? options.decideCounter
      : () => false;
    this.decideLeverageAssault = typeof options.decideLeverageAssault === "function"
      ? options.decideLeverageAssault
      : () => false;
    this.checkpointSearchWork();
    this.searchBudget?.observeClone?.();
    this.initial = cloneWorld(visibleState);
    this.initializeMomentumBranches(this.initial);
    // root 结算模拟守卫：目标级 root 的 apply 群伤循环会再次请求 counterDecision，避免递归。
    this._simulatingRootResolution = false;
  }

  /*
  功能
  在已证实的长概率/响应同步循环内请求当前搜索预算 cooperative checkpoint。

  调用方
  Action/Response/Combat Simulation 的 current-event intersection、projection 与身份消费边界。

  输入
  无。

  输出
  可继续时返回 true；TIME/NODE/CANCEL 中断时由 SearchBudget 抛出专属 unwind signal。

  读取状态
  注入的 searchBudget。

  写入状态
  SearchBudget 首次过期时写入停止原因；不写 World。

  调用函数
  SearchBudget.checkpointCurrentWork。

  边界与不变量
  只允许 Planner preparation boundary 捕获 signal；当前 partial World/world 必须整体丢弃。
  */
  checkpointSearchWork() {
    return this.searchBudget?.checkpointCurrentWork?.() ?? true;
  }

  /*
  功能
  在同一 SearchBudget 下原子执行一次概率操作并记录纯数字 timing/count 诊断。

  调用方
  intersectProbabilityWork、projectProbabilityWork、mergeProbabilityWork 与 rawProbabilityWork。

  输入
  operation 名称、输入世界数、cooperative/raw 模式与返回完整分支数组的 work。

  输出
  work 的完整结果；cooperative 中断继续抛出本 SearchBudget 的专属 signal。

  读取状态
  注入的 SearchBudget 与 work 捕获的只读概率输入。

  写入状态
  只写 SearchBudget probability operation 诊断。

  调用函数
  SearchBudget.beginProbabilityOperation/finishProbabilityOperation、work。

  边界与不变量
  partial 结果不得登记；诊断不记录 state/world 内容，也不参与概率、预算或搜索排序。
  */
  runProbabilityOperation(operation, inputWorldCount, mode, work) {
    const token = this.searchBudget?.beginProbabilityOperation?.(
      operation,
      inputWorldCount,
      mode
    ) ?? null;
    try {
      const result = work();
      this.searchBudget?.finishProbabilityOperation?.(token, result?.length ?? 0, true);
      if (!token) this.searchBudget?.observeProbabilityWork?.(result?.length ?? 0);
      return result;
    } catch (error) {
      this.searchBudget?.finishProbabilityOperation?.(token, 0, false);
      throw error;
    }
  }

  /*
  功能
  在同一 SearchBudget checkpoint 下按当前事件索引相交概率状态，并记录完成工作量。

  调用方
  ResponseSimulation 与 CardEffectSimulation 的生产局部事件相交点。

  输入
  概率状态分区数组。

  输出
  完整当前事件交集；预算中断时由 SearchBudget signal 回退整个 candidate。

  读取状态
  注入的 SearchBudget 与只读概率分区。

  写入状态
  只更新 SearchBudget probability work 诊断。

  调用函数
  intersectProbabilityStateBranchesCooperatively、checkpointSearchWork、SearchBudget.observeProbabilityWork。

  边界与不变量
  partial 交集永不返回或计数；不预估或构造 generic Cartesian pair universe。
  */
  intersectProbabilityWork(partitions, operation = "Simulation.intersect") {
    let inputWorldCount = 0;
    const probabilityPartitions = partitions ?? [];
    for (let index = 0; index < probabilityPartitions.length; index += 1) {
      if (index > 0 && index % 32 === 0) this.checkpointSearchWork();
      const partition = probabilityPartitions[index];
      if (!Array.isArray(partition)) continue;
      inputWorldCount += partition.length;
    }
    const checkpoint = inputWorldCount >= 32 || this.searchBudget?.stopReason
      ? () => this.checkpointSearchWork()
      : null;
    return this.runProbabilityOperation(
      operation,
      inputWorldCount,
      "cooperative",
      () => intersectProbabilityStateBranchesCooperatively(
        partitions,
        checkpoint
      )
    );
  }

  /*
  功能
  在同一 SearchBudget checkpoint 下完整投影高分支概率状态，并记录完成工作量。

  调用方
  ResponseSimulation 与 CardEffectSimulation 的生产高频 projection 热点。

  输入
  完整世界数组与纯 projector。

  输出
  完整投影分区；预算中断时由 SearchBudget signal 回退整个 candidate。

  读取状态
  注入的 SearchBudget 与只读概率世界。

  写入状态
  只更新 SearchBudget probability work 诊断。

  调用函数
  projectProbabilityStateBranchesCooperatively、checkpointSearchWork、SearchBudget.observeProbabilityWork。

  边界与不变量
  partial projection 永不返回或计数；projector 不得修改输入世界。
  */
  projectProbabilityWork(worlds, projector, operation = "Simulation.project") {
    const checkpoint = (worlds?.length ?? 0) >= 32 || this.searchBudget?.stopReason
      ? () => this.checkpointSearchWork()
      : null;
    return this.runProbabilityOperation(
      operation,
      Array.isArray(worlds) ? worlds.length : 0,
      "cooperative",
      () => projectProbabilityStateBranchesCooperatively(
        worlds,
        projector,
        checkpoint
      )
    );
  }

  /*
  功能
  在同一 SearchBudget checkpoint 下完整合并高分支概率状态，并记录完成工作量。

  调用方
  ResponseSimulation 与 CardEffectSimulation 的生产高频 merge 热点。

  输入
  概率状态分支数组。

  输出
  完整合并分区；预算中断时由 SearchBudget signal 回退整个 candidate。

  读取状态
  注入的 SearchBudget 与只读概率分支。

  写入状态
  只更新 SearchBudget probability work 诊断。

  调用函数
  mergeProbabilityStateBranchesCooperatively、checkpointSearchWork、SearchBudget.observeProbabilityWork。

  边界与不变量
  partial merge 永不返回或计数；正常路径不改变签名、概率或输出顺序。
  */
  mergeProbabilityWork(branches, operation = "Simulation.merge") {
    const checkpoint = (branches?.length ?? 0) >= 32 || this.searchBudget?.stopReason
      ? () => this.checkpointSearchWork()
      : null;
    return this.runProbabilityOperation(
      operation,
      Array.isArray(branches) ? branches.length : 0,
      "cooperative",
      () => mergeProbabilityStateBranchesCooperatively(
        branches,
        checkpoint
      )
    );
  }

  /*
  功能
  在开始前观察 SearchBudget，并显式记录一项输入严格有界的 raw 概率操作。

  调用方
  已审计为小常数输入、无需在内部 cooperative checkpoint 的 Simulation 调用点。

  输入
  operation 名称、输入世界数与返回完整分支数组的 raw work。

  输出
  raw work 的完整结果。

  读取状态
  注入的 SearchBudget 与调用方小常数概率分区。

  写入状态
  只写 SearchBudget raw probability diagnostics。

  调用函数
  checkpointSearchWork、runProbabilityOperation。

  边界与不变量
  只允许输入规模不随玩家、手牌、world、response 或搜索深度增长的调用点；TIME 后不得启动。
  */
  rawProbabilityWork(operation, inputWorldCount, work) {
    this.checkpointSearchWork();
    return this.runProbabilityOperation(operation, inputWorldCount, "raw", work);
  }

  /*
  功能
  创建一个与输入和兄弟分支隔离的可变 World 模拟世界。

  调用方
  Planner、RootResolutionQuery、ValueSimulationQuery 与组件内反事实分支：创建兄弟世界。

  输入
  可选 World；缺省为实例 initial。内部 apply 可声明 checkpoint 已在同一原子边界完成。

  输出
  完成必要摘要同步的独立可变 World。

  读取状态
  只读输入状态或实例 initial。

  写入状态
  只写新克隆的响应、势能与技能费用摘要。

  调用函数
  checkpointSearchWork、SearchBudget.observeClone、cloneWorld、组件初始化器与 syncActiveSkillCosts。

  边界与不变量
  默认必须在 structuredClone 前观察同一个 SearchBudget；不得修改输入或 initial；
  每个概率分支和兄弟节点必须拥有独立可变状态。
  */
  clone(state = this.initial, options = {}) {
    if (options.checkpoint !== false) this.checkpointSearchWork();
    this.searchBudget?.observeClone?.();
    const cloned = cloneWorld(state);
    this.initializeMomentumBranches(cloned);
    this.syncActiveSkillCosts(cloned);
    return cloned;
  }

  /*
  功能
  从当前 Probability 充分状态与事件语义生成稳定键。

  调用方
  getEventWorlds、概率门控和各 Simulation 组件：为新条件事件取得共享身份。

  输入
  当前独立 World 与事件语义标签。

  输出
  新的稳定字符串键。

  读取状态
  当前 ProbabilityState sufficient statistics。

  写入状态
  无。

  调用函数
  currentProbabilitySignature。

  边界与不变量
  同一当前物理概率状态与同一语义事件必须复用该键；历史 operation count 不得进入键或 World。
  */
  currentProbabilityEventKey(state, label = "event") {
    return `simulation:${label}:${currentProbabilitySignature(state?.probabilityState)}`;
  }

  /*
  功能
  把显式分支或单一概率规范化为发生/未发生的完整事件世界分区。

  调用方
  动作分派及所有条件效果组件：把标量概率或调用方分支统一为概率分支（带条件的互斥世界）。

  输入
  独立 World、缺省发生概率、可选 suppliedBranches 与事件标签。

  输出
  规范化的新 occurs 分支数组。

  读取状态
  只读取显式概率输入与当前 ProbabilityState。

  写入状态
  无。

  调用函数
  mergeProbabilityStateBranches、probabilityEventPartition、currentProbabilityEventKey。

  边界与不变量
  调用方分支优先且不得被重新采样；新建分区的发生/未发生质量之和必须为一。
  */
  getEventWorlds(state, probability = 1, suppliedBranches = null, label = "event") {
    if (Array.isArray(suppliedBranches) && suppliedBranches.length) {
      return this.projectProbabilityWork(
        suppliedBranches,
        (branch) => ({ occurs:Boolean(branch.occurs ?? branch.executes) }),
        "Simulator.getEventWorlds:supplied"
      );
    }
    return probabilityEventPartition(
      this.currentProbabilityEventKey(state, label),
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
  World、已有事件分支、零到一的附加 chance 与门标签。

  输出
  保留原条件并追加门条件的 occurs 分支数组。

  读取状态
  只读已有分支与当前 ProbabilityState。

  写入状态
  无。

  调用函数
  intersectProbabilityStateBranches、probabilityEventPartition、currentProbabilityEventKey。

  边界与不变量
  chance 为零或一时不得额外创建随机条件；原事件为 false 的世界不能被门重新激活。
  */
  gateEventWorlds(state, eventWorlds, chance, label = "gate") {
    const probability = clampProbability(chance);
    if (probability >= 1 - PROBABILITY_EPSILON) return eventWorlds;
    if (probability <= PROBABILITY_EPSILON) {
      return this.projectProbabilityWork(
        eventWorlds,
        () => ({ occurs:false }),
        "Simulator.gateEventWorlds:closed"
      );
    }
    const gate = probabilityEventPartition(
      this.currentProbabilityEventKey(state, label), probability, "gateOccurs"
    );
    const intersection = this.intersectProbabilityWork(
      [eventWorlds, gate],
      "Simulator.gateEventWorlds:intersect"
    );
    return this.projectProbabilityWork(
      intersection,
      (branch) => ({ occurs:Boolean(branch.occurs && branch.gateOccurs) }),
      "Simulator.gateEventWorlds:project"
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
  玩家当前 energy。

  写入状态
  玩家当前 energy。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、expectedBranchValue。

  边界与不变量
  transformer 只能改变当前分支能量；条件身份和概率质量必须保留。
  */
  updateEnergyFromWorlds(player, worldBranches, transformer) {
    const energy = [{
      probability:1,
      conditions:{},
      energyAmount:Number(player.energy) || 0
    }];
    const intersection = this.intersectProbabilityWork(
      [energy, worldBranches],
      "Simulator.updateEnergyFromWorlds:intersect"
    );
    const updated = this.projectProbabilityWork(intersection, (branch) => ({
      amount:Math.max(0, Math.min(player.maxEnergy ?? Infinity,
        Number(transformer(branch.energyAmount, branch)) || 0))
    }), "Simulator.updateEnergyFromWorlds:project");
    player.energy = expectedBranchValue(updated);
    return intersection;
  }

  /*
  功能
  把确定或条件化的能量增减交给统一分支更新流程。

  调用方
  CardEffectSimulation 与 SkillEffectSimulation：结算确定或条件化能量增减。

  输入
  World、目标玩家、能量 delta 与可选事件世界。

  输出
  无返回值；玩家能量分支和摘要已推进。

  读取状态
  玩家当前能量与事件世界。

  写入状态
  玩家 energy。

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
  玩家当前 shield。

  写入状态
  玩家当前 shield。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、expectedBranchValue。

  边界与不变量
  条件身份与概率质量保持不变；transformer 不得修改其他战斗资源。
  */
  updateShieldFromWorlds(player, worldBranches, transformer) {
    const shield = [{
      probability:1,
      conditions:{},
      shieldAmount:Number(player.shield) || 0
    }];
    const intersection = this.intersectProbabilityWork(
      [shield, worldBranches],
      "Simulator.updateShieldFromWorlds:intersect"
    );
    const updated = this.projectProbabilityWork(intersection, (branch) => ({
      amount:Math.max(0, Number(transformer(branch.shieldAmount, branch)) || 0)
    }), "Simulator.updateShieldFromWorlds:project");
    player.shield = expectedBranchValue(updated);
    return intersection;
  }

  /*
  功能
  把确定或条件化的护盾增减交给统一分支更新流程。

  调用方
  CardEffectSimulation 与 SkillEffectSimulation：结算确定或条件化护盾增减。

  输入
  World、目标玩家、护盾 delta 与可选事件世界。

  输出
  无返回值；玩家护盾分支和摘要已推进。

  读取状态
  玩家当前护盾与事件世界。

  写入状态
  玩家 shield。

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
  行动者 World 摘要。

  输出
  每次突袭容量各自对应的可用状态分支数组。

  读取状态
  attackLimit 与 attackUsed 当前摘要。

  写入状态
  无；槽位只存在本次突袭 transition 调用栈。

  调用函数
  getAvailabilityStateBranches、availableBranchesFromState。

  边界与不变量
  标量次数只投影为本次 transition 的有界局部槽位；不得写回 World 或 Action。
  */
  ensureAttackUseSlots(player) {
    const used = Math.max(0, Number(player.attackUsed) || 0);
    const limit = Number.isFinite(Number(player.attackLimit))
      ? Math.max(0, Number(player.attackLimit))
      : used + 1;
    const remaining = Math.max(0, limit - used);
    return Array.from({ length:Math.ceil(remaining) }, (_, index) => probabilityEventPartition(
      `attack-use:${player.id}:${index}`,
      Math.min(1, remaining - index),
      "available"
    ));
  }

  /*
  功能
  从正式槽位或技能次数摘要恢复指定主动技能的独立可用世界。

  调用方
  apply：取得当前主动技能次数资源的完整槽位。

  输入
  行动者 World 摘要与正式技能定义。

  输出
  该技能每次容量对应的可用状态分支数组。

  读取状态
  当前技能次数、限制与使用摘要。

  写入状态
  无；槽位只存在本次技能 transition 调用栈。

  调用函数
  getAvailabilityStateBranches、availableBranchesFromState。

  边界与不变量
  技能限制为零时不得创建槽位；局部槽位不能增加期望可用次数或进入 World。
  */
  ensureSkillUseSlots(player, skill) {
    const uses = Math.max(0, Number(player.activeSkillUses ?? (player.activeSkillUsed ? 1 : 0)) || 0);
    const limit = Math.max(0, Number(player.activeSkillLimit ?? skill?.limitPerTurn ?? 1) || 0);
    const remaining = Math.max(0, limit - uses);
    return Array.from({ length:Math.ceil(remaining) }, (_, index) => probabilityEventPartition(
      `skill-use:${player.id}:${skill?.id ?? "unknown"}:${index}`,
      Math.min(1, remaining - index),
      "available"
    ));
  }

  /*
  功能
  将期望执行世界分配到一个可用槽位，并仅在相交世界中标记该槽已消费。

  调用方
  consumeAttackUse 与 apply 的技能分派：把执行世界绑定到一个次数槽。

  输入
  World、槽位数组、期望执行世界和标签。

  输出
  被消费的槽位下标、实际消费世界及其概率。

  读取状态
  各槽位可用状态与 desiredEventWorlds。

  写入状态
  只更新选中槽位在相交世界中的 available 状态。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、currentProbabilityEventKey。

  边界与不变量
  每个世界最多消费一个槽位；不兼容条件不能交叉消费，未满足质量原样返回为未执行。
  */
  consumeSlot(state, slots, desiredEventWorlds, label = "slot") {
    const indexes = slots.map((_, index) => index);
    let best = null;
    for (const index of indexes) {
      const slot = slots[index];
      if (!Array.isArray(slot)) continue;
      const normalizedSlot = this.mergeProbabilityWork(
        slot,
        "Simulator.consumeSlot:slot"
      );
      const slotState = [];
      for (let branchIndex = 0; branchIndex < normalizedSlot.length; branchIndex += 1) {
        if (branchIndex % 32 === 0) this.checkpointSearchWork();
        const branch = normalizedSlot[branchIndex];
        slotState.push({
          probability:branch.probability,
          conditions:branch.conditions,
          slotAvailable:Boolean(branch.available)
        });
      }
      const intersection = this.intersectProbabilityWork(
        [desiredEventWorlds, slotState],
        "Simulator.consumeSlot:intersect"
      );
      const actualWorlds = this.projectProbabilityWork(intersection, (branch) => ({
        occurs:Boolean(branch.occurs && branch.slotAvailable)
      }), "Simulator.consumeSlot:actual");
      const executionProbability = this.eventProbability(actualWorlds);
      if (executionProbability <= PROBABILITY_EPSILON
        || (best && executionProbability <= best.executionProbability + PROBABILITY_EPSILON)) continue;
      best = { index, intersection, eventWorlds:actualWorlds, executionProbability };
    }
    if (best) {
      slots[best.index] = this.projectProbabilityWork(best.intersection, (branch) => ({
        available:Boolean(branch.slotAvailable && !(branch.occurs && branch.slotAvailable))
      }), "Simulator.consumeSlot:remaining");
      return { index:best.index, eventWorlds:best.eventWorlds };
    }
    return {
      index:null,
      eventWorlds:this.projectProbabilityWork(
        desiredEventWorlds,
        () => ({ occurs:false }),
        "Simulator.consumeSlot:unavailable"
      )
    };
  }

  /*
  功能
  消费一次突袭槽位并同步攻击次数摘要，避免概率世界重复使用同一次数。

  调用方
  CombatSimulation.simulateAssault：在伤害结算前消费一次攻击容量。

  输入
  World、行动者与期望攻击世界。

  输出
  实际攻击事件世界、消费概率和槽位下标。

  读取状态
  行动者 attackUseSlots 与攻击次数摘要。

  写入状态
  attackUsed 当前摘要。

  调用函数
  ensureAttackUseSlots、consumeSlot、eventProbability。

  边界与不变量
  同一槽位在同一条件世界只能使用一次；摘要必须由槽位重新投影而不能另行扣减。
  */
  consumeAttackUse(state, player, desiredEventWorlds) {
    const slots = this.ensureAttackUseSlots(player);
    const consumed = this.consumeSlot(
      state,
      slots,
      desiredEventWorlds,
      `attack-slot:${player.id}`
    );
    const probability = this.eventProbability(consumed.eventWorlds);
    player.attackUsed = (player.attackUsed ?? 0) + probability;
    return consumed;
  }

  /*
  功能
  按动作类型把单个抽象动作分派给已组合的 Simulation 组件并推进独立世界。

  调用方
  Planner、CounterfactualTerms 与有界 simulation query：推进一个已经合法枚举的抽象动作。

  输入
  动作前 World、抽象动作与 viewer ID；动作已经由 ActionGenerator/Policy 选择。

  输出
  独立的动作后 World；输入状态保持不变。

  读取状态
  输入 World、canonical Action 的真实意图与正式卡牌/技能定义。

  写入状态
  只写本次 clone 及 root 递归守卫；具体效果写入委托各 Simulation 组件。

  调用函数
  clone、buildSkillExecutionWorlds、buildCardExecutionWorlds、applySkill、applyCardEffect 与响应查询。

  边界与不变量
  必须先通过当前 SearchBudget checkpoint 再 clone、支付和结算；卡牌级反制容量只消费一次，
  响应顺序和随机调用顺序不得改变；中断 signal 由 Planner preparation boundary 统一收束。
  */
  apply(state, action) {
    this.checkpointSearchWork();
    const next = this.clone(state, { checkpoint:false });
    if (next.playPhaseEnded) return next;
    const actor = next.players.find((player) => player.id === action.actorId);
    if (action.type === "end") {
      if (hasPassiveSkill(actor, "momentum")) {
        actor.momentum = 0;
      }
      next.playPhaseEnded = true;
      // 真实 TurnWorkflow 在出牌阶段结束后立即进入弃牌阶段并把手牌压到生命上限；
      // 搜索世界必须投影同一结算，否则 end 会把马上被强制弃置的牌仍计为可保留资源。
      this.applyMandatoryDiscard(next, actor);
      return next;
    }
    if (!actor) return next;
    if (action.type === "skill") {
      const skill = ACTIVE_SKILL_DEFINITIONS[action.skillId] ?? null;
      if (!skill) return next;
      const skillEventWorlds = this.buildSkillExecutionWorlds(next, actor, action, skill);
      const executionProbability = this.eventProbability(skillEventWorlds);
      if (executionProbability <= 0) return next;
      const skillLimit = actor.activeSkillLimit ?? skill.limitPerTurn ?? 1;
      actor.activeSkillUses = Math.min(skillLimit,
        (actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0)) + executionProbability);
      actor.activeSkillUsed = actor.activeSkillUses >= skillLimit - PROBABILITY_EPSILON;
      this.applySkill(next, actor, action, skillEventWorlds);
      this.syncActiveSkillCosts(next);
      return next;
    }
    const definition = CARD_DEFINITIONS[action.cardId] ?? null;
    const card = definition ? { ...definition, id:action.cardInstanceId } : null;
    if (!card) return next;
    const targetId = action.targetIds?.[0];
    const target = next.players.find((player) => player.id === targetId);
    const targets = (action.targetIds ?? [])
      .map((id) => next.players.find((player) => player.id === id))
      .filter(Boolean);
    const heldCard = (actor.hand ?? []).find((entry) => entry.id === action.cardInstanceId) ?? null;
    const cardEventWorlds = this.buildCardExecutionWorlds(
      next,
      actor,
      action,
      card,
      heldCard
    );
    if (heldCard) {
      heldCard.availability = Math.max(
        0,
        Number(heldCard.availability ?? 1) - this.eventProbability(cardEventWorlds)
      );
      if (heldCard.availability <= PROBABILITY_EPSILON) {
        actor.hand = actor.hand.filter((entry) => entry.id !== action.cardInstanceId);
      }
    }
    const executionProbability = this.eventProbability(cardEventWorlds);
    // restoreActorHand：root 效果估值专用。当前状态中 root 卡牌已经打出（资源已沉没），
    // 结算模拟时把这张卡的打出成本还原再扣，使资源账目净变化为 0，只体现 root 效果价值。
    const handRestore = action.execution?.restoreActorHand
      && executionProbability > PROBABILITY_EPSILON ? 1 : 0;
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability + handRestore);
    if (executionProbability <= 0) return next;
    // card-scope 的取消概率与容量消费必须使用同一份 responder 评估；两者之间没有
    // 状态变化，因此重复计算 counterDecision 只会增加开销，不会提供新信息。
    const cardScopeCounterEvaluation = card.category === "tactic"
      && card.counterable !== false && !action.execution?.ignoreCounter
      && card.counterScope !== "target"
      ? this.evaluateCardScopeCounterResponses(
        next,
        actor,
        card,
        targets,
        action.selection ?? null,
        { createCondition:true }
      )
      : null;
    let effectEventWorlds = cardEventWorlds;
    if (card.counterScope !== "target" && cardScopeCounterEvaluation) {
      const responseWorlds = this.intersectProbabilityWork([
        cardEventWorlds,
        cardScopeCounterEvaluation.responseWorlds
      ], "Simulator.apply:card-scope-response");
      cardScopeCounterEvaluation.responseWorlds = this.projectProbabilityWork(
        responseWorlds,
        (branch) => ({
          responderId:branch.occurs ? branch.responderId : null,
          availableKnownKeys:branch.availableKnownKeys ?? [],
        }),
        "Simulator.apply:card-scope-response-outcome"
      );
      effectEventWorlds = this.projectProbabilityWork(
        responseWorlds,
        (branch) => ({ occurs:Boolean(branch.occurs && branch.responderId === null) }),
        "Simulator.apply:card-scope-effect"
      );
    }
    const scale = this.eventProbability(effectEventWorlds);
    // card-scope 战术的生效概率与反制资源消费必须来自同一 responseEvaluation。
    // 这里兑现该评估的边际取消世界，使同一张反制不能既取消当前战术，又保留在
    // 当前 Counter query / sealCounterProbability 中成为未来可用容量。
    if (card.category === "tactic" && card.counterable !== false
      && !action.execution?.ignoreCounter && card.counterScope !== "target") {
      this.consumeCountersForCardScope(
        next,
        actor,
        card,
        targets,
        action.selection ?? null,
        cardScopeCounterEvaluation
      );
    }
    return this.applyCardEffect(next, actor, action, {
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
  在搜索世界的 end 动作后投影真实弃牌阶段的手牌上限结算。

  调用方
  apply 的 end 分支。

  输入
  独立 World 与行动者。

  输出
  无；行动者总手牌数量按生命上限压缩，并同步已知身份、匿名容量与概率摘要。

  读取状态
  行动者 hand/handCount、生命、匿名容量与公开装备上下文。

  写入状态
  手牌 availability、hand/handCount、匿名容量与突袭/格挡/反制/调息摘要。

  调用函数
  hasCompleteCertainHand、cardAvailability、consumeUnknownResourceCard、
  consumeChosenHandCard、syncCardEstimates。

  边界与不变量
  总手牌数以 handCount 为准，不得用 hand.length 掩盖匿名容量；完整确定手牌仍走正式保留价值选择，
  混合状态先消费匿名容量，再对剩余已知身份做保留价值选择；不虚构 definitionId，
  行动者未存活或手牌不超上限时为空操作。
  */
  applyMandatoryDiscard(state, actor) {
    if (!actor?.alive) return;
    const rawHandCount = Number(actor.handCount);
    const handSize = Number.isFinite(rawHandCount)
      ? Math.max(0, rawHandCount)
      : (Array.isArray(actor.hand) ? actor.hand.length : 0);
    const hp = Math.max(0, Number(actor.hp) || 0);
    let remaining = Math.max(0, handSize - hp);
    if (remaining <= PROBABILITY_EPSILON) return;
    if (!Array.isArray(actor.hand)) {
      // 无身份信息的摘要状态（测试夹具）无法按保留价值选牌，只投影数量上限。
      actor.handCount = Math.min(handSize, hp);
      return;
    }
    if (this.hasCompleteCertainHand(actor)) {
      this.consumeChosenHandCard(state, actor, remaining, {
        label:"end-hand-limit-discard"
      });
      return;
    }
    // 混合状态中的匿名容量没有可排序身份，先在匿名聚合内消费；
    // 余量只落在已知身份上，再复用正式保留价值选择，避免给匿名牌虚构 definitionId。
    while (remaining > PROBABILITY_EPSILON) {
      const explicitExpected = [
        ...(Array.isArray(actor.hand) ? actor.hand : []),
        ...(Array.isArray(actor.knownCards) ? actor.knownCards : [])
      ].reduce((sum, card) => sum + this.cardAvailability(card), 0);
      const anonymousCapacity = Math.max(
        0,
        Math.max(0, Number(actor.handCount) || 0) - explicitExpected
      );
      if (anonymousCapacity <= PROBABILITY_EPSILON) break;
      const removed = this.consumeUnknownResourceCard(
        state,
        actor,
        Math.min(1, remaining, anonymousCapacity),
        anonymousCapacity
      );
      if (removed <= PROBABILITY_EPSILON) break;
      remaining = Math.max(0, Math.max(0, Number(actor.handCount) || 0) - hp);
    }
    remaining = Math.max(0, Math.max(0, Number(actor.handCount) || 0) - hp);
    if (remaining > PROBABILITY_EPSILON) {
      this.consumeChosenHandCard(state, actor, remaining, {
        label:"end-hand-limit-discard"
      });
    }
    actor.handCount = Math.min(Math.max(0, Number(actor.handCount) || 0), hp);
  }

  /*
  功能
  从给定座位沿真实座次生成循环顺序，可选择是否包含起点。

  调用方
  CardEffectSimulation 的全体受益结算：按真实座次取得接收顺序。

  输入
  World、来源玩家与是否包含来源的布尔选项。

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
