/**
 * 主动技能 lookup/legacy façade。Domain Skill Rules 拥有 canUse/target/cost；
 * Application SkillEffectRuntime 拥有 execute；Application Trigger 拥有 passive registration。
 */
import { ACTIVE_SKILL_DEFINITIONS, PASSIVE_SKILL_DEFINITIONS } from "../domain/definitions/skills/SkillDefinitions.js?build=20260815-shadow-agent-p1-slot";
import { removeStatus, setStatus } from "../domain/state/transitions/StatusTransitions.js?build=20260815-shadow-agent-p1-slot";
import { RuleEngine } from "../core/RuleEngine.js?build=20260815-shadow-agent-p1-slot";
import { getActiveSkillUseCount } from "../domain/rules/turn/TurnRules.js?build=20260815-shadow-agent-p1-slot";
import { canUseSkillBase, getSkillCost as getDomainSkillCost } from "../domain/rules/skill/SkillRules.js?build=20260815-shadow-agent-p1-slot";

/*
功能
转发被动技能 trigger registration 到 Application Trigger。

调用方
Game temporary composition 与 tests。

输入
game。

输出
无。

读取状态
game.passiveTriggerRegistry。

写入状态
listener registrations。

调用函数
passiveTriggerRegistry.registerForPlayers。

边界与不变量
本文件不含 passive trigger semantic。
*/
export function registerPassiveSkills(game) {
  game.passiveTriggerRegistry.registerForPlayers(game.state.players);
}



/*
功能
解析主动技能当前实际能量成本。

调用方
ActionWorkflow/skillRegistry 与 tests。

输入
gameOrState、source 与 skill。

输出
非负整数。

读取状态
skill.getCost 或 Domain SkillRule cost。

写入状态
无。

调用函数
getDomainSkillCost。

边界与不变量
成本 formula 由 Domain SkillRule 唯一拥有。
*/
export function getActiveSkillCost(gameOrState, source, skill) {
  if (!skill) return 0;
  const rawCost = typeof skill.getCost === "function"
    ? skill.getCost(gameOrState, source)
    : getDomainSkillCost(skill, source);
  return Math.max(0, Number(rawCost) || 0);
}

const baseCanUse = (game, source, skill, minimumEnergy = getActiveSkillCost(game, source, skill)) => {
  const players = game?.state?.players ?? game?.players ?? [source];
  const used = getActiveSkillUseCount(source.turnFlags, skill.id);
  return canUseSkillBase({
    players,
    sourceId: source.id,
    currentPlayerId: game.currentPlayer?.id ?? game.state?.currentPlayerId ?? null,
    phase: game.state?.phase ?? game.phase ?? "idle",
    skill,
    used,
    limitPerTurn: skill.limitPerTurn ?? 1,
    energy: source.energy,
    minimumEnergy
  });
};

/*
功能
把 Domain Skill Definition 投影为 ACTIVE_SKILLS 既有 runtime shape。

调用方
ACTIVE_SKILLS 模块初始化。

输入
active skill definition id。

输出
只含旧 runtime 字段的技能对象，不包含 description。

读取状态
ACTIVE_SKILL_DEFINITIONS。

写入状态
无。

调用函数
无。

边界与不变量
不维护任何 cost/limit/target/range literal；字段顺序与迁移前一致。
*/
const runtimeSkill = (skillId) => {
  const definition = ACTIVE_SKILL_DEFINITIONS[skillId];
  return {
    id: definition.id,
    name: definition.name,
    cost: definition.cost,
    limitPerTurn: definition.limitPerTurn,
    targetType: definition.targetType,
    rangeRule: definition.rangeRule,
    ...(definition.range !== undefined ? { range: definition.range } : {})
  };
};

