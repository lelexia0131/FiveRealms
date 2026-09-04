/*
模块职责
把公开领域定义与 UI 素材组合成开始界面的插画式规则书，并管理纯展示层的翻页、目录与焦点。

上游
UIManager。

下游
Domain definitions、presentation metadata 与安全 HTML 转义工具。

状态边界
只读公开静态定义；仅写规则书 DOM、当前页索引与焦点，不读写 MatchState。

信息边界
只展示所有玩家均可获知的规则、卡牌、角色与素材，不接触运行时隐藏手牌。

架构约束
不得复制卡牌或技能效果 authority，不得修改游戏规则、阵营、资源或胜负状态。
*/
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js";
import { CHARACTER_DEFINITIONS } from "../domain/definitions/characters/CharacterDefinitions.js";
import { RULESET_DEFINITION } from "../domain/definitions/ruleset/RulesetDefinition.js";
import { ACTIVE_SKILL_DEFINITIONS, PASSIVE_SKILL_DEFINITIONS } from "../domain/definitions/skills/SkillDefinitions.js";
import { CARD_PRESENTATION } from "../adapters/ui/CardPresentationDefinitions.js";
import { CHARACTER_PRESENTATION } from "../adapters/ui/CharacterPresentationDefinitions.js";
import { TEAM_PRESENTATION } from "../adapters/ui/PresentationMetadata.js";
import { escapeHtml, hiddenCardBackTemplate } from "./templates.js";

const USAGE_LABELS = Object.freeze({
  active:"出牌阶段",
  response:"响应时",
  both:"出牌 / 救援"
});

const TARGET_LABELS = Object.freeze({
  singleEnemyInRange:"距离 1 内敌人",
  self:"自己",
  responseOnly:"当前事件",
  singleAlly:"自己或队友",
  otherWithCards:"有手牌的其他角色",
  multiStage:"依提示分步选择",
  allEnemies:"全部敌人",
  otherWithCardsOrEquipment:"有牌区的其他角色",
  none:"无需选取",
  singleEnemy:"一名敌人",
  allLiving:"所有存活角色",
  singleUnsealedEnemy:"未被封印的敌人"
});

const TARGET_LABEL_OVERRIDES = Object.freeze({
  recover:"自己或濒死的队友",
  harvest:"自己"
});

const CARD_GROUPS = Object.freeze({
  basic:Object.freeze(["assault", "recover", "block", "charge", "shield"]),
  control:Object.freeze(["scout", "transfer", "plunder", "destroy", "counter"]),
  pressure:Object.freeze(["exposeWeakness", "shockwave", "provoke", "leverage", "duel"]),
  supply:Object.freeze(["harvest", "mutualBenefit", "symbiosis", "seal", "lightning"]),
  equipment:Object.freeze(["energyDevice", "recycleDevice", "defenseDevice", "battleDevice", "telescope", "barrierDevice"])
});

const CHARACTER_PAIRS = Object.freeze([
  Object.freeze(["blade-walker", "oath-warden"]),
  Object.freeze(["spirit-medic", "shade-agent"]),
  Object.freeze(["ember-magus", "trail-hunter"]),
  Object.freeze(["fate-gambler", "resonance-tuner"])
]);

/*
功能
为一张正式卡牌生成规则书所需的纯展示事实。

调用方
manualCardTemplate、规则书 UI 测试。

输入
正式卡牌 definitionId。

输出
合并领域事实与展示素材的新对象；未知 ID 返回 null。

读取状态
CARD_DEFINITIONS、CARD_PRESENTATION 与展示标签映射。

写入状态
无。

调用函数
无。

边界与不变量
效果正文始终直接来自 Domain CardDefinitions；本函数只补玩家可读标签。
*/
export function getRulebookCardView(definitionId) {
  const definition = CARD_DEFINITIONS[definitionId];
  const presentation = CARD_PRESENTATION[definitionId];
  if (!definition || !presentation) return null;
  const range = definition.ignoresDistance
    ? "无视距离"
    : definition.effectRange
      ? `距离 ${definition.effectRange}`
      : definition.targetType === "singleEnemyInRange"
        ? "攻击距离 1"
        : "依目标规则";
  return {
    ...definition,
    ...presentation,
    usageLabel:USAGE_LABELS[definition.usageMode] ?? "出牌阶段",
    targetLabel:TARGET_LABEL_OVERRIDES[definitionId]
      ?? TARGET_LABELS[definition.targetType]
      ?? "依牌面说明",
    responseLabel:definition.category === "tactic"
      ? (definition.counterable ? "可被反制" : "不可反制")
      : (definition.usageMode === "response" ? "响应牌" : "非反制牌"),
    rangeLabel:range,
    destinationLabel:definition.category === "equipment" ? "使用后进入装备槽" : "使用后进入弃牌堆"
  };
}

/*
功能
把一张正式卡牌渲染为规则书中的图解卡片。

调用方
cardGridTemplate 与重点交互页面。

输入
正式卡牌 definitionId。

输出
包含真实卡图、效果正文与规则标签的安全 HTML。

读取状态
getRulebookCardView 返回的公开展示事实。

写入状态
无。

调用函数
getRulebookCardView、escapeHtml。

边界与不变量
未知卡牌不生成占位规则；所有插值文本均转义。
*/
function manualCardTemplate(definitionId) {
  const card = getRulebookCardView(definitionId);
  if (!card) return "";
  return `<article class="manual-card" style="--manual-accent:${escapeHtml(card.accent)}">
    <div class="manual-card-art"><img src="${escapeHtml(card.art)}" alt="${escapeHtml(card.name)}卡牌插画"><span>${escapeHtml(card.categoryName)}</span></div>
    <div class="manual-card-copy">
      <header><h3>${escapeHtml(card.name)}</h3><small>${escapeHtml(card.usageLabel)}</small></header>
      <p>${escapeHtml(card.description)}</p>
      <div class="manual-card-facts">
        <span><b>作用对象</b>${escapeHtml(card.targetLabel)}</span>
        <span><b>距离</b>${escapeHtml(card.rangeLabel)}</span>
        <span><b>交互</b>${escapeHtml(card.responseLabel)}</span>
        <span><b>去向</b>${escapeHtml(card.destinationLabel)}</span>
      </div>
    </div>
  </article>`;
}

