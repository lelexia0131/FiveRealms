/*
模块职责
作为 AI 组合根一次性构造组件、注入窄能力，并向真实执行边界提供稳定门面。

上游
MatchApplication、ResponseWorkflow、PublicCardPoolWorkflow、角色技能与测试。

下游
状态组合、Fact、动作生成、Searcher 运行组合与 Worker 搜索边界。

状态边界
只在门面入口读取当前 GameState；价值与搜索组件仅接收 World 与显式能力。

信息边界
确定信息只能经 Fact 进入边界；未知信息只能经 Probability 局部查询进入决策。

架构约束
子组件不得回指 Controller；公开 owner 字段只供显式诊断与专项测试，生产上游使用控制器边界。
*/
import { createInitialWorld } from "./Simulator/World.js";
import {
  deriveCurrentCardCounts,
  hasFactStatus
} from "./Event/Fact.js";
import {
  Generator,
  deduplicateSearchEquivalentActions
} from "./Generator/Generator.js";
import { sameAction } from "./Generator/Action.js";
import {
  Evaluator,
  chooseDiscardCandidates,
  chooseLowestKnownCardId,
  chooseLowestRoleCardId
} from "./Evaluator/Evaluator.js";
import {
  SearchBudget,
  Searcher,
  validateRootActionContract
} from "./Searcher/Searcher.js";
import { Pattern } from "./Searcher/Pattern.js";
import { Rng, hashSearchSeed } from "./Searcher/Rng.js";
import { Simulator, tacticResolutionScale } from "./Simulator/Simulator.js";
import {
  inAttackRange,
  sampleProbabilityWorlds
} from "./Event/Probability/Probability.js";

export const AI_RUNTIME_POLICY = Object.freeze({
  forceAiRescueHuman:true,
  maxActionsPerTurn:16,
  searchDepth:4,
  beamWidth:10,
  hiddenStateSamples:10,
  searchTimeBudgetMs:900,
  searchYieldEvery:48,
  nearTieRange:0.35,
  enableRandomness:true,
  randomnessRange:0.035,
  difficultyMultiplier:1
});

export const AI_SEARCH_PROFILE = Object.freeze({
  mode:"NORMAL",
  softTargetMs:null,
  hardWatchdogMs:10000
});

/*
功能
冻结 search request 中的数组或浅层 plain object 值。

调用方
createSearchRequest、createWorkerSearchOutcome。

输入
任意可序列化值。

输出
数组或对象的冻结浅副本；primitive 原样返回。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
canonical World/Action 已在入口验证冻结；本 helper 不深拷贝或创建第二 canonical model。
*/
function freezeValue(value) {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (value && typeof value === "object") return Object.freeze({ ...value });
  return value;
}
/*
功能
创建一次 AI search request。

调用方
Controller.selectAction 与 SearchRequest 契约测试。

输入
requestId、gameId、stateVersion、actorId、phase、currentRound、canonical World、searchConfig、rng 与 rootActions。

输出
冻结 data-only SearchRequest。

读取状态
只读输入。

写入状态
无。

调用函数
freezeValue、validateRootActionContract、Object.freeze。

边界与不变量
不接受函数；world 与 rootActions 必须直接使用 canonical frozen World/Action，不做 DTO materialization；
World 必须包含 actor，全部 roots 必须属于该 actor 且恰有一个 canonical END。
*/
export function createSearchRequest({
  requestId,
  gameId,
  stateVersion,
  actorId,
  phase,
  currentRound,
  world,
  searchConfig,
  rng,
  rootActions
}) {
  if (typeof requestId !== "string" || !requestId) throw new TypeError("SearchRequest 需要 requestId");
  if (typeof gameId !== "string" || !gameId) throw new TypeError("SearchRequest 需要 gameId");
  if (!Number.isInteger(stateVersion) || stateVersion < 0) throw new TypeError("SearchRequest 需要非负整数 stateVersion");
  if (typeof actorId !== "string" || !actorId) throw new TypeError("SearchRequest 需要 actorId");
  if (!world || typeof world !== "object") throw new TypeError("SearchRequest 需要 world");
  if (!Object.isFrozen(world)) throw new TypeError("SearchRequest 需要 canonical frozen World");
  if (!searchConfig || typeof searchConfig !== "object") throw new TypeError("SearchRequest 需要 searchConfig");
  if (!rng || typeof rng !== "object" || typeof rng.seed !== "number"
    || typeof rng.state !== "number" || rng.algorithm !== "lcg") {
    throw new TypeError("SearchRequest 需要 lcg rng continuation（seed/state/draws）");
  }
  if (!Array.isArray(rootActions)) throw new TypeError("SearchRequest 需要 rootActions");
  if (rootActions.some((action) => !action || !Object.isFrozen(action))) {
    throw new TypeError("SearchRequest 需要 canonical frozen Actions");
  }
  if (!Array.isArray(world.players)
    || !world.players.some((player) => player?.id === actorId)) {
    throw new TypeError(`SearchRequest World 缺少 actor：${actorId}`);
  }
  validateRootActionContract({ id:actorId }, rootActions);
  return Object.freeze({
    requestId,
    gameId,
    stateVersion,
    actorId,
    phase,
    currentRound,
    world,
    searchConfig:freezeValue(searchConfig),
    rng:freezeValue(rng),
    rootActions:Object.freeze([...rootActions])
  });
}

