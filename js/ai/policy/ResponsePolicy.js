/*
模块职责
拥有合法响应窗口中的 block、counter、guardian aid、dying rescue、leverage 与状态反制选择。

上游
AIController、ResponseBoundary 正式边界 与 Simulator 的共享全体受益反制入口。

下游
value/CardValue 常量尺度和调用方注入的 Value/Domain/simulation query。

状态边界
只读 plain DecisionContext 与纯查询结果，不投影 State、不修改 GameState/World。

信息边界
只消费合法响应牌、公开玩家视图、合法记忆摘要和 Belief；不接收敌方未知手牌定义。

架构约束
不执行规则、不依赖 Planner/Controller/UI，不 import 或构造 具体 Simulator。
*/
import { getBaseCardAiValue } from "../value/CardValue.js";
import { cardAvailability } from "../value/CardValue.js";
import { HP_VALUE } from "../value/Economics.js";
import {
  hypergeometricProbabilityAtLeast,
  queryCurrentCardCounts,
  queryPlayerHandProbability
} from "../state/Probability.js";
import { getRecoverHealAmount } from "../../domain/rules/card/CardEffectRules.js";

/*
功能
返回所有响应入口共用且只计一次的反制牌机会成本。

调用方
ResponsePolicy、Simulator 与 GlobalBenefitValue 正式边界。

输入
无。

输出
冻结的 counter.aiValue × 0.35。

读取状态
CARD_DEFINITIONS.counter。

写入状态
无。

调用函数
无。

边界与不变量
这是既定的局部策略近似，只用于响应选择，不进入最终 Transition Value；STAY/FLIP 配对世界不得重复扣除。
*/
export function counterOpportunityCost() {
  return getBaseCardAiValue("counter") * 0.35;
}

/*
功能
根据全体受益 Domain/Value assessment 与反制链 parity 作出局部反制决策。

调用方
ResponsePolicy 与 GlobalBenefitValue 正式边界。

输入
显式 assessment 查询、公开玩家、响应者阵营、root 定义和链上下文。

输出
非全体受益牌返回 null；否则返回布尔决策。

读取状态
只读公开玩家、Belief counts 与 assessment 纯结果。

写入状态
无。

调用函数
assessGlobalBenefit、counterOpportunityCost。

边界与不变量
偶数 depth 表示 root 生效；首层队友非负收益保护与既有严格成本比较保持不变。
*/
export function globalBenefitCounterDecision(
  assessGlobalBenefit,
  players,
  battleTeam,
  definitionId,
  options = {}
) {
  const { rootSourceId = null, counterDepth = 0, remainingCardCounts = null } = options ?? {};
  const assessment = assessGlobalBenefit(
    players,
    battleTeam,
    definitionId,
    rootSourceId,
    remainingCardCounts
  );
  if (!assessment) return null;
  const resolvesAtStay = (counterDepth % 2) === 0;
  const stay = resolvesAtStay ? assessment.netBenefit : 0;
  const flip = resolvesAtStay ? 0 : assessment.netBenefit;
  if (counterDepth === 0 && rootSourceId) {
    const rootSource = (players ?? []).find((player) => player?.id === rootSourceId);
    if (rootSource?.battleTeam === battleTeam && (assessment.allyBenefit ?? 0) >= 0) {
      return false;
    }
  }
  return (flip - stay) > counterOpportunityCost();
}

