/*
模块职责
把 Application response ChoiceRequest bridge 到既有 UIManager session request API；不改 UI 渲染或交互语义。

上游
composition root 的 human choice port。

下游
现有 UI session 的 requestResponse。

状态边界
不读写真 GameState；不接触 Card/Player 实体。

信息边界
只把 data-only ChoiceRequest 映射为 UI session request。

架构约束
不得 import UIManager、AIController、SoundManager、Game runtime 或其它 concrete adapter。
*/
import { createChoiceResult, normalizeChoiceResult } from "../../application/ports/ChoicePort.js?build=20260818-skill-rules-locality-refactor";

/*
功能
创建 human peer Choice adapter。

调用方
composition root。

输入
注入的 requestResponse、requestPublicCard、getChoiceContext 与 isSessionValid 能力。

输出
冻结的 { request } adapter。

读取状态
无。

写入状态
无。

调用函数
normalizeChoiceResult、createChoiceResult。

边界与不变量
response 请求字段与 UI session request 保持逐项映射；publicCard 经私有 choice context 解析实体；session 失效必须返回 cancelled。
*/
export function createUiChoiceAdapter({
  requestResponse,
  requestPublicCard,
  requestDiscard,
  requestTarget,
  getChoiceContext,
  isSessionValid
}) {
  if (typeof requestResponse !== "function" || typeof isSessionValid !== "function") {
    throw new TypeError("UiChoiceAdapter 需要 requestResponse 与 isSessionValid");
  }
  if (typeof requestPublicCard !== "function" || typeof getChoiceContext !== "function") {
    throw new TypeError("UiChoiceAdapter 需要 requestPublicCard 与 getChoiceContext");
  }
  if (typeof requestDiscard !== "function" || typeof requestTarget !== "function") {
    throw new TypeError("UiChoiceAdapter 需要 requestDiscard 与 requestTarget");
  }
  return Object.freeze({
    /*
    功能
    把 data-only ChoiceRequest bridge 到既有 UI request，并返回 canonical ChoiceResult。

    调用方
    ChoicePort router。

    输入
    ChoiceRequest。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    注入的私有 choice context。

    写入状态
    无。

    调用函数
    requestResponse、requestPublicCard、normalizeChoiceResult、createChoiceResult。

    边界与不变量
    不改 UI 交互、超时或取消语义。
    */
    async request(choiceRequest) {
      if (choiceRequest?.kind === "publicCard") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.player || !Array.isArray(choiceContext.cards)) return createChoiceResult("cancelled");
        const card = await requestPublicCard(choiceContext.player, choiceContext.cards);
        if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        return card
          ? createChoiceResult("selected", { selectedIds:[card.id] })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind === "discard") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.player || !Number.isFinite(choiceContext.count)) return createChoiceResult("cancelled");
        const cards = await requestDiscard(choiceContext.player, choiceContext.count, choiceContext.prompt);
        if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        return cards?.length
          ? createChoiceResult("selected", { selectedIds: cards.slice(0, choiceContext.count).map((card) => card.id) })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind === "target") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.players) return createChoiceResult("cancelled");
        const target = await requestTarget(choiceContext.players, choiceContext.prompt, choiceContext.meta);
        if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        return target
          ? createChoiceResult("selected", { selectedIds:[target.id] })
          : createChoiceResult("declined");
      }
      if (choiceRequest?.kind !== "response") return createChoiceResult("cancelled", { reason:"unsupported-choice-kind" });
      const { constraints, context } = choiceRequest;
      const responseRequest = {
        id: choiceRequest.requestId,
        type: constraints.responseType,
        sourcePlayerId: context.sourcePlayerId,
        targetPlayerId: choiceRequest.actorId,
        cardId: context.cardId,
        legalCardIds: choiceRequest.options.map((option) => option.optionId),
        requiredCount: constraints.requiredCount,
        legalSkillIds: [],
        timeoutMs: context.timeoutMs,
        allowDecline: choiceRequest.canDecline,
        presentation: context.presentation
      };
      const decision = await requestResponse(responseRequest, context.label);
      return isSessionValid(choiceRequest.gameId)
        ? normalizeChoiceResult(decision)
        : createChoiceResult("cancelled");
    }
  });
}
