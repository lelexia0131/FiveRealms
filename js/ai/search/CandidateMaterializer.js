/*
模块职责
负责 candidate materialization（候选物化：把已模拟动作完整转换成可比较搜索节点），产出显式转移项、诊断表示、前沿值与最终候选值。

上游
Planner 与搜索价值回归测试。

下游
TransitionValue、ValueLedger、FrontierValue、SearchPrior、CounterfactualTerms、SiblingTransitionTerms、ActionDescriptor 与 Economics 尺度。

状态边界
只读动作前后的 SearchState；反事实写入由注入的数值项生产者隔离。

信息边界
只消费有明确归属者的数值与合法隐藏上下文，不访问 Game 或 Controller。

架构约束
每项价值只向唯一归属者请求一次；不得生成/执行真实动作、决定束裁剪或同分裁决，也不得复制最终价值组合公式。
*/
import { statePointsToUtility } from "../value/Economics.js";
import { STATE_UTILITY_PRIOR_WEIGHT } from "./SearchPrior.js";

export class CandidateMaterializer {
  /*
  功能
  绑定候选物化所需的正式归属模块。

  调用方
  AIController 组合根与 Planner 正式边界。

  输入
  价值/搜索归属模块、转移项生产者与动作描述适配器。

  输出
  候选物化服务实例。

  读取状态
  保存显式依赖引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  任一必要归属模块缺失时立即失败，不保存 Game、Controller 或 Simulator。
  */
  constructor({
    transitionValue,
    valueLedger,
    frontierValue,
    searchPrior,
    counterfactualTerms,
    siblingTerms,
    actionDescriptor,
    getResolutionScale
  } = {}) {
    const services = {
      transitionValue,
      valueLedger,
      frontierValue,
      searchPrior,
      counterfactualTerms,
      siblingTerms,
      actionDescriptor
    };
    for (const [name, service] of Object.entries(services)) {
      if (!service) throw new TypeError(`CandidateMaterializer 缺少依赖：${name}`);
    }
    if (typeof getResolutionScale !== "function") {
      throw new TypeError("CandidateMaterializer 缺少依赖：getResolutionScale");
    }
    Object.assign(this, services);
    this.getResolutionScale = getResolutionScale;
  }

  /*
  功能
  把根候选的廉价探索顺序评分委托给唯一 SearchPrior owner。

  调用方
  Planner 在任何 root materialization 前。

  输入
  根动作、行动者与根 SearchState。

  输出
  有限调度分数；缺少测试 stub 方法时兼容返回零。

  读取状态
  只读 SearchPrior 与输入动作/状态。

  写入状态
  无。

  调用函数
  SearchPrior.rootSchedulingScore。

  边界与不变量
  本适配器不拥有或修改评分，结果不得进入候选 value/prior。
  */
  rootSchedulingScore(action, player, visibleState) {
    const score = this.searchPrior.rootSchedulingScore?.(action, player, visibleState) ?? 0;
    return Number.isFinite(score) || score === Number.NEGATIVE_INFINITY ? score : 0;
  }

  /*
  功能
  返回不含实体手牌顺序与 card instance ID 的 root 调度语义键。

  调用方
  Planner 的确定性同分排序。

  输入
  根候选动作。

  输出
  ActionDescriptor 提供的稳定字符串键。

  读取状态
  只读动作公开搜索语义。

  写入状态
  无。

  调用函数
  ActionDescriptor.schedulingKey。

  边界与不变量
  type、definition/skill、目标顺序与 selection 必须保留；不得包含 hand index。
  */
  rootSchedulingKey(action) {
    return this.actionDescriptor.schedulingKey(action);
  }

  /*
  功能
  返回保留 execution 与 availability 差异的普通搜索 secondary key。

  调用方
  Planner 的 root 与 child 确定性同 intent 排序。

  输入
  当前 runtime search action。

  输出
  ActionDescriptor 提供的稳定 search-semantic 字符串。

  读取状态
  只读动作已经携带的公开搜索执行语义。

  写入状态
  无。

  调用函数
  ActionDescriptor.searchSemanticKey。

  边界与不变量
  不得进入 Pattern intent、候选 value 或 prior；不得使用 hand index 或 card instance ID。
  */
  schedulingSecondaryKey(action) {
    return this.actionDescriptor.searchSemanticKey(action);
  }

