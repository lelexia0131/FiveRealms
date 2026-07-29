/**
 * 集中保存规则、AI 搜索与展示节奏参数。
 *
 * 调整原则：人数、牌量和每回合额度会直接改变平衡；延迟只改变可读节奏；
 * 搜索深度、宽度、采样数和预算会同时影响 AI 强度与浏览器负载。规则模块不得
 * 在别处复制这些数字，模拟和真人对局也必须读取同一份配置。
 */
export const GAME_CONFIG = Object.freeze({
  // 固定五人桌；其他值需要同步重做阵营、座位和 UI，当前不建议修改。
  playerCount: 5,
  // 少人数阵营规模；提高会改变补偿归属并破坏 2V3，当前只能为 2。
  smallTeamSize: 2,
  // 多人数阵营规模；与 playerCount-smallTeamSize 一致，当前只能为 3。
  largeTeamSize: 3,
  // 真人可选角色数；1～8 可运行，越大选择更充分但征召页更拥挤。
  generalCandidateCount: 4,
  // 是否允许同局重复角色；开启会削弱角色辨识度并让技能叠加更难平衡。
  allowDuplicateGenerals: false,
  // 基础初始牌；推荐 3～5，增大会提高首轮爆发并加快首次重洗。
  initialHandCount: 4,
  // 每回合摸牌数；推荐 1～3，增大会放宽资源压力并延长弃牌操作。
  defaultDrawCount: 2,
  // 默认能量上限；推荐 3～5，改变后需复核所有主动技能成本。
  defaultMaxEnergy: 3,
  // 普通突袭射程；当前动态存活环以 1 为核心，增大会明显削弱座位战术。
  defaultAttackRange: 1,
  // 真人响应窗口毫秒数；推荐 8000～20000，只影响操作宽容度，不改 AI 合法性。
  responseTimeoutMs: 12000,
  // 单回合动作安全上限；降低可能截断合法连招，提高会放大异常循环风险。
  aiMaxActionsPerTurn: 16,
  // 首轮编号；仅影响展示和轮次标记，通常保持 1。
  initialRound: 1,
  // 赌命者被动成功率；0～1，增大会直接增强该角色并影响阵营胜率。
  gamblerDrawChance: 0.6,
  // 刃行者连势上限；推荐 1～3，增大会显著提高连续出牌爆发。
  momentumMaxStacks: 2,
  // 调试输出总开关；开启只增加诊断日志，不应改变规则或随机过程。
  debugMode: false,

  // 二人阵营的集中补偿；null 是“无限调息”的唯一表达，不得改成魔法大数。
  smallTeamBonuses: Object.freeze({
    // 每名小队成员额外初始牌；推荐 0～2，增大会提高首轮稳定性。
    extraInitialCards: 1,
    // 每个出牌阶段主动突袭上限；用户规则固定为 2，修改会直接破坏平衡契约。
    attackLimitPerTurn: 2,
    // null 表示主动调息不限次数，但仍受受伤与手牌约束。
    recoverLimitPerTurn: null,
    // 自己回合能量总基础值；固定为 2，装备加成在服务层另算。
    turnEnergyGain: 2
  }),
  // 三人阵营基准规则；与小队补偿并列，避免各模块重复判断人数。
  largeTeamRules: Object.freeze({
    // 大队不获得额外初始牌。
    extraInitialCards: 0,
    // 每个出牌阶段主动突袭一次；提高会放大人数优势。
    attackLimitPerTurn: 1,
    // 每个出牌阶段主动调息一次；null 才表示无限。
    recoverLimitPerTurn: 1,
    // 自己回合获得 1 点基础能量。
    turnEnergyGain: 1
  }),

  // 以下均为毫秒范围；调高只延长自然模式阅读时间，调低会让动作显得跳跃。
  // 首次分析推荐 1800～4500ms，复杂局面可由 aiComplexThinkMaxMs 延长。
  aiInitialThinkMinMs: 1800,
  aiInitialThinkMaxMs: 3500,
  // 连续动作间的重规划展示，推荐 800～2500ms。
  aiBetweenActionMinMs: 1000,
  aiBetweenActionMaxMs: 2200,
  // 格挡、反制、救援等响应思考，推荐 800～2500ms。
  aiResponseThinkMinMs: 1000,
  aiResponseThinkMaxMs: 2200,
  // 弃牌思考，推荐 600～2000ms。
  aiDiscardThinkMinMs: 1000,
  aiDiscardThinkMaxMs: 1800,
  // 结束出牌前停顿，推荐 350～1200ms。
  aiEndThinkMinMs: 500,
  aiEndThinkMaxMs: 1000,
  // 高复杂度自然模式最长展示；过高会让玩家误以为页面卡住。
  aiComplexThinkMaxMs: 4500,
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

export const TEAM_CONFIG = Object.freeze({
  dawn: Object.freeze({ id: "dawn", name: "晨星阵营", shortName: "晨星" }),
  dusk: Object.freeze({ id: "dusk", name: "暮影阵营", shortName: "暮影" })
});

export const PHASE_NAMES = Object.freeze({
  idle: "等待", turnStart: "回合开始", status: "状态处理", energy: "获得能量",
  draw: "摸牌", play: "出牌", dying: "濒死救援", judgment: "装置判定",
  discard: "弃牌", turnEnd: "回合结束", gameOver: "对局结束"
});
