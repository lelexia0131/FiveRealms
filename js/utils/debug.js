/**
 * 本文件统一管理调试输出，依赖 RuntimePolicy，不记录公开对局日志。
 * 业务模块不得散落 console.log；生产模式下这些调用会安静返回。
 */
import { RUNTIME_POLICY } from "../application/policy/RuntimePolicy.js";

export class Debug {
  /*
  功能
  在 debugMode 开启时输出带模块标签的诊断信息。

  调用方
  音频加载、Application 异常恢复与页面 bootstrap。

  输入
  诊断 scope、消息及可选 detail。

  输出
  无返回值。

  读取状态
  RUNTIME_POLICY.debugMode。

  写入状态
  仅在调试模式写浏览器 console。

  调用函数
  console.debug。

  边界与不变量
  不写公开对局日志或游戏状态；生产模式必须安静返回。
  */
  static log(scope, message, detail = undefined) {
    if (!RUNTIME_POLICY.debugMode) return;
    if (detail === undefined) console.debug(`[五域:${scope}] ${message}`);
    else console.debug(`[五域:${scope}] ${message}`, detail);
  }
}
