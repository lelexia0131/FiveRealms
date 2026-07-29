import { createAiVisibleState } from "./AiVisibleState.js";
import { AiKnowledge } from "./AiKnowledge.js";
import { AiCardSelector } from "./AiCardSelector.js";
import { AiResponsePolicy } from "./AiResponsePolicy.js";
import { AiActionGenerator } from "./AiActionGenerator.js";
import { AiEvaluator } from "./AiEvaluator.js";
import { AiPlanner } from "./AiPlanner.js";

/** AI 门面：负责组合生成、知识、评估、规划、响应和选牌模块。 */
export class AIController {
  constructor(game) {
    this.game = game;
    this.knowledge = new AiKnowledge(game);
    this.evaluator = new AiEvaluator(game);
    this.cardSelector = new AiCardSelector(game, this.knowledge);
    this.responsePolicy = new AiResponsePolicy(game, this.evaluator, this.knowledge);
    this.actionGenerator = new AiActionGenerator(game);
    this.planner = new AiPlanner(game, this.evaluator);
  }

  getLegalActions(player) { return this.actionGenerator.generate(player); }
  async selectAction(player, options = {}) {
    const visible = createAiVisibleState(player.id, this.game.state);
    return this.planner.plan(player, visible, this.getLegalActions(player), options);
  }
  chooseDiscards(player, count) { return this.cardSelector.chooseDiscards(player, count); }
  shouldRespond(player, type, context) { return this.responsePolicy.shouldRespond(player, type, context, []); }
  chooseRedirectTarget(_player, alternatives) { return alternatives[0] ?? null; }
}
