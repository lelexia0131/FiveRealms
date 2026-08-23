/*
模块职责
镜像 SearchState 中的格挡、反制、护援与响应资源容量，不拥有响应策略。

上游
Simulator 正式模拟门面与 Combat/Card/Status 模拟组件。

下游
state/Probability、正式 ResponsePolicy、GlobalBenefit assessment 与共享 simulation runtime。

状态边界
只修改 Simulator 门面提供的独立 SearchState 副本及其概率分支。

信息边界
未知手牌只按合法 knownCards、handCount 与 remaining counts 建模。

架构约束
不得读取 Game/UI/Controller/Planner，不得复制 Policy、Value 或真实规则实现。
*/
import { PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getCounterResponderOrder, isCounterEligible } from "../../domain/rules/response/ResponseRules.js";
import { hasPassiveSkill, projectCanonicalSeatRoster } from "../state/RuleProjection.js";
import { assessGlobalBenefit } from "../value/GlobalBenefitValue.js";
import { planningCounterDecision, planningDynamicCounterGain } from "../policy/ResponsePolicy.js";
import { PROBABILITY_EPSILON, availableBranchesFromState, expectedBranchValue, getAvailabilityBranches, joinProbabilityStateBranches, probabilityEventPartition, totalBranchProbability } from "../state/Probability.js";
import { mutateHiddenPool, projectHiddenSummaries } from "../state/HiddenPool.js";
import { clampProbability, remainingCardDensity, unionProbability } from "./SimulationSupport.js";

