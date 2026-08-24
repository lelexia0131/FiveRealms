/*
模块职责
作为 AI 组合根一次性构造组件、注入窄能力，并向真实执行边界提供稳定门面。

上游
MatchApplication、ResponseWorkflow、PublicCardPoolWorkflow、角色技能与测试。

下游
状态组合、Fact、选择、响应、动作生成、评估与 Worker 搜索边界。

状态边界
只在门面入口读取当前 GameState；价值与搜索组件仅接收 World 与显式能力。

信息边界
确定信息只能经 Fact 进入边界；未知信息只能经 Probability 局部查询进入决策。

架构约束
子组件不得回指 AIController；公开 owner 字段只供显式诊断与专项测试，生产上游使用控制器边界。
*/
import { createInitialWorld } from "./state/StateContracts.js";
import { deriveCurrentCardCounts, hasFactStatus } from "./state/Fact.js";
import { CardSelectionBoundary } from "./policy/CardSelectionBoundary.js";
import {
  ActionGenerator,
  deduplicateSearchEquivalentActions
} from "./search/ActionGenerator.js";
import { StateValue } from "./value/StateValue.js";
import { ValueSimulationQuery } from "./simulation/ValueSimulationQuery.js";
import { Simulator } from "./simulation/Simulator.js";
import { AI_RUNTIME_POLICY, AI_SEARCH_PROFILE } from "./policy/AiRuntimePolicy.js";
import { actionIntentKey, sameAction } from "./search/Action.js";
import { createSearchRequest } from "./search/SearchRequest.js";
import { createWorkerSearchOutcome, workerOutcomeViolations } from "./search/WorkerSearchOutcome.js";
import {
  Evaluator,
  buildResourceCandidates,
  chooseBestResourceHandCandidate,
  chooseContextualResourceCandidate,
  chooseDefaultZoneSelection,
  chooseLowestKnownCardId,
  chooseLowestRoleCardId,
  choosePublicCardId
} from "./value/Evaluator.js";
import { getCharacterRoleTags } from "./policy/CharacterRoleMetadata.js";
import { projectCanonicalSeatRoster } from "./state/RuleProjection.js";
import { inAttackRange } from "./state/DistanceProbabilityBranches.js";
import {
  nextLightningReceiverId as nextDomainLightningReceiverId
} from "../domain/rules/status/StatusRules.js";

export const SEARCH_RESULT_STATUS = Object.freeze({
  ACCEPTED:"ACCEPTED",
  STALE_VERSION:"STALE_VERSION",
  INVALID_SESSION:"INVALID_SESSION",
  INVALID_ACTOR:"INVALID_ACTOR",
  INVALID_PHASE:"INVALID_PHASE",
  INVALID_ACTION:"INVALID_ACTION",
  FALLBACK:"FALLBACK",
  CANCELLED:"CANCELLED"
});

/*
功能
在 Controller acceptance boundary 内记录一次 canonical Action 搜索结果。

调用方
AIController.acceptSearchResult 与 acceptWorkerSearchOutcome。

输入
请求身份、canonical Action/sequence、stats、acceptance status 与可选 RNG continuation。

输出
冻结的 main-thread 结果记录。

读取状态
只读输入普通值。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
这是 Controller 内联诊断记录，不是第二种 Action/World DTO；action 与 sequence 保持 canonical identity。
*/
function createSearchResult({
  request,
  action = null,
  plannedActions = [],
  stats = null,
  status,
  rejectionReason = null,
  rngAfter = null
}) {
  return Object.freeze({
    requestId:request.requestId,
    gameId:request.gameId,
    stateVersion:request.stateVersion,
    actorId:request.actorId,
    status,
    rejectionReason,
    action,
    plannedActions:Object.freeze([...(plannedActions ?? [])]),
    stats:stats ? Object.freeze({ ...stats }) : null,
    rngAfter:rngAfter ? Object.freeze({ ...rngAfter }) : null
  });
}

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

