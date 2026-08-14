/*
模块职责
把上游闪电 simulation query 的纯数值结果送入正式 value/Evaluator。

上游
AIController、TransitionValue、ValueLedger、响应策略与兼容 façade。

下游
value/Evaluator 与 AiValueSimulationQuery。

状态边界
只读过滤后的状态；不持有 Game，不写状态。

信息边界
只接受 VisibleState/SearchState，不访问未过滤的真实手牌。

架构约束
本适配器不拥有 State Value 公式；stateUtility 公式只存在于 value/Evaluator。
*/

export class AiStateValue {
  /*
  功能
  绑定纯 Evaluator 与闪电查询能力。

  调用方
  AIController composition root。

  输入
  value/Evaluator 与 AiValueSimulationQuery 实例。

  输出
  稳定的运行时 State Value 门面。

  读取状态
  保存显式依赖引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Planner 或 Controller。
  */
  constructor(evaluator, simulationQuery) {
    this.evaluator = evaluator;
    this.simulationQuery = simulationQuery;
  }

  /*
  功能
  计算包含闪电生命周期项的完整 State Value。

  调用方
  TransitionValue、ValueLedger、Search/Policy 兼容入口与测试。

  输入
  过滤后的状态与 viewer ID。

  输出
  value/Evaluator 返回的团队 State Value。

  读取状态
  只读传入状态；闪电查询只使用 SearchState 克隆与缓存。

  写入状态
  无。

  调用函数
  AiValueSimulationQuery.lightningValues、Evaluator.stateUtility。

  边界与不变量
  模拟结果先物化为纯值再交给 Evaluator；本层不复制任何估值公式。
  */
  stateUtility(state, viewerId) {
    const lightningValues = this.simulationQuery.lightningValues(state, viewerId);
    return this.evaluator.stateUtility(state, viewerId, lightningValues);
  }
}
