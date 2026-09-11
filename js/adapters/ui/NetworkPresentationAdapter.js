/*
模块职责
把 viewer-safe Network 投影转成正式 UI 的只读展示模型。

上游
NetworkGameView。

下游
公开角色/卡牌展示定义。

状态边界
只读取投影和本地 UI 选择状态；不创建或模拟 MatchState。

信息边界
对手手牌只使用 observedHand 与 handCount，不制造未知牌实体。

架构约束
不得依赖规则查询、MatchApplication、GameLoop、AI、Worker 或 ActionWorkflow。
*/
import { CHARACTER_BY_ID } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { presentCharacter } from "./CharacterPresentationDefinitions.js";
import { PHASE_PRESENTATION } from "./PresentationMetadata.js";
import { presentCard } from "./CardPresentationDefinitions.js";
import { orderPlayersForViewer } from "../../ui/PlayerPresentationOrder.js";

/*
功能
把 Host 已确定的可见字段转换成正式战场模板输入。

调用方
NetworkGameView.render。

输入
projection、当前请求，以及 UI 的 target/discard/thinking 展示状态。

输出
data-only 正式战场、手牌及按钮展示模型。

读取状态
仅 viewer-safe projection 与公开角色定义。

写入状态
无。

调用函数
orderPlayersForViewer、presentCharacter、presentCard。

边界与不变量
只重命名和排列字段；距离和可用性仅来自 Host，绝不调用规则。
*/

export function presentNetworkGame(projection, request, ui) {
  const p = projection;
  const orderedProjectionPlayers = orderPlayersForViewer(p.players, p.viewerId);
  const players = orderedProjectionPlayers.map((entry) => ({
    id: entry.playerId, seatIndex: entry.seatIndex, battleTeam: entry.teamId,
    displayName: entry.displayName ?? entry.networkRole,
    networkRole: entry.networkRole,
    character: CHARACTER_BY_ID[entry.characterId], name: entry.name,
    loreFaction: CHARACTER_BY_ID[entry.characterId]?.loreFaction ?? "",
    hp: entry.hp, maxHp: entry.maxHp, energy: entry.energy, maxEnergy: entry.maxEnergy,
    shield: entry.shield, alive: entry.alive, equipment: entry.equipment,
    hand: entry.hand ?? [], handCount: entry.handCount,
    statuses: Object.fromEntries(entry.statusIds.map((id) => [id,
      id === "exposeWeakness" ? { stacks: entry.publicDisplay.exposeWeaknessStacks } : {}
    ])),
    turnFlags: entry.publicDisplay?.turnFlags ?? {}
  }));
  const human = players.find((player) => player.id === p.viewerId);
  if (!human) throw new Error("Network presentation 缺少 viewer model");
  const panels = players.map((player, index) => ({
    player,
    options: {
      humanTeam: human.battleTeam, isHuman: index === 0, isViewer: player.id === human.id,
      isCurrent: p.currentPlayerId === player.id, isThinking: ui.thinkingPlayerId === player.id,
      isTargeting: Boolean(ui.targetState),
      isLegalTarget: Boolean(ui.targetState?.legalIds.has(player.id)),
      isSelectedTarget: ui.targetState?.selected?.id === player.id,
      distanceInfo: ui.targetState?.meta?.targetDisplay
        ? ui.targetState.meta.targetDisplay[player.id] ?? null
        : human.alive && player.id !== human.id ? p.display?.distances?.[player.id] ?? null : null,
      distanceState: ui.targetState?.meta?.targetDisplay
        ? ui.targetState.meta.targetDisplay[player.id]?.distanceState ?? null
        : request?.targetDisplay?.[player.id]?.distanceState ?? p.display?.distances?.[player.id]?.distanceState ?? null,
      displayName: player.displayName,
      networkRole: player.networkRole,
      opponentHandSlots: player.id === human.id
        ? human.hand.map((card) => ({ ...presentCard(card), known: true }))
        : orderedProjectionPlayers[index].observedHand
    }
  }));
  const options = request?.kind === "player-intent" ? request.options : [];
  const cardOptions = new Set(options.filter((option) => option.card).map((option) => option.card.id));
  const skill = options.find((option) => option.intent === "skill");
  const end = options.find((option) => option.intent === "end");
  return {
    players, human,
    battlefield: {
      gameId: p.gameId,
      metrics: [
        ["轮次", `第 ${p.round} 轮`, "round"],
        ["当前角色", players.find((player) => player.id === p.currentPlayerId)?.name ?? "—", "active"],
        ["阶段", PHASE_PRESENTATION[p.phase] ?? p.phase, "phase"],
        ["阵营", `晨 ${players.filter((player) => player.alive && player.battleTeam === "dawn").length} · 暮 ${players.filter((player) => player.alive && player.battleTeam === "dusk").length}`, "teams"],
        ["牌堆", p.deckCount, "deck"], ["弃牌", p.discardCount, "discard"]
      ],
      self: panels[0],
      opponents: panels.slice(1)
    },
    hand: human.hand.map((card) => ({
      card, selected: ui.discardState?.selectedIds.has(card.id) || ui.targetState?.meta?.card?.id === card.id,
      disabled: ui.discardState ? !request?.options.some((option) => option.card?.id === card.id) : !cardOptions.has(card.id)
    })),
    controls: {
      skillLabel: presentCharacter(human.character)?.activeName || "主动技能",
      skillDisabled: !skill, endDisabled: !end
    }
  };
}
