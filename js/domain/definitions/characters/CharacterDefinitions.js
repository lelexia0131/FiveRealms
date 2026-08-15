/*
模块职责
唯一拥有 FiveRealms 八名角色的纯静态领域定义；不含 portrait、AI profile、展示标签或运行时 Player 状态。

上游
generalConfig legacy façade 与未来 domain/rules、application/match 消费者。

下游
无。

状态边界
纯静态事实，不读取或写入运行时状态。

信息边界
全部字段均为公开角色规则事实，无隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game 或任何 runtime 模块。
*/

export const CHARACTER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "blade-walker",
    name: "刃行者",
    loreFaction: "流火长路",
    maxHp: 4,
    initialEnergy: 0,
    passiveSkillIds: Object.freeze(["momentum"]),
    activeSkillIds: Object.freeze(["breakArmy"]),
    description: "沿熔岩古道巡行的迅刃，用变化不定的牌序积蓄致命节奏。"
  }),
  Object.freeze({
    id: "oath-warden",
    name: "守誓者",
    loreFaction: "曜石城垒",
    maxHp: 4,
    initialEnergy: 0,
    passiveSkillIds: Object.freeze(["guardianAid"]),
    activeSkillIds: Object.freeze(["barrier"]),
    description: "背负古誓的城垒守卫，擅长将危险拦截在盟友身前。"
  }),
  Object.freeze({
    id: "spirit-medic",
    name: "灵医",
    loreFaction: "雾泉庭",
    maxHp: 4,
    initialEnergy: 1,
    passiveSkillIds: Object.freeze(["rejuvenation"]),
    activeSkillIds: Object.freeze(["symbiosis"]),
    description: "听见生命回声的游医，以自己的元息换取同伴继续作战。"
  }),
  Object.freeze({
    id: "shade-agent",
    name: "影客",
    loreFaction: "无灯港",
    maxHp: 4,
    initialEnergy: 0,
    passiveSkillIds: Object.freeze(["spyGap"]),
    activeSkillIds: Object.freeze(["stealSkill"]),
    description: "往返暗潮市集的情报客，相信一张被看见的牌就不再是秘密。"
  }),
  Object.freeze({
    id: "ember-magus",
    name: "炎术师",
    loreFaction: "赤砂穹庐",
    maxHp: 4,
    initialEnergy: 1,
    passiveSkillIds: Object.freeze(["ember"]),
    activeSkillIds: Object.freeze(["burningField"]),
    description: "以赤砂为燃料的术士，能从每一道伤痕里回收燃烧的余烬。"
  }),
  Object.freeze({
    id: "trail-hunter",
    name: "追猎者",
    loreFaction: "苍苔原",
    maxHp: 4,
    initialEnergy: 0,
    passiveSkillIds: Object.freeze(["tracking"]),
    activeSkillIds: Object.freeze(["hunt"]),
    description: "从不追赶脚步，只追赶选择；一旦落印，猎物便难逃终局。"
  }),
  Object.freeze({
    id: "fate-gambler",
    name: "赌命者",
    loreFaction: "镜轮市",
    maxHp: 4,
    initialEnergy: 0,
    passiveSkillIds: Object.freeze(["gamble"]),
    activeSkillIds: Object.freeze(["allIn"]),
    description: "在镜轮赌局中输掉姓名的旅人，习惯把剩下的一切推向桌面中央。"
  }),
  Object.freeze({
    id: "resonance-tuner",
    name: "调律师",
    loreFaction: "鸣风塔",
    maxHp: 4,
    initialEnergy: 1,
    passiveSkillIds: Object.freeze(["coordination"]),
    activeSkillIds: Object.freeze(["resonance"]),
    description: "借风塔谐振器校准队友的行动，让每一次协作都产生新的回响。"
  })
]);

export const CHARACTER_BY_ID = Object.freeze(Object.fromEntries(CHARACTER_DEFINITIONS.map((character) => [character.id, character])));
