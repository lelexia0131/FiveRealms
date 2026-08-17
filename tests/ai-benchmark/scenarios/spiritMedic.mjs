/**
 * 灵医（spirit-medic）专属矩阵：验证【滋荣 / 回春】的治疗规划是否由真实规则、
 * 可见状态、Simulator、Planner、after-state 与统一 stateUtility 表达，而不是靠
 * “低血加分”“总缺血量×常数”“有回春就加分”等 magic heuristic。
 *
 * 命名区分：ACTIVE_SKILLS.symbiosis = 滋荣（主动技能）；CARD_DEFINITIONS.symbiosis = 共生（卡牌）。
 * 评分只依据真实动作链与规则判断，不读取 AI 内部估值函数。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard } from "../helpers.mjs";
import {
  QUALITY, isCard, isEnd, isSkill, quality, targetsOnly, describeActionShort
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id: "a", team: "dawn", character: "spirit-medic" },
  { id: "b", team: "dusk", character: "blade-walker" },
  { id: "c", team: "dusk", character: "fate-gambler" },
  { id: "d", team: "dawn", character: "fate-gambler" },
  { id: "e", team: "dusk", character: "ember-magus" },
  { id: "f", team: "dawn", character: "resonance-tuner" }
];

/** 6 人局：a(0) b(1) c(2) d(3) e(4) f(5)，邻座即攻击范围 1 的合法目标。 */
function board(actorOverrides = {}, others = {}, seed = 62000) {
  const players = BASE.map((config) => ({
    ...config,
    hp: 4,
    energy: 1,
    hand: [],
    shield: 0,
    statuses: {},
    turnFlags: {},
    roundFlags: {}
  }));
  const actor = players[0];
  Object.assign(actor, {
    energy: 2,
    hand: [],
    turnFlags: {},
    statuses: {},
    aiMemory: { knownCardsByPlayer: {} }
  }, actorOverrides);
  for (const player of players.slice(1)) Object.assign(player, others[player.id] ?? {});
  return { players, options: { actorId: "a", seed } };
}

/** 让灵医确定性记住某名敌人手中有突击牌，构造真实可见的高暴露目标。 */
function withKnownAssault(boardResult, enemyId) {
  const actor = boardResult.players.find((player) => player.id === "a");
  actor.aiMemory.knownCardsByPlayer[enemyId] = [
    { id: `known-${enemyId}-assault`, definitionId: "assault" }
  ];
  return boardResult;
}

const sequenceSkillCount = (stats, skillId) => (stats?.bestSequence ?? [])
  .filter((action) => action.type === "skill" && action.cardId === skillId).length;
const sequenceHasCard = (stats, definitionId) => (stats?.bestSequence ?? [])
  .some((action) => action.cardId === definitionId);
const sequenceSkillTargets = (stats, skillId) => (stats?.bestSequence ?? [])
  .filter((action) => action.type === "skill" && action.cardId === skillId)
  .map((action) => action.targetId ?? action.targetIds?.[0] ?? null);

