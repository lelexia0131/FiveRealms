/*
模块职责
镜像 SearchState 中的攻击、伤害、失去生命、治疗、濒死救援和死亡结算顺序。

上游
Simulator facade 及 Card/Skill/Status simulation components。

下游
ResponseSimulation、Radar domain、state/Probability 与共享 simulation runtime。

状态边界
只修改 facade 提供的独立 SearchState clone，不持有真实 GameState。

信息边界
只消费可见/概率摘要，不读取隐藏实体牌或未来牌堆。

架构约束
结算顺序以 Game.damage、HpLossSystem 与 DyingSystem 为权威；不得拥有 Policy 或 Value 公式。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260814-ai-simulation-engine";
import { GAME_CONFIG } from "../../config/gameConfig.js?build=20260814-ai-simulation-engine";
import { RADAR_BASIC_DEFINITIONS } from "../domain/RadarModel.js?build=20260814-ai-simulation-engine";
import { PROBABILITY_EPSILON, expectedBranchValue, getAvailabilityBranches, getValueBranches, joinProbabilityStateBranches, mergeProbabilityStateBranches, probabilityEventPartition, projectProbabilityStateBranches, totalBranchProbability } from "../state/Probability.js?build=20260814-ai-simulation-engine";
import { clampProbability, unionProbability } from "./SimulationSupport.js?build=20260814-ai-simulation-engine";

/*
功能
把 Base class 与 CombatSimulation 的无状态方法组合成单一 Simulator 类型。

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
export const withCombatSimulation = (Base) => class CombatSimulation extends Base {
  /** 普通突袭与借势响应共用同一次数槽、伤害与后续收益结算入口。 */
  /*
  功能
  推进战斗生命周期步骤 simulateAssault。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
  推进战斗生命周期步骤 applyDuel。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
  */
  applyDuel(state, actor, target, scale, damageContext = { cardDamage:true, emberTriggeredProbabilities:{} }) {
    const resolutionProbability = clampProbability(scale);
    const actorDistribution = this.syncAssaultSummary(actor);
    const targetDistribution = this.syncAssaultSummary(target);
    const actorRemaining = new Map();
    const targetRemaining = new Map();
    /*
    功能
    推进战斗生命周期步骤 addBranch。

    调用方
    Card/Skill/Status components、Simulator query 与 combat characterization 测试。

    输入
    独立 SearchState、攻击/治疗参与者和显式效果世界。

    输出
    更新后的 combat state 或结算摘要。

    读取状态
    只读 SearchState 的 HP、shield、response、equipment 与状态分支。

    写入状态
    只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

    调用函数
    ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

    边界与不变量
    严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
    推进战斗生命周期步骤 toDistribution。

    调用方
    Card/Skill/Status components、Simulator query 与 combat characterization 测试。

    输入
    独立 SearchState、攻击/治疗参与者和显式效果世界。

    输出
    更新后的 combat state 或结算摘要。

    读取状态
    只读 SearchState 的 HP、shield、response、equipment 与状态分支。

    写入状态
    只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

    调用函数
    ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

    边界与不变量
    严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
  推进战斗生命周期步骤 applyDamage。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
      // 先基于判定前的身份保存格挡容量：既避免旧快照在判定身份加入后才
      // 用“全部已知”捷径重建分布并重复计数，也用于决定判定格挡是否被消费。
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
    推进战斗生命周期步骤 effectiveDamageFor。

    调用方
    Card/Skill/Status components、Simulator query 与 combat characterization 测试。

    输入
    独立 SearchState、攻击/治疗参与者和显式效果世界。

    输出
    更新后的 combat state 或结算摘要。

    读取状态
    只读 SearchState 的 HP、shield、response、equipment 与状态分支。

    写入状态
    只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

    调用函数
    ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

    边界与不变量
    严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
    */
    const effectiveDamageFor = (branch) => Math.max(0, branch.damageAmount - aidReductionPerPass);
    /*
    功能
    推进战斗生命周期步骤 hpDamageFor。

    调用方
    Card/Skill/Status components、Simulator query 与 combat characterization 测试。

    输入
    独立 SearchState、攻击/治疗参与者和显式效果世界。

    输出
    更新后的 combat state 或结算摘要。

    读取状态
    只读 SearchState 的 HP、shield、response、equipment 与状态分支。

    写入状态
    只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

    调用函数
    ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

    边界与不变量
    严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
  推进战斗生命周期步骤 applyHpLoss。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
  */
  applyHpLoss(state, target, amount) {
    if (!target.alive || amount <= 0) return;
    target.hp -= amount;
    this.resolveFatal(state, target);
  }

  /*
  功能
  推进战斗生命周期步骤 resolveFatal。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
  推进战斗生命周期步骤 heal。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
  */
  heal(target, amount) {
    if (target.alive && amount > 0) target.hp = Math.min(target.maxHp, target.hp + amount);
  }

  /** 模拟由角色发起的治疗；灵医首次实际治疗己方时同步计算回春的摸牌收益。 */
  /*
  功能
  推进战斗生命周期步骤 healFrom。

  调用方
  Card/Skill/Status components、Simulator query 与 combat characterization 测试。

  输入
  独立 SearchState、攻击/治疗参与者和显式效果世界。

  输出
  更新后的 combat state 或结算摘要。

  读取状态
  只读 SearchState 的 HP、shield、response、equipment 与状态分支。

  写入状态
  只写独立 SearchState 的战斗、救援、死亡和相关资源字段。

  调用函数
  ResponseSimulation、Status hooks、Card resource helpers 与 state/Probability。

  边界与不变量
  严格保持 Game.damage、HpLossSystem、DyingSystem 的既有顺序；死亡只结算一次。
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
