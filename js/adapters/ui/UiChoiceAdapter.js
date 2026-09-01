/*
模块职责
把 Application ChoiceRequest bridge 到既有 UIManager session request API；不改 UI 渲染或交互语义。

上游
composition root 的 human choice port。

下游
现有 UI session 的 requestResponse。

状态边界
不写 GameState；只在 composition 私有 context 内把隐藏 token 重绑为当前 Card ID。

信息边界
ChoiceRequest 只含 data-only facts；Player/Card 实体不离开私有 adapter context。

架构约束
不得 import UIManager、AIController、SoundManager、Game runtime 或其它 concrete adapter。
*/
import { createChoiceResult, normalizeChoiceResult } from "../../application/ports/ChoicePort.js";

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
  requestHiddenCards,
  requestZoneCard,
  resolveHiddenToken,
  resolveConfirmedHiddenTokens,
  isHiddenSelectionActive,
  clearHiddenSelection,
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
    ChoiceRequest 及私有 choice context 中的合法展示用途。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    注入的私有 choice context。

    写入状态
    无。

    调用函数
    requestResponse、requestPublicCard、normalizeChoiceResult、createChoiceResult。

    边界与不变量
    response actor 与 effect target 必须分别来自 actorId/context.targetPlayerId；转移只传递排序意图，
    不携带隐藏牌定义；不改 UI 交互、超时或取消语义。
    */
    async request(choiceRequest) {
      if (choiceRequest?.kind === "hiddenCard") {
        const choiceContext = getChoiceContext(choiceRequest.requestId);
        if (!choiceContext?.actor || !choiceContext?.owner) return createChoiceResult("cancelled");
        const maximum = choiceRequest.constraints.requiredCount;
        if (choiceRequest.constraints.mode === "zone") {
          if (typeof requestZoneCard !== "function" || typeof resolveHiddenToken !== "function"
            || typeof isHiddenSelectionActive !== "function" || typeof clearHiddenSelection !== "function") {
            return createChoiceResult("cancelled", { reason:"hidden-zone-adapter-unavailable" });
          }
          const selection = await requestZoneCard(
            choiceContext.actor,
            choiceContext.owner,
            choiceContext.reason,
            choiceContext.excludedCardIds,
            { canDecline: choiceRequest.canDecline }
          );
          if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
          if (!selection?.selectionId) return createChoiceResult("declined");
          try {
            if (!isHiddenSelectionActive(selection.selectionId, choiceContext.owner)) {
              return createChoiceResult("declined");
            }
            if (selection.zone === "equipment") {
              const equipment = choiceContext.owner.equipment;
              return equipment?.id === selection.equipmentCardId
                ? createChoiceResult("selected", { selectedIds:[equipment.id] })
                : createChoiceResult("declined");
            }
            const card = resolveHiddenToken(
              selection.tokens?.[0],
              choiceContext.owner,
              selection.selectionId
            );
            return card
              ? createChoiceResult("selected", { selectedIds:[card.id] })
              : createChoiceResult("declined");
          } finally {
            clearHiddenSelection(selection.selectionId);
          }
        }
        if (typeof requestHiddenCards !== "function" || !choiceContext.selection) {
          return createChoiceResult("cancelled", { reason:"hidden-card-adapter-unavailable" });
        }
        const tokens = await requestHiddenCards(
          choiceContext.selection,
          maximum,
          choiceContext.reason,
          {
            exact: choiceContext.exact,
            viewer: choiceContext.actor,
            owner: choiceContext.owner,
            orderZoneSelection: choiceContext.aiContext?.purpose === "transfer",
            canDecline: choiceRequest.canDecline
          }
        );
        if (!isSessionValid(choiceRequest.gameId)) return createChoiceResult("cancelled");
        const cards = choiceContext.confirmed
          ? resolveConfirmedHiddenTokens?.(
            tokens,
            choiceContext.owner,
            choiceContext.selection.selectionId,
            maximum
          ) ?? []
          : [...new Set(tokens ?? [])].slice(0, maximum)
            .map((token) => resolveHiddenToken?.(
              token,
              choiceContext.owner,
              choiceContext.selection.selectionId
            ))
            .filter(Boolean);
        const selectedIds = [...new Set(cards.map((card) => card.id))];
        return selectedIds.length
          ? createChoiceResult("selected", { selectedIds })
          : createChoiceResult("declined");
      }
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
        targetPlayerId: context.targetPlayerId,
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
