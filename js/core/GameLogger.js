/**
 * 本文件统一写入公开对局日志，依赖 GameState 和 UI 渲染接口。
 * 它不记录 AI 私密可见信息或电脑未公开手牌；调用者必须只传可公开文本。
 */
import { createId } from "../utils/helpers.js?build=20260804-plunder-dual-role-value-v70";

export class GameLogger {
  constructor(state, ui) {
    this.state = state;
    this.ui = ui;
  }

  /** 按当前玩家数据把角色名拆成安全 token；普通文本仍作为纯文本片段保存。 */
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

  /** 添加一条公开日志并通知 UI 自动滚动；会修改 state.logs。 */
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
