/*
模块职责
拥有 AI 在合法转移来源、接收者与手牌候选之间的局部评分和稳定选择。

上游
AIController、CardSelectionPolicy、ActionGenerator 与正式边界。

下游
value/CardValue、value/ThreatValue 与 state/Probability。

状态边界
只读调用方提供的公开/过滤玩家、合法候选与 Belief 计数，不移动实体牌。

信息边界
其他玩家未知手牌只作为聚合未知候选；只有自己手牌、过滤 knownCards 或合法 aiMemory 可提供定义。

架构约束
不调用 RuleEngine 生成合法集合，不依赖 Planner/Controller/UI，也不执行规则或构造 Simulator。
*/
import {
  getBaseCardAiValue,
  getRoleCardAiValue
} from "../value/CardValue.js?build=20260815-shadow-agent-p1-slot";
import { ThreatCalculator } from "../value/ThreatValue.js?build=20260815-shadow-agent-p1-slot";
import {
  PROBABILITY_EPSILON,
  totalBranchProbability
} from "../state/Probability.js?build=20260815-shadow-agent-p1-slot";

export const MIN_TRANSFER_UTILITY = 0.5;
export const UNKNOWN_HAND_EXPECTED_VALUE = 4;
const HUMAN_ALLY_HAND_PROTECTION = 7;
const MIN_ENEMY_REDISTRIBUTION_THREAT_GAP = 4;
const MIN_ENEMY_REDISTRIBUTION_UTILITY = 5;

/*
功能
读取一张过滤卡牌实体仍可用的概率质量。

调用方
handCount、knownHandDefinitionIds 与 knownHandCandidateEntries。

输入
可选 availability 状态分支的卡牌摘要。

输出
可用概率；无分支字段时为一。

读取状态
只读卡牌概率字段。

写入状态
无。

调用函数
totalBranchProbability。

边界与不变量
优先使用条件状态分支，不能把部分概率身份当成确定已知。
*/
function cardAvailability(card) {
  if (Array.isArray(card?.availabilityStateBranches)) {
    return totalBranchProbability(
      card.availabilityStateBranches.filter((branch) => branch.available)
    );
  }
  if (Array.isArray(card?.availabilityBranches)) {
    return totalBranchProbability(card.availabilityBranches);
  }
  return 1;
}

/*
功能
计算排除指定实体后的一名玩家手牌期望数量。

调用方
expectedHandValue、chooseTransferHandCandidate、evaluateTransferCombination、threatView。

输入
真实/过滤玩家与可选排除 ID 集合。

输出
非负手牌期望数量。

读取状态
只读 hand/handCount 和卡牌 availability。

写入状态
无。

调用函数
cardAvailability。

边界与不变量
没有实体 hand 的其他玩家只使用公开 handCount。
*/
function handCount(player, excludedCardIds = null) {
  if (Array.isArray(player?.hand)) {
    return player.hand
      .filter((card) => !excludedCardIds?.has(card.id))
      .reduce((sum, card) => sum + cardAvailability(card), 0);
  }
  return Math.max(0, Number(player?.handCount ?? 0));
}

/*
功能
判断过滤卡牌身份是否在全部概率世界中可用。

调用方
knownHandDefinitionIds 与 knownHandCandidateEntries。

输入
卡牌摘要。

输出
确定已知可用时为 true。

读取状态
只读 availability。

写入状态
无。

调用函数
cardAvailability。

边界与不变量
部分或零概率身份必须留在 unknown 质量中。
*/
function isCertainKnown(card) {
  return cardAvailability(card) >= 1 - PROBABILITY_EPSILON;
}

