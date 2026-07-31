import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GAME_CONFIG } from "../js/config/gameConfig.js";
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../js/config/cardConfig.js";
import { GENERAL_DEFINITIONS } from "../js/config/generalConfig.js";
import { Game } from "../js/core/Game.js";
import { Player } from "../js/core/Player.js";
import { Deck } from "../js/core/Deck.js";
import { TeamManager } from "../js/core/TeamManager.js";
import { TeamRuleService } from "../js/core/TeamRuleService.js";
import { DistanceSystem } from "../js/core/DistanceSystem.js";
import { RuleEngine } from "../js/core/RuleEngine.js";
import { CardSelectionSystem } from "../js/core/CardSelectionSystem.js";
import { createAiVisibleState } from "../js/ai/AiVisibleState.js";
import { AiSimulator } from "../js/ai/AiSimulator.js";
import { ThreatCalculator } from "../js/ai/ThreatCalculator.js";
import { CleanupManager } from "../js/utils/CleanupManager.js";
import { getAiDelay, sampleDelay } from "../js/utils/aiTiming.js";
import { candidateCardTemplate, cardDescriptionClass, equipmentSlotTemplate, formatLogEntry, handCardTemplate, hiddenCardBackTemplate, opponentHandStripTemplate, playerPanelTemplate, resolvingCardTemplate, skillDetailsTemplate } from "../js/ui/templates.js";
import { InteractionController, hiddenSelectionMarkup } from "../js/ui/InteractionController.js";
import { UIManager, canSubmitResponse, skillButtonLabel } from "../js/ui/UIManager.js";
import { CARD_CATEGORY_DISPLAY_ORDER, CARD_DEFINITION_DISPLAY_ORDER, createHiddenSelectionView, createOpponentHandView } from "../js/ui/handVisibility.js";
import { PublicPoolView } from "../js/ui/PublicPoolView.js";
import { isCardSelectionValid, toggleCardSelection } from "../js/ui/selectionUtils.js";
import { buildResponsePresentation } from "../js/core/ResponseSystem.js";
import { hasCardResolver } from "../js/cards/cardRegistry.js";
import { ACTIVE_SKILLS, hasActiveSkill, hasPassiveSkill, registerPassiveSkills } from "../js/generals/skillRegistry.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const projectFile = (relativePath) => fileURLToPath(new URL(`../${relativePath.replace(/^\.\//, "")}`, import.meta.url));
async function listJavaScriptFiles(directory = projectFile("js")) {
  const entries = await readdir(directory, { withFileTypes:true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? listJavaScriptFiles(path) : (entry.isFile() && entry.name.endsWith(".js") ? [path] : []);
  }));
  return nested.flat();
}
let serial = 0;
const instance = (definitionId) => ({ ...CARD_DEFINITIONS[definitionId], id:`test-card-${definitionId}-${++serial}` });

function makeUi(response = () => false) {
  return {
    logs:[], reveals:[], responseRequests:[], publicRequests:[], thinking:[], currentCards:[],
    playEndState:null,
    render() {}, appendLog(entry) { this.logs.push(entry.message); },
    waitForHumanPlayEnd(gameId) { return new Promise((resolve) => { this.playEndState = { gameId, resolve }; }); },
    resolveHumanPlayEnd(gameId) { if (!this.playEndState || this.playEndState.gameId !== gameId) return;const resolve=this.playEndState.resolve;this.playEndState=null;resolve(true); },
    cancelPendingInteractions() { if(this.playEndState){const resolve=this.playEndState.resolve;this.playEndState=null;resolve(false);} },
    async requestResponse(request) { this.responseRequests.push(request); return response(request); },
    async requestDiscard(player, count) { return player.hand.slice(0, count); },
    async requestTarget(players) { return players[0] ?? null; },
    async requestPublicCard(_player, cards) { this.publicRequests.push(cards.map((card) => card.id)); return cards[0] ?? null; },
    async showPrivateReveal(title, cards = []) { this.reveals.push({ title, cards:[...cards] }); },
    setCurrentCard(cardOrName, source, targetLabel = "") { this.currentCards.push({ cardOrName, source, targetLabel }); }, setPrompt() {}, setThinking(...args) { this.thinking.push(args); }, showGameOver() {}, queueFeedback() {},
    showDying() {}, hideDying() {}, showPublicPool() {}, hidePublicPool() {}, showJudgment() {}, showDuel() {}, hideDuel() {}
  };
}

function makePlayer(id, seatIndex, team, controllerType = "ai", generalIndex = seatIndex % 8) {
  const player = new Player({ id, seatIndex, battleTeam:team, controllerType });
  player.applyGeneral(GENERAL_DEFINITIONS[generalIndex]);
  player.resetRoundFlags();
  return player;
}

function makeGame(players, { random = () => 0.25, response = () => false } = {}) {
  const ui = makeUi(response);
  const game = new Game(ui, random);
  game.state.players = players;
  game.state.currentPlayerIndex = 0;
  game.state.startingPlayerIndex = 0;
  game.state.phase = "play";
  game.simulationMode = true;
  game.cleanupManager.delay = async () => !game.state.isDisposed;
  for (const player of players) {
    player.maxEnergy = game.teamRules.getMaxEnergy(player);
    player.energy = Math.min(player.energy, player.maxEnergy);
    player.resetTurnFlags(game.teamRules.getRules(player));
  }
  game.registerGlobalRules();
  return { game, ui };
}

function makeTeamFixture() {
  const small=makePlayer("small",0,"dawn","ai",0),large=makePlayer("large",1,"dusk","ai",0);
  const smallAlly=makePlayer("small-ally",2,"dawn"),largeAlly1=makePlayer("large-ally-1",3,"dusk"),largeAlly2=makePlayer("large-ally-2",4,"dusk");
  const fixture=makeGame([small,large,smallAlly,largeAlly1,largeAlly2]);
  return {...fixture,small,large};
}

function makeInteractiveElement() {
  const listeners = new Map();
  const classes = new Set(["is-hidden"]);
  return {
    innerHTML:"", listeners,
    classList:{ add:(name)=>classes.add(name), remove:(name)=>classes.delete(name), contains:(name)=>classes.has(name) },
    addEventListener:(type, handler)=>listeners.set(type, handler),
    removeEventListener:(type, handler)=>{ if (listeners.get(type) === handler) listeners.delete(type); },
    click(target) { listeners.get("click")?.({ target }); }
  };
}

function clickTarget(selector, dataset = {}) {
  return { dataset, closest:(query) => query === selector ? { dataset } : null };
}

// 配置、展示资源与注册表（40 项）
for (const general of GENERAL_DEFINITIONS) test(`角色资源：${general.name}具有有效本地肖像`, async () => {
  assert.match(general.portrait, /^\.\/assets\/characters\/[a-z-]+\.svg$/);
  await access(projectFile(general.portrait));
});

for (const definition of Object.values(CARD_DEFINITIONS)) test(`卡牌资源：${definition.name}定义与 SVG 完整`, async () => {
  assert.ok(["basic","tactic","equipment"].includes(definition.category));
  for (const field of ["definitionId","name","categoryName","usageMode","targetType","description","art","icon","accent","frameStyle","flavorText"]) assert.ok(definition[field] !== undefined, `${definition.definitionId}.${field}`);
  assert.ok(Array.isArray(definition.subtypes));
  assert.ok(Array.isArray(definition.responseTypes));
  assert.ok(Array.isArray(definition.selectionFlow));
  assert.match(definition.art, /^\.\/assets\/cards\/[a-z-]+\.svg$/);
  await access(projectFile(definition.art));
  assert.ok(hasCardResolver(definition.definitionId));
});

test("牌组恰有23种定义和155张实体牌", () => { assert.equal(Object.keys(CARD_DEFINITIONS).length, 23); assert.equal(TOTAL_CARD_COUNT, 155); });
test("三种卡牌分类之外没有旧响应分类", () => assert.deepEqual([...new Set(Object.values(CARD_DEFINITIONS).map((card) => card.category))].sort(), ["basic","equipment","tactic"]));
test("旧 support/insight/steal/coreDevice/redirect 定义已删除", () => ["support","insight","steal","coreDevice","redirect"].forEach((id) => assert.equal(CARD_DEFINITIONS[id], undefined)));
test("五种基础牌数量为突袭40、格挡20、调息12、聚能10、护盾10", () => assert.deepEqual(Object.fromEntries(["assault","block","recover","charge","shield"].map((id)=>[id,CARD_DEFINITIONS[id].count])),{assault:40,block:20,recover:12,charge:10,shield:10}));
test("基础牌数量合计92", () => assert.equal(Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0), 92));
test("战术牌数量合计48", () => assert.equal(Object.values(CARD_DEFINITIONS).filter((card) => card.category === "tactic").reduce((sum, card) => sum + card.count, 0), 48));
test("装备牌数量合计15且数量来自统一配置", () => { const equipment = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment"); assert.equal(equipment.reduce((sum, card) => sum + card.count, 0), 15); assert.equal(equipment.length, 6); assert.deepEqual(Object.fromEntries(equipment.map((card)=>[card.definitionId,card.count])),{energyDevice:2,recycleDevice:3,defenseDevice:2,battleDevice:2,telescope:3,barrierDevice:3}); });
test("所有角色技能都存在注册器", () => GENERAL_DEFINITIONS.forEach((general) => { general.passiveSkillIds.forEach((id) => assert.ok(hasPassiveSkill(id))); general.activeSkillIds.forEach((id) => assert.ok(hasActiveSkill(id))); }));
test("所有角色都用稳定英文 roleTags 供 AI 判断职责", () => GENERAL_DEFINITIONS.forEach((general) => { assert.ok(general.roleTags.length >= 2);general.roleTags.forEach((tag)=>assert.match(tag,/^[a-z-]+$/)); }));
test("守誓者最大生命为3且壁垒说明声明临时可叠加", () => { const oath=GENERAL_DEFINITIONS.find((general)=>general.id==="oath-warden");assert.equal(oath.maxHp,3);assert.match(oath.activeDescription,/1点可叠加的壁垒护盾/);assert.match(oath.activeDescription,/下次回合开始/); });
test("八名角色规则配置与README角色介绍一致", async () => { const readme=await readFile(projectFile("README.md"),"utf8");for(const general of GENERAL_DEFINITIONS){assert.match(readme,new RegExp(`### ${general.name}`));assert.ok(readme.includes(general.description));assert.match(readme,new RegExp(`主动·${general.activeName}`));assert.match(readme,new RegExp(`被动·${general.passiveName}`));}const byId=Object.fromEntries(GENERAL_DEFINITIONS.map((general)=>[general.id,general])),expected={"blade-walker":[4,2,1],"oath-warden":[3,2,2],"spirit-medic":[3,2,2],"shade-agent":[4,2,1],"ember-magus":[3,3,1],"trail-hunter":[4,2,2],"fate-gambler":[4,1,1],"resonance-tuner":[4,2,2]};for(const [id,values] of Object.entries(expected)){const general=byId[id],skill=ACTIVE_SKILLS[general.activeSkillIds[0]];assert.deepEqual([general.maxHp,general.activeCost,general.activeLimitPerTurn],values,id);assert.deepEqual([skill.cost,skill.limitPerTurn],values.slice(1),`${id}实际技能`);} });
test("强制 AI 救援真人配置默认开启", () => assert.equal(GAME_CONFIG.forceAiRescueHuman, true));

test("浏览器模块图使用统一构建版本，静态服务器不会复用旧规则模块", async () => {
  const index = await readFile(projectFile("index.html"), "utf8");
  const entry = index.match(/src="\.\/js\/main\.js\?build=([^"]+)"/);
  assert.ok(entry, "入口模块缺少 build 查询参数");
  const expectedBuild = entry[1];
  const stylesheetBuilds = [...index.matchAll(/href="\.\/css\/[^"]+\.css\?build=([^"]+)"/g)].map((match) => match[1]);
  assert.equal(stylesheetBuilds.length, 7, "所有样式表都必须带构建版本");
  stylesheetBuilds.forEach((build) => assert.equal(build, expectedBuild));
  for (const file of await listJavaScriptFiles()) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s+)["'][^"']+\.js(?:\?build=([^"']+))?["']/g)) {
      assert.equal(match[1], expectedBuild, `${file} 存在未版本化或版本不一致的模块依赖：${match[0]}`);
    }
  }
});
test("对局记录计数显示条目单位和明确的辅助说明", () => {
  const countElement = { textContent:"", title:"", setAttribute(name, value) { this[name] = value; } };
  UIManager.prototype.updateLogCount.call({ elements:{ log_count:countElement } }, 62);
  assert.equal(countElement.textContent, "62 条");
  assert.equal(countElement.title, "共 62 条对局记录");
  assert.equal(countElement["aria-label"], "共 62 条对局记录");
});
test("新对局会清空上一局中央结算卡，避免开局显示旧突袭", async () => {
  const currentCard = { innerHTML:"<div>甲对乙使用了突袭</div>", classList:{ remove(){} } };
  UIManager.prototype.resetCurrentCard.call({ elements:{ current_card:currentCard } });
  assert.match(currentCard.innerHTML, /等待第一张牌/);
  assert.doesNotMatch(currentCard.innerHTML, /突袭|作用对象/);
  const source = await readFile(projectFile("js/ui/UIManager.js"), "utf8");
  assert.match(source, /showSelection\([^)]*\)\s*\{[\s\S]*?this\.resetCurrentCard\(\)/);
  assert.match(source, /showGame\([^)]*\)\s*\{[\s\S]*?this\.resetCurrentCard\(\)/);
});
test("响应窗口保持居中浮层原布局且中央结算卡在普通阶段下移", async () => {
  const css = await readFile(projectFile("css/layout.css"), "utf8");
  assert.match(css, /\.current-card\s*\{[^}]*translateY\(clamp\(20px,\s*2\.4vh,\s*30px\)\)/s);
  assert.match(css, /:has\(\.response-panel:not\(\.is-hidden\)\)\s+\.current-card\s*\{[^}]*translateY\(clamp\(26px,\s*3vh,\s*38px\)\)/s);
  assert.match(css, /\.private-reveal,\s*\.response-panel,\s*\.public-pool-view\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*top:\s*50%[^}]*translate\(-50%,\s*-50%\)/s);
  assert.doesNotMatch(css, /\.response-panel\.is-card-response/);
});

