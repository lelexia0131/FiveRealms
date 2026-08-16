/*
模块职责
拥有 Card entity 在数组牌区之间移动的 root-aware 通用原子写操作；不拥有 draw/discard/judgment/equip workflow 或事件。

上游
Deck 的物理移动路径与直接测试。

下游
无。

状态边界
只修改传入 state.stateVersion 与牌区数组；保持 Card 对象引用。

信息边界
不读取卡牌规则字段或 AI 信息。

架构约束
不得依赖 Game/EventBus/UI/AI/application/adapters；禁止具体卡牌效果分支。
*/
import { bumpStateVersion } from "./StateVersion.js?build=20260816-legacy-recovery";

/*
功能
把 Card entity 追加到目标牌区。

调用方
Deck zone commit 与直接测试。

输入
state、目标数组与 Card entity。

输出
追加后的数组长度。

读取状态
state.stateVersion 与目标数组。

写入状态
目标数组；成功追加 bump。

调用函数
Array.push、bumpStateVersion。

边界与不变量
不验证 zone uniqueness；调用方必须保留既有校验语义。
*/
export function appendCardToZone(state, zone, card) {
  const length = zone.push(card);
  bumpStateVersion(state);
  return length;
}

/*
功能
从牌区移除一个 Card entity 引用。

调用方
Deck zone commit 与直接测试。

输入
state、牌区数组与 Card entity。

输出
移除成功返回 true；未找到返回 false。

读取状态
state.stateVersion 与牌区数组。

写入状态
牌区数组；成功移除 bump。

调用函数
Array.indexOf、Array.splice、bumpStateVersion。

边界与不变量
只移除第一个匹配引用；不改变 Card 身份。
*/
export function removeCardFromZone(state, zone, card) {
  const index = zone.indexOf(card);
  if (index < 0) return false;
  zone.splice(index, 1);
  bumpStateVersion(state);
  return true;
}

/*
功能
把 Card entity 从一个牌区移到另一个牌区。

调用方
Deck resolving/judgment movement 与直接测试。

输入
state、来源数组、目标数组与 Card entity。

输出
移动成功返回 true；来源不存在该卡返回 false。

读取状态
state.stateVersion 与来源/目标数组。

写入状态
来源与目标数组；成功移动只 bump 一次。

调用函数
removeCardFromZone、appendCardToZone。

边界与不变量
保持同一 Card 引用；调用方仍负责区域唯一性与事件顺序。
*/
export function moveCardBetweenZones(state, fromZone, toZone, card) {
  const index = fromZone.indexOf(card);
  if (index < 0) return false;
  fromZone.splice(index, 1);
  toZone.push(card);
  bumpStateVersion(state);
  return true;
}


/*
功能
将一组 Card entity 从来源牌区一次性移动到目标牌区。

调用方
Game.payCardsFromHandAtomically 与 atomic payment tests。

输入
state、来源数组、目标数组与 Card 数组。

输出
移动成功返回 true；任一卡不在来源返回 false。

读取状态
state.stateVersion 与来源/目标数组。

写入状态
两数组；成功时只 bump 一次。

调用函数
Array.indexOf、Array.splice、Array.push、bumpStateVersion。

边界与不变量
调用方必须已完成全部 before 校验；transition 不逐张提前提交。
*/
export function moveCardsAtomically(state, fromZone, toZone, cards) {
  const indexes = cards.map((card) => fromZone.indexOf(card));
  if (indexes.some((index) => index < 0)) return false;
  for (const index of indexes.sort((a, b) => b - a)) fromZone.splice(index, 1);
  for (const card of cards) toZone.push(card);
  bumpStateVersion(state);
  return true;
}

/*
功能
将装备槽 Card entity 原子移动到目标玩家手牌。

调用方
Game.moveEquipmentToHand 与 direct tests。

输入
state、来源 Player、目标 Player 与 Card。

输出
移动成功返回 true。

读取状态
state.stateVersion、from.equipment 与 to.hand。

写入状态
equipment 清空、hand 追加；只 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
保持 Card 身份；不处理知识失效或日志。
*/
export function moveEquipmentToHand(state, from, to, card) {
  if (from.equipment !== card) return false;
  from.equipment = null;
  to.hand.push(card);
  bumpStateVersion(state);
  return true;
}

