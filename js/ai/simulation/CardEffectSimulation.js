/*
模块职责
镜像卡牌效果、装备与手牌资源身份在 World 中的变化。

上游
Simulator 正式模拟门面、CombatSimulation 与 SkillEffectSimulation。

下游
Response/Combat/Status 组件、Domain CardRules、正式资源 Policy 与 Probability。

状态边界
只修改 Simulator 门面提供的独立 World 副本。

信息边界
未知手牌只按位置、数量与概率身份处理，不读取真实 definitionId。

架构约束
不生成动作、不搜索、不拥有规则合法性或最终价值公式。
*/
import { CARD_DEFINITIONS as DOMAIN_CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import {
  findPlayerFact,
  getCardTargetIds
} from "../../domain/rules/card/CardRules.js";
import { hasPassiveSkill, projectRulePlayers } from "../state/RuleProjection.js";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  expectedBranchValue,
  getAvailabilityStateBranches,
  mutateProbability,
  probabilityEventPartition,
  queryAnonymousSlotDistribution,
  queryPlayerHandProbability,
  totalBranchProbability
} from "../state/Probability.js";
import {
  getRangeConditionBranches,
  inAttackRange
} from "../state/DistanceProbabilityBranches.js";
import { getLightningStatusStateBranches } from "../domain/LightningModel.js";
import { getSealStatusStateBranches } from "../domain/SealModel.js";
import { getDiscardKeepValue } from "../policy/ResourceSelectionPolicy.js";

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
  在当前 transition 调用栈内解析卡牌身份、距离与延迟状态条件。

  调用方
  Simulator.apply 的卡牌分派。

  输入
  独立 World、行动者、canonical Action、正式卡牌定义与当前手牌身份。

  输出
  本次卡牌实际发生/不发生的有界局部分区。

  读取状态
  当前牌 availability、目标、距离装备概率与闪电/封印存在概率。

  写入状态
  无；返回分区只存在于本次 apply 调用栈。

  调用函数
  getAvailabilityStateBranches、getRangeConditionBranches、Lightning/Seal 状态查询与概率运行时。

  边界与不变量
  transfer 最多枚举三项距离装备变量，其余动作最多两项；当前规则下输出上界为八个条件世界，
  不写 Action、World 或第二种状态表示。root 配对反事实没有当前手牌实体，但由真实语义标记确认成本已沉没。
  */
  buildCardExecutionWorlds(state, actor, action, card, heldCard) {
    const targets = (action.targetIds ?? [])
      .map((id) => state.players.find((player) => player.id === id))
      .filter(Boolean);
    let conditionBranches = [{ probability:1, conditions:{}, matches:true }];
    if (card.definitionId === "lightning") {
      conditionBranches = getLightningStatusStateBranches(actor).map((branch) => ({
        ...branch,
        matches:!branch.present
      }));
    } else if (card.definitionId === "seal") {
      conditionBranches = getSealStatusStateBranches(targets[0]).map((branch) => ({
        ...branch,
        matches:!branch.present
      }));
    } else if (card.definitionId === "transfer") {
      const source = state.players.find((player) => player.id === action.selection?.sourceId);
      const receiver = state.players.find((player) => player.id === action.selection?.receiverId);
      conditionBranches = getRangeConditionBranches({ state }, [
        { source:actor, target:source, range:card.effectRange },
        { source:actor, target:receiver, range:card.effectRange }
      ]);
    } else if (card.definitionId === "leverage") {
      const first = state.players.find((player) => player.id === action.selection?.firstTargetId);
      const second = state.players.find((player) => player.id === action.selection?.secondTargetId);
      conditionBranches = getRangeConditionBranches({ state }, {
        source:first,
        target:second,
        range:first?.attackRange ?? 1
      }, {
        equipmentRequirements:[{
          player:first,
          definitionId:action.selection?.equipmentDefinitionId,
          present:true
        }]
      });
    } else if (card.definitionId === "assault" && targets[0]) {
      conditionBranches = getRangeConditionBranches({ state }, {
        source:actor,
        target:targets[0],
        range:actor.attackRange ?? 1
      });
    } else if (!card.ignoresDistance && card.effectRange != null && targets[0]) {
      conditionBranches = getRangeConditionBranches({ state }, {
        source:actor,
        target:targets[0],
        range:card.effectRange
      });
    }
    const cardAvailability = action.execution?.restoreActorHand && !heldCard
      ? [{ probability:1, conditions:{}, available:true }]
      : getAvailabilityStateBranches(
          heldCard,
          heldCard ? heldCard.availability ?? 1 : 0
        );
    const joined = this.intersectProbabilityWork(
      [conditionBranches, cardAvailability],
      "CardEffectSimulation.buildCardExecutionWorlds:conditions"
    );
    return this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(branch.matches && branch.available)
    }), "CardEffectSimulation.buildCardExecutionWorlds:execution");
  }

  /*
  功能
  执行一张已完成动作支付与 card-scope 响应门控的卡牌效果。

  调用方
  Simulator.apply 唯一动作分派入口。

  输入
  独立 World、行动者、抽象动作，以及 Simulator 门面计算出的共享事件世界、
  响应前状态和目标摘要。

  输出
  同一独立 World。

  读取状态
  卡牌定义、目标、效果世界与组件共享资源摘要。

  写入状态
  仅输入 World 的卡牌效果、资源和触发摘要。

  调用函数
  CombatSimulation、ResponseSimulation、Skill/Status 后置钩子与资源辅助函数。

  边界与不变量
  不重新计算动作支付或 card-scope 响应；响应前摘要只供窥探 option value 读取，
  不能作为结算目标；switch 顺序与既有后置触发顺序保持不变。
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
        this.recordSimulatedPrivatePeek(
          next,
          actor,
          target,
          DOMAIN_CARD_DEFINITIONS.scout.maxRevealCount,
          effectEventWorlds
        );
        coordinationProbability = scale;
        coordinationTargets = [target];
        break;
      }
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          damageContext:cardDamageContext
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDecision(next, player, actor, card, [player])
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
            this.counterDecision(next, player, actor, card, [player])
          );
          const targetWorlds = counterResponse.effectPassWorlds;
          const response = queryPlayerHandProbability(
            next.probabilityState, player, "assault"
          ).probability;
          const eventProbability = this.eventProbability(targetWorlds);
          const spent = Math.min(eventProbability, response);
          const knownBefore = (Array.isArray(player.hand) ? player.hand : [])
            .filter((entry) => entry.definitionId === "assault")
            .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
          this.consumeKnownCardsFromHand(next, player, "assault", spent);
          const knownAfter = (Array.isArray(player.hand) ? player.hand : [])
            .filter((entry) => entry.definitionId === "assault")
            .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
          const anonymousSpent = Math.max(0, spent - (knownBefore - knownAfter));
          if (anonymousSpent > PROBABILITY_EPSILON) mutateProbability(next.probabilityState, {
            type:"REMOVE",
            sourceBucketId:player.id,
            definitionId:"assault",
            probability:anonymousSpent
          });
          player.handCount = Math.max(0, player.handCount - spent);
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
          ?? next.players.find((player) => player.id === abstractAction.targetIds?.[0]);
        const second = next.players.find((player) => player.id === abstractAction.selection?.secondTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targetIds?.[1]);
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
        const firstAssault = queryPlayerHandProbability(
          next.probabilityState, first, "assault"
        );
        const assaultAvailable = canActuallyTargetWithAssault
          ? firstAssault.probability
          : 0;
        const willingToAssault = this.decideLeverageAssault(next, first, second);
        const existenceProbability = this.getSimulatedEquipmentProbability(first);
        const desiredUseWorlds = this.gateEventWorlds(next, effectEventWorlds,
          assaultAvailable * (willingToAssault ? 1 : 0),
          `leverage-assault:${card.id}:${first.id}`);
        const actualUseWorlds = desiredUseWorlds;
        const effectiveUseProbability = this.eventProbability(actualUseWorlds);
        first.attackUsed = (first.attackUsed ?? 0) + effectiveUseProbability;
        const effectiveDeclineProbability = Math.min(existenceProbability, Math.max(0, scale - effectiveUseProbability));
        const assaultOpportunity = assaultAvailable > PROBABILITY_EPSILON
          ? Math.min(1, effectiveUseProbability / assaultAvailable)
          : 0;
        const assaultSpent = Math.min(
          assaultOpportunity,
          firstAssault.probability
        );
        const knownBefore = (Array.isArray(first.hand) ? first.hand : [])
          .filter((entry) => entry.definitionId === "assault")
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        this.consumeKnownCardsFromHand(next, first, "assault", assaultSpent);
        const knownAfter = (Array.isArray(first.hand) ? first.hand : [])
          .filter((entry) => entry.definitionId === "assault")
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        const anonymousSpent = Math.max(0, assaultSpent - (knownBefore - knownAfter));
        if (anonymousSpent > PROBABILITY_EPSILON) mutateProbability(next.probabilityState, {
          type:"REMOVE",
          sourceBucketId:first.id,
          definitionId:"assault",
          probability:anonymousSpent
        });
        first.handCount = Math.max(0, first.handCount - assaultSpent);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, actualUseWorlds, {
          sourceEquipmentConditional:true,
          attackUseConsumed:true,
          damageContext:cardDamageContext
        });
        actor.handCount += effectiveDeclineProbability;
        this.setSimulatedEquipment(first, first.equipmentDefinitionId, existenceProbability - effectiveDeclineProbability);
        coordinationProbability = scale;
        coordinationTargets = [first, second];
        break;
      }
      case "plunder": {
        const plundered = target
          ? this.takeResourceToHand(
              next,
              actor,
              target,
              effectEventWorlds,
              `plunder:${card.id ?? card.definitionId}`,
              abstractAction.selection
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
        coordinationTargets = (abstractAction.targetIds ?? [])
          .map((id) => next.players.find((player) => player.id === id))
          .filter(Boolean);
        break;
      case "destroy": {
        const destroyed = target
          ? this.destroyResource(
              next,
              actor,
              target,
              effectEventWorlds,
              `destroy:${card.id ?? card.definitionId}`,
              abstractAction.selection
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
        const perRecipientDrawCount = DOMAIN_CARD_DEFINITIONS.mutualBenefit.perRecipientDrawCount;
        for (const player of coordinationTargets) {
          this.gainUnknownCardsWithCounterState(
            next, player, perRecipientDrawCount, effectEventWorlds, "mutual-benefit-draw"
          );
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
读取一张抽象牌当前剩余可用概率。

  调用方
  Simulation、CardValue 与资源选择：读取一张已过滤卡牌仍可消费的概率。

输入
带当前 availability 标量或确定可用身份的卡牌摘要。

输出
卡牌当前可用概率；缺失标量时为一。

  读取状态
  只读卡牌 availability 状态。

  写入状态
  无。

调用函数
clampProbability。

边界与不变量
只读当前值，不创建或保存 availability branch hierarchy。
  */
  cardAvailability(card) {
    return clampProbability(card?.availability ?? 1);
  }







  /*
  功能
  将资源效果的标量概率或既有条件世界规范成同一 occurs 分区。

  调用方
  takeResourceToHand 与 destroyResource：把资源效果的执行尺度交给统一事件世界。

  输入
  World、概率标量或已有事件分支、条件标签。

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
  World 与正式卡牌定义 ID。

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
  World、拥有 hand 数组的玩家、牌身份与获得事件世界。

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
    const acquired = this.projectProbabilityWork(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs)
    }), "CardEffectSimulation.addSimulatedCardToHand:acquired");
    const acquisitionProbability = totalBranchProbability(acquired.filter((branch) => branch.available));
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    const id = cardIdentity.id ?? this.nextSimulatedCardId(state, cardIdentity.definitionId);
    player.hand ??= [];
    player.hand.push({
      id,
      definitionId: cardIdentity.definitionId,
      availability:acquisitionProbability
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
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
  只访问来源允许的表示；若测试或迁移态同时含 hand/knownCards，先按 cardId 检查 hand，
  未命中时只回退合法 knownCards，且不得读取无关隐藏实体定义。
  */
  findTransferCardEntry(source, cardId, definitionId) {
    if (!cardId || !definitionId) return null;
    if (Array.isArray(source?.hand)) {
      const sameId = source.hand.find((card) => card?.id === cardId) ?? null;
      if (sameId) return sameId.definitionId === definitionId ? sameId : null;
    }
    return this.findKnownCardEntry(source, cardId, definitionId);
  }

  /*
  功能
  只向其他玩家的合法 knownCards 表示写入新获得的确定身份。

  调用方
  转移、雷达与非观察者摸牌：向合法 knownCards 表示加入确定身份。

  输入
  World、目标玩家、cardId/definitionId 与获得世界。

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
    const acquired = this.projectProbabilityWork(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs)
    }), "CardEffectSimulation.addSimulatedKnownCard:acquired");
    const acquisitionProbability = totalBranchProbability(acquired.filter((branch) => branch.available));
    if (acquisitionProbability <= PROBABILITY_EPSILON) return 0;
    const sameCardId = (player.knownCards ?? []).find((entry) => entry?.cardId === identity.cardId) ?? null;
    if (sameCardId && sameCardId.definitionId !== identity.definitionId) {
      throw new Error(`addSimulatedKnownCard 同 cardId 不同 definitionId：${identity.cardId}`);
    }
    const existing = sameCardId;
    if (existing) {
      if (existing.definitionId !== identity.definitionId) {
        throw new Error(`addSimulatedKnownCard 同 cardId 不同 definitionId：${identity.cardId}`);
      }
      const oldState = getAvailabilityStateBranches(
        existing,
        1
      );
      const oldProbability = this.cardAvailability(existing);
      const newState = this.projectProbabilityWork(acquisitionWorlds, (branch) => ({
        newAvailable:Boolean(branch.occurs)
      }), "CardEffectSimulation.addSimulatedKnownCard:new");
      const merged = this.intersectProbabilityWork(
        [oldState, newState],
        "CardEffectSimulation.addSimulatedKnownCard:join"
      );
      const mergedState = this.projectProbabilityWork(merged, (branch) => ({
        available:Boolean(branch.available || branch.newAvailable)
      }), "CardEffectSimulation.addSimulatedKnownCard:merged");
      existing.availability = totalBranchProbability(
        mergedState.filter((branch) => branch.available)
      );
      const addedProbability = Math.max(0, existing.availability - oldProbability);
      if (addedProbability > PROBABILITY_EPSILON) {
        player.handCount = (player.handCount ?? 0) + addedProbability;
      }
      return addedProbability;
    }
    player.knownCards ??= [];
    player.knownCards.push({
      cardId:identity.cardId,
      definitionId:identity.definitionId,
      availability:acquisitionProbability
    });
    player.handCount = (player.handCount ?? 0) + acquisitionProbability;
    return acquisitionProbability;
  }

  /*
  功能
  用同一联合条件世界从来源移除并向接收者增加确定牌身份。

  调用方
  CardEffectSimulation 的转移牌结算：在同一世界搬运一张确定身份。

  输入
  World、来源/接收者、牌身份、效果世界、接收者可见性与排除集合。

  输出
  实际转移概率。

  读取状态
  来源实体 availability、双方手牌/响应摘要。

  写入状态
  来源 availability/handCount 与接收者 hand 或 knownCards、响应容量。

  调用函数
  findTransferCardEntry、addSimulatedCardToHand/addSimulatedKnownCard、响应容量移除 辅助函数。

  边界与不变量
  来源移除和接收者增加必须共享同一条件世界；实体 ID 在任一世界只能归一个持有者；
  exact identity 缺失或不可用时不得降级为匿名转移。
  */
  transferKnownCardIdentity(state, source, receiver, identity, effectWorlds, receiverIsActor, excludedCardIds = null) {
    const entry = (!excludedCardIds?.has(identity.cardId))
      ? this.findTransferCardEntry(source, identity.cardId, identity.definitionId)
      : null;
    if (!entry || this.cardAvailability(entry) <= PROBABILITY_EPSILON) return 0;
    const availabilityState = getAvailabilityStateBranches(
      entry,
      1
    );
    const joined = this.intersectProbabilityWork(
      [effectWorlds, availabilityState],
      "CardEffectSimulation.transferKnownCardIdentity:join"
    );
    const remainingState = this.projectProbabilityWork(joined, (branch) => ({
      available:Boolean(branch.available && !branch.occurs)
    }), "CardEffectSimulation.transferKnownCardIdentity:remaining");
    const acquisitionWorlds = this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(branch.available && branch.occurs)
    }), "CardEffectSimulation.transferKnownCardIdentity:acquired");
    const transferProbability = this.eventProbability(acquisitionWorlds);
    if (transferProbability <= PROBABILITY_EPSILON) return 0;
    const remainingProbability = totalBranchProbability(
      remainingState.filter((branch) => branch.available)
    );
    entry.availability = remainingProbability;
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
  World、来源/接收者、效果世界与来源可用未知数量。

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
    const transferred = Math.min(
      this.eventProbability(effectWorlds),
      Math.max(0, Number(availableUnknownCount) || 0),
      Math.max(0, Number(source?.handCount) || 0)
    );
    if (transferred <= PROBABILITY_EPSILON) return 0;
    const whole = Math.floor(transferred);
    if (whole > 0) mutateProbability(state.probabilityState, {
      type:"MOVE",
      sourceBucketId:source.id,
      targetBucketId:receiver.id,
      count:whole
    });
    if (transferred - whole > PROBABILITY_EPSILON) mutateProbability(state.probabilityState, {
      type:"MOVE",
      sourceBucketId:source.id,
      targetBucketId:receiver.id,
      probability:transferred - whole
    });
    source.handCount = Math.max(0, (source.handCount ?? 0) - transferred);
    receiver.handCount = (receiver.handCount ?? 0) + transferred;
    return transferred;
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
  knownCards 只能来自自己 hand 或合法记忆；全部 known availability 必须先占用手牌容量，
  不一致状态 fail closed，部分已知身份保留 exact candidate 且不得重新进入 unknown pool。
  */
  buildSimulatedKnownCards(target) {
    const knownCards = Array.isArray(target.knownCards) ? target.knownCards : [];
    const handCount = Math.max(0, Number(target.handCount) || 0);
    const availableKnown = knownCards.filter(
      (entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON
    );
    const knownOccupancy = knownCards.reduce(
      (sum, entry) => sum + this.cardAvailability(entry), 0
    );
    if (knownOccupancy > handCount + PROBABILITY_EPSILON) {
      return { knownCards: [], unknownCount: 0 };
    }
    return { knownCards: availableKnown, unknownCount: Math.max(0, handCount - knownOccupancy) };
  }

  /*
  功能
  对一个已明确指定的资源候选执行 Destroy removal 或 Plunder ownership transfer。

  调用方
  ResourceValueQuery：为每个候选生成不会递归选择的 after-state。

  输入
  独立 World、其中的 actor/target、purpose 与确定候选描述。

  输出
  实际移除或转移的概率质量。

  读取状态
  候选公开/known/anonymous 身份与目标当前资源状态。

  写入状态
  只写传入的独立 World。

  调用函数
  takeResourceToHand、destroyResource 的 forcedSelection 入口。

  边界与不变量
  必须提供候选；本入口绝不调用 chooseSimulatedResourceSelection，known 缺失时不得退化为匿名随机消费。
  */
  applyForcedResourceSelection(state, actor, target, purpose, selection) {
    if (!selection || !actor || !target) return 0;
    if (purpose === "plunder") {
      return this.takeResourceToHand(
        state, actor, target, 1, "resource-counterfactual-plunder", selection
      );
    }
    if (purpose === "destroy") {
      return this.destroyResource(
        state, actor, target, 1, "resource-counterfactual-destroy", selection
      );
    }
    throw new Error(`applyForcedResourceSelection 非法 purpose：${String(purpose)}`);
  }

  /*
  功能
  按共享效果世界从自己的模拟手牌消费指定已知牌身份。

  调用方
  对决、格挡/反制与救援资源消耗：按期望量扣减自己的确定手牌。

  输入
  World、拥有 hand 的玩家、definitionId 与非负期望消耗量。

  输出
  无返回值；匹配牌的可用世界已按顺序消费。

读取状态
匹配实体的当前 availability。

写入状态
牌 availability 标量，并在质量归零时移出 hand。

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
      const availabilityState = getAvailabilityStateBranches(
        card,
        1
      );
      const availableProbability = totalBranchProbability(
        availabilityState.filter((branch) => branch.available)
      );
      if (availableProbability <= PROBABILITY_EPSILON) continue;
      const spendProbability = Math.min(availableProbability, remaining);
      const spendWorlds = this.getEventWorlds(state, spendProbability / availableProbability, null,
        `response-card:${player.id}:${card.id}`);
      const joined = this.intersectProbabilityWork(
        [availabilityState, spendWorlds],
        "CardEffectSimulation.consumeKnownCardsFromHand:join"
      );
      const remainingState = this.projectProbabilityWork(joined, (branch) => ({
        available:Boolean(branch.available && !branch.occurs)
      }), "CardEffectSimulation.consumeKnownCardsFromHand:remaining");
      card.availability = totalBranchProbability(
        remainingState.filter((branch) => branch.available)
      );
      if (card.availability <= PROBABILITY_EPSILON) {
        player.hand = player.hand.filter((entry) => entry.id !== card.id);
      }
      remaining -= spendProbability;
    }
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
    }
    return changed;
  }

  /*
  功能
  从未知聚合容量中消费一张资源牌，并同步各类响应数量分布。

  调用方
  destroyResource 与匿名资源消费：从聚合未知手牌中扣减一次资源。

  输入
  World、玩家、期望消耗、可用匿名容量与可选事件世界。

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
    const whole = Math.floor(spent);
    if (whole > 0) mutateProbability(state.probabilityState, {
      type:"REMOVE",
      sourceBucketId:player.id,
      count:whole
    });
    if (spent - whole > PROBABILITY_EPSILON) mutateProbability(state.probabilityState, {
      type:"REMOVE",
      sourceBucketId:player.id,
      probability:spent - whole
    });
    player.handCount = Math.max(0, (player.handCount ?? 0) - spent);
    this.downgradePartialKnownCardsAfterRandomLoss(player);
    return spent;
  }

  /*
  功能
  按当前已知/未知身份概率移除一张随机手牌并返回效果世界。

  调用方
  consumeRandomHandCards 与 guardian aid 弃牌路径：镜像一次随机失牌。

  输入
  World、玩家、零到一的移除质量与可选结果收集器。

  输出
  实际移除的期望数量。

  读取状态
  确定身份 availability、匿名容量、block/counter 分布与 handCount。

  写入状态
  牌/匿名 availability、响应数量分布、handCount 与可选结果世界。

  调用函数
  queryAnonymousSlotDistribution、Probability 连接/投影/合并、mutateProbability 与 SearchBudget checkpoint。

  边界与不变量
  W 个触发/匿名数量世界与 H 个当前身份直接生成至多 W×(H+1) 个选择结果，
  时间和空间上界 O(W·H)，不得枚举 2^H 个 identity presence 组合；同一张牌最多移除一次，
  中断时整个未完成局部选择更新随当前 candidate 作废；结果不得成为持久身份历史。
  */
  removeOneRandomCardFromHand(state, player, spend, options = {}) {
    this.checkpointSearchWork();
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
    const candidates = options.anonymousOnly
      ? []
      : [
          ...(Array.isArray(player.hand) ? player.hand
            .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON)
            .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:card.definitionId })) : []),
          ...(Array.isArray(player.knownCards) ? player.knownCards
            .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON)
            .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:entry.definitionId })) : [])
        ];
    if (!candidates.length && expectedUnknown <= PROBABILITY_EPSILON) return 0;

    const anonymousState = queryAnonymousSlotDistribution(
      state.probabilityState,
      player.id
    ).map((branch) => ({
      probability:branch.probability,
      conditions:{},
      anonymousCount:branch.count
    }));

    const removalWorlds = Array.isArray(options.eventWorlds) && options.eventWorlds.length
      ? this.gateEventWorlds(
          state,
          options.eventWorlds,
          eventMass > PROBABILITY_EPSILON ? amount / eventMass : 0,
          "random-hand-removal"
        )
      : probabilityEventPartition(
          this.currentProbabilityEventKey(state, "random-hand-removal"),
          Math.min(1, amount),
          "occurs"
        );
    const anonymousPartition = anonymousState.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      anonymousCount:Math.max(0, Number(branch.anonymousCount) || 0)
    }));
    const joined = this.intersectProbabilityWork([
      removalWorlds,
      anonymousPartition
    ], "CardEffectSimulation.removeOneRandomCardFromHand:candidate-worlds");
    const selectionKey = this.currentProbabilityEventKey(state, "random-hand-selection");
    const outcomes = [];
    for (let branchIndex = 0; branchIndex < joined.length; branchIndex += 1) {
      if (branchIndex % 32 === 0) this.checkpointSearchWork();
      const branch = joined[branchIndex];
      const occurs = Boolean(branch.occurs);
      const knownWeights = candidates.map((candidate) => this.cardAvailability(candidate.card));
      const knownCount = knownWeights.reduce((sum, weight) => sum + weight, 0);
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
        if (knownWeights[index] > PROBABILITY_EPSILON) {
          outcomes.push({
            probability:branch.probability * (knownWeights[index] / total),
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

    const selectionPartition = this.mergeProbabilityWork(outcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      this.checkpointSearchWork();
      const candidate = candidates[index];
      const selectedProbability = totalBranchProbability(
        selectionPartition.filter((branch) => branch.selectedIndex === index)
      );
      candidate.card.availability = Math.max(
        0,
        this.cardAvailability(candidate.card) - selectedProbability
      );
      if (candidate.card.availability <= PROBABILITY_EPSILON) {
        if (Array.isArray(player.hand)) player.hand = player.hand.filter((card) => card !== candidate.card);
        if (Array.isArray(player.knownCards)) player.knownCards = player.knownCards.filter((entry) => entry !== candidate.card);
      }
    }

    const anonymousRemoved = totalBranchProbability(
      selectionPartition.filter((branch) => branch.anonymousSelected)
    );
    if (anonymousRemoved > PROBABILITY_EPSILON) mutateProbability(state.probabilityState, {
      type:options.anonymousTargetBucketId ? "MOVE" : "REMOVE",
      sourceBucketId:player.id,
      ...(options.anonymousTargetBucketId
        ? { targetBucketId:options.anonymousTargetBucketId }
        : {}),
      probability:anonymousRemoved
    });
    if (Array.isArray(player.hand)) {
      player.hand = player.hand.filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON);
    }
    if (Array.isArray(player.knownCards)) {
      player.knownCards = player.knownCards.filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON);
    }
    player.handCount = Math.max(0, (player.handCount ?? 0) - amount);
    return amount;
  }

  /*
  功能
  重复应用单张随机移除，得到多张随机弃置后的联合状态。

  调用方
  破坏、掠夺、窃取与守护援助：按期望数量连续执行随机失牌。

  输入
  World、玩家、非负期望数量与可选结果收集器。

  输出
  实际移除的期望总数。

  读取状态
  当前 handCount 与突袭数量分布。

  写入状态
  由单张移除 辅助函数 推进的手牌/响应状态。

  调用函数
  removeOneRandomCardFromHand、SearchBudget checkpoint。

  边界与不变量
  每轮最多移除一张并使用更新后的手牌作下一轮分母；不越过当前 handCount；
  中断时不返回 partial 资源结果。
  */
  consumeRandomHandCards(state, player, expectedAmount, options = {}) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    let totalSpent = 0;
    const result = options.result ?? null;
    while (remaining > PROBABILITY_EPSILON && (player.handCount ?? 0) > PROBABILITY_EPSILON) {
      this.checkpointSearchWork();
      const spend = Math.min(1, remaining, Math.max(0, Number(player.handCount) || 0));
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
  World 与待弃牌玩家。

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
  World、玩家、期望弃牌量与可选结果收集器/事件标签。

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
      const availabilityState = getAvailabilityStateBranches(
        chosen,
        1
      ).map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        available: Boolean(branch.available)
      }));
      const joinedAvailability = this.intersectProbabilityWork(
        [availabilityState, removalPartition],
        "CardEffectSimulation.consumeChosenHandCard:join"
      );
      const remainingState = this.projectProbabilityWork(joinedAvailability, (branch) => ({
        available: Boolean(branch.available && !branch.removed)
      }), "CardEffectSimulation.consumeChosenHandCard:remaining");
      chosen.availability = totalBranchProbability(
        remainingState.filter((branch) => branch.available)
      );
      if (Array.isArray(player.hand)) {
        player.hand = player.hand.filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON);
      }
      player.handCount = Math.max(0, (player.handCount ?? 0) - spent);
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
  World、行动者、目标、效果概率/分支、标签与可选强制候选。

  输出
  实际转移的期望质量。

  读取状态
  策略选择、目标装备/手牌身份与响应容量。

  写入状态
  双方装备、hand/knownCards、handCount 与响应/卡牌摘要。

  调用函数
  normalizeResourceEffectWorlds、可选 chooseSimulatedResourceSelection、transferKnownCardIdentity 与匿名转移 辅助函数。

  边界与不变量
  来源减少与行动者获得必须共享同一世界；未知手牌只能作为匿名容量转移；强制 known 缺失时不得随机替换。
  */
  takeResourceToHand(
    state,
    actor,
    target,
    resolution = 1,
    label = "plunder-resource",
    selection = null
  ) {
    const effectWorlds = this.normalizeResourceEffectWorlds(state, resolution, label);
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
      return this.transferKnownCardIdentity(
        state,
        target,
        actor,
        { cardId:selection.cardId, definitionId:selection.definitionId },
        effectWorlds,
        true,
        null
      );
    } else if (selection.zone === "hand") {
      return this.transferUnknownCardIdentity(
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
  完整 World、行动者、目标、效果概率/分支、标签与可选强制候选。

  输出
  实际移除的期望质量。

  读取状态
  策略选择、目标装备/手牌身份与响应容量。

  写入状态
  目标装备、hand/knownCards、handCount 与响应/卡牌摘要。

  调用函数
  normalizeResourceEffectWorlds、可选 chooseSimulatedResourceSelection、确定/匿名消费 辅助函数。

  边界与不变量
  要求完整 state/actor/target 签名；只删除目标资源，不向行动者创建牌身份；强制 known 缺失时不得随机替换。
  */
  destroyResource(
    state,
    actor,
    target,
    resolution = 1,
    label = "destroy-resource",
    selection = null
  ) {
    if (!Array.isArray(state?.players)) {
      throw new Error("destroyResource 需要 state、actor、target、scale 完整签名");
    }
    const effectWorlds = this.normalizeResourceEffectWorlds(state, resolution, label);
    if (!selection) return 0;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const removalProbability = existenceProbability * this.eventProbability(effectWorlds);
      this.setSimulatedEquipment(target, target.equipmentDefinitionId,
        existenceProbability * (1 - this.eventProbability(effectWorlds)));
      return removalProbability;
    } else if (selection.zone === "hand" && selection.selectionKind === "known") {
      const entry = this.findKnownCardEntry(target, selection.cardId, selection.definitionId);
      if (entry && this.cardAvailability(entry) > PROBABILITY_EPSILON) {
        const availabilityState = getAvailabilityStateBranches(
          entry,
          1
        );
        const joined = this.intersectProbabilityWork(
          [effectWorlds, availabilityState],
          "CardEffectSimulation.destroyResource:join"
        );
        const removalWorlds = this.projectProbabilityWork(joined, (branch) => ({
          occurs:Boolean(branch.available && branch.occurs)
        }), "CardEffectSimulation.destroyResource:removal");
        const removalProbability = this.eventProbability(removalWorlds);
        if (removalProbability <= PROBABILITY_EPSILON) return 0;
        const remainingState = this.projectProbabilityWork(joined, (branch) => ({
          available:Boolean(branch.available && !branch.occurs)
        }), "CardEffectSimulation.destroyResource:remaining");
        entry.availability = totalBranchProbability(
          remainingState.filter((branch) => branch.available)
        );
        if (entry.availability <= PROBABILITY_EPSILON) {
          target.knownCards = target.knownCards.filter((item) => item !== entry);
        }
        target.handCount = Math.max(0, (target.handCount ?? 0) - removalProbability);
        return removalProbability;
      }
      return 0;
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
  World、行动者、牌身份与获得条件世界。

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
    const acquired = this.projectProbabilityWork(acquisitionWorlds, (branch) => ({
      available:Boolean(branch.occurs ?? branch.available)
    }), "CardEffectSimulation.addStolenIdentityToHand:acquired");
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
      const oldState = getAvailabilityStateBranches(
        existing,
        1
      );
      const oldProbability = totalBranchProbability(
        oldState.filter((branch) => branch.available)
      );
      const newState = acquired.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        newAvailable:Boolean(branch.available)
      }));
      const joined = this.intersectProbabilityWork(
        [oldState, newState],
        "CardEffectSimulation.addStolenIdentityToHand:join"
      );
      const mergedState = this.projectProbabilityWork(
        joined,
        (branch) => ({ available:Boolean(branch.available || branch.newAvailable) }),
        "CardEffectSimulation.addStolenIdentityToHand:merged"
      );
      existing.availability = totalBranchProbability(
        mergedState.filter((branch) => branch.available)
      );
      return Math.max(0, existing.availability - oldProbability);
    }
    actor.hand.push({
      id:identityId,
      definitionId:cardIdentity.definitionId,
      availability:acquisitionProbability
    });
    return acquisitionProbability;
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
    return this.projectProbabilityWork(
      selectionPartition,
      (branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        occurs:branch.outcome === outcome
          && (cardId == null || branch.cardId === cardId)
      }),
      "CardEffectSimulation.projectStealOutcome"
    );
  }

  /*
  功能
  镜像窃取技能：把目标手牌与装备合并为单一等概率候选，并将所得身份写入施术者手牌。

  调用方
  SkillEffectSimulation 的窃取技能。

  输入
  World、行动者、目标与执行概率。

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
    const chance = clampProbability(scale);
    const handCount = Math.max(0, Number(target.handCount) || 0);
    const existenceProbability = this.getSimulatedEquipmentProbability(target);
    if ((!handCount && !existenceProbability) || chance <= 0) return;
    const poolSize = handCount + existenceProbability;
    const equipmentLossProbability = existenceProbability / poolSize * chance;
    const { knownCards, unknownCount } = this.buildSimulatedKnownCards(target);
    const knownLoss = knownCards.length / poolSize * chance;
    const unknownLoss = Math.max(0, unknownCount) / poolSize * chance;
    const selectionKey = this.currentProbabilityEventKey(state, `steal-resource:${actor.id}:${target.id}`);
    const outcomeBranches = [];
    if (equipmentLossProbability > PROBABILITY_EPSILON && target.equipmentDefinitionId) {
      outcomeBranches.push({
        probability:equipmentLossProbability,
        conditions:{ [selectionKey]:"equipment" },
        outcome:"equipment"
      });
    }
    for (let index = 0; index < knownCards.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const card = knownCards[index];
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
    const selectionPartition = this.mergeProbabilityWork(
      outcomeBranches,
      "CardEffectSimulation.stealResourceToHand:selection"
    );
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
      const stolen = this.consumeRandomHandCards(state, target, unknownLoss, {
        result,
        eventWorlds:unknownWorlds,
        anonymousOnly:true,
        anonymousTargetBucketId:actor.id
      });
      actor.handCount = (actor.handCount ?? 0) + stolen;
    }
  }
};
