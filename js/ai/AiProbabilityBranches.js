/*
模块职责
拥有雷达判定这一领域概率模型，并保留通用概率工具的历史导入路径。

上游
AiEvaluator、AiSimulator、现有测试与尚未迁移的 AI 模块。

下游
卡牌定义配置、state/Probability 通用纯函数。

状态边界
只读剩余牌计数与卡牌配置，不读写 GameState 或 SearchState。

信息边界
仅使用调用方提供的合法剩余牌计数；无计数时显式退化为固定牌组密度。

架构约束
通用概率逻辑只能由 state/Probability 实现，本文件不得复制其算法。
*/
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260814-ai-controller-di";
import {
  PROBABILITY_EPSILON,
  clampProbability
} from "./state/Probability.js?build=20260814-ai-controller-di";

export * from "./state/Probability.js?build=20260814-ai-controller-di";

export const RADAR_BASIC_DEFINITIONS = Object.freeze(["assault", "recover", "block", "charge", "shield"]);

/*
功能
计算一次雷达判定落入战术、装备或各基础牌定义的条件概率。

调用方
AiEvaluator、AiSimulator 与雷达概率回归测试。

输入
可选剩余牌计数与兼容的 block、otherBasic、equipment 概率覆盖。

输出
归一化的雷达类别概率、基础牌概率与判定池可用标记。

读取状态
CARD_DEFINITIONS、合法剩余牌计数。

写入状态
无。

调用函数
clampProbability。

边界与不变量
动态计数缺失时使用固定牌组密度；概率质量非空时总和必须为一。
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
    for (const [definitionId, definition] of Object.entries(CARD_DEFINITIONS)) {
      weights[definitionId] = definition.count;
      totalWeight += definition.count;
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
    const otherBasicDefinitions = ["assault", "recover", "charge", "shield"];
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
        .reduce((sum, definitionId) => sum + CARD_DEFINITIONS[definitionId].count, 0);
      otherBasicRatios = Object.fromEntries(otherBasicDefinitions.map((definitionId) => [
        definitionId,
        fixedTotal > 0 ? CARD_DEFINITIONS[definitionId].count / fixedTotal : 0.25
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
