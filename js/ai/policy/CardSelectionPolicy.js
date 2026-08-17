/*
模块职责
拥有 AI 在已合法给出的手牌位置、公开牌池和资源候选中的局部选择策略。

上游
AIController 与 CardSelectionBoundary 正式边界。

下游
ResourceSelectionPolicy、TransferPolicy 与 value/CardValue。

状态边界
只读调用方提供的候选、合法记忆和 Belief；输出 ID/区域描述，不移动实体牌。

信息边界
其他玩家未知手牌只能按位置随机或以聚合期望比较，绝不读取未知实体 definitionId。

架构约束
不执行规则、不投影 State、不依赖 Planner/Controller/UI，也不构造 Simulator。
*/
import { getBaseCardAiValue } from "../value/CardValue.js?build=20260817-architecture-closure-final";
import { getRoleCardAiValue } from "../value/CardValue.js?build=20260817-architecture-closure-final";
import { UNKNOWN_HAND_EXPECTED_VALUE } from "./TransferPolicy.js?build=20260817-architecture-closure-final";
import {
  getResourceDefinitionUtility,
  getResourceUnknownUtility
} from "./ResourceSelectionPolicy.js?build=20260817-architecture-closure-final";

/*
功能
读取公开或合法已知定义的全局基础值。

调用方
extremeIndex 与默认隐藏选择。

输入
合法已知 definitionId。

输出
卡牌基础值或未知期望四。

读取状态
CARD_DEFINITIONS。

写入状态
无。

调用函数
无。

边界与不变量
只对调用方已经合法揭示的定义调用。
*/
function globalKnownValue(definitionId) {
  try {
    return getBaseCardAiValue(definitionId);
  } catch {
    return UNKNOWN_HAND_EXPECTED_VALUE;
  }
}

/*
功能
把一个已由执行边界选中的手牌位置整理为资源 Policy 候选。

调用方
CardSelectionPolicy.chooseZoneSelection。

输入
观察者、拥有者、卡牌、用途和 Belief counts。

输出
known/unknown 资源候选描述。

读取状态
自己手牌定义或观察者合法 aiMemory。

写入状态
无。

调用函数
getResourceDefinitionUtility、getResourceUnknownUtility。

边界与不变量
其他玩家未知卡不携带 cardId/definitionId，只返回聚合效用。
*/
function buildResourceHandCandidate(actor, owner, card, purpose, remainingCardCounts = null) {
  const definitionId = actor.id === owner.id
    ? card.definitionId
    : (actor.aiMemory.knownCardsByPlayer[owner.id]?.[card.id] ?? null);
  if (definitionId) {
    return {
      selectionKind: "known",
      cardId: card.id,
      definitionId,
      utility: getResourceDefinitionUtility(purpose, actor, owner, definitionId)
    };
  }
  return {
    selectionKind: "unknown",
    cardId: null,
    definitionId: null,
    utility: getResourceUnknownUtility(purpose, actor, owner, remainingCardCounts)
  };
}

export class CardSelectionPolicy {
  /*
  功能
  绑定局部选择所需随机、Belief、资源和转移能力。

  调用方
  AIController 组合根（统一组装依赖的位置） 与直接策略测试。

  输入
  random、remainingCounts、ResourceSelectionPolicy、TransferPolicy。

  输出
  可复用 CardSelectionPolicy 实例。

  读取状态
  保存显式窄依赖。

  写入状态
  写实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game 或 Controller；缺失必需能力立即抛错。
  */
  constructor({ random, remainingCounts, resourcePolicy, transferPolicy } = {}) {
    if (typeof random !== "function") {
      throw new TypeError("CardSelectionPolicy 缺少依赖：random");
    }
    if (typeof remainingCounts !== "function") {
      throw new TypeError("CardSelectionPolicy 缺少依赖：remainingCounts");
    }
    if (!resourcePolicy || typeof resourcePolicy.chooseHandCandidate !== "function") {
      throw new TypeError("CardSelectionPolicy 缺少依赖：resourcePolicy");
    }
    if (!transferPolicy || typeof transferPolicy.chooseHandCandidate !== "function") {
      throw new TypeError("CardSelectionPolicy 缺少依赖：transferPolicy");
    }
    this.random = random;
    this.remainingCounts = remainingCounts;
    this.resourcePolicy = resourcePolicy;
    this.transferPolicy = transferPolicy;
  }

  /*
  功能
  为窥探/窥隙从合法手牌位置中选择一个下标。

  调用方
  chooseHiddenCardIds 与 正式边界。

  输入
  合法记忆映射与已过滤候选卡数组。

  输出
  候选数组下标。

  读取状态
  合法已知定义与注入随机源。

  写入状态
  仅推进随机源。

  调用函数
  getRoleCardAiValue、random。

  边界与不变量
  优先从未知位置随机；未知耗尽后按已知基础值升序且同分保持原顺序。
  */
  peekIndex(known, cards) {
    const unknownIndices = [];
    for (let current = 0; current < cards.length; current += 1) {
      if (!known[cards[current].id]) unknownIndices.push(current);
    }
    if (unknownIndices.length) {
      return unknownIndices[Math.floor(this.random() * unknownIndices.length)];
    }
    const knownCards = cards
      .map((card, current) => ({ card, current, definitionId: known[card.id] }))
      .filter((entry) => entry.definitionId)
      .sort((left, right) => (
        globalKnownValue(left.definitionId)
        - globalKnownValue(right.definitionId)
      ));
    return knownCards[0]?.current ?? 0;
  }

