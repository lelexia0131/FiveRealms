import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { candidateCardTemplate, cardDescriptionClass, equipmentSlotTemplate, formatLogEntry, handCardTemplate, hiddenCardBackTemplate, opponentHandStripTemplate, playerPanelTemplate, privateCardTemplate, resolvingCardTemplate, skillDetailsTemplate } from "../js/ui/templates.js";
import { InteractionController, hiddenSelectionMarkup } from "../js/ui/InteractionController.js";
import { UIManager, canSubmitResponse, skillButtonLabel } from "../js/ui/UIManager.js";
import { CARD_CATEGORY_DISPLAY_ORDER, CARD_DEFINITION_DISPLAY_ORDER, createHiddenSelectionView, createOpponentHandView } from "../js/ui/handVisibility.js";
import { PublicPoolView } from "../js/ui/PublicPoolView.js";
import { isCardSelectionValid, toggleCardSelection } from "../js/ui/selectionUtils.js";
import { buildResponsePresentation } from "../js/core/ResponseSystem.js";
import { hasCardResolver } from "../js/cards/cardRegistry.js";
import { ACTIVE_SKILLS, hasActiveSkill, hasPassiveSkill, registerPassiveSkills } from "../js/generals/skillRegistry.js";
import { MUSIC_PROFILES, SoundManager } from "../js/audio/SoundManager.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const execFileAsync = promisify(execFile);
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
const assertClose = (actual, expected, epsilon = 1e-9) => assert.ok(
  Math.abs(actual - expected) <= epsilon,
  `expected ${actual} to be within ${epsilon} of ${expected}`
);