/*
功能
列出观察者合法知道且确定可用的手牌定义。

调用方
expectedHandValue。

输入
观察者、资源拥有者与排除 ID。

输出
definitionId 数组。

读取状态
自己手牌、过滤 knownCards 或合法 aiMemory。

写入状态
无。

调用函数
isCertainKnown。

边界与不变量
绝不从其他玩家真实未知 hand 读取 definitionId。
*/
function knownHandDefinitionIds(actor, owner, excludedCardIds = null) {
  if (!actor || !owner) return [];
  if (actor.id === owner.id) {
    return (actor.hand ?? [])
      .filter((card) => !excludedCardIds?.has(card.id))
      .filter(isCertainKnown)
      .map((card) => card.definitionId)
      .filter(Boolean);
  }
  if (Array.isArray(owner.knownCards)) {
    return owner.knownCards
      .filter((card) => !excludedCardIds?.has(card.cardId))
      .filter(isCertainKnown)
      .map((card) => card.definitionId)
      .filter(Boolean);
  }
  return Object.entries(actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {})
    .filter(([cardId]) => !excludedCardIds?.has(cardId))
    .map(([, definitionId]) => definitionId)
    .filter(Boolean);
}

/*
功能
列出观察者合法知道且确定可用的手牌实体候选。

调用方
chooseTransferHandCandidate。

输入
观察者、资源拥有者与排除 ID。

输出
只含 cardId/definitionId 的候选数组。

读取状态
自己手牌、过滤 knownCards 或合法 aiMemory。

写入状态
无。

调用函数
isCertainKnown。

边界与不变量
未知实体不进入输出；三种合法知识来源保持既有优先级。
*/
function knownHandCandidateEntries(actor, owner, excludedCardIds = null) {
  if (actor.id === owner.id) {
    return (owner.hand ?? [])
      .filter((card) => !excludedCardIds?.has(card.id))
      .filter(isCertainKnown)
      .map((card) => ({ cardId: card.id, definitionId: card.definitionId }))
      .filter((entry) => entry.definitionId);
  }
  if (Array.isArray(owner.knownCards)) {
    return owner.knownCards
      .filter((card) => !excludedCardIds?.has(card.cardId))
      .filter(isCertainKnown)
      .map((card) => ({ cardId: card.cardId, definitionId: card.definitionId }))
      .filter((entry) => entry.definitionId);
  }
  return Object.entries(actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {})
    .filter(([cardId]) => !excludedCardIds?.has(cardId))
    .map(([cardId, definitionId]) => ({ cardId, definitionId }))
    .filter((entry) => entry.definitionId);
}

/*
功能
通过正式 CardValue 读取角色相关值，缺少角色身份时回退基础值。

调用方
cardSituationValue。

输入
玩家公开摘要与 definitionId。

输出
角色或基础卡牌值。

读取状态
只读 CardValue。

写入状态
无。

调用函数
getRoleCardAiValue、getBaseCardAiValue。

边界与不变量
非空非法 generalId 保持抛错，不静默吞掉配置错误。
*/
function roleOrBaseCardAiValue(player, definitionId) {
  return player?.generalId
    ? getRoleCardAiValue(player.generalId, definitionId)
    : getBaseCardAiValue(definitionId);
}

/*
功能
计算一张合法已知牌对指定角色的转移情境价值。

调用方
expectedHandValue、expectedUnknownSituationValue、chooseTransferHandCandidate。

输入
definitionId 与公开/过滤玩家摘要。

输出
既有转移 policy value。

读取状态
CardValue 与玩家生命、能量、技能、盾和攻击槽摘要。

写入状态
无。

调用函数
roleOrBaseCardAiValue。

边界与不变量
数值与条件完全沿用冻结基线，不成为 final transition value。
*/
export function cardSituationValue(definitionId, player) {
  const base = roleOrBaseCardAiValue(player, definitionId);
  const hp = Number(player?.hp ?? player?.maxHp ?? 0);
  const maxHp = Number(player?.maxHp ?? hp);
  const shield = Number(player?.shield ?? 0);
  const missingHp = Math.max(0, maxHp - hp);
  let value = base;
  if (definitionId === "recover") {
    if (hp >= maxHp) value -= 2;
    if (hp <= 2) value += 7;
    value += Math.min(2, missingHp);
  } else if (definitionId === "block") {
    if (hp <= 2) value += 6;
  } else if (definitionId === "charge") {
    const missingEnergy = Math.max(
      0,
      Number(player?.maxEnergy ?? player?.energy ?? 0) - Number(player?.energy ?? 0)
    );
    value += Math.min(2, missingEnergy);
    const activeSkillId = player?.activeSkillId ?? player?.general?.activeSkillIds?.[0] ?? null;
    const activeSkillCost = Number(player?.activeSkillCost ?? player?.general?.activeCost ?? 0);
    const activeSkillUses = Number(
      player?.activeSkillUses
      ?? player?.turnFlags?.activeSkillUseCounts?.[activeSkillId]
      ?? 0
    );
    const activeSkillLimit = Number(
      player?.activeSkillLimit ?? player?.general?.activeLimitPerTurn ?? 0
    );
    if (
      activeSkillId
      && activeSkillLimit > 0
      && activeSkillUses < activeSkillLimit
      && activeSkillCost > 0
      && Number(player?.energy ?? 0) + 1 >= activeSkillCost
    ) value += 2;
  } else if (definitionId === "shield") {
    if (hp <= 2) value += 3;
    if (shield >= 2) value -= 2;
  } else if (definitionId === "assault") {
    const attackLimit = Number(player?.attackLimit ?? player?.turnFlags?.attackLimit ?? 0);
    const attackUsed = Number(player?.attackUsed ?? player?.turnFlags?.attackUsed ?? 0);
    if (attackLimit > 0 && attackUsed < attackLimit) value += 1;
  }
  return value;
}

