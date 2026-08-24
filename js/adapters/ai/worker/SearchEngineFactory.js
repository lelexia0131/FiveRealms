/*
模块职责
从 Worker 边界消息构造唯一 Worker-safe Searcher composition，不读取 Game/Application/main-thread mutable state。

上游
WorkerSearchRuntime 与纯 search composition 测试。

下游
AI value/policy/simulation/search modules 与 Domain Definitions/Rules。

状态边界
只读 request.world 与 request.searchConfig；Searcher/Simulator 只写 Worker 本地状态。

信息边界
只消费 SearchRequest 已携带的合法 Fact 与当前 Probability 状态。

架构约束
不得 import composition、application、UI/Audio/DOM 或 Domain transitions；不得使用 Math.random。
*/
import { getMaxEnergy, getTurnEnergyBreakdown } from "../../../domain/rules/team/TeamRules.js";
import { sampleProbabilityWorlds } from "../../../ai/state/Probability/Probability.js";
import { Evaluator } from "../../../ai/value/Evaluator.js";
import { assessGlobalBenefit } from "../../../ai/value/GlobalBenefitValue.js";
import { ResponsePolicy } from "../../../ai/policy/ResponsePolicy.js";
import { StateValue } from "../../../ai/value/StateValue.js";
import { ValueLedger } from "../../../ai/value/ValueLedger.js";
import { ValueSimulationQuery } from "../../../ai/simulation/ValueSimulationQuery.js";
import { Simulator } from "../../../ai/simulation/Simulator.js";
import {
  ActionGenerator,
  deduplicateSearchEquivalentActions
} from "../../../ai/search/ActionGenerator.js";
import { CounterfactualTerms } from "../../../ai/search/CounterfactualTerms.js";
import { Pattern } from "../../../ai/Searcher/Pattern/Pattern.js";
import { Searcher } from "../../../ai/search/Searcher.js";
import { SearchBudget } from "../../../ai/search/SearchBudget.js";
import { SearchPrior } from "../../../ai/search/SearchPrior.js";
import { tacticResolutionScale } from "../../../ai/search/TacticResolutionQuery.js";
import { SearchRng } from "../../../ai/search/SearchRng.js";

/*
功能
从 SearchRequest 构造完整 search engine。

调用方
WorkerSearchRuntime.runSearchRequest。

输入
SearchRequest、SearchRng 与 runtimeControl（yield/now）。

输出
{ searcher, rng }。

读取状态
request.world/searchConfig。

写入状态
无；Searcher 执行时才写其内部诊断。

调用函数
Domain TeamRules、value/policy/search/simulation 模块。

边界与不变量
所有随机来自注入 rng；SearchBudget/Searcher 只消费 request.searchConfig；不缓存跨请求服务。
*/
export function createSearchEngine(request, rng, runtimeControl = {}) {
  const rootWorld = request.world;
  const config = request.searchConfig;
  /*
  功能
  从 World 投影计算玩家 max energy。

  调用方
  createSearchEngine 构造 Evaluator。

  输入
  World player。

  输出
  非负整数。

  读取状态
  World players 与 Domain TeamRules。

  写入状态
  无。

  调用函数
  getMaxEnergy。

  边界与不变量
  不读取 Game/real Player；公式只由 Domain TeamRules 解释。
  */
  const getMaxEnergyForPlayer = (player) => getMaxEnergy(
    { players:rootWorld.players },
    player
  );
  /*
  功能
  从 World 投影计算玩家回合能量 breakdown。

  调用方
  createSearchEngine 构造 Evaluator。

  输入
  World player。

  输出
  Domain TeamRules breakdown。

  读取状态
  World players 与 Domain TeamRules。

  写入状态
  无。

  调用函数
  getTurnEnergyBreakdown。

  边界与不变量
  不读取 Game/real Player；公式只由 Domain TeamRules 解释。
  */
  const getTurnEnergyBreakdownForPlayer = (player) => getTurnEnergyBreakdown(
    { players:rootWorld.players },
    player
  );
  const stateEvaluator = new Evaluator({
    getMaxEnergy:getMaxEnergyForPlayer,
    getTurnEnergyBreakdown:getTurnEnergyBreakdownForPlayer,
    getDifficultyMultiplier:() => config.difficultyMultiplier
  });
  const responsePolicy = new ResponsePolicy({ assessGlobalBenefit });
  /*
  功能
  为 Worker search runtime 创建共享资源决策语义的独立 Simulator。

  调用方
  ValueSimulationQuery 与 Searcher。

  输入
  当前查询或搜索节点的 World，以及可选搜索工作诊断上下文。

  输出
  注入搜索预算上下文的 Simulator。

  读取状态
  当前 search engine 的搜索预算上下文。

  写入状态
  无。

  调用函数
  Simulator 构造函数。

  边界与不变量
  不得依赖 main-thread 对象；Worker 不构造未被搜索消费的资源选择查询。
  */
  const simulatorFactory = (state, runtime = {}) => new Simulator(state, {
    searchBudget:runtime.searchBudget ?? null,
    decideCounter:(...args) => responsePolicy.decidePlanningCounter(...args),
    decideLeverageAssault:(...args) => responsePolicy.decideLeverageAssault(...args)
  });
  const valueSimulationQuery = new ValueSimulationQuery(
    stateEvaluator,
    simulatorFactory
  );
  const stateValue = new StateValue(stateEvaluator, valueSimulationQuery);
  const valueLedger = new ValueLedger({
    evaluator:stateEvaluator,
    stateValue,
    simulationQuery:valueSimulationQuery
  });
  const searchPrior = new SearchPrior({
    evaluator:stateEvaluator,
    simulationQuery:valueSimulationQuery
  });
  const actionGenerator = new ActionGenerator();
  const counterfactualTerms = new CounterfactualTerms({
    evaluator:stateValue,
    generateActions: (...args) => actionGenerator.generate(...args),
    sampleUnknownHands: (query) => sampleProbabilityWorlds({
      ...query,
      random:() => rng.next()
    }),
    hiddenSampleCount:config.hiddenSamples
  });
  const patternMatcher = new Pattern();
  const searcher = new Searcher({
    evaluator:stateEvaluator,
    stateValue,
    valueLedger,
    searchPrior,
    counterfactualTerms,
    patternMatcher,
    getResolutionScale:tacticResolutionScale,
    config,
    simulatorFactory,
    searchBudgetFactory: () => new SearchBudget({
      timeBudget:config.timeBudgetMs,
      nodeBudget:config.nodeBudget,
      now:typeof runtimeControl.now === "function" ? runtimeControl.now : null
    }),
    deduplicateActions:deduplicateSearchEquivalentActions,
    generateActions: (...args) => actionGenerator.generate(...args),
    yieldControl: typeof runtimeControl.yieldControl === "function"
      ? runtimeControl.yieldControl
      : async () => true
  });
  return { searcher, rng };
}
