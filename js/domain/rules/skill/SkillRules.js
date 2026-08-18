/*
模块职责
唯一拥有主动技能动态成本、合法性与目标决定；固定技能效果数值由 SkillDefinitions 唯一拥有，本模块只转发或按运行状态组合。

上游
Application ActionLegality、skill runtime 与 tests。

下游
Domain TurnRules、CardRules、distance rules 与 SkillDefinitions。

状态边界
只读 canonical facts；不写状态。

信息边界
不读取 controllerType、aiMemory、UI、AI 或 hidden hand。

架构约束
不得依赖 Game/ActionLegality/application/adapters/EventDispatcher；不得 await、emit、随机、mutation；不得复制 SkillDefinitions 固定 literal。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../definitions/skills/SkillDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { getDistance } from "../distance/DistanceRules.js?build=20260818-skill-rules-locality-refactor";
import { hasActiveSkillUseRemaining } from "../turn/TurnRules.js?build=20260818-skill-rules-locality-refactor";

/*
功能
判断技能候选目标是否满足距离规则。

调用方
filterSkillCandidatesByRange。

输入
players、source、target、skill facts 与可选距离校验回调。

输出
目标在规则范围内时返回 true。

读取状态
source/target 装备与 skill.range、source.attackRange。

写入状态
无。

调用函数
isRangeLegal 回调或 getDistance。

边界与不变量
保留外部回调的 source、target、range 参数契约；没有回调时使用实时距离事实。
*/
function isSkillTargetInRange(players, source, target, skill, isRangeLegal) {
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
}

/*
功能
按技能 rangeRule 将候选角色转换为合法目标 ID。

调用方
getSkillTargetIds。

输入
players、source、skill facts、候选角色与可选距离校验回调。

输出
保持原候选顺序的目标 ID 数组。

读取状态
skill.rangeRule 与候选角色身份。

写入状态
无。

调用函数
isSkillTargetInRange。

边界与不变量
attack/fixed 才进行距离过滤；unlimited/ally 不读取距离；self 只返回已经枚举到的 source。
*/
function filterSkillCandidatesByRange(players, source, skill, candidates, isRangeLegal) {
  if (["attack", "fixed"].includes(skill.rangeRule)) {
    return candidates
      .filter((target) => isSkillTargetInRange(players, source, target, skill, isRangeLegal))
      .map((player) => player.id);
  }
  if (["unlimited", "ally"].includes(skill.rangeRule)) return candidates.map((player) => player.id);
  return skill.rangeRule === "self" && candidates.some((player) => player.id === source.id) ? [source.id] : [];
}

const SKILL_RULES = Object.freeze({
  breakArmy: {
    decideEffect: ({ energyCost }) => Object.freeze({
      energyCost,
      attackLimitBonus: ACTIVE_SKILL_DEFINITIONS.breakArmy.attackLimitBonus
    })
  },

  barrier: {
    decideEffect: ({ energyCost }) => Object.freeze({
      energyCost,
      shieldAmount: ACTIVE_SKILL_DEFINITIONS.barrier.shieldAmount
    }),
    getCandidates: (alive, source) => alive.filter((player) => player.battleTeam === source.battleTeam)
  },

  symbiosis: {
    decideEffect: ({ energyCost }) => Object.freeze({
      energyCost,
      healAmount: ACTIVE_SKILL_DEFINITIONS.symbiosis.healAmount
    }),
    getCandidates: (alive, source) => alive.filter((player) => (
      player.battleTeam === source.battleTeam && player.hp < player.maxHp
    ))
  },

  stealSkill: {
    getCandidates: (alive, source) => alive.filter((player) => (
      player.battleTeam !== source.battleTeam && (player.handCount > 0 || player.equipmentDefinitionId)
    ))
  },

  burningField: {
    decideEffect: ({ energyCost }) => Object.freeze({
      energyCost,
      damageAmount: ACTIVE_SKILL_DEFINITIONS.burningField.damageAmount
    }),
    getCandidates: (alive, source) => alive.filter((player) => player.battleTeam !== source.battleTeam)
  },

  hunt: {
    decideEffect: ({ energyCost }) => Object.freeze({
      energyCost,
      damageAmount: ACTIVE_SKILL_DEFINITIONS.hunt.damageAmount,
      blockedRewardDraw: ACTIVE_SKILL_DEFINITIONS.hunt.blockedRewardDraw
    }),
    getCandidates: (alive, source) => alive.filter((player) => (
      player.battleTeam !== source.battleTeam && player.huntMarkSourceId === source.id
    ))
  },

  allIn: {
    /*
    功能
    返回孤注技能从指定能量计算出的摸牌数量。

    调用方
    decideAllInDrawCount 与 decideSkillEffect。

    输入
    当前能量值。

    输出
    非负整数。

    读取状态
    ACTIVE_SKILL_DEFINITIONS.allIn.drawOffset。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    AI 概率世界逐 branch 调用本规则，不自行复制 energy - offset 公式。
    */
    getDrawCount(energy) {
      const definition = ACTIVE_SKILL_DEFINITIONS.allIn;
      const drawOffset = Math.max(0, Number(definition.drawOffset) || 0);
      return Math.max(0, Math.floor((Number(energy) || 0) - drawOffset));
    },

    /*
    功能
    返回孤注技能从指定能量计算出的进入概率。

    调用方
    decideAllInEnterChance 与 decideSkillEffect。

    输入
    当前能量值。

    输出
    零到上限之间的概率。

    读取状态
    ACTIVE_SKILL_DEFINITIONS.allIn.enterChancePerEnergy/enterChanceCap。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    AI 概率世界逐 branch 调用本规则，不自行复制 energy × rate 公式。
    */
    getEnterChance(energy) {
      const definition = ACTIVE_SKILL_DEFINITIONS.allIn;
      const rate = Number(definition.enterChancePerEnergy) || 0;
      const cap = definition.enterChanceCap === undefined
        ? 1
        : Math.max(0, Number(definition.enterChanceCap) || 0);
      return Math.min(cap, Math.max(0, Number(energy) || 0) * rate);
    },

    /*
    功能
    组合孤注技能的运行态效果 facts。

    调用方
    decideSkillEffect。

    输入
    source fact。

    输出
    冻结的孤注效果 decision。

    读取状态
    source.energy 与本 block 的动态计算规则。

    写入状态
    无。

    调用函数
    getDrawCount、getEnterChance。

    边界与不变量
    energyCost、drawCount 与 enterChance 都基于同一发动瞬间能量；实际消耗为全部能量。
    */
    decideEffect({ source }) {
      const currentEnergy = Math.max(0, Number(source.energy) || 0);
      return Object.freeze({
        energyCost: currentEnergy,
        drawCount: this.getDrawCount(currentEnergy),
        enterChance: this.getEnterChance(currentEnergy)
      });
    }
  },

  resonance: {
    decideEffect: ({ energyCost }) => Object.freeze({
      energyCost,
      drawCount: ACTIVE_SKILL_DEFINITIONS.resonance.drawCount
    }),
    getCandidates: (alive, source) => alive.filter((player) => player.battleTeam === source.battleTeam)
  }
});