  /*
  功能
  在合法已知与聚合未知位置间按价值方向选择下标。

  调用方
  正式边界 与直接策略测试。

  输入
  合法记忆、候选卡、方向、已知估值函数与未知期望。

  输出
  候选数组下标。

  读取状态
  合法已知定义与注入随机源。

  写入状态
  仅在未知胜出或全部未知时推进随机源。

  调用函数
  knownValueForDefinition、random。

  边界与不变量
  未知只用固定/显式期望比较；同分不击败最佳已知。
  */
  extremeIndex(
    known,
    cards,
    direction,
    knownValueForDefinition = globalKnownValue,
    unknownValue = UNKNOWN_HAND_EXPECTED_VALUE
  ) {
    const knownEntries = [];
    const unknownIndices = [];
    for (let current = 0; current < cards.length; current += 1) {
      const definitionId = known[cards[current].id];
      if (definitionId) {
        knownEntries.push({ current, value: knownValueForDefinition(definitionId) });
      } else {
        unknownIndices.push(current);
      }
    }
    if (!knownEntries.length) {
      return unknownIndices[Math.floor(this.random() * unknownIndices.length)] ?? 0;
    }
    const bestKnown = knownEntries.reduce((best, entry) => (
      direction === "highest"
        ? (entry.value > best.value ? entry : best)
        : (entry.value < best.value ? entry : best)
    ), knownEntries[0]);
    const unknownWins = unknownIndices.length > 0
      && (direction === "highest"
        ? unknownValue > bestKnown.value
        : unknownValue < bestKnown.value);
    if (unknownWins) {
      return unknownIndices[Math.floor(this.random() * unknownIndices.length)];
    }
    return bestKnown.current;
  }

  /*
  功能
  从执行边界已过滤的合法手牌位置中选择指定数量的实体 ID。

  调用方
  CardSelectionBoundary 正式边界。

  输入
  观察者、拥有者、合法候选、数量、排除 ID、用途与可选 Belief counts。

  输出
  按既有顺序选择的 cardId 数组。

  读取状态
  自己手牌、合法记忆、公开角色字段、Belief 与注入随机源。

  写入状态
  仅推进随机源；不修改输入候选。

  调用函数
  TransferPolicy、ResourceSelectionPolicy、peekIndex、getRoleCardAiValue。

  边界与不变量
  未知位置从本地候选数组随机，任何真实未知 definitionId 都不参与选择。
  */
  chooseHiddenCardIds({
    actor,
    owner,
    cards,
    count,
    excludedCardIds = null,
    context = null,
    resourceCounts = null
  }) {
    const selected = [];
    const known = actor.aiMemory.knownCardsByPlayer[owner.id] ?? {};
    const candidates = [...(cards ?? [])];
    const purpose = context?.purpose ?? null;
    const remainingCardCounts = resourceCounts !== null
      ? resourceCounts
      : ((purpose === "transfer" || purpose === "destroy" || purpose === "plunder")
        ? this.remainingCounts(actor)
        : null);
    while (selected.length < count && candidates.length) {
      let index = -1;
      if (purpose === "transfer") {
        const candidate = this.transferPolicy.chooseHandCandidate(
          actor,
          owner,
          context?.receiver,
          excludedCardIds,
          remainingCardCounts
        );
        if (!candidate) return selected;
        if (candidate.selectionKind === "known") {
          index = candidates.findIndex((card) => card.id === candidate.cardId);
        } else {
          const unknownIndices = [];
          for (let current = 0; current < candidates.length; current += 1) {
            if (!known[candidates[current].id]) unknownIndices.push(current);
          }
          index = unknownIndices[Math.floor(this.random() * unknownIndices.length)] ?? 0;
        }
        if (index < 0) return selected;
      } else if (actor.id === owner.id) {
        index = candidates.reduce((best, card, current) => (
          getRoleCardAiValue(actor.characterId, card.definitionId)
            < getRoleCardAiValue(actor.characterId, candidates[best].definitionId)
            ? current
            : best
        ), 0);
      } else if (purpose === "scout" || purpose === "spy-gap") {
        index = this.peekIndex(known, candidates);
      } else if (purpose === "destroy" || purpose === "plunder") {
        const knownCards = [];
        for (let current = 0; current < candidates.length; current += 1) {
          const definitionId = known[candidates[current].id];
          if (definitionId) {
            knownCards.push({ cardId: candidates[current].id, definitionId });
          }
        }
        const candidate = this.resourcePolicy.chooseHandCandidate({
          purpose,
          actor,
          owner,
          knownCards,
          unknownCount: candidates.length - knownCards.length,
          remainingCardCounts
        });
        if (!candidate) return selected;
        if (candidate.selectionKind === "known") {
          index = candidates.findIndex((card) => card.id === candidate.cardId);
        } else {
          const unknownIndices = [];
          for (let current = 0; current < candidates.length; current += 1) {
            if (!known[candidates[current].id]) unknownIndices.push(current);
          }
          index = unknownIndices[Math.floor(this.random() * unknownIndices.length)] ?? 0;
        }
        if (index < 0) return selected;
      } else {
        const knownCards = candidates
          .map((card, current) => ({ card, current, definitionId: known[card.id] }))
          .filter((entry) => entry.definitionId)
          .sort((left, right) => (
            globalKnownValue(left.definitionId)
            - globalKnownValue(right.definitionId)
          ));
        index = knownCards[0]?.current ?? Math.floor(this.random() * candidates.length);
      }
      selected.push(candidates.splice(Math.max(0, index), 1)[0].id);
    }
    return selected;
  }

