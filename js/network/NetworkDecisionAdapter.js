import { createChoiceResult } from "../application/ports/ChoicePort.js";

/*
功能
适配远端真人的隐藏选择令牌并复用现有重绑 authority。

调用方
createChoiceBoundary。

输入
远端 request capability、context getter 和 hiddenSelection capabilities。

输出
ChoicePort。

读取状态
私有 choice context 与隐藏选择会话。

写入状态
仅 zone 请求临时 token session。

调用函数
requestRemote、resolveHiddenToken、resolveConfirmedHiddenTokens、clearHiddenSelection。

边界与不变量
远端不能提交未知实体 ID 替代 token；只有 Host 确认已知的牌才展示牌面。
*/
export function createNetworkChoiceAdapter({
  requestRemote, getChoiceContext, createHiddenSelection, resolveHiddenToken,
  resolveConfirmedHiddenTokens, isHiddenSelectionActive, clearHiddenSelection, isSessionValid
}) {
  return Object.freeze({
    /*
功能
发送远端 ChoiceRequest，并在返回后将合法 token 转成 canonical selectedIds。

调用方
PlayerControlRouter。

输入
data-only ChoiceRequest。

输出
ChoiceResult Promise。

读取状态
request、私有 owner/selection。

写入状态
临时隐藏选择 session。

调用函数
requestRemote 与 hiddenSelection capabilities。

边界与不变量
zone 自建会话必须 finally 清理；其他选择继续交原 workflow 重验。
*/
    async request(request) {
      if (request.kind !== "hiddenCard") return requestRemote(request);
      const context = getChoiceContext(request.requestId);
      if (!context?.owner) return createChoiceResult("cancelled");
      const zone = request.constraints.mode === "zone";
      const selection = zone ? createHiddenSelection(context.owner) : context.selection;
      if (!selection) return createChoiceResult("cancelled");
      try {
        const tokens = selection.tokens.filter((entry) => {
          const card = resolveHiddenToken(entry.token, context.owner, selection.selectionId);
          return card && !context.excludedCardIds?.has(card.id);
        }).map((entry) => entry.token);
        const equipment = zone ? context.owner.equipment : null;
        const equipmentId = equipment && !context.excludedCardIds?.has(equipment.id) ? equipment.id : null;
        const result = await requestRemote({
          ...request, optionIds: [...tokens, ...(equipmentId ? [equipmentId] : [])],
          // 位置只交给 Host bridge 关联既有知识；不进入 Guest 的有限选项 payload。
          selection: { tokens: selection.tokens.filter((entry) => tokens.includes(entry.token)) }
        });
        if (!isSessionValid(request.gameId) || !isHiddenSelectionActive(selection.selectionId, context.owner)) return createChoiceResult("cancelled");
        if (result?.status !== "selected") return createChoiceResult(result?.status === "declined" ? "declined" : "cancelled");
        const selected = [...new Set(result.selectedIds ?? [])].slice(0, request.constraints.requiredCount);
        if (zone && selected[0] === equipmentId && equipmentId && context.owner.equipment === equipment) {
          return createChoiceResult("selected", { selectedIds: [equipmentId] });
        }
        const allowed = selected.filter((id) => tokens.includes(id));
        const cards = context.confirmed
          ? resolveConfirmedHiddenTokens(allowed, context.owner, selection.selectionId, request.constraints.requiredCount)
          : allowed.map((token) => resolveHiddenToken(token, context.owner, selection.selectionId)).filter(Boolean);
        return createChoiceResult(cards.length ? "selected" : "declined", { selectedIds: cards.map((card) => card.id) });
      } finally {
        if (zone) clearHiddenSelection(selection.selectionId);
      }
    }
  });
}
