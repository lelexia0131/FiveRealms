/*
模块职责
唯一把过滤后的状态与已计算领域项转换为 State Value（从指定观察者阵营评估一个完整状态的存量价值）。

上游
AIController 组合的状态价值适配器、ValueLedger 与测试。

下游
Economics、CardValue、ThreatValue 以及封印、雷达的现有纯领域函数。

状态边界
只读 VisibleState/SearchState 和显式传入的领域值；不持有 Game，不写状态。

信息边界
只使用公开字段、合法概率摘要与 viewer 自身的可见卡牌身份。

架构约束
不得导入或构造 Simulator、Planner、Controller；State Value 只读一个状态，闪电等生命周期结果必须由调用层先计算为纯值。
*/
import { buildRadarJudgmentProbabilities } from "../domain/RadarModel.js";
import { sealTeamBurden } from "./SealValue.js";
import { cardAvailability, getBaseCardAiValue, roleCardDelta } from "./CardValue.js";
import {
  ENERGY_STATE_WEIGHT,
  HP_VALUE,
  energyDeviceFutureUtility
} from "./Economics.js";
import {
  DANGER_VALUE,
  DEATH_VALUE,
  exposureComponents,
  hp2ThreatRiskValue,
  radarMitigationUtility,
  shieldStateValue
} from "./ThreatValue.js";

export class Evaluator {
  /*
  功能
  绑定状态估值所需的稳定规则查询能力。

  调用方
  AIController 组合根（统一组装依赖的位置） 与纯价值测试。

  输入
  getMaxEnergy、getTurnEnergyBreakdown 两个显式规则函数。

  输出
  不持有 Game 的纯状态评估器实例。

  读取状态
  仅保存规则函数引用。

  写入状态
  写入实例的不可变依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Simulator、Planner 或 Controller；规则函数只能回答稳定能量规则。
  */
  constructor({ getMaxEnergy = null, getTurnEnergyBreakdown = null } = {}) {
    this.energyRules = Object.freeze({ getMaxEnergy, getTurnEnergyBreakdown });
  }

  /*
  功能
  暴露 State Value 使用的正式攻击暴露 primitive。

  调用方
  playerValueTerms 与 value ownership 测试。

  输入
  过滤后的状态与被评估玩家。

  输出
  ThreatValue 的 current、future、energy 与逐敌分解。

  读取状态
  只读过滤后的威胁摘要和距离字段。

  写入状态
  无。

  调用函数
  ThreatValue.exposureComponents。

  边界与不变量
  只转发唯一威胁公式，使单次玩家估值可验证为只计算一次暴露分解。
  */
  exposureComponents(state, player) {
    return exposureComponents(state, player);
  }

  /*
  功能
  生成单个玩家状态价值的未签名共享分项。

  调用方
  stateUtility、ValueLedger 与 lightning simulation query。

  输入
  过滤后的状态、玩家、viewer ID 与雷达战术判定概率。

  输出
  death 与 terms 分解；阵亡角色只返回 death。

  读取状态
  只读公开资源、合法概率摘要、viewer 自身手牌身份与稳定规则查询。

  写入状态
  无。

  调用函数
  CardValue、ThreatValue 与 energyDeviceFutureUtility。

  边界与不变量
  这里不施加团队符号，也不计封印/闪电 burden；同一分项同时供 state value 与 ledger 使用。
  */
  playerValueTerms(state, player, viewerId, radarTacticProbability) {
    if (!player.alive) return { death: -DEATH_VALUE, terms: {} };
    const danger = player.hp <= 1 ? -DANGER_VALUE : 0;
    const rescueOutlook = player.survivalChance === undefined
      ? 0
      : (player.survivalChance - 0.5) * 8;
    const equipmentValue = player.equipmentDefinitionId
      ? getBaseCardAiValue(player.equipmentDefinitionId)
      : 0;
    const initialEquipmentValue = player.initialEquipmentValue ?? equipmentValue;
    const equipmentDelta = (equipmentValue
      * (player.equipmentRetentionProbability ?? (equipmentValue ? 1 : 0))
      - initialEquipmentValue + (player.expectedEquipmentGain ?? 0)) * 0.25;
    const currentEquipmentRoleDelta = player.equipmentDefinitionId
      ? roleCardDelta(player.characterId, player.equipmentDefinitionId)
      : 0;
    const initialEquipmentRoleDelta = Number.isFinite(player.initialEquipmentRoleDelta)
      ? player.initialEquipmentRoleDelta
      : currentEquipmentRoleDelta;
    const equipmentRoleDelta = (currentEquipmentRoleDelta
      * (player.equipmentRetentionProbability ?? (currentEquipmentRoleDelta ? 1 : 0))
      - initialEquipmentRoleDelta + (player.expectedEquipmentRoleDelta ?? 0)) * 0.25;
    const handRoleDelta = player.id === viewerId
      ? (player.hand ?? []).reduce((sum, card) => (
          sum + roleCardDelta(player.characterId, card?.definitionId) * cardAvailability(card)
        ), 0)
      : 0;
    const markThreat = Object.entries(player.huntMarkProbabilities ?? {}).reduce(
      (sum, [sourceId, probability]) => {
        const source = state.players.find((entry) => entry.id === sourceId);
        return sum + (source?.battleTeam !== player.battleTeam ? Number(probability) || 0 : 0);
      },
      0
    );
    const {
      currentThreat,
      futureInventory,
      energyPressure,
      perEnemy
    } = this.exposureComponents(state, player);
    const exposure = currentThreat + futureInventory + energyPressure;
    const radarMitigation = radarMitigationUtility(exposure, player, radarTacticProbability);
    const residualExposure = Math.max(0, exposure - radarMitigation);
    const shield = shieldStateValue(player, residualExposure);
    // hp2 风险排除 viewer 自身对敌方造成的资源联动，避免同一资源消费在 threat 外再记一次。
    const bufferExposure = (perEnemy ?? [])
      .filter((entry) => entry.enemyId !== viewerId)
      .reduce((sum, entry) => (
        sum + entry.currentThreat + entry.futureInventory + entry.energyPressure
      ), 0);
    const bufferResidualExposure = Math.max(
      0,
      bufferExposure - radarMitigationUtility(bufferExposure, player, radarTacticProbability)
    );
    const hp2Risk = hp2ThreatRiskValue(player, bufferResidualExposure);
    const energyDeviceFuture = energyDeviceFutureUtility(this.energyRules, player);
    return {
      death: 0,
      terms: {
        danger,
        hp2Risk,
        rescueOutlook,
        hp: player.hp * HP_VALUE,
        shield,
        energy: Math.max(0, Number(player.energy) || 0) * ENERGY_STATE_WEIGHT,
        handCount: player.handCount * 1.1,
        handRole: handRoleDelta,
        stacks: (player.exposeWeaknessStacks ?? 0) * 1.5,
        equipmentDelta,
        equipmentRoleDelta,
        info: (player.expectedInformationGain ?? 0) * 0.35,
        markThreat: -markThreat * 1.5,
        currentThreat: -currentThreat,
        futureInventory: -futureInventory,
        energyPressure: -energyPressure,
        radar: radarMitigation,
        energyDeviceFuture,
        mutualDraft: player.mutualBenefitDraftValue ?? 0
      }
    };
  }

