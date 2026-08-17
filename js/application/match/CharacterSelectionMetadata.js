/*
模块职责
唯一拥有角色征召时用于阵容多样性与候选标签的产品策略元数据。

上游
CharacterSelection 与 UI candidate presentation。

下游
无。

状态边界
纯静态只读元数据，不读取或写入 MatchState。

信息边界
全部字段均为公开角色定位。

架构约束
不得复制 Character/Skill 领域定义，不得进入 AI 搜索价值或合法性。
*/

export const CHARACTER_SELECTION_TAGS = Object.freeze({
  "blade-walker": Object.freeze(["输出", "爆发"]),
  "oath-warden": Object.freeze(["防护", "辅助"]),
  "spirit-medic": Object.freeze(["恢复", "辅助"]),
  "shade-agent": Object.freeze(["控制", "辅助"]),
  "ember-magus": Object.freeze(["群攻", "爆发"]),
  "trail-hunter": Object.freeze(["突破", "爆发"]),
  "fate-gambler": Object.freeze(["输出", "爆发"]),
  "resonance-tuner": Object.freeze(["过牌", "辅助"])
});

export const SMALL_TEAM_CHARACTER_PRIORITY = Object.freeze({
  "ember-magus": 10,
  "trail-hunter": 9,
  "oath-warden": 8,
  "blade-walker": 5,
  "resonance-tuner": 3
});
