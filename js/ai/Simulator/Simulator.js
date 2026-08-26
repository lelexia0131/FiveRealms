/*
模块职责
作为 World 模拟的唯一正式门面（统一对外入口），负责世界克隆、动作分派与共享运行时协调。

上游
Searcher、Evaluator 的有界运行时查询、Worker composition 与模拟器专项测试。

下游
World、Damage、Resource、Response、Probability facade 与 Domain rules。

状态边界
只克隆并写入 World；不持有或修改真实 GameState。

信息边界
只消费过滤后的可见状态、合法记忆与 Probability 概率，不读取隐藏实体牌或未来牌堆。

架构约束
不得拥有 Policy、Value 或 Domain 公式；所有模拟算法只存在于本目录组件。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS, PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { findPlayerFact, getCardTargetIds } from "../../domain/rules/card/CardRules.js";
import {
  calculateHealAmount,
  calculateHpDamage,
  calculateShieldAbsorption,
  isDying,
  isKillRewardEligible
} from "../../domain/rules/combat/CombatRules.js";
import { interpretDefenseJudgment } from "../../domain/rules/judgment/JudgmentRules.js";
import {
  getDyingRescueResponderOrder,
  getRequiredBlockCount
} from "../../domain/rules/response/ResponseRules.js";
import { decideAllInDrawCount, decideAllInEnterChance, getSkillCost } from "../../domain/rules/skill/SkillRules.js";
import {
  nextLightningReceiverId as nextDomainLightningReceiverId
} from "../../domain/rules/status/StatusRules.js";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  buildLightningHitDistribution,
  buildRadarJudgmentSequenceProbabilities,
  cardAvailability,
  clampProbability,
  conditionProbability,
  currentProbabilitySignature,
  expectedBranchValue,
  getAvailabilityStateBranches,
  getRangeConditionBranches,
  independentUnionProbability,
  mutateProbability,
  intersectProbabilityStateBranchesCooperatively,
  mergeProbabilityStateBranchesCooperatively,
  probabilityEventPartition,
  projectProbabilityStateBranchesCooperatively,
  queryCurrentCardCounts,
  queryHandProbability,
  queryPlayerHandProbability,
  statusPresence,
  totalBranchProbability
} from "../Event/Probability/Probability.js";
import { cloneWorld } from "./World.js";
import { hasPassiveSkill, projectCanonicalSeatRoster, projectRulePlayers } from "../Event/Fact.js";

import { withResponse } from "./Response.js";
import { withDamage } from "./Damage.js";
import { withResource } from "./Resource.js";

const RADAR_BASIC_DEFINITION_IDS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "basic")
    .map((definition) => definition.definitionId)
);
const TARGET_SCOPE_CARDS = new Set(["shockwave", "provoke"]);

class SimulatorCore {
  /*
  功能
  创建只保存运行能力、不拥有初始 World 的轻量模拟器。

  调用方
  Searcher 与有界 Value/Root simulation query：为一次搜索或配对查询创建模拟生命周期。

  输入
  可选 SearchBudget、Evaluator response willingness 与 resolved discard capability。

  输出
  不持有 World、仅保存窄运行能力的 Simulator 实例。

  读取状态
  只读传入的运行选项。

  写入状态
  搜索预算、只读 willingness capabilities、概率摘要缓存与 root 递归守卫。

  调用函数
  无。

  边界与不变量
  构造不得回读 GameState；Evaluator capability 只返回 boolean 且必须全部显式注入；
  构造阶段不得复制 World；所有完整 World copy 必须由 clone 显式创建并计数。
  */
  constructor(options = {}) {
    this.searchBudget = options.searchBudget ?? null;
    const decisionCapabilities = [
      "decideCounter",
      "decideLeverageAssault",
      "decideBlock",
      "decideGuardianAid",
      "decideDyingRescue"
    ];
    for (const name of decisionCapabilities) {
      if (typeof options[name] !== "function") {
        throw new TypeError(`Simulator 缺少 Evaluator capability：${name}`);
      }
      this[name] = options[name];
    }
    if (typeof options.resolveDiscardCandidates !== "function") {
      throw new TypeError("Simulator 缺少 Evaluator capability：resolveDiscardCandidates");
    }
    this.resolveDiscardCandidates = options.resolveDiscardCandidates;
    this.selectGuardianAidDiscard = (player, cards, context) => (
      this.resolveDiscardCandidates(player, cards, 1, context)[0] ?? null
    );
    this.lightningOutcomeCache = new WeakMap();
    // root 结算模拟守卫：目标级 root 的 apply 群伤循环会再次请求 counterDecision，避免递归。
    this._simulatingRootResolution = false;
  }

  /*
  功能
  在已证实的长概率/响应同步循环内请求当前搜索预算 cooperative checkpoint。

  调用方
  Action/Response/Combat Simulation 的 current-event intersection、projection 与身份消费边界。

  输入
  无。

  输出
  可继续时返回 true；TIME/NODE/CANCEL 中断时由 SearchBudget 抛出专属 unwind signal。

  读取状态
  注入的 searchBudget。

  写入状态
  SearchBudget 首次过期时写入停止原因；不写 World。

  调用函数
  SearchBudget.checkpointCurrentWork。

  边界与不变量
  只允许 Searcher preparation boundary 捕获 signal；当前 partial World/world 必须整体丢弃。
  */
  checkpointSearchWork() {
    return this.searchBudget?.checkpointCurrentWork?.() ?? true;
  }

  /*
  功能
  在同一 SearchBudget 下原子执行一次概率操作并记录纯数字 timing/count 诊断。

  调用方
  intersectProbabilityWork、projectProbabilityWork、mergeProbabilityWork 与 rawProbabilityWork。

  输入
  operation 名称、输入世界数、cooperative/raw 模式与返回完整分支数组的 work。

  输出
  work 的完整结果；cooperative 中断继续抛出本 SearchBudget 的专属 signal。

  读取状态
  注入的 SearchBudget 与 work 捕获的只读概率输入。

  写入状态
  只写 SearchBudget probability operation 诊断。

  调用函数
  SearchBudget.beginProbabilityOperation/finishProbabilityOperation、work。

  边界与不变量
  partial 结果不得登记；诊断不记录 state/world 内容，也不参与概率、预算或搜索排序。
  */
  runProbabilityOperation(operation, inputWorldCount, mode, work) {
    const token = this.searchBudget?.beginProbabilityOperation?.(
      operation,
      inputWorldCount,
      mode
    ) ?? null;
    try {
      const result = work();
      this.searchBudget?.finishProbabilityOperation?.(token, result?.length ?? 0, true);
      if (!token) this.searchBudget?.observeProbabilityWork?.(result?.length ?? 0);
      return result;
    } catch (error) {
      this.searchBudget?.finishProbabilityOperation?.(token, 0, false);
      throw error;
    }
  }

  /*
  功能
  在同一 SearchBudget checkpoint 下按当前事件索引相交概率状态，并记录完成工作量。

  调用方
  Response 与 Simulator 的生产局部事件相交点。

  输入
  概率状态分区数组。

  输出
  完整当前事件交集；预算中断时由 SearchBudget signal 回退整个 candidate。

  读取状态
  注入的 SearchBudget 与只读概率分区。

  写入状态
  只更新 SearchBudget probability work 诊断。

  调用函数
  intersectProbabilityStateBranchesCooperatively、checkpointSearchWork、SearchBudget.observeProbabilityWork。

  边界与不变量
  partial 交集永不返回或计数；不预估或构造 generic Cartesian pair universe。
  */
  intersectProbabilityWork(partitions, operation = "Simulation.intersect") {
    let inputWorldCount = 0;
    const probabilityPartitions = partitions ?? [];
    for (let index = 0; index < probabilityPartitions.length; index += 1) {
      if (index > 0 && index % 32 === 0) this.checkpointSearchWork();
      const partition = probabilityPartitions[index];
      if (!Array.isArray(partition)) continue;
      inputWorldCount += partition.length;
    }
    const checkpoint = inputWorldCount >= 32 || this.searchBudget?.stopReason
      ? () => this.checkpointSearchWork()
      : null;
    return this.runProbabilityOperation(
      operation,
      inputWorldCount,
      "cooperative",
      () => intersectProbabilityStateBranchesCooperatively(
        partitions,
        checkpoint
      )
    );
  }

  /*
  功能
  在同一 SearchBudget checkpoint 下完整投影高分支概率状态，并记录完成工作量。

  调用方
  Response 与 Simulator 的生产高频 projection 热点。

  输入
  完整世界数组与纯 projector。

  输出
  完整投影分区；预算中断时由 SearchBudget signal 回退整个 candidate。

  读取状态
  注入的 SearchBudget 与只读概率世界。

  写入状态
  只更新 SearchBudget probability work 诊断。

  调用函数
  projectProbabilityStateBranchesCooperatively、checkpointSearchWork、SearchBudget.observeProbabilityWork。

  边界与不变量
  partial projection 永不返回或计数；projector 不得修改输入世界。
  */
  projectProbabilityWork(worlds, projector, operation = "Simulation.project") {
    const checkpoint = (worlds?.length ?? 0) >= 32 || this.searchBudget?.stopReason
      ? () => this.checkpointSearchWork()
      : null;
    return this.runProbabilityOperation(
      operation,
      Array.isArray(worlds) ? worlds.length : 0,
      "cooperative",
      () => projectProbabilityStateBranchesCooperatively(
        worlds,
        projector,
        checkpoint
      )
    );
  }

  /*
  功能
  在同一 SearchBudget checkpoint 下完整合并高分支概率状态，并记录完成工作量。

  调用方
  Response 与 Simulator 的生产高频 merge 热点。

  输入
  概率状态分支数组。

  输出
  完整合并分区；预算中断时由 SearchBudget signal 回退整个 candidate。

  读取状态
  注入的 SearchBudget 与只读概率分支。

  写入状态
  只更新 SearchBudget probability work 诊断。

  调用函数
  mergeProbabilityStateBranchesCooperatively、checkpointSearchWork、SearchBudget.observeProbabilityWork。

  边界与不变量
  partial merge 永不返回或计数；正常路径不改变签名、概率或输出顺序。
  */
  mergeProbabilityWork(branches, operation = "Simulation.merge") {
    const checkpoint = (branches?.length ?? 0) >= 32 || this.searchBudget?.stopReason
      ? () => this.checkpointSearchWork()
      : null;
    return this.runProbabilityOperation(
      operation,
      Array.isArray(branches) ? branches.length : 0,
      "cooperative",
      () => mergeProbabilityStateBranchesCooperatively(
        branches,
        checkpoint
      )
    );
  }

  /*
  功能
  在开始前观察 SearchBudget，并显式记录一项输入严格有界的 raw 概率操作。

  调用方
  已审计为小常数输入、无需在内部 cooperative checkpoint 的 Simulation 调用点。

  输入
  operation 名称、输入世界数与返回完整分支数组的 raw work。

  输出
  raw work 的完整结果。

  读取状态
  注入的 SearchBudget 与调用方小常数概率分区。

  写入状态
  只写 SearchBudget raw probability diagnostics。

  调用函数
  checkpointSearchWork、runProbabilityOperation。

  边界与不变量
  只允许输入规模不随玩家、手牌、world、response 或搜索深度增长的调用点；TIME 后不得启动。
  */
  rawProbabilityWork(operation, inputWorldCount, work) {
    this.checkpointSearchWork();
    return this.runProbabilityOperation(operation, inputWorldCount, "raw", work);
  }

  /*
  功能
  创建一个与输入和兄弟分支隔离的可变 World 模拟世界。

  调用方
  Searcher、Simulator root outcome builder、Simulator/Evaluator composition 与组件内反事实分支：创建兄弟世界。

  输入
  必填 World。内部 apply 可声明 checkpoint 已在同一原子边界完成。

  输出
  完成必要摘要同步的独立可变 World。

  读取状态
  只读显式传入的 World。

  写入状态
  只写新克隆的响应、势能与技能费用摘要。

  调用函数
  checkpointSearchWork、SearchBudget.observeClone、cloneWorld、组件初始化器与 syncActiveSkillCosts。

  边界与不变量
  默认必须在 cloneWorld 深拷贝前观察同一个 SearchBudget；不得修改输入；
  每个概率分支和兄弟节点必须拥有独立可变状态。
  */
  clone(state, options = {}) {
    if (!state || typeof state !== "object") throw new TypeError("Simulator.clone 需要 World");
    if (options.checkpoint !== false) this.checkpointSearchWork();
    this.searchBudget?.observeClone?.();
    const cloned = cloneWorld(state);
    this.initializeMomentumBranches(cloned);
    this.syncActiveSkillCosts(cloned);
    return cloned;
  }

  /*
  功能
  构造一枚闪电完整生命周期的互斥命中 World。

  调用方
  Searcher 与 Controller 的 State Value/状态反制编排。

  输入
  canonical World、初始持有者与可选存在概率覆盖。

  输出
  `{ holderId, presence, outcomes }`；每个 outcome 含命中概率和独立 after World。

  读取状态
  当前闪电状态、存活座位环、剩余判定牌池与可选 SearchBudget。

  写入状态
  只写独立命中 World 与本 Simulator 的 World-keyed 结果缓存。

  调用函数
  statusPresence、buildLightningPropagationChainIds、buildLightningHitDistribution、applyLightningHit。

  边界与不变量
  Probability 只给分布，Simulator 才构造 World；存在概率与命中概率分开保留，
  命中顺序和浮点累加顺序必须与持有者传播链一致。
  */
  buildLightningOutcomeWorlds(state, initialHolder, presenceOverride = null) {
    if (!state || !initialHolder?.alive) {
      return { holderId:initialHolder?.id ?? null, presence:0, outcomes:[] };
    }
    const presence = presenceOverride == null
      ? statusPresence(initialHolder, "lightning").probability
      : clampProbability(presenceOverride);
    let stateCache = this.lightningOutcomeCache.get(state);
    if (!stateCache) {
      stateCache = new Map();
      this.lightningOutcomeCache.set(state, stateCache);
    }
    const cacheKey = `${initialHolder.id}:${presence}`;
    if (stateCache.has(cacheKey)) return stateCache.get(cacheKey);
    this.checkpointSearchWork();
    const distribution = buildLightningHitDistribution(
      state,
      this.buildLightningPropagationChainIds(state.players, initialHolder)
    );
    const result = {
      holderId:initialHolder.id,
      presence,
      outcomes:presence <= 0
        ? []
        : distribution.map((outcome) => {
            this.checkpointSearchWork();
            return {
              holderId:outcome.holderId,
              probability:outcome.probability,
              world:this.applyLightningHit(state, outcome.holderId)
            };
          })
    };
    stateCache.set(cacheKey, result);
    return result;
  }

  /*
  功能
  按 World 玩家顺序构造所有未结算闪电的生命周期 World 集合。

  调用方
  Searcher/Controller 在调用 Evaluator.stateUtility 前。

  输入
  canonical World。

  输出
  只包含存活且闪电存在概率大于零的 outcome 集合数组。

  读取状态
  玩家顺序与闪电存在概率。

  写入状态
  仅由 buildLightningOutcomeWorlds 写独立 World 和缓存。

  调用函数
  statusPresence、buildLightningOutcomeWorlds。

  边界与不变量
  holder 顺序保持不变，以冻结 State Value 的浮点累加顺序。
  */
  buildLightningOutcomeSets(state) {
    const sets = [];
    for (const holder of state?.players ?? []) {
      if (!holder?.alive || statusPresence(holder, "lightning").probability <= 0) continue;
      sets.push(this.buildLightningOutcomeWorlds(state, holder));
    }
    return sets;
  }

  /*
  功能
  构造同一枚闪电从旧持有者转交给新持有者后的 canonical World。

  调用方
  Controller 的闪电反制配对编排。

  输入
  当前 World、旧持有者与新持有者。

  输出
  `{ world, holder }`；实体缺失时返回 null。

  读取状态
  两名玩家的公开状态字段。

  写入状态
  只写 canonical cloneWorld 产生的独立 World 中旧持有者的闪电状态。

  调用函数
  clone。

  边界与不变量
  必须先清除旧持有者再评估新传播链；不新增或复制价值语义。
  */
  buildTransferredLightningWorld(state, previousHolder, receiver) {
    if (!state || !previousHolder || !receiver) return null;
    const world = this.clone(state);
    const previous = world.players.find((player) => player.id === previousHolder.id);
    const holder = world.players.find((player) => player.id === receiver.id);
    if (!previous || !holder) return null;
    if (Array.isArray(previous.statuses)) {
      previous.statuses = previous.statuses.filter((statusId) => statusId !== "lightning");
    } else if (previous.statuses) {
      delete previous.statuses.lightning;
    }
    previous.lightningStatusProbability = 0;
    return { world, holder };
  }

  /*
  功能
  构造守誓者不护援与按既有响应链护援的两个配对 World。

  调用方
  Controller 的 Guardian willingness 编排。

  输入
  当前 World、响应者/目标/来源 ID 与伤害量。

  输出
  `{ stayWorld, aidWorld }`。

  读取状态
  伤害、响应资源、护援次数与存活状态。

  写入状态
  只写两个独立 Simulator clone。

  调用函数
  clone、applyDamage。

  边界与不变量
  STAY 只排除指定守誓者；AID 走既有完整护援 transition；两侧固定 canBlock=false。
  */
  buildGuardianAidWorlds(state, responderId, targetId, sourceId, amount) {
    const stayWorld = this.clone(state);
    const aidWorld = this.clone(state);
    const stayTarget = stayWorld.players.find((player) => player.id === targetId);
    const aidTarget = aidWorld.players.find((player) => player.id === targetId);
    const staySource = sourceId
      ? stayWorld.players.find((player) => player.id === sourceId)
      : null;
    const aidSource = sourceId
      ? aidWorld.players.find((player) => player.id === sourceId)
      : null;
    this.applyDamage(stayWorld, staySource, stayTarget, amount, {
      canBlock:false,
      excludedGuardianIds:new Set([responderId])
    });
    this.applyDamage(aidWorld, aidSource, aidTarget, amount, {
      canBlock:false,
      forcedGuardianId:responderId
    });
    return { stayWorld, aidWorld };
  }

  /*
  功能
  构造当前响应深度下 root 战术 STAY/FLIP 比较所需的配对 World。

  调用方
  Controller 的动态反制 willingness 编排与专项测试。

  输入
  当前 response World、canonical root Action 与 counter depth。

  输出
  非战术或全体受益牌返回 null；否则返回 `{ baseWorld, resolvedWorld, resolvesAtStay }`。

  读取状态
  固定卡牌定义、root 来源/目标、响应容量与当前 counter depth。

  写入状态
  只写目标收敛 clone、root 结算 clone 与递归守卫。

  调用函数
  clone、conditionProbability、apply。

  边界与不变量
  两侧除 root 是否生效外必须完全配对；目标级群体战术继续清零目标反制容量，
  root apply 期间不得递归请求同一动态反制。
  */
  buildRootFlipWorlds(state, rootAction, counterDepth) {
    const definition = CARD_DEFINITIONS[rootAction?.cardId] ?? null;
    if (!rootAction?.cardId || definition?.category !== "tactic" || definition.globalBenefit === true) {
      return null;
    }
    const actor = state.players.find((player) => player.id === rootAction.actorId);
    if (!actor?.alive) {
      return { baseWorld:state, resolvedWorld:state, resolvesAtStay:(counterDepth % 2) === 0 };
    }
    const targets = (rootAction.targetIds ?? [])
      .map((id) => state.players.find((player) => player.id === id))
      .filter((target) => target?.alive);
    let baseWorld = state;
    if (TARGET_SCOPE_CARDS.has(rootAction.cardId)) {
      baseWorld = this.clone(state);
      const source = baseWorld.players.find((player) => player.id === rootAction.actorId);
      const targetIds = new Set(targets.map((target) => target.id));
      for (const player of baseWorld.players) {
        if (player.id === rootAction.actorId || targetIds.has(player.id)) continue;
        if (source && player.battleTeam !== source.battleTeam) player.alive = false;
      }
      for (const player of baseWorld.players) {
        if (!targetIds.has(player.id)) continue;
        conditionProbability(baseWorld.probabilityState, {
          type:"CONDITION",
          definitionId:"counter",
          bucketId:player.id,
          maximum:0
        });
        if (Array.isArray(player.hand)) {
          player.hand = player.hand.filter((card) => card.definitionId !== "counter");
        }
        if (Array.isArray(player.knownCards)) {
          player.knownCards = player.knownCards.filter((card) => card.definitionId !== "counter");
        }
      }
    }
    const previousSimulating = this._simulatingRootResolution ?? false;
    this._simulatingRootResolution = true;
    try {
      return {
        baseWorld,
        resolvedWorld:this.apply(baseWorld, rootAction, {
          restoreActorHand:true,
          ignoreCounter:true
        }),
        resolvesAtStay:(counterDepth % 2) === 0
      };
    } finally {
      this._simulatingRootResolution = previousSimulating;
    }
  }

  /*
  功能
  构造实际响应结果与只移除指定响应能力的配对反事实 World。

  调用方
  Searcher 的诊断编排。

  输入
  before World、canonical Action、defender ID、移除项与可选 actual after。

  输出
  `{ actualWorld, counterfactualWorld }`。

  读取状态
  指定响应者的 Probability、hand 与 knownCards。

  写入状态
  只写反事实 clone 和两个独立 action result World。

  调用函数
  apply、clone、conditionProbability。

  边界与不变量
  反事实只移除 block/counter/recover 中明确请求的能力；其他条件和身份保持配对。
  */
  buildResponseCounterfactualWorlds(before, action, defenderId, opts = {}, after = null) {
    if (!action) return null;
    const actualWorld = after ?? this.apply(before, action);
    const counterfactualBefore = this.clone(before);
    const defender = counterfactualBefore.players.find((player) => player.id === defenderId);
    for (const [definitionId, remove] of [
      ["block", opts.removeBlock],
      ["counter", opts.removeCounter],
      ["recover", opts.removeRecover]
    ]) {
      if (!remove) continue;
      conditionProbability(counterfactualBefore.probabilityState, {
        type:"CONDITION",
        definitionId,
        bucketId:defenderId,
        maximum:0
      });
      if (Array.isArray(defender?.hand)) {
        defender.hand = defender.hand.filter((card) => card.definitionId !== definitionId);
      }
      if (Array.isArray(defender?.knownCards)) {
        defender.knownCards = defender.knownCards.filter(
          (card) => card.definitionId !== definitionId
        );
      }
    }
    this.checkpointSearchWork();
    return {
      actualWorld,
      counterfactualWorld:this.apply(counterfactualBefore, action)
    };
  }

  /*
  功能
  把一个合法匿名手牌样本专化为敌方身份确定的独立 World。

  调用方
  Searcher 的窥隙信息反事实编排。

  输入
  根 World、单个 Monte Carlo hidden world 与 viewer ID。

  输出
  已重建响应摘要的独立确定 World。

  读取状态
  根 World 的公开身份、合法 knownCards 与样本中的牌定义。

  写入状态
  只写一次完整 World clone。

  调用函数
  clone、mutateProbability。

  边界与不变量
  不回读真实未知手牌；viewer 手牌保持原样；确定 known 占位按原顺序保留。
  */
  specializeHiddenWorld(beforeState, hiddenWorld, actorId) {
    const specialized = this.clone(beforeState);
    for (const player of specialized.players ?? []) {
      if (player.id === actorId) continue;
      const definitions = hiddenWorld?.[player.id] ?? [];
      const beforePlayer = beforeState.players.find((entry) => entry.id === player.id);
      const certainKnownCount = (beforePlayer?.knownCards ?? []).filter((entry) => (
        cardAvailability(entry) >= 1 - PROBABILITY_EPSILON
      )).length;
      for (const definitionId of definitions.slice(certainKnownCount)) {
        mutateProbability(specialized.probabilityState, {
          type:"REMOVE",
          sourceBucketId:player.id,
          definitionId
        });
      }
      player.knownCards = definitions.map((definitionId, index) => ({
        cardId:`revealed:${player.id}:${index}`,
        definitionId,
        availability:1
      }));
      player.hand = undefined;
      player.handCount = definitions.length;
    }
    return specialized;
  }

  /*
  功能
  构造新增破势层的 baseline/boosted 配对输入 World。

  调用方
  Searcher 的 expose marginal 编排。

  输入
  expose 动作后的 World、行动者 ID 与本动作新增层数。

  输出
  `{ baselineWorld, boostedWorld }`。

  读取状态
  行动者当前 exposeWeaknessStacks。

  写入状态
  只写 baseline clone。

  调用函数
  clone。

  边界与不变量
  baseline 只回退本动作新增层数；boosted 直接复用只读 after World。
  */
  buildExposeMarginalWorlds(afterState, actorId, addedStacks) {
    const baselineWorld = this.clone(afterState);
    const actor = baselineWorld.players.find((entry) => entry.id === actorId);
    actor.exposeWeaknessStacks = Math.max(
      0,
      (actor.exposeWeaknessStacks ?? 0) - addedStacks
    );
    return { baselineWorld, boostedWorld:afterState };
  }

  /*
  功能
  构造旧破势层消费信用的 baseline/boosted 配对输入 World。

  调用方
  Searcher 的 assault-stack marginal 编排。

  输入
  当前 World、行动者 ID 与剩余旧层数。

  输出
  `{ baselineWorld, boostedWorld }`。

  读取状态
  当前 canonical World。

  写入状态
  只写两个独立 clone 的 exposeWeaknessStacks。

  调用函数
  clone。

  边界与不变量
  两侧除行动者破势层分别为零/旧层数外完全一致。
  */
  buildAssaultStackWorlds(currentState, actorId, remainingRootExposeStacks) {
    const boostedWorld = this.clone(currentState);
    const baselineWorld = this.clone(currentState);
    boostedWorld.players.find(
      (entry) => entry.id === actorId
    ).exposeWeaknessStacks = remainingRootExposeStacks;
    baselineWorld.players.find(
      (entry) => entry.id === actorId
    ).exposeWeaknessStacks = 0;
    return { baselineWorld, boostedWorld };
  }

  /*
  功能
  从当前 Probability 充分状态与事件语义生成稳定键。

  调用方
  getEventWorlds、概率门控和各 Simulation 组件：为新条件事件取得共享身份。

  输入
  当前独立 World 与事件语义标签。

  输出
  新的稳定字符串键。

  读取状态
  当前 ProbabilityState sufficient statistics。

  写入状态
  无。

  调用函数
  currentProbabilitySignature。

  边界与不变量
  同一当前物理概率状态与同一语义事件必须复用该键；历史 operation count 不得进入键或 World。
  */
  currentProbabilityEventKey(state, label = "event") {
    return `simulation:${label}:${currentProbabilitySignature(state?.probabilityState)}`;
  }

  /*
  功能
  把显式分支或单一概率规范化为发生/未发生的完整事件世界分区。

  调用方
  动作分派及所有条件效果组件：把标量概率或调用方分支统一为概率分支（带条件的互斥世界）。

  输入
  独立 World、缺省发生概率、可选 suppliedBranches 与事件标签。

  输出
  规范化的新 occurs 分支数组。

  读取状态
  只读取显式概率输入与当前 ProbabilityState。

  写入状态
  无。

  调用函数
  mergeProbabilityStateBranches、probabilityEventPartition、currentProbabilityEventKey。

  边界与不变量
  调用方分支优先且不得被重新采样；新建分区的发生/未发生质量之和必须为一。
  */
  getEventWorlds(state, probability = 1, suppliedBranches = null, label = "event") {
    if (Array.isArray(suppliedBranches) && suppliedBranches.length) {
      return this.projectProbabilityWork(
        suppliedBranches,
        (branch) => ({ occurs:Boolean(branch.occurs ?? branch.executes) }),
        "Simulator.getEventWorlds:supplied"
      );
    }
    return probabilityEventPartition(
      this.currentProbabilityEventKey(state, label),
      probability,
      "occurs"
    );
  }

  /*
  功能
  将已有事件世界与额外触发门相交，保留联合条件和完整概率质量。

  调用方
  反制、技能与资源效果：在既有条件世界上追加一个独立触发门。

  输入
  World、已有事件分支、零到一的附加 chance 与门标签。

  输出
  保留原条件并追加门条件的 occurs 分支数组。

  读取状态
  只读已有分支与当前 ProbabilityState。

  写入状态
  无。

  调用函数
  intersectProbabilityStateBranches、probabilityEventPartition、currentProbabilityEventKey。

  边界与不变量
  chance 为零或一时不得额外创建随机条件；原事件为 false 的世界不能被门重新激活。
  */
  gateEventWorlds(state, eventWorlds, chance, label = "gate") {
    const probability = clampProbability(chance);
    if (probability >= 1 - PROBABILITY_EPSILON) return eventWorlds;
    if (probability <= PROBABILITY_EPSILON) {
      return this.projectProbabilityWork(
        eventWorlds,
        () => ({ occurs:false }),
        "Simulator.gateEventWorlds:closed"
      );
    }
    const gate = probabilityEventPartition(
      this.currentProbabilityEventKey(state, label), probability, "gateOccurs"
    );
    const intersection = this.intersectProbabilityWork(
      [eventWorlds, gate],
      "Simulator.gateEventWorlds:intersect"
    );
    return this.projectProbabilityWork(
      intersection,
      (branch) => ({ occurs:Boolean(branch.occurs && branch.gateOccurs) }),
      "Simulator.gateEventWorlds:project"
    );
  }

  /*
  功能
  汇总事件世界中 occurs 分支的概率质量。

  调用方
  所有 Simulation 组件：把完整事件世界投影为发生概率。

  输入
  包含 probability 与 occurs 的事件分支数组。

  输出
  occurs=true 分支的总概率质量。

  读取状态
  无；只读传入分支。

  写入状态
  无。

  调用函数
  totalBranchProbability。

  边界与不变量
  只汇总已有质量，不归一化、不合并条件，也不改变分支对象。
  */
  eventProbability(eventWorlds) {
    return totalBranchProbability((eventWorlds ?? []).filter((branch) => branch.occurs));
  }

  /*
  功能
  按动作类型把单个抽象动作分派给已组合的 Simulation 组件并推进独立世界。

  调用方
  Searcher、Searcher counterfactual terms 与有界 simulation query：推进一个已经合法枚举的抽象动作。

  输入
  动作前 World、抽象动作与可选 root replay 控制；动作已经由 Generator/Policy 选择。

  输出
  独立的动作后 World；输入状态保持不变。

  读取状态
  输入 World、canonical Action 的真实意图与正式卡牌/技能定义。

  写入状态
  只写本次 clone 及 root 递归守卫；具体效果写入委托各 Simulation 组件。

  调用函数
  clone、buildSkillExecutionWorlds、buildCardExecutionWorlds、applySkill、applyCardEffect 与响应查询。

  边界与不变量
  必须先通过当前 SearchBudget checkpoint 再 clone、支付和结算；卡牌级反制容量只消费一次，
  响应顺序和随机调用顺序不得改变；中断 signal 由 Searcher preparation boundary 统一收束。
  */
  apply(state, action, controls = {}) {
    this.checkpointSearchWork();
    const next = this.clone(state, { checkpoint:false });
    if (next.playPhaseEnded) return next;
    const actor = next.players.find((player) => player.id === action.actorId);
    if (action.type === "end") {
      if (hasPassiveSkill(actor, "momentum")) {
        actor.momentum = 0;
      }
      next.playPhaseEnded = true;
      // 真实 TurnWorkflow 在出牌阶段结束后立即进入弃牌阶段并把手牌压到生命上限；
      // 搜索世界必须投影同一结算，否则 end 会把马上被强制弃置的牌仍计为可保留资源。
      this.applyMandatoryDiscard(next, actor);
      return next;
    }
    if (!actor) return next;
    if (action.type === "skill") {
      const skill = ACTIVE_SKILL_DEFINITIONS[action.skillId] ?? null;
      if (!skill) return next;
      const skillEventWorlds = this.buildSkillExecutionWorlds(next, actor, action, skill);
      const executionProbability = this.eventProbability(skillEventWorlds);
      if (executionProbability <= 0) return next;
      const skillLimit = actor.activeSkillLimit ?? skill.limitPerTurn ?? 1;
      actor.activeSkillUses = Math.min(skillLimit,
        (actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0)) + executionProbability);
      actor.activeSkillUsed = actor.activeSkillUses >= skillLimit - PROBABILITY_EPSILON;
      this.applySkill(next, actor, action, skillEventWorlds);
      this.syncActiveSkillCosts(next);
      return next;
    }
    const definition = CARD_DEFINITIONS[action.cardId] ?? null;
    const card = definition ? { ...definition, id:action.cardInstanceId } : null;
    if (!card) return next;
    const targetId = action.targetIds?.[0];
    const target = next.players.find((player) => player.id === targetId);
    const targets = (action.targetIds ?? [])
      .map((id) => next.players.find((player) => player.id === id))
      .filter(Boolean);
    const heldCard = (actor.hand ?? []).find((entry) => entry.id === action.cardInstanceId) ?? null;
    const cardEventWorlds = this.buildCardExecutionWorlds(
      next,
      actor,
      action,
      card,
      heldCard,
      controls
    );
    if (heldCard) {
      heldCard.availability = clampProbability(
        cardAvailability(heldCard) - this.eventProbability(cardEventWorlds)
      );
      if (heldCard.availability <= PROBABILITY_EPSILON) {
        actor.hand = actor.hand.filter((entry) => entry.id !== action.cardInstanceId);
      }
    }
    const executionProbability = this.eventProbability(cardEventWorlds);
    // restoreActorHand：root 效果估值专用。当前状态中 root 卡牌已经打出（资源已沉没），
    // 结算模拟时把这张卡的打出成本还原再扣，使资源账目净变化为 0，只体现 root 效果价值。
    const handRestore = controls.restoreActorHand
      && executionProbability > PROBABILITY_EPSILON ? 1 : 0;
    actor.handCount = Math.max(0, (actor.handCount ?? 0) - executionProbability + handRestore);
    if (executionProbability <= 0) return next;
    // card-scope 的取消概率与容量消费必须使用同一份 responder 评估；两者之间没有
    // 状态变化，因此重复计算 counterDecision 只会增加开销，不会提供新信息。
    const cardScopeCounterEvaluation = card.category === "tactic"
      && card.counterable !== false && !controls.ignoreCounter
      && card.counterScope !== "target"
      ? this.evaluateCardScopeCounterResponses(
        next,
        actor,
        card,
        targets,
        action.selection ?? null
      )
      : null;
    let effectEventWorlds = cardEventWorlds;
    if (card.counterScope !== "target" && cardScopeCounterEvaluation) {
      const responseWorlds = this.intersectProbabilityWork([
        cardEventWorlds,
        cardScopeCounterEvaluation.responseWorlds
      ], "Simulator.apply:card-scope-response");
      cardScopeCounterEvaluation.responseWorlds = this.projectProbabilityWork(
        responseWorlds,
        (branch) => ({
          responderId:branch.occurs ? branch.responderId : null,
          availableKnownKeys:branch.availableKnownKeys ?? [],
        }),
        "Simulator.apply:card-scope-response-outcome"
      );
      effectEventWorlds = this.projectProbabilityWork(
        responseWorlds,
        (branch) => ({ occurs:Boolean(branch.occurs && branch.responderId === null) }),
        "Simulator.apply:card-scope-effect"
      );
    }
    const scale = this.eventProbability(effectEventWorlds);
    // card-scope 战术的生效概率与反制资源消费必须来自同一 responseEvaluation。
    // 这里兑现该评估的边际取消世界，使同一张反制不能既取消当前战术，又保留在
    // 当前 Counter query / sealCounterProbability 中成为未来可用容量。
    if (card.category === "tactic" && card.counterable !== false
      && !controls.ignoreCounter && card.counterScope !== "target") {
      this.consumeCountersForCardScope(
        next,
        actor,
        card,
        targets,
        action.selection ?? null,
        cardScopeCounterEvaluation
      );
    }
    return this.applyCardEffect(next, actor, action, {
      card,
      target,
      cardEventWorlds,
      effectEventWorlds,
      executionProbability,
      scale
    });
  }

  /*
  功能
  从给定座位沿真实座次生成循环顺序，可选择是否包含起点。

  调用方
  Simulator 的全体受益结算：按真实座次取得接收顺序。

  输入
  World、来源玩家与是否包含来源的布尔选项。

  输出
  按来源之后顺时针排列的存活玩家新数组。

  读取状态
  players 的 alive、id 与 seatIndex。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不修改 players 原数组；同座次输入保持现有稳定顺序，死亡玩家始终排除。
  */
  seatOrderFrom(state, source, includeSource = false) {
    const players = state?.players ?? [];
    const seatCount = Math.max(1, players.length);
    const sourceSeat = Number(source?.seatIndex) || 0;
    return players.filter((player) => player.alive && (includeSource || player.id !== source.id))
      .sort((left, right) => {
        const leftDistance = ((Number(left.seatIndex) || 0) - sourceSeat + seatCount) % seatCount;
        const rightDistance = ((Number(right.seatIndex) || 0) - sourceSeat + seatCount) % seatCount;
        return leftDistance - rightDistance;
      });
  }

  /*
  功能
  返回 Domain rule 确定的下一名闪电接收者 ID。

  调用方
  buildLightningPropagationChainIds 与 simulation lifecycle tests。

  输入
  canonical 玩家座次数组与当前持有者。

  输出
  下一接收者 ID；不存在时为 null。

  读取状态
  玩家 alive、seatIndex、status 与当前 holder ID。

  写入状态
  无。

  调用函数
  RuleProjection.projectCanonicalSeatRoster、Domain StatusRules.nextLightningReceiverId。

  边界与不变量
  接收者规则只由 Domain authority 解释；本方法不计算概率或修改状态。
  */
  nextLightningReceiverId(players, holder) {
    if (!holder?.alive || !Array.isArray(players) || !players.length) return null;
    return nextDomainLightningReceiverId(
      projectCanonicalSeatRoster(players),
      holder.id
    ) ?? null;
  }

  /*
  功能
  构造闪电在当前存活座位环的一圈合法持有者 ID 顺序。

  调用方
  Simulator/Evaluator composition 与 simulation lifecycle tests。

  输入
  canonical 玩家座次数组与初始持有者。

  输出
  以初始持有者开头、每名玩家最多一次的新 ID 数组。

  读取状态
  玩家 alive、seatIndex、status 与初始 holder。

  写入状态
  无。

  调用函数
  nextLightningReceiverId、RuleProjection.projectCanonicalSeatRoster。

  边界与不变量
  Domain rule 负责跳过死亡者和已有闪电者；回到初始 holder、原地或无接收者时立即终止。
  */
  buildLightningPropagationChainIds(players, initialHolder) {
    if (!initialHolder?.alive || !Array.isArray(players) || !players.length) return [];
    const roster = projectCanonicalSeatRoster(players);
    const chainIds = [initialHolder.id];
    let currentId = initialHolder.id;
    while (chainIds.length < roster.length) {
      const nextId = nextDomainLightningReceiverId(roster, currentId);
      if (!nextId || nextId === currentId || nextId === initialHolder.id) break;
      chainIds.push(nextId);
      currentId = nextId;
    }
    return chainIds;
  }

}