function makeUi(response = () => false) {
  return {
    logs:[], reveals:[], responseRequests:[], publicRequests:[], hiddenRequests:[], thinking:[], currentCards:[],
    playEndState:null,
    render() {}, appendLog(entry) { this.logs.push(entry.message); },
    waitForHumanPlayEnd(gameId) { return new Promise((resolve) => { this.playEndState = { gameId, resolve }; }); },
    resolveHumanPlayEnd(gameId) { if (!this.playEndState || this.playEndState.gameId !== gameId) return;const resolve=this.playEndState.resolve;this.playEndState=null;resolve(true); },
    cancelPendingInteractions() { if(this.playEndState){const resolve=this.playEndState.resolve;this.playEndState=null;resolve(false);} },
    async requestResponse(request) { this.responseRequests.push(request); return response(request); },
    async requestDiscard(player, count) { return player.hand.slice(0, count); },
    async requestTarget(players) { return players[0] ?? null; },
    async requestPublicCard(_player, cards) { this.publicRequests.push(cards.map((card) => card.id)); return cards[0] ?? null; },
    async requestHiddenCards(selection, count, prompt, options = {}) {
      this.hiddenRequests.push({ selection, count, prompt, options });
      return selection.tokens.slice(0, count).map((entry) => entry.token);
    },
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

/** 统一按实体引用检查抽牌、手牌、装备、弃牌、结算、判定和公共牌池。 */
function assertCardOnlyIn(game, card, expectedZone) {
  assert.deepEqual(game.getCardZoneOccurrences(card), [expectedZone]);
}

function makeOwnedUi() {
  return {
    game:null, renders:[], mutations:[], logs:[], responseState:null, targetState:null, discardState:null, publicState:null,
    attachGame:UIManager.prototype.attachGame,
    isGameAttached:UIManager.prototype.isGameAttached,
    createGameSession:UIManager.prototype.createGameSession,
    render(game) { if (!this.isGameAttached(game)) return false;this.renders.push(game.state.gameId);return true; },
    appendLog(entry) { this.logs.push(entry.message); },
    setPrompt(message) { this.mutations.push(["prompt",message]); },
    setThinking(value) { this.mutations.push(["thinking",value]); },
    setCurrentCard(card) { this.mutations.push(["card",card?.id ?? card]); },
    queueFeedback() {}, setFastMode() {}, resolveHumanPlayEnd() {},
    requestResponse(request) { return new Promise((resolve) => { this.responseState={request,resolve};this.onResponse?.(request); }); },
    requestTarget() { return new Promise((resolve) => { this.targetState={resolve};this.onTarget?.(); }); },
    requestDiscard() { return new Promise((resolve) => { this.discardState={resolve};this.onDiscard?.(); }); },
    requestPublicCard() { return new Promise((resolve) => { this.publicState={resolve};this.onPublic?.(); }); },
    waitForHumanPlayEnd() { return Promise.resolve(true); },
    showPrivateReveal() {}, showPublicPool() {}, hidePublicPool() {}, showJudgment() {}, hideJudgment() {},
    showDying() {}, hideDying() {}, showDuel() {}, hideDuel() {}, showGameOver() {},
    cancelPendingInteractions() {
      if (this.responseState) { const {resolve}=this.responseState;this.responseState=null;resolve({status:"cancelled"}); }
      if (this.targetState) { const {resolve}=this.targetState;this.targetState=null;resolve(null); }
      if (this.discardState) { const {resolve}=this.discardState;this.discardState=null;resolve([]); }
      if (this.publicState) { const {resolve}=this.publicState;this.publicState=null;resolve(null); }
    }
  };
}

function configureOwnedGame(game, players) {
  game.state.players=players;game.state.currentPlayerIndex=0;game.state.startingPlayerIndex=0;game.state.phase="play";game.simulationMode=true;
  game.cleanupManager.delay=async()=>!game.state.isDisposed;
  for (const player of players) { player.maxEnergy=game.teamRules.getMaxEnergy(player);player.resetTurnFlags(game.teamRules.getRules(player)); }
  return game;
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

async function choosePrivateCardThroughInteraction(game, actor, card, target, { handIndexes = [0], equipment = false } = {}) {
  const ui = {
    game,
    elements:{ response_panel:makeInteractiveElement() },
    render() {},
    async requestTarget(players) { return players[0] ?? null; }
  };
  const controller = new InteractionController(ui);
  controller.requestHiddenCards = async (selection, _count, _prompt, options = {}) => {
    if (equipment) return [options.slots.find((slot) => slot.zone === "equipment")?.token].filter(Boolean);
    return handIndexes.map((index) => selection.tokens[index]?.token).filter(Boolean);
  };
  return controller.requestCardFlow(game, actor, card, [target]);
}

function assertNoHiddenSelectionLeak(value, hiddenCards) {
  const seen = new Set();
  const visit = (entry) => {
    if (!entry || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    for (const hidden of hiddenCards) assert.notEqual(entry, hidden, "公开上下文包含隐藏实体对象");
    for (const nested of Object.values(entry)) visit(nested);
  };
  visit(value);
  const serialized = JSON.stringify(value);
  for (const hidden of hiddenCards) {
    for (const secret of [hidden.id, hidden.definitionId, hidden.name, hidden.description]) {
      if (secret) assert.equal(serialized.includes(secret), false, `公开上下文泄露隐藏字段：${secret}`);
    }
  }
}

function forceAvailableAiCounters(game, capturedContexts = []) {
  game.aiController.responsePolicy.shouldRespond = (_responder, type, context, cards) => {
    capturedContexts.push(context);
    return type === "counter" && cards.length > 0;
  };
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

test("牌组恰有24种定义和158张实体牌", () => { assert.equal(Object.keys(CARD_DEFINITIONS).length, 24); assert.equal(TOTAL_CARD_COUNT, 158); });
test("三种卡牌分类之外没有旧响应分类", () => assert.deepEqual([...new Set(Object.values(CARD_DEFINITIONS).map((card) => card.category))].sort(), ["basic","equipment","tactic"]));
test("旧 support/insight/steal/coreDevice/redirect 定义已删除", () => ["support","insight","steal","coreDevice","redirect"].forEach((id) => assert.equal(CARD_DEFINITIONS[id], undefined)));
test("五种基础牌数量为突袭40、格挡20、调息12、聚能10、护盾10", () => assert.deepEqual(Object.fromEntries(["assault","block","recover","charge","shield"].map((id)=>[id,CARD_DEFINITIONS[id].count])),{assault:40,block:20,recover:12,charge:10,shield:10}));
test("基础牌数量合计92", () => assert.equal(Object.values(CARD_DEFINITIONS).filter((card) => card.category === "basic").reduce((sum, card) => sum + card.count, 0), 92));
test("战术牌数量合计51", () => assert.equal(Object.values(CARD_DEFINITIONS).filter((card) => card.category === "tactic").reduce((sum, card) => sum + card.count, 0), 51));
test("借势在集中牌堆中固定3张且均为不同真实实例", () => {
  const deck=new Deck(()=>0);deck.build();const cards=deck.cards.filter((card)=>card.definitionId==="leverage");
  assert.equal(CARD_DEFINITIONS.leverage.count,3);assert.equal(cards.length,3);assert.equal(new Set(cards.map((card)=>card.id)).size,3);assert.equal(new Set(cards).size,3);
  deck.build();assert.equal(deck.cards.filter((card)=>card.definitionId==="leverage").length,3);
});
test("装备牌数量合计15且数量来自统一配置", () => { const equipment = Object.values(CARD_DEFINITIONS).filter((card) => card.category === "equipment"); assert.equal(equipment.reduce((sum, card) => sum + card.count, 0), 15); assert.equal(equipment.length, 6); assert.deepEqual(Object.fromEntries(equipment.map((card)=>[card.definitionId,card.count])),{energyDevice:2,recycleDevice:3,defenseDevice:2,battleDevice:2,telescope:3,barrierDevice:3}); });
test("所有角色技能都存在注册器", () => GENERAL_DEFINITIONS.forEach((general) => { general.passiveSkillIds.forEach((id) => assert.ok(hasPassiveSkill(id))); general.activeSkillIds.forEach((id) => assert.ok(hasActiveSkill(id))); }));
test("所有角色都用稳定英文 roleTags 供 AI 判断职责", () => GENERAL_DEFINITIONS.forEach((general) => { assert.ok(general.roleTags.length >= 2);general.roleTags.forEach((tag)=>assert.match(tag,/^[a-z-]+$/)); }));
test("守誓者最大生命为3且壁垒说明为可叠加的永久护盾", () => { const oath=GENERAL_DEFINITIONS.find((general)=>general.id==="oath-warden");assert.equal(oath.maxHp,3);assert.match(oath.activeDescription,/1点可叠加的护盾/);assert.match(oath.activeDescription,/不会随回合消失/);assert.match(oath.activeDescription,/抵消伤害时消耗/); });
test("壁垒配置、README与实际目标规则保持一致", async () => { const oath=GENERAL_DEFINITIONS.find((general)=>general.id==="oath-warden"),readme=await readFile(projectFile("README.md"),"utf8"),config=await readFile(projectFile("js/config/generalConfig.js"),"utf8"),skills=await readFile(projectFile("js/generals/skillRegistry.js"),"utf8");assert.equal(oath.activeCost,ACTIVE_SKILLS.barrier.cost);assert.equal(oath.activeLimitPerTurn,ACTIVE_SKILLS.barrier.limitPerTurn);for(const text of [readme,config]){assert.doesNotMatch(text,/临时护盾|下次回合开始|回合开始时消散|统一消散/);assert.match(text,/不会随回合(?:数)?消失/);}assert.doesNotMatch(skills,/statuses\.temporaryShield|clearAtTurnStart/);const source=makePlayer("warden",0,"dawn","ai",1),ally=makePlayer("ally",1,"dawn"),deadAlly=makePlayer("dead-ally",2,"dawn"),enemy=makePlayer("enemy",3,"dusk");deadAlly.alive=false;const {game}=makeGame([source,ally,deadAlly,enemy]);assert.deepEqual(RuleEngine.getSkillTargets(game,source,ACTIVE_SKILLS.barrier).map((player)=>player.id),[ally.id]); });
test("八名角色规则配置与README角色介绍一致", async () => { const readme=await readFile(projectFile("README.md"),"utf8");for(const general of GENERAL_DEFINITIONS){assert.match(readme,new RegExp(`### ${general.name}`));assert.ok(readme.includes(general.description));assert.match(readme,new RegExp(`主动·${general.activeName}`));assert.match(readme,new RegExp(`被动·${general.passiveName}`));}const byId=Object.fromEntries(GENERAL_DEFINITIONS.map((general)=>[general.id,general])),expected={"blade-walker":[4,2,1],"oath-warden":[3,2,2],"spirit-medic":[3,2,2],"shade-agent":[3,1,2],"ember-magus":[3,3,1],"trail-hunter":[4,2,2],"fate-gambler":[4,1,1],"resonance-tuner":[4,2,2]};for(const [id,values] of Object.entries(expected)){const general=byId[id],skill=ACTIVE_SKILLS[general.activeSkillIds[0]];assert.deepEqual([general.maxHp,general.activeCost,general.activeLimitPerTurn],values,id);assert.deepEqual([skill.cost,skill.limitPerTurn],values.slice(1),`${id}实际技能`);} });
test("灵医配置与README同步回春摸牌、濒死触发及滋荣自疗规则", async () => {
  const medic=GENERAL_DEFINITIONS.find((general)=>general.id==="spirit-medic"),readme=await readFile(projectFile("README.md"),"utf8"),medicSection=readme.match(/### 灵医[\s\S]*?(?=\r?\n### )/)?.[0]??"";
  for(const text of [medic.passiveDescription,medicSection]){assert.match(text,/己方阵营角色/);assert.match(text,/额外恢复\s*1\s*点/);assert.match(text,/摸\s*1\s*张牌/);assert.match(text,/濒死救援.*触发|濒死救援也可触发/);assert.doesNotMatch(text,/濒死救援.*不会|阻止灵医.*回春/);}
  assert.equal(medic.activeName,"滋荣");assert.equal(ACTIVE_SKILLS.symbiosis.name,"滋荣");
  for(const text of [medic.activeDescription,medicSection]){assert.match(text,/受伤的己方阵营角色/);assert.match(text,/包括自己/);assert.match(text,/目标不是自己.*自己同样恢复\s*1\s*点生命/);assert.match(text,/消耗\s*2\s*点能量/);assert.match(text,/最多(?:使用|发动)\s*2\s*次/);}
});
test("强制 AI 救援真人配置默认开启", () => assert.equal(GAME_CONFIG.forceAiRescueHuman, true));
test("声音系统覆盖八类反馈且在无 Web Audio 环境安全降级", async () => {
  const sound = new SoundManager();
  for (const name of ["draw","select","playCard","hit","skill","discard","heal","shield"]) {
    assert.equal(typeof sound[`sound_${name}`], "function", name);
  }
  if (!sound.isSupported) assert.equal(await sound.play("draw"), false);
});
test("晨昏 BGM 使用不同速度、音色与旋律轮廓", () => {
  assert.notEqual(MUSIC_PROFILES.dawn.tempo, MUSIC_PROFILES.dusk.tempo);
  assert.notEqual(MUSIC_PROFILES.dawn.wave, MUSIC_PROFILES.dusk.wave);
  assert.notDeepEqual(MUSIC_PROFILES.dawn.lead, MUSIC_PROFILES.dusk.lead);
  for (const profile of Object.values(MUSIC_PROFILES)) {
    assert.ok(profile.lead.length * 30 / profile.tempo >= 60);
    assert.equal(profile.bass.length * 8, profile.lead.length);
    assert.equal(profile.thirds.length, profile.bass.length);
  }
});
test("BGM 音量可独立调节并限制在合法范围", () => {
  const sound = new SoundManager();
  assert.equal(sound.setMusicVolume(0.82), 0.82);
  assert.equal(sound.musicVolume, 0.82);
  assert.equal(sound.setMusicVolume(3), 1);
  assert.equal(sound.setMusicVolume(-1), 0);
});
test("BGM 无保存音量时使用默认值且明确保存零时保持静音", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable:true,
      value:{ getItem:() => null, setItem(){} }
    });
    assert.equal(new SoundManager().musicVolume, 0.75);
    globalThis.localStorage.getItem = () => "0";
    assert.equal(new SoundManager().musicVolume, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
test("晨昏主题切换后分别续播而不是反复从开头播放", () => {
  const sound = new SoundManager();
  sound.musicTeam="dawn";sound.musicStep=42;
  sound.setMusicTeam("dusk");
  assert.equal(sound.musicStepsByTeam.dawn,42);
  sound.musicStep=17;
  sound.setMusicTeam("dawn");
  assert.equal(sound.musicStepsByTeam.dusk,17);
  assert.equal(sound.musicStep,42);
});
test("抽牌音效只使用柔和纸张噪声而不含持续滑音", async () => {
  const source = await readFile(projectFile("js/audio/SoundManager.js"), "utf8");
  const drawBody = source.match(/sound_draw\(time\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  assert.match(drawBody, /this\.noise\(/);
  assert.doesNotMatch(drawBody, /this\.(?:sweep|tone)\(/);
});
test("出牌音效改用低频棕噪声且不含白噪声或持续滑音", async () => {
  const source = await readFile(projectFile("js/audio/SoundManager.js"), "utf8");
  const playBody = source.match(/sound_playCard\(time\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  assert.match(playBody, /this\.softNoise\(/);
  assert.doesNotMatch(playBody, /this\.(?:noise|sweep|tone)\(/);
});
test("普通手牌出牌不叠加选中提示音", () => {
  const played=[],sounds=[];
  const context={ discardState:null, callbacks:{ onCard:(cardId)=>played.push(cardId) }, playSound:(name)=>sounds.push(name), render(){} };
  const event={ target:clickTarget("[data-card-id]",{cardId:"audio-card",disabled:"false"}) };
  UIManager.prototype.handleHandClick.call(context,event);
  assert.deepEqual(played,["audio-card"]);
  assert.deepEqual(sounds,[]);
  context.discardState={ selectedIds:new Set(), count:1 };
  UIManager.prototype.handleHandClick.call(context,event);
  assert.deepEqual(sounds,["select"]);
});

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
test("Deck 创建158个唯一实体 card.id", () => { const deck = new Deck(() => .4); assert.equal(deck.build(), 158); assert.equal(new Set(deck.cards.map((card) => card.id)).size, 158); });
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
test("阵亡角色面板不显示残留状态和距离环文案", () => {
  const player=makePlayer("dead-panel",0,"dusk","ai",6);player.hp=0;player.alive=false;player.statuses={exposeWeakness:{stacks:2},huntMark:{sourceId:"hunter"},allIn:{assaultBonus:1}};player.turnFlags.momentum=3;
  const markup=playerPanelTemplate(player,{humanTeam:"dawn",distanceInfo:{distance:Infinity,range:1},distanceState:"已离开距离环"});
  assert.match(markup,/已阵亡/);assert.match(markup,/>状态<\/small><b>—<\/b>/);assert.doesNotMatch(markup,/破势|猎印|孤注|连势|已离开距离环|距离Infinity|距离 Infinity|射程/);
});
test("刃行者使用不同类别卡牌会增加并公开显示连势且命中后消耗", async () => { const blade=makePlayer("blade",0,"dawn","ai",0),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk","ai",0);const {game}=makeGame([blade,ally,enemy]);registerPassiveSkills(game);const charge=instance("charge"),harvest=instance("harvest"),assault=instance("assault");blade.hand.push(charge,harvest,assault);game.state.deck.cards.push(instance("block"),instance("shield"));assert.equal(await game.playCard(blade,charge,[blade]),true);assert.equal(blade.turnFlags.momentum,1);assert.equal(await game.playCard(blade,harvest,[]),true);assert.equal(blade.turnFlags.momentum,2);assert.match(playerPanelTemplate(blade,{humanTeam:"dawn"}),/状态<\/small><b>连势 2<\/b>/);const hp=enemy.hp;assert.equal(await game.playCard(blade,assault,[enemy]),true);assert.equal(enemy.hp,hp-3);assert.equal(blade.turnFlags.momentum,0);assert.doesNotMatch(playerPanelTemplate(blade,{humanTeam:"dawn"}),/连势 \d/); });
test("刃行者连势只在本人回合结束时清空", async () => {
  const blade=makePlayer("blade-turn-end",0,"dawn","ai",0),ally=makePlayer("blade-ally",1,"dawn"),enemy=makePlayer("blade-enemy",2,"dusk"),{game}=makeGame([blade,ally,enemy]);registerPassiveSkills(game);
  blade.turnFlags.momentum=2;await game.eventBus.emit("turnEnd",{type:"turnEnd",player:ally});assert.equal(blade.turnFlags.momentum,2);
  await game.eventBus.emit("turnEnd",{type:"turnEnd",player:blade});assert.equal(blade.turnFlags.momentum,0);assert.doesNotMatch(playerPanelTemplate(blade,{humanTeam:"dawn"}),/连势 \d/);
});
test("刃行者配置与README都声明回合结束清空连势", async () => {
  const blade=GENERAL_DEFINITIONS.find((general)=>general.id==="blade-walker"),readme=await readFile(projectFile("README.md"),"utf8"),bladeSection=readme.match(/### 刃行者[\s\S]*?(?=\r?\n### )/)?.[0]??"";
  assert.match(blade.passiveDescription,/回合结束后清空连势/);assert.match(bladeSection,/回合结束后清空连势/);
});
test("刃行者完整回合结束流程会清空未消费的连势", async () => {
  const blade=makePlayer("blade-full-turn",0,"dawn","ai",0),enemy=makePlayer("blade-full-turn-enemy",1,"dusk"),{game}=makeGame([blade,enemy]);registerPassiveSkills(game);
  game.aiController.selectAction=async()=>({type:"end"});game.eventBus.on("playPhaseEnd","test:grant-momentum-before-turn-end",()=>{blade.turnFlags.momentum=2;});
  await game.takeTurn(blade,game.state.gameId);assert.equal(blade.turnFlags.momentum,0);
});
test("壁垒每次提供1点可叠加的永久护盾", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn","ai",1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=4;target.shield=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,3);await ACTIVE_SKILLS.barrier.execute(game,source,[target]);assert.equal(target.shield,4);assert.equal("temporaryShield" in target.statuses,false);const log=game.state.logs.at(-1)?.message??"";assert.match(log,/构筑壁垒.*获得1点护盾/);assert.doesNotMatch(log,/持续|消散/); });
test("壁垒护盾不会在目标回合开始时消失", async () => { const source=makePlayer("a",0,"dawn"),target=makePlayer("b",1,"dawn","ai",1),enemy=makePlayer("c",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);game.state.currentPlayerIndex=1;game.aiController.selectAction=async()=>({type:"end"});await game.takeTurn(target,game.state.gameId);assert.equal(target.shield,1);assert.equal("temporaryShield" in target.statuses,false); });
test("壁垒护盾经过完整轮次且守誓者阵亡后仍然保留", async () => { const source=makePlayer("warden",0,"dawn","ai",1),target=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([source,target,enemy]);source.energy=2;target.shield=1;await ACTIVE_SKILLS.barrier.execute(game,source,[target]);source.alive=false;source.hp=0;game.state.currentPlayerIndex=1;game.state.startingPlayerIndex=1;game.aiController.selectAction=async()=>({type:"end"});for(let turn=0;turn<4;turn+=1){await game.takeTurn(game.currentPlayer,game.state.gameId);await game.advanceTurn();}assert.equal(game.state.currentRound,3);assert.equal(target.shield,2);assert.equal("temporaryShield" in target.statuses,false); });
test("壁垒与护盾牌使用统一伤害吸收规则", async () => { const source=makePlayer("warden",0,"dawn","ai",1),target=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk"),shieldCard=instance("shield");const {game}=makeGame([source,target,enemy]);source.hand.push(shieldCard);source.energy=2;assert.equal(await game.playCard(source,shieldCard,[target]),true);await ACTIVE_SKILLS.barrier.execute(game,source,[target]);const hp=target.hp;assert.equal(target.shield,2);await game.damage(enemy,target,3,{canBlock:false,damageType:"normal"});assert.equal(target.shield,0);assert.equal(target.hp,hp-1);assert.equal("temporaryShield" in target.statuses,false); });
test("README中的主动技能消耗与每回合次数进入实际规则", async () => { const warden=makePlayer("warden",0,"dawn","ai",1),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");const {game}=makeGame([warden,ally,enemy]);warden.energy=4;assert.equal(await game.useActiveSkill(warden,"barrier",[ally]),true);assert.equal(await game.useActiveSkill(warden,"barrier",[ally]),true);warden.energy=2;assert.equal(await game.useActiveSkill(warden,"barrier",[ally]),false);assert.equal(warden.turnFlags.activeSkillUseCounts.barrier,2);const blade=makePlayer("blade",0,"dawn","ai",0),bladeAlly=makePlayer("blade-ally",1,"dawn"),bladeEnemy=makePlayer("blade-enemy",2,"dusk");const {game:bladeGame}=makeGame([blade,bladeAlly,bladeEnemy]);blade.energy=2;assert.equal(await bladeGame.useActiveSkill(blade,"breakArmy",[]),true);assert.equal(blade.energy,0);assert.equal(blade.turnFlags.attackLimit,3); });
test("灵医滋荣可选择受伤的自己或队友，治疗队友时自己也恢复1点", async () => {
  const medic=makePlayer("medic",0,"dawn","ai",2),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");
  medic.hp=1;ally.hp=1;const {game}=makeGame([medic,ally,enemy]);registerPassiveSkills(game);game.state.deck.cards.push(instance("block"));medic.energy=4;
  assert.deepEqual(RuleEngine.getSkillTargets(game,medic,ACTIVE_SKILLS.symbiosis).map((player)=>player.id),[medic.id,ally.id]);
  assert.equal(await game.useActiveSkill(medic,"symbiosis",[ally]),true);
  assert.equal(ally.hp,3);assert.equal(medic.hp,2);assert.equal(medic.hand.length,1);
  assert.equal(await game.useActiveSkill(medic,"symbiosis",[medic]),true);
  assert.equal(medic.hp,medic.maxHp);assert.equal(medic.hand.length,1);assert.equal(medic.energy,0);
  medic.energy=2;assert.equal(await game.useActiveSkill(medic,"symbiosis",[ally]),false);
  assert.equal(medic.turnFlags.activeSkillUseCounts.symbiosis,2);
});
test("灵医回春每回合首次治疗己方额外恢复1点并摸1张", async () => {
  const medic=makePlayer("medic-rejuvenation",0,"dawn","ai",2),ally=makePlayer("ally-rejuvenation",1,"dawn"),enemy=makePlayer("enemy-rejuvenation",2,"dusk");
  medic.hp=2;ally.hp=1;enemy.hp-=1;const {game}=makeGame([medic,ally,enemy]);registerPassiveSkills(game);game.state.deck.cards.push(instance("block"),instance("charge"));
  await game.heal(medic,enemy,1,{reason:"测试敌方治疗"});
  assert.equal(medic.turnFlags.rejuvenationUsed,false);assert.equal(medic.hand.length,0);
  assert.equal(await game.heal(medic,ally,1,{reason:"测试队友治疗"}),2);
  assert.equal(ally.hp,3);assert.equal(medic.hand.length,1);assert.equal(medic.turnFlags.rejuvenationUsed,true);
  assert.equal(await game.heal(medic,medic,1,{reason:"测试自我治疗"}),1);
  assert.equal(medic.hp,3);assert.equal(medic.hand.length,1);
  medic.resetTurnFlags(game.teamRules.getRules(medic));ally.hp=1;
  assert.equal(await game.heal(medic,ally,1,{reason:"测试下一回合"}),2);
  assert.equal(medic.hand.length,2);assert.equal(medic.turnFlags.rejuvenationUsed,true);
});
test("影客为3点生命且窥隙经实际伤害与隐藏选择查看至多2张实体牌", async () => { const shade=makePlayer("shade",0,"dawn","human",3),enemy=makePlayer("enemy",1,"dusk");enemy.hand.push(instance("assault"),instance("recover"),instance("charge"));const {game,ui}=makeGame([shade,enemy],{random:()=>0});registerPassiveSkills(game);await game.damage(shade,enemy,1,{canBlock:false});assert.equal(shade.maxHp,3);assert.equal(shade.hp,3);assert.equal(ACTIVE_SKILLS.stealSkill.cost,1);assert.equal(ui.hiddenRequests.length,1);assert.equal(ui.hiddenRequests[0].count,2);assert.equal(ui.reveals.length,1);assert.equal(ui.reveals[0].cards.length,2);assert.equal(Object.keys(shade.aiMemory.knownCardsByPlayer[enemy.id]).length,2); });
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
test("追猎者每回合最多标记2名敌人且同一敌人最多留下1次猎印", async () => {
  const hunter=makePlayer("tracking-hunter",0,"dawn","ai",5),enemyA=makePlayer("tracking-a",1,"dusk"),enemyB=makePlayer("tracking-b",2,"dusk"),enemyC=makePlayer("tracking-c",3,"dusk"),{game}=makeGame([hunter,enemyA,enemyB,enemyC]);registerPassiveSkills(game);
  const target=(enemy)=>game.eventBus.emit("targetSelected",{source:hunter,card:instance("assault"),targets:[enemy]});
  await game.eventBus.emit("turnStart",{player:hunter});await target(enemyA);
  assert.deepEqual(enemyA.statuses.huntMark,{sourceId:hunter.id,expireAtTurnEnd:2});
  delete enemyA.statuses.huntMark;await target(enemyA);assert.equal(enemyA.statuses.huntMark,undefined);
  await target(enemyB);assert.deepEqual(enemyB.statuses.huntMark,{sourceId:hunter.id,expireAtTurnEnd:2});
  await target(enemyC);assert.equal(enemyC.statuses.huntMark,undefined);
  assert.deepEqual([...hunter.turnFlags.trackingTargetIds],[enemyA.id,enemyB.id]);
});
test("追猎者猎印持续到自己的下回合结束", async () => {
  const hunter=makePlayer("tracking-clock-hunter",0,"dawn","ai",5),enemy=makePlayer("tracking-clock-enemy",1,"dusk"),{game}=makeGame([hunter,enemy]);registerPassiveSkills(game);
  await game.eventBus.emit("turnStart",{player:hunter});await game.eventBus.emit("targetSelected",{source:hunter,card:instance("assault"),targets:[enemy]});
  await game.eventBus.emit("turnEnd",{player:hunter});assert.equal(enemy.statuses.huntMark?.sourceId,hunter.id);
  await game.eventBus.emit("turnStart",{player:hunter});assert.equal(enemy.statuses.huntMark?.sourceId,hunter.id);
  await game.eventBus.emit("turnEnd",{player:hunter});assert.equal(enemy.statuses.huntMark,undefined);
});
test("AI 深层模拟保存追踪目标并允许同回合标记不同敌人", () => {
  const state={players:[
    {id:"hunter",seatIndex:0,generalId:"trail-hunter",battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:4,alive:true,handCount:4,hand:[{id:"a1",definitionId:"assault"},{id:"a2",definitionId:"assault"},{id:"a3",definitionId:"assault"},{id:"a4",definitionId:"assault"}],attackUsed:0,trackingTargetIds:[],activeSkillUses:0,activeSkillLimit:2,statuses:[]},
    {id:"enemy-a",seatIndex:1,battleTeam:"dusk",hp:10,maxHp:10,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0,statuses:[]},
    {id:"enemy-b",seatIndex:2,battleTeam:"dusk",hp:10,maxHp:10,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0,statuses:[]},
    {id:"enemy-c",seatIndex:3,battleTeam:"dusk",hp:10,maxHp:10,shield:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0,statuses:[]}
  ]},simulator=new AiSimulator(state);
  const markedA=simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"a1"},targets:[{id:"enemy-a"}]},"hunter");
  const huntedA=simulator.apply(markedA,{type:"skill",skill:{id:"hunt",cost:0,limitPerTurn:2},targets:[{id:"enemy-a"}]},"hunter");
  const repeatedA=simulator.apply(huntedA,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"a2"},targets:[{id:"enemy-a"}]},"hunter");
  const markedB=simulator.apply(repeatedA,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"a3"},targets:[{id:"enemy-b"}]},"hunter");
  const cappedC=simulator.apply(markedB,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"a4"},targets:[{id:"enemy-c"}]},"hunter");
  assert.equal(markedA.players[1].huntMarkSourceId,"hunter");assert.equal(repeatedA.players[1].huntMarkSourceId,null);
  assert.equal(markedB.players[2].huntMarkSourceId,"hunter");assert.equal(cappedC.players[3].huntMarkSourceId,undefined);assert.deepEqual(cappedC.players[0].trackingTargetIds,["enemy-a","enemy-b"]);
});
test("追踪配置与README声明每回合限2次、同一敌人限1次并持续到下回合结束", async () => {
  const hunter=GENERAL_DEFINITIONS.find((general)=>general.id==="trail-hunter"),readme=await readFile(projectFile("README.md"),"utf8"),section=readme.match(/### 追猎者[\s\S]*?(?=\r?\n### )/)?.[0]??"";
  for(const text of [hunter.passiveDescription,hunter.passiveLimitText,section])assert.match(text,/每回合.*2\s*次/);
  for(const text of [hunter.passiveDescription,hunter.passiveLimitText,section]){assert.match(text,/同一名?敌人.*(?:每回合|一回合).*(?:1次|1 次)/);}
  for(const text of [hunter.passiveDescription,section])assert.match(text,/下回合结束/);
});
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
test("响应事件中的角色和卡牌名称会在写入 DOM 前安全转义", async () => { const responder=makePlayer("h",0,"dawn","human"),source={id:"source",name:'<img src=x onerror=alert(1)>'},target=responder,card={name:'<script>bad()</script>',definitionId:"assault"},presentation=buildResponsePresentation(responder,"block",{source,target,card},1,0,"格挡");const previousWindow=globalThis.window;globalThis.window={setInterval,clearInterval};const panel={innerHTML:"",classList:{add(){},remove(){}},querySelector(){return null;}};const fake={responseState:null,elements:{response_panel:panel},game:{cleanupManager:{delay:()=>new Promise(()=>{})}},render(){}};try{const pending=UIManager.prototype.requestResponse.call(fake,{id:"escape-response",requiredCount:1,legalCardIds:[],timeoutMs:5000,presentation},"格挡");assert.doesNotMatch(panel.innerHTML,/<img|<script>/);assert.match(panel.innerHTML,/&lt;img/);assert.match(panel.innerHTML,/&lt;script/);fake.responseState.resolve(false);assert.equal((await pending).status,"declined");}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;} });
test("主动技能按钮只显示技能名称", () => { assert.equal(skillButtonLabel({id:"allIn",name:"孤注",cost:"all"}),"孤注");assert.equal(skillButtonLabel({id:"hunt",name:"猎杀",cost:2}),"猎杀");assert.equal(skillButtonLabel(null),"主动技能"); });
test("突袭在中央结算区与使用日志中显示作用对象", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game,ui}=makeGame([a,b]);const assault=instance("assault");a.hand.push(assault);await game.playCard(a,assault,[b]);assert.equal(ui.currentCards[0].targetLabel,b.name);assert.ok(ui.logs.some((message)=>message===`${a.name}使用了「突袭」，作用对象：${b.name}。`)); });
test("借势第一目标要求真实装备且至少存在一个距离合法第二目标", () => {
  const actor=makePlayer("actor",0,"dawn"),valid=makePlayer("valid",1,"dawn"),empty=makePlayer("empty",2,"dawn"),dead=makePlayer("dead",3,"dawn");
  valid.equipment=instance("energyDevice");dead.equipment=instance("telescope");dead.alive=false;empty.statuses.virtualEquipment={definitionId:"battleDevice"};
  const {game}=makeGame([actor,valid,empty,dead]);assert.deepEqual(RuleEngine.getLegalAssaultTargets(game,valid),[]);
  assert.ok(RuleEngine.getAssaultTargetCandidates(game,valid).includes(actor));assert.deepEqual(RuleEngine.getLeverageFirstTargets(game,actor),[valid]);
  valid.turnFlags.attackUsed=valid.turnFlags.attackLimit;assert.deepEqual(RuleEngine.getLeverageFirstTargets(game,actor),[valid]);
});
test("借势核心第一目标筛选不要求普通突袭敌人且允许同阵营第二目标", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dawn"),ally=makePlayer("ally",2,"dawn"),use=instance("leverage");actor.hand.push(use);first.equipment=instance("energyDevice");
  const {game}=makeGame([actor,first,ally]);
  assert.deepEqual(RuleEngine.getLegalAssaultTargets(game,first),[]);assert.ok(RuleEngine.getAssaultTargetCandidates(game,first).includes(actor));
  assert.ok(RuleEngine.getLeverageFirstTargets(game,actor).includes(first));assert.ok(!RuleEngine.getLeverageFirstTargets(game,actor).includes(actor));
  assert.equal(RuleEngine.canPlayCard(game,actor,use).ok,true);
});
test("AI 根节点在无普通突袭敌人时仍生成同阵营借势意图", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dawn"),ally=makePlayer("ally",2,"dawn"),use=instance("leverage");actor.hand.push(use);first.equipment=instance("energyDevice");
  const {game}=makeGame([actor,first,ally]);assert.deepEqual(RuleEngine.getLegalAssaultTargets(game,first),[]);
  const actions=game.aiController.actionGenerator.generate(actor).filter((action)=>action.card?.id===use.id);
  assert.ok(actions.some((action)=>action.selection.firstTargetId===first.id&&action.selection.equipmentCardId===first.equipment.id&&action.selection.secondTargetId===actor.id));
});
test("AI 深层生成在无普通突袭敌人时仍枚举同阵营借势第二目标", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dawn"),ally=makePlayer("ally",2,"dawn"),use=instance("leverage");actor.hand.push(use);first.equipment=instance("energyDevice");
  const {game}=makeGame([actor,first,ally]);const visible=createAiVisibleState(actor.id,game.state),visibleFirst=visible.players.find((player)=>player.id===first.id);
  const simulationGame={state:{players:visible.players}};
  assert.equal(RuleEngine.getLegalAssaultTargets(simulationGame,visibleFirst).length,0);assert.ok(RuleEngine.getAssaultTargetCandidates(simulationGame,visibleFirst).some((player)=>player.id===actor.id));
  const deepActions=game.aiController.actionGenerator.generateFromVisible(visible,actor.id).filter((action)=>action.card?.id===use.id);
  assert.ok(deepActions.some((action)=>action.selection.firstTargetId===first.id&&action.selection.equipmentCardId===null&&action.selection.equipmentDefinitionId==="energyDevice"&&action.selection.secondTargetId===actor.id));
});
test("真人借势无普通突袭敌人时仍可选择同阵营第一目标和使用者为第二目标", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),first=makePlayer("first",1,"dawn"),use=instance("leverage"),equipment=instance("energyDevice");actor.hand.push(use);first.equipment=equipment;const {game}=makeGame([actor,first]);
  let call=0;const controller=new InteractionController({requestTarget:async(players)=>{call+=1;return call===1?players.find((player)=>player.id==="first"):players.find((player)=>player.id==="actor");}});
  controller.requestConfirmation=async()=>true;
  const selection=await controller.requestCardFlow(game,actor,use,[]);
  assert.deepEqual(selection,{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});
});
test("借势第一目标没有距离合法第二目标时仍被排除", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dawn"),ally=makePlayer("ally",2,"dawn"),enemy=makePlayer("enemy",3,"dusk"),tail=makePlayer("tail",4,"dawn");first.equipment=instance("energyDevice");
  actor.equipment=instance("barrierDevice");ally.equipment=instance("barrierDevice");enemy.equipment=instance("barrierDevice");tail.equipment=instance("barrierDevice");
  const {game}=makeGame([actor,first,ally,enemy,tail]);
  assert.deepEqual(RuleEngine.getAssaultTargetCandidates(game,first),[]);assert.ok(!RuleEngine.getLeverageFirstTargets(game,actor).includes(first));
});
test("借势第一目标筛选完全不读取手牌或突袭次数", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),equipment=instance("energyDevice");first.equipment=equipment;const {game}=makeGame([actor,first]);
  first.hand=new Proxy([], {get(){throw new Error("候选筛选不应读取手牌");}});
  first.turnFlags=new Proxy(first.turnFlags,{get(target,key){if(key==="attackUsed"||key==="attackLimit")throw new Error("候选筛选不应读取突袭次数");return Reflect.get(target,key);}});
  assert.deepEqual(RuleEngine.getLeverageFirstTargets(game,actor),[first]);assert.deepEqual(RuleEngine.getAssaultTargetCandidates(game,first),[actor]);
});
test("借势可指定距离外队友为第一目标且只检查其对第二目标的普通突袭距离", async () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),farAlly=makePlayer("far-ally",2,"dawn"),ally=makePlayer("ally",3,"dawn"),tail=makePlayer("tail",4,"dusk"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);farAlly.equipment=equipment;const {game}=makeGame([actor,enemy,farAlly,ally,tail]);
  assert.equal(DistanceSystem.getDistance(game,actor,farAlly),2);assert.ok(RuleEngine.getLeverageFirstTargets(game,actor).includes(farAlly));assert.ok(RuleEngine.getLegalAssaultTargets(game,farAlly).includes(enemy));
  await game.playCard(actor,use,[],{firstTargetId:farAlly.id,equipmentCardId:equipment.id,secondTargetId:enemy.id});assert.equal(farAlly.equipment,null);assert.ok(actor.hand.includes(equipment));
});
test("借势第二目标只按第一目标攻击距离筛选且允许同阵营与使用者本人", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),ally=makePlayer("ally",2,"dusk"),far=makePlayer("far",3,"dawn"),tail=makePlayer("tail",4,"dawn");first.equipment=instance("energyDevice");
  const {game}=makeGame([actor,first,ally,far,tail]);const targets=RuleEngine.getAssaultTargetCandidates(game,first);
  assert.ok(targets.includes(actor));assert.ok(targets.includes(ally));assert.ok(!targets.includes(first));assert.ok(!targets.includes(far));assert.ok(!targets.includes(tail));
  assert.ok(!RuleEngine.getLegalAssaultTargets(game,first).includes(ally));
});
test("借势选择阶段取消不会消耗卡牌或留下状态变化", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),first=makePlayer("first",1,"dusk"),use=instance("leverage"),equipment=instance("energyDevice");actor.hand.push(use);first.equipment=equipment;const {game}=makeGame([actor,first]);const controller=new InteractionController({requestTarget:async()=>null});const logCount=game.state.logs.length;
  assert.equal(await controller.requestCardFlow(game,actor,use,[]),null);assert.ok(actor.hand.includes(use));assert.equal(first.equipment,equipment);assert.equal(game.state.logs.length,logCount);assert.equal(controller.pending,null);
});
test("借势无合法突袭时不弹响应窗口并把同一装备实例移入使用者手牌", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk","human"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=equipment;
  const {game,ui}=makeGame([actor,first]);const selection={firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id};
  assert.equal(await game.playCard(actor,use,[],selection),true);assert.equal(ui.responseRequests.some((request)=>request.type==="leverageAssault"),false);assert.equal(first.equipment,null);assert.ok(actor.hand.includes(equipment));assert.equal(actor.equipment,null);assert.ok(game.state.deck.discardPile.includes(use));assert.equal(equipment.id,selection.equipmentCardId);
});
test("借势主动拒绝统一转移装备且不消耗第一目标突袭", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk","human"),equipment=instance("battleDevice"),assault=instance("assault"),use=instance("leverage");actor.hand.push(use);first.hand.push(assault);first.equipment=equipment;
  const {game,ui}=makeGame([actor,first],{response:()=>false});await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});
  assert.ok(first.hand.includes(assault));assert.ok(actor.hand.includes(equipment));assert.ok(ui.logs.some((message)=>message===`${first.name}拒绝使用「突袭」，${actor.name}获得了其「${equipment.name}」。`));assert.ok(!ui.logs.some((message)=>/没有突袭|距离|次数/.test(message)));
});
test("借势成功响应使用真实突袭并完整复用次数、伤害、格挡和弃置流程", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),first=makePlayer("first",1,"dusk","human"),equipment=instance("battleDevice"),assault=instance("assault"),blockA=instance("block"),blockB=instance("block"),use=instance("leverage");actor.hand.push(use,blockA,blockB);first.hand.push(assault);first.equipment=equipment;
  const {game,ui}=makeGame([actor,first],{response:(request)=>request.type==="leverageAssault"||request.type==="block"});const hp=actor.hp;
  await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});
  assert.equal(first.equipment,equipment);assert.equal(first.turnFlags.attackUsed,1);assert.equal(actor.hp,hp);assert.ok(game.state.deck.discardPile.includes(assault));assert.ok(game.state.deck.discardPile.includes(use));assert.equal(actor.hand.includes(blockA),false);assert.equal(actor.hand.includes(blockB),false);assert.ok(ui.responseRequests.some((request)=>request.type==="leverageAssault"&&request.legalCardIds.includes(assault.id)));
});
test("借势不能绕过第一目标的突袭次数限制", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk","human"),equipment=instance("energyDevice"),assault=instance("assault"),use=instance("leverage");actor.hand.push(use);first.hand.push(assault);first.equipment=equipment;
  const {game,ui}=makeGame([actor,first],{response:()=>true});first.turnFlags.attackUsed=first.turnFlags.attackLimit;
  assert.equal(RuleEngine.canPlayCard(game,actor,use).ok,true);assert.deepEqual(RuleEngine.getLeverageFirstTargets(game,actor),[first]);assert.deepEqual(RuleEngine.getAssaultTargetCandidates(game,first),[actor]);
  assert.equal(RuleEngine.canActuallyUseAssault(game,first,assault,actor,{allowOutOfTurn:true}).ok,false);
  await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});
  assert.equal(ui.responseRequests.some((request)=>request.type==="leverageAssault"),false);assert.ok(first.hand.includes(assault));assert.ok(actor.hand.includes(equipment));assert.equal(first.turnFlags.attackUsed,first.turnFlags.attackLimit);assert.ok(ui.logs.some((message)=>message===`${first.name}拒绝使用「突袭」，${actor.name}获得了其「${equipment.name}」。`));
});
test("借势锁定望远镜时响应前不卸装，仍按该武器修正后的距离使用普通突袭", async () => {
  const actor=makePlayer("actor",2,"dawn","human"),first=makePlayer("first",0,"dusk","human"),screen=makePlayer("screen",1,"dusk"),other=makePlayer("other",3,"dawn"),tail=makePlayer("tail",4,"dawn"),equipment=instance("telescope"),assault=instance("assault"),use=instance("leverage");actor.hand.push(use);first.hand.push(assault);first.equipment=equipment;
  const {game}=makeGame([actor,first,screen,other,tail],{response:(request)=>request.type==="leverageAssault"});assert.equal(DistanceSystem.getDistance(game,first,actor),1);
  assert.ok(RuleEngine.getLegalAssaultTargets(game,first).includes(actor));await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});assert.equal(first.equipment,equipment);assert.equal(first.turnFlags.attackUsed,1);
});
test("借势只接受唯一ID对应的原装备且不会用同名替代", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),original=instance("energyDevice"),replacement=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=original;const {game}=makeGame([actor,first]);
  assert.equal(await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:replacement.id,secondTargetId:actor.id}),false);assert.ok(actor.hand.includes(use));assert.equal(first.equipment,original);
  game.eventBus.on("beforeCardResolve","test:replace-leverage-equipment",(event)=>{if(event.card===use)first.equipment=replacement;});
  assert.equal(await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:original.id,secondTargetId:actor.id}),true);assert.equal(first.equipment,replacement);assert.ok(!actor.hand.includes(original));assert.ok(!actor.hand.includes(replacement));assert.ok(game.state.logs.some((entry)=>entry.message.includes("指定装备已离开装备区")));
});
test("借势并发重复提交只结算和转移一次", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=equipment;const {game}=makeGame([actor,first]);const selection={firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id};
  const results=await Promise.all([game.playCard(actor,use,[],selection),game.playCard(actor,use,[],selection)]);assert.equal(results.filter(Boolean).length,1);assert.equal(actor.hand.filter((card)=>card===equipment).length,1);assert.equal(first.equipment,null);assert.equal(game.state.deck.discardPile.filter((card)=>card===use).length,1);
});
test("借势响应前任一目标离场会取消且不按拒绝转移装备", async () => {
  for(const leaving of ["first","second"]){const actor=makePlayer(`actor-${leaving}`,0,"dawn"),first=makePlayer(`first-${leaving}`,1,"dusk"),second=makePlayer(`second-${leaving}`,2,"dawn"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=equipment;const {game}=makeGame([actor,first,second]);
    game.eventBus.on("beforeCardResolve",`test:leave-before-leverage:${leaving}`,(event)=>{if(event.card===use)(leaving==="first"?first:second).alive=false;});
    await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:second.id});assert.equal(first.equipment,equipment);assert.ok(!actor.hand.includes(equipment));assert.ok(game.state.logs.some((entry)=>entry.message.includes("目标已离场")));
  }
});
test("AI 主动借势第一目标需有距离合法第二目标且第二目标只按距离枚举", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),ally=makePlayer("ally",2,"dusk"),far=makePlayer("far",3,"dawn"),tail=makePlayer("tail",4,"dawn"),use=instance("leverage");actor.hand.push(use);first.equipment=instance("energyDevice");const {game}=makeGame([actor,first,ally,far,tail]);
  const actions=game.aiController.getLegalActions(actor).filter((action)=>action.card?.id===use.id);assert.ok(actions.length>0);for(const action of actions){assert.equal(action.selection.firstTargetId,first.id);assert.equal(action.selection.equipmentCardId,first.equipment.id);assert.ok(RuleEngine.getAssaultTargetCandidates(game,first).includes(action.targets[1]));}assert.ok(actions.some((action)=>action.targets[1]===actor));assert.ok(actions.some((action)=>action.targets[1]===ally));assert.ok(!actions.some((action)=>action.targets[1]===far));assert.ok(!actions.some((action)=>action.targets[1]===tail));
});
test("借势第二目标选择不读取第一目标手牌或突袭次数", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),ally=makePlayer("ally",2,"dusk"),equipment=instance("energyDevice");first.equipment=equipment;const {game}=makeGame([actor,first,ally]);
  first.hand=new Proxy([], {get(){throw new Error("借势第二目标筛选不应读取手牌");}});
  first.turnFlags=new Proxy(first.turnFlags,{get(target,key){if(key==="attackUsed"||key==="attackLimit")throw new Error("借势第二目标筛选不应读取突袭次数");return Reflect.get(target,key);}});
  const targets=RuleEngine.getAssaultTargetCandidates(game,first);assert.ok(targets.includes(actor));assert.ok(targets.includes(ally));
});
test("借势第二目标距离按第一目标到第二目标计算而非借势使用者", () => {
  const user=makePlayer("user",0,"dawn"),screen=makePlayer("screen",1,"dawn"),first=makePlayer("first",2,"dusk"),second=makePlayer("second",3,"dusk"),tail=makePlayer("tail",4,"dawn");first.equipment=instance("energyDevice");const {game}=makeGame([user,screen,first,second,tail]);
  assert.equal(DistanceSystem.getDistance(game,first,second),1);assert.equal(DistanceSystem.getDistance(game,user,second),2);
  const targets=RuleEngine.getAssaultTargetCandidates(game,first);assert.ok(targets.includes(second));
});
test("借势可指定距离内同阵营第二目标且核心接受该选择", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk","human"),ally=makePlayer("ally",2,"dusk"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=equipment;const {game,ui}=makeGame([actor,first,ally]);
  assert.equal(await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:ally.id}),true);
  assert.equal(ui.responseRequests.some((request)=>request.type==="leverageAssault"),false);assert.equal(first.equipment,null);assert.ok(actor.hand.includes(equipment));
});
test("真人借势可选择距离内同阵营第二目标", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),first=makePlayer("first",1,"dusk"),ally=makePlayer("ally",2,"dusk"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=equipment;const {game}=makeGame([actor,first,ally]);
  let call=0;const controller=new InteractionController({requestTarget:async(players)=>{call+=1;return call===1?players.find((player)=>player.id==="first"):players.find((player)=>player.id==="ally");}});
  controller.requestConfirmation=async()=>true;
  const selection=await controller.requestCardFlow(game,actor,use,[]);
  assert.deepEqual(selection,{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:ally.id});
});
test("借势第二目标候选枚举不提前交出装备或结算突袭", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),ally=makePlayer("ally",2,"dusk"),equipment=instance("energyDevice"),assault=instance("assault"),use=instance("leverage");actor.hand.push(use);first.hand.push(assault);first.equipment=equipment;const {game}=makeGame([actor,first,ally]);const logs=game.state.logs.length;
  RuleEngine.getAssaultTargetCandidates(game,first);
  assert.equal(first.equipment,equipment);assert.equal(first.turnFlags.attackUsed,0);assert.ok(first.hand.includes(assault));assert.ok(actor.hand.includes(use));assert.equal(game.state.logs.length,logs);
});
test("AI 不会因估计没有突袭或次数用尽删除合法借势组合", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),use=instance("leverage");actor.hand.push(use);first.equipment=instance("energyDevice");const {game}=makeGame([actor,first]);first.turnFlags.attackUsed=first.turnFlags.attackLimit;
  const rootActions=game.aiController.getLegalActions(actor).filter((action)=>action.card?.id===use.id);assert.ok(rootActions.length>0);
  const visible=createAiVisibleState(actor.id,game.state),visibleFirst=visible.players.find((player)=>player.id===first.id);assert.equal(visibleFirst.assaultResponseProbability,0);assert.equal(visibleFirst.attackUsed,visibleFirst.attackLimit);
  const deepActions=game.aiController.actionGenerator.generateFromVisible(visible,actor.id).filter((action)=>action.card?.id===use.id);assert.ok(deepActions.length>0);assert.ok(deepActions.some((action)=>action.selection.secondTargetId===actor.id));
});
test("AI 借势响应使用统一策略且仍通过普通突袭流程", async () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),equipment=instance("battleDevice"),assault=instance("assault"),use=instance("leverage");actor.hand.push(use);first.hand.push(assault,instance("assault"));first.equipment=equipment;const {game}=makeGame([actor,first]);game.aiController.responsePolicy.shouldRespond=(_responder,type)=>type==="leverageAssault";
  await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});assert.equal(first.turnFlags.attackUsed,1);assert.equal(first.equipment,equipment);assert.ok(game.state.deck.discardPile.includes(assault));
});
test("AI 借势响应通过可见快照评估真实玩家状态", () => {
  const actor=makePlayer("actor",0,"dawn"),first=makePlayer("first",1,"dusk"),equipment=instance("battleDevice"),assault=instance("assault");first.hand.push(assault);first.equipment=equipment;const {game}=makeGame([actor,first]);
  const decision=game.aiController.responsePolicy.shouldRespond(first,"leverageAssault",{target:actor,equipment},[assault]);assert.equal(typeof decision,"boolean");
});
test("AI 借势有牌拒绝与无牌拒绝经过相同思考提示且日志不泄露原因", async () => {
  const run=async(withAssault)=>{const actor=makePlayer(`actor-${withAssault}`,0,"dawn"),first=makePlayer(`first-${withAssault}`,1,"dusk"),equipment=instance("energyDevice"),use=instance("leverage");actor.hand.push(use);first.equipment=equipment;if(withAssault)first.hand.push(instance("assault"));const {game,ui}=makeGame([actor,first]);game.aiController.responsePolicy.shouldRespond=()=>false;const prompts=[];ui.setPrompt=(message)=>prompts.push(message);await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});return {thinking:ui.thinking.map((entry)=>entry[0]),prompts,logs:ui.logs.filter((message)=>message.includes("拒绝使用「突袭」"))};};
  const without=await run(false),withCard=await run(true);assert.deepEqual(without.thinking,[true,false]);assert.deepEqual(withCard.thinking,[true,false]);assert.deepEqual(without.prompts,[]);assert.deepEqual(withCard.prompts,[]);assert.equal(without.logs.length,1);assert.equal(withCard.logs.length,1);assert.ok(without.logs.every((message)=>!/没有|次数|无法|距离/.test(message)));assert.ok(withCard.logs.every((message)=>!/没有|次数|无法|距离/.test(message)));
});
test("真人把自己设为借势第二目标并阵亡后不恢复继续出牌提示", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),first=makePlayer("first",1,"dusk","ai"),ally=makePlayer("ally",2,"dawn","ai"),equipment=instance("energyDevice"),assault=instance("assault"),use=instance("leverage");actor.hp=1;actor.hand.push(use);first.hand.push(assault);first.equipment=equipment;const {game,ui}=makeGame([actor,first,ally]);const prompts=[];ui.setPrompt=(message)=>prompts.push(message);game.aiController.responsePolicy.shouldRespond=(_responder,type)=>type==="leverageAssault";
  await game.playCard(actor,use,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id});assert.equal(actor.alive,false);assert.equal(game.pendingHumanPlayEnd,false);assert.ok(!prompts.some((message)=>message.includes("继续出牌")||message.includes("结束本次出牌阶段")));
});
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
test("转移配置和README明确只允许移动手牌", async () => { const transfer=CARD_DEFINITIONS.transfer,readme=await readFile(projectFile("README.md"),"utf8");assert.deepEqual(transfer.targetZones,["hand"]);assert.deepEqual(transfer.selectionFlow,["source","receiver","handCard:1"]);assert.ok(!transfer.subtypes.includes("equipment-control"));assert.match(transfer.description,/手牌/);assert.match(transfer.description,/不能转移装备区/);assert.match(readme,/转移：[^\n]*装备区的牌不能被转移/);assert.doesNotMatch(readme,/转移：[^\n]*装备直接进入接收者装备区/); });
test("真人转移选牌界面不提供装备区选项", async () => { const actor=makePlayer("actor",0,"dawn","human"),from=makePlayer("from",1,"dusk"),receiver=makePlayer("receiver",2,"dawn"),use=instance("transfer"),held=instance("block"),equipment=instance("defenseDevice");actor.hand.push(use);from.hand.push(held);from.equipment=equipment;const {game}=makeGame([actor,from,receiver]),chosenPlayers=[from,receiver],ui={requestTarget:async()=>chosenPlayers.shift()},controller=new InteractionController(ui);let slots=null;controller.requestHiddenCards=async(selection,_count,_prompt,options)=>{slots=options.slots;return [selection.tokens[0].token];};const result=await controller.requestCardFlow(game,actor,use,[]);assert.equal(result.zone,"hand");assert.ok(result.tokens.length===1);assert.equal(slots.length,1);assert.ok(slots.every((slot)=>slot.zone!=="equipment"&&slot.token!=="public-equipment")); });
test("真人掠夺指定隐藏牌后按已知公开牌名记录", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const use=instance("plunder"),secret=instance("block");a.hand.push(use);b.hand.push(secret);b.bumpHandVersion();const h=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,use,[b],{tokens:[h.tokens[0].token],selectionId:h.selectionId});assert.ok(a.hand.includes(secret));assert.ok(game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("破坏公开牌名并把牌移入弃牌堆", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);const use=instance("destroy"),secret=instance("block");a.hand.push(use);b.hand.push(secret);b.bumpHandVersion();const h=game.cardSelectionSystem.createHiddenSelection(b);await game.playCard(a,use,[b],{tokens:[h.tokens[0].token],selectionId:h.selectionId});assert.ok(game.state.deck.discardPile.includes(secret));assert.ok(game.state.logs.some((entry)=>entry.message.includes(secret.name))); });
test("四种旧装备采用README中的新名称且保留稳定definitionId", () => { assert.deepEqual(Object.fromEntries(["energyDevice","recycleDevice","defenseDevice","battleDevice"].map((id)=>[id,CARD_DEFINITIONS[id].name])),{energyDevice:"充能桩",recycleDevice:"回收站",defenseDevice:"雷达",battleDevice:"军火库"}); });
test("转移与掠夺按统一动态距离限制且转移来源必须持有手牌", () => { const actor=makePlayer("actor",0,"dawn"),near=makePlayer("near",1,"dusk"),far=makePlayer("far",2,"dusk"),other=makePlayer("other",3,"dawn"),tail=makePlayer("tail",4,"dawn");near.hand.push(instance("block"));far.equipment=instance("barrierDevice");const {game}=makeGame([actor,near,far,other,tail]);assert.ok(RuleEngine.getTransferSources(game,actor,CARD_DEFINITIONS.transfer).includes(near));assert.ok(!RuleEngine.getTransferSources(game,actor,CARD_DEFINITIONS.transfer).includes(far));assert.ok(!RuleEngine.getCardTargets(game,actor,CARD_DEFINITIONS.plunder).includes(far));assert.ok(RuleEngine.getCardTargets(game,actor,CARD_DEFINITIONS.destroy).includes(far));far.hand.push(instance("charge"));far.equipment=instance("energyDevice");actor.equipment=instance("telescope");assert.ok(RuleEngine.getTransferSources(game,actor,CARD_DEFINITIONS.transfer).includes(far));assert.ok(RuleEngine.getCardTargets(game,actor,CARD_DEFINITIONS.plunder).includes(far)); });
test("真人和核心都拒绝把装备区实体作为转移牌", async () => { const actor=makePlayer("actor",0,"dawn","human"),from=makePlayer("from",1,"dusk"),receiver=makePlayer("receiver",2,"dawn"),equipment=instance("energyDevice"),hiddenCard=instance("block"),oldEquipment=instance("defenseDevice"),use=instance("transfer");const {game}=makeGame([actor,from,receiver]);actor.hand.push(use);from.hand.push(hiddenCard);from.equipment=equipment;receiver.equipment=oldEquipment;const selection=game.cardSelectionSystem.createHiddenSelection(from);assert.equal(await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"equipment",equipmentCardId:equipment.id,selectionId:selection.selectionId}),false);assert.ok(actor.hand.includes(use));assert.equal(from.equipment,equipment);assert.equal(receiver.equipment,oldEquipment);assert.ok(from.hand.includes(hiddenCard));assert.ok(!game.state.deck.discardPile.includes(use));assert.equal(game.cardSelectionSystem.isSelectionActive(selection.selectionId,from),false); });
test("掠夺可把距离2内目标装备公开移入施牌者手牌", async () => { const actor=makePlayer("actor",0,"dawn","human"),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),equipment=instance("energyDevice"),original=instance("battleDevice"),use=instance("plunder");const {game}=makeGame([actor,near,target,other,tail]);actor.equipment=original;actor.hand.push(use);target.equipment=equipment;const handVersion=actor.handVersion,selection=game.cardSelectionSystem.createHiddenSelection(target);assert.equal(await game.playCard(actor,use,[target],{zone:"equipment",equipmentCardId:equipment.id,selectionId:selection.selectionId}),true);assert.equal(target.equipment,null);assert.equal(actor.equipment,original);assert.ok(actor.hand.includes(equipment));assert.ok(!game.state.deck.discardPile.includes(original));assert.ok(actor.handVersion>handVersion);assert.ok(game.state.logs.some((entry)=>entry.message.includes("充能桩")&&entry.message.includes("收入手牌"))); });
test("破坏可不限距离弃置装备区装备", async () => { const actor=makePlayer("actor",0,"dawn"),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),equipment=instance("barrierDevice"),use=instance("destroy");const {game}=makeGame([actor,near,target,other,tail]);actor.hand.push(use);target.equipment=equipment;assert.equal(DistanceSystem.getDistance(game,actor,target),3);const selection=game.cardSelectionSystem.createHiddenSelection(target);assert.equal(await game.playCard(actor,use,[target],{zone:"equipment",equipmentCardId:equipment.id,selectionId:selection.selectionId}),true);assert.equal(target.equipment,null);assert.ok(game.state.deck.discardPile.includes(equipment)); });
test("影客窃取可把距离2内敌方装备收入手牌且不替换原装备", async () => { const shade=makePlayer("shade",0,"dawn","ai",3),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),equipment=instance("energyDevice"),original=instance("battleDevice");const {game}=makeGame([shade,near,target,other,tail],{random:()=>0});shade.energy=2;shade.equipment=original;target.equipment=equipment;assert.ok(RuleEngine.getSkillTargets(game,shade,ACTIVE_SKILLS.stealSkill).includes(target));assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),true);assert.equal(target.equipment,null);assert.equal(shade.equipment,original);assert.ok(shade.hand.includes(equipment));assert.ok(!game.state.deck.discardPile.includes(equipment));const blockedShade=makePlayer("blocked-shade",0,"dawn","ai",3),blockedNear=makePlayer("blocked-near",1,"dawn"),blocked=makePlayer("blocked",2,"dusk"),blockedOther=makePlayer("blocked-other",3,"dusk"),blockedTail=makePlayer("blocked-tail",4,"dawn");blocked.equipment=instance("barrierDevice");const {game:blockedGame}=makeGame([blockedShade,blockedNear,blocked,blockedOther,blockedTail]);assert.equal(DistanceSystem.getDistance(blockedGame,blockedShade,blocked),3);assert.ok(!RuleEngine.getSkillTargets(blockedGame,blockedShade,ACTIVE_SKILLS.stealSkill).includes(blocked)); });
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
test("震荡的反制只取消当前目标所受效果而不取消整张群伤牌", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dusk");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.type==="counter"&&request.targetPlayerId===b.id});const shockwave=instance("shockwave"),counter=instance("counter"),bHp=b.hp,cHp=c.hp;a.hand.push(shockwave);b.hand.push(counter);await game.playCard(a,shockwave,[b,c]);assert.equal(b.hp,bHp);assert.equal(c.hp,cHp-1);assert.equal(b.hand.includes(counter),false);assert.ok(ui.responseRequests.some((request)=>request.type==="counter"&&request.targetPlayerId===b.id&&request.presentation.responseText.includes("仅取消")&&request.presentation.responseText.includes("其他目标")));assert.ok(ui.logs.some((message)=>message===`${b.name}对${a.name}的「震荡」使用了「反制」，取消了「震荡」对${b.name}的效果。`)); });
test("挑衅的反制只取消当前目标效果且不能保护队友", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dusk","human");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.type==="counter"&&request.targetPlayerId===b.id});const provoke=instance("provoke"),counter=instance("counter"),bHp=b.hp,cHp=c.hp;a.hand.push(provoke);b.hand.push(counter);await game.playCard(a,provoke,[b,c]);assert.equal(b.hp,bHp);assert.equal(c.hp,cHp-1);assert.equal(b.hand.includes(counter),false);assert.ok(ui.responseRequests.some((request)=>request.type==="counter"&&request.targetPlayerId===b.id&&request.presentation.responseText.includes("仅取消")&&request.presentation.responseText.includes("其他目标")));assert.ok(ui.logs.some((message)=>message===`${b.name}对${a.name}的「挑衅」使用了「反制」，取消了「挑衅」对${b.name}的效果。`)); });
test("针对震荡目标的反制仍可被后续反制，之后该目标继续承受效果", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn");const {game,ui}=makeGame([a,b,c],{response:(request)=>request.type==="counter"&&request.legalCardIds.length>=request.requiredCount});const shockwave=instance("shockwave"),first=instance("counter"),second=instance("counter"),hp=b.hp;a.hand.push(shockwave,second);b.hand.push(first);await game.playCard(a,shockwave,[b]);assert.equal(b.hp,hp-1);assert.equal(b.hand.includes(first),false);assert.equal(a.hand.includes(second),false);assert.ok(ui.logs.some((message)=>message===`${b.name}对${a.name}的「震荡」使用了「反制」，取消了「震荡」对${b.name}的效果。`));assert.ok(ui.logs.some((message)=>message===`${a.name}对${b.name}的「反制」使用了「反制」，取消了「反制」的效果。`));assert.ok(!ui.logs.some((message)=>message.includes("被后续反制抵消"))); });
test("两次反制后原战术牌恢复生效", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human");const order=[];const {game,ui}=makeGame([a,b,c],{response:(request)=>(order.push(request.targetPlayerId),request.legalCardIds.length>=request.requiredCount)});game.state.deck.cards.push(instance("block"),instance("charge"));a.hand.push(instance("harvest"));b.hand.push(instance("counter"));c.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id,a.id,b.id]);assert.equal(a.hand.length,2);assert.equal(b.hand.length,0);assert.equal(c.hand.length,0);assert.equal(ui.logs.filter((message)=>message.includes("使用了「反制」")).length,2);assert.ok(!ui.logs.some((message)=>message.includes("被后续反制抵消"))); });
test("三次反制后原战术牌仍被取消", async () => { const a=makePlayer("a",0,"dawn","human"),b=makePlayer("b",1,"dusk","human"),c=makePlayer("c",2,"dawn","human"),d=makePlayer("d",3,"dusk","human");const order=[];const {game}=makeGame([a,b,c,d],{response:(request)=>(order.push(request.targetPlayerId),request.legalCardIds.length>=request.requiredCount)});game.state.deck.cards.push(instance("block"),instance("charge"));a.hand.push(instance("harvest"));b.hand.push(instance("counter"));c.hand.push(instance("counter"));d.hand.push(instance("counter"));await game.playCard(a,a.hand[0],[]);assert.deepEqual(order,[b.id,c.id,d.id,a.id,b.id,c.id]);assert.equal(a.hand.length,0);assert.equal(b.hand.length,0);assert.equal(c.hand.length,0);assert.equal(d.hand.length,0);assert.equal(game.state.logs.filter((entry)=>entry.message.includes("使用了「反制」")).length,3);assert.ok(game.state.logs.some((entry)=>entry.message.includes("取消了「收获」的效果"))); });

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
test("灵医回春可在救援濒死队友时额外恢复并摸牌", async () => {
  const target=makePlayer("d",0,"dawn","human",1),medic=makePlayer("m",1,"dawn","ai",2),enemy=makePlayer("e",2,"dusk");
  target.hp=-1;medic.hand.push(instance("recover"));const {game}=makeGame([target,medic,enemy]);game.state.deck.cards.push(instance("block"));registerPassiveSkills(game);
  const events=[];game.eventBus.on("beforeHeal","test:rescue-before",(event)=>events.push([event.type,event.isDyingRescue]));game.eventBus.on("afterHeal","test:rescue-after",(event)=>events.push([event.type,event.actualAmount]));
  await game.dyingSystem.enter(target,enemy);
  assert.equal(target.alive,true);assert.equal(target.hp,1);assert.equal(medic.statistics.healingDone,2);assert.equal(medic.hand.length,1);
  assert.deepEqual(events,[["beforeHeal",true],["afterHeal",2]]);assert.equal(medic.turnFlags.rejuvenationUsed,true);
});
test("灵医本人濒死时也能以回春强化自救并摸牌", async () => {
  const medic=makePlayer("self-dying-medic",0,"dawn","ai",2),enemy=makePlayer("self-dying-enemy",1,"dusk");
  medic.hp=-1;medic.hand.push(instance("recover"));const {game}=makeGame([medic,enemy]);game.state.deck.cards.push(instance("charge"));registerPassiveSkills(game);
  await game.dyingSystem.enter(medic,enemy);
  assert.equal(medic.alive,true);assert.equal(medic.hp,1);assert.equal(medic.statistics.healingDone,2);assert.equal(medic.hand.length,1);assert.equal(medic.turnFlags.rejuvenationUsed,true);
});
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
  assert.equal(result.status,"unavailable");assert.equal(result.card,null);assert.ok(enemy.hand.includes(card));assert.equal(game.state.pendingResponses.length,0);
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
  assert.equal(result.status,"cancelled");assert.equal(result.card,null);assert.ok(ally.hand.includes(card));assert.equal(game.cleanupManager.pending.size,0);assert.equal(game.state.pendingResponses.length,0);
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
test("强制救援16：濒死上下文会触发灵医回春额外治疗与摸牌", async () => {
  const human=makePlayer("human",0,"dawn","human"),medic=makePlayer("medic",1,"dawn","ai",2),enemy=makePlayer("enemy",2,"dusk");human.hp=0;medic.hand.push(instance("recover"));
  const {game}=makeGame([human,medic,enemy]);game.state.deck.cards.push(instance("block"));registerPassiveSkills(game);await game.dyingSystem.enter(human,enemy);
  assert.equal(human.hp,2);assert.equal(medic.statistics.healingDone,2);assert.equal(medic.hand.length,1);assert.equal(medic.turnFlags.rejuvenationUsed,true);
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
test("窥隙选择池的已知牌复用正常完整牌面且仍只使用不透明令牌", async () => {
  const viewer=makePlayer("peek-layout-viewer",0,"dawn","human",3),owner=makePlayer("peek-layout-owner",1,"dusk"),known=instance("counter"),unknown=instance("recover"),{game}=makeGame([viewer,owner]);owner.hand.push(known,unknown);game.rememberPrivateCard(viewer,owner,known);const selection=game.cardSelectionSystem.createHiddenSelection(owner),slots=createHiddenSelectionView(viewer,owner,selection),markup=hiddenSelectionMarkup(selection,slots);
  for(const className of ["hand-card","hidden-known-card","card-topline","card-name","card-category","card-art","card-crest","card-rules","card-description","card-flavor"])assert.match(markup,new RegExp(`class="[^"]*${className}`),className);
  assert.match(markup,new RegExp(selection.tokens[0].token));assert.match(markup,/hidden-card-back/);assert.match(markup,new RegExp(known.name));assert.match(markup,new RegExp(known.description.slice(0,8)));assert.doesNotMatch(markup,/data-card-id|data-disabled/);assert.doesNotMatch(markup,new RegExp(known.id));for(const hidden of [unknown.id,unknown.name,unknown.description,unknown.art])assert.doesNotMatch(markup,new RegExp(hidden.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  const css=await readFile(projectFile("css/cards.css"),"utf8");assert.match(css,/\.hidden-known-card\.hand-card\s*\{[^}]*cursor:\s*pointer;/s);assert.doesNotMatch(css,/\.hidden-known-card\s+img|\.hidden-known-card\s+strong/);
});
test("隐藏选择池的已知牌与未知牌同尺寸且全部牌池保持单行横向滚动", async () => {
  const css=await readFile(projectFile("css/cards.css"),"utf8");
  assert.match(css,/\.hidden-card-grid,\s*\.private-card-grid,\s*\.tableau-cards\s*\{[^}]*flex-wrap:\s*nowrap[^}]*justify-content:\s*safe center[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s);
  assert.match(css,/\.hidden-card-back\.is-compact\s*\{[^}]*width:\s*124px[^}]*height:\s*174px/s);
  assert.match(css,/\.hidden-card-grid\s+\.hidden-known-card\.hand-card\s*\{[^}]*flex:\s*0\s+0\s+124px[^}]*width:\s*124px[^}]*height:\s*174px/s);
  assert.match(css,/\.hidden-card-grid\s+\.hidden-known-card\s*>\s*\.card-art\s*\{[^}]*block-size:\s*70px\s*!important/s);
});
test("掠夺选择池的公开装备复用正常牌面图标与说明", async () => {
  const actor=makePlayer("plunder-pool-actor",0,"dawn","human"),owner=makePlayer("plunder-pool-owner",1,"dusk"),equipment=instance("defenseDevice"),{game}=makeGame([actor,owner]);owner.equipment=equipment;const panel=makeInteractiveElement(),controller=new InteractionController({game,elements:{response_panel:panel},render(){}});let receivedSelection=null,receivedOptions=null;controller.requestHiddenCards=async (selection,_count,_prompt,options)=>{receivedSelection=selection;receivedOptions=options;return ["public-equipment"];};const result=await controller.requestZoneCard(game,actor,owner,"掠夺：选择1张手牌或装备牌"),markup=hiddenSelectionMarkup({tokens:[]},receivedOptions.slots);
  assert.deepEqual(result,{zone:"equipment",equipmentCardId:equipment.id,selectionId:receivedSelection.selectionId});for(const className of ["hand-card","hidden-known-card","frame-machine","card-topline","card-name","card-category","card-art","card-crest","card-rules","card-description","card-flavor"])assert.match(markup,new RegExp(className));assert.equal((markup.match(/<img\b/g)??[]).length,2);assert.match(markup,new RegExp(equipment.name));assert.match(markup,new RegExp(equipment.categoryName));assert.match(markup,new RegExp(equipment.description));assert.doesNotMatch(markup,/data-card-id/);assert.doesNotMatch(markup,new RegExp(equipment.id));
});
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
test("八名角色使用结构化被动触发条件与限制文案", async () => { const expected={"blade-walker":"每回合按不同卡牌类别分别触发","oath-warden":"每轮限触发1次","spirit-medic":"每回合限触发1次","shade-agent":"每回合限触发1次","ember-magus":"每次卡牌结算最多触发1次","trail-hunter":"每回合限触发2次；同一敌人每回合限1次","fate-gambler":"每回合限触发1次","resonance-tuner":"每回合限触发1次"};for(const [index,general] of GENERAL_DEFINITIONS.entries()){assert.ok(general.passiveTriggerText);assert.equal(general.passiveLimitText,expected[general.id]);const player=makePlayer(`structured-${general.id}`,index,"dawn","human",index),markup=skillDetailsTemplate(player);assert.match(markup,new RegExp(general.passiveTriggerText));assert.match(markup,new RegExp(general.passiveLimitText));}const source=await readFile(projectFile("js/ui/templates.js"),"utf8");assert.doesNotMatch(source,/description\.includes\(|每轮一次.*includes|每回合首次.*includes/); });
test("目标选择期间技能入口优先且查看后保留原选择状态", () => { const source=makePlayer("source",0,"dawn","human"),target=makePlayer("target",1,"dusk"),illegal=makePlayer("illegal",2,"dawn");let resolved=null,shown=null,triggerUsed=null,rendered=0;const targetState={players:[target],legalIds:new Set([target.id]),resolve:(value)=>{resolved=value;}};const fake={game:{state:{players:[source,target,illegal]}},targetState,showSkillDetails:(value,trigger)=>{shown=value;triggerUsed=trigger;},render:()=>{rendered+=1;},playSound(){}};const panelFor=(player)=>({dataset:{playerId:player.id}}),skillFor=(player)=>({dataset:{skillPlayerId:player.id}}),eventFor=(player,kind)=>({target:{closest:(query)=>query==="[data-skill-player-id]"&&kind==="skill"?skillFor(player):query==="[data-player-id]"?panelFor(player):null}});UIManager.prototype.handlePlayerClick.call(fake,eventFor(target,"skill"));assert.equal(shown,target);assert.equal(triggerUsed.dataset.skillPlayerId,target.id);assert.equal(fake.targetState,targetState);assert.equal(resolved,null);shown=null;UIManager.prototype.handlePlayerClick.call(fake,eventFor(illegal,"skill"));assert.equal(shown,illegal);assert.equal(fake.targetState,targetState);shown=null;UIManager.prototype.handlePlayerClick.call(fake,eventFor(illegal,"panel"));assert.equal(resolved,null);assert.equal(fake.targetState,targetState);UIManager.prototype.handlePlayerClick.call(fake,eventFor(target,"panel"));assert.equal(resolved,target);assert.equal(fake.targetState,null);assert.equal(rendered,1); });
test("关闭技能弹窗后焦点返回原生触发按钮", () => { let focused=0;const overlay={innerHTML:"dialog",classList:{add(){}}},trigger={isConnected:true,focus(){focused+=1;}};const fake={elements:{skill_details_overlay:overlay},skillDetailsTrigger:trigger};UIManager.prototype.hideSkillDetails.call(fake);assert.equal(overlay.innerHTML,"");assert.equal(fake.skillDetailsTrigger,null);assert.equal(focused,1); });
test("互利必须先选择再确认且可直接切换选择", async () => { const element=makeInteractiveElement(),view=new PublicPoolView(element),player=makePlayer("human",0,"dawn","human"),first=instance("assault"),second=instance("block");let settled=false;const pending=view.request(player,[first,second]).then((card)=>{settled=true;return card;});assert.match(element.innerHTML,/data-public-confirm disabled/);element.click(clickTarget("[data-public-card-id]",{publicCardId:first.id}));await Promise.resolve();assert.equal(settled,false);assert.equal(view.pending.selected.has(first.id),true);assert.doesNotMatch(element.innerHTML,/data-public-confirm disabled/);element.click(clickTarget("[data-public-card-id]",{publicCardId:second.id}));assert.deepEqual([...view.pending.selected],[second.id]);assert.equal(settled,false);element.click(clickTarget("[data-public-confirm]"));assert.equal(await pending,second);assert.equal(view.pending,null); });
test("互利公开牌池也复用正常完整牌面", async () => { const element=makeInteractiveElement(),view=new PublicPoolView(element),card=instance("mutualBenefit");view.show([card],{interactive:true});for(const className of ["hand-card","tableau-card","frame-ward","card-topline","card-name","card-category","card-art","card-crest","card-rules","card-description","card-flavor"])assert.match(element.innerHTML,new RegExp(className));assert.equal((element.innerHTML.match(/<img\b/g)??[]).length,2);assert.match(element.innerHTML,new RegExp(card.description));assert.match(element.innerHTML,/data-public-card-id/);const css=await readFile(projectFile("css/cards.css"),"utf8");assert.match(css,/\.tableau-card\.hand-card\s*\{[^}]*cursor:\s*pointer;/s);assert.doesNotMatch(css,/\.tableau-card\s*>\s*img|\.tableau-card\s+strong|\.tableau-card\s+small/); });
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
test("AI滋荣会生成自疗目标并模拟治疗队友时同步自疗", () => {
  const medic=makePlayer("ai-medic",0,"dawn","ai",2),ally=makePlayer("ai-medic-ally",1,"dawn"),enemy=makePlayer("ai-medic-enemy",2,"dusk");
  medic.hp=1;ally.hp=1;medic.energy=4;const {game}=makeGame([medic,ally,enemy]);const visible=createAiVisibleState(medic.id,game.state),generator=game.aiController.actionGenerator;
  const actions=generator.generateFromVisible(visible,medic.id).filter((action)=>action.type==="skill"&&action.skill.id==="symbiosis");
  assert.deepEqual(actions.map((action)=>action.targets[0].id),[medic.id,ally.id]);
  const allyAction=actions.find((action)=>action.targets[0].id===ally.id),afterAlly=new AiSimulator(visible).apply(visible,allyAction,medic.id),simMedic=afterAlly.players.find((player)=>player.id===medic.id),simAlly=afterAlly.players.find((player)=>player.id===ally.id);
  assert.equal(simAlly.hp,3);assert.equal(simMedic.hp,2);assert.equal(simMedic.handCount,1);assert.equal(simMedic.rejuvenationUsed,true);
  const selfAction=generator.generateFromVisible(afterAlly,medic.id).find((action)=>action.type==="skill"&&action.skill.id==="symbiosis"&&action.targets[0].id===medic.id);
  const afterSelf=new AiSimulator(afterAlly).apply(afterAlly,selfAction,medic.id),simMedicAgain=afterSelf.players.find((player)=>player.id===medic.id);
  assert.equal(simMedicAgain.hp,3);assert.equal(simMedicAgain.handCount,1);assert.equal(simMedicAgain.activeSkillUses,2);
});
test("AI模拟中的灵医回春也能让一张濒死调息恢复2点并摸牌", () => {
  const state={playPhaseEnded:false,players:[
    {id:"attacker",seatIndex:0,generalId:"blade-walker",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,hand:[{id:"assault",definitionId:"assault"}],attackUsed:0,attackLimit:2,exposeWeaknessStacks:1,assaultBonus:0},
    {id:"target",seatIndex:1,generalId:"oath-warden",battleTeam:"dawn",alive:true,hp:1,maxHp:3,shield:0,handCount:0,expectedRecoverCount:0,blockProbability:0,twoBlockProbability:0},
    {id:"medic",seatIndex:2,generalId:"spirit-medic",battleTeam:"dawn",alive:true,hp:3,maxHp:3,shield:0,handCount:1,expectedRecoverCount:1,rejuvenationUsed:false}
  ]};
  const action={type:"card",card:{...CARD_DEFINITIONS.assault,id:"assault"},targets:[state.players[1]]},next=new AiSimulator(state).apply(state,action,"attacker"),target=next.players[1],medic=next.players[2];
  assert.equal(target.alive,true);assert.equal(target.hp,1);assert.equal(medic.expectedRecoverCount,0);assert.equal(medic.handCount,1);assert.equal(medic.rejuvenationUsed,true);
});
test("AI壁垒只增加统一护盾且快照不包含专属护盾字段", () => { const warden=makePlayer("warden",0,"dawn","ai",1),ally=makePlayer("ally",1,"dawn"),enemy=makePlayer("enemy",2,"dusk");warden.energy=2;ally.shield=2;const {game}=makeGame([warden,ally,enemy]),visible=createAiVisibleState(warden.id,game.state);assert.ok(visible.players.every((player)=>!("temporaryShieldAmount" in player)));const next=new AiSimulator(visible).apply(visible,{type:"skill",skill:{id:"barrier",cost:2,limitPerTurn:2},targets:[{id:ally.id}]},warden.id),nextAlly=next.players.find((player)=>player.id===ally.id);assert.equal(nextAlly.shield,3);assert.equal("temporaryShieldAmount" in nextAlly,false); });
test("AI 对未知调息只按公开手牌数估算而不读取真实牌面", () => { const ai=makePlayer("ai",0,"dawn"),other=makePlayer("other",1,"dusk");const {game}=makeGame([ai,other]);other.hand=[instance("recover")];const first=createAiVisibleState(ai.id,game.state).players[1].expectedRecoverCount;other.hand=[instance("assault")];const second=createAiVisibleState(ai.id,game.state).players[1].expectedRecoverCount;assert.equal(first,second); });
test("AI 模拟器只接收过滤快照并可独立克隆推演", () => { const visible={players:[{id:"a",battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,alive:true,handCount:1,hand:[{id:"x",definitionId:"assault"}]},{id:"b",battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,alive:true,handCount:2}]};const simulator=new AiSimulator(visible);const next=simulator.apply(visible,{type:"card",card:{id:"x",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(next.players[1].hp,3);assert.equal(visible.players[1].hp,4);assert.equal("game" in simulator,false); });
test("AI 动作生成使用同一距离合法性", () => { const ps=[makePlayer("a",0,"dawn"),makePlayer("b",1,"dusk"),makePlayer("c",2,"dusk"),makePlayer("d",3,"dawn"),makePlayer("e",4,"dusk")];const {game}=makeGame(ps);ps[0].hand.push(instance("assault"));const targets=game.aiController.getLegalActions(ps[0]).filter((a)=>a.card?.definitionId==="assault").map((a)=>a.targets[0].id);assert.deepEqual(targets,["b","e"]); });
test("AI 可见动作与模拟器支持装备掠夺进入手牌且不读取隐藏手牌", () => { const actor=makePlayer("actor",0,"dawn"),near=makePlayer("near",1,"dawn"),target=makePlayer("target",2,"dusk"),other=makePlayer("other",3,"dusk"),tail=makePlayer("tail",4,"dawn"),plunder=instance("plunder");actor.hand.push(plunder);actor.equipment=instance("battleDevice");target.equipment=instance("energyDevice");const {game}=makeGame([actor,near,target,other,tail]),visible=createAiVisibleState(actor.id,game.state),actions=game.aiController.actionGenerator.generateFromVisible(visible,actor.id);const action=actions.find((entry)=>entry.card?.id===plunder.id&&entry.targets[0]?.id===target.id);assert.ok(action);assert.equal(visible.players[2].hand,undefined);const next=new AiSimulator(visible).apply(visible,action,actor.id);assert.equal(next.players[2].equipmentDefinitionId,null);assert.equal(next.players[0].equipmentDefinitionId,"battleDevice");assert.equal(next.players[0].handCount,1); });
test("AI 束搜索实际达到多层、记录展开节点并采样10个隐藏世界", async () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);a.hand.push(instance("charge"),instance("exposeWeakness"),instance("assault"));const action=await game.aiController.selectAction(a,{gameId:game.state.gameId});assert.ok(["card","skill","end"].includes(action.type));assert.ok(game.aiController.planner.lastSearchStats.expanded>3);assert.ok(game.aiController.planner.lastSearchStats.depth>=2);assert.equal(game.aiController.planner.lastSearchStats.hiddenSamples,10); });
test("AI 刃行者模拟按不同类别积累连势且命中的突袭消耗连势", () => {
  const blade=makePlayer("sim-blade",0,"dawn","ai",0),enemy=makePlayer("sim-blade-enemy",1,"dusk"),charge=instance("charge"),harvest=instance("harvest"),assault=instance("assault");
  blade.hand.push(charge,harvest,assault);
  const {game}=makeGame([blade,enemy]),visible=createAiVisibleState(blade.id,game.state),simulator=new AiSimulator(visible);
  const charged=simulator.apply(visible,{type:"card",card:charge,targets:[]},blade.id);
  const harvested=simulator.apply(charged,{type:"card",card:harvest,targets:[]},blade.id);
  const attacked=simulator.apply(harvested,{type:"card",card:assault,targets:[{id:enemy.id}]},blade.id);
  assert.deepEqual(charged.players[0].categoriesUsed,["basic"]);assert.equal(charged.players[0].momentum,1);
  assert.deepEqual(harvested.players[0].categoriesUsed,["basic","tactic"]);assert.equal(harvested.players[0].momentum,GAME_CONFIG.momentumMaxStacks);
  assert.equal(attacked.players[1].hp,enemy.maxHp-3);assert.equal(attacked.players[0].momentum,0);
});
test("AI 刃行者突袭被格挡或被护盾完全吸收时不消耗连势", () => {
  const state={players:[
    {id:"blade",seatIndex:0,generalId:"blade-walker",battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,momentum:2,categoriesUsed:["basic","tactic"],expectedRecoverCount:0},
    {id:"target",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,alive:true,handCount:1,blockProbability:1,twoBlockProbability:0,expectedRecoverCount:0}
  ]};
  const blocked=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"hit"},targets:[{id:"target"}]},"blade");
  assert.equal(blocked.players[1].hp,4);assert.equal(blocked.players[0].momentum,2);
  const shieldedState=structuredClone(state);shieldedState.players[1].blockProbability=0;shieldedState.players[1].shield=3;
  const shielded=new AiSimulator(shieldedState).apply(shieldedState,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"hit"},targets:[{id:"target"}]},"blade");
  assert.equal(shielded.players[1].hp,4);assert.equal(shielded.players[1].shield,0);assert.equal(shielded.players[0].momentum,2);
});
test("AI 刃行者突袭部分命中时按生命伤害概率消耗连势", () => {
  const state={players:[
    {id:"blade",seatIndex:0,generalId:"blade-walker",battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,momentum:2,categoriesUsed:["basic","tactic"],expectedRecoverCount:0},
    {id:"target",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,alive:true,handCount:1,blockProbability:.5,twoBlockProbability:0,expectedRecoverCount:0}
  ]};
  const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"hit"},targets:[{id:"target"}]},"blade");
  assert.equal(next.players[1].hp,2.5);assert.equal(next.players[0].momentum,1);
  const shieldedState=structuredClone(state);shieldedState.players[1].shield=2;
  const shielded=new AiSimulator(shieldedState).apply(shieldedState,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"hit"},targets:[{id:"target"}]},"blade");
  assert.equal(shielded.players[1].hp,3.5);assert.equal(shielded.players[0].momentum,1);
});
test("AI 刃行者首次使用基础牌的连势按突袭命中分支计算期望", () => {
  const state={players:[
    {id:"blade",seatIndex:0,generalId:"blade-walker",battleTeam:"dawn",hp:4,maxHp:4,shield:0,alive:true,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,momentum:2,categoriesUsed:["tactic"],expectedRecoverCount:0},
    {id:"target",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,alive:true,handCount:1,blockProbability:.5,twoBlockProbability:0,expectedRecoverCount:0}
  ]};
  const action={type:"card",card:{...CARD_DEFINITIONS.assault,id:"hit"},targets:[{id:"target"}]};
  const partial=new AiSimulator(state).apply(state,action,"blade");
  assert.equal(partial.players[0].momentum,1.5);assert.deepEqual(partial.players[0].categoriesUsed,["tactic","basic"]);
  const hitState=structuredClone(state);hitState.players[1].blockProbability=0;
  assert.equal(new AiSimulator(hitState).apply(hitState,action,"blade").players[0].momentum,1);
  const missState=structuredClone(state);missState.players[1].blockProbability=1;
  assert.equal(new AiSimulator(missState).apply(missState,action,"blade").players[0].momentum,2);
});
test("AI 固定节点预算达到上限后返回当前最佳动作且不再按时间截断", async () => {
  const actor=makePlayer("node-budget-actor",0,"dawn"),enemy=makePlayer("node-budget-enemy",1,"dusk");actor.hand.push(instance("charge"),instance("exposeWeakness"),instance("assault"));
  const {game}=makeGame([actor,enemy]);game.aiSearchNodeBudgetOverride=5;game.aiSearchBudgetOverrideMs=0;
  const action=await game.aiController.selectAction(actor,{gameId:game.state.gameId});
  assert.ok(["card","skill","end"].includes(action.type));assert.equal(game.aiController.planner.lastSearchStats.expanded,5);assert.equal(game.aiController.planner.lastSearchStats.budgetType,"nodes");assert.equal(game.aiController.planner.lastSearchStats.nodeBudget,5);
});
test("AI 固定节点预算截止时保留上一层已发现的全局最佳候选", async () => {
  const actor=makePlayer("node-best-actor",0,"dawn"),enemy=makePlayer("node-best-enemy",1,"dusk"),best=instance("charge"),lower=instance("harvest");
  actor.hand.push(best,lower);
  const {game}=makeGame([actor,enemy]);
  const visible=createAiVisibleState(actor.id,game.state),planner=game.aiController.planner;
  game.aiSearchNodeBudgetOverride=3;game.aiRandomnessRange=0;
  planner.evaluator={
    actionUtility:(action)=>action.card?.id===best.id?10:action.card?.id===lower.id?5:-20,
    stateUtility:()=>0
  };
  game.aiController.actionGenerator.generateFromVisible=(state)=>state.players.find((player)=>player.id===actor.id).hand?.some((card)=>card.id===best.id)?[{type:"end"}]:[];
  const action=await planner.plan(actor,visible,[{type:"card",card:best,targets:[]},{type:"card",card:lower,targets:[]}],{gameId:game.state.gameId});
  assert.equal(action.card.id,best.id);assert.equal(planner.lastSearchStats.expanded,3);
});
test("AI 根节点束裁剪会计入模拟后的局面效用", async () => {
  const actor=makePlayer("root-state-actor",0,"dawn"),enemy=makePlayer("root-state-enemy",1,"dusk"),charge=instance("charge"),assault=instance("assault");actor.hand.push(charge,assault);const {game}=makeGame([actor,enemy]),visible=createAiVisibleState(actor.id,game.state),planner=game.aiController.planner;game.aiSearchNodeBudgetOverride=2;game.aiRandomnessRange=0;let stateCalls=0;planner.evaluator={actionUtility:()=>0,stateUtility:(state)=>{stateCalls+=1;return state.players.find((player)=>player.id===enemy.id).hp<enemy.hp?100:0;}};const action=await planner.plan(actor,visible,[{type:"card",card:charge,targets:[]},{type:"card",card:assault,targets:[{id:enemy.id}]}],{gameId:game.state.gameId});assert.equal(action.card.id,assault.id);assert.equal(stateCalls,2);
});
test("AI 根动作生成受搜索预算约束，不会长期锁住观察战场界面", async () => {
  const actor=makePlayer("root-budget-actor",0,"dawn"),enemy=makePlayer("root-budget-enemy",1,"dusk"),card=instance("charge");actor.hand.push(card);const {game}=makeGame([actor,enemy]),visible=createAiVisibleState(actor.id,game.state),planner=game.aiController.planner;game.aiSearchBudgetOverrideMs=0;game.aiRandomnessRange=0;let evaluated=0;planner.evaluator={actionUtility:()=>0,stateUtility:()=>{evaluated+=1;return 0;}};const roots=Array.from({length:200},(_,index)=>({type:"card",card:{...card,id:`root-${index}`},targets:[]}));const action=await planner.plan(actor,visible,roots,{gameId:game.state.gameId});assert.equal(action.type,"card");assert.equal(evaluated,1);assert.equal(planner.lastSearchStats.expanded,1);
});
test("AI 规划异常会安全结束出牌并清理观察状态", async () => {
  const ai=makePlayer("planner-fallback-ai",0,"dawn"),enemy=makePlayer("planner-fallback-enemy",1,"dusk"),{game,ui}=makeGame([ai,enemy]);game.state.currentPlayerIndex=0;game.state.phase="play";game.cleanupManager.delay=async()=>true;game.aiController.getLegalActions=()=>[];game.aiController.selectAction=async()=>{throw new Error("planner test failure");};await game.takeAiPlayPhase(ai,game.state.gameId);assert.equal(ui.thinking.at(-1)[0],false);assert.match(ui.logs.join("\n"),/^(?!.*planner test failure)/s);
});
test("手牌实体已离开时 moveHandToResolving 返回失败而不抛异常", async () => {
  const ai=makePlayer("missing-move-ai",0,"dawn"),enemy=makePlayer("missing-move-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([ai,enemy]);assert.equal(await game.moveHandToResolving(ai,card),false);assert.equal(game.state.resolvingCards.length,0);assert.equal(game.state.discardPile.length,0);
});
test("beforeCardMove 取消出牌时保持手牌且不产生出牌统计或事件", async () => {
  const ai=makePlayer("cancel-move-ai",0,"dawn"),enemy=makePlayer("cancel-move-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([ai,enemy]);ai.hand.push(card);let used=0;game.eventBus.on("beforeCardMove","test:cancel-ai-card-move",(event)=>{if(event.card===card)event.cancelled=true;});game.eventBus.on("cardUsed","test:no-card-used-after-cancel",()=>{used+=1;});assert.equal(await game.playCard(ai,card,[]),false);assert.deepEqual(ai.hand,[card]);assert.equal(game.state.resolvingCards.length,0);assert.equal(game.state.discardPile.length,0);assert.equal(ai.statistics.cardsPlayed,0);assert.equal(used,0);assert.equal(game.actionLocked,false);
});
test("beforeCardMove 取消 AI 动作后游戏循环仍推进至下一角色", async () => {
  const ai=makePlayer("cancel-loop-ai",0,"dawn"),next=makePlayer("cancel-loop-next",1,"dusk"),card=instance("charge"),{game}=makeGame([ai,next]);ai.hand.push(card);game.aiController.getLegalActions=()=>[];game.aiController.selectAction=async()=>({type:"card",card,targets:[]});game.eventBus.on("beforeCardMove","test:cancel-loop-card",(event)=>{if(event.card===card)event.cancelled=true;});let nextStarted=false;game.eventBus.on("turnStart","test:cancel-loop-next-turn",(event)=>{if(event.player===next){nextStarted=true;game.state.isGameOver=true;}});game.loopPromise=game.runGameLoop();await assert.doesNotReject(game.loopPromise);assert.equal(nextStarted,true);assert.deepEqual(ai.hand,[card]);assert.equal(game.state.resolvingCards.length,0);assert.equal(game.actionLocked,false);
});
test("beginResolve 失败时 playCard 不移除手牌或产生悬空牌", async () => {
  const ai=makePlayer("begin-resolve-ai",0,"dawn"),enemy=makePlayer("begin-resolve-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([ai,enemy]);ai.hand.push(card);game.state.deck.beginResolve=()=>false;assert.equal(await game.playCard(ai,card,[]),false);assert.deepEqual(ai.hand,[card]);assert.equal(game.state.resolvingCards.length,0);assert.equal(game.state.discardPile.length,0);assert.equal(ai.statistics.cardsPlayed,0);assert.equal(game.actionLocked,false);
});
test("beforeCardUse 抛异常后实体牌离开结算区并只进入一次弃牌堆", async () => {
  const source=makePlayer("before-use-source",0,"dawn"),enemy=makePlayer("before-use-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([source,enemy]);source.hand.push(card);
  game.eventBus.on("beforeCardUse","test:throw-before-use",(event)=>{if(event.card===card)throw new Error("private beforeCardUse failure");});
  await assert.rejects(game.playCard(source,card,[]),/private beforeCardUse failure/);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);assert.doesNotMatch(game.state.logs.map((entry)=>entry.message).join("\n"),/private beforeCardUse failure/);
});
test("targetSelected 抛异常后不会留下悬空牌", async () => {
  const source=makePlayer("target-hook-source",0,"dawn"),enemy=makePlayer("target-hook-enemy",1,"dusk"),card=instance("assault"),{game}=makeGame([source,enemy]);source.hand.push(card);
  game.eventBus.on("targetSelected","test:throw-target-selected",(event)=>{if(event.card===card)throw new Error("target hook failed");});
  await assert.rejects(game.playCard(source,card,[enemy]),/target hook failed/);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);
});
test("beforeCardResolve 抛异常后不会留下悬空牌", async () => {
  const source=makePlayer("resolve-hook-source",0,"dawn"),enemy=makePlayer("resolve-hook-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([source,enemy]);source.hand.push(card);
  game.eventBus.on("beforeCardResolve","test:throw-before-resolve",(event)=>{if(event.card===card)throw new Error("resolve hook failed");});
  await assert.rejects(game.playCard(source,card,[]),/resolve hook failed/);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);
});
test("反制流程抛异常后主动牌安全进入弃牌堆", async () => {
  const source=makePlayer("counter-failure-source",0,"dawn"),enemy=makePlayer("counter-failure-enemy",1,"dusk"),card=instance("harvest"),{game}=makeGame([source,enemy]);source.hand.push(card);game.responseSystem.askForCounter=async()=>{throw new Error("counter flow failed");};
  await assert.rejects(game.playCard(source,card,[]),/counter flow failed/);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);
});
test("卡牌效果部分生效后抛异常不回滚效果但会清理实体牌", async () => {
  const source=makePlayer("partial-effect-source",0,"dawn"),enemy=makePlayer("partial-effect-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([source,enemy]);source.energy=0;source.hand.push(card);
  game.eventBus.on("afterGainEnergy","test:throw-after-partial-effect",(event)=>{if(event.card===card)throw new Error("effect failed after mutation");});
  await assert.rejects(game.playCard(source,card,[]),/effect failed after mutation/);assert.equal(source.energy,1);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);
});
test("cardUsed 监听器抛异常后不重复弃牌且不重复触发事件", async () => {
  const source=makePlayer("card-used-source",0,"dawn"),enemy=makePlayer("card-used-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([source,enemy]);source.hand.push(card);let calls=0;
  game.eventBus.on("cardUsed","test:throw-card-used",(event)=>{if(event.card===card){calls+=1;throw new Error("cardUsed failed");}});
  await assert.rejects(game.playCard(source,card,[]),/cardUsed failed/);assert.equal(calls,1);assertCardOnlyIn(game,card,"discard");assert.equal(game.state.deck.discardPile.filter((entry)=>entry===card).length,1);assert.equal(source.statistics.cardsPlayed,0);
});
test("finishResolvingToDiscard 虚假成功时 playCard 检测真实区域并执行失败清理", async () => {
  const source=makePlayer("finish-failure-source",0,"dawn"),enemy=makePlayer("finish-failure-enemy",1,"dusk"),card=instance("charge"),{game}=makeGame([source,enemy]);source.hand.push(card);game.finishResolvingToDiscard=async()=>true;
  await assert.rejects(game.playCard(source,card,[]),/结算牌未能进入弃牌堆/);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);
});
test("equipCard 虚假成功但牌仍在结算区时由调用方拒绝并清理", async () => {
  const source=makePlayer("equip-result-source",0,"dawn"),enemy=makePlayer("equip-result-enemy",1,"dusk"),card=instance("energyDevice"),{game}=makeGame([source,enemy]);source.hand.push(card);game.equipCard=async()=>true;
  await assert.rejects(game.playCard(source,card,[]),/装备牌未能进入装备区/);assert.equal(source.equipment,null);assertCardOnlyIn(game,card,"discard");assert.equal(source.statistics.cardsPlayed,0);
});
test("装备替换预检取消或抛异常时旧装备保持原位且新装备进入弃牌堆", async () => {
  for(const mode of ["cancel","throw"]){const source=makePlayer(`replace-${mode}-source`,0,"dawn"),enemy=makePlayer(`replace-${mode}-enemy`,1,"dusk"),old=instance("energyDevice"),next=instance("battleDevice"),{game}=makeGame([source,enemy]);source.equipment=old;source.hand.push(next);
    game.eventBus.on("beforeCardMove",`test:replace-preflight-${mode}`,(event)=>{if(event.card!==old||event.from!=="equipment")return;if(mode==="cancel")event.cancelled=true;else throw new Error("replacement preflight failed");});
    await assert.rejects(game.playCard(source,next,[]),mode==="cancel"?/装备牌未能进入装备区/:/replacement preflight failed/);assert.equal(source.equipment,old);assertCardOnlyIn(game,old,`equipment:${source.id}`);assertCardOnlyIn(game,next,"discard");assert.equal(source.statistics.cardsPlayed,0);
  }
});
test("装备替换成功后旧装备只在弃牌堆且新装备只在装备区", async () => {
  const source=makePlayer("atomic-equip-source",0,"dawn"),enemy=makePlayer("atomic-equip-enemy",1,"dusk"),old=instance("energyDevice"),next=instance("battleDevice"),{game}=makeGame([source,enemy]);source.equipment=old;source.hand.push(next);
  assert.equal(await game.playCard(source,next,[]),true);assert.equal(source.equipment,next);assertCardOnlyIn(game,old,"discard");assertCardOnlyIn(game,next,`equipment:${source.id}`);assert.equal(game.resolutionOwners.size,0);
});
test("借势内嵌突袭异常只失败清理突袭牌且外层借势正常收束", async () => {
  const actor=makePlayer("nested-actor",0,"dawn","human"),first=makePlayer("nested-first",1,"dusk","human"),equipment=instance("energyDevice"),assault=instance("assault"),leverage=instance("leverage");actor.hand.push(leverage);first.hand.push(assault);first.equipment=equipment;
  const {game}=makeGame([actor,first],{response:(request)=>request.type==="leverageAssault"});let outerUsed=0,innerUsed=0;
  game.eventBus.on("beforeCardResolve","test:throw-nested-assault",(event)=>{if(event.card===assault)throw new Error("nested assault failed");});game.eventBus.on("cardUsed","test:count-nested-resolutions",(event)=>{if(event.card===leverage)outerUsed+=1;if(event.card===assault)innerUsed+=1;});
  assert.equal(await game.playCard(actor,leverage,[],{firstTargetId:first.id,equipmentCardId:equipment.id,secondTargetId:actor.id}),true);assert.equal(outerUsed,1);assert.equal(innerUsed,0);assertCardOnlyIn(game,assault,"discard");assertCardOnlyIn(game,leverage,"discard");assertCardOnlyIn(game,equipment,`hand:${actor.id}`);assert.equal(game.resolutionOwners.size,0);assert.equal(game.actionLocked,false);
});
test("结算异常后 actionLocked、interactionLocked 与 AI thinking 全部恢复", async () => {
  const source=makePlayer("lock-restore-source",0,"dawn"),enemy=makePlayer("lock-restore-enemy",1,"dusk"),card=instance("charge"),{game,ui}=makeGame([source,enemy]);source.hand.push(card);game.interactionLocked=true;ui.thinkingPlayerId=source.id;ui.setThinking(true,source,"测试异常恢复");
  game.eventBus.on("beforeCardUse","test:throw-for-lock-restore",(event)=>{if(event.card===card)throw new Error("restore locks");});await assert.rejects(game.playCard(source,card,[]),/restore locks/);assert.equal(game.actionLocked,false);assert.equal(game.interactionLocked,false);assert.equal(ui.thinking.at(-1)[0],false);assertCardOnlyIn(game,card,"discard");
});
test("实体牌结算异常后游戏循环仍推进到下一角色", async () => {
  const source=makePlayer("resolution-loop-source",0,"dawn"),next=makePlayer("resolution-loop-next",1,"dusk"),card=instance("charge"),{game,ui}=makeGame([source,next]);source.hand.push(card);game.aiController.getLegalActions=()=>[];game.aiController.selectAction=async()=>({type:"card",card,targets:[]});game.eventBus.on("afterGainEnergy","test:throw-loop-partial",(event)=>{if(event.card===card)throw new Error("loop resolution failed");});let nextStarted=false;game.eventBus.on("turnStart","test:next-after-resolution-failure",(event)=>{if(event.player===next){nextStarted=true;game.state.isGameOver=true;}});
  game.loopPromise=game.runGameLoop();await assert.doesNotReject(game.loopPromise);assert.equal(nextStarted,true);assertCardOnlyIn(game,card,"discard");assert.equal(game.actionLocked,false);assert.equal(game.interactionLocked,false);assert.equal(ui.thinking.at(-1)[0],false);
});
test("AI 陈旧手牌动作返回失败后安全结束阶段并清除锁与思考状态", async () => {
  const ai=makePlayer("stale-action-ai",0,"dawn"),enemy=makePlayer("stale-action-enemy",1,"dusk"),staleCard=instance("charge"),{game,ui}=makeGame([ai,enemy]);let selections=0;game.aiController.getLegalActions=()=>[];game.aiController.selectAction=async()=>{selections+=1;return {type:"card",card:staleCard,targets:[]};};await game.takeAiPlayPhase(ai,game.state.gameId);assert.equal(selections,1);assert.equal(game.actionLocked,false);assert.equal(game.interactionLocked,false);assert.equal(ui.thinking.at(-1)[0],false);assert.equal(game.state.resolvingCards.length,0);
});
test("AI 真实出牌异常不会拒绝 loopPromise 且下一名存活角色仍开始回合", async () => {
  const ai=makePlayer("throw-card-ai",0,"dawn"),next=makePlayer("throw-card-next",1,"dusk"),card=instance("charge"),{game,ui}=makeGame([ai,next]);ai.hand.push(card);game.aiController.getLegalActions=()=>[];game.aiController.selectAction=async()=>({type:"card",card,targets:[]});game.eventBus.on("beforeCardMove","test:throw-real-card-error",(event)=>{if(event.card===card)throw new Error("ai card execution exploded");});let nextStarted=false;game.eventBus.on("turnStart","test:observe-next-turn",(event)=>{if(event.player===next){nextStarted=true;game.state.isGameOver=true;}});game.loopPromise=game.runGameLoop();await assert.doesNotReject(game.loopPromise);assert.equal(nextStarted,true);assert.equal(game.actionLocked,false);assert.equal(game.interactionLocked,false);assert.equal(ui.thinking.at(-1)[0],false);assert.doesNotMatch(ui.logs.join("\n"),/ai card execution exploded/);assert.doesNotMatch(game.state.logs.map((entry)=>entry.message).join("\n"),/ai card execution exploded/);
});
test("AI 主动技能执行异常由出牌阶段捕获并恢复全部锁状态", async () => {
  const ai=makePlayer("throw-skill-ai",0,"dawn","ai",1),ally=makePlayer("throw-skill-ally",1,"dawn"),enemy=makePlayer("throw-skill-enemy",2,"dusk"),{game,ui}=makeGame([ai,ally,enemy]);ai.energy=4;game.aiController.getLegalActions=()=>[];game.aiController.selectAction=async()=>({type:"skill",skill:ACTIVE_SKILLS.barrier,targets:[ally]});ui.setCurrentCard=()=>{throw new Error("ai skill execution exploded");};await game.takeAiPlayPhase(ai,game.state.gameId);assert.equal(game.actionLocked,false);assert.equal(game.interactionLocked,false);assert.equal(ui.thinking.at(-1)[0],false);assert.doesNotMatch(ui.logs.join("\n"),/ai skill execution exploded/);
});
test("游戏循环连续回合异常有上限并以 resolved 状态安全停止", async () => {
  const first=makePlayer("loop-guard-first",0,"dawn"),second=makePlayer("loop-guard-second",1,"dusk"),{game,ui}=makeGame([first,second]),attempts=[];game.takeTurn=async(player)=>{attempts.push(player.id);throw new Error(`turn failure ${player.id}`);};game.loopPromise=game.runGameLoop();await assert.doesNotReject(game.loopPromise);assert.deepEqual(attempts,[first.id,second.id,first.id]);assert.equal(game.actionLocked,false);assert.equal(game.interactionLocked,false);assert.equal(ui.thinking.at(-1)[0],false);assert.doesNotMatch(ui.logs.join("\n"),/turn failure/);
});
test("AI 借势动作粗评分不重复计算后继状态中的伤害与装备收益", () => {
  const actor=makePlayer("leverage-score-actor",0,"dawn"),first=makePlayer("leverage-score-first",1,"dusk"),second=makePlayer("leverage-score-second",2,"dusk"),{game}=makeGame([actor,first,second]),evaluator=game.aiController.evaluator,card={...CARD_DEFINITIONS.leverage,id:"leverage-score"},action={type:"card",card,targets:[{id:first.id},{id:second.id}]},makeVisible=(equipmentDefinitionId,hp)=>({players:[{id:actor.id,battleTeam:"dawn",handCount:1},{id:first.id,battleTeam:"dusk",equipmentDefinitionId,attackUsed:0,attackLimit:1,assaultResponseProbability:.8},{id:second.id,battleTeam:"dusk",hp,maxHp:4}]});assert.equal(evaluator.actionUtility(action,actor,makeVisible("battleDevice",1)),evaluator.actionUtility(action,actor,makeVisible("energyDevice",4)));
});
test("AI 猎印与基础牌类别使用概率采用联合概率累计", () => {
  const simulator=new AiSimulator({players:[]}),hunter={id:"hunter",generalId:"trail-hunter",battleTeam:"dawn",alive:true,trackingTargetIds:[],trackingUses:0,attackUsed:0},marked={id:"marked",battleTeam:"dusk",alive:true,hp:10,maxHp:10,shield:10,handCount:0,blockProbability:0,statuses:[],expectedRecoverCount:0},trackingState={players:[hunter,marked]};simulator.simulateAssault(trackingState,hunter,marked,.5);simulator.simulateAssault(trackingState,hunter,marked,.5);assert.ok(Math.abs(marked.huntMarkProbabilities[hunter.id]-.75)<1e-9);assert.ok(Math.abs(hunter.trackingUses-.75)<1e-9);
  const blade={id:"blade",generalId:"blade-walker",battleTeam:"dawn",alive:true,momentum:0,categoriesUsed:[],categoryUsedProbabilities:{basic:0},attackUsed:0},shielded={id:"shielded",battleTeam:"dusk",alive:true,hp:10,maxHp:10,shield:10,handCount:0,blockProbability:0,expectedRecoverCount:0},momentumState={players:[blade,shielded]};simulator.simulateAssault(momentumState,blade,shielded,.5);simulator.simulateAssault(momentumState,blade,shielded,.5);assert.ok(Math.abs(blade.categoryUsedProbabilities.basic-.75)<1e-9);assert.ok(Math.abs(blade.momentum-.75)<1e-9);
});
test("AI 共用突袭模拟覆盖护援弃牌、窥隙信息和余烬能量", () => {
  const simulator=new AiSimulator({players:[]});
  const attacker={id:"attacker",generalId:"blade-walker",battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:0,momentum:0,categoriesUsed:["basic"],attackUsed:0},protectedTarget={id:"protected",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0},guardian={id:"guardian",generalId:"oath-warden",battleTeam:"dawn",alive:true,hp:3,maxHp:3,shield:0,handCount:1,guardianAidUsedProbability:0};simulator.simulateAssault({players:[attacker,protectedTarget,guardian]},attacker,protectedTarget,1);assert.equal(protectedTarget.hp,4);assert.equal(guardian.handCount,0);assert.equal(guardian.guardianAidUsedProbability,1);
  const spy={id:"spy",generalId:"shade-agent",battleTeam:"dawn",alive:true,hp:3,maxHp:3,handCount:0,attackUsed:0,spyGapTriggeredProbability:0,expectedInformationGain:0},spyTarget={id:"spy-target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:3,blockProbability:0,expectedRecoverCount:0};simulator.simulateAssault({players:[spy,spyTarget]},spy,spyTarget,1);assert.equal(spyTarget.hp,3);assert.equal(spy.spyGapTriggeredProbability,1);assert.equal(spy.expectedInformationGain,2);
  const ember={id:"ember",generalId:"ember-magus",battleTeam:"dawn",alive:true,hp:3,maxHp:3,energy:1,maxEnergy:3,handCount:0,attackUsed:0},emberTarget={id:"ember-target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0};simulator.simulateAssault({players:[ember,emberTarget]},ember,emberTarget,1);assert.equal(ember.energy,2);
});
test("AI 共用突袭模拟消费破势与孤注并保留濒死救援和击杀奖励", () => {
  const simulator=new AiSimulator({players:[]}),source={id:"source",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0,attackUsed:0,exposeWeaknessStacks:2,assaultBonus:1},target={id:"target",battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0};simulator.simulateAssault({players:[source,target]},source,target,1);assert.equal(target.hp,1);assert.equal(source.exposeWeaknessStacks,0);assert.equal(source.assaultBonus,0);
  const killer={id:"killer",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0,attackUsed:0},victim={id:"victim",battleTeam:"dusk",alive:true,hp:1,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0},killState={players:[killer,victim]};simulator.simulateAssault(killState,killer,victim,1);assert.equal(victim.alive,false);assert.equal(killer.handCount,GAME_CONFIG.killRewardDrawCount);
  const rescuedAttacker={id:"rescued-attacker",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0,attackUsed:0},rescued={id:"rescued",battleTeam:"dusk",alive:true,hp:1,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0},rescuer={id:"rescuer",generalId:"spirit-medic",battleTeam:"dusk",alive:true,hp:3,maxHp:3,shield:0,handCount:1,expectedRecoverCount:1,rejuvenationUsed:false},rescueState={players:[rescuedAttacker,rescued,rescuer]};simulator.simulateAssault(rescueState,rescuedAttacker,rescued,1);assert.equal(rescued.alive,true);assert.equal(rescued.hp,2);assert.equal(rescuedAttacker.handCount,0);
});
test("平衡模拟在相同种子和固定节点预算下连续两次结果完全一致", async () => {
  const env={...process.env,FIVE_REALMS_GAMES:"2",FIVE_REALMS_SEED_BASE:"123456789",FIVE_REALMS_START_INDEX:"8",FIVE_REALMS_SEARCH_NODE_BUDGET:"80"};
  delete env.FIVE_REALMS_SEARCH_BUDGET;
  const run=async()=>JSON.parse((await execFileAsync(process.execPath,[projectFile("tests/balance-simulation.mjs")],{cwd:projectFile("."),env,encoding:"utf8",maxBuffer:1024*1024})).stdout);
  const first=await run(),second=await run();
  assert.deepEqual(second,first);assert.deepEqual([first.games,first.completedGames,first.smallTeamWinRate,first.largeTeamWinRate],[2,2,50,50]);
});
test("AI 模拟器识别破势叠加后强化普通突袭", () => { const visible={players:[{id:"a",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:4,attackRange:1,attackUsed:0,attackLimit:2,recoverUsed:0,recoverLimit:null,exposeWeaknessStacks:0,alive:true,handCount:3,hand:[{id:"x1",definitionId:"exposeWeakness"},{id:"x2",definitionId:"exposeWeakness"},{id:"a1",definitionId:"assault"}]},{id:"b",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,maxEnergy:3,attackRange:1,alive:true,handCount:0}]};const simulator=new AiSimulator(visible);const once=simulator.apply(visible,{type:"card",card:{id:"x1",definitionId:"exposeWeakness"},targets:[]},"a");const twice=simulator.apply(once,{type:"card",card:{id:"x2",definitionId:"exposeWeakness"},targets:[]},"a");const attacked=simulator.apply(twice,{type:"card",card:{id:"a1",definitionId:"assault"},targets:[{id:"b"}]},"a");assert.equal(attacked.players[1].hp,1);assert.equal(attacked.players[0].exposeWeaknessStacks,0);assert.equal(attacked.players[0].recoverLimit,null); });
test("AI 普通突袭与借势响应共用同一模拟入口", () => {
  const state={players:[{id:"actor",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:2,hand:[{id:"a",definitionId:"assault"},{id:"l",definitionId:"leverage"}],attackUsed:0,attackLimit:2,counterProbability:0},{id:"first",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,attackUsed:0,attackLimit:1,equipmentDefinitionId:"energyDevice",assaultResponseProbability:1,expectedAssaultCount:1,blockProbability:0,counterProbability:0},{id:"second",seatIndex:2,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:0,blockProbability:0,counterProbability:0}]};
  const simulator=new AiSimulator(state),original=simulator.simulateAssault.bind(simulator),sources=[];simulator.simulateAssault=(next,source,target,chance,options)=>{sources.push(source.id);return original(next,source,target,chance,options);};simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"a"},targets:[{id:"first"}]},"actor");simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.leverage,id:"l"},targets:[{id:"first"},{id:"second"}],selection:{firstTargetId:"first",secondTargetId:"second"}},"actor");assert.deepEqual(sources,["actor","first"]);
});
test("AI 模拟借势不会对同阵营第二目标使用突袭", () => {
  const state={players:[{id:"actor",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"l",definitionId:"leverage"}],counterProbability:0,expectedEquipmentGain:0},{id:"first",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:2,hand:[{id:"a1",definitionId:"assault"}],attackUsed:0,attackLimit:1,attackRange:1,equipmentDefinitionId:"energyDevice",equipmentRetentionProbability:1,assaultResponseProbability:1,expectedAssaultCount:1,blockProbability:0,counterProbability:0},{id:"second",seatIndex:2,battleTeam:"dusk",hp:4,maxHp:4,shield:2,energy:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0}]};
  const game={state:{players:state.players}};assert.ok(!RuleEngine.getLegalAssaultTargets(game,state.players[1]).some((candidate)=>candidate.id==="second"));assert.ok(RuleEngine.getAssaultTargetCandidates(game,state.players[1]).some((candidate)=>candidate.id==="second"));
  const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.leverage,id:"l"},targets:[{id:"first"},{id:"second"}],selection:{firstTargetId:"first",secondTargetId:"second"}},"actor"),first=next.players[1],second=next.players[2];
  assert.equal(second.hp,4);assert.equal(second.shield,2);assert.equal(first.attackUsed,0);assert.equal(first.attackUseSlots[0][0].available,true);assert.equal(first.expectedAssaultCount,1);assert.equal(first.handCount,2);assert.equal(first.hand.length,1);assert.equal(first.equipmentDefinitionId,null);assert.equal(first.equipmentRetentionProbability,0);assert.equal(next.players[0].expectedEquipmentGain,CARD_DEFINITIONS.energyDevice.aiValue);assert.equal(next.players[0].handCount,1);
});
test("AI 模拟借势不会对同阵营使用者本人使用突袭", () => {
  const state={players:[{id:"actor",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"l",definitionId:"leverage"}],counterProbability:0,expectedEquipmentGain:0},{id:"first",seatIndex:1,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"a1",definitionId:"assault"}],attackUsed:0,attackLimit:1,attackRange:1,equipmentDefinitionId:"energyDevice",equipmentRetentionProbability:1,assaultResponseProbability:1,expectedAssaultCount:1,blockProbability:0,counterProbability:0}]};
  const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.leverage,id:"l"},targets:[{id:"first"},{id:"actor"}],selection:{firstTargetId:"first",secondTargetId:"actor"}},"actor"),actor=next.players[0],first=next.players[1];
  assert.equal(actor.hp,4);assert.equal(first.attackUsed,0);assert.equal(first.attackUseSlots[0][0].available,true);assert.equal(first.expectedAssaultCount,1);assert.equal(first.handCount,1);assert.equal(first.equipmentDefinitionId,null);assert.equal(actor.expectedEquipmentGain,CARD_DEFINITIONS.energyDevice.aiValue);assert.equal(actor.handCount,1);
});
test("AI 模拟借势对合法敌方第二目标保留突袭使用", () => {
  const state={players:[{id:"actor",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"l",definitionId:"leverage"}],counterProbability:0,expectedEquipmentGain:0},{id:"first",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:2,hand:[{id:"a1",definitionId:"assault"}],attackUsed:0,attackLimit:1,attackRange:1,equipmentDefinitionId:"energyDevice",equipmentRetentionProbability:1,assaultResponseProbability:1,expectedAssaultCount:1,blockProbability:0,counterProbability:0},{id:"second",seatIndex:2,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:0,blockProbability:0,expectedRecoverCount:0}]};
  const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.leverage,id:"l"},targets:[{id:"first"},{id:"second"}],selection:{firstTargetId:"first",secondTargetId:"second"}},"actor"),first=next.players[1],second=next.players[2];
  assert.ok(first.attackUsed>0);assert.ok(first.expectedAssaultCount<1);assert.ok(first.handCount<2);assert.ok(second.hp<4);
});
test("AI 借势用连续期望模拟使用与拒绝且不按阈值删除装备", () => {
  const state={players:[{id:"actor",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:1,hand:[{id:"l",definitionId:"leverage"}],counterProbability:0,expectedEquipmentGain:0},{id:"first",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:2,attackUsed:0,attackLimit:1,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1,assaultResponseProbability:.5,expectedAssaultCount:.5,blockProbability:0,counterProbability:0},{id:"second",seatIndex:2,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:0,blockProbability:.2,twoBlockProbability:0,counterProbability:0}]};
  const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.leverage,id:"l"},targets:[{id:"first"},{id:"second"}],selection:{firstTargetId:"first",secondTargetId:"second"}},"actor"),actor=next.players[0],first=next.players[1],second=next.players[2];assert.equal(first.equipmentDefinitionId,"battleDevice");assert.ok(first.equipmentRetentionProbability>0&&first.equipmentRetentionProbability<1);assert.ok(actor.handCount>0&&actor.handCount<1);assert.ok(actor.expectedEquipmentGain>0);assert.ok(first.attackUsed>0&&first.attackUsed<1);assert.ok(second.hp<4);
});
test("AI 连续借势按装备剩余概率计算且累计获得期望不超过同一件装备", () => {
  const state={players:[{id:"actor",seatIndex:0,battleTeam:"dawn",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:2,hand:[{id:"l1",definitionId:"leverage"},{id:"l2",definitionId:"leverage"}],counterProbability:0,expectedEquipmentGain:0},{id:"first",seatIndex:1,battleTeam:"dusk",hp:4,maxHp:4,shield:0,energy:0,alive:true,handCount:2,attackUsed:0,attackLimit:2,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1,assaultResponseProbability:.5,expectedAssaultCount:1,blockProbability:0,counterProbability:0},{id:"second",seatIndex:2,battleTeam:"dawn",hp:5,maxHp:5,shield:0,energy:0,alive:true,handCount:0,blockProbability:0,twoBlockProbability:0,counterProbability:0}]};
  const simulator=new AiSimulator(state),action=(id)=>({type:"card",card:{...CARD_DEFINITIONS.leverage,id},targets:[{id:"first"},{id:"second"}],selection:{firstTargetId:"first",secondTargetId:"second"}}),once=simulator.apply(state,action("l1"),"actor"),twice=simulator.apply(once,action("l2"),"actor"),equipmentValue=CARD_DEFINITIONS.battleDevice.aiValue,firstOnce=once.players[1],firstTwice=twice.players[1],actorTwice=twice.players[0];assert.ok(firstOnce.equipmentRetentionProbability<1&&firstOnce.equipmentRetentionProbability>0);assert.ok(firstTwice.equipmentRetentionProbability<firstOnce.equipmentRetentionProbability);assert.ok(actorTwice.expectedEquipmentGain/equipmentValue<=1+1e-9);assert.ok(actorTwice.handCount<=1+1e-9);assert.ok(firstTwice.attackUsed<=2);
});
test("AI 装备统一接口会在换装时重置概率并在明确失去时清空", () => {
  const simulator=new AiSimulator({players:[]}),player={equipmentDefinitionId:"telescope",equipmentRetentionProbability:.25};simulator.setSimulatedEquipment(player,"barrierDevice",1);assert.deepEqual([player.equipmentDefinitionId,player.equipmentRetentionProbability],["barrierDevice",1]);simulator.setSimulatedEquipment(player,null,0);assert.deepEqual([player.equipmentDefinitionId,player.equipmentRetentionProbability],[null,0]);
});
test("AI 距离与攻防装备效果按装备存在概率加权", () => {
  const source={id:"s",seatIndex:0,battleTeam:"dawn",alive:true,attackRange:1,equipmentDefinitionId:"telescope",equipmentRetentionProbability:.5},middle={id:"m",seatIndex:1,battleTeam:"dawn",alive:true},target={id:"t",seatIndex:2,battleTeam:"dusk",alive:true,equipmentDefinitionId:"barrierDevice",equipmentRetentionProbability:.25},tail={id:"x",seatIndex:3,battleTeam:"dusk",alive:true},game={state:{players:[source,middle,target,tail]}};assert.equal(DistanceSystem.getDistance(game,source,target),2);assert.equal(DistanceSystem.getRangeLegalityProbability(game,source,target,1),.375);
  const damageState={players:[{id:"a",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:.5},{id:"b",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,blockProbability:1,twoBlockProbability:0,equipmentDefinitionId:null,equipmentRetentionProbability:0,expectedRecoverCount:0}]};const simulator=new AiSimulator(damageState),next=simulator.clone(damageState);simulator.applyDamage(next,next.players[0],next.players[1],1,{canBlock:true,deviceAttack:true});assert.equal(next.players[1].hp,3.5);assert.equal(next.players[1].handCount,.5);
});
test("AI 雷达与回收站效果按装备存在概率加权", () => {
  const makeDamage=(probability)=>({players:[{id:"a",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0,equipmentDefinitionId:null,equipmentRetentionProbability:0},{id:"b",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,equipmentDefinitionId:probability?"defenseDevice":null,equipmentRetentionProbability:probability,expectedRecoverCount:0}]});const simulator=new AiSimulator({players:[]}),damage=(probability)=>{const state=makeDamage(probability);simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:true,deviceAttack:true});return state.players[1].hp;},without=damage(0),half=damage(.5),full=damage(1);assert.ok(full>half&&half>without);assert.ok(Math.abs(half-(full+without)/2)<1e-9);
  const recycleState={players:[{id:"r",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:1,hand:[{id:"x",definitionId:"exposeWeakness"}],equipmentDefinitionId:"recycleDevice",equipmentRetentionProbability:.5,recycleDeviceUses:0,exposeWeaknessStacks:0}]};const recycled=simulator.apply(recycleState,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x"},targets:[]},"r");assert.equal(recycled.players[0].handCount,.5);assert.equal(recycled.players[0].recycleDeviceUses,.5);
});
test("概率距离合法性枚举离散装备分支且真实状态只返回0或1", () => {
  const source={id:"s",seatIndex:0,battleTeam:"dawn",alive:true,attackRange:1,equipmentDefinitionId:"telescope",equipmentRetentionProbability:.4},middle={id:"m",seatIndex:1,battleTeam:"dawn",alive:true},target={id:"t",seatIndex:2,battleTeam:"dusk",alive:true,equipmentDefinitionId:"barrierDevice",equipmentRetentionProbability:.25},tail={id:"x",seatIndex:3,battleTeam:"dusk",alive:true},game={state:{players:[source,middle,target,tail]}};assert.ok(Math.abs(DistanceSystem.getRangeLegalityProbability(game,source,target,1)-.3)<1e-9);delete source.equipmentRetentionProbability;delete target.equipmentRetentionProbability;assert.equal(DistanceSystem.getRangeLegalityProbability(game,source,target,1),0);target.equipmentDefinitionId=null;assert.equal(DistanceSystem.getRangeLegalityProbability(game,source,target,1),1);
});
test("概率距离动作按同一概率扣牌结算且未执行分支不能重复攻击同一目标", () => {
  const state={playPhaseEnded:false,players:[{id:"a",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:0,attackLimit:1,attackRange:1,equipmentDefinitionId:"telescope",equipmentRetentionProbability:.5},{id:"m",seatIndex:1,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0},{id:"t",seatIndex:2,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0},{id:"x",seatIndex:3,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0}]};const actor=makePlayer("real",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),{game}=makeGame([actor,enemy]),actions=game.aiController.actionGenerator.generateFromVisible(state,"a"),attack=actions.find((action)=>action.card?.id==="hit"&&action.targets[0]?.id==="t");assert.equal(attack.executionProbability,.5);const next=new AiSimulator(state).apply(state,attack,"a"),nextActor=next.players[0];assert.equal(nextActor.handCount,.5);assert.deepEqual(nextActor.hand[0].availabilityBranches,[{probability:.5,conditions:{"equipment:a:telescope":"absent","equipment:t:barrierDevice":"absent"}}]);assert.equal(nextActor.attackUsed,.5);assert.equal(next.players[2].hp,3.5);const follow=game.aiController.actionGenerator.generateFromVisible(next,"a");assert.ok(!follow.some((action)=>action.card?.id==="hit"&&action.targets[0]?.id==="t"));
});
test("概率装备依赖的借势同步缩放卡牌成本并禁止再次针对同一装备", () => {
  const state={playPhaseEnded:false,players:[{id:"a",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:1,hand:[{id:"l",definitionId:"leverage"}],attackUsed:0,attackLimit:1,attackRange:1,counterProbability:0},{id:"f",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,attackUsed:0,attackLimit:1,attackRange:1,equipmentDefinitionId:"energyDevice",equipmentRetentionProbability:.25,assaultResponseProbability:1,expectedAssaultCount:1,counterProbability:0,blockProbability:0}]};const actor=makePlayer("real",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),{game}=makeGame([actor,enemy]),actions=game.aiController.actionGenerator.generateFromVisible(state,"a"),leverage=actions.find((action)=>action.card?.id==="l");assert.equal(leverage.executionProbability,.25);const next=new AiSimulator(state).apply(state,leverage,"a"),held=next.players[0].hand.find((card)=>card.id==="l");assert.deepEqual(held.availabilityBranches,[{probability:.75,conditions:{"equipment:a:barrierDevice":"absent","equipment:f:energyDevice":"absent","equipment:f:telescope":"absent"}}]);const follow=game.aiController.actionGenerator.generateFromVisible(next,"a");assert.ok(!follow.some((action)=>action.card?.id==="l"&&action.selection?.firstTargetId==="f"));
});
test("AI 回收站触发期望严格封顶2次", () => {
  const state={players:[{id:"r",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:1,hand:[{id:"x",definitionId:"exposeWeakness"}],equipmentDefinitionId:"recycleDevice",equipmentRetentionProbability:.8,recycleDeviceUses:1.7,exposeWeaknessStacks:0}]};const next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"x"},targets:[]},"r");assert.ok(Math.abs(next.players[0].recycleDeviceUses-2)<1e-9);assert.ok(Math.abs(next.players[0].handCount-.3)<1e-9);
});
test("AI 雷达按判定牌类型计算格挡消耗并保持手牌非负", () => {
  const battleProbability=.25,normalBlockProbability=.1,twoBlockProbability=.02,state={players:[{id:"a",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:battleProbability},{id:"b",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:normalBlockProbability,twoBlockProbability,equipmentDefinitionId:"defenseDevice",equipmentRetentionProbability:1,expectedRecoverCount:0}]},basicTotal=Object.values(CARD_DEFINITIONS).filter((card)=>card.category==="basic").reduce((sum,card)=>sum+card.count,0),equipmentTotal=Object.values(CARD_DEFINITIONS).filter((card)=>card.category==="equipment").reduce((sum,card)=>sum+card.count,0),blockChance=CARD_DEFINITIONS.block.count/TOTAL_CARD_COUNT,otherBasicChance=(basicTotal-CARD_DEFINITIONS.block.count)/TOTAL_CARD_COUNT,equipmentChance=equipmentTotal/TOTAL_CARD_COUNT,normalSpent=blockChance+(otherBasicChance+equipmentChance)*normalBlockProbability,battleSpent=2*(blockChance*normalBlockProbability+(otherBasicChance+equipmentChance)*twoBlockProbability),expectedSpent=battleProbability*battleSpent+(1-battleProbability)*normalSpent,simulator=new AiSimulator(state);simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:true,deviceAttack:true});assert.ok(Math.abs(state.players[1].handCount-Math.max(0,basicTotal/TOTAL_CARD_COUNT-expectedSpent))<1e-9);assert.ok(state.players[1].handCount>=0);
});
test("AI 掠夺破坏窃取与主动装备均通过统一装备状态更新", () => {
  const simulator=new AiSimulator({players:[]}),actor={handCount:0,equipmentDefinitionId:null,equipmentRetentionProbability:0},target={handCount:0,equipmentDefinitionId:"energyDevice",equipmentRetentionProbability:1};simulator.takeResourceToHand(actor,target,.4);assert.equal(target.equipmentRetentionProbability,.6);assert.equal(actor.handCount,.4);simulator.destroyResource(target,.5);assert.equal(target.equipmentRetentionProbability,.3);simulator.stealResourceToHand(actor,target);assert.equal(target.equipmentDefinitionId,null);assert.equal(target.equipmentRetentionProbability,0);const state={players:[{id:"a",alive:true,battleTeam:"dawn",handCount:1,hand:[{id:"e",definitionId:"barrierDevice"}],equipmentDefinitionId:"telescope",equipmentRetentionProbability:.2}]};const equipped=simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.barrierDevice,id:"e"},targets:[]},"a");assert.deepEqual([equipped.players[0].equipmentDefinitionId,equipped.players[0].equipmentRetentionProbability],["barrierDevice",1]);
});
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
test("响应窗口超时会按放弃处理并清除响应状态", async () => { const previousWindow=globalThis.window;globalThis.window={setInterval,clearInterval};const panel={innerHTML:"",classList:{add(){},remove(){}},querySelector(){return null;}};const fake={responseState:null,elements:{response_panel:panel},game:{cleanupManager:{delay:async()=>true}},render(){}};try{const result=await UIManager.prototype.requestResponse.call(fake,{id:"timeout-response",requiredCount:1,legalCardIds:[],timeoutMs:1,presentation:{eventText:"测试事件",responseText:"需要响应",availabilityText:"当前不足",buttonLabel:"格挡"}},"格挡");assert.equal(result.status,"declined");assert.equal(fake.responseState,null);assert.equal(panel.innerHTML,"");}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;} });
test("销毁对局会以 cancelled 结束未完成响应并清空请求", async () => { const a=makePlayer("a",0,"dawn"),human=makePlayer("human",1,"dusk","human");const {game,ui}=makeGame([a,human]);let settle=null;ui.requestResponse=()=>new Promise((resolve)=>{settle=resolve;});ui.cancelPendingInteractions=()=>{settle?.({status:"cancelled"});};const pending=game.responseSystem.requestCardResponse(human,"block",{source:a,target:human,card:instance("assault")},1);await Promise.resolve();assert.equal(game.state.pendingResponses.length,1);game.dispose();const result=await pending;assert.equal(result.status,"cancelled");assert.deepEqual(result.cards,[]);assert.equal(game.state.pendingResponses.length,0); });
test("旧局格挡窗口取消后不能扣血、刷新新局 UI 或夺回绑定", async () => {
  const ui=makeOwnedUi(),source=makePlayer("old-attacker",0,"dawn"),target=makePlayer("old-human",1,"dusk","human");
  const old=configureOwnedGame(new Game(ui),[source,target]);ui.attachGame(old);
  let openedResolve;const opened=new Promise((resolve)=>{openedResolve=resolve;});ui.onResponse=(request)=>{if(request.type==="block")openedResolve();};
  const hp=target.hp,pending=old.damage(source,target,1,{card:instance("assault"),canBlock:true,damageType:"normal"});await opened;
  old.dispose();const fresh=configureOwnedGame(new Game(ui),[makePlayer("new-human",0,"dawn","human"),makePlayer("new-enemy",1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];
  assert.equal(await pending,0);assert.equal(target.hp,hp);assert.equal(ui.game,fresh);assert.deepEqual(ui.renders,[]);assert.deepEqual(ui.mutations,[]);assert.deepEqual(ui.logs,[]);
  assert.equal(old.ui.render(old),undefined);assert.equal(ui.game,fresh);
});
test("旧局护援技能响应取消后不会弃牌或减少新一段伤害", async () => {
  const ui=makeOwnedUi(),source=makePlayer("old-aid-source",0,"dusk","ai",4),target=makePlayer("old-aid-target",1,"dawn","ai",2),guardian=makePlayer("old-aid-guardian",2,"dawn","human",1);
  const payment=instance("charge");guardian.hand.push(payment);const old=configureOwnedGame(new Game(ui),[source,target,guardian]);registerPassiveSkills(old);ui.attachGame(old);
  let openedResolve;const opened=new Promise((resolve)=>{openedResolve=resolve;});ui.onResponse=(request)=>{if(request.type==="skill")openedResolve();};const hp=target.hp,pending=old.damage(source,target,1,{skill:"burningField",actionName:"焚场",canBlock:false,damageType:"skill"});await opened;
  old.dispose();const fresh=configureOwnedGame(new Game(ui),[makePlayer("new-aid-human",0,"dawn","human"),makePlayer("new-aid-enemy",1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];
  assert.equal(await pending,0);assert.equal(target.hp,hp);assert.ok(guardian.hand.includes(payment));assert.equal(guardian.roundFlags.guardianAidUsed,false);assert.equal(ui.game,fresh);assert.deepEqual(ui.mutations,[]);
});
test("事件处理器等待中销毁旧局时，雷达判定不会恢复后继续移动牌或伤害", async () => {
  const ui=makeOwnedUi(),source=makePlayer("old-judge-source",0,"dawn"),target=makePlayer("old-judge-target",1,"dusk");target.equipment=instance("defenseDevice");
  const old=configureOwnedGame(new Game(ui),[source,target]);ui.attachGame(old);const judgmentCard=instance("charge");old.state.deck.cards.push(judgmentCard);
  let openedResolve,release;const opened=new Promise((resolve)=>{openedResolve=resolve;});const gate=new Promise((resolve)=>{release=resolve;});old.eventBus.on("judgmentRevealed","test:pause",async()=>{openedResolve();await gate;});
  const hp=target.hp,pending=old.damage(source,target,1,{card:instance("assault"),canBlock:true,damageType:"normal"});await opened;old.dispose();
  const fresh=configureOwnedGame(new Game(ui),[makePlayer("new-judge-human",0,"dawn","human"),makePlayer("new-judge-enemy",1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];release();
  assert.equal(await pending,0);assert.equal(target.hp,hp);assert.ok(old.state.deck.judgmentZone.includes(judgmentCard));assert.equal(fresh.state.deck.judgmentZone.length,0);assert.deepEqual(ui.mutations,[]);assert.deepEqual(ui.logs,[]);
});
test("旧局治疗和能量事件等待恢复后不再修改角色", async () => {
  for (const mode of ["heal","energy"]) {
    const ui=makeOwnedUi(),actor=makePlayer(`old-${mode}-actor`,0,"dawn"),enemy=makePlayer(`old-${mode}-enemy`,1,"dusk");const old=configureOwnedGame(new Game(ui),[actor,enemy]);ui.attachGame(old);
    if(mode==="heal")actor.hp-=1;else actor.energy=0;const before=mode==="heal"?actor.hp:actor.energy;let openedResolve,release;const opened=new Promise((resolve)=>{openedResolve=resolve;});const gate=new Promise((resolve)=>{release=resolve;});old.eventBus.on(mode==="heal"?"beforeHeal":"beforeGainEnergy",`test:${mode}`,async()=>{openedResolve();await gate;});
    const pending=mode==="heal"?old.heal(actor,actor,1):old.gainEnergy(actor,1,{reason:"测试"});await opened;old.dispose();const fresh=configureOwnedGame(new Game(ui),[makePlayer(`new-${mode}-human`,0,"dawn","human"),makePlayer(`new-${mode}-enemy`,1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];release();
    assert.equal(await pending,0);assert.equal(mode==="heal"?actor.hp:actor.energy,before);assert.deepEqual(ui.mutations,[]);assert.deepEqual(ui.logs,[]);
  }
});
for (const definitionId of ["duel","provoke"]) test(`旧局${CARD_DEFINITIONS[definitionId].name}响应取消后不会继续造成伤害`, async () => {
  const ui=makeOwnedUi(),source=makePlayer(`old-${definitionId}-source`,0,"dawn"),target=makePlayer(`old-${definitionId}-target`,1,"dusk","human");
  const old=configureOwnedGame(new Game(ui),[source,target]);ui.attachGame(old);const use=instance(definitionId);source.hand.push(use);
  let openedResolve;const opened=new Promise((resolve)=>{openedResolve=resolve;});ui.onResponse=(request)=>{if(request.type==="counter"){const state=ui.responseState;ui.responseState=null;state.resolve({status:"declined"});}else openedResolve();};
  const hp=target.hp,pending=old.playCard(source,use,[target]);await opened;
  old.dispose();const fresh=configureOwnedGame(new Game(ui),[makePlayer(`new-${definitionId}-human`,0,"dawn","human"),makePlayer(`new-${definitionId}-enemy`,1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];
  assert.equal(await pending,false);assert.equal(target.hp,hp);assert.equal(ui.game,fresh);assert.deepEqual(ui.renders,[]);assert.deepEqual(ui.mutations,[]);assert.deepEqual(ui.logs,[]);
});
test("旧局反制链取消后不会完成战术结算或污染新局中央区域", async () => {
  const ui=makeOwnedUi(),source=makePlayer("old-counter-source",0,"dawn"),responder=makePlayer("old-counter-human",1,"dusk","human");
  const old=configureOwnedGame(new Game(ui),[source,responder]);ui.attachGame(old);const use=instance("harvest");source.hand.push(use);
  let openedResolve;const opened=new Promise((resolve)=>{openedResolve=resolve;});ui.onResponse=(request)=>{if(request.type==="counter")openedResolve();};
  const pending=old.playCard(source,use,[]);await opened;old.dispose();
  const fresh=configureOwnedGame(new Game(ui),[makePlayer("new-counter-human",0,"dawn","human"),makePlayer("new-counter-enemy",1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];
  assert.equal(await pending,false);assertCardOnlyIn(old,use,"discard");assert.equal(fresh.state.resolvingCards.length,0);assert.equal(ui.game,fresh);assert.deepEqual(ui.mutations,[]);assert.deepEqual(ui.logs,[]);
});
test("旧局公共池、目标和弃牌等待取消后不移动实体且不影响新 UI", async () => {
  for (const mode of ["public","target","discard"]) {
    const ui=makeOwnedUi(),human=makePlayer(`old-${mode}-human`,0,"dawn","human"),enemy=makePlayer(`old-${mode}-enemy`,1,"dusk");
    const old=configureOwnedGame(new Game(ui),[human,enemy]);ui.attachGame(old);let openedResolve;const opened=new Promise((resolve)=>{openedResolve=resolve;});let pending,tracked;
    if (mode==="public") {
      ui.onResponse=()=>{const state=ui.responseState;ui.responseState=null;state.resolve({status:"declined"});};ui.onPublic=openedResolve;
      old.state.deck.cards.push(instance("block"),instance("charge"));tracked=instance("mutualBenefit");human.hand.push(tracked);pending=old.playCard(human,tracked,[]);
    } else if (mode==="target") {
      ui.onTarget=openedResolve;tracked=instance("assault");human.hand.push(tracked);pending=old.handleHumanCard(tracked.id);
    } else {
      ui.onDiscard=openedResolve;tracked=instance("block");human.hand.push(tracked,instance("charge"));human.hp=1;old.state.phase="discard";pending=old.handleDiscardPhase(human,old.state.gameId);
    }
    await opened;old.dispose();const fresh=configureOwnedGame(new Game(ui),[makePlayer(`new-${mode}-human`,0,"dawn","human"),makePlayer(`new-${mode}-enemy`,1,"dusk")]);ui.attachGame(fresh);ui.renders=[];ui.mutations=[];ui.logs=[];
    await pending;assert.equal(ui.game,fresh);assert.deepEqual(ui.renders,[]);assert.deepEqual(ui.mutations,[]);assert.deepEqual(ui.logs,[]);assert.ok(!human.hand.includes(undefined));if(mode!=="public")assert.ok(human.hand.includes(tracked));
  }
});
test("重新征召 cleanup 会清空隐藏令牌、公共池和响应", () => { const a=makePlayer("a",0,"dawn"),b=makePlayer("b",1,"dusk");const {game}=makeGame([a,b]);b.hand.push(instance("block"));game.cardSelectionSystem.createHiddenSelection(b);game.state.pendingResponses.push({id:"old"});game.dispose();assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.state.pendingResponses.length,0);assert.equal(game.state.publicCardPool.length,0); });
test("重新征召后按新阵营重新设置能量上限和无限调息", async () => { const verify=async(seed)=>{let value=seed;const random=()=>((value=Math.imul(value,1664525)+1013904223>>>0)/4294967296),ui=makeUi(),game=new Game(ui,random);game.simulationMode=true;game.cleanupManager.delay=async()=>!game.state.isDisposed;const candidates=game.startSelection();for(const player of game.state.players)assert.equal(player.maxEnergy,game.teamRules.getTeamSize(player)===2?4:3);await game.confirmGeneral(candidates[0].id);for(const player of game.state.players){assert.equal(player.maxEnergy,game.teamRules.getMaxEnergy(player));assert.equal(player.turnFlags.recoverLimit,null);}game.dispose();await game.loopPromise;};await verify(11);await verify(29); });
test("装备槽空置和六种装备生成不同可访问 DOM", () => { const p=makePlayer("a",0,"dawn");const empty=equipmentSlotTemplate(p,true);assert.match(empty,/is-empty|装备槽为空/);for(const id of ["energyDevice","recycleDevice","defenseDevice","battleDevice","telescope","barrierDevice"]){p.equipment=instance(id);const markup=equipmentSlotTemplate(p,true);assert.match(markup,new RegExp(CARD_DEFINITIONS[id].name));assert.match(markup,new RegExp(CARD_DEFINITIONS[id].description.slice(0,6)));assert.notEqual(markup,empty);} });
test("UIManager 源码不直接写生命、能量、手牌或胜负", async () => { const source=await readFile(projectFile("js/ui/UIManager.js"),"utf8");for(const forbidden of [/\.hp\s*=/,/\.energy\s*=/,/\.hand\.(?:push|splice|pop|shift|unshift)/,/\.winnerTeam\s*=/,/\.isGameOver\s*=/])assert.doesNotMatch(source,forbidden); });
test("全 AI 快速对局能推进到合法胜者", async () => { let seed=77;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);const ui=makeUi();const game=new Game(ui,random);game.simulationMode=true;game.setAnimationFastMode(true);game.cleanupManager.delay=async()=>!game.state.isDisposed;const candidates=game.startSelection();game.state.players[0].controllerType="ai";await game.confirmGeneral(candidates[0].id);const result=await Promise.race([game.loopPromise.then(()=>"done"),new Promise((resolve)=>setTimeout(()=>resolve("timeout"),10000))]);assert.equal(result,"done");assert.ok(["dawn","dusk"].includes(game.state.winnerTeam));game.dispose(); });

// 本轮规则修复回归
test("掠夺装备收入手牌且不会替换或弃置使用者旧装备", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),target=makePlayer("target",1,"dusk"),use=instance("plunder");
  const old=instance("barrierDevice"),moved=instance("energyDevice");actor.equipment=old;actor.hand.push(use);target.equipment=moved;
  const {game}=makeGame([actor,target]);const selection=game.cardSelectionSystem.createHiddenSelection(target);
  await game.playCard(actor,use,[target],{zone:"equipment",equipmentCardId:moved.id,selectionId:selection.selectionId});
  assert.equal(actor.equipment,old);assert.ok(actor.hand.includes(moved));assert.ok(!game.state.deck.discardPile.includes(old));assert.equal(target.equipment,null);
  assert.equal(await game.playCard(actor,moved,[]),true);assert.equal(actor.equipment,moved);assert.ok(game.state.deck.discardPile.includes(old));
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
  const {game}=makeGame([tuner,enemy,ally]);registerPassiveSkills(game);game.state.deck.cards.push(instance("charge"));let usedEvent=null;game.eventBus.on("cardUsed","test:successful-transfer",(event)=>{usedEvent=event;});
  const use=instance("transfer"),moved=instance("block");tuner.hand.push(use);enemy.hand.push(moved);enemy.bumpHandVersion();
  const hidden=game.cardSelectionSystem.createHiddenSelection(enemy);
  await game.playCard(tuner,use,[],{sourceId:enemy.id,receiverId:ally.id,zone:"hand",tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId});
  assert.ok(ally.hand.includes(moved));assert.equal(tuner.turnFlags.coordinationTriggered,true);assert.equal(tuner.hand.length,1);assert.equal(usedEvent.cancelled,false);assert.equal(usedEvent.resolved,true);assert.deepEqual(usedEvent.effectiveTargets,[ally]);
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
test("AI 转移忽略真人队友装备区的雷达", () => {
  const actor=makePlayer("actor",0,"dawn"),humanAlly=makePlayer("human-ally",1,"dawn","human");
  actor.hand.push(instance("transfer"));humanAlly.equipment=instance("defenseDevice");const {game}=makeGame([actor,humanAlly]);
  assert.equal(game.aiController.actionGenerator.generate(actor).some((action)=>action.card?.definitionId==="transfer"),false);
});
test("AI 转移不会把仅有装备的角色作为来源", () => {
  const actor=makePlayer("actor",0,"dawn"),ally=makePlayer("ally",1,"dawn");
  actor.hand.push(instance("transfer"));ally.equipment=instance("defenseDevice");const {game}=makeGame([actor,ally]);
  assert.equal(game.aiController.actionGenerator.generate(actor).some((action)=>action.card?.definitionId==="transfer"),false);
});
test("AI 转移最佳方案为负数时不进入实际动作列表", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk");
  actor.hand.push(instance("transfer"));const {game}=makeGame([actor,enemy]);
  assert.equal(game.aiController.actionGenerator.generate(actor).some((action)=>action.card?.definitionId==="transfer"),false);
});
test("AI 转移不会从敌人装备区移走高价值装备", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const use=instance("transfer");actor.hand.push(use);actor.equipment=instance("energyDevice");enemy.equipment=instance("defenseDevice");const {game}=makeGame([actor,enemy,ally]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  assert.equal(action,undefined);assert.equal(enemy.equipment.definitionId,"defenseDevice");assert.equal(ally.equipment,null);
});
test("AI 转移在角色同时拥有手牌和装备时只生成手牌选择", () => {
  const actor=makePlayer("actor",0,"dawn"),low=makePlayer("low",1,"dusk"),high=makePlayer("high",2,"dusk"),ally=makePlayer("ally",3,"dawn");
  const use=instance("transfer");actor.hand.push(use);low.hand.push(instance("block"));low.equipment=instance("energyDevice");high.equipment=instance("defenseDevice");const {game}=makeGame([actor,low,high,ally]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  assert.ok(action);assert.equal(action.selection.sourceId,low.id);assert.equal(action.selection.zone,"hand");assert.equal(Object.hasOwn(action.selection,"equipmentCardId"),false);
});
test("AI 转移可将即将溢出的队友手牌移给有空间的队友", () => {
  const actor=makePlayer("actor",0,"dawn"),overflow=makePlayer("overflow",1,"dawn"),receiver=makePlayer("receiver",2,"dawn");
  const use=instance("transfer");actor.hand.push(use);overflow.hp=1;overflow.hand.push(instance("harvest"),instance("charge"));const {game}=makeGame([actor,overflow,receiver]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  assert.ok(action);assert.equal(action.selection.sourceId,overflow.id);assert.equal(action.selection.zone,"hand");
});
test("AI 转移真实动作与深层模拟对同一公开局面选择一致", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const use=instance("transfer");actor.hand.push(use);actor.equipment=instance("energyDevice");enemy.hand.push(instance("block"));enemy.equipment=instance("defenseDevice");const {game}=makeGame([actor,enemy,ally]);
  const real=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);
  const visible=createAiVisibleState(actor.id,game.state);
  const simulated=game.aiController.actionGenerator.generateFromVisible(visible,actor.id).find((entry)=>entry.card?.id===use.id);
  const plan=(action)=>[action?.selection?.sourceId,action?.selection?.receiverId,action?.selection?.zone];
  assert.ok(real);assert.ok(simulated);assert.equal(real.selection.zone,"hand");assert.deepEqual(plan(real),plan(simulated));
});
test("AI 模拟器拒绝伪造的装备区转移选择", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn"),use=instance("transfer"),equipment=instance("defenseDevice");actor.hand.push(use);enemy.equipment=equipment;const {game}=makeGame([actor,enemy,ally]),visible=createAiVisibleState(actor.id,game.state),next=new AiSimulator(visible).apply(visible,{type:"card",card:use,targets:[],selection:{sourceId:enemy.id,receiverId:ally.id,zone:"equipment",equipmentCardId:equipment.id}},actor.id),nextEnemy=next.players.find((player)=>player.id===enemy.id),nextAlly=next.players.find((player)=>player.id===ally.id);assert.equal(nextEnemy.equipmentDefinitionId,"defenseDevice");assert.equal(nextAlly.equipmentDefinitionId,null);assert.equal(nextAlly.handCount,0);
});
test("交换敌人未知手牌的真实 definitionId 不改变 AI 转移计划", () => {
  const actor=makePlayer("actor",0,"dawn"),enemy=makePlayer("enemy",1,"dusk"),ally=makePlayer("ally",2,"dawn");
  const use=instance("transfer"),first=instance("counter"),second=instance("harvest");actor.hand.push(use);enemy.hand.push(first,second);const {game}=makeGame([actor,enemy,ally]);
  const choose=()=>{const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);return [action?.selection?.sourceId,action?.selection?.receiverId,action?.selection?.zone];};
  const before=choose();[first.definitionId,second.definitionId]=[second.definitionId,first.definitionId];assert.deepEqual(choose(),before);
});
test("AI 以自己为转移来源时排除正在使用的转移实体", async () => {
  const actor=makePlayer("actor",0,"dawn"),ally=makePlayer("ally",1,"dawn"),use=instance("transfer"),otherA=instance("harvest"),otherB=instance("charge");
  actor.hp=1;actor.hand.push(use,otherA,otherB);const {game}=makeGame([actor,ally]);
  const action=game.aiController.actionGenerator.generate(actor).find((entry)=>entry.card?.id===use.id);assert.ok(action);assert.equal(action.selection.sourceId,actor.id);assert.equal(action.selection.zone,"hand");
  const prepared=await game.prepareTransferIntent(actor,use,action.selection);assert.ok(prepared);assert.notEqual(prepared.privateIntent.card,use);assert.ok([otherA,otherB].includes(prepared.privateIntent.card));
});
test("真人以自己为来源时核心拒绝选择正在使用的转移实体", async () => {
  const actor=makePlayer("actor",0,"dawn","human"),ally=makePlayer("ally",1,"dawn"),use=instance("transfer"),other=instance("harvest");actor.hand.push(use,other);
  const {game}=makeGame([actor,ally]);const hidden=game.cardSelectionSystem.createHiddenSelection(actor);
  assert.equal(await game.playCard(actor,use,[],{sourceId:actor.id,receiverId:ally.id,zone:"hand",tokens:[hidden.tokens[0].token],selectionId:hidden.selectionId}),false);
  assert.ok(actor.hand.includes(use));assert.ok(actor.hand.includes(other));assert.ok(!game.state.deck.resolvingCards.includes(use));assert.ok(!game.state.deck.discardPile.includes(use));
});
test("排除转移牌后没有其他手牌时即使有装备也不能开始转移", async () => {
  const actor=makePlayer("actor",0,"dawn"),ally=makePlayer("ally",1,"dawn"),use=instance("transfer");actor.hand.push(use);actor.equipment=instance("defenseDevice");const {game}=makeGame([actor,ally]);
  assert.equal(RuleEngine.canPlayCard(game,actor,use).ok,false);assert.equal(await game.playCard(actor,use,[],{sourceId:actor.id,receiverId:ally.id,zone:"hand"}),false);assert.ok(actor.hand.includes(use));
});
test("锁定牌在结算前离开来源时转移失败且没有有效目标、成功日志或协调", async () => {
  const tuner=makePlayer("tuner",0,"dawn","ai",7),from=makePlayer("from",1,"dusk"),escaped=makePlayer("escaped",2,"dusk"),ally=makePlayer("ally",3,"dawn"),use=instance("transfer"),locked=instance("block");
  tuner.hand.push(use);from.hand.push(locked);const {game}=makeGame([tuner,from,escaped,ally]);game.state.deck.cards.push(instance("charge"));registerPassiveSkills(game);let usedEvent=null;
  game.eventBus.on("beforeCardResolve","test:remove-locked-transfer-card",()=>{const index=from.hand.indexOf(locked);if(index>=0){from.hand.splice(index,1);escaped.hand.push(locked);from.bumpHandVersion();escaped.bumpHandVersion();}});
  game.eventBus.on("cardUsed","test:failed-transfer",(event)=>{usedEvent=event;});
  assert.equal(await game.playCard(tuner,use,[],{sourceId:from.id,receiverId:ally.id,zone:"hand"}),true);
  assert.ok(escaped.hand.includes(locked));assert.ok(!ally.hand.includes(locked));assert.ok(game.state.deck.discardPile.includes(use));assert.ok(!game.state.deck.resolvingCards.includes(use));
  assert.equal(tuner.turnFlags.coordinationTriggered,false);assert.equal(tuner.hand.length,0);assert.ok(usedEvent);assert.equal(usedEvent.cancelled,true);assert.equal(usedEvent.resolved,false);assert.deepEqual(usedEvent.effectiveTargets,[]);
  assert.equal(game.state.logs.some((entry)=>entry.message.includes(`${tuner.name}将${from.name}的`)&&entry.message.includes(`转移给了${ally.name}`)),false);
});
test("正式击杀敌人额外摸1张牌再判定胜负，救回与队友死亡均不奖励", async () => {
  const killer=makePlayer("killer",0,"dawn"),enemy=makePlayer("enemy",1,"dusk");
  const {game}=makeGame([killer,enemy]);game.state.deck.cards.push(instance("charge"),instance("block"));enemy.hp=1;
  await game.damage(killer,enemy,1,{canBlock:false});
  assert.equal(enemy.hp,0);assert.equal(enemy.alive,false);assert.equal(killer.hand.length,1);assert.equal(game.state.isGameOver,true);
  assert.ok(game.state.logs.some((entry)=>entry.message===`${killer.name}击杀了${enemy.name}，额外摸了1张牌。`));

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
test("伪造装备区转移不会开启反制窗口或生成公开转移上下文", async () => {
  const actor=makePlayer("actor",0,"dawn"),from=makePlayer("from",1,"dusk"),responder=makePlayer("responder",2,"dusk"),receiver=makePlayer("receiver",3,"dawn");
  const use=instance("transfer"),radar=instance("defenseDevice"),held=instance("block");actor.hand.push(use);from.hand.push(held);from.equipment=radar;responder.hand.push(instance("counter"));
  const {game}=makeGame([actor,from,responder,receiver]);let publicContext=null;game.aiController.responsePolicy.shouldRespond=(_player,_type,context)=>{publicContext=context.publicTransferContext;return false;};const selection=game.cardSelectionSystem.createHiddenSelection(from);
  assert.equal(await game.playCard(actor,use,[],{sourceId:from.id,receiverId:receiver.id,zone:"equipment",equipmentCardId:radar.id,selectionId:selection.selectionId}),false);
  assert.equal(publicContext,null);assert.equal(from.equipment,radar);assert.ok(actor.hand.includes(use));assert.equal(game.state.pendingResponses.length,0);
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

test("真人破坏预选手牌经过双重反制后仍破坏原实体且不泄露私密选择", async () => {
  const source=makePlayer("private-destroy-source",0,"dawn","human"),target=makePlayer("private-destroy-target",1,"dusk"),third=makePlayer("private-destroy-third",2,"dawn");
  const use=instance("destroy"),secret={...instance("charge"),definitionId:"hidden-destroy-definition",name:"隐藏破坏实体标记",description:"隐藏破坏描述标记"},decoy=instance("block"),firstCounter=instance("counter"),secondCounter=instance("counter");
  source.hand.push(use);target.hand.push(secret,decoy,firstCounter);third.hand.push(secondCounter);
  const {game,ui}=makeGame([source,target,third]),contexts=[];forceAvailableAiCounters(game,contexts);
  const selection=await choosePrivateCardThroughInteraction(game,source,use,target,{handIndexes:[0]});
  assert.ok(selection?.selectionId);assert.ok(game.cardSelectionSystem.selections.size>0);
  assert.equal(await game.playCard(source,use,[target],selection),true);
  assert.ok(game.state.deck.discardPile.includes(secret));assert.ok(target.hand.includes(decoy));assert.ok(!target.hand.includes(secret));
  assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.cardSelectionSystem.sessions.size,0);
  for(const context of contexts)assertNoHiddenSelectionLeak(context,[secret]);
  for(const request of ui.responseRequests)assertNoHiddenSelectionLeak(request,[secret]);
});

test("真人掠夺预选手牌经过双重反制后仍获得原实体", async () => {
  const source=makePlayer("private-plunder-source",0,"dawn","human"),target=makePlayer("private-plunder-target",1,"dusk"),third=makePlayer("private-plunder-third",2,"dawn");
  const use=instance("plunder"),secret=instance("harvest"),decoy=instance("charge"),firstCounter=instance("counter"),secondCounter=instance("counter");
  source.hand.push(use);target.hand.push(secret,decoy,firstCounter);third.hand.push(secondCounter);
  const {game}=makeGame([source,target,third]);forceAvailableAiCounters(game);
  const selection=await choosePrivateCardThroughInteraction(game,source,use,target,{handIndexes:[0]});
  assert.equal(await game.playCard(source,use,[target],selection),true);
  assert.ok(source.hand.includes(secret));assert.ok(target.hand.includes(decoy));assert.ok(!target.hand.includes(secret));
  assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.cardSelectionSystem.sessions.size,0);
});

test("真人掠夺预选装备不受目标反制导致的手牌版本变化影响", async () => {
  const source=makePlayer("private-equip-source",0,"dawn","human"),target=makePlayer("private-equip-target",1,"dusk"),third=makePlayer("private-equip-third",2,"dawn");
  const use=instance("plunder"),equipment=instance("defenseDevice"),firstCounter=instance("counter"),secondCounter=instance("counter");
  source.hand.push(use);target.hand.push(firstCounter);target.equipment=equipment;third.hand.push(secondCounter);
  const {game}=makeGame([source,target,third]);forceAvailableAiCounters(game);
  const selection=await choosePrivateCardThroughInteraction(game,source,use,target,{equipment:true});
  assert.equal(await game.playCard(source,use,[target],selection),true);
  assert.equal(target.equipment,null);assert.equal(source.equipment,null);assert.ok(source.hand.includes(equipment));
  assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.cardSelectionSystem.sessions.size,0);
});

test("真人窥探两张手牌经过双重反制后仍只展示反制前确认的实体", async () => {
  const source=makePlayer("private-scout-source",0,"dawn","human"),target=makePlayer("private-scout-target",1,"dusk"),third=makePlayer("private-scout-third",2,"dawn");
  const use=instance("scout"),first=instance("charge"),second=instance("harvest"),counter=instance("counter"),thirdCounter=instance("counter");
  source.hand.push(use);target.hand.push(first,second,counter);third.hand.push(thirdCounter);
  const {game,ui}=makeGame([source,target,third]);forceAvailableAiCounters(game);
  const selection=await choosePrivateCardThroughInteraction(game,source,use,target,{handIndexes:[0,1]});
  assert.equal(await game.playCard(source,use,[target],selection),true);
  assert.deepEqual(ui.reveals.at(-1)?.cards,[first,second]);
  assert.equal(source.aiMemory.knownCardsByPlayer[target.id][first.id],first.definitionId);
  assert.equal(source.aiMemory.knownCardsByPlayer[target.id][second.id],second.definitionId);
  assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.cardSelectionSystem.sessions.size,0);
});

test("反制期间原预选牌离开区域时破坏安全失败且不改选其他牌", async () => {
  const source=makePlayer("private-missing-source",0,"dawn","human"),target=makePlayer("private-missing-target",1,"dusk"),third=makePlayer("private-missing-third",2,"dawn");
  const use=instance("destroy"),selected=instance("charge"),decoy=instance("harvest"),counter=instance("counter"),thirdCounter=instance("counter");
  source.hand.push(use);target.hand.push(selected,decoy,counter);third.hand.push(thirdCounter);
  const {game}=makeGame([source,target,third]);forceAvailableAiCounters(game);let usedEvent=null,moved=false;
  game.eventBus.on("afterCardMove","test:remove-private-destroy-selection",async(event)=>{if(!moved&&event.card===counter){moved=true;await game.discardCardFromHand(target,selected,"反制期间合法移走",{silent:true});}});
  game.eventBus.on("cardUsed","test:private-destroy-safe-failure",(event)=>{if(event.card===use)usedEvent=event;});
  const selection=await choosePrivateCardThroughInteraction(game,source,use,target,{handIndexes:[0]});
  assert.equal(await game.playCard(source,use,[target],selection),true);
  assert.ok(game.state.deck.discardPile.includes(selected));assert.ok(target.hand.includes(decoy));
  assert.equal(usedEvent?.resolved,false);assert.deepEqual(usedEvent?.effectiveTargets,[]);
  assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(game.cardSelectionSystem.sessions.size,0);
});

test("窥探预选两张中一张在反制期间离开时只展示仍在原手牌的一张", async () => {
  const source=makePlayer("private-filter-source",0,"dawn","human"),target=makePlayer("private-filter-target",1,"dusk"),third=makePlayer("private-filter-third",2,"dawn");
  const use=instance("scout"),left=instance("charge"),remains=instance("harvest"),counter=instance("counter"),thirdCounter=instance("counter");
  source.hand.push(use);target.hand.push(left,remains,counter);third.hand.push(thirdCounter);
  const {game,ui}=makeGame([source,target,third]);forceAvailableAiCounters(game);let moved=false;
  game.eventBus.on("afterCardMove","test:remove-one-private-scout-selection",async(event)=>{if(!moved&&event.card===counter){moved=true;await game.discardCardFromHand(target,left,"反制期间合法移走",{silent:true});}});
  const selection=await choosePrivateCardThroughInteraction(game,source,use,target,{handIndexes:[0,1]});
  assert.equal(await game.playCard(source,use,[target],selection),true);
  assert.deepEqual(ui.reveals.at(-1)?.cards,[remains]);
  assert.equal(source.aiMemory.knownCardsByPlayer[target.id]?.[left.id],undefined);
  assert.equal(source.aiMemory.knownCardsByPlayer[target.id][remains.id],remains.definitionId);
});

test("AI 模拟 end 会设置终止状态且终止快照不再生成动作", () => {
  const actor=makePlayer("terminal-actor",0,"dawn","ai",0),enemy=makePlayer("terminal-enemy",1,"dusk"),use=instance("harvest");actor.hand.push(use);
  const {game}=makeGame([actor,enemy]);actor.turnFlags.momentum=2;const visible=createAiVisibleState(actor.id,game.state),terminal=new AiSimulator(visible).apply(visible,{type:"end"},actor.id);
  assert.equal(visible.playPhaseEnded,false);assert.equal(visible.players[0].momentum,2);assert.equal(terminal.playPhaseEnded,true);assert.equal(terminal.players[0].momentum,0);
  assert.deepEqual(game.aiController.actionGenerator.generateFromVisible(terminal,actor.id),[]);
});

test("AI Planner 不扩展 end 根节点，即使动作生成器伪造高收益后续", async () => {
  const actor=makePlayer("terminal-plan-actor",0,"dawn"),enemy=makePlayer("terminal-plan-enemy",1,"dusk"),fiction=instance("harvest");actor.hand.push(fiction);
  const {game}=makeGame([actor,enemy]),visible=createAiVisibleState(actor.id,game.state),planner=game.aiController.planner;
  game.aiController.actionGenerator.generateFromVisible=()=>[{type:"card",card:fiction,targets:[]}];
  planner.evaluator.actionUtility=(action)=>action.type==="card"?10000:0;planner.evaluator.stateUtility=()=>10000;
  const chosen=await planner.plan(actor,visible,[{type:"end"}],{gameId:game.state.gameId});
  assert.equal(chosen.type,"end");assert.equal(planner.lastSearchStats.expanded,1);assert.deepEqual(planner.lastPlannedSequence.map((action)=>action.type),["end"]);
});

test("AI 规划序列中的 end 始终位于末尾且真实 AI 仍能正常结束", async () => {
  const actor=makePlayer("terminal-real-actor",0,"dawn"),enemy=makePlayer("terminal-real-enemy",1,"dusk");
  const {game}=makeGame([actor,enemy]),visible=createAiVisibleState(actor.id,game.state),actions=game.aiController.getLegalActions(actor);
  assert.deepEqual(actions,[{type:"end"}]);assert.equal((await game.aiController.planner.plan(actor,visible,actions,{gameId:game.state.gameId})).type,"end");
  const endIndex=game.aiController.planner.lastPlannedSequence.findIndex((action)=>action.type==="end");assert.equal(endIndex,game.aiController.planner.lastPlannedSequence.length-1);
  await game.takeAiPlayPhase(actor,game.state.gameId);assert.equal(actor.hand.length,0);assert.equal(game.state.phase,"play");
});

test("两张响应牌原子支付成功时统一提交并发送完整移动事件", async () => {
  const player=makePlayer("atomic-success",0,"dawn"),enemy=makePlayer("atomic-success-enemy",1,"dusk"),first=instance("block"),second=instance("block");player.hand.push(first,second);
  const {game}=makeGame([player,enemy]),events=[];game.eventBus.on("afterCardMove","test:atomic-success",(event)=>events.push(event.card));
  const beforeVersion=player.handVersion,result=await game.payCardsFromHandAtomically(player,[first,second],"测试原子支付",{silent:true,expectedCount:2});
  assert.equal(result.status,"used");assert.deepEqual(result.cards,[first,second]);assert.equal(player.hand.length,0);assert.equal(player.handVersion,beforeVersion+1);
  assert.ok(game.state.deck.discardPile.includes(first));assert.ok(game.state.deck.discardPile.includes(second));assert.deepEqual(events,[first,second]);
});

test("第二张 beforeCardMove 取消时原子响应两张牌都保留", async () => {
  const player=makePlayer("atomic-cancel",0,"dawn"),enemy=makePlayer("atomic-cancel-enemy",1,"dusk"),first=instance("block"),second=instance("block");player.hand.push(first,second);
  const {game}=makeGame([player,enemy]);game.eventBus.on("beforeCardMove","test:atomic-cancel",(event)=>{if(event.card===second)event.cancelled=true;});
  const version=player.handVersion,result=await game.payCardsFromHandAtomically(player,[first,second],"测试原子取消",{silent:true,expectedCount:2});
  assert.equal(result.status,"invalid");assert.deepEqual(player.hand,[first,second]);assert.equal(player.handVersion,version);assert.equal(game.state.deck.discardPile.includes(first),false);assert.equal(game.state.deck.discardPile.includes(second),false);
});

test("原子响应支付拒绝已离手实体和重复实体且不移动其余牌", async () => {
  const player=makePlayer("atomic-invalid",0,"dawn"),enemy=makePlayer("atomic-invalid-enemy",1,"dusk"),first=instance("block"),second=instance("block");player.hand.push(first,second);
  const {game}=makeGame([player,enemy]);player.hand.splice(player.hand.indexOf(second),1);
  const missing=await game.payCardsFromHandAtomically(player,[first,second],"测试实体已变化",{silent:true,expectedCount:2});
  assert.equal(missing.status,"invalid");assert.deepEqual(player.hand,[first]);assert.equal(game.state.deck.discardPile.includes(first),false);
  player.hand.push(second);const duplicate=await game.payCardsFromHandAtomically(player,[first,first],"测试重复实体",{silent:true,expectedCount:2});
  assert.equal(duplicate.status,"invalid");assert.deepEqual(player.hand,[first,second]);assert.equal(game.state.deck.discardPile.length,0);
});

test("原子响应支付验证期间 dispose 返回 cancelled 且不消费任何牌", async () => {
  const player=makePlayer("atomic-dispose",0,"dawn"),enemy=makePlayer("atomic-dispose-enemy",1,"dusk"),first=instance("block"),second=instance("block");player.hand.push(first,second);
  const {game}=makeGame([player,enemy]);let openedResolve,release;const opened=new Promise((resolve)=>{openedResolve=resolve;}),gate=new Promise((resolve)=>{release=resolve;});
  game.eventBus.on("beforeCardMove","test:atomic-dispose",async()=>{openedResolve();await gate;});
  const pending=game.payCardsFromHandAtomically(player,[first,second],"测试销毁取消",{silent:true,expectedCount:2});await opened;game.dispose();release();
  const result=await pending;assert.equal(result.status,"cancelled");assert.deepEqual(player.hand,[first,second]);assert.equal(game.state.deck.discardPile.length,0);
});

test("响应系统只有整组原子支付完成后才返回 used", async () => {
  const attacker=makePlayer("atomic-response-attacker",0,"dawn"),defender=makePlayer("atomic-response-defender",1,"dusk","human"),first=instance("block"),second=instance("block");defender.hand.push(first,second);
  const {game}=makeGame([attacker,defender],{response:()=>true});game.eventBus.on("beforeCardMove","test:atomic-response-invalid",(event)=>{if(event.card===second)event.cancelled=true;});
  const result=await game.responseSystem.requestCardResponse(defender,"block",{source:attacker,target:defender,card:instance("assault")},2);
  assert.equal(result.status,"invalid");assert.deepEqual(result.cards,[]);assert.deepEqual(defender.hand,[first,second]);assert.equal(game.state.deck.discardPile.length,0);
});

test("日志角色 token 可在同一行分别按阵营安全着色", () => {
  const dawn=makePlayer("晨方角色",0,"dawn"),dusk=makePlayer("暮方角色",1,"dusk");const {game}=makeGame([dawn,dusk]);
  const entry=game.log(`${dawn.name}对${dusk.name}造成影响。`);
  assert.deepEqual(entry.fragments.filter((fragment)=>fragment.type==="player").map((fragment)=>fragment.battleTeam),["dawn","dusk"]);
  const markup=formatLogEntry(entry);assert.match(markup,/log-player-name team-dawn/);assert.match(markup,/log-player-name team-dusk/);
  assert.match(markup,/造成影响/);
});
test("24 种牌面均不渲染 card-tags 或可见英文 subtype", () => {
  assert.equal(Object.keys(CARD_DEFINITIONS).length,24);
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
test("牌面 CSS 将长描述标记限制在文字区且不再影响外层插画网格", async () => {
  const cards=await readFile(projectFile("css/cards.css"),"utf8"),characters=await readFile(projectFile("css/characters.css"),"utf8"),css=`${cards}\n${characters}`;
  assert.doesNotMatch(css,/\.card-tags/);assert.match(cards,/\.hand-card \.card-rules\.is-description-long \.card-description\s*\{[^}]*font-size:[^}]*line-height:/s);assert.match(cards,/\.hand-card \.card-rules\.is-description-very-long \.card-flavor\s*\{[^}]*display:\s*none/s);
  assert.match(characters,/\.opponent-card-slot \.card-rules\.is-description-very-long \.card-description\s*\{[^}]*font-size:[^}]*line-height:/s);assert.doesNotMatch(css,/\.\w*-?card(?:-slot)?\.is-description-(?:very-)?long\s*\{[^}]*grid-template-rows/s);assert.match(cards,/overflow-wrap:\s*anywhere/);
  const lowHeight=cards.match(/@media \(max-height:\s*920px\)[\s\S]*$/)?.[0]??"";assert.doesNotMatch(lowHeight,/\.card-description\s*\{[^}]*display:\s*none/s);assert.doesNotMatch(cards,/\.card-description\s*\{[^}]*overflow:\s*hidden/s);
});

test("回收站次数只在装备区显示并随真实回合状态重置", () => {
  const player=makePlayer("recycle-ui",0,"dawn","human");
  player.equipment=instance("recycleDevice");
  for(const uses of [0,1,2]){
    player.turnFlags.recycleDeviceUses=uses;
    const equipment=equipmentSlotTemplate(player,true),panel=playerPanelTemplate(player,{isHuman:true});
    assert.match(equipment,new RegExp(`>${uses}/2<`));
    const status=panel.match(/<span class="panel-status"[\s\S]*?<\/span>/)?.[0]??"";
    assert.doesNotMatch(status,/回收站|回收|\d\/2/);
  }
  player.resetTurnFlags({attackLimitPerTurn:2,recoverLimitPerTurn:null});
  assert.match(equipmentSlotTemplate(player,true),/>0\/2</);
  player.equipment=null;
  assert.doesNotMatch(equipmentSlotTemplate(player,true),/>\d\/2</);
});

test("回收站仍严格限制每回合最多触发2次", async () => {
  const owner=makePlayer("recycle-rule",0,"dawn"),enemy=makePlayer("recycle-enemy",1,"dusk");
  const {game}=makeGame([owner,enemy]);owner.equipment=instance("recycleDevice");
  owner.hand.push(instance("exposeWeakness"),instance("exposeWeakness"),instance("exposeWeakness"));
  game.state.deck.cards.push(instance("charge"),instance("block"),instance("shield"));
  await game.playCard(owner,owner.hand[0],[]);await game.playCard(owner,owner.hand[0],[]);await game.playCard(owner,owner.hand[0],[]);
  assert.equal(owner.turnFlags.recycleDeviceUses,2);assert.equal(game.state.logs.filter((entry)=>entry.message.includes("回收站启动")).length,2);
});

test("窃取把3张手牌与1张装备组成单一等概率实体集合", async () => {
  const rolls=[0,.26,.51,.76];
  for(const [expectedIndex,roll] of rolls.entries()){
    const shade=makePlayer(`uniform-shade-${expectedIndex}`,0,"dawn","ai",3),target=makePlayer(`uniform-target-${expectedIndex}`,1,"dusk");
    const cards=[instance("assault"),instance("recover"),instance("charge")],equipment=instance("recycleDevice"),original=instance("battleDevice");
    target.hand.push(...cards);target.equipment=equipment;shade.equipment=original;shade.energy=1;
    const {game}=makeGame([shade,target],{random:()=>roll}),candidate=[...cards,equipment][expectedIndex];
    const shadeVersion=shade.handVersion,targetVersion=target.handVersion;
    assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),true);
    assert.deepEqual(shade.hand,[candidate]);assert.equal(shade.equipment,original);assert.equal(shade.handVersion,shadeVersion+1);
    assert.equal(target.hand.includes(candidate),false);assert.equal(target.equipment===candidate,false);
    assert.equal(game.state.deck.discardPile.includes(candidate),false);assert.equal(game.state.deck.resolvingCards.includes(candidate),false);
    assert.equal(target.handVersion,targetVersion+(expectedIndex<3?1:0));
    const zones=[shade.hand.includes(candidate),shade.equipment===candidate,target.hand.includes(candidate),target.equipment===candidate,game.state.deck.discardPile.includes(candidate)];
    assert.equal(zones.filter(Boolean).length,1);
  }
});

test("真人窃取先选择距离2内敌人再只从该目标随机获得资源", async () => {
  const shade=makePlayer("human-steal-shade",0,"dawn","human",3),allyA=makePlayer("human-steal-ally-a",1,"dawn"),chosen=makePlayer("human-steal-chosen",2,"dusk"),otherEnemy=makePlayer("human-steal-other",3,"dusk"),allyB=makePlayer("human-steal-ally-b",4,"dawn"),chosenEquipment=instance("energyDevice"),untouched=instance("block");chosen.equipment=chosenEquipment;otherEnemy.hand.push(untouched);shade.energy=1;const {game,ui}=makeGame([shade,allyA,chosen,otherEnemy,allyB],{random:()=>0});let offered=null,prompt="";ui.requestTarget=async(players,message)=>{offered=[...players];prompt=message;return chosen;};assert.equal(await game.handleHumanSkill(),true);assert.ok(offered.includes(chosen));assert.ok(offered.includes(otherEnemy));assert.ok(offered.every((player)=>player.battleTeam!==shade.battleTeam&&DistanceSystem.getDistance(game,shade,player)<=2));assert.match(prompt,/窃取.*选择目标/);assert.equal(chosen.equipment,null);assert.ok(shade.hand.includes(chosenEquipment));assert.ok(otherEnemy.hand.includes(untouched));assert.equal(shade.energy,0);
});

test("窃取装备先进入手牌且只有之后正常使用才会装备和替换", async () => {
  const shade=makePlayer("equip-to-hand-shade",0,"dawn","ai",3),target=makePlayer("equip-to-hand-target",1,"dusk"),stolen=instance("energyDevice"),original=instance("battleDevice");
  const {game}=makeGame([shade,target],{random:()=>0});shade.energy=1;shade.equipment=original;target.equipment=stolen;const moves=[];
  game.eventBus.on("afterCardMove","test:steal-equipment-zone",(event)=>{if(event.card===stolen)moves.push([event.from,event.to]);});
  assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),true);
  assert.deepEqual(moves,[["equipment","hand"]]);assert.equal(shade.equipment,original);assert.ok(shade.hand.includes(stolen));assert.equal(shade.turnFlags.recycleDeviceUses,0);
  assert.equal(await game.playCard(shade,stolen,[]),true);assert.equal(shade.equipment,stolen);assert.ok(game.state.deck.discardPile.includes(original));
});

test("窃取消耗1点能量且每回合最多发动2次", async () => {
  const shade=makePlayer("steal-limit",0,"dawn","ai",3),target=makePlayer("steal-limit-target",1,"dusk");target.hand.push(instance("block"),instance("charge"),instance("recover"));
  const {game}=makeGame([shade,target],{random:()=>0});shade.energy=3;
  assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),true);assert.equal(shade.energy,2);
  assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),true);assert.equal(shade.energy,1);
  assert.equal(await game.useActiveSkill(shade,"stealSkill",[target]),false);assert.equal(shade.turnFlags.activeSkillUseCounts.stealSkill,2);assert.equal(target.hand.length,1);
  assert.equal(ACTIVE_SKILLS.stealSkill.cost,1);assert.equal(ACTIVE_SKILLS.stealSkill.limitPerTurn,2);assert.doesNotMatch(GENERAL_DEFINITIONS[3].activeDescription,/直接进入.*装备区|直接装备/);
});

