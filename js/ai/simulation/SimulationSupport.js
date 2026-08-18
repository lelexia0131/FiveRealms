/*
模块职责
提供模拟组件共用的卡牌密度与概率标量辅助函数。

上游
Simulator、ResponseSimulation、CombatSimulation 与效果组件。

下游
Domain Card/Ruleset Definitions。

状态边界
全部函数纯计算，不持有或修改 SearchState。

信息边界
只消费显式剩余牌计数，不读取牌堆实体或隐藏手牌。

架构约束
不得包含规则执行、策略、价值或组件调度。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js?build=20260818-skill-rules-locality-refactor";

const DECK_COMPOSITION = RULESET_DEFINITION.deckComposition;
const TOTAL_CARD_COUNT = Object.values(DECK_COMPOSITION)
  .reduce((sum, count) => sum + count, 0);
const BASIC_CARD_COUNT = Object.entries(DECK_COMPOSITION)
  .filter(([definitionId]) => CARD_DEFINITIONS[definitionId]?.category === "basic")
  .reduce((sum, [, count]) => sum + count, 0);
const EQUIPMENT_CARD_COUNT = Object.entries(DECK_COMPOSITION)
  .filter(([definitionId]) => CARD_DEFINITIONS[definitionId]?.category === "equipment")
  .reduce((sum, [, count]) => sum + count, 0);
const BLOCK_CARD_COUNT = DECK_COMPOSITION.block ?? 0;
const OTHER_BASIC_CARD_COUNT = BASIC_CARD_COUNT - BLOCK_CARD_COUNT;

/*
功能
根据确定手牌计数计算指定卡牌类型在已知手牌中的密度。

调用方
BeliefState 与响应/卡牌模拟：在没有剩余牌快照时取得指定牌的固定先验密度。

输入
卡牌定义 ID；允许未知 ID。

输出
定义数量占完整牌堆的比例；未知定义返回零。

读取状态
只读不可变 CARD_DEFINITIONS 与 TOTAL_CARD_COUNT。

写入状态
无。

调用函数
无。

边界与不变量
这是配置先验，不是对真实牌堆的观察；不得读取牌堆实体或随机顺序。
*/
export const fixedCardDensity = (definitionId) => (
  (DECK_COMPOSITION[definitionId] ?? 0) / TOTAL_CARD_COUNT
);

/*
功能
从剩余牌计数计算指定类型在未知牌池中的条件密度。

调用方
BeliefState、ResponseSimulation 与 CardEffectSimulation：从当前未知池估算下一张指定牌的条件概率。

输入
公开推导的 remainingCardCounts 快照与卡牌定义 ID。

输出
零到一的条件密度；缺少合法计数对象时退回固定先验。

读取状态
只读传入的剩余定义计数。

写入状态
无。

调用函数
fixedCardDensity。

边界与不变量
忽略负数和非法计数；总质量为零时返回零，不得用真实隐藏牌补全。
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
把确定雷达判定牌映射为基础、锦囊与装备三类互斥概率。

调用方
remainingRadarJudgmentProbabilities：剩余牌快照缺失时提供雷达判定类别先验。

输入
无。

输出
新的 block、otherBasic、equipment 三类概率对象。

读取状态
只读模块加载时由卡牌配置计算的类别数量常量。

写入状态
无。

调用函数
无。

边界与不变量
三类互斥并使用完整牌堆作分母；战术牌不属于雷达可获得的三类结果。
*/
export const fixedRadarJudgmentProbabilities = () => ({
  block:BLOCK_CARD_COUNT / TOTAL_CARD_COUNT,
  otherBasic:OTHER_BASIC_CARD_COUNT / TOTAL_CARD_COUNT,
  equipment:EQUIPMENT_CARD_COUNT / TOTAL_CARD_COUNT
});

/*
功能
按剩余牌池密度构造雷达判定的三类互斥概率。

调用方
雷达判定兼容查询：从当前剩余牌池派生基础牌与装备类别概率。

输入
公开推导的 remainingCardCounts；允许缺失或空池。

输出
新的 block、otherBasic、equipment 概率对象。

读取状态
只读剩余定义计数与 CARD_DEFINITIONS 的类别。

写入状态
无。

调用函数
fixedRadarJudgmentProbabilities。

边界与不变量
仅统计仍为正数且有正式定义的牌；输出三类互斥，空池全部为零。
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
把任意数值规范化到闭区间零到一，非法值按零处理。

调用方
Simulation 与 Domain 概率边界：在组合条件世界前规范外部标量。

输入
任意可转为数值的概率候选。

输出
零到一的数值；NaN、空值与非法输入返回零。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只做边界截断，不归一化概率分支，也不创造隐藏信息。
*/
export const clampProbability = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/*
功能
计算多个独立事件至少发生一次的联合概率。

调用方
StatusSimulation：合并同一状态由多个独立来源触发的存在概率。

输入
两个分别表示事件发生概率的标量。

输出
至少一个事件发生的联合概率。

读取状态
无。

写入状态
无。

调用函数
clampProbability。

边界与不变量
公式只适用于调用方已确认独立的事件；相关条件世界必须使用 Probability 分支连接而不能调用本函数。
*/
export const unionProbability = (oldProbability, newProbability) => 1
  - (1 - clampProbability(oldProbability)) * (1 - clampProbability(newProbability));
