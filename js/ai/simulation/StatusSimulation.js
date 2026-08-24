/*
模块职责
镜像延迟状态、雷达判定和角色被动状态钩子的 World 生命周期。

上游
Simulator 正式模拟门面、CardEffectSimulation 与 CombatSimulation。

下游
Lightning/Seal/Radar domain models、角色/卡牌配置与 Probability。

状态边界
只修改 Simulator 门面提供的独立 World 副本。

信息边界
只消费过滤状态和显式概率分支，不读取未来判定实体牌。

架构约束
真实状态与监听顺序以 StatusResolutionWorkflow、JudgmentWorkflow 和 Application triggers 为权威；不拥有 Policy 或 Value 公式。
*/
import { CARD_DEFINITIONS as DOMAIN_CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { interpretDefenseJudgment } from "../../domain/rules/judgment/JudgmentRules.js";
import { getLightningStatusStateBranches, lightningPresenceProbability } from "../domain/LightningModel.js";
import { getSealStatusStateBranches, sealPresenceProbability } from "../domain/SealModel.js";
import {
  buildRadarJudgmentSequenceProbabilities
} from "../domain/RadarModel.js";
import { hasPassiveSkill } from "../state/RuleProjection.js";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  clampProbability,
  expectedBranchValue,
  independentUnionProbability,
  probabilityEventPartition,
  queryCurrentCardCounts,
  totalBranchProbability
} from "../state/Probability.js";