/*
功能
把指定正式卡牌集合渲染为规则书卡牌图鉴。

调用方
基础牌、战术牌与装备章节。

输入
definitionId 数组、可选四列布局标记与可选样式变体。

输出
卡牌图鉴 HTML。

读取状态
无。

写入状态
无。

调用函数
manualCardTemplate。

边界与不变量
保留输入顺序，不筛改任何领域定义。
*/
function cardGridTemplate(definitionIds, fourColumns = false, variant = "") {
  const classes = ["rulebook-card-grid", fourColumns ? "is-four" : "", variant].filter(Boolean).join(" ");
  return `<div class="${classes}">${definitionIds.map(manualCardTemplate).join("")}</div>`;
}

/*
功能
生成统一的规则书章节标题。

调用方
所有非封面页面构建。

输入
页码、章节英文眉题、中文标题与导语。

输出
章节标题 HTML。

读取状态
无。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
只渲染展示文案，不承载规则值。
*/
function pageHead(number, eyebrow, title, kicker) {
  return `<header class="rulebook-page-head">
    <span class="rulebook-chapter-number">${String(number).padStart(2, "0")}</span>
    <div><small>${escapeHtml(eyebrow)}</small><h2>${escapeHtml(title)}</h2><p class="rulebook-kicker">${escapeHtml(kicker)}</p></div>
  </header>`;
}

/*
功能
把一名正式角色投影为规则书中的立绘与双技能图解。

调用方
角色章节构建。

输入
角色 definitionId。

输出
角色图解 HTML；未知角色返回空字符串。

读取状态
角色、主动技能、被动技能与 portrait 展示定义。

写入状态
无。

调用函数
escapeHtml。

边界与不变量
技能成本、次数与效果直接读取 Domain SkillDefinitions，不自行解释数值。
*/
function characterManualTemplate(characterId) {
  const character = CHARACTER_DEFINITIONS.find((entry) => entry.id === characterId);
  const presentation = CHARACTER_PRESENTATION[characterId];
  const active = ACTIVE_SKILL_DEFINITIONS[character?.activeSkillIds?.[0]];
  const passive = PASSIVE_SKILL_DEFINITIONS[character?.passiveSkillIds?.[0]];
  if (!character || !presentation || !active || !passive) return "";
  const activeCost = active.id === "allIn" ? "消耗全部能量" : `${active.cost} 点能量`;
  return `<article class="character-manual">
    <div class="character-portrait">
      <img src="${escapeHtml(presentation.portrait)}" alt="${escapeHtml(character.name)}角色立绘">
      <div class="character-identity"><small>${escapeHtml(character.loreFaction)}</small><strong>${escapeHtml(character.name)}</strong></div>
    </div>
    <div class="character-manual-copy">
      <div class="character-vitals"><span>HP ${character.maxHp}</span><span>初始能量 ${character.initialEnergy}</span></div>
      <div class="skill-scroll">
        <section class="manual-skill"><span class="skill-icon">主</span><strong>${escapeHtml(active.name)}<small>${escapeHtml(activeCost)} · 每回合 ${active.limitPerTurn} 次</small></strong><p>${escapeHtml(active.description)}</p></section>
        <section class="manual-skill"><span class="skill-icon">被</span><strong>${escapeHtml(passive.name)}<small>被动技能</small></strong><p>${escapeHtml(passive.description)}</p></section>
      </div>
    </div>
  </article>`;
}

/*
功能
构建一对正式角色的规则书章节。

调用方
buildRulebookPages。

输入
页码、角色 ID 对、标题与导语。

输出
完整角色页 HTML。

读取状态
无。

写入状态
无。

调用函数
pageHead、characterManualTemplate。

边界与不变量
每名正式角色恰好出现在一个角色章节中。
*/
function characterPage(number, ids, title, kicker) {
  return `${pageHead(number, "CHARACTERS & SKILLS", title, kicker)}
    <div class="character-manual-grid">${ids.map(characterManualTemplate).join("")}</div>`;
}