/*
功能
把 Damage、Resource 与 Response sibling 的跨子系统结算顺序组合到唯一 Simulator facade。

调用方
本模块末尾的 Simulator composition。

输入
已组合三个 sibling capability 的 Base class。

输出
新增响应支付与伤害生命周期编排方法的 class。

读取状态
无。

写入状态
无；实例方法只推进调用方传入的独立 World。

调用函数
无。

边界与不变量
sibling 只提供本地 capability；所有 sibling 间的调用顺序和 exactly-once payment 都在此层定义。
*/
const withSimulatorOrchestration = (Base) => class SimulatorOrchestration extends Base {
  /*
  功能
  解析一次 Block 响应并执行其唯一物理支付。

  调用方
  applyDamage 的雷达与普通可格挡路径，以及 Simulator 专项测试。

  输入
  World、目标、攻击世界和可选雷达判定上下文。

  输出
  Response 解析得到的 outcome worlds、格挡概率与期望支付量。

  读取状态
  Response 的 resolved result 与 Resource payment request。

  写入状态
  仅通过 Resource 执行一次格挡身份、handCount 和概率容量扣减。

  调用函数
  resolveBlockResponseWorlds、consumeBlockPayment。

  边界与不变量
  Response 不修改资源；payment 不得重复执行。
  */
  consumeBlockResponseWorlds(state, target, attackWorlds, options = {}) {
    const response = this.resolveBlockResponseWorlds(state, target, attackWorlds, options);
    this.consumeBlockPayment(state, target, response.payment);
    return response;
  }

  /*
  功能
  解析一次 target-scope Counter 响应并执行其唯一物理支付。

  调用方
  目标级战术、card-scope 首响应者兑现和 Simulator 专项测试。

  输入
  World、目标、效果世界与确定 willingness。

  输出
  Response 解析得到的 outcome/effect/counter worlds。

  读取状态
  Response resolved result 与已选 Counter identity request。

  写入状态
  仅通过 Resource 扣除一次 Counter 身份或匿名容量。

  调用函数
  resolveTargetCounterResponseWorlds、consumeCounterPayment。

  边界与不变量
  willingness 不得重新计算；Response 选择与 Resource 消费必须复用同一 selection partition。
  */
  consumeTargetCounterResponseWorlds(state, target, effectWorlds, counterDecision) {
    const response = this.resolveTargetCounterResponseWorlds(
      state,
      target,
      effectWorlds,
      counterDecision
    );
    this.consumeCounterPayment(state, target, response.payment);
    return response;
  }

  /*
  功能
  在冻结的 card-scope 响应世界中兑现一名首响应者的 Counter 支付。

  调用方
  consumeCountersForCardScope。

  输入
  World、响应者与包含 responderId 的共享响应世界。

  输出
  实际消费的 Counter 概率质量。

  读取状态
  冻结响应世界与当前 Counter capacity。

  写入状态
  通过 target-scope 编排扣除一次 Counter 支付。

  调用函数
  consumeTargetCounterResponseWorlds、概率投影与汇总 primitive。

  边界与不变量
  只在该玩家是首名响应者的世界支付，不建立第二个随机响应事件。
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
  按冻结的 card-scope 响应链依次执行每名实际首响应者的 Counter 支付。

  调用方
  Simulator.apply 的 card-scope tactic 路径。

  输入
  World、行动者、卡牌、目标、selection 与可选已冻结 response evaluation。

  输出
  无返回值；evaluation 中的 payment 已兑现。

  读取状态
  Response evaluation 的 contenders、effectiveProbability 和共享 responseWorlds。

  写入状态
  仅通过 Counter payment 编排修改响应者资源。

  调用函数
  evaluateCardScopeCounterResponses、consumeCounterResponseWorlds。

  边界与不变量
  已提供 evaluation 时不得重新评估；每个互斥 responder world 最多支付一次。
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
  按座次编排 Guardian response、已解析 identity 支付和伤害减免。

  调用方
  applyDamage：Block 后、Shield 前存在 pending HP damage 时。

  输入
  World、受保护目标、入射期望 HP 伤害、触发概率、排除 ID 与伤害选项。

  输出
  Guardian 减免后的非负期望伤害量。

  读取状态
  Guardian 资格、使用概率、物理手牌描述与 Response resolved result。

  写入状态
  Resource 支付，以及接受者 guardianAidUsed 概率摘要。

  调用函数
  hasCompleteCertainHand、buildDiscardKeepValueContext、resolveGuardianAidResponse、consumeGuardianAidPayment。

  边界与不变量
  保持座次与原 willingness 调用顺序；接受时 selection/payment 各一次，拒绝时均为零；
  匿名支付只传递 random-card 请求，不展开 definitionId。
  */
  simulateGuardianAid(state, target, incomingDamage, eventProbability, excludedGuardianIds = null, options = {}) {
    const probability = clampProbability(eventProbability);
    if (incomingDamage <= PROBABILITY_EPSILON || probability <= PROBABILITY_EPSILON) {
      return Math.max(0, incomingDamage);
    }
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
      const handAvailability = clampProbability(guardian.handCount);
      const triggerProbability = remainingTriggerProbability * (1 - oldUsedProbability) * handAvailability;
      if (triggerProbability <= PROBABILITY_EPSILON) continue;
      const paymentContext = this.hasCompleteCertainHand(guardian)
        ? {
            completeCertainHand:true,
            discardContext:this.buildDiscardKeepValueContext(state, guardian)
          }
        : { completeCertainHand:false, discardContext:null };
      const response = this.resolveGuardianAidResponse(state, guardian, target, {
        incomingDamage,
        eventProbability:probability,
        triggerProbability,
        conditionalReduction,
        paymentContext,
        options
      });
      if (!response.accepted) continue;
      const paid = this.consumeGuardianAidPayment(state, guardian, response.payment);
      if (paid <= PROBABILITY_EPSILON) continue;
      guardian.guardianAidUsedProbability = clampProbability(oldUsedProbability + triggerProbability);
      guardian.guardianAidUsed = guardian.guardianAidUsedProbability >= 1 - Number.EPSILON;
      expectedReduction += response.expectedReduction;
      remainingTriggerProbability = Math.max(0, remainingTriggerProbability - triggerProbability);
    }
    return Math.max(0, incomingDamage - expectedReduction);
  }

  /*
  功能
  按雷达、Block、Guardian、Shield、HP、伤后钩子与 fatal/rescue 的固定顺序编排一次伤害。

  调用方
  卡牌、技能、状态与 Simulator 攻击入口。

  输入
  独立 World、可空攻击者、存活目标、正伤害量与格挡/装备/事件选项。

  输出
  期望生命伤害量；可选 outcome 同步得到伤害与格挡概率分支。

  读取状态
  事件世界、攻防装备、响应结果、护援结果、护盾/生命与状态钩子。

  写入状态
  依次委托 Resource 支付、Damage HP/shield commit、伤后状态与 fatal/rescue 编排。

  调用函数
  consumeBlockResponseWorlds、simulateGuardianAid、applyResolvedDamage、resolveFatal 与伤后钩子。

  边界与不变量
  顺序固定为逐需求雷达→Block→pending HP damage Guardian→Shield/HP→afterDamage→fatal/rescue/death→rescued post-hook；
  sibling 只接收已解析输入，任何响应支付不得重复执行。
  */
  applyDamage(state, attacker, target, amount, options = {}) {
    if (!target.alive || amount <= 0) {
      if (options.outcome) {
        options.outcome.lifeDamageChance = 0;
        options.outcome.blockedByCardChance = 0;
      }
      return 0;
    }
    const eventWorlds = this.getEventWorlds(
      state,
      options.eventProbability ?? 1,
      options.eventBranches,
      `damage-event:${attacker?.id ?? "unknown"}:${target.id}`
    );
    const eventProbability = this.eventProbability(eventWorlds);
    if (eventProbability <= 0) return 0;
    const amountState = (Array.isArray(options.amountBranches) && options.amountBranches.length
      ? this.mergeProbabilityWork(
          options.amountBranches,
          "Damage.applyDamage:amount"
        )
      : [{ probability:1, conditions:{}, amount }]).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      damageAmount:Math.max(0, Number(branch.amount) || 0)
    }));
    const battleProbability = clampProbability(options.deviceAttack
      && attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability
        ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    // 雷达按统一“需要打出格挡”语义生效：只要伤害可格挡且目标持有防御装置，
    // 就进入判定路径，不依赖具体卡牌名称。
    const defenseProbability = options.canBlock
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = 0;
    let passChance = 1;
    let attackOutcomeWorlds = null;
    if (defenseProbability > 0) {
      const battleKey = this.currentProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount("battleDevice", true) }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount(null, true) }]
          : [
              {
                probability:battleProbability,
                conditions:{ [battleKey]:"yes" },
                requiredCount:getRequiredBlockCount("battleDevice", true)
              },
              {
                probability:1 - battleProbability,
                conditions:{ [battleKey]:"no" },
                requiredCount:getRequiredBlockCount(null, true)
              }
            ];
      const radarPresencePartition = probabilityEventPartition(
        this.currentProbabilityEventKey(state, `radar-present:${target.id}`),
        defenseProbability,
        "hasRadar"
      );
      const maximumRequirement = Math.max(
        0,
        ...requiredPartition.map((branch) => Math.max(0, Math.floor(Number(branch.requiredCount) || 0)))
      );
      const maximumAllowedRequirement = Math.max(
        getRequiredBlockCount(null, true),
        getRequiredBlockCount("battleDevice", true)
      );
      const radarOutcomeSequence = this.buildRadarOutcomeSequencePartition(
        state,
        maximumRequirement,
        maximumAllowedRequirement,
        options.radarJudgmentProbabilities,
        options.radarJudgmentProbabilitiesByRequirement
      );
      const joinedBaseWorlds = this.intersectProbabilityWork(
        [eventWorlds, requiredPartition, radarPresencePartition, radarOutcomeSequence],
        "Damage.applyDamage:radar-base"
      );
      const baseWorlds = joinedBaseWorlds.map((branch, index) => {
        if (index % 32 === 0) this.checkpointSearchWork();
        const originalRequiredCount = branch.requiredCount;
        const radarOutcomes = branch.hasRadar && branch.occurs
          ? branch.radarOutcomes.slice(0, originalRequiredCount)
          : Array.from({ length:originalRequiredCount }, () => null);
        const waivedBlockCount = branch.hasRadar && branch.occurs
          ? branch.waivedBlockSlots.slice(0, originalRequiredCount)
            .reduce((sum, waived) => sum + waived, 0)
          : 0;
        return {
          ...branch,
          radarOutcomes,
          waivedBlockCount,
          originalRequiredCount,
          requiredCount:Math.max(0, originalRequiredCount - waivedBlockCount),
          responseAllowed:Boolean(options.canBlock)
        };
      });
      // 判定前容量必须单独键化，避免新判定身份同时进入根容量与本次增量。
      const preJudgmentKey = this.currentProbabilityEventKey(state, "pre-judgment-blocks");
      const preJudgmentBlockState = queryPlayerHandProbability(
        state.probabilityState,
        target,
        "block"
      ).distribution.map((branch, index) => ({
        probability:branch.probability,
        conditions:{ ...branch.conditions, [preJudgmentKey]:`v${index}` },
        blockCount:branch.blockCount
      }));
      const judgmentBlockCards = [];
      for (let slot = 0; slot < maximumRequirement; slot += 1) {
        for (const definitionId of RADAR_BASIC_DEFINITION_IDS) {
          this.checkpointSearchWork();
          const acquisitionWorlds = this.projectProbabilityWork(
            baseWorlds,
            (branch) => ({
              occurs:Boolean(branch.occurs
                && branch.hasRadar
                && slot < branch.originalRequiredCount
                && branch.radarOutcomes?.[slot] === `basic:${definitionId}`)
            }),
            "Damage.applyDamage:radar-identity"
          );
          if (this.eventProbability(acquisitionWorlds) <= PROBABILITY_EPSILON) continue;
          const simulatedId = this.nextSimulatedCardId(state, definitionId);
          if (Array.isArray(target.hand)) {
            this.addSimulatedCardToHand(
              state,
              target,
              { id:simulatedId, definitionId },
              acquisitionWorlds
            );
            if (definitionId === "block") {
              const judgedBlock = target.hand.find((card) => card.id === simulatedId) ?? null;
              if (judgedBlock) judgmentBlockCards.push(judgedBlock);
            }
          } else {
            this.addSimulatedKnownCard(
              state,
              target,
              { cardId:simulatedId, definitionId },
              acquisitionWorlds
            );
            if (definitionId === "block") {
              const judgedBlock = target.knownCards.find((entry) => entry.cardId === simulatedId) ?? null;
              if (judgedBlock) judgmentBlockCards.push(judgedBlock);
            }
          }
        }
      }
      const response = this.consumeBlockResponseWorlds(state, target, baseWorlds, {
        preJudgmentBlockState,
        judgmentBlockCards,
        incomingDamage:amount
      });
      attackOutcomeWorlds = response.outcomeWorlds;
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, response.blockedProbability / eventProbability)
        : 0;
    } else if (options.canBlock) {
      const battleKey = this.currentProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount("battleDevice", true) }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount(null, true) }]
          : [
              {
                probability:battleProbability,
                conditions:{ [battleKey]:"yes" },
                requiredCount:getRequiredBlockCount("battleDevice", true)
              },
              {
                probability:1 - battleProbability,
                conditions:{ [battleKey]:"no" },
                requiredCount:getRequiredBlockCount(null, true)
              }
            ];
      const responseWorlds = this.intersectProbabilityWork(
        [eventWorlds, requiredPartition],
        "Damage.applyDamage:block"
      ).map((branch) => ({ ...branch, responseAllowed:true }));
      const response = this.consumeBlockResponseWorlds(state, target, responseWorlds, {
        incomingDamage:amount
      });
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, response.blockedProbability / eventProbability)
        : 0;
      passChance = clampProbability(1 - blockedByCardChance);
    }
    let damagePassProbability = eventProbability * passChance;
    if (attackOutcomeWorlds) {
      damagePassProbability = 0;
      for (let index = 0; index < attackOutcomeWorlds.length; index += 1) {
        if (index % 32 === 0) this.checkpointSearchWork();
        const branch = attackOutcomeWorlds[index];
        if (branch.occurs && branch.passes) {
          damagePassProbability += Math.max(0, Number(branch.probability) || 0);
        }
      }
    }
    const shieldState = [{
      probability:1,
      conditions:{},
      shieldAmount:Number(target.shield) || 0
    }];
    const aidPassWorlds = attackOutcomeWorlds
      ?? this.intersectProbabilityWork([
        eventWorlds,
        probabilityEventPartition(
          this.currentProbabilityEventKey(
            state,
            `damage-pass-aid:${attacker?.id ?? "unknown"}:${target.id}`
          ),
          passChance,
          "passes"
        )
      ], "Damage.applyDamage:aid-pass");
    const preAidDamageWorlds = this.intersectProbabilityWork(
      [aidPassWorlds, shieldState, amountState],
      "Damage.applyDamage:pre-aid"
    );
    /*
    功能
    读取护援前真正会穿过护盾落到生命值的伤害量。

    调用方
    applyDamage 的 Guardian 资格与最终条件世界投影。

    输入
    含 occurs、passes、damageAmount 与 shieldAmount 的伤害分支。

    输出
    该分支护援前的非负生命伤害。

    读取状态
    无。

    写入状态
    无。

    调用函数
    calculateShieldAbsorption、calculateHpDamage。

    边界与不变量
    未发生或未穿过 Block 的世界必须为零；只用于决定 Guardian 窗口，不提交 Shield 或 HP。
    */
    const preAidHpDamageFor = (branch) => {
      if (!branch.occurs || !branch.passes) return 0;
      const absorbed = calculateShieldAbsorption(branch.shieldAmount, branch.damageAmount);
      return calculateHpDamage(branch.damageAmount, absorbed);
    };
    let pendingLifeDamageProbability = 0;
    let incomingExpectedHpDamage = 0;
    for (let index = 0; index < preAidDamageWorlds.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = preAidDamageWorlds[index];
      const hpDamage = preAidHpDamageFor(branch);
      if (hpDamage > PROBABILITY_EPSILON) {
        pendingLifeDamageProbability += Math.max(0, Number(branch.probability) || 0);
      }
      incomingExpectedHpDamage += branch.probability * hpDamage;
    }
    let aidReductionPerLifeDamage = 0;
    if (damagePassProbability > PROBABILITY_EPSILON) {
      const aidedExpectedHpDamage = this.simulateGuardianAid(
        state,
        target,
        incomingExpectedHpDamage,
        pendingLifeDamageProbability,
        options.excludedGuardianIds,
        options
      );
      if (pendingLifeDamageProbability > PROBABILITY_EPSILON) {
        aidReductionPerLifeDamage = Math.max(
          0,
          (incomingExpectedHpDamage - aidedExpectedHpDamage) / pendingLifeDamageProbability
        );
      }
    }
    const damageWorlds = attackOutcomeWorlds
      ? this.intersectProbabilityWork(
          [attackOutcomeWorlds, shieldState, amountState],
          "Damage.applyDamage:damage-worlds"
        )
      : this.intersectProbabilityWork([
          eventWorlds,
          probabilityEventPartition(
            this.currentProbabilityEventKey(
              state,
              `damage-pass:${attacker?.id ?? "unknown"}:${target.id}`
            ),
            passChance,
            "passes"
          ),
          shieldState,
          amountState
        ], "Damage.applyDamage:damage-worlds");
    const damageResult = this.applyResolvedDamage(
      state,
      target,
      damageWorlds,
      aidReductionPerLifeDamage,
      {
        eventProbability,
        blockedByCardChance,
        attackOutcomeWorlds,
        outcome:options.outcome ?? null
      }
    );
    this.simulateAfterLifeDamage(
      state,
      attacker,
      target,
      damageResult.lifeDamageChance,
      damageResult.lifeDamageBranches,
      options.damageContext ?? {}
    );
    this.resolveFatal(state, target, attacker);
    this.simulateSpyGapAfterLifeDamage(
      state,
      attacker,
      target,
      damageResult.lifeDamageChance
    );
    return damageResult.actualDamage;
  }

  /*
  功能
  编排濒死救援意愿、Resource 支付、死亡清理和击杀奖励。

  调用方
  applyDamage：afterDamage 钩子之后、rescued post-hook 之前。

  输入
  独立 World、濒死目标与可空伤害来源。

  输出
  无返回值；目标存活、死亡或被救援后的状态已完成。

  读取状态
  同阵营座次、救援意愿、Recover 容量、角色被动与击杀奖励规则。

  写入状态
  Resource 支付/清理、目标 HP/alive、死亡状态清理、救援被动和击杀奖励。

  调用函数
  decideDyingRescue、consumeKnownCardsFromHand、gainUnknownCardsWithCounterState、setSimulatedEquipment 与状态钩子。

  边界与不变量
  救援按目标优先再顺时针盟友顺序；每张 Recover 只支付一次；死亡清理和击杀奖励最多一次。
  */
  resolveFatal(state, target, attacker = null) {
    if (!isDying(target.hp, target.alive)) return;
    const need = Math.max(0, 1 - target.hp);
    const roster = projectCanonicalSeatRoster(state.players);
    const rescueOrder = getDyingRescueResponderOrder(roster, target.id);
    const allies = rescueOrder
      .map((id) => state.players.find((player) => player.id === id))
      .filter(Boolean);
    /*
    功能
    惰性查询一名救援者当前可用 Recover 的期望容量。

    调用方
    resolveFatal 的总容量判断与逐轮救援支付。

    输入
    当前 World 中的救援玩家。

    输出
    由唯一 ProbabilityState 和确定身份共同得到的非负期望张数。

    读取状态
    World.probabilityState 与玩家 hand/knownCards。

    写入状态
    无。

    调用函数
    queryHandProbability。

    边界与不变量
    查询结果只在本次濒死编排调用栈中存在，不写回 World 或新建分支层级。
    */
    const recoverCapacity = (player) => queryHandProbability(state.probabilityState, {
      bucketId:player.id,
      knownResources:[
        ...(Array.isArray(player.hand) ? player.hand : []),
        ...(Array.isArray(player.knownCards) ? player.knownCards : [])
      ],
      definitionId:"recover"
    }).expected;
    const rescuers = [];
    for (const player of allies) {
      const available = Math.max(0, recoverCapacity(player));
      rescuers.push({
        player,
        available,
        willing:available > PROBABILITY_EPSILON && this.decideDyingRescue(
          state,
          player,
          target,
          { need, available }
        ) === true
      });
    }
    const capacity = rescuers.reduce(
      (sum, entry) => sum + (entry.willing ? entry.available : 0),
      0
    );
    if (capacity < need) {
      target.alive = false;
      target.hp = 0;
      target.exposeWeaknessStacks = 0;
      target.assaultBonus = 0;
      target.huntMarkSourceId = null;
      target.huntMarkProbability = 0;
      target.huntMarkProbabilities = {};
      target.momentum = 0;
      target.statuses = [];
      this.clearSimulatedPlayerResources(state, target);
      this.clearHuntMarksBySource(state, target.id);
      const targetFact = roster.find((player) => player.id === target.id) ?? null;
      const attackerFact = attacker
        ? roster.find((player) => player.id === attacker.id) ?? null
        : null;
      if (isKillRewardEligible(
        { rewardGranted:false, alive:targetFact?.alive, battleTeam:targetFact?.battleTeam },
        attackerFact
      )) {
        this.gainUnknownCardsWithCounterState(
          state,
          attacker,
          RULESET_DEFINITION.killRewardDrawCount,
          null,
          "kill-reward-draw"
        );
      }
      return;
    }
    let remaining = need;
    let healingApplied = 0;
    const maxRounds = Math.max(1, Math.ceil(capacity));
    let rounds = 0;
    while (remaining > PROBABILITY_EPSILON && rounds < maxRounds) {
      let usedThisRound = false;
      for (const entry of rescuers) {
        if (remaining <= PROBABILITY_EPSILON) break;
        if (!entry.willing) continue;
        const rescuer = entry.player;
        const available = Math.max(0, recoverCapacity(rescuer));
        if (available <= PROBABILITY_EPSILON) continue;
        const canRejuvenate = hasPassiveSkill(rescuer, "rejuvenation")
          && (rescuer.rejuvenationTriggerCount ?? 0)
            < PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn;
        const healingPerCard = CARD_DEFINITIONS.recover.healAmount;
        const spent = Math.min(1, available);
        if (spent <= PROBABILITY_EPSILON) continue;
        const healing = spent * healingPerCard;
        usedThisRound = true;
        remaining -= healing;
        healingApplied += healing;
        this.consumeKnownDefinitionPayment(state, rescuer, "recover", spent);
        if (canRejuvenate) {
          // 概率救援按实际支付推进回春；摸牌和次数使用同一权重并受每回合上限约束。
          const remainingSlots = Math.max(
            0,
            PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn
              - (rescuer.rejuvenationTriggerCount ?? 0)
          );
          const consume = Math.min(spent, remainingSlots);
          if (consume > PROBABILITY_EPSILON) {
            this.gainUnknownCardsWithCounterState(
              state,
              rescuer,
              consume,
              null,
              "rejuvenation-rescue-draw"
            );
            rescuer.rejuvenationTriggerCount = (rescuer.rejuvenationTriggerCount ?? 0) + consume;
          }
        }
        this.simulateCoordination(state, rescuer, [target], spent);
      }
      rounds += 1;
      if (!usedThisRound) break;
    }
    const appliedHealing = calculateHealAmount(healingApplied, target.maxHp, target.hp);
    target.hp += appliedHealing;
    target.alive = true;
  }

  /*
  功能
  编排带来源治疗及 Rejuvenation 的唯一 Resource gain。

  调用方
  卡牌与技能治疗效果。

  输入
  独立 World、治疗来源、存活目标与正治疗量。

  输出
  无返回值；治疗和可能的被动摸牌已结算。

  读取状态
  治疗前后生命、来源阵营/被动与 Rejuvenation 次数。

  写入状态
  Damage heal、来源触发次数和 Resource unknown gain。

  调用函数
  heal、gainUnknownCardsWithCounterState。

  边界与不变量
  Rejuvenation 只按实际治疗量触发且每回合不超过两次；摸牌与次数共享同一权重。
  */
  healFrom(state, source, target, amount) {
    if (!target?.alive || target.hp >= target.maxHp || amount <= 0) return;
    const beforeHp = target.hp;
    this.heal(target, amount);
    const actualAmount = Math.max(0, target.hp - beforeHp);
    if (hasPassiveSkill(source, "rejuvenation") && source.battleTeam === target.battleTeam
      && (source.rejuvenationTriggerCount ?? 0)
        < PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn) {
      const triggerWeight = Math.min(1, actualAmount);
      if (triggerWeight <= PROBABILITY_EPSILON) return;
      const remainingSlots = Math.max(
        0,
        PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn
          - (source.rejuvenationTriggerCount ?? 0)
      );
      const consume = Math.min(triggerWeight, remainingSlots);
      if (consume <= PROBABILITY_EPSILON) return;
      source.rejuvenationTriggerCount = (source.rejuvenationTriggerCount ?? 0) + consume;
      this.gainUnknownCardsWithCounterState(
        state,
        source,
        consume,
        null,
        "rejuvenation-draw"
      );
    }
  }

  /*
  功能
  在 end 动作后编排 resolved discard choice 与 Resource 物理支付。

  调用方
  Simulator.apply 的 end 分支。

  输入
  独立 World 与行动者。

  输出
  无返回值；行动者总手牌按生命上限压缩。

  读取状态
  hand/handCount、生命、匿名容量、公开装备上下文与注入的 resolved discard capability。

  写入状态
  仅通过 Resource primitive 修改已知身份、匿名容量、handCount 与概率摘要。

  调用函数
  hasCompleteCertainHand、resolveDiscardCandidates、consumeUnknownResourceCard、consumeChosenHandCard。

  边界与不变量
  Resource 不参与排序；匿名容量先物理消费且不虚构 definitionId，已知身份只按已解析 ID 支付。
  */
  applyMandatoryDiscard(state, actor) {
    if (!actor?.alive) return;
    const rawHandCount = Number(actor.handCount);
    const handSize = Number.isFinite(rawHandCount)
      ? Math.max(0, rawHandCount)
      : (Array.isArray(actor.hand) ? actor.hand.length : 0);
    const hp = Math.max(0, Number(actor.hp) || 0);
    let remaining = Math.max(0, handSize - hp);
    if (remaining <= PROBABILITY_EPSILON) return;
    if (!Array.isArray(actor.hand)) {
      this.limitSimulatedHandCount(actor, hp);
      return;
    }
    if (this.hasCompleteCertainHand(actor)) {
      const selected = this.resolveDiscardCandidates(
        actor,
        actor.hand,
        remaining,
        this.buildDiscardKeepValueContext(state, actor)
      );
      this.consumeChosenHandCard(state, actor, remaining, {
        label:"end-hand-limit-discard",
        selectedCardIds:selected.map((card) => card.id ?? card.cardId).filter(Boolean)
      });
      return;
    }
    // 匿名容量没有可排序身份，先在匿名聚合内消费，再对余下已知身份请求 resolved choice。
    while (remaining > PROBABILITY_EPSILON) {
      const explicitExpected = [
        ...(Array.isArray(actor.hand) ? actor.hand : []),
        ...(Array.isArray(actor.knownCards) ? actor.knownCards : [])
      ].reduce((sum, card) => sum + cardAvailability(card), 0);
      const anonymousCapacity = Math.max(
        0,
        Math.max(0, Number(actor.handCount) || 0) - explicitExpected
      );
      if (anonymousCapacity <= PROBABILITY_EPSILON) break;
      const removed = this.consumeUnknownResourceCard(
        state,
        actor,
        Math.min(1, remaining, anonymousCapacity),
        anonymousCapacity
      );
      if (removed <= PROBABILITY_EPSILON) break;
      remaining = Math.max(0, Math.max(0, Number(actor.handCount) || 0) - hp);
    }
    remaining = Math.max(0, Math.max(0, Number(actor.handCount) || 0) - hp);
    if (remaining > PROBABILITY_EPSILON) {
      const selected = this.resolveDiscardCandidates(
        actor,
        actor.hand,
        remaining,
        this.buildDiscardKeepValueContext(state, actor)
      );
      this.consumeChosenHandCard(state, actor, remaining, {
        label:"end-hand-limit-discard",
        selectedCardIds:selected.map((card) => card.id ?? card.cardId).filter(Boolean)
      });
    }
  }
};

