/**
 * 本文件定义全部卡牌的公开数据与牌堆数量，不执行卡牌效果。
 * 结算逻辑位于 cards/cardRegistry.js；AI 估值位于 ai/AIController.js。
 * 增删卡牌时需同时注册结算器，并确保 count 为非负整数。
 */

export const CARD_DEFINITIONS = Object.freeze({
  assault: Object.freeze({
    definitionId: "assault", name: "突袭", category: "basic", categoryName: "基础牌",
    subtypes: ["attack"], description: "对一名敌方角色造成1点可格挡伤害。",
    targetType: "singleEnemy", responseType: "block", canBeRedirected: false, count: 24, aiValue: 4,
    art: "./assets/cards/assault.svg", icon: "./assets/cards/assault.svg", accent: "#b84a2f", frameStyle: "strike", flavorText: "刀光先于战意抵达。"
  }),
  block: Object.freeze({
    definitionId: "block", name: "格挡", category: "basic", categoryName: "响应牌",
    subtypes: ["response", "block"], description: "响应可格挡伤害，使此次伤害减少1点。",
    targetType: "responseOnly", responseType: null, canBeRedirected: false, count: 18, aiValue: 5,
    art: "./assets/cards/block.svg", icon: "./assets/cards/block.svg", accent: "#54728a", frameStyle: "guard", flavorText: "山岳不语，自有回响。"
  }),
  recover: Object.freeze({
    definitionId: "recover", name: "调息", category: "basic", categoryName: "恢复牌",
    subtypes: ["heal"], description: "为自己恢复1点生命；满生命时不可使用。",
    targetType: "self", responseType: null, canBeRedirected: false, count: 10, aiValue: 4,
    art: "./assets/cards/recover.svg", icon: "./assets/cards/recover.svg", accent: "#4f8468", frameStyle: "vital", flavorText: "一息尚存，灵脉不绝。"
  }),
  support: Object.freeze({
    definitionId: "support", name: "援护", category: "basic", categoryName: "辅助牌",
    subtypes: ["support"], description: "令一名受伤队友获得1点临时护盾。",
    targetType: "injuredAlly", responseType: null, canBeRedirected: false, count: 6, aiValue: 3,
    art: "./assets/cards/support.svg", icon: "./assets/cards/support.svg", accent: "#2d8b82", frameStyle: "ward", flavorText: "并肩之处，风雨止步。"
  }),
  insight: Object.freeze({
    definitionId: "insight", name: "洞察", category: "tactic", categoryName: "战术牌",
    subtypes: ["draw"], description: "摸2张牌，然后弃置1张牌。",
    targetType: "none", responseType: "counter", canBeRedirected: false, count: 6, aiValue: 5,
    art: "./assets/cards/insight.svg", icon: "./assets/cards/insight.svg", accent: "#655b9b", frameStyle: "oracle", flavorText: "见一叶，便知潮向。"
  }),
  exposeWeakness: Object.freeze({
    definitionId: "exposeWeakness", name: "破势", category: "tactic", categoryName: "战术牌",
    subtypes: ["status"], description: "令一名敌人获得破绽；其下次受伤时伤害+1。",
    targetType: "singleEnemy", responseType: "counter", canBeRedirected: true, count: 5, aiValue: 5,
    art: "./assets/cards/expose-weakness.svg", icon: "./assets/cards/expose-weakness.svg", accent: "#8d332f", frameStyle: "fracture", flavorText: "裂隙从来早于崩塌。"
  }),
  redirect: Object.freeze({
    definitionId: "redirect", name: "转移", category: "response", categoryName: "响应牌",
    subtypes: ["response", "redirect"], description: "将指定自己的可转移单体战术牌转给另一合法目标。",
    targetType: "responseOnly", responseType: null, canBeRedirected: false, count: 4, aiValue: 6,
    art: "./assets/cards/redirect.svg", icon: "./assets/cards/redirect.svg", accent: "#465b9b", frameStyle: "current", flavorText: "借势回旋，锋芒易主。"
  }),
  counter: Object.freeze({
    definitionId: "counter", name: "反制", category: "response", categoryName: "响应牌",
    subtypes: ["response", "counter"], description: "响应其他角色的战术牌，取消其效果。",
    targetType: "responseOnly", responseType: null, canBeRedirected: false, count: 4, aiValue: 7,
    art: "./assets/cards/counter.svg", icon: "./assets/cards/counter.svg", accent: "#59406e", frameStyle: "seal", flavorText: "印成，则万法暂寂。"
  }),
  shockwave: Object.freeze({
    definitionId: "shockwave", name: "震荡", category: "tactic", categoryName: "群体战术",
    subtypes: ["attack", "area"], description: "依次对所有敌人造成1点可格挡伤害。",
    targetType: "allEnemies", responseType: "counter", canBeRedirected: false, count: 3, aiValue: 7,
    art: "./assets/cards/shockwave.svg", icon: "./assets/cards/shockwave.svg", accent: "#c35a35", frameStyle: "impact", flavorText: "大地替怒火发声。"
  }),
  steal: Object.freeze({
    definitionId: "steal", name: "夺取", category: "tactic", categoryName: "战术牌",
    subtypes: ["control"], description: "随机获得一名有手牌敌人的1张手牌。",
    targetType: "enemyWithCards", responseType: "counter", canBeRedirected: false, count: 4, aiValue: 6,
    art: "./assets/cards/steal.svg", icon: "./assets/cards/steal.svg", accent: "#714985", frameStyle: "chain", flavorText: "秘密总有第二位主人。"
  }),
  charge: Object.freeze({
    definitionId: "charge", name: "聚能", category: "basic", categoryName: "能量牌",
    subtypes: ["energy"], description: "获得1点能量，不能超过上限。",
    targetType: "self", responseType: null, canBeRedirected: false, count: 6, aiValue: 4,
    art: "./assets/cards/charge.svg", icon: "./assets/cards/charge.svg", accent: "#b4872f", frameStyle: "core", flavorText: "星火归心，静待雷鸣。"
  }),
  coreDevice: Object.freeze({
    definitionId: "coreDevice", name: "核心装置", category: "equipment", categoryName: "装备牌",
    subtypes: ["equipment"], description: "装备后，每回合首次使用战术牌后摸1张牌。",
    targetType: "self", responseType: null, canBeRedirected: false, count: 4, aiValue: 6,
    art: "./assets/cards/core-device.svg", icon: "./assets/cards/core-device.svg", accent: "#8b6e3f", frameStyle: "machine", flavorText: "古代机芯仍记得星辰的频率。"
  })
});

export const CARD_COUNTS = Object.freeze(
  Object.fromEntries(Object.values(CARD_DEFINITIONS).map((definition) => [definition.definitionId, definition.count]))
);
