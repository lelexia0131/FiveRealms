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
import { getBaseCardAiValue, getRoleCardAiValue } from "./value/CardValue.js?build=20260814-ai-simulation-engine";
import {
  assessGlobalBenefitOutcome,
  buildMutualBenefitDraftOutcome,
  isGlobalBenefitCard
} from "./domain/GlobalBenefitModel.js?build=20260814-ai-simulation-engine";
import {
  counterOpportunityCost as responseCounterOpportunityCost,
  globalBenefitCounterDesire as decideGlobalBenefitCounter
} from "./policy/ResponsePolicy.js?build=20260814-ai-simulation-engine";

/** 角色对该牌的有效价值；缺少角色身份时回退全局基础值。 */
function cardValueFor(generalId, definitionId) {
  if (!generalId) return getBaseCardAiValue(definitionId);
  try {
    return getRoleCardAiValue(generalId, definitionId);
  } catch {
    return getBaseCardAiValue(definitionId);
  }
}

/*
功能
保留互利每名接收者价值摘要的历史签名并委托正式 GlobalBenefitModel。

调用方
AiSimulator、历史测试与迁移期调用方。

输入
玩家、来源与公开剩余牌计数。

输出
以玩家 ID 为键的期望选牌价值对象。

读取状态
玩家角色 ID 与正式 CardValue。

写入状态
无。

调用函数
domain/GlobalBenefitModel.buildMutualBenefitDraftOutcome、cardValueFor。

边界与不变量
座次、公开池消耗与 recipient 算法只存在于正式 Domain owner；本适配器只注入价值并投影旧输出。
*/
export function mutualBenefitDraftValues(players, source, remainingCounts) {
  const playersById = new Map((players ?? []).map((player) => [player.id, player]));
  const outcome = buildMutualBenefitDraftOutcome(
    players,
    source,
    remainingCounts,
    (playerId, definitionId) => cardValueFor(
      playersById.get(playerId)?.generalId,
      definitionId
    )
  );
  return Object.fromEntries(
    outcome.recipients.map((recipient) => [recipient.playerId, recipient.benefit])
  );
}

/*
功能
保留全体受益牌团队价值摘要的历史签名并委托正式 GlobalBenefitModel。

调用方
Controller、Response façade、SearchPrior、AiSimulator 与历史测试。

输入
玩家、观察阵营、定义 ID、来源 ID 与公开剩余牌计数。

输出
非全体受益牌为 null，否则返回历史团队计数与净受益字段。

读取状态
玩家公开字段与正式 CardValue。

写入状态
无。

调用函数
domain/GlobalBenefitModel.assessGlobalBenefitOutcome、cardValueFor。

边界与不变量
Domain 拥有座次/recipient/受益结构；本适配器只注入价值并移除新增结构字段以保持兼容。
*/
export function assessGlobalBenefit(players, battleTeam, definitionId, sourceId = null, remainingCounts = null) {
  const playersById = new Map((players ?? []).map((player) => [player.id, player]));
  const result = assessGlobalBenefitOutcome(players, battleTeam, definitionId, {
    sourceId,
    remainingCounts,
    definitionValue:(playerId, candidateDefinitionId) => cardValueFor(
      playersById.get(playerId)?.generalId,
      candidateDefinitionId
    )
  });
  if (!result) return null;
  return {
    allyAliveCount:result.allyAliveCount,
    enemyAliveCount:result.enemyAliveCount,
    allyBenefit:result.allyBenefit,
    enemyBenefit:result.enemyBenefit,
    netBenefit:result.netBenefit
  };
}

/*
功能
保留全体受益牌反制意愿的历史函数签名并委托正式 ResponsePolicy owner。

调用方
AiSimulator、历史测试与迁移期调用方。

输入
公开玩家、响应阵营、root 定义和反制链上下文。

输出
非全体受益牌为 null，否则为零或一。

读取状态
只读公开玩家、Belief 与本文件的 GlobalBenefit assessment adapter。

写入状态
无。

调用函数
policy/ResponsePolicy.globalBenefitCounterDesire、assessGlobalBenefit。

边界与不变量
反制 parity、队友首层保护和成本公式只存在于正式 Policy。
*/
export function globalBenefitCounterDesire(players, battleTeam, definitionId, options = {}) {
  return decideGlobalBenefitCounter(
    assessGlobalBenefit,
    players,
    battleTeam,
    definitionId,
    options
  );
}

/*
功能
保留反制机会成本的历史入口并委托正式 ResponsePolicy owner。

调用方
AiSimulator、动态 root 测试与迁移期调用方。

输入
无。

输出
冻结的反制机会成本。

读取状态
正式 Policy 的 CardValue 尺度。

写入状态
无。

调用函数
policy/ResponsePolicy.counterOpportunityCost。

边界与不变量
本文件不得复制 counter.aiValue × 0.35 公式。
*/
export function counterOpportunityCost() {
  return responseCounterOpportunityCost();
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

/*
功能
计算追加一张反制翻转 root 结局的经济收益。

调用方
AiValueSimulationQuery、历史测试与迁移期调用方。

输入
Evaluator、注入 Simulator、当前响应状态、响应者、root 卡与来源/深度/目标上下文。

输出
全体受益牌或非法 root 为 null，否则返回 FLIP 价值减 STAY 价值。

读取状态
当前响应时刻的过滤/模拟状态与实时 root 目标。

写入状态
仅由注入 Simulator 写入独立克隆。

调用函数
domain/GlobalBenefitModel.isGlobalBenefitCard、buildTargetScopedBase、resolveRootState、Evaluator.stateUtility。

边界与不变量
不得复用 root 初始目标快照；全体受益牌由正式 Domain/Policy 路径处理，本函数不构造 Simulator。
*/
export function dynamicRootFlipGain(evaluator, simulator, state, responderId, rootCard, rootSourceId, counterDepth, rootTargetIds, options = {}) {
  const definitionId = rootCard?.definitionId;
  if (!definitionId || rootCard.category !== "tactic" || isGlobalBenefitCard(definitionId)) return null;
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
