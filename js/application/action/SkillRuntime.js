/*
模块职责
把真实 Player 的角色技能身份投影为 Domain Skill Definition，并组合技能使用合法性。

上游
ActionWorkflow、UI 与 composition root。

下游
Domain Skill/Turn rules、SkillDefinitions 与 ActionLegality。

状态边界
只读真实 match state；不写能量、次数、状态或效果。

信息边界
只读取公开角色技能与执行者自己的资源事实。

架构约束
不得复制技能定义、实现技能效果、注册被动触发或提供兼容 runtime shape。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getActiveSkillUseCount } from "../../domain/rules/turn/TurnRules.js";
import { canUseSkillBase, getSkillCost as getDomainSkillCost } from "../../domain/rules/skill/SkillRules.js";
import { ActionLegality } from "./ActionLegality.js";

/*
功能
解析主动技能当前实际能量成本。

调用方
ActionWorkflow、AI 执行边界与测试。

输入
真实 match、source 与 Domain skill definition。

输出
非负整数。

读取状态
skill 与 source。

写入状态
无。

调用函数
getDomainSkillCost。

边界与不变量
成本公式由 Domain SkillRules 唯一拥有；孤注的最低发动能量在合法性入口处理。
*/
export function getActiveSkillCost(_match, source, skill) {
  if (!skill) return 0;
  return Math.max(0, Number(getDomainSkillCost(skill, source)) || 0);
}

/*
功能
返回玩家唯一主动技能的 Domain definition。

调用方
ActionWorkflow、UI 与 AI 执行边界。

输入
真实 Player 或同形公开玩家。

输出
冻结技能定义或 null。

读取状态
player.character.activeSkillIds。

写入状态
无。

调用函数
无。

边界与不变量
不创建带 canUse/execute 方法的第二份技能对象。
*/
export function getActiveSkill(player) {
  const skillId = player?.character?.activeSkillIds?.[0] ?? player?.activeSkillId ?? null;
  return skillId ? ACTIVE_SKILL_DEFINITIONS[skillId] ?? null : null;
}

/*
功能
组合 Domain 基础条件与真实目标存在性，判断主动技能能否发动。

调用方
ActionWorkflow 与执行边界测试。

输入
真实 match、source、Domain skill definition 与可选显式成本。

输出
{ ok, reason }。

读取状态
当前玩家/阶段、技能次数、能量与合法目标。

写入状态
无。

调用函数
canUseSkillBase、getActiveSkillUseCount、getActiveSkillCost、ActionLegality.getSkillTargets。

边界与不变量
目标公式仍由 Domain SkillRules 拥有；本入口只把实体投影结果映射为既有拒绝文案。
*/
export function canUseActiveSkill(match, source, skill, explicitCost = null) {
  if (!skill || !source) return { ok:false, reason:"没有可用技能" };
  const players = match?.state?.players ?? match?.players ?? [source];
  const minimumEnergy = skill.id === "allIn"
    ? 1
    : (explicitCost ?? getActiveSkillCost(match, source, skill));
  const base = canUseSkillBase({
    players,
    sourceId:source.id,
    currentPlayerId:match?.currentPlayer?.id ?? match?.state?.currentPlayerId ?? null,
    phase:match?.state?.phase ?? match?.phase ?? "idle",
    skill,
    used:getActiveSkillUseCount(source.turnFlags, skill.id),
    limitPerTurn:skill.limitPerTurn ?? 1,
    energy:source.energy,
    minimumEnergy
  });
  if (!base.ok || ["breakArmy", "allIn"].includes(skill.id)) return base;
  if (ActionLegality.getSkillTargets(match, source, skill).length) return base;
  const reasons = {
    barrier:"没有存活队友",
    symbiosis:"自己和队友都未受伤",
    stealSkill:"距离2内没有持有手牌或装备的敌人",
    hunt:"没有猎印目标",
    resonance:"没有存活队友"
  };
  return { ok:false, reason:reasons[skill.id] ?? "没有合法目标" };
}
