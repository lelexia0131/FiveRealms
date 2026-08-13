/**
 * root outcome 的统一公开估值与反制意愿。
 *
 * 反制决策围绕最终 root outcome 与反制链奇偶（parity）展开：
 *   root=0 时 root 生效；第一张反制=1 时 root 被取消；第二张反制=2 时恢复生效；以此类推。
 * 每一层都对比"不追加反制"（stay）与"追加一张反制"（flip）两个世界的 root 结局价值，
 * 只有结局翻转带来的价值增量超过反制牌机会成本时才反制。因此判断必须评价最终 root
 * outcome 而不是只看当前 source：嵌套反制时当前被反制的牌是上一张反制，其施放者阵营
 * 与 root 是否应该被取消没有直接关系。
 *
 * 全体受益牌（互利、共生）使用专门模型：
 *   互利按真实公开选牌顺序（施放者优先，再按环形座位顺时针）做确定性期望——把公共
 *   剩余牌数构成预期牌池，每个角色按座位顺序取自己角色价值最高的剩余定义并消耗一张；
 *   后手只能从先手未选走的集合中选，顺序优势来自"可选集合随前序选择逐步缩小"。
 *   规划/反制阶段牌面未翻开，禁止读取真实未来牌堆或 RNG，只能用公共剩余牌计数估算。
 *
 * 其余可反制牌统一走动态 root 效果估值（dynamicRootFlipGain，真实响应链的游戏侧入口
 * dynamicRootCounterDecision 位于 AiResponsePolicy）：
 *   root 效果价值按"当前响应链实际消耗资源后的实时状态"模拟 root 结算后的 after-state
 *   得到，而不是 root 最初打出时的 snapshot，也不是静态 card value。例如掠夺的目标在
 *   响应链中已把手牌用尽时，恢复掠夺的实际收益已从"可能获得 1 张牌"降为 0。
 */
import { CARD_DEFINITIONS } from "../config/cardConfig.js?build=20260813-ai-hotpath-reuse";
import { getBaseCardAiValue, getRoleCardAiValue } from "./roleCardValue.js?build=20260813-ai-hotpath-reuse";

const GLOBAL_BENEFIT_CARDS = new Set(["mutualBenefit", "symbiosis"]);

function benefitForPlayer(player, definitionId) {
  if (definitionId === "symbiosis") {
    return Math.min(1, Math.max(0, (player.maxHp ?? 0) - (player.hp ?? 0)));
  }
  return 0;
}

/** 互利公开选牌的真实座位顺序：施放者优先，其余按环形座位顺时针；只保留存活角色。 */
function mutualBenefitSeatOrder(players, source) {
  const all = Array.isArray(players) ? players : [];
  const seatCount = Math.max(1, all.length);
  const sourceSeat = Number(source?.seatIndex) || 0;
  const ordered = [];
  for (let offset = 0; offset < seatCount; offset += 1) {
    const player = all[(sourceSeat + offset) % seatCount];
    if (player?.alive) ordered.push(player);
  }
  return ordered;
}

/** 角色对该牌的有效价值；缺少角色身份时回退全局基础值。 */
function cardValueFor(generalId, definitionId) {
  if (!generalId) return getBaseCardAiValue(definitionId);
  try {
    return getRoleCardAiValue(generalId, definitionId);
  } catch {
    return getBaseCardAiValue(definitionId);
  }
}

/**
 * 互利按真实选牌顺序的确定性期望：从剩余牌计数构建预期牌池，每个存活角色按座位顺序
 * 取自己角色价值最高的剩余定义并消耗一张。先手能取到更高价值，后手只能从剩余集合选；
 * 顺序优势来自可选集合逐步缩小，而不是任何座位奖励常数。规划/反制阶段不读取真实未来牌。
 */
