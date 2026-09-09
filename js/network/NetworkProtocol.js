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

// Transport capability: createRoom({roomId}), joinRoom({address}), send(envelope),
// subscribe(receive) -> unsubscribe, close()。subscribe 只交付经身份认证的对端事件；
// roomId + sender + sequence 标识消息，revision 是 Host setup 快照版本。
// GAME_SNAPSHOT 仅携带 viewer-safe projection；DECISION_REQUEST/RESPONSE 与 PLAYER_INTENT
// 由游戏侧关联并验证，Transport 不解释决定，也不得把消息 sender 覆盖为 CAPABILITY。
// 无 capability 时仅能创建本地等待会话，不伪造连接或决定。
