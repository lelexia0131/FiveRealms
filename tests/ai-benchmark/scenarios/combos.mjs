/**
 * 模块 E：战术与连招（重点模块）。
 * 测试行动顺序、铺垫/终结、响应诱导、资源保存与队友利用。
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
    player.roundFlags = override.roundFlags ?? {};
  }
  const actor = players[0];
  actor.hp = actorOverrides.hp ?? 4;
  actor.energy = actorOverrides.energy ?? 3;
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  actor.roundFlags = actorOverrides.roundFlags ?? {};
  return { players, options: { actorId: "a", seed: 5000 } };
}

registerScenario({
  id: "combos.charge-break-army-assault",
  name: "聚能→破军→突袭三连",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board({
    energy: 1,
    hand: [makeCard("charge"), makeCard("assault"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "先聚能解锁破军，构成三连");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "直接突袭放弃连段");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.expose-then-assault",
  name: "破势→双突袭顺序",
  category: "combos",
  depth: 3,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board({
    energy: 2,
    hand: [makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")]
  }, { b:{ hp:2, hand:[] }, c:{ hand:[] }, d:{ hand:[] }, e:{ hand:[] } }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "先破势使下一次突袭跨过2HP击杀线");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "普通突袭未跨过当前击杀线");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.momentum-category-order",
  name: "刃行者连势：类别顺序",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board({
    energy: 2,
    hand: [makeCard("charge"), makeCard("assault"), makeCard("exposeWeakness")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "战术类别先触发连势+1，再突袭+1");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "基础类别铺垫也可获得连势");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "首张即突袭无连势加成");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.provoke-then-kill",
  name: "挑衅后击杀的响应压力",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board({
    energy: 3,
    hand: [makeCard("provoke"), makeCard("assault")]
  }, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.STRONG, "先必杀更直接；挑衅可留作后续");
    if (isCard(action, "provoke")) return quality(QUALITY.ACCEPTABLE, "先挑衅可诱导响应，再收人头");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.shield-then-trade",
  name: "护盾后安全换血",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board({
    hp: 1,
    energy: 2,
    hand: [makeCard("shield"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.OPTIMAL, "1HP 先护盾再突袭");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "濒死仍进攻，易被反杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.duel-finisher",
  name: "决斗终结选择",
  category: "combos",
  depth: 2,
  setup: () => board({
    energy: 2,
    hand: [makeCard("duel"), makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 1, hand: makeCards(["assault"]) } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭直接击杀 1HP 目标");
    if (isCard(action, "duel") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "决斗让濒死目标先手，风险大");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.hunt-kill-chain",
  name: "猎杀→击杀抽牌连锁",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board({
    character: "trail-hunter",
    energy: 3,
    hand: [makeCard("assault")]
  }, { b: { hp: 1, statuses: { huntMark: { sourceId: "a" } } } }),
  grade: ({ action }) => {
    if (isSkill(action, "hunt") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "猎杀 2 点伤害完成击杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "突袭可击杀但浪费猎杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.burning-field-setup",
  name: "焚场多目标铺垫",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board({
    character: "ember-magus",
    energy: 3,
    hand: [makeCard("assault"), makeCard("charge")]
  }, { b: { hp: 2 }, c: { hp: 2 }, e: { hp: 2 } }),
  grade: ({ action }) => {
    if (isSkill(action, "burningField")) return quality(QUALITY.OPTIMAL, "焚场先压低全体血量");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "单点突袭不如焚场收益");
    if (isCard(action, "charge")) return quality(QUALITY.POOR, "能量已够焚场，聚能浪费");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.gamble-tactic-trigger",
  name: "赌命者战术牌触发冒险",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board({
    character: "fate-gambler",
    energy: 2,
    hand: [makeCard("exposeWeakness"), makeCard("assault"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "战术牌触发冒险抽牌并破势");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "直接突袭错过冒险收益");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.guardian-aid-kill-block",
  name: "护援存在时的击杀判断",
  category: "combos",
  depth: 3,
  setup: () => board({
    energy: 2,
    hand: [makeCard("assault"), makeCard("exposeWeakness")]
  }, {
    // c 是守誓者，与 b 同阵营，可弃牌护援 b（护援对同阵营有效）
    b: { hp: 2, hand: makeCards(["assault"]) },
    c: { character: "oath-warden", hp: 4, hand: makeCards(["assault", "assault", "assault"]) }
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "目标可能被护援减伤，先破势保证击杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "1 点伤害可能被护援抵消");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.medic-rejuvenation-order",
  name: "灵医：先治疗触发回春",
  category: "combos",
  depth: 3,
  setup: () => board({
    character: "spirit-medic",
    energy: 3,
    hand: [makeCard("recover")]
  }, { d: { hp: 2 } }),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "治疗触发回春抽牌");
    if (isCard(action, "recover")) return quality(QUALITY.ACCEPTABLE, "恢复自身也可触发回春");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "combos.resonance-coordination",
  name: "调律师：共鸣与协调",
  category: "combos",
  depth: 3,
  setup: () => board({
    character: "resonance-tuner",
    energy: 3,
    hand: [makeCard("shield"), makeCard("assault")]
  }, { d: { hp: 2, hand: makeCards(["assault"]) } }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾令队友成为有效目标触发协调");
    if (isSkill(action, "resonance") && targetsOnly(action, "d")) return quality(QUALITY.STRONG, "共鸣补牌并触发协调");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "错过协调过牌");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "combos", label: "Tactics & Combos" };
