/**
 * 模块：隐藏信息与概率推理（单点场景）+ 反事实 Family（拆分变体）。
 * 未知手牌只以数量与密度进入 AI 视角，遵守生产 AiVisibleState / AiKnowledge。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isEnd, targetsOnly, describeActionShort,
  QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id: "a", team: "dawn", character: "blade-walker" },
  { id: "b", team: "dusk", character: "oath-warden" },
  { id: "c", team: "dusk", character: "fate-gambler" },
  { id: "d", team: "dawn", character: "spirit-medic" },
  { id: "e", team: "dusk", character: "ember-magus" }
];

function board(actorOverrides = {}, others = {}, viewerMemory = null) {
  const players = BASE.map((config) => ({ ...config }));
  for (const player of players) {
    if (player.id === "a") continue;
    const override = others[player.id] ?? {};
    player.hp = override.hp ?? 4;
    player.energy = override.energy ?? 1;
    player.hand = override.hand ?? makeCards(["assault"]);
    player.equipment = override.equipment ?? null;
    player.statuses = override.statuses ?? {};
  }
  const actor = players[0];
  actor.hp = actorOverrides.hp ?? 4;
  actor.energy = actorOverrides.energy ?? 2;
  // maxEnergy 由 makeGame 按生产 TeamRuleService 计算。
  actor.hand = actorOverrides.hand ?? [];
  actor.statuses = actorOverrides.statuses ?? {};
  if (viewerMemory) actor.aiMemory = { ...actor.aiMemory, ...viewerMemory };
  return { players, options: { actorId: "a", seed: 7000 } };
}

// ---------- 单点概率场景 ----------

registerScenario({
  id: "probability.guaranteed-block",
  name: "确定有格挡时避免直突袭",
  category: "probability",
  depth: 2,
  difficulty: "advanced",
  discrimination: "probability",
  setup: () => board(
    { hand: [makeCard("assault"), makeCard("exposeWeakness")] },
    { b: { hp: 2, hand: [makeCard("block", "kb1")] } },
    { knownCardsByPlayer: { b: [{ id: "kb1", definitionId: "block" }] } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "破势不受格挡影响，再突袭");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.SEVERE, "明知有格挡仍直突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.counter-held",
  name: "确定有反制时避免战术牌",
  category: "probability",
  depth: 2,
  difficulty: "advanced",
  discrimination: "probability",
  setup: () => board(
    { hand: [makeCard("shockwave"), makeCard("assault")] },
    { b: { hp: 2, hand: [makeCard("counter", "kc1")] } },
    { knownCardsByPlayer: { b: [{ id: "kc1", definitionId: "counter" }] } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "shockwave")) return quality(QUALITY.SEVERE, "震波必被反制，浪费资源");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭不可被反制");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.unknown-counter-risk",
  name: "未知反制风险下的战术牌取舍",
  category: "probability",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "probability",
  setup: () => board(
    { hand: [makeCard("provoke"), makeCard("assault")] },
    { b: { hp: 2, hand: [makeCard("assault"), makeCard("assault")] } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.STRONG, "低反制概率下挑衅收益合理");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.STRONG, "直接突袭亦可接受");
    if (isEnd(action)) return quality(QUALITY.POOR, "过度保守");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.defense-device-risk",
  name: "雷达装备概率影响突袭",
  category: "probability",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "probability",
  setup: () => board(
    { hand: [makeCard("assault"), makeCard("exposeWeakness")] },
    { b: { hp: 2, equipment: makeCard("defenseDevice"), hand: [makeCard("assault")] } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.STRONG, "破势绕过雷达判定风险");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "雷达可能令突袭无效");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.tactic-vs-probable-counter",
  name: "大概率反制下的战术牌风险",
  category: "probability",
  depth: 2,
  difficulty: "advanced",
  discrimination: "probability",
  setup: () => board(
    { hand: [makeCard("provoke"), makeCard("assault")] },
    {
      b: { hp: 1, hand: [makeCard("counter", "kp"), makeCard("assault")] },
      c: { hp: 4 }
    },
    { knownCardsByPlayer: { b: [{ id: "kp", definitionId: "counter" }] } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.POOR, "挑衅大概率被反制");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭收 1HP 目标，规避反制");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.tactic-no-counter",
  name: "无反制风险时战术牌优先",
  category: "probability",
  depth: 2,
  difficulty: "advanced",
  discrimination: "probability",
  setup: () => board(
    { hand: [makeCard("provoke"), makeCard("assault")] },
    { b: { hp: 2, hand: [makeCard("assault"), makeCard("assault")] } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.OPTIMAL, "无已知反制，挑衅收益明确");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.STRONG, "直接突袭亦可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------- 反事实 Family：格挡概率 ----------

const blockVariantBoard = (hand, known) => board(
  { hand: [makeCard("assault"), makeCard("assault")] },
  { b: { hp: 2, hand } },
  { knownCardsByPlayer: { b: known } }
);

registerScenario({
  id: "probability.block-0pct",
  name: "格挡概率 Family：0%",
  category: "counterfactual",
  depth: 2,
  family: "block-probability",
  expectedClass: "card:assault",
  difficulty: "intermediate",
  discrimination: "probability",
  setup: () => blockVariantBoard([makeCard("assault"), makeCard("assault")], []),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "0% 格挡，双突袭必杀");
    return quality(QUALITY.POOR, `0% 格挡却未进攻：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.block-50pct",
  name: "格挡概率 Family：50%",
  category: "counterfactual",
  depth: 2,
  family: "block-probability",
  expectedClass: "card:exposeWeakness",
  difficulty: "intermediate",
  discrimination: "probability",
  setup: () => blockVariantBoard([makeCard("block", "kb"), makeCard("assault")], [{ id: "kb", definitionId: "block" }]),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "破势绕过格挡风险");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "进攻有风险但可接受");
    return quality(QUALITY.POOR, `50% 格挡下决策一般：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.block-100pct",
  name: "格挡概率 Family：100%",
  category: "counterfactual",
  depth: 2,
  family: "block-probability",
  expectedClass: "card:exposeWeakness",
  difficulty: "advanced",
  discrimination: "probability",
  setup: () => blockVariantBoard([makeCard("block", "kb2")], [{ id: "kb2", definitionId: "block" }]),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "100% 格挡下用破势突破");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.SEVERE, "100% 格挡仍直突袭");
    return quality(QUALITY.POOR, `100% 格挡时决策一般：${describeActionShort(action)}`);
  }
});

// ---------- 反事实 Family：目标血量 ----------

const hpVariantBoard = (hp) => board(
  { hand: [makeCard("assault"), makeCard("exposeWeakness")] },
  {
    b: { hp, hand: [makeCard("assault")] },
    c: { hp: 4, hand: [makeCard("assault")] }
  }
);

registerScenario({
  id: "probability.target-hp-1",
  name: "目标血量 Family：1HP",
  category: "counterfactual",
  depth: 1,
  family: "target-hp",
  expectedClass: "card:assault",
  difficulty: "basic",
  discrimination: "counterfactual",
  setup: () => hpVariantBoard(1),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "1HP 直接击杀");
    return quality(QUALITY.SEVERE, "1HP 目标未直接击杀");
  }
});

registerScenario({
  id: "probability.target-hp-2",
  name: "目标血量 Family：2HP",
  category: "counterfactual",
  depth: 2,
  family: "target-hp",
  expectedClass: "card:exposeWeakness",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => hpVariantBoard(2),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "2HP 先破势再突袭");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "直接突袭亦可接受");
    return quality(QUALITY.POOR, `2HP 决策一般：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "probability.target-hp-3",
  name: "目标血量 Family：3HP",
  category: "counterfactual",
  depth: 2,
  family: "target-hp",
  expectedClass: "card:exposeWeakness",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => hpVariantBoard(3),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.STRONG, "3HP 铺垫合理");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "直接突袭亦可接受");
    return quality(QUALITY.POOR, `3HP 决策一般：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "probability", label: "Hidden Info & Probability" };
