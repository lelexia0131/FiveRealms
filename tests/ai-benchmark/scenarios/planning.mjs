/**
 * 模块 H：搜索深度与长期规划。
 * 通过行为测试有效规划深度：D1 立即收益、D2 下一动作、D3 铺垫→中间→终结、
 * D4 跨响应/下一回合。
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

function board(general = "blade-walker", actorOverrides = {}, others = {}) {
  const players = BASE.map((config) => ({ ...config }));
  players[0].general = general;
  for (const player of players) {
    if (player.id === "a") continue;
    const override = others[player.id] ?? {};
    if (override.general) player.general = override.general;
    player.hp = override.hp ?? 4;
    player.energy = override.energy ?? 1;
    player.hand = override.hand ?? makeCards(["assault"]);
    player.equipment = override.equipment ?? null;
    player.statuses = override.statuses ?? {};
    player.turnFlags = override.turnFlags ?? {};
  }
  const actor = players[0];
  actor.hp = actorOverrides.hp ?? 4;
  actor.energy = actorOverrides.energy ?? 3;
  // maxEnergy 由 makeGame 按生产 TeamRuleService 计算。
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  return { players, options: { actorId: "a", seed: 8000 } };
}

// ---------- D1：立即收益即可判断 ----------

registerScenario({
  id: "planning.d1-lethal",
  name: "D1：必杀识别",
  category: "planning",
  depth: 1,
  setup: () => board("blade-walker", { hand: [makeCard("assault")] }, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "1 点伤害击杀");
    if (isEnd(action)) return quality(QUALITY.CATASTROPHIC, "放弃必杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "planning.d1-recover-value",
  name: "D1：治疗收益",
  category: "planning",
  depth: 1,
  setup: () => board("spirit-medic", { hp: 2, hand: [makeCard("recover")] }),
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.OPTIMAL, "治疗 2HP 自身");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------- D2：必须考虑下一动作 ----------

registerScenario({
id: "planning.d2-charge-then-skill",
  name: "D2：聚能解锁技能",
  category: "planning",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "planning",
  setup: () => board("blade-walker", {
    energy: 1,
    hand: [makeCard("charge"), makeCard("assault"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能→破军→突袭");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "立即突袭放弃破军");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "planning.d2-buff-before-double",
  name: "D2：强化先于双突袭",
  category: "planning",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "planning",
  setup: () => board("blade-walker", {
    hand: [makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "破势使两次突袭受益");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "顺序错误");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------- D3：铺垫→中间→终结 ----------

registerScenario({
id: "planning.d3-full-combo",
  name: "D3：聚能→破势→终结",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("blade-walker", {
    energy: 1,
    hand: [makeCard("charge"), makeCard("exposeWeakness"), makeCard("assault")]
  }, { b: { hp: 3 } }),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能→破势→突袭三连");
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.ACCEPTABLE, "跳过聚能，收益不足");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "直接突袭放弃全部铺垫");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "planning.d3-all-in-chain",
  name: "D3：孤注→突袭连段",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("fate-gambler", {
    energy: 3,
    hand: [makeCard("assault"), makeCard("assault")]
  }),
  grade: ({ action }) => {
    if (isSkill(action, "allIn")) return quality(QUALITY.OPTIMAL, "孤注抽牌并强化下一次突袭");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "直接突袭放弃资源转化");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "planning.d3-medic-chain",
  name: "D3：治疗→回春→再行动",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("spirit-medic", {
    energy: 3,
    hand: [makeCard("recover"), makeCard("assault")]
  }, { d: { hp: 2 } }),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "治疗触发回春补牌");
    if (isCard(action, "recover")) return quality(QUALITY.ACCEPTABLE, "恢复自身亦可触发回春");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "放弃治疗与回春");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------- D4：跨响应 / 下一回合 ----------

registerScenario({
id: "planning.d4-seal-then-kill",
  name: "D4：封印封锁后再击杀",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  setup: () => board("shade-agent", {
    energy: 3,
    hand: [makeCard("seal"), makeCard("assault")]
  }, {
    b: { hp: 2, hand: [makeCard("block")], knownCards: [{ definitionId: "block", id: "kb" }] },
    c: { hp: 1, hand: [makeCard("assault")] }
  }),
  grade: ({ action }) => {
    if (isCard(action, "seal") && targetsOnly(action, "c")) return quality(QUALITY.OPTIMAL, "封印下回合威胁，再处理格挡目标");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "格挡目标攻击被挡");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.ACCEPTABLE, "击杀 1HP 亦可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "planning.d4-provoke-response",
  name: "D4：挑衅诱出响应",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("blade-walker", {
    energy: 3,
    hand: [makeCard("provoke"), makeCard("assault")]
  }, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.STRONG, "挑衅逼迫目标消耗突袭，后续收头");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.STRONG, "直接收头同样成立");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "planning.d4-energy-save-next-turn",
  name: "D4：为下一回合保留能量",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("ember-magus", {
    energy: 3,
    hand: [makeCard("charge"), makeCard("assault")]
  }, { b: { hp: 3 }, c: { hp: 3 }, e: { hp: 3 } }),
  grade: ({ action }) => {
    // 真实规则（maxEnergy=4 + 余烬）下，charge→焚场 与 突袭→charge→焚场 终态等价，
    // 直接焚场/突袭均为合理行动；聚能并不构成"能量溢出"级别的严重错误。
    if (isSkill(action, "burningField")) return quality(QUALITY.OPTIMAL, "直接焚场，立即收益");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "先聚能再焚场，终态等价");
    if (isCard(action, "assault")) return quality(QUALITY.ACCEPTABLE, "先突袭再焚场，终态等价");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "planning.d4-tracking-setup",
  name: "D4：追踪印记为下回合铺垫",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("trail-hunter", {
    energy: 3,
    hand: [makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 4 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭留下狩猎印记，下回合猎杀");
    if (isEnd(action)) return quality(QUALITY.POOR, "放弃铺印记");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "planning.d4-shield-before-enemy-turn",
  name: "D4：跨回合保护低血队友",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board("oath-warden", {
    energy: 3,
    hand: [makeCard("shield"), makeCard("assault")]
  }, { d: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾保住 1HP 队友跨过敌方回合");
    if (isSkill(action, "barrier") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "壁垒同样保护队友");
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.POOR, "自身非最危急目标");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "无视队友即将被击杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "planning", label: "Planning Depth" };