/*
功能
将装备槽 Card entity 原子移动到弃牌堆。

调用方
Game.discardEquipment 与 direct tests。

输入
state、Player、Card 与弃牌堆数组。

输出
移动成功返回 true。

读取状态
state.stateVersion、player.equipment 与弃牌堆。

写入状态
equipment 清空、弃牌堆追加；只 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
保持 Card 身份；不处理知识失效或日志。
*/
export function discardEquipment(state, player, card, discardPile) {
  if (player.equipment !== card) return false;
  player.equipment = null;
  discardPile.push(card);
  bumpStateVersion(state);
  return true;
}

/*
功能
原子提交装备替换：旧装备进弃牌堆、新装备从结算区进入装备槽。

调用方
Game.equipCard 与 direct tests。

输入
state、Player、新装备 Card、旧装备 Card 或 null、结算区数组与弃牌堆数组。

输出
提交成功返回 true。

读取状态
state.stateVersion、player.equipment、resolving 与 discard 数组。

写入状态
装备槽与两数组；只 bump 一次。

调用函数
Array.indexOf、Array.splice、Array.push、bumpStateVersion。

边界与不变量
调用方必须在最后校验后无 await 地调用；transition 不暴露空装备/双装备中间态。
*/
export function commitEquipmentReplacement(state, player, newCard, oldCard, resolvingZone, discardZone) {
  const resolvingIndex = resolvingZone.indexOf(newCard);
  if (resolvingIndex < 0) return false;
  resolvingZone.splice(resolvingIndex, 1);
  if (oldCard) discardZone.push(oldCard);
  player.equipment = newCard;
  bumpStateVersion(state);
  return true;
}

/*
功能
将 Card entity 从所有已给定牌区/玩家区域清除，并唯一追加到弃牌堆。

调用方
Game.cleanupFailedResolution 与 failure cleanup tests。

输入
state、Card、牌区数组集合、players、额外牌区数组与弃牌堆。

输出
提交成功返回 true。

读取状态
state.stateVersion、所有传入区域。

写入状态
所有出现位置移除并追加弃牌堆；只 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
transition 不决定哪些区域属于失败清理；调用方已决定并传入。
*/
export function purgeCardToDiscard(state, card, zones, players, extraZones, discardZone) {
  for (const zone of zones) {
    for (let index = zone.length - 1; index >= 0; index -= 1) {
      if (zone[index] === card) zone.splice(index, 1);
    }
  }
  for (const zone of extraZones) {
    for (let index = zone.length - 1; index >= 0; index -= 1) {
      if (zone[index] === card) zone.splice(index, 1);
    }
  }
  for (const player of players) {
    for (let index = player.hand.length - 1; index >= 0; index -= 1) {
      if (player.hand[index] === card) player.hand.splice(index, 1);
    }
    if (player.equipment === card) player.equipment = null;
  }
  discardZone.push(card);
  bumpStateVersion(state);
  return true;
}


/*
功能
原子替换 Deck 的四个牌区引用为已决定的数组。

调用方
Deck.build 与 direct tests。

输入
state、Deck 与四个已决定数组。

输出
无返回值。

读取状态
state.stateVersion 与 Deck 牌区字段。

写入状态
Deck 四个牌区字段；只 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
transition 不产生随机顺序；调用方已决定数组。
*/
export function commitDeckBuild(state, deck, cards, discardPile, resolvingCards, judgmentZone) {
  deck.cards = cards;
  deck.discardPile = discardPile;
  deck.resolvingCards = resolvingCards;
  deck.judgmentZone = judgmentZone;
  bumpStateVersion(state);
}

/*
功能
原子提交已洗好的弃牌堆回牌堆。

调用方
Deck.reshuffle 与 direct tests。

输入
state、Deck 与已决定的新牌堆数组。

输出
无返回值。

读取状态
state.stateVersion 与 Deck.cards/discardPile。

写入状态
Deck.cards/discardPile；只 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
reshuffleCount 是 diagnostics，不在此处理。
*/
export function commitReshuffle(state, deck, shuffledCards) {
  deck.cards = shuffledCards;
  deck.discardPile = [];
  bumpStateVersion(state);
}

/*
功能
从牌区顶部取走一张 Card entity。

调用方
Deck.drawOne 与 direct tests。

输入
state 与牌区数组。

输出
被取走的 Card 或 null。

读取状态
state.stateVersion 与牌区数组。

写入状态
牌区数组；取到卡时 bump。

调用函数
Array.pop、bumpStateVersion。

边界与不变量
不决定是否重洗。
*/
export function takeTopCard(state, zone) {
  const card = zone.pop();
  if (card) bumpStateVersion(state);
  return card;
}