  /*
  功能
  把深层候选的廉价探索顺序评分委托给现有 SearchPrior owner。

  调用方
  Planner 在任何 child materialization 前。

  输入
  当前动作、行动者与动作生成后的 SearchState。

  输出
  与 root scheduling 相同定义的有限调度分数。

  读取状态
  只读 SearchPrior 与输入动作/状态。

  写入状态
  无。

  调用函数
  SearchPrior.rootSchedulingScore。

  边界与不变量
  这是同一搜索先验的结构性复用，不引入新的权重，也不得进入候选 value/prior。
  */
  childSchedulingScore(action, player, state) {
    return this.rootSchedulingScore(action, player, state);
  }

  /*
  功能
  返回不含 hand index 与 card instance ID 的深层动作调度语义键。

  调用方
  Planner 的确定性 child 同分排序。

  输入
  当前深层候选动作。

  输出
  ActionDescriptor 提供的稳定字符串键。

  读取状态
  只读动作公开搜索语义。

  写入状态
  无。

  调用函数
  ActionDescriptor.schedulingKey。

  边界与不变量
  必须与 root scheduling 使用同一 semantic identity，不得读取物理手牌顺序。
  */
  childSchedulingKey(action) {
    return this.rootSchedulingKey(action);
  }

  /*
  功能
  创建一次规划共用的领域转移上下文（context）。

  调用方
  Planner.plan。

  输入
  行动者、根 SearchState 与根动作。

  输出
  冻结的领域上下文。

  读取状态
  委托 CounterfactualTerms。

  写入状态
  由 CounterfactualTerms 消耗既有隐藏采样随机序列。

  调用函数
  CounterfactualTerms.createContext。

  边界与不变量
  每次规划只调用一次。
  */
  createContext(player, visibleState, rootActions) {
    return this.counterfactualTerms.createContext(player, visibleState, rootActions);
  }

  /*
  功能
  记录不参与评分的候选诊断事实。

  调用方
  Planner 深层生成循环。

  输入
  动作与当前搜索上下文。

  输出
  无。

  读取状态
  委托 CounterfactualTerms。

  写入状态
  只写上下文的诊断字段。

  调用函数
  CounterfactualTerms.observeCandidate。

  边界与不变量
  不返回或改变任何评分项。
  */
  observeCandidate(action, context) {
    this.counterfactualTerms.observeCandidate(action, context);
  }

  /*
  功能
  把领域上下文投影为 Planner 可记录的普通搜索诊断。

  调用方
  Planner.recordResult。

  输入
  当前规划的反事实上下文。

  输出
  hiddenSamples 与 discoveredDynamicTarget。

  读取状态
  上下文的隐藏样本数组和只增诊断标记。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不暴露样本内容或领域来源记录，诊断值不参与评分。
  */
  contextDiagnostics(context) {
    return {
      hiddenSamples:context.hiddenWorldEstimate.sampleCount,
      discoveredDynamicTarget:Boolean(context.discoveredDynamicTarget)
    };
  }

