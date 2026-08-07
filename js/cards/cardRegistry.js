/** 二十四种卡牌的结算器；所有持久状态变化都回到 Game 服务。 */
import { RuleEngine } from "../core/RuleEngine.js?build=20260807-leverage-response-ui-v97";

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
  async assault(game, source, card, targets, context) {
    source.turnFlags.attackUsed += 1;
    source.statistics.assaultsUsed += 1;
    const stacks = source.statuses.exposeWeakness?.stacks ?? 0;
    if (stacks) {
      delete source.statuses.exposeWeakness;
      game.log(`${source.name}消耗${stacks}层破势，本次突袭伤害+${stacks}。`, "important");
    }
    await game.damage(source, targets[0], 1 + stacks, { card, canBlock:true, damageType:"normal", resolutionId:context.resolutionId });
  },

  async recover(game, source, card, targets, context) {
    source.turnFlags.recoverUsed += 1;
    await game.heal(source, source, 1, { card, resolutionId:context.resolutionId });
  },

  async charge(game, source, card) { await game.gainEnergy(source, 1, { card, reason:"聚能" }); },

  async shield(game, source, card, targets) {
    const target = targets[0];
    if (!target?.alive || target.battleTeam !== source.battleTeam) return;
    target.shield += 1;
    game.ui.queueFeedback?.("shield", target.id, 1);
    game.log(`${source.name}使用「${card.name}」令${target.name}获得1点护盾，现有${target.shield}点。`, "heal");
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
      game.log(`${source.name}将${intent.from.name}的${game.cardLabelForHuman(intent.receiver, intent.card)}转移给了${intent.receiver.name}。`, "important");
    }
    return { destination:"discard", resolved:Boolean(transferred) };
  },

  async exposeWeakness(game, source) {
    const status = source.statuses.exposeWeakness ??= { stacks:0 };
    status.stacks += 1;
    game.log(`${source.name}积累了${status.stacks}层破势。`, "important");
  },

  async shockwave(game, source, card, targets, context) {
    const gameId = game.state.gameId;
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
      await game.damage(source, target, 1, { card, canBlock:true, damageType:"area", resolutionId:context.resolutionId });
      if (!game.isSessionValid(gameId)) return { resolved:false };
    }
  },

  async provoke(game, source, card, _targets, context) {
    const gameId = game.state.gameId;
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
      if (discarded.status !== "used") await game.damage(source, target, 1, {
        card, canBlock:false, damageType:"provoke", actionName:"挑衅", resolutionId:context.resolutionId
      });
      if (!game.isSessionValid(gameId)) return { resolved:false };
    }
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
    if (plundered) game.log(`${source.name}从${target.name}处掠夺了${game.cardLabelForHuman(source, chosen.card)}并收入手牌。`, "important");
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
      : await game.discardCardFromHand(target, chosen.card, `被${source.name}破坏`);
    if (!game.isSessionValid(gameId)) return { resolved:false };
    if (!destroyed) return { resolved:false };
    game.ui.setCurrentCard?.(chosen.card, `${source.name}破坏的${chosen.zone === "equipment" ? "装备" : "手牌"}`, target.name);
    game.log(`${source.name}破坏了${target.name}的${chosen.zone === "equipment" ? "装备" : "手牌"}「${chosen.card.name}」。`, "important");
    return { resolved:true };
  },

  async harvest(game, source) { await game.drawCards(source, 2, "收获"); },

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
    for (const target of game.seatOrderFrom(source, true).filter((player) => player.alive)) {
      await game.heal(source, target, 1, { card });
      if (!game.isSessionValid(gameId)) return { resolved:false };
    }
  },

  async energyDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async recycleDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async defenseDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async battleDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async telescope(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },
  async barrierDevice(game, source, card, targets, context) { return resolveEquipment(game, source, card, context); },

  async block() { throw new Error("格挡只能作为响应牌使用"); },
  async counter() { throw new Error("反制只能作为响应牌使用"); }
};

export async function resolveCardEffect(game, source, card, targets, context) {
  const resolver = CARD_EFFECTS[card.definitionId];
  if (!resolver) throw new Error(`未注册卡牌效果：${card.definitionId}`);
  return { destination:"discard", ...((await resolver(game, source, card, targets, context)) ?? {}) };
}

export function hasCardResolver(definitionId) { return typeof CARD_EFFECTS[definitionId] === "function"; }
