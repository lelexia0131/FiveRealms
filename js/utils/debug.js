/**
 * 本文件统一管理调试输出，依赖 gameConfig.js，不记录公开对局日志。
 * 业务模块不得散落 console.log；生产模式下这些调用会安静返回。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260804-leverage-ignore-limit-v60";

export class Debug {
  /** 在 debugMode 开启时输出带模块标签的信息；不会修改游戏状态。 */
  static log(scope, message, detail = undefined) {
    if (!GAME_CONFIG.debugMode) return;
    if (detail === undefined) console.debug(`[五域:${scope}] ${message}`);
    else console.debug(`[五域:${scope}] ${message}`, detail);
  }
}
