/*
模块职责
提供真实牌区实体出现位置的纯只读查询，并作为 Game zone query 的 forwarding target。

上游
match application 的 zone query boundary 与当前 transitions 前置校验。

下游
无。

状态边界
只读 state.deck 数组、state.publicCardPool 与 player.hand/equipment；不写入、不移动牌。

信息边界
实体身份只按引用比较；不读取牌面或 AI 信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得实现任何卡牌移动。
*/

/*
功能
返回实体牌在所有规则区域中的实际出现位置。

调用方
Game.getCardZoneOccurrences 与 zone invariant tests。

输入
state 与 Card entity。

输出
zone label 数组；同一实体的重复引用逐次计数。

读取状态
state.deck 四区、state.publicCardPool、每名玩家 hand/equipment。

写入状态
无。

调用函数
无。

边界与不变量
zone 枚举顺序和 label 格式与当前 Game 实现完全一致。
*/
export function getCardZoneOccurrences(state, card) {
  const occurrences = [];
  /*
  功能
  将指定牌区中与目标实体引用相同的卡逐次记录为 zone label。

  调用方
  getCardZoneOccurrences。

  输入
  牌区数组与 zone label。

  输出
  无返回值，只写局部 occurrences。

  读取状态
  cards 数组。

  写入状态
  occurrences 局部数组。

  调用函数
  Array.forEach。

  边界与不变量
  重复引用逐次计数，不修改牌区。
  */
  const collect = (cards, zone) => cards.forEach((entry) => {
    if (entry === card) occurrences.push(zone);
  });
  collect(state.deck.cards, "deck");
  collect(state.deck.discardPile, "discard");
  collect(state.deck.resolvingCards, "resolving");
  collect(state.deck.judgmentZone, "judgment");
  collect(state.publicCardPool ?? [], "publicPool");
  for (const player of state.players) {
    collect(player.hand, `hand:${player.id}`);
    if (player.equipment === card) occurrences.push(`equipment:${player.id}`);
  }
  return occurrences;
}

/*
功能
判断实体牌当前唯一处于弃牌堆。

调用方
Game.isCardCommittedToDiscard 与 zone invariant tests。

输入
state 与 Card entity。

输出
布尔值。

读取状态
getCardZoneOccurrences。

写入状态
无。

调用函数
getCardZoneOccurrences。

边界与不变量
只有 occurrence 数组恰为 ["discard"] 时返回 true。
*/
export function isCardCommittedToDiscard(state, card) {
  const occurrences = getCardZoneOccurrences(state, card);
  return occurrences.length === 1 && occurrences[0] === "discard";
}

/*
功能
判断实体牌当前唯一处于指定玩家装备槽。

调用方
Game.isCardCommittedToEquipment 与 zone invariant tests。

输入
state、Player 与 Card entity。

输出
布尔值。

读取状态
getCardZoneOccurrences。

写入状态
无。

调用函数
getCardZoneOccurrences。

边界与不变量
label 必须与 equipment:<playerId> 完全一致。
*/
export function isCardCommittedToEquipment(state, player, card) {
  const occurrences = getCardZoneOccurrences(state, card);
  return occurrences.length === 1 && occurrences[0] === `equipment:${player?.id}`;
}
