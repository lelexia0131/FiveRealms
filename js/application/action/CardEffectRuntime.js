/*
模块职责
唯一拥有 card-specific effect execution sequencing：效果提交、response integration、card movement orchestration 与 card-specific presentation；不拥有 Domain legality/target formula 或 generic Action lifecycle。

上游
application card runtime boundary 与 Application CardRuntime/ActionWorkflow。

下游
Application Combat/Response/Judgment/Turn workflows、Domain transitions 与 narrow collaborators。

状态边界
内部 duelContext 是 card-specific runtime state；Domain mutation 经 transitions 或 application workflows。

信息边界
private intent 只存在于当前调用栈；public context 不泄漏 hidden card。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime、ActionLegality 或 concrete adapters。
*/
import { isExposeWeaknessConsumable } from "../../domain/rules/status/StatusRules.js";
import { getAssaultBaseDamage, getChargeEnergyAmount, getDuelDamage, getHarvestDrawCount, getMutualBenefitRevealCount, getNextExposeWeaknessStacks, getProvokeDamage, getRecoverHealAmount, getShieldAmount, getShockwaveDamage, getSymbiosisHealAmount } from "../../domain/rules/card/CardEffectRules.js";
import { changeShield } from "../../domain/state/transitions/ResourceTransitions.js";
import { incrementAttackUsed, incrementRecoverUsed } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { removeStatus, setStatus } from "../../domain/state/transitions/StatusTransitions.js";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "presentation", "damage", "heal", "gainEnergy", "drawCards",
  "equipCard", "moveCardBetweenHands", "moveEquipmentToHand", "discardEquipment",
  "discardCardFromHand", "rememberPrivateCard", "cardLabelForHuman", "seatOrderFrom",
  "getEnemies", "responseWorkflow", "publicCardPool", "resolveLeverage",
  "getCardTargets", "getTransferSources", "getTransferReceivers", "diagnostics",
  "random", "createId"
];

