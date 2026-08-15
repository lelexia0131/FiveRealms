/*
模块职责
作为 AI 组合根一次性构造组件、注入窄能力，并向真实执行边界提供稳定门面。

上游
Game、ResponseSystem、PublicCardPool、角色技能与测试。

下游
状态组合、Knowledge、选择、响应、动作生成、评估与 Planner。

状态边界
只在门面入口读取当前 GameState；价值与搜索组件仅接收 SearchState 与显式能力。

信息边界
隐藏信息只能经 Knowledge 和状态组合入口进入决策，门面不得暴露敌方未知牌面。

架构约束
子组件不得回指 AIController；公开 owner 字段只供显式诊断与专项测试，生产上游使用控制器边界。
*/
import { createInitialSearchState } from "./state/StateContracts.js?build=20260815-threat-exposure-fix-final";
import { Knowledge } from "./state/Knowledge.js?build=20260815-threat-exposure-fix-final";
import { CardSelectionBoundary } from "./policy/CardSelectionBoundary.js?build=20260815-threat-exposure-fix-final";
import { ResponseBoundary } from "./policy/ResponseBoundary.js?build=20260815-threat-exposure-fix-final";
import { ActionGenerator } from "./search/ActionGenerator.js?build=20260815-threat-exposure-fix-final";
import { ValueService } from "./value/ValueService.js?build=20260815-threat-exposure-fix-final";
import { StateValue } from "./value/StateValue.js?build=20260815-threat-exposure-fix-final";
import { ValueSimulationQuery } from "./simulation/ValueSimulationQuery.js?build=20260815-threat-exposure-fix-final";
import { Simulator } from "./simulation/Simulator.js?build=20260815-threat-exposure-fix-final";
import { ActionDescriptor } from "./search/ActionDescriptor.js?build=20260815-threat-exposure-fix-final";
import { CandidateMaterializer } from "./search/CandidateMaterializer.js?build=20260815-threat-exposure-fix-final";
import { CounterfactualTerms } from "./search/CounterfactualTerms.js?build=20260815-threat-exposure-fix-final";
import { Planner } from "./search/Planner.js?build=20260815-threat-exposure-fix-final";
import { SearchBudget } from "./search/SearchBudget.js?build=20260815-threat-exposure-fix-final";
import { SearchPolicy } from "./search/SearchPolicy.js?build=20260815-threat-exposure-fix-final";
import { SiblingTransitionTerms } from "./search/SiblingTransitionTerms.js?build=20260815-threat-exposure-fix-final";
import { tacticResolutionScale } from "./search/TacticResolutionQuery.js?build=20260815-threat-exposure-fix-final";
import { FrontierValue } from "./search/FrontierValue.js?build=20260815-threat-exposure-fix-final";
import { SearchPrior } from "./search/SearchPrior.js?build=20260815-threat-exposure-fix-final";
import { TransitionValue } from "./search/TransitionValue.js?build=20260815-threat-exposure-fix-final";
import { Evaluator } from "./value/Evaluator.js?build=20260815-threat-exposure-fix-final";
import { ValueLedger } from "./value/ValueLedger.js?build=20260815-threat-exposure-fix-final";
import { ActionCandidatePolicy } from "./policy/ActionCandidatePolicy.js?build=20260815-threat-exposure-fix-final";
import { CardSelectionPolicy } from "./policy/CardSelectionPolicy.js?build=20260815-threat-exposure-fix-final";
import { ResourceSelectionPolicy } from "./policy/ResourceSelectionPolicy.js?build=20260815-threat-exposure-fix-final";
import { ResponsePolicy } from "./policy/ResponsePolicy.js?build=20260815-threat-exposure-fix-final";
import { TransferPolicy } from "./policy/TransferPolicy.js?build=20260815-threat-exposure-fix-final";
import { assessGlobalBenefit } from "./value/GlobalBenefitValue.js?build=20260815-threat-exposure-fix-final";

