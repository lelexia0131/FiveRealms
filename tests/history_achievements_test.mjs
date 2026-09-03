import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    isMvp: true,
    finalScore: 1001,
    effectiveRounds: 4,
    totals: { enemyHpDamage: 12, enemyKills: 2 },
    combatStats: { totalDamage: 12, damageTaken: 8, support: 0 },
    achievementFacts: {
      activeSkillUses: 3, rescueCount: 3, maxTurnDamage: 3, maxTurnKills: 2,
      maxHandCount: 16, equipmentUses: 10, lightningCasts: 2, lightningHits: 2,
      teammateDeaths: 0, clutchEnemyCounts: [2, 3]
    },
    ...overrides
  };
  return { gameId: "achievement-match", players: [player] };
}

export function registerHistoryAchievementTests(test) {
  test("UI·征途成就：首次解锁时间持久化且重复达成不覆盖", async () => {
    const storage = memoryStorage();
    let index = 0;
    const dates = ["2026-09-03T05:32:14.183Z", "2026-09-04T05:32:14.183Z"];
    const manager = new HistoryStatsManager({ storage, now: () => new Date(dates[index++]) });
    await manager.recordMatchResult(result(), "human");
    await manager.recordMatchResult(result({ gameId: "achievement-match-2" }), "human");
    const record = storage.readObject().achievements.records.first_victory.duo;
    assert.equal(record.unlockedAt, dates[0]);
  });

  test("UI·征途成就：二人和三人进度由部分铭刻变为完整铭刻", async () => {
    const storage = memoryStorage();
    const manager = new HistoryStatsManager({ storage, now: () => new Date("2026-09-03T00:00:00.000Z") });
    await manager.recordMatchResult(result(), "human");
    let cards = (await manager.getArchiveData()).achievements.cards;
    assert.equal(cards.find((card) => card.id === "first_victory").status, "PARTIAL");
    await manager.recordMatchResult(result({ initialTeamSize: 3, teammateCharacterIds: ["oath-warden", "spirit-medic"] }), "human");
    cards = (await manager.getArchiveData()).achievements.cards;
    assert.equal(cards.find((card) => card.id === "first_victory").status, "COMPLETE");
  });

  test("UI·征途成就：专属队伍成就完成后不会显示为半完成", () => {
    const cards = buildAchievementViewModels({ records: {
      last_stand_duo: { duo: { unlockedAt: "2026-09-03T00:00:00.000Z" } },
      last_stand_trio: { trio: { unlockedAt: "2026-09-03T00:00:00.000Z" } }
    } });
    assert.equal(cards.find((card) => card.id === "last_stand_duo").status, "COMPLETE");
    assert.equal(cards.find((card) => card.id === "last_stand_trio").status, "COMPLETE");
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
    assert.equal(ACHIEVEMENT_DEFINITIONS.length, 22);
  });

  test("UI·征途成就：档案页渲染全部二十二张卡并保留隐藏卡面", async () => {
    const storage = memoryStorage();
    const manager = new HistoryStatsManager({ storage });
    const root = { innerHTML: "", addEventListener() {} };
    const view = new HistoryArchiveView(root, manager, () => {});
    await view.show();
    const achievementMarkup = root.innerHTML.slice(
      root.innerHTML.indexOf('<section class="history-section history-achievements"'),
      root.innerHTML.indexOf('<section class="history-section" aria-labelledby="history-travelers-title">')
    );
    assert.equal((achievementMarkup.match(/class="achievement-card /g) ?? []).length, 22);
    assert.equal((achievementMarkup.match(/journey-progress-segment/g) ?? []).length, 22);
    assert.match(achievementMarkup, /每一道亮起的铭痕，都来自一场真实终局[\s\S]*?achievement-journey-progress/);
    assert.doesNotMatch(achievementMarkup, /achievement-journey-sigil|journey-crest-mark/);
    assert.equal((achievementMarkup.match(/is-hidden-locked/g) ?? []).length, 6);
    assert.equal((achievementMarkup.match(/achievement-card is-hidden-tier is-hidden-locked/g) ?? []).length, 3);
    assert.doesNotMatch(achievementMarkup, /assets\/(cards|characters)\//);
    assert.match(achievementMarkup, /assets\/achievements\/storm_scribe\.svg/);
    assert.match(achievementMarkup, /assets\/achievements\/overflowing_grimoire\.svg/);
    assert.match(achievementMarkup, /assets\/achievements\/armory_keeper\.svg/);
    assert.doesNotMatch(achievementMarkup, />FR<\/b>/);
    assert.match(achievementMarkup, /data-achievement-id="first_victory"[\s\S]*?<i class="crest-wing crest-duo"><\/i>[\s\S]*?<i class="crest-wing crest-trio"><\/i>[\s\S]*?<\/button>/);
    assert.match(achievementMarkup, /data-achievement-id="last_stand_duo"[\s\S]*?<i class="crest-wing crest-duo"><\/i>[\s\S]*?<i class="crest-wing crest-trio is-placeholder"><\/i>[\s\S]*?<\/button>/);
    assert.match(achievementMarkup, /data-achievement-id="last_stand_trio"[\s\S]*?<i class="crest-wing crest-duo is-placeholder"><\/i>[\s\S]*?<i class="crest-wing crest-trio"><\/i>[\s\S]*?<\/button>/);
    const achievementCss = readFileSync(new URL("../css/achievements.css", import.meta.url), "utf8");
    assert.match(achievementCss, /\.achievement-card\.is-common, \.achievement-modal\.is-common\s*\{[^}]*--achievement-tier-color:\s*#f0f2ee;[^}]*--achievement-tier-border:\s*rgba\(232,\s*236,\s*230,\s*\.78\)/s);
    assert.match(achievementCss, /\.achievement-card\.is-rare, \.achievement-modal\.is-rare\s*\{[^}]*--achievement-tier-color:\s*#67beb3/);
    assert.match(achievementCss, /\.achievement-card\.is-epic, \.achievement-modal\.is-epic\s*\{[^}]*--achievement-tier-color:\s*#d97991/);
    assert.match(achievementCss, /\.achievement-card\.is-legendary, \.achievement-modal\.is-legendary\s*\{[^}]*--achievement-tier-color:\s*#efc96e/);
    assert.match(achievementCss, /\.achievement-card\.is-hidden-tier, \.achievement-modal\.is-hidden-tier\s*\{[^}]*--achievement-tier-color:\s*#aaa0d7/);
    assert.match(achievementCss, /\.achievement-modal\s*\{[^}]*border:\s*1px solid var\(--achievement-tier-border\)[^}]*background:\s*var\(--achievement-tier-surface\)/s);
    assert.match(achievementCss, /\.achievement-modal-art > span:not\(\.achievement-crest\)/);
    assert.match(achievementCss, /\.achievement-card\.is-partial\s*\{[^}]*0 0 20px var\(--achievement-tier-glow\)/s);
    assert.match(achievementCss, /\.journey-progress-track\s*\{[^}]*repeat\(22, minmax\(0, 1fr\)\)/s);
    assert.match(achievementCss, /\.achievement-card\.is-partial, \.achievement-modal\.is-partial\s*\{[^}]*--achievement-art-brightness:\s*\.84/s);
    assert.match(achievementCss, /\.achievement-card\.is-complete, \.achievement-modal\.is-complete\s*\{[^}]*--achievement-art-brightness:\s*1\.08/s);
    assert.match(achievementCss, /\.achievement-card > img\s*\{[^}]*filter: saturate\(var\(--achievement-art-saturation\)\) brightness\(var\(--achievement-art-brightness\)\)/s);
    assert.match(achievementCss, /\.achievement-modal-art > img\s*\{[^}]*filter: saturate\(var\(--achievement-art-saturation\)\) brightness\(var\(--achievement-art-brightness\)\)/s);
    assert.match(achievementCss, /\.achievement-card\.is-complete\s*\{[^}]*0 0 42px var\(--achievement-tier-glow\)/s);
  });

  test("UI·征途成就：标题长度有层次且无人倒下使用战旗插画", () => {
    const titles = ACHIEVEMENT_DEFINITIONS.map((definition) => definition.title);
    const lengths = new Set(titles.map((title) => [...title].length));
    assert.equal(new Set(titles).size, 22);
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

  test("UI·征途成就：tracker 输出单回合、救援、装备与闪电事实", async () => {
    const actor = { id: "actor", name: "actor", seatIndex: 0, battleTeam: "dawn", alive: true, shield: 0, hand: [], character: { id: "blade-walker", name: "actor" } };
    const ally = { id: "ally", name: "ally", seatIndex: 1, battleTeam: "dawn", alive: true, shield: 0, hand: [], character: { id: "oath-warden", name: "ally" } };
    const enemy = { id: "enemy", name: "enemy", seatIndex: 2, battleTeam: "dusk", alive: true, shield: 0, hand: [], character: { id: "ember-magus", name: "enemy" } };
    const state = { gameId: "tracker-achievements", players: [actor, ally, enemy], phase: "play", currentPlayerIndex: 0, winnerTeam: "dawn" };
    const dispatcher = new EventDispatcher(() => true);
    const tracker = new MatchPerformanceTracker({ eventDispatcher: dispatcher, getState: () => state }).start();
    tracker.initializeRoster();
    await dispatcher.emit("turnStart", { player: actor });
    await dispatcher.emit("activeSkillUsed", { source: actor });
    await dispatcher.emit("afterDamage", { source: actor, target: enemy, actualAmount: 3, shieldAbsorbed: 0 });
    await dispatcher.emit("afterHeal", { source: actor, target: ally, actualAmount: 1, isDyingRescue: true });
    await dispatcher.emit("cardUsed", { source: actor, card: { definitionId: "lightning", category: "tactic" }, resolved: true });
    await dispatcher.emit("afterDamage", { source: null, target: enemy, actualAmount: 3, shieldAbsorbed: 0, damageType: "lightning", metadata: { originPlayerId: actor.id } });
    const facts = tracker.finalizeMatch().players[0].achievementFacts;
    assert.equal(facts.activeSkillUses, 1);
    assert.equal(facts.rescueCount, 1);
    assert.equal(facts.maxTurnDamage, 3);
    assert.equal(facts.lightningCasts, 1);
    assert.equal(facts.lightningHits, 1);
  });
}
