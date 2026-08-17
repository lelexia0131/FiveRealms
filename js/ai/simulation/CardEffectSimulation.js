/*
模块职责
镜像卡牌效果、装备与手牌资源身份在 SearchState 中的变化。

上游
Simulator 正式模拟门面、CombatSimulation 与 SkillEffectSimulation。

下游
Response/Combat/Status 组件、Domain CardRules、正式资源 Policy、CardValue 与 Probability。

状态边界
只修改 Simulator 门面提供的独立 SearchState 副本。

信息边界
未知手牌只按位置、数量与概率身份处理，不读取真实 definitionId。

架构约束
不生成动作、不搜索、不拥有规则合法性或最终价值公式。
*/
import { CARD_DEFINITIONS as DOMAIN_CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js?build=20260817-architecture-closure-final";
import {
  findPlayerFact,
  getCardTargetIds
} from "../../domain/rules/card/CardRules.js?build=20260817-architecture-closure-final";
import { hasPassiveSkill, projectRulePlayers } from "../state/RuleProjection.js?build=20260817-architecture-closure-final";
import { inAttackRange } from "../state/DistanceProbabilityBranches.js?build=20260817-architecture-closure-final";
import { mutualBenefitDraftValues } from "../value/GlobalBenefitValue.js?build=20260817-architecture-closure-final";
import { chooseBestResourceHandCandidate, chooseResourceZone } from "../policy/ResourceSelectionPolicy.js?build=20260817-architecture-closure-final";
import { getBaseCardAiValue, getRoleCardAiValue } from "../value/CardValue.js?build=20260817-architecture-closure-final";
import { getDiscardKeepValue } from "../policy/ResourceSelectionPolicy.js?build=20260817-architecture-closure-final";
import { PROBABILITY_EPSILON, availableBranchesFromState, expectedBranchValue, getAvailabilityBranches, getAvailabilityStateBranches, getValueBranches, joinProbabilityStateBranches, mergeProbabilityBranches, mergeProbabilityStateBranches, probabilityEventPartition, projectProbabilityStateBranches, totalBranchProbability } from "../state/Probability.js?build=20260817-architecture-closure-final";
import { clampProbability, fixedCardDensity, remainingCardDensity } from "./SimulationSupport.js?build=20260817-architecture-closure-final";

/*
功能
把 Base class 与 CardEffectSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把卡牌效果方法加入正式模拟门面。

输入
已经包含响应与战斗能力的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增卡牌、装备与资源方法的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withCardEffectSimulation = (Base) => class CardEffectSimulation extends Base {
  /*
  功能
  为每名玩家冻结搜索根的装备基础值与角色差量，供后续换装计算边际变化。

  调用方
  Simulator 构造与 clone：在任何装备变化前冻结根装备比较基线。

  输入
  独立 SearchState；玩家可能已带或未带装备。

  输出
  无返回值；缺失的初始装备价值字段已补齐。

  读取状态
  players 的装备定义、角色 ID 与已有 baseline 字段。

  写入状态
  仅写缺失的 initialEquipmentValue 和 initialEquipmentRoleDelta。

  调用函数
  equipmentRoleDelta、CardValue 配置。

  边界与不变量
  已存在的基线绝不覆盖；后续换装只能相对同一搜索根比较。
  */
  initializeEquipmentBaselines(state) {
    for (const player of state?.players ?? []) {
      if (!Object.hasOwn(player, "initialEquipmentValue")) {
        player.initialEquipmentValue = player.equipmentDefinitionId
          ? getBaseCardAiValue(player.equipmentDefinitionId)
          : 0;
      }
      if (!Object.hasOwn(player, "initialEquipmentRoleDelta")) {
        player.initialEquipmentRoleDelta = player.equipmentDefinitionId
          ? this.equipmentRoleDelta(player, player.equipmentDefinitionId)
          : 0;
      }
    }
  }

  /*
  功能
  计算一件装备相对全局基础值的角色专属差量。

  调用方
  initializeEquipmentBaselines、换装结算与 StateContracts：计算角色对装备的相对偏好。

  输入
  玩家摘要与装备定义 ID。

  输出
  角色静态装备价值减去全局基础值的数值；缺少身份时为零。

  读取状态
  player.characterId 与 CardValue 正式公式。

  写入状态
  无。

  调用函数
  getRoleCardAiValue、getBaseCardAiValue。

  边界与不变量
  只返回静态差量，不把它直接加入最终行动价值。
  */
  equipmentRoleDelta(player, definitionId) {
    if (!player?.characterId || !definitionId) return 0;
    return getRoleCardAiValue(player.characterId, definitionId) - getBaseCardAiValue(definitionId);
  }

  /*
  功能
  从合法已知牌和未知牌密度初始化突袭、格挡、反制与调息的数量摘要。

  调用方
  Simulator 构造：在搜索开始前为所有玩家建立突袭数量摘要。

  输入
  独立 SearchState。

  输出
  无返回值；每名玩家的突袭分布与派生摘要已同步。

  读取状态
  players 的手牌身份、handCount、existing assault distribution 与 remaining counts。

  写入状态
  assaultCountDistribution、expectedAssaultCount、assaultResponseProbability。

  调用函数
  syncAssaultSummary。

  边界与不变量
  只规范已有合法信息；不得读取敌方未知牌定义或额外采样。
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
  独立 SearchState、行动者、抽象动作以及 Simulator 门面计算出的共享事件世界。

  输出
  同一独立 SearchState。

  读取状态
  卡牌定义、目标、效果世界与组件共享资源摘要。

  写入状态
  仅输入 SearchState 的卡牌效果、资源和触发摘要。

  调用函数
  CombatSimulation、ResponseSimulation、Skill/Status 后置钩子与资源辅助函数。

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
        this.healFrom(next, actor, actor, DOMAIN_CARD_DEFINITIONS.recover.healAmount * scale);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        actor.expectedRecoverCount = Math.max(0, (actor.expectedRecoverCount ?? 0) - executionProbability);
        break;
      case "charge": this.changeEnergy(next, actor, DOMAIN_CARD_DEFINITIONS.charge.energyGain, effectEventWorlds); break;
      case "shield":
        if (target?.alive && target.battleTeam === actor.battleTeam) {
          this.changeShield(next, target, DOMAIN_CARD_DEFINITIONS.shield.shieldAmount, effectEventWorlds);
          coordinationProbability = scale;
          coordinationTargets = [target];
        }
        break;
      case "harvest":
        this.gainUnknownCardsWithCounterState(
          next, actor, DOMAIN_CARD_DEFINITIONS.harvest.drawCount, effectEventWorlds, "harvest-draw"
        );
        break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0)
        + DOMAIN_CARD_DEFINITIONS.exposeWeakness.stacksGain * scale; break;
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
        const informationGain = Math.min(DOMAIN_CARD_DEFINITIONS.scout.maxRevealCount, unknownCount);
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
          this.applyDamage(next, actor, player, DOMAIN_CARD_DEFINITIONS.shockwave.perTargetDamage, {
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
          this.applyDamage(next, actor, player, DOMAIN_CARD_DEFINITIONS.provoke.failDamage, {
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
        const rulePlayers = projectRulePlayers(next.players);
        const firstRuleFact = findPlayerFact(rulePlayers, first.id);
        const canActuallyTargetWithAssault = getCardTargetIds(
          rulePlayers,
          firstRuleFact,
          DOMAIN_CARD_DEFINITIONS.assault
        ).includes(second.id);
        // 候选组合从不因手牌估计或次数删除；实际使用必须消费第一目标自己的次数槽。
        const assaultAvailable = canActuallyTargetWithAssault
          ? Math.max(0, Math.min(1, first.assaultResponseProbability ?? 0))
          : 0;
        const equipmentValue = getBaseCardAiValue(first.equipmentDefinitionId);
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
        const perRecipientDrawCount = DOMAIN_CARD_DEFINITIONS.mutualBenefit.perRecipientDrawCount;
        for (const player of coordinationTargets) {
          this.gainUnknownCardsWithCounterState(
            next, player, perRecipientDrawCount, effectEventWorlds, "mutual-benefit-draw"
          );
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
        for (const player of targets) {
          this.healFrom(next, actor, player, DOMAIN_CARD_DEFINITIONS.symbiosis.healAmount * scale);
        }
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
      const remainingUses = Math.max(
        0,
        DOMAIN_CARD_DEFINITIONS.recycleDevice.maxUsesPerTurn - (actor.recycleDeviceUses ?? 0)
      );
      const triggerProbability = Math.min(recycleProbability, remainingUses);
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + triggerProbability;
      if (triggerProbability > PROBABILITY_EPSILON) {
        const recycleWorlds = this.getEventWorlds(
          next, triggerProbability, null, `recycle-draw:${card.id ?? card.definitionId}`
        );
        this.gainUnknownCardsWithCounterState(
          next,
          actor,
          triggerProbability * DOMAIN_CARD_DEFINITIONS.recycleDevice.triggerDrawCount,
          recycleWorlds,
          "recycle-draw"
        );
      }
    }
    if (hasPassiveSkill(actor, "momentum") && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? DOMAIN_CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(next, actor, category, cardEventWorlds);
    }
    this.syncActiveSkillCosts(next);

    return next;
  }

  /*
  功能
  在概率世界中写入玩家当前模拟装备，并同步价值、角色差量与保留概率。

  调用方
  卡牌资源效果、Combat 死亡清理与换装结算：统一写装备存在摘要。

  输入
  玩家摘要、可空装备定义 ID 与存在概率。

  输出
  无返回值；装备定义和保留概率已同步。

  读取状态
  无；只使用显式参数。

  写入状态
  equipmentDefinitionId 与 equipmentRetentionProbability。

  调用函数
  无。

  边界与不变量
  概率为零或定义缺失时必须同时清空身份；不在此结算换装价值。
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
  读取指定装备在玩家当前条件世界中存在的联合概率。

  调用方
  Combat、卡牌资源与技能模拟：判断指定装备在当前条件世界中的存在质量。

  输入
  玩家摘要与可选装备定义 ID 过滤器。

  输出
  零到一的装备存在概率。

  读取状态
  equipmentDefinitionId 与 equipmentRetentionProbability。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  定义不匹配或无装备时返回零；不推测其他装备。
  */
  getSimulatedEquipmentProbability(player, definitionId = null) {
    if (!player?.equipmentDefinitionId || (definitionId && player.equipmentDefinitionId !== definitionId)) return 0;
    return Math.max(0, Math.min(1, Number(player.equipmentRetentionProbability ?? 1) || 0));
  }

  /*
  功能
  汇总一张抽象牌在其可用性分支中的剩余概率。

  调用方
  Simulation、CardValue 与资源选择：读取一张已过滤卡牌仍可消费的概率。

  输入
  可含完整 availabilityStateBranches、兼容 availabilityBranches 或无分支的卡牌摘要。

  输出
  卡牌可用世界的总概率；无分支时为一。

  读取状态
  只读卡牌 availability 状态。

  写入状态
  无。

  调用函数
  totalBranchProbability。

  边界与不变量
  完整状态分支优先；只做投影，不改变身份或概率质量。
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

  /*
  功能
  将资源效果的标量概率或既有条件世界规范成同一 occurs 分区。

  调用方
  takeResourceToHand 与 destroyResource：把资源效果的执行尺度交给统一事件世界。

  输入
  SearchState、概率标量或已有事件分支、条件标签。

  输出
  原分支数组或新建的 occurs 事件分支。

  读取状态
  只读显式 resolution；标量路径由 getEventWorlds 读取事件计数。

  写入状态
  无。

  调用函数
  getEventWorlds。

  边界与不变量
  已有条件世界必须原样复用；标量只建立一次互补事件。
  */
  normalizeResourceEffectWorlds(state, resolution, label) {
    if (Array.isArray(resolution) && resolution.length) return resolution;
    const probability = Math.max(0, Math.min(1, Number(resolution) || 0));
    return this.getEventWorlds(state, probability, null, label);
  }

  /*
  功能
  生成不会与真实实体牌冲突的单调模拟卡牌 ID。

  调用方
  摸牌、雷达与资源转移模拟：为没有真实实体 ID 的确定牌创建身份。

  输入
  SearchState 与正式卡牌定义 ID。

  输出
  不会与真实牌 ID 冲突的单调字符串 ID。

  读取状态
  simulatedCardCounter。

  写入状态
  simulatedCardCounter 加一。

  调用函数
  无。

  边界与不变量
  同一状态内不复用计数；定义 ID 只进入模拟身份，不读取牌堆实体。
  */
  nextSimulatedCardId(state, definitionId) {
    state.simulatedCardCounter = Math.max(0, Number(state.simulatedCardCounter) || 0) + 1;
    return `simulated-resource:${state.simulatedCardCounter}:${definitionId}`;
  }

  /*
  功能
  按实体 ID 与定义 ID 在合法 knownCards 中定位抽象牌条目。

  调用方
  转移、掠夺与破坏模拟：按合法记忆定位确定牌身份。

  输入
  目标玩家、cardId 与 definitionId。

  输出
  同一实体/定义的 knownCards 条目；找不到返回 null。

  读取状态
  仅目标 knownCards。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  ID 与定义必须同时相等，不能只按牌名匹配未知位置。
  */
  findKnownCardEntry(target, cardId, definitionId) {
    if (!Array.isArray(target?.knownCards) || !cardId || !definitionId) return null;
    return target.knownCards.find((entry) => (
      entry?.cardId === cardId && entry?.definitionId === definitionId
    )) ?? null;
  }

  /*
  功能
  按获得世界把一张已知或模拟身份牌加入玩家自己的搜索手牌。

  调用方
  雷达、掠夺与已知转移：把确定身份加入行动者自己的搜索手牌。

  输入
  SearchState、拥有 hand 数组的玩家、牌身份与获得事件世界。

  输出
  实际新增可用质量；无效输入或零质量返回零。

  读取状态
  玩家现有 hand/handCount、响应分布与 remaining counts。

  写入状态
  hand、handCount、牌 availability、block/counter/assault/recover 摘要。

  调用函数
  nextSimulatedCardId、响应容量增量 辅助函数、syncCardEstimates。

  边界与不变量
  同一获得世界同时驱动身份、手牌数与响应容量；新增身份不能在初始分布中重复计数。
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
    // 必须先用加入前的身份初始化反制分布；否则新身份会同时进入根分布和本次增量，造成重复计数。
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

  /*
  功能
  计算玩家手牌数量扣除确定已知身份后的未知聚合容量。

  调用方
  未知资源转移与消费路径：计算除确定身份外仍可操作的聚合手牌容量。

  输入
  玩家摘要与可选排除 card ID 集合。

  输出
  非负未知期望容量。

  读取状态
  自己的 hand availability，或其他玩家的合法 knownCards 与 handCount。

  写入状态
  无。

  调用函数
  cardAvailability、buildSimulatedKnownCards。

  边界与不变量
  排除实体后仍不得把合法已知身份再次计入未知容量。
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

  /*
  功能
  按来源可见性定位转移使用的真实自有牌或合法已知他人牌。

  调用方
  transferKnownCardIdentity：在来源可见表示中重绑待转移实体。

  输入
  来源玩家、cardId 与 definitionId。

  输出
  自己的 hand 卡或合法 knownCards 条目；找不到返回 null。

  读取状态
  source.hand 或 source.knownCards。

  写入状态
  无。

  调用函数
  findKnownCardEntry。

  边界与不变量
  只访问来源允许的表示；未知他人手牌不得按真实实体重绑。
  */
  findTransferCardEntry(source, cardId, definitionId) {
    if (!cardId || !definitionId) return null;
    if (Array.isArray(source?.hand)) {
      return source.hand.find((card) => card?.id === cardId && card?.definitionId === definitionId) ?? null;
    }
    return this.findKnownCardEntry(source, cardId, definitionId);
  }

  /*
  功能
  只向其他玩家的合法 knownCards 表示写入新获得的确定身份。

  调用方
  转移、雷达与非观察者摸牌：向合法 knownCards 表示加入确定身份。

  输入
  SearchState、目标玩家、cardId/definitionId 与获得世界。

  输出
  实际新增可用质量；无效或零质量返回零。

  读取状态
  knownCards、handCount、响应分布与 remaining counts。

  写入状态
  knownCards availability、handCount 与 block/counter/card estimates。

  调用函数
  响应容量增量 辅助函数、syncCardEstimates。

  边界与不变量
  同一 cardId 不能对应不同 definitionId；重复获得只并联合并可用世界。
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

  /*
  功能
  用同一联合条件世界从来源移除并向接收者增加确定牌身份。

  调用方
  CardEffectSimulation 的转移牌结算：在同一世界搬运一张确定身份。

  输入
  SearchState、来源/接收者、牌身份、效果世界、接收者可见性与排除集合。

  输出
  实际转移概率。

  读取状态
  来源实体 availability、双方手牌/响应摘要。

  写入状态
  来源 availability/handCount 与接收者 hand 或 knownCards、响应容量。

  调用函数
  findTransferCardEntry、addSimulatedCardToHand/addSimulatedKnownCard、响应容量移除 辅助函数。

  边界与不变量
  来源移除和接收者增加必须共享同一条件世界；实体 ID 在任一世界只能归一个持有者。
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

  /*
  功能
  用共享匿名身份条件将一张未知牌容量从来源转给接收者。

  调用方
  转移牌与未知手牌资源路径：搬运一个匿名手牌容量。

  输入
  SearchState、来源/接收者、效果世界与来源可用未知数量。

  输出
  实际转移的期望数量。

  读取状态
  双方 handCount、未知 block/counter 容量与 remaining counts。

  写入状态
  双方 handCount、block/counter 分布及派生摘要。

  调用函数
  transferUnknownBlockCapacity。

  边界与不变量
  来源减少与接收者增加必须条件耦合；不得生成 definitionId。
  */
  transferUnknownCardIdentity(state, source, receiver, effectWorlds, availableUnknownCount) {
    return this.transferUnknownBlockCapacity(state, source, receiver, effectWorlds, availableUnknownCount);
  }

  /*
  功能
  根据确定牌和未知聚合牌建立指定定义的数量概率分布。

  调用方
  syncCardEstimates 与响应初始化：估计指定牌在当前手牌中的数量分布。

  输入
  玩家过滤摘要、卡牌定义 ID 与可选 remainingCardCounts。

  输出
  按 count 升序、概率归一的新分布数组。

  读取状态
  全部已知身份的 availability、handCount 与未知池密度。

  写入状态
  无。

  调用函数
  cardAvailability、remainingCardDensity。

  边界与不变量
  确定身份逐张进入分布；只有扣除全部已知身份占用后的真实匿名容量才使用聚合密度，
  不得把已知但属于其它定义的手牌重新当作未知槽；不访问真实未知牌。
  */
  cardEstimateDistribution(player, definitionId, remainingCardCounts = null) {
    const explicitEntries = Array.isArray(player.hand)
      ? player.hand
      : Array.isArray(player.knownCards)
        ? player.knownCards
        : [];
    const matchingEntries = explicitEntries.filter(
      (entry) => entry?.definitionId === definitionId
    );
    const totalExplicitOccupancy = explicitEntries.reduce(
      (sum, card) => sum + this.cardAvailability(card), 0
    );
    const handCount = Math.max(0, Number(player.handCount) || 0);
    const anonymousExpectedCount = Math.max(0, handCount - totalExplicitOccupancy);
    const wholeSlots = Math.floor(anonymousExpectedCount);
    const fractionalSlot = anonymousExpectedCount - wholeSlots;
    const density = remainingCardDensity(remainingCardCounts, definitionId);
    let distribution = [{ count:0, probability:1 }];
    /*
    功能
    将一张牌的定义概率卷积进当前数量分布，并合并相同条件世界。

    调用方
    cardEstimateDistribution：逐个把确定身份或未知槽的命中概率加入局部计数分布。

    输入
    当前槽为指定定义的概率。

    输出
    无返回值；闭包中的局部 distribution 替换为卷积结果。

    读取状态
    仅闭包局部 distribution。

    写入状态
    仅写 cardEstimateDistribution 的局部 distribution。

    调用函数
    无。

    边界与不变量
    每个槽只卷积一次；不修改玩家状态或重新归一化中间质量。
    */
    const convolve = (probability) => {
      const next = [];
      for (const branch of distribution) {
        next.push({ count:branch.count, probability:branch.probability * (1 - probability) });
        next.push({ count:branch.count + 1, probability:branch.probability * probability });
      }
      distribution = next;
    };
    for (const card of matchingEntries) convolve(this.cardAvailability(card));
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
  从当前手牌身份和剩余牌先验重建调息、格挡、反制与突袭摘要。

  调用方
  摸牌、失牌、转移与响应容量变化后：重建玩家的卡牌数量派生摘要。

  输入
  玩家过滤摘要与可选 remainingCardCounts。

  输出
  无返回值；调息、格挡、反制和突袭摘要已同步。

  读取状态
  手牌身份/availability、handCount、已有响应分布与未知池密度。

  写入状态
  expectedRecoverCount、block/counter summaries、assaultCountDistribution/expectation/responseProbability。

  调用函数
  cardEstimateDistribution、ResponseSimulation 的 block/counter 辅助函数、syncAssaultSummary。

  边界与不变量
  所有摘要必须来自同一当前手牌表示；不得把身份损失和聚合损失重复扣除。
  */
  syncCardEstimates(player, remainingCardCounts = null) {
    if (!player) return;
    /*
    功能
    计算数量分布的一阶期望。

    调用方
    syncCardEstimates：把数量分布投影为派生期望库存。

    输入
    count/probability 数量分布。

    输出
    未归一化的一阶期望数值。

    读取状态
    仅局部分布。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    调用方负责传入规范化分布；本函数不修改或重新缩放概率。
    */
    const expectation = (distribution) => distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability, 0
    );
    /*
    功能
    计算数量分布达到给定阈值的概率。

    调用方
    syncCardEstimates：计算至少拥有指定张数的响应概率。

    输入
    count/probability 数量分布与非负阈值。

    输出
    count 大于等于阈值的概率质量。

    读取状态
    仅局部分布。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    只汇总已有分支，不把期望数量误当作命中概率。
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

  /*
  功能
  将合法已知手牌整理成确定身份与未知聚合数量，处理身份数量失配的保守回退。

  调用方
  资源选择与未知容量计算：把合法身份和匿名容量整理为策略输入。

  输入
  过滤后的目标玩家摘要。

  输出
  包含 knownCards 与 unknownCount 的新对象。

  读取状态
  target.hand 或 knownCards、handCount 与各牌 availability。

  写入状态
  无。

  调用函数
  cardAvailability。

  边界与不变量
  knownCards 只能来自自己 hand 或合法记忆；身份总量超过 handCount 时按手牌容量保守截断。
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

  /*
  功能
  为破坏或掠夺构造公开资源上下文并委托正式 ResourceSelectionPolicy。

  调用方
  takeResourceToHand 与 destroyResource：在公开资源上下文中请求正式资源策略。

  输入
  SearchState、行动者、目标与 purpose（plunder 或 destroy）。

  输出
  选中区域/身份描述；无正收益候选时为 null。

  读取状态
  公开装备、合法已知手牌、匿名容量、距离与 remaining counts。

  写入状态
  无。

  调用函数
  chooseBestResourceHandCandidate、chooseResourceZone、buildSimulatedKnownCards。

  边界与不变量
  本函数只选择，不移动资源；未知候选不携带真实 definitionId。
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

  /*
  功能
  按共享效果世界从自己的模拟手牌消费指定已知牌身份。

  调用方
  对决、格挡/反制与救援资源消耗：按期望量扣减自己的确定手牌。

  输入
  SearchState、拥有 hand 的玩家、definitionId 与非负期望消耗量。

  输出
  无返回值；匹配牌的可用世界已按顺序消费。

  读取状态
  匹配实体的 availabilityStateBranches。

  写入状态
  牌 availability 分支，并在质量归零时移出 hand。

  调用函数
  getEventWorlds、join/project Probability 辅助函数。

  边界与不变量
  按 hand 顺序消费且每张身份最多一次；不直接改变 handCount，由拥有该流量的调用方统一记账。
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
  规范玩家突袭数量分布；输入未携带正式分支时从现有确定/期望摘要回退。

  调用方
  syncAssaultSummary、Combat 对决与响应路径：取得正式突袭数量分布。

  输入
  玩家摘要与可选原始 count/probability 分布。

  输出
  按 count 聚合并归一的新分布。

  读取状态
  优先 rawDistribution，其次 hand availability，最后确定/期望摘要回退。

  写入状态
  无。

  调用函数
  cardAvailability、Probability 辅助函数。

  边界与不变量
  分布 count 不得超过 handCount；输入未含正式分支时的回退不能增加期望容量。
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
  从突袭数量分布同步期望库存与至少一张的响应概率。

  调用方
  Simulator 初始化、Combat 对决和随机失牌路径：同步突袭库存表示。

  输入
  玩家摘要与可选数量分布。

  输出
  规范化后的突袭数量分布。

  读取状态
  给定分布或 player.assaultCountDistribution。

  写入状态
  assaultCountDistribution、expectedAssaultCount 与 assaultResponseProbability。

  调用函数
  normalizeAssaultCountDistribution。

  边界与不变量
  期望数量和至少一张概率必须由同一分布投影，不能独立更新。
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
  在可兑现的条件世界消费一张突袭容量并保持条件相关性。

  调用方
  卡牌结算、对决与 Simulator 动作支付：消费一次可兑现突袭容量。

  输入
  玩家摘要与本次机会发生概率。

  输出
  实际消费的期望突袭数量。

  读取状态
  当前突袭数量分布。

  写入状态
  assaultCountDistribution 及其期望/响应摘要。

  调用函数
  syncAssaultSummary。

  边界与不变量
  只在 count>0 的机会世界扣一张；同一机会不能按期望数再次扣除。
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

  /*
  功能
  随机失牌后降级部分已知身份，避免已知牌与聚合手牌容量双计。

  调用方
  随机未知失牌后：删除无法继续证明身份仍存在的部分 knownCards。

  输入
  其他玩家的过滤摘要。

  输出
  knownCards 是否发生变化。

  读取状态
  knownCards 的 availability 与定义。

  写入状态
  必要时替换 knownCards 数组。

  调用函数
  cardAvailability。

  边界与不变量
  只保留确定身份和仍有格挡用途的合法部分身份；不补看未知牌面。
  */
  downgradePartialKnownCardsAfterRandomLoss(player) {
    if (!Array.isArray(player?.knownCards)) return false;
    const retained = player.knownCards.filter((entry) => (
      (entry.definitionId === "block" && this.cardAvailability(entry) > PROBABILITY_EPSILON)
      || this.cardAvailability(entry) >= 1 - PROBABILITY_EPSILON
    ));
    const changed = retained.length !== player.knownCards.length;
    if (changed) {
      player.knownCards = retained;
      // 身份条目被降级后，既有槽位全状态不再与条目集合等价；
      // 清除对应 group state，后续随机移除回退逐身份语义，避免使用陈旧世界。
      if (player.identitySlotStates) {
        for (const groupKey of Object.keys(player.identitySlotStates)) {
          if (!retained.some((entry) => entry.identityGroupKey === groupKey)) {
            delete player.identitySlotStates[groupKey];
          }
        }
      }
    }
    return changed;
  }

  /*
  功能
  从未知聚合容量中消费一张资源牌，并同步各类响应数量分布。

  调用方
  destroyResource 与匿名资源消费：从聚合未知手牌中扣减一次资源。

  输入
  SearchState、玩家、期望消耗、可用匿名容量与可选事件世界。

  输出
  实际移除的期望数量。

  读取状态
  handCount、block/counter 分布、knownCards 与 remaining counts。

  写入状态
  handCount、block/counter/assault/recover 摘要和 knownCards 降级。

  调用函数
  removeUnknownCardsFromBlockDistribution、removeUnknownCardsFromCounterDistribution、syncCardEstimates。

  边界与不变量
  两种响应容量必须复用同一身份损失世界；未知消费不得生成或选择 definitionId。
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

  /*
  功能
  取得一个 partial-group 的完整物理槽位状态，或从条目全状态精确重建。

  调用方
  removeOneRandomCardFromHand。

  输入
  玩家、identityGroupKey 与该组成员。

  输出
  slotAvailable/definitionId 的完整概率分区；无法证明互斥完整时返回 null。

  读取状态
  player.identitySlotStates 或条目 availabilityStateBranches。

  写入状态
  无。

  调用函数
  getAvailabilityStateBranches、mergeProbabilityStateBranches。

  边界与不变量
  完整分区质量必须约等于一；只对可证明互斥的身份组启用精确边缘化，
  其他输入回退既有逐身份选择语义。
  */
  identitySlotStateFor(player, groupKey, entries) {
    const stored = player?.identitySlotStates?.[groupKey];
    if (Array.isArray(stored) && stored.length) return stored;
    const branches = entries.flatMap((entry) => (
      getAvailabilityStateBranches(entry).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        slotAvailable:Boolean(branch.available),
        definitionId:branch.available ? entry.definitionId : null
      }))
    ));
    const merged = mergeProbabilityStateBranches(branches);
    const mass = totalBranchProbability(merged);
    return Math.abs(mass - 1) <= 1e-7 ? merged : null;
  }

  /*
  功能
  把同一物理槽位的互斥身份可用分支边缘化为该槽位的可用概率分区。

  调用方
  removeOneRandomCardFromHand 的 partial-group 候选构造。

  输入
  共享 identityGroupKey 的概率身份条目与该内部条件键。

  输出
  删除内部身份键后按剩余条件合并的槽位可用分支。

  读取状态
  availabilityStateBranches 或 availabilityBranches。

  写入状态
  无。

  调用函数
  mergeProbabilityBranches。

  边界与不变量
  只边缘化调用方显式声明的槽位内部身份键；其他共享世界条件必须原样保留，
  因此不会把相关性错误的独立化，也不修改任何身份条目。
  */
  marginalizeIdentitySlotBranches(entries, identityKey) {
    return mergeProbabilityBranches(entries.flatMap((entry) => {
      const branches = Array.isArray(entry.availabilityStateBranches)
        ? entry.availabilityStateBranches
        : entry.availabilityBranches ?? [];
      return branches
        .filter((branch) => branch.available !== false)
        .map((branch) => {
          const conditions = { ...(branch.conditions ?? {}) };
          delete conditions[identityKey];
          return {
            probability:Math.max(0, Number(branch.probability) || 0),
            conditions
          };
        });
    }));
  }

  /*
  功能
  按当前已知/未知身份概率移除一张随机手牌并返回效果世界。

  调用方
  consumeRandomHandCards 与 guardian aid 弃牌路径：镜像一次随机失牌。

  输入
  SearchState、玩家、零到一的移除质量与可选结果收集器。

  输出
  实际移除的期望数量。

  读取状态
  确定身份 availability、匿名容量、block/counter 分布与 handCount。

  写入状态
  牌/匿名 availability、响应数量分布、handCount 与可选结果世界。

  调用函数
  Probability 连接/投影 辅助函数、syncBlockSummary、syncCounterSummary、clearCountersWhenHandEmpty。

  边界与不变量
  身份选择分区必须互斥；同一张牌在一个世界最多移除一次，响应容量与手牌身份共享条件。
  */
  removeOneRandomCardFromHand(state, player, spend, options = {}) {
    const eventMass = Array.isArray(options.eventWorlds) && options.eventWorlds.length
      ? this.eventProbability(options.eventWorlds)
      : null;
    const amount = Math.min(
      Math.max(0, Number(spend) || 0),
      Math.max(0, Number(player.handCount) || 0),
      eventMass == null ? Infinity : eventMass
    );
    if (amount <= PROBABILITY_EPSILON || !player) return 0;
    const explicitCards = options.anonymousOnly
      ? []
      : [
          ...(Array.isArray(player.hand) ? player.hand : []),
          ...(Array.isArray(player.knownCards) ? player.knownCards : [])
        ];
    const explicitExpected = explicitCards.reduce(
      (sum, card) => sum + this.cardAvailability(card), 0
    );
    const expectedUnknown = Math.max(0, (Number(player.handCount) || 0) - explicitExpected);
    let candidates = options.anonymousOnly
      ? []
      : [
          ...(Array.isArray(player.hand) ? player.hand
            .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON
              && !card.identityGroupKey)
            .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:card.definitionId })) : []),
          ...(Array.isArray(player.knownCards) ? player.knownCards
            .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON
              && !entry.identityGroupKey)
            .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:entry.definitionId })) : [])
        ];
    // 同一观察/窃取槽位的互斥概率身份共享 identityGroupKey。
    // 随机移除只把它们当作一个聚合候选，避免二十余个互斥身份反复进入 Probability 叉乘。
    if (!options.anonymousOnly) {
      const groupedEntries = new Map();
      for (const entries of [
        ...(Array.isArray(player.hand) ? player.hand : []),
        ...(Array.isArray(player.knownCards) ? player.knownCards : [])
      ]) {
        if (!entries.identityGroupKey || this.cardAvailability(entries) <= PROBABILITY_EPSILON) continue;
        if (!groupedEntries.has(entries.identityGroupKey)) groupedEntries.set(entries.identityGroupKey, []);
        groupedEntries.get(entries.identityGroupKey).push(entries);
      }
      candidates = [
        ...candidates,
        ...[...groupedEntries.entries()].map(([groupKey, entries]) => {
          const slotState = this.identitySlotStateFor(player, groupKey, entries);
          const candidate = {
            key:`partial-group:${groupKey}`,
            card:{
              id:`partial-group:${groupKey}`,
              definitionId:null
            },
            definitionId:null,
            aggregateEntries:entries,
            slotKey:groupKey,
            slotState
          };
          if (slotState) {
            candidate.card.availabilityStateBranches = projectProbabilityStateBranches(
              slotState,
              (branch) => ({ available:Boolean(branch.slotAvailable) })
            );
          } else {
            candidate.card.availabilityBranches = this.marginalizeIdentitySlotBranches(
              entries,
              groupKey
            );
          }
          return candidate;
        })
      ];
    }
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

    const removalWorlds = Array.isArray(options.eventWorlds) && options.eventWorlds.length
      ? this.gateEventWorlds(
          state,
          options.eventWorlds,
          eventMass > PROBABILITY_EPSILON ? amount / eventMass : 0,
          "random-hand-removal"
        )
      : probabilityEventPartition(
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
    // 聚合槽位已在上面按完整 slotState 重建 block/counter 容量；
    // 响应容量循环只消费真正的独立 block/counter 候选，不再次解释 aggregate 选择。
    const responseSelectionPartition = mergeProbabilityStateBranches(
      selectionPartition.map((branch) => {
        const selectedAggregate = branch.selectedIndex >= 0
          && Boolean(candidates[branch.selectedIndex]?.aggregateEntries);
        return {
          probability:branch.probability,
          conditions:branch.conditions,
          selectedIndex:selectedAggregate ? -1 : branch.selectedIndex,
          anonymousSelected:selectedAggregate ? false : branch.anonymousSelected,
          anonymousCount:branch.anonymousCount ?? 0
        };
      })
    );
    if (options.result) {
      options.result.selectionPartition = selectionPartition;
      options.result.knownIdentityWorlds = candidates.map((candidate, index) => ({
        definitionId:candidate.definitionId,
        cardId:candidate.card?.id ?? candidate.card?.cardId ?? null,
        worlds:mergeProbabilityStateBranches(
          selectionPartition
            .filter((branch) => branch.selectedIndex === index)
            .map((branch) => ({
              probability:branch.probability,
              conditions:branch.conditions,
              occurs:true
            }))
        )
      }));
      options.result.anonymousSelectionWorlds = mergeProbabilityStateBranches(
        selectionPartition
          .filter((branch) => branch.anonymousSelected)
          .map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            occurs:true
          }))
      );
    }
    let aggregateBlockRemovedWorlds = null;
    let aggregateCounterRemovedWorlds = null;
    let handCountAdjusted = false;
    const hasAggregateCandidate = candidates.some((candidate) => candidate.aggregateEntries);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.aggregateEntries) {
        if (candidate.slotState) {
          const joinedSlot = joinProbabilityStateBranches(candidate.slotState, selectionPartition);
          aggregateBlockRemovedWorlds = mergeProbabilityStateBranches(
            joinedSlot.map((branch) => ({
              probability:branch.probability,
              conditions:branch.conditions,
              occurs:Boolean(
                branch.slotAvailable
                && branch.selectedIndex === index
                && branch.definitionId === "block"
              )
            }))
          );
          aggregateCounterRemovedWorlds = mergeProbabilityStateBranches(
            joinedSlot.map((branch) => ({
              probability:branch.probability,
              conditions:branch.conditions,
              occurs:Boolean(
                branch.slotAvailable
                && branch.selectedIndex === index
                && branch.definitionId === "counter"
              )
            }))
          );
          const updatedSlot = projectProbabilityStateBranches(joinedSlot, (branch) => ({
            slotAvailable:Boolean(branch.slotAvailable && branch.selectedIndex !== index),
            definitionId:branch.definitionId
          }));
          if (player.identitySlotStates) {
            player.identitySlotStates[candidate.slotKey] = updatedSlot;
          }
          for (const entry of candidate.aggregateEntries) {
            entry.availabilityStateBranches = projectProbabilityStateBranches(updatedSlot, (branch) => ({
              available:Boolean(branch.slotAvailable && branch.definitionId === entry.definitionId)
            }));
            entry.availabilityBranches = availableBranchesFromState(entry.availabilityStateBranches);
            if (totalBranchProbability(entry.availabilityBranches) <= PROBABILITY_EPSILON) {
              if (Array.isArray(player.hand)) player.hand = player.hand.filter((card) => card !== entry);
              if (Array.isArray(player.knownCards)) {
                player.knownCards = player.knownCards.filter((known) => known !== entry);
              }
            }
          }
          continue;
        }
        for (const entry of candidate.aggregateEntries) {
          const entryState = getAvailabilityStateBranches(entry).map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            available:Boolean(branch.available)
          }));
          const joinedEntry = joinProbabilityStateBranches(entryState, selectionPartition);
          entry.availabilityStateBranches = projectProbabilityStateBranches(joinedEntry, (branch) => ({
            available:Boolean(branch.available && branch.selectedIndex !== index)
          }));
          entry.availabilityBranches = availableBranchesFromState(entry.availabilityStateBranches);
          if (totalBranchProbability(entry.availabilityBranches) <= PROBABILITY_EPSILON) {
            if (Array.isArray(player.hand)) player.hand = player.hand.filter((card) => card !== entry);
            if (Array.isArray(player.knownCards)) {
              player.knownCards = player.knownCards.filter((known) => known !== entry);
            }
          }
        }
        continue;
      }
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

    if (hasAggregateCandidate) {
      // 聚合槽位已在上面按完整 slotState 投影条目；这里推进 handCount 后从最终条目边际
      // 一次性重建 block/counter 容量，避免 aggregate selection 再次污染响应分布。
      player.handCount = Math.max(0, (player.handCount ?? 0) - amount);
      handCountAdjusted = true;
      player.blockCountDistribution = this.buildInitialBlockCountDistribution(
        player,
        state?.remainingCardCounts ?? null
      ).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        blockCount:branch.blockCount
      }));
      this.syncBlockSummary(player);
      player.counterCountDistribution = this.buildInitialCounterCountDistribution(
        player,
        state?.remainingCardCounts ?? null
      ).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        counterCount:branch.counterCount
      }));
      this.syncCounterSummary(player);
      if (options.result) {
        const selectedBlockWorlds = mergeProbabilityStateBranches(
          selectionPartition.map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            occurs:Boolean(
              branch.selectedIndex >= 0
              && candidates[branch.selectedIndex]?.definitionId === "block"
            )
          }))
        );
        const selectedCounterWorlds = mergeProbabilityStateBranches(
          selectionPartition.map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            occurs:Boolean(
              branch.selectedIndex >= 0
              && candidates[branch.selectedIndex]?.definitionId === "counter"
            )
          }))
        );
        options.result.blockRemovedWorlds = aggregateBlockRemovedWorlds
          ? aggregateBlockRemovedWorlds
          : selectedBlockWorlds;
        options.result.counterRemovedWorlds.push(
          aggregateCounterRemovedWorlds ?? selectedCounterWorlds
        );
      }
    } else {
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
            blockCount:Math.max(0, totalBlocks - 1),
            blockRemoved:true
          });
          blockOutcomes.push({
            probability:branch.probability * (1 - removalChance),
            conditions:branch.conditions,
            blockCount:totalBlocks,
            blockRemoved:false
          });
        } else if (selectedIndex >= 0 && candidates[selectedIndex]?.definitionId === "block") {
          blockOutcomes.push({
            probability:branch.probability,
            conditions:branch.conditions,
            blockCount:Math.max(0, totalBlocks - 1),
            blockRemoved:true
          });
        } else {
          blockOutcomes.push({
            probability:branch.probability,
            conditions:branch.conditions,
            blockCount:totalBlocks,
            blockRemoved:false
          });
        }
      }
      if (options.result) {
        options.result.blockRemovedWorlds = mergeProbabilityStateBranches(
          blockOutcomes.map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            occurs:Boolean(branch.blockRemoved ?? false)
          }))
        );
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
    }
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
    if (!handCountAdjusted) {
      player.handCount = Math.max(0, (player.handCount ?? 0) - amount);
    }
    this.clearCountersWhenHandEmpty(player);
    return amount;
  }

  /*
  功能
  重复应用单张随机移除，得到多张随机弃置后的联合状态。

  调用方
  破坏、掠夺、窃取与守护援助：按期望数量连续执行随机失牌。

  输入
  SearchState、玩家、非负期望数量与可选结果收集器。

  输出
  实际移除的期望总数。

  读取状态
  当前 handCount 与突袭数量分布。

  写入状态
  由单张移除 辅助函数 推进的手牌/响应状态。

  调用函数
  removeOneRandomCardFromHand、syncAssaultSummary。

  边界与不变量
  每轮最多移除一张并使用更新后的手牌作下一轮分母；不越过当前 handCount。
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
      this.removeOneRandomCardFromHand(state, player, spend, {
        result,
        eventWorlds:options.eventWorlds ?? null,
        anonymousOnly:options.anonymousOnly ?? false
      });
      remaining -= spend;
      totalSpent += spend;
    }
    return totalSpent;
  }

  /*
  功能
  从搜索状态构造与真实弃牌策略一致的距离、装备与资源保留上下文。

  调用方
  consumeChosenHandCard：为守护援助的确定弃牌调用正式保留价值策略。

  输入
  SearchState 与待弃牌玩家。

  输出
  新的 stranded、装备定义与装备保留概率上下文。

  读取状态
  存活敌人、攻击距离与玩家公开装备。

  写入状态
  无。

  调用函数
  inAttackRange。

  边界与不变量
  只提供公开距离/装备事实，不在 Simulation 中复制弃牌评分。
  */
  buildDiscardKeepValueContext(state, player) {
    const enemies = state.players.filter((entry) => entry.alive && entry.battleTeam !== player.battleTeam);
    const stranded = enemies.length > 0
      && !enemies.some((enemy) => inAttackRange({ state }, player, enemy));
    return {
      stranded,
      equippedDefinitionId: player.equipmentDefinitionId ?? null,
      equipmentRetentionProbability: player.equipmentRetentionProbability ?? 1
    };
  }

  /*
  功能
  判断聚合手牌是否已被完整且确定的合法身份覆盖。

  调用方
  ResponseSimulation.simulateGuardianAid：判断能否安全使用确定实体弃牌策略。

  输入
  玩家手牌摘要。

  输出
  全部手牌身份确定且数量完全覆盖 handCount 时为 true。

  读取状态
  hand、handCount 与每张牌 availability。

  写入状态
  无。

  调用函数
  cardAvailability。

  边界与不变量
  任何部分可用身份或匿名容量都返回 false，避免按未知 definitionId 选牌。
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

  /*
  功能
  按 ResourceSelectionPolicy 的选择从模拟手牌消费确定实体或未知位置。

  调用方
  ResponseSimulation.simulateGuardianAid：在完整确定手牌中按正式保留策略弃牌。

  输入
  SearchState、玩家、期望弃牌量与可选结果收集器/事件标签。

  输出
  实际消费的期望数量。

  读取状态
  确定 hand、保留价值上下文及各响应/突袭/调息摘要。

  写入状态
  牌 availability、hand/handCount 与 block/counter/assault/recover 摘要。

  调用函数
  buildDiscardKeepValueContext、getDiscardKeepValue、响应容量移除 辅助函数。

  边界与不变量
  每轮只消费当前最低保留值实体；选择与移除共享事件世界，匿名手牌不得进入本路径。
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
        `${options.label ?? "guardian-aid-discard"}:${player.id}:${chosen.id}`
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
  镜像掠夺：从目标资源区移除所选资源并加入行动者手牌表示。

  调用方
  applyCardEffect 的掠夺分支：把策略选中的目标资源转入行动者手牌。

  输入
  SearchState、行动者、目标、效果概率/分支与标签。

  输出
  实际转移的期望质量。

  读取状态
  策略选择、目标装备/手牌身份与响应容量。

  写入状态
  双方装备、hand/knownCards、handCount 与响应/卡牌摘要。

  调用函数
  normalizeResourceEffectWorlds、chooseSimulatedResourceSelection、身份/匿名转移 辅助函数。

  边界与不变量
  来源减少与行动者获得必须共享同一世界；未知手牌只能作为匿名容量转移。
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

  /*
  功能
  镜像破坏：按所选区域和身份从目标状态删除一项资源。

  调用方
  applyCardEffect 的破坏分支：删除策略选中的目标资源。

  输入
  完整 SearchState、行动者、目标、效果概率/分支与标签。

  输出
  实际移除的期望质量。

  读取状态
  策略选择、目标装备/手牌身份与响应容量。

  写入状态
  目标装备、hand/knownCards、handCount 与响应/卡牌摘要。

  调用函数
  normalizeResourceEffectWorlds、chooseSimulatedResourceSelection、确定/匿名消费 辅助函数。

  边界与不变量
  要求完整 state/actor/target 签名；只删除目标资源，不向行动者创建牌身份。
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

  /*
  功能
  在不重复增加 handCount 的前提下，把窃取所得确定或概率身份写入行动者手牌表示。

  调用方
  stealResourceToHand 与匿名窃取身份辅助方法。

  输入
  SearchState、行动者、牌身份与获得条件世界。

  输出
  实际写入身份的概率质量。

  读取状态
  行动者现有 hand 与牌 availability。

  写入状态
  行动者 hand 中新增或合并牌身份条目；不改 handCount 或响应容量。

  调用函数
  projectProbabilityStateBranches、getAvailabilityStateBranches、availableBranchesFromState。

  边界与不变量
  同一实体 ID 只能绑定同一 definitionId；重复获得通过并联合并可用质量，不重复创建条目。
  */
  addStolenIdentityToHand(state, actor, cardIdentity, acquisitionWorlds) {
    if (!actor || !cardIdentity?.definitionId || !Array.isArray(acquisitionWorlds)) return 0;
    const acquired = projectProbabilityStateBranches(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs ?? branch.available)
    }));
    const acquisitionProbability = totalBranchProbability(
      acquired.filter((branch) => branch.available)
    );
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    actor.hand ??= [];
    const identityId = cardIdentity.id ?? this.nextSimulatedCardId(state, cardIdentity.definitionId);
    const existing = actor.hand.find((entry) => entry.id === identityId) ?? null;
    if (existing) {
      if (existing.definitionId !== cardIdentity.definitionId) {
        throw new Error(`addStolenIdentityToHand 同 cardId 不同 definitionId：${identityId}`);
      }
      const oldState = getAvailabilityStateBranches(existing);
      const oldProbability = totalBranchProbability(
        oldState.filter((branch) => branch.available)
      );
      const newState = acquired.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        newAvailable:Boolean(branch.available)
      }));
      const mergedState = projectProbabilityStateBranches(
        joinProbabilityStateBranches(oldState, newState),
        (branch) => ({ available:Boolean(branch.available || branch.newAvailable) })
      );
      existing.availabilityStateBranches = mergedState;
      existing.availabilityBranches = availableBranchesFromState(mergedState);
      return Math.max(0, totalBranchProbability(
        mergedState.filter((branch) => branch.available)
      ) - oldProbability);
    }
    actor.hand.push({
      id:identityId,
      definitionId:cardIdentity.definitionId,
      availabilityBranches:availableBranchesFromState(acquired),
      ...(cardIdentity.identityGroupKey
        ? { identityGroupKey:cardIdentity.identityGroupKey }
        : {})
    });
    return acquisitionProbability;
  }

  /*
  功能
  把窃取未知手牌路径产生的匿名身份概率化写入行动者手牌，并转移对应响应容量。

  调用方
  stealResourceToHand 的未知手牌分支。

  输入
  SearchState、行动者与匿名移除结果（selection/block/counter 身份世界）。

  输出
  行动者新增的匿名手牌期望质量。

  读取状态
  剩余牌计数与匿名移除共享条件世界。

  写入状态
  行动者 hand 身份、handCount、格挡/反制分布和 remainingCardCounts。

  调用函数
  addStolenIdentityToHand、addKnownBlockToDistribution、addKnownCounterToDistribution、remainingCardDensity、syncCardEstimates。

  边界与不变量
  身份世界必须复用来源匿名移除的同一条件分区；格挡与反制互斥，其余定义按合法剩余密度补齐。
  */
  addAnonymousStolenIdentityToHand(state, actor, result) {
    const selection = Array.isArray(result?.selectionPartition)
      ? result.selectionPartition
      : [];
    const selectionPartition = selection.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      stolen:Boolean(branch.anonymousSelected)
    }));
    const stolenMass = totalBranchProbability(
      selectionPartition.filter((branch) => branch.stolen)
    );
    if (stolenMass <= PROBABILITY_EPSILON) return 0;
    const blockPartition = (result.blockRemovedWorlds ?? []).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      blockRemoved:Boolean(branch.occurs)
    }));
    const counterPartition = (result.counterRemovedWorlds ?? []).flatMap((partition) => (
      Array.isArray(partition) ? partition : []
    )).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      counterRemoved:Boolean(branch.occurs)
    }));
    const stolenSlotIdentityKey = `steal-unknown-identity:${actor.id}:${this.nextProbabilityEventKey(
      state,
      `steal-unknown-slot:${actor.id}`
    )}`;
    const stolenSlotKey = `${stolenSlotIdentityKey}:slot`;
    const otherDefinitions = Object.keys(DOMAIN_CARD_DEFINITIONS)
      .filter((definitionId) => !["block", "counter"].includes(definitionId));
    const otherDensity = otherDefinitions.reduce((sum, definitionId) => (
      sum + remainingCardDensity(state?.remainingCardCounts ?? null, definitionId)
    ), 0);
    const joined = joinProbabilityStateBranches(
      selectionPartition,
      blockPartition,
      counterPartition
    );
    // block/counter 与其余定义合并为同一物理槽位的互斥身份分区；
    // 随机移除只需该分区边缘化，响应容量则从选中身份世界精确恢复。
    const identityPartition = mergeProbabilityStateBranches(joined.flatMap((branch) => {
      if (!branch.stolen) {
        return [{
          probability:branch.probability,
          conditions:branch.conditions,
          observedDefinitionId:null
        }];
      }
      if (branch.blockRemoved) {
        return [{
          probability:branch.probability,
          conditions:branch.conditions,
          observedDefinitionId:"block"
        }];
      }
      if (branch.counterRemoved && !branch.blockRemoved) {
        return [{
          probability:branch.probability,
          conditions:branch.conditions,
          observedDefinitionId:"counter"
        }];
      }
      if (otherDensity <= PROBABILITY_EPSILON) {
        return [{
          probability:branch.probability,
          conditions:branch.conditions,
          observedDefinitionId:null
        }];
      }
      return otherDefinitions.map((definitionId) => ({
        probability:branch.probability
          * remainingCardDensity(state?.remainingCardCounts ?? null, definitionId)
          / otherDensity,
        conditions:branch.conditions,
        observedDefinitionId:definitionId
      }));
    }).filter((branch) => branch.probability > PROBABILITY_EPSILON));
    actor.identitySlotStates ??= {};
    actor.identitySlotStates[stolenSlotIdentityKey] = mergeProbabilityStateBranches(
      identityPartition.map((branch) => {
        const conditions = { ...branch.conditions, [stolenSlotKey]:branch.observedDefinitionId ? "yes" : "no" };
        return {
          probability:branch.probability,
          conditions,
          slotAvailable:branch.observedDefinitionId !== null,
          definitionId:branch.observedDefinitionId
        };
      })
    );
    const blockRemovalPartition = mergeProbabilityStateBranches(
      identityPartition.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.observedDefinitionId === "block"
      }))
    );
    const counterRemovalPartition = mergeProbabilityStateBranches(
      identityPartition.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.observedDefinitionId === "counter"
      }))
    );
    for (const definitionId of ["block", "counter", ...otherDefinitions]) {
      const identityWorlds = mergeProbabilityStateBranches(
        identityPartition
          .filter((branch) => branch.observedDefinitionId === definitionId)
          .map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            occurs:true
          }))
      );
      const identityMass = this.eventProbability(identityWorlds);
      if (identityMass <= PROBABILITY_EPSILON) continue;
      this.addStolenIdentityToHand(state, actor, {
        definitionId,
        identityGroupKey:stolenSlotIdentityKey
      }, identityWorlds);
      if (definitionId === "block") {
        this.addKnownBlockToDistribution(state, actor, blockRemovalPartition);
      }
      if (definitionId === "counter") {
        this.addKnownCounterToDistribution(state, actor, counterRemovalPartition);
      }
      if (state.remainingCardCounts && Number.isFinite(state.remainingCardCounts[definitionId])) {
        state.remainingCardCounts[definitionId] = Math.max(0,
          (state.remainingCardCounts[definitionId] ?? 0) - identityMass);
      }
    }
    actor.handCount = (actor.handCount ?? 0) + stolenMass;
    this.syncCardEstimates(actor, state?.remainingCardCounts ?? null);
    return stolenMass;
  }

  /*
  功能
  把窃取技能的统一选择分区投影为指定 outcome 的完整条件世界。

  调用方
  stealResourceToHand。

  输入
  完整选择分区、目标 outcome 与可选确定牌 ID。

  输出
  概率质量为一的 occurs 布尔分区。

  读取状态
  只读选择分区。

  写入状态
  无。

  调用函数
  mergeProbabilityStateBranches。

  边界与不变量
  必须保留未选中世界，否则下游 Probability join 会把不完整分区错误重归一化。
  */
  projectStealOutcome(selectionPartition, outcome, cardId = null) {
    return mergeProbabilityStateBranches(
      selectionPartition.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.outcome === outcome
          && (cardId == null || branch.cardId === cardId)
      }))
    );
  }

  /*
  功能
  镜像窃取技能：把目标手牌与装备合并为单一等概率候选，并将所得身份写入施术者手牌。

  调用方
  SkillEffectSimulation 的窃取技能。

  输入
  SearchState、行动者、目标与执行概率；兼容旧式 (actor, target) 调用。

  输出
  无返回值；目标资源损失和行动者手牌收益已按互斥窃取世界推进。

  读取状态
  目标 handCount/knownCards/装备存在概率、剩余牌密度与随机移除结果。

  写入状态
  双方 hand/knownCards、handCount、目标装备与 block/counter 摘要。

  调用函数
  buildSimulatedKnownCards、transferKnownCardIdentity、consumeRandomHandCards、addAnonymousStolenIdentityToHand、addStolenIdentityToHand、setSimulatedEquipment。

  边界与不变量
  装备、每张确定已知手牌与匿名手牌聚合必须共享同一个互斥选择条件；实际所得身份与来源损失不得由根先验独立重抽。
  */
  stealResourceToHand(state, actor, target, scale = 1) {
    if (!Array.isArray(state?.players)) {
      scale = target ?? 1;
      target = actor;
      actor = state;
      state = { players:[actor, target] };
    }
    const chance = clampProbability(scale);
    const handCount = Math.max(0, Number(target.handCount) || 0);
    const existenceProbability = this.getSimulatedEquipmentProbability(target);
    if ((!handCount && !existenceProbability) || chance <= 0) return;
    const poolSize = handCount + existenceProbability;
    const equipmentLossProbability = existenceProbability / poolSize * chance;
    const { knownCards, unknownCount } = this.buildSimulatedKnownCards(target);
    const knownLoss = knownCards.length / poolSize * chance;
    const unknownLoss = Math.max(0, unknownCount) / poolSize * chance;
    const selectionKey = this.nextProbabilityEventKey(state, `steal-resource:${actor.id}:${target.id}`);
    const outcomeBranches = [];
    if (equipmentLossProbability > PROBABILITY_EPSILON && target.equipmentDefinitionId) {
      outcomeBranches.push({
        probability:equipmentLossProbability,
        conditions:{ [selectionKey]:"equipment" },
        outcome:"equipment"
      });
    }
    for (const card of knownCards) {
      outcomeBranches.push({
        probability:chance / poolSize,
        conditions:{ [selectionKey]:`known:${card.cardId}` },
        outcome:"known",
        cardId:card.cardId,
        definitionId:card.definitionId
      });
    }
    if (unknownLoss > PROBABILITY_EPSILON) {
      outcomeBranches.push({
        probability:unknownLoss,
        conditions:{ [selectionKey]:"unknown" },
        outcome:"unknown"
      });
    }
    outcomeBranches.push({
      probability:Math.max(0, 1 - chance),
      conditions:{ [selectionKey]:"none" },
      outcome:"none"
    });
    const selectionPartition = mergeProbabilityStateBranches(outcomeBranches);
    if (equipmentLossProbability > PROBABILITY_EPSILON && target.equipmentDefinitionId) {
      const stolenEquipmentDefinitionId = target.equipmentDefinitionId;
      const equipmentWorlds = this.projectStealOutcome(selectionPartition, "equipment");
      const equipmentMass = this.eventProbability(equipmentWorlds);
      if (equipmentMass > PROBABILITY_EPSILON) {
        this.setSimulatedEquipment(
          target,
          stolenEquipmentDefinitionId,
          existenceProbability - equipmentLossProbability
        );
        this.addStolenIdentityToHand(state, actor, {
          definitionId:stolenEquipmentDefinitionId
        }, equipmentWorlds);
        actor.handCount = (actor.handCount ?? 0) + equipmentMass;
      }
    }
    for (const known of knownCards) {
      const knownWorlds = this.projectStealOutcome(selectionPartition, "known", known.cardId);
      if (this.eventProbability(knownWorlds) <= PROBABILITY_EPSILON) continue;
      this.transferKnownCardIdentity(
        state,
        target,
        actor,
        { cardId:known.cardId, definitionId:known.definitionId },
        knownWorlds,
        true,
        null
      );
    }
    if (unknownLoss > PROBABILITY_EPSILON) {
      const unknownWorlds = this.projectStealOutcome(selectionPartition, "unknown");
      const result = { counterRemovedWorlds: [] };
      this.consumeRandomHandCards(state, target, unknownLoss, {
        result,
        eventWorlds:unknownWorlds,
        anonymousOnly:true
      });
      this.addAnonymousStolenIdentityToHand(state, actor, result);
    }
    this.syncCardEstimates(target, state?.remainingCardCounts ?? null);
    this.syncCardEstimates(actor, state?.remainingCardCounts ?? null);
  }
};