registerScenario({
  id: "medic.danger-1hp-beats-plain-2hp",
  name: "灵医：1HP 危险目标优先于普通 2HP 伤员",
  category: "board",
  depth: 1,
  difficulty: "basic",
  discrimination: "tactical",
  setup: () => board({ hp: 4, energy: 2 }, { d: { hp: 2 }, f: { hp: 1 } }),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "f")) {
      return quality(QUALITY.OPTIMAL, "滋荣 1HP 目标，消除 danger 阈值的真实价值最高");
    }
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) {
      return quality(QUALITY.POOR, "治疗 2HP 普通伤员错过 danger 消除");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗危险目标");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.danger-over-static-exposure",
  name: "灵医：安全 1HP 与暴露 2HP 之间优先消除 danger",
  category: "board",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => withKnownAssault(
    board({ hp: 4, energy: 2 }, {
      d: { hp: 2, energy: 2 },
      e: { hp: 4, hand: [makeCard("assault")], energy: 2 },
      f: { hp: 1 }
    }),
    "e"
  ),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "f")) {
      return quality(QUALITY.OPTIMAL, "1HP 危险目标：治疗消除 danger 阈值，暴露是静态惩罚不会因治疗消失");
    }
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) {
      return quality(QUALITY.POOR, "治疗暴露 2HP 只获得 +1HP，未消除任何 danger");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.exposed-1hp-vs-safe-1hp",
  name: "灵医：同为 1HP 时 danger 阈值主导，暴露不重复计价",
  category: "board",
  depth: 2,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => withKnownAssault(
    board({ hp: 4, energy: 2 }, {
      d: { hp: 1 },
      e: { hp: 4, hand: [makeCard("assault")], energy: 2 },
      f: { hp: 1 }
    }),
    "e"
  ),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) {
      return quality(QUALITY.OPTIMAL, "邻座敌人持突击牌的高暴露 1HP 目标优先");
    }
    if (isSkill(action, "symbiosis") && targetsOnly(action, "f")) {
      return quality(QUALITY.OPTIMAL, "同为 1HP 均处于 danger 阈值：暴露是静态项，不重复叠加威胁计价");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.self-vs-ally-critical",
  name: "灵医：队友 1HP 优先于非危急自身",
  category: "board",
  depth: 1,
  difficulty: "basic",
  discrimination: "tactical",
  setup: () => board({ hp: 2, energy: 2 }, { f: { hp: 1 } }),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "f")) {
      return quality(QUALITY.OPTIMAL, "队友 1HP 危险目标优先，无固定自疗偏好");
    }
    if (isSkill(action, "symbiosis") && targetsOnly(action, "a")) {
      return quality(QUALITY.POOR, "治疗 2HP 自身错过队友的 danger 消除");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.heal-over-assault-critical-ally",
  name: "灵医：队友濒危时治疗优先于突击",
  category: "board",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board(
    { hp: 4, energy: 2, hand: [makeCard("assault")] },
    { d: { hp: 1 }, b: { hp: 3 } }
  ),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) {
      return quality(QUALITY.OPTIMAL, "1HP 队友的 danger 消除价值高于一次突击");
    }
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.POOR, "队友 1HP 仍选择进攻");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.symbiosis-card-heals-both",
  name: "灵医：共生牌先于滋荣群体恢复并触发回春",
  category: "board",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "tactical",
  setup: () => board(
    { hp: 4, energy: 2, hand: [makeCard("symbiosis")] },
    { d: { hp: 1 }, f: { hp: 1 } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "symbiosis")) {
      return quality(QUALITY.OPTIMAL, "共生（卡牌）令两个 1HP 队友各恢复 1 点并触发两次回春");
    }
    if (isSkill(action, "symbiosis")) {
      return quality(QUALITY.STRONG, "先滋荣单个目标也可接受，但错过共生群体收益");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃群体治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.rejuvenation-available-danger-heal",
  name: "灵医：回春可用时危险治疗附带摸牌",
  category: "synergy",
  depth: 1,
  difficulty: "basic",
  discrimination: "synergy",
  setup: () => board(
    { hp: 1, energy: 2, turnFlags: { rejuvenationTriggerCount: 0 } },
    { d: { hp: 4 } }
  ),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "a")) {
      return quality(QUALITY.OPTIMAL, "回春两次机会均可用：自疗消除 danger 并附带摸 1 张");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃自疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.rejuvenation-exhausted-danger-heal",
  name: "灵医：回春耗尽后危险治疗仍不放弃",
  category: "synergy",
  depth: 1,
  difficulty: "intermediate",
  discrimination: "synergy",
  setup: () => board(
    { hp: 1, energy: 2, turnFlags: { rejuvenationTriggerCount: 2 } },
    { d: { hp: 4 } }
  ),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "a")) {
      return quality(QUALITY.OPTIMAL, "回春已耗尽仍治疗危险目标，不虚构不存在的摸牌也不放弃");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃自疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.recover-self-heal-with-rejuvenation",
  name: "灵医：调息自疗消除 danger 并触发回春",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "synergy",
  setup: () => board(
    { hp: 2, energy: 2, hand: [makeCard("recover")] },
    { d: { hp: 4 } }
  ),
  grade: ({ action }) => {
    if (isCard(action, "recover")) {
      return quality(QUALITY.OPTIMAL, "调息自疗消除自身 danger 并触发回春摸牌，不消耗能量");
    }
    if (isSkill(action, "symbiosis") && targetsOnly(action, "a")) {
      return quality(QUALITY.OPTIMAL, "滋荣→调息链同样消除 danger 并完成双治疗，顺序等价");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃自疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.four-energy-two-critical-heals",
  name: "灵医：4 能量连续治疗两个危险目标",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board({ hp: 4, energy: 4 }, { d: { hp: 1 }, f: { hp: 1 } }),
  grade: ({ action, stats }) => {
    const heals = sequenceSkillCount(stats, "symbiosis");
    if (heals >= 2) return quality(QUALITY.OPTIMAL, "两个危险目标均值得治疗，连续滋荣两次");
    if (heals === 1) return quality(QUALITY.POOR, "只治疗一次，留下另一个 1HP 目标");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "4 能量却放弃全部治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.four-energy-exhausted-double-heal",
  name: "灵医：回春耗尽时 4 能量仍连续治疗两个危险目标",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board(
    { hp: 4, energy: 4, turnFlags: { rejuvenationTriggerCount: 2 } },
    { d: { hp: 1 }, f: { hp: 1 } }
  ),
  grade: ({ action, stats }) => {
    const heals = sequenceSkillCount(stats, "symbiosis");
    if (heals >= 2) {
      return quality(QUALITY.OPTIMAL, "回春耗尽不影响两次危险治疗的真实 after-state 价值");
    }
    if (heals === 1) return quality(QUALITY.POOR, "只治疗一次，留下另一个 1HP 目标");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "4 能量却放弃全部治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.symbiosis-preserves-recover",
  name: "灵医：滋荣完成治疗并保留调息救援容量",
  category: "synergy",
  depth: 2,
  difficulty: "intermediate",
  discrimination: "resource",
  setup: () => board(
    { hp: 4, energy: 2, hand: [makeCard("recover")] },
    { d: { hp: 1 } }
  ),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "d")) {
      return quality(QUALITY.OPTIMAL, "用滋荣治疗 1HP 队友，保留调息作为濒死救援容量");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "持有调息却放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.charge-crosses-first-heal-threshold",
  name: "灵医：聚能跨过第一次滋荣能量门槛",
  category: "planning",
  depth: 3,
  difficulty: "intermediate",
  discrimination: "planning",
  setup: () => board(
    { hp: 4, energy: 1, hand: [makeCard("charge")] },
    { d: { hp: 1 }, f: { hp: 4 } }
  ),
  grade: ({ action, stats }) => {
    if (sequenceSkillCount(stats, "symbiosis") >= 1) {
      return quality(QUALITY.OPTIMAL, "聚能 1→2 后滋荣，Planner 发现真实链");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗链");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.charge-crosses-second-heal-threshold",
  name: "灵医：聚能跨过第二次滋荣能量门槛",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board(
    { hp: 4, energy: 3, hand: [makeCard("charge")] },
    { d: { hp: 1 }, f: { hp: 1 } }
  ),
  grade: ({ action, stats }) => {
    const heals = sequenceSkillCount(stats, "symbiosis");
    if (heals >= 2 && sequenceHasCard(stats, "charge")) {
      return quality(QUALITY.OPTIMAL, "聚能 3→4 后连续滋荣两次，Planner 发现 2/4 门槛真实链");
    }
    if (heals === 1) return quality(QUALITY.POOR, "只完成一次治疗，未利用聚能跨越第二次门槛");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗链");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.same-target-double-heal",
  name: "灵医：同一目标连续治疗由 after-state 决定",
  category: "planning",
  depth: 3,
  difficulty: "advanced",
  discrimination: "planning",
  setup: () => board({ hp: 4, energy: 4 }, { d: { hp: 1 }, f: { hp: 4 } }),
  grade: ({ action, stats }) => {
    const targets = sequenceSkillTargets(stats, "symbiosis");
    if (targets.length >= 2 && targets.every((target) => target === "d")) {
      return quality(QUALITY.OPTIMAL, "连续两次滋荣同一目标：每次 +1HP 均有真实 after-state 价值");
    }
    if (targets.length === 1) return quality(QUALITY.ACCEPTABLE, "只治疗一次，保留能量");
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.exposed-2hp-beats-safe-2hp",
  name: "灵医：同 HP 下暴露目标治疗价值高于安全目标",
  category: "board",
  depth: 2,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => {
    const players = [
      {
        id: "a", team: "dawn", character: "spirit-medic", hp: 4, energy: 2, hand: [],
        turnFlags: { rejuvenationTriggerCount: 2 }, aiMemory: { knownCardsByPlayer: {} }, seatIndex: 0
      },
      { id: "x", team: "dawn", character: "fate-gambler", hp: 2, energy: 1, hand: [], seatIndex: 1 },
      { id: "p", team: "dusk", character: "blade-walker", hp: 4, energy: 2, hand: [makeCard("assault")], seatIndex: 2 },
      { id: "m", team: "dawn", character: "oath-warden", hp: 4, energy: 1, hand: [], seatIndex: 3 },
      { id: "q", team: "dusk", character: "ember-magus", hp: 4, energy: 0, hand: [], seatIndex: 4 },
      { id: "y", team: "dawn", character: "resonance-tuner", hp: 2, energy: 1, hand: [], seatIndex: 5 }
    ];
    players[0].aiMemory.knownCardsByPlayer.p = [{ id: "known-p-assault", definitionId: "assault" }];
    return { players, options: { actorId: "a", seed: 62010 } };
  },
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "x")) {
      return quality(QUALITY.OPTIMAL, "暴露 2HP 目标：额外 HP 缓冲在真实威胁下可吸收未来伤害");
    }
    if (isSkill(action, "symbiosis") && targetsOnly(action, "y")) {
      return quality(QUALITY.POOR, "治疗安全 2HP 目标，错过暴露目标的生存缓冲价值");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.plain-2hp-heal-accepted",
  name: "灵医：正收益 2HP 治疗不再被结束惩罚压制",
  category: "synergy",
  depth: 2,
  difficulty: "advanced",
  discrimination: "tactical",
  setup: () => ({
    players: [
      {
        id: "a", team: "dawn", character: "spirit-medic", hp: 2, energy: 2, hand: [],
        turnFlags: { rejuvenationTriggerCount: 0 }, aiMemory: { knownCardsByPlayer: {} }, seatIndex: 0
      },
      { id: "b", team: "dawn", character: "oath-warden", hp: 4, energy: 1, hand: [], seatIndex: 1 },
      { id: "c", team: "dusk", character: "blade-walker", hp: 4, energy: 1, hand: [], seatIndex: 2 },
      { id: "d", team: "dawn", character: "fate-gambler", hp: 4, energy: 1, hand: [], seatIndex: 3 },
      { id: "e", team: "dusk", character: "ember-magus", hp: 4, energy: 1, hand: [], seatIndex: 4 },
      { id: "f", team: "dawn", character: "resonance-tuner", hp: 4, energy: 1, hand: [], seatIndex: 5 }
    ],
    options: { actorId: "a", seed: 62011 }
  }),
  grade: ({ action }) => {
    if (isSkill(action, "symbiosis") && targetsOnly(action, "a")) {
      return quality(QUALITY.OPTIMAL, "2HP 自疗 +1 为正收益且回春摸牌，治疗不应因结束惩罚被反向压制");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "放弃正收益治疗");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.assault-kill-not-end",
  name: "灵医：明显正收益行动存在时不得提前结束",
  category: "board",
  depth: 2,
  difficulty: "basic",
  discrimination: "tactical",
  setup: () => ({
    players: [
      {
        id: "a", team: "dawn", character: "spirit-medic", hp: 4, energy: 2,
        hand: [makeCard("assault")], turnFlags: { rejuvenationTriggerCount: 0 },
        aiMemory: { knownCardsByPlayer: {} }, seatIndex: 0
      },
      { id: "b", team: "dusk", character: "oath-warden", hp: 1, energy: 1, hand: [], seatIndex: 1 },
      { id: "c", team: "dusk", character: "fate-gambler", hp: 4, energy: 1, hand: [], seatIndex: 2 },
      { id: "d", team: "dawn", character: "fate-gambler", hp: 4, energy: 1, hand: [], seatIndex: 3 },
      { id: "e", team: "dusk", character: "ember-magus", hp: 4, energy: 1, hand: [], seatIndex: 4 },
      { id: "f", team: "dawn", character: "resonance-tuner", hp: 4, energy: 1, hand: [], seatIndex: 5 }
    ],
    options: { actorId: "a", seed: 62012 }
  }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.OPTIMAL, "击杀 1HP 敌人是明显正收益，不得因结束语义修复而提前结束");
    }
    if (isEnd(action)) return quality(QUALITY.SEVERE, "无故提前结束");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id: "medic.response-only-hand-end",
  name: "灵医：仅剩响应牌时结束不产生实质经济损失",
  category: "basicSkills",
  depth: 1,
  difficulty: "basic",
  discrimination: "legality",
  setup: () => ({
    players: [
      {
        id: "a", team: "dawn", character: "spirit-medic", hp: 4, energy: 2,
        hand: [makeCard("block")], turnFlags: { rejuvenationTriggerCount: 0 },
        aiMemory: { knownCardsByPlayer: {} }, seatIndex: 0
      },
      { id: "b", team: "dawn", character: "oath-warden", hp: 4, energy: 1, hand: [], seatIndex: 1 },
      { id: "c", team: "dusk", character: "blade-walker", hp: 4, energy: 1, hand: [], seatIndex: 2 },
      { id: "d", team: "dawn", character: "fate-gambler", hp: 4, energy: 1, hand: [], seatIndex: 3 },
      { id: "e", team: "dusk", character: "ember-magus", hp: 4, energy: 1, hand: [], seatIndex: 4 },
      { id: "f", team: "dawn", character: "resonance-tuner", hp: 4, energy: 1, hand: [], seatIndex: 5 }
    ],
    options: { actorId: "a", seed: 62013 }
  }),
  grade: ({ action, legalActions }) => {
    if (legalActions.every((entry) => entry.type === "end")) {
      return quality(QUALITY.OPTIMAL, "响应牌出牌阶段不可兑现，正确结束且不因 handCount>0 计实质损失");
    }
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "正确结束");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

export const scenarioModule = { id: "spiritMedic", label: "Spirit Medic Healing Planning" };
