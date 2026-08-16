/**
 * 旧卡牌配置 façade。纯领域卡牌定义已由 domain/definitions/cards/CardDefinitions.js 单一拥有；
 * 本文件只负责把领域定义与 AI/UI presentation metadata 组合成当前公开 CARD_DEFINITIONS shape。
 */
import { CARD_DEFINITIONS as CARD_DOMAIN_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js?build=20260816-legacy-recovery";
import { RULESET_DEFINITION } from "../domain/definitions/ruleset/RulesetDefinition.js?build=20260816-legacy-recovery";

const CARD_PRESENTATION = Object.freeze({
  assault: Object.freeze({
    categoryName: "基础牌",
    aiValue: 4,
    art: "./assets/cards/assault.svg",
    icon: "./assets/cards/assault.svg",
    accent: "#b84a2f",
    frameStyle: "strike",
    flavorText: "刀光先于战意抵达。",
  }),
  recover: Object.freeze({
    categoryName: "基础牌",
    aiValue: 6,
    art: "./assets/cards/recover.svg",
    icon: "./assets/cards/recover.svg",
    accent: "#4f8468",
    frameStyle: "vital",
    flavorText: "一息尚存，灵脉不绝。",
  }),
  block: Object.freeze({
    categoryName: "基础牌",
    aiValue: 5,
    art: "./assets/cards/block.svg",
    icon: "./assets/cards/block.svg",
    accent: "#54728a",
    frameStyle: "guard",
    flavorText: "山岳不语，自有回响。",
  }),
  charge: Object.freeze({
    categoryName: "基础牌",
    aiValue: 5,
    art: "./assets/cards/charge.svg",
    icon: "./assets/cards/charge.svg",
    accent: "#b4872f",
    frameStyle: "core",
    flavorText: "星火归心，静待雷鸣。",
  }),
  shield: Object.freeze({
    categoryName: "基础牌",
    aiValue: 7,
    art: "./assets/cards/shield.svg",
    icon: "./assets/cards/shield.svg",
    accent: "#477b91",
    frameStyle: "ward",
    flavorText: "灵光层叠，终成不破之垒。",
  }),
  scout: Object.freeze({
    categoryName: "战术牌",
    aiValue: 5,
    art: "./assets/cards/scout.svg",
    icon: "./assets/cards/scout.svg",
    accent: "#4b718b",
    frameStyle: "oracle",
    flavorText: "潮声掩住了情报的脚步。",
  }),
  transfer: Object.freeze({
    categoryName: "战术牌",
    aiValue: 7,
    art: "./assets/cards/transfer.svg",
    icon: "./assets/cards/transfer.svg",
    accent: "#3f6099",
    frameStyle: "current",
    flavorText: "物随势转，去处不由旧主。",
  }),
  exposeWeakness: Object.freeze({
    categoryName: "战术牌",
    aiValue: 6,
    art: "./assets/cards/expose-weakness.svg",
    icon: "./assets/cards/expose-weakness.svg",
    accent: "#8d332f",
    frameStyle: "fracture",
    flavorText: "先断其势，再断其锋。",
  }),
  shockwave: Object.freeze({
    categoryName: "战术牌",
    aiValue: 8,
    art: "./assets/cards/shockwave.svg",
    icon: "./assets/cards/shockwave.svg",
    accent: "#c35a35",
    frameStyle: "impact",
    flavorText: "大地替怒火发声。",
  }),
  provoke: Object.freeze({
    categoryName: "战术牌",
    aiValue: 8,
    art: "./assets/cards/provoke.svg",
    icon: "./assets/cards/provoke.svg",
    accent: "#a44935",
    frameStyle: "impact",
    flavorText: "怒意一旦应声，代价便已写下。",
  }),
  leverage: Object.freeze({
    categoryName: "战术牌",
    aiValue: 7,
    art: "./assets/cards/leverage.svg",
    icon: "./assets/cards/leverage.svg",
    accent: "#9c6537",
    frameStyle: "current",
    flavorText: "借来的锋芒，也能改写归属。",
  }),
  plunder: Object.freeze({
    categoryName: "战术牌",
    aiValue: 7,
    art: "./assets/cards/plunder.svg",
    icon: "./assets/cards/plunder.svg",
    accent: "#714985",
    frameStyle: "chain",
    flavorText: "秘密总有第二位主人。",
  }),
  destroy: Object.freeze({
    categoryName: "战术牌",
    aiValue: 6,
    art: "./assets/cards/destroy.svg",
    icon: "./assets/cards/destroy.svg",
    accent: "#7a3f36",
    frameStyle: "fracture",
    flavorText: "断裂之声让秘密无处藏身。",
  }),
  counter: Object.freeze({
    categoryName: "战术牌",
    aiValue: 8,
    art: "./assets/cards/counter.svg",
    icon: "./assets/cards/counter.svg",
    accent: "#59406e",
    frameStyle: "seal",
    flavorText: "印成，则万法暂寂。",
  }),
  harvest: Object.freeze({
    categoryName: "战术牌",
    aiValue: 8,
    art: "./assets/cards/harvest.svg",
    icon: "./assets/cards/harvest.svg",
    accent: "#71834b",
    frameStyle: "vital",
    flavorText: "耐心让每一粒星火结实。",
  }),
  duel: Object.freeze({
    categoryName: "战术牌",
    aiValue: 6,
    art: "./assets/cards/duel.svg",
    icon: "./assets/cards/duel.svg",
    accent: "#933d31",
    frameStyle: "strike",
    flavorText: "胜负只隔着下一次出刃。",
  }),
  mutualBenefit: Object.freeze({
    categoryName: "战术牌",
    aiValue: 6,
    art: "./assets/cards/mutual-benefit.svg",
    icon: "./assets/cards/mutual-benefit.svg",
    accent: "#5a8b7f",
    frameStyle: "ward",
    flavorText: "同桌之上，各取所需。",
  }),
  symbiosis: Object.freeze({
    categoryName: "战术牌",
    aiValue: 5,
    art: "./assets/cards/symbiosis.svg",
    icon: "./assets/cards/symbiosis.svg",
    accent: "#45856b",
    frameStyle: "vital",
    flavorText: "万脉同息，枯处亦生。",
  }),
  seal: Object.freeze({
    categoryName: "战术牌",
    aiValue: 7,
    art: "./assets/cards/seal.svg",
    icon: "./assets/cards/seal.svg",
    accent: "#7655a8",
    frameStyle: "seal",
    flavorText: "印落于身，来日方知枷锁轻重。",
  }),
  lightning: Object.freeze({
    categoryName: "战术牌",
    aiValue: 3,
    art: "./assets/cards/lightning.svg",
    icon: "./assets/cards/lightning.svg",
    accent: "#5b7fd4",
    frameStyle: "current",
    flavorText: "云隙一瞬，雷霆已有归处。",
  }),
  energyDevice: Object.freeze({
    categoryName: "装备牌",
    aiValue: 7,
    art: "./assets/cards/energy-device.svg",
    icon: "./assets/cards/energy-device.svg",
    accent: "#b4872f",
    frameStyle: "machine",
    flavorText: "微光沿铜轨汇入核心。",
  }),
  recycleDevice: Object.freeze({
    categoryName: "装备牌",
    aiValue: 8,
    art: "./assets/cards/recycle-device.svg",
    icon: "./assets/cards/recycle-device.svg",
    accent: "#7d8260",
    frameStyle: "machine",
    flavorText: "废弃的余响仍可再次运转。",
  }),
  defenseDevice: Object.freeze({
    categoryName: "装备牌",
    aiValue: 9,
    art: "./assets/cards/defense-device.svg",
    icon: "./assets/cards/defense-device.svg",
    accent: "#58788c",
    frameStyle: "machine",
    flavorText: "齿轮先一步听见危险。",
  }),
  battleDevice: Object.freeze({
    categoryName: "装备牌",
    aiValue: 9,
    art: "./assets/cards/battle-device.svg",
    icon: "./assets/cards/battle-device.svg",
    accent: "#9a6139",
    frameStyle: "machine",
    flavorText: "双重压力让防线发出哀鸣。",
  }),
  telescope: Object.freeze({
    categoryName: "装备牌",
    aiValue: 8,
    art: "./assets/cards/telescope.svg",
    icon: "./assets/cards/telescope.svg",
    accent: "#497c91",
    frameStyle: "machine",
    flavorText: "远处的锋芒，也能近在眼前。",
  }),
  barrierDevice: Object.freeze({
    categoryName: "装备牌",
    aiValue: 9,
    art: "./assets/cards/barrier-device.svg",
    icon: "./assets/cards/barrier-device.svg",
    accent: "#6d638f",
    frameStyle: "machine",
    flavorText: "无形界面，将来敌推远一步。",
  }),
});

/*
功能
克隆数组字段，保持 legacy 公开对象的数组与 Domain authority 相互隔离。

调用方
legacyCard。

输入
定义或 presentation 字段值。

输出
数组返回新浅拷贝，其余值原样返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不复制对象身份；只隔离数组以保留旧公开 API 的可变性语义。
*/
const projectLegacyValue = (value) => Array.isArray(value) ? [...value] : value;

/*
功能
把一份 Domain Card Definition 投影为当前公开的完整卡牌对象 shape。

调用方
cardConfig 模块初始化。

输入
domain/definitions/cards 中的单卡领域定义。

输出
冻结的完整卡牌对象，领域字段与 AI/UI 字段按旧 key order 合并。

读取状态
CARD_DOMAIN_DEFINITIONS、CARD_PRESENTATION 与 RULESET_DEFINITION.deckComposition。

写入状态
无。

调用函数
无。

边界与不变量
不维护任何领域字段 literal；旧字段顺序与迁移前一致。
*/

const legacyCard = (definition) => {
  const presentation = CARD_PRESENTATION[definition.definitionId];
  const result = {};
  const orderedFields = [
    "usageMode", "responseTypes", "counterable", "counterScope", "ignoresDistance", "selectionFlow",
    "definitionId", "name", "category", "categoryName", "targetType", "subtypes", "description", "count",
    "aiValue", "effectRange", "targetZones", "art", "icon", "accent", "frameStyle", "flavorText"
  ];
  for (const field of orderedFields) {
    if (field === "count") result[field] = RULESET_DEFINITION.deckComposition[definition.definitionId];
    else if (definition[field] !== undefined) result[field] = projectLegacyValue(definition[field]);
    else if (presentation[field] !== undefined) result[field] = projectLegacyValue(presentation[field]);
  }
  return Object.freeze(result);
};

export const CARD_DEFINITIONS = Object.freeze(
  Object.fromEntries(Object.entries(CARD_DOMAIN_DEFINITIONS).map(([definitionId, definition]) => [
    definitionId,
    legacyCard(definition)
  ]))
);

export const CARD_COUNTS = RULESET_DEFINITION.deckComposition;
export const TOTAL_CARD_COUNT = Object.values(CARD_COUNTS).reduce((sum, count) => sum + count, 0);
