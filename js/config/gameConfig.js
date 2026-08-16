/**
 * 旧混合配置 façade。领域规则值已由 domain/definitions/ruleset/RulesetDefinition.js 单一拥有；
 * 本文件继续保留 AI 搜索、展示节奏、调试与产品行为参数，直到后续阶段迁移。
 */
import { RULESET_DEFINITION } from "../domain/definitions/ruleset/RulesetDefinition.js?build=20260816-fr-arch-14-runtime-closure";

export const GAME_CONFIG = Object.freeze({
  playerCount: RULESET_DEFINITION.playerCount,
  smallTeamSize: RULESET_DEFINITION.smallTeamSize,
  largeTeamSize: RULESET_DEFINITION.largeTeamSize,
  generalCandidateCount: RULESET_DEFINITION.generalCandidateCount,
  allowDuplicateGenerals: RULESET_DEFINITION.allowDuplicateGenerals,
  initialHandCount: RULESET_DEFINITION.initialHandCount,
  defaultDrawCount: RULESET_DEFINITION.defaultDrawCount,
  defaultMaxEnergy: RULESET_DEFINITION.defaultMaxEnergy,
  defaultAttackRange: RULESET_DEFINITION.defaultAttackRange,
  // 真人响应窗口默认无限等待；正有限毫秒只改变 UI/Application 等待与 fallback，不改变响应合法性。
  // 该值当前属于 Application/Presentation runtime policy，不属于 Domain Ruleset。
  responseTimeoutMs: null,

  // 是否强制同阵营 AI 队友救援濒死真人。该参数是 AI 产品行为，暂不属 Domain Ruleset。
  forceAiRescueHuman: true,
  // 单回合动作安全上限；降低可能截断合法连招，提高会放大异常循环风险。
  aiMaxActionsPerTurn: 16,
  // 一局 Match State 的初始轮号，由 Domain Ruleset 唯一拥有。
  initialRound: RULESET_DEFINITION.initialRound,

  gamblerDrawChance: RULESET_DEFINITION.gamblerDrawChance,
  momentumMaxStacks: RULESET_DEFINITION.momentumMaxStacks,
  killRewardDrawCount: RULESET_DEFINITION.killRewardDrawCount,

  // 调试输出总开关；开启只增加诊断日志，不应改变规则或随机过程。
  debugMode: false,

  // 二人阵营的集中补偿对象由 Domain Ruleset 唯一拥有。
  smallTeamBonuses: RULESET_DEFINITION.smallTeamBonuses,
  // 三人阵营基准规则对象由 Domain Ruleset 唯一拥有。
  largeTeamRules: RULESET_DEFINITION.largeTeamRules,

  // 以下均为毫秒范围；调高只延长自然模式阅读时间，调低会让动作显得跳跃。
  // 回合首次可见思考；与下方搜索计算预算分离，不改变 AI 决策强度。
  aiInitialThinkMinMs: 3000,
  aiInitialThinkMaxMs: 5500,
  // 连续动作之间的可见重规划停顿。
  aiBetweenActionMinMs: 1800,
  aiBetweenActionMaxMs: 3500,
  // 格挡、反制、救援等响应的可见考虑时间。
  aiResponseThinkMinMs: 1800,
  aiResponseThinkMaxMs: 3200,
  // 弃牌前的可见思考时间。
  aiDiscardThinkMinMs: 1600,
  aiDiscardThinkMaxMs: 2800,
  // 结束出牌前的短暂停顿。
  aiEndThinkMinMs: 900,
  aiEndThinkMaxMs: 1600,
  // 高复杂度自然模式最长展示；过高会让玩家误以为页面卡住。
  aiComplexThinkMaxMs: 7000,
  // 默认关闭快速动画；开启不应改变规则、随机源或合法动作。
  animationFastMode: false,
  // 快速模式时间倍率；推荐 0.03～0.25，越小越接近无等待。
  animationFastScale: 0.08,
  // 快速模式最短延迟；保持 0 便于自动模拟，增大只影响展示。
  animationFastMinimumMs: 0,
  // 无 DOM 模拟标记；只关闭视觉等待，不能绕过规则。
  simulationMode: false,

  // 束搜索最大动作深度；推荐 3～5，增大呈指数增加计算量。
  aiSearchDepth: 4,
  // 每层保留候选数；推荐 8～12，增大更稳但会提高 CPU 占用。
  aiBeamWidth: 10,
  // 每次规划的未知手牌世界采样数；推荐 6～20，不能用真实隐藏牌替代。
  aiHiddenStateSamples: 10,
  // 单次规划时间预算；推荐 400～1500ms，到点必须返回当前最佳动作。
  aiSearchTimeBudgetMs: 900,
  // 每个真实动作后重新读取状态并规划，关闭会让动态距离和手牌变化失效。
  aiReplanAfterEveryAction: true,
  // 展开若干节点后让出事件循环；越小越流畅但调度开销更高，推荐 24～96。
  aiSearchYieldEvery: 48,
  // 分数差小于该值视为近似同分；增大会增加风格变化与次优选择。
  aiNearTieRange: 0.35,
  // 仅在近似同分时允许随机选择；关闭可获得完全确定的同局策略。
  enableAiRandomness: true,
  // 预留的小幅随机扰动范围；推荐 0～0.1，过大会掩盖效用评分。
  aiRandomnessRange: 0.035,
  // AI 难度总倍率接口；当前 1 为标准，调整前需配合评估权重验证。
  aiDifficultyMultiplier: 1
});

/*
功能
提供 FR-ARCH-14 的 named AI search profiles；搜索 deadline 与 watchdog 是 AI runtime/product policy，不属于 Domain Ruleset。
*/
export const AI_SEARCH_PROFILES = Object.freeze({
  FAST: Object.freeze({
    softTargetMs: 500,
    searchDeadlineMs: 900,
    hardWatchdogMs: 5000
  }),
  NORMAL: Object.freeze({
    softTargetMs: null,
    searchDeadlineMs: 3000,
    hardWatchdogMs: 10000
  })
});

export const TEAM_CONFIG = Object.freeze({
  dawn: Object.freeze({ id: "dawn", name: "晨星阵营", shortName: "晨星" }),
  dusk: Object.freeze({ id: "dusk", name: "暮影阵营", shortName: "暮影" })
});

export const PHASE_NAMES = Object.freeze({
  idle: "等待", turnStart: "回合开始", status: "状态处理", energy: "获得能量",
  draw: "摸牌", play: "出牌", dying: "濒死救援", judgment: "判定",
  discard: "弃牌", turnEnd: "回合结束", gameOver: "对局结束"
});
