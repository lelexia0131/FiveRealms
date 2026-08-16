/**
 * 本文件定义单个座位的运行时玩家状态，依赖 gameConfig.js 与角色配置数据。
 * Player 只保存数据并提供安全的资源变更，不决定目标合法性、伤害响应或胜负。
 * 每局都会重新创建 Player，因此无需跨局保留实例。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260815-shadow-agent-p1-slot";
import { createPlayerState } from "../domain/state/model/PlayerState.js?build=20260815-shadow-agent-p1-slot";
import { applyGeneralDefinition, bumpHandVersion } from "../domain/state/transitions/PlayerStateTransitions.js?build=20260815-shadow-agent-p1-slot";
import { changeEnergy } from "../domain/state/transitions/ResourceTransitions.js?build=20260815-shadow-agent-p1-slot";
import { resetGlobalTurnReactiveFlags, resetRoundFlags, resetTurnFlags } from "../domain/state/transitions/RuleUsageTransitions.js?build=20260815-shadow-agent-p1-slot";

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
    this.general = null;
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

  /*
  功能
  将已决定的角色定义应用到 PlayerState。

  调用方
  Game.confirmGeneral 与测试 fixture。

  输入
  general definition。

  输出
  无返回值。

  读取状态
  general definition。

  写入状态
  Player 角色身份与初始资源字段。

  调用函数
  applyGeneralDefinition。

  边界与不变量
  只转发 Domain transition；不决定角色选择。
  */
  applyGeneral(general, state = null) {
    applyGeneralDefinition(state ?? { stateVersion: 0 }, this, general);
    this.general = general;
  }

  /*
  功能
  重置每回合次数与技能标记；生产调用必须提供 authoritative state。

  调用方
  Game.takeTurn 与测试 fixture。

  输入
  teamRules 与可选 state。

  输出
  无返回值。

  读取状态
  Player turnFlags。

  写入状态
  turnFlags 经 RuleUsageTransitions。

  调用函数
  resetTurnFlags。

  边界与不变量
  无 state 的调用只用于测试/旧 fixture，不更新真实 stateVersion。
  */
  resetTurnFlags(teamRules = null, state = null) {
    resetTurnFlags(state ?? { stateVersion: 0 }, this, teamRules);
  }

  /*
  功能
  重置所有玩家共用的 global-turn reactive 额度。

  调用方
  Game.takeTurn 与测试 fixture。

  输入
  可选 authoritative state。

  输出
  无返回值。

  读取状态
  Player turnFlags。

  写入状态
  reactive flags 经 RuleUsageTransition。

  调用函数
  resetGlobalTurnReactiveFlags。

  边界与不变量
  不触碰 actor-turn state。
  */
  resetGlobalTurnReactiveFlags(state = null) {
    resetGlobalTurnReactiveFlags(state ?? { stateVersion: 0 }, this);
  }

  /*
  功能
  递增手牌版本并返回新版本。

  调用方
  Game 卡牌移动与 CardSelectionSystem。

  输入
  无。

  输出
  新 handVersion。

  读取状态
  this.handVersion。

  写入状态
  this.handVersion。

  调用函数
  bumpHandVersion。

  边界与不变量
  handVersion 只服务隐藏选择 token 失效，不参与 stateVersion。
  */
  bumpHandVersion(state = null) {
    return bumpHandVersion(state ?? { stateVersion: 0 }, this);
  }

  /*
  功能
  重置每轮技能标记；生产调用必须提供 authoritative state。

  调用方
  Game.runGameLoop 与测试 fixture。

  输入
  可选 state。

  输出
  无返回值。

  读取状态
  Player roundFlags。

  写入状态
  roundFlags 经 RuleUsageTransitions。

  调用函数
  resetRoundFlags。

  边界与不变量
  Guardian aid 按当前规则位于 turnFlags。
  */
  resetRoundFlags(state = null) {
    resetRoundFlags(state ?? { stateVersion: 0 }, this);
  }

  /*
  功能
  安全增加能量并限制在上限内。

  调用方
  Game 与技能 execute。

  输入
  能量增量。

  输出
  实际变化量。

  读取状态
  this.energy、this.maxEnergy。

  写入状态
  this.energy。

  调用函数
  changeEnergy。

  边界与不变量
  只转发 Domain ResourceTransition，不触发事件。
  */
  changeEnergy(amount, state = null) {
    return changeEnergy(state ?? { stateVersion: 0 }, this, amount);
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
