/*
模块职责
唯一拥有 FiveRealms 全局静态领域规则参数（含 deckComposition 与 initialRound）；不含 AI 搜索、UI 时序、调试或运行时行为。

上游
Domain rules 与 Application match consumers。

下游
无。

状态边界
纯静态事实，不读取或写入运行时状态。

信息边界
全部字段均为公开规则事实，无隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game 或任何 runtime 模块。
*/

export const RULESET_DEFINITION = Object.freeze({
  // 固定五人桌；其他值需要同步重做阵营、座位和 UI，当前不建议修改。
  playerCount: 5,
  // 少人数阵营规模；提高会改变补偿归属并破坏 2V3，当前只能为 2。
  smallTeamSize: 2,
  // 多人数阵营规模；与 playerCount-smallTeamSize 一致，当前只能为 3。
  largeTeamSize: 3,
  // 真人可选角色数；1～8 可运行，越大选择更充分但征召页更拥挤。
  characterCandidateCount: 4,
  // 是否允许同局重复角色；开启会削弱角色辨识度并让技能叠加更难平衡。
  allowDuplicateCharacters: false,
  // 三人阵营默认初始牌；二人阵营由 smallTeamBonuses.initialHandCount 覆盖。
  initialHandCount: 4,
  // 三人阵营默认每回合摸牌数；二人阵营由 smallTeamBonuses.drawCountPerTurn 覆盖。
  defaultDrawCount: 2,
  // 默认能量上限；推荐 3～5，改变后需复核所有主动技能成本。
  defaultMaxEnergy: 3,
  // 普通突袭射程；当前动态存活环以 1 为核心，增大会明显削弱座位战术。
  defaultAttackRange: 1,
  // 一局游戏进入 Match State 时的初始轮数；会进入 roundStart/roundEnd 与回合推进。
  initialRound: 1,
  // 合法击杀敌方角色后的额外摸牌数；真实死亡结算与 AI 模拟统一读取。
  killRewardDrawCount: 1,

  // 当前 Ruleset 的牌堆组成 authority；Card Definition 自身不拥有数量。
  deckComposition: Object.freeze({
    assault: 40,
    recover: 12,
    block: 20,
    charge: 10,
    shield: 10,
    scout: 6,
    transfer: 2,
    exposeWeakness: 6,
    shockwave: 3,
    provoke: 3,
    leverage: 3,
    plunder: 5,
    destroy: 6,
    counter: 7,
    harvest: 4,
    duel: 3,
    mutualBenefit: 2,
    symbiosis: 1,
    seal: 3,
    lightning: 2,
    energyDevice: 2,
    recycleDevice: 3,
    defenseDevice: 2,
    battleDevice: 2,
    assaultMagazine: 1,
    telescope: 3,
    barrierDevice: 3
  }),

  // 二人阵营的集中补偿；null 是“无限调息”的唯一表达，不得改成魔法大数。
  smallTeamBonuses: Object.freeze({
    // 每名小队成员开局总手牌数；当前规则固定为 5。
    initialHandCount: 5,
    // 二人阵营每回合摸3张牌。
    drawCountPerTurn: 3,
    // 每个出牌阶段主动突袭上限；用户规则固定为 2，修改会直接破坏平衡契约。
    attackLimitPerTurn: 2,
    // null 表示主动调息不限次数，但仍受受伤与手牌约束。
    recoverLimitPerTurn: null,
    // 自己回合获得的基础能量；装备加成在服务层另算。
    turnEnergyGain: 1,
    // 阵营额外能量；当前两种阵营均无额外加成，保留字段供事件分项展示。
    turnEnergyBonus: 0,
    // 二人小队的能量上限；所有能量来源统一受该值约束。
    maxEnergy: 4
  }),
  // 三人阵营基准规则；与小队补偿并列，避免各模块重复判断人数。
  largeTeamRules: Object.freeze({
    // 每名大队成员开局总手牌数；默认保持 4。
    initialHandCount: 4,
    // 三人阵营每回合摸2张牌。
    drawCountPerTurn: 2,
    // 每个出牌阶段主动突袭一次；提高会放大人数优势。
    attackLimitPerTurn: 1,
    // null 表示主动调息不限次数，但仍受受伤与手牌约束。
    recoverLimitPerTurn: null,
    // 自己回合获得 1 点基础能量。
    turnEnergyGain: 1,
    // 阵营额外能量；当前两种阵营均无额外加成，保留字段供事件分项展示。
    turnEnergyBonus: 0,
    // 三人阵营的能量上限；所有能量来源统一受该值约束。
    maxEnergy: 3
  })
});
