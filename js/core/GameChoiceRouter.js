/*
模块职责
为单局 Game 组合 human/AI peer Choice adapters，并按 participant metadata 路由到对应 port；这是 composition-owned router，不是 service locator。

上游
Game 构造函数。

下游
application/choice、application/ports 与 adapters/ui、adapters/ai。

状态边界
只读 game.state.players 的 controllerType/identity；不写状态。

信息边界
不在 ChoiceRequest 中放入实体；adapter 内部 legacy rebind 由本模块提供窄闭包。

架构约束
最终 owner 是 composition wiring；当前 Game 仍是单局 composition root，所以物理上暂留此 bridge。main.js 成为唯一 composition root 时删除本文件。允许导入 concrete adapters；application/choice 仍禁止 concrete adapter import。
*/
import { createChoiceCoordinator } from "../application/choice/ChoiceCoordinator.js?build=20260815-shadow-agent-p1-slot";
import { createChoicePort, createChoiceResult } from "../application/ports/ChoicePort.js?build=20260815-shadow-agent-p1-slot";
import { createAiChoiceAdapter } from "../adapters/ai/AiChoiceAdapter.js?build=20260815-shadow-agent-p1-slot";
import { createAiResponseTimingDecorator } from "../application/response/AiResponseTimingDecorator.js?build=20260815-shadow-agent-p1-slot";
import { createUiChoiceAdapter } from "../adapters/ui/UiChoiceAdapter.js?build=20260815-shadow-agent-p1-slot";
import { getAiDelay } from "../utils/aiTiming.js?build=20260815-shadow-agent-p1-slot";

/*
功能
创建单局 Choice boundary（port router 与 coordinator）。

调用方
Game 构造函数。

输入
game、choiceContexts registry 与可选外部注入 choicePort。

输出
{ choicePort, choiceCoordinator }。

读取状态
game.state.players 与 game.ui/aiController 门面。

写入状态
无。

调用函数
createUiChoiceAdapter、createAiChoiceAdapter、createChoicePort、createChoiceCoordinator。

边界与不变量
外部注入 port 优先；否则按 controllerType 路由；未知 actor 返回 cancelled。
*/
export function createGameChoiceBoundary(game, choiceContexts, injectedPort = null) {
  if (injectedPort) {
    const choicePort = createChoicePort(injectedPort);
    return { choicePort, choiceCoordinator: createChoiceCoordinator(choicePort) };
  }
  const humanPort = createChoicePort(createUiChoiceAdapter({
    requestResponse: (request, label) => game.ui.requestResponse(request, label),
    requestPublicCard: (player, cards) => game.ui.requestPublicCard?.(player, cards),
    getLegacyContext: (requestId) => choiceContexts.get(requestId),
    isSessionValid: (gameId) => game.isSessionValid(gameId)
  }));
  const rawAiPort = createChoicePort(createAiChoiceAdapter({
    getLegacyContext: (requestId) => choiceContexts.get(requestId),
    shouldRespond: (responder, type, context, cards) => game.aiController.shouldRespond(responder, type, context, cards),
    choosePublicCard: (player, cards) => game.aiController.choosePublicCard(player, cards),
    isSessionValid: (gameId) => game.isSessionValid(gameId)
  }));
  const aiPort = createChoicePort(createAiResponseTimingDecorator(rawAiPort, {
    getPlayer: (actorId) => game.state.players.find((player) => player.id === actorId),
    setThinking: (isThinking, player, message) => game.ui.setThinking(isThinking, player, message),
    delay: async () => game.cleanupManager.delay(getAiDelay(game, "response")),
    setPrompt: (message) => game.ui.setPrompt(message),
    isSessionValid: (gameId) => game.isSessionValid(gameId)
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
    game.state.players 的 id/controllerType。

    写入状态
    无。

    调用函数
    createChoiceResult、humanPort.request、aiPort.request。

    边界与不变量
    不是 service locator；未知 actor 返回 cancelled。
    */
    async request(choiceRequest) {
      const actor = game.state.players.find((player) => player.id === choiceRequest?.actorId);
      if (!actor) return createChoiceResult("cancelled", { reason:"unknown-actor" });
      const port = actor.controllerType === "human" ? humanPort : aiPort;
      return port.request(choiceRequest);
    }
  });
  return { choicePort, choiceCoordinator: createChoiceCoordinator(choicePort) };
}