/*
功能
把 Worker search result 补齐 request identity 并冻结为 plain payload。

调用方
WorkerSearchRuntime 与 Controller transport-failure fallback。

输入
Request 与当前 root canonical Action、stats、RNG continuation、取消或错误字段。

输出
Structured-clone-safe plain object。

读取状态
Request identity 与结果普通值。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
Payload 不是第二 Action/World model；只运输本次真实执行所需的 root Action。
*/
export function createWorkerSearchOutcome({ request, ...result }) {
  return Object.freeze({
    requestId:request.requestId,
    gameId:request.gameId,
    stateVersion:request.stateVersion,
    actorId:request.actorId,
    action:result.action ?? null,
    stats:result.stats ? Object.freeze({ ...result.stats }) : null,
    searchStopReason:result.searchStopReason ?? null,
    searchFault:result.searchFault ? Object.freeze({ ...result.searchFault }) : null,
    rngAfter:result.rngAfter ? Object.freeze({ ...result.rngAfter }) : null,
    cancelled:Boolean(result.cancelled),
    workerError:result.workerError ?? null
  });
}

/*
功能
验证 outcome 是否可被 Main Thread 安全处理。

调用方
Worker transport 与测试。

输入
outcome 与 request。

输出
data-only/request identity violations 数组。

读取状态
无。

写入状态
无。

调用函数
Object.entries。

边界与不变量
未知 requestId、缺失 rngAfter、实体字段或函数字段均 fail safe。
*/
export function workerOutcomeViolations(outcome, request = null) {
  const violations = [];
  if (!outcome || typeof outcome !== "object") return ["outcome-not-object"];
  if (request && outcome.requestId !== request.requestId) violations.push("requestId mismatch");
  if (request && outcome.gameId !== request.gameId) violations.push("gameId mismatch");
  if (request && outcome.stateVersion !== request.stateVersion) violations.push("stateVersion mismatch");
  if (!outcome.rngAfter || typeof outcome.rngAfter.state !== "number") violations.push("rngAfter missing");
  for (const [key, value] of Object.entries(outcome)) {
    if (typeof value === "function") violations.push(`function:${key}`);
  }
  return violations;
}

export const SEARCH_RESULT_STATUS = Object.freeze({
  ACCEPTED:"ACCEPTED",
  PREPARATION_FAILURE:"PREPARATION_FAILURE",
  SEARCH_INTERNAL_FAILURE:"SEARCH_INTERNAL_FAILURE",
  WORKER_FAILURE:"WORKER_FAILURE",
  SEARCH_CANCELLED:"SEARCH_CANCELLED",
  SEARCH_BUDGET_EXHAUSTED:"SEARCH_BUDGET_EXHAUSTED",
  STALE_VERSION:"STALE_VERSION",
  INVALID_SESSION:"INVALID_SESSION",
  INVALID_ACTOR:"INVALID_ACTOR",
  INVALID_PHASE:"INVALID_PHASE",
  INVALID_ACTION:"INVALID_ACTION"
});

/*
功能
在 Controller acceptance boundary 内记录一次 canonical Action 搜索结果。

调用方
acceptWorkerSearchOutcome。

输入
请求身份、当前 root canonical Action、stats、acceptance status 与可选 RNG continuation。

输出
冻结的 main-thread 结果记录。

读取状态
只读输入普通值。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
这是 Controller 内联诊断记录，不是第二种 Action/World DTO；只记录当前 root Action。
*/
function createSearchResult({
  request,
  action = null,
  stats = null,
  status,
  rejectionReason = null,
  searchFault = null,
  rngAfter = null
}) {
  return Object.freeze({
    requestId:request.requestId,
    gameId:request.gameId,
    stateVersion:request.stateVersion,
    actorId:request.actorId,
    status,
    rejectionReason,
    searchFault:searchFault ? Object.freeze({ ...searchFault }) : null,
    action,
    stats:stats ? Object.freeze({ ...stats }) : null,
    rngAfter:rngAfter ? Object.freeze({ ...rngAfter }) : null
  });
}

/*
功能
读取 main-thread decision diagnostics 使用的单调墙钟。

调用方
Controller.selectAction。

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
创建 application boundary 使用的 AI search RNG。

调用方
MatchApplication composition root 与 RNG 契约测试。

输入
数值 seed 或需要稳定散列的 session 字符串。

输出
可快照、恢复与提交 continuation 的 Search Rng。

读取状态
无。

写入状态
只初始化新 Rng 实例。

调用函数
hashSearchSeed、Rng。

边界与不变量
应用层不得直接 import Searcher/Rng.js；数值 seed 不重新散列，字符串 seed 使用固定 FNV-1a。
*/
export function createSearchRng(seed) {
  const numericSeed = typeof seed === "number" && Number.isFinite(seed)
    ? seed
    : hashSearchSeed(seed);
  return new Rng(numericSeed);
}

