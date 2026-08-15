/*
模块职责
镜像 SearchState 中的攻击、伤害、失去生命、治疗、濒死救援和死亡结算顺序。

上游
Simulator 正式模拟门面及 Card/Skill/Status 模拟组件。

下游
ResponseSimulation、Radar domain、state/Probability 与共享 simulation runtime。

状态边界
只修改 Simulator 门面提供的独立 SearchState 副本，不持有真实 GameState。

信息边界
只消费可见/概率摘要，不读取隐藏实体牌或未来牌堆。

架构约束
结算顺序以 Game.damage、HpLossSystem 与 DyingSystem 为权威；不得拥有 Policy 或 Value 公式。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260815-ai-residue-cleanup-final";
import { GAME_CONFIG } from "../../config/gameConfig.js?build=20260815-ai-residue-cleanup-final";
import { RADAR_BASIC_DEFINITIONS } from "../domain/RadarModel.js?build=20260815-ai-residue-cleanup-final";
import { PROBABILITY_EPSILON, expectedBranchValue, getAvailabilityBranches, getValueBranches, joinProbabilityStateBranches, mergeProbabilityStateBranches, probabilityEventPartition, projectProbabilityStateBranches, totalBranchProbability } from "../state/Probability.js?build=20260815-ai-residue-cleanup-final";
import { clampProbability, unionProbability } from "./SimulationSupport.js?build=20260815-ai-residue-cleanup-final";

/*
功能
把 Base class 与 CombatSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把 CombatSimulation 方法加入正式模拟门面。

输入
已经包含上一层模拟能力的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增 攻击、伤害、濒死与治疗方法 的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withCombatSimulation = (Base) => class CombatSimulation extends Base {
  /*
  功能
  联合突袭执行、格挡响应与增伤世界，结算命中伤害并返回生命伤害概率。

  调用方
  CardEffectSimulation 与搜索模拟：结算一张突袭或等价攻击效果。

  输入
  独立 SearchState、存活来源/目标、发生概率或事件世界，以及已消费槽位等选项。

  输出
  目标实际受到生命伤害的概率；状态原地推进。

  读取状态
  攻击槽、势能、破势层、装备概率、格挡容量与目标生存状态。

  写入状态
  攻击次数、追猎标记、伤害/响应资源、破势与类别使用摘要。

  调用函数
  consumeAttackUse、simulateTracking、applyDamage、simulateCategoryUse。

  边界与不变量
  次数槽先于伤害消费；破势层和突袭加成只按实际执行质量消费一次。
  */
  simulateAssault(state, source, target, resolution = 1, options = {}) {
    const desiredWorlds = Array.isArray(resolution)
      ? this.getEventWorlds(state, 1, resolution, `assault:${source.id}:${target.id}`)
      : this.getEventWorlds(state, clampProbability(resolution), null, `assault:${source.id}:${target.id}`);
    const tracksAttackSlots = Array.isArray(source.attackUseSlots) || Number.isFinite(Number(source.attackLimit));
    const assaultWorlds = options.attackUseConsumed || !tracksAttackSlots
      ? desiredWorlds
      : this.consumeAttackUse(state, source, desiredWorlds, options.attackUseSlot).eventWorlds;
    const chance = this.eventProbability(assaultWorlds);
    if (!chance || !source?.alive || !target?.alive) return 0;
    if (!tracksAttackSlots && !options.attackUseConsumed) {
      source.attackUsed = (source.attackUsed ?? 0) + chance;
    }
    this.simulateTracking(state, source, target, assaultWorlds);
    const momentumBranches = source.generalId === "blade-walker"
      ? this.syncMomentumSummary(source)
      : [{ probability:1, conditions:{}, amount:0 }];
    const damageOutcome = {};
    const baseDamage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0);
    const damageBranches = momentumBranches.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      amount:baseDamage + branch.amount
    }));
    const damage = expectedBranchValue(damageBranches);
    this.applyDamage(state, source, target, damage, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:assaultWorlds,
      amountBranches:damageBranches,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined,
      damageContext:options.damageContext ?? { cardDamage:true, emberTriggeredProbabilities:{} }
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    this.simulateCategoryUse(
      state, source, "basic", assaultWorlds, damageOutcome.lifeDamageBranches ?? null
    );
    return lifeDamageChance;
  }

  /*
  功能
  按双方可用突袭身份和概率世界轮流结算对决，直至一方无法继续响应。

  调用方
  CardEffectSimulation.applyCardEffect：结算已经通过反制门控的对决。

  输入
  独立 SearchState、对决双方、生效概率与伤害上下文。

  输出
  双方失败概率、期望突袭消耗和剩余数量分布的新摘要对象。

  读取状态
  双方突袭数量分布、手牌数量与合法已知突袭身份。

  写入状态
  双方突袭容量、手牌计数/身份及条件伤害结果。

  调用函数
  syncAssaultSummary、consumeKnownCardsFromHand、applyDamage。

  边界与不变量
  双方同一概率世界必须成对比较；先手多响应一次的既有顺序和分布质量不得改变。
  */
  applyDuel(state, actor, target, scale, damageContext = { cardDamage:true, emberTriggeredProbabilities:{} }) {
    const resolutionProbability = clampProbability(scale);
    const actorDistribution = this.syncAssaultSummary(actor);
    const targetDistribution = this.syncAssaultSummary(target);
    const actorRemaining = new Map();
    const targetRemaining = new Map();
    /*
    功能
    把一个对决状态写入同条件聚合桶，累加其联合概率质量。

    调用方
    applyDuel 的未发生世界与每个对决配对世界：聚合相同剩余数量。

    输入
    局部 Map、非负剩余数量与联合概率。

    输出
    无返回值；局部聚合桶已更新。

    读取状态
    仅局部 Map 现有概率。

    写入状态
    仅写 applyDuel 的局部 Map。

    调用函数
    无。

    边界与不变量
    小于等于概率容差的分支不进入桶；相同数量只累加质量，不改变条件外状态。
    */
    const addBranch = (map, count, probability) => {
      if (probability <= PROBABILITY_EPSILON) return;
      map.set(count, (map.get(count) ?? 0) + probability);
    };
    for (const branch of actorDistribution) addBranch(
      actorRemaining, branch.count, branch.probability * (1 - resolutionProbability)
    );
    for (const branch of targetDistribution) addBranch(
      targetRemaining, branch.count, branch.probability * (1 - resolutionProbability)
    );

    let actorLoseProbability = 0;
    let targetLoseProbability = 0;
    let expectedActorSpent = 0;
    let expectedTargetSpent = 0;
    for (const actorBranch of actorDistribution) {
      for (const targetBranch of targetDistribution) {
        const probability = actorBranch.probability * targetBranch.probability * resolutionProbability;
        if (probability <= PROBABILITY_EPSILON) continue;
        const actorCount = actorBranch.count;
        const targetCount = targetBranch.count;
        const targetLoses = targetCount <= actorCount;
        const actorSpent = Math.min(actorCount, targetCount);
        const targetSpent = Math.min(targetCount, actorCount + 1);
        expectedActorSpent += probability * actorSpent;
        expectedTargetSpent += probability * targetSpent;
        if (targetLoses) targetLoseProbability += probability;
        else actorLoseProbability += probability;
        addBranch(actorRemaining, actorCount - actorSpent, probability);
        addBranch(targetRemaining, targetCount - targetSpent, probability);
      }
    }

    /*
    功能
    将对决聚合桶规范化为供后续伤害结算使用的概率分布。

    调用方
    applyDuel：把双方局部聚合桶交回正式突袭摘要同步入口。

    输入
    按剩余突袭数量聚合的局部 Map。

    输出
    新的 count/probability 分支数组。

    读取状态
    仅局部 Map。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    只改变表示形式，不归一化或重排对决结果的概率含义。
    */
    const toDistribution = (map) => [...map.entries()].map(([count, probability]) => ({ count, probability }));
    const actorRemainingDistribution = this.syncAssaultSummary(actor, toDistribution(actorRemaining));
    const targetRemainingDistribution = this.syncAssaultSummary(target, toDistribution(targetRemaining));
    actor.handCount = Math.max(0, actor.handCount - expectedActorSpent);
    target.handCount = Math.max(0, target.handCount - expectedTargetSpent);
    this.consumeKnownCardsFromHand(state, actor, "assault", expectedActorSpent);
    this.consumeKnownCardsFromHand(state, target, "assault", expectedTargetSpent);
    this.applyDamage(state, target, actor, 1, {
      canBlock:false,
      eventProbability:actorLoseProbability,
      damageContext
    });
    this.applyDamage(state, actor, target, 1, {
      canBlock:false,
      eventProbability:targetLoseProbability,
      damageContext
    });
    return {
      actorLoseProbability,
      targetLoseProbability,
      expectedActorSpent,
      expectedTargetSpent,
      actorRemainingDistribution,
      targetRemainingDistribution
    };
  }

  /*
  功能
  按护盾、生命、救援与伤后钩子的真实顺序结算条件化伤害世界。

  调用方
  CardEffect、SkillEffect、Status、ValueSimulationQuery 与本模块攻击入口：镜像一次条件化伤害。

  输入
  独立 SearchState、可空攻击者、存活目标、正伤害量与格挡/装备/事件选项。

  输出
  期望生命伤害量；可选 outcome 同步得到伤害与格挡概率分支。

  读取状态
  事件世界、攻防装备、格挡容量、护援能力、护盾/生命分支与状态钩子。

  写入状态
  格挡身份和容量、护援资源、护盾、生命、濒死/死亡及伤后状态。

  调用函数
  buildRadarOutcomePartition、consumeBlockResponseWorlds、simulateGuardianAid、resolveFatal 与伤后钩子。

  边界与不变量
  顺序固定为响应/护援→护盾→生命→伤后钩子→濒死；同一格挡或反制资源不得重复消费。
  */
  applyDamage(state, attacker, target, amount, options = {}) {
    if (!target.alive || amount <= 0) {
      if (options.outcome) {
        options.outcome.lifeDamageChance = 0;
        options.outcome.blockedByCardChance = 0;
      }
      return 0;
    }
    const eventWorlds = this.getEventWorlds(state,
      options.eventProbability ?? 1,
      options.eventBranches,
      `damage-event:${attacker?.id ?? "unknown"}:${target.id}`);
    const eventProbability = this.eventProbability(eventWorlds);
    if (eventProbability <= 0) return 0;
    const amountState = (Array.isArray(options.amountBranches) && options.amountBranches.length
      ? mergeProbabilityStateBranches(options.amountBranches)
      : [{ probability:1, conditions:{}, amount }]).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      damageAmount:Math.max(0, Number(branch.amount) || 0)
    }));
    const battleProbability = clampProbability(options.deviceAttack
      && attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    // 雷达按统一“需要打出格挡”语义生效：只要本次伤害可格挡（options.canBlock），
    // 目标装备 defenseDevice 时就进入雷达判定路径，不再依赖 assault/shock 牌名白名单。
    const defenseProbability = options.canBlock
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = 0;
    let expectedBlockSpend = 0;
    let passChance = 1;
    let attackOutcomeWorlds = null;
    if (defenseProbability > 0) {
      // 雷达路径：单一互斥结果分区，判定身份、格挡消费与伤害通过共用同一组条件世界。
      const radarOutcomePartition = this.buildRadarOutcomePartition(
        state, defenseProbability, options.radarJudgmentProbabilities
      );
      const battleKey = this.nextProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:2 }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:1 }]
          : [
              { probability:battleProbability, conditions:{ [battleKey]:"yes" }, requiredCount:2 },
              { probability:1 - battleProbability, conditions:{ [battleKey]:"no" }, requiredCount:1 }
            ];
      const baseWorlds = joinProbabilityStateBranches(
        eventWorlds, radarOutcomePartition, requiredPartition
      ).map((branch) => ({
        ...branch,
        responseAllowed:Boolean(options.canBlock) && branch.responseAllowed !== false
      }));
      // 先保存判定前的格挡容量：若在判定身份加入后重建分布，新身份会同时进入
      // 根容量和本次增量；该快照也用于判断判定得到的格挡是否真的被消费。
      // 无条件的匿名容量分支在这里显式键化，使判定格挡身份、判定前容量和
      // 最终 blockCount 在后续世界中保持同一条件关联。
      const preJudgmentKey = this.nextProbabilityEventKey(state, "pre-judgment-blocks");
      const preJudgmentBlockState = this.getBlockCountBranches(
        target, state?.remainingCardCounts ?? null
      ).map((branch, index) => ({
        probability:branch.probability,
        conditions:{ ...branch.conditions, [preJudgmentKey]:`v${index}` },
        blockCount:branch.blockCount
      }));
      target.blockCountDistribution = preJudgmentBlockState;
      this.syncBlockSummary(target);
      let judgmentBlockCard = null;
      // 基础判定牌先加入身份：判定得到的格挡可以立即用于本次响应。
      for (const definitionId of RADAR_BASIC_DEFINITIONS) {
        const acquisitionWorlds = projectProbabilityStateBranches(baseWorlds, (branch) => ({
          occurs:Boolean(branch.occurs && branch.radarOutcome === `basic:${definitionId}`)
        }));
        if (this.eventProbability(acquisitionWorlds) <= PROBABILITY_EPSILON) continue;
        const simulatedId = this.nextSimulatedCardId(state, definitionId);
        if (Array.isArray(target.hand)) {
          this.addSimulatedCardToHand(state, target, { id:simulatedId, definitionId }, acquisitionWorlds);
          if (definitionId === "block") {
            judgmentBlockCard = target.hand.find((card) => card.id === simulatedId) ?? null;
          }
        } else {
          this.addSimulatedKnownCard(state, target, { cardId:simulatedId, definitionId }, acquisitionWorlds);
          if (definitionId === "block") {
            judgmentBlockCard = target.knownCards.find((entry) => entry.cardId === simulatedId) ?? null;
          }
        }
      }
      const response = this.consumeBlockResponseWorlds(state, target, baseWorlds, {
        preJudgmentBlockState,
        judgmentBlockCard
      });
      attackOutcomeWorlds = response.outcomeWorlds;
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, response.blockedProbability / eventProbability)
        : 0;
    } else if (options.canBlock) {
      // 非雷达路径：格挡数量分布与本次伤害事件世界联合，只有同时发生且数量足够的
      // 世界才消费格挡；消费张数由军火库条件决定（1 或 2）。
      const battleKey = this.nextProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:2 }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:1 }]
          : [
              { probability:battleProbability, conditions:{ [battleKey]:"yes" }, requiredCount:2 },
              { probability:1 - battleProbability, conditions:{ [battleKey]:"no" }, requiredCount:1 }
            ];
      const blockState = this.getBlockCountBranches(target, state?.remainingCardCounts ?? null);
      const blockWorlds = joinProbabilityStateBranches(eventWorlds, requiredPartition, blockState);
      const consumedBranches = blockWorlds.filter(
        (branch) => branch.occurs && branch.blockCount >= branch.requiredCount
      );
      const blockedProbability = totalBranchProbability(consumedBranches);
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, blockedProbability / eventProbability)
        : 0;
      passChance = Math.max(0, Math.min(1, 1 - blockedByCardChance));
      expectedBlockSpend = consumedBranches.reduce(
        (sum, branch) => sum + branch.probability * branch.requiredCount, 0
      );
      const remainingBlockBranches = projectProbabilityStateBranches(blockWorlds, (branch) => ({
        blockCount: branch.occurs && branch.blockCount >= branch.requiredCount
          ? Math.max(0, branch.blockCount - branch.requiredCount)
          : branch.blockCount
      }));
      target.blockCountDistribution = remainingBlockBranches;
      this.syncBlockSummary(target);
      const identityWorlds = blockWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        requiredCount:branch.requiredCount,
        blockUsed:Boolean(branch.occurs && branch.blockCount >= branch.requiredCount)
      }));
      this.consumeBlockIdentities(state, target, identityWorlds);
      target.handCount = Math.max(0, (target.handCount ?? 0) - expectedBlockSpend);
    }
    const damagePassProbability = attackOutcomeWorlds
      ? totalBranchProbability(attackOutcomeWorlds.filter((branch) => branch.occurs && branch.passes))
      : eventProbability * passChance;
    let aidReductionPerPass = 0;
    if (damagePassProbability > PROBABILITY_EPSILON) {
      const passWorlds = attackOutcomeWorlds
        ?? joinProbabilityStateBranches(eventWorlds, probabilityEventPartition(
          this.nextProbabilityEventKey(state, `damage-pass-aid:${attacker?.id ?? "unknown"}:${target.id}`),
          passChance,
          "passes"
        ));
      const incomingExpectedDamage = joinProbabilityStateBranches(passWorlds, amountState)
        .reduce((sum, branch) => (
          sum + (branch.occurs && branch.passes ? branch.probability * branch.damageAmount : 0)
        ), 0);
      const aidedExpectedDamage = this.simulateGuardianAid(
        state, target, incomingExpectedDamage, damagePassProbability, options.excludedGuardianIds, options
      );
      aidReductionPerPass = Math.max(0,
        (incomingExpectedDamage - aidedExpectedDamage) / damagePassProbability);
    }
    const shieldState = getValueBranches(target, "shield", target.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const damageWorlds = attackOutcomeWorlds
      ? joinProbabilityStateBranches(attackOutcomeWorlds, shieldState, amountState)
      : joinProbabilityStateBranches(eventWorlds, probabilityEventPartition(
          this.nextProbabilityEventKey(state, `damage-pass:${attacker?.id ?? "unknown"}:${target.id}`),
          passChance,
          "passes"
        ), shieldState, amountState);
    /*
    功能
    读取指定条件世界中扣除免伤后的实际伤害量。

    调用方
    applyDamage 的护盾与生命投影：在每个条件世界复用同一护援减免。

    输入
    含 damageAmount 的当前伤害分支。

    输出
    扣除本次护援减免后的非负伤害量。

    读取状态
    闭包中的 aidReductionPerPass。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    只在当前 applyDamage 调用内使用；不得再次应用格挡或护盾减免。
    */
    const effectiveDamageFor = (branch) => Math.max(0, branch.damageAmount - aidReductionPerPass);
    /*
    功能
    读取指定条件世界中穿过护盾并落到生命值的伤害量。

    调用方
    applyDamage：计算每个条件世界真正落到生命值的部分。

    输入
    含 occurs、passes、damageAmount 与 shieldAmount 的伤害分支。

    输出
    该分支的非负生命伤害量。

    读取状态
    闭包中的 effectiveDamageFor。

    写入状态
    无。

    调用函数
    effectiveDamageFor。

    边界与不变量
    未发生或未穿过响应的世界必须返回零；护盾只在这里扣一次。
    */
    const hpDamageFor = (branch) => branch.occurs && branch.passes
      ? Math.max(0, effectiveDamageFor(branch) - branch.shieldAmount)
      : 0;
    target.shieldBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
      amount:branch.occurs && branch.passes
        ? Math.max(0, branch.shieldAmount - effectiveDamageFor(branch))
        : branch.shieldAmount
    }));
    target.shield = expectedBranchValue(target.shieldBranches);
    const actualDamage = damageWorlds.reduce((sum, branch) => (
      sum + branch.probability * hpDamageFor(branch)
    ), 0);
    const lifeDamageBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
      occurs:hpDamageFor(branch) > PROBABILITY_EPSILON
    }));
    const lifeDamageChance = this.eventProbability(lifeDamageBranches);
    if (options.outcome) {
      options.outcome.lifeDamageBranches = lifeDamageBranches;
      options.outcome.lifeDamageChance = lifeDamageChance;
      options.outcome.blockedByCardChance = eventProbability * blockedByCardChance;
    }
    target.hp -= actualDamage;
    this.simulateAfterLifeDamage(state, attacker, target, lifeDamageChance,
      lifeDamageBranches, options.damageContext ?? {});
    this.resolveFatal(state, target, attacker);
    this.simulateSpyGapAfterLifeDamage(state, attacker, target, lifeDamageChance);
    return actualDamage;
  }

  /*
  功能
  扣减生命值分支并同步确定生命摘要，不在此重复结算救援。

  调用方
  需要绕过伤害/护盾响应的生命流失镜像入口。

  输入
  独立 SearchState、存活目标与正生命流失量。

  输出
  无返回值；目标生命与濒死结果已推进。

  读取状态
  目标 alive 与 hp。

  写入状态
  目标 hp，以及 resolveFatal 产生的救援/死亡状态。

  调用函数
  resolveFatal。

  边界与不变量
  本函数不触发格挡、护盾或伤后伤害钩子；救援只由 resolveFatal 结算一次。
  */
  applyHpLoss(state, target, amount) {
    if (!target.alive || amount <= 0) return;
    target.hp -= amount;
    this.resolveFatal(state, target);
  }

  /*
  功能
  在濒死世界中按合法救援资源和角色被动结算存活、死亡及资源消耗。

  调用方
  applyDamage 与 applyHpLoss：在目标生命不大于零时结算救援和死亡。

  输入
  独立 SearchState、濒死目标与可空伤害来源。

  输出
  无返回值；目标存活、死亡或被救援后的状态已完成。

  读取状态
  同阵营座次、调息容量、角色被动、击杀来源与奖励配置。

  写入状态
  救援者手牌/调息/回春，目标生命与全部死亡清理字段，攻击者击杀摸牌。

  调用函数
  consumeKnownCardsFromHand、simulateCoordination、setSimulatedEquipment、clearHuntMarksBySource、gainUnknownCardsWithCounterState。

  边界与不变量
  救援按目标优先再顺时针盟友顺序；死亡清理和击杀奖励最多执行一次，不产生半存活状态。
  */
  resolveFatal(state, target, attacker = null) {
    if (target.hp > 0 || !target.alive) return;
    const need = 1 - target.hp;
    const seatCount = Math.max(1, state.players.length);
    const targetSeat = Number(target.seatIndex) || 0;
    const allies = state.players.filter((player) => player.alive && player.battleTeam === target.battleTeam)
      .sort((a,b) => {
        if (a.id === target.id) return -1;
        if (b.id === target.id) return 1;
        const aDistance = ((Number(a.seatIndex) || 0) - targetSeat + seatCount) % seatCount;
        const bDistance = ((Number(b.seatIndex) || 0) - targetSeat + seatCount) % seatCount;
        return aDistance - bDistance;
      });
    const capacity = allies.reduce((sum, player) => sum + (player.expectedRecoverCount ?? 0), 0);
    target.survivalChance = Math.min(1, capacity / need);
    if (capacity < need) {
      target.alive = false;
      target.hp = 0;
      target.exposeWeaknessStacks = 0;
      target.assaultBonus = 0;
      target.huntMarkSourceId = null;
      target.huntMarkProbability = 0;
      target.huntMarkProbabilities = {};
      target.momentum = 0;
      target.momentumBranches = [{ probability:1, conditions:{}, amount:0 }];
      target.statuses = [];
      target.handCount = 0;
      target.hand = [];
      target.expectedAssaultCount = 0;
      target.assaultCountDistribution = [{ count:0, probability:1 }];
      target.expectedRecoverCount = 0;
      target.assaultResponseProbability = 0;
      target.blockProbability = 0;
      target.twoBlockProbability = 0;
      target.counterProbability = 0;
      target.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
      if (Array.isArray(target.knownCards)) {
        target.knownCards = target.knownCards.filter((entry) => entry.definitionId !== "counter");
      }
      this.setSimulatedEquipment(target, null, 0);
      this.clearHuntMarksBySource(state, target.id);
      if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
        this.gainUnknownCardsWithCounterState(
          state, attacker, GAME_CONFIG.killRewardDrawCount, null, "kill-reward-draw"
        );
      }
      return;
    }
    let remaining = need;
    let healingApplied = 0;
    const totalRecover = allies.reduce((sum, rescuer) => sum + Math.max(0, rescuer.expectedRecoverCount ?? 0), 0);
    const maxRounds = Math.max(1, Math.ceil(totalRecover));
    let rounds = 0;
    while (remaining > PROBABILITY_EPSILON && rounds < maxRounds) {
      let usedThisRound = false;
      for (const rescuer of allies) {
        if (remaining <= PROBABILITY_EPSILON) break;
        const available = Math.max(0, rescuer.expectedRecoverCount ?? 0);
        if (available <= PROBABILITY_EPSILON) continue;
        const canRejuvenate = rescuer.generalId === "spirit-medic"
          && (rescuer.rejuvenationTriggerCount ?? 0) < 2;
        const healingPerCard = 1;
        const spent = Math.min(1, available);
        if (spent <= PROBABILITY_EPSILON) continue;
        const healing = spent * healingPerCard;
        usedThisRound = true;
        remaining -= healing;
        healingApplied += healing;
        rescuer.expectedRecoverCount = Math.max(0, available - spent);
        rescuer.handCount = Math.max(0, (rescuer.handCount ?? 0) - spent);
        if (canRejuvenate) {
          // 概率救援按实际消耗的期望调息推进回春：摸牌与次数消耗必须共享同一概率权重，
          // 并以每回合 2 次为上限，避免“摸牌按分数计、次数却完整消耗”的条件世界失配。
          const remainingSlots = Math.max(0, 2 - (rescuer.rejuvenationTriggerCount ?? 0));
          const consume = Math.min(spent, remainingSlots);
          if (consume > PROBABILITY_EPSILON) {
            this.gainUnknownCardsWithCounterState(state, rescuer, consume, null, "rejuvenation-rescue-draw");
            rescuer.rejuvenationTriggerCount = (rescuer.rejuvenationTriggerCount ?? 0) + consume;
          }
        }
        this.consumeKnownCardsFromHand(state, rescuer, "recover", spent);
        this.simulateCoordination(state, rescuer, [target], spent);
      }
      rounds += 1;
      if (!usedThisRound) break;
    }
    target.hp = Math.min(target.maxHp, target.hp + healingApplied);
    target.survivalChance = 1;
    target.alive = true;
  }

  /*
  功能
  将确定治疗量写入目标生命值分支并限制在最大生命值内。

  调用方
  healFrom 与直接治疗镜像：只推进确定生命恢复。

  输入
  目标玩家与正治疗量。

  输出
  无返回值；目标 hp 可能增加。

  读取状态
  目标 alive、hp 与 maxHp。

  写入状态
  仅目标 hp。

  调用函数
  无。

  边界与不变量
  死亡或已满生命目标不变化；生命不得超过 maxHp。
  */
  heal(target, amount) {
    if (target.alive && amount > 0) target.hp = Math.min(target.maxHp, target.hp + amount);
  }

  /*
  功能
  结算带来源的治疗，同时推进与治疗来源和目标相关的角色被动。

  调用方
  CardEffectSimulation 与 SkillEffectSimulation：结算带来源的治疗及回春被动。

  输入
  独立 SearchState、治疗来源、存活目标与正治疗量。

  输出
  无返回值；治疗和可能的回春摸牌已结算。

  读取状态
  治疗前后生命、来源角色/阵营与回春次数。

  写入状态
  目标 hp；满足条件时写来源回春次数、手牌与响应摘要。

  调用函数
  heal、gainUnknownCardsWithCounterState。

  边界与不变量
  回春只按实际治疗量触发且每回合不超过两次；摸牌与次数消费共享同一概率权重。
  */
  healFrom(state, source, target, amount) {
    if (!target?.alive || target.hp >= target.maxHp || amount <= 0) return;
    const beforeHp = target.hp;
    this.heal(target, amount);
    const actualAmount = Math.max(0, target.hp - beforeHp);
    if (source?.generalId === "spirit-medic" && source.battleTeam === target.battleTeam
      && (source.rejuvenationTriggerCount ?? 0) < 2) {
      const triggerWeight = Math.min(1, actualAmount);
      if (triggerWeight <= PROBABILITY_EPSILON) return;
      // 概率执行的治疗只按触发权重推进回春次数，与摸牌共享同一概率权重；
      // 剩余额度按 2 - 期望次数截断，保证期望次数不越过每回合 2 次上限。
      const remainingSlots = Math.max(0, 2 - (source.rejuvenationTriggerCount ?? 0));
      const consume = Math.min(triggerWeight, remainingSlots);
      if (consume <= PROBABILITY_EPSILON) return;
      source.rejuvenationTriggerCount = (source.rejuvenationTriggerCount ?? 0) + consume;
      this.gainUnknownCardsWithCounterState(state, source, consume, null, "rejuvenation-draw");
    }
  }
};