export function mutualBenefitDraftValues(players, source, remainingCounts) {
  const pool = {};
  let total = 0;
  if (remainingCounts && typeof remainingCounts === "object" && !Array.isArray(remainingCounts)) {
    for (const [definitionId, count] of Object.entries(remainingCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      pool[definitionId] = count;
      total += count;
    }
  }
  const values = {};
  for (const player of mutualBenefitSeatOrder(players, source)) {
    if (total <= 0) break;
    let bestDefinitionId = null;
    let bestValue = -Infinity;
    for (const definitionId of Object.keys(pool)) {
      if (pool[definitionId] <= 0) continue;
      const value = cardValueFor(player.generalId, definitionId);
      if (value > bestValue) {
        bestValue = value;
        bestDefinitionId = definitionId;
      }
    }
    if (bestDefinitionId === null) break;
    pool[bestDefinitionId] -= 1;
    total -= 1;
    values[player.id] = bestValue;
  }
  return values;
}

/**
 * 只依据当前可见局面评估全体受益牌，不读取隐藏手牌或未来牌堆。
 * 互利按真实选牌顺序给出每名角色拿到牌的期望价值；共生按双方本次能实际恢复的生命总量。
 * sourceId 是互利施放者（决定选牌顺序起点）；其余牌不依赖施放者。
 */
export function assessGlobalBenefit(players, battleTeam, definitionId, sourceId = null, remainingCounts = null) {
  if (!GLOBAL_BENEFIT_CARDS.has(definitionId)) return null;
  const alive = (players ?? []).filter((player) => player?.alive);
  const source = alive.find((player) => player?.id === sourceId) ?? null;
  const result = {
    allyAliveCount:0,
    enemyAliveCount:0,
    allyBenefit:0,
    enemyBenefit:0,
    netBenefit:0
  };
  const draftValues = definitionId === "mutualBenefit"
    ? mutualBenefitDraftValues(alive, source, remainingCounts)
    : {};
  for (const player of alive) {
    const allied = player.battleTeam === battleTeam;
    const benefit = definitionId === "mutualBenefit"
      ? (draftValues[player.id] ?? 0)
      : benefitForPlayer(player, definitionId);
    if (allied) {
      result.allyAliveCount += 1;
      result.allyBenefit += benefit;
    } else {
      result.enemyAliveCount += 1;
      result.enemyBenefit += benefit;
    }
  }
  result.netBenefit = result.allyBenefit - result.enemyBenefit;
  return result;
}

/**
 * 全体受益牌的反制意愿（真实响应与规划模拟共用的同一判断）。
 *
 * root 的最终结局由当前反制链深度奇偶决定：偶数深度 root 生效、奇数深度 root 被取消。
 * stay 是"不再追加反制"时 root 结局对 responder 阵营的 netBenefit，flip 是追加一张
 * 反制翻转结局后的 netBenefit；仅当 (flip - stay) 超过反制牌机会成本才反制。
 *
 * 队友正收益 root 的首张反制保护：depth=0 且 root 由队友打出、root 生效对我方非负时
 * 不得反制（队友 root 生效时己方价值为正，取消只会让己方更差）。该保护必须由
 * parity + root outcome 推导，只约束首张反制：嵌套链中"敌方取消己方牌后的反反制"
 * 与"直接反制队友的牌"是不同语义，不能因为当前 source 是队友就机械放弃。
 */
export function globalBenefitCounterDesire(players, battleTeam, definitionId, options = {}) {
  if (!GLOBAL_BENEFIT_CARDS.has(definitionId)) return null;
  const { rootSourceId = null, counterDepth = 0, remainingCardCounts = null } = options ?? {};
  const assessment = assessGlobalBenefit(players, battleTeam, definitionId, rootSourceId, remainingCardCounts);
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
  // 反制牌机会成本与闪电/封印反制路径同尺度（counter.aiValue × 0.35），只计一次。
  const counterCost = (CARD_DEFINITIONS.counter.aiValue ?? 8) * 0.35;
  return (flip - stay) > counterCost ? 1 : 0;
}

/**
 * 反制牌机会成本：统一只计一次的固定近似。
 *
 * 边界：仍是 legacy 近似（counter.aiValue × 0.35），不是统一分解的完整迁移。之所以
 * 保留：互利的 globalBenefit 模型、封印/闪电状态反制路径与动态 root 框架都使用同一个
 * 0.35 尺度，单独为动态路径换成本会破坏各反制入口之间的成本一致；且统一分解的
 * responseCapacity 项与 stateUtility 单位不对齐，完整迁移会扩大为另一套权重校准。
 * 该近似在每条反制决策路径中只计算一次：stay/flip 两世界本身不消耗反制牌，反制的
 * 资源损失只由这一项表达，因此"本层已花掉的反制"不会与"未来响应容量"重复计价。
 */
export function counterOpportunityCost() {
  return (CARD_DEFINITIONS.counter.aiValue ?? 8) * 0.35;
}

/** 目标级反制（震荡/挑衅）：apply 的群伤循环会命中所有敌人，必须收敛到当前目标。 */
export const TARGET_SCOPE_CARDS = new Set(["shockwave", "provoke"]);

/**
 * 目标级 root 的收敛状态：把"敌人（除当前目标外）"标记为非存活，使 apply 的群伤循环
 * 只命中当前目标；同时把当前目标的剩余反制容量置 0，避免模拟 root 结算时让目标再次
 * 反制把效果概率化。base 与 resolved 两世界都基于同一收敛状态求值，死亡角色的固定
 * 负分在差值中抵消，差值只反映"当前目标上的效果是否发生"。
 */
export function buildTargetScopedBase(simulator, state, rootSourceId, targets) {
  const reduced = simulator.clone(state);
  const source = reduced.players.find((player) => player.id === rootSourceId);
  const targetIds = new Set(targets.map((target) => target.id));
  for (const player of reduced.players) {
    if (player.id === rootSourceId || targetIds.has(player.id)) continue;
    if (source && player.battleTeam !== source.battleTeam) player.alive = false;
  }
  for (const player of reduced.players) {
    if (targetIds.has(player.id)) {
      player.counterCountDistribution = [{ probability:1, conditions:{}, counterCount:0 }];
      player.counterProbability = 0;
    }
  }
  return reduced;
}

/** 转移/借势需要的选择信息；其余卡牌无选择。transfer 的来源/接收者来自规划动作的
 * selection（规划侧）或链上下文的公开来源/接收者（真实响应侧）。 */
function buildRootSelection(rootCard, targets, options = {}) {
  const rootId = rootCard?.definitionId;
  if (rootId === "transfer") {
    const planned = options.selection ?? null;
    if (planned?.sourceId && planned?.receiverId) {
      // 规划动作的 selection 携带确定选牌（selectionKind/cardId/definitionId）；真实响应
      // 侧不携带具体牌（隐私），退回未知转移路径。
      return {
        sourceId:planned.sourceId,
        receiverId:planned.receiverId,
        zone:planned.zone ?? "hand",
        selectionKind:planned.selectionKind ?? null,
        cardId:planned.cardId ?? null,
        definitionId:planned.definitionId ?? null
      };
    }
    const context = options.publicTransferContext ?? null;
    if (!context?.fromPlayerId || !context?.receiverPlayerId) return null;
    return { sourceId:context.fromPlayerId, receiverId:context.receiverPlayerId, zone:context.zone ?? "hand" };
  }
  if (rootId === "leverage") {
    // 借势目标即 [第一目标, 第二目标]；apply 会据此重新检查装备存在性与合法突袭目标。
    return { firstTargetId:targets[0]?.id ?? null, secondTargetId:targets[1]?.id ?? null };
  }
  return null;
}

/**
 * 结算"root 在当前状态生效"后的 after-state（克隆，不改动传入 state）。
 *
 * 当前状态中 root 卡牌已经打出（资源已沉没），但 apply 会把"打出这张牌"的手牌成本
 * 再扣一次。这里先给 root 施放者还原 1 张手牌再走 apply，使资源账目净变化为 0，从而
 * 只体现 root 的效果价值，而不是再次支付一次 root 卡的成本。模拟牌固定为
 * counterable:false：root 的结局已经由本层决策与 parity 决定，不能让 apply 再次按
 * 其他玩家的反制意愿把效果概率化。
 *
 * 结算期间打开 _simulatingRootResolution 守卫：目标级 root（震荡/挑衅）的 apply 群伤
 * 循环会再次调用 counterDesire，若此时再进入动态 root 估值会形成无限递归；守卫使该
 * 调用返回 0（root 结算模拟内部不再评估二次反制）。这是同一 (state, root) 对多个
 * 响应者共享的只读结算，真实侧与规划侧都从这里取 after-state。
 */
export function resolveRootState(simulator, state, rootCard, rootSourceId, targets, options = {}) {
  const previousSimulating = simulator._simulatingRootResolution ?? false;
  simulator._simulatingRootResolution = true;
  try {
    const action = {
      type:"card",
      card:{ ...rootCard, id:`root-sim:${rootCard.id ?? rootCard.definitionId}`, counterable:false },
      targets,
      selection:buildRootSelection(rootCard, targets, options),
      restoreActorHand:true
    };
    return simulator.apply(state, action, rootSourceId);
  } finally {
    simulator._simulatingRootResolution = previousSimulating;
  }
}

/**
 * 计算"追加一张反制翻转 root 结局"的经济收益（FLIP 价值 - STAY 价值）。
 *
 * state 必须是当前响应时刻的可见/模拟状态；rootTargetIds 从该状态重新解析 root 目标
 * （目标可能已死亡、已清空资源或失去装备），绝不复用 root 最初的目标对象。返回 null
 * 表示该 root 属于既有 globalBenefit 模型，不适用本框架。这是只读辅助函数，可直接
 * 作为测试探针验证"root resolve 使用当前 response-state"。
 */
export function dynamicRootFlipGain(evaluator, simulator, state, responderId, rootCard, rootSourceId, counterDepth, rootTargetIds, options = {}) {
  const definitionId = rootCard?.definitionId;
  if (!definitionId || rootCard.category !== "tactic" || GLOBAL_BENEFIT_CARDS.has(definitionId)) return null;
  const actor = state.players.find((player) => player.id === rootSourceId);
  if (!actor?.alive) return 0;
  const targets = (rootTargetIds ?? [])
    .map((id) => state.players.find((player) => player.id === id))
    .filter((target) => target?.alive);
  const resolvesAtStay = (counterDepth % 2) === 0;
  const baseState = TARGET_SCOPE_CARDS.has(definitionId)
    ? buildTargetScopedBase(simulator, state, rootSourceId, targets)
    : state;
  const resolvedState = resolveRootState(simulator, baseState, rootCard, rootSourceId, targets, options);
  const baseValue = evaluator.stateUtility(baseState, responderId);
  const resolvedValue = evaluator.stateUtility(resolvedState, responderId);
  const rootEffectValue = resolvedValue - baseValue;
  return resolvesAtStay ? -rootEffectValue : rootEffectValue;
}

// 注意：本文件不导入 AiSimulator（simulator 由调用方注入，见 dynamicRootFlipGain 签名），
// 避免与 AiSimulator 的 globalBenefitCounterDesire / mutualBenefitDraftValues 导入形成
// 循环依赖。真实响应链的游戏侧入口（构建可见状态 + new AiSimulator）位于 AiResponsePolicy。
