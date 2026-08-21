/*
模块职责
唯一把动作前状态、动作与动作后状态组合为 Transition Value（一次动作带来的最终搜索价值）。

上游
Planner 与价值等价测试。

下游
运行时 State Value 与 value/Economics 的既定流量项。

状态边界
只读 before/after SearchState；不写状态、不生成或执行动作。

信息边界
只使用过滤后的状态、显式行动者/观察者，以及调用层提供的概率、领域和前沿数值。

架构约束
不读取 Game/Controller，不搜索、不决定束裁剪或同分裁决，也绝不消费仅用于剪枝的 SearchPrior。
*/
import {
  STATE_DELTA_SCALE,
  actionEconomicValue
} from "../value/Economics.js";

export class TransitionValue {
  /*
  功能
  绑定 State Value 的唯一运行时入口。

  调用方
  AIController 组合根（统一组装依赖的位置） 与直接测试。

  输入
  提供 stateUtility(state, viewerId) 的显式依赖。

  输出
  Final Transition Value 服务实例。

  读取状态
  保存 stateValue 引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Planner、Controller、ActionGenerator 或 SearchPrior。
  */
  constructor(stateValue) {
    this.stateValue = stateValue;
  }

  /*
  功能
  计算 before 到 after 的唯一 state delta。

  调用方
  evaluateBase 与逐 term 等价测试。

  输入
  beforeState、afterState 与 viewer ID。

  输出
  after state value 减 before state value 的未缩放差值。

  读取状态
  只读两个过滤后的 SearchState。

  写入状态
  无。

  调用函数
  stateValue.stateUtility。

  边界与不变量
  运算顺序固定为 after 减 before；Planner 与其他生产模块不得再次实现该公式。
  */
  stateDelta(beforeState, afterState, viewerId) {
    return this.stateValue.stateUtility(afterState, viewerId)
      - this.stateValue.stateUtility(beforeState, viewerId);
  }

  /*
  功能
  计算一次候选的经济项、state delta 与未加领域修正的 base transition。

  调用方
  Planner 根节点和深层候选展开。

  输入
  动作、actor、before/after、仅作 horizon 诊断的 depth、end 机会成本与 resolutionScale 查询函数。

  输出
  包含逐 term 数值和 baseTransition 的不可变语义对象。

  读取状态
  只读动作执行概率、before/after 与 state value。

  写入状态
  无。

  调用函数
  actionEconomicValue、stateDelta、getResolutionScale。

  边界与不变量
  只有非零 economic 读取 resolutionScale；after-state 变化只经 stateDelta×0.08 一次进入；
  depth 只限制 Planner 的搜索 horizon，不得缩放动作价值。
  */
  evaluateBase({
    action,
    player,
    beforeState,
    afterState,
    depth = 1,
    endOpportunityCost = 0,
    getResolutionScale = () => 1
  }) {
    const executionProbability = action.executionProbability ?? 1;
    const economic = action.type === "end"
      ? -endOpportunityCost
      : actionEconomicValue(action, player, beforeState);
    const resolutionScale = economic === 0 ? 1 : getResolutionScale();
    const immediate = (economic * resolutionScale) * executionProbability;
    const stateDelta = this.stateDelta(beforeState, afterState, player.id);
    const stateDeltaValue = stateDelta * STATE_DELTA_SCALE;
    const baseTransition = immediate + stateDeltaValue;
    return {
      economic,
      resolutionScale,
      executionProbability,
      immediate,
      stateDelta,
      stateDeltaValue,
      depth,
      baseTransition
    };
  }

  /*
  功能
  组合 base transition、terminal frontier 与信息选择价值为最终候选值。

  调用方
  Planner 与直接测试入口。

  输入
  baseTransition、terminal frontier 与窥隙信息选择价值。

  输出
  当前候选的最终 Transition Value。

  读取状态
  无；只读取显式数值输入。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  response 与实际后续效果已包含在 state delta 中故不再相加；Expose/既有破势边际只作 Search Prior，
  不得与后续 after-state 重复进入 final；窥隙项是未包含在状态中的 Monte Carlo 信息选择价值，不是概率。
  */
  composeCandidateValue({
    baseTransition,
    frontierValue = 0,
    spyGapInformationValue = 0
  }) {
    return baseTransition + frontierValue
      + spyGapInformationValue * STATE_DELTA_SCALE;
  }
}
