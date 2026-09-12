export const NETWORK_STATE = Object.freeze({
  IDLE: "IDLE", CREATING: "CREATING", JOINING: "JOINING",
  WAITING_PEER: "WAITING_PEER", SELECTING: "SELECTING",
  WAITING_REMOTE: "WAITING_REMOTE", LOADING_GAME: "LOADING_GAME",
  IN_GAME: "IN_GAME", DISCONNECTED: "DISCONNECTED"
});
const TRANSITIONS = Object.freeze({
  IDLE: ["CREATING", "JOINING"],
  CREATING: ["WAITING_PEER", "DISCONNECTED", "IDLE"],
  JOINING: ["WAITING_PEER", "DISCONNECTED", "IDLE"],
  WAITING_PEER: ["SELECTING", "DISCONNECTED", "IDLE"],
  SELECTING: ["WAITING_REMOTE", "LOADING_GAME", "DISCONNECTED", "IDLE"],
  WAITING_REMOTE: ["SELECTING", "LOADING_GAME", "DISCONNECTED", "IDLE"],
  LOADING_GAME: ["IN_GAME", "DISCONNECTED", "IDLE"],
  IN_GAME: ["SELECTING", "DISCONNECTED", "IDLE"],
  DISCONNECTED: ["SELECTING", "WAITING_PEER", "IDLE"]
});

/*
功能
校验 NetworkSession 的合法状态转移。

调用方
NetworkSession。

输入
当前和目标状态。

输出
目标状态；非法转移抛错。

读取状态
TRANSITIONS。

写入状态
无。

调用函数
无。

边界与不变量
允许幂等通知，不允许绕过连接与两道准备屏障。
*/
export function transitionNetworkState(current, next) {
  if (current !== next && !TRANSITIONS[current]?.includes(next)) {
    throw new Error(`非法 Network transition：${current} → ${next}`);
  }
  return next;
}