  /*
  功能
  提供 owner ledger 与 stateUtility 共用的原始状态项入口。

  调用方
  ValueLedger 与 ownerMaterialValue。

  输入
  状态、玩家、viewer ID 与雷达概率。

  输出
  与 playerValueTerms 完全相同的共享分项。

  读取状态
  与 playerValueTerms 相同。

  写入状态
  无。

  调用函数
  playerValueTerms。

  边界与不变量
  不复制公式，确保 owner ledger 与全局 state value 处于同一个价值世界。
  */
  ownerStateTerms(state, player, viewerId, radarTacticProbability) {
    return this.playerValueTerms(state, player, viewerId, radarTacticProbability);
  }

  /*
  功能
  汇总单个 owner 在不含延迟状态负担时的经济总值。

  调用方
  闪电生命周期 simulation query。

  输入
  状态、owner、viewer ID 与雷达概率。

  输出
  未施加团队符号的 owner material value。

  读取状态
  与 ownerStateTerms 相同。

  写入状态
  无。

  调用函数
  ownerStateTerms。

  边界与不变量
  不包含封印与闪电自身 burden，避免生命周期查询递归调用 stateUtility。
  */
  ownerMaterialValue(state, player, viewerId, radarTacticProbability) {
    const { death, terms } = this.ownerStateTerms(
      state,
      player,
      viewerId,
      radarTacticProbability
    );
    return death + Object.values(terms).reduce((sum, value) => sum + value, 0);
  }

  /*
  功能
  把状态与调用层已计算的闪电值转换为唯一团队 State Value。

  调用方
  状态价值运行时适配器与纯边界测试。

  输入
  过滤后的状态、viewer ID，以及按 holder 顺序排列的闪电生命周期纯数值。

  输出
  viewer 团队视角的 State Value；找不到 viewer 时返回负无穷。

  读取状态
  只读公开资源、合法概率摘要和传入的领域值。

  写入状态
  无。

  调用函数
  playerValueTerms、sealTeamBurden、buildRadarJudgmentProbabilities。

  边界与不变量
  闪电值由调用层模拟后传入；本函数不模拟，且按既有玩家、holder 顺序保持浮点运算顺序。
  */
  stateUtility(state, viewerId, lightningValues = []) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) return -Infinity;
    const radarTacticProbability = buildRadarJudgmentProbabilities(
      state?.remainingCardCounts ?? null
    ).tactic;
    let score = 0;
    for (const player of state.players) {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      const { death, terms } = this.playerValueTerms(
        state,
        player,
        viewerId,
        radarTacticProbability
      );
      score += sign * (death + Object.values(terms).reduce((sum, value) => sum + value, 0))
        - sealTeamBurden(state, player, viewer.battleTeam);
    }
    for (const value of lightningValues) score += value;
    return score;
  }
}
