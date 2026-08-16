/*
模块职责
唯一拥有 FiveRealms 主动与被动技能的纯静态定义；不含 canUse、execute、passive handler、EventBus 注册或 AI/UI 选择逻辑。

上游
generalConfig legacy façade、skillRegistry runtime projection 与未来 domain/rules 消费者。

下游
无。

状态边界
纯静态事实，不读取或写入运行时状态。

信息边界
全部字段均为公开技能规则事实，无隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game/skillRegistry 或任何 runtime 模块。
*/

export const ACTIVE_SKILL_DEFINITIONS = Object.freeze({
  breakArmy: Object.freeze({
    id: "breakArmy",
    name: "破军",
    cost: 2,
    limitPerTurn: 1,
    targetType: "none",
    rangeRule: "self",
    description: "消耗2点能量，本回合可额外使用1张「突袭」；每回合最多发动1次。",
    attackLimitBonus: 1
  }),
  barrier: Object.freeze({
    id: "barrier",
    name: "壁垒",
    cost: 2,
    limitPerTurn: 2,
    targetType: "ally",
    rangeRule: "ally",
    description: "消耗2点能量，使一名己方阵营角色获得1点护盾；每回合最多发动2次。",
    shieldAmount: 1
  }),
  symbiosis: Object.freeze({
    id: "symbiosis",
    name: "滋荣",
    cost: 2,
    limitPerTurn: 2,
    targetType: "injuredAlly",
    rangeRule: "ally",
    description: "消耗2点能量，使一名己方阵营角色恢复1点生命；每回合最多发动2次",
    healAmount: 1
  }),
  stealSkill: Object.freeze({
    id: "stealSkill",
    name: "窃取",
    cost: 2,
    limitPerTurn: 2,
    targetType: "enemyWithCardsOrEquipment",
    rangeRule: "fixed",
    range: 2,
    description: "消耗2点能量，选择距离2内一名持有手牌或装备的敌人作为目标，将其全部手牌与装备区牌组成统一候选集合，等概率随机获得其中1张并收入手牌；每回合最多发动2次。"
  }),
  burningField: Object.freeze({
    id: "burningField",
    name: "焚场",
    cost: 3,
    limitPerTurn: 2,
    targetType: "allEnemies",
    rangeRule: "unlimited",
    description: "消耗3点能量，对所有存活敌人各造成1点可格挡伤害；每回合最多发动2次。",
    damageAmount: 1
  }),
  hunt: Object.freeze({
    id: "hunt",
    name: "猎杀",
    cost: 2,
    limitPerTurn: 2,
    targetType: "markedEnemy",
    rangeRule: "unlimited",
    description: "消耗2点能量，对有你「猎印」的敌人造成2点可格挡伤害并移除「猎印」；无视距离，若格挡成功则摸1张牌；每回合最多发动2次。",
    damageAmount: 2,
    blockedRewardDraw: 1
  }),
  allIn: Object.freeze({
    id: "allIn",
    name: "孤注",
    cost: 1,
    limitPerTurn: 1,
    targetType: "none",
    rangeRule: "self",
    description: "消耗全部能量，摸取比实际消耗能量少1张的牌；有25×实际消耗能量%的概率进入不可叠加的「孤注」状态，令下一次「突袭」伤害+1，「突袭」完毕后退出；每回合最多发动1次。",
    drawOffset: 1,
    enterChancePerEnergy: 0.25,
    enterChanceCap: 1,
    assaultDamageBonus: 1
  }),
  resonance: Object.freeze({
    id: "resonance",
    name: "共鸣",
    cost: 2,
    limitPerTurn: 2,
    targetType: "ally",
    rangeRule: "ally",
    description: "消耗2点能量，使一名己方阵营角色摸1张牌；每回合最多发动2次。",
    drawCount: 1
  })
});

export const PASSIVE_SKILL_DEFINITIONS = Object.freeze({
  momentum: Object.freeze({
    id: "momentum",
    name: "连势",
    description: "每回合首次使用一种新的卡牌类别时获得1层「连势」，最多2层；下一次「突袭」实际造成伤害时增加等同层数的伤害并消耗，回合结束后清空「连势」。",
    triggerText: "使用本回合尚未记录的卡牌类别时",
    limitText: "每回合按不同卡牌类别分别触发"
  }),
  guardianAid: Object.freeze({
    id: "guardianAid",
    name: "护援",
    description: "每回合1次，弃置1张手牌令队友即将受到的伤害-1。",
    triggerText: "队友即将受到伤害且你可弃置1张手牌时",
    limitText: "每回合限触发1次",
    maxTriggersPerTurn: 1,
    damageReduction: 1
  }),
  rejuvenation: Object.freeze({
    id: "rejuvenation",
    name: "回春",
    description: "由你使一名己方阵营角色恢复生命时，你摸1张牌；濒死救援也可触发；每回合最多触发2次。",
    triggerText: "由你使自己或队友恢复生命时",
    limitText: "每回合限触发2次",
    maxTriggersPerTurn: 2,
    drawCount: 1
  }),
  spyGap: Object.freeze({
    id: "spyGap",
    name: "窥隙",
    description: "每回合首次对敌人造成实际伤害后，私下查看其至多2张手牌。",
    triggerText: "对敌人造成实际伤害后",
    limitText: "每回合限触发1次",
    maxRevealCount: 2
  }),
  ember: Object.freeze({
    id: "ember",
    name: "余烬",
    description: "卡牌每次结算首次对敌人造成实际伤害后，获得1点能量。",
    triggerText: "卡牌结算中首次对敌人造成实际伤害后",
    limitText: "每次卡牌结算最多触发1次",
    energyGain: 1
  }),
  tracking: Object.freeze({
    id: "tracking",
    name: "追踪",
    description: "每回合以「突袭」指定敌人后可留下「猎印」，限触发2次；同一名敌人每回合最多留下1次「猎印」；「猎印」持续到你自己的下回合结束。",
    triggerText: "以「突袭」指定敌人后",
    limitText: "每回合限触发2次；同一敌人每回合限1次",
    maxTargetsPerTurn: 2,
    maxMarksPerTarget: 1
  }),
  gamble: Object.freeze({
    id: "gamble",
    name: "冒险",
    description: "每回合首次使用战术牌后，有60%概率摸1张牌。",
    triggerText: "使用战术牌后",
    limitText: "每回合限触发1次"
  }),
  coordination: Object.freeze({
    id: "coordination",
    name: "协调",
    description: "每回合首次令另一名队友成为卡牌的有效作用目标后，自己摸1张牌。",
    triggerText: "令另一名队友成为卡牌的有效作用目标后",
    limitText: "每回合限触发1次",
    drawCount: 1
  })
});
