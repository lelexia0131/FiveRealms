/**
 * AI 有限深度束搜索。依赖过滤快照、AiSimulator、AiEvaluator 与可取消 yield；
 * 到达时间或固定节点预算时返回当前最佳根动作。真实动作执行后由 AIController 重新调用。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260810-expose-marginal-v146";
import { AiSimulator } from "./AiSimulator.js?build=20260810-expose-marginal-v146";

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

  /**
   * 破势单步反事实边际价值：对本回合合法下一次突袭候选逐一模拟
   * “N 层”与“N+1 层”的同一突袭，取结果效用差的最大正值。
   *
   * 候选必须来自真实动作生成（generateFromVisible），因此自动包含距离/目标/
   * 次数槽/牌可用概率等合法性；两次 apply 走 AiSimulator 的真实伤害链
   * （格挡、护盾、雷达、护援、濒死、救援、击杀奖励），不在此手写任何防御判断。
   *
   * baseline 必须是 afterState 的克隆、仅回退“这张破势实际新增的层数”
   * （after.stacks - before.stacks），而不是 beforeState：破势牌的消耗、
   * 手牌数量、卡牌可用性等“打出破势的成本”属于普通 transition 的职责，
   * 不能混进这一层的边际测量。两个反事实世界在模拟突袭前除 exposeWeaknessStacks
   * 相差该增量外完全一致。
   *
   * 一张破势只增加 1 层，且被下一次突袭一次性消费，因此只比较下一次突袭，
   * 并对多个候选取 max（不是 sum）；无合法候选或边际为负时返回 0。
   */
  evaluateExposeMarginal(beforeState, afterState, actorId, simulator = null) {
    const sim = simulator ?? new AiSimulator(afterState);
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    const addedStacks = (afterActor?.exposeWeaknessStacks ?? 0) - (beforeActor?.exposeWeaknessStacks ?? 0);
    if (!(addedStacks > 0)) return 0;
    const baselineState = structuredClone(afterState);
    const baselineActor = baselineState.players.find((entry) => entry.id === actorId);
    baselineActor.exposeWeaknessStacks = Math.max(0, (baselineActor.exposeWeaknessStacks ?? 0) - addedStacks);
    const candidates = this.game.aiController.actionGenerator.generateFromVisible(afterState, actorId);
    let best = 0;
    for (const candidate of candidates) {
      if (candidate.card?.definitionId !== "assault") continue;
      const base = sim.apply(baselineState, candidate, actorId);
      const boosted = sim.apply(afterState, candidate, actorId);
      const marginal = this.evaluator.stateUtility(boosted, actorId)
        - this.evaluator.stateUtility(base, actorId);
      if (marginal > best) best = marginal;
    }
    return best;
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
      if (action.card?.definitionId !== "assault" || !hiddenWorlds.length) return 0;
      const targetId = action.targets?.[0]?.id;
      if (!targetId) return 0;
      return -1.5 * hiddenWorlds.filter((world) => world[targetId]?.includes("block")).length / hiddenWorlds.length;
    };
    const tacticResolutionScale = (action, state) => {
      const card = action.card;
      if (card?.category !== "tactic" || card.counterable === false) return 1;
      const actor = state.players.find((entry) => entry.id === player.id);
      if (!actor) return 1;
      if (card.counterScope === "target") {
        const targetIds = new Set((action.targets ?? []).map((target) => target.id));
        const aliveTargets = state.players.filter((entry) => targetIds.has(entry.id) && entry.alive);
        if (!aliveTargets.length) return 0;
        const total = aliveTargets.reduce((sum, target) => (
          sum + simulator.targetResolutionChance(state, actor, card, target)
        ), 0);
        return total / aliveTargets.length;
      }
      const mappedTargets = (action.targets ?? [])
        .map((target) => state.players.find((entry) => entry.id === target.id))
        .filter(Boolean);
      return simulator.tacticResolutionChance(state, actor, card, mappedTargets);
    };
    const transitionScore = (action, beforeState, afterState, depth = 1, availableActions = []) => {
      const executionProbability = action.executionProbability ?? 1;
      const actionValue = this.evaluator.actionUtility(action, player, beforeState, { availableActions });
      const resolutionScale = tacticResolutionScale(action, beforeState);
      const immediate = (actionValue * resolutionScale + hiddenAdjustment(action))
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
      const exposeMarginal = action.card?.definitionId === "exposeWeakness"
        ? this.evaluateExposeMarginal(visibleState, state, player.id, simulator)
        : 0;
      beam.push({
        action,
        state,
        terminal:Boolean(state.playPhaseEnded),
        // 根节点也必须看到模拟后的伤害、装备和资源变化，否则第一次束裁剪会丢掉真正优质的动作。
        score:transitionScore(action, visibleState, state, 1, rootActions) + exposeMarginal,
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
          const exposeMarginal = follow.card?.definitionId === "exposeWeakness"
            ? this.evaluateExposeMarginal(node.state, state, player.id, simulator) / depth
            : 0;
          const score = node.score + transitionScore(follow, node.state, state, depth, followActions)
            + exposeMarginal;
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
