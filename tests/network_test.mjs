import assert from "node:assert/strict";
import { NetworkSession } from "../js/network/NetworkSession.js";
import { NETWORK_EVENT as E, NETWORK_ROLE as R, NETWORK_CAPABILITY_SENDER } from "../js/network/NetworkProtocol.js";
import { NETWORK_STATE as S, transitionNetworkState } from "../js/network/NetworkLobbyState.js";
import { createNetworkSetup, isNetworkSetupValid, isNetworkSelectionValid, finalizeNetworkSetup, projectNetworkMatch } from "../js/network/NetworkSetup.js";
import { PlayerControlRouter, PLAYER_CONTROL as C } from "../js/network/PlayerControlRouter.js";
import { MATCH_MODE, isMatchPersistenceEligible } from "../js/application/match/MatchMode.js";
import { createGameApplication } from "../js/composition/createGameApplication.js";
import { createNetworkFlow } from "../js/composition/createNetworkFlow.js";
import { UIManager } from "../js/ui/UIManager.js";
import { renderNetworkSquadSelectionView } from "../js/ui/network/NetworkSquadSelectionView.js";

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
async function connectedPair(random = () => 0.25) {
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
  const host = new NetworkSession({ capability: capability(R.HOST), random });
  const guest = new NetworkSession({ capability: capability(R.GUEST), random: () => { throw Error("Guest 不得 shuffle"); } });
  await host.open(R.HOST);
  await guest.open(R.GUEST, "test-room");
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
  pair.guest.select({ characterId: pair.guest.snapshot().candidates[0], ...guestSeat });
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
export function registerNetworkTests(test, { makeUi, instance }) {
  test("Network：无 Transport 创建等待且不能选择或提前准备", async () => {
    const session = new NetworkSession();
    await session.open(R.HOST);
    assert.equal(session.snapshot().state, S.WAITING_PEER);
    assert.deepEqual(session.snapshot().candidates, []);
    assert.throws(() => session.select({}), /自己的角色/);
    assert.throws(() => session.confirm(), /确认/);
    session.gameReady();
    assert.equal(session.snapshot().matchSetup, null);
    session.close();
    assert.equal(session.snapshot().state, S.IDLE);
    assert.throws(() => transitionNetworkState(S.IDLE, S.IN_GAME), /非法/);
  });

  test("Network：随机角色池4比4互斥且同房间重绘确认重连不重新分配", async () => {
    let draws = 0;
    const pair = await connectedPair(() => { draws += 1; return 0.25; });
    const count = draws;
    const h = pair.host.snapshot();
    const g = pair.guest.snapshot();
    assert.equal(h.state, S.SELECTING);
    assert.equal(g.state, S.SELECTING);
    assert.equal(h.candidates.length, 4);
    assert.equal(g.candidates.length, 4);
    assert.equal(new Set([...h.candidates, ...g.candidates]).size, 8);
    assert.equal(h.candidates.some((id) => g.candidates.includes(id)), false);
    choosePair(pair);
    pair.host.confirm();
    renderNetworkSquadSelectionView(pair.host.snapshot());
    pair.host.disconnect();
    pair.guest.disconnect();
    pair.connect();
    assert.deepEqual(pair.host.snapshot().candidates, h.candidates);
    assert.deepEqual(pair.guest.snapshot().candidates, g.candidates);
    assert.equal(draws, count);
    assert.notDeepEqual(createNetworkSetup(() => 0).pools, createNetworkSetup(() => 0.99).pools);
  });

  for (const same of [true, false]) {
    test(`Network：双方${same ? "同阵营" : "敌对阵营"}保持五席2v3及两道Ready屏障`, async () => {
      const pair = await connectedPair();
      choosePair(pair, same);
      pair.host.confirm();
      assert.equal(pair.host.snapshot().state, S.WAITING_REMOTE);
      assert.equal(pair.host.snapshot().matchSetup, null);
      assert.equal(pair.guest.snapshot().matchSetup, null);
      pair.guest.confirm();
      for (const session of [pair.host, pair.guest]) {
        const snap = session.snapshot();
        assert.equal(snap.state, S.LOADING_GAME);
        assert.deepEqual(snap.matchSetup.players.map((p) => p.controlType).sort(), [C.AI, C.AI, C.AI, C.LOCAL_HUMAN, C.REMOTE_HUMAN].sort());
        assert.equal(snap.matchSetup.players[0].controlType, C.LOCAL_HUMAN);
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

  test("Network：拒绝交叉角色池冲突席位越权确认及旧消息", async () => {
    const pair = await connectedPair();
    choosePair(pair);
    const snap = pair.host.snapshot();
    assert.throws(() => pair.host.select({ ...snap.localSelection, characterId: pair.guest.snapshot().candidates[0] }));
    assert.throws(() => pair.guest.select({ ...pair.guest.snapshot().localSelection, seatId: snap.localSelection.seatId, teamId: snap.localSelection.teamId }));
    assert.equal(pair.host.receive({ roomId: "old", sender: R.GUEST, sequence: 900, type: E.GAME_READY }), false);
    assert.equal(pair.host.receive({ roomId: pair.roomId, sender: R.HOST, sequence: 901, type: E.SELECTION_CONFIRMED }), false);
    const last = pair.events.at(-1);
    assert.equal(pair.guest.receive(last), false);
    pair.host.confirm();
    assert.throws(() => pair.host.select(snap.localSelection));
    const copy = pair.host.snapshot();
    copy.candidates.length = 0;
    assert.equal(pair.host.snapshot().candidates.length, 4);
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
    await guest.open(R.GUEST, "address");
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
    duplicate.pools.GUEST[0] = duplicate.pools.HOST[0];
    assert.equal(isNetworkSetupValid(duplicate), false);
    assert.equal(isNetworkSelectionValid(setup, R.HOST, { characterId: setup.pools.GUEST[0], ...setup.seats[0] }), false);
    assert.equal(finalizeNetworkSetup(setup, {}, { HOST: true, GUEST: false }), null);
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
      handleSkill: (...args) => applied.push(["skill", ...args]), setPrompt: () => {}
    }), true);
    assert.deepEqual(applied, [["card", "card", "remote"], ["skill", "remote"]]);
  });

  test("Network：最终setup复用真实Match准备且GameReady之前绝不发牌", async () => {
    const pair = await connectedPair();
    choosePair(pair);
    pair.host.confirm();
    pair.guest.confirm();
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
      pair.host.confirm(); pair.guest.confirm();
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

  test("Network：远端隐藏令牌在原选择authority重绑且私密揭示不进入本地UI", async () => {
    const pair = await connectedPair();
    choosePair(pair);
    pair.host.confirm(); pair.guest.confirm();
    const requests = [];
    const ui = makeUi();
    const game = createGameApplication(ui, () => 0.25, { mode: MATCH_MODE.NETWORK, networkSession: {
      requestDecision: async (request) => { requests.push(request); return { status: "selected", selectedIds: request.optionIds?.slice(0, 1) ?? [] }; }
    } });
    game.prepareNetworkMatch(pair.host.snapshot().matchSetup);
    const remote = game.state.players.find((p) => p.controlType === C.REMOTE_HUMAN);
    const owner = game.state.players[0];
    owner.hand.push(instance("assault"));
    const chosen = await game.hiddenCardChoiceWorkflow.chooseHiddenCards(remote, owner, 1, "测试选择");
    assert.equal(chosen[0], owner.hand[0]);
    assert.notEqual(requests[0].optionIds[0], owner.hand[0].id);
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
    assert.match(markup, /两位真人，五个席位。阵营由你选择。/);
    click("join");
    assert.match(markup, /data-network-form/);
  });

  test("UI·Network：两端DOM各渲染本地四卡且等待页没有候选", async () => {
    const pair = await connectedPair();
    for (const [local, remote] of [[pair.host, pair.guest], [pair.guest, pair.host]]) {
      const markup = renderNetworkSquadSelectionView(local.snapshot());
      assert.equal((markup.match(/data-character-id=/g) ?? []).length, 4);
      for (const id of remote.snapshot().candidates) assert.ok(!markup.includes(`data-character-id="${id}"`));
    }
    const waiting = new NetworkSession();
    await waiting.open(R.HOST);
    const markup = renderNetworkSquadSelectionView(waiting.snapshot());
    assert.match(markup, /等待另一名玩家连接/);
    assert.ok(!markup.includes("data-character-id"));
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
