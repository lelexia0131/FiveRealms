/**
 * 本文件实现八名角色的被动监听器与主动技能标准接口，依赖 EventBus、RuleEngine 和 Game 服务。
 * 角色配置只保存技能 ID；核心伤害与回合模块不会出现角色名称分支。
 * 重新开始时 EventBus.clear 会移除全部监听器，随后新玩家重新注册。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260815-shadow-agent-p1-slot";
import { ACTIVE_SKILL_DEFINITIONS } from "../domain/definitions/skills/SkillDefinitions.js?build=20260815-shadow-agent-p1-slot";
import { changeEnergy, changeShield } from "../domain/state/transitions/ResourceTransitions.js?build=20260815-shadow-agent-p1-slot";
import { removeStatus, setStatus } from "../domain/state/transitions/StatusTransitions.js?build=20260815-shadow-agent-p1-slot";
import { addSpyGapPendingTarget, addTrackingTarget, incrementAttackLimit, markCategoryUsed, removeSpyGapPendingTarget, setCoordinationTriggered, setGambleTriggered, setGuardianAidUsed, setLastEmberResolutionId, setMomentum, setRejuvenationTriggerCount, setSpyGapTriggered, setTrackingTurnNumber } from "../domain/state/transitions/RuleUsageTransitions.js?build=20260815-shadow-agent-p1-slot";
import { RuleEngine } from "../core/RuleEngine.js?build=20260815-shadow-agent-p1-slot";
import { randomChoice } from "../utils/helpers.js?build=20260815-shadow-agent-p1-slot";
import { Debug } from "../utils/debug.js?build=20260815-shadow-agent-p1-slot";

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
  /*
  功能
  注册连势被动监听器；动量提交经 RuleUsageTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  EventBus、玩家类别与 momentum。

  写入状态
  categoriesUsed/momentum 经 RuleUsageTransition。

  调用函数
  markCategoryUsed、setMomentum。

  边界与不变量
  触发顺序与日志不变。
  */
  momentum(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:momentum:category`, (event) => {
      if (!owner.alive || event.source.id !== owner.id) return;
      if (!owner.turnFlags.categoriesUsed.has(event.card.category)) {
        markCategoryUsed(game.state, owner, event.card.category);
        const previousMomentum = owner.turnFlags.momentum;
        setMomentum(game.state, owner, Math.min(GAME_CONFIG.momentumMaxStacks, previousMomentum + 1));
        if (owner.turnFlags.momentum > previousMomentum) {
          game.log(`${owner.name}触发「连势」，现有${owner.turnFlags.momentum}层「连势」。`);
        }
      }
    });
    game.eventBus.on("beforeDamage", `${owner.id}:momentum:damage`, (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.card?.definitionId !== "assault") return;
      const bonus = owner.turnFlags.momentum;
      if (bonus > 0) {
        event.amount += bonus;
        event.metadata.consumeMomentum = true;
        event.metadata.momentumBonus = bonus;
      }
    });
    game.eventBus.on("afterDamage", `${owner.id}:momentum:consume`, (event) => {
      if (event.source?.id !== owner.id || event.actualAmount <= 0) return;
      if (event.metadata.consumeMomentum) {
        const consumed = event.metadata.momentumBonus;
        setMomentum(game.state, owner, 0);
        game.log(`${owner.name}消耗${consumed}层「连势」，本次「突袭」伤害+${consumed}。`, "important");
      }
    });
    game.eventBus.on("turnEnd", `${owner.id}:momentum:turnEnd`, () => {
      // 「回合结束后清空连势」指任意行动角色的全局回合结束，而非只清空刃行者自己的回合。
      // 回合外借势等路径产生的 momentum 必须在当前全局回合 turnEnd 立即归零。
      setMomentum(game.state, owner, 0);
    });
  },

  /*
  功能
  注册护援被动监听器；护援额度经 RuleUsageTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  EventBus、响应系统与手牌。

  写入状态
  guardianAidUsed 经 RuleUsageTransition。

  调用函数
  setGuardianAidUsed、game.discardCardFromHand。

  边界与不变量
  响应与弃牌顺序不变。
  */
  guardianAid(game, owner) {
    game.eventBus.on("beforeDamage", `${owner.id}:guardianAid`, async (event) => {
      const gameId = game.state.gameId;
      if (!owner.alive || !event.target?.alive || owner.id === event.target.id) return;
      if (owner.battleTeam !== event.target.battleTeam || owner.turnFlags.guardianAidUsed || !owner.hand.length || event.amount <= 0) return;
      const response = await game.responseSystem.requestSkillResponse(owner, "guardianAid", "护援", event);
      if (!game.isSessionValid(gameId) || response.status !== "used" || !owner.alive || !owner.hand.length) return;
      let discard = null;
      if (owner.controllerType === "human") discard = (await game.ui.requestDiscard(owner, 1, "护援：选择弃置1张手牌"))[0] ?? null;
      else discard = game.aiController.chooseDiscards(owner, 1)[0] ?? null;
      if (!game.isSessionValid(gameId)) return;
      if (!discard) return;
      const moved = await game.discardCardFromHand(owner, discard, "护援", { logReason:"「护援」" });
      if (!game.isSessionValid(gameId) || !moved) return;
      setGuardianAidUsed(game.state, owner, true);
      event.amount = Math.max(0, event.amount - 1);
      game.log(`${owner.name}发动「护援」，令${event.target.name}受到的伤害减少1点。`, "important");
    });
  },

  /*
  功能
  注册回春被动监听器；触发计数经 RuleUsageTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  EventBus、治疗事件与触发计数。

  写入状态
  rejuvenationTriggerCount 经 RuleUsageTransition。

  调用函数
  setRejuvenationTriggerCount、game.drawCards。

  边界与不变量
  重置与触发顺序不变。
  */
  rejuvenation(game, owner) {
    game.eventBus.on("turnStart", `${owner.id}:rejuvenation:reset`, () => {
      setRejuvenationTriggerCount(game.state, owner, 0);
    });
    game.eventBus.on("afterHeal", `${owner.id}:rejuvenation`, async (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.target?.battleTeam !== owner.battleTeam
        || event.actualAmount <= 0 || (owner.turnFlags.rejuvenationTriggerCount ?? 0) >= 2) return;
      setRejuvenationTriggerCount(game.state, owner, (owner.turnFlags.rejuvenationTriggerCount ?? 0) + 1);
      const gameId = game.state.gameId;
      const drawn = await game.drawCards(owner, 1, "回春", { silent:true });
      if (!game.isSessionValid(gameId)) return;
      game.log(`${owner.name}触发「回春」，${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`, "heal");
    });
  },

  /*
  功能
  注册窥隙被动监听器；窥隙额度与 pending 目标经 RuleUsageTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  EventBus、伤害/救援事件与手牌。

  写入状态
  spyGap flags 经 RuleUsageTransition。

  调用函数
  setSpyGapTriggered、setSpyGapPendingTargetIds、add/removeSpyGapPendingTarget。

  边界与不变量
  私密窥牌与日志顺序不变。
  */
  spyGap(game, owner) {
    /*
    功能
    执行一次窥隙查看并提交触发额度。

    调用方
    spyGap 内部监听器。

    输入
    目标 Player。

    输出
    无返回值。

    读取状态
    owner 额度、目标手牌与 Game 私密选择。

    写入状态
    spyGapTriggered 经 RuleUsageTransition；AI 记忆经既有 API。

    调用函数
    setSpyGapTriggered、game.preparePrivateHandPeekIntent。

    边界与不变量
    只查看合法数量且不公开牌面。
    */
    async function revealGap(target) {
      const gameId = game.state.gameId;
      if (!owner.alive || !target?.alive || target.hp <= 0
        || target.battleTeam === owner.battleTeam
        || owner.turnFlags.spyGapTriggered || !target.hand.length) return;
      setSpyGapTriggered(game.state, owner, true);
      const intent = await game.preparePrivateHandPeekIntent(owner, target, 2, `窥隙：选择查看${target.name}至多2张手牌`);
      if (!game.isSessionValid(gameId)) return;
      const seen = game.resolvePrivateHandPeekIntent(owner, intent);
      if (!seen.length) return;
      for (const card of seen) game.rememberPrivateCard(owner, target, card);
      if (owner.controllerType === "human") await game.ui.showPrivateReveal(`窥隙：${target.name}的手牌`, seen);
      if (!game.isSessionValid(gameId)) return;
      game.log(`${owner.name}触发「窥隙」，查看了${target.name}的${seen.length}张手牌。`);
    }

    game.eventBus.on("afterDamage", `${owner.id}:spyGap`, async (event) => {
      if (!owner.alive || event.source?.id !== owner.id || !event.target?.alive
        || event.target.battleTeam === owner.battleTeam || event.actualAmount <= 0
        || owner.turnFlags.spyGapTriggered) return;
      if (event.target.hp > 0) {
        await revealGap(event.target);
        return;
      }
      if (!owner.turnFlags.spyGapPendingTargetIds) setSpyGapPendingTargetIds(game.state, owner, new Set());
      addSpyGapPendingTarget(game.state, owner, event.target.id);
    });

    game.eventBus.on("playerRescued", `${owner.id}:spyGap:rescue`, async (event) => {
      const pending = owner.turnFlags.spyGapPendingTargetIds;
      if (!pending?.has(event.target?.id)) return;
      pending.delete(event.target.id);
      await revealGap(event.target);
    });

    game.eventBus.on("playerDead", `${owner.id}:spyGap:dead`, (event) => {
      if (event.target?.id) removeSpyGapPendingTarget(game.state, owner, event.target.id);
    });
  },

  /*
  功能
  注册余烬被动监听器；resolution 标记经 RuleUsageTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  EventBus、伤害事件与 gameFlags。

  写入状态
  lastEmberResolutionId 经 RuleUsageTransition。

  调用函数
  setLastEmberResolutionId、game.gainEnergy。

  边界与不变量
  每次卡牌结算最多触发一次。
  */
  ember(game, owner) {
    game.eventBus.on("afterDamage", `${owner.id}:ember`, async (event) => {
      if (!owner.alive || event.source?.id !== owner.id || event.target.battleTeam === owner.battleTeam || event.actualAmount <= 0 || !event.card) return;
      if (owner.gameFlags.lastEmberResolutionId === event.resolutionId) return;
      setLastEmberResolutionId(game.state, owner, event.resolutionId);
      await game.gainEnergy(owner, 1, { skill: "ember", reason: "余烬" });
    });
  },

  /*
  功能
  注册追踪被动技能监听器；状态提交经 StatusTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  Game EventBus 与玩家 flags/statuses。

  写入状态
  turnFlags/gameFlags 仍为 deferred；status 经 StatusTransition。

  调用函数
  setStatus、removeStatus。

  边界与不变量
  追踪触发规则保持不变。
  */
  tracking(game, owner) {
    game.eventBus.on("turnStart", `${owner.id}:tracking:clock`, (event) => {
      if (event.player.id === owner.id) setTrackingTurnNumber(game.state, owner, (owner.gameFlags.trackingTurnNumber ?? 0) + 1);
    });
    game.eventBus.on("targetSelected", `${owner.id}:tracking`, (event) => {
      const target = event.targets[0];
      if (!owner.alive || event.source.id !== owner.id || event.card?.definitionId !== "assault" || !target
        || target.battleTeam === owner.battleTeam || owner.turnFlags.trackingTargetIds.size >= 2
        || owner.turnFlags.trackingTargetIds.has(target.id)) return;
      addTrackingTarget(game.state, owner, target.id);
      const currentTrackingTurn = owner.gameFlags.trackingTurnNumber ?? 0;
      setStatus(game.state, target, "huntMark", { sourceId: owner.id, expireAtTurnEnd: currentTrackingTurn + 1 });
      game.log(`${owner.name}触发「追踪」，在${target.name}身上留下了「猎印」。`, "important");
    });
    game.eventBus.on("turnEnd", `${owner.id}:tracking:cleanup`, (event) => {
      if (event.player.id !== owner.id) return;
      for (const player of game.state.players) {
        const mark = player.statuses.huntMark;
        if (mark?.sourceId === owner.id && mark.expireAtTurnEnd <= (owner.gameFlags.trackingTurnNumber ?? 0)) removeStatus(game.state, player, "huntMark");
      }
    });
  },

  /*
  功能
  注册冒险/孤注被动技能监听器；状态提交经 StatusTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  Game EventBus、玩家 flags 与状态。

  写入状态
  flags 仍 deferred；status 经 StatusTransition。

  调用函数
  setStatus、removeStatus、game.drawCards。

  边界与不变量
  随机判定与日志顺序不变。
  */
  gamble(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:gamble`, async (event) => {
      if (!owner.alive || event.source.id !== owner.id || event.card.category !== "tactic" || owner.turnFlags.gambleTriggered) return;
      setGambleTriggered(game.state, owner, true);
      if (game.random() < GAME_CONFIG.gamblerDrawChance) {
        const gameId = game.state.gameId;
        const drawn = await game.drawCards(owner, 1, "冒险", { silent:true });
        if (!game.isSessionValid(gameId)) return;
        game.log(`${owner.name}触发「冒险」，${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`);
      } else game.log(`${owner.name}触发「冒险」，但未获得额外收益。`);
    });
    game.eventBus.on("beforeDamage", `${owner.id}:allIn:damage`, (event) => {
      const allIn = owner.statuses.allIn;
      if (!owner.alive || event.source?.id !== owner.id || event.card?.definitionId !== "assault" || !allIn) return;
      event.amount += allIn.assaultBonus;
      event.metadata.consumeAssaultBonus = true;
      game.log(`${owner.name}的「孤注」状态令此次「突袭」伤害+1。`, "important");
    });
    game.eventBus.on("afterDamage", `${owner.id}:allIn:consume`, (event) => {
      if (!owner.statuses.allIn) return;
      const assaultFinishedWithoutDamage = event.card?.definitionId === "assault"
        && ["block", "defenseDevice"].includes(event.preventedBy);
      if (event.source?.id === owner.id
        && (event.metadata.consumeAssaultBonus || assaultFinishedWithoutDamage)) {
        removeStatus(game.state, owner, "allIn");
        game.log(`${owner.name}退出「孤注」状态。`);
      }
    });
  },

  /*
  功能
  注册协调被动监听器；协调额度经 RuleUsageTransition。

  调用方
  registerPassiveSkills。

  输入
  Game 与 owner。

  输出
  无返回值。

  读取状态
  EventBus、卡牌有效目标与额度。

  写入状态
  coordinationTriggered 经 RuleUsageTransition。

  调用函数
  setCoordinationTriggered、game.drawCards。

  边界与不变量
  每回合只触发一次。
  */
  coordination(game, owner) {
    game.eventBus.on("cardUsed", `${owner.id}:coordination`, async (event) => {
      if (!owner.alive || event.resolved !== true || event.source?.id !== owner.id
        || owner.turnFlags.coordinationTriggered) return;
      if (!(event.effectiveTargets ?? []).some((target) => target?.alive && target.id !== owner.id
        && target.battleTeam === owner.battleTeam)) return;
      setCoordinationTriggered(game.state, owner, true);
      const gameId = game.state.gameId;
      const drawn = await game.drawCards(owner, 1, "协调", { silent:true });
      if (!game.isSessionValid(gameId)) return;
      game.log(`${owner.name}触发「协调」，${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`);
    });
  }
};