/*
功能
构建全部二十三页插画式规则书内容。

调用方
RulebookView.render 与 UI 回归测试。

输入
无。

输出
按阅读顺序排列的冻结页面对象数组。

读取状态
公开规则、卡牌、角色、技能与展示素材定义。

写入状态
无。

调用函数
pageHead、cardGridTemplate、manualCardTemplate、characterPage。

边界与不变量
卡牌效果和技能效果只从正式定义读取；静态流程文案必须与 Application workflow 保持一致。
*/
export function buildRulebookPages() {
  const small = RULESET_DEFINITION.smallTeamBonuses;
  const large = RULESET_DEFINITION.largeTeamRules;
  const cast = ["blade-walker", "spirit-medic", "oath-warden"]
    .map((id) => CHARACTER_PRESENTATION[id].portrait);
  const pages = [
    {
      id:"cover",
      title:"五域纷争 · 战场手册",
      html:`<div class="rulebook-cover-art" aria-hidden="true"></div>
        <div class="rulebook-cover-cast" aria-hidden="true">${cast.map((src) => `<img src="${src}" alt="">`).join("")}</div>
        <div class="rulebook-cover-content">
          <small>FIVE REALMS · ILLUSTRATED FIELD MANUAL</small>
          <h2><span>五域</span>纷争</h2>
          <p>五名旅者分属晨星与暮影。隐藏的手牌、瞬时的响应、不断变化的距离与角色技能，共同决定哪个阵营能存活到最后。</p>
        </div>`
    },
    {
      id:"victory",
      title:"阵营与胜利",
      html:`${pageHead(2, "OBJECTIVE", "晨星 VS 暮影", "五人被分为 2 人小队与 3 人小队；你只需要与己方角色共同活到最后。")}
        <div class="rulebook-duel">
          <article class="faction-banner faction-dawn"><img src="./assets/characters/spirit-medic.svg" alt="晨星角色示意"><div class="faction-copy"><small>DAWN</small><strong>${TEAM_PRESENTATION.dawn.name}</strong><span>同阵营角色互为队友</span></div></article>
          <div class="duel-versus" aria-hidden="true"><i></i><b>VS</b><i></i></div>
          <article class="faction-banner faction-dusk"><img src="./assets/characters/ember-magus.svg" alt="暮影角色示意"><div class="faction-copy"><small>DUSK</small><strong>${TEAM_PRESENTATION.dusk.name}</strong><span>让敌方全部阵亡</span></div></article>
        </div>
        <div class="rulebook-rule-strip">
          <div><strong>阵亡不是立即终局</strong><span>单名角色阵亡后退出行动顺序，仍可能有存活队友继续作战。</span></div>
          <div><strong>只看存活阵营</strong><span>晨星与暮影都有人存活时继续；仅剩一个阵营时立刻决出胜者。</span></div>
          <div><strong>全队共享胜负</strong><span>你的角色阵亡后仍可观战；只要队友赢到最后，你依然随阵营获胜。</span></div>
        </div>`
    },
    {
      id:"interface",
      title:"战斗界面解剖",
      html:`${pageHead(3, "BATTLEFIELD", "一眼读懂战场", "实际对局把公开状态集中在角色席、中央结算区与顶部状态栏；你的手牌只对自己可见。")}
        <div class="anatomy-scroll"><div class="rulebook-anatomy">
          <div class="anatomy-status"><span><b>五域纷争</b>当前战局</span><span><b>第 2 轮</b>当前回合</span><span><b>你的回合</b>行动角色</span><span><b>牌堆 91</b>剩余牌</span><span><b>弃牌 12</b>公开牌区</span></div>
          <div class="anatomy-field">
            <article class="anatomy-seat anatomy-seat-dusk"><img src="./assets/characters/ember-magus.svg" alt=""><div><strong>敌人 · 炎术师</strong><span>HP 3 · 能量 2</span><span>距离 1 · 4 张手牌</span></div></article>
            <article class="anatomy-seat anatomy-seat-dawn"><img src="./assets/characters/oath-warden.svg" alt=""><div><strong>队友 · 守誓者</strong><span>HP 4 · 护盾 1</span><span>距离 2 · 装备区</span></div></article>
            <article class="anatomy-seat anatomy-seat-dusk"><img src="./assets/characters/trail-hunter.svg" alt=""><div><strong>敌人 · 追猎者</strong><span>HP 4 · 猎印状态</span><span>距离 2 · 装备区</span></div></article>
            <article class="anatomy-seat anatomy-seat-dusk"><img src="./assets/characters/fate-gambler.svg" alt=""><div><strong>敌人 · 赌命者</strong><span>HP 2 · 能量 3</span><span>距离 1 · 2 张手牌</span></div></article>
          </div>
          <div class="anatomy-center"><div class="anatomy-pile">${hiddenCardBackTemplate()}<b>牌堆</b></div><div class="anatomy-resolve"><img src="./assets/cards/assault.svg" alt="中央结算区的突袭"><small>中央结算区</small></div><div class="anatomy-prompt"><strong>你的出牌阶段</strong><span>选择手牌、发动技能，或结束出牌。</span></div><div class="anatomy-command"><b class="anatomy-action-skill">破军</b><b class="anatomy-action-primary">结束出牌</b><span class="anatomy-callout callout-five"><b>5</b>行动按钮</span></div></div>
          <div class="anatomy-human"><article class="anatomy-human-seat"><img src="./assets/characters/blade-walker.svg" alt=""><div><strong>你 · 刃行者</strong><span>HP 4　护盾 0　能量 2</span><span>装备：望远镜</span></div></article><div class="anatomy-hand"><img src="./assets/cards/assault.svg" alt=""><img src="./assets/cards/block.svg" alt=""><img src="./assets/cards/charge.svg" alt=""><img src="./assets/cards/counter.svg" alt=""><img src="./assets/cards/telescope.svg" alt=""></div></div>
          <span class="anatomy-callout callout-one"><b>1</b>队友 / 敌人</span><span class="anatomy-callout callout-two"><b>2</b>HP / 护盾 / 距离</span><span class="anatomy-callout callout-three"><b>3</b>出牌与响应结算</span><span class="anatomy-callout callout-four"><b>4</b>你的角色与装备</span><span class="anatomy-callout callout-six"><b>6</b>手牌区</span>
        </div></div>`
    },
    {
      id:"turn",
      title:"完整回合流程",
      html:`${pageHead(4, "TURN SEQUENCE", "轮到你时会发生什么", "每个存活角色依座位轮流行动；阵亡角色会被跳过，走完一圈进入下一轮。")}
        <div class="rulebook-flow">
          <div class="flow-node"><i>始</i><strong>回合开始</strong><span>重置本回合次数</span></div>
          <div class="flow-node"><img src="./assets/cards/seal.svg" alt=""><strong>处理状态</strong><span>封印 / 闪电先判定</span></div>
          <div class="flow-node"><img src="./assets/ui/charge-glyph.svg" alt=""><strong>获得能量</strong><span>基础 1，装备可加成</span></div>
          <div class="flow-node"><i>牌</i><strong>摸牌</strong><span>小队 ${small.drawCountPerTurn} / 大队 ${large.drawCountPerTurn}</span></div>
          <div class="flow-node"><img src="./assets/cards/assault.svg" alt=""><strong>出牌阶段</strong><span>用牌、技能或结束</span></div>
          <div class="flow-node"><i>弃</i><strong>弃牌阶段</strong><span>手牌留至当前 HP</span></div>
          <div class="flow-node"><i>终</i><strong>回合结束</strong><span>下一名存活角色</span></div>
        </div>
        <div class="rulebook-rule-strip">
          <div><strong>二人小队补偿</strong><span>开局 ${small.initialHandCount} 张、每回合摸 ${small.drawCountPerTurn} 张、每回合可主动使用 ${small.attackLimitPerTurn} 张「突袭」、能量上限 ${small.maxEnergy}。</span></div>
          <div><strong>三人小队基准</strong><span>开局 ${large.initialHandCount} 张、每回合摸 ${large.drawCountPerTurn} 张、每回合可主动使用 ${large.attackLimitPerTurn} 张「突袭」、能量上限 ${large.maxEnergy}。</span></div>
          <div><strong>封印的例外</strong><span>封印生效时仍会获得能量并摸牌，但跳过出牌阶段，直接检查弃牌。</span></div>
        </div>`
    },
    {
      id:"card-basics",
      title:"卡牌入门",
      html:`${pageHead(5, "CARD BASICS", "从手牌到弃牌堆", "点选手牌后，界面只会高亮当前合法的目标；完成结算的实体牌进入弃牌堆。")}
        <div class="rulebook-combat-sequence">
          <div class="combat-beat"><span class="beat-number">01 · 获得</span><img src="./assets/cards/harvest.svg" alt="摸牌示意"><strong>进入手牌</strong><span>摸牌、互利选择、转移或掠夺都可能让你获得牌。</span></div>
          <div class="combat-beat"><span class="beat-number">02 · 检查</span><img src="./assets/cards/assault.svg" alt="合法性示意"><strong>是否合法</strong><span>时机、目标、距离、次数、角色状态共同决定能否使用。</span></div>
          <div class="combat-beat"><span class="beat-number">03 · 选择</span><img src="./assets/cards/transfer.svg" alt="多段目标示意"><strong>确定目标</strong><span>有些牌无需目标；有些牌会分步选择角色、牌区或公开牌。</span></div>
          <div class="combat-beat"><span class="beat-number">04 · 响应</span><img src="./assets/cards/counter.svg" alt="反制示意"><strong>打开窗口</strong><span>战术牌可能被反制；可格挡伤害会询问目标是否使用格挡。</span></div>
          <div class="combat-beat"><span class="beat-number">05 · 结算</span><img src="./assets/cards/destroy.svg" alt="弃牌堆示意"><strong>进入弃牌</strong><span>结算完成后离开手牌；装备牌则留在唯一的装备槽中。</span></div>
        </div>`
    },
    {
      id:"basic-cards",
      title:"五张基础牌",
      html:`${pageHead(6, "BASIC CARDS", "每一局的基础语言", "突袭制造压力，格挡回答攻击，调息维持生命，聚能积攒潜力，护盾为下一轮铺路。")}${cardGridTemplate(CARD_GROUPS.basic)}`
    },
    {
      id:"assault-response",
      title:"突袭与响应",
      html:`${pageHead(7, "COMBAT RESPONSE", "一次攻击如何结算", "格挡发生在伤害之前；格挡成功则整次攻击无效，未格挡的伤害先穿过护盾，再扣生命。")}
        <div class="rulebook-combat-sequence">
          <div class="combat-beat"><span class="beat-number">01 · 发起</span><img src="./assets/cards/assault.svg" alt="突袭"><strong>A 使用「突袭」</strong><span>选择攻击距离 1 内的一名敌人。</span></div>
          <div class="combat-beat"><span class="beat-number">02 · 防御判定</span><img src="./assets/cards/defense-device.svg" alt="雷达"><strong>雷达先判定</strong><span>若目标装备雷达，每个格挡需求先分别判定。</span></div>
          <div class="combat-beat"><span class="beat-number">03 · 响应</span><img src="./assets/cards/block.svg" alt="格挡"><strong>目标使用格挡</strong><span>通常需要 1 张；军火库让突袭与震荡需要 2 张。</span></div>
          <div class="combat-beat"><span class="beat-number">04 · 吸收</span><img src="./assets/ui/shield-glyph.svg" alt="护盾"><strong>护盾先承伤</strong><span>每点护盾免疫 1 点伤害，剩余部分才扣 HP。</span></div>
          <div class="combat-beat"><span class="beat-number">05 · 结果</span><img src="./assets/characters/fate-gambler.svg" alt="受击角色"><strong>更新角色状态</strong><span class="combat-result"><b>HP 3 → 2</b>；降至 0 或更低则进入濒死。</span></div>
        </div>
        <div class="rulebook-note">「反制」不是用来回答普通「突袭」的：它只响应标记为可反制的战术牌。群体战术牌被目标反制时，只取消对该目标自己的效果。</div>`
    },
    {
      id:"control-tactics",
      title:"情报与控制战术",
      html:`${pageHead(8, "TACTICS · CONTROL", "看见、移动、夺取与取消", "这些战术围绕隐藏牌与牌区展开；牌面定义会告诉你能选手牌、装备，还是两者皆可。")}${cardGridTemplate(CARD_GROUPS.control)}`
    },
    {
      id:"pressure-tactics",
      title:"攻势与博弈战术",
      html:`${pageHead(9, "TACTICS · PRESSURE", "把一张牌变成战场选择题", "范围攻击、强迫出牌、借用他人攻击与轮流弃突袭，会把响应窗口扩展为多方互动。")}${cardGridTemplate(CARD_GROUPS.pressure)}`
    },
    {
      id:"supply-tactics",
      title:"补给与延迟战术",
      html:`${pageHead(10, "TACTICS · SUPPLY", "现在获得，或留到下回合", "丰收、互利、共生即时改变资源；封印与闪电则进入状态区，在持有者下回合摸牌前处理。")}${cardGridTemplate(CARD_GROUPS.supply)}`
    },
    {
      id:"equipment",
      title:"唯一装备槽",
      html:`${pageHead(11, "EQUIPMENT", "装上一件，替换一件", "装备牌从手牌使用后留在角色面板的装备区；每名角色只有一个装备槽。")}
        ${cardGridTemplate(CARD_GROUPS.equipment, false, "is-equipment")}
        <div class="rulebook-rule-strip">
          <div><strong>装备与替换</strong><span>打出新装备时立即生效，并把原装备移入弃牌堆。</span></div>
          <div><strong>被取得或破坏</strong><span>掠夺、破坏、借势与窃取会按各自规则移动或弃置装备；离开装备槽后效果结束。</span></div>
          <div><strong>阵亡清理</strong><span>阵亡角色的装备和全部手牌一同进入弃牌堆。</span></div>
        </div>`
    },
    {
      id:"distance",
      title:"存活环与距离",
      html:`${pageHead(12, "DISTANCE", "相邻，不等于永远相邻", "只把存活角色按座位围成一圈；顺、逆时针步数较小者，就是两人之间的基础距离。")}
        <div class="distance-scroll"><div class="distance-arena"><div class="distance-ring"></div>
          <div class="distance-seat distance-seat-dawn"><img src="./assets/characters/blade-walker.svg" alt=""><strong>你 · 刃行者</strong><span>起点</span></div>
          <div class="distance-seat distance-seat-dusk"><img src="./assets/characters/ember-magus.svg" alt=""><strong>敌人 · 炎术师</strong><span>距离 1</span></div>
          <div class="distance-seat distance-seat-dawn"><img src="./assets/characters/oath-warden.svg" alt=""><strong>队友 · 守誓者</strong><span>距离 2</span></div>
          <div class="distance-seat distance-seat-dusk"><img src="./assets/characters/trail-hunter.svg" alt=""><strong>敌人 · 追猎者</strong><span>距离 2</span></div>
          <div class="distance-seat distance-seat-dusk"><img src="./assets/characters/fate-gambler.svg" alt=""><strong>敌人 · 赌命者</strong><span>距离 1</span></div>
          <div class="distance-center"><strong>存活角色环</strong><span>有人阵亡后重新压缩</span></div>
        </div></div>
        <div class="distance-modifiers">
          <article class="distance-modifier"><img src="./assets/cards/telescope.svg" alt="望远镜"><div><strong>望远镜 · 从你出发 -1</strong><span>你计算与其他角色的距离时减 1，结果最低仍为 1。</span></div></article>
          <article class="distance-modifier"><img src="./assets/cards/barrier-device.svg" alt="屏障"><div><strong>屏障 · 目标离你 + 1</strong><span>其他角色计算与你的距离时加 1。</span></div></article>
        </div>`
    },
    {
      id:"resources",
      title:"生命、护盾与能量",
      html:`${pageHead(13, "RESOURCES", "三条读懂生存与技能的刻度", "护盾独立吸收伤害；能量在自己回合获得并支付主动技能。")}
        <div class="rulebook-resource-grid">
          <article class="resource-plate"><img src="./assets/ui/recover-glyph.svg" alt="生命图标"><h3>生命 HP</h3><div class="resource-demo"><b class="hp">4</b><i>受 1 点伤害 →</i><b class="hp">3</b><i>→</i><b class="hp">2</b></div><p>治疗不能超过最大生命。回合末手牌上限等于当前 HP，因此受伤也会压缩你能保留的手牌。</p></article>
          <article class="resource-plate"><img src="./assets/ui/shield-glyph.svg" alt="护盾图标"><h3>护盾</h3><div class="resource-demo"><b>伤害 2</b><i>→</i><b class="shield">护盾 1</b><i>→</i><b class="hp">HP -1</b></div><p>护盾先于生命承受伤害；每点护盾免疫 1 点伤害，吸收后会消耗。</p></article>
          <article class="resource-plate"><img src="./assets/ui/charge-glyph.svg" alt="能量图标"><h3>能量</h3><div class="resource-demo"><b>+1</b><i>→</i><b>2 / 4</b><i>→ 技能</i><b>0 / 4</b></div><p>二人小队上限 ${small.maxEnergy}，三人小队上限 ${large.maxEnergy}；充能桩会让回合开始额外获得 1 点。</p></article>
        </div>`
    },
    { id:"characters-one", title:"刃行者与守誓者", html:characterPage(14, CHARACTER_PAIRS[0], "锋刃与城垒", "刃行者用卡牌类别积蓄连势，守誓者用手牌与能量替队友承受压力。") },
    { id:"characters-two", title:"灵医与影客", html:characterPage(15, CHARACTER_PAIRS[1], "生命回声与暗潮情报", "灵医把治疗转成补牌，影客通过实际伤害看见秘密，并能从敌方牌区随机窃取。") },
    { id:"characters-three", title:"炎术师与追猎者", html:characterPage(16, CHARACTER_PAIRS[2], "余烬与猎印", "炎术师从伤害中回收能量，追猎者先标记目标，再以无视距离的猎杀兑现猎印。") },
    { id:"characters-four", title:"赌命者与调律师", html:characterPage(17, CHARACTER_PAIRS[3], "孤注与共鸣", "赌命者把全部能量押成牌与伤害机会；调律师让队友成为资源流动的中心。") },
    {
      id:"judgment",
      title:"判定与延迟状态",
      html:`${pageHead(18, "JUDGMENT", "牌堆也会回答问题", "封印、闪电与雷达都翻开牌堆顶牌判定，但它们关注的类别和判定后的去向并不相同。")}
        <div class="rulebook-combat-sequence">
          <div class="combat-beat"><span class="beat-number">封印 · 回合状态</span><img src="./assets/cards/seal.svg" alt="封印"><strong>战术牌：未生效</strong><span>持有者正常进行回合；其他类别则生效，摸牌后跳过出牌阶段。</span></div>
          <div class="combat-beat"><span class="beat-number">闪电 · 回合状态</span><img src="./assets/cards/lightning.svg" alt="闪电"><strong>装备牌：受到 3 伤害</strong><span>命中后移除；未命中则转移给下一名没有闪电状态的角色。</span></div>
          <div class="combat-beat"><span class="beat-number">雷达 · 防御装备</span><img src="./assets/cards/defense-device.svg" alt="雷达"><strong>每个格挡需求分别判定</strong><span>战术免除需求；基础进入手牌；装备进入弃牌，然后继续格挡结算。</span></div>
          <div class="combat-beat"><span class="beat-number">延迟状态反制</span><img src="./assets/cards/counter.svg" alt="反制"><strong>结算前可反制</strong><span>状态持有者优先响应，其余存活角色再按座位顺序决定。</span></div>
          <div class="combat-beat"><span class="beat-number">公开结果</span><img src="./assets/cards/harvest.svg" alt="公开判定牌"><strong>所有人看见类别</strong><span>判定牌与结果会显示在中央区域，不属于任何人的隐藏手牌。</span></div>
        </div>`
    },
    {
      id:"death",
      title:"濒死、阵亡与观战",
      html:`${pageHead(19, "DYING & SPECTATING", "HP 降至 0 之后", "这不是立刻阵亡：系统先开启调息救援，只有无法恢复到至少 1 HP 才会提交死亡。")}
        <div class="spectator-stage">
          <div class="spectator-death"><img src="./assets/characters/blade-walker.svg" alt="阵亡角色"><span class="spectator-stamp">阵亡</span></div>
          <div class="spectator-path">
            <div class="spectator-step"><b>01</b><div><strong>进入濒死</strong><span>界面显示当前 HP 与还需恢复多少点才能回到 1。</span></div></div>
            <div class="spectator-step"><b>02</b><div><strong>依座次询问调息</strong><span>自己与存活队友可用「调息」救援；每张恢复 1 点，直到脱离濒死或无人继续。</span></div></div>
            <div class="spectator-step"><b>03</b><div><strong>救援失败则阵亡</strong><span>HP 归 0、状态清空、手牌与装备全部进入弃牌堆，后续回合跳过该角色。</span></div></div>
            <div class="spectator-step"><b>04</b><div><strong>观战己方</strong><span>本地角色阵亡后进入观战，可看见存活队友手牌；敌方未知牌仍保持牌背。</span></div></div>
            <div class="spectator-step"><b>05</b><div><strong>等待阵营结局</strong><span>敌对存活击杀者额外摸 ${RULESET_DEFINITION.killRewardDrawCount} 张；一个阵营无人存活时对局结束。</span></div></div>
          </div>
        </div>`
    },
    {
      id:"hidden-information",
      title:"隐藏与公开信息",
      html:`${pageHead(20, "HIDDEN INFORMATION", "你知道什么，桌上就显示什么", "玩家视图只呈现合法公开或已识别的信息。")}
        <div class="hidden-info-stage">
          <article class="hidden-info-card"><img src="./assets/cards/assault.svg" alt="自己的正面手牌"><h3>自己的手牌 · 正面</h3><p>你能阅读自己每张牌的名称、插画和效果，并在出牌阶段选择合法行动。</p></article>
          <article class="hidden-info-card"><div class="rulebook-hidden-card">${hiddenCardBackTemplate({ compact:true })}</div><h3>对手未知牌 · 牌背</h3><p>通常只知道对手的手牌数量，不知道具体牌面。</p></article>
          <article class="hidden-info-card"><div class="known-stack"><img src="./assets/cards/block.svg" alt=""><img src="./assets/cards/counter.svg" alt=""><b>已知</b></div><h3>窥探 / 公开 · 已识别</h3><p>窥探后，那张牌会持续以正面显示；它离开对方手牌后，就不再保持已知标记。</p></article>
        </div>
        <div class="rulebook-note">公开信息包括角色、HP、护盾、能量、装备、状态、距离、手牌数量、牌堆与弃牌数量，以及中央结算和公开选择中展示的牌。</div>`
    },
    {
      id:"example-one",
      title:"新手实战 · 出牌",
      html:`${pageHead(21, "FIRST TURN · PART I", "从摸牌到一次格挡。", "你控制刃行者，轮到自己行动；跟着界面完成第一张主动牌。")}
        <div class="comic-grid">
          <article class="comic-panel"><img src="./assets/characters/blade-walker.svg" alt=""><span class="comic-number">01</span><span class="comic-speech">“我的回合开始。”</span><div class="comic-caption">处理状态后获得 1 点能量。</div></article>
          <article class="comic-panel"><img src="./assets/cards/harvest.svg" alt=""><span class="comic-number">02</span><span class="comic-speech">摸取本阵营的回合牌数</span><div class="comic-caption">新牌进入自己的正面手牌。</div></article>
          <article class="comic-panel"><img src="./assets/characters/ember-magus.svg" alt=""><img class="comic-card" src="./assets/cards/assault.svg" alt="突袭"><span class="comic-number">03</span><div class="comic-caption">点选「突袭」，界面高亮距离 1 内的敌人。</div></article>
          <article class="comic-panel"><img src="./assets/characters/ember-magus.svg" alt=""><span class="comic-number">04</span><span class="comic-speech">“选择炎术师。”</span><div class="comic-caption">合法目标进入中央结算区。</div></article>
          <article class="comic-panel"><img src="./assets/characters/ember-magus.svg" alt=""><img class="comic-card" src="./assets/cards/block.svg" alt="格挡"><span class="comic-number">05</span><span class="comic-speech">敌人：使用格挡</span><div class="comic-caption">一张格挡满足需求，突袭无效。</div></article>
        </div>`
    },
    {
      id:"example-two",
      title:"新手实战 · 收束",
      html:`${pageHead(22, "FIRST TURN · PART II", "继续行动，然后安全结束", "格挡并不会自动结束你的出牌阶段；只要还有合法牌或技能，就可以继续决定。")}
        <div class="comic-grid">
          <article class="comic-panel"><img src="./assets/characters/blade-walker.svg" alt=""><img class="comic-card" src="./assets/cards/charge.svg" alt="聚能"><span class="comic-number">06</span><span class="comic-speech">“我再使用聚能。”</span><div class="comic-caption">获得 1 点能量，为「破军」准备。</div></article>
          <article class="comic-panel"><img src="./assets/characters/blade-walker.svg" alt=""><span class="comic-number">07</span><span class="comic-speech">发动技能，或继续出牌？</span><div class="comic-caption">查看主动技能成本与本回合次数。</div></article>
          <article class="comic-panel"><img src="./assets/cards/block.svg" alt=""><span class="comic-number">08</span><div class="comic-caption">保留「格挡」：它不能主动使用，要等响应窗口。</div></article>
          <article class="comic-panel"><img src="./assets/characters/blade-walker.svg" alt=""><span class="comic-number">09</span><span class="comic-speech">“结束出牌。”</span><div class="comic-caption">进入弃牌阶段；手牌超过当前 HP 才需要弃置。</div></article>
          <article class="comic-panel"><img src="./assets/characters/oath-warden.svg" alt=""><span class="comic-number">10</span><span class="comic-speech">下一名存活角色行动</span><div class="comic-caption">完成第一回合：观察、选择、响应、收束。</div></article>
          <article class="comic-panel"><img src="./assets/cards/assault.svg" alt=""><span class="comic-number">✓</span><div class="comic-caption"><strong>目标先看距离</strong><br>突袭通常只能指定距离 1 的敌人。</div></article>
          <article class="comic-panel"><img src="./assets/cards/counter.svg" alt=""><span class="comic-number">✓</span><div class="comic-caption"><strong>牌要看使用时机</strong><br>格挡、反制、濒死调息都在窗口中使用。</div></article>
          <article class="comic-panel"><img src="./assets/ui/recover-glyph.svg" alt=""><span class="comic-number">✓</span><div class="comic-caption"><strong>结束前看 HP</strong><br>当前 HP 就是回合末手牌上限。</div></article>
        </div>`
    },
    {
      id:"horizontal-card-view",
      title:"横向卡牌查看",
      html:`${pageHead(23, "HORIZONTAL CARD VIEW", "横向牌区，左右滑动查看", "当卡牌沿水平方向排列时，未显示的剩余卡牌仍在同一牌区内等待查看。")}
        <div class="rulebook-horizontal-stage">
          <div class="rulebook-horizontal-rail" aria-hidden="true">
            <img src="./assets/cards/assault.svg" alt="">
            <img src="./assets/cards/block.svg" alt="">
            <img src="./assets/cards/charge.svg" alt="">
            <img src="./assets/cards/transfer.svg" alt="">
            <img src="./assets/cards/telescope.svg" alt="">
            <img src="./assets/cards/barrier-device.svg" alt="">
          </div>
          <div class="rulebook-horizontal-direction" aria-hidden="true"><span>←</span><strong>左右拖动 / 滑动</strong><span>→</span></div>
        </div>
        <div class="rulebook-rule-strip">
          <div><strong>所有横向卡牌区</strong><span>自己的手牌区、对手手牌区、隐藏牌选择区与私密展示区，都可以用鼠标左右拖动或滑动查看当前未显示的牌。</span></div>
          <div><strong>所有横向卡牌池</strong><span>公共牌池等沿水平方向排列的卡牌池，同样可以左右拖动或滑动，查看牌区中暂时未显示的剩余卡牌。</span></div>
          <div><strong>牌面不因查看改变</strong><span>拖动或滑动只改变当前可见位置，不改变卡牌顺序、归属、公开状态或结算结果。</span></div>
        </div>`
    }
  ];
  return Object.freeze(pages.map((page, index) => Object.freeze({
    ...page,
    folio:String(index + 1).padStart(2, "0")
  })));
}

