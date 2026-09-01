/*
模块职责
唯一拥有历史档案馆页面的加载、卡牌式渲染与返回交互。

上游
UIManager 页面生命周期。

下游
HistoryStatsManager 查询接口与公开角色展示素材。

状态边界
只读取冻结历史查询对象并写入档案页 DOM。

信息边界
仅展示真人长期终局记录，不读取对局状态或隐藏信息。

架构约束
不得访问 history_data.json、计算胜率、累计统计或参与对局流程。
*/
import { CHARACTER_PRESENTATION } from "../../adapters/ui/CharacterPresentationDefinitions.js";
import { escapeHtml } from "../templates.js";

const RECENT_RECORD_LIMIT = 8;

/*
功能
把历史时间戳格式化为档案题记日期。

调用方
renderRecordCard。

输入
ISO 时间字符串。

输出
本地日期时间文本。

读取状态
浏览器中文区域格式。

写入状态
无。

调用函数
Date、Intl.DateTimeFormat。

边界与不变量
无效时间回退为“时间佚失”，不影响其余记录展示。
*/
function formatArchiveTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间佚失";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

/*
功能
将档案中的最高评分统一格式化为一位小数。

调用方
旅者档案卡、征途总览与传奇记录渲染。

输入
HistoryStatsManager 提供的最高评分数值。

输出
固定保留一位小数的展示文本。

读取状态
无。

写入状态
无。

调用函数
Number、Number.isFinite、Number.toFixed。

边界与不变量
只格式化展示，不修改 JSON 中的原始评分；非法值按 0.0 展示。
*/
function formatHighestScore(value) {
  const score = Number(value);
  return (Number.isFinite(score) ? score : 0).toFixed(1);
}

/*
功能
渲染单张旅者档案收藏卡。

调用方
HistoryArchiveView.render。

输入
Manager 提供的角色展示统计。

输出
安全 HTML 字符串。

读取状态
角色 portrait 展示元数据。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
只显示 Manager 已计算的胜率与累计值；未知素材使用空路径而不冒用其他角色。
*/
function renderCharacterCard(character) {
  const portrait = CHARACTER_PRESENTATION[character.id]?.portrait ?? "";
  return `<article class="history-traveler-card">
    <div class="history-traveler-art">
      <img src="${escapeHtml(portrait)}" alt="${escapeHtml(character.name)}角色立绘">
      <span>${escapeHtml(character.loreFaction)}</span>
    </div>
    <div class="history-traveler-copy">
      <small>TRAVELER DOSSIER</small>
      <h3>${escapeHtml(character.name)}</h3>
      <div class="history-traveler-stats">
        <span><b>${character.matches}</b>次出征</span>
        <span><b>${character.winRate}%</b>胜率</span>
        <span><b>${character.wins}</b>场胜利</span>
        <span><b>${character.mvpCount}</b>次 MVP</span>
      </div>
      <p>最高评分 <strong>${formatHighestScore(character.highestScore)}</strong></p>
    </div>
  </article>`;
}

/*
功能
渲染一张晨星或暮影阵营记录纹章。

调用方
HistoryArchiveView.render。

输入
Manager 提供的阵营统计。

输出
安全 HTML 字符串。

读取状态
无。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
阵营视觉 class 只接受 Manager 固定提供的 dawn/dusk。
*/
function renderTeamCard(team) {
  const glyph = team.id === "dawn" ? "☼" : "◒";
  return `<article class="history-faction-card is-${escapeHtml(team.id)}">
    <div class="history-faction-sigil" aria-hidden="true">${glyph}</div>
    <div><small>${team.id === "dawn" ? "DAWN COVENANT" : "DUSK COVENANT"}</small><h3>${escapeHtml(team.name)}</h3></div>
    <dl><div><dt>对局</dt><dd>${team.matches}</dd></div><div><dt>胜场</dt><dd>${team.wins}</dd></div><div><dt>胜率</dt><dd>${team.winRate}%</dd></div></dl>
  </article>`;
}

