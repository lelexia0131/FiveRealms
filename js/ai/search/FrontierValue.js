/*
模块职责
唯一计算 frontier（搜索前沿：已经物化但尚未继续展开的节点集合）中未兑现的未来库存与持有选项表示。

上游
Planner、TransitionValue 诊断与正式边界。

下游
ThreatValue、CardValue 与 Economics。

状态边界
只读 SearchState；不写状态、不执行动作。

信息边界
只使用 viewer 自身手牌身份与过滤后的敌方威胁摘要。

架构约束
持有的调息/回收选项只能在前沿或终止节点一次进入最终价值，不能按搜索深度逐层累计。
*/
import { cardAvailability } from "../value/CardValue.js";
import {
  HP_VALUE,
  STATE_DELTA_SCALE
} from "../value/Economics.js";
import { exposureComponents } from "../value/ThreatValue.js";

export class FrontierValue {
  /*
  功能
  计算当前前沿状态尚未兑现的威胁库存与持有选项。

  调用方
  Planner 与正式边界。

  输入
  SearchState 与 viewer ID。

  输出
  futureInventory、held.recover/recycle 与 total；viewer 无效时返回 null。

  读取状态
  只读 viewer 生命、手牌、装备与过滤后的威胁摘要。

  写入状态
  无。

  调用函数
  exposureComponents、cardAvailability。

  边界与不变量
  本表示与路径无关；生产 final 只消费 held 两项且仅在 terminal 一次，futureInventory 仅诊断。
  */
  frontierResidual(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer || !viewer.alive) return null;
    const { futureInventory, energyPressure } = exposureComponents(state, viewer);
    const recoverCards = (viewer.hand ?? [])
      .filter((card) => card.definitionId === "recover")
      .reduce((sum, card) => sum + cardAvailability(card), 0);
    const recover = recoverCards > 0
      ? Math.max(
          0,
          Math.min(recoverCards, Math.max(0, viewer.maxHp - viewer.hp))
        ) * HP_VALUE
      : 0;
    const recycle = viewer.equipmentDefinitionId === "recycleDevice"
      ? Math.max(0, 2 - (viewer.recycleDeviceUses ?? 0))
        * Math.min(
          1,
          (viewer.hand ?? []).filter(
            (card) => card.category === "tactic" && card.counterable !== false
          ).length
        )
        * 1.1
        * Math.max(0, Number(viewer.equipmentRetentionProbability) || 1)
      : 0;
    const futureInventoryTotal = futureInventory + energyPressure;
    return {
      futureInventory: futureInventoryTotal,
      held: { recover, recycle },
      total: futureInventoryTotal + recover + recycle
    };
  }

  /*
  功能
  把前沿表示转换为当前生产语义实际消费的 terminal held value。

  调用方
  Planner。

  输入
  frontierResidual 返回的表示与是否 terminal。

  输出
  terminal 时 recover+recycle 的缩放值，否则为零。

  读取状态
  只读 residual 对象。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  futureInventory 已在 state value 暴露项中，永不在此重复进入 final；held 只在 terminal 一次。
  */
  finalValue(residual, terminal) {
    if (!terminal || !residual) return 0;
    return ((residual.held?.recover ?? 0) + (residual.held?.recycle ?? 0))
      * STATE_DELTA_SCALE;
  }
}
