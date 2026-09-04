import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createCombatWorkflow } from "../js/application/combat/CombatWorkflow.js";
import { EventDispatcher } from "../js/application/messaging/EventDispatcher.js";
import {
  ACHIEVEMENT_DEFINITIONS,
  sortAchievements
} from "../js/ui/history/achievements/AchievementRegistry.js";
import {
  buildAchievementViewModels,
  createEmptyAchievementData
} from "../js/ui/history/achievements/AchievementStore.js";
import { evaluateMatchAchievements } from "../js/ui/history/achievements/AchievementTracker.js";
import { HistoryStatsManager } from "../js/ui/history/HistoryStatsManager.js";
import { MatchPerformanceTracker } from "../js/ui/results/MatchPerformanceTracker.js";
import { MatchMvpResultView } from "../js/ui/results/MatchMvpResultView.js";
import { HistoryArchiveView } from "../js/ui/history/HistoryArchiveView.js";
import { AchievementView } from "../js/ui/history/achievements/AchievementView.js";

/*
功能
创建测试用的内存历史存储。

调用方
历史成就持久化测试。

输入
无。

输出
符合 HistoryStatsManager contract 的内存适配器。

读取状态
闭包中的 JSON 字符串。

写入状态
更新 JSON 字符串。

调用函数
JSON.parse、JSON.stringify。

边界与不变量
create 只用于首次建档，后续 write 模拟同一 History 文件。
*/
function memoryStorage() {
  let json = null;
  return {
    async read() { return json; },
    async create(next) { if (json !== null) return false; json = next; return true; },
    async write(next) { json = next; },
    readObject() { return JSON.parse(json); }
  };
}

/*
功能
创建包含真人结果与成就事实的最小终局。

调用方
成就评估与 Manager 测试。

输入
覆盖项。

输出
MatchResultViewModel 等价对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
事实已经由 MatchPerformanceTracker 冻结；成就层不重新计算。
*/
function result(overrides = {}) {
  const player = {
    playerId: "human",
    characterId: "blade-walker",
    characterName: "刃行者",
    teamId: "dawn",
    initialTeamSize: 2,
    teammateCharacterIds: ["oath-warden"],
    won: true,
    aliveAtEnd: true,
    isMvp: true,
    finalScore: 1001,
    effectiveRounds: 4,
    totals: { enemyHpDamage: 12, enemyKills: 2 },
    combatStats: { totalDamage: 12, damageTaken: 8, support: 0 },
    achievementFacts: {
      activeSkillUses: 3, activeAssaultUses: 0, committedAssaultUses: 0,
      rescueCount: 3, maxTurnDamage: 3, maxTurnKills: 2,
      maxHandCount: 16, equipmentUses: 10, lightningCasts: 2, lightningHits: 2,
      teammateDeaths: 0, maxAliveRound: 0, clutchEnemyCounts: [2, 3]
    },
    ...overrides
  };
  return { gameId: "achievement-match", players: [player] };
}

/*
功能
用结构化终局事实评估单项成就。

调用方
新增成就边界测试。

输入
成就 ID、玩家字段覆盖、achievementFacts 覆盖、持久化事实、连胜前置值与其他玩家结果。

输出
该成就在本次评估中是否满足。

读取状态
createEmptyAchievementData、evaluateMatchAchievements。

写入状态
仅写入测试专用的 streak 快照。

调用函数
evaluateMatchAchievements。

边界与不变量
不经过日志、DOM 或历史扫描；最高存活轮次与 scores 直接作为冻结 MatchResult 事实提供。
*/
function evaluateAchievementForTest(
  id,
  playerOverrides = {},
  factOverrides = {},
  persistentFacts = {},
  streakOverrides = {},
  otherPlayers = []
) {
  const base = result().players[0];
  const player = {
    ...base,
    ...playerOverrides,
    achievementFacts: { ...base.achievementFacts, ...factOverrides }
  };
  const streaks = createEmptyAchievementData().streaks;
  streaks.duo.win = streakOverrides.win ?? 0;
  streaks.duo.mvp = streakOverrides.mvp ?? 0;
  streaks.duo.lostMvp = streakOverrides.lostMvp ?? 0;
  return evaluateMatchAchievements(
    { gameId: "achievement-boundary", finalRound: playerOverrides.finalRound ?? 0, players: [player, ...otherPlayers] },
    "human",
    streaks,
    persistentFacts
  ).unlocked.includes(id);
}

/*
功能
通过真实 CombatWorkflow 与 MatchPerformanceTracker 评估一次攻击对应的伤害成就。

调用方
攻击伤害成就回归测试。

输入
增减伤完成后的攻击伤害与目标攻击前生命。

输出
实际掉血、冻结成就事实与本场解锁 ID。

读取状态
测试内 MatchState 与 CombatWorkflow 发布的 afterDamage 事实。

写入状态
测试目标生命与 MatchPerformanceTracker 局内事实。

调用函数
createCombatWorkflow、MatchPerformanceTracker.finalizeMatch、evaluateMatchAchievements。

边界与不变量
目标护盾令实际生命伤害等于剩余 HP 且不格挡；成就事实必须保留 HP cap 前伤害，火力累计仍只使用实际掉血。
*/
async function evaluateTrackedAttack(finalAttackDamage, targetHp) {
  const actor = {
    id: "human", name: "human", seatIndex: 0, battleTeam: "dawn", controllerType: "human",
    alive: true, hp: 4, maxHp: 4, shield: 0, hand: [], character: { id: "blade-walker", name: "human" }
  };
  const ally = {
    id: "ally", name: "ally", seatIndex: 1, battleTeam: "dawn", controllerType: "ai",
    alive: true, hp: 4, maxHp: 4, shield: 0, hand: [], character: { id: "oath-warden", name: "ally" }
  };
  const enemy = {
    id: "enemy", name: "enemy", seatIndex: 2, battleTeam: "dusk", controllerType: "ai",
    alive: true, hp: targetHp, maxHp: 4, shield: Math.max(0, finalAttackDamage - targetHp),
    hand: [], character: { id: "ember-magus", name: "enemy" }
  };
  const state = {
    gameId: `achievement-damage-${finalAttackDamage}-${targetHp}`,
    isGameOver: false,
    stateVersion: 0,
    players: [actor, ally, enemy],
    currentPlayerIndex: 0,
    currentRound: 1,
    phase: "play",
    winnerTeam: "dawn"
  };
  const dispatcher = new EventDispatcher(() => true);
  const tracker = new MatchPerformanceTracker({ eventDispatcher: dispatcher, getState: () => state }).start();
  tracker.initializeRoster();
  const workflow = createCombatWorkflow({
    getState: () => state,
    isSessionValid: () => true,
    askForBlock: async () => ({ status: "declined", cards: [] }),
    getBlockRequirement: () => 0,
    judgeDefense: async () => ({ handled: false, immune: false, waivedBlock: false }),
    enterDying: async () => false,
    emitEvent: (type, payload) => dispatcher.emit(type, payload),
    createId: () => "achievement-damage-resolution",
    presentation: {
      log() {}, showDamageFeedback() {}, showShieldFeedback() {}, refresh() {}
    },
    diagnostics: { recordDamage() {} },
    observeDamage() {}
  });
  const actualDamage = await workflow.damage(actor, enemy, finalAttackDamage, {
    card: { definitionId: "assault", name: "突袭" },
    canBlock: false,
    damageType: "normal",
    resolutionId: "achievement-damage-resolution"
  });
  const snapshot = tracker.finalizeMatch();
  const humanResult = snapshot.players.find((player) => player.playerId === actor.id);
  const unlocked = evaluateMatchAchievements(
    { gameId: state.gameId, players: snapshot.players },
    actor.id,
    createEmptyAchievementData().streaks
  ).unlocked;
  return { actualDamage, humanResult, unlocked };
}

