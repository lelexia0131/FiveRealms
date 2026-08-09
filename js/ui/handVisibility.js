/**
 * 将非本地玩家手牌转换为脱敏展示模型。未知槽位不携带实体 ID、定义、名称、
 * 类别、描述或图片；已知信息只读取本地真人自己的实体牌记忆。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260809-coordination-target-audit-v138";

// 与 README 卡牌表保持一致的纯展示顺序；任何排序都只作用于 ViewModel。
export const CARD_CATEGORY_DISPLAY_ORDER = Object.freeze({ basic:0, tactic:1, equipment:2, unknown:3 });
export const CARD_DEFINITION_DISPLAY_ORDER = Object.freeze([
  "assault", "recover", "block", "charge", "shield",
  "scout", "transfer", "exposeWeakness", "shockwave", "provoke", "leverage", "plunder", "destroy", "counter", "harvest", "duel", "mutualBenefit", "symbiosis", "seal", "lightning",
  "energyDevice", "recycleDevice", "defenseDevice", "battleDevice", "telescope", "barrierDevice"
]);
const definitionOrder = new Map(CARD_DEFINITION_DISPLAY_ORDER.map((definitionId, index) => [definitionId, index]));

function knownCardView(definition) {
  return Object.freeze({
    known:true,
    name:definition.name,
    category:definition.category,
    categoryName:definition.categoryName,
    description:definition.description,
    art:definition.art,
    icon:definition.icon,
    accent:definition.accent,
    frameStyle:definition.frameStyle,
    flavorText:definition.flavorText,
    subtypes:[...definition.subtypes]
  });
}

function compareDisplayEntries(left, right) {
  const categoryDifference = left.categoryOrder - right.categoryOrder;
  if (categoryDifference) return categoryDifference;
  if (left.categoryOrder === CARD_CATEGORY_DISPLAY_ORDER.unknown) return left.originalIndex - right.originalIndex;
  const definitionDifference = left.definitionOrder - right.definitionOrder;
  if (definitionDifference) return definitionDifference;
  const nameDifference = left.view.name.localeCompare(right.view.name, "zh-CN");
  return nameDifference || left.originalIndex - right.originalIndex;
}

export function createOpponentHandView(viewer, owner) {
  const knownByEntity = viewer?.aiMemory?.knownCardsByPlayer?.[owner?.id] ?? {};
  return (owner?.hand ?? []).map((card, originalIndex) => {
    const rememberedDefinitionId = knownByEntity[card.id];
    if (rememberedDefinitionId !== card.definitionId) return {
      view:Object.freeze({ known:false }), originalIndex,
      categoryOrder:CARD_CATEGORY_DISPLAY_ORDER.unknown, definitionOrder:Number.MAX_SAFE_INTEGER
    };
    const definition = CARD_DEFINITIONS[rememberedDefinitionId];
    if (!definition) return {
      view:Object.freeze({ known:false }), originalIndex,
      categoryOrder:CARD_CATEGORY_DISPLAY_ORDER.unknown, definitionOrder:Number.MAX_SAFE_INTEGER
    };
    return {
      view:knownCardView(definition), originalIndex,
      categoryOrder:CARD_CATEGORY_DISPLAY_ORDER[definition.category] ?? CARD_CATEGORY_DISPLAY_ORDER.unknown - 1,
      definitionOrder:definitionOrder.get(definition.definitionId) ?? Number.MAX_SAFE_INTEGER
    };
  }).sort(compareDisplayEntries).map((entry) => entry.view);
}

/** 为不透明 token 生成安全展示数据；未知项只携带 token 与 known=false。 */
export function createHiddenSelectionView(viewer, owner, selection) {
  const knownByEntity = viewer?.aiMemory?.knownCardsByPlayer?.[owner?.id] ?? {};
  return (selection?.tokens ?? []).map((entry) => {
    const card = owner?.hand?.[entry.position - 1];
    const definitionId = card && (viewer?.id === owner?.id || knownByEntity[card.id] === card.definitionId) ? card.definitionId : null;
    const definition = definitionId ? CARD_DEFINITIONS[definitionId] : null;
    return Object.freeze({ token:entry.token, ...(definition ? knownCardView(definition) : { known:false }) });
  });
}
