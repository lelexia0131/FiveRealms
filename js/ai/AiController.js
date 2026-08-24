/*
模块职责
作为 AI 组合根一次性构造组件、注入窄能力，并向真实执行边界提供稳定门面。

上游
MatchApplication、ResponseWorkflow、PublicCardPoolWorkflow、角色技能与测试。

下游
状态组合、Fact、选择、响应、动作生成、评估与 Planner。

状态边界
只在门面入口读取当前 GameState；价值与搜索组件仅接收 World 与显式能力。

信息边界
确定信息只能经 Fact 进入边界；未知信息只能经 Probability 局部查询进入决策。

架构约束
子组件不得回指 AIController；公开 owner 字段只供显式诊断与专项测试，生产上游使用控制器边界。
*/
import { createInitialWorld } from "./state/StateContracts.js";
import { deriveCurrentCardCounts } from "./state/Fact.js";
import { sampleProbabilityWorlds } from "./state/Probability.js";
import { CardSelectionBoundary } from "./policy/CardSelectionBoundary.js";
import { ResponseBoundary } from "./policy/ResponseBoundary.js";
import {
  ActionGenerator,
  deduplicateSearchEquivalentActions
} from "./search/ActionGenerator.js";
import { StateValue } from "./value/StateValue.js";
import { ValueSimulationQuery } from "./simulation/ValueSimulationQuery.js";
import { ResourceValueQuery } from "./simulation/ResourceValueQuery.js";
import { Simulator } from "./simulation/Simulator.js";
import { AI_RUNTIME_POLICY, AI_SEARCH_PROFILE } from "./policy/AiRuntimePolicy.js";
import { actionIntentKey, sameAction } from "./search/Action.js";
import { createSearchRequest } from "./search/SearchRequest.js";
import { createSearchResult, SEARCH_RESULT_STATUS } from "./search/SearchResult.js";
import { createWorkerSearchOutcome, workerOutcomeViolations } from "./search/WorkerSearchOutcome.js";
import { CandidateMaterializer } from "./search/CandidateMaterializer.js";
import { CounterfactualTerms } from "./search/CounterfactualTerms.js";
import { PatternMatcher } from "./search/pattern/PatternMatcher.js";
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
import { CardSelectionPolicy } from "./policy/CardSelectionPolicy.js";
import { ResponsePolicy } from "./policy/ResponsePolicy.js";
import { assessGlobalBenefit } from "./value/GlobalBenefitValue.js";