/*
功能
把卡牌与攻击的跨子系统 transition 编排加入唯一 Simulator facade。

调用方
本模块末尾的 Simulator composition。

输入
已组合 World、Response、Damage 与 Resource 能力的 Base class。

输出
新增 canonical Action sequencing 的 class。

读取状态
无。

写入状态
无；实例方法执行时只写独立 World clone。

调用函数
无。

边界与不变量
跨 Damage/Resource/Response 的顺序只在父 facade 定义；不生成动作或计算价值。
*/
const withActionTransition = (Base) => class ActionTransition extends Base {
  /*
  功能
  在当前 transition 调用栈内解析卡牌身份、距离与延迟状态条件。

  调用方
  Simulator.apply 的卡牌分派。

  输入
  独立 World、行动者、canonical Action、正式卡牌定义与当前手牌身份。

  输出
  本次卡牌实际发生/不发生的有界局部分区。

  读取状态
  当前牌 availability、目标、距离装备概率与闪电/封印存在概率。

  写入状态
  无；返回分区只存在于本次 apply 调用栈。

  调用函数
  getAvailabilityStateBranches、getRangeConditionBranches、Lightning/Seal 状态查询与概率运行时。

  边界与不变量
  transfer 最多枚举三项距离装备变量，其余动作最多两项；当前规则下输出上界为八个条件世界，
  不写 Action、World 或第二种状态表示。root 配对反事实没有当前手牌实体，但由真实语义标记确认成本已沉没。
  */
  buildCardExecutionWorlds(state, actor, action, card, heldCard, controls = {}) {
    const targets = (action.targetIds ?? [])
      .map((id) => state.players.find((player) => player.id === id))
      .filter(Boolean);
    let conditionBranches = [{ probability:1, conditions:{}, matches:true }];
    if (card.definitionId === "lightning") {
      conditionBranches = statusPresence(actor, "lightning").branches.map((branch) => ({
        ...branch,
        matches:!branch.present
      }));
    } else if (card.definitionId === "seal") {
      conditionBranches = statusPresence(targets[0], "sealed").branches.map((branch) => ({
        ...branch,
        matches:!branch.present
      }));
    } else if (card.definitionId === "transfer") {
      const source = state.players.find((player) => player.id === action.selection?.sourceId);
      const receiver = state.players.find((player) => player.id === action.selection?.receiverId);
      conditionBranches = getRangeConditionBranches({ state }, [
        { source:actor, target:source, range:card.effectRange },
        { source:actor, target:receiver, range:card.effectRange }
      ]);
    } else if (card.definitionId === "leverage") {
      const first = state.players.find((player) => player.id === action.selection?.firstTargetId);
      const second = state.players.find((player) => player.id === action.selection?.secondTargetId);
      conditionBranches = getRangeConditionBranches({ state }, {
        source:first,
        target:second,
        range:first?.attackRange ?? 1
      }, {
        equipmentRequirements:[{
          player:first,
          definitionId:action.selection?.equipmentDefinitionId,
          present:true
        }]
      });
    } else if (card.definitionId === "assault" && targets[0]) {
      conditionBranches = getRangeConditionBranches({ state }, {
        source:actor,
        target:targets[0],
        range:actor.attackRange ?? 1
      });
    } else if (!card.ignoresDistance && card.effectRange != null && targets[0]) {
      conditionBranches = getRangeConditionBranches({ state }, {
        source:actor,
        target:targets[0],
        range:card.effectRange
      });
    }
    const availabilityBranches = controls.restoreActorHand && !heldCard
      ? [{ probability:1, conditions:{}, available:true }]
      : getAvailabilityStateBranches(
          heldCard,
          heldCard ? cardAvailability(heldCard) : 0
        );
    const joined = this.intersectProbabilityWork(
      [conditionBranches, availabilityBranches],
      "Simulator.buildCardExecutionWorlds:conditions"
    );
    return this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(branch.matches && branch.available)
    }), "Simulator.buildCardExecutionWorlds:execution");
  }

  /*
  功能
  执行一张已完成动作支付与 card-scope 响应门控的卡牌效果。

  调用方
  Simulator.apply 唯一动作分派入口。

  输入
  独立 World、行动者、抽象动作，以及 Simulator 门面计算出的共享事件世界、
  响应前状态和目标摘要。

  输出
  同一独立 World。

  读取状态
  卡牌定义、目标、效果世界与组件共享资源摘要。

  写入状态
  仅输入 World 的卡牌效果、资源和触发摘要。

  调用函数
  Damage、Response、Skill/Status 后置钩子与资源辅助函数。

  边界与不变量
  不重新计算动作支付或 card-scope 响应；响应前摘要只供窥探 option value 读取，
  不能作为结算目标；switch 顺序与既有后置触发顺序保持不变。
  */
  applyCardEffect(next, actor, abstractAction, context) {
    const {
      card,
      target,
      cardEventWorlds,
      effectEventWorlds,
      executionProbability,
      scale
    } = context;
    const cardDamageContext = { cardDamage:true, emberTriggeredProbabilities:{} };
    let coordinationProbability = 0;
    let coordinationTargets = [];

    switch (card.definitionId) {
      case "recover":
        this.healFrom(next, actor, actor, CARD_DEFINITIONS.recover.healAmount * scale);
        actor.recoverUsed = (actor.recoverUsed ?? 0) + executionProbability;
        break;
      case "charge": this.changeEnergy(next, actor, CARD_DEFINITIONS.charge.energyGain, effectEventWorlds); break;
      case "shield":
        if (target?.alive && target.battleTeam === actor.battleTeam) {
          this.changeShield(next, target, CARD_DEFINITIONS.shield.shieldAmount, effectEventWorlds);
          coordinationProbability = scale;
          coordinationTargets = [target];
        }
        break;
      case "harvest":
        this.gainUnknownCardsWithCounterState(
          next, actor, CARD_DEFINITIONS.harvest.drawCount, effectEventWorlds, "harvest-draw"
        );
        break;
      case "exposeWeakness": actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0)
        + CARD_DEFINITIONS.exposeWeakness.stacksGain * scale; break;
      case "lightning":
        this.applyDelayedStatusCard(next, actor, null, "lightning", effectEventWorlds);
        break;
      case "seal":
        this.applyDelayedStatusCard(next, actor, target, "sealed", effectEventWorlds);
        break;
      case "scout": {
        if (!target?.alive) break;
        this.recordSimulatedPrivatePeek(
          next,
          actor,
          target,
          CARD_DEFINITIONS.scout.maxRevealCount,
          effectEventWorlds
        );
        coordinationProbability = scale;
        coordinationTargets = [target];
        break;
      }
      case "assault":
        if (target) this.simulateAssault(next, actor, target, cardEventWorlds, {
          damageContext:cardDamageContext
        });
        break;
      case "shockwave":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDecision(next, player, actor, card, [player])
          );
          this.applyDamage(next, actor, player, CARD_DEFINITIONS.shockwave.perTargetDamage, {
            canBlock:true,
            deviceAttack:true,
            eventBranches:counterResponse.effectPassWorlds,
            damageContext:cardDamageContext
          });
        }
        break;
      case "provoke":
        for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) {
          const counterResponse = this.consumeTargetCounterResponseWorlds(
            next,
            player,
            effectEventWorlds,
            this.counterDecision(next, player, actor, card, [player])
          );
          const targetWorlds = counterResponse.effectPassWorlds;
          const response = queryPlayerHandProbability(
            next.probabilityState, player, "assault"
          ).probability;
          const eventProbability = this.eventProbability(targetWorlds);
          const spent = Math.min(eventProbability, response);
          const knownBefore = (Array.isArray(player.hand) ? player.hand : [])
            .filter((entry) => entry.definitionId === "assault")
            .reduce((sum, entry) => sum + cardAvailability(entry), 0);
          this.consumeKnownCardsFromHand(next, player, "assault", spent);
          const knownAfter = (Array.isArray(player.hand) ? player.hand : [])
            .filter((entry) => entry.definitionId === "assault")
            .reduce((sum, entry) => sum + cardAvailability(entry), 0);
          const anonymousSpent = Math.max(0, spent - (knownBefore - knownAfter));
          if (anonymousSpent > PROBABILITY_EPSILON) mutateProbability(next.probabilityState, {
            type:"REMOVE",
            sourceBucketId:player.id,
            definitionId:"assault",
            probability:anonymousSpent
          });
          player.handCount = Math.max(0, player.handCount - spent);
          this.applyDamage(next, actor, player, CARD_DEFINITIONS.provoke.failDamage, {
            canBlock:false,
            deviceAttack:false,
            eventBranches:this.gateEventWorlds(next, targetWorlds,
              1 - response, `provoke-response:${card.id}:${player.id}`),
            damageContext:cardDamageContext
          });
        }
        break;
      case "leverage": {
        const first = next.players.find((player) => player.id === abstractAction.selection?.firstTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targetIds?.[0]);
        const second = next.players.find((player) => player.id === abstractAction.selection?.secondTargetId)
          ?? next.players.find((player) => player.id === abstractAction.targetIds?.[1]);
        if (!first?.alive || !second?.alive || !first.equipmentDefinitionId) break;
        // 借势第二目标选择只按距离，但实际打出突袭必须满足普通突袭完整目标合法性。
        const rulePlayers = projectRulePlayers(next.players);
        const firstRuleFact = findPlayerFact(rulePlayers, first.id);
        const canActuallyTargetWithAssault = getCardTargetIds(
          rulePlayers,
          firstRuleFact,
          CARD_DEFINITIONS.assault
        ).includes(second.id);
        // 候选组合从不因手牌估计或次数删除；实际使用必须消费第一目标自己的次数槽。
        const firstAssault = queryPlayerHandProbability(
          next.probabilityState, first, "assault"
        );
        const assaultAvailable = canActuallyTargetWithAssault
          ? firstAssault.probability
          : 0;
        const willingToAssault = this.decideLeverageAssault(next, first, second);
        const existenceProbability = this.getSimulatedEquipmentProbability(first);
        const desiredUseWorlds = this.gateEventWorlds(next, effectEventWorlds,
          assaultAvailable * (willingToAssault ? 1 : 0),
          `leverage-assault:${card.id}:${first.id}`);
        const actualUseWorlds = desiredUseWorlds;
        const effectiveUseProbability = this.eventProbability(actualUseWorlds);
        first.attackUsed = (first.attackUsed ?? 0) + effectiveUseProbability;
        const effectiveDeclineProbability = Math.min(existenceProbability, Math.max(0, scale - effectiveUseProbability));
        const assaultOpportunity = assaultAvailable > PROBABILITY_EPSILON
          ? Math.min(1, effectiveUseProbability / assaultAvailable)
          : 0;
        const assaultSpent = Math.min(
          assaultOpportunity,
          firstAssault.probability
        );
        const knownBefore = (Array.isArray(first.hand) ? first.hand : [])
          .filter((entry) => entry.definitionId === "assault")
          .reduce((sum, entry) => sum + cardAvailability(entry), 0);
        this.consumeKnownCardsFromHand(next, first, "assault", assaultSpent);
        const knownAfter = (Array.isArray(first.hand) ? first.hand : [])
          .filter((entry) => entry.definitionId === "assault")
          .reduce((sum, entry) => sum + cardAvailability(entry), 0);
        const anonymousSpent = Math.max(0, assaultSpent - (knownBefore - knownAfter));
        if (anonymousSpent > PROBABILITY_EPSILON) mutateProbability(next.probabilityState, {
          type:"REMOVE",
          sourceBucketId:first.id,
          definitionId:"assault",
          probability:anonymousSpent
        });
        first.handCount = Math.max(0, first.handCount - assaultSpent);
        // 借势实际打出突袭的分支必然处于“指定装备仍存在”条件下，避免装备效果再次乘存在概率。
        this.simulateAssault(next, first, second, actualUseWorlds, {
          sourceEquipmentConditional:true,
          attackUseConsumed:true,
          damageContext:cardDamageContext
        });
        actor.handCount += effectiveDeclineProbability;
        this.setSimulatedEquipment(first, first.equipmentDefinitionId, existenceProbability - effectiveDeclineProbability);
        coordinationProbability = scale;
        coordinationTargets = [first, second];
        break;
      }
      case "plunder": {
        const plundered = target
          ? this.takeResourceToHand(
              next,
              actor,
              target,
              effectEventWorlds,
              `plunder:${card.id ?? card.definitionId}`,
              abstractAction.selection
            )
          : 0;
        if (plundered > PROBABILITY_EPSILON) {
          coordinationProbability = plundered;
          coordinationTargets = [target];
        }
        break;
      }
      case "transfer": {
        const source = next.players.find((player) => player.id === abstractAction.selection?.sourceId)
          ?? null;
        const receiver = next.players.find((player) => player.id === abstractAction.selection?.receiverId)
          ?? null;
        if (source && receiver && (source.handCount ?? 0) > 0 && abstractAction.selection?.zone !== "equipment") {
          const selection = abstractAction.selection ?? {};
          const transferCardId = card?.id ?? null;
          const excludedTransferCard = transferCardId ? new Set([transferCardId]) : null;
          const transferred = selection.selectionKind === "known"
            ? this.transferKnownCardIdentity(next, source, receiver, {
                cardId:selection.cardId ?? null,
                definitionId:selection.definitionId ?? null
              }, effectEventWorlds, receiver.id === actor.id, excludedTransferCard)
            : this.transferUnknownCardIdentity(next, source, receiver,
                effectEventWorlds,
                selection.availableUnknownCount != null && Number.isFinite(Number(selection.availableUnknownCount))
                  ? Math.max(0, Number(selection.availableUnknownCount))
                  : this.availableUnknownCountFor(source, excludedTransferCard));
          coordinationProbability = transferred;
          coordinationTargets = [source, receiver];
        }
        break;
      }
      case "counter":
        coordinationProbability = scale;
        coordinationTargets = (abstractAction.targetIds ?? [])
          .map((id) => next.players.find((player) => player.id === id))
          .filter(Boolean);
        break;
      case "destroy": {
        const destroyed = target
          ? this.destroyResource(
              next,
              actor,
              target,
              effectEventWorlds,
              `destroy:${card.id ?? card.definitionId}`,
              abstractAction.selection
            )
          : 0;
        if (destroyed > PROBABILITY_EPSILON) {
          coordinationProbability = destroyed;
          coordinationTargets = [target];
        }
        break;
      }
      case "duel": if (target) this.applyDuel(next, actor, target, scale, cardDamageContext); break;
      case "mutualBenefit": {
        coordinationTargets = next.players.filter((player) => player.alive);
        coordinationProbability = scale;
        const perRecipientDrawCount = CARD_DEFINITIONS.mutualBenefit.perRecipientDrawCount;
        for (const player of coordinationTargets) {
          this.gainUnknownCardsWithCounterState(
            next, player, perRecipientDrawCount, effectEventWorlds, "mutual-benefit-draw"
          );
        }
        break;
      }
      case "symbiosis": {
        const targets = this.seatOrderFrom(next, actor, true);
        coordinationTargets = targets.filter((player) => player.hp < player.maxHp);
        coordinationProbability = scale;
        for (const player of targets) {
          this.healFrom(next, actor, player, CARD_DEFINITIONS.symbiosis.healAmount * scale);
        }
        break;
      }
      default:
        if (card.category === "equipment") this.setSimulatedEquipment(actor, card.definitionId, executionProbability);
        break;
    }
    this.simulateGamble(next, actor, card, executionProbability);
    this.simulateCoordination(next, actor, coordinationTargets, coordinationProbability);
    const recycleProbability = executionProbability * this.getSimulatedEquipmentProbability(actor, "recycleDevice");
    if (card.category === "tactic" && recycleProbability > 0) {
      const remainingUses = Math.max(
        0,
        CARD_DEFINITIONS.recycleDevice.maxUsesPerTurn - (actor.recycleDeviceUses ?? 0)
      );
      const triggerProbability = Math.min(recycleProbability, remainingUses);
      actor.recycleDeviceUses = (actor.recycleDeviceUses ?? 0) + triggerProbability;
      if (triggerProbability > PROBABILITY_EPSILON) {
        const recycleWorlds = this.getEventWorlds(
          next, triggerProbability, null, `recycle-draw:${card.id ?? card.definitionId}`
        );
        this.gainUnknownCardsWithCounterState(
          next,
          actor,
          triggerProbability * CARD_DEFINITIONS.recycleDevice.triggerDrawCount,
          recycleWorlds,
          "recycle-draw"
        );
      }
    }
    if (hasPassiveSkill(actor, "momentum") && actor.alive && card.definitionId !== "assault") {
      const category = card.category ?? CARD_DEFINITIONS[card.definitionId]?.category;
      this.simulateCategoryUse(next, actor, category, cardEventWorlds);
    }
    this.syncActiveSkillCosts(next);

    return next;
  }

  /*
  功能
  联合突袭执行、格挡响应与增伤世界，结算命中伤害并返回生命伤害概率。

  调用方
  Simulator 与搜索模拟：结算一张突袭或等价攻击效果。

  输入
  独立 World、存活来源/目标、发生概率或事件世界，以及已消费槽位等选项。

  输出
  目标实际受到生命伤害的概率；状态原地推进。

  读取状态
  攻击槽、势能、破势层、装备概率、格挡容量与目标生存状态。

  写入状态
  攻击次数、追猎标记、伤害/响应资源、破势与类别使用摘要。

  调用函数
  consumeAttackUse、simulateTracking、applyDamage、simulateCategoryUse。

  边界与不变量
  次数槽先于伤害消费；破势层和突袭加成只按实际执行质量消费一次。
  */
  simulateAssault(state, source, target, resolution = 1, options = {}) {
    const desiredWorlds = Array.isArray(resolution)
      ? this.getEventWorlds(state, 1, resolution, `assault:${source.id}:${target.id}`)
      : this.getEventWorlds(state, clampProbability(resolution), null, `assault:${source.id}:${target.id}`);
    const tracksAttackSlots = Number.isFinite(Number(source.attackLimit));
    const assaultWorlds = options.attackUseConsumed || !tracksAttackSlots
      ? desiredWorlds
      : this.consumeAttackUse(state, source, desiredWorlds).eventWorlds;
    const chance = this.eventProbability(assaultWorlds);
    if (!chance || !source?.alive || !target?.alive) return 0;
    if (!tracksAttackSlots && !options.attackUseConsumed) {
      source.attackUsed = (source.attackUsed ?? 0) + chance;
    }
    this.simulateTracking(state, source, target, assaultWorlds);
    const momentumBranches = hasPassiveSkill(source, "momentum")
      ? this.syncMomentumSummary(source)
      : [{ probability:1, conditions:{}, amount:0 }];
    const damageOutcome = {};
    const baseDamage = CARD_DEFINITIONS.assault.baseDamage
      + (source.exposeWeaknessStacks ?? 0)
      + (source.assaultBonus ?? 0);
    const damageBranches = momentumBranches.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      amount:baseDamage + branch.amount
    }));
    const damage = expectedBranchValue(damageBranches);
    this.applyDamage(state, source, target, damage, {
      canBlock:true,
      deviceAttack:true,
      eventBranches:assaultWorlds,
      amountBranches:damageBranches,
      outcome:damageOutcome,
      attackerEquipmentProbability:options.sourceEquipmentConditional ? 1 : undefined,
      damageContext:options.damageContext ?? { cardDamage:true, emberTriggeredProbabilities:{} }
    });
    const lifeDamageChance = clampProbability(damageOutcome.lifeDamageChance ?? 0);
    source.exposeWeaknessStacks = (source.exposeWeaknessStacks ?? 0) * (1 - chance);
    source.assaultBonus = (source.assaultBonus ?? 0) * (1 - chance);
    this.simulateCategoryUse(
      state, source, "basic", assaultWorlds, damageOutcome.lifeDamageBranches ?? null
    );
    return lifeDamageChance;
  }

  /*
  功能
  按双方可用突袭身份和概率世界轮流结算对决，直至一方无法继续响应。

  调用方
  Simulator.applyCardEffect：结算已经通过反制门控的对决。

  输入
  独立 World、对决双方、生效概率与伤害上下文。

  输出
  双方失败概率、期望突袭消耗和剩余数量分布的新摘要对象。

  读取状态
  双方突袭数量分布、手牌数量与合法已知突袭身份。

  写入状态
  双方突袭容量、手牌计数/身份及条件伤害结果。

  调用函数
  syncAssaultSummary、consumeKnownCardsFromHand、applyDamage。

  边界与不变量
  双方同一概率世界必须成对比较；先手多响应一次的既有顺序和分布质量不得改变。
  */
  applyDuel(state, actor, target, scale, damageContext = { cardDamage:true, emberTriggeredProbabilities:{} }) {
    const resolutionProbability = clampProbability(scale);
    const actorDistribution = queryPlayerHandProbability(
      state.probabilityState, actor, "assault"
    ).distribution;
    const targetDistribution = queryPlayerHandProbability(
      state.probabilityState, target, "assault"
    ).distribution;
    const actorState = actorDistribution.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      actorCount:branch.count
    }));
    const targetState = targetDistribution.map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions ?? {},
      targetCount:branch.count
    }));
    const resolutionState = probabilityEventPartition(
      this.currentProbabilityEventKey(state, `duel-resolution:${actor.id}:${target.id}`),
      resolutionProbability,
      "resolves"
    );
    const joinedOutcomeWorlds = this.intersectProbabilityWork(
      [actorState, targetState, resolutionState],
      "Damage.applyDuel:outcomes"
    );
    const outcomeWorlds = this.projectProbabilityWork(joinedOutcomeWorlds, (branch) => {
      const targetLoses = branch.resolves && branch.targetCount <= branch.actorCount;
      const actorLoses = branch.resolves && !targetLoses;
      return {
        ...branch,
        targetLoses,
        actorLoses,
        actorSpent:branch.resolves ? Math.min(branch.actorCount, branch.targetCount) : 0,
        targetSpent:branch.resolves ? Math.min(branch.targetCount, branch.actorCount + 1) : 0
      };
    }, "Damage.applyDuel:resolved-outcomes");
    let actorLoseProbability = 0;
    let targetLoseProbability = 0;
    let expectedActorSpent = 0;
    let expectedTargetSpent = 0;
    for (let index = 0; index < outcomeWorlds.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = outcomeWorlds[index];
      if (branch.actorLoses) actorLoseProbability += Math.max(0, Number(branch.probability) || 0);
      if (branch.targetLoses) targetLoseProbability += Math.max(0, Number(branch.probability) || 0);
      expectedActorSpent += branch.probability * branch.actorSpent;
      expectedTargetSpent += branch.probability * branch.targetSpent;
    }
    const actorRemainingDistribution = this.projectProbabilityWork(outcomeWorlds, (branch) => ({
      count:branch.actorCount - branch.actorSpent
    }), "Damage.applyDuel:actor-remaining");
    const targetRemainingDistribution = this.projectProbabilityWork(outcomeWorlds, (branch) => ({
      count:branch.targetCount - branch.targetSpent
    }), "Damage.applyDuel:target-remaining");
    const actorKnownBefore = (Array.isArray(actor.hand) ? actor.hand : [])
      .filter((entry) => entry.definitionId === "assault")
      .reduce((sum, entry) => sum + cardAvailability(entry), 0);
    const targetKnownBefore = (Array.isArray(target.hand) ? target.hand : [])
      .filter((entry) => entry.definitionId === "assault")
      .reduce((sum, entry) => sum + cardAvailability(entry), 0);
    this.consumeKnownCardsFromHand(state, actor, "assault", expectedActorSpent);
    this.consumeKnownCardsFromHand(state, target, "assault", expectedTargetSpent);
    const actorKnownAfter = (Array.isArray(actor.hand) ? actor.hand : [])
      .filter((entry) => entry.definitionId === "assault")
      .reduce((sum, entry) => sum + cardAvailability(entry), 0);
    const targetKnownAfter = (Array.isArray(target.hand) ? target.hand : [])
      .filter((entry) => entry.definitionId === "assault")
      .reduce((sum, entry) => sum + cardAvailability(entry), 0);
    const actorAnonymousSpent = Math.max(
      0, expectedActorSpent - (actorKnownBefore - actorKnownAfter)
    );
    const targetAnonymousSpent = Math.max(
      0, expectedTargetSpent - (targetKnownBefore - targetKnownAfter)
    );
    for (const [player, spent] of [
      [actor, actorAnonymousSpent],
      [target, targetAnonymousSpent]
    ]) {
      const whole = Math.floor(spent);
      if (whole > 0) mutateProbability(state.probabilityState, {
        type:"REMOVE",
        sourceBucketId:player.id,
        definitionId:"assault",
        count:whole
      });
      if (spent - whole > PROBABILITY_EPSILON) mutateProbability(state.probabilityState, {
        type:"REMOVE",
        sourceBucketId:player.id,
        definitionId:"assault",
        probability:spent - whole
      });
    }
    actor.handCount = Math.max(0, actor.handCount - expectedActorSpent);
    target.handCount = Math.max(0, target.handCount - expectedTargetSpent);
    this.applyDamage(state, target, actor, CARD_DEFINITIONS.duel.failDamage, {
      canBlock:false,
      eventBranches:this.projectProbabilityWork(outcomeWorlds, (branch) => ({
        occurs:branch.actorLoses
      }), "Damage.applyDuel:actor-loses"),
      damageContext
    });
    this.applyDamage(state, actor, target, CARD_DEFINITIONS.duel.failDamage, {
      canBlock:false,
      eventBranches:this.projectProbabilityWork(outcomeWorlds, (branch) => ({
        occurs:branch.targetLoses
      }), "Damage.applyDuel:target-loses"),
      damageContext
    });
    return {
      actorLoseProbability,
      targetLoseProbability,
      expectedActorSpent,
      expectedTargetSpent,
      actorRemainingDistribution,
      targetRemainingDistribution
    };
  }
};

