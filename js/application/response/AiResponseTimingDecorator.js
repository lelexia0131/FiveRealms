/*
模块职责
拥有 AI response Choice 的 Application timing/presentation decorator：thinking on -> inner AI decision -> elapsed-aware delay -> thinking off -> result presentation；不拥有 AI policy。

上游
composition boundary 的 AI ChoicePort wiring。

下游
adapters/ai/AiChoiceAdapter 的纯决策结果。

状态边界
不写 GameState；只经注入 presentation/delay 能力写既有 UI 状态。

信息边界
不新增 response context；label/actor 只用于既有提示。

架构约束
不得依赖 concrete UI/AI、Game runtime、DOM 或 EventDispatcher。
*/
import { createChoiceResult } from "../ports/ChoicePort.js";

/*
功能
创建带 Application Response timing 的 AI ChoicePort decorator。

调用方
composition choice boundary。

输入
inner AI decision port 与 presentation/delay/session 能力。

输出
冻结 { request } port。

读取状态
无。

写入状态
经注入 setThinking/setPrompt 写 presentation 状态。

调用函数
createChoiceResult。

边界与不变量
只有 kind=response 装饰 timing；publicCard 直通；真实决策耗时必须从 planned presentation pacing 中扣除。
*/
export function createAiResponseTimingDecorator(innerPort, {
  getPlayer,
  setThinking,
  delay,
  setPrompt,
  isSessionValid,
  now
}) {
  if (typeof innerPort?.request !== "function" || typeof getPlayer !== "function"
    || typeof setThinking !== "function" || typeof delay !== "function"
    || typeof setPrompt !== "function" || typeof isSessionValid !== "function"
    || typeof now !== "function") {
    throw new TypeError("AiResponseTimingDecorator 缺少必要 capability");
  }
  return Object.freeze({
    /*
    功能
    执行 AI response timing 序列并转发决策。

    调用方
    ChoicePort router。

    输入
    data-only ChoiceRequest。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    request 与注入能力。

    写入状态
    thinking/prompt。

    调用函数
    innerPort.request、createChoiceResult。

    边界与不变量
    thinking on 必须早于 AI decision；decision 完成后才按真实 elapsed 补足 delay；cancelled/异常/失效时也必须在 finally 清除 thinking。
    */
    async request(choiceRequest) {
      if (choiceRequest?.kind !== "response") return innerPort.request(choiceRequest);
      const actor = getPlayer(choiceRequest.actorId);
      if (!actor) return createChoiceResult("cancelled", { reason:"unknown-actor" });
      const label = choiceRequest.context?.label ?? "";
      setThinking(true, actor, `正在考虑是否${label}`);
      const startedAt = now();
      try {
        const result = await innerPort.request(choiceRequest);
        if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        const elapsedMs = Math.max(0, now() - startedAt);
        const waited = await delay({ elapsedMs });
        if (!waited || !isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        if (result.status === "declined" && choiceRequest.constraints.responseType !== "leverageAssault") {
          setPrompt(`${actor.name}放弃${label}。`);
        }
        return result;
      } finally {
        setThinking(false);
      }
    }
  });
}
