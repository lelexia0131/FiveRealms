/*
模块职责
唯一拥有主动技能动态成本、合法性与目标决定；固定技能效果数值由 SkillDefinitions 唯一拥有，本模块只转发或按运行状态组合。

上游
core/RuleEngine 与 generals/skillRegistry legacy façades、tests。

下游
Domain TurnRules、CardRules、distance rules 与 SkillDefinitions。

状态边界
只读 canonical facts；不写状态。

信息边界
不读取 controllerType、aiMemory、UI、AI 或 hidden hand。

架构约束
不得依赖 Game/RuleEngine/application/adapters/EventBus；不得 await、emit、随机、mutation；不得复制 SkillDefinitions 固定 literal。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../definitions/skills/SkillDefinitions.js?build=20260816-legacy-recovery";
import { getDistance } from "../distance/DistanceRules.js?build=20260816-legacy-recovery";
import { hasActiveSkillUseRemaining } from "../turn/TurnRules.js?build=20260816-legacy-recovery";

/*
功能
决定主动技能纯静态/当前敌人计数成本。

调用方
skillRegistry adapter 与 tests。

输入
skill facts 与 source facts。

输出
非负整数。

读取状态
skill.cost 与敌人计数。

写入状态
无。

调用函数
Array.filter。

边界与不变量
当前全部主动技能 cost 为 definition.cost；动态 cost 若未来出现由本模块唯一解释。
*/
export function getSkillCost(skill, source, players = []) {
  if (!skill) return 0;
  return Math.max(0, Number(skill.cost) || 0);
}

/*
功能
决定主动技能基础使用合法性。

调用方
skillRegistry adapter 与 tests。

输入
players、sourceId、currentPlayerId、phase、skill facts、usage 与 energy。

输出
{ ok, reason }。

读取状态
source alive/energy 与 skill limit。

写入状态
无。

调用函数
hasActiveSkillUseRemaining。

边界与不变量
reason 与旧 skillRegistry 完全一致。
*/
export function canUseSkillBase({
  players,
  sourceId,
  currentPlayerId,
  phase,
  skill,
  used = 0,
  limitPerTurn = 1,
  energy,
  minimumEnergy = null
}) {
  const source = players.find((player) => player.id === sourceId) ?? null;
  if (!source?.alive || !(phase === "play" && currentPlayerId === sourceId)) {
    return { ok: false, reason: "只能在自己的出牌阶段发动" };
  }
  if (!hasActiveSkillUseRemaining(used, limitPerTurn)) {
    return { ok: false, reason: "本回合发动次数已用尽" };
  }
  if ((energy ?? source.energy) < (minimumEnergy ?? getSkillCost(skill, source, players))) {
    return { ok: false, reason: "能量不足" };
  }
  return { ok: true, reason: "" };
}

/*
功能
返回孤注技能从指定能量计算出的摸牌数量。

调用方
decideSkillEffect 与 AI SkillEffectSimulation。

输入
当前能量值。

输出
非负整数。

读取状态
ACTIVE_SKILL_DEFINITIONS.allIn。

写入状态
无。

调用函数
无。

边界与不变量
AI 概率世界逐 branch 调用本函数，不自行复制 energy - offset 公式。
*/
export function decideAllInDrawCount(energy) {
  const definition = ACTIVE_SKILL_DEFINITIONS.allIn;
  const drawOffset = Math.max(0, Number(definition.drawOffset) || 0);
  return Math.max(0, Math.floor((Number(energy) || 0) - drawOffset));
}

/*
功能
返回孤注技能从指定能量计算出的进入概率。

调用方
decideSkillEffect 与 AI SkillEffectSimulation。

输入
当前能量值。

输出
零到上限之间的概率。

读取状态
ACTIVE_SKILL_DEFINITIONS.allIn。

写入状态
无。

调用函数
无。

边界与不变量
AI 概率世界逐 branch 调用本函数，不自行复制 energy × rate 公式。
*/
export function decideAllInEnterChance(energy) {
  const definition = ACTIVE_SKILL_DEFINITIONS.allIn;
  const rate = Number(definition.enterChancePerEnergy) || 0;
  const cap = definition.enterChanceCap === undefined
    ? 1
    : Math.max(0, Number(definition.enterChanceCap) || 0);
  return Math.min(cap, Math.max(0, Number(energy) || 0) * rate);
}