// 牌堆、阵营、距离和次数补偿
test("Deck 创建155个唯一实体 card.id", () => { const deck = new Deck(() => .4); assert.equal(deck.build(), 155); assert.equal(new Set(deck.cards.map((card) => card.id)).size, 155); });
test("结算区不会进入重洗", () => { const deck = new Deck(() => .4); deck.build(); const resolving = deck.drawOne(); const discard = deck.drawOne(); deck.beginResolve(resolving); deck.discard(discard); deck.cards = []; deck.reshuffle(); assert.equal(deck.cards.length, 1); assert.equal(deck.resolvingCards[0], resolving); });
test("判定区不会进入重洗", () => { const deck = new Deck(() => .4); deck.build(); const judgment = deck.drawToJudgment(); const discard = deck.drawOne(); deck.discard(discard); deck.cards = []; deck.reshuffle(); assert.equal(deck.cards.length, 1); assert.equal(deck.judgmentZone[0], judgment); });
test("重洗计数会准确累加", () => { const deck = new Deck(); deck.discardPile.push(instance("charge")); deck.reshuffle(); assert.equal(deck.reshuffleCount, 1); });
test("阵营始终严格2V3", () => { for (let i=0;i<50;i+=1) { const teams = TeamManager.assignTeams(() => (i % 17) / 17); const dawn=teams.filter((t)=>t==="dawn").length; const dusk=teams.filter((t)=>t==="dusk").length; assert.deepEqual([dawn,dusk].sort(),[2,3]); } });
test("小队两名成员在环形座位上不相邻", () => { for (let i=0;i<40;i+=1) { const teams=TeamManager.assignTeams(() => (i%19)/19); const small=["dawn","dusk"].find((team)=>teams.filter((entry)=>entry===team).length===2); const seats=teams.map((team,index)=>team===small?index:-1).filter((index)=>index>=0); const raw=Math.abs(seats[0]-seats[1]); assert.ok(Math.min(raw,5-raw)>1); } });
test("真人座位可以随机进入小队或大队", () => { const sizes=new Set(); for(let i=0;i<60;i+=1){const teams=TeamManager.assignTeams(()=>((i*7)%61)/61); sizes.add(teams.filter((team)=>team===teams[0]).length);} assert.deepEqual([...sizes].sort(),[2,3]); });
test("环形距离取顺时针与逆时针较小值", () => { const ps=Array.from({length:5},(_,i)=>({id:`p${i}`,seatIndex:i,alive:true})); const game={state:{players:ps}}; assert.equal(DistanceSystem.getDistance(game,ps[0],ps[4]),1); assert.equal(DistanceSystem.getDistance(game,ps[0],ps[2]),2); });
test("望远镜令装备者计算到其他角色的距离减1且最低为1", () => { const ps=Array.from({length:5},(_,i)=>makePlayer(`p${i}`,i,i<2?"dawn":"dusk"));const {game}=makeGame(ps);ps[0].equipment=instance("telescope");assert.equal(DistanceSystem.getDistance(game,ps[0],ps[2]),1);assert.equal(DistanceSystem.getDistance(game,ps[0],ps[1]),1);assert.equal(DistanceSystem.getDistance(game,ps[2],ps[0]),2); });
test("屏障令其他角色计算到装备者的距离加1但不影响装备者主动测距", () => { const ps=Array.from({length:5},(_,i)=>makePlayer(`p${i}`,i,i<2?"dawn":"dusk"));const {game}=makeGame(ps);ps[1].equipment=instance("barrierDevice");assert.equal(DistanceSystem.getDistance(game,ps[0],ps[1]),2);assert.equal(DistanceSystem.getDistance(game,ps[1],ps[0]),1); });
test("望远镜和屏障在同一条方向距离上依次生效", () => { const ps=Array.from({length:5},(_,i)=>makePlayer(`p${i}`,i,i<2?"dawn":"dusk"));const {game}=makeGame(ps);ps[0].equipment=instance("telescope");ps[2].equipment=instance("barrierDevice");assert.equal(DistanceSystem.getDistance(game,ps[0],ps[2]),2); });
test("距离装备即时改变普通突袭合法目标且AI快照使用相同修正", () => { const source=makePlayer("source",0,"dawn"),ally=makePlayer("ally",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dusk"),assault=instance("assault");const {game}=makeGame([source,ally,target,other,tail]);source.hand.push(assault);assert.ok(!RuleEngine.getCardTargets(game,source,assault).includes(target));source.equipment=instance("telescope");assert.ok(RuleEngine.getCardTargets(game,source,assault).includes(target));const visible=createAiVisibleState(source.id,game.state);assert.equal(DistanceSystem.getDistance({state:{players:visible.players}},visible.players[0],visible.players[2]),1);target.equipment=instance("barrierDevice");assert.ok(!RuleEngine.getCardTargets(game,source,assault).includes(target)); });
test("AI深层模拟装备望远镜后会生成新进入距离的突袭目标", () => { const source=makePlayer("source",0,"dawn"),ally=makePlayer("ally",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dusk"),telescope=instance("telescope"),assault=instance("assault");source.hand.push(telescope,assault);const {game}=makeGame([source,ally,target,other,tail]),visible=createAiVisibleState(source.id,game.state),equipAction=game.aiController.actionGenerator.generateFromVisible(visible,source.id).find((action)=>action.card?.id===telescope.id),equipped=new AiSimulator(visible).apply(visible,equipAction,source.id),follow=game.aiController.actionGenerator.generateFromVisible(equipped,source.id);assert.ok(follow.some((action)=>action.card?.id===assault.id&&action.targets[0]?.id===target.id)); });
test("普通突袭只能选择距离1内敌人", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dusk"),makePlayer("d",3,"dawn"),makePlayer("e",4,"dusk")]; const {game}=makeGame(ps); ps[0].hand.push(instance("assault")); assert.deepEqual(RuleEngine.getCardTargets(game,ps[0],ps[0].hand[0]).map((p)=>p.id),["b","e"]); });
test("震荡与决斗显式无视距离", () => { assert.equal(CARD_DEFINITIONS.shockwave.ignoresDistance,true); assert.equal(CARD_DEFINITIONS.duel.ignoresDistance,true); });
test("震荡与挑衅都使用逐目标反制作用域", () => { assert.equal(CARD_DEFINITIONS.shockwave.counterScope,"target");assert.equal(CARD_DEFINITIONS.provoke.counterScope,"target"); });
test("七种全局或指定型卡牌显式无视距离", () => { for (const id of ["shockwave","provoke","scout","destroy","duel","mutualBenefit","symbiosis"]) assert.equal(CARD_DEFINITIONS[id].ignoresDistance,true,id); });
test("每个主动技能都显式声明距离规则", () => { for (const skill of Object.values(ACTIVE_SKILLS)) assert.ok(["attack","fixed","unlimited","ally","self"].includes(skill.rangeRule),skill.id); });
test("小队规则为开局5张、每回合摸3张、突袭2、调息无限、回合能量1、能量上限4", () => { const {game,small}=makeTeamFixture();const rules=game.teamRules;assert.equal(rules.getInitialHandCount(small),5);assert.equal(rules.getDrawCount(small),3);assert.equal(rules.getAttackLimit(small),2);assert.equal(rules.getRecoverLimit(small),null);assert.equal(rules.getTurnEnergyGain(small),1);assert.equal(rules.getMaxEnergy(small),4);assert.equal(small.maxEnergy,4); });
test("大队规则为开局4张、每回合摸2张、突袭1、调息无限、回合能量1、能量上限3", () => { const {game,large}=makeTeamFixture();const rules=game.teamRules;assert.equal(rules.getInitialHandCount(large),4);assert.equal(rules.getDrawCount(large),2);assert.equal(rules.getAttackLimit(large),1);assert.equal(rules.getRecoverLimit(large),null);assert.equal(rules.getTurnEnergyGain(large),1);assert.equal(rules.getMaxEnergy(large),3);assert.equal(large.maxEnergy,3); });
test("回合摸牌事件按二人阵营3张、三人阵营2张取值", async () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dawn"),makePlayer("d",3,"dusk"),makePlayer("e",4,"dusk")];const {game}=makeGame(ps);const counts=[];game.eventBus.on("beforeDraw","test:team-draw",(event)=>counts.push(event.count));game.aiController.selectAction=async()=>({type:"end"});game.state.deck.cards.push(instance("block"),instance("charge"),instance("recover"));await game.takeTurn(ps[0],game.state.gameId);game.state.currentPlayerIndex=1;game.state.deck.cards.push(instance("block"),instance("charge"));await game.takeTurn(ps[1],game.state.gameId);assert.deepEqual(counts,[3,2]); });
test("二人小队无装备时每回合实际获得1点能量", async () => { const {game,small}=makeTeamFixture();game.aiController.selectAction=async()=>({type:"end"});await game.takeTurn(small,game.state.gameId);assert.equal(small.energy,1);assert.deepEqual(game.teamRules.getTurnEnergyBreakdown(small),{baseAmount:1,teamBonus:0,equipmentBonus:0}); });
test("三人小队无装备时每回合实际获得1点能量", async () => { const {game,large}=makeTeamFixture();game.state.currentPlayerIndex=large.seatIndex;game.aiController.selectAction=async()=>({type:"end"});await game.takeTurn(large,game.state.gameId);assert.equal(large.energy,1);assert.deepEqual(game.teamRules.getTurnEnergyBreakdown(large),{baseAmount:1,teamBonus:0,equipmentBonus:0}); });
test("二人小队能量最多积累到4", async () => { const {game,small}=makeTeamFixture();small.energy=3;assert.equal(await game.gainEnergy(small,3,{reason:"测试"}),1);assert.equal(small.energy,4); });
test("三人小队能量最多积累到3", async () => { const {game,large}=makeTeamFixture();large.energy=2;assert.equal(await game.gainEnergy(large,3,{reason:"测试"}),1);assert.equal(large.energy,3); });
test("充能桩只给回合能量额外+1", () => { const {game,small}=makeTeamFixture();small.equipment=instance("energyDevice");assert.equal(game.teamRules.getTurnEnergyGain(small),2);assert.deepEqual(game.teamRules.getTurnEnergyBreakdown(small),{baseAmount:1,teamBonus:0,equipmentBonus:1});small.equipment=instance("battleDevice");assert.equal(game.teamRules.getTurnEnergyGain(small),1); });
test("回合基础能量和阵营加成都由规则配置读取而非服务层硬编码", () => { const {game,small}=makeTeamFixture();const original=game.teamRules.getRules;game.teamRules.getRules=()=>({turnEnergyGain:2,turnEnergyBonus:3});assert.deepEqual(game.teamRules.getTurnEnergyBreakdown(small),{baseAmount:2,teamBonus:3,equipmentBonus:0});assert.equal(game.teamRules.getTurnEnergyGain(small),5);game.teamRules.getRules=original; });
test("满生命角色即使持有调息也不能主动使用", () => { const {game,small,large}=makeTeamFixture();for(const player of [small,large]){game.state.currentPlayerIndex=player.seatIndex;const recover=instance("recover");player.hand.push(recover);assert.equal(RuleEngine.canPlayCard(game,player,recover).ok,false);} });
test("角色面板不再显示突袭和调息次数栏", () => { const {small,large}=makeTeamFixture();for(const player of [small,large]){const markup=playerPanelTemplate(player,{isHuman:true});assert.doesNotMatch(markup,/turn-usage|突袭 \d+\/|调息 \d+\//);} });
test("真人角色能力按主动在上、被动在下展示且不混入人物介绍", () => { const player=makePlayer("human",0,"dawn","human",0),markup=playerPanelTemplate(player,{isHuman:true});const activeIndex=markup.indexOf(player.general.activeName),passiveIndex=markup.indexOf(player.general.passiveName);assert.ok(activeIndex>=0&&passiveIndex>activeIndex);assert.match(markup,/主动技能/);assert.match(markup,/被动技能/);assert.match(markup,new RegExp(player.general.activeDescription));assert.match(markup,new RegExp(player.general.passiveDescription));assert.doesNotMatch(markup,new RegExp(player.general.description)); });
test("角色状态取代座位栏且护盾只在独立资源栏显示", () => { const player=makePlayer("human",0,"dawn","human",0);player.shield=2;let markup=playerPanelTemplate(player,{isHuman:true});assert.match(markup,/class="panel-status"/);assert.match(markup,/>状态<\/small><b>—<\/b>/);assert.match(markup,/resource-pill shield[^>]*><small>护盾<\/small><strong>2<\/strong>/);assert.doesNotMatch(markup,/状态<\/small><b>[^<]*护盾|状态稳定|status-row|status-chip|座位\s*\d/);player.statuses.exposeWeakness={stacks:2};player.statuses.huntMark={sourceId:"hunter"};markup=playerPanelTemplate(player,{isHuman:true,distanceInfo:{distance:1,range:1,seat:3},distanceState:"距离 1 · 可突袭"});assert.match(markup,/状态<\/small><b>破势 2 · 猎印<\/b>/);assert.match(markup,/距离 1 · 可突袭/);assert.match(markup,/射程 1/);assert.doesNotMatch(markup,/状态<\/small><b>[^<]*护盾|座位\s*3/); });
test("刃行者使用不同类别卡牌会增加并公开显示连势且命中后消耗", async () => { const blade=makePlayer("blade",0,"dawn","ai",0),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk","ai",0);const {game}=makeGame([blade,ally,enemy]);registerPassiveSkills(game);const charge=instance("charge"),harvest=instance("harvest"),assault=instance("assault");blade.hand.push(charge,harvest,assault);game.state.deck.cards.push(instance("block"),instance("shield"));assert.equal(await game.playCard(blade,charge,[blade]),true);assert.equal(blade.turnFlags.momentum,1);assert.equal(await game.playCard(blade,harvest,[]),true);assert.equal(blade.turnFlags.momentum,2);assert.match(playerPanelTemplate(blade,{humanTeam:"dawn"}),/状态<\/small><b>连势 2<\/b>/);const hp=enemy.hp;assert.equal(await game.playCard(blade,assault,[enemy]),true);assert.equal(enemy.hp,hp-3);assert.equal(blade.turnFlags.momentum,0);assert.doesNotMatch(playerPanelTemplate(blade,{humanTeam:"dawn"}),/连势 \d/); });
test("壁垒每次提供1点临时护盾且重复施放可以叠加", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn", "ai", 1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;target.shield=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,3);assert.deepEqual(target.statuses.temporaryShield,{amount:1,clearAtTurnStart:true});source.energy=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,4);assert.equal(target.statuses.temporaryShield.amount,2); });
test("壁垒护盾被伤害优先消耗且不影响已有护盾", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn", "ai", 1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;target.shield=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);const hp=target.hp;await game.damage(enemy,target,1,{canBlock:false});assert.equal(target.hp,hp);assert.equal(target.shield,2);assert.equal(target.statuses.temporaryShield,undefined); });
test("叠加后未消耗的壁垒护盾在目标下回合开始时统一消散", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn", "ai", 1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);target.shield=2;source.energy=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);source.energy=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,4);game.state.currentPlayerIndex=1;game.state.deck.cards.push(instance("block"),instance("charge"));game.aiController.selectAction=async()=>({type:"end"});await game.takeTurn(target,game.state.gameId);assert.equal(target.shield,2);assert.equal(target.statuses.temporaryShield,undefined); });
test("README中的主动技能消耗与每回合次数进入实际规则", async () => { const warden=makePlayer("warden",0,"dawn","ai",1),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([warden,ally,enemy]);warden.energy=4;assert.equal(await game.useActiveSkill(warden,"barrier",[ally]),true);assert.equal(await game.useActiveSkill(warden,"barrier",[ally]),true);warden.energy=2;assert.equal(await game.useActiveSkill(warden,"barrier",[ally]),false);assert.equal(warden.turnFlags.activeSkillUseCounts.barrier,2);const blade=makePlayer("blade",0,"dawn","ai",0),bladeAlly=makePlayer("blade-ally",1,"dawn"),bladeEnemy=makePlayer("blade-enemy",2,"dusk");const {game:bladeGame}=makeGame([blade,bladeAlly,bladeEnemy]);blade.energy=2;assert.equal(await bladeGame.useActiveSkill(blade,"breakArmy",[]),true);assert.equal(blade.energy,0);assert.equal(blade.turnFlags.attackLimit,3); });
test("灵医共生按README恢复1点且每回合可发动2次", async () => { const medic=makePlayer("medic",0,"dawn","ai",2),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");ally.hp-=2;const {game}=makeGame([medic,ally,enemy]);medic.energy=4;const medicHp=medic.hp;assert.equal(await game.useActiveSkill(medic,"symbiosis",[ally]),true);assert.equal(await game.useActiveSkill(medic,"symbiosis",[ally]),true);assert.equal(ally.hp,ally.maxHp);assert.equal(medic.hp,medicHp); });
test("影客窥隙查看至多2张随机实体牌且人物生命和窃取消耗符合README", async () => { const shade=makePlayer("shade",0,"dawn","human",3),enemy=makePlayer("enemy",1,"dusk");enemy.hand.push(instance("assault"),instance("recover"),instance("charge"));const {game}=makeGame([shade,enemy],{random:()=>0});registerPassiveSkills(game);await game.eventBus.emit("afterDamage",{source:shade,target:enemy,actualAmount:1});assert.equal(shade.maxHp,4);assert.equal(ACTIVE_SKILLS.stealSkill.cost,2);assert.equal(Object.keys(shade.aiMemory.knownCardsByPlayer[enemy.id]).length,2); });
test("赌命者冒险失败不再随机弃牌", async () => { const gambler=makePlayer("gambler",0,"dawn","ai",6),enemy=makePlayer("enemy",1,"dusk"),kept=instance("block");gambler.hand.push(kept);const {game}=makeGame([gambler,enemy],{random:()=>.99});registerPassiveSkills(game);await game.eventBus.emit("cardUsed",{source:gambler,card:instance("harvest"),targets:[]});assert.ok(gambler.hand.includes(kept));assert.equal(gambler.hand.length,1); });
test("赌命者孤注消耗全部能量并摸取等量牌，按30x%概率进入状态", async () => {
  for (const [energy, roll, expected] of [[1,.29,true],[1,.3,false],[2,.59,true],[2,.6,false],[3,.89,true],[3,.9,false],[4,.999,true]]) {
    const gambler=makePlayer(`gambler-${energy}-${roll}`,0,"dawn","ai",6),enemy=makePlayer(`enemy-${energy}-${roll}`,1,"dusk");
    const {game}=makeGame([gambler,enemy],{random:()=>roll});registerPassiveSkills(game);
    game.state.deck.cards.push(...Array.from({length:energy},()=>instance("charge")));
    gambler.energy=energy;
    assert.equal(await game.useActiveSkill(gambler,"allIn",[]),true);
    assert.equal(gambler.energy,0);
    assert.equal(gambler.hand.length,energy);
    assert.equal(Boolean(gambler.statuses.allIn),expected,`${energy}点能量，随机数${roll}`);
    gambler.energy=1;
    assert.equal(await game.useActiveSkill(gambler,"allIn",[]),false,"一回合只能使用1次");
  }
});
test("孤注状态不可叠加、跨回合保留，并在下一次突袭完毕后退出", async () => {
  const gambler=makePlayer("gambler",0,"dawn","ai",6),target=makePlayer("target",1,"dusk","human"),ally=makePlayer("ally",2,"dawn"),assault=instance("assault");
  gambler.hand.push(assault);
  const {game}=makeGame([gambler,target,ally],{random:()=>0});registerPassiveSkills(game);
  game.state.deck.cards.push(instance("charge"),instance("shield"),instance("block"));
  gambler.energy=3;await game.useActiveSkill(gambler,"allIn",[]);
  gambler.resetTurnFlags(game.teamRules.getRules(gambler));
  assert.deepEqual(gambler.statuses.allIn,{assaultBonus:1});
  gambler.energy=1;
  assert.deepEqual(ACTIVE_SKILLS.allIn.canUse(game,gambler),{ok:false,reason:"已处于孤注状态"});
  const hp=target.hp;await game.playCard(gambler,assault,[target]);
  assert.equal(target.hp,hp-2);assert.equal(gambler.statuses.allIn,undefined);
});
test("孤注强化的突袭被格挡后也会退出状态", async () => {
  const gambler=makePlayer("blocked-gambler",0,"dawn","ai",6),target=makePlayer("blocked-target",1,"dusk","human"),ally=makePlayer("blocked-ally",2,"dawn"),assault=instance("assault");
  gambler.hand.push(assault);target.hand.push(instance("block"));
  const {game}=makeGame([gambler,target,ally],{response:()=>true,random:()=>0});registerPassiveSkills(game);
  game.state.deck.cards.push(instance("charge"));
  gambler.energy=1;await game.useActiveSkill(gambler,"allIn",[]);
  await game.playCard(gambler,assault,[target]);
  assert.equal(gambler.statuses.allIn,undefined);
});
test("炎术师余烬每个卡牌结算ID最多触发1次", async () => { const ember=makePlayer("ember",0,"dawn","ai",4),enemyA=makePlayer("enemy-a",1,"dusk"),enemyB=makePlayer("enemy-b",2,"dusk");const {game}=makeGame([ember,enemyA,enemyB]);registerPassiveSkills(game);const card=instance("shockwave");await game.eventBus.emit("afterDamage",{source:ember,target:enemyA,actualAmount:1,card,resolutionId:"same"});await game.eventBus.emit("afterDamage",{source:ember,target:enemyB,actualAmount:1,card,resolutionId:"same"});assert.equal(ember.energy,1);await game.eventBus.emit("afterDamage",{source:ember,target:enemyB,actualAmount:1,card,resolutionId:"next"});assert.equal(ember.energy,2); });
test("调律师协调每回合只触发一次且共鸣可发动2次", async () => { const tuner=makePlayer("tuner",0,"dawn","ai",7),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([tuner,ally,enemy]);registerPassiveSkills(game);game.state.deck.cards.push(instance("assault"),instance("block"));await game.eventBus.emit("cardUsed",{source:tuner,card:instance("shield"),targets:[ally]});await game.eventBus.emit("cardUsed",{source:tuner,card:instance("shield"),targets:[ally]});assert.equal(tuner.hand.length,1);game.state.deck.cards.push(instance("assault"),instance("block"),instance("charge"),instance("shield"));tuner.energy=4;assert.equal(await game.useActiveSkill(tuner,"resonance",[ally]),true);assert.equal(await game.useActiveSkill(tuner,"resonance",[ally]),true);assert.equal(ally.hand.length,4);assert.equal(tuner.turnFlags.activeSkillUseCounts.resonance,2); });
test("追猎者猎杀被格挡后摸1张且每回合上限为2次", async () => { const hunter=makePlayer("hunter",0,"dawn","ai",5),target=makePlayer("target",1,"dusk","human"),ally=makePlayer("ally",2,"dawn");target.statuses.huntMark={sourceId:hunter.id};target.hand.push(instance("block"));const {game}=makeGame([hunter,target,ally],{response:()=>true});game.state.deck.cards.push(instance("charge"));hunter.energy=2;assert.equal(await game.useActiveSkill(hunter,"hunt",[target]),true);assert.equal(hunter.hand.length,1);assert.equal(hunter.turnFlags.activeSkillUseCounts.hunt,1);assert.equal(ACTIVE_SKILLS.hunt.limitPerTurn,2); });
test("技能详情使用结构化的每回合发动次数", () => { const warden=makePlayer("warden",0,"dawn","human",1),markup=skillDetailsTemplate(warden);assert.match(markup,/每回合限发动2次/); });
test("赌命者技能详情显示等量摸牌、30x%概率和每回合1次", () => { const gambler=makePlayer("gambler",0,"dawn","human",6),markup=skillDetailsTemplate(gambler);assert.match(markup,/摸取等量牌/);assert.match(markup,/30×消耗能量%/);assert.match(markup,/每回合限发动1次/); });
test("赌命者候选卡将孤注消耗显示为 X 能量", () => { const gambler=GENERAL_DEFINITIONS.find((general)=>general.id==="fate-gambler"),markup=candidateCardTemplate(gambler,0);assert.match(markup,/主动 · 孤注/);assert.match(markup,/<small>X 能量<\/small>/);assert.doesNotMatch(markup,/<small>1 能量<\/small>/); });
test("角色候选卡统一将主动技能显示在被动技能上方", () => { for(const [index,general] of GENERAL_DEFINITIONS.entries()){const markup=candidateCardTemplate(general,index),active=markup.indexOf(`主动 · ${general.activeName}`),passive=markup.indexOf(`被动 · ${general.passiveName}`);assert.ok(active>=0&&passive>=0&&active<passive,general.name);} });

test("护盾牌可选择自己或任意存活队友但不能选择敌人和阵亡队友", () => { const source=makePlayer("source",0,"dawn"),ally=makePlayer("ally",1,"dawn"),dead=makePlayer("dead",2,"dawn"),enemy=makePlayer("enemy",3,"dusk");dead.alive=false;const {game}=makeGame([source,ally,dead,enemy]),card=instance("shield");source.hand.push(card);assert.deepEqual(RuleEngine.getCardTargets(game,source,card).map((player)=>player.id),[source.id,ally.id]);assert.equal(RuleEngine.targetLegality(game,source,card,enemy).ok,false); });
test("护盾牌可为自己使用并在队友身上永久叠加", async () => { const source=makePlayer("source",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([source,ally,enemy]),selfCard=instance("shield"),first=instance("shield"),second=instance("shield");source.hand.push(selfCard,first,second);assert.equal(await game.playCard(source,selfCard,[source]),true);assert.equal(source.shield,1);assert.equal(await game.playCard(source,first,[ally]),true);assert.equal(await game.playCard(source,second,[ally]),true);assert.equal(ally.shield,2);assert.equal(ally.statuses.temporaryShield,undefined); });
test("护盾牌提供的护盾不会在目标回合开始时归零", async () => { const source=makePlayer("source",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([source,ally,enemy]),card=instance("shield");source.hand.push(card);await game.playCard(source,card,[ally]);game.state.currentPlayerIndex=1;game.state.deck.cards.push(instance("assault"),instance("block"),instance("charge"));game.aiController.selectAction=async()=>({type:"end"});await game.takeTurn(ally,game.state.gameId);assert.equal(ally.shield,1); });
test("每点护盾免疫1点伤害并在免疫后消耗", async () => { const attacker=makePlayer("attacker",0,"dusk"),target=makePlayer("target",1,"dawn");const {game}=makeGame([attacker,target]);target.shield=2;const hp=target.hp,actual=await game.damage(attacker,target,3,{canBlock:false});assert.equal(target.shield,0);assert.equal(target.hp,hp-1);assert.equal(actual,1); });
test("护盾牌提交敌方目标会在核心层拒绝且不消耗实体牌", async () => { const source=makePlayer("source",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),card=instance("shield");const {game}=makeGame([source,enemy]);source.hand.push(card);assert.equal(await game.playCard(source,card,[enemy]),false);assert.ok(source.hand.includes(card));assert.equal(enemy.shield,0); });

// 动态存活座位环（16 项）
const distanceFixture = () => { const players=[makePlayer("A",0,"dawn"),makePlayer("B",1,"dusk"),makePlayer("C",2,"dusk"),makePlayer("D",3,"dawn"),makePlayer("E",4,"dusk")]; return { players, game:makeGame(players).game }; };
test("动态距离1：五人全存活时固定相邻距离为1", () => { const {players,game}=distanceFixture();assert.equal(DistanceSystem.getDistance(game,players[0],players[1]),1); });
test("动态距离2：五人全存活时隔一人距离为2", () => { const {players,game}=distanceFixture();assert.equal(DistanceSystem.getDistance(game,players[0],players[2]),2); });
test("动态距离3：中间角色阵亡后两侧由2变1", () => { const {players,game}=distanceFixture();players[1].alive=false;assert.equal(DistanceSystem.getDistance(game,players[0],players[2]),1); });
test("动态距离4：连续两人阵亡后距离继续压缩", () => { const {players,game}=distanceFixture();players[1].alive=false;players[3].alive=false;assert.equal(DistanceSystem.getDistance(game,players[2],players[4]),1); });
test("动态距离5：三名存活角色任意两人距离均为1", () => { const {players,game}=distanceFixture();players[1].alive=false;players[3].alive=false;for(const a of [players[0],players[2],players[4]])for(const b of [players[0],players[2],players[4]])if(a!==b)assert.equal(DistanceSystem.getDistance(game,a,b),1); });
test("动态距离6：两名存活角色之间距离为1", () => { const {players,game}=distanceFixture();players.slice(1,4).forEach((p)=>p.alive=false);assert.equal(DistanceSystem.getDistance(game,players[0],players[4]),1); });
test("动态距离7：阵亡角色的距离为 Infinity", () => { const {players,game}=distanceFixture();players[1].alive=false;assert.equal(DistanceSystem.getDistance(game,players[0],players[1]),Infinity); });
test("动态距离8：存活角色到自身距离为0", () => { const {players,game}=distanceFixture();assert.equal(DistanceSystem.getDistance(game,players[0],players[0]),0); });
test("动态距离9：存活队友仍占据距离，不能穿过队友", () => { const players=[makePlayer("A",0,"dawn"),makePlayer("B",1,"dawn"),makePlayer("C",2,"dusk"),makePlayer("D",3,"dusk")];const {game}=makeGame(players);assert.equal(DistanceSystem.getDistance(game,players[0],players[2]),2);assert.equal(DistanceSystem.getDistance(game,players[0],players[3]),1); });
test("动态距离10：普通突袭在阵亡后立即出现新合法目标", () => { const {players,game}=distanceFixture();const assault=instance("assault");players[0].hand.push(assault);assert.ok(!RuleEngine.getCardTargets(game,players[0],assault).includes(players[2]));players[1].alive=false;assert.ok(RuleEngine.getCardTargets(game,players[0],assault).includes(players[2])); });
test("动态距离11：震荡和决斗始终显式忽略距离", () => { assert.equal(CARD_DEFINITIONS.shockwave.ignoresDistance,true);assert.equal(CARD_DEFINITIONS.duel.ignoresDistance,true); });
test("动态距离12：UI 距离文案可在阵亡后从2更新为1", () => { const {players,game}=distanceFixture();let info=DistanceSystem.describe(game,players[0],players[2]);let markup=playerPanelTemplate(players[2],{humanTeam:"dawn",distanceInfo:info,distanceState:`距离 ${info.distance} · 超出攻击范围`});assert.match(markup,/距离 2 · 超出攻击范围/);players[1].alive=false;info=DistanceSystem.describe(game,players[0],players[2]);markup=playerPanelTemplate(players[2],{humanTeam:"dawn",distanceInfo:info,distanceState:`距离 ${info.distance} · 可突袭`});assert.match(markup,/距离 1 · 可突袭/); });
test("动态距离13：AI 动作生成不根据固定 seatIndex 攻击", () => { const {players,game}=distanceFixture();const assault=instance("assault");players[0].hand.push(assault);players[1].alive=false;const targets=game.aiController.getLegalActions(players[0]).filter((action)=>action.card?.id===assault.id).map((action)=>action.targets[0].id);assert.ok(targets.includes("C")); });
test("动态距离14：AI 模拟识别先击杀中间角色再攻击新相邻敌人", async () => { const {players,game}=distanceFixture();players[0].turnFlags.attackLimit=2;players[1].hp=1;players[0].hand.push(instance("assault"),instance("assault"));game.aiSearchBudgetOverrideMs=100;await game.aiController.selectAction(players[0],{gameId:game.state.gameId});assert.equal(game.aiController.planner.lastSearchStats.discoveredDynamicTarget,true); });
test("动态距离15：每次调用都读取实时 alive，不使用整局缓存", () => { const {players,game}=distanceFixture();assert.equal(DistanceSystem.getDistance(game,players[0],players[2]),2);players[1].alive=false;assert.equal(DistanceSystem.getDistance(game,players[0],players[2]),1);players[1].alive=true;assert.equal(DistanceSystem.getDistance(game,players[0],players[2]),2); });
test("动态距离16：新 Game 使用自己的全新存活环", () => { const first=distanceFixture(),second=distanceFixture();first.players[1].alive=false;assert.equal(DistanceSystem.getDistance(first.game,first.players[0],first.players[2]),1);assert.equal(DistanceSystem.getDistance(second.game,second.players[0],second.players[2]),2); });

// 基础牌、战术牌与公开/隐藏移动
test("普通突袭计入次数并造成伤害", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk"); const {game}=makeGame([a,b]); const c=instance("assault"); a.hand.push(c); await game.playCard(a,c,[b]); assert.equal(a.turnFlags.attackUsed,1); assert.equal(b.hp,b.maxHp-1); });
test("真人没有格挡时仍出现完整响应窗口，但不能凭空格挡", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game,ui}=makeGame([a,b],{response:()=>true});const hp=b.hp,assault=instance("assault");await game.damage(a,b,1,{card:assault,canBlock:true,damageType:"normal"});assert.equal(ui.responseRequests.length,1);const request=ui.responseRequests[0];assert.deepEqual(request.legalCardIds,[]);assert.equal(request.requiredCount,1);assert.match(request.presentation.eventText,new RegExp(`${a.name}.*你.*突袭`));assert.match(request.presentation.availabilityText,/当前 0 张/);assert.equal(canSubmitResponse(request),false);assert.equal(b.hp,hp-1); });
test("AI 没有合法响应牌时立即跳过且不创建真人响应请求", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","ai");const {game,ui}=makeGame([a,b]);const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(ui.responseRequests.length,0);assert.equal(ui.thinking.length,0);assert.equal(b.hp,hp-1); });
test("真人没有反制也按座次获得一次响应窗口", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human");const {game,ui}=makeGame([a,b,c]);a.hand.push(instance("harvest"));game.state.deck.cards.push(instance("charge"),instance("block"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(ui.responseRequests.filter((request)=>request.type==="counter").map((request)=>request.targetPlayerId),[b.id,c.id]);assert.ok(ui.responseRequests.every((request)=>request.legalCardIds.length===0)); });
test("格挡确认只在合法牌数达到要求时可用", () => { assert.equal(canSubmitResponse({requiredCount:1,legalCardIds:[]}),false);assert.equal(canSubmitResponse({requiredCount:2,legalCardIds:["one"]}),false);assert.equal(canSubmitResponse({requiredCount:2,legalCardIds:["one","two"]}),true); });
test("响应窗口显示真实持有数量但只消耗所需格挡", async () => { const source=makePlayer("source",0,"dusk"),target=makePlayer("target",1,"dawn","human");target.hand.push(instance("block"),instance("block"),instance("block"));const {game,ui}=makeGame([source,target],{response:()=>true});await game.damage(source,target,1,{card:instance("assault"),canBlock:true,damageType:"normal"});const request=ui.responseRequests.find((entry)=>entry.type==="block");assert.equal(request.presentation.availableCount,3);assert.equal(request.legalCardIds.length,3);assert.match(request.presentation.availabilityText,/需要 1 张格挡，当前 3 张/);assert.equal(target.hand.filter((card)=>card.definitionId==="block").length,2); });
test("军火库响应显示完整数量并原子消耗两张格挡", async () => { const source=makePlayer("source",0,"dusk"),target=makePlayer("target",1,"dawn","human");source.equipment=instance("battleDevice");target.hand.push(instance("block"),instance("block"),instance("block"));const {game,ui}=makeGame([source,target],{response:()=>true});await game.damage(source,target,1,{card:instance("assault"),canBlock:true,damageType:"normal"});const request=ui.responseRequests.find((entry)=>entry.type==="block");assert.equal(request.requiredCount,2);assert.equal(request.presentation.availableCount,3);assert.match(request.presentation.availabilityText,/需要 2 张格挡，当前 3 张/);assert.equal(target.hand.filter((card)=>card.definitionId==="block").length,1); });
test("反制、强制突袭与濒死调息显示完整持有数量", async () => { const source=makePlayer("source",0,"dusk"),responder=makePlayer("responder",1,"dawn","human"),target=makePlayer("target",2,"dawn");const {game,ui}=makeGame([source,responder,target],{response:()=>true});responder.hand.push(instance("counter"),instance("counter"),instance("counter"));await game.responseSystem.requestCardResponse(responder,"counter",{source,target,card:instance("harvest")},1);let request=ui.responseRequests.at(-1);assert.equal(request.presentation.availableCount,3);assert.equal(responder.hand.filter((card)=>card.definitionId==="counter").length,2);responder.hand.push(instance("assault"),instance("assault"),instance("assault"),instance("assault"));await game.responseSystem.requestAssaultDiscard(responder,"决斗",{source,target:responder,card:instance("duel")});request=ui.responseRequests.at(-1);assert.equal(request.presentation.availableCount,4);assert.match(request.presentation.availabilityText,/当前 4 张/);target.hp=0;responder.hand.push(instance("recover"),instance("recover"));await game.responseSystem.requestDyingRescue(responder,target,responder.hand.find((card)=>card.definitionId==="recover"));request=ui.responseRequests.at(-1);assert.equal(request.presentation.availableCount,2);assert.match(request.presentation.availabilityText,/当前 2 张/);assert.equal(responder.hand.filter((card)=>card.definitionId==="recover").length,1); });
test("响应事件中的角色和卡牌名称会在写入 DOM 前安全转义", async () => { const responder=makePlayer("h",0,"dawn","human"),source={id:"source",name:'<img src=x onerror=alert(1)>'},target=responder,card={name:'<script>bad()</script>',definitionId:"assault"},presentation=buildResponsePresentation(responder,"block",{source,target,card},1,0,"格挡");const previousWindow=globalThis.window;globalThis.window={setInterval,clearInterval};const panel={innerHTML:"",classList:{add(){},remove(){}},querySelector(){return null;}};const fake={responseState:null,elements:{response_panel:panel},game:{cleanupManager:{delay:()=>new Promise(()=>{})}},render(){}};try{const pending=UIManager.prototype.requestResponse.call(fake,{id:"escape-response",requiredCount:1,legalCardIds:[],timeoutMs:5000,presentation},"格挡");assert.doesNotMatch(panel.innerHTML,/<img|<script>/);assert.match(panel.innerHTML,/&lt;img/);assert.match(panel.innerHTML,/&lt;script/);fake.responseState.resolve(false);assert.equal(await pending,false);}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;} });
test("主动技能按钮只显示技能名称", () => { assert.equal(skillButtonLabel({id:"allIn",name:"孤注",cost:"all"}),"孤注");assert.equal(skillButtonLabel({id:"hunt",name:"猎杀",cost:2}),"猎杀");assert.equal(skillButtonLabel(null),"主动技能"); });
test("突袭在中央结算区与使用日志中显示作用对象", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game,ui}=makeGame([a,b]);const assault=instance("assault");a.hand.push(assault);await game.playCard(a,assault,[b]);assert.equal(ui.currentCards[0].targetLabel,b.name);assert.ok(ui.logs.some((message)=>message===`${a.name}使用了「突袭」，作用对象：${b.name}。`)); });
test("群体牌会列出全部作用对象且结算模板显示目标标签", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dusk");const {game,ui}=makeGame([a,b,c]);const shockwave=instance("shockwave");a.hand.push(shockwave);await game.playCard(a,shockwave,[]);assert.equal(ui.currentCards[0].targetLabel,`${b.name}、${c.name}`);const markup=resolvingCardTemplate(shockwave,a.name,ui.currentCards[0].targetLabel);assert.match(markup,/作用对象/);assert.match(markup,new RegExp(`${b.name}、${c.name}`)); });
test("上方 AI 思考提示出现时隐藏下方重复提示", () => { const classes=()=>{const values=new Set();return {values,toggle(name,force){if(force)values.add(name);else values.delete(name);}};};const thinkingClasses=classes(),promptClasses=classes();const fake={game:null,thinkingPlayerId:null,thinkingMessage:"",elements:{thinking_indicator:{classList:thinkingClasses,innerHTML:""},action_prompt:{classList:promptClasses}},render(){}};const player=makePlayer("ai",0,"dawn");UIManager.prototype.setThinking.call(fake,true,player,"准备使用突袭");assert.ok(promptClasses.values.has("is-hidden"));UIManager.prototype.setThinking.call(fake,false,player);assert.ok(!promptClasses.values.has("is-hidden")); });
test("多层破势叠加并在下一次主动突袭一次性消耗", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk"); b.hp=8;b.maxHp=8; const {game}=makeGame([a,b]); for(let i=0;i<2;i+=1){const c=instance("exposeWeakness");a.hand.push(c);await game.playCard(a,c,[]);} assert.equal(a.statuses.exposeWeakness.stacks,2); const attack=instance("assault");a.hand.push(attack);await game.playCard(a,attack,[b]);assert.equal(b.hp,5);assert.equal(a.statuses.exposeWeakness,undefined); });
test("破势即使突袭被格挡也会消耗", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk","human"); const {game}=makeGame([a,b],{response:()=>true}); a.statuses.exposeWeakness={stacks:2}; a.hand.push(instance("assault")); b.hand.push(instance("block")); await game.playCard(a,a.hand[0],[b]); assert.equal(b.hp,b.maxHp); assert.equal(a.statuses.exposeWeakness,undefined); });
test("震荡不计突袭次数也不消耗破势", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk"), c=makePlayer("c",2,"dusk"); const {game}=makeGame([a,b,c]); a.statuses.exposeWeakness={stacks:2}; const card=instance("shockwave");a.hand.push(card);await game.playCard(a,card,[b,c]);assert.equal(a.turnFlags.attackUsed,0);assert.equal(a.statuses.exposeWeakness.stacks,2); });
test("二人小队可在同一出牌阶段连续使用多张调息", async () => { const {game,small}=makeTeamFixture();small.hp-=2;small.hand.push(instance("recover"),instance("recover"));await game.playCard(small,small.hand[0],[]);await game.playCard(small,small.hand[0],[]);assert.equal(small.hp,small.maxHp);assert.equal(small.turnFlags.recoverUsed,2);assert.equal(small.turnFlags.recoverLimit,null); });
test("三人小队可在同一出牌阶段连续使用多张调息", async () => { const {game,large}=makeTeamFixture();game.state.currentPlayerIndex=large.seatIndex;large.hp-=2;large.hand.push(instance("recover"),instance("recover"));await game.playCard(large,large.hand[0],[]);await game.playCard(large,large.hand[0],[]);assert.equal(large.hp,large.maxHp);assert.equal(large.turnFlags.recoverUsed,2);assert.equal(large.turnFlags.recoverLimit,null); });
test("聚能不能突破二人或三人阵营的能量上限", async () => { for(const kind of ["small","large"]){const fixture=makeTeamFixture(),player=fixture[kind];fixture.game.state.currentPlayerIndex=player.seatIndex;player.energy=player.maxEnergy-1;player.hand.push(instance("charge"),instance("charge"));await fixture.game.playCard(player,player.hand[0],[]);assert.equal(player.energy,player.maxEnergy);assert.equal(RuleEngine.canPlayCard(fixture.game,player,player.hand[0]).ok,false);} });
test("窥探只向真人私密层展示并把该实体牌标记为已知", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk");const {game,ui}=makeGame([a,b]);const scout=instance("scout"), secret=instance("counter");a.hand.push(scout);b.hand.push(secret);b.bumpHandVersion();const hidden=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,scout,[b],{tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});assert.equal(ui.reveals[0].cards[0],secret);assert.equal(createOpponentHandView(a,b)[0].name,secret.name);assert.ok(!game.state.logs.at(-1).message.includes(secret.name)); });
test("AI 窥探记忆绑定实体 card.id", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b],{random:()=>0});const scout=instance("scout"), secret=instance("block");a.hand.push(scout);b.hand.push(secret);await game.playCard(a,scout,[b]);assert.equal(a.aiMemory.knownCardsByPlayer[b.id][secret.id],secret.definitionId); });
test("被窥探牌离开原手牌后实体记忆立即失效", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const secret=instance("block");b.hand.push(secret);game.rememberPrivateCard(a,b,secret);await game.discardCardFromHand(b,secret,"测试");assert.equal(a.aiMemory.knownCardsByPlayer[b.id][secret.id],undefined); });
test("转移支持来源、接收者与指定牌三阶段", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dawn");const {game}=makeGame([a,b,c]);const transfer=instance("transfer"),moved=instance("block");a.hand.push(transfer);b.hand.push(moved);b.bumpHandVersion();const hidden=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,transfer,[],{sourceId:b.id,receiverId:c.id,tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});assert.ok(c.hand.includes(moved));assert.ok(!game.state.logs.at(-1).message.includes(moved.name)); });
test("真人掠夺指定隐藏牌后按已知公开牌名记录", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const use=instance("plunder"),secret=instance("block");a.hand.push(use);b.hand.push(secret);b.bumpHandVersion();const h=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,use,[b],{tokens:[h.tokens[0].token],selectionId:h.selectionId});assert.ok(a.hand.includes(secret));assert.ok(game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("破坏公开牌名并把牌移入弃牌堆", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const use=instance("destroy"),secret=instance("block");a.hand.push(use);b.hand.push(secret);b.bumpHandVersion();const h=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,use,[b],{tokens:[h.tokens[0].token],selectionId:h.selectionId});assert.ok(game.state.deck.discardPile.includes(secret));assert.ok(game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("四种旧装备采用README中的新名称且保留稳定definitionId", () => { assert.deepEqual(Object.fromEntries(["energyDevice","recycleDevice","defenseDevice","battleDevice"].map((id)=>[id,CARD_DEFINITIONS[id].name])),{energyDevice:"充能桩",recycleDevice:"回收站",defenseDevice:"雷达",battleDevice:"军火库"}); });
test("转移与掠夺按统一动态距离限制，破坏仍不限距离", () => { const actor=makePlayer("actor",0,"dawn"),near=makePlayer("near",1,"dusk"),far=makePlayer("far",2,"dusk"),other=makePlayer("other",3,"dawn"),tail=makePlayer("tail",4,"dawn");near.hand.push(instance("block"));far.equipment=instance("barrierDevice");const {game}=makeGame([actor,near,far,other,tail]);assert.ok(RuleEngine.getTransferSources(game,actor,CARD_DEFINITIONS.transfer).includes(near));assert.ok(!RuleEngine.getTransferSources(game,actor,CARD_DEFINITIONS.transfer).includes(far));assert.ok(!RuleEngine.getCardTargets(game,actor,CARD_DEFINITIONS.plunder).includes(far));assert.ok(RuleEngine.getCardTargets(game,actor,CARD_DEFINITIONS.destroy).includes(far));far.equipment=instance("energyDevice");actor.equipment=instance("telescope");assert.ok(RuleEngine.getTransferSources(game,actor,CARD_DEFINITIONS.transfer).includes(far));assert.ok(RuleEngine.getCardTargets(game,actor,CARD_DEFINITIONS.plunder).includes(far)); });
test("转移可把距离1内来源的装备移入距离1接收者装备区并替换旧装备", async () => { const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),middle=makePlayer("middle",2,"dusk"),other=makePlayer("other",3,"dawn"),receiver=makePlayer("receiver",4,"dawn"),moved=instance("energyDevice"),replaced=instance("defenseDevice"),use=instance("transfer");const {game}=makeGame([actor,from,middle,other,receiver]);actor.hand.push(use);from.equipment=moved;receiver.equipment=replaced;const selection=game.cardSelectionSystem.createHiddenSelection(from);assert.equal(await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"equipment",equipmentCardId:moved.id,selectionId:selection.selectionId}),true);assert.equal(from.equipment,null);assert.equal(receiver.equipment,moved);assert.ok(game.state.deck.discardPile.includes(replaced));assert.equal(game.cardSelectionSystem.isSelectionActive(selection.selectionId,from),false); });
test("掠夺可把距离2内目标装备公开移入施牌者装备区", async () => { const actor=makePlayer("actor",0,"dawn","human"),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),equipment=instance("energyDevice"),use=instance("plunder");const {game}=makeGame([actor,near,target,other,tail]);actor.hand.push(use);target.equipment=equipment;const selection=game.cardSelectionSystem.createHiddenSelection(target);assert.equal(await game.playCard(actor,use,[target],{zone:"equipment",equipmentCardId:equipment.id,selectionId:selection.selectionId}),true);assert.equal(target.equipment,null);assert.equal(actor.equipment,equipment);assert.ok(!actor.hand.includes(equipment));assert.ok(game.state.logs.some((entry)=>entry.message.includes("装备了「充能桩」"))); });
test("破坏可不限距离弃置装备区装备", async () => { const actor=makePlayer("actor",0,"dawn"),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),equipment=instance("barrierDevice"),use=instance("destroy");const {game}=makeGame([actor,near,target,other,tail]);actor.hand.push(use);target.equipment=equipment;assert.equal(DistanceSystem.getDistance(game,actor,target),3);const selection=game.cardSelectionSystem.createHiddenSelection(target);assert.equal(await game.playCard(actor,use,[target],{zone:"equipment",equipmentCardId:equipment.id,selectionId:selection.selectionId}),true);assert.equal(target.equipment,null);assert.ok(game.state.deck.discardPile.includes(equipment)); });
test("影客窃取可把距离2内敌方装备移入装备区但不能越过屏障后的距离3", async () => { const shade=makePlayer("shade",0,"dawn","ai",3),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),equipment=instance("energyDevice");const {game}=makeGame([shade,near,target,other,tail],{random:()=>0});shade.energy=2;target.equipment=equipment;assert.ok(RuleEngine.getSkillTargets(game,shade,ACTIVE_SKILLS.stealSkill).includes(target));assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),true);assert.equal(target.equipment,null);assert.equal(shade.equipment,equipment);assert.ok(!shade.hand.includes(equipment));const blockedShade=makePlayer("blocked-shade",0,"dawn","ai",3),blockedNear=makePlayer("blocked-near",1,"dawn"),blocked=makePlayer("blocked",2,"dusk"),blockedOther=makePlayer("blocked-other",3,"dusk"),blockedTail=makePlayer("blocked-tail",4,"dawn");blocked.equipment=instance("barrierDevice");const {game:blockedGame}=makeGame([blockedShade,blockedNear,blocked,blockedOther,blockedTail]);assert.equal(DistanceSystem.getDistance(blockedGame,blockedShade,blocked),3);assert.ok(!RuleEngine.getSkillTargets(blockedGame,blockedShade,ACTIVE_SKILLS.stealSkill).includes(blocked)); });
test("装备区选择令牌绑定本次会话、所有者和手牌版本", async () => { const actor=makePlayer("actor",0,"dawn"),owner=makePlayer("owner",1,"dusk"),equipment=instance("energyDevice");owner.equipment=equipment;const {game}=makeGame([actor,owner]);const selection=game.cardSelectionSystem.createHiddenSelection(owner);owner.bumpHandVersion();assert.equal(await game.choosePlayerZoneCard(actor,owner,"测试",{zone:"equipment",equipmentCardId:equipment.id,selectionId:selection.selectionId}),null);const otherSelection=game.cardSelectionSystem.createHiddenSelection(actor);assert.equal(await game.choosePlayerZoneCard(actor,owner,"测试",{zone:"equipment",equipmentCardId:equipment.id,selectionId:otherSelection.selectionId}),null); });
test("收获直接摸2且无需弃牌", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);game.state.deck.cards.push(instance("block"),instance("charge"));const use=instance("harvest");a.hand.push(use);await game.playCard(a,use,[]);assert.equal(a.hand.length,2); });
test("挑衅：有突袭者可打出，没有者优先消耗护盾且不触发格挡或雷达", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dusk","human");const {game,ui}=makeGame([a,b,c],{response:(r)=>r.targetPlayerId===b.id});a.hand.push(instance("provoke"));b.hand.push(instance("assault"));c.shield=2;c.equipment=instance("defenseDevice");game.state.deck.cards.push(instance("harvest"));const hp=c.hp;await game.playCard(a,a.hand[0],[b,c]);assert.equal(b.hand.length,0);assert.equal(c.hp,hp);assert.equal(c.shield,1);assert.ok(!ui.responseRequests.some((request)=>request.type==="block"));assert.equal(game.state.deck.judgmentZone.length,0);assert.equal(game.state.deck.cards.at(-1)?.definitionId,"harvest"); });
test("决斗轮流打出突袭，先不能响应者承受可被护盾吸收的1伤害", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:(r)=>r.targetPlayerId===b.id});const duel=instance("duel");a.hand.push(duel);b.hand.push(instance("assault"));a.shield=1;await game.playCard(a,duel,[b]);assert.equal(a.hp,a.maxHp);assert.equal(a.shield,0);assert.equal(a.turnFlags.attackUsed,0); });
test("决斗轮到无突袭真人时先显示响应窗口再结算伤害", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game,ui}=makeGame([a,b],{response:()=>false});const duel=instance("duel"),hp=b.hp;a.hand.push(duel);await game.playCard(a,duel,[b]);const request=ui.responseRequests.find((entry)=>entry.type==="assaultDiscard");assert.ok(request);assert.deepEqual(request.legalCardIds,[]);assert.match(request.presentation.eventText,new RegExp(`${a.name}.*你.*决斗`));assert.match(request.presentation.responseText,/1 张突袭/);assert.equal(b.hp,hp-1); });
test("挑衅轮到无突袭真人时仍显示响应窗口", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game,ui}=makeGame([a,b],{response:()=>false});const provoke=instance("provoke"),hp=b.hp;a.hand.push(provoke);await game.playCard(a,provoke,[b]);const request=ui.responseRequests.find((entry)=>entry.type==="assaultDiscard");assert.ok(request);assert.equal(request.presentation.responseCardName,"突袭");assert.match(request.presentation.availabilityText,/当前 0 张/);assert.equal(b.hp,hp-1); });
test("反制链响应说明包含来源、目标、原牌和当前反制", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.legalCardIds.length>=request.requiredCount});a.hand.push(instance("harvest"));b.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);const chained=ui.responseRequests.find((request)=>request.type==="counter"&&request.sourcePlayerId===b.id&&request.targetPlayerId===c.id);assert.ok(chained);assert.match(chained.presentation.eventText,new RegExp(`${b.name}.*${a.name}.*收获.*反制`));assert.match(chained.presentation.responseText,/继续.*反制/); });
test("无人物目标的战术牌响应文案不再显示对战场使用", () => { const responder=makePlayer("human",0,"dawn","human"),source=makePlayer("ai",1,"dusk","ai");const presentation=buildResponsePresentation(responder,"counter",{source,card:instance("transfer"),targets:[]},1,0,"反制");assert.equal(presentation.eventText,`${source.name}使用了「转移」。`);assert.doesNotMatch(presentation.eventText,/对战场使用/); });
test("护援响应区分原技能名称与当前响应技能名称", async () => { for(const [actionName,context] of [["焚场",{skill:"burningField",actionName:"焚场",canBlock:false,damageType:"skill"}],["猎杀",{skill:"hunt",actionName:"猎杀",canBlock:true,damageType:"skill"}],["突袭",{card:instance("assault"),canBlock:true,damageType:"normal"}]]){const source=makePlayer(`source-${actionName}`,0,"dusk","ai",4),target=makePlayer(`target-${actionName}`,1,"dawn","ai",2),guardian=makePlayer(`guardian-${actionName}`,2,"dawn","human",1);guardian.hand.push(instance("charge"));const {game,ui}=makeGame([source,target,guardian],{response:()=>false});registerPassiveSkills(game);await game.damage(source,target,1,context);const request=ui.responseRequests.find((entry)=>entry.type==="skill");assert.ok(request);assert.equal(request.presentation.eventText,`${source.name}对${target.name}使用了「${actionName}」。`);assert.equal(request.presentation.responseText,"你可以发动「护援」。");assert.equal(request.presentation.buttonLabel,"发动护援");assert.doesNotMatch(request.presentation.eventText,/发动护援|burningField|hunt/);} });
test("互利在反制窗口之后才展示并按座位每人选1张", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dawn");const {game,ui}=makeGame([a,b,c]);game.state.deck.cards.push(instance("block"),instance("charge"),instance("recover"));a.hand.push(instance("mutualBenefit"));await game.playCard(a,a.hand[0],[]);assert.equal(a.hand.length,1);assert.equal(b.hand.length,1);assert.equal(c.hand.length,1);assert.equal(game.state.publicCardPool.length,0);assert.equal(ui.publicRequests.length,1); });
test("互利选牌严格跳过阵亡座位", async () => { const a=makePlayer("a",0,"dawn","human"),dead=makePlayer("dead",1,"dusk"),b=makePlayer("b",2,"dusk"),c=makePlayer("c",3,"dawn");dead.alive=false;const {game}=makeGame([a,dead,b,c]);game.state.deck.cards.push(instance("block"),instance("charge"),instance("recover"));a.hand.push(instance("mutualBenefit"));await game.playCard(a,a.hand[0],[]);assert.equal(dead.hand.length,0);assert.equal(a.hand.length,1);assert.equal(b.hand.length,1);assert.equal(c.hand.length,1); });
test("共生按全体存活角色结算治疗", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dawn");[a,b,c].forEach((p)=>p.hp-=1);const {game}=makeGame([a,b,c]);a.hand.push(instance("symbiosis"));await game.playCard(a,a.hand[0],[]);[a,b,c].forEach((p)=>assert.equal(p.hp,p.maxHp)); });
test("反制者包含盟友并按施牌者后的座位顺序", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dawn","human"),c=makePlayer("c",2,"dusk","human");const order=[];const {game}=makeGame([a,b,c],{response:(request)=>(order.push(request.targetPlayerId),request.legalCardIds.length>=request.requiredCount)});a.hand.push(instance("harvest"));b.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id]); });
test("反制本身可被反制且仍保持响应牌接口", () => { assert.equal(CARD_DEFINITIONS.counter.counterable,true);assert.equal(CARD_DEFINITIONS.counter.usageMode,"response");assert.match(CARD_DEFINITIONS.counter.description,/也可以被其他反制响应/); });
test("震荡的反制只取消当前目标所受效果而不取消整张群伤牌", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dusk");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.type==="counter"&&request.targetPlayerId===b.id});const shockwave=instance("shockwave"),counter=instance("counter"),bHp=b.hp,cHp=c.hp;a.hand.push(shockwave);b.hand.push(counter);await game.playCard(a,shockwave,[b,c]);assert.equal(b.hp,bHp);assert.equal(c.hp,cHp-1);assert.equal(b.hand.includes(counter),false);assert.ok(ui.responseRequests.some((request)=>request.type==="counter"&&request.targetPlayerId===b.id&&request.presentation.responseText.includes("仅取消")&&request.presentation.responseText.includes("其他目标")));assert.ok(ui.logs.some((message)=>message.includes(`${b.name}反制了「震荡」对自己的效果`))); });
test("挑衅的反制只取消当前目标效果且不能保护队友", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dusk","human");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.type==="counter"&&request.targetPlayerId===b.id});const provoke=instance("provoke"),counter=instance("counter"),bHp=b.hp,cHp=c.hp;a.hand.push(provoke);b.hand.push(counter);await game.playCard(a,provoke,[b,c]);assert.equal(b.hp,bHp);assert.equal(c.hp,cHp-1);assert.equal(b.hand.includes(counter),false);assert.ok(ui.responseRequests.some((request)=>request.type==="counter"&&request.targetPlayerId===b.id&&request.presentation.responseText.includes("仅取消")&&request.presentation.responseText.includes("其他目标")));assert.ok(ui.logs.some((message)=>message.includes(`${b.name}反制了「挑衅」对自己的效果`))); });
test("针对震荡目标的反制仍可被后续反制，之后该目标继续承受效果", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.type==="counter"&&request.legalCardIds.length>=request.requiredCount});const shockwave=instance("shockwave"),first=instance("counter"),second=instance("counter"),hp=b.hp;a.hand.push(shockwave,second);b.hand.push(first);await game.playCard(a,shockwave,[b]);assert.equal(b.hp,hp-1);assert.equal(b.hand.includes(first),false);assert.equal(a.hand.includes(second),false);assert.ok(ui.logs.some((message)=>message.includes(`${b.name}的「反制」被后续反制抵消`))); });
test("两次反制后原战术牌恢复生效", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human");const order=[];const {game,ui}=makeGame([a,b,c],{response:(request)=>(order.push(request.targetPlayerId),request.legalCardIds.length>=request.requiredCount)});game.state.deck.cards.push(instance("block"),instance("charge"));a.hand.push(instance("harvest"));b.hand.push(instance("counter"));c.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id,a.id,b.id]);assert.equal(a.hand.length,2);assert.equal(b.hand.length,0);assert.equal(c.hand.length,0);assert.ok(ui.logs.some((message)=>message.includes(`${b.name}的「反制」被后续反制抵消`))); });
test("三次反制后原战术牌仍被取消", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human"),d=makePlayer("d",3,"dusk","human");const order=[];const {game}=makeGame([a,b,c,d],{response:(request)=>(order.push(request.targetPlayerId),request.legalCardIds.length>=request.requiredCount)});game.state.deck.cards.push(instance("block"),instance("charge"));a.hand.push(instance("harvest"));b.hand.push(instance("counter"));c.hand.push(instance("counter"));d.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id,d.id,a.id,b.id,c.id]);assert.equal(a.hand.length,0);assert.equal(b.hand.length,0);assert.equal(c.hand.length,0);assert.equal(d.hand.length,0);assert.ok(game.state.logs.some((entry)=>entry.message.includes("效果被取消"))); });

// 装备与判定
for (const id of ["energyDevice","recycleDevice","defenseDevice","battleDevice","telescope","barrierDevice"]) test(`装备 ${CARD_DEFINITIONS[id].name} 会进入唯一装备槽`, async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const equipment=instance(id);a.hand.push(equipment);await game.playCard(a,equipment,[]);assert.equal(a.equipment,equipment);assert.ok(!game.state.deck.discardPile.includes(equipment)); });
test("替换装备时旧装备进入弃牌堆且新装备留在槽内", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const old=instance("energyDevice");a.equipment=old;const next=instance("battleDevice");a.hand.push(next);await game.playCard(a,next,[]);assert.equal(a.equipment,next);assert.ok(game.state.deck.discardPile.includes(old)); });
test("望远镜替换为屏障后方向性距离立即按新装备重算", async () => { const source=makePlayer("source",0,"dawn"),ally=makePlayer("ally",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dusk"),old=instance("telescope"),next=instance("barrierDevice");const {game}=makeGame([source,ally,target,other,tail]);source.equipment=old;source.hand.push(next);assert.equal(DistanceSystem.getDistance(game,source,target),1);assert.equal(await game.playCard(source,next,[]),true);assert.equal(DistanceSystem.getDistance(game,source,target),2);assert.equal(DistanceSystem.getDistance(game,target,source),3);assert.ok(game.state.deck.discardPile.includes(old)); });
test("回收站每回合前两张主动战术各摸1且被反制也触发", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:(request)=>request.type==="counter"});a.equipment=instance("recycleDevice");a.hand.push(instance("harvest"),instance("exposeWeakness"),instance("exposeWeakness"));b.hand.push(instance("counter"));game.state.deck.cards.push(instance("charge"),instance("block"),instance("shield"));await game.playCard(a,a.hand[0],[]);await game.playCard(a,a.hand[0],[]);await game.playCard(a,a.hand[0],[]);assert.equal(a.turnFlags.recycleDeviceUses,2);assert.equal(a.hand.length,2); });
test("雷达判定战术牌时免疫原突袭并把判定牌弃置", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("harvest");game.state.deck.cards.push(judgment);const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.ok(game.state.deck.discardPile.includes(judgment));assert.equal(game.state.deck.judgmentZone.length,0); });
test("雷达判定基础牌时获得该牌并继续攻击", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("charge");game.state.deck.cards.push(judgment);const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.ok(b.hand.includes(judgment));assert.equal(b.hp,hp-1); });
test("雷达公开获得的基础牌写入其他 AI 记忆", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("charge");game.state.deck.cards.push(judgment);await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(a.aiMemory.knownCardsByPlayer[b.id][judgment.id],"charge"); });
test("雷达获得的格挡可立即用于当前攻击", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:()=>true});b.equipment=instance("defenseDevice");game.state.deck.cards.push(instance("block"));const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.equal(b.hand.length,0); });
test("雷达判定装备牌时不直接扣血且原攻击继续由护盾吸收", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("energyDevice");game.state.deck.cards.push(judgment);b.shield=2;const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.equal(b.shield,1);assert.ok(game.state.deck.discardPile.includes(judgment));assert.equal(b.equipment.definitionId,"defenseDevice"); });
test("军火库要求2张格挡；只有1张时仍显示响应但按钮禁用且不会浪费", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game,ui}=makeGame([a,b],{response:()=>true});a.equipment=instance("battleDevice");b.hand.push(instance("block"));const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});const request=ui.responseRequests[0];assert.equal(request.requiredCount,2);assert.equal(request.legalCardIds.length,1);assert.equal(canSubmitResponse(request),false);assert.match(request.presentation.availabilityText,/不足/);assert.equal(b.hp,hp-1);assert.equal(b.hand.length,1); });
test("军火库面对2张格挡时原子弃置并完全防住", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:()=>true});a.equipment=instance("battleDevice");b.hand.push(instance("block"),instance("block"));const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.equal(b.hand.length,0); });

