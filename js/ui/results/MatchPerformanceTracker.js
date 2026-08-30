import { MATCH_PERFORMANCE_POLICY } from "./MatchPerformancePolicy.js";

/*
功能
创建一名玩家本局独立的团队牌资源贡献事实桶。

调用方
createPlayerRecord。

输入
无。

输出
六项从零开始的可变 contribution facts。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只记录真实资源变化与成功保护；总分公式留给 calculator 派生。
*/
function createContributionFacts() {
  return {
    allyCardsGranted: 0,
    enemyCardsPlundered: 0,
    enemyCardsDestroyed: 0,
    enemyCardsTransferred: 0,
    allyResourceActionsProtected: 0,
    enemyCardsGranted: 0
  };
}

/*
功能
创建一名玩家本局的独立原始表现记录。

调用方
MatchPerformanceTracker.initializeRoster。

输入
权威 Player entity 与该玩家阵营本局开局人数。

输出
只由 tracker 持有的可变 raw record。

读取状态
Player 的公开身份、座位、阵营和角色名称。

写入状态
无。

调用函数
createContributionFacts。

边界与不变量
不把统计字段写回 Player/GameState；所有累计项从零开始。
*/
function createPlayerRecord(player, initialTeamSize) {
  return {
    playerId: player.id,
    playerName: player.name,
    characterName: player.character?.name ?? player.name,
    teamId: player.battleTeam,
    seatIndex: player.seatIndex,
    initialTeamSize,
    effectiveRounds: 0,
    totals: {
      enemyHpDamage: 0,
      enemyKills: 0,
      allyHealing: 0,
      allyRescueHealing: 0,
      allyMitigation: 0,
      allyShieldAbsorbed: 0,
      cardsPlayed: 0,
      activeSkillsUsed: 0,
      enemyControls: 0
    },
    contributionFacts: createContributionFacts(),
    aliveAtEnd: false
  };
}

/*
功能
读取玩家当前回合 authoritative 主动技能使用总次数。

调用方
MatchPerformanceTracker.settleActiveSkillTurn。

输入
当前 Player entity。

输出
activeSkillUseCounts 中全部有限非负次数之和。

读取状态
player.turnFlags.activeSkillUseCounts。

写入状态
无。

调用函数
Object.values。

边界与不变量
非法尝试和纯被动不会写入该权威结构，因此不会进入结果。
*/
function countCurrentTurnActiveSkills(player) {
  return Object.values(player?.turnFlags?.activeSkillUseCounts ?? {}).reduce(
    (sum, value) => sum + Math.max(0, Number(value) || 0),
    0
  );
}

/*
功能
把可变 tracker record 复制为不可变结算快照行。

调用方
MatchPerformanceTracker.finalizeMatch。

输入
raw record 与结算时存活事实。

输出
冻结的玩家统计行。

读取状态
record。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
effectiveRounds 至少为一；快照不共享可变 totals 引用。
*/
function freezePlayerRecord(record, aliveAtEnd) {
  return Object.freeze({
    ...record,
    effectiveRounds: Math.max(1, record.effectiveRounds),
    totals: Object.freeze({ ...record.totals }),
    contributionFacts: Object.freeze({ ...record.contributionFacts }),
    aliveAtEnd
  });
}

export class MatchPerformanceTracker {
  /*
  功能
  创建只读观察现有对局语义的原始表现 tracker。

  调用方
  createMatchPerformanceSidecar 与 tracker 单元测试。

  输入
  EventDispatcher、authoritative state getter 与可选 policy。

  输出
  初始化但尚未订阅的 tracker 实例。

  读取状态
  无。

  写入状态
  records、subscription 与当前回合技能结算状态。

  调用函数
  reset。

  边界与不变量
  tracker 不写 GameState、不排序、不计算分数、不渲染 DOM。
  */
  constructor({ eventDispatcher, getState, policy = MATCH_PERFORMANCE_POLICY }) {
    this.eventDispatcher = eventDispatcher;
    this.getState = getState;
    this.policy = policy;
    this.started = false;
    this.unsubscribers = [];
    this.reset();
  }

