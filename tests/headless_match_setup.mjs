/*
功能
在正式 roster 提交事件中把 headless 对局的全部参与者配置为 AI。

调用方
Balance runner 与功能测试中的 headless 初始化回归。

输入
已创建但尚未确认角色的 application，以及当前监听器唯一 key。

输出
EventDispatcher 返回的 unsubscribe 函数。

读取状态
teamAssigned 事件提供的 authoritative roster。

写入状态
仅写 Player participant metadata controllerType。

调用函数
application.eventDispatcher.on。

边界与不变量
不得在 startSelection 后猜测 roster 已存在；角色、阵营、牌堆和随机顺序仍只由 MatchWorkflow.confirmCharacter 决定。
*/
export function configureAllAiRoster(application, listenerKey) {
  return application.eventDispatcher.on("teamAssigned", listenerKey, (event) => {
    for (const player of event.players) player.controllerType = "ai";
  });
}
