/*
模块职责
拥有 Worker 搜索专用 root action 的 data-only 投影与从 SearchState 稳定 rehydrate 的契约；与执行期 ActionDescriptor 职责分离。

上游
AIController root boundary、SearchRequest 与 Worker search runtime。

下游
Domain Definitions、AI 配置与 Simulator/Value/SearchPrior。

状态边界
只读 action/SearchState；rehydrate 返回独立 action 对象。

信息边界
投影不读取 hidden hand definition；只保存 card instance ID、skill ID、target IDs 与公开选择字段。

架构约束
不得 import Game/Application/Domain transitions；不得直接 structuredClone 真实实体图。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";

/*
功能
浅投影一个仅含普通值的 selection 字段。

调用方
describeRootSearchAction。

输入
任意 selection 或 null。

输出
独立普通对象或 null。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不复制实体；只复制重演 search semantic 所需的显式普通字段。
*/
function projectSelection(selection) {
  if (!selection) return null;
  return Object.freeze({ ...selection });
}

/*
功能
把 main-thread root action 投影为 Worker 可恢复的 data-only root search action。

调用方
AIController 构造 SearchRequest。

输入
raw root action。

输出
冻结 RootSearchAction record。

读取状态
action.card/skill/targets/selection/energyCost。

写入状态
无。

调用函数
projectSelection、Object.freeze。

边界与不变量
不保存 Card/Player 实体；target 只保存 ID；selection 必须本身是普通 data。
*/
export function describeRootSearchAction(action) {
  return Object.freeze({
    type: action.type,
    card: action.card
      ? Object.freeze({ definitionId:action.card.definitionId, cardInstanceId:action.card.id ?? null })
      : null,
    skillId: action.skill?.id ?? null,
    targetIds:Object.freeze((action.targets ?? []).map((target) => target.id)),
    selection:projectSelection(action.selection),
    energyCost:Number.isFinite(Number(action.energyCost)) ? Number(action.energyCost) : null
  });
}

/*
功能
从 RootSearchAction record 与 SearchState 恢复 Planner/Simulator 所需 search action。

调用方
WorkerSearchRuntime.runSearchRequest。

输入
record、SearchState 与 actor。

输出
独立 raw search action；找不到卡牌实例时抛错。

读取状态
actor.hand、SearchState players 与 AI/domain definitions。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
Card 字段来自 Definition + SearchState held 概率身份；target 按 ID 从 SearchState players 恢复；selection 原样 data-only。
*/
export function rehydrateRootSearchAction(record, searchState, actor) {
  if (!record || record.type === "end") return { type:"end" };
  if (record.type === "skill") {
    const skill = ACTIVE_SKILL_DEFINITIONS[record.skillId] ?? null;
    if (!skill) throw new Error(`Worker 无法恢复技能：${record.skillId}`);
    return {
      type:"skill",
      skill,
      targets:record.targetIds.map((id) => searchState.players.find((player) => player.id === id)).filter(Boolean),
      energyCost:record.energyCost,
      selection:record.selection ?? null
    };
  }
  if (record.type !== "card" || !record.card) throw new Error("Worker 收到未知 root action type");
  const definition = CARD_DEFINITIONS[record.card.definitionId] ?? null;
  if (!definition) throw new Error(`Worker 无法恢复卡牌定义：${record.card.definitionId}`);
  const held = actor?.hand?.find((card) => card.id === record.card.cardInstanceId) ?? null;
  const card = Object.freeze({
    ...definition,
    ...(held ?? {}),
    id:record.card.cardInstanceId ?? held?.id ?? null
  });
  return {
    type:"card",
    card,
    targets:record.targetIds.map((id) => searchState.players.find((player) => player.id === id)).filter(Boolean),
    selection:record.selection ?? null,
    energyCost:record.energyCost
  };
}