/*
功能
把主动技能的跨子系统 transition 编排加入唯一 Simulator facade。

调用方
本模块末尾的 Simulator composition。

输入
已经包含动作、资源、伤害与响应能力的 Base class。

输出
新增主动技能 lifecycle 方法的 class。

读取状态
无。

写入状态
无；实例方法执行时只写独立 World clone。

调用函数
无。

边界与不变量
不生成技能动作、不决定是否使用技能、不拥有价值或 Domain 合法性。
*/
const withSkillTransition = (Base) => class SkillTransition extends Base {
  /*
  功能
  按技能费用与显式使用世界同步主动技能次数、可用概率和摘要字段。

  调用方
  Simulator 构造/clone 与 Simulator 的装备变化：刷新装备可能影响的技能费用。

  输入
  独立 World。

  输出
  无返回值；每名拥有正式主动技能的玩家费用已同步。

  读取状态
  players、activeSkillId 与 Domain SkillRules 所需公开规则字段。

  写入状态
  player.activeSkillCost。

  调用函数
  getSkillCost。

  边界与不变量
  只更新费用摘要，不消费能量、次数或动作；技能定义不存在时保持原字段。
  */
  syncActiveSkillCosts(state) {
    for (const player of state?.players ?? []) {
      const skill = ACTIVE_SKILL_DEFINITIONS[player.activeSkillId] ?? null;
      if (skill) player.activeSkillCost = getSkillCost(skill, player, state?.players ?? []);
    }
  }

  /*
  功能
  在当前 transition 调用栈内解析主动技能的目标、能量与次数条件。

  调用方
  Simulator.apply 的技能分派。

  输入
  独立 World、行动者、canonical Action 与正式技能定义。

  输出
  本次技能实际发生/不发生的有界局部分区。

  读取状态
  当前能量、技能使用次数、猎印概率与距离装备概率。

  写入状态
  只消费本次技能次数的局部槽位；不把分区写回 World 或 Action。

  调用函数
  getRangeConditionBranches、ensureSkillUseSlots、consumeSlot。

  边界与不变量
  当前技能至多涉及一个目标的两项距离装备变量和固定技能次数上限；分区有界，
  结算后立即边缘化为 World 当前值，不形成持久 execution world。
  */
  buildSkillExecutionWorlds(state, actor, action, skill) {
    const target = state.players.find((player) => player.id === action.targetIds?.[0]);
    let conditionBranches = [{ probability:1, conditions:{}, matches:true }];
    if (skill.id === "hunt") {
      const markProbability = clampProbability(
        target?.huntMarkProbabilities?.[actor.id]
          ?? (target?.huntMarkSourceId === actor.id ? 1 : 0)
      );
      conditionBranches = this.getEventWorlds(
        state,
        markProbability,
        null,
        `hunt-mark:${actor.id}:${target?.id ?? "unknown"}`
      ).map((branch) => ({ ...branch, matches:Boolean(branch.occurs) }));
    } else if (skill.rangeRule === "attack" || skill.rangeRule === "fixed") {
      conditionBranches = getRangeConditionBranches({ state }, {
        source:actor,
        target,
        range:skill.rangeRule === "attack" ? actor.attackRange : skill.range
      });
    }
    const minimumEnergy = skill.id === "allIn" ? 1 : action.energyCost;
    const energyState = [{
      probability:1,
      conditions:{},
      energyAmount:Number(actor.energy) || 0
    }];
    const joined = this.intersectProbabilityWork(
      [conditionBranches, energyState],
      "Simulator.buildSkillExecutionWorlds:conditions"
    );
    const desiredWorlds = this.projectProbabilityWork(joined, (branch) => ({
      occurs:Boolean(branch.matches && branch.energyAmount >= minimumEnergy)
    }), "Simulator.buildSkillExecutionWorlds:desired");
    return this.consumeSlot(
      state,
      this.ensureSkillUseSlots(actor, skill),
      desiredWorlds,
      `skill-slot:${skill.id}`
    ).eventWorlds;
  }

  /*
  功能
  按技能标识分派主动效果，在独立 World 中结算资源、目标和状态变化。

  调用方
  Simulator.apply：在技能次数槽与执行世界确定后结算主动技能。

  输入
  独立 World、行动者、已合法的技能动作与实际执行事件世界。

  输出
  无返回值；对应技能的资源、目标和状态效果已推进。

  读取状态
  ACTIVE_SKILL_DEFINITIONS、技能目标、能量/次数槽、猎印与相关战斗资源。

  写入状态
  能量、技能次数、护盾/生命、手牌、猎印及委托组件产生的效果字段。

  调用函数
  decideAllInDrawCount、decideAllInEnterChance、getSkillCost、changeEnergy、consume/ensure slot 辅助函数、changeShield、healFrom、stealResourceToHand、applyDamage、gainUnknownCardsWithCounterState。

  边界与不变量
  技能分派顺序、费用、目标和随机/概率分支不在此重新决定；每个执行世界只消费一次技能容量。
  */
  applySkill(state, actor, action, eventWorlds) {
    const skill = ACTIVE_SKILL_DEFINITIONS[action.skillId] ?? null;
    const target = state.players.find((player) => player.id === action.targetIds?.[0]);
    const chance = this.eventProbability(eventWorlds);
    if (!skill || chance <= 0) return;
    if (skill.id === "allIn") {
      const joined = this.updateEnergyFromWorlds(actor, eventWorlds, (amount, branch) => (
        branch.occurs ? 0 : amount
      ));
      this.gainUnknownCardsWithCounterState(
        state,
        actor,
        (branch) => (branch.occurs ? decideAllInDrawCount(branch.energyAmount) : 0),
        joined,
        "allIn-draw"
      );
      const currentAssaultBonus = actor.assaultBonus ?? 0;
      const joinedExpectedValue = joined.reduce((sum, branch) => (
        sum + (branch.occurs
          ? branch.probability * decideAllInEnterChance(branch.energyAmount)
          : 0)
      ), 0);
      actor.assaultBonus = currentAssaultBonus + joinedExpectedValue * (1 - currentAssaultBonus);
      return;
    }
    const energyCost = action.energyCost ?? getSkillCost(skill, actor, state?.players ?? []);
    this.changeEnergy(state, actor, -energyCost, eventWorlds);
    if (skill.id === "breakArmy") {
      actor.attackLimit = (actor.attackLimit ?? 0)
        + chance * ACTIVE_SKILL_DEFINITIONS.breakArmy.attackLimitBonus;
    }
    else if (skill.id === "barrier" && target) {
      this.changeShield(state, target, ACTIVE_SKILL_DEFINITIONS.barrier.shieldAmount, eventWorlds);
    } else if (skill.id === "symbiosis" && target) {
      this.healFrom(state, actor, target, chance * ACTIVE_SKILL_DEFINITIONS.symbiosis.healAmount);
    } else if (skill.id === "stealSkill" && target) {
      this.stealResourceToHand(state, actor, target, chance);
    } else if (skill.id === "burningField") {
      for (const enemy of state.players) if (enemy.alive && enemy.battleTeam !== actor.battleTeam) {
        this.applyDamage(state, actor, enemy, ACTIVE_SKILL_DEFINITIONS.burningField.damageAmount, { canBlock:true, eventBranches:eventWorlds });
      }
    } else if (skill.id === "hunt" && target) {
      target.huntMarkProbabilities ??= {};
      const oldMarkProbability = clampProbability(target.huntMarkProbabilities[actor.id]
        ?? (target.huntMarkSourceId === actor.id ? 1 : 0));
      const consumedMarkProbability = Math.min(oldMarkProbability, chance);
      target.huntMarkProbabilities[actor.id] = Math.max(
        0,
        oldMarkProbability - consumedMarkProbability
      );
      target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities ?? {}).map(clampProbability));
      const fullMarkSource = Object.entries(target.huntMarkProbabilities)
        .find(([, probability]) => clampProbability(probability) >= 1 - Number.EPSILON)?.[0] ?? null;
      target.huntMarkSourceId = fullMarkSource;
      if (Array.isArray(target.statuses) && !fullMarkSource) {
        target.statuses = target.statuses.filter((status) => status !== "huntMark");
      }
      const outcome = {};
      this.applyDamage(state, actor, target, ACTIVE_SKILL_DEFINITIONS.hunt.damageAmount, {
        canBlock:true,
        eventBranches:consumedMarkProbability >= chance - PROBABILITY_EPSILON
          ? eventWorlds
          : this.gateEventWorlds(state, eventWorlds,
            chance > 0 ? consumedMarkProbability / chance : 0,
            `hunt-mark:${actor.id}:${target.id}`),
        outcome
      });
      if ((outcome.blockedByCardChance ?? 0) > PROBABILITY_EPSILON) {
        this.gainUnknownCardsWithCounterState(
          state,
          actor,
          outcome.blockedByCardChance * ACTIVE_SKILL_DEFINITIONS.hunt.blockedRewardDraw,
          null,
          "hunt-blocked-draw"
        );
      }
    } else if (skill.id === "resonance" && target) {
      this.gainUnknownCardsWithCounterState(
        state, target, ACTIVE_SKILL_DEFINITIONS.resonance.drawCount, eventWorlds, "resonance-draw"
      );
    }
  }
};

