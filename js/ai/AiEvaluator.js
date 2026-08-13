/**
 * AI 团队效用评估器。只读取公开或过滤后的字段并返回分数，不生成、执行动作，
 * 不写 GameState；权重修改会影响阵营平衡，之后必须重跑 200 局模拟。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260813-ai-hotpath-reuse";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260813-ai-hotpath-reuse";
import { buildRadarJudgmentProbabilities } from "./AiProbabilityBranches.js?build=20260813-ai-hotpath-reuse";
import { ThreatCalculator } from "./ThreatCalculator.js?build=20260813-ai-hotpath-reuse";
import { assessGlobalBenefit } from "./AiGlobalBenefit.js?build=20260813-ai-hotpath-reuse";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260813-ai-hotpath-reuse";
import { getBaseCardAiValue, getEquipmentKeepValueDeduction, getRoleCardAiValue } from "./roleCardValue.js?build=20260813-ai-hotpath-reuse";
import { buildLightningHitDistribution, lightningPresenceProbability } from "./lightningScoring.js?build=20260813-ai-hotpath-reuse";
import { AiSimulator } from "./AiSimulator.js?build=20260813-ai-hotpath-reuse";
import { HP_VALUE, STATE_DELTA_SCALE } from "./AiEconomics.js?build=20260813-ai-hotpath-reuse";
import {
  sealTeamBurden, sealUseValue
} from "./sealScoring.js?build=20260813-ai-hotpath-reuse";

/** stateUtility 中每点能量的单位价值；充能桩未来有效能量复用同一语义，不另设常数。 */
const ENERGY_STATE_WEIGHT = 1.2;
/** 额外 1 点能量跨过主动技能成本门槛时的选择权价值；与聚能现有启发式保持一致。 */
const SKILL_THRESHOLD_OPTION_VALUE = 4;
/** 焚场的临时 beam 排序信用：只服务当前层 pruning/ranking，不进入真实累计价值。 */
const BURNING_FIELD_SEARCH_PRIOR = 8;
/**
 * stateDelta 进入最终 candidate value 的既有缩放（transitionScore 中的 ×0.08）。
 * 响应价值与前沿未实现价值复用同一缩放，保证已实现/响应/前沿三类价值在同一尺度上
 * 互斥计价——不引入新的独立权重，避免"同一价值在不同入口用不同权重"的双算。
 */
export { HP_VALUE, STATE_DELTA_SCALE };
/** stateUtility 与 shieldStateValue 共用：HP<=1 danger 阈值惩罚。 */
const DANGER_VALUE = 7;
/** stateUtility 与 shieldStateValue 共用：阵亡惩罚。 */
const DEATH_VALUE = 28;
/** 通用 shield state value：第 1 点盾的基础储备（stored defense）权重。 */
const SHIELD_RESERVE_WEIGHT = 2;
/** 通用 shield state value：残余威胁容量的保护实现权重（保守；exposure 是威胁 proxy 而非确定伤害）。 */
const SHIELD_PROTECTION_WEIGHT = 0.5;

export class AiEvaluator {
  constructor(game) {
    this.game = game;
    this.lightningLifecycleCache = new WeakMap();
  }

  /** 角色对某张卡牌相对全局基础值的差量；缺少 generalId 或 definitionId 时回退 0。 */
  roleCardDelta(generalId, definitionId) {
    if (!generalId || !definitionId) return 0;
    return getRoleCardAiValue(generalId, definitionId) - getBaseCardAiValue(definitionId);
  }

  /** 具体手牌的剩余可用概率：优先读取 availabilityStateBranches，其次 availabilityBranches。 */
  cardAvailability(card) {
    const stateBranches = Array.isArray(card?.availabilityStateBranches)
      ? card.availabilityStateBranches
      : null;
    if (stateBranches) {
      return stateBranches
        .filter((branch) => branch.available)
        .reduce((sum, branch) => sum + (Number(branch.probability) || 0), 0);
    }
    if (Array.isArray(card?.availabilityBranches)) {
      return card.availabilityBranches.reduce((sum, branch) => sum + (Number(branch.probability) || 0), 0);
    }
    return 1;
  }

  breakArmyUtility(actor) {
    const assaultCount = (actor.hand ?? []).filter((card) => card.definitionId === "assault")
      .reduce((sum, card) => sum + (Array.isArray(card.availabilityBranches)
        ? card.availabilityBranches.reduce((total, branch) => total + (Number(branch.probability) || 0), 0)
        : 1), 0);
    const availableAttackUses = Array.isArray(actor.attackUseSlots)
      ? actor.attackUseSlots.reduce((sum, slot) => sum + (slot ?? []).reduce((total, branch) => (
          total + (branch.available ? Number(branch.probability) || 0 : 0)
        ), 0), 0)
      : Math.max(0, (Number(actor.attackLimit ?? actor.turnFlags?.attackLimit) || 0)
        - (Number(actor.attackUsed ?? actor.turnFlags?.attackUsed) || 0));
    return assaultCount > availableAttackUses + Number.EPSILON ? 8 : -4;
  }

  threatPriority(viewer, target, memory, expectedDamage = 1) {
    const multiplier = Math.max(0, Number(this.game.aiDifficultyMultiplier ?? GAME_CONFIG.aiDifficultyMultiplier) || 0);
    if (!multiplier || !target || target.battleTeam === viewer.battleTeam) return 0;
    return ThreatCalculator.calculate(viewer, target, memory, expectedDamage) * 0.12 * multiplier;
  }

