/** 二十一种卡牌的结算器；所有持久状态变化都回到 Game 服务。 */

const byId = (game, id) => game.state.players.find((player) => player.id === id && player.alive) ?? null;

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
    const selection = context.selection ?? {};
    let from = byId(game, selection.sourceId);
    let receiver = byId(game, selection.receiverId);
    if (!from || !from.hand.length) from = game.aiController.cardSelector.chooseTransferSource(source, game.state.players.filter((player) => player.alive && player.hand.length));
    if (!receiver || receiver.id === from?.id) receiver = game.aiController.cardSelector.chooseTransferReceiver(source, from, game.state.players.filter((player) => player.alive && player.id !== from?.id));
    if (!from || !receiver || from.id === receiver.id) return;
    game.ui.setCurrentCard?.(card, source.name, `来源 ${from.name} → 接收 ${receiver.name}`);
    const [moved] = await game.chooseHiddenCards(source, from, 1, "选择要转移的手牌", selection);
    if (!moved) return;
    const transferred = await game.moveCardBetweenHands(from, receiver, moved, "转移");
    if (transferred) game.log(`${source.name}将${from.name}的${game.cardLabelForHuman(receiver, moved)}转移给了${receiver.name}。`, "important");
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
      if (discarded) game.log(`${target.name}以突袭回应了挑衅。`, "important");
      else await game.hpLossSystem.lose(target, 1, { source, card, reason:"挑衅" });
    }
  },

  async plunder(game, source, card, targets, context) {
    const target = targets[0];
    const [stolen] = await game.chooseHiddenCards(source, target, 1, "选择要掠夺的手牌", context.selection);
    if (!stolen) return;
    const plundered = await game.moveCardBetweenHands(target, source, stolen, "掠夺");
    if (plundered) game.log(`${source.name}从${target.name}处掠夺了${game.cardLabelForHuman(source, stolen)}。`, "important");
  },

  async destroy(game, source, card, targets, context) {
    const target = targets[0];
    const [destroyed] = await game.chooseHiddenCards(source, target, 1, "选择要破坏的手牌", context.selection);
    if (!destroyed) return;
    await game.discardCardFromHand(target, destroyed, `被${source.name}破坏`);
    game.ui.setCurrentCard?.(destroyed, `${source.name}破坏的手牌`, target.name);
    game.log(`${source.name}破坏了${target.name}的「${destroyed.name}」。`, "important");
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

  async block() { throw new Error("格挡只能作为响应牌使用"); },
  async counter() { throw new Error("反制只能作为响应牌使用"); }
};

export async function resolveCardEffect(game, source, card, targets, context) {
  const resolver = CARD_EFFECTS[card.definitionId];
  if (!resolver) throw new Error(`未注册卡牌效果：${card.definitionId}`);
  return { destination:"discard", ...((await resolver(game, source, card, targets, context)) ?? {}) };
}

export function hasCardResolver(definitionId) { return typeof CARD_EFFECTS[definitionId] === "function"; }
