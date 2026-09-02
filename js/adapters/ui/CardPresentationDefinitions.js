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
  }),
  recover: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/recover.svg",
    icon: "./assets/cards/recover.svg",
    glyph: "./assets/ui/recover-glyph.svg",
    accent: "#4f8468",
    frameStyle: "vital",
  }),
  block: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/block.svg",
    icon: "./assets/cards/block.svg",
    accent: "#54728a",
    frameStyle: "guard",
  }),
  charge: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/charge.svg",
    icon: "./assets/cards/charge.svg",
    glyph: "./assets/ui/charge-glyph.svg",
    accent: "#b4872f",
    frameStyle: "core",
  }),
  shield: Object.freeze({
    categoryName: "基础牌",
    art: "./assets/cards/shield.svg",
    icon: "./assets/cards/shield.svg",
    glyph: "./assets/ui/shield-glyph.svg",
    accent: "#477b91",
    frameStyle: "ward",
  }),
  scout: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/scout.svg",
    icon: "./assets/cards/scout.svg",
    accent: "#4b718b",
    frameStyle: "oracle",
  }),
  transfer: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/transfer.svg",
    icon: "./assets/cards/transfer.svg",
    accent: "#3f6099",
    frameStyle: "current",
  }),
  exposeWeakness: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/expose-weakness.svg",
    icon: "./assets/cards/expose-weakness.svg",
    accent: "#8d332f",
    frameStyle: "fracture",
  }),
  shockwave: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/shockwave.svg",
    icon: "./assets/cards/shockwave.svg",
    accent: "#c35a35",
    frameStyle: "impact",
  }),
  provoke: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/provoke.svg",
    icon: "./assets/cards/provoke.svg",
    accent: "#a44935",
    frameStyle: "impact",
  }),
  leverage: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/leverage.svg",
    icon: "./assets/cards/leverage.svg",
    accent: "#9c6537",
    frameStyle: "current",
  }),
  plunder: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/plunder.svg",
    icon: "./assets/cards/plunder.svg",
    accent: "#714985",
    frameStyle: "chain",
  }),
  destroy: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/destroy.svg",
    icon: "./assets/cards/destroy.svg",
    accent: "#7a3f36",
    frameStyle: "fracture",
  }),
  counter: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/counter.svg",
    icon: "./assets/cards/counter.svg",
    accent: "#59406e",
    frameStyle: "seal",
  }),
  harvest: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/harvest.svg",
    icon: "./assets/cards/harvest.svg",
    accent: "#71834b",
    frameStyle: "vital",
  }),
  duel: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/duel.svg",
    icon: "./assets/cards/duel.svg",
    accent: "#933d31",
    frameStyle: "strike",
  }),
  mutualBenefit: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/mutual-benefit.svg",
    icon: "./assets/cards/mutual-benefit.svg",
    accent: "#5a8b7f",
    frameStyle: "ward",
  }),
  symbiosis: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/symbiosis.svg",
    icon: "./assets/cards/symbiosis.svg",
    accent: "#45856b",
    frameStyle: "vital",
  }),
  seal: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/seal.svg",
    icon: "./assets/cards/seal.svg",
    accent: "#7655a8",
    frameStyle: "seal",
  }),
  lightning: Object.freeze({
    categoryName: "战术牌",
    art: "./assets/cards/lightning.svg",
    icon: "./assets/cards/lightning.svg",
    accent: "#5b7fd4",
    frameStyle: "current",
  }),
  energyDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/energy-device.svg",
    icon: "./assets/cards/energy-device.svg",
    accent: "#b4872f",
    frameStyle: "machine",
  }),
  recycleDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/recycle-device.svg",
    icon: "./assets/cards/recycle-device.svg",
    accent: "#7d8260",
    frameStyle: "machine",
  }),
  defenseDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/defense-device.svg",
    icon: "./assets/cards/defense-device.svg",
    accent: "#58788c",
    frameStyle: "machine",
  }),
  battleDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/battle-device.svg",
    icon: "./assets/cards/battle-device.svg",
    accent: "#9a6139",
    frameStyle: "machine",
  }),
  telescope: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/telescope.svg",
    icon: "./assets/cards/telescope.svg",
    accent: "#497c91",
    frameStyle: "machine",
  }),
  barrierDevice: Object.freeze({
    categoryName: "装备牌",
    art: "./assets/cards/barrier-device.svg",
    icon: "./assets/cards/barrier-device.svg",
    accent: "#6d638f",
    frameStyle: "machine",
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
