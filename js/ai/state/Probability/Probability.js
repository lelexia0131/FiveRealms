/*
模块职责
Probability authority 的唯一 public facade；组合 generic Branch、finite Pool 与 Radar/Lightning/Seal business-facing queries。

上游
AI State、Search、Simulation、Value、Policy 与 Worker composition。

下游
内部 Branch/Pool 实现及 canonical Domain Definitions/Rules。

状态边界
通过 Pool 管理 ProbabilityState；business query 只读 World/Fact 并返回局部概率结果。

信息边界
只消费公开 Fact、known identity、匿名有限池与显式合法 override；不得读取未知真实实体。

架构约束
外部 production 只能依赖本 facade；Branch 与 Pool 必须正交且不得形成循环。
*/
import { CARD_DEFINITIONS } from "../../../domain/definitions/cards/CardDefinitions.js";
import { RULESET_DEFINITION } from "../../../domain/definitions/ruleset/RulesetDefinition.js";
import { hasFactStatus } from "../Fact.js";
import {
  PROBABILITY_EPSILON,
  clampProbability,
  independentUnionProbability,
  mergeProbabilityBranches,
  mergeProbabilityBranchesCooperatively,
  totalBranchProbability,
  mergeProbabilityStateBranches,
  mergeProbabilityStateBranchesCooperatively,
  intersectProbabilityStateBranches,
  intersectProbabilityStateBranchesCooperatively,
  projectProbabilityStateBranches,
  projectProbabilityStateBranchesCooperatively,
  expectedBranchValue,
  probabilityEventPartition,
  getAvailabilityBranches,
  getAvailabilityStateBranches,
  availableBranchesFromState,
  binaryConditionPartition
} from "./Branch.js";
import {
  conditionFinitePool,
  createFinitePoolState,
  cyclicFirstSuccessDistribution,
  mutateFinitePool,
  hypergeometricProbabilityAtLeast,
  probabilityFromCurrentCounts,
  currentProbabilitySignature,
  queryCurrentCardCounts,
  expectedAnonymousSlots,
  queryAnonymousSlotDistribution,
  queryProbability,
  queryCardCategoryProbability
} from "./Pool.js";

export {
  PROBABILITY_EPSILON,
  clampProbability,
  independentUnionProbability,
  mergeProbabilityBranches,
  mergeProbabilityBranchesCooperatively,
  totalBranchProbability,
  mergeProbabilityStateBranches,
  mergeProbabilityStateBranchesCooperatively,
  intersectProbabilityStateBranches,
  intersectProbabilityStateBranchesCooperatively,
  projectProbabilityStateBranches,
  projectProbabilityStateBranchesCooperatively,
  expectedBranchValue,
  probabilityEventPartition,
  getAvailabilityBranches,
  getAvailabilityStateBranches,
  availableBranchesFromState,
  binaryConditionPartition,
  hypergeometricProbabilityAtLeast,
  probabilityFromCurrentCounts,
  currentProbabilitySignature,
  queryCurrentCardCounts,
  expectedAnonymousSlots,
  queryAnonymousSlotDistribution,
  queryProbability,
  queryCardCategoryProbability
};

export const PROBABILITY_CLASSIFICATION = Object.freeze({
  EXACT:"EXACT",
  CURRENT_STATE_PROBABILITY:"CURRENT STATE PROBABILITY",
  MONTE_CARLO_ESTIMATE:"MONTE CARLO ESTIMATE",
  POLICY_HEURISTIC:"POLICY HEURISTIC",
  EXPECTED_VALUE:"EXPECTED VALUE, NOT PROBABILITY"
});

const PROBABILITY_DEFINITION_IDS = Object.freeze([
  "recover", "block", "counter", "assault"
]);
export const PROBABILITY_DRAW_BUCKET = "outside/drawPool";

const RADAR_BASIC_DEFINITION_IDS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "basic")
    .map((definition) => definition.definitionId)
);
const RADAR_OTHER_BASIC_DEFINITION_IDS = Object.freeze(
  RADAR_BASIC_DEFINITION_IDS.filter((definitionId) => definitionId !== "block")
);
const STATUS_PROBABILITY_FIELDS = Object.freeze({
  lightning:"lightningStatusProbability",
  sealed:"sealedStatusProbability"
});


