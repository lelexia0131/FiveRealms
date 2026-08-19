/*
模块职责
拥有状态对象的 root-aware 通用 set/remove/clear 原子写操作；不拥有任何具体状态生命周期或规则。

上游
CardEffectRuntime、SkillEffectRuntime、StatusResolutionWorkflow 与直接测试。

下游
无。

状态边界
只修改传入 state.stateVersion 与 Player.statuses 对象。

信息边界
不读取具体状态语义、AI 或隐藏信息。

架构约束
不得依赖 Game/EventDispatcher/UI/AI/application/adapters；禁止 statusId 具体规则分支。
*/
import { bumpStateVersion } from "./StateVersion.js";

/*
功能
写入或替换指定状态 ID 的状态对象。

调用方
真实状态 workflow 与直接测试。

输入
state、Player、statusId 与状态对象。

输出
写入后的状态对象。

读取状态
state.stateVersion、player.statuses。

写入状态
player.statuses[statusId]；引用变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不解释状态语义，不触发事件或日志。
*/
export function setStatus(state, player, statusId, status) {
  const previous = player.statuses[statusId];
  player.statuses[statusId] = status;
  if (previous !== status) bumpStateVersion(state);
  return status;
}

/*
功能
删除指定状态 ID 的状态对象。

调用方
真实状态 workflow 与直接测试。

输入
state、Player 与 statusId。

输出
被删除的状态对象；原本不存在时返回 undefined。

读取状态
state.stateVersion、player.statuses。

写入状态
player.statuses[statusId]；存在时 bump。

调用函数
delete、bumpStateVersion。

边界与不变量
不解释状态语义，不触发事件或日志。
*/
export function removeStatus(state, player, statusId) {
  if (!Object.hasOwn(player.statuses, statusId)) return undefined;
  const removed = player.statuses[statusId];
  delete player.statuses[statusId];
  bumpStateVersion(state);
  return removed;
}

/*
功能
清空玩家全部状态对象。

调用方
DyingWorkflow kill cleanup 与直接测试。

输入
state 与 Player。

输出
被替换前的旧状态对象。

读取状态
state.stateVersion、player.statuses。

写入状态
player.statuses；存在状态时 bump。

调用函数
bumpStateVersion。

边界与不变量
保留新对象可写语义；不决定何时应清空状态。
*/
export function clearStatuses(state, player) {
  const previous = player.statuses;
  player.statuses = {};
  if (Object.keys(previous).length > 0) bumpStateVersion(state);
  return previous;
}