export class RulebookView {
  /*
  功能
  创建规则书视图并绑定打开入口、目录、翻页和键盘交互。

  调用方
  UIManager 构造函数。

  输入
  overlay 根元素、开始页 opener 按钮与统一 UI 激活音效回调。

  输出
  RulebookView 实例。

  读取状态
  公开规则书页面模型与传入 DOM。

  写入状态
  overlay markup、当前页、焦点与事件监听。

  调用函数
  buildRulebookPages、render、bind；音效由 UIManager 注入的现有播放入口负责。

  边界与不变量
  缺失 DOM 时保持惰性空视图；不触碰游戏状态。
  */
  constructor(overlay, opener, onActivate = null) {
    this.overlay = overlay;
    this.opener = opener;
    this.onActivate = onActivate;
    this.pages = buildRulebookPages();
    this.currentIndex = 0;
    this.lastFocus = null;
    this.handleDocumentKeydown = (event) => this.handleKeydown(event);
    if (!this.overlay || !this.opener) return;
    this.render();
    this.bind();
  }

  /*
  功能
  一次性渲染规则书外壳、目录、全部页面与翻页栏。

  调用方
  constructor。

  输入
  无。

  输出
  无返回值。

  读取状态
  pages。

  写入状态
  overlay.innerHTML 与子元素引用。

  调用函数
  escapeHtml。

  边界与不变量
  页面正文来自 buildRulebookPages；初始仅封面可见。
  */
  render() {
    const toc = this.pages.map((page, index) => `<button type="button" data-rulebook-page="${index}" aria-current="${index === 0 ? "page" : "false"}"><b>${page.folio}</b><span>${escapeHtml(page.title)}</span></button>`).join("");
    const pages = this.pages.map((page, index) => `<section class="rulebook-page${index === 0 ? " rulebook-cover" : ""}" data-rulebook-page-id="${escapeHtml(page.id)}" data-folio="${page.folio}" aria-hidden="${index === 0 ? "false" : "true"}">${page.html}</section>`).join("");
    this.overlay.innerHTML = `<div class="rulebook-shell" role="document">
      <header class="rulebook-topbar">
        <div class="rulebook-brand"><span><strong id="rulebook-title">战场手册</strong><small>FIVE REALMS</small></span></div>
        <div class="rulebook-location"><small>${this.pages[0].folio} / ${this.pages.length}</small><strong>${escapeHtml(this.pages[0].title)}</strong></div>
        <button type="button" class="rulebook-close" data-rulebook-close aria-label="关闭入局说明">×</button>
      </header>
      <nav class="rulebook-toc" aria-label="规则书目录"><div class="rulebook-toc-label">CHAPTER INDEX</div><div class="rulebook-toc-list">${toc}</div></nav>
      <main class="rulebook-viewport"><div class="rulebook-pages">${pages}</div></main>
      <footer class="rulebook-footer">
        <button type="button" class="ghost-button" data-rulebook-prev disabled>← 上一页</button>
        <div class="rulebook-progress"><span>${this.pages[0].folio}</span><div class="rulebook-progress-track"><i></i></div><span>${this.pages.length}</span></div>
        <button type="button" class="primary-button" data-rulebook-next>下一页 →</button>
      </footer>
    </div>`;
    this.location = this.overlay.querySelector(".rulebook-location");
    this.progress = this.overlay.querySelector(".rulebook-progress");
    this.prevButton = this.overlay.querySelector("[data-rulebook-prev]");
    this.nextButton = this.overlay.querySelector("[data-rulebook-next]");
  }

