/*
模块职责
在 SearchState 上执行有限深度束搜索并返回当前最佳根动作与稳定描述序列。

上游
AIController 组合根与搜索回归测试。

下游
AiSimulator、AiEvaluator、封印时序模型及构造时注入的动作、Belief 和运行控制能力。

状态边界
只读输入 SearchState，所有分支写入由 AiSimulator 创建的独立克隆承担。

信息边界
隐藏世界只能来自注入的合法 Belief 采样能力，Planner 不读取 GameState。

架构约束
不得持有 Game 或回指 AIController；预算、随机、让步和搜索服务必须显式注入。
*/
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260814-ai-controller-di";
import { AiSimulator } from "./AiSimulator.js?build=20260814-ai-controller-di";
import { HP_VALUE, STATE_DELTA_SCALE } from "./AiEvaluator.js?build=20260814-ai-controller-di";
import { sealDelayCost, sealEarlyUsePenalty } from "./sealScoring.js?build=20260814-ai-controller-di";

/** end 机会成本上限（未缩放）：与 actionEconomicValue(end) 的旧默认 -0.8 同量纲。 */
const END_OPPORTUNITY_CAP = 0.8;

export class AiPlanner {
  /*
  功能
  创建只依赖显式窄能力的束搜索 Planner。

  调用方
  AIController 组合根与直接独立性测试。

  输入
  评估器、深层动作生成、隐藏世界采样、随机、配置读取和可取消让步能力。

  输出
  可执行 plan 的 AiPlanner；任一必要依赖缺失时立即抛错。

  读取状态
  无。

  写入状态
  实例依赖、最近搜索统计与计划序列。

  调用函数
  无。

  边界与不变量
  不接收或保存 Game、AIController，也不在搜索节点中重新构造依赖对象。
  */
  constructor({
    evaluator,
    generateFromVisible,
    sampleHiddenWorlds,
    random,
    getRandomnessRange,
    getSearchTimeBudget,
    getSearchNodeBudget,
    yieldControl,
  } = {}) {
    const capabilities = {
      generateFromVisible,
      sampleHiddenWorlds,
      random,
      getRandomnessRange,
      getSearchTimeBudget,
      getSearchNodeBudget,
      yieldControl,
    };
    if (!evaluator) throw new TypeError("AiPlanner 缺少依赖：evaluator");
    for (const [name, capability] of Object.entries(capabilities)) {
      if (typeof capability !== "function") throw new TypeError(`AiPlanner 缺少依赖：${name}`);
    }
    this.evaluator = evaluator;
    Object.assign(this, capabilities);
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

  /*
  功能
  用真实模拟计算新增一层破势对下一次合法突袭的最大正边际。

  调用方
  plan 的根节点与深层候选评分。

  输入
  动作前后 SearchState、行动者 ID 与可选复用模拟器。

  输出
  下一次突袭的最大非负效用增量。

  读取状态
  输入 SearchState、注入的深层动作生成能力与 evaluator。

  写入状态
  无；模拟器只写独立克隆。

  调用函数
  generateFromVisible、AiSimulator.apply、AiEvaluator.stateUtility。

  边界与不变量
  baseline 只回退本动作新增层数；候选来自合法生成，一张破势只比较下一次突袭并取 max 而非 sum。
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
    const candidates = this.generateFromVisible(afterState, actorId);
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

  /**
   * 已有破势层的消费侧反事实边际：对同一个合法突袭动作比较
   * “本节点沿搜索路径仍未消费的回合开始旧层（remainingRootExposeStacks）”
   * 与“临时降为 0 层”的模拟结果差。
   *
   * 突袭会一次性消费全部已有层，因此已有层对本次突袭的兑现价值只能在
   * 消费动作上体现；actionUtility(assault) 不读取 exposeWeaknessStacks，
   * 如果不在此补信用，该价值只以 stateUtility × 0.08 进入，会被严重稀释。
   *
   * remainingRootExposeStacks 由每个 beam 节点独立维护（沿搜索路径随
   * 真实 Simulator 的 stacks 保留比例衰减），因此已被前序突袭消费的旧层
   * 不会再被后续突袭重复计价；本回合新打的破势不进入该值，其信用只由
   * evaluateExposeMarginal（N vs N+1 增量）负责。
   *
   * 反事实通过真实 AiSimulator 覆盖格挡、护盾、护援、调息、救援、击杀与
   * 概率执行；无合法突袭候选或边际为负时返回 0，不强制出突袭。
   */
  evaluateAssaultStacksMarginal(currentState, action, actorId, remainingRootExposeStacks, simulator = null) {
    if (!(remainingRootExposeStacks > 0)) return 0;
    const sim = simulator ?? new AiSimulator(currentState);
    const boostedState = structuredClone(currentState);
    const baselineState = structuredClone(currentState);
    const boostedActor = boostedState.players.find((entry) => entry.id === actorId);
    const baselineActor = baselineState.players.find((entry) => entry.id === actorId);
    boostedActor.exposeWeaknessStacks = remainingRootExposeStacks;
    baselineActor.exposeWeaknessStacks = 0;
    const boosted = sim.apply(boostedState, action, actorId);
    const baseline = sim.apply(baselineState, action, actorId);
    const marginal = this.evaluator.stateUtility(boosted, actorId)
      - this.evaluator.stateUtility(baseline, actorId);
    return marginal > 0 ? marginal : 0;
  }

  /**
   * 沿搜索路径推进“回合开始旧层剩余量”：用真实 Simulator 前后状态的
   * exposeWeaknessStacks 保留比例（after/before）同步缩放旧层剩余量。
   *
   * 只在 assault 消费动作后调用：确定执行时比例 0（旧层归零），部分概率
   * 执行时按真实期望状态保留（如 1 → 0.6），新破势等非消费动作不调用，
   * 因此不会把本回合新层计入旧层。返回值为 0~N 的分数期望值。
   */
  advanceRemainingRootExposeStacks(beforeState, afterState, actorId, remainingRootStacks) {
    if (!(remainingRootStacks > 0)) return 0;
    const beforeActor = beforeState.players.find((entry) => entry.id === actorId);
    const afterActor = afterState.players.find((entry) => entry.id === actorId);
    const beforeStacks = beforeActor?.exposeWeaknessStacks ?? 0;
    const afterStacks = afterActor?.exposeWeaknessStacks ?? 0;
    if (!(beforeStacks > 0)) return 0;
    const retainRatio = Math.max(0, afterStacks / beforeStacks);
    return Math.max(0, remainingRootStacks * retainRatio);
  }

  /**
   * 同一事件世界的响应反事实：对"去掉该玩家响应能力"的 before 世界重新 apply
   * 同一个 action，比较实际 after 与反事实 after，得到该响应为受保护侧创造的
   * 避免损失。1-ply，不嵌套完整搜索，不修改任何输入状态。
   *
   * grossAvoided = 纯避免伤害（HP 差 × HP_VALUE）；
   * ownerValue = 响应从响应方自身视角的净值（含避免死亡、资源消耗、身份变化）；
   * projected = 从调用方 viewer 视角的投影（敌我符号由投影决定）。
   * 该值不是通过 assault inventory exposure removal 间接假装：两条世界除响应能力
   * 外完全一致，差值只来自响应本身。
   */
  responseCounterfactual(before, action, actorId, defenderId, viewerId, opts = {}, after = null) {
    if (!action) return { grossAvoided: 0, ownerValue: 0, projected: 0 };
    const sim = new AiSimulator(before);
    const actualAfter = after ?? sim.apply(before, action, actorId);
    const cfState = before.players.map((p) => {
      if (p.id !== defenderId) return p;
      const next = { ...p };
      if (opts.removeBlock) {
        next.blockCountDistribution = [{ probability: 1, conditions: {}, blockCount: 0 }];
        next.blockProbability = 0;
        next.twoBlockProbability = 0;
      }
      if (opts.removeCounter) {
        next.counterCountDistribution = [{ probability: 1, conditions: {}, counterCount: 0 }];
        next.counterProbability = 0;
      }
      if (opts.removeRecover) {
        next.expectedRecoverCount = 0;
        if (Array.isArray(next.hand)) next.hand = next.hand.filter((c) => c.definitionId !== "recover");
      }
      return next;
    });
    const cfBefore = { ...before, players: cfState };
    const cfAfter = new AiSimulator(cfBefore).apply(cfBefore, action, actorId);
    const actualDefender = actualAfter.players.find((p) => p.id === defenderId);
    const cfDefender = cfAfter.players.find((p) => p.id === defenderId);
    const grossAvoided = Math.max(0, (actualDefender?.hp ?? 0) - (cfDefender?.hp ?? 0)) * HP_VALUE;
    const ownerValue = this.evaluator.stateUtility(actualAfter, defenderId)
      - this.evaluator.stateUtility(cfAfter, defenderId);
    const projected = this.evaluator.stateUtility(actualAfter, viewerId)
      - this.evaluator.stateUtility(cfAfter, viewerId);
    return { grossAvoided, ownerValue, projected };
  }

  /**
   * 响应侧消费链：block / counter / dying rescue 的 owner-scored value。
   *
   * 检测本次 transition 中实际发生的响应（block/counter 容量下降、rescue 消耗
   * recover），并用同一事件反事实计算该响应为受保护侧创造的避免损失，归属到
   * 响应方 / 受保护侧。只读输入，不修改任何状态。
   */
  computeResponseLedger(before, action, after, viewerId) {
    if (!action) return { responses: [] };
    const beforeById = new Map(before.players.map((p) => [p.id, p]));
    const actorId = viewerId;
    const responses = [];
    for (const player of after.players) {
      if (player.id === actorId || !player.alive) continue;
      const beforePlayer = beforeById.get(player.id);
      if (!beforePlayer) continue;
      const blockDropped = (beforePlayer.blockProbability ?? 0) - (player.blockProbability ?? 0) > 1e-9;
      const counterDropped = (beforePlayer.counterProbability ?? 0) - (player.counterProbability ?? 0) > 1e-9;
      if (blockDropped || counterDropped) {
        const cf = this.responseCounterfactual(before, action, actorId, player.id, viewerId, {
          removeBlock: blockDropped,
          removeCounter: counterDropped
        }, after);
        responses.push({
          kind: blockDropped && counterDropped ? "blockAndCounter" : blockDropped ? "block" : "counter",
          responderId: player.id,
          protectedId: player.id,
          resourceSpent: Math.max(0, (beforePlayer.handCount ?? 0) - (player.handCount ?? 0)) * 1.1,
          grossAvoided: cf.grossAvoided,
          ownerValue: cf.ownerValue,
          netValue: cf.projected
        });
      }
    }
    // dying rescue：救援者消耗 recover，受保护侧是濒死目标（由反事实决定）。
    for (const rescuer of after.players) {
      if (rescuer.id === actorId || !rescuer.alive) continue;
      const beforeRescuer = beforeById.get(rescuer.id);
      if (!beforeRescuer) continue;
      const recoverSpent = (beforeRescuer.expectedRecoverCount ?? 0) - (rescuer.expectedRecoverCount ?? 0);
      if (recoverSpent > 1e-9) {
        const cf = this.responseCounterfactual(before, action, actorId, rescuer.id, viewerId, {
          removeRecover: true
        }, after);
        responses.push({
          kind: "rescue",
          responderId: rescuer.id,
          protectedId: null,
          resourceSpent: recoverSpent * 1.1,
          grossAvoided: cf.grossAvoided,
          ownerValue: cf.ownerValue,
          netValue: cf.projected
        });
      }
    }
    return { responses };
  }

  /**
   * 单个候选的 owner-local value ledger：state delta 分解（ownerStateLedger +
   * perspective projection）叠加响应侧价值（computeResponseLedger）。只对根候选
   * 计算（响应反事实代价有界）；深层候选只附加 frontier-only residual，不再携带
   * 完整 ledger。该 representation 只在显式决策诊断中构造，用于解释 owner 归属，
   * 不参与生产候选评分。
   */
  computeCandidateLedger(before, action, after, viewerId, includeResponse) {
    if (typeof this.evaluator.ownerStateLedger !== "function") {
      return { ownerLedger: null, projected: null, responses: [] };
    }
    const ownerLedger = this.evaluator.ownerStateLedger(before, after, viewerId);
    const projected = this.evaluator.projectOwnerLedger(ownerLedger, viewerId);
    const responses = includeResponse
      ? this.computeResponseLedger(before, action, after, viewerId).responses
      : [];
    return { ownerLedger, projected, responses };
  }

  /** frontier-only residual；evaluator 未提供该 API 时安全降级为 null。 */
  frontierResidualOf(state, viewerId) {
    return typeof this.evaluator.frontierResidual === "function"
      ? this.evaluator.frontierResidual(state, viewerId)
      : null;
  }

  /**
   * 候选价值的互斥组成（测试与生产共用同一入口，避免公式漂移）。
   *
   *   realizedTransition = baseTransition - responseNet × scale
   *                        已实现转变：stateDelta 扣除响应边际后的非响应部分
   *   realizedResponse   = responseNet × scale
   *                        已实现响应/避免损失：与转变同权重显式计回
   *   frontierValue      = 前沿未实现价值（只计 held 未来选项，仅终局一次）
   *
   * responseNet 已完整包含在 stateDelta 中（containment 恒等式），因此先扣减再
   * 显式计回，代数上恒等于 baseTransition——不引入新权重、不重复计价；"能看出来
   * 响应价值占多少"正是本入口存在的意义。无响应时 responseNet=0，退化为普通
   * 已实现转变价值。封印 timing 修正保持原语义；破势边际信用按下文与
   * stateDelta 同 scale。
   *
   * 破势边际信用（exposeMarginal / assaultStacksCredit）测量的是 stateUtility 差值
   * （N 层 vs N+1 层的下一次突袭），必须与 stateDelta 同乘 scale：否则同一份破势
   * 兑现价值会被"stateDelta 已含层数伤害 + 全权重边际"双重计价，且相对已实现转变
   * 被放大到 1/scale 倍，扭曲目标优先与击杀判断。
   */
  composeCandidateValue(baseTransition, responseNet, frontierValue, sealTimingPenalty, exposeMarginal, assaultStacksCredit) {
    // responseNet 只用于 ledger 分解：realizedTransition + realizedResponse 恒等于
    // baseTransition。直接返回化简结果，确保诊断开关连浮点舍入都不会改变候选价值。
    return baseTransition + frontierValue
      - sealTimingPenalty
      + (exposeMarginal + assaultStacksCredit) * STATE_DELTA_SCALE;
  }

  /*
  功能
  从最终束中按既有近似平局与随机扰动规则选择候选。

  调用方
  plan 搜索收束阶段。

  输入
  已按价值排序的候选束。

  输出
  被选候选节点；空束时为 undefined。

  读取状态
  GAME_CONFIG 与注入的随机、随机幅度能力。

  写入状态
  随机源序列。

  调用函数
  getRandomnessRange、random。

  边界与不变量
  随机调用次数、调用位置、近似平局集合与 tie-break 顺序保持既有语义。
  */
  chooseCandidate(beam) {
    const bestScore = beam[0]?.valueScore ?? -Infinity;
    const near = beam.filter((node) => bestScore - node.valueScore <= GAME_CONFIG.aiNearTieRange);
    if (near.length <= 1 || !GAME_CONFIG.enableAiRandomness) return near[0] ?? beam[0];
    const randomness = Math.max(0, Number(this.getRandomnessRange() ?? GAME_CONFIG.aiRandomnessRange) || 0);
    if (!randomness) return near[0];
    const scale = Math.max(1, Math.abs(bestScore));
    return near.reduce((best, node) => {
      const adjusted = node.valueScore + (this.random() * 2 - 1) * scale * randomness;
      return !best || adjusted > best.adjusted ? { node, adjusted } : best;
    }, null).node;
  }

  /*
  功能
  在固定时间或节点预算内执行有限深度束搜索并选择根动作。

  调用方
  AIController.selectAction、搜索回归与直接依赖注入测试。

  输入
  行动者、根 SearchState、根合法动作与可选会话/诊断上下文。

  输出
  当前最佳根动作；取消或无候选时安全结束阶段。

  读取状态
  SearchState、evaluator、注入的动作生成、Belief 采样、预算、随机和会话能力。

  写入状态
  lastSearchStats、lastPlannedSequence 与随机源序列。

  调用函数
  AiSimulator、generateFromVisible、sampleHiddenWorlds、yieldControl 及本类评分 helper。

  边界与不变量
  搜索深度、束顺序、采样时机、随机顺序、最终评分与 descriptor 序列不得因装配迁移改变。
  */
  async plan(player, visibleState, rootActions, options = {}) {
    this.lastPlannedSequence = [];
    const collectDiagnostics = Boolean(options.collectAiDecisionDiagnostics);
    const started = globalThis.performance?.now?.() ?? Date.now();
    const timeBudget = this.getSearchTimeBudget() ?? GAME_CONFIG.aiSearchTimeBudgetMs;
    const configuredNodeBudget = Number(this.getSearchNodeBudget());
    const nodeBudget = Number.isFinite(configuredNodeBudget) && configuredNodeBudget >= 1
      ? Math.floor(configuredNodeBudget)
      : null;
    const simulator = new AiSimulator(visibleState);
    // 回合开始已存在的旧破势层，作为根节点的 remainingRootExposeStacks 初值。
    const rootRemainingExposeStacks = (visibleState.players.find((entry) => entry.id === player.id)
      ?.exposeWeaknessStacks ?? 0);
    const hiddenWorlds = this.sampleHiddenWorlds(player, visibleState, GAME_CONFIG.aiHiddenStateSamples);
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
    // 临时 search credit：只用于当前层 beam pruning/ranking，不进入真实累计价值。
    // 静态卡牌分（actionUtility）与隐藏世界格挡先验（hiddenAdjustment）都在这里，
    // 帮助 beam 优先展开"值得打的牌"；最终 root 选择只看 valueScore。
    const searchPrior = (action, state) => (
      hiddenAdjustment(action)
      + (typeof this.evaluator.actionUtility === "function"
        ? this.evaluator.actionUtility(action, player, state) : 0)
      + (typeof this.evaluator.actionSearchPrior === "function"
        ? this.evaluator.actionSearchPrior(action, player, state) : 0)
    );
    /**
     * 未调整的 base transition score（U/d）。封印的软性后置 penalty 不在这里
     * 计算：同一 parent 下的跨候选 timing 比较由调用方在物化同层候选后完成，
     * 只对 seal 候选用“最佳非封印即时动作延迟一步”的 delayCost 做减法。
     * immediate 只取 actionEconomicValue（不在 stateDelta 中的经济量）；静态先验
     * 与隐藏世界格挡先验都移到 searchPrior，避免与 stateDelta 的卡片机会成本重复计价。
     */
    const transitionScore = (action, beforeState, afterState, depth = 1, endOpportunityCost = 0) => {
      const executionProbability = action.executionProbability ?? 1;
      // end 的最终机会成本来自同一 parent 的真实正收益 sibling 边际（已封顶），
      // 而不是“存在任意合法 non-end action”：负收益/近零 sibling 不应让 end 被固定
      // -0.8 惩罚而强制 AI 执行负收益动作；有 +10 机会时成本也不超过 END_OPPORTUNITY_CAP。
      const economicValue = action.type === "end"
        ? -endOpportunityCost
        : (this.evaluator.actionEconomicValue
          ? this.evaluator.actionEconomicValue(action, player, beforeState)
          : 0);
      // 只有 economicValue 会读取 resolutionScale；值为 0 时继续推导反制概率最终只会乘 0。
      // 真实 Counter outcome 已在 simulator.apply(afterState) 中完整结算，不能在此删减。
      const resolutionScale = economicValue === 0 ? 1 : tacticResolutionScale(action, beforeState);
      const immediate = (economicValue * resolutionScale)
        * executionProbability;
      // state credit 使用边际局面改善量；afterState 已是按执行概率/反制概率折算的期望状态，
      // 因此这里不再重复乘 executionProbability 或 resolutionScale。
      const stateDelta = this.evaluator.stateUtility(afterState, player.id)
        - this.evaluator.stateUtility(beforeState, player.id);
      return (immediate + stateDelta * 0.08) / depth;
    };
    let expanded = 0;
    const limitReached = () => nodeBudget === null
      ? (globalThis.performance?.now?.() ?? Date.now()) - started >= timeBudget
      : expanded >= nodeBudget;
    const beam = [];
    // 根动作也受时间/节点预算约束并定期让出主线程；复杂手牌不能把界面锁死在“观察战场”。
    // 先在同一 parent 物化所有已处理根候选的 base transition，再对 seal 候选应用
    // “最佳非封印即时动作延迟一步”的 timing penalty：每张牌只 apply 一次，
    // 不因 seal 候选对替代动作重复 apply。
    const rootCandidates = [];
    const rootLedgers = [];
    let bestRootNonSealBase = -Infinity;
    // 根层 end 机会成本：只累计真实正收益 non-end sibling 的未缩放边际（depth=1，baseTransition 即未缩放）。
    let bestPositiveRootMarginal = 0;
    for (const action of rootActions) {
      // 与旧实现一致：至少处理一个根动作，随后到达时间/节点预算立即停止；
      // beam 在第二遍才填充，因此用 rootCandidates.length 作为“已处理”信号。
      if (rootCandidates.length && limitReached()) break;
      const state = simulator.apply(visibleState, action, player.id);
      const exposeMarginal = action.card?.definitionId === "exposeWeakness"
        ? this.evaluateExposeMarginal(visibleState, state, player.id, simulator)
        : 0;
      const assaultStacksCredit = action.card?.definitionId === "assault"
        ? this.evaluateAssaultStacksMarginal(
          visibleState, action, player.id, rootRemainingExposeStacks, simulator
        )
        : 0;
      // 根 transition 与深层 transition 对称：根动作若是突袭，必须按真实 Simulator
      // 前后 stacks 保留比例推进旧层剩余量，否则已被根突袭消费的旧层会继续
      // 在 depth>=2 的后续突袭上重复获得消费侧信用。
      const remainingRootExposeStacks = action.card?.definitionId === "assault"
        ? this.advanceRemainingRootExposeStacks(
          visibleState, state, player.id, rootRemainingExposeStacks
        )
        : rootRemainingExposeStacks;
      const baseTransition = transitionScore(action, visibleState, state, 1, 0);
      // owner-local ledger 是诊断 representation；响应净值在 composeCandidateValue 中
      // 先减后加，最终严格回到 baseTransition。生产评分不需要为每个根候选构造反事实，
      // 只有显式审计时才按需生成，评分公式仍由同一入口验证该恒等式。
      const candidateLedger = collectDiagnostics
        ? this.computeCandidateLedger(visibleState, action, state, player.id, true)
        : null;
      const responseNet = (candidateLedger?.responses ?? [])
        .reduce((sum, response) => sum + (response.netValue ?? 0), 0);
      const frontierResidual = Boolean(state.playPhaseEnded)
        ? this.frontierResidualOf(state, player.id)
        : null;
      // 前沿未实现价值只取 held 未来选项（调息治疗 / 回收站抽牌）；futureInventory 是
      // 敌方未来攻击库存，已经由终局 stateUtility 的 exposure 分项计价，在前沿再叠加
      // 会针对同一威胁双算，因此前沿积分只计入 held，且只在 playPhaseEnded 计一次。
      const frontierValue = frontierResidual
        ? (frontierResidual.held.recover + frontierResidual.held.recycle) * STATE_DELTA_SCALE
        : 0;
      if (action.card?.definitionId !== "seal" && action.type !== "end") {
        bestRootNonSealBase = Math.max(bestRootNonSealBase, baseTransition);
      }
      if (action.type !== "end") {
        bestPositiveRootMarginal = Math.max(bestPositiveRootMarginal, baseTransition);
      }
      rootCandidates.push({
        action, state, exposeMarginal, assaultStacksCredit, remainingRootExposeStacks, baseTransition,
        candidateLedger, frontierResidual, responseNet, frontierValue
      });
      if (collectDiagnostics) {
        rootLedgers.push({
          action: this.describeAction(action),
          projected: candidateLedger.projected,
          responses: candidateLedger.responses,
          responseNet,
          frontierValue
        });
      }
      expanded += 1;
      if (expanded % GAME_CONFIG.aiSearchYieldEvery === 0) {
        if (!(await this.yieldControl(options.gameId))) {
          return { type:"end" };
        }
      }
    }
    // end 根候选的机会成本按真实正收益 sibling 边际计算（封顶），而不是 sibling 存在性。
    const endRootCandidate = rootCandidates.find((candidate) => candidate.action.type === "end");
    if (endRootCandidate) {
      endRootCandidate.baseTransition = -Math.min(END_OPPORTUNITY_CAP, bestPositiveRootMarginal);
    }
    for (const candidate of rootCandidates) {
      // 根 depth=1：delayCost = 最佳非封印 base transition / (1 + 1)。
      const sealTimingPenalty = candidate.action.card?.definitionId === "seal"
        ? sealEarlyUsePenalty(sealDelayCost(bestRootNonSealBase, 1))
        : 0;
      const valueScore = this.composeCandidateValue(
        candidate.baseTransition,
        candidate.responseNet,
        candidate.frontierValue,
        sealTimingPenalty,
        candidate.exposeMarginal,
        candidate.assaultStacksCredit
      );
      beam.push({
        action:candidate.action,
        state:candidate.state,
        terminal:Boolean(candidate.state.playPhaseEnded),
        // 根节点也必须看到模拟后的伤害、装备和资源变化，否则第一次束裁剪会丢掉真正优质的动作。
        valueScore,
        pruneScore:valueScore + searchPrior(candidate.action, visibleState),
        sequence:[candidate.action],
        remainingRootExposeStacks:candidate.remainingRootExposeStacks,
        remainingHistory:[candidate.remainingRootExposeStacks],
        candidateLedger:candidate.candidateLedger,
        frontierResidual:candidate.frontierResidual
      });
    }
    beam.sort((a,b) => b.pruneScore - a.pruneScore);
    let activeBeam = beam.slice(0, GAME_CONFIG.aiBeamWidth);
    let bestCandidate = beam.reduce((best, node) => (
      !best || node.valueScore > best.valueScore ? node : best
    ), null) ?? activeBeam[0];
    const rootAssaultTargets = new Set(rootActions.filter((action) => action.card?.definitionId === "assault").map((action) => action.targets?.[0]?.id));
    let discoveredDynamicTarget = false;
    for (let depth = 2; depth <= GAME_CONFIG.aiSearchDepth; depth += 1) {
      if (limitReached() || activeBeam.every((node) => node.terminal)) break;
      const candidates = [];
      for (const node of activeBeam) {
        if (node.terminal) {
          candidates.push({ ...node, pruneScore:node.valueScore });
          continue;
        }
        const followActions = this.generateFromVisible(node.state, player.id);
        // 每张 follow 只 apply 一次并记录未调整 base transition；找到该 parent 下
        // 最佳非封印即时动作后，再只对 seal 候选应用“延迟一步”的 timing penalty。
        const nodeCandidates = [];
        let bestNonSealBase = -Infinity;
        // 深层 end 机会成本：只累计真实正收益 non-end follow 的未缩放边际（baseTransition×depth）。
        let bestPositiveFollowMarginal = 0;
        for (const follow of followActions) {
          if (limitReached()) break;
          if (follow.card?.definitionId === "assault" && !rootAssaultTargets.has(follow.targets?.[0]?.id)) discoveredDynamicTarget = true;
          const state = simulator.apply(node.state, follow, player.id);
          const exposeMarginal = follow.card?.definitionId === "exposeWeakness"
            ? this.evaluateExposeMarginal(node.state, state, player.id, simulator) / depth
            : 0;
          const assaultStacksCredit = follow.card?.definitionId === "assault"
            ? this.evaluateAssaultStacksMarginal(
              node.state, follow, player.id, node.remainingRootExposeStacks, simulator
            ) / depth
            : 0;
          const remainingRootExposeStacks = follow.card?.definitionId === "assault"
            ? this.advanceRemainingRootExposeStacks(
              node.state, state, player.id, node.remainingRootExposeStacks
            )
            : node.remainingRootExposeStacks;
          const baseTransition = transitionScore(follow, node.state, state, depth, 0);
          // 深层候选只附加 frontier-only residual：owner ledger / 响应反事实只对根
          // 候选计算（代价有界），深层节点以恒定小开销推进，避免拉长搜索时延。
          const frontierResidual = Boolean(state.playPhaseEnded)
            ? this.frontierResidualOf(state, player.id)
            : null;
          // 前沿积分只计入 held 未来选项（与根候选同一口径），只在终局计一次。
          const frontierValue = frontierResidual
            ? (frontierResidual.held.recover + frontierResidual.held.recycle) * STATE_DELTA_SCALE
            : 0;
          if (follow.card?.definitionId !== "seal" && follow.type !== "end") {
            bestNonSealBase = Math.max(bestNonSealBase, baseTransition);
          }
          if (follow.type !== "end") {
            bestPositiveFollowMarginal = Math.max(bestPositiveFollowMarginal, baseTransition * depth);
          }
          nodeCandidates.push({
            follow, state, exposeMarginal, assaultStacksCredit, remainingRootExposeStacks, baseTransition,
            frontierResidual, frontierValue
          });
          expanded += 1;
          if (expanded % GAME_CONFIG.aiSearchYieldEvery === 0) {
            if (!(await this.yieldControl(options.gameId))) return { type:"end" };
          }
          if (limitReached()) break;
        }
        // end follow 的机会成本按真实正收益 sibling 边际计算（封顶），而不是 sibling 存在性。
        const endFollowCandidate = nodeCandidates.find((candidate) => candidate.follow.type === "end");
        if (endFollowCandidate) {
          endFollowCandidate.baseTransition = -Math.min(END_OPPORTUNITY_CAP, bestPositiveFollowMarginal) / depth;
        }
        for (const candidate of nodeCandidates) {
          // 当前 depth=d：替代 base transition 已是 U/d，延迟一步贡献 U/(d+1)，
          // 因此 delayCost = bestNonSealBase / (d + 1)。
          const sealTimingPenalty = candidate.follow.card?.definitionId === "seal"
            ? sealEarlyUsePenalty(sealDelayCost(bestNonSealBase, depth))
            : 0;
          const valueScore = node.valueScore + this.composeCandidateValue(
            candidate.baseTransition,
            0,
            candidate.frontierValue,
            sealTimingPenalty,
            candidate.exposeMarginal,
            candidate.assaultStacksCredit
          );
          candidates.push({
            action:node.action,
            state:candidate.state,
            terminal:Boolean(candidate.state.playPhaseEnded),
            valueScore,
            pruneScore:valueScore + searchPrior(candidate.follow, node.state) / depth,
            sequence:[...node.sequence, candidate.follow],
            remainingRootExposeStacks:candidate.remainingRootExposeStacks,
            remainingHistory:[...node.remainingHistory, candidate.remainingRootExposeStacks],
            frontierResidual:candidate.frontierResidual
          });
          if (!bestCandidate || valueScore > bestCandidate.valueScore) bestCandidate = candidates.at(-1);
        }
        if (limitReached()) break;
      }
      if (!candidates.length) break;
      candidates.sort((a,b) => b.pruneScore - a.pruneScore);
      activeBeam = candidates.slice(0, GAME_CONFIG.aiBeamWidth);
      if (limitReached()) break;
    }
    // 终局选择必须只按真实 valueScore 重新排序，search credit 不得影响最终比较。
    activeBeam.sort((a,b) => b.valueScore - a.valueScore);
    let choice = nodeBudget !== null && limitReached()
      ? bestCandidate
      : this.chooseCandidate(activeBeam);
    // end fallback：即使 end 因 search prior 被 beam 剪掉，只要搜索到的候选真实价值
    // 都不超过 end 的机会成本修正价值（root depth=1），最终仍必须能选择 end，
    // 保证负收益动作永远不会因为“end 被剪枝”而被强制执行。
    const rootEndAction = rootActions.find((action) => action.type === "end");
    const endInFinalBeam = activeBeam.some((node) => node.action?.type === "end");
    if (rootEndAction && !endInFinalBeam) {
      const endFallbackBase = -Math.min(END_OPPORTUNITY_CAP, bestPositiveRootMarginal);
      const endTerminal = simulator.apply(visibleState, rootEndAction, player.id);
      const endFrontier = Boolean(endTerminal.playPhaseEnded)
        ? this.frontierResidualOf(endTerminal, player.id)
        : null;
      const endFallbackValue = endFallbackBase
        + (endFrontier
          ? (endFrontier.held.recover + endFrontier.held.recycle) * STATE_DELTA_SCALE
          : 0);
      if (!choice || endFallbackValue > choice.valueScore) {
        choice = {
          action: rootEndAction,
          state: endTerminal,
          terminal: true,
          valueScore: endFallbackValue,
          pruneScore: endFallbackValue,
          sequence: [rootEndAction],
          remainingHistory: [],
          frontierResidual: endFrontier
        };
      }
    }
    const selectedSequence = [...(choice?.sequence ?? [])];
    const endIndex = selectedSequence.findIndex((action) => action.type === "end");
    this.lastPlannedSequence = (endIndex >= 0 ? selectedSequence.slice(0, endIndex + 1) : selectedSequence)
      .map((action) => this.describeAction(action));
    this.lastSearchStats = { elapsedMs:(globalThis.performance?.now?.() ?? Date.now()) - started, expanded, depth:Math.max(1, choice?.sequence.length ?? 1), beamWidth:GAME_CONFIG.aiBeamWidth,
      budgetType:nodeBudget === null ? "time" : "nodes", nodeBudget,
      discoveredDynamicTarget, hiddenSamples:hiddenWorlds.length, bestSequence:this.lastPlannedSequence,
      bestRemainingProvenance:choice?.remainingHistory ?? [], bestValueScore:choice?.valueScore ?? null,
      // 仅在 collectAiDecisionDiagnostics=true 时包含 owner-local root ledger；生产为空数组。
      rootLedgers };
    return choice?.action ?? { type:"end" };
  }
}
