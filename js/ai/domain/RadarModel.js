/*
模块职责
根据公开剩余牌计数派生雷达判定的未知判定牌概率分区；本模块是 AI probabilistic/search model，不是 Repository Domain Rule authority。

上游
Simulator、ValueSimulationQuery、Evaluator、ValueLedger 与正式边界。

下游
Domain Card/Ruleset Definitions、Domain JudgmentRules 与 state/Probability。

状态边界
只读剩余牌计数并返回独立概率对象，不读写 GameState 或 World。

信息边界
只使用调用方提供的公开剩余牌计数；缺失时使用 RulesetDefinition 正式初始牌堆构成。

架构约束
雷达 category 解释来自 Domain Card Definitions；本模型只拥有未知判定牌概率分区。不得依赖 Controller、Planner、Simulator、Evaluator、UI 或 value 层。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import {
  PROBABILITY_EPSILON,
  clampProbability
} from "../state/Probability.js";

export const RADAR_BASIC_DEFINITIONS = Object.freeze(
  Object.entries(CARD_DEFINITIONS)
    .filter(([, definition]) => definition.category === "basic")
    .map(([definitionId]) => definitionId)
);
const RADAR_OTHER_BASIC_DEFINITIONS = Object.freeze(
  RADAR_BASIC_DEFINITIONS.filter((definitionId) => definitionId !== "block")
);

/*
功能
计算一次雷达判定落入战术、装备或各基础牌定义的条件概率。

调用方
Simulator、Value query、Evaluator、ValueLedger、正式边界与领域测试。

输入
可选剩余牌计数，以及 block、otherBasic、equipment 的显式概率覆盖。

输出
归一化的新雷达类别概率、基础牌概率与判定池可用标记。

读取状态
CARD_DEFINITIONS 与调用方提供的剩余牌计数。

写入状态
无。

调用函数
clampProbability。

边界与不变量
不修改输入；概率质量非空时总和为一，空池时全部为零。
*/
export function buildRadarJudgmentProbabilities(remainingCardCounts = null, overrideProbabilities = null) {
  const weights = {};
  let totalWeight = 0;
  if (remainingCardCounts && typeof remainingCardCounts === "object" && !Array.isArray(remainingCardCounts)) {
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      const value = Number(count);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (!CARD_DEFINITIONS[definitionId]) continue;
      weights[definitionId] = (weights[definitionId] ?? 0) + value;
      totalWeight += value;
    }
  } else {
    for (const [definitionId, count] of Object.entries(RULESET_DEFINITION.deckComposition)) {
      if (!CARD_DEFINITIONS[definitionId]) continue;
      weights[definitionId] = count;
      totalWeight += count;
    }
  }

  const basicProbabilities = {};
  for (const definitionId of RADAR_BASIC_DEFINITIONS) {
    basicProbabilities[definitionId] = totalWeight > PROBABILITY_EPSILON
      ? (weights[definitionId] ?? 0) / totalWeight
      : 0;
  }
  let tacticProbability = 0;
  let equipmentProbability = 0;
  for (const [definitionId, definition] of Object.entries(CARD_DEFINITIONS)) {
    const weight = weights[definitionId] ?? 0;
    if (weight <= 0) continue;
    if (definition.category === "tactic") tacticProbability += weight / totalWeight;
    else if (definition.category === "equipment") equipmentProbability += weight / totalWeight;
  }

  const override = overrideProbabilities && typeof overrideProbabilities === "object"
    ? overrideProbabilities
    : null;
  if (override) {
    const otherBasicDefinitions = RADAR_OTHER_BASIC_DEFINITIONS;
    const overrideBlock = clampProbability(override.block ?? basicProbabilities.block);
    const overrideEquipment = clampProbability(override.equipment ?? equipmentProbability);
    const overrideOtherBasic = clampProbability(override.otherBasic ?? otherBasicDefinitions
      .reduce((sum, definitionId) => sum + basicProbabilities[definitionId], 0));
    const otherBasicWeights = otherBasicDefinitions
      .reduce((sum, definitionId) => sum + (weights[definitionId] ?? 0), 0);
    let otherBasicRatios;
    if (otherBasicWeights > PROBABILITY_EPSILON) {
      otherBasicRatios = Object.fromEntries(otherBasicDefinitions.map((definitionId) => [
        definitionId,
        (weights[definitionId] ?? 0) / otherBasicWeights
      ]));
    } else {
      const fixedTotal = otherBasicDefinitions
        .reduce((sum, definitionId) => sum + (RULESET_DEFINITION.deckComposition[definitionId] ?? 0), 0);
      otherBasicRatios = Object.fromEntries(otherBasicDefinitions.map((definitionId) => [
        definitionId,
        fixedTotal > 0 ? (RULESET_DEFINITION.deckComposition[definitionId] ?? 0) / fixedTotal : 0.25
      ]));
    }
    basicProbabilities.block = overrideBlock;
    for (const definitionId of otherBasicDefinitions) {
      basicProbabilities[definitionId] = overrideOtherBasic * otherBasicRatios[definitionId];
    }
    equipmentProbability = overrideEquipment;
    tacticProbability = Math.max(0, 1 - overrideBlock - overrideOtherBasic - overrideEquipment);
  }

  let judgmentTotal = tacticProbability + equipmentProbability;
  for (const definitionId of RADAR_BASIC_DEFINITIONS) {
    judgmentTotal += basicProbabilities[definitionId];
  }
  if (judgmentTotal > PROBABILITY_EPSILON) {
    tacticProbability /= judgmentTotal;
    equipmentProbability /= judgmentTotal;
    for (const definitionId of RADAR_BASIC_DEFINITIONS) {
      basicProbabilities[definitionId] /= judgmentTotal;
    }
  } else {
    tacticProbability = 0;
    equipmentProbability = 0;
    for (const definitionId of RADAR_BASIC_DEFINITIONS) {
      basicProbabilities[definitionId] = 0;
    }
  }

  return {
    tactic:tacticProbability,
    equipment:equipmentProbability,
    basic:basicProbabilities,
    hasJudgmentPool:totalWeight > PROBABILITY_EPSILON || Boolean(override)
  };
}

