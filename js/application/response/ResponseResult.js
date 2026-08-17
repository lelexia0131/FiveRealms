/*
模块职责
拥有 Response Workflow 的 canonical result status；与 ChoiceResult 语义分离。

上游
Application ResponseWorkflow 与 tests。

下游
ActionWorkflow、CombatWorkflow、DyingWorkflow 与状态结算 workflow 等 consumers。

状态边界
不读写真状态。

信息边界
无隐藏信息。

架构约束
不得依赖 concrete UI/AI/Audio/Diagnostics、Game runtime、EventDispatcher 或 Domain mutation。
*/

export const RESPONSE_STATUS = Object.freeze({
  USED: "used",
  DECLINED: "declined",
  CANCELLED: "cancelled",
  UNAVAILABLE: "unavailable",
  INVALID: "invalid"
});

/*
功能
创建 canonical ResponseWorkflowResult。

调用方
application/response ResponseWorkflow。

输入
status 与 payload。

输出
冻结 workflow result。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
status 只使用 RESPONSE_STATUS；payload 不包含 ChoiceResult。
*/
export function createResponseWorkflowResult(status, payload = {}) {
  return Object.freeze({ status, ...payload });
}

/*
功能
判断 ResponseWorkflowResult 是否 cancelled。

调用方
Application workflows 与 tests。

输入
result。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持 isCancelledResponse 语义。
*/
export function isCancelledResponse(result) {
  return result?.status === RESPONSE_STATUS.CANCELLED;
}
