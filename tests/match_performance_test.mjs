import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventDispatcher } from "../js/application/messaging/EventDispatcher.js";
import { createSkillEffectRuntime } from "../js/application/action/SkillEffectRuntime.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../js/domain/definitions/skills/SkillDefinitions.js";
import {
  calculatePerformance,
  getPerformanceThresholds,
  getRoundMultiplier,
  normalizeForRadar
} from "../js/ui/results/MatchPerformanceCalculator.js";
import { MatchPerformanceTracker } from "../js/ui/results/MatchPerformanceTracker.js";
import { createMatchPerformanceSidecar } from "../js/ui/results/MatchPerformanceSidecar.js";
import { createMatchResultViewModel } from "../js/ui/results/MatchResultViewModel.js";
import { MatchMvpResultView } from "../js/ui/results/MatchMvpResultView.js";
import { UIManager } from "../js/ui/UIManager.js";
import {
  calculateRadarPoints,
  createRadarChartMarkup,
  MATCH_PERFORMANCE_RADAR_AXIS_ORDER
} from "../js/ui/results/MatchMvpRadarChart.js";

const TOTAL_DEFAULTS = Object.freeze({
  enemyHpDamage: 0,
  enemyKills: 0,
  allyHealing: 0,
  allyRescueHealing: 0,
  allyMitigation: 0,
  allyShieldAbsorbed: 0,
  hpDamageTaken: 0,
  cardsPlayed: 0,
  skillEnergySpent: 0,
  enemyControls: 0
});

const CONTRIBUTION_DEFAULTS = Object.freeze({
  allyCardsGranted: 0,
  enemyCardsPlundered: 0,
  enemyCardsDestroyed: 0,
  enemyCardsTransferred: 0,
  allyResourceActionsProtected: 0,
  enemyCardsGranted: 0,
  sealContribution: 0
});

/*
功能
创建纯评分测试需要的完整 raw player row。

调用方
MVP calculator、ranking 与 victory multiplier tests。

输入
可覆盖身份、回合、队伍人数、totals、contributionFacts、胜负、残局与存活状态的 options。

输出
完整 raw player row。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
未指定累计项全部为零，避免测试依赖 production 默认补值。
*/
function rawPlayer(options = {}) {
  const playerId = options.playerId ?? "player";
  return {
    playerId,
    playerName: options.playerName ?? playerId,
    characterId: options.characterId ?? playerId,
    characterName: options.characterName ?? playerId,
    teamId: options.teamId ?? "dawn",
    seatIndex: options.seatIndex ?? 0,
    initialTeamSize: options.initialTeamSize ?? 2,
    effectiveRounds: options.effectiveRounds ?? 1,
    totals: { ...TOTAL_DEFAULTS, ...(options.totals ?? {}) },
    contributionFacts: { ...CONTRIBUTION_DEFAULTS, ...(options.contributionFacts ?? {}) },
    won: options.won ?? false,
    clutchEnemyCount: options.clutchEnemyCount ?? null,
    aliveAtEnd: options.aliveAtEnd ?? false
  };
}

/*
功能
创建 tracker 事件测试使用的最小权威玩家实体。

调用方
trackerFixture 与各事件归属测试。

输入
player id、seatIndex 与 battleTeam。

输出
含角色身份、存活状态和主动技能使用槽的玩家对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只提供 tracker 读取的公开字段，不模拟游戏规则。
*/
function trackerPlayer(id, seatIndex, battleTeam) {
  return {
    id,
    name: id,
    character: { name: id },
    seatIndex,
    battleTeam,
    alive: true,
    shield: 0,
    hand: [],
    turnFlags: { activeSkillUseCounts: {} }
  };
}

/*
功能
创建带真实 EventDispatcher 的 MatchPerformanceTracker 测试夹具。

调用方
Activity、Skill、Control、Contribution、clutch、reset 与 duplication tests。

输入
权威玩家数组。

输出
{ state, dispatcher, tracker }。

读取状态
无。

写入状态
创建隔离测试状态和 listener registry。

调用函数
EventDispatcher、MatchPerformanceTracker.start/initializeRoster。

边界与不变量
每个夹具使用独立 dispatcher；不创建 MatchApplication 或 AI simulation。
*/
function trackerFixture(players) {
  const state = {
    gameId: "mvp-match",
    stateVersion: 0,
    players,
    phase: "play",
    currentPlayerIndex: 0
  };
  const dispatcher = new EventDispatcher(() => true);
  const tracker = new MatchPerformanceTracker({
    eventDispatcher: dispatcher,
    getState: () => state
  }).start();
  tracker.initializeRoster();
  return { state, dispatcher, tracker };
}

/*
功能
创建可执行真实 SkillEffectRuntime 支付点的 MVP tracker 测试夹具。

调用方
MVP 技能能量支付回归测试。

输入
主动技能发动前的 source 能量。

输出
{ actor, ally, enemy, state, dispatcher, tracker, skillRuntime }。

读取状态
无。

写入状态
创建隔离 MatchState、EventDispatcher、Tracker 与 SkillEffectRuntime。

调用函数
trackerPlayer、trackerFixture、createSkillEffectRuntime。

边界与不变量
只执行真实 Application payment runtime；所有非支付 collaborator 都是无副作用测试替身。
*/
function skillPaymentFixture(energy) {
  const actor = trackerPlayer("skill-actor", 0, "dawn");
  const ally = trackerPlayer("skill-ally", 1, "dawn");
  const enemy = trackerPlayer("skill-enemy", 2, "dusk");
  actor.energy = energy;
  actor.maxEnergy = 4;
  actor.statuses = {};
  ally.energy = 0;
  ally.maxEnergy = 4;
  ally.statuses = {};
  const fixture = trackerFixture([actor, ally, enemy]);
  const skillRuntime = createSkillEffectRuntime({
    getState: () => fixture.state,
    isSessionValid: () => true,
    presentation: { log() {}, showShieldFeedback() {} },
    heal: async () => 0,
    damage: async () => 0,
    drawCards: async () => 0,
    moveEquipmentToHand: async () => null,
    moveCardBetweenHands: async () => null,
    cardLabelForHuman: () => "测试牌",
    getEnemies: () => [enemy],
    random: () => 1,
    emitEvent: (type, payload) => fixture.dispatcher.emit(type, payload)
  });
  const executeSkill = async (skill, targets, energyCost) => {
    const { actualEnergyPaid: actualAmount } = await skillRuntime.execute(
      skill, actor, targets, { energyCost }
    );
    if (actualAmount > 0) {
      await fixture.dispatcher.publishFact("skillEnergyPaid", { source: actor, skill, actualAmount });
    }
    return actualAmount;
  };
  return { actor, ally, enemy, ...fixture, skillRuntime, executeSkill };
}

