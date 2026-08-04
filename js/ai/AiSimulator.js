/**
 * 轻量期望值模拟器。只消费过滤后的可见快照；未知格挡、反制、突袭和救援牌
 * 通过快照概率折算，绝不读取其他玩家真实手牌或未来牌堆。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260804-destroy-sim-zone-v72";
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260804-destroy-sim-zone-v72";
import { RuleEngine } from "../core/RuleEngine.js?build=20260804-destroy-sim-zone-v72";
import { globalBenefitCounterDesire } from "./AiGlobalBenefit.js?build=20260804-destroy-sim-zone-v72";
import { chooseBestResourceHandCandidate, chooseResourceZone } from "./resourceSelectionValue.js?build=20260804-destroy-sim-zone-v72";
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
} from "./AiProbabilityBranches.js?build=20260804-destroy-sim-zone-v72";

const BASIC_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0);
const EQUIPMENT_CARD_COUNT = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment").reduce((sum, card) => sum + card.count, 0);
const BLOCK_CARD_COUNT = CARD_DEFINITIONS.block.count;
const OTHER_BASIC_CARD_COUNT = BASIC_CARD_COUNT - BLOCK_CARD_COUNT;
const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const unionProbability = (oldProbability, newProbability) => 1
  - (1 - clampProbability(oldProbability)) * (1 - clampProbability(newProbability));

export class AiSimulator {
  constructor(visibleState) {
    this.initial = structuredClone(visibleState);
    this.initializeEquipmentBaselines(this.initial);
    this.initializeAssaultSummaries(this.initial);
  }

  clone(state = this.initial) {
    const cloned = structuredClone(state);
    this.initializeEquipmentBaselines(cloned);
    this.initializeAssaultSummaries(cloned);
    return cloned;
  }

  initializeEquipmentBaselines(state) {
    for (const player of state?.players ?? []) {
      if (Object.hasOwn(player, "initialEquipmentValue")) continue;
      player.initialEquipmentValue = player.equipmentDefinitionId
        ? (CARD_DEFINITIONS[player.equipmentDefinitionId]?.aiValue ?? 7)
        : 0;
    }
  }

  initializeAssaultSummaries(state) {
    for (const player of state?.players ?? []) this.syncAssaultSummary(player);
  }

  nextProbabilityEventKey(state, label = "event") {
    state.probabilityEventCounter = Math.max(0, Number(state.probabilityEventCounter) || 0) + 1;
    return `simulation:${label}:${state.probabilityEventCounter}`;
  }

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

  eventProbability(eventWorlds) {
    return totalBranchProbability((eventWorlds ?? []).filter((branch) => branch.occurs));
  }

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

  changeEnergy(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "energy");
    return this.updateEnergyFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

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

  changeShield(state, player, delta, eventWorlds = null) {
    const worlds = eventWorlds ?? this.getEventWorlds(state, 1, null, "shield");
    return this.updateShieldFromWorlds(player, worlds, (amount, branch) => (
      branch.occurs ? amount + (typeof delta === "function" ? delta(amount, branch) : delta) : amount
    ));
  }

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

  consumeAttackUse(state, player, desiredEventWorlds, preferredIndex = null) {
    const slots = this.ensureAttackUseSlots(player);
    const consumed = this.consumeSlot(state, slots, desiredEventWorlds, preferredIndex,
      `attack-slot:${player.id}`);
    const probability = this.eventProbability(consumed.eventWorlds);
    player.attackAvailabilityBranches = slots.map(availableBranchesFromState);
    player.attackUsed = (player.attackUsed ?? 0) + probability;
    return consumed;
  }

  apply(state, abstractAction, viewerId) {
    const next = this.clone(state);
    if (next.playPhaseEnded) return next;
    const actor = next.players.find((player) => player.id === viewerId);
    if (abstractAction.type === "end") {
      if (actor?.generalId === "blade-walker") actor.momentum = 0;
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
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability);
    if (executionProbability <= 0) return next;
    const effectEventWorlds = card.counterScope === "target"
      ? cardEventWorlds
      : this.gateEventWorlds(next, cardEventWorlds,
        this.tacticResolutionChance(next, actor, card, abstractAction.targets ?? []),
        `counter:${card.id ?? card.definitionId}`);
    const scale = this.eventProbability(effectEventWorlds);
    const cardDamageContext = { cardDamage:true, emberTriggeredProbabilities:{} };
    let coordinationProbability = 0;
    let coordinationTargets = [];

    switch (card.definitionId) {
      case "recover":
        this.healFrom(actor, actor, 1 * scale);
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
      case "harvest": actor.handCount += 2 * scale; break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + scale; break;
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          attackUseSlot:abstractAction.attackUseSlot,
          damageContext:cardDamageContext
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetWorlds = this.gateEventWorlds(next, effectEventWorlds,
            this.targetResolutionChance(next, actor, card, player), `target-counter:${card.id}:${player.id}`);
          this.applyDamage(next, actor, player, 1, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:targetWorlds,
            damageContext:cardDamageContext
          });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const targetScale = this.targetResolutionChance(next, actor, card, player);
          const response = player.assaultResponseProbability ?? 0;
          const targetWorlds = this.gateEventWorlds(next, effectEventWorlds,
            targetScale, `target-counter:${card.id}:${player.id}`);
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
          ? Math.max(second.blockProbability ?? 0, BLOCK_CARD_COUNT / TOTAL_CARD_COUNT)
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
        this.setSimulatedEquipment(first, first.equipmentDefinitionId, existenceProbability - effectiveDeclineProbability);
        coordinationProbability = scale;
        coordinationTargets = [first, second];
        break;
      }
      case "plunder":
        if (target) this.takeResourceToHand(next, actor, target, scale);
        break;
      case "transfer": {
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? null;
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? null;
        if (source && receiver && (source.handCount ?? 0) > 0 && abstractAction.selection?.zone !== "equipment") {
          const transferred = this.consumeRandomHandCards(next, source, scale);
          receiver.handCount += transferred;
          coordinationProbability = transferred;
          coordinationTargets = [receiver];
        }
        break;
      }
      case "destroy": if (target) this.destroyResource(next, actor, target, scale); break;
      case "duel": if (target) this.applyDuel(next, actor, target, scale, cardDamageContext); break;
      case "mutualBenefit": {
        coordinationTargets = next.players.filter((player) => player.alive);
        coordinationProbability = scale;
        for (const player of coordinationTargets) player.handCount += scale;
        break;
      }
      case "symbiosis": {
        coordinationTargets = this.seatOrderFrom(next, actor, true);
        coordinationProbability = scale;
        for (const player of coordinationTargets) this.healFrom(actor, player, scale);
        break;
      }
      default:
        if (card.category === "equipment") this.setSimulatedEquipment(actor, card.definitionId, executionProbability);
        break;
    }
    this.simulateGamble(actor, card, executionProbability);
    this.simulateCoordination(actor, coordinationTargets, coordinationProbability);
    const recycleProbability = executionProbability * this.getSimulatedEquipmentProbability(actor, "recycleDevice");
    if (card.category === "tactic" && recycleProbability > 0) {
      const remainingUses = Math.max(0, 2 - (actor.recycleDeviceUses ?? 0));
      const triggerProbability = Math.min(recycleProbability, remainingUses);
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + triggerProbability;
      actor.handCount += triggerProbability;
    }
    if (actor.generalId === "blade-walker" && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(actor, category, executionProbability);
    }
    return next;
  }

  /** AI 模拟中装备定义与存在概率的唯一写入口；换装固定重置为完整的新装备。 */
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

  getSimulatedEquipmentProbability(player, definitionId = null) {
    if (!player?.equipmentDefinitionId || (definitionId && player.equipmentDefinitionId !== definitionId)) return 0;
    return Math.max(0, Math.min(1, Number(player.equipmentRetentionProbability ?? 1) || 0));
  }

  /**
   * 从模拟可见状态整理合法已知手牌与未知数量。
   * 身份数量超过聚合手牌时保守回退：剩余期望手牌全部按未知聚合处理，不猜测哪张已知牌消失。
   */
  buildSimulatedKnownCards(target) {
    const knownCards = Array.isArray(target.knownCards) ? target.knownCards : [];
    const handCount = Math.max(0, Number(target.handCount) || 0);
    if (knownCards.length > handCount + PROBABILITY_EPSILON) {
      return { knownCards: [], unknownCount: handCount };
    }
    return { knownCards, unknownCount: Math.max(0, handCount - knownCards.length) };
  }

  /** 模拟破坏/掠夺的抽象资源选择；本阶段仅用于 destroy，不读取 target.hand。 */
  chooseSimulatedResourceSelection(actor, target, purpose) {
    const { knownCards, unknownCount } = this.buildSimulatedKnownCards(target);
    const handCandidate = chooseBestResourceHandCandidate({
      purpose,
      actor,
      owner: target,
      knownCards,
      unknownCount
    });
    const equipmentDefinitionId = this.getSimulatedEquipmentProbability(target) > PROBABILITY_EPSILON
      ? (target.equipmentDefinitionId ?? null)
      : null;
    return chooseResourceZone({
      purpose,
      actor,
      owner: target,
      handCandidate,
      equipmentDefinitionId
    });
  }

  /** 从 AI 自己的具体模拟手牌中同步消费响应牌；部分期望消费会保留对应可用概率。 */
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

  consumeRandomHandCards(state, player, expectedAmount) {
    let remaining = Math.max(0, Number(expectedAmount) || 0);
    let totalSpent = 0;
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

      const cards = (player.hand ?? []).filter((card) => totalBranchProbability(getAvailabilityBranches(card)) > PROBABILITY_EPSILON);
      const totalAvailability = cards.reduce((sum, card) => sum + totalBranchProbability(getAvailabilityBranches(card)), 0);
      for (const card of cards) {
        const availabilityState = getAvailabilityStateBranches(card);
        const availableProbability = totalBranchProbability(availabilityState.filter((branch) => branch.available));
        const removalProbability = totalAvailability > 0 ? spend * availableProbability / totalAvailability : 0;
        const removalWorlds = this.getEventWorlds(state,
          availableProbability > 0 ? removalProbability / availableProbability : 0,
          null, `random-card-loss:${player.id}:${card.id}`);
        const joined = joinProbabilityStateBranches(availabilityState, removalWorlds);
        card.availabilityStateBranches = projectProbabilityStateBranches(joined, (branch) => ({
          available:Boolean(branch.available && !branch.occurs)
        }));
        card.availabilityBranches = availableBranchesFromState(card.availabilityStateBranches);
      }
      if (Array.isArray(player.hand)) {
        player.hand = player.hand.filter((card) => totalBranchProbability(getAvailabilityBranches(card)) > PROBABILITY_EPSILON);
      }
      player.handCount = Math.max(0, handBefore - spend);
      remaining -= spend;
      totalSpent += spend;
    }
    return totalSpent;
  }

  /** 连势按“该类别此前已使用”的概率累计，避免多个部分概率动作重复获得完整首次收益。 */
  simulateCategoryUse(player, category, useProbability = 1, lifeDamageProbability = 0) {
    if (!category || player?.generalId !== "blade-walker") return 0;
    const chance = clampProbability(useProbability);
    const lifeDamageChance = Math.min(chance, clampProbability(lifeDamageProbability));
    player.categoriesUsed ??= [];
    player.categoryUsedProbabilities ??= {};
    const oldUsedProbability = clampProbability(player.categoryUsedProbabilities[category]
      ?? (player.categoriesUsed.includes(category) ? 1 : 0));
    const newUsedProbability = unionProbability(oldUsedProbability, chance);
    const firstUseProbability = Math.max(0, newUsedProbability - oldUsedProbability);
    player.categoryUsedProbabilities[category] = newUsedProbability;
    if (newUsedProbability >= 1 - Number.EPSILON && !player.categoriesUsed.includes(category)) {
      player.categoriesUsed.push(category);
    }

    const currentMomentum = Math.max(0, Number(player.momentum) || 0);
    const unusedProbability = 1 - oldUsedProbability;
    const firstUseOnHit = lifeDamageChance * unusedProbability;
    const firstUseWithoutHit = Math.max(0, chance - lifeDamageChance) * unusedProbability;
    const nonHitGain = Math.min(1, Math.max(0, GAME_CONFIG.momentumMaxStacks - currentMomentum));
    // 命中生命时旧连势先被消耗，随后本次首次类别仍会积累1层；未命中分支只补足剩余层数。
    player.momentum = Math.min(GAME_CONFIG.momentumMaxStacks,
      currentMomentum * (1 - lifeDamageChance) + firstUseOnHit + firstUseWithoutHit * nonHitGain);
    return firstUseProbability;
  }

  simulateGamble(actor, card, useProbability) {
    if (actor?.generalId !== "fate-gambler" || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    actor.handCount = (actor.handCount ?? 0) + triggerProbability * GAME_CONFIG.gamblerDrawChance;
    return triggerProbability;
  }

  simulateCoordination(actor, effectiveTargets, resolutionProbability) {
    if (actor?.generalId !== "resonance-tuner") return 0;
    if (!(effectiveTargets ?? []).some((target) => target?.alive && target.id !== actor.id
      && target.battleTeam === actor.battleTeam)) return 0;
    const oldProbability = clampProbability(actor.coordinationTriggeredProbability
      ?? (actor.coordinationTriggered ? 1 : 0));
    const newProbability = unionProbability(oldProbability, resolutionProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.coordinationTriggeredProbability = newProbability;
    actor.coordinationTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    actor.handCount = (actor.handCount ?? 0) + triggerProbability;
    return triggerProbability;
  }

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

  /** 目标指定阶段的猎印概率使用联合概率；同一猎手每回合最多留下两次猎印。 */
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

  /** 护援在格挡、雷达和护盾之前减少伤害，并同步计算一次弃牌与每轮次数的期望代价。 */
  simulateGuardianAid(state, target, incomingDamage, eventProbability) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) return Math.max(0, incomingDamage);
    const conditionalReduction = Math.min(1, incomingDamage / probability);
    let remainingTriggerProbability = probability;
    let expectedReduction = 0;
    for (const guardian of state.players) {
      if (remainingTriggerProbability <= PROBABILITY_EPSILON) break;
      if (!guardian.alive || guardian.generalId !== "oath-warden" || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const oldUsedProbability = clampProbability(guardian.guardianAidUsedProbability
        ?? (guardian.guardianAidUsed ? 1 : 0));
      const handAvailability = Math.min(1, Math.max(0, Number(guardian.handCount) || 0));
      const triggerProbability = remainingTriggerProbability * (1 - oldUsedProbability) * handAvailability;
      if (triggerProbability <= 0) continue;
      this.consumeRandomHandCards(state, guardian, triggerProbability);
      guardian.guardianAidUsedProbability = clampProbability(oldUsedProbability + triggerProbability);
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - Number.EPSILON;
      expectedReduction += triggerProbability * conditionalReduction;
      remainingTriggerProbability = Math.max(0, remainingTriggerProbability - triggerProbability);
    }
    return Math.max(0, incomingDamage - expectedReduction);
  }

  /** 统一处理实际生命伤害后的角色收益。 */
  simulateAfterLifeDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null, damageContext = {}) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target) return;
    if (source.generalId === "shade-agent" && target.alive && target.hp > 0
      && target.battleTeam !== source.battleTeam && (target.handCount ?? 0) > 0) {
      const oldTriggeredProbability = clampProbability(source.spyGapTriggeredProbability
        ?? (source.spyGapTriggered ? 1 : 0));
      const triggerProbability = (1 - oldTriggeredProbability) * chance;
      source.spyGapTriggeredProbability = unionProbability(oldTriggeredProbability, chance);
      source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
      source.expectedInformationGain = (source.expectedInformationGain ?? 0)
        + Math.min(2, target.handCount) * triggerProbability;
    }
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

  simulateAssaultAfterDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null) {
    return this.simulateAfterLifeDamage(state, source, target, lifeDamageProbability,
      lifeDamageBranches, { cardDamage:true, emberTriggeredProbabilities:{} });
  }

  /** 普通突袭与借势响应共用同一次数槽、伤害与后续收益结算入口。 */
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
    const momentum = source.generalId === "blade-walker" ? (source.momentum ?? 0) : 0;
    const damageOutcome = {};
    const damage = 1 + (source.exposeWeaknessStacks ?? 0) + (source.assaultBonus ?? 0) + momentum;
    this.applyDamage(state, source, target, damage, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:assaultWorlds,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined,
      damageContext:options.damageContext ?? { cardDamage:true, emberTriggeredProbabilities:{} }
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    this.simulateCategoryUse(source, "basic", chance, lifeDamageChance);
    return lifeDamageChance;
  }

  takeResourceToHand(state, actor, target, scale = 1) {
    if (!Array.isArray(state?.players)) {
      scale = target ?? 1;
      target = actor;
      actor = state;
      state = { players:[actor, target] };
    }
    const takeEquipment = target.equipmentDefinitionId && ((target.handCount ?? 0) <= 0 || CARD_DEFINITIONS[target.equipmentDefinitionId]?.aiValue >= 7);
    if (takeEquipment) {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      const transferProbability = existenceProbability * Math.max(0, Math.min(1, scale));
      this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - transferProbability);
      actor.handCount += transferProbability;
    } else {
      const transferred = this.consumeRandomHandCards(state, target, scale);
      actor.handCount += transferred;
    }
  }

  /**
   * 本阶段只同步破坏的手牌/装备区域选择。
   * 选择手牌后仍使用聚合随机消耗，不追踪具体已知牌身份。
   */
  destroyResource(state, actor, target, scale = 1) {
    if (!Array.isArray(state?.players)) {
      throw new Error("destroyResource 需要 state、actor、target、scale 完整签名");
    }
    const clampedScale = Math.max(0, Math.min(1, Number(scale) || 0));
    const selection = this.chooseSimulatedResourceSelection(actor, target, "destroy");
    if (!selection) return;
    if (selection.zone === "equipment") {
      const existenceProbability = this.getSimulatedEquipmentProbability(target);
      this.setSimulatedEquipment(target, target.equipmentDefinitionId,
        existenceProbability * (1 - clampedScale));
    } else if (selection.zone === "hand") {
      this.consumeRandomHandCards(state, target, clampedScale);
    }
  }

  tacticResolutionChance(state, actor, card, targets = []) {
    if (card.category !== "tactic" || card.counterable === false) return 1;
    return state.players.filter((player) => player.alive && player.id !== actor.id)
      .reduce((chance, player) => chance * (1 - (player.counterProbability ?? 0) * this.counterDesire(state, player, actor, card, targets)), 1);
  }

  targetResolutionChance(state, actor, card, target) {
    if (card.counterScope !== "target") return 1;
    return 1 - (target.counterProbability ?? 0) * this.counterDesire(state, target, actor, card, [target]);
  }

  counterDesire(state, responder, actor, card, targets) {
    const sourceEnemy = responder.battleTeam !== actor.battleTeam;
    const target = state.players.find((player) => player.id === targets[0]?.id);
    const globalBenefitDesire = globalBenefitCounterDesire(state.players, responder.battleTeam, card.definitionId);
    if (globalBenefitDesire !== null) return globalBenefitDesire;
    if (["shockwave","provoke"].includes(card.definitionId)) return sourceEnemy ? 1 : 0;
    if (card.definitionId === "duel") return target?.battleTeam === responder.battleTeam ? 0.9 : sourceEnemy ? 0.35 : 0;
    if (["scout","plunder","destroy"].includes(card.definitionId) && target) {
      if (target.battleTeam === responder.battleTeam) return sourceEnemy ? 1 : 0.75;
      return sourceEnemy ? 0.25 : 0;
    }
    if (card.definitionId === "transfer") return sourceEnemy ? 0.45 : 0.15;
    return sourceEnemy ? ((card.aiValue ?? 0) >= 7 ? 0.8 : 0.45) : 0;
  }

  applySkill(state, actor, action, eventWorlds) {
    const skill = action.skill;
    const target = state.players.find((player) => player.id === action.targets?.[0]?.id);
    const chance = this.eventProbability(eventWorlds);
    if (!skill || chance <= 0) return;
    if (skill.id === "allIn") {
      const joined = this.updateEnergyFromWorlds(actor, eventWorlds, (amount, branch) => (
        branch.occurs ? 0 : amount
      ));
      actor.handCount += joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * branch.energyAmount : 0)
      ), 0);
      const currentAssaultBonus = actor.assaultBonus ?? 0;
      const joinedExpectedValue = joined.reduce((sum, branch) => (
        sum + (branch.occurs ? branch.probability * Math.min(1, branch.energyAmount * .3) : 0)
      ), 0);
      actor.assaultBonus = currentAssaultBonus + joinedExpectedValue * (1 - currentAssaultBonus);
      return;
    }
    this.changeEnergy(state, actor, -(Number(skill.cost) || 0), eventWorlds);
    if (skill.id === "breakArmy") {
      const attackSlots = this.ensureAttackUseSlots(actor);
      attackSlots.push(projectProbabilityStateBranches(eventWorlds, (branch) => ({
        available:Boolean(branch.occurs)
      })));
      actor.attackLimit = (actor.attackLimit ?? attackSlots.length - 1) + chance;
      actor.attackAvailabilityBranches = attackSlots.map(availableBranchesFromState);
    }
    else if (skill.id === "barrier" && target) {
      this.changeShield(state, target, 1, eventWorlds);
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(actor, target, chance);
      if (target.id !== actor.id) this.healFrom(actor, actor, chance);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, 1, { canBlock:false, eventBranches:eventWorlds });
      }
    } else if (skill.id === "hunt" && target) {
      target.huntMarkProbabilities ??= {};
      const oldMarkProbability = clampProbability(target.huntMarkProbabilities[actor.id]
        ?? (target.huntMarkSourceId === actor.id ? 1 : 0));
      const consumedMarkProbability = Math.min(oldMarkProbability, chance);
      const markBranches = target.huntMarkStateBranchesBySource?.[actor.id];
      if (Array.isArray(markBranches)) {
        const markedState = markBranches.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          marked:Boolean(branch.marked)
        }));
        const joinedMarks = joinProbabilityStateBranches(markedState, eventWorlds);
        target.huntMarkStateBranchesBySource[actor.id] = projectProbabilityStateBranches(
          joinedMarks,
          (branch) => ({ marked:Boolean(branch.marked && !branch.occurs) })
        );
        target.huntMarkProbabilities[actor.id] = totalBranchProbability(
          target.huntMarkStateBranchesBySource[actor.id].filter((branch) => branch.marked)
        );
      } else {
        target.huntMarkProbabilities[actor.id] = Math.max(0, oldMarkProbability - consumedMarkProbability);
      }
      target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities ?? {}).map(clampProbability));
      const fullMarkSource = Object.entries(target.huntMarkProbabilities)
        .find(([, probability]) => clampProbability(probability) >= 1 - Number.EPSILON)?.[0] ?? null;
      target.huntMarkSourceId = fullMarkSource;
      if (Array.isArray(target.statuses) && !fullMarkSource) {
        target.statuses = target.statuses.filter((status) => status !== "huntMark");
      }
      const outcome = {};
      this.applyDamage(state, actor, target, 2, {
        canBlock:true,
        eventBranches:consumedMarkProbability >= chance - PROBABILITY_EPSILON
          ? eventWorlds
          : this.gateEventWorlds(state, eventWorlds,
            chance > 0 ? consumedMarkProbability / chance : 0,
            `hunt-mark:${actor.id}:${target.id}`),
        outcome
      });
      actor.handCount += outcome.blockedByCardChance ?? 0;
    } else if (skill.id === "resonance" && target) target.handCount += 2 * chance;
  }

  /** 窃取所得资源只增加手牌；目标仅有装备时，模拟中明确移除装备且不替换施术者装备。 */
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
    this.consumeRandomHandCards(state, target, handLoss);
    this.setSimulatedEquipment(target, target.equipmentDefinitionId, existenceProbability - equipmentLossProbability);
  }

  applyDuel(state, actor, target, scale, damageContext = { cardDamage:true, emberTriggeredProbabilities:{} }) {
    const resolutionProbability = clampProbability(scale);
    const actorDistribution = this.syncAssaultSummary(actor);
    const targetDistribution = this.syncAssaultSummary(target);
    const actorRemaining = new Map();
    const targetRemaining = new Map();
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
    const aidedExpectedDamage = this.simulateGuardianAid(
      state, target, amount * eventProbability, eventProbability
    );
    amount = aidedExpectedDamage / eventProbability;
    if (amount <= PROBABILITY_EPSILON) {
      if (options.outcome) {
        options.outcome.lifeDamageBranches = projectProbabilityStateBranches(
          eventWorlds, () => ({ occurs:false })
        );
        options.outcome.lifeDamageChance = 0;
        options.outcome.blockedByCardChance = 0;
      }
      return 0;
    }
    const battleProbability = clampProbability(options.deviceAttack
      && attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    const normalBlockChance = clampProbability(target.blockProbability ?? 0);
    const twoBlockChance = clampProbability(target.twoBlockProbability ?? 0);
    const blockChance = options.canBlock
      ? battleProbability * twoBlockChance + (1 - battleProbability) * normalBlockChance
      : 0;
    let passChance = 1 - blockChance;
    const defenseProbability = options.deviceAttack
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = blockChance;
    let expectedBlockSpend = options.canBlock
      ? battleProbability * twoBlockChance * 2 + (1 - battleProbability) * normalBlockChance
      : 0;
    let expectedJudgmentGain = 0;
    if (defenseProbability > 0) {
      const judgmentProbabilities = options.radarJudgmentProbabilities ?? {};
      const judgmentBlockChance = clampProbability(
        judgmentProbabilities.block ?? BLOCK_CARD_COUNT / TOTAL_CARD_COUNT
      );
      const otherBasicChance = clampProbability(
        judgmentProbabilities.otherBasic ?? OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT
      );
      const basicChance = judgmentBlockChance + otherBasicChance;
      const equipmentChance = clampProbability(
        judgmentProbabilities.equipment ?? EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT
      );
      const normalRadarPass = !options.canBlock
        ? basicChance + equipmentChance
        : (otherBasicChance + equipmentChance) * (1 - normalBlockChance);
      const battleRadarPass = !options.canBlock
        ? basicChance + equipmentChance
        : judgmentBlockChance * (1 - normalBlockChance)
          + (otherBasicChance + equipmentChance) * (1 - twoBlockChance);
      const radarPass = battleProbability * battleRadarPass + (1 - battleProbability) * normalRadarPass;
      passChance = (1 - defenseProbability) * passChance + defenseProbability * radarPass;
      const noRadarSpent = options.canBlock
        ? battleProbability * twoBlockChance * 2 + (1 - battleProbability) * normalBlockChance
        : 0;
      const normalRadarSpent = options.canBlock
        ? judgmentBlockChance + (otherBasicChance + equipmentChance) * normalBlockChance
        : 0;
      const battleRadarSpent = options.canBlock
        ? 2 * (judgmentBlockChance * normalBlockChance
          + (otherBasicChance + equipmentChance) * twoBlockChance)
        : 0;
      const radarSpent = battleProbability * battleRadarSpent + (1 - battleProbability) * normalRadarSpent;
      const normalRadarBlocked = options.canBlock
        ? judgmentBlockChance + (otherBasicChance + equipmentChance) * normalBlockChance
        : 0;
      const battleRadarBlocked = options.canBlock
        ? judgmentBlockChance * normalBlockChance
          + (otherBasicChance + equipmentChance) * twoBlockChance
        : 0;
      const radarBlocked = battleProbability * battleRadarBlocked
        + (1 - battleProbability) * normalRadarBlocked;
      blockedByCardChance = (1 - defenseProbability) * blockChance + defenseProbability * radarBlocked;
      expectedBlockSpend = (1 - defenseProbability) * noRadarSpent + defenseProbability * radarSpent;
      expectedJudgmentGain = defenseProbability * basicChance;
    }
    target.handCount = Math.max(0, (target.handCount ?? 0)
      + eventProbability * expectedJudgmentGain
      - eventProbability * expectedBlockSpend);
    const passPartition = probabilityEventPartition(
      this.nextProbabilityEventKey(state, `damage-pass:${attacker?.id ?? "unknown"}:${target.id}`),
      passChance,
      "passes"
    );
    const shieldState = getValueBranches(target, "shield", target.shield).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      shieldAmount:branch.amount
    }));
    const damageWorlds = joinProbabilityStateBranches(eventWorlds, passPartition, shieldState);
    const hpDamageFor = (branch) => branch.occurs && branch.passes
      ? Math.max(0, amount - branch.shieldAmount)
      : 0;
    target.shieldBranches = projectProbabilityStateBranches(damageWorlds, (branch) => ({
      amount:branch.occurs && branch.passes
        ? Math.max(0, branch.shieldAmount - amount)
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
    return actualDamage;
  }

  applyHpLoss(state, target, amount) {
    if (!target.alive || amount <= 0) return;
    target.hp -= amount;
    this.resolveFatal(state, target);
  }

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
    const rejuvenationBonus = (player) => player.generalId === "spirit-medic" && !player.rejuvenationUsed
      ? Math.min(1, player.expectedRecoverCount ?? 0)
      : 0;
    const capacity = allies.reduce((sum, player) => sum + (player.expectedRecoverCount ?? 0) + rejuvenationBonus(player), 0);
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
      this.setSimulatedEquipment(target, null, 0);
      this.clearHuntMarksBySource(state, target.id);
      if (attacker?.alive && attacker.battleTeam !== target.battleTeam) {
        attacker.handCount = (attacker.handCount ?? 0) + GAME_CONFIG.killRewardDrawCount;
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
        const canRejuvenate = rejuvenationBonus(rescuer) > 0;
        const healingPerCard = canRejuvenate ? 2 : 1;
        const spent = Math.min(1, available);
        if (spent <= PROBABILITY_EPSILON) continue;
        const healing = spent * healingPerCard;
        usedThisRound = true;
        remaining -= healing;
        healingApplied += healing;
        rescuer.expectedRecoverCount = Math.max(0, available - spent);
        rescuer.handCount = Math.max(0, (rescuer.handCount ?? 0) - spent + (canRejuvenate ? spent : 0));
        if (canRejuvenate) rescuer.rejuvenationUsed = true;
        this.consumeKnownCardsFromHand(state, rescuer, "recover", spent);
      }
      rounds += 1;
      if (!usedThisRound) break;
    }
    target.hp = Math.min(target.maxHp, target.hp + healingApplied);
    target.survivalChance = 1;
    target.alive = true;
  }

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

  heal(target, amount) {
    if (target.alive && amount > 0) target.hp = Math.min(target.maxHp, target.hp + amount);
  }

  /** 模拟由角色发起的治疗；灵医首次治疗己方时同步计算回春的治疗与摸牌收益。 */
  healFrom(source, target, amount) {
    if (!target?.alive || target.hp >= target.maxHp || amount <= 0) return;
    let finalAmount = amount;
    if (source?.generalId === "spirit-medic" && source.battleTeam === target.battleTeam && !source.rejuvenationUsed) {
      const triggerWeight = Math.min(1, amount);
      source.rejuvenationUsed = true;
      source.handCount = (source.handCount ?? 0) + triggerWeight;
      finalAmount += triggerWeight;
    }
    this.heal(target, finalAmount);
  }
}