/*
功能
读取 main-thread decision diagnostics 使用的单调墙钟。

调用方
AIController.selectAction。

输入
无。

输出
当前高精度毫秒时间；运行时不支持 performance 时回退 Date.now。

读取状态
globalThis.performance。

写入状态
无。

调用函数
performance.now、Date.now。

边界与不变量
只用于诊断，不参与 SearchBudget、watchdog、排序或策略。
*/
function decisionNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

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
  Value owners、Fact、正式 Policy、执行边界、ActionGenerator 与 Planner 构造函数。

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
    this.lastSearchFallback = null;
    this.lastDecisionDiagnostics = null;
    this.lastMainThreadOperationDiagnostics = null;
    this.acceptedPlannedSequence = [];
    this.planSource = "planner";
    this.committedRngRequestIds = new Set();
    this.searchDiagnostics = {
      SEARCH:0,
      RESULT:0,
      CANCEL:0,
      WATCHDOG:0,
      STALE:0,
      WORKER_ERROR:0,
      FALLBACK:0
    };
    this.actionGenerator = new ActionGenerator();

    this.stateEvaluator = new Evaluator({
      getMaxEnergy: (player) => this.getMaxEnergy(player),
      getTurnEnergyBreakdown: (player) => this.getTurnEnergyBreakdown(player)
    });
    /*
    功能
    为 main-thread 组合根创建共享资源决策语义的独立 Simulator。

    调用方
    ValueSimulationQuery、ResourceValueQuery 与 Planner。

    输入
    当前查询或搜索节点的 World，以及可选搜索工作诊断上下文。

    输出
    注入正式资源 Policy/query 的 Simulator。

    读取状态
    当前 AIController 的搜索预算上下文。

    写入状态
    无。

    调用函数
    Simulator 构造函数。

    边界与不变量
    不得回读 Game；资源价值查询只服务真实选择边界，不注入物理 Simulator。
    */
    const simulatorFactory = (state, runtime = {}) => new Simulator(state, {
      searchBudget:runtime.searchBudget ?? null
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
    this.cardSelectionPolicy = new CardSelectionPolicy({
      random: () => this.searchRng.next(),
      remainingCounts: (actor) => deriveCurrentCardCounts(actor, this.getState())
    });
    this.responseDecisionPolicy = new ResponsePolicy({ assessGlobalBenefit });
    this.cardSelector = new CardSelectionBoundary({
      random: () => this.searchRng.next(),
      getState: () => this.getState(),
      getEnemies: (player) => this.getEnemies(player),
      remainingCounts: (actor) => deriveCurrentCardCounts(actor, this.getState()),
      createWorld: (viewerId, remainingCardCounts) => createInitialWorld(
        viewerId, this.getState(), remainingCardCounts
      )
    }, {
      cardSelectionPolicy: this.cardSelectionPolicy,
      resourceValueQuery: this.resourceValueQuery,
    });
    this.responsePolicy = new ResponseBoundary({
      getState: () => this.getState(),
      getDyingRescueOrder: (target) => this.getDyingRescueOrder(target),
      isSmallTeam: (player) => this.isSmallTeam(player),
      forceAiRescueHuman: this.getForceAiRescueHuman(),
      remainingCounts: (actor) => deriveCurrentCardCounts(actor, this.getState())
    }, {
      responsePolicy: this.responseDecisionPolicy,
      simulationQuery: this.valueSimulationQuery,
      stateValue: this.stateValue,
      searchPrior:this.searchPrior,
      actionGenerator:this.actionGenerator
    });

    const actionGenerator = this.actionGenerator;
    this.searchPolicy = new SearchPolicy({
      random: () => this.searchRng.next(),
      getRandomnessRange: () => this.getRandomnessRange(),
      compareCandidates:(left, right) => this.transitionValue.compareCandidates(left, right),
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
      evaluator: this.stateValue,
      generateActions: (...args) => actionGenerator.generate(...args),
      sampleUnknownHands: (query) => sampleProbabilityWorlds({
        ...query,
        random:() => this.searchRng.next()
      }),
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
      getResolutionScale: tacticResolutionScale
    });
    this.patternMatcher = new PatternMatcher();
    this.planner = new Planner({
      candidateMaterializer: this.candidateMaterializer,
      patternMatcher:this.patternMatcher,
      searchPolicy: this.searchPolicy,
      simulatorFactory,
      searchBudgetFactory: () => new SearchBudget({
        timeBudget: this.getSearchTimeBudget(),
        nodeBudget: this.getSearchNodeBudget()
      }),
      deduplicateActions:deduplicateSearchEquivalentActions,
      generateActions: (...args) => actionGenerator.generate(...args),
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
  getActionCandidates(player, world = null) {
    const currentState = this.getState();
    const currentWorld = world ?? createInitialWorld(
      player.id,
      currentState,
      deriveCurrentCardCounts(player, currentState)
    );
    return this.actionGenerator.generate(currentWorld, player.id);
  }

  /*
  功能
  记录一次浏览器主线程同步 AI 操作的起止时间与已有规模计数。

  调用方
  selectAction 的 pre-worker 阶段与 AIController 的 Response/CardSelection 门面。

  输入
  operation 名称、startMs，以及可选 candidate/world count。

  输出
  只含 operation/timing/count 的冻结诊断记录。

  读取状态
  performance.now 或 Date.now。

  写入状态
  lastMainThreadOperationDiagnostics。

  调用函数
  decisionNow。

  边界与不变量
  只记录数字规模，不记录 GameState、World、Card、Player 或 probability world 内容；不参与决策。
  */
  recordMainThreadOperation(
    operation,
    startMs,
    { candidateCount = "unavailable", worldCount = "unavailable" } = {}
  ) {
    const endMs = decisionNow();
    const record = Object.freeze({
      operation:String(operation),
      startMs,
      endMs,
      durationMs:Math.max(0, endMs - startMs),
      candidateCount:Number.isFinite(Number(candidateCount))
        ? Math.max(0, Number(candidateCount))
        : "unavailable",
      worldCount:Number.isFinite(Number(worldCount))
        ? Math.max(0, Number(worldCount))
        : "unavailable"
    });
    this.lastMainThreadOperationDiagnostics = record;
    return record;
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
  当前 GameState、合法 Fact 与搜索配置。

  写入状态
  Planner 最近搜索诊断与计划序列。

  调用函数
  deriveCurrentCardCounts、createInitialWorld、getActionCandidates、Planner.plan。

  边界与不变量
  剩余牌计数每次真实决策只计算一次，Planner 不获得 Game 或 Controller。
  */
  /*
  功能
  组装只理解显式毫秒预算的 data-only search configuration snapshot。

  调用方
  selectAction。

  输入
  可选 { timeBudgetMs }；调用方传入本次 decision 已采样的 wall-clock 上限。

  输出
  冻结 search config 普通对象。

  读取状态
  SearchPolicy 默认、AI_SEARCH_PROFILE hard watchdog 与 main-thread runtime override getters。

  写入状态
  无。

  调用函数
  SearchPolicy.snapshot。

  边界与不变量
  runtime override 只服务显式测试/诊断覆盖；Controller 不理解速度档位或 timing RNG；正常 wall-clock 截止只由 Worker 内 SearchBudget.TIME 收束。
  */
  buildSearchConfig(options = {}) {
    const base = this.searchPolicy.snapshot();
    const timeBudgetOverride = this.getSearchTimeBudget();
    const nodeBudget = this.getSearchNodeBudget();
    const numericOverride = Number(timeBudgetOverride);
    const numericRequested = Number(options.timeBudgetMs);
    const numericNodes = Number(nodeBudget);
    const hasOverride = timeBudgetOverride !== null && timeBudgetOverride !== undefined
      && Number.isFinite(numericOverride);
    const hasRequested = options.timeBudgetMs !== null && options.timeBudgetMs !== undefined
      && Number.isFinite(numericRequested);
    const timeBudgetMs = Math.max(0, hasOverride
      ? numericOverride
      : hasRequested ? numericRequested : AI_RUNTIME_POLICY.searchTimeBudgetMs);
    return Object.freeze({
      ...base,
      searchMode:AI_SEARCH_PROFILE.mode,
      softTargetMs:AI_SEARCH_PROFILE.softTargetMs,
      hardWatchdogMs:AI_SEARCH_PROFILE.hardWatchdogMs,
      timeBudgetMs,
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
  descriptor 与 request.rootActions。

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
  isActionInRootSet(action, rootActions) {
    return rootActions.some((entry) => sameAction(entry, action));
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
  validateRequestAcceptance、isDescriptorInRootSet、Action.describe、resolvePlannedAction、createSearchResult。

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
        action:null,
        plannedActions:[],
        stats,
        status:validation.status,
        rejectionReason:validation.reason
      });
      this.lastSearchResult = result;
      return { action:this.actionGenerator.createEndAction(request.actorId), result };
    }
    if (stats?.stopReason === "CANCELLED") {
      const result = createSearchResult({
        request,
        action:null,
        plannedActions:[],
        stats,
        status:SEARCH_RESULT_STATUS.CANCELLED,
        rejectionReason:"cancelled"
      });
      this.lastSearchResult = result;
      return { action:this.actionGenerator.createEndAction(request.actorId), result };
    }
    if (!action || !this.isActionInRootSet(action, request.rootActions)) {
      const result = createSearchResult({
        request,
        action:null,
        plannedActions:[],
        stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"action not in request root set"
      });
      this.lastSearchResult = result;
      return { action:this.actionGenerator.createEndAction(request.actorId), result };
    }
    const result = createSearchResult({
      request,
      action,
      plannedActions:plannedSequence,
      stats,
      status:SEARCH_RESULT_STATUS.ACCEPTED
    });
    this.lastSearchResult = result;
    return { action, result };
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
  当前 GameState、Fact、SearchPolicy 与 Planner。

  写入状态
  lastSearchRequest/lastSearchResult 与 Planner 诊断。

  调用函数
  deriveCurrentCardCounts、createInitialWorld、getActionCandidates、createSearchRequest、Planner.plan、acceptSearchResult。

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
  在 Worker 基础设施失败时，用现有 Search Prior 对当前合法根候选做确定性降级选择。

  调用方
  acceptWorkerSearchOutcome 的 malformed/workerError 分支。

  输入
  当前真实 Player、已通过 session/version/actor/phase 验证的 SearchRequest 与可选 decision-local 合法根集合。

  输出
  { action, actionDescriptor, score }；候选按 prior 总分稳定择优。

  读取状态
  当前 Domain/Policy 合法根候选、request.searchState 与 SearchPrior。

  写入状态
  无。

  调用函数
  getActionCandidates、SearchPrior.actionUtility/actionSearchPrior、Action.describe。

  边界与不变量
  该路径不执行 Planner、Simulator、随机数或 Final Utility；通过 stateVersion 验证的 decision-local 根集合
  与当前权威状态严格对应，可直接复用而不建立跨决策缓存；同分保持 ActionGenerator 稳定顺序。
  */
  selectWorkerFailureFallback(player, request, decisionRootActions = null) {
    const candidates = Array.isArray(decisionRootActions)
      ? decisionRootActions
      : this.getActionCandidates(player);
    const ranked = candidates.map((action) => {
      const score = this.searchPrior.actionUtility(
        action, player, request.world
      ) + this.searchPrior.actionSearchPrior(action, player, request.world);
      return {
        action,
        score:Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY
      };
    });
    const best = ranked.reduce((current, candidate) => (
      !current || candidate.score > current.score ? candidate : current
    ), null);
    if (!best) return null;
    return {
      action:best.action,
      score:best.score
    };
  }

  /*
  功能
  接受 WorkerSearchOutcome，并在基础设施故障时通过确定性根候选 Policy 产生安全 fallback。

  调用方
  selectAction 与 worker result tests。

  输入
  request、WorkerSearchOutcome 与可选 decision-local 合法根集合。

  输出
  { action, result }；正常结果执行权威重绑，Worker fault 返回已重新比较的合法 fallback。

  读取状态
  current GameState、session、request、outcome、Domain candidate set 与 Search Prior。

  写入状态
  searchRng continuation、lastWorkerOutcome、lastSearchResult、lastSearchFallback、acceptedPlannedSequence。

  调用函数
  workerOutcomeViolations、selectWorkerFailureFallback、commitWorkerRng、validateRequestAcceptance、
  isDescriptorInRootSet、resolvePlannedAction、createSearchResult。

  边界与不变量
  Worker 不宣布 ACCEPTED；Main Thread 验证全部身份/version/actor/phase/rebind/legality；
  CANCELLED 与 stale 状态仍安全结束；validation 通过时允许复用同一 decision 已生成的合法实体根，
  但不得跨 stateVersion 或跨 decision 缓存。
  */
  acceptWorkerSearchOutcome(request, outcome, decisionRootActions = null) {
    this.lastWorkerOutcome = outcome;
    this.planSource = "worker";
    this.lastSearchFallback = null;
    if (outcome?.stats) this.planner.lastSearchStats = { ...outcome.stats };
    if (Array.isArray(outcome?.plannedActions)) {
      this.planner.lastPlannedSequence = [...outcome.plannedActions];
    }
    const malformed = workerOutcomeViolations(outcome, request);
    if (malformed.length || outcome?.workerError) {
      this.searchDiagnostics.WORKER_ERROR += 1;
      const fallbackReason = outcome?.workerError ?? malformed.join(", ");
      if (String(fallbackReason).includes("watchdog")) this.searchDiagnostics.WATCHDOG += 1;
      const player = this.getState().players.find((entry) => entry.id === request.actorId) ?? null;
      const validation = this.validateRequestAcceptance(player, request);
      if (validation.status) {
        const result = createSearchResult({
          request,
          action:null,
          plannedActions:[],
          stats:outcome?.stats ?? null,
          status:validation.status,
          rejectionReason:validation.reason,
          rngAfter:null
        });
        this.lastSearchResult = result;
        this.acceptedPlannedSequence = [];
        return { action:this.actionGenerator.createEndAction(request.actorId), result };
      }
      const fallback = this.selectWorkerFailureFallback(player, request, decisionRootActions);
      if (!fallback) {
        const result = createSearchResult({
          request,
          action:null,
          plannedActions:[],
          stats:outcome?.stats ?? null,
          status:SEARCH_RESULT_STATUS.INVALID_ACTION,
          rejectionReason:fallbackReason,
          rngAfter:null
        });
        this.lastSearchResult = result;
        this.acceptedPlannedSequence = [];
        return { action:this.actionGenerator.createEndAction(request.actorId), result };
      }
      const result = createSearchResult({
        request,
        action:fallback.action,
        plannedActions:[],
        stats:outcome?.stats ?? null,
        status:SEARCH_RESULT_STATUS.FALLBACK,
        rejectionReason:fallbackReason,
        rngAfter:null
      });
      this.planSource = "worker-fallback";
      this.lastSearchFallback = Object.freeze({
        source:"root-search-prior",
        reason:fallbackReason,
        score:fallback.score,
        action:fallback.action
      });
      this.searchDiagnostics.FALLBACK += 1;
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      this.planner.lastPlannedSequence = [];
      return { action:fallback.action, result };
    }
    if (outcome.cancelled || outcome.searchStopReason === "CANCELLED") {
      this.searchDiagnostics.CANCEL += 1;
      const result = createSearchResult({
        request,
        action:null,
        plannedActions:[],
        stats:outcome.stats,
        status:SEARCH_RESULT_STATUS.CANCELLED,
        rejectionReason:"cancelled",
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:this.actionGenerator.createEndAction(request.actorId), result };
    }

    const player = this.getState().players.find((entry) => entry.id === request.actorId) ?? null;
    const validation = this.validateRequestAcceptance(player, request);
    if (validation.status) {
      const result = createSearchResult({
        request,
        action:null,
        plannedActions:[],
        stats:outcome.stats,
        status:validation.status,
        rejectionReason:validation.reason,
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:this.actionGenerator.createEndAction(request.actorId), result };
    }

    const action = outcome.action;
    if (!action || !this.isActionInRootSet(action, request.rootActions)) {
      const result = createSearchResult({
        request,
        action:null,
        plannedActions:[],
        stats:outcome.stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"action not in request root set",
        rngAfter:null
      });
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
      return { action:this.actionGenerator.createEndAction(request.actorId), result };
    }

    const rngCommitted = this.commitWorkerRng(request, outcome);
    const result = createSearchResult({
      request,
      action,
      plannedActions:outcome.plannedActions,
      stats:outcome.stats,
      status:SEARCH_RESULT_STATUS.ACCEPTED,
      rngAfter:rngCommitted ? outcome.rngAfter : null
    });
    this.lastSearchResult = result;
    this.acceptedPlannedSequence = [...(outcome.plannedActions ?? [])];
    this.searchDiagnostics.RESULT += 1;
    return { action, result };
  }

  /*
  功能
  构造 SearchRequest、通过 injected search executor 执行 Worker-safe search，并把 outcome 交给 main-thread acceptance。

  调用方
  TurnWorkflow 与测试。

  输入
  player 与可选 options/signal/searchTimeBudgetMs。

  输出
  当前可执行 action；executor fault 进入确定性 root fallback，stale/cancel 安全返回 end。

  读取状态
  current GameState、Fact、SearchPolicy、searchRng。

  写入状态
  lastSearchRequest、lastDecisionDiagnostics、worker/fallback diagnostics、RNG continuation 与 accepted plan。

  调用函数
  createInitialWorld、getActionCandidates、createSearchRequest、searchExecutor.search、acceptWorkerSearchOutcome、decisionNow。

  边界与不变量
  生产 Planner execution 由 executor 负责；正常 TIME 仍由 Worker 返回 incumbent；Main Thread 只在
  infrastructure fault 时使用既有合法根候选与 Search Prior，且不执行 Planner/Simulator。
  */
  async selectAction(player, options = {}) {
    const state = this.getState();
    if (!this.isSessionValid(options.gameId ?? state.gameId)) {
      return this.actionGenerator.createEndAction(player.id);
    }
    const preWorkerStartedAt = decisionNow();
    const mainThreadOperations = [];
    let operationStartedAt = decisionNow();
    const remainingCardCounts = deriveCurrentCardCounts(player, state);
    mainThreadOperations.push(this.recordMainThreadOperation(
      "AiController.selectAction:remaining-counts",
      operationStartedAt
    ));
    operationStartedAt = decisionNow();
    const world = createInitialWorld(player.id, state, remainingCardCounts);
    mainThreadOperations.push(this.recordMainThreadOperation(
      "AiController.selectAction:create-world",
      operationStartedAt
    ));
    operationStartedAt = decisionNow();
    const rootActions = this.getActionCandidates(player, world);
    mainThreadOperations.push(this.recordMainThreadOperation(
      "AiController.selectAction:root-candidates",
      operationStartedAt,
      { candidateCount:rootActions.length }
    ));
    const uniqueRootCount = deduplicateSearchEquivalentActions(rootActions).length;
    const request = createSearchRequest({
      requestId:this.createId("search-request"),
      gameId:state.gameId,
      stateVersion:state.stateVersion,
      actorId:player.id,
      phase:state.phase,
      currentRound:state.currentRound,
      world,
      searchConfig:this.buildSearchConfig({ timeBudgetMs:options.searchTimeBudgetMs }),
      rng:this.searchRng.snapshot(),
      rootActions
    });
    this.lastSearchRequest = request;
    this.searchDiagnostics.SEARCH += 1;
    const preWorkerFinishedAt = decisionNow();
    const workerRoundTripStartedAt = preWorkerFinishedAt;
    let outcome;
    try {
      outcome = await this.searchExecutor.search(request, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const cancelled = /\bcancell?ed\b/iu.test(errorMessage);
      outcome = createWorkerSearchOutcome({
        request,
        action:null,
        plannedActions:[],
        stats:null,
        searchStopReason:cancelled ? "CANCELLED" : null,
        rngAfter:this.searchRng.snapshot(),
        cancelled,
        workerError:cancelled ? null : errorMessage
      });
    }
    const workerRoundTripFinishedAt = decisionNow();
    const accepted = this.acceptWorkerSearchOutcome(request, outcome, rootActions);
    const postWorkerFinishedAt = decisionNow();
    const workerSearchMs = Number(outcome?.stats?.workerSearchMs);
    const transportDiagnostics = this.searchExecutor.getLastTransportDiagnostics?.() ?? null;
    this.lastDecisionDiagnostics = Object.freeze({
      requestId:request.requestId,
      preWorkerMs:Math.max(0, preWorkerFinishedAt - preWorkerStartedAt),
      workerSearchMs:Number.isFinite(workerSearchMs) ? Math.max(0, workerSearchMs) : null,
      workerRoundTripMs:Math.max(0, workerRoundTripFinishedAt - workerRoundTripStartedAt),
      workerTransportMs:Number.isFinite(workerSearchMs)
        ? Math.max(0, workerRoundTripFinishedAt - workerRoundTripStartedAt - workerSearchMs)
        : null,
      postMessageMs:transportDiagnostics?.requestId === request.requestId
        && Number.isFinite(Number(transportDiagnostics.postMessageMs))
        ? Math.max(0, Number(transportDiagnostics.postMessageMs))
        : null,
      postWorkerMs:Math.max(0, postWorkerFinishedAt - workerRoundTripFinishedAt),
      physicalRootCount:rootActions.length,
      uniqueRootCount,
      preWorkerProbabilityPreparations:"unavailable",
      preWorkerConditionBranches:"unavailable",
      mainThreadOperations,
      searchStopReason:outcome?.searchStopReason ?? null,
      resultStatus:accepted.result?.status ?? null
    });
    return accepted.action;
  }
  /*
  功能
  返回搜索运行时诊断计数器的隔离副本。

  调用方
  runtime diagnostics、测试与 browser console audit。

  输入
  无。

  输出
  SEARCH/RESULT/CANCEL/WATCHDOG/STALE/WORKER_ERROR/FALLBACK 计数副本。

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
  返回最近一次真实 selectAction 的阶段耗时与 pre-worker 工作摘要。

  调用方
  runtime diagnostics、真实入口回归与 browser console audit。

  输入
  无。

  输出
  最近 decision diagnostics 的隔离副本；尚未决策时返回 null。

  读取状态
  lastDecisionDiagnostics。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  仅诊断；不得被搜索预算、合法性、评分、fallback 或 RNG 读取。
  */
  getLastDecisionDiagnostics() {
    return this.lastDecisionDiagnostics
      ? {
          ...this.lastDecisionDiagnostics,
          mainThreadOperations:[...(this.lastDecisionDiagnostics.mainThreadOperations ?? [])]
        }
      : null;
  }

  /*
  功能
  返回最近一次同步 main-thread AI 边界操作的数字诊断。

  调用方
  runtime diagnostics、focused regression 与 browser console audit。

  输入
  无。

  输出
  最近 operation/timing/count 的隔离副本；尚未执行时返回 null。

  读取状态
  lastMainThreadOperationDiagnostics。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只读诊断，不得被 ResponsePolicy、CardSelectionPolicy、搜索或 RNG 使用。
  */
  getLastMainThreadOperationDiagnostics() {
    return this.lastMainThreadOperationDiagnostics
      ? { ...this.lastMainThreadOperationDiagnostics }
      : null;
  }

  /*
  功能
  将搜索计划中的动作描述重新绑定到当前真实局面的 AI 候选动作。

  调用方
  TurnWorkflow 复用计划序列时。

  输入
  当前行动 Player、稳定动作描述与可选 decision-local 合法根集合。

  输出
  匹配的当前动作；状态变化导致不匹配时返回 null。

  读取状态
  当前通过规则校验并经 AI 候选策略过滤的动作集合。

  写入状态
  无。

  调用函数
  getActionCandidates。

  边界与不变量
  实体牌优先按实例 ID 重绑，目标顺序和选择字段必须完全一致；外部计划复用仍重新生成当前合法集合，
  只有同一 request 且 stateVersion 已验证的 selectAction acceptance 可提供 decision-local 集合。
  */
  resolvePlannedAction(player, plannedAction, decisionRootActions = null) {
    if (!plannedAction) return null;
    const state = this.getState();
    if (!this.isSessionValid(state.gameId)) return null;
    const currentPlayer = state.players[state.currentPlayerIndex] ?? null;
    if (!player?.alive || currentPlayer?.id !== player.id || state.phase !== "play") return null;
    const candidates = Array.isArray(decisionRootActions)
      ? decisionRootActions
      : this.getActionCandidates(player);
    const intentKey = actionIntentKey(plannedAction);
    return candidates.find((action) => actionIntentKey(action) === intentKey) ?? null;
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
    if (this.planSource !== "planner") return [...this.acceptedPlannedSequence];
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
  当前 GameState、Fact 与选择策略。

  写入状态
  无。

  调用函数
  CardSelectionBoundary.chooseDiscards。

  边界与不变量
  门面不改动选择结果或牌序。
  */
  chooseDiscards(player, count) {
    const startedAt = decisionNow();
    const cards = this.cardSelector.chooseDiscards(player, count);
    this.recordMainThreadOperation(
      "CardSelectionBoundary.chooseDiscards",
      startedAt,
      { candidateCount:player?.hand?.length }
    );
    return cards;
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
  当前 GameState、Fact 与转移评分。

  写入状态
  无。

  调用函数
  CardSelectionBoundary.chooseTransferCombination。

  边界与不变量
  不解析或移动实体牌，真实执行仍必须重新验证。
  */
  chooseTransferCombination(...args) {
    const startedAt = decisionNow();
    const selection = this.cardSelector.chooseTransferCombination(...args);
    this.recordMainThreadOperation(
      "CardSelectionBoundary.chooseTransferCombination",
      startedAt,
      { candidateCount:Array.isArray(args[2]) ? args[2].length : "unavailable" }
    );
    return selection;
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
    const startedAt = decisionNow();
    const cards = this.cardSelector.chooseHiddenCards(...args);
    this.recordMainThreadOperation(
      "CardSelectionBoundary.chooseHiddenCards",
      startedAt,
      { candidateCount:Array.isArray(args[1]?.hand) ? args[1].hand.length : "unavailable" }
    );
    return cards;
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
    const startedAt = decisionNow();
    const selection = this.cardSelector.chooseZoneCard(...args);
    const owner = args[1];
    const handCount = Array.isArray(owner?.hand) ? owner.hand.length : Number.NaN;
    this.recordMainThreadOperation(
      "CardSelectionBoundary.chooseZoneCard",
      startedAt,
      { candidateCount:Number.isFinite(handCount) ? handCount + (owner?.equipment ? 1 : 0) : "unavailable" }
    );
    return selection;
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
    const startedAt = decisionNow();
    const card = this.cardSelector.choosePublicCard(...args);
    this.recordMainThreadOperation(
      "CardSelectionBoundary.choosePublicCard",
      startedAt,
      { candidateCount:Array.isArray(args[1]) ? args[1].length : "unavailable" }
    );
    return card;
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
  当前 GameState、Fact、评估与响应策略。

  写入状态
  无。

  调用函数
  ResponseBoundary.shouldRespond。

  边界与不变量
  候选牌默认空数组；门面不得构造或泄露额外隐藏信息。
  */
  shouldRespond(player, type, context, cards = []) {
    const startedAt = decisionNow();
    const decision = this.responsePolicy.shouldRespond(player, type, context, cards);
    this.recordMainThreadOperation(
      "ResponseBoundary.shouldRespond",
      startedAt,
      { candidateCount:Array.isArray(cards) ? cards.length : "unavailable" }
    );
    return decision;
  }

  /*
  功能
  基于当前合法信息评估一名 AI 对濒死目标的救援容量。

  调用方
  ResponseWorkflow 注入的必败救援查询与直接策略测试。

  输入
  响应者与濒死目标真实实体。

  输出
  ResponseBoundary 生成的救援 assessment object。

  读取状态
  ResponseBoundary 读取的当前公开状态、合法记忆与 Probability。

  写入状态
  无。

  调用函数
  ResponseBoundary.assessDyingRescue。

  边界与不变量
  Controller 只暴露窄查询；不得让 Application 直接访问 Policy 内部 owner。
  */
  assessDyingRescue(responder, target) {
    const startedAt = decisionNow();
    const assessment = this.responsePolicy.assessDyingRescue(responder, target);
    this.recordMainThreadOperation(
      "ResponseBoundary.assessDyingRescue",
      startedAt,
      { candidateCount:this.getState()?.players?.length }
    );
    return assessment;
  }

}
