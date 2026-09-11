import { NetworkGameChannel } from "./NetworkGameChannel.js";
import { MATCH_MODE } from "../application/match/MatchMode.js";
import { NETWORK_EVENT as E, NETWORK_ROLE as R, NETWORK_CAPABILITY_SENDER, normalizeConnectionInfo, normalizeNetworkEndpoint } from "./NetworkProtocol.js";
import { NETWORK_STATE as S, transitionNetworkState } from "./NetworkLobbyState.js";
import { createNetworkSetup, isNetworkSetupValid, isNetworkSelectionValid, finalizeNetworkSetup, projectNetworkMatch, normalizeParticipantDisplayName } from "./NetworkSetup.js";

export class NetworkSession {
  #data;
  #listeners = new Set();
  #capability;
  #random;
  #displayName;
  #generation = 0;
  #sequence = 0;
  #peerSequence = new Map();
  #unsubscribe = null;

  /*
功能
创建唯一游戏侧房间 authority。

调用方
NetworkFlow 与测试。

输入
Transport capability、Host RNG 与本端 displayName。

输出
NetworkSession。

读取状态
无。

写入状态
私有会话、展示名和通道。

调用函数
normalizeParticipantDisplayName、reset、NetworkGameChannel。

边界与不变量
Guest 不创建 Match authority；displayName 只作为 participant 展示 metadata。
*/
  constructor({ capability = null, random = Math.random, displayName = null } = {}) {
    this.#capability = capability;
    this.#random = random;
    this.#displayName = normalizeParticipantDisplayName(displayName);
    this.reset();
    this.gameChannel = new NetworkGameChannel({
      getSession: () => this.snapshot(), send: (type, payload, participantId) => this.send(type, payload, participantId)
    });
  }

