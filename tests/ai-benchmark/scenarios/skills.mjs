/**
 * 模块 C：角色技能理解。
 * 覆盖当前 8 名角色的主动/被动技能与卡牌、HP、能量、队友、敌人、响应、行动顺序的组合关系。
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

function board(general, overrides = {}, others = {}) {
  const players = BASE.map((config) => ({ ...config }));
  players[0].general = general;
  const fill = (player) => {
    player.hp = others[player.id]?.hp ?? 4;
    player.energy = others[player.id]?.energy ?? 1;
    player.hand = others[player.id]?.hand ?? makeCards(["assault"]);
    if (others[player.id]?.equipment) player.equipment = others[player.id].equipment;
    if (others[player.id]?.statuses) player.statuses = others[player.id].statuses;
    if (others[player.id]?.knownCards) player.knownCards = others[player.id].knownCards;
    if (others[player.id]?.knownOwnerId) player.knownOwnerId = others[player.id].knownOwnerId;
    if (others[player.id]?.turnFlags) player.turnFlags = others[player.id].turnFlags;
  };
  for (const player of players) fill(player);
  const actor = players[0];
  actor.hp = overrides.hp ?? 4;
  actor.energy = overrides.energy ?? 3;
  actor.shield = overrides.shield ?? 0;
  actor.hand = overrides.hand ?? [makeCard("assault")];
  actor.turnFlags = overrides.turnFlags ?? {};
  actor.statuses = overrides.statuses ?? {};
  return { players, options: { actorId: "a", seed: 3000 } };
}

registerScenario({
id: "skills.blade-momentum-order",
  name: "刃行者：先铺垫后突袭",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board("blade-walker", {
    energy: 3,
    hand: [makeCard("assault"), makeCard("exposeWeakness"), makeCard("charge")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "先破势再突袭，利用连势与破势");
    if (isCard(action, "charge")) return quality(QUALITY.STRONG, "先聚能可接受，但破势更直接");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "未铺垫直接突袭，浪费连势");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "skills.blade-break-army-combo",
  name: "刃行者：破军补足突袭次数",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => board("blade-walker", {
    energy: 3,
    turnFlags: { attackUsed: 1, attackLimit: 1 },
    hand: [makeCard("assault"), makeCard("assault"), makeCard("charge")]
  }),
  grade: ({ action }) => {
    if (isSkill(action, "breakArmy")) return quality(QUALITY.OPTIMAL, "破军解锁当前唯一可兑现的额外突袭");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "次数已尽仍选择突袭");
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "先聚能触发新类别连势，后续仍能破军并突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "skills.oath-barrier-low-hp",
  name: "守誓者：壁垒护低血队友",
  category: "basicSkills",
  depth: 2,
  setup: () => board("oath-warden", {
    energy: 3,
    hand: [makeCard("shield")]
  }, { d: { hp: 1 } }),
  grade: ({ action }) => {
    if (isSkill(action, "barrier") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "壁垒给 1HP 队友");
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.STRONG, "护盾牌亦可救队友");
    if (isSkill(action, "barrier") && targetsOnly(action, "a")) return quality(QUALITY.POOR, "自身满血不如队友危急");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "skills.medic-symbiosis-injured",
  name: "灵医：共生只治受伤",
  category: "basicSkills",
  depth: 2,
  setup: () => board("spirit-medic", {
    energy: 3,
    hand: [makeCard("recover")]
  }, { d: { hp: 2 } }),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "治疗 2HP 队友");
    if (isCard(action, "recover")) return quality(QUALITY.ACCEPTABLE, "恢复自己亦可接受，但队友更危急");
    if (isSkill(action, "symbiosis") && targetsOnly(action, "a")) return quality(QUALITY.POOR, "自身未受伤，浪费治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "skills.shade-steal-equipment",
  name: "影客：窃取敌方装备",
  category: "basicSkills",
  depth: 2,
  setup: () => board("shade-agent", {
    energy: 3,
    hand: [makeCard("assault")]
  }, { b: { equipment: makeCard("battleDevice") } }),
  grade: ({ action }) => {
    if (isSkill(action, "stealSkill") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "窃取军火库削弱敌方");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "忽视窃取价值");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "skills.ember-burning-field",
  name: "炎术师：焚场多目标价值",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board("ember-magus", {
    energy: 3,
    hand: [makeCard("assault")]
  }, { c: { hp: 1 }, e: { hp: 1 } }),
  grade: ({ action }) => {
    if (isSkill(action, "burningField")) return quality(QUALITY.OPTIMAL, "焚场同时威胁两个低血敌人");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "单点突袭不如焚场多目标收益");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "skills.hunter-hunt-marked",
  name: "追猎者：猎杀优先带印记目标",
  category: "basicSkills",
  depth: 2,
  setup: () => board("trail-hunter", {
    energy: 3,
    hand: [makeCard("assault")]
  }, { b: { statuses: { huntMark: { sourceId: "a" } }, hp: 3 }, c: { hp: 2 } }),
  grade: ({ action }) => {
    if (isSkill(action, "hunt") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "猎杀印记目标造成 2 点伤害");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.POOR, "忽略印记目标");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "攻击印记目标可接受但不如猎杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "skills.gambler-all-in-value",
  name: "赌命者：孤注价值判断",
  category: "resources",
  depth: 3,
  difficulty: "advanced",
  discrimination: "resource",
  setup: () => board("fate-gambler", {
    energy: 3,
    hand: [makeCard("assault"), makeCard("charge")]
  }),
  grade: ({ action }) => {
    if (isSkill(action, "allIn")) return quality(QUALITY.OPTIMAL, "3 能量孤注摸 2 张并 75% 概率强化突袭");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "聚能较保守，孤注期望更高");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "直接突袭放弃资源转化");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "skills.gambler-all-in-no-double",
  name: "赌命者：已有孤注不重复发动",
  category: "basicSkills",
  depth: 1,
  setup: () => board("fate-gambler", {
    energy: 3,
    statuses: { allIn: { assaultBonus: 1 } },
    hand: [makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isSkill(action, "allIn")) return quality(QUALITY.CATASTROPHIC, "孤注不可叠加，已有状态仍发动");
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "直接利用已有孤注突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "skills.tuner-resonance-draw",
  name: "调律师：共鸣帮助队友过牌",
  category: "basicSkills",
  depth: 2,
  setup: () => board("resonance-tuner", {
    energy: 3,
    hand: [makeCard("assault")]
  }, { d: { hand: makeCards(["assault"]) } }),
  grade: ({ action }) => {
    if (isSkill(action, "resonance") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "共鸣给队友补牌");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "忽视队友过牌需求");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "skills.hunter-tracking-mark",
  name: "追猎者：突袭留印记",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board("trail-hunter", {
    energy: 2,
    hand: [makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 3 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭留下狩猎印记，为猎杀铺路");
    if (isEnd(action)) return quality(QUALITY.POOR, "放弃印记铺垫");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "skills.medic-rejuvenation-trigger",
  name: "灵医：治疗触发回春",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board("spirit-medic", {
    hp: 2,
    energy: 2,
    hand: [makeCard("recover")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.OPTIMAL, "恢复自身并触发回春抽牌");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗与过牌");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "skills", label: "General Skills" };
