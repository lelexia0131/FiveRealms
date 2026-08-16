/*
模块职责
唯一拥有 Application Messaging propagation：keyed listener registry、sequential await dispatch、mutable Hook propagation、immutable Fact propagation、generation/clear/session guard。不解释事件业务含义，不拥有 trigger rule 或 presentation。

上游
core/EventBus legacy façade 与 Game temporary composition root。

下游
Application workflows/triggers。

状态边界
只写自身 listener registry/depth/generation；不写 Domain state。

信息边界
只传播 caller payload；不读取或解释 hidden info。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、Debug、DOM 或 concrete adapters；不 import Domain events builder。
*/

/*
功能
创建并返回 EventDispatcher 实例。

调用方
Game temporary composition root。

输入
isActive session guard 与可选 trace collaborator。

输出
EventDispatcher。

读取状态
无。

写入状态
listener registry/depth/generation。

调用函数
无。

边界与不变量
完全保留旧 EventBus 的 same-key overwrite、registration order、shared mutable object、sequential await、maxDepth=24、generation clear 语义。
*/
export class EventDispatcher {
  /*
  功能
  创建 dispatcher 并初始化 listener registry/session guard。

  调用方
  Game temporary composition。

  输入
  isActive 与 trace。

  输出
  EventDispatcher。

  读取状态
  无。

  写入状态
  listeners/depth/generation。

  调用函数
  无。

  边界与不变量
  maxDepth 固定 24。
  */
  constructor(isActive = () => true, trace = null) {
    this.listeners = new Map();
    this.depth = 0;
    this.maxDepth = 24;
    this.generation = 0;
    this.isActive = isActive;
    this.trace = typeof trace === "function" ? trace : () => { };
  }

  /*
  功能
  注册 keyed listener。

  调用方
  Application Trigger/legacy Game。

  输入
  eventName、key 与 handler。

  输出
  unsubscribe 函数。

  读取状态
  listeners。

  写入状态
  listeners。

  调用函数
  Map。

  边界与不变量
  同 event+key 覆盖旧 handler。
  */
  on(eventName, key, handler) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Map());
    this.listeners.get(eventName).set(key, handler);
    this.trace("EventBus", `注册 ${eventName}:${key}`);
    return () => this.listeners.get(eventName)?.delete(key);
  }

  /*
  功能
  按顺序异步传播一个 mutable Application Hook。

  调用方
  Application workflows。

  输入
  eventName 与 shared mutable payload。

  输出
  同一 payload object。

  读取状态
  listeners/generation/depth/isActive。

  写入状态
  depth。

  调用函数
  trace。

  边界与不变量
  前一 handler 修改必须对后一 handler 可见；clear 后停止后续；深度超限抛错。
  */
  async dispatchHook(eventName, event = {}) {
    if (!this.isActive()) return event;
    if (this.depth >= this.maxDepth) throw new Error(`事件递归超过安全深度：${eventName}`);
    const handlers = [...(this.listeners.get(eventName)?.values() ?? [])];
    const generation = this.generation;
    this.trace("EventBus", `触发 ${eventName}`, event);
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

  /*
  功能
  冻结并传播一个 immutable Application/Domain fact。

  调用方
  Application workflows。

  输入
  eventName 与 data-only fact。

  输出
  冻结 fact。

  读取状态
  listeners/generation/depth/isActive。

  写入状态
  depth。

  调用函数
  Object.freeze、dispatchHook。

  边界与不变量
  fact 只传播一次；不创建第二 registry。
  */
  async publishFact(eventName, fact = {}) {
    const frozen = Object.freeze({ ...fact });
    await this.dispatchHook(eventName, frozen);
    return frozen;
  }

  /*
  功能
  兼容旧 EventBus.emit 入口，语义等于 dispatchHook。

  调用方
  legacy Game/Response/Dying/Judgment façades。

  输入
  eventName 与 payload。

  输出
  payload。

  读取状态
  dispatcher registry。

  写入状态
  depth。

  调用函数
  dispatchHook。

  边界与不变量
  不创建第二 registry。
  */
  async emit(eventName, event = {}) {
    return this.dispatchHook(eventName, event);
  }

  /*
  功能
  清空全部监听器并推进 generation。

  调用方
  MatchWorkflow.dispose。

  输入
  无。

  输出
  无。

  读取状态
  listeners/generation。

  写入状态
  listeners/generation。

  调用函数
  Map.clear。

  边界与不变量
  active dispatch 快照因此失效。
  */
  clear() {
    this.listeners.clear();
    this.generation += 1;
  }
}
