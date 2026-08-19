/**
 * 将非本地玩家手牌转换为脱敏展示模型。未知槽位不携带实体 ID、定义、名称、
 * 类别、描述或图片；已知信息只读取本地真人自己的实体牌记忆。
 */
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js";
import { presentCard } from "../adapters/ui/CardPresentationDefinitions.js";

// 与 README 卡牌表保持一致的纯展示顺序；任何排序都只作用于 ViewModel。
export const CARD_CATEGORY_DISPLAY_ORDER = Object.freeze({ basic:0, tactic:1, equipment:2, unknown:3 });
export const CARD_DEFINITION_DISPLAY_ORDER = Object.freeze([
  "assault", "recover", "block", "charge", "shield",
  "scout", "transfer", "exposeWeakness", "shockwave", "provoke", "leverage", "plunder", "destroy", "counter", "harvest", "duel", "mutualBenefit", "symbiosis", "seal", "lightning",
  "energyDevice", "recycleDevice", "defenseDevice", "battleDevice", "telescope", "barrierDevice"
]);
const definitionOrder = new Map(CARD_DEFINITION_DISPLAY_ORDER.map((definitionId, index) => [definitionId, index]));

/*
功能
把合法已知的卡牌定义转换为不可变展示模型。

调用方
createOpponentHandView 与 createHiddenSelectionView。

输入
已确认可见的卡牌定义。

输出
不含实体 ID 的冻结展示对象。

读取状态
CardPresentationDefinitions 中的公开展示字段。

写入状态
无。

调用函数
presentCard、Object.freeze。

边界与不变量
不得携带实体 ID 或回读未知牌；subtypes 必须复制以避免共享可变数组。
*/
function knownCardView(definition) {
  const card = presentCard(definition);
  return Object.freeze({
    known:true,
    name:card.name,
    category:card.category,
    categoryName:card.categoryName,
    description:card.description,
    art:card.art,
    icon:card.icon,
    accent:card.accent,
    frameStyle:card.frameStyle,
    flavorText:card.flavorText,
    subtypes:[...card.subtypes]
  });
}

/*
功能
按类别、定义和名称稳定比较对手手牌展示项。

调用方
createOpponentHandView 的 Array.sort。

输入
两个包含展示排序键与原始位置的条目。

输出
符合 Array.sort 契约的负数、零或正数。

读取状态
CARD_CATEGORY_DISPLAY_ORDER。

写入状态
无。

调用函数
localeCompare。

边界与不变量
未知槽位只保持原始位置，不得通过真实定义参与排序而泄露信息。
*/
function compareDisplayEntries(left, right) {
  const categoryDifference = left.categoryOrder - right.categoryOrder;
  if (categoryDifference) return categoryDifference;
  if (left.categoryOrder === CARD_CATEGORY_DISPLAY_ORDER.unknown) return left.originalIndex - right.originalIndex;
  const definitionDifference = left.definitionOrder - right.definitionOrder;
  if (definitionDifference) return definitionDifference;
  const nameDifference = left.view.name.localeCompare(right.view.name, "zh-CN");
  return nameDifference || left.originalIndex - right.originalIndex;
}

/*
功能
生成本地真人可合法观察的对手手牌展示序列。

调用方
UIManager.render 与 playerTemplate。

输入
观察者与手牌所有者。

输出
由已知牌面和无信息背面组成的展示数组。

读取状态
owner.hand 与 viewer.aiMemory.knownCardsByPlayer。

写入状态
无。

调用函数
knownCardView、compareDisplayEntries。

边界与不变量
记忆必须同时匹配实体 ID 与当前 definitionId；未知牌不携带任何定义或实体事实。
*/
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

/*
功能
为一次隐藏选择生成仅含合法知识和不透明 token 的展示槽位。

调用方
InteractionController.requestZoneCard/requestHiddenCards。

输入
观察者、手牌所有者与 HiddenCardSelectionAdapter selection。

输出
按 selection token 顺序排列的冻结展示项。

读取状态
owner.hand、selection.positions 与 viewer.aiMemory。

写入状态
无。

调用函数
knownCardView、Object.freeze。

边界与不变量
未知项只能包含 token 与 known=false；不得把真实实体 ID 或 definitionId 写入 DOM 模型。
*/
export function createHiddenSelectionView(viewer, owner, selection) {
  const knownByEntity = viewer?.aiMemory?.knownCardsByPlayer?.[owner?.id] ?? {};
  return (selection?.tokens ?? []).map((entry) => {
    const card = owner?.hand?.[entry.position - 1];
    const definitionId = card && (viewer?.id === owner?.id || knownByEntity[card.id] === card.definitionId) ? card.definitionId : null;
    const definition = definitionId ? CARD_DEFINITIONS[definitionId] : null;
    return Object.freeze({ token:entry.token, ...(definition ? knownCardView(definition) : { known:false }) });
  });
}