/*
功能
把真实或过滤 Player 转成 Evaluator 可读的公开响应视图。

调用方
AIController.buildResponseDecisionContext。

输入
Player 或玩家快照。

输出
不含 hand 实体和 Game 引用的公开响应视图。

读取状态
公开生命、护盾、能量、阵营、角色、状态、装备和手牌数量。

写入状态
无。

调用函数
getCharacterRoleTags。

边界与不变量
其他玩家真实 hand definitionId 永不进入输出；响应者自己的合法定义另行显式提供。
*/
function responsePlayerView(player) {
  if (!player) return null;
  return {
    id:player.id,
    seatIndex:player.seatIndex,
    alive:Boolean(player.alive),
    battleTeam:player.battleTeam,
    controllerType:player.controllerType,
    characterId:player.characterId ?? player.character?.id ?? null,
    roleTags:[...(player.roleTags ?? getCharacterRoleTags(
      player.characterId ?? player.character?.id
    ))],
    tags:[...(player.tags ?? [])],
    hp:Number(player.hp ?? 0),
    maxHp:Number(player.maxHp ?? player.hp ?? 0),
    shield:Number(player.shield ?? 0),
    energy:Number(player.energy ?? 0),
    handCount:Number(player.handCount ?? player.hand?.length ?? 0),
    hasEquipment:Boolean(player.equipment ?? player.equipmentDefinitionId),
    equipmentDefinitionId:player.equipment?.definitionId
      ?? player.equipmentDefinitionId
      ?? null,
    statuses:Array.isArray(player.statuses)
      ? [...player.statuses]
      : { ...(player.statuses ?? {}) },
    passiveSkillIds:[...(player.character?.passiveSkillIds ?? [])],
    momentum:Number(player.turnFlags?.momentum ?? player.momentum ?? 0),
    assaultBonus:Number(player.statuses?.allIn?.assaultBonus ?? player.assaultBonus ?? 0),
    guardianAidUsed:Boolean(
      player.turnFlags?.guardianAidUsed
      ?? ((player.guardianAidUsedProbability ?? 0) >= 1)
    )
  };
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
  Value owners、Fact、正式 Policy、执行边界与 ActionGenerator 构造函数。

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
    this.forceAiRescueHuman = this.getForceAiRescueHuman();
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
    this.lastSearchStats = null;
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
      getTurnEnergyBreakdown: (player) => this.getTurnEnergyBreakdown(player),
      getDifficultyMultiplier:() => this.getDifficultyMultiplier()
    });
    /*
    功能
    为 main-thread 组合根创建共享资源决策语义的独立 Simulator。

    调用方
    ValueSimulationQuery 与 Controller 的有界资源反事实编排。

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
      searchBudget:runtime.searchBudget ?? null,
      decideCounter:(...args) => this.stateEvaluator.decidePlanningCounter(...args),
      decideLeverageAssault:(...args) => this.stateEvaluator.decideLeverageAssault(...args),
      decideBlock:(...args) => this.stateEvaluator.decidePlanningBlock(...args),
      decideGuardianAid:(...args) => this.stateEvaluator.decidePlanningGuardianAid(...args),
      decideDyingRescue:(...args) => this.stateEvaluator.decidePlanningDyingRescue(...args),
      resolveDiscardCandidates:(...args) => this.stateEvaluator.resolveDiscardCandidates(...args)
    });
    this.simulatorFactory = simulatorFactory;
    this.valueSimulationQuery = new ValueSimulationQuery(
      this.stateEvaluator,
      simulatorFactory
    );
    this.stateValue = new StateValue(this.stateEvaluator, this.valueSimulationQuery);
    this.cardSelector = new CardSelectionBoundary({
      random: () => this.searchRng.next(),
      getState: () => this.getState(),
      remainingCounts: (actor) => deriveCurrentCardCounts(actor, this.getState())
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
  供 Searcher 搜索的候选动作数组；它是游戏规则合法动作的策略子集。

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
  从当前真实状态构造搜索快照并请求 Searcher 选择动作。

  调用方
  TurnWorkflow.takeAiPlayPhase 与测试。

  输入
  当前行动 Player 与可选搜索上下文。

  输出
  Searcher 从 AI 候选集合中选择的当前可执行动作。

  读取状态
  当前 GameState、合法 Fact 与搜索配置。

  写入状态
  最近搜索诊断与计划序列。

  调用函数
  deriveCurrentCardCounts、createInitialWorld、getActionCandidates、Searcher.search。

  边界与不变量
  剩余牌计数每次真实决策只计算一次，Searcher 不获得 Game 或 Controller。
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
  AI_RUNTIME_POLICY、AI_SEARCH_PROFILE hard watchdog 与 main-thread runtime override getters。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  runtime override 只服务显式测试/诊断覆盖；Controller 不理解速度档位或 timing RNG；正常 wall-clock 截止只由 Worker 内 SearchBudget.TIME 收束。
  */
  buildSearchConfig(options = {}) {
    const base = Object.freeze({
      depth:AI_RUNTIME_POLICY.searchDepth,
      beamWidth:AI_RUNTIME_POLICY.beamWidth,
      hiddenSamples:AI_RUNTIME_POLICY.hiddenStateSamples,
      yieldEvery:AI_RUNTIME_POLICY.searchYieldEvery,
      timeBudgetMs:AI_RUNTIME_POLICY.searchTimeBudgetMs,
      nodeBudget:null,
      nearTieRange:AI_RUNTIME_POLICY.nearTieRange,
      enableRandomness:AI_RUNTIME_POLICY.enableRandomness,
      randomnessRange:AI_RUNTIME_POLICY.randomnessRange,
      difficultyMultiplier:AI_RUNTIME_POLICY.difficultyMultiplier
    });
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
  判断 Searcher 返回 action 是否属于本次请求的 canonical root Action 集合。

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
  在 Worker 基础设施失败时返回 Generator 定义的确定性安全结束动作。

  调用方
  acceptWorkerSearchOutcome 的 malformed/workerError 分支。

  输入
  当前真实 Player 与可选 decision-local canonical 根动作集合。

  输出
  { action }；优先复用根集合中的 canonical end，否则由 Generator 创建同语义 end。

  读取状态
  当前 decision-local canonical 根动作。

  写入状态
  无。

  调用函数
  ActionGenerator.createEndAction。

  边界与不变量
  该路径不评分、不排序、不执行 Searcher/Simulator，也不尝试替代 AI 决策；
  基础设施故障只允许安全结束，避免 Controller 成为第二 final-selection authority。
  */
  selectWorkerFailureFallback(player, decisionRootActions = null) {
    const candidates = Array.isArray(decisionRootActions)
      ? decisionRootActions
      : this.getActionCandidates(player);
    return {
      action:candidates.find((action) => action?.type === "end")
        ?? this.actionGenerator.createEndAction(player.id)
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
    this.lastSearchFallback = null;
    this.lastSearchStats = outcome?.stats ? { ...outcome.stats } : null;
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
      const fallback = this.selectWorkerFailureFallback(player, decisionRootActions);
      const result = createSearchResult({
        request,
        action:fallback.action,
        plannedActions:[],
        stats:outcome?.stats ?? null,
        status:SEARCH_RESULT_STATUS.FALLBACK,
        rejectionReason:fallbackReason,
        rngAfter:null
      });
      this.lastSearchFallback = Object.freeze({
        source:"generator-safe-end",
        reason:fallbackReason,
        action:fallback.action
      });
      this.searchDiagnostics.FALLBACK += 1;
      this.lastSearchResult = result;
      this.acceptedPlannedSequence = [];
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
  current GameState、Fact、search configuration 与 searchRng。

  写入状态
  lastSearchRequest、lastDecisionDiagnostics、worker/fallback diagnostics、RNG continuation 与 accepted plan。

  调用函数
  createInitialWorld、getActionCandidates、createSearchRequest、searchExecutor.search、acceptWorkerSearchOutcome、decisionNow。

  边界与不变量
  生产 Searcher execution 由 executor 负责；正常 TIME 仍由 Worker 返回 incumbent；Main Thread 只在
  infrastructure fault 时使用 Generator 定义的安全 end，且不执行 Searcher/Simulator。
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
  只读诊断，不得被 Evaluator response willingness、runtime card resolution、搜索或 RNG 使用。
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
  返回最近一次已接受 Worker 搜索序列的隔离副本。

  调用方
  TurnWorkflow 可选连续计划执行路径。

  输入
  无。

  输出
  动作序列浅副本。

  读取状态
  acceptedPlannedSequence。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  调用方不得通过返回数组修改 Controller 已接受的 canonical Action 序列。
  */
  getPlannedSequence() {
    return [...this.acceptedPlannedSequence];
  }

  /*
  功能
  编排 destroy/plunder 的有界反事实，并把 Evaluator 胜者解析为当前真实实体。

  调用方
  chooseZoneCard 的 resource purpose 分支。

  输入
  行动者、资源拥有者、purpose、排除 ID 与冻结的 remaining counts。

  输出
  `{card, zone}` 或 null。

  读取状态
  当前合法实体、World 投影、Simulator transition、StateValue 与 Evaluator comparison。

  写入状态
  只在 anonymous 胜出时推进 AI RNG；真实 GameState 不变。

  调用函数
  createInitialWorld、Simulator.applyForcedResourceSelection、StateValue.transitionDelta、Evaluator resource methods。

  边界与不变量
  Controller 不写价值公式；每个候选恰好一次 clone/forced transition/state delta，unknown 只在胜出后解析物理位置。
  */
  chooseContextualZoneCard(
    actor,
    owner,
    purpose,
    excludedCardIds,
    remainingCardCounts
  ) {
    const world = createInitialWorld(actor.id, this.getState(), remainingCardCounts);
    const searchActor = world.players.find((player) => player.id === actor.id);
    const searchOwner = world.players.find((player) => player.id === owner.id);
    if (!searchActor || !searchOwner) return null;
    const eligibleCards = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const eligibleIds = new Set(eligibleCards.map((card) => card.id));
    const knownCards = (searchOwner.knownCards ?? []).filter(
      (entry) => eligibleIds.has(entry.cardId)
    );
    const knownIds = new Set(knownCards.map((entry) => entry.cardId));
    const unknownCards = eligibleCards.filter((card) => !knownIds.has(card.id));
    const candidates = buildResourceCandidates({
      purpose,
      actor:searchActor,
      owner:searchOwner,
      knownCards,
      unknownCount:unknownCards.length,
      equipmentDefinitionId:owner.equipment?.definitionId ?? null,
      remainingCardCounts
    }).map((candidate) => ({
      ...candidate,
      availableUnknownCount:unknownCards.length
    }));
    const simulator = this.simulatorFactory(world);
    const evaluated = [];
    for (const candidate of candidates) {
      const after = simulator.clone(world);
      const afterActor = after.players.find((player) => player.id === searchActor.id);
      const afterOwner = after.players.find((player) => player.id === searchOwner.id);
      const appliedProbability = simulator.applyForcedResourceSelection(
        after,
        afterActor,
        afterOwner,
        purpose,
        candidate
      );
      const rawStateDelta = appliedProbability > 0
        ? this.stateValue.transitionDelta(world, after, searchActor.id)
        : 0;
      evaluated.push(this.stateEvaluator.evaluateResourceTransitionCandidate({
        before:world,
        after,
        actorId:searchActor.id,
        purpose,
        candidate,
        appliedProbability,
        rawStateDelta
      }));
    }
    const selection = chooseContextualResourceCandidate(evaluated);
    if (selection?.zone === "equipment" && owner.equipment) {
      return { card:owner.equipment, zone:"equipment" };
    }
    if (selection?.selectionKind === "known") {
      const card = eligibleCards.find((entry) => entry.id === selection.cardId) ?? null;
      return card ? { card, zone:"hand" } : null;
    }
    if (selection?.selectionKind === "unknown" && unknownCards.length) {
      const index = Math.floor(this.searchRng.next() * unknownCards.length);
      return { card:unknownCards[index] ?? unknownCards[0], zone:"hand" };
    }
    return null;
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
  inAttackRange、Evaluator.resolveDiscardCandidates。

  边界与不变量
  门面不改动选择结果或牌序。
  */
  chooseDiscards(player, count) {
    const startedAt = decisionNow();
    const enemies = this.getEnemies(player);
    const state = this.getState();
    const stranded = enemies.length > 0 && !enemies.some(
      (enemy) => inAttackRange({ state }, player, enemy)
    );
    const cards = this.stateEvaluator.resolveDiscardCandidates(
      player,
      player.hand,
      count,
      {
        stranded,
        equippedDefinitionId:player.equipment?.definitionId
          ?? player.equipmentDefinitionId
          ?? null,
        equipmentRetentionProbability:player.equipmentRetentionProbability ?? 1
      }
    );
    this.recordMainThreadOperation(
      "Evaluator.resolveDiscardCandidates",
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
  Evaluator card/resource comparison、CardSelectionBoundary transfer residue 与 search RNG。

  边界与不变量
  未知牌只能按位置采样；除 transfer residue 外，价值比较只发生在 Evaluator。
  */
  chooseHiddenCards(
    actor,
    owner,
    count,
    excludedCardIds = null,
    context = null,
    resourceCounts = null
  ) {
    const startedAt = decisionNow();
    const candidates = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const purpose = context?.purpose ?? null;
    if (purpose === "transfer") {
      const cards = this.cardSelector.chooseTransferCards({
        actor,
        owner,
        cards:candidates,
        count,
        receiver:context?.receiver,
        excludedCardIds,
        remainingCardCounts:resourceCounts
      });
      this.recordMainThreadOperation(
        "CardSelectionBoundary.chooseTransferCards",
        startedAt,
        { candidateCount:candidates.length }
      );
      return cards;
    }
    const selected = [];
    const known = actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {};
    const remainingCardCounts = resourceCounts !== null
      ? resourceCounts
      : ((purpose === "destroy" || purpose === "plunder")
        ? deriveCurrentCardCounts(actor, this.getState())
        : null);
    while (selected.length < count && candidates.length) {
      let selectedId = null;
      if (actor.id === owner.id) {
        selectedId = chooseLowestRoleCardId(actor, candidates);
      } else if (purpose === "destroy" || purpose === "plunder") {
        const knownCards = candidates
          .map((card) => ({ cardId:card.id, definitionId:known[card.id] }))
          .filter((entry) => entry.definitionId);
        const choice = chooseBestResourceHandCandidate({
          purpose,
          actor,
          owner,
          knownCards,
          unknownCount:candidates.length - knownCards.length,
          remainingCardCounts
        });
        if (choice?.selectionKind === "known") selectedId = choice.cardId;
        else if (choice?.selectionKind === "unknown") {
          const unknown = candidates.filter((card) => !known[card.id]);
          selectedId = unknown[Math.floor(this.searchRng.next() * unknown.length)]?.id ?? null;
        }
      } else if (purpose === "scout" || purpose === "spy-gap") {
        const unknown = candidates.filter((card) => !known[card.id]);
        selectedId = unknown.length
          ? unknown[Math.floor(this.searchRng.next() * unknown.length)]?.id ?? null
          : chooseLowestKnownCardId(known, candidates);
      } else {
        selectedId = chooseLowestKnownCardId(known, candidates);
        if (!selectedId) {
          selectedId = candidates[Math.floor(this.searchRng.next() * candidates.length)]?.id ?? null;
        }
      }
      const index = candidates.findIndex((card) => card.id === selectedId);
      if (index < 0) break;
      selected.push(candidates.splice(index, 1)[0]);
    }
    this.recordMainThreadOperation(
      "AIController.resolveHiddenCards",
      startedAt,
      { candidateCount:owner?.hand?.length ?? "unavailable" }
    );
    return selected;
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
  chooseContextualZoneCard、chooseHiddenCards、Evaluator.chooseDefaultZoneSelection。

  边界与不变量
  不读取未知牌定义，真实执行仍按实体身份复核。
  */
  chooseZoneCard(actor, owner, context = null, excludedCardIds = null) {
    const startedAt = decisionNow();
    if (!owner?.alive) return null;
    const purpose = context?.purpose ?? null;
    const remainingCardCounts = purpose === "destroy" || purpose === "plunder"
      ? deriveCurrentCardCounts(actor, this.getState())
      : null;
    let selection = null;
    if (purpose === "destroy" || purpose === "plunder") {
      selection = this.chooseContextualZoneCard(
        actor,
        owner,
        purpose,
        excludedCardIds,
        remainingCardCounts
      );
    } else {
      const [handCard] = this.chooseHiddenCards(
        actor,
        owner,
        1,
        excludedCardIds,
        context,
        remainingCardCounts
      );
      const descriptor = chooseDefaultZoneSelection({
        actor,
        owner,
        handCard:handCard ?? null,
        equipment:owner.equipment ?? null
      });
      if (descriptor?.zone === "equipment" && owner.equipment) {
        selection = { card:owner.equipment, zone:"equipment" };
      } else if (descriptor?.zone === "hand" && handCard?.id === descriptor.cardId) {
        selection = { card:handCard, zone:"hand" };
      }
    }
    const handCount = Array.isArray(owner?.hand) ? owner.hand.length : Number.NaN;
    this.recordMainThreadOperation(
      "AIController.resolveZoneCard",
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
  Evaluator.choosePublicCardId。

  边界与不变量
  门面不改变同分时的原始顺序。
  */
  choosePublicCard(player, cards) {
    const startedAt = decisionNow();
    const cardId = choosePublicCardId(player, cards);
    const card = cards.find((candidate) => candidate.id === cardId) ?? null;
    this.recordMainThreadOperation(
      "Evaluator.choosePublicCardId",
      startedAt,
      { candidateCount:Array.isArray(cards) ? cards.length : "unavailable" }
    );
    return card;
  }

  /*
  功能
  把真实响应参数转换成 Evaluator 使用的 plain DecisionContext。

  调用方
  shouldRespond、assessDyingRescue 与响应专项查询。

  输入
  响应者、响应类型、真实公开上下文和合法响应卡数组。

  输出
  不含 Game/Simulator 引用且只暴露合法信息的 DecisionContext。

  读取状态
  当前 GameState、Fact、Team Rules、Dying order 与显式 Value/Domain query。

  写入状态
  只有被调用的未知位置/状态查询可能写 query 私有缓存；真实状态不变。

  调用函数
  responsePlayerView、createInitialWorld、ValueSimulationQuery 与既有 Domain/Value 辅助函数。

  边界与不变量
  Controller 只负责 runtime entity/context binding；所有价值比较由同一 Evaluator 完成，昂贵查询惰性且每分支至多一次。
  */
  buildResponseDecisionContext(responder, type, rawContext, cards = []) {
    const rawPlayers = this.getState().players;
    const players = rawPlayers.map(responsePlayerView);
    const byId = new Map(players.map((player) => [player.id, player]));
    const responderView = byId.get(responder.id);
    const publicContext = {
      ...rawContext,
      target:byId.get(rawContext.target?.id) ?? null,
      source:byId.get(rawContext.source?.id) ?? null,
      rootSource:byId.get(rawContext.rootSource?.id) ?? null,
      statusCounterContext:rawContext.statusCounterContext
        ? { ...rawContext.statusCounterContext }
        : null
    };
    let remainingCardCounts;
    /*
    功能
    在一次响应决策内惰性读取并复用同一份 canonical remaining counts。

    调用方
    buildResponseDecisionContext 的状态、guardian 与 dynamic query 闭包。

    输入
    无；闭包捕获当前 responder。

    输出
    Fact 返回的当前确定牌池计数。

    读取状态
    当前 GameState 与观察者合法信息。

    写入状态
    只写本次 DecisionContext 的局部缓存。

    调用函数
    deriveCurrentCardCounts。

    边界与不变量
    同一响应窗口最多计算一次，不跨决策复用或暴露真实未知牌。
    */
    const getRemainingCardCounts = () => {
      if (remainingCardCounts === undefined) {
        remainingCardCounts = deriveCurrentCardCounts(responder, this.getState());
      }
      return remainingCardCounts;
    };
    const needsRemainingCounts = type === "counter" || type === "skill" || type === "dyingRescue";
    if (needsRemainingCounts) getRemainingCardCounts();
    const rescueOrder = type === "dyingRescue"
      ? this.getDyingRescueOrder(rawContext.target ?? responder)
          .map((player) => byId.get(player.id))
          .filter(Boolean)
      : [];
    return {
      responder:responderView,
      responseType:type,
      context:publicContext,
      cards,
      players,
      rescueOrder,
      responderHandDefinitionIds:(responder.hand ?? []).map((card) => card.definitionId),
      knownCardsByPlayer:responder.aiMemory.knownCardsByPlayer,
      remainingCardCounts:needsRemainingCounts ? remainingCardCounts : null,
      isSmallTeam:this.isSmallTeam(responder),
      forceAiRescueHuman:this.forceAiRescueHuman,
      leverageMetrics:() => {
        const target = rawContext.target ?? responder;
        const world = createInitialWorld(responder.id, this.getState());
        return this.stateEvaluator.leverageResponseMetrics(
          responderView,
          byId.get(target.id),
          responder.aiMemory,
          world,
          getRemainingCardCounts()
        );
      },
      guardianAidValues:() => {
        const target = rawContext.target;
        const world = createInitialWorld(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        return this.valueSimulationQuery.guardianAidValues(
          world,
          responder.id,
          target.id,
          rawContext.source?.id ?? null,
          Math.max(0, Number(rawContext.amount) || 0),
          this.stateValue
        );
      },
      lightningCounterTerms:() => {
        const holder = rawPlayers.find((player) => (
          player.id === rawContext.statusCounterContext?.holderId && player.alive
        ));
        if (!holder
          || !hasFactStatus(holder, "lightning")
          || holder.battleTeam !== responder.battleTeam) {
          return { valid:false, noCounterBurden:0, withCounterBurden:0 };
        }
        const world = createInitialWorld(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        const worldHolder = world.players.find((player) => player.id === holder.id);
        const receiverId = nextDomainLightningReceiverId(
          projectCanonicalSeatRoster(rawPlayers),
          holder.id
        );
        const worldReceiver = world.players.find((player) => player.id === receiverId);
        return this.valueSimulationQuery.lightningCounterTerms(
          world,
          worldHolder,
          worldReceiver,
          responder.id
        );
      },
      sealCounterTerms:() => {
        const holder = rawPlayers.find((player) => (
          player.id === rawContext.statusCounterContext?.holderId && player.alive
        ));
        if (!holder
          || !hasFactStatus(holder, "sealed")
          || holder.battleTeam !== responder.battleTeam) {
          return { valid:false, preventedBurden:0 };
        }
        const world = createInitialWorld(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        const probabilityHolder = world.players.find((player) => player.id === holder.id);
        return this.stateEvaluator.sealCounterTerms(
          probabilityHolder,
          world,
          getRemainingCardCounts()
        );
      },
      dynamicRootFlipGain:() => {
        const rootCard = rawContext.rootCard ?? rawContext.card;
        if (!rootCard?.definitionId || rootCard.category !== "tactic") return null;
        const rootSourceId = rawContext.rootSourceId
          ?? rawContext.rootSource?.id
          ?? rawContext.source?.id
          ?? null;
        const world = createInitialWorld(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        const rootAction = this.actionGenerator.createRootResolutionAction(
          world,
          rootCard,
          rootSourceId,
          Array.isArray(rawContext.rootTargetIds) ? rawContext.rootTargetIds : [],
          { publicTransferContext:rawContext.publicTransferContext ?? null }
        );
        if (!rootAction) return null;
        return this.valueSimulationQuery.dynamicRootFlipGain(
          world,
          responder.id,
          rootAction,
          rawContext.counterDepth ?? 0,
          this.stateValue
        );
      }
    };
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
  当前 GameState、Fact、runtime binding 与 Evaluator。

  写入状态
  无。

  调用函数
  buildResponseDecisionContext、Evaluator.shouldRespond。

  边界与不变量
  候选牌默认空数组；门面不得构造或泄露额外隐藏信息。
  */
  shouldRespond(player, type, context, cards = []) {
    const startedAt = decisionNow();
    const decision = this.stateEvaluator.shouldRespond(
      this.buildResponseDecisionContext(player, type, context, cards)
    );
    this.recordMainThreadOperation(
      "AIController.shouldRespond",
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
  Evaluator 生成的救援 assessment object。

  读取状态
  Controller 绑定的当前公开状态、合法记忆与 Probability。

  写入状态
  无。

  调用函数
  buildResponseDecisionContext、Evaluator.assessDyingRescue。

  边界与不变量
  Controller 只暴露窄查询；不得让 Application 直接访问 Policy 内部 owner。
  */
  assessDyingRescue(responder, target) {
    const startedAt = decisionNow();
    const decision = this.buildResponseDecisionContext(
      responder,
      "dyingRescue",
      { target },
      []
    );
    const assessment = this.stateEvaluator.assessDyingRescue({
      responder:decision.responder,
      target:decision.context.target,
      rescueOrder:decision.rescueOrder,
      responderHandDefinitionIds:decision.responderHandDefinitionIds,
      knownCardsByPlayer:decision.knownCardsByPlayer,
      recoverDensity:decision.recoverDensity,
      remainingCardCounts:decision.remainingCardCounts
    });
    this.recordMainThreadOperation(
      "AIController.assessDyingRescue",
      startedAt,
      { candidateCount:this.getState()?.players?.length }
    );
    return assessment;
  }

  /*
  功能
  通过 Controller runtime binding 评估护援响应。

  调用方
  护援专项测试与真实响应入口。

  输入
  守誓者与公开伤害上下文。

  输出
  是否发动护援。

  读取状态
  当前 GameState、Probability 与窄 simulation query。

  写入状态
  无。

  调用函数
  shouldRespond。

  边界与不变量
  与 skill 响应窗口共用同一 Evaluator willingness，Controller 不增加阈值。
  */
  shouldUseGuardianAid(responder, context) {
    return this.shouldRespond(responder, "skill", context, []);
  }

}
