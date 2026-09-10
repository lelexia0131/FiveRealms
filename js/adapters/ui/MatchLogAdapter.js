/**
 * 本文件统一写入公开对局日志，依赖 GameState 和 UI 渲染接口。
 * 字符串仅接收公开文本；结构化事实在 Host 按各 viewer 的合法知识渲染后交给 UI。
 */
import { createId } from "../../utils/helpers.js";
import { presentLogFact } from "../../ui/LogPresentation.js";

export class MatchLogAdapter {
  /*
  功能
  创建绑定当前 MatchState 与日志展示能力的公开日志适配器。

  调用方
  createGameApplication composition root。

  输入
  当前 MatchState、窄 UI 日志接口与合法卡牌知识查询。

  输出
  MatchLogAdapter 实例。

  读取状态
  无。

  写入状态
  保存 state、ui 与 knowledge capability。

  调用函数
  无。

  边界与不变量
  字符串只能是公开文本；牌移动事实必须经注入 knowledge authority 按 viewer 投影。
  */
  constructor(state, ui, isCardKnownTo) {
    this.state = state;
    this.ui = ui;
    this.isCardKnownTo = isCardKnownTo;
  }

  /*
  功能
  按当前玩家名称把日志拆成可安全渲染的角色和纯文本片段。

  调用方
  MatchLogAdapter.add。

  输入
  已确认可公开的日志字符串。

  输出
  按原顺序排列的 text/player fragment 数组。

  读取状态
  state.players 的名称、ID 与 battleTeam。

  写入状态
  无。

  调用函数
  String.startsWith/slice。

  边界与不变量
  优先匹配较长名称避免前缀冲突；普通片段保持原文本，不生成 HTML。
  */
  tokenizePlayers(message) {
    const players = [...(this.state.players ?? [])]
      .filter((player) => player?.name)
      .sort((a, b) => b.name.length - a.name.length);
    if (!players.length) return [{ type:"text", text:message }];
    const fragments = [];
    let cursor = 0;
    while (cursor < message.length) {
      const player = players.find((candidate) => message.startsWith(candidate.name, cursor));
      if (player) {
        fragments.push({ type:"player", text:player.name, playerId:player.id, battleTeam:player.battleTeam });
        cursor += player.name.length;
        continue;
      }
      const start = cursor;
      cursor += 1;
      while (cursor < message.length && !players.some((candidate) => message.startsWith(candidate.name, cursor))) cursor += 1;
      fragments.push({ type:"text", text:message.slice(start, cursor) });
    }
    return fragments;
  }

  /*
  功能
  追加一条结构化公开对局日志并通知 UI。

  调用方
  MatchApplication.log public boundary 与 Application workflows。

  输入
  可公开消息、opening fact 或已成功结算的 card-move ID fact，以及日志 kind。

  输出
  新建的日志 entry。

  读取状态
  当前本地 viewer、公开角色、接收者手牌与 knowledge authority。

  写入状态
  向 state.logs 追加 entry，并更新 UI 日志 DOM。

  调用函数
  createId、presentLogFact、captureCardMoveFact、tokenizePlayers、ui.appendLog。

  边界与不变量
  先保存各 viewer 事件时知识，再分别渲染；原始移动身份及所有 viewer 的知识不得广播。
  */
  add(message, kind = "normal") {
    const presentationFact = message?.type === "opening" ? {
      type: "opening", viewerId: message.viewerId,
      players: message.players.map(({ playerId, name, battleTeam }) => ({ playerId, name, battleTeam }))
    } : message?.type === "card-move" ? this.captureCardMoveFact(message) : null;
    const viewerId = presentationFact?.viewerId
      ?? this.state.players.find((player) => player.controlType === "LOCAL_HUMAN")?.id
      ?? this.state.players.find((player) => player.controllerType === "human")?.id;
    const fragments = presentationFact
      ? presentLogFact(presentationFact, viewerId) : this.tokenizePlayers(String(message ?? ""));
    const entry = {
      id:createId("log"), message: presentationFact ? fragments.map((fragment) => fragment.text).join("") : message,
      kind, timestamp:Date.now(), fragments,
      ...(presentationFact ? { presentationFact } : {})
    };
    this.state.logs.push(entry);
    this.ui?.appendLog(entry, this.state.logs.length);
    return entry;
  }

  /*
  功能
  将成功牌移动的实体 ID 事实转换成固定于事件时刻的日志展示事实。

  调用方
  add 的 card-move 入口。

  输入
  action、actorId、fromId、receiverId 与 cardId。

  输出
  仅含公开角色及各 viewer 合法牌名的内部 presentation fact。

  读取状态
  接收者当前手牌、玩家身份与注入 knowledge authority。

  写入状态
  无。

  调用函数
  isCardKnownTo。

  边界与不变量
  只在成功移动且记忆迁移完成后捕获；先判断知识再读取牌名。
  该事实留在 Host，发往 Guest 的只有针对其 viewer 渲染的片段。
  */
  captureCardMoveFact(message) {
    const players = this.state.players;
    const receiver = players.find((player) => player.id === message.receiverId);
    const card = receiver?.hand.find((entry) => entry.id === message.cardId);
    return {
      type: "card-move", action: message.action, actorId: message.actorId,
      fromId: message.fromId, receiverId: message.receiverId,
      players: players.map((player) => ({ playerId: player.id, text: player.name, battleTeam: player.battleTeam })),
      cardNamesByViewer: Object.fromEntries(players.map((viewer) => [viewer.id,
        card && this.isCardKnownTo(viewer, receiver, card) ? card.name : null
      ]))
    };
  }
}
