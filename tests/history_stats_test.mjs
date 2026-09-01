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
只覆盖指定临时 JSON 文件。

调用函数
readFile、writeFile。

边界与不变量
只有 ENOENT 映射为未初始化；其他文件错误必须继续抛出。
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
    }
  };
}

/*
功能
创建模拟旧版静态服务 501 写入失败的历史存储。

调用方
历史档案降级展示与会话内累计测试。

输入
无。

输出
read 返回缺档、write 固定抛出 HTTP 501 的存储适配器。

读取状态
无。

写入状态
无。

调用函数
Error。

边界与不变量
只模拟文件写入能力缺失，不改变 Manager 的统计输入。
*/
function createUnsupportedWriteStorage() {
  return {
    async read() { return null; },
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
创建只包含最终历史写入字段的 MatchResult fixture。

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
评分、胜负、MVP 和回合已经由上游确定，Manager 只能记录不能重算。
*/
function matchResult(options = {}) {
  return {
    gameId: options.gameId ?? "history-match",
    players: [{
      playerId: "human",
      characterId: options.characterId ?? "blade-walker",
      characterName: options.characterName ?? "刃行者",
      teamId: options.teamId ?? "dawn",
      won: options.won ?? true,
      finalScore: options.finalScore ?? 420,
      effectiveRounds: options.effectiveRounds ?? 8,
      isMvp: options.isMvp ?? true
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
        records: []
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("UI·历史档案：旧服务不支持写入时仍展示零记录卷册且不暴露 HTTP 错误", async () => {
    const manager = new HistoryStatsManager({ storage: createUnsupportedWriteStorage() });
    const archive = await manager.initialize();
    const root = { innerHTML: "", addEventListener() {} };
    const view = new HistoryArchiveView(root, manager, () => {});
    await view.show();
    assert.equal(archive.summary.totalMatches, 0);
    assert.match(root.innerHTML, /历史档案馆/);
    assert.match(root.innerHTML, /卷宗尚未落笔/);
    assert.doesNotMatch(root.innerHTML, /501|HTTP|保存历史档案失败|档案卷册暂时封存/);
  });

  test("UI·历史档案：写入暂不可用时仍保留本次会话终局记录", async () => {
    const manager = new HistoryStatsManager({ storage: createUnsupportedWriteStorage() });
    await manager.initialize();
    await assert.rejects(manager.recordMatchResult(matchResult(), "human"), /HTTP 501/);
    const archive = await manager.getArchiveData();
    assert.equal(archive.summary.totalMatches, 1);
    assert.equal(archive.records[0].characterName, "刃行者");
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
        won: true,
        score: 420,
        rounds: 8,
        isMvp: true
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
      assert.equal(root.innerHTML.match(/420\.0/g)?.length, 3);
      assert.doesNotMatch(root.innerHTML, /<table/i);
    } finally {
      await fixture.cleanup();
    }
  });
}
