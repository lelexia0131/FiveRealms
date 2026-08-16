/**
 * Card effect resolver 的 legacy façade。
 * Rule authority 已迁至 js/domain/rules/card；effect sequencing 已迁至 js/application/action/CardEffectRuntime。
 * 本文件只提供 lookup 与 Game façade 转发。
 */
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js?build=20260816-legacy-recovery";

/*
功能
转发真实卡牌效果到 Application CardEffectRuntime。

调用方
Game temporary composition root。

输入
game、source、card、targets 与 context。

输出
card resolution result。

读取状态
无。

写入状态
无。

调用函数
game.cardEffectRuntime.resolve。

边界与不变量
本文件不含第二份 effect resolver。
*/
export async function resolveCardEffect(game, source, card, targets, context) {
  return game.cardEffectRuntime.resolve(source, card, targets, context);
}

/*
功能
查询卡牌定义是否具有 effect resolver。

调用方
tests。

输入
definitionId。

输出
布尔值。

读取状态
CARD_DEFINITIONS。

写入状态
无。

调用函数
无。

边界与不变量
当前 26 张定义牌均有 resolver（含 block/counter 的禁止主动使用 resolver）。
*/
export function hasCardResolver(definitionId) {
  return Boolean(definitionId && CARD_DEFINITIONS[definitionId]);
}