  /*
  功能
  物化一次已由 Planner 模拟的候选评分记录。

  调用方
  Planner 根与深层展开。

  输入
  动作、前后状态、行动者、深度、来源记录、Simulator、领域上下文与诊断开关。

  输出
  包含基础转移、领域项、前沿值、搜索先验与诊断账本的候选记录；预算中断返回 null。

  读取状态
  只读输入状态并调用正式归属模块。

  写入状态
  只允许转移项生产者写独立反事实状态。

  调用函数
  CounterfactualTerms、TransitionValue、ValueLedger、FrontierValue 与 SearchPrior。

  边界与不变量
  基础转移只计算一次；end 只读取既有 mandatory-discard 前后身份，不再次模拟；
  诊断关闭时不构造账本；最终价值尚不在此组合；反事实未完整返回时不得登记 partial candidate。
  所有 nested value/simulation query 必须继承传入的同一 SearchBudget。
  */
  materialize({
    action,
    beforeState,
    afterState,
    player,
    depth,
    remainingProvenance,
    simulator,
    context,
    collectDiagnostics = false,
    searchBudget = null
  }) {
    const terms = this.counterfactualTerms.candidateTerms({
      beforeState,
      afterState,
      action,
      actorId:player.id,
      depth,
      remainingProvenance,
      simulator,
      context,
      searchBudget
    });
    if (terms === null) return null;
    const baseTerms = this.transitionValue.evaluateBase({
      action,
      player,
      beforeState,
      afterState,
      depth,
      endOpportunityCost:0,
      getResolutionScale:() => this.getResolutionScale(
        action,
        beforeState,
        player.id,
        simulator
      ),
      searchBudget
    });
    const baseTransition = baseTerms.baseTransition;
    const candidateLedger = collectDiagnostics
      ? this.valueLedger.computeCandidateLedger(
          beforeState,
          action,
          afterState,
          player.id,
          true,
          searchBudget
        )
      : null;
    const responseNet = (candidateLedger?.responses ?? [])
      .reduce((sum, response) => sum + (response.netValue ?? 0), 0);
    const terminal = Boolean(afterState.playPhaseEnded);
    const frontierResidual = terminal
      ? this.frontierValue.frontierResidual(afterState, player.id)
      : null;
    const frontierValue = this.frontierValue.finalValue(frontierResidual, terminal);
    const beforeActor = beforeState.players.find((entry) => entry.id === player.id);
    const forcedDiscardOptions = terminal && beforeActor
      ? this.siblingTerms.forcedDiscardOptions(
          beforeState,
          afterState,
          player.id,
          simulator.buildDiscardKeepValueContext(beforeState, beforeActor)
        )
      : [];
    // 破势点数先按 HP 基线归一化，再乘纯 beam heuristic；该结果不进入 Final Utility。
    const domainPrior = statePointsToUtility(
      terms.exposeMarginal + terms.assaultStacksCredit
    ) * STATE_UTILITY_PRIOR_WEIGHT;
    const searchCredit = this.searchPrior.actionSearchPrior(action, player, beforeState);
    const prior = this.counterfactualTerms.hiddenPrior(action, context)
      + this.searchPrior.actionUtility(action, player, beforeState, { searchBudget })
      + searchCredit
      + domainPrior;
    return {
      action,
      state:afterState,
      terminal,
      baseTerms,
      baseTransition,
      exposeMarginal:terms.exposeMarginal,
      assaultStacksCredit:terms.assaultStacksCredit,
      spyGapInformationValue:terms.spyGapInformationValue ?? 0,
      remainingProvenance:terms.nextProvenance,
      candidateLedger,
      responseNet,
      frontierResidual,
      frontierValue,
      forcedDiscardOptions,
      forcedDiscardOpportunity:0,
      domainPrior,
      searchCredit,
      prior,
      transitionValue:null
    };
  }

  /*
  功能
  完成同层 end 兼容收口，并通过唯一公式计算每个候选的最终 Transition Value。

  调用方
  Planner 完成同一父节点下的所有候选物化后。

  输入
  同层候选记录。

  输出
  零值 end 兼容摘要；每个候选获得 transitionValue。

  读取状态
  候选记录中的显式数值项。

  写入状态
  写候选的基础转移和最终转移数值字段。

  调用函数
  SiblingTransitionTerms.finalize、TransitionValue.composeCandidateValue。

  边界与不变量
  最终组合只调用正式归属模块；responseNet 仍为诊断项，不影响公式结果。
  */
  finalizeSiblings(candidates) {
    const summary = this.siblingTerms.finalize(candidates);
    for (const candidate of candidates) {
      candidate.transitionValue = this.transitionValue.composeCandidateValue({
        baseTransition:candidate.baseTransition,
        responseNet:candidate.responseNet,
        frontierValue:candidate.frontierValue,
        spyGapInformationValue:candidate.spyGapInformationValue ?? 0
      });
    }
    return summary;
  }

