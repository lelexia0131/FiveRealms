const PACKAGE_VERSION_URL = new URL("../../package.json", import.meta.url);

/*
功能
从项目清单读取当前应用版本号。

调用方
GameInfoView.show 与游戏说明页测试。

输入
可选 fetch capability，默认使用当前运行环境的 fetch。

输出
合法语义版本字符串；读取失败或字段非法时返回破折号占位。

读取状态
package.json 的 version 字段。

写入状态
无。

调用函数
fetch、Response.json。

边界与不变量
版本只以 package.json 为来源；页面不得维护第二份硬编码版本号。
*/
export async function loadGameVersion(fetchVersion = globalThis.fetch) {
  try {
    const response = await fetchVersion(PACKAGE_VERSION_URL);
    if (!response.ok) return "—";
    const version = (await response.json())?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : "—";
  } catch {
    return "—";
  }
}

export class GameInfoView {
  /*
  功能
  创建独立游戏说明页的展示与返回交互边界。

  调用方
  UIManager 构造函数。

  输入
  页面根节点、返回首页 callback，以及可选版本读取函数。

  输出
  GameInfoView 实例。

  读取状态
  无。

  写入状态
  保存依赖并注册根节点 click listener。

  调用函数
  handleClick。

  边界与不变量
  View 只渲染制作信息，不读取或修改 MatchState。
  */
  constructor(root, onBack, versionLoader = loadGameVersion) {
    this.root = root;
    this.onBack = onBack;
    this.versionLoader = versionLoader;
    this.version = null;
    this.root?.addEventListener("click", (event) => this.handleClick(event));
  }

  /*
  功能
  读取一次当前版本并渲染完整游戏说明页。

  调用方
  UIManager.showGameInfo。

  输入
  无。

  输出
  页面渲染完成的 Promise。

  读取状态
  package.json 版本与已缓存的当前版本。

  写入状态
  version 缓存与说明页 DOM。

  调用函数
  versionLoader、render。

  边界与不变量
  重复进入复用同一版本值；读取失败仍渲染完整正文且不产生滚动错误页。
  */
  async show() {
    if (!this.root) return;
    if (this.version === null) this.version = await this.versionLoader();
    this.render();
  }

  /*
  功能
  将用户指定的制作信息渲染为一屏档案扉页。

  调用方
  show。

  输入
  无。

  输出
  无返回值。

  读取状态
  已校验的 version 字符串。

  写入状态
  game info root 的 innerHTML。

  调用函数
  无。

  边界与不变量
  可见文案严格限制为需求给定内容与返回入口，装饰元素不承载文字。
  */
  render() {
    this.root.innerHTML = `<div class="game-info-atmosphere" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="game-info-shell">
        <header class="game-info-header">
          <button class="ghost-button game-info-back-button" type="button" data-game-info-back>← 返回</button>
          <div class="game-info-title-lockup"><h1>五域纷争</h1><p>FIVE REALMS</p></div>
          <span class="game-info-seal" aria-hidden="true"></span>
        </header>

        <section class="game-info-facts">
          <div><span>当前版本</span><strong>v${this.version}</strong></div>
          <div><span>游戏作者</span><strong>Lelexia</strong></div>
          <div><span>更新时间</span><strong>2026.09.04</strong></div>
        </section>

        <div class="game-info-columns">
          <section class="game-info-card game-info-about">
            <h2>关于游戏</h2>
            <p>《五域纷争》是一款以阵营对抗、卡牌博弈与角色能力为核心的策略游戏。</p>
            <p>游戏将根据实际对局体验持续进行规则调整、平衡优化、Bug 修复与界面改进。</p>
            <p>如有对游戏玩法有疑问，可前往首页“入局说明”查看详细游玩介绍。</p>
          </section>

          <section class="game-info-card game-info-contact">
            <h2>反馈与联系</h2>
            <p>如发现规则异常、程序错误、显示问题，<br />或对游戏设计、平衡性及后续内容有建议，欢迎联系。</p>
            <div class="game-info-links">
              <a href="mailto:colasmith3783@gmail.com">colasmith3783@gmail.com</a>
              <a href="mailto:2100532928@qq.com">2100532928@qq.com</a>
              <a href="https://github.com/lelexia0131/FiveRealms" target="_blank" rel="noopener noreferrer">https://github.com/lelexia0131/FiveRealms</a>
            </div>
          </section>
        </div>

        <section class="game-info-copyright">
          <h2>版权说明</h2>
          <div>
            <p>© 2026 Five Realms. All Rights Reserved.</p>
            <p>除另有说明外，《五域纷争》的游戏规则、程序代码、角色设定、<br />界面设计及原创素材版权归作者所有。</p>
            <p>未经许可，不得将本游戏或其中的原创内容用于商业发行、<br />再分发、冒充官方版本或移除原作者署名。</p>
            <p>第三方字体、图形、音频及其他资源的相关权利<br />归各自权利人所有，并按照对应授权协议使用。</p>
          </div>
        </section>

        <footer class="game-info-footer"><p>感谢游玩《五域纷争》</p></footer>
      </div>`;
  }

  /*
  功能
  把说明页返回按钮点击提交给顶层页面生命周期。

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
  只有 data-game-info-back 元素提交返回，不触发征召或对局。
  */
  handleClick(event) {
    if (event.target.closest("[data-game-info-back]")) this.onBack?.();
  }
}
