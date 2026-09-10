export const NETWORK_CAPABILITY_SENDER = "CAPABILITY";
export const NETWORK_ROLE = Object.freeze({ HOST: "HOST", GUEST: "GUEST" });
export const NETWORK_EVENT = Object.freeze({
  ROOM_CREATED: "ROOM_CREATED",
  PEER_CONNECTED: "PEER_CONNECTED",
  ROLE_POOL_ASSIGNED: "ROLE_POOL_ASSIGNED",
  SELECTION_CHANGED: "SELECTION_CHANGED",
  SELECTION_CONFIRMED: "SELECTION_CONFIRMED",
  PEER_READY: "PEER_READY",
  GAME_READY: "GAME_READY",
  MATCH_START: "MATCH_START",
  GAME_SNAPSHOT: "GAME_SNAPSHOT",
  DECISION_REQUEST: "DECISION_REQUEST",
  DECISION_RESPONSE: "DECISION_RESPONSE",
  DECISION_CANCELLED: "DECISION_CANCELLED",
  PLAYER_INTENT: "PLAYER_INTENT",
  REMOTE_DECISION: "REMOTE_DECISION",
  DISCONNECTED: "DISCONNECTED",
  ERROR: "ERROR"
});

// Transport capability: createRoom({roomId}) -> {roomId, connectionInfo: {host, port} | null},
// joinRoom({host, port}) -> {roomId}, send(envelope),
// subscribe(receive) -> unsubscribe, close()。subscribe 只交付经身份认证的对端事件；
// connectionId 必须由 Transport 按真实连接覆盖注入，不得直接沿用客户端报文中的同名字段。
// roomId + connectionId + sequence 标识消息；participantId 必须匹配 Host 保存的连接映射。
// Host 的 recipientParticipantId 指定唯一接收成员；Transport 不可把私有消息广播给其他 Guest。
// PEER_CONNECTED 的 remoteAddress 由 Transport 注入；无元数据的既有连接使用 default 标识。
// revision 是 Host 房间快照版本；Guest 身份由首个定向房间快照的接收人确定。
// GAME_SNAPSHOT 仅携带 viewer-safe projection；DECISION_REQUEST/RESPONSE 与 PLAYER_INTENT
// 由游戏侧关联并验证，Transport 不解释决定，也不得把消息 sender 覆盖为 CAPABILITY。
// 无 capability 时可由 Host 准备单真人房间，但不伪造远端连接或决定。
export const NETWORK_DEFAULT_PORT = 38520;

/*
功能
统一格式化 Transport 注入的远端地址。

调用方
NetworkSquadSelectionView。

输入
remoteAddress 字符串或 null。

输出
展示地址或未知占位。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只移除 IPv4-mapped IPv6 前缀，不查询网卡、Socket 或网络。
*/
export function formatNetworkAddress(remoteAddress) {
  if (typeof remoteAddress !== "string" || !remoteAddress.trim()) return "地址未提供";
  return remoteAddress.trim().replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, "");
}

// Shared UI/Transport boundary; hostnames are resolved by the Transport.
export function normalizeNetworkEndpoint({ host, port } = {}) {
  if (typeof host !== "string" || !host.trim()) throw new Error("请输入 IP 地址或主机名");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口须为 1–65535 的整数");
  return { host: host.trim(), port };
}