/*
功能
把 Base class 与 StatusSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把 StatusSimulation 方法加入正式模拟门面。

输入
已经包含上一层模拟能力的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增 势能、角色被动、雷达与延迟状态方法 的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withStatusSimulation = (Base) => class StatusSimulation extends Base {
  /*
  功能
  为刀客补齐势能与本回合卡牌类别使用的概率分支，并同步确定摘要。

  调用方
  Simulator 构造/clone 与 simulateCategoryUse：补齐刀客概率状态。

  输入
  独立 World。

  输出
  无返回值；刀客的势能和类别使用分支已存在并同步。

  读取状态
  玩家 characterId、momentum、categoriesUsed 及已有概率分支。

  写入状态
  momentumBranches、categoryUsedStateBranchesByCategory 及摘要字段。

  调用函数
  syncMomentumSummary、syncCategoryUsedSummary。

  边界与不变量
  已有正式分支只规范不重采样；非刀客不获得额外势能状态。
  */
  initializeMomentumBranches(state) {
    for (const player of state?.players ?? []) {
      if (!hasPassiveSkill(player, "momentum")) continue;
      this.syncMomentumSummary(player);
      player.categoryUsedProbabilities ??= {};
      player.categoriesUsed ??= [];
      for (const category of ["basic", "tactic", "equipment"]) {
        player.categoryUsedProbabilities[category] = clampProbability(
          player.categoryUsedProbabilities[category]
            ?? (player.categoriesUsed.includes(category) ? 1 : 0)
        );
        this.syncCategoryUsedSummary(player, category);
      }
    }
  }

  /*
  功能
  规范势能数量分支并把其期望值同步到玩家势能摘要。

  调用方
  CombatSimulation 与本模块势能推进：读取规范化刀客势能世界。

  输入
  包含势能确定值或 momentumBranches 的玩家摘要。

  输出
  规范化后的 amount 概率分支数组。

  读取状态
  player.momentumBranches 与 momentum。

  写入状态
  momentumBranches 与期望 momentum。

  调用函数
  mergeProbabilityStateBranches、expectedBranchValue。

  边界与不变量
  势能量不得为负；摘要必须由完整分支投影，不能另行累加。
  */
  syncMomentumSummary(player) {
    player.momentum = Math.max(
      0,
      Math.min(PASSIVE_SKILL_DEFINITIONS.momentum.maxStacks, Number(player.momentum) || 0)
    );
    return [{ probability:1, conditions:{}, amount:player.momentum }];
  }

  /*
  功能
  合并指定卡牌类别的已用分支，并同步概率与确定类别列表。

  调用方
  initializeMomentumBranches 与 simulateCategoryUse：同步一种卡牌类别的本回合使用状态。

  输入
  玩家摘要与卡牌 category。

  输出
  规范化后的 used 概率分支数组。

  读取状态
  类别分支、类别概率与确定 categoriesUsed。

  写入状态
  categoryUsedStateBranchesByCategory、categoryUsedProbabilities 与 categoriesUsed。

  调用函数
  mergeProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  只有概率一的类别才进入确定列表；不同类别的条件身份不得互相覆盖。
  */
  syncCategoryUsedSummary(player, category) {
    const probability = clampProbability(
      player.categoryUsedProbabilities?.[category]
        ?? (player.categoriesUsed?.includes(category) ? 1 : 0)
    );
    player.categoryUsedProbabilities ??= {};
    player.categoryUsedProbabilities[category] = probability;
    const index = player.categoriesUsed.indexOf(category);
    if (probability >= 1 - PROBABILITY_EPSILON && index < 0) player.categoriesUsed.push(category);
    else if (probability < 1 - PROBABILITY_EPSILON && index >= 0) player.categoriesUsed.splice(index, 1);
    if (probability <= PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, used:false }];
    }
    if (probability >= 1 - PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, used:true }];
    }
    return [
      { probability, conditions:{}, used:true },
      { probability:1 - probability, conditions:{}, used:false }
    ];
  }

  /*
  功能
  联合卡牌使用、类别历史与生命伤害世界，结算刀客势能获得或清空。

  调用方
  CardEffectSimulation 与 CombatSimulation：在牌实际使用后推进刀客势能。

  输入
  World、行动者、卡牌类别、使用世界与可选生命伤害世界。

  输出
  无返回值；类别使用和势能分支已推进。

  读取状态
  刀客身份、当前类别/势能分支与本次使用/伤害条件。

  写入状态
  类别已用分支、类别概率、categoriesUsed、momentumBranches 与 momentum。

  调用函数
  initializeMomentumBranches、getEventWorlds、intersectProbabilityStateBranches、syncMomentumSummary、syncCategoryUsedSummary。

  边界与不变量
  同类首次且造成生命伤害才增加势能，重复类别在相交世界清空；条件质量必须守恒。
  */
  simulateCategoryUse(state, player, category, useResolution = 1, lifeDamageResolution = null) {
    if (!category || !hasPassiveSkill(player, "momentum")) return 0;
    this.initializeMomentumBranches({ players: [player] });
    const useWorlds = Array.isArray(useResolution)
      ? this.getEventWorlds(state, 1, useResolution, `momentum-use:${player.id}:${category}`)
      : this.getEventWorlds(state, clampProbability(useResolution), null,
        `momentum-use:${player.id}:${category}`);
    const lifeDamageWorlds = Array.isArray(lifeDamageResolution)
      ? this.getEventWorlds(state, 1, lifeDamageResolution,
        `momentum-life-damage:${player.id}:${category}`)
      : this.getEventWorlds(state, clampProbability(lifeDamageResolution), null,
        `momentum-life-damage:${player.id}:${category}`);
    const momentumState = this.syncMomentumSummary(player).map((branch) => ({
      probability: branch.probability,
      conditions: branch.conditions,
      momentumAmount: branch.amount
    }));
    const categoryState = this.syncCategoryUsedSummary(player, category).map((branch) => ({
      probability: branch.probability,
      conditions: branch.conditions,
      categoryUsed: Boolean(branch.used)
    }));
    const joined = this.intersectProbabilityWork(
      [momentumState, categoryState, useWorlds.map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        cardUsed: Boolean(branch.occurs)
      })),
      lifeDamageWorlds.map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        lifeDamage: Boolean(branch.occurs)
      }))],
      "StatusSimulation.simulateCategoryUse:join"
    );
    const firstUseProbability = totalBranchProbability(
      joined.filter((branch) => branch.cardUsed && !branch.categoryUsed)
    );
    const momentumOutcomes = this.projectProbabilityWork(joined, (branch) => {
      if (!branch.cardUsed) return { amount: branch.momentumAmount };
      const retained = branch.lifeDamage ? 0 : branch.momentumAmount;
      return {
        amount: Math.min(PASSIVE_SKILL_DEFINITIONS.momentum.maxStacks,
          retained + (!branch.categoryUsed ? PASSIVE_SKILL_DEFINITIONS.momentum.stacksGain : 0))
      };
    }, "StatusSimulation.simulateCategoryUse:momentum");
    const categoryOutcomes = this.projectProbabilityWork(
      joined,
      (branch) => ({ used: Boolean(branch.categoryUsed || branch.cardUsed) }),
      "StatusSimulation.simulateCategoryUse:category"
    );
    player.momentum = expectedBranchValue(momentumOutcomes);
    player.categoryUsedProbabilities[category] = totalBranchProbability(
      categoryOutcomes.filter((branch) => branch.used)
    );
    this.syncMomentumSummary(player);
    this.syncCategoryUsedSummary(player, category);
    return firstUseProbability;
  }

  /*
  功能
  模拟「冒险」被动：首次战术牌触发后按定义概率决定是否获得摸牌收益。
  
  调用方
  CardEffectSimulation.applyCardEffect。
  
  输入
  World、行动者、已使用卡牌与生效概率。
  
  输出
  返回本次新增触发概率；成功世界中的摸牌状态已推进。
  
  读取状态
  gambleTriggeredProbability、gambleTriggered 与 SkillDefinitions 的 drawChance/drawCount。
  
  写入状态
  手牌/响应摘要、gambleTriggeredProbability 与 gambleTriggered。
  
  调用函数
  getEventWorlds、gateEventWorlds、gainUnknownCardsWithCounterState。
  
  边界与不变量
  每回合首次战术牌才产生新增触发质量；drawChance 决定成功世界，drawCount 决定成功世界中的摸牌数量，两项固定事实均由 SkillDefinitions 拥有。
  */
  simulateGamble(state, actor, card, useProbability) {
    if (!hasPassiveSkill(actor, "gamble") || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(
      actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0)
    );
    const newProbability = independentUnionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const gambleWorlds = this.getEventWorlds(
        state,
        triggerProbability,
        null,
        "gamble-trigger"
      );
      const gambleSuccessWorlds = this.gateEventWorlds(
        state,
        gambleWorlds,
        PASSIVE_SKILL_DEFINITIONS.gamble.drawChance,
        "gamble-success"
      );
      this.gainUnknownCardsWithCounterState(
        state,
        actor,
        PASSIVE_SKILL_DEFINITIONS.gamble.drawCount,
        gambleSuccessWorlds,
        "gamble-draw"
      );
    }
    return triggerProbability;
  }

  /*
  功能
  按协同生效世界为有效目标结算团队资源增益。

  调用方
  CardEffectSimulation、CombatSimulation 与 SkillEffectSimulation：在有效目标世界结算协同收益。

  输入
  World、来源、有效目标列表与结算概率。

  输出
  无返回值；团队目标资源与协同触发摘要已更新。

  读取状态
  来源/目标阵营、存活状态与 coordinationTriggeredProbability。

  写入状态
  目标手牌/响应摘要、能量或协同触发字段。

  调用函数
  gainUnknownCardsWithCounterState、changeEnergy。

  边界与不变量
  只作用于调用方确认的有效目标；同一触发质量不得对同一目标重复发放。
  */
  simulateCoordination(state, actor, effectiveTargets, resolutionProbability) {
    if (!hasPassiveSkill(actor, "coordination")) return 0;
    if (!(effectiveTargets ?? []).some((target) => target?.alive && target.id !== actor.id
      && target.battleTeam === actor.battleTeam)) return 0;
    const oldProbability = clampProbability(actor.coordinationTriggeredProbability
      ?? (actor.coordinationTriggered ? 1 : 0));
    const newProbability = independentUnionProbability(oldProbability, resolutionProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.coordinationTriggeredProbability = newProbability;
    actor.coordinationTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const coordinationWorlds = this.getEventWorlds(state, triggerProbability, null, "coordination-draw");
      this.gainUnknownCardsWithCounterState(
        state, actor, triggerProbability, coordinationWorlds, "coordination-draw"
      );
    }
    return triggerProbability;
  }

  /*
  功能
  按追猎命中世界写入来源绑定的猎物标记及其概率分支。

  调用方
  CombatSimulation.simulateAssault：在突袭执行世界写入追猎标记。

  输入
  World、攻击来源、目标与突袭事件世界。

  输出
  无返回值；目标的来源绑定标记分支已推进。

  读取状态
  目标已有 huntMark 分支和来源 ID。

  写入状态
  huntMarkStateBranchesBySource、huntMarkProbabilities、huntMarkProbability、huntMarkSourceId 与 statuses。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  不同来源的标记分别记账；确定摘要只能来自概率一世界，未命中世界保持原标记。
  */
  simulateTracking(state, source, target, eventWorlds) {
    if (!hasPassiveSkill(source, "tracking") || target.battleTeam === source.battleTeam) return;
    source.trackingTargetIds ??= [];
    // 同一敌人本回合只能触发一次；猎杀移除标记也不会返还该次追踪额度。
    if (source.trackingTargetIds.includes(target.id)) return;
    source.trackingUses ??= source.trackingTargetIds.length;
    target.huntMarkProbabilities ??= {};
    const oldProbability = clampProbability(target.huntMarkProbabilities[source.id]
      ?? (target.huntMarkSourceId === source.id ? 1 : 0));
    const remainingUses = Math.max(
      0,
      PASSIVE_SKILL_DEFINITIONS.tracking.maxTargetsPerTurn - source.trackingUses
    );
    const limitedEventWorlds = this.eventProbability(eventWorlds) <= remainingUses + PROBABILITY_EPSILON
      ? eventWorlds
      : this.gateEventWorlds(state, eventWorlds,
        remainingUses / this.eventProbability(eventWorlds), `tracking-limit:${source.id}:${target.id}`);
    const existingBranches = probabilityEventPartition(
      this.currentProbabilityEventKey(state, `hunt-mark-existing:${source.id}:${target.id}`),
      oldProbability,
      "marked"
    );
    const joined = this.intersectProbabilityWork(
      [existingBranches, limitedEventWorlds],
      "StatusSimulation.simulateTracking:join"
    );
    const markState = this.projectProbabilityWork(joined, (branch) => ({
      marked: Boolean(branch.marked || branch.occurs)
    }), "StatusSimulation.simulateTracking:project");
    const markProbability = totalBranchProbability(markState.filter((branch) => branch.marked));
    const gainedProbability = Math.max(0, markProbability - oldProbability);
    target.huntMarkProbabilities[source.id] = markProbability;
    target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities).map(clampProbability));
    source.trackingUses += gainedProbability;
    if (markProbability >= 1 - Number.EPSILON && !source.trackingTargetIds.includes(target.id)) {
      source.trackingTargetIds.push(target.id);
      target.huntMarkSourceId = source.id;
      if (Array.isArray(target.statuses) && !target.statuses.includes("huntMark")) target.statuses.push("huntMark");
    }
  }

  /*
  功能
  在生命伤害世界中按真实钩子顺序结算受伤后的角色被动效果。

  调用方
  CombatSimulation.applyDamage：生命伤害落地后按权威顺序触发角色被动。

  输入
  World、可空来源、目标、生命伤害概率/分支与伤害上下文。

  输出
  无返回值；所有与生命伤害相关的被动状态已推进。

  读取状态
  双方角色、伤害来源、上下文去重标记与生命伤害条件。

  写入状态
  角色被动对应的手牌、能量、标记、势能或一次性触发字段。

  调用函数
  simulateSpyGapAfterLifeDamage 及资源/概率辅助函数。

  边界与不变量
  只在生命伤害世界触发；同一 damageContext 的一次性被动不得重复执行，调用顺序保持真实监听顺序。
  */
  simulateAfterLifeDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null, damageContext = {}) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target) return;
    if (damageContext.cardDamage && hasPassiveSkill(source, "ember")
      && target.battleTeam !== source.battleTeam) {
      damageContext.emberTriggeredProbabilities ??= {};
      const oldProbability = clampProbability(damageContext.emberTriggeredProbabilities[source.id]);
      const newProbability = independentUnionProbability(oldProbability, chance);
      damageContext.emberTriggeredProbabilities[source.id] = newProbability;
      damageContext.emberBaseEnergyBranches ??= {};
      damageContext.emberBaseEnergyBranches[source.id] ??= [{
        probability:1,
        conditions:{},
        amount:Number(source.energy) || 0
      }];
      if (newProbability > oldProbability + PROBABILITY_EPSILON) {
        const triggerWorlds = oldProbability <= PROBABILITY_EPSILON && lifeDamageBranches
          ? lifeDamageBranches
          : probabilityEventPartition(
            this.currentProbabilityEventKey(state, `ember-resolution:${source.id}`),
            newProbability,
            "occurs"
          );
        const baseEnergy = damageContext.emberBaseEnergyBranches[source.id].map((branch) => ({
          probability: branch.probability,
          conditions: branch.conditions,
          baseEnergyAmount: branch.amount
        }));
        const joined = this.intersectProbabilityWork(
          [baseEnergy, triggerWorlds],
          "StatusSimulation.simulateAfterLifeDamage:ember-join"
        );
        const energyOutcomes = this.projectProbabilityWork(joined, (branch) => ({
          amount: Math.max(0, Math.min(source.maxEnergy ?? Infinity,
            branch.baseEnergyAmount + (branch.occurs
              ? PASSIVE_SKILL_DEFINITIONS.ember.energyGain
              : 0)))
        }), "StatusSimulation.simulateAfterLifeDamage:ember-project");
        source.energy = expectedBranchValue(energyOutcomes);
      }
    }
  }

  /*
  功能
  记录私密查看已发生，但把未观测前的身份结果立即边缘化回当前 Probability。

  调用方
  CardEffectSimulation 的窥探结算与 simulateSpyGapAfterLifeDamage：推进私密信息状态。

  输入
  World、观察者、被观察者、期望揭示数量与触发条件世界。

  输出
  实际发生的期望查看槽数。

  读取状态
  目标 handCount/knownCards 与当前触发质量。

  写入状态
  无；具体观察结果只在实际需要的信息反事实查询中惰性采样。

  调用函数
  cardAvailability、eventProbability。

  边界与不变量
  观察前对所有互斥身份求期望后，边际牌池必须等于观察前当前状态；
  禁止持久保存 operation×definition identity worlds，信息选择价值由惰性反事实查询拥有。
  */
  recordSimulatedPrivatePeek(state, source, target, revealCount, triggerWorlds) {
    if (!target?.alive || !Array.isArray(state?.players)) return 0;
    const triggerProbability = this.eventProbability(triggerWorlds);
    if (triggerProbability <= PROBABILITY_EPSILON) return 0;
    const knownOccupancy = (target.knownCards ?? []).reduce(
      (sum, entry) => sum + this.cardAvailability(entry),
      0
    );
    const revealSlots = Math.min(
      Math.max(0, Number(revealCount) || 0),
      Math.max(0, (Number(target.handCount) || 0) - knownOccupancy)
    );
    return revealSlots * triggerProbability;
  }

  /*
  功能
  根据生命伤害概率结算影客窥隙：推进一次性额度并把新观察身份写入后续可消费状态。

  调用方
  CombatSimulation.applyDamage：在生命伤害与濒死结果落地后触发。

  输入
  World、伤害来源、受伤目标与生命伤害概率。

  输出
  无返回值；满足触发条件时推进窥隙额度与目标私密信息。

  读取状态
  来源 characterId/既有触发概率、目标阵营/生命/手牌与剩余牌先验。

  写入状态
  spyGapTriggeredProbability、spyGapTriggered、lastSpyGapTargetId，以及委托记录的目标已知牌与摘要。

  调用函数
  recordSimulatedPrivatePeek。

  边界与不变量
  只有本回合尚未触发的边际生命伤害世界会揭示新牌；空手、队友、已死亡或已触发时不会产生信息价值。
  */
  simulateSpyGapAfterLifeDamage(state, source, target, lifeDamageProbability) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target?.alive || target.hp <= 0
      || target.battleTeam === source.battleTeam || (target.handCount ?? 0) <= 0
      || !hasPassiveSkill(source, "spyGap")) return;
    const oldTriggeredProbability = clampProbability(source.spyGapTriggeredProbability
      ?? (source.spyGapTriggered ? 1 : 0));
    const triggerProbability = (1 - oldTriggeredProbability) * chance;
    source.spyGapTriggeredProbability = independentUnionProbability(oldTriggeredProbability, chance);
    source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
    if (triggerProbability <= PROBABILITY_EPSILON) return;
    source.lastSpyGapTargetId = target.id;
    const triggerWorlds = probabilityEventPartition(
      this.currentProbabilityEventKey(state, `spy-gap:${source.id}:${target.id}`),
      triggerProbability,
      "occurs"
    );
    this.recordSimulatedPrivatePeek(
      state, source, target, PASSIVE_SKILL_DEFINITIONS.spyGap.maxRevealCount, triggerWorlds
    );
  }


  /*
  功能
  把权威格挡需求数量映射为按顺序排列的多次雷达联合判定分区。

  调用方
  CombatSimulation.applyDamage。

  输入
  World、格挡需求数量、可选统一概率覆盖与可选逐需求概率覆盖。

  输出
  互斥且概率守恒的 `{ radarOutcomes, waivedBlockSlots }` 条件分支。

  读取状态
  remainingCardCounts 或调用方显式覆盖。

  写入状态
  仅为联合判定分配一个条件键。

  调用函数
  buildRadarJudgmentSequenceProbabilities、interpretDefenseJudgment、currentProbabilityEventKey。

  边界与不变量
  outcomes 顺序与真实判定调用顺序一致；每个战术结果只免除一个格挡需求。
  */
  buildRadarOutcomeSequencePartition(
    state,
    requirementCount,
    overrideProbabilities = null,
    overrideProbabilitiesByRequirement = null
  ) {
    const sequence = buildRadarJudgmentSequenceProbabilities(
      queryCurrentCardCounts(state.probabilityState),
      requirementCount,
      overrideProbabilitiesByRequirement,
      overrideProbabilities
    );
    const key = this.currentProbabilityEventKey(state, "radar-outcome-sequence");
    return sequence.map((branch, index) => ({
      probability:branch.probability,
      conditions:{ [key]:`v${index}` },
      radarOutcomes:branch.outcomes,
      waivedBlockSlots:branch.outcomes.map((outcome) => (
        outcome === "tactic" && interpretDefenseJudgment("tactic").immune ? 1 : 0
      ))
    }));
  }

  /*
  功能
  结算闪电命中目标的伤害与延迟状态移除，并保持状态分支一致。

  调用方
  ValueSimulationQuery：推进一枚闪电在指定持有者命中的模拟世界。

  输入
  独立 World 与命中目标 ID。

  输出
  无返回值；闪电伤害和状态移除已结算。

  读取状态
  目标存活、闪电状态分支与伤害资源。

  写入状态
  目标伤害/濒死字段及闪电 statuses/概率分支。

  调用函数
  applyDamage、Probability 状态投影 辅助函数。

  边界与不变量
  只移除当前目标的闪电状态；命中伤害与状态清除顺序保持领域生命周期。
  */
  applyLightningHit(state, targetId) {
    const next = this.clone(state);
    const target = next.players.find((player) => player.id === targetId);
    if (!target?.alive) return next;
    // 真实结算在伤害前已消费命中的闪电；分支 after-state 也必须清除此状态，
    // 否则后续评估会把已经兑现的风险继续留在场上。
    if (Array.isArray(target.statuses)) {
      target.statuses = target.statuses.filter((statusId) => statusId !== "lightning");
    } else if (target.statuses) {
      delete target.statuses.lightning;
    }
    target.lightningStatusProbability = 0;
    this.applyDamage(next, null, target, DOMAIN_CARD_DEFINITIONS.lightning.hitDamage, { canBlock: false });
    return next;
  }

  /*
  功能
  清除指定来源创建的全部追猎标记，避免死亡或失效来源继续触发。

  调用方
  CombatSimulation.resolveFatal 与追猎消费路径：让失效来源不再保留标记。

  输入
  World 与标记来源 ID。

  输出
  无返回值；所有玩家上该来源的追猎标记已清除。

  读取状态
  players 的来源绑定标记分支和摘要。

  写入状态
  huntMarkStateBranchesBySource、huntMarkProbabilities、huntMarkProbability、huntMarkSourceId 与 statuses。

  调用函数
  projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  只清除指定来源，不影响其他来源；确定摘要必须由剩余分支重新投影。
  */
  clearHuntMarksBySource(state, sourceId) {
    for (const player of state.players ?? []) {
      if (player.huntMarkProbabilities) delete player.huntMarkProbabilities[sourceId];
      const probabilities = Object.values(player.huntMarkProbabilities ?? {}).map(clampProbability);
      player.huntMarkProbability = probabilities.length ? Math.max(...probabilities) : 0;
      if (player.huntMarkSourceId === sourceId) player.huntMarkSourceId = null;
      if (Array.isArray(player.statuses) && player.huntMarkProbability <= PROBABILITY_EPSILON) {
        player.statuses = player.statuses.filter((status) => status !== "huntMark");
      }
    }
  }

  /*
  功能
  把闪电或封印卡牌的条件生效世界合并进目标延迟状态分支。

  调用方
  CardEffectSimulation.applyCardEffect：在延迟牌已通过反制门控后写入状态。

  输入
  World、行动者、目标、statusId 与条件生效世界。

  输出
  无返回值；目标延迟状态分支和确定摘要已推进。

  读取状态
  目标已有 status 分支与本次 effectEventWorlds。

  写入状态
  对应 status 状态分支、存在概率与 statuses。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  闪电/封印状态只按同一效果世界加入；概率小于一时不得误写为确定状态。
  */
  applyDelayedStatusCard(state, actor, target, statusId, effectEventWorlds) {
    const holder = statusId === "lightning" ? actor : target;
    if (!holder?.alive || (statusId === "sealed" && holder.battleTeam === actor.battleTeam)) return;
    const oldBranches = statusId === "lightning"
      ? getLightningStatusStateBranches(holder)
      : getSealStatusStateBranches(holder);
    const joined = this.intersectProbabilityWork(
      [oldBranches, effectEventWorlds],
      `StatusSimulation.applyDelayedStatusCard:${statusId}:join`
    );
    const projected = this.projectProbabilityWork(joined, (branch) => ({
      present: Boolean(branch.present || branch.occurs)
    }), `StatusSimulation.applyDelayedStatusCard:${statusId}:project`);
    const probability = totalBranchProbability(projected.filter((branch) => branch.present));
    if (statusId === "lightning") {
      holder.lightningStatusProbability = probability;
    } else {
      holder.sealedStatusProbability = probability;
    }
    holder.statuses ??= [];
    if (probability >= 1 - PROBABILITY_EPSILON) {
      if (!holder.statuses.includes(statusId)) holder.statuses.push(statusId);
    } else {
      holder.statuses = holder.statuses.filter((status) => status !== statusId);
    }
  }
};
