/**
 * 本文件统一写入公开对局日志，依赖 GameState 和 UI 渲染接口。
 * 它不记录 AI 私密可见信息或电脑未公开手牌；调用者必须只传可公开文本。
 */
import { createId } from "../../utils/helpers.js?build=20260818-skill-rules-locality-refactor";

export class MatchLogAdapter {
  /*
  功能
  创建并初始化 MatchLogAdapter 实例。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  constructor(state, ui) {
    this.state = state;
    this.ui = ui;
  }

  /** 按当前玩家数据把角色名拆成安全 token；普通文本仍作为纯文本片段保存。 */
  /*
  功能
  查询并返回 tokenizePlayers 对应的 MatchLogAdapter 结果。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
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

  /** 添加一条公开日志并通知 UI 自动滚动；会修改 state.logs。 */
  /*
  功能
  执行 add 对应的 MatchLogAdapter 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
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