/*
功能
用与真实响应相同的经济单位估算规划世界中取消一张 root 战术的收益。

调用方
ResponseSimulation 的 planning counter query 与直接 parity 测试。

输入
只读 World、响应者、施放者、root 卡牌、目标和可选资源选择。

输出
以现有 HP_VALUE、手牌、能量和状态尺度表示的非规格化收益。

读取状态
仅输入 World 的公开/概率摘要字段。

写入状态
无。

调用函数
无。

边界与不变量
这是既有规划策略的轻量近似；不得读取隐藏实体牌，不得改动 family、常量或分支顺序。
*/
export function planningDynamicCounterGain(
  state,
  responder,
  actor,
  card,
  targets,
  selection = null
) {
  const definitionId = card?.definitionId;
  if (!definitionId) return 0;
  const team = responder.battleTeam;
  const actorEnemy = actor?.battleTeam !== team;
  if (!actorEnemy) return 0;
  const target = (targets ?? []).find((entry) => entry?.id)
    ? state.players.find((player) => player.id === targets[0].id) : null;
  /*
  功能
  执行规划反制策略内部纯 辅助函数 hasResource。

  调用方
  planningDynamicCounterGain。

  输入
  只读公开 World player。

  输出
  布尔值。

  读取状态
  只读公开资源摘要或 knownCards。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不得读取未知手牌 definitionId 或修改 Simulation 状态。
  */
  const hasResource = (player) => Number(player?.handCount ?? 0) > 0
    || Boolean(player?.equipmentDefinitionId);
  /*
  功能
  执行规划反制策略内部纯 辅助函数 knownAssault。

  调用方
  planningDynamicCounterGain。

  输入
  只读公开 World player。

  输出
  布尔值。

  读取状态
  只读公开资源摘要或 knownCards。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不得读取未知手牌 definitionId 或修改 Simulation 状态。
  */
  const knownAssault = (player) => Array.isArray(player?.knownCards)
    && player.knownCards.some((entry) => entry.definitionId === "assault");

  switch (definitionId) {
    case "shockwave": {
      if (!target?.alive) return 0;
      const blockChance = queryPlayerHandProbability(
        state.probabilityState, target, "block"
      ).probability;
      return HP_VALUE * (1 - blockChance) * (Number(target.shield) >= 1 ? 0 : 1);
    }
    case "provoke": {
      if (!target?.alive) return 0;
      return queryPlayerHandProbability(
        state.probabilityState, target, "assault"
      ).probability > 0 ? 1.1 : HP_VALUE;
    }
    case "duel": {
      if (!target?.alive) return 0;
      return HP_VALUE * (queryPlayerHandProbability(
        state.probabilityState, target, "assault"
      ).probability > 0 ? 0.5 : 1);
    }
    case "scout": {
      if (!target?.alive) return 0;
      const knownCount = Array.isArray(target.knownCards)
        ? target.knownCards.reduce((sum, entry) => sum + cardAvailability(entry), 0)
        : 0;
      const unknownCount = Math.max(0, Number(target.handCount) - knownCount);
      const info = Math.min(2, unknownCount) * 0.35;
      return actorEnemy ? info : -info;
    }
    case "harvest": return actorEnemy ? 2 * 1.1 : -2 * 1.1;
    case "charge": return actorEnemy ? 1.2 : -1.2;
    case "exposeWeakness": return actorEnemy ? 1.5 : -1.5;
    case "plunder": {
      if (!target?.alive || !hasResource(target)) return 0;
      const threat = actorEnemy && knownAssault(target) ? HP_VALUE : 0;
      return actorEnemy ? 2.2 + threat : -(2.2 + threat);
    }
    case "destroy": {
      if (!target?.alive || !hasResource(target)) return 0;
      const threat = !actorEnemy && knownAssault(target) ? HP_VALUE : 0;
      return (target.battleTeam === team ? 1.1 + threat : 1.1) * (actorEnemy ? 1 : -1);
    }
    case "transfer": return actorEnemy ? 2.2 : -2.2;
    case "seal": return actorEnemy ? 2.8 : -2.8;
    case "lightning": return actorEnemy ? 2.8 : -2.8;
    case "leverage": {
      if (!target?.alive) return 0;
      return actorEnemy && target.equipmentDefinitionId ? 2 : -2;
    }
    default: return 0;
  }
}

/*
功能
在确定的规划世界中决定当前响应者是否打出反制。

调用方
ResponseSimulation 的 card-scope 与 target-scope 响应评估。

输入
World、响应上下文、全体受益 assessment、root guard 与动态收益查询。

输出
确定的 respond / do not respond 布尔值。

读取状态
输入状态的反制容量、阵营与 root 上下文。

写入状态
无。

调用函数
globalBenefitCounterDecision、counterOpportunityCost、dynamicCounterGain。

边界与不变量
先处理全体受益，再执行递归守卫和无容量短路；Policy 分数不得作为随机响应概率。
*/
export function planningCounterDecision(
  state,
  responder,
  actor,
  card,
  targets,
  selection,
  { assessGlobalBenefit, simulatingRootResolution = false, dynamicCounterGain }
) {
  const globalDecision = globalBenefitCounterDecision(
    assessGlobalBenefit,
    state.players,
    responder.battleTeam,
    card.definitionId,
    {
      rootSourceId:actor?.id ?? null,
      counterDepth:0,
      remainingCardCounts:queryCurrentCardCounts(state.probabilityState)
    }
  );
  if (globalDecision !== null) return globalDecision;
  if (simulatingRootResolution) return false;
  const hasCounter = queryPlayerHandProbability(
    state.probabilityState, responder, "counter"
  ).probability > 0;
  if (!hasCounter) return false;
  const gain = dynamicCounterGain(state, responder, actor, card, targets, selection);
  if (!Number.isFinite(gain)) return false;
  return gain > counterOpportunityCost();
}

