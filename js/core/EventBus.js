/**
 * 本文件实现异步事件总线，技能系统依赖它观察并修改结算上下文。
 * 它不解释事件含义、不直接修改玩家，也不处理 UI；事件递归深度有限制以阻止技能死循环。
 * 重新开始必须调用 clear，避免旧角色监听器进入新对局。
 */
import { Debug } from "../utils/debug.js?build=20260807-burning-field-2x-v115";

export class EventBus {
  constructor(isActive = () => true) {
    /** @type {Map<string, Map<string, Function>>} */
    this.listeners = new Map();
    this.depth = 0;
    this.maxDepth = 24;
    this.generation = 0;
    this.isActive = isActive;
  }

  /**
   * 注册具名监听器。同一事件和 key 只能存在一个监听器，重复注册会覆盖旧实现。
   * @param {string} eventName 事件名。
   * @param {string} key 稳定的唯一键，通常包含玩家 ID 与技能 ID。
   * @param {(event:Object)=>Promise<void>|void} handler 可异步修改事件对象的处理器。
   * @returns {Function} 取消注册函数。
   */
  on(eventName, key, handler) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Map());
    this.listeners.get(eventName).set(key, handler);
    Debug.log("EventBus", `注册 ${eventName}:${key}`);
    return () => this.listeners.get(eventName)?.delete(key);
  }

  /**
   * 依注册顺序异步触发事件。处理器共享同一对象，因此前一技能的修改对后一技能可见。
   * @param {string} eventName 事件名。
   * @param {Object} event 可修改的结算上下文。
   * @returns {Promise<Object>} 修改后的同一事件对象。
   */
  async emit(eventName, event = {}) {
    if (!this.isActive()) return event;
    if (this.depth >= this.maxDepth) throw new Error(`事件递归超过安全深度：${eventName}`);
    const handlers = [...(this.listeners.get(eventName)?.values() ?? [])];
    const generation = this.generation;
    Debug.log("EventBus", `触发 ${eventName}`, event);
    this.depth += 1;
    try {
      for (const handler of handlers) {
        if (!this.isActive() || generation !== this.generation) break;
        await handler(event);
        if (!this.isActive() || generation !== this.generation) break;
      }
    } finally {
      this.depth = Math.max(0, this.depth - 1);
    }
    return event;
  }

  /** 清空全部监听器；重新开始和销毁对局时调用。 */
  clear() {
    this.listeners.clear();
    this.generation += 1;
  }
}