/*
功能
从当前公开判定池或正式初始牌堆一次构造 Radar query 所需的计数。

调用方
buildRadarJudgmentProbabilities、buildRadarJudgmentSequenceProbabilities。

输入
可选的当前剩余牌定义计数，以及是否直接按判定 outcome 聚合。

输出
只含合法正计数的独立 counts 对象及其 totalWeight。

读取状态
Domain CardDefinitions 与 RulesetDefinition.deckComposition。

写入状态
无。

调用函数
无。

边界与不变量
不读取真实判定牌身份或修改输入；null 使用正式初始牌堆，显式空对象保持空池语义；
definition 与 outcome 两种粒度都只扫描并物化当前牌池一次。
*/
function radarJudgmentPoolCounts(remainingCardCounts = null, groupByOutcome = false) {
  const sourceCounts = remainingCardCounts
    && typeof remainingCardCounts === "object"
    && !Array.isArray(remainingCardCounts)
    ? remainingCardCounts
    : RULESET_DEFINITION.deckComposition;
  const counts = {};
  let totalWeight = 0;
  for (const [definitionId, count] of Object.entries(sourceCounts)) {
    const value = Number(count);
    const definition = CARD_DEFINITIONS[definitionId];
    if (!definition || !Number.isFinite(value) || value <= 0) continue;
    const key = groupByOutcome
      ? definition.category === "basic" ? `basic:${definitionId}` : definition.category
      : definitionId;
    counts[key] = (counts[key] ?? 0) + value;
    totalWeight += value;
  }
  return { counts, totalWeight };
}