/*
功能
把被动触发、判定与延迟状态编排加入唯一 Simulator facade。

调用方
本模块末尾的 Simulator composition。

输入
已经包含动作、技能、资源、伤害与响应能力的 Base class。

输出
新增状态 lifecycle 方法的 class。

读取状态
无。

写入状态
无；实例方法执行时只写独立 World clone。

调用函数
无。

边界与不变量
状态顺序保持既有 Application contract；不拥有概率算法、策略 willingness 或最终价值。
*/
const withStatusTransition = (Base) => class StatusTransition extends Base {
  /*
  功能
  为刀客补齐势能与本回合卡牌类别使用的概率分支，并同步确定摘要。

  调用方
  Simulator 构造/clone 与 simulateCategoryUse：补齐刀客概率状态。

  输入
  独立 World。

  输出
  无返回值；刀客的势能和类别使用分支已存在并同步。

  读取状态
  玩家 characterId、momentum、categoriesUsed 及已有概率分支。

  写入状态
  momentumBranches、categoryUsedStateBranchesByCategory 及摘要字段。

  调用函数
  syncMomentumSummary、syncCategoryUsedSummary。

  边界与不变量
  已有正式分支只规范不重采样；非刀客不获得额外势能状态。
  */
  initializeMomentumBranches(state) {
    for (const player of state?.players ?? []) {
      if (!hasPassiveSkill(player, "momentum")) continue;
      this.syncMomentumSummary(player);
      player.categoryUsedProbabilities ??= {};
      player.categoriesUsed ??= [];
      for (const category of ["basic", "tactic", "equipment"]) {
        player.categoryUsedProbabilities[category] = clampProbability(
          player.categoryUsedProbabilities[category]
            ?? (player.categoriesUsed.includes(category) ? 1 : 0)
        );
        this.syncCategoryUsedSummary(player, category);
      }
    }
  }

  /*
  功能
  规范势能数量分支并把其期望值同步到玩家势能摘要。

  调用方
  Damage 与本模块势能推进：读取规范化刀客势能世界。

  输入
  包含势能确定值或 momentumBranches 的玩家摘要。

  输出
  规范化后的 amount 概率分支数组。

  读取状态
  player.momentumBranches 与 momentum。

  写入状态
  momentumBranches 与期望 momentum。

  调用函数
  mergeProbabilityStateBranches、expectedBranchValue。

  边界与不变量
  势能量不得为负；摘要必须由完整分支投影，不能另行累加。
  */
  syncMomentumSummary(player) {
    player.momentum = Math.max(
      0,
      Math.min(PASSIVE_SKILL_DEFINITIONS.momentum.maxStacks, Number(player.momentum) || 0)
    );
    return [{ probability:1, conditions:{}, amount:player.momentum }];
  }

  /*
  功能
  合并指定卡牌类别的已用分支，并同步概率与确定类别列表。

  调用方
  initializeMomentumBranches 与 simulateCategoryUse：同步一种卡牌类别的本回合使用状态。

  输入
  玩家摘要与卡牌 category。

  输出
  规范化后的 used 概率分支数组。

  读取状态
  类别分支、类别概率与确定 categoriesUsed。

  写入状态
  categoryUsedStateBranchesByCategory、categoryUsedProbabilities 与 categoriesUsed。

  调用函数
  mergeProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  只有概率一的类别才进入确定列表；不同类别的条件身份不得互相覆盖。
  */
  syncCategoryUsedSummary(player, category) {
    const probability = clampProbability(
      player.categoryUsedProbabilities?.[category]
        ?? (player.categoriesUsed?.includes(category) ? 1 : 0)
    );
    player.categoryUsedProbabilities ??= {};
    player.categoryUsedProbabilities[category] = probability;
    const index = player.categoriesUsed.indexOf(category);
    if (probability >= 1 - PROBABILITY_EPSILON && index < 0) player.categoriesUsed.push(category);
    else if (probability < 1 - PROBABILITY_EPSILON && index >= 0) player.categoriesUsed.splice(index, 1);
    if (probability <= PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, used:false }];
    }
    if (probability >= 1 - PROBABILITY_EPSILON) {
      return [{ probability:1, conditions:{}, used:true }];
    }
    return [
      { probability, conditions:{}, used:true },
      { probability:1 - probability, conditions:{}, used:false }
    ];
  }

  /*
  功能
  联合卡牌使用、类别历史与生命伤害世界，结算刀客势能获得或清空。

  调用方
  Simulator 与 Damage：在牌实际使用后推进刀客势能。

  输入
  World、行动者、卡牌类别、使用世界与可选生命伤害世界。

  输出
  无返回值；类别使用和势能分支已推进。

  读取状态
  刀客身份、当前类别/势能分支与本次使用/伤害条件。

  写入状态
  类别已用分支、类别概率、categoriesUsed、momentumBranches 与 momentum。

  调用函数
  initializeMomentumBranches、getEventWorlds、intersectProbabilityStateBranches、syncMomentumSummary、syncCategoryUsedSummary。

  边界与不变量
  同类首次且造成生命伤害才增加势能，重复类别在相交世界清空；条件质量必须守恒。
  */
  simulateCategoryUse(state, player, category, useResolution = 1, lifeDamageResolution = null) {
    if (!category || !hasPassiveSkill(player, "momentum")) return 0;
    this.initializeMomentumBranches({ players: [player] });
    const useWorlds = Array.isArray(useResolution)
      ? this.getEventWorlds(state, 1, useResolution, `momentum-use:${player.id}:${category}`)
      : this.getEventWorlds(state, clampProbability(useResolution), null,
        `momentum-use:${player.id}:${category}`);
    const lifeDamageWorlds = Array.isArray(lifeDamageResolution)
      ? this.getEventWorlds(state, 1, lifeDamageResolution,
        `momentum-life-damage:${player.id}:${category}`)
      : this.getEventWorlds(state, clampProbability(lifeDamageResolution), null,
        `momentum-life-damage:${player.id}:${category}`);
    const momentumState = this.syncMomentumSummary(player).map((branch) => ({
      probability: branch.probability,
      conditions: branch.conditions,
      momentumAmount: branch.amount
    }));
    const categoryState = this.syncCategoryUsedSummary(player, category).map((branch) => ({
      probability: branch.probability,
      conditions: branch.conditions,
      categoryUsed: Boolean(branch.used)
    }));
    const joined = this.intersectProbabilityWork(
      [momentumState, categoryState, useWorlds.map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        cardUsed: Boolean(branch.occurs)
      })),
      lifeDamageWorlds.map((branch) => ({
        probability: branch.probability,
        conditions: branch.conditions,
        lifeDamage: Boolean(branch.occurs)
      }))],
      "Simulator.simulateCategoryUse:join"
    );
    const firstUseProbability = totalBranchProbability(
      joined.filter((branch) => branch.cardUsed && !branch.categoryUsed)
    );
    const momentumOutcomes = this.projectProbabilityWork(joined, (branch) => {
      if (!branch.cardUsed) return { amount: branch.momentumAmount };
      const retained = branch.lifeDamage ? 0 : branch.momentumAmount;
      return {
        amount: Math.min(PASSIVE_SKILL_DEFINITIONS.momentum.maxStacks,
          retained + (!branch.categoryUsed ? PASSIVE_SKILL_DEFINITIONS.momentum.stacksGain : 0))
      };
    }, "Simulator.simulateCategoryUse:momentum");
    const categoryOutcomes = this.projectProbabilityWork(
      joined,
      (branch) => ({ used: Boolean(branch.categoryUsed || branch.cardUsed) }),
      "Simulator.simulateCategoryUse:category"
    );
    player.momentum = expectedBranchValue(momentumOutcomes);
    player.categoryUsedProbabilities[category] = totalBranchProbability(
      categoryOutcomes.filter((branch) => branch.used)
    );
    this.syncMomentumSummary(player);
    this.syncCategoryUsedSummary(player, category);
    return firstUseProbability;
  }

  /*
  功能
  模拟「冒险」被动：首次战术牌触发后按定义概率决定是否获得摸牌收益。
  
  调用方
  Simulator.applyCardEffect。
  
  输入
  World、行动者、已使用卡牌与生效概率。
  
  输出
  返回本次新增触发概率；成功世界中的摸牌状态已推进。
  
  读取状态
  gambleTriggeredProbability、gambleTriggered 与 SkillDefinitions 的 drawChance/drawCount。
  
  写入状态
  手牌/响应摘要、gambleTriggeredProbability 与 gambleTriggered。
  
  调用函数
  getEventWorlds、gateEventWorlds、gainUnknownCardsWithCounterState。
  
  边界与不变量
  每回合首次战术牌才产生新增触发质量；drawChance 决定成功世界，drawCount 决定成功世界中的摸牌数量，两项固定事实均由 SkillDefinitions 拥有。
  */
  simulateGamble(state, actor, card, useProbability) {
    if (!hasPassiveSkill(actor, "gamble") || card?.category !== "tactic") return 0;
    const oldProbability = clampProbability(
      actor.gambleTriggeredProbability
      ?? (actor.gambleTriggered ? 1 : 0)
    );
    const newProbability = independentUnionProbability(oldProbability, useProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.gambleTriggeredProbability = newProbability;
    actor.gambleTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const gambleWorlds = this.getEventWorlds(
        state,
        triggerProbability,
        null,
        "gamble-trigger"
      );
      const gambleSuccessWorlds = this.gateEventWorlds(
        state,
        gambleWorlds,
        PASSIVE_SKILL_DEFINITIONS.gamble.drawChance,
        "gamble-success"
      );
      this.gainUnknownCardsWithCounterState(
        state,
        actor,
        PASSIVE_SKILL_DEFINITIONS.gamble.drawCount,
        gambleSuccessWorlds,
        "gamble-draw"
      );
    }
    return triggerProbability;
  }

  /*
  功能
  按协同生效世界为有效目标结算团队资源增益。

  调用方
  Simulator、Damage 与 Simulator：在有效目标世界结算协同收益。

  输入
  World、来源、有效目标列表与结算概率。

  输出
  无返回值；团队目标资源与协同触发摘要已更新。

  读取状态
  来源/目标阵营、存活状态与 coordinationTriggeredProbability。

  写入状态
  目标手牌/响应摘要、能量或协同触发字段。

  调用函数
  gainUnknownCardsWithCounterState、changeEnergy。

  边界与不变量
  只作用于调用方确认的有效目标；同一触发质量不得对同一目标重复发放。
  */
  simulateCoordination(state, actor, effectiveTargets, resolutionProbability) {
    if (!hasPassiveSkill(actor, "coordination")) return 0;
    if (!(effectiveTargets ?? []).some((target) => target?.alive && target.id !== actor.id
      && target.battleTeam === actor.battleTeam)) return 0;
    const oldProbability = clampProbability(actor.coordinationTriggeredProbability
      ?? (actor.coordinationTriggered ? 1 : 0));
    const newProbability = independentUnionProbability(oldProbability, resolutionProbability);
    const triggerProbability = Math.max(0, newProbability - oldProbability);
    actor.coordinationTriggeredProbability = newProbability;
    actor.coordinationTriggered = newProbability >= 1 - PROBABILITY_EPSILON;
    if (triggerProbability > PROBABILITY_EPSILON) {
      const coordinationWorlds = this.getEventWorlds(state, triggerProbability, null, "coordination-draw");
      this.gainUnknownCardsWithCounterState(
        state, actor, triggerProbability, coordinationWorlds, "coordination-draw"
      );
    }
    return triggerProbability;
  }

  /*
  功能
  按追猎命中世界写入来源绑定的猎物标记及其概率分支。

  调用方
  Damage.simulateAssault：在突袭执行世界写入追猎标记。

  输入
  World、攻击来源、目标与突袭事件世界。

  输出
  无返回值；目标的来源绑定标记分支已推进。

  读取状态
  目标已有 huntMark 分支和来源 ID。

  写入状态
  huntMarkStateBranchesBySource、huntMarkProbabilities、huntMarkProbability、huntMarkSourceId 与 statuses。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  不同来源的标记分别记账；确定摘要只能来自概率一世界，未命中世界保持原标记。
  */
  simulateTracking(state, source, target, eventWorlds) {
    if (!hasPassiveSkill(source, "tracking") || target.battleTeam === source.battleTeam) return;
    source.trackingTargetIds ??= [];
    // 同一敌人本回合只能触发一次；猎杀移除标记也不会返还该次追踪额度。
    if (source.trackingTargetIds.includes(target.id)) return;
    source.trackingUses ??= source.trackingTargetIds.length;
    target.huntMarkProbabilities ??= {};
    const oldProbability = clampProbability(target.huntMarkProbabilities[source.id]
      ?? (target.huntMarkSourceId === source.id ? 1 : 0));
    const remainingUses = Math.max(
      0,
      PASSIVE_SKILL_DEFINITIONS.tracking.maxTargetsPerTurn - source.trackingUses
    );
    const limitedEventWorlds = this.eventProbability(eventWorlds) <= remainingUses + PROBABILITY_EPSILON
      ? eventWorlds
      : this.gateEventWorlds(state, eventWorlds,
        remainingUses / this.eventProbability(eventWorlds), `tracking-limit:${source.id}:${target.id}`);
    const existingBranches = probabilityEventPartition(
      this.currentProbabilityEventKey(state, `hunt-mark-existing:${source.id}:${target.id}`),
      oldProbability,
      "marked"
    );
    const joined = this.intersectProbabilityWork(
      [existingBranches, limitedEventWorlds],
      "Simulator.simulateTracking:join"
    );
    const markState = this.projectProbabilityWork(joined, (branch) => ({
      marked: Boolean(branch.marked || branch.occurs)
    }), "Simulator.simulateTracking:project");
    const markProbability = totalBranchProbability(markState.filter((branch) => branch.marked));
    const gainedProbability = Math.max(0, markProbability - oldProbability);
    target.huntMarkProbabilities[source.id] = markProbability;
    target.huntMarkProbability = Math.max(0, ...Object.values(target.huntMarkProbabilities).map(clampProbability));
    source.trackingUses += gainedProbability;
    if (markProbability >= 1 - Number.EPSILON && !source.trackingTargetIds.includes(target.id)) {
      source.trackingTargetIds.push(target.id);
      target.huntMarkSourceId = source.id;
      if (Array.isArray(target.statuses) && !target.statuses.includes("huntMark")) target.statuses.push("huntMark");
    }
  }

  /*
  功能
  在生命伤害世界中按真实钩子顺序结算受伤后的角色被动效果。

  调用方
  Damage.applyDamage：生命伤害落地后按权威顺序触发角色被动。

  输入
  World、可空来源、目标、生命伤害概率/分支与伤害上下文。

  输出
  无返回值；所有与生命伤害相关的被动状态已推进。

  读取状态
  双方角色、伤害来源、上下文去重标记与生命伤害条件。

  写入状态
  角色被动对应的手牌、能量、标记、势能或一次性触发字段。

  调用函数
  simulateSpyGapAfterLifeDamage 及资源/概率辅助函数。

  边界与不变量
  只在生命伤害世界触发；同一 damageContext 的一次性被动不得重复执行，调用顺序保持真实监听顺序。
  */
  simulateAfterLifeDamage(state, source, target, lifeDamageProbability, lifeDamageBranches = null, damageContext = {}) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target) return;
    if (damageContext.cardDamage && hasPassiveSkill(source, "ember")
      && target.battleTeam !== source.battleTeam) {
      damageContext.emberTriggeredProbabilities ??= {};
      const oldProbability = clampProbability(damageContext.emberTriggeredProbabilities[source.id]);
      const newProbability = independentUnionProbability(oldProbability, chance);
      damageContext.emberTriggeredProbabilities[source.id] = newProbability;
      damageContext.emberBaseEnergyBranches ??= {};
      damageContext.emberBaseEnergyBranches[source.id] ??= [{
        probability:1,
        conditions:{},
        amount:Number(source.energy) || 0
      }];
      if (newProbability > oldProbability + PROBABILITY_EPSILON) {
        const triggerWorlds = oldProbability <= PROBABILITY_EPSILON && lifeDamageBranches
          ? lifeDamageBranches
          : probabilityEventPartition(
            this.currentProbabilityEventKey(state, `ember-resolution:${source.id}`),
            newProbability,
            "occurs"
          );
        const baseEnergy = damageContext.emberBaseEnergyBranches[source.id].map((branch) => ({
          probability: branch.probability,
          conditions: branch.conditions,
          baseEnergyAmount: branch.amount
        }));
        const joined = this.intersectProbabilityWork(
          [baseEnergy, triggerWorlds],
          "Simulator.simulateAfterLifeDamage:ember-join"
        );
        const energyOutcomes = this.projectProbabilityWork(joined, (branch) => ({
          amount: Math.max(0, Math.min(source.maxEnergy ?? Infinity,
            branch.baseEnergyAmount + (branch.occurs
              ? PASSIVE_SKILL_DEFINITIONS.ember.energyGain
              : 0)))
        }), "Simulator.simulateAfterLifeDamage:ember-project");
        source.energy = expectedBranchValue(energyOutcomes);
      }
    }
  }

  /*
  功能
  记录私密查看已发生，但把未观测前的身份结果立即边缘化回当前 Probability。

  调用方
  Simulator 的窥探结算与 simulateSpyGapAfterLifeDamage：推进私密信息状态。

  输入
  World、观察者、被观察者、期望揭示数量与触发条件世界。

  输出
  实际发生的期望查看槽数。

  读取状态
  目标 handCount/knownCards 与当前触发质量。

  写入状态
  无；具体观察结果只在实际需要的信息反事实查询中惰性采样。

  调用函数
  cardAvailability、eventProbability。

  边界与不变量
  观察前对所有互斥身份求期望后，边际牌池必须等于观察前当前状态；
  禁止持久保存 operation×definition identity worlds，信息选择价值由惰性反事实查询拥有。
  */
  recordSimulatedPrivatePeek(state, source, target, revealCount, triggerWorlds) {
    if (!target?.alive || !Array.isArray(state?.players)) return 0;
    const triggerProbability = this.eventProbability(triggerWorlds);
    if (triggerProbability <= PROBABILITY_EPSILON) return 0;
    const knownOccupancy = (target.knownCards ?? []).reduce(
      (sum, entry) => sum + cardAvailability(entry),
      0
    );
    const revealSlots = Math.min(
      Math.max(0, Number(revealCount) || 0),
      Math.max(0, (Number(target.handCount) || 0) - knownOccupancy)
    );
    return revealSlots * triggerProbability;
  }

  /*
  功能
  根据生命伤害概率结算影客窥隙：推进一次性额度并把新观察身份写入后续可消费状态。

  调用方
  Damage.applyDamage：在生命伤害与濒死结果落地后触发。

  输入
  World、伤害来源、受伤目标与生命伤害概率。

  输出
  无返回值；满足触发条件时推进窥隙额度与目标私密信息。

  读取状态
  来源 characterId/既有触发概率、目标阵营/生命/手牌与剩余牌先验。

  写入状态
  spyGapTriggeredProbability、spyGapTriggered、lastSpyGapTargetId，以及委托记录的目标已知牌与摘要。

  调用函数
  recordSimulatedPrivatePeek。

  边界与不变量
  只有本回合尚未触发的边际生命伤害世界会揭示新牌；空手、队友、已死亡或已触发时不会产生信息价值。
  */
  simulateSpyGapAfterLifeDamage(state, source, target, lifeDamageProbability) {
    const chance = clampProbability(lifeDamageProbability);
    if (!chance || !source?.alive || !target?.alive || target.hp <= 0
      || target.battleTeam === source.battleTeam || (target.handCount ?? 0) <= 0
      || !hasPassiveSkill(source, "spyGap")) return;
    const oldTriggeredProbability = clampProbability(source.spyGapTriggeredProbability
      ?? (source.spyGapTriggered ? 1 : 0));
    const triggerProbability = (1 - oldTriggeredProbability) * chance;
    source.spyGapTriggeredProbability = independentUnionProbability(oldTriggeredProbability, chance);
    source.spyGapTriggered = source.spyGapTriggeredProbability >= 1 - Number.EPSILON;
    if (triggerProbability <= PROBABILITY_EPSILON) return;
    source.lastSpyGapTargetId = target.id;
    const triggerWorlds = probabilityEventPartition(
      this.currentProbabilityEventKey(state, `spy-gap:${source.id}:${target.id}`),
      triggerProbability,
      "occurs"
    );
    this.recordSimulatedPrivatePeek(
      state, source, target, PASSIVE_SKILL_DEFINITIONS.spyGap.maxRevealCount, triggerWorlds
    );
  }


  /*
  功能
  把权威格挡需求数量映射为按顺序排列的多次雷达联合判定分区。

  调用方
  Damage.applyDamage。

  输入
  World、格挡需求数量、响应规则给出的领域最大需求数量、可选统一概率覆盖与可选逐需求概率覆盖。

  输出
  互斥且概率守恒的 `{ radarOutcomes, waivedBlockSlots }` 条件分支。

  读取状态
  remainingCardCounts 或调用方显式覆盖。

  写入状态
  仅为联合判定分配一个条件键。

  调用函数
  Probability.buildRadarJudgmentSequenceProbabilities、interpretDefenseJudgment、currentProbabilityEventKey。

  边界与不变量
  outcomes 顺序与真实判定调用顺序一致；每个战术结果只免除一个格挡需求；
  requirementCount 超过 maxRequirementCount 时由 Probability/Pool 明确失败。
  */
  buildRadarOutcomeSequencePartition(
    state,
    requirementCount,
    maxRequirementCount,
    overrideProbabilities = null,
    overrideProbabilitiesByRequirement = null
  ) {
    const sequence = buildRadarJudgmentSequenceProbabilities(
      queryCurrentCardCounts(state.probabilityState),
      requirementCount,
      maxRequirementCount,
      overrideProbabilitiesByRequirement,
      overrideProbabilities
    );
    const key = this.currentProbabilityEventKey(state, "radar-outcome-sequence");
    return sequence.map((branch, index) => ({
      probability:branch.probability,
      conditions:{ [key]:`v${index}` },
      radarOutcomes:branch.outcomes,
      waivedBlockSlots:branch.outcomes.map((outcome) => (
        outcome === "tactic" && interpretDefenseJudgment("tactic").immune ? 1 : 0
      ))
    }));
  }

  /*
  功能
  结算闪电命中目标的伤害与延迟状态移除，并保持状态分支一致。

  调用方
  Simulator/Evaluator composition：推进一枚闪电在指定持有者命中的模拟世界。

  输入
  独立 World 与命中目标 ID。

  输出
  无返回值；闪电伤害和状态移除已结算。

  读取状态
  目标存活、闪电状态分支与伤害资源。

  写入状态
  目标伤害/濒死字段及闪电 statuses/概率分支。

  调用函数
  applyDamage、Probability 状态投影 辅助函数。

  边界与不变量
  只移除当前目标的闪电状态；命中伤害与状态清除顺序保持领域生命周期。
  */
  applyLightningHit(state, targetId) {
    const next = this.clone(state);
    const target = next.players.find((player) => player.id === targetId);
    if (!target?.alive) return next;
    // 真实结算在伤害前已消费命中的闪电；分支 after-state 也必须清除此状态，
    // 否则后续评估会把已经兑现的风险继续留在场上。
    if (Array.isArray(target.statuses)) {
      target.statuses = target.statuses.filter((statusId) => statusId !== "lightning");
    } else if (target.statuses) {
      delete target.statuses.lightning;
    }
    target.lightningStatusProbability = 0;
    this.applyDamage(next, null, target, CARD_DEFINITIONS.lightning.hitDamage, { canBlock: false });
    return next;
  }

  /*
  功能
  清除指定来源创建的全部追猎标记，避免死亡或失效来源继续触发。

  调用方
  Damage.resolveFatal 与追猎消费路径：让失效来源不再保留标记。

  输入
  World 与标记来源 ID。

  输出
  无返回值；所有玩家上该来源的追猎标记已清除。

  读取状态
  players 的来源绑定标记分支和摘要。

  写入状态
  huntMarkStateBranchesBySource、huntMarkProbabilities、huntMarkProbability、huntMarkSourceId 与 statuses。

  调用函数
  projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  只清除指定来源，不影响其他来源；确定摘要必须由剩余分支重新投影。
  */
  clearHuntMarksBySource(state, sourceId) {
    for (const player of state.players ?? []) {
      if (player.huntMarkProbabilities) delete player.huntMarkProbabilities[sourceId];
      const probabilities = Object.values(player.huntMarkProbabilities ?? {}).map(clampProbability);
      player.huntMarkProbability = probabilities.length ? Math.max(...probabilities) : 0;
      if (player.huntMarkSourceId === sourceId) player.huntMarkSourceId = null;
      if (Array.isArray(player.statuses) && player.huntMarkProbability <= PROBABILITY_EPSILON) {
        player.statuses = player.statuses.filter((status) => status !== "huntMark");
      }
    }
  }

  /*
  功能
  把闪电或封印卡牌的条件生效世界合并进目标延迟状态分支。

  调用方
  Simulator.applyCardEffect：在延迟牌已通过反制门控后写入状态。

  输入
  World、行动者、目标、statusId 与条件生效世界。

  输出
  无返回值；目标延迟状态分支和确定摘要已推进。

  读取状态
  目标已有 status 分支与本次 effectEventWorlds。

  写入状态
  对应 status 状态分支、存在概率与 statuses。

  调用函数
  intersectProbabilityStateBranches、projectProbabilityStateBranches、totalBranchProbability。

  边界与不变量
  闪电/封印状态只按同一效果世界加入；概率小于一时不得误写为确定状态。
  */
  applyDelayedStatusCard(state, actor, target, statusId, effectEventWorlds) {
    const holder = statusId === "lightning" ? actor : target;
    if (!holder?.alive || (statusId === "sealed" && holder.battleTeam === actor.battleTeam)) return;
    const oldBranches = statusId === "lightning"
      ? statusPresence(holder, "lightning").branches
      : statusPresence(holder, "sealed").branches;
    const joined = this.intersectProbabilityWork(
      [oldBranches, effectEventWorlds],
      `Simulator.applyDelayedStatusCard:${statusId}:join`
    );
    const projected = this.projectProbabilityWork(joined, (branch) => ({
      present: Boolean(branch.present || branch.occurs)
    }), `Simulator.applyDelayedStatusCard:${statusId}:project`);
    const probability = totalBranchProbability(projected.filter((branch) => branch.present));
    if (statusId === "lightning") {
      holder.lightningStatusProbability = probability;
    } else {
      holder.sealedStatusProbability = probability;
    }
    holder.statuses ??= [];
    if (probability >= 1 - PROBABILITY_EPSILON) {
      if (!holder.statuses.includes(statusId)) holder.statuses.push(statusId);
    } else {
      holder.statuses = holder.statuses.filter((status) => status !== statusId);
    }
  }
};

