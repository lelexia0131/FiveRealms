/*
模块职责
对 Destroy/Plunder 的有限资源候选执行强制 after-state 模拟并生成统一上下文价值。

上游
CardSelectionBoundary、CardEffectSimulation 与 AI composition roots。

下游
value/Economics、注入的 StateValue、纯 Evaluator equipment material primitive 与 Simulator factory。

状态边界
只写 Simulator 创建的独立 SearchState 克隆，不修改输入或真实 GameState。

信息边界
候选只含公开装备、合法 known identity 或匿名槽；query 不读取未知实体定义。

架构约束
不生成 Planner action、不决定候选胜负；强制 mutation 不得重新进入 ResourceSelectionPolicy。
*/
import { PROBABILITY_EPSILON } from "../state/Probability.js";
import { RESOURCE_MATERIAL_SCALE } from "../value/Economics.js";

export class ResourceValueQuery {
  /*
  功能
  绑定资源反事实所需的唯一状态价值、装备材料分解与 Simulator 工厂。

  调用方
  AIController 与 Worker SearchEngineFactory 组合根。

  输入
  stateValue、evaluator 与 simulatorFactory。

  输出
  可复用的有界 ResourceValueQuery。

  读取状态
  保存显式窄依赖。

  写入状态
  写实例依赖字段。

  调用函数
  无。

  边界与不变量
  simulatorFactory 创建的实例必须提供 clone 与 applyForcedResourceSelection；query 不持有 Planner/Policy/Game。
  */
  constructor({ stateValue, evaluator, simulatorFactory } = {}) {
    if (!stateValue || typeof stateValue.stateUtility !== "function") {
      throw new TypeError("ResourceValueQuery 缺少依赖：stateValue");
    }
    if (!evaluator || typeof evaluator.equipmentMaterialDelta !== "function") {
      throw new TypeError("ResourceValueQuery 缺少依赖：evaluator");
    }
    if (typeof simulatorFactory !== "function") {
      throw new TypeError("ResourceValueQuery 缺少依赖：simulatorFactory");
    }
    this.stateValue = stateValue;
    this.evaluator = evaluator;
    this.simulatorFactory = simulatorFactory;
  }

  /*
  功能
  为同一资源决策的每个候选生成强制 after-state 与可比较的上下文收益。

  调用方
  CardSelectionBoundary 与 CardEffectSimulation。

  输入
  SearchState、actor/target ID、purpose、已合法整理的候选数组与可选父 SearchBudget。

  输出
  附加 raw/contextual/acquisition/skill-threshold Policy 点数分项的新候选数组。

  读取状态
  StateValue、装备材料分解和候选公开/合法身份。

  写入状态
  仅写每个候选独立 clone；不写输入状态。

  调用函数
  SearchBudget checkpoint、Simulator.clone/applyForcedResourceSelection、
  StateValue.stateUtility、Evaluator.equipmentMaterialDelta。

  边界与不变量
  父搜索存在时，nested Simulator 与 State Value 查询必须继承同一个 SearchBudget；
  每个候选恰好一次强制 mutation；State Value 与装备材料、CardValue 派生项均保持
  既有 Policy state points，不在查询出口往返换算；技能门槛项只参与资源候选排序，
  不是概率、State/Final Utility 或单位换算；不会递归选择资源。
  */
  evaluate({ state, actorId, targetId, purpose, candidates, searchBudget = null }) {
    if (!Array.isArray(state?.players) || !Array.isArray(candidates) || !candidates.length) {
      return [];
    }
    searchBudget?.checkpointCurrentWork?.();
    const baseline = this.stateValue.stateUtility(state, actorId, searchBudget);
    const simulator = this.simulatorFactory(state, { searchBudget });
    const evaluated = [];
    for (const candidate of candidates) {
      searchBudget?.checkpointCurrentWork?.();
      const after = simulator.clone(state);
      const actor = after.players.find((player) => player.id === actorId);
      const target = after.players.find((player) => player.id === targetId);
      const applied = simulator.applyForcedResourceSelection(
        after, actor, target, purpose, candidate
      );
      if (applied <= PROBABILITY_EPSILON) {
        evaluated.push({ ...candidate, contextualUtility: -Infinity, appliedProbability: 0 });
        continue;
      }
      const rawStateDelta = this.stateValue.stateUtility(after, actorId, searchBudget) - baseline;
      const equipmentMaterialDelta = this.evaluator.equipmentMaterialDelta(
        state, after, actorId
      );
      const contextualStateDelta = rawStateDelta - equipmentMaterialDelta;
      const acquisitionMaterial = purpose === "plunder"
        ? candidate.acquisitionUtility * RESOURCE_MATERIAL_SCALE * applied
        : 0;
      const skillThresholdOption = (Number(candidate.skillThresholdOption) || 0) * applied;
      evaluated.push({
        ...candidate,
        appliedProbability: applied,
        rawStateDelta,
        equipmentMaterialDelta,
        contextualStateDelta,
        acquisitionMaterial,
        skillThresholdOption,
        contextualUtility: contextualStateDelta + acquisitionMaterial + skillThresholdOption
      });
    }
    return evaluated;
  }
}