export const ACTIVE_SKILLS = Object.freeze({
  breakArmy: Object.freeze({
    ...runtimeSkill("breakArmy"),
    canUse(game, source) { return baseCanUse(game, source, this); },
    /*
    功能
    提交破军技能已决定的费用与攻击上限变化。

    调用方
    Game.useActiveSkill。

    输入
    Game 与 source。

    输出
    无显式返回值。

    读取状态
    source 能量与 attackLimit。

    写入状态
    能量经 ResourceTransition；attackLimit 经 RuleUsageTransition。

    调用函数
    changeEnergy、incrementAttackLimit。

    边界与不变量
    不重新判断技能合法性。
    */
    async execute(game, source) { return game.skillEffectRuntime.execute(this, source, []); }
  }),
  barrier: Object.freeze({
    ...runtimeSkill("barrier"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? { ok:false, reason:"没有存活队友" } : base; },
    /*
    功能
    提交壁垒技能已决定的护盾写入。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量与 target。

    写入状态
    能量经 Player façade；护盾经 ResourceTransition。

    调用函数
    changeShield、Player.changeEnergy。

    边界与不变量
    不重新判断技能合法性。
    */
    async execute(game, source, targets) { return game.skillEffectRuntime.execute(this, source, targets); }
  }),
  symbiosis: Object.freeze({
    ...runtimeSkill("symbiosis"),
    canUse(game, source) { const base = baseCanUse(game, source, this); if (!base.ok) return base; return RuleEngine.getSkillTargets(game, source, this).length ? base : {ok:false,reason:"自己和队友都未受伤"}; },
    /*
    功能
    提交滋荣技能已决定的费用与治疗 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量与 target。

    写入状态
    能量经 ResourceTransition；治疗经 Game.heal。

    调用函数
    changeEnergy、game.heal。

    边界与不变量
    日志顺序不变。
    */
    async execute(game, source, targets) { return game.skillEffectRuntime.execute(this, source, targets); }
  }),
  stealSkill: Object.freeze({
    ...runtimeSkill("stealSkill"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"距离2内没有持有手牌或装备的敌人"} : base; },
    /*
    功能
    提交窃取技能已决定的费用、随机资源选择与移动 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量、target 手牌/装备与随机源。

    写入状态
    能量经 ResourceTransition；移动经 Game zone workflow。

    调用函数
    changeEnergy、randomChoice、game.moveEquipmentToHand/moveCardBetweenHands。

    边界与不变量
    随机调用与日志顺序不变。
    */
    async execute(game, source, targets) { return game.skillEffectRuntime.execute(this, source, targets); }
  }),
  burningField: Object.freeze({
    ...runtimeSkill("burningField"),
    canUse(game, source, energyCost = getActiveSkillCost(game, source, this)) {
      return baseCanUse(game, source, this, energyCost);
    },
    /*
    功能
    提交焚场技能已决定的费用与逐目标伤害 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source、targets 与 context。

    输出
    无显式返回值。

    读取状态
    source 能量、敌人与 Game workflow。

    写入状态
    能量经 ResourceTransition；伤害经 Game.damage。

    调用函数
    changeEnergy、game.damage。

    边界与不变量
    逐目标顺序与响应顺序不变。
    */
    async execute(game, source, targets, context = {}) { return game.skillEffectRuntime.execute(this, source, targets, context); }
  }),
  hunt: Object.freeze({
    ...runtimeSkill("hunt"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有猎印目标"} : base; },
    /*
    功能
    提交猎杀技能已决定的费用、状态移除与伤害 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量、target 状态与 Game workflow。

    写入状态
    能量经 Player façade；status 经 StatusTransition。

    调用函数
    removeStatus、game.damage。

    边界与不变量
    不重新判断技能合法性。
    */
    async execute(game, source, targets) { return game.skillEffectRuntime.execute(this, source, targets); }
  }),
  allIn: Object.freeze({
    ...runtimeSkill("allIn"),
    canUse(game, source) {
      return baseCanUse(game, source, this, 1);
    },
    /*
    功能
    提交孤注技能已决定的资源消耗、摸牌与状态写入。

    调用方
    Game.useActiveSkill。

    输入
    Game 与 source。

    输出
    无显式返回值。

    读取状态
    source 能量、Game 随机源与状态。

    写入状态
    能量经 Player façade；状态经 StatusTransition。

    调用函数
    setStatus、game.drawCards。

    边界与不变量
    随机调用次数与日志顺序不变。
    */
    async execute(game, source) { return game.skillEffectRuntime.execute(this, source, []); }
  }),
  resonance: Object.freeze({
    ...runtimeSkill("resonance"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有存活队友"} : base; },
    /*
    功能
    提交共鸣技能已决定的费用与摸牌 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量与目标。

    写入状态
    能量经 ResourceTransition；摸牌经 Game.drawCards。

    调用函数
    changeEnergy、game.drawCards。

    边界与不变量
    日志顺序不变。
    */
    async execute(game, source, targets) { return game.skillEffectRuntime.execute(this, source, targets); }
  })
});

/** 返回玩家唯一主动技能配置；角色第一版各有一个主动技能。 */
export function getActiveSkill(player) {
  const skillId = player.general?.activeSkillIds[0];
  return skillId ? ACTIVE_SKILLS[skillId] ?? null : null;
}

/** 检查所有配置技能是否均有实现，供自动测试使用。 */
export function hasActiveSkill(skillId) {
  return Boolean(ACTIVE_SKILLS[skillId]);
}

/*
功能
查询被动技能定义是否存在。

调用方
tests。

输入
skillId。

输出
布尔值。

读取状态
PASSIVE_SKILL_DEFINITIONS。

写入状态
无。

调用函数
无。

边界与不变量
不查询 trigger runtime。
*/
export function hasPassiveSkill(skillId) {
  return Boolean(PASSIVE_SKILL_DEFINITIONS[skillId]);
}
