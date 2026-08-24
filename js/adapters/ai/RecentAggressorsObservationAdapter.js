/*
模块职责
把 Application Combat 的 damage observation 结果写入 target.aiMemory.recentAggressors；只拥有 narrow AI memory adapter，不拥有 AI policy/search/planner。

上游
composition root。

下游
无。

状态边界
只写 target.aiMemory.recentAggressors；不写 Domain state。

信息边界
只处理 source/target/hpDamage 事实；不读取手牌或隐藏信息。

架构约束
不得依赖 Game class、AIController、Planner、World 或 Domain transitions。
*/

/*
功能
创建 narrow damage AI observation adapter。

调用方
composition root。

输入
无。

输出
冻结 { observeDamage }。

读取状态
无。

写入状态
经 observeDamage 写 recentAggressors。

调用函数
无。

边界与不变量
保持旧语义：敌对来源、hpDamage > 0 才累加；不重构 aiMemory shape。
*/
export function createRecentAggressorsObservationAdapter() {
  return Object.freeze({
    /*
    功能
    记录一次对目标的敌对生命伤害至 recentAggressors。

    调用方
    Application CombatWorkflow。

    输入
    target、source 与 hpDamage。

    输出
    无。

    读取状态
    无。

    写入状态
    target.aiMemory.recentAggressors。

    调用函数
    无。

    边界与不变量
    调用时机由 CombatWorkflow 保留；本 adapter 不决定是否观察。
    */
    observeDamage(target, source, hpDamage) {
      if (source && hpDamage > 0 && source.battleTeam !== target.battleTeam) {
        target.aiMemory.recentAggressors[source.id] = (target.aiMemory.recentAggressors[source.id] ?? 0) + hpDamage;
      }
    }
  });
}
