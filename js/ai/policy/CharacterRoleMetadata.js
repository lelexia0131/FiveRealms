/*
模块职责
唯一拥有 AI 对角色公开战术定位的静态标签；不拥有角色规则、价值权重或选择算法。

上游
AI VisibleState、ResponseBoundary 与 TransferPolicy。

下游
无。

状态边界
纯静态只读元数据，不读取或写入 GameState/SearchState。

信息边界
标签全部来自公开角色身份，不含隐藏信息。

架构约束
不得复制 CharacterDefinitions、SkillDefinitions 或 AI 评分公式。
*/

export const CHARACTER_ROLE_TAGS = Object.freeze({
  "blade-walker": Object.freeze(["damage", "attacker"]),
  "oath-warden": Object.freeze(["tank", "support"]),
  "spirit-medic": Object.freeze(["support", "healer"]),
  "shade-agent": Object.freeze(["control", "utility"]),
  "ember-magus": Object.freeze(["damage", "caster"]),
  "trail-hunter": Object.freeze(["damage", "control"]),
  "fate-gambler": Object.freeze(["damage", "resource"]),
  "resonance-tuner": Object.freeze(["support", "control"])
});

/*
功能
返回角色的公开 AI 战术标签副本。

调用方
AI 状态投影与真实执行边界。

输入
characterId。

输出
新数组；未知角色返回空数组。

读取状态
CHARACTER_ROLE_TAGS。

写入状态
无。

调用函数
无。

边界与不变量
调用方可安全修改返回数组，不会改写静态 metadata。
*/
export function getCharacterRoleTags(characterId) {
  return [...(CHARACTER_ROLE_TAGS[characterId] ?? [])];
}