/*
功能
计算未知手牌对指定角色的剩余池加权情境期望。

调用方
expectedHandValue 与 chooseTransferHandCandidate。

输入
玩家公开摘要与可选 remaining counts。

输出
动态期望或固定值四。

读取状态
只读 Belief counts 与 CardValue policy 解释。

写入状态
无。

调用函数
cardSituationValue。

边界与不变量
只按定义数量聚合，不与任一未知实体绑定。
*/
function expectedUnknownSituationValue(player, remainingCardCounts) {
  if (
    remainingCardCounts !== null
    && typeof remainingCardCounts === "object"
    && !Array.isArray(remainingCardCounts)
  ) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      weightedSum += count * cardSituationValue(definitionId, player);
      totalWeight += count;
    }
    if (totalWeight > 0) return weightedSum / totalWeight;
  }
  return UNKNOWN_HAND_EXPECTED_VALUE;
}

/*
功能
计算已知与聚合未知候选中指定方向的手牌预计价值。

调用方
直接测试与转移策略诊断。

输入
观察者、拥有者、方向、排除 ID 与 remaining counts。

输出
最高或最低的情境价值。

读取状态
合法已知身份、公开手牌数量与 Belief。

写入状态
无。

调用函数
knownHandDefinitionIds、handCount、expectedUnknownSituationValue。

边界与不变量
未知只贡献一个聚合期望候选，不读取真实牌面。
*/
export function expectedHandValue(
  actor,
  owner,
  direction = "lowest",
  excludedCardIds = null,
  remainingCardCounts = null
) {
  const definitionIds = knownHandDefinitionIds(actor, owner, excludedCardIds);
  const knownValues = definitionIds
    .map((definitionId) => cardSituationValue(definitionId, owner))
    .filter(Number.isFinite);
  const unknownCount = Math.max(0, handCount(owner, excludedCardIds) - definitionIds.length);
  const candidates = [...knownValues];
  if (unknownCount > 0) {
    candidates.push(expectedUnknownSituationValue(owner, remainingCardCounts));
  }
  if (!candidates.length) return UNKNOWN_HAND_EXPECTED_VALUE;
  return direction === "highest" ? Math.max(...candidates) : Math.min(...candidates);
}

/*
功能
把一张候选从来源移到接收者的双方阵营价值组合为转移效用。

调用方
chooseTransferHandCandidate。

输入
来源/接收者是否同阵营及双方卡牌情境值。

输出
转移效用或负无穷。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
禁止从己方送给敌方；其余三类组合公式保持冻结。
*/
function transferCardUtility(sourceIsAlly, receiverIsAlly, sourceValue, receiverValue) {
  if (sourceIsAlly && receiverIsAlly) return receiverValue - sourceValue;
  if (!sourceIsAlly && receiverIsAlly) return sourceValue + receiverValue;
  if (!sourceIsAlly && !receiverIsAlly) return sourceValue - receiverValue;
  return Number.NEGATIVE_INFINITY;
}

