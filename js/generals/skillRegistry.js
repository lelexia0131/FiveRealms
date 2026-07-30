/**
 * 本文件实现八名角色的被动监听器与主动技能标准接口，依赖 EventBus、RuleEngine 和 Game 服务。
 * 角色配置只保存技能 ID；核心伤害与回合模块不会出现角色名称分支。
 * 重新开始时 EventBus.clear 会移除全部监听器，随后新玩家重新注册。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260730-tabletop-hands-v19";
import { RuleEngine } from "../core/RuleEngine.js?build=20260730-tabletop-hands-v19";
import { randomChoice } from "../utils/helpers.js?build=20260730-tabletop-hands-v19";
import { Debug } from "../utils/debug.js?build=20260730-tabletop-hands-v19";

/**
 * 为本局全部角色注册被动技能。每个监听器使用 playerId:skillId 唯一键，防止重复注册。
 * @param {Object} game 当前 Game 实例。
 * @returns {void}
 */
export function registerPassiveSkills(game) {
  for (const owner of game.state.players) {
    for (const skillId of owner.general.passiveSkillIds) {
      const register = PASSIVE_SKILLS[skillId];
      if (!register) throw new Error(`未注册被动技能：${skillId}`);
      register(game, owner);
      Debug.log("Skill", `注册 ${owner.name}:${skillId}`);
    }
  }
}

