/**
 * 模块 I：稳定性与适应能力。
 * 相同局面/等价局面/无关变量轻微变化/随机种子变化下，质量是否稳定。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard, makeCards } from "../helpers.mjs";
import {
  isCard, isSkill, isEnd, targetsOnly,
  gradeByAction, playCard, playSkill, endTurn, describeActionShort
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
  actor.hand = actorOverrides.hand ?? [];
  actor.turnFlags = actorOverrides.turnFlags ?? {};
  actor.statuses = actorOverrides.statuses ?? {};
  return { players, options: { actorId: "a", seed: 9000 } };
}

registerScenario({
  id: "stability.seed-consistency",
  name: "相同局面不同种子：决策质量稳定",
  category: "stability",
  depth: 2,
  runs: 4,
  setup: () => board({
    hand: [makeCard("assault"), makeCard("exposeWeakness")]
  }, { b: { hp: 2 } }),
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return { score: 1, reason: "破势→突袭为最优" };
    if (isCard(action, "assault") && targetsOnly(action, "b")) return { score: 0.5, reason: "直接突袭次优" };
    return { score: 0.3, reason: `决策漂移：${describeActionShort(action)}` };
  }
});

registerScenario({
  id: "stability.equivalent-board",
  name: "等价局面：无关细节不影响决策",
  category: "stability",
  depth: 2,
  runs: 3,
  setup: ({ runIndex }) => {
    // 敌方手牌内容对 AI 不可见；交换未知牌身份不应改变决策质量
    const hiddenHands = [
      ["assault", "assault"],
      ["recover", "recover"],
      ["charge", "charge"]
    ];
    return board({
      hand: [makeCard("assault"), makeCard("exposeWeakness")]
    }, {
      b: { hp: 2, hand: makeCards(hiddenHands[runIndex]) },
      c: { hp: 3, hand: makeCards(["assault"]) }
    });
  },
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return { score: 1, reason: "最优动作保持" };
    if (isCard(action, "assault") && targetsOnly(action, "b")) return { score: 0.5, reason: "次优动作" };
    return { score: 0.3, reason: `等价局面下决策漂移：${describeActionShort(action)}` };
  }
});

registerScenario({
  id: "stability.minor-perturbation",
  name: "无关变量扰动：决策质量稳定",
  category: "stability",
  depth: 2,
  runs: 3,
  setup: ({ runIndex }) => {
    // 无关变量：目标能量 0/1/2 不应改变"破势→突袭"结构
    const energies = [0, 1, 2];
    return board({
      hand: [makeCard("assault"), makeCard("exposeWeakness")]
    }, { b: { hp: 2, energy: energies[runIndex] } });
  },
  grade: ({ action }) => {
    if (isCard(action, "exposeWeakness")) return { score: 1, reason: "最优动作保持" };
    if (isCard(action, "assault") && targetsOnly(action, "b")) return { score: 0.5, reason: "次优动作" };
    return { score: 0.3, reason: `扰动下决策漂移：${describeActionShort(action)}` };
  }
});

registerScenario({
  id: "stability.edge-flip",
  name: "临界局面：随机性不引发灾难性漂移",
  category: "stability",
  depth: 2,
  runs: 4,
  setup: () => board({
    hand: [makeCard("assault"), makeCard("assault")]
  }, { b: { hp: 1 } }),
  grade: ({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) return { score: 1, reason: "稳定击杀" };
    if (isEnd(action)) return { score: 0.1, reason: "放弃必杀" };
    return { score: 0.4, reason: `非最优：${describeActionShort(action)}` };
  }
});

registerScenario({
  id: "stability.ambiguous-choice",
  name: "近似等价选择：不出现灾难性漂移",
  category: "stability",
  depth: 3,
  runs: 4,
  setup: () => board({
    hand: [makeCard("charge"), makeCard("assault"), makeCard("exposeWeakness")]
  }, { b: { hp: 3 } }),
  grade: ({ action }) => {
    if (isCard(action, "charge")) return { score: 1, reason: "聚能铺垫为最优线起点" };
    if (isCard(action, "exposeWeakness")) return { score: 0.9, reason: "破势铺垫为近似等价" };
    if (isCard(action, "assault") && targetsOnly(action, "b")) return { score: 0.5, reason: "直接突袭明显次优" };
    if (isEnd(action)) return { score: 0.2, reason: "结束出牌为灾难性漂移" };
    return { score: 0.4, reason: `非最优：${describeActionShort(action)}` };
  }
});

export const scenarioModule = { id: "stability", label: "Stability" };
