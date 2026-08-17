/**
 * 高难度场景：多目标权衡、错误诱饵、跨回合资源冲突、概率边界。
 *
 * 这些场景中"立即价值最高"的动作通常不是最佳选择；
 * 评分只给"明确最优线"满分，次优但合理的替代最多 0.6。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isSkill, isEnd, targetsOnly,
  describeActionShort, QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id: "a", team: "dawn", character: "blade-walker" },
  { id: "b", team: "dusk", character: "oath-warden" },
  { id: "c", team: "dusk", character: "fate-gambler" },
  { id: "d", team: "dawn", character: "spirit-medic" },
  { id: "e", team: "dusk", character: "ember-magus" }
];

function board(character = "blade-walker", actorOverrides = {}, others = {}, viewerMemory = null, seed = 20000) {
  others = others ?? {};
  const players = BASE.map((config) => ({ ...config }));
  players[0].character = character;
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
  actor.energy = actorOverrides.energy ?? 3;
  // maxEnergy 由 makeGame 按生产 TeamRuleService 计算（2 人小队=4），
  // 这里不再覆盖，避免与真实规则不一致。
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  if (viewerMemory) actor.aiMemory = { ...actor.aiMemory, ...viewerMemory };
  return { players, options: { actorId: "a", seed } };
}

// ---------------------------------------------------------------
// Tactics & Action Ordering（错误诱饵为主）
// ---------------------------------------------------------------

registerScenario({
  id: "hard.assault-now-vs-combo",
  name: "诱饵：立即突袭 vs 聚能连段",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  adversarial: "immediate-reward",
  setup: () => board("blade-walker", {
    energy: 1,
    hand: [makeCard("assault"), makeCard("assault"), makeCard("charge"), makeCard("exposeWeakness")]
  }, { b: { hp: 3 } }, null, 20001),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能→破军→破势→双突袭，总伤远高于立即突袭");
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.ACCEPTABLE, "破势铺垫可以但缺能量");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "被立即伤害吸引，放弃整套连段");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.save-shockwave",
  name: "诱饵：保存终结牌",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  adversarial: "immediate-reward",
  setup: () => board("ember-magus", {
    energy: 3,
    hand: [makeCard("shockwave"), makeCard("assault")]
  }, { b: { hp: 3 }, c: { hp: 1 }, e: { hp: 1 } }, null, 20002),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.OPTIMAL, "突袭收 1HP，震波留待群体爆发");
    if (isCard(action, "assault") && targetsOnly(action, "e")) return quality(QUALITY.OPTIMAL, "突袭收 1HP，震波留待群体爆发");
    if (isCard(action, "shockwave")) return quality(QUALITY.ACCEPTABLE, "立即震波可接受但浪费终结价值");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.expose-or-allin",
  name: "资源冲突：破军 vs 孤注",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "tactical",
  adversarial: "resource",
  setup: () => board("fate-gambler", {
    energy: 2,
    hand: [makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")]
  }, { b: { hp: 3 } }, null, 20003),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "战术牌触发冒险+破势，双突袭最大化");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "立即突袭浪费冒险与破势");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.burning-order",
  name: "焚场前置 vs 后置",
  category: "combos",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  adversarial: "setup",
  setup: () => board("ember-magus", {
    energy: 3,
    hand: [makeCard("shockwave"), makeCard("assault")]
  }, { b: { hp: 2 }, c: { hp: 2 }, e: { hp: 2 } }, null, 20004),
  grade: ({ action }) => {
    if (isSkill(action, "burningField")) return quality(QUALITY.OPTIMAL, "焚场压低全体，为震波收尾铺路");
    if (isCard(action, "shockwave")) return quality(QUALITY.ACCEPTABLE, "先震波亦可接受但伤害重叠");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "单点突袭节奏最差");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Multi-step Planning（跨回合 / 竞争资源）
// ---------------------------------------------------------------

registerScenario({
  id: "hard.cross-turn-energy",
  name: "跨回合：本回合与下回合的资源分配",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "cross-turn",
  setup: () => board("ember-magus", {
    energy: 2,
    hand: [makeCard("charge"), makeCard("assault")]
  }, { b: { hp: 3 }, c: { hp: 3 }, e: { hp: 3 } }, null, 20010),
  grade: ({ action }) => {
    // 真实规则（maxEnergy=4 + 余烬被动）下：charge→焚场→突袭 与 突袭→聚能→焚场
    // 回合结束时能量均≈1，终态等价；两条线都是合理行动。
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "先突袭并保留资源，同为合理线");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "先聚能立即焚场，终态与保留线等价");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.medic-save-trigger",
  name: "跨回合：保留治疗触发",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  adversarial: "healing",
  setup: () => board("spirit-medic", {
    hp: 2,
    energy: 3,
    hand: [makeCard("recover"), makeCard("shield")]
  }, { d: { hp: 1 }, b: { equipment: makeCard("battleDevice") } }, null, 20011),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾救队友，恢复留待回春触发");
    if (isCard(action, "recover")) return quality(QUALITY.STRONG, "立即恢复亦可接受");
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.POOR, "自身 2HP 不如队友 1HP 危急");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.energy-split-choice",
  name: "跨回合：能量分配二选一",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "cross-turn",
  setup: () => board("oath-warden", {
    energy: 2,
    hand: [makeCard("assault"), makeCard("shield")]
  }, { d: { hp: 1 }, b: { hp: 2 } }, null, 20012),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾保住队友，代价是放弃击杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "击杀 2HP 但队友暴露被杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.chain-seal-kill",
  name: "跨回合：封印→下回合击杀",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "setup",
  setup: () => board("shade-agent", {
    energy: 3,
    hand: [makeCard("seal"), makeCard("assault")]
  }, {
    b: { hp: 2, equipment: makeCard("battleDevice") },
    c: { hp: 4, hand: makeCards(["assault"]) }
  }, null, 20013),
  grade: ({ action }) => {
    if (isCard(action, "seal") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "封印军火库，下回合处理");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "立即突袭可接受");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.POOR, "打无关目标");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.provoke-bait-then-kill",
  name: "跨回合：挑衅诱出响应再收割",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "response-bait",
  setup: () => board("blade-walker", {
    energy: 3,
    hand: [makeCard("provoke"), makeCard("assault"), makeCard("assault")]
  }, {
    b: { hp: 1, hand: makeCards(["assault", "assault"]) },
    c: { hp: 4 }
  }, null, 20014),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.OPTIMAL, "挑衅逼迫目标消耗突袭，再安全收头");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "直接收头可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.response-save-vs-push",
  name: "跨回合：响应保留 vs 资源推进",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  adversarial: "cross-turn",
  setup: () => board("blade-walker", {
    energy: 3,
    hand: [makeCard("charge"), makeCard("assault"), makeCard("block")]
  }, {
    b: { equipment: makeCard("battleDevice"), hp: 3 }
  }, null, 20015),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "突袭推进，格挡留作防御");
    if (isCard(action, "charge")) return quality(QUALITY.STRONG, "聚能推进亦可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "hard.energy-deadline",
  name: "跨回合：能量截止线",
  category: "planning",
  depth: 4,
  difficulty: "advanced",
  discrimination: "planning",
  adversarial: "resource",
  setup: () => board("fate-gambler", {
    energy: 2,
    hand: [makeCard("charge"), makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 3 } }, null, 20016),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能到 3 解锁孤注+突袭");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "立即突袭错过孤注转化");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------- 经探针验证：Greedy 失败、Production 成功 ----------

registerScenario({
  id: "adv.guardian-target-trap",
  name: "对抗：守誓者护援下的目标陷阱",
  category: "combos",
  depth: 3,
  difficulty: "expert",
  discrimination: "tactical",
  adversarial: "target",
  setup: () => board("blade-walker", {
    energy: 2,
    hand: [makeCard("assault"), makeCard("exposeWeakness")]
  }, {
    b: { hp: 2 },
    c: { character: "oath-warden", hp: 4, hand: makeCards(["assault", "assault"]) }
  }, null, 20030),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "护援可减伤，破势保证 2 伤击杀");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "1 伤可能被护援抵消");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "adv.save-energy-next-turn",
  name: "对抗：跨回合保留能量",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "cross-turn",
  setup: () => board("ember-magus", {
    energy: 2,
    hand: [makeCard("charge"), makeCard("assault")]
  }, { b: { hp: 3 }, c: { hp: 3 }, e: { hp: 3 } }, null, 20031),
  grade: ({ action }) => {
    // 真实规则下两条线终态等价（见 hard.cross-turn-energy 注释）。
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "先突袭并保留资源，同为合理线");
    if (isCard(action, "charge")) return quality(QUALITY.ACCEPTABLE, "先聚能立即焚场，终态与保留线等价");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "adv.full-combo-ladder",
  name: "对抗：聚能→破军→破势→突袭",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "setup",
  setup: () => board("blade-walker", {
    energy: 1,
    hand: [makeCard("charge"), makeCard("exposeWeakness"), makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 4 } }, null, 20032),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能→破军→破势→双突袭");
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.ACCEPTABLE, "破势铺垫可以但缺能量");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "直接突袭放弃整套连段");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "adv.tracking-setup-chain",
  name: "对抗：追踪印记为下回合铺垫",
  category: "planning",
  depth: 4,
  difficulty: "expert",
  discrimination: "planning",
  adversarial: "setup",
  setup: () => board("trail-hunter", {
    energy: 2,
    hand: [makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 4 }, c: { hp: 2 } }, null, 20033),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "印记 4HP 目标，下回合猎杀");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.POOR, "击杀 2HP 但浪费印记铺垫");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Hidden Info & Probability（边界）
// ---------------------------------------------------------------

registerScenario({
  id: "hard.block-probability-boundary",
  name: "概率边界：格挡概率下的进攻决策",
  category: "probability",
  depth: 2,
  runs: 3,
  difficulty: "advanced",
  discrimination: "probability",
  adversarial: "resource",
  setup: ({ runIndex }) => {
    // 变体：已知 0/1/2 张格挡（2 张手牌）
    const knownSets = [
      [],
      [{ id: "hb1", definitionId: "block" }],
      [{ id: "hb1", definitionId: "block" }, { id: "hb2", definitionId: "block" }]
    ];
    const hands = [
      [makeCard("assault", "hx1"), makeCard("assault", "hx2")],
      [makeCard("block", "hb1"), makeCard("assault", "hx2")],
      [makeCard("block", "hb1"), makeCard("block", "hb2")]
    ];
    return board("blade-walker", {
      energy: 2,
      hand: [makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")]
    }, {
      b: { hp: 2, hand: hands[runIndex] }
    }, { knownCardsByPlayer: { b: knownSets[runIndex] } }, 20020 + runIndex);
  },
  grade: ({ action, runIndex }) => {
    if (runIndex === 0) {
      if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "0 格挡，双突袭必杀");
      if (isCard(action, "exposeWeakness")) return quality(QUALITY.ACCEPTABLE, "破势铺垫可接受但多余");
      return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
    }
    if (runIndex === 1) {
      if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "1 格挡概率下破势保证后续伤害");
      if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "可能被单格挡挡住一次");
      return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
    }
    if (runIndex === 2) {
      if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "双格挡下只能靠破势突破");
      if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.SEVERE, "明知双格挡仍直突袭");
      return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
    }
    return quality(QUALITY.POOR, "未知 runIndex");
  }
});

registerScenario({
  id: "hard.counter-adaptation",
  name: "反制适应：改变战术时机",
  category: "probability",
  depth: 2,
  difficulty: "advanced",
  discrimination: "probability",
  adversarial: "response-bait",
  setup: () => board("blade-walker", {
    energy: 3,
    hand: [makeCard("shockwave"), makeCard("provoke")]
  }, {
    b: { hp: 2, hand: [makeCard("counter", "kc")] }
  }, { knownCardsByPlayer: { b: [{ id: "kc", definitionId: "counter" }] } }, 20023),
  grade: ({ action }) => {
    if (isCard(action, "provoke")) return quality(QUALITY.POOR, "挑衅被反制，浪费");
    if (isCard(action, "shockwave")) return quality(QUALITY.SEVERE, "震波必被反制");
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "对方持反制，保留资源等待");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// ---------------------------------------------------------------
// Counterfactual Family：护盾目标（队友血量 1/2/3）
// ---------------------------------------------------------------

const shieldAllyBase = (allyHp) => board("oath-warden", {
  energy: 2,
  hand: [makeCard("shield"), makeCard("assault")]
}, { d: { hp: allyHp }, b: { hp: 2 } }, null, 20030);

registerScenario({
  id: "cf.shield-ally-hp1",
  name: "护盾队友Family：1HP 必护",
  category: "counterfactual",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "counterfactual",
  family: "shield-ally",
  expectedClass: "card:shield",
  setup: () => shieldAllyBase(1),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "1HP 队友必护");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "队友濒死仍进攻");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.shield-ally-hp2",
  name: "护盾队友Family：2HP 可攻可守",
  category: "counterfactual",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "counterfactual",
  family: "shield-ally",
  expectedClass: "card:shield",
  setup: () => shieldAllyBase(2),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "2HP 队友护盾合理");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.ACCEPTABLE, "击杀 2HP 目标亦可接受");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cf.shield-ally-hp3",
  name: "护盾队友Family：3HP 优先进攻",
  category: "counterfactual",
  depth: 1,
  difficulty: "intermediate",
  discrimination: "counterfactual",
  family: "shield-ally",
  expectedClass: "card:assault",
  setup: () => shieldAllyBase(3),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "3HP 队友不危急，先击杀 2HP 敌人");
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.ACCEPTABLE, "护盾偏保守");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});
