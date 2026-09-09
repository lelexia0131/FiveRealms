import { createChoiceResult } from "../application/ports/ChoicePort.js";

export const PLAYER_CONTROL = Object.freeze({
  LOCAL_HUMAN: "LOCAL_HUMAN", REMOTE_HUMAN: "REMOTE_HUMAN", AI: "AI"
});

/*
功能
读取统一控制来源，兼容既有单人 participant metadata。

调用方
composition、UI 和 NetworkSetup。

输入
player。

输出
LOCAL_HUMAN、REMOTE_HUMAN 或 AI。

读取状态
player.controlType/controllerType。

写入状态
无。

调用函数
无。

边界与不变量
远程真人仍是 human；不得落入 AI 决策。
*/
export function getPlayerControl(player) {
  return player?.controlType ?? (player?.controllerType === "human" ? PLAYER_CONTROL.LOCAL_HUMAN : PLAYER_CONTROL.AI);
}

export class PlayerControlRouter {
  /*
功能
装配单局控制路由及远端决策 capability。

调用方
MatchApplication。

输入
状态 getter 与 remoteDecision(request) capability。

输出
路由实例。

读取状态
无。

写入状态
保存只读 capability 引用。

调用函数
无。

边界与不变量
不拥有游戏状态、规则或 Transport。
*/
  constructor({ getState, remoteDecision }) {
    this.getState = getState;
    this.remoteDecision = remoteDecision;
  }

  /*
功能
解析真人命令的行动者，缺省使用本地真人。

调用方
ActionWorkflow 经 composition。

输入
可选 actorId。

输出
真人 player 或 null。

读取状态
roster 和 controlType。

写入状态
无。

调用函数
getPlayerControl。

边界与不变量
显式 actorId 不能选择 AI；本地 UI 不提供远端 actorId。
*/
  humanPlayer(actorId) {
    return this.getState().players.find((player) => actorId
      ? player.id === actorId && getPlayerControl(player) !== PLAYER_CONTROL.AI
      : getPlayerControl(player) === PLAYER_CONTROL.LOCAL_HUMAN) ?? null;
  }

  /*
功能
按 actor 的统一控制来源分派所有 ChoiceRequest。

调用方
createChoiceBoundary。

输入
data-only request 和本地/AI ports。

输出
ChoiceResult Promise。

读取状态
当前 roster。

写入状态
无。

调用函数
port.request、requestRemote。

边界与不变量
远端没有 capability 时拒绝，不把远端选择显示给本机。
*/
  request(request, humanPort, aiPort, remotePort) {
    const actor = this.getState().players.find((player) => player.id === request.actorId);
    if (!actor) return Promise.resolve(createChoiceResult("cancelled", { reason: "unknown-actor" }));
    const control = getPlayerControl(actor);
    if (control === PLAYER_CONTROL.REMOTE_HUMAN) return remotePort ? remotePort.request(request) : this.requestRemote(request);
    return (control === PLAYER_CONTROL.LOCAL_HUMAN ? humanPort : aiPort).request(request);
  }

  /*
功能
向注入 capability 发出可序列化的远端决定。

调用方
request、waitForHumanPlay、requestCardFlow。

输入
只含 ID、选项或 token 的 request。

输出
远端返回值 Promise；能力缺失抛错。

读取状态
remoteDecision。

写入状态
无。

调用函数
structuredClone、remoteDecision。

边界与不变量
禁止传递实体、DOM、闭包或 AI 对象，取消由 session 信号收束。
*/
  async requestRemote(request) {
    if (!this.remoteDecision) throw new Error("远程玩家决策通道尚未接入");
    return this.remoteDecision(structuredClone(request));
  }

  /*
功能
把真人出牌阶段交给本地 UI 或远端意图来源。

调用方
TurnWorkflow 经 composition waitForHumanPlayEnd。

输入
actor、gameId、本地等待及 card/skill 执行 callbacks。

输出
阶段完成布尔值 Promise。

读取状态
当前 gameId、actor、phase、存活与终局状态。

写入状态
经 callbacks 进入唯一 ActionWorkflow。

调用函数
requestRemote、handleCard、handleSkill、waitLocal。

边界与不变量
远端每条意图重验当前回合；正常卡牌、目标和技能复用原 workflow，不创建第二回合循环。
*/
  async waitForHumanPlay(actor, gameId, { waitLocal, handleCard, handleSkill, setPrompt }) {
    if (getPlayerControl(actor) !== PLAYER_CONTROL.REMOTE_HUMAN) return waitLocal(gameId);
    setPrompt("等待另一名玩家行动", "对方正在选择手牌或技能");
    while (true) {
      const state = this.getState();
      if (state.isDisposed || state.gameId !== gameId || state.isGameOver || !actor.alive
        || state.phase !== "play" || state.players[state.currentPlayerIndex]?.id !== actor.id) return false;
      const intent = await this.requestRemote({ kind: "player-intent", gameId, actorId: actor.id, stateVersion: state.stateVersion });
      if (state.isDisposed || state.isGameOver || !actor.alive || state.phase !== "play"
        || state.players[state.currentPlayerIndex]?.id !== actor.id) return false;
      if (intent?.kind === "cancelled") return false;
      if (intent?.kind === "end") return true;
      if (intent?.kind === "card") await handleCard(intent.cardId, actor.id);
      else if (intent?.kind === "skill") await handleSkill(actor.id);
      else throw new Error("无效远端出牌意图");
    }
  }

  /*
功能
为卡牌的附加选择流程分派本地或远端控制。

调用方
ActionWorkflow 经 composition requestCardFlow。

输入
actor、卡牌、初始目标和本地流程 callback。

输出
selection Promise。

读取状态
卡牌公开 flow 描述及目标 ID。

写入状态
无。

调用函数
requestRemote、requestLocal。

边界与不变量
未来资源、技能参数与手牌选择通过同一远端决策边界，结算仍重验 selection。
*/
  requestCardFlow(actor, card, targets, requestLocal) {
    if (getPlayerControl(actor) !== PLAYER_CONTROL.REMOTE_HUMAN) return requestLocal();
    return this.requestRemote({
      kind: "card-flow", gameId: this.getState().gameId, actorId: actor.id,
      cardId: card.id, targetIds: targets.map((target) => target.id),
      flow: card.selectionFlow
    });
  }

  /*
功能
把合法私密揭示交给其观看者并等待关闭。

调用方
Presentation adapter 经 composition。

输入
viewerId、title、合法 cardIds 与本地展示 callback。

输出
揭示关闭 Promise。

读取状态
viewer 控制来源。

写入状态
无。

调用函数
requestRemote、presentLocal。

边界与不变量
远端观看者的卡牌不得进入本地揭示 DOM。
*/
  presentPrivateReveal(descriptor, presentLocal) {
    const viewer = this.getState().players.find((player) => player.id === descriptor.viewerId);
    if (getPlayerControl(viewer) !== PLAYER_CONTROL.REMOTE_HUMAN) return presentLocal();
    return this.requestRemote({ ...descriptor, kind: "private-reveal", gameId: this.getState().gameId, actorId: viewer.id });
  }
}
