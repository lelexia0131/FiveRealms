/**
 * 零依赖核心测试：验证配置完整性、2V3、牌堆隔离、角色分配、合法目标、AI 隐藏信息与伤害资源。
 * 运行方式仅用于开发校验：使用项目附带的 package.json 执行 npm test，游戏运行本身不需要 Node.js。
 */
import assert from "node:assert/strict";
import { GAME_CONFIG } from "../js/config/gameConfig.js";
import { CARD_DEFINITIONS } from "../js/config/cardConfig.js";
import { GENERAL_DEFINITIONS } from "../js/config/generalConfig.js";
import { TeamManager } from "../js/core/TeamManager.js";
import { GeneralSelection } from "../js/core/GeneralSelection.js";
import { Deck } from "../js/core/Deck.js";
import { Player } from "../js/core/Player.js";
import { RuleEngine } from "../js/core/RuleEngine.js";
import { Game } from "../js/core/Game.js";
import { createAiVisibleState } from "../js/ai/AiVisibleState.js";
import { hasCardResolver } from "../js/cards/cardRegistry.js";
import { hasActiveSkill, hasPassiveSkill } from "../js/generals/skillRegistry.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("阵营分配始终严格为 2V3，真人可进入任一阵营", () => {
  const humanTeams = new Set();
  for (let index = 0; index < 300; index += 1) {
    const teams = TeamManager.assignTeams();
    assert.equal(teams.length, 5);
    const dawn = teams.filter((team) => team === "dawn").length;
    assert.ok([2, 3].includes(dawn));
    assert.equal(teams.filter((team) => team === "dusk").length, 5 - dawn);
    humanTeams.add(teams[0]);
  }
  assert.deepEqual([...humanTeams].sort(), ["dawn", "dusk"]);
});

test("牌堆数量、唯一 ID 与结算区隔离正确", () => {
  const deck = new Deck(() => 0.42);
  const total = deck.build();
  const expected = Object.values(CARD_DEFINITIONS).reduce((sum, card) => sum + card.count, 0);
  assert.equal(total, expected);
  assert.equal(new Set(deck.cards.map((card) => card.id)).size, expected);
  const resolving = deck.drawOne();
  const discarded = deck.drawOne();
  deck.beginResolve(resolving);
  deck.discard(discarded);
  deck.cards = [];
  assert.equal(deck.reshuffle(), true);
  assert.equal(deck.cards.length, 1);
  assert.equal(deck.cards[0].id, discarded.id);
  assert.equal(deck.resolvingCards[0].id, resolving.id);
});

test("候选、电脑角色与技能注册完整且不重复", () => {
  const selection = new GeneralSelection(() => 0.31);
  const candidates = selection.createCandidates();
  assert.equal(candidates.length, GAME_CONFIG.generalCandidateCount);
  assert.equal(new Set(candidates.map((general) => general.id)).size, candidates.length);
  const teams = ["dawn", "dawn", "dusk", "dusk"];
  const aiPlayers = teams.map((battleTeam, seatIndex) => ({ battleTeam, seatIndex }));
  const assigned = selection.assignAiGenerals(aiPlayers, candidates[0].id);
  assert.equal(new Set(assigned.map((general) => general.id)).size, 4);
  assert.ok(!assigned.some((general) => general.id === candidates[0].id));
  for (const general of GENERAL_DEFINITIONS) {
    general.passiveSkillIds.forEach((id) => assert.ok(hasPassiveSkill(id), `缺少被动 ${id}`));
    general.activeSkillIds.forEach((id) => assert.ok(hasActiveSkill(id), `缺少主动 ${id}`));
  }
  Object.keys(CARD_DEFINITIONS).forEach((id) => assert.ok(hasCardResolver(id), `缺少卡牌 ${id}`));
});

test("合法性规则拒绝攻击队友、满血调息和主动响应牌", () => {
  const source = new Player({ id: "p1", seatIndex: 0, controllerType: "human", battleTeam: "dawn" });
  const ally = new Player({ id: "p2", seatIndex: 1, controllerType: "ai", battleTeam: "dawn" });
  const enemy = new Player({ id: "p3", seatIndex: 2, controllerType: "ai", battleTeam: "dusk" });
  [source, ally, enemy].forEach((player, index) => player.applyGeneral(GENERAL_DEFINITIONS[index]));
  source.resetTurnFlags();
  const assault = { ...CARD_DEFINITIONS.assault, id: "assault-test" };
  const recover = { ...CARD_DEFINITIONS.recover, id: "recover-test" };
  const block = { ...CARD_DEFINITIONS.block, id: "block-test" };
  source.hand.push(assault, recover, block);
  const game = { state: { phase: "play", players: [source, ally, enemy] }, currentPlayer: source };
  assert.deepEqual(RuleEngine.getCardTargets(game, source, assault).map((player) => player.id), [enemy.id]);
  assert.equal(RuleEngine.canPlayCard(game, source, recover).ok, false);
  assert.equal(RuleEngine.canPlayCard(game, source, block).ok, false);
});