  /*
  功能
  绑定规则书入口与 overlay 内部的委托事件。

  调用方
  constructor。

  输入
  无。

  输出
  无返回值。

  读取状态
  opener 与 overlay。

  写入状态
  DOM 事件监听。

  调用函数
  open、close、show 与 onActivate。

  边界与不变量
  有效点击先触发统一 UI 音效；所有翻页事件只更新展示索引。
  */
  bind() {
    this.opener.addEventListener("click", () => {
      this.onActivate?.();
      this.open();
    });
    this.overlay.addEventListener("click", (event) => {
      if (event.target === this.overlay || event.target.closest("[data-rulebook-close]")) {
        this.onActivate?.();
        this.close();
        return;
      }
      const pageButton = event.target.closest("[data-rulebook-page]");
      if (pageButton) {
        this.onActivate?.();
        this.show(Number(pageButton.dataset.rulebookPage));
      } else if (event.target.closest("[data-rulebook-prev]")) {
        this.onActivate?.();
        this.show(this.currentIndex - 1);
      } else if (event.target.closest("[data-rulebook-next]")) {
        this.onActivate?.();
        this.show(this.currentIndex + 1);
      }
    });
  }

  /*
  功能
  打开规则书并把键盘焦点移入对话框。

  调用方
  opener click。

  输入
  无。

  输出
  无返回值。

  读取状态
  当前 activeElement 与 overlay。

  写入状态
  可见类、body 滚动锁、document keydown 与焦点。

  调用函数
  show。

  边界与不变量
  重复打开不重复注册 keydown；总是从当前已选页面继续。
  */
  open() {
    if (!this.overlay?.classList.contains("is-hidden")) return;
    this.lastFocus = document.activeElement;
    this.overlay.classList.remove("is-hidden");
    document.body.classList.add("rulebook-open");
    document.addEventListener("keydown", this.handleDocumentKeydown);
    this.show(this.currentIndex);
    this.overlay.querySelector("[data-rulebook-close]")?.focus();
  }