// 负生命、濒死救援与事件顺序
test("濒死救援阶段保留负生命以计算调息，正式阵亡后归零", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;const {game}=makeGame([a,b]);let dyingHp=null,need=null;game.eventBus.on("playerDying","test:negative-hp",(event)=>{dyingHp=event.target.hp;need=event.need;});await game.damage(a,b,3,{canBlock:false});assert.equal(dyingHp,-2);assert.equal(need,3);assert.equal(b.hp,0);assert.equal(b.alive,false); });
test("无人可救时濒死角色在救援窗口后以0生命阵亡", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;const {game}=makeGame([a,b]);await game.damage(a,b,1,{canBlock:false});assert.equal(b.alive,false);assert.equal(b.hp,0); });
test("合法真人救援者没有调息时仍显示响应窗口", async () => { const target=makePlayer("target",0,"dawn"),human=makePlayer("human",1,"dawn","human"),enemy=makePlayer("enemy",2,"dusk");target.hp=0;const {game,ui}=makeGame([target,human,enemy],{response:()=>false});await game.dyingSystem.enter(target,enemy);const request=ui.responseRequests.find((entry)=>entry.type==="dyingRescue"&&entry.sourcePlayerId===human.id);assert.ok(request);assert.deepEqual(request.legalCardIds,[]);assert.match(request.presentation.eventText,new RegExp(`${target.name}.*濒死`));assert.match(request.presentation.responseText,/调息.*救援/);assert.match(request.presentation.availabilityText,/当前 0 张/); });
test("AI 濒死本人有调息时必须自救", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;b.hand.push(instance("recover"));const {game}=makeGame([a,b]);const used=b.turnFlags.recoverUsed;await game.damage(a,b,1,{canBlock:false});assert.equal(b.alive,true);assert.equal(b.hp,1);assert.equal(b.turnFlags.recoverUsed,used); });
test("负1生命需要2张调息并会重复开启救援轮", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;b.hand.push(instance("recover"),instance("recover"));const {game}=makeGame([a,b]);await game.damage(a,b,2,{canBlock:false});assert.equal(b.hp,1);assert.equal(b.alive,true); });
test("救援顺序为濒死本人后再从下一座位起的盟友", async () => { const dying=makePlayer("d",0,"dawn","human"),ally1=makePlayer("a1",1,"dawn","human"),enemy=makePlayer("e",2,"dusk","human"),ally2=makePlayer("a2",3,"dawn","human");dying.hp=0;[dying,ally1,enemy,ally2].forEach((p)=>p.hand.push(instance("recover")));const order=[];const {game}=makeGame([dying,ally1,enemy,ally2],{response:(r)=>(order.push(r.sourcePlayerId),r.sourcePlayerId===ally1.id)});await game.dyingSystem.enter(dying,enemy);assert.deepEqual(order,[dying.id,ally1.id]);assert.equal(dying.hp,1); });
test("敌人永远不会进入濒死救援候选队列", async () => { const dying=makePlayer("d",0,"dawn","human"),enemy=makePlayer("e",1,"dusk","human");dying.hp=0;enemy.hand.push(instance("recover"));const {game,ui}=makeGame([dying,enemy],{response:()=>false});await game.dyingSystem.enter(dying,enemy);assert.deepEqual(ui.responseRequests.map((request)=>request.sourcePlayerId),[dying.id]);assert.ok(!ui.responseRequests.some((request)=>request.sourcePlayerId===enemy.id));assert.equal(dying.alive,false); });
test("beforePlayerDying 取消后会恢复到合法的1点生命", async () => { const dying=makePlayer("d",0,"dawn"),enemy=makePlayer("e",1,"dusk");dying.hp=0;const {game}=makeGame([dying,enemy]);game.eventBus.on("beforePlayerDying","test:cancel",(event)=>{event.cancelled=true;});await game.dyingSystem.enter(dying,enemy);assert.equal(dying.alive,true);assert.equal(dying.hp,1); });
test("成功救援事件顺序包含 dying、rescueUsed、rescued", async () => { const dying=makePlayer("d",0,"dawn"),enemy=makePlayer("e",1,"dusk");dying.hp=0;dying.hand.push(instance("recover"));const {game}=makeGame([dying,enemy]);const events=[];for(const type of ["playerDying","dyingRescueUsed","playerRescued"])game.eventBus.on(type,`test:${type}`,()=>events.push(type));await game.dyingSystem.enter(dying,enemy);assert.deepEqual(events,["playerDying","dyingRescueUsed","playerRescued"]); });
test("濒死调息进入统一治疗事件和统计但不触发回春加量", async () => { const target=makePlayer("d",0,"dawn","ai",1),medic=makePlayer("m",1,"dawn","ai",2),enemy=makePlayer("e",2,"dusk");target.hp=0;medic.hand.push(instance("recover"));const {game}=makeGame([target,medic,enemy]);registerPassiveSkills(game);const events=[];game.eventBus.on("beforeHeal","test:rescue-before",(event)=>events.push([event.type,event.isDyingRescue]));game.eventBus.on("afterHeal","test:rescue-after",(event)=>events.push([event.type,event.actualAmount]));await game.dyingSystem.enter(target,enemy);assert.equal(target.hp,1);assert.equal(medic.statistics.healingDone,1);assert.deepEqual(events,[["beforeHeal",true],["afterHeal",1]]);assert.equal(medic.turnFlags.rejuvenationUsed,undefined); });
test("三人阵营 AI 能协作各交一张调息救回负1血队友", async () => { const target=makePlayer("d",0,"dawn","ai",2),ally1=makePlayer("a1",1,"dawn"),ally2=makePlayer("a2",2,"dawn"),enemy=makePlayer("e",3,"dusk");target.hp=-1;ally1.hand.push(instance("recover"));ally2.hand.push(instance("recover"));const {game}=makeGame([target,ally1,ally2,enemy]);assert.equal(game.aiController.responsePolicy.assessDyingRescue(ally1,target).strategic,true);await game.dyingSystem.enter(target,enemy);assert.equal(target.alive,true);assert.equal(target.hp,1);assert.equal(ally1.hand.length,0);assert.equal(ally2.hand.length,0); });
test("AI 按单张边际价值启动负2血的1+2协作救援", async () => { const target=makePlayer("d",0,"dawn","ai",2),ally1=makePlayer("a1",1,"dawn"),ally2=makePlayer("a2",2,"dawn"),enemy=makePlayer("e",3,"dusk");target.hp=-2;ally1.hand.push(instance("recover"));ally2.hand.push(instance("recover"),instance("recover"));const {game}=makeGame([target,ally1,ally2,enemy]);const assessment=game.aiController.responsePolicy.assessDyingRescue(ally1,target);assert.ok(assessment.futureExpectedRecover>0);assert.equal(game.aiController.responsePolicy.shouldRespond(ally1,"dyingRescue",{target},[ally1.hand[0]]),true);await game.dyingSystem.enter(target,enemy);assert.equal(target.alive,true);assert.equal(target.hp,1);assert.equal(ally1.hand.length,0);assert.equal(ally2.hand.length,0); });

