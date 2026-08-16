/*
模块职责
唯一拥有角色被动技能 trigger registration：WHEN/IF 事件接收、rule predicate query、effect workflow invocation 与 once-per-turn/round commit；不拥有 Domain Skill Rule、active skill execute 或完整 EventBus/Messaging。

上游
skillRegistry legacy façade 与 Game temporary composition root。

下游
Domain rules、Application workflows 与 narrow legacy collaborators。

状态边界
Domain mutation 经 transitions/workflows；trigger runtime state 经 transitions。

信息边界
不读取 UI/AI/DOM/Planner；private peek 经 opaque selection collaborator。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、concrete adapters 或 config runtime。
*/
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js?build=20260816-legacy-recovery";
import { removeStatus, setStatus } from "../../domain/state/transitions/StatusTransitions.js?build=20260816-legacy-recovery";
import { addSpyGapPendingTarget, addTrackingTarget, markCategoryUsed, removeSpyGapPendingTarget, setCoordinationTriggered, setGambleTriggered, setGuardianAidUsed, setLastEmberResolutionId, setMomentum, setRejuvenationTriggerCount, setSpyGapTriggered, setTrackingTurnNumber } from "../../domain/state/transitions/RuleUsageTransitions.js?build=20260816-legacy-recovery";
import { getAllInAssaultBonus } from "../../domain/rules/status/StatusRules.js?build=20260816-legacy-recovery";
import { createDiscardChoiceRequest } from "../choice/DiscardChoiceRequest.js?build=20260816-legacy-recovery";
import { canRevealSpyGap, canTriggerCoordination, canTriggerEmber, canTriggerGamble, canTriggerGuardianAid, canTriggerMomentumCategory, canTriggerRejuvenation, canTriggerSpyGapAfterDamage, canTriggerSpyGapOnRescue, canTriggerTrackingTarget, isHuntMarkExpiredForOwner, shouldAddAllInDamage, shouldAddMomentumDamage, shouldAdvanceTrackingClock, shouldCleanupExpiredHuntMarks, shouldConsumeAllIn, shouldConsumeMomentum, shouldIgnoreEmberDuplicate, shouldQueueSpyGapOnDying, shouldRemoveSpyGapPendingOnDead, shouldResetMomentumAtTurnEnd, shouldResetRejuvenationAtTurnStart } from "../../domain/rules/skill/PassiveSkillRules.js?build=20260816-legacy-recovery";

const REQUIRED_DEPENDENCIES = [
  "onEvent", "getState", "isSessionValid", "presentation", "random", "responseSystem",
  "discardCardFromHand", "drawCards", "gainEnergy", "preparePrivateHandPeekIntent",
  "resolvePrivateHandPeekIntent", "rememberPrivateCard", "choiceCoordinator",
  "choiceContexts", "createId"
];

