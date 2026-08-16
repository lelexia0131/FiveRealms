/*
模块职责
拥有 MatchState primitive 字段的 root-aware 通用原子写操作；不决定回合推进、阶段顺序、胜负或 workflow。

上游
Game、DyingSystem、JudgmentSystem、PublicCardPool 的 legacy commit façade。

下游
无。

状态边界
只修改传入 state 的指定 MatchState 字段与 stateVersion。

信息边界
不读取 AI、UI、事件或隐藏信息。

架构约束
不得依赖 Game/EventBus/UI/AI/application/adapters；不得计算下一玩家、轮次或胜利者。
*/
import { bumpStateVersion } from "./StateVersion.js?build=20260816-legacy-recovery";

/*
功能
写入当前行动玩家索引。

调用方
Game.advanceTurn 与直接测试。

输入
state 与索引。

输出
写入后的索引。

读取状态
state.currentPlayerIndex、state.stateVersion。

写入状态
state.currentPlayerIndex；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不负责寻找下一名存活玩家。
*/
export function setCurrentPlayerIndex(state, index) {
  if (state.currentPlayerIndex === index) return index;
  state.currentPlayerIndex = index;
  bumpStateVersion(state);
  return index;
}

/*
功能
写入当前轮次编号。

调用方
Game.advanceTurn 与直接测试。

输入
state 与轮次编号。

输出
写入后的轮次编号。

读取状态
state.currentRound、state.stateVersion。

写入状态
state.currentRound；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不负责判断何时进入新一轮。
*/
export function setCurrentRound(state, round) {
  if (state.currentRound === round) return round;
  state.currentRound = round;
  bumpStateVersion(state);
  return round;
}

/*
功能
写入当前 match phase。

调用方
Game turn flow、DyingSystem、JudgmentSystem 与直接测试。

输入
state 与 phase。

输出
写入后的 phase。

读取状态
state.phase、state.stateVersion。

写入状态
state.phase；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不负责 phase 序列合法性。
*/
export function setMatchPhase(state, phase) {
  if (state.phase === phase) return phase;
  state.phase = phase;
  bumpStateVersion(state);
  return phase;
}

/*
功能
写入胜者阵营。

调用方
Game.checkVictory 与直接测试。

输入
state 与 team id。

输出
写入后的 team id。

读取状态
state.winnerTeam、state.stateVersion。

写入状态
state.winnerTeam；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不计算谁获胜。
*/
export function setWinnerTeam(state, winnerTeam) {
  if (state.winnerTeam === winnerTeam) return winnerTeam;
  state.winnerTeam = winnerTeam;
  bumpStateVersion(state);
  return winnerTeam;
}

/*
功能
写入游戏结束标记。

调用方
Game.checkVictory 与直接测试。

输入
state 与布尔值。

输出
写入后的布尔值。

读取状态
state.isGameOver、state.stateVersion。

写入状态
state.isGameOver；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不触发 gameOver 事件或 UI。
*/
export function setGameOver(state, isGameOver) {
  if (state.isGameOver === isGameOver) return isGameOver;
  state.isGameOver = isGameOver;
  bumpStateVersion(state);
  return isGameOver;
}

/*
功能
写入公开牌池数组引用。

调用方
PublicCardPool 与直接测试。

输入
state 与数组。

输出
写入后的数组引用。

读取状态
state.publicCardPool、state.stateVersion。

写入状态
state.publicCardPool；引用变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
保持传入数组身份，不复制。
*/
export function setPublicCardPool(state, cards) {
  if (state.publicCardPool === cards) return cards;
  state.publicCardPool = cards;
  bumpStateVersion(state);
  return cards;
}