/*
功能
计算一次雷达判定落入战术、装备或各基础牌定义的条件概率。

调用方
Status/Combat simulation 上游、ValueSimulationQuery、Evaluator、ValueLedger 与直接概率测试。

输入
可选当前剩余牌计数，以及 block、otherBasic、equipment 的显式概率覆盖。

输出
归一化的新雷达类别概率、基础牌概率与判定池可用标记。

读取状态
Domain CardDefinitions、RulesetDefinition 与调用方提供的当前牌池计数。

写入状态
无。

调用函数
radarJudgmentPoolCounts、clampProbability。

边界与不变量
不修改输入；概率质量非空时总和为一，显式空池时全部为零；override 保持当前残差和归一化语义。
*/
export function buildRadarJudgmentProbabilities(
  remainingCardCounts = null,
  overrideProbabilities = null
) {
  const {
    counts:weights,
    totalWeight
  } = radarJudgmentPoolCounts(remainingCardCounts);
  const basicProbabilities = Object.fromEntries(
    RADAR_BASIC_DEFINITION_IDS.map((definitionId) => [
      definitionId,
      totalWeight > PROBABILITY_EPSILON ? (weights[definitionId] ?? 0) / totalWeight : 0
    ])
  );
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
    const overrideBlock = clampProbability(override.block ?? basicProbabilities.block);
    const overrideEquipment = clampProbability(override.equipment ?? equipmentProbability);
    const overrideOtherBasic = clampProbability(override.otherBasic
      ?? RADAR_OTHER_BASIC_DEFINITION_IDS.reduce(
        (sum, definitionId) => sum + basicProbabilities[definitionId],
        0
      ));
    const otherBasicWeight = RADAR_OTHER_BASIC_DEFINITION_IDS.reduce(
      (sum, definitionId) => sum + (weights[definitionId] ?? 0),
      0
    );
    let otherBasicRatios;
    if (otherBasicWeight > PROBABILITY_EPSILON) {
      otherBasicRatios = Object.fromEntries(
        RADAR_OTHER_BASIC_DEFINITION_IDS.map((definitionId) => [
          definitionId,
          (weights[definitionId] ?? 0) / otherBasicWeight
        ])
      );
    } else {
      const fixedTotal = RADAR_OTHER_BASIC_DEFINITION_IDS.reduce(
        (sum, definitionId) => sum + (RULESET_DEFINITION.deckComposition[definitionId] ?? 0),
        0
      );
      otherBasicRatios = Object.fromEntries(
        RADAR_OTHER_BASIC_DEFINITION_IDS.map((definitionId) => [
          definitionId,
          fixedTotal > 0
            ? (RULESET_DEFINITION.deckComposition[definitionId] ?? 0) / fixedTotal
            : RADAR_OTHER_BASIC_DEFINITION_IDS.length > 0
              ? 1 / RADAR_OTHER_BASIC_DEFINITION_IDS.length
              : 0
        ])
      );
    }
    basicProbabilities.block = overrideBlock;
    for (const definitionId of RADAR_OTHER_BASIC_DEFINITION_IDS) {
      basicProbabilities[definitionId] = overrideOtherBasic * otherBasicRatios[definitionId];
    }
    equipmentProbability = overrideEquipment;
    tacticProbability = Math.max(
      0,
      1 - overrideBlock - overrideOtherBasic - overrideEquipment
    );
  }

  let judgmentTotal = tacticProbability + equipmentProbability;
  for (const definitionId of RADAR_BASIC_DEFINITION_IDS) {
    judgmentTotal += basicProbabilities[definitionId];
  }
  if (judgmentTotal > PROBABILITY_EPSILON) {
    tacticProbability /= judgmentTotal;
    equipmentProbability /= judgmentTotal;
    for (const definitionId of RADAR_BASIC_DEFINITION_IDS) {
      basicProbabilities[definitionId] /= judgmentTotal;
    }
  } else {
    tacticProbability = 0;
    equipmentProbability = 0;
    for (const definitionId of RADAR_BASIC_DEFINITION_IDS) {
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
把当前 Radar finite-pool outcome counts 转为单槽基础或 override 后的可消费分布。

调用方
buildRadarJudgmentSequenceProbabilities 的统一逐槽状态机。

输入
当前 outcome counts、初始 outcome counts、当前总容量与可选单槽 override。

输出
包含 outcome、probability 与是否耗用当前池容量的分布。

读取状态
Radar 基础牌 definition 投影与当前槽 pool counts。

写入状态
无。

调用函数
clampProbability。

边界与不变量
初始存在的物理 outcome 耗尽后不能再次出现；初始不存在的显式 override 保持旧 synthetic local contract；
override 有效质量归零时退回当前物理池分布。
*/
function radarOutcomeDistribution(
  poolCounts,
  initialPoolCounts,
  totalWeight,
  overrideProbabilities = null
) {
  if (totalWeight <= PROBABILITY_EPSILON) {
    const hasOverride = overrideProbabilities && typeof overrideProbabilities === "object";
    if (!hasOverride) return [{ outcome:"noJudgment", probability:1, consumes:false }];
  }
  const baseDistribution = Object.entries(poolCounts)
    .filter(([, available]) => available > PROBABILITY_EPSILON)
    .map(([outcome, available]) => ({
      outcome,
      probability:available / totalWeight,
      consumes:true
    }));
  const override = overrideProbabilities && typeof overrideProbabilities === "object"
    ? overrideProbabilities
    : null;
  if (!override) return baseDistribution;

  const baseByOutcome = Object.fromEntries(
    baseDistribution.map(({ outcome, probability }) => [outcome, probability])
  );
  const otherBasicWeight = RADAR_OTHER_BASIC_DEFINITION_IDS.reduce(
    (sum, definitionId) => sum + (poolCounts[`basic:${definitionId}`] ?? 0),
    0
  );
  const overrideBlock = clampProbability(
    override.block ?? baseByOutcome["basic:block"] ?? 0
  );
  const overrideEquipment = clampProbability(
    override.equipment ?? baseByOutcome.equipment ?? 0
  );
  const overrideOtherBasic = clampProbability(override.otherBasic
    ?? RADAR_OTHER_BASIC_DEFINITION_IDS.reduce(
      (sum, definitionId) => sum + (baseByOutcome[`basic:${definitionId}`] ?? 0),
      0
    ));
  const overrideTactic = Math.max(
    0,
    1 - overrideBlock - overrideOtherBasic - overrideEquipment
  );
  const desiredByOutcome = {
    tactic:overrideTactic,
    equipment:overrideEquipment,
    "basic:block":overrideBlock
  };
  const fixedOtherBasicTotal = RADAR_OTHER_BASIC_DEFINITION_IDS.reduce(
    (sum, definitionId) => sum + (RULESET_DEFINITION.deckComposition[definitionId] ?? 0),
    0
  );
  for (const definitionId of RADAR_OTHER_BASIC_DEFINITION_IDS) {
    desiredByOutcome[`basic:${definitionId}`] = otherBasicWeight > PROBABILITY_EPSILON
      ? overrideOtherBasic * (poolCounts[`basic:${definitionId}`] ?? 0) / otherBasicWeight
      : fixedOtherBasicTotal > PROBABILITY_EPSILON
        ? overrideOtherBasic
          * (RULESET_DEFINITION.deckComposition[definitionId] ?? 0)
          / fixedOtherBasicTotal
        : RADAR_OTHER_BASIC_DEFINITION_IDS.length > 0
          ? overrideOtherBasic / RADAR_OTHER_BASIC_DEFINITION_IDS.length
          : 0;
  }
  const orderedOutcomes = [
    "tactic",
    "equipment",
    ...RADAR_BASIC_DEFINITION_IDS.map((definitionId) => `basic:${definitionId}`)
  ];
  const transformed = orderedOutcomes.flatMap((outcome) => {
    const probability = desiredByOutcome[outcome] ?? 0;
    if (probability <= PROBABILITY_EPSILON) return [];
    const currentCapacity = poolCounts[outcome] ?? 0;
    const initialCapacity = initialPoolCounts[outcome] ?? 0;
    if (currentCapacity > PROBABILITY_EPSILON) {
      return [{ outcome, probability, consumes:true }];
    }
    return initialCapacity <= PROBABILITY_EPSILON
      ? [{ outcome, probability, consumes:false }]
      : [];
  });
  const transformedTotal = transformed.reduce(
    (sum, branch) => sum + branch.probability,
    0
  );
  return transformedTotal > PROBABILITY_EPSILON
    ? transformed.map((branch) => ({
        ...branch,
        probability:branch.probability / transformedTotal
      }))
    : baseDistribution.length
      ? baseDistribution
      : [{ outcome:"noJudgment", probability:1, consumes:false }];
}

/*
功能
按当前无放回牌池或显式逐槽覆盖计算多个雷达判定的联合结果分区。

调用方
StatusSimulation.buildRadarOutcomeSequencePartition 与直接概率测试。

输入
当前剩余牌计数、非负判定次数、可选逐槽概率覆盖与可选统一概率覆盖。

输出
`{ probability, outcomes }` 数组；outcomes 严格按判定顺序排列。

读取状态
Domain CardDefinitions、RulesetDefinition 与传入当前牌池计数。

写入状态
无。

调用函数
radarJudgmentPoolCounts、radarOutcomeDistribution。

边界与不变量
所有槽统一从前一槽剩余容量抽取；per-slot/uniform override 只变换当前分布，不能跳过物理耗用；
结果不写回 World 或保留历史 genealogy。
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
  const {
    counts:outcomeCounts,
    totalWeight
  } = radarJudgmentPoolCounts(remainingCardCounts, true);
  let worlds = [{
    probability:1,
    outcomes:[],
    counts:outcomeCounts,
    initialCounts:outcomeCounts,
    total:totalWeight
  }];
  for (let slot = 0; slot < count; slot += 1) {
    worlds = worlds.flatMap((world) => {
      const distribution = radarOutcomeDistribution(
        world.counts,
        world.initialCounts,
        world.total,
        overrides?.[slot] ?? overrideProbabilities
      );
      return distribution.map(({ outcome, probability, consumes }) => {
        return {
          probability:world.probability * probability,
          outcomes:[...world.outcomes, outcome],
          counts:consumes
            ? { ...world.counts, [outcome]:world.counts[outcome] - 1 }
            : world.counts,
          initialCounts:world.initialCounts,
          total:consumes ? world.total - 1 : world.total
        };
      });
    });
  }
  return worlds.map(({ probability, outcomes }) => ({ probability, outcomes }));
}

/*
功能
返回一个公开 status 的确定/概率存在分区与总存在概率。

调用方
ActionGenerator、CardEffectSimulation、StatusSimulation、ValueSimulationQuery 与直接 contract tests。

输入
过滤玩家与 canonical status ID。

输出
新的 `{ branches, probability }` 当前状态查询结果。

读取状态
Fact status、lightning/sealed probability summary 与玩家 ID。

写入状态
无。

调用函数
Fact.hasFactStatus、Branch.probabilityEventPartition/totalBranchProbability/clampProbability。

边界与不变量
确定 Fact 只在缺少概率 summary 时回退；查询分支不写入 World 或形成跨 transition genealogy。
*/
export function statusPresence(player, statusId) {
  const probabilityField = STATUS_PROBABILITY_FIELDS[statusId]
    ?? `${statusId}StatusProbability`;
  const rawProbability = player?.[probabilityField]
    ?? (hasFactStatus(player, statusId) ? 1 : 0);
  const branches = probabilityEventPartition(
    `${statusId}-status:${player?.id ?? "unknown"}`,
    rawProbability,
    "present"
  );
  return {
    branches,
    probability:clampProbability(totalBranchProbability(
      branches.filter((branch) => branch.present)
    ))
  };
}

/*
功能
统计当前公开判定池中目标 category 的容量与合法牌总数。

调用方
buildLightningHitDistribution、tacticJudgmentProbability。

输入
可选当前剩余牌计数与 canonical category。

输出
目标 category count 与 total。

读取状态
Domain CardDefinitions 与 RulesetDefinition.deckComposition。

写入状态
无。

调用函数
无。

边界与不变量
忽略非法定义与非正计数；null 使用正式初始牌堆，不读取未来真实判定身份。
*/
function judgmentCategoryCounts(remainingCardCounts = null, category) {
  const sourceCounts = remainingCardCounts
    && typeof remainingCardCounts === "object"
    && !Array.isArray(remainingCardCounts)
    ? remainingCardCounts
    : RULESET_DEFINITION.deckComposition;
  let matches = 0;
  let total = 0;
  for (const [definitionId, count] of Object.entries(sourceCounts)) {
    const value = Number(count);
    const definition = CARD_DEFINITIONS[definitionId];
    if (!definition || !Number.isFinite(value) || value <= 0) continue;
    total += value;
    if (definition.category === category) matches += value;
  }
  return { matches, total };
}

/*
功能
把 Simulator 提供的合法闪电传播环与当前有限判定池组合成最终命中分布。

调用方
ValueSimulationQuery 与 direct probability tests。

输入
含 ProbabilityState 的 World 与按生命周期规则排列的 holder ID 数组。

输出
只含 holderId、hop、probability 的独立结果数组。

读取状态
当前判定池计数、Lightning trigger category 与调用方提供的传播顺序。

写入状态
无。

调用函数
Pool.cyclicFirstSuccessDistribution、queryCurrentCardCounts。

边界与不变量
传播顺序由 Simulator/Domain Rules 决定；Probability 只做首次成功无放回分布，不读取实体判定牌。
*/
export function buildLightningHitDistribution(state, holderIds = []) {
  const category = CARD_DEFINITIONS.lightning.judgmentTriggerCategory;
  const counts = judgmentCategoryCounts(
    state?.probabilityState ? queryCurrentCardCounts(state.probabilityState) : null,
    category
  );
  return cyclicFirstSuccessDistribution(
    counts.total,
    counts.matches,
    holderIds.length
  ).map(({ hop, probability }) => ({
    holderId:holderIds[hop],
    hop,
    probability
  }));
}

/*
功能
计算公开剩余判定池中 Seal trigger category 的概率。

调用方
ResponseBoundary、sealOutcomeProbabilities 与 direct probability tests。

输入
可选当前剩余牌计数。

输出
零到一的 trigger category 概率。

读取状态
Domain Seal definition、CardDefinitions 与 RulesetDefinition。

写入状态
无。

调用函数
judgmentCategoryCounts、clampProbability。

边界与不变量
显式空池返回零；null 使用正式初始牌堆，不读取真实判定 identity。
*/
export function tacticJudgmentProbability(remainingCardCounts = null) {
  const category = CARD_DEFINITIONS.seal.judgmentTriggerCategory;
  const counts = judgmentCategoryCounts(remainingCardCounts, category);
  return counts.total > 0 ? clampProbability(counts.matches / counts.total) : 0;
}

/*
功能
计算 Seal holder 当前存活阵营至少拥有一张可用 Counter 的联合概率。

调用方
sealOutcomeProbabilities。

输入
过滤 World 与 holder。

输出
零到一的团队 Counter 概率。

读取状态
当前 known Counter identity、同一 ProbabilityState finite-pool factor 与存活 team bucket。

写入状态
无。

调用函数
probabilityAnyAvailable、Pool.queryProbability、clampProbability。

边界与不变量
匿名容量通过同一团队 bucket query 计算，不连接逐玩家独立边际或生成 hidden allocations。
*/
function sealCounterProbability(state, holder) {
  if (!holder?.alive) return 0;
  const team = (state?.players ?? []).filter(
    (player) => player.alive && player.battleTeam === holder.battleTeam
  );
  const knownCounters = team.flatMap((player) => [
    ...(Array.isArray(player.hand) ? player.hand : []),
    ...(Array.isArray(player.knownCards) ? player.knownCards : [])
  ].filter((card) => card?.definitionId === "counter"));
  const knownProbability = probabilityAnyAvailable(knownCounters);
  const anonymousProbability = queryProbability(state?.probabilityState, {
    definitionId:"counter",
    groupBucketIds:team.map((player) => player.id)
  }).probability;
  return clampProbability(
    1 - (1 - knownProbability) * (1 - anonymousProbability)
  );
}

/*
功能
汇总 Seal 先 Counter、未 Counter 再 judgment 且最终 clear 的互斥事件概率。

调用方
SealPrior、SealValue 与 direct probability tests。

输入
过滤 World 与 Seal holder。

输出
冻结的 present/countered/judgment/success/skipAction/cleared 概率对象。

读取状态
Seal status presence、团队 Counter finite pool 与当前 draw bucket category probability。

写入状态
无。

调用函数
statusPresence、sealCounterProbability、Pool.queryCardCategoryProbability。

边界与不变量
countered + success + skipAction 等于 present；presence 为零不查询团队容量；本函数不修改或 clear World。
*/
export function sealOutcomeProbabilities(state, holder) {
  const present = statusPresence(holder, "sealed").probability;
  if (present <= 0) {
    return Object.freeze({
      present:0,
      countered:0,
      judgment:0,
      success:0,
      skipAction:0,
      cleared:0
    });
  }
  const counter = sealCounterProbability(state, holder);
  const triggerCategory = CARD_DEFINITIONS.seal.judgmentTriggerCategory;
  const tactic = queryCardCategoryProbability(
    state?.probabilityState,
    PROBABILITY_DRAW_BUCKET,
    Object.keys(CARD_DEFINITIONS).filter((definitionId) => (
      CARD_DEFINITIONS[definitionId]?.category === triggerCategory
    ))
  );
  const judgment = present * (1 - counter);
  return Object.freeze({
    present,
    countered:present * counter,
    judgment,
    success:judgment * tactic,
    skipAction:judgment * (1 - tactic),
    cleared:present
  });
}

/*
功能
生成公开装备世界条件的稳定键。

调用方
Simulator 与装备相关评分。

输入
玩家 ID 与装备定义 ID。

输出
稳定的条件字符串。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
相同实体组合必须生成相同键。
*/
export function equipmentConditionKey(playerId, definitionId) {
  return `equipment:${playerId}:${definitionId}`;
}

/*
功能
生成猎杀标记世界条件的稳定键。

调用方
Simulator 与猎杀相关评分。

输入
来源玩家 ID 与目标玩家 ID。

输出
稳定的条件字符串。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
相同来源目标组合必须生成相同键。
*/
export function huntMarkConditionKey(sourceId, targetId) {
  return `huntMark:${sourceId}:${targetId}`;
}

/*
功能
读取资源数值字段的完整概率分支并提供确定性回退。

调用方
Simulator 与价值计算模块。

输入
资源对象、字段名与回退值。

输出
规范化数值状态分支数组。

读取状态
resource 对应 Branches 字段。

写入状态
无。

调用函数
mergeProbabilityStateBranches。

边界与不变量
缺失或空分支时返回一个概率为一的 amount 回退分支。
*/
export function getValueBranches(resource, field, fallbackValue = 0) {
  return [{
    probability:1,
    conditions:{},
    amount:Number(resource?.[field] ?? fallbackValue) || 0
  }];
}

/*
功能
从 canonical Fact 创建唯一 ProbabilityState facade contract。

调用方
StateContracts。

输入
当前 Fact。

输出
带 CURRENT_STATE_PROBABILITY classification 的 finite-pool state。

读取状态
Fact current counts 与匿名槽位。

写入状态
无。

调用函数
Pool.createFinitePoolState。

边界与不变量
业务 definition allowlist 留在 facade；Pool 不知道具体卡牌 ID。
*/
export function createProbabilityState(fact) {
  return createFinitePoolState(fact, {
    drawBucketId:PROBABILITY_DRAW_BUCKET,
    classification:PROBABILITY_CLASSIFICATION.CURRENT_STATE_PROBABILITY
  });
}

/*
功能
把当前桶确定无目标定义的观察写入 ProbabilityState 后验。

调用方
RootResolutionQuery 与 ValueSimulationQuery。

输入
ProbabilityState 与 maximum=0 的业务 condition。

输出
观察前证据概率。

读取状态
当前 finite-pool factors。

写入状态
更新同一 ProbabilityState 当前后验。

调用函数
Pool.conditionFinitePool。

边界与不变量
当前兼容 definition allowlist 仍由 facade 控制，不扩展既有四类 schema。
*/
export function conditionProbability(state, condition = {}) {
  return conditionFinitePool(state, condition, PROBABILITY_DEFINITION_IDS);
}

/*
功能
按业务 mutation contract 推进 canonical ProbabilityState。

调用方
Simulation effects。

输入
ProbabilityState 与 MOVE/ADD/REMOVE/CONDITION mutation。

输出
同一 ProbabilityState。

读取状态
当前 finite-pool factors。

写入状态
提交 Pool 返回的当前充分统计。

调用函数
Pool.mutateFinitePool。

边界与不变量
默认 draw bucket 与兼容 condition allowlist 由 facade 注入；Pool 不保存业务常量。
*/
export function mutateProbability(state, mutation = {}) {
  return mutateFinitePool(state, mutation, {
    drawBucketId:PROBABILITY_DRAW_BUCKET,
    allowedDefinitionIds:PROBABILITY_DEFINITION_IDS
  });
}


/*
功能
计算当前已知实体资源中可用实体数量的局部分布。

调用方
queryHandProbability、probabilityAnyAvailable。

输入
当前确定属于同一定义的实体资源数组。

输出
只在本次查询存在的 count distribution。

读取状态
各实体当前 availability 标量。

写入状态
无。

调用函数
getAvailabilityStateBranches、intersectProbabilityStateBranches、projectProbabilityStateBranches。

边界与不变量
每个实体最多贡献一；共享动态 event key 通过索引条件化一次，结果不写回持久 ProbabilityState。
*/
function availableResourceCountDistribution(resources = []) {
  let distribution = [{ probability:1, conditions:{}, count:0 }];
  for (const resource of resources) {
    const availability = getAvailabilityStateBranches(resource).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      available:Boolean(branch.available)
    }));
    distribution = projectProbabilityStateBranches(
      intersectProbabilityStateBranches(distribution, availability),
      (branch) => ({ count:branch.count + (branch.available ? 1 : 0) })
    );
  }
  return distribution;
}

