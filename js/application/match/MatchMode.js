export const MATCH_MODE = Object.freeze({ SINGLEPLAYER: "singleplayer", NETWORK: "network" });

/*
功能
判断对局是否参与永久成就与历史体系。

调用方
composition、UIManager。

输入
正式 Match mode；省略表示既有单人局。

输出
布尔值；未知模式抛错。

读取状态
MATCH_MODE。

写入状态
无。

调用函数
无。

边界与不变量
成就与历史共享资格，不维护独立开关。
*/
export function isMatchPersistenceEligible(mode = MATCH_MODE.SINGLEPLAYER) {
  if (!Object.values(MATCH_MODE).includes(mode)) throw new TypeError("未知游玩方式");
  return mode === MATCH_MODE.SINGLEPLAYER;
}
