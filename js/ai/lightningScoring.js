/**
 * 闪电的 AI 共享纯计算：状态检查、剩余装备类别概率、下一接收者查找与期望负担。
 * 只读取公开/过滤后的字段，不实例化匿名判定牌，不修改 remainingCardCounts 根先验。
 */
import { CARD_DEFINITIONS, TOTAL_CARD_COUNT } from "../config/cardConfig.js?build=20260811-offensive-exposure-v168";
import { RuleEngine } from "../core/RuleEngine.js?build=20260811-offensive-exposure-v168";
import { PROBABILITY_EPSILON, clampProbability, mergeProbabilityStateBranches, totalBranchProbability } from "./AiProbabilityBranches.js?build=20260811-offensive-exposure-v168";

const DISCOUNT = 0.5;

export function hasLightning(player) {
  return RuleEngine.hasStatus(player, "lightning");
}

/** 返回玩家闪电状态的完整概率分区；无概率分支时回退为确定性状态。 */
export function getLightningStatusStateBranches(player) {
  if (Array.isArray(player?.lightningStatusStateBranches) && player.lightningStatusStateBranches.length) {
    return mergeProbabilityStateBranches(
      player.lightningStatusStateBranches.map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions ?? {},
        present:Boolean(branch.present)
      }))
    );
  }
  return [{ probability:1, conditions:{}, present:RuleEngine.hasStatus(player, "lightning") }];
}

/** 返回 P(lightning present)，范围 [0,1]。 */
export function lightningPresenceProbability(player) {
  return clampProbability(totalBranchProbability(
    getLightningStatusStateBranches(player).filter((branch) => branch.present)
  ));
}

/** 剩余装备类别概率：装备牌剩余数量 / 剩余未知牌总数；无动态计数时回退固定初始密度。 */
export function equipmentJudgmentProbability(remainingCardCounts = null) {
  if (remainingCardCounts && typeof remainingCardCounts === "object" && !Array.isArray(remainingCardCounts)) {
    let equipment = 0;
    let total = 0;
    for (const [definitionId, count] of Object.entries(remainingCardCounts)) {
      const value = Number(count);
      if (!Number.isFinite(value) || value <= 0) continue;
      const definition = CARD_DEFINITIONS[definitionId];
      if (!definition) continue;
      total += value;
      if (definition.category === "equipment") equipment += value;
    }
    return total > 0 ? Math.max(0, Math.min(1, equipment / total)) : 0;
  }
  const equipmentTotal = Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.category === "equipment")
    .reduce((sum, definition) => sum + definition.count, 0);
  return TOTAL_CARD_COUNT > 0 ? equipmentTotal / TOTAL_CARD_COUNT : 0;
}

export function nextLightningReceiver(players, holder) {
  return RuleEngine.nextLightningReceiver(players, holder);
}

/**
 * 构造一枚移动闪电的有限传播链（纯 AI 估值 helper，不替代真实规则）：
 * 从 initialHolder 开始顺时针扫描一次，每名当前可参与玩家最多进入一次，
 * 扫描到 initialHolder 前停止；除 initialHolder 外没有其他合法接收者时
 * 返回 [holder, holder]，与真实“转移回自己”及旧模型 k=1 兼容。
 */
export function buildLightningPropagationChain(players, initialHolder) {
  if (!initialHolder?.alive || !Array.isArray(players) || !players.length) return [];
  const chain = [initialHolder];
  const count = players.length;
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = players[(initialHolder.seatIndex + offset) % count];
    if (!candidate?.alive || candidate.id === initialHolder.id) continue;
    if (hasLightning(candidate)) continue;
    chain.push(candidate);
  }
  if (chain.length === 1) chain.push(initialHolder);
  return chain;
}

/** 3 点闪电伤害对一名玩家的期望生命负担，含低生命/致死额外风险。 */
function damageRisk(player) {
  const protect = Math.max(0, Number(player?.hp ?? 0) + Number(player?.shield ?? 0));
  const lost = Math.min(3, protect);
  const lethal = protect <= 3 ? 4 - protect : 0;
  return lost + lethal;
}

/**
 * 有限传播链 signed burden：从 initialHolder 的 k=0 开始，
 * weight(k) = p × [(1-p) × DISCOUNT]^k，己方为正、敌方为负；
 * futureOnly 时只累计 k>=1（供主动使用价值的未来传播项使用）。
 */
function lightningPropagationBurden(state, initialHolder, viewerTeam, futureOnly = false) {
  const probability = equipmentJudgmentProbability(state?.remainingCardCounts);
  const chain = buildLightningPropagationChain(state?.players, initialHolder);
  let burden = 0;
  let weight = probability;
  for (let hop = 0; hop < chain.length; hop += 1) {
    if (hop > 0 || !futureOnly) {
      const holder = chain[hop];
      const sign = holder.battleTeam === viewerTeam ? 1 : -1;
      burden += weight * damageRisk(holder) * sign;
    }
    weight *= (1 - probability) * DISCOUNT;
  }
  return burden;
}

/** 从 viewerTeam 视角返回持有闪电的期望团队损失（正数为己方损失，负数为敌方损失）。 */
export function lightningTeamBurden(state, holder, viewerTeam) {
  if (!holder?.alive) return 0;
  const presence = lightningPresenceProbability(holder);
  if (presence <= PROBABILITY_EPSILON) return 0;
  return presence * lightningPropagationBurden(state, holder, viewerTeam);
}

/** 状态反制成功后立即转移给 receiver 时，从 viewerTeam 视角的后续期望损失。 */
export function lightningTransferredBurden(state, receiver, viewerTeam) {
  if (!receiver?.alive) return 0;
  return DISCOUNT * lightningPropagationBurden(state, receiver, viewerTeam);
}

/** 主动使用闪电的情境价值：基础 aiValue - 自身触发风险 + 转移收益 - 致死惩罚 - 手牌机会成本。 */
export function lightningUseValue(actor, state) {
  if (!actor?.alive || hasLightning(actor)) return -50;
  const probability = equipmentJudgmentProbability(state?.remainingCardCounts);
  const selfBurden = probability * damageRisk(actor);
  const futureValue = -lightningPropagationBurden(state, actor, actor.battleTeam, true);
  const protect = Math.max(0, Number(actor?.hp ?? 0) + Number(actor?.shield ?? 0));
  const lethalPenalty = protect <= 3 ? 8 + (3 - protect) * 2 : 0;
  return (CARD_DEFINITIONS.lightning?.aiValue ?? 5) - selfBurden + futureValue - lethalPenalty - 1;
}