  /*
功能
清除已关闭房间的成员与控制权。

调用方
constructor、close。

输入
无。

输出
无。

读取状态
无。

写入状态
data、序号。

调用函数
无。

边界与不变量
仅关闭或构造时重置，不重建对局角色。
*/
  reset() {
    this.#data = { mode: MATCH_MODE.NETWORK, state: S.IDLE, role: null, participantId: null,
      roomId: null, connectionInfo: null, revision: 0, maxHumanCount: 2, participants: {},
      setup: null, finalSetup: null, locked: false, error: null };
    this.#sequence = 0;
    this.#peerSequence.clear();
  }

  /*
功能
在进入房间前设置本端真人 participant 的展示名。

调用方
main 在用户名持久化成功后装配 NetworkFlow。

输入
displayName 候选值。

输出
无。

读取状态
无。

写入状态
私有 displayName。

调用函数
normalizeParticipantDisplayName。

边界与不变量
只更新后续 participant 展示 metadata，不修改 participantId、connectionId、角色或 ownership。
  */
  setDisplayName(displayName) {
    this.#displayName = normalizeParticipantDisplayName(displayName);
  }

  /*
功能
返回真人成员与席位控制权的隔离投影。

调用方
页面订阅、NetworkGameChannel 与 Host 管理入口。

输入
无。

输出
data-only room snapshot。

读取状态
私有 data。

写入状态
无。

调用函数
projectNetworkMatch。

边界与不变量
人数来自 authority；AI 不在成员集合，只有 Host 可开始。
*/
  snapshot() {
    const d = this.#data;
    const local = d.participants[d.participantId];
    const humans = Object.values(d.participants).filter((participant) => participant.connected && !participant.kicked);
    return structuredClone({
      mode: d.mode, state: d.state, role: d.role, participantId: d.participantId, roomId: d.roomId,
      revision: d.revision, connectionInfo: d.connectionInfo, error: d.error,
      participants: d.participants, currentHumanCount: humans.length, maxHumanCount: d.maxHumanCount,
      locked: d.locked, canStart: !d.locked && humans.length > 0
        && humans.every((participant) => participant.ready && isNetworkSelectionValid(d.setup, participant.participantId, participant.selection, d.participants)),
      candidates: d.setup?.candidates ?? [], seats: d.setup?.seats ?? [],
      localSelection: local?.selection ?? null, localReady: local?.ready ?? false,
      localGameReady: local?.gameReady ?? false,
      matchSetup: d.finalSetup ? projectNetworkMatch(d.finalSetup, d.participantId, d.participants) : null
    });
  }

  /*
功能
订阅会话更新并立即交付本地投影。

调用方
network 页面 coordinator。

输入
接收本地 snapshot 的订阅函数。

输出
unsubscribe 函数。

读取状态
私有 data。

写入状态
listeners。

调用函数
snapshot、Set.add/delete。

边界与不变量
页面不保存第二套可写 lobby 状态。
*/
  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  /*
功能
通知当前会话状态。

调用方
状态变更方法。

输入
无。

输出
无。

读取状态
listeners、data。

写入状态
无。

调用函数
snapshot、listeners。

边界与不变量
每位订阅者收到独立副本。
*/
  notify() {
    for (const listener of this.#listeners) {
      listener(this.snapshot());
    }
  }

  /*
功能
通过合法 transition 更新页面状态。

调用方
会话 lifecycle 与同步。

输入
目标 state。

输出
无。

读取状态
当前 state。

写入状态
私有 state。

调用函数
transitionNetworkState。

边界与不变量
UI 只能消费状态，不能自行推测准备阶段。
*/
  move(state) {
    this.#data.state = transitionNetworkState(this.#data.state, state);
  }

  /*
功能
在 authority 层限制房间管理入口。

调用方
Host-only 管理、选择确认与广播入口。

输入
无。

输出
无；非 Host 抛错。

读取状态
role、state。

写入状态
无。

调用函数
无。

边界与不变量
Guest 即使直接调用方法也不能管理成员或开局。
*/
  assertHost() {
    if (this.#data.role !== R.HOST || ![S.SELECTING, S.WAITING_REMOTE, S.LOADING_GAME, S.IN_GAME].includes(this.#data.state)) {
      throw Object.assign(new Error("仅 Host 可管理房间"), { code: "HOST_ONLY" });
    }
  }

  /*
功能
创建或加入房间并隔离迟到连接结果。

调用方
NetworkFlow 创建或加入按钮。

输入
HOST/GUEST 与加入地址。

输出
连接准备 Promise。

读取状态
capability、generation。

写入状态
房间身份、Host 成员、setup、订阅。

调用函数
normalizeNetworkEndpoint、normalizeConnectionInfo、createNetworkSetup、move、notify。

边界与不变量
只有 Host 生成候选和席位；未连接的 Guest 不伪造成员；Host 连接地址 metadata 完整进入 snapshot。
*/
  async open(role, endpoint = null) {
    if (this.#data.state !== S.IDLE) throw new Error("请先关闭当前房间");
    if (!Object.values(R).includes(role)) throw new Error("无效会话身份");
    const generation = ++this.#generation;
    const d = this.#data;
    d.role = role;
    d.roomId = role === R.HOST ? crypto.randomUUID() : null;
    this.move(role === R.HOST ? S.CREATING : S.JOINING);
    this.notify();
    try {
      if (role === R.GUEST && !this.#capability?.joinRoom) throw new Error("连接功能尚未接入");
      const connectionInfo = role === R.GUEST ? normalizeNetworkEndpoint(endpoint ?? {}) : null;
      const result = role === R.HOST
        ? await this.#capability?.createRoom?.({ roomId: d.roomId })
        : await this.#capability.joinRoom(connectionInfo);
      if (generation !== this.#generation) return;
      if (result?.roomId) d.roomId = result.roomId;
      d.connectionInfo = role === R.HOST
        ? result?.connectionInfo ? normalizeConnectionInfo(result.connectionInfo) : null : connectionInfo;
      if (!d.roomId) throw new Error("缺少房间标识");
      this.move(S.WAITING_PEER);
      if (role === R.HOST) {
        d.participantId = crypto.randomUUID();
        // Host 没有 Transport remoteAddress 时，用创建房间已有的 LAN host 作为连接来源 metadata；IP 不参与身份认证或权限。
        d.participants[d.participantId] = { participantId: d.participantId, role: R.HOST, guestOrdinal: null,
          connectionId: null, remoteAddress: result?.remoteAddress ?? d.connectionInfo?.host ?? null, displayName: this.#displayName,
          connected: true, kicked: false, selection: null, ready: false, gameReady: false };
        d.setup = createNetworkSetup(this.#random);
        this.move(S.SELECTING);
      }
      this.#unsubscribe = this.#capability?.subscribe?.((event) => this.receive(event, generation)) ?? null;
      this.notify();
    } catch (error) {
      if (generation === this.#generation) this.disconnect(error.message);
    }
  }

  /*
功能
接收 Transport 注入的连接并分配稳定真人身份。

调用方
Transport capability、receive 的认证连接通知。

输入
已认证 connectionId、可选 remoteAddress 与可选 displayName。

输出
{ok, participantId} 或稳定错误 code。

读取状态
成员、上限、锁房标志。

写入状态
仅新 Guest 成员与其展示 metadata。

调用函数
assertHost、publish、normalizeParticipantDisplayName。

边界与不变量
身份只由 connectionId 建立，displayName 仅进入展示 metadata；不采信 Guest 自报 IP；不重编号现存成员，锁房后不再加入。
*/
  addParticipant({ connectionId, remoteAddress = null, displayName = null }) {
    this.assertHost();
    const d = this.#data;
    if (d.locked) return { ok: false, code: "ROOM_LOCKED" };
    if (typeof connectionId !== "string" || !connectionId) return { ok: false, code: "INVALID_CONNECTION" };
    const humans = Object.values(d.participants);
    const normalizedDisplayName = normalizeParticipantDisplayName(displayName);
    const existing = humans.find((participant) => participant.connectionId === connectionId);
    if (existing) {
      if (normalizedDisplayName && existing.displayName !== normalizedDisplayName) {
        existing.displayName = normalizedDisplayName;
        this.publish(E.ROLE_POOL_ASSIGNED);
      }
      return { ok: true, participantId: existing.participantId };
    }
    if (humans.length >= d.maxHumanCount) return { ok: false, code: "ROOM_FULL" };
    let guestOrdinal = 1;
    while (humans.some((participant) => participant.guestOrdinal === guestOrdinal)) guestOrdinal += 1;
    const participantId = crypto.randomUUID();
    d.participants[participantId] = { participantId, role: R.GUEST, guestOrdinal, connectionId,
      remoteAddress: typeof remoteAddress === "string" ? remoteAddress : null, displayName: normalizedDisplayName,
      connected: true, kicked: false, selection: null, ready: false, gameReady: false };
    this.#peerSequence.delete(connectionId);
    d.error = null;
    this.publish(E.ROLE_POOL_ASSIGNED);
    return { ok: true, participantId };
  }

  /*
功能
由 Host 设置当前房间真人上限。

调用方
Host 房间管理 UI。

输入
2、3、4 或 5。

输出
稳定操作结果。

读取状态
当前真人数、locked。

写入状态
maxHumanCount。

调用函数
assertHost、publish。

边界与不变量
不得降低到现有人数以下或自动踢人。
*/
  setMaxHumanCount(maxHumanCount) {
    this.assertHost();
    if (this.#data.locked) return { ok: false, code: "ROOM_LOCKED" };
    if (![2, 3, 4, 5].includes(maxHumanCount)) return { ok: false, code: "INVALID_CAPACITY" };
    if (maxHumanCount < Object.keys(this.#data.participants).length) return { ok: false, code: "CAPACITY_BELOW_COUNT" };
    this.#data.maxHumanCount = maxHumanCount;
    this.publish(E.SELECTION_CHANGED);
    return { ok: true };
  }

  /*
功能
发送按成员定向的 protocol envelope。

调用方
publish、Guest 意图与 NetworkGameChannel。

输入
事件、data-only payload、目标 participantId。

输出
无。

读取状态
房间、身份、revision、capability。

写入状态
发送序号。

调用函数
capability.send、markParticipantDisconnected、disconnect。

边界与不变量
定向消息由 Transport 按接收人路由；发送失败只接管对应 Guest，旧房间错误失效。
*/
  send(type, payload = {}, recipientParticipantId = null) {
    const generation = this.#generation;
    const d = this.#data;
    const envelope = { type, roomId: d.roomId, sender: d.role, participantId: d.participantId,
      recipientParticipantId, sequence: ++this.#sequence, revision: d.revision, payload: structuredClone(payload) };
/*
功能
收束当前房间的发送错误。

调用方
send 的同步异常或 Promise rejection。

输入
Transport error。

输出
无。

读取状态
generation、role、接收成员。

写入状态
对应成员控制权或会话终止状态。

调用函数
markParticipantDisconnected、disconnect。

边界与不变量
旧 generation 的失败忽略；定向发送失败不终止其他真人。
*/
    const failed = (error) => {
      if (generation !== this.#generation || [S.IDLE, S.DISCONNECTED].includes(d.state)) return;
      if (d.role === R.HOST && recipientParticipantId) this.markParticipantDisconnected(recipientParticipantId);
      else this.disconnect(error.message);
    };
    try { Promise.resolve(this.#capability?.send?.(envelope)).catch(failed); }
    catch (error) { failed(error); }
  }

  /*
功能
广播 Host 房间快照并推进既有准备屏障。

调用方
Host 成员、选择、确认、开始和就绪变更。

输入
lobby event type。

输出
无。

读取状态
成员 ready/gameReady 与 finalSetup。

写入状态
revision、state；同步 runtime 控制元数据。

调用函数
move、gameChannel.syncControllers、send、notify。

边界与不变量
确认不自动开局；锁房后所有有效真人 Game Ready 才进入 IN_GAME。
*/
  publish(type) {
    this.assertHost();
    const d = this.#data;
    const humans = Object.values(d.participants).filter((participant) => participant.connected && !participant.kicked);
    if (d.locked) {
      this.move(humans.every((participant) => participant.gameReady) ? S.IN_GAME : S.LOADING_GAME);
    } else this.move(d.participants[d.participantId].ready ? S.WAITING_REMOTE : S.SELECTING);
    d.revision += 1;
    this.gameChannel.syncControllers();
    for (const participant of humans) {
      if (participant.role !== R.GUEST) continue;
      this.send(d.state === S.IN_GAME ? E.MATCH_START : type, {
        setup: d.setup, participants: d.participants, maxHumanCount: d.maxHumanCount,
        locked: d.locked, finalSetup: d.finalSetup
      }, participant.participantId);
    }
    this.notify();
  }

  /*
功能
校验 Transport 认证身份与逐连接序号后分派消息。

调用方
Transport subscribe callback 与定向集成测试。

输入
envelope；可选订阅 generation。

输出
是否接收；加入可返回 capacity 结果。

读取状态
connectionId 映射、成员身份、revision。

写入状态
已认证连接序号与经入口提交的房间状态。

调用函数
addParticipant、selectFor、confirmFor、acceptSnapshot、gameChannel.receive、publish。

边界与不变量
connectionId 必须由 capability 注入而非 payload；无元数据的既有 Transport 使用默认连接标识；PARTICIPANT_HELLO 只按已认证 connectionId 补充 displayName。
*/
  receive(event, generation = this.#generation) {
    const d = this.#data;
    if (generation !== this.#generation || !d.roomId || event?.roomId !== d.roomId || d.state === S.DISCONNECTED) return false;
    const connectionId = event.connectionId ?? "default";
    const lifecycle = event.sender === NETWORK_CAPABILITY_SENDER && [E.PEER_CONNECTED, E.DISCONNECTED, E.ERROR].includes(event.type);
    try {
      if (lifecycle) {
        if (event.type === E.PEER_CONNECTED) {
          return d.role === R.HOST
            ? this.addParticipant({
              connectionId,
              remoteAddress: event.payload?.remoteAddress,
              displayName: event.payload?.displayName
            })
            : true;
        }
        const participant = Object.values(d.participants).find((entry) => entry.connectionId === connectionId);
        if (d.role === R.HOST && event.type === E.DISCONNECTED) {
          return participant ? this.markParticipantDisconnected(participant.participantId).ok : false;
        }
        this.disconnect(event.payload?.message ?? "Host authority 或连接已关闭");
        return true;
      }
      if (event.sender !== (d.role === R.HOST ? R.GUEST : R.HOST)
        || !Number.isSafeInteger(event.sequence) || event.sequence <= (this.#peerSequence.get(connectionId) ?? 0)) return false;
      const participant = d.role === R.HOST
        ? Object.values(d.participants).find((entry) => entry.connectionId === connectionId && entry.connected && !entry.kicked) : null;
      if (d.role === R.HOST && (!participant || (event.participantId != null && event.participantId !== participant.participantId))) return false;
      if (d.role === R.GUEST && d.participantId && event.recipientParticipantId && event.recipientParticipantId !== d.participantId) return false;
      if (event.type === E.DISCONNECTED && d.role === R.GUEST) {
        this.disconnect(event.payload?.message ?? "已离开房间");
        return true;
      }
      if (event.type === E.PARTICIPANT_HELLO && d.role === R.HOST) {
        const displayName = normalizeParticipantDisplayName(event.payload?.displayName);
        if (displayName && participant.displayName !== displayName) {
          participant.displayName = displayName;
          this.publish(E.ROLE_POOL_ASSIGNED);
        }
        return true;
      }
      if ([E.GAME_SNAPSHOT, E.DECISION_REQUEST, E.DECISION_RECEIVED, E.DECISION_RESPONSE, E.DECISION_ACCEPTED, E.DECISION_CANCELLED, E.RESYNC_REQUEST, E.PLAYER_INTENT].includes(event.type)) {
        const accepted = this.gameChannel.receive({ ...event, participantId: participant?.participantId ?? event.participantId });
        // 同步 callback 可先完成更高序号的恢复消息；外层返回不得倒退已提交水位。
        if (accepted) this.#peerSequence.set(connectionId, Math.max(event.sequence, this.#peerSequence.get(connectionId) ?? 0));
        return accepted;
      }
      this.#peerSequence.set(connectionId, event.sequence);
      if (d.role === R.GUEST) return this.acceptSnapshot(event);
      if (event.type === E.SELECTION_CHANGED) this.selectFor(participant.participantId, event.payload);
      else if (event.type === E.SELECTION_CONFIRMED) this.confirmFor(participant.participantId, event.payload);
      else if (event.type === E.GAME_READY && d.locked && !participant.gameReady) {
        participant.gameReady = true;
        this.publish(E.GAME_READY);
      } else return false;
      return true;
    } catch (error) {
      d.error = error.message;
      this.notify();
      return false;
    }
  }

  /*
功能
接收 Host 的完整房间权威投影。

调用方
Guest receive。

输入
已认证 Host envelope。

输出
是否接收。

读取状态
旧 setup、revision、locked、finalSetup。

写入状态
Guest 房间只读副本。

调用函数
isNetworkSetupValid、finalizeNetworkSetup、send、move、notify。

边界与不变量
不合并 Guest 自有状态；锁房后固定角色与席位，只允许 Guest controller 转 AI；displayName 差异只触发认证连接上的补报。
*/
  acceptSnapshot(event) {
    const d = this.#data;
    if (![E.ROLE_POOL_ASSIGNED, E.SELECTION_CHANGED, E.PEER_READY, E.GAME_READY, E.MATCH_START].includes(event.type)
      || !Number.isSafeInteger(event.revision) || event.revision <= d.revision) return false;
    const p = structuredClone(event.payload);
    const localId = d.participantId ?? event.recipientParticipantId;
    const humans = Object.values(p.participants ?? {});
    if (!localId || !p.participants?.[localId]?.connected || p.participants[localId].kicked
      || p.participants[localId].role !== R.GUEST || ![2, 3, 4, 5].includes(p.maxHumanCount)
      || humans.length > p.maxHumanCount || humans.filter((entry) => entry.role === R.HOST).length !== 1
      || !isNetworkSetupValid(p.setup) || (d.setup && JSON.stringify(d.setup) !== JSON.stringify(p.setup))) return false;
    if (d.locked && !p.locked) return false;
    if (p.locked && !d.locked) {
      const expected = finalizeNetworkSetup(p.setup, p.participants);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(p.finalSetup)) return false;
    } else if (d.locked) {
      if (p.finalSetup?.players?.length !== d.finalSetup.players.length) return false;
      for (let index = 0; index < d.finalSetup.players.length; index += 1) {
        const old = d.finalSetup.players[index], next = p.finalSetup.players[index];
        const transfer = old.controller.type === R.GUEST && next.controller.type === "AI"
          && next.controller.participantId === null && !p.participants[old.controller.participantId]?.connected;
        if (JSON.stringify({ ...old, controller: null }) !== JSON.stringify({ ...next, controller: null })
          || (!transfer && JSON.stringify(old.controller) !== JSON.stringify(next.controller))) return false;
      }
    } else if (p.finalSetup != null) return false;
    const allGameReady = humans.filter((entry) => entry.connected && !entry.kicked).every((entry) => entry.gameReady);
    if (event.type === E.MATCH_START && (!p.locked || !allGameReady)) return false;
    Object.assign(d, { participantId: localId, setup: p.setup, participants: p.participants,
      maxHumanCount: p.maxHumanCount, locked: p.locked, finalSetup: p.finalSetup, revision: event.revision, error: null });
    // 无元数据旧 Transport 可在首次成员快照后按已认证 connectionId 补报 displayName；到齐后不会再重发。
    if (this.#displayName && d.participants[localId]?.displayName !== this.#displayName) {
      this.send(E.PARTICIPANT_HELLO, { displayName: this.#displayName });
    }
    if (d.state === S.WAITING_PEER) this.move(S.SELECTING);
    this.move(event.type === E.MATCH_START ? S.IN_GAME : d.locked ? S.LOADING_GAME
      : d.participants[localId].ready ? S.WAITING_REMOTE : S.SELECTING);
    this.notify();
    return true;
  }

  /*
功能
提交本地真人选角意图。

调用方
NetworkFlow 角色与席位按钮。

输入
characterId、teamId、seatId。

输出
无；非法抛错。

读取状态
local participant、setup。

写入状态
Host 提交或 Guest 发消息。

调用函数
selectFor、send、isNetworkSelectionValid。

边界与不变量
Guest 不乐观写入，也不能覆盖其他成员。
*/
  select(selection) {
    const d = this.#data;
    if (d.locked || d.participants[d.participantId]?.ready
      || !isNetworkSelectionValid(d.setup, d.participantId, selection, d.participants)) throw new Error("请选择自己的角色与空闲席位");
    if (d.role === R.HOST) this.selectFor(d.participantId, selection);
    else this.send(E.SELECTION_CHANGED, selection);
  }

  /*
功能
由 Host 唯一更新一位真人的 selection。

调用方
Host 本地 select 与已认证 Guest 选择消息。

输入
已认证 participantId 和选择意图。

输出
无；冲突抛错。

读取状态
setup、成员、ready。

写入状态
该成员 selection。

调用函数
assertHost、isNetworkSelectionValid、publish。

边界与不变量
只拷贝三个正式选择字段；身份来自发送连接而非意图。
*/
  selectFor(participantId, selection) {
    this.assertHost();
    const d = this.#data;
    const participant = d.participants[participantId];
    if (d.locked || participant?.ready || !isNetworkSelectionValid(d.setup, participantId, selection, d.participants)) throw new Error("席位或角色已占用，或选择已确认");
    participant.selection = { characterId: selection.characterId, teamId: selection.teamId, seatId: selection.seatId };
    d.error = null;
    this.publish(E.SELECTION_CHANGED);
  }

  /*
功能
确认当前本地选择。

调用方
NetworkFlow 确认按钮。

输入
无。

输出
无。

读取状态
本地成员 selection。

写入状态
经 Host 写 ready。

调用函数
confirmFor、send。

边界与不变量
只确认 authority 已接收的选项，不自动开始。
*/
  confirm() {
    const d = this.#data;
    if (d.role === R.HOST) this.confirmFor(d.participantId, d.participants[d.participantId]?.selection);
    else this.send(E.SELECTION_CONFIRMED, d.participants[d.participantId]?.selection);
  }

  /*
功能
由 Host 重验选择后通过真人确认屏障。

调用方
Host 本地 confirm 与已认证 Guest 确认消息。

输入
认证身份与确认 selection。

输出
无；过期抛错。

读取状态
成员与 setup。

写入状态
该成员 ready。

调用函数
assertHost、isNetworkSelectionValid、publish。

边界与不变量
所有真人确认只产生 canStart，Host 仍需主动开始。
*/
  confirmFor(participantId, selection) {
    this.assertHost();
    const d = this.#data;
    const participant = d.participants[participantId];
    if (d.locked || !isNetworkSelectionValid(d.setup, participantId, selection, d.participants)
      || JSON.stringify(selection) !== JSON.stringify(participant.selection)) throw new Error("确认内容已过期，请重新选择");
    participant.ready = true;
    this.publish(E.PEER_READY);
  }

  /*
功能
由 Host 锁定真人成员并为余下席位补 AI。

调用方
Host NetworkFlow 开始按钮。

输入
无。

输出
操作结果。

读取状态
canStart、setup、成员确认。

写入状态
locked、finalSetup。

调用函数
assertHost、finalizeNetworkSetup、publish。

边界与不变量
保留第一道确认屏障；不调用 GameLoop，随后进入现有 Game Ready。
*/
  start() {
    this.assertHost();
    if (!this.snapshot().canStart) return { ok: false, code: this.#data.locked ? "ROOM_LOCKED" : "NOT_READY" };
    this.#data.finalSetup = finalizeNetworkSetup(this.#data.setup, this.#data.participants);
    this.#data.locked = true;
    this.publish(E.PEER_READY);
    return { ok: true };
  }

  /*
功能
记录本端已完成正式 UI 初始化。

调用方
NetworkFlow 完成 Host Match 或 Guest UI 初始化后。

输入
无。

输出
无；重复幂等。

读取状态
locked、local gameReady。

写入状态
本地 Host gameReady 或远端意图。

调用函数
publish、send。

边界与不变量
只在原 LOADING_GAME 阶段生效；所有有效真人就绪才 MATCH_START。
*/
  gameReady() {
    const d = this.#data;
    if (!d.locked || d.state !== S.LOADING_GAME || d.participants[d.participantId]?.gameReady) return;
    if (d.role === R.HOST) {
      d.participants[d.participantId].gameReady = true;
      this.publish(E.GAME_READY);
    } else this.send(E.GAME_READY);
  }

  /*
功能
将指定 Guest 断线收口到成员失效和 AI 接管。

调用方
Transport capability、定向发送失败与 receive。

输入
Transport 已认证的 participantId。

输出
稳定操作结果。

读取状态
成员和锁房状态。

写入状态
经 removeParticipant 更新成员和 controller。

调用函数
assertHost、removeParticipant。

边界与不变量
Host 消失必须终止房间，不能迁移 Host authority。
*/
  markParticipantDisconnected(participantId) {
    this.assertHost();
    return this.removeParticipant(participantId, false);
  }

  /*
功能
由 Host 踢出 Guest 并撤销其决策权限。

调用方
Host 房间管理 UI。

输入
目标 participantId。

输出
稳定操作结果。

读取状态
成员。

写入状态
经 removeParticipant 更新成员和 controller。

调用函数
assertHost、send、removeParticipant。

边界与不变量
Host 不可踢自己；只发送游戏侧移除通知，不关闭 Socket。
*/
  kickParticipant(participantId) {
    this.assertHost();
    const participant = this.#data.participants[participantId];
    if (!participant || participant.role === R.HOST) return { ok: false, code: participant ? "CANNOT_REMOVE_HOST" : "UNKNOWN_PARTICIPANT" };
    this.send(E.DISCONNECTED, { message: "已被 Host 移出房间" }, participantId);
    return this.removeParticipant(participantId, true);
  }

  /*
功能
统一释放大厅成员或将锁定席位控制权交给 AI。

调用方
markParticipantDisconnected、kickParticipant。

输入
目标身份、是否踢出。

输出
稳定操作结果。

读取状态
participant、finalSetup。

写入状态
成员连接状态、controller ownership。

调用函数
assertHost、gameChannel.syncControllers/cancelParticipant、publish。

边界与不变量
不删除或重建 Player；先切控制元数据再解除等待，角色和全部领域状态保持原样。
*/
  removeParticipant(participantId, kicked) {
    this.assertHost();
    const d = this.#data, participant = d.participants[participantId];
    if (!participant || participant.role === R.HOST) return { ok: false, code: participant ? "CANNOT_REMOVE_HOST" : "UNKNOWN_PARTICIPANT" };
    if (!participant.connected) return { ok: true };
    participant.connected = false;
    participant.kicked = kicked;
    if (d.locked) {
      d.finalSetup = { ...d.finalSetup, players: d.finalSetup.players.map((player) =>
        player.controller.participantId === participantId
          ? { ...player, controller: { type: "AI", participantId: null, displayName: null } } : player) };
      this.gameChannel.syncControllers();
      this.gameChannel.cancelParticipant(participantId);
    } else delete d.participants[participantId];
    this.publish(E.SELECTION_CHANGED);
    this.gameChannel.publish();
    return { ok: true };
  }

  /*
功能
复用唯一游戏消息通道请求真人决定。

调用方
PlayerControlRouter 的远端 decision capability。

输入
Host data-only request。

输出
结果 Promise。

读取状态
gameChannel。

写入状态
通道 pending。

调用函数
NetworkGameChannel.request。

边界与不变量
合法性仍交既有 canonical Action，Session 不建立 legality checker。
*/
  requestDecision(request) {
    return this.gameChannel.request(request);
  }

  /*
功能
终止失去 Host authority 或本端失败的房间。

调用方
本端 authority 故障、Guest 失去 Host 连接与 NetworkFlow 错误收束。

输入
错误说明。

输出
无。

读取状态
state。

写入状态
连接状态、error、通道等待。

调用函数
gameChannel.reset、move、notify。

边界与不变量
Guest 单独离线使用成员接管入口；此入口代表整端会话终止。
*/
  disconnect(message = "连接已断开") {
    const d = this.#data;
    if (d.state === S.IDLE) return;
    this.gameChannel.reset();
    for (const participant of Object.values(d.participants)) participant.connected = false;
    d.error = message;
    this.move(S.DISCONNECTED);
    this.notify();
  }

  /*
功能
关闭房间并使旧订阅和异步回执失效。

调用方
NetworkFlow 导航、取消与页面销毁。

输入
无。

输出
无。

读取状态
capability、unsubscribe。

写入状态
generation、全部 lobby 数据。

调用函数
gameChannel.reset、unsubscribe、capability.close、reset、notify。

边界与不变量
不写持久化或规则；新的 open 才重新生成房间。
*/
  close() {
    this.#generation += 1;
    this.gameChannel.reset();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#capability?.close?.();
    this.reset();
    this.notify();
  }
}