export class ResponsePolicy {
  /*
  功能
  绑定响应策略所需的全体受益 assessment 查询。

  调用方
  AIController 组合根（统一组装依赖的位置） 与直接策略测试。

  输入
  assessGlobalBenefit 纯查询。

  输出
  可复用 ResponsePolicy 实例。

  读取状态
  保存显式查询依赖。

  写入状态
  写实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、State projector、Simulator、Planner 或 Controller。
  */
  constructor({ assessGlobalBenefit } = {}) {
    if (typeof assessGlobalBenefit !== "function") {
      throw new TypeError("ResponsePolicy 缺少依赖：assessGlobalBenefit");
    }
    this.assessGlobalBenefit = assessGlobalBenefit;
  }

  /*
  功能
  为搜索模拟提供一次确定的战术反制选择。

  调用方
  Worker/Main composition 注入给 Simulator 的 decideCounter capability。

  输入
  World、响应者、行动者、卡牌、目标、selection 与 root recursion guard。

  输出
  确定的 respond / do-not-respond 布尔值。

  读取状态
  公开 World、合法 Probability 与本实例 GlobalBenefit value query。

  写入状态
  无。

  调用函数
  planningCounterDecision、planningDynamicCounterGain。

  边界与不变量
  Policy 分数必须先在这里完成比较；Simulator 只能消费 boolean，不得把 heuristic 当概率。
  */
  decidePlanningCounter(
    state,
    responder,
    actor,
    card,
    targets,
    selection = null,
    { simulatingRootResolution = false } = {}
  ) {
    return planningCounterDecision(state, responder, actor, card, targets, selection, {
      assessGlobalBenefit:this.assessGlobalBenefit,
      simulatingRootResolution,
      dynamicCounterGain:planningDynamicCounterGain
    });
  }

  /*
  功能
  决定借势第一目标是否愿意把现有装备换成一次突袭。

  调用方
  Worker/Main composition 注入给 Simulator 的 decideLeverageAssault capability。

  输入
  World、第一目标与第二目标。

  输出
  确定的愿意/拒绝布尔值。

  读取状态
  第一目标装备价值、突袭容量、第二目标格挡概率与敌友关系。

  写入状态
  无。

  调用函数
  getBaseCardAiValue、queryPlayerHandProbability。

  边界与不变量
  保留原 heuristic 的全部输入和 0.5 决策阈值；返回值不是自然概率，Simulator 另行处理突袭可用 Belief。
  */
  decideLeverageAssault(state, first, second) {
    const firstAssault = queryPlayerHandProbability(
      state.probabilityState,
      first,
      "assault"
    );
    const secondBlock = queryPlayerHandProbability(
      state.probabilityState,
      second,
      "block"
    );
    const equipmentValue = getBaseCardAiValue(first.equipmentDefinitionId);
    const friendlyFirePenalty = second.battleTeam === first.battleTeam ? 0.55 : 0;
    const defenseRisk = Math.min(0.9, secondBlock.probability);
    const targetValue = second.battleTeam === first.battleTeam
      ? -0.35 - (second.hp <= 2 ? 0.15 : 0)
      : 0.3 + (second.hp <= 2 ? 0.15 : 0);
    const conserveAssaultPenalty = firstAssault.expected <= 0.75 ? 0.18 : 0;
    const willingness = 0.42 + equipmentValue * 0.04 + targetValue
      - friendlyFirePenalty - defenseRisk * 0.2 - conserveAssaultPenalty;
    return willingness >= 0.5;
  }

