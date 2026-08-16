/** 二十六种卡牌的结算器；所有持久状态变化都回到 Game 服务。 */
import { RuleEngine } from "../core/RuleEngine.js?build=20260815-shadow-agent-p1-slot";
import { changeShield } from "../domain/state/transitions/ResourceTransitions.js?build=20260815-shadow-agent-p1-slot";
import { incrementAttackUsed, incrementRecoverUsed } from "../domain/state/transitions/RuleUsageTransitions.js?build=20260815-shadow-agent-p1-slot";
import { removeStatus, setStatus } from "../domain/state/transitions/StatusTransitions.js?build=20260815-shadow-agent-p1-slot";

/** 只在最终效果解析时读取私密意图，并按原角色、原区域复验实体牌。 */
function resolvePrivateSelectionIntent(game, source, card, target, context, expectedZone = null) {
  const intent = context.privateCardSelectionIntent;
  if (!intent || intent.owner !== target || !target?.alive
    || (expectedZone && intent.zone !== expectedZone)
    || !["hand", "equipment"].includes(intent.zone)
    || !RuleEngine.getCardTargets(game, source, card).includes(target)) return null;
  const cards = intent.cards.filter((entity) => intent.zone === "hand"
    ? target.hand.includes(entity)
    : target.equipment === entity);
  return { owner:target, zone:intent.zone, cards };
}

/** 装备结算必须真实提交到装备区；预检失败交由 playCard 的失败清理收束。 */
async function resolveEquipment(game, source, card, context) {
  const equipped = await game.equipCard(source, card, context.resolutionId);
  if (!equipped || source.equipment !== card || game.state.deck.resolvingCards.includes(card)) {
    throw new Error("装备牌未能进入装备区");
  }
  return { destination:"equipment" };
}

