/*
模块职责
把 Application response ChoiceRequest bridge 到既有 AIController.shouldRespond 决策门面；不重写 Planner/Simulator/Evaluator/Policy。

上游
composition root 的 AI choice port。

下游
既有 AI response decision API。

状态边界
不写 GameState；只读由 legacy snapshot registry 提供的绑定上下文。

信息边界
不把实体引用放进 ChoiceRequest；adapter 内部仅为 bridge 使用 legacy 实体。

架构约束
不得 import AIController、UIManager、SoundManager、Game runtime 或其它 concrete adapter。
*/
import { createChoiceResult } from "../../application/ports/ChoicePort.js?build=20260815-shadow-agent-p1-slot";

/*
功能
创建 AI peer Choice adapter。

调用方
composition root。

输入
注入的 legacy context resolver、AI shouldRespond/choosePublicCard、thinking/delay/session 能力。

输出
冻结的 { request } adapter。

读取状态
无。

写入状态
经注入的 setThinking 写既有 UI thinking 状态。

调用函数
createChoiceResult。

边界与不变量
delay 顺序、thinking 显示、session 取消与借势拒绝提示完全保持旧 ResponseSystem 行为；publicCard 只 bridge 既有 choosePublicCard。
*/
export function createAiChoiceAdapter({
  getLegacyContext,
  shouldRespond,
  choosePublicCard,
  isSessionValid,
  setThinking,
  delay,
  setPrompt
}) {
  if (typeof getLegacyContext !== "function" || typeof shouldRespond !== "function"
    || typeof choosePublicCard !== "function" || typeof isSessionValid !== "function"
    || typeof setThinking !== "function" || typeof delay !== "function"
    || typeof setPrompt !== "function") {
    throw new TypeError("AiChoiceAdapter 缺少必要 bridge capability");
  }
  return Object.freeze({
    /*
    功能
    把 data-only ChoiceRequest bridge 到既有 AI decision API，并返回 canonical ChoiceResult。

    调用方
    ChoicePort router。

    输入
    ChoiceRequest。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    注入的 legacy snapshot 与 AI 决策边界。

    写入状态
    经注入 setThinking 写 thinking 状态。

    调用函数
    getLegacyContext、shouldRespond、choosePublicCard、createChoiceResult。

    边界与不变量
    AI policy/search/planner 不变；timing 与 thinking 顺序不变。
    */
    async request(choiceRequest) {
      if (choiceRequest?.kind === "publicCard") {
        const legacy = getLegacyContext(choiceRequest.requestId);
        if (!legacy?.player || !Array.isArray(legacy.cards)) return createChoiceResult("cancelled");
        const card = choosePublicCard(legacy.player, legacy.cards);
        return card
          ? createChoiceResult("selected", { selectedIds:[card.id] })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind !== "response") return createChoiceResult("cancelled", { reason:"unsupported-choice-kind" });
      const legacy = getLegacyContext(choiceRequest.requestId);
      if (!legacy?.responder) return createChoiceResult("cancelled");
      setThinking(true, legacy.responder, `正在考虑是否${legacy.label}`);
      const waited = await delay();
      if (!waited || !isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
      const use = shouldRespond(
        legacy.responder,
        choiceRequest.constraints.responseType,
        legacy.context,
        legacy.cards
      );
      setThinking(false);
      if (!use && choiceRequest.constraints.responseType !== "leverageAssault") {
        setPrompt(`${legacy.responder.name}放弃${legacy.label}。`);
      }
      return createChoiceResult(use ? "selected" : "declined");
    }
  });
}