test("AI模拟窃取装备时只增加手牌且保持影客当前装备", () => {
  const shade=makePlayer("sim-steal-shade",0,"dawn","ai",3),target=makePlayer("sim-steal-target",1,"dusk"),current=instance("battleDevice");
  shade.equipment=current;shade.energy=2;target.equipment=instance("energyDevice");const {game}=makeGame([shade,target]);
  const visible=createAiVisibleState(shade.id,game.state),next=new AiSimulator(visible).apply(visible,{type:"skill",skill:ACTIVE_SKILLS.stealSkill,targets:[{id:target.id}]},shade.id);
  const actor=next.players.find((player)=>player.id===shade.id),victim=next.players.find((player)=>player.id===target.id);
  assert.equal(actor.handCount,1);assert.equal(actor.energy,1);assert.equal(actor.activeSkillUses,1);assert.equal(actor.activeSkillUsed,false);assert.equal(actor.equipmentDefinitionId,current.definitionId);assert.equal(victim.equipmentDefinitionId,null);
});

test("窃取说明与README均使用收入手牌的新规则", async () => {
  const readme=await readFile(projectFile("README.md"),"utf8"),description=GENERAL_DEFINITIONS[3].activeDescription;
  assert.equal(GENERAL_DEFINITIONS[3].activeCost,1);assert.equal(GENERAL_DEFINITIONS[3].activeLimitPerTurn,2);assert.equal(ACTIVE_SKILLS.stealSkill.cost,1);assert.equal(ACTIVE_SKILLS.stealSkill.limitPerTurn,2);
  assert.match(description,/消耗1点能量.*选择距离2内.*敌人作为目标/);assert.match(description,/统一候选集合.*等概率随机获得.*收入手牌/);assert.match(description,/每回合最多发动2次/);assert.doesNotMatch(`${description}\n${readme}`,/装备牌直接进入.*装备区|窃取.*直接装备/);
  assert.match(readme,/主动·窃取[^\n]*消耗 1 点能量[^\n]*选择距离 2 内[^\n]*敌人作为目标[^\n]*统一候选集合[^\n]*等概率随机获得[^\n]*一回合最多使用 2 次/);
});

