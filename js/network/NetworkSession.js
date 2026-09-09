import { NetworkGameChannel } from "./NetworkGameChannel.js";
import { MATCH_MODE } from "../application/match/MatchMode.js";
import { NETWORK_EVENT as E, NETWORK_ROLE as R, NETWORK_CAPABILITY_SENDER } from "./NetworkProtocol.js";
import { NETWORK_STATE as S, transitionNetworkState } from "./NetworkLobbyState.js";
import { createNetworkSetup, isNetworkSetupValid, isNetworkSelectionValid, finalizeNetworkSetup, projectNetworkMatch } from "./NetworkSetup.js";

export class NetworkSession {
  #data;
  #listeners = new Set();
  #capability;
  #random;
  #generation = 0;
  #sequence = 0;
  #peerSequence = 0;
  #unsubscribe = null;
  #abort = new AbortController();

  /*
功能
创建无 Transport 实现的游戏侧联机会话 owner。

调用方
network 页面 composition 与测试。

输入
可选 capability、确定性 random。

输出
NetworkSession。

读取状态
无。

写入状态
私有会话、订阅与随机源。

调用函数
reset。

边界与不变量
真实连接必须由外部 capability 通知，生产代码不模拟对端。
*/
  constructor({ capability = null, random = Math.random } = {}) {
    this.#capability = capability;
    this.#random = random;
    this.reset();
    this.gameChannel = new NetworkGameChannel({
      getSession: () => this.snapshot(), send: (type, payload) => this.send(type, payload)
    });
  }

