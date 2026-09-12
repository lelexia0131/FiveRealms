import { NETWORK_EVENT as E, NETWORK_ROLE as R, NETWORK_RESYNC_INTERVAL_MS, NETWORK_LOG_REQUEST_INTERVAL_MS } from "./NetworkProtocol.js";
import { NETWORK_STATE as S } from "./NetworkLobbyState.js";
import { projectNetworkGame } from "./NetworkViewerProjection.js";

export class NetworkGameChannel {
  #getSession;
  #send;
  #host = null;
  #pending = new Map();
  #accepted = new Map();
  #requests = new Map();
  #listeners = new Set();
  #projection = null;
  #serial = 0;
  #projectionRevision = 0;
  #logs = [];
  #logContinuations = new Map();
  #resyncTimes = new Map();
  #resyncTimers = new Map();
  #logRequestTimer = null;
  #logRollbackRevision = 0;

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
getState、prepareDecision、getDisplay 与控制元数据同步 capability。

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
  bindHost({ getState, prepareDecision, getDisplay = () => null, syncControllers = () => {} }) {
    if (this.#getSession().role !== R.HOST || this.#host) throw new Error("仅 Host 可绑定唯一 Match authority");
    this.#host = { getState, prepareDecision, getDisplay, syncControllers };
  }

  /*
功能
向 Guest 发送经过 viewer 白名单投影的最新状态。

调用方
Host presentation bridge、请求决策前。

输入
已白名单处理的 presentation；recipientParticipantId 限定成员，resetLogs 从头恢复，logContinuation 只补日志块。

输出
无。

读取状态
  唯一 Host 状态、五席 controller ownership 与真人成员。

写入状态
记录每成员唯一可继续拉取的位置；不写游戏状态。

调用函数
projectNetworkGame、send。

边界与不变量
  只有已完成选角的 Host 能发布；controller 标签只按 setup.playerId 映射，不允许按数组位置猜；不允许传入或发送 raw MatchState。
*/
  publish(presentation = null, recipientParticipantId = null, resetLogs = false, logContinuation = false) {
    const session = this.#getSession();
    if (!this.#host || session.role !== R.HOST || ![S.LOADING_GAME, S.IN_GAME].includes(session.state)) return;
    const state = this.#host.getState();
    if (state.isDisposed || !state.players.length) return;
    const networkRoles = Object.fromEntries(
      session.matchSetup.players.map((player) => [player.playerId, player.networkRole])
    );
    for (const seat of session.matchSetup.players) {
      if (seat.controller.type !== R.GUEST) continue;
      const participant = session.participants[seat.controller.participantId];
      if (!participant?.connected || participant.kicked) continue;
      if (recipientParticipantId && participant.participantId !== recipientParticipantId) continue;
      const projection = projectNetworkGame(
        state, seat.playerId, presentation, this.#host.getDisplay(seat.playerId, resetLogs), networkRoles
      );
      const sync = projection.display?.logSync;
      const next = sync ? sync.start + sync.entries.length : 0;
      // 先登记再投递，内存 capability 可以同步交付下一块请求。
      if (sync && next < sync.total) this.#logContinuations.set(participant.participantId, next);
      else this.#logContinuations.delete(participant.participantId);
      this.#send(E.GAME_SNAPSHOT, projection, participant.participantId);
      if (logContinuation) continue;
      for (const pending of this.#pending.values()) {
        if (pending.participantId !== participant.participantId) continue;
        // 恢复时先沿用回答验收的失效规则，否则 Guest 会永远拒绝旧版本请求而 Host 仍等待。
        const { view } = pending;
        if (recipientParticipantId && (state.isGameOver || state.gameId !== view.gameId
          || state.stateVersion !== view.stateVersion || !state.players.find((player) => player.id === view.actorId)?.alive)) {
          this.#pending.delete(view.requestId);
          this.#send(E.DECISION_CANCELLED, { requestId: view.requestId }, participant.participantId);
          pending.resolve(view.kind === "player-intent" ? { kind: "cancelled" } : { status: "cancelled", selectedIds: [] });
          continue;
        }
        this.#send(E.DECISION_REQUEST, view, participant.participantId);
      }
    }
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
includeLogs 决定是否附上本地累计展示副本，日常通知传 false。

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
  snapshot(includeLogs = true) {
    const result = structuredClone({ projection: this.#projection, projectionRevision: this.#projectionRevision, requests: [...this.#requests.values()] });
    // 只有新订阅/显式本地读取需要展示副本；日常通知不复制累计历史。
    if (includeLogs && result.projection?.display) result.projection.display.logs = structuredClone(this.#logs);
    return result;
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
      listener(this.snapshot(false));
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
    const seat = session.matchSetup.players.find((player) => player.playerId === request.actorId);
    const participant = session.participants[seat?.controller.participantId];
    if (state.isDisposed || state.isGameOver || seat?.controller.type !== R.GUEST
      || !participant?.connected || participant.kicked || request.gameId !== state.gameId) {
      return Promise.reject(new Error("无效远端决定 actor 或游戏"));
    }
    const prepared = this.#host.prepareDecision(request);
    if (Object.hasOwn(prepared, "immediate")) return Promise.resolve(prepared.immediate);
    const requestId = `network-decision-${++this.#serial}`;
    const view = { ...prepared.view, requestId, actorId: seat.playerId, gameId: state.gameId, stateVersion: state.stateVersion };
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { view, participantId: participant.participantId, decode: prepared.decode, resolve, reject });
    });
    // publish 已发送快照及 pending 请求；同步交付可能在返回前收到 Accepted，不能再次发送已完成请求。
    this.publish();
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
Guest projection/日志展示副本/requests，Host pending Promise、恢复预算及单次拉取位置。

调用函数
acceptResponse、notify。

边界与不变量
Guest 无法反向写 snapshot；仅 Host 可发请求，LOADING 只允许接收初始投影。
*/
  receive(event) {
    const session = this.#getSession();
    if (![S.LOADING_GAME, S.IN_GAME].includes(session.state)) return false;
    if (session.role === R.HOST) {
      if ([E.RESYNC_REQUEST, E.LOG_REQUEST].includes(event.type)) {
        const participant = session.participants[event.participantId];
        if (!this.#host || !participant?.connected || participant.kicked || participant.role !== R.GUEST
          || event.payload?.gameId !== this.#host.getState().gameId) return false;
        if (event.type === E.LOG_REQUEST) {
          if (!this.#logContinuations.has(event.participantId)
            || event.payload.offset !== this.#logContinuations.get(event.participantId)) return false;
          this.#logContinuations.delete(event.participantId);
        } else {
          const now = performance.now();
          const remaining = NETWORK_RESYNC_INTERVAL_MS - (now - (this.#resyncTimes.get(event.participantId) ?? -Infinity));
          if (remaining > 0) {
            this.deferResync(event.participantId, remaining);
            return true;
          }
          clearTimeout(this.#resyncTimers.get(event.participantId));
          this.#resyncTimers.delete(event.participantId);
          this.#resyncTimes.set(event.participantId, now);
        }
        this.publish(null, event.participantId, event.type === E.RESYNC_REQUEST, event.type === E.LOG_REQUEST);
        return true;
      }
      if (event.type === E.DECISION_RECEIVED) {
        const pending = this.#pending.get(event.payload?.requestId);
        return Boolean(pending && pending.participantId === event.participantId);
      }
      if (![E.DECISION_RESPONSE, E.PLAYER_INTENT].includes(event.type) || session.state !== S.IN_GAME) return false;
      return this.acceptResponse(event);
    }
    if (event.type === E.GAME_SNAPSHOT) {
      const projection = event.payload;
      const viewerId = session.matchSetup?.players.find((player) => player.controller.participantId === session.participantId)?.playerId;
      if (!projection?.gameId || projection.viewerId !== viewerId
        || !Number.isSafeInteger(projection.stateVersion) || projection.stateVersion < 0) return false;
      const sync = projection.display?.logSync;
      if (sync) {
        if (!Number.isSafeInteger(sync.start) || sync.start < 0 || !Number.isSafeInteger(sync.total)
          || !Number.isSafeInteger(sync.rollbackRevision) || sync.rollbackRevision < this.#logRollbackRevision
          || !Array.isArray(sync.entries) || sync.total < sync.start + sync.entries.length) return false;
      }
      // 正式 Action 会原位恢复 stateVersion；只有 Host 新的回滚边界可同时恢复该投影。
      // 普通迟到快照及旧回滚 epoch 仍拒绝，Guest 不更改任何领域版本。
      if (this.#projection && (projection.gameId !== this.#projection.gameId
        || (projection.stateVersion < this.#projection.stateVersion
          && !(sync?.rollbackRevision > this.#logRollbackRevision)))) return false;
      if (sync) {
        if (sync.start > this.#logs.length) {
          this.#send(E.RESYNC_REQUEST, { gameId: projection.gameId });
          return false;
        }
        this.#logs.length = sync.start;
        this.#logs.push(...structuredClone(sync.entries));
        this.#logRollbackRevision = sync.rollbackRevision;
      }
      this.#projection = structuredClone(projection);
      this.#projectionRevision += 1;
      this.notify();
      if (sync && sync.start + sync.entries.length < sync.total && this.#logRequestTimer === null) {
        this.#logRequestTimer = setTimeout(() => this.requestNextLogs(), NETWORK_LOG_REQUEST_INTERVAL_MS);
      }
      return true;
    }
    if (event.type === E.DECISION_REQUEST && session.state === S.IN_GAME) {
      const request = event.payload;
      const viewerId = session.matchSetup?.players.find((player) => player.controller.participantId === session.participantId)?.playerId;
      if (!request || typeof request.gameId !== "string" || !request.gameId || request.actorId !== viewerId
        || typeof request.requestId !== "string" || !request.requestId || !Number.isSafeInteger(request.stateVersion)
        || request.stateVersion < 0 || !Array.isArray(request.options)
        || !Number.isSafeInteger(request.min) || !Number.isSafeInteger(request.max)
        || request.min < 0 || request.max < request.min || request.options.length < request.min) return false;
      if (this.#projection && request.gameId !== this.#projection.gameId) return false;
      if (!this.#projection || request.stateVersion > this.#projection.stateVersion) {
        this.#send(E.RESYNC_REQUEST, { gameId: request.gameId });
        return false;
      }
      if (request.stateVersion < this.#projection.stateVersion) return false;
      if (this.#requests.has(request.requestId)) {
        if (JSON.stringify(this.#requests.get(request.requestId)) !== JSON.stringify(request)) return false;
        this.#send(E.DECISION_RECEIVED, { requestId: request.requestId });
        return true;
      }
      this.#requests.set(request.requestId, structuredClone(request));
      this.#send(E.DECISION_RECEIVED, { requestId: request.requestId });
      this.notify();
      return true;
    }
    if (event.type === E.DECISION_CANCELLED) {
      this.#requests.delete(event.payload?.requestId);
      this.notify();
      return true;
    }
    if (event.type === E.DECISION_ACCEPTED) {
      this.#requests.delete(event.payload?.requestId);
      this.notify();
      return true;
    }
    return false;
  }

  /*
  功能
  按展示恢复节奏拉取下一块历史。

  调用方
  receive 的日志恢复计时器。

  输入
  无。

  输出
  无。

  读取状态
  最新 projection 的总边界和本地展示副本长度。

  写入状态
  清除本次计时器。

  调用函数
  send。

  边界与不变量
  普通更新可以提前补齐历史；届时不再请求。节奏保证长历史恢复不会触发 Guest envelope 限速。
  */
  requestNextLogs() {
    this.#logRequestTimer = null;
    if (!this.#projection || this.#logs.length >= this.#projection.display?.logSync?.total) return;
    this.#send(E.LOG_REQUEST, { gameId: this.#projection.gameId, offset: this.#logs.length });
  }

  /*
  功能
  合并窗口内恢复请求，在预算恢复后发送最新投影。

  调用方
  receive 的 RESYNC_REQUEST 分支。

  输入
  已认证 participantId、剩余等待毫秒。

  输出
  无。

  读取状态
  当前成员的恢复计时器。

  写入状态
  每成员最多一个计时器。

  调用函数
  finishResync、setTimeout。

  边界与不变量
  限流只合并恢复构造；不永久丢掉正常的第二次恢复，不影响其它成员。
  */
  deferResync(participantId, delay) {
    if (this.#resyncTimers.has(participantId)) return;
    this.#resyncTimers.set(participantId, setTimeout(() => this.finishResync(participantId), delay));
  }

  /*
  功能
  完成被合并的恢复请求并更新时间水位。

  调用方
  deferResync 计时器。

  输入
  participantId。

  输出
  无。

  读取状态
  当前 Host capability 与成员有效性，经 publish 再检查。

  写入状态
  该成员恢复计时器和时间水位。

  调用函数
  publish、performance.now。

  边界与不变量
  reset 和成员撤销会取消计时器，不能向旧房间恢复。
  */
  finishResync(participantId) {
    this.#resyncTimers.delete(participantId);
    this.#resyncTimes.set(participantId, performance.now());
    this.publish(null, participantId, true);
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
    if (!pending || !this.#host || event.participantId !== pending.participantId) {
      const prior = this.#accepted.get(response?.requestId);
      if (prior && prior.type === event.type && prior.participantId === event.participantId && JSON.stringify(prior.payload) === JSON.stringify(response)) {
        this.#send(E.DECISION_ACCEPTED, { requestId: response.requestId }, event.participantId);
        return true;
      }
      return false;
    }
    const session = this.#getSession();
    const participant = session.participants[pending.participantId];
    const seat = session.matchSetup.players.find((player) => player.playerId === pending.view.actorId);
    if (!participant?.connected || participant.kicked || seat?.controller.type !== R.GUEST
      || seat.controller.participantId !== pending.participantId) return false;
    const { view } = pending;
    const expectedType = view.kind === "player-intent" ? E.PLAYER_INTENT : E.DECISION_RESPONSE;
    if (event.type !== expectedType || response.gameId !== view.gameId || response.actorId !== view.actorId
      || response.stateVersion !== view.stateVersion) return false;
    const state = this.#host.getState();
    const actor = state.players.find((player) => player.id === view.actorId);
    if (state.isDisposed || state.isGameOver || state.gameId !== view.gameId || state.stateVersion !== view.stateVersion || !actor?.alive) {
      this.#pending.delete(view.requestId);
      this.#send(E.DECISION_CANCELLED, { requestId: view.requestId }, pending.participantId);
      pending.resolve(view.kind === "player-intent" ? { kind: "cancelled" } : { status: "cancelled", selectedIds: [] });
      return false;
    }
    const ids = response.selectedIds;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return false;
    if (response.status === "declined") {
      if (!view.canDecline || ids.length) return false;
    } else if (response.status !== "selected" || ids.length < view.min || ids.length > view.max
      || ids.some((id) => !view.options.some((option) => option.optionId === id))) return false;
    const decoded = pending.decode(response);
    this.#accepted.set(view.requestId, { type: event.type, participantId: pending.participantId, payload: structuredClone(response) });
    this.#pending.delete(view.requestId);
    this.#send(E.DECISION_ACCEPTED, { requestId: view.requestId }, pending.participantId);
    pending.resolve(decoded);
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
    this.#send(request.kind === "player-intent" ? E.PLAYER_INTENT : E.DECISION_RESPONSE, {
      requestId, gameId: request.gameId, actorId: request.actorId, stateVersion: request.stateVersion,
      status: result.status, selectedIds: [...(result.selectedIds ?? [])]
    });
    this.notify();
    return true;
  }


  /*
功能
将 Session 席位控制投影同步到已有 runtime Player 元数据。

调用方
NetworkSession.publish/removeParticipant。

输入
无。

输出
无。

读取状态
唯一 session.matchSetup。

写入状态
经 Host capability 只更新控制元数据。

调用函数
host.syncControllers。

边界与不变量
不创建 Player，不写领域状态；Session 始终是 ownership owner。
*/

  syncControllers() {
    if (this.#host) this.#host.syncControllers(this.#getSession().matchSetup);
  }

  /*
功能
解除被撤销真人的挂起请求，允许原 router 转交 AI。

调用方
NetworkSession.removeParticipant。

输入
participantId。

输出
无。

读取状态
pending 的 participantId。

写入状态
删除该成员 pending、accepted ledger、日志拉取位置及恢复计时器。

调用函数
pending.reject。

边界与不变量
只中断该成员的决定；其他 Guest 的响应窗口保持有效。
*/

  cancelParticipant(participantId) {
    clearTimeout(this.#resyncTimers.get(participantId));
    this.#resyncTimers.delete(participantId);
    this.#resyncTimes.delete(participantId);
    this.#logContinuations.delete(participantId);
    // 撤销 ownership 后旧回答不再有补确认权；其他成员的 ledger 保留。
    for (const [requestId, accepted] of this.#accepted) {
      if (accepted.participantId === participantId) this.#accepted.delete(requestId);
    }
    for (const [requestId, pending] of this.#pending) {
      if (pending.participantId !== participantId) continue;
      this.#pending.delete(requestId);
      pending.reject(Object.assign(new Error("真人控制权已转交 AI"), { code: "CONTROLLER_CHANGED" }));
    }
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
    this.#accepted.clear();
    this.#requests.clear();
    this.#logs = [];
    this.#logRollbackRevision = 0;
    this.#resyncTimes.clear();
    for (const timer of this.#resyncTimers.values()) clearTimeout(timer);
    this.#resyncTimers.clear();
    clearTimeout(this.#logRequestTimer);
    this.#logRequestTimer = null;
    this.#logContinuations.clear();
    this.#projection = null;
    this.#host = null;
    this.notify();
  }
}
