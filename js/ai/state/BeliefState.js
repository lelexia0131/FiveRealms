/*
模块职责
从合法可见事实、私有记忆与剩余牌计数推导隐藏牌概率和采样世界。

上游
AI 状态组合入口、Knowledge、Planner 隐藏世界采样与状态契约测试。

下游
卡牌数量配置。

状态边界
只读 VisibleState、Knowledge 或合法 GameState 区域，创建不可变 BeliefState 或独立采样结果。

信息边界
只允许观察者手牌、公开牌区、观察者合法记忆和未知槽位数量；禁止敌方真实未知牌面。

架构约束
不得生成动作、计算价值、写 GameState，概率分布必须归一且不持有输入计数引用。
*/
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { cardAvailability } from "../value/CardValue.js";
import {
  PROBABILITY_CLASSIFICATION,
  PROBABILITY_EPSILON
} from "./Probability.js";
import {
  HIDDEN_POOL_DEFINITION_IDS,
  createHiddenPoolState,
  hypergeometricCountDistribution,
  queryHiddenPool
} from "./HiddenPool.js";

const CARD_COUNTS = RULESET_DEFINITION.deckComposition;

/*
功能
复制并冻结合法的剩余牌计数快照。

调用方
createBeliefState。

输入
定义 ID 到剩余实例数的普通对象，或空值。

输出
冻结副本；非普通对象返回 null。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不得修改或保留调用方对象引用。
*/
function normalizeRemainingCardCounts(remainingCardCounts) {
  if (!remainingCardCounts || typeof remainingCardCounts !== "object" || Array.isArray(remainingCardCounts)) {
    return null;
  }
  return Object.freeze({ ...remainingCardCounts });
}

















/*
功能
计算有限剩余牌池中至少得到指定总数量目标牌的概率。

调用方
ResponsePolicy 与正式概率测试。

输入
剩余总数、目标牌数、未知槽位数、所需总数与已知数量偏移。

输出
零到一的超几何尾概率。

读取状态
无。

写入状态
无。

调用函数
hypergeometricCountDistribution。

边界与不变量
所需总数已由 offset 满足时返回一；不使用独立同分布近似。
*/
export function hypergeometricProbabilityAtLeast(
  populationSize,
  successCount,
  draws,
  required,
  offset = 0
) {
  if (required <= offset) return 1;
  return hypergeometricCountDistribution(
    populationSize,
    successCount,
    draws,
    offset
  ).reduce((sum, branch) => sum + (branch.count >= required ? branch.probability : 0), 0);
}


/*
功能
从观察者依法可见的 GameState 区域扣除已知实体，得到剩余牌计数。

调用方
Knowledge.remainingCounts。

输入
观察者 Player 与当前 GameState。

输出
新的定义 ID 到剩余实例数对象。

读取状态
本人手牌、公开牌区、公开装备和本人合法 AI 记忆。

写入状态
无。

调用函数
无。

边界与不变量
同一实体 ID 只扣除一次，不读取其他玩家手牌或牌堆未来顺序。
*/
export function deriveRemainingCardCounts(viewer, gameState) {
  const remaining = { ...CARD_COUNTS };
  const seenIds = new Set();
  /*
  功能
  从剩余计数中安全消费一个依法可见的卡牌实体。

  调用方
  deriveRemainingCardCounts 内的合法牌区与记忆遍历。

  输入
  带 definitionId 以及可选 id/cardId 的卡牌记录。

  输出
  无。

  读取状态
  闭包 remaining、seenIds。

  写入状态
  扣减闭包 remaining，并登记已消费实体 ID。

  调用函数
  无。

  边界与不变量
  非法定义忽略，同一实体 ID 最多消费一次，计数不得为负。
  */
  const consume = (entry) => {
    if (!entry || typeof entry.definitionId !== "string") return;
    if (!Object.hasOwn(remaining, entry.definitionId)) return;
    const entityId = entry.id ?? entry.cardId ?? null;
    if (entityId !== null) {
      if (seenIds.has(entityId)) return;
      seenIds.add(entityId);
    }
    remaining[entry.definitionId] = Math.max(0, remaining[entry.definitionId] - 1);
  };
  (viewer?.hand ?? []).forEach(consume);
  (gameState?.deck?.discardPile ?? []).forEach(consume);
  (gameState?.deck?.resolvingCards ?? []).forEach(consume);
  (gameState?.deck?.judgmentZone ?? []).forEach(consume);
  (gameState?.players ?? []).forEach((player) => {
    if (player?.equipment) consume(player.equipment);
  });
  (gameState?.publicCardPool ?? []).forEach(consume);
  Object.values(viewer?.aiMemory?.knownCardsByPlayer ?? {}).forEach((records) => {
    Object.entries(records ?? {}).forEach(([cardId, definitionId]) => consume({ cardId, definitionId }));
  });
  return remaining;
}