test("窥隙真人选择只私下展示且公共日志与DOM不泄露牌面", async () => {
  const shade=makePlayer("peek-human",0,"dawn","human",3),target=makePlayer("peek-target",1,"dusk"),secrets=[instance("counter"),instance("harvest"),instance("duel")];target.hand.push(...secrets);
  const {game,ui}=makeGame([shade,target]);registerPassiveSkills(game);await game.damage(shade,target,1,{canBlock:false});
  assert.equal(ui.hiddenRequests.length,1);const request=ui.hiddenRequests[0],markup=hiddenSelectionMarkup(request.selection);assert.equal("helpText" in request.options,false);assert.equal("hideHelpText" in request.options,false);
  for(const card of secrets){assert.doesNotMatch(markup,new RegExp(card.id));assert.doesNotMatch(markup,new RegExp(card.definitionId));assert.doesNotMatch(markup,new RegExp(card.name));assert.doesNotMatch(markup,new RegExp(card.description));}
  assert.deepEqual(ui.reveals[0].cards,secrets.slice(0,2));assert.equal(game.cardSelectionSystem.sessions.size,0);assert.equal(game.cardSelectionSystem.selections.size,0);
  const publicLog=game.state.logs.find((entry)=>entry.message.includes("发动窥隙"));assert.equal(publicLog.message,`${shade.name}发动窥隙，查看了${target.name}的2张手牌。`);
  for(const card of secrets)assert.doesNotMatch(publicLog.message,new RegExp(card.name));
});