  /*
  功能
  评估一次己方濒死救援的资源与后续救援价值。

  调用方
  shouldRespond 与直接策略测试。

  输入
  已过滤的 responder/target、救援顺序、自己手牌定义、合法记忆、recover density 和剩余牌计数。

  输出
  冻结字段的救援容量、成功概率与期望价值 assessment object。

  读取状态
  只读 DecisionContext 公开/合法信息。

  写入状态
  无。

  调用函数
  hypergeometricProbabilityAtLeast、getBaseCardAiValue、getRecoverHealAmount。

  边界与不变量
  后续未知手牌只按公开 handCount、合法记忆与 Remaining Knowledge 无放回计数估算；
  guaranteed impossible 保持硬拒绝，strategic 只提高存活价值。
  */
  assessDyingRescue({
    responder,
    target,
    rescueOrder,
    responderHandDefinitionIds,
    knownCardsByPlayer,
    recoverDensity,
    remainingCardCounts
  }) {
    const need = Math.max(1, 1 - target.hp);
    const recoverHealAmount = getRecoverHealAmount();
    const ownRecover = responderHandDefinitionIds
      .filter((definitionId) => definitionId === "recover").length;
    const knownRecoverCapacity = rescueOrder.reduce((sum, player) => {
      if (player.id === responder.id) return sum + ownRecover;
      const known = knownCardsByPlayer[player.id] ?? {};
      return sum + Object.values(known)
        .filter((definitionId) => definitionId === "recover").length;
    }, 0);
    const unknownRecoverSlots = rescueOrder.reduce((sum, player) => {
      if (player.id === responder.id) return sum;
      const known = knownCardsByPlayer[player.id] ?? {};
      return sum + Math.max(0, player.handCount - Object.keys(known).length);
    }, 0);
    const remainingRecoverCount = Number(remainingCardCounts?.recover);
    const unknownRecoverCapacity = Number.isFinite(remainingRecoverCount)
      ? Math.min(unknownRecoverSlots, Math.max(0, remainingRecoverCount))
      : unknownRecoverSlots;
    const knownFeasibleRecovery = knownRecoverCapacity * recoverHealAmount;
    const maximumFeasibleRecovery = (
      knownRecoverCapacity + unknownRecoverCapacity
    ) * recoverHealAmount;
    const guaranteedImpossible = maximumFeasibleRecovery < need;
    const guaranteedSurvivable = knownFeasibleRecovery >= need;
    const requiredRecoverCount = Math.ceil(need / recoverHealAmount);
    const unknownRecoveryRequired = Math.max(0, requiredRecoverCount - knownRecoverCapacity);
    const remainingPopulation = Object.values(remainingCardCounts ?? {}).reduce(
      (sum, count) => sum + (Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0),
      0
    );
    const rescueSuccessProbability = guaranteedImpossible || remainingPopulation <= 0
      ? 0
      : hypergeometricProbabilityAtLeast(
          remainingPopulation,
          Math.max(0, remainingRecoverCount),
          unknownRecoverSlots,
          unknownRecoveryRequired
        );
    const expectedUnknownRecover = remainingPopulation > 0
      ? unknownRecoverSlots * Math.max(0, remainingRecoverCount) / remainingPopulation
      : 0;
    const futureExpectedRecover = Math.max(0, knownRecoverCapacity - 1)
      + expectedUnknownRecover;
    const remainingAfterThisCard = Math.max(0, need - recoverHealAmount);
    const aliveTeam = rescueOrder.filter(
      (player) => player.alive && player.battleTeam === target.battleTeam
    );
    const strategic = (target.roleTags ?? []).some(
      (tag) => ["support", "healer", "damage", "control", "tank"].includes(tag)
    );
    const actionValue = target.handCount * 1.25
      + target.energy * 1.1
      + (target.hasEquipment ? 2 : 0)
      + (strategic ? 3 : 0);
    const immediateDefeatRisk = aliveTeam.length <= 2;
    const lastRecoverPenalty = ownRecover === 1 ? (responder.hp <= 2 ? 3 : 1.5) : 0;
    const survivalValue = HP_VALUE + actionValue + (immediateDefeatRisk ? 8 : 0);
    // Policy 沿用现有响应资源的 35% 静态保留尺度；最后一张调息的自保价值只计入机会成本。
    const recoverOpportunityCost = getBaseCardAiValue("recover") * 0.35 + lastRecoverPenalty;
    const expectedRescueValue = rescueSuccessProbability * survivalValue
      - recoverOpportunityCost;
    return {
      need,
      ownRecover,
      recoverDensity,
      futureExpectedRecover,
      knownFeasibleRecovery,
      maximumFeasibleRecovery,
      unknownRecoverCapacity,
      unknownRecoveryRequired,
      guaranteedImpossible,
      guaranteedSurvivable,
      rescueSuccessProbability,
      remainingAfterThisCard,
      strategic,
      immediateDefeatRisk,
      actionValue,
      survivalValue,
      recoverOpportunityCost,
      expectedRescueValue,
      score:expectedRescueValue
    };
  }

