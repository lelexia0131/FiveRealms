/*
模块职责
镜像卡牌效果、装备与手牌资源身份在 SearchState 中的变化。

上游
Simulator facade、CombatSimulation 与 SkillEffectSimulation。

下游
Response/Combat/Status components、RuleEngine、正式资源 Policy、CardValue 与 Probability。

状态边界
只修改 facade 提供的独立 SearchState clone。

信息边界
未知手牌只按位置、数量与概率身份处理，不读取真实 definitionId。

架构约束
不生成动作、不搜索、不拥有规则合法性或最终价值公式。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260814-ai-simulation-engine";
import { RuleEngine } from "../../core/RuleEngine.js?build=20260814-ai-simulation-engine";
import { DistanceSystem } from "../../core/DistanceSystem.js?build=20260814-ai-simulation-engine";
import { mutualBenefitDraftValues } from "../AiGlobalBenefit.js?build=20260814-ai-simulation-engine";
import { chooseBestResourceHandCandidate, chooseResourceZone } from "../resourceSelectionValue.js?build=20260814-ai-simulation-engine";
import { getBaseCardAiValue, getRoleCardAiValue } from "../value/CardValue.js?build=20260814-ai-simulation-engine";
import { getDiscardKeepValue } from "../discardScoring.js?build=20260814-ai-simulation-engine";
import { PROBABILITY_EPSILON, availableBranchesFromState, expectedBranchValue, getAvailabilityBranches, getAvailabilityStateBranches, getValueBranches, joinProbabilityStateBranches, mergeProbabilityStateBranches, probabilityEventPartition, projectProbabilityStateBranches, totalBranchProbability } from "../state/Probability.js?build=20260814-ai-simulation-engine";
import { clampProbability, fixedCardDensity, remainingCardDensity } from "./SimulationSupport.js?build=20260814-ai-simulation-engine";

/*
功能
把 Base class 与 CardEffectSimulation 的无状态方法组合成单一 Simulator 类型。

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
export const withCardEffectSimulation = (Base) => class CardEffectSimulation extends Base {
  /*
  功能
  推进卡牌/资源效果步骤 initializeEquipmentBaselines。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  initializeEquipmentBaselines(state) {
    for (const player of state?.players ?? []) {
      if (!Object.hasOwn(player, "initialEquipmentValue")) {
        player.initialEquipmentValue = player.equipmentDefinitionId
          ? (CARD_DEFINITIONS[player.equipmentDefinitionId]?.aiValue ?? 7)
          : 0;
      }
      if (!Object.hasOwn(player, "initialEquipmentRoleDelta")) {
        player.initialEquipmentRoleDelta = player.equipmentDefinitionId
          ? this.equipmentRoleDelta(player, player.equipmentDefinitionId)
          : 0;
      }
    }
  }

  /** 角色对装备卡牌相对全局基础值的差量；缺少 generalId 或 definitionId 时回退 0。 */
  /*
  功能
  推进卡牌/资源效果步骤 equipmentRoleDelta。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  equipmentRoleDelta(player, definitionId) {
    if (!player?.generalId || !definitionId) return 0;
    return getRoleCardAiValue(player.generalId, definitionId) - getBaseCardAiValue(definitionId);
  }

  /*
  功能
  推进卡牌/资源效果步骤 initializeAssaultSummaries。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  initializeAssaultSummaries(state) {
    for (const player of state?.players ?? []) this.syncAssaultSummary(player);
  }

  /*
  功能
  执行一张已完成动作支付与 card-scope 响应门控的卡牌效果。

  调用方
  Simulator.apply 唯一动作分派入口。

  输入
  独立 SearchState、行动者、抽象动作以及 facade 计算出的共享事件世界。

  输出
  同一独立 SearchState。

  读取状态
  卡牌定义、目标、效果世界与组件共享资源摘要。

  写入状态
  仅输入 SearchState 的卡牌效果、资源和触发摘要。

  调用函数
  CombatSimulation、ResponseSimulation、Skill/Status hooks 与资源 helper。

  边界与不变量
  不重新计算动作支付或 card-scope 响应；switch 顺序与既有后置触发顺序保持不变。
  */
  applyCardEffect(next, actor, abstractAction, context) {
    const {
      card,
      target,
      cardEventWorlds,
      effectEventWorlds,
      executionProbability,
      scale
    } = context;
    const cardDamageContext = { cardDamage:true, emberTriggeredProbabilities:{} };
    let coordinationProbability = 0;
    let coordinationTargets = [];

    switch (card.definitionId) {
      case "recover":
        this.healFrom(next, actor, actor, 1 * scale);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - executionProbability);
        break;
      case "charge": this.changeEnergy(next, actor, 1, effectEventWorlds); break;
      case "shield":
        if (target?.alive && target.battleTeam === actor.battleTeam) {
          this.changeShield(next, target, 1, effectEventWorlds);
          coordinationProbability = scale;
          coordinationTargets = [target];
        }
        break;
      case "harvest":
        this.gainUnknownCardsWithCounterState(next, actor, 2, effectEventWorlds, "harvest-draw");
        break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "lightning":
        this.applyDelayedStatusCard(next, actor, null, "lightning", effectEventWorlds);
        break;
      case "seal":
        this.applyDelayedStatusCard(next, actor, target, "sealed", effectEventWorlds);
        break;
      case "scout": {
        if (!target?.alive) break;
        const knownExpectedCount = (target.knownCards ?? [])
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        const unknownCount = Math.max(0, (Number(target.handCount) || 0) - knownExpectedCount);
        const informationGain = Math.min(2, unknownCount);
        actor.expectedInformationGain = (actor.expectedInformationGain ?? 0) + informationGain * scale;
        coordinationProbability = scale;
        coordinationTargets = [target];
        break;
      }
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          attackUseSlot:abstractAction.attackUseSlot,
          damageContext:cardDamageContext
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDesire(next, player, actor, card, [player])
          );
          this.applyDamage(next, actor, player, 1, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:counterResponse.effectPassWorlds,
            damageContext:cardDamageContext
          });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDesire(next, player, actor, card, [player])
          );
          const targetWorlds = counterResponse.effectPassWorlds;
          const response = player.assaultResponseProbability ?? 0;
          const eventProbability = this.eventProbability(targetWorlds);
          const spent = this.consumeAssaultForOpportunity(player, eventProbability);
          player.handCount = Math.max(0, player.handCount - spent);
          this.consumeKnownCardsFromHand(next, player, "assault", spent);
          this.applyDamage(next, actor, player, 1, {
            canBlock:false,
            deviceAttack:false,
            eventBranches:this.gateEventWorlds(next, targetWorlds,
              1 - response, `provoke-response:${card.id}:${player.id}`),
            damageContext:cardDamageContext
          });
        }
        break;
      case "leverage": {
        const first = next.players.find((player) => player.id === abstractAction.selection?.firstTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[0]?.id);
        const second = next.players.find((player) => player.id === abstractAction.selection?.secondTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targets?.[1]?.id);
        if (!first?.alive || !second?.alive || !first.equipmentDefinitionId) break;
        // 借势第二目标选择只按距离，但实际打出突袭必须满足普通突袭完整目标合法性。
        const simulationGame = { state:{ players:next.players } };
        const canActuallyTargetWithAssault = RuleEngine.getLegalAssaultTargets(simulationGame, first)
          .some((candidate) => candidate.id === second.id);
        // 候选组合从不因手牌估计或次数删除；实际使用必须消费第一目标自己的次数槽。
        const assaultAvailable = canActuallyTargetWithAssault
          ? Math.max(0, Math.min(1, first.assaultResponseProbability ?? 0))
          : 0;
        const equipmentValue = CARD_DEFINITIONS[first.equipmentDefinitionId]?.aiValue ?? 7;
        const friendlyFirePenalty = second.battleTeam === first.battleTeam ? .55 : 0;
        const defenseRisk = Math.min(.9, second.equipmentDefinitionId === "defenseDevice"
          ? (second.blockProbability ?? remainingCardDensity(next.remainingCardCounts, "block"))
          : (second.blockProbability ?? 0));
        const targetValue = second.battleTeam === first.battleTeam
          ? -0.35 - (second.hp <= 2 ? .15 : 0)
          : .3 + (second.hp <= 2 ? .15 : 0);
        const conserveAssaultPenalty = (first.expectedAssaultCount ?? 0) <= .75 ? .18 : 0;
        const willingness = Math.max(.08, Math.min(.97,
          .42 + equipmentValue * .04 + targetValue - friendlyFirePenalty - defenseRisk * .2
          - conserveAssaultPenalty));
        const existenceProbability = this.getSimulatedEquipmentProbability(first);
        const desiredUseWorlds = this.gateEventWorlds(next, effectEventWorlds,
          assaultAvailable * willingness, `leverage-assault:${card.id}:${first.id}`);
        this.ensureAttackUseSlots(first);
        const actualUseWorlds = desiredUseWorlds;
        const effectiveUseProbability = this.eventProbability(actualUseWorlds);
        first.attackUsed = (first.attackUsed ?? 0) + effectiveUseProbability;
        if (effectiveUseProbability > PROBABILITY_EPSILON) first.attackUseSlots = undefined;
        const effectiveDeclineProbability = Math.min(existenceProbability, Math.max(0, scale - effectiveUseProbability));
        const assaultOpportunity = assaultAvailable > PROBABILITY_EPSILON
          ? Math.min(1, effectiveUseProbability / assaultAvailable)
          : 0;
        const assaultSpent = this.consumeAssaultForOpportunity(first, assaultOpportunity);
        first.handCount = Math.max(0, first.handCount - assaultSpent);
        this.consumeKnownCardsFromHand(next, first, "assault", assaultSpent);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, actualUseWorlds, {
          sourceEquipmentConditional:true,
          attackUseConsumed:true,
          damageContext:cardDamageContext
        });
        actor.handCount += effectiveDeclineProbability;
        actor.expectedEquipmentGain = (actor.expectedEquipmentGain ?? 0) + equipmentValue * effectiveDeclineProbability;
        actor.expectedEquipmentRoleDelta = (actor.expectedEquipmentRoleDelta ?? 0)
          + this.equipmentRoleDelta(actor, first.equipmentDefinitionId) * effectiveDeclineProbability;
        this.setSimulatedEquipment(first, first.equipmentDefinitionId, existenceProbability - effectiveDeclineProbability);
        coordinationProbability = scale;
        coordinationTargets = [first, second];
        break;
      }
      case "plunder": {
        const plundered = target
          ? this.takeResourceToHand(
              next, actor, target, effectEventWorlds, `plunder:${card.id ?? card.definitionId}`
            )
          : 0;
        if (plundered > PROBABILITY_EPSILON) {
          coordinationProbability = plundered;
          coordinationTargets = [target];
        }
        break;
      }
      case "transfer": {
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? null;
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? null;
        if (source && receiver && (source.handCount ?? 0) > 0 && abstractAction.selection?.zone !== "equipment") {
          const selection = abstractAction.selection ?? {};
          const transferCardId = card?.id ?? null;
          const excludedTransferCard = transferCardId ? new Set([transferCardId]) : null;
          const transferred = selection.selectionKind === "known"
            ? this.transferKnownCardIdentity(next, source, receiver, {
                cardId:selection.cardId ?? null,
                definitionId:selection.definitionId ?? null
              }, effectEventWorlds, receiver.id === actor.id, excludedTransferCard)
            : this.transferUnknownCardIdentity(next, source, receiver,
                effectEventWorlds,
                selection.availableUnknownCount != null && Number.isFinite(Number(selection.availableUnknownCount))
                  ? Math.max(0, Number(selection.availableUnknownCount))
                  : this.availableUnknownCountFor(source, excludedTransferCard));
          coordinationProbability = transferred;
          coordinationTargets = [source, receiver];
        }
        break;
      }
      case "counter":
        coordinationProbability = scale;
        coordinationTargets = abstractAction.targets ?? [];
        break;
      case "destroy": {
        const destroyed = target
          ? this.destroyResource(
              next, actor, target, effectEventWorlds, `destroy:${card.id ?? card.definitionId}`
            )
          : 0;
        if (destroyed > PROBABILITY_EPSILON) {
          coordinationProbability = destroyed;
          coordinationTargets = [target];
        }
        break;
      }
      case "duel": if (target) this.applyDuel(next, actor, target, scale, cardDamageContext); break;
      case "mutualBenefit": {
        coordinationTargets = next.players.filter((player) => player.alive);
        coordinationProbability = scale;
        // 互利按真实公开选牌顺序估值：从施放者开始逐个存活角色从预期剩余牌池选走自己
        // 角色价值最高的牌并消耗一张；后手只能从剩余集合选，顺序优势来自可选集合逐步
        // 缩小。规划阶段牌未翻开，禁止读取真实未来牌堆或 RNG，只能用公共剩余牌计数做
        // 确定性期望。
        const draftValues = mutualBenefitDraftValues(next.players, actor, next?.remainingCardCounts ?? null);
        for (const player of coordinationTargets) {
          this.gainUnknownCardsWithCounterState(next, player, 1, effectEventWorlds, "mutual-benefit-draw");
          // 把本次选牌期望价值记入角色状态：owner ledger 据此区分"己方先选/敌方先选"
          // 两种座位排列，后手因可选集合缩小而自然更低，不引入座位奖励常数。
          player.mutualBenefitDraftValue = (player.mutualBenefitDraftValue ?? 0)
            + (draftValues[player.id] ?? 0) * scale;
        }
        break;
      }
      case "symbiosis": {
        const targets = this.seatOrderFrom(next, actor, true);
        coordinationTargets = targets.filter((player) => player.hp < player.maxHp);
        coordinationProbability = scale;
        for (const player of targets) this.healFrom(next, actor, player, scale);
        break;
      }
      default:
        if (card.category === "equipment") this.setSimulatedEquipment(actor, card.definitionId, executionProbability);
        break;
    }
    this.simulateGamble(next, actor, card, executionProbability);
    this.simulateCoordination(next, actor, coordinationTargets, coordinationProbability);
    const recycleProbability = executionProbability * this.getSimulatedEquipmentProbability(actor, "recycleDevice");
    if (card.category === "tactic" && recycleProbability > 0) {
      const remainingUses = Math.max(0, 2 - (actor.recycleDeviceUses ?? 0));
      const triggerProbability = Math.min(recycleProbability, remainingUses);
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + triggerProbability;
      if (triggerProbability > PROBABILITY_EPSILON) {
        const recycleWorlds = this.getEventWorlds(
          next, triggerProbability, null, `recycle-draw:${card.id ?? card.definitionId}`
        );
        this.gainUnknownCardsWithCounterState(next, actor, triggerProbability, recycleWorlds, "recycle-draw");
      }
    }
    if (actor.generalId === "blade-walker" && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(next, actor, category, cardEventWorlds);
    }
    this.syncActiveSkillCosts(next);

    return next;
  }

  /** AI 模拟中装备定义与存在概率的唯一写入口；换装固定重置为完整的新装备。 */
  /*
  功能
  推进卡牌/资源效果步骤 setSimulatedEquipment。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  setSimulatedEquipment(player, definitionId, probability = 1) {
    const normalized = Math.max(0, Math.min(1, Number(probability) || 0));
    if (!definitionId || normalized === 0) {
      player.equipmentDefinitionId = null;
      player.equipmentRetentionProbability = 0;
      return;
    }
    player.equipmentDefinitionId = definitionId;
    player.equipmentRetentionProbability = normalized;
  }

  /*
  功能
  推进卡牌/资源效果步骤 getSimulatedEquipmentProbability。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  getSimulatedEquipmentProbability(player, definitionId = null) {
    if (!player?.equipmentDefinitionId || (definitionId && player.equipmentDefinitionId !== definitionId)) return 0;
    return Math.max(0, Math.min(1, Number(player.equipmentRetentionProbability ?? 1) || 0));
  }

  /** 读取抽象牌或已知牌条目的剩余可用概率；字段缺失时按完整可用 1。 */
  /*
  功能
  推进卡牌/资源效果步骤 cardAvailability。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  cardAvailability(card) {
    const stateBranches = Array.isArray(card?.availabilityStateBranches)
      ? card.availabilityStateBranches
      : null;
    if (stateBranches) {
      return totalBranchProbability(stateBranches.filter((branch) => branch.available));
    }
    if (Array.isArray(card?.availabilityBranches)) {
      return totalBranchProbability(card.availabilityBranches);
    }
    return 1;
  }

  /** 将标量或已有世界统一为带条件键的效果世界；目标移除与行动者获得必须复用同一数组。 */
  /*
  功能
  推进卡牌/资源效果步骤 normalizeResourceEffectWorlds。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  normalizeResourceEffectWorlds(state, resolution, label) {
    if (Array.isArray(resolution) && resolution.length) return resolution;
    const probability = Math.max(0, Math.min(1, Number(resolution) || 0));
    return this.getEventWorlds(state, probability, null, label);
  }

  /** 生成仅用于模拟的唯一卡牌 ID，避免与真实实体 ID 冲突。 */
  /*
  功能
  推进卡牌/资源效果步骤 nextSimulatedCardId。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  nextSimulatedCardId(state, definitionId) {
    state.simulatedCardCounter = Math.max(0, Number(state.simulatedCardCounter) || 0) + 1;
    return `simulated-resource:${state.simulatedCardCounter}:${definitionId}`;
  }

  /** 在目标 knownCards 中按 cardId + definitionId 查找条目。 */
  /*
  功能
  推进卡牌/资源效果步骤 findKnownCardEntry。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  findKnownCardEntry(target, cardId, definitionId) {
    if (!Array.isArray(target?.knownCards) || !cardId || !definitionId) return null;
    return target.knownCards.find((entry) => (
      entry?.cardId === cardId && entry?.definitionId === definitionId
    )) ?? null;
  }

  /** 将一张已知身份或模拟身份的抽象牌加入玩家手牌，可用性来自 acquisitionWorlds 的 occurs 分支。 */
  /*
  功能
  推进卡牌/资源效果步骤 addSimulatedCardToHand。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  addSimulatedCardToHand(state, player, cardIdentity, acquisitionWorlds) {
    if (!player || !cardIdentity?.definitionId || !Array.isArray(acquisitionWorlds)) return 0;
    const acquired = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs)
    }));
    const acquisitionProbability = totalBranchProbability(acquired.filter((branch) => branch.available));
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    const id = cardIdentity.id ?? this.nextSimulatedCardId(state, cardIdentity.definitionId);
    player.hand ??= [];
    // 先基于加入前的身份初始化反制分布，避免旧快照把新身份计入初始分布后重复 +1。
    this.ensureCounterCountDistribution(player, state?.remainingCardCounts ?? null);
    player.hand.push({
      id,
      definitionId: cardIdentity.definitionId,
      availabilityBranches: availableBranchesFromState(acquired),
      availabilityStateBranches: acquired
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
    if (cardIdentity.definitionId === "block") this.addKnownBlockToDistribution(state, player, acquired);
    if (cardIdentity.definitionId === "counter") this.addKnownCounterToDistribution(state, player, acquired);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return acquisitionProbability;
  }

  /** 计算来源在当前可见表示中的未知聚合数量；可选排除正在使用的转移牌。 */
  /*
  功能
  推进卡牌/资源效果步骤 availableUnknownCountFor。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  availableUnknownCountFor(player, excludedCardIds = null) {
    if (!player) return 0;
    if (Array.isArray(player.hand)) {
      const cards = player.hand.filter((card) => !excludedCardIds?.has(card.id));
      const certainKnownCount = cards.filter((card) => this.cardAvailability(card) >= 1 - PROBABILITY_EPSILON).length;
      const concreteExpected = cards.reduce((sum, card) => sum + this.cardAvailability(card), 0);
      return Math.max(0, concreteExpected - certainKnownCount);
    }
    const { unknownCount } = this.buildSimulatedKnownCards(player);
    return Math.max(0, unknownCount);
  }

  /** 定位来源中的已知转移实体：自己手牌按 id，其他玩家 knownCards 按 cardId+definitionId。 */
  /*
  功能
  推进卡牌/资源效果步骤 findTransferCardEntry。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  findTransferCardEntry(source, cardId, definitionId) {
    if (!cardId || !definitionId) return null;
    if (Array.isArray(source?.hand)) {
      return source.hand.find((card) => card?.id === cardId && card?.definitionId === definitionId) ?? null;
    }
    return this.findKnownCardEntry(source, cardId, definitionId);
  }

  /** 只给其他玩家写入合法已知身份；绝不创建其完整 hand。 */
  /*
  功能
  推进卡牌/资源效果步骤 addSimulatedKnownCard。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  addSimulatedKnownCard(state, player, identity, acquisitionWorlds) {
    if (!player || !identity?.cardId || !identity?.definitionId || !Array.isArray(acquisitionWorlds)) return 0;
    const acquired = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs)
    }));
    const acquisitionProbability = totalBranchProbability(acquired.filter((branch) => branch.available));
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    this.ensureCounterCountDistribution(player, state?.remainingCardCounts ?? null);
    const sameCardId = (player.knownCards ?? []).find((entry) => entry?.cardId === identity.cardId) ?? null;
    if (sameCardId && sameCardId.definitionId !== identity.definitionId) {
      throw new Error(`addSimulatedKnownCard 同 cardId 不同 definitionId：${identity.cardId}`);
    }
    const existing = sameCardId;
    if (existing) {
      if (existing.definitionId !== identity.definitionId) {
        throw new Error(`addSimulatedKnownCard 同 cardId 不同 definitionId：${identity.cardId}`);
      }
      const oldState = getAvailabilityStateBranches(existing);
      const oldProbability = this.cardAvailability(existing);
      const newState = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
        newAvailable:Boolean(branch.occurs)
      }));
      const merged = joinProbabilityStateBranches(oldState, newState);
      const mergedState = projectProbabilityStateBranches(merged, (branch) => ({
        available:Boolean(branch.available || branch.newAvailable)
      }));
      existing.availabilityStateBranches = mergedState;
      existing.availabilityBranches = availableBranchesFromState(mergedState);
      const addedProbability = Math.max(0,
        totalBranchProbability(mergedState.filter((branch) => branch.available)) - oldProbability);
      if (addedProbability > PROBABILITY_EPSILON) {
        player.handCount = (player.handCount ?? 0) + addedProbability;
        if (identity.definitionId === "block") {
          const addedWorlds = projectProbabilityStateBranches(merged, (branch) => ({
            occurs:Boolean(branch.newAvailable && !branch.available)
          }));
          this.addKnownBlockToDistribution(state, player, addedWorlds);
        }
        if (identity.definitionId === "counter") {
          const addedWorlds = projectProbabilityStateBranches(merged, (branch) => ({
            occurs:Boolean(branch.newAvailable && !branch.available)
          }));
          this.addKnownCounterToDistribution(state, player, addedWorlds);
        }
      }
      this.syncCardEstimates(player, state?.remainingCardCounts);
      return addedProbability;
    }
    player.knownCards ??= [];
    player.knownCards.push({
      cardId:identity.cardId,
      definitionId:identity.definitionId,
      availabilityBranches:availableBranchesFromState(acquired),
      availabilityStateBranches:acquired
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
    if (identity.definitionId === "block") this.addKnownBlockToDistribution(state, player, acquired);
    if (identity.definitionId === "counter") this.addKnownCounterToDistribution(state, player, acquired);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return acquisitionProbability;
  }

  /** 已知转移：同一 joined branches 决定来源剩余与接收者获得，身份不在同世界双存。 */
  /*
  功能
  推进卡牌/资源效果步骤 transferKnownCardIdentity。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  transferKnownCardIdentity(state, source, receiver, identity, effectWorlds, receiverIsActor, excludedCardIds = null) {
    const entry = (!excludedCardIds?.has(identity.cardId))
      ? this.findTransferCardEntry(source, identity.cardId, identity.definitionId)
      : null;
    if (!entry || this.cardAvailability(entry) < 1 - PROBABILITY_EPSILON) {
      return this.transferUnknownCardIdentity(state, source, receiver,
        effectWorlds, this.availableUnknownCountFor(source, excludedCardIds));
    }
    const availabilityState = getAvailabilityStateBranches(entry);
    const joined = joinProbabilityStateBranches(effectWorlds, availabilityState);
    const remainingState = projectProbabilityStateBranches(joined, (branch) => ({
      available:Boolean(branch.available && !branch.occurs)
    }));
    const acquisitionWorlds = projectProbabilityStateBranches(joined, (branch) => ({
      occurs:Boolean(branch.available && branch.occurs)
    }));
    const transferProbability = this.eventProbability(acquisitionWorlds);
    if (transferProbability <= PROBABILITY_EPSILON) return 0;
    if (identity.definitionId === "block") {
      this.removeKnownBlockFromDistribution(state, source, acquisitionWorlds);
    }
    if (identity.definitionId === "counter") {
      this.removeKnownCounterFromDistribution(state, source, acquisitionWorlds);
    }
    entry.availabilityStateBranches = remainingState;
    entry.availabilityBranches = availableBranchesFromState(remainingState);
    const remainingProbability = totalBranchProbability(entry.availabilityBranches);
    if (Array.isArray(source.hand)) {
      if (remainingProbability <= PROBABILITY_EPSILON) {
        source.hand = source.hand.filter((card) => card.id !== identity.cardId);
      }
    } else if (Array.isArray(source.knownCards)) {
      if (remainingProbability <= PROBABILITY_EPSILON) {
        source.knownCards = source.knownCards.filter((item) => item !== entry);
      }
    }
    source.handCount = Math.max(0, (source.handCount ?? 0) - transferProbability);
    this.syncCardEstimates(source, state?.remainingCardCounts);
    if (receiverIsActor) {
      return this.addSimulatedCardToHand(state, receiver, {
        id:identity.cardId,
        definitionId:identity.definitionId
      }, acquisitionWorlds);
    }
    return this.addSimulatedKnownCard(state, receiver, identity, acquisitionWorlds);
  }

  /** 未知转移：来源与接收者共享同一组匿名牌身份条件。 */
  /*
  功能
  推进卡牌/资源效果步骤 transferUnknownCardIdentity。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  transferUnknownCardIdentity(state, source, receiver, effectWorlds, availableUnknownCount) {
    return this.transferUnknownBlockCapacity(state, source, receiver, effectWorlds, availableUnknownCount);
  }

  /** 按具体牌与未知聚合重建四类派生摘要；只用于定向已知牌转移/移除与装备入手路径。 */
  /*
  功能
  推进卡牌/资源效果步骤 cardEstimateDistribution。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  cardEstimateDistribution(player, definitionId, remainingCardCounts = null) {
    const explicitEntries = Array.isArray(player.hand)
      ? player.hand.filter((card) => card?.definitionId === definitionId)
      : Array.isArray(player.knownCards)
        ? player.knownCards.filter((entry) => entry?.definitionId === definitionId)
        : [];
    const explicitExpectedCount = explicitEntries.reduce(
      (sum, card) => sum + this.cardAvailability(card), 0
    );
    const handCount = Math.max(0, Number(player.handCount) || 0);
    const unknownExpectedCount = Math.max(0, handCount - explicitExpectedCount);
    const wholeSlots = Math.floor(unknownExpectedCount);
    const fractionalSlot = unknownExpectedCount - wholeSlots;
    const density = remainingCardDensity(remainingCardCounts, definitionId);
    let distribution = [{ count:0, probability:1 }];
    /*
    功能
    推进卡牌/资源效果步骤 convolve。

    调用方
    Simulator facade、Combat/Skill components 与 card characterization 测试。

    输入
    独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

    输出
    更新后的卡牌、装备或资源状态。

    读取状态
    只读 SearchState、card config、RuleEngine facts 与显式选择结果。

    写入状态
    只写独立 SearchState 的 hand/equipment/resource/effect fields。

    调用函数
    Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

    边界与不变量
    不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
    */
    const convolve = (probability) => {
      const next = [];
      for (const branch of distribution) {
        next.push({ count:branch.count, probability:branch.probability * (1 - probability) });
        next.push({ count:branch.count + 1, probability:branch.probability * probability });
      }
      distribution = next;
    };
    for (const card of explicitEntries) convolve(this.cardAvailability(card));
    for (let slot = 0; slot < wholeSlots; slot += 1) convolve(density);
    if (fractionalSlot > PROBABILITY_EPSILON) convolve(fractionalSlot * density);
    const maxCount = Math.max(0, Math.ceil(handCount));
    const merged = new Map();
    for (const branch of distribution) {
      const count = Math.max(0, Math.min(maxCount, Math.floor(Number(branch?.count) || 0)));
      const probability = Math.max(0, Number(branch?.probability) || 0);
      if (probability <= PROBABILITY_EPSILON) continue;
      merged.set(count, (merged.get(count) ?? 0) + probability);
    }
    if (!merged.size) return [{ count:0, probability:1 }];
    const total = [...merged.values()].reduce((sum, probability) => sum + probability, 0);
    return [...merged.entries()]
      .sort(([left], [right]) => left - right)
      .map(([count, probability]) => ({ count, probability:probability / total }));
  }

  /*
  功能
  推进卡牌/资源效果步骤 syncCardEstimates。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  syncCardEstimates(player, remainingCardCounts = null) {
    if (!player) return;
    /*
    功能
    推进卡牌/资源效果步骤 expectation。

    调用方
    Simulator facade、Combat/Skill components 与 card characterization 测试。

    输入
    独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

    输出
    更新后的卡牌、装备或资源状态。

    读取状态
    只读 SearchState、card config、RuleEngine facts 与显式选择结果。

    写入状态
    只写独立 SearchState 的 hand/equipment/resource/effect fields。

    调用函数
    Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

    边界与不变量
    不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
    */
    const expectation = (distribution) => distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability, 0
    );
    /*
    功能
    推进卡牌/资源效果步骤 atLeast。

    调用方
    Simulator facade、Combat/Skill components 与 card characterization 测试。

    输入
    独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

    输出
    更新后的卡牌、装备或资源状态。

    读取状态
    只读 SearchState、card config、RuleEngine facts 与显式选择结果。

    写入状态
    只写独立 SearchState 的 hand/equipment/resource/effect fields。

    调用函数
    Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

    边界与不变量
    不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
    */
    const atLeast = (distribution, required) => distribution.reduce(
      (sum, branch) => sum + (branch.count >= required ? branch.probability : 0), 0
    );
    const recoverDistribution = this.cardEstimateDistribution(player, "recover", remainingCardCounts);
    const assaultDistribution = this.cardEstimateDistribution(player, "assault", remainingCardCounts);
    player.expectedRecoverCount = expectation(recoverDistribution);
    if (!Array.isArray(player.blockCountDistribution) || !player.blockCountDistribution.length) {
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(player, remainingCardCounts);
    }
    this.syncBlockSummary(player);
    if (!Array.isArray(player.counterCountDistribution) || !player.counterCountDistribution.length) {
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(player, remainingCardCounts);
    }
    this.syncCounterSummary(player);
    player.assaultCountDistribution = assaultDistribution;
    player.expectedAssaultCount = expectation(assaultDistribution);
    player.assaultResponseProbability = atLeast(assaultDistribution, 1);
  }

  /**
   * 从模拟可见状态整理合法已知手牌与未知数量。
   * 身份数量超过聚合手牌时保守回退：剩余期望手牌全部按未知聚合处理，不猜测哪张已知牌消失。
   */
  /*
  功能
  推进卡牌/资源效果步骤 buildSimulatedKnownCards。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  buildSimulatedKnownCards(target) {
    const knownCards = Array.isArray(target.knownCards) ? target.knownCards : [];
    const handCount = Math.max(0, Number(target.handCount) || 0);
    const certainKnown = knownCards.filter((entry) => this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON);
    const certainKnownCount = certainKnown.length;
    if (certainKnownCount > handCount + PROBABILITY_EPSILON) {
      return { knownCards: [], unknownCount: handCount };
    }
    return { knownCards: certainKnown, unknownCount: Math.max(0, handCount - certainKnownCount) };
  }

  /** 模拟破坏/掠夺的抽象资源选择；用于 destroy 与 plunder，不读取 target.hand。 */
  /*
  功能
  推进卡牌/资源效果步骤 chooseSimulatedResourceSelection。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  chooseSimulatedResourceSelection(state, actor, target, purpose) {
    const { knownCards, unknownCount } = this.buildSimulatedKnownCards(target);
    const handCandidate = chooseBestResourceHandCandidate({
      purpose,
      actor,
      owner: target,
      knownCards,
      unknownCount,
      remainingCardCounts: state?.remainingCardCounts ?? null
    });
    const equipmentDefinitionId = this.getSimulatedEquipmentProbability(target) > PROBABILITY_EPSILON
      ? (target.equipmentDefinitionId ?? null)
      : null;
    const selection = chooseResourceZone({
      purpose,
      actor,
      owner: target,
      handCandidate,
      equipmentDefinitionId
    });
    if (!selection) return null;
    // 仅供模拟器未知消费使用；不修改资源选择模块的公共语义
    return { ...selection, availableUnknownCount: unknownCount };
  }

  /** 从 AI 自己的具体模拟手牌中同步消费响应牌；部分期望消费会保留对应可用概率。 */
  /*
  功能
  推进卡牌/资源效果步骤 consumeKnownCardsFromHand。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  consumeKnownCardsFromHand(state, player, definitionId, expectedAmount) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    if (!Array.isArray(player?.hand) || remaining <= PROBABILITY_EPSILON) return;
    for (const card of [...player.hand]) {
      if (card.definitionId !== definitionId || remaining <= PROBABILITY_EPSILON) continue;
      const availabilityState = getAvailabilityStateBranches(card);
      const availableProbability = totalBranchProbability(
        availabilityState.filter((branch) => branch.available)
      );
      if (availableProbability <= PROBABILITY_EPSILON) continue;
      const spendProbability = Math.min(availableProbability, remaining);
      const spendWorlds = this.getEventWorlds(state, spendProbability / availableProbability, null,
        `response-card:${player.id}:${card.id}`);
      const joined = joinProbabilityStateBranches(availabilityState, spendWorlds);
      card.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
        available:Boolean(branch.available && !branch.occurs)
      }));
      card.availabilityBranches = availableBranchesFromState(card.availabilityStateBranches);
      if (totalBranchProbability(card.availabilityBranches) <= PROBABILITY_EPSILON) {
        player.hand = player.hand.filter((entry) => entry.id !== card.id);
      }
      remaining -= spendProbability;
    }
  }

  /*
  功能
  推进卡牌/资源效果步骤 normalizeAssaultCountDistribution。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  normalizeAssaultCountDistribution(player, rawDistribution = null) {
    let source = Array.isArray(rawDistribution) && rawDistribution.length
      ? rawDistribution
      : null;
    if (!source && Array.isArray(player?.hand)
      && (player.hand.length > 0 || !(Number(player.expectedAssaultCount) > 0))) {
      source = [{ count:0, probability:1 }];
      for (const card of player.hand.filter((entry) => entry.definitionId === "assault")) {
        const availability = clampProbability(totalBranchProbability(getAvailabilityBranches(card)));
        const next = [];
        for (const branch of source) {
          next.push({ count:branch.count, probability:branch.probability * (1 - availability) });
          next.push({ count:branch.count + 1, probability:branch.probability * availability });
        }
        source = next;
      }
    }
    if (!source) {
      const expected = Math.max(0, Number(player?.expectedAssaultCount) || 0);
      const response = clampProbability(player?.assaultResponseProbability
        ?? (expected > 0 ? 1 : 0));
      if (response <= PROBABILITY_EPSILON || expected <= PROBABILITY_EPSILON) {
        source = [{ count:0, probability:1 }];
      } else {
        const conditionalMean = Math.max(1, expected / response);
        const lower = Math.floor(conditionalMean);
        const upper = Math.ceil(conditionalMean);
        const upperWeight = conditionalMean - lower;
        source = [
          { count:0, probability:1 - response },
          { count:lower, probability:response * (1 - upperWeight) },
          { count:upper, probability:response * upperWeight }
        ];
      }
    }
    const maxCount = Math.max(0, Math.ceil(Number(player?.handCount) || 0));
    const merged = new Map();
    for (const branch of source) {
      const count = Math.max(0, Math.min(maxCount, Math.floor(Number(branch?.count) || 0)));
      const probability = Math.max(0, Number(branch?.probability) || 0);
      if (probability <= PROBABILITY_EPSILON) continue;
      merged.set(count, (merged.get(count) ?? 0) + probability);
    }
    if (!merged.size) return [{ count:0, probability:1 }];
    const total = [...merged.values()].reduce((sum, probability) => sum + probability, 0);
    return [...merged.entries()]
      .sort(([left], [right]) => left - right)
      .map(([count, probability]) => ({ count, probability:probability / total }));
  }

  /*
  功能
  推进卡牌/资源效果步骤 syncAssaultSummary。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  syncAssaultSummary(player, distribution = null) {
    const normalized = this.normalizeAssaultCountDistribution(
      player,
      distribution ?? player?.assaultCountDistribution
    );
    player.assaultCountDistribution = normalized;
    player.expectedAssaultCount = normalized.reduce(
      (sum, branch) => sum + branch.count * branch.probability, 0
    );
    player.assaultResponseProbability = normalized.reduce(
      (sum, branch) => sum + (branch.count > 0 ? branch.probability : 0), 0
    );
    return normalized;
  }

  /*
  功能
  推进卡牌/资源效果步骤 consumeAssaultForOpportunity。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  consumeAssaultForOpportunity(player, opportunityProbability = 1) {
    const chance = clampProbability(opportunityProbability);
    const distribution = this.syncAssaultSummary(player);
    const remaining = [];
    let expectedSpent = 0;
    for (const branch of distribution) {
      if (branch.count <= 0 || chance <= PROBABILITY_EPSILON) {
        remaining.push(branch);
        continue;
      }
      remaining.push({ count:branch.count, probability:branch.probability * (1 - chance) });
      remaining.push({ count:branch.count - 1, probability:branch.probability * chance });
      expectedSpent += branch.probability * chance;
    }
    this.syncAssaultSummary(player, remaining);
    return expectedSpent;
  }

  /**
   * 聚合随机消费后对部分概率 knownCards 做保守身份降级。
   * 完整确定条目保留；零概率与部分概率条目移除（其概率质量已包含在 handCount 中，转为未知聚合）。
   * @returns {boolean} knownCards 是否发生变化
   */
  /*
  功能
  推进卡牌/资源效果步骤 downgradePartialKnownCardsAfterRandomLoss。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  downgradePartialKnownCardsAfterRandomLoss(player) {
    if (!Array.isArray(player?.knownCards)) return false;
    const retained = player.knownCards.filter((entry) => (
      (entry.definitionId === "block" && this.cardAvailability(entry) > PROBABILITY_EPSILON)
      || this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON
    ));
    const changed = retained.length !== player.knownCards.length;
    if (changed) player.knownCards = retained;
    return changed;
  }

  /**
   * 资源专用未知消费：只消费 availableUnknownCount 范围内的未知聚合数量，
   * 不按整手牌比例侵蚀完整确定 known；消费后始终重算摘要。
   * @returns {number} 实际消费的期望数量
   */
  /*
  功能
  推进卡牌/资源效果步骤 consumeUnknownResourceCard。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  consumeUnknownResourceCard(state, player, expectedAmount, availableUnknownCount, eventWorlds = null) {
    if (!player) return 0;
    const spent = Math.min(
      Math.max(0, Number(expectedAmount) || 0),
      Math.max(0, Number(availableUnknownCount) || 0),
      Math.max(0, Number(player.handCount) || 0)
    );
    if (spent <= PROBABILITY_EPSILON) return 0;
    const { removed, identityWorlds } = this.removeUnknownCardsFromBlockDistribution(
      state,
      player,
      spent,
      availableUnknownCount,
      eventWorlds,
      "unknown-resource-loss",
      false
    );
    this.removeUnknownCardsFromCounterDistribution(
      state,
      player,
      removed,
      availableUnknownCount,
      identityWorlds,
      "unknown-counter-resource-loss",
      false
    );
    player.handCount = Math.max(0, (player.handCount ?? 0) - removed);
    this.clearCountersWhenHandEmpty(player);
    this.downgradePartialKnownCardsAfterRandomLoss(player);
    this.syncCardEstimates(player, state?.remainingCardCounts);
    return removed;
  }

  /**
   * 从整副手牌中随机移除一张：hand / knownCards 身份与匿名桶组成互斥候选池。
   * 一次移除只可能选中一个候选，并返回本次实际移除的期望数量。
   */
  /*
  功能
  推进卡牌/资源效果步骤 removeOneRandomCardFromHand。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  removeOneRandomCardFromHand(state, player, spend, options = {}) {
    const amount = Math.min(
      Math.max(0, Number(spend) || 0),
      Math.max(0, Number(player.handCount) || 0)
    );
    if (amount <= PROBABILITY_EPSILON || !player) return 0;
    const explicitCards = [
      ...(Array.isArray(player.hand) ? player.hand : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards : [])
    ];
    const explicitExpected = explicitCards.reduce(
      (sum, card) => sum + this.cardAvailability(card), 0
    );
    const expectedUnknown = Math.max(0, (Number(player.handCount) || 0) - explicitExpected);
    const candidates = [
      ...(Array.isArray(player.hand) ? player.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON)
        .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:card.definitionId })) : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards
        .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON)
        .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:entry.definitionId })) : [])
    ];
    if (!candidates.length && expectedUnknown <= PROBABILITY_EPSILON) return 0;

    let anonymousState = Array.isArray(player.anonymousCountBranches) && player.anonymousCountBranches.length
      ? mergeProbabilityStateBranches(player.anonymousCountBranches)
      : null;
    if (anonymousState) {
      const anonymousExpected = anonymousState.reduce(
        (sum, branch) => sum + branch.probability * (Number(branch.anonymousCount) || 0), 0
      );
      if (Math.abs(anonymousExpected - expectedUnknown) > PROBABILITY_EPSILON) anonymousState = null;
    }
    if (!anonymousState) {
      player.anonymousCountBranches = [{ probability:1, conditions:{}, anonymousCount:expectedUnknown }];
      anonymousState = player.anonymousCountBranches;
    }

    const removalWorlds = probabilityEventPartition(
      this.nextProbabilityEventKey(state, "random-hand-removal"),
      Math.min(1, amount),
      "occurs"
    );
    const candidatePartitions = candidates.map((candidate, index) => (
      getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        [`c${index}`]:Boolean(branch.available)
      }))
    ));
    const anonymousPartition = anonymousState.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      anonymousCount:Math.max(0, Number(branch.anonymousCount) || 0)
    }));
    const joined = joinProbabilityStateBranches(
      removalWorlds, ...candidatePartitions, anonymousPartition
    );
    const selectionKey = this.nextProbabilityEventKey(state, "random-hand-selection");
    const outcomes = [];
    for (const branch of joined) {
      const occurs = Boolean(branch.occurs);
      const available = candidates.map((_, index) => Boolean(branch[`c${index}`]));
      const knownCount = available.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const anonymousCount = Math.max(0, Number(branch.anonymousCount) || 0);
      const total = knownCount + anonymousCount;
      if (!occurs || total <= PROBABILITY_EPSILON) {
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:"none" },
          selectedIndex:-1,
          anonymousSelected:false,
          anonymousCount
        });
        continue;
      }
      for (let index = 0; index < candidates.length; index += 1) {
        if (available[index]) {
          outcomes.push({
            probability:branch.probability / total,
            conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[index].key}` },
            selectedIndex:index,
            anonymousSelected:false,
            anonymousCount
          });
        }
      }
      outcomes.push({
        probability:branch.probability * (anonymousCount / total),
        conditions:{ ...branch.conditions, [selectionKey]:"anonymous" },
        selectedIndex:-1,
        anonymousSelected:true,
        anonymousCount
      });
    }

    const selectionPartition = mergeProbabilityStateBranches(outcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const availabilityState = getAvailabilityStateBranches(candidate.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedAvailability = joinProbabilityStateBranches(availabilityState, selectionPartition);
      candidate.card.availabilityStateBranches = projectProbabilityStateBranches(
        joinedAvailability,
        (branch) => ({ available:Boolean(branch.available && !(branch.selectedIndex === index)) })
      );
      candidate.card.availabilityBranches = availableBranchesFromState(candidate.card.availabilityStateBranches);
      if (totalBranchProbability(candidate.card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(player.hand)) player.hand = player.hand.filter((card) => card !== candidate.card);
        if (Array.isArray(player.knownCards)) player.knownCards = player.knownCards.filter((entry) => entry !== candidate.card);
      }
    }

    const blockState = this.getBlockCountBranches(player, state?.remainingCardCounts ?? null);
    const knownState = this.getKnownBlockCountBranches(player);
    const joinedBlock = joinProbabilityStateBranches(blockState, knownState, selectionPartition);
    const blockOutcomes = [];
    for (const branch of joinedBlock) {
      const totalBlocks = Math.max(0, Math.floor(Number(branch.blockCount) || 0));
      const knownBlocks = Math.max(0, Math.floor(Number(branch.knownBlockCount) || 0));
      const selectedIndex = Number.isFinite(Number(branch.selectedIndex)) ? Number(branch.selectedIndex) : -1;
      if (branch.anonymousSelected) {
        const anonymousCount = Math.max(0, Number(branch.anonymousCount) || 0);
        const anonymousBlocks = Math.max(0, Math.min(anonymousCount, totalBlocks - knownBlocks));
        const removalChance = anonymousCount > PROBABILITY_EPSILON
          ? Math.min(1, anonymousBlocks / anonymousCount)
          : 0;
        blockOutcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          blockCount:Math.max(0, totalBlocks - 1)
        });
        blockOutcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          blockCount:totalBlocks
        });
      } else if (selectedIndex >= 0 && candidates[selectedIndex]?.definitionId === "block") {
        blockOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:Math.max(0, totalBlocks - 1)
        });
      } else {
        blockOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          blockCount:totalBlocks
        });
      }
    }
    player.blockCountDistribution = mergeProbabilityStateBranches(blockOutcomes);
    this.syncBlockSummary(player);

    const counterState = this.getCounterCountBranches(player, state?.remainingCardCounts ?? null);
    const knownCounterState = this.getKnownCounterCountBranches(player);
    const joinedCounter = joinProbabilityStateBranches(counterState, knownCounterState, selectionPartition);
    const counterOutcomes = [];
    for (const branch of joinedCounter) {
      const totalCounters = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const knownCounters = Math.max(0, Math.floor(Number(branch.knownCounterCount) || 0));
      const selectedIndex = Number.isFinite(Number(branch.selectedIndex)) ? Number(branch.selectedIndex) : -1;
      if (branch.anonymousSelected) {
        const anonymousCount = Math.max(0, Number(branch.anonymousCount) || 0);
        const anonymousCounters = Math.max(0, Math.min(anonymousCount, totalCounters - knownCounters));
        const removalChance = anonymousCount > PROBABILITY_EPSILON
          ? Math.min(1, anonymousCounters / anonymousCount)
          : 0;
        counterOutcomes.push({
          probability:branch.probability * removalChance,
          conditions:branch.conditions,
          counterCount:Math.max(0, totalCounters - 1),
          counterRemoved:true
        });
        counterOutcomes.push({
          probability:branch.probability * (1 - removalChance),
          conditions:branch.conditions,
          counterCount:totalCounters,
          counterRemoved:false
        });
      } else if (selectedIndex >= 0 && candidates[selectedIndex]?.definitionId === "counter") {
        counterOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:Math.max(0, totalCounters - 1),
          counterRemoved:true
        });
      } else {
        counterOutcomes.push({
          probability:branch.probability,
          conditions:branch.conditions,
          counterCount:totalCounters,
          counterRemoved:false
        });
      }
    }
    const counterRemovedPartition = mergeProbabilityStateBranches(
      counterOutcomes.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:Boolean(branch.counterRemoved)
      }))
    );
    if (options.result && counterRemovedPartition.length) {
      options.result.counterRemovedWorlds.push(counterRemovedPartition);
    }
    player.counterCountDistribution = mergeProbabilityStateBranches(
      counterOutcomes.map(({ probability, conditions, counterCount }) => ({
        probability, conditions, counterCount
      }))
    );
    this.syncCounterSummary(player);

    const joinedAnonymous = joinProbabilityStateBranches(anonymousPartition, selectionPartition);
    player.anonymousCountBranches = projectProbabilityStateBranches(joinedAnonymous, (branch) => ({
      anonymousCount:Math.max(0, (Number(branch.anonymousCount) || 0) - (branch.anonymousSelected ? 1 : 0))
    }));

    if (Array.isArray(player.hand)) {
      player.hand = player.hand.filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON);
    }
    if (Array.isArray(player.knownCards)) {
      player.knownCards = player.knownCards.filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON);
    }
    player.handCount = Math.max(0, (player.handCount ?? 0) - amount);
    this.clearCountersWhenHandEmpty(player);
    return amount;
  }

  /*
  功能
  推进卡牌/资源效果步骤 consumeRandomHandCards。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  consumeRandomHandCards(state, player, expectedAmount, options = {}) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    let totalSpent = 0;
    const result = options.result ?? null;
    while (remaining > PROBABILITY_EPSILON && (player.handCount ?? 0) > PROBABILITY_EPSILON) {
      const handBefore = Math.max(PROBABILITY_EPSILON, Number(player.handCount) || 0);
      const spend = Math.min(1, remaining, handBefore);
      const distribution = this.syncAssaultSummary(player);
      const next = [];
      for (const branch of distribution) {
        const assaultLossChance = clampProbability(spend * branch.count / handBefore);
        next.push({ count:branch.count, probability:branch.probability * (1 - assaultLossChance) });
        if (branch.count > 0) next.push({ count:branch.count - 1, probability:branch.probability * assaultLossChance });
      }
      this.syncAssaultSummary(player, next);
      this.removeOneRandomCardFromHand(state, player, spend, result ? { result } : {});
      remaining -= spend;
      totalSpent += spend;
    }
    return totalSpent;
  }

  /** 由 AI 自主选择弃牌时的共享上下文：距离 stranded 与装备边际与真实 chooseDiscards 等价。 */
  /*
  功能
  推进卡牌/资源效果步骤 buildDiscardKeepValueContext。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  buildDiscardKeepValueContext(state, player) {
    const enemies = state.players.filter((entry) => entry.alive && entry.battleTeam !== player.battleTeam);
    const stranded = enemies.length > 0
      && !enemies.some((enemy) => DistanceSystem.inAttackRange({ state }, player, enemy));
    return {
      stranded,
      equippedDefinitionId: player.equipmentDefinitionId ?? null,
      equipmentRetentionProbability: player.equipmentRetentionProbability ?? 1
    };
  }

  /**
   * 护援确定性弃牌的前置守卫：只有具体手牌全部 100% 确定存在，且具体身份数量
   * 与 handCount 完全一致（无匿名/未知容量）时，才允许按共享保留价值智能选牌；
   * 概率/部分身份手牌必须回退随机期望消费。
   */
  /*
  功能
  推进卡牌/资源效果步骤 hasCompleteCertainHand。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  hasCompleteCertainHand(player) {
    if (!Array.isArray(player?.hand) || !player.hand.length) return false;
    const allCertain = player.hand.every(
      (card) => this.cardAvailability(card) >= 1 - PROBABILITY_EPSILON
    );
    if (!allCertain) return false;
    return Math.abs(
      Math.max(0, Number(player.handCount) || 0) - player.hand.length
    ) <= PROBABILITY_EPSILON;
  }

  /**
   * 按共享保留价值定向消费已知手牌：护援反事实中 responder 自己的手牌身份合法可见，
   * 因此应选择最低 keep-value 的牌，而不是把已知手牌当作随机损失。
   * 只用于明确由 AI 自主选牌支付的路径；真正随机的弃牌/未知损失仍走 consumeRandomHandCards。
   */
  /*
  功能
  推进卡牌/资源效果步骤 consumeChosenHandCard。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  consumeChosenHandCard(state, player, spend, options = {}) {
    let remaining = Math.max(0, Number(spend) || 0);
    let totalSpent = 0;
    const result = options.result ?? null;
    while (remaining > PROBABILITY_EPSILON && (player.handCount ?? 0) > PROBABILITY_EPSILON) {
      const context = this.buildDiscardKeepValueContext(state, player);
      const candidates = player.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON)
        .sort((left, right) => (
          getDiscardKeepValue(player, left, context) - getDiscardKeepValue(player, right, context)
        ));
      if (!candidates.length) break;
      const chosen = candidates[0];
      const availableProbability = this.cardAvailability(chosen);
      const spent = Math.min(1, remaining, availableProbability);
      const spendWorlds = this.getEventWorlds(
        state,
        Math.min(1, spent / availableProbability),
        null,
        `guardian-aid-discard:${player.id}:${chosen.id}`
      );
      const removalPartition = spendWorlds.map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        removed: Boolean(branch.occurs)
      }));
      const availabilityState = getAvailabilityStateBranches(chosen).map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        available: Boolean(branch.available)
      }));
      const joinedAvailability = joinProbabilityStateBranches(availabilityState, removalPartition);
      chosen.availabilityStateBranches = projectProbabilityStateBranches(joinedAvailability, (branch) => ({
        available: Boolean(branch.available && !branch.removed)
      }));
      chosen.availabilityBranches = availableBranchesFromState(chosen.availabilityStateBranches);
      if (chosen.definitionId === "block") this.removeKnownBlockFromDistribution(state, player, spendWorlds);
      if (chosen.definitionId === "counter") this.removeKnownCounterFromDistribution(state, player, spendWorlds);
      if (chosen.definitionId === "assault") {
        const assaultState = this.syncAssaultSummary(player).map((branch) => ({
          probability: branch.probability,
          conditions: branch.conditions,
          count: branch.count
        }));
        const joinedAssault = joinProbabilityStateBranches(assaultState, removalPartition);
        player.assaultCountDistribution = projectProbabilityStateBranches(joinedAssault, (branch) => ({
          count: Math.max(0, branch.count - (branch.removed && branch.count > 0 ? 1 : 0))
        }));
        this.syncAssaultSummary(player);
      }
      if (chosen.definitionId === "recover") {
        player.expectedRecoverCount = Math.max(
          0,
          (player.expectedRecoverCount ?? 0) - this.eventProbability(spendWorlds)
        );
      }
      if (Array.isArray(player.hand)) {
        player.hand = player.hand.filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON);
      }
      player.handCount = Math.max(0, (player.handCount ?? 0) - spent);
      this.clearCountersWhenHandEmpty(player);
      if (result) {
        result.guardianAidDiscards ??= [];
        result.guardianAidDiscards.push({
          cardId: chosen.id ?? null,
          definitionId: chosen.definitionId
        });
      }
      remaining -= spent;
      totalSpent += spent;
    }
    return totalSpent;
  }

  /*
  功能
  推进卡牌/资源效果步骤 takeResourceToHand。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  takeResourceToHand(state, actor, target, resolution = 1, label = "plunder-resource") {
    if (!Array.isArray(state?.players)) {
      resolution = target ?? 1;
      target = actor;
      actor = state;
      state = { players:[actor, target] };
    }
    const effectWorlds = this.normalizeResourceEffectWorlds(state, resolution, label);
    const selection = this.chooseSimulatedResourceSelection(state, actor, target, "plunder");
    if (!selection) return 0;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const equipmentTransferWorlds = this.gateEventWorlds(
        state,
        effectWorlds,
        existenceProbability,
        `equipment-transfer:${target.id ?? "unknown"}:${selection.definitionId}`
      );
      const transferProbability = this.eventProbability(equipmentTransferWorlds);
      if (transferProbability > PROBABILITY_EPSILON) {
        this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - transferProbability);
        this.addSimulatedCardToHand(state, actor, { definitionId: selection.definitionId }, equipmentTransferWorlds);
      }
      return transferProbability;
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON) {
        const acquisitionProbability = this.eventProbability(effectWorlds);
        if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
        if (selection.definitionId === "block") {
          this.removeKnownBlockFromDistribution(state, target, effectWorlds);
        }
        if (selection.definitionId === "counter") {
          this.removeKnownCounterFromDistribution(state, target, effectWorlds);
        }
        entry.availabilityStateBranches = projectProbabilityStateBranches(effectWorlds, (branch) => ({
          available:Boolean(!branch.occurs)
        }));
        entry.availabilityBranches = availableBranchesFromState(entry.availabilityStateBranches);
        if (totalBranchProbability(entry.availabilityBranches) <= PROBABILITY_EPSILON) {
          target.knownCards = target.knownCards.filter((item) => item !== entry);
        }
        target.handCount = Math.max(0, (target.handCount ?? 0) - acquisitionProbability);
        this.syncCardEstimates(target, state?.remainingCardCounts);
        this.addSimulatedCardToHand(state, actor, {
          id: selection.cardId,
          definitionId: selection.definitionId
        }, effectWorlds);
        return acquisitionProbability;
      }
      const transferred = this.consumeRandomHandCards(state, target, this.eventProbability(effectWorlds));
      actor.handCount = (actor.handCount ?? 0) + transferred;
      return transferred;
    } else if (selection.zone === "hand") {
      return this.transferUnknownBlockCapacity(
        state,
        target,
        actor,
        effectWorlds,
        selection.availableUnknownCount
      );
    }
    return 0;
  }

  /**
   * 同步破坏的手牌/装备区域选择；确定已知牌按 cardId 定向移除，
   * 部分概率保留互补可用分支，未知牌继续走聚合随机消耗。
   */
  /*
  功能
  推进卡牌/资源效果步骤 destroyResource。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  destroyResource(state, actor, target, resolution = 1, label = "destroy-resource") {
    if (!Array.isArray(state?.players)) {
      throw new Error("destroyResource 需要 state、actor、target、scale 完整签名");
    }
    const effectWorlds = this.normalizeResourceEffectWorlds(state, resolution, label);
    const selection = this.chooseSimulatedResourceSelection(state, actor, target, "destroy");
    if (!selection) return 0;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const removalProbability = existenceProbability * this.eventProbability(effectWorlds);
      this.setSimulatedEquipment(target, target.equipmentDefinitionId,
        existenceProbability * (1 - this.eventProbability(effectWorlds)));
      return removalProbability;
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON) {
        const removalProbability = this.eventProbability(effectWorlds);
        if (removalProbability <= PROBABILITY_EPSILON) return 0;
        if (selection.definitionId === "block") {
          this.removeKnownBlockFromDistribution(state, target, effectWorlds);
        }
        if (selection.definitionId === "counter") {
          this.removeKnownCounterFromDistribution(state, target, effectWorlds);
        }
        entry.availabilityStateBranches = projectProbabilityStateBranches(effectWorlds, (branch) => ({
          available:Boolean(!branch.occurs)
        }));
        entry.availabilityBranches = availableBranchesFromState(entry.availabilityStateBranches);
        if (totalBranchProbability(entry.availabilityBranches) <= PROBABILITY_EPSILON) {
          target.knownCards = target.knownCards.filter((item) => item !== entry);
        }
        target.handCount = Math.max(0, (target.handCount ?? 0) - removalProbability);
        this.syncCardEstimates(target, state?.remainingCardCounts);
        return removalProbability;
      }
      return this.consumeRandomHandCards(state, target, this.eventProbability(effectWorlds));
    } else if (selection.zone === "hand") {
      return this.consumeUnknownResourceCard(
        state,
        target,
        this.eventProbability(effectWorlds),
        selection.availableUnknownCount,
        effectWorlds
      );
    }
    return 0;
  }

  /** 窃取所得资源只增加手牌；目标仅有装备时，模拟中明确移除装备且不替换施术者装备。 */
  /*
  功能
  推进卡牌/资源效果步骤 stealResourceToHand。

  调用方
  Simulator facade、Combat/Skill components 与 card characterization 测试。

  输入
  独立 SearchState、卡牌 action/effect worlds 或已选 selection descriptor。

  输出
  更新后的卡牌、装备或资源状态。

  读取状态
  只读 SearchState、card config、RuleEngine facts 与显式选择结果。

  写入状态
  只写独立 SearchState 的 hand/equipment/resource/effect fields。

  调用函数
  Combat、Response、Status components、正式 Resource Policy helper 与 state/Probability。

  边界与不变量
  不生成或评分动作；伤害与响应必须委托唯一 Combat/Response owner。
  */
  stealResourceToHand(state, actor, target, scale = 1) {
    if (!Array.isArray(state?.players)) {
      scale = target ?? 1;
      target = actor;
      actor = state;
      state = { players:[actor, target] };
    }
    const chance = clampProbability(scale);
    const handCount = Math.max(0, target.handCount ?? 0);
    const existenceProbability = this.getSimulatedEquipmentProbability(target);
    if ((!handCount && !existenceProbability) || chance <= 0) return;
    const equipmentLossProbability = existenceProbability / (handCount + 1) * chance;
    const handLoss = handCount > 0 ? (1 - existenceProbability / (handCount + 1)) * chance : 0;
    const gainProbability = (handCount > 0 ? 1 : existenceProbability) * chance;
    actor.handCount = (actor.handCount ?? 0) + gainProbability;
    const result = { counterRemovedWorlds: [] };
    this.consumeRandomHandCards(state, target, handLoss, { result });
    // 只有实际窃取到目标手牌且该手牌是反制的世界才转移反制容量；
    // 复用来源随机失牌已经决定的 counterRemoved 世界，不重新按根先验猜测。
    for (const partition of result.counterRemovedWorlds) {
      this.addTransferredCounterCapacity(state, actor, partition);
    }
    this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - equipmentLossProbability);
  }
};