/*
功能
创建被动技能 trigger registry。

调用方
Game temporary composition root。

输入
显式注入的 legacy event/session/choice/presentation collaborators。

输出
冻结 { registerForPlayers, hasSkill }。

读取状态
无。

写入状态
经 listener 与 transitions。

调用函数
PASSIVE_SKILLS。

边界与不变量
每名角色每个技能只注册一次；具体 predicate 由 PASSIVE_SKILLS 拥有。
*/
export function createPassiveSkillTriggerRegistry(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`PassiveSkillTriggerRegistry 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

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
    runtime.onEvent("cardUsed", `${owner.id}:momentum:category`, (event) => {
      if (!canTriggerMomentumCategory(owner, event)) return;
      if (canTriggerMomentumCategory(owner, event)) {
        markCategoryUsed(runtime.getState(), owner, event.card.category);
        const previousMomentum = owner.turnFlags.momentum;
        setMomentum(runtime.getState(), owner, Math.min(RULESET_DEFINITION.momentumMaxStacks, previousMomentum + 1));
        if (owner.turnFlags.momentum > previousMomentum) {
          runtime.presentation.log(`${owner.name}触发「连势」，现有${owner.turnFlags.momentum}层「连势」。`);
        }
      }
    });
    runtime.onEvent("beforeDamage", `${owner.id}:momentum:damage`, (event) => {
      if (!shouldAddMomentumDamage(owner, event)) return;
      const bonus = owner.turnFlags.momentum;
      if (bonus > 0) {
        event.amount += bonus;
        event.metadata.consumeMomentum = true;
        event.metadata.momentumBonus = bonus;
      }
    });
    runtime.onEvent("afterDamage", `${owner.id}:momentum:consume`, (event) => {
      if (!shouldConsumeMomentum(owner, event)) return;
      if (shouldConsumeMomentum(owner, event)) {
        const consumed = event.metadata.momentumBonus;
        setMomentum(runtime.getState(), owner, 0);
        runtime.presentation.log(`${owner.name}消耗${consumed}层「连势」，本次「突袭」伤害+${consumed}。`, "important");
      }
    });
    runtime.onEvent("turnEnd", `${owner.id}:momentum:turnEnd`, () => {
      // 「回合结束后清空连势」指任意行动角色的全局回合结束，而非只清空刃行者自己的回合。
      // 回合外借势等路径产生的 momentum 必须在当前全局回合 turnEnd 立即归零。
      setMomentum(runtime.getState(), owner, 0);
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
  setGuardianAidUsed、runtime.discardCardFromHand。

  边界与不变量
  响应与弃牌顺序不变。
  */
  guardianAid(game, owner) {
    runtime.onEvent("beforeDamage", `${owner.id}:guardianAid`, async (event) => {
      const gameId = runtime.getState().gameId;
      if (!canTriggerGuardianAid(owner, event)) return;
      const response = await runtime.responseSystem.requestSkillResponse(owner, "guardianAid", "护援", event);
      if (!runtime.isSessionValid(gameId) || response.status !== "used" || !owner.alive || !owner.hand.length) return;
      const discardRequestId = runtime.createId("guardian-aid-discard");
      const discardRequest = createDiscardChoiceRequest({
        requestId: discardRequestId,
        actorId: owner.id,
        gameId,
        stateVersion: runtime.getState().stateVersion,
        handCardIds: owner.hand.map((card) => card.id),
        requiredCount: 1,
        label: "护援：选择弃置1张手牌",
        handLimit: Math.max(0, owner.hp)
      });
      runtime.choiceContexts.set(discardRequestId, { player: owner, count: 1, prompt: "护援：选择弃置1张手牌" });
      let discardDecision;
      try {
        discardDecision = await runtime.choiceCoordinator.request(discardRequest);
      } finally {
        runtime.choiceContexts.delete(discardRequestId);
      }
      if (!runtime.isSessionValid(gameId)) return;
      const discard = (discardDecision.selectedIds ?? [])
        .map((cardId) => owner.hand.find((card) => card.id === cardId))
        .find(Boolean) ?? null;
      if (!discard) return;
      const moved = await runtime.discardCardFromHand(owner, discard, "护援", { logReason:"「护援」" });
      if (!runtime.isSessionValid(gameId) || !moved) return;
      setGuardianAidUsed(runtime.getState(), owner, true);
      event.amount = Math.max(0, event.amount - 1);
      runtime.presentation.log(`${owner.name}发动「护援」，令${event.target.name}受到的伤害减少1点。`, "important");
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
  setRejuvenationTriggerCount、runtime.drawCards。

  边界与不变量
  重置与触发顺序不变。
  */
  rejuvenation(game, owner) {
    runtime.onEvent("turnStart", `${owner.id}:rejuvenation:reset`, () => {
      if (!shouldResetRejuvenationAtTurnStart()) return;
      setRejuvenationTriggerCount(runtime.getState(), owner, 0);
    });
    runtime.onEvent("afterHeal", `${owner.id}:rejuvenation`, async (event) => {
      if (!canTriggerRejuvenation(owner, event)) return;
      setRejuvenationTriggerCount(runtime.getState(), owner, (owner.turnFlags.rejuvenationTriggerCount ?? 0) + 1);
      const gameId = runtime.getState().gameId;
      const drawn = await runtime.drawCards(owner, 1, "回春", { silent:true });
      if (!runtime.isSessionValid(gameId)) return;
      runtime.presentation.log(`${owner.name}触发「回春」，${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`, "heal");
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
    setSpyGapTriggered、runtime.preparePrivateHandPeekIntent。

    边界与不变量
    只查看合法数量且不公开牌面。
    */
    async function revealGap(target) {
      const gameId = runtime.getState().gameId;
      if (!canRevealSpyGap(owner, target)) return;
      setSpyGapTriggered(runtime.getState(), owner, true);
      const intent = await runtime.preparePrivateHandPeekIntent(owner, target, 2, `窥隙：选择查看${target.name}至多2张手牌`);
      if (!runtime.isSessionValid(gameId)) return;
      const seen = runtime.resolvePrivateHandPeekIntent(owner, intent);
      if (!seen.length) return;
      for (const card of seen) runtime.rememberPrivateCard(owner, target, card);
      if (owner.controllerType === "human") await runtime.presentation.showPrivateReveal({ title: `窥隙：${target.name}的手牌`, cardIds: seen.map((card) => card.id) });
      if (!runtime.isSessionValid(gameId)) return;
      runtime.presentation.log(`${owner.name}触发「窥隙」，查看了${target.name}的${seen.length}张手牌。`);
    }

    runtime.onEvent("afterDamage", `${owner.id}:spyGap`, async (event) => {
      if (!canTriggerSpyGapAfterDamage(owner, event)) return;
      if (event.target.hp > 0) {
        await revealGap(event.target);
        return;
      }
      if (!shouldQueueSpyGapOnDying(owner, event)) return;
      if (!owner.turnFlags.spyGapPendingTargetIds) setSpyGapPendingTargetIds(runtime.getState(), owner, new Set());
      addSpyGapPendingTarget(runtime.getState(), owner, event.target.id);
    });

    runtime.onEvent("playerRescued", `${owner.id}:spyGap:rescue`, async (event) => {
      const pending = owner.turnFlags.spyGapPendingTargetIds;
      if (!canTriggerSpyGapOnRescue(owner, event)) return;
      pending.delete(event.target.id);
      await revealGap(event.target);
    });

    runtime.onEvent("playerDead", `${owner.id}:spyGap:dead`, (event) => {
      if (shouldRemoveSpyGapPendingOnDead(owner, event)) removeSpyGapPendingTarget(runtime.getState(), owner, event.target.id);
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
  setLastEmberResolutionId、runtime.gainEnergy。

  边界与不变量
  每次卡牌结算最多触发一次。
  */
  ember(game, owner) {
    runtime.onEvent("afterDamage", `${owner.id}:ember`, async (event) => {
      if (!canTriggerEmber(owner, event)) return;
      if (shouldIgnoreEmberDuplicate(owner, event)) return;
      setLastEmberResolutionId(runtime.getState(), owner, event.resolutionId);
      await runtime.gainEnergy(owner, 1, { skill: "ember", reason: "余烬" });
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
    runtime.onEvent("turnStart", `${owner.id}:tracking:clock`, (event) => {
      if (shouldAdvanceTrackingClock(owner, event)) setTrackingTurnNumber(runtime.getState(), owner, (owner.gameFlags.trackingTurnNumber ?? 0) + 1);
    });
    runtime.onEvent("targetSelected", `${owner.id}:tracking`, (event) => {
      const target = event.targets[0];
      if (!canTriggerTrackingTarget(owner, event)) return;
      addTrackingTarget(runtime.getState(), owner, target.id);
      const currentTrackingTurn = owner.gameFlags.trackingTurnNumber ?? 0;
      setStatus(runtime.getState(), target, "huntMark", { sourceId: owner.id, expireAtTurnEnd: currentTrackingTurn + 1 });
      runtime.presentation.log(`${owner.name}触发「追踪」，在${target.name}身上留下了「猎印」。`, "important");
    });
    runtime.onEvent("turnEnd", `${owner.id}:tracking:cleanup`, (event) => {
      if (!shouldCleanupExpiredHuntMarks(owner, event)) return;
      for (const player of runtime.getState().players) {
        const mark = player.statuses.huntMark;
        if (mark?.sourceId === owner.id && isHuntMarkExpiredForOwner(mark, owner)) {
          removeStatus(runtime.getState(), player, "huntMark");
        }
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
  setStatus、removeStatus、runtime.drawCards。

  边界与不变量
  随机判定与日志顺序不变。
  */
  gamble(game, owner) {
    runtime.onEvent("cardUsed", `${owner.id}:gamble`, async (event) => {
      if (!canTriggerGamble(owner, event)) return;
      setGambleTriggered(runtime.getState(), owner, true);
      if (runtime.random() < RULESET_DEFINITION.gamblerDrawChance) {
        const gameId = runtime.getState().gameId;
        const drawn = await runtime.drawCards(owner, 1, "冒险", { silent:true });
        if (!runtime.isSessionValid(gameId)) return;
        runtime.presentation.log(`${owner.name}触发「冒险」，${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`);
      } else runtime.presentation.log(`${owner.name}触发「冒险」，但未获得额外收益。`);
    });
    runtime.onEvent("beforeDamage", `${owner.id}:allIn:damage`, (event) => {
      const allIn = owner.statuses.allIn;
      if (!shouldAddAllInDamage(owner, event)) return;
      event.amount += getAllInAssaultBonus(allIn);
      event.metadata.consumeAssaultBonus = true;
      runtime.presentation.log(`${owner.name}的「孤注」状态令此次「突袭」伤害+1。`, "important");
    });
    runtime.onEvent("afterDamage", `${owner.id}:allIn:consume`, (event) => {
      if (!shouldConsumeAllIn(owner, event)) return;
      {
        removeStatus(runtime.getState(), owner, "allIn");
        runtime.presentation.log(`${owner.name}退出「孤注」状态。`);
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
  setCoordinationTriggered、runtime.drawCards。

  边界与不变量
  每回合只触发一次。
  */
  coordination(game, owner) {
    runtime.onEvent("cardUsed", `${owner.id}:coordination`, async (event) => {
      if (!canTriggerCoordination(owner, event)) return;
      setCoordinationTriggered(runtime.getState(), owner, true);
      const gameId = runtime.getState().gameId;
      const drawn = await runtime.drawCards(owner, 1, "协调", { silent:true });
      if (!runtime.isSessionValid(gameId)) return;
      runtime.presentation.log(`${owner.name}触发「协调」，${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`);
    });
  }
};
  /*
  功能
  为 players 上每个 passiveSkillId 注册 trigger。

  调用方
  skillRegistry legacy façade。

  输入
  players 数组。

  输出
  无。

  读取状态
  owner.general.passiveSkillIds。

  写入状态
  listener registrations。

  调用函数
  PASSIVE_SKILLS。

  边界与不变量
  key=playerId:skillId 防重复注册。
  */
  function registerForPlayers(players) {
    for (const owner of players) {
      for (const skillId of owner.general.passiveSkillIds) {
        const register = PASSIVE_SKILLS[skillId];
        if (!register) throw new Error(`未注册被动技能：${skillId}`);
        register(runtime, owner);
      }
    }
  }

  /*
  功能
  查询被动 trigger 是否存在。

  调用方
  skillRegistry legacy façade。

  输入
  skillId。

  输出
  布尔值。

  读取状态
  PASSIVE_SKILLS。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不执行 effect。
  */
  function hasSkill(skillId) {
    return typeof PASSIVE_SKILLS[skillId] === "function";
  }

  return Object.freeze({ registerForPlayers, hasSkill });
}