  /*
  功能
  从公开突袭上下文读取当前确定的角色加伤预览。

  调用方
  shouldRespond 的 block 分支。

  输入
  已过滤 source 和公开 card。

  输出
  非负已知加伤。

  读取状态
  source passive IDs、momentum 与 allIn assaultBonus。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不触发 beforeDamage 或任何真实监听器。
  */
  knownPendingAssaultBonus(context) {
    const source = context.source;
    if (!source?.alive || context.card?.definitionId !== "assault") return 0;
    let bonus = 0;
    if ((source.passiveSkillIds ?? []).includes("momentum")) {
      bonus += Math.max(0, Number(source.momentum) || 0);
    }
    if ((source.passiveSkillIds ?? []).includes("gamble")) {
      bonus += Math.max(0, Number(source.assaultBonus) || 0);
    }
    return bonus;
  }

  /*
  功能
  判断一次合法响应窗口是否应使用给定响应资源。

  调用方
  ResponseBoundary 正式边界 与直接策略测试。

  输入
  plain DecisionContext，含 responseType、公开玩家、合法 Cards、Belief 与窄查询。

  输出
  是否响应的布尔值。

  读取状态
  只读 DecisionContext 和惰性纯查询结果。

  写入状态
  无；查询只操作独立 World clone。

  调用函数
  assessDyingRescue、knownPendingAssaultBonus、状态/guardian/dynamic query。

  边界与不变量
  Policy 不投影 State、不构造 Simulator；确定必败硬拒绝，自救与强制真人救援保留固定策略，
  其余救援只在连续期望价值严格为正时响应。
  */
  shouldRespond(decision) {
    const {
      responder,
      responseType: type,
      context,
      cards = [],
      players,
      rescueOrder,
      responderHandDefinitionIds,
      knownCardsByPlayer,
      recoverDensity,
      remainingCardCounts,
      isSmallTeam,
      forceAiRescueHuman,
      leverageMetrics,
      guardianAidValues,
      lightningCounterTerms,
      sealCounterTerms,
      dynamicRootFlipGain
    } = decision;
    const target = context.target ?? responder;
    if (type === "dyingRescue") {
      if (target.battleTeam !== responder.battleTeam) return false;
      const assessment = this.assessDyingRescue({
        responder,
        target,
        rescueOrder,
        responderHandDefinitionIds,
        knownCardsByPlayer,
        recoverDensity,
        remainingCardCounts
      });
      if (!assessment.ownRecover) return false;
      // 这是由公开座次、合法记忆、手牌槽位和剩余牌池共同给出的容量上界；
      // 只有即使所有未知槽位都恰为调息仍不足时，才可确定本次救援必败。
      if (assessment.guaranteedImpossible) return false;
      if (target.id === responder.id) return true;
      if (
        forceAiRescueHuman
        && responder.controllerType === "ai"
        && target.controllerType === "human"
      ) return true;
      return assessment.expectedRescueValue > 0;
    }
    if (type === "block") {
      const incoming = Math.max(0, Number(context.amount ?? 1) || 0)
        + this.knownPendingAssaultBonus(context);
      const lethal = incoming - target.shield >= target.hp;
      const availableBlocks = cards.length;
      const requiredBlocks = Math.max(1, context.requiredCount ?? 1);
      if (availableBlocks < requiredBlocks) return false;
      const lowHp = target.hp <= 2;
      const blocksAreAbundant = availableBlocks * 2 >= responder.handCount;
      if (isSmallTeam) return true;
      return lethal || lowHp || blocksAreAbundant;
    }
    if (type === "counter") {
      if (context.statusCounterContext) {
        return context.statusCounterContext.statusId === "sealed"
          ? this.shouldCounterSeal(sealCounterTerms())
          : this.shouldCounterLightning(lightningCounterTerms());
      }
      const rootId = context.rootCard?.definitionId ?? context.card?.definitionId;
      const rootSourceId = context.rootSourceId
        ?? context.rootSource?.id
        ?? context.source?.id
        ?? null;
      const globalDecision = globalBenefitCounterDecision(
        this.assessGlobalBenefit,
        players,
        responder.battleTeam,
        rootId,
        {
          rootSourceId,
          counterDepth: context.counterDepth ?? 0,
          remainingCardCounts
        }
      );
      if (globalDecision !== null) return globalDecision;
      if (rootId === "counter") {
        const sourceEnemy = context.source?.battleTeam !== responder.battleTeam;
        return sourceEnemy && context.card?.definitionId
          ? getBaseCardAiValue(context.card.definitionId) >= 7
          : false;
      }
      const gain = dynamicRootFlipGain();
      return gain !== null && gain > counterOpportunityCost();
    }
    if (type === "assaultDiscard") {
      if (context.card?.definitionId === "provoke") {
        return responder.hp <= 2 || responder.handCount > 2;
      }
      if (context.card?.definitionId === "duel") return true;
      const assaultCount = responderHandDefinitionIds
        .filter((definitionId) => definitionId === "assault").length;
      return responder.hp <= 2 || assaultCount > 1;
    }
    if (type === "leverageAssault") {
      if (!cards.length || !target?.alive) return false;
      const metrics = leverageMetrics();
      const enemyTarget = target.battleTeam !== responder.battleTeam;
      const attackBenefit = enemyTarget
        ? 4
          + metrics.threat
          + Math.max(0, target.maxHp - target.hp) * 1.5
          + (target.hp <= 1 ? 5 : 0)
        : -10;
      const equipmentValue = context.equipment?.definitionId
        ? getBaseCardAiValue(context.equipment.definitionId)
        : 5;
      const assaultCost = cards.length <= 1 ? 4.5 : 2.5;
      const score = attackBenefit
        + equipmentValue * 1.05
        - assaultCost
        - metrics.blockRisk * 2.5;
      return score > 0;
    }
    if (type === "skill") return this.shouldUseGuardianAid(decision, guardianAidValues);
    return false;
  }