/*
功能
决定主动技能纯定义成本。

调用方
Application SkillRuntime、AI state/search 与 tests。

输入
skill facts；source 与 players 参数仅为稳定调用签名保留。

输出
非负整数。

读取状态
skill.cost。

写入状态
无。

调用函数
无。

边界与不变量
当前全部主动技能 cost 由 SkillDefinitions 提供；本函数不恢复旧的 enemy-count dynamic cost。
*/
export function getSkillCost(skill, source, players = []) {
  if (!skill) return 0;
  return Math.max(0, Number(skill.cost) || 0);
}

/*
功能
决定主动技能基础使用合法性。

调用方
Application SkillRuntime 与 tests。

输入
players、sourceId、currentPlayerId、phase、skill facts、usage 与 energy。

输出
{ ok, reason }。

读取状态
source alive/energy 与 skill limit。

写入状态
无。

调用函数
hasActiveSkillUseRemaining、getSkillCost。

边界与不变量
reason 保持既定公开拒绝文案；该 gate 不承载技能特有目标规则。
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
AI SkillEffectSimulation、decideSkillEffect 与 tests。

输入
当前能量值。

输出
非负整数。

读取状态
SKILL_RULES.allIn 与 ACTIVE_SKILL_DEFINITIONS.allIn。

写入状态
无。

调用函数
SKILL_RULES.allIn.getDrawCount。

边界与不变量
保持稳定 public API；AI 概率世界逐 branch 使用同一动态公式。
*/
export function decideAllInDrawCount(energy) {
  return SKILL_RULES.allIn.getDrawCount(energy);
}

/*
功能
返回孤注技能从指定能量计算出的进入概率。

调用方
AI SkillEffectSimulation、decideSkillEffect 与 tests。

输入
当前能量值。

输出
零到上限之间的概率。

读取状态
SKILL_RULES.allIn 与 ACTIVE_SKILL_DEFINITIONS.allIn。

写入状态
无。

调用函数
SKILL_RULES.allIn.getEnterChance。

边界与不变量
保持稳定 public API；概率按定义的 rate 与 cap 限制在合法范围。
*/
export function decideAllInEnterChance(energy) {
  return SKILL_RULES.allIn.getEnterChance(energy);
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
skill.cost/source.energy 与对应 SKILL_RULES block。

写入状态
无。

调用函数
getSkillCost、SKILL_RULES.*.decideEffect。

边界与不变量
Application 只执行 decision；固定效果数值继续由 SkillDefinitions 唯一拥有。
*/
export function decideSkillEffect(skill, source, options = {}) {
  const energyCost = Math.max(0, Number(options.energyCost ?? getSkillCost(skill, source)));
  const rule = SKILL_RULES[skill.id];
  return rule?.decideEffect?.({ energyCost, source, skill }) ?? Object.freeze({ energyCost });
}

/*
功能
决定主动技能合法目标 ID。

调用方
ActionLegality adapter、AI ActionGenerator 与 tests。

输入
players、sourceId、skill facts 与可选距离校验回调。

输出
目标 ID 数组。

读取状态
alive/battleTeam/status/hand/equipment/range facts。

写入状态
无。

调用函数
SKILL_RULES.*.getCandidates、filterSkillCandidatesByRange。

边界与不变量
保持 isRangeLegal 参数契约；self 技能只返回 registry 枚举出的目标，当前无 self target skill。
*/
export function getSkillTargetIds(players, sourceId, skill, isRangeLegal = null) {
  const source = players.find((player) => player.id === sourceId) ?? null;
  if (!source?.alive || !skill?.rangeRule) return [];
  const alive = players.filter((player) => player.alive);
  const rule = SKILL_RULES[skill.id];
  const candidates = rule?.getCandidates?.(alive, source) ?? [];
  return filterSkillCandidatesByRange(players, source, skill, candidates, isRangeLegal);
}