export class AIController {
  /*
  功能
  按明确顺序构造 AI 组件，并把窄能力一次性注入依赖方。

  调用方
  Game 构造函数与直接构造测试。

  输入
  当前 Game 实例。

  输出
  完成装配的 AIController；缺少必要运行能力时由子组件构造立即失败。

  读取状态
  Game 的随机源、搜索覆盖配置、CleanupManager 与会话状态。

  写入状态
  仅写控制器组件字段。

  调用函数
  Value owners、Knowledge、正式 Policy、执行边界、ActionGenerator 与 Planner 构造函数。

  边界与不变量
  装配无事后补丁；闭包持有具体组件或 Game 能力，不把 Controller 传给任何子组件。
  */
  constructor(game) {
    this.game = game;
    this.knowledge = new Knowledge(game);
    this.stateEvaluator = new Evaluator({
      getMaxEnergy: (player) => game.teamRules.getMaxEnergy(player),
      getTurnEnergyBreakdown: (player) => game.teamRules.getTurnEnergyBreakdown(player)
    });
    this.valueSimulationQuery = new ValueSimulationQuery(this.stateEvaluator);
    this.stateValue = new StateValue(this.stateEvaluator, this.valueSimulationQuery);
    this.valueLedger = new ValueLedger({
      evaluator: this.stateEvaluator,
      stateValue: this.stateValue,
      simulationQuery: this.valueSimulationQuery
    });
    this.frontierValue = new FrontierValue();
    this.searchPrior = new SearchPrior({
      getDifficultyMultiplier: () => game.aiDifficultyMultiplier,
      simulationQuery: this.valueSimulationQuery
    });
    this.transitionValue = new TransitionValue(this.stateValue);
    this.evaluator = new ValueService({
      evaluator: this.stateEvaluator,
      stateValue: this.stateValue,
      simulationQuery: this.valueSimulationQuery,
      valueLedger: this.valueLedger,
      frontierValue: this.frontierValue,
      searchPrior: this.searchPrior,
      transitionValue: this.transitionValue
    });
    this.resourceSelectionPolicy = new ResourceSelectionPolicy();
    this.transferPolicy = new TransferPolicy();
    this.cardSelectionPolicy = new CardSelectionPolicy({
      random: () => game.random(),
      remainingCounts: (actor) => this.knowledge.remainingCounts(actor),
      resourcePolicy: this.resourceSelectionPolicy,
      transferPolicy: this.transferPolicy
    });
    this.actionCandidatePolicy = new ActionCandidatePolicy();
    this.responseDecisionPolicy = new ResponsePolicy({ assessGlobalBenefit });
    this.cardSelector = new CardSelectionBoundary(game, this.knowledge, {
      cardSelectionPolicy: this.cardSelectionPolicy,
      resourcePolicy: this.resourceSelectionPolicy,
      transferPolicy: this.transferPolicy
    });
    this.responsePolicy = new ResponseBoundary(game, this.evaluator, this.knowledge, {
      responsePolicy: this.responseDecisionPolicy,
      simulationQuery: this.valueSimulationQuery,
      stateValue: this.stateValue
    });

    const cardSelector = this.cardSelector;
    this.actionGenerator = new ActionGenerator(game, {
      chooseTransferCombination: (...args) => cardSelector.chooseTransferCombination(...args),
      transferPolicy: this.transferPolicy,
      actionCandidatePolicy: this.actionCandidatePolicy
    });

    const actionGenerator = this.actionGenerator;
    const knowledge = this.knowledge;
    this.searchPolicy = new SearchPolicy({
      random: () => game.random(),
      getRandomnessRange: () => game.aiRandomnessRange
    });
    this.counterfactualTerms = new CounterfactualTerms({
      evaluator: this.evaluator,
      generateFromVisible: (...args) => actionGenerator.generateFromVisible(...args),
      sampleHiddenWorlds: (...args) => knowledge.sampleHiddenWorlds(...args),
      hiddenSampleCount: this.searchPolicy.structure().hiddenSamples
    });
    this.siblingTransitionTerms = new SiblingTransitionTerms();
    this.candidateMaterializer = new CandidateMaterializer({
      transitionValue: this.transitionValue,
      valueLedger: this.valueLedger,
      frontierValue: this.frontierValue,
      searchPrior: this.searchPrior,
      counterfactualTerms: this.counterfactualTerms,
      siblingTerms: this.siblingTransitionTerms,
      actionDescriptor: ActionDescriptor,
      getResolutionScale: tacticResolutionScale
    });
    this.planner = new Planner({
      candidateMaterializer: this.candidateMaterializer,
      searchPolicy: this.searchPolicy,
      simulatorFactory: (state) => new Simulator(state),
      searchBudgetFactory: () => new SearchBudget({
        timeBudget: game.aiSearchBudgetOverrideMs,
        nodeBudget: game.aiSearchNodeBudgetOverride
      }),
      generateFromVisible: (...args) => actionGenerator.generateFromVisible(...args),
      yieldControl: async (gameId) => (
        await game.cleanupManager.delay(0)
      ) && game.isSessionValid(gameId ?? game.state.gameId),
    });
  }

