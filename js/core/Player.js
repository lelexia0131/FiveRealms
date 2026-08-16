/**
 * 本文件定义单个座位的运行时玩家状态，依赖 gameConfig.js 与角色配置数据。
 * Player 只保存数据并提供安全的资源变更，不决定目标合法性、伤害响应或胜负。
 * 每局都会重新创建 Player，因此无需跨局保留实例。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260815-shadow-agent-p1-slot";
import { createPlayerState } from "../domain/state/model/PlayerState.js?build=20260815-shadow-agent-p1-slot";
import { clamp } from "../utils/helpers.js?build=20260815-shadow-agent-p1-slot";

export class Player {
  /*
  功能
  创建一个 legacy composite Player runtime，其领域字段由 Domain PlayerState factory 提供。

  调用方
  Game.startSelection 与测试 fixture。

  输入
  id、seatIndex、controllerType 与 battleTeam。

  输出
  初始化完成的 Player 实例。

  读取状态
  Domain PlayerState 初始 shape。

  写入状态
  Player 领域字段与 legacy extension 字段。

  调用函数
  createPlayerState。

  边界与不变量
  controllerType 属于 Application participant metadata；aiMemory 属于 AI adapter state；两者均作为 legacy extension 保留，不进入 Domain PlayerState。
  */
  constructor(options) {
    const playerState = createPlayerState({
      id: options.id,
      seatIndex: options.seatIndex,
      battleTeam: options.battleTeam
    });
    this.id = playerState.id;
    this.seatIndex = playerState.seatIndex;
    this.controllerType = options.controllerType;
    this.battleTeam = playerState.battleTeam;
    this.generalId = playerState.generalId;
    this.name = playerState.name;
    this.loreFaction = playerState.loreFaction;
    this.general = playerState.general;
    this.hp = playerState.hp;
    this.maxHp = playerState.maxHp;
    this.shield = playerState.shield;
    this.energy = playerState.energy;
    this.maxEnergy = playerState.maxEnergy;
    this.attackRange = playerState.attackRange;
    this.hand = playerState.hand;
    this.handVersion = playerState.handVersion;
    this.equipment = playerState.equipment;
    this.statuses = playerState.statuses;
    this.alive = playerState.alive;
    this.turnFlags = {};
    this.roundFlags = {};
    this.gameFlags = {};
    this.statistics = { damageDealt: 0, healingDone: 0, cardsPlayed: 0, damageTaken: 0, assaultsUsed: 0 };
    this.aiMemory = { revealedCardsByPlayer: {}, knownCardsByPlayer: {}, recentAggressors: {} };
  }

  /**
   * 将角色配置应用到座位并恢复至满生命、初始能量。只在角色分配阶段调用，会修改玩家状态。
   * @param {Object} general 角色配置。
   * @returns {void}
   */
  applyGeneral(general) {
    this.general = general;
    this.generalId = general.id;
    this.name = general.name;
    this.loreFaction = general.loreFaction;
    this.maxHp = general.maxHp;
    this.hp = general.maxHp;
    this.energy = general.initialEnergy ?? 0;
  }

  /** 重置每回合次数与技能标记；TurnManager 在回合开始调用。 */
  resetTurnFlags(teamRules = null) {
    this.turnFlags = {
      attackUsed: 0,
      attackLimit: teamRules?.attackLimitPerTurn ?? GAME_CONFIG.largeTeamRules.attackLimitPerTurn,
      recoverUsed: 0,
      recoverLimit: teamRules ? teamRules.recoverLimitPerTurn : GAME_CONFIG.largeTeamRules.recoverLimitPerTurn,
      categoriesUsed: new Set(),
      momentum: 0,
      activeSkillsUsed: new Set(),
      activeSkillUseCounts: {},
      recycleDeviceUses: 0,
      guardianAidUsed: false,
      coordinationTriggered: false,
      gambleTriggered: false,
      rejuvenationTriggerCount: 0,
      spyGapTriggered: false,
      spyGapPendingTargetIds: new Set(),
      trackingTargetIds: new Set(),
      skipActionPhase: false
    };
  }

  /**
   * 重置所有角色都可能在任意玩家回合触发的“每回合”被动额度；
   * Game 在每个新全局回合开始时对全部玩家调用一次，必须在 turnStart 监听器执行前完成。
   * 不触碰 actor-turn state（攻击次数、主动技能次数、调息次数、skipActionPhase 等）。
   */
  resetGlobalTurnReactiveFlags() {
    this.turnFlags.categoriesUsed = new Set();
    this.turnFlags.momentum = 0;
    this.turnFlags.guardianAidUsed = false;
    this.turnFlags.coordinationTriggered = false;
    this.turnFlags.gambleTriggered = false;
    this.turnFlags.rejuvenationTriggerCount = 0;
    this.turnFlags.spyGapTriggered = false;
    this.turnFlags.spyGapPendingTargetIds = new Set();
    this.turnFlags.trackingTargetIds = new Set();
  }

  bumpHandVersion() { this.handVersion += 1; return this.handVersion; }

  /** 重置每轮技能标记；新轮开始时调用。 */
  resetRoundFlags() {
    // Guardian aid is per-global-turn and lives in turnFlags (resetGlobalTurnReactiveFlags).
    this.roundFlags = {};
  }

  /**
   * 安全增加能量并限制在上限内。
   * @param {number} amount 增量，可为负数。
   * @returns {number} 实际变化量。
   */
  changeEnergy(amount) {
    const previous = this.energy;
    this.energy = clamp(this.energy + amount, 0, this.maxEnergy);
    return this.energy - previous;
  }

  /** 返回角色是否具有给定技能 ID；不修改状态。 */
  hasSkill(skillId) {
    return Boolean(this.general?.passiveSkillIds.includes(skillId) || this.general?.activeSkillIds.includes(skillId));
  }

  /** 返回手中第一个指定定义的卡牌实例；不向 UI 暴露电脑牌。 */
  findCard(definitionId) {
    return this.hand.find((card) => card.definitionId === definitionId) ?? null;
  }
}
