/*
模块职责
负责 candidate materialization（候选物化：把已模拟动作完整转换成可比较搜索节点），产出显式转移项、诊断表示、前沿值与最终候选值。

上游
Planner 与搜索价值回归测试。

下游
TransitionValue、ValueLedger、FrontierValue、SearchPrior、CounterfactualTerms、SiblingTransitionTerms 与 ActionDescriptor。

状态边界
只读动作前后的 SearchState；反事实写入由注入的数值项生产者隔离。

信息边界
只消费有明确归属者的数值与合法隐藏上下文，不访问 Game 或 Controller。

架构约束
每项价值只向唯一归属者请求一次；不得生成/执行真实动作、决定束裁剪或同分裁决，也不得复制最终价值组合公式。
*/

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
      hiddenSamples:context.hiddenWorlds.length,
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
  包含基础转移、领域项、前沿值、搜索先验与诊断账本的候选记录。

  读取状态
  只读输入状态并调用正式归属模块。

  写入状态
  只允许转移项生产者写独立反事实状态。

  调用函数
  CounterfactualTerms、TransitionValue、ValueLedger、FrontierValue 与 SearchPrior。

  边界与不变量
  基础转移只计算一次；诊断关闭时不构造账本；最终价值尚不在此组合。
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
      searchBudget
    });
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
      )
    });
    const baseTransition = baseTerms.baseTransition;
    const candidateLedger = collectDiagnostics
      ? this.valueLedger.computeCandidateLedger(
          beforeState,
          action,
          afterState,
          player.id,
          true
        )
      : null;
    const responseNet = (candidateLedger?.responses ?? [])
      .reduce((sum, response) => sum + (response.netValue ?? 0), 0);
    const terminal = Boolean(afterState.playPhaseEnded);
    const frontierResidual = terminal
      ? this.frontierValue.frontierResidual(afterState, player.id)
      : null;
    const frontierValue = this.frontierValue.finalValue(frontierResidual, terminal);
    const prior = this.counterfactualTerms.hiddenPrior(action, context)
      + this.searchPrior.actionUtility(action, player, beforeState)
      + this.searchPrior.actionSearchPrior(action, player, beforeState);
    return {
      action,
      state:afterState,
      terminal,
      baseTerms,
      baseTransition,
      exposeMarginal:terms.exposeMarginal,
      assaultStacksCredit:terms.assaultStacksCredit,
      remainingProvenance:terms.nextProvenance,
      candidateLedger,
      responseNet,
      frontierResidual,
      frontierValue,
      prior,
      sealTimingPenalty:0,
      transitionValue:null
    };
  }

  /*
  功能
  完成同层结束/封印项，并通过唯一公式计算每个候选的最终 Transition Value。

  调用方
  Planner 完成同一父节点下的所有候选物化后。

  输入
  同层候选记录与真实搜索深度。

  输出
  结束回退基值摘要；每个候选获得 transitionValue。

  读取状态
  候选记录中的显式数值项。

  写入状态
  写候选的基础转移、封印时机和最终转移数值字段。

  调用函数
  SiblingTransitionTerms.finalize、TransitionValue.composeCandidateValue。

  边界与不变量
  最终组合只调用正式归属模块；responseNet 仍为诊断项，不影响公式结果。
  */
  finalizeSiblings(candidates, depth) {
    const summary = this.siblingTerms.finalize(candidates, depth);
    for (const candidate of candidates) {
      candidate.transitionValue = this.transitionValue.composeCandidateValue({
        baseTransition:candidate.baseTransition,
        responseNet:candidate.responseNet,
        frontierValue:candidate.frontierValue,
        sealTimingPenalty:candidate.sealTimingPenalty,
        exposeMarginal:candidate.exposeMarginal,
        assaultStacksCredit:candidate.assaultStacksCredit
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
  为被束搜索剪出的根终止动作恢复既有回退最终价值。

  调用方
  Planner 最终选择。

  输入
  终止后的状态、观察者 ID、同层结束回退基值与可选的终止前状态。

  输出
  前沿残值与最终 valueScore。

  读取状态
  终止 SearchState。

  写入状态
  无。

  调用函数
  FrontierValue、TransitionValue.composeCandidateValue/evaluateBase。

  边界与不变量
  不重新计算领域边际；end 自身状态变化由终止前状态经 evaluateBase 一次性计入，
  与机会成本共同组成最终 base，保留原回退路径的一次最终组合。
  */
  terminalFallback(afterState, viewerId, endFallbackBase, beforeState = null) {
    const terminal = Boolean(afterState.playPhaseEnded);
    const frontierResidual = terminal
      ? this.frontierValue.frontierResidual(afterState, viewerId)
      : null;
    const frontierValue = this.frontierValue.finalValue(frontierResidual, terminal);
    // end 自身状态变化（例如手牌上限弃牌）与放弃正收益 sibling 的机会成本共同构成最终 base。
    const ownBase = beforeState
      ? this.transitionValue.evaluateBase({
          action:{ type:"end" },
          player:{ id:viewerId },
          beforeState,
          afterState,
          depth:1
        }).baseTransition
      : 0;
    const valueScore = this.transitionValue.composeCandidateValue({
      baseTransition:endFallbackBase + ownBase,
      responseNet:0,
      frontierValue,
      sealTimingPenalty:0,
      exposeMarginal:0,
      assaultStacksCredit:0
    });
    return { frontierResidual, valueScore };
  }
}
