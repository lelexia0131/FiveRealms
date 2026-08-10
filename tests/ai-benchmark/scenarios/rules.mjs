/**
 * 模块 A：规则与合法性。
 * 测试 AI 是否尊重能量、次数、目标、阵营、自身/存活限制等生产规则。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isSkill, isEnd, targetsOnly,
  gradeByAction, playCard, playSkill, endTurn, describeActionShort,
  QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

const basicPlayers = [
  { id: "a", team: "dawn", general: "blade-walker" },
  { id: "b", team: "dusk", general: "oath-warden" },
  { id: "c", team: "dusk", general: "fate-gambler" },
  { id: "d", team: "dawn", general: "spirit-medic" },
  { id: "e", team: "dusk", general: "ember-magus" }
];

/** 通用局面：actor 为 a，敌人 b/c/e，队友 d。 */
function baseBoard(actorOverrides = {}, opponentCards = 2, playerOverrides = {}) {
  const players = basicPlayers.map((config) => ({ ...config }));
  for (const player of players) {
    if (player.id === "a") {
      player.energy = 3;
      player.hand = [];
      Object.assign(player, actorOverrides);
    } else {
      if (player.hp == null) player.hp = 4;
      player.energy = 1;
      player.hand = makeCards(Array.from({ length: opponentCards }, () => "assault"));
      Object.assign(player, playerOverrides[player.id] ?? {});
    }
  }
  return { players, options: { actorId: "a", seed: 1001 } };
}

