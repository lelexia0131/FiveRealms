import { calculatePerformance } from "./MatchPerformanceCalculator.js";

/*
功能
按确定性规则比较两名玩家的结算表现。

调用方
createMatchResultViewModel 的 Array.sort。

输入
两名已计算表现的玩家对象。

输出
负数、零或正数排序结果。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
依次比较 final、base、firepower、support，最终以开局座位顺序稳定决胜；不使用随机数。
*/
export function compareMatchPerformance(left, right) {
  return right.finalScore - left.finalScore
    || right.baseScore - left.baseScore
    || right.scores.firepower - left.scores.firepower
    || right.scores.support - left.scores.support
    || left.seatIndex - right.seatIndex;
}

/*
功能
把一局冻结的玩家统计快照转换为排名、MVP、队友身份和默认选择视图模型。

调用方
MatchPerformanceSidecar 的 gameOver 监听器。

输入
一局全部玩家的 raw snapshot。

输出
冻结的 MatchResultViewModel；每名玩家行明确带有同阵营队友角色 ID。

读取状态
无。

写入状态
无。

调用函数
calculatePerformance、compareMatchPerformance。

边界与不变量
每名玩家只计算一次、全场只排序一次；队友列表来自同一最终 roster 且不含本人；第一名是唯一 MVP，点击选择不得重新计算。
*/
export function createMatchResultViewModel(snapshot) {
  const ranked = snapshot.players.map((entry) => calculatePerformance(entry)).sort(compareMatchPerformance);
  const players = Object.freeze(ranked.map((entry, index) => Object.freeze({
    ...entry,
    teammateCharacterIds: Object.freeze(snapshot.players.filter(
      (candidate) => candidate.playerId !== entry.playerId && candidate.teamId === entry.teamId
    ).map((candidate) => candidate.characterId).filter(Boolean)),
    primaryName: entry.playerName,
    secondaryLabel: entry.characterName && entry.characterName !== entry.playerName
      ? entry.characterName
      : null,
    rank: index + 1,
    isMvp: index === 0
  })));
  return Object.freeze({
    gameId: snapshot.gameId,
    players,
    mvpPlayerId: players[0]?.playerId ?? null,
    defaultSelectedPlayerId: players[0]?.playerId ?? null
  });
}
