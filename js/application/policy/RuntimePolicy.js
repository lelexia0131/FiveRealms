/*
模块职责
唯一拥有不属于 Domain Ruleset 的应用响应等待、AI 单步思考窗口、展示节奏、调试与会话运行策略。

上游
composition root、Application timing/response/turn consumers 与 presentation timing helper。

下游
无。

状态边界
纯静态只读策略，不读取或写入 MatchState。

信息边界
全部字段均为公开产品配置，不含对局隐藏信息。

架构约束
不得复制 Ruleset、Card、Character、Skill 或 AI 搜索算法；思考窗口只能由 composition 作为显式毫秒预算交给 AI，timing RNG 与真实游戏/搜索 RNG 仍相互独立。
*/

export const RUNTIME_POLICY = Object.freeze({
  // null 表示真人响应窗口无限等待；正有限毫秒只改变等待/fallback，不改变响应合法性。
  responseTimeoutMs: null,
  debugMode: false,
  defaultAiSpeed: 1,
  aiRawThinkingRanges: Object.freeze({
    initial: Object.freeze({ minimumMs:3000, maximumMs:5500, complexMaximumMs:7000 }),
    action: Object.freeze({ minimumMs:1800, maximumMs:3500 }),
    response: Object.freeze({ minimumMs:1800, maximumMs:3200 }),
    discard: Object.freeze({ minimumMs:1600, maximumMs:2800 }),
    end: Object.freeze({ minimumMs:900, maximumMs:1600 })
  }),
  simulationMode: false
});

export const AI_PACING = Object.freeze({
  1: Object.freeze({ baseMinMs:1800, baseMaxMs:3000, minJitter:0.25, maxJitter:0.20 }),
  2: Object.freeze({ baseMinMs:900, baseMaxMs:1500, minJitter:0.20, maxJitter:0.20 }),
  3: Object.freeze({ baseMinMs:600, baseMaxMs:1000, minJitter:0.15, maxJitter:0.15 })
});
