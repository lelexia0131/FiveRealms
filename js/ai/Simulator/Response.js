/*
模块职责
镜像 World 中的格挡、反制、护援与响应资源容量，不拥有响应策略。

上游
Simulator 正式模拟门面。

下游
Fact、canonical Probability facade、Domain response rules 与门面显式注入的 willingness/resource choice。

状态边界
只读取 Simulator 门面提供的独立 World，返回本次调用栈内的 resolved result/payment request。

信息边界
未知手牌只按合法 knownCards、handCount 与 remaining counts 建模。

架构约束
不得读取 Game/UI/Controller/Searcher/Evaluator，不得复制 willingness、Value 或真实规则实现。
*/
import { getCounterResponderOrder, isCounterEligible } from "../../domain/rules/response/ResponseRules.js";
import { projectCanonicalSeatRoster } from "../Event/Fact.js";
import {
  PROBABILITY_EPSILON,
  cardAvailability,
  queryOrderedFirstResponder,
  queryPlayerHandProbability,
  totalBranchProbability
} from "../Event/Probability/Probability.js";

/*
功能
把 Base class 与 Response 的无状态方法组合成单一 Simulator 类型。

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
export const withResponse = (Base) => class Response extends Base {
  /*
  功能
  解析单名 Guardian 的 willingness、已选身份请求与 mitigation 结果。

  调用方
  Simulator.simulateGuardianAid：按座次准备一名合法 Guardian 响应。

  输入
  World、Guardian、受保护目标及 Simulator 准备的触发/支付上下文。

  输出
  accepted、expectedReduction 与不含隐藏 definitionId 的 payment request。

  读取状态
  正式 Guardian willingness、已知手牌候选和 resolved discard capability。

  写入状态
  无。

  调用函数
  decideGuardianAid、selectGuardianAidDiscard。

  边界与不变量
  只描述响应与支付；不修改 Guardian hand、usage 或概率容量，匿名支付不得展开 identity。
  */
  resolveGuardianAidResponse(state, guardian, target, responseContext = {}) {
    const {
      incomingDamage = 0,
      eventProbability = 0,
      triggerProbability = 0,
      conditionalReduction = 0,
      paymentContext = null,
      options = {}
    } = responseContext;
    const willing = options.forcedGuardianId === guardian.id
      || this.decideGuardianAid(state, guardian, target, {
        incomingDamage,
        eventProbability,
        triggerProbability,
        conditionalReduction,
        options
      }) === true;
    if (!willing) return { accepted:false, expectedReduction:0, payment:null };
    if (paymentContext?.completeCertainHand) {
      const selected = this.selectGuardianAidDiscard(
        guardian,
        guardian.hand,
        paymentContext.discardContext
      );
      const selectedCardId = selected?.id ?? selected?.cardId ?? null;
      if (!selectedCardId) return { accepted:false, expectedReduction:0, payment:null };
      return {
        accepted:true,
        expectedReduction:triggerProbability * conditionalReduction,
        payment:{
          kind:"chosen-card",
          amount:triggerProbability,
          selectedCardId,
          result:options.result ?? null
        }
      };
    }
    return {
      accepted:true,
      expectedReduction:triggerProbability * conditionalReduction,
      payment:{
        kind:"random-card",
        amount:triggerProbability,
        result:options.result ?? null
      }
    };
  }






  /*
  功能
  按座次惰性查询同一有限牌池中的首名反制响应者。

  调用方
  TacticResolutionQuery、consumeCountersForCardScope 与 Simulator.apply：冻结一次卡牌级反制链。

  输入
  World、行动者、战术牌、目标列表、可选 selection 与动态条件创建选项。

  输出
  包含 resolutionChance、互斥响应结果和每名响应者边际消费质量的独立对象。

  读取状态
  存活座次、Counter finite-pool factor、确定身份与正式 counter decision。

  写入状态
  无。

  调用函数
  counterDecision、queryOrderedFirstResponder。

  边界与不变量
  链顺序只计算一次；逐玩家边际不得独立相乘；返回结果不得修改任何响应容量。
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
      const counterProbability = queryPlayerHandProbability(
        state.probabilityState, player, "counter"
      ).probability;
      const decision = this.counterDecision(state, player, actor, card, targets, selection) === true;
      contenders.push({ player, counterProbability, decision, effectiveProbability:0 });
    }
    void options;
    const active = contenders.filter((contender) => contender.decision);
    const ordered = queryOrderedFirstResponder(
      state.probabilityState,
      "counter",
      active.map(({ player }) => ({
        responderId:player.id,
        bucketId:player.id,
        knownResources:[
          ...(Array.isArray(player.hand) ? player.hand : []),
          ...(Array.isArray(player.knownCards) ? player.knownCards : [])
        ].filter((cardEntry) => cardEntry?.definitionId === "counter")
      }))
    );
    const responseWorlds = [
      ...ordered.responders.map((entry) => ({
        probability:entry.probability,
        conditions:{},
        responderId:entry.responderId
      })),
      { probability:ordered.none, conditions:{}, responderId:null }
    ].filter((entry) => entry.probability > PROBABILITY_EPSILON);
    const resolutionChance = ordered.none;
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
  计算单个目标经过目标级反制后的最终生效概率。

  调用方
  TacticResolutionQuery 与目标级卡牌效果：估算单个目标是否通过反制。

  输入
  World、行动者、卡牌与目标。

  输出
  目标效果最终生效概率；非目标级可反制战术返回一。

  读取状态
  目标 Counter capacity 与正式 Evaluator counter willingness。

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
    return 1 - queryPlayerHandProbability(
      state.probabilityState, target, "counter"
    ).probability;
  }

  /*
  功能
  请求 Evaluator 对当前规划反制窗口作出确定意愿判断。

  调用方
  card-scope 与 target-scope 响应查询。

  输入
  World、响应者、行动者、卡牌、目标列表与可选 selection。

  输出
  确定的 respond / do not respond 布尔值。

  读取状态
  公开/过滤状态、全体受益 assessment 与 root 递归守卫。

  写入状态
  无。

  调用函数
  注入的 Evaluator decideCounter capability。

  边界与不变量
  Simulation 不复制价值公式；root 递归守卫只阻止重复反事实，不改变普通响应。
  */
  counterDecision(state, responder, actor, card, targets, selection = null) {
    return this.decideCounter(state, responder, actor, card, targets, selection, {
      simulatingRootResolution:this._simulatingRootResolution,
    });
  }

  /*
  功能
  将攻击世界与格挡容量和身份相交，返回命中与格挡后的互斥世界。

  调用方
  Damage.applyDamage：把已确定攻击世界与格挡容量和雷达结果联合。

  输入
  World、目标、攻击世界及可选判定前格挡/多个判定牌身份。

  输出
  outcomeWorlds、blockedProbability 与 expectedBlockSpend。

  读取状态
  block 分布、已知身份、requiredCount、雷达免疫与 responseAllowed 条件。

  写入状态
  无；只返回供 Resource 执行的 payment request。

  调用函数
  getBlockCountBranches 与 Probability 连接/投影辅助函数。

  边界与不变量
  格挡结果与 payment request 共享同一世界；本方法不得修改手牌或概率容量。
  */
  resolveBlockResponseWorlds(state, target, attackWorlds, options = {}) {
    const willing = this.decideBlock(state, target, attackWorlds, options) === true;
    const blockState = queryPlayerHandProbability(
      state.probabilityState, target, "block"
    ).distribution.map(({ count, ...branch }) => ({ ...branch, blockCount:count }));
    const preJudgmentPartition = Array.isArray(options.preJudgmentBlockState)
      && options.preJudgmentBlockState.length
      ? options.preJudgmentBlockState.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          preBlockCount:branch.blockCount
        }))
      : null;
    const joined = this.intersectProbabilityWork(
      preJudgmentPartition
        ? [attackWorlds, blockState, preJudgmentPartition]
        : [attackWorlds, blockState]
    );
    /*
    功能
    判断一条响应资源分支与攻击世界条件是否兼容，避免跨世界重复消费。

    调用方
    resolveBlockResponseWorlds：在同一条件世界判断是否真正打出格挡。

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
      willing
      && branch.occurs
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
    return {
      outcomeWorlds,
      blockedProbability,
      expectedBlockSpend,
      payment:{
        identityWorlds,
        judgmentBlockCards,
        preJudgmentPartition,
        joined:joined.map((branch) => ({ ...branch, blockUsed:responseMatches(branch) })),
        expectedBlockSpend
      }
    };
  }

  /*
  功能
  将目标效果世界与 Counter 容量和确定决策相交，解析身份选择及支付请求。

  调用方
  Simulator 的 target-scope Counter 编排：解析单目标响应结果。

  输入
  World、目标、效果世界、布尔反制决策与可选响应选项。

  输出
  完整 outcome/effect/counter worlds 与局部 payment request。

  读取状态
  目标 counter/knownCounter 分布、确定身份 availability 与效果条件。

  写入状态
  无。

  调用函数
  queryPlayerHandProbability 与 Probability 连接/投影 primitive。

  边界与不变量
  Policy heuristic 不得在这里转成随机事件；W 个效果/count 世界与 H 个当前反制身份
  直接生成至多 W×(H+1) 个选择结果，时间和空间上界 O(W·H)，不得枚举 2^H presence 组合；
  所有长 join/project/merge 在同一 SearchBudget 下 cooperative abort，partial outcome 不得返回；
  identity 只写入 payment request，不在 Response 中修改 availability 或 handCount。
  */
  resolveTargetCounterResponseWorlds(state, target, effectWorlds, counterDecision, options = {}) {
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
        ),
        payment:null
      };
    }
    void options;
    const decisionPartition = [{
      probability:1,
      conditions:{},
      willing:counterDecision === true
    }];
    const counterState = queryPlayerHandProbability(
      state.probabilityState, target, "counter"
    ).distribution.map(({ count, ...branch }) => ({ ...branch, counterCount:count }));
    const candidates = [
      ...(Array.isArray(target.hand) ? target.hand
        .filter((card) => cardAvailability(card) > PROBABILITY_EPSILON && card.definitionId === "counter")
        .map((card, index) => ({ key:`hand:${card.id ?? index}`, card, definitionId:"counter" })) : []),
      ...(Array.isArray(target.knownCards) ? target.knownCards
        .filter((entry) => cardAvailability(entry) > PROBABILITY_EPSILON && entry.definitionId === "counter")
        .map((entry, index) => ({ key:`known:${entry.cardId ?? index}`, card:entry, definitionId:"counter" })) : [])
    ];
    const joined = this.intersectProbabilityWork([
      effectWorlds,
      decisionPartition,
      counterState
    ], "Response.consumeTargetCounterResponseWorlds:candidate-worlds");
    const selectionKey = this.currentProbabilityEventKey(state, `counter-selection:${target.id ?? "unknown"}`);
    const outcomes = [];
    for (let branchIndex = 0; branchIndex < joined.length; branchIndex += 1) {
      if (branchIndex % 32 === 0) this.checkpointSearchWork();
      const branch = joined[branchIndex];
      const effectOccurs = Boolean(branch.occurs);
      const willing = Boolean(branch.willing);
      const counterCount = Math.max(0, Math.floor(Number(branch.counterCount) || 0));
      const knownWeights = candidates.map((candidate) => cardAvailability(candidate.card));
      const knownCount = knownWeights.reduce((sum, weight) => sum + weight, 0);
      const anonymousCount = Math.max(0, counterCount - knownCount);
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
      // World 只保存当前 identity 边际；按当前可用质量直接形成一个有限选择分布，
      // 避免为 H 张 fractional identity 物化 2^H 个存在组合。
      const total = knownCount + anonymousCount;
      for (let index = 0; index < candidates.length; index += 1) {
        if (knownWeights[index] > PROBABILITY_EPSILON) {
          outcomes.push({
            probability:branch.probability * (knownWeights[index] / total),
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
    // 数量支付只在 counterAttempted 世界发生；身份选择只描述具体应删哪张。
    const attemptedPartition = this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(
        branch.occurs
        && branch.willing
        && Math.max(0, Math.floor(Number(branch.counterCount) || 0)) >= 1
      )
    }));
    const attemptedProbability = this.eventProbability(attemptedPartition);

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
      })),
      payment:{ candidates, selectionPartition, attemptedProbability }
    };
  }
};
