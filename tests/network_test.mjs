import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectNetworkGame } from "../js/network/NetworkViewerProjection.js";
import { NetworkGameView } from "../js/ui/network/NetworkGameView.js";
import { MatchMvpResultView } from "../js/ui/results/MatchMvpResultView.js";
import { handleNetworkHostPaste, validateNetworkHost, renderNetworkEntryView } from "../js/ui/network/NetworkEntryView.js";
import { NETWORK_DEFAULT_PORT, formatNetworkAddress, normalizeNetworkEndpoint } from "../js/network/NetworkProtocol.js";
import { NetworkSession } from "../js/network/NetworkSession.js";
import { NETWORK_EVENT as E, NETWORK_ROLE as R, NETWORK_CAPABILITY_SENDER } from "../js/network/NetworkProtocol.js";
import { NETWORK_STATE as S, transitionNetworkState } from "../js/network/NetworkLobbyState.js";
import { createNetworkSetup, isNetworkSetupValid, isNetworkSelectionValid, finalizeNetworkSetup } from "../js/network/NetworkSetup.js";
import { PlayerControlRouter, PLAYER_CONTROL as C } from "../js/network/PlayerControlRouter.js";
import { MATCH_MODE, isMatchPersistenceEligible } from "../js/application/match/MatchMode.js";
import { createGameApplication } from "../js/composition/createGameApplication.js";
import { createNetworkFlow } from "../js/composition/createNetworkFlow.js";
import { UIManager } from "../js/ui/UIManager.js";
import { PrivateRevealView } from "../js/ui/PrivateRevealView.js";
import { CHARACTER_BY_ID } from "../js/domain/definitions/characters/CharacterDefinitions.js";
import { createActionTransaction } from "../js/application/action/ActionTransaction.js";
import { InteractionController, orderZoneSelectionSlots } from "../js/ui/InteractionController.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../js/domain/definitions/skills/SkillDefinitions.js";
import { TEAM_PRESENTATION } from "../js/adapters/ui/PresentationMetadata.js";
import { ActionLegality } from "../js/application/action/ActionLegality.js";
import { createTargetChoiceRequest } from "../js/application/choice/TargetChoiceRequest.js";
import { Player } from "../js/application/match/Player.js";
import { renderNetworkSquadSelectionView } from "../js/ui/network/NetworkSquadSelectionView.js";
import { playerPanelTemplate } from "../js/ui/templates.js";

/*
功能
创建只在测试中存在的双端 capability 与已连接会话。

调用方
Network 测试。

输入
可注入 Host RNG。

输出
host、guest、events 与生命周期通知。

读取状态
无。

写入状态
测试内存队列。

调用函数
NetworkSession.open/receive。

边界与不变量
不创建生产 FakeTransport，不进行网络访问。
*/
async function connectedPair(random = () => 0.25, names = {}) {
  const receivers = {};
  const events = [];
  let roomId;
  const capability = (role) => ({
    createRoom: async (room) => { roomId = room.roomId; return room; },
    joinRoom: async () => ({ roomId }),
    subscribe: (receive) => { receivers[role] = receive; return () => { delete receivers[role]; }; },
    send: (event) => { events.push(event); receivers[role === R.HOST ? R.GUEST : R.HOST]?.(structuredClone(event)); },
    close: () => {}
  });
  const host = new NetworkSession({ capability: capability(R.HOST), random, displayName: names.host ?? null });
  const guest = new NetworkSession({ capability: capability(R.GUEST), random: () => { throw Error("Guest 不得 shuffle"); }, displayName: names.guest ?? null });
  await host.open(R.HOST);
  await guest.open(R.GUEST, { host: "test-room", port: NETWORK_DEFAULT_PORT });
  const connect = () => {
    receivers.GUEST({ type: E.PEER_CONNECTED, roomId, sender: NETWORK_CAPABILITY_SENDER });
    receivers.HOST({ type: E.PEER_CONNECTED, roomId, sender: NETWORK_CAPABILITY_SENDER });
  };
  connect();
  return { host, guest, events, connect, roomId };
}

/*
功能
为两端选择不冲突角色与指定阵营席位。

调用方
Network Ready 与 Match 测试。

输入
双端 fixture 与是否同阵营。

输出
无。

读取状态
session local candidates/seats。

写入状态
经 select 提交选择。

调用函数
NetworkSession.select。

边界与不变量
不跳过 setup authority。
*/
function choosePair(pair, sameTeam = true) {
  const h = pair.host.snapshot();
  const dawn = h.seats.filter((seat) => seat.teamId === "dawn");
  const guestSeat = sameTeam ? dawn[1] : h.seats.find((seat) => seat.teamId === "dusk");
  pair.host.select({ characterId: h.candidates[0], ...dawn[0] });
  pair.guest.select({ characterId: pair.guest.snapshot().candidates.find((id) => id !== pair.host.snapshot().localSelection?.characterId), ...guestSeat });
}

/*
功能
为 viewer rotation 测试把两名真人放到指定 canonical 席位。

调用方
Network canonical seat 与正式 UI 测试。

输入
双端 fixture、Host 与 Guest 的零基 canonical seatIndex。

输出
无。

读取状态
共享 seats 与共享候选池。

写入状态
经 Session authority 提交双方选择。

调用函数
NetworkSession.select。

边界与不变量
只选择既有合法席位；不旋转或改写 setup。
*/
function choosePairAtSeats(pair, hostSeatIndex, guestSeatIndex) {
  const host = pair.host.snapshot();
  const guest = pair.guest.snapshot();
  pair.host.select({ characterId: host.candidates[0], ...host.seats[hostSeatIndex] });
  pair.guest.select({ characterId: guest.candidates.find((id) => id !== pair.host.snapshot().localSelection?.characterId), ...guest.seats[guestSeatIndex] });
}

  /*
  功能
  为 Network 定向测试提供正式模板路径和可控交互的 UI。

  调用方
  Network 测试。

  输入
  无。

  输出
  可检查正式 markup 的 UI fixture。

  读取状态
  无。

  写入状态
  测试 DOM 替身。

  调用函数
  UIManager 原型渲染函数、MatchMvpResultView。

  边界与不变量
  只替换浏览器环境，不创建 Guest Match 或规则。
  */
function makeGuestUi() {
  const element = () => ({
    innerHTML: "", textContent: "", scrollLeft: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
  });
  const ui = {
    game: null, targetState: null, discardState: null, thinkingPlayerId: null,
    elements: Object.fromEntries(["human_panel", "cpu_grid", "human_hand", "status_metrics", "hand_hint",
      "action_prompt", "skill_button", "end_play_button", "discard_confirm_button", "cancel_interaction_button"].map((id) => [id, element()])),
    showGame(game) { assert.equal(game, null); this.game = game; },
    showNetworkPage() {}, playSound() {}, setPrompt: UIManager.prototype.setPrompt, setMusicTeam() {},
    cancelPendingInteractions() { this.targetState = null; this.discardState = null; },
    cancelChoiceInteractions() { this.targetState = null; this.discardState = null; },
    showGameOver() {}, showPublicPool() {}, hidePublicPool() {}, clearLog() {}, appendLog() {}, restoreLogBoundary() {},
    publicPoolView: { pending: null }, animationController: { flush() {} },
    renderBattlefield: UIManager.prototype.renderBattlefield,
    renderPresentedHand: UIManager.prototype.renderPresentedHand,
    renderPresentedControls: UIManager.prototype.renderPresentedControls,
    render: UIManager.prototype.render,
    requestResponse: () => new Promise(() => {})
  };
  ui.resultRoot = element();
  ui.matchMvpResultView = new MatchMvpResultView(ui.resultRoot);
  return ui;
}

/*
功能
为私密揭示生命周期提供正式 UIManager 与 PrivateRevealView 的小型 DOM fixture。

调用方
Network 私密揭示测试。

输入
无。

输出
可观察显示、关闭和定时清理的 UI。

读取状态
无。

写入状态
测试 DOM 与正式 UI 交互状态。

调用函数
makeGuestUi、PrivateRevealView、UIManager。

边界与不变量
不创建 Guest 游戏状态；只替换浏览器元素，不替换揭示生命周期。
*/
function makeRevealUi() {
  const ui = makeGuestUi();
  const root = { innerHTML: "", textContent: "", hidden: true,
    classList: { add() { root.hidden = true; }, remove() { root.hidden = false; } },
    querySelector: () => ({ addEventListener() {} }) };
  ui.privateRevealView = new PrivateRevealView(root);
  ui.privateRevealTimer = null;
  ui.showPrivateReveal = UIManager.prototype.showPrivateReveal;
  ui.cancelChoiceInteractions = UIManager.prototype.cancelChoiceInteractions;
  ui.cancelPendingInteractions = () => ui.cancelChoiceInteractions();
  ui.interactionController = { cancel() {} };
  ui.publicPoolView.cancel = () => {};
  ui.elements.response_panel = { innerHTML: "", classList: { add() {} } };
  return ui;
}

  /*
  功能
  提供加入房间表单的浏览器校验替身。

  调用方
  Network 表单与粘贴测试。

  输入
  Host 与端口初值。

  输出
  form fixture。

  读取状态
  无。

  写入状态
  测试字段与错误提示。

  调用函数
  无。

  边界与不变量
  只模拟 DOM；提交仍经过正式 endpoint 校验。
  */
function makeJoinForm(host = "test-room", port = NETWORK_DEFAULT_PORT) {
  const error = { textContent: "" };
  const input = { value: host, validationMessage: "", matches: () => true, setCustomValidity(message) { this.validationMessage = message; } };
  const form = { elements: { host: input, port: { value: String(port) } }, matches: () => true, querySelector: () => error };
  input.form = form;
  return form;
}

/*
功能
注册 Network setup、lifecycle、control 和持久化定向测试。

调用方
tests/run.mjs 核心状态 → Match setup。

输入
test registrar 与既有 makeUi。

输出
无。

读取状态
无。

写入状态
测试注册表。

调用函数
test。

边界与不变量
所有随机验证仅证明正确性，不运行平衡或自博弈。
*/

/*
功能
建立多个已认证内存连接以验证同一个 NetworkSession。

调用方
多人 Network contract tests。

输入
真人数量 1–5。

输出
Host、Guests、envelopes 和清理函数。

读取状态
无。

写入状态
仅测试内存 receivers 和生产 session。

调用函数
NetworkSession.open/addParticipant。

边界与不变量
不启动 Socket、浏览器、Electron 或真实对局循环。
*/

async function connectedRoom(humanCount) {
  const receivers = new Map(), events = [];
  let roomId, host;
  const capability = (connectionId) => ({
    createRoom: async (room) => { roomId = room.roomId; return { ...room, remoteAddress: "10.0.0.1" }; },
    joinRoom: async () => ({ roomId }),
    subscribe: (receive) => { receivers.set(connectionId, receive); return () => receivers.delete(connectionId); },
    send: (event) => {
      events.push(structuredClone(event));
      if (connectionId === "host") {
        const recipient = host.snapshot().participants[event.recipientParticipantId];
        receivers.get(recipient?.connectionId)?.({ ...structuredClone(event), connectionId: "host" });
      } else receivers.get("host")?.({ ...structuredClone(event), connectionId });
    },
    close() {}
  });
  host = new NetworkSession({ capability: capability("host"), random: () => 0.25 });
  await host.open(R.HOST);
  host.setMaxHumanCount(5);
  const guests = [];
  for (let index = 1; index < humanCount; index += 1) {
    const connectionId = `connection-${index}`;
    const guest = new NetworkSession({ capability: capability(connectionId), random: () => { throw Error("Guest RNG"); } });
    await guest.open(R.GUEST, { host: "test-room", port: NETWORK_DEFAULT_PORT });
    assert.equal(host.addParticipant({ connectionId, remoteAddress: `::ffff:10.0.0.${index + 1}` }).ok, true);
    guests.push(guest);
  }
  return { host, guests, events, roomId,
    close() { host.close(); for (const guest of guests) guest.close(); }
  };
}

/*
功能
通过真实 selection 与确认入口准备全体真人。

调用方
多人 Network tests。

输入
connectedRoom fixture。

输出
无。

读取状态
session candidates 与 canonical seats。

写入状态
经生产入口写成员 selection/ready。

调用函数
select、confirm。

边界与不变量
不调用 start，也不绕过任何屏障。
*/

function chooseRoom(room) {
  for (const [index, session] of [room.host, ...room.guests].entries()) {
    const snapshot = session.snapshot();
    session.select({ characterId: snapshot.candidates[index], ...snapshot.seats[index] });
    session.confirm();
  }
}

