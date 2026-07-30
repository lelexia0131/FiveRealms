/**
 * 本文件统一写入公开对局日志，依赖 GameState 和 UI 渲染接口。
 * 它不记录 AI 私密可见信息或电脑未公开手牌；调用者必须只传可公开文本。
 */
import { createId } from "../utils/helpers.js?build=20260730-tabletop-hands-v16";

export class GameLogger {
  constructor(state, ui) {
    this.state = state;
    this.ui = ui;
  }

  /** 添加一条公开日志并通知 UI 自动滚动；会修改 state.logs。 */
  add(message, kind = "normal") {
    const entry = { id: createId("log"), message, kind, timestamp: Date.now() };
    this.state.logs.push(entry);
    this.ui?.appendLog(entry, this.state.logs.length);
    return entry;
  }
}