// 同阵营 AI 强制救援真人（16 项）
test("强制救援1：同阵营 AI 持有调息时真人必定获救", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=0;ally.hand.push(instance("recover"));
  const {game,ui}=makeGame([human,ally,enemy]);
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.alive,true);assert.equal(human.hp,1);assert.equal(ally.hand.length,0);
  assert.ok(ui.thinking.some(([active,player,message])=>active&&player.id===ally.id&&message===`正在准备救援${human.name}`));
  assert.ok(ui.logs.some((message)=>message.includes(`${ally.name}使用调息救援${human.name}`)));
  assert.ok(ui.logs.some((message)=>message.includes(`${human.name}脱离濒死`)));
});
test("强制救援2：AI 只剩最后一张调息时也必须救真人", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=0;ally.hand=[instance("recover")];
  const {game}=makeGame([human,ally,enemy]);game.aiController.responsePolicy.shouldRespond=()=>false;
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.hp,1);assert.equal(ally.hand.length,0);
});
test("强制救援3：AI 只有1点生命时也必须救真人", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=0;ally.hp=1;ally.hand.push(instance("recover"));
  const {game}=makeGame([human,ally,enemy]);game.aiController.responsePolicy.shouldRespond=()=>false;
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.hp,1);assert.equal(ally.hp,1);assert.equal(ally.hand.length,0);
});
test("强制救援4：AI 评分函数返回 false 时仍绕过策略救真人", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=0;ally.hand.push(instance("recover"));
  const {game}=makeGame([human,ally,enemy]);let policyCalls=0;game.aiController.responsePolicy.shouldRespond=()=>{policyCalls+=1;return false;};
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.hp,1);assert.equal(policyCalls,0);
});
test("强制救援5：AI 即使无法独自完全救活也必须先使用调息", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=-1;ally.hand.push(instance("recover"));
  const {game,ui}=makeGame([human,ally,enemy]);game.aiController.responsePolicy.shouldRespond=()=>false;
  await game.dyingSystem.enter(human,enemy);
  assert.equal(ally.hand.length,0);assert.equal(ally.statistics.healingDone,1);assert.equal(human.hp,0);assert.equal(human.alive,false);
  assert.ok(ui.logs.some((message)=>message.includes(`${human.name}仍处于濒死，还需1张调息`)));
});
test("强制救援6：真人负1血时两名 AI 各用一张并救活", async () => {
  const human=makePlayer("human",0,"dawn","human"),allyA=makePlayer("ally-a",1,"dawn"),allyB=makePlayer("ally-b",2,"dawn"),enemy=makePlayer("enemy",3,"dusk");
  human.hp=-1;allyA.hand.push(instance("recover"));allyB.hand.push(instance("recover"));
  const {game}=makeGame([human,allyA,allyB,enemy]);game.aiController.responsePolicy.shouldRespond=()=>false;
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.alive,true);assert.equal(human.hp,1);assert.equal(allyA.hand.length,0);assert.equal(allyB.hand.length,0);
});
test("强制救援7：真人负2血时同一 AI 跨三轮连续使用三张", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=-2;ally.hand.push(instance("recover"),instance("recover"),instance("recover"));
  const {game}=makeGame([human,ally,enemy]);game.aiController.responsePolicy.shouldRespond=()=>false;
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.alive,true);assert.equal(human.hp,1);assert.equal(ally.hand.length,0);assert.equal(ally.statistics.healingDone,3);
});
test("强制救援8：总共仅两张时仍全部使用，真人到0血后阵亡", async () => {
  const human=makePlayer("human",0,"dawn","human"),allyA=makePlayer("ally-a",1,"dawn"),allyB=makePlayer("ally-b",2,"dawn"),enemy=makePlayer("enemy",3,"dusk");
  human.hp=-2;allyA.hand.push(instance("recover"));allyB.hand.push(instance("recover"));
  const {game}=makeGame([human,allyA,allyB,enemy]);game.aiController.responsePolicy.shouldRespond=()=>false;
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.hp,0);assert.equal(human.alive,false);assert.equal(allyA.hand.length,0);assert.equal(allyB.hand.length,0);
});
test("强制救援9：敌方 AI 即使持有调息也不能救真人", async () => {
  const human=makePlayer("human",0,"dawn","human"),enemy=makePlayer("enemy",1,"dusk");
  human.hp=0;enemy.hand.push(instance("recover"));
  const {game,ui}=makeGame([human,enemy]);await game.dyingSystem.enter(human,enemy);
  assert.equal(human.alive,false);assert.equal(enemy.hand.length,1);assert.equal(ui.thinking.length,0);
});
test("强制救援10：不同阵营 AI 不能从核心响应入口救真人", async () => {
  const human=makePlayer("human",0,"dawn","human"),enemy=makePlayer("enemy",1,"dusk");
  human.hp=0;const card=instance("recover");enemy.hand.push(card);
  const {game}=makeGame([human,enemy]);const result=await game.responseSystem.requestDyingRescue(enemy,human,card);
  assert.equal(result,null);assert.ok(enemy.hand.includes(card));assert.equal(game.state.pendingResponses.length,0);
});
test("强制救援11：关闭配置后恢复普通 AI 救援策略", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=0;ally.hand.push(instance("recover"));
  const {game}=makeGame([human,ally,enemy]);game.forceAiRescueHuman=false;let policyCalls=0;game.aiController.responsePolicy.shouldRespond=()=>{policyCalls+=1;return false;};
  await game.dyingSystem.enter(human,enemy);
  assert.equal(human.alive,false);assert.equal(ally.hand.length,1);assert.equal(policyCalls,1);
});
test("强制救援12：真人救队友时仍可自行接受或拒绝", async () => {
  const run=async (decision)=>{const target=makePlayer(`target-${decision}`,0,"dawn"),human=makePlayer(`human-${decision}`,1,"dawn","human"),enemy=makePlayer(`enemy-${decision}`,2,"dusk");target.hp=0;human.hand.push(instance("recover"));const fixture=makeGame([target,human,enemy],{response:()=>decision});await fixture.game.dyingSystem.enter(target,enemy);return {target,human,ui:fixture.ui};};
  const declined=await run(false),accepted=await run(true);
  assert.equal(declined.target.alive,false);assert.equal(declined.human.hand.length,1);assert.equal(declined.ui.responseRequests.length,1);
  assert.equal(accepted.target.alive,true);assert.equal(accepted.target.hp,1);assert.equal(accepted.human.hand.length,0);assert.equal(accepted.ui.responseRequests.length,1);
});
test("强制救援13：AI 自己濒死时仍然固定自救", async () => {
  const target=makePlayer("target",0,"dawn"),enemy=makePlayer("enemy",1,"dusk");target.hp=0;target.hand.push(instance("recover"));
  const {game}=makeGame([target,enemy]);let policyCalls=0;game.aiController.responsePolicy.shouldRespond=()=>{policyCalls+=1;return false;};
  await game.dyingSystem.enter(target,enemy);
  assert.equal(target.alive,true);assert.equal(target.hp,1);assert.equal(policyCalls,0);
});
test("强制救援14：重新征召会取消尚未完成的 AI 救援等待", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");human.hp=0;const card=instance("recover");ally.hand.push(card);
  const {game,ui}=makeGame([human,ally,enemy]);game.simulationMode=false;game.cleanupManager=new CleanupManager();
  const pending=game.responseSystem.requestDyingRescue(ally,human,card);game.dispose();const result=await pending;
  assert.equal(result,null);assert.ok(ally.hand.includes(card));assert.equal(game.cleanupManager.pending.size,0);assert.equal(game.state.pendingResponses.length,0);
  assert.equal(ui.thinking.at(-1)[0],false);
});
test("强制救援15：救援经过 Game.heal 并产生治疗事件与统计", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");human.hp=0;ally.hand.push(instance("recover"));
  const {game}=makeGame([human,ally,enemy]);const events=[];
  game.eventBus.on("beforeHeal","test:forced-before",(event)=>events.push([event.type,event.isDyingRescue,event.reason]));
  game.eventBus.on("afterHeal","test:forced-after",(event)=>events.push([event.type,event.actualAmount]));
  await game.dyingSystem.enter(human,enemy);
  assert.deepEqual(events,[["beforeHeal",true,"dyingRescue"],["afterHeal",1]]);assert.equal(ally.statistics.healingDone,1);assert.equal(human.hp,1);
});
test("强制救援16：濒死上下文不会触发灵医回春额外治疗", async () => {
  const human=makePlayer("human",0,"dawn","human"),medic=makePlayer("medic",1,"dawn","ai",2),enemy=makePlayer("enemy",2,"dusk");human.hp=0;medic.hand.push(instance("recover"));
  const {game}=makeGame([human,medic,enemy]);registerPassiveSkills(game);await game.dyingSystem.enter(human,enemy);
  assert.equal(human.hp,1);assert.equal(medic.statistics.healingDone,1);assert.equal(medic.turnFlags.rejuvenationUsed,undefined);
});

