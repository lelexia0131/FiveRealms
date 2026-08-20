/*
模块职责
唯一拥有 AI 决策、搜索预算、随机扰动与搜索执行 profile 的静态产品策略。

上游
AIController、AI policy/search 与 composition root。

下游
无。

状态边界
纯静态只读配置，不读取或写入 MatchState/SearchState。

信息边界
不含对局信息、领域规则、展示文案或设备状态。

架构约束
不得复制 Domain rules/definitions；只配置 AI 如何搜索与选择，不决定动作合法性或效果。
*/

export const AI_RUNTIME_POLICY = Object.freeze({
  forceAiRescueHuman:true,
  maxActionsPerTurn:16,
  searchDepth:4,
  beamWidth:10,
  hiddenStateSamples:10,
  searchTimeBudgetMs:900,
  replanAfterEveryAction:true,
  searchYieldEvery:48,
  nearTieRange:0.35,
  enableRandomness:true,
  randomnessRange:0.035,
  difficultyMultiplier:1
});

export const AI_SEARCH_PROFILE = Object.freeze({
  mode:"NORMAL",
  softTargetMs:null,
  // SearchBudget 先按本次显式预算收束；Worker normal deadline 只留候选物化与 transport 的小幅技术余量。
  searchDeadlineMarginMs:100,
  hardWatchdogMs:10000
});
