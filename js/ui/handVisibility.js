/**
 * 将非本地玩家手牌转换为脱敏展示模型。未知槽位不携带实体 ID、定义、名称、
 * 类别、描述或图片；已知信息只读取本地真人自己的实体牌记忆。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260730-response-hands-v7";

export function createOpponentHandView(viewer, owner) {
  const knownByEntity = viewer?.aiMemory?.knownCardsByPlayer?.[owner?.id] ?? {};
  return (owner?.hand ?? []).map((card, index) => {
    const rememberedDefinitionId = knownByEntity[card.id];
    if (rememberedDefinitionId !== card.definitionId) return Object.freeze({ known:false, slot:index + 1 });
    const definition = CARD_DEFINITIONS[rememberedDefinitionId];
    if (!definition) return Object.freeze({ known:false, slot:index + 1 });
    return Object.freeze({
      known:true,
      slot:index + 1,
      name:definition.name,
      categoryName:definition.categoryName,
      description:definition.description,
      art:definition.art
    });
  });
}
