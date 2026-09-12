import { NetworkGameView } from "../ui/network/NetworkGameView.js";
import { NetworkChatView } from "../ui/network/NetworkChatView.js";
import { NetworkSession } from "../network/NetworkSession.js";
import { NETWORK_ROLE as R, normalizeNetworkEndpoint } from "../network/NetworkProtocol.js";
import { NETWORK_STATE as S } from "../network/NetworkLobbyState.js";
import { MATCH_MODE } from "../application/match/MatchMode.js";
import { renderPlayModeSelectionView } from "../ui/network/PlayModeSelectionView.js";
import { renderNetworkEntryView, handleNetworkHostPaste, validateNetworkHost } from "../ui/network/NetworkEntryView.js";
import { renderNetworkSquadSelectionView } from "../ui/network/NetworkSquadSelectionView.js";

/*
功能
连接游戏侧 NetworkSession、页面和既有 Match lifecycle capabilities。

调用方
main.js。

输入
UI、可选 Transport capability、本端 displayName、单人/首页/准备/开始/清理 callbacks。

输出
冻结 navigation handle。

读取状态
NetworkSession snapshot 与页面表单 draft。

写入状态
仅导航会话，不写领域状态。

调用函数
NetworkSession、NetworkChatView、三种页面 renderer、注入 Match callbacks。

边界与不变量
Game UI 准备完成后才发 GAME_READY；本模块不拥有 GameLoop、规则或持久化；displayName 只交给 participant metadata。
*/
export function createNetworkFlow({ ui, capability = null, displayName = null, onSingleplayer, onHome, onPrepareMatch, onStartMatch, onDisposeMatch }) {
  const session = new NetworkSession({ capability, displayName });
  let page = "mode";
  let draft = {};
  let prepared = false;
  let started = false;
  let guestView = null;

  /*
功能
响应 lobby 状态并穿过游戏准备与启动屏障。

调用方
NetworkSession subscription。

输入
本地 session snapshot。

输出
无。

读取状态
page、prepared、started。

写入状态
页面与 Match lifecycle 标记。

调用函数
onPrepareMatch、gameReady、onStartMatch、showNetworkPage。

边界与不变量
每局准备与启动各调用一次；断线或 Host 回组选角时销毁旧 Match，回组不关闭房间。
*/
  function update(snapshot) {
    if (page !== "squad") return;
    if ([S.DISCONNECTED, S.SELECTING].includes(snapshot.state) && prepared) {
      if (snapshot.role === R.HOST) onDisposeMatch();
      guestView?.dispose();
      guestView = null;
      prepared = false;
      started = false;
      if (snapshot.state === S.SELECTING) {
        draft = {};
        ui.clearLog();
      }
    }
    if (snapshot.state === S.LOADING_GAME || snapshot.state === S.IN_GAME) {
      if (!prepared) {
        prepared = true;
        try {
          if (snapshot.role === R.HOST) {
            onPrepareMatch(snapshot.matchSetup, session);
            session.gameChannel.publish();
          } else {
            guestView = new NetworkGameView({
              ui,
              submit: (requestId, result) => session.gameChannel.respond(requestId, result)
            });
            guestView.update(session.gameChannel.snapshot());
          }
          ui.setPrompt("Host 已开始，等待成员游戏就绪", "全部成员就绪后进入对局");
          session.gameReady();
        } catch (error) {
          session.disconnect(error.message);
        }
      }
      if (snapshot.role === R.HOST && snapshot.state === S.IN_GAME && prepared && !started) {
        started = true;
        void Promise.resolve(onStartMatch()).catch((error) => session.disconnect(error.message));
      }
      return;
    }
    ui.showNetworkPage(renderNetworkSquadSelectionView(snapshot, draft), "squad");
  }
  session.subscribe(update);
  new NetworkChatView({ ui, session });
  session.gameChannel.subscribe((snapshot) => guestView?.update(snapshot));

  /*
功能
关闭当前房间并进入游玩方式页或联机入口。

调用方
main 与导航按钮。

输入
mode 或 entry。

输出
无。

读取状态
当前 lifecycle。

写入状态
清除当前房间、draft 和 Match。

调用函数
session.close、onDisposeMatch、showNetworkPage。

边界与不变量
先禁用旧页更新再关闭；迟到事件不能重新打开页面。
*/
  function show(destination = "mode") {
    page = destination;
    guestView?.dispose();
    guestView = null;
    session.close();
    onDisposeMatch();
    prepared = false;
    started = false;
    draft = {};
    ui.showNetworkPage(destination === "mode" ? renderPlayModeSelectionView() : renderNetworkEntryView());
  }

  /*
功能
处理 Network 页面按钮和角色/席位输入。

调用方
UIManager 根节点 click。

输入
DOM click event；复制按钮通过 dataset 携带自身地址。

输出
无。

读取状态
session snapshot、本地 draft。

写入状态
导航、表单 draft；选择仅经 session authority。

调用函数
show、session.open/select/confirm、normalizeNetworkEndpoint、callbacks。

边界与不变量
disabled 元素不提交；候选与席位全部齐备后才向 Host 提交；复制地址只读取被点击按钮 dataset。
*/
  function handleClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    ui.playSound("select");
    const action = button.dataset.networkAction;
    if (action === "copy-address") {
      const snapshot = session.snapshot();
      if (snapshot.role !== R.HOST || !button.dataset?.networkHost || button.dataset.networkPort == null) return;
      let endpoint;
      try {
        endpoint = normalizeNetworkEndpoint({ host: button.dataset.networkHost, port: Number(button.dataset.networkPort) });
      } catch {
        return;
      }
      const status = button.parentElement?.querySelector?.("[data-network-copy-status]")
        ?? button.closest?.(".network-connection-card")?.querySelector?.("[data-network-copy-status]") ?? null;
      void Promise.resolve().then(() => navigator.clipboard.writeText(`${endpoint.host}:${endpoint.port}`))
        .then(() => {
          if (status && button.isConnected && session.snapshot().roomId === snapshot.roomId) status.textContent = "连接地址已复制";
        }).catch(() => {
          if (status && button.isConnected && session.snapshot().roomId === snapshot.roomId) status.textContent = "复制失败，请选中上方地址手动复制。";
        });
    } else if (action === MATCH_MODE.SINGLEPLAYER) {
      page = "singleplayer";
      session.close();
      onSingleplayer();
    } else if (action === MATCH_MODE.NETWORK || action === "entry" || action === "cancel") show("entry");
    else if (action === "mode") show();
    else if (action === "home") {
      page = "home";
      session.close();
      onHome();
    } else if (action === "join") {
      page = "join";
      ui.showNetworkPage(renderNetworkEntryView({ join: true }));
    } else if (action === "create") {
      page = "squad";
      void session.open(R.HOST);
    } else if (action === "confirm") {
      try { session.confirm(); } catch (error) { ui.setPrompt(error.message); }
    } else if (["start", "kick", "capacity"].includes(action)) {
      try {
        const result = action === "start" ? session.start()
          : action === "kick" ? session.kickParticipant(button.dataset.participantId)
            : session.setMaxHumanCount(Number(button.dataset.capacity));
        if (!result.ok) ui.setPrompt({
          NOT_READY: "请等待所有已加入成员确认角色与席位。",
          ROOM_LOCKED: "房间已开始，不能更改编队。",
          CAPACITY_BELOW_COUNT: "人数上限不能低于当前房间人数。",
          INVALID_CAPACITY: "真人上限须为 2 至 5 人。",
          CANNOT_REMOVE_HOST: "房主不能踢出自己。",
          UNKNOWN_PARTICIPANT: "该成员已离开房间。"
        }[result.code] ?? "房间状态已变化，请重试。");
      } catch (error) { ui.setPrompt(error.message); }
    } else if (button.dataset.characterId || button.dataset.networkSeat) {
      const snapshot = session.snapshot();
      if (snapshot.state !== S.SELECTING) return;
      draft = { ...snapshot.localSelection, ...draft };
      if (button.dataset.characterId) draft.characterId = button.dataset.characterId;
      if (button.dataset.networkSeat) {
        const seat = snapshot.seats.find((entry) => entry.seatId === button.dataset.networkSeat);
        if (!seat) return;
        draft.seatId = seat.seatId;
        draft.teamId = seat.teamId;
      }
      if (draft.characterId && draft.seatId) {
        try { session.select(draft); }
        catch (error) { ui.showNetworkPage(renderNetworkSquadSelectionView({ ...snapshot, error: error.message }, draft), "squad"); return; }
      }
      update(session.snapshot());
    }
  }

  /*
功能
将加入表单交给注入的会话 capability。

调用方
UIManager network submit。

输入
form submit event。

输出
无。

读取状态
房间地址文本。

写入状态
page 与会话 JOINING。

调用函数
session.open。

边界与不变量
不解析或连接 IP/TCP；输入无效由原生表单阻止。
*/
  function handleSubmit(event) {
    if (!event.target.matches("[data-network-form]")) return;
    event.preventDefault();
    if (!validateNetworkHost(event.target)) return;
    const form = new FormData(event.target);
    let endpoint;
    try {
      endpoint = normalizeNetworkEndpoint({ host: String(form.get("host") ?? ""), port: Number(form.get("port")) });
    } catch (error) {
      event.target.querySelector("[data-network-form-error]").textContent = error.message;
      return;
    }
    page = "squad";
    void session.open(R.GUEST, endpoint);
  }

  return Object.freeze({
    show, handleClick, handleSubmit, session,
    handlePaste: handleNetworkHostPaste,
    handleInput: (event) => event.target.form?.matches("[data-network-form]") && validateNetworkHost(event.target.form),
    guestIntent: (kind, cardId) => guestView?.intent(kind, cardId)
  });
}
