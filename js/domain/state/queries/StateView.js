/*
模块职责
提供只读取真实 Domain State 的最小语义读边界；不识别 AI SearchState，也不复制状态。

上游
MatchQueries 与未来 domain/rules 消费者。

下游
无。

状态边界
只读传入 state.players/currentPlayerIndex；不写入、不克隆。

信息边界
只暴露公开玩家座位/存活/阵营事实；不得暴露 controllerType、aiMemory、AI 概率或隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得出现 Real Player/SearchState 双 schema 分支。
*/

/*
功能
返回 state.players 原始数组。

调用方
createStateView 内部能力。

输入
只读 state 对象。

输出
原始 players 数组引用。

读取状态
state.players。

写入状态
无。

调用函数
无。

边界与不变量
不得复制数组，保持 Player/Card 身份。
*/
function viewPlayers(state) {
  return state.players;
}

/*
功能
返回当前行动角色或 null。

调用方
createStateView 内部能力。

输入
只读 state 对象。

输出
state.players[currentPlayerIndex] 或 null。

读取状态
state.players、state.currentPlayerIndex。

写入状态
无。

调用函数
无。

边界与不变量
索引未设置时返回 null，不抛错。
*/
function viewCurrentActor(state) {
  return state.players[state.currentPlayerIndex] ?? null;
}

/*
功能
返回从 source 下一座位开始的环形座位顺序。

调用方
createStateView 内部能力。

输入
只读 state 对象、source Player 与 includeSource。

输出
真实 Player 引用数组。

读取状态
state.players 与 source.seatIndex。

写入状态
无。

调用函数
无。

边界与不变量
includeSource 为 true 时 source 排首位；顺序与当前 Game.seatOrderFrom 完全一致。
*/
function viewSeatOrderFrom(state, source, includeSource = false) {
  const ordered = includeSource ? [source] : [];
  for (let offset = 1; offset < state.players.length; offset += 1) {
    ordered.push(state.players[(source.seatIndex + offset) % state.players.length]);
  }
  return ordered;
}

/*
功能
创建一组只读 Domain StateView 能力。

调用方
MatchQueries 与未来 domain/rules 消费者。

输入
真实 Game.state 或与其同形的只读 state。

输出
冻结的语义读方法集合。

读取状态
只经内部只读能力读取 state。

写入状态
无。

调用函数
viewPlayers、viewCurrentActor、viewSeatOrderFrom。

边界与不变量
不缓存查询结果；allies/enemies 语义保持当前实现（含 source 自身、只过滤 alive）。
*/
export function createStateView(state) {
  return Object.freeze({
    players: () => viewPlayers(state),
    currentActor: () => viewCurrentActor(state),
    livingPlayers: () => viewPlayers(state).filter((player) => player.alive),
    alliesOf: (player) => viewPlayers(state).filter((other) => other.alive && other.battleTeam === player.battleTeam),
    enemiesOf: (player) => viewPlayers(state).filter((other) => other.alive && other.battleTeam !== player.battleTeam),
    seatOrderFrom: (source, includeSource = false) => viewSeatOrderFrom(state, source, includeSource)
  });
}