  /*
  功能
  通过动作生成器返回当前真实局面中经规则校验与 AI 候选策略筛选的根动作。

  调用方
  Game、selectAction、动作重绑与测试。

  输入
  当前行动 Player。

  输出
  供 Planner 搜索的候选动作数组；它是游戏规则合法动作的策略子集。

  读取状态
  当前 GameState 与 RuleEngine 权威。

  写入状态
  无。

  调用函数
  ActionGenerator.generate。

  边界与不变量
  RuleEngine 定义游戏合法性，ActionCandidatePolicy 只决定 AI 是否考虑候选；门面不得额外筛选或重排，也不得把策略拒绝解释为游戏非法。
  */
  getActionCandidates(player) {
    return this.actionGenerator.generate(player);
  }

  /*
  功能
  从当前真实状态构造搜索快照并请求 Planner 选择动作。

  调用方
  Game AI 出牌循环与测试。

  输入
  当前行动 Player 与可选搜索上下文。

  输出
  Planner 从 AI 候选集合中选择的当前可执行动作。

  读取状态
  当前 GameState、合法 Knowledge 与搜索配置。

  写入状态
  Planner 最近搜索诊断与计划序列。

  调用函数
  Knowledge.remainingCounts、createInitialSearchState、getActionCandidates、Planner.plan。

  边界与不变量
  剩余牌计数每次真实决策只计算一次，Planner 不获得 Game 或 Controller。
  */
  async selectAction(player, options = {}) {
    const remainingCardCounts = this.knowledge.remainingCounts(player);
    const visible = createInitialSearchState(player.id, this.game.state, remainingCardCounts);
    return this.planner.plan(player, visible, this.getActionCandidates(player), options);
  }