  /**
   * 敌方攻击暴露的语义分解。
   *
   * 把原 incomingExposure 混合标量拆成三个可独立归属的威胁分量，任何分量的
   * 汇总恒等于 incomingExposure 总值（保持 stateUtility 既有数值不变）：
   *
   *   currentThreat   当前已经形成 / imminent 的威胁：敌方以 assaultResponseProbability
   *                   持有至少一张突袭（概率加权，此刻即可发动）。
   *   futureInventory 尚未执行的 future hostile action inventory：额外突袭牌构成
   *                   跨回合未来攻击压力。
   *   energyPressure  能量折算的未来攻击资源（未来回合可转化为攻击）。
   *
   * 三者与雷达/shield 等 mitigation 分属不同 representation：threat 与 mitigation
   * 不再在同一不可解释标量中相互抵消。只读公开/模拟合法字段，不读取隐藏手牌身份。
   */
  exposureComponents(state, player) {
    const perEnemy = [];
    let currentThreat = 0;
    let futureInventory = 0;
    let energyPressure = 0;
    for (const enemy of state.players) {
      if (!enemy?.alive || enemy.battleTeam === player.battleTeam || enemy.id === player.id) continue;
      const rangeProbability = DistanceSystem.getRangeLegalityProbability(
        { state }, enemy, player, enemy.attackRange ?? 1
      );
      if (rangeProbability <= 0) continue;
      const energy = Math.max(0, Number(enemy.energy ?? 0));
      // 攻击资源用 assault summary（己方=真实可见手牌，他人=已知身份+剩余牌池密度估计），
      // 不再把 raw handCount 当作攻击牌 proxy：打出非攻击牌不应无条件降低攻击 pressure。
      const expectedAssault = Math.max(0, Number(enemy.expectedAssaultCount ?? 0));
      const response = Math.max(0, Math.min(1, Number(enemy.assaultResponseProbability) || 0));
      // 威胁强度：基准1点突袭(以概率持有) + 突袭期望 + 能量折算的潜在攻击资源，再按 hp=5 权重换算。
      // 不做次数截断：expectedAssaultCount 已是有界的具体突袭数量，多张突袭代表跨回合的持续威胁；
      // 单回合剩余次数由 Simulator 的 attackUseSlots 消费处理，不在此重复计价。
      const current = response * HP_VALUE * rangeProbability;
      const future = Math.min(3, expectedAssault) * 0.5 * HP_VALUE * rangeProbability;
      const energyTerm = Math.min(2, energy) * 0.3 * HP_VALUE * rangeProbability;
      currentThreat += current;
      futureInventory += future;
      energyPressure += energyTerm;
      perEnemy.push({
        enemyId: enemy.id,
        rangeProbability,
        currentThreat: current,
        futureInventory: future,
        energyPressure: energyTerm
      });
    }
    return { currentThreat, futureInventory, energyPressure, perEnemy };
  }

  /** 敌方攻击暴露：三个已分解威胁分量的汇总；只读公开/模拟合法字段，不读取隐藏手牌身份。 */
  incomingExposure(state, player) {
    const { currentThreat, futureInventory, energyPressure } = this.exposureComponents(state, player);
    return currentThreat + futureInventory + energyPressure;
  }

  /**
   * 单个玩家的 stateUtility 未签名字项（stateUtility 与 owner ledger 的共同来源）。
   *
   * 抽取理由：ownerStateTerms 与 stateUtility 此前逐行镜像，会形成两个价值世界——
   * 修改某个 primitive 时忘记同步另一处，就会出现"全局投影 == stateDelta"恒等式
   * 被破坏却难以定位的维护风险。本方法返回该玩家自身的未签名分项（不含团队 sign、
   * 不含 lightning/seal burden），stateUtility 在求和时施加 sign 与 burden，
   * owner ledger 直接消费同一份 terms。
   *
   * 威胁按 currentThreat / futureInventory / energyPressure 三分量记账（均为负值），
   * 三者之和恒等于 -incomingExposure；因此 stateUtility 的单标量 -exposure 与
   * owner ledger 的威胁分项在代数上完全一致，不因表示差异产生数值漂移。
   *
   * handRole 与既有语义一致：只有 viewer 自己的手牌可被身份评分，因此该子项
   * 只归属 viewer 自身的 entry（当前模型"只能对自己手牌身份估值"的忠实保留）。
   */
  playerValueTerms(state, player, viewerId, radarTacticProbability) {
    if (!player.alive) return { death: -DEATH_VALUE, terms: {} };
    const danger = player.hp <= 1 ? -DANGER_VALUE : 0;
    const rescueOutlook = player.survivalChance === undefined ? 0 : (player.survivalChance - 0.5) * 8;
    const equipmentValue = player.equipmentDefinitionId ? (CARD_DEFINITIONS[player.equipmentDefinitionId]?.aiValue ?? 7) : 0;
    const initialEquipmentValue = player.initialEquipmentValue ?? equipmentValue;
    const equipmentDelta = (equipmentValue * (player.equipmentRetentionProbability ?? (equipmentValue ? 1 : 0))
      - initialEquipmentValue + (player.expectedEquipmentGain ?? 0)) * 0.25;
    const currentEquipmentRoleDelta = player.equipmentDefinitionId
      ? this.roleCardDelta(player.generalId, player.equipmentDefinitionId) : 0;
    const initialEquipmentRoleDelta = Number.isFinite(player.initialEquipmentRoleDelta)
      ? player.initialEquipmentRoleDelta : currentEquipmentRoleDelta;
    const equipmentRoleDelta = (currentEquipmentRoleDelta
        * (player.equipmentRetentionProbability ?? (currentEquipmentRoleDelta ? 1 : 0))
      - initialEquipmentRoleDelta + (player.expectedEquipmentRoleDelta ?? 0)) * 0.25;
    const handRoleDelta = player.id === viewerId
      ? (player.hand ?? []).reduce((sum, card) => (
          sum + this.roleCardDelta(player.generalId, card?.definitionId) * this.cardAvailability(card)
        ), 0)
      : 0;
    const markThreat = Object.entries(player.huntMarkProbabilities ?? {}).reduce((sum, [sourceId, probability]) => {
      const source = state.players.find((entry) => entry.id === sourceId);
      return sum + (source?.battleTeam !== player.battleTeam ? Number(probability) || 0 : 0);
    }, 0);
    const { currentThreat, futureInventory, energyPressure } = this.exposureComponents(state, player);
    const exposure = currentThreat + futureInventory + energyPressure;
    const radarMitigation = this.radarMitigationUtility(exposure, player, radarTacticProbability);
    const residualExposure = Math.max(0, exposure - radarMitigation);
    const shield = this.shieldStateValue(player, residualExposure);
    const energyDeviceFuture = this.energyDeviceFutureUtility(player);
    return {
      death: 0,
      terms: {
        danger,
        rescueOutlook,
        hp: player.hp * HP_VALUE,
        shield,
        // energy 对缺失字段回退 0：真实可见状态始终带 energy，此处防御不完整测试状态。
        energy: Math.max(0, Number(player.energy) || 0) * ENERGY_STATE_WEIGHT,
        handCount: player.handCount * 1.1,
        handRole: handRoleDelta,
        stacks: (player.exposeWeaknessStacks ?? 0) * 1.5,
        equipmentDelta,
        equipmentRoleDelta,
        info: (player.expectedInformationGain ?? 0) * .35,
        markThreat: -markThreat * 1.5,
        // 威胁三分量之和 == -exposure，保证 owner ledger 总值与 stateUtility 完全一致
        currentThreat: -currentThreat,
        futureInventory: -futureInventory,
        energyPressure: -energyPressure,
        radar: radarMitigation,
        energyDeviceFuture,
        // 互利选牌期望价值：互利按真实座位顺序从预期剩余牌池选牌，先手取高价值、后手
        // 只能选剩余集合；该值直接消费既有的角色卡牌价值 primitive，不是新的权重体系。
        mutualDraft: player.mutualBenefitDraftValue ?? 0
      }
    };
  }