  /*
  功能
  幂等订阅本局需要的结构化事实与 hook。

  调用方
  createMatchPerformanceSidecar 与 lifecycle 测试。

  输入
  无。

  输出
  当前 tracker。

  读取状态
  started 与 EventDispatcher。

  写入状态
  subscription registry 与 started。

  调用函数
  EventDispatcher.on。

  边界与不变量
  重复 start 不重复注册；每类事实只选一个权威来源累计。
  */
  start() {
    if (this.started) return this;
    const handlers = {
      gameStart: () => this.initializeRoster(),
      roundStart: () => this.handleRoundStart(),
      afterDamage: (event) => this.handleAfterDamage(event),
      afterHeal: (event) => this.handleAfterHeal(event),
      beforeCardUse: (event) => this.handleBeforeCardUse(event),
      cardUsed: (event) => this.handleCardUsed(event),
      playerDead: (event) => this.handlePlayerDead(event),
      turnStart: (event) => this.handleTurnStart(event),
      turnEnd: (event) => this.handleTurnEnd(event)
    };
    for (const [eventName, handler] of Object.entries(handlers)) {
      this.unsubscribers.push(this.eventDispatcher.on(
        eventName,
        `match-performance:${eventName}`,
        handler
      ));
    }
    this.started = true;
    return this;
  }