/*
功能
按无放回牌池或显式逐槽覆盖计算多个雷达判定的联合结果分区。

调用方
StatusSimulation.buildRadarOutcomeSequencePartition。

输入
公开剩余牌计数、正整数判定次数、可选逐槽概率覆盖与可选统一概率覆盖。

输出
概率质量为一的 `{ probability, outcomes }` 数组；outcomes 按判定顺序排列。

读取状态
CARD_DEFINITIONS、RULESET_DEFINITION.deckComposition 与传入计数。

写入状态
无。

调用函数
buildRadarJudgmentProbabilities。

边界与不变量
默认牌池严格无放回；显式概率覆盖仅用于调用方指定的独立概率槽，不读取未来真实判定牌。
*/
export function buildRadarJudgmentSequenceProbabilities(
  remainingCardCounts,
  requirementCount,
  overrideProbabilitiesByRequirement = null,
  overrideProbabilities = null
) {
  const count = Math.max(0, Math.floor(Number(requirementCount) || 0));
  if (count <= 0) return [{ probability:1, outcomes:[] }];
  const overrides = Array.isArray(overrideProbabilitiesByRequirement)
    ? overrideProbabilitiesByRequirement
    : null;
  if (overrides?.length || overrideProbabilities) {
    let worlds = [{ probability:1, outcomes:[] }];
    for (let slot = 0; slot < count; slot += 1) {
      const probabilities = buildRadarJudgmentProbabilities(
        remainingCardCounts,
        overrides?.[slot] ?? overrideProbabilities
      );
      const outcomes = [];
      if (!probabilities.hasJudgmentPool) outcomes.push(["noJudgment", 1]);
      else {
        if (probabilities.tactic > PROBABILITY_EPSILON) outcomes.push(["tactic", probabilities.tactic]);
        if (probabilities.equipment > PROBABILITY_EPSILON) outcomes.push(["equipment", probabilities.equipment]);
        for (const definitionId of RADAR_BASIC_DEFINITIONS) {
          const probability = probabilities.basic[definitionId];
          if (probability > PROBABILITY_EPSILON) outcomes.push([`basic:${definitionId}`, probability]);
        }
      }
      worlds = worlds.flatMap((world) => outcomes.map(([outcome, probability]) => ({
        probability:world.probability * probability,
        outcomes:[...world.outcomes, outcome]
      })));
    }
    return worlds;
  }

  const sourceCounts = remainingCardCounts && typeof remainingCardCounts === "object"
    && !Array.isArray(remainingCardCounts)
    ? remainingCardCounts
    : RULESET_DEFINITION.deckComposition;
  const outcomeCounts = {};
  for (const [definitionId, rawCount] of Object.entries(sourceCounts)) {
    const cardCount = Number(rawCount);
    const definition = CARD_DEFINITIONS[definitionId];
    if (!definition || !Number.isFinite(cardCount) || cardCount <= 0) continue;
    const outcome = definition.category === "basic"
      ? `basic:${definitionId}`
      : definition.category;
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + cardCount;
  }
  let worlds = [{
    probability:1,
    outcomes:[],
    counts:outcomeCounts,
    total:Object.values(outcomeCounts).reduce((sum, value) => sum + value, 0)
  }];
  for (let slot = 0; slot < count; slot += 1) {
    worlds = worlds.flatMap((world) => {
      if (world.total <= PROBABILITY_EPSILON) {
        return [{ ...world, outcomes:[...world.outcomes, "noJudgment"] }];
      }
      return Object.entries(world.counts).flatMap(([outcome, available]) => {
        if (available <= PROBABILITY_EPSILON) return [];
        return [{
          probability:world.probability * available / world.total,
          outcomes:[...world.outcomes, outcome],
          counts:{ ...world.counts, [outcome]:available - 1 },
          total:world.total - 1
        }];
      });
    });
  }
  return worlds.map(({ probability, outcomes }) => ({ probability, outcomes }));
}