  /** owner ledger 的原始状态项：直接复用共享 primitive，避免与 stateUtility 形成两个价值世界。 */
  ownerStateTerms(state, player, viewerId, radarTacticProbability) {
    return this.playerValueTerms(state, player, viewerId, radarTacticProbability);
  }

  /** 单个 owner 在不含延迟状态负担时的统一经济总值。 */
  ownerMaterialValue(state, player, viewerId, radarTacticProbability) {
    const { death, terms } = this.ownerStateTerms(state, player, viewerId, radarTacticProbability);
    return death + Object.values(terms).reduce((sum, value) => sum + value, 0);
  }

  /**
   * 一枚闪电的完整生命周期 owner ledger。
   *
   * 只看当前 holder 会遗漏未命中后顺时针回流的风险；这里先按真实座位环求出
   * 最终命中分布，再让每个命中分支走 AiSimulator.applyLightningHit。HP、护盾、
   * 守誓者护援、调息救援与死亡清理由统一 after-state 经济自然定价，不另设闪电
   * 伤害或击杀常量。当前近似假设命中前存活环和其他闪电占位不变；剩余牌类别则
   * 按判定牌无放回消耗传播，直到第一张装备牌命中，不用随跳数衰减的任意折扣。
   *
   * unresolved value 只作为当前状态的一部分进入 stateUtility；路径上的已实现伤害仍
   * 只由真实 transition 计价，frontier 不再追加闪电 residual，避免 future risk 重复。
   */
  lightningLifecycleOwnerDeltas(state, initialHolder, viewerId, presenceOverride = null) {
    if (!state || !initialHolder?.alive) return new Map();
    let stateCache = this.lightningLifecycleCache.get(state);
    if (!stateCache) {
      stateCache = new Map();
      this.lightningLifecycleCache.set(state, stateCache);
    }
    const presence = presenceOverride == null
      ? lightningPresenceProbability(initialHolder)
      : Math.max(0, Math.min(1, Number(presenceOverride) || 0));
    const cacheKey = `${initialHolder.id}:${viewerId}:${presence}`;
    if (stateCache.has(cacheKey)) return stateCache.get(cacheKey);
    const deltas = new Map(state.players.map((player) => [player.id, 0]));
    if (presence <= 0) {
      stateCache.set(cacheKey, deltas);
      return deltas;
    }
    const distribution = buildLightningHitDistribution(state, initialHolder);
    const beforeRadar = buildRadarJudgmentProbabilities(state?.remainingCardCounts ?? null).tactic;
    const beforeValues = new Map(state.players.map((player) => [
      player.id,
      this.ownerMaterialValue(state, player, viewerId, beforeRadar)
    ]));
    const simulator = new AiSimulator(state);
    for (const outcome of distribution) {
      const after = simulator.applyLightningHit(state, outcome.holder.id);
      const afterRadar = buildRadarJudgmentProbabilities(after?.remainingCardCounts ?? null).tactic;
      for (const afterPlayer of after.players) {
        const delta = this.ownerMaterialValue(after, afterPlayer, viewerId, afterRadar)
          - (beforeValues.get(afterPlayer.id) ?? 0);
        deltas.set(
          afterPlayer.id,
          (deltas.get(afterPlayer.id) ?? 0) + presence * outcome.probability * delta
        );
      }
    }
    stateCache.set(cacheKey, deltas);
    return deltas;
  }

