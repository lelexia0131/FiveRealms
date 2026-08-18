/**
 * 本文件统一管理调试输出，依赖 RuntimePolicy，不记录公开对局日志。
 * 业务模块不得散落 console.log；生产模式下这些调用会安静返回。
 */
import { RUNTIME_POLICY } from "../application/policy/RuntimePolicy.js?build=20260818-skill-rules-locality-refactor";

export class Debug {
  /** 在 debugMode 开启时输出带模块标签的信息；不会修改游戏状态。 */
  /*
  功能
  执行 log 对应的 debug 职责。

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
  static log(scope, message, detail = undefined) {
    if (!RUNTIME_POLICY.debugMode) return;
    if (detail === undefined) console.debug(`[五域:${scope}] ${message}`);
    else console.debug(`[五域:${scope}] ${message}`, detail);
  }
}
