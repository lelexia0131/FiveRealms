import { MATCH_MODE } from "../../application/match/MatchMode.js";

/*
功能
渲染 FiveRealms 游玩方式入口。

调用方
UIManager network 页面。

输入
无。

输出
页面 HTML。

读取状态
MATCH_MODE。

写入状态
无。

调用函数
无。

边界与不变量
单人按钮只导航到既有编队选择，不复制单人页面。
*/
export function renderPlayModeSelectionView() {
  return `<div class="network-menu"><header><h2>选择游玩方式</h2></header>
    <div class="network-mode-grid">
      <button type="button" class="network-mode-card" data-network-action="${MATCH_MODE.SINGLEPLAYER}">
        <span class="network-mode-symbol" aria-hidden="true">✦</span><span class="eyebrow">独自征召</span><strong>单人游玩</strong><span>选择编队与角色<br>与四位电脑角色展开对局</span></button>
      <button type="button" class="network-mode-card network-mode-dusk" data-network-action="${MATCH_MODE.NETWORK}">
        <span class="network-mode-symbol" aria-hidden="true">✧ ✧</span><span class="eyebrow">双人同行</span><strong>多人游玩</strong><span>各自选择角色与阵营<br>并肩作战，或成为彼此的对手</span></button>
    </div><button type="button" class="ghost-button" data-network-action="home">返回</button></div>`;
}
