import assert from "node:assert/strict";
import { getBadgeTierFromExperience } from "../js/adapters/ui/PresentationMetadata.js";
import { experienceBadgeTemplate, experienceProgressTemplate } from "../js/ui/templates.js";
import { MatchMvpResultView } from "../js/ui/results/MatchMvpResultView.js";
import { NetworkGameView } from "../js/ui/network/NetworkGameView.js";
import { NetworkSession } from "../js/network/NetworkSession.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryArchiveView } from "../js/ui/history/HistoryArchiveView.js";
import { UIManager } from "../js/ui/UIManager.js";
import { HistoryStatsManager, isValidUsername, normalizeUsername } from "../js/ui/history/HistoryStatsManager.js";

const TIER_NAMES = /青铜|白银|黄金|钻石|史诗|王者|传奇/;

/*
功能
构造已经具有正式胜负与 MVP 事实的最小结果。

调用方
经验累计测试。

输入
gameId、胜负与 MVP。

输出
真人终局行与对局身份。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不启动 AI 或模拟对局，不重新评分。
*/
function result(gameId, won = true, isMvp = false) {
  return { gameId, players: [{ playerId: "human", characterId: "blade-walker", characterName: "刃行者",
    teamId: "dawn", teammateCharacterIds: [], finalScore: 10, effectiveRounds: 2, won, isMvp }] };
}

/*
功能
提供可重建 Manager 的 JSON 存储替身。

调用方
经验事务、并发与旧档兼容测试。

输入
可选旧档案。

输出
存储适配器与故障开关。

读取状态
测试内序列化档案。

写入状态
仅测试内存。

调用函数
JSON.stringify。

边界与不变量
写入失败时保留旧 JSON；真实文件重读另由历史档案测试覆盖。
*/
function storageFixture(initial = { version: 1, profile: { username: "旅者", experience: 0, experienceMigrationVersion: 1 } }) {
  return {
    json: JSON.stringify(initial), fail: false, writes: 0,
    async read() { return this.json; },
    async write(json) {
      if (this.fail) throw new Error("写盘失败");
      this.json = json;
      this.writes += 1;
    }
  };
}

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
验证历史档案的连续胜场累计、重读与旧存档初始化。

调用方
registerHistoryStatsTests 的连胜回归测试。

输入
无；测试使用临时文件存储与固定终局序列。

输出
无返回值；断言失败时抛出异常。

读取状态
HistoryStatsManager 的 summary 与 history_data.json。

写入状态
临时历史文件中的连续胜场字段。

调用函数
HistoryStatsManager.recordMatchResult、getArchiveData、initialize、writeFile。

