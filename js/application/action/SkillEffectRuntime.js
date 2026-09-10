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
  "moveEquipmentToHand", "moveCardBetweenHands",
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

  /*
  功能
  在主动技能的 canonical 扣款点支付能量并记录真实支付量。

  调用方
  所有主动技能 effect resolver。

  输入
  真实 source、已解析的请求支付量与本次 execution payment ledger。

  输出
  本次实际支付的非负能量。

  读取状态
  MatchState、source.energy 与 source.maxEnergy。

  写入状态
  通过 changeEnergy 写入真实能量，并把实际支付量写入本次 execution payment ledger。

  调用函数
  changeEnergy。

  边界与不变量
  金额只取 changeEnergy 的实际负向变化，不读取技能标称 cost；事实由 Action commit 后发布。
  */
  function paySkillEnergy(source, requestedAmount, payment) {
    const actualPaid = Math.max(0, -changeEnergy(
      runtime.getState(),
      source,
      -Math.max(0, Number(requestedAmount) || 0)
    ));
    payment.actualAmount += actualPaid;
    return actualPaid;
  }

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
source.energy 与本回合 attack limit。

调用函数
paySkillEnergy、incrementAttackLimit 与 presentation collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async breakArmy(skill, source, _targets, context) {
      const state = runtime.getState();
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
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
source.energy 与 target.shield。

调用函数
paySkillEnergy、changeShield、emitEvent 与 presentation collaborator。

边界与不变量
不重复 Domain rule 决定；只发布最终实际新增的护盾事实。
*/
    async barrier(skill, source, targets, context) {
      const state = runtime.getState();
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
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
source.energy；治疗结果经 heal collaborator。

调用函数
paySkillEnergy、heal 与 presentation collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async symbiosis(skill, source, targets, context) {
      const state = runtime.getState();
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
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
无返回值；成功窃取时把真实来源与数量写入 execution-local ledger。

读取状态
runtime/card/skill facts。

写入状态
source.energy；牌移动经 zone collaborator；成功事实写入 context.cardSteals。

调用函数
paySkillEnergy、randomChoice 与 zone/presentation collaborator。

边界与不变量
不重复 Domain rule 决定；只有移动成功才记录一张，事实由 Action commit 后发布。
*/
    async stealSkill(skill, source, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
      const target = targets[0];
      const options = [...target.hand.map((card) => ({ card, zone: "hand" })), ...(target.equipment ? [{ card: target.equipment, zone: "equipment" }] : [])];
      const chosen = randomChoice(options, runtime.random);
      if (!chosen) return;
      const stolen = chosen.zone === "equipment"
        ? await runtime.moveEquipmentToHand(target, source, chosen.card, "窃取")
        : await runtime.moveCardBetweenHands(target, source, chosen.card, "窃取");
      if (!runtime.isSessionValid(gameId)) return;
      if (stolen) {
        context.cardSteals.push(Object.freeze({ target, actualAmount: 1 }));
        runtime.presentation.log({ type: "card-move", action: "steal", actorId: source.id,
          fromId: target.id, receiverId: source.id, cardId: chosen.card.id }, "important");
      }
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
source.energy；伤害结果经 damage collaborator。

调用函数
paySkillEnergy、getEnemies、damage 与 presentation collaborator。

边界与不变量
不重复 Domain rule 决定。
*/
    async burningField(skill, source, _targets, context = {}) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
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
执行猎杀的支付、移印、伤害与格挡后摸牌。

调用方
execute 按 hunt 技能 ID 分发。

输入
技能定义、使用者、唯一猎印目标与含 resolutionId/payment 的本次执行上下文。

输出
Promise<void>，等待伤害及合法格挡奖励完成。

读取状态
本局 session、source.alive、猎印目标与技能规则。

写入状态
source.energy、target.huntMark；伤害与摸牌经 collaborator。

调用函数
paySkillEnergy、removeStatus、damage、drawCards 与 presentation collaborator。

边界与不变量
伤害量由 Domain 决定，伤害事实由 Combat 发布；透传本次技能 resolutionId，使伤害与完成通知可去重关联。
*/
    async hunt(skill, source, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      const target = targets[0];
      runtime.presentation.log(`${source.name}对${target.name}发动「猎杀」。`, "important");
      paySkillEnergy(source, decision.energyCost, context.payment);
      removeStatus(state, target, "huntMark");
      const damageContext = { skill: "hunt", actionName: "猎杀", canBlock: true, damageType: "skill",
        resolutionId: context.resolutionId };
      await runtime.damage(source, target, decision.damageAmount, damageContext);
      if (!runtime.isSessionValid(gameId)) return;
      if (damageContext.blockedByCard && source.alive) await runtime.drawCards(source, decision.blockedRewardDraw, "猎杀被格挡");
    },
/*
功能
执行孤注支付、摸牌和状态转换，并返回本次是否真正进入状态。

调用方
execute 按 allIn 技能 ID 分发。

输入
技能定义、使用者与本次 execution-local 上下文；不使用目标数组。

输出
Promise<void>，context.enteredAllIn 记录本次从无到有的状态转换。

读取状态
source 原有孤注状态、能量、session 与 Domain 技能规则。

写入状态
source.energy/statuses；摸牌经 drawCards collaborator；context.enteredAllIn 只在本次执行内写入。

调用函数
paySkillEnergy、drawCards、setStatus 与 presentation collaborator。

边界与不变量
概率与数值由 Domain 决定；原先持有孤注时继续保持不得算作进入，统计随 Action 提交才发布。
*/
    async allIn(skill, source, _targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const hadAllInBefore = Boolean(source.statuses.allIn);
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
      const drawn = await runtime.drawCards(source, decision.drawCount, "孤注", { silent: true });
      if (!runtime.isSessionValid(gameId)) return;
      const entered = runtime.random() < decision.enterChance;
      if (entered) setStatus(state, source, "allIn", { assaultBonus: decision.assaultDamageBonus });
      context.enteredAllIn = !hadAllInBefore && entered;
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
source.energy；目标摸牌经 drawCards collaborator。

调用函数
paySkillEnergy、drawCards 与 presentation collaborator。

边界与不变量
只记录 drawCards 返回的真实获牌数；自己获牌是否形成团队贡献由下游统计 authority 判断。
*/
    async resonance(skill, source, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const decision = decideSkillEffect(skill, source, context);
      paySkillEnergy(source, decision.energyCost, context.payment);
      const drawn = await runtime.drawCards(targets[0], decision.drawCount, "共鸣", { silent: true });
      if (drawn > 0) context.cardGrants.push(Object.freeze({ target: targets[0], actualAmount: drawn }));
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
  Promise<{ actualEnergyPaid, cardGrants, cardSteals, enteredAllIn }>，返回本次 execution 的真实支付、资源与孤注进入事实。

  读取状态
  skill.id、runtime state 与 execution-local payment ledger。

  写入状态
  经 EFFECTS 写入真实技能效果；payment、cardGrants、cardSteals 与 enteredAllIn 只在本次调用内可写。

  调用函数
  EFFECTS。

  边界与不变量
  未知 skill 抛错；统计事实只返回给 Action commit boundary，失败或回滚不得发布。
  */
  async function execute(skill, source, targets, context = {}) {
    const resolver = EFFECTS[skill.id];
    if (!resolver) throw new Error(`未注册主动技能效果：${skill.id}`);
    const executionContext = {
      ...context,
      payment: { actualAmount: 0 },
      cardGrants: [],
      cardSteals: [],
      enteredAllIn: false
    };
    await resolver(skill, source, targets, executionContext);
    return Object.freeze({
      actualEnergyPaid: executionContext.payment.actualAmount,
      cardGrants: Object.freeze([...executionContext.cardGrants]),
      cardSteals: Object.freeze([...executionContext.cardSteals]),
      enteredAllIn: executionContext.enteredAllIn
    });
  }

  return Object.freeze({ execute });
}