/*
功能
创建使用真实 DyingWorkflow 与 MatchPerformanceTracker 的定向救援夹具。

调用方
征途成就救援事件回归测试。

输入
测试运行器提供的 makeGame/makePlayer/instance，以及目标初始生命和各救援者调息数量。

输出
Game、濒死目标、救援者与 tracker。

读取状态
测试 Game fixture 的真实玩家、牌区与事件总线。

写入状态
设置目标生命并向救援者手牌加入调息。

调用函数
makePlayer、instance、makeGame、MatchPerformanceTracker.initializeRoster。

边界与不变量
目标不持有调息；只有显式配置的同阵营真人救援者会接受 dyingRescue 响应。
*/
function createTrackedRescueFixture(
  { makeGame, makePlayer, instance },
  { targetHp, rescuerCardCounts }
) {
  const target = makePlayer("achievement-rescue-target", 0, "dawn", "human");
  target.hp = targetHp;
  const rescuers = [];
  for (const [index, count] of rescuerCardCounts.entries()) {
    const rescuer = makePlayer(`achievement-rescuer-${index}`, index + 1, "dawn", "human");
    rescuer.hand.push(...Array.from({ length: count }, () => instance("recover")));
    rescuers.push(rescuer);
  }
  const enemy = makePlayer("achievement-rescue-enemy", rescuers.length + 1, "dusk");
  const { game } = makeGame([target, ...rescuers, enemy], {
    response: (request) => request.type === "dyingRescue"
  });
  const tracker = game.matchPerformanceSidecar.tracker;
  tracker.initializeRoster();
  return { game, target, rescuers, tracker };
}

