/**
 * AI 团队效用评估器。只读取公开或过滤后的字段并返回分数，不生成、执行动作，
 * 不写 GameState；权重修改会影响阵营平衡，之后必须重跑 200 局模拟。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260811-seal-consumer-v170";
import { DistanceSystem } from "../core/DistanceSystem.js?build=20260811-seal-consumer-v170";
import { buildRadarJudgmentProbabilities } from "./AiProbabilityBranches.js?build=20260811-seal-consumer-v170";
import { ThreatCalculator } from "./ThreatCalculator.js?build=20260811-seal-consumer-v170";
import { assessGlobalBenefit } from "./AiGlobalBenefit.js?build=20260811-seal-consumer-v170";
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260811-seal-consumer-v170";
import { getBaseCardAiValue, getEquipmentKeepValueDeduction, getRoleCardAiValue } from "./roleCardValue.js?build=20260811-seal-consumer-v170";
import { lightningTeamBurden, lightningUseValue } from "./lightningScoring.js?build=20260811-seal-consumer-v170";
import {
  sealTeamBurden, sealUseValue
} from "./sealScoring.js?build=20260811-seal-consumer-v170";

/** stateUtility 中每点能量的单位价值；充能桩未来有效能量复用同一语义，不另设常数。 */
const ENERGY_STATE_WEIGHT = 1.2;
/** 额外 1 点能量跨过主动技能成本门槛时的选择权价值；与聚能现有启发式保持一致。 */
const SKILL_THRESHOLD_OPTION_VALUE = 4;
/** 焚场的临时 beam 排序信用：只服务当前层 pruning/ranking，不进入真实累计价值。 */
const BURNING_FIELD_SEARCH_PRIOR = 8;
/** stateUtility 与 shieldStateValue 共用：每点 HP 的效用权重。 */
const HP_VALUE = 5;
/** stateUtility 与 shieldStateValue 共用：HP<=1 danger 阈值惩罚。 */
const DANGER_VALUE = 7;
/** stateUtility 与 shieldStateValue 共用：阵亡惩罚。 */
const DEATH_VALUE = 28;
/** 通用 shield state value：第 1 点盾的基础储备（stored defense）权重。 */
const SHIELD_RESERVE_WEIGHT = 2;
/** 通用 shield state value：残余威胁容量的保护实现权重（保守；exposure 是威胁 proxy 而非确定伤害）。 */
const SHIELD_PROTECTION_WEIGHT = 0.5;

export class AiEvaluator {
  constructor(game) { this.game = game; }

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

  /** 敌方攻击暴露：距离可达概率 × 公开突袭资源强度；只读公开/模拟合法字段，不读取隐藏手牌身份。 */
  incomingExposure(state, player) {
    let exposure = 0;
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
      const expectedDamage = response + Math.min(3, expectedAssault) * 0.5 + Math.min(2, energy) * 0.3;
      exposure += expectedDamage * HP_VALUE * rangeProbability;
    }
    return exposure;
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
      if (!player.alive) {
        score += sign * -DEATH_VALUE;
        continue;
      }
      const danger = player.hp <= 1 ? -DANGER_VALUE : 0;
      const rescueOutlook = player.survivalChance === undefined ? 0 : (player.survivalChance - 0.5) * 8;
      const equipmentValue = player.equipmentDefinitionId ? (CARD_DEFINITIONS[player.equipmentDefinitionId]?.aiValue ?? 7) : 0;
      const initialEquipmentValue = player.initialEquipmentValue ?? equipmentValue;
      const equipmentDelta = equipmentValue * (player.equipmentRetentionProbability ?? (equipmentValue ? 1 : 0))
        - initialEquipmentValue
        + (player.expectedEquipmentGain ?? 0);
      const currentEquipmentRoleDelta = player.equipmentDefinitionId
        ? this.roleCardDelta(player.generalId, player.equipmentDefinitionId)
        : 0;
      const initialEquipmentRoleDelta = Number.isFinite(player.initialEquipmentRoleDelta)
        ? player.initialEquipmentRoleDelta
        : currentEquipmentRoleDelta;
      const equipmentRoleDelta = currentEquipmentRoleDelta
          * (player.equipmentRetentionProbability ?? (currentEquipmentRoleDelta ? 1 : 0))
        - initialEquipmentRoleDelta
        + (player.expectedEquipmentRoleDelta ?? 0);
      const handRoleDelta = player.id === viewerId
        ? (player.hand ?? []).reduce((sum, card) => (
            sum + this.roleCardDelta(player.generalId, card?.definitionId) * this.cardAvailability(card)
          ), 0)
        : 0;
      const markThreat = Object.entries(player.huntMarkProbabilities ?? {}).reduce((sum, [sourceId, probability]) => {
        const source = state.players.find((entry) => entry.id === sourceId);
        return sum + (source?.battleTeam !== player.battleTeam ? Number(probability) || 0 : 0);
      }, 0);
      const exposure = this.incomingExposure(state, player);
      const radarMitigation = this.radarMitigationUtility(exposure, player, radarTacticProbability);
      const residualExposure = Math.max(0, exposure - radarMitigation);
      const energyDeviceFuture = this.energyDeviceFutureUtility(player);
      score += sign * (danger + rescueOutlook + player.hp * HP_VALUE
        + this.shieldStateValue(player, residualExposure)
        + player.energy * ENERGY_STATE_WEIGHT
        + player.handCount * 1.1 + handRoleDelta + (player.exposeWeaknessStacks ?? 0) * 1.5
        + equipmentDelta * .25 + equipmentRoleDelta * .25
        + (player.expectedInformationGain ?? 0) * .35 - markThreat * 1.5 - exposure + radarMitigation
        + energyDeviceFuture)
      - lightningTeamBurden(state, player, viewer.battleTeam)
      - sealTeamBurden(state, player, viewer.battleTeam);
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
        // SM1-SM6 实测无需 temporary search prior（零先验下临界治疗仍稳进 beam）。
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
      value = lightningUseValue(actor, visible) + roleDelta;
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