  /*
  功能
  关闭规则书并把焦点归还给打开入口。

  调用方
  close 按钮、背景点击与 Escape。

  输入
  无。

  输出
  无返回值。

  读取状态
  lastFocus 与 overlay。

  写入状态
  可见类、body 滚动锁、document keydown 与焦点。

  调用函数
  focus。

  边界与不变量
  关闭不重置阅读页；焦点目标失效时回退 opener。
  */
  close() {
    if (!this.overlay || this.overlay.classList.contains("is-hidden")) return;
    this.overlay.classList.add("is-hidden");
    document.body.classList.remove("rulebook-open");
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    const focusTarget = this.lastFocus?.isConnected ? this.lastFocus : this.opener;
    focusTarget?.focus();
  }

  /*
  功能
  切换到指定规则书页面并同步目录、标题、进度与按钮状态。

  调用方
  目录、前后页按钮、open 与键盘导航。

  输入
  目标页索引。

  输出
  实际显示的页索引。

  读取状态
  pages 与 overlay 页面节点。

  写入状态
  currentIndex、aria-hidden/current、滚动位置与进度。

  调用函数
  Math.max/min、escapeHtml。

  边界与不变量
  索引始终收束在有效范围；一次只显示一个页面。
  */
  show(index) {
    if (!this.overlay) return this.currentIndex;
    const next = Math.max(0, Math.min(this.pages.length - 1, Number(index) || 0));
    this.currentIndex = next;
    const pageNodes = [...this.overlay.querySelectorAll("[data-rulebook-page-id]")];
    const tocButtons = [...this.overlay.querySelectorAll("[data-rulebook-page]")];
    pageNodes.forEach((page, pageIndex) => {
      const visible = pageIndex === next;
      page.setAttribute("aria-hidden", String(!visible));
      if (visible) page.scrollTop = 0;
    });
    tocButtons.forEach((button, pageIndex) => button.setAttribute("aria-current", pageIndex === next ? "page" : "false"));
    tocButtons[next]?.scrollIntoView?.({ block:"nearest", inline:"nearest" });
    const page = this.pages[next];
    this.location.innerHTML = `<small>${page.folio} / ${this.pages.length}</small><strong>${escapeHtml(page.title)}</strong>`;
    this.progress.querySelector("span:first-child").textContent = page.folio;
    this.progress.querySelector("i").style.width = `${((next + 1) / this.pages.length) * 100}%`;
    this.prevButton.disabled = next === 0;
    this.nextButton.disabled = next === this.pages.length - 1;
    this.nextButton.textContent = next === this.pages.length - 1 ? "已读完" : "下一页 →";
    return next;
  }

  /*
  功能
  在规则书开启时处理关闭与键盘翻页。

  调用方
  document keydown listener。

  输入
  KeyboardEvent。

  输出
  无返回值。

  读取状态
  overlay 可见性与 currentIndex。

  写入状态
  可能更新当前页或关闭 overlay。

  调用函数
  close、show、preventDefault。

  边界与不变量
  Escape 关闭；左右箭头、PageUp/PageDown、Home/End 只在非输入控件上生效。
  */
  handleKeydown(event) {
    if (!this.overlay || this.overlay.classList.contains("is-hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.target.closest?.("input, textarea, select")) return;
    const destination = event.key === "ArrowLeft" || event.key === "PageUp"
      ? this.currentIndex - 1
      : event.key === "ArrowRight" || event.key === "PageDown"
        ? this.currentIndex + 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? this.pages.length - 1
            : null;
    if (destination === null) return;
    event.preventDefault();
    this.show(destination);
  }
}
