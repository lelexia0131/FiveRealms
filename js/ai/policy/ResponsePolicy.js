/*
模块职责
拥有合法响应窗口中的 block、counter、guardian aid、dying rescue、leverage 与状态反制选择。

上游
AIController、ResponseBoundary 正式边界 与 Simulator 的共享全体受益反制入口。

下游
value/CardValue 常量尺度和调用方注入的 Value/Domain/simulation query。

状态边界
只读 plain DecisionContext 与纯查询结果，不投影 State、不修改 GameState/SearchState。

信息边界
只消费合法响应牌、公开玩家视图、合法记忆摘要和 Belief；不接收敌方未知手牌定义。

架构约束
不执行规则、不依赖 Planner/Controller/UI，不 import 或构造 具体 Simulator。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260814-ai-code-hygiene-final";
import { HP_VALUE } from "../value/Economics.js?build=20260814-ai-code-hygiene-final";

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
  return (CARD_DEFINITIONS.counter.aiValue ?? 8) * 0.35;
}

/*
功能
根据全体受益 Domain/Value assessment 与反制链 parity 决定局部反制意愿。

调用方
ResponsePolicy 与 GlobalBenefitValue 正式边界。

输入
显式 assessment 查询、公开玩家、响应者阵营、root 定义和链上下文。

输出
非全体受益牌返回 null；否则返回零或一。

读取状态
只读公开玩家、Belief counts 与 assessment 纯结果。

写入状态
无。

调用函数
assessGlobalBenefit、counterOpportunityCost。

边界与不变量
偶数 depth 表示 root 生效；首层队友非负收益保护与既有严格成本比较保持不变。
*/
export function globalBenefitCounterDesire(
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
      return 0;
    }
  }
  return (flip - stay) > counterOpportunityCost() ? 1 : 0;
}