/*
功能
决定主动技能执行所需的纯数值效果 facts。

调用方
SkillEffectRuntime 与 tests。

输入
skill、source 与 options.energyCost。

输出
冻结 decision。

读取状态
skill.cost/source.energy。

写入状态
无。

调用函数
getSkillCost。

边界与不变量
Application 只执行 decision，不复制数值。
*/
export function decideSkillEffect(skill, source, options = {}) {
  const energyCost = Math.max(0, Number(options.energyCost ?? getSkillCost(skill, source)));
  const definition = ACTIVE_SKILL_DEFINITIONS[skill.id] ?? {};
  if (skill.id === "breakArmy") return Object.freeze({ energyCost, attackLimitBonus: definition.attackLimitBonus });
  if (skill.id === "barrier") return Object.freeze({ energyCost, shieldAmount: definition.shieldAmount });
  if (skill.id === "symbiosis") return Object.freeze({ energyCost, healAmount: definition.healAmount });
  if (skill.id === "stealSkill") return Object.freeze({ energyCost });
  if (skill.id === "burningField") return Object.freeze({ energyCost, damageAmount: definition.damageAmount });
  if (skill.id === "hunt") return Object.freeze({ energyCost, damageAmount: definition.damageAmount, blockedRewardDraw: definition.blockedRewardDraw });
  if (skill.id === "allIn") {
    const currentEnergy = Math.max(0, Number(source.energy) || 0);
    return Object.freeze({
      energyCost: currentEnergy,
      drawCount: decideAllInDrawCount(currentEnergy),
      enterChance: decideAllInEnterChance(currentEnergy)
    });
  }
  if (skill.id === "resonance") return Object.freeze({ energyCost, drawCount: definition.drawCount });
  return Object.freeze({ energyCost });
}

/*
功能
决定主动技能合法目标 ID。

调用方
RuleEngine adapter 与 tests。

输入
players、sourceId 与 skill facts。

输出
目标 ID 数组。

读取状态
alive/battleTeam/status/hand/equipment/range facts。

写入状态
无。

调用函数
getDistance。

边界与不变量
每个 skill 的目标语义只在本模块维护。
*/
export function getSkillTargetIds(players, sourceId, skill, isRangeLegal = null) {
  const source = players.find((player) => player.id === sourceId) ?? null;
  if (!source?.alive || !skill?.rangeRule) return [];
  const alive = players.filter((player) => player.alive);
  let candidates = [];
  if (skill.id === "barrier") candidates = alive.filter((player) => player.battleTeam === source.battleTeam);
  else if (skill.id === "resonance") candidates = alive.filter((player) => player.battleTeam === source.battleTeam);
  else if (skill.id === "symbiosis") candidates = alive.filter((player) => player.battleTeam === source.battleTeam && player.hp < player.maxHp);
  else if (skill.id === "stealSkill") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && (player.handCount > 0 || player.equipmentDefinitionId));
  else if (skill.id === "hunt") candidates = alive.filter((player) => player.battleTeam !== source.battleTeam && player.huntMarkSourceId === source.id);
  /*
  功能
  判断技能目标是否在 range rule 范围内。

  调用方
  getSkillTargetIds。

  输入
  target projection。

  输出
  布尔值。

  读取状态
  distance facts。

  写入状态
  无。

  调用函数
  getDistance。

  边界与不变量
  range 使用 skill.range 或 source.attackRange。
  */
  const inRange = (target) => {
    const range = skill.range ?? source.attackRange ?? 1;
    if (typeof isRangeLegal === "function") {
      return Boolean(isRangeLegal(source, target, range));
    }
    const distance = getDistance(
      players, source, target,
      source.equipmentDefinitionId ?? null,
      target.equipmentDefinitionId ?? null
    );
    return Number.isFinite(distance) && distance <= range;
  };
  if (skill.rangeRule === "attack") return candidates.filter(inRange).map((player) => player.id);
  if (skill.rangeRule === "fixed") return candidates.filter(inRange).map((player) => player.id);
  if (["unlimited", "ally"].includes(skill.rangeRule)) return candidates.map((player) => player.id);
  return skill.rangeRule === "self" && candidates.some((player) => player.id === source.id) ? [source.id] : [];
}