/** 解析主动技能在当前真实或模拟状态中的实际能量成本。 */
export function getActiveSkillCost(gameOrState, source, skill) {
  if (!skill) return 0;
  const rawCost = typeof skill.getCost === "function"
    ? skill.getCost(gameOrState, source)
    : skill.cost;
  return Math.max(0, Number(rawCost) || 0);
}

const baseCanUse = (game, source, skill, minimumEnergy = getActiveSkillCost(game, source, skill)) => {
  if (!source.alive || game.state.phase !== "play" || game.currentPlayer?.id !== source.id) return { ok: false, reason: "只能在自己的出牌阶段发动" };
  const used = source.turnFlags.activeSkillUseCounts?.[skill.id] ?? (source.turnFlags.activeSkillsUsed.has(skill.id) ? 1 : 0);
  if (used >= (skill.limitPerTurn ?? 1)) return { ok: false, reason: "本回合发动次数已用尽" };
  if (source.energy < minimumEnergy) return { ok: false, reason: "能量不足" };
  return { ok: true, reason: "" };
};

/*
功能
把 Domain Skill Definition 投影为 ACTIVE_SKILLS 既有 runtime shape。

调用方
ACTIVE_SKILLS 模块初始化。

输入
active skill definition id。

输出
只含旧 runtime 字段的技能对象，不包含 description。

读取状态
ACTIVE_SKILL_DEFINITIONS。

写入状态
无。

调用函数
无。

边界与不变量
不维护任何 cost/limit/target/range literal；字段顺序与迁移前一致。
*/
const runtimeSkill = (skillId) => {
  const definition = ACTIVE_SKILL_DEFINITIONS[skillId];
  return {
    id: definition.id,
    name: definition.name,
    cost: definition.cost,
    limitPerTurn: definition.limitPerTurn,
    targetType: definition.targetType,
    rangeRule: definition.rangeRule,
    ...(definition.range !== undefined ? { range: definition.range } : {})
  };
};

