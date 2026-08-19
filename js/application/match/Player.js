/**
 * 本文件定义单个座位的运行时玩家状态，依赖 Domain state 与 transitions。
 * Player 只保存数据并提供安全的资源变更，不决定目标合法性、伤害响应或胜负。
 * 每局都会重新创建 Player，因此无需跨局保留实例。
 */
import { createPlayerState } from "../../domain/state/model/PlayerState.js";
import { applyCharacterDefinition, bumpHandVersion } from "../../domain/state/transitions/PlayerStateTransitions.js";
import { changeEnergy } from "../../domain/state/transitions/ResourceTransitions.js";
import { resetGlobalTurnReactiveFlags, resetRoundFlags, resetTurnFlags } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { createGlobalTurnReactiveState, createRoundUsageState, createTurnUsageState } from "../../domain/rules/turn/TurnRules.js";

export class Player {
  /*
  功能
  创建一个 composite Player runtime，其领域字段由 Domain PlayerState factory 提供。

  调用方
  MatchWorkflow.startSelection 经 createPlayer capability 与测试 fixture。

  输入
  id、seatIndex、controllerType 与 battleTeam。

  输出
  初始化完成的 Player 实例。

  读取状态
  Domain PlayerState 初始 shape。

  写入状态
  Player 领域字段与 extension 字段。

  调用函数
  createPlayerState。

  边界与不变量
  controllerType 属于 Application participant metadata；aiMemory 属于 AI adapter state；两者均作为 extension 保留，不进入 Domain PlayerState。
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
    this.characterId = playerState.characterId;
    this.name = playerState.name;
    this.loreFaction = playerState.loreFaction;
    this.character = null;
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
  直接测试；生产 MatchWorkflow 直接调用同一 applyCharacterDefinition transition。

  输入
  authoritative state 与 character definition。

  输出
  无返回值。

  读取状态
  character definition。

  写入状态
  Player 角色身份与初始资源字段。

  调用函数
  applyCharacterDefinition。

  边界与不变量
  只转发 Domain transition；不决定角色选择。
  */
  applyCharacter(state, character) {
    applyCharacterDefinition(state, this, character);
    this.character = character;
  }

  /*
  功能
  重置每回合次数与技能标记；生产调用必须提供 authoritative state。

  调用方
  直接测试；生产 TurnWorkflow 直接调用同一 resetTurnFlags transition。

  输入
  authoritative state 与 teamRules（可选规则对象）。

  输出
  无返回值。

  读取状态
  Player turnFlags。

  写入状态
  turnFlags 经 RuleUsageTransitions。

  调用函数
  resetTurnFlags。

  边界与不变量
  state 为必填；测试 fixture 必须显式传入 { stateVersion: 0 } 或正式 createMatchState 根状态。
  */
  resetTurnFlags(state, teamRules = null) {
    resetTurnFlags(state, this, createTurnUsageState(teamRules));
  }

  /*
  功能
  重置所有玩家共用的 global-turn reactive 额度。

  调用方
  直接测试；生产 TurnWorkflow 直接调用同一 resetGlobalTurnReactiveFlags transition。

  输入
  authoritative state。

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
  resetGlobalTurnReactiveFlags(state) {
    resetGlobalTurnReactiveFlags(state, this, createGlobalTurnReactiveState());
  }

  /*
  功能
  递增手牌版本并返回新版本。

  调用方
  ResourceWorkflow 牌区移动与 HiddenCardChoiceWorkflow。

  输入
  authoritative state。

  输出
  新 handVersion。

  读取状态
  this.handVersion 与 state.stateVersion。

  写入状态
  this.handVersion 经 PlayerStateTransition。

  调用函数
  bumpHandVersion。

  边界与不变量
  handVersion 语义独立于 stateVersion；authoritative hand mutation 会同时推进 handVersion 与 stateVersion。
  */
  bumpHandVersion(state) {
    return bumpHandVersion(state, this);
  }

  /*
  功能
  重置每轮技能标记；生产调用必须提供 authoritative state。

  调用方
  直接测试；生产 TurnWorkflow 直接调用同一 resetRoundFlags transition。

  输入
  authoritative state。

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
  resetRoundFlags(state) {
    resetRoundFlags(state, this, createRoundUsageState());
  }

  /*
  功能
  安全增加能量并限制在上限内。

  调用方
  ResourceWorkflow、SkillEffectRuntime 与测试 fixture。

  输入
  authoritative state 与能量增量。

  输出
  实际变化量。

  读取状态
  this.energy、this.maxEnergy 与 state.stateVersion。

  写入状态
  this.energy 经 ResourceTransition。

  调用函数
  changeEnergy。

  边界与不变量
  只转发 Domain ResourceTransition，不触发事件。
  */
  changeEnergy(state, amount) {
    return changeEnergy(state, this, amount);
  }

  /** 返回角色是否具有给定技能 ID；不修改状态。 */
  /*
  功能
  判断当前角色定义是否声明指定主动或被动技能。

  调用方
  Action/trigger 合法性入口与测试。

  输入
  skillId，技能定义 ID。

  输出
  具有该技能时返回 true。

  读取状态
  this.character 的 activeSkillIds 与 passiveSkillIds。

  写入状态
  无。

  调用函数
  Array.includes。

  边界与不变量
  未选择角色时返回 false，不推断或修改技能状态。
  */
  hasSkill(skillId) {
    return Boolean(this.character?.passiveSkillIds.includes(skillId) || this.character?.activeSkillIds.includes(skillId));
  }

  /** 返回手中第一个指定定义的卡牌实例；不向 UI 暴露电脑牌。 */
  /*
  功能
  返回手牌中第一张指定定义的实体牌。

  调用方
  response/action 执行边界与测试。

  输入
  definitionId，卡牌定义 ID。

  输出
  匹配的 Card entity；不存在时返回 null。

  读取状态
  this.hand。

  写入状态
  无。

  调用函数
  Array.find。

  边界与不变量
  返回当前手牌中的原实体引用，不按名称匹配或复制。
  */
  findCard(definitionId) {
    return this.hand.find((card) => card.definitionId === definitionId) ?? null;
  }
}