边界与不变量
currentWinStreak 只表示最近连续胜场；maxWinStreak 只增不减；旧档案缺字段时从零安全开始累计。
*/
async function historyWinStreakPersistenceAndCompatibility() {
  const fixture = await createHistoryFixture();
  try {
    const manager = new HistoryStatsManager({ storage: fixture.storage });
    const sequence = [true, true, false, true, true, true, false, true];
    const checkpoints = [];
    for (const [index, won] of sequence.entries()) {
      const archive = await manager.recordMatchResult(matchResult({
        gameId: `history-streak-${index}`,
        won,
        isMvp: false
      }), "human");
      checkpoints.push([archive.summary.currentWinStreak, archive.summary.maxWinStreak]);
    }
    assert.deepEqual(checkpoints, [[1, 1], [2, 2], [0, 2], [1, 2], [2, 2], [3, 3], [0, 3], [1, 3]]);
    const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
    assert.equal(persisted.summary.currentWinStreak, 1);
    assert.equal(persisted.summary.maxWinStreak, 3);

    const reopened = new HistoryStatsManager({ storage: createFileStorage(fixture.filePath) });
    const reopenedArchive = await reopened.getArchiveData();
    assert.equal(reopenedArchive.summary.currentWinStreak, 1);
    assert.equal(reopenedArchive.summary.maxWinStreak, 3);

    await writeFile(fixture.filePath, JSON.stringify({
      version: 1,
      summary: {
        totalMatches: 2, wins: 2, losses: 0, mvpCount: 0,
        highestScore: 0, highestRounds: 0, totalScore: 0, totalRounds: 0
      },
      characters: {},
      teams: {},
      records: []
    }), "utf8");
    const legacyManager = new HistoryStatsManager({ storage: createFileStorage(fixture.filePath) });
    const legacyArchive = await legacyManager.initialize();
    assert.equal(legacyArchive.summary.currentWinStreak, 0);
    assert.equal(legacyArchive.summary.maxWinStreak, 0);
    const migratedArchive = await legacyManager.recordMatchResult(matchResult({ gameId: "history-legacy-win" }), "human");
    assert.equal(migratedArchive.summary.currentWinStreak, 1);
    assert.equal(migratedArchive.summary.maxWinStreak, 1);
  } finally {
    await fixture.cleanup();
  }
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
for (const [matches, dawn, dusk, mvp, expected] of [
    [0, 0, 0, 0, 0], [10, 0, 0, 0, 50], [10, 6, 0, 0, 80],
    [10, 3, 3, 2, 100], [80, 22, 18, 15, 750]
  ]) {
    test(`UI·经验迁移：累计 ${matches} 场 ${dawn}+${dusk} 胜 ${mvp} MVP 得到 ${expected} EXP`, async () => {
      const storage = storageFixture({ version: 1, summary: { totalMatches: matches, mvpCount: mvp, wins: 999, winRate: 99 },
        teams: { dawn: { matches, wins: dawn }, dusk: { matches, wins: dusk } }, records: [] });
      const manager = new HistoryStatsManager({ storage });
      const archive = await manager.initialize();
      assert.equal(archive.experience, expected);
      assert.equal(manager.getExperienceProgress().afterExp, expected);
      assert.equal(JSON.parse(storage.json).profile.experience, expected);
      assert.equal(JSON.parse(storage.json).profile.experienceMigrationVersion, 1);
      assert.equal(storage.writes, 1);
      await manager.getArchiveData();
      const restarted = new HistoryStatsManager({ storage });
      await restarted.initialize();
      assert.equal(restarted.getExperienceProgress().afterExp, expected);
      assert.equal(storage.writes, 1);
    });
  }

  for (const experience of [undefined, 0, 20, 900]) {
    test(`UI·经验迁移：无版本的 ${experience ?? "缺失"} EXP 以历史总值赋值且保留已有凭据`, async () => {
      const settlements = [{ gameId: "already-counted", gained: 20 }];
      const source = { version: 1, profile: { username: "旅者", experience, experienceSettlements: settlements, custom: { color: "red" } },
        summary: { totalMatches: 80, mvpCount: 15, wins: 40 },
        teams: { dawn: { matches: 40, wins: 22 }, dusk: { matches: 40, wins: 18 } },
        characters: { preserved: { matches: 3 } }, achievements: { completedMatches: 80, custom: "keep" }, records: [{ custom: "keep" }] };
      const storage = storageFixture(source);
      const before = JSON.parse(storage.json);
      const manager = new HistoryStatsManager({ storage });
      await manager.initialize();
      const after = JSON.parse(storage.json);
      assert.deepEqual(after, { ...before, profile: { ...before.profile, experience: 750, experienceMigrationVersion: 1 } });
      assert.deepEqual(manager.data.profile.experienceSettlements, settlements);
      assert.deepEqual(manager.data.profile.custom, { color: "red" });
      await manager.recordMatchResult(result("already-counted", true, true), "human");
      assert.equal(manager.getExperienceProgress().afterExp, 750, "历史已包含 settlement，不再次加经验");
      await manager.recordMatchResult(result("new", false, true), "human");
      assert.equal(manager.getExperienceProgress().afterExp, 765);
      const writes = storage.writes;
      await manager.recordMatchResult(result("network", true, true), "human", "network");
      assert.equal(manager.getExperienceProgress().afterExp, 765);
      assert.equal(storage.writes, writes);
      assert.deepEqual(JSON.parse(storage.json).profile.custom, { color: "red" });
    });
  }

  test("UI·经验迁移：版本一的合法零经验不按累计值再次迁移", async () => {
    const storage = storageFixture({ profile: { experience: 0, experienceMigrationVersion: 1 }, summary: { totalMatches: 10 } });
    const manager = new HistoryStatsManager({ storage });
    await manager.initialize();
    assert.equal(manager.getExperienceProgress().afterExp, 0);
    assert.equal(storage.writes, 0);
  });

  test("UI·经验迁移：保存等待与失败均不发布未落盘经验，重试成功才提交", async () => {
    const storage = storageFixture({ profile: { username: "旅者" }, summary: { totalMatches: 10 } });
    const original = storage.json;
    let rejectWrite;
    let enteredWrite;
    const started = new Promise((resolve) => { enteredWrite = resolve; });
    const write = storage.write.bind(storage);
    storage.write = () => {
      enteredWrite();
      return new Promise((resolve, reject) => { rejectWrite = reject; });
    };
    const manager = new HistoryStatsManager({ storage });
    const pending = manager.initialize();
    await started;
    assert.equal(manager.data, null);
    assert.equal(manager.getExperienceProgress().afterExp, 0);
    rejectWrite(new Error("迁移写盘失败"));
    await assert.rejects(pending, /迁移写盘失败/);
    assert.equal(manager.data, null);
    assert.equal(storage.json, original);
    storage.write = write;
    await manager.initialize();
    assert.equal(manager.getExperienceProgress().afterExp, 50);
    assert.equal(storage.writes, 1);
  });

  test("UI·经验迁移：条件创建冲突读取旧档后仍先迁移再提交内存", async () => {
    const storage = storageFixture({ summary: { totalMatches: 10, mvpCount: 2 }, teams: { dawn: { matches: 10, wins: 6 } } });
    let reads = 0;
    const read = storage.read.bind(storage);
    storage.read = async () => ++reads === 1 ? null : read();
    storage.create = async () => false;
    const manager = new HistoryStatsManager({ storage });
    await manager.initialize();
    assert.equal(manager.getExperienceProgress().afterExp, 100);
    assert.equal(JSON.parse(storage.json).profile.experienceMigrationVersion, 1);
  });

  test("UI·经验迁移：档案总览内部立即显示迁移经验且入房读取相同值", async () => {
    const storage = storageFixture({ summary: { totalMatches: 80, mvpCount: 15 },
      teams: { dawn: { matches: 40, wins: 22 }, dusk: { matches: 40, wins: 18 } } });
    const manager = new HistoryStatsManager({ storage });
    const root = { innerHTML: "", addEventListener() {} };
    const view = new HistoryArchiveView(root, manager, () => {});
    await view.show();
    const overview = root.innerHTML.match(/<section class="history-overview"[\s\S]*?<\/section>/)?.[0];
    assert.ok(overview);
    assert.match(overview, /征途总览/);
    assert.match(overview, /history-experience-row/);
    assert.match(overview, /data-badge-tier="gold"/);
    assert.match(overview, /experience-existing" style="width:50%/);
    assert.match(overview, /750 EXP/);
    assert.ok(overview.indexOf('class="history-experience-row"') > overview.indexOf("最长战斗"));
    assert.equal((root.innerHTML.match(/history-experience-row/g) ?? []).length, 1);
    assert.doesNotMatch(root.innerHTML, /<section[^>]*(?:experience|经验)|本局 \+|experience-gain/);
    assert.doesNotMatch(root.innerHTML, TIER_NAMES);
    const session = new NetworkSession({ getExperience: () => manager.getExperienceProgress().afterExp });
    try {
      await session.open("HOST");
      const snapshot = session.snapshot();
      assert.equal(snapshot.participants[snapshot.participantId].experience, 750);
    } finally { session.close(); }
  });

  test("UI·经验徽章：最高阶满条保留真实总 EXP 且不产生无穷或等级文字", () => {
    for (const overview of [false, true]) {
      const markup = experienceProgressTemplate({ afterExp: 12750, gained: 20, overview });
      assert.match(markup, /data-badge-tier="legend"/);
      assert.match(markup, /width:100%/);
      assert.match(markup, /12750 EXP/);
      assert.doesNotMatch(markup, /Infinity|NaN|undefined/);
      assert.doesNotMatch(markup, TIER_NAMES);
      if (overview) assert.doesNotMatch(markup, /本局|experience-gain/);
    }
  });

  test("UI·经验徽章：所有 UI renderer 与 CSS 不输出等级文字或把内部 tier 字段作为标签", async () => {
    const uiFiles = await readdir(new URL("../js/ui/", import.meta.url), { recursive: true });
    const cssFiles = await readdir(new URL("../css/", import.meta.url));
    const assets = await readdir(new URL("../assets/", import.meta.url), { recursive: true });
    for (const file of [...uiFiles.filter((file) => file.endsWith(".js")).map((file) => `js/ui/${file}`),
      ...cssFiles.filter((file) => file.endsWith(".css")).map((file) => `css/${file}`),
      ...assets.filter((file) => file.endsWith(".svg")).map((file) => `assets/${file}`), "index.html"]) {
      const source = await readFile(new URL(`../${file.replaceAll("\\", "/")}`, import.meta.url), "utf8");
      const production = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/<!--[\s\S]*?-->/g, "");
      assert.doesNotMatch(production, TIER_NAMES, file);
      assert.doesNotMatch(production, /\$\{(?:tier|badgeTier)\.(?:name|label)\}|(?:textContent|innerHTML)\s*=\s*(?:tier|badgeTier)\.(?:name|label)/, file);
      assert.doesNotMatch(production, /content\s*:\s*attr\(data-(?:badge-tier|tier|label)\)/, file);
    }
  });

  for (const [exp, id] of [[0, "bronze"], [99, "bronze"], [100, "silver"], [499, "silver"],
    [500, "gold"], [999, "gold"], [1000, "diamond"], [1999, "diamond"], [2000, "epic"],
    [4999, "epic"], [5000, "king"], [9999, "king"], [10000, "legend"]]) {
    test(`UI·经验徽章：${exp} 经验使用 ${id} 图案且无等级文字`, () => {
      assert.equal(getBadgeTierFromExperience(exp).id, id);
      const badge = experienceBadgeTemplate(exp);
      assert.match(badge, new RegExp(`data-badge-tier="${id}"`));
      assert.match(badge, /<svg/);
      assert.match(badge, /aria-label="经验徽章"/);
      assert.match(badge, new RegExp(`title="${exp} EXP"`));
      assert.doesNotMatch(badge, TIER_NAMES);
      for (const overview of [false, true]) assert.doesNotMatch(experienceProgressTemplate({ afterExp: exp, overview }), TIER_NAMES);
    });
  }

  for (const [mode, won, mvp, gained] of [
    ["singleplayer", true, false, 10], ["singleplayer", false, false, 5],
    ["singleplayer", true, true, 20], ["singleplayer", false, true, 15],
    ["network", true, false, 0], ["network", false, false, 0],
    ["network", true, true, 0], ["network", false, true, 0]
  ]) {
    test(`UI·经验徽章：${mode} ${won ? "胜利" : "失败"}${mvp ? " MVP" : ""} 结算 +${gained}`, async () => {
      const storage = storageFixture();
      const manager = new HistoryStatsManager({ storage });
      await manager.recordMatchResult(result("match", won, mvp), "human", mode);
      assert.deepEqual(manager.getExperienceProgress("match"), { afterExp: gained, gained });
      const reloaded = new HistoryStatsManager({ storage });
      await reloaded.initialize();
      assert.equal(reloaded.getExperienceProgress().afterExp, gained);
      if (mode === "network") assert.equal(storage.writes, 0);
    });
  }

  test("UI·经验徽章：新档默认零且同局并发、重读和最近记录裁剪均不重复加经验", async () => {
    const storage = storageFixture();
    const manager = new HistoryStatsManager({ storage });
    await manager.initialize();
    assert.deepEqual(manager.getExperienceProgress(), { afterExp: 0, gained: 0 });
    await Promise.all([manager.recordMatchResult(result("first"), "human"), manager.recordMatchResult(result("first"), "human")]);
    assert.equal(manager.getExperienceProgress().afterExp, 10);
    for (let index = 0; index < 11; index += 1) await manager.recordMatchResult(result(`later-${index}`), "human");
    const reloaded = new HistoryStatsManager({ storage });
    await reloaded.recordMatchResult(result("first"), "human");
    assert.deepEqual(reloaded.getExperienceProgress("first"), { afterExp: 120, gained: 10 });
    assert.equal(JSON.parse(storage.json).profile.experienceSettlements.length, 12);
  });

  test("UI·经验徽章：写盘失败不刷新经验或凭据且重试只加一次", async () => {
    const storage = storageFixture();
    const manager = new HistoryStatsManager({ storage });
    await manager.initialize();
    storage.fail = true;
    await assert.rejects(manager.recordMatchResult(result("retry", false, true), "human"), /写盘失败/);
    assert.deepEqual(manager.getExperienceProgress("retry"), { afterExp: 0, gained: 0 });
    assert.equal(JSON.parse(storage.json).profile.experience, 0);
    storage.fail = false;
    await manager.recordMatchResult(result("retry", false, true), "human");
    await manager.recordMatchResult(result("retry", false, true), "human");
    assert.deepEqual(manager.getExperienceProgress("retry"), { afterExp: 15, gained: 15 });
  });

  test("UI·经验徽章：MVP 页底部显示总经验、本局增量和蓝色推进且重复渲染不写盘", async () => {
    const storage = storageFixture({ profile: { experience: 300, experienceMigrationVersion: 1 } });
    const manager = new HistoryStatsManager({ storage });
    await manager.recordMatchResult(result("mvp", true, true), "human");
    const root = { innerHTML: "", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
    const view = new MatchMvpResultView(root);
    const model = { players: [{ ...result("mvp").players[0], primaryName: "旅者", rank: 1 }], defaultSelectedPlayerId: "human" };
    const writes = storage.writes;
    view.render(model, "human", "", manager.getExperienceProgress("mvp"));
    view.render(model, "human", "", manager.getExperienceProgress("mvp"));
    assert.equal(storage.writes, writes);
    assert.match(root.innerHTML, /当前经验 320 EXP/);
    assert.match(root.innerHTML, /本局 \+20 EXP/);
    assert.match(root.innerHTML, /data-badge-tier="silver"/);
    assert.doesNotMatch(root.innerHTML, TIER_NAMES);
    assert.match(root.innerHTML, /experience-existing" style="width:50%/);
    assert.match(root.innerHTML, /experience-gain" style="left:50%;width:5%/);
    assert.ok(root.innerHTML.indexOf('class="match-experience"') > root.innerHTML.indexOf("data-match-performance-detail"));
    assert.match(experienceProgressTemplate({ afterExp: 105, gained: 10 }), /left:0%;width:1.25%/);
    assert.match(experienceProgressTemplate({ afterExp: 10020, gained: 20 }), /10020 EXP/);
    assert.doesNotMatch(experienceProgressTemplate({ afterExp: 500, gained: 0 }), /experience-gain/);
  });

  test("UI·经验徽章：单人战场只给本地玩家显示档案徽章", () => {
    const player = { id: "local", name: "刃行者", battleTeam: "dawn", hand: [], alive: true, hp: 3, energy: 1, statuses: {} };
    const ui = { elements: { cpu_grid: { innerHTML: "" }, human_panel: { innerHTML: "" }, status_metrics: { innerHTML: "" } },
      historyStatsManager: { getExperienceProgress: () => ({ afterExp: 500 }) } };
    UIManager.prototype.renderBattlefield.call(ui, { gameId: "single", metrics: [], opponents: [{ player: { ...player, id: "ai" }, options: {} }], self: { player, options: { isHuman: true } } });
    assert.match(ui.elements.human_panel.innerHTML, /data-badge-tier="gold"/);
    assert.doesNotMatch(ui.elements.human_panel.innerHTML, TIER_NAMES);
    assert.doesNotMatch(ui.elements.cpu_grid.innerHTML, /experience-badge/);
  });

  test("UI·经验徽章：Guest 结果页读取本地总经验且不继承 Host 本局增量", () => {
    const calls = [];
    const ui = { historyStatsManager: { getExperienceProgress: () => ({ afterExp: 500, gained: 0 }) },
      matchMvpResultView: { render: (...args) => calls.push(args) }, animationController: { flush() {} } };
    NetworkGameView.prototype.presentEvent.call({ ui, players: [], projection: { viewerId: "guest" } }, { kind: "result", result: {} });
    assert.deepEqual(calls[0], [{}, "guest", "", { afterExp: 500, gained: 0 }]);
  });

  test("UI·历史档案：单人经验写入文件后重启保留且旧局重放不重复累加", async () => {
    const fixture = await createHistoryFixture();
    try {
      await writeFile(fixture.filePath, JSON.stringify({ version: 1, profile: { username: "旅者", experience: 0 },
        summary: { totalMatches: 80, mvpCount: 15 },
        teams: { dawn: { matches: 40, wins: 22 }, dusk: { matches: 40, wins: 18 } } }), "utf8");
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.initialize();
      assert.equal(manager.getExperienceProgress().afterExp, 750);
      const migrated = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(migrated.profile.experience, 750);
      assert.equal(migrated.profile.experienceMigrationVersion, 1);
      await manager.recordMatchResult(matchResult({ gameId: "experience-file", won: true, isMvp: true }), "human", "singleplayer");
      assert.equal(JSON.parse(await readFile(fixture.filePath, "utf8")).profile.experience, 770);
      const reloaded = new HistoryStatsManager({ storage: fixture.storage });
      await reloaded.initialize();
      assert.deepEqual(reloaded.getExperienceProgress("experience-file"), { afterExp: 770, gained: 20 });
      await reloaded.recordMatchResult(matchResult({ gameId: "experience-file", won: true, isMvp: true }), "human", "singleplayer");
      assert.equal(JSON.parse(await readFile(fixture.filePath, "utf8")).profile.experience, 770);
      await reloaded.recordMatchResult(matchResult({ gameId: "experience-next", won: false, isMvp: false }), "human", "singleplayer");
      assert.equal(reloaded.getExperienceProgress().afterExp, 775);
    } finally { await fixture.cleanup(); }
  });

  test("UI·历史档案：首次启动自动创建 version 1 JSON", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      const archive = await manager.initialize();
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(archive.version, 1);
      assert.deepEqual({ ...persisted, achievements: {
        companions: persisted.achievements.companions,
        highestSingleMatchDamage: persisted.achievements.highestSingleMatchDamage,
        highestSingleMatchKills: persisted.achievements.highestSingleMatchKills,
        highestSingleMatchSupport: persisted.achievements.highestSingleMatchSupport,
        highestSingleMatchDamageTaken: persisted.achievements.highestSingleMatchDamageTaken
      } }, {
        version: 1,
        profile: { username: "", experience: 0, experienceSettlements: [], experienceMigrationVersion: 1 },
        summary: {
          totalMatches: 0, wins: 0, losses: 0, mvpCount: 0,
          highestScore: 0, highestRounds: 0, totalScore: 0, totalRounds: 0,
          currentWinStreak: 0, maxWinStreak: 0
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
      profile: { experienceMigrationVersion: 1 },
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
        highestScore: 420, highestRounds: 8, totalScore: 420, totalRounds: 8,
        currentWinStreak: 1, maxWinStreak: 1
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
        highestScore: 420, highestRounds: 8, totalScore: 695, totalRounds: 14,
        currentWinStreak: 0, maxWinStreak: 1, winRate: 50
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

  test("UI·历史档案：连续胜场按终局序列累计并兼容缺少字段的旧存档", historyWinStreakPersistenceAndCompatibility);

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
      assert.deepEqual({
        mostFrequentCompanion: archive.achievements.mostFrequentCompanion,
        highestSingleMatchDamage: archive.achievements.highestSingleMatchDamage,
        highestSingleMatchKills: archive.achievements.highestSingleMatchKills,
        highestSingleMatchSupport: archive.achievements.highestSingleMatchSupport,
        highestSingleMatchDamageTaken: archive.achievements.highestSingleMatchDamageTaken
      }, {
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
      assert.deepEqual({
        mostFrequentCompanion: archive.achievements.mostFrequentCompanion,
        highestSingleMatchDamage: archive.achievements.highestSingleMatchDamage,
        highestSingleMatchKills: archive.achievements.highestSingleMatchKills,
        highestSingleMatchSupport: archive.achievements.highestSingleMatchSupport,
        highestSingleMatchDamageTaken: archive.achievements.highestSingleMatchDamageTaken
      }, {
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
      const honorStart = root.innerHTML.indexOf('<div class="history-honor-grid">');
      const honorEnd = root.innerHTML.indexOf('<section class="history-section history-journeys"');
      const honorMarkup = root.innerHTML.slice(honorStart, honorEnd);
      const honorLabels = [...honorMarkup.matchAll(/<span>([^<]+)<\/span><strong>/g)].map((match) => match[1]);
      assert.deepEqual(honorLabels.slice(0, 3), ["最常同行", "单局最高伤害", "最多连胜场数"]);
      assert.doesNotMatch(root.innerHTML, /单局最高击杀/);
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
      await manager.recordMatchResult(matchResult({ gameId: "history-mvp", effectiveRounds: 11, isMvp: true }), "human");
      await manager.recordMatchResult(matchResult({ gameId: "history-no-mvp", effectiveRounds: 3, isMvp: false }), "human");
      const root = { innerHTML: "", addEventListener() {} };
      const view = new HistoryArchiveView(root, manager, () => {});
      await view.show();

      const facts = [...root.innerHTML.matchAll(/<div class="history-journey-facts">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
      assert.equal(facts.length, 2);
      assert.match(facts[0], /<i class="history-journey-mvp is-placeholder" aria-hidden="true">MVP<\/i><span class="history-journey-score">评分/);
      assert.match(facts[1], /<i class="history-journey-mvp">MVP<\/i><span class="history-journey-score">评分/);
      assert.match(facts[0], /history-journey-score[\s\S]*history-journey-rounds">回合 <b>3<\/b>/);
      assert.match(facts[1], /history-journey-score[\s\S]*history-journey-rounds">回合 <b>11<\/b>/);
      const css = await readFile(new URL("../css/history.css", import.meta.url), "utf8");
      assert.match(css, /\.history-journey-facts\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*32px 58px 48px;[^}]*justify-self:\s*end/s);
      assert.match(css, /\.history-journey-score,\s*\.history-journey-rounds\s*\{[^}]*width:\s*100%/s);
      assert.match(css, /\.history-journey-facts b\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
      assert.match(css, /\.history-journey-facts i\.is-placeholder\s*\{[^}]*visibility:\s*hidden/s);
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：旧档无 profile 时判定需要填写用户名而合法 username 直接读取", async () => {
    const fixture = await createHistoryFixture();
    try {
      const legacy = {
        version: 1,
        summary: {
          totalMatches: 3, wins: 2, losses: 1, mvpCount: 1,
          highestScore: 200, highestRounds: 5, totalScore: 400, totalRounds: 12,
          currentWinStreak: 1, maxWinStreak: 2
        },
        characters: { "blade-walker": { matches: 3, wins: 2, winRate: 66.7, mvpCount: 1, highestScore: 200, totalScore: 400 } },
        teams: { dawn: { matches: 3, wins: 2, winRate: 66.7 } },
        achievements: {},
        records: [{ timestamp: "2026-09-01T00:00:00.000Z", characterId: "blade-walker", characterName: "刃行者", teamId: "dawn", teammateCharacterIds: [], won: true, score: 200, rounds: 5, isMvp: true }]
      };
      await writeFile(fixture.filePath, JSON.stringify(legacy), "utf8");
      const legacyManager = new HistoryStatsManager({ storage: fixture.storage });
      await legacyManager.initialize();
      assert.equal(legacyManager.getUsername(), null);
      assert.equal(legacyManager.hasUsername(), false);

      await writeFile(fixture.filePath, JSON.stringify({ ...legacy, profile: { username: "lelexia" } }), "utf8");
      const existingManager = new HistoryStatsManager({ storage: fixture.storage });
      await existingManager.initialize();
      assert.equal(existingManager.getUsername(), "lelexia");
      assert.equal(existingManager.hasUsername(), true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：保存 username 保留 records、stats 与 achievements", async () => {
    const fixture = await createHistoryFixture();
    try {
      let minute = 0;
      const manager = new HistoryStatsManager({
        storage: fixture.storage,
        now: () => new Date(Date.UTC(2026, 8, 1, 8, minute++, 0))
      });
      await manager.recordMatchResult(matchResult({ isMvp: true }), "human");
      const before = JSON.parse(await readFile(fixture.filePath, "utf8"));

      assert.equal(await manager.saveUsername("  lelexia  "), "lelexia");
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.deepEqual(persisted.profile, { ...before.profile, username: "lelexia" });
      for (const key of ["version", "summary", "characters", "teams", "achievements", "records"]) {
        assert.deepEqual(persisted[key], before[key], `${key} 不得被 username 保存覆盖`);
      }

      await manager.recordMatchResult(matchResult({ gameId: "history-after-username" }), "human");
      const afterMatch = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(afterMatch.profile.username, "lelexia");
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：保存 username 失败不进入主界面且内存 username 保持未设置", async () => {
    const existing = JSON.stringify({
      version: 1,
      profile: { experienceMigrationVersion: 1 },
      summary: {
        totalMatches: 0, wins: 0, losses: 0, mvpCount: 0,
        highestScore: 0, highestRounds: 0, totalScore: 0, totalRounds: 0
      },
      characters: {}, teams: {}, records: []
    });
    const storage = createUnsupportedWriteStorage(existing);
    const manager = new HistoryStatsManager({ storage });
    await manager.initialize();
    await assert.rejects(manager.saveUsername("lelexia"), /HTTP 501/);
    assert.equal(manager.hasUsername(), false);
    assert.equal(manager.getUsername(), null);
    assert.equal(await storage.read(), existing);

    let enteredMain = false;
    try {
      await manager.saveUsername("lelexia");
      enteredMain = true;
    } catch {
      // 保存失败必须停留在填写页，主界面入口不能执行。
    }
    assert.equal(enteredMain, false);
  });

  test("UI·历史档案：username 校验 trim 长度空白与控制字符且不写非法值", async () => {
    assert.equal(normalizeUsername("  lelexia  "), "lelexia");
    assert.equal(normalizeUsername("a".repeat(20)), "a".repeat(20));
    assert.equal(normalizeUsername("a".repeat(21)), "");
    assert.equal(normalizeUsername("　　"), "");
    assert.equal(normalizeUsername("alice\n"), "alice");
    assert.equal(normalizeUsername("ali\u0000ce"), "");
    assert.equal(normalizeUsername("ali\u009Fce"), "");
    assert.equal(isValidUsername(" "), false);
    assert.equal(isValidUsername(null), false);

    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.initialize();
      await assert.rejects(manager.saveUsername("   "), /用户名/);
      await assert.rejects(manager.saveUsername("bad\u0000name"), /用户名/);
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(persisted.profile.username, "");
      assert.equal(manager.hasUsername(), false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：保存 username 等待真实落盘完成前不更新内存", async () => {
    const fixture = await createHistoryFixture();
    try {
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      await manager.initialize();

      let releaseWrite;
      let writeStarted = false;
      const originalStorage = manager.storage;
      manager.storage = {
        read: (...args) => originalStorage.read(...args),
        write: async (json) => {
          writeStarted = true;
          await new Promise((resolve) => { releaseWrite = resolve; });
          await originalStorage.write(json);
        }
      };

      const pending = manager.saveUsername("lelexia");
      assert.equal(writeStarted, true);
      assert.equal(manager.hasUsername(), false);
      releaseWrite();
      assert.equal(await pending, "lelexia");
      assert.equal(manager.hasUsername(), true);
      assert.equal(JSON.parse(await readFile(fixture.filePath, "utf8")).profile.username, "lelexia");
    } finally {
      await fixture.cleanup();
    }
  });


  test("UI·历史档案：无合法 username 展示用户名填写页且不泄露历史内容", () => {
    const makeClassList = () => {
      const values = new Set();
      return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name)
      };
    };
    const usernameScreen = { classList: makeClassList() };
    const startScreen = { classList: makeClassList() };
    const usernameError = { textContent: "", classList: { toggle: (name, value) => {
      if (name === "is-hidden" && value) usernameError.hidden = true;
      if (name === "is-hidden" && !value) usernameError.hidden = false;
    } } };
    let focused = false;
    const usernameInput = { disabled: false, focus: () => { focused = true; } };
    const usernameSubmit = { disabled: false, textContent: "继续" };
    const context = {
      usernamePending: false,
      elements: {
        username_screen: usernameScreen, start_screen: startScreen,
        username_error: usernameError, username_input: usernameInput, username_submit: usernameSubmit,
        username_form: { reset() {} }
      },
      sound: { playMenuMusic() {} },
      setUsernameError: UIManager.prototype.setUsernameError,
      setUsernamePending: UIManager.prototype.setUsernamePending
    };

    UIManager.prototype.showUsernameSetup.call(context);
    assert.equal(usernameScreen.classList.contains("is-hidden"), false);
    assert.equal(startScreen.classList.contains("is-hidden"), true);
    assert.equal(focused, true);
    assert.equal(context.usernamePending, false);
    assert.equal(usernameError.textContent, "");

    UIManager.prototype.setUsernameError.call(context, "用户名保存失败，请重试。");
    assert.equal(usernameError.textContent, "用户名保存失败，请重试。");
    assert.equal(usernameError.hidden, false);
    UIManager.prototype.setUsernamePending.call(context, true);
    assert.equal(usernameInput.disabled, true);
    assert.equal(usernameSubmit.disabled, true);
    assert.equal(context.usernamePending, true);
  });

  test("UI·历史档案：首次启动用户名提交恢复 saveUsername、setDisplayName 与 showStart 链路", async () => {
    const mainSource = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
    const extractFunctionSource = (name) => {
      const match = mainSource.match(
        new RegExp(`(?:async\\s+)?function\\s+${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`)
      );
      assert.ok(match, `main.js 缺少 ${name}`);
      return match[0];
    };
    const makeHarness = (manager) => {
      const uiEvents = [];
      const displayNames = [];
      const ui = {
        setUsernamePending(value) { uiEvents.push(["pending", value]); },
        setUsernameError(message) { uiEvents.push(["error", message]); },
        showUsernameSetup() { uiEvents.push(["showSetup"]); },
        showStart() { uiEvents.push(["showStart"]); }
      };
      const networkFlow = { session: { setDisplayName(value) { displayNames.push(value); } } };
      const debug = { log() {} };
      const factory = new Function(
        "networkFlow", "ui", "historyStatsManager", "Debug",
        `${extractFunctionSource("enterMain")}\n${extractFunctionSource("submitUsername")}\n${extractFunctionSource("bootstrap")}\nreturn { bootstrap, submitUsername };`
      );
      const { bootstrap, submitUsername } = factory(networkFlow, ui, manager, debug);
      return { bootstrap, submitUsername, uiEvents, displayNames };
    };
    const legacy = {
      version: 1,
      summary: {
        totalMatches: 1, wins: 1, losses: 0, mvpCount: 0,
        highestScore: 100, highestRounds: 3, totalScore: 100, totalRounds: 3,
        currentWinStreak: 1, maxWinStreak: 1
      },
      characters: {}, teams: {}, achievements: {},
      records: [{ timestamp: "2026-09-01T00:00:00.000Z", characterId: "blade-walker", characterName: "刃行者", teamId: "dawn", teammateCharacterIds: [], won: true, score: 100, rounds: 3, isMvp: false }]
    };

    const fixture = await createHistoryFixture();
    try {
      await writeFile(fixture.filePath, JSON.stringify(legacy), "utf8");
      const manager = new HistoryStatsManager({ storage: fixture.storage });
      let saveCalls = 0;
      const originalSaveUsername = manager.saveUsername.bind(manager);
      manager.saveUsername = async (value) => {
        saveCalls += 1;
        return originalSaveUsername(value);
      };
      const harness = makeHarness(manager);

      await harness.bootstrap();
      assert.deepEqual(harness.uiEvents, [["showSetup"]]);

      await harness.submitUsername("lelexia");
      assert.equal(saveCalls, 1, "submitUsername 不得在 usernamePending 之外提前 return");
      assert.deepEqual(harness.displayNames, ["lelexia"]);
      assert.equal(harness.uiEvents.some(([name]) => name === "showStart"), true);
      assert.equal(harness.uiEvents.at(-1)[0], "showStart");
      assert.equal(harness.uiEvents.some(([name]) => name === "error"), false);
      assert.equal(manager.hasUsername(), true);
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8"));
      assert.equal(persisted.profile.username, "lelexia");
      assert.equal(persisted.summary.totalMatches, 1);
      assert.equal(persisted.records.length, 1);
    } finally {
      await fixture.cleanup();
    }

    const existing = JSON.stringify({
      version: 1,
      profile: { experienceMigrationVersion: 1 },
      summary: {
        totalMatches: 1, wins: 1, losses: 0, mvpCount: 0,
        highestScore: 100, highestRounds: 3, totalScore: 100, totalRounds: 3,
        currentWinStreak: 1, maxWinStreak: 1
      },
      characters: {}, teams: {}, achievements: {}, records: []
    });
    const failedManager = new HistoryStatsManager({ storage: createUnsupportedWriteStorage(existing) });
    const failedHarness = makeHarness(failedManager);

    await failedHarness.bootstrap();
    assert.deepEqual(failedHarness.uiEvents, [["showSetup"]]);

    await failedHarness.submitUsername("lelexia");
    assert.deepEqual(failedHarness.displayNames, [], "保存失败不得设置 displayName");
    assert.equal(failedHarness.uiEvents.some(([name]) => name === "showStart"), false, "保存失败不得进入主界面");
    assert.equal(failedHarness.uiEvents.some(([name, value]) => name === "error" && /HTTP 501/.test(value)), true);
    assert.equal(failedHarness.uiEvents.at(-1)[0], "pending");
    assert.equal(failedHarness.uiEvents.at(-1)[1], false);
    assert.equal(failedManager.hasUsername(), false);
  });

}