  /*
  功能
  在执行边界提供的手牌候选与公开装备之间选择资源区域描述。

  调用方
  CardSelectionBoundary 正式边界。

  输入
  观察者、拥有者、用途、一个已选手牌候选、装备定义与 Belief counts。

  输出
  `{zone, cardId}` 或 null。

  读取状态
  合法记忆、公开装备与 ResourceSelectionPolicy。

  写入状态
  无。

  调用函数
  buildResourceHandCandidate、ResourceSelectionPolicy.chooseZone。

  边界与不变量
  非 destroy/plunder 保持旧装备优先条件；只输出身份描述，不返回或移动实体。
  */
  chooseZoneSelection({
    actor,
    owner,
    purpose = null,
    handCard = null,
    equipment = null,
    remainingCardCounts = null
  }) {
    if (purpose === "plunder" || purpose === "destroy") {
      const handCandidate = handCard
        ? buildResourceHandCandidate(
            actor,
            owner,
            handCard,
            purpose,
            remainingCardCounts
          )
        : null;
      const zoneChoice = this.resourcePolicy.chooseZone({
        purpose,
        actor,
        owner,
        handCandidate,
        equipmentDefinitionId: equipment?.definitionId ?? null
      });
      if (zoneChoice?.zone === "equipment" && equipment) {
        return { zone: "equipment", cardId: equipment.id ?? null };
      }
      if (zoneChoice?.zone === "hand" && handCard) {
        return { zone: "hand", cardId: handCard.id };
      }
      return null;
    }
    if (equipment && (!owner.hand.length || (actor.id !== owner.id && globalKnownValue(equipment.definitionId) >= 7))) {
      return { zone: "equipment", cardId: equipment.id ?? null };
    }
    if (handCard) return { zone: "hand", cardId: handCard.id };
    return equipment ? { zone: "equipment", cardId: equipment.id ?? null } : null;
  }

  /*
  功能
  计算观察者对一张自己或他人手牌的合法期望值。

  调用方
  CardSelectionBoundary 正式边界 与直接测试。

  输入
  观察者、拥有者与卡牌实体。

  输出
  自己/合法已知定义的值，或未知期望四。

  读取状态
  自己手牌定义、合法 aiMemory 与 CardValue。

  写入状态
  无。

  调用函数
  getRoleCardAiValue。

  边界与不变量
  绝不读取其他玩家未知卡的真实 definitionId。
  */
  expectedCardValue(actor, owner, card) {
    if (actor.id === owner.id) {
      return getRoleCardAiValue(actor.characterId, card.definitionId);
    }
    const definitionId = actor.aiMemory.knownCardsByPlayer[owner.id]?.[card.id] ?? null;
    return definitionId
      ? globalKnownValue(definitionId)
      : UNKNOWN_HAND_EXPECTED_VALUE;
  }

  /*
  功能
  从公开牌池按角色卡牌价值选择最佳实体 ID。

  调用方
  CardSelectionBoundary 正式边界。

  输入
  当前玩家和公开合法卡牌数组。

  输出
  最佳 cardId 或 null。

  读取状态
  公开 definitionId 与 CardValue。

  写入状态
  无；不修改原数组。

  调用函数
  getRoleCardAiValue。

  边界与不变量
  同分保持原始公开池顺序。
  */
  choosePublicCardId(player, cards) {
    return [...cards].sort((left, right) => (
      getRoleCardAiValue(player.characterId, right.definitionId)
      - getRoleCardAiValue(player.characterId, left.definitionId)
    ))[0]?.id ?? null;
  }

  /*
  功能
  从执行边界已确认的合法卡牌中选择弃牌实体 ID。

  调用方
  CardSelectionBoundary 正式边界。

  输入
  玩家、合法卡牌、数量与公开弃牌上下文。

  输出
  cardId 数组。

  读取状态
  ResourceSelectionPolicy 与 CardValue。

  写入状态
  无。

  调用函数
  ResourceSelectionPolicy.chooseDiscards。

  边界与不变量
  实际实体解析和移动留在执行边界。
  */
  chooseDiscardIds(player, cards, count, context = {}) {
    return this.resourcePolicy.chooseDiscards(player, cards, count, context)
      .map((card) => card.id);
  }
}
