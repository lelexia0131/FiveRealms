import { MATCH_PERFORMANCE_POLICY } from "./MatchPerformancePolicy.js";

/*
功能
创建一名玩家本局独立的贡献事实桶。

调用方
createPlayerRecord。

输入
无。

输出
七项从零开始的可变 contribution facts。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只记录真实资源变化、成功保护与封印结算；总分公式留给 calculator 派生。
*/
function createContributionFacts() {
  return {
    allyCardsGranted: 0,
    enemyCardsPlundered: 0,
    enemyCardsDestroyed: 0,
    enemyCardsTransferred: 0,
    allyResourceActionsProtected: 0,
    enemyCardsGranted: 0,
    sealContribution: 0
  };
}

/*
功能
创建成就判定需要但不参与 MVP 评分的本局结构化事实桶。

调用方
createPlayerRecord。

输入
玩家开局手牌数量。

输出
从初始手牌峰值开始、其余归零的成就事实与局内集合。

读取状态
无。

写入状态
无。

调用函数
Set。

边界与不变量
集合只在 tracker 内可变，冻结快照输出数组；初始手牌作为本局首批获牌计数，最高存活轮次只由 roundStart 推进。
*/
function createAchievementFacts(initialHandCount) {
  return {
    activeSkillUses: 0,
    activeAssaultUses: 0,
    committedAssaultUses: 0,
    rescueCount: 0,
    maxTurnDamage: 0,
    maxTurnKills: 0,
    maxHandCount: Math.max(0, Number(initialHandCount) || 0),
    equipmentUses: 0,
    lightningCasts: 0,
    lightningHits: 0,
    lightningDamageTakenHits: 0,
    selfLightningHit: false,
    radarTacticJudgments: 0,
    cardsGained: Math.max(0, Number(initialHandCount) || 0),
    maxSingleAttackDamage: 0,
    damageResolutionId: null,
    damageResolutionTotal: 0,
    teammateDeaths: 0,
    maxAliveRound: 0,
    clutchEnemyCounts: new Set(),
    turnDamage: 0,
    turnKills: 0
  };
}

/*
功能
复制一名玩家的 tracker-owned 可变记录，用于真实 Action rollback checkpoint。

调用方
MatchPerformanceTracker.captureActionCheckpoint。

输入
当前玩家 raw record。

输出
不共享 totals、contributionFacts、achievementFacts 或残局集合的记录副本。

读取状态
传入 record。

写入状态
无。

调用函数
Set。

边界与不变量
玩家身份等不可变标量保持原值；只复制 tracker 自有可变容器，不复制真实 Player entity。
*/
function clonePlayerRecord(record) {
  return {
    ...record,
    totals: { ...record.totals },
    contributionFacts: { ...record.contributionFacts },
    achievementFacts: {
      ...record.achievementFacts,
      clutchEnemyCounts: new Set(record.achievementFacts.clutchEnemyCounts)
    }
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
    characterId: player.character?.id ?? null,
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
      hpDamageTaken: 0,
      cardsPlayed: 0,
      skillEnergySpent: 0,
      enemyControls: 0
    },
    contributionFacts: createContributionFacts(),
    achievementFacts: createAchievementFacts(player.hand?.length),
    clutchEnemyCount: null,
    aliveAtEnd: false
  };
}