  /*
  功能
  将搜索计划中的动作描述重新绑定到当前真实局面的 AI 候选动作。

  调用方
  Game 复用计划序列时。

  输入
  当前行动 Player 与稳定动作描述。

  输出
  匹配的当前动作；状态变化导致不匹配时返回 null。

  读取状态
  当前通过规则校验并经 AI 候选策略过滤的动作集合。

  写入状态
  无。

  调用函数
  getActionCandidates。

  边界与不变量
  实体牌优先按实例 ID 重绑，目标顺序和选择字段必须完全一致。
  */
  resolvePlannedAction(player, descriptor) {
    if (!descriptor) return null;
    return this.getActionCandidates(player).find((action) => {
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

  /*
  功能
  返回 Planner 最近生成计划序列的隔离副本。

  调用方
  Game 可选连续计划执行路径。

  输入
  无。

  输出
  动作序列浅副本。

  读取状态
  Planner.lastPlannedSequence。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  调用方不得通过返回数组修改 Planner 内部序列。
  */
  getPlannedSequence() {
    return [...this.planner.lastPlannedSequence];
  }

  /*
  功能
  选择需要弃置的实体牌。

  调用方
  Game 与角色被动规则。

  输入
  付款 Player 与弃牌数量。

  输出
  按既有保留价值排序的实体牌数组。

  读取状态
  当前 GameState、Knowledge 与选择策略。

  写入状态
  无。

  调用函数
  CardSelectionBoundary.chooseDiscards。

  边界与不变量
  门面不改动选择结果或牌序。
  */
  chooseDiscards(player, count) {
    return this.cardSelector.chooseDiscards(player, count);
  }

  /*
  功能
  为转移牌选择来源、接收者和资源类别。

  调用方
  Game 转移准备与 ActionGenerator 注入能力。

  输入
  转移行动者、卡牌、合法来源及可选接收者和排除集合。

  输出
  最佳正收益选择描述；无正收益时为 null。

  读取状态
  当前 GameState、Knowledge 与转移评分。

  写入状态
  无。

  调用函数
  CardSelectionBoundary.chooseTransferCombination。

  边界与不变量
  不解析或移动实体牌，真实执行仍必须重新验证。
  */
  chooseTransferCombination(...args) {
    return this.cardSelector.chooseTransferCombination(...args);
  }

  /*
  功能
  从合法隐藏手牌位置中选择实体牌。

  调用方
  Game 的隐藏选择边界。

  输入
  观察者、持有者、数量及可选排除和用途上下文。

  输出
  合法实体牌数组。

  读取状态
  观察者合法记忆、剩余牌计数与随机源。

  写入状态
  随机源序列。

  调用函数
  CardSelectionBoundary.chooseHiddenCards。

  边界与不变量
  未知牌只能按位置采样，调用次数和随机数顺序保持选择器既有语义。
  */
  chooseHiddenCards(...args) {
    return this.cardSelector.chooseHiddenCards(...args);
  }

  /*
  功能
  在目标手牌与装备区之间选择资源实体。

  调用方
  Game 的区域选择边界。

  输入
  行动者、资源持有者、用途上下文与排除集合。

  输出
  带实体牌和区域的选择；无资源时为 null。

  读取状态
  合法记忆、公开装备与资源选择价值。

  写入状态
  可能消费随机源序列。

  调用函数
  CardSelectionBoundary.chooseZoneCard。

  边界与不变量
  不读取未知牌定义，真实执行仍按实体身份复核。
  */
  chooseZoneCard(...args) {
    return this.cardSelector.chooseZoneCard(...args);
  }

  /*
  功能
  从公开牌池选择最适合当前角色的牌。

  调用方
  PublicCardPool。

  输入
  当前 Player 与公开实体牌数组。

  输出
  被选实体牌；空牌池时为 null。

  读取状态
  角色卡牌价值。

  写入状态
  无。

  调用函数
  CardSelectionBoundary.choosePublicCard。

  边界与不变量
  门面不改变同分时的原始顺序。
  */
  choosePublicCard(...args) {
    return this.cardSelector.choosePublicCard(...args);
  }

  /*
  功能
  判断 AI 是否在当前响应窗口使用候选响应。

  调用方
  ResponseSystem 与直接测试。

  输入
  响应者、响应类型、公开上下文与合法候选牌。

  输出
  是否响应的布尔值。

  读取状态
  当前 GameState、Knowledge、评估与响应策略。

  写入状态
  无。

  调用函数
  ResponseBoundary.shouldRespond。

  边界与不变量
  候选牌默认空数组；门面不得构造或泄露额外隐藏信息。
  */
  shouldRespond(player, type, context, cards = []) {
    return this.responsePolicy.shouldRespond(player, type, context, cards);
  }

  /*
  功能
  在重定向备选目标中保持既有首项选择语义。

  调用方
  统一响应流程。

  输入
  当前 Player 与合法替代目标数组。

  输出
  首个目标；空数组时为 null。

  读取状态
  无。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不增加评分、随机或目标重排。
  */
  chooseRedirectTarget(_player, alternatives) {
    return alternatives[0] ?? null;
  }
}