test("所有隐藏选择池都不显示令牌或核心校验技术提示", async () => {
  const owner=makePlayer("peek-help-owner",0,"dusk"),viewer=makePlayer("peek-help-viewer",1,"dawn","human",3),secret=instance("counter");owner.hand.push(secret);
  const selection={selectionId:"peek-help",tokens:[{token:"opaque-token"}]},panel=makeInteractiveElement();
  const ui={game:null,elements:{response_panel:panel},render(){}};const controller=new InteractionController(ui);
  const pending=controller.requestHiddenCards(selection,1,"掠夺：选择手牌或装备",{viewer,owner,helpText:"手牌使用安全令牌；装备牌为公开信息，确认时核心会重新验证所在区域。"});
  assert.doesNotMatch(panel.innerHTML,/安全令牌|临时令牌|核心会重新|handVersion|校验手牌版本/);assert.doesNotMatch(panel.innerHTML,/<p>/);
  controller.cancel();assert.equal(await pending,null);
});
test("互利、窥隙和隐藏选择牌池为选中上移预留空间且不拉伸牌面", async () => {
  const css=await readFile(projectFile("css/cards.css"),"utf8"),selection=hiddenSelectionMarkup({tokens:[{token:"opaque-a"}]});
  assert.match(css,/\.hidden-card-grid,\s*\.private-card-grid,\s*\.tableau-cards\s*\{[^}]*align-items:\s*flex-start[^}]*margin:\s*16px 0 12px/s);
  assert.match(css,/\.hidden-card-grid\s*\{\s*gap:\s*9px/);
  assert.match(css,/\.tableau-cards \.hand-card\.is-selected\s*\{\s*transform:\s*translateY\(-7px\)/s);
  assert.match(css,/\.hidden-card-grid \.hand-card\.is-selected[^}]*translateY\(-7px\)/s);
  assert.match(selection,/hidden-card-back is-compact/);
});