/*
功能
查询当前确定身份资源中至少一个仍可用的概率。

调用方
sealOutcomeProbabilities 的团队已知 Counter 查询。

输入
当前确定身份资源数组。

输出
零到一的局部事件概率。

读取状态
资源 availability 状态。

写入状态
无。

调用函数
availableResourceCountDistribution、totalBranchProbability。

边界与不变量
不构造所有隐藏牌世界；临时分支上界只由当前实体资源数与当前动态条件数决定。
*/
export function probabilityAnyAvailable(resources = []) {
  return clampProbability(totalBranchProbability(
    availableResourceCountDistribution(resources).filter((branch) => branch.count >= 1)
  ));
}

/*
功能
惰性查询一名玩家当前手牌中某定义的完整数量分布。

调用方
Response/Combat/Card Simulation、SearchPrior 与 Value 的真实未知消费点。

输入
ProbabilityState、玩家匿名 bucketId、当前确定身份资源、definitionId 与数量阈值。

输出
count distribution、期望和达到阈值的概率。

读取状态
当前有限池 factor 与确定身份 availability。

写入状态
无。

调用函数
queryProbability、availableResourceCountDistribution、mergeProbabilityStateBranches。

边界与不变量
匿名槽与确定身份是互斥物理集合；临时卷积在查询结束后释放，不写入玩家或 ProbabilityState。
*/
export function queryHandProbability(state, query = {}) {
  const definitionId = query.definitionId;
  const anonymous = queryProbability(state, {
    definitionId,
    bucketId:query.bucketId
  }).distribution;
  const known = availableResourceCountDistribution(
    (query.knownResources ?? []).filter((entry) => entry?.definitionId === definitionId)
  );
  const combined = [];
  const outputCount = anonymous.length * known.length;
  for (let index = 0; index < outputCount; index += 1) {
    const anonymousBranch = anonymous[Math.floor(index / known.length)];
    const knownBranch = known[index % known.length];
    combined.push({
      count:anonymousBranch.count + knownBranch.count,
      probability:anonymousBranch.probability * knownBranch.probability,
      conditions:knownBranch.conditions ?? {}
    });
  }
  const distribution = mergeProbabilityStateBranches(combined)
    .sort((left, right) => left.count - right.count);
  const minimum = Math.max(0, Math.floor(Number(query.minimum) || 1));
  return {
    distribution,
    expected:distribution.reduce(
      (sum, branch) => sum + branch.count * branch.probability,
      0
    ),
    probability:clampProbability(totalBranchProbability(
      distribution.filter((branch) => branch.count >= minimum)
    ))
  };
}

