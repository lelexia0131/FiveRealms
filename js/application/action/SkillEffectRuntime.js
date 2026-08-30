/*
模块职责
唯一拥有主动技能 effect execution sequencing：cost commit、card/status/resource movement orchestration 与 skill presentation；不拥有 canUse/target/cost pure rule 或 generic Action lifecycle。

上游
application skill runtime boundary 与 Application ActionWorkflow。

下游
Application Combat/Turn workflows、Domain transitions 与 narrow collaborators。

状态边界
Domain mutation 经 transitions；随机与移动经注入 collaborator。

信息边界
不读取 UI/AI search internals 或 hidden hand；只使用 target entity 执行。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime、ActionLegality 或 concrete adapters。
*/
import { changeEnergy, changeShield } from "../../domain/state/transitions/ResourceTransitions.js";
import { incrementAttackLimit } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { removeStatus, setStatus } from "../../domain/state/transitions/StatusTransitions.js";
import { randomChoice } from "../../utils/helpers.js";
import { decideSkillEffect } from "../../domain/rules/skill/SkillRules.js";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "presentation", "heal", "damage", "drawCards",
  "moveEquipmentToHand", "moveCardBetweenHands", "cardLabelForHuman",
  "getEnemies", "random", "emitEvent"
];

/*
功能
创建主动技能 effect runtime。

调用方
composition root。

输入
显式注入的 combat/zone/presentation/random collaborators。

输出
冻结 { execute }。

读取状态
无。

写入状态
经 transitions/application workflows。

调用函数
无。

边界与不变量
不复制 skill canUse/target/cost rule。
*/
export function createSkillEffectRuntime(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`SkillEffectRuntime 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  const EFFECTS = {
/*
功能
执行 breakArmy 技能效果 sequencing。

调用方
breakArmy 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async breakArmy(skill, source, _targets, context) {
      const state = runtime.getState();
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      incrementAttackLimit(state, source, decision.attackLimitBonus);
      runtime.presentation.log(`${source.name}发动「破军」，本回合可额外使用${decision.attackLimitBonus}张「突袭」。`, "important");
    },
/*
功能
执行 barrier 技能效果 sequencing。

调用方
barrier 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
changeEnergy、changeShield、emitEvent 与 presentation collaborator。

边界与不变量
不重复 Domain rule 决定；只发布最终实际新增的护盾事实。
*/
    async barrier(skill, source, targets, context) {
      const state = runtime.getState();
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      const target = targets[0];
      const shieldBefore = target.shield;
      changeShield(state, target, decision.shieldAmount);
      const actualAddedAmount = Math.max(0, target.shield - shieldBefore);
      if (actualAddedAmount > 0) {
        await runtime.emitEvent("shieldGranted", {
          source,
          target,
          actualAddedAmount,
          effectDefinitionId: skill.id
        });
        if (!runtime.isSessionValid(state.gameId)) return;
      }
      runtime.presentation.showShieldFeedback(target.id, decision.shieldAmount, "gain");
      runtime.presentation.log(`${source.name}发动「壁垒」，令${target.name}获得${decision.shieldAmount}点护盾。`, "heal");
    },
/*
功能
执行 symbiosis 技能效果 sequencing。

调用方
symbiosis 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async symbiosis(skill, source, targets, context) {
      const state = runtime.getState();
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      const target = targets[0];
      runtime.presentation.log(
        target.id === source.id
          ? `${source.name}对自己发动「滋荣」。`
          : `${source.name}对${target.name}发动「滋荣」。`,
        "important"
      );
      await runtime.heal(source, target, decision.healAmount, { skill: "symbiosis" });
    },
/*
功能
执行 stealSkill 技能效果 sequencing。

调用方
stealSkill 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async stealSkill(skill, source, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      const target = targets[0];
      const options = [...target.hand.map((card) => ({ card, zone: "hand" })), ...(target.equipment ? [{ card: target.equipment, zone: "equipment" }] : [])];
      const chosen = randomChoice(options, runtime.random);
      if (!chosen) return;
      const stolen = chosen.zone === "equipment"
        ? await runtime.moveEquipmentToHand(target, source, chosen.card, "窃取")
        : await runtime.moveCardBetweenHands(target, source, chosen.card, "窃取");
      if (!runtime.isSessionValid(gameId)) return;
      if (stolen) runtime.presentation.log(`${source.name}发动「窃取」，从${target.name}处获得${runtime.cardLabelForHuman(source, chosen.card)}并收入手牌。`, "important");
    },
/*
功能
执行 burningField 技能效果 sequencing。

调用方
burningField 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async burningField(skill, source, _targets, context = {}) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      runtime.presentation.log(`${source.name}发动「焚场」。`, "important");
      for (const target of runtime.getEnemies(source)) {
        if (!runtime.isSessionValid(gameId) || state.isGameOver) break;
        if (target.alive) await runtime.damage(source, target, decision.damageAmount, {
          skill: "burningField", actionName: "焚场", canBlock: true,
          damageType: "skill", resolutionId: context.resolutionId
        });
      }
    },
/*
功能
执行 hunt 技能效果 sequencing。

调用方
hunt 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async hunt(skill, source, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      const target = targets[0];
      runtime.presentation.log(`${source.name}对${target.name}发动「猎杀」。`, "important");
      changeEnergy(state, source, -decision.energyCost);
      removeStatus(state, target, "huntMark");
      const damageContext = { skill: "hunt", actionName: "猎杀", canBlock: true, damageType: "skill" };
      await runtime.damage(source, target, decision.damageAmount, damageContext);
      if (!runtime.isSessionValid(gameId)) return;
      if (damageContext.blockedByCard && source.alive) await runtime.drawCards(source, decision.blockedRewardDraw, "猎杀被格挡");
    },
/*
功能
执行 allIn 技能效果 sequencing。

调用方
allIn 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async allIn(skill, source, _targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const hadAllInBefore = Boolean(source.statuses.allIn);
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      const drawn = await runtime.drawCards(source, decision.drawCount, "孤注", { silent: true });
      if (!runtime.isSessionValid(gameId)) return;
      const entered = runtime.random() < decision.enterChance;
      if (entered) setStatus(state, source, "allIn", { assaultBonus: decision.assaultDamageBonus });
      if (hadAllInBefore) {
        runtime.presentation.log(`${source.name}消耗${decision.energyCost}点能量发动「孤注」，${drawn ? `摸${drawn}张牌` : "未摸到牌"}，原有「孤注」状态保持不变。`, "important");
      } else {
        runtime.presentation.log(`${source.name}消耗${decision.energyCost}点能量发动「孤注」，${drawn ? `摸${drawn}张牌` : "未摸到牌"}，${entered ? "并进入" : "但未进入"}「孤注」状态。`, "important");
      }
    },
/*
功能
执行 resonance 技能效果 sequencing。

调用方
resonance 的 direct callers。

输入
按 signature 传入的 runtime facts。

输出
按 signature 返回。

读取状态
runtime/card/skill facts。

写入状态
无直接 Domain write。

调用函数
下游 collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async resonance(skill, source, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      changeEnergy(state, source, -decision.energyCost);
      const drawn = await runtime.drawCards(targets[0], decision.drawCount, "共鸣", { silent: true });
      if (runtime.isSessionValid(gameId)) runtime.presentation.log(`${source.name}发动「共鸣」，令${targets[0].name}${drawn ? `摸${drawn}张牌` : "未摸到牌"}。`);
    }
  };

  /*
  功能
  执行指定主动技能效果。

  调用方
  application skill runtime boundary。

  输入
  skill、source、targets 与 context。

  输出
  Promise。

  读取状态
  skill.id 与 runtime state。

  写入状态
  经 EFFECTS。

  调用函数
  EFFECTS。

  边界与不变量
  未知 skill 抛错。
  */
  async function execute(skill, source, targets, context = {}) {
    const resolver = EFFECTS[skill.id];
    if (!resolver) throw new Error(`未注册主动技能效果：${skill.id}`);
    await resolver(skill, source, targets, context);
  }

  return Object.freeze({ execute });
}