  /*
  功能
  比较护援 STAY/AID 配对世界和唯一额度的未来机会成本。

  调用方
  shouldRespond 的 skill 分支。

  输入
  公开合法上下文和注入的 guardianAidValues 窄查询。

  输出
  AID 严格更优时为 true。

  读取状态
  公开响应者/目标字段与纯数值 query result。

  写入状态
  无。

  调用函数
  guardianAidValues。

  边界与不变量
  硬守卫与真实技能一致；Policy 不接触模拟状态，严格比较和 HP_VALUE 尺度不变。
  */
  shouldUseGuardianAid(decision, guardianAidValues) {
    const { responder, context } = decision;
    const target = context.target;
    if (!responder?.alive || !target?.alive || responder.id === target.id) return false;
    if (responder.battleTeam !== target.battleTeam) return false;
    if (!responder.handCount) return false;
    const amount = Math.max(0, Number(context.amount) || 0);
    if (amount <= 0) return false;
    if (responder.guardianAidUsed) return false;
    const { stayValue, aidValue, futureInventory } = guardianAidValues();
    const quotaFutureValue = Math.min(HP_VALUE, futureInventory);
    return (aidValue - stayValue) > quotaFutureValue;
  }

  /*
  功能
  根据 Lightning Domain 与 Value query 的纯结果判断是否反制状态。

  调用方
  shouldRespond 的 lightning status counter 分支。

  输入
  `{valid, noCounterBurden, withCounterBurden}`。

  输出
  转移后负担加成本严格低于不反制负担时为 true。

  读取状态
  只读纯数值 Domain/Value 结果。

  写入状态
  无。

  调用函数
  counterOpportunityCost。

  边界与不变量
  不建传播分布、不修改 holder，反制成本只计一次。
  */
  shouldCounterLightning({ valid, noCounterBurden, withCounterBurden }) {
    if (!valid) return false;
    return withCounterBurden + counterOpportunityCost() < noCounterBurden;
  }

  /*
  功能
  根据 Seal Domain/Policy 纯结果判断是否反制状态。

  调用方
  shouldRespond 的 sealed status counter 分支。

  输入
  `{valid, preventedBurden}`。

  输出
  己方有效封印负担严格超过反制成本时为 true。

  读取状态
  只读纯数值 Domain/Policy 结果。

  写入状态
  无。

  调用函数
  counterOpportunityCost。

  边界与不变量
  不计算判定池或状态生命周期；这些由调用方 Domain query 提供。
  */
  shouldCounterSeal({ valid, preventedBurden }) {
    return valid && preventedBurden > counterOpportunityCost();
  }
}
