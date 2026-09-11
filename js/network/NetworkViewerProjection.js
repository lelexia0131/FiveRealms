import { createOpponentHandView } from "../ui/handVisibility.js";
import { MATCH_PERFORMANCE_DIMENSIONS } from "../ui/results/MatchPerformancePolicy.js";

  /*
  功能
  按字段白名单保留 Host AI 速度、已计算的公开距离与安全日志。

  调用方
  projectNetworkGame。

  输入
  Host presentation bridge 生成的展示 DTO。

  输出
  仅展示用途的 DTO，缺省为 null。

  读取状态
  Host AI 速度、计算的距离、射程、可达性说明与经过脱敏的日志片段。

  写入状态
  无。

  调用函数
  Object.fromEntries。

  边界与不变量
  不能展开 state、任意嵌套对象或原始 Host 日志；可达性和说明必须由 Host bridge 提供。
  */
export function projectNetworkDisplay(display) {
  if (!display) return null;
  return {
    aiSpeed: display.aiSpeed,
    prompt: display.prompt ? { message: display.prompt.message, handHint: display.prompt.handHint, revision: display.prompt.revision } : null,
    distances: Object.fromEntries(Object.entries(display.distances ?? {}).map(([target, value]) => [
      target, {
        distance: value.distance, range: value.range, seat: value.seat,
        reachable: value.reachable === true,
        distanceState: typeof value.distanceState === "string" ? value.distanceState : ""
      }
    ])),
    logs: (display.logs ?? []).map((entry) => ({
      id: entry.id, kind: entry.kind,
      fragments: entry.fragments.map((fragment) => fragment.type === "player"
        ? { type: "player", text: fragment.text, playerId: fragment.playerId, battleTeam: fragment.battleTeam }
        : { type: "text", text: fragment.text })
    }))
  };
}


/*
功能
将已经允许展示的牌缩减为稳定身份和定义。

调用方
viewer projection 与决策展示。

输入
合法可见的 card。

输出
牌面 DTO 或 null。

读取状态
id、definitionId。

写入状态
无。

调用函数
无。

边界与不变量
只有调用方确认可见后才能传入；不展开实体扩展字段。
*/
export function projectNetworkCard(card) {
  return card ? { id: card.id, definitionId: card.definitionId } : null;
}

/*
功能
从唯一 Host 状态生成指定观看者的展示投影。

调用方
NetworkGameChannel.publish。

输入
真实 state、Guest playerId、经过筛选的 presentation/display 与 setup 角色映射。

输出
data-only client projection。

读取状态
玩家公开属性、本地手牌、合法已知记忆、公开牌区及 Network setup role metadata。

写入状态
无。

调用函数
createOpponentHandView、projectNetworkCard。

边界与不变量
不输出敌方未知手牌 ID、牌库内容、RNG、aiMemory、待处理响应或隐藏 selection；绝不展开 MatchState。
*/
export function projectNetworkGame(state, viewerId, presentation = null, display = null, networkRoles = {}) {
  const viewer = state.players.find((player) => player.id === viewerId);
  if (!viewer) throw new Error("缺少合法 Network viewer");
  const players = state.players.map((player) => ({
    playerId: player.id, seatId: player.seatId, seatIndex: player.seatIndex,
    displayName: networkRoles[player.id] ?? null,
    networkRole: networkRoles[player.id] ?? null,
    teamId: player.battleTeam, characterId: player.characterId, name: player.name,
    hp: player.hp, maxHp: player.maxHp, energy: player.energy, maxEnergy: player.maxEnergy,
    shield: player.shield, alive: player.alive, handCount: player.hand.length,
    equipment: projectNetworkCard(player.equipment),
    statusIds: Object.keys(player.statuses ?? {}),
    publicDisplay: {
      exposeWeaknessStacks: player.statuses?.exposeWeakness?.stacks ?? 0,
      turnFlags: {
        momentum: player.turnFlags?.momentum ?? 0,
        recycleDeviceUses: player.turnFlags?.recycleDeviceUses ?? 0,
        assaultMagazineUsed: player.turnFlags?.assaultMagazineUsed ?? 0
      }
    },
    hand: player.id === viewerId ? player.hand.map(projectNetworkCard) : null,
    observedHand: player.id === viewerId ? null : createOpponentHandView(viewer, player)
  }));
  return {
    gameId: state.gameId, viewerId, stateVersion: state.stateVersion,
    round: state.currentRound, phase: state.phase,
    currentPlayerId: state.players[state.currentPlayerIndex]?.id ?? null,
    winnerTeam: state.winnerTeam, isGameOver: state.isGameOver,
    deckCount: state.deck?.cards?.length ?? 0,
    players, resolvingCards: (state.resolvingCards ?? []).map(projectNetworkCard),
    discardCount: state.discardPile?.length ?? 0,
    publicCards: (state.publicCardPool ?? []).map(projectNetworkCard),
    presentation: projectNetworkPresentation(presentation),
    display: projectNetworkDisplay(display)
  };
}