export function registerNetworkTests(test, { makeUi, instance }) {

  test("Network：正式回合提示按viewer归属且Guest保留主提示与hand hint", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostUi = makeUi();
    const hostPrompts = [];
    hostUi.setPrompt = (message, hint) => hostPrompts.push([message, hint]);
    const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    const guestPrompts = [];
    ui.setPrompt = (message, hint) => { guestPrompts.push([message, hint]); UIManager.prototype.setPrompt.call(ui, message, hint); };
    const view = new NetworkGameView({ ui, submit() {} });
    const off = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      const actors = [game.controlRouter.humanPlayer(), game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN)];
      game.controlRouter.waitForHumanPlay = async () => false;
      for (const actor of actors) {
        game.state.currentPlayerIndex = actor.seatIndex;
        await game.turnWorkflow.takeTurn(actor, game.state.gameId);
        const own = ["你的出牌阶段：选择手牌、发动技能，或结束出牌。", "从手牌中选择可用牌"];
        const waiting = ["等待另一名玩家行动", "对方正在选择手牌或技能"];
        assert.deepEqual(hostPrompts.at(-1), actor === actors[0] ? own : waiting);
        assert.deepEqual(guestPrompts.at(-1), actor === actors[1] ? own : waiting);
        const expected = guestPrompts.at(-1);
        assert.equal(ui.elements.action_prompt.textContent, expected[0]);
        assert.equal(ui.elements.hand_hint.textContent, expected[1]);
        const pending = game.controlRouter.requestRemote({ kind: "player-intent", actorId: actors[1].id, gameId: game.state.gameId });
        const request = pair.guest.gameChannel.snapshot().requests[0];
        assert.equal(ui.elements.action_prompt.textContent, expected[0], "请求label不得覆盖正式提示");
        pair.guest.gameChannel.respond(request.requestId, { status: "selected", selectedIds: [request.options.at(-1).optionId] });
        await pending;
      }
      game.ui.setPrompt("HOST_PRIVATE_PROMPT", "HOST_PRIVATE_HAND");
      game.networkBridge.publish();
      assert.doesNotMatch(JSON.stringify(pair.guest.gameChannel.snapshot()), /HOST_PRIVATE/);
      game.presentationPort.setPrompt("公开阶段结束", "正式阶段提示");
      assert.deepEqual(guestPrompts.at(-1), ["公开阶段结束", "正式阶段提示"]);
    } finally { off(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：真实card与skill结算提示归属正确且Guest正式cue各播放一次", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostUi = makeUi();
    const hostPrompts = [];
    hostUi.setPrompt = (message, hint) => hostPrompts.push([message, hint]);
    hostUi.playSound = () => {};
    const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi(), sounds = [], guestPrompts = [];
    ui.playSound = (cue) => sounds.push(cue);
    ui.setPrompt = (message, hint) => guestPrompts.push([message, hint]);
    ui.setCurrentCard = () => {};
    const view = new NetworkGameView({ ui, submit() {} });
    const off = pair.guest.gameChannel.subscribe((snapshot) => {
      view.update(snapshot);
      if (snapshot.projection?.presentation?.kind === "action-cue") view.update(snapshot);
    });
    try {
      for (const control of [C.LOCAL_HUMAN, C.REMOTE_HUMAN]) {
        const actor = game.state.players.find((player) => player.controlType === control);
        actor.applyCharacter(game.state, CHARACTER_BY_ID["blade-walker"]);
        game.state.currentPlayerIndex = actor.seatIndex;
        game.controlRouter.waitForHumanPlay = async () => false;
        await game.turnWorkflow.takeTurn(actor, game.state.gameId);
        game.state.phase = "play";
        actor.energy = 0;
        const card = instance("charge"); actor.hand.push(card);
        const start = sounds.length;
        assert.equal(await game.actionWorkflow.playCard(actor, card), true);
        const localOwn = control === C.LOCAL_HUMAN;
        assert.deepEqual((localOwn ? hostPrompts : guestPrompts).at(-1), ["继续出牌，或结束本次出牌阶段。", "选择一张可用手牌"]);
        assert.deepEqual((localOwn ? guestPrompts : hostPrompts).at(-1), ["等待另一名玩家行动", "对方正在选择手牌或技能"]);
        actor.energy = 3;
        assert.equal(await game.actionWorkflow.useActiveSkill(actor, "breakArmy"), true);
        assert.deepEqual((localOwn ? hostPrompts : guestPrompts).at(-1), ["技能结算完成，继续出牌或结束阶段。", "选择一张可用手牌"]);
        assert.deepEqual((localOwn ? guestPrompts : hostPrompts).at(-1), ["等待另一名玩家行动", "对方正在选择手牌或技能"]);
        pair.guest.gameChannel.notify();
        view.update(pair.guest.gameChannel.snapshot());
        game.ui.playSound("select");
        assert.deepEqual(sounds.slice(start), ["playCard", "skill"]);
        const previous = hostPrompts.length;
        assert.equal(await game.actionWorkflow.playCard(actor, card), false);
        assert.equal(hostPrompts.length, previous, "失败行动不产生完成提示");
        assert.deepEqual(sounds.slice(start), ["playCard", "skill"]);
      }
    } finally { off(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：阵亡目标仍有正式distance与target entry且不显示普通不可达", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const dead = game.state.players.find((player) => player.id !== actor.id);
    dead.alive = false; dead.hp = 0;
    const card = instance("assault"); actor.hand.push(card);
    game.networkBridge.publish();
    const display = pair.guest.gameChannel.snapshot().projection.display;
    assert.equal(display.distances[dead.id].distanceState, "已阵亡");
    assert.equal(display.distances[dead.id].reachable, false);
    const prepared = game.networkBridge.prepareDecision({ kind: "target", actorId: actor.id,
      context: { cardId: card.id }, options: game.state.players.filter((player) => player.alive && player.id !== actor.id).map((player) => ({ optionId: player.id })) });
    const ui = makeGuestUi();
    const view = new NetworkGameView({ ui, submit() {} });
    view.update(pair.guest.gameChannel.snapshot());
    ui.requestTarget = async (_players, _label, meta) => {
      assert.equal(meta.targetDisplay[dead.id].distanceState, "已阵亡");
      assert.equal(meta.targetDisplay[dead.id].available, false);
      for (const target of game.state.players.filter((player) => player.id !== actor.id)) {
        assert.equal(meta.targetDisplay[target.id].distanceState,
          UIManager.prototype.getDistanceState.call({ game, targetState: { meta: { card } } }, actor, target));
      }
      return null;
    };
    try {
      const deadPanel = view.model.battlefield.opponents.find((panel) => panel.player.id === dead.id);
      assert.equal(deadPanel.options.distanceState, "已阵亡");
      await view.presentDecision(prepared.view);
    } finally { view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：借势保留最终确认且转移保留分阶段目标并只发送有限选项", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const first = game.state.players[2];
    first.equipment = instance("energyDevice");
    const card = instance("leverage");
    actor.hand.push(card);
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    ui.elements.response_panel = { innerHTML: "", classList: { add() {}, remove() {} } };
    ui.requestTarget = UIManager.prototype.requestTarget;
    ui.cancelTarget = UIManager.prototype.cancelTarget;
    ui.renderTargetConfirmation = UIManager.prototype.renderTargetConfirmation;
    ui.interactionController = new InteractionController(ui);
    const view = new NetworkGameView({ ui, submit: (...args) => pair.guest.gameChannel.respond(...args) });
    const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      const pending = game.controlRouter.requestCardFlow(actor, card, [], () => { throw Error("不得在Host弹出Guest选择"); });
      const request = pair.guest.gameChannel.snapshot().requests[0];
      const option = request.options.find((entry) => entry.targetIds[1] === actor.id);
      assert.ok(option);
      const stages = [];
      for (const [index, id] of option.targetIds.entries()) {
        const stage = ui.targetState;
        stages.push({ prompt: stage.prompt, sourceId: stage.meta.source.id, cardId: stage.meta.card.definitionId, stepTitle: stage.meta.stepTitle });
        assert.equal(stage.meta.source.id, index === 0 ? actor.id : first.id);
        for (const target of game.state.players.filter((player) => player.id !== stage.meta.source.id)) {
          const source = index === 0 ? actor : first;
          const expected = UIManager.prototype.getDistanceState.call({ game, targetState: stage }, source, target);
          assert.equal(stage.meta.targetDisplay[target.id].distanceState, expected);
        }
        if (index === 1) {
          assert.equal(view.model.battlefield.self.options.distanceState, stage.meta.targetDisplay[actor.id].distanceState);
          assert.equal(view.model.battlefield.self.options.distanceInfo.distance, ActionLegality.getDistance(game, first, actor));
        }
        stage.selected = stage.players.find((player) => player.id === id);
        UIManager.prototype.confirmTarget.call(ui);
        await Promise.resolve();
      }
      assert.equal(ui.interactionController.pending.type, "confirm");
      assert.match(ui.elements.response_panel.innerHTML, /借势 · 确认/);
      assert.ok(ui.elements.response_panel.innerHTML.includes(first.equipment.name));
      assert.equal(pair.events.filter((event) => event.type === E.DECISION_RESPONSE).length, 0);
      const localStages = [];
      const local = new InteractionController({ requestTarget: async (players, prompt, meta) => {
        localStages.push({ prompt, sourceId: meta.source.id, cardId: meta.card.definitionId, stepTitle: meta.stepTitle });
        return players.find((player) => player.id === option.targetIds[localStages.length - 1]);
      } });
      local.requestConfirmation = async (title, summary) => {
        assert.equal(title, "借势 · 确认");
        assert.ok(ui.elements.response_panel.innerHTML.includes(summary));
        return true;
      };
      const expected = await local.requestCardFlow(game, actor, card, []);
      assert.deepEqual(stages, localStages);
      ui.interactionController.confirm();
      assert.deepEqual(await pending, expected);
      const response = pair.events.findLast((event) => event.type === E.DECISION_RESPONSE);
      assert.equal(response.payload.status, "selected");
      assert.deepEqual(response.payload.selectedIds, [option.optionId]);
      assert.doesNotMatch(JSON.stringify(response.payload), /equipmentDefinitionId|firstTargetId|secondTargetId/);
      assert.equal(ui.game, null);
      assert.ok(actor.hand.includes(card));
      assert.ok(first.equipment);
      const transfer = instance("transfer");
      actor.hand.push(transfer);
      const transferPending = game.controlRouter.requestCardFlow(actor, transfer, [], () => { throw Error("不得在Host弹出Guest选择"); });
      const transferRequest = pair.guest.gameChannel.snapshot().requests[0];
      const transferOption = transferRequest.options[0];
      assert.ok(transferOption);
      const responsesBefore = pair.events.filter((event) => event.type === E.DECISION_RESPONSE).length;
      for (const [index, id] of transferOption.targetIds.entries()) {
        assert.match(ui.targetState.prompt, index === 0 ? /牌来源/ : /接收者/);
        assert.equal(Boolean(ui.targetState.meta.confirmSelection), false);
        assert.equal(pair.events.filter((event) => event.type === E.DECISION_RESPONSE).length, responsesBefore);
        UIManager.prototype.handlePlayerClick.call(ui, { target: { closest: (selector) => selector === "[data-player-id]" ? { dataset: { playerId: id } } : null } });
        await Promise.resolve();
      }
      assert.deepEqual(await transferPending, { sourceId: transferOption.targetIds[0], receiverId: transferOption.targetIds[1] });
      assert.equal(pair.events.filter((event) => event.type === E.DECISION_RESPONSE).length, responsesBefore + 1);
      for (const flowCard of [card, transfer]) {
        const cancelled = game.controlRouter.requestCardFlow(actor, flowCard, [], () => { throw Error("不得在Host弹出Guest选择"); });
        assert.equal(pair.guest.gameChannel.snapshot().requests[0].kind, "card-flow");
        ui.cancelTarget();
        assert.equal(await cancelled, null);
        assert.deepEqual(pair.guest.gameChannel.snapshot().requests, []);
        assert.ok(actor.hand.includes(flowCard));
      }
    } finally { unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：响应快捷跳过必须被Host和Guest分别合法证明", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostUi = makeUi();
    const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const host = game.controlRouter.humanPlayer();
    const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const responder = game.state.players[2];
    const card = instance("charge");
    responder.hand.push(card);
    game.cardKnowledge.remember(host, responder, card);
    let boundaries = 0;
    game.cleanupManager.delay = async () => { boundaries += 1; return true; };
    try {
      for (const guestKnows of [false, true]) {
        if (guestKnows) game.cardKnowledge.remember(guest, responder, card);
        boundaries = 0;
        const eventStart = pair.events.length;
        const result = await game.responseWorkflow.requestCardResponse(responder, "block", { source: host, target: responder, card: instance("assault") }, 1);
        assert.equal(result.status, "unavailable");
        assert.equal(boundaries, guestKnows ? 0 : 1);
        const thinking = pair.events.slice(eventStart).some((event) => event.payload?.presentation?.kind === "thinking"
          && event.payload.presentation.playerId === responder.id);
        assert.equal(thinking, !guestKnows);
        assert.deepEqual(responder.hand, [card]);
      }
    } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：Guest复用正式响应确认支持AssaultDuel救援借势与零卡技能", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    actor.hand.push(instance("block"), instance("assault"), instance("recover"));
    pair.host.gameReady(); pair.guest.gameReady();
    const previousWindow = globalThis.window;
    globalThis.window = { clearInterval() {} };
    const ui = makeGuestUi();
    ui.elements.response_panel = { innerHTML: "", classList: { add() {}, remove() {} } };
    ui.requestResponse = UIManager.prototype.requestResponse;
    const view = new NetworkGameView({ ui, submit: (...args) => pair.guest.gameChannel.respond(...args) });
    const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      for (const [type, cardIndex, count] of [["block", 0, 1], ["assaultDiscard", 1, 1], ["dyingRescue", 2, 1], ["leverageAssault", 1, 1], ["skill", 0, 0]]) {
        const expected = count ? [actor.hand[cardIndex].id] : [];
        const pending = game.choicePort.request({
          kind: "response", requestId: "response-" + type, actorId: actor.id, gameId: game.state.gameId,
          options: expected.map((optionId) => ({ optionId })), constraints: { requiredCount: count, responseType: type },
          canDecline: true, context: { label: type, presentation: { eventText: "公开事件", buttonLabel: "完成响应", availabilityText: "可响应" } }
        });
        assert.match(ui.elements.response_panel.innerHTML, /响应窗口|公开事件/);
        UIManager.prototype.resolveResponse.call(ui, true);
        assert.deepEqual(await pending, { status: "selected", selectedIds: expected });
      }
      assert.equal(ui.game, null);
    } finally {
      unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close();
      globalThis.window = previousWindow;
    }
  });

  test("Network：Guest沿用正式目标和弃牌控件且取消迟到输入不再提交", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    actor.hand.push(instance("charge"), instance("shield"));
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    ui.elements.response_panel = { innerHTML: "", classList: { add() {}, remove() {} } };
    ui.requestTarget = UIManager.prototype.requestTarget;
    ui.cancelTarget = UIManager.prototype.cancelTarget;
    ui.renderTargetConfirmation = UIManager.prototype.renderTargetConfirmation;
    ui.requestDiscard = UIManager.prototype.requestDiscard;
    const sent = [];
    const view = new NetworkGameView({ ui, submit: (...args) => { sent.push(args); pair.guest.gameChannel.respond(...args); } });
    const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      let pending = pair.host.requestDecision(createTargetChoiceRequest({ requestId: "ordinary-target", actorId: actor.id,
        gameId: game.state.gameId, stateVersion: game.state.stateVersion, targets: [actor], label: "选择本人" }));
      assert.equal(ui.targetState.meta.canDecline, true);
      assert.doesNotMatch(ui.elements.response_panel.innerHTML, /data-target-confirm|data-target-cancel|确认选择/);
      assert.equal(Boolean(ui.targetState.meta.confirmSelection), false);
      const illegal = game.state.players.find((player) => player.id !== actor.id);
      UIManager.prototype.handlePlayerClick.call(ui, { target: { closest: (selector) => selector === "[data-player-id]" ? { dataset: { playerId: illegal.id } } : null } });
      assert.equal(sent.length, 0);
      assert.ok(ui.targetState);
      UIManager.prototype.handlePlayerClick.call(ui, { target: { closest: (selector) => selector === "[data-player-id]" ? { dataset: { playerId: actor.id } } : null } });
      assert.equal(ui.targetState, null);
      assert.deepEqual(await pending, { status: "selected", selectedIds: [actor.id] });
      pending = pair.host.requestDecision({ kind: "discard", actorId: actor.id, gameId: game.state.gameId,
        options: actor.hand.map((card) => ({ optionId: card.id })), constraints: { requiredCount: 1 }, context: { label: "弃一张牌" } });
      UIManager.prototype.handleHandClick.call(ui, { target: { closest: () => ({ dataset: { cardId: actor.hand[1].id } }) } });
      assert.match(ui.elements.human_hand.innerHTML, /is-selected/);
      UIManager.prototype.confirmDiscard.call(ui);
      assert.deepEqual(await pending, { status: "selected", selectedIds: [actor.hand[1].id] });
      assert.equal(actor.hand.length, 2, "展示选择本身不能移动Host手牌");
      const old = { ...view.request, options: [], canDecline: true };
      view.dispose();
      const count = sent.length;
      view.answer(old, null);
      assert.equal(sent.length, count);
    } finally { unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：Guest普通目标取消收束Host请求且卡牌技能不提交不耗资源", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    actor.applyCharacter(game.state, CHARACTER_BY_ID["spirit-medic"]);
    actor.resetTurnFlags(game.state, game.teamRules.getRules(actor));
    actor.energy = 3; actor.hp = 2;
    game.state.currentPlayerIndex = actor.seatIndex;
    game.state.phase = "play";
    actor.hand.push(instance("assault"), instance("shield"), instance("duel"));
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    ui.elements.response_panel = { innerHTML: "", classList: { add() {}, remove() {} } };
    ui.requestTarget = UIManager.prototype.requestTarget;
    ui.cancelTarget = UIManager.prototype.cancelTarget;
    let cancelHidden = true;
    ui.elements.cancel_interaction_button.classList.toggle = (_name, hidden) => { cancelHidden = hidden; };
    const view = new NetworkGameView({ ui, submit: (...args) => pair.guest.gameChannel.respond(...args) });
    const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      for (const card of [...actor.hand, null]) {
        if (card) assert.equal(ActionLegality.canPlayCard(game, actor, card).ok, true);
        const before = JSON.stringify(game.state);
        const pending = card ? game.actionWorkflow.handleHumanCard(card.id, actor.id)
          : game.actionWorkflow.handleHumanSkill(actor.id);
        await new Promise((resolve) => setImmediate(resolve));
        const request = pair.guest.gameChannel.snapshot().requests[0];
        assert.equal(request?.kind, "target");
        assert.equal(request.canDecline, true);
        assert.equal(cancelHidden, false);
        assert.equal(Boolean(ui.targetState.meta.confirmSelection), false);
        assert.equal(game.actionWorkflow.getActionStateSnapshot().interactionLocked, true);
        ui.cancelTarget();
        assert.equal(await pending, false);
        assert.equal(ui.targetState, null);
        assert.equal(cancelHidden, true);
        assert.equal(game.actionWorkflow.getActionStateSnapshot().interactionLocked, false);
        assert.equal(game.actionWorkflow.getActionStateSnapshot().actionLocked, false);
        assert.deepEqual(pair.guest.gameChannel.snapshot().requests, []);
        assert.equal(JSON.stringify(game.state), before, "取消不得进入结算或更改牌、能量、技能次数和状态版本");
        const response = pair.events.findLast((event) => event.type === E.DECISION_RESPONSE);
        assert.equal(response.payload.requestId, request.requestId);
        assert.equal(response.payload.status, "declined");
        assert.deepEqual(response.payload.selectedIds, []);
        assert.equal(pair.guest.gameChannel.respond(request.requestId, { status: "declined", selectedIds: [] }), false);
      }
      const next = game.controlRouter.requestRemote({ kind: "player-intent", actorId: actor.id, gameId: game.state.gameId });
      assert.equal(view.request.kind, "player-intent");
      assert.equal(ui.elements.skill_button.disabled, false);
      view.intent("end");
      assert.deepEqual(await next, { kind: "end" });
      assert.equal(ui.game, null);
    } finally { unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：Host切换AI速度立即同步Guest只读档位且不写Guest偏好", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostUi = makeUi();
    hostUi.elements = {};
    hostUi.setAiSpeed = UIManager.prototype.setAiSpeed;
    const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    ui.aiSpeed = 1;
    ui.setAiSpeed = UIManager.prototype.setAiSpeed;
    const buttons = [1, 2, 3].map((speed) => ({ dataset: { aiSpeed: String(speed) }, disabled: false,
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }));
    ui.elements.ai_speed_control = { querySelectorAll: () => buttons };
    const view = new NetworkGameView({ ui, submit() { throw Error("速度展示不得发送决定"); } });
    const previousStorage = globalThis.localStorage;
    const writes = [];
    globalThis.localStorage = { setItem: (key, value) => writes.push([key, value]), removeItem() {} };
    const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      const stateVersion = game.state.stateVersion;
      for (const speed of [2, 3, 1]) {
        const snapshotsBefore = pair.events.filter((event) => event.type === E.GAME_SNAPSHOT).length;
        writes.length = 0;
        assert.equal(game.setAiSpeed(speed), speed);
        const snapshot = pair.guest.gameChannel.snapshot();
        assert.equal(snapshot.projection.display.aiSpeed, speed);
        assert.equal(snapshot.projection.stateVersion, stateVersion);
        assert.equal(pair.events.filter((event) => event.type === E.GAME_SNAPSHOT).length, snapshotsBefore + 1);
        for (const button of buttons) {
          assert.equal(button.disabled, true);
          assert.equal(button.attributes["aria-pressed"], String(Number(button.dataset.aiSpeed) === speed));
        }
        assert.equal(ui.aiSpeed, 1, "Guest 本地偏好字段保持不变");
        assert.deepEqual(writes, [["five-realms-ai-speed", String(speed)]], "只有 Host 的 setAiSpeed 写一次偏好");
        assert.equal(ui.game, null);
      }
    } finally {
      unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close();
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  test("Network：Host濒死在damage和loseHp救援前刷新真实HP人物面板", async () => {
    const previousDocument = globalThis.document;
    globalThis.document = {};
    try {
      for (const kind of ["damage", "loseHp"]) {
        const pair = await connectedPair();
        choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
        const hostUi = makeUi();
        const panelUi = makeGuestUi();
        hostUi.elements = panelUi.elements;
        hostUi.animationController = panelUi.animationController;
        hostUi.isGameAttached = (game) => game === hostUi.game;
        hostUi.getDistanceState = UIManager.prototype.getDistanceState;
        hostUi.renderHand = () => {};
        hostUi.renderControls = () => {};
        hostUi.render = UIManager.prototype.render;
        const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
        hostUi.game = game;
        game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
        const host = game.state.players.find((player) => player.controlType === C.LOCAL_HUMAN);
        const source = game.state.players.find((player) => player.battleTeam !== host.battleTeam);
        host.hp = 1;
        host.shield = 0;
        host.hand = [instance("recover")];
        pair.host.gameReady(); pair.guest.gameReady();
        hostUi.render(game);
        assert.match(hostUi.elements.human_panel.innerHTML, /生命1点/);
        const trace = [];
        hostUi.showDying = (target, context) => {
          if (trace.length > 0) return;
          assert.equal(target, host);
          assert.equal(context.currentHp, 0);
          assert.match(hostUi.elements.human_panel.innerHTML, /生命0点/);
          assert.doesNotMatch(hostUi.elements.human_panel.innerHTML, /life-cell is-full/);
          trace.push("dying");
        };
        hostUi.requestResponse = async (request) => {
          assert.deepEqual(trace, ["dying"]);
          assert.equal(host.hp, 0);
          assert.match(hostUi.elements.human_panel.innerHTML, /生命0点/);
          trace.push("rescue");
          return { status: "used", selectedIds: request.legalCardIds.slice(0, request.requiredCount) };
        };
        try {
          const result = kind === "damage"
            ? await game.damage(source, host, 1, { canBlock: false })
            : await game.combatWorkflow.loseHp(host, 1, { source });
          assert.equal(result, 1);
          assert.deepEqual(trace, ["dying", "rescue"]);
          assert.equal(host.hp, 1);
          assert.equal(host.alive, true);
        } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
      }
    } finally {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  });

  test("Network：正式战场按Guest旋转且canonical座次、身份、距离和手牌知识属实", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 0, 2); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const host = game.state.players.find((player) => player.controlType === C.LOCAL_HUMAN);
    guest.equipment = instance("telescope");
    guest.hand.push(instance("charge"));
    const knownHostCard = { ...instance("block"), id: "HOST_KNOWN_ID" };
    host.hand.push(knownHostCard, { ...instance("assault"), id: "HOST_SECRET_ID" });
    guest.aiMemory.knownCardsByPlayer[host.id] = { [knownHostCard.id]: knownHostCard.definitionId };
    host.shield = 2;
    host.statuses.exposeWeakness = { stacks: 3 };
    host.statuses.seal = {};
    host.turnFlags.momentum = 2;
    host.equipment = instance("recycleDevice");
    host.turnFlags.recycleDeviceUses = 1;
    pair.host.gameChannel.publish();
    const ui = makeGuestUi();
    const view = new NetworkGameView({ ui, submit() {} });
    const snapshot = pair.guest.gameChannel.snapshot();
    view.update(snapshot);
    assert.deepEqual(game.state.players.map((player) => player.seatIndex), [0, 1, 2, 3, 4]);
    assert.deepEqual(game.state.players.map((player) => player.id), pair.host.snapshot().matchSetup.players.map((player) => player.playerId));
    assert.equal(view.model.battlefield.self.player.id, guest.id);
    assert.deepEqual(view.model.battlefield.opponents.map(({ player }) => player.id), [
      ...game.state.players.slice(guest.seatIndex + 1), ...game.state.players.slice(0, guest.seatIndex)
    ].map((player) => player.id));
    assert.equal(view.model.human.id, guest.id);
    assert.equal(view.players.find((player) => player.id === host.id).hand.length, 0);
    const statuses = view.players.find((player) => player.id === host.id).statuses;
    assert.deepEqual(statuses.exposeWeakness, { stacks: 3 });
    assert.deepEqual(statuses.seal, {});
    for (const player of game.state.players.filter((player) => player.id !== guest.id)) {
      const expected = ActionLegality.describeDistance(game, guest, player);
      const actual = snapshot.projection.display.distances[player.id];
      assert.deepEqual({ seat: actual.seat, distance: actual.distance, range: actual.range }, expected);
      assert.equal(actual.reachable, expected.distance <= expected.range);
      assert.equal(actual.distanceState, UIManager.prototype.getDistanceState.call({ game }, guest, player));
    }
    const hostProjection = snapshot.projection.players.find((player) => player.playerId === host.id);
    assert.equal(hostProjection.observedHand.length, 2);
    assert.equal(hostProjection.observedHand.filter((card) => card.known).length, 1);
    assert.equal(hostProjection.observedHand.some((card) => Object.hasOwn(card, "id")), false);
    assert.match(ui.elements.cpu_grid.innerHTML, /破势 3|连势 2/);
    assert.match(ui.elements.cpu_grid.innerHTML, /回收站/);
    assert.match(ui.elements.cpu_grid.innerHTML, /1\/2/);
    assert.match(ui.elements.human_panel.innerHTML, /手牌1张/);
    assert.doesNotMatch(ui.elements.cpu_grid.innerHTML + ui.elements.human_panel.innerHTML, /HOST_SECRET_ID/);
    assert.match(ui.elements.human_panel.innerHTML, / · 你/);
    assert.match(ui.elements.human_panel.innerHTML, /network-role-badge[^>]*>Guest 1</);
    assert.match(ui.elements.cpu_grid.innerHTML, /network-role-badge[^>]*>Host</);
    assert.equal((ui.elements.cpu_grid.innerHTML.match(/network-role-badge/g) ?? []).length, 4, "三个 AI 显示实际控制权");
    const hostUi = makeGuestUi();
    Object.assign(hostUi, {
      game,
      isGameAttached: () => true,
      getDistanceState: UIManager.prototype.getDistanceState,
      renderHand() {}, renderControls() {}
    });
    const previousDocument = globalThis.document;
    try {
      globalThis.document = {};
      UIManager.prototype.render.call(hostUi, game);
    } finally {
      globalThis.document = previousDocument;
    }
    assert.match(hostUi.elements.human_panel.innerHTML, new RegExp(`data-player-id="${host.id}"`));
    assert.match(hostUi.elements.human_panel.innerHTML, /network-role-badge[^>]*>Host</);
    assert.match(hostUi.elements.cpu_grid.innerHTML, /network-role-badge[^>]*>Guest 1</);
    const distanceTarget = game.state.players[3];
    assert.notEqual(
      ActionLegality.describeDistance(game, host, distanceTarget).distance,
      snapshot.projection.display.distances[distanceTarget.id].distance
    );
    assert.equal(ui.game, null);
    view.dispose(); game.dispose(); pair.host.close(); pair.guest.close();
  });

  test("Network：Host与Guest snapshot 保留双方displayName且对局内真人标签使用displayName", async () => {
    const pair = await connectedPair(undefined, { host: "lelexia", guest: "炎术士" });
    const beforeHost = pair.host.snapshot();
    const beforeGuest = pair.guest.snapshot();
    const hostId = beforeHost.participantId;
    const guestId = beforeGuest.participantId;
    assert.notEqual(hostId, guestId);
    assert.equal(beforeHost.participants[hostId].displayName, "lelexia");
    assert.equal(beforeHost.participants[guestId].displayName, "炎术士");
    assert.equal(beforeGuest.participants[hostId].displayName, "lelexia");
    assert.equal(beforeGuest.participants[guestId].displayName, "炎术士");

    choosePair(pair);
    pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const setup = pair.host.snapshot().matchSetup;
    const guestSetup = pair.guest.snapshot().matchSetup;
    const humans = setup.players.filter((seat) => seat.controller.type !== "AI");
    assert.equal(humans.length, 2);
    assert.deepEqual(humans.map((seat) => seat.displayName).sort(), ["lelexia", "炎术士"]);
    assert.deepEqual(humans.map((seat) => seat.networkRole).sort(), ["lelexia", "炎术士"]);
    assert.deepEqual(humans.map((seat) => seat.controller.displayName).sort(), ["lelexia", "炎术士"]);
    assert.equal(new Set(humans.map((seat) => seat.controller.participantId)).size, 2);
    assert.deepEqual(
      guestSetup.players.map((seat) => [seat.playerId, seat.controller.participantId, seat.networkRole]),
      setup.players.map((seat) => [seat.playerId, seat.controller.participantId, seat.networkRole])
    );

    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(setup);
    const local = game.state.players.find((player) => player.controlType === C.LOCAL_HUMAN);
    const remote = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    assert.equal(local.networkRole, "lelexia");
    assert.equal(remote.networkRole, "炎术士");
    const localMarkup = playerPanelTemplate(local, { networkRole: local.networkRole, isHuman: true, isViewer: true });
    const remoteMarkup = playerPanelTemplate(remote, { networkRole: remote.networkRole, humanTeam: local.battleTeam });
    assert.match(localMarkup, /network-role-badge[^>]*>lelexia</);
    assert.match(remoteMarkup, /network-role-badge[^>]*>炎术士</);
    assert.doesNotMatch(remoteMarkup, /<strong>Host<\/strong>|<strong>Guest 1<\/strong>/);
    game.dispose();
  });

  test("Network：displayName重名不影响participantId、席位与控制权ownership", async () => {
    const pair = await connectedPair(undefined, { host: "同名人", guest: "同名人" });
    const hostId = pair.host.snapshot().participantId;
    const guestId = pair.guest.snapshot().participantId;
    assert.notEqual(hostId, guestId);
    assert.equal(pair.host.snapshot().participants[hostId].displayName, "同名人");
    assert.equal(pair.host.snapshot().participants[guestId].displayName, "同名人");
    assert.equal(pair.guest.snapshot().participants[guestId].displayName, "同名人");

    choosePair(pair);
    const hostSelection = pair.host.snapshot().localSelection;
    pair.host.confirm(); pair.guest.confirm();
    assert.equal(pair.host.snapshot().canStart, true);
    assert.equal(pair.host.start().ok, true);
    const setup = pair.host.snapshot().matchSetup;
    const humanControllers = setup.players
      .filter((seat) => seat.controller.type !== "AI")
      .map((seat) => seat.controller);
    assert.deepEqual(humanControllers.map((controller) => controller.displayName), ["同名人", "同名人"]);
    assert.equal(new Set(humanControllers.map((controller) => controller.participantId)).size, 2);
    assert.equal(setup.players.filter((seat) => seat.controller.participantId === hostId).length, 1);
    assert.equal(setup.players.filter((seat) => seat.controller.participantId === guestId).length, 1);
    const hostSeat = setup.players.find((seat) => seat.controller.participantId === hostId);
    assert.equal(hostSeat.characterId, hostSelection.characterId);
    assert.equal(hostSeat.controlType, C.LOCAL_HUMAN);
    assert.equal(setup.players.find((seat) => seat.controller.participantId === guestId).controlType, C.REMOTE_HUMAN);
  });

  test("Network：单人模式Player不注入联机displayName且UI不显示联机badge", () => {
    const single = new Player({
      id: "single-player", seatIndex: 0, controllerType: "human",
      controlType: C.LOCAL_HUMAN, battleTeam: "dawn"
    });
    assert.equal(single.networkRole, null);
    assert.equal(single.displayName, undefined);
    const markup = playerPanelTemplate(single, { isHuman: true, isViewer: true });
    assert.doesNotMatch(markup, /network-role-badge|联机玩家/);
  });

  test("Network：真人不在第零席时Match仍保持canonical并显式区分本地与远端", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 3, 1);
    pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostSetup = pair.host.snapshot().matchSetup;
    const guestSetup = pair.guest.snapshot().matchSetup;
    assert.deepEqual(hostSetup.players.map((player) => player.playerId), guestSetup.players.map((player) => player.playerId));
    assert.deepEqual(hostSetup.players.map((player) => player.seatIndex), [0, 1, 2, 3, 4]);
    assert.equal(hostSetup.players[3].controller.type, R.HOST);
    assert.equal(hostSetup.players[3].controlType, C.LOCAL_HUMAN);
    assert.equal(guestSetup.players[1].controller.type, R.GUEST);
    assert.equal(guestSetup.players[1].controlType, C.LOCAL_HUMAN);
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.runGameLoop = () => {};
    game.prepareNetworkMatch(hostSetup);
    assert.deepEqual(game.state.players.map((player) => player.seatIndex), [0, 1, 2, 3, 4]);
    assert.equal(game.state.players[3].networkRole, "Host");
    assert.equal(game.state.selectedCharacterId, game.state.players[3].characterId);
    pair.host.gameReady(); pair.guest.gameReady();
    assert.equal(await game.startPreparedMatch(), true);
    game.dispose(); pair.host.close(); pair.guest.close();
  });

  test("Network：Host非零席且与首席敌对时开局BGM使用本地控制身份", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const ui = makeUi();
    let musicTeam;
    Object.assign(ui, { attachGame() {}, showGame() {}, setMusicTeam(team) { musicTeam = team; } });
    const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
    // 执行实际入口函数，隔离顶层页面初始化；Match 与 controller router 使用生产实现。
    const prepare = new Function("createGameApplication", "ui", "MATCH_MODE", "setup", "networkSession",
      `let game; ${main.match(/function prepareNetworkMatch\(setup, networkSession\) \{[\s\S]*?\n\}/)[0]}
      prepareNetworkMatch(setup, networkSession); return game;`);
    const game = prepare(createGameApplication, ui, MATCH_MODE, pair.host.snapshot().matchSetup, pair.host);
    try {
      const host = game.controlRouter.humanPlayer();
      assert.equal(host.networkRole, "Host");
      assert.equal(host.seatIndex, 3);
      assert.notEqual(host.battleTeam, game.state.players[0].battleTeam);
      assert.equal(musicTeam, host.battleTeam);
    } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：开局日志按各自viewer渲染角色阵营且公开事实一致", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const ui = makeUi();
    const hostEntries = [];
    ui.appendLog = (entry) => hostEntries.push(entry);
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.runGameLoop = () => {};
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    try {
      await game.startPreparedMatch();
      const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
      const host = game.controlRouter.humanPlayer();
      const opening = hostEntries.find((entry) => entry.presentationFact?.type === "opening");
      assert.ok(opening);
      const guestLogs = pair.guest.gameChannel.snapshot().projection.display.logs;
      const guestOpening = guestLogs.find((entry) => entry.id === opening.id);
      for (const [entry, viewer, other] of [[opening, host, guest], [guestOpening, guest, host]]) {
        const text = entry.fragments.map((fragment) => fragment.text).join("");
        assert.equal(text, `你选择了${viewer.name}，你的阵营是${TEAM_PRESENTATION[viewer.battleTeam].name}。`);
        assert.deepEqual(entry.fragments.filter((fragment) => fragment.type === "player").map((fragment) => fragment.playerId), [viewer.id]);
        assert.ok(!text.includes(other.name));
      }
      assert.equal(Object.hasOwn(guestOpening, "presentationFact"), false);
      assert.deepEqual(guestLogs.filter((entry) => entry.id !== opening.id),
        hostEntries.filter((entry) => entry.id !== opening.id).map(({ id, kind, fragments }) => ({ id, kind, fragments })));
      game.state.logs.push({ id: "private-opening-data", message: "HOST_PRIVATE_OPENING_SECRET" });
      pair.host.gameChannel.publish();
      const payload = JSON.stringify(pair.guest.gameChannel.snapshot().projection.display.logs);
      assert.doesNotMatch(payload, /HOST_PRIVATE_OPENING_SECRET|knownCardsByPlayer/);
      for (const card of host.hand) assert.ok(!payload.includes(card.id));
    } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：正式presentation白名单保留来源目标判定VFX且日志不裸传Host私有牌名", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const ui = makeUi();
    ui.playRadarSuccess = () => {};
    ui.playLightningHit = () => {};
    ui.resetCurrentCard = () => {};
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const [host, target] = game.state.players;
    const card = instance("assault");
    game.ui.setCurrentCard(card, host.name, target.name, [{ id: target.id, name: target.name, secret: "NO_TARGET_SECRET" }]);
    let p = pair.guest.gameChannel.snapshot().projection.presentation;
    assert.equal(p.source, host.name); assert.equal(p.targetLabel, target.name);
    assert.deepEqual(p.displayTargets, [{ id: target.id, name: target.name, isSelf: false }]);
    game.ui.queueFeedback("damage", target.id, 2, "cross-slash");
    assert.equal(pair.guest.gameChannel.snapshot().projection.presentation.variant, "cross-slash");
    game.ui.showJudgment(target, card, { delayedStatusContext: { ownerName: target.name, statusName: "闪电", secret: "NO_JUDGMENT_SECRET" } });
    assert.deepEqual(pair.guest.gameChannel.snapshot().projection.presentation.delayedStatus, { ownerName: target.name, statusName: "闪电" });
    game.ui.setThinking(true, target, "正在选择行动");
    assert.equal(pair.guest.gameChannel.snapshot().projection.presentation.message, "正在选择行动");
    game.ui.showDying(target, { currentHp: -1, need: 2 });
    assert.equal(pair.guest.gameChannel.snapshot().projection.presentation.need, 2);
    game.ui.playLightningHit(target.id);
    assert.equal(pair.guest.gameChannel.snapshot().projection.presentation.view, "playLightningHit");
    const secret = instance("counter");
    host.hand.push(secret);
    for (const action of ["plunder", "steal"]) game.log({ type: "card-move", action,
      actorId: host.id, fromId: target.id, receiverId: host.id, cardId: secret.id }, "important");
    game.state.logs.push({ id: "untrusted", message: "HOST_PRIVATE_SECRET", fragments: [{ type: "text", text: "HOST_PRIVATE_SECRET" }] });
    pair.host.gameChannel.publish();
    const text = JSON.stringify(pair.guest.gameChannel.snapshot().projection);
    assert.doesNotMatch(text, /HOST_PRIVATE_SECRET|NO_TARGET_SECRET|NO_JUDGMENT_SECRET|反制/);
    const logs = pair.guest.gameChannel.snapshot().projection.display.logs;
    assert.ok(logs.some((entry) => entry.fragments.some((fragment) => fragment.text.includes("1张手牌"))));
    assert.ok(logs.some((entry) => entry.fragments.some((fragment) => fragment.text.includes("窃取"))));
    game.dispose(); pair.host.close(); pair.guest.close();
  });

  test("Network：长局日志按增量传输且RESYNC有界分块恢复完整顺序", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const shown = [], notices = [];
    const ui = makeGuestUi();
    ui.appendLog = (entry) => shown.push(entry);
    ui.restoreLogBoundary = (count) => { shown.length = count; };
    const view = new NetworkGameView({ ui, submit() {} });
    const off = pair.guest.gameChannel.subscribe((snapshot) => { notices.push(snapshot); view.update(snapshot); });
    try {
      const start = pair.events.length;
      for (let index = 0; index < 160; index += 1) {
        game.log(`${index}: ${"长日志".repeat(1200)}`);
        game.ui.render();
        game.ui.queueFeedback("heal", game.state.players[0], 1);
        game.ui.setCurrentCard("技能", game.state.players[0].id, "目标");
      }
      const updates = pair.events.slice(start).filter((event) => event.type === E.GAME_SNAPSHOT);
      assert.equal(updates.flatMap((event) => event.payload.display.logSync.entries).length, 160);
      assert.ok(updates.every((event) => !Object.hasOwn(event.payload.display, "logs")));
      assert.ok(updates.every((event) => event.payload.display.logSync.entries.length <= 1));
      assert.ok(updates.every((event) => Buffer.byteLength(JSON.stringify(event)) < 30000), "历史增长不能放大单消息");
      assert.ok(notices.slice(1).every((notice) => !Object.hasOwn(notice.projection.display, "logs")), "日常通知不clone累计日志");
      const expected = game.state.logs.map((entry) => entry.id);
      assert.deepEqual(shown.map((entry) => entry.id), expected);
      const beforeRecovery = pair.events.length;
      pair.guest.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      const recoveryDeadline = performance.now() + 3000;
      while (shown.length < expected.length && performance.now() < recoveryDeadline) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(shown.map((entry) => entry.id), expected);
      assert.deepEqual(pair.guest.gameChannel.snapshot().projection.display.logs.map((entry) => entry.id), expected);
      const recovery = pair.events.slice(beforeRecovery).filter((event) => event.type === E.GAME_SNAPSHOT);
      assert.ok(recovery.length > 1);
      assert.ok(recovery.every((event) => event.payload.display.logSync.entries.length <= 32));
      assert.ok(recovery.every((event) => Buffer.byteLength(JSON.stringify(event.payload.display.logSync.entries)) < 65536));
      const beforeRender = pair.events.length;
      game.ui.render();
      assert.equal(pair.events.slice(beforeRender).find((event) => event.type === E.GAME_SNAPSHOT).payload.display.logSync.entries.length, 0);
    } finally { off(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：RESYNC按成员合并频率且正常第二次恢复最终到达", async () => {
    const room = await connectedRoom(3);
    chooseRoom(room); room.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: room.host });
    game.prepareNetworkMatch(room.host.snapshot().matchSetup);
    const [a, b] = room.guests;
    try {
      const start = room.events.length;
      for (let index = 0; index < 100; index += 1) a.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      b.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      const snapshots = () => room.events.slice(start).filter((event) => event.type === E.GAME_SNAPSHOT);
      assert.equal(snapshots().filter((event) => event.recipientParticipantId === a.snapshot().participantId).length, 1);
      assert.equal(snapshots().filter((event) => event.recipientParticipantId === b.snapshot().participantId).length, 1);
      const end = performance.now() + 2000;
      while (snapshots().length < 3 && performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(snapshots().length, 3, "合并后补发，不能吞掉正常恢复");
      assert.equal(room.host.snapshot().state, S.LOADING_GAME);
    } finally { game.dispose(); room.close(); }
  });

  test("Network：publicLogs随正式rollback删除失效entry并保持后续追加顺序", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostUi = makeUi();
    hostUi.restoreLogBoundary = (count) => { hostUi.logs.length = count; };
    const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const ui = makeGuestUi(), shown = [];
    ui.appendLog = (entry) => shown.push(entry);
    ui.clearLog = () => { shown.length = 0; };
    ui.restoreLogBoundary = (count) => { shown.length = count; };
    const view = new NetworkGameView({ ui, submit() {} });
    const off = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      game.log("保留的日志");
      const retained = game.state.logs.slice();
      for (let index = 0; index < 5; index += 1) {
        const boundary = game.state.logs.length;
        const transaction = createActionTransaction({ roots: [game.state], logs: game.state.logs,
          randomPort: game.randomPort, restoreLogPresentation: (count) => game.ui.restoreLogBoundary(count) });
        game.state.stateVersion += 1;
        game.log(`撤销甲${index}`); game.log(`撤销乙${index}`);
        const staleIds = game.state.logs.slice(boundary).map((entry) => entry.id);
        assert.ok(shown.some((entry) => staleIds.includes(entry.id)));
        const beforeRollback = pair.guest.gameChannel.snapshot().projection;
        transaction.rollback();
        const logs = pair.guest.gameChannel.snapshot().projection.display.logs;
        assert.equal(logs.length, boundary, "完整publicLogs投影规模等于当前有效边界");
        assert.ok(logs.every((entry) => !staleIds.includes(entry.id)));
        assert.equal(pair.guest.gameChannel.snapshot().projection.stateVersion, game.state.stateVersion);
        assert.equal(pair.guest.gameChannel.receive({ type: E.GAME_SNAPSHOT, payload: beforeRollback }), false, "旧回滚epoch不能复活尾部日志");
        assert.deepEqual(shown.map((entry) => entry.id), game.state.logs.map((entry) => entry.id));
        game.ui.restoreLogBoundary(boundary);
        game.log(`新的日志${index}`);
        assert.deepEqual(pair.guest.gameChannel.snapshot().projection.display.logs.map((entry) => entry.id), game.state.logs.map((entry) => entry.id));
        assert.equal(shown.at(-1).fragments.map((fragment) => fragment.text).join(""), `新的日志${index}`);
      }
      for (const [index, entry] of retained.entries()) assert.equal(game.state.logs[index], entry);
      assert.doesNotMatch(JSON.stringify(shown), /撤销/);
    } finally { off(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：转移掠夺窃取真实结算日志分别按两端事件时知识渲染", async () => {
    for (const action of ["transfer", "plunder", "steal"]) {
      for (const [hostKnows, guestKnows] of [[true, false], [false, true], [true, true], [false, false]]) {
        const pair = await connectedPair();
        choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
        const hostEntries = [];
        const hostUi = makeUi();
        hostUi.appendLog = (entry) => hostEntries.push(entry);
        const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
        game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
        const host = game.controlRouter.humanPlayer();
        const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
        const source = game.state.players[0], owner = game.state.players[4];
        const moved = instance("counter");
        owner.hand.push(moved);
        if (hostKnows) game.cardKnowledge.remember(host, owner, moved);
        if (guestKnows) game.cardKnowledge.remember(guest, owner, moved);
        try {
          if (action === "steal") await game.skillEffectRuntime.execute(ACTIVE_SKILL_DEFINITIONS.stealSkill, source, [owner]);
          else await game.cardEffectRuntime.resolve(source, instance(action), [owner], action === "transfer"
            ? { privateTransferIntent: { from: owner, receiver: source, card: moved, zone: "hand" } }
            : { privateCardSelectionIntent: { owner, cards: [moved], zone: "hand" } });
          assert.ok(source.hand.includes(moved), `${action} 必须真实移动牌`);
          const hostLog = hostEntries.find((entry) => entry.presentationFact?.type === "card-move");
          assert.ok(hostLog, action);
          const guestLog = pair.guest.gameChannel.snapshot().projection.display.logs.find((entry) => entry.id === hostLog.id);
          for (const [entry, known] of [[hostLog, hostKnows], [guestLog, guestKnows]]) {
            const text = entry.fragments.map((fragment) => fragment.text).join("");
            assert.equal(text.includes("「反制」"), known, `${action}: ${text}`);
            assert.equal(text.includes("1张手牌"), !known);
          }
          const safe = JSON.stringify(guestLog);
          assert.doesNotMatch(safe, /definitionId|cardId|cardNamesByViewer|presentationFact/);
          assert.ok(!safe.includes(moved.id));
          const rendered = [];
          const ui = makeGuestUi(); ui.appendLog = (entry) => rendered.push(entry);
          const view = new NetworkGameView({ ui, submit() {} });
          view.update(pair.guest.gameChannel.snapshot());
          assert.deepEqual(rendered.find((entry) => entry.id === hostLog.id), guestLog);
          view.dispose();
          game.cardKnowledge.invalidate(moved.id, source.id);
          game.cardKnowledge.remember(guest, source, moved);
          pair.host.gameChannel.publish();
          assert.deepEqual(pair.guest.gameChannel.snapshot().projection.display.logs.find((entry) => entry.id === hostLog.id), guestLog);
        } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
      }
    }
  });

  test("Network：Guest正式手牌技能END只发送Host选项且重复点击不会修改投影", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    game.state.phase = "play"; game.state.currentPlayerIndex = actor.seatIndex;
    actor.hand.push(instance("charge"));
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    const sent = [];
    const view = new NetworkGameView({ ui, submit: (...args) => { sent.push(args); pair.guest.gameChannel.respond(...args); } });
    const pending = pair.host.requestDecision({ kind: "player-intent", gameId: game.state.gameId, actorId: actor.id });
    const snapshot = pair.guest.gameChannel.snapshot();
    view.update(snapshot);
    const before = JSON.stringify(view.projection);
    view.intent("card", "forged");
    assert.equal(sent.length, 0);
    view.intent("card", actor.hand[0].id);
    view.intent("card", actor.hand[0].id);
    assert.equal(sent.length, 1);
    assert.deepEqual(await pending, { kind: "card", cardId: actor.hand[0].id });
    assert.equal(JSON.stringify(view.projection), before);
    view.update(pair.guest.gameChannel.snapshot());
    const ending = pair.host.requestDecision({ kind: "player-intent", gameId: game.state.gameId, actorId: actor.id });
    view.update(pair.guest.gameChannel.snapshot());
    view.intent("end");
    assert.deepEqual(await ending, { kind: "end" });
    assert.equal(ui.game, null);
    view.dispose(); game.dispose(); pair.host.close(); pair.guest.close();
  });


  test("Network：同步响应完成后初始请求发送不得复活已接受的Decision", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    pair.host.gameReady(); pair.guest.gameReady();
    const seen = new Set();
    const unsubscribe = pair.guest.gameChannel.subscribe(({ requests }) => {
      for (const request of requests) {
        if (seen.has(request.requestId)) continue;
        seen.add(request.requestId);
        pair.guest.gameChannel.respond(request.requestId, {
          status: "selected", selectedIds: [request.options[0].optionId]
        });
      }
    });
    try {
      const result = await pair.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
        options: [{ optionId: actor.id }], constraints: { requiredCount: 1 }, context: {} });
      assert.equal(result.status, "selected");
      assert.equal(seen.size, 1);
      assert.equal(pair.events.filter((event) => event.type === E.DECISION_ACCEPTED).length, 1);
      assert.deepEqual(pair.guest.gameChannel.snapshot().requests, [], "Accepted 后不得重新登记已完成请求");
      assert.equal(pair.events.filter((event) => event.type === E.DECISION_REQUEST).length, 1);
    } finally {
      unsubscribe(); game.dispose(); pair.host.close(); pair.guest.close();
    }
  });

  test("Network：Guest出牌意图经原ActionWorkflow在Host真实结算并同步能量", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    game.runGameLoop = () => {};
    pair.host.gameReady(); pair.guest.gameReady();
    await game.startPreparedMatch();
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    game.state.currentPlayerIndex = actor.seatIndex;
    game.state.phase = "play";
    actor.energy = 0;
    const card = instance("charge");
    actor.hand.push(card);
    let used = false;
    pair.guest.gameChannel.subscribe(({ requests }) => {
      for (const request of requests) {
        assert.equal(request.kind, "player-intent");
        const option = !used ? request.options.find((entry) => entry.card?.id === card.id)
          : request.options.find((entry) => entry.label === "结束出牌");
        assert.ok(option);
        used = true;
        pair.guest.gameChannel.respond(request.requestId, { status: "selected", selectedIds: [option.optionId] });
      }
    });
    const finished = await game.controlRouter.waitForHumanPlay(actor, game.state.gameId, {
      waitLocal: () => { throw Error("不应在Host等待Guest本地输入"); },
      handleCard: (...args) => game.actionWorkflow.handleHumanCard(...args),
      handleSkill: (...args) => game.actionWorkflow.handleHumanSkill(...args)
    });
    assert.equal(finished, true);
    assert.equal(actor.energy, 1);
    assert.ok(!actor.hand.includes(card));
    assert.ok(game.state.discardPile.includes(card));
    const projected = pair.guest.gameChannel.snapshot().projection.players.find((player) => player.playerId === actor.id);
    assert.equal(projected.energy, 1);
    assert.ok(!projected.hand.some((entry) => entry.id === card.id));
    game.dispose();
  });

  test("Network：Host终局Result安全投影到Guest真实MVP模板且没有成就section", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const ui = makeUi();
    ui.showMatchPerformance = () => {};
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    await game.eventDispatcher.publishFact("gameStart", { gameId: game.state.gameId });
    game.state.isGameOver = true;
    game.state.winnerTeam = "dawn";
    await game.eventDispatcher.publishFact("gameOver", { gameId: game.state.gameId, winnerTeam: "dawn" });
    const snapshot = pair.guest.gameChannel.snapshot();
    const result = snapshot.projection.presentation.result;
    assert.equal(snapshot.projection.presentation.kind, "result");
    assert.equal(result.players.length, 5);
    assert.ok(result.mvpPlayerId);
    assert.doesNotMatch(JSON.stringify(result), /achievementFacts|contributionFacts|aiMemory|handVersion|pendingResponses/);
    const guestUi = makeGuestUi();
    const view = new NetworkGameView({ ui: guestUi, submit: () => {} });
    view.update(snapshot);
    assert.match(guestUi.resultRoot.innerHTML, /MVP/);
    assert.match(guestUi.resultRoot.innerHTML, /全场表现排名/);
    assert.doesNotMatch(guestUi.resultRoot.innerHTML, /match-achievement-section|本局解锁成就|本局没有新的征途铭刻/);
    game.dispose();
  });

  test("Network：Host唯一创建并启动Match而Guest只初始化投影UI", async () => {
    let roomId, hostGame, startPromise, hostCreated = 0, guestCreated = 0, hostLoops = 0, guestLoops = 0;
    const receivers = {};
    const capabilities = (role) => ({
      createRoom: async (room) => { roomId = room.roomId; return room; },
      joinRoom: async () => ({ roomId }),
      subscribe: (receive) => { receivers[role] = receive; return () => {}; },
      send: (event) => receivers[role === R.HOST ? R.GUEST : R.HOST]?.(structuredClone(event)),
      close: () => {}
    });
    const hostUi = { ...makeUi(), showNetworkPage: () => {}, playSound: () => {} };
    const guestUi = makeGuestUi();
    const hostFlow = createNetworkFlow({
      ui: hostUi, capability: capabilities(R.HOST), onDisposeMatch: () => hostGame?.dispose(),
      onPrepareMatch: (setup, session) => {
        hostCreated += 1;
        hostGame = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: session });
        hostGame.runGameLoop = () => { hostLoops += 1; };
        hostGame.prepareNetworkMatch(setup);
      },
      onStartMatch: () => (startPromise = hostGame.startPreparedMatch())
    });
    const guestFlow = createNetworkFlow({
      ui: guestUi, capability: capabilities(R.GUEST), onDisposeMatch: () => {},
      onPrepareMatch: () => { guestCreated += 1; throw Error("Guest 创建了 Match"); },
      onStartMatch: () => { guestLoops += 1; throw Error("Guest 启动了 GameLoop"); }
    });
    hostFlow.handleClick({ target: { closest: () => ({ dataset: { networkAction: "create" } }) } });
    await Promise.resolve(); await Promise.resolve();
    const previousFormData = globalThis.FormData;
    try {
      globalThis.FormData = class { get(name) { return name === "host" ? "test-room" : NETWORK_DEFAULT_PORT; } };
      guestFlow.handleSubmit({ target: makeJoinForm(), preventDefault: () => {} });
    } finally { globalThis.FormData = previousFormData; }
    await Promise.resolve(); await Promise.resolve();
    receivers.GUEST({ type: E.PEER_CONNECTED, sender: NETWORK_CAPABILITY_SENDER, roomId });
    receivers.HOST({ type: E.PEER_CONNECTED, sender: NETWORK_CAPABILITY_SENDER, roomId });
    const pair = { host: hostFlow.session, guest: guestFlow.session };
    choosePair(pair);
    pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    assert.ok(startPromise, "Host 必须触发真实启动入口");
    await startPromise;
    assert.equal(pair.host.snapshot().state, S.IN_GAME);
    assert.equal(pair.guest.snapshot().state, S.IN_GAME);
    assert.equal(hostCreated, 1);
    assert.equal(hostLoops, 1);
    assert.equal(guestCreated, 0);
    assert.equal(guestLoops, 0);
    assert.equal(guestUi.game, null);
    assert.equal((guestUi.elements.cpu_grid.innerHTML.match(/class="player-seat/g) ?? []).length, 4);
    assert.match(guestUi.elements.human_panel.innerHTML, /human-seat/);
    assert.match(guestUi.elements.human_hand.innerHTML, /hand-card/);
    assert.ok(pair.guest.gameChannel.snapshot().projection.players.every((p) => p.handCount > 0));
    hostGame.dispose();
    pair.host.close(); pair.guest.close();
  });

  test("Network：Guest构造入口在RNG和Worker初始化前拒绝且不能绑定Authority", async () => {
    const pair = await connectedPair();
    let rngCalls = 0, workerCalls = 0;
    const previousWorker = globalThis.Worker;
    try {
      globalThis.Worker = class { constructor() { workerCalls += 1; throw Error("不应创建Worker"); } };
      assert.throws(() => createGameApplication(makeUi(), () => { rngCalls += 1; return 0.5; },
        { mode: MATCH_MODE.NETWORK, networkSession: pair.guest }), /只能在 Host/);
    } finally { globalThis.Worker = previousWorker; }
    assert.equal(rngCalls, 0);
    assert.equal(workerCalls, 0);
    assert.throws(() => pair.guest.gameChannel.bindHost({ getState: () => {}, prepareDecision: () => {} }), /仅 Host/);
    await assert.rejects(pair.guest.requestDecision({}), /仅 Host/);
    for (const file of ["js/ui/network/NetworkGameView.js", "js/network/NetworkGameChannel.js", "js/composition/createNetworkFlow.js"]) {
      const source = await readFile(new URL("../" + file, import.meta.url), "utf8");
      assert.doesNotMatch(source, /new Worker|new MatchState|createGameApplication\(|createSearchExecutor\(|Math\.random\(/);
    }
  });

  test("Network：Host投影仅含Guest手牌和公开信息且客户端修改不影响Host", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const ui = makeUi();
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const guest = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
    const host = game.state.players.find((player) => player.controlType === C.LOCAL_HUMAN);
    host.hand.push({ ...instance("assault"), id: "HOST_PRIVATE_CARD", secret: "SECRET_EXTENSION" });
    guest.hand.push({ ...instance("block"), id: "GUEST_OWN_CARD", secret: "OWN_PRIVATE_EXTENSION" });
    game.state.deck.cards.push({ ...instance("counter"), id: "SECRET_DECK_TOP" });
    game.state.hiddenSelection = { secret: "SECRET_SELECTION" };
    game.state.pendingResponses.push({ secret: "SECRET_RESPONSE" });
    game.state.logs.push({ message: "HOST_PRIVATE_KNOWLEDGE" });
    pair.host.gameChannel.publish({ kind: "unexpected", secret: "PRESENTATION_SECRET" });
    const copy = pair.guest.gameChannel.snapshot().projection;
    const json = JSON.stringify(copy);
    assert.match(json, /GUEST_OWN_CARD/);
    for (const value of ["HOST_PRIVATE_CARD", "SECRET_EXTENSION", "OWN_PRIVATE_EXTENSION", "SECRET_DECK_TOP", "SECRET_SELECTION", "SECRET_RESPONSE", "HOST_PRIVATE_KNOWLEDGE", "PRESENTATION_SECRET"]) assert.ok(!json.includes(value), value);
    assert.equal(copy.players.find((p) => p.playerId === host.id).hand, null);
    assert.equal(copy.players.find((p) => p.playerId === host.id).handCount, 1);
    copy.players[0].hp = 999;
    assert.notEqual(host.hp, 999);
    assert.notEqual(pair.guest.gameChannel.snapshot().projection.players[0].hp, 999);
    const guestUi = makeGuestUi();
    const view = new NetworkGameView({ ui: guestUi, submit: () => {} });
    view.update(pair.guest.gameChannel.snapshot());
    assert.match(guestUi.elements.cpu_grid.innerHTML, /手牌1张/);
    assert.doesNotMatch(guestUi.elements.cpu_grid.innerHTML, /HOST_PRIVATE_CARD|SECRET_DECK_TOP/);
    game.state.phase = "discard";
    game.ui.render(game);
    assert.equal(pair.guest.gameChannel.snapshot().projection.phase, "discard");
    game.ui.queueFeedback("damage", guest.id, 1);
    assert.equal(pair.guest.gameChannel.snapshot().projection.presentation.kind, "feedback");
    game.dispose();
  });

  test("Network：焚场丢失首次receipt后同requestId恢复且多目标Action只结算一次", async () => {
    const pair = await connectedPair();
    const setup = pair.host.snapshot();
    pair.host.select({ characterId: "ember-magus", ...setup.seats.find((seat) => seat.teamId === "dawn") });
    pair.guest.select({ characterId: "blade-walker", ...setup.seats.find((seat) => seat.teamId === "dusk") });
    pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const host = game.controlRouter.humanPlayer();
    const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    host.energy = 3;
    for (const player of game.state.players) player.resetTurnFlags(game.state);
    game.state.phase = "play"; game.state.currentPlayerIndex = host.seatIndex;
    guest.hand.push(instance("block"));
    pair.host.gameReady(); pair.guest.gameReady();
    const damage = [], facts = [];
    game.eventDispatcher.on("afterDamage", "network-fire-damage", (event) => damage.push(event.target.id));
    game.eventDispatcher.on("activeSkillUsed", "network-fire-commit", (event) => facts.push(event.resolutionId));
    const random = game.randomPort;
    let commits = 0;
    game.randomPort = { ...random, commitTransaction: (token) => { commits += 1; return random.commitTransaction(token); } };
    const receive = pair.host.gameChannel.receive.bind(pair.host.gameChannel);
    let dropped = false;
    pair.host.gameChannel.receive = (event) => {
      if (event.type === E.DECISION_RECEIVED && !dropped) { dropped = true; return false; }
      return receive(event);
    };
    const hp = new Map(game.state.players.map((player) => [player.id, player.hp]));
    const enemies = game.getEnemies(host);
    let settled = false;
    const workflow = game.useActiveSkill(host, "burningField", []).then((result) => { settled = true; return result; });
    void workflow.catch(() => {});
    try {
      await new Promise(setImmediate);
      assert.equal(dropped, true);
      assert.equal(settled, false);
      const request = pair.guest.gameChannel.snapshot().requests[0];
      assert.equal(request.kind, "response");
      assert.equal(request.response.type, "block");
      const before = pair.events.length;
      pair.guest.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      assert.ok(pair.events.slice(before).some((event) => event.type === E.DECISION_REQUEST && event.payload.requestId === request.requestId), "Host仍持有pending并重发原ID");
      assert.equal(pair.guest.gameChannel.snapshot().requests.length, 1);
      assert.equal(receive({ type: E.DECISION_RECEIVED, participantId: pair.guest.snapshot().participantId, payload: { requestId: request.requestId } }), true);
      pair.guest.gameChannel.respond(request.requestId, { status: "declined", selectedIds: [] });
      assert.equal(await workflow, true);
      assert.deepEqual(damage, enemies.map((player) => player.id));
      for (const player of game.state.players) assert.equal(player.hp, hp.get(player.id) - (enemies.includes(player) ? 1 : 0));
      assert.equal(commits, 1);
      assert.equal(facts.length, 1);
      assert.equal(game.actionLocked, false);
      assert.deepEqual(pair.guest.gameChannel.snapshot().requests, []);
      const tail = pair.events.length;
      pair.guest.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      assert.equal(pair.events.slice(tail).some((event) => event.type === E.DECISION_REQUEST), false);
      for (const type of [E.DECISION_RECEIVED, E.DECISION_RESPONSE, E.DECISION_ACCEPTED]) {
        assert.ok(pair.events.some((event) => event.type === type && event.payload.requestId === request.requestId));
      }
    } finally { game.dispose(); await workflow.catch(() => {}); pair.host.close(); pair.guest.close(); }
  });

  test("Network：转移真实隐藏选牌丢失Accepted后重试只补确认且资源统计日志不重复", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const owner = game.state.players.find((player) => player.controllerType === "ai"
      && player.battleTeam !== actor.battleTeam && ActionLegality.getDistance(game, actor, player) === 1);
    const moved = instance("charge"), transfer = instance("transfer");
    owner.hand.push(moved); actor.hand.push(transfer);
    const receiver = ActionLegality.getTransferReceivers(game, actor, owner, transfer).find((player) => player !== actor);
    assert.ok(receiver, "存在独立于出牌者的合法接收者");
    for (const player of game.state.players) player.resetTurnFlags(game.state);
    game.state.phase = "play"; game.state.currentPlayerIndex = actor.seatIndex;
    pair.host.gameReady(); pair.guest.gameReady();
    const moves = [], uses = [];
    game.eventDispatcher.on("afterCardMove", "network-transfer-move", (event) => moves.push(event.card.id));
    game.eventDispatcher.on("cardUsed", "network-transfer-use", (event) => uses.push(event.card.id));
    const random = game.randomPort;
    let commits = 0;
    game.randomPort = { ...random, commitTransaction: (token) => { commits += 1; return random.commitTransaction(token); } };
    const receive = pair.guest.gameChannel.receive.bind(pair.guest.gameChannel);
    let dropped = false;
    pair.guest.gameChannel.receive = (event) => {
      if (event.type === E.DECISION_ACCEPTED && !dropped) { dropped = true; return false; }
      return receive(event);
    };
    const ownerCount = owner.hand.length, receiverCount = receiver.hand.length;
    game.matchPerformanceSidecar.tracker.initializeRoster();
    assert.equal(ActionLegality.canPlayCard(game, actor, transfer).ok, true);
    assert.ok(ActionLegality.getTransferSources(game, actor, transfer).includes(owner), "来源合法");
    assert.ok(ActionLegality.getTransferReceivers(game, actor, owner, transfer).includes(receiver), "接收者合法");
    let opened;
    const opening = new Promise((resolve) => { opened = resolve; });
    const unsubscribe = pair.guest.gameChannel.subscribe(({ requests }) => {
      const request = requests.find((entry) => entry.kind === "hiddenCard");
      if (request) opened(request);
    });
    const workflow = game.playCard(actor, transfer, [], { sourceId: owner.id, receiverId: receiver.id });
    void workflow.catch(() => {});
    try {
      const request = await Promise.race([opening, workflow.then(() => null)]);
      assert.equal(request?.kind, "hiddenCard");
      assert.equal(game.actionLocked, true);
      assert.equal(request.options[0].card, null, "隐藏手牌不得暴露牌面");
      const result = { status: "selected", selectedIds: [request.options[0].optionId] };
      pair.guest.gameChannel.respond(request.requestId, result);
      assert.equal(await workflow, true);
      assert.equal(dropped, true);
      assert.equal(pair.guest.gameChannel.snapshot().requests.length, 1);
      assert.equal(owner.hand.length, ownerCount - 1);
      assert.equal(receiver.hand.length, receiverCount + 1);
      assert.deepEqual(moves.filter((id) => id === moved.id), [moved.id]);
      assert.deepEqual(uses, [transfer.id]);
      assert.equal(commits, 1);
      const stateBeforeRetry = JSON.stringify(game.state);
      const performanceBeforeRetry = game.matchPerformanceSidecar.tracker.captureActionCheckpoint();
      const movesBefore = [...moves];
      const tail = pair.events.length;
      pair.guest.gameChannel.respond(request.requestId, result);
      assert.deepEqual(pair.events.slice(tail).filter((event) => event.sender === R.HOST).map((event) => event.type), [E.DECISION_ACCEPTED]);
      assert.equal(JSON.stringify(game.state), stateBeforeRetry, "重试不写stateVersion、统计或日志事实");
      assert.deepEqual(game.matchPerformanceSidecar.tracker.captureActionCheckpoint(), performanceBeforeRetry);
      assert.deepEqual(moves, movesBefore);
      assert.equal(commits, 1);
      assert.deepEqual(uses, [transfer.id]);
      assert.equal(game.state.players.flatMap((player) => player.hand).filter((card) => card.id === moved.id).length, 1);
      assert.ok(receiver.hand.includes(moved));
      assert.equal(game.state.discardPile.filter((card) => card.id === transfer.id).length, 1);
      assert.deepEqual(pair.guest.gameChannel.snapshot().requests, []);
      const finalTail = pair.events.length;
      pair.guest.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      assert.equal(pair.events.slice(finalTail).some((event) => event.type === E.DECISION_REQUEST), false);
    } finally { unsubscribe(); game.dispose(); await workflow.catch(() => {}); pair.host.close(); pair.guest.close(); }
  });

  for (const cleanup of ["reset", "cancelParticipant"]) {
    test(`Network：accepted ledger在${cleanup}清理且跨身份游戏类型拒绝`, async () => {
      const pair = await connectedPair();
      choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
      const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
      game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
      const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
      pair.host.gameReady(); pair.guest.gameReady();
      try {
        const waiting = pair.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
          options: [{ optionId: actor.id }], constraints: { requiredCount: 1 }, context: {} });
        const request = pair.guest.gameChannel.snapshot().requests[0];
        pair.guest.gameChannel.respond(request.requestId, { status: "selected", selectedIds: [actor.id] });
        await waiting;
        const response = pair.events.findLast((event) => event.type === E.DECISION_RESPONSE);
        assert.equal(pair.host.gameChannel.receive(response), true, "保留已接受回答用于补发确认");
        assert.equal(pair.host.gameChannel.receive({ ...response, participantId: "forged" }), false);
        assert.equal(pair.host.gameChannel.receive({ ...response, payload: { ...response.payload, gameId: "old-game" } }), false);
        assert.equal(pair.host.gameChannel.receive({ ...response, type: E.PLAYER_INTENT }), false);
        pair.host.gameChannel[cleanup](pair.guest.snapshot().participantId);
        assert.equal(pair.host.gameChannel.receive(response), false, "生命周期结束后不得命中旧ledger");
      } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
    });
  }

  test("Network：Resync只恢复请求者私人投影和pending且重复请求不重复UI", async () => {
    const room = await connectedRoom(3);
    chooseRoom(room); room.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: room.host });
    game.prepareNetworkMatch(room.host.snapshot().matchSetup);
    room.host.gameReady(); room.guests.forEach((guest) => guest.gameReady());
    const [a, b] = room.guests;
    const players = room.guests.map((guest) => game.state.players.find((player) =>
      room.host.snapshot().matchSetup.players.find((seat) => seat.playerId === player.id)?.controller.participantId === guest.snapshot().participantId));
    players[1].hand.push({ ...instance("block"), id: "PRIVATE_B_CARD" });
    const waits = players.map((actor, index) => room.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
      options: [{ optionId: actor.id }], constraints: { requiredCount: 1 }, context: { label: `PRIVATE_${index}_DECISION` } }));
    const ui = makeGuestUi();
    let uiRequests = 0, finishTarget;
    ui.requestTarget = () => { uiRequests += 1; return new Promise((resolve) => { finishTarget = resolve; }); };
    const view = new NetworkGameView({ ui, submit: (...args) => a.gameChannel.respond(...args) });
    const unsubscribe = a.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      const request = a.gameChannel.snapshot().requests[0];
      const before = room.events.length;
      a.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      const replies = room.events.slice(before).filter((event) => event.sender === R.HOST);
      assert.deepEqual(replies.map((event) => event.type), [E.GAME_SNAPSHOT, E.DECISION_REQUEST]);
      assert.ok(replies.every((event) => event.recipientParticipantId === a.snapshot().participantId));
      assert.equal(replies[0].payload.viewerId, players[0].id);
      assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_B_CARD|PRIVATE_1_DECISION/);
      assert.equal(replies[1].payload.requestId, request.requestId);
      assert.equal(a.gameChannel.snapshot().requests.length, 1);
      assert.equal(uiRequests, 1, "Resync不重复开启同ID目标面板");
      assert.ok(room.events.slice(before).some((event) => event.type === E.DECISION_RECEIVED));
      assert.equal(room.host.gameChannel.receive({ type: E.DECISION_RECEIVED, participantId: b.snapshot().participantId, payload: { requestId: request.requestId } }), false);
      for (const [index, guest] of room.guests.entries()) guest.gameChannel.respond(guest.gameChannel.snapshot().requests[0].requestId,
        { status: "selected", selectedIds: [players[index].id] });
      await Promise.all(waits);
    } finally { unsubscribe(); view.dispose(); finishTarget?.(null); game.dispose(); await Promise.allSettled(waits); room.close(); }
  });

  test("Network：sequence拒绝不提交且恢复重试后duplicate与stale仍被拒绝", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    pair.host.gameChannel.publish();
    const event = structuredClone(pair.events.findLast((entry) => entry.type === E.GAME_SNAPSHOT));
    event.sequence += 100;
    const original = pair.guest.gameChannel.receive.bind(pair.guest.gameChannel);
    try {
      pair.guest.gameChannel.receive = () => false;
      assert.equal(pair.guest.receive(event), false);
      pair.guest.gameChannel.receive = original;
      assert.equal(pair.guest.receive(event), true, "相同N在gameplay成功前仍可交付，gap无需重排");
      assert.equal(pair.guest.receive(event), false);
      assert.equal(pair.guest.receive({ ...event, sequence: event.sequence - 1 }), false);
      assert.equal(pair.guest.receive({ ...event, sequence: event.sequence + 1, recipientParticipantId: "other" }), false);
      const lobby = structuredClone(pair.events.findLast((entry) => entry.type === E.MATCH_START));
      lobby.sequence = event.sequence + 1; lobby.revision += 20;
      assert.equal(pair.guest.receive(lobby), true, "房间完整快照允许revision gap");
      const hostBefore = pair.events.length;
      assert.equal(pair.host.receive({ type: E.RESYNC_REQUEST, sender: R.GUEST, roomId: pair.roomId, sequence: 10000,
        connectionId: "forged", participantId: pair.guest.snapshot().participantId, payload: { gameId: game.state.gameId } }), false);
      assert.equal(pair.host.receive({ type: E.RESYNC_REQUEST, sender: R.GUEST, roomId: pair.roomId, sequence: 10000,
        participantId: "forged", payload: { gameId: game.state.gameId } }), false);
      assert.equal(pair.events.length, hostBefore, "身份错误不进入恢复流程");
    } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：Decision状态错位触发恢复而非法重复内容和身份不触发恢复", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const waiting = pair.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
      options: [{ optionId: actor.id }], constraints: { requiredCount: 1 }, context: {} });
    try {
      const event = structuredClone(pair.events.findLast((entry) => entry.type === E.DECISION_REQUEST));
      const before = pair.events.length;
      assert.equal(pair.guest.gameChannel.receive({ ...event, payload: { ...event.payload, options: [] } }), false);
      assert.equal(pair.guest.gameChannel.receive({ ...event, payload: { ...event.payload, actorId: "forged" } }), false);
      assert.equal(pair.events.slice(before).some((entry) => entry.type === E.RESYNC_REQUEST), false);
      const snapshot = structuredClone(pair.events.findLast((entry) => entry.type === E.GAME_SNAPSHOT));
      snapshot.payload.stateVersion -= 1;
      assert.equal(pair.guest.gameChannel.receive(snapshot), false);
      assert.equal(pair.events.slice(before).some((entry) => entry.type === E.RESYNC_REQUEST), false, "旧完整快照安全忽略");
      const view = pair.guest.gameChannel.snapshot().projection;
      pair.guest.gameChannel.reset();
      assert.equal(pair.guest.gameChannel.receive(event), false, "尚无projection不得登记Decision");
      assert.ok(pair.events.slice(before).some((entry) => entry.type === E.RESYNC_REQUEST));
      assert.equal(pair.guest.gameChannel.snapshot().projection.gameId, view.gameId);
      assert.equal(pair.guest.gameChannel.snapshot().requests.length, 1);
      const recoveryStart = pair.events.length;
      assert.equal(pair.guest.gameChannel.receive({ ...event, payload: { ...event.payload,
        requestId: "future-decision", stateVersion: view.stateVersion + 1 } }), false);
      assert.ok(pair.events.slice(recoveryStart).some((entry) => entry.type === E.RESYNC_REQUEST), "合法shape的较新Decision请求恢复快照");
      assert.equal(pair.guest.gameChannel.snapshot().requests.length, 1);
      assert.equal(pair.guest.gameChannel.receive({ ...snapshot, payload: { ...view, stateVersion: "invalid" } }), false);
      pair.guest.gameChannel.respond(event.payload.requestId, { status: "selected", selectedIds: [actor.id] });
      await waiting;
    } finally { game.dispose(); await Promise.allSettled([waiting]); pair.host.close(); pair.guest.close(); }
  });

  test("Network：Resync遇到Host已失效的pending时取消并收束原workflow", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const waiting = pair.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
      options: [{ optionId: actor.id }], constraints: { requiredCount: 1 }, context: {} });
    try {
      const id = pair.guest.gameChannel.snapshot().requests[0].requestId;
      actor.resetTurnFlags(game.state);
      const before = pair.events.length;
      pair.guest.send(E.RESYNC_REQUEST, { gameId: game.state.gameId });
      assert.ok(pair.events.slice(before).some((event) => event.type === E.DECISION_CANCELLED && event.payload.requestId === id));
      assert.equal((await waiting).status, "cancelled");
      assert.deepEqual(pair.guest.gameChannel.snapshot().requests, []);
      assert.equal(pair.events.slice(before).some((event) => event.type === E.DECISION_REQUEST), false);
    } finally { game.dispose(); await Promise.allSettled([waiting]); pair.host.close(); pair.guest.close(); }
  });

  test("Network：同步恢复内层已提交sequence不会被外层旧sequence覆盖", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady(); pair.host.gameChannel.publish();
    const outer = structuredClone(pair.events.findLast((event) => event.type === E.GAME_SNAPSHOT));
    outer.sequence += 10;
    const inner = { ...outer, sequence: outer.sequence + 1 };
    const receive = pair.guest.gameChannel.receive.bind(pair.guest.gameChannel);
    pair.guest.gameChannel.receive = (event) => {
      if (event.sequence === outer.sequence) assert.equal(pair.guest.receive(inner), true);
      return receive(event);
    };
    try {
      assert.equal(pair.guest.receive(outer), true);
      assert.equal(pair.guest.receive(inner), false, "已在同步callback中提交的消息不能重放");
    } finally { game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：Guest输入经请求关联往返返回Host且不发送任意selection", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
    const card = instance("block"); actor.hand.push(card);
    pair.host.gameReady(); pair.guest.gameReady();
    const pending = game.choicePort.request({
      kind: "response", requestId: "domain-response", actorId: actor.id, gameId: game.state.gameId,
      options: [{ optionId: card.id }], constraints: { requiredCount: 1 }, canDecline: true,
      context: { label: "请响应", secret: "DO_NOT_SEND" }
    });
    const safe = pair.guest.gameChannel.snapshot();
    assert.equal(safe.requests.length, 1);
    assert.ok(!JSON.stringify(safe).includes("DO_NOT_SEND"));
    const guestUi = makeGuestUi();
    guestUi.requestResponse = async (request) => {
      assert.deepEqual(request.legalCardIds, [card.id]);
      return { status: "used", selectedIds: [card.id] };
    };
    const view = new NetworkGameView({ ui: guestUi,
      submit: (requestId, result) => pair.guest.gameChannel.respond(requestId, result)
    });
    view.update(safe);
    assert.deepEqual(await pending, { status: "selected", selectedIds: [card.id] });
    assert.ok(pair.events.some((e) => e.type === E.DECISION_REQUEST));
    assert.ok(pair.events.some((e) => e.type === E.DECISION_RESPONSE));
    const last = pair.events.findLast((e) => e.type === E.DECISION_RESPONSE);
    assert.equal(pair.host.receive(last), false);
    assert.equal(pair.guest.gameChannel.snapshot().requests.length, 0);
    assert.equal(actor.hand[0], card);
    game.dispose();
  });

  test("Network：回答拒绝越权过期和非法选项且断线收束等待", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
    pair.host.gameReady(); pair.guest.gameReady();
    const pending = pair.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
      options: [{ optionId: game.state.players[0].id }], constraints: { requiredCount: 1 }, context: {} });
    const request = pair.guest.gameChannel.snapshot().requests[0];
    const response = { requestId: request.requestId, actorId: request.actorId, gameId: request.gameId,
      stateVersion: request.stateVersion, status: "selected", selectedIds: [request.options[0].optionId] };
    let sequence = 100;
    const deliver = (payload) => pair.host.receive({ type: E.DECISION_RESPONSE, sender: R.GUEST, roomId: pair.roomId, sequence: sequence++, payload });
    assert.equal(deliver({ ...response, actorId: "forged-actor" }), false);
    assert.equal(deliver({ ...response, gameId: "old-game" }), false);
    assert.equal(deliver({ ...response, selectedIds: ["forged-option"] }), false);
    assert.equal(deliver({ ...response, status: "declined", selectedIds: [] }), false);
    game.state.stateVersion += 1;
    assert.equal(deliver(response), false);
    assert.equal((await pending).status, "cancelled");
    const waiting = pair.host.requestDecision({ kind: "target", actorId: actor.id, gameId: game.state.gameId,
      options: [{ optionId: actor.id }], constraints: { requiredCount: 1 }, context: {} });
    const rejected = assert.rejects(waiting, /已关闭/);
    pair.host.disconnect();
    await rejected;
    game.dispose();
  });

  test("Network：远端出牌意图和公开组合由Host映射而Guest不能上传动作对象", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const actor = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
    game.state.currentPlayerIndex = actor.seatIndex; game.state.phase = "play";
    pair.host.gameReady(); pair.guest.gameReady();
    const pending = pair.host.requestDecision({ kind: "player-intent", actorId: actor.id, gameId: game.state.gameId });
    const request = pair.guest.gameChannel.snapshot().requests[0];
    const end = request.options.find((option) => option.label === "结束出牌");
    pair.guest.gameChannel.respond(request.requestId, { status: "selected", selectedIds: [end.optionId], kind: "card", cardId: "forged" });
    assert.deepEqual(await pending, { kind: "end" });
    const event = pair.events.findLast((e) => e.type === E.PLAYER_INTENT);
    assert.equal(event.payload.cardId, undefined);
    assert.equal(event.payload.kind, undefined);
    game.dispose();
  });


  // 多人房间、controller ownership 与 Transport 游戏侧 contract。
  for (const humanCount of [1, 2, 3, 4, 5]) {
    test(`Network：多人房间${humanCount}真人经Host主动开始和原两道屏障生成五席`, async () => {
      const room = await connectedRoom(humanCount);
      try {
        assert.equal(room.host.snapshot().currentHumanCount, humanCount);
        assert.equal(room.host.start().code, "NOT_READY");
        chooseRoom(room);
        assert.equal(room.host.snapshot().canStart, true);
        assert.equal(room.host.snapshot().locked, false);
        assert.equal(room.host.snapshot().matchSetup, null, "全部确认也不能自动开始");
        assert.equal(room.host.start().ok, true);
        assert.equal(room.host.snapshot().state, S.LOADING_GAME);
        const setup = room.host.snapshot().matchSetup;
        assert.equal(setup.players.length, 5);
        assert.equal(setup.players.filter((seat) => seat.controller.type === "AI").length, 5 - humanCount);
        assert.equal(setup.players.filter((seat) => seat.controller.type === "GUEST").length, humanCount - 1);
        assert.equal(Object.keys(room.host.snapshot().participants).length, humanCount);
        assert.ok(Object.values(room.host.snapshot().participants).every((p) => ["HOST", "GUEST"].includes(p.role)));
        assert.equal(room.host.addParticipant({ connectionId: "late" }).code, "ROOM_LOCKED");
        assert.equal(room.host.start().code, "ROOM_LOCKED");
        room.host.gameReady();
        for (const guest of room.guests) {
          assert.equal(room.host.snapshot().state, S.LOADING_GAME);
          guest.gameReady();
        }
        assert.equal(room.host.snapshot().state, S.IN_GAME);
        for (const guest of room.guests) {
          assert.equal(guest.snapshot().state, S.IN_GAME);
          const local = guest.snapshot().matchSetup.players.filter((seat) => seat.controlType === C.LOCAL_HUMAN);
          assert.equal(local.length, 1);
          assert.equal(local[0].controller.participantId, guest.snapshot().participantId);
        }
      } finally { room.close(); }
    });
  }

  test("Network：多人容量满员和降低上限均返回稳定结果且不踢人", async () => {
    const room = await connectedRoom(3);
    try {
      assert.equal(room.host.setMaxHumanCount(3).ok, true);
      assert.deepEqual(room.host.addParticipant({ connectionId: "overflow" }), { ok: false, code: "ROOM_FULL" });
      assert.deepEqual(room.host.setMaxHumanCount(2), { ok: false, code: "CAPACITY_BELOW_COUNT" });
      assert.equal(room.host.snapshot().currentHumanCount, 3);
      assert.equal(room.host.snapshot().maxHumanCount, 3);
      for (const guest of room.guests) {
        assert.equal(guest.snapshot().maxHumanCount, 3);
        assert.throws(() => guest.setMaxHumanCount(5), { code: "HOST_ONLY" });
        assert.throws(() => guest.addParticipant({ connectionId: "fake" }), { code: "HOST_ONLY" });
        assert.throws(() => guest.start(), { code: "HOST_ONLY" });
      }
    } finally { room.close(); }
  });

  test("Network：多人selection按认证连接归属且角色席位唯一", async () => {
    const room = await connectedRoom(3);
    try {
      const [first, second] = room.guests;
      const setup = room.host.snapshot();
      const firstId = first.snapshot().participantId, secondId = second.snapshot().participantId;
      first.select({ characterId: setup.candidates[1], ...setup.seats[1] });
      assert.throws(() => second.select({ characterId: setup.candidates[1], ...setup.seats[2] }));
      assert.throws(() => second.select({ characterId: setup.candidates[2], ...setup.seats[1] }));
      first.select({ characterId: setup.candidates[3], ...setup.seats[3] });
      second.select({ characterId: setup.candidates[1], ...setup.seats[1] });
      const forged = { type: E.SELECTION_CHANGED, sender: R.GUEST, roomId: room.roomId, sequence: 100,
        connectionId: "connection-1", participantId: secondId,
        payload: { characterId: setup.candidates[2], ...setup.seats[2] } };
      assert.equal(room.host.receive(forged), false);
      assert.equal(room.host.snapshot().participants[secondId].selection.seatId, "seat-1");
      assert.equal(room.host.receive({ ...forged, participantId: firstId,
        payload: { ...forged.payload, participantId: secondId, remoteAddress: "forged-ip" } }), true);
      const members = room.host.snapshot().participants;
      assert.equal(members[firstId].selection.seatId, "seat-2");
      assert.equal(members[secondId].selection.seatId, "seat-1");
      assert.equal(members[firstId].remoteAddress, "::ffff:10.0.0.2");
      assert.deepEqual(Object.keys(members[firstId].selection).sort(), ["characterId", "seatId", "teamId"]);
    } finally { room.close(); }
  });

  test("Network：Lobby成员展示displayName且Host连接地址保留IP并优先Transport地址", async () => {
    async function openHost(result = {}) {
      const session = new NetworkSession({ displayName: "主机旅者", capability: {
        createRoom: async (room) => ({ ...room, ...result }),
        subscribe: () => () => {},
        close: () => {}
      } });
      await session.open(R.HOST);
      return session;
    }
    const sessions = [];
    try {
      const preferred = await openHost({ remoteAddress: "10.0.0.9",
        connectionInfo: { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT } });
      sessions.push(preferred);
      const preferredSnapshot = preferred.snapshot();
      assert.equal(preferredSnapshot.participants[preferredSnapshot.participantId].remoteAddress, "10.0.0.9");
      const preferredMarkup = renderNetworkSquadSelectionView(preferredSnapshot);
      assert.match(preferredMarkup, /<strong>主机旅者<\/strong>/);
      assert.match(preferredMarkup, /10\.196\.91\.170:38520/);
      assert.doesNotMatch(preferredMarkup, /10\.0\.0\.9/);

      const fallback = await openHost({ connectionInfo: { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT } });
      sessions.push(fallback);
      const fallbackSnapshot = fallback.snapshot();
      assert.equal(fallbackSnapshot.participants[fallbackSnapshot.participantId].remoteAddress, "10.196.91.170");
      const fallbackMarkup = renderNetworkSquadSelectionView(fallbackSnapshot);
      assert.match(fallbackMarkup, /<strong>主机旅者<\/strong>/);
      assert.match(fallbackMarkup, /10\.196\.91\.170:38520/);

      const mapped = await openHost({ connectionInfo: { host: "::ffff:10.196.91.170", port: NETWORK_DEFAULT_PORT } });
      sessions.push(mapped);
      const mappedMarkup = renderNetworkSquadSelectionView(mapped.snapshot());
      assert.match(mappedMarkup, /<strong>主机旅者<\/strong>/);
      assert.match(mappedMarkup, /10\.196\.91\.170:38520/);
      assert.doesNotMatch(mappedMarkup, /::ffff:/);

      const missing = await openHost();
      sessions.push(missing);
      const missingSnapshot = missing.snapshot();
      assert.equal(missingSnapshot.participants[missingSnapshot.participantId].remoteAddress, null);
      const missingMarkup = renderNetworkSquadSelectionView(missingSnapshot);
      assert.match(missingMarkup, /<strong>主机旅者<\/strong>/);
      assert.doesNotMatch(missingMarkup, /地址未提供/);
      assert.match(missingMarkup, /连接地址将在网络服务启动后显示/);
    } finally {
      for (const session of sessions) session.close();
    }
  });

  test("Network：Host connectionInfo 多地址进入snapshot且UI逐项展示", async () => {
    async function openHost(connectionInfo) {
      const session = new NetworkSession({ capability: {
        createRoom: async (room) => ({ ...room, connectionInfo }),
        subscribe: () => () => {},
        close: () => {}
      } });
      await session.open(R.HOST);
      return session;
    }
    const sessions = [];
    try {
      const multi = await openHost({
        host: "100.86.236.89", port: NETWORK_DEFAULT_PORT,
        addresses: [
          { host: "100.86.236.89", port: NETWORK_DEFAULT_PORT, interfaceName: "Tailscale", kind: "tailscale" },
          { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT, interfaceName: "Wi-Fi", kind: "lan" },
          { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT, interfaceName: "Wi-Fi duplicate", kind: "lan" },
          { host: "192.168.1.99", port: NETWORK_DEFAULT_PORT, interfaceName: "VPN", kind: "vpn" },
          { host: "10.19.6.1", port: 0, interfaceName: "bad-port", kind: "lan" }
        ]
      });
      sessions.push(multi);
      const multiSnapshot = multi.snapshot();
      assert.deepEqual(multiSnapshot.connectionInfo, {
        host: "100.86.236.89", port: NETWORK_DEFAULT_PORT,
        addresses: [
          { host: "100.86.236.89", port: NETWORK_DEFAULT_PORT, kind: "tailscale" },
          { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT, kind: "lan" }
        ]
      });
      const multiMarkup = renderNetworkSquadSelectionView(multiSnapshot);
      assert.match(multiMarkup, /局域网/);
      assert.match(multiMarkup, /Tailscale/);
      assert.match(multiMarkup, /100\.86\.236\.89:38520/);
      assert.match(multiMarkup, /10\.196\.91\.170:38520/);
      assert.equal((multiMarkup.match(/data-network-action="copy-address"/g) ?? []).length, 2);
      assert.match(multiMarkup, /data-network-host="100\.86\.236\.89" data-network-port="38520"/);
      assert.match(multiMarkup, /data-network-host="10\.196\.91\.170" data-network-port="38520"/);
      assert.doesNotMatch(multiMarkup, /interfaceName|Wi-Fi|VPN|192\.168\.1\.99/);

      const legacy = await openHost({ host: "10.1.2.3", port: NETWORK_DEFAULT_PORT });
      sessions.push(legacy);
      const legacySnapshot = legacy.snapshot();
      assert.deepEqual(legacySnapshot.connectionInfo, {
        host: "10.1.2.3", port: NETWORK_DEFAULT_PORT,
        addresses: [{ host: "10.1.2.3", port: NETWORK_DEFAULT_PORT, kind: "lan" }]
      });
      const legacyMarkup = renderNetworkSquadSelectionView(legacySnapshot);
      assert.match(legacyMarkup, /局域网/);
      assert.match(legacyMarkup, /10\.1\.2\.3:38520/);
      assert.equal((legacyMarkup.match(/data-network-action="copy-address"/g) ?? []).length, 1);

      const reservedSnapshot = structuredClone(multiSnapshot);
      reservedSnapshot.connectionInfo = {
        host: "0.0.0.0", port: NETWORK_DEFAULT_PORT,
        addresses: [
          { host: "0.0.0.0", port: NETWORK_DEFAULT_PORT, kind: "lan" },
          { host: "127.0.0.1", port: NETWORK_DEFAULT_PORT, kind: "tailscale" }
        ]
      };
      const reservedMarkup = renderNetworkSquadSelectionView(reservedSnapshot);
      assert.doesNotMatch(reservedMarkup, /0\.0\.0\.0|127\.0\.0\.1/);
      assert.match(reservedMarkup, /连接地址将在网络服务启动后显示/);

      const missing = await openHost(null);
      sessions.push(missing);
      assert.equal(missing.snapshot().connectionInfo, null);
      const missingMarkup = renderNetworkSquadSelectionView(missing.snapshot());
      assert.match(missingMarkup, /连接地址将在网络服务启动后显示/);
      assert.doesNotMatch(missingMarkup, /0\.0\.0\.0|127\.0\.0\.1|localhost/);

      let joinedEndpoint = null;
      const guest = new NetworkSession({ capability: {
        joinRoom: async (endpoint) => { joinedEndpoint = endpoint; return { roomId: "guest-room" }; },
        subscribe: () => () => {},
        close: () => {}
      } });
      sessions.push(guest);
      await guest.open(R.GUEST, normalizeNetworkEndpoint({ host: " 10.1.2.3 ", port: NETWORK_DEFAULT_PORT }));
      assert.deepEqual(joinedEndpoint, { host: "10.1.2.3", port: NETWORK_DEFAULT_PORT });
      assert.deepEqual(guest.snapshot().connectionInfo, { host: "10.1.2.3", port: NETWORK_DEFAULT_PORT });
    } finally {
      for (const session of sessions) session.close();
    }
  });

  test("Network：Host多地址复制按钮各自复制dataset地址且非法dataset安全返回", async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const copied = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text) => { copied.push(text); } } }
    });
    const flow = createNetworkFlow({
      ui: { playSound() {} },
      capability: {
        createRoom: async (room) => ({ ...room, connectionInfo: {
          host: "100.86.236.89", port: NETWORK_DEFAULT_PORT,
          addresses: [
            { host: "100.86.236.89", port: NETWORK_DEFAULT_PORT, kind: "tailscale" },
            { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT, kind: "lan" }
          ]
        } }),
        subscribe: () => () => {},
        close() {}
      },
      onDisposeMatch() {}
    });
    try {
      await flow.session.open(R.HOST);
      const addresses = flow.session.snapshot().connectionInfo.addresses;
      const statuses = addresses.map(() => ({ textContent: "" }));
      const buttons = addresses.map((address, index) => ({
        disabled: false, isConnected: true,
        dataset: { networkAction: "copy-address", networkHost: address.host, networkPort: String(address.port) },
        parentElement: { querySelector: (selector) => selector === "[data-network-copy-status]" ? statuses[index] : null }
      }));
      for (const button of buttons) flow.handleClick({ target: { closest: () => button } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(copied, ["100.86.236.89:38520", "10.196.91.170:38520"]);
      assert.equal(statuses[0].textContent, "连接地址已复制");
      assert.equal(statuses[1].textContent, "连接地址已复制");

      copied.length = 0;
      statuses.forEach((status) => { status.textContent = ""; });
      flow.handleClick({ target: { closest: () => ({
        disabled: false, isConnected: true,
        dataset: { networkAction: "copy-address", networkHost: "10.1.2.3" },
        parentElement: { querySelector: () => statuses[0] }
      }) } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(copied, []);
      assert.equal(statuses[0].textContent, "");
    } finally {
      flow.session.close();
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  test("Network：Lobby身份显示displayName而LAN与Tailscale连接地址仍保留IP", async () => {
    let roomId;
    const receivers = {};
    const capability = (role) => ({
      createRoom: async (room) => {
        roomId = room.roomId;
        return { ...room, connectionInfo: {
          host: "100.86.236.89", port: NETWORK_DEFAULT_PORT,
          addresses: [
            { host: "100.86.236.89", port: NETWORK_DEFAULT_PORT, kind: "tailscale" },
            { host: "10.196.91.170", port: NETWORK_DEFAULT_PORT, kind: "lan" }
          ]
        } };
      },
      joinRoom: async () => ({ roomId }),
      subscribe: (receive) => { receivers[role] = receive; return () => { delete receivers[role]; }; },
      send: (event) => { receivers[event.sender === R.HOST ? R.GUEST : R.HOST]?.(structuredClone(event)); },
      close: () => {}
    });
    const host = new NetworkSession({ capability: capability(R.HOST), random: () => 0.25, displayName: "主控者" });
    const guest = new NetworkSession({ capability: capability(R.GUEST), random: () => { throw new Error("Guest 不得 shuffle"); }, displayName: "旅人甲" });
    try {
      await host.open(R.HOST);
      await guest.open(R.GUEST, { host: "100.86.236.89", port: NETWORK_DEFAULT_PORT });
      host.setMaxHumanCount(3);
      assert.equal(host.addParticipant({ connectionId: "guest-1", remoteAddress: "10.0.0.55", displayName: "旅人甲" }).ok, true);
      assert.equal(host.addParticipant({ connectionId: "guest-2", remoteAddress: null }).ok, true);

      const hostSnapshot = host.snapshot();
      const guestSnapshot = guest.snapshot();
      const hostId = hostSnapshot.participantId;
      const guestOneId = Object.values(hostSnapshot.participants).find((participant) => participant.connectionId === "guest-1").participantId;
      assert.equal(hostSnapshot.participants[hostId].displayName, "主控者");
      assert.equal(hostSnapshot.participants[guestOneId].displayName, "旅人甲");
      assert.equal(guestSnapshot.participants[hostId].displayName, "主控者");
      assert.equal(guestSnapshot.participants[guestOneId].displayName, "旅人甲");

      const hostMarkup = renderNetworkSquadSelectionView(hostSnapshot);
      assert.match(hostMarkup, /<strong>主控者<\/strong>/);
      assert.match(hostMarkup, /<strong>旅人甲<\/strong>/);
      assert.equal((hostMarkup.match(/data-network-action="copy-address"/g) ?? []).length, 2);
      assert.match(hostMarkup, /100\.86\.236\.89:38520/);
      assert.match(hostMarkup, /10\.196\.91\.170:38520/);
      assert.doesNotMatch(hostMarkup, /<strong>(?:Host|Guest 1)<\/strong>/);
      assert.doesNotMatch(hostMarkup, /10\.0\.0\.55/);

      const guestMarkup = renderNetworkSquadSelectionView(guestSnapshot);
      assert.match(guestMarkup, /<strong>主控者<\/strong>/);
      assert.match(guestMarkup, /<strong>旅人甲<\/strong>/);
      assert.match(guestMarkup, /<strong>Guest 2<\/strong>/);
      assert.doesNotMatch(guestMarkup, /10\.0\.0\.55/);
      assert.doesNotMatch(guestMarkup, /data-network-action="copy-address"/);
    } finally {
      host.close();
      guest.close();
    }
  });

  test("Network：Lobby踢人释放选择且Guest编号不因中间成员退出重排", async () => {
    const room = await connectedRoom(4);
    try {
      const [, middle, last] = room.guests;
      const hostId = room.host.snapshot().participantId, middleId = middle.snapshot().participantId, lastId = last.snapshot().participantId;
      const setup = middle.snapshot();
      middle.select({ characterId: setup.candidates[2], ...setup.seats[2] });
      assert.equal(room.host.kickParticipant(hostId).code, "CANNOT_REMOVE_HOST");
      assert.throws(() => last.kickParticipant(middleId), { code: "HOST_ONLY" });
      assert.equal(room.host.kickParticipant(middleId).ok, true);
      assert.equal(middle.snapshot().state, S.DISCONNECTED);
      assert.equal(room.host.snapshot().participants[middleId], undefined);
      assert.equal(room.host.snapshot().participants[lastId].guestOrdinal, 3);
      last.select({ characterId: setup.candidates[2], ...setup.seats[2] });
      const added = room.host.addParticipant({ connectionId: "new-connection" });
      assert.equal(added.ok, true);
      assert.equal(room.host.snapshot().participants[lastId].guestOrdinal, 3);
      assert.equal(room.host.snapshot().participants[added.participantId].guestOrdinal, 2);
      assert.notEqual(added.participantId, middleId);
      assert.equal(room.host.snapshot().currentHumanCount, 4);
    } finally { room.close(); }
  });

  test("Network：多人决定逐Guest隔离并拒绝其他Guest和Host席位伪装", async () => {
    const room = await connectedRoom(3);
    let game;
    try {
      chooseRoom(room); room.host.start();
      game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: room.host });
      game.prepareNetworkMatch(room.host.snapshot().matchSetup);
      room.host.gameReady(); for (const guest of room.guests) guest.gameReady();
      const [first, second] = room.guests;
      const actors = room.host.snapshot().matchSetup.players.filter((seat) => seat.controller.type === "GUEST")
        .map((seat) => game.state.players.find((p) => p.id === seat.playerId));
      const ownCards = actors.map((actor) => { const card = instance("block"); actor.hand.push(card); return card; });
      const pending = actors.map((actor, index) => room.host.requestDecision({
        kind: "response", actorId: actor.id, gameId: game.state.gameId,
        options: [{ optionId: ownCards[index].id }], constraints: { requiredCount: 1 }, context: {}, canDecline: true
      }));
      for (const [index, guest] of room.guests.entries()) {
        const snapshot = guest.gameChannel.snapshot();
        assert.equal(snapshot.requests.length, 1);
        assert.equal(snapshot.requests[0].actorId, actors[index].id);
        assert.equal(snapshot.projection.viewerId, actors[index].id);
        assert.ok(!JSON.stringify(snapshot).includes(ownCards[1 - index].id), "另一位Guest的未知牌ID不应泄露");
      }
      const request = second.gameChannel.snapshot().requests[0];
      const payload = { requestId: request.requestId, actorId: request.actorId, gameId: request.gameId,
        stateVersion: request.stateVersion, status: "selected", selectedIds: [request.options[0].optionId] };
      assert.equal(room.host.receive({ type: E.DECISION_RESPONSE, sender: R.GUEST,
        participantId: first.snapshot().participantId, connectionId: "connection-1", roomId: room.roomId, sequence: 100, payload }), false);
      await assert.rejects(room.host.requestDecision({ kind: "target", actorId: game.controlRouter.humanPlayer().id, gameId: game.state.gameId }));
      second.gameChannel.respond(request.requestId, { status: "selected", selectedIds: payload.selectedIds });
      const ownRequest = first.gameChannel.snapshot().requests[0];
      // 恶意消息消耗该认证连接的序号后，用递增序号提交它自己的合法回答。
      assert.equal(room.host.receive({ type: E.DECISION_RESPONSE, sender: R.GUEST,
        participantId: first.snapshot().participantId, connectionId: "connection-1", roomId: room.roomId, sequence: 101,
        payload: { requestId: ownRequest.requestId, actorId: ownRequest.actorId, gameId: ownRequest.gameId,
          stateVersion: ownRequest.stateVersion, status: "selected", selectedIds: [ownRequest.options[0].optionId] } }), true);
      assert.deepEqual(await Promise.all(pending), ownCards.map((card) => ({ status: "selected", selectedIds: [card.id] })));
    } finally { game?.dispose(); room.close(); }
  });

  for (const operation of ["markParticipantDisconnected", "kickParticipant"]) {
    test(`Network：多人对局${operation}只转controller且保留角色全部状态并转交AI弃牌`, async () => {
      const room = await connectedRoom(3);
      let game;
      try {
        chooseRoom(room); room.host.start();
        game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: room.host });
        game.prepareNetworkMatch(room.host.snapshot().matchSetup);
        room.host.gameReady(); for (const guest of room.guests) guest.gameReady();
        const participantId = room.guests[0].snapshot().participantId;
        const seat = room.host.snapshot().matchSetup.players.find((p) => p.controller.participantId === participantId);
        const actor = game.state.players.find((p) => p.id === seat.playerId);
        actor.hand.push(instance("block"), instance("assault"));
        actor.equipment = instance("telescope");
        actor.hp = 2; actor.shield = 1; actor.energy = 2;
        actor.statuses.exposeWeakness = { stacks: 2 };
        actor.turnFlags.momentum = 1;
        const before = structuredClone(actor), hand = actor.hand, equipment = actor.equipment, version = game.state.stateVersion;
        game.choiceContexts.set("takeover-discard", { player: actor, count: 1, prompt: "弃一张" });
        let aiCalls = 0;
        game.aiController.chooseDiscards = (player, count) => { aiCalls += 1; assert.equal(player, actor); assert.equal(count, 1); return [actor.hand[0]]; };
        const pending = game.choicePort.request({ kind: "discard", requestId: "takeover-discard",
          actorId: actor.id, gameId: game.state.gameId, options: actor.hand.map((card) => ({ optionId: card.id })),
          constraints: { requiredCount: 1 }, context: {} });
        assert.equal(room.host[operation](participantId).ok, true);
        assert.equal(game.state.players.find((p) => p.id === actor.id), actor);
        assert.equal(actor.hand, hand); assert.equal(actor.equipment, equipment);
        assert.equal(game.state.stateVersion, version);
        for (const key of Object.keys(before).filter((key) => !["controllerType", "controlType", "networkRole"].includes(key))) {
          assert.deepEqual(actor[key], before[key], key);
        }
        assert.equal(actor.controlType, C.AI); assert.equal(actor.controllerType, "ai"); assert.equal(actor.networkRole, "AI");
        assert.equal(room.host.snapshot().participants[participantId].connected, false);
        assert.deepEqual(room.host.snapshot().matchSetup.players[actor.seatIndex].controller, { type: "AI", participantId: null, displayName: null });
        assert.equal(room.host.snapshot().state, S.IN_GAME);
        assert.equal(room.guests[1].snapshot().state, S.IN_GAME);
        assert.equal(room.guests[1].gameChannel.snapshot().projection.players.find((p) => p.playerId === actor.id).networkRole, "AI");
        assert.deepEqual(await pending, { status: "selected", selectedIds: [hand[0].id], reason: null });
        assert.equal(aiCalls, 1);
      } finally { game?.dispose(); room.close(); }
    });
  }


  test("Network：Action回滚恢复领域状态但不撤销断线接管", async () => {
    const room = await connectedRoom(2);
    let game;
    try {
      chooseRoom(room); room.host.start();
      game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: room.host });
      game.prepareNetworkMatch(room.host.snapshot().matchSetup);
      room.host.gameReady(); room.guests[0].gameReady();
      const actor = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
      const card = instance("telescope");
      actor.hand.push(card);
      game.state.phase = "play";
      game.state.currentPlayerIndex = actor.seatIndex;
      const hp = actor.hp;
      const failure = new Error("取消进行中的Action");
      game.eventDispatcher.on("beforeCardUse", "test:disconnect-during-action", () => {
        actor.hp -= 1;
        room.host.markParticipantDisconnected(room.guests[0].snapshot().participantId);
        throw failure;
      });
      await assert.rejects(game.playCard(actor, card), (error) => error === failure);
      assert.equal(actor.hp, hp);
      assert.equal(actor.hand[0], card);
      assert.equal(game.state.players[actor.seatIndex], actor);
      assert.equal(actor.controllerType, "ai");
      assert.equal(actor.controlType, C.AI);
      assert.equal(actor.networkRole, "AI");
    } finally { game?.dispose(); room.close(); }
  });


  test("Network：加载屏障期间断线仍保留席位且迟到首份锁房快照可被Guest接收", async () => {
    const room = await connectedRoom(3);
    let lateGuest;
    try {
      chooseRoom(room); room.host.start();
      const removedId = room.guests[0].snapshot().participantId;
      const remainingId = room.guests[1].snapshot().participantId;
      room.host.markParticipantDisconnected(removedId);
      assert.equal(room.host.snapshot().state, S.LOADING_GAME);
      lateGuest = new NetworkSession({ capability: { joinRoom: async () => ({ roomId: room.roomId }) } });
      await lateGuest.open(R.GUEST, { host: "test-room", port: NETWORK_DEFAULT_PORT });
      const snapshotEvent = room.events.findLast((event) => event.recipientParticipantId === remainingId
        && event.type === E.SELECTION_CHANGED);
      assert.ok(snapshotEvent);
      assert.equal(lateGuest.receive(snapshotEvent), true);
      assert.equal(lateGuest.snapshot().state, S.LOADING_GAME);
      assert.equal(lateGuest.snapshot().matchSetup.players.filter((seat) => seat.controller.type === "AI").length, 3);
      room.host.gameReady(); room.guests[1].gameReady();
      assert.equal(room.host.snapshot().state, S.IN_GAME);
    } finally { lateGuest?.close(); room.close(); }
  });

  test("Network：移除成员的迟到断线通知不会终止Host或其他Guest", async () => {
    const room = await connectedRoom(3);
    try {
      const removed = room.guests[0].snapshot().participantId;
      room.host.kickParticipant(removed);
      assert.equal(room.host.receive({ roomId: room.roomId, sender: NETWORK_CAPABILITY_SENDER,
        type: E.DISCONNECTED, connectionId: "connection-1" }), false);
      assert.equal(room.host.snapshot().state, S.SELECTING);
      assert.equal(room.host.snapshot().currentHumanCount, 2);
      assert.equal(room.guests[1].snapshot().state, S.SELECTING);
      assert.equal(room.guests[1].receive({ roomId: room.roomId, sender: NETWORK_CAPABILITY_SENDER,
        type: E.DISCONNECTED, connectionId: "host" }), true);
      assert.equal(room.guests[1].snapshot().state, S.DISCONNECTED);
    } finally { room.close(); }
  });

  test("Network：接管后新选择走AI且私密揭示与卡牌附加选择不打开Host输入", async () => {
    const actor = { id: "remote", controlType: C.AI };
    const router = new PlayerControlRouter({ getState: () => ({ gameId: "game", players: [actor] }) });
    const local = () => { throw Error("AI接管后不可打开Host私密输入"); };
    const ai = { request: (request) => ({ status: "selected", selectedIds: [request.kind] }) };
    for (const kind of ["target", "response", "discard", "hiddenCard", "publicCard"]) {
      assert.deepEqual(await router.request({ kind, actorId: actor.id }, { request: local }, ai),
        { status: "selected", selectedIds: [kind] });
    }
    assert.equal(await router.requestCardFlow(actor, {}, [], local), null);
    await router.presentPrivateReveal({ viewerId: actor.id, cardIds: [] }, local);
  });

  test("Network：断线中断当前远端出牌等待后接续同一个AI阶段", async () => {
    const room = await connectedRoom(2);
    let game;
    try {
      chooseRoom(room); room.host.start();
      game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: room.host });
      game.prepareNetworkMatch(room.host.snapshot().matchSetup);
      room.host.gameReady(); room.guests[0].gameReady();
      const actor = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
      game.state.phase = "play"; game.state.currentPlayerIndex = actor.seatIndex;
      let continued = 0;
      const pending = game.controlRouter.waitForHumanPlay(actor, game.state.gameId, {
        waitLocal() { throw Error("不能打开Host输入"); },
        handleCard() { throw Error("不能执行旧真人意图"); },
        handleSkill() { throw Error("不能执行旧真人意图"); },
        runAi(player, gameId) { assert.equal(player, actor); assert.equal(gameId, game.state.gameId); continued += 1; }
      });
      room.host.markParticipantDisconnected(room.guests[0].snapshot().participantId);
      assert.equal(await pending, true);
      assert.equal(continued, 1);
    } finally { game?.dispose(); room.close(); }
  });

  test("Network：无 Transport 可准备Host单真人但不伪造连接或跳过屏障", async () => {
    const session = new NetworkSession();
    await session.open(R.HOST);
    assert.equal(session.snapshot().state, S.SELECTING);
    assert.equal(session.snapshot().currentHumanCount, 1);
    assert.equal(session.snapshot().candidates.length, 8);
    assert.throws(() => session.select({}), /自己的角色/);
    assert.throws(() => session.confirm(), /确认/);
    session.gameReady();
    assert.equal(session.snapshot().matchSetup, null);
    session.close();
    assert.equal(session.snapshot().state, S.IDLE);
    assert.throws(() => transitionNetworkState(S.IDLE, S.IN_GAME), /非法/);
  });

  test("Network：共享角色池且同房间重绘确认和成员更替不重新分配", async () => {
    let draws = 0;
    const pair = await connectedPair(() => { draws += 1; return 0.25; });
    const count = draws;
    const h = pair.host.snapshot();
    const g = pair.guest.snapshot();
    assert.equal(h.state, S.SELECTING);
    assert.equal(g.state, S.SELECTING);
    assert.equal(h.candidates.length, 8);
    assert.equal(g.candidates.length, 8);
    assert.equal(new Set([...h.candidates, ...g.candidates]).size, 8);
    assert.deepEqual(h.candidates, g.candidates);
    choosePair(pair);
    pair.host.confirm();
    renderNetworkSquadSelectionView(pair.host.snapshot());
    const guestId = pair.guest.snapshot().participantId;
    pair.host.markParticipantDisconnected(guestId);
    pair.host.addParticipant({ connectionId: "replacement" });
    assert.deepEqual(pair.host.snapshot().candidates, h.candidates);
    assert.deepEqual(pair.guest.snapshot().candidates, g.candidates);
    assert.equal(draws, count);
    assert.notDeepEqual(createNetworkSetup(() => 0).candidates, createNetworkSetup(() => 0.99).candidates);
  });

  for (const same of [true, false]) {
    test(`Network：双方${same ? "同阵营" : "敌对阵营"}保持五席2v3及两道Ready屏障`, async () => {
      const pair = await connectedPair();
      choosePair(pair, same);
      pair.host.confirm();
      assert.equal(pair.host.snapshot().state, S.WAITING_REMOTE);
      assert.equal(pair.host.snapshot().matchSetup, null);
      assert.equal(pair.guest.snapshot().matchSetup, null);
      pair.guest.confirm(); pair.host.start();
      const hostSetup = pair.host.snapshot().matchSetup;
      const guestSetup = pair.guest.snapshot().matchSetup;
      assert.deepEqual(hostSetup.players.map((player) => player.playerId), guestSetup.players.map((player) => player.playerId));
      assert.deepEqual(hostSetup.players.map((player) => player.seatIndex), [0, 1, 2, 3, 4]);
      for (const [session, localRole] of [[pair.host, R.HOST], [pair.guest, R.GUEST]]) {
        const snap = session.snapshot();
        assert.equal(snap.state, S.LOADING_GAME);
        assert.deepEqual(snap.matchSetup.players.map((p) => p.controlType).sort(), [C.AI, C.AI, C.AI, C.LOCAL_HUMAN, C.REMOTE_HUMAN].sort());
        assert.equal(snap.matchSetup.players.find((p) => p.controller.type === localRole).controlType, C.LOCAL_HUMAN);
        assert.equal(snap.matchSetup.players.find((p) => p.controller.type !== "AI" && p.controller.type !== localRole).controlType, C.REMOTE_HUMAN);
        assert.equal(new Set(snap.matchSetup.players.map((p) => p.characterId)).size, 5);
        assert.equal(snap.matchSetup.players.filter((p) => p.teamId === "dawn").length, 2);
        assert.equal(snap.matchSetup.players.filter((p) => p.teamId === "dusk").length, 3);
      }
      pair.host.gameReady();
      assert.equal(pair.host.snapshot().state, S.LOADING_GAME);
      assert.equal(pair.events.some((event) => event.type === E.MATCH_START), false);
      pair.guest.gameReady();
      assert.equal(pair.host.snapshot().state, S.IN_GAME);
      assert.equal(pair.guest.snapshot().state, S.IN_GAME);
      const starts = pair.events.filter((event) => event.type === E.MATCH_START).length;
      pair.host.gameReady();
      pair.guest.gameReady();
      assert.equal(pair.events.filter((event) => event.type === E.MATCH_START).length, starts);
    });
  }

  test("Network：拒绝重复角色冲突席位越权确认及旧消息", async () => {
    const pair = await connectedPair();
    choosePair(pair);
    const snap = pair.host.snapshot();
    assert.throws(() => pair.host.select({ ...snap.localSelection, characterId: pair.guest.snapshot().candidates.find((id) => id !== pair.host.snapshot().localSelection?.characterId) }));
    assert.throws(() => pair.guest.select({ ...pair.guest.snapshot().localSelection, seatId: snap.localSelection.seatId, teamId: snap.localSelection.teamId }));
    assert.equal(pair.host.receive({ roomId: "old", sender: R.GUEST, sequence: 900, type: E.GAME_READY }), false);
    assert.equal(pair.host.receive({ roomId: pair.roomId, sender: R.HOST, sequence: 901, type: E.SELECTION_CONFIRMED }), false);
    const last = pair.events.at(-1);
    assert.equal(pair.guest.receive(last), false);
    pair.host.confirm();
    assert.throws(() => pair.host.select(snap.localSelection));
    const copy = pair.host.snapshot();
    copy.candidates.length = 0;
    assert.equal(pair.host.snapshot().candidates.length, 8);
    pair.host.close();
    assert.equal(pair.host.receive({ roomId: pair.roomId, sender: NETWORK_CAPABILITY_SENDER, type: E.PEER_CONNECTED }), false);
  });

  test("Network：取消迟到创建和加入能力缺失均不伪造连接", async () => {
    let complete;
    const session = new NetworkSession({ capability: { createRoom: () => new Promise((resolve) => { complete = resolve; }) } });
    const pending = session.open(R.HOST);
    session.close();
    complete({ roomId: "late-room" });
    await pending;
    assert.equal(session.snapshot().state, S.IDLE);
    const guest = new NetworkSession();
    await guest.open(R.GUEST, { host: "address", port: NETWORK_DEFAULT_PORT });
    assert.equal(guest.snapshot().state, S.DISCONNECTED);
    assert.match(guest.snapshot().error, /尚未接入/);
  });

  test("Network：setup快照校验不接受容量和角色池篡改", () => {
    const setup = createNetworkSetup(() => 0.25);
    assert.equal(isNetworkSetupValid(setup), true);
    const broken = structuredClone(setup);
    broken.seats[0].teamId = broken.seats[0].teamId === "dawn" ? "dusk" : "dawn";
    assert.equal(isNetworkSetupValid(broken), false);
    const duplicate = structuredClone(setup);
    duplicate.candidates[1] = duplicate.candidates[0];
    assert.equal(isNetworkSetupValid(duplicate), false);
    assert.equal(isNetworkSelectionValid(setup, R.HOST, { characterId: "unknown-character", ...setup.seats[0] }), false);
    assert.equal(finalizeNetworkSetup(setup, {}), null);
  });

  test("Network：所有Choice种类统一路由远端且不调用本地或AI", async () => {
    const calls = [];
    const state = { players: [{ id: "local", controlType: C.LOCAL_HUMAN }, { id: "remote", controlType: C.REMOTE_HUMAN }, { id: "ai", controlType: C.AI }] };
    const router = new PlayerControlRouter({ getState: () => state, remoteDecision: async (request) => { calls.push(request); return { status: "declined" }; } });
    const local = { request: () => "local" }, ai = { request: () => "ai" };
    for (const kind of ["target", "discard", "hiddenCard", "publicCard", "response", "resource", "skill"]) {
      await router.request({ actorId: "remote", kind }, local, ai);
    }
    assert.equal(calls.length, 7);
    assert.equal(router.request({ actorId: "local" }, local, ai), "local");
    assert.equal(router.request({ actorId: "ai" }, local, ai), "ai");
    const missing = new PlayerControlRouter({ getState: () => state });
    await assert.rejects(missing.request({ actorId: "remote" }, local, ai), /尚未接入/);
  });

  test("Network：远端出牌与技能进入唯一Action入口并由远端结束阶段", async () => {
    const actor = { id: "remote", controlType: C.REMOTE_HUMAN, alive: true };
    const state = { gameId: "game", players: [actor], currentPlayerIndex: 0, phase: "play" };
    const intents = [{ kind: "card", cardId: "card" }, { kind: "skill" }, { kind: "end" }];
    const applied = [];
    const router = new PlayerControlRouter({ getState: () => state, remoteDecision: async () => intents.shift() });
    assert.equal(await router.waitForHumanPlay(actor, "game", {
      waitLocal: () => { throw Error("远端不应打开本地出牌"); },
      handleCard: (...args) => applied.push(["card", ...args]),
      handleSkill: (...args) => applied.push(["skill", ...args])
    }), true);
    assert.deepEqual(applied, [["card", "card", "remote"], ["skill", "remote"]]);
  });

  test("Network：最终setup复用真实Match准备且GameReady之前绝不发牌", async () => {
    const pair = await connectedPair();
    choosePair(pair);
    pair.host.confirm();
    pair.guest.confirm(); pair.host.start();
    const ui = makeUi();
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    let loops = 0;
    game.runGameLoop = () => { loops += 1; };
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    assert.equal(game.state.players.length, 5);
    assert.ok(game.state.players.every((p) => p.hand.length === 0));
    assert.throws(() => game.startPreparedMatch(), /尚未就绪/);
    pair.host.gameReady();
    assert.throws(() => game.startPreparedMatch(), /尚未就绪/);
    pair.guest.gameReady();
    assert.equal(await game.startPreparedMatch(), true);
    assert.ok(game.state.players.every((p) => p.hand.length > 0));
    assert.equal(loops, 1);
    assert.equal(await game.startPreparedMatch(), false);
    game.dispose();
  });

  test("Network：终局保留Result和MVP且禁止历史回调与永久成就", async () => {
    for (const mode of [MATCH_MODE.NETWORK, MATCH_MODE.SINGLEPLAYER]) {
      const pair = await connectedPair();
      choosePair(pair);
      pair.host.confirm(); pair.guest.confirm(); pair.host.start();
      const ui = makeUi();
      let persisted = 0;
      let presented = 0;
      ui.showMatchPerformance = (result) => { presented += 1; assert.ok(result); };
      const game = createGameApplication(ui, () => 0.25, { mode, networkSession: pair.host, onMatchResult: () => { persisted += 1; } });
      // 测试经相同准备入口生成公开最终事实，避免运行对局或平衡采样。
      game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
      await game.eventDispatcher.publishFact("gameStart", { gameId: game.state.gameId });
      game.state.winnerTeam = "dawn";
      await game.eventDispatcher.publishFact("gameOver", { gameId: game.state.gameId, winnerTeam: "dawn" });
      assert.equal(persisted, mode === MATCH_MODE.NETWORK ? 0 : 1);
      assert.equal(presented, 1);
      assert.equal(isMatchPersistenceEligible(mode), mode === MATCH_MODE.SINGLEPLAYER);
      game.dispose();
    }
  });

  test("Network：隐藏选牌与人物面板保持已知未知混合且未知payload无定义", async () => {
    for (const knownFlags of [[true], [false], [true, false]]) {
      const pair = await connectedPair();
      choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
      const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
      game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
      const host = game.controlRouter.humanPlayer();
      const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
      host.hand.push(...knownFlags.map((known) => instance(known ? "block" : "assault")));
      guest.aiMemory.knownCardsByPlayer[host.id] = Object.fromEntries(host.hand
        .filter((card, index) => knownFlags[index]).map((card) => [card.id, card.definitionId]));
      // Host 自己记得所有牌，不应改变 Guest 的可见性。
      host.aiMemory.knownCardsByPlayer[host.id] = Object.fromEntries(host.hand.map((card) => [card.id, card.definitionId]));
      pair.host.gameReady(); pair.guest.gameReady();
      const ui = makeGuestUi();
      ui.elements.response_panel = { innerHTML: "", classList: { add() {}, remove() {} } };
      ui.interactionController = new InteractionController(ui);
      const view = new NetworkGameView({ ui, submit: (...args) => pair.guest.gameChannel.respond(...args) });
      const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
      try {
        const pending = game.hiddenCardChoiceWorkflow.chooseHiddenCards(guest, host, 1, "选择手牌");
        const snapshot = pair.guest.gameChannel.snapshot();
        const request = snapshot.requests[0];
        const panel = snapshot.projection.players.find((player) => player.playerId === host.id).observedHand;
        assert.deepEqual(panel.map((card) => card.known), knownFlags);
        assert.deepEqual(request.options.map((option) => Boolean(option.card)), knownFlags);
        for (const [index, option] of request.options.entries()) {
          assert.equal(option.zone, "hand");
          assert.notEqual(option.optionId, host.hand[index].id);
          if (knownFlags[index]) {
            const { token, ...card } = option.card;
            assert.deepEqual(card, panel[index]);
            assert.ok(ui.elements.response_panel.innerHTML.includes(card.name));
          } else {
            assert.equal(option.card, null);
            assert.ok(!JSON.stringify(option).includes(host.hand[index].definitionId));
            assert.ok(!JSON.stringify(option).includes(host.hand[index].id));
            assert.doesNotMatch(JSON.stringify(option), /definitionId/);
          }
        }
        assert.equal((ui.elements.response_panel.innerHTML.match(/hidden-known-card/g) ?? []).length, knownFlags.filter(Boolean).length);
        assert.equal(Object.hasOwn(request, "selection"), false);
        ui.interactionController.settle([request.options[0].optionId]);
        assert.deepEqual(await pending, [host.hand[0]]);
      } finally {
        unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close();
      }
    }
  });

  test("Network：区域选牌复用正式装备已知基础已知战术未知排序并保持token身份", async () => {
    const pair = await connectedPair();
    choosePairAtSeats(pair, 3, 1); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const game = createGameApplication(makeUi(), () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const guest = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const owner = game.controlRouter.humanPlayer();
    const unknown = instance("recover"), tactic = instance("counter"), basic = instance("block");
    owner.hand.push(unknown, tactic, basic);
    owner.equipment = instance("energyDevice");
    for (const card of [tactic, basic]) game.cardKnowledge.remember(guest, owner, card);
    pair.host.gameReady(); pair.guest.gameReady();
    const ui = makeGuestUi();
    ui.elements.response_panel = { innerHTML: "", classList: { add() {}, remove() {} } };
    ui.interactionController = new InteractionController(ui);
    const view = new NetworkGameView({ ui, submit: (...args) => pair.guest.gameChannel.respond(...args) });
    const unsubscribe = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      const pending = game.hiddenCardChoiceWorkflow.choosePlayerZoneCard(guest, owner, "区域选择");
      const request = pair.guest.gameChannel.snapshot().requests[0];
      const slots = request.options.map((option) => ({ ...option.card, known: Boolean(option.card), zone: option.zone, token: option.optionId }));
      const expected = orderZoneSelectionSlots(slots.filter((slot) => slot.zone === "equipment"), slots.filter((slot) => slot.zone === "hand"));
      assert.deepEqual(expected.map((slot) => slot.name ?? "未知"), [owner.equipment.name, basic.name, tactic.name, "未知"]);
      const actualTokens = [...ui.elements.response_panel.innerHTML.matchAll(/data-hidden-token="([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(actualTokens, expected.map((slot) => slot.token));
      assert.ok(!ui.elements.response_panel.innerHTML.includes(unknown.name));
      ui.interactionController.settle([actualTokens[1]]);
      assert.deepEqual(await pending, { card: basic, zone: "hand" });
      assert.deepEqual(owner.hand, [unknown, tactic, basic]);
    } finally { unsubscribe(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：private reveal按cardIds顺序走正式UIManager且不泄露未知牌", async () => {
    const pair = await connectedPair();
    choosePair(pair); pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const hostUi = makeUi();
    const game = createGameApplication(hostUi, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    pair.host.gameReady(); pair.guest.gameReady();
    const actor = game.state.players.find((player) => player.controlType === C.REMOTE_HUMAN);
    const owner = game.controlRouter.humanPlayer();
    const [a, b, unknown, own] = ["assault", "charge", "counter", "recover"].map(instance);
    owner.hand.push(a, b, unknown); actor.hand.push(own);
    for (const card of [a, b]) game.cardKnowledge.remember(actor, owner, card);
    const ui = makeRevealUi(), calls = [];
    ui.showPrivateReveal = (title, cards) => {
      calls.push({ title, cards });
      return UIManager.prototype.showPrivateReveal.call(ui, title, cards);
    };
    const view = new NetworkGameView({ ui, submit: (...args) => pair.guest.gameChannel.respond(...args) });
    const off = pair.guest.gameChannel.subscribe((snapshot) => view.update(snapshot));
    try {
      let settled = false;
      const pending = game.presentationPort.showPrivateReveal({ viewerId: actor.id, title: "仅你可见",
        cardIds: [b.id, own.id, a.id, unknown.id, "missing"] }).then(() => { settled = true; });
      assert.deepEqual(calls[0].cards, [b, own, a].map((card) => ({ definitionId: card.definitionId })));
      assert.ok(ui.privateRevealView.pending);
      assert.equal(settled, false);
      assert.equal(hostUi.reveals.length, 0);
      const request = pair.guest.gameChannel.snapshot().requests[0];
      assert.doesNotMatch(JSON.stringify(request), new RegExp(`${unknown.id}|counter|${a.id}|${b.id}`));
      const html = ui.privateRevealView.element.innerHTML;
      assert.ok(html.indexOf("聚能") < html.indexOf("调息") && html.indexOf("调息") < html.indexOf("突袭"));
      pair.guest.gameChannel.notify();
      assert.equal(calls.length, 1);
      ui.privateRevealView.hide();
      await pending;
      assert.equal(settled, true);
      assert.equal(ui.privateRevealView.element.innerHTML, "");
      const source = await readFile(new URL("../js/ui/network/NetworkGameView.js", import.meta.url), "utf8");
      assert.doesNotMatch(source, /privateRevealView/);
    } finally { off(); view.dispose(); game.dispose(); pair.host.close(); pair.guest.close(); }
  });

  test("Network：无牌private reveal不阻塞且单机Guest共用定时与取消生命周期", async () => {
    const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map();
    let serial = 0;
    globalThis.setTimeout = (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    try {
      for (const game of [null, {}]) {
        const ui = makeRevealUi(); ui.game = game;
        await ui.showPrivateReveal("没有可展示的牌", []);
        assert.equal(ui.privateRevealView.pending, null);
        assert.equal(ui.privateRevealView.element.hidden, false);
        const timer = timers.get(ui.privateRevealTimer);
        assert.equal(timer.ms, 3200);
        ui.cancelChoiceInteractions({ preserveEmptyPrivateReveal: true });
        assert.equal(ui.privateRevealView.element.hidden, false);
        timers.delete(ui.privateRevealTimer); timer.callback();
        assert.equal(ui.privateRevealView.element.hidden, true);
        await ui.showPrivateReveal("另一条空牌提示", []);
        ui.cancelPendingInteractions();
        assert.equal(timers.size, 0);
        assert.equal(ui.privateRevealView.element.innerHTML, "");
      }
      const ui = makeRevealUi(), answers = [];
      const view = new NetworkGameView({ ui, submit: (...args) => answers.push(args) });
      const request = { kind: "private-reveal", requestId: "empty-reveal", label: "无牌", cards: [], min: 1, max: 1,
        options: [{ optionId: "close" }] };
      view.request = request;
      await view.presentDecision(request);
      assert.equal(answers.length, 1, "无牌仍通过正式UI入口立即完成协议确认");
      assert.equal(ui.privateRevealView.element.hidden, false);
      ui.cancelPendingInteractions();
      assert.equal(timers.size, 0);
    } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
  });

  test("Network：远端隐藏令牌在原选择authority重绑且私密揭示不进入本地UI", async () => {
    const pair = await connectedPair();
    choosePair(pair);
    pair.host.confirm(); pair.guest.confirm(); pair.host.start();
    const requests = [];
    const ui = makeUi();
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: pair.host });
    pair.guest.gameChannel.subscribe(({ requests: pending }) => {
      for (const request of pending) {
        requests.push(request);
        pair.guest.gameChannel.respond(request.requestId, { status: "selected", selectedIds: request.options.slice(0, request.min).map((option) => option.optionId) });
      }
    });
    pair.host.gameReady(); pair.guest.gameReady();
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const remote = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
    const owner = game.state.players.find((player) => player.controlType === C.LOCAL_HUMAN);
    owner.hand.push(instance("assault"));
    const chosen = await game.hiddenCardChoiceWorkflow.chooseHiddenCards(remote, owner, 1, "测试选择");
    assert.equal(chosen[0], owner.hand[0]);
    assert.notEqual(requests[0].options[0].optionId, owner.hand[0].id);
    await game.presentationPort.showPrivateReveal({ viewerId: remote.id, title: "私密", cardIds: [owner.hand[0].id] });
    assert.equal(requests.at(-1).kind, "private-reveal");
    assert.equal(ui.reveals.length, 0);
    game.dispose();
  });
}

/*
功能
注册模式导航、本地四卡DOM与结果页隔离测试。

调用方
tests/run.mjs UI 区域。

输入
test registrar。

输出
无。

读取状态
无。

写入状态
测试注册表。

调用函数
test。

边界与不变量
只测试页面行为与标记，不更改生产 capability。
*/
export function registerNetworkUiTests(test) {

  test("UI·Network：对局只复用正式game-screen与控件且旧renderer和CSS已删除", async () => {
    const [view, adapter, css] = await Promise.all([
      readFile(new URL("../js/ui/network/NetworkGameView.js", import.meta.url), "utf8"),
      readFile(new URL("../js/adapters/ui/NetworkPresentationAdapter.js", import.meta.url), "utf8"),
      readFile(new URL("../css/network.css", import.meta.url), "utf8")
    ]);
    assert.doesNotMatch(view, /network-game-player|network-game-roster|network-game-decision|renderDecision|showPage/);
    assert.doesNotMatch(css, /\.network-game(?:\b|-)/);
    for (const officialControl of [
      "renderBattlefield", "renderPresentedHand", "renderPresentedControls", "requestTarget",
      "requestDiscard", "requestResponse", "requestPublicCard", "requestHiddenCards",
      "appendLog", "setCurrentCard", "showJudgment", "showDying", "showDuel"
    ]) assert.match(view, new RegExp(`\\b${officialControl}\\b`), officialControl);
    assert.match(adapter, /orderPlayersForViewer/);
    const coreUi = await readFile(new URL("../js/ui/UIManager.js", import.meta.url), "utf8");
    assert.doesNotMatch(coreUi, /NetworkPresentationAdapter/);
    assert.match(coreUi, /PlayerPresentationOrder\.js/);
    assert.doesNotMatch(view + adapter, /createGameApplication|new MatchState|new GameLoop|new Worker|\/ai\//);
  });

  test("UI·Network：粘贴有效IP或hostname自动拆分且非法端口阻止提交", async () => {
    for (const [text, host, port] of [
      ["100.87.23.11:38520", "100.87.23.11", "38520"],
      [" hostname:38520 ", "hostname", "38520"], ["host:1", "host", "1"], ["host:65535", "host", "65535"]
    ]) {
      const form = makeJoinForm("", 4321);
      let prevented = false;
      handleNetworkHostPaste({ target: form.elements.host, clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      assert.equal(form.elements.host.value, host);
      assert.equal(form.elements.port.value, port);
      assert.equal(validateNetworkHost(form), true);
    }
    for (const text of ["abc:def", "host:99999", "host:0", "host:-1", "host:1.5", "host:1e3"]) {
      const form = makeJoinForm();
      handleNetworkHostPaste({ target: form.elements.host, clipboardData: { getData: () => text }, preventDefault() {} });
      assert.equal(form.elements.host.value, text);
      assert.equal(form.elements.port.value, String(NETWORK_DEFAULT_PORT));
      assert.equal(validateNetworkHost(form), false);
      assert.match(form.elements.host.validationMessage, /1–65535/);
    }
    const form = makeJoinForm("", 4321);
    let prevented = false;
    handleNetworkHostPaste({ target: form.elements.host, clipboardData: { getData: () => "100.87.23.11" }, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, "纯 Host 保持原生粘贴，不破坏逐字编辑");
    assert.equal(form.elements.port.value, "4321");
    form.elements.host.value = "manual-host";
    assert.equal(validateNetworkHost(form), true);
    assert.match(renderNetworkEntryView({ join: true }), /min="1" max="65535" step="1"/);

    let joined;
    const flow = createNetworkFlow({
      ui: { showNetworkPage() {} }, onDisposeMatch() {},
      capability: { joinRoom: async (endpoint) => { joined = endpoint; return { roomId: "room" }; }, subscribe: () => () => {}, close() {} }
    });
    const previous = globalThis.FormData;
    try {
      globalThis.FormData = class { constructor(value) { this.form = value; } get(key) { return this.form.elements[key].value; } };
      flow.handleSubmit({ target: form, preventDefault() {} });
      await Promise.resolve();
      assert.deepEqual(joined, { host: "manual-host", port: 4321 });
      flow.show("entry");
      joined = null;
      form.elements.host.value = "host:99999";
      flow.handleSubmit({ target: form, preventDefault() {} });
      assert.equal(joined, null);
      form.elements.host.value = "host";
      form.elements.port.value = "65536";
      flow.handleSubmit({ target: form, preventDefault() {} });
      assert.equal(joined, null);
    } finally { globalThis.FormData = previous; flow.session.close(); }
  });
  test("UI·Network：模式页单人回到原入口且多人进入创建加入页", () => {
    let markup = "", single = 0;
    const flow = createNetworkFlow({
      ui: { showNetworkPage: (html) => { markup = html; }, playSound: () => {} },
      onSingleplayer: () => { single += 1; }, onHome: () => {}, onDisposeMatch: () => {}
    });
    flow.show();
    assert.match(markup, /选择游玩方式/);
    assert.match(markup, /<header><h2>选择游玩方式<\/h2><\/header>/);
    assert.doesNotMatch(markup, /五域纷争 · 开启新局|踏入五域，与同伴书写新的战局。/);
    assert.match(markup, /class="ghost-button" data-network-action="home">返回<\/button>/);
    const click = (action) => flow.handleClick({ target: { closest: () => ({ dataset: { networkAction: action } }) } });
    click(MATCH_MODE.SINGLEPLAYER);
    assert.equal(single, 1);
    flow.show();
    click(MATCH_MODE.NETWORK);
    assert.match(markup, /创建房间/);
    assert.match(markup, /加入房间/);
    assert.doesNotMatch(markup, /五域纷争 · 双人同行/);
    assert.match(markup, /最多五位真人，五个席位。阵营由你选择。/);
    click("join");
    assert.match(markup, /data-network-form/);
  });


  test("UI·Network：Lobby身份展示displayName且管理权限来自authority", async () => {
    const room = await connectedRoom(4);
    try {
      assert.equal(formatNetworkAddress("::ffff:10.196.91.201"), "10.196.91.201");
      assert.equal(formatNetworkAddress("2001:db8::1"), "2001:db8::1");
      assert.equal(formatNetworkAddress(null), "地址未提供");
      room.host.setMaxHumanCount(4);
      const renderNamed = (snapshot) => {
        const named = structuredClone(snapshot);
        for (const participant of Object.values(named.participants)) {
          participant.displayName = participant.role === R.HOST ? "主控玩家" : `访客 ${participant.guestOrdinal}`;
        }
        return renderNetworkSquadSelectionView(named);
      };
      const hostMarkup = renderNamed(room.host.snapshot());
      assert.match(hostMarkup, /房间 4 \/ 4/);
      for (const label of ["主控玩家", "访客 1", "访客 2", "访客 3"]) assert.ok(hostMarkup.includes(label));
      assert.equal((hostMarkup.match(/data-network-action="kick"/g) ?? []).length, 3);
      assert.doesNotMatch(hostMarkup, /10\.0\.0\.2|<strong>Host<\/strong>|<strong>Guest [123]<\/strong>/);
      assert.doesNotMatch(hostMarkup, /::ffff:|双人|等待另一名|两位真人/);
      const guestMarkup = renderNamed(room.guests[0].snapshot());
      assert.match(guestMarkup, /房间 4 \/ 4/);
      assert.match(guestMarkup, /<strong>主控玩家<\/strong>/);
      assert.match(guestMarkup, /<strong>访客 1<\/strong>/);
      assert.doesNotMatch(guestMarkup, /data-network-action="(?:kick|capacity|start)"/);
      room.host.select({ characterId: room.host.snapshot().candidates[0], ...room.host.snapshot().seats[0] });
      const updated = renderNetworkSquadSelectionView(room.guests[0].snapshot());
      assert.match(updated, /disabled[^>]*data-character-id=/);
    } finally { room.close(); }
  });

  test("UI·Network：两端DOM显示共享候选且单真人Host可以选择", async () => {
    const pair = await connectedPair();
    for (const [local, remote] of [[pair.host, pair.guest], [pair.guest, pair.host]]) {
      const markup = renderNetworkSquadSelectionView(local.snapshot());
      assert.equal((markup.match(/data-character-id=/g) ?? []).length, 8);
      for (const id of remote.snapshot().candidates) assert.ok(markup.includes(`data-character-id="${id}"`));
    }
    const waiting = new NetworkSession();
    await waiting.open(R.HOST);
    const markup = renderNetworkSquadSelectionView(waiting.snapshot());
    assert.match(markup, /房间 1 \/ 2/);
    assert.ok(markup.includes("data-character-id"));
    assert.match(markup, /data-network-action="confirm" disabled/);
  });

  test("UI·Network：多人结果不生成成就section而单人保持原展示", () => {
    for (const mode of [MATCH_MODE.NETWORK, MATCH_MODE.SINGLEPLAYER]) {
      let sections = 0, markup;
      UIManager.prototype.showMatchPerformance.call({
        game: { mode, state: { players: [] } }, newlyUnlockedAchievements: [],
        historyArchiveView: { achievementView: { renderMatchUnlockList: () => { sections += 1; return "<section>achievements</section>"; } } },
        matchMvpResultView: { render: (_vm, _human, html) => { markup = html; } }
      }, {});
      assert.equal(sections, mode === MATCH_MODE.NETWORK ? 0 : 1);
      assert.equal(markup, mode === MATCH_MODE.NETWORK ? "" : "<section>achievements</section>");
    }
  });
}
