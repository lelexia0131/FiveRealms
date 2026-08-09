import { createAiVisibleState } from "./AiVisibleState.js?build=20260809-ai-block-damage-preview-v133";
import { AiKnowledge } from "./AiKnowledge.js?build=20260809-ai-block-damage-preview-v133";
import { AiCardSelector } from "./AiCardSelector.js?build=20260809-ai-block-damage-preview-v133";
import { AiResponsePolicy } from "./AiResponsePolicy.js?build=20260809-ai-block-damage-preview-v133";
import { AiActionGenerator } from "./AiActionGenerator.js?build=20260809-ai-block-damage-preview-v133";
import { AiEvaluator } from "./AiEvaluator.js?build=20260809-ai-block-damage-preview-v133";
import { AiPlanner } from "./AiPlanner.js?build=20260809-ai-block-damage-preview-v133";

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
    const remainingCardCounts = this.knowledge.remainingCounts(player);
    const visible = createAiVisibleState(player.id, this.game.state, remainingCardCounts);
    return this.planner.plan(player, visible, this.getLegalActions(player), options);
  }
  /** 将上一棵搜索树里的动作描述重新绑定到当前真实合法动作；状态变化后匹配失败即要求重规划。 */
  resolvePlannedAction(player, descriptor) {
    if (!descriptor) return null;
    return this.getLegalActions(player).find((action) => {
      if (action.type !== descriptor.type) return false;
      if (action.type === "end") return true;
      if (action.type === "skill" && action.skill?.id !== descriptor.cardId) return false;
      if (action.type === "card" && descriptor.cardInstanceId && action.card?.id !== descriptor.cardInstanceId) return false;
      if (action.type === "card" && !descriptor.cardInstanceId && action.card?.definitionId !== descriptor.cardId) return false;
      const targetIds = (action.targets ?? []).map((target) => target.id);
      if (targetIds.length !== (descriptor.targetIds?.length ?? 0) || !targetIds.every((id, index) => id === descriptor.targetIds[index])) return false;
      if (descriptor.selection) {
        if (!action.selection) return false;
        return Object.entries(descriptor.selection).every(([key, value]) => value == null || action.selection[key] === value);
      }
      return true;
    }) ?? null;
  }
  chooseDiscards(player, count) { return this.cardSelector.chooseDiscards(player, count); }
  shouldRespond(player, type, context) { return this.responsePolicy.shouldRespond(player, type, context, []); }
  chooseRedirectTarget(_player, alternatives) { return alternatives[0] ?? null; }
}