/*
功能
从 canonical World 玩家和唯一 ProbabilityState 惰性查询当前手牌定义数量。

调用方
Simulation、SearchPrior、Policy 与 Value 的响应/资源消费点。

输入
ProbabilityState、World 玩家、definitionId 与最小数量。

输出
当前局部 count distribution、期望数量与达到阈值的概率。

读取状态
玩家自己的 hand 或合法 knownCards，以及 ProbabilityState 匿名桶。

写入状态
无。

调用函数
queryHandProbability。

边界与不变量
查询结果只在调用栈内存在，不得写回 World 或 ProbabilityState。
*/
export function queryPlayerHandProbability(state, player, definitionId, minimum = 1) {
  return queryHandProbability(state, {
    bucketId:player?.id,
    knownResources:[
      ...(Array.isArray(player?.hand) ? player.hand : []),
      ...(Array.isArray(player?.knownCards) ? player.knownCards : [])
    ],
    definitionId,
    minimum
  });
}

/*
功能
按给定响应顺序直接计算首个拥有目标资源的响应者概率。

调用方
ResponseSimulation 的 card-scope Counter 链。

输入
ProbabilityState、definitionId，以及按顺序提供的 bucketId/knownResources 响应者。

输出
每个响应者成为首名可用者的概率和无人可用概率。

读取状态
同一 finite-pool factor 与当前确定身份 availability。

写入状态
无。

调用函数
queryProbability、probabilityAnyAvailable。

边界与不变量
使用 `P(previous none) - P(previous+current none)`，不连接逐玩家边际；
同一有限池实例不可能同时成为两名响应者的牌，结果互斥且总质量为一。
*/
export function queryOrderedFirstResponder(
  state,
  definitionId,
  responders = []
) {
  const probabilities = [];
  const prefixBuckets = [];
  const prefixKnown = [];
  let previousNone = 1;
  for (const responder of responders) {
    prefixBuckets.push(responder.bucketId);
    prefixKnown.push(...(responder.knownResources ?? []));
    const anonymousAny = queryProbability(state, {
      definitionId,
      groupBucketIds:prefixBuckets
    }).probability;
    const knownAny = probabilityAnyAvailable(prefixKnown);
    const currentNone = (1 - anonymousAny) * (1 - knownAny);
    probabilities.push({
      responderId:responder.responderId,
      probability:clampProbability(previousNone - currentNone)
    });
    previousNone = currentNone;
  }
  return {
    responders:probabilities,
    none:clampProbability(previousNone)
  };
}

