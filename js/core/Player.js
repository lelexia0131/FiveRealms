/**
 * 本文件定义单个座位的运行时玩家状态，依赖 gameConfig.js 与角色配置数据。
 * Player 只保存数据并提供安全的资源变更，不决定目标合法性、伤害响应或胜负。
 * 每局都会重新创建 Player，因此无需跨局保留实例。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260809-delayed-tactic-counter-v132";
import { clamp } from "../utils/helpers.js?build=20260809-delayed-tactic-counter-v132";

export class Player {
  /**
   * @param {{id:string,seatIndex:number,controllerType:"human"|"ai",battleTeam:string}} options 座位与阵营信息。
   */
  constructor(options) {
    this.id = options.id;
    this.seatIndex = options.seatIndex;
    this.controllerType = options.controllerType;
    this.battleTeam = options.battleTeam;
    this.generalId = null;
    this.name = "待选择";
    this.loreFaction = "未知";
    this.general = null;
    this.hp = 0;
    this.maxHp = 0;
    this.shield = 0;
    this.energy = 0;
    this.maxEnergy = GAME_CONFIG.defaultMaxEnergy;
    this.attackRange = GAME_CONFIG.defaultAttackRange;
    /** @type {Array<Object>} */ this.hand = [];
    this.handVersion = 0;
    /** @type {Object|null} */ this.equipment = null;
    /** @type {Record<string, Object>} */ this.statuses = {};
    this.alive = true;
    this.turnFlags = {};
    this.roundFlags = {};
    this.gameFlags = {};
    this.statistics = { damageDealt: 0, healingDone: 0, cardsPlayed: 0, damageTaken: 0, assaultsUsed: 0 };
    this.aiMemory = { revealedCardsByPlayer: {}, knownCardsByPlayer: {}, recentAggressors: {} };
  }

  /**
   * 将角色配置应用到座位并恢复至满生命。只在角色分配阶段调用，会修改玩家状态。
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
      coordinationTriggered: false,
      gambleTriggered: false,
      rejuvenationUsed: false,
      spyGapTriggered: false,
      spyGapPendingTargetIds: new Set(),
      trackingTargetIds: new Set(),
      skipActionPhase: false
    };
  }

  bumpHandVersion() { this.handVersion += 1; return this.handVersion; }

  /** 重置每轮技能标记；新轮开始时调用。 */
  resetRoundFlags() {
    this.roundFlags = { guardianAidUsed: false };
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