/*
功能
从剩余牌计数计算下一未知牌为指定定义的概率。

调用方
Knowledge.probability。

输入
剩余牌计数与卡牌定义 ID。

输出
零到一之间的概率。

读取状态
CARD_COUNTS、剩余牌计数。

写入状态
无。

调用函数
无。

边界与不变量
未知定义或空牌池返回零。
*/
export function probabilityFromRemainingCounts(remaining, definitionId) {
  if (!Object.hasOwn(CARD_COUNTS, definitionId)) return 0;
  const total = Object.values(remaining).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;
  return remaining[definitionId] / total;
}

/*
功能
组合不可变 BeliefState，集中保存剩余牌池和逐玩家隐藏牌分布。

调用方
createStateContracts、状态契约测试。

输入
观察者 ID、VisibleState、Knowledge 与可选剩余牌计数。

输出
冻结的 BeliefState。

读取状态
VisibleState 玩家槽位、Knowledge 合法记忆、卡牌配置密度。

写入状态
无。

调用函数
normalizeRemainingCardCounts、createHiddenPoolState、queryHiddenPool。

边界与不变量
同一输入必须确定性输出，任何敌方真实未知牌换面都不得改变结果。
*/
export function createBeliefState(viewerId, visibleState, knowledgeState, remainingCardCounts = null) {
  const counts = normalizeRemainingCardCounts(remainingCardCounts);
  const slotsByBucket = Object.fromEntries(visibleState.players.map((player) => {
    const knownCards = player.id === viewerId
      ? (player.hand ?? [])
      : (knowledgeState.knownCardsByPlayer[player.id] ?? []);
    return [player.id, player.id === viewerId
      ? 0
      : Math.max(0, Math.floor(Number(player.handCount) || 0) - knownCards.length)];
  }));
  const hiddenPoolState = createHiddenPoolState({
    slotsByBucket,
    cardCounts:counts ?? CARD_COUNTS
  });
  const playersById = Object.fromEntries(visibleState.players.map((player) => {
    const knownCards = player.id === viewerId
      ? (player.hand ?? [])
      : (knowledgeState.knownCardsByPlayer[player.id] ?? []);
    const estimates = Object.fromEntries(HIDDEN_POOL_DEFINITION_IDS.map((definitionId) => {
      const knownCount = knownCards.filter((card) => card.definitionId === definitionId).length;
      const distribution = queryHiddenPool(hiddenPoolState, {
        definitionId,
        bucketId:player.id
      }).distribution.map((branch) => Object.freeze({
        count:branch.count + knownCount,
        probability:branch.probability
      }));
      return [definitionId, {
        distribution:Object.freeze(distribution),
        expected:distribution.reduce(
          (sum, branch) => sum + branch.count * branch.probability, 0
        ),
        atLeastOne:distribution.reduce(
          (sum, branch) => sum + (branch.count >= 1 ? branch.probability : 0), 0
        ),
        atLeastTwo:distribution.reduce(
          (sum, branch) => sum + (branch.count >= 2 ? branch.probability : 0), 0
        )
      }];
    }));
    const recover = estimates.recover;
    const block = estimates.block;
    const counter = estimates.counter;
    const assault = estimates.assault;
    return [player.id, Object.freeze({
      expectedRecoverCount:recover.expected,
      recoverCountDistribution:recover.distribution,
      expectedBlockCount:block.expected,
      blockProbability:block.atLeastOne,
      twoBlockProbability:block.atLeastTwo,
      blockCountDistribution:block.distribution,
      counterProbability:counter.atLeastOne,
      counterCountDistribution:counter.distribution,
      expectedAssaultCount:assault.expected,
      assaultResponseProbability:assault.atLeastOne,
      assaultCountDistribution:assault.distribution
    })];
  }));
  return Object.freeze({
    classification:PROBABILITY_CLASSIFICATION.BELIEF_PROBABILITY,
    remainingCardCounts:counts,
    hiddenPoolState,
    playersById:Object.freeze(playersById)
  });
}