test("真人在自己的决斗中阵亡会在完整结算后主动结束出牌等待", async () => {
  const human=makePlayer("human",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  human.hp=1;const duel=instance("duel");human.hand.push(duel);enemy.hand.push(instance("assault"));
  const {game,ui}=makeGame([human,ally,enemy]);const waiting=ui.waitForHumanPlayEnd(game.state.gameId);
  assert.equal(await game.handleHumanCard(duel.id),true);
  const ended=await Promise.race([waiting,new Promise((resolve)=>setTimeout(()=>resolve("timeout"),50))]);
  assert.equal(human.alive,false);assert.equal(game.state.phase,"play");assert.equal(game.state.isGameOver,false);
  assert.equal(ended,true);assert.equal(ui.playEndState,null);assert.equal(game.pendingHumanPlayEnd,false);
});

test("互利等待选牌时重新征召不会把 undefined 放入手牌", async () => {
  const human=makePlayer("human",0,"dawn","human"),enemy=makePlayer("enemy",1,"dusk");const {game,ui}=makeGame([human,enemy]);
  game.state.deck.cards.push(instance("block"),instance("charge"));game.publicCardPool.reveal(2);
  let settleSelection=null;
  ui.requestPublicCard=()=>new Promise((resolve)=>{settleSelection=resolve;});
  ui.cancelPendingInteractions=()=>{settleSelection?.(undefined);};
  const drafting=game.publicCardPool.draft(human);await Promise.resolve();game.dispose();
  assert.equal(await drafting,false);assert.deepEqual(human.hand,[]);assert.equal(human.hand.includes(undefined),false);assert.equal(game.state.publicCardPool.length,0);
});

test("非出牌阶段触发阵亡后恢复进入濒死前的真实阶段", async () => {
  const target=makePlayer("target",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  const {game}=makeGame([target,ally,enemy]);game.state.phase="energy";target.hp=0;
  await game.dyingSystem.enter(target,enemy);
  assert.equal(target.alive,false);assert.equal(game.state.isGameOver,false);assert.equal(game.state.phase,"energy");
});

// 隐藏信息、AI、延迟与 UI 安全
test("不透明隐藏牌 DOM 不含牌名、definitionId、类别、描述或 art", () => { const markup=hiddenSelectionMarkup({tokens:[{token:"opaque-safe",position:1}]});assert.match(markup,/opaque-safe/);for(const secret of ["反制","definitionId","category","description","assets\/cards"])assert.doesNotMatch(markup,new RegExp(secret)); });
test("过期手牌版本令不透明令牌失效", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));const selection=game.cardSelectionSystem.createHiddenSelection(b);b.bumpHandVersion();assert.equal(game.cardSelectionSystem.resolveToken(selection.tokens[0].token,b),null); });
test("隐藏牌令牌必须属于本次 selectionId", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));const first=game.cardSelectionSystem.createHiddenSelection(b),second=game.cardSelectionSystem.createHiddenSelection(b);assert.equal(game.cardSelectionSystem.resolveToken(first.tokens[0].token,b,second.selectionId),null);assert.equal(game.cardSelectionSystem.resolveToken(first.tokens[0].token,b,first.selectionId),b.hand[0]); });
test("核心隐藏牌解析会同时去重 token 和实体牌", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"),instance("recover"));const selection=game.cardSelectionSystem.createHiddenSelection(b);const duplicate=selection.tokens[0].token;const cards=await game.chooseHiddenCards(a,b,2,"测试去重",{selectionId:selection.selectionId,tokens:[duplicate,duplicate]});assert.equal(cards.length,1);assert.equal(cards[0].id,b.hand[0].id); });
test("取消牌背选择会立即清除对应临时令牌", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));const selection=game.cardSelectionSystem.createHiddenSelection(b);const panel={innerHTML:"",classList:{add(){},remove(){}}};let resolved="pending";const ui={game,elements:{response_panel:panel},render(){}};const controller=new InteractionController(ui);controller.pending={type:"hidden",selection,count:1,exact:true,selected:new Set(),resolve:(value)=>{resolved=value;}};controller.cancel();assert.equal(resolved,null);assert.equal(game.cardSelectionSystem.selections.size,0); });
test("牌背多阶段 pending 会锁住手牌、技能和结束出牌", () => { const fake={targetState:null,discardState:null,responseState:null,interactionController:{pending:{type:"hidden"}},game:{interactionLocked:false}};assert.equal(UIManager.prototype.isInteractionActive.call(fake),true);const human=makePlayer("h",0,"dawn","human"),enemy=makePlayer("e",1,"dusk");const {game}=makeGame([human,enemy]);game.interactionLocked=true;assert.equal(game.requestEndHumanPlay(),false); });
test("电脑玩家模板只暴露手牌数量", () => { const human=makePlayer("h",0,"dawn","human"),ai=makePlayer("ai",1,"dusk");ai.hand.push({ ...instance("counter"), name:"绝密名称" });const markup=playerPanelTemplate(ai,{humanTeam:human.battleTeam});assert.match(markup,/手牌1/);assert.doesNotMatch(markup,/绝密名称|definitionId/); });
test("未知对手手牌展示模型和 DOM 均不含真实牌面资料", () => { const human=makePlayer("h",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),secret={...instance("counter"),name:"绝密反制",description:"绝密说明"};ai.hand.push(secret);const view=createOpponentHandView(human,ai),serialized=JSON.stringify(view),markup=opponentHandStripTemplate(view);assert.deepEqual(view,[{known:false}]);for(const hidden of [secret.id,secret.definitionId,secret.name,secret.description,secret.art]){assert.ok(!serialized.includes(hidden));assert.ok(!markup.includes(hidden));}assert.match(markup,/hidden-card-back/);assert.doesNotMatch(markup,/未知手牌|\?牌|牌背\s*\d/); });
test("真人识别实体牌后显示已知小卡面和说明", () => { const human=makePlayer("h",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),secret=instance("block");const {game}=makeGame([human,ai]);ai.hand.push(secret);game.rememberPrivateCard(human,ai,secret);const view=createOpponentHandView(human,ai),markup=opponentHandStripTemplate(view);assert.equal(view[0].known,true);assert.equal(view[0].name,secret.name);assert.match(markup,new RegExp(secret.name));assert.match(markup,new RegExp(secret.description.slice(0,6))); });
test("真人窥探后持续识别该实体牌，离开原手牌后立即失效", async () => { const human=makePlayer("h",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),secret=instance("counter");const {game}=makeGame([human,ai]);ai.hand.push(secret);game.rememberPrivateCard(human,ai,secret);assert.equal(createOpponentHandView(human,ai)[0].known,true);await game.discardCardFromHand(ai,secret,"测试离手");assert.equal(createOpponentHandView(human,ai).length,0);assert.equal(human.aiMemory.knownCardsByPlayer[ai.id][secret.id],undefined); });
test("大量对手手牌保持固定卡牌尺寸并在独立区域横向滚动", async () => { const slots=Array.from({length:18},()=>({known:false})),markup=opponentHandStripTemplate(slots),characterCss=await readFile(projectFile("css/characters.css"),"utf8"),cardCss=await readFile(projectFile("css/cards.css"),"utf8");assert.equal((markup.match(/hidden-card-back is-compact/g)??[]).length,18);assert.match(markup,/opponent-hand-strip/);assert.match(characterCss,/\.opponent-hand-strip\s*\{[^}]*overflow-x:\s*auto/s);assert.match(characterCss,/touch-action:\s*pan-x/);assert.match(cardCss,/\.hidden-card-back\.is-compact\s*\{[^}]*width:\s*124px[^}]*height:\s*174px/s); });
test("对手手牌区删除标题并占用独立网格行", async () => { const ai=makePlayer("ai",1,"dusk"),markup=playerPanelTemplate(ai,{opponentHandSlots:[{known:false}]}),css=await readFile(projectFile("css/characters.css"),"utf8");assert.doesNotMatch(markup,/手牌区域\s*·|手牌区域/);assert.match(css,/\.player-seat\s*\{[^}]*grid-template-rows:/s);assert.match(css,/\.opponent-hand-region\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/s); });
test("统一未知牌组件只渲染无文字纯牌背", () => { const markup=hiddenCardBackTemplate({compact:true});assert.match(markup,/hidden-card-back is-compact/);assert.doesNotMatch(markup,/\?牌|牌背|未知牌|>\s*\d+\s*</);assert.match(markup,/aria-hidden="true"/); });
test("已知对手手牌保留中文实体卡层级、删除英文标签并与牌背同尺寸", async () => { const human=makePlayer("human",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),card=instance("mutualBenefit"),{game}=makeGame([human,ai]);ai.hand.push(card);game.rememberPrivateCard(human,ai,card);const markup=opponentHandStripTemplate(createOpponentHandView(human,ai)),css=await readFile(projectFile("css/characters.css"),"utf8");for(const className of ["card-topline","card-name","card-category","card-art","card-crest","card-rules","card-description","card-flavor"])assert.match(markup,new RegExp(className));assert.doesNotMatch(markup,/card-tags|public-pool|draw/);assert.match(markup,new RegExp(card.name));assert.match(markup,new RegExp(card.description.slice(0,6)));assert.match(markup,new RegExp(card.flavorText.slice(0,4)));assert.match(css,/\.opponent-card-slot\s*\{[^}]*flex:\s*0\s+0\s+124px[^}]*width:\s*124px[^}]*height:\s*174px/s); });
test("人物席、中央消息区和真人区各占独立网格行且低高度改为内部滚动", async () => { const layoutCss=await readFile(projectFile("css/layout.css"),"utf8"),characterCss=await readFile(projectFile("css/characters.css"),"utf8");assert.match(layoutCss,/\.battlefield\s*\{[^}]*grid-template-rows:\s*minmax\(480px,[^}]*minmax\(174px,[^}]*minmax\(270px,[^}]*overflow-y:\s*auto/s);assert.match(layoutCss,/\.cpu-grid\s*\{[^}]*overflow:\s*hidden/s);assert.match(layoutCss,/\.command-deck\s*\{[^}]*min-height:\s*174px/s);assert.match(characterCss,/\.player-seat\s*\{[^}]*grid-template-rows:\s*minmax\(245px,[^}]*202px[^}]*overflow:\s*hidden/s); });
test("对手手牌滚动条预留独立高度且阵营与行动徽章位于裁切边界内", async () => { const css=await readFile(projectFile("css/characters.css"),"utf8");assert.match(css,/\.opponent-hand-strip\s*\{[^}]*height:\s*197px[^}]*overflow-x:\s*auto/s);assert.match(css,/\.player-seat\.is-ally::before[^}]*\{[^}]*top:\s*6px[^}]*left:\s*6px/s);assert.match(css,/\.player-seat\.is-active::after\s*\{[^}]*bottom:\s*8px/s);assert.match(css,/\.cpu-seat\.is-active::after\s*\{[^}]*bottom:\s*206px/s); });
test("低高度战场压缩为单屏且真人手牌顶部保留安全间距", async () => { const layout=await readFile(projectFile("css/layout.css"),"utf8"),cards=await readFile(projectFile("css/cards.css"),"utf8"),characters=await readFile(projectFile("css/characters.css"),"utf8");assert.match(layout,/@media \(max-height:\s*920px\)[\s\S]*grid-template-rows:\s*410px\s+135px\s+minmax\(250px,\s*1fr\)/);assert.match(layout,/\.human-hand\s*\{[^}]*padding:\s*4px\s+5px\s+7px/s);assert.match(cards,/@media \(max-height:\s*920px\)[\s\S]*\.hand-card\s*\{[^}]*clamp\(136px,\s*8\.5vw,\s*148px\)/);assert.match(characters,/@media \(max-height:\s*920px\)[\s\S]*grid-template-rows:\s*minmax\(194px,\s*1fr\)\s+197px/); });
test("对局中缩放进入窄屏断点会自动折叠日志避免遮挡战场", () => { const previousWindow=globalThis.window;let collapsed=null;globalThis.window={innerWidth:1000};const fake={viewportWasNarrow:false,elements:{game_screen:{classList:{contains:()=>false}}},setLogCollapsed:(value)=>{collapsed=value;}};try{UIManager.prototype.handleViewportResize.call(fake);assert.equal(collapsed,true);assert.equal(fake.viewportWasNarrow,true);globalThis.window.innerWidth=1440;UIManager.prototype.handleViewportResize.call(fake);assert.equal(collapsed,true);assert.equal(fake.viewportWasNarrow,false);}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;} });
test("隐藏牌选择窗口不显示牌背编号或真实卡牌资料", () => { const owner=makePlayer("owner",1,"dusk"),viewer=makePlayer("viewer",0,"dawn","human"),secret={...instance("counter"),name:"不可泄露名称",description:"不可泄露说明"};owner.hand.push(secret);const selection={tokens:[{token:"opaque-a",position:1}]},slots=createHiddenSelectionView(viewer,owner,selection),markup=hiddenSelectionMarkup(selection,slots);assert.deepEqual(slots,[{token:"opaque-a",known:false}]);for(const hidden of [secret.id,secret.definitionId,secret.name,secret.description,secret.art,"牌背 1","未知牌 1","？牌"])assert.ok(!markup.includes(hidden));assert.match(markup,/hidden-card-back/); });
test("所有隐藏牌界面源码不再生成可见牌背序号", async () => { const sources=await Promise.all(["js/ui/templates.js","js/ui/InteractionController.js"].map((file)=>readFile(projectFile(file),"utf8")));const source=sources.join("\n");assert.doesNotMatch(source,/牌背\s*\$\{|未知牌\s*\$\{|\?牌/); });
test("角色技能详情完整展示主动与被动公开信息", () => { const player=makePlayer("hero",0,"dawn","human",3);player.hand.push({...instance("counter"),name:"隐藏决策资料"});const markup=skillDetailsTemplate(player);assert.match(markup,/主动技能/);assert.match(markup,new RegExp(player.general.activeName));assert.match(markup,new RegExp(player.general.activeDescription));assert.match(markup,/能量消耗|发动时消耗全部能量/);assert.match(markup,/次数限制/);assert.match(markup,/被动技能/);assert.match(markup,new RegExp(player.general.passiveName));assert.match(markup,new RegExp(player.general.passiveDescription));assert.doesNotMatch(markup,/隐藏决策资料|knownCardsByPlayer|aiMemory|decision|weight/); });
test("八名角色使用结构化被动触发条件与限制文案", async () => { const expected={"blade-walker":"每回合按不同卡牌类别分别触发","oath-warden":"每轮限触发1次","spirit-medic":"每回合限触发1次","shade-agent":"每回合限触发1次","ember-magus":"每次卡牌结算最多触发1次","trail-hunter":"每回合限触发1次","fate-gambler":"每回合限触发1次","resonance-tuner":"每回合限触发1次"};for(const [index,general] of GENERAL_DEFINITIONS.entries()){assert.ok(general.passiveTriggerText);assert.equal(general.passiveLimitText,expected[general.id]);const player=makePlayer(`structured-${general.id}`,index,"dawn","human",index),markup=skillDetailsTemplate(player);assert.match(markup,new RegExp(general.passiveTriggerText));assert.match(markup,new RegExp(general.passiveLimitText));}const source=await readFile(projectFile("js/ui/templates.js"),"utf8");assert.doesNotMatch(source,/description\.includes\(|每轮一次.*includes|每回合首次.*includes/); });
test("技能查看仅响应专用入口且目标选择优先", () => { const source=makePlayer("source",0,"dawn","human"),target=makePlayer("target",1,"dusk");let resolved=null,shown=null,triggerUsed=null,rendered=0;const fake={game:{state:{players:[source,target]}},targetState:null,showSkillDetails:(value,trigger)=>{shown=value;triggerUsed=trigger;},render:()=>{rendered+=1;}};const panel={dataset:{playerId:target.id}},skillTrigger={dataset:{skillPlayerId:target.id}},eventFor=(kind)=>({target:{closest:(query)=>query==="[data-player-id]"?panel:(query==="[data-skill-player-id]"&&kind==="skill"?skillTrigger:null)}});UIManager.prototype.handlePlayerClick.call(fake,eventFor("hand"));assert.equal(shown,null);UIManager.prototype.handlePlayerClick.call(fake,eventFor("equipment"));assert.equal(shown,null);UIManager.prototype.handlePlayerClick.call(fake,eventFor("skill"));assert.equal(shown,target);assert.equal(triggerUsed,skillTrigger);shown=null;fake.targetState={players:[target],legalIds:new Set([target.id]),resolve:(value)=>{resolved=value;}};UIManager.prototype.handlePlayerClick.call(fake,eventFor("skill"));assert.equal(resolved,target);assert.equal(shown,null);assert.equal(rendered,1); });
test("关闭技能弹窗后焦点返回原生触发按钮", () => { let focused=0;const overlay={innerHTML:"dialog",classList:{add(){}}},trigger={isConnected:true,focus(){focused+=1;}};const fake={elements:{skill_details_overlay:overlay},skillDetailsTrigger:trigger};UIManager.prototype.hideSkillDetails.call(fake);assert.equal(overlay.innerHTML,"");assert.equal(fake.skillDetailsTrigger,null);assert.equal(focused,1); });
test("互利必须先选择再确认且可直接切换选择", async () => { const element=makeInteractiveElement(),view=new PublicPoolView(element),player=makePlayer("human",0,"dawn","human"),first=instance("assault"),second=instance("block");let settled=false;const pending=view.request(player,[first,second]).then((card)=>{settled=true;return card;});assert.match(element.innerHTML,/data-public-confirm disabled/);element.click(clickTarget("[data-public-card-id]",{publicCardId:first.id}));await Promise.resolve();assert.equal(settled,false);assert.equal(view.pending.selected.has(first.id),true);assert.doesNotMatch(element.innerHTML,/data-public-confirm disabled/);element.click(clickTarget("[data-public-card-id]",{publicCardId:second.id}));assert.deepEqual([...view.pending.selected],[second.id]);assert.equal(settled,false);element.click(clickTarget("[data-public-confirm]"));assert.equal(await pending,second);assert.equal(view.pending,null); });
test("互利界面不提供取消按钮且内部 cancel 仅供清理", async () => { const element=makeInteractiveElement(),view=new PublicPoolView(element),player=makePlayer("human",0,"dawn","human"),card=instance("recover");let settled=false;const pending=view.request(player,[card]).then((value)=>{settled=true;return value;});assert.doesNotMatch(element.innerHTML,/data-public-cancel|>取消</);element.click(clickTarget("[data-public-card-id]",{publicCardId:card.id}));element.click(clickTarget("[data-public-cancel]"));await Promise.resolve();assert.equal(settled,false);view.cancel();assert.equal(await pending,null);assert.equal(view.pending,null); });
test("有效对局中互利意外返回 null 会重开当前选择并继续后续座次", async () => { const human=makePlayer("human",0,"dawn","human"),next=makePlayer("next",1,"dusk"),last=makePlayer("last",2,"dawn"),{game,ui}=makeGame([human,next,last]);const cards=[instance("assault"),instance("block"),instance("recover")];game.publicCardPool.cards=[...cards];game.state.publicCardPool=game.publicCardPool.cards;let calls=0;ui.requestPublicCard=async (_player,available)=>{calls+=1;return calls===1?null:available[0];};const result=await game.publicCardPool.draft(human);assert.equal(result,true);assert.equal(calls,2);assert.equal(human.hand.length,1);assert.equal(next.hand.length,1);assert.equal(last.hand.length,1);assert.equal(game.state.publicCardPool.length,0); });
test("标准单选可直接从第一张切换到第二张", () => { let selected=toggleCardSelection(new Set(),"first",1);selected=toggleCardSelection(selected,"second",1);assert.deepEqual([...selected],["second"]);assert.equal(isCardSelectionValid(selected,1,true),true);selected=toggleCardSelection(selected,"second",1);assert.equal(selected.size,0); });
test("多选组件仍可同时保留多张选择", () => { let selected=toggleCardSelection(new Set(),"first",2);selected=toggleCardSelection(selected,"second",2);assert.deepEqual([...selected],["first","second"]);assert.equal(isCardSelectionValid(selected,2,true),true); });
test("真人已知的实体牌被AI窃取后仍在获得者面板显示真实牌面", async () => { const human=makePlayer("human",0,"dawn","human"),thief=makePlayer("thief",1,"dusk","ai",3),secret=instance("block");const {game}=makeGame([human,thief],{random:()=>0});human.hand.push(secret);thief.energy=3;await ACTIVE_SKILLS.stealSkill.execute(game,thief,[human]);const view=createOpponentHandView(human,thief);assert.equal(view[0].known,true);assert.equal(view[0].name,secret.name);assert.ok(game.state.logs.some((entry)=>entry.message.includes(thief.name)&&entry.message.includes(human.name)&&entry.message.includes(secret.name))); });
test("AI之间未公开随机获得不会向真人泄露牌面", async () => { const human=makePlayer("human",0,"dawn","human"),thief=makePlayer("thief",1,"dawn"),owner=makePlayer("owner",2,"dusk"),plunder=instance("plunder"),secret={...instance("counter"),name:"AI私密牌"};const {game}=makeGame([human,thief,owner],{random:()=>0});thief.hand.push(plunder);owner.hand.push(secret);await game.playCard(thief,plunder,[owner]);const view=createOpponentHandView(human,thief),markup=opponentHandStripTemplate(view);assert.ok(view.some((entry)=>entry.known===false));assert.ok(!markup.includes(secret.name));assert.ok(!game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("已知实体牌进入弃牌等非手牌区域后立即清除认知", async () => { const human=makePlayer("human",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),secret=instance("block");const {game}=makeGame([human,ai]);ai.hand.push(secret);game.rememberPrivateCard(human,ai,secret);await game.discardCardFromHand(ai,secret,"公开离手");assert.equal(human.aiMemory.knownCardsByPlayer[ai.id][secret.id],undefined);assert.ok(game.state.deck.discardPile.includes(secret)); });
test("AI面板按README类别及名称顺序排序且未知牌最后", () => { const human=makePlayer("human",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),unknown=instance("counter"),equipment=instance("energyDevice"),tactic=instance("destroy"),block=instance("block"),assault=instance("assault");ai.hand.push(unknown,equipment,tactic,block,assault);const {game}=makeGame([human,ai]);for(const card of [equipment,tactic,block,assault])game.rememberPrivateCard(human,ai,card);const before=ai.hand.map((card)=>card.id),view=createOpponentHandView(human,ai);assert.deepEqual(view.map((entry)=>entry.known?entry.name:"unknown"),[assault.name,block.name,tactic.name,equipment.name,"unknown"]);assert.deepEqual(ai.hand.map((card)=>card.id),before);assert.deepEqual(CARD_CATEGORY_DISPLAY_ORDER,{basic:0,tactic:1,equipment:2,unknown:3}); });
test("同类别已知牌严格采用README定义顺序", () => { const human=makePlayer("human",0,"dawn","human"),ai=makePlayer("ai",1,"dusk"),ids=["shield","charge","block","recover","assault","symbiosis","scout","mutualBenefit","destroy","barrierDevice","battleDevice","telescope","energyDevice"],cards=ids.map(instance);ai.hand.push(...cards);const {game}=makeGame([human,ai]);cards.forEach((card)=>game.rememberPrivateCard(human,ai,card));const ordered=createOpponentHandView(human,ai).map((entry)=>entry.name),expected=CARD_DEFINITION_DISPLAY_ORDER.filter((id)=>ids.includes(id)).map((id)=>CARD_DEFINITIONS[id].name);assert.deepEqual(ordered,expected);assert.ok(ordered.indexOf("护盾")>ordered.indexOf("聚能"));assert.ok(ordered.indexOf("望远镜")<ordered.indexOf("屏障")); });
test("AI 可见状态不含其他玩家真实手牌", () => { const ai=makePlayer("ai",0,"dawn"),other=makePlayer("other",1,"dusk");ai.hand.push(instance("assault"));other.hand.push(instance("counter"));const {game}=makeGame([ai,other]);const visible=createAiVisibleState(ai.id,game.state);assert.equal(visible.players[1].hand,undefined);assert.equal(visible.players[1].handCount,1);assert.equal(visible.players[0].hand[0].definitionId,"assault"); });
test("AI 可见状态、动作生成和模拟器正确识别阵营上限与无限调息", () => { const {game,small,large}=makeTeamFixture();large.hp-=1;large.turnFlags.recoverUsed=7;const recover=instance("recover");large.hand.push(recover);const visible=createAiVisibleState(large.id,game.state),smallView=visible.players.find((player)=>player.id===small.id),largeView=visible.players.find((player)=>player.id===large.id);assert.deepEqual([smallView.maxEnergy,smallView.recoverLimit],[4,null]);assert.deepEqual([largeView.maxEnergy,largeView.recoverLimit],[3,null]);const action=game.aiController.actionGenerator.generateFromVisible(visible,large.id).find((entry)=>entry.card?.id===recover.id);assert.ok(action);const simulated=new AiSimulator(visible).apply(visible,action,large.id),simulatedLarge=simulated.players.find((player)=>player.id===large.id);assert.equal(simulatedLarge.recoverLimit,null);assert.equal(simulatedLarge.hp,large.hp+1); });
test("AI只为自己或存活队友生成护盾目标并在深层模拟中叠加", () => { const actor=makePlayer("actor",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk"),card=instance("shield");actor.hand.push(card);ally.shield=1;const {game}=makeGame([actor,ally,enemy]);const visible=createAiVisibleState(actor.id,game.state),actions=game.aiController.actionGenerator.generateFromVisible(visible,actor.id).filter((action)=>action.card?.id===card.id);assert.deepEqual(actions.map((action)=>action.targets[0].id),[actor.id,ally.id]);const chosen=actions.find((action)=>action.targets[0].id===ally.id),next=new AiSimulator(visible).apply(visible,chosen,actor.id),nextAlly=next.players.find((player)=>player.id===ally.id);assert.equal(nextAlly.shield,2);assert.equal(visible.players.find((player)=>player.id===ally.id).shield,1); });
test("AI可见状态与模拟器保留主动技能多次发动额度", () => { const warden=makePlayer("warden",0,"dawn","ai",1),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");warden.energy=4;const {game}=makeGame([warden,ally,enemy]);warden.turnFlags.activeSkillUseCounts.barrier=1;warden.turnFlags.activeSkillsUsed.add("barrier");const visible=createAiVisibleState(warden.id,game.state),actor=visible.players.find((player)=>player.id===warden.id);assert.deepEqual([actor.activeSkillUses,actor.activeSkillLimit,actor.activeSkillUsed],[1,2,false]);const action=game.aiController.actionGenerator.generateFromVisible(visible,warden.id).find((entry)=>entry.type==="skill"&&entry.skill.id==="barrier");assert.ok(action);const next=new AiSimulator(visible).apply(visible,action,warden.id),nextActor=next.players.find((player)=>player.id===warden.id);assert.deepEqual([nextActor.activeSkillUses,nextActor.activeSkillUsed],[2,true]); });
test("AI 对未知调息只按公开手牌数估算而不读取真实牌面", () => { const ai=makePlayer("ai",0,"dawn"),other=makePlayer("other",1,"dusk");const {game}=makeGame([ai,other]);other.hand=[instance("recover")];const first=createAiVisibleState(ai.id,game.state).players[1].expectedRecoverCount;other.hand=[instance("assault")];const second=createAiVisibleState(ai.id,game.state).players[1].expectedRecoverCount;assert.equal(first,second); });
test("AI 模拟器只接收过滤快照并可独立克隆推演", () => { const visible={players:[{id:"a",battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,alive:true,handCount:1,hand:[{id:"x",definitionId:"assault"}]},{id:"b",battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,alive:true,handCount:2}]};const simulator=new AiSimulator(visible);const next=simulator.apply(visible,{type:"card",card:{id:"x",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].hp,3);assert.equal(visible.players[1].hp,4);assert.equal("game" in simulator,false); });
test("AI 动作生成使用同一距离合法性", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dusk"),makePlayer("d",3,"dawn"),makePlayer("e",4,"dusk")];const {game}=makeGame(ps);ps[0].hand.push(instance("assault"));const targets=game.aiController.getLegalActions(ps[0]).filter((a)=>a.card?.definitionId==="assault").map((a)=>a.targets[0].id);assert.deepEqual(targets,["b","e"]); });
test("AI 可见动作与模拟器支持范围内装备掠夺且不读取隐藏手牌", () => { const actor=makePlayer("actor",0,"dawn"),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),plunder=instance("plunder");actor.hand.push(plunder);target.equipment=instance("energyDevice");const {game}=makeGame([actor,near,target,other,tail]),visible=createAiVisibleState(actor.id,game.state),actions=game.aiController.actionGenerator.generateFromVisible(visible,actor.id);const action=actions.find((entry)=>entry.card?.id===plunder.id&&entry.targets[0]?.id===target.id);assert.ok(action);assert.equal(visible.players[2].hand,undefined);const next=new AiSimulator(visible).apply(visible,action,actor.id);assert.equal(next.players[2].equipmentDefinitionId,null);assert.equal(next.players[0].equipmentDefinitionId,"energyDevice");assert.equal(next.players[0].handCount,0); });
test("AI 束搜索实际达到多层、记录展开节点并采样10个隐藏世界", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);a.hand.push(instance("charge"),instance("exposeWeakness"),instance("assault"));const action=await game.aiController.selectAction(a,{gameId:game.state.gameId});assert.ok(["card","skill","end"].includes(action.type));assert.ok(game.aiController.planner.lastSearchStats.expanded>3);assert.ok(game.aiController.planner.lastSearchStats.depth>=2);assert.equal(game.aiController.planner.lastSearchStats.hiddenSamples,10); });
test("AI 模拟器识别破势叠加后强化普通突袭", () => { const visible={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:4,attackRange:1,attackUsed:0,attackLimit:2,recoverUsed:0,recoverLimit:null,exposeWeaknessStacks:0,alive:true,handCount:3,hand:[{id:"x1",definitionId:"exposeWeakness"},{id:"x2",definitionId:"exposeWeakness"},{id:"a1",definitionId:"assault"}]},{id:"b",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,attackRange:1,alive:true,handCount:0}]};const simulator=new AiSimulator(visible);const once=simulator.apply(visible,{type:"card",card:{id:"x1",definitionId:"exposeWeakness"},targets:[]},"a");const twice=simulator.apply(once,{type:"card",card:{id:"x2",definitionId:"exposeWeakness"},targets:[]},"a");const attacked=simulator.apply(twice,{type:"card",card:{id:"a1",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(attacked.players[1].hp,1);assert.equal(attacked.players[0].exposeWeaknessStacks,0);assert.equal(attacked.players[0].recoverLimit,null); });
test("AI 深层节点能发现先聚能再发动主动技能", () => { const actor=makePlayer("a",0,"dawn","ai",2),ally=makePlayer("ally",1,"dawn","ai",1),enemy=makePlayer("e",2,"dusk");actor.energy=1;ally.hp-=1;actor.hand.push(instance("charge"));const {game}=makeGame([actor,ally,enemy]);const visible=createAiVisibleState(actor.id,game.state);const simulator=new AiSimulator(visible);const charged=simulator.apply(visible,{type:"card",card:actor.hand[0],targets:[]},actor.id);const follow=game.aiController.actionGenerator.generateFromVisible(charged,actor.id);assert.ok(follow.some((action)=>action.type==="skill"&&action.skill.id==="symbiosis"&&action.targets[0].id===ally.id)); });
test("AI 模拟伤害会计算队伍调息并保留可获救角色", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:1,maxHp:4,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0},{id:"c",seatIndex:2,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,expectedRecoverCount:1}]};const simulator=new AiSimulator(state);const next=simulator.apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].alive,true);assert.equal(next.players[1].hp,1);assert.equal(next.players[2].expectedRecoverCount,0); });
test("AI 模拟调息不足时保持0血离散阵亡而不制造半血存活者", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:0,maxHp:4,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0},{id:"c",seatIndex:2,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,expectedRecoverCount:1}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].alive,false);assert.equal(next.players[1].hp,0);assert.equal(next.players[1].survivalChance,.5); });
test("AI 模拟军火库要求两张格挡而不是一张", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,equipmentDefinitionId:"battleDevice",expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,blockProbability:1,twoBlockProbability:0,expectedRecoverCount:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].hp,2); });
test("AI 模拟雷达按当前牌堆配置计算判定概率", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:0,blockProbability:0,twoBlockProbability:0,equipmentDefinitionId:"defenseDevice",expectedRecoverCount:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a"),basicTotal=Object.values(CARD_DEFINITIONS).filter((card)=>card.category==="basic").reduce((sum,card)=>sum+card.count,0),otherBasic=basicTotal-CARD_DEFINITIONS.block.count,equipment=Object.values(CARD_DEFINITIONS).filter((card)=>card.category==="equipment").reduce((sum,card)=>sum+card.count,0);assert.ok(Math.abs(next.players[1].hp-(3-(otherBasic+equipment)/TOTAL_CARD_COUNT))<1e-9); });
test("AI 模拟反制会考虑同阵营响应者的阵营净收益", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"s",definitionId:"symbiosis"}]},{id:"ally",seatIndex:1,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,counterProbability:1},{id:"e1",seatIndex:2,battleTeam:"dusk",hp:2,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0},{id:"e2",seatIndex:3,battleTeam:"dusk",hp:2,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.symbiosis,id:"s"},targets:state.players},"a");assert.equal(next.players[2].hp,2);assert.equal(next.players[3].hp,2); });
test("AI 模拟震荡时按目标分别计算反制而不是取消整张牌", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{...CARD_DEFINITIONS.shockwave,id:"s"}]},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,counterProbability:1,blockProbability:0,expectedRecoverCount:0},{id:"c",seatIndex:2,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0,blockProbability:0,expectedRecoverCount:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.shockwave,id:"s"},targets:[state.players[1],state.players[2]]},"a");assert.equal(next.players[1].hp,3);assert.equal(next.players[2].hp,2); });
test("AI 模拟挑衅时按目标分别计算反制", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{...CARD_DEFINITIONS.provoke,id:"p"}]},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,counterProbability:1,assaultResponseProbability:0,expectedAssaultCount:0},{id:"c",seatIndex:2,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0,assaultResponseProbability:0,expectedAssaultCount:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.provoke,id:"p"},targets:[state.players[1],state.players[2]]},"a");assert.equal(next.players[1].hp,3);assert.equal(next.players[2].hp,2); });
test("AI 模拟回收站在前两张战术后补牌且第三张不再触发", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:3,hand:[{id:"x1",definitionId:"exposeWeakness"},{id:"x2",definitionId:"exposeWeakness"},{id:"x3",definitionId:"exposeWeakness"}],equipmentDefinitionId:"recycleDevice",recycleDeviceUses:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0}]};const simulator=new AiSimulator(state);const once=simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x1"},targets:[]},"a");const twice=simulator.apply(once,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x2"},targets:[]},"a");const thrice=simulator.apply(twice,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x3"},targets:[]},"a");assert.equal(once.players[0].handCount,3);assert.equal(twice.players[0].handCount,3);assert.equal(thrice.players[0].handCount,2);assert.equal(thrice.players[0].recycleDeviceUses,2); });
test("AI 深层结束与重复装备评分读取模拟节点而非根玩家", () => { const real=makePlayer("a",0,"dawn");real.hand.push(instance("assault"),instance("charge"));const enemy=makePlayer("b",1,"dusk");const {game}=makeGame([real,enemy]);const evaluator=game.aiController.evaluator;const emptyVisible={players:[{id:real.id,battleTeam:"dawn",handCount:0,equipmentDefinitionId:"energyDevice"},{id:enemy.id,battleTeam:"dusk",alive:true,hp:3,maxHp:3}]};assert.equal(evaluator.actionUtility({type:"end"},real,emptyVisible),0);const equipment=instance("energyDevice");assert.equal(evaluator.actionUtility({type:"card",card:equipment,targets:[]},real,emptyVisible),equipment.aiValue-4); });
test("AI 到达搜索预算仍返回当前最佳合法动作", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);for(let i=0;i<8;i+=1)a.hand.push(instance(i%2?"exposeWeakness":"assault"));game.aiSearchBudgetOverrideMs=0;const action=await game.aiController.selectAction(a,{gameId:game.state.gameId});assert.ok(["card","skill","end"].includes(action.type));assert.ok(game.aiController.planner.lastSearchStats.elapsedMs<250); });
test("AI 低血弃牌会保留调息和格挡", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);a.hp=1;a.hand.push(instance("recover"),instance("block"),instance("charge"),instance("assault"));const discarded=game.aiController.chooseDiscards(a,2).map((card)=>card.definitionId);assert.ok(!discarded.includes("recover"));assert.ok(!discarded.includes("block")); });
test("AI 不会反制对己方净治疗明显有利的共生", () => { const a=makePlayer("a",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");a.hp-=1;ally.hp-=1;const {game}=makeGame([a,ally,enemy]);const use=game.aiController.responsePolicy.shouldRespond(a,"counter",{source:enemy,card:instance("symbiosis")},[instance("counter")]);assert.equal(use,false); });
test("AI 对互利按当前存活敌我人数决定是否反制", () => { const smallA=makePlayer("small-a",0,"dawn"),largeA=makePlayer("large-a",1,"dusk"),smallB=makePlayer("small-b",2,"dawn"),largeB=makePlayer("large-b",3,"dusk"),largeC=makePlayer("large-c",4,"dusk");const {game}=makeGame([smallA,largeA,smallB,largeB,largeC]);const card=instance("mutualBenefit"),counter=instance("counter");assert.equal(game.aiController.responsePolicy.shouldRespond(smallA,"counter",{source:largeA,card},[counter]),true);assert.equal(game.aiController.responsePolicy.shouldRespond(largeA,"counter",{source:smallA,card},[counter]),false);largeC.alive=false;assert.equal(game.aiController.responsePolicy.shouldRespond(smallA,"counter",{source:largeA,card},[counter]),false); });
test("AI 对共生按双方本次实际治疗人数决定是否反制", () => { const a=makePlayer("a",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemyA=makePlayer("enemy-a",2,"dusk"),enemyB=makePlayer("enemy-b",3,"dusk"),enemyC=makePlayer("enemy-c",4,"dusk");const {game}=makeGame([a,ally,enemyA,enemyB,enemyC]);const card=instance("symbiosis"),counter=instance("counter");a.hp-=1;ally.hp-=1;enemyA.hp-=1;assert.equal(game.aiController.responsePolicy.shouldRespond(a,"counter",{source:enemyA,card},[counter]),false);ally.hp=ally.maxHp;enemyB.hp-=1;assert.equal(game.aiController.responsePolicy.shouldRespond(a,"counter",{source:enemyA,card},[counter]),true); });
test("AI 模拟器与真实策略使用相同的全体受益反制判断", () => { const state={players:[{id:"small-a",battleTeam:"dawn",alive:true,hp:4,maxHp:4},{id:"large-a",battleTeam:"dusk",alive:true,hp:4,maxHp:4},{id:"small-b",battleTeam:"dawn",alive:true,hp:4,maxHp:4},{id:"large-b",battleTeam:"dusk",alive:true,hp:4,maxHp:4},{id:"large-c",battleTeam:"dusk",alive:true,hp:4,maxHp:4}]};const simulator=new AiSimulator(state),small=state.players[0],large=state.players[1],card={...CARD_DEFINITIONS.mutualBenefit,id:"mutual"};assert.equal(simulator.counterDesire(state,small,large,card,[]),1);assert.equal(simulator.counterDesire(state,large,small,card,[]),0);state.players[4].alive=false;assert.equal(simulator.counterDesire(state,small,large,card,[]),0); });
test("回合能量事件公开配置基础、零阵营加成和装备加成且不能突破上限", async () => { const {game,small}=makeTeamFixture();small.energy=3;small.equipment=instance("energyDevice");game.cleanupManager.delay=async()=>true;game.aiController.selectAction=async()=>({type:"end"});let before=null,after=null;game.eventBus.on("beforeTurnEnergyGain","test:before",(event)=>{before={baseAmount:event.baseAmount,teamBonus:event.teamBonus,equipmentBonus:event.equipmentBonus,amount:event.amount};});game.eventBus.on("afterTurnEnergyGain","test:after",(event)=>{after=event.actualAmount;});await game.takeTurn(small,game.state.gameId);assert.deepEqual(before,{baseAmount:1,teamBonus:0,equipmentBonus:1,amount:2});assert.equal(after,1);assert.equal(small.energy,4); });
test("AI 未知牌按位置采样而不因真实 definitionId 改变选择位置", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b],{random:()=>.6});b.hand=[instance("counter"),instance("charge"),instance("block")];const first=game.aiController.cardSelector.chooseHiddenCards(a,b,1)[0];b.hand=[instance("assault"),instance("recover"),instance("energyDevice")];const second=game.aiController.cardSelector.chooseHiddenCards(a,b,1)[0];assert.equal(first.definitionId,"charge");assert.equal(second.definitionId,"recover"); });
test("AI 自救响应策略为确定必用，敌方救援为拒绝", () => { const a=makePlayer("a",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([a,ally,enemy]);assert.equal(game.aiController.responsePolicy.shouldRespond(a,"dyingRescue",{target:a},[instance("recover")]),true);assert.equal(game.aiController.responsePolicy.shouldRespond(enemy,"dyingRescue",{target:a},[instance("recover")]),false); });
test("AI 延迟在配置上下限内且快速模式显著缩短", () => { const natural=sampleDelay(()=>.5,GAME_CONFIG.aiInitialThinkMinMs,GAME_CONFIG.aiInitialThinkMaxMs,false);const fast=sampleDelay(()=>.5,GAME_CONFIG.aiInitialThinkMinMs,GAME_CONFIG.aiInitialThinkMaxMs,true);assert.ok(natural>=GAME_CONFIG.aiInitialThinkMinMs&&natural<=GAME_CONFIG.aiInitialThinkMaxMs);assert.ok(fast<natural/2); });
test("AI 各可见思考阶段使用集中配置范围且不改变搜索预算", () => { const ranges={initial:[3000,5500],action:[1800,3500],response:[1800,3200],discard:[1600,2800],end:[900,1600]};for(const [phase,[minimum,maximum]] of Object.entries(ranges)){const low=getAiDelay({random:()=>0,simulationMode:false,animationFastMode:false},phase),high=getAiDelay({random:()=>.999999,simulationMode:false,animationFastMode:false},phase),fast=getAiDelay({random:()=>.5,simulationMode:false,animationFastMode:true},phase);assert.equal(low,minimum);assert.ok(high<=maximum&&high>=maximum-1);assert.ok(fast<(minimum+maximum)/4);}assert.equal(GAME_CONFIG.aiComplexThinkMaxMs,7000);assert.equal(GAME_CONFIG.aiSearchTimeBudgetMs,900); });
test("复杂局面首次思考实际使用 aiComplexThinkMaxMs 上限", () => { const game={random:()=>.999999,simulationMode:false,animationFastMode:false};assert.equal(getAiDelay(game,"initial"),GAME_CONFIG.aiInitialThinkMaxMs);assert.equal(getAiDelay(game,"initial",{complex:true}),GAME_CONFIG.aiComplexThinkMaxMs); });
test("关闭逐动作重规划时会复用仍合法的束搜索牌序", async () => { const actor=makePlayer("a",0,"dawn"),enemy=makePlayer("b",1,"dusk");const charge=instance("charge");actor.hand.push(charge);const {game}=makeGame([actor,enemy]);game.aiReplanAfterEveryAction=false;let plans=0;game.aiController.selectAction=async()=>{plans+=1;game.aiController.planner.lastPlannedSequence=[{type:"card",cardId:"charge",cardInstanceId:charge.id,targetIds:[]},{type:"end",cardId:null,cardInstanceId:null,targetIds:[]}];return {type:"card",card:charge,targets:[]};};await game.takeAiPlayPhase(actor,game.state.gameId);assert.equal(plans,1);assert.equal(actor.energy,1);assert.equal(actor.hand.length,0); });
test("aiRandomnessRange 控制近似同分动作的评分扰动", () => { const actor=makePlayer("a",0,"dawn"),enemy=makePlayer("b",1,"dusk");const {game}=makeGame([actor,enemy]);const beam=[{score:10,id:"first"},{score:9.9,id:"second"}];game.aiRandomnessRange=0;assert.equal(game.aiController.planner.chooseCandidate(beam).id,"first");const rolls=[0,1];game.random=()=>rolls.shift();game.aiRandomnessRange=.1;assert.equal(game.aiController.planner.chooseCandidate(beam).id,"second"); });
test("ThreatCalculator 的稳定角色标签与近期攻击者会进入目标评分", () => { const viewer={battleTeam:"dawn"},base={id:"x",alive:true,battleTeam:"dusk",hp:3,maxHp:4,shield:0,energy:1,handCount:1,tags:[],statuses:[]};const plain=ThreatCalculator.calculate(viewer,{...base,roleTags:[]},{recentAggressors:{}},1);const support=ThreatCalculator.calculate(viewer,{...base,roleTags:["support","healer"]},{recentAggressors:{}},1);assert.ok(support>plain);const actor=makePlayer("a",0,"dawn"),first=makePlayer("first",1,"dusk","ai",4),second=makePlayer("second",2,"dusk","ai",4);const {game}=makeGame([actor,first,second]);actor.aiMemory.recentAggressors[second.id]=3;const visible=createAiVisibleState(actor.id,game.state),assault=instance("assault"),score=(target)=>game.aiController.evaluator.actionUtility({type:"card",card:assault,targets:[target]},actor,visible);game.aiDifficultyMultiplier=0;assert.equal(score(first),score(second));game.aiDifficultyMultiplier=1;assert.ok(score(second)>score(first)); });
test("CleanupManager 可取消尚未完成的延迟", async () => { const cleanup=new CleanupManager();const waiting=cleanup.delay(5000);cleanup.cleanup();assert.equal(await waiting,false);assert.equal(cleanup.pending.size,0); });
test("响应窗口超时会按放弃处理并清除响应状态", async () => { const previousWindow=globalThis.window;globalThis.window={setInterval,clearInterval};const panel={innerHTML:"",classList:{add(){},remove(){}},querySelector(){return null;}};const fake={responseState:null,elements:{response_panel:panel},game:{cleanupManager:{delay:async()=>true}},render(){}};try{const result=await UIManager.prototype.requestResponse.call(fake,{id:"timeout-response",requiredCount:1,legalCardIds:[],timeoutMs:1,presentation:{eventText:"测试事件",responseText:"需要响应",availabilityText:"当前不足",buttonLabel:"格挡"}},"格挡");assert.equal(result,false);assert.equal(fake.responseState,null);assert.equal(panel.innerHTML,"");}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;} });
test("销毁对局会结束未完成响应 Promise 并清空请求", async () => { const a=makePlayer("a",0,"dawn"),human=makePlayer("human",1,"dusk","human");const {game,ui}=makeGame([a,human]);let settle=null;ui.requestResponse=()=>new Promise((resolve)=>{settle=resolve;});ui.cancelPendingInteractions=()=>{settle?.(false);};const pending=game.responseSystem.requestCardResponse(human,"block",{source:a,target:human,card:instance("assault")},1);await Promise.resolve();assert.equal(game.state.pendingResponses.length,1);game.dispose();assert.deepEqual(await pending,[]);assert.equal(game.state.pendingResponses.length,0); });
test("重新征召 cleanup 会清空隐藏令牌、公共池和响应", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));game.cardSelectionSystem.createHiddenSelection(b);game.state.pendingResponses.push({id:"old"});game.dispose();assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.state.pendingResponses.length,0);assert.equal(game.state.publicCardPool.length,0); });
test("重新征召后按新阵营重新设置能量上限和无限调息", async () => { const verify=async(seed)=>{let value=seed;const random=()=>((value=Math.imul(value,1664525)+1013904223>>>0)/4294967296),ui=makeUi(),game=new Game(ui,random);game.simulationMode=true;game.cleanupManager.delay=async()=>!game.state.isDisposed;const candidates=game.startSelection();for(const player of game.state.players)assert.equal(player.maxEnergy,game.teamRules.getTeamSize(player)===2?4:3);await game.confirmGeneral(candidates[0].id);for(const player of game.state.players){assert.equal(player.maxEnergy,game.teamRules.getMaxEnergy(player));assert.equal(player.turnFlags.recoverLimit,null);}game.dispose();await game.loopPromise;};await verify(11);await verify(29); });
test("装备槽空置和六种装备生成不同可访问 DOM", () => { const p=makePlayer("a",0,"dawn");const empty=equipmentSlotTemplate(p,true);assert.match(empty,/is-empty|装备槽为空/);for(const id of ["energyDevice","recycleDevice","defenseDevice","battleDevice","telescope","barrierDevice"]){p.equipment=instance(id);const markup=equipmentSlotTemplate(p,true);assert.match(markup,new RegExp(CARD_DEFINITIONS[id].name));assert.match(markup,new RegExp(CARD_DEFINITIONS[id].description.slice(0,6)));assert.notEqual(markup,empty);} });
test("UIManager 源码不直接写生命、能量、手牌或胜负", async () => { const source=await readFile(projectFile("js/ui/UIManager.js"),"utf8");for(const forbidden of [/\.hp\s*=/,/\.energy\s*=/,/\.hand\.(?:push|splice|pop|shift|unshift)/,/\.winnerTeam\s*=/,/\.isGameOver\s*=/])assert.doesNotMatch(source,forbidden); });
test("全 AI 快速对局能推进到合法胜者", async () => { let seed=77;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);const ui=makeUi();const game=new Game(ui,random);game.simulationMode=true;game.setAnimationFastMode(true);game.cleanupManager.delay=async()=>!game.state.isDisposed;const candidates=game.startSelection();game.state.players[0].controllerType="ai";await game.confirmGeneral(candidates[0].id);const result=await Promise.race([game.loopPromise.then(()=>"done"),new Promise((resolve)=>setTimeout(()=>resolve("timeout"),10000))]);assert.equal(result,"done");assert.ok(["dawn","dusk"].includes(game.state.winnerTeam));game.dispose(); });

