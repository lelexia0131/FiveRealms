/*
模块职责
从 data-only SearchRequest 构造完整 Worker-safe AI search engine（Value/Policy/DeepGenerator/Planner），不读取 Game/Application/main-thread mutable state。

上游
WorkerSearchRuntime 与纯 search composition 测试。

下游
AI value/policy/simulation/search modules 与 Domain Definitions/Rules。

状态边界
只读 request.searchState 与 request.searchConfig；Planner/Simulator 只写 Worker 本地状态。

信息边界
只消费 SearchRequest 已携带的合法 Visible/Knowledge/Belief 事实。

架构约束
不得 import composition、application、UI/Audio/DOM 或 Domain transitions；不得使用 Math.random。
*/
import { getMaxEnergy, getTurnEnergyBreakdown } from "../../../domain/rules/team/TeamRules.js?build=20260818-skill-rules-locality-refactor";
import { sampleHiddenWorlds } from "../../../ai/state/BeliefState.js?build=20260818-skill-rules-locality-refactor";
import { Evaluator } from "../../../ai/value/Evaluator.js?build=20260818-skill-rules-locality-refactor";
import { StateValue } from "../../../ai/value/StateValue.js?build=20260818-skill-rules-locality-refactor";
import { ValueLedger } from "../../../ai/value/ValueLedger.js?build=20260818-skill-rules-locality-refactor";
import { ValueService } from "../../../ai/value/ValueService.js?build=20260818-skill-rules-locality-refactor";
import { ValueSimulationQuery } from "../../../ai/simulation/ValueSimulationQuery.js?build=20260818-skill-rules-locality-refactor";
import { Simulator } from "../../../ai/simulation/Simulator.js?build=20260818-skill-rules-locality-refactor";
import { ActionCandidatePolicy } from "../../../ai/policy/ActionCandidatePolicy.js?build=20260818-skill-rules-locality-refactor";
import { TransferPolicy } from "../../../ai/policy/TransferPolicy.js?build=20260818-skill-rules-locality-refactor";
import { ActionGenerator } from "../../../ai/search/ActionGenerator.js?build=20260818-skill-rules-locality-refactor";
import { CandidateMaterializer } from "../../../ai/search/CandidateMaterializer.js?build=20260818-skill-rules-locality-refactor";
import { CounterfactualTerms } from "../../../ai/search/CounterfactualTerms.js?build=20260818-skill-rules-locality-refactor";
import { FrontierValue } from "../../../ai/search/FrontierValue.js?build=20260818-skill-rules-locality-refactor";
import { Planner } from "../../../ai/search/Planner.js?build=20260818-skill-rules-locality-refactor";
import { SearchBudget } from "../../../ai/search/SearchBudget.js?build=20260818-skill-rules-locality-refactor";
import { SearchPolicy } from "../../../ai/search/SearchPolicy.js?build=20260818-skill-rules-locality-refactor";
import { SearchPrior } from "../../../ai/search/SearchPrior.js?build=20260818-skill-rules-locality-refactor";
import { SiblingTransitionTerms } from "../../../ai/search/SiblingTransitionTerms.js?build=20260818-skill-rules-locality-refactor";
import { tacticResolutionScale } from "../../../ai/search/TacticResolutionQuery.js?build=20260818-skill-rules-locality-refactor";
import { TransitionValue } from "../../../ai/search/TransitionValue.js?build=20260818-skill-rules-locality-refactor";
import { ActionDescriptor } from "../../../ai/search/ActionDescriptor.js?build=20260818-skill-rules-locality-refactor";
import { SearchRng } from "../../../ai/search/SearchRng.js?build=20260818-skill-rules-locality-refactor";

/*
功能
构造 Worker-safe deep action generator。

调用方
createSearchEngine。

输入
transfer/action candidate policies。

输出
deep-only ActionGenerator。

读取状态
无。

写入状态
无。

调用函数
ActionGenerator 构造函数。

边界与不变量
不注入 getRootContext/chooseTransferCombination；root generate 调用会 fail fast。
*/
function createDeepActionGenerator(transferPolicy, actionCandidatePolicy) {
  return new ActionGenerator({
    transferPolicy,
    actionCandidatePolicy
  });
}

