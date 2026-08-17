/**
 * 模块 F：环境与局面判断。
 * 测试威胁优先级、装备/状态/队友环境对决策的影响。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isSkill, isEnd, targetsOnly,
  gradeByAction, playCard, playSkill, endTurn, describeActionShort,
  QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id: "a", team: "dawn", character: "blade-walker" },
  { id: "b", team: "dusk", character: "oath-warden" },
  { id: "c", team: "dusk", character: "fate-gambler" },
  { id: "d", team: "dawn", character: "spirit-medic" },
  { id: "e", team: "dusk", character: "ember-magus" }
];

function board(actorOverrides = {}, others = {}) {
  const players = BASE.map((config) => ({ ...config }));
  for (const player of players) {
    if (player.id === "a") continue;
    const override = others[player.id] ?? {};
    if (override.character) player.character = override.character;
    player.hp = override.hp ?? 4;
    player.energy = override.energy ?? 1;
    player.hand = override.hand ?? makeCards(["assault"]);
    player.equipment = override.equipment ?? null;
    player.statuses = override.statuses ?? {};
    player.turnFlags = override.turnFlags ?? {};
  }
  const actor = players[0];
  actor.hp = actorOverrides.hp ?? 4;
  actor.energy = actorOverrides.energy ?? 2;
  // maxEnergy 由 makeGame 按生产 TeamRuleService 计算。
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  return { players, options: { actorId: "a", seed: 6000 } };
}

registerScenario({
  id: "board.threat-priority",
  name: "威胁优先：装备强敌优先",
  category: "board",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board({
    hand: [makeCard("assault")]
  }, { b: { hp: 4, equipment: makeCard("battleDevice") }, c: { hp: 2 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "优先压制军火库威胁");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.POOR, "选择低威胁目标");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.sealed-enemy-skip",
  name: "封印目标不浪费伤害",
  category: "board",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board({
    hand: [makeCard("assault")]
  }, { b: { hp: 1, statuses: { sealed: true } }, c: { hp: 2 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.OPTIMAL, "封印敌人下回合不能行动，先打未封印");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "打死封印目标收益有限");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.ally-low-hp-defend",
  name: "队友濒死优先防守",
  category: "board",
  depth: 2,
  setup: () => board({
    hand: [makeCard("shield"), makeCard("assault")]
  }, { d: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾保 1HP 队友");
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.POOR, "自身非危急目标");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "无视队友濒死");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.response-save",
  name: "保留响应应对大威胁",
  category: "board",
  depth: 2,
  setup: () => board({
    hand: [makeCard("block"), makeCard("assault")]
  }, { b: { equipment: makeCard("battleDevice") } }),
  grade: ({ action }) => {
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "主动阶段保留格挡，同时消耗敌方");
    if (isEnd(action)) return quality(QUALITY.ACCEPTABLE, "保守可接受但失去节奏");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.incoming-threat-low-hp",
  name: "自身濒死不再激进",
  category: "board",
  depth: 2,
  setup: () => board({
    hp: 1,
    hand: [makeCard("assault"), makeCard("recover")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.OPTIMAL, "1HP 先恢复");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "濒死仍进攻");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.radar-equipment-threat",
  name: "雷达装备影响突袭判断",
  category: "board",
  depth: 2,
  setup: () => board({
    hand: [makeCard("assault"), makeCard("exposeWeakness")]
  }, { b: { equipment: makeCard("defenseDevice") } }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.STRONG, "破势先于突袭合理");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "雷达可能使突袭失效");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.equipment-count-value",
  name: "敌方装备数量决定破坏价值",
  category: "board",
  depth: 2,
  setup: () => board({
    hand: [makeCard("destroy"), makeCard("assault")]
  }, { b: { equipment: makeCard("energyDevice") } }),
  grade: ({ action }) => {
    if (isCard(action, "destroy") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "破坏充能塔遏制敌方资源");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "忽略装备资源");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.distance-equipment",
  name: "望远镜扩大射程",
  category: "board",
  depth: 2,
  setup: () => board({
    hand: [makeCard("assault"), makeCard("telescope")],
    energy: 1
  }, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "telescope")) return quality(QUALITY.ACCEPTABLE, "望远镜扩大射程可接受");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "直接击杀 1HP 目标");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "board.defend-against-threat",
  name: "面对高威胁敌人优先防守",
  category: "board",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board({
    hp: 2,
    hand: [makeCard("shield"), makeCard("assault")]
  }, { b: { equipment: makeCard("battleDevice") }, c: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.OPTIMAL, "2HP 面对军火库威胁先护盾");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.POOR, "击杀 1HP 目标但暴露自身");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "先攻强敌风险过大");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "board", label: "Board Awareness" };
