/*
模块职责
拥有 seat-order Domain Rule 输入的 canonical full roster 契约：完整连续座次花名册，而不是 filtered candidates。

上游
domain/rules/status 与 domain/rules/response 的 seat-order rule。

下游
无。

状态边界
只读数组 facts；不写状态。

信息边界
不读取 controllerType/aiMemory/AI/UI 或隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime。
*/

/*
功能
判断 players 是否为完整 canonical seat roster。

调用方
assertCanonicalSeatRoster 与 tests。

输入
players 数组。

输出
布尔值。

读取状态
无。

写入状态
无。

调用函数
Number.isInteger。

边界与不变量
要求 players[i].seatIndex === i；这同时保证 0..length-1 连续、唯一且物理 seat-order；允许 dead player 保留在 roster。
*/
export function isCanonicalSeatRoster(players) {
  if (!Array.isArray(players) || players.length === 0) return false;
  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    if (!player || player.id === undefined || player.seatIndex !== index) return false;
  }
  return true;
}

/*
功能
强制 players 为完整 canonical seat roster，否则抛出 TypeError。

调用方
StatusRules.nextLightningReceiverId、ResponseRules seat-order 入口与 tests。

输入
players 数组。

输出
校验通过时返回原数组。

读取状态
无。

写入状态
无。

调用函数
isCanonicalSeatRoster。

边界与不变量
不排序、不复制、不改变 seat semantics。
*/
export function assertCanonicalSeatRoster(players) {
  if (!isCanonicalSeatRoster(players)) {
    throw new TypeError("seat-order rule 只接受完整且物理 seat-ordered canonical roster；players[i].seatIndex 必须等于 i");
  }
  return players;
}
