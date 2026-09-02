import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryArchiveView } from "../js/ui/history/HistoryArchiveView.js";
import { HistoryStatsManager } from "../js/ui/history/HistoryStatsManager.js";

/*
功能
创建只在当前测试临时目录内读写 history_data.json 的存储适配器。

调用方
历史初始化、累计与重启持久化测试。

输入
临时历史文件绝对路径。

输出
符合 HistoryStatsManager storage contract 的适配器。

读取状态
指定临时 JSON 文件。

写入状态
条件创建或覆盖指定临时 JSON 文件。

调用函数
readFile、writeFile。

边界与不变量
只有 ENOENT 映射为未初始化；create 使用独占文件标志防止覆盖并发出现的已有档案。
*/
function createFileStorage(filePath) {
  return {
    async read() {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(json) {
      await writeFile(filePath, json, "utf8");
    },
    async create(json) {
      try {
        await writeFile(filePath, json, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (error) {
        if (error?.code === "EEXIST") return false;
        throw error;
      }
    }
  };
}

/*
功能
创建始终拒绝持久化写入的历史存储。

调用方
历史初始化与终局事务失败测试。

输入
无。

输出
可选择返回已有档案，create/write 固定抛出 HTTP 501 的存储适配器。

读取状态
无。

写入状态
无。

调用函数
Error。

边界与不变量
只模拟文件写入能力缺失；Manager 不得把未落盘数据提交到内存查询。
*/
function createUnsupportedWriteStorage(existing = null) {
  return {
    async read() { return existing; },
    async create() { throw new Error("保存历史档案失败：HTTP 501"); },
    async write() { throw new Error("保存历史档案失败：HTTP 501"); }
  };
}

/*
功能
创建历史测试使用的独立临时目录、文件适配器与清理函数。

调用方
各 HistoryStatsManager 文件持久化测试。

输入
无。

输出
包含 directory、filePath、storage 与 cleanup 的 fixture。

读取状态
系统临时目录路径。

写入状态
创建 fr-history 前缀临时目录。

调用函数
mkdtemp、join、createFileStorage、rm。

边界与不变量
cleanup 只递归删除 mkdtemp 返回的精确临时目录。
*/
async function createHistoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "fr-history-"));
  const filePath = join(directory, "history_data.json");
  return {
    directory,
    filePath,
    storage: createFileStorage(filePath),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/*
功能
创建包含完整终局事实与队伍身份的 MatchResult fixture。

调用方
胜利、失败与统计累计测试。

输入
真人终局字段覆盖项。

输出
冻结语义等价的 MatchResult 数据对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
评分、胜负、MVP、战斗统计和队友身份已经由上游确定，Manager 只能记录不能重算。
*/
function matchResult(options = {}) {
  const teamId = options.teamId ?? "dawn";
  const teammateCharacterIds = options.teammateCharacterIds ?? ["oath-warden"];
  const teammateNames = {
    "oath-warden": "守誓者",
    "spirit-medic": "灵医",
    "shade-agent": "影客"
  };
  return {
    gameId: options.gameId ?? "history-match",
    players: [{
      playerId: "human",
      characterId: options.characterId ?? "blade-walker",
      characterName: options.characterName ?? "刃行者",
      teamId,
      teammateCharacterIds,
      won: options.won ?? true,
      finalScore: options.finalScore ?? 420,
      effectiveRounds: options.effectiveRounds ?? 8,
      isMvp: options.isMvp ?? true,
      combatStats: options.combatStats ?? { totalDamage: 18, support: 5, damageTaken: 8 },
      totals: options.totals ?? { enemyKills: 2 }
    }, ...teammateCharacterIds.map((characterId, index) => ({
      playerId: `ally-${index}`,
      characterId,
      characterName: teammateNames[characterId] ?? characterId,
      teamId
    })), {
      playerId: "enemy",
      characterId: "ember-magus",
      characterName: "炎术师",
      teamId: teamId === "dawn" ? "dusk" : "dawn"
    }]
  };
}

/*
功能
注册历史数据初始化、累计、持久化与档案页边界测试。

调用方
tests/run.mjs 的 UI 与模板稳定分组。

输入
测试注册函数。

输出
无返回值。

读取状态
无。

写入状态
向统一 runner 注册历史模块测试。

调用函数
test。

边界与不变量
测试文件职责独立，不混入 MVP 评分公式测试；不访问仓库根 history_data.json。
*/
export function registerHistoryStatsTests(test) {
  test("UI·历史档案：首次启动自动创建 version 1 JSON", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      const archive = await manager.initialize();
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(archive.version, 1);
      assert.deepEqual(persisted, {
        version: 1,
        summary: {
          totalMatches: 0, wins: 0, losses: 0, mvpCount: 0,
          highestScore: 0, highestRounds: 0, totalScore: 0, totalRounds: 0
        },
        characters: {},
        teams: {},
        achievements: {
          companions: {},
          highestSingleMatchDamage: null,
          highestSingleMatchKills: null,
          highestSingleMatchSupport: null,
          highestSingleMatchDamageTaken: null
        },
        records: []
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：首次建档写入失败时展示读取错误且不伪装成持久化空档", async () => {
    const manager = new HistoryStatsManager({ storage: createUnsupportedWriteStorage() });
    await assert.rejects(manager.initialize(), /HTTP 501/);
    const root = { innerHTML: "", addEventListener() {} };
    const view = new HistoryArchiveView(root, manager, () => {});
    await view.show();
    assert.match(root.innerHTML, /卷册尚待展开/);
    assert.doesNotMatch(root.innerHTML, /501|HTTP|保存历史档案失败/);
  });

  test("UI·历史档案：终局 PUT 失败时不把未落盘记录提交到内存", async () => {
    const existing = JSON.stringify({
      version: 1,
      summary: {
        totalMatches: 0, wins: 0, losses: 0, mvpCount: 0,
        highestScore: 0, highestRounds: 0, totalScore: 0, totalRounds: 0
      },
      characters: {}, teams: {}, records: []
    });
    const manager = new HistoryStatsManager({ storage: createUnsupportedWriteStorage(existing) });
    await manager.initialize();
    await assert.rejects(manager.recordMatchResult(matchResult(), "human"), /HTTP 501/);
    const archive = await manager.getArchiveData();
    assert.equal(archive.summary.totalMatches, 0);
    assert.equal(archive.records.length, 0);
  });

  test("UI·历史档案：胜利终局累计角色、阵营、MVP 与最高纪录", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({
        storage: fixture.storage,
        now: () => new Date("2026-09-01T08:30:00.000Z")
      });
      await manager.recordMatchResult(matchResult(), "human");
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.deepEqual(persisted.summary, {
        totalMatches: 1, wins: 1, losses: 0, mvpCount: 1,
        highestScore: 420, highestRounds: 8, totalScore: 420, totalRounds: 8
      });
      assert.deepEqual(persisted.characters["blade-walker"], {
        matches: 1, wins: 1, winRate: 100, mvpCount: 1, highestScore: 420, totalScore: 420
      });
      assert.deepEqual(persisted.teams.dawn, { matches: 1, wins: 1, winRate: 100 });
      assert.deepEqual(persisted.records[0], {
        timestamp: "2026-09-01T08:30:00.000Z",
        characterId: "blade-walker",
        characterName: "刃行者",
        teamId: "dawn",
        teammateCharacterIds: ["oath-warden"],
        won: true,
        score: 420,
        rounds: 8,
        isMvp: true,
        damage: 18,
        kills: 2,
        support: 5,
        damageTaken: 8
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：失败终局累计并保持已有最高评分与最长回合", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.recordMatchResult(matchResult(), "human");
      await manager.recordMatchResult(matchResult({
        gameId: "history-loss",
        characterId: "ember-magus",
        characterName: "炎术师",
        teamId: "dusk",
        won: false,
        finalScore: 275,
        effectiveRounds: 6,
        isMvp: false
      }), "human");
      const archive = await manager.getArchiveData();
      const ember = archive.characters.find((character) => character.id === "ember-magus");
      const dusk = archive.teams.find((team) => team.id === "dusk");
      assert.deepEqual(archive.summary, {
        totalMatches: 2, wins: 1, losses: 1, mvpCount: 1,
        highestScore: 420, highestRounds: 8, totalScore: 695, totalRounds: 14, winRate: 50
      });
      assert.deepEqual(
        { matches: ember.matches, wins: ember.wins, winRate: ember.winRate, mvpCount: ember.mvpCount },
        { matches: 1, wins: 0, winRate: 0, mvpCount: 0 }
      );
      assert.deepEqual(dusk, { id: "dusk", name: "暮影", matches: 1, wins: 0, winRate: 0 });
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：关闭后重新创建 Manager 仍读取已保存历史", async () => {
    const fixture = await createHistoryFixture();
    try {
      const first = new HistoryStatsManager({ storage: fixture.storage });
      await first.recordMatchResult(matchResult({ finalScore: 512, effectiveRounds: 11 }), "human");
      const reopened = new HistoryStatsManager({ storage: createFileStorage(fixture.filePath) });
      const archive = await reopened.getArchiveData();
      assert.equal(archive.summary.totalMatches, 1);
      assert.equal(archive.summary.highestScore, 512);
      assert.equal(archive.summary.highestRounds, 11);
      assert.equal(archive.records[0].characterName, "刃行者");
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：同一 Manager 打开档案时仍重新读取磁盘 authority", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.initialize();
      const external = {
        version: 1,
        summary: {
          totalMatches: 1, wins: 1, losses: 0, mvpCount: 0,
          highestScore: 300, highestRounds: 7, totalScore: 300, totalRounds: 7
        },
        characters: {}, teams: {}, records: []
      };
      await writeFile(fixture.filePath, JSON.stringify(external), "utf8");
      const archive = await manager.getArchiveData();
      assert.equal(archive.summary.totalMatches, 1);
      assert.equal(archive.summary.highestScore, 300);
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：旧 version 1 记录保留且缺失终局事实保持未知", async () => {
    const fixture = await createHistoryFixture();
    try {
      const legacy = {
        version: 1,
        summary: {
          totalMatches: 1, wins: 1, losses: 0, mvpCount: 0,
          highestScore: 300, highestRounds: 7, totalScore: 300, totalRounds: 7
        },
        characters: {},
        teams: {},
        records: [{
          timestamp: "2026-08-01T00:00:00.000Z",
          characterId: "blade-walker",
          characterName: "刃行者",
          teamId: "dawn",
          won: true,
          score: 300,
          rounds: 7,
          isMvp: false
        }]
      };
      await writeFile(fixture.filePath, JSON.stringify(legacy), "utf8");
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      const archive = await manager.initialize();
      assert.equal(archive.records.length, 1);
      assert.equal(archive.records[0].damage, null);
      assert.equal(archive.records[0].kills, null);
      assert.equal(archive.records[0].support, null);
      assert.equal(archive.records[0].damageTaken, null);
      assert.equal(archive.records[0].teammateCharacterIds, null);
      assert.deepEqual(archive.achievements, {
        mostFrequentCompanion: null,
        highestSingleMatchDamage: null,
        highestSingleMatchKills: null,
        highestSingleMatchSupport: null,
        highestSingleMatchDamageTaken: null
      });

      await manager.recordMatchResult(matchResult(), "human");
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(persisted.records.length, 2);
      assert.equal(persisted.records[1].timestamp, legacy.records[0].timestamp);
      assert.equal(persisted.records[1].damage, null);
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：传奇记录只投影同行与四项真实单局终局事实", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.recordMatchResult(matchResult({
        teammateCharacterIds: ["oath-warden"],
        combatStats: { totalDamage: 18, support: 5, damageTaken: 8 },
        totals: { enemyKills: 2 }
      }), "human");
      await manager.recordMatchResult(matchResult({
        gameId: "history-two",
        teammateCharacterIds: ["spirit-medic"],
        combatStats: { totalDamage: 30, support: 9, damageTaken: 4 },
        totals: { enemyKills: 1 }
      }), "human");
      let archive = await manager.getArchiveData();
      assert.deepEqual(archive.achievements.mostFrequentCompanion, {
        characterId: "oath-warden", characterName: "守誓者", matches: 1
      });

      await manager.recordMatchResult(matchResult({
        gameId: "history-three",
        teammateCharacterIds: ["spirit-medic"],
        combatStats: { totalDamage: 20, support: 2, damageTaken: 12 },
        totals: { enemyKills: 4 }
      }), "human");
      archive = await manager.getArchiveData();
      assert.deepEqual(archive.achievements, {
        mostFrequentCompanion: {
          characterId: "spirit-medic", characterName: "灵医", matches: 2
        },
        highestSingleMatchDamage: 30,
        highestSingleMatchKills: 4,
        highestSingleMatchSupport: 9,
        highestSingleMatchDamageTaken: 12
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：最近征途持久化十局且同行按完整历史累计并可重读", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      for (let index = 0; index < 12; index += 1) {
        await manager.recordMatchResult(matchResult({
          gameId: `history-retention-${index}`,
          teammateCharacterIds: [index < 7 ? "oath-warden" : "spirit-medic"]
        }), "human");
      }
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(persisted.summary.totalMatches, 12);
      assert.equal(persisted.records.length, 10);
      assert.deepEqual(persisted.achievements.companions, {
        "oath-warden": { matches: 7 },
        "spirit-medic": { matches: 5 }
      });

      const reopened = new HistoryStatsManager({ storage: createFileStorage(fixture.filePath) });
      const archive = await reopened.getArchiveData();
      assert.equal(archive.records.length, 10);
      assert.deepEqual(archive.achievements.mostFrequentCompanion, {
        characterId: "oath-warden", characterName: "守誓者", matches: 7
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：返回旅途起点按动画偏好滚到顶部且真正返回按钮仍回首页", () => {
    const rootScrolls = [];
    const windowScrolls = [];
    let reducedMotion = false;
    let backCount = 0;
    const root = {
      innerHTML: "",
      addEventListener() {},
      scrollTo(options) { rootScrolls.push(options); },
      ownerDocument: {
        defaultView: {
          matchMedia: () => ({ matches: reducedMotion }),
          scrollTo(options) { windowScrolls.push(options); }
        }
      }
    };
    const view = new HistoryArchiveView(root, null, () => { backCount += 1; });
    const topTarget = {
      closest: (selector) => selector === "[data-history-top]" ? topTarget : null
    };
    view.handleClick({ target: topTarget });
    assert.deepEqual(rootScrolls.at(-1), { top: 0, behavior: "smooth" });
    assert.deepEqual(windowScrolls.at(-1), { top: 0, behavior: "smooth" });
    assert.equal(backCount, 0);

    reducedMotion = true;
    view.handleClick({ target: topTarget });
    assert.deepEqual(rootScrolls.at(-1), { top: 0, behavior: "auto" });
    assert.deepEqual(windowScrolls.at(-1), { top: 0, behavior: "auto" });

    const backTarget = {
      closest: (selector) => selector === "[data-history-back]" ? backTarget : null
    };
    view.handleClick({ target: backTarget });
    assert.equal(backCount, 1);
    assert.equal(rootScrolls.length, 2);
  });

  test("UI·历史档案：View 使用卡牌与纹章渲染且不生成表格", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.recordMatchResult(matchResult(), "human");
      const root = { innerHTML: "", addEventListener() {} };
      const view = new HistoryArchiveView(root, manager, () => {});
      await view.show();
      assert.match(root.innerHTML, /历史档案馆/);
      assert.match(root.innerHTML, /history-traveler-card/);
      assert.match(root.innerHTML, /history-faction-card is-dawn/);
      assert.match(root.innerHTML, /history-journey-card is-victory/);
      assert.match(root.innerHTML, /最常同行/);
      assert.match(root.innerHTML, /单局最高伤害/);
      assert.match(root.innerHTML, /单局最高击杀/);
      assert.match(root.innerHTML, /单局最高支援/);
      assert.match(root.innerHTML, /单局最高承伤/);
      assert.match(root.innerHTML, /data-history-top>返回旅途起点/);
      assert.equal(root.innerHTML.match(/420\.0/g)?.length, 3);
      assert.doesNotMatch(root.innerHTML, /<table/i);
      const [css, layout] = await Promise.all([
        readFile(new URL("../css/history.css", import.meta.url), "utf8"),
        readFile(new URL("../css/layout.css", import.meta.url), "utf8")
      ]);
      assert.match(css, /\.history-journey-grid\s*\{[^}]*grid-auto-rows:\s*122px/s);
      assert.match(css, /\.history-outcome\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1/s);
      assert.match(css, /\.history-journey-facts\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*2/s);
      assert.match(layout, /body:has\(\.history-archive-screen:not\(\.is-hidden\)\)\s*\{\s*min-width:\s*0/);
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：最近征途事实按 MVP、评分、回合顺序稳定对齐", async () => {
    const fixture = await createHistoryFixture();
    try {
      let minute = 0;
      const manager = new HistoryStatsManager({
        storage: fixture.storage,
        now: () => new Date(Date.UTC(2026, 8, 1, 8, minute++, 0))
      });
      await manager.recordMatchResult(matchResult({ gameId: "history-mvp", isMvp: true }), "human");
      await manager.recordMatchResult(matchResult({ gameId: "history-no-mvp", isMvp: false }), "human");
      const root = { innerHTML: "", addEventListener() {} };
      const view = new HistoryArchiveView(root, manager, () => {});
      await view.show();

      const facts = [...root.innerHTML.matchAll(/<div class="history-journey-facts">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
      assert.equal(facts.length, 2);
      assert.match(facts[0], /<i class="history-journey-mvp is-placeholder" aria-hidden="true">MVP<\/i><span>评分/);
      assert.match(facts[1], /<i class="history-journey-mvp">MVP<\/i><span>评分/);
      assert.match(facts[0], /<span>评分[\s\S]*<span>回合/);
      assert.match(facts[1], /<span>评分[\s\S]*<span>回合/);
      const css = await readFile(new URL("../css/history.css", import.meta.url), "utf8");
      assert.match(css, /\.history-journey-facts i\.is-placeholder\s*\{[^}]*visibility:\s*hidden/s);
    } finally {
      await fixture.cleanup();
    }
  });
}