/*
功能
注册征途成就定义、事实链、持久化与展示的定向测试。

调用方
tests/run.mjs。

输入
测试注册函数，以及真实 Game 测试夹具构造器。

输出
无返回值。

读取状态
各测试在执行时读取独立 fixture 与生产成就定义。

写入状态
仅向传入测试注册器添加测试。

调用函数
test、makeGame、makePlayer、instance。

边界与不变量
每个测试使用独立状态；不运行 Balance、自博弈或随机长局。
*/
export function registerHistoryAchievementTests(test, gameFixtures) {
  const { makeGame, makePlayer, instance } = gameFixtures;
  test("UI·征途成就：首次 duo 解锁提示一次且重复达成不再提示", async () => {
    const storage = memoryStorage();
    let index = 0;
    const dates = ["2026-09-03T05:32:14.183Z", "2026-09-04T05:32:14.183Z"];
    const manager = new HistoryStatsManager({ storage, now: () => new Date(dates[index++]) });
    const first = await manager.recordMatchResult(result({
      won: false,
      isMvp: false,
      finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 1 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    }), "human");
    const toastRoot = { innerHTML: "", addEventListener() {} };
    const view = new AchievementView({
      ownerDocument: { addEventListener() {} },
      addEventListener() {}
    }, { toastRoot });
    view.setItems(first.achievements.cards);
    view.enqueueUnlocks(first.newlyUnlockedAchievements);
    assert.deepEqual(first.newlyUnlockedAchievements, [{
      achievementId: "first_blood",
      teamScope: "duo",
      unlockedAt: dates[0]
    }]);
    assert.equal((toastRoot.innerHTML.match(/achievement-unlock-toast/g) ?? []).length, 1);
    assert.match(toastRoot.innerHTML, /data-achievement-id="first_blood"/);
    view.resetUnlockQueue();

    const repeated = await manager.recordMatchResult(result({
      won: false,
      isMvp: false,
      finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 1 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    }), "human");
    view.setItems(repeated.achievements.cards);
    view.enqueueUnlocks(repeated.newlyUnlockedAchievements);
    assert.deepEqual(repeated.newlyUnlockedAchievements, []);
    assert.equal(toastRoot.innerHTML, "");
    const record = storage.readObject().achievements.records.first_blood.duo;
    assert.equal(record.unlockedAt, dates[0]);
  });

  test("UI·征途成就：已有 duo 后首次 trio 只新增一条提示并变为完整铭刻", async () => {
    const storage = memoryStorage();
    const manager = new HistoryStatsManager({ storage, now: () => new Date("2026-09-03T00:00:00.000Z") });
    const facts = {
      won: false,
      isMvp: false,
      finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 1 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    };
    await manager.recordMatchResult(result(facts), "human");
    let cards = (await manager.getArchiveData()).achievements.cards;
    assert.equal(cards.find((card) => card.id === "first_blood").status, "PARTIAL");
    const trio = await manager.recordMatchResult(result({
      ...facts,
      initialTeamSize: 3,
      teammateCharacterIds: ["oath-warden", "spirit-medic"]
    }), "human");
    cards = trio.achievements.cards;
    assert.deepEqual(trio.newlyUnlockedAchievements.map(({ achievementId, teamScope }) => ({ achievementId, teamScope })), [{
      achievementId: "first_blood",
      teamScope: "trio"
    }]);
    assert.equal(cards.find((card) => card.id === "first_blood").status, "COMPLETE");
    assert.deepEqual(Object.keys(storage.readObject().achievements.records.first_blood).sort(), ["duo", "trio"]);

    const toastRoot = { innerHTML: "", addEventListener() {} };
    const view = new AchievementView({
      ownerDocument: { addEventListener() {} },
      addEventListener() {}
    }, { toastRoot });
    view.setItems(cards);
    view.enqueueUnlocks(trio.newlyUnlockedAchievements);
    assert.equal((toastRoot.innerHTML.match(/achievement-unlock-toast/g) ?? []).length, 1);
    assert.match(toastRoot.innerHTML, /achievement-unlock-toast is-common is-complete/);
    view.resetUnlockQueue();
  });

  test("UI·征途成就：专属队伍成就完成后不会显示为半完成", () => {
    const cards = buildAchievementViewModels({ records: {
      last_stand_duo: { duo: { unlockedAt: "2026-09-03T00:00:00.000Z" } },
      last_stand_trio: { trio: { unlockedAt: "2026-09-03T00:00:00.000Z" } }
    } });
    assert.equal(cards.find((card) => card.id === "last_stand_duo").status, "COMPLETE");
    assert.equal(cards.find((card) => card.id === "last_stand_trio").status, "COMPLETE");
  });

  test("UI·征途成就：同一 Match 多项解锁按 Store 顺序单条播放并逐条触发音效", () => {
    const timestamp = "2026-09-03T00:00:00.000Z";
    const shown = [];
    const items = buildAchievementViewModels({ records: {
      first_blood: { duo: { unlockedAt: timestamp } },
      rescue_beacon: { duo: { unlockedAt: timestamp } }
    } });
    const toastRoot = { innerHTML: "", addEventListener() {} };
    const view = new AchievementView({
      ownerDocument: { addEventListener() {} },
      addEventListener() {}
    }, { toastRoot, onToastShown: (unlock) => shown.push(unlock.achievementId) });
    view.setItems(items);
    view.enqueueUnlocks([
      { achievementId: "first_blood", teamScope: "duo", unlockedAt: timestamp },
      { achievementId: "rescue_beacon", teamScope: "duo", unlockedAt: timestamp }
    ]);
    assert.equal(view.currentToast.item.id, "first_blood");
    assert.equal(view.toastQueue.length, 1);
    assert.equal((toastRoot.innerHTML.match(/achievement-unlock-toast/g) ?? []).length, 1);
    assert.doesNotMatch(toastRoot.innerHTML, /data-achievement-id="rescue_beacon"/);
    assert.deepEqual(shown, ["first_blood"]);
    view.finishCurrentToast();
    assert.equal(view.currentToast.item.id, "rescue_beacon");
    assert.equal(view.toastQueue.length, 0);
    assert.equal((toastRoot.innerHTML.match(/achievement-unlock-toast/g) ?? []).length, 1);
    assert.deepEqual(shown, ["first_blood", "rescue_beacon"]);
    view.resetUnlockQueue();
  });

  test("UI·征途成就：Toast 展示回调接入现有 Achievement 命名音效", () => {
    const managerSource = readFileSync(new URL("../js/ui/UIManager.js", import.meta.url), "utf8");
    assert.match(managerSource, /onToastShown:\s*\(\)\s*=>\s*this\.playSound\("achievementUnlock"\)/);
  });

  test("UI·征途成就：MVP 列表只渲染本局新增记录并保留滚动空状态", async () => {
    const timestamp = "2026-09-03T00:00:00.000Z";
    const items = buildAchievementViewModels({ records: {
      first_blood: { duo: { unlockedAt: timestamp } },
      rescue_beacon: { duo: { unlockedAt: timestamp } }
    } });
    const view = new AchievementView({
      ownerDocument: { addEventListener() {} },
      addEventListener() {}
    });
    view.setItems(items);
    const markup = view.renderMatchUnlockList([
      { achievementId: "rescue_beacon", teamScope: "duo", unlockedAt: timestamp }
    ]);
    assert.match(markup, /data-achievement-id="rescue_beacon"/);
    assert.doesNotMatch(markup, /data-achievement-id="first_blood"/);
    assert.match(view.renderMatchUnlockList([]), /本局没有新的征途铭刻/);
    const achievementCss = readFileSync(new URL("../css/achievements.css", import.meta.url), "utf8");
    assert.match(achievementCss, /\.match-achievement-list\s*\{[^}]*max-height:\s*264px;[^}]*overflow-y:\s*auto/s);
  });

  test("UI·征途成就：Toast 与 MVP 行继承五类 tier class", () => {
    const timestamp = "2026-09-03T00:00:00.000Z";
    const tierIds = [
      ["first_blood", "common"],
      ["double_blood", "rare"],
      ["executioner_turn", "epic"],
      ["score_over_thousand", "legendary"],
      ["storm_scribe", "hidden-tier"]
    ];
    const records = Object.fromEntries(tierIds.map(([achievementId]) => [achievementId, {
      duo: { unlockedAt: timestamp }
    }]));
    const unlocks = tierIds.map(([achievementId]) => ({ achievementId, teamScope: "duo", unlockedAt: timestamp }));
    const toastRoot = { innerHTML: "", addEventListener() {} };
    const view = new AchievementView({
      ownerDocument: { addEventListener() {} },
      addEventListener() {}
    }, { toastRoot });
    view.setItems(buildAchievementViewModels({ records }));
    const rows = view.renderMatchUnlockList(unlocks);
    for (const [achievementId, tierClass] of tierIds) {
      assert.match(rows, new RegExp(`match-achievement-row is-${tierClass}[^>]*data-achievement-id="${achievementId}"`));
      view.resetUnlockQueue();
      view.enqueueUnlocks([{ achievementId, teamScope: "duo", unlockedAt: timestamp }]);
      assert.match(toastRoot.innerHTML, new RegExp(`achievement-unlock-toast is-${tierClass}`));
    }
    view.resetUnlockQueue();
  });

  test("UI·征途成就：Toast 与 MVP 行调用同一个现有详情弹窗入口", () => {
    const calls = [];
    const view = new AchievementView({
      ownerDocument: { addEventListener() {} },
      addEventListener() {}
    });
    view.openDetail = (achievementId, trigger) => calls.push([achievementId, trigger]);
    const toastTrigger = { dataset: { achievementId: "first_blood" } };
    view.handleToastClick({ target: { closest: () => toastTrigger } });

    const resultView = new MatchMvpResultView({ addEventListener() {} },
      (achievementId, trigger) => view.openDetail(achievementId, trigger));
    const rowTrigger = { dataset: { achievementId: "rescue_beacon" } };
    resultView.handleClick({
      target: {
        closest(selector) {
          return selector.startsWith(".match-achievement-row") ? rowTrigger : null;
        }
      }
    });
    assert.deepEqual(calls, [
      ["first_blood", toastTrigger],
      ["rescue_beacon", rowTrigger]
    ]);
  });

  test("UI·征途成就：未解锁隐藏成就 ViewModel 不包含真实条件", () => {
    const hidden = buildAchievementViewModels({ records: {} }).find((card) => card.hidden);
    assert.equal(hidden.status, "HIDDEN_LOCKED");
    assert.equal("criteria" in hidden, false);
    assert.doesNotMatch(hidden.description, /闪电|手牌|装备/);
  });

  test("UI·征途成就：定义乱序后仍按 tier、order、id 稳定排列", () => {
    const source = [
      { id: "z", tier: "legendary", order: 1 },
      { id: "b", tier: "common", order: 2 },
      { id: "a", tier: "common", order: 1 },
      { id: "h", tier: "hidden", order: 1 }
    ];
    assert.deepEqual(sortAchievements(source).map((entry) => entry.id), ["a", "b", "z", "h"]);
    assert.equal(ACHIEVEMENT_DEFINITIONS.length, 40);
  });

  test("UI·征途成就：档案页渲染全部四十张卡并保留隐藏卡面", async () => {
    const storage = memoryStorage();
    const manager = new HistoryStatsManager({ storage });
    const root = { innerHTML: "", addEventListener() {} };
    const view = new HistoryArchiveView(root, manager, () => {});
    await view.show();
    const achievementMarkup = root.innerHTML.slice(
      root.innerHTML.indexOf('<section class="history-section history-achievements"'),
      root.innerHTML.indexOf('<section class="history-section" aria-labelledby="history-travelers-title">')
    );
    assert.equal((achievementMarkup.match(/class="achievement-card /g) ?? []).length, 40);
    assert.equal((achievementMarkup.match(/journey-progress-segment/g) ?? []).length, 40);
    assert.match(achievementMarkup, /每一道亮起的铭痕，都来自一场真实终局[\s\S]*?achievement-journey-progress/);
    assert.doesNotMatch(achievementMarkup, /achievement-journey-sigil|journey-crest-mark/);
    assert.equal((achievementMarkup.match(/is-hidden-locked/g) ?? []).length, 10);
    assert.equal((achievementMarkup.match(/achievement-card is-hidden-tier is-hidden-locked/g) ?? []).length, 5);
    assert.doesNotMatch(achievementMarkup, /assets\/(cards|characters)\//);
    assert.match(achievementMarkup, /assets\/achievements\/storm_scribe\.svg/);
    assert.match(achievementMarkup, /assets\/achievements\/overflowing_grimoire\.svg/);
    assert.match(achievementMarkup, /assets\/achievements\/armory_keeper\.svg/);
    assert.doesNotMatch(achievementMarkup, />FR<\/b>/);
    assert.match(achievementMarkup, /data-achievement-id="first_victory"[\s\S]*?<i class="crest-wing crest-duo"><\/i>[\s\S]*?<i class="crest-wing crest-trio"><\/i>[\s\S]*?<\/button>/);
    assert.match(achievementMarkup, /data-achievement-id="last_stand_duo"[\s\S]*?<i class="crest-wing crest-duo"><\/i>[\s\S]*?<i class="crest-wing crest-trio is-placeholder"><\/i>[\s\S]*?<\/button>/);
    assert.match(achievementMarkup, /data-achievement-id="last_stand_trio"[\s\S]*?<i class="crest-wing crest-duo is-placeholder"><\/i>[\s\S]*?<i class="crest-wing crest-trio"><\/i>[\s\S]*?<\/button>/);
    const achievementCss = readFileSync(new URL("../css/achievements.css", import.meta.url), "utf8");
    assert.match(achievementCss, /\.achievement-card\.is-common, \.achievement-modal\.is-common, \.achievement-unlock-toast\.is-common, \.match-achievement-row\.is-common\s*\{[^}]*--achievement-tier-color:\s*#f0f2ee;[^}]*--achievement-tier-border:\s*rgba\(232,\s*236,\s*230,\s*\.78\)/s);
    assert.match(achievementCss, /\.achievement-card\.is-rare, \.achievement-modal\.is-rare, \.achievement-unlock-toast\.is-rare, \.match-achievement-row\.is-rare\s*\{[^}]*--achievement-tier-color:\s*#67beb3/);
    assert.match(achievementCss, /\.achievement-card\.is-epic, \.achievement-modal\.is-epic, \.achievement-unlock-toast\.is-epic, \.match-achievement-row\.is-epic\s*\{[^}]*--achievement-tier-color:\s*#d97991/);
    assert.match(achievementCss, /\.achievement-card\.is-legendary, \.achievement-modal\.is-legendary, \.achievement-unlock-toast\.is-legendary, \.match-achievement-row\.is-legendary\s*\{[^}]*--achievement-tier-color:\s*#efc96e/);
    assert.match(achievementCss, /\.achievement-card\.is-hidden-tier, \.achievement-modal\.is-hidden-tier, \.achievement-unlock-toast\.is-hidden-tier, \.match-achievement-row\.is-hidden-tier\s*\{[^}]*--achievement-tier-color:\s*#aaa0d7/);
    assert.match(achievementCss, /\.achievement-modal\s*\{[^}]*border:\s*1px solid var\(--achievement-tier-border\)[^}]*background:\s*var\(--achievement-tier-surface\)/s);
    assert.match(achievementCss, /\.achievement-modal-art > span:not\(\.achievement-crest\)/);
    assert.match(achievementCss, /\.achievement-card\.is-partial\s*\{[^}]*0 0 20px var\(--achievement-tier-glow\)/s);
    assert.match(achievementCss, /\.journey-progress-track\s*\{[^}]*repeat\(40, minmax\(0, 1fr\)\)/s);
    assert.match(achievementCss, /\.achievement-card\.is-partial, \.achievement-modal\.is-partial\s*\{[^}]*--achievement-art-brightness:\s*\.84/s);
    assert.match(achievementCss, /\.achievement-card\.is-complete, \.achievement-modal\.is-complete\s*\{[^}]*--achievement-art-brightness:\s*1\.08/s);
    assert.match(achievementCss, /\.achievement-card > img\s*\{[^}]*filter: saturate\(var\(--achievement-art-saturation\)\) brightness\(var\(--achievement-art-brightness\)\)/s);
    assert.match(achievementCss, /\.achievement-modal-art > img\s*\{[^}]*filter: saturate\(var\(--achievement-art-saturation\)\) brightness\(var\(--achievement-art-brightness\)\)/s);
    assert.match(achievementCss, /\.achievement-card\.is-complete\s*\{[^}]*0 0 42px var\(--achievement-tier-glow\)/s);
  });

  test("UI·征途成就：标题长度有层次且无人倒下使用战旗插画", () => {
    const titles = ACHIEVEMENT_DEFINITIONS.map((definition) => definition.title);
    const lengths = new Set(titles.map((title) => [...title].length));
    assert.equal(new Set(titles).size, 40);
    assert.ok(lengths.size >= 3);
    assert.ok(titles.every((title) => !/[。！？]$/.test(title)));
    const flawless = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "flawless_victory");
    const mvp = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "mvp_streak_ten");
    const ironWall = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "iron_wall_epic");
    assert.equal(flawless.title, "无人倒下");
    assert.equal(mvp.title, "冠冕长明");
    assert.equal(ironWall.title, "千锤百炼");
    assert.match(readFileSync(new URL("../assets/achievements/iron_wall_epic.svg", import.meta.url), "utf8"), /id="(?:anvil|hammer)"/);
    const artwork = readFileSync(new URL("../assets/achievements/flawless_victory.svg", import.meta.url), "utf8");
    assert.match(artwork, /flag|circle|stroke-dasharray/);
    assert.doesNotMatch(artwork, /crown|皇冠|王冠|冠冕/);
  });

  test("UI·征途成就：单翼铭刻会点亮对应卡片并让详情继承 tier 主题", () => {
    const records = {
      first_victory: { duo: { unlockedAt: "2026-09-03T00:00:00.000Z" } },
      storm_scribe: { duo: { unlockedAt: "2026-09-03T00:00:00.000Z" } }
    };
    const items = buildAchievementViewModels({ records });
    const partial = items.find((item) => item.id === "first_victory");
    assert.equal(partial.status, "PARTIAL");
    const root = {
      innerHTML: "",
      ownerDocument: { addEventListener() {} },
      addEventListener() {},
      querySelector(selector) {
        if (selector === "[data-achievement-overlay]") return null;
        return { focus() {} };
      },
      insertAdjacentHTML(_position, html) { this.innerHTML += html; }
    };
    const view = new AchievementView(root);
    view.items = items;
    const sectionMarkup = view.renderSection(items);
    assert.match(sectionMarkup, /class="achievement-card is-common is-partial"[\s\S]*?data-achievement-id="first_victory"/);
    assert.match(sectionMarkup, /journey-progress-segment is-partial/);
    view.openDetail(partial.id);
    assert.match(root.innerHTML, /achievement-modal is-common is-partial/);
    root.innerHTML = "";
    view.openDetail("storm_scribe");
    assert.match(root.innerHTML, /achievement-modal is-hidden-tier is-partial/);
    assert.doesNotMatch(root.innerHTML, /未铭刻的征途/);
  });

  test("UI·征途成就：复杂条件消费真实终局事实", () => {
    const streaks = createEmptyAchievementData().streaks;
    streaks.duo.win = 2;
    streaks.duo.mvp = 9;
    const evaluated = evaluateMatchAchievements(result(), "human", streaks).unlocked;
    for (const id of [
      "first_victory", "skill_trinity", "first_blood", "rescue_beacon", "win_streak_three",
      "double_blood", "rescue_chain", "heavy_blow", "damage_ten", "war_of_attrition",
      "flawless_victory", "last_stand_duo", "last_stand_duo_three", "executioner_turn",
      "iron_wall_epic", "rescue_master", "score_over_thousand", "mvp_streak_ten", "storm_scribe",
      "overflowing_grimoire", "armory_keeper"
    ]) assert.ok(evaluated.includes(id), id);
    assert.equal(evaluated.includes("last_stand_trio"), false);
  });

  test("UI·征途成就：四十项定义、ID、艺术资源与模式范围完整", () => {
    assert.equal(ACHIEVEMENT_DEFINITIONS.length, 40);
    assert.equal(new Set(ACHIEVEMENT_DEFINITIONS.map((definition) => definition.id)).size, 40);
    assert.equal(new Set(ACHIEVEMENT_DEFINITIONS.map((definition) => definition.title)).size, 40);
    for (const definition of ACHIEVEMENT_DEFINITIONS) {
      assert.match(definition.id, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      assert.ok(existsSync(new URL(`../${definition.artwork.slice(2)}`, import.meta.url)), definition.id);
      assert.match(readFileSync(new URL(`../${definition.artwork.slice(2)}`, import.meta.url), "utf8"), /^\s*<svg\b/);
    }
    const rescueChain = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "rescue_chain");
    const rescueMaster = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "rescue_master");
    const heavyBlow = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "heavy_blow");
    const ace = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "ace");
    const singlePunch = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "single_punch");
    const seriousPunch = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "serious_punch");
    const accidentalSuccess = ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "accidental_success");
    assert.deepEqual([rescueChain.title, rescueChain.criteria], ["医术高超", "单场成功救下至少 2 次濒死友军。"]);
    assert.deepEqual([rescueMaster.title, rescueMaster.criteria], ["轮回天生", "单场成功救下至少 3 次濒死友军。"]);
    assert.equal(heavyBlow.tier, "common");
    assert.equal(ace.teamScope, "duo");
    assert.equal(ace.criteria, "二人小队中玩家单场击杀全部敌人。");
    assert.equal(singlePunch.criteria, "打出的一次攻击造成至少 3 点伤害。");
    assert.equal(seriousPunch.criteria, "打出的一次攻击造成至少 5 点伤害。");
    assert.deepEqual(
      [accidentalSuccess.title, accidentalSuccess.tier, accidentalSuccess.hidden, accidentalSuccess.criteria],
      ["歪打正着", "hidden", true, "全程未打出突袭并成为全场最高火力者。"]
    );
    assert.equal(ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "storm_scribe").title, "雷神");
    assert.equal(ACHIEVEMENT_DEFINITIONS.find((definition) => definition.id === "last_stand_trio").teamScope, "trio");
    assert.deepEqual(sortAchievements(ACHIEVEMENT_DEFINITIONS).map((definition) => definition.id), ACHIEVEMENT_DEFINITIONS.map((definition) => definition.id));
    assert.deepEqual(
      ACHIEVEMENT_DEFINITIONS.slice(6, 9).map((definition) => definition.id),
      ["full_health", "heavy_blow", "win_streak_three"]
    );
  });

  test("UI·征途成就：新增判定严格遵守阈值、存活与真实来源", () => {
    assert.equal(evaluateAchievementForTest("mvp_spotlight", { isMvp: true }), true);
    assert.equal(evaluateAchievementForTest("mvp_spotlight", { isMvp: false }), false);
    assert.equal(evaluateAchievementForTest("matches_ten", {}, {}, { completedMatches: 9 }), false);
    assert.equal(evaluateAchievementForTest("matches_ten", {}, {}, { completedMatches: 10 }), true);

    assert.equal(evaluateAchievementForTest("full_health", { aliveAtEnd: true, finalHp: 4, finalMaxHp: 4 }), true);
    assert.equal(evaluateAchievementForTest("full_health", { aliveAtEnd: true, finalHp: 3, finalMaxHp: 4 }), false);
    assert.equal(evaluateAchievementForTest("full_health", { aliveAtEnd: false, finalHp: 4, finalMaxHp: 4 }), false);

    assert.equal(evaluateAchievementForTest("self_lightning", {}, { selfLightningHit: true }), true);
    assert.equal(evaluateAchievementForTest("self_lightning", {}, { selfLightningHit: false, lightningDamageTakenHits: 1 }), false);
    assert.equal(evaluateAchievementForTest("rescue_beacon", {}, { rescueCount: 0 }), false);
    assert.equal(evaluateAchievementForTest("rescue_beacon", {}, { rescueCount: 1 }), true);
    assert.equal(evaluateAchievementForTest("rescue_chain", {}, { rescueCount: 1 }), false);
    assert.equal(evaluateAchievementForTest("rescue_chain", {}, { rescueCount: 2 }), true);
    assert.equal(evaluateAchievementForTest("rescue_master", {}, { rescueCount: 2 }), false);
    assert.equal(evaluateAchievementForTest("rescue_master", {}, { rescueCount: 3 }), true);
    assert.equal(evaluateAchievementForTest("single_punch", {}, { maxSingleAttackDamage: 2 }), false);
    assert.equal(evaluateAchievementForTest("single_punch", {}, { maxSingleAttackDamage: 3 }), true);
    assert.equal(evaluateAchievementForTest("serious_punch", {}, { maxSingleAttackDamage: 4 }), false);
    assert.equal(evaluateAchievementForTest("serious_punch", {}, { maxSingleAttackDamage: 5 }), true);

    assert.equal(evaluateAchievementForTest("ace", { initialTeamSize: 2, totals: { enemyKills: 2 } }), false);
    assert.equal(evaluateAchievementForTest("ace", { initialTeamSize: 2, totals: { enemyKills: 3 } }), true);
    assert.equal(evaluateAchievementForTest("ace", { initialTeamSize: 3, totals: { enemyKills: 3 } }), false);
    assert.equal(evaluateAchievementForTest("defeated_mvp", { won: false, isMvp: true }), true);
    assert.equal(evaluateAchievementForTest("defeated_mvp", { won: true, isMvp: true }), false);
    assert.equal(evaluateAchievementForTest("defeated_mvp_streak", {}, {}, {}, { lostMvp: 0 }), false);
    assert.equal(evaluateAchievementForTest("defeated_mvp_streak", { won: false, isMvp: true }, {}, {}, { lostMvp: 1 }), true);

    assert.equal(evaluateAchievementForTest("lightning_conductor", {}, { lightningDamageTakenHits: 1 }), false);
    assert.equal(evaluateAchievementForTest("lightning_conductor", {}, { lightningDamageTakenHits: 2 }), true);
    assert.equal(evaluateAchievementForTest("radar_tactician", {}, { radarTacticJudgments: 4 }), false);
    assert.equal(evaluateAchievementForTest("radar_tactician", {}, { radarTacticJudgments: 5 }), true);
    assert.equal(evaluateAchievementForTest("energy_twenty_five", { totals: { skillEnergySpent: 24 } }), false);
    assert.equal(evaluateAchievementForTest("energy_twenty_five", { totals: { skillEnergySpent: 25 } }), true);

    assert.equal(evaluateAchievementForTest("survivor_thirteen", { aliveAtEnd: false }, { maxAliveRound: 12 }), false);
    assert.equal(evaluateAchievementForTest("survivor_thirteen", { aliveAtEnd: false }, { maxAliveRound: 13 }), true);
    assert.equal(evaluateAchievementForTest("battle_over_eighteen", { aliveAtEnd: false }, { maxAliveRound: 18 }), false);
    assert.equal(evaluateAchievementForTest("battle_over_eighteen", { aliveAtEnd: false }, { maxAliveRound: 19 }), true);

    assert.equal(evaluateAchievementForTest("score_over_thousand", { finalScore: 1000 }), false);
    assert.equal(evaluateAchievementForTest("score_over_thousand", { finalScore: 1000.01 }), true);
    assert.equal(evaluateAchievementForTest("damage_taken_twelve", { combatStats: { damageTaken: 11 } }), false);
    assert.equal(evaluateAchievementForTest("damage_taken_twelve", { combatStats: { damageTaken: 12 } }), true);
    assert.equal(evaluateAchievementForTest("card_creator", {}, { cardsGained: 100 }), false);
    assert.equal(evaluateAchievementForTest("card_creator", {}, { cardsGained: 101 }), true);
    const allScores = { activity: 101, support: 101, contribution: 101, control: 101, skill: 101, firepower: 101 };
    assert.equal(evaluateAchievementForTest("all_rounder", { scores: { ...allScores, support: 100 } }), false);
    assert.equal(evaluateAchievementForTest("all_rounder", { scores: allScores }), true);

    const lowerFirepower = [{ playerId: "ai-1", raw: { firepower: 4 }, scores: { firepower: 999 } }];
    const higherFirepower = [{ playerId: "ai-1", raw: { firepower: 6 } }];
    const tiedFirepower = [{ playerId: "ai-1", raw: { firepower: 5 } }];
    assert.equal(evaluateAchievementForTest(
      "accidental_success", { raw: { firepower: 5 }, scores: { firepower: 0 } }, { committedAssaultUses: 0 }, {}, {}, lowerFirepower
    ), true);
    assert.equal(evaluateAchievementForTest(
      "accidental_success", { raw: { firepower: 5 } }, { committedAssaultUses: 1 }, {}, {}, lowerFirepower
    ), false);
    assert.equal(evaluateAchievementForTest(
      "accidental_success", { raw: { firepower: 5 } }, { committedAssaultUses: 0 }, {}, {}, higherFirepower
    ), false);
    assert.equal(evaluateAchievementForTest(
      "accidental_success", { raw: { firepower: 5 } }, { committedAssaultUses: 0 }, {}, {}, tiedFirepower
    ), true);
  });

  test("UI·征途成就：无人倒下同时要求胜利、本人存活与队友无人死亡", () => {
    assert.equal(evaluateAchievementForTest(
      "flawless_victory", { won: true, aliveAtEnd: true }, { teammateDeaths: 0 }
    ), true);
    assert.equal(evaluateAchievementForTest(
      "flawless_victory", { won: true, aliveAtEnd: false }, { teammateDeaths: 0 }
    ), false);
    assert.equal(evaluateAchievementForTest(
      "flawless_victory", { won: true, aliveAtEnd: true }, { teammateDeaths: 1 }
    ), false);
    assert.equal(evaluateAchievementForTest(
      "flawless_victory", { won: false, aliveAtEnd: true }, { teammateDeaths: 0 }
    ), false);
  });

  test("UI·征途成就：成功救援按濒死事件及参与者去重提交", async () => {
    const direct = createTrackedRescueFixture(gameFixtures, {
      targetHp: 0,
      rescuerCardCounts: [1]
    });
    assert.equal(await direct.game.dyingWorkflow.enter(direct.target, null), true);
    assert.equal(direct.tracker.recordFor(direct.rescuers[0]).achievementFacts.rescueCount, 1);
    direct.game.dispose();

    const repeated = createTrackedRescueFixture(gameFixtures, {
      targetHp: -2,
      rescuerCardCounts: [3]
    });
    const countsBeforeSuccess = [];
    repeated.game.eventDispatcher.on("afterHeal", "test:rescue-await-success", () => {
      countsBeforeSuccess.push(
        repeated.tracker.recordFor(repeated.rescuers[0]).achievementFacts.rescueCount
      );
    });
    assert.equal(await repeated.game.dyingWorkflow.enter(repeated.target, null), true);
    assert.deepEqual(countsBeforeSuccess, [0, 0, 0]);
    assert.equal(repeated.tracker.recordFor(repeated.rescuers[0]).achievementFacts.rescueCount, 1);
    repeated.game.dispose();

    const shared = createTrackedRescueFixture(gameFixtures, {
      targetHp: -1,
      rescuerCardCounts: [1, 1]
    });
    assert.equal(await shared.game.dyingWorkflow.enter(shared.target, null), true);
    assert.deepEqual(shared.rescuers.map((rescuer) => (
      shared.tracker.recordFor(rescuer).achievementFacts.rescueCount
    )), [1, 1]);
    shared.game.dispose();
  });

  test("UI·征途成就：失败救援不计且两个独立成功濒死事件可累计", async () => {
    const failed = createTrackedRescueFixture(gameFixtures, {
      targetHp: -2,
      rescuerCardCounts: [1, 1]
    });
    assert.equal(await failed.game.dyingWorkflow.enter(failed.target, null), false);
    assert.deepEqual(failed.rescuers.map((rescuer) => (
      failed.tracker.recordFor(rescuer).achievementFacts.rescueCount
    )), [0, 0]);
    failed.game.dispose();

    const twice = createTrackedRescueFixture(gameFixtures, {
      targetHp: 0,
      rescuerCardCounts: [2]
    });
    assert.equal(await twice.game.dyingWorkflow.enter(twice.target, null), true);
    twice.target.hp = 0;
    assert.equal(await twice.game.dyingWorkflow.enter(twice.target, null), true);
    assert.equal(twice.tracker.recordFor(twice.rescuers[0]).achievementFacts.rescueCount, 2);
    twice.game.dispose();
  });

  test("UI·征途成就：普通、响应与借势突袭均写入 committed 事实", async () => {
    assert.equal(evaluateAchievementForTest(
      "accidental_success",
      { raw: { firepower: 5 } },
      { committedAssaultUses: 0 },
      {},
      {},
      [{ playerId: "other", raw: { firepower: 4 } }]
    ), true);

    const ordinaryActor = makePlayer("achievement-assault-action", 0, "dawn", "human");
    const ordinaryEnemy = makePlayer("achievement-assault-action-enemy", 1, "dusk");
    const ordinaryAssault = instance("assault");
    ordinaryActor.hand.push(ordinaryAssault);
    const ordinary = makeGame([ordinaryActor, ordinaryEnemy]);
    ordinary.game.matchPerformanceSidecar.tracker.initializeRoster();
    assert.equal(await ordinary.game.playCard(ordinaryActor, ordinaryAssault, [ordinaryEnemy]), true);
    assert.deepEqual([
      ordinary.game.matchPerformanceSidecar.tracker.recordFor(ordinaryActor).achievementFacts.activeAssaultUses,
      ordinary.game.matchPerformanceSidecar.tracker.recordFor(ordinaryActor).achievementFacts.committedAssaultUses
    ], [1, 1]);
    ordinary.game.dispose();

    const responder = makePlayer("achievement-assault-response", 0, "dawn", "human");
    const responseEnemy = makePlayer("achievement-assault-response-enemy", 1, "dusk");
    responder.hand.push(instance("assault"));
    const response = makeGame([responder, responseEnemy], {
      response: (request) => request.type === "assaultDiscard"
    });
    response.game.matchPerformanceSidecar.tracker.initializeRoster();
    const responseResult = await response.game.responseWorkflow.requestAssaultDiscard(
      responder,
      "在决斗中打出突袭",
      { source: responseEnemy, target: responder, card: instance("duel") }
    );
    assert.equal(responseResult.status, "used");
    assert.deepEqual([
      response.game.matchPerformanceSidecar.tracker.recordFor(responder).achievementFacts.activeAssaultUses,
      response.game.matchPerformanceSidecar.tracker.recordFor(responder).achievementFacts.committedAssaultUses
    ], [0, 1]);
    response.game.dispose();

    const leverageSource = makePlayer("achievement-leverage-source", 0, "dawn", "human");
    const leverageResponder = makePlayer("achievement-leverage-responder", 1, "dusk", "human");
    const leverage = instance("leverage");
    const forcedAssault = instance("assault");
    const equipment = instance("energyDevice");
    leverageSource.hand.push(leverage);
    leverageResponder.hand.push(forcedAssault);
    leverageResponder.equipment = equipment;
    const leverageFixture = makeGame([leverageSource, leverageResponder], {
      response: (request) => request.type === "leverageAssault"
    });
    leverageFixture.game.matchPerformanceSidecar.tracker.initializeRoster();
    assert.equal(await leverageFixture.game.playCard(leverageSource, leverage, [], {
      firstTargetId: leverageResponder.id,
      equipmentCardId: equipment.id,
      equipmentDefinitionId: equipment.definitionId,
      secondTargetId: leverageSource.id
    }), true);
    assert.deepEqual([
      leverageFixture.game.matchPerformanceSidecar.tracker.recordFor(leverageResponder).achievementFacts.activeAssaultUses,
      leverageFixture.game.matchPerformanceSidecar.tracker.recordFor(leverageResponder).achievementFacts.committedAssaultUses
    ], [0, 1]);
    leverageFixture.game.dispose();
  });

  test("UI·征途成就：非法、未提交与 rollback 突袭不污染 committed 事实", async () => {
    const actor = makePlayer("achievement-assault-rollback", 0, "dawn", "human");
    const ally = makePlayer("achievement-assault-rollback-ally", 1, "dawn");
    const enemy = makePlayer("achievement-assault-rollback-enemy", 2, "dusk");
    const illegalAssault = instance("assault");
    const rollbackAssault = instance("assault");
    actor.hand.push(illegalAssault, rollbackAssault);
    const { game } = makeGame([actor, ally, enemy]);
    const tracker = game.matchPerformanceSidecar.tracker;
    tracker.initializeRoster();
    assert.equal(await game.playCard(actor, illegalAssault, [ally]), false);
    assert.equal(tracker.recordFor(actor).achievementFacts.committedAssaultUses, 0);
    game.eventDispatcher.on("cardUsed", "test:rollback-assault-achievement-fact", (event) => {
      if (event.card === rollbackAssault) throw new Error("rollback assault fact");
    });
    await assert.rejects(
      game.playCard(actor, rollbackAssault, [enemy]),
      /rollback assault fact/
    );
    assert.deepEqual([
      tracker.recordFor(actor).achievementFacts.activeAssaultUses,
      tracker.recordFor(actor).achievementFacts.committedAssaultUses
    ], [0, 0]);
    game.dispose();
  });

  test("UI·征途成就：真实 1v3 后进入 1v2 会保留两个残局档位", async () => {
    const survivor = makePlayer("achievement-clutch-survivor", 0, "dawn", "human");
    const ally = makePlayer("achievement-clutch-ally", 1, "dawn");
    const enemies = [
      makePlayer("achievement-clutch-enemy-a", 2, "dusk"),
      makePlayer("achievement-clutch-enemy-b", 3, "dusk"),
      makePlayer("achievement-clutch-enemy-c", 4, "dusk")
    ];
    const { game } = makeGame([survivor, ally, ...enemies]);
    const tracker = game.matchPerformanceSidecar.tracker;
    tracker.initializeRoster();
    ally.hp = 0;
    await game.dyingWorkflow.kill(ally, enemies[0]);
    assert.deepEqual([...tracker.recordFor(survivor).achievementFacts.clutchEnemyCounts], [3]);
    enemies[0].hp = 0;
    await game.dyingWorkflow.kill(enemies[0], survivor);
    game.state.winnerTeam = "dawn";
    const snapshot = tracker.finalizeMatch();
    const player = snapshot.players.find((entry) => entry.playerId === survivor.id);
    const unlocked = evaluateMatchAchievements(
      snapshot,
      survivor.id,
      createEmptyAchievementData().streaks
    ).unlocked;
    assert.deepEqual(player.achievementFacts.clutchEnemyCounts, [2, 3]);
    assert.equal(unlocked.includes("last_stand_duo"), true);
    assert.equal(unlocked.includes("last_stand_duo_three"), true);
    game.dispose();
  });

  test("UI·征途成就：只形成 1v3 不会自动产生 1v2 残局事实", async () => {
    const survivor = makePlayer("achievement-clutch-only-three", 0, "dawn", "human");
    const ally = makePlayer("achievement-clutch-only-three-ally", 1, "dawn");
    const enemies = [
      makePlayer("achievement-clutch-only-three-a", 2, "dusk"),
      makePlayer("achievement-clutch-only-three-b", 3, "dusk"),
      makePlayer("achievement-clutch-only-three-c", 4, "dusk")
    ];
    const { game } = makeGame([survivor, ally, ...enemies]);
    const tracker = game.matchPerformanceSidecar.tracker;
    tracker.initializeRoster();
    ally.hp = 0;
    await game.dyingWorkflow.kill(ally, enemies[0]);
    game.state.winnerTeam = "dawn";
    const snapshot = tracker.finalizeMatch();
    const player = snapshot.players.find((entry) => entry.playerId === survivor.id);
    const unlocked = evaluateMatchAchievements(
      snapshot,
      survivor.id,
      createEmptyAchievementData().streaks
    ).unlocked;
    assert.deepEqual(player.achievementFacts.clutchEnemyCounts, [3]);
    assert.equal(unlocked.includes("last_stand_duo"), false);
    assert.equal(unlocked.includes("last_stand_duo_three"), true);
    game.dispose();
  });

  test("UI·征途成就：攻击峰值使用 HP cap 前最终结算伤害", async () => {
    const singlePunch = await evaluateTrackedAttack(3, 1);
    assert.equal(singlePunch.actualDamage, 1);
    assert.equal(singlePunch.humanResult.totals.enemyHpDamage, 1);
    assert.equal(singlePunch.humanResult.achievementFacts.maxSingleAttackDamage, 3);
    assert.equal(singlePunch.unlocked.includes("single_punch"), true);

    const seriousPunch = await evaluateTrackedAttack(5, 2);
    assert.equal(seriousPunch.actualDamage, 2);
    assert.equal(seriousPunch.humanResult.totals.enemyHpDamage, 2);
    assert.equal(seriousPunch.humanResult.achievementFacts.maxSingleAttackDamage, 5);
    assert.equal(seriousPunch.unlocked.includes("serious_punch"), true);

    const belowSeriousPunch = await evaluateTrackedAttack(4, 2);
    assert.equal(belowSeriousPunch.humanResult.achievementFacts.maxSingleAttackDamage, 4);
    assert.equal(belowSeriousPunch.unlocked.includes("serious_punch"), false);
  });

  test("UI·征途成就：长期完成局数与败方 MVP streak 按模式隔离", async () => {
    const storage = memoryStorage();
    const manager = new HistoryStatsManager({ storage, now: () => new Date("2026-09-03T00:00:00.000Z") });
    const ordinaryLoss = result({
      won: false, isMvp: false, finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 0 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    });
    let tenth = null;
    for (let index = 0; index < 10; index += 1) tenth = await manager.recordMatchResult(ordinaryLoss, "human");
    assert.equal(tenth.achievements.completedMatches, 10);
    assert.ok(tenth.newlyUnlockedAchievements.some(({ achievementId }) => achievementId === "matches_ten"));

    const defeatedMvp = result({
      won: false, isMvp: true, finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 0 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    });
    const trioDefeatedMvp = result({
      ...defeatedMvp.players[0],
      initialTeamSize: 3,
      teammateCharacterIds: ["oath-warden", "spirit-medic"]
    });

    const mixedManager = new HistoryStatsManager({ storage: memoryStorage(), now: () => new Date("2026-09-03T00:00:00.000Z") });
    await mixedManager.recordMatchResult(defeatedMvp, "human");
    const mixedSecond = await mixedManager.recordMatchResult(trioDefeatedMvp, "human");
    assert.equal(mixedSecond.newlyUnlockedAchievements.some(({ achievementId }) => achievementId === "defeated_mvp_streak"), false);
    assert.deepEqual(mixedSecond.achievements.streaks.duo, {
      win: 0, maxWin: 0, mvp: 1, maxMvp: 1, lostMvp: 1, maxLostMvp: 1
    });
    assert.deepEqual(mixedSecond.achievements.streaks.trio, {
      win: 0, maxWin: 0, mvp: 1, maxMvp: 1, lostMvp: 1, maxLostMvp: 1
    });
    const afterOrdinaryDuoLoss = await mixedManager.recordMatchResult(result({
      won: false, isMvp: false, finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 0 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    }), "human");
    assert.equal(afterOrdinaryDuoLoss.achievements.streaks.duo.lostMvp, 0);
    assert.equal(afterOrdinaryDuoLoss.achievements.streaks.trio.lostMvp, 1);

    const duoManager = new HistoryStatsManager({ storage: memoryStorage(), now: () => new Date("2026-09-03T00:00:00.000Z") });
    await duoManager.recordMatchResult(defeatedMvp, "human");
    const duoSecond = await duoManager.recordMatchResult(defeatedMvp, "human");
    assert.ok(duoSecond.newlyUnlockedAchievements.some(({ achievementId, teamScope }) => (
      achievementId === "defeated_mvp_streak" && teamScope === "duo"
    )));

    const trioManager = new HistoryStatsManager({ storage: memoryStorage(), now: () => new Date("2026-09-03T00:00:00.000Z") });
    await trioManager.recordMatchResult(defeatedMvp, "human");
    await trioManager.recordMatchResult(trioDefeatedMvp, "human");
    const duoWin = result({ ...defeatedMvp.players[0], won: true, isMvp: true });
    const afterDuoReset = await trioManager.recordMatchResult(duoWin, "human");
    assert.equal(afterDuoReset.achievements.streaks.duo.lostMvp, 0);
    assert.equal(afterDuoReset.achievements.streaks.trio.lostMvp, 1);
    const trioSecond = await trioManager.recordMatchResult(trioDefeatedMvp, "human");
    assert.ok(trioSecond.newlyUnlockedAchievements.some(({ achievementId, teamScope }) => (
      achievementId === "defeated_mvp_streak" && teamScope === "trio"
    )));
  });

  test("UI·征途成就：旧全局败方 MVP streak 按最近终局事实安全迁移", async () => {
    let persisted = null;
    const legacyManager = new HistoryStatsManager({
      storage: {
        async read() {
          return {
            version: 1,
            summary: { totalMatches: 7 },
            achievements: { schemaVersion: 1, lostMvpStreak: 2, maxLostMvpStreak: 2 },
            records: [
              { teammateCharacterIds: ["oath-warden", "spirit-medic"], won: false, isMvp: true },
              { teammateCharacterIds: ["oath-warden"], won: false, isMvp: true }
            ]
          };
        },
        async write(json) { persisted = JSON.parse(json); }
      }
    });
    const migrated = await legacyManager.initialize();
    assert.equal(migrated.achievements.completedMatches, 7);
    assert.equal(migrated.achievements.streaks.duo.lostMvp, 1);
    assert.equal(migrated.achievements.streaks.trio.lostMvp, 1);
    assert.equal(migrated.achievements.streaks.duo.maxLostMvp, 1);
    assert.equal(migrated.achievements.streaks.trio.maxLostMvp, 1);
    assert.equal(Object.hasOwn(migrated.achievements, "lostMvpStreak"), false);
    const continued = await legacyManager.recordMatchResult(result({
      won: false, isMvp: true, finalScore: 0,
      totals: { enemyHpDamage: 0, enemyKills: 0 },
      combatStats: { totalDamage: 0, damageTaken: 0, support: 0 },
      achievementFacts: {}
    }), "human");
    assert.ok(continued.newlyUnlockedAchievements.some(({ achievementId, teamScope }) => (
      achievementId === "defeated_mvp_streak" && teamScope === "duo"
    )));
    assert.equal(persisted.achievements.schemaVersion, 2);
    assert.equal(Object.hasOwn(persisted.achievements, "lostMvpStreak"), false);
  });

  test("UI·征途成就：tracker 输出攻击、救援、突袭、装备与闪电事实", async () => {
    const actor = { id: "actor", name: "actor", seatIndex: 0, battleTeam: "dawn", controllerType: "human", alive: true, shield: 0, hand: [], character: { id: "blade-walker", name: "actor" } };
    const ally = { id: "ally", name: "ally", seatIndex: 1, battleTeam: "dawn", controllerType: "ai", alive: true, shield: 0, hand: [], character: { id: "oath-warden", name: "ally" } };
    const enemy = { id: "enemy", name: "enemy", seatIndex: 2, battleTeam: "dusk", controllerType: "ai", alive: true, shield: 0, hand: [], character: { id: "ember-magus", name: "enemy" } };
    const state = { gameId: "tracker-achievements", players: [actor, ally, enemy], phase: "play", currentPlayerIndex: 0, currentRound: 1, winnerTeam: "dawn" };
    const dispatcher = new EventDispatcher(() => true);
    const tracker = new MatchPerformanceTracker({ eventDispatcher: dispatcher, getState: () => state }).start();
    tracker.initializeRoster();
    await dispatcher.emit("turnStart", { player: actor });
    await dispatcher.emit("activeSkillUsed", { source: actor });
    await dispatcher.emit("afterDamage", { source: actor, target: enemy, actualAmount: 1, finalAttackDamage: 3, shieldAbsorbed: 0, resolutionId: "attack-1" });
    await dispatcher.emit("afterDamage", { source: actor, target: enemy, actualAmount: 2, finalAttackDamage: 2, shieldAbsorbed: 0, resolutionId: "attack-2" });
    await dispatcher.emit("afterHeal", { source: actor, target: ally, actualAmount: 1, isDyingRescue: true });
    await dispatcher.emit("afterHeal", { source: actor, target: ally, actualAmount: 1, isDyingRescue: true });
    assert.equal(tracker.recordFor(actor).achievementFacts.rescueCount, 0);
    await dispatcher.emit("afterHeal", { source: actor, target: ally, actualAmount: 1, isDyingRescue: true });
    await dispatcher.emit("playerRescued", { target: ally });
    const assault = { definitionId: "assault", category: "basic" };
    await dispatcher.emit("beforeCardUse", { source: actor, card: assault, cancelled: true });
    await dispatcher.emit("cardCommitted", { source: enemy, card: assault, usageContext: "action" });
    await dispatcher.emit("cardCommitted", { source: actor, card: assault, usageContext: "response" });
    await dispatcher.emit("cardCommitted", { source: actor, card: assault, usageContext: "leverageAssault" });
    await dispatcher.emit("cardCommitted", { source: actor, card: { definitionId: "lightning" }, usageContext: "action" });
    assert.equal(tracker.recordFor(actor).achievementFacts.activeAssaultUses, 0);
    assert.equal(tracker.recordFor(actor).achievementFacts.committedAssaultUses, 2);
    await dispatcher.emit("cardCommitted", { source: actor, card: assault, usageContext: "action" });
    await dispatcher.emit("cardUsed", { source: actor, card: { definitionId: "lightning", category: "tactic" }, resolved: true });
    await dispatcher.emit("afterDamage", { source: null, target: enemy, actualAmount: 3, shieldAbsorbed: 0, damageType: "lightning", metadata: { originPlayerId: actor.id } });
    await dispatcher.emit("afterDamage", { source: null, target: actor, actualAmount: 1, shieldAbsorbed: 0, damageType: "lightning", metadata: { originPlayerId: actor.id } });
    await dispatcher.emit("afterDamage", { source: null, target: actor, actualAmount: 1, shieldAbsorbed: 0, damageType: "lightning", metadata: { originPlayerId: enemy.id } });
    await dispatcher.emit("judgmentRevealed", { attacker: enemy, defender: actor, card: { category: "tactic" } });
    await dispatcher.emit("afterCardMove", { to: "hand", player: actor });
    await dispatcher.emit("skillEnergyPaid", { source: actor, actualAmount: 2 });
    for (let round = 1; round <= 19; round += 1) {
      state.currentRound = round;
      await dispatcher.emit("roundStart", { round });
    }
    actor.alive = false;
    state.currentRound = 20;
    await dispatcher.emit("playerDead", { source: enemy, target: actor });
    await dispatcher.emit("roundStart", { round: 20 });
    const playerResult = tracker.finalizeMatch().players[0];
    const facts = playerResult.achievementFacts;
    assert.equal(facts.activeSkillUses, 1);
    assert.equal(facts.activeAssaultUses, 1);
    assert.equal(facts.committedAssaultUses, 3);
    assert.equal(facts.rescueCount, 1);
    assert.equal(facts.maxTurnDamage, 3);
    assert.equal(facts.lightningCasts, 1);
    assert.equal(facts.lightningHits, 1);
    assert.equal(facts.maxSingleAttackDamage, 3);
    assert.equal(facts.lightningDamageTakenHits, 2);
    assert.equal(facts.selfLightningHit, true);
    assert.equal(facts.radarTacticJudgments, 1);
    assert.equal(facts.cardsGained, 1);
    assert.equal(facts.maxAliveRound, 19);
    assert.equal(playerResult.aliveAtEnd, false);
    assert.equal(tracker.finalizeMatch().players[0].totals.skillEnergySpent, 2);
  });
}
