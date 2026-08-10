/**
 * 模块 D：数值与资源判断。
 * 测试能量、手牌、装备与血量的边际判断，以及溢出管理。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isSkill, isEnd, targetsOnly,
  gradeByAction, playCard, playSkill, endTurn, describeActionShort,
  QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id: "a", team: "dawn", general: "blade-walker" },
  { id: "b", team: "dusk", general: "oath-warden" },
  { id: "c", team: "dusk", general: "fate-gambler" },
  { id: "d", team: "dawn", general: "spirit-medic" },
  { id: "e", team: "dusk", general: "ember-magus" }
];

function board(actorOverrides = {}, others = {}) {
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
  if (actorOverrides.general) actor.general = actorOverrides.general;
  actor.hp = actorOverrides.hp ?? 4;
  actor.energy = actorOverrides.energy ?? 3;
  // maxEnergy 由 makeGame 按生产 TeamRuleService 计算。
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  return { players, options: { actorId: "a", seed: 4000 } };
}

registerScenario({
  id: "resources.energy-threshold-skill",
  name: "能量阈值：为技能保留能量",
  category: "resources",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "resource",
  setup: () => board({
    energy: 1,
    hand: [makeCard("assault"), makeCard("charge")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能越过 2 能量阈值解锁破军");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "立即突袭放弃技能解锁");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.no-overkill-shield",
  name: "避免无谓消耗：不溢出血量",
  category: "resources",
  depth: 1,
  setup: () => board({
    energy: 1,
    hand: [makeCard("recover")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.SEVERE, "满血仍使用恢复，资源浪费");
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "正确保留手牌");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.shield-before-assault",
  name: "护盾价值高于普通突袭",
  category: "resources",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "resource",
  setup: () => board({
    energy: 2,
    hand: [makeCard("shield"), makeCard("assault")]
  }, { d: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾保住 1HP 队友");
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.ACCEPTABLE, "护盾自身亦可接受");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "无视队友濒死风险");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.harvest-draw-value",
  name: "丰收过牌价值",
  category: "resources",
  depth: 1,
  setup: () => board({
    energy: 2,
    hand: [makeCard("harvest"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "harvest")) return quality(QUALITY.OPTIMAL, "丰收补牌提高后续选择空间");
    if (isCard(action, "assault")) return quality(QUALITY.ACCEPTABLE, "突袭可接受但先过牌更优");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.assault-count-pressure",
  name: "突袭数量决定攻防节奏",
  category: "resources",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "resource",
  setup: () => board({
    energy: 2,
    hand: [makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "先破势让双突袭同时受益");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "未铺垫直接突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.energy-device-tempo",
  name: "充能塔节奏价值",
  category: "resources",
  depth: 2,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board({
    energy: 1,
    hand: [makeCard("energyDevice"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "energyDevice")) return quality(QUALITY.OPTIMAL, "装备充能塔提升后续能量");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "放弃装备节奏");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.low-hp-dont-waste-buff",
  name: "1HP 目标不需要强化",
  category: "resources",
  depth: 2,
  setup: () => board({
    energy: 2,
    hand: [makeCard("assault"), makeCard("exposeWeakness")]
  }, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "1 点伤害必杀，不需要破势");
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.SEVERE, "对必杀目标使用破势是浪费");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.skill-cost-vs-charge",
  name: "技能费用约束下的聚能取舍",
  category: "resources",
  depth: 2,
  setup: () => board({
    general: "ember-magus",
    energy: 2,
    hand: [makeCard("charge"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "先突袭保留能量，为下回合焚场铺垫");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "聚能后立刻焚场可接受，但能量利用略浪费");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "resources.discard-tempo",
  name: "低血量放弃弃牌压力",
  category: "resources",
  depth: 1,
  difficulty: "intermediate",
  discrimination: "resource",
  setup: () => board({
    hp: 2,
    energy: 2,
    hand: [makeCard("recover"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.OPTIMAL, "低血量先恢复减少弃牌压力");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "先攻后恢复，可能被击杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "resources", label: "Numerical & Resource" };
