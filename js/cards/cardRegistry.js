/** 二十三种卡牌的结算器；所有持久状态变化都回到 Game 服务。 */
import { RuleEngine } from "../core/RuleEngine.js?build=20260730-equipment-control-v26";

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
    const target = targets[0];
    if (!target?.hand.length) return;
    const chosen = await game.chooseHiddenCards(source, target, Math.min(2, target.hand.length), "选择至多2张手牌进行窥探", context.selection);
    if (!chosen.length) return;
    for (const seen of chosen) game.rememberPrivateCard(source, target, seen);
    if (source.controllerType === "human") await game.ui.showPrivateReveal?.(`${target.name}的手牌情报`, chosen);
    game.log(`${source.name}窥探了${target.name}的${chosen.length}张手牌。`);
  },

  async transfer(game, source, card, targets, context) {
    const intent = context.transferIntent;
    if (!intent || !RuleEngine.getTransferSources(game, source, card).includes(intent.from)
      || !RuleEngine.getTransferReceivers(game, source, intent.from, card).includes(intent.receiver)) return;
    const transferred = intent.zone === "equipment"
      ? await game.moveEquipmentBetweenPlayers(intent.from, intent.receiver, intent.card, "转移")
      : await game.moveCardBetweenHands(intent.from, intent.receiver, intent.card, "转移");
    if (transferred && intent.zone === "hand") {
      game.log(`${source.name}将${intent.from.name}的${game.cardLabelForHuman(intent.receiver, intent.card)}转移给了${intent.receiver.name}。`, "important");
    }
  },

  async exposeWeakness(game, source) {
    const status = source.statuses.exposeWeakness ??= { stacks:0 };
    status.stacks += 1;
    game.log(`${source.name}积累了${status.stacks}层破势。`, "important");
  },

  async shockwave(game, source, card, targets, context) {
    source.statistics.assaultsUsed += 1;
    const enemies = game.seatOrderFrom(source, false).filter((target) => target.alive && target.battleTeam !== source.battleTeam);
    for (const target of enemies) {
      if (game.state.isGameOver) break;
      if (!target.alive) continue;
      const counteredForTarget = await game.responseSystem.askForCounter(source, card, [target], {
        responders:[target], targetScoped:true
      });
      if (counteredForTarget) {
        game.log(`${target.name}反制了「${card.name}」对自己的效果；其他目标继续结算。`, "important");
        continue;
      }
      await game.damage(source, target, 1, { card, canBlock:true, damageType:"area", resolutionId:context.resolutionId });
    }
  },

  async provoke(game, source, card) {
    for (const target of game.seatOrderFrom(source, false).filter((player) => player.alive && player.battleTeam !== source.battleTeam)) {
      if (game.state.isGameOver) break;
      if (!target.alive) continue;
      const counteredForTarget = await game.responseSystem.askForCounter(source, card, [target], {
        responders:[target], targetScoped:true
      });
      if (counteredForTarget) {
        game.log(`${target.name}反制了「${card.name}」对自己的效果；其他目标继续结算。`, "important");
        continue;
      }
      const discarded = await game.responseSystem.requestAssaultDiscard(target, "响应挑衅并弃置突袭", { source, target, card });
      if (!discarded) await game.damage(source, target, 1, {
        card, canBlock:false, damageType:"provoke", actionName:"挑衅"
      });
    }
  },

  async plunder(game, source, card, targets, context) {
    const target = targets[0];
    if (!RuleEngine.getCardTargets(game, source, card).includes(target)) return;
    const chosen = await game.choosePlayerZoneCard(source, target, "选择要掠夺的手牌或装备牌", context.selection);
    if (!chosen || !RuleEngine.getCardTargets(game, source, card).includes(target)) return;
    const plundered = chosen.zone === "equipment"
      ? await game.moveEquipmentBetweenPlayers(target, source, chosen.card, "掠夺")
      : await game.moveCardBetweenHands(target, source, chosen.card, "掠夺");
    if (plundered && chosen.zone === "hand") game.log(`${source.name}从${target.name}处掠夺了${game.cardLabelForHuman(source, chosen.card)}。`, "important");
  },

  async destroy(game, source, card, targets, context) {
    const target = targets[0];
    if (!RuleEngine.getCardTargets(game, source, card).includes(target)) return;
    const chosen = await game.choosePlayerZoneCard(source, target, "选择要破坏的手牌或装备牌", context.selection);
    if (!chosen || !RuleEngine.getCardTargets(game, source, card).includes(target)) return;
    const destroyed = chosen.zone === "equipment"
      ? await game.discardEquipment(target, chosen.card, `被${source.name}破坏`)
      : await game.discardCardFromHand(target, chosen.card, `被${source.name}破坏`);
    if (!destroyed) return;
    game.ui.setCurrentCard?.(chosen.card, `${source.name}破坏的${chosen.zone === "equipment" ? "装备" : "手牌"}`, target.name);
    game.log(`${source.name}破坏了${target.name}的${chosen.zone === "equipment" ? "装备" : "手牌"}「${chosen.card.name}」。`, "important");
  },

  async harvest(game, source) { await game.drawCards(source, 2, "收获"); },

  async duel(game, source, card, targets, context) {
    const target = targets[0];
    let current = target;
    let opponent = source;
    game.state.duelContext = { sourceId:source.id, targetId:target.id, currentId:target.id };
    while (current.alive && opponent.alive && !game.state.isGameOver) {
      game.state.duelContext.currentId = current.id;
      game.ui.showDuel?.(current, opponent);
      const assault = await game.responseSystem.requestAssaultDiscard(current, "在决斗中打出突袭", { source:opponent, target:current, card });
      if (!assault) {
        game.log(`${current.name}在决斗中败下阵来。`, "important");
        await game.damage(opponent, current, 1, { card, canBlock:false, damageType:"duel", resolutionId:context.resolutionId });
        break;
      }
      [current, opponent] = [opponent, current];
    }
    game.state.duelContext = null;
    game.ui.hideDuel?.();
  },

  async mutualBenefit(game, source) {
    const count = game.state.players.filter((player) => player.alive).length;
    game.publicCardPool.reveal(count);
    game.log(`${source.name}展示了${game.state.publicCardPool.length}张互利牌。`, "important");
    await game.publicCardPool.draft(source);
  },

  async symbiosis(game, source, card) {
    for (const target of game.seatOrderFrom(source, true).filter((player) => player.alive)) {
      await game.heal(source, target, 1, { card });
    }
  },

  async energyDevice(game, source, card) { return { destination:await game.equipCard(source, card) ? "equipment" : "discard" }; },
  async recycleDevice(game, source, card) { return { destination:await game.equipCard(source, card) ? "equipment" : "discard" }; },
  async defenseDevice(game, source, card) { return { destination:await game.equipCard(source, card) ? "equipment" : "discard" }; },
  async battleDevice(game, source, card) { return { destination:await game.equipCard(source, card) ? "equipment" : "discard" }; },
  async telescope(game, source, card) { return { destination:await game.equipCard(source, card) ? "equipment" : "discard" }; },
  async barrierDevice(game, source, card) { return { destination:await game.equipCard(source, card) ? "equipment" : "discard" }; },

  async block() { throw new Error("格挡只能作为响应牌使用"); },
  async counter() { throw new Error("反制只能作为响应牌使用"); }
};

export async function resolveCardEffect(game, source, card, targets, context) {
  const resolver = CARD_EFFECTS[card.definitionId];
  if (!resolver) throw new Error(`未注册卡牌效果：${card.definitionId}`);
  return { destination:"discard", ...((await resolver(game, source, card, targets, context)) ?? {}) };
}

export function hasCardResolver(definitionId) { return typeof CARD_EFFECTS[definitionId] === "function"; }