  /*
  功能
  取消 tracker 的全部显式订阅并清空局内事实。

  调用方
  MatchPerformanceSidecar.dispose 与 lifecycle 测试。

  输入
  无。

  输出
  无返回值。

  读取状态
  unsubscribers。

  写入状态
  subscription registry、started 与 raw state。

  调用函数
  unsubscribe callbacks、reset。

  边界与不变量
  重复 dispose 安全；下一局由新 sidecar 建立全新 tracker。
  */
  dispose() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.started = false;
    this.reset();
  }

  /*
  功能
  清空本局 raw facts 与当前回合标记。

  调用方
  constructor、initializeRoster、dispose 与 match reset 测试。

  输入
  无。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  records、gameId、activeSkillTurnPlayerId、资源关联状态与 finalizedSnapshot。

  调用函数
  Map。

  边界与不变量
  不影响 EventDispatcher subscription；所有累计项回到零。
  */
  reset() {
    this.records = new Map();
    this.gameId = null;
    this.activeSkillTurnPlayerId = null;
    this.pendingResolvedCounter = null;
    this.pendingMutualBenefitHands = new Map();
    this.finalizedSnapshot = null;
  }

  /*
  功能
  从正式 gameStart 时的 roster 建立每名玩家记录与开局阵营人数。

  调用方
  gameStart listener 与 tracker 测试。

  输入
  无；读取 getState 当前 roster。

  输出
  无返回值。

  读取状态
  MatchState.gameId 与 players。

  写入状态
  tracker records/gameId。

  调用函数
  reset、createPlayerRecord。

  边界与不变量
  阵营标准在此按开局人数冻结，阵亡不会改变 initialTeamSize。
  */
  initializeRoster() {
    const state = this.getState();
    this.reset();
    this.gameId = state.gameId;
    for (const player of state.players) {
      const initialTeamSize = state.players.filter(
        (candidate) => candidate.battleTeam === player.battleTeam
      ).length;
      this.records.set(player.id, createPlayerRecord(player, initialTeamSize));
    }
  }

  /*
  功能
  取得指定玩家的 tracker-owned raw record。

  调用方
  各结构化事件 handler。

  输入
  Player entity 或 player ID。

  输出
  对应 raw record；不存在时为 null。

  读取状态
  records。

  写入状态
  无。

  调用函数
  Map.get。

  边界与不变量
  不为 gameStart roster 之外的对象临时造统计行。
  */
  recordFor(playerOrId) {
    const playerId = typeof playerOrId === "string" ? playerOrId : playerOrId?.id;
    return this.records.get(playerId) ?? null;
  }

  /*
  功能
  判断两个真实玩家是否为不同实体的同阵营队友。

  调用方
  Support、Control 与 Contribution handlers。

  输入
  source 与 target Player entity。

  输出
  同阵营且 ID 不同时为 true。

  读取状态
  Player ID 与 battleTeam。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  自己永不视为支援或贡献对象。
  */
  areAllies(source, target) {
    return Boolean(source && target && source.id !== target.id && source.battleTeam === target.battleTeam);
  }

  /*
  功能
  为本轮开始时仍存活的正式参与者增加一个有效回合。

  调用方
  roundStart listener。

  输入
  无。

  输出
  无返回值。

  读取状态
  authoritative players.alive。

  写入状态
  records.effectiveRounds。

  调用函数
  recordFor。

  边界与不变量
  阵亡者之后的轮次不再增加；比赛结束所在轮已在轮开始时计入存活玩家；
  直接装配 roster 的 headless/test runtime 若未发布 gameStart，则在首个 roundStart 建立同一开局快照。
  */
  handleRoundStart() {
    if (!this.records.size) this.initializeRoster();
    for (const player of this.getState().players) {
      if (player.alive) this.recordFor(player).effectiveRounds += 1;
    }
  }

  /*
  功能
  累计对敌最终实际生命伤害。

  调用方
  afterDamage listener。

  输入
  含 source、target 与 actualAmount 的结算后事件。

  输出
  无返回值。

  读取状态
  结构化 afterDamage fact。

  写入状态
  source.enemyHpDamage。

  调用函数
  recordFor。

  边界与不变量
  友伤、自伤、环境伤害、格挡、护盾吸收和减伤部分均不增加火力。
  */
  handleAfterDamage(event) {
    if (!event.source || !event.target || event.source.battleTeam === event.target.battleTeam) return;
    const record = this.recordFor(event.source);
    if (record) record.totals.enemyHpDamage += Math.max(0, Number(event.actualAmount) || 0);
  }

  /*
  功能
  累计真正由玩家导致的敌方阵亡次数。

  调用方
  playerDead listener。

  输入
  含 source 与 target 的正式死亡事件。

  输出
  无返回值。

  读取状态
  结构化 playerDead fact。

  写入状态
  source.enemyKills。

  调用函数
  recordFor。

  边界与不变量
  友军击杀、自杀和无来源环境死亡不计；不依赖击杀摸牌奖励资格。
  */
  handlePlayerDead(event) {
    const source = event.source;
    const target = event.target;
    if (!source || !target || source.id === target.id || source.battleTeam === target.battleTeam) return;
    const record = this.recordFor(source);
    if (record) record.totals.enemyKills += 1;
  }

  /*
  功能
  累计对队友实际普通治疗或濒死救援治疗。

  调用方
  afterHeal listener。

  输入
  含 source、target、actualAmount 与 isDyingRescue 的结算后事件。

  输出
  无返回值。

  读取状态
  结构化 afterHeal fact。

  写入状态
  source allyHealing 或 allyRescueHealing。

  调用函数
  areAllies、recordFor。

  边界与不变量
  自疗和敌方治疗不计；同一笔救援只进入 rescue bucket，评分时再乘二。
  */
  handleAfterHeal(event) {
    if (!this.areAllies(event.source, event.target)) return;
    const record = this.recordFor(event.source);
    if (!record) return;
    const amount = Math.max(0, Number(event.actualAmount) || 0);
    const key = event.isDyingRescue ? "allyRescueHealing" : "allyHealing";
    record.totals[key] += amount;
  }

  /*
  功能
  在互利效果发生前保存每名玩家的权威手牌数量。

  调用方
  beforeCardUse listener。

  输入
  含 card 与 resolutionId 的 beforeCardUse hook。

  输出
  无返回值。

  读取状态
  MatchState players.hand。

  写入状态
  pendingMutualBenefitHands。

  调用函数
  Map。

  边界与不变量
  只跟踪互利；快照发生在使用牌已离开来源手牌后，因此结算后的正差值就是实际获牌数。
  */
  handleBeforeCardUse(event) {
    if (event.card?.definitionId !== "mutualBenefit" || !event.resolutionId) return;
    this.pendingMutualBenefitHands.set(
      event.resolutionId,
      new Map(this.getState().players.map((player) => [player.id, player.hand?.length ?? 0]))
    );
  }

  /*
  功能
  按互利前后权威手牌差值结算友方正贡献与敌方负贡献。

  调用方
  handleCardUsed 收到互利最终事件时。

  输入
  使用者 record、source 与最终 cardUsed event。

  输出
  无返回值。

  读取状态
  pendingMutualBenefitHands 与 MatchState players.hand。

  写入状态
  allyCardsGranted、enemyCardsGranted，并消费对应快照。

  调用函数
  areAllies、Map.delete。

  边界与不变量
  取消或没有同 resolution 快照时不猜 recipients；自己获牌不计，实际多张牌按正差值逐张累计。
  */
  settleMutualBenefitContribution(record, source, event) {
    const beforeHands = this.pendingMutualBenefitHands.get(event.resolutionId);
    if (event.resolutionId) this.pendingMutualBenefitHands.delete(event.resolutionId);
    if (!event.resolved || !beforeHands) return;
    for (const target of this.getState().players) {
      const gained = Math.max(0, (target.hand?.length ?? 0) - (beforeHands.get(target.id) ?? 0));
      if (!gained || target.id === source.id) continue;
      if (this.areAllies(source, target)) record.contributionFacts.allyCardsGranted += gained;
      else if (target.battleTeam !== source.battleTeam) {
        record.contributionFacts.enemyCardsGranted += gained;
      }
    }
  }

  /*
  功能
  用最终根牌结果确认一次反制是否真实保护了队友的手牌资源。

  调用方
  handleCardUsed 收到非反制根牌时。

  输入
  已完成结算的根 cardUsed event。

  输出
  无返回值。

  读取状态
  pendingResolvedCounter、根牌 source/targets/resolved 与双方阵营。

  写入状态
  成功反制者 allyResourceActionsProtected，随后清空 pending correlation。

  调用函数
  areAllies、recordFor。

  边界与不变量
  只认可敌人对队友的掠夺、破坏或转移，且根效果最终取消；反制自己、非资源牌和被再反制均不计。
  */
  settleProtectedAllyResourceAction(event) {
    const pending = this.pendingResolvedCounter;
    this.pendingResolvedCounter = null;
    if (!pending || event.resolved !== false
      || !["plunder", "destroy", "transfer"].includes(event.card?.definitionId)) return;
    const hostileSource = event.source;
    const protectedTarget = event.targets?.[0];
    const counterSource = pending.source;
    if (!hostileSource || !protectedTarget || !counterSource
      || hostileSource.battleTeam === counterSource.battleTeam
      || !this.areAllies(counterSource, protectedTarget)
      || !pending.effectiveTargetIds.includes(hostileSource.id)
      || !pending.effectiveTargetIds.includes(protectedTarget.id)) return;
    const record = this.recordFor(counterSource);
    if (record) record.contributionFacts.allyResourceActionsProtected += 1;
  }

  /*
  功能
  累计已提交主动牌，并从最终 cardUsed 语义派生控制、资源贡献与保护事实。

  调用方
  cardUsed listener。

  输入
  cardUsed event 的 source/card/resolved/effectiveTargets/usageContext。

  输出
  无返回值。

  读取状态
  结构化 cardUsed event、当前 phase 与 currentPlayerIndex。

  写入状态
  cardsPlayed、enemyControls、contributionFacts 与 pendingResolvedCounter。

  调用函数
  recordFor、areAllies、settleMutualBenefitContribution、settleProtectedAllyResourceAction。

  边界与不变量
  Activity 只计 play phase 中当前行动者没有 response usageContext 的主动牌，是否被反制不影响计数；响应牌仍可进入 Control/Contribution。
  */
  handleCardUsed(event) {
    const source = event.source;
    const record = this.recordFor(source);
    if (!record) return;
    const state = this.getState();
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!event.usageContext && state.phase === "play" && currentPlayer?.id === source.id) {
      record.totals.cardsPlayed += 1;
    }
    const targets = Array.isArray(event.effectiveTargets) ? event.effectiveTargets : [];
    const cardId = event.card?.definitionId;
    if (cardId === "mutualBenefit") {
      this.settleProtectedAllyResourceAction(event);
      this.settleMutualBenefitContribution(record, source, event);
      return;
    }
    if (cardId === "counter") {
      if (!event.resolved) return;
      // 延迟状态反制 payload 没有原始状态施加者；在 status phase 排除，避免按状态持有者误归属。
      const counteredActionOwner = targets[0];
      if (this.getState().phase !== "status" && counteredActionOwner
        && counteredActionOwner.battleTeam !== source.battleTeam) {
        record.totals.enemyControls += 1;
        this.pendingResolvedCounter = {
          source,
          effectiveTargetIds: targets.map((target) => target?.id).filter(Boolean)
        };
      }
      return;
    }
    this.settleProtectedAllyResourceAction(event);
    if (!event.resolved) return;
    if (cardId === "transfer") {
      const controlledSource = targets[0];
      const receiver = targets[1];
      if (controlledSource && controlledSource.battleTeam !== source.battleTeam) {
        record.totals.enemyControls += 1;
        record.contributionFacts.enemyCardsTransferred += 1;
      }
      if (this.areAllies(source, receiver)) record.contributionFacts.allyCardsGranted += 1;
      return;
    }
    if (this.policy.controlCardIds.includes(cardId)
      && targets.some((target) => target?.battleTeam !== source.battleTeam)) {
      record.totals.enemyControls += 1;
    }
    if (cardId === "plunder") {
      record.contributionFacts.enemyCardsPlundered += targets.filter(
        (target) => target?.battleTeam !== source.battleTeam
      ).length;
    }
    if (cardId === "destroy") {
      record.contributionFacts.enemyCardsDestroyed += targets.filter(
        (target) => target?.battleTeam !== source.battleTeam
      ).length;
    }
  }

  /*
  功能
  开始追踪当前真实行动者这一回合的主动技能累计槽。

  调用方
  turnStart listener。

  输入
  含 player 的 turnStart event。

  输出
  无返回值。

  读取状态
  activeSkillTurnPlayerId。

  写入状态
  activeSkillTurnPlayerId。

  调用函数
  settleActiveSkillTurn。

  边界与不变量
  若异常流程未发 turnEnd 而直接进入下一回合，先收束上一回合，避免事实丢失。
  */
  handleTurnStart(event) {
    if (this.activeSkillTurnPlayerId) this.settleActiveSkillTurn(this.activeSkillTurnPlayerId);
    this.activeSkillTurnPlayerId = event.player?.id ?? null;
  }

  /*
  功能
  在真实回合结束时收束该玩家主动技能使用次数。

  调用方
  turnEnd listener。

  输入
  含 player 的 turnEnd event。

  输出
  无返回值。

  读取状态
  activeSkillTurnPlayerId。

  写入状态
  activeSkillsUsed 与当前回合标记。

  调用函数
  settleActiveSkillTurn。

  边界与不变量
  重复或过期 turnEnd 不得重复累计。
  */
  handleTurnEnd(event) {
    if (event.player?.id !== this.activeSkillTurnPlayerId) return;
    this.settleActiveSkillTurn(event.player.id);
  }

  /*
  功能
  把指定当前回合的 authoritative 主动技能次数加入 tracker 一次。

  调用方
  turnStart、turnEnd 与 finalizeMatch。

  输入
  当前回合玩家 ID。

  输出
  无返回值。

  读取状态
  MatchState player.turnFlags.activeSkillUseCounts。

  写入状态
  record.activeSkillsUsed 与 activeSkillTurnPlayerId。

  调用函数
  countCurrentTurnActiveSkills、recordFor。

  边界与不变量
  只结算仍标记为当前回合的 ID；同一回合最多累计一次。
  */
  settleActiveSkillTurn(playerId) {
    if (!playerId || playerId !== this.activeSkillTurnPlayerId) return;
    const player = this.getState().players.find((candidate) => candidate.id === playerId);
    const record = this.recordFor(playerId);
    if (player && record) record.totals.activeSkillsUsed += countCurrentTurnActiveSkills(player);
    this.activeSkillTurnPlayerId = null;
  }

  /*
  功能
  收束未结束回合并冻结整局 raw performance snapshot。

  调用方
  MatchPerformanceSidecar 的 gameOver listener 与测试。

  输入
  无。

  输出
  冻结的 { gameId, players } snapshot。

  读取状态
  MatchState players.alive 与 tracker records。

  写入状态
  finalizedSnapshot。

  调用函数
  settleActiveSkillTurn、freezePlayerRecord。

  边界与不变量
  同局重复 finalize 返回同一 immutable snapshot；玩家按原座位输出，评分排序留给 ViewModel。
  */
  finalizeMatch() {
    if (this.finalizedSnapshot) return this.finalizedSnapshot;
    this.settleActiveSkillTurn(this.activeSkillTurnPlayerId);
    const players = Object.freeze([...this.records.values()]
      .sort((left, right) => left.seatIndex - right.seatIndex)
      .map((record) => {
        const player = this.getState().players.find((candidate) => candidate.id === record.playerId);
        return freezePlayerRecord(record, Boolean(player?.alive));
      }));
    this.finalizedSnapshot = Object.freeze({ gameId: this.gameId, players });
    return this.finalizedSnapshot;
  }
}
