/**
 * 本文件建立 AI 合法可见状态，依赖完整 GameState 但会过滤其他角色的手牌内容。
 * AIController 必须通过此视图评估敌人；即使完整状态在同一内存中，也不能读取隐藏牌定义。
 * 技能合法窥见的牌只以 knownCardDefinitionIds 暴露，不会写入公开日志。
 */

/**
 * 创建指定 AI 的只读快照。
 * @param {string} viewerId 观察者玩家 ID。
 * @param {Object} state 完整游戏状态。
 * @returns {Object} 不含他人具体手牌对象的可见状态。
 */
export function createAiVisibleState(viewerId, state) {
  const viewer = state.players.find((player) => player.id === viewerId);
  if (!viewer) throw new Error("AI 可见状态缺少观察者");
  return Object.freeze({
    gameId: state.gameId,
    currentRound: state.currentRound,
    phase: state.phase,
    deckCount: state.deck.cards.length,
    discardCount: state.deck.discardPile.length,
    discardDefinitionIds: state.deck.discardPile.map((card) => card.definitionId),
    judgmentDefinitionIds: state.deck.judgmentZone.map((card) => card.definitionId),
    publicPool: (state.publicCardPool ?? []).map((card) => ({ id:card.id, definitionId:card.definitionId })),
    players: state.players.map((player) => Object.freeze({
      id: player.id,
      seatIndex: player.seatIndex,
      name: player.name,
      battleTeam: player.battleTeam,
      generalId: player.generalId,
      tags: [...player.general.tags],
      hp: player.hp,
      maxHp: player.maxHp,
      shield: player.shield,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      attackRange: player.attackRange,
      attackUsed: player.turnFlags.attackUsed,
      attackLimit: player.turnFlags.attackLimit,
      recoverUsed: player.turnFlags.recoverUsed,
      recoverLimit: player.turnFlags.recoverLimit,
      exposeWeaknessStacks: player.statuses.exposeWeakness?.stacks ?? 0,
      alive: player.alive,
      handCount: player.hand.length,
      hand: player.id === viewerId ? player.hand.map((card) => ({ id: card.id, definitionId: card.definitionId })) : undefined,
      knownCards: player.id === viewerId ? undefined : Object.entries(viewer.aiMemory.knownCardsByPlayer[player.id] ?? {}).map(([cardId, definitionId]) => ({ cardId, definitionId })),
      equipmentDefinitionId: player.equipment?.definitionId ?? null,
      statuses: Object.keys(player.statuses)
    }))
  });
}
