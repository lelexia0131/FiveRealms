import { createOpponentHandView } from "../ui/handVisibility.js";
import { MATCH_PERFORMANCE_DIMENSIONS } from "../ui/results/MatchPerformancePolicy.js";

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
真实 state、Guest playerId 与经过筛选的 presentation。

输出
data-only client projection。

读取状态
玩家公开属性、本地手牌、合法已知记忆及公开牌区。

写入状态
无。

调用函数
createOpponentHandView、projectNetworkCard。

边界与不变量
不输出敌方未知手牌 ID、牌库内容、RNG、aiMemory、待处理响应或隐藏 selection；绝不展开 MatchState。
*/
export function projectNetworkGame(state, viewerId, presentation = null) {
  const viewer = state.players.find((player) => player.id === viewerId);
  if (!viewer) throw new Error("缺少合法 Network viewer");
  const players = state.players.map((player) => ({
    playerId: player.id, seatId: player.seatId, seatIndex: player.seatIndex,
    teamId: player.battleTeam, characterId: player.characterId, name: player.name,
    hp: player.hp, maxHp: player.maxHp, energy: player.energy, maxEnergy: player.maxEnergy,
    shield: player.shield, alive: player.alive, handCount: player.hand.length,
    equipment: projectNetworkCard(player.equipment),
    statusIds: Object.keys(player.statuses ?? {}),
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
    presentation: projectNetworkPresentation(presentation)
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
  if (p.kind === "result") return { kind: p.kind, result: projectNetworkResult(p.result) };
  if (p.kind === "feedback") return { kind: p.kind, effect: String(p.effect), playerId: p.playerId, amount: p.amount };
  if (p.kind === "action") return { kind: p.kind, card: projectNetworkCard(p.card), skillName: p.skillName };
  if (p.kind === "judgment") return { kind: p.kind, card: projectNetworkCard(p.card), playerId: p.playerId };
  if (["thinking", "dying"].includes(p.kind)) return { kind: p.kind, playerId: p.playerId };
  return null;
}