export const ACTIVE_SKILLS = Object.freeze({
  breakArmy: Object.freeze({
    ...runtimeSkill("breakArmy"),
    canUse(game, source) { return baseCanUse(game, source, this); },
    /*
    功能
    提交破军技能已决定的费用与攻击上限变化。

    调用方
    Game.useActiveSkill。

    输入
    Game 与 source。

    输出
    无显式返回值。

    读取状态
    source 能量与 attackLimit。

    写入状态
    能量经 ResourceTransition；attackLimit 经 RuleUsageTransition。

    调用函数
    changeEnergy、incrementAttackLimit。

    边界与不变量
    不重新判断技能合法性。
    */
    async execute(game, source) { changeEnergy(game.state, source, -2); incrementAttackLimit(game.state, source, 1); game.log(`${source.name}发动「破军」，本回合可额外使用1张「突袭」。`, "important"); }
  }),
  barrier: Object.freeze({
    ...runtimeSkill("barrier"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? { ok:false, reason:"没有存活队友" } : base; },
    /*
    功能
    提交壁垒技能已决定的护盾写入。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量与 target。

    写入状态
    能量经 Player façade；护盾经 ResourceTransition。

    调用函数
    changeShield、Player.changeEnergy。

    边界与不变量
    不重新判断技能合法性。
    */
    async execute(game, source, targets) {
      changeEnergy(game.state, source, -this.cost);
      const target = targets[0];
      changeShield(game.state, target, 1);
      game.ui.queueFeedback?.("shield", target.id, 1);
      game.log(`${source.name}发动「壁垒」，令${target.name}获得1点护盾。`, "heal");
    }
  }),
  symbiosis: Object.freeze({
    ...runtimeSkill("symbiosis"),
    canUse(game, source) { const base = baseCanUse(game, source, this); if (!base.ok) return base; return RuleEngine.getSkillTargets(game, source, this).length ? base : {ok:false,reason:"自己和队友都未受伤"}; },
    /*
    功能
    提交滋荣技能已决定的费用与治疗 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量与 target。

    写入状态
    能量经 ResourceTransition；治疗经 Game.heal。

    调用函数
    changeEnergy、game.heal。

    边界与不变量
    日志顺序不变。
    */
    async execute(game, source, targets) {
      changeEnergy(game.state, source, -this.cost);
      const target = targets[0];
      game.log(
        target.id === source.id
          ? `${source.name}对自己发动「滋荣」。`
          : `${source.name}对${target.name}发动「滋荣」。`,
        "important"
      );
      await game.heal(source, target, 1, { skill:"symbiosis" });
    }
  }),
  stealSkill: Object.freeze({
    ...runtimeSkill("stealSkill"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"距离2内没有持有手牌或装备的敌人"} : base; },
    /*
    功能
    提交窃取技能已决定的费用、随机资源选择与移动 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量、target 手牌/装备与随机源。

    写入状态
    能量经 ResourceTransition；移动经 Game zone workflow。

    调用函数
    changeEnergy、randomChoice、game.moveEquipmentToHand/moveCardBetweenHands。

    边界与不变量
    随机调用与日志顺序不变。
    */
    async execute(game, source, targets) {
      const gameId = game.state.gameId;
      changeEnergy(game.state, source, -this.cost);
      const target = targets[0];
      const options = [...target.hand.map((card) => ({ card, zone:"hand" })), ...(target.equipment ? [{ card:target.equipment, zone:"equipment" }] : [])];
      const chosen = randomChoice(options, game.random);
      if (!chosen) return;
      const stolen = chosen.zone === "equipment"
        ? await game.moveEquipmentToHand(target, source, chosen.card, "窃取")
        : await game.moveCardBetweenHands(target, source, chosen.card, "窃取");
      if (!game.isSessionValid(gameId)) return;
      if (stolen) game.log(`${source.name}发动「窃取」，从${target.name}处获得${game.cardLabelForHuman(source, chosen.card)}并收入手牌。`, "important");
    }
  }),
  burningField: Object.freeze({
    ...runtimeSkill("burningField"),
    canUse(game, source, energyCost = getActiveSkillCost(game, source, this)) {
      return baseCanUse(game, source, this, energyCost);
    },
    /*
    功能
    提交焚场技能已决定的费用与逐目标伤害 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source、targets 与 context。

    输出
    无显式返回值。

    读取状态
    source 能量、敌人与 Game workflow。

    写入状态
    能量经 ResourceTransition；伤害经 Game.damage。

    调用函数
    changeEnergy、game.damage。

    边界与不变量
    逐目标顺序与响应顺序不变。
    */
    async execute(game, source, _targets, context = {}) {
      const gameId = game.state.gameId;
      const energyCost = context.energyCost ?? getActiveSkillCost(game, source, this);
      changeEnergy(game.state, source, -energyCost);
      game.log(`${source.name}发动「焚场」。`, "important");
      for (const target of game.getEnemies(source)) {
        if (!game.isSessionValid(gameId) || game.state.isGameOver) break;
        if (target.alive) await game.damage(source, target, 1, {
          skill:"burningField", actionName:"焚场", canBlock:true,
          damageType:"skill", resolutionId:context.resolutionId
        });
      }
    }
  }),
  hunt: Object.freeze({
    ...runtimeSkill("hunt"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有猎印目标"} : base; },
    /*
    功能
    提交猎杀技能已决定的费用、状态移除与伤害 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量、target 状态与 Game workflow。

    写入状态
    能量经 Player façade；status 经 StatusTransition。

    调用函数
    removeStatus、game.damage。

    边界与不变量
    不重新判断技能合法性。
    */
    async execute(game, source, targets) { const gameId=game.state.gameId;const target=targets[0];game.log(`${source.name}对${target.name}发动「猎杀」。`,"important");changeEnergy(game.state, source, -2);removeStatus(game.state, target, "huntMark");const context={skill:"hunt",actionName:"猎杀",canBlock:true,damageType:"skill"};await game.damage(source,target,2,context);if(!game.isSessionValid(gameId))return;if(context.blockedByCard&&source.alive)await game.drawCards(source,1,"猎杀被格挡"); }
  }),
  allIn: Object.freeze({
    ...runtimeSkill("allIn"),
    canUse(game, source) {
      return baseCanUse(game, source, this, 1);
    },
    /*
    功能
    提交孤注技能已决定的资源消耗、摸牌与状态写入。

    调用方
    Game.useActiveSkill。

    输入
    Game 与 source。

    输出
    无显式返回值。

    读取状态
    source 能量、Game 随机源与状态。

    写入状态
    能量经 Player façade；状态经 StatusTransition。

    调用函数
    setStatus、game.drawCards。

    边界与不变量
    随机调用次数与日志顺序不变。
    */
    async execute(game, source) {
      const gameId = game.state.gameId;
      const hadAllInBefore = Boolean(source.statuses.allIn);
      const energy = source.energy;
      const drawCount = Math.max(0, energy - 1);
      const chance = Math.min(1, energy * .25);
      changeEnergy(game.state, source, -energy);
      const drawn = await game.drawCards(source, drawCount, "孤注", { silent:true });
      if (!game.isSessionValid(gameId)) return;
      const entered = game.random() < chance;
      if (entered) setStatus(game.state, source, "allIn", { assaultBonus:1 });
      if (hadAllInBefore) {
        game.log(`${source.name}消耗${energy}点能量发动「孤注」，${drawn ? `摸${drawn}张牌` : "未摸到牌"}，原有「孤注」状态保持不变。`, "important");
      } else {
        game.log(`${source.name}消耗${energy}点能量发动「孤注」，${drawn ? `摸${drawn}张牌` : "未摸到牌"}，${entered ? "并进入" : "但未进入"}「孤注」状态。`, "important");
      }
    }
  }),
  resonance: Object.freeze({
    ...runtimeSkill("resonance"),
    canUse(game, source) { const base = baseCanUse(game, source, this); return base.ok && !RuleEngine.getSkillTargets(game, source, this).length ? {ok:false,reason:"没有存活队友"} : base; },
    /*
    功能
    提交共鸣技能已决定的费用与摸牌 workflow。

    调用方
    Game.useActiveSkill。

    输入
    Game、source 与 targets。

    输出
    无显式返回值。

    读取状态
    source 能量与目标。

    写入状态
    能量经 ResourceTransition；摸牌经 Game.drawCards。

    调用函数
    changeEnergy、game.drawCards。

    边界与不变量
    日志顺序不变。
    */
    async execute(game, source, targets) { const gameId=game.state.gameId;changeEnergy(game.state, source, -this.cost);const drawn=await game.drawCards(targets[0],1,"共鸣",{silent:true});if(game.isSessionValid(gameId))game.log(`${source.name}发动「共鸣」，令${targets[0].name}${drawn ? `摸${drawn}张牌` : "未摸到牌"}。`); }
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
