import { makeGame, makeCard, disposeGame } from "./ai_test_helpers.mjs";
import { createInitialWorld } from "../js/ai/Simulator/World.js";
import { deriveCurrentCardCounts } from "../js/ai/Event/Fact.js";

/*
功能
构造固定的正式 Search 请求，覆盖隐藏手牌、反事实与闪电计算。

调用方
Compute Worker 定向测试与性能 probe。

输入
无。

输出
经过正式 World/Generator 边界的 data-only request。

读取状态
独立测试 Game。

写入状态
仅构造并释放测试 Game。

调用函数
makeGame、createInitialWorld、deriveCurrentCardCounts、getActionCandidates、disposeGame。

边界与不变量
固定实体和 RNG；不运行对局或平衡评估。
*/
export function makeComputeSearchRequest() {
  const game = makeGame({
    players: [
      { id: "a", team: "dawn", character: "shade-agent", energy: 4,
        hand: ["assault", "exposeWeakness", "lightning", "plunder", "recover"]
          .map((id, index) => makeCard(id, `a-${index}`)) },
      { id: "b", team: "dusk", character: "oath-warden", energy: 2,
        hand: [makeCard("block", "b-0"), makeCard("counter", "b-1")] },
      { id: "c", team: "dawn", character: "spirit-medic", energy: 1, hp: 3 },
      { id: "d", team: "dusk", character: "fate-gambler", energy: 1,
        hand: [makeCard("recover", "d-0")], statuses: { lightning: true } },
      { id: "e", team: "dusk", character: "blade-walker", energy: 1 }
    ],
    options: { actorId: "a", seed: 2731, nodeBudget: 1000 }
  });
  try {
    game.state.gameId = "compute-fixture";
    const actor = game.state.players[0];
    const world = createInitialWorld(actor.id, game.state, deriveCurrentCardCounts(actor, game.state));
    return {
      requestId: "compute-search", gameId: world.gameId, actorId: actor.id, world,
      rootActions: game.aiController.getActionCandidates(actor, world),
      searchConfig: game.aiController.buildSearchConfig(),
      rng: { algorithm: "lcg", seed: 2731, state: 2731, draws: 0 }
    };
  } finally {
    disposeGame(game);
  }
}
