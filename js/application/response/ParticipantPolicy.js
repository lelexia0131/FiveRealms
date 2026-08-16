/*
模块职责
唯一拥有 Application Response participant-kind policy：只根据 controllerType 参与者元数据决定窗口展示与救援兼容策略；不拥有 concrete Human/AI routing、Domain Rule 或 response choice。

上游
application/response ResponseWorkflow。

下游
无。

状态边界
只读 participant 的 controllerType/id/battleTeam 元数据；不写状态。

信息边界
controllerType 是 Application participant metadata；不读取手牌、AI 内部状态或 hidden information。

架构约束
不得依赖 concrete UI/AI/Game/Domain transitions；不得决定 legality 或 Domain rule。
*/

/*
功能
判断参与者是否为真人。

调用方
ParticipantPolicy helpers 与 tests。

输入
participant 投影。

输出
布尔值。

读取状态
controllerType。

写入状态
无。

调用函数
无。

边界与不变量
缺失 metadata 视为非真人，保持旧默认。
*/
export function isHumanParticipant(participant) {
  return participant?.controllerType === "human";
}

/*
功能
判断参与者是否为 AI。

调用方
ParticipantPolicy helpers 与 tests。

输入
participant 投影。

输出
布尔值。

读取状态
controllerType。

写入状态
无。

调用函数
无。

边界与不变量
缺失 metadata 视为非 AI，保持旧默认。
*/
export function isAiParticipant(participant) {
  return participant?.controllerType === "ai";
}

/*
功能
决定响应者没有足够响应牌时是否仍展示响应窗口。

调用方
ResponseWorkflow.requestCardResponse/requestDyingRescue/requestAssaultDiscard。

输入
responder 投影。

输出
布尔值。

读取状态
controllerType。

写入状态
无。

调用函数
isHumanParticipant。

边界与不变量
只有真人无牌仍展示窗口；AI 无牌立即 unavailable。
*/
export function shouldShowResponseWindowWithoutCards(responder) {
  return isHumanParticipant(responder);
}

/*
功能
决定 AI 自救策略是否直接固定使用调息。

调用方
ResponseWorkflow.requestDyingRescue。

输入
rescuer 与 target 投影。

输出
布尔值。

读取状态
controllerType 与 id。

写入状态
无。

调用函数
isAiParticipant。

边界与不变量
只有 AI 救援自己时启用；不改变支付或资格校验。
*/
export function shouldForceAiSelfRescue(rescuer, target) {
  return isAiParticipant(rescuer) && rescuer.id === target.id;
}

/*
功能
决定 AI 队友是否按兼容策略强制救援真人。

调用方
ResponseWorkflow.requestDyingRescue。

输入
rescuer、target 投影与当前强制策略值。

输出
布尔值。

读取状态
controllerType、id 与 battleTeam。

写入状态
无。

调用函数
isAiParticipant、isHumanParticipant。

边界与不变量
仅强制策略开启、AI 救同阵营真人队友时启用；不改变 Domain 救援资格。
*/
export function shouldForceAiRescueHuman(rescuer, target, forceAiRescueHuman) {
  return Boolean(forceAiRescueHuman)
    && isAiParticipant(rescuer)
    && isHumanParticipant(target)
    && rescuer.id !== target.id
    && rescuer.battleTeam === target.battleTeam;
}

/*
功能
决定响应结果是否优先采用参与者显式选择的合法牌。

调用方
ResponseWorkflow.requestLeverageAssault。

输入
responder 投影。

输出
布尔值。

读取状态
controllerType。

写入状态
无。

调用函数
isHumanParticipant。

边界与不变量
AI 策略仍固定采用可用牌第一张；该差异是 Application participant policy。
*/
export function shouldPreferExplicitSelection(responder) {
  return isHumanParticipant(responder);
}

/*
功能
决定借势响应者在没有合法突袭牌时是否直接不可用。

调用方
ResponseWorkflow.requestLeverageAssault。

输入
responder 投影。

输出
布尔值。

读取状态
controllerType。

写入状态
无。

调用函数
isHumanParticipant。

边界与不变量
只有真人无合法突袭不创建窗口；AI 仍走 timing 窗口，避免手牌侧信道。
*/
export function shouldRejectLeverageWithoutCards(responder) {
  return isHumanParticipant(responder);
}