/*
功能
白名单投影终局评分与MVP展示，不发送tracker内部事实。

调用方
Host 终局 presentation bridge。

输入
最终 MatchResultViewModel。

输出
仅展示需要的结果 DTO。

读取状态
排名、六维分数与公开战斗统计。

写入状态
无。

调用函数
Object.fromEntries。

边界与不变量
不复制achievementFacts、原始contributionFacts或任何永久成就内容。
*/
export function projectNetworkResult(result) {
  if (!result) return null;
  return {
    gameId: result.gameId, finalRound: result.finalRound,
    mvpPlayerId: result.mvpPlayerId, defaultSelectedPlayerId: result.defaultSelectedPlayerId,
    players: result.players.map((player) => ({
      playerId: player.playerId, teamId: player.teamId, characterId: player.characterId,
      primaryName: player.primaryName, secondaryLabel: player.secondaryLabel,
      rank: player.rank, isMvp: player.isMvp, finalScore: player.finalScore,
      baseScore: player.baseScore, roundMultiplier: player.roundMultiplier,
      victoryMultiplier: player.victoryMultiplier,
      raw: Object.fromEntries(MATCH_PERFORMANCE_DIMENSIONS.map((key) => [key, player.raw[key]])),
      ratios: Object.fromEntries(MATCH_PERFORMANCE_DIMENSIONS.map((key) => [key, player.ratios[key]])),
      scores: Object.fromEntries(MATCH_PERFORMANCE_DIMENSIONS.map((key) => [key, player.scores[key]])),
      combatStats: { totalDamage: player.combatStats.totalDamage, support: player.combatStats.support, damageTaken: player.combatStats.damageTaken }
    }))
  };
}

/*
功能
白名单过滤公开 presentation，拒绝任意附加状态。

调用方
projectNetworkGame。

输入
presentation descriptor。

输出
安全描述或 null。

读取状态
公开展示字段。

写入状态
无。

调用函数
projectNetworkCard、projectNetworkResult。

边界与不变量
未知 kind 不发送；私密信息只能通过已授权决定揭示，不能混入广播。
*/
export function projectNetworkPresentation(presentation) {
  if (!presentation) return null;
  const p = presentation;
  if (p.kind === "action-cue" && ["playCard", "skill"].includes(p.cue)) return { kind: p.kind, cue: p.cue };
  if (p.kind === "duel") return { kind: p.kind, playerId: p.playerId, opponentId: p.opponentId };
  if (p.kind === "clear" && ["hideJudgment", "hideDying", "hideDuel", "resetCurrentCard"].includes(p.view)) return { kind: p.kind, view: p.view };
  if (p.kind === "vfx" && ["playRadarSuccess", "playLightningHit"].includes(p.view)) return { kind: p.kind, view: p.view, playerId: p.playerId };
  if (p.kind === "result") return { kind: p.kind, result: projectNetworkResult(p.result) };
  if (p.kind === "feedback") return { kind: p.kind, effect: String(p.effect), playerId: p.playerId, amount: p.amount, variant: typeof p.variant === "string" ? p.variant : null };
  if (p.kind === "action") return {
    kind: p.kind, card: projectNetworkCard(p.card), skillName: p.skillName,
    source: typeof p.source === "string" ? p.source : "", targetLabel: typeof p.targetLabel === "string" ? p.targetLabel : "",
    displayTargets: p.displayTargets?.map((target) => ({ id: target.id, name: target.name, isSelf: target.isSelf === true })) ?? null
  };
  if (p.kind === "judgment") return {
    kind: p.kind, card: projectNetworkCard(p.card), playerId: p.playerId,
    delayedStatus: p.delayedStatus ? { ownerName: p.delayedStatus.ownerName, statusName: p.delayedStatus.statusName } : null
  };
  if (p.kind === "thinking") return { kind: p.kind, playerId: p.playerId, message: typeof p.message === "string" ? p.message : "正在思考" };
  if (p.kind === "dying") return { kind: p.kind, playerId: p.playerId, currentHp: p.currentHp, need: p.need };
  return null;
}
