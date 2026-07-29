/**
 * AI 团队效用评估器。只读取公开或过滤后的字段并返回分数，不生成、执行动作，
 * 不写 GameState；权重修改会影响阵营平衡，之后必须重跑 200 局模拟。
 */
export class AiEvaluator {
  constructor(game) { this.game = game; }

  stateUtility(state, viewerId) {
    const viewer = state.players.find((player) => player.id === viewerId);
    if (!viewer) return -Infinity;
    let score = 0;
    for (const player of state.players) {
      const sign = player.battleTeam === viewer.battleTeam ? 1 : -1;
      const death = player.alive ? 0 : -28;
      const danger = player.alive && player.hp <= 1 ? -7 : 0;
      score += sign * (death + danger + player.hp * 5 + player.shield * 2 + player.energy * 1.2 + player.handCount * 1.1 + (player.exposeWeaknessStacks ?? 0) * 1.5);
    }
    return score;
  }

  actionUtility(action, player, visible) {
    if (action.type === "end") return player.hand.length ? -0.8 : 0;
    if (action.type === "skill") return 4 + (action.skill.cost ?? 0) * 0.35;
    const card = action.card;
    let value = card.aiValue ?? 0;
    const target = action.targets?.[0];
    if (target) {
      const enemy = target.battleTeam !== player.battleTeam;
      if (card.subtypes.includes("attack") || card.definitionId === "duel") {
        const focus = (target.maxHp - target.hp) * 3 + (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        value += enemy ? 3 + focus : -12;
      }
      if (["plunder","destroy","scout"].includes(card.definitionId)) value += Math.min(4, target.hand?.length ?? target.handCount ?? 0);
    }
    if (card.definitionId === "recover") value += (player.maxHp - player.hp) * 4;
    if (card.definitionId === "charge") value += (player.maxEnergy - player.energy) * 1.5;
    if (card.definitionId === "exposeWeakness") value += player.hand.filter((entry) => entry.definitionId === "assault").length * 2;
    if (card.definitionId === "shockwave") value += this.game.getEnemies(player).filter((enemy) => enemy.hp <= 1).length * 7;
    if (card.definitionId === "symbiosis") {
      const net = this.symbiosisNet(player);
      value = net > 0 ? 8 + net : -9 + net;
    }
    if (card.category === "equipment" && player.equipment?.definitionId === card.definitionId) value -= 4;
    return value;
  }

  symbiosisNet(player) {
    return this.game.state.players.filter((entry) => entry.alive).reduce((sum, entry) => {
      const actual = entry.hp < entry.maxHp ? 1 : 0;
      return sum + (entry.battleTeam === player.battleTeam ? actual : -actual);
    }, 0) * 4;
  }
}
