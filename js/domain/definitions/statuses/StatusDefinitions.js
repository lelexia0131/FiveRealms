/*
模块职责
唯一拥有 FiveRealms 当前真实存在状态键的纯静态身份与文案定义；不含生命周期、触发、判定、伤害或转移规则。

上游
未来 domain/rules/status 与 presentation 消费者。

下游
无。

状态边界
纯静态事实，不读取或写入运行时状态。

信息边界
全部字段均为公开状态事实，无隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game 或任何 runtime 模块。
*/

export const STATUS_DEFINITIONS = Object.freeze({
  exposeWeakness: Object.freeze({
    id: "exposeWeakness",
    name: "破势",
    description: "「破势」可以使「突袭」伤害额外增加相应层数；层数可叠加，打出「突袭」后消耗所有层数。"
  }),
  allIn: Object.freeze({
    id: "allIn",
    name: "孤注",
    description: "「孤注」令下一次「突袭」伤害+1，「突袭」完毕后退出；不可叠加。"
  }),
  huntMark: Object.freeze({
    id: "huntMark",
    name: "猎印",
    description: "「猎印」持续到留下者的下回合结束，并允许「猎杀」无视距离指定目标。"
  }),
  sealed: Object.freeze({
    id: "sealed",
    name: "封印",
    description: "持有者的下个回合摸牌阶段前判定：为战术牌时未生效；否则生效，摸牌后跳过出牌阶段。"
  }),
  lightning: Object.freeze({
    id: "lightning",
    name: "闪电",
    description: "持有者的下回合摸牌前判定：若结果为装备牌，受到3点伤害并移除状态；否则转移给下一名未进入「闪电」状态的角色。"
  })
});