  /*
功能
重置关闭房间后的游戏侧状态。

调用方
constructor、close。

输入
无。

输出
无。

读取状态
无。

写入状态
私有 data 与消息序号。

调用函数
无。

边界与不变量
仅关闭房间清除角色池；重绘与重连不调用。
*/
  reset() {
    this.#data = { mode: MATCH_MODE.NETWORK, state: S.IDLE, role: null, roomId: null,
      revision: 0, peerConnected: false, setup: null, selections: { HOST: null, GUEST: null },
      ready: { HOST: false, GUEST: false }, gameReady: { HOST: false, GUEST: false },
      finalSetup: null, error: null };
    this.#sequence = 0;
    this.#peerSequence = 0;
  }

  /*
功能
提供仅含本地候选与公开选角事实的隔离快照。

调用方
NetworkSquadSelectionView 与页面 coordinator。

输入
无。

输出
可独立修改而不影响 authority 的 snapshot。

读取状态
私有 data。

写入状态
无。

调用函数
structuredClone、projectNetworkMatch。

边界与不变量
不得把对方四名候选提供给 View。
*/
  snapshot() {
    const d = this.#data;
    const peer = d.role === R.HOST ? R.GUEST : R.HOST;
    return structuredClone({
      mode: d.mode, state: d.state, role: d.role, roomId: d.roomId, revision: d.revision,
      peerConnected: d.peerConnected, error: d.error,
      candidates: d.peerConnected ? d.setup?.pools[d.role] ?? [] : [],
      seats: d.setup?.seats ?? [], localSelection: d.selections[d.role] ?? null,
      remoteSelection: d.selections[peer], localReady: d.ready[d.role] ?? false,
      remoteReady: d.ready[peer], localGameReady: d.gameReady[d.role] ?? false,
      remoteGameReady: d.gameReady[peer],
      matchSetup: d.finalSetup ? projectNetworkMatch(d.finalSetup, d.role) : null
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
创建房间或请求加入，隔离迟到的异步连接结果。

调用方
NetworkEntryView coordinator。

输入
HOST/GUEST；加入地址。

输出
连接请求完成 Promise。

读取状态
capability 与 generation。

写入状态
房间 lifecycle、role、roomId、订阅。

调用函数
capability.createRoom/joinRoom/subscribe、move、notify。

边界与不变量
无 capability 时 HOST 等待、GUEST 报未接入；不得宣称真实连接成功。
*/
  async open(role, address = "") {
    if (this.#data.state !== S.IDLE) throw new Error("请先关闭当前房间");
    if (!Object.values(R).includes(role)) throw new Error("无效会话身份");
    const generation = ++this.#generation;
    this.#abort = new AbortController();
    this.#data.role = role;
    this.#data.roomId = role === R.HOST ? crypto.randomUUID() : null;
    this.move(role === R.HOST ? S.CREATING : S.JOINING);
    this.notify();
    try {
      if (role === R.GUEST && !this.#capability?.joinRoom) throw new Error("连接功能尚未接入");
      const result = role === R.HOST
        ? await this.#capability?.createRoom?.({ roomId: this.#data.roomId })
        : await this.#capability.joinRoom({ address: address.trim() });
      if (generation !== this.#generation) return;
      if (result?.roomId) this.#data.roomId = result.roomId;
      if (!this.#data.roomId) throw new Error("缺少房间标识");
      this.move(S.WAITING_PEER);
      this.#unsubscribe = this.#capability?.subscribe?.((event) => this.receive(event, generation)) ?? null;
      this.notify();
    } catch (error) {
      if (generation === this.#generation) this.disconnect(error.message);
    }
  }

  /*
功能
封装唯一 protocol envelope 并交给 capability。

调用方
选择、Ready 与 Host 广播。

输入
protocol type 与 data-only payload。

输出
无。

读取状态
房间、role、revision、generation。

写入状态
本地发送 sequence。

调用函数
capability.send、disconnect。

边界与不变量
send 失败必须终止等待；异步失败不得污染新房间。
*/
  send(type, payload = {}) {
    const generation = this.#generation;
    const envelope = { type, roomId: this.#data.roomId, sender: this.#data.role,
      sequence: ++this.#sequence, revision: this.#data.revision, payload: structuredClone(payload) };
    try {
      Promise.resolve(this.#capability?.send?.(envelope)).catch((error) => {
        if (generation === this.#generation) this.disconnect(error.message);
      });
    } catch (error) {
      this.disconnect(error.message);
    }
  }

  /*
功能
提交 Host 快照并同步到 Guest。

调用方
Host 连接、选择与准备变更。

输入
protocol type。

输出
无。

读取状态
全部权威 lobby data。

写入状态
revision、state。

调用函数
move、send、notify。

边界与不变量
双方确认才产生 final setup，双方 Game Ready 才进入 IN_GAME。
*/
  publish(type) {
    const d = this.#data;
    if (d.ready.HOST && d.ready.GUEST && !d.finalSetup) {
      d.finalSetup = finalizeNetworkSetup(d.setup, d.selections, d.ready);
    }
    if (d.finalSetup) this.move(d.gameReady.HOST && d.gameReady.GUEST ? S.IN_GAME : S.LOADING_GAME);
    else this.move(d.ready[d.role] ? S.WAITING_REMOTE : S.SELECTING);
    d.revision += 1;
    this.send(d.state === S.IN_GAME ? E.MATCH_START : type, {
      setup: d.setup, selections: d.selections, ready: d.ready, gameReady: d.gameReady, finalSetup: d.finalSetup
    });
    this.notify();
  }

  /*
功能
处理已认证对端语义，拒绝旧房间、重复序号与越权命令。

调用方
Transport subscribe；测试注入。

输入
envelope 与订阅 generation。

输出
有效消息 true，否则 false。

读取状态
房间、角色、revision、selection。

写入状态
合法 lobby data。

调用函数
publish、acceptSnapshot、selectFor、confirmFor、disconnect。

边界与不变量
Guest 不分池；Host 重验 Guest 席位与确认内容；重复连接不重洗。
*/
  receive(event, generation = this.#generation) {
    const d = this.#data;
    if (generation !== this.#generation || !d.roomId || event?.roomId !== d.roomId) return false;
    const lifecycle = event.sender === NETWORK_CAPABILITY_SENDER && [E.PEER_CONNECTED, E.DISCONNECTED, E.ERROR].includes(event.type);
    if (!lifecycle) {
      if (event.sender !== (d.role === R.HOST ? R.GUEST : R.HOST)
        || !Number.isSafeInteger(event.sequence) || event.sequence <= this.#peerSequence
        || event.type === E.PEER_CONNECTED) return false;
      this.#peerSequence = event.sequence;
    }
    try {
      if (event.type === E.DISCONNECTED || event.type === E.ERROR) {
        this.disconnect(event.payload?.message ?? "另一名玩家已断开连接");
        return true;
      }
      if (event.type === E.PEER_CONNECTED) {
        if (d.peerConnected || d.finalSetup) return false;
        d.peerConnected = true;
        d.error = null;
        this.#abort = new AbortController();
        if (d.role === R.HOST) {
          d.setup ??= createNetworkSetup(this.#random);
          this.publish(E.ROLE_POOL_ASSIGNED);
        }
        return true;
      }
      if ([E.GAME_SNAPSHOT, E.DECISION_REQUEST, E.DECISION_RESPONSE, E.DECISION_CANCELLED, E.PLAYER_INTENT].includes(event.type)) {
        return this.gameChannel.receive(event);
      }
      if (d.role === R.GUEST) return this.acceptSnapshot(event);
      if (!d.peerConnected) return false;
      if (event.type === E.SELECTION_CHANGED) this.selectFor(R.GUEST, event.payload);
      else if (event.type === E.SELECTION_CONFIRMED) this.confirmFor(R.GUEST, event.payload);
      else if (event.type === E.GAME_READY && d.finalSetup) {
        d.gameReady.GUEST = true;
        this.publish(E.GAME_READY);
      } else return false;
      return true;
    } catch (error) {
      // 非法对端命令不改变已确认结果；错误反馈携带权威快照，允许修正过时的席位选择。
      d.error = error.message;
      if (d.role === R.HOST && d.setup && !d.finalSetup) this.publish(E.SELECTION_CHANGED);
      else this.notify();
      return false;
    }
  }

  /*
功能
验证并接收 Host 权威选角快照。

调用方
Guest receive。

输入
Host envelope。

输出
是否接收。

读取状态
当前 revision 与固定角色池。

写入状态
Guest 的 lobby 副本与状态。

调用函数
finalizeNetworkSetup、move、notify。

边界与不变量
固定 pools 不可重分；final setup 必须由同一快照的合法选择和 Ready 推导。
*/
  acceptSnapshot(event) {
    const d = this.#data;
    if (![E.ROLE_POOL_ASSIGNED, E.SELECTION_CHANGED, E.PEER_READY, E.GAME_READY, E.MATCH_START].includes(event.type)
      || !Number.isSafeInteger(event.revision) || event.revision <= d.revision) return false;
    if (d.finalSetup && !d.peerConnected) return false;
    const p = structuredClone(event.payload);
    if (!isNetworkSetupValid(p.setup)
      || (d.setup && JSON.stringify(d.setup) !== JSON.stringify(p.setup))) throw new Error("无效角色池快照");
    const finalSetup = finalizeNetworkSetup(p.setup, p.selections, p.ready);
    if (JSON.stringify(finalSetup) !== JSON.stringify(p.finalSetup)) throw new Error("无效最终编队");
    if (event.type === E.MATCH_START && (!finalSetup || !p.gameReady.HOST || !p.gameReady.GUEST)) return false;
    d.setup = p.setup;
    d.selections = p.selections;
    d.ready = p.ready;
    d.gameReady = p.gameReady;
    d.finalSetup = finalSetup;
    d.peerConnected = true;
    d.revision = event.revision;
    d.error = null;
    if (d.state === S.WAITING_PEER || d.state === S.DISCONNECTED) this.move(S.SELECTING);
    this.move(event.type === E.MATCH_START ? S.IN_GAME
      : finalSetup ? S.LOADING_GAME : d.ready.GUEST ? S.WAITING_REMOTE : S.SELECTING);
    this.notify();
    return true;
  }

  /*
功能
提交本地候选与席位选择意图。

调用方
NetworkSquadSelectionView。

输入
characterId、teamId、seatId。

输出
无；非法选择抛错。

读取状态
本地投影与 ready。

写入状态
Host 直接提交，Guest 等待 Host 回执。

调用函数
selectFor、send、isNetworkSelectionValid。

边界与不变量
已确认不能修改；Guest 不乐观占用席位。
*/
  select(selection) {
    const d = this.#data;
    if (!d.peerConnected || d.ready[d.role] || d.finalSetup
      || !isNetworkSelectionValid(d.setup, d.role, selection, d.selections)) throw new Error("请选择自己的角色与空闲席位");
    if (d.role === R.HOST) this.selectFor(R.HOST, selection);
    else this.send(E.SELECTION_CHANGED, selection);
  }

  /*
功能
由房主唯一提交真人选择。

调用方
本地 select 与 Guest SELECTION_CHANGED。

输入
角色及选择。

输出
无；冲突抛错。

读取状态
setup、ready、selections。

写入状态
对应 selection。

调用函数
isNetworkSelectionValid、publish。

边界与不变量
selection 拷贝只保留正式字段，不接受对端扩展状态。
*/
  selectFor(role, selection) {
    const d = this.#data;
    if (!d.peerConnected || d.finalSetup || d.ready[role]
      || !isNetworkSelectionValid(d.setup, role, selection, d.selections)) throw new Error("席位已占用或选择已确认");
    d.selections[role] = { characterId: selection.characterId, teamId: selection.teamId, seatId: selection.seatId };
    d.error = null;
    this.publish(E.SELECTION_CHANGED);
  }

  /*
功能
请求确认当前本地选择。

调用方
选角确认按钮。

输入
无。

输出
无；无合法选择抛错。

读取状态
当前本地 selection。

写入状态
经 Host 提交 ready。

调用函数
confirmFor、send。

边界与不变量
只确认已被 authority 接收的选择，不提前创建 Match。
*/
  confirm() {
    const d = this.#data;
    if (d.role === R.HOST) this.confirmFor(R.HOST, d.selections.HOST);
    else this.send(E.SELECTION_CONFIRMED, d.selections.GUEST);
  }

  /*
功能
由房主验证精确选择后记录 Ready。

调用方
confirm 与 Guest 确认消息。

输入
角色及确认的 selection。

输出
无；过时或非法确认抛错。

读取状态
固定池、选择与 finalSetup。

写入状态
ready。

调用函数
isNetworkSelectionValid、publish。

边界与不变量
拒绝迟到确认覆盖新选择；单方 Ready 不生成 finalSetup。
*/
  confirmFor(role, selection) {
    const d = this.#data;
    if (!d.peerConnected || d.finalSetup || !isNetworkSelectionValid(d.setup, role, selection, d.selections)
      || JSON.stringify(selection) !== JSON.stringify(d.selections[role])) throw new Error("确认内容已过期，请重新选择");
    d.ready[role] = true;
    this.publish(E.PEER_READY);
  }

  /*
功能
记录本地游戏 UI 已初始化完成。

调用方
network Match 页面初始化完成 callback。

输入
无。

输出
无。

读取状态
finalSetup 与 gameReady。

写入状态
对应 gameReady。

调用函数
publish、send。

边界与不变量
只有双方 gameReady 才发布 MATCH_START；重复调用幂等。
*/
  gameReady() {
    const d = this.#data;
    if (!d.finalSetup || d.state !== S.LOADING_GAME || d.gameReady[d.role]) return;
    if (d.role === R.HOST) {
      d.gameReady.HOST = true;
      this.publish(E.GAME_READY);
    } else this.send(E.GAME_READY);
  }

  /*
功能
把远端真人决定交给游戏侧请求与回答通道。

调用方
PlayerControlRouter。

输入
Host 内部 data-only request。

输出
经过关联与选项校验的结果 Promise。

读取状态
gameChannel。

写入状态
pending request registry。

调用函数
NetworkGameChannel.request。

边界与不变量
Transport 只发送 envelope，不再代替游戏侧实现 decision round-trip。
*/
  requestDecision(request) {
    return this.gameChannel.request(request);
  }

  /*
功能
冻结断线会话并取消远端等待，保留池供选角重连。

调用方
Transport 断线及本地失败。

输入
面向玩家的错误说明。

输出
无。

读取状态
state。

写入状态
peerConnected、Ready、error、abort。

调用函数
move、notify、AbortController.abort。

边界与不变量
已生成 Match 的断线必须由页面销毁对局；不自动恢复真实战斗。
*/
  disconnect(message = "连接已断开") {
    if (this.#data.state === S.IDLE) return;
    this.#abort.abort();
    this.gameChannel.reset();
    this.#data.peerConnected = false;
    this.#data.ready = { HOST: false, GUEST: false };
    this.#data.gameReady = { HOST: false, GUEST: false };
    this.#data.error = message;
    this.move(S.DISCONNECTED);
    this.notify();
  }

  /*
功能
关闭房间并使所有旧订阅和异步回执失效。

调用方
返回、重新进入与页面销毁。

输入
无。

输出
无。

读取状态
capability、unsubscribe。

写入状态
generation、abort、整个 lobby 生命周期。

调用函数
unsubscribe、capability.close、reset、notify。

边界与不变量
不修改游戏规则或永久存储；只有再次 open 才可能生成新池。
*/
  close() {
    this.#generation += 1;
    this.#abort.abort();
    this.gameChannel.reset();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#capability?.close?.();
    this.reset();
    this.notify();
  }
}