/*
功能
按当前剩余实例数随机抽取一个定义并原地消费该采样世界的计数。

调用方
sampleHiddenWorlds。

输入
单个采样世界的可变剩余计数与零到一随机数函数。

输出
被抽中的卡牌定义 ID；无可用实例时抛错。

读取状态
采样世界剩余计数。

写入状态
扣减该采样世界中被抽中的定义计数。

调用函数
random。

边界与不变量
每个未知槽位必须消费恰好一个可用实例，不能跨世界共享计数。
*/
function pickDefinition(remaining, random) {
  const entries = Object.entries(remaining).filter(([, value]) => Number.isFinite(value) && value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) throw new Error("隐藏世界抽样失败：未知位置超过该世界可用剩余牌数");
  let roll = random() * total;
  for (const [definitionId, countValue] of entries) {
    if (roll < countValue) {
      remaining[definitionId] = countValue - 1;
      return definitionId;
    }
    roll -= countValue;
  }
  const [definitionId, countValue] = entries.at(-1);
  remaining[definitionId] = countValue - 1;
  return definitionId;
}

/*
功能
从 SearchState 的合法 Belief 信息采样彼此独立的隐藏手牌世界。

调用方
Knowledge.sampleHiddenWorlds、Planner。

输入
观察者、SearchState、非负样本数与随机函数。

输出
显式 MONTE CARLO ESTIMATE；worlds 中每个样本按玩家 ID 给出确定已知牌加采样未知牌定义。

读取状态
SearchState 剩余计数、玩家 handCount 与 knownCards。

写入状态
仅写每个样本私有的剩余计数副本。

调用函数
cardAvailability、pickDefinition。

边界与不变量
不得回读 Game；部分概率身份按未知质量处理，已知实体不重复采样，各世界计数完全隔离。
*/
export function sampleHiddenWorlds(viewer, searchState, count, random) {
  const rootCounts = searchState.remainingCardCounts;
  if (!rootCounts || typeof rootCounts !== "object" || Array.isArray(rootCounts)) {
    throw new Error("sampleHiddenWorlds 需要合法的可见剩余牌计数快照");
  }
  const sampleCount = Math.max(0, Math.floor(Number(count) || 0));
  const worlds = Array.from({ length:sampleCount }, () => {
    const remaining = { ...rootCounts };
    return Object.fromEntries(searchState.players.filter((player) => player.id !== viewer.id).map((player) => {
      const certainKnown = (player.knownCards ?? []).filter((entry) => (
        cardAvailability(entry) >= 1 - PROBABILITY_EPSILON
      ));
      const known = new Map(certainKnown.map((entry) => [entry.cardId, entry.definitionId]));
      const unknownCount = Math.max(0, player.handCount - known.size);
      const sampled = [];
      for (let index = 0; index < unknownCount; index += 1) {
        sampled.push(pickDefinition(remaining, random));
      }
      return [player.id, [...known.values(), ...sampled]];
    }));
  });
  return Object.freeze({
    classification:PROBABILITY_CLASSIFICATION.MONTE_CARLO_ESTIMATE,
    sampleCount,
    worlds:Object.freeze(worlds)
  });
}
