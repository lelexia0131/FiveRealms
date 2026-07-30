import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
import { CleanupManager } from "../js/utils/CleanupManager.js";
import { sampleDelay } from "../js/utils/aiTiming.js";
import { equipmentSlotTemplate, playerPanelTemplate, resolvingCardTemplate } from "../js/ui/templates.js";
import { InteractionController, hiddenSelectionMarkup } from "../js/ui/InteractionController.js";
import { UIManager } from "../js/ui/UIManager.js";
import { hasCardResolver } from "../js/cards/cardRegistry.js";
import { ACTIVE_SKILLS, hasActiveSkill, hasPassiveSkill, registerPassiveSkills } from "../js/generals/skillRegistry.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const projectFile = (relativePath) => fileURLToPath(new URL(`../${relativePath.replace(/^\.\//, "")}`, import.meta.url));
let serial = 0;
const instance = (definitionId) => ({ ...CARD_DEFINITIONS[definitionId], id:`test-card-${definitionId}-${++serial}` });

function makeUi(response = () => false) {
  return {
    logs:[], reveals:[], responseRequests:[], publicRequests:[], thinking:[], currentCards:[],
    render() {}, appendLog(entry) { this.logs.push(entry.message); }, cancelPendingInteractions() {},
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
  for (const player of players) player.resetTurnFlags(game.teamRules.getRules(player));
  game.registerGlobalRules();
  return { game, ui };
}

// 配置、展示资源与注册表（38 项）
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

test("牌组恰有20种定义和178张实体牌", () => { assert.equal(Object.keys(CARD_DEFINITIONS).length, 20); assert.equal(TOTAL_CARD_COUNT, 178); });
test("三种卡牌分类之外没有旧响应分类", () => assert.deepEqual([...new Set(Object.values(CARD_DEFINITIONS).map((card) => card.category))].sort(), ["basic","equipment","tactic"]));
test("旧 support/insight/steal/coreDevice/redirect 定义已删除", () => ["support","insight","steal","coreDevice","redirect"].forEach((id) => assert.equal(CARD_DEFINITIONS[id], undefined)));
test("基础牌数量合计130", () => assert.equal(Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0), 130));
test("战术牌数量合计40", () => assert.equal(Object.values(CARD_DEFINITIONS).filter((card) => card.category === "tactic").reduce((sum, card) => sum + card.count, 0), 40));
test("装备牌数量合计8且每种2张", () => { const equipment = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment"); assert.equal(equipment.reduce((sum, card) => sum + card.count, 0), 8); equipment.forEach((card) => assert.equal(card.count, 2)); });
test("所有角色技能都存在注册器", () => GENERAL_DEFINITIONS.forEach((general) => { general.passiveSkillIds.forEach((id) => assert.ok(hasPassiveSkill(id))); general.activeSkillIds.forEach((id) => assert.ok(hasActiveSkill(id))); }));
test("所有角色都用稳定英文 roleTags 供 AI 判断职责", () => GENERAL_DEFINITIONS.forEach((general) => { assert.ok(general.roleTags.length >= 2);general.roleTags.forEach((tag)=>assert.match(tag,/^[a-z-]+$/)); }));
test("守誓者最大生命为3且壁垒说明声明临时不叠加", () => { const oath=GENERAL_DEFINITIONS.find((general)=>general.id==="oath-warden");assert.equal(oath.maxHp,3);assert.match(oath.activeDescription,/1点壁垒护盾/);assert.match(oath.activeDescription,/不叠加/); });
test("强制 AI 救援真人配置默认开启", () => assert.equal(GAME_CONFIG.forceAiRescueHuman, true));

// 牌堆、阵营、距离和次数补偿
test("Deck 创建178个唯一实体 card.id", () => { const deck = new Deck(() => .4); assert.equal(deck.build(), 178); assert.equal(new Set(deck.cards.map((card) => card.id)).size, 178); });
test("结算区不会进入重洗", () => { const deck = new Deck(() => .4); deck.build(); const resolving = deck.drawOne(); const discard = deck.drawOne(); deck.beginResolve(resolving); deck.discard(discard); deck.cards = []; deck.reshuffle(); assert.equal(deck.cards.length, 1); assert.equal(deck.resolvingCards[0], resolving); });
test("判定区不会进入重洗", () => { const deck = new Deck(() => .4); deck.build(); const judgment = deck.drawToJudgment(); const discard = deck.drawOne(); deck.discard(discard); deck.cards = []; deck.reshuffle(); assert.equal(deck.cards.length, 1); assert.equal(deck.judgmentZone[0], judgment); });
test("重洗计数会准确累加", () => { const deck = new Deck(); deck.discardPile.push(instance("charge")); deck.reshuffle(); assert.equal(deck.reshuffleCount, 1); });
test("阵营始终严格2V3", () => { for (let i=0;i<50;i+=1) { const teams = TeamManager.assignTeams(() => (i % 17) / 17); const dawn=teams.filter((t)=>t==="dawn").length; const dusk=teams.filter((t)=>t==="dusk").length; assert.deepEqual([dawn,dusk].sort(),[2,3]); } });
test("小队两名成员在环形座位上不相邻", () => { for (let i=0;i<40;i+=1) { const teams=TeamManager.assignTeams(() => (i%19)/19); const small=["dawn","dusk"].find((team)=>teams.filter((entry)=>entry===team).length===2); const seats=teams.map((team,index)=>team===small?index:-1).filter((index)=>index>=0); const raw=Math.abs(seats[0]-seats[1]); assert.ok(Math.min(raw,5-raw)>1); } });
test("真人座位可以随机进入小队或大队", () => { const sizes=new Set(); for(let i=0;i<60;i+=1){const teams=TeamManager.assignTeams(()=>((i*7)%61)/61); sizes.add(teams.filter((team)=>team===teams[0]).length);} assert.deepEqual([...sizes].sort(),[2,3]); });
test("环形距离取顺时针与逆时针较小值", () => { const ps=Array.from({length:5},(_,i)=>({id:`p${i}`,seatIndex:i,alive:true})); const game={state:{players:ps}}; assert.equal(DistanceSystem.getDistance(game,ps[0],ps[4]),1); assert.equal(DistanceSystem.getDistance(game,ps[0],ps[2]),2); });
test("普通突袭只能选择距离1内敌人", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dusk"),makePlayer("d",3,"dawn"),makePlayer("e",4,"dusk")]; const {game}=makeGame(ps); ps[0].hand.push(instance("assault")); assert.deepEqual(RuleEngine.getCardTargets(game,ps[0],ps[0].hand[0]).map((p)=>p.id),["b","e"]); });
test("震荡与决斗显式无视距离", () => { assert.equal(CARD_DEFINITIONS.shockwave.ignoresDistance,true); assert.equal(CARD_DEFINITIONS.duel.ignoresDistance,true); });
test("九种全局或指定型卡牌显式无视距离", () => { for (const id of ["shockwave","provoke","scout","transfer","plunder","destroy","duel","mutualBenefit","symbiosis"]) assert.equal(CARD_DEFINITIONS[id].ignoresDistance,true,id); });
test("每个主动技能都显式声明距离规则", () => { for (const skill of Object.values(ACTIVE_SKILLS)) assert.ok(["attack","unlimited","ally","self"].includes(skill.rangeRule),skill.id); });
test("小队规则为开局5张、每回合摸3张、突袭2、调息无限、回合能量2", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dawn"),makePlayer("d",3,"dusk"),makePlayer("e",4,"dusk")]; const {game}=makeGame(ps); const rules=game.teamRules; assert.equal(rules.getInitialHandCount(ps[0]),5); assert.equal(rules.getDrawCount(ps[0]),3); assert.equal(rules.getAttackLimit(ps[0]),2); assert.equal(rules.getRecoverLimit(ps[0]),null); assert.equal(rules.getTurnEnergyGain(ps[0]),2); });
test("大队规则为开局4张、每回合摸2张、突袭1、调息1、回合能量1", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dawn"),makePlayer("d",3,"dusk"),makePlayer("e",4,"dawn")]; const {game}=makeGame(ps); assert.equal(game.teamRules.getInitialHandCount(ps[0]),4); assert.equal(game.teamRules.getDrawCount(ps[0]),2); assert.equal(game.teamRules.getAttackLimit(ps[0]),1); assert.equal(game.teamRules.getRecoverLimit(ps[0]),1); assert.equal(game.teamRules.getTurnEnergyGain(ps[0]),1); });
test("回合摸牌事件按二人阵营3张、三人阵营2张取值", async () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dawn"),makePlayer("d",3,"dusk"),makePlayer("e",4,"dusk")];const {game}=makeGame(ps);const counts=[];game.eventBus.on("beforeDraw","test:team-draw",(event)=>counts.push(event.count));game.aiController.selectAction=async()=>({type:"end"});game.state.deck.cards.push(instance("block"),instance("charge"),instance("recover"));await game.takeTurn(ps[0],game.state.gameId);game.state.currentPlayerIndex=1;game.state.deck.cards.push(instance("block"),instance("charge"));await game.takeTurn(ps[1],game.state.gameId);assert.deepEqual(counts,[3,2]); });
test("充能装置只给回合能量额外+1", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk")]; const {game}=makeGame(ps); ps[0].equipment=instance("energyDevice"); assert.equal(game.teamRules.getTurnEnergyGain(ps[0]),2); ps[0].equipment=instance("battleDevice"); assert.equal(game.teamRules.getTurnEnergyGain(ps[0]),1); });
test("小队调息次数显示为无上限且仍要求受伤", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dawn"),makePlayer("d",3,"dusk"),makePlayer("e",4,"dusk")]; const {game}=makeGame(ps); const recover=instance("recover"); ps[0].hand.push(recover); assert.equal(RuleEngine.canPlayCard(game,ps[0],recover).ok,false); ps[0].hp-=1; assert.equal(RuleEngine.canPlayCard(game,ps[0],recover).ok,true); });
test("壁垒只提供1点临时护盾且重复施放仅刷新", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn", "ai", 1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;target.shield=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,3);assert.deepEqual(target.statuses.temporaryShield,{amount:1,clearAtTurnStart:true});source.energy=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,3);assert.equal(target.statuses.temporaryShield.amount,1); });
test("壁垒护盾被伤害优先消耗且不影响已有护盾", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn", "ai", 1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;target.shield=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);const hp=target.hp;await game.damage(enemy,target,1,{canBlock:false});assert.equal(target.hp,hp);assert.equal(target.shield,2);assert.equal(target.statuses.temporaryShield,undefined); });
test("未消耗的壁垒护盾在目标下回合开始时消散", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn", "ai", 1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);game.state.currentPlayerIndex=1;game.state.deck.cards.push(instance("block"),instance("charge"));game.aiController.selectAction=async()=>({type:"end"});await game.takeTurn(target,game.state.gameId);assert.equal(target.shield,0);assert.equal(target.statuses.temporaryShield,undefined); });

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
test("突袭在中央结算区与使用日志中显示作用对象", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game,ui}=makeGame([a,b]);const assault=instance("assault");a.hand.push(assault);await game.playCard(a,assault,[b]);assert.equal(ui.currentCards[0].targetLabel,b.name);assert.ok(ui.logs.some((message)=>message===`${a.name}使用了「突袭」，作用对象：${b.name}。`)); });
test("群体牌会列出全部作用对象且结算模板显示目标标签", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dusk");const {game,ui}=makeGame([a,b,c]);const shockwave=instance("shockwave");a.hand.push(shockwave);await game.playCard(a,shockwave,[]);assert.equal(ui.currentCards[0].targetLabel,`${b.name}、${c.name}`);const markup=resolvingCardTemplate(shockwave,a.name,ui.currentCards[0].targetLabel);assert.match(markup,/作用对象/);assert.match(markup,new RegExp(`${b.name}、${c.name}`)); });
test("上方 AI 思考提示出现时隐藏下方重复提示", () => { const classes=()=>{const values=new Set();return {values,toggle(name,force){if(force)values.add(name);else values.delete(name);}};};const thinkingClasses=classes(),promptClasses=classes();const fake={game:null,thinkingPlayerId:null,thinkingMessage:"",elements:{thinking_indicator:{classList:thinkingClasses,innerHTML:""},action_prompt:{classList:promptClasses}},render(){}};const player=makePlayer("ai",0,"dawn");UIManager.prototype.setThinking.call(fake,true,player,"准备使用突袭");assert.ok(promptClasses.values.has("is-hidden"));UIManager.prototype.setThinking.call(fake,false,player);assert.ok(!promptClasses.values.has("is-hidden")); });
test("多层破势叠加并在下一次主动突袭一次性消耗", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk"); b.hp=8;b.maxHp=8; const {game}=makeGame([a,b]); for(let i=0;i<2;i+=1){const c=instance("exposeWeakness");a.hand.push(c);await game.playCard(a,c,[]);} assert.equal(a.statuses.exposeWeakness.stacks,2); const attack=instance("assault");a.hand.push(attack);await game.playCard(a,attack,[b]);assert.equal(b.hp,5);assert.equal(a.statuses.exposeWeakness,undefined); });
test("破势即使突袭被格挡也会消耗", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk","human"); const {game}=makeGame([a,b],{response:()=>true}); a.statuses.exposeWeakness={stacks:2}; a.hand.push(instance("assault")); b.hand.push(instance("block")); await game.playCard(a,a.hand[0],[b]); assert.equal(b.hp,b.maxHp); assert.equal(a.statuses.exposeWeakness,undefined); });
test("震荡不计突袭次数也不消耗破势", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk"), c=makePlayer("c",2,"dusk"); const {game}=makeGame([a,b,c]); a.statuses.exposeWeakness={stacks:2}; const card=instance("shockwave");a.hand.push(card);await game.playCard(a,card,[b,c]);assert.equal(a.turnFlags.attackUsed,0);assert.equal(a.statuses.exposeWeakness.stacks,2); });
test("主动调息恢复1且计数，濒死救援不计主动次数", async () => { const a=makePlayer("a",0,"dawn");a.hp-=1;const b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const card=instance("recover");a.hand.push(card);await game.playCard(a,card,[]);assert.equal(a.turnFlags.recoverUsed,1); });
test("聚能不超过能量上限且可重复使用", async () => { const a=makePlayer("a",0,"dawn"), b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);a.energy=2;for(let i=0;i<2;i+=1)a.hand.push(instance("charge"));await game.playCard(a,a.hand[0],[]);assert.equal(a.energy,3);assert.equal(RuleEngine.canPlayCard(game,a,a.hand[0]).ok,false); });
test("窥探只向真人私密层展示且公开日志不含牌名", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk");const {game,ui}=makeGame([a,b]);const scout=instance("scout"), secret=instance("counter");a.hand.push(scout);b.hand.push(secret);b.bumpHandVersion();const hidden=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,scout,[b],{tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});assert.equal(ui.reveals[0].cards[0],secret);assert.ok(!game.state.logs.at(-1).message.includes(secret.name)); });
test("AI 窥探记忆绑定实体 card.id", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b],{random:()=>0});const scout=instance("scout"), secret=instance("block");a.hand.push(scout);b.hand.push(secret);await game.playCard(a,scout,[b]);assert.equal(a.aiMemory.knownCardsByPlayer[b.id][secret.id],secret.definitionId); });
test("被窥探牌离开原手牌后实体记忆立即失效", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const secret=instance("block");b.hand.push(secret);game.rememberPrivateCard(a,b,secret);await game.discardCardFromHand(b,secret,"测试");assert.equal(a.aiMemory.knownCardsByPlayer[b.id][secret.id],undefined); });
test("转移支持来源、接收者与指定牌三阶段", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dawn");const {game}=makeGame([a,b,c]);const transfer=instance("transfer"),moved=instance("block");a.hand.push(transfer);b.hand.push(moved);b.bumpHandVersion();const hidden=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,transfer,[],{sourceId:b.id,receiverId:c.id,tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});assert.ok(c.hand.includes(moved));assert.ok(!game.state.logs.at(-1).message.includes(moved.name)); });
test("掠夺获得指定隐藏牌但不公开牌名", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const use=instance("plunder"),secret=instance("block");a.hand.push(use);b.hand.push(secret);b.bumpHandVersion();const h=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,use,[b],{tokens:[h.tokens[0].token],selectionId:h.selectionId});assert.ok(a.hand.includes(secret));assert.ok(!game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("破坏公开牌名并把牌移入弃牌堆", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const use=instance("destroy"),secret=instance("block");a.hand.push(use);b.hand.push(secret);b.bumpHandVersion();const h=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,use,[b],{tokens:[h.tokens[0].token],selectionId:h.selectionId});assert.ok(game.state.deck.discardPile.includes(secret));assert.ok(game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("收获直接摸2且无需弃牌", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);game.state.deck.cards.push(instance("block"),instance("charge"));const use=instance("harvest");a.hand.push(use);await game.playCard(a,use,[]);assert.equal(a.hand.length,2); });
test("挑衅：有突袭者可弃置，没有者失去生命且无视护盾", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dusk","human");const {game}=makeGame([a,b,c],{response:(r)=>r.targetPlayerId===b.id});a.hand.push(instance("provoke"));b.hand.push(instance("assault"));c.shield=2;const hp=c.hp;await game.playCard(a,a.hand[0],[b,c]);assert.equal(b.hand.length,0);assert.equal(c.hp,hp-1);assert.equal(c.shield,2); });
test("决斗轮流弃突袭，先不能响应者承受可被护盾吸收的1伤害", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:(r)=>r.targetPlayerId===b.id});const duel=instance("duel");a.hand.push(duel);b.hand.push(instance("assault"));a.shield=1;await game.playCard(a,duel,[b]);assert.equal(a.hp,a.maxHp);assert.equal(a.shield,0);assert.equal(a.turnFlags.attackUsed,0); });
test("互利在反制窗口之后才展示并按座位每人选1张", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dawn");const {game,ui}=makeGame([a,b,c]);game.state.deck.cards.push(instance("block"),instance("charge"),instance("recover"));a.hand.push(instance("mutualBenefit"));await game.playCard(a,a.hand[0],[]);assert.equal(a.hand.length,1);assert.equal(b.hand.length,1);assert.equal(c.hand.length,1);assert.equal(game.state.publicCardPool.length,0);assert.equal(ui.publicRequests.length,1); });
test("互利选牌严格跳过阵亡座位", async () => { const a=makePlayer("a",0,"dawn","human"),dead=makePlayer("dead",1,"dusk"),b=makePlayer("b",2,"dusk"),c=makePlayer("c",3,"dawn");dead.alive=false;const {game}=makeGame([a,dead,b,c]);game.state.deck.cards.push(instance("block"),instance("charge"),instance("recover"));a.hand.push(instance("mutualBenefit"));await game.playCard(a,a.hand[0],[]);assert.equal(dead.hand.length,0);assert.equal(a.hand.length,1);assert.equal(b.hand.length,1);assert.equal(c.hand.length,1); });
test("共生按全体存活角色结算治疗", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk"),c=makePlayer("c",2,"dawn");[a,b,c].forEach((p)=>p.hp-=1);const {game}=makeGame([a,b,c]);a.hand.push(instance("symbiosis"));await game.playCard(a,a.hand[0],[]);[a,b,c].forEach((p)=>assert.equal(p.hp,p.maxHp)); });
test("反制者包含盟友并按施牌者后的座位顺序", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dawn","human"),c=makePlayer("c",2,"dusk","human");const order=[];const {game}=makeGame([a,b,c],{response:(r)=>(order.push(r.targetPlayerId),r.targetPlayerId===b.id)});a.hand.push(instance("harvest"));b.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id]); });
test("反制本身可被反制且仍保持响应牌接口", () => { assert.equal(CARD_DEFINITIONS.counter.counterable,true);assert.equal(CARD_DEFINITIONS.counter.usageMode,"response");assert.match(CARD_DEFINITIONS.counter.description,/也可以被其他反制响应/); });
test("两次反制后原战术牌恢复生效", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human");const order=[];const {game,ui}=makeGame([a,b,c],{response:(request)=>(order.push(request.targetPlayerId),true)});game.state.deck.cards.push(instance("block"),instance("charge"));a.hand.push(instance("harvest"));b.hand.push(instance("counter"));c.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id]);assert.equal(a.hand.length,2);assert.equal(b.hand.length,0);assert.equal(c.hand.length,0);assert.ok(ui.logs.some((message)=>message.includes(`${b.name}的「反制」被后续反制抵消`))); });
test("三次反制后原战术牌仍被取消", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human"),d=makePlayer("d",3,"dusk","human");const order=[];const {game}=makeGame([a,b,c,d],{response:(request)=>(order.push(request.targetPlayerId),true)});game.state.deck.cards.push(instance("block"),instance("charge"));a.hand.push(instance("harvest"));b.hand.push(instance("counter"));c.hand.push(instance("counter"));d.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id,d.id]);assert.equal(a.hand.length,0);assert.equal(b.hand.length,0);assert.equal(c.hand.length,0);assert.equal(d.hand.length,0);assert.ok(game.state.logs.some((entry)=>entry.message.includes("效果被取消"))); });

// 装备与判定
for (const id of ["energyDevice","recycleDevice","defenseDevice","battleDevice"]) test(`装备 ${CARD_DEFINITIONS[id].name} 会进入唯一装备槽`, async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const equipment=instance(id);a.hand.push(equipment);await game.playCard(a,equipment,[]);assert.equal(a.equipment,equipment);assert.ok(!game.state.deck.discardPile.includes(equipment)); });
test("替换装备时旧装备进入弃牌堆且新装备留在槽内", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const old=instance("energyDevice");a.equipment=old;const next=instance("battleDevice");a.hand.push(next);await game.playCard(a,next,[]);assert.equal(a.equipment,next);assert.ok(game.state.deck.discardPile.includes(old)); });
test("回收装置在本回合首次主动战术即使被反制也摸1", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:()=>true});a.equipment=instance("recycleDevice");a.hand.push(instance("harvest"));b.hand.push(instance("counter"));game.state.deck.cards.push(instance("charge"));await game.playCard(a,a.hand[0],[]);assert.equal(a.turnFlags.recycleDeviceTriggered,true);assert.equal(a.hand.length,1); });
test("防御装置判定战术牌时免疫原突袭并把判定牌弃置", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("harvest");game.state.deck.cards.push(judgment);const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.ok(game.state.deck.discardPile.includes(judgment));assert.equal(game.state.deck.judgmentZone.length,0); });
test("防御装置判定基础牌时获得该牌并继续攻击", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("charge");game.state.deck.cards.push(judgment);const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.ok(b.hand.includes(judgment));assert.equal(b.hp,hp-1); });
test("防御装置公开获得的基础牌写入其他 AI 记忆", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");const judgment=instance("charge");game.state.deck.cards.push(judgment);await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(a.aiMemory.knownCardsByPlayer[b.id][judgment.id],"charge"); });
test("防御装置获得的格挡可立即用于当前攻击", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:()=>true});b.equipment=instance("defenseDevice");game.state.deck.cards.push(instance("block"));const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.equal(b.hand.length,0); });
test("防御装置判定装备牌时失去1生命且原攻击终止", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.equipment=instance("defenseDevice");game.state.deck.cards.push(instance("energyDevice"));b.shield=2;const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp-1);assert.equal(b.shield,2); });
test("战斗装置要求2张格挡；只有1张时不会浪费", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:()=>true});a.equipment=instance("battleDevice");b.hand.push(instance("block"));const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp-1);assert.equal(b.hand.length,1); });
test("战斗装置面对2张格挡时原子弃置并完全防住", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human");const {game}=makeGame([a,b],{response:()=>true});a.equipment=instance("battleDevice");b.hand.push(instance("block"),instance("block"));const hp=b.hp;await game.damage(a,b,1,{card:instance("assault"),canBlock:true,damageType:"normal"});assert.equal(b.hp,hp);assert.equal(b.hand.length,0); });

// 负生命、濒死救援与事件顺序
test("伤害可以让生命降到负数而不是钳制到0", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;const {game}=makeGame([a,b]);await game.damage(a,b,3,{canBlock:false});assert.ok(b.hp<0); });
test("无人可救时濒死角色在救援窗口后阵亡", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;const {game}=makeGame([a,b]);await game.damage(a,b,1,{canBlock:false});assert.equal(b.alive,false); });
test("AI 濒死本人有调息时必须自救", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;b.hand.push(instance("recover"));const {game}=makeGame([a,b]);const used=b.turnFlags.recoverUsed;await game.damage(a,b,1,{canBlock:false});assert.equal(b.alive,true);assert.equal(b.hp,1);assert.equal(b.turnFlags.recoverUsed,used); });
test("负1生命需要2张调息并会重复开启救援轮", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");b.hp=1;b.hand.push(instance("recover"),instance("recover"));const {game}=makeGame([a,b]);await game.damage(a,b,2,{canBlock:false});assert.equal(b.hp,1);assert.equal(b.alive,true); });
test("救援顺序为濒死本人后再从下一座位起的盟友", async () => { const dying=makePlayer("d",0,"dawn","human"),ally1=makePlayer("a1",1,"dawn","human"),enemy=makePlayer("e",2,"dusk","human"),ally2=makePlayer("a2",3,"dawn","human");dying.hp=0;[dying,ally1,enemy,ally2].forEach((p)=>p.hand.push(instance("recover")));const order=[];const {game}=makeGame([dying,ally1,enemy,ally2],{response:(r)=>(order.push(r.sourcePlayerId),r.sourcePlayerId===ally1.id)});await game.dyingSystem.enter(dying,enemy);assert.deepEqual(order,[dying.id,ally1.id]);assert.equal(dying.hp,1); });
test("敌人永远不会进入濒死救援候选队列", async () => { const dying=makePlayer("d",0,"dawn","human"),enemy=makePlayer("e",1,"dusk","human");dying.hp=0;enemy.hand.push(instance("recover"));const {game,ui}=makeGame([dying,enemy],{response:()=>true});await game.dyingSystem.enter(dying,enemy);assert.equal(ui.responseRequests.length,0);assert.equal(dying.alive,false); });
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

// 隐藏信息、AI、延迟与 UI 安全
test("不透明隐藏牌 DOM 不含牌名、definitionId、类别、描述或 art", () => { const markup=hiddenSelectionMarkup({tokens:[{token:"opaque-safe",position:1}]});assert.match(markup,/opaque-safe/);for(const secret of ["反制","definitionId","category","description","assets\/cards"])assert.doesNotMatch(markup,new RegExp(secret)); });
test("过期手牌版本令不透明令牌失效", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));const selection=game.cardSelectionSystem.createHiddenSelection(b);b.bumpHandVersion();assert.equal(game.cardSelectionSystem.resolveToken(selection.tokens[0].token,b),null); });
test("隐藏牌令牌必须属于本次 selectionId", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));const first=game.cardSelectionSystem.createHiddenSelection(b),second=game.cardSelectionSystem.createHiddenSelection(b);assert.equal(game.cardSelectionSystem.resolveToken(first.tokens[0].token,b,second.selectionId),null);assert.equal(game.cardSelectionSystem.resolveToken(first.tokens[0].token,b,first.selectionId),b.hand[0]); });
test("核心隐藏牌解析会同时去重 token 和实体牌", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"),instance("recover"));const selection=game.cardSelectionSystem.createHiddenSelection(b);const duplicate=selection.tokens[0].token;const cards=await game.chooseHiddenCards(a,b,2,"测试去重",{selectionId:selection.selectionId,tokens:[duplicate,duplicate]});assert.equal(cards.length,1);assert.equal(cards[0].id,b.hand[0].id); });
test("取消牌背选择会立即清除对应临时令牌", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));const selection=game.cardSelectionSystem.createHiddenSelection(b);const panel={innerHTML:"",classList:{add(){}}};let resolved="pending";const ui={game,elements:{response_panel:panel},render(){}};const controller=new InteractionController(ui);controller.pending={type:"hidden",selection,count:1,exact:true,selected:new Set(),resolve:(value)=>{resolved=value;}};controller.cancel();assert.equal(resolved,null);assert.equal(game.cardSelectionSystem.selections.size,0); });
test("牌背多阶段 pending 会锁住手牌、技能和结束出牌", () => { const fake={targetState:null,discardState:null,responseState:null,interactionController:{pending:{type:"hidden"}},game:{interactionLocked:false}};assert.equal(UIManager.prototype.isInteractionActive.call(fake),true);const human=makePlayer("h",0,"dawn","human"),enemy=makePlayer("e",1,"dusk");const {game}=makeGame([human,enemy]);game.interactionLocked=true;assert.equal(game.requestEndHumanPlay(),false); });
test("电脑玩家模板只暴露手牌数量", () => { const human=makePlayer("h",0,"dawn","human"),ai=makePlayer("ai",1,"dusk");ai.hand.push({ ...instance("counter"), name:"绝密名称" });const markup=playerPanelTemplate(ai,{humanTeam:human.battleTeam});assert.match(markup,/手牌1/);assert.doesNotMatch(markup,/绝密名称|definitionId/); });
test("AI 可见状态不含其他玩家真实手牌", () => { const ai=makePlayer("ai",0,"dawn"),other=makePlayer("other",1,"dusk");ai.hand.push(instance("assault"));other.hand.push(instance("counter"));const {game}=makeGame([ai,other]);const visible=createAiVisibleState(ai.id,game.state);assert.equal(visible.players[1].hand,undefined);assert.equal(visible.players[1].handCount,1);assert.equal(visible.players[0].hand[0].definitionId,"assault"); });
test("AI 对未知调息只按公开手牌数估算而不读取真实牌面", () => { const ai=makePlayer("ai",0,"dawn"),other=makePlayer("other",1,"dusk");const {game}=makeGame([ai,other]);other.hand=[instance("recover")];const first=createAiVisibleState(ai.id,game.state).players[1].expectedRecoverCount;other.hand=[instance("assault")];const second=createAiVisibleState(ai.id,game.state).players[1].expectedRecoverCount;assert.equal(first,second); });
test("AI 模拟器只接收过滤快照并可独立克隆推演", () => { const visible={players:[{id:"a",battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,alive:true,handCount:1,hand:[{id:"x",definitionId:"assault"}]},{id:"b",battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,alive:true,handCount:2}]};const simulator=new AiSimulator(visible);const next=simulator.apply(visible,{type:"card",card:{id:"x",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].hp,3);assert.equal(visible.players[1].hp,4);assert.equal("game" in simulator,false); });
test("AI 动作生成使用同一距离合法性", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dusk"),makePlayer("d",3,"dawn"),makePlayer("e",4,"dusk")];const {game}=makeGame(ps);ps[0].hand.push(instance("assault"));const targets=game.aiController.getLegalActions(ps[0]).filter((a)=>a.card?.definitionId==="assault").map((a)=>a.targets[0].id);assert.deepEqual(targets,["b","e"]); });
test("AI 束搜索实际达到多层、记录展开节点并采样10个隐藏世界", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);a.hand.push(instance("charge"),instance("exposeWeakness"),instance("assault"));const action=await game.aiController.selectAction(a,{gameId:game.state.gameId});assert.ok(["card","skill","end"].includes(action.type));assert.ok(game.aiController.planner.lastSearchStats.expanded>3);assert.ok(game.aiController.planner.lastSearchStats.depth>=2);assert.equal(game.aiController.planner.lastSearchStats.hiddenSamples,10); });
test("AI 模拟器识别破势叠加后强化普通突袭", () => { const visible={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,attackRange:1,attackUsed:0,attackLimit:2,recoverUsed:0,recoverLimit:1,exposeWeaknessStacks:0,alive:true,handCount:3,hand:[{id:"x1",definitionId:"exposeWeakness"},{id:"x2",definitionId:"exposeWeakness"},{id:"a1",definitionId:"assault"}]},{id:"b",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,attackRange:1,alive:true,handCount:0}]};const simulator=new AiSimulator(visible);const once=simulator.apply(visible,{type:"card",card:{id:"x1",definitionId:"exposeWeakness"},targets:[]},"a");const twice=simulator.apply(once,{type:"card",card:{id:"x2",definitionId:"exposeWeakness"},targets:[]},"a");const attacked=simulator.apply(twice,{type:"card",card:{id:"a1",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(attacked.players[1].hp,1);assert.equal(attacked.players[0].exposeWeaknessStacks,0); });
test("AI 深层节点能发现先聚能再发动主动技能", () => { const actor=makePlayer("a",0,"dawn","ai",2),ally=makePlayer("ally",1,"dawn","ai",1),enemy=makePlayer("e",2,"dusk");actor.energy=1;ally.hp-=1;actor.hand.push(instance("charge"));const {game}=makeGame([actor,ally,enemy]);const visible=createAiVisibleState(actor.id,game.state);const simulator=new AiSimulator(visible);const charged=simulator.apply(visible,{type:"card",card:actor.hand[0],targets:[]},actor.id);const follow=game.aiController.actionGenerator.generateFromVisible(charged,actor.id);assert.ok(follow.some((action)=>action.type==="skill"&&action.skill.id==="symbiosis"&&action.targets[0].id===ally.id)); });
test("AI 模拟伤害会计算队伍调息并保留可获救角色", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:1,maxHp:4,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0},{id:"c",seatIndex:2,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,expectedRecoverCount:1}]};const simulator=new AiSimulator(state);const next=simulator.apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].alive,true);assert.equal(next.players[1].hp,1);assert.equal(next.players[2].expectedRecoverCount,0); });
test("AI 模拟调息不足时保持离散阵亡而不制造半血存活者", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:0,maxHp:4,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0},{id:"c",seatIndex:2,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,expectedRecoverCount:1}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].alive,false);assert.equal(next.players[1].hp,-1);assert.equal(next.players[1].survivalChance,.5); });
test("AI 模拟战斗装置要求两张格挡而不是一张", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,equipmentDefinitionId:"battleDevice",expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:1,blockProbability:1,twoBlockProbability:0,expectedRecoverCount:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].hp,2); });
test("AI 模拟防御装置包含判定获得格挡并立即响应的概率", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,expectedRecoverCount:0},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:0,blockProbability:0,twoBlockProbability:0,equipmentDefinitionId:"defenseDevice",expectedRecoverCount:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{id:"hit",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.ok(Math.abs(next.players[1].hp-(3-103/178))<1e-9); });
test("AI 模拟反制会考虑同阵营响应者的阵营净收益", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"s",definitionId:"symbiosis"}]},{id:"ally",seatIndex:1,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,counterProbability:1},{id:"e1",seatIndex:2,battleTeam:"dusk",hp:2,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0},{id:"e2",seatIndex:3,battleTeam:"dusk",hp:2,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.symbiosis,id:"s"},targets:state.players},"a");assert.equal(next.players[2].hp,2);assert.equal(next.players[3].hp,2); });
test("AI 模拟回收装置只在首次战术后补1张", () => { const state={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:2,hand:[{id:"x1",definitionId:"exposeWeakness"},{id:"x2",definitionId:"exposeWeakness"}],equipmentDefinitionId:"recycleDevice",recycleDeviceTriggered:false},{id:"b",seatIndex:1,battleTeam:"dusk",hp:3,maxHp:3,shield:0,alive:true,handCount:0,counterProbability:0}]};const simulator=new AiSimulator(state);const once=simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x1"},targets:[]},"a");const twice=simulator.apply(once,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x2"},targets:[]},"a");assert.equal(once.players[0].handCount,2);assert.equal(twice.players[0].handCount,1); });
test("AI 深层结束与重复装备评分读取模拟节点而非根玩家", () => { const real=makePlayer("a",0,"dawn");real.hand.push(instance("assault"),instance("charge"));const enemy=makePlayer("b",1,"dusk");const {game}=makeGame([real,enemy]);const evaluator=game.aiController.evaluator;const emptyVisible={players:[{id:real.id,battleTeam:"dawn",handCount:0,equipmentDefinitionId:"energyDevice"},{id:enemy.id,battleTeam:"dusk",alive:true,hp:3,maxHp:3}]};assert.equal(evaluator.actionUtility({type:"end"},real,emptyVisible),0);const equipment=instance("energyDevice");assert.equal(evaluator.actionUtility({type:"card",card:equipment,targets:[]},real,emptyVisible),equipment.aiValue-4); });
test("AI 到达搜索预算仍返回当前最佳合法动作", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);for(let i=0;i<8;i+=1)a.hand.push(instance(i%2?"exposeWeakness":"assault"));game.aiSearchBudgetOverrideMs=0;const action=await game.aiController.selectAction(a,{gameId:game.state.gameId});assert.ok(["card","skill","end"].includes(action.type));assert.ok(game.aiController.planner.lastSearchStats.elapsedMs<250); });
test("AI 低血弃牌会保留调息和格挡", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);a.hp=1;a.hand.push(instance("recover"),instance("block"),instance("charge"),instance("assault"));const discarded=game.aiController.chooseDiscards(a,2).map((card)=>card.definitionId);assert.ok(!discarded.includes("recover"));assert.ok(!discarded.includes("block")); });
test("AI 不会反制对己方净治疗明显有利的共生", () => { const a=makePlayer("a",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");a.hp-=1;ally.hp-=1;const {game}=makeGame([a,ally,enemy]);const use=game.aiController.responsePolicy.shouldRespond(a,"counter",{source:enemy,card:instance("symbiosis")},[instance("counter")]);assert.equal(use,false); });
test("回合能量事件公开基础、阵营和装备三段来源", async () => { const a=makePlayer("a",0,"dawn"),ally=makePlayer("ally",1,"dawn"),b=makePlayer("b",2,"dusk"),c=makePlayer("c",3,"dusk"),d=makePlayer("d",4,"dusk");const {game}=makeGame([a,ally,b,c,d]);a.equipment=instance("energyDevice");game.state.deck.cards.push(instance("block"),instance("charge"));game.cleanupManager.delay=async()=>true;game.aiController.selectAction=async()=>({type:"end"});let before=null,after=null;game.eventBus.on("beforeTurnEnergyGain","test:before",(event)=>{before={baseAmount:event.baseAmount,teamBonus:event.teamBonus,equipmentBonus:event.equipmentBonus,amount:event.amount};});game.eventBus.on("afterTurnEnergyGain","test:after",(event)=>{after=event.actualAmount;});await game.takeTurn(a,game.state.gameId);assert.deepEqual(before,{baseAmount:1,teamBonus:1,equipmentBonus:1,amount:3});assert.equal(after,3); });
test("AI 未知牌按位置采样而不因真实 definitionId 改变选择位置", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b],{random:()=>.6});b.hand=[instance("counter"),instance("charge"),instance("block")];const first=game.aiController.cardSelector.chooseHiddenCards(a,b,1)[0];b.hand=[instance("assault"),instance("recover"),instance("energyDevice")];const second=game.aiController.cardSelector.chooseHiddenCards(a,b,1)[0];assert.equal(first.definitionId,"charge");assert.equal(second.definitionId,"recover"); });
test("AI 自救响应策略为确定必用，敌方救援为拒绝", () => { const a=makePlayer("a",0,"dawn"),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([a,ally,enemy]);assert.equal(game.aiController.responsePolicy.shouldRespond(a,"dyingRescue",{target:a},[instance("recover")]),true);assert.equal(game.aiController.responsePolicy.shouldRespond(enemy,"dyingRescue",{target:a},[instance("recover")]),false); });
test("AI 延迟在配置上下限内且快速模式显著缩短", () => { const natural=sampleDelay(()=>.5,GAME_CONFIG.aiInitialThinkMinMs,GAME_CONFIG.aiInitialThinkMaxMs,false);const fast=sampleDelay(()=>.5,GAME_CONFIG.aiInitialThinkMinMs,GAME_CONFIG.aiInitialThinkMaxMs,true);assert.ok(natural>=1800&&natural<=3500);assert.ok(fast<natural/2); });
test("CleanupManager 可取消尚未完成的延迟", async () => { const cleanup=new CleanupManager();const waiting=cleanup.delay(5000);cleanup.cleanup();assert.equal(await waiting,false);assert.equal(cleanup.pending.size,0); });
test("重新征召 cleanup 会清空隐藏令牌、公共池和响应", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));game.cardSelectionSystem.createHiddenSelection(b);game.state.pendingResponses.push({id:"old"});game.dispose();assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.state.pendingResponses.length,0);assert.equal(game.state.publicCardPool.length,0); });
test("装备槽空置和四种装备生成不同可访问 DOM", () => { const p=makePlayer("a",0,"dawn");const empty=equipmentSlotTemplate(p,true);assert.match(empty,/is-empty|装备槽为空/);for(const id of ["energyDevice","recycleDevice","defenseDevice","battleDevice"]){p.equipment=instance(id);const markup=equipmentSlotTemplate(p,true);assert.match(markup,new RegExp(CARD_DEFINITIONS[id].name));assert.match(markup,new RegExp(CARD_DEFINITIONS[id].description.slice(0,6)));assert.notEqual(markup,empty);} });
test("UIManager 源码不直接写生命、能量、手牌或胜负", async () => { const source=await readFile(projectFile("js/ui/UIManager.js"),"utf8");for(const forbidden of [/\.hp\s*=/,/\.energy\s*=/,/\.hand\.(?:push|splice|pop|shift|unshift)/,/\.winnerTeam\s*=/,/\.isGameOver\s*=/])assert.doesNotMatch(source,forbidden); });
test("全 AI 快速对局能推进到合法胜者", async () => { let seed=77;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);const ui=makeUi();const game=new Game(ui,random);game.simulationMode=true;game.setAnimationFastMode(true);game.cleanupManager.delay=async()=>!game.state.isDisposed;const candidates=game.startSelection();game.state.players[0].controllerType="ai";await game.confirmGeneral(candidates[0].id);const result=await Promise.race([game.loopPromise.then(()=>"done"),new Promise((resolve)=>setTimeout(()=>resolve("timeout"),10000))]);assert.equal(result,"done");assert.ok(["dawn","dusk"].includes(game.state.winnerTeam));game.dispose(); });

let passed = 0;
for (const { name, fn } of tests) {
  try { await fn(); passed += 1; process.stdout.write(`✓ ${name}\n`); }
  catch (error) { process.stderr.write(`✗ ${name}\n${error.stack}\n`); process.exitCode = 1; }
}
process.stdout.write(`\n${passed}/${tests.length} tests passed\n`);