test("窥隙目标仅1张手牌时最多选择并展示1张", async () => {
  const shade=makePlayer("peek-one",0,"dawn","human",3),target=makePlayer("peek-one-target",1,"dusk"),only=instance("counter");target.hand.push(only);
  const {game,ui}=makeGame([shade,target]);registerPassiveSkills(game);await game.damage(shade,target,1,{canBlock:false});
  assert.equal(ui.hiddenRequests[0].count,1);assert.deepEqual(ui.reveals[0].cards,[only]);
});

test("窥隙等待期间已选牌离手时只展示仍在原手牌的实体", async () => {
  const shade=makePlayer("peek-changing",0,"dawn","human",3),target=makePlayer("peek-changing-target",1,"dusk"),first=instance("counter"),second=instance("harvest"),third=instance("duel");target.hand.push(first,second,third);
  const {game,ui}=makeGame([shade,target]);registerPassiveSkills(game);
  ui.requestHiddenCards=async(selection)=>{target.hand.splice(target.hand.indexOf(first),1);target.bumpHandVersion();game.state.deck.discard(first);return selection.tokens.slice(0,2).map((entry)=>entry.token);};
  await game.damage(shade,target,1,{canBlock:false});assert.deepEqual(ui.reveals[0].cards,[second]);
  assert.deepEqual(Object.keys(shade.aiMemory.knownCardsByPlayer[target.id]),[second.id]);assert.ok(!ui.reveals[0].cards.includes(third));
  assert.equal(game.cardSelectionSystem.sessions.size,0);assert.equal(game.cardSelectionSystem.selections.size,0);
});

test("窥隙同回合仅触发一次且格挡、护盾、队友和空手牌均不触发", async () => {
  const shade=makePlayer("peek-once",0,"dawn","human",3),target=makePlayer("peek-once-target",1,"dusk");target.hand.push(instance("charge"),instance("harvest"),instance("duel"));
  const {game,ui}=makeGame([shade,target]);registerPassiveSkills(game);await game.damage(shade,target,1,{canBlock:false});await game.damage(shade,target,1,{canBlock:false});assert.equal(ui.hiddenRequests.length,1);

  const shieldShade=makePlayer("peek-shield",0,"dawn","human",3),shieldTarget=makePlayer("peek-shield-target",1,"dusk");shieldTarget.shield=1;shieldTarget.hand.push(instance("charge"));const shieldFixture=makeGame([shieldShade,shieldTarget]);registerPassiveSkills(shieldFixture.game);await shieldFixture.game.damage(shieldShade,shieldTarget,1,{canBlock:false});assert.equal(shieldFixture.ui.hiddenRequests.length,0);

  const blockShade=makePlayer("peek-block",0,"dawn","human",3),blockTarget=makePlayer("peek-block-target",1,"dusk","human");blockTarget.hand.push(instance("block"),instance("charge"));const blockFixture=makeGame([blockShade,blockTarget],{response:(request)=>request.type==="block"});registerPassiveSkills(blockFixture.game);await blockFixture.game.damage(blockShade,blockTarget,1,{card:instance("assault"),canBlock:true});assert.equal(blockFixture.ui.hiddenRequests.length,0);

  const allyShade=makePlayer("peek-ally",0,"dawn","human",3),ally=makePlayer("peek-ally-target",1,"dawn");ally.hand.push(instance("charge"));const allyFixture=makeGame([allyShade,ally]);registerPassiveSkills(allyFixture.game);await allyFixture.game.damage(allyShade,ally,1,{canBlock:false});assert.equal(allyFixture.ui.hiddenRequests.length,0);

  const emptyShade=makePlayer("peek-empty",0,"dawn","human",3),emptyTarget=makePlayer("peek-empty-target",1,"dusk");const emptyFixture=makeGame([emptyShade,emptyTarget]);registerPassiveSkills(emptyFixture.game);await emptyFixture.game.damage(emptyShade,emptyTarget,1,{canBlock:false});assert.equal(emptyFixture.ui.hiddenRequests.length,0);
});

test("窥隙隐藏选择期间dispose会收束Promise并清理令牌", async () => {
  const shade=makePlayer("peek-dispose",0,"dawn","human",3),target=makePlayer("peek-dispose-target",1,"dusk");target.hand.push(instance("charge"),instance("harvest"));
  const {game,ui}=makeGame([shade,target]);registerPassiveSkills(game);let openedResolve,settle;const opened=new Promise((resolve)=>{openedResolve=resolve;});
  ui.requestHiddenCards=()=>new Promise((resolve)=>{settle=resolve;openedResolve();});const baseCancel=ui.cancelPendingInteractions.bind(ui);ui.cancelPendingInteractions=()=>{baseCancel();settle?.(null);};
  const pending=game.damage(shade,target,1,{canBlock:false});await opened;assert.equal(game.cardSelectionSystem.sessions.size,1);game.dispose();await pending;
  assert.equal(game.cardSelectionSystem.sessions.size,0);assert.equal(game.cardSelectionSystem.selections.size,0);assert.equal(ui.reveals.length,0);
});

test("AI窥隙按未知位置选择且只更新自己的私密记忆", async () => {
  const shade=makePlayer("peek-ai",0,"dawn","ai",3),ally=makePlayer("peek-ai-ally",1,"dawn","ai",0),target=makePlayer("peek-ai-target",2,"dusk");let definitionReads=0;
  const cards=[instance("counter"),instance("harvest"),instance("duel")];for(const card of cards){const value=card.definitionId;Object.defineProperty(card,"definitionId",{configurable:true,get(){definitionReads+=1;return value;}});}target.hand.push(...cards);
  const {game,ui}=makeGame([shade,ally,target],{random:()=>0});registerPassiveSkills(game);await game.damage(shade,target,1,{canBlock:false});
  assert.equal(definitionReads,2);assert.deepEqual(Object.keys(shade.aiMemory.knownCardsByPlayer[target.id]),cards.slice(0,2).map((card)=>card.id));
  assert.equal(Object.keys(ally.aiMemory.knownCardsByPlayer[target.id]??{}).length,0);assert.equal(ui.reveals.length,0);
});