/*
功能
在一个合法 source/receiver 对的已知与未知手牌候选中选择最佳候选。

调用方
evaluateTransferCombination、CardSelectionPolicy 与测试。

输入
观察者、合法来源/接收者、排除 ID 与 Belief counts。

输出
known/unknown 候选描述或 null。

读取状态
合法记忆、公开状态、CardValue 和 Belief。

写入状态
无。

调用函数
knownHandCandidateEntries、handCount、cardSituationValue、expectedUnknownSituationValue、transferCardUtility。

边界与不变量
未知输出不含 cardId/definitionId；同分已知优先，再按 cardId 稳定排序。
*/
export function chooseTransferHandCandidate(
  actor,
  from,
  receiver,
  excludedCardIds = null,
  remainingCardCounts = null
) {
  if (!actor || !from || !receiver) return null;
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;
  if (sourceIsAlly && !receiverIsAlly) return null;
  const knownEntries = knownHandCandidateEntries(actor, from, excludedCardIds);
  const unknownCount = Math.max(0, handCount(from, excludedCardIds) - knownEntries.length);
  const scored = knownEntries.map((entry) => {
    const sourceValue = cardSituationValue(entry.definitionId, from);
    const receiverValue = cardSituationValue(entry.definitionId, receiver);
    return {
      selectionKind: "known",
      cardId: entry.cardId,
      definitionId: entry.definitionId,
      expectedValue: receiverValue,
      utility: transferCardUtility(
        sourceIsAlly,
        receiverIsAlly,
        sourceValue,
        receiverValue
      ),
      availableUnknownCount: 0
    };
  });
  if (unknownCount > 0) {
    const sourceUnknownValue = expectedUnknownSituationValue(from, remainingCardCounts);
    const receiverUnknownValue = expectedUnknownSituationValue(receiver, remainingCardCounts);
    scored.push({
      selectionKind: "unknown",
      cardId: null,
      definitionId: null,
      expectedValue: receiverUnknownValue,
      utility: transferCardUtility(
        sourceIsAlly,
        receiverIsAlly,
        sourceUnknownValue,
        receiverUnknownValue
      ),
      availableUnknownCount: unknownCount
    });
  }
  if (!scored.length) return null;
  scored.sort((left, right) => right.utility - left.utility
    || (left.selectionKind === "known" ? 0 : 1)
      - (right.selectionKind === "known" ? 0 : 1)
    || String(left.cardId ?? "").localeCompare(String(right.cardId ?? "")));
  return scored[0];
}

/*
功能
把真实 Player 或过滤快照归一化为 ThreatValue 可读的公开视图。

调用方
enemyThreatGap 与直接策略测试。

输入
玩家或过滤玩家摘要。

输出
不含未知牌定义的 threat view。

读取状态
只读公开状态和 handCount。

写入状态
无。

调用函数
handCount。

边界与不变量
保留 player ID 以让合法近期攻击者记忆继续参与评分。
*/
export function threatView(player) {
  return {
    id: player?.id,
    alive: Boolean(player?.alive),
    battleTeam: player?.battleTeam,
    hp: Number(player?.hp ?? 0),
    maxHp: Number(player?.maxHp ?? player?.hp ?? 0),
    shield: Number(player?.shield ?? 0),
    energy: Number(player?.energy ?? 0),
    handCount: handCount(player),
    statuses: Array.isArray(player?.statuses)
      ? player.statuses
      : Object.keys(player?.statuses ?? {}),
    roleTags: player?.roleTags ?? player?.general?.roleTags ?? [],
    tags: player?.tags ?? player?.general?.tags ?? []
  };
}

