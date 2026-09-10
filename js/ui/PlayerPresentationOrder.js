/*
功能
按 viewerId 旋转展示顺序，保留 canonical 座次。

调用方
UIManager.render、presentNetworkGame。

输入
canonical players 与当前 viewerId。

输出
以 viewer 开头、沿 canonical 环形顺序排列的新数组。

读取状态
player.id/playerId 与原数组顺序。

写入状态
无。

调用函数
Array.findIndex、slice。

边界与不变量
只旋转展示数组，不改写玩家对象、seatIndex 或原数组；viewer 必须存在。
*/
export function orderPlayersForViewer(players, viewerId) {
  const viewerIndex = players.findIndex((player) => (player.playerId ?? player.id) === viewerId);
  if (viewerIndex < 0) throw new Error("玩家展示缺少 viewer");
  return [...players.slice(viewerIndex), ...players.slice(0, viewerIndex)];
}