test("全部卡牌SVG使用统一480x280画布且配置引用均存在", async () => {
  const files=(await readdir(projectFile("assets/cards"))).filter((name)=>name.endsWith(".svg")).sort();assert.ok(files.length>0);
  for(const name of files){const source=await readFile(projectFile(`assets/cards/${name}`),"utf8"),root=source.match(/<svg\b[^>]*>/)?.[0]??"";assert.match(root,/\bwidth="480"/i,name);assert.match(root,/\bheight="280"/i,name);assert.match(root,/\bviewBox="0 0 480 280"/i,name);}
  for(const definition of Object.values(CARD_DEFINITIONS))await access(projectFile(definition.art.replace(/^\.\//,"")));
  const shield=await readFile(projectFile("assets/cards/shield.svg"),"utf8"),assault=await readFile(projectFile("assets/cards/assault.svg"),"utf8"),transfer=await readFile(projectFile("assets/cards/transfer.svg"),"utf8");
  for(const source of [shield,assault,transfer])assert.match(source,/^<svg width="480" height="280" viewBox="0 0 480 280"/);
});

test("卡牌CSS在手牌、结算、私密展示、判定和装备区统一约束图片尺寸", async () => {
  const cards=await readFile(projectFile("css/cards.css"),"utf8"),characters=await readFile(projectFile("css/characters.css"),"utf8");
  for(const selector of [".card-art > img",".resolving-card > img",".judgment-view img"]){const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");assert.match(cards,new RegExp(`${escaped}\\s*\\{[^}]*display:\\s*block[^}]*width:\\s*[^;]+;[^}]*height:\\s*[^;]+;[^}]*object-fit:\\s*(?:cover|contain)`,"s"),selector);}
  assert.match(characters,/\.equipment-icon\s*\{[^}]*display:\s*block[^}]*width:\s*[^;]+;[^}]*height:\s*[^;]+;[^}]*object-fit:\s*cover/s);
});

test("窥隙结果牌与正常手牌共用完整牌面布局且不暴露实体ID", async () => {
  const card=instance("counter"),normal=handCardTemplate(card),revealed=privateCardTemplate(card),face=(markup)=>markup.replace(/^<[^>]+>\s*/,"").replace(/\s*<\/(?:button|article)>$/,"");
  for(const className of ["card-topline","card-name","card-category","card-art","card-crest","card-rules","card-description","card-flavor"])assert.match(revealed,new RegExp(`class="[^"]*${className}`),className);
  assert.equal(face(revealed),face(normal));assert.match(revealed,/class="hand-card private-card frame-seal"/);assert.doesNotMatch(revealed,/data-card-id|data-disabled|aria-pressed/);assert.doesNotMatch(revealed,new RegExp(card.id));
  const css=await readFile(projectFile("css/cards.css"),"utf8");assert.match(css,/\.private-card\.hand-card\s*\{[^}]*font-weight:\s*400;[^}]*cursor:\s*default;/s);assert.doesNotMatch(css,/\.private-card\s*,\s*\.tableau-card|\.private-card\s+img/);
});

test("所有牌框保持相同内容宽度且机械双线不再挤压牌面", async () => {
  const css=await readFile(projectFile("css/cards.css"),"utf8");
  assert.match(css,/\.hand-card\s*\{[^}]*border:\s*2px\s+solid/s);
  assert.match(css,/\.frame-machine\s*\{[^}]*border-style:\s*solid;[^}]*border-width:\s*2px;/s);
  assert.match(css,/\.frame-machine::before\s*\{[^}]*border-style:\s*double;[^}]*border-width:\s*3px;/s);
  assert.doesNotMatch(css,/\.frame-machine\s*\{[^}]*border-width:\s*4px/s);
});

test("护盾和反制等长描述牌与普通牌保持相同插画高度", async () => {
  const cards=await readFile(projectFile("css/cards.css"),"utf8"),characters=await readFile(projectFile("css/characters.css"),"utf8");
  assert.match(cards,/\.hand-card\s*\{[^}]*grid-template-rows:\s*37px\s+72px\s+minmax\(0,\s*1fr\)/s);
  assert.match(cards,/\.hand-card\s*>\s*\.card-art\s*\{[^}]*height:\s*72px;[^}]*min-height:\s*72px;[^}]*max-height:\s*72px;/s);
  assert.match(cards,/@media\s*\(max-height:\s*920px\)[\s\S]*?\.hand-card\s*\{[^}]*grid-template-rows:\s*32px\s+66px\s+minmax\(0,\s*1fr\)/s);
  assert.match(cards,/@media\s*\(max-height:\s*920px\)[\s\S]*?\.hand-card\s*>\s*\.card-art\s*\{[^}]*height:\s*66px;[^}]*min-height:\s*66px;[^}]*max-height:\s*66px;/s);
  assert.match(characters,/\.opponent-card-slot\s*\{[^}]*grid-template-rows:\s*27px\s+70px\s+minmax\(0,\s*1fr\)/s);
  assert.match(characters,/\.opponent-card-slot\s*>\s*\.card-art\s*\{[^}]*height:\s*70px;[^}]*min-height:\s*70px;[^}]*max-height:\s*70px;/s);
  assert.doesNotMatch(`${cards}\n${characters}`,/\.\w*-?card(?:-slot)?\.is-description-(?:very-)?long\s*\{[^}]*grid-template-rows/s);
});

test("反制护盾和军火库的长描述标记只进入文字区并由末尾规则锁定插画高度", async () => {
  const cards=await readFile(projectFile("css/cards.css"),"utf8");
  for(const definitionId of ["counter","shield","battleDevice"]){
    const markup=handCardTemplate(instance(definitionId));
    assert.doesNotMatch(markup,/^<button class="[^"]*is-description-(?:very-)?long/);
    assert.match(markup,/class="card-rules is-description-(?:very-)?long"/);
  }
  assert.match(cards,/牌面插画高度是跨卡牌不变量/);
  assert.match(cards,/\.hand-card\s*>\s*\.card-art\s*\{[^}]*block-size:\s*72px\s*!important;[^}]*min-block-size:\s*72px\s*!important;[^}]*max-block-size:\s*72px\s*!important;/s);
  assert.match(cards,/@media\s*\(max-height:\s*920px\)[\s\S]*?\.hand-card\s*>\s*\.card-art\s*\{[^}]*block-size:\s*66px\s*!important;/s);
});

test("击杀奖励配置为1且AI模拟使用同一奖励数量", () => {
  const killer=makePlayer("sim-killer",0,"dawn"),target=makePlayer("sim-victim",1,"dusk"),assault=instance("assault");killer.hand.push(assault);target.hp=1;target.statuses={exposeWeakness:{stacks:2},huntMark:{sourceId:"hunter"},allIn:{assaultBonus:1}};target.turnFlags.momentum=2;
  const {game}=makeGame([killer,target]),visible=createAiVisibleState(killer.id,game.state),next=new AiSimulator(visible).apply(visible,{type:"card",card:assault,targets:[{id:target.id}]},killer.id);
  const simulatedTarget=next.players.find((player)=>player.id===target.id);
  assert.equal(GAME_CONFIG.killRewardDrawCount,1);assert.equal(simulatedTarget.alive,false);assert.equal(next.players.find((player)=>player.id===killer.id).handCount,1);assert.deepEqual([simulatedTarget.exposeWeaknessStacks,simulatedTarget.assaultBonus,simulatedTarget.huntMarkSourceId,simulatedTarget.momentum,simulatedTarget.statuses],[0,0,null,0,[]]);
});

test("正式阵亡会在首次界面刷新前清空状态和连势", async () => {
  const source=makePlayer("death-source",0,"dawn"),target=makePlayer("death-target",1,"dusk"),survivor=makePlayer("death-survivor",2,"dusk"),{game,ui}=makeGame([source,target,survivor]);
  target.hp=0;target.statuses={exposeWeakness:{stacks:2},huntMark:{sourceId:source.id},allIn:{assaultBonus:1}};target.turnFlags.momentum=3;
  const snapshots=[];const originalRender=ui.render.bind(ui);ui.render=(renderedGame)=>{snapshots.push({statuses:{...target.statuses},momentum:target.turnFlags.momentum,alive:target.alive});return originalRender(renderedGame);};
  assert.equal(await game.dyingSystem.kill(target,source),true);assert.deepEqual(target.statuses,{});assert.equal(target.turnFlags.momentum,0);assert.equal(target.alive,false);assert.deepEqual(snapshots[0],{statuses:{},momentum:0,alive:false});
});

test("无明确来源的死亡不奖励且连续击杀两个敌人各奖励1张", async () => {
  const current=makePlayer("no-source-current",0,"dawn"),victim=makePlayer("no-source-victim",1,"dusk"),other=makePlayer("no-source-other",2,"dusk");victim.hp=0;
  const noSource=makeGame([current,victim,other]);noSource.game.state.deck.cards.push(instance("charge"));await noSource.game.dyingSystem.kill(victim,null);assert.equal(current.hand.length,0);

  const killer=makePlayer("double-killer",0,"dawn"),ally=makePlayer("double-ally",1,"dawn"),enemyA=makePlayer("double-enemy-a",2,"dusk"),enemyB=makePlayer("double-enemy-b",3,"dusk");enemyA.hp=1;enemyB.hp=1;
  const fixture=makeGame([killer,ally,enemyA,enemyB]);fixture.game.state.deck.cards.push(instance("charge"),instance("block"));let rewards=0;fixture.game.eventBus.on("enemyKilled","test:count-kill-reward",()=>{rewards+=1;});
  await fixture.game.damage(killer,enemyA,1,{canBlock:false});await fixture.game.damage(killer,enemyB,1,{canBlock:false});
  assert.equal(killer.hand.length,2);assert.equal(rewards,2);assert.equal(await fixture.game.dyingSystem.kill(enemyB,killer),false);assert.equal(killer.hand.length,2);
});

test("击杀奖励README与规则文本统一为额外摸1张", async () => {
  const readme=await readFile(projectFile("README.md"),"utf8"),sources=(await Promise.all((await listJavaScriptFiles()).map((file)=>readFile(file,"utf8")))).join("\n");
  assert.match(readme,/杀死敌方角色后.*额外摸 1 张牌/);assert.doesNotMatch(`${readme}\n${sources}`,/击杀[^\n]{0,20}摸(?:了)?2张|杀死敌人[^\n]{0,20}摸2张/);
});

test("AI 转移联合距离分支共享同一望远镜且效果按概率缩放", () => {
  const state={playPhaseEnded:false,players:[
    {id:"z-actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:1,hand:[{id:"move",definitionId:"transfer"}],equipmentDefinitionId:"telescope",equipmentRetentionProbability:.4,counterProbability:0},
    {id:"near",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:0,counterProbability:0},
    {id:"source",seatIndex:2,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:2,counterProbability:0},
    {id:"a-receiver",seatIndex:3,battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0,counterProbability:0},
    {id:"tail",seatIndex:4,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:0,counterProbability:0}
  ]};
  const {game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const actions=game.aiController.actionGenerator.generateFromVisible(state,"z-actor");
  const transfer=actions.find((action)=>action.card?.id==="move");
  assert.equal(transfer.selection.sourceId,"source");assert.equal(transfer.selection.receiverId,"a-receiver");
  assertClose(transfer.executionProbability,.4);
  const next=new AiSimulator(state).apply(state,transfer,"z-actor");
  assertClose(next.players[0].handCount,.6);assertClose(next.players[2].handCount,1.6);assertClose(next.players[3].handCount,.4);
});

test("AI 掠夺和固定距离窃取按真实距离分支缩放全部资源", () => {
  const basePlayers=[
    {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:2,handCount:1,hand:[{id:"loot",definitionId:"plunder"}],equipmentDefinitionId:"telescope",equipmentRetentionProbability:.4,counterProbability:0,activeSkillId:"stealSkill",activeSkillUses:0,activeSkillLimit:2,activeSkillUsed:false},
    {id:"p1",seatIndex:1,battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"p2",seatIndex:2,battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"target",seatIndex:3,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,counterProbability:0},
    {id:"p4",seatIndex:4,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"p5",seatIndex:5,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:0}
  ];
  const {game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const plunder=game.aiController.actionGenerator.generateFromVisible({playPhaseEnded:false,players:structuredClone(basePlayers)},"actor")
    .find((action)=>action.card?.id==="loot");
  assertClose(plunder.executionProbability,.4);
  const plundered=new AiSimulator({players:basePlayers}).apply({players:basePlayers},plunder,"actor");
  assertClose(plundered.players[0].handCount,1);assertClose(plundered.players[3].handCount,.6);

  const skillState={playPhaseEnded:false,players:structuredClone(basePlayers)};
  skillState.players[0].hand=[];skillState.players[0].handCount=0;
  const steal=game.aiController.actionGenerator.generateFromVisible(skillState,"actor")
    .find((action)=>action.type==="skill"&&action.skill.id==="stealSkill"&&action.targets[0].id==="target");
  assertClose(steal.executionProbability,.4);
  const stolen=new AiSimulator(skillState).apply(skillState,steal,"actor");
  assertClose(stolen.players[0].energy,1.6);assertClose(stolen.players[0].activeSkillUses,.4);
  assertClose(stolen.players[0].handCount,.4);assertClose(stolen.players[3].handCount,.6);
});

test("确定合法距离保持概率1且条件技能次数不会重复消费同一分支", () => {
  const state={playPhaseEnded:false,players:[
    {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:2,handCount:0,hand:[],activeSkillId:"stealSkill",activeSkillUses:0,activeSkillLimit:2,activeSkillUsed:false},
    {id:"target",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:2}
  ]};
  const {game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const first=game.aiController.actionGenerator.generateFromVisible(state,"actor").find((action)=>action.type==="skill");
  assert.equal(first.executionProbability,1);
  const once=new AiSimulator(state).apply(state,first,"actor");
  const second=game.aiController.actionGenerator.generateFromVisible(once,"actor").find((action)=>action.type==="skill");
  assert.equal(second.executionProbability,1);assert.notEqual(second.skillUseSlot,first.skillUseSlot);
  const twice=new AiSimulator(once).apply(once,second,"actor");
  assert.ok(!game.aiController.actionGenerator.generateFromVisible(twice,"actor").some((action)=>action.type==="skill"));
});

test("同一卡牌只消费相交分支，另一张牌仍可复用同一望远镜世界", () => {
  const state={playPhaseEnded:false,players:[
    {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:2,hand:[{id:"one",definitionId:"assault"},{id:"two",definitionId:"assault"}],attackUsed:0,attackLimit:2,attackRange:1,equipmentDefinitionId:"telescope",equipmentRetentionProbability:.4},
    {id:"near",seatIndex:1,battleTeam:"dusk",alive:true,hp:6,maxHp:6,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0},
    {id:"far",seatIndex:2,battleTeam:"dusk",alive:true,hp:6,maxHp:6,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0},
    {id:"ally",seatIndex:3,battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"tail",seatIndex:4,battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0}
  ]};
  const {game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const generated=game.aiController.actionGenerator.generateFromVisible(state,"actor");
  const farFirst=generated.find((action)=>action.card?.id==="one"&&action.targets[0]?.id==="far");
  assertClose(farFirst.executionProbability,.4);
  const once=new AiSimulator(state).apply(state,farFirst,"actor");
  const follow=game.aiController.actionGenerator.generateFromVisible(once,"actor");
  assert.ok(!follow.some((action)=>action.card?.id==="one"&&action.targets[0]?.id==="far"));
  assertClose(follow.find((action)=>action.card?.id==="one"&&action.targets[0]?.id==="near").executionProbability,.6);
  assertClose(follow.find((action)=>action.card?.id==="two"&&action.targets[0]?.id==="far").executionProbability,.4);
});

test("望远镜与目标屏障组合分支各计一次且不重复质量", () => {
  const source={id:"source",seatIndex:0,battleTeam:"dawn",alive:true,equipmentDefinitionId:"telescope",equipmentRetentionProbability:.4};
  const target={id:"target",seatIndex:2,battleTeam:"dusk",alive:true,equipmentDefinitionId:"barrierDevice",equipmentRetentionProbability:.25};
  const game={state:{players:[source,{id:"middle",seatIndex:1,alive:true},target,{id:"tail",seatIndex:3,alive:true}]}};
  const branches=DistanceSystem.getRangeConditionBranches(game,{source,target,range:1});
  assert.equal(branches.length,4);assertClose(branches.reduce((sum,branch)=>sum+branch.probability,0),1);
  assert.equal(new Set(branches.map((branch)=>JSON.stringify(branch.conditions))).size,4);
  assertClose(branches.filter((branch)=>branch.matches).reduce((sum,branch)=>sum+branch.probability,0),.3);
});

test("概率猎印生成猎杀并按0.4缩放成本次数伤害格挡和摸牌", () => {
  const state={playPhaseEnded:false,players:[
    {id:"hunter",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:2,handCount:0,activeSkillId:"hunt",activeSkillUses:0,activeSkillLimit:2,activeSkillUsed:false},
    {id:"marked",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,blockProbability:.5,twoBlockProbability:0,huntMarkSourceId:null,huntMarkProbability:.4,huntMarkProbabilities:{hunter:.4},statuses:[],expectedRecoverCount:0}
  ]};
  const {game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const hunt=game.aiController.actionGenerator.generateFromVisible(state,"hunter").find((action)=>action.skill?.id==="hunt");
  assertClose(hunt.executionProbability,.4);
  const next=new AiSimulator(state).apply(state,hunt,"hunter");
  assertClose(next.players[0].energy,1.2);assertClose(next.players[0].activeSkillUses,.4);assertClose(next.players[0].handCount,.2);
  assertClose(next.players[1].hp,3.6);assertClose(next.players[1].handCount,.8);assertClose(next.players[1].huntMarkProbabilities.hunter,0);
  assert.ok(!game.aiController.actionGenerator.generateFromVisible(next,"hunter").some((action)=>action.skill?.id==="hunt"));
});

test("完整猎印概率1保持真实猎杀的完整成本和伤害", () => {
  const state={players:[
    {id:"hunter",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:2,handCount:0,activeSkillUses:0,activeSkillLimit:2},
    {id:"marked",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,huntMarkSourceId:"hunter",huntMarkProbabilities:{hunter:1},statuses:["huntMark"],expectedRecoverCount:0}
  ]};
  const action={type:"skill",skill:ACTIVE_SKILLS.hunt,targets:[{id:"marked"}],executionProbability:1};
  const next=new AiSimulator(state).apply(state,action,"hunter");
  assert.equal(next.players[0].energy,0);assert.equal(next.players[0].activeSkillUses,1);assert.equal(next.players[1].hp,2);assert.equal(next.players[1].huntMarkSourceId,null);
});

test("雷达战术判定免疫且不消耗原格挡，基础与装备判定按真实顺序结算", () => {
  const simulator=new AiSimulator({players:[]});
  const run=({handCount,blockProbability,judgment})=>{const state={players:[
    {id:"attacker",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount,blockProbability,twoBlockProbability:0,equipmentDefinitionId:"defenseDevice",equipmentRetentionProbability:1,expectedRecoverCount:0}
  ]};simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:true,deviceAttack:true,radarJudgmentProbabilities:judgment});return state.players[1];};
  const tactic=run({handCount:1,blockProbability:1,judgment:{block:0,otherBasic:0,equipment:0}});
  assert.equal(tactic.hp,4);assert.equal(tactic.handCount,1);
  const judgedBlock=run({handCount:0,blockProbability:0,judgment:{block:1,otherBasic:0,equipment:0}});
  assert.equal(judgedBlock.hp,4);assert.equal(judgedBlock.handCount,0);
  const otherBasic=run({handCount:0,blockProbability:0,judgment:{block:0,otherBasic:1,equipment:0}});
  assert.equal(otherBasic.hp,3);assert.equal(otherBasic.handCount,1);
  const equipment=run({handCount:1,blockProbability:1,judgment:{block:0,otherBasic:0,equipment:1}});
  assert.equal(equipment.hp,4);assert.equal(equipment.handCount,0);
});

test("军火库雷达判得格挡后仍要求原手牌另有一张格挡", () => {
  const simulator=new AiSimulator({players:[]});
  const run=(normalBlockChance,handCount)=>{const state={players:[
    {id:"attacker",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1},
    {id:"target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount,blockProbability:normalBlockChance,twoBlockProbability:0,equipmentDefinitionId:"defenseDevice",equipmentRetentionProbability:1,expectedRecoverCount:0}
  ]};simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:true,deviceAttack:true,radarJudgmentProbabilities:{block:1,otherBasic:0,equipment:0}});return state.players[1];};
  const withoutOriginal=run(0,0);assert.equal(withoutOriginal.hp,3);assert.equal(withoutOriginal.handCount,1);
  const withOriginal=run(1,1);assert.equal(withOriginal.hp,4);assert.equal(withOriginal.handCount,0);
});

test("部分概率攻击额外缩放雷达得牌、格挡消耗与最终伤害", () => {
  const state={players:[
    {id:"attacker",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,blockProbability:.5,twoBlockProbability:0,equipmentDefinitionId:"defenseDevice",equipmentRetentionProbability:1,expectedRecoverCount:0}
  ]};
  new AiSimulator(state).applyDamage(state,state.players[0],state.players[1],1,{
    canBlock:true,deviceAttack:true,eventProbability:.4,
    radarJudgmentProbabilities:{block:0,otherBasic:1,equipment:0}
  });
  assertClose(state.players[1].hp,3.8);assertClose(state.players[1].handCount,1.2);
});

const conditionalAssaultState = (attackLimit) => ({ playPhaseEnded:false, players:[
  {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,maxEnergy:4,handCount:2,hand:[{id:"one",definitionId:"assault"},{id:"two",definitionId:"assault"}],attackUsed:0,attackLimit,attackRange:1,equipmentDefinitionId:"telescope",equipmentRetentionProbability:.4},
  {id:"middle",seatIndex:1,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0},
  {id:"far",seatIndex:2,battleTeam:"dusk",alive:true,hp:8,maxHp:8,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,expectedRecoverCount:0},
  {id:"near",seatIndex:3,battleTeam:"dusk",alive:true,hp:8,maxHp:8,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,expectedRecoverCount:0}
] });

test("概率突袭次数槽阻止两张牌重复消费同一望远镜世界", () => {
  const state=conditionalAssaultState(1),{game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const first=game.aiController.actionGenerator.generateFromVisible(state,"actor").find((action)=>action.card?.id==="one"&&action.targets[0]?.id==="far");
  assertClose(first.executionProbability,.4);
  const once=new AiSimulator(state).apply(state,first,"actor"),follow=game.aiController.actionGenerator.generateFromVisible(once,"actor");
  assertClose(once.players[0].attackUsed,.4);
  assert.ok(!follow.some((action)=>action.card?.id==="two"&&action.targets[0]?.id==="far"));
  assertClose(follow.find((action)=>action.card?.id==="one"&&action.targets[0]?.id==="near").executionProbability,.6);
});

test("两个概率突袭次数槽可在同一望远镜世界各消费一次", () => {
  const state=conditionalAssaultState(2),{game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const first=game.aiController.actionGenerator.generateFromVisible(state,"actor").find((action)=>action.card?.id==="one"&&action.targets[0]?.id==="far");
  const once=new AiSimulator(state).apply(state,first,"actor");
  const second=game.aiController.actionGenerator.generateFromVisible(once,"actor").find((action)=>action.card?.id==="two"&&action.targets[0]?.id==="far");
  assertClose(second.executionProbability,.4);assert.notEqual(second.attackUseSlot,first.attackUseSlot);
  const twice=new AiSimulator(once).apply(once,second,"actor");assertClose(twice.players[0].attackUsed,.8);
});

test("借势强制突袭复用真实次数槽且震荡不消费次数槽", () => {
  const leverageState={players:[
    {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:2,hand:[{id:"l1",definitionId:"leverage"},{id:"l2",definitionId:"leverage"}],counterProbability:0},
    {id:"first",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:2,attackUsed:0,attackLimit:1,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1,assaultResponseProbability:1,expectedAssaultCount:2,blockProbability:0,counterProbability:0},
    {id:"second",seatIndex:2,battleTeam:"dawn",alive:true,hp:8,maxHp:8,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,counterProbability:0}
  ]},simulator=new AiSimulator(leverageState),action=(id)=>({type:"card",card:{...CARD_DEFINITIONS.leverage,id},targets:[{id:"first"},{id:"second"}],selection:{firstTargetId:"first",secondTargetId:"second"}}),once=simulator.apply(leverageState,action("l1"),"actor"),twice=simulator.apply(once,action("l2"),"actor");
  assert.ok(once.players[1].attackUsed>0&&once.players[1].attackUsed<1);assert.ok(twice.players[1].attackUsed>once.players[1].attackUsed&&twice.players[1].attackUsed<=1);

  const shockState={players:[{id:"source",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:2,hand:[{id:"shock",definitionId:"shockwave"},{id:"hit",definitionId:"assault"}],attackUsed:0,attackLimit:1,counterProbability:0},{id:"enemy",battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,counterProbability:0,expectedRecoverCount:0}]};
  const shocked=new AiSimulator(shockState).apply(shockState,{type:"card",card:{...CARD_DEFINITIONS.shockwave,id:"shock"},targets:[{id:"enemy"}]},"source");assertClose(shocked.players[0].attackUsed,0);
  const assaulted=new AiSimulator(shocked).apply(shocked,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"hit"},targets:[{id:"enemy"}]},"source");assertClose(assaulted.players[0].attackUsed,1);
});

test("概率破军只在发动世界新增可用突袭次数槽", () => {
  const shared="break-army-energy",state={playPhaseEnded:false,players:[
    {id:"blade",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:.8,maxEnergy:4,energyBranches:[{probability:.4,conditions:{[shared]:"yes"},amount:2},{probability:.6,conditions:{[shared]:"no"},amount:0}],handCount:1,hand:[{id:"hit",definitionId:"assault"}],attackUsed:1,attackLimit:1,attackRange:1,activeSkillId:"breakArmy",activeSkillUses:0,activeSkillLimit:1},
    {id:"enemy",seatIndex:1,battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,expectedRecoverCount:0}
  ]},{game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const skill=game.aiController.actionGenerator.generateFromVisible(state,"blade").find((action)=>action.skill?.id==="breakArmy");assertClose(skill.executionProbability,.4);
  const boosted=new AiSimulator(state).apply(state,skill,"blade");assertClose(boosted.players[0].attackLimit,1.4);
  const assault=game.aiController.actionGenerator.generateFromVisible(boosted,"blade").find((action)=>action.card?.id==="hit");assertClose(assault.executionProbability,.4);
});

test("概率伤害先逐世界结算护盾再汇总期望", () => {
  const run=({amount,eventProbability,shield,blockProbability=0})=>{const state={players:[
    {id:"attacker",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},
    {id:"target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield,handCount:blockProbability?1:0,blockProbability,twoBlockProbability:0,expectedRecoverCount:0}
  ]};const simulator=new AiSimulator(state),outcome={},damage=simulator.applyDamage(state,state.players[0],state.players[1],amount,{canBlock:blockProbability>0,eventProbability,outcome});return {state,target:state.players[1],damage,outcome};};
  let result=run({amount:2,eventProbability:.4,shield:1});assertClose(result.target.shield,.6);assertClose(result.target.hp,3.6);assertClose(result.damage,.4);assertClose(result.outcome.lifeDamageChance,.4);
  result=run({amount:1,eventProbability:.4,shield:1});assertClose(result.target.shield,.6);assertClose(result.target.hp,4);
  result=run({amount:2,eventProbability:.4,shield:2});assertClose(result.target.shield,1.2);assertClose(result.target.hp,4);
  result=run({amount:2,eventProbability:.4,shield:1,blockProbability:.5});assertClose(result.target.shield,.8);assertClose(result.target.hp,3.8);assertClose(result.target.handCount,.8);assertClose(result.outcome.lifeDamageChance,.2);
  result=run({amount:3,eventProbability:1,shield:2});assertClose(result.target.shield,0);assertClose(result.target.hp,3);assertClose(result.outcome.lifeDamageChance,1);
});

test("连续概率伤害不会重复使用已消耗的护盾分支", () => {
  const state={players:[{id:"attacker",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:0},{id:"target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:1,handCount:0,blockProbability:0,twoBlockProbability:0,expectedRecoverCount:0}]},simulator=new AiSimulator(state);
  const first=simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:false,eventProbability:.4});
  const second=simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:false,eventProbability:.4});
  assertClose(first,0);assertClose(second,.16);assertClose(state.players[1].shield,.36);assertClose(state.players[1].hp,3.84);
});

const conditionalHuntState = (secondMarkBranches) => ({playPhaseEnded:false,players:[
  {id:"hunter",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:2,maxEnergy:4,handCount:0,hand:[],activeSkillId:"hunt",activeSkillUses:0,activeSkillLimit:2},
  {id:"marked-a",seatIndex:1,battleTeam:"dusk",alive:true,hp:6,maxHp:6,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,huntMarkProbabilities:{hunter:.4},huntMarkStateBranchesBySource:{hunter:[{probability:.4,conditions:{shared:"yes"},marked:true},{probability:.6,conditions:{shared:"no"},marked:false}]},statuses:[],expectedRecoverCount:0},
  {id:"marked-b",seatIndex:2,battleTeam:"dusk",alive:true,hp:6,maxHp:6,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,huntMarkProbabilities:{hunter:secondMarkBranches.filter((branch)=>branch.marked).reduce((sum,branch)=>sum+branch.probability,0)},huntMarkStateBranchesBySource:{hunter:secondMarkBranches},statuses:[],expectedRecoverCount:0}
]});

test("能量分支让后续技能只在仍有足够能量的世界生成", () => {
  const state=conditionalHuntState([{probability:1,conditions:{},marked:true}]),{game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const first=game.aiController.actionGenerator.generateFromVisible(state,"hunter").find((action)=>action.skill?.id==="hunt"&&action.targets[0].id==="marked-a");
  const once=new AiSimulator(state).apply(state,first,"hunter"),energy=once.players[0].energyBranches;
  assertClose(energy.filter((branch)=>branch.amount===0).reduce((sum,branch)=>sum+branch.probability,0),.4);assertClose(once.players[0].energy,1.2);
  const second=game.aiController.actionGenerator.generateFromVisible(once,"hunter").find((action)=>action.skill?.id==="hunt"&&action.targets[0].id==="marked-b");assertClose(second.executionProbability,.6);
  const twice=new AiSimulator(once).apply(once,second,"hunter");assertClose(twice.players[0].energy,0);assertClose(twice.players[0].activeSkillUses,1);
});

test("完全重叠与互斥猎印分别阻止和允许复用同一份能量", () => {
  const {game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]),firstMark=(state)=>game.aiController.actionGenerator.generateFromVisible(state,"hunter").find((action)=>action.skill?.id==="hunt"&&action.targets[0].id==="marked-a");
  const overlapping=conditionalHuntState([{probability:.4,conditions:{shared:"yes"},marked:true},{probability:.6,conditions:{shared:"no"},marked:false}]);
  const overlapOnce=new AiSimulator(overlapping).apply(overlapping,firstMark(overlapping),"hunter");assert.ok(!game.aiController.actionGenerator.generateFromVisible(overlapOnce,"hunter").some((action)=>action.skill?.id==="hunt"&&action.targets[0].id==="marked-b"));
  const exclusive=conditionalHuntState([{probability:.4,conditions:{shared:"yes"},marked:false},{probability:.6,conditions:{shared:"no"},marked:true}]);
  const exclusiveOnce=new AiSimulator(exclusive).apply(exclusive,firstMark(exclusive),"hunter"),second=game.aiController.actionGenerator.generateFromVisible(exclusiveOnce,"hunter").find((action)=>action.skill?.id==="hunt"&&action.targets[0].id==="marked-b");assertClose(second.executionProbability,.6);
});

test("概率获得能量与孤注均按各自世界的实际能量结算", () => {
  const shared="charge-world",state={playPhaseEnded:false,players:[
    {id:"hunter",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:1,maxEnergy:4,handCount:1,hand:[{id:"charge",definitionId:"charge",availabilityBranches:[{probability:.4,conditions:{[shared]:"yes"}}],availabilityStateBranches:[{probability:.4,conditions:{[shared]:"yes"},available:true},{probability:.6,conditions:{[shared]:"no"},available:false}]}],activeSkillId:"hunt",activeSkillUses:0,activeSkillLimit:2},
    {id:"marked",seatIndex:1,battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,twoBlockProbability:0,huntMarkProbabilities:{hunter:1},huntMarkStateBranchesBySource:{hunter:[{probability:1,conditions:{},marked:true}]},statuses:[],expectedRecoverCount:0}
  ]},{game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]);
  const charge=game.aiController.actionGenerator.generateFromVisible(state,"hunter").find((action)=>action.card?.id==="charge"),charged=new AiSimulator(state).apply(state,charge,"hunter");
  const hunt=game.aiController.actionGenerator.generateFromVisible(charged,"hunter").find((action)=>action.skill?.id==="hunt");assertClose(hunt.executionProbability,.4);

  const allInState={players:[{id:"gambler",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:1.2,maxEnergy:4,energyBranches:[{probability:.4,conditions:{rich:"yes"},amount:3},{probability:.6,conditions:{rich:"no"},amount:0}],handCount:0,activeSkillUses:0,activeSkillLimit:1}]};
  const allInWorlds=[{probability:.4,conditions:{rich:"yes"},executes:true},{probability:.6,conditions:{rich:"no"},executes:false}],allIn=new AiSimulator(allInState).apply(allInState,{type:"skill",skill:ACTIVE_SKILLS.allIn,targets:[],executionProbability:.4,executionWorldBranches:allInWorlds},"gambler");
  assertClose(allIn.players[0].handCount,1.2);assertClose(allIn.players[0].energy,0);
});

test("AI破军只在额外攻击槽确实有第二张突袭可用时生成", () => {
  const blade=makePlayer("break-army-blade",0,"dawn","ai",0),enemy=makePlayer("break-army-enemy",1,"dusk");
  blade.energy=2;blade.hand.push(instance("assault"));const {game}=makeGame([blade,enemy]);blade.energy=2;
  const skills=()=>game.aiController.getLegalActions(blade).filter((action)=>action.skill?.id==="breakArmy");
  assert.equal(skills().length,0);assert.equal(game.aiController.evaluator.breakArmyUtility(createAiVisibleState(blade.id,game.state).players[0]),-4);blade.turnFlags.attackUsed=blade.turnFlags.attackLimit;assert.equal(skills().length,1);assert.equal(game.aiController.evaluator.breakArmyUtility(createAiVisibleState(blade.id,game.state).players[0]),8);
});

test("AI决斗按目标先出牌关系扣除双方突袭且不额外消费出牌者", () => {
  const run=(actorAssaults,targetAssaults)=>{const actorHand=[{id:"duel",definitionId:"duel"},...Array.from({length:actorAssaults},(_,index)=>({id:`actor-assault-${index}`,definitionId:"assault"}))],targetHand=Array.from({length:targetAssaults},(_,index)=>({id:`target-assault-${index}`,definitionId:"assault"})),state={playPhaseEnded:false,players:[
    {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:actorHand.length,hand:actorHand,expectedAssaultCount:actorAssaults,counterProbability:0},
    {id:"target",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:targetHand.length,hand:targetHand,expectedAssaultCount:targetAssaults,expectedRecoverCount:0,blockProbability:0,counterProbability:0}
  ]};return new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.duel,id:"duel"},targets:[{id:"target"}]},"actor");};
  let next=run(1,0);assert.equal(next.players[0].expectedAssaultCount,1);assert.equal(next.players[0].hand.filter((card)=>card.definitionId==="assault").length,1);assert.equal(next.players[1].hp,3);
  next=run(1,1);assert.equal(next.players[0].expectedAssaultCount,0);assert.equal(next.players[1].expectedAssaultCount,0);assert.ok(next.players.every((player)=>!(player.hand??[]).some((card)=>card.definitionId==="assault")));
  next=run(1,2);assert.equal(next.players[0].expectedAssaultCount,0);assert.equal(next.players[1].expectedAssaultCount,0);assert.equal(next.players[0].hp,3);
});

