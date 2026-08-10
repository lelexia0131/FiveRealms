/**
 * Counterfactual Families：同一基础局面上只变化一个关键变量，
 * 检验 AI 是否在合理阈值附近改变决策。
 *
 * 每个变体都带 expectedClass（AI 应表现出的行为类别），
 * 用于 family 级别的“类别敏感度”诊断；质量分仍按变体独立给出。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isSkill, isEnd, targetsOnly,
  describeActionShort, QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id: "a", team: "dawn", general: "blade-walker" },
  { id: "b", team: "dusk", general: "oath-warden" },
  { id: "c", team: "dusk", general: "fate-gambler" },
  { id: "d", team: "dawn", general: "spirit-medic" },
  { id: "e", team: "dusk", general: "ember-magus" }
];

function board(general, actorOverrides = {}, others = {}, viewerMemory = null, seed = 10000) {
  others = others ?? {};
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
  actor.energy = actorOverrides.energy ?? 2;
  // maxEnergy 由 makeGame 按生产 TeamRuleService 计算。
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  if (viewerMemory) actor.aiMemory = { ...actor.aiMemory, ...viewerMemory };
  return { players, options: { actorId: "a", seed } };
}

// ---------------------------------------------------------------
// Family 1：破势 vs 突袭（目标 HP / 护盾 / 护援 / 格挡）
// ---------------------------------------------------------------

const exposeBase = (extra = {}) => board("blade-walker", {
  energy: 2,
  hand: [makeCard("assault"), makeCard("exposeWeakness")]
}, {
  b: {
    hp: extra.hp ?? 2,
    shield: extra.shield ?? 0,
    ...(extra.hand ? { hand: extra.hand } : {}),
    ...(extra.equipment ? { equipment: extra.equipment } : {})
  },
  ...(extra.guardian ? { c: { general: "oath-warden", hp: 4, hand: makeCards(["assault", "assault"]) } } : {})
}, extra.viewerMemory ?? null, 10001);

registerScenario({
  id: "cf.expose-hp1",
  name: "破势Family：目标 1HP 直接突袭",
  category: "counterfactual",
  depth: 1,
  family: "expose-vs-assault",
  expectedClass: "card:assault",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => exposeBase({ hp: 1 }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "1 点伤害必杀，破势是浪费");
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.SEVERE, "对 1HP 目标仍铺垫破势");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.expose-hp2",
  name: "破势Family：目标 2HP 先破势",
  category: "counterfactual",
  depth: 2,
  family: "expose-vs-assault",
  expectedClass: "card:exposeWeakness",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => exposeBase({ hp: 2 }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "2HP 先破势再突袭必杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "直突袭只打 1 点，杀不掉 2HP");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.expose-hp3",
  name: "破势Family：目标 3HP 铺垫更弱",
  category: "counterfactual",
  depth: 2,
  family: "expose-vs-assault",
  expectedClass: "card:exposeWeakness",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => exposeBase({ hp: 3 }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.STRONG, "3HP 铺垫合理（为后续突袭）");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "直接突袭可接受但收益低");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.expose-shield1",
  name: "破势Family：目标 1 盾 2HP",
  category: "counterfactual",
  depth: 2,
  family: "expose-vs-assault",
  expectedClass: "card:exposeWeakness",
  difficulty: "advanced",
  discrimination: "counterfactual",
  setup: () => exposeBase({ hp: 2, shield: 1 }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "破势后突袭 2 点穿透盾+血");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "突袭 1 点被盾吸收");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.expose-guardian",
  name: "破势Family：守誓者护援下必杀",
  category: "counterfactual",
  depth: 3,
  family: "expose-vs-assault",
  expectedClass: "card:exposeWeakness",
  difficulty: "advanced",
  discrimination: "counterfactual",
  setup: () => exposeBase({ hp: 2, guardian: true }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "护援可能减 1 伤，破势保证 2 伤击杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "1 伤可能被护援抵消");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.expose-block100",
  name: "破势Family：100% 格挡仍先破势",
  category: "counterfactual",
  depth: 2,
  family: "expose-vs-assault",
  expectedClass: "card:exposeWeakness",
  difficulty: "advanced",
  discrimination: "probability",
  setup: () => exposeBase({
    hp: 2,
    hand: [makeCard("block", "kbb")],
    viewerMemory: { knownCardsByPlayer: { b: [{ id: "kbb", definitionId: "block" }] } }
  }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "格挡挡不了破势");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.SEVERE, "明知 100% 格挡仍直突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Family 2：聚能 vs 保留（能量阈值与手牌结构）
// ---------------------------------------------------------------

const chargeBase = (energy, hand, hp = 4) => board("blade-walker", {
  energy,
  hand
}, { b: { hp } }, null, 10002);

registerScenario({
  id: "cf.charge-below-threshold",
  name: "聚能Family：1 能量必聚能",
  category: "counterfactual",
  depth: 2,
  family: "charge-threshold",
  expectedClass: "card:charge",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => chargeBase(1, [makeCard("charge"), makeCard("assault"), makeCard("assault")]),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能解锁破军，双突袭连段");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "立即突袭放弃破军");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.charge-at-threshold",
  name: "聚能Family：3 能量直接连段",
  category: "counterfactual",
  depth: 2,
  family: "charge-threshold",
  expectedClass: "skill:breakArmy",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => chargeBase(3, [makeCard("charge"), makeCard("assault"), makeCard("assault")]),
  grade: ({ action }) => {
    // maxEnergy=4 下聚能上限为 4，能量未溢出；直接破军与先聚能均不构成严重错误。
    if (isSkill(action, "breakArmy")) return quality(QUALITY.OPTIMAL, "能量足够直接破军");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "先聚能可接受，能量未溢出");
    if (isCard(action, "assault")) return quality(QUALITY.ACCEPTABLE, "直接突袭可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.charge-no-skill-value",
  name: "聚能Family：无技能价值时聚能保守",
  category: "counterfactual",
  depth: 2,
  family: "charge-threshold",
  expectedClass: "card:assault",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => board("oath-warden", {
    energy: 1,
    hand: [makeCard("charge"), makeCard("assault")]
  }, { b: { hp: 2 } }, null, 10003),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "无关键技能，先突袭更直接");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "聚能可接受但收益有限");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Family 3：孤注价值（能量与已有状态）
// ---------------------------------------------------------------

registerScenario({
  id: "cf.allin-energy1",
  name: "孤注Family：1 能量不孤注",
  category: "counterfactual",
  depth: 1,
  family: "all-in-value",
  expectedClass: "card:assault",
  difficulty: "basic",
  discrimination: "counterfactual",
  setup: () => board("fate-gambler", {
    energy: 1,
    hand: [makeCard("assault")]
  }, null, null, 10004),
  grade: ({ action }) => {
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "1 能量孤注无摸牌且概率低，直接突袭");
    if (isSkill(action, "allIn")) return quality(QUALITY.SEVERE, "1 能量孤注几乎无收益");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.allin-energy3",
  name: "孤注Family：3 能量孤注",
  category: "counterfactual",
  depth: 2,
  family: "all-in-value",
  expectedClass: "skill:allIn",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => board("fate-gambler", {
    energy: 3,
    hand: [makeCard("assault")]
  }, null, null, 10005),
  grade: ({ action }) => {
    if (isSkill(action, "allIn")) return quality(QUALITY.OPTIMAL, "3 能量摸 2 张并 75% 强化");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "直接突袭放弃资源转化");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.allin-already",
  name: "孤注Family：已有状态不再孤注",
  category: "counterfactual",
  depth: 1,
  family: "all-in-value",
  expectedClass: "card:assault",
  difficulty: "basic",
  discrimination: "counterfactual",
  setup: () => board("fate-gambler", {
    energy: 3,
    statuses: { allIn: { assaultBonus: 1 } },
    hand: [makeCard("assault")]
  }, null, null, 10006),
  grade: ({ action }) => {
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "已有孤注直接突袭");
    if (isSkill(action, "allIn")) return quality(QUALITY.SEVERE, "孤注不可叠加仍发动");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Family 4：灵医治疗目标与时机
// ---------------------------------------------------------------

registerScenario({
  id: "cf.medic-self-vs-ally",
  name: "灵医Family：自身 2HP 队友 1HP",
  category: "counterfactual",
  depth: 2,
  family: "medic-heal-priority",
  expectedClass: "skill:symbiosis",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => board("spirit-medic", {
    hp: 2,
    energy: 3,
    hand: [makeCard("recover")]
  }, { d: { hp: 1 } }, null, 10007),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "队友 1HP 更危急");
    if (isCard(action, "recover")) return quality(QUALITY.ACCEPTABLE, "恢复自身亦可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.medic-full-hp",
  name: "灵医Family：全队满血不治疗",
  category: "counterfactual",
  depth: 1,
  family: "medic-heal-priority",
  expectedClass: "end",
  difficulty: "basic",
  discrimination: "counterfactual",
  setup: () => board("spirit-medic", {
    hp: 4,
    energy: 3,
    hand: [makeCard("recover")]
  }, {}, null, 10008),
  grade: ({ action }) => {
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "无治疗目标正确保留");
    if (isCard(action, "recover")) return quality(QUALITY.SEVERE, "满血治疗浪费");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.medic-low-hp-self",
  name: "灵医Family：自身 1HP 优先自救",
  category: "counterfactual",
  depth: 1,
  family: "medic-heal-priority",
  expectedClass: "card:recover",
  difficulty: "basic",
  discrimination: "counterfactual",
  setup: () => board("spirit-medic", {
    hp: 1,
    energy: 3,
    hand: [makeCard("recover")]
  }, { d: { hp: 3 } }, null, 10009),
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.OPTIMAL, "自身 1HP 先自救");
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) return quality(QUALITY.POOR, "队友 3HP 不急，自身濒死");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Family 5：追猎者猎杀 vs 突袭（目标 HP）
// ---------------------------------------------------------------

const huntBase = (hp) => board("trail-hunter", {
  energy: 3,
  hand: [makeCard("assault")]
}, {
  b: { hp, statuses: { huntMark: { sourceId: "a" } } },
  c: { hp: 4 }
}, null, 10010);

registerScenario({
  id: "cf.hunt-hp1",
  name: "猎杀Family：1HP 目标直接突袭",
  category: "counterfactual",
  depth: 1,
  family: "hunt-vs-assault",
  expectedClass: "card:assault",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => huntBase(1),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭 1 点击杀即可，节省猎杀");
    if (isSkill(action, "hunt") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "猎杀 2 伤溢出");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.hunt-hp3",
  name: "猎杀Family：3HP 目标用猎杀",
  category: "counterfactual",
  depth: 2,
  family: "hunt-vs-assault",
  expectedClass: "skill:hunt",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => huntBase(3),
  grade: ({ action }) => {
    if (isSkill(action, "hunt") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "猎杀 2 伤大幅逼近击杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "突袭 1 伤浪费猎杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Family 6：焚场 vs 单点（敌人数/血量）
// ---------------------------------------------------------------

const burnBase = (enemyHp, aliveEnemies = 3) => {
  const others = {};
  let index = 1;
  for (const id of ["b", "c", "e"]) {
    if (aliveEnemies === 1 && id !== "b") { others[id] = { hp: 0, alive: false }; continue; }
    others[id] = { hp: enemyHp };
    index += 1;
  }
  return board("ember-magus", {
    energy: 3,
    hand: [makeCard("assault")]
  }, others, null, 10011);
};

registerScenario({
  id: "cf.burn-3-enemies",
  name: "焚场Family：3 敌人用焚场",
  category: "counterfactual",
  depth: 2,
  family: "burning-field-value",
  expectedClass: "skill:burningField",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => burnBase(4, 3),
  grade: ({ action }) => {
    if (isSkill(action, "burningField")) return quality(QUALITY.OPTIMAL, "3 目标共 3 伤，优于单点");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "单点 1 伤不如焚场");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.burn-1-enemy",
  name: "焚场Family：仅 1 敌人不焚场",
  category: "counterfactual",
  depth: 1,
  family: "burning-field-value",
  expectedClass: "card:assault",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => burnBase(4, 1),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "单目标焚场费 1 伤不划算");
    if (isSkill(action, "burningField")) return quality(QUALITY.SEVERE, "1 敌人仍用焚场，费用全耗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.burn-2-enemies-lowhp",
  name: "焚场Family：2 低血敌人优先焚场",
  category: "counterfactual",
  depth: 2,
  family: "burning-field-value",
  expectedClass: "skill:burningField",
  difficulty: "advanced",
  discrimination: "counterfactual",
  setup: () => {
    const others = { b: { hp: 1 }, c: { hp: 1 }, e: { hp: 0, alive: false } };
    return board("ember-magus", {
      energy: 2,
      hand: [makeCard("assault")]
    }, others, null, 10012);
  },
  grade: ({ action }) => {
    if (isSkill(action, "burningField")) return quality(QUALITY.OPTIMAL, "焚场双杀 1HP 敌人");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "只杀一个浪费双杀机会");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Family 7：护盾 vs 进攻（自身血量）
// ---------------------------------------------------------------

const shieldBase = (hp) => board("oath-warden", {
  hp,
  energy: 2,
  hand: [makeCard("shield"), makeCard("assault")]
}, { b: { equipment: makeCard("battleDevice") } }, null, 10013);

registerScenario({
  id: "cf.shield-hp1",
  name: "护盾Family：1HP 先护盾",
  category: "counterfactual",
  depth: 2,
  family: "shield-vs-attack",
  expectedClass: "card:shield",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => shieldBase(1),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.OPTIMAL, "1HP 面对军火库先护盾");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "濒死仍进攻");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.shield-hp4",
  name: "护盾Family：满血直接进攻",
  category: "counterfactual",
  depth: 1,
  family: "shield-vs-attack",
  expectedClass: "card:assault",
  difficulty: "intermediate",
  discrimination: "counterfactual",
  setup: () => shieldBase(4),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "满血无防守压力直接进攻");
    if (isCard(action, "shield")) return quality(QUALITY.ACCEPTABLE, "护盾可接受但节奏偏慢");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// 错误诱饵：立即价值最高 ≠ 最终最佳
// ---------------------------------------------------------------

registerScenario({
id: "bait.assault-vs-expose-setup",
  name: "诱饵：立即突袭价值高但先破势更优",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  adversarial: "setup",
  setup: () => board("blade-walker", {
    energy: 2,
    hand: [makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")]
  }, { b: { hp: 3 } }, null, 10020),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "破势→双突袭共 4 伤，胜于立即 2 伤");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "被立即伤害吸引，顺序错误");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "bait.provoke-before-finish",
  name: "诱饵：挑衅诱出响应再终结",
  category: "combos",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "response-bait",
  setup: () => board("blade-walker", {
    energy: 3,
    hand: [makeCard("provoke"), makeCard("assault")]
  }, { b: { hp: 1, hand: makeCards(["assault", "assault"]) } }, null, 10021),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.OPTIMAL, "挑衅迫使目标消耗突袭，为后续创造安全");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.STRONG, "直接收头亦可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
id: "bait.medic-delay-heal",
  name: "诱饵：先制造触发条件再治疗",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  adversarial: "healing",
  setup: () => board("spirit-medic", {
    hp: 2,
    energy: 3,
    hand: [makeCard("recover"), makeCard("assault")]
  }, { d: { hp: 2 } }, null, 10022),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "共生触发回春再收尾");
    if (isCard(action, "recover")) return quality(QUALITY.STRONG, "恢复自身亦触发回春");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "立即进攻放弃治疗触发");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});