/*
功能
从 SearchRequest 构造完整 search engine。

调用方
WorkerSearchRuntime.runSearchRequest。

输入
SearchRequest、SearchRng 与 runtimeControl（yield/now）。

输出
{ planner, searchPolicy, rng }。

读取状态
request.searchState/searchConfig。

写入状态
无；Planner 执行时才写其内部诊断。

调用函数
Domain TeamRules、value/policy/search/simulation 模块。

边界与不变量
所有随机来自注入 rng；SearchBudget/SearchPolicy 只消费 request.searchConfig；不缓存跨请求服务。
*/
export function createSearchEngine(request, rng, runtimeControl = {}) {
  const searchState = request.searchState;
  const config = request.searchConfig;
  /*
  功能
  从 SearchState 投影计算玩家 max energy。

  调用方
  createSearchEngine 构造 Evaluator。

  输入
  SearchState player。

  输出
  非负整数。

  读取状态
  SearchState players 与 Domain TeamRules。

  写入状态
  无。

  调用函数
  getMaxEnergy。

  边界与不变量
  不读取 Game/real Player；公式只由 Domain TeamRules 解释。
  */
  const getMaxEnergyForPlayer = (player) => getMaxEnergy(
    { players:searchState.players },
    player
  );
  /*
  功能
  从 SearchState 投影计算玩家回合能量 breakdown。

  调用方
  createSearchEngine 构造 Evaluator。

  输入
  SearchState player。

  输出
  Domain TeamRules breakdown。

  读取状态
  SearchState players 与 Domain TeamRules。

  写入状态
  无。

  调用函数
  getTurnEnergyBreakdown。

  边界与不变量
  不读取 Game/real Player；公式只由 Domain TeamRules 解释。
  */
  const getTurnEnergyBreakdownForPlayer = (player) => getTurnEnergyBreakdown(
    { players:searchState.players },
    player
  );
  const stateEvaluator = new Evaluator({
    getMaxEnergy:getMaxEnergyForPlayer,
    getTurnEnergyBreakdown:getTurnEnergyBreakdownForPlayer
  });
  const valueSimulationQuery = new ValueSimulationQuery(stateEvaluator);
  const stateValue = new StateValue(stateEvaluator, valueSimulationQuery);
  const valueLedger = new ValueLedger({
    evaluator:stateEvaluator,
    stateValue,
    simulationQuery:valueSimulationQuery
  });
  const frontierValue = new FrontierValue();
  const searchPrior = new SearchPrior({
    getDifficultyMultiplier: () => config.difficultyMultiplier,
    simulationQuery:valueSimulationQuery
  });
  const transitionValue = new TransitionValue(stateValue);
  const evaluator = new ValueService({
    evaluator:stateEvaluator,
    stateValue,
    simulationQuery:valueSimulationQuery,
    valueLedger,
    frontierValue,
    searchPrior,
    transitionValue
  });
  const transferPolicy = new TransferPolicy();
  const actionCandidatePolicy = new ActionCandidatePolicy();
  const actionGenerator = createDeepActionGenerator(transferPolicy, actionCandidatePolicy);
  const searchPolicy = new SearchPolicy({
    random: () => rng.next(),
    getRandomnessRange: () => config.randomnessRange,
    config
  });
  const counterfactualTerms = new CounterfactualTerms({
    evaluator,
    generateFromVisible: (...args) => actionGenerator.generateFromVisible(...args),
    sampleHiddenWorlds: (viewer, state, count) => sampleHiddenWorlds(
      viewer, state, count, () => rng.next()
    ),
    hiddenSampleCount:searchPolicy.structure().hiddenSamples
  });
  const siblingTransitionTerms = new SiblingTransitionTerms();
  const candidateMaterializer = new CandidateMaterializer({
    transitionValue,
    valueLedger,
    frontierValue,
    searchPrior,
    counterfactualTerms,
    siblingTerms:siblingTransitionTerms,
    actionDescriptor:ActionDescriptor,
    getResolutionScale:tacticResolutionScale
  });
  const planner = new Planner({
    candidateMaterializer,
    searchPolicy,
    simulatorFactory: (state) => new Simulator(state),
    searchBudgetFactory: () => new SearchBudget({
      timeBudget:config.timeBudgetMs,
      nodeBudget:config.nodeBudget,
      now:typeof runtimeControl.now === "function" ? runtimeControl.now : null
    }),
    generateFromVisible: (...args) => actionGenerator.generateFromVisible(...args),
    yieldControl: typeof runtimeControl.yieldControl === "function"
      ? runtimeControl.yieldControl
      : async () => true
  });
  return { planner, searchPolicy, rng };
}
