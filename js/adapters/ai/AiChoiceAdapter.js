/*
模块职责
把 Application ChoiceRequest bridge 到既有 AIController 决策 API；只拥有 AI POLICY DECISION mechanism，不拥有 timing/presentation。

上游
composition boundary 的 AI ChoicePort wiring。

下游
既有 AI shouldRespond/choosePublicCard 门面。

状态边界
不写 GameState；只读 legacy snapshot registry。

信息边界
不把实体引用放进 ChoiceRequest；adapter 内部仅为 bridge 使用 legacy 实体。

架构约束
不得 import AIController、UIManager、SoundManager、Game runtime 或其它 concrete adapter。
*/
import { createChoiceResult } from "../../application/ports/ChoicePort.js?build=20260816-legacy-recovery";

/*
功能
创建纯 AI peer Choice adapter。

调用方
composition boundary。

输入
注入的 legacy context resolver、shouldRespond、choosePublicCard 与 isSessionValid。

输出
冻结 { request } adapter。

读取状态
无。

写入状态
无。

调用函数
createChoiceResult。

边界与不变量
不执行 delay/thinking/prompt；publicCard 只 bridge choosePublicCard。
*/
export function createAiChoiceAdapter({
  getLegacyContext,
  shouldRespond,
  choosePublicCard,
  chooseDiscards,
  isSessionValid
}) {
  if (typeof getLegacyContext !== "function" || typeof shouldRespond !== "function"
    || typeof choosePublicCard !== "function" || typeof chooseDiscards !== "function"
    || typeof isSessionValid !== "function") {
    throw new TypeError("AiChoiceAdapter 缺少必要 bridge capability");
  }
  return Object.freeze({
    /*
    功能
    调用既有 AI decision API 并返回 canonical ChoiceResult。

    调用方
    ChoicePort router 或 AiResponseTimingDecorator。

    输入
    data-only ChoiceRequest。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    legacy snapshot 与 AI decision boundary。

    写入状态
    无。

    调用函数
    getLegacyContext、shouldRespond、choosePublicCard、createChoiceResult。

    边界与不变量
    AI policy/search/planner 不变；不拥有 Application delay 或 presentation state。
    */
    async request(choiceRequest) {
      if (choiceRequest?.kind === "discard") {
        const legacy = getLegacyContext(choiceRequest.requestId);
        if (!legacy?.player || !Number.isFinite(legacy.count)) return createChoiceResult("cancelled");
        const cards = chooseDiscards(legacy.player, legacy.count);
        return cards?.length
          ? createChoiceResult("selected", { selectedIds: cards.slice(0, legacy.count).map((card) => card.id) })
          : createChoiceResult("declined");
      }
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
      if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
      const use = shouldRespond(
        legacy.responder,
        choiceRequest.constraints.responseType,
        legacy.context,
        legacy.cards
      );
      return createChoiceResult(use ? "selected" : "declined");
    }
  });
}
