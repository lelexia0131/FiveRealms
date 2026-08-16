/**
 * Application Messaging EventDispatcher 的 legacy compatibility façade。
 * 真实 listener registry/dispatch/generation 语义已迁至 js/application/messaging/EventDispatcher.js。
 */
export { EventDispatcher as EventBus } from "../application/messaging/EventDispatcher.js?build=20260815-shadow-agent-p1-slot";
