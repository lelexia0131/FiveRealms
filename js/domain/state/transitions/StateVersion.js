/*
模块职责
唯一拥有 authoritative MatchState.stateVersion 的单调递增写权限。

上游
Domain transition implementations only。

下游
无。

状态边界
只修改 state.stateVersion。

信息边界
不读取规则、AI 或隐藏信息。

架构约束
禁止被 Game/cardRegistry/skillRegistry/AI/UI 直接 import；禁止暴露任意字段修改能力。
*/

/*
功能
在成功 committed Domain mutation 后将 stateVersion 加一。

调用方
Domain transition implementations。

输入
authoritative MatchState。

输出
新 stateVersion。

读取状态
state.stateVersion。

写入状态
state.stateVersion。

调用函数
无。

边界与不变量
只做 +1；no-op/failed/cancelled 不得调用；初始化不得调用。
*/
export function bumpStateVersion(state) {
  state.stateVersion += 1;
  return state.stateVersion;
}