/*
功能
计算敌方来源相对敌方接收者的公开威胁差。

调用方
evaluateTransferCombination。

输入
行动者、来源与接收者。

输出
ThreatValue 差值。

读取状态
公开玩家字段与行动者合法记忆。

写入状态
无。

调用函数
ThreatCalculator.calculate、threatView。

边界与不变量
不读取任一未知手牌定义。
*/
function enemyThreatGap(actor, from, receiver) {
  const memory = actor?.aiMemory ?? {};
  return ThreatCalculator.calculate(threatView(actor), threatView(from), memory)
    - ThreatCalculator.calculate(threatView(actor), threatView(receiver), memory);
}

/*
功能
对一个已合法枚举的 source/receiver/zone 组合计算候选和完整转移分数。

调用方
scoreTransferCombination 与 buildTransferCandidates。

输入
行动者、合法来源/接收者/区域、排除 ID 与 Belief counts。

输出
`{candidate, score}`。

读取状态
公开资源、合法记忆、CardValue、ThreatValue 与 Belief。

写入状态
无。

调用函数
chooseTransferHandCandidate、handCount、enemyThreatGap。

边界与不变量
每个组合只选择候选一次；所有门槛、保护值和浮点运算顺序保持冻结。
*/
function evaluateTransferCombination({
  actor,
  from,
  receiver,
  zone,
  excludedCardIds = null,
  remainingCardCounts = null
}) {
  if (!actor || !from || !receiver || from.id === receiver.id) {
    return { candidate: null, score: Number.NEGATIVE_INFINITY };
  }
  const sourceIsAlly = from.battleTeam === actor.battleTeam;
  const receiverIsAlly = receiver.battleTeam === actor.battleTeam;
  if (sourceIsAlly && !receiverIsAlly) {
    return { candidate: null, score: Number.NEGATIVE_INFINITY };
  }
  if (zone !== "hand" || handCount(from, excludedCardIds) <= 0) {
    return { candidate: null, score: Number.NEGATIVE_INFINITY };
  }
  const candidate = chooseTransferHandCandidate(
    actor,
    from,
    receiver,
    excludedCardIds,
    remainingCardCounts
  );
  if (!candidate) return { candidate: null, score: Number.NEGATIVE_INFINITY };
  const fromLimit = Math.max(0, Number(from.hp ?? 0));
  const receiverLimit = Math.max(0, Number(receiver.hp ?? 0));
  const sourceOverflow = Math.max(0, handCount(from, excludedCardIds) - fromLimit);
  const receiverSpace = Math.max(0, receiverLimit - handCount(receiver, excludedCardIds));
  let score = candidate.utility;
  if (sourceIsAlly && receiverIsAlly) score += Math.min(sourceOverflow, receiverSpace) * 4;
  if (!sourceIsAlly && sourceOverflow > 0) score -= Math.min(sourceOverflow, 2) * 2;
  if (receiverIsAlly && receiverSpace === 0) score -= candidate.expectedValue * 0.75;
  if (!receiverIsAlly && receiverSpace === 0) score += 1;
  if (sourceIsAlly && from.controllerType === "human") score -= HUMAN_ALLY_HAND_PROTECTION;
  if (!sourceIsAlly && !receiverIsAlly) {
    if (enemyThreatGap(actor, from, receiver) < MIN_ENEMY_REDISTRIBUTION_THREAT_GAP) {
      return { candidate, score: Number.NEGATIVE_INFINITY };
    }
    if (score < MIN_ENEMY_REDISTRIBUTION_UTILITY) {
      return { candidate, score: Number.NEGATIVE_INFINITY };
    }
  }
  return { candidate, score };
}

/*
功能
返回一个已合法枚举转移组合的完整策略分数。

调用方
正式边界 与直接测试。

输入
evaluateTransferCombination 所需上下文。

输出
数值分数或负无穷。

读取状态
只读输入。

写入状态
无。

调用函数
evaluateTransferCombination。

边界与不变量
不生成 RuleEngine 合法候选。
*/
export function scoreTransferCombination(options) {
  return evaluateTransferCombination(options).score;
}