/*
功能
构造主线程与 Worker 共用的 Evaluator/Simulator 语义运行组合。

调用方
Controller constructor 与 createSearchEngine。

输入
能量规则、难度倍率与可选根 World。

输出
共享同一 Evaluator 决策能力的 evaluator 与 simulatorFactory。

读取状态
只调用注入的稳定规则函数。

写入状态
无；Simulator 实例只在 factory 被调用时创建。

调用函数
Evaluator、Simulator。

边界与不变量
Controller 是唯一 composition owner；Simulator 只接收 Evaluator 的 boolean/resource capabilities，Evaluator 不保存或反向调用 Simulator。
*/
function createRuntimeComposition({
  world = null,
  getMaxEnergy: getMaxEnergyForPlayer = null,
  getTurnEnergyBreakdown: getTurnEnergyBreakdownForPlayer = null,
  getDifficultyMultiplier = () => 1,
  forceAiRescueHuman = true
} = {}) {
  const evaluator = new Evaluator({
    world,
    getMaxEnergy:getMaxEnergyForPlayer,
    getTurnEnergyBreakdown:getTurnEnergyBreakdownForPlayer,
    getDifficultyMultiplier,
    forceAiRescueHuman
  });
  /*
  功能
  为一次搜索或主线程同步价值查询创建注入同一 Evaluator 决策的 Simulator。

  调用方
  Searcher、Controller runtime boundary。

  输入
  可选 SearchBudget runtime。

  输出
  不持有 World、只在显式方法输入上工作的 Simulator。

  读取状态
  闭包中的 Evaluator 与显式 SearchBudget。

  写入状态
  仅新 Simulator 实例内部状态。

  调用函数
  Simulator、Evaluator response/resource decision methods。

  边界与不变量
  所有环境共用完全相同的决策注入；Evaluator 不保存或反向调用 Simulator。
  */
  const simulatorFactory = (runtime = {}) => new Simulator({
    searchBudget:runtime.searchBudget ?? null,
    decideCounter:(...args) => evaluator.decidePlanningCounter(...args),
    decideLeverageAssault:(...args) => evaluator.decideLeverageAssault(...args),
    decideBlock:(...args) => evaluator.decidePlanningBlock(...args),
    decideGuardianAid:(...args) => evaluator.decidePlanningGuardianAid(...args),
    decideDyingRescue:(...args) => evaluator.decidePlanningDyingRescue(...args),
    choosePublicCardId:(...args) => evaluator.choosePublicCardId(...args),
    resolveDiscardCandidates:chooseDiscardCandidates
  });
  return { evaluator, simulatorFactory };
}

/*
功能
从 canonical search request 构造唯一 Searcher 运行图。

调用方
executeSearchRequest 与搜索 composition 测试。

输入
Search request、已恢复 Rng 与 Worker-safe runtime control。

输出
共享同一 Evaluator、Simulator、Generator、Pattern 与 Searcher 的运行图。

读取状态
request.world 与 request.searchConfig。

写入状态
无；Search 执行时才写实例诊断。

调用函数
createRuntimeComposition、Generator、Pattern、Searcher 与 SearchBudget。

边界与不变量
这是 main/local/Worker 唯一 composition；所有随机只来自传入 Rng，不读取 Game 或 main-thread mutable state。
*/
export function createSearchEngine(request, rng, runtimeControl = {}) {
  const rootWorld = request.world;
  const config = request.searchConfig;
  const { evaluator, simulatorFactory } = createRuntimeComposition({
    world:rootWorld,
    getDifficultyMultiplier:() => config.difficultyMultiplier
  });
  const generator = new Generator();
  const searcher = new Searcher({
    evaluator,
    patternMatcher:new Pattern(),
    getResolutionScale:tacticResolutionScale,
    config,
    simulatorFactory,
    searchBudgetFactory:() => new SearchBudget({
      timeBudget:config.timeBudgetMs,
      nodeBudget:config.nodeBudget,
      now:typeof runtimeControl.now === "function" ? runtimeControl.now : null
    }),
    deduplicateActions:deduplicateSearchEquivalentActions,
    generateActions:(...args) => generator.generate(...args),
    sampleUnknownHands:(query) => sampleProbabilityWorlds({
      ...query,
      random:() => rng.next()
    }),
    yieldControl:typeof runtimeControl.yieldControl === "function"
      ? runtimeControl.yieldControl
      : async () => true
  });
  return { searcher, rng };
}

/*
功能
恢复请求 RNG 并通过 Controller public composition 执行一次搜索。

调用方
WorkerSearchRuntime 的 local 与 Dedicated Worker dispatch。

输入
Canonical request 与 Worker-safe runtime control。

输出
当前 root canonical Action、stats、stop reason、RNG continuation 与取消标记。

读取状态
request 的 World、Action、config 与 RNG snapshot。

写入状态
只写本次 Searcher、Simulator 与 Rng 实例。

调用函数
Rng.restore、createSearchEngine、Searcher.search。

边界与不变量
不创建 transport DTO；返回值直接引用 canonical Action，Worker 只补 request identity 并序列化。
*/
export async function executeSearchRequest(request, runtimeControl = {}) {
  const rng = Rng.restore(request.rng);
  const actor = request.world.players.find((player) => player.id === request.actorId) ?? null;
  if (!actor) throw new Error(`Worker World 缺少 actor：${request.actorId}`);
  const engine = createSearchEngine(request, rng, runtimeControl);
  const action = await engine.searcher.search(
    actor,
    request.world,
    request.rootActions,
    {
      gameId:request.gameId,
      rootCandidateCount:request.rootActions.length
    }
  );
  const cancelled = engine.searcher.lastSearchStats?.stopReason === "CANCELLED";
  return {
    action,
    stats:engine.searcher.lastSearchStats,
    searchStopReason:engine.searcher.lastSearchStats?.stopReason ?? null,
    searchFault:engine.searcher.lastSearchStats?.searchFault ?? null,
    rngAfter:rng.snapshot(),
    cancelled
  };
}

