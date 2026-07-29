/**
 * 本文件集中保存对局流程、节奏与平衡参数，不负责读取 UI 或执行规则。
 * 业务模块只应读取这些值；若新增可调数值，应先在此记录用途与安全范围。
 * 修改阵营人数时必须保证两队总人数等于 playerCount，否则 TeamManager 会拒绝启动。
 */

export const GAME_CONFIG = Object.freeze({
  /** 总座位数。增大会延长每轮并放大牌堆消耗，减小会削弱阵营配合；推荐固定为 5，改动会影响布局和组队逻辑。 */
  playerCount: 5,
  /** 小队人数。增大时补偿覆盖更多角色，减小时小队更脆弱；推荐 2，必须小于 largeTeamSize。 */
  smallTeamSize: 2,
  /** 大队人数。增大会提高人数优势，减小会缩小目标数量；推荐 3，与 smallTeamSize 之和必须等于 5。 */
  largeTeamSize: 3,
  /** 真人可选角色数。增大可提升选择自由但占用更多界面，减小会降低策略；推荐 3～5，不得超过角色池。 */
  generalCandidateCount: 4,
  /** 是否允许重复角色。开启会增加组合波动，关闭便于辨认；推荐 false，改动不会破坏流程但会影响平衡。 */
  allowDuplicateGenerals: false,

  /** 常规初始手牌。增大提升开局选择并加速牌堆消耗，减小会使前期空转；推荐 3～5。 */
  initialHandCount: 4,
  /** 小队每名成员的额外初始牌。增大显著补强二人队，减小会放大人数劣势；推荐 0～2，可设为 0 关闭。 */
  smallTeamBonusCards: 1,
  /** 默认摸牌数。增大提高行动密度并增加弃牌，减小使资源紧张；推荐 1～3，过高可能令 AI 回合变长。 */
  defaultDrawCount: 2,

  /** 默认能量上限。增大可囤积更多爆发，减小会使高耗技能无法使用；推荐固定为 3，低于 3 会破坏部分技能。 */
  defaultMaxEnergy: 3,
  /** 每回合突袭次数。增大提高爆发并削弱防守，减为 0 会禁用普通攻击；推荐 1，技能可临时修改。 */
  defaultAttackLimitPerTurn: 1,
  /** 每回合调息次数。增大会拖长对局，减为 0 会禁用恢复牌；推荐 1。 */
  defaultRecoverLimitPerTurn: 1,

  /** 真人响应等待毫秒数。增大给思考留出更多时间，减小节奏更快；推荐 5000～15000，过低影响可操作性。 */
  responseTimeoutMs: 10000,
  /** AI 回合首次观察战场的思考范围。 */
  aiInitialThinkMinMs: 900,
  aiInitialThinkMaxMs: 1700,
  /** AI 连续动作、公开行动意图之间的停顿范围。 */
  aiBetweenActionMinMs: 650,
  aiBetweenActionMaxMs: 1200,
  /** AI 决定是否格挡、反制、转移或护援的思考范围。 */
  aiResponseThinkMinMs: 700,
  aiResponseThinkMaxMs: 1400,
  /** AI 弃牌阶段的思考范围。 */
  aiDiscardThinkMinMs: 700,
  aiDiscardThinkMaxMs: 1200,
  /** AI 收束并结束出牌阶段的短暂停顿范围。 */
  aiEndThinkMinMs: 350,
  aiEndThinkMaxMs: 700,
  /** 默认是否启用快速动画；它只缩短展示等待，不改变决策结果。 */
  animationFastMode: false,
  /** 快速模式等待倍率与最低可读停顿。 */
  animationFastScale: 0.18,
  animationFastMinimumMs: 55,
  /** AI 单个出牌阶段最大动作数。增大允许更长连锁，减小可能提前结束；推荐 8～16，用于防止无穷循环。 */
  aiMaxActionsPerTurn: 12,

  /** 是否为同分 AI 行动加入随机扰动。开启增加重玩性，关闭便于测试；不会绕过合法性检查。 */
  enableAiRandomness: true,
  /** AI 评分随机幅度比例。增大更不可预测，减小更稳定；推荐 0～0.2，过高可能选择明显次优行动。 */
  aiRandomnessRange: 0.12,
  /** AI 整体评分倍率。增大强化主动行动意愿，减小更保守；推荐 0.8～1.25，不改变规则合法性。 */
  aiDifficultyMultiplier: 1,

  /** 赌命者冒险摸牌概率。增大提高收益，减小增加风险；推荐 0.5～0.7，必须位于 0～1。 */
  gamblerDrawChance: 0.6,
  /** 连势最大层数。增大显著提升刃行者爆发，减小会削弱技能；推荐固定为 2。 */
  momentumMaxStacks: 2,
  /** 首轮编号，仅影响显示和每轮标记初始化；推荐固定为 1。 */
  initialRound: 1,
  /** 是否输出详细调试轨迹。开启便于排错但输出很多，关闭保持控制台干净；不影响胜负。 */
  debugMode: false
});

export const TEAM_CONFIG = Object.freeze({
  dawn: Object.freeze({ id: "dawn", name: "晨星阵营", shortName: "晨星" }),
  dusk: Object.freeze({ id: "dusk", name: "暮影阵营", shortName: "暮影" })
});

export const PHASE_NAMES = Object.freeze({
  idle: "等待",
  turnStart: "回合开始",
  status: "状态处理",
  draw: "摸牌",
  play: "出牌",
  discard: "弃牌",
  turnEnd: "回合结束",
  gameOver: "对局结束"
});
