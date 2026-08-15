/**
 * 旧角色配置 façade。纯角色与技能静态定义已分别由
 * domain/definitions/characters 与 domain/definitions/skills 单一拥有；
 * 本文件继续保留 AI profile、portrait、展示标签与旧 GENERAL_DEFINITIONS API shape。
 */
import { CHARACTER_DEFINITIONS } from "../domain/definitions/characters/CharacterDefinitions.js?build=20260815-shadow-agent-p1-slot";
import { ACTIVE_SKILL_DEFINITIONS, PASSIVE_SKILL_DEFINITIONS } from "../domain/definitions/skills/SkillDefinitions.js?build=20260815-shadow-agent-p1-slot";

/*
功能
创建 AI 风格 profile 的冻结对象。

调用方
generalConfig 模块初始化。

输入
八个 AI profile 数值。

输出
冻结的 profile 对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
字段顺序与旧 profile 完全一致；不参与任何 Domain 定义。
*/
const profile = (aggression, defense, support, healingPriority, cardConservation, energyConservation, responseConservation, riskTolerance) => Object.freeze({
  aggression, defense, support, healingPriority, cardConservation, energyConservation, responseConservation, riskTolerance
});

const CHARACTER_PRESENTATION = Object.freeze({
  "blade-walker": Object.freeze({
    glyph: "刃",
    portrait: "./assets/characters/blade-walker.svg",
    tags: ["输出", "爆发"],
    roleTags: ["damage", "attacker"],
    aiProfile: profile(1.35, .65, .35, .45, .55, .55, .5, 1.05)
  }),
  "oath-warden": Object.freeze({
    glyph: "誓",
    portrait: "./assets/characters/oath-warden.svg",
    tags: ["防护", "辅助"],
    roleTags: ["tank", "support"],
    aiProfile: profile(.6, 1.45, 1.25, .7, .8, .85, .9, .45)
  }),
  "spirit-medic": Object.freeze({
    glyph: "灵",
    portrait: "./assets/characters/spirit-medic.svg",
    tags: ["恢复", "辅助"],
    roleTags: ["support", "healer"],
    aiProfile: profile(.45, .95, 1.45, 1.5, .75, .9, .85, .35)
  }),
  "shade-agent": Object.freeze({
    glyph: "影",
    portrait: "./assets/characters/shade-agent.svg",
    tags: ["控制", "辅助"],
    roleTags: ["control", "utility"],
    aiProfile: profile(1.05, .75, .4, .4, .9, .65, .85, 1.1)
  }),
  "ember-magus": Object.freeze({
    glyph: "炎",
    portrait: "./assets/characters/ember-magus.svg",
    tags: ["群攻", "爆发"],
    roleTags: ["damage", "caster"],
    aiProfile: profile(1.45, .45, .25, .3, .45, .55, .45, 1.25)
  }),
  "trail-hunter": Object.freeze({
    glyph: "猎",
    portrait: "./assets/characters/trail-hunter.svg",
    tags: ["突破", "爆发"],
    roleTags: ["damage", "control"],
    aiProfile: profile(1.3, .7, .35, .45, .65, .75, .65, .95)
  }),
  "fate-gambler": Object.freeze({
    glyph: "赌",
    portrait: "./assets/characters/fate-gambler.svg",
    tags: ["输出", "爆发"],
    roleTags: ["damage", "resource"],
    aiProfile: profile(1.05, .55, .4, .4, .35, .25, .4, 1.5)
  }),
  "resonance-tuner": Object.freeze({
    glyph: "律",
    portrait: "./assets/characters/resonance-tuner.svg",
    tags: ["过牌", "辅助"],
    roleTags: ["support", "control"],
    aiProfile: profile(.6, .8, 1.45, .9, .7, .8, .75, .55)
  })
});

/*
功能
克隆数组字段，保持 legacy GENERAL_DEFINITIONS 的数组与 Domain authority 相互隔离。

调用方
legacyCharacter。

输入
数组或标量字段值。

输出
数组返回新浅拷贝，其余值原样返回。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只隔离数组可变性，不复制领域或 presentation 对象身份。
*/
const projectLegacyArray = (value) => Array.isArray(value) ? [...value] : value;

/*
功能
把 Domain Character 与 Domain Skill 定义投影为当前公开 GENERAL_DEFINITIONS 完整对象 shape。

调用方
generalConfig 模块初始化。

输入
角色领域定义、主动/被动技能领域定义与角色 presentation metadata。

输出
冻结的旧版角色对象，字段顺序与迁移前一致。

读取状态
CHARACTER_DEFINITIONS、ACTIVE_SKILL_DEFINITIONS、PASSIVE_SKILL_DEFINITIONS、CHARACTER_PRESENTATION。

写入状态
无。

调用函数
无。

边界与不变量
不维护任何角色或技能领域字段 literal；AI/UI 字段只来自 CHARACTER_PRESENTATION。
*/

const legacyCharacter = (character) => {
  const presentation = CHARACTER_PRESENTATION[character.id];
  const active = ACTIVE_SKILL_DEFINITIONS[character.activeSkillIds[0]];
  const passive = PASSIVE_SKILL_DEFINITIONS[character.passiveSkillIds[0]];
  return Object.freeze({
    id: character.id,
    name: character.name,
    glyph: presentation.glyph,
    portrait: presentation.portrait,
    loreFaction: character.loreFaction,
    maxHp: character.maxHp,
    initialEnergy: character.initialEnergy,
    tags: projectLegacyArray(presentation.tags),
    roleTags: projectLegacyArray(presentation.roleTags),
    passiveSkillIds: projectLegacyArray(character.passiveSkillIds),
    activeSkillIds: projectLegacyArray(character.activeSkillIds),
    passiveName: passive.name,
    passiveDescription: passive.description,
    passiveTriggerText: passive.triggerText,
    passiveLimitText: passive.limitText,
    activeName: active.name,
    activeDescription: active.description,
    activeCost: active.cost,
    activeLimitPerTurn: active.limitPerTurn,
    description: character.description,
    aiProfile: presentation.aiProfile
  });
};

export const GENERAL_DEFINITIONS = Object.freeze(CHARACTER_DEFINITIONS.map(legacyCharacter));

export const GENERAL_BY_ID = Object.freeze(Object.fromEntries(GENERAL_DEFINITIONS.map((general) => [general.id, general])));