/*
功能
创建 card-specific effect runtime。

调用方
composition root。

输入
显式注入的 combat/response/zone/presentation/choice collaborators。

输出
冻结 { resolve, hasResolver }。

读取状态
无。

写入状态
内部 duelContext；其它经 deps/transitions。

调用函数
无。

边界与不变量
不执行 generic Action pipeline；不复制 ActionLegality 合法性。
*/
export function createCardEffectRuntime(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`CardEffectRuntime 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  let duelContext = null;

  /*
  功能
  复验私密选择意图并只保留仍处于原区域的实体牌。

  调用方
  scout/transfer/plunder/destroy resolver。

  输入
  source、card、target、context 与 expectedZone。

  输出
  { owner, zone, cards } 或 null。

  读取状态
  注入 getCardTargets 与 target hand/equipment。

  写入状态
  无。

  调用函数
  runtime.getCardTargets。

  边界与不变量
  不在 Choice/Response public context 暴露 hidden entity。
  */
  function resolvePrivateSelectionIntent(source, card, target, context, expectedZone = null) {
    const intent = context.privateCardSelectionIntent;
    if (!intent || intent.owner !== target || !target?.alive
      || (expectedZone && intent.zone !== expectedZone)
      || !["hand", "equipment"].includes(intent.zone)
      || !runtime.getCardTargets(source, card).includes(target)) return null;
    const cards = intent.cards.filter((entity) => intent.zone === "hand"
      ? target.hand.includes(entity)
      : target.equipment === entity);
    return { owner: target, zone: intent.zone, cards };
  }

  /*
  功能
  提交装备牌到装备区。

  调用方
  equipment resolvers。

  输入
  source、card 与 context。

  输出
  { destination:"equipment" }。

  读取状态
  source.equipment 与 resolving zone。

  写入状态
  经 equipCard collaborator。

  调用函数
  runtime.equipCard。

  边界与不变量
  预检失败抛错并由 generic Action 清理。
  */
  async function resolveEquipment(source, card, context) {
    const state = runtime.getState();
    const equipped = await runtime.equipCard(source, card, context.resolutionId);
    if (!equipped || source.equipment !== card || state.deck.resolvingCards.includes(card)) {
      throw new Error("装备牌未能进入装备区");
    }
    return { destination: "equipment" };
  }

  const CARD_EFFECTS = {
/*
功能
执行 assault 卡牌效果 sequencing。

调用方
assault 的 direct callers。

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
    async assault(source, card, targets, context) {
      const state = runtime.getState();
      incrementAttackUsed(state, source);
      runtime.diagnostics.recordAssaultUse({ sourceId: source.id });
      const stacks = getNextExposeWeaknessStacks(source.statuses.exposeWeakness) - 1;
      if (isExposeWeaknessConsumable(source.statuses.exposeWeakness)) {
        removeStatus(state, source, "exposeWeakness");
        runtime.presentation.log(`${source.name}消耗${stacks}层「破势」，本次「突袭」伤害+${stacks}。`, "important");
      }
      await runtime.damage(source, targets[0], getAssaultBaseDamage() + stacks, { card, canBlock: true, damageType: "normal", resolutionId: context.resolutionId });
    },

/*
功能
执行 recover 卡牌效果 sequencing。

调用方
recover 的 direct callers。

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
    async recover(source, card, _targets, context) {
      const state = runtime.getState();
      incrementRecoverUsed(state, source);
      await runtime.heal(source, source, getRecoverHealAmount(), {
        card, resolutionId: context.resolutionId, silentLog: true,
        resultLog: (actualAmount) => `${source.name}使用「${card.name}」，恢复${actualAmount}点生命。`
      });
    },

/*
功能
执行 charge 卡牌效果 sequencing。

调用方
charge 的 direct callers。

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
    async charge(source, card) { await runtime.gainEnergy(source, getChargeEnergyAmount(), { card, reason: "聚能" }); },

/*
功能
执行 shield 卡牌效果 sequencing。

调用方
shield 的 direct callers。

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
    async shield(source, card, targets) {
      const state = runtime.getState();
      const target = targets[0];
      if (!target?.alive || target.battleTeam !== source.battleTeam) return { resolved: false };
      changeShield(state, target, getShieldAmount());
      runtime.presentation.showShieldFeedback(target.id, 1);
      const targetLabel = target.id === source.id ? "自己" : target.name;
      runtime.presentation.log(`${source.name}使用「${card.name}」，令${targetLabel}获得1点护盾，现有${target.shield}点。`, "heal");
      return { resolved: true };
    },

/*
功能
执行 scout 卡牌效果 sequencing。

调用方
scout 的 direct callers。

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
    async scout(source, card, targets, context) {
      const gameId = runtime.getState().gameId;
      const target = targets[0];
      const intent = resolvePrivateSelectionIntent(source, card, target, context, "hand");
      const chosen = intent?.cards.slice(0, 2) ?? [];
      if (!chosen.length) return { resolved: false };
      for (const seen of chosen) runtime.rememberPrivateCard(source, target, seen);
      if (source.controllerType === "human") await runtime.presentation.showPrivateReveal({ title: `${target.name}的手牌情报`, cardIds: chosen.map((card) => card.id) });
      if (!runtime.isSessionValid(gameId)) return { resolved: false };
      runtime.presentation.log(`${source.name}窥探了${target.name}的${chosen.length}张手牌。`);
      return { resolved: true };
    },

/*
功能
执行 transfer 卡牌效果 sequencing。

调用方
transfer 的 direct callers。

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
    async transfer(source, card, _targets, context) {
      const state = runtime.getState();
      const intent = context.privateTransferIntent;
      if (!intent || intent.zone !== "hand" || !intent.from?.hand?.includes(intent.card)
        || !runtime.getTransferSources(source, card).includes(intent.from)
        || !runtime.getTransferReceivers(source, intent.from, card).includes(intent.receiver)) {
        return { destination: "discard", resolved: false };
      }
      const transferred = await runtime.moveCardBetweenHands(intent.from, intent.receiver, intent.card, "转移");
      if (!runtime.isSessionValid(state.gameId)) return { destination: "discard", resolved: false };
      if (transferred) {
        const receiverLabel = intent.receiver.id === source.id ? "自己" : intent.receiver.name;
        runtime.presentation.log(`${source.name}将${intent.from.name}的${runtime.cardLabelForHuman(intent.receiver, intent.card)}转移给了${receiverLabel}。`, "important");
      }
      return { destination: "discard", resolved: Boolean(transferred) };
    },

/*
功能
执行 exposeWeakness 卡牌效果 sequencing。

调用方
exposeWeakness 的 direct callers。

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
    async exposeWeakness(source) {
      const state = runtime.getState();
      const status = setStatus(state, source, "exposeWeakness", { stacks: getNextExposeWeaknessStacks(source.statuses.exposeWeakness) });
      runtime.presentation.log(`${source.name}获得${status.stacks}层「破势」。`, "important");
    },

/*
功能
执行 shockwave 卡牌效果 sequencing。

调用方
shockwave 的 direct callers。

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
    async shockwave(source, card, _targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const effectiveTargets = [];
      runtime.diagnostics.recordAssaultUse({ sourceId: source.id });
      const enemies = runtime.seatOrderFrom(source, false).filter((target) => target.alive && target.battleTeam !== source.battleTeam);
      for (const target of enemies) {
        if (state.isGameOver) break;
        if (!target.alive) continue;
        const counteredForTarget = await runtime.responseWorkflow.askForCounter(source, card, [target], {
          responders: [target], targetScoped: true
        });
        if (!runtime.isSessionValid(gameId) || counteredForTarget.status === "cancelled") return { resolved: false };
        if (counteredForTarget.status === "used") continue;
        effectiveTargets.push(target);
        await runtime.damage(source, target, getShockwaveDamage(), { card, canBlock: true, damageType: "area", resolutionId: context.resolutionId });
        if (!runtime.isSessionValid(gameId)) return { resolved: false };
      }
      return { effectiveTargets };
    },

/*
功能
执行 provoke 卡牌效果 sequencing。

调用方
provoke 的 direct callers。

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
    async provoke(source, card, _targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const effectiveTargets = [];
      for (const target of runtime.seatOrderFrom(source, false).filter((player) => player.alive && player.battleTeam !== source.battleTeam)) {
        if (state.isGameOver) break;
        if (!target.alive) continue;
        const counteredForTarget = await runtime.responseWorkflow.askForCounter(source, card, [target], {
          responders: [target], targetScoped: true
        });
        if (!runtime.isSessionValid(gameId) || counteredForTarget.status === "cancelled") return { resolved: false };
        if (counteredForTarget.status === "used") continue;
        const discarded = await runtime.responseWorkflow.requestAssaultDiscard(target, "响应挑衅并打出突袭", { source, target, card });
        if (!runtime.isSessionValid(gameId) || discarded.status === "cancelled") return { resolved: false };
        effectiveTargets.push(target);
        if (discarded.status !== "used") await runtime.damage(source, target, getProvokeDamage(), {
          card, canBlock: false, damageType: "provoke", actionName: "挑衅", resolutionId: context.resolutionId
        });
        if (!runtime.isSessionValid(gameId)) return { resolved: false };
      }
      return { effectiveTargets };
    },

/*
功能
执行 leverage 卡牌效果 sequencing。

调用方
leverage 的 direct callers。

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
    async leverage(source, card, _targets, context) {
      return { resolved: await runtime.resolveLeverage(source, card, context.privateLeverageIntent, context.resolutionId) };
    },

/*
功能
执行 plunder 卡牌效果 sequencing。

调用方
plunder 的 direct callers。

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
    async plunder(source, card, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const target = targets[0];
      const intent = resolvePrivateSelectionIntent(source, card, target, context);
      const chosen = intent?.cards[0] ? { card: intent.cards[0], zone: intent.zone } : null;
      if (!chosen) return { resolved: false };
      const plundered = chosen.zone === "equipment"
        ? await runtime.moveEquipmentToHand(target, source, chosen.card, "掠夺")
        : await runtime.moveCardBetweenHands(target, source, chosen.card, "掠夺");
      if (!runtime.isSessionValid(gameId)) return { resolved: false };
      if (plundered) runtime.presentation.log(`${source.name}从${target.name}处掠夺了${runtime.cardLabelForHuman(source, chosen.card)}。`, "important");
      return { resolved: Boolean(plundered) };
    },

/*
功能
执行 destroy 卡牌效果 sequencing。

调用方
destroy 的 direct callers。

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
    async destroy(source, card, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const target = targets[0];
      const intent = resolvePrivateSelectionIntent(source, card, target, context);
      const chosen = intent?.cards[0] ? { card: intent.cards[0], zone: intent.zone } : null;
      if (!chosen) return { resolved: false };
      const destroyed = chosen.zone === "equipment"
        ? await runtime.discardEquipment(target, chosen.card, `被${source.name}破坏`)
        : await runtime.discardCardFromHand(target, chosen.card, `被${source.name}破坏`, { silent: true });
      if (!runtime.isSessionValid(gameId)) return { resolved: false };
      if (!destroyed) return { resolved: false };
      runtime.presentation.showCurrentAction({ cardId: chosen.card.id, sourceLabel: `${source.name}破坏的${chosen.zone === "equipment" ? "装备" : "手牌"}`, targetLabel: target.name, displayTargets: [] });
      runtime.presentation.log(`${source.name}破坏了${target.name}的${chosen.zone === "equipment" ? "装备" : "手牌"}「${chosen.card.name}」。`, "important");
      return { resolved: true, effectiveTargets: [target] };
    },

/*
功能
执行 harvest 卡牌效果 sequencing。

调用方
harvest 的 direct callers。

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
    async harvest(source) { await runtime.drawCards(source, getHarvestDrawCount(), "丰收"); },

/*
功能
执行 duel 卡牌效果 sequencing。

调用方
duel 的 direct callers。

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
    async duel(source, card, targets, context) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const target = targets[0];
      let current = target;
      let opponent = source;
      duelContext = { sourceId: source.id, targetId: target.id, currentId: target.id };
      while (current.alive && opponent.alive && !state.isGameOver) {
        duelContext.currentId = current.id;
        runtime.presentation.showDuel({ playerId: current.id, opponentId: opponent.id });
        const assault = await runtime.responseWorkflow.requestAssaultDiscard(current, "在决斗中打出突袭", { source: opponent, target: current, card });
        if (!runtime.isSessionValid(gameId) || assault.status === "cancelled") return { resolved: false };
        if (assault.status !== "used") {
          runtime.presentation.log(`${current.name}在决斗中败下阵来。`, "important");
          await runtime.damage(opponent, current, getDuelDamage(), { card, canBlock: false, damageType: "duel", resolutionId: context.resolutionId });
          if (!runtime.isSessionValid(gameId)) return { resolved: false };
          break;
        }
        [current, opponent] = [opponent, current];
      }
      if (!runtime.isSessionValid(gameId)) return { resolved: false };
      duelContext = null;
      runtime.presentation.hideDuel();
    },

/*
功能
执行 mutualBenefit 卡牌效果 sequencing。

调用方
mutualBenefit 的 direct callers。

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
    async mutualBenefit(source) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const count = getMutualBenefitRevealCount(state.players.filter((player) => player.alive).length);
      runtime.publicCardPool.reveal(count);
      runtime.presentation.log(`${source.name}展示了${state.publicCardPool.length}张互利牌。`, "important");
      const drafted = await runtime.publicCardPool.draft(source);
      return { resolved: Boolean(drafted && runtime.isSessionValid(gameId)) };
    },

/*
功能
执行 symbiosis 卡牌效果 sequencing。

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
    async symbiosis(source, card) {
      const state = runtime.getState();
      const gameId = state.gameId;
      const effectiveTargets = [];
      for (const target of runtime.seatOrderFrom(source, true).filter((player) => player.alive)) {
        const healed = await runtime.heal(source, target, getSymbiosisHealAmount(), { card });
        if (!runtime.isSessionValid(gameId)) return { resolved: false };
        if (healed > 0) effectiveTargets.push(target);
      }
      return { resolved: effectiveTargets.length > 0, effectiveTargets };
    },

/*
功能
执行 seal 卡牌效果 sequencing。

调用方
seal 的 direct callers。

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
    async seal(source, card, targets) {
      const target = targets[0];
      if (!runtime.getCardTargets(source, card).includes(target)) return { resolved: false };
      setStatus(runtime.getState(), target, "sealed", { cardDefinitionId: card.definitionId, originPlayerId: source.id });
      runtime.presentation.log(`${source.name}使${target.name}进入「封印」状态。`, "important");
    },

/*
功能
执行 energyDevice 装备效果 sequencing。

调用方
energyDevice 的 direct callers。

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
    async energyDevice(source, card, _targets, context) { return resolveEquipment(source, card, context); },
/*
功能
执行 recycleDevice 装备效果 sequencing。

调用方
recycleDevice 的 direct callers。

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
    async recycleDevice(source, card, _targets, context) { return resolveEquipment(source, card, context); },
/*
功能
执行 defenseDevice 装备效果 sequencing。

调用方
defenseDevice 的 direct callers。

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
    async defenseDevice(source, card, _targets, context) { return resolveEquipment(source, card, context); },
/*
功能
执行 battleDevice 装备效果 sequencing。

调用方
battleDevice 的 direct callers。

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
    async battleDevice(source, card, _targets, context) { return resolveEquipment(source, card, context); },
/*
功能
执行 telescope 装备效果 sequencing。

调用方
telescope 的 direct callers。

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
    async telescope(source, card, _targets, context) { return resolveEquipment(source, card, context); },
/*
功能
执行 barrierDevice 装备效果 sequencing。

调用方
barrierDevice 的 direct callers。

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
    async barrierDevice(source, card, _targets, context) { return resolveEquipment(source, card, context); },

/*
功能
执行 lightning 卡牌效果 sequencing。

调用方
lightning 的 direct callers。

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
    async lightning(source, card) {
      if (source.statuses.lightning) return;
      setStatus(runtime.getState(), source, "lightning", { cardDefinitionId: card.definitionId, originPlayerId: source.id });
      runtime.presentation.log(`${source.name}获得了「闪电」状态。`, "important");
    },

/*
功能
执行 block 卡牌效果 sequencing。

调用方
block 的 direct callers。

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
    async block() { throw new Error("格挡只能作为响应牌使用"); },
/*
功能
执行 counter 卡牌效果 sequencing。

调用方
counter 的 direct callers。

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
    async counter() { throw new Error("反制只能作为响应牌使用"); }
  };

  /*
  功能
  解析并执行一张已通过 generic Action pipeline 的卡牌效果。

  调用方
  CardRuntime.resolveCardAction。

  输入
  source、card、targets 与 context。

  输出
  { destination, resolved, effectiveTargets }。

  读取状态
  card.definitionId registry。

  写入状态
  经各 effect runtime。

  调用函数
  CARD_EFFECTS。

  边界与不变量
  默认 destination 为 discard；未知卡抛错。
  */
  async function resolve(source, card, targets, context) {
    const resolver = CARD_EFFECTS[card.definitionId];
    if (!resolver) throw new Error(`未注册卡牌效果：${card.definitionId}`);
    return { destination: "discard", ...((await resolver(source, card, targets, context)) ?? {}) };
  }

  /*
  功能
  查询指定卡牌是否有 effect resolver。

  调用方
  application card runtime boundary。

  输入
  definitionId。

  输出
  布尔值。

  读取状态
  CARD_EFFECTS。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不执行 effect。
  */
  function hasResolver(definitionId) { return typeof CARD_EFFECTS[definitionId] === "function"; }

  return Object.freeze({ resolve, hasResolver });
}
