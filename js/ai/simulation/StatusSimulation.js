/*
模块职责
镜像延迟状态、雷达判定和角色被动状态钩子的 SearchState 生命周期。

上游
Simulator facade、CardEffectSimulation 与 CombatSimulation。

下游
Lightning/Seal/Radar domain models、角色/卡牌配置与 Probability。

状态边界
只修改 facade 提供的独立 SearchState clone。

信息边界
只消费过滤状态和显式概率分支，不读取未来判定实体牌。

架构约束
真实状态/监听顺序以 Game、JudgmentSystem 与 skillRegistry 为权威；不拥有 Policy 或 Value 公式。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260814-ai-simulation-engine";
import { GAME_CONFIG } from "../../config/gameConfig.js?build=20260814-ai-simulation-engine";
import { getLightningStatusStateBranches, lightningPresenceProbability } from "../domain/LightningModel.js?build=20260814-ai-simulation-engine";
import { getSealStatusStateBranches, sealPresenceProbability } from "../domain/SealModel.js?build=20260814-ai-simulation-engine";
import {
  RADAR_BASIC_DEFINITIONS,
  buildRadarJudgmentProbabilities
} from "../domain/RadarModel.js?build=20260814-ai-simulation-engine";
import {
  PROBABILITY_EPSILON,
  expectedBranchValue,
  getValueBranches,
  joinProbabilityStateBranches,
  mergeProbabilityStateBranches,
  probabilityEventPartition,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260814-ai-simulation-engine";
import { clampProbability, unionProbability } from "./SimulationSupport.js?build=20260814-ai-simulation-engine";

/*
功能
把 Base class 与 StatusSimulation 的无状态方法组合成单一 Simulator 类型。

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
export const withStatusSimulation = (Base) => class StatusSimulation extends Base {
  /** 连势必须保留防御结果的条件键；只存期望标量会让后续突袭把加伤摊到错误世界。 */
  /*
  功能
  推进状态/被动生命周期步骤 initializeMomentumBranches。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  initializeMomentumBranches(state) {
    for (const player of state?.players ?? []) {
      if (player.generalId !== "blade-walker") continue;
      if (!Array.isArray(player.momentumBranches) || !player.momentumBranches.length) {
        player.momentumBranches = [{
          probability:1,
          conditions:{},
          amount:Math.max(0, Math.min(GAME_CONFIG.momentumMaxStacks, Number(player.momentum) || 0))
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
  推进状态/被动生命周期步骤 syncMomentumSummary。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  syncMomentumSummary(player) {
    player.momentumBranches = projectProbabilityStateBranches(
      getValueBranches(player, "momentum", player.momentum),
      (branch) => ({
        amount:Math.max(0, Math.min(GAME_CONFIG.momentumMaxStacks, Number(branch.amount) || 0))
      })
    );
    player.momentum = expectedBranchValue(player.momentumBranches);
    return player.momentumBranches;
  }

  /*
  功能
  推进状态/被动生命周期步骤 syncCategoryUsedSummary。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
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

  /**
   * 连势与类别首次使用都沿用动作/伤害的完整条件世界。命中生命时先消费旧连势，
   * 随后的 cardUsed 若是该类别首次使用再获得1层；未命中世界保留旧层并正常叠层。
   */
  /*
  功能
  推进状态/被动生命周期步骤 simulateCategoryUse。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateCategoryUse(state, player, category, useResolution = 1, lifeDamageResolution = null) {
    if (!category || player?.generalId !== "blade-walker") return 0;
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
        amount:Math.min(GAME_CONFIG.momentumMaxStacks,
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
  推进状态/被动生命周期步骤 simulateGamble。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateGamble(state, actor, card, useProbability) {
    if (actor?.generalId !== "fate-gambler" || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const gambleWorlds = this.getEventWorlds(state, triggerProbability, null, "gamble-draw");
      this.gainUnknownCardsWithCounterState(
        state, actor, triggerProbability * GAME_CONFIG.gamblerDrawChance, gambleWorlds, "gamble-draw"
      );
    }
    return triggerProbability;
  }

  /*
  功能
  推进状态/被动生命周期步骤 simulateCoordination。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateCoordination(state, actor, effectiveTargets, resolutionProbability) {
    if (actor?.generalId !== "resonance-tuner") return 0;
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

  /** 目标指定阶段的猎印概率使用联合概率；同一猎手每回合最多留下两次猎印。 */
  /*
  功能
  推进状态/被动生命周期步骤 simulateTracking。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateTracking(state, source, target, eventWorlds) {
    if (source.generalId !== "trail-hunter" || target.battleTeam === source.battleTeam) return;
    source.trackingTargetIds ??= [];
    // 同一敌人本回合只能触发一次；猎杀移除标记也不会返还该次追踪额度。
    if (source.trackingTargetIds.includes(target.id)) return;
    source.trackingUses ??= source.trackingTargetIds.length;
    target.huntMarkProbabilities ??= {};
    const oldProbability = clampProbability(target.huntMarkProbabilities[source.id]
      ?? (target.huntMarkSourceId === source.id ? 1 : 0));
    const remainingUses = Math.max(0, 2 - source.trackingUses);
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

  /** 统一处理实际生命伤害后的角色收益。 */
  /*
  功能
  推进状态/被动生命周期步骤 simulateAfterLifeDamage。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateAfterLifeDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null, damageContext = {}) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target) return;
    if (damageContext.cardDamage && source.generalId === "ember-magus"
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
            branch.baseEnergyAmount + (branch.occurs ? 1 : 0)))
        }));
        source.energy = expectedBranchValue(source.energyBranches);
      }
    }
  }

  /** 濒死救援结算后再结算窥隙，避免目标获救后继续存活时被漏算。 */
  /*
  功能
  推进状态/被动生命周期步骤 simulateSpyGapAfterLifeDamage。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateSpyGapAfterLifeDamage(state, source, target, lifeDamageProbability) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target?.alive || target.hp <= 0
      || target.battleTeam === source.battleTeam || (target.handCount ?? 0) <= 0
      || source.generalId !== "shade-agent") return;
    const oldTriggeredProbability = clampProbability(source.spyGapTriggeredProbability
      ?? (source.spyGapTriggered ? 1 : 0));
    const triggerProbability = (1 - oldTriggeredProbability) * chance;
    source.spyGapTriggeredProbability = unionProbability(oldTriggeredProbability, chance);
    source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
    source.expectedInformationGain = (source.expectedInformationGain ?? 0)
      + Math.min(2, target.handCount) * triggerProbability;
  }

  /*
  功能
  推进状态/被动生命周期步骤 simulateAssaultAfterDamage。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
  */
  simulateAssaultAfterDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null) {
    return this.simulateAfterLifeDamage(state, source, target, lifeDamageProbability,
      lifeDamageBranches, { cardDamage:true, emberTriggeredProbabilities:{} });
  }

  /**
   * 构造单一互斥雷达结果分区：noRadar / noJudgment / tactic / equipment /
   * basic:assault / basic:recover / basic:block / basic:charge / basic:shield。
   * 所有结果共享同一个条件键，不同结果值互斥，概率合计为 1。
   * 默认概率来自 remainingCardCounts（只读）；override 兼容
   * { block, otherBasic, equipment }，其中 otherBasic 按剩余密度拆分到四种非格挡基础牌。
   */
  /*
  功能
  推进状态/被动生命周期步骤 buildRadarOutcomePartition。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
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
      推进状态/被动生命周期步骤 pushOutcome。

      调用方
      Simulator、Card/Combat components、Value query 与 status characterization 测试。

      输入
      独立 SearchState、状态 holder/target 与显式条件世界。

      输出
      更新后的状态概率、兼容摘要或后置触发结果。

      读取状态
      只读 SearchState 与 Lightning/Seal/Radar domain outcome。

      写入状态
      只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

      调用函数
      Domain models、Combat/Response/Card helpers 与 state/Probability。

      边界与不变量
      不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
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
        pushOutcome("tactic", tacticProbability, false, true);
        pushOutcome("equipment", equipmentProbability, true, false);
        for (const definitionId of RADAR_BASIC_DEFINITIONS) {
          pushOutcome(`basic:${definitionId}`, basicProbabilities[definitionId], true, false);
        }
      }
    }
    const branchTotal = branches.reduce((sum, branch) => sum + branch.probability, 0);
    return branchTotal > 0
      ? branches.map((branch) => ({ ...branch, probability:branch.probability / branchTotal }))
      : [{ probability:1, conditions:{ [key]:"noRadar" }, radarOutcome:"noRadar", responseAllowed:true, immuneByRadar:false }];
  }

  /**
   * 闪电判中复用统一伤害模拟：不可格挡，因此雷达和格挡不会介入；护援在护盾前、
   * 护盾吸收、调息救援与死亡清理都继续走 applyDamage 的正式 AI 语义。
   */
  /*
  功能
  推进状态/被动生命周期步骤 applyLightningHit。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
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
    this.applyDamage(next, null, target, 3, { canBlock:false });
    return next;
  }

  /*
  功能
  推进状态/被动生命周期步骤 clearHuntMarksBySource。

  调用方
  Simulator、Card/Combat components、Value query 与 status characterization 测试。

  输入
  独立 SearchState、状态 holder/target 与显式条件世界。

  输出
  更新后的状态概率、兼容摘要或后置触发结果。

  读取状态
  只读 SearchState 与 Lightning/Seal/Radar domain outcome。

  写入状态
  只写独立 SearchState 的 status、turn/game flags 和相关资源摘要。

  调用函数
  Domain models、Combat/Response/Card helpers 与 state/Probability。

  边界与不变量
  不复制 Domain 概率；reset、damage hook 与 clear 时机必须保持真实 authority 顺序。
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
  CardEffectSimulation.applyCardEffect。

  输入
  SearchState、施放者、目标、状态 ID 与效果世界。

  输出
  无；更新目标状态概率与确定状态兼容数组。

  读取状态
  LightningModel/SealModel 状态分支与效果条件世界。

  写入状态
  lightning/sealed 状态分支、概率与 statuses 兼容字段。

  调用函数
  getLightningStatusStateBranches、getSealStatusStateBranches、Probability projection。

  边界与不变量
  首次放置不执行普通战术反制或立即判定；确定状态只在概率为一时写入 statuses。
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