/*
功能
从调用方提供的合法来源与接收者集合构建稳定转移候选。

调用方
CardSelectionBoundary、ActionGenerator 与直接测试。

输入
行动者、合法 sources、接收者查询和可选限制/Belief。

输出
完整评分候选数组。

读取状态
只读合法集合与策略输入。

写入状态
无。

调用函数
evaluateTransferCombination、handCount、getReceivers。

边界与不变量
getReceivers 必须由 RuleEngine/Generator 边界提供；本函数不把策略拒绝变成规则非法。
*/
export function buildTransferCandidates({
  actor,
  sources,
  getReceivers,
  allowedReceiverIds = null,
  excludedCardIds = null,
  remainingCardCounts = null
}) {
  const candidates = [];
  for (const from of sources ?? []) {
    const receivers = (getReceivers(from) ?? []).filter((receiver) => (
      !allowedReceiverIds || allowedReceiverIds.has(receiver.id)
    ));
    for (const receiver of receivers) {
      if (handCount(from, excludedCardIds) <= 0) continue;
      const evaluation = evaluateTransferCombination({
        actor,
        from,
        receiver,
        zone: "hand",
        excludedCardIds,
        remainingCardCounts
      });
      candidates.push({
        sourceId: from.id,
        sourceSeatIndex: from.seatIndex,
        receiverId: receiver.id,
        zone: "hand",
        score: evaluation.score,
        selectionKind: evaluation.candidate?.selectionKind ?? null,
        cardId: evaluation.candidate?.cardId ?? null,
        definitionId: evaluation.candidate?.definitionId ?? null,
        expectedValue: evaluation.candidate?.expectedValue ?? null,
        availableUnknownCount: evaluation.candidate?.availableUnknownCount ?? 0
      });
    }
  }
  return candidates;
}

/*
功能
从已评分合法候选中按冻结 tie-break 选择达到最低效用的最佳方案。

调用方
TransferPolicy、CardSelectionBoundary、ActionGenerator 与测试。

输入
候选数组与可选最低效用。

输出
冻结选择描述或 null。

读取状态
只读候选。

写入状态
无。

调用函数
无。

边界与不变量
顺序为分数降序、来源座次升序、receiver ID 升序；不重算候选分数。
*/
export function chooseBestPositiveTransfer(candidates, minimumUtility = MIN_TRANSFER_UTILITY) {
  const best = [...(candidates ?? [])].sort((left, right) => right.score - left.score
    || (left.sourceSeatIndex ?? 0) - (right.sourceSeatIndex ?? 0)
    || String(left.receiverId).localeCompare(String(right.receiverId)))[0];
  return best && best.score >= minimumUtility
    ? Object.freeze({
        sourceId: best.sourceId,
        receiverId: best.receiverId,
        zone: best.zone,
        score: best.score,
        selectionKind: best.selectionKind ?? null,
        cardId: best.cardId ?? null,
        definitionId: best.definitionId ?? null,
        expectedValue: best.expectedValue ?? null,
        availableUnknownCount: best.availableUnknownCount ?? 0
      })
    : null;
}

export class TransferPolicy {
  /*
  功能
  从调用方提供的合法 source/receiver 集合选择最佳转移描述。

  调用方
  AIController、CardSelectionBoundary 与 ActionGenerator。

  输入
  buildTransferCandidates 所需的合法候选上下文。

  输出
  达到既有最低效用的冻结选择描述或 null。

  读取状态
  只读公开/过滤状态、合法记忆与 Belief。

  写入状态
  无。

  调用函数
  buildTransferCandidates、chooseBestPositiveTransfer。

  边界与不变量
  不调用 RuleEngine、不解析或移动真实实体，每个组合只评分一次。
  */
  choose(context) {
    return chooseBestPositiveTransfer(buildTransferCandidates(context));
  }

  /*
  功能
  为执行边界选择一个合法 source/receiver 对中的手牌候选类型。

  调用方
  CardSelectionPolicy。

  输入
  观察者、合法来源/接收者、排除 ID 与 Belief。

  输出
  known/unknown 候选描述或 null。

  读取状态
  只读合法观察与 Belief。

  写入状态
  无。

  调用函数
  chooseTransferHandCandidate。

  边界与不变量
  未知候选不返回实体身份。
  */
  chooseHandCandidate(...args) {
    return chooseTransferHandCandidate(...args);
  }
}