// 本轮规则修复回归
test("掠夺装备会替换使用者旧装备并将旧装备公开弃置", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),target=makePlayer("target",1,"dusk"),use=instance("plunder");
  const old=instance("barrierDevice"),moved=instance("energyDevice");actor.equipment=old;actor.hand.push(use);target.equipment=moved;
  const {game}=makeGame([actor,target]);const selection=game.cardSelectionSystem.createHiddenSelection(target);
  await game.playCard(actor,use,[target],{zone:"equipment",equipmentCardId:moved.id,selectionId:selection.selectionId});
  assert.equal(actor.equipment,moved);assert.ok(game.state.deck.discardPile.includes(old));assert.equal(target.equipment,null);
});
test("雷达装备判定后仍可正常使用已有格挡", async () => {
  const attacker=makePlayer("attacker",0,"dawn"),defender=makePlayer("defender",1,"dusk","human");
  const {game,ui}=makeGame([attacker,defender],{response:(request)=>request.type==="block"});
  defender.equipment=instance("defenseDevice");defender.hand.push(instance("block"));game.state.deck.cards.push(instance("energyDevice"));
  const hp=defender.hp;await game.damage(attacker,defender,1,{card:instance("assault"),canBlock:true,damageType:"normal"});
  assert.equal(defender.hp,hp);assert.equal(defender.hand.length,0);assert.ok(ui.responseRequests.some((request)=>request.type==="block"));
});
test("互利规则目标包含所有存活角色且调律师只触发一次协调", async () => {
  const tuner=makePlayer("tuner",0,"dawn","ai",7),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  const {game}=makeGame([tuner,ally,enemy]);registerPassiveSkills(game);
  assert.deepEqual(RuleEngine.getCardTargets(game,tuner,CARD_DEFINITIONS.mutualBenefit),[tuner,ally,enemy]);
  game.state.deck.cards.push(instance("assault"),instance("block"),instance("charge"),instance("shield"));
  const use=instance("mutualBenefit");tuner.hand.push(use);await game.playCard(tuner,use,[]);
  assert.equal(tuner.turnFlags.coordinationTriggered,true);assert.equal(tuner.hand.length,2);
});
test("调律师转移给队友把接收者作为有效目标并只触发一次协调", async () => {
  const tuner=makePlayer("tuner",0,"dawn","ai",7),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const {game}=makeGame([tuner,enemy,ally]);registerPassiveSkills(game);game.state.deck.cards.push(instance("charge"));
  const use=instance("transfer"),moved=instance("block");tuner.hand.push(use);enemy.hand.push(moved);enemy.bumpHandVersion();
  const hidden=game.cardSelectionSystem.createHiddenSelection(enemy);
  await game.playCard(tuner,use,[],{sourceId:enemy.id,receiverId:ally.id,zone:"hand",tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});
  assert.ok(ally.hand.includes(moved));assert.equal(tuner.turnFlags.coordinationTriggered,true);assert.equal(tuner.hand.length,1);
});
test("AI 破坏与掠夺只生成敌方目标，窃取规则也排除队友", () => {
  const actor=makePlayer("actor",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  ally.hand.push(instance("block"));enemy.hand.push(instance("block"));
  const destroy=instance("destroy"),plunder=instance("plunder");actor.hand.push(destroy,plunder);
  const {game}=makeGame([actor,ally,enemy]);
  const actions=game.aiController.actionGenerator.generate(actor);
  for(const id of ["destroy","plunder"]){
    const targets=actions.filter((action)=>action.card?.definitionId===id).map((action)=>action.targets[0]);
    assert.ok(targets.length>0);assert.ok(targets.every((target)=>target.battleTeam!==actor.battleTeam));
  }
  assert.ok(!RuleEngine.getSkillTargets(game,actor,ACTIVE_SKILLS.stealSkill).includes(ally));
});
test("AI 转移不会拿真人队友的雷达填自己的空装备槽", () => {
  const actor=makePlayer("actor",0,"dawn"),humanAlly=makePlayer("human-ally",1,"dawn","human");
  actor.hand.push(instance("transfer"));humanAlly.equipment=instance("defenseDevice");const {game}=makeGame([actor,humanAlly]);
  assert.equal(game.aiController.actionGenerator.generate(actor).some((action)=>action.card?.definitionId==="transfer"),false);
});
test("AI 转移不会执行 AI 队友装备之间的零收益搬运", () => {
  const actor=makePlayer("actor",0,"dawn"),ally=makePlayer("ally",1,"dawn");
  actor.hand.push(instance("transfer"));ally.equipment=instance("defenseDevice");const {game}=makeGame([actor,ally]);
  assert.equal(game.aiController.actionGenerator.generate(actor).some((action)=>action.card?.definitionId==="transfer"),false);
});
test("AI 转移最佳方案为负数时不进入实际动作列表", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk");
  actor.hand.push(instance("transfer"));const {game}=makeGame([actor,enemy]);
  assert.equal(game.aiController.actionGenerator.generate(actor).some((action)=>action.card?.definitionId==="transfer"),false);
});
test("AI 转移可从敌人移走高价值装备交给队友", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const use=instance("transfer");actor.hand.push(use);actor.equipment=instance("energyDevice");enemy.equipment=instance("defenseDevice");const {game}=makeGame([actor,enemy,ally]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  assert.ok(action);assert.equal(action.selection.sourceId,enemy.id);assert.equal(action.selection.receiverId,ally.id);assert.equal(action.selection.zone,"equipment");
});
test("AI 转移可用敌方低价值装备替换敌方高价值装备", () => {
  const actor=makePlayer("actor",0,"dawn"),low=makePlayer("low",1,"dusk"),high=makePlayer("high",2,"dusk");
  const use=instance("transfer");actor.hand.push(use);actor.equipment=instance("battleDevice");low.equipment=instance("energyDevice");high.equipment=instance("defenseDevice");const {game}=makeGame([actor,low,high]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  assert.ok(action);assert.equal(action.selection.sourceId,low.id);assert.equal(action.selection.receiverId,high.id);
});
test("AI 转移可将即将溢出的队友手牌移给有空间的队友", () => {
  const actor=makePlayer("actor",0,"dawn"),overflow=makePlayer("overflow",1,"dawn"),receiver=makePlayer("receiver",2,"dawn");
  const use=instance("transfer");actor.hand.push(use);overflow.hp=1;overflow.hand.push(instance("harvest"),instance("charge"));const {game}=makeGame([actor,overflow,receiver]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  assert.ok(action);assert.equal(action.selection.sourceId,overflow.id);assert.equal(action.selection.zone,"hand");
});
test("AI 转移真实动作与深层模拟对同一公开局面选择一致", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const use=instance("transfer");actor.hand.push(use);actor.equipment=instance("energyDevice");enemy.equipment=instance("defenseDevice");const {game}=makeGame([actor,enemy,ally]);
  const real=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  const visible=createAiVisibleState(actor.id,game.state);
  const simulated=game.aiController.actionGenerator.generateFromVisible(visible,actor.id).find((entry)=>entry.card?.id===use.id);
  const plan=(action)=>[action?.selection?.sourceId,action?.selection?.receiverId,action?.selection?.zone];
  assert.ok(real);assert.ok(simulated);assert.deepEqual(plan(real),plan(simulated));
});
test("交换敌人未知手牌的真实 definitionId 不改变 AI 转移计划", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const use=instance("transfer"),first=instance("counter"),second=instance("harvest");actor.hand.push(use);enemy.hand.push(first,second);const {game}=makeGame([actor,enemy,ally]);
  const choose=()=>{const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);return [action?.selection?.sourceId,action?.selection?.receiverId,action?.selection?.zone];};
  const before=choose();[first.definitionId,second.definitionId]=[second.definitionId,first.definitionId];assert.deepEqual(choose(),before);
});
test("正式击杀敌人先摸2张牌再判定胜负，救回与队友死亡均不奖励", async () => {
  const killer=makePlayer("killer",0,"dawn"),enemy=makePlayer("enemy",1,"dusk");
  const {game}=makeGame([killer,enemy]);game.state.deck.cards.push(instance("charge"),instance("block"));enemy.hp=1;
  await game.damage(killer,enemy,1,{canBlock:false});
  assert.equal(enemy.hp,0);assert.equal(enemy.alive,false);assert.equal(killer.hand.length,2);assert.equal(game.state.isGameOver,true);
  assert.ok(game.state.logs.some((entry)=>entry.message===`${killer.name}击杀了${enemy.name}，摸了2张牌。`));

  const source=makePlayer("source",0,"dawn"),rescued=makePlayer("rescued",1,"dusk");rescued.hp=1;rescued.hand.push(instance("recover"));
  const {game:rescueGame}=makeGame([source,rescued]);rescueGame.state.deck.cards.push(instance("charge"),instance("block"));
  await rescueGame.damage(source,rescued,1,{canBlock:false});assert.equal(rescued.alive,true);assert.equal(source.hand.length,0);

  const allySource=makePlayer("ally-source",0,"dawn"),allyTarget=makePlayer("ally-target",1,"dawn"),otherEnemy=makePlayer("other-enemy",2,"dusk");
  const {game:allyGame}=makeGame([allySource,allyTarget,otherEnemy]);allyGame.state.deck.cards.push(instance("charge"),instance("block"));allyTarget.hp=1;
  await allyGame.damage(allySource,allyTarget,1,{canBlock:false});assert.equal(allySource.hand.length,0);
});
test("转移在反制前的日志和响应上下文包含来源与接收者但不泄露隐藏牌名", async () => {
  const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),responder=makePlayer("responder",2,"dusk","human"),receiver=makePlayer("receiver",3,"dawn");
  const use=instance("transfer"),secret=instance("block");actor.hand.push(use);from.hand.push(secret);from.bumpHandVersion();
  const {game,ui}=makeGame([actor,from,responder,receiver],{response:()=>false});const hidden=game.cardSelectionSystem.createHiddenSelection(from);
  await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});
  const request=ui.responseRequests.find((entry)=>entry.type==="counter"&&entry.targetPlayerId===responder.id);
  assert.match(request.presentation.eventText,new RegExp(`${from.name}.*1张牌.*${receiver.name}`));
  assert.doesNotMatch(request.presentation.eventText,new RegExp(secret.name));
  const intentLog=game.state.logs.find((entry)=>entry.message.includes("准备将"));
  assert.match(intentLog.message,new RegExp(`${from.name}.*1张牌.*${receiver.name}`));assert.doesNotMatch(intentLog.message,new RegExp(secret.name));
});
test("隐藏转移传给 AI 响应策略的公开上下文不含锁定手牌资料", async () => {
  const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),responder=makePlayer("responder",2,"dusk"),receiver=makePlayer("receiver",3,"dawn");
  const use=instance("transfer"),secret={...instance("block"),name:"绝密锁定牌"};actor.hand.push(use);from.hand.push(secret);responder.hand.push(instance("counter"));
  const {game}=makeGame([actor,from,responder,receiver],{random:()=>0});let receivedContext=null;
  game.aiController.responsePolicy.shouldRespond=(_player,_type,context)=>{receivedContext=context;return false;};
  await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"hand"});
  assert.ok(receivedContext);const publicContext=receivedContext.publicTransferContext;assert.ok(publicContext);assert.equal(Object.isFrozen(publicContext),true);
  for(const forbidden of ["card","cardId","definitionId","hiddenCardName"])assert.equal(Object.hasOwn(publicContext,forbidden),false);
  const seen=new Set();const contains=(value,needle)=>{if(value===needle)return true;if(!value||typeof value!=="object"||seen.has(value))return false;seen.add(value);return Object.values(value).some((entry)=>contains(entry,needle));};
  for(const secretValue of [secret,secret.id,secret.definitionId,secret.name]){seen.clear();assert.equal(contains(receivedContext,secretValue),false);}
  assert.equal(publicContext.safeItemLabel,"1张牌");
});
test("转移响应期间手牌换序后仍移动反制前锁定的同一实体", async () => {
  const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),responder=makePlayer("responder",2,"dusk"),receiver=makePlayer("receiver",3,"dawn");
  const use=instance("transfer"),locked=instance("block"),other=instance("harvest");actor.hand.push(use);from.hand.push(locked,other);responder.hand.push(instance("counter"));
  const {game}=makeGame([actor,from,responder,receiver],{random:()=>0});game.aiController.responsePolicy.shouldRespond=()=>{from.hand.reverse();return false;};
  await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"hand"});
  assert.ok(receiver.hand.includes(locked));assert.ok(from.hand.includes(other));assert.ok(!receiver.hand.includes(other));
});
test("转移被反制后锁定手牌仍留在来源区域", async () => {
  const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),responder=makePlayer("responder",2,"dusk"),receiver=makePlayer("receiver",3,"dawn");
  const use=instance("transfer"),locked=instance("block");actor.hand.push(use);from.hand.push(locked);responder.hand.push(instance("counter"));
  const {game}=makeGame([actor,from,responder,receiver],{random:()=>0});game.aiController.responsePolicy.shouldRespond=()=>true;
  await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"hand"});
  assert.ok(from.hand.includes(locked));assert.ok(!receiver.hand.includes(locked));
});
test("公开装备转移的响应上下文可安全显示装备名", async () => {
  const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),responder=makePlayer("responder",2,"dusk"),receiver=makePlayer("receiver",3,"dawn");
  const use=instance("transfer"),radar=instance("defenseDevice");actor.hand.push(use);from.equipment=radar;responder.hand.push(instance("counter"));
  const {game}=makeGame([actor,from,responder,receiver]);let publicContext=null;game.aiController.responsePolicy.shouldRespond=(_player,_type,context)=>{publicContext=context.publicTransferContext;return false;};
  await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"equipment",equipmentCardId:radar.id});
  assert.equal(publicContext.safeItemLabel,`装备「${radar.name}」`);assert.equal(Object.hasOwn(publicContext,"card"),false);assert.equal(Object.hasOwn(publicContext,"cardId"),false);
});
test("被反制的互利不建立公共牌池且不触发协调", async () => {
  const tuner=makePlayer("tuner",0,"dawn","ai",7),counterer=makePlayer("counterer",1,"dusk","human"),ally=makePlayer("ally",2,"dawn");
  const use=instance("mutualBenefit");tuner.hand.push(use);counterer.hand.push(instance("counter"));const {game}=makeGame([tuner,counterer,ally],{response:(request)=>request.type==="counter"});registerPassiveSkills(game);
  await game.playCard(tuner,use,[]);assert.equal(game.state.publicCardPool.length,0);assert.equal(tuner.turnFlags.coordinationTriggered,false);assert.equal(tuner.hand.length,0);
});
test("被反制的转移不移动牌且不触发协调", async () => {
  const tuner=makePlayer("tuner",0,"dawn","ai",7),from=makePlayer("from",1,"dusk"),counterer=makePlayer("counterer",2,"dusk","human"),ally=makePlayer("ally",3,"dawn");
  const use=instance("transfer"),locked=instance("block");tuner.hand.push(use);from.hand.push(locked);counterer.hand.push(instance("counter"));const {game}=makeGame([tuner,from,counterer,ally],{response:(request)=>request.type==="counter"});registerPassiveSkills(game);
  await game.playCard(tuner,use,[],{sourceId:from.id,receiverId:ally.id,zone:"hand"});assert.ok(from.hand.includes(locked));assert.ok(!ally.hand.includes(locked));assert.equal(tuner.turnFlags.coordinationTriggered,false);
});
test("协调只看转移接收者：给敌人不触发，从敌人给队友才触发", async () => {
  const noTriggerTuner=makePlayer("no-trigger",0,"dawn","ai",7),allySource=makePlayer("ally-source",1,"dawn"),enemyReceiver=makePlayer("enemy-receiver",2,"dusk");
  const firstUse=instance("transfer"),firstMoved=instance("harvest");noTriggerTuner.hand.push(firstUse);allySource.hand.push(firstMoved);const {game:firstGame}=makeGame([noTriggerTuner,allySource,enemyReceiver]);registerPassiveSkills(firstGame);
  await firstGame.playCard(noTriggerTuner,firstUse,[],{sourceId:allySource.id,receiverId:enemyReceiver.id,zone:"hand"});assert.equal(noTriggerTuner.turnFlags.coordinationTriggered,false);

  const enemyOnlyTuner=makePlayer("enemy-only",0,"dawn","ai",7),enemySourceOnly=makePlayer("enemy-source-only",1,"dusk"),enemyReceiverOnly=makePlayer("enemy-receiver-only",2,"dusk");
  const enemyUse=instance("transfer"),enemyMoved=instance("harvest");enemyOnlyTuner.hand.push(enemyUse);enemySourceOnly.hand.push(enemyMoved);const {game:enemyGame}=makeGame([enemyOnlyTuner,enemySourceOnly,enemyReceiverOnly]);registerPassiveSkills(enemyGame);
  await enemyGame.playCard(enemyOnlyTuner,enemyUse,[],{sourceId:enemySourceOnly.id,receiverId:enemyReceiverOnly.id,zone:"hand"});assert.equal(enemyOnlyTuner.turnFlags.coordinationTriggered,false);

  const triggerTuner=makePlayer("trigger",0,"dawn","ai",7),enemySource=makePlayer("enemy-source",1,"dusk"),allyReceiver=makePlayer("ally-receiver",2,"dawn");
  const secondUse=instance("transfer"),secondMoved=instance("harvest");triggerTuner.hand.push(secondUse);enemySource.hand.push(secondMoved);const {game:secondGame}=makeGame([triggerTuner,enemySource,allyReceiver]);secondGame.state.deck.cards.push(instance("charge"));registerPassiveSkills(secondGame);
  await secondGame.playCard(triggerTuner,secondUse,[],{sourceId:enemySource.id,receiverId:allyReceiver.id,zone:"hand"});assert.equal(triggerTuner.turnFlags.coordinationTriggered,true);assert.ok(allyReceiver.hand.includes(secondMoved));
});
test("互利包含多个队友时每次用牌仍只触发一次协调", async () => {
  const tuner=makePlayer("tuner",0,"dawn","ai",7),allyA=makePlayer("ally-a",1,"dawn"),enemy=makePlayer("enemy",2,"dusk"),allyB=makePlayer("ally-b",3,"dawn");
  const use=instance("mutualBenefit");tuner.hand.push(use);const {game}=makeGame([tuner,allyA,enemy,allyB]);game.state.deck.cards.push(instance("assault"),instance("block"),instance("charge"),instance("shield"),instance("harvest"));registerPassiveSkills(game);
  await game.playCard(tuner,use,[]);assert.equal(tuner.turnFlags.coordinationTriggered,true);assert.equal(tuner.hand.length,2);
});
test("beforeCardUse 与 beforeCardResolve 取消的牌都不触发协调", async () => {
  for(const hook of ["beforeCardUse","beforeCardResolve"]){
    const tuner=makePlayer(`tuner-${hook}`,0,"dawn","ai",7),ally=makePlayer(`ally-${hook}`,1,"dawn"),enemy=makePlayer(`enemy-${hook}`,2,"dusk"),use=instance("mutualBenefit");
    tuner.hand.push(use);const {game}=makeGame([tuner,ally,enemy]);registerPassiveSkills(game);game.eventBus.on(hook,`test-cancel-${hook}`,(event)=>{event.cancelled=true;});
    await game.playCard(tuner,use,[]);assert.equal(tuner.turnFlags.coordinationTriggered,false);assert.equal(game.state.publicCardPool.length,0);
  }
});
test("响应牌与装备牌只输出语义日志，不产生底层弃置或通用使用日志", async () => {
  const attacker=makePlayer("attacker",0,"dawn"),defender=makePlayer("defender",1,"dusk","human");
  const {game}=makeGame([attacker,defender],{response:()=>true});defender.hand.push(instance("block"));
  await game.damage(attacker,defender,1,{card:instance("assault"),canBlock:true,damageType:"normal"});
  assert.ok(game.state.logs.some((entry)=>entry.message===`${defender.name}使用了「格挡」。`));
  assert.ok(!game.state.logs.some((entry)=>entry.message.includes("因响应·格挡弃置")));
  const equipment=instance("energyDevice");attacker.hand.push(equipment);await game.playCard(attacker,equipment,[]);
  assert.ok(game.state.logs.some((entry)=>entry.message===`${attacker.name}装备了「充能桩」。`));
  assert.ok(!game.state.logs.some((entry)=>entry.message.includes("使用了「充能桩」")));
});
test("日志角色 token 可在同一行分别按阵营安全着色", () => {
  const dawn=makePlayer("晨方角色",0,"dawn"),dusk=makePlayer("暮方角色",1,"dusk");const {game}=makeGame([dawn,dusk]);
  const entry=game.log(`${dawn.name}对${dusk.name}造成影响。`);
  assert.deepEqual(entry.fragments.filter((fragment)=>fragment.type==="player").map((fragment)=>fragment.battleTeam),["dawn","dusk"]);
  const markup=formatLogEntry(entry);assert.match(markup,/log-player-name team-dawn/);assert.match(markup,/log-player-name team-dusk/);
  assert.match(markup,/造成影响/);
});
test("23 种牌面均不渲染 card-tags 或可见英文 subtype", () => {
  assert.equal(Object.keys(CARD_DEFINITIONS).length,23);
  for(const definition of Object.values(CARD_DEFINITIONS)){
    const card={...definition,id:`layout-${definition.definitionId}`};
    for(const markup of [handCardTemplate(card),opponentHandStripTemplate([{known:true,...card}])]){
      assert.doesNotMatch(markup,/card-tags/);assert.ok(markup.includes(card.description));
      for(const subtype of card.subtypes??[])assert.doesNotMatch(markup,new RegExp(`>\\s*${subtype}\\s*<`,"i"));
    }
  }
});
test("牌面长描述分类确定且真人与已知对手模板共用同一函数", () => {
  for(const definitionId of ["counter","defenseDevice","transfer","mutualBenefit","battleDevice","shield","provoke"]){
    const card=instance(definitionId),descriptionClass=cardDescriptionClass(card.description);
    assert.match(descriptionClass,/^is-description-(?:long|very-long)$/);assert.match(handCardTemplate(card),new RegExp(descriptionClass));assert.match(opponentHandStripTemplate([{known:true,...card}]),new RegExp(descriptionClass));
  }
  assert.equal(cardDescriptionClass(CARD_DEFINITIONS.harvest.description),"");assert.doesNotMatch(handCardTemplate(instance("harvest")),/is-description-very-long/);
  assert.equal(cardDescriptionClass(CARD_DEFINITIONS.radar?.description??CARD_DEFINITIONS.defenseDevice.description),"is-description-very-long");
});
test("牌面 CSS 删除旧标签并让长描述优先缩字、缩图和隐藏风味", async () => {
  const cards=await readFile(projectFile("css/cards.css"),"utf8"),characters=await readFile(projectFile("css/characters.css"),"utf8"),css=`${cards}\n${characters}`;
  assert.doesNotMatch(css,/\.card-tags/);assert.match(cards,/\.hand-card\.is-description-long\s*\{[^}]*grid-template-rows:/s);assert.match(cards,/\.hand-card\.is-description-long \.card-description\s*\{[^}]*font-size:[^}]*line-height:/s);assert.match(cards,/\.hand-card\.is-description-very-long \.card-flavor\s*\{[^}]*display:\s*none/s);
  assert.match(characters,/\.opponent-card-slot\.is-description-long\s*\{[^}]*grid-template-rows:/s);assert.match(characters,/\.opponent-card-slot\.is-description-very-long \.card-description\s*\{[^}]*font-size:[^}]*line-height:/s);assert.match(cards,/overflow-wrap:\s*anywhere/);
  const lowHeight=cards.match(/@media \(max-height:\s*920px\)[\s\S]*$/)?.[0]??"";assert.doesNotMatch(lowHeight,/\.card-description\s*\{[^}]*display:\s*none/s);assert.doesNotMatch(cards,/\.card-description\s*\{[^}]*overflow:\s*hidden/s);
});

let passed = 0;
const testPattern = process.env.TEST_PATTERN ? new RegExp(process.env.TEST_PATTERN, "u") : null;
const selectedTests = testPattern ? tests.filter(({ name }) => testPattern.test(name)) : tests;
for (const { name, fn } of selectedTests) {
  try { await fn(); passed += 1; process.stdout.write(`✓ ${name}\n`); }
  catch (error) { process.stderr.write(`✗ ${name}\n${error.stack}\n`); process.exitCode = 1; }
}
process.stdout.write(`\n${passed}/${selectedTests.length} tests passed\n`);
