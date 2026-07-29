/**
 * 本文件仅描述八名原创角色及其 AI 性格，不包含技能执行逻辑。
 * 技能实现与注册位于 generals/skillRegistry.js；新增角色无需修改通用伤害或回合模块。
 * AI 参数通常推荐 0.4～1.5：数值越高，对应倾向越强，极端值可能破坏阵容平衡但不会绕过规则。
 */

const profile = (aggression, defense, support, healingPriority, cardConservation, energyConservation, responseConservation, riskTolerance) => Object.freeze({
  /** 进攻倾向：增大更愿意攻击低血敌人，减小更早结束回合。 */ aggression,
  /** 防御倾向：增大更重视格挡与自保，减小更愿意消耗响应资源。 */ defense,
  /** 支援倾向：增大更愿意保护与帮助队友，减小偏向个人收益。 */ support,
  /** 治疗优先：增大更早治疗受伤者，减小会容忍较低生命。 */ healingPriority,
  /** 手牌保留：增大更珍惜高价值牌，减小更愿意快速过牌与弃牌。 */ cardConservation,
  /** 能量保留：增大更愿意等待主动技能，减小更快使用聚能后的资源。 */ energyConservation,
  /** 响应保留：增大更珍惜格挡/反制，减小更常立即响应。 */ responseConservation,
  /** 风险偏好：增大更愿意随机与爆发，减小偏向稳定行动。 */ riskTolerance
});

export const GENERAL_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "blade-walker", name: "刃行者", glyph: "刃", loreFaction: "流火长路", maxHp: 4, tags: ["进攻", "连击"], passiveSkillIds: ["momentum"], activeSkillIds: ["breakArmy"], passiveName: "连势", passiveDescription: "每用一种新的卡牌类别获得连势，下一次突袭可造成额外伤害。", activeName: "破军", activeDescription: "消耗3点能量，本回合可额外使用1张突袭。", activeCost: 3, description: "沿熔岩古道巡行的迅刃，用变化不定的牌序积蓄致命节奏。", aiProfile: profile(1.35,.65,.35,.45,.55,.55,.5,1.05) }),
  Object.freeze({ id: "oath-warden", name: "守誓者", glyph: "誓", loreFaction: "曜石城垒", maxHp: 5, tags: ["防御", "保护"], passiveSkillIds: ["guardianAid"], activeSkillIds: ["barrier"], passiveName: "护援", passiveDescription: "每轮一次，弃置1张手牌令队友即将受到的伤害-1。", activeName: "壁垒", activeDescription: "消耗2点能量，令一名队友获得2点临时护盾。", activeCost: 2, description: "背负古誓的城垒守卫，擅长将危险拦截在盟友身前。", aiProfile: profile(.6,1.45,1.25,.7,.8,.85,.9,.45) }),
  Object.freeze({ id: "spirit-medic", name: "灵医", glyph: "灵", loreFaction: "雾泉庭", maxHp: 3, tags: ["恢复", "辅助"], passiveSkillIds: ["rejuvenation"], activeSkillIds: ["symbiosis"], passiveName: "回春", passiveDescription: "每回合第一次由你使角色恢复生命时，额外恢复1点。", activeName: "共生", activeDescription: "消耗2点能量并失去1点生命，令一名队友恢复2点。", activeCost: 2, description: "听见生命回声的游医，以自己的元息换取同伴继续作战。", aiProfile: profile(.45,.95,1.45,1.5,.75,.9,.85,.35) }),
  Object.freeze({ id: "shade-agent", name: "影客", glyph: "影", loreFaction: "无灯港", maxHp: 3, tags: ["控制", "谍报"], passiveSkillIds: ["spyGap"], activeSkillIds: ["stealSkill"], passiveName: "窥隙", passiveDescription: "每回合首次伤害敌人后，私下查看其1张随机手牌。", activeName: "窃取", activeDescription: "消耗3点能量，随机获得一名敌人的1张手牌。", activeCost: 3, description: "往返暗潮市集的情报客，相信一张被看见的牌就不再是秘密。", aiProfile: profile(1.05,.75,.4,.4,.9,.65,.85,1.1) }),
  Object.freeze({ id: "ember-magus", name: "炎术师", glyph: "炎", loreFaction: "赤砂穹庐", maxHp: 3, tags: ["群攻", "爆发"], passiveSkillIds: ["ember"], activeSkillIds: ["burningField"], passiveName: "余烬", passiveDescription: "卡牌每次结算首次对敌人造成实际伤害后，获得1点能量。", activeName: "焚场", activeDescription: "消耗3点能量，对所有敌人各造成1点不可格挡伤害。", activeCost: 3, description: "以赤砂为燃料的术士，能从每一道伤痕里回收燃烧的余烬。", aiProfile: profile(1.45,.45,.25,.3,.45,.55,.45,1.25) }),
  Object.freeze({ id: "trail-hunter", name: "追猎者", glyph: "猎", loreFaction: "苍苔原", maxHp: 4, tags: ["标记", "爆发"], passiveSkillIds: ["tracking"], activeSkillIds: ["hunt"], passiveName: "追踪", passiveDescription: "每回合首次以突袭指定敌人后，为其留下持续到下回合结束的猎印。", activeName: "猎杀", activeDescription: "消耗2点能量，对有你猎印的敌人造成2点伤害并移除猎印。", activeCost: 2, description: "从不追赶脚步，只追赶选择；一旦落印，猎物便难逃终局。", aiProfile: profile(1.3,.7,.35,.45,.65,.75,.65,.95) }),
  Object.freeze({ id: "fate-gambler", name: "赌命者", glyph: "赌", loreFaction: "镜轮市", maxHp: 4, tags: ["风险", "随机"], passiveSkillIds: ["gamble"], activeSkillIds: ["allIn"], passiveName: "冒险", passiveDescription: "每回合首次使用战术牌后，60%摸1张，否则随机弃1张。", activeName: "孤注", activeDescription: "消耗全部能量并按点数摸牌；3点时还强化下一次突袭。", activeCost: 1, description: "在镜轮赌局中输掉姓名的旅人，习惯把剩下的一切推向桌面中央。", aiProfile: profile(1.05,.55,.4,.4,.35,.25,.4,1.5) }),
  Object.freeze({ id: "resonance-tuner", name: "调律师", glyph: "律", loreFaction: "鸣风塔", maxHp: 4, tags: ["辅助", "过牌"], passiveSkillIds: ["coordination"], activeSkillIds: ["resonance"], passiveName: "协调", passiveDescription: "每回合首次对队友使用卡牌后，自己摸1张牌。", activeName: "共鸣", activeDescription: "消耗2点能量，令一名队友摸2张牌。", activeCost: 2, description: "借风塔谐振器校准队友的行动，让每一次协作都产生新的回响。", aiProfile: profile(.6,.8,1.45,.9,.7,.8,.75,.55) })
]);

export const GENERAL_BY_ID = Object.freeze(Object.fromEntries(GENERAL_DEFINITIONS.map((general) => [general.id, general])));
