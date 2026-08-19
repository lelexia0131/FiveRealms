/*
模块职责
作为 AI 组合根一次性构造组件、注入窄能力，并向真实执行边界提供稳定门面。

上游
MatchApplication、ResponseWorkflow、PublicCardPoolWorkflow、角色技能与测试。

下游
状态组合、Knowledge、选择、响应、动作生成、评估与 Planner。

状态边界
只在门面入口读取当前 GameState；价值与搜索组件仅接收 SearchState 与显式能力。

信息边界
隐藏信息只能经 Knowledge 和状态组合入口进入决策，门面不得暴露敌方未知牌面。

架构约束
子组件不得回指 AIController；公开 owner 字段只供显式诊断与专项测试，生产上游使用控制器边界。
*/
import { createInitialSearchState } from "./state/StateContracts.js";
import { Knowledge } from "./state/Knowledge.js";
import { CardSelectionBoundary } from "./policy/CardSelectionBoundary.js";
import { ResponseBoundary } from "./policy/ResponseBoundary.js";
import { ActionGenerator } from "./search/ActionGenerator.js";
import { ValueService } from "./value/ValueService.js";
import { StateValue } from "./value/StateValue.js";
import { ValueSimulationQuery } from "./simulation/ValueSimulationQuery.js";
import { ResourceValueQuery } from "./simulation/ResourceValueQuery.js";
import { Simulator } from "./simulation/Simulator.js";
import { AI_RUNTIME_POLICY, AI_SEARCH_PROFILE } from "./policy/AiRuntimePolicy.js";
import { ActionDescriptor } from "./search/ActionDescriptor.js";
import { createSearchRequest } from "./search/SearchRequest.js";
import { describeRootSearchAction } from "./search/RootSearchAction.js";
import { createSearchResult, SEARCH_RESULT_STATUS } from "./search/SearchResult.js";
import { createWorkerSearchOutcome, workerOutcomeViolations } from "./search/WorkerSearchOutcome.js";
import { CandidateMaterializer } from "./search/CandidateMaterializer.js";
import { CounterfactualTerms } from "./search/CounterfactualTerms.js";
import { Planner } from "./search/Planner.js";
import { SearchBudget } from "./search/SearchBudget.js";
import { SearchPolicy } from "./search/SearchPolicy.js";
import { SiblingTransitionTerms } from "./search/SiblingTransitionTerms.js";
import { tacticResolutionScale } from "./search/TacticResolutionQuery.js";
import { FrontierValue } from "./search/FrontierValue.js";
import { SearchPrior } from "./search/SearchPrior.js";
import { TransitionValue } from "./search/TransitionValue.js";
import { Evaluator } from "./value/Evaluator.js";
import { ValueLedger } from "./value/ValueLedger.js";
import { ActionCandidatePolicy } from "./policy/ActionCandidatePolicy.js";
import { CardSelectionPolicy } from "./policy/CardSelectionPolicy.js";
import { ResourceSelectionPolicy } from "./policy/ResourceSelectionPolicy.js";
import { ResponsePolicy } from "./policy/ResponsePolicy.js";
import { TransferPolicy } from "./policy/TransferPolicy.js";
import { assessGlobalBenefit } from "./value/GlobalBenefitValue.js";

