/**
 * 本文件实现八名角色的被动监听器与主动技能标准接口，依赖 EventBus、RuleEngine 和 Game 服务。
 * 角色配置只保存技能 ID；核心伤害与回合模块不会出现角色名称分支。
 * 重新开始时 EventBus.clear 会移除全部监听器，随后新玩家重新注册。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260801-card-art-invariant-v35";
import { RuleEngine } from "../core/RuleEngine.js?build=20260801-card-art-invariant-v35";
import { randomChoice } from "../utils/helpers.js?build=20260801-card-art-invariant-v35";
import { Debug } from "../utils/debug.js?build=20260801-card-art-invariant-v35";

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
      const bonus = owner.turnFlags.momentum;
      if (bonus > 0) {
        event.amount += bonus;
        event.metadata.consumeMomentum = owner.turnFlags.momentum > 0;
        game.log(`${owner.name}的突袭获得${bonus}点额外伤害。`, "important");
      }
    });
    game.eventBus.on("afterDamage", `${owner.id}:momentum:consume`, (event) => {
      if (event.source?.id !== owner.id || event.actualAmount <= 0) return;
      if (event.metadata.consumeMomentum) owner.turnFlags.momentum = 0;
    });
  },

  guardianAid(game, owner) {
    game.eventBus.on("beforeDamage", `${owner.id}:guardianAid`, async (event) => {
      const gameId = game.state.gameId;
      if (!owner.alive || !event.target?.alive || owner.id === event.target.id) return;
      if (owner.battleTeam !== event.target.battleTeam || owner.roundFlags.guardianAidUsed || !owner.hand.length || event.amount <= 0) return;
      const response = await game.responseSystem.requestSkillResponse(owner, "guardianAid", "护援", event);
      if (!game.isSessionValid(gameId) || response.status !== "used" || !owner.alive || !owner.hand.length) return;
      let discard = null;
      if (owner.controllerType === "human") discard = (await game.ui.requestDiscard(owner, 1, "护援：选择弃置1张手牌"))[0] ?? null;
      else discard = game.aiController.chooseDiscards(owner, 1)[0] ?? null;
      if (!game.isSessionValid(gameId)) return;
      if (!discard) return;
      const moved = await game.discardCardFromHand(owner, discard, "护援");
      if (!game.isSessionValid(gameId) || !moved) return;
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
    game.eventBus.on("afterDamage", `${owner.id}:spyGap`, async (event) => {
      const gameId = game.state.gameId;
      if (!owner.alive || event.source?.id !== owner.id || !event.target?.alive || event.target.hp <= 0
        || event.target.battleTeam === owner.battleTeam || event.actualAmount <= 0
        || owner.turnFlags.spyGapTriggered || !event.target.hand.length) return;
      owner.turnFlags.spyGapTriggered = true;
      const intent = await game.preparePrivateHandPeekIntent(owner, event.target, 2, `窥隙：选择查看${event.target.name}至多2张手牌`);
      if (!game.isSessionValid(gameId)) return;
      const seen = game.resolvePrivateHandPeekIntent(owner, intent);
      if (!seen.length) return;
      for (const card of seen) game.rememberPrivateCard(owner, event.target, card);
      if (owner.controllerType === "human") await game.ui.showPrivateReveal(`窥隙：${event.target.name}的手牌`, seen);
      if (!game.isSessionValid(gameId)) return;
      game.log(`${owner.name}发动窥隙，查看了${event.target.name}的${seen.length}张手牌。`);
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
      } else game.log(`${owner.name}的冒险没有带来额外收益。`);
    });
    game.eventBus.on("beforeDamage", `${owner.id}:allIn:damage`, (event) => {
      const allIn = owner.statuses.allIn;
      if (!owner.alive || event.source?.id !== owner.id || event.card?.definitionId !== "assault" || !allIn) return;
      event.amount += allIn.assaultBonus;
      event.metadata.consumeAssaultBonus = true;
      game.log(`${owner.name}的孤注令此次突袭伤害+1。`, "important");
    });
    game.eventBus.on("afterDamage", `${owner.id}:allIn:consume`, (event) => {
      if (event.source?.id === owner.id && event.metadata.consumeAssaultBonus) {
        delete owner.statuses.allIn;
        game.log(`${owner.name}的孤注状态已结束。`);
      }
    });
  },

  coordination(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:coordination`, async (event) => {
      if (event.cancelled) return;
      if (!owner.alive || event.source.id !== owner.id || owner.turnFlags.coordinationTriggered) return;
      const effectiveTargets = event.effectiveTargets ?? event.targets ?? [];
      if (!effectiveTargets.some((target) => target.id !== owner.id && target.battleTeam === owner.battleTeam)) return;
      owner.turnFlags.coordinationTriggered = true;
      game.log(`${owner.name}通过协调摸1张牌。`);
      await game.drawCards(owner, 1, "协调");
    });
  }
};

const baseCanUse = (game, source, skill, minimumEnergy = skill.cost) => {
  if (!source.alive || game.state.phase !== "play" || game.currentPlayer?.id !== source.id) return { ok: false, reason: "只能在自己的出牌阶段发动" };
  const used = source.turnFlags.activeSkillUseCounts?.[skill.id] ?? (source.turnFlags.activeSkillsUsed.has(skill.id) ? 1 : 0);
  if (used >= (skill.limitPerTurn ?? 1)) return { ok: false, reason: "本回合发动次数已用尽" };
  if (source.energy < minimumEnergy) return { ok: false, reason: "能量不足" };
  return { ok: true, reason: "" };
};

export const ACTIVE_SKILLS = Object.freeze({
  breakArmy: Object.freeze({
    id: "breakArmy", name: "破军", cost: 2, limitPerTurn: 1, targetType: "none", rangeRule: "self",
    canUse(game, source) { return baseCanUse(game, source, this); },
    async execute(game, source) { source.changeEnergy(-2); source.turnFlags.attackLimit += 1; game.log(`${source.name}发动破军，本回合可额外突袭一次。`, "important"); }
  }),
  barrier: Object.freeze({
    id: "barrier", name: "壁垒", cost: 2, limitPerTurn: 2, targetType: "ally", rangeRule: "ally",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? { ok:false, reason:"没有存活队友" } : base; },
    async execute(game, source, targets) {
      source.changeEnergy(-2);
      const target = targets[0];
      target.shield += 1;
      target.statuses.temporaryShield = { amount:(target.statuses.temporaryShield?.amount ?? 0) + 1, clearAtTurnStart:true };
      game.ui.queueFeedback?.("shield", target.id, 1);
      game.log(`${source.name}为${target.name}构筑壁垒，获得1点可叠加且持续至其下次回合开始的护盾。`, "heal");
    }
  }),
  symbiosis: Object.freeze({
    id: "symbiosis", name: "共生", cost: 2, limitPerTurn: 2, targetType: "injuredAlly", rangeRule: "ally",
    canUse(game, source) { const base = baseCanUse(game, source, this); if (!base.ok) return base; return RuleEngine.getSkillTargets(game, source, this).length ? base : {ok:false,reason:"没有受伤队友"}; },
    async execute(game, source, targets) { source.changeEnergy(-2); await game.heal(source, targets[0], 1, { skill:"symbiosis" }); }
  }),
  stealSkill: Object.freeze({
    id: "stealSkill", name: "窃取", cost: 2, limitPerTurn: 1, targetType: "enemyWithCardsOrEquipment", rangeRule: "fixed", range: 2,
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"距离2内没有持有手牌或装备的敌人"} : base; },
    async execute(game, source, targets) {
      const gameId = game.state.gameId;
      source.changeEnergy(-2);
      const target = targets[0];
      const options = [...target.hand.map((card) => ({ card, zone:"hand" })), ...(target.equipment ? [{ card:target.equipment, zone:"equipment" }] : [])];
      const chosen = randomChoice(options, game.random);
      if (!chosen) return;
      const stolen = chosen.zone === "equipment"
        ? await game.moveEquipmentToHand(target, source, chosen.card, "窃取")
        : await game.moveCardBetweenHands(target, source, chosen.card, "窃取");
      if (!game.isSessionValid(gameId)) return;
      if (stolen) game.log(`${source.name}从${target.name}处窃取了${game.cardLabelForHuman(source, chosen.card)}并收入手牌。`, "important");
    }
  }),
  burningField: Object.freeze({
    id: "burningField", name: "焚场", cost: 3, limitPerTurn: 1, targetType: "allEnemies", rangeRule: "unlimited",
    canUse(game, source) { return baseCanUse(game, source, this); },
    async execute(game, source) { const gameId=game.state.gameId;source.changeEnergy(-3);game.log(`${source.name}发动焚场！`, "important");for(const target of game.getEnemies(source)){if(!game.isSessionValid(gameId)||game.state.isGameOver)break;if(target.alive)await game.damage(source,target,1,{skill:"burningField",actionName:"焚场",canBlock:false,damageType:"skill"});} }
  }),
  hunt: Object.freeze({
    id: "hunt", name: "猎杀", cost: 2, limitPerTurn: 2, targetType: "markedEnemy", rangeRule: "unlimited",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有猎印目标"} : base; },
    async execute(game, source, targets) { const gameId=game.state.gameId;source.changeEnergy(-2);delete targets[0].statuses.huntMark;const context={skill:"hunt",actionName:"猎杀",canBlock:true,damageType:"skill"};await game.damage(source,targets[0],2,context);if(!game.isSessionValid(gameId))return;if(context.blockedByCard&&source.alive)await game.drawCards(source,1,"猎杀被格挡"); }
  }),
  allIn: Object.freeze({
    id: "allIn", name: "孤注", cost: 1, limitPerTurn: 1, targetType: "none", rangeRule: "self",
    canUse(game, source) {
      const base = baseCanUse(game, source, this, 1);
      return base.ok && source.statuses.allIn ? { ok:false, reason:"已处于孤注状态" } : base;
    },
    async execute(game, source) {
      const gameId = game.state.gameId;
      const energy = source.energy;
      const chance = Math.min(1, energy * .3);
      source.changeEnergy(-energy);
      await game.drawCards(source, energy, "孤注");
      if (!game.isSessionValid(gameId)) return;
      const entered = game.random() < chance;
      if (entered) source.statuses.allIn = { assaultBonus:1 };
      game.log(`${source.name}以${energy}点能量发动孤注并摸${energy}张牌，${entered ? "进入" : "未进入"}孤注状态（${Math.round(chance * 100)}%）。`, "important");
    }
  }),
  resonance: Object.freeze({
    id: "resonance", name: "共鸣", cost: 2, limitPerTurn: 2, targetType: "ally", rangeRule: "ally",
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有存活队友"} : base; },
    async execute(game, source, targets) { const gameId=game.state.gameId;source.changeEnergy(-2);await game.drawCards(targets[0],2,"共鸣");if(game.isSessionValid(gameId))game.log(`${source.name}与${targets[0].name}共鸣，令其摸2张牌。`); }
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
