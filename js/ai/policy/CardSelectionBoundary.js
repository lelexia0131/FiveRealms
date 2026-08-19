/*
模块职责
作为真实选牌执行边界，把合法实体候选转换为正式 Policy 输入，再把选择 ID 解析回当前实体。

上游
AiController、MatchApplication、PublicCardPoolWorkflow、角色技能与直接测试。

下游
Domain CardRules、AI RuleProjection/DistanceProbabilityBranches 与 policy/CardSelectionPolicy、ResourceSelectionPolicy、TransferPolicy。

状态边界
只读 runtime 提供的当前 state/Player 实体；不移动卡牌，实体移动仍由真实规则调用方执行。

信息边界
边界只把自己手牌、合法 aiMemory、公开装备和 Belief 交给 Policy，未知牌只能按位置解析。

架构约束
选择公式只存在于 policy 目录；本文件只负责合法集合、公开上下文与实体 ID 解析。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import {
  findPlayerFact,
  getTransferReceiverIds
} from "../../domain/rules/card/CardRules.js";
import { projectTransferRulePlayers } from "../state/RuleProjection.js";
import { inAttackRange } from "../state/DistanceProbabilityBranches.js";
import { CardSelectionPolicy } from "./CardSelectionPolicy.js";
import { ResourceSelectionPolicy } from "./ResourceSelectionPolicy.js";
import { TransferPolicy } from "./TransferPolicy.js";

export class CardSelectionBoundary {
  /*
  功能
  绑定真实规则边界、Knowledge 与 Controller 构造的正式 Policy。

  调用方
  AIController 组合根（统一组装依赖的位置） 与边界专项测试。

  输入
  显式 runtime 能力、Knowledge 及可选正式 Policy 实例。

  输出
  可解析真实实体的正式边界。

  读取状态
  保存显式依赖。

  写入状态
  写实例依赖字段。

  调用函数
  ResourceSelectionPolicy、TransferPolicy、CardSelectionPolicy 构造函数。

  边界与不变量
  不保存 Game；runtime 只提供 random/getState/getEnemies/createSearchState 窄能力，query 缺失时保留直接测试的旧静态回退。
  */
  constructor(runtime, knowledge, policies = {}) {
    if (!runtime || typeof runtime.random !== "function") {
      throw new TypeError("CardSelectionBoundary 缺少 runtime 能力：random");
    }
    this.getState = typeof runtime.getState === "function"
      ? runtime.getState
      : () => runtime.state ?? { players:[] };
    this.getEnemies = typeof runtime.getEnemies === "function"
      ? runtime.getEnemies
      : (player) => (this.getState().players ?? []).filter((entry) => (
        entry.alive && entry.battleTeam !== player.battleTeam
      ));
    this.random = runtime.random;
    this.createSearchState = typeof runtime.createSearchState === "function"
      ? runtime.createSearchState
      : null;
    this.knowledge = knowledge;
    this.resourcePolicy = policies.resourcePolicy ?? new ResourceSelectionPolicy();
    this.resourceValueQuery = policies.resourceValueQuery ?? null;
    this.transferPolicy = policies.transferPolicy ?? new TransferPolicy();
    this.cardSelectionPolicy = policies.cardSelectionPolicy ?? new CardSelectionPolicy({
      random: () => this.random(),
      remainingCounts: (actor) => this.knowledge?.remainingCounts?.(actor) ?? null,
      resourcePolicy: this.resourcePolicy,
      transferPolicy: this.transferPolicy
    });
  }

  /*
  功能
  在真实执行边界用与深层模拟相同的 SearchState 反事实语义选择资源并解析当前实体。

  调用方
  chooseZoneCard 的 destroy/plunder 分支。

  输入
  行动者、资源拥有者、purpose、排除 ID 与一次冻结的 remaining counts。

  输出
  `{card, zone}` 或 null。

  读取状态
  当前合法实体 ID、createSearchState 输出、公开装备、合法 known identities 与匿名容量。

  写入状态
  仅在匿名候选胜出时推进随机源。

  调用函数
  ResourceSelectionPolicy.buildCandidates/chooseContextual、ResourceValueQuery.evaluate。

  边界与不变量
  known 必须按 exact cardId 解析；unknown 只在胜出后从匿名位置随机解析且不读取 definitionId。
  */
  chooseContextualZoneCard(
    actor,
    owner,
    purpose,
    excludedCardIds,
    remainingCardCounts
  ) {
    const searchState = this.createSearchState(actor.id, remainingCardCounts);
    const searchActor = searchState.players.find((player) => player.id === actor.id);
    const searchOwner = searchState.players.find((player) => player.id === owner.id);
    if (!searchActor || !searchOwner) return null;
    const eligibleCards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const eligibleIds = new Set(eligibleCards.map((card) => card.id));
    const knownCards = (searchOwner.knownCards ?? []).filter(
      (entry) => eligibleIds.has(entry.cardId)
    );
    const knownIds = new Set(knownCards.map((entry) => entry.cardId));
    const unknownCards = eligibleCards.filter((card) => !knownIds.has(card.id));
    const equipmentDefinitionId = owner.equipment?.definitionId ?? null;
    const candidates = this.resourcePolicy.buildCandidates({
      purpose,
      actor: searchActor,
      owner: searchOwner,
      knownCards,
      unknownCount: unknownCards.length,
      equipmentDefinitionId,
      remainingCardCounts
    }).map((candidate) => ({
      ...candidate,
      availableUnknownCount: unknownCards.length
    }));
    const evaluated = this.resourceValueQuery.evaluate({
      state: searchState,
      actorId: searchActor.id,
      targetId: searchOwner.id,
      purpose,
      candidates
    });
    const selection = this.resourcePolicy.chooseContextual(evaluated);
    if (selection?.zone === "equipment" && owner.equipment) {
      return { card: owner.equipment, zone: "equipment" };
    }
    if (selection?.selectionKind === "known") {
      const card = eligibleCards.find((entry) => entry.id === selection.cardId) ?? null;
      return card ? { card, zone: "hand" } : null;
    }
    if (selection?.selectionKind === "unknown" && unknownCards.length) {
      const index = Math.floor(this.random() * unknownCards.length);
      return { card: unknownCards[index] ?? unknownCards[0], zone: "hand" };
    }
    return null;
  }

  /*
  功能
  从当前合法手牌实体中按 Policy 选择位置并解析为实体数组。

  调用方
  AIController、AiChoiceAdapter、chooseZoneCard 与直接测试。

  输入
  观察者、拥有者、数量、排除 ID、用途上下文和可选 remaining counts。

  输出
  仍存在于本次候选集合中的真实 Card 实体数组。

  读取状态
  owner.hand、合法 aiMemory、Knowledge 与注入随机源。

  写入状态
  仅 Policy 随机源序列。

  调用函数
  CardSelectionPolicy.chooseHiddenCardIds。

  边界与不变量
  执行边界先过滤实体再按 ID 解析；未知 definitionId 不进入 Policy 比较。
  */
  chooseHiddenCards(
    actor,
    owner,
    count,
    excludedCardIds = null,
    context = null,
    resourceCounts = null
  ) {
    const cards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const selectedIds = this.cardSelectionPolicy.chooseHiddenCardIds({
      actor,
      owner,
      cards,
      count,
      excludedCardIds,
      context,
      resourceCounts
    });
    const byId = new Map(cards.map((card) => [card.id, card]));
    return selectedIds.map((cardId) => byId.get(cardId)).filter(Boolean);
  }

  /*
  功能
  选择窥探位置并委托正式 Policy 排序。

  调用方
  专项测试与 chooseHiddenCards。

  输入
  合法记忆映射与已过滤候选卡数组。

  输出
  候选数组下标。

  读取状态
  只读输入与 Policy 随机源。

  写入状态
  可能推进随机源。

  调用函数
  CardSelectionPolicy.peekIndex。

  边界与不变量
  本边界不复制选择公式。
  */
  peekIndex(known, cards) {
    return this.cardSelectionPolicy.peekIndex(known, cards);
  }

  /*
  功能
  选择已知/未知极值位置并委托正式 Policy。

  调用方
  边界专项测试。

  输入
  合法记忆、候选、方向、估值函数与未知期望。

  输出
  候选数组下标。

  读取状态
  只读输入与 Policy 随机源。

  写入状态
  可能推进随机源。

  调用函数
  CardSelectionPolicy.extremeIndex。

  边界与不变量
  本边界不读取未知定义或复制 tie-break。
  */
  extremeIndex(...args) {
    return this.cardSelectionPolicy.extremeIndex(...args);
  }

  /*
  功能
  在真实手牌与公开装备区之间解析 Resource Policy 的区域选择。

  调用方
  AIController、HiddenCardChoiceWorkflow 破坏/掠夺边界与测试。

  输入
  行动者、资源拥有者、用途上下文和排除 ID。

  输出
  `{card, zone}` 或 null。

  读取状态
  当前实体区域、Knowledge 与公开装备。

  写入状态
  可能推进未知位置随机源。

  调用函数
  chooseHiddenCards、CardSelectionPolicy.chooseZoneSelection。

  边界与不变量
  Policy 只返回描述；本边界必须从当前候选重新解析真实实体。
  */
  chooseZoneCard(actor, owner, context = null, excludedCardIds = null) {
    if (!owner?.alive) return null;
    const purpose = context?.purpose ?? null;
    const remainingCardCounts = purpose === "plunder" || purpose === "destroy"
      ? (this.knowledge?.remainingCounts?.(actor) ?? null)
      : null;
    if ((purpose === "plunder" || purpose === "destroy")
      && this.createSearchState && this.resourceValueQuery) {
      return this.chooseContextualZoneCard(
        actor, owner, purpose, excludedCardIds, remainingCardCounts
      );
    }
    const [handCard] = this.chooseHiddenCards(
      actor,
      owner,
      1,
      excludedCardIds,
      context,
      remainingCardCounts
    );
    const selection = this.cardSelectionPolicy.chooseZoneSelection({
      actor,
      owner,
      purpose,
      handCard: handCard ?? null,
      equipment: owner.equipment ?? null,
      remainingCardCounts
    });
    if (selection?.zone === "equipment" && owner.equipment) {
      return { card: owner.equipment, zone: "equipment" };
    }
    if (selection?.zone === "hand" && handCard?.id === selection.cardId) {
      return { card: handCard, zone: "hand" };
    }
    return null;
  }

  /*
  功能
  保留观察者对手牌实体的合法期望值入口。

  调用方
  边界专项测试与正式调用方。

  输入
  观察者、拥有者与 Card 实体。

  输出
  合法已知值或未知固定期望。

  读取状态
  自己手牌或合法 aiMemory。

  写入状态
  无。

  调用函数
  CardSelectionPolicy.expectedCardValue。

  边界与不变量
  本边界不读取其他玩家未知 definitionId。
  */
  expectedCardValue(actor, owner, card) {
    return this.cardSelectionPolicy.expectedCardValue(actor, owner, card);
  }

  /*
  功能
  从合法来源候选中解析最佳转移来源实体。

  调用方
  分阶段转移选择流程。

  输入
  行动者与合法来源数组。

  输出
  当前来源实体或 null。

  读取状态
  Domain CardRules 合法接收者与 TransferPolicy。

  写入状态
  无。

  调用函数
  chooseTransferCombination。

  边界与不变量
  不移动手牌，最终真实结算仍需实体复核。
  */
  chooseTransferSource(actor, candidates) {
    const plan = this.chooseTransferCombination(actor, CARD_DEFINITIONS.transfer, candidates);
    return candidates.find((player) => player.id === plan?.sourceId) ?? null;
  }

  /*
  功能
  从合法接收者候选中解析最佳转移接收者实体。

  调用方
  分阶段转移选择流程。

  输入
  行动者、已选来源和合法接收者数组。

  输出
  当前接收者实体或 null。

  读取状态
  Domain CardRules 合法集合与 TransferPolicy。

  写入状态
  无。

  调用函数
  chooseTransferCombination。

  边界与不变量
  只限制调用方已经给出的 receiver ID。
  */
  chooseTransferReceiver(actor, from, candidates) {
    const plan = this.chooseTransferCombination(
      actor,
      CARD_DEFINITIONS.transfer,
      [from],
      new Set(candidates.map((player) => player.id))
    );
    return candidates.find((player) => player.id === plan?.receiverId) ?? null;
  }

  /*
  功能
  从 Domain CardRules 给出的合法 source/receiver 集合选择最佳转移描述。

  调用方
  AIController、ActionGenerator 与分阶段选择入口。

  输入
  行动者、转移牌、合法来源、接收者限制与排除 ID。

  输出
  冻结 transfer selection 或 null。

  读取状态
  Domain CardRules 合法集合、Knowledge remaining counts 与 TransferPolicy。

  写入状态
  无。

  调用函数
  Domain CardRules.getTransferReceiverIds、TransferPolicy.choose。

  边界与不变量
  合法性由 Domain CardRules 提供，Policy 只评分；正在使用的转移实体通过排除集合保持不可选。
  */
  chooseTransferCombination(
    actor,
    card,
    sources,
    allowedReceiverIds = null,
    excludedCardIds = null
  ) {
    const remainingCardCounts = this.knowledge?.remainingCounts?.(actor) ?? null;
    const players = this.getState()?.players ?? [];
    return this.transferPolicy.choose({
      actor,
      sources,
      allowedReceiverIds,
      excludedCardIds,
      remainingCardCounts,
      getReceivers: (from) => {
        const exclusions = excludedCardIds ?? (card?.id ? new Set([card.id]) : null);
        const facts = projectTransferRulePlayers(players, exclusions);
        const actorFact = findPlayerFact(facts, actor.id);
        const fromFact = findPlayerFact(facts, from.id);
        const receiverIds = getTransferReceiverIds(facts, actorFact, fromFact, card);
        return players.filter((player) => receiverIds.includes(player.id));
      }
    });
  }

  /*
  功能
  从公开合法牌池解析 CardSelectionPolicy 选择的实体。

  调用方
  AiController 与 PublicCardPoolWorkflow。

  输入
  当前玩家与公开卡牌数组。

  输出
  当前公开 Card 实体或 null。

  读取状态
  公开候选与 CardValue。

  写入状态
  无。

  调用函数
  CardSelectionPolicy.choosePublicCardId。

  边界与不变量
  只按 ID 解析，不改变公开池顺序或内容。
  */
  choosePublicCard(player, cards) {
    const cardId = this.cardSelectionPolicy.choosePublicCardId(player, cards);
    return cards.find((card) => card.id === cardId) ?? null;
  }

  /*
  功能
  构造公开弃牌上下文并解析 ResourceSelectionPolicy 的实体 ID 结果。

  调用方
  AIController、AiChoiceAdapter 与角色规则。

  输入
  付款 Player 与弃牌数量。

  输出
  当前手牌中的真实 Card 实体数组。

  读取状态
  当前敌人距离、装备与玩家手牌。

  写入状态
  无。

  调用函数
  inAttackRange、CardSelectionPolicy.chooseDiscardIds。

  边界与不变量
  距离事实由真实规则边界提供；评分只存在于正式 ResourceSelectionPolicy。
  */
  chooseDiscards(player, count) {
    const enemies = this.getEnemies(player);
    const state = this.getState();
    const stranded = enemies.length > 0 && !enemies.some(
      (enemy) => inAttackRange({ state }, player, enemy)
    );
    const equippedDefinitionId = player.equipment?.definitionId
      ?? player.equipmentDefinitionId
      ?? null;
    const selectedIds = this.cardSelectionPolicy.chooseDiscardIds(
      player,
      player.hand,
      count,
      {
        stranded,
        equippedDefinitionId,
        equipmentRetentionProbability: player.equipmentRetentionProbability ?? 1
      }
    );
    const byId = new Map(player.hand.map((card) => [card.id, card]));
    return selectedIds.map((cardId) => byId.get(cardId)).filter(Boolean);
  }
}
