/*
模块职责
唯一拥有卡牌素材、配色与展示文案，并在 UI 边界把领域卡牌投影为可渲染视图。

上游
UI 模板与 presentation adapter。

下游
Domain CardDefinitions。

状态边界
只读卡牌定义与传入卡牌，不写运行时状态。

信息边界
只处理已经允许展示的卡牌实体；不负责判断隐藏信息可见性。

架构约束
不得拥有领域规则、牌堆数量、AI 价值或结算行为。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";

export const CARD_PRESENTATION = Object.freeze({
  assault: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/assault.svg",
    icon: "./assets/cards/assault.svg",
    accent: "#b84a2f",
    frameStyle: "strike",
    flavorText: "刀光先于战意抵达。",
  }),
  recover: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/recover.svg",
    icon: "./assets/cards/recover.svg",
    glyph: "./assets/ui/recover-glyph.svg",
    accent: "#4f8468",
    frameStyle: "vital",
    flavorText: "一息尚存，灵脉不绝。",
  }),
  block: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/block.svg",
    icon: "./assets/cards/block.svg",
    accent: "#54728a",
    frameStyle: "guard",
    flavorText: "山岳不语，自有回响。",
  }),
  charge: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/charge.svg",
    icon: "./assets/cards/charge.svg",
    glyph: "./assets/ui/charge-glyph.svg",
    accent: "#b4872f",
    frameStyle: "core",
    flavorText: "星火归心，静待雷鸣。",
  }),
  shield: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/shield.svg",
    icon: "./assets/cards/shield.svg",
    glyph: "./assets/ui/shield-glyph.svg",
    accent: "#477b91",
    frameStyle: "ward",
    flavorText: "灵光层叠，终成不破之垒。",
  }),
  scout: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/scout.svg",
    icon: "./assets/cards/scout.svg",
    accent: "#4b718b",
    frameStyle: "oracle",
    flavorText: "潮声掩住了情报的脚步。",
  }),
  transfer: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/transfer.svg",
    icon: "./assets/cards/transfer.svg",
    accent: "#3f6099",
    frameStyle: "current",
    flavorText: "物随势转，去处不由旧主。",
  }),
  exposeWeakness: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/expose-weakness.svg",
    icon: "./assets/cards/expose-weakness.svg",
    accent: "#8d332f",
    frameStyle: "fracture",
    flavorText: "先断其势，再断其锋。",
  }),
  shockwave: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/shockwave.svg",
    icon: "./assets/cards/shockwave.svg",
    accent: "#c35a35",
    frameStyle: "impact",
    flavorText: "大地替怒火发声。",
  }),
  provoke: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/provoke.svg",
    icon: "./assets/cards/provoke.svg",
    accent: "#a44935",
    frameStyle: "impact",
    flavorText: "怒意一旦应声，代价便已写下。",
  }),
  leverage: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/leverage.svg",
    icon: "./assets/cards/leverage.svg",
    accent: "#9c6537",
    frameStyle: "current",
    flavorText: "借来的锋芒，也能改写归属。",
  }),
  plunder: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/plunder.svg",
    icon: "./assets/cards/plunder.svg",
    accent: "#714985",
    frameStyle: "chain",
    flavorText: "秘密总有第二位主人。",
  }),
  destroy: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/destroy.svg",
    icon: "./assets/cards/destroy.svg",
    accent: "#7a3f36",
    frameStyle: "fracture",
    flavorText: "断裂之声让秘密无处藏身。",
  }),
  counter: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/counter.svg",
    icon: "./assets/cards/counter.svg",
    accent: "#59406e",
    frameStyle: "seal",
    flavorText: "印成，则万法暂寂。",
  }),
  harvest: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/harvest.svg",
    icon: "./assets/cards/harvest.svg",
    accent: "#71834b",
    frameStyle: "vital",
    flavorText: "耐心让每一粒星火结实。",
  }),
  duel: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/duel.svg",
    icon: "./assets/cards/duel.svg",
    accent: "#933d31",
    frameStyle: "strike",
    flavorText: "胜负只隔着下一次出刃。",
  }),
  mutualBenefit: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/mutual-benefit.svg",
    icon: "./assets/cards/mutual-benefit.svg",
    accent: "#5a8b7f",
    frameStyle: "ward",
    flavorText: "同桌之上，各取所需。",
  }),
  symbiosis: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/symbiosis.svg",
    icon: "./assets/cards/symbiosis.svg",
    accent: "#45856b",
    frameStyle: "vital",
    flavorText: "万脉同息，枯处亦生。",
  }),
  seal: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/seal.svg",
    icon: "./assets/cards/seal.svg",
    accent: "#7655a8",
    frameStyle: "seal",
    flavorText: "印落于身，来日方知枷锁轻重。",
  }),
  lightning: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/lightning.svg",
    icon: "./assets/cards/lightning.svg",
    accent: "#5b7fd4",
    frameStyle: "current",
    flavorText: "云隙一瞬，雷霆已有归处。",
  }),
  energyDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/energy-device.svg",
    icon: "./assets/cards/energy-device.svg",
    accent: "#b4872f",
    frameStyle: "machine",
    flavorText: "微光沿铜轨汇入核心。",
  }),
  recycleDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/recycle-device.svg",
    icon: "./assets/cards/recycle-device.svg",
    accent: "#7d8260",
    frameStyle: "machine",
    flavorText: "废弃的余响仍可再次运转。",
  }),
  defenseDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/defense-device.svg",
    icon: "./assets/cards/defense-device.svg",
    accent: "#58788c",
    frameStyle: "machine",
    flavorText: "齿轮先一步听见危险。",
  }),
  battleDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/battle-device.svg",
    icon: "./assets/cards/battle-device.svg",
    accent: "#9a6139",
    frameStyle: "machine",
    flavorText: "双重压力让防线发出哀鸣。",
  }),
  telescope: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/telescope.svg",
    icon: "./assets/cards/telescope.svg",
    accent: "#497c91",
    frameStyle: "machine",
    flavorText: "远处的锋芒，也能近在眼前。",
  }),
  barrierDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/barrier-device.svg",
    icon: "./assets/cards/barrier-device.svg",
    accent: "#6d638f",
    frameStyle: "machine",
    flavorText: "无形界面，将来敌推远一步。",
  }),
});

/*
功能
把卡牌实体或 definitionId 投影为 UI 可渲染卡牌视图。

调用方
UI 模板与 presentation adapter。

输入
卡牌实体、领域定义或 definitionId。

输出
合并领域定义、运行时实体字段和展示字段的新对象；未知定义返回原输入。

读取状态
CARD_DEFINITIONS 与 CARD_PRESENTATION。

写入状态
无。

调用函数
对象展开。

边界与不变量
不判断卡牌是否可见；调用方必须先完成隐藏信息过滤。
*/
export function presentCard(card) {
  const definitionId = typeof card === "string" ? card : card?.definitionId;
  const definition = CARD_DEFINITIONS[definitionId];
  if (!definition) return card;
  return {
    ...definition,
    ...(typeof card === "object" && card ? card : {}),
    ...CARD_PRESENTATION[definitionId]
  };
}
