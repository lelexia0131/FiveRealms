/**
 * 模块 B：卡牌理解。
 * 测试边际收益、保留价值、目标选择、溢出与不同角色下的差异价值。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isEnd, targetsOnly,
  gradeByAction, playCard, endTurn, describeActionShort,
  QUALITY, quality
} from "../evaluators/scenarioDsl.mjs";

function basePlayers() {
  return [
    { id: "a", team: "dawn", general: "blade-walker" },
    { id: "b", team: "dusk", general: "oath-warden" },
    { id: "c", team: "dusk", general: "fate-gambler" },
    { id: "d", team: "dawn", general: "spirit-medic" },
    { id: "e", team: "dusk", general: "ember-magus" }
  ];
}

function fillOthers(players, cards = 2) {
  for (const player of players) {
    if (player.id === "a") continue;
    player.hp ??= 4;
    player.energy ??= 1;
    player.hand = makeCards(Array.from({ length: cards }, () => "assault"));
  }
  return players;
}

registerScenario({
  id: "cards.assault-marginal-kill",
  name: "必杀突袭的边际价值",
  category: "basicCards",
  depth: 1,
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 1;
    actor.hand = [makeCard("assault")];
    players[1].hp = 1;
    return { players, options: { actorId: "a", seed: 2001 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "1 点伤害直接击杀");
    if (isCard(action, "assault") && !targetsOnly(action, "b")) return quality(QUALITY.POOR, "存在更优击杀目标却未选");
    if (isEnd(action)) return quality(QUALITY.CATASTROPHIC, "放弃必杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.save-charge-for-skill",
  name: "聚能保留以解锁技能",
  category: "resources",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "resource",
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 1;
    actor.hand = [makeCard("charge"), makeCard("assault"), makeCard("assault")];
    players[1].hp = 3;
    return { players, options: { actorId: "a", seed: 2002 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "聚能后解锁破军获得额外突袭");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "立即突袭放弃了破军连段");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.shockwave-spillover",
  name: "群体伤害的溢出价值",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 2;
    actor.hand = [makeCard("shockwave"), makeCard("assault")];
    players[1].hp = 2;
    players[2].hp = 1;
    players[4].hp = 1;
    return { players, options: { actorId: "a", seed: 2003 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "shockwave")) return quality(QUALITY.OPTIMAL, "震波同时命中两个 1HP 敌人");
    if (isCard(action, "assault") && targetsOnly(action, "c")) return quality(QUALITY.POOR, "只击杀单目标，浪费群伤");
    if (isCard(action, "assault") && targetsOnly(action, "e")) return quality(QUALITY.POOR, "只击杀单目标，浪费群伤");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.plunder-equipment",
  name: "掠夺关键装备",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 2;
    actor.hand = [makeCard("plunder"), makeCard("assault")];
    players[1].equipment = makeCard("battleDevice");
    players[1].hp = 4;
    return { players, options: { actorId: "a", seed: 2004 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "plunder") && targetsOnly(action, "b")) return quality(QUALITY.OPTIMAL, "掠夺军火库削弱敌方输出");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "忽略敌方强力装备");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.destroy-key-equipment",
  name: "破坏关键装备",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 2;
    actor.hand = [makeCard("destroy"), makeCard("assault")];
    players[1].equipment = makeCard("energyDevice");
    players[2].equipment = makeCard("barrierDevice");
    return { players, options: { actorId: "a", seed: 2005 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "destroy")) return quality(QUALITY.OPTIMAL, "破坏敌方装备");
    if (isCard(action, "assault")) return quality(QUALITY.POOR, "忽略敌方装备优势");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.target-selection-injured",
  name: "治疗目标选择",
  category: "basicCards",
  depth: 1,
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.general = "spirit-medic";
    actor.hp = 2;
    actor.energy = 1;
    actor.hand = [makeCard("recover")];
    players[3].hp = 3;
    return { players, options: { actorId: "a", seed: 2006 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "recover")) return quality(QUALITY.OPTIMAL, "治疗最需要回复的自身");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "有治疗需求却放弃");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.duel-assault-count",
  name: "决斗的突袭持有价值",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 2;
    actor.hand = [makeCard("duel"), makeCard("assault")];
    players[1].hand = makeCards(["assault", "assault", "assault"]);
    players[1].hp = 4;
    return { players, options: { actorId: "a", seed: 2007 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "duel") && targetsOnly(action, "b")) return quality(QUALITY.POOR, "敌方 3 张突袭，决斗大概率自伤");
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "避开劣势决斗，直接稳定突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.role-delta-blade-assault",
  name: "刃行者对突袭的高价值",
  category: "basicCards",
  depth: 2,
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 2;
    actor.hand = [makeCard("charge"), makeCard("assault"), makeCard("assault"), makeCard("recover")];
    players[1].hp = 3;
    return { players, options: { actorId: "a", seed: 2008 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "charge")) return quality(QUALITY.OPTIMAL, "刃行者先聚能准备突袭连段");
    if (isCard(action, "assault")) return quality(QUALITY.ACCEPTABLE, "突袭合理但错过聚能铺垫");
    if (isCard(action, "recover")) return quality(QUALITY.SEVERE, "满血时治疗毫无价值");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "cards.response-retention",
  name: "响应牌保留价值",
  category: "basicCards",
  depth: 2,
  setup: () => {
    const players = fillOthers(basePlayers(), 1);
    const actor = players[0];
    actor.hp = 4;
    actor.energy = 1;
    actor.hand = [makeCard("block"), makeCard("assault")];
    return { players, options: { actorId: "a", seed: 2009 } };
  },
  grade: ({ action }) => {
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "主动阶段使用突袭，格挡保留为响应");
    if (isEnd(action)) return quality(QUALITY.POOR, "保留格挡却放弃进攻机会");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "cards", label: "Card Understanding" };
