/**
 * 本文件统一写入公开对局日志，依赖 GameState 和 UI 渲染接口。
 * 它不记录 AI 私密可见信息或电脑未公开手牌；调用者必须只传可公开文本。
 */
import { createId } from "../../utils/helpers.js";

export class MatchLogAdapter {
  /*
  功能
  创建绑定当前 MatchState 与日志展示能力的公开日志适配器。

  调用方
  createGameApplication composition root。

  输入
  当前 MatchState 与窄 UI 日志接口。

  输出
  MatchLogAdapter 实例。

  读取状态
  无。

  写入状态
  保存 state 与 ui 引用。

  调用函数
  无。

  边界与不变量
  调用方只能传可公开文本；适配器不得读取 AI 私密信息。
  */
  constructor(state, ui) {
    this.state = state;
    this.ui = ui;
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
  可公开消息与日志 kind。

  输出
  新建的日志 entry。

  读取状态
  state.players 与当前 logs 长度。

  写入状态
  向 state.logs 追加 entry，并更新 UI 日志 DOM。

  调用函数
  createId、tokenizePlayers、ui.appendLog。

  边界与不变量
  fragments 只包含公开角色事实；entry 顺序与调用顺序一致。
  */
  add(message, kind = "normal") {
    const entry = {
      id:createId("log"), message, kind, timestamp:Date.now(),
      fragments:this.tokenizePlayers(String(message ?? ""))
    };
    this.state.logs.push(entry);
    this.ui?.appendLog(entry, this.state.logs.length);
    return entry;
  }
}
