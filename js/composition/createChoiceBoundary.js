/*
模块职责
为单局应用组合 human/AI peer Choice adapters，并按 participant metadata 路由到对应 port；这是窄 composition bridge，不是 service locator。

上游
MatchApplication constructor。

下游
application/choice、application/ports 与 adapters/ui、adapters/ai。

状态边界
只读显式注入的 state players；不写状态。

信息边界
不在 ChoiceRequest 中放入实体；adapter 的实体重绑由本模块提供窄闭包。

架构约束
不接收或回读应用对象；所有 concrete capability 由 composition root 显式注入。
*/
import { createChoiceCoordinator } from "../application/choice/ChoiceCoordinator.js";
import { createChoicePort, createChoiceResult } from "../application/ports/ChoicePort.js";
import { createAiChoiceAdapter } from "../adapters/ai/AiChoiceAdapter.js";
import { createAiResponseTimingDecorator } from "../application/response/AiResponseTimingDecorator.js";
import { createUiChoiceAdapter } from "../adapters/ui/UiChoiceAdapter.js";
import { getAiDelay } from "../utils/aiTiming.js";

/*
功能
创建单局 Choice boundary（port router 与 coordinator）。

调用方
MatchApplication constructor。

输入
dependencies（state/ui/choiceContexts/AI capability/lifecycle）与可选外部注入 choicePort。

输出
{ choicePort, choiceCoordinator }。

读取状态
显式注入 state players 与 ui/AI capability。

写入状态
无。

调用函数
createUiChoiceAdapter、createAiChoiceAdapter、createChoicePort、createChoiceCoordinator。

边界与不变量
外部注入 port 优先；否则按 controllerType 路由；未知 actor 返回 cancelled。
*/
export function createChoiceBoundary(dependencies, injectedPort = null) {
  const {
    state,
    ui,
    choiceContexts,
    isSessionValid,
    shouldRespond,
    choosePublicCard,
    chooseDiscards,
    chooseHiddenCards,
    chooseZoneCard,
    requestHiddenCards,
    requestZoneCard,
    resolveHiddenToken,
    resolveConfirmedHiddenTokens,
    isHiddenSelectionActive,
    clearHiddenSelection,
    cleanupDelay,
    getAiResponseDelay,
    now
  } = dependencies;
  if (injectedPort) {
    const choicePort = createChoicePort(injectedPort);
    return { choicePort, choiceCoordinator: createChoiceCoordinator(choicePort) };
  }
  const humanPort = createChoicePort(createUiChoiceAdapter({
    requestResponse: (request, label) => ui.requestResponse(request, label),
    requestPublicCard: (player, cards) => ui.requestPublicCard?.(player, cards),
    requestDiscard: (player, count, prompt) => ui.requestDiscard(player, count, prompt),
    requestTarget: (players, prompt, meta) => ui.requestTarget(players, prompt, meta),
    requestHiddenCards,
    requestZoneCard,
    resolveHiddenToken,
    resolveConfirmedHiddenTokens,
    isHiddenSelectionActive,
    clearHiddenSelection,
    getChoiceContext: (requestId) => choiceContexts.get(requestId),
    isSessionValid
  }));
  const rawAiPort = createChoicePort(createAiChoiceAdapter({
    getChoiceContext: (requestId) => choiceContexts.get(requestId),
    shouldRespond,
    choosePublicCard,
    chooseDiscards,
    chooseHiddenCards,
    chooseZoneCard,
    isSessionValid
  }));
  const aiPort = createChoicePort(createAiResponseTimingDecorator(rawAiPort, {
    getPlayer: (actorId) => state.players.find((player) => player.id === actorId),
    setThinking: (isThinking, player, message) => ui.setThinking(isThinking, player, message),
    delay: async (options) => cleanupDelay(getAiResponseDelay(options)),
    setPrompt: (message) => ui.setPrompt(message),
    isSessionValid,
    now
  }));
  const choicePort = createChoicePort({
    /*
    功能
    按 participant metadata 路由 ChoiceRequest 到 human 或 AI peer port。

    调用方
    createChoiceCoordinator。

    输入
    data-only ChoiceRequest。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    state.players 的 id/controllerType。

    写入状态
    无。

    调用函数
    createChoiceResult、humanPort.request、aiPort.request。

    边界与不变量
    不是 service locator；未知 actor 返回 cancelled。
    */
    async request(choiceRequest) {
      const actor = state.players.find((player) => player.id === choiceRequest?.actorId);
      if (!actor) return createChoiceResult("cancelled", { reason:"unknown-actor" });
      const port = actor.controllerType === "human" ? humanPort : aiPort;
      return port.request(choiceRequest);
    }
  });
  return { choicePort, choiceCoordinator: createChoiceCoordinator(choicePort) };
}