registerScenario({
  id: "rules.insufficient-energy-skill",
  name: "能量不足时不发动技能",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({ energy: 1, hand: [makeCard("assault"), makeCard("assault"), makeCard("charge")] }),
  grade: ({ action }) => {
    if (isSkill(action, "breakArmy")) return quality(QUALITY.CATASTROPHIC, "能量 1 时仍发动需 2 能量的破军");
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "选择合法突袭，未尝试非法技能");
    if (isCard(action, "charge")) return quality(QUALITY.STRONG, "先聚能可接受，但放弃当前突袭机会");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.attack-limit-respected",
  name: "突袭次数上限被尊重",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({
    energy: 2,
    turnFlags: { attackUsed: 1, attackLimit: 1 },
    hand: [makeCard("assault"), makeCard("exposeWeakness")]
  }),
  grade: ({ action }) => {
    if (isCard(action, "assault")) return quality(QUALITY.CATASTROPHIC, "已用尽突袭次数仍选择突袭");
    if (isCard(action, "exposeWeakness")) return quality(QUALITY.OPTIMAL, "次数耗尽时正确选择破势铺垫");
    if (isSkill(action, "breakArmy")) return quality(QUALITY.OPTIMAL, "破军解锁额外突袭，是合法且正确的选择");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.out-of-range-target",
  name: "射程外目标不可被突袭",
  category: "basicRules",
  depth: 1,
  setup: () => {
    // 座次 0~4；b(1) 距 a 为 1（合法），e(4) 距 a 为 1（合法），c(2) 距 a 为 2（非法）。
    const players = basicPlayers.map((config) => ({ ...config }));
    players[0].hand = [makeCard("assault")];
    players[0].energy = 2;
    for (const player of players.slice(1)) {
      player.hp = 4;
      player.energy = 1;
      player.hand = makeCards(["assault"]);
    }
    return { players, options: { actorId: "a", seed: 1002 } };
  },
  grade: ({ action, legalActions }) => {
    const assaultActions = legalActions.filter((entry) => entry.type === "card" && entry.card?.definitionId === "assault");
    const illegalTarget = assaultActions.some((entry) => entry.targets?.some((target) => target.id === "c"));
    if (illegalTarget) return quality(QUALITY.CATASTROPHIC, "生成了射程外目标 c 的突袭动作");
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "仅生成射程内目标");
    if (isCard(action, "assault") && targetsOnly(action, "e")) return quality(QUALITY.OPTIMAL, "仅生成射程内目标");
    if (isEnd(action)) return quality(QUALITY.POOR, "未进攻");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.faction-restriction-shield",
  name: "护盾不可指定敌方",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({
    hand: [makeCard("shield")],
    energy: 1
  }),
  grade: ({ action, legalActions }) => {
    const shieldActions = legalActions.filter((entry) => entry.type === "card" && entry.card?.definitionId === "shield");
    if (shieldActions.some((entry) => entry.targets?.some((target) => target.id === "b" || target.id === "c" || target.id === "e"))) {
      return quality(QUALITY.CATASTROPHIC, "护盾的目标列表中包含敌方");
    }
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.OPTIMAL, "正确只生成友方目标");
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "正确只生成友方目标");
    return quality(QUALITY.ACCEPTABLE, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.no-wasted-recover",
  name: "满血不使用恢复",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({ hand: [makeCard("recover")], energy: 1 }),
  grade: ({ action, legalActions }) => {
    if (legalActions.some((entry) => entry.type === "card" && entry.card?.definitionId === "recover")) {
      return quality(QUALITY.CATASTROPHIC, "满血仍生成恢复动作");
    }
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "满血时正确放弃无效恢复");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.charge-cap",
  name: "能量已满不使用聚能",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({ energy: 4, maxEnergy: 4, hand: [makeCard("charge"), makeCard("assault")] }),
  grade: ({ action, legalActions }) => {
    if (legalActions.some((entry) => entry.type === "card" && entry.card?.definitionId === "charge")) {
      return quality(QUALITY.CATASTROPHIC, "能量已满仍生成聚能动作");
    }
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "跳过无效聚能直接进攻");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.self-not-ally-target",
  name: "单友方目标不可指定敌方",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({
    hand: [makeCard("shield"), makeCard("assault")],
    energy: 2
  }),
  grade: ({ action, legalActions }) => {
    const shieldActions = legalActions.filter((entry) => entry.type === "card" && entry.card?.definitionId === "shield");
    for (const entry of shieldActions) {
      for (const target of entry.targets ?? []) {
        if (target.battleTeam !== "dawn") return quality(QUALITY.CATASTROPHIC, "护盾生成了敌方目标");
      }
    }
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.OPTIMAL, "正确选择自身或队友");
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "正确选择自身或队友");
    if (isCard(action, "assault")) return quality(QUALITY.STRONG, "进攻可接受，但护盾价值被忽略");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.kill-priority",
  name: "低血量目标优先击杀",
  category: "board",
  depth: 1,
  setup: () => baseBoard({
    hand: [makeCard("assault")],
    energy: 1
  }, 1, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "直接击杀 1HP 敌人");
    if (isEnd(action)) return quality(QUALITY.CATASTROPHIC, "有必杀目标却结束出牌");
    return quality(QUALITY.POOR, `未选择击杀目标：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.lightning-state-block",
  name: "已有闪电状态不再使用闪电",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({
    statuses: { lightning: true },
    hand: [makeCard("lightning"), makeCard("assault")],
    energy: 2
  }),
  grade: ({ action, legalActions }) => {
    if (legalActions.some((entry) => entry.type === "card" && entry.card?.definitionId === "lightning")) {
      return quality(QUALITY.CATASTROPHIC, "已有闪电状态仍生成闪电动作");
    }
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "正确跳过重复闪电");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.shield-target-injured",
  name: "护盾优先低血量目标",
  category: "board",
  depth: 1,
  setup: () => baseBoard({
    hand: [makeCard("shield"), makeCard("assault")],
    energy: 2
  }, 1, { d: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "shield") && targetsOnly(action, "d")) return quality(QUALITY.OPTIMAL, "护盾给低血量队友");
    if (isCard(action, "shield") && targetsOnly(action, "a")) return quality(QUALITY.ACCEPTABLE, "满血自身优于低血队友");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "放弃救命护盾选择进攻");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "rules.response-card-not-active",
  name: "响应牌不可主动使用",
  category: "basicRules",
  depth: 1,
  setup: () => baseBoard({
    hand: [makeCard("block"), makeCard("counter"), makeCard("assault")],
    energy: 2
  }),
  grade: ({ action, legalActions }) => {
    const illegal = legalActions.some((entry) => entry.type === "card"
      && (entry.card?.definitionId === "block" || entry.card?.definitionId === "counter"));
    if (illegal) return quality(QUALITY.CATASTROPHIC, "响应牌被生成为主动动作");
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "正确仅主动使用突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

// 导出供目录与统计使用。
export const scenarioModule = { id: "rules", label: "Rules & Legality" };