test("AI 可见状态不包含其他角色的具体手牌", () => {
  const viewer = new Player({ id: "ai", seatIndex: 1, controllerType: "ai", battleTeam: "dawn" });
  const enemy = new Player({ id: "human", seatIndex: 0, controllerType: "human", battleTeam: "dusk" });
  viewer.applyGeneral(GENERAL_DEFINITIONS[0]);
  enemy.applyGeneral(GENERAL_DEFINITIONS[1]);
  viewer.hand.push({ id: "own", definitionId: "assault" });
  enemy.hand.push({ id: "secret", definitionId: "counter", name: "反制" });
  const deck = new Deck();
  const visible = createAiVisibleState(viewer.id, { gameId: "g", players: [viewer, enemy], deck, currentRound: 1, phase: "play" });
  assert.equal(visible.players.find((player) => player.id === enemy.id).hand, undefined);
  assert.equal(visible.players.find((player) => player.id === enemy.id).handCount, 1);
  assert.equal(visible.players.find((player) => player.id === viewer.id).hand[0].definitionId, "assault");
});

test("伤害依次消耗护盾和生命，能量不会越界", async () => {
  const fakeUi = {
    render() {}, appendLog() {}, cancelPendingInteractions() {}, requestResponse: async () => false,
    setCurrentCard() {}, setPrompt() {}, setThinking() {}, showGameOver() {}
  };
  const game = new Game(fakeUi, () => 0.5);
  const source = new Player({ id: "s", seatIndex: 0, controllerType: "ai", battleTeam: "dawn" });
  const target = new Player({ id: "t", seatIndex: 1, controllerType: "ai", battleTeam: "dusk" });
  source.applyGeneral(GENERAL_DEFINITIONS[0]);
  target.applyGeneral(GENERAL_DEFINITIONS[1]);
  source.resetTurnFlags(); target.resetTurnFlags(); source.resetRoundFlags(); target.resetRoundFlags();
  target.shield = 1;
  game.state.players = [source, target];
  game.state.currentPlayerIndex = 0;
  game.registerGlobalRules();
  const actual = await game.damage(source, target, 2, { canBlock: false });
  assert.equal(actual, 1);
  assert.equal(target.shield, 0);
  assert.equal(target.hp, target.maxHp - 1);
  assert.equal(await game.gainEnergy(source, 99, { reason: "测试" }), source.maxEnergy);
  assert.equal(source.energy, source.maxEnergy);
  game.dispose();
});

test("主动卡从手牌经过结算区进入弃牌堆，且只伤害敌人", async () => {
  const fakeUi = {
    render() {}, appendLog() {}, cancelPendingInteractions() {}, requestResponse: async () => false,
    setCurrentCard() {}, setPrompt() {}, setThinking() {}, showGameOver() {}
  };
  const game = new Game(fakeUi, () => 0.9);
  const source = new Player({ id: "card-source", seatIndex: 0, controllerType: "ai", battleTeam: "dawn" });
  const target = new Player({ id: "card-target", seatIndex: 1, controllerType: "ai", battleTeam: "dusk" });
  source.applyGeneral(GENERAL_DEFINITIONS[7]);
  target.applyGeneral(GENERAL_DEFINITIONS[1]);
  source.resetTurnFlags(); target.resetTurnFlags(); source.resetRoundFlags(); target.resetRoundFlags();
  const assault = { ...CARD_DEFINITIONS.assault, id: "pipeline-assault" };
  source.hand.push(assault);
  game.state.players = [source, target];
  game.state.currentPlayerIndex = 0;
  game.state.phase = "play";
  game.registerGlobalRules();
  assert.equal(await game.playCard(source, assault, [target]), true);
  assert.equal(source.hand.length, 0);
  assert.equal(game.state.deck.resolvingCards.length, 0);
  assert.equal(game.state.deck.discardPile[0].id, assault.id);
  assert.equal(target.hp, target.maxHp - 1);
  game.dispose();
});

test("五名 AI 可完整运行到单一阵营获胜", async () => {
  let seed = 0x5f3759df;
  const random = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  let shownWinner = null;
  const fakeUi = {
    render() {}, appendLog() {}, cancelPendingInteractions() {}, requestResponse: async () => false,
    setCurrentCard() {}, setPrompt() {}, setThinking() {}, showGameOver(team) { shownWinner = team; }
  };
  const game = new Game(fakeUi, random);
  const candidates = game.startSelection();
  game.state.players[0].controllerType = "ai";
  game.cleanupManager.delay = () => new Promise((resolve) => setTimeout(() => resolve(true), 0));
  await game.confirmGeneral(candidates[0].id);
  const result = await Promise.race([
    game.loopPromise.then(() => "complete"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000))
  ]);
  assert.equal(result, "complete", "完整 AI 对局在 8 秒内未结束");
  assert.equal(game.state.isGameOver, true);
  assert.ok(["dawn", "dusk"].includes(game.state.winnerTeam));
  assert.equal(shownWinner, game.state.winnerTeam);
  assert.equal(game.state.players.filter((player) => player.alive && player.battleTeam !== game.state.winnerTeam).length, 0);
  game.dispose();
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    process.stderr.write(`✗ ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n${passed}/${tests.length} tests passed\n`);