  /** 从 viewer 视角投影一枚闪电整个流转生命周期的预期局面变化。 */
  lightningLifecycleValue(state, initialHolder, viewerId, presenceOverride = null) {
    const viewer = state?.players?.find((player) => player.id === viewerId);
    if (!viewer) return 0;
    const deltas = this.lightningLifecycleOwnerDeltas(state, initialHolder, viewerId, presenceOverride);
    return state.players.reduce((sum, player) => {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      return sum + sign * (deltas.get(player.id) ?? 0);
    }, 0);
  }

  /** 正数表示该闪电给 viewer 阵营造成的预期负担。 */
  lightningTeamBurden(state, holder, viewerId, presenceOverride = null) {
    return -this.lightningLifecycleValue(state, holder, viewerId, presenceOverride);
  }

  /**
   * 状态反制成功的过渡态会先移除旧 holder，再把同一枚闪电交给 receiver。
   * 必须在该过渡态估值，否则旧 holder 会被误当成另一枚闪电的占位而从回流环跳过。
   */
  lightningTransferredBurden(state, holder, receiver, viewerId) {
    if (!state || !holder || !receiver) return 0;
    const transferred = structuredClone(state);
    const previous = transferred.players.find((player) => player.id === holder.id);
    const nextHolder = transferred.players.find((player) => player.id === receiver.id);
    if (!previous || !nextHolder) return 0;
    if (Array.isArray(previous.statuses)) {
      previous.statuses = previous.statuses.filter((statusId) => statusId !== "lightning");
    } else if (previous.statuses) {
      delete previous.statuses.lightning;
    }
    previous.lightningStatusStateBranches = [{ probability:1, conditions:{}, present:false }];
    previous.lightningStatusProbability = 0;
    return this.lightningTeamBurden(transferred, nextHolder, viewerId, 1);
  }

  /** 当前状态中所有独立闪电对指定 owner 的未兑现经济变化。 */
  lightningOwnerDelta(state, ownerId, viewerId) {
    let total = 0;
    for (const holder of state.players) {
      if (!holder?.alive || lightningPresenceProbability(holder) <= 0) continue;
      total += this.lightningLifecycleOwnerDeltas(state, holder, viewerId).get(ownerId) ?? 0;
    }
    return total;
  }

  /**
   * Owner-local state ledger：把一次 transition（before→after）的 stateUtility delta
   * 分解到每个 owner 名下（self / ally / enemy），先记账、后投影。
   *
   * 与把所有角色变化带符号直接求和的 signed-global 方式相反：block 的 -1.1 与
   * assault 的 -1.1 分属不同 owner，不在求和时互相抵消。owner.total 是该 owner 的
   * 未签名原始变化；projectOwnerLedger 再从 planner perspective 决定符号。
   *
   * 每个 owner 的分项按语义归入六类：generic（手牌数、能量）只表达泛用资源量；
   * specific（手牌/装备的角色身份差量）只记录相对全局基础 aiValue 的 delta 部分，
   * 身份差量未被估价时为 0，因此与 generic 互补、不重复计价；material 为 HP/盾/
   * 信息/层数等实体资源，threat 为敌方威胁分量，outcome 为危险/救援处境，
   * teamBurden 为闪电/封印的团队负担。
   */
  ownerStateLedger(before, after, viewerId) {
    const radarTactic = buildRadarJudgmentProbabilities(after?.remainingCardCounts ?? null).tactic;
    const viewer = after.players.find((p) => p.id === viewerId) ?? before.players.find((p) => p.id === viewerId);
    const beforePlayers = new Map(before.players.map((p) => [p.id, p]));
    const owners = [];
    for (const afterPlayer of after.players) {
      const beforePlayer = beforePlayers.get(afterPlayer.id);
      if (!beforePlayer) continue;
      const relation = afterPlayer.battleTeam === viewer.battleTeam
        ? (afterPlayer.id === viewerId ? "self" : "ally")
        : "enemy";
      const beforeTerms = this.ownerStateTerms(before, beforePlayer, viewerId, radarTactic);
      const afterTerms = this.ownerStateTerms(after, afterPlayer, viewerId, radarTactic);
      const beforeBurden = {
        lightning: this.lightningOwnerDelta(before, beforePlayer.id, viewerId),
        seal: sealTeamBurden(before, beforePlayer, viewer.battleTeam)
      };
      const afterBurden = {
        lightning: this.lightningOwnerDelta(after, afterPlayer.id, viewerId),
        seal: sealTeamBurden(after, afterPlayer, viewer.battleTeam)
      };
      const fields = {};
      for (const key of new Set([...Object.keys(beforeTerms.terms), ...Object.keys(afterTerms.terms)])) {
        fields[key] = (afterTerms.terms[key] ?? 0) - (beforeTerms.terms[key] ?? 0);
      }
      fields.death = afterTerms.death - beforeTerms.death;
      fields.lightning = afterBurden.lightning - beforeBurden.lightning;
      fields.seal = afterBurden.seal - beforeBurden.seal;
      const total = Object.values(fields).reduce((sum, value) => sum + value, 0);
      owners.push({
        playerId: afterPlayer.id,
        relation,
        total,
        generic: { handCount: fields.handCount ?? 0, energy: fields.energy ?? 0 },
        material: {
          hp: fields.hp ?? 0,
          shield: fields.shield ?? 0,
          info: fields.info ?? 0,
          stacks: fields.stacks ?? 0,
          equipmentDelta: fields.equipmentDelta ?? 0,
          energyDeviceFuture: fields.energyDeviceFuture ?? 0,
          death: fields.death ?? 0
        },
        threat: {
          currentThreat: fields.currentThreat ?? 0,
          futureInventory: fields.futureInventory ?? 0,
          energyPressure: fields.energyPressure ?? 0,
          markThreat: fields.markThreat ?? 0,
          radar: fields.radar ?? 0
        },
        specific: { handRole: fields.handRole ?? 0, equipmentRole: fields.equipmentRoleDelta ?? 0 },
        outcome: { danger: fields.danger ?? 0, rescueOutlook: fields.rescueOutlook ?? 0 },
        teamBurden: { lightning: fields.lightning ?? 0, seal: fields.seal ?? 0 }
      });
    }
    const total = owners.reduce((sum, owner) => sum + owner.total, 0);
    return { perspectiveId: viewerId, owners, total };
  }

