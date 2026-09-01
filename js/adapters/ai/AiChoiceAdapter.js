/*
模块职责
把 Application ChoiceRequest bridge 到既有 AIController 响应与资源选择 API；只拥有 AI POLICY DECISION mechanism，不拥有 timing/presentation。

上游
composition boundary 的 AI ChoicePort wiring。

下游
既有 AI shouldRespond/choosePublicCard 门面。

状态边界
不写 GameState；只读 composition 提供的私有 choice context。

信息边界
不把实体引用放进 ChoiceRequest；adapter 仅在私有边界内重绑实体。

架构约束
不得 import AIController、UIManager、SoundManager、Game runtime 或其它 concrete adapter。
*/
import { createChoiceResult } from "../../application/ports/ChoicePort.js";

/*
功能
创建纯 AI peer Choice adapter。

调用方
composition boundary。

输入
注入的 choice context resolver、shouldRespond、choosePublicCard 与 isSessionValid。

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
  getChoiceContext,
  shouldRespond,
  choosePublicCard,
  chooseDiscards,
  chooseHiddenCards,
  isSessionValid
}) {
  if (typeof getChoiceContext !== "function" || typeof shouldRespond !== "function"
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
    私有 choice context 与 AI decision boundary。

    写入状态
    无。

    调用函数
    getChoiceContext、shouldRespond、choosePublicCard、createChoiceResult。

    边界与不变量
    AI policy/search/planner 不变；不拥有 Application delay 或 presentation state。
    */
    async request(choiceRequest) {
      if (choiceRequest?.kind === "hiddenCard") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.actor || !choiceContext?.owner
          || !isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        if (choiceRequest.constraints.mode === "zone") {
          return createChoiceResult("declined", { reason:"canonical-zone-selection-required" });
        }
        if (typeof chooseHiddenCards !== "function") {
          return createChoiceResult("cancelled", { reason:"hidden-card-adapter-unavailable" });
        }
        const cards = chooseHiddenCards(
          choiceContext.actor,
          choiceContext.owner,
          choiceRequest.constraints.requiredCount,
          choiceContext.excludedCardIds,
          choiceContext.aiContext
        );
        const selectedIds = [...new Set((cards ?? []).map((card) => card?.id).filter(Boolean))]
          .slice(0, choiceRequest.constraints.requiredCount);
        return selectedIds.length
          ? createChoiceResult("selected", { selectedIds })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind === "discard") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.player || !Number.isFinite(choiceContext.count)) return createChoiceResult("cancelled");
        const cards = chooseDiscards(choiceContext.player, choiceContext.count);
        return cards?.length
          ? createChoiceResult("selected", { selectedIds: cards.slice(0, choiceContext.count).map((card) => card.id) })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind === "publicCard") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.player || !Array.isArray(choiceContext.cards)) return createChoiceResult("cancelled");
        const card = choosePublicCard(choiceContext.player, choiceContext.cards);
        return card
          ? createChoiceResult("selected", { selectedIds:[card.id] })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind !== "response") return createChoiceResult("cancelled", { reason:"unsupported-choice-kind" });
      const choiceContext = getChoiceContext(choiceRequest.requestId);
      if (!choiceContext?.responder) return createChoiceResult("cancelled");
      if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
      // 候选不足时不进入 response policy，保留原有“不可用”策略语义；外层 timing decorator
      // 仍会在返回 declined 后补齐可观察等待，因此不会泄露这次没有对应手牌。
      if (choiceRequest.options.length < choiceRequest.constraints.requiredCount) {
        return createChoiceResult("declined");
      }
      const use = await shouldRespond(
        choiceContext.responder,
        choiceRequest.constraints.responseType,
        choiceContext.context,
        choiceContext.cards
      );
      if (use == null || !isSessionValid(choiceRequest.gameId)) {
        return createChoiceResult("cancelled");
      }
      return use
        ? createChoiceResult("selected", {
            selectedIds: choiceRequest.options
              .slice(0, choiceRequest.constraints.requiredCount)
              .map((option) => option.optionId)
          })
        : createChoiceResult("declined");
    }
  });
}