/*
功能
从根 ProbabilityState 采样有限个 Monte Carlo 隐藏手牌估计。

调用方
CounterfactualTerms 的根搜索上下文。

输入
观察者 ID、当前 ProbabilityState、过滤玩家、样本数与 Search RNG。

输出
显式 MONTE_CARLO_ESTIMATE 契约。

读取状态
单一未条件化根 factor 与玩家确定 knownCards。

写入状态
只写各样本私有计数副本。

调用函数
random。

边界与不变量
采样不是 exact Probability；每个槽消费一个实例且世界间不共享计数，条件化搜索状态不得进入该根采样入口。
*/
export function sampleProbabilityWorlds({
  viewerId,
  probabilityState,
  players,
  sampleCount,
  random
}) {
  const factors = probabilityState?.factors ?? [];
  if (factors.length !== 1 || factors[0].slotGroups.some(
    (group) => group.excludedDefinitions.length > 0
  )) {
    throw new Error("隐藏世界采样只接受未条件化的当前根 ProbabilityState");
  }
  const factor = factors[0];
  const count = Math.max(0, Math.floor(Number(sampleCount) || 0));
  const worlds = Array.from({ length:count }, () => {
    const remaining = { ...factor.cardCounts };
    /*
    功能
    从单个 Monte Carlo 样本的当前剩余实例中抽取并消费一个定义。

    调用方
    sampleProbabilityWorlds 的匿名槽填充。

    输入
    无；使用闭包 remaining 与 random。

    输出
    抽中的 definitionId。

    读取状态
    当前样本 remaining 与注入 Search RNG。

    写入状态
    当前样本对应定义计数减一。

    调用函数
    random。

    边界与不变量
    每个匿名槽消费一个实例；不同样本不共享 remaining。
    */
    const drawDefinition = () => {
      const entries = Object.entries(remaining).filter(([, value]) => value > 0);
      const total = entries.reduce((sum, [, value]) => sum + value, 0);
      if (total <= 0) throw new Error("隐藏世界抽样槽位超过当前有限牌池");
      let roll = random() * total;
      for (const [definitionId, value] of entries) {
        if (roll < value) {
          remaining[definitionId] -= 1;
          return definitionId;
        }
        roll -= value;
      }
      const definitionId = entries.at(-1)[0];
      remaining[definitionId] -= 1;
      return definitionId;
    };
    return Object.fromEntries((players ?? [])
      .filter((player) => player.id !== viewerId)
      .map((player) => {
        const known = (player.knownCards ?? [])
          .filter((entry) => totalBranchProbability(getAvailabilityBranches(entry)) >= 1 - PROBABILITY_EPSILON)
          .map((entry) => entry.definitionId);
        const anonymousSlots = factor.slotGroups
          .filter((group) => group.bucketId === player.id)
          .reduce((sum, group) => sum + group.count, 0);
        return [
          player.id,
          [...known, ...Array.from({ length:anonymousSlots }, drawDefinition)]
        ];
      }));
  });
  return Object.freeze({
    classification:PROBABILITY_CLASSIFICATION.MONTE_CARLO_ESTIMATE,
    sampleCount:count,
    worlds:Object.freeze(worlds)
  });
}
