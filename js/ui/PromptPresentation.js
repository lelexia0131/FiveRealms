/*
功能
按提示所属行动者生成观看者的正式主提示与手牌提示。

调用方
GamePresentationAdapter、NetworkHostBridge。

输入
正式提示描述与观看者 ID。

输出
message、handHint 展示文本。

读取状态
描述中的行动者 ID 和已授权文案。

写入状态
无。

调用函数
无。

边界与不变量
第一人称提示只属于行动者；其他观看者只得到等待文案，不解析或替换私密文本。
*/
export function presentPrompt({ message, handHint = "", actorId = null }, viewerId) {
  return actorId && actorId !== viewerId
    ? { message: "等待另一名玩家行动", handHint: "对方正在选择手牌或技能" }
    : { message, handHint };
}
