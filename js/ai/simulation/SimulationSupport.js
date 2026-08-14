/*
模块职责
提供 Simulation components 共用的卡牌密度与概率标量 helper。

上游
Simulator、ResponseSimulation、CombatSimulation 与效果组件。

下游
卡牌配置。

状态边界
全部函数纯计算，不持有或修改 SearchState。

信息边界
只消费显式剩余牌计数，不读取牌堆实体或隐藏手牌。

架构约束
不得包含规则执行、策略、价值或组件调度。
*/
import {
  CARD_DEFINITIONS,
  TOTAL_CARD_COUNT
} from "../../config/cardConfig.js?build=20260814-ai-simulation-engine";

const BASIC_CARD_COUNT = Object.values(CARD_DEFINITIONS)
  .filter((card) => card.category === "basic")
  .reduce((sum, card) => sum + card.count, 0);
const EQUIPMENT_CARD_COUNT = Object.values(CARD_DEFINITIONS)
  .filter((card) => card.category === "equipment")
  .reduce((sum, card) => sum + card.count, 0);
const BLOCK_CARD_COUNT = CARD_DEFINITIONS.block.count;
const OTHER_BASIC_CARD_COUNT = BASIC_CARD_COUNT - BLOCK_CARD_COUNT;

/*
功能
执行 Simulation 共用的纯概率/密度步骤 fixedCardDensity。

调用方
Simulator 及其 Response、Combat、Card、Skill、Status components。

输入
显式数值、卡牌定义 ID 或 remaining card counts。

输出
新概率值或独立概率摘要。

读取状态
只读参数与 card config。

写入状态
无。

调用函数
同文件纯 helper 或 JavaScript 数值运算。

边界与不变量
不得读取隐藏牌堆实体；概率必须限制在合法范围并保持既有 fallback。
*/
export const fixedCardDensity = (definitionId) => (
  (CARD_DEFINITIONS[definitionId]?.count ?? 0) / TOTAL_CARD_COUNT
);

/*
功能
执行 Simulation 共用的纯概率/密度步骤 remainingCardDensity。

调用方
Simulator 及其 Response、Combat、Card、Skill、Status components。

输入
显式数值、卡牌定义 ID 或 remaining card counts。

输出
新概率值或独立概率摘要。

读取状态
只读参数与 card config。

写入状态
无。

调用函数
同文件纯 helper 或 JavaScript 数值运算。

边界与不变量
不得读取隐藏牌堆实体；概率必须限制在合法范围并保持既有 fallback。
*/
export const remainingCardDensity = (remainingCardCounts, definitionId) => {
  if (!remainingCardCounts || typeof remainingCardCounts !== "object"
    || Array.isArray(remainingCardCounts)) {
    return fixedCardDensity(definitionId);
  }
  let total = 0;
  for (const count of Object.values(remainingCardCounts)) {
    if (Number.isFinite(count)) total += Math.max(0, count);
  }
  if (total <= 0) return 0;
  const count = Number(remainingCardCounts[definitionId]);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.max(0, Math.min(1, count / total));
};

/*
功能
执行 Simulation 共用的纯概率/密度步骤 fixedRadarJudgmentProbabilities。

调用方
Simulator 及其 Response、Combat、Card、Skill、Status components。

输入
显式数值、卡牌定义 ID 或 remaining card counts。

输出
新概率值或独立概率摘要。

读取状态
只读参数与 card config。

写入状态
无。

调用函数
同文件纯 helper 或 JavaScript 数值运算。

边界与不变量
不得读取隐藏牌堆实体；概率必须限制在合法范围并保持既有 fallback。
*/
export const fixedRadarJudgmentProbabilities = () => ({
  block:BLOCK_CARD_COUNT / TOTAL_CARD_COUNT,
  otherBasic:OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT,
  equipment:EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT
});

/*
功能
执行 Simulation 共用的纯概率/密度步骤 remainingRadarJudgmentProbabilities。

调用方
Simulator 及其 Response、Combat、Card、Skill、Status components。

输入
显式数值、卡牌定义 ID 或 remaining card counts。

输出
新概率值或独立概率摘要。

读取状态
只读参数与 card config。

写入状态
无。

调用函数
同文件纯 helper 或 JavaScript 数值运算。

边界与不变量
不得读取隐藏牌堆实体；概率必须限制在合法范围并保持既有 fallback。
*/
export const remainingRadarJudgmentProbabilities = (remainingCardCounts) => {
  if (!remainingCardCounts || typeof remainingCardCounts !== "object"
    || Array.isArray(remainingCardCounts)) {
    return fixedRadarJudgmentProbabilities();
  }
  const positiveCounts = {};
  let total = 0;
  for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) continue;
    positiveCounts[definitionId] = value;
    total += value;
  }
  if (total <= 0) return { block:0, otherBasic:0, equipment:0 };
  let block = 0;
  let otherBasic = 0;
  let equipment = 0;
  for (const [definitionId, count] of Object.entries(positiveCounts)) {
    const definition = CARD_DEFINITIONS[definitionId];
    if (!definition) continue;
    if (definitionId === "block") block += count;
    else if (definition.category === "basic") otherBasic += count;
    else if (definition.category === "equipment") equipment += count;
  }
  return {
    block:Math.max(0, Math.min(1, block / total)),
    otherBasic:Math.max(0, Math.min(1, otherBasic / total)),
    equipment:Math.max(0, Math.min(1, equipment / total))
  };
};

/*
功能
执行 Simulation 共用的纯概率/密度步骤 clampProbability。

调用方
Simulator 及其 Response、Combat、Card、Skill、Status components。

输入
显式数值、卡牌定义 ID 或 remaining card counts。

输出
新概率值或独立概率摘要。

读取状态
只读参数与 card config。

写入状态
无。

调用函数
同文件纯 helper 或 JavaScript 数值运算。

边界与不变量
不得读取隐藏牌堆实体；概率必须限制在合法范围并保持既有 fallback。
*/
export const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/*
功能
执行 Simulation 共用的纯概率/密度步骤 unionProbability。

调用方
Simulator 及其 Response、Combat、Card、Skill、Status components。

输入
显式数值、卡牌定义 ID 或 remaining card counts。

输出
新概率值或独立概率摘要。

读取状态
只读参数与 card config。

写入状态
无。

调用函数
同文件纯 helper 或 JavaScript 数值运算。

边界与不变量
不得读取隐藏牌堆实体；概率必须限制在合法范围并保持既有 fallback。
*/
export const unionProbability = (oldProbability, newProbability) => 1
  - (1 - clampProbability(oldProbability)) * (1 - clampProbability(newProbability));