/*
功能
渲染最近征途中的一张终局记录卡。

调用方
HistoryArchiveView.render。

输入
Manager 提供的单场历史记录。

输出
安全 HTML 字符串。

读取状态
角色 portrait 展示元数据。

写入状态
无。

调用函数
formatArchiveTime、escapeHtml。

边界与不变量
胜负、评分与 MVP 均直接使用最终记录，不推导或重算。
*/
function renderRecordCard(record) {
  const portrait = CHARACTER_PRESENTATION[record.characterId]?.portrait ?? "";
  const teamName = record.teamId === "dawn" ? "晨星" : "暮影";
  return `<article class="history-journey-card is-${record.won ? "victory" : "defeat"}">
    <img src="${escapeHtml(portrait)}" alt="" aria-hidden="true">
    <div class="history-journey-main"><small>${escapeHtml(formatArchiveTime(record.timestamp))}</small><h3>${escapeHtml(record.characterName)}</h3><span class="history-team-mark is-${escapeHtml(record.teamId)}">${teamName}</span></div>
    <strong class="history-outcome">${record.won ? "凯旋" : "陨落"}</strong>
    <div class="history-journey-facts"><span>评分 <b>${record.score}</b></span><span>回合 <b>${record.rounds}</b></span>${record.isMvp ? "<i>MVP</i>" : ""}</div>
  </article>`;
}

export class HistoryArchiveView {
  /*
  功能
  创建档案馆页面并绑定返回首页交互。

  调用方
  UIManager constructor。

  输入
  页面根元素、HistoryStatsManager 与返回 callback。

  输出
  HistoryArchiveView 实例。

  读取状态
  无。

  写入状态
  保存依赖并注册根节点 click listener。

  调用函数
  handleClick。

  边界与不变量
  View 只能通过 Manager 查询数据；返回只提交页面意图。
  */
  constructor(root, historyStatsManager, onBack) {
    this.root = root;
    this.historyStatsManager = historyStatsManager;
    this.onBack = onBack;
    this.root?.addEventListener("click", (event) => this.handleClick(event));
  }

  /*
  功能
  加载最新档案并完成页面渲染。

  调用方
  UIManager.showHistoryArchive。

  输入
  无。

  输出
  渲染完成的 Promise。

  读取状态
  HistoryStatsManager 查询接口。

  写入状态
  档案页加载、成功或失败 DOM。

  调用函数
  HistoryStatsManager.getArchiveData、render、renderError。

  边界与不变量
  读取失败只能影响档案页，不得改变首页或对局状态。
  */
  async show() {
    if (!this.root || !this.historyStatsManager) return;
    this.root.innerHTML = `<div class="history-loading"><span aria-hidden="true">◇</span><strong>档案守卫正在展开卷册……</strong></div>`;
    try {
      this.render(await this.historyStatsManager.getArchiveData());
    } catch {
      this.renderError();
    }
  }

  /*
  功能
  收束档案页生命周期。

  调用方
  UIManager.hideHistoryArchive。

  输入
  无。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  历史 DOM 保留到下次刷新覆盖，返回动作不触碰数据。
  */
  hide() {}

  /*
  功能
  响应档案页返回按钮并提交一次返回首页意图。

  调用方
  root click listener。

  输入
  浏览器 click event。

  输出
  无返回值。

  读取状态
  点击目标与 onBack callback。

  写入状态
  无。

  调用函数
  Element.closest、onBack。

  边界与不变量
  非返回按钮点击不得触发页面切换。
  */
  handleClick(event) {
    if (event.target.closest("[data-history-back]")) this.onBack?.();
  }

