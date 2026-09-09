import { NETWORK_EVENT as E, NETWORK_ROLE as R } from "./NetworkProtocol.js";
import { NETWORK_STATE as S } from "./NetworkLobbyState.js";
import { projectNetworkGame } from "./NetworkViewerProjection.js";

export class NetworkGameChannel {
  #getSession;
  #send;
  #host = null;
  #pending = new Map();
  #requests = new Map();
  #listeners = new Set();
  #projection = null;
  #serial = 0;

  /*
功能
装配受 NetworkSession 生命周期约束的游戏消息通道。

调用方
NetworkSession constructor。

输入
session snapshot getter 与唯一 send capability。

输出
channel。

读取状态
无。

写入状态
私有消息与订阅容器。

调用函数
无。

边界与不变量
不创建 MatchState、规则引擎、RNG 或 Worker。
*/
  constructor({ getSession, send }) {
    this.#getSession = getSession;
    this.#send = send;
  }

  /*
功能
仅允许 Host 绑定唯一真实游戏的读取和决定投影能力。

调用方
Host composition。

输入
getState、prepareDecision。

输出
无；Guest 或重复绑定抛错。

读取状态
session role。

写入状态
Host capability 引用。

调用函数
无。

边界与不变量
Guest 不能取得真实状态能力；Host 状态本体仍由 MatchApplication 持有。
*/
  bindHost({ getState, prepareDecision }) {
    if (this.#getSession().role !== R.HOST || this.#host) throw new Error("仅 Host 可绑定唯一 Match authority");
    this.#host = { getState, prepareDecision };
  }

  /*
功能
向 Guest 发送经过 viewer 白名单投影的最新状态。

调用方
Host presentation bridge、请求决策前。

输入
已白名单处理的 presentation，缺省为空。

输出
无。

读取状态
唯一 Host 状态与双方正式 setup。

写入状态
只发送消息，不写游戏状态。

调用函数
projectNetworkGame、send。

边界与不变量
只有已完成选角的 Host 能发布；不允许传入或发送 raw MatchState。
*/
  publish(presentation = null) {
    const session = this.#getSession();
    if (!this.#host || session.role !== R.HOST || ![S.LOADING_GAME, S.IN_GAME].includes(session.state)) return;
    const viewerId = session.matchSetup?.players.find((player) => player.role === R.GUEST)?.playerId;
    const state = this.#host.getState();
    if (!viewerId || state.isDisposed || !state.players.length) return;
    this.#send(E.GAME_SNAPSHOT, projectNetworkGame(state, viewerId, presentation));
  }

  /*
功能
注册 Guest 展示消费者。

调用方
NetworkFlow。

输入
listener。

输出
取消订阅函数。

读取状态
client projection 与安全请求。

写入状态
订阅表。

调用函数
notify。

边界与不变量
快照拷贝不会成为规则 authority。
*/
  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  /*
功能
提供 Guest 可展示的状态及待答请求副本。

调用方
NetworkFlow 与测试。

输入
无。

输出
data-only projection/request snapshot。

读取状态
私有 projection 和 requests。

写入状态
无。

调用函数
structuredClone。

边界与不变量
不持有或暴露 Host 真实状态。
*/
  snapshot() {
    return structuredClone({ projection: this.#projection, requests: [...this.#requests.values()] });
  }

  /*
功能
通知 Guest 投影和决策面板变更。

调用方
receive、respond、reset。

输入
无。

输出
无。

读取状态
listeners。

写入状态
无。

调用函数
snapshot。

边界与不变量
每个消费者获得独立数据副本。
*/
  notify() {
    for (const listener of this.#listeners) {
      listener(this.snapshot());
    }
  }

  /*
功能
把 Host 的真人决定挂起并发送有限、安全的选项。

调用方
NetworkSession.requestDecision。

输入
Host 内部 request。

输出
已验证并重绑的结果 Promise。

读取状态
Host state、session、prepareDecision。

写入状态
pending request registry。

调用函数
publish、prepareDecision、send。

边界与不变量
仅向已绑定 Guest actor 发请求；实际状态版本与关联 ID 固定，断线解除等待。
*/
  request(request) {
    const session = this.#getSession();
    if (session.role !== R.HOST || session.state !== S.IN_GAME || !this.#host) return Promise.reject(new Error("仅 Host 可请求远端决定"));
    const state = this.#host.getState();
    const guestId = session.matchSetup.players.find((player) => player.role === R.GUEST)?.playerId;
    if (state.isDisposed || state.isGameOver || request.actorId !== guestId || request.gameId !== state.gameId) {
      return Promise.reject(new Error("无效远端决定 actor 或游戏"));
    }
    const prepared = this.#host.prepareDecision(request);
    if (Object.hasOwn(prepared, "immediate")) return Promise.resolve(prepared.immediate);
    const requestId = `network-decision-${++this.#serial}`;
    const view = { ...prepared.view, requestId, actorId: guestId, gameId: state.gameId, stateVersion: state.stateVersion };
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { view, decode: prepared.decode, resolve, reject });
    });
    this.publish();
    this.#send(E.DECISION_REQUEST, view);
    return promise;
  }

  /*
功能
接收通过 Session 身份、序号和房间检查的游戏消息。

调用方
NetworkSession.receive。

输入
protocol envelope。

输出
是否接受。

读取状态
role、phase、pending 与 client projection。

写入状态
Guest projection/requests，或 Host pending Promise。

调用函数
acceptResponse、notify。

边界与不变量
Guest 无法反向写 snapshot；仅 Host 可发请求，LOADING 只允许接收初始投影。
*/
  receive(event) {
    const session = this.#getSession();
    if (![S.LOADING_GAME, S.IN_GAME].includes(session.state)) return false;
    if (session.role === R.HOST) {
      if (![E.DECISION_RESPONSE, E.PLAYER_INTENT].includes(event.type) || session.state !== S.IN_GAME) return false;
      return this.acceptResponse(event);
    }
    if (event.type === E.GAME_SNAPSHOT) {
      const projection = event.payload;
      const viewerId = session.matchSetup?.players.find((player) => player.role === R.GUEST)?.playerId;
      if (!projection?.gameId || projection.viewerId !== viewerId
        || (this.#projection && (projection.gameId !== this.#projection.gameId || projection.stateVersion < this.#projection.stateVersion))) return false;
      this.#projection = structuredClone(projection);
      this.notify();
      return true;
    }
    if (event.type === E.DECISION_REQUEST && session.state === S.IN_GAME) {
      const request = event.payload;
      if (request?.gameId !== this.#projection?.gameId || request.actorId !== this.#projection?.viewerId
        || typeof request.requestId !== "string" || this.#requests.has(request.requestId)) return false;
      this.#requests.set(request.requestId, structuredClone(request));
      this.notify();
      return true;
    }
    if (event.type === E.DECISION_CANCELLED) {
      this.#requests.delete(event.payload?.requestId);
      this.notify();
      return true;
    }
    return false;
  }

  /*
功能
验证 Guest 回答的关联身份、类型、数量与最新 Host 状态。

调用方
receive。

输入
DECISION_RESPONSE 或 PLAYER_INTENT envelope。

输出
是否接受。

读取状态
pending view 与当前真实状态。

写入状态
只完成 pending；规则结算留给原 workflow。

调用函数
pending.decode、resolve、send。

边界与不变量
拒绝重放、跨 actor、跨游戏、未授权选项和过期回答；不接受客户端 selection 对象。
*/
  acceptResponse(event) {
    const response = event.payload;
    const pending = this.#pending.get(response?.requestId);
    if (!pending || !this.#host) return false;
    const { view } = pending;
    const expectedType = view.kind === "player-intent" ? E.PLAYER_INTENT : E.DECISION_RESPONSE;
    if (event.type !== expectedType || response.gameId !== view.gameId || response.actorId !== view.actorId
      || response.stateVersion !== view.stateVersion) return false;
    const state = this.#host.getState();
    const actor = state.players.find((player) => player.id === view.actorId);
    if (state.isDisposed || state.isGameOver || state.gameId !== view.gameId || state.stateVersion !== view.stateVersion || !actor?.alive) {
      this.#pending.delete(view.requestId);
      this.#send(E.DECISION_CANCELLED, { requestId: view.requestId });
      pending.resolve(view.kind === "player-intent" ? { kind: "cancelled" } : { status: "cancelled", selectedIds: [] });
      return false;
    }
    const ids = response.selectedIds;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return false;
    if (response.status === "declined") {
      if (!view.canDecline || ids.length) return false;
    } else if (response.status !== "selected" || ids.length < view.min || ids.length > view.max
      || ids.some((id) => !view.options.some((option) => option.optionId === id))) return false;
    this.#pending.delete(view.requestId);
    this.#send(E.DECISION_CANCELLED, { requestId: view.requestId });
    pending.resolve(pending.decode(response));
    return true;
  }

  /*
功能
从 Guest UI 提交当前请求的选项 ID。

调用方
NetworkGameView。

输入
requestId 与 selected/declined、selectedIds。

输出
是否提交。

读取状态
当前请求与 session role。

写入状态
Guest 请求面板。

调用函数
send、notify。

边界与不变量
只能答复 Host 请求，不能自造 actor、gameId、stateVersion 或任意执行 payload。
*/
  respond(requestId, result) {
    const request = this.#requests.get(requestId);
    if (this.#getSession().role !== R.GUEST || this.#getSession().state !== S.IN_GAME || !request) return false;
    this.#requests.delete(requestId);
    this.#send(request.kind === "player-intent" ? E.PLAYER_INTENT : E.DECISION_RESPONSE, {
      requestId, gameId: request.gameId, actorId: request.actorId, stateVersion: request.stateVersion,
      status: result.status, selectedIds: [...(result.selectedIds ?? [])]
    });
    this.notify();
    return true;
  }

  /*
功能
清理当前游戏通道和所有待处理决定。

调用方
Session.close/disconnect；Host dispose。

输入
无。

输出
无。

读取状态
pending。

写入状态
清除 authority capabilities、projection、请求和 generation。

调用函数
reject、notify。

边界与不变量
不更改 Lobby 池；迟到回答找不到旧 pending；Guest 无需销毁任何 Match。
*/
  reset() {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Network 游戏通道已关闭"));
    }
    this.#pending.clear();
    this.#requests.clear();
    this.#projection = null;
    this.#host = null;
    this.notify();
  }
}