/*
功能
用与真实响应相同的经济单位估算规划世界中取消一张 root 战术的收益。

调用方
ResponseSimulation 的 planning counter query 与直接 parity 测试。

输入
只读 SearchState、响应者、施放者、root 卡牌、目标和可选资源选择。

输出
以现有 HP_VALUE、手牌、能量和状态尺度表示的非规格化收益。

读取状态
仅输入 SearchState 的公开/概率摘要字段。

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
  只读公开 SearchState player。

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
  只读公开 SearchState player。

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
      const blockChance = Math.min(1, Number(target.blockProbability) || 0);
      return HP_VALUE * (1 - blockChance) * (Number(target.shield) >= 1 ? 0 : 1);
    }
    case "provoke": {
      if (!target?.alive) return 0;
      return (Number(target.assaultResponseProbability) || 0) > 0 ? 1.1 : HP_VALUE;
    }
    case "duel": {
      if (!target?.alive) return 0;
      return HP_VALUE * ((Number(target.assaultResponseProbability) || 0) > 0 ? 0.5 : 1);
    }
    case "scout": {
      if (!target?.alive) return 0;
      const knownCount = Array.isArray(target.knownCards) ? target.knownCards.length : 0;
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
把规划世界的 root 效果收益映射为当前响应者的反制意愿。

调用方
ResponseSimulation 的 card-scope 与 target-scope 响应评估。

输入
SearchState、响应上下文、全体受益 assessment、root guard 与动态收益查询。

输出
零到一之间的反制意愿。

读取状态
输入状态的反制容量、阵营与 root 上下文。

写入状态
无。

调用函数
globalBenefitCounterDesire、counterOpportunityCost、dynamicCounterGain。

边界与不变量
先处理全体受益，再执行递归守卫和无容量短路；映射顺序与严格成本尺度保持不变。
*/
export function planningCounterDesire(
  state,
  responder,
  actor,
  card,
  targets,
  selection,
  { assessGlobalBenefit, simulatingRootResolution = false, dynamicCounterGain }
) {
  const globalDesire = globalBenefitCounterDesire(
    assessGlobalBenefit,
    state.players,
    responder.battleTeam,
    card.definitionId,
    {
      rootSourceId:actor?.id ?? null,
      counterDepth:0,
      remainingCardCounts:state?.remainingCardCounts ?? null
    }
  );
  if (globalDesire !== null) return globalDesire;
  if (simulatingRootResolution) return 0;
  const hasCounter = (responder.counterCountDistribution ?? [])
    .some((branch) => (branch.counterCount ?? 0) >= 1 && (branch.probability ?? 0) > 0)
    || (responder.counterProbability ?? 0) > 0;
  if (!hasCounter) return 0;
  const gain = dynamicCounterGain(state, responder, actor, card, targets, selection);
  if (!Number.isFinite(gain)) return 0;
  return Math.max(0, Math.min(1, (Number(gain) || 0) / counterOpportunityCost()));
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
  评估一次己方濒死救援的资源与后续救援价值。

  调用方
  shouldRespond 与直接策略测试。

  输入
  已过滤的 responder/target、救援顺序、自己手牌定义、合法记忆和 recover density。

  输出
  冻结字段的救援 assessment object。

  读取状态
  只读 DecisionContext 公开/合法信息。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  后续未知手牌只按公开 handCount 与统一 recover density 估算。
  */
  assessDyingRescue({
    responder,
    target,
    rescueOrder,
    responderHandDefinitionIds,
    knownCardsByPlayer,
    recoverDensity
  }) {
    const need = Math.max(1, 1 - target.hp);
    const ownRecover = responderHandDefinitionIds
      .filter((definitionId) => definitionId === "recover").length;
    const responderIndex = rescueOrder.findIndex((player) => player.id === responder.id);
    const later = responderIndex < 0 ? [] : rescueOrder.slice(responderIndex + 1);
    const futureExpectedRecover = later.reduce((sum, player) => {
      const known = knownCardsByPlayer[player.id] ?? {};
      const knownRecover = Object.values(known)
        .filter((definitionId) => definitionId === "recover").length;
      const unknownCards = Math.max(0, player.handCount - Object.keys(known).length);
      return sum + knownRecover + unknownCards * recoverDensity;
    }, 0);
    const remainingAfterThisCard = Math.max(0, need - 1);
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
    const likelyFollowUp = futureExpectedRecover > 0;
    const lastRecoverPenalty = ownRecover === 1 ? (responder.hp <= 2 ? 3 : 1.5) : 0;
    const score = 3 + actionValue
      + (immediateDefeatRisk ? 8 : 0)
      + (likelyFollowUp ? 4 : 0)
      + (ownRecover > 1 ? 3 : 0)
      - lastRecoverPenalty
      - remainingAfterThisCard;
    return {
      need,
      ownRecover,
      recoverDensity,
      futureExpectedRecover,
      remainingAfterThisCard,
      strategic,
      immediateDefeatRisk,
      likelyFollowUp,
      actionValue,
      score
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
  无；查询只操作独立 SearchState clone。

  调用函数
  assessDyingRescue、knownPendingAssaultBonus、状态/guardian/dynamic query。

  边界与不变量
  Policy 不投影 State、不构造 Simulator；所有阈值、严格比较和分支顺序保持冻结。
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
      if (target.id === responder.id) return true;
      if (target.battleTeam !== responder.battleTeam) return false;
      if (
        forceAiRescueHuman
        && responder.controllerType === "ai"
        && target.controllerType === "human"
      ) return true;
      const assessment = this.assessDyingRescue({
        responder,
        target,
        rescueOrder,
        responderHandDefinitionIds,
        knownCardsByPlayer,
        recoverDensity
      });
      if (!assessment.ownRecover) return false;
      return assessment.immediateDefeatRisk
        || assessment.likelyFollowUp
        || assessment.strategic
        || assessment.ownRecover > 1
        || assessment.score > 0;
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
      const globalDesire = globalBenefitCounterDesire(
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
      if (globalDesire !== null) return globalDesire > 0;
      if (rootId === "counter") {
        const sourceEnemy = context.source?.battleTeam !== responder.battleTeam;
        return sourceEnemy ? (context.card?.aiValue ?? 0) >= 7 : false;
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
      const equipmentValue = Number(context.equipment?.aiValue ?? 5);
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