  /*
  功能
  将完整查询对象渲染为档案大厅的徽章、收藏卡、荣誉与征途卡。

  调用方
  show。

  输入
  HistoryStatsManager 提供的冻结查询对象。

  输出
  无返回值。

  读取状态
  查询对象中的已计算统计。

  写入状态
  root.innerHTML。

  调用函数
  renderCharacterCard、renderTeamCard、renderRecordCard、escapeHtml。

  边界与不变量
  不出现 table，不计算胜率；最近征途只取已按新到旧排序的前八条。
  */
  render(archive) {
    const recentRecords = archive.records.slice(0, RECENT_RECORD_LIMIT);
    const achievementItems = [
      ["最高评分", formatHighestScore(archive.achievements.highestScore), "✦"],
      ["最长战斗", `${archive.achievements.highestRounds} 回合`, "⌛"],
      ["MVP 次数", archive.achievements.mvpCount, "♛"],
      ["最常同行", archive.achievements.mostUsedCharacter, "◇"],
      ["胜率之冠", archive.achievements.bestWinRateCharacter, "❖"]
    ];
    this.root.innerHTML = `<div class="history-archive-shell">
      <header class="history-archive-header">
        <button class="ghost-button history-back-button" type="button" data-history-back>← 返回主界面</button>
        <div class="history-title-lockup"><p>THE HALL OF REMEMBRANCE</p><h1>历史档案馆</h1><span>记录每一次旅者的征途、胜利与陨落。</span></div>
        <div class="history-header-seal" aria-hidden="true"><span>FR</span><small>Ⅰ</small></div>
      </header>

      <section class="history-overview" aria-labelledby="history-overview-title">
        <div class="history-section-heading"><small>ARCHIVE INSIGNIA</small><h2 id="history-overview-title">征途总览</h2><span>由历次终局刻入的旅者徽记</span></div>
        <div class="history-badge-grid">
          <article><i>Ⅰ</i><span>总征战次数</span><strong>${archive.summary.totalMatches}</strong></article>
          <article><i>Ⅱ</i><span>总胜率</span><strong>${archive.summary.winRate}%</strong></article>
          <article><i>Ⅲ</i><span>MVP 次数</span><strong>${archive.summary.mvpCount}</strong></article>
          <article><i>Ⅳ</i><span>最高评分</span><strong>${formatHighestScore(archive.summary.highestScore)}</strong></article>
          <article><i>Ⅴ</i><span>最长战斗</span><strong>${archive.summary.highestRounds}<small>回合</small></strong></article>
        </div>
      </section>

      <section class="history-section" aria-labelledby="history-travelers-title">
        <div class="history-section-heading"><small>TRAVELER ARCHIVES</small><h2 id="history-travelers-title">旅者档案</h2><span>八域来客的每一次被选择，都在此留下墨痕</span></div>
        <div class="history-traveler-grid">${archive.characters.map(renderCharacterCard).join("")}</div>
      </section>

      <section class="history-section" aria-labelledby="history-factions-title">
        <div class="history-section-heading"><small>FACTION CHRONICLE</small><h2 id="history-factions-title">阵营记录</h2><span>晨星与暮影在漫长对峙中留下的两面纹章</span></div>
        <div class="history-faction-grid">${archive.teams.map(renderTeamCard).join("")}</div>
      </section>

      <section class="history-section" aria-labelledby="history-legends-title">
        <div class="history-section-heading"><small>LEGENDARY HONORS</small><h2 id="history-legends-title">传奇记录</h2><span>由最高的火光与最漫长的暗夜铸成</span></div>
        <div class="history-honor-grid">${achievementItems.map(([label, value, glyph]) => `<article><i aria-hidden="true">${glyph}</i><span>${label}</span><strong>${escapeHtml(String(value))}</strong></article>`).join("")}</div>
      </section>

      <section class="history-section history-journeys" aria-labelledby="history-journeys-title">
        <div class="history-section-heading"><small>RECENT VOYAGES</small><h2 id="history-journeys-title">最近征途</h2><span>卷宗最上层仍带着战场尘埃的终局记录</span></div>
        <div class="history-journey-grid">${recentRecords.length ? recentRecords.map(renderRecordCard).join("") : `<div class="history-empty"><span aria-hidden="true">◇</span><strong>卷宗尚未落笔</strong><p>完成第一场对局后，旅者的名字将在这里被铭记。</p></div>`}</div>
      </section>
      <footer class="history-archive-footer"><span>FIVE REALMS · ARCHIVE ${archive.version}</span><button class="ghost-button" type="button" data-history-back>返回旅途起点</button></footer>
    </div>`;
  }

  /*
  功能
  在档案读取失败时显示世界观一致的可恢复提示。

  调用方
  show error branch。

  输入
  读取异常。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  root.innerHTML。

  调用函数
  无。

  边界与不变量
  不得向玩家暴露 HTTP、文件路径或异常堆栈；始终保留返回首页按钮。
  */
  renderError() {
    this.root.innerHTML = `<div class="history-error"><span aria-hidden="true">✧</span><h1>卷册尚待展开</h1><p>档案守卫正在整理散落的记录，请稍后再来。</p><button class="ghost-button" type="button" data-history-back>← 返回主界面</button></div>`;
  }
}