export class AIController {
  /*
  功能
  按明确顺序构造 AI 组件，并把窄能力一次性注入依赖方。

  调用方
  MatchApplication composition root 与直接构造测试。

  输入
  显式 narrow dependencies（state/session/rule capability/search RNG/lifecycle/rebind）。

  输出
  完成装配的 AIController；缺少必要运行能力时由子组件构造立即失败。

  读取状态
  无；依赖均为显式能力引用。

  写入状态
  仅写控制器组件字段。

  调用函数
  Value owners、Knowledge、正式 Policy、执行边界、ActionGenerator 与 Planner 构造函数。

  边界与不变量
  装配无事后补丁；闭包只持有窄能力，不保存 Game，也不把 Controller 传给任何子组件。
  */
  constructor(dependencies = {}) {
    const required = [
      "getState", "isSessionValid", "getMaxEnergy", "getTurnEnergyBreakdown",
      "getDifficultyMultiplier", "getRandomnessRange", "getSearchTimeBudget",
      "getSearchNodeBudget", "getEnemies", "getDyingRescueOrder", "isSmallTeam",
      "getForceAiRescueHuman", "yieldControl", "createId"
    ];
    for (const name of required) {
      if (typeof dependencies[name] !== "function") throw new TypeError(`AIController 缺少依赖：${name}`);
    }
    if (!dependencies.searchRng || typeof dependencies.searchRng.next !== "function"
      || typeof dependencies.searchRng.snapshot !== "function"
      || typeof dependencies.searchRng.commit !== "function") {
      throw new TypeError("AIController 缺少依赖：searchRng");
    }
    if (!dependencies.searchExecutor || typeof dependencies.searchExecutor.search !== "function") {
      throw new TypeError("AIController 缺少依赖：searchExecutor.search");
    }
    this.getState = dependencies.getState;
    this.isSessionValid = dependencies.isSessionValid;
    this.getMaxEnergy = dependencies.getMaxEnergy;
    this.getTurnEnergyBreakdown = dependencies.getTurnEnergyBreakdown;
    this.getDifficultyMultiplier = dependencies.getDifficultyMultiplier;
    this.getRandomnessRange = dependencies.getRandomnessRange;
    this.getSearchTimeBudget = dependencies.getSearchTimeBudget;
    this.getSearchNodeBudget = dependencies.getSearchNodeBudget;
    this.getEnemies = dependencies.getEnemies;
    this.getDyingRescueOrder = dependencies.getDyingRescueOrder;
    this.isSmallTeam = dependencies.isSmallTeam;
    this.getForceAiRescueHuman = dependencies.getForceAiRescueHuman;
    this.yieldControl = dependencies.yieldControl;
    this.createId = dependencies.createId;
    this.searchRng = dependencies.searchRng;
    this.searchExecutor = dependencies.searchExecutor;
    this.lastSearchRequest = null;
    this.lastSearchResult = null;
    this.lastWorkerOutcome = null;
    this.acceptedPlannedSequence = [];
    this.planSource = "planner";
    this.committedRngRequestIds = new Set();
    this.searchDiagnostics = {
      SEARCH:0,
      RESULT:0,
      CANCEL:0,
      WATCHDOG:0,
      STALE:0,
      WORKER_ERROR:0
    };

    this.knowledge = new Knowledge({
      getState: () => this.getState(),
      random: () => this.searchRng.next()
    });
    this.stateEvaluator = new Evaluator({
      getMaxEnergy: (player) => this.getMaxEnergy(player),
      getTurnEnergyBreakdown: (player) => this.getTurnEnergyBreakdown(player)
    });
    this.resourceSelectionPolicy = new ResourceSelectionPolicy();
    /*
    功能
    为 main-thread 组合根创建共享资源决策语义的独立 Simulator。

    调用方
    ValueSimulationQuery、ResourceValueQuery 与 Planner。

    输入
    当前查询或搜索节点的 SearchState。

    输出
    注入正式资源 Policy/query 的 Simulator。

    读取状态
    当前 AIController 的 resourceSelectionPolicy 与已完成初始化的 resourceValueQuery。

    写入状态
    无。

    调用函数
    Simulator 构造函数。

    边界与不变量
    闭包允许在 ResourceValueQuery 初始化完成前声明，但只在组合完成后调用；不得回读 Game。
    */
    const simulatorFactory = (state) => new Simulator(state, {
      resourceSelectionPolicy: this.resourceSelectionPolicy,
      resourceValueQuery: this.resourceValueQuery ?? null
    });
    this.valueSimulationQuery = new ValueSimulationQuery(
      this.stateEvaluator,
      simulatorFactory
    );
    this.stateValue = new StateValue(this.stateEvaluator, this.valueSimulationQuery);
    this.resourceValueQuery = new ResourceValueQuery({
      stateValue: this.stateValue,
      evaluator: this.stateEvaluator,
      simulatorFactory
    });
    this.valueLedger = new ValueLedger({
      evaluator: this.stateEvaluator,
      stateValue: this.stateValue,
      simulationQuery: this.valueSimulationQuery
    });
    this.frontierValue = new FrontierValue();
    this.searchPrior = new SearchPrior({
      getDifficultyMultiplier: () => this.getDifficultyMultiplier(),
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
    this.transferPolicy = new TransferPolicy();
    this.cardSelectionPolicy = new CardSelectionPolicy({
      random: () => this.searchRng.next(),
      remainingCounts: (actor) => this.knowledge.remainingCounts(actor),
      resourcePolicy: this.resourceSelectionPolicy,
      transferPolicy: this.transferPolicy
    });
    this.actionCandidatePolicy = new ActionCandidatePolicy();
    this.responseDecisionPolicy = new ResponsePolicy({ assessGlobalBenefit });
    this.cardSelector = new CardSelectionBoundary({
      random: () => this.searchRng.next(),
      getState: () => this.getState(),
      getEnemies: (player) => this.getEnemies(player),
      createSearchState: (viewerId, remainingCardCounts) => createInitialSearchState(
        viewerId, this.getState(), remainingCardCounts
      )
    }, this.knowledge, {
      cardSelectionPolicy: this.cardSelectionPolicy,
      resourcePolicy: this.resourceSelectionPolicy,
      resourceValueQuery: this.resourceValueQuery,
      transferPolicy: this.transferPolicy
    });
    this.responsePolicy = new ResponseBoundary({
      getState: () => this.getState(),
      getDyingRescueOrder: (target) => this.getDyingRescueOrder(target),
      isSmallTeam: (player) => this.isSmallTeam(player),
      forceAiRescueHuman: this.getForceAiRescueHuman()
    }, this.evaluator, this.knowledge, {
      responsePolicy: this.responseDecisionPolicy,
      simulationQuery: this.valueSimulationQuery,
      stateValue: this.stateValue
    });

    const cardSelector = this.cardSelector;
    this.actionGenerator = new ActionGenerator({
      getRootContext: () => {
        const state = this.getState();
        return {
          state,
          currentPlayer: state.players[state.currentPlayerIndex] ?? null,
          phase: state.phase
        };
      },
      chooseTransferCombination: (...args) => cardSelector.chooseTransferCombination(...args),
      transferPolicy: this.transferPolicy,
      actionCandidatePolicy: this.actionCandidatePolicy
    });

    const actionGenerator = this.actionGenerator;
    const knowledge = this.knowledge;
    this.searchPolicy = new SearchPolicy({
      random: () => this.searchRng.next(),
      getRandomnessRange: () => this.getRandomnessRange(),
      config: {
        depth: AI_RUNTIME_POLICY.searchDepth,
        beamWidth: AI_RUNTIME_POLICY.beamWidth,
        hiddenSamples: AI_RUNTIME_POLICY.hiddenStateSamples,
        yieldEvery: AI_RUNTIME_POLICY.searchYieldEvery,
        timeBudgetMs: AI_RUNTIME_POLICY.searchTimeBudgetMs,
        nearTieRange: AI_RUNTIME_POLICY.nearTieRange,
        enableRandomness: AI_RUNTIME_POLICY.enableRandomness,
        randomnessRange: AI_RUNTIME_POLICY.randomnessRange,
        difficultyMultiplier: AI_RUNTIME_POLICY.difficultyMultiplier
      }
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
      simulatorFactory,
      searchBudgetFactory: () => new SearchBudget({
        timeBudget: this.getSearchTimeBudget(),
        nodeBudget: this.getSearchNodeBudget()
      }),
      generateFromVisible: (...args) => actionGenerator.generateFromVisible(...args),
      yieldControl: (gameId) => this.yieldControl(gameId)
    });
  }

  /*
  功能
  通过动作生成器返回当前真实局面中经规则校验与 AI 候选策略筛选的根动作。

  调用方
  MatchApplication、selectAction、动作重绑与测试。

  输入
  当前行动 Player。

  输出
  供 Planner 搜索的候选动作数组；它是游戏规则合法动作的策略子集。

  读取状态
  当前 GameState 与 Domain Rules 权威。

  写入状态
  无。

  调用函数
  ActionGenerator.generate。

  边界与不变量
  Domain Rules 定义确定性游戏合法性，ActionCandidatePolicy 只决定 AI 是否考虑候选；门面不得额外筛选或重排，也不得把策略拒绝解释为游戏非法。
  */
  getActionCandidates(player) {
    return this.actionGenerator.generate(player);
  }

  /*
  功能
  从当前真实状态构造搜索快照并请求 Planner 选择动作。

  调用方
  TurnWorkflow.takeAiPlayPhase 与测试。

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
  /*
  功能
  组装不受展示速度影响的 data-only search configuration snapshot。

  调用方
  selectAction。

  输入
  无。

  输出
  冻结 search config 普通对象。

  读取状态
  SearchPolicy 默认、单一 AI_SEARCH_PROFILE 与 main-thread runtime override getters。

  写入状态
  无。

  调用函数
  SearchPolicy.snapshot。

  边界与不变量
  runtime override 只覆盖已有字段；1×/2×/3× 只属于 presentation pacing，不得改变搜索预算。
  */
  buildSearchConfig() {
    const base = this.searchPolicy.snapshot();
    const timeBudget = this.getSearchTimeBudget();
    const nodeBudget = this.getSearchNodeBudget();
    const numericTime = Number(timeBudget);
    const numericNodes = Number(nodeBudget);
    return Object.freeze({
      ...base,
      searchMode:AI_SEARCH_PROFILE.mode,
      softTargetMs:AI_SEARCH_PROFILE.softTargetMs,
      searchDeadlineMs:AI_SEARCH_PROFILE.searchDeadlineMs,
      hardWatchdogMs:AI_SEARCH_PROFILE.hardWatchdogMs,
      timeBudgetMs:timeBudget === null || timeBudget === undefined || !Number.isFinite(numericTime)
        ? AI_SEARCH_PROFILE.searchDeadlineMs
        : Math.max(0, numericTime),
      nodeBudget:nodeBudget === null || nodeBudget === undefined
        || !Number.isFinite(numericNodes) || numericNodes < 1
        ? null
        : Math.max(0, numericNodes),
      randomnessRange:Number.isFinite(Number(this.getRandomnessRange()))
        ? Number(this.getRandomnessRange())
        : base.randomnessRange,
      difficultyMultiplier:Number.isFinite(Number(this.getDifficultyMultiplier()))
        ? Number(this.getDifficultyMultiplier())
        : base.difficultyMultiplier
    });
  }

  /*
  功能
  验证当前 main-thread state 是否仍接受一次 SearchRequest 的结果。

  调用方
  acceptSearchResult。

  输入
  player 与 SearchRequest。

  输出
  { status, reason }；identity/stateVersion/actor/phase 不匹配时拒绝。

  读取状态
  当前 GameState 与 session。

  写入状态
  无。

  调用函数
  isSessionValid。

  边界与不变量
  stateVersion 只保护一次异步 search result；queued planned sequence 走 resolvePlannedAction 的 current-state rebind。
  */
  validateRequestAcceptance(player, request) {
    if (!this.isSessionValid(request.gameId)) {
      return { status:SEARCH_RESULT_STATUS.INVALID_SESSION, reason:"session invalid" };
    }
    const state = this.getState();
    if (state.gameId !== request.gameId) {
      return { status:SEARCH_RESULT_STATUS.INVALID_SESSION, reason:"game identity changed" };
    }
    if (state.stateVersion !== request.stateVersion) {
      return { status:SEARCH_RESULT_STATUS.STALE_VERSION, reason:`stateVersion ${state.stateVersion} != ${request.stateVersion}` };
    }
    const currentPlayer = state.players[state.currentPlayerIndex] ?? null;
    if (!player || !currentPlayer || player.id !== currentPlayer.id || currentPlayer.id !== request.actorId) {
      return { status:SEARCH_RESULT_STATUS.INVALID_ACTOR, reason:"actor changed" };
    }
    if (!player.alive) return { status:SEARCH_RESULT_STATUS.INVALID_ACTOR, reason:"actor dead" };
    if (state.phase !== "play") return { status:SEARCH_RESULT_STATUS.INVALID_PHASE, reason:`phase ${state.phase}` };
    return { status:null, reason:"" };
  }

  /*
  功能
  判断 Planner 返回 action 的 descriptor 是否属于本次 SearchRequest 的 root descriptor set。

  调用方
  acceptSearchResult。

  输入
  descriptor 与 request.rootActionDescriptors。

  输出
  布尔值。

  读取状态
  无。

  写入状态
  无。

  调用函数
  JSON.stringify。

  边界与不变量
  只用稳定普通字段比较；不会把策略收窄后的 root set 当成完整游戏合法集。
  */
  isDescriptorInRootSet(descriptor, rootActionDescriptors) {
    const text = JSON.stringify(descriptor);
    return rootActionDescriptors.some((entry) => JSON.stringify(entry) === text);
  }

  /*
  功能
  接受并验证一次异步 AI search 结果，只返回已 rebind 的当前 Domain-legal action。

  调用方
  selectAction。

  输入
  SearchRequest、Planner raw action、计划序列与 stats。

  输出
  { action, result }；非法结果返回安全 end，绝不返回旧实体动作。

  读取状态
  SearchRequest、当前 GameState、Domain legality 经 getActionCandidates。

  写入状态
  lastSearchResult。

  调用函数
  validateRequestAcceptance、isDescriptorInRootSet、ActionDescriptor.describe、resolvePlannedAction、createSearchResult。

  边界与不变量
  result descriptor 必须先属于 request root set，再在当前 root candidate 集合 rebind；cancelled 只允许返回 end。
  */
  acceptSearchResult({ request, action = null, plannedSequence = [], stats = null }) {
    const player = this.getState().players.find((entry) => entry.id === request.actorId) ?? null;
    const validation = this.validateRequestAcceptance(player, request);
    if (validation.status) {
      if (validation.status === SEARCH_RESULT_STATUS.STALE_VERSION) this.searchDiagnostics.STALE += 1;
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats,
        status:validation.status,
        rejectionReason:validation.reason
      });
      this.lastSearchResult = result;
      return { action:{ type:"end" }, result };
    }
    if (stats?.stopReason === "CANCELLED") {
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats,
        status:SEARCH_RESULT_STATUS.CANCELLED,
        rejectionReason:"cancelled"
      });
      this.lastSearchResult = result;
      return { action:{ type:"end" }, result };
    }
    const descriptor = action ? ActionDescriptor.describe(action) : null;
    if (!descriptor || !this.isDescriptorInRootSet(descriptor, request.rootActionDescriptors)) {
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"descriptor not in request root set"
      });
      this.lastSearchResult = result;
      return { action:{ type:"end" }, result };
    }
    const rebound = this.resolvePlannedAction(player, descriptor);
    if (!rebound) {
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"action cannot rebind to current Domain-legal set"
      });
      this.lastSearchResult = result;
      return { action:{ type:"end" }, result };
    }
    const result = createSearchResult({
      request,
      actionDescriptor:descriptor,
      plannedSequenceDescriptors:plannedSequence,
      stats,
      status:SEARCH_RESULT_STATUS.ACCEPTED
    });
    this.lastSearchResult = result;
    return { action:rebound, result };
  }

  /*
  功能
  从当前权威 state 构造 SearchRequest、执行 Planner，并只返回通过 stale/rebind/Domain-legality 验证的 action。

  调用方
  MatchApplication/TurnWorkflow 与测试。

  输入
  当前行动 Player 与可选上下文。

  输出
  当前可执行的 Planner 动作；非法结果安全返回 end。

  读取状态
  当前 GameState、Knowledge、SearchPolicy 与 Planner。

  写入状态
  lastSearchRequest/lastSearchResult 与 Planner 诊断。

  调用函数
  Knowledge.remainingCounts、createInitialSearchState、getActionCandidates、createSearchRequest、Planner.plan、acceptSearchResult。

  边界与不变量
  stateVersion 只用于本次异步结果 acceptance；queued plan reuse 继续由 resolvePlannedAction current-state rebind。
  */
  /*
  功能
  提交 Worker outcome 返回的 RNG continuation。

  调用方
  acceptWorkerSearchOutcome。

  输入
  request 与 outcome。

  输出
  已提交返回 true；重复提交返回 false。

  读取状态
  committedRngRequestIds 与 session。

  写入状态
  searchRng state/draws 与 committedRngRequestIds。

  调用函数
  isSessionValid、SearchRng.commit。

  边界与不变量
  同一 requestId 只 commit 一次；invalid session 不 commit，新对局不继承旧 session RNG。
  */
  commitWorkerRng(request, outcome) {
    if (!outcome?.rngAfter || this.committedRngRequestIds.has(request.requestId)) return false;
    if (!this.isSessionValid(outcome.gameId)) return false;
    this.searchRng.commit(outcome.rngAfter);
    this.committedRngRequestIds.add(request.requestId);
    return true;
  }

  /*
  功能
  接受 WorkerSearchOutcome 并产生 main-thread authoritative SearchResult。

  调用方
  selectAction 与 worker result tests。

  输入
  request 与 WorkerSearchOutcome。

  输出
  { action, result }；Worker error/cancelled/非法 outcome 只返回安全 end。

  读取状态
  current GameState、session、request、outcome 与 Domain candidate set。

  写入状态
  searchRng continuation、lastWorkerOutcome、lastSearchResult、acceptedPlannedSequence。

  调用函数
  workerOutcomeViolations、commitWorkerRng、validateRequestAcceptance、isDescriptorInRootSet、resolvePlannedAction、createSearchResult。

  边界与不变量
  Worker 不宣布 ACCEPTED；Main Thread 验证全部身份/version/actor/phase/rebind/legality；descriptor 不二次投影。
  */
  acceptWorkerSearchOutcome(request, outcome) {
    this.lastWorkerOutcome = outcome;
    this.planSource = "worker";
    // Main planner 在 Worker 生产路径只作诊断兼容；同步 outcome 数据保持既有测试/诊断读口。
    if (outcome?.stats) this.planner.lastSearchStats = { ...outcome.stats };
    if (Array.isArray(outcome?.plannedSequenceDescriptors)) {
      this.planner.lastPlannedSequence = [...outcome.plannedSequenceDescriptors];
    }
    const malformed = workerOutcomeViolations(outcome, request);
    if (malformed.length || outcome.workerError) {
      this.searchDiagnostics.WORKER_ERROR += 1;
      if (String(outcome.workerError ?? "").includes("watchdog")) this.searchDiagnostics.WATCHDOG += 1;
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats:outcome?.stats ?? null,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:outcome?.workerError ?? malformed.join(", "),
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:{ type:"end" }, result };
    }
    if (outcome.cancelled || outcome.searchStopReason === "CANCELLED") {
      this.searchDiagnostics.CANCEL += 1;
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats:outcome.stats,
        status:SEARCH_RESULT_STATUS.CANCELLED,
        rejectionReason:"cancelled",
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:{ type:"end" }, result };
    }

    const player = this.getState().players.find((entry) => entry.id === request.actorId) ?? null;
    const validation = this.validateRequestAcceptance(player, request);
    if (validation.status) {
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats:outcome.stats,
        status:validation.status,
        rejectionReason:validation.reason,
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:{ type:"end" }, result };
    }

    const descriptor = outcome.actionDescriptor;
    if (!descriptor || !this.isDescriptorInRootSet(descriptor, request.rootActionDescriptors)) {
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats:outcome.stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"descriptor not in request root set",
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:{ type:"end" }, result };
    }

    const rebound = this.resolvePlannedAction(player, descriptor);
    if (!rebound) {
      const result = createSearchResult({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats:outcome.stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"action cannot rebind to current Domain-legal set",
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:{ type:"end" }, result };
    }

    const rngCommitted = this.commitWorkerRng(request, outcome);
    const result = createSearchResult({
      request,
      actionDescriptor:descriptor,
      plannedSequenceDescriptors:outcome.plannedSequenceDescriptors,
      stats:outcome.stats,
      status:SEARCH_RESULT_STATUS.ACCEPTED,
      rngAfter:rngCommitted ? outcome.rngAfter : null
    });
    this.lastSearchResult = result;
    this.acceptedPlannedSequence = [...(outcome.plannedSequenceDescriptors ?? [])];
    this.searchDiagnostics.RESULT += 1;
    return { action:rebound, result };
  }

  /*
  功能
  构造 SearchRequest、通过 injected search executor 执行 Worker-safe search，并把 outcome 交给 main-thread acceptance。

  调用方
  TurnWorkflow 与测试。

  输入
  player 与可选 options/signal。

  输出
  当前可执行 action；executor error/stale/cancel 安全返回 end。

  读取状态
  current GameState、Knowledge、SearchPolicy、searchRng。

  写入状态
  lastSearchRequest、worker/acceptance diagnostics、RNG continuation 与 accepted plan。

  调用函数
  createInitialSearchState、getActionCandidates、createSearchRequest、searchExecutor.search、acceptWorkerSearchOutcome。

  边界与不变量
  生产 Planner execution 由 executor 负责；Main Thread 只 rebind 与 Domain-legal validation。
  */
  async selectAction(player, options = {}) {
    const state = this.getState();
    if (!this.isSessionValid(options.gameId ?? state.gameId)) return { type:"end" };
    const remainingCardCounts = this.knowledge.remainingCounts(player);
    const visible = createInitialSearchState(player.id, state, remainingCardCounts);
    const rootActions = this.getActionCandidates(player);
    const request = createSearchRequest({
      requestId:this.createId("search-request"),
      gameId:state.gameId,
      stateVersion:state.stateVersion,
      actorId:player.id,
      phase:state.phase,
      currentRound:state.currentRound,
      searchState:visible,
      searchConfig:this.buildSearchConfig(),
      rng:this.searchRng.snapshot(),
      rootActionDescriptors:rootActions.map(ActionDescriptor.describe),
      rootSearchActions:rootActions.map(describeRootSearchAction)
    });
    this.lastSearchRequest = request;
    this.searchDiagnostics.SEARCH += 1;
    let outcome;
    try {
      outcome = await this.searchExecutor.search(request, options);
    } catch (error) {
      this.searchDiagnostics.WORKER_ERROR += 1;
      if (String(error?.message ?? error).includes("watchdog")) this.searchDiagnostics.WATCHDOG += 1;
      outcome = createWorkerSearchOutcome({
        request,
        actionDescriptor:null,
        plannedSequenceDescriptors:[],
        stats:null,
        searchStopReason:null,
        rngAfter:this.searchRng.snapshot(),
        cancelled:false,
        workerError:error instanceof Error ? error.message : String(error)
      });
    }
    return this.acceptWorkerSearchOutcome(request, outcome).action;
  }
  /*
  功能
  返回搜索运行时诊断计数器的隔离副本。

  调用方
  runtime diagnostics、测试与 browser console audit。

  输入
  无。

  输出
  SEARCH/RESULT/CANCEL/WATCHDOG/STALE/WORKER_ERROR 计数副本。

  读取状态
  searchDiagnostics。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  仅 diagnostics；不得被任何策略、候选排序或 RNG commit 读取。
  */
  getSearchDiagnostics() {
    return { ...this.searchDiagnostics };
  }

  /*
  功能
  将搜索计划中的动作描述重新绑定到当前真实局面的 AI 候选动作。

  调用方
  TurnWorkflow 复用计划序列时。

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
    const state = this.getState();
    if (!this.isSessionValid(state.gameId)) return null;
    const currentPlayer = state.players[state.currentPlayerIndex] ?? null;
    if (!player?.alive || currentPlayer?.id !== player.id || state.phase !== "play") return null;
    if (descriptor.type === "end") return { type:"end" };
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
  TurnWorkflow 可选连续计划执行路径。

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
    if (this.planSource === "worker") return [...this.acceptedPlannedSequence];
    return [...this.planner.lastPlannedSequence];
  }

  /*
  功能
  选择需要弃置的实体牌。

  调用方
  AiChoiceAdapter 与角色被动规则。

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
  CardIntentRuntime 转移准备与 ActionGenerator 注入能力。

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
  AiChoiceAdapter hiddenCard 请求。

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
  AiChoiceAdapter hiddenCard zone 请求。

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
  PublicCardPoolWorkflow。

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
  ResponseWorkflow 与直接测试。

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
