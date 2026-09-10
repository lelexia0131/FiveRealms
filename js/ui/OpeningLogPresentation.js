import { TEAM_PRESENTATION } from "../adapters/ui/PresentationMetadata.js";

/*
功能
按目标 viewer 把开局角色与阵营事实渲染成正式日志片段。

调用方
presentLogFact。

输入
仅含开局可见角色身份的 opening fact 与 viewerId。

输出
以目标 viewer 为“你”的 text/player 片段。

读取状态
fact.players 的 playerId、name、battleTeam 与公开阵营名称。

写入状态
无。

调用函数
Array.find。

边界与不变量
不读取手牌、知识或 Host 日志文本；viewer 缺失时拒绝，不回退到首席或另一真人。
*/
export function presentOpeningLog(fact, viewerId) {
  const player = fact.players.find((entry) => entry.playerId === viewerId);
  if (!player) throw new Error("开局日志缺少 viewer");
  return [
    { type: "text", text: "你选择了" },
    { type: "player", text: player.name, playerId: player.playerId, battleTeam: player.battleTeam },
    { type: "text", text: `，你的阵营是${TEAM_PRESENTATION[player.battleTeam].name}。` }
  ];
}
