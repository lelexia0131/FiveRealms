/*
模块职责
唯一拥有 Match lifecycle 的 immutable data-only Domain fact contracts：gameStart 与 gameOver。不拥有 publisher/subscriber/dispatcher/EventDispatcher。

上游
application/match MatchWorkflow。

下游
无。

状态边界
只读 caller facts；不写状态。

信息边界
只含 gameId/stateVersion/IDs/public primitive；不含 Game/Player/Card/AI/function。

架构约束
不得依赖 Game/application/adapters/EventDispatcher；不得 await、emit、mutation。
*/

/*
功能
构建 gameStart Domain fact。

调用方
MatchWorkflow.confirmCharacter。

输入
gameId、stateVersion 与 human/selected facts。

输出
冻结 { type, gameId, stateVersion, humanPlayerId, selectedCharacterId }。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不含 Game entity；可 JSON 序列化。
*/
export function createGameStartFact({ gameId, stateVersion, humanPlayerId, selectedCharacterId }) {
  return Object.freeze({
    type: "gameStart",
    gameId,
    stateVersion,
    humanPlayerId,
    selectedCharacterId
  });
}

/*
功能
构建 gameOver Domain fact。

调用方
MatchWorkflow.checkVictory。

输入
gameId、stateVersion 与 winnerTeam。

输出
冻结 { type, gameId, stateVersion, winnerTeam }。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不含 Game entity；可 JSON 序列化。
*/
export function createGameOverFact({ gameId, stateVersion, winnerTeam }) {
  return Object.freeze({
    type: "gameOver",
    gameId,
    stateVersion,
    winnerTeam
  });
}