  /*
  功能
  构造根候选的稳定诊断条目。

  调用方
  Planner 诊断路径。

  输入
  已完成物化的候选记录。

  输出
  动作描述、价值投影、响应诊断与前沿数值。

  读取状态
  候选账本和动作。

  写入状态
  无。

  调用函数
  ActionDescriptor.describe。

  边界与不变量
  只在诊断开启且账本存在时调用，不参与评分。
  */
  diagnosticEntry(candidate) {
    return {
      action:this.describeAction(candidate.action),
      projected:candidate.candidateLedger.projected,
      responses:candidate.candidateLedger.responses,
      responseNet:candidate.responseNet,
      frontierValue:candidate.frontierValue
    };
  }

  /*
  功能
  通过纯适配器返回稳定动作描述。

  调用方
  Planner 计划序列、正式边界与测试。

  输入
  候选动作。

  输出
  稳定动作描述对象。

  读取状态
  只读动作。

  写入状态
  无。

  调用函数
  actionDescriptor.describe。

  边界与不变量
  不访问 Game、合法性或隐藏信息。
  */
  describeAction(action) {
    return this.actionDescriptor.describe(action);
  }

  /*
  功能
  找到候选集合中的显式终止动作。

  调用方
  Planner 的结束动作回退路径。

  输入
  动作数组。

  输出
  首个终止动作或 undefined。

  读取状态
  委托 SiblingTransitionTerms 的类型判断。

  写入状态
  无。

  调用函数
  SiblingTransitionTerms.isTerminalAction。

  边界与不变量
  不创建终止动作，回退路径只能使用根合法集合已有动作。
  */
  findTerminalAction(actions) {
    return actions.find((action) => this.siblingTerms.isTerminalAction(action));
  }

  /*
  功能
  截断终止动作之后不会执行的计划尾部，并投影为稳定动作描述。

  调用方
  Planner 搜索收束。

  输入
  动作序列。

  输出
  截断后的稳定动作描述序列。

  读取状态
  动作类型与动作描述字段。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  首个终止动作仍保留；无终止动作时保留完整序列。
  */
  describeSequence(sequence) {
    const terminalIndex = sequence.findIndex(
      (action) => this.siblingTerms.isTerminalAction(action)
    );
    return (terminalIndex >= 0 ? sequence.slice(0, terminalIndex + 1) : sequence)
      .map((action) => this.describeAction(action));
  }

  /*
  功能
  把预算边界补算的根终止动作送回正常候选物化与 sibling finalization 路径。

  调用方
  Planner 最终选择。

  输入
  end 动作、前后状态、行动者、已物化 non-end siblings、根 provenance、Simulator、搜索 context 与父 SearchBudget。

  输出
  与普通根 end 相同 shape 且已完成 transitionValue 的候选记录。

  读取状态
  before/after SearchState、已物化 siblings 与正式搜索归属模块。

  写入状态
  只写新建终止候选和 siblings 的浅复制，不修改调用方候选或真实 GameState。

  调用函数
  materialize、finalizeSiblings。

  边界与不变量
  不再次执行 end 模拟；fallback 必须与普通 end 共同经过 forced-discard/seal sibling owner，
  不能用预算中断前缺少 end 的 summary 绕过正常 after-state 与最终价值组合；
  nested value/simulation query 必须继承同一个父 SearchBudget。
  */
  terminalFallback({
    action,
    beforeState,
    afterState,
    player,
    siblingCandidates,
    remainingProvenance,
    simulator,
    context,
    searchBudget = null
  }) {
    const terminalCandidate = this.materialize({
      action,
      beforeState,
      afterState,
      player,
      depth:1,
      remainingProvenance,
      simulator,
      context,
      collectDiagnostics:false,
      searchBudget
    });
    const comparableSiblings = (siblingCandidates ?? []).map((candidate) => ({
      ...candidate,
      baseTransition:candidate.baseTerms?.baseTransition ?? candidate.baseTransition,
      transitionValue:null
    }));
    this.finalizeSiblings([...comparableSiblings, terminalCandidate]);
    return terminalCandidate;
  }
}