/*
功能
把 Base class 与 ResponseSimulation 的无状态方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把响应资源方法加入正式模拟门面。

输入
已经包含共享概率运行时的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增格挡、反制与护援方法的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withResponseSimulation = (Base) => class ResponseSimulation extends Base {


















  /*
  功能
  逐张推进未知摸牌、剩余密度和反制容量，使无放回抽取保持一致。

  调用方
  摸牌、奖励与技能效果入口：逐张推进无放回未知牌及响应容量。

  输入
  SearchState、玩家、非负期望张数、可选条件世界与事件标签。

  输出
  实际获得的期望手牌数量。

  读取状态
  handCount、remainingCardCounts、block/counter 分布和调用方事件世界。

  写入状态
  handCount、remainingCardCounts、block/counter/card estimates。

  调用函数
  addOneUnknownCardToBlockDistribution、addOneUnknownCardToCounterDistribution、Probability 事件 辅助函数。

  边界与不变量
  每张未知牌按更新后的剩余池密度推进；block 与 counter 必须共享同一抽牌身份世界。
  */
  gainUnknownCardsWithCounterState(state, player, amount, eventWorlds = null, label = "unknown-draw") {
    if (!player) return 0;
    if (typeof amount !== "function" && amount <= PROBABILITY_EPSILON) return 0;
    const worlds = Array.isArray(eventWorlds) && eventWorlds.length
      ? eventWorlds
      : this.getEventWorlds(state, 1, null, label);
    const eventMass = this.eventProbability(worlds);
    if (eventMass <= PROBABILITY_EPSILON) return 0;
    if (typeof amount === "function") {
      const remainingByBranch = worlds.map((branch) => (
        branch.occurs ? Math.max(0, Number(amount(branch)) || 0) : 0
      ));
      let gained = 0;
      while (remainingByBranch.some((remaining) => remaining > PROBABILITY_EPSILON)) {
        this.checkpointSearchWork();
        const cardWorlds = [];
        for (let index = 0; index < worlds.length; index += 1) {
          if (index % 32 === 0) this.checkpointSearchWork();
          const branch = worlds[index];
          const remaining = remainingByBranch[index];
          if (remaining <= PROBABILITY_EPSILON) {
            cardWorlds.push({ ...branch, occurs:false });
            continue;
          }
          const cardProbability = Math.min(1, remaining);
          if (cardProbability >= 1 - PROBABILITY_EPSILON) {
            cardWorlds.push({ ...branch, occurs:true });
          } else {
            const gate = probabilityEventPartition(
              this.nextProbabilityEventKey(state, `${label}:branch-card`),
              cardProbability,
              "gateOccurs"
            );
            const gatedWorlds = this.rawProbabilityWork(
              "ResponseSimulation.gainUnknownCardsWithCounterState:single-branch-gate",
              3,
              () => joinProbabilityStateBranches([branch], gate)
            );
            for (const gated of gatedWorlds) {
              cardWorlds.push({ ...gated, occurs:Boolean(gated.gateOccurs) });
            }
          }
        }
        const cardGain = this.eventProbability(cardWorlds);
        if (cardGain <= PROBABILITY_EPSILON) break;
        player.handCount = (player.handCount ?? 0) + cardGain;
        mutateHiddenPool(state.hiddenPoolState, {
          type:"ADD",
          targetBucketId:player.id,
          probability:cardGain
        });
        projectHiddenSummaries(state);
        gained += cardGain;
        for (let index = 0; index < remainingByBranch.length; index += 1) {
          remainingByBranch[index] -= Math.min(1, remainingByBranch[index]);
        }
      }
      return gained;
    }
    let remaining = Math.max(0, Number(amount) || 0);
    let gained = 0;
    while (remaining > PROBABILITY_EPSILON) {
      this.checkpointSearchWork();
      const cardProbability = Math.min(1, remaining);
      const gateChance = Math.min(1, cardProbability / eventMass);
      const cardWorlds = gateChance >= 1 - PROBABILITY_EPSILON
        ? worlds
        : this.gateEventWorlds(state, worlds, gateChance, `${label}:card`);
      const cardGain = this.eventProbability(cardWorlds);
      if (cardGain <= PROBABILITY_EPSILON) break;
      player.handCount = (player.handCount ?? 0) + cardGain;
      mutateHiddenPool(state.hiddenPoolState, {
        type:"ADD",
        targetBucketId:player.id,
        probability:cardGain
      });
      projectHiddenSummaries(state);
      gained += cardGain;
      remaining -= cardProbability;
    }
    return gained;
  }







  /*
  功能
  将实际格挡世界映射到可用已知身份并消费每张卡至多一次。

  调用方
  CombatSimulation 与 consumeBlockResponseWorlds：把已决定的格挡消费映射到具体合法身份。

  输入
  SearchState、玩家、含 requiredCount/blockUsed 的格挡世界与可选排除 ID。

  输出
  无返回值；相交世界中的已知格挡身份已消费。

  读取状态
  hand/knownCards availability 与 blockWorlds。

  写入状态
  卡牌 availability，并在质量归零时移出身份数组。

  调用函数
  getAvailabilityStateBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  每个世界按稳定身份顺序消费所需张数；排除的雷达判定牌由调用方单独处理。
  */
  consumeBlockIdentities(state, player, blockWorlds, excludedCardIds = null) {
    if (!player || !Array.isArray(blockWorlds) || !blockWorlds.length) return;
    const candidates = [
      ...(Array.isArray(player.hand) ? player.hand.filter((card) => card.definitionId === "block") : []),
      ...(Array.isArray(player.knownCards) ? player.knownCards.filter((entry) => entry.definitionId === "block") : [])
    ].filter((card) => !excludedCardIds?.has(card.id ?? card.cardId));
    if (!candidates.length) return;
    let remainingWorlds = this.projectProbabilityWork(
      blockWorlds,
      (branch) => ({
        remaining:branch.blockUsed
          ? Math.max(0, Number(branch.requiredCount) || 1)
          : 0
      }),
      "ResponseSimulation.consumeBlockIdentities:remaining"
    );
    for (const card of candidates) {
      this.checkpointSearchWork();
      const availabilityState = this.getAvailabilityStateWork(
        card,
        "availabilityStateBranches",
        1,
        "ResponseSimulation.consumeBlockIdentities:availability"
      ).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joined = this.joinProbabilityWork(
        [remainingWorlds, availabilityState],
        "ResponseSimulation.consumeBlockIdentities:join"
      );
      if (!joined.length) break;
      const usedWorlds = this.projectProbabilityWork(
        joined,
        (branch) => ({
          used:Boolean(branch.available && branch.remaining > 0),
          remaining:Math.max(0, Number(branch.remaining)
            - (branch.available && branch.remaining > 0 ? 1 : 0))
        }),
        "ResponseSimulation.consumeBlockIdentities:used"
      );
      card.availabilityStateBranches = this.projectProbabilityWork(
        joined,
        (branch) => ({
          available:Boolean(branch.available && !(branch.available && branch.remaining > 0))
        }),
        "ResponseSimulation.consumeBlockIdentities:card-remaining"
      );
      card.availabilityBranches = availableBranchesFromState(card.availabilityStateBranches);
      if (totalBranchProbability(card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(player.hand)) player.hand = player.hand.filter((entry) => entry !== card);
        if (Array.isArray(player.knownCards)) player.knownCards = player.knownCards.filter((entry) => entry !== card);
      }
      remainingWorlds = usedWorlds.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        remaining:branch.remaining
      }));
      if (!remainingWorlds.some((branch) => branch.remaining > 0 && branch.probability > PROBABILITY_EPSILON)) break;
    }
  }

  /*
  功能
  按守护者意愿、可用格挡与目标伤害世界结算护援及其资源消耗。

  调用方
  CombatSimulation.applyDamage：在伤害穿过响应后结算守护援助。

  输入
  SearchState、受保护目标、入射期望伤害、事件概率、排除守护者与伤害选项。

  输出
  护援后剩余的期望伤害量。

  读取状态
  存活盟友、守护技能可用性、格挡/手牌资源与正式 Policy 意愿。

  写入状态
  守护者格挡/手牌/响应分布及可选伤害 outcome。

  调用函数
  seatOrderFrom、ResponsePolicy query、consumeChosenHandCard/consumeRandomHandCards。

  边界与不变量
  护援按座次和可用资源依次结算；每名守护者每个伤害世界最多响应一次。
  */
  simulateGuardianAid(state, target, incomingDamage, eventProbability, excludedGuardianIds = null, options = {}) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) return Math.max(0, incomingDamage);
    const conditionalReduction = Math.min(
      PASSIVE_SKILL_DEFINITIONS.guardianAid.damageReduction,
      incomingDamage / probability
    );
    let remainingTriggerProbability = probability;
    let expectedReduction = 0;
    for (const guardian of state.players) {
      if (remainingTriggerProbability <= PROBABILITY_EPSILON) break;
      if (excludedGuardianIds?.has(guardian.id)) continue;
      if (!guardian.alive || !hasPassiveSkill(guardian, "guardianAid") || guardian.id === target.id
        || guardian.battleTeam !== target.battleTeam) continue;
      const oldUsedProbability = clampProbability(guardian.guardianAidUsedProbability
        ?? (guardian.guardianAidUsed ? 1 : 0));
      const handAvailability = Math.min(1, Math.max(0, Number(guardian.handCount) || 0));
      const triggerProbability = remainingTriggerProbability * (1 - oldUsedProbability) * handAvailability;
      if (triggerProbability <= 0) continue;
      if (this.hasCompleteCertainHand(guardian)) {
        this.consumeChosenHandCard(state, guardian, triggerProbability, options);
      } else {
        this.consumeRandomHandCards(state, guardian, triggerProbability);
      }
      guardian.guardianAidUsedProbability = clampProbability(oldUsedProbability + triggerProbability);
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - Number.EPSILON;
      expectedReduction += triggerProbability * conditionalReduction;
      remainingTriggerProbability = Math.max(0, remainingTriggerProbability - triggerProbability);
    }
    return Math.max(0, incomingDamage - expectedReduction);
  }






  /*
  功能
  汇总整张锦囊经过各反制响应后的最终生效概率。

  调用方
  TacticResolutionQuery 与 Simulator.apply：取得整张 card-scope 战术的最终生效概率。

  输入
  SearchState、行动者、卡牌、目标列表与可选 selection。

  输出
  所有卡牌级反制链结算后的零到一生效概率。

  读取状态
  响应者 counter 分布、座次、阵营与正式反制决策查询。

  写入状态
  无。

  调用函数
  evaluateCardScopeCounterResponses。

  边界与不变量
  本函数只查询，不消费反制；实际消费必须使用同一次 responseEvaluation。
  */
  tacticResolutionChance(state, actor, card, targets = [], selection = null) {
    if (!isCounterEligible(card.category, card.counterable)) return 1;
    return this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection).resolutionChance;
  }

  /*
  功能
  按座次评估卡牌级反制链，在共享隐藏牌世界中选择首名确定响应者。

  调用方
  tacticResolutionChance、consumeCountersForCardScope 与 Simulator.apply：冻结一次卡牌级反制链。

  输入
  SearchState、行动者、战术牌、目标列表、可选 selection 与动态条件创建选项。

  输出
  包含 resolutionChance、联合响应世界和每名响应者边际消费质量的独立对象。

  读取状态
  存活座次、Counter finite-pool factor、确定身份与正式 counter decision。

  写入状态
  无。

  调用函数
  queryCounterCountBranches、counterDecision、
  Probability 联合/投影辅助函数。

  边界与不变量
  链顺序和奇偶翻转只计算一次；正式 factor 路径只在调用方要求时创建动态条件；
  返回结果不得修改任何响应容量；
  join/project 中断时整个未完成响应 preparation 作废。
  */
  evaluateCardScopeCounterResponses(
    state,
    actor,
    card,
    targets = [],
    selection = null,
    options = {}
  ) {
    this.checkpointSearchWork();
    const roster = projectCanonicalSeatRoster(state.players);
    const responderOrder = getCounterResponderOrder(roster, actor.id);
    const contenders = [];
    for (let index = 0; index < responderOrder.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const responderId = responderOrder[index];
      const player = state.players.find((entry) => entry.id === responderId);
      if (!player?.alive || player.id === actor.id) continue;
      const counterProbability = clampProbability(player.counterProbability ?? 0);
      const decision = this.counterDecision(state, player, actor, card, targets, selection) === true;
      contenders.push({ player, counterProbability, decision, effectiveProbability:0 });
    }
    void options;
    const active = contenders.filter((contender) => contender.decision);
    const partitions = active.map(({ player }) => {
      const field = `counterCount:${player.id}`;
      return (player.counterCountDistribution ?? [])
        .map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          [field]:branch.counterCount
        }));
    });
    const jointWorlds = partitions.length
      ? this.joinProbabilityWork(partitions)
      : [{ probability:1, conditions:{} }];
    const responseWorlds = this.projectProbabilityWork(jointWorlds, (world) => {
      const responder = active.find(({ player }) => (
        (world[`counterCount:${player.id}`] ?? 0) >= 1
      ));
      return { responderId:responder?.player.id ?? null };
    });
    const resolutionChance = totalBranchProbability(
      responseWorlds.filter((world) => world.responderId === null)
    );
    for (let index = 0; index < contenders.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const contender = contenders[index];
      contender.effectiveProbability = totalBranchProbability(
        responseWorlds.filter((world) => world.responderId === contender.player.id)
      );
    }
    this.searchBudget?.observeResponseBranches?.(responseWorlds.length);
    return { resolutionChance, contenders, responseWorlds };
  }

  /*
  功能
  依据已评估的卡牌级反制链消费对应玩家的反制容量与身份。

  调用方
  Simulator.apply：在卡牌级反制生效概率确定后兑现同一链的资源消耗。

  输入
  SearchState、行动者、战术牌、目标/selection 与可选已冻结 responseEvaluation。

  输出
  实际消费的期望反制总量。

  读取状态
  响应链的 per-player 消费世界与各玩家反制分布。

  写入状态
  响应者 counterCountDistribution、counterProbability、handCount 与确定反制身份。

  调用函数
  evaluateCardScopeCounterResponses、consumeCounterResponseWorlds。

  边界与不变量
  必须消费用于 resolutionChance 的同一链；不得再次调用决策查询造成重复计算或双计。
  */
  consumeCountersForCardScope(state, actor, card, targets, selection = null, responseEvaluation = null) {
    const evaluation = responseEvaluation
      ?? this.evaluateCardScopeCounterResponses(state, actor, card, targets, selection);
    for (const { player, effectiveProbability } of evaluation.contenders) {
      if (effectiveProbability <= PROBABILITY_EPSILON) continue;
      this.consumeCounterResponseWorlds(state, player, evaluation.responseWorlds);
    }
  }

  /*
  功能
  在已冻结的共享响应世界中扣除一名玩家实际打出的反制并同步摘要。

  调用方
  consumeCountersForCardScope：按同一次 card-scope 响应评估兑现资源。

  输入
  SearchState、响应者与包含 responderId 的共享响应世界。

  输出
  实际消费的反制概率质量。

  读取状态
  counterCountDistribution、共享 condition keys 与响应世界。

  写入状态
  counterCountDistribution、counterProbability、handCount 与确定身份 availability。

  调用函数
  consumeTargetCounterResponseWorlds、Probability 投影/汇总辅助函数。

  边界与不变量
  只在同一条件世界中该玩家确为首名响应者且存在反制时扣一张，不重新抽取独立事件；
  projection 中断时由上层丢弃当前 partial candidate。
  */
  consumeCounterResponseWorlds(state, player, responseWorlds) {
    if (!player || !Array.isArray(responseWorlds) || !responseWorlds.length) return 0;
    const attemptWorlds = this.projectProbabilityWork(responseWorlds, (world) => ({
      occurs:world.responderId === player.id
    }));
    const response = this.consumeTargetCounterResponseWorlds(
      state,
      player,
      attemptWorlds,
      true
    );
    return totalBranchProbability(
      response.outcomeWorlds.filter((world) => world.counterConsumed)
    );
  }

  /*
  功能
  计算单个目标经过目标级反制后的最终生效概率。

  调用方
  TacticResolutionQuery 与目标级卡牌效果：估算单个目标是否通过反制。

  输入
  SearchState、行动者、卡牌与目标。

  输出
  目标效果最终生效概率；非目标级可反制战术返回一。

  读取状态
  目标 counter 分布与正式 counter decision。

  写入状态
  无。

  调用函数
  counterDecision、queryCounterCountBranches。

  边界与不变量
  只做概率查询，不消费反制；实际目标响应由 consumeTargetCounterResponseWorlds 结算。
  */
  targetResolutionChance(state, actor, card, target) {
    if (!isCounterEligible(card.category, card.counterable) || card.counterScope !== "target") return 1;
    if (this.counterDecision(state, target, actor, card, [target]) !== true) return 1;
    return (target.counterCountDistribution ?? []).reduce(
      (sum, branch) => sum + (branch.counterCount < 1 ? branch.probability : 0),
      0
    );
  }

  /*
  功能
  根据阵营关系、效果价值与当前状态作出确定的规划反制决策。

  调用方
  card-scope 与 target-scope 响应查询：请求正式 ResponsePolicy 的规划反制决策。

  输入
  SearchState、响应者、行动者、卡牌、目标列表与可选 selection。

  输出
  确定的 respond / do not respond 布尔值。

  读取状态
  公开/过滤状态、全体受益 assessment 与 root 递归守卫。

  写入状态
  无。

  调用函数
  planningCounterDecision、dynamicCounterGain。

  边界与不变量
  Simulation 不复制策略公式；root 递归守卫只阻止重复反事实，不改变普通响应。
  */
  counterDecision(state, responder, actor, card, targets, selection = null) {
    return planningCounterDecision(state, responder, actor, card, targets, selection, {
      assessGlobalBenefit,
      simulatingRootResolution:this._simulatingRootResolution,
      dynamicCounterGain:(...args) => this.dynamicCounterGain(...args)
    });
  }

  /*
  功能
  比较反制前后状态价值，计算当前响应在此世界中的动态收益。

  调用方
  planningCounterDecision：需要比较反制前后 root 结局时请求有界价值增量。

  输入
  SearchState、响应者、行动者、卡牌、目标列表与可选 selection。

  输出
  反制翻转相对不反制的纯价值差。

  读取状态
  只读传入过滤状态和公开 root context。

  写入状态
  无。

  调用函数
  planningDynamicCounterGain。

  边界与不变量
  本入口不修改当前 SearchState；具体配对模拟由正式查询 owner 隔离。
  */
  dynamicCounterGain(state, responder, actor, card, targets, selection = null) {
    return planningDynamicCounterGain(state, responder, actor, card, targets, selection);
  }

  /*
  功能
  将攻击世界与格挡容量和身份相交，返回命中与格挡后的互斥世界。

  调用方
  CombatSimulation.applyDamage：把已确定攻击世界与格挡容量和雷达结果联合。

  输入
  SearchState、目标、攻击世界及可选判定前格挡/多个判定牌身份。

  输出
  outcomeWorlds、blockedProbability 与 expectedBlockSpend。

  读取状态
  block 分布、已知身份、requiredCount、雷达免疫与 responseAllowed 条件。

  写入状态
  blockCountDistribution/摘要、格挡身份 availability 与 handCount。

  调用函数
  getBlockCountBranches、consumeBlockIdentities、Probability 连接/投影 辅助函数。

  边界与不变量
  格挡选择、容量扣减和身份消费共享同一世界；雷达判定格挡按判定顺序只补足原格挡容量缺口。
  */
  consumeBlockResponseWorlds(state, target, attackWorlds, options = {}) {
    const blockState = target.blockCountDistribution ?? [];
    const preJudgmentPartition = Array.isArray(options.preJudgmentBlockState)
      && options.preJudgmentBlockState.length
      ? options.preJudgmentBlockState.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          preBlockCount:branch.blockCount
        }))
      : null;
    const joined = this.joinProbabilityWork(
      preJudgmentPartition
        ? [attackWorlds, blockState, preJudgmentPartition]
        : [attackWorlds, blockState]
    );
    /*
    功能
    判断一条响应资源分支与攻击世界条件是否兼容，避免跨世界重复消费。

    调用方
    consumeBlockResponseWorlds：在同一条件世界判断是否真正打出格挡。

    输入
    含攻击发生、响应允许、雷达免疫、blockCount 与 requiredCount 的联合分支。

    输出
    该分支是否消费格挡并阻止伤害。

    读取状态
    仅闭包当前联合分支。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    必须同时发生、允许响应、未被雷达免疫且容量足够；不能跨条件世界借用格挡。
    */
    const responseMatches = (branch) => Boolean(
      branch.occurs
      && branch.responseAllowed !== false
      && branch.requiredCount > 0
      && branch.blockCount >= branch.requiredCount
    );
    const consumedBranches = [];
    let blockedProbability = 0;
    let expectedBlockSpend = 0;
    for (let index = 0; index < joined.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = joined[index];
      if (!responseMatches(branch)) continue;
      consumedBranches.push(branch);
      blockedProbability += Math.max(0, Number(branch.probability) || 0);
      expectedBlockSpend += branch.probability * branch.requiredCount;
    }
    const identityWorlds = joined.map((branch, index) => {
      if (index % 32 === 0) this.checkpointSearchWork();
      return {
        probability:branch.probability,
        conditions:branch.conditions,
        requiredCount:branch.requiredCount,
        blockUsed:responseMatches(branch)
      };
    });
    const judgmentBlockCards = Array.isArray(options.judgmentBlockCards)
      ? options.judgmentBlockCards.filter(Boolean)
      : options.judgmentBlockCard
        ? [options.judgmentBlockCard]
        : [];
    const excludedCardIds = judgmentBlockCards.length
      ? new Set(judgmentBlockCards.map((card) => card.id ?? card.cardId))
      : null;
    const knownBlockCards = [
      ...(Array.isArray(target.hand) ? target.hand : []),
      ...(Array.isArray(target.knownCards) ? target.knownCards : [])
    ].filter((card) => card?.definitionId === "block" && !excludedCardIds?.has(card.id ?? card.cardId));
    const knownBefore = knownBlockCards.reduce((sum, card) => sum + this.cardAvailability(card), 0);
    this.consumeBlockIdentities(state, target, identityWorlds, excludedCardIds);
    const knownAfter = knownBlockCards.reduce((sum, card) => sum + this.cardAvailability(card), 0);
    this.checkpointSearchWork();
    if (judgmentBlockCards.length && preJudgmentPartition) {
      let joinedJudgments = joined;
      for (let index = 0; index < judgmentBlockCards.length; index += 1) {
        this.checkpointSearchWork();
        const availabilityField = `judgmentBlockAvailable${index}`;
        const availability = this.getAvailabilityStateWork(
          judgmentBlockCards[index],
          "availabilityStateBranches",
          1,
          "ResponseSimulation.consumeBlockResponseWorlds:judgment-availability"
        ).map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          [availabilityField]:Boolean(branch.available)
        }));
        joinedJudgments = this.joinProbabilityWork([joinedJudgments, availability]);
      }
      for (let index = 0; index < judgmentBlockCards.length; index += 1) {
        this.checkpointSearchWork();
        const judgmentBlockCard = judgmentBlockCards[index];
        const availabilityField = `judgmentBlockAvailable${index}`;
        const judgmentConsumedWorlds = this.projectProbabilityWork(
          joinedJudgments,
          (branch) => {
            let earlierAvailable = 0;
            for (let prior = 0; prior < index; prior += 1) {
              if (branch[`judgmentBlockAvailable${prior}`]) earlierAvailable += 1;
            }
            const neededFromJudgments = Math.max(0, branch.requiredCount - branch.preBlockCount);
            return {
              available:Boolean(branch[availabilityField]
                && !(responseMatches(branch) && earlierAvailable < neededFromJudgments))
            };
          }
        );
        judgmentBlockCard.availabilityStateBranches = judgmentConsumedWorlds;
        judgmentBlockCard.availabilityBranches = availableBranchesFromState(judgmentConsumedWorlds);
        if (totalBranchProbability(judgmentBlockCard.availabilityBranches) <= PROBABILITY_EPSILON) {
          if (Array.isArray(target.hand)) target.hand = target.hand.filter((card) => card !== judgmentBlockCard);
          if (Array.isArray(target.knownCards)) target.knownCards = target.knownCards.filter((entry) => entry !== judgmentBlockCard);
        }
      }
    }
    target.handCount = Math.max(0, (target.handCount ?? 0) - expectedBlockSpend);
    const anonymousSpend = Math.max(0, expectedBlockSpend - (knownBefore - knownAfter));
    const wholeAnonymousSpend = Math.floor(anonymousSpend);
    if (wholeAnonymousSpend > 0) mutateHiddenPool(state.hiddenPoolState, {
      type:"REMOVE",
      sourceBucketId:target.id,
      definitionId:"block",
      count:wholeAnonymousSpend
    });
    if (anonymousSpend - wholeAnonymousSpend > PROBABILITY_EPSILON) {
      mutateHiddenPool(state.hiddenPoolState, {
        type:"REMOVE",
        sourceBucketId:target.id,
        definitionId:"block",
        probability:anonymousSpend - wholeAnonymousSpend
      });
    }
    projectHiddenSummaries(state);
    const outcomeWorlds = this.projectProbabilityWork(
      joined,
      (branch) => ({
        occurs:Boolean(branch.occurs),
        radarOutcome:branch.radarOutcomes?.[0] ?? null,
        radarOutcomes:branch.radarOutcomes ?? [],
        requiredCount:branch.requiredCount,
        immuneByRadar:Boolean(branch.occurs && branch.originalRequiredCount > 0 && branch.requiredCount <= 0),
        blockedByCard:responseMatches(branch),
        passes:Boolean(branch.occurs && branch.requiredCount > 0 && !responseMatches(branch))
      })
    );
    this.searchBudget?.observeResponseBranches?.(outcomeWorlds.length);
    return { outcomeWorlds, blockedProbability, expectedBlockSpend };
  }

  /*
  功能
  将目标效果世界与反制容量和确定决策相交，消费资源并返回最终生效世界。

  调用方
  CardEffectSimulation 的 target-scope 战术：兑现单目标反制尝试。

  输入
  SearchState、目标、效果世界、布尔反制决策与可选响应选项。

  输出
  完整 outcomeWorlds、最终 effectPassWorlds 与 counterAttemptedWorlds。

  读取状态
  目标 counter/knownCounter 分布、确定身份 availability 与效果条件。

  写入状态
  counterCountDistribution/摘要、反制身份 availability、hand/knownCards 与 handCount。

  调用函数
  getCounterCountBranches、getKnownCounterCountBranches、Probability 连接/投影 辅助函数。

  边界与不变量
  Policy heuristic 不得在这里转成随机事件；容量、具体身份选择和效果取消必须条件耦合；
  所有长 join/project/merge 在同一 SearchBudget 下 cooperative abort，partial outcome 不得返回。
  */
  consumeTargetCounterResponseWorlds(state, target, effectWorlds, counterDecision, options = {}) {
    this.checkpointSearchWork();
    if (!target) {
      const emptyOutcome = this.projectProbabilityWork(effectWorlds, (branch) => ({
        effectOccurs:Boolean(branch.occurs),
        counterWilling:false,
        counterAvailable:false,
        counterAttempted:false,
        counterConsumed:false,
        effectCancelled:false,
        effectPasses:Boolean(branch.occurs),
        responderId:null
      }));
      this.searchBudget?.observeResponseBranches?.(emptyOutcome.length);
      return {
        outcomeWorlds:emptyOutcome,
        effectPassWorlds:effectWorlds,
        counterAttemptedWorlds:this.projectProbabilityWork(
          effectWorlds,
          () => ({ occurs:false })
        )
      };
    }
    void options;
    const decisionPartition = [{
      probability:1,
      conditions:{},
      willing:counterDecision === true
    }];
    const counterState = target.counterCountDistribution ?? [];
    const candidates = [
      ...(Array.isArray(target.hand) ? target.hand
        .filter((card) => this.cardAvailability(card) > PROBABILITY_EPSILON && card.definitionId === "counter")
        .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:"counter" })) : []),
      ...(Array.isArray(target.knownCards) ? target.knownCards
        .filter((entry) => this.cardAvailability(entry) > PROBABILITY_EPSILON && entry.definitionId === "counter")
        .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:"counter" })) : [])
    ];
    const knownBefore = candidates.reduce(
      (sum, candidate) => sum + this.cardAvailability(candidate.card), 0
    );
    const candidatePartitions = candidates.map((candidate, index) => (
      this.getAvailabilityStateWork(
        candidate.card,
        "availabilityStateBranches",
        1,
        "ResponseSimulation.consumeTargetCounterResponseWorlds:candidate-availability"
      ).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        [`c${index}`]:Boolean(branch.available)
      }))
    ));
    const joined = this.joinProbabilityWork([
      effectWorlds,
      decisionPartition,
      counterState,
      ...candidatePartitions
    ], "ResponseSimulation.consumeTargetCounterResponseWorlds:candidate-worlds");
    const selectionKey = this.nextProbabilityEventKey(state, `counter-selection:${target.id ?? "unknown"}`);
    const outcomes = [];
    for (let branchIndex = 0; branchIndex < joined.length; branchIndex += 1) {
      if (branchIndex % 32 === 0) this.checkpointSearchWork();
      const branch = joined[branchIndex];
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const available = candidates.map((_, index) => Boolean(branch[`c${index}`]));
      const availableCount = available.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const anonymousCount = Math.max(0, counterCount - availableCount);
      const attempted = effectOccurs && willing && counterCount >= 1;
      if (!attempted) {
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:"none" },
          selectedIndex:-1,
          anonymousSelected:false
        });
        continue;
      }
      if (Array.isArray(target.hand)) {
        // 当前 AI 自己：按真实手牌顺序选择第一张可用反制，不随机选择。
        const firstIndex = available.indexOf(true);
        if (firstIndex < 0) {
          outcomes.push({
            probability:branch.probability,
            conditions:{ ...branch.conditions, [selectionKey]:"none" },
            selectedIndex:-1,
            anonymousSelected:false
          });
          continue;
        }
        outcomes.push({
          probability:branch.probability,
          conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[firstIndex].key}` },
          selectedIndex:firstIndex,
          anonymousSelected:false
        });
        continue;
      }
      // 其他玩家：已知反制身份与匿名反制桶交换对称互斥选择。
      const total = availableCount + anonymousCount;
      for (let index = 0; index < candidates.length; index += 1) {
        if (available[index]) {
          outcomes.push({
            probability:branch.probability / total,
            conditions:{ ...branch.conditions, [selectionKey]:`known:${candidates[index].key}` },
            selectedIndex:index,
            anonymousSelected:false
          });
        }
      }
      if (anonymousCount > 0) {
        outcomes.push({
          probability:branch.probability * (anonymousCount / total),
          conditions:{ ...branch.conditions, [selectionKey]:"anonymous" },
          selectedIndex:-1,
          anonymousSelected:true
        });
      }
    }

    const selectionPartition = this.mergeProbabilityWork(outcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      this.checkpointSearchWork();
      const candidate = candidates[index];
      const availabilityState = this.getAvailabilityStateWork(
        candidate.card,
        "availabilityStateBranches",
        1,
        "ResponseSimulation.consumeTargetCounterResponseWorlds:remaining-availability"
      ).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        available:Boolean(branch.available)
      }));
      const joinedAvailability = this.joinProbabilityWork([
        availabilityState,
        selectionPartition
      ]);
      candidate.card.availabilityStateBranches = this.projectProbabilityWork(
        joinedAvailability,
        (branch) => ({ available:Boolean(branch.available && !(branch.selectedIndex === index)) })
      );
      candidate.card.availabilityBranches = availableBranchesFromState(candidate.card.availabilityStateBranches);
      if (totalBranchProbability(candidate.card.availabilityBranches) <= PROBABILITY_EPSILON) {
        if (Array.isArray(target.hand)) target.hand = target.hand.filter((card) => card !== candidate.card);
        if (Array.isArray(target.knownCards)) target.knownCards = target.knownCards.filter((entry) => entry !== candidate.card);
      }
    }

    // 数量与 handCount 只在 counterAttempted 世界扣减；身份选择只决定具体删哪张。
    const attemptedPartition = this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(
        branch.occurs
        && branch.willing
        && Math.max(0, Math.floor(Number(branch.counterCount) || 0)) >= 1
      )
    }));
    const attemptedProbability = this.eventProbability(attemptedPartition);
    const knownAfter = candidates.reduce(
      (sum, candidate) => sum + this.cardAvailability(candidate.card), 0
    );
    const anonymousSpend = Math.max(0, attemptedProbability - (knownBefore - knownAfter));
    if (anonymousSpend > PROBABILITY_EPSILON) mutateHiddenPool(state.hiddenPoolState, {
      type:"REMOVE",
      sourceBucketId:target.id,
      definitionId:"counter",
      probability:anonymousSpend
    });
    target.handCount = Math.max(0, (target.handCount ?? 0) - attemptedProbability);
    projectHiddenSummaries(state);

    const outcomeWorlds = this.projectProbabilityWork(joined, (branch) => {
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const attempted = effectOccurs && willing && counterCount >= 1;
      return {
        effectOccurs,
        counterWilling:willing,
        counterAvailable:counterCount >= 1,
        counterAttempted:attempted,
        counterConsumed:attempted,
        effectCancelled:attempted,
        effectPasses:Boolean(effectOccurs && !attempted),
        responderId:target.id ?? null
      };
    });
    this.searchBudget?.observeResponseBranches?.(outcomeWorlds.length);
    return {
      outcomeWorlds,
      effectPassWorlds:this.projectProbabilityWork(outcomeWorlds, (branch) => ({
        occurs:branch.effectPasses
      })),
      counterAttemptedWorlds:this.projectProbabilityWork(outcomeWorlds, (branch) => ({
        occurs:branch.counterAttempted
      }))
    };
  }
};