const CARD_EFFECTS = {
  /*
  功能
  提交一次已决定的突袭效果：递增攻击次数、消耗破势并调用统一伤害 workflow。

  调用方
  resolveCardEffect。

  输入
  Game、source、assault card、目标数组与 resolution context。

  输出
  无显式返回值。

  读取状态
  source.turnFlags/statuses/statistics。

  写入状态
  经 transition 写 turnFlags/statuses 并触发 damage。

  调用函数
  removeStatus、game.damage。

  边界与不变量
  不重新计算合法性；伤害目标由 workflow 决定。
  */
  async assault(game, source, card, targets, context) {
    incrementAttackUsed(game.state, source);
    source.statistics.assaultsUsed += 1;
    const stacks = source.statuses.exposeWeakness?.stacks ?? 0;
    if (stacks) {
      removeStatus(game.state, source, "exposeWeakness");
      game.log(`${source.name}消耗${stacks}层「破势」，本次「突袭」伤害+${stacks}。`, "important");
    }
    await game.damage(source, targets[0], 1 + stacks, { card, canBlock:true, damageType:"normal", resolutionId:context.resolutionId });
  },

  /*
  功能
  提交调息卡已决定的次数与治疗 workflow。

  调用方
  resolveCardEffect。

  输入
  Game、source、recover card、targets 与 context。

  输出
  无显式返回值。

  读取状态
  source.turnFlags。

  写入状态
  recoverUsed 经 RuleUsageTransition；治疗经 Game.heal。

  调用函数
  incrementRecoverUsed、game.heal。

  边界与不变量
  不重新判断合法性。
  */
  async recover(game, source, card, targets, context) {
    incrementRecoverUsed(game.state, source);
    await game.heal(source, source, 1, {
      card, resolutionId:context.resolutionId, silentLog:true,
      resultLog:(actualAmount) => `${source.name}使用「${card.name}」，恢复${actualAmount}点生命。`
    });
  },

  async charge(game, source, card) { await game.gainEnergy(source, 1, { card, reason:"聚能" }); },

  /*
  功能
  提交已决定的护盾牌效果，给合法目标增加 1 点护盾。

  调用方
  resolveCardEffect。

  输入
  Game、source、shield card 与目标数组。

  输出
  resolved 布尔值。

  读取状态
  target 存活与阵营。

  写入状态
  target.shield 经 ResourceTransition。

  调用函数
  changeShield。

  边界与不变量
  不做合法性判断；UI 反馈与日志由调用方上下文继续。
  */
  async shield(game, source, card, targets) {
    const target = targets[0];
    if (!target?.alive || target.battleTeam !== source.battleTeam) return { resolved:false };
    changeShield(game.state, target, 1);
    game.ui.queueFeedback?.("shield", target.id, 1);
    const targetLabel = target.id === source.id ? "自己" : target.name;
    game.log(`${source.name}使用「${card.name}」，令${targetLabel}获得1点护盾，现有${target.shield}点。`, "heal");
    return { resolved:true };
  },

  async scout(game, source, card, targets, context) {
    const gameId = game.state.gameId;
    const target = targets[0];
    const intent = resolvePrivateSelectionIntent(game, source, card, target, context, "hand");
    const chosen = intent?.cards.slice(0, 2) ?? [];
    if (!chosen.length) return { resolved:false };
    for (const seen of chosen) game.rememberPrivateCard(source, target, seen);
    if (source.controllerType === "human") await game.ui.showPrivateReveal?.(`${target.name}的手牌情报`, chosen);
    if (!game.isSessionValid(gameId)) return { resolved:false };
    game.log(`${source.name}窥探了${target.name}的${chosen.length}张手牌。`);
    return { resolved:true };
  },

  async transfer(game, source, card, targets, context) {
    const intent = context.privateTransferIntent;
    if (!intent || intent.zone !== "hand" || !intent.from?.hand?.includes(intent.card)
      || !RuleEngine.getTransferSources(game, source, card).includes(intent.from)
      || !RuleEngine.getTransferReceivers(game, source, intent.from, card).includes(intent.receiver)) {
      return { destination:"discard", resolved:false };
    }
    const transferred = await game.moveCardBetweenHands(intent.from, intent.receiver, intent.card, "转移");
    if (!game.isSessionValid(game.state.gameId)) return { destination:"discard", resolved:false };
    if (transferred) {
      const receiverLabel = intent.receiver.id === source.id ? "自己" : intent.receiver.name;
      game.log(`${source.name}将${intent.from.name}的${game.cardLabelForHuman(intent.receiver, intent.card)}转移给了${receiverLabel}。`, "important");
    }
    return { destination:"discard", resolved:Boolean(transferred) };
  },

  /*
  功能
  提交已决定的破势效果，增加一层破势状态。

  调用方
  resolveCardEffect。

  输入
  Game 与 source。

  输出
  无显式返回值。

  读取状态
  source.statuses.exposeWeakness。

  写入状态
  source.statuses.exposeWeakness 经 StatusTransition。

  调用函数
  setStatus。

  边界与不变量
  不拥有破势具体消耗规则；只提交层数变化。
  */
  async exposeWeakness(game, source) {
    const status = setStatus(game.state, source, "exposeWeakness", { stacks:(source.statuses.exposeWeakness?.stacks ?? 0) + 1 });
    game.log(`${source.name}获得${status.stacks}层「破势」。`, "important");
  },

  async shockwave(game, source, card, targets, context) {
    const gameId = game.state.gameId;
    const effectiveTargets = [];
    source.statistics.assaultsUsed += 1;
    const enemies = game.seatOrderFrom(source, false).filter((target) => target.alive && target.battleTeam !== source.battleTeam);
    for (const target of enemies) {
      if (game.state.isGameOver) break;
      if (!target.alive) continue;
      const counteredForTarget = await game.responseSystem.askForCounter(source, card, [target], {
        responders:[target], targetScoped:true
      });
      if (!game.isSessionValid(gameId) || counteredForTarget.status === "cancelled") return { resolved:false };
      if (counteredForTarget.status === "used") {
        continue;
      }
      effectiveTargets.push(target);
      await game.damage(source, target, 1, { card, canBlock:true, damageType:"area", resolutionId:context.resolutionId });
      if (!game.isSessionValid(gameId)) return { resolved:false };
    }
    return { effectiveTargets };
  },

  async provoke(game, source, card, _targets, context) {
    const gameId = game.state.gameId;
    const effectiveTargets = [];
    for (const target of game.seatOrderFrom(source, false).filter((player) => player.alive && player.battleTeam !== source.battleTeam)) {
      if (game.state.isGameOver) break;
      if (!target.alive) continue;
      const counteredForTarget = await game.responseSystem.askForCounter(source, card, [target], {
        responders:[target], targetScoped:true
      });
      if (!game.isSessionValid(gameId) || counteredForTarget.status === "cancelled") return { resolved:false };
      if (counteredForTarget.status === "used") {
        continue;
      }
      const discarded = await game.responseSystem.requestAssaultDiscard(target, "响应挑衅并打出突袭", { source, target, card });
      if (!game.isSessionValid(gameId) || discarded.status === "cancelled") return { resolved:false };
      effectiveTargets.push(target);
      if (discarded.status !== "used") await game.damage(source, target, 1, {
        card, canBlock:false, damageType:"provoke", actionName:"挑衅", resolutionId:context.resolutionId
      });
      if (!game.isSessionValid(gameId)) return { resolved:false };
    }
    return { effectiveTargets };
  },

  /** 借势只编排统一响应、普通突袭和装备转移入口，不在卡牌层复制底层规则。 */
  async leverage(game, source, card, _targets, context) {
    return { resolved:await game.resolveLeverage(source, card, context.privateLeverageIntent, context.resolutionId) };
  },

  async plunder(game, source, card, targets, context) {
    const gameId = game.state.gameId;
    const target = targets[0];
    const intent = resolvePrivateSelectionIntent(game, source, card, target, context);
    const chosen = intent?.cards[0] ? { card:intent.cards[0], zone:intent.zone } : null;
    if (!chosen) return { resolved:false };
    const plundered = chosen.zone === "equipment"
      ? await game.moveEquipmentToHand(target, source, chosen.card, "掠夺")
      : await game.moveCardBetweenHands(target, source, chosen.card, "掠夺");
    if (!game.isSessionValid(gameId)) return { resolved:false };
    if (plundered) game.log(`${source.name}从${target.name}处掠夺了${game.cardLabelForHuman(source, chosen.card)}。`, "important");
    return { resolved:Boolean(plundered) };
  },

  async destroy(game, source, card, targets, context) {
    const gameId = game.state.gameId;
    const target = targets[0];
    const intent = resolvePrivateSelectionIntent(game, source, card, target, context);
    const chosen = intent?.cards[0] ? { card:intent.cards[0], zone:intent.zone } : null;
    if (!chosen) return { resolved:false };
    const destroyed = chosen.zone === "equipment"
      ? await game.discardEquipment(target, chosen.card, `被${source.name}破坏`)
      : await game.discardCardFromHand(target, chosen.card, `被${source.name}破坏`, { silent:true });
    if (!game.isSessionValid(gameId)) return { resolved:false };
    if (!destroyed) return { resolved:false };
    game.ui.setCurrentCard?.(chosen.card, `${source.name}破坏的${chosen.zone === "equipment" ? "装备" : "手牌"}`, target.name);
    game.log(`${source.name}破坏了${target.name}的${chosen.zone === "equipment" ? "装备" : "手牌"}「${chosen.card.name}」。`, "important");
    return { resolved:true, effectiveTargets:[target] };
  },

  async harvest(game, source) { await game.drawCards(source, 2, "丰收"); },

  async duel(game, source, card, targets, context) {
    const gameId = game.state.gameId;
    const target = targets[0];
    let current = target;
    let opponent = source;
    game.state.duelContext = { sourceId:source.id, targetId:target.id, currentId:target.id };
    while (current.alive && opponent.alive && !game.state.isGameOver) {
      game.state.duelContext.currentId = current.id;
      game.ui.showDuel?.(current, opponent);
      const assault = await game.responseSystem.requestAssaultDiscard(current, "在决斗中打出突袭", { source:opponent, target:current, card });
      if (!game.isSessionValid(gameId) || assault.status === "cancelled") return { resolved:false };
      if (assault.status !== "used") {
        game.log(`${current.name}在决斗中败下阵来。`, "important");
        await game.damage(opponent, current, 1, { card, canBlock:false, damageType:"duel", resolutionId:context.resolutionId });
        if (!game.isSessionValid(gameId)) return { resolved:false };
        break;
      }
      [current, opponent] = [opponent, current];
    }
    if (!game.isSessionValid(gameId)) return { resolved:false };
    game.state.duelContext = null;
    game.ui.hideDuel?.();
  },

  async mutualBenefit(game, source) {
    const gameId = game.state.gameId;
    const count = game.state.players.filter((player) => player.alive).length;
    game.publicCardPool.reveal(count);
    game.log(`${source.name}展示了${game.state.publicCardPool.length}张互利牌。`, "important");
    const drafted = await game.publicCardPool.draft(source);
    return { resolved:Boolean(drafted && game.isSessionValid(gameId)) };
  },

  async symbiosis(game, source, card) {
    const gameId = game.state.gameId;
    const effectiveTargets = [];
    for (const target of game.seatOrderFrom(source, true).filter((player) => player.alive)) {
      const healed = await game.heal(source, target, 1, { card });
      if (!game.isSessionValid(gameId)) return { resolved:false };
      if (healed > 0) effectiveTargets.push(target);
    }
    return { resolved:effectiveTargets.length > 0, effectiveTargets };
  },

  /*
  功能
  提交已决定的封印状态写入。

  调用方
  resolveCardEffect。

  输入
  Game、source、seal card 与目标数组。

  输出
  无显式返回值。

  读取状态
  target 状态。

  写入状态
  target.statuses.sealed 经 StatusTransition。

  调用函数
  setStatus。

  边界与不变量
  不决定判定时机或转移规则。
  */
  async seal(game, source, card, targets) {
    const target = targets[0];
    if (!RuleEngine.getCardTargets(game, source, card).includes(target)) return { resolved:false };
    setStatus(game.state, target, "sealed", { cardDefinitionId:card.definitionId, originPlayerId:source.id });
    game.log(`${source.name}使${target.name}进入「封印」状态。`, "important");
  },

  async energyDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async recycleDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async defenseDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async battleDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async telescope(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async barrierDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },

  /*
  功能
  提交已决定的闪电状态写入。

  调用方
  resolveCardEffect。

  输入
  Game、source 与 lightning card。

  输出
  无显式返回值。

  读取状态
  source.statuses.lightning。

  写入状态
  source.statuses.lightning 经 StatusTransition。

  调用函数
  setStatus。

  边界与不变量
  不决定判定、伤害或转移规则。
  */
  async lightning(game, source, card) {
    if (source.statuses.lightning) return;
    setStatus(game.state, source, "lightning", { cardDefinitionId: card.definitionId, originPlayerId: source.id });
    game.log(`${source.name}获得了「闪电」状态。`, "important");
  },

  async block() { throw new Error("格挡只能作为响应牌使用"); },
  async counter() { throw new Error("反制只能作为响应牌使用"); }
};

export async function resolveCardEffect(game, source, card, targets, context) {
  const resolver = CARD_EFFECTS[card.definitionId];
  if (!resolver) throw new Error(`未注册卡牌效果：${card.definitionId}`);
  return { destination:"discard", ...((await resolver(game, source, card, targets, context)) ?? {}) };
}

export function hasCardResolver(definitionId) { return typeof CARD_EFFECTS[definitionId] === "function"; }
