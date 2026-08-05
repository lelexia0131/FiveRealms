/**
 * 八名原创角色的规则数据与纯展示肖像路径。portrait 不参与技能、合法性或 AI 判断。
 */
const profile = (aggression, defense, support, healingPriority, cardConservation, energyConservation, responseConservation, riskTolerance) => Object.freeze({
  aggression, defense, support, healingPriority, cardConservation, energyConservation, responseConservation, riskTolerance
});

export const GENERAL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "blade-walker", name: "刃行者", glyph: "刃", portrait: "./assets/characters/blade-walker.svg",
    loreFaction: "流火长路", maxHp: 4, tags: ["进攻", "连击"], roleTags: ["damage", "attacker"], passiveSkillIds: ["momentum"], activeSkillIds: ["breakArmy"],
    passiveName: "连势", passiveDescription: "每回合首次使用一种新的卡牌类别时获得1层连势，最多2层；下一次突袭实际造成伤害时增加等同层数的伤害并消耗，回合结束后清空连势。",
    passiveTriggerText: "使用本回合尚未记录的卡牌类别时", passiveLimitText: "每回合按不同卡牌类别分别触发",
    activeName: "破军", activeDescription: "消耗2点能量，本回合可额外使用1张突袭；每回合最多发动1次。", activeCost: 2, activeLimitPerTurn: 1,
    description: "沿熔岩古道巡行的迅刃，用变化不定的牌序积蓄致命节奏。",
    aiProfile: profile(1.35, .65, .35, .45, .55, .55, .5, 1.05)
  }),
  Object.freeze({
    id: "oath-warden", name: "守誓者", glyph: "誓", portrait: "./assets/characters/oath-warden.svg",
    loreFaction: "曜石城垒", maxHp: 3, tags: ["防御", "保护"], roleTags: ["tank", "support"], passiveSkillIds: ["guardianAid"], activeSkillIds: ["barrier"],
    passiveName: "护援", passiveDescription: "每回合一次，弃置1张手牌令队友即将受到的伤害-1。",
    passiveTriggerText: "队友即将受到伤害且你可弃置1张手牌时", passiveLimitText: "每回合限触发1次",
    activeName: "壁垒", activeDescription: "消耗2点能量，使一名存活队友获得1点可叠加的护盾；该护盾不会随回合消失，只会在抵消伤害时消耗，每回合最多发动2次。", activeCost: 2, activeLimitPerTurn: 2,
    description: "背负古誓的城垒守卫，擅长将危险拦截在盟友身前。",
    aiProfile: profile(.6, 1.45, 1.25, .7, .8, .85, .9, .45)
  }),
  Object.freeze({
    id: "spirit-medic", name: "灵医", glyph: "灵", portrait: "./assets/characters/spirit-medic.svg",
    loreFaction: "雾泉庭", maxHp: 3, tags: ["恢复", "辅助"], roleTags: ["support", "healer"], passiveSkillIds: ["rejuvenation"], activeSkillIds: ["symbiosis"],
    passiveName: "回春", passiveDescription: "每回合第一次由你使己方阵营角色恢复生命时，额外恢复1点并摸1张牌；濒死救援也可触发。",
    passiveTriggerText: "由你使己方阵营角色（包括自己）恢复生命时", passiveLimitText: "每回合限触发1次",
    activeName: "滋荣", activeDescription: "消耗2点能量，使一名受伤的己方阵营角色（包括自己）恢复1点生命；若目标不是自己，自己同样恢复1点生命；每回合最多发动2次。", activeCost: 2, activeLimitPerTurn: 2,
    description: "听见生命回声的游医，以自己的元息换取同伴继续作战。",
    aiProfile: profile(.45, .95, 1.45, 1.5, .75, .9, .85, .35)
  }),
  Object.freeze({
    id: "shade-agent", name: "影客", glyph: "影", portrait: "./assets/characters/shade-agent.svg",
    loreFaction: "无灯港", maxHp: 3, tags: ["控制", "谍报"], roleTags: ["control", "utility"], passiveSkillIds: ["spyGap"], activeSkillIds: ["stealSkill"],
    passiveName: "窥隙", passiveDescription: "每回合首次对敌人造成实际伤害后，私下查看其至多2张手牌。",
    passiveTriggerText: "对敌人造成实际伤害后", passiveLimitText: "每回合限触发1次",
    activeName: "窃取", activeDescription: "消耗1点能量，选择距离2内一名持有手牌或装备的敌人作为目标，将其全部手牌与装备区牌组成统一候选集合，等概率随机获得其中1张并收入手牌；每回合最多发动2次。", activeCost: 1, activeLimitPerTurn: 2,
    description: "往返暗潮市集的情报客，相信一张被看见的牌就不再是秘密。",
    aiProfile: profile(1.05, .75, .4, .4, .9, .65, .85, 1.1)
  }),
  Object.freeze({
    id: "ember-magus", name: "炎术师", glyph: "炎", portrait: "./assets/characters/ember-magus.svg",
    loreFaction: "赤砂穹庐", maxHp: 3, tags: ["群攻", "爆发"], roleTags: ["damage", "caster"], passiveSkillIds: ["ember"], activeSkillIds: ["burningField"],
    passiveName: "余烬", passiveDescription: "卡牌每次结算首次对敌人造成实际伤害后，获得1点能量。",
    passiveTriggerText: "卡牌结算中首次对敌人造成实际伤害后", passiveLimitText: "每次卡牌结算最多触发1次",
    activeName: "焚场", activeDescription: "消耗2点能量，对所有存活敌人各造成1点不可格挡伤害；每回合最多发动1次。", activeCost: 2, activeLimitPerTurn: 1,
    description: "以赤砂为燃料的术士，能从每一道伤痕里回收燃烧的余烬。",
    aiProfile: profile(1.45, .45, .25, .3, .45, .55, .45, 1.25)
  }),
  Object.freeze({
    id: "trail-hunter", name: "追猎者", glyph: "猎", portrait: "./assets/characters/trail-hunter.svg",
    loreFaction: "苍苔原", maxHp: 4, tags: ["标记", "爆发"], roleTags: ["damage", "control"], passiveSkillIds: ["tracking"], activeSkillIds: ["hunt"],
    passiveName: "追踪", passiveDescription: "每回合以突袭指定敌人后可留下猎印，限触发2次；同一名敌人每回合最多留下1次猎印；猎印持续到你自己的下回合结束。",
    passiveTriggerText: "以突袭指定敌人后", passiveLimitText: "每回合限触发2次；同一敌人每回合限1次",
    activeName: "猎杀", activeDescription: "消耗2点能量，对有你猎印的敌人造成2点可格挡伤害并移除猎印；无视距离，若格挡成功则摸1张牌；每回合最多发动2次。", activeCost: 2, activeLimitPerTurn: 2,
    description: "从不追赶脚步，只追赶选择；一旦落印，猎物便难逃终局。",
    aiProfile: profile(1.3, .7, .35, .45, .65, .75, .65, .95)
  }),
  Object.freeze({
    id: "fate-gambler", name: "赌命者", glyph: "赌", portrait: "./assets/characters/fate-gambler.svg",
    loreFaction: "镜轮市", maxHp: 4, tags: ["风险", "随机"], roleTags: ["damage", "resource"], passiveSkillIds: ["gamble"], activeSkillIds: ["allIn"],
    passiveName: "冒险", passiveDescription: "每回合首次使用战术牌后，有60%概率摸1张牌。",
    passiveTriggerText: "使用战术牌后", passiveLimitText: "每回合限触发1次",
    activeName: "孤注", activeDescription: "消耗全部能量并摸取等量牌；有30×消耗能量%的概率进入不可叠加的孤注状态，令下一次突袭伤害+1，突袭完毕后退出；每回合最多发动1次。", activeCost: 1, activeLimitPerTurn: 1,
    description: "在镜轮赌局中输掉姓名的旅人，习惯把剩下的一切推向桌面中央。",
    aiProfile: profile(1.05, .55, .4, .4, .35, .25, .4, 1.5)
  }),
  Object.freeze({
    id: "resonance-tuner", name: "调律师", glyph: "律", portrait: "./assets/characters/resonance-tuner.svg",
    loreFaction: "鸣风塔", maxHp: 4, tags: ["辅助", "过牌"], roleTags: ["support", "control"], passiveSkillIds: ["coordination"], activeSkillIds: ["resonance"],
    passiveName: "协调", passiveDescription: "每回合首次令另一名队友成为卡牌的有效作用目标后，自己摸1张牌；互利的所有存活角色与转移的接收者均按此规则计入。",
    passiveTriggerText: "对另一名队友使用卡牌后", passiveLimitText: "每回合限触发1次",
    activeName: "共鸣", activeDescription: "消耗2点能量，令一名存活队友摸2张牌；每回合最多发动2次。", activeCost: 2, activeLimitPerTurn: 2,
    description: "借风塔谐振器校准队友的行动，让每一次协作都产生新的回响。",
    aiProfile: profile(.6, .8, 1.45, .9, .7, .8, .75, .55)
  })
]);

export const GENERAL_BY_ID = Object.freeze(Object.fromEntries(GENERAL_DEFINITIONS.map((general) => [general.id, general])));