export class Controller {
  /*
  功能
  按明确顺序构造 AI 组件，并把窄能力一次性注入依赖方。

  调用方
  MatchApplication composition root 与直接构造测试。

  输入
  显式 narrow dependencies（state/session/rule capability/search RNG/lifecycle/current entity lookup）。

  输出
  完成装配的 Controller；缺少必要运行能力时由子组件构造立即失败。

  读取状态
  无；依赖均为显式能力引用。

  写入状态
  仅写控制器组件字段。

  调用函数
  createRuntimeComposition、Fact、Evaluator、Generator 与真实选择/响应边界方法。

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
      if (typeof dependencies[name] !== "function") throw new TypeError(`Controller 缺少依赖：${name}`);
    }
    if (!dependencies.searchRng || typeof dependencies.searchRng.next !== "function"
      || typeof dependencies.searchRng.snapshot !== "function"
      || typeof dependencies.searchRng.commit !== "function") {
      throw new TypeError("Controller 缺少依赖：searchRng");
    }
    if (!dependencies.searchExecutor || typeof dependencies.searchExecutor.search !== "function") {
      throw new TypeError("Controller 缺少依赖：searchExecutor.search");
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
    this.lastDecisionDiagnostics = null;
    this.lastMainThreadOperationDiagnostics = null;
    this.lastSearchStats = null;
    this.committedRngRequestIds = new Set();
    this.searchDiagnostics = {
      SEARCH:0,
      RESULT:0,
      CANCEL:0,
      WATCHDOG:0,
      STALE:0,
      WORKER_ERROR:0
    };
    this.actionGenerator = new Generator();

    const runtimeComposition = createRuntimeComposition({
      getMaxEnergy: (player) => this.getMaxEnergy(player),
      getTurnEnergyBreakdown: (player) => this.getTurnEnergyBreakdown(player),
      getDifficultyMultiplier:() => this.getDifficultyMultiplier(),
      forceAiRescueHuman:this.forceAiRescueHuman
    });
    this.evaluator = runtimeComposition.evaluator;
    this.simulatorFactory = runtimeComposition.simulatorFactory;
  }

  /*
  功能
  通过动作生成器返回当前真实局面中经规则校验与 AI 候选策略筛选的根动作。

  调用方
  selectAction 与测试。

  输入
  当前行动 Player。

  输出
  供 Searcher 搜索的候选动作数组；它是游戏规则合法动作的策略子集。

  读取状态
  当前 GameState 与 Domain Rules 权威。

  写入状态
  无。

  调用函数
  Generator.generate。

  边界与不变量
  Domain Rules 定义确定性游戏合法性；门面不得额外筛选或重排 Generator 的 canonical 候选。
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
  selectAction 的 pre-worker 阶段与 Controller 的 Response/CardSelection 门面。

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
  最近搜索诊断与当前 root Action acceptance 记录。

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
  acceptWorkerSearchOutcome。

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
  stateVersion 保护本次异步 search result；每个真实 Action 后下一步都会从新 stateVersion 重新搜索。
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
  acceptWorkerSearchOutcome。

  输入
  canonical Action 与 request.rootActions。

  输出
  布尔值。

  读取状态
  无。

  写入状态
  无。

  调用函数
  sameAction。

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
  isSessionValid、Rng.commit。

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
  接受 WorkerSearchOutcome，并把 transport/search failure 与战略 Action 严格分离。

  调用方
  selectAction 与 worker result tests。

  输入
  request、WorkerSearchOutcome 与可选 decision-local 合法根集合。

  输出
  { action, result }；正常结果返回经身份、版本与根集合验证的 canonical Action；
  无 Searcher Action 或 acceptance 拒绝时 action 为 null 并返回显式 failure result。

  读取状态
  current GameState、session、request、outcome 与 decision-local root set。

  写入状态
  searchRng continuation、lastWorkerOutcome、lastSearchResult 与 diagnostics。

  调用函数
  workerOutcomeViolations、commitWorkerRng、validateRequestAcceptance、isActionInRootSet、createSearchResult。

  边界与不变量
  Worker 不宣布 ACCEPTED；Main Thread 验证全部身份/version/actor/phase/root membership；
  CANCELLED/FAULT 带完整 action 时仍必须通过全部 acceptance；没有 action 时按真实停止层分类；
  validation 通过时允许复用同一 decision 已生成的合法实体根，
  但不得跨 stateVersion 或跨 decision 缓存；Controller 绝不创建战略 END。
  */
  acceptWorkerSearchOutcome(request, outcome, decisionRootActions = null) {
    this.lastWorkerOutcome = outcome;
    this.lastSearchStats = outcome?.stats ? { ...outcome.stats } : null;
    const acceptedRootActions = Array.isArray(decisionRootActions)
      ? decisionRootActions
      : request.rootActions;
    const malformed = workerOutcomeViolations(outcome, request);
    if (malformed.length || outcome?.workerError) {
      this.searchDiagnostics.WORKER_ERROR += 1;
      const failureReason = outcome?.workerError ?? malformed.join(", ");
      if (String(failureReason).includes("watchdog")) this.searchDiagnostics.WATCHDOG += 1;
      const result = createSearchResult({
        request,
        action:null,
        stats:outcome?.stats ?? null,
        status:SEARCH_RESULT_STATUS.WORKER_FAILURE,
        rejectionReason:failureReason,
        searchFault:outcome?.searchFault ?? null,
        rngAfter:null
      });
      this.lastSearchResult = result;
      return { action:null, result };
    }
    const cancelled = outcome.cancelled || outcome.searchStopReason === "CANCELLED";
    if (cancelled) this.searchDiagnostics.CANCEL += 1;
    if (!outcome.action) {
      const stopReason = outcome.searchStopReason ?? outcome.stats?.stopReason ?? null;
      const status = cancelled
        ? SEARCH_RESULT_STATUS.SEARCH_CANCELLED
        : ["TIME", "NODE"].includes(stopReason)
          ? SEARCH_RESULT_STATUS.SEARCH_BUDGET_EXHAUSTED
          : SEARCH_RESULT_STATUS.SEARCH_INTERNAL_FAILURE;
      const rejectionReason = cancelled
        ? "cancelled without complete Searcher action"
        : ["TIME", "NODE"].includes(stopReason)
          ? `${stopReason} budget exhausted without complete Searcher action`
          : stopReason === "FAULT" || outcome.searchFault
            ? "Searcher internal fault without complete action"
            : `Searcher ${stopReason ?? "UNKNOWN"} returned no complete action`;
      const result = createSearchResult({
        request,
        action:null,
        stats:outcome.stats,
        status,
        rejectionReason,
        searchFault:outcome.searchFault,
        rngAfter:null
      });
      this.lastSearchResult = result;
      return { action:null, result };
    }

    const player = this.getState().players.find((entry) => entry.id === request.actorId) ?? null;
    const validation = this.validateRequestAcceptance(player, request);
    if (validation.status) {
      const result = createSearchResult({
        request,
        action:null,
        stats:outcome.stats,
        status:validation.status,
        rejectionReason:validation.reason,
        searchFault:outcome.searchFault,
        rngAfter:null
      });
      this.lastSearchResult = result;
      return { action:null, result };
    }

    const action = outcome.action;
    if (!this.isActionInRootSet(action, acceptedRootActions)) {
      const result = createSearchResult({
        request,
        action:null,
        stats:outcome.stats,
        status:SEARCH_RESULT_STATUS.INVALID_ACTION,
        rejectionReason:"action not in request root set",
        searchFault:outcome.searchFault,
        rngAfter:null
      });
      this.lastSearchResult = result;
      return { action:null, result };
    }

    const rngCommitted = this.commitWorkerRng(request, outcome);
    const result = createSearchResult({
      request,
      action,
      stats:outcome.stats,
      status:SEARCH_RESULT_STATUS.ACCEPTED,
      searchFault:outcome.searchFault,
      rngAfter:rngCommitted ? outcome.rngAfter : null
    });
    this.lastSearchResult = result;
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
  当前可执行 action；preparation、搜索或 transport failure 返回 null，
  并在 lastSearchResult 中记录显式 failure status 与原始错误诊断。

  读取状态
  current GameState、Fact、search configuration 与 searchRng。

  写入状态
  lastSearchRequest、lastDecisionDiagnostics、worker diagnostics、RNG continuation 与当前 search result。

  调用函数
  deriveCurrentCardCounts、createInitialWorld、getActionCandidates、createSearchRequest、
  searchExecutor.search、acceptWorkerSearchOutcome、decisionNow。

  边界与不变量
  调用者必须提供合法 Player；该调用合同在可恢复 AI preparation boundary 外显式失败。
  生产 Searcher execution 由 executor 负责；TIME/CANCELLED/FAULT 可由 Worker 同时返回完整 incumbent 与 diagnostics；
  Main Thread 只验收 Searcher Action，任何 preparation/search failure 都不得制造 canonical END。
  */
  async selectAction(player, options = {}) {
    if (!player || typeof player.id !== "string" || !player.id) {
      throw new TypeError("Controller.selectAction 需要合法 Player");
    }
    const state = this.getState();
    if (!this.isSessionValid(options.gameId ?? state.gameId)) {
      this.lastSearchResult = Object.freeze({
        requestId:null,
        gameId:state.gameId,
        stateVersion:state.stateVersion,
        actorId:player.id,
        status:SEARCH_RESULT_STATUS.INVALID_SESSION,
        rejectionReason:"invalid session before search",
        action:null,
        stats:null,
        searchFault:null,
        rngAfter:null
      });
      return null;
    }
    const preWorkerStartedAt = decisionNow();
    const mainThreadOperations = [];
    let operationStartedAt = decisionNow();
    let preparationOperation = "remaining-counts";
    let rootActions = null;
    let uniqueRootCount = null;
    let requestId = null;
    let request = null;
    let preWorkerFinishedAt = null;
    try {
      const remainingCardCounts = deriveCurrentCardCounts(player, state);
      mainThreadOperations.push(this.recordMainThreadOperation(
        "Controller.selectAction:remaining-counts",
        operationStartedAt
      ));
      preparationOperation = "create-world";
      operationStartedAt = decisionNow();
      const world = createInitialWorld(player.id, state, remainingCardCounts);
      mainThreadOperations.push(this.recordMainThreadOperation(
        "Controller.selectAction:create-world",
        operationStartedAt
      ));
      preparationOperation = "root-candidates";
      operationStartedAt = decisionNow();
      rootActions = this.getActionCandidates(player, world);
      mainThreadOperations.push(this.recordMainThreadOperation(
        "Controller.selectAction:root-candidates",
        operationStartedAt,
        { candidateCount:rootActions.length }
      ));
      preparationOperation = "root-deduplication";
      uniqueRootCount = deduplicateSearchEquivalentActions(rootActions).length;
      preparationOperation = "create-search-request";
      requestId = this.createId("search-request");
      request = createSearchRequest({
        requestId,
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
      preWorkerFinishedAt = decisionNow();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const searchFault = {
        stage:"PREPARATION",
        operation:preparationOperation,
        name:error instanceof Error ? error.name : "Error",
        message:errorMessage
      };
      const result = createSearchResult({
        request:{
          requestId:typeof requestId === "string" && requestId ? requestId : null,
          gameId:state.gameId,
          stateVersion:state.stateVersion,
          actorId:player.id
        },
        action:null,
        stats:null,
        status:SEARCH_RESULT_STATUS.PREPARATION_FAILURE,
        rejectionReason:errorMessage,
        searchFault,
        rngAfter:null
      });
      const failedAt = decisionNow();
      this.lastSearchRequest = null;
      this.lastWorkerOutcome = null;
      this.lastSearchStats = null;
      this.lastSearchResult = result;
      this.lastDecisionDiagnostics = Object.freeze({
        requestId:result.requestId,
        stage:"PREPARATION",
        preWorkerMs:Math.max(0, failedAt - preWorkerStartedAt),
        workerSearchMs:null,
        workerRoundTripMs:null,
        workerTransportMs:null,
        postMessageMs:null,
        postWorkerMs:null,
        physicalRootCount:Array.isArray(rootActions) ? rootActions.length : null,
        uniqueRootCount,
        preWorkerProbabilityPreparations:"unavailable",
        preWorkerConditionBranches:"unavailable",
        mainThreadOperations:Object.freeze([...mainThreadOperations]),
        searchStopReason:null,
        resultStatus:result.status
      });
      return null;
    }
    const workerRoundTripStartedAt = preWorkerFinishedAt;
    let outcome;
    try {
      outcome = await this.searchExecutor.search(request, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const cancelled = /\bcancell?ed\b/iu.test(errorMessage);
      outcome = createWorkerSearchOutcome({ request,
        action:null,
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
  inAttackRange、chooseDiscardCandidates。

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
    const cards = chooseDiscardCandidates(
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
      "Evaluator.chooseDiscardCandidates",
      startedAt,
      { candidateCount:player?.hand?.length }
    );
    return cards;
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
  观察者合法记忆与随机源。

  写入状态
  随机源序列。

  调用函数
  Evaluator card comparison 与 search RNG。

  边界与不变量
  canonical Action 已拥有 Transfer/Destroy/Plunder 选择；本入口只处理独立隐藏选择，不得重跑这些战略决策。
  */
  chooseHiddenCards(
    actor,
    owner,
    count,
    excludedCardIds = null,
    context = null
  ) {
    const startedAt = decisionNow();
    const candidates = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    const candidateCount = candidates.length;
    const purpose = context?.purpose ?? null;
    const selected = [];
    const known = actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {};
    while (selected.length < count && candidates.length) {
      let selectedId = null;
      if (actor.id === owner.id) {
        selectedId = chooseLowestRoleCardId(actor, candidates);
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
      "Controller.resolveHiddenCards",
      startedAt,
      { candidateCount:owner?.hand?.length ?? "unavailable" }
    );
    return selected;
  }

  /*
  功能
  把 canonical hidden-card selection 绑定到当前真实手牌实体。

  调用方
  HiddenCardChoiceWorkflow 的 AI canonical selection 路径。

  输入
  资源拥有者、known/unknown/peek selection、数量与可选排除实体 ID。

  输出
  仍位于手牌且符合选择位置的真实 Card 数组。

  读取状态
  当前真实手牌位置与 search RNG。

  写入状态
  unknown 或 peek anonymous remainder 绑定时推进 RNG；不修改 GameState。

  调用函数
  Rng.next。

  边界与不变量
  不生成、模拟、评价或重新选择战略候选；known/peek cardIds 只按 ID 精确绑定，
  anonymous remainder 只在 canonical knownCardIds 排除后按 seeded 位置绑定，且不读取候选 definitionId。
  */
  bindCanonicalHiddenCards(owner, selection, count = 1, excludedCardIds = null) {
    const eligible = owner.hand.filter((card) => !excludedCardIds?.has(card.id));
    if (selection?.selectionKind === "known" && selection.cardId) {
      const card = eligible.find((entry) => entry.id === selection.cardId) ?? null;
      return card ? [card] : [];
    }
    if (selection?.selectionKind === "peek") {
      const selected = (selection.cardIds ?? []).map((cardId) => (
        eligible.find((entry) => entry.id === cardId) ?? null
      )).filter(Boolean);
      if (selected.length !== (selection.cardIds?.length ?? 0)
        || new Set(selected.map((card) => card.id)).size !== selected.length) return [];
      const selectedIds = new Set(selected.map((card) => card.id));
      const knownCardIds = new Set(selection.knownCardIds ?? []);
      const anonymous = eligible.filter((card) => (
        !selectedIds.has(card.id) && !knownCardIds.has(card.id)
      ));
      const unknownCount = Math.max(0, Math.floor(Number(selection.unknownCount) || 0));
      const expectedCount = Math.min(count, selected.length + unknownCount);
      while (selected.length < expectedCount && anonymous.length) {
        const index = Math.floor(this.searchRng.next() * anonymous.length);
        selected.push(anonymous.splice(index, 1)[0]);
      }
      return selected.length === expectedCount ? selected : [];
    }
    if (selection?.selectionKind !== "unknown") return [];
    const knownCardIds = new Set(selection.knownCardIds ?? []);
    const anonymous = eligible.filter((card) => !knownCardIds.has(card.id));
    const selected = [];
    while (selected.length < count && anonymous.length) {
      const index = Math.floor(this.searchRng.next() * anonymous.length);
      selected.push(anonymous.splice(index, 1)[0]);
    }
    return selected;
  }

  /*
  功能
  从公开牌池选择对当前角色真实状态边际最高的牌。

  调用方
  PublicCardPoolWorkflow。

  输入
  当前 Player 与公开实体牌数组。

  输出
  被选实体牌；空牌池时为 null。

  读取状态
  当前 GameState、接收者公开状态、装备槽与公开候选实体。

  写入状态
  无。

  调用函数
  createInitialWorld、Simulator.resolvePublicCardChoice。

  边界与不变量
  Controller 只组装 canonical before World 并请求 resolved choice；Simulator 唯一构造候选状态，Evaluator 唯一比较价值；
  门面不改变同分时的原始顺序，也不写真实 GameState。
  */
  choosePublicCard(player, cards) {
    const startedAt = decisionNow();
    const state = this.getState();
    const world = createInitialWorld(
      player.id,
      state,
      deriveCurrentCardCounts(player, state)
    );
    const cardId = this.simulatorFactory().resolvePublicCardChoice(
      world,
      player.id,
      cards
    );
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
  createInitialWorld、Simulator paired-world construction 与 Evaluator data/value helpers。

  边界与不变量
  Controller 只负责 runtime entity/context binding；所有价值比较由同一 Evaluator 完成，所需 Worlds/标量按响应类型预物化且每分支至多一次。
  */
  buildResponseDecisionContext(responder, type, rawContext, cards = []) {
    const state = this.getState();
    const remainingCardCounts = deriveCurrentCardCounts(responder, state);
    const world = createInitialWorld(responder.id, state, remainingCardCounts);
    const players = world.players;
    const byId = new Map(players.map((player) => [player.id, player]));
    const responderView = byId.get(responder.id);
    const rawCard = rawContext.card ?? null;
    const rawRootCard = rawContext.rootCard ?? null;
    const rawEquipment = rawContext.equipment ?? null;
    const publicContext = {
      target:byId.get(rawContext.target?.id) ?? null,
      source:byId.get(rawContext.source?.id) ?? null,
      rootSource:byId.get(rawContext.rootSource?.id) ?? null,
      amount:Math.max(0, Number(rawContext.amount) || 0),
      requiredCount:Math.max(1, Math.floor(Number(rawContext.requiredCount) || 1)),
      counterDepth:Math.max(0, Math.floor(Number(rawContext.counterDepth) || 0)),
      rootSourceId:rawContext.rootSourceId ?? rawContext.rootSource?.id ?? null,
      rootTargetIds:Object.freeze([...(rawContext.rootTargetIds ?? [])]),
      publicTransferContext:rawContext.publicTransferContext
        ? Object.freeze({
            fromPlayerId:rawContext.publicTransferContext.fromPlayerId ?? null,
            receiverPlayerId:rawContext.publicTransferContext.receiverPlayerId ?? null,
            zone:rawContext.publicTransferContext.zone ?? "hand"
          })
        : null,
      publicSelectionContext:rawContext.publicSelectionContext
        ? Object.freeze({
            ownerPlayerId:rawContext.publicSelectionContext.ownerPlayerId ?? null,
            zone:rawContext.publicSelectionContext.zone ?? null,
            selectedCount:Math.max(
              0,
              Math.floor(Number(rawContext.publicSelectionContext.selectedCount) || 0)
            )
          })
        : null,
      card:rawCard ? Object.freeze({
        definitionId:rawCard.definitionId ?? null,
        category:rawCard.category ?? null,
        counterable:rawCard.counterable !== false,
        counterScope:rawCard.counterScope ?? null
      }) : null,
      rootCard:rawRootCard ? Object.freeze({
        definitionId:rawRootCard.definitionId ?? null,
        category:rawRootCard.category ?? null,
        counterable:rawRootCard.counterable !== false,
        counterScope:rawRootCard.counterScope ?? null
      }) : null,
      equipment:rawEquipment ? Object.freeze({
        definitionId:rawEquipment.definitionId ?? null
      }) : null,
      statusCounterContext:rawContext.statusCounterContext
        ? Object.freeze({
            holderId:rawContext.statusCounterContext.holderId ?? null,
            statusId:rawContext.statusCounterContext.statusId ?? null
          })
        : null
    };
    const rescueOrder = type === "dyingRescue"
      ? this.getDyingRescueOrder(rawContext.target ?? responder)
          .map((player) => byId.get(player.id))
          .filter(Boolean)
      : [];
    const decision = {
      responder:responderView,
      responseType:type,
      context:Object.freeze(publicContext),
      availableResponseCount:Array.isArray(cards) ? cards.length : 0,
      players,
      rescueOrder,
      responderHandDefinitionIds:(responderView?.hand ?? []).map((card) => card.definitionId),
      knownCardsByPlayer:Object.fromEntries(players.map((player) => [
        player.id,
        Object.fromEntries((player.knownCards ?? []).map((card) => [
          card.cardId,
          card.definitionId
        ]))
      ])),
      remainingCardCounts,
      isSmallTeam:this.isSmallTeam(responder),
      forceAiRescueHuman:this.forceAiRescueHuman,
      world,
      leverageMetrics:null,
      guardianAidWorlds:null,
      lightningCounterWorlds:null,
      sealCounterTerms:null,
      rootFlipWorlds:null,
      counterSelection:null
    };
    if (type === "leverageAssault") {
      const target = publicContext.target ?? responderView;
      decision.leverageMetrics = this.evaluator.leverageResponseMetrics(
        target,
        remainingCardCounts
      );
    } else if (type === "skill" && publicContext.target) {
      const simulator = this.simulatorFactory();
      const worlds = simulator.buildGuardianAidWorlds(
          world,
          responder.id,
          publicContext.target.id,
          rawContext.source?.id ?? null,
          Math.max(0, Number(rawContext.amount) || 0)
        );
      decision.guardianAidWorlds = {
        stayWorld:worlds.stayWorld,
        aidWorld:worlds.aidWorld,
        stayLightningOutcomeSets:simulator.buildLightningOutcomeSets(worlds.stayWorld),
        aidLightningOutcomeSets:simulator.buildLightningOutcomeSets(worlds.aidWorld)
      };
    } else if (type === "counter" && publicContext.statusCounterContext) {
      const holder = players.find((player) => (
        player.id === publicContext.statusCounterContext.holderId && player.alive
      ));
      if (holder && holder.battleTeam === responderView.battleTeam
        && hasFactStatus(holder, publicContext.statusCounterContext.statusId)) {
        if (publicContext.statusCounterContext.statusId === "sealed") {
          decision.sealCounterTerms = this.evaluator.sealCounterTerms(
            holder,
            world,
            remainingCardCounts
          );
        } else if (publicContext.statusCounterContext.statusId === "lightning") {
          const simulator = this.simulatorFactory();
          const receiverId = simulator.nextLightningReceiverId(players, holder);
          const receiver = players.find((player) => player.id === receiverId) ?? null;
          const transferred = receiver
            ? simulator.buildTransferredLightningWorld(world, holder, receiver)
            : null;
          decision.lightningCounterWorlds = {
            stayOutcomeSet:simulator.buildLightningOutcomeWorlds(
              world,
              holder
            ),
            transferredWorld:transferred?.world ?? null,
            transferredOutcomeSet:transferred
              ? simulator.buildLightningOutcomeWorlds(transferred.world, transferred.holder, 1)
              : null
          };
        }
      }
    } else if (type === "counter") {
      const rootCard = rawRootCard ?? rawCard;
      const rootSourceId = rawContext.rootSourceId
        ?? rawContext.rootSource?.id
        ?? rawContext.source?.id
        ?? null;
      const rootAction = this.actionGenerator.createRootResolutionAction(
        world,
        rootCard,
        rootSourceId,
        Array.isArray(rawContext.rootTargetIds) ? rawContext.rootTargetIds : [],
        {
          selection:rawContext.selection ?? null,
          publicTransferContext:publicContext.publicTransferContext,
          publicSelectionContext:publicContext.publicSelectionContext
        }
      );
      if (rootAction) {
        decision.counterSelection = rootAction.selection;
        const simulator = this.simulatorFactory();
        const worlds = simulator.buildRootFlipWorlds(
          world,
          rootAction,
          rawContext.counterDepth ?? 0
        );
        if (worlds) {
          decision.rootFlipWorlds = {
            ...worlds,
            baseLightningOutcomeSets:simulator.buildLightningOutcomeSets(worlds.baseWorld),
            resolvedLightningOutcomeSets:simulator.buildLightningOutcomeSets(worlds.resolvedWorld)
          };
        }
      }
    }
    return decision;
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
    const decision = this.evaluator.shouldRespond(
      this.buildResponseDecisionContext(player, type, context, cards)
    );
    this.recordMainThreadOperation(
      "Controller.shouldRespond",
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
  Controller 只返回 data-only assessment；不得让 Application 直接访问 Evaluator 内部 owner。
  */
  assessDyingRescue(responder, target) {
    const startedAt = decisionNow();
    const decision = this.buildResponseDecisionContext(
      responder,
      "dyingRescue",
      { target },
      []
    );
    const assessment = this.evaluator.assessDyingRescue({
      responder:decision.responder,
      target:decision.context.target,
      rescueOrder:decision.rescueOrder,
      responderHandDefinitionIds:decision.responderHandDefinitionIds,
      knownCardsByPlayer:decision.knownCardsByPlayer,
      recoverDensity:decision.recoverDensity,
      remainingCardCounts:decision.remainingCardCounts
    });
    this.recordMainThreadOperation(
      "Controller.assessDyingRescue",
      startedAt,
      { candidateCount:this.getState()?.players?.length }
    );
    return assessment;
  }

}