test("AI决斗移除的具体突袭不会再次进入深层动作生成", () => {
  const state={playPhaseEnded:false,players:[
    {id:"actor",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,maxEnergy:4,attackRange:1,attackUsed:0,attackLimit:2,handCount:2,hand:[{id:"duel",definitionId:"duel"},{id:"assault",definitionId:"assault"}],expectedAssaultCount:1,counterProbability:0},
    {id:"target",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,expectedAssaultCount:1,expectedRecoverCount:0,blockProbability:0,counterProbability:0}
  ]},{game}=makeGame([makePlayer("real-a",0,"dawn"),makePlayer("real-b",1,"dusk")]),next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.duel,id:"duel"},targets:[{id:"target"}]},"actor");
  assert.ok(!game.aiController.actionGenerator.generateFromVisible(next,"actor").some((action)=>action.card?.definitionId==="assault"));
});

test("AI军火库不会提高猎杀等非设备攻击的格挡需求", () => {
  const state={players:[
    {id:"hunter",battleTeam:"dawn",alive:true,hp:4,maxHp:4,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1},
    {id:"target",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:1,blockProbability:1,twoBlockProbability:0,expectedRecoverCount:0}
  ]};
  new AiSimulator(state).applyDamage(state,state.players[0],state.players[1],2,{canBlock:true,deviceAttack:false});
  assert.equal(state.players[1].hp,4);assert.equal(state.players[1].handCount,0);
});

test("AI模拟阵亡会清空手牌装备摘要且评估器只保留死亡惩罚", () => {
  const state={players:[
    {id:"killer",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:0},
    {id:"victim",seatIndex:1,battleTeam:"dusk",alive:true,hp:1,maxHp:4,shield:0,energy:3,handCount:5,hand:[{id:"a",definitionId:"assault"}],expectedAssaultCount:3,expectedRecoverCount:.2,assaultResponseProbability:1,blockProbability:1,twoBlockProbability:1,counterProbability:1,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1,huntMarkSourceId:null,huntMarkProbabilities:{}}
  ]},simulator=new AiSimulator(state);simulator.applyDamage(state,state.players[0],state.players[1],1,{canBlock:false});const victim=state.players[1];
  assert.deepEqual([victim.alive,victim.handCount,victim.hand.length,victim.expectedAssaultCount,victim.expectedRecoverCount,victim.equipmentDefinitionId,victim.equipmentRetentionProbability],[false,0,0,0,0,null,0]);
  const {game}=makeGame([makePlayer("viewer",0,"dawn"),makePlayer("dead",1,"dusk")]),viewer={id:"viewer",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:0},dead={id:"dead",battleTeam:"dusk",alive:false,hp:0,maxHp:4,shield:0,energy:0,handCount:0};
  const emptyScore=game.aiController.evaluator.stateUtility({players:[viewer,dead]},viewer.id),richScore=game.aiController.evaluator.stateUtility({players:[viewer,{...dead,shield:99,energy:99,handCount:99,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:1}]},viewer.id);assert.equal(richScore,emptyScore);
});

test("AI装备完全移除时按初始装备价值产生完整损失", () => {
  const {game}=makeGame([makePlayer("equipment-viewer",0,"dawn"),makePlayer("equipment-enemy",1,"dusk")]),value=CARD_DEFINITIONS.battleDevice.aiValue,base={id:"equipment-viewer",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:0,initialEquipmentValue:value,expectedEquipmentGain:0},enemy={id:"equipment-enemy",battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,energy:0,handCount:0};
  const partial=game.aiController.evaluator.stateUtility({players:[{...base,equipmentDefinitionId:"battleDevice",equipmentRetentionProbability:.1},enemy]},base.id),removed=game.aiController.evaluator.stateUtility({players:[{...base,equipmentDefinitionId:null,equipmentRetentionProbability:0},enemy]},base.id);
  assert.ok(removed<partial);assertClose(partial-removed,value*.1*.25);
});

test("AI攻击与技能次数槽选择执行概率最高的可用槽", () => {
  const partialSlot=[{probability:.2,conditions:{partial:"yes"},available:true},{probability:.8,conditions:{partial:"no"},available:false}],fullSlot=[{probability:1,conditions:{},available:true}],{game}=makeGame([makePlayer("slot-real-a",0,"dawn"),makePlayer("slot-real-b",1,"dusk")]);
  const attackState={playPhaseEnded:false,players:[{id:"attacker",seatIndex:0,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,energy:0,attackRange:1,attackUsed:0,attackLimit:2,attackUseSlots:[partialSlot,fullSlot],handCount:1,hand:[{id:"hit",definitionId:"assault"}]},{id:"enemy",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0}]};
  const attack=game.aiController.actionGenerator.generateFromVisible(attackState,"attacker").find((action)=>action.card?.id==="hit");assert.equal(attack.attackUseSlot,1);assert.equal(attack.executionProbability,1);
  const skillState={playPhaseEnded:false,players:[{id:"warden",seatIndex:0,battleTeam:"dawn",alive:true,hp:3,maxHp:3,shield:0,energy:2,activeSkillId:"barrier",activeSkillUses:0,activeSkillLimit:2,activeSkillUseSlots:[partialSlot,fullSlot],handCount:0,hand:[]},{id:"ally",seatIndex:1,battleTeam:"dawn",alive:true,hp:3,maxHp:3,shield:0,handCount:0},{id:"enemy",seatIndex:2,battleTeam:"dusk",alive:true,hp:3,maxHp:3,shield:0,handCount:0}]};
  const skill=game.aiController.actionGenerator.generateFromVisible(skillState,"warden").find((action)=>action.skill?.id==="barrier");assert.equal(skill.skillUseSlot,1);assert.equal(skill.executionProbability,1);
});

test("AI濒死救援在本人后按相对座位环绕顺序消费调息", () => {
  const players=[
    {id:"ally-zero",seatIndex:0,battleTeam:"dawn",alive:true,hp:3,maxHp:3,handCount:1,hand:[{id:"recover-zero",definitionId:"recover"}],expectedRecoverCount:1},
    {id:"enemy-one",seatIndex:1,battleTeam:"dusk",alive:true,hp:3,maxHp:3,handCount:0,expectedRecoverCount:0},
    {id:"dying",seatIndex:2,battleTeam:"dawn",alive:true,hp:0,maxHp:3,handCount:0,hand:[],expectedRecoverCount:0},
    {id:"enemy-three",seatIndex:3,battleTeam:"dusk",alive:true,hp:3,maxHp:3,handCount:0,expectedRecoverCount:0},
    {id:"ally-four",seatIndex:4,battleTeam:"dawn",alive:true,hp:3,maxHp:3,handCount:1,hand:[{id:"recover-four",definitionId:"recover"}],expectedRecoverCount:1}
  ],state={players},simulator=new AiSimulator(state);simulator.resolveFatal(state,players[2],players[1]);assert.equal(players[2].hp,1);assert.equal(players[4].expectedRecoverCount,0);assert.equal(players[0].expectedRecoverCount,1);
});

test("关闭逐动作重规划时转移描述只保存稳定ID并可重新绑定", () => {
  const actor=makePlayer("transfer-rebind-actor",0,"dawn"),from=makePlayer("transfer-rebind-from",1,"dusk"),receiver=makePlayer("transfer-rebind-receiver",2,"dawn"),use=instance("transfer");actor.hand.push(use);from.hand.push(instance("block"));const {game}=makeGame([actor,from,receiver]),action=game.aiController.getLegalActions(actor).find((entry)=>entry.card?.id===use.id),descriptor=game.aiController.planner.describeAction(action);
  assert.deepEqual(descriptor.selection,{sourceId:action.selection.sourceId,receiverId:action.selection.receiverId,zone:"hand"});assert.equal(Object.hasOwn(descriptor.selection,"source"),false);assert.equal(Object.hasOwn(descriptor.selection,"score"),false);assert.ok(game.aiController.resolvePlannedAction(actor,structuredClone(descriptor)));
});

test("追猎者阵亡时统一清理其他角色身上由其留下的猎印", async () => {
  const hunter=makePlayer("dead-hunter",0,"dawn","ai",5),marked=makePlayer("marked-after-death",1,"dusk"),killer=makePlayer("hunter-killer",2,"dusk");marked.statuses.huntMark={sourceId:hunter.id,expireAtTurnEnd:99};const {game}=makeGame([hunter,marked,killer]);await game.dyingSystem.kill(hunter,killer);assert.equal(marked.statuses.huntMark,undefined);
});

test("反制链每张实际反制只记录一条带明确双方与对象的日志", async () => {
  const source=makePlayer("log-source",0,"dawn","human"),first=makePlayer("log-first",1,"dusk","human"),second=makePlayer("log-second",2,"dawn","human"),use=instance("harvest");source.hand.push(use);first.hand.push(instance("counter"));second.hand.push(instance("counter"));const {game}=makeGame([source,first,second],{response:(request)=>request.type==="counter"&&request.legalCardIds.length>=request.requiredCount});game.state.deck.cards.push(instance("charge"),instance("block"));await game.playCard(source,use,[]);const logs=game.state.logs.map((entry)=>entry.message).filter((message)=>message.includes("使用了「反制」"));
  assert.deepEqual(logs,[`${first.name}对${source.name}的「收获」使用了「反制」，取消了「收获」的效果。`,`${second.name}对${first.name}的「反制」使用了「反制」，取消了「反制」的效果。`]);assert.ok(!game.state.logs.some((entry)=>entry.message.includes("被后续反制抵消")||entry.message===`「收获」的效果被取消。`));
});

function simulatedDuelPlayer(id, team, count) {
  return {
    id, seatIndex:team === "dawn" ? 0 : 1, battleTeam:team, alive:true,
    hp:10, maxHp:10, shield:0, handCount:count, hand:[], expectedRecoverCount:0,
    assaultCountDistribution:[{ count, probability:1 }], expectedAssaultCount:count,
    assaultResponseProbability:count > 0 ? 1 : 0, blockProbability:0
  };
}

test("AI决斗按整数突袭分布覆盖1对0、1对1、1对2与0对0", () => {
  const cases = [
    [1,0,{actorLoseProbability:0,targetLoseProbability:1,expectedActorSpent:0,expectedTargetSpent:0}],
    [1,1,{actorLoseProbability:0,targetLoseProbability:1,expectedActorSpent:1,expectedTargetSpent:1}],
    [1,2,{actorLoseProbability:1,targetLoseProbability:0,expectedActorSpent:1,expectedTargetSpent:2}],
    [0,0,{actorLoseProbability:0,targetLoseProbability:1,expectedActorSpent:0,expectedTargetSpent:0}]
  ];
  for (const [actorCount,targetCount,expected] of cases) {
    const actor=simulatedDuelPlayer(`duel-actor-${actorCount}-${targetCount}`,"dawn",actorCount);
    const target=simulatedDuelPlayer(`duel-target-${actorCount}-${targetCount}`,"dusk",targetCount);
    const state={players:[actor,target]},outcome=new AiSimulator(state).applyDuel(state,actor,target,1);
    for (const [field,value] of Object.entries(expected)) assertClose(outcome[field],value);
  }
});

test("AI决斗未知手牌产生双向非零失败概率且分支严格有界", () => {
  const actor=makePlayer("duel-visible-actor",0,"dawn","ai"),target=makePlayer("duel-hidden-target",1,"dusk");
  target.hand.push(instance("recover"),instance("block"));
  const {game}=makeGame([actor,target]),visible=createAiVisibleState(actor.id,game.state);
  const visibleActor=structuredClone(visible.players[0]),visibleTarget=structuredClone(visible.players[1]);
  const state={players:[visibleActor,visibleTarget]},outcome=new AiSimulator(state).applyDuel(state,visibleActor,visibleTarget,1);
  assert.ok(outcome.actorLoseProbability>0&&outcome.targetLoseProbability>0);
  assert.ok(outcome.actorLoseProbability<1&&outcome.targetLoseProbability<1);
  assert.ok(visibleTarget.assaultCountDistribution.length<=visibleTarget.handCount+1);
  assertClose(visibleTarget.assaultCountDistribution.reduce((sum,branch)=>sum+branch.probability,0),1);
  assert.ok(visibleTarget.assaultCountDistribution.every((branch)=>Number.isInteger(branch.count)&&branch.count>=0));
});

test("AI决斗1张对4张未知手牌不会确定判负且目标消耗不超原期望", () => {
  const actor=makePlayer("duel-one-actor",0,"dawn","ai"),target=makePlayer("duel-four-target",1,"dusk");
  actor.hand.push(instance("assault"));target.hand.push(instance("recover"),instance("block"),instance("charge"),instance("shield"));
  const {game}=makeGame([actor,target]),visible=createAiVisibleState(actor.id,game.state);
  const a=structuredClone(visible.players[0]),t=structuredClone(visible.players[1]),original=t.expectedAssaultCount;
  const state={players:[a,t]},outcome=new AiSimulator(state).applyDuel(state,a,t,1);
  assert.ok(outcome.actorLoseProbability>0&&outcome.actorLoseProbability<1);
  assert.ok(outcome.targetLoseProbability>0&&outcome.targetLoseProbability<1);
  assert.ok(outcome.expectedTargetSpent<=original+1e-9);
});

test("AI决斗前主动突袭会同步为0张突袭", () => {
  const state={players:[
    {id:"assault-then-duel",seatIndex:0,battleTeam:"dawn",alive:true,hp:5,maxHp:5,shield:0,handCount:1,hand:[{id:"only-assault",definitionId:"assault"}],attackUsed:0,attackLimit:2,assaultCountDistribution:[{count:1,probability:1}]},
    {id:"assault-first-target",seatIndex:1,battleTeam:"dusk",alive:true,hp:10,maxHp:10,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0,assaultCountDistribution:[{count:0,probability:1}]},
    {id:"duel-second-target",seatIndex:2,battleTeam:"dusk",alive:true,hp:10,maxHp:10,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0,assaultCountDistribution:[{count:0,probability:1}]}
  ]};
  const simulator=new AiSimulator(state),afterAssault=simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.assault,id:"only-assault"},targets:[{id:"assault-first-target"}]},"assault-then-duel");
  const actor=afterAssault.players[0],target=afterAssault.players[2],outcome=simulator.applyDuel(afterAssault,actor,target,1);
  assert.equal(actor.expectedAssaultCount,0);assert.deepEqual(actor.assaultCountDistribution,[{count:0,probability:1}]);assert.equal(outcome.expectedActorSpent,0);
});

test("AI决斗分布不读取敌方真实隐藏手牌内容", () => {
  const actor=makePlayer("duel-private-actor",0,"dawn","ai"),target=makePlayer("duel-private-target",1,"dusk");
  target.hand.push(instance("assault"),instance("assault"),instance("recover"),instance("block"));
  const {game}=makeGame([actor,target]),first=createAiVisibleState(actor.id,game.state).players[1].assaultCountDistribution;
  target.hand=target.hand.map((card,index)=>({...instance(["shield","charge","counter","harvest"][index]),id:card.id}));
  const second=createAiVisibleState(actor.id,game.state).players[1].assaultCountDistribution;
  assert.deepEqual(second,first);
});

test("余烬按挑衅和震荡的同一resolutionId各只触发一次", async () => {
  for (const definitionId of ["provoke","shockwave"]) {
    const ember=makePlayer(`ember-${definitionId}`,0,"dawn","ai",4),enemies=[1,2,3].map((seat)=>makePlayer(`${definitionId}-enemy-${seat}`,seat,"dusk"));
    const {game}=makeGame([ember,...enemies]);registerPassiveSkills(game);ember.hand.push(instance(definitionId));
    await game.playCard(ember,ember.hand[0],enemies);assert.equal(ember.energy,1);
  }
  const ember=makePlayer("ember-two-cards",0,"dawn","ai",4),enemy=makePlayer("ember-two-target",1,"dusk"),{game}=makeGame([ember,enemy]);
  registerPassiveSkills(game);ember.hand.push(instance("provoke"),instance("provoke"));
  await game.playCard(ember,ember.hand[0],[enemy]);await game.playCard(ember,ember.hand[0],[enemy]);assert.equal(ember.energy,2);
});

test("格挡决策随可用格挡数单调且先验证实际支付数量", () => {
  const responder=makePlayer("block-policy",0,"dawn","ai"),ally1=makePlayer("block-ally-1",1,"dawn"),enemy1=makePlayer("block-enemy-1",2,"dusk"),ally2=makePlayer("block-ally-2",3,"dawn"),enemy2=makePlayer("block-enemy-2",4,"dusk");
  const {game}=makeGame([responder,ally1,enemy1,ally2,enemy2]),policy=game.aiController.responsePolicy;
  const decisions=[];
  for (const count of [1,2,3]) {
    responder.hand=[...Array.from({length:count},()=>instance("block")),...Array.from({length:4-count},()=>instance("charge"))];
    decisions.push(policy.shouldRespond(responder,"block",{target:responder,amount:1,requiredCount:1},responder.hand.filter((card)=>card.definitionId==="block")));
  }
  assert.ok(!decisions.some((decision,index)=>index>0&&decisions[index-1]&&!decision));
  responder.hp=1;responder.shield=0;responder.hand=[instance("block")];assert.equal(policy.shouldRespond(responder,"block",{target:responder,amount:1,requiredCount:1},responder.hand),true);
  responder.hp=2;assert.equal(policy.shouldRespond(responder,"block",{target:responder,amount:1,requiredCount:1},responder.hand),true);
  assert.equal(policy.shouldRespond(responder,"block",{target:responder,amount:2,requiredCount:2},responder.hand),false);
});

test("AI护援统一覆盖突袭、震荡、挑衅、决斗、猎杀与焚场", () => {
  const runCard=(definitionId,targetSetup=()=>{})=>{
    const actor={id:`${definitionId}-actor`,seatIndex:0,battleTeam:"dawn",alive:true,hp:5,maxHp:5,shield:0,energy:3,maxEnergy:4,handCount:1,hand:[{id:`${definitionId}-card`,definitionId}],attackUsed:0,attackLimit:2,assaultCountDistribution:[{count:definitionId==="assault"?1:0,probability:1}]};
    const target={id:`${definitionId}-target`,seatIndex:1,battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0,assaultCountDistribution:[{count:0,probability:1}]};
    const guardian={id:`${definitionId}-guardian`,seatIndex:2,generalId:"oath-warden",battleTeam:"dusk",alive:true,hp:3,maxHp:3,shield:0,handCount:1,hand:[{id:`${definitionId}-aid`,definitionId:"charge"}],guardianAidUsedProbability:0};
    targetSetup(actor,target);const state={players:[actor,target,guardian]},next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS[definitionId],id:`${definitionId}-card`},targets:[target]},actor.id);
    assert.equal(next.players[1].hp,5);assert.equal(next.players[2].handCount,0);
  };
  for (const id of ["assault","shockwave","provoke","duel"]) runCard(id);
  const runSkill=(skill,actorGeneral,damage)=>{
    const actor={id:`${skill.id}-actor`,seatIndex:0,generalId:actorGeneral,battleTeam:"dawn",alive:true,hp:5,maxHp:5,shield:0,energy:3,maxEnergy:4,handCount:0,activeSkillUses:0};
    const target={id:`${skill.id}-target`,seatIndex:1,battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0,statuses:[],huntMarkSourceId:actor.id,huntMarkProbability:1,huntMarkProbabilities:{[actor.id]:1},huntMarkStateBranchesBySource:{[actor.id]:[{probability:1,conditions:{},marked:true}]}};
    const guardian={id:`${skill.id}-guardian`,seatIndex:2,generalId:"oath-warden",battleTeam:"dusk",alive:true,hp:3,maxHp:3,shield:0,handCount:1,hand:[{id:`${skill.id}-aid`,definitionId:"charge"}],guardianAidUsedProbability:0};
    const state={players:[actor,target,guardian]},next=new AiSimulator(state).apply(state,{type:"skill",skill,targets:[target]},actor.id);
    assert.equal(next.players[1].hp,5-(damage-1));assert.equal(next.players[2].handCount,0);
  };
  runSkill(ACTIVE_SKILLS.hunt,"trail-hunter",2);runSkill(ACTIVE_SKILLS.burningField,"ember-magus",1);
});

test("AI护援每名守誓者每轮一次且零伤害与阵亡时不弃牌", () => {
  const attacker={id:"aid-attacker",battleTeam:"dawn",alive:true,hp:5,maxHp:5,handCount:0};
  const target={id:"aid-target",battleTeam:"dusk",alive:true,hp:5,maxHp:5,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0};
  const guardian={id:"aid-guardian",generalId:"oath-warden",battleTeam:"dusk",alive:true,hp:3,maxHp:3,handCount:2,guardianAidUsedProbability:0};
  const state={players:[attacker,target,guardian]},simulator=new AiSimulator(state);simulator.applyDamage(state,attacker,target,0,{canBlock:false});assert.equal(guardian.handCount,2);
  simulator.applyDamage(state,attacker,target,1,{canBlock:false});simulator.applyDamage(state,attacker,target,1,{canBlock:false});assert.equal(guardian.handCount,1);assert.equal(target.hp,4);
  const dead={...guardian,id:"dead-aid",alive:false,handCount:1,guardianAidUsedProbability:0},deadTarget={...target,id:"dead-aid-target",hp:5};const deadState={players:[attacker,deadTarget,dead]};simulator.applyDamage(deadState,attacker,deadTarget,1,{canBlock:false});assert.equal(dead.handCount,1);assert.equal(deadTarget.hp,4);
});

test("AI窥隙与余烬从统一生命伤害入口覆盖非突袭和群体卡牌", () => {
  const spy=simulatedDuelPlayer("duel-spy","dawn",1);spy.generalId="shade-agent";spy.expectedInformationGain=0;spy.spyGapTriggeredProbability=0;
  const spyTarget=simulatedDuelPlayer("duel-spy-target","dusk",0);spyTarget.handCount=3;
  const duelState={players:[spy,spyTarget]};new AiSimulator(duelState).applyDuel(duelState,spy,spyTarget,1);assert.equal(spy.expectedInformationGain,2);
  const ember={id:"provoke-ember",seatIndex:0,generalId:"ember-magus",battleTeam:"dawn",alive:true,hp:4,maxHp:4,energy:0,maxEnergy:3,handCount:1,hand:[{id:"ember-provoke",definitionId:"provoke"}]};
  const enemies=[1,2,3].map((seat)=>({id:`ember-group-${seat}`,seatIndex:seat,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,blockProbability:0,expectedRecoverCount:0,assaultCountDistribution:[{count:0,probability:1}]}));
  const state={players:[ember,...enemies]},next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.provoke,id:"ember-provoke"},targets:enemies},ember.id);assert.equal(next.players[0].energy,1);
});

test("AI救援轮次让A与B首轮各消耗一张调息", () => {
  const target={id:"round-rescue-target",seatIndex:0,battleTeam:"dawn",alive:true,hp:-1,maxHp:4,handCount:0,expectedRecoverCount:0};
  const a={id:"round-rescue-a",seatIndex:1,battleTeam:"dawn",alive:true,hp:3,maxHp:3,handCount:2,hand:[{id:"a-r1",definitionId:"recover"},{id:"a-r2",definitionId:"recover"}],expectedRecoverCount:2};
  const b={id:"round-rescue-b",seatIndex:2,battleTeam:"dawn",alive:true,hp:3,maxHp:3,handCount:1,hand:[{id:"b-r1",definitionId:"recover"}],expectedRecoverCount:1};
  const state={players:[target,a,b]};new AiSimulator(state).resolveFatal(state,target);assert.equal(target.hp,1);assert.equal(a.expectedRecoverCount,1);assert.equal(b.expectedRecoverCount,0);
});

test("AI共生顺序从非0号出牌者开始并让回春命中首个合法目标", () => {
  const ally0={id:"symbiosis-seat-0",seatIndex:0,battleTeam:"dawn",alive:true,hp:1,maxHp:4,handCount:0};
  const enemy1={id:"symbiosis-seat-1",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:0,counterProbability:0};
  const medic={id:"symbiosis-medic",seatIndex:2,generalId:"spirit-medic",battleTeam:"dawn",alive:true,hp:3,maxHp:3,handCount:1,hand:[{id:"ordered-symbiosis",definitionId:"symbiosis"}],rejuvenationUsed:false};
  const ally3={id:"symbiosis-seat-3",seatIndex:3,battleTeam:"dawn",alive:true,hp:1,maxHp:4,handCount:0};
  const state={players:[ally0,enemy1,medic,ally3]},next=new AiSimulator(state).apply(state,{type:"card",card:{...CARD_DEFINITIONS.symbiosis,id:"ordered-symbiosis"},targets:state.players},medic.id);
  assert.equal(next.players[3].hp,3);assert.equal(next.players[0].hp,2);assert.equal(next.players[2].handCount,1);
});

test("AI冒险首次战术期望摸0.6且被反制仍触发、同回合不重复", () => {
  const actor={id:"gamble-sim",seatIndex:0,generalId:"fate-gambler",battleTeam:"dawn",alive:true,hp:4,maxHp:4,handCount:2,hand:[{id:"gamble-one",definitionId:"exposeWeakness"},{id:"gamble-two",definitionId:"exposeWeakness"}],gambleTriggered:false};
  const enemy={id:"gamble-counter",seatIndex:1,battleTeam:"dusk",alive:true,hp:4,maxHp:4,handCount:1,counterProbability:1};const state={players:[actor,enemy]},simulator=new AiSimulator(state);
  const once=simulator.apply(state,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"gamble-one"},targets:[]},actor.id);assertClose(once.players[0].handCount,1.6);assert.equal(once.players[0].gambleTriggered,true);
  const twice=simulator.apply(once,{type:"card",card:{...CARD_DEFINITIONS.exposeWeakness,id:"gamble-two"},targets:[]},actor.id);assertClose(twice.players[0].handCount,.6);
});

test("AI协调只依据未取消的其他己方有效目标且同回合一次", () => {
  const actor={id:"coord-sim",seatIndex:0,generalId:"resonance-tuner",battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:2,hand:[{id:"coord-one",definitionId:"shield"},{id:"coord-two",definitionId:"shield"}],coordinationTriggered:false};
  const ally={id:"coord-ally",seatIndex:1,battleTeam:"dawn",alive:true,hp:4,maxHp:4,shield:0,handCount:0};const enemy={id:"coord-enemy",seatIndex:2,battleTeam:"dusk",alive:true,hp:4,maxHp:4,shield:0,handCount:0,counterProbability:0};
  const state={players:[actor,ally,enemy]},simulator=new AiSimulator(state),action=(id,target)=>({type:"card",card:{...CARD_DEFINITIONS.shield,id},targets:[target]});
  const once=simulator.apply(state,action("coord-one",ally),actor.id);assert.equal(once.players[0].handCount,2);assert.equal(once.players[0].coordinationTriggered,true);
  const twice=simulator.apply(once,action("coord-two",ally),actor.id);assert.equal(twice.players[0].handCount,1);
  const selfState=structuredClone(state),selfOnly=new AiSimulator(selfState).apply(selfState,action("coord-one",selfState.players[0]),actor.id);assert.equal(selfOnly.players[0].coordinationTriggered,false);
  const counterActor={...actor,id:"coord-countered",handCount:1,hand:[{id:"coord-mutual",definitionId:"mutualBenefit"}],coordinationTriggered:false},counterAlly={...ally,id:"coord-counter-ally"},counterEnemy={...enemy,id:"coord-counter-enemy",counterProbability:1};const counterState={players:[counterActor,counterAlly,counterEnemy]};
  const countered=new AiSimulator(counterState).apply(counterState,{type:"card",card:{...CARD_DEFINITIONS.mutualBenefit,id:"coord-mutual"},targets:counterState.players},counterActor.id);assert.equal(countered.players[0].coordinationTriggered,false);
});

test("猎印到期覆盖正常回合与首次回合前借势时钟", async () => {
  const normalHunter=makePlayer("normal-clock-hunter",0,"dawn","ai",5),normalTarget=makePlayer("normal-clock-target",1,"dusk"),normalGame=makeGame([normalHunter,normalTarget]).game;registerPassiveSkills(normalGame);
  await normalGame.eventBus.emit("turnStart",{type:"turnStart",player:normalHunter});await normalGame.eventBus.emit("targetSelected",{type:"targetSelected",source:normalHunter,card:instance("assault"),targets:[normalTarget]});assert.equal(normalTarget.statuses.huntMark.expireAtTurnEnd,2);
  await normalGame.eventBus.emit("turnEnd",{type:"turnEnd",player:normalHunter});assert.ok(normalTarget.statuses.huntMark);await normalGame.eventBus.emit("turnStart",{type:"turnStart",player:normalHunter});await normalGame.eventBus.emit("turnEnd",{type:"turnEnd",player:normalHunter});assert.equal(normalTarget.statuses.huntMark,undefined);
  const earlyHunter=makePlayer("early-clock-hunter",0,"dawn","ai",5),earlyTarget=makePlayer("early-clock-target",1,"dusk"),earlyGame=makeGame([earlyHunter,earlyTarget]).game;registerPassiveSkills(earlyGame);
  await earlyGame.eventBus.emit("targetSelected",{type:"targetSelected",source:earlyHunter,card:instance("assault"),targets:[earlyTarget]});assert.equal(earlyTarget.statuses.huntMark.expireAtTurnEnd,1);
  await earlyGame.eventBus.emit("turnStart",{type:"turnStart",player:earlyHunter});await earlyGame.eventBus.emit("turnEnd",{type:"turnEnd",player:earlyHunter});assert.equal(earlyTarget.statuses.huntMark,undefined);
});

let passed = 0;
const testPattern = process.env.TEST_PATTERN ? new RegExp(process.env.TEST_PATTERN, "u") : null;
const selectedTests = testPattern ? tests.filter(({ name }) => testPattern.test(name)) : tests;
for (const { name, fn } of selectedTests) {
  try { await fn(); passed += 1; process.stdout.write(`✓ ${name}\n`); }
  catch (error) { process.stderr.write(`✗ ${name}\n${error.stack}\n`); process.exitCode = 1; }
}
process.stdout.write(`\n${passed}/${selectedTests.length} tests passed\n`);