const PASSIVE_SKILLS = {
  momentum(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:momentum:category`, (event) => {
      if (!owner.alive || event.source.id !== owner.id) return;
      if (!owner.turnFlags.categoriesUsed.has(event.card.category)) {
        owner.turnFlags.categoriesUsed.add(event.card.category);
        owner.turnFlags.momentum = Math.min(GAME_CONFIG.momentumMaxStacks, owner.turnFlags.momentum + 1);
        game.log(`${owner.name}通过「连势」积累了${owner.turnFlags.momentum}层连势。`);
      }
    });
    game.eventBus.on("beforeDamage", `${owner.id}:momentum:damage`, (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.card?.definitionId !== "assault") return;
      const bonus = owner.turnFlags.momentum + (owner.turnFlags.assaultBonus || 0);
      if (bonus > 0) {
        event.amount += bonus;
        event.metadata.consumeMomentum = owner.turnFlags.momentum > 0;
        event.metadata.consumeAssaultBonus = owner.turnFlags.assaultBonus > 0;
        game.log(`${owner.name}的突袭获得${bonus}点额外伤害。`, "important");
      }
    });
    game.eventBus.on("afterDamage", `${owner.id}:momentum:consume`, (event) => {
      if (event.source?.id !== owner.id || event.actualAmount <= 0) return;
      if (event.metadata.consumeMomentum) owner.turnFlags.momentum = 0;
      if (event.metadata.consumeAssaultBonus) owner.turnFlags.assaultBonus = 0;
    });
  },

  guardianAid(game, owner) {
    game.eventBus.on("beforeDamage", `${owner.id}:guardianAid`, async (event) => {
      if (!owner.alive || !event.target?.alive || owner.id === event.target.id) return;
      if (owner.battleTeam !== event.target.battleTeam || owner.roundFlags.guardianAidUsed || !owner.hand.length || event.amount <= 0) return;
      const use = await game.responseSystem.requestSkillResponse(owner, "guardianAid", "护援", event);
      if (!use || !owner.alive || !owner.hand.length) return;
      let discard = null;
      if (owner.controllerType === "human") discard = (await game.ui.requestDiscard(owner, 1, "护援：选择弃置1张手牌"))[0] ?? null;
      else discard = game.aiController.chooseDiscards(owner, 1)[0] ?? null;
      if (!discard) return;
      await game.discardCardFromHand(owner, discard, "护援");
      owner.roundFlags.guardianAidUsed = true;
      event.amount = Math.max(0, event.amount - 1);
      game.log(`${owner.name}发动护援，令${event.target.name}受到的伤害减少1点。`, "important");
    });
  },

  rejuvenation(game, owner) {
    game.eventBus.on("beforeHeal", `${owner.id}:rejuvenation`, (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.isDyingRescue || owner.turnFlags.rejuvenationUsed) return;
      owner.turnFlags.rejuvenationUsed = true;
      event.amount += 1;
      game.log(`${owner.name}的回春令治疗额外恢复1点。`, "heal");
    });
  },

  spyGap(game, owner) {
    game.eventBus.on("afterDamage", `${owner.id}:spyGap`, (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.target.battleTeam === owner.battleTeam || event.actualAmount <= 0 || owner.turnFlags.spyGapTriggered) return;
      owner.turnFlags.spyGapTriggered = true;
      const seen = randomChoice(event.target.hand, game.random);
      if (!seen) return;
      game.rememberPrivateCard(owner, event.target, seen);
      if (owner.controllerType === "human") game.ui.showPrivateReveal(`窥隙：${event.target.name}持有「${seen.name}」`);
    });
  },

  ember(game, owner) {
    game.eventBus.on("afterDamage", `${owner.id}:ember`, async (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.target.battleTeam === owner.battleTeam || event.actualAmount <= 0 || !event.card) return;
      if (owner.gameFlags.lastEmberResolutionId === event.resolutionId) return;
      owner.gameFlags.lastEmberResolutionId = event.resolutionId;
      await game.gainEnergy(owner, 1, { skill: "ember", reason: "余烬" });
    });
  },

  tracking(game, owner) {
    game.eventBus.on("turnStart", `${owner.id}:tracking:clock`, (event) => {
      if (event.player.id === owner.id) owner.gameFlags.trackingTurnNumber = (owner.gameFlags.trackingTurnNumber ?? 0) + 1;
    });
    game.eventBus.on("targetSelected", `${owner.id}:tracking`, (event) => {
      if (!owner.alive || event.source.id !== owner.id || event.card?.definitionId !== "assault" || owner.turnFlags.trackingTriggered) return;
      owner.turnFlags.trackingTriggered = true;
      event.targets[0].statuses.huntMark = { sourceId: owner.id, expireAtTurnEnd: (owner.gameFlags.trackingTurnNumber ?? 1) + 1 };
      game.log(`${owner.name}在${event.targets[0].name}身上留下了猎印。`, "important");
    });
    game.eventBus.on("turnEnd", `${owner.id}:tracking:cleanup`, (event) => {
      if (event.player.id !== owner.id) return;
      for (const player of game.state.players) {
        const mark = player.statuses.huntMark;
        if (mark?.sourceId === owner.id && mark.expireAtTurnEnd <= (owner.gameFlags.trackingTurnNumber ?? 0)) delete player.statuses.huntMark;
      }
    });
  },

  gamble(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:gamble`, async (event) => {
      if (!owner.alive || event.source.id !== owner.id || event.card.category !== "tactic" || owner.turnFlags.gambleTriggered) return;
      owner.turnFlags.gambleTriggered = true;
      if (game.random() < GAME_CONFIG.gamblerDrawChance) {
        game.log(`${owner.name}的冒险带来了收益。`);
        await game.drawCards(owner, 1, "冒险");
      } else if (owner.hand.length) {
        const discarded = randomChoice(owner.hand, game.random);
        await game.discardCardFromHand(owner, discarded, "冒险");
      }
    });
  },

  coordination(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:coordination`, async (event) => {
      if (!owner.alive || event.source.id !== owner.id || owner.turnFlags.coordinationTriggered) return;
      if (!event.targets.some((target) => target.id !== owner.id && target.battleTeam === owner.battleTeam)) return;
      owner.turnFlags.coordinationTriggered = true;
      game.log(`${owner.name}通过协调摸1张牌。`);
      await game.drawCards(owner, 1, "协调");
    });
  }
};

const baseCanUse = (game, source, skill, minimumEnergy = skill.cost) => {
  if (!source.alive || game.state.phase !== "play" || game.currentPlayer?.id !== source.id) return { ok: false, reason: "只能在自己的出牌阶段发动" };
  if (source.turnFlags.activeSkillsUsed.has(skill.id)) return { ok: false, reason: "本回合已发动" };
  if (source.energy < minimumEnergy) return { ok: false, reason: "能量不足" };
  return { ok: true, reason: "" };
};

export const ACTIVE_SKILLS = Object.freeze({
  breakArmy: Object.freeze({
    id: "breakArmy", name: "破军", cost: 3, targetType: "none", rangeRule: "self",
    canUse(game, source) { return baseCanUse(game, source, this); },
    async execute(game, source) { source.changeEnergy(-3); source.turnFlags.attackLimit += 1; game.log(`${source.name}发动破军，本回合可额外突袭一次。`, "important"); }
  }),
  barrier: Object.freeze({
    id: "barrier", name: "壁垒", cost: 2, targetType: "ally", rangeRule: "ally",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? { ok:false, reason:"没有存活队友" } : base; },
    async execute(game, source, targets) {
      source.changeEnergy(-2);
      const target = targets[0];
      const previousTemporary = Math.min(target.shield, target.statuses.temporaryShield?.amount ?? 0);
      target.shield = Math.max(0, target.shield - previousTemporary) + 1;
      target.statuses.temporaryShield = { amount:1, clearAtTurnStart:true };
      game.ui.queueFeedback?.("shield", target.id, 1);
      game.log(`${source.name}为${target.name}构筑壁垒，获得1点持续至其下次回合开始的护盾。`, "heal");
    }
  }),
  symbiosis: Object.freeze({
    id: "symbiosis", name: "共生", cost: 2, targetType: "injuredAlly", rangeRule: "ally",
    canUse(game, source) { const base = baseCanUse(game, source, this); if (!base.ok) return base; if (source.hp <= 1) return {ok:false,reason:"生命不足"}; return RuleEngine.getSkillTargets(game, source, this).length ? base : {ok:false,reason:"没有受伤队友"}; },
    async execute(game, source, targets) { source.changeEnergy(-2); await game.hpLossSystem.lose(source, 1, { source, reason:"技能·共生" }); if (source.alive) await game.heal(source, targets[0], 2, { skill:"symbiosis" }); }
  }),
  stealSkill: Object.freeze({
    id: "stealSkill", name: "窃取", cost: 3, targetType: "enemyWithCards", rangeRule: "unlimited",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"敌人没有手牌"} : base; },
    async execute(game, source, targets) { source.changeEnergy(-3); const card = randomChoice(targets[0].hand, game.random); if (card) { const stolen = await game.moveCardBetweenHands(targets[0], source, card, "窃取"); if (stolen) game.log(`${source.name}从${targets[0].name}处窃取了${game.cardLabelForHuman(source, card)}。`, "important"); } }
  }),
  burningField: Object.freeze({
    id: "burningField", name: "焚场", cost: 3, targetType: "allEnemies", rangeRule: "unlimited",
    canUse(game, source) { return baseCanUse(game, source, this); },
    async execute(game, source) { source.changeEnergy(-3); game.log(`${source.name}发动焚场！`, "important"); for (const target of game.getEnemies(source)) { if (game.state.isGameOver) break; if (target.alive) await game.damage(source, target, 1, {skill:"burningField",actionName:"焚场",canBlock:false,damageType:"skill"}); } }
  }),
  hunt: Object.freeze({
    id: "hunt", name: "猎杀", cost: 2, targetType: "markedEnemy", rangeRule: "unlimited",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有猎印目标"} : base; },
    async execute(game, source, targets) { source.changeEnergy(-2); delete targets[0].statuses.huntMark; await game.damage(source, targets[0], 2, {skill:"hunt",actionName:"猎杀",canBlock:true,damageType:"skill"}); }
  }),
  allIn: Object.freeze({
    id: "allIn", name: "孤注", cost: 1, targetType: "none", rangeRule: "self",
    canUse(game, source) { return baseCanUse(game, source, this, 1); },
    async execute(game, source) { const energy = source.energy; source.changeEnergy(-energy); await game.drawCards(source, Math.min(2, energy), "孤注"); if (energy >= 3) source.turnFlags.assaultBonus += 1; game.log(`${source.name}以${energy}点能量发动孤注。`, "important"); }
  }),
  resonance: Object.freeze({
    id: "resonance", name: "共鸣", cost: 2, targetType: "ally", rangeRule: "ally",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有存活队友"} : base; },
    async execute(game, source, targets) { source.changeEnergy(-2); await game.drawCards(targets[0], 2, "共鸣"); game.log(`${source.name}与${targets[0].name}共鸣，令其摸2张牌。`); }
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

/** 返回被动技能是否存在注册器，供启动自检与扩展检查使用。 */
export function hasPassiveSkill(skillId) {
  return typeof PASSIVE_SKILLS[skillId] === "function";
}