/*
功能
向现有测试 runner 注册 MVP 结算系统的定点回归测试。

调用方
tests/run.mjs 的 UI 与模板区域。

输入
runner 的 test(name, fn) 注册函数。

输出
无返回值。

读取状态
无。

写入状态
向 runner tests registry 添加 MVP tests。

调用函数
纯 calculator/view-model/radar 与 tracker fixtures。

边界与不变量
只做正确性回归，不运行 Balance、自博弈或数值调优。
*/
export function registerMatchPerformanceTests(test) {
  test("UI·MVP：二人队六维标准按行动至火力顺序使用新上限", () => {
    const thresholds = getPerformanceThresholds(2);
    const result = calculatePerformance(rawPlayer({
      effectiveRounds: 10,
      totals: { skillEnergySpent: 13 },
      contributionFacts: { allyCardsGranted: 7 }
    }));
    assert.deepEqual(
      MATCH_PERFORMANCE_RADAR_AXIS_ORDER.map((key) => thresholds[key]),
      [3.2, 0.6, 1.0, 1.2, 1.3, 2.0]
    );
    assert.deepEqual([result.scores.contribution, result.scores.skill], [70, 100]);
  });

  test("UI·MVP：三人队六维标准按行动至火力顺序使用新上限", () => {
    const thresholds = getPerformanceThresholds(3);
    const result = calculatePerformance(rawPlayer({
      initialTeamSize: 3,
      effectiveRounds: 10,
      totals: { skillEnergySpent: 12 },
      contributionFacts: { allyCardsGranted: 5 }
    }));
    assert.deepEqual(
      MATCH_PERFORMANCE_RADAR_AXIS_ORDER.map((key) => thresholds[key]),
      [2.6, 0.5, 0.8, 1.0, 1.2, 1.2]
    );
    assert.deepEqual([result.scores.contribution, result.scores.skill], [62.5, 100]);
  });

  test("UI·MVP：二人队火力按实际敌伤与真实击杀得到87.5分", async () => {
    const result = calculatePerformance(rawPlayer({
      effectiveRounds: 4,
      totals: { enemyHpDamage: 4, enemyKills: 1 }
    }));
    assert.equal(result.raw.firepower, 1.75);
    assert.equal(result.scores.firepower, 87.5);
    const actor = trackerPlayer("actor", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, ally, enemy]);
    await dispatcher.emit("afterDamage", { source: actor, target: enemy, actualAmount: 4 });
    await dispatcher.emit("playerDead", { source: actor, target: enemy });
    await dispatcher.emit("playerDead", { source: actor, target: ally });
    await dispatcher.emit("playerDead", { source: null, target: enemy });
    const totals = tracker.finalizeMatch().players[0].totals;
    assert.deepEqual([totals.enemyHpDamage, totals.enemyKills], [4, 1]);
  });

  test("UI·MVP：三人队对同一火力使用独立标准得到145.833分", () => {
    const result = calculatePerformance(rawPlayer({
      initialTeamSize: 3,
      effectiveRounds: 4,
      totals: { enemyHpDamage: 4, enemyKills: 1 }
    }));
    assert.equal(result.raw.firepower, 1.75);
    assert.equal(result.scores.firepower, 145.83333333333334);
  });

  test("UI·MVP：濒死救援按二倍计入一次且支援原始值为1.4", () => {
    const result = calculatePerformance(rawPlayer({
      effectiveRounds: 5,
      totals: {
        allyHealing: 1,
        allyRescueHealing: 1,
        allyMitigation: 2,
        allyShieldAbsorbed: 3
      }
    }));
    assert.equal(result.raw.support, 1.6);
  });

  test("UI·MVP：真实战斗事实透传总伤支援与承伤且不改变排名雷达", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const enemyAlly = trackerPlayer("enemy-ally", 3, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, ally, enemy, enemyAlly]);
    await dispatcher.emit("afterDamage", {
      source: actor, target: enemy, actualAmount: 18, shieldAbsorbed: 0, metadata: {}
    });
    await dispatcher.emit("afterHeal", {
      source: actor, target: ally, actualAmount: 1, isDyingRescue: false
    });
    await dispatcher.emit("afterHeal", {
      source: actor, target: ally, actualAmount: 1, isDyingRescue: true
    });
    ally.shield = 1;
    await dispatcher.emit("shieldGranted", {
      source: actor, target: ally, actualAddedAmount: 1, effectDefinitionId: "test-shield"
    });
    ally.shield = 0;
    await dispatcher.emit("afterDamage", {
      source: enemy,
      target: ally,
      actualAmount: 4,
      shieldAbsorbed: 1,
      metadata: {
        mitigationContributions: [
          { contributorPlayerId: actor.id, effectDefinitionId: "test-mitigation", amount: 2 }
        ]
      }
    });
    await dispatcher.emit("afterDamage", {
      source: enemy, target: actor, actualAmount: 6, shieldAbsorbed: 4, metadata: {}
    });
    await dispatcher.emit("afterDamage", {
      source: enemy, target: actor, actualAmount: 0, shieldAbsorbed: 3, metadata: {}
    });
    await dispatcher.emit("afterHpLoss", { player: actor, actualAmount: 2 });
    await dispatcher.emit("afterHeal", {
      source: enemy, target: actor, actualAmount: 4, isDyingRescue: false
    });

    const snapshot = tracker.finalizeMatch();
    const viewModel = createMatchResultViewModel(snapshot);
    const result = viewModel.players.find((player) => player.playerId === actor.id);
    const scoreControl = calculatePerformance(rawPlayer({
      totals: {
        enemyHpDamage: 18,
        allyHealing: 1,
        allyRescueHealing: 1,
        allyMitigation: 2,
        allyShieldAbsorbed: 1
      }
    }));
    assert.deepEqual(result.combatStats, { totalDamage: 18, support: 5, damageTaken: 8 });
    assert.equal(snapshot.players[0].totals.hpDamageTaken, 8);
    assert.equal(result.rank, 1);
    assert.deepEqual(result.raw, scoreControl.raw);
    assert.deepEqual(result.ratios, scoreControl.ratios);
  });

  test("UI·MVP：实际减伤只归属保护队友的贡献者", async () => {
    const protector = trackerPlayer("protector", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([protector, ally, enemy]);
    await dispatcher.emit("afterDamage", {
      source: enemy,
      target: ally,
      actualAmount: 0,
      shieldAbsorbed: 0,
      metadata: {
        mitigationContributions: [
          { contributorPlayerId: protector.id, effectDefinitionId: "guardianAid", amount: 1 },
          { contributorPlayerId: ally.id, effectDefinitionId: "selfReduction", amount: 1 },
          { contributorPlayerId: enemy.id, effectDefinitionId: "enemyReduction", amount: 1 },
          { contributorPlayerId: protector.id, effectDefinitionId: "noActualReduction", amount: 0 }
        ]
      }
    });
    const snapshot = tracker.finalizeMatch();
    assert.equal(snapshot.players.find((entry) => entry.playerId === protector.id).totals.allyMitigation, 1);
    assert.equal(snapshot.players.find((entry) => entry.playerId === ally.id).totals.allyMitigation, 0);
    assert.equal(snapshot.players.find((entry) => entry.playerId === enemy.id).totals.allyMitigation, 0);
  });

  test("UI·MVP：混合护盾来源按获得顺序消费且只归属实际吸收的友军盾", async () => {
    const providerA = trackerPlayer("provider-a", 0, "dawn");
    const receiver = trackerPlayer("receiver", 1, "dawn");
    const providerC = trackerPlayer("provider-c", 2, "dawn");
    const enemy = trackerPlayer("enemy", 3, "dusk");
    const { dispatcher, tracker } = trackerFixture([providerA, receiver, providerC, enemy]);
    for (const source of [receiver, providerA, providerC]) {
      receiver.shield += 1;
      await dispatcher.emit("shieldGranted", {
        source,
        target: receiver,
        actualAddedAmount: 1,
        effectDefinitionId: "shield"
      });
    }
    assert.equal(receiver.shield, 3);
    assert.equal(providerA.shield, 0);
    assert.equal(providerC.shield, 0);

    receiver.shield = 1;
    await dispatcher.emit("afterDamage", {
      source: enemy, target: receiver, actualAmount: 0, shieldAbsorbed: 2, metadata: {}
    });
    assert.deepEqual(
      tracker.shieldSourceLedgers.get(receiver.id),
      [{ providerPlayerId: providerC.id, effectDefinitionId: "shield", remainingAmount: 1 }]
    );
    receiver.shield = 0;
    await dispatcher.emit("afterDamage", {
      source: enemy, target: receiver, actualAmount: 0, shieldAbsorbed: 1, metadata: {}
    });
    const snapshot = tracker.finalizeMatch();
    assert.equal(snapshot.players.find((entry) => entry.playerId === providerA.id).totals.allyShieldAbsorbed, 1);
    assert.equal(snapshot.players.find((entry) => entry.playerId === providerC.id).totals.allyShieldAbsorbed, 1);
    assert.equal(snapshot.players.find((entry) => entry.playerId === receiver.id).totals.allyShieldAbsorbed, 0);
  });

  test("UI·MVP：连续同来源护盾合并 ledger 且支援归属不变", async () => {
    const provider = trackerPlayer("merged-provider", 0, "dawn");
    const receiver = trackerPlayer("merged-receiver", 1, "dawn");
    const enemy = trackerPlayer("merged-enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([provider, receiver, enemy]);
    for (let index = 0; index < 100; index += 1) {
      receiver.shield += 1;
      await dispatcher.emit("shieldGranted", {
        source:provider,
        target:receiver,
        actualAddedAmount:1,
        effectDefinitionId:"shield"
      });
    }
    assert.deepEqual(tracker.shieldSourceLedgers.get(receiver.id), [{
      providerPlayerId:provider.id,
      effectDefinitionId:"shield",
      remainingAmount:100
    }]);
    receiver.shield = 40;
    await dispatcher.emit("afterDamage", {
      source:enemy,
      target:receiver,
      actualAmount:0,
      shieldAbsorbed:60,
      metadata:{}
    });
    assert.equal(
      tracker.finalizeMatch().players.find((entry) => entry.playerId === provider.id)
        .totals.allyShieldAbsorbed,
      60
    );
  });

  test("UI·MVP：护盾来源只记录真实新增量而不记录请求量", async () => {
    const provider = trackerPlayer("provider", 0, "dawn");
    const receiver = trackerPlayer("receiver", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([provider, receiver, enemy]);
    receiver.shield = 1;
    await dispatcher.emit("shieldGranted", {
      source: provider,
      target: receiver,
      requestedAmount: 2,
      actualAddedAmount: 1,
      effectDefinitionId: "shield"
    });
    receiver.shield = 0;
    await dispatcher.emit("afterDamage", {
      source: enemy, target: receiver, actualAmount: 0, shieldAbsorbed: 1, metadata: {}
    });
    assert.equal(tracker.finalizeMatch().players[0].totals.allyShieldAbsorbed, 1);
  });

  test("UI·MVP：护盾无承伤清除只同步来源账且不给提供者支援", async () => {
    const provider = trackerPlayer("provider", 0, "dawn");
    const receiver = trackerPlayer("receiver", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([provider, receiver, enemy]);
    receiver.shield = 1;
    await dispatcher.emit("shieldGranted", {
      source: provider,
      target: receiver,
      actualAddedAmount: 1,
      effectDefinitionId: "shield"
    });
    receiver.shield = 0;
    tracker.reconcileShieldLedger(receiver, receiver.shield);
    assert.deepEqual(tracker.shieldSourceLedgers.get(receiver.id), []);
    assert.equal(tracker.finalizeMatch().players[0].totals.allyShieldAbsorbed, 0);
  });

  test("UI·MVP：自疗与自己的护盾吸收不进入支援", () => {
    const self = trackerPlayer("self", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { tracker } = trackerFixture([self, enemy]);
    tracker.handleAfterHeal({ source: self, target: self, actualAmount: 2, isDyingRescue: false });
    tracker.handleAfterDamage({ source: self, target: self, actualAmount: 0, shieldAbsorbed: 2 });
    const totals = tracker.finalizeMatch().players[0].totals;
    assert.deepEqual(
      [totals.allyHealing, totals.allyRescueHealing, totals.allyShieldAbsorbed],
      [0, 0, 0]
    );
  });

  test("UI·MVP：当前行动者主动打出三张手牌累计三次行动", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    for (const definitionId of ["assault", "charge", "destroy"]) {
      await dispatcher.emit("cardUsed", {
        source: actor,
        card: { definitionId },
        resolved: true,
        effectiveTargets: [enemy]
      });
    }
    assert.equal(tracker.finalizeMatch().players[0].totals.cardsPlayed, 3);
  });

  test("UI·MVP：两次主动出牌外的格挡反制救援与借势响应不计行动", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    for (const definitionId of ["assault", "shield"]) {
      await dispatcher.emit("cardUsed", {
        source: actor,
        card: { definitionId },
        resolved: true,
        effectiveTargets: [enemy]
      });
    }
    await dispatcher.emit("afterCardMove", {
      from: "hand",
      to: "discard",
      player: actor,
      card: { definitionId: "block" },
      atomicGroupSize: 1
    });
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "counter" },
      usageContext: "response",
      resolved: true,
      effectiveTargets: [enemy]
    });
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "recover" },
      usageContext: "dyingRescue",
      resolved: true,
      effectiveTargets: [actor]
    });
    await dispatcher.emit("cardUsed", {
      source: enemy,
      card: { definitionId: "assault" },
      resolved: true,
      effectiveTargets: [actor]
    });
    const snapshot = tracker.finalizeMatch();
    assert.equal(snapshot.players[0].totals.cardsPlayed, 2);
    assert.equal(snapshot.players[1].totals.cardsPlayed, 0);
  });

  test("UI·MVP：当前行动者主动牌最终被反制仍累计一次行动", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "destroy" },
      targets: [enemy],
      effectiveTargets: [],
      resolved: false
    });
    assert.equal(tracker.finalizeMatch().players[0].totals.cardsPlayed, 1);
  });

  test("UI·MVP：1能量主动技能按实际支付累计1", async () => {
    const { actor, tracker, executeSkill } = skillPaymentFixture(1);
    await executeSkill(ACTIVE_SKILL_DEFINITIONS.allIn, [], 1);
    assert.equal(actor.energy, 0);
    assert.equal(tracker.finalizeMatch().players[0].totals.skillEnergySpent, 1);
  });

  test("UI·MVP：2能量主动技能按实际支付累计2", async () => {
    const { actor, ally, tracker, executeSkill } = skillPaymentFixture(2);
    await executeSkill(ACTIVE_SKILL_DEFINITIONS.barrier, [ally], 2);
    assert.equal(actor.energy, 0);
    assert.equal(tracker.finalizeMatch().players[0].totals.skillEnergySpent, 2);
  });

  test("UI·MVP：主动技能减费后只累计实际支付的1能量", async () => {
    const { actor, ally, tracker, executeSkill } = skillPaymentFixture(2);
    await executeSkill(ACTIVE_SKILL_DEFINITIONS.barrier, [ally], 1);
    assert.equal(actor.energy, 1);
    assert.equal(tracker.finalizeMatch().players[0].totals.skillEnergySpent, 1);
  });

  test("UI·MVP：免费主动技能不增加技能能量统计", async () => {
    const { actor, ally, tracker, executeSkill } = skillPaymentFixture(2);
    await executeSkill(ACTIVE_SKILL_DEFINITIONS.barrier, [ally], 0);
    assert.equal(actor.energy, 2);
    assert.equal(tracker.finalizeMatch().players[0].totals.skillEnergySpent, 0);
  });

  test("UI·MVP：被动技能结算不增加技能能量统计", async () => {
    const { actor, ally, enemy, dispatcher, tracker } = skillPaymentFixture(2);
    await dispatcher.emit("afterDamage", {
      source: enemy,
      target: ally,
      actualAmount: 1,
      metadata: {
        mitigationContributions: [{
          contributorPlayerId: actor.id,
          effectDefinitionId: "guardianAid",
          amount: 1
        }]
      }
    });
    assert.equal(tracker.finalizeMatch().players[0].totals.skillEnergySpent, 0);
  });

  test("UI·MVP：控制只计敌方目标且转移友方分流到贡献", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, ally, enemy]);
    const use = (definitionId, effectiveTargets) => dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId },
      resolved: true,
      effectiveTargets
    });
    await use("scout", [enemy]);
    await use("scout", [ally]);
    await use("transfer", [enemy, ally]);
    await use("transfer", [actor, ally]);
    await use("seal", [enemy]);
    const actorResult = tracker.finalizeMatch().players[0];
    assert.equal(actorResult.totals.enemyControls, 2);
    assert.equal(actorResult.contributionFacts.sealContribution, 0);
    assert.equal(actorResult.contributionFacts.allyCardsGranted, 2);
    assert.equal(actorResult.contributionFacts.enemyCardsTransferred, 1);
  });

  test("UI·MVP：多层反制按当前被反制 action owner 分别归属控制", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "counter" },
      usageContext: "response",
      resolved: true,
      effectiveTargets: [enemy]
    });
    await dispatcher.emit("cardUsed", {
      source: enemy,
      card: { definitionId: "counter" },
      usageContext: "response",
      resolved: true,
      effectiveTargets: [actor]
    });
    const snapshot = tracker.finalizeMatch();
    assert.equal(snapshot.players.find((entry) => entry.playerId === actor.id).totals.enemyControls, 1);
    assert.equal(snapshot.players.find((entry) => entry.playerId === enemy.id).totals.enemyControls, 1);
  });

  test("UI·MVP：成功掠夺敌方一张牌只增加一次资源贡献", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    await dispatcher.emit("afterCardMove", {
      from: "hand", to: "hand", fromPlayer: enemy, player: actor, reason: "掠夺"
    });
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "plunder" },
      targets: [enemy],
      effectiveTargets: [enemy],
      resolved: true
    });
    const facts = tracker.finalizeMatch().players[0].contributionFacts;
    assert.equal(facts.enemyCardsPlundered, 1);
  });

  test("UI·MVP：成功破坏敌方一张牌增加一次资源贡献", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "destroy" },
      targets: [enemy],
      effectiveTargets: [enemy],
      resolved: true
    });
    assert.equal(
      tracker.finalizeMatch().players[0].contributionFacts.enemyCardsDestroyed,
      1
    );
  });

  test("UI·MVP：成功转移敌方一张牌同时保留控制与资源贡献", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "transfer" },
      targets: [enemy, actor],
      effectiveTargets: [enemy, actor],
      resolved: true
    });
    const result = tracker.finalizeMatch().players[0];
    assert.equal(result.totals.enemyControls, 1);
    assert.equal(result.contributionFacts.enemyCardsTransferred, 1);
  });

  test("UI·MVP：成功把牌转移给敌人只增加敌方获牌事实", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, ally, enemy]);
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "transfer" },
      targets: [ally, enemy],
      effectiveTargets: [ally, enemy],
      resolved: true
    });
    const facts = tracker.finalizeMatch().players[0].contributionFacts;
    assert.deepEqual(
      [facts.allyCardsGranted, facts.enemyCardsTransferred, facts.enemyCardsGranted],
      [0, 0, 1]
    );
  });

  test("UI·MVP：互利按实际 recipients 汇总友方正项与敌方负项", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const allyA = trackerPlayer("ally-a", 1, "dawn");
    const allyB = trackerPlayer("ally-b", 2, "dawn");
    const enemy = trackerPlayer("enemy", 3, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, allyA, allyB, enemy]);
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "transfer" },
      resolved: true,
      effectiveTargets: [actor, allyA]
    });
    await dispatcher.emit("beforeCardUse", {
      source: actor,
      card: { definitionId: "mutualBenefit" },
      resolutionId: "mutual-1"
    });
    actor.hand.push({ id: "actor-card" });
    allyA.hand.push({ id: "ally-a-card" });
    allyB.hand.push({ id: "ally-b-card" });
    enemy.hand.push({ id: "enemy-card" });
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "mutualBenefit" },
      resolved: true,
      effectiveTargets: [actor, allyA, allyB, enemy],
      resolutionId: "mutual-1"
    });
    const actorResult = tracker.finalizeMatch().players[0];
    assert.equal(actorResult.contributionFacts.allyCardsGranted, 3);
    assert.equal(actorResult.contributionFacts.enemyCardsGranted, 1);
    assert.equal(calculatePerformance(actorResult).contributionTotal, 2);
  });

  test("UI·MVP：只给敌人一张牌保留负贡献事实而评分最低为零", () => {
    const result = calculatePerformance(rawPlayer({
      contributionFacts: { enemyCardsGranted: 1 }
    }));
    assert.equal(result.contributionTotal, -1);
    assert.equal(result.raw.contribution, 0);
    assert.equal(result.scores.contribution, 0);
    assert.equal(result.ratios.contribution, 0);
  });

  test("UI·MVP：成功反制敌人对队友的破坏增加一次保护贡献", async () => {
    const protector = trackerPlayer("protector", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const { dispatcher, tracker } = trackerFixture([protector, ally, enemy]);
    await dispatcher.emit("cardUsed", {
      source: protector,
      card: { definitionId: "counter" },
      usageContext: "response",
      targets: [enemy, ally],
      effectiveTargets: [enemy, ally],
      resolved: true
    });
    await dispatcher.emit("cardUsed", {
      source: enemy,
      card: { definitionId: "destroy" },
      targets: [ally],
      effectiveTargets: [],
      resolved: false
    });
    assert.equal(
      tracker.finalizeMatch().players[0].contributionFacts.allyResourceActionsProtected,
      1
    );
  });

  test("UI·MVP：保护反制被再反制且敌方破坏成功时不增加贡献", async () => {
    const protector = trackerPlayer("protector", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemy = trackerPlayer("enemy", 2, "dusk");
    const enemyCounter = trackerPlayer("enemy-counter", 3, "dusk");
    const { dispatcher, tracker } = trackerFixture([protector, ally, enemy, enemyCounter]);
    await dispatcher.emit("cardUsed", {
      source: enemyCounter,
      card: { definitionId: "counter" },
      usageContext: "response",
      targets: [protector, enemy],
      effectiveTargets: [protector, enemy],
      resolved: true
    });
    await dispatcher.emit("cardUsed", {
      source: enemy,
      card: { definitionId: "destroy" },
      targets: [ally],
      effectiveTargets: [ally],
      resolved: true
    });
    assert.equal(
      tracker.finalizeMatch().players[0].contributionFacts.allyResourceActionsProtected,
      0
    );
  });

  test("UI·MVP：回合系数使用一至十三回合固定表并从十四回合起每回合增加0.01", () => {
    const rounds = [1, 2, 3, 10, 11, 12, 13, 14, 15, 20, 30];
    assert.deepEqual(
      rounds.map((value) => getRoundMultiplier(value)),
      [0.30, 0.40, 0.50, 0.85, 0.90, 0.95, 1.00, 1.01, 1.02, 1.07, 1.17]
    );
  });

  test("UI·MVP：二人队胜局系数区分1v3、1v2、普通存活胜局与阵亡队友", () => {
    const scenarios = [
      { aliveAtEnd: true, clutchEnemyCount: 3 },
      { aliveAtEnd: true, clutchEnemyCount: 2 },
      { playerId: "normal-survivor-a", aliveAtEnd: true },
      { playerId: "normal-survivor-b", aliveAtEnd: true },
      { aliveAtEnd: true, clutchEnemyCount: 1 },
      { aliveAtEnd: false, clutchEnemyCount: 3 }
    ];
    assert.deepEqual(scenarios.map((options) => calculatePerformance(rawPlayer({
      initialTeamSize: 2,
      won: true,
      ...options
    })).victoryMultiplier), [1.50, 1.30, 1.20, 1.20, 1.20, 1.00]);
  });

  test("UI·MVP：三人队胜局系数区分1v2、普通存活胜局与阵亡玩家", () => {
    const scenarios = [
      { aliveAtEnd: true, clutchEnemyCount: 2 },
      { aliveAtEnd: true, clutchEnemyCount: 1 },
      { playerId: "normal-survivor-a", aliveAtEnd: true },
      { playerId: "normal-survivor-b", aliveAtEnd: true },
      { aliveAtEnd: false, clutchEnemyCount: 2 }
    ];
    assert.deepEqual(scenarios.map((options) => calculatePerformance(rawPlayer({
      initialTeamSize: 3,
      won: true,
      ...options
    })).victoryMultiplier), [2.00, 1.20, 1.20, 1.20, 1.00]);
  });

  test("UI·MVP：失败玩家即使曾进入1v2残局也没有胜局系数", () => {
    const result = calculatePerformance(rawPlayer({
      initialTeamSize: 3,
      won: false,
      aliveAtEnd: true,
      clutchEnemyCount: 2
    }));
    assert.equal(result.victoryMultiplier, 1.00);
  });

  test("UI·MVP：1v3进入残局后降至1v2并获胜仍使用1v3系数", async () => {
    const survivor = trackerPlayer("survivor", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemies = [
      trackerPlayer("enemy-a", 2, "dusk"),
      trackerPlayer("enemy-b", 3, "dusk"),
      trackerPlayer("enemy-c", 4, "dusk")
    ];
    const { state, dispatcher, tracker } = trackerFixture([survivor, ally, ...enemies]);
    ally.alive = false;
    await dispatcher.emit("playerDead", { source: enemies[0], target: ally });
    for (const enemy of enemies) {
      enemy.alive = false;
      await dispatcher.emit("playerDead", { source: survivor, target: enemy });
    }
    state.winnerTeam = "dawn";
    const snapshot = tracker.finalizeMatch();
    const survivorResult = snapshot.players.find((entry) => entry.playerId === survivor.id);
    const deadAllyResult = snapshot.players.find((entry) => entry.playerId === ally.id);
    const enemyResults = snapshot.players.filter((entry) => entry.teamId === "dusk");
    assert.equal(survivorResult.clutchEnemyCount, 3);
    assert.equal(survivorResult.won, true);
    assert.equal(deadAllyResult.clutchEnemyCount, null);
    assert.equal(deadAllyResult.won, true);
    assert.equal(calculatePerformance(survivorResult).victoryMultiplier, 1.50);
    assert.equal(calculatePerformance(deadAllyResult).victoryMultiplier, 1.00);
    assert.deepEqual(enemyResults.map((entry) => entry.clutchEnemyCount), [null, null, null]);
  });

  test("UI·MVP：1v2进入残局后降至1v1并获胜仍使用1v2系数", async () => {
    const survivor = trackerPlayer("survivor", 0, "dawn");
    const ally = trackerPlayer("ally", 1, "dawn");
    const enemies = [
      trackerPlayer("enemy-a", 2, "dusk"),
      trackerPlayer("enemy-b", 3, "dusk")
    ];
    const { state, dispatcher, tracker } = trackerFixture([survivor, ally, ...enemies]);
    ally.alive = false;
    await dispatcher.emit("playerDead", { source: enemies[0], target: ally });
    for (const enemy of enemies) {
      enemy.alive = false;
      await dispatcher.emit("playerDead", { source: survivor, target: enemy });
    }
    state.winnerTeam = "dawn";
    const survivorResult = tracker.finalizeMatch().players.find(
      (entry) => entry.playerId === survivor.id
    );
    assert.equal(survivorResult.clutchEnemyCount, 2);
    assert.equal(calculatePerformance(survivorResult).victoryMultiplier, 1.30);
  });

  test("UI·MVP：新出现的1v1不建立残局档位", async () => {
    const survivor = trackerPlayer("survivor", 0, "dawn");
    const allies = [
      trackerPlayer("ally-a", 1, "dawn"),
      trackerPlayer("ally-b", 2, "dawn")
    ];
    const enemy = trackerPlayer("enemy", 3, "dusk");
    const { state, dispatcher, tracker } = trackerFixture([survivor, ...allies, enemy]);
    for (const ally of allies) {
      ally.alive = false;
      await dispatcher.emit("playerDead", { source: enemy, target: ally });
    }
    enemy.alive = false;
    await dispatcher.emit("playerDead", { source: survivor, target: enemy });
    state.winnerTeam = "dawn";
    const survivorResult = tracker.finalizeMatch().players.find(
      (entry) => entry.playerId === survivor.id
    );
    assert.equal(survivorResult.clutchEnemyCount, null);
    assert.equal(calculatePerformance(survivorResult).victoryMultiplier, 1.20);
  });

  test("UI·MVP：2v1人数优势方获胜时两名存活胜者都使用普通胜局系数", async () => {
    const winners = [
      trackerPlayer("winner-a", 0, "dawn"),
      trackerPlayer("winner-b", 1, "dawn")
    ];
    const loser = trackerPlayer("loser", 2, "dusk");
    const { state, dispatcher, tracker } = trackerFixture([...winners, loser]);
    loser.alive = false;
    await dispatcher.emit("playerDead", { source: winners[0], target: loser });
    state.winnerTeam = "dawn";
    const winnerResults = tracker.finalizeMatch().players.filter((entry) => entry.won);
    assert.deepEqual(winnerResults.map((entry) => entry.clutchEnemyCount), [null, null]);
    assert.deepEqual(
      winnerResults.map((entry) => calculatePerformance(entry).victoryMultiplier),
      [1.20, 1.20]
    );
  });

  test("UI·MVP：十五回合按新控制贡献阈值得到对应基础分与最终分", () => {
    const twoPlayerResult = calculatePerformance(rawPlayer({
      initialTeamSize: 2,
      effectiveRounds: 15,
      won: true,
      aliveAtEnd: true,
      clutchEnemyCount: 3,
      totals: {
        enemyHpDamage: 30,
        allyHealing: 9,
        cardsPlayed: 48,
        skillEnergySpent: 19.5,
        enemyControls: 15
      },
      contributionFacts: { allyCardsGranted: 10.5 }
    }));
    const threePlayerResult = calculatePerformance(rawPlayer({
      initialTeamSize: 3,
      effectiveRounds: 15,
      won: true,
      aliveAtEnd: true,
      clutchEnemyCount: 2,
      totals: {
        enemyHpDamage: 18,
        allyHealing: 7.5,
        cardsPlayed: 39,
        skillEnergySpent: 18,
        enemyControls: 12
      },
      contributionFacts: { allyCardsGranted: 7.5 }
    }));
    assert.deepEqual(
      [twoPlayerResult.baseScore, twoPlayerResult.roundMultiplier,
        twoPlayerResult.victoryMultiplier, twoPlayerResult.finalScore],
      [553.3333333333334, 1.02, 1.50, 846.6000000000001]
    );
    assert.deepEqual(
      [threePlayerResult.baseScore, threePlayerResult.roundMultiplier,
        threePlayerResult.victoryMultiplier, threePlayerResult.finalScore],
      [542.5, 1.02, 2.00, 1106.7]
    );
  });

  test("UI·MVP：胜方存活与阵亡玩家同组六维保持相同雷达数据", () => {
    const totals = { enemyHpDamage: 2.25, cardsPlayed: 2 };
    const alive = calculatePerformance(rawPlayer({ totals, won: true, aliveAtEnd: true }));
    const dead = calculatePerformance(rawPlayer({ totals, won: true, aliveAtEnd: false }));
    assert.deepEqual(alive.ratios, dead.ratios);
    assert.notEqual(alive.finalScore, dead.finalScore);
  });

  test("UI·MVP：相同每回合六维在不同回合系数下保持同一雷达比例", () => {
    const short = calculatePerformance(rawPlayer({
      effectiveRounds: 3,
      totals: { enemyHpDamage: 4.5, cardsPlayed: 6 }
    }));
    const long = calculatePerformance(rawPlayer({
      effectiveRounds: 11,
      totals: { enemyHpDamage: 16.5, cardsPlayed: 22 }
    }));
    assert.deepEqual(short.raw, long.raw);
    assert.deepEqual(short.ratios, long.ratios);
    assert.notEqual(short.roundMultiplier, long.roundMultiplier);
  });

  test("UI·MVP：五人乱序输入按最终分降序且第一名为MVP", () => {
    const viewModel = createMatchResultViewModel({
      gameId: "ranking",
      players: [3, 1, 5, 2, 4].map((value, index) => rawPlayer({
        playerId: `p${value}`,
        seatIndex: index,
        totals: { enemyHpDamage: value }
      }))
    });
    assert.deepEqual(viewModel.players.map((entry) => entry.playerId), ["p5", "p4", "p3", "p2", "p1"]);
    assert.equal(viewModel.players[0].isMvp, true);
    assert.equal(viewModel.mvpPlayerId, "p5");
  });

  test("UI·MVP：桌面结算卡整体缩放且窄屏保留滚动兜底", async () => {
    const css = await readFile(new URL("../css/components.css", import.meta.url), "utf8");
    assert.match(css, /\.game-over-overlay\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(css, /@media\s*\(min-width:\s*821px\)\s*\{\s*\.game-over-card\s*\{[^}]*zoom:\s*\.94/s);
    assert.match(css, /@media\s*\(min-width:\s*821px\)\s+and\s+\(max-height:\s*840px\)\s*\{\s*\.game-over-card\s*\{[^}]*zoom:\s*\.82/s);
    assert.match(css, /@media\s*\(min-width:\s*821px\)\s+and\s+\(max-height:\s*760px\)\s*\{\s*\.game-over-card\s*\{[^}]*zoom:\s*\.76/s);
    assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.game-over-overlay\s*\{[^}]*overflow:\s*auto/s);
  });

  test("UI·MVP：MatchResult 暴露队友角色与现有真实战斗统计", () => {
    const viewModel = createMatchResultViewModel({
      gameId: "history-final-facts",
      players: [
        rawPlayer({
          playerId: "human",
          characterId: "blade-walker",
          teamId: "dawn",
          seatIndex: 0,
          totals: {
            enemyHpDamage: 21,
            enemyKills: 3,
            allyHealing: 2,
            allyMitigation: 4,
            hpDamageTaken: 7
          }
        }),
        rawPlayer({
          playerId: "ally",
          characterId: "oath-warden",
          teamId: "dawn",
          seatIndex: 1
        }),
        rawPlayer({
          playerId: "enemy",
          characterId: "ember-magus",
          teamId: "dusk",
          seatIndex: 2
        })
      ]
    });
    const human = viewModel.players.find((entry) => entry.playerId === "human");
    assert.deepEqual(human.teammateCharacterIds, ["oath-warden"]);
    assert.equal(Object.isFrozen(human.teammateCharacterIds), true);
    assert.deepEqual(human.combatStats, { totalDamage: 21, support: 6, damageTaken: 7 });
    assert.equal(human.totals.enemyKills, 3);
  });

  test("UI·MVP：相同玩家与角色名只渲染一份且第一名使用背景装饰", () => {
    const viewModel = createMatchResultViewModel({
      gameId: "duplicate-label",
      players: [rawPlayer({
        playerId: "tuner",
        playerName: "调律师",
        characterName: "调律师"
      })]
    });
    const root = {
      innerHTML: "",
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; }
    };
    new MatchMvpResultView(root).render(viewModel);
    const rankingMarkup = root.innerHTML.match(/<button[\s\S]*?<\/button>/)?.[0] ?? "";
    const heroMarkup = root.innerHTML.match(/<header class="match-mvp-hero">[\s\S]*?<\/header>/)?.[0] ?? "";
    assert.equal(viewModel.players[0].secondaryLabel, null);
    assert.equal(rankingMarkup.match(/调律师/g)?.length, 1);
    assert.match(rankingMarkup, /match-mvp-ranking-watermark[^>]*aria-hidden="true">MVP/);
    assert.doesNotMatch(rankingMarkup, /match-mvp-badge/);
    assert.doesNotMatch(heroMarkup, /本场 MVP/);
    assert.match(heroMarkup, /match-mvp-hero-watermark[^>]*aria-hidden="true">MVP/);
  });

  test("UI·MVP：切换详情角色同步更新同排顶部战斗统计", () => {
    const detail = { innerHTML: "" };
    const buttons = ["leader", "support"].map((playerId) => ({
      dataset: { matchPerformancePlayerId: playerId },
      classList: { toggle() {} },
      setAttribute() {}
    }));
    const root = {
      addEventListener() {},
      querySelectorAll() { return buttons; },
      querySelector() { return detail; }
    };
    const viewModel = createMatchResultViewModel({
      gameId: "combat-stats-switch",
      players: [
        rawPlayer({
          playerId: "leader",
          playerName: "甲",
          seatIndex: 0,
          totals: {
            enemyHpDamage: 18,
            allyHealing: 2,
            allyMitigation: 3,
            hpDamageTaken: 8
          }
        }),
        rawPlayer({
          playerId: "support",
          playerName: "乙",
          seatIndex: 1,
          totals: {
            enemyHpDamage: 7,
            allyShieldAbsorbed: 1,
            hpDamageTaken: 12
          }
        })
      ]
    });
    const view = new MatchMvpResultView(root);
    view.viewModel = viewModel;
    view.selectedPlayerId = viewModel.defaultSelectedPlayerId;
    view.renderSelection();
    assert.match(detail.innerHTML, /甲/);
    assert.doesNotMatch(detail.innerHTML, /当前查看/);
    assert.match(detail.innerHTML, /<header><div class="match-mvp-detail-copy"><strong>甲<\/strong>[\s\S]*<\/div><span>第 1 名<\/span><\/header>/);
    assert.match(detail.innerHTML, /aria-label="总伤 \/ 支援 \/ 承伤 18\/5\/8"/);
    assert.match(detail.innerHTML, /is-damage-dealt[^>]*>18<\/i>\/.*is-support[^>]*>5<\/i>\/.*is-damage-taken[^>]*>8<\/i>/s);

    view.handleClick({
      target: { closest: () => ({ dataset: { matchPerformancePlayerId: "support" } }) }
    });
    assert.match(detail.innerHTML, /乙/);
    assert.match(detail.innerHTML, /aria-label="总伤 \/ 支援 \/ 承伤 7\/1\/12"/);
    assert.doesNotMatch(detail.innerHTML, /18\/5\/8/);
  });

  test("UI·MVP：本人纹章不写入结果且晨昏队伍使用不同展示图案", () => {
    const viewModel = createMatchResultViewModel({
      gameId: "human-sigil",
      players: [
        rawPlayer({ playerId: "local", playerName: "甲", seatIndex: 0 }),
        rawPlayer({ playerId: "leader", playerName: "乙", teamId: "dusk", seatIndex: 1, totals: { enemyHpDamage: 1 } })
      ]
    });
    const root = {
      innerHTML: "",
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; }
    };
    new MatchMvpResultView(root).render(viewModel, "local");
    const rankingRows = root.innerHTML.match(/<button[\s\S]*?<\/button>/g) ?? [];
    const localRow = rankingRows.find((row) => row.includes('data-match-performance-player-id="local"')) ?? "";
    const leaderRow = rankingRows.find((row) => row.includes('data-match-performance-player-id="leader"')) ?? "";
    assert.equal(Object.hasOwn(viewModel.players.find((player) => player.playerId === "local"), "isHumanPlayer"), false);
    assert.match(localRow, /match-mvp-ranking-row is-human-player/);
    assert.match(localRow, /match-mvp-player-sigil[^>]*aria-hidden="true"/);
    assert.match(localRow, /data-match-performance-team="dawn"/);
    assert.match(localRow, /match-mvp-team-pattern[^>]*aria-hidden="true"/);
    assert.doesNotMatch(localRow, />本人<|>YOU<|>玩家</);
    assert.doesNotMatch(leaderRow, /is-human-player|match-mvp-player-sigil/);
    assert.match(leaderRow, /data-match-performance-team="dusk"/);
    assert.match(leaderRow, /match-mvp-team-pattern[^>]*aria-hidden="true"/);
    assert.match(leaderRow, /match-mvp-ranking-watermark[^>]*aria-hidden="true">MVP/);
  });

  test("UI·MVP：UIManager 从当前对局参与者元数据传递真人展示上下文", () => {
    const viewModel = Object.freeze({ players: Object.freeze([]) });
    const calls = [];
    const manager = Object.create(UIManager.prototype);
    manager.game = { state: { players: [
      { id: "leader", controllerType: "ai" },
      { id: "local", controllerType: "human" }
    ] } };
    manager.newlyUnlockedAchievements = Object.freeze([]);
    manager.historyArchiveView = {
      achievementView: { renderMatchUnlockList: () => '<div class="match-achievement-empty">本局没有新的征途铭刻</div>' }
    };
    manager.matchMvpResultView = { render: (...args) => calls.push(args) };
    manager.showMatchPerformance(viewModel);
    assert.deepEqual(calls, [[
      viewModel,
      "local",
      '<div class="match-achievement-empty">本局没有新的征途铭刻</div>'
    ]]);
  });

  test("UI·MVP：本局成就 session 只保留必要字段并在新 Match 清空", () => {
    const queued = [];
    let resets = 0;
    const manager = Object.create(UIManager.prototype);
    manager.game = null;
    manager.newlyUnlockedAchievements = Object.freeze([]);
    manager.matchMvpResultView = { reset() { resets += 1; } };
    manager.historyArchiveView = { achievementView: {
      setItems() {},
      enqueueUnlocks(unlocks) { queued.push(unlocks); },
      resetUnlockQueue() { resets += 1; }
    } };
    manager.presentMatchAchievementUnlocks([{
      achievementId: "first_blood",
      teamScope: "duo",
      unlockedAt: "2026-09-03T00:00:00.000Z",
      ignored: "not-session-data"
    }], []);
    assert.deepEqual(Object.keys(manager.newlyUnlockedAchievements[0]), [
      "achievementId", "teamScope", "unlockedAt"
    ]);
    assert.equal(queued.length, 1);
    manager.attachGame({ state: { gameId: "next-match" } });
    assert.deepEqual(manager.newlyUnlockedAchievements, []);
    assert.equal(resets, 2);
  });

  test("UI·MVP：终局分发等待 History 与成就 session 完成后才渲染结果", async () => {
    const source = await readFile(new URL("../js/composition/createGameApplication.js", import.meta.url), "utf8");
    const body = source.match(/async function deliverMatchResult\([\s\S]*?\n\}/)?.[0] ?? "";
    const historyIndex = body.indexOf("await application.onMatchResult");
    const renderIndex = body.indexOf("application.ui.showMatchPerformance");
    assert.ok(historyIndex >= 0);
    assert.ok(renderIndex > historyIndex);
  });

  test("UI·MVP：详情使用回合系数与胜局系数且不再显示存活奖励", () => {
    const detail = { innerHTML: "" };
    const root = {
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return detail; }
    };
    const viewModel = createMatchResultViewModel({
      gameId: "multiplier-label",
      players: [rawPlayer({ won: true, aliveAtEnd: true, clutchEnemyCount: 3 })]
    });
    const view = new MatchMvpResultView(root);
    view.viewModel = viewModel;
    view.selectedPlayerId = viewModel.defaultSelectedPlayerId;
    view.renderSelection();
    assert.match(detail.innerHTML, /回合系数 <b>×0\.30<\/b>/);
    assert.match(detail.innerHTML, /胜局系数 <b>×1\.50<\/b>/);
    assert.doesNotMatch(detail.innerHTML, /存活奖励/);
  });

  test("UI·MVP：同分每次均以原始座位顺序确定排名", () => {
    const left = rawPlayer({ playerId: "seat-0", seatIndex: 0, totals: { enemyHpDamage: 1 } });
    const right = rawPlayer({ playerId: "seat-1", seatIndex: 1, totals: { enemyHpDamage: 1 } });
    const first = createMatchResultViewModel({ gameId: "tie-a", players: [right, left] });
    const second = createMatchResultViewModel({ gameId: "tie-b", players: [left, right] });
    assert.deepEqual(first.players.map((entry) => entry.playerId), ["seat-0", "seat-1"]);
    assert.deepEqual(second.players.map((entry) => entry.playerId), ["seat-0", "seat-1"]);
  });

  test("UI·MVP：雷达轴固定从顶部行动开始按指定顺序顺时针排列", () => {
    const expected = ["activity", "support", "contribution", "control", "skill", "firepower"];
    const points = calculateRadarPoints(Object.fromEntries(expected.map((key) => [key, 1])));
    assert.deepEqual([...MATCH_PERFORMANCE_RADAR_AXIS_ORDER], expected);
    assert.deepEqual(points.map((point) => point.key), expected);
    assert.deepEqual([points[0].x, points[0].y], [160, 68]);
    assert.deepEqual([points[3].x, points[3].y], [160, 252]);
  });

  test("UI·MVP：雷达只生成纯文字六维标签且无白色轮廓", async () => {
    const markup = createRadarChartMarkup({});
    const css = await readFile(new URL("../css/components.css", import.meta.url), "utf8");
    const labelRule = css.match(/\.match-mvp-radar-label\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.doesNotMatch(markup, />0<|100%/);
    assert.doesNotMatch(markup, /<rect|<foreignObject/);
    assert.doesNotMatch(labelRule, /(?:^|;)\s*(?:stroke|stroke-width|paint-order|text-shadow|background)\s*:/);
    for (const label of ["行动", "支援", "贡献", "控制", "技能", "火力"]) {
      assert.match(markup, new RegExp(`>${label}<`));
    }
  });

  test("UI·MVP：雷达150%保持真实比例并越过固定标准圈", () => {
    const ratios = normalizeForRadar({ firepower: 3.0 }, 2);
    const point = calculateRadarPoints(ratios).find((entry) => entry.key === "firepower");
    const markup = createRadarChartMarkup(ratios);
    assert.equal(ratios.firepower, 1.5);
    assert.ok(Math.abs(Math.hypot(point.x - 160, point.y - 160) - 138) < 1e-9);
    assert.match(markup, /match-mvp-radar-performance/);
    assert.match(markup, /viewBox="0 0 320 320"/);
  });

  test("UI·MVP：连续两局初始化会把第二局累计清零", () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { state, tracker } = trackerFixture([actor, enemy]);
    tracker.handleAfterDamage({ source: actor, target: enemy, actualAmount: 2 });
    state.gameId = "mvp-match-2";
    tracker.initializeRoster();
    assert.equal(tracker.finalizeMatch().players[0].totals.enemyHpDamage, 0);
  });

  test("UI·MVP：重复 start 不会让同一 card event 累计两次", async () => {
    const actor = trackerPlayer("actor", 0, "dawn");
    const enemy = trackerPlayer("enemy", 1, "dusk");
    const { dispatcher, tracker } = trackerFixture([actor, enemy]);
    tracker.start();
    await dispatcher.emit("cardUsed", {
      source: actor,
      card: { definitionId: "assault" },
      resolved: true,
      effectiveTargets: [enemy]
    });
    assert.equal(tracker.finalizeMatch().players[0].totals.cardsPlayed, 1);
  });

  test("UI·MVP：同一 sidecar 重复收到 gameOver 仍只分发一次 MatchResult", async () => {
    const state = {
      gameId: "single-result",
      stateVersion: 0,
      players: [trackerPlayer("human", 0, "dawn"), trackerPlayer("enemy", 1, "dusk")],
      winnerTeam: "dawn",
      phase: "gameOver",
      currentPlayerIndex: 0
    };
    const dispatcher = new EventDispatcher(() => true);
    let deliveries = 0;
    const sidecar = createMatchPerformanceSidecar({
      eventDispatcher: dispatcher,
      getState: () => state,
      onResult: () => { deliveries += 1; }
    });
    await dispatcher.emit("gameOver", { winnerTeam: "dawn" });
    await dispatcher.emit("gameOver", { winnerTeam: "dawn" });
    assert.equal(deliveries, 1);
    sidecar.dispose();
  });
}