  /**
   * Perspective projection：把 owner-local ledger 从 viewerId 视角投影为
   * self / ally / enemy 三块。enemy 收益对 viewer 为负，投影时取反。
   * projected.total == stateUtility(after, viewerId) - stateUtility(before, viewerId)。
   */
  projectOwnerLedger(ledger, viewerId) {
    const self = ledger.owners.find((owner) => owner.playerId === viewerId);
    const allies = ledger.owners.filter((owner) => owner.relation === "ally");
    const enemies = ledger.owners.filter((owner) => owner.relation === "enemy");
    const selfValue = self?.total ?? 0;
    const allyValue = allies.reduce((sum, owner) => sum + owner.total, 0);
    const enemyValue = enemies.reduce((sum, owner) => sum + owner.total, 0);
    return {
      perspectiveId: viewerId,
      self: selfValue,
      ally: allyValue,
      enemy: enemyValue,
      total: selfValue + allyValue - enemyValue
    };
  }

  /**
   * Frontier-only residual（递归 / 路径安全边界）。
   *
   * realized event value 在发生的 transition 计一次；unresolved / future state
   * residual 只在前沿 / 终局评估计一次。本函数只读当前状态，返回该状态下
   * 尚未兑现的未来价值（future hostile inventory 与 held 未来 option）。
   * 它不随路径深度重复累计：同一状态不同到达路径得到同一 residual；若沿每条路径
   * 逐 depth 各加一次，同一未兑现价值会在多个深度被重复计价，因此只能在前沿评估。
   */
  frontierResidual(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer || !viewer.alive) return null;
    const { futureInventory, energyPressure } = this.exposureComponents(state, viewer);
    // 未来治疗选项必须持有调息卡才成立：持有张数与当前缺血量共同决定可兑现的治愈量，
    // 不能对没有调息来源的缺口无条件赋予完整治疗价值（否则前沿会给"无治疗手段的受伤态"
    // 凭空加分，与"特定未来选项"语义不符）。
    const recoverCards = (viewer.hand ?? []).filter((card) => card.definitionId === "recover")
      .reduce((sum, card) => sum + this.cardAvailability(card), 0);
    const recover = recoverCards > 0
      ? Math.max(0, Math.min(recoverCards, Math.max(0, viewer.maxHp - viewer.hp))) * HP_VALUE
      : 0;
    const recycle = viewer.equipmentDefinitionId === "recycleDevice"
      ? Math.max(0, 2 - (viewer.recycleDeviceUses ?? 0))
        * Math.min(1, (viewer.hand ?? []).filter((card) => card.category === "tactic" && card.counterable !== false).length)
        * 1.1
        * Math.max(0, Number(viewer.equipmentRetentionProbability) || 1)
      : 0;
    const futureInventoryTotal = futureInventory + energyPressure;
    return {
      futureInventory: futureInventoryTotal,
      held: { recover, recycle },
      total: futureInventoryTotal + recover + recycle
    };
  }

  /**
   * 打出某张牌的卡片机会成本分解（只读辅助，不直接进入生产评分）。
   *
   * 语义：牌的成本是"放弃该牌未来最好用途的机会成本"，而不是印在牌上的固定静态分。
   * 本方法用既有 representation 把一次打出拆成互斥的几层，任一层都不重复计价：
   *
   *   generic          —— 一张泛用手牌资源（handCount×1.1 单位）；打出任何牌都付出这一层。
   *   specific         —— 该牌对本角色的身份差量（roleCardDelta，与 handRole 同语义）；
   *                       只记相对全局基础值的边际，与 generic 互补（"计数" vs "身份"是
   *                       两个不同对象，永远不完整双算）。
   *   futureOption     —— 调息/回收站等具体未来选项的边际，与 frontierResidual.held 同语义；
   *                       打出后 after-state 的 frontier 持有值自然下降，此处给出"打出即
   *                       失去的未来选项"分解，不额外进入评分。
   *   responseCapacity —— 格挡/反制/调息作为响应牌时对应的未来响应容量，打出即失去一次；
   *                       容量在 after-state 的 block/counter/expectedRecover 字段下降，
   *                       由响应/反制未来预期计价。capacity 不是泛用资源，因此不会叠加
   *                       到 generic 上——同一张牌"作为手牌资源"与"作为响应容量"是两个
   *                       语义，各计一次，永不因同一用途被 generic 与 specific 双收。
   *
   * 该分解不对应任何新增静态分值，也不进入 candidate value；它把既有账目对"打出一张牌
   * 到底损失了什么"逐层摊开，供测试证明 generic/specific/futureOption/responseCapacity
   * 之间不重复。
   */
  cardOpportunityCost(card, player) {
    const definitionId = card?.definitionId ?? null;
    const generic = 1.1;
    const specific = definitionId ? this.roleCardDelta(player?.generalId, definitionId) : 0;
    const recoverOption = definitionId === "recover"
      ? Math.max(0, Math.min(1, Math.max(0, (player?.maxHp ?? 0) - (player?.hp ?? 0)))) * HP_VALUE
      : 0;
    const recycleOption = definitionId
      && player?.equipmentDefinitionId === "recycleDevice"
      && Array.isArray(player?.hand)
      && player.hand.some((entry) => entry.definitionId === definitionId
        && entry.category === "tactic" && entry.counterable !== false)
      ? Math.max(0, 2 - (player.recycleDeviceUses ?? 0)) * 1.1
        * Math.max(0, Number(player.equipmentRetentionProbability) || 1)
      : 0;
    return {
      definitionId,
      generic,
      specific,
      futureOption: { recover: recoverOption, recycle: recycleOption },
      responseCapacity: {
        block: definitionId === "block" ? 1 : 0,
        counter: definitionId === "counter" ? 1 : 0,
        recover: definitionId === "recover" ? 1 : 0
      }
    };
  }

  /** 雷达动态免伤：当前攻击暴露 × 雷达存在概率 × 判定为战术牌的条件概率；只对 defenseDevice 的真实规则生效。 */
  radarMitigationUtility(exposure, player, tacticJudgmentProbability) {
    if (player?.equipmentDefinitionId !== "defenseDevice") return 0;
    const retention = player.equipmentRetentionProbability ?? 1;
    return exposure * retention * tacticJudgmentProbability;
  }

  /**
   * 充能桩下一回合有效能量与技能选择权的动态价值。
   *
   * 只对 energyDevice 产生；按真实规则（TeamRuleService）计算两个反事实世界的
   * 下一回合开始能量，不修改任何状态，也不预测未来摸牌、目标或猎印。
   * 当前回合已使用的技能次数不会影响下一回合容量：主动技能均在自己回合开始
   * 时随 resetTurnFlags 重置。
   */
  energyDeviceFutureUtility(player) {
    if (player?.equipmentDefinitionId !== "energyDevice" || !player?.battleTeam || !this.game?.teamRules) return 0;
    const retention = player.equipmentRetentionProbability
      ?? (player.equipmentDefinitionId ? 1 : 0);
    if (retention <= 0) return 0;
    const ruleStub = { battleTeam: player.battleTeam };
    const cap = Math.max(0, Number(this.game.teamRules.getMaxEnergy(ruleStub)) || 0);
    const withoutBreakdown = this.game.teamRules.getTurnEnergyBreakdown(ruleStub);
    const withBreakdown = this.game.teamRules.getTurnEnergyBreakdown({
      ...ruleStub,
      equipment: { definitionId: "energyDevice" }
    });
    const currentEnergy = Math.max(0, Number(player.energy) || 0);
    const withoutGain = Number(withoutBreakdown.baseAmount) + Number(withoutBreakdown.teamBonus);
    const withGain = Number(withBreakdown.baseAmount) + Number(withBreakdown.teamBonus)
      + Number(withBreakdown.equipmentBonus);
    const withoutEnergy = Math.min(cap, currentEnergy + withoutGain);
    const withEnergy = Math.min(cap, currentEnergy + withGain);
    const effectiveGain = Math.max(0, withEnergy - withoutEnergy);
    const baseValue = effectiveGain * ENERGY_STATE_WEIGHT;
    const skillCost = Math.max(0, Number(player.activeSkillCost) || 0);
    const skillLimit = Math.max(0, Number(player.activeSkillLimit) || 0);
    let optionValue = 0;
    if (player.activeSkillId && skillCost > 0 && skillLimit > 0) {
      const affordableUses = (energy) => Math.min(skillLimit, Math.floor(energy / skillCost));
      const additionalUses = affordableUses(withEnergy) - affordableUses(withoutEnergy);
      optionValue = Math.max(0, additionalUses) * SKILL_THRESHOLD_OPTION_VALUE;
    }
    return retention * (baseValue + optionValue);
  }

  stateUtility(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) return -Infinity;
    const radarTacticProbability = buildRadarJudgmentProbabilities(state?.remainingCardCounts ?? null).tactic;
    let score = 0;
    for (const player of state.players) {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      // 未签名分项来自共享 primitive：equipmentDelta/equipmentRoleDelta 已含 ×0.25、
      // 威胁三分量之和 == -incomingExposure，与 owner ledger 完全一致。
      const { death, terms } = this.playerValueTerms(state, player, viewerId, radarTacticProbability);
      score += sign * (death + Object.values(terms).reduce((sum, value) => sum + value, 0))
        - sealTeamBurden(state, player, viewer.battleTeam);
    }
    for (const holder of state.players) {
      if (holder?.alive && lightningPresenceProbability(holder) > 0) {
        score += this.lightningLifecycleValue(state, holder, viewerId);
      }
    }
    return score;
  }

  /**
   * 通用 shield state value（只读、无随机、无 Simulator、无隐藏信息，O(1)）。
   *
   * 设计：
   * - 第 1 点盾保留基础储备价值（stored defense），后续盾只按“当前可见残余威胁容量”计价；
   * - residualExposure = raw exposure - radarMitigation，避免 radar 与 shield 重复抵扣同一风险；
   * - absorbed = min(shield, residualExposure / HP_VALUE)：盾不能无限抵消可见威胁；
   * - HP1/HP2 目标在确有可见威胁时获得有上限的 danger/death option 加成（受威胁量调节，
   *   威胁≈0 时不会自动获得完整免死奖金）。
   */
  shieldStateValue(player, residualExposure) {
    const shield = Math.max(0, Number(player.shield) || 0);
    if (!shield || !player?.alive) return 0;
    const reserve = SHIELD_RESERVE_WEIGHT * Math.min(shield, 1);
    const threatPoints = Math.max(0, residualExposure) / HP_VALUE;
    const absorbed = Math.min(shield, threatPoints);
    const hpProtection = absorbed * HP_VALUE * SHIELD_PROTECTION_WEIGHT;
    const lifePremium = player.hp === 1 ? DEATH_VALUE - HP_VALUE
      : player.hp === 2 ? DANGER_VALUE - HP_VALUE
        : 0;
    const lifeProtection = Math.min(1, absorbed) * lifePremium * SHIELD_PROTECTION_WEIGHT;
    return reserve + hpProtection + lifeProtection;
  }

  /**
   * 动作的真实经济先验：只包含"不在 stateDelta 中、但确有经济语义"的项。
   *
   * 原则：final candidate value = realized transition + response + frontier，历史先验
   * （静态卡牌分、目标焦点、威胁优先级等）只用于 beam 排序（见 actionUtility 注释），
   * 不得进入最终 root valueScore。这里只保留两类 stateDelta 看不到的经济量：
   *
   *   - 结束出牌但仍有手牌：-0.8。结束不改状态（stateDelta≈0），但结束 = 浪费本次
   *     出牌机会；该成本只能在此表达，否则所有负经济动作都会让 AI 选择结束而停滞。
   *   - 聚能跨过主动技能成本门槛：+4。能量 +1 已在 stateDelta 计价，但"主动技能现在
   *     可用"这一未来选项不在 stateDelta，与充能桩的未来有效能量价值同一语义。
   *
   * 其余所有 actionUtility 项都迁移到 beam 排序先验，不再进入最终价值。
   */
  actionEconomicValue(action, player, visible) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") {
      const remainingCards = actor.handCount ?? actor.hand?.length ?? player.hand.length;
      return remainingCards > 0 ? -0.8 : 0;
    }
    if (action.type === "skill") return 0;
    const card = action.card;
    if (card?.definitionId === "charge") {
      return (actor.activeSkillId && !actor.activeSkillUsed && actor.energy < actor.activeSkillCost
        && actor.energy + 1 >= actor.activeSkillCost) ? SKILL_THRESHOLD_OPTION_VALUE : 0;
    }
    return 0;
  }

  /**
   * 动作的 beam 排序先验（search prior，不进入最终 candidate value）。
   *
   * 历史沿革：actionUtility 曾是最终评分的支配项，其中的静态卡牌分（getRoleCardAiValue）
   * 会与 stateDelta 的 card-spend opportunity cost（handCount/角色身份差量）对同一张牌
   * 重复计价。现在该函数只服务候选的搜索顺序（pruneScore = valueScore + actionUtility
   * + actionSearchPrior），帮助 beam 优先展开"值得打的牌"与"优先击杀的目标"；最终 root
   * 选择只按 valueScore（真实经济 = stateDelta + response ledger + frontier）。
   * 真实价值一律由 stateDelta 表达，本函数保留的 static base 只在 beam 层给卡片打出
   * 一个展开偏置，绝不进入最终 root valueScore。
   */
  actionUtility(action, player, visible, options = {}) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") {
      const remainingCards = actor.handCount ?? actor.hand?.length ?? player.hand.length;
      return remainingCards > 0 ? -0.8 : 0;
    }
    if (action.type === "skill") {
      const actionTarget = action.targets?.[0];
      const target = visible.players.find((entry) => entry.id === actionTarget?.id) ?? actionTarget;
      const enemies = visible.players.filter((entry) => entry.alive && entry.battleTeam !== actor.battleTeam);
      const missing = target ? Math.max(0, target.maxHp - target.hp) : 0;
      const values = {
        breakArmy: this.breakArmyUtility(actor),
        barrier: 4 + (target?.hp <= 2 ? 4 : 0),
        // 滋荣真实价值（治疗 1 HP、danger 消除、回春摸牌）全部由 stateDelta 表达；
        // 旧 `missing × 4` 把“总缺血量”误当成“本次实际恢复量”，必须显式为 0。
        // 无需搜索先验：零先验下临界治疗仍能稳定进入 beam。
        symbiosis: 0,
        stealSkill: 5 + Math.min(4, (target?.handCount ?? 0) + (target?.equipmentDefinitionId ? 1 : 0)),
        // 焚场真实价值（伤害/击杀/救援/能量）全部由 stateDelta 表达；此处必须显式为 0，
        // 避免回退到 `?? 4` 的默认先验。临时 beam 排序信用放在 actionSearchPrior。
        burningField: 0,
        hunt: 7 + (target?.hp <= 2 ? 7 : 0),
        allIn: Math.max(0, actor.energy - 1) * 3
          + Math.min(1, actor.energy * .25) * (1 - (actor.assaultBonus ?? 0)) * 4,
        resonance: 5 + (target?.handCount <= 1 ? 3 : 0)
      };
      let value = values[action.skill.id] ?? 4;
      if (["stealSkill","hunt"].includes(action.skill.id)) value += this.threatPriority(actor, target, player.aiMemory, 1);
      return value;
    }
    const card = action.card;
    const roleDelta = this.roleCardDelta(actor?.generalId, card?.definitionId);
    let value = actor?.generalId && card?.definitionId
      ? getRoleCardAiValue(actor.generalId, card.definitionId)
      : (card.aiValue ?? 0);
    if (card.definitionId === "lightning") {
      // 静态牌值只负责 beam 排序；整个流转链的真实价值已经作为 after-state
      // unresolved lifecycle 进入 stateDelta，最终 valueScore 不读取本先验。
      value = (card.aiValue ?? 0)
        + this.lightningLifecycleValue(visible, actor, actor.id, 1) * STATE_DELTA_SCALE
        + roleDelta;
    }
    const actionTarget = action.targets?.[0];
    const target = visible.players.find((entry) => entry.id === actionTarget?.id) ?? actionTarget;
    if (card.definitionId === "seal") {
      // 封印的软性后置（现在先封印会让最佳非封印即时动作延迟一步）属于跨候选
      // timing 比较，由 AiPlanner 在同一 parent 物化候选后用真实 base transition
      // 计算 delayCost 再调整 seal transition；actionUtility 只读单动作先验，
      // 不再递归比较替代动作。
      value = sealUseValue(actor, target, visible) + roleDelta;
    }
    if (target) {
      const enemy = target.battleTeam !== player.battleTeam;
      if (card.subtypes.includes("attack") || card.definitionId === "duel") {
        const focus = (target.maxHp - target.hp) * 3 + (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        // 突袭的基础伤害与击杀收益已由 AiSimulator 写入 after-state，并经 stateUtility
        // 以 HP/危险/阵亡价值表达，不再按缺失血量重复计价；只保留近杀目标选择先验
        // （2HP/1HP 目标的边际击杀倾向，属于独立的目标选取 contextual prior）。
        // 震荡为多目标牌，逐目标伤害/击杀已由 stateDelta 自然累积，不设单目标先验。
        // 决斗等其它攻击类卡牌仍沿用原即时先验。
        if (enemy && card.definitionId === "assault") value += (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        else if (enemy && !["assault","shockwave"].includes(card.definitionId)) value += 3 + focus;
        else if (!enemy) value -= 12;
      }
      if (["plunder","destroy","scout"].includes(card.definitionId)) {
        const equipmentValue = target.equipmentDefinitionId || target.equipment ? (card.definitionId === "plunder" ? 1 : 2) : 0;
        value += Math.min(5, (target.hand?.length ?? target.handCount ?? 0) + equipmentValue);
      }
      if (!enemy && ["plunder","destroy"].includes(card.definitionId)) value -= 30;
      if (!enemy && card.definitionId === "scout") value -= actor.activeSkillId === "resonance" ? 5 : 12;
      if (enemy && ["assault","duel","plunder","destroy","scout"].includes(card.definitionId)) {
        value += this.threatPriority(actor, target, player.aiMemory, ["assault","duel"].includes(card.definitionId) ? 1 : 0);
      }
    }
    // 调息的真实价值（恢复1HP、danger/死亡消除）已由 AiSimulator 写入 after-state，
    // 由 stateUtility 的 HP/危险/阵亡价值表达；旧 `(maxHp - hp) * 4` 把"总缺血量"
    // 误当成"本次实际恢复量"且与 stateDelta 重复计价，与滋荣同一语义缺陷，必须删除。
    if (card.definitionId === "charge") value += (actor.maxEnergy - actor.energy) * 1.5 + (actor.activeSkillId && !actor.activeSkillUsed && actor.energy < actor.activeSkillCost && actor.energy + 1 >= actor.activeSkillCost ? SKILL_THRESHOLD_OPTION_VALUE : 0);
    // 护盾的真实价值（+1 盾、低血目标在可见威胁下的危险/死亡保护）已由 AiSimulator
    // 写入 after-state，并经 shieldStateValue 以暴露感知的储备+保护价值表达；
    // 旧的固定 `(hp<=1 ? 6 : hp<=2 ? 3 : 0) + max(0, 2-shield)` 与 stateDelta 重复，
    // 且无视暴露感知（低威胁下仍给完整危险奖金），必须删除。
    // 震荡对每名敌人的基础伤害与击杀收益已由 AiSimulator 逐目标写入 after-state，
    // 由 stateDelta 自然累积；旧的 `近杀敌人数 × 7` 与多目标击杀重复计价，必须删除。
    if (card.definitionId === "provoke") value += visible.players.filter((enemy) => enemy.alive && enemy.battleTeam !== actor.battleTeam).reduce((sum, enemy) => sum + (1 - (enemy.assaultResponseProbability ?? 0)) * 3, 0);
    // 借势造成的伤害、手牌与装备变化已经由 AiSimulator 写入后继状态，统一交给 stateUtility 计分。
    if (card.definitionId === "duel" && target) value += ((actor.expectedAssaultCount ?? 0) - (target.expectedAssaultCount ?? 0)) * 2;
    if (card.definitionId === "transfer") value += Number(action.selection?.score ?? 0);
    if (card.definitionId === "symbiosis") {
      const net = this.symbiosisNetFromState(actor, visible);
      value = (net > 0 ? 8 + net : -9 + net) + roleDelta;
    }
    const equippedDefinitionId = actor.equipmentDefinitionId ?? actor.equipment?.definitionId ?? null;
    if (card.category === "equipment" && equippedDefinitionId) {
      // 边际装备价值：与弃牌保留价值共用同一折损语义（replacement / redundancy 净增量）。
      value -= getEquipmentKeepValueDeduction(
        actor?.generalId ?? null,
        card.definitionId,
        equippedDefinitionId,
        actor.equipmentRetentionProbability ?? 1,
        { cardDefinitions: CARD_DEFINITIONS }
      );
    }
    return value;
  }

  symbiosisNet(player) {
    return this.symbiosisNetFromState(player, this.game.state);
  }

  symbiosisNetFromState(player, state) {
    return (assessGlobalBenefit(state.players, player.battleTeam, "symbiosis")?.netBenefit ?? 0) * 4;
  }

  /**
   * 临时 search / ranking credit：只用于当前这一层的 beam pruning / ranking，
   * 不进入 transition 的真实累计价值，也不影响最终 valueScore 决策。
   * 当前第一位消费者：焚场（8 是在 beamWidth=10 且已构造的高分支场景下，
   * 经实验确认足以降低合理候选过早被剪风险的经验值，并非游戏价值）。
   */
  actionSearchPrior(action, player, visible) {
    if (action.skill?.id === "burningField") return BURNING_FIELD_SEARCH_PRIOR;
    return 0;
  }
}