export class Simulator extends withStatusTransition(
  withSkillTransition(
    withActionTransition(
      withSimulatorOrchestration(withResource(withDamage(withResponse(SimulatorCore))))
    )
  )
) {}

/*
功能
计算一个已枚举战术 Action 在当前响应容量下的结算比例。

调用方
Searcher candidate evaluation 与直接模拟测试。

输入
canonical Action、World、行动者 ID 与负责响应 transition 的 Simulator。

输出
零到一的战术结算比例；非可反制战术为一。

读取状态
Action 卡牌定义、存活目标与 Simulator 已解析的响应概率。

写入状态
无。

调用函数
Simulator.targetResolutionChance、evaluateCardScopeCounterResponses。

边界与不变量
只读取已解析响应 World，不决定反制意愿；target scope 按存活目标等权平均，运算顺序保持冻结。
*/
export function tacticResolutionScale(action, state, actorId, simulator) {
  const card = CARD_DEFINITIONS[action.cardId] ?? null;
  if (card?.category !== "tactic" || card.counterable === false) return 1;
  const actor = state.players.find((entry) => entry.id === actorId);
  if (!actor) return 1;
  if (card.counterScope === "target") {
    const targetIds = new Set(action.targetIds ?? []);
    const aliveTargets = state.players.filter(
      (entry) => targetIds.has(entry.id) && entry.alive
    );
    if (!aliveTargets.length) return 0;
    const total = aliveTargets.reduce((sum, target) => (
      sum + simulator.targetResolutionChance(state, actor, card, target)
    ), 0);
    return total / aliveTargets.length;
  }
  const mappedTargets = (action.targetIds ?? [])
    .map((targetId) => state.players.find((entry) => entry.id === targetId))
    .filter(Boolean);
  return simulator.evaluateCardScopeCounterResponses(
    state,
    actor,
    card,
    mappedTargets
  ).resolutionChance;
}
