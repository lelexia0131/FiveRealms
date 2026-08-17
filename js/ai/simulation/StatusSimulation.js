/*
模块职责
镜像延迟状态、雷达判定和角色被动状态钩子的 SearchState 生命周期。

上游
Simulator 正式模拟门面、CardEffectSimulation 与 CombatSimulation。

下游
Lightning/Seal/Radar domain models、角色/卡牌配置与 Probability。

状态边界
只修改 Simulator 门面提供的独立 SearchState 副本。

信息边界
只消费过滤状态和显式概率分支，不读取未来判定实体牌。

架构约束
真实状态与监听顺序以 StatusResolutionWorkflow、JudgmentWorkflow 和 Application triggers 为权威；不拥有 Policy 或 Value 公式。
*/
import { CARD_DEFINITIONS as DOMAIN_CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js?build=20260817-architecture-closure-final";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js?build=20260817-architecture-closure-final";
import { PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js?build=20260817-architecture-closure-final";
import { interpretDefenseJudgment } from "../../domain/rules/judgment/JudgmentRules.js?build=20260817-architecture-closure-final";
import { getLightningStatusStateBranches, lightningPresenceProbability } from "../domain/LightningModel.js?build=20260817-architecture-closure-final";
import { getSealStatusStateBranches, sealPresenceProbability } from "../domain/SealModel.js?build=20260817-architecture-closure-final";
import {
  RADAR_BASIC_DEFINITIONS,
  buildRadarJudgmentProbabilities
} from "../domain/RadarModel.js?build=20260817-architecture-closure-final";
import { hasPassiveSkill } from "../state/RuleProjection.js?build=20260817-architecture-closure-final";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  expectedBranchValue,
  getValueBranches,
  joinProbabilityStateBranches,
  mergeProbabilityStateBranches,
  probabilityEventPartition,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260817-architecture-closure-final";
import {
  clampProbability,
  remainingCardDensity,
  unionProbability
} from "./SimulationSupport.js?build=20260817-architecture-closure-final";

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
  独立 SearchState。

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
      if (!Array.isArray(player.momentumBranches) || !player.momentumBranches.length) {
        player.momentumBranches = [{
          probability:1,
          conditions:{},
          amount:Math.max(0, Math.min(RULESET_DEFINITION.momentumMaxStacks, Number(player.momentum) || 0))
        }];
      }
      this.syncMomentumSummary(player);
      player.categoryUsedStateBranchesByCategory ??= {};
      player.categoryUsedProbabilities ??= {};
      player.categoriesUsed ??= [];
      for (const category of ["basic", "tactic", "equipment"]) {
        if (!Array.isArray(player.categoryUsedStateBranchesByCategory[category])
          || !player.categoryUsedStateBranchesByCategory[category].length) {
          const usedProbability = clampProbability(player.categoryUsedProbabilities[category]
            ?? (player.categoriesUsed.includes(category) ? 1 : 0));
          player.categoryUsedStateBranchesByCategory[category] = usedProbability <= PROBABILITY_EPSILON
            ? [{ probability:1, conditions:{}, used:false }]
            : usedProbability >= 1 - PROBABILITY_EPSILON
              ? [{ probability:1, conditions:{}, used:true }]
              : [
                  { probability:usedProbability, conditions:{}, used:true },
                  { probability:1 - usedProbability, conditions:{}, used:false }
                ];
        }
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
    player.momentumBranches = projectProbabilityStateBranches(
      getValueBranches(player, "momentum", player.momentum),
      (branch) => ({
        amount:Math.max(0, Math.min(RULESET_DEFINITION.momentumMaxStacks, Number(branch.amount) || 0))
      })
    );
    player.momentum = expectedBranchValue(player.momentumBranches);
    return player.momentumBranches;
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
    const branches = mergeProbabilityStateBranches(
      player.categoryUsedStateBranchesByCategory?.[category] ?? []
    );
    player.categoryUsedStateBranchesByCategory[category] = branches;
    const probability = totalBranchProbability(branches.filter((branch) => branch.used));
    player.categoryUsedProbabilities[category] = probability;
    const index = player.categoriesUsed.indexOf(category);
    if (probability >= 1 - PROBABILITY_EPSILON && index < 0) player.categoriesUsed.push(category);
    else if (probability < 1 - PROBABILITY_EPSILON && index >= 0) player.categoriesUsed.splice(index, 1);
    return branches;
  }

  /*
  功能
  联合卡牌使用、类别历史与生命伤害世界，结算刀客势能获得或清空。

  调用方
  CardEffectSimulation 与 CombatSimulation：在牌实际使用后推进刀客势能。

  输入
  SearchState、行动者、卡牌类别、使用世界与可选生命伤害世界。

  输出
  无返回值；类别使用和势能分支已推进。

  读取状态
  刀客身份、当前类别/势能分支与本次使用/伤害条件。

  写入状态
  类别已用分支、类别概率、categoriesUsed、momentumBranches 与 momentum。

  调用函数
  initializeMomentumBranches、getEventWorlds、joinProbabilityStateBranches、syncMomentumSummary、syncCategoryUsedSummary。

  边界与不变量
  同类首次且造成生命伤害才增加势能，重复类别在相交世界清空；条件质量必须守恒。
  */
  simulateCategoryUse(state, player, category, useResolution = 1, lifeDamageResolution = null) {
    if (!category || !hasPassiveSkill(player, "momentum")) return 0;
    this.initializeMomentumBranches({ players:[player] });
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
      probability:branch.probability,
      conditions:branch.conditions,
      momentumAmount:branch.amount
    }));
    const categoryState = this.syncCategoryUsedSummary(player, category).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      categoryUsed:Boolean(branch.used)
    }));
    const joined = joinProbabilityStateBranches(
      momentumState,
      categoryState,
      useWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        cardUsed:Boolean(branch.occurs)
      })),
      lifeDamageWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        lifeDamage:Boolean(branch.occurs)
      }))
    );
    const firstUseProbability = totalBranchProbability(
      joined.filter((branch) => branch.cardUsed && !branch.categoryUsed)
    );
    player.momentumBranches = projectProbabilityStateBranches(joined, (branch) => {
      if (!branch.cardUsed) return { amount:branch.momentumAmount };
      const retained = branch.lifeDamage ? 0 : branch.momentumAmount;
      return {
        amount:Math.min(RULESET_DEFINITION.momentumMaxStacks,
          retained + (!branch.categoryUsed ? 1 : 0))
      };
    });
    player.categoryUsedStateBranchesByCategory[category] = projectProbabilityStateBranches(
      joined,
      (branch) => ({ used:Boolean(branch.categoryUsed || branch.cardUsed) })
    );
    this.syncMomentumSummary(player);
    this.syncCategoryUsedSummary(player, category);
    return firstUseProbability;
  }

  /*
  功能
  按赌徒判定颜色世界结算弃牌收益、能量变化与后续状态。

  调用方
  CardEffectSimulation.applyCardEffect：结算赌徒卡牌在生效世界中的判定收益。

  输入
  SearchState、行动者、已使用卡牌与生效概率。

  输出
  无返回值；弃牌、摸牌、能量和触发概率已推进。

  读取状态
  卡牌颜色、gambleTriggeredProbability 与行动者资源。

  写入状态
  手牌/响应摘要、能量、gambleTriggeredProbability 和触发标记。

  调用函数
  getEventWorlds、gainUnknownCardsWithCounterState、changeEnergy。

  边界与不变量
  颜色分支与卡牌生效世界共享条件；一次行动的奖励和惩罚不能同时重复结算。
  */
  simulateGamble(state, actor, card, useProbability) {
    if (!hasPassiveSkill(actor, "gamble") || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const gambleWorlds = this.getEventWorlds(state, triggerProbability, null, "gamble-draw");
      this.gainUnknownCardsWithCounterState(
        state, actor, triggerProbability * RULESET_DEFINITION.gamblerDrawChance, gambleWorlds, "gamble-draw"
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
  SearchState、来源、有效目标列表与结算概率。

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
    const newProbability = unionProbability(oldProbability, resolutionProbability);
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
  SearchState、攻击来源、目标与突袭事件世界。

  输出
  无返回值；目标的来源绑定标记分支已推进。

  读取状态
  目标已有 huntMark 分支和来源 ID。

  写入状态
  huntMarkStateBranchesBySource、huntMarkProbabilities、huntMarkProbability、huntMarkSourceId 与 statuses。

  调用函数
  joinProbabilityStateBranches、projectProbabilityStateBranches、totalBranchProbability。

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
    const existingBranches = target.huntMarkStateBranchesBySource?.[source.id]
      ?? probabilityEventPartition(
        this.nextProbabilityEventKey(state, `hunt-mark-existing:${source.id}:${target.id}`),
        oldProbability,
        "marked"
      );
    const joined = joinProbabilityStateBranches(existingBranches, limitedEventWorlds);
    const markState = projectProbabilityStateBranches(joined, (branch) => ({
      marked:Boolean(branch.marked || branch.occurs)
    }));
    const markProbability = totalBranchProbability(markState.filter((branch) => branch.marked));
    const gainedProbability = Math.max(0, markProbability - oldProbability);
    target.huntMarkStateBranchesBySource ??= {};
    target.huntMarkStateBranchesBySource[source.id] = markState;
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
  SearchState、可空来源、目标、生命伤害概率/分支与伤害上下文。

  输出
  无返回值；所有与生命伤害相关的被动状态已推进。

  读取状态
  双方角色、伤害来源、上下文去重标记与生命伤害条件。

  写入状态
  角色被动对应的手牌、能量、标记、势能或一次性触发字段。

  调用函数
  simulateSpyGapAfterLifeDamage、simulateAssaultAfterDamage 及资源/概率 辅助函数。

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
      const newProbability = unionProbability(oldProbability, chance);
      damageContext.emberTriggeredProbabilities[source.id] = newProbability;
      damageContext.emberBaseEnergyBranches ??= {};
      damageContext.emberBaseEnergyBranches[source.id] ??= getValueBranches(source, "energy", source.energy);
      if (newProbability > oldProbability + PROBABILITY_EPSILON) {
        const triggerWorlds = oldProbability <= PROBABILITY_EPSILON && lifeDamageBranches
          ? lifeDamageBranches
          : probabilityEventPartition(
            this.nextProbabilityEventKey(state, `ember-resolution:${source.id}`),
            newProbability,
            "occurs"
          );
        const baseEnergy = damageContext.emberBaseEnergyBranches[source.id].map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          baseEnergyAmount:branch.amount
        }));
        const joined = joinProbabilityStateBranches(baseEnergy, triggerWorlds);
        source.energyBranches = projectProbabilityStateBranches(joined, (branch) => ({
          amount:Math.max(0, Math.min(source.maxEnergy ?? Infinity,
            branch.baseEnergyAmount + (branch.occurs
              ? PASSIVE_SKILL_DEFINITIONS.ember.energyGain
              : 0)))
        }));
        source.energy = expectedBranchValue(source.energyBranches);
      }
    }
  }

  /*
  功能
  把窥隙实际看到的未知手牌身份按合法先验写入目标的 knownCards 概率条目。

  调用方
  simulateSpyGapAfterLifeDamage：在窥隙新触发世界中推进私密信息状态。

  输入
  SearchState、观察者、被观察者、期望揭示数量与触发条件世界。

  输出
  无返回值；目标的已知牌、剩余牌计数与卡牌摘要已按揭示世界推进。

  读取状态
  目标 handCount/knownCards、当前 remainingCardCounts 与合法卡牌定义。

  写入状态
  目标 knownCards 概率身份、remainingCardCounts 和 recover/assault 摘要；不改手牌数量或格挡/反制总量。

  调用函数
  cardAvailability、gateEventWorlds、nextSimulatedCardId、remainingCardDensity、availableBranchesFromState、syncCardEstimates。

  边界与不变量
  窥隙只观察已在目标手牌中的槽位，不得改变 handCount 或凭空重抽格挡/反制容量；
  每张观察身份拥有独立概率世界，重复窥探已确定身份不会产生新的揭示质量。
  */
  recordSimulatedSpyGapPeek(state, source, target, revealCount, triggerWorlds) {
    if (!target?.alive || !Array.isArray(state?.players)) return;
    target.knownCards ??= [];
    const triggerProbability = this.eventProbability(triggerWorlds);
    if (triggerProbability <= PROBABILITY_EPSILON) return;
    const knownOccupancy = target.knownCards.reduce(
      (sum, entry) => sum + this.cardAvailability(entry),
      0
    );
    let revealMass = Math.min(
      Math.max(0, Number(revealCount) || 0),
      Math.max(0, (Number(target.handCount) || 0) - knownOccupancy)
    );
    const maxPositions = Math.ceil(Math.max(0, revealMass));
    for (let position = 0; position < maxPositions && revealMass > PROBABILITY_EPSILON; position += 1) {
      const positionProbability = Math.min(1, revealMass);
      const revealWorlds = this.gateEventWorlds(
        state,
        triggerWorlds,
        positionProbability,
        `spy-gap-reveal:${source.id}:${target.id}:${position}`
      );
      const revealProbability = this.eventProbability(revealWorlds);
      if (revealProbability <= PROBABILITY_EPSILON) break;
      // 同一观察槽位的各牌身份必须共享一个条件键，保证候选互斥；
      // 否则 Probability 会把 26 个身份误当成独立牌反复叉乘。
      const identityKey = `spy-gap-identity:${source.id}:${target.id}:${position}`;
      const identityPartition = mergeProbabilityStateBranches(revealWorlds.flatMap((branch) => {
        if (!branch.occurs) {
          return [{
            probability:branch.probability,
            conditions:{ ...branch.conditions, [identityKey]:"none" },
            observedDefinitionId:null
          }];
        }
        return Object.keys(DOMAIN_CARD_DEFINITIONS).map((definitionId) => ({
          probability:branch.probability
            * remainingCardDensity(state?.remainingCardCounts ?? null, definitionId),
          conditions:{ ...branch.conditions, [identityKey]:definitionId },
          observedDefinitionId:definitionId
        }));
      }).filter((branch) => branch.probability > PROBABILITY_EPSILON));
      const slotKey = `${identityKey}:slot`;
      target.identitySlotStates ??= {};
      target.identitySlotStates[identityKey] = mergeProbabilityStateBranches(
        identityPartition.map((branch) => {
          const conditions = { ...branch.conditions, [slotKey]:branch.observedDefinitionId ? "yes" : "no" };
          delete conditions[identityKey];
          return {
            probability:branch.probability,
            conditions,
            slotAvailable:branch.observedDefinitionId !== null,
            definitionId:branch.observedDefinitionId
          };
        })
      );
      for (const definitionId of Object.keys(DOMAIN_CARD_DEFINITIONS)) {
        const identityWorlds = mergeProbabilityStateBranches(
          identityPartition
            .filter((branch) => branch.observedDefinitionId === definitionId)
            .map((branch) => ({
              probability:branch.probability,
              conditions:branch.conditions,
              occurs:true
            }))
        );
        const identityProbability = this.eventProbability(identityWorlds);
        if (identityProbability <= PROBABILITY_EPSILON) continue;
        const slotKey = `${identityKey}:slot`;
        const entry = {
          cardId:this.nextSimulatedCardId(state, definitionId),
          definitionId,
          availabilityBranches:availableBranchesFromState(
            projectProbabilityStateBranches(identityWorlds, (branch) => ({
              available:Boolean(branch.occurs)
            }))
          ).map((branch) => ({
            ...branch,
            conditions:{
              ...branch.conditions,
              [slotKey]:definitionId === "block" || definitionId === "counter" ? "no" : "yes"
            }
          }))
        };
        entry.identityGroupKey = identityKey;
        target.knownCards.push(entry);
        if (state.remainingCardCounts && Number.isFinite(state.remainingCardCounts[definitionId])) {
          state.remainingCardCounts[definitionId] = Math.max(
            0,
            (state.remainingCardCounts[definitionId] ?? 0) - identityProbability
          );
        }
      }
      revealMass -= positionProbability;
    }
    this.syncCardEstimates(target, state?.remainingCardCounts ?? null);
  }

  /*
  功能
  根据生命伤害概率结算影客窥隙：推进一次性额度并把新观察身份写入后续可消费状态。

  调用方
  CombatSimulation.applyDamage：在生命伤害与濒死结果落地后触发。

  输入
  SearchState、伤害来源、受伤目标与生命伤害概率。

  输出
  无返回值；满足触发条件时推进窥隙额度与目标私密信息。

  读取状态
  来源 characterId/既有触发概率、目标阵营/生命/手牌与剩余牌先验。

  写入状态
  spyGapTriggeredProbability、spyGapTriggered、lastSpyGapTargetId，以及委托记录的目标已知牌与摘要。

  调用函数
  recordSimulatedSpyGapPeek。

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
    source.spyGapTriggeredProbability = unionProbability(oldTriggeredProbability, chance);
    source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
    if (triggerProbability <= PROBABILITY_EPSILON) return;
    source.lastSpyGapTargetId = target.id;
    const triggerWorlds = probabilityEventPartition(
      this.nextProbabilityEventKey(state, `spy-gap:${source.id}:${target.id}`),
      triggerProbability,
      "occurs"
    );
    this.recordSimulatedSpyGapPeek(
      state, source, target, PASSIVE_SKILL_DEFINITIONS.spyGap.maxRevealCount, triggerWorlds
    );
  }

  /*
  功能
  在突袭造成生命伤害后推进与伤害来源绑定的后置被动。

  调用方
  simulateAfterLifeDamage：只处理突袭来源绑定的伤后被动。

  输入
  SearchState、来源、目标、生命伤害概率与可选条件分支。

  输出
  无返回值；突袭伤后相关状态已推进。

  读取状态
  来源/目标角色、追猎标记与生命伤害世界。

  写入状态
  突袭后摸牌、标记清理或角色被动字段。

  调用函数
  gainUnknownCardsWithCounterState、clearHuntMarksBySource。

  边界与不变量
  非突袭或无生命伤害世界不得触发；同一来源标记只能消费一次。
  */
  simulateAssaultAfterDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null) {
    return this.simulateAfterLifeDamage(state, source, target, lifeDamageProbability,
      lifeDamageBranches, { cardDamage:true, emberTriggeredProbabilities:{} });
  }

  /*
  功能
  组合防御结果与雷达判定类别，生成互斥且概率守恒的结果分区。

  调用方
  CombatSimulation.applyDamage：在防御装置存在世界中建立雷达判定结果。

  输入
  SearchState、防御装置存在概率与可选显式判定概率。

  输出
  新的互斥雷达结果概率分支数组。

  读取状态
  remainingCardCounts 或调用方 override，不读取未来判定实体。

  写入状态
  仅为中间概率事件分配条件键。

  调用函数
  buildRadarJudgmentProbabilities、nextProbabilityEventKey、mergeProbabilityStateBranches。

  边界与不变量
  防御装置不存在、各基础牌、战术和装备结果互斥且总质量为一。
  */
  buildRadarOutcomePartition(state, defenseProbability, overrideProbabilities = null) {
    const defense = clampProbability(defenseProbability);
    const {
      tactic: tacticProbability,
      equipment: equipmentProbability,
      basic: basicProbabilities,
      hasJudgmentPool
    } = buildRadarJudgmentProbabilities(state?.remainingCardCounts ?? null, overrideProbabilities);

    const key = this.nextProbabilityEventKey(state, "radar-outcome");
    const branches = [];
    const noRadarProbability = 1 - defense;
    if (noRadarProbability > PROBABILITY_EPSILON) {
      branches.push({
        probability:noRadarProbability,
        conditions:{ [key]:"noRadar" },
        radarOutcome:"noRadar",
        responseAllowed:true,
        immuneByRadar:false
      });
    }
    if (defense > PROBABILITY_EPSILON) {
      /*
      功能
      向雷达结果分区追加一个带联合条件的非零概率结果。

      调用方
      buildRadarOutcomePartition：向局部结果数组追加一种非零雷达结局。

      输入
      结果标签、概率、是否允许格挡与是否由雷达免疫。

      输出
      无返回值；闭包中的 outcomes 可能追加一个分支。

      读取状态
      闭包事件键。

      写入状态
      仅写 buildRadarOutcomePartition 的局部 outcomes 数组。

      调用函数
      无。

      边界与不变量
      零概率结果不创建分支；每个结果必须使用同一事件键保持互斥。
      */
      const pushOutcome = (outcome, probability, responseAllowed, immuneByRadar) => {
        const chance = probability * defense;
        if (chance > PROBABILITY_EPSILON) {
          branches.push({
            probability:chance,
            conditions:{ [key]:outcome },
            radarOutcome:outcome,
            responseAllowed,
            immuneByRadar
          });
        }
      };
      if (!hasJudgmentPool) {
        pushOutcome("noJudgment", 1, true, false);
      } else {
        const tacticOutcome = interpretDefenseJudgment("tactic");
        const nonTacticOutcome = interpretDefenseJudgment("basic");
        pushOutcome(
          "tactic",
          tacticProbability,
          !tacticOutcome.immune,
          tacticOutcome.immune
        );
        pushOutcome(
          "equipment",
          equipmentProbability,
          !nonTacticOutcome.immune,
          nonTacticOutcome.immune
        );
        for (const definitionId of RADAR_BASIC_DEFINITIONS) {
          pushOutcome(
            `basic:${definitionId}`,
            basicProbabilities[definitionId],
            !nonTacticOutcome.immune,
            nonTacticOutcome.immune
          );
        }
      }
    }
    const branchTotal = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return branchTotal > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / branchTotal }))
      : [{ probability:1, conditions:{ [key]:"noRadar" }, radarOutcome:"noRadar", responseAllowed:true, immuneByRadar:false }];
  }

  /*
  功能
  结算闪电命中目标的伤害与延迟状态移除，并保持状态分支一致。

  调用方
  ValueSimulationQuery：推进一枚闪电在指定持有者命中的模拟世界。

  输入
  独立 SearchState 与命中目标 ID。

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
    target.lightningStatusStateBranches = [{ probability:1, conditions:{}, present:false }];
    target.lightningStatusProbability = 0;
    this.applyDamage(next, null, target, DOMAIN_CARD_DEFINITIONS.lightning.hitDamage, { canBlock:false });
    return next;
  }

  /*
  功能
  清除指定来源创建的全部追猎标记，避免死亡或失效来源继续触发。

  调用方
  CombatSimulation.resolveFatal 与追猎消费路径：让失效来源不再保留标记。

  输入
  SearchState 与标记来源 ID。

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
      if (player.huntMarkStateBranchesBySource) delete player.huntMarkStateBranchesBySource[sourceId];
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
  SearchState、行动者、目标、statusId 与条件生效世界。

  输出
  无返回值；目标延迟状态分支和确定摘要已推进。

  读取状态
  目标已有 status 分支与本次 effectEventWorlds。

  写入状态
  对应 status 状态分支、存在概率与 statuses。

  调用函数
  joinProbabilityStateBranches、projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  闪电/封印状态只按同一效果世界加入；概率小于一时不得误写为确定状态。
  */
  applyDelayedStatusCard(state, actor, target, statusId, effectEventWorlds) {
    const holder = statusId === "lightning" ? actor : target;
    if (!holder?.alive || (statusId === "sealed" && holder.battleTeam === actor.battleTeam)) return;
    const oldBranches = statusId === "lightning"
      ? getLightningStatusStateBranches(holder)
      : getSealStatusStateBranches(holder);
    const joined = joinProbabilityStateBranches(oldBranches, effectEventWorlds);
    const projected = projectProbabilityStateBranches(joined, (branch) => ({
      present:Boolean(branch.present || branch.occurs)
    }));
    const probability = totalBranchProbability(projected.filter((branch) => branch.present));
    if (statusId === "lightning") {
      holder.lightningStatusStateBranches = projected;
      holder.lightningStatusProbability = probability;
    } else {
      holder.sealedStatusStateBranches = projected;
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
