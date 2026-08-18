/*
模块职责
唯一拥有角色的 UI glyph 与 portrait；角色名称、规则与技能事实继续由 Domain Definitions 拥有。

上游
UI templates 与 presentation asset tests。

下游
无。

状态边界
纯静态只读展示元数据，不读取或写入 MatchState。

信息边界
全部字段均为公开展示资产。

架构约束
不得包含 AI profile/roleTags、技能 cost/limit 或角色规则副本。
*/
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { ACTIVE_SKILL_DEFINITIONS, PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { CHARACTER_SELECTION_TAGS } from "../../application/match/CharacterSelectionMetadata.js?build=20260818-skill-rules-locality-refactor";

export const CHARACTER_PRESENTATION = Object.freeze({
  "blade-walker": Object.freeze({ glyph: "刃", portrait: "./assets/characters/blade-walker.svg" }),
  "oath-warden": Object.freeze({ glyph: "誓", portrait: "./assets/characters/oath-warden.svg" }),
  "spirit-medic": Object.freeze({ glyph: "灵", portrait: "./assets/characters/spirit-medic.svg" }),
  "shade-agent": Object.freeze({ glyph: "影", portrait: "./assets/characters/shade-agent.svg" }),
  "ember-magus": Object.freeze({ glyph: "炎", portrait: "./assets/characters/ember-magus.svg" }),
  "trail-hunter": Object.freeze({ glyph: "猎", portrait: "./assets/characters/trail-hunter.svg" }),
  "fate-gambler": Object.freeze({ glyph: "赌", portrait: "./assets/characters/fate-gambler.svg" }),
  "resonance-tuner": Object.freeze({ glyph: "律", portrait: "./assets/characters/resonance-tuner.svg" })
});

/*
功能
返回指定角色的 UI presentation metadata。

调用方
UI templates。

输入
characterId。

输出
冻结 metadata 或 null。

读取状态
CHARACTER_PRESENTATION。

写入状态
无。

调用函数
无。

边界与不变量
未知角色不回退到另一角色，避免展示与领域身份错配。
*/
export function getCharacterPresentation(characterId) {
  return CHARACTER_PRESENTATION[characterId] ?? null;
}

/*
功能
把领域角色定义投影为 UI 所需的角色与技能展示视图。

调用方
征召卡片、玩家席位与技能详情模板。

输入
领域角色定义或角色 ID。

输出
包含角色、素材、征召标签与技能展示字段的新对象；未知角色返回 null。

读取状态
Domain Character/Skill definitions 与 UI/Application presentation metadata。

写入状态
无。

调用函数
getCharacterPresentation。

边界与不变量
只组合公开展示数据，不向领域实体写回 presentation 字段。
*/
export function presentCharacter(character) {
  const definition = typeof character === "string" ? CHARACTER_BY_ID[character] : character;
  if (!definition) return null;
  const active = ACTIVE_SKILL_DEFINITIONS[definition.activeSkillIds?.[0]];
  const passive = PASSIVE_SKILL_DEFINITIONS[definition.passiveSkillIds?.[0]];
  return {
    ...definition,
    ...getCharacterPresentation(definition.id),
    tags:CHARACTER_SELECTION_TAGS[definition.id] ?? [],
    activeName:active?.name ?? "",
    activeDescription:active?.description ?? "",
    activeCost:active?.cost ?? 0,
    activeLimitPerTurn:active?.limitPerTurn ?? 0,
    passiveName:passive?.name ?? "",
    passiveDescription:passive?.description ?? "",
    passiveTriggerText:passive?.triggerText ?? "",
    passiveLimitText:passive?.limitText ?? ""
  };
}
