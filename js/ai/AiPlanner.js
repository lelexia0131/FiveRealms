/**
 * AI 有限深度束搜索。依赖过滤快照、AiSimulator、AiEvaluator 与可取消 yield；
 * 到达时间或固定节点预算时返回当前最佳根动作。真实动作执行后由 AIController 重新调用。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260805-resource-identity-v79";
import { AiSimulator } from "./AiSimulator.js?build=20260805-resource-identity-v79";

/** 有限深度束搜索；不保存跨真实动作的陈旧计划。 */
export class AiPlanner {
  constructor(game, evaluator) {
    this.game = game;
    this.evaluator = evaluator;
    this.lastSearchStats = null;
    this.lastPlannedSequence = [];
  }

  describeAction(action) {
    const selection = action.selection
      ? action.card?.definitionId === "transfer"
        ? {
            sourceId:action.selection.sourceId,
            receiverId:action.selection.receiverId,
            zone:action.selection.zone
          }
        : { ...action.selection }
      : null;
    return {
      type: action.type,
      cardId: action.card?.definitionId ?? action.skill?.id ?? null,
      cardInstanceId: action.card?.id ?? null,
      targetId: action.targets?.[0]?.id ?? null,
      targetIds: (action.targets ?? []).map((target) => target.id),
      selection
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
    const timeBudget = this.game.aiSearchBudgetOverrideMs ?? GAME_CONFIG.aiSearchTimeBudgetMs;
    const configuredNodeBudget = Number(this.game.aiSearchNodeBudgetOverride);
    const nodeBudget = Number.isFinite(configuredNodeBudget) && configuredNodeBudget >= 1
      ? Math.floor(configuredNodeBudget)
      : null;
    const simulator = new AiSimulator(visibleState);
    const hiddenWorlds = this.game.aiController.knowledge.sampleHiddenWorlds(player, visibleState, GAME_CONFIG.aiHiddenStateSamples);
    const hiddenAdjustment = (action) => {
      const targetId = action.targets?.[0]?.id;
      if (!targetId || !hiddenWorlds.length) return 0;
      if (action.card?.definitionId === "assault") return -1.5 * hiddenWorlds.filter((world) => world[targetId]?.includes("block")).length / hiddenWorlds.length;
      if (action.card?.category === "tactic") return -hiddenWorlds.filter((world) => Object.values(world).some((hand) => hand.includes("counter"))).length / hiddenWorlds.length;
      return 0;
    };
    const transitionScore = (action, beforeState, afterState, depth = 1) => {
      const executionProbability = action.executionProbability ?? 1;
      const immediate = (this.evaluator.actionUtility(action, player, beforeState) + hiddenAdjustment(action))
        * executionProbability;
      return (immediate + this.evaluator.stateUtility(afterState, player.id) * 0.08) / depth;
    };
    let expanded = 0;
    const limitReached = () => nodeBudget === null
      ? (globalThis.performance?.now?.() ?? Date.now()) - started >= timeBudget
      : expanded >= nodeBudget;
    const beam = [];
    // 根动作也受时间/节点预算约束并定期让出主线程；复杂手牌不能把界面锁死在“观察战场”。
    for (const action of rootActions) {
      if (beam.length && limitReached()) break;
      const state = simulator.apply(visibleState, action, player.id);
      beam.push({
        action,
        state,
        terminal:Boolean(state.playPhaseEnded),
        // 根节点也必须看到模拟后的伤害、装备和资源变化，否则第一次束裁剪会丢掉真正优质的动作。
        score:transitionScore(action, visibleState, state),
        sequence:[action]
      });
      expanded += 1;
      if (expanded % GAME_CONFIG.aiSearchYieldEvery === 0) {
        if (!(await this.game.cleanupManager.delay(0)) || !this.game.isSessionValid(options.gameId ?? this.game.state.gameId)) {
          return { type:"end" };
        }
      }
    }
    beam.sort((a,b) => b.score - a.score);
    let activeBeam = beam.slice(0, GAME_CONFIG.aiBeamWidth);
    let bestCandidate = activeBeam[0];
    const rootAssaultTargets = new Set(rootActions.filter((action) => action.card?.definitionId === "assault").map((action) => action.targets?.[0]?.id));
    let discoveredDynamicTarget = false;
    for (let depth = 2; depth <= GAME_CONFIG.aiSearchDepth; depth += 1) {
      if (limitReached() || activeBeam.every((node) => node.terminal)) break;
      const candidates = [];
      for (const node of activeBeam) {
        if (node.terminal) {
          candidates.push(node);
          continue;
        }
        const followActions = this.game.aiController.actionGenerator.generateFromVisible(node.state, player.id);
        for (const follow of followActions) {
          if (limitReached()) break;
          if (follow.card?.definitionId === "assault" && !rootAssaultTargets.has(follow.targets?.[0]?.id)) discoveredDynamicTarget = true;
          const state = simulator.apply(node.state, follow, player.id);
          const score = node.score + transitionScore(follow, node.state, state, depth);
          candidates.push({
            action:node.action,
            state,
            terminal:Boolean(state.playPhaseEnded),
            score,
            sequence:[...node.sequence, follow]
          });
          if (!bestCandidate || score > bestCandidate.score) bestCandidate = candidates.at(-1);
          expanded += 1;
          if (expanded % GAME_CONFIG.aiSearchYieldEvery === 0) {
            if (!(await this.game.cleanupManager.delay(0)) || !this.game.isSessionValid(options.gameId ?? this.game.state.gameId)) return { type:"end" };
          }
          if (limitReached()) break;
        }
        if (limitReached()) break;
      }
      if (!candidates.length) break;
      candidates.sort((a,b) => b.score - a.score);
      activeBeam = candidates.slice(0, GAME_CONFIG.aiBeamWidth);
      if (limitReached()) break;
    }
    const choice = nodeBudget !== null && limitReached()
      ? bestCandidate
      : this.chooseCandidate(activeBeam);
    const selectedSequence = [...(choice?.sequence ?? [])];
    const endIndex = selectedSequence.findIndex((action) => action.type === "end");
    this.lastPlannedSequence = (endIndex >= 0 ? selectedSequence.slice(0, endIndex + 1) : selectedSequence)
      .map((action) => this.describeAction(action));
    this.lastSearchStats = { elapsedMs:(globalThis.performance?.now?.() ?? Date.now()) - started, expanded, depth:Math.max(1, choice?.sequence.length ?? 1), beamWidth:GAME_CONFIG.aiBeamWidth,
      budgetType:nodeBudget === null ? "time" : "nodes", nodeBudget,
      discoveredDynamicTarget, hiddenSamples:hiddenWorlds.length, bestSequence:this.lastPlannedSequence };
    return choice?.action ?? { type:"end" };
  }
}
