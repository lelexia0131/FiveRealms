/**
 * AI 有限深度束搜索。依赖过滤快照、AiSimulator、AiEvaluator 与可取消 yield；
 * 到达时间预算返回当前最佳根动作。真实动作执行后由 AIController 重新调用。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260730-character-v6";
import { AiSimulator } from "./AiSimulator.js?build=20260730-character-v6";

/** 有限深度束搜索；不保存跨真实动作的陈旧计划。 */
export class AiPlanner {
  constructor(game, evaluator) {
    this.game = game;
    this.evaluator = evaluator;
    this.lastSearchStats = null;
    this.lastPlannedSequence = [];
  }

  describeAction(action) {
    return {
      type: action.type,
      cardId: action.card?.definitionId ?? action.skill?.id ?? null,
      cardInstanceId: action.card?.id ?? null,
      targetId: action.targets?.[0]?.id ?? null,
      targetIds: (action.targets ?? []).map((target) => target.id)
    };
  }

  chooseCandidate(beam) {
    const bestScore = beam[0]?.score ?? -Infinity;
    const near = beam.filter((node) => bestScore - node.score <= GAME_CONFIG.aiNearTieRange);
    if (near.length <= 1 || !GAME_CONFIG.enableAiRandomness) return near[0] ?? beam[0];
    const randomness = Math.max(0, Number(this.game.aiRandomnessRange ?? GAME_CONFIG.aiRandomnessRange) || 0);
    if (!randomness) return near[0];
    const scale = Math.max(1, Math.abs(bestScore));
    return near.reduce((best, node) => {
      const adjusted = node.score + (this.game.random() * 2 - 1) * scale * randomness;
      return !best || adjusted > best.adjusted ? { node, adjusted } : best;
    }, null).node;
  }

  async plan(player, visibleState, rootActions, options = {}) {
    this.lastPlannedSequence = [];
    const started = globalThis.performance?.now?.() ?? Date.now();
    const budget = this.game.aiSearchBudgetOverrideMs ?? GAME_CONFIG.aiSearchTimeBudgetMs;
    const simulator = new AiSimulator(visibleState);
    const hiddenWorlds = this.game.aiController.knowledge.sampleHiddenWorlds(player, visibleState, GAME_CONFIG.aiHiddenStateSamples);
    const hiddenAdjustment = (action) => {
      const targetId = action.targets?.[0]?.id;
      if (!targetId || !hiddenWorlds.length) return 0;
      if (action.card?.definitionId === "assault") return -1.5 * hiddenWorlds.filter((world) => world[targetId]?.includes("block")).length / hiddenWorlds.length;
      if (action.card?.category === "tactic") return -hiddenWorlds.filter((world) => Object.values(world).some((hand) => hand.includes("counter"))).length / hiddenWorlds.length;
      return 0;
    };
    let beam = rootActions.map((action) => ({ action, state:simulator.apply(visibleState, action, player.id), score:this.evaluator.actionUtility(action, player, visibleState) + hiddenAdjustment(action), sequence:[action] }));
    beam.sort((a,b) => b.score - a.score);
    beam = beam.slice(0, GAME_CONFIG.aiBeamWidth);
    let expanded = beam.length;
    const rootAssaultTargets = new Set(rootActions.filter((action) => action.card?.definitionId === "assault").map((action) => action.targets?.[0]?.id));
    let discoveredDynamicTarget = false;
    for (let depth = 2; depth <= GAME_CONFIG.aiSearchDepth; depth += 1) {
      const candidates = [];
      for (const node of beam) {
        const followActions = this.game.aiController.actionGenerator.generateFromVisible(node.state, player.id);
        for (const follow of followActions) {
          if (follow.card?.definitionId === "assault" && !rootAssaultTargets.has(follow.targets?.[0]?.id)) discoveredDynamicTarget = true;
          const state = simulator.apply(node.state, follow, player.id);
          const score = node.score + this.evaluator.actionUtility(follow, player, node.state) / depth + this.evaluator.stateUtility(state, player.id) * 0.08 / depth;
          candidates.push({ action:node.action, state, score, sequence:[...node.sequence, follow] });
          expanded += 1;
          if (expanded % GAME_CONFIG.aiSearchYieldEvery === 0) {
            if (!(await this.game.cleanupManager.delay(0)) || !this.game.isSessionValid(options.gameId ?? this.game.state.gameId)) return { type:"end" };
          }
          if ((globalThis.performance?.now?.() ?? Date.now()) - started >= budget) break;
        }
        if ((globalThis.performance?.now?.() ?? Date.now()) - started >= budget) break;
      }
      if (!candidates.length) break;
      candidates.sort((a,b) => b.score - a.score);
      beam = candidates.slice(0, GAME_CONFIG.aiBeamWidth);
      if ((globalThis.performance?.now?.() ?? Date.now()) - started >= budget) break;
    }
    const choice = this.chooseCandidate(beam);
    this.lastPlannedSequence = (choice?.sequence ?? []).map((action) => this.describeAction(action));
    this.lastSearchStats = { elapsedMs:(globalThis.performance?.now?.() ?? Date.now()) - started, expanded, depth:Math.max(1, choice?.sequence.length ?? 1), beamWidth:GAME_CONFIG.aiBeamWidth,
      discoveredDynamicTarget, hiddenSamples:hiddenWorlds.length, bestSequence:this.lastPlannedSequence };
    return choice?.action ?? { type:"end" };
  }
}
