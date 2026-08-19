/*
模块职责
提供真实 Domain MatchState 的纯只读玩家/座次查询入口，并作为 MatchApplication public query 的 forwarding target。

上游
match application 的 query boundary 与当前 domain/rules 消费者。

下游
StateView 语义读边界。

状态边界
只读 state；不写入、不 emit、不 log、不调用 UI/AI/random。

信息边界
不读取 controllerType、aiMemory 或任何 AI/UI 字段。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得实现规则、距离、合法性或 workflow。
*/
import { createStateView } from "./StateView.js";

/*
功能
返回当前行动角色。

调用方
MatchApplication.currentPlayer projection 与 domain query tests。

输入
真实 MatchState 或同形只读 state。

输出
当前 Player 实例或 null。

读取状态
StateView.currentActor。

写入状态
无。

调用函数
createStateView。

边界与不变量
返回原始 Player 引用；不改变索引语义。
*/
export function getCurrentActor(state) {
  return createStateView(state).currentActor();
}

/*
功能
返回全部存活玩家。

调用方
domain query tests 与未来 rules。

输入
真实 MatchState 或同形只读 state。

输出
原始 Player 引用数组，保持 state.players 顺序。

读取状态
StateView.livingPlayers。

写入状态
无。

调用函数
createStateView。

边界与不变量
不复制、不排序、不缓存。
*/
export function getLivingPlayers(state) {
  return createStateView(state).livingPlayers();
}

/*
功能
返回指定玩家含自身在内的存活同阵营玩家。

调用方
MatchApplication.getAllies projection 与 Domain rules。

输入
state 与 Player。

输出
原始 Player 引用数组。

读取状态
StateView.alliesOf。

写入状态
无。

调用函数
createStateView。

边界与不变量
必须包含 source 自身；当前行为是 baseline。
*/
export function getAllies(state, player) {
  return createStateView(state).alliesOf(player);
}

/*
功能
返回指定玩家的存活敌对阵营玩家。

调用方
MatchApplication.getEnemies projection 与 Domain rules。

输入
state 与 Player。

输出
原始 Player 引用数组。

读取状态
StateView.enemiesOf。

写入状态
无。

调用函数
createStateView。

边界与不变量
阵营判定只使用 battleTeam。
*/
export function getEnemies(state, player) {
  return createStateView(state).enemiesOf(player);
}

/*
功能
返回从指定角色下一座位开始的环形座位顺序。

调用方
MatchApplication.seatOrderFrom projection 与 Domain rules。

输入
state、source Player 与 includeSource。

输出
原始 Player 引用数组。

读取状态
StateView.seatOrderFrom。

写入状态
无。

调用函数
createStateView。

边界与不变量
与当前 MatchApplication.seatOrderFrom projection 的 includeSource 和环形语义完全一致。
*/
export function getSeatOrderFrom(state, source, includeSource = false) {
  return createStateView(state).seatOrderFrom(source, includeSource);
}
