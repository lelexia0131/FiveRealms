import { presentOpeningLog } from "./OpeningLogPresentation.js";

/*
功能
按指定 viewer 渲染正式结构化日志事实。

调用方
MatchLogAdapter.add、NetworkHostBridge。

输入
开局事实或携带事件发生时各 viewer 合法牌名的移动事实，以及 viewerId。

输出
可交给正式日志 renderer 的 text/player fragments。

读取状态
fact 中的公开角色身份与指定 viewer 的合法牌名快照。

写入状态
无。

调用函数
presentOpeningLog。

边界与不变量
不从 Host 文本恢复信息；不输出其他 viewer 的知识、卡牌实体 ID 或 definitionId。
历史日志固定使用事件发生时的知识，后来揭示或失效不回写历史。
*/
export function presentLogFact(fact, viewerId) {
  if (fact.type === "opening") return presentOpeningLog(fact, viewerId);
  const players = Object.fromEntries(fact.players.map((entry) => [entry.playerId, { type: "player", ...entry }]));
  const name = fact.cardNamesByViewer[viewerId];
  const label = name ? `「${name}」` : "1张手牌";
  const actor = players[fact.actorId], from = players[fact.fromId];
  if (fact.action === "transfer") return [actor, { type: "text", text: "将" }, from, { type: "text", text: `的${label}转移给了` },
    fact.receiverId === fact.actorId ? { type: "text", text: "自己" } : players[fact.receiverId], { type: "text", text: "。" }];
  if (fact.action === "plunder") return [actor, { type: "text", text: "从" }, from, { type: "text", text: `处掠夺了${label}。` }];
  if (fact.action === "steal") return [actor, { type: "text", text: "发动「窃取」，从" }, from, { type: "text", text: `处获得${label}并收入手牌。` }];
  throw new Error("未知牌移动日志事实");
}