/*
功能
把可变 tracker record 复制为不可变结算快照行。

调用方
MatchPerformanceTracker.finalizeMatch。

输入
raw record、结算时存活事实与胜方阵营。

输出
冻结的玩家统计行。

读取状态
record。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
effectiveRounds 至少为一；胜负按玩家自己的开局阵营判定；快照不共享可变 totals 引用。
*/
function freezePlayerRecord(record, aliveAtEnd, winnerTeam, player) {
  const {
    turnDamage: _turnDamage,
    turnKills: _turnKills,
    damageResolutionId: _damageResolutionId,
    damageResolutionTotal: _damageResolutionTotal,
    clutchEnemyCounts,
    ...achievementFacts
  } = record.achievementFacts;
  return Object.freeze({
    ...record,
    effectiveRounds: Math.max(1, record.effectiveRounds),
    totals: Object.freeze({ ...record.totals }),
    contributionFacts: Object.freeze({ ...record.contributionFacts }),
    achievementFacts: Object.freeze({
      ...achievementFacts,
      clutchEnemyCounts: Object.freeze([...clutchEnemyCounts].sort((left, right) => left - right))
    }),
    won: record.teamId === winnerTeam,
    aliveAtEnd,
    finalHp: Number.isFinite(Number(player?.hp)) ? Number(player.hp) : null,
    finalMaxHp: Number.isFinite(Number(player?.maxHp)) ? Number(player.maxHp) : null
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
  records、subscription 与局内关联状态。

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
      roundStart: (event) => this.handleRoundStart(event),
      turnStart: (event) => this.handleTurnStart(event),
      turnEnd: (event) => this.handleTurnEnd(event),
      judgmentRevealed: (event) => this.handleJudgmentRevealed(event),
      afterDamage: (event) => this.handleAfterDamage(event),
      afterHpLoss: (event) => this.handleAfterHpLoss(event),
      afterHeal: (event) => this.handleAfterHeal(event),
      shieldGranted: (event) => this.handleShieldGranted(event),
      beforeCardUse: (event) => this.handleBeforeCardUse(event),
      afterCardMove: (event) => this.handleAfterCardMove(event),
      cardCommitted: (event) => this.handleCardCommitted(event),
      cardUsed: (event) => this.handleCardUsed(event),
      cardsGranted: (event) => this.handleCardsGranted(event),
      sealSettled: (event) => this.handleSealSettled(event),
      skillEnergyPaid: (event) => this.handleSkillEnergyPaid(event),
      activeSkillUsed: (event) => this.handleActiveSkillUsed(event),
      playerRescued: (event) => this.handlePlayerRescued(event),
      playerDead: (event) => this.handlePlayerDead(event)
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
  清空本局 raw facts 与局内关联状态。

  调用方
  constructor、initializeRoster、dispose 与 match reset 测试。

  输入
  无。

  输出
  无返回值。

  读取状态
  无。

  写入状态
  records、gameId、护盾来源账、资源关联状态与 finalizedSnapshot。

  调用函数
  Map。

  边界与不变量
  不影响 EventDispatcher subscription；所有累计项回到零。
  */
  reset() {
    this.records = new Map();
    this.shieldSourceLedgers = new Map();
    this.gameId = null;
    this.pendingResolvedCounter = null;
    this.pendingMutualBenefitHands = new Map();
    this.pendingRescueContributors = new Map();
    this.currentTurnPlayerId = null;
    this.finalizedSnapshot = null;
  }

  /*
  功能
  捕获真实 Action 开始前的全部 tracker-owned 可变事实。

  调用方
  ActionTransaction composition participant。

  输入
  无。

  输出
  可供 restoreActionCheckpoint 恢复的独立 checkpoint。

  读取状态
  records、护盾账、资源关联、救援参与者、当前回合与最终快照。

  写入状态
  无。

  调用函数
  clonePlayerRecord、Map、Set、Object.freeze。

  边界与不变量
  checkpoint 不持有任何 tracker 可变容器；真实 Player 引用只保留在既有短期关联事实中。
  */
  captureActionCheckpoint() {
    return Object.freeze({
      records: new Map([...this.records].map(([playerId, record]) => [
        playerId,
        clonePlayerRecord(record)
      ])),
      shieldSourceLedgers: new Map([...this.shieldSourceLedgers].map(([playerId, entries]) => [
        playerId,
        entries.map((entry) => ({ ...entry }))
      ])),
      gameId: this.gameId,
      pendingResolvedCounter: this.pendingResolvedCounter ? {
        ...this.pendingResolvedCounter,
        effectiveTargetIds: [...this.pendingResolvedCounter.effectiveTargetIds]
      } : null,
      pendingMutualBenefitHands: new Map([...this.pendingMutualBenefitHands].map(([
        resolutionId,
        hands
      ]) => [resolutionId, new Map(hands)])),
      pendingRescueContributors: new Map([...this.pendingRescueContributors].map(([
        targetId,
        contributorIds
      ]) => [targetId, new Set(contributorIds)])),
      currentTurnPlayerId: this.currentTurnPlayerId,
      finalizedSnapshot: this.finalizedSnapshot
    });
  }

  /*
  功能
  恢复真实 Action 开始前的全部 tracker-owned 可变事实。

  调用方
  ActionTransaction rollback。

  输入
  captureActionCheckpoint 返回的 checkpoint。

  输出
  无返回值。

  读取状态
  checkpoint。

  写入状态
  records、护盾账、资源关联、救援参与者、当前回合与最终快照。

  调用函数
  无。

  边界与不变量
  不修改订阅、EventDispatcher 或真实 GameState；失败 Action 发布过的统计事实全部回到开始边界。
  */
  restoreActionCheckpoint(checkpoint) {
    if (!(checkpoint?.records instanceof Map)
      || !(checkpoint.shieldSourceLedgers instanceof Map)
      || !(checkpoint.pendingMutualBenefitHands instanceof Map)
      || !(checkpoint.pendingRescueContributors instanceof Map)) {
      throw new TypeError("MatchPerformanceTracker Action checkpoint 非法");
    }
    this.records = checkpoint.records;
    this.shieldSourceLedgers = checkpoint.shieldSourceLedgers;
    this.gameId = checkpoint.gameId;
    this.pendingResolvedCounter = checkpoint.pendingResolvedCounter;
    this.pendingMutualBenefitHands = checkpoint.pendingMutualBenefitHands;
    this.pendingRescueContributors = checkpoint.pendingRescueContributors;
    this.currentTurnPlayerId = checkpoint.currentTurnPlayerId;
    this.finalizedSnapshot = checkpoint.finalizedSnapshot;
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
  tracker records/gameId 与每名玩家的护盾来源账。

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
      const initialShield = Math.max(0, Number(player.shield) || 0);
      this.shieldSourceLedgers.set(player.id, initialShield > 0 ? [{
        providerPlayerId: null,
        effectDefinitionId: null,
        remainingAmount: initialShield
      }] : []);
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
  把指定玩家的 FIFO 护盾来源账无计分地校准到真实护盾总量。

  调用方
  handleShieldGranted、settleShieldAbsorption。

  输入
  target Player 与校准时应存在的非负护盾总量。

  输出
  校准后的可变 ledger entries。

  读取状态
  shieldSourceLedgers。

  写入状态
  对应玩家的 shieldSourceLedgers entries。

  调用函数
  Map.get、Map.set。

  边界与不变量
  未观察到的既存护盾记为 unattributed；直接移除按 FIFO 同步扣账但永不产生支援统计。
  */
  reconcileShieldLedger(target, expectedTotal) {
    const targetTotal = Math.max(0, Number(expectedTotal) || 0);
    const ledger = this.shieldSourceLedgers.get(target.id) ?? [];
    let trackedTotal = ledger.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.remainingAmount) || 0),
      0
    );
    let excess = Math.max(0, trackedTotal - targetTotal);
    while (excess > 0 && ledger.length) {
      const entry = ledger[0];
      const removed = Math.min(excess, entry.remainingAmount);
      entry.remainingAmount -= removed;
      excess -= removed;
      trackedTotal -= removed;
      if (entry.remainingAmount <= 0) ledger.shift();
    }
    if (trackedTotal < targetTotal) {
      ledger.push({
        providerPlayerId: null,
        effectDefinitionId: null,
        remainingAmount: targetTotal - trackedTotal
      });
    }
    this.shieldSourceLedgers.set(target.id, ledger);
    return ledger;
  }

  /*
  功能
  记录真实结算后新增护盾的提供者与实际新增量。

  调用方
  shieldGranted listener。

  输入
  含 source、target、actualAddedAmount 与 effectDefinitionId 的结构化事实。

  输出
  无返回值。

  读取状态
  target.shield 与 shieldSourceLedgers。

  写入状态
  target 对应 FIFO shield source ledger；相邻同 attribution entry 原位合并。

  调用函数
  reconcileShieldLedger。

  边界与不变量
  只记录最终实际新增的正数；新增前先校准既存盾，不能用角色或技能反推 provider；
  仅相邻且 provider/effect 都相同的来源可合并，FIFO 归属与真实数值必须不变。
  */
  handleShieldGranted(event) {
    const target = event.target;
    const actualAddedAmount = Math.max(0, Number(event.actualAddedAmount) || 0);
    if (!target || actualAddedAmount <= 0) return;
    const currentShield = Math.max(0, Number(target.shield) || 0);
    const ledger = this.reconcileShieldLedger(target, Math.max(0, currentShield - actualAddedAmount));
    const providerPlayerId = event.source?.id ?? null;
    const effectDefinitionId = event.effectDefinitionId ?? null;
    const previous = ledger.at(-1) ?? null;
    if (previous?.providerPlayerId === providerPlayerId
      && previous?.effectDefinitionId === effectDefinitionId) {
      previous.remainingAmount += actualAddedAmount;
    } else {
      ledger.push({ providerPlayerId, effectDefinitionId, remainingAmount:actualAddedAmount });
    }
    this.reconcileShieldLedger(target, currentShield);
  }

  /*
  功能
  把真实伤害事件中的实际减伤 contribution 归属给保护队友的贡献者。

  调用方
  handleAfterDamage。

  输入
  含 target 与 metadata.mitigationContributions 的 afterDamage 事件。

  输出
  无返回值。

  读取状态
  MatchState roster 与 tracker records。

  写入状态
  合法贡献者的 allyMitigation。

  调用函数
  areAllies、recordFor。

  边界与不变量
  只接受明确 contributorPlayerId、友军被保护者和正实际减伤；自减伤、敌方与零贡献不计。
  */
  settleMitigationContributions(event) {
    const contributions = event.metadata?.mitigationContributions;
    if (!event.target || !Array.isArray(contributions)) return;
    for (const contribution of contributions) {
      const amount = Math.max(0, Number(contribution?.amount) || 0);
      if (!contribution?.contributorPlayerId || amount <= 0) continue;
      const contributor = this.getState().players.find(
        (player) => player.id === contribution.contributorPlayerId
      );
      if (!this.areAllies(contributor, event.target)) continue;
      const record = this.recordFor(contributor);
      if (record) record.totals.allyMitigation += amount;
    }
  }

  /*
  功能
  按 FIFO 消费真实吸收量，并把被实际消耗的友军护盾归属给提供者。

  调用方
  handleAfterDamage。

  输入
  含 target 与 shieldAbsorbed 的结算后伤害事件。

  输出
  无返回值。

  读取状态
  target.shield、MatchState roster 与 shieldSourceLedgers。

  写入状态
  shieldSourceLedgers 与合法提供者的 allyShieldAbsorbed。

  调用函数
  reconcileShieldLedger、areAllies、recordFor。

  边界与不变量
  消费量与真实 shieldAbsorbed 相同；自盾、敌方盾、unattributed 盾和未被吸收的盾不计分。
  */
  settleShieldAbsorption(event) {
    const target = event.target;
    let remaining = Math.max(0, Number(event.shieldAbsorbed) || 0);
    if (!target || remaining <= 0) return;
    const currentShield = Math.max(0, Number(target.shield) || 0);
    const ledger = this.reconcileShieldLedger(target, currentShield + remaining);
    while (remaining > 0 && ledger.length) {
      const entry = ledger[0];
      const consumed = Math.min(remaining, entry.remainingAmount);
      if (entry.providerPlayerId) {
        const provider = this.getState().players.find(
          (player) => player.id === entry.providerPlayerId
        );
        if (this.areAllies(provider, target)) {
          const record = this.recordFor(provider);
          if (record) record.totals.allyShieldAbsorbed += consumed;
        }
      }
      entry.remainingAmount -= consumed;
      remaining -= consumed;
      if (entry.remainingAmount <= 0) ledger.shift();
    }
    this.reconcileShieldLedger(target, currentShield);
  }

  /*
  功能
  为本轮开始时仍存活的正式参与者增加有效回合并记录最高存活轮次。

  调用方
  roundStart listener。

  输入
  含当前结构化 round 的 roundStart 事件。

  输出
  无返回值。

  读取状态
  authoritative players.alive、event.round 与 MatchState.currentRound。

  写入状态
  records.effectiveRounds 与 achievementFacts.maxAliveRound。

  调用函数
  recordFor。

  边界与不变量
  阵亡者之后的轮次不再增加；比赛结束所在轮已在轮开始时计入存活玩家；
  直接装配 roster 的 headless/test runtime 若未发布 gameStart，则在首个 roundStart 建立同一开局快照。
  */
  handleRoundStart(event = {}) {
    if (!this.records.size) this.initializeRoster();
    const state = this.getState();
    const round = Math.max(0, Number(event.round ?? state.currentRound) || 0);
    for (const player of state.players) {
      if (!player.alive) continue;
      const record = this.recordFor(player);
      record.effectiveRounds += 1;
      record.achievementFacts.maxAliveRound = Math.max(record.achievementFacts.maxAliveRound, round);
    }
  }

  /*
  功能
  为行动者重置单回合伤害/击杀计数并记录回合开始手牌峰值。

  调用方
  turnStart listener。

  输入
  含当前行动 player 的结构化事件。

  输出
  无返回值。

  读取状态
  player.hand。

  写入状态
  对应 achievementFacts 的 turnDamage、turnKills 与 maxHandCount。

  调用函数
  recordFor、Math.max。

  边界与不变量
  每个行动回合独立计数，历史峰值不重置。
  */
  handleTurnStart(event) {
    const record = this.recordFor(event.player);
    if (!record) return;
    this.currentTurnPlayerId = event.player.id;
    record.achievementFacts.turnDamage = 0;
    record.achievementFacts.turnKills = 0;
    record.achievementFacts.maxHandCount = Math.max(
      record.achievementFacts.maxHandCount,
      event.player?.hand?.length ?? 0
    );
  }

  /*
  功能
  在正式回合结束时关闭成就单回合观察窗口。

  调用方
  turnEnd listener。

  输入
  含当前行动 player 的结构化事件。

  输出
  无返回值。

  读取状态
  currentTurnPlayerId。

  写入状态
  匹配时清空 currentTurnPlayerId。

  调用函数
  无。

  边界与不变量
  其他玩家或陈旧事件不能关闭当前窗口；gameOver 前的事实仍由 finalize 收束。
  */
  handleTurnEnd(event) {
    if (this.currentTurnPlayerId === event.player?.id) this.currentTurnPlayerId = null;
  }

  /*
功能
在牌区移动提交后记录真实获牌，并更新当前行动者在自己出牌阶段的手牌峰值。

  调用方
  afterCardMove listener。

  输入
  无；读取当前 authoritative state。

  输出
  无返回值。

  读取状态
  phase、currentPlayerIndex、当前玩家 hand。

写入状态
收牌者 achievementFacts.cardsGained 与当前玩家 achievementFacts.maxHandCount。

  调用函数
  recordFor、Math.max。

边界与不变量
获牌按每张 afterCardMove 累计；只在 turnStart/turnEnd 界定的本人行动回合采样手牌峰值，响应者手牌变化不会被误算。
  */
  handleAfterCardMove(event = {}) {
    if (event.to === "hand") {
      const recipient = event.player ?? event.toPlayer;
      const recipientRecord = this.recordFor(recipient);
      if (recipientRecord) recipientRecord.achievementFacts.cardsGained += 1;
    }
    if (!this.currentTurnPlayerId) return;
    const state = this.getState();
    const current = state.players.find((player) => player.id === this.currentTurnPlayerId);
    const record = this.recordFor(current);
    if (record) record.achievementFacts.maxHandCount = Math.max(
      record.achievementFacts.maxHandCount,
      current.hand?.length ?? 0
    );
  }

  /*
  功能
  记录雷达战术判定，并补记确定进入手牌的基础判定牌。

  调用方
  judgmentRevealed listener。

  输入
  含 attacker、defender 与判定牌 category 的结构化事件。

  输出
  无返回值。

  读取状态
  defender record 与 card.category。

  写入状态
  defender achievementFacts.radarTacticJudgments/cardsGained。

  调用函数
  recordFor。

  边界与不变量
  只有带攻击者的防御雷达判定才计数；tactic 仅增加 Radar 事实，basic 的确定性手牌去向增加获牌事实；延迟判定没有 attacker，不会混入。
  */
  handleJudgmentRevealed(event) {
    if (!event?.attacker || !event.defender) return;
    const record = this.recordFor(event.defender);
    if (!record) return;
    if (event.card?.category === "tactic") record.achievementFacts.radarTacticJudgments += 1;
    if (event.card?.category === "basic") record.achievementFacts.cardsGained += 1;
  }

  /*
功能
累计真实减伤与护盾吸收归属、目标实际生命承伤、闪电命中事实、来源对敌实际生命伤害与攻击结算峰值。

  调用方
  afterDamage listener。

  输入
含 source、target、actualAmount 与 finalAttackDamage 的结算后事件。

  输出
  无返回值。

  读取状态
  结构化 afterDamage fact。

写入状态
合法 provider 的 allyMitigation/allyShieldAbsorbed、target.hpDamageTaken/闪电命中与 source.enemyHpDamage/单次攻击峰值。

  调用函数
  settleMitigationContributions、settleShieldAbsorption、recordFor。

边界与不变量
承伤与火力只取 actualAmount；单次攻击峰值只取同一 afterDamage 事实中的 finalAttackDamage，保留 HP/护盾截断前数值；
友伤、自伤、环境伤害、格挡与减伤至零均不产生攻击峰值。
  */
  handleAfterDamage(event) {
    this.settleMitigationContributions(event);
    this.settleShieldAbsorption(event);
    const actualAmount = Math.max(0, Number(event.actualAmount) || 0);
    const targetRecord = this.recordFor(event.target);
    if (targetRecord) targetRecord.totals.hpDamageTaken += actualAmount;
    if (targetRecord && event.damageType === "lightning" && actualAmount > 0) {
      targetRecord.achievementFacts.lightningDamageTakenHits += 1;
      if (event.metadata?.originPlayerId === event.target.id) {
        targetRecord.achievementFacts.selfLightningHit = true;
      }
    }
    if (event.damageType === "lightning" && actualAmount > 0 && event.metadata?.originPlayerId) {
      const origin = this.getState().players.find((player) => player.id === event.metadata.originPlayerId);
      if (origin && event.target && origin.battleTeam !== event.target.battleTeam) {
        const originRecord = this.recordFor(origin);
        if (originRecord) originRecord.achievementFacts.lightningHits += 1;
      }
    }
    if (!event.source || !event.target || event.source.battleTeam === event.target.battleTeam) return;
    const record = this.recordFor(event.source);
    if (record) {
      record.totals.enemyHpDamage += actualAmount;
      const finalAttackDamage = Math.max(0, Number(event.finalAttackDamage) || 0);
      if (finalAttackDamage > 0) {
        const resolutionId = event.resolutionId ?? null;
        if (resolutionId && record.achievementFacts.damageResolutionId === resolutionId) {
          record.achievementFacts.damageResolutionTotal += finalAttackDamage;
        } else {
          record.achievementFacts.damageResolutionId = resolutionId;
          record.achievementFacts.damageResolutionTotal = finalAttackDamage;
        }
        record.achievementFacts.maxSingleAttackDamage = Math.max(
          record.achievementFacts.maxSingleAttackDamage,
          record.achievementFacts.damageResolutionTotal
        );
      }
      const state = this.getState();
      const current = state.players[state.currentPlayerIndex];
      if (current?.id === event.source.id && this.currentTurnPlayerId === event.source.id) {
        record.achievementFacts.turnDamage += actualAmount;
        record.achievementFacts.maxTurnDamage = Math.max(
          record.achievementFacts.maxTurnDamage,
          record.achievementFacts.turnDamage
        );
      }
    }
  }

  /*
  功能
  累计绕过护盾的效果失血所造成的真实生命承伤。

  调用方
  afterHpLoss listener。

  输入
  含 player 与 actualAmount 的结算后 HP-loss 事件。

  输出
  无返回值。

  读取状态
  结构化 afterHpLoss fact。

  写入状态
  player.hpDamageTaken。

  调用函数
  recordFor。

  边界与不变量
  只取 workflow 已提交的实际失血；不读取最终 HP，不把治疗、护盾或死亡状态切换计为承伤。
  */
  handleAfterHpLoss(event) {
    const record = this.recordFor(event.player);
    if (record) record.totals.hpDamageTaken += Math.max(0, Number(event.actualAmount) || 0);
  }

  /*
  功能
  累计真正由玩家导致的敌方阵亡，并在死亡改变存活人数后维护双方真实残局快照。

  调用方
  playerDead listener。

  输入
  含 source 与 target 的正式死亡事件。

  输出
  无返回值。

  读取状态
  结构化 playerDead fact。

  写入状态
  合法击杀者的 enemyKills、队友死亡数，以及所有唯一幸存者真实经历的残局档位。

  调用函数
  getState、recordFor。

  边界与不变量
  友军击杀、自杀和无来源环境死亡不计击杀，但仍可形成残局；只记录真实出现的 1v2/1v3，已有档位不删除。
  */
  handlePlayerDead(event) {
    const source = event.source;
    const target = event.target;
    if (!target) return;
    this.pendingRescueContributors.delete(target.id);
    if (source && source.id !== target.id && source.battleTeam !== target.battleTeam) {
      const sourceRecord = this.recordFor(source);
      if (sourceRecord) {
        sourceRecord.totals.enemyKills += 1;
        const state = this.getState();
        const current = state.players[state.currentPlayerIndex];
        if (current?.id === source.id && this.currentTurnPlayerId === source.id) {
          sourceRecord.achievementFacts.turnKills += 1;
          sourceRecord.achievementFacts.maxTurnKills = Math.max(
            sourceRecord.achievementFacts.maxTurnKills,
            sourceRecord.achievementFacts.turnKills
          );
        }
      }
    }

    const players = this.getState().players;
    for (const record of this.records.values()) {
      if (record.playerId !== target.id && record.teamId === target.battleTeam) {
        record.achievementFacts.teammateDeaths += 1;
      }
    }
    for (const survivor of players.filter((player) => player.alive)) {
      const survivingAllies = players.filter(
        (player) => player.alive && player.battleTeam === survivor.battleTeam
      );
      if (survivingAllies.length !== 1) continue;
      const clutchEnemyCount = players.filter(
        (player) => player.alive && player.battleTeam !== survivor.battleTeam
      ).length;
      if (clutchEnemyCount !== 2 && clutchEnemyCount !== 3) continue;
      const survivorRecord = this.recordFor(survivor);
      if (!survivorRecord) continue;
      survivorRecord.achievementFacts.clutchEnemyCounts.add(clutchEnemyCount);
      // 数组事实保留每个真实档位；旧标量只为现有展示兼容而保留历史最大值。
      survivorRecord.clutchEnemyCount = Math.max(
        survivorRecord.clutchEnemyCount ?? 0,
        clutchEnemyCount
      );
    }
  }

  /*
  功能
  累计对队友实际普通治疗或濒死救援治疗，并登记当前濒死事件的真实贡献者。

  调用方
  afterHeal listener。

  输入
  含 source、target、actualAmount 与 isDyingRescue 的结算后事件。

  输出
  无返回值。

  读取状态
  结构化 afterHeal fact。

  写入状态
  source allyHealing 或 allyRescueHealing，以及目标对应的去重救援参与者。

  调用函数
  areAllies、recordFor。

  边界与不变量
  自疗和敌方治疗不计；同一笔救援只进入 rescue bucket，评分时再乘二；rescueCount 等待 playerRescued 才提交。
  */
  handleAfterHeal(event) {
    if (!this.areAllies(event.source, event.target)) return;
    const record = this.recordFor(event.source);
    if (!record) return;
    const amount = Math.max(0, Number(event.actualAmount) || 0);
    const key = event.isDyingRescue ? "allyRescueHealing" : "allyHealing";
    record.totals[key] += amount;
    if (!event.isDyingRescue || amount <= 0) return;
    const contributors = this.pendingRescueContributors.get(event.target.id) ?? new Set();
    contributors.add(event.source.id);
    this.pendingRescueContributors.set(event.target.id, contributors);
  }

  /*
  功能
  在真实 playerRescued commit 时为本次濒死事件的每名实际贡献者各提交一次救援。

  调用方
  playerRescued listener。

  输入
  含 target 的正式成功脱离濒死事件。

  输出
  无返回值。

  读取状态
  pendingRescueContributors 与玩家 records。

  写入状态
  各贡献者 rescueCount，并消费目标对应的参与者集合。

  调用函数
  recordFor。

  边界与不变量
  同一次濒死事件按玩家 ID 去重；没有正数救援贡献者时不计，失败死亡由 playerDead 丢弃集合。
  */
  handlePlayerRescued(event) {
    const targetId = event.target?.id;
    if (!targetId) return;
    const contributors = this.pendingRescueContributors.get(targetId);
    this.pendingRescueContributors.delete(targetId);
    for (const contributorId of contributors ?? []) {
      const record = this.recordFor(contributorId);
      if (record) record.achievementFacts.rescueCount += 1;
    }
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
  通过现有团队牌资源贡献字段累计一次真实给牌结果。

  调用方
  handleCardsGranted、settleMutualBenefitContribution、handleCardUsed。

  输入
  发动者 record、source、实际获牌 target 与实际张数。

  输出
  无返回值。

  读取状态
  双方阵营与玩家身份。

  写入状态
  source record 的 allyCardsGranted 或 enemyCardsGranted。

  调用函数
  areAllies。

  边界与不变量
  自己获牌与非正数不计；贡献始终归属 source，同一次事实只在本 authority 累计一次。
  */
  recordGrantedCards(record, source, target, actualAmount) {
    const granted = Math.max(0, Number(actualAmount) || 0);
    if (!record || !source || !target || target.id === source.id || !granted) return;
    if (this.areAllies(source, target)) record.contributionFacts.allyCardsGranted += granted;
    else if (target.battleTeam !== source.battleTeam) {
      record.contributionFacts.enemyCardsGranted += granted;
    }
  }

  /*
  功能
  把 Action 提交后发布的实际给牌事实接入团队牌资源贡献 authority。

  调用方
  cardsGranted listener。

  输入
  含 source 与 grants 的 immutable fact。

  输出
  无返回值。

  读取状态
  source record 与每项 grant 的 target/actualAmount。

  写入状态
  source record 的 contributionFacts。

  调用函数
  recordFor、recordGrantedCards。

  边界与不变量
  仅消费已提交 Action 的显式事实；普通卡牌转移仍只由 cardUsed 结算，避免重复计分。
  */
  handleCardsGranted(event) {
    const record = this.recordFor(event.source);
    if (!record || !Array.isArray(event.grants)) return;
    for (const grant of event.grants) {
      this.recordGrantedCards(record, event.source, grant?.target, grant?.actualAmount);
    }
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
      this.recordGrantedCards(record, source, target, gained);
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
    if (event.resolved && event.card?.category === "equipment") record.achievementFacts.equipmentUses += 1;
    if (event.resolved && cardId === "lightning") record.achievementFacts.lightningCasts += 1;
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
      this.recordGrantedCards(record, source, receiver, 1);
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
  把封印成功生效后的基础贡献与真实弃牌数累计到原始施加者。

  调用方
  sealSettled fact listener。

  输入
  含 source、target 与 discardedCount 的已提交封印结算事实。

  输出
  无返回值。

  读取状态
  source/target 阵营与 source record。

  写入状态
  source record 的 sealContribution。

  调用函数
  recordFor。

  边界与不变量
  只接受敌方目标；基础贡献固定为一，附加值只取非负整数的真实弃牌数。
  */
  handleSealSettled(event) {
    const source = event.source;
    const target = event.target;
    const record = this.recordFor(source);
    if (!record || !source || !target || target.battleTeam === source.battleTeam) return;
    const discardedCount = Math.max(0, Math.floor(Number(event.discardedCount) || 0));
    record.contributionFacts.sealContribution += 1 + discardedCount;
  }

  /*
  功能
  累计一次真实主动技能支付的实际能量。

  调用方
  skillEnergyPaid listener。

  输入
  含 source 与 actualAmount 的 immutable payment fact。

  输出
  无返回值。

  读取状态
  skillEnergyPaid fact。

  写入状态
  record.skillEnergySpent。

  调用函数
  recordFor。

  边界与不变量
  只接受真实支付点发布的正数；免费、非法、取消、被动与 AI World simulation 均不发布该事实。
  */
  handleSkillEnergyPaid(event) {
    const actualAmount = Math.max(0, Number(event.actualAmount) || 0);
    const record = this.recordFor(event.source);
    if (record && actualAmount > 0) record.totals.skillEnergySpent += actualAmount;
  }

  /*
  功能
  记录真人玩家正式提交的突袭事实，并保留普通 action 主动突袭的既有计数。

  调用方
  cardCommitted listener。

  输入
  含 source、card 与 usageContext 的正式卡牌提交事实。

  输出
  无返回值。

  读取状态
  source.controllerType、card.definitionId 与 usageContext。

  写入状态
  source achievementFacts.committedAssaultUses，以及普通 action 的 activeAssaultUses。

  调用函数
  recordFor。

  边界与不变量
  committedAssaultUses 接受真人全部正式提交的突袭；activeAssaultUses 仍只接受普通 action，AI 与提交前取消均不计数。
  */
  handleCardCommitted(event) {
    if (event.source?.controllerType !== "human"
      || event.card?.definitionId !== "assault") return;
    const record = this.recordFor(event.source);
    if (!record) return;
    record.achievementFacts.committedAssaultUses += 1;
    if (event.usageContext === "action") record.achievementFacts.activeAssaultUses += 1;
  }

  /*
  功能
  累计一次事务已提交的主动技能使用动作。

  调用方
  activeSkillUsed listener。

  输入
  含 source 与 skill 的 immutable fact。

  输出
  无返回值。

  读取状态
  source 对应 tracker record。

  写入状态
  achievementFacts.activeSkillUses。

  调用函数
  recordFor。

  边界与不变量
  免费主动技能也计一次；非法、取消、回滚和被动触发均不会发布该事实。
  */
  handleActiveSkillUsed(event) {
    const record = this.recordFor(event.source);
    if (record) record.achievementFacts.activeSkillUses += 1;
  }

  /*
  功能
  收束未结束回合并冻结整局 raw performance snapshot。

  调用方
  MatchPerformanceSidecar 的 gameOver listener 与测试。

  输入
  无。

输出
冻结的 { gameId, finalRound, players } snapshot。

读取状态
MatchState currentRound/players.alive/winnerTeam 与 tracker records。

  写入状态
  finalizedSnapshot。

  调用函数
  freezePlayerRecord。

  边界与不变量
  同局重复 finalize 返回同一 immutable snapshot；玩家按原座位输出，评分排序留给 ViewModel。
  */
  finalizeMatch() {
    if (this.finalizedSnapshot) return this.finalizedSnapshot;
    const state = this.getState();
    const players = Object.freeze([...this.records.values()]
      .sort((left, right) => left.seatIndex - right.seatIndex)
      .map((record) => {
        const player = state.players.find((candidate) => candidate.id === record.playerId);
        return freezePlayerRecord(record, Boolean(player?.alive), state.winnerTeam, player);
      }));
    this.finalizedSnapshot = Object.freeze({
      gameId: this.gameId,
      finalRound: Math.max(0, Number(state.currentRound) || 0),
      players
    });
    return this.finalizedSnapshot;
  }
}
