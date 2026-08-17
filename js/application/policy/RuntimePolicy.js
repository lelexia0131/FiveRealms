/*
模块职责
唯一拥有不属于 Domain Ruleset 的应用响应等待、展示节奏、调试与会话运行策略。

上游
composition root、Application timing/response/turn consumers 与 presentation timing helper。

下游
无。

状态边界
纯静态只读策略，不读取或写入 MatchState。

信息边界
全部字段均为公开产品配置，不含对局隐藏信息。

架构约束
不得复制 Ruleset、Card、Character、Skill 或 AI 搜索策略；展示与真实游戏 RNG 仍相互独立。
*/

export const RUNTIME_POLICY = Object.freeze({
  // null 表示真人响应窗口无限等待；正有限毫秒只改变等待/fallback，不改变响应合法性。
  responseTimeoutMs: null,
  debugMode: false,

  aiInitialThinkMinMs: 3000,
  aiInitialThinkMaxMs: 5500,
  aiBetweenActionMinMs: 1800,
  aiBetweenActionMaxMs: 3500,
  aiResponseThinkMinMs: 1800,
  aiResponseThinkMaxMs: 3200,
  aiDiscardThinkMinMs: 1600,
  aiDiscardThinkMaxMs: 2800,
  aiEndThinkMinMs: 900,
  aiEndThinkMaxMs: 1600,
  aiComplexThinkMaxMs: 7000,
  animationFastMode: false,
  animationFastScale: 0.08,
  animationFastMinimumMs: 0,
  simulationMode: false
});
