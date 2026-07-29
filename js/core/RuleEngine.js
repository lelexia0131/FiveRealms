/**
 * 本文件集中判断卡牌与技能的合法目标，依赖卡牌定义但不执行效果。
 * UI 与 AI 必须使用同一套结果，避免界面允许、核心拒绝或 AI 攻击队友。
 */

export class RuleEngine {
  /** 返回指定卡牌当前所有合法目标；不会修改状态。 */
  static getCardTargets(game, source, card) {
    const alive = game.state.players.filter((player) => player.alive);
    switch (card.targetType) {
      case "singleEnemy": return alive.filter((player) => player.battleTeam !== source.battleTeam);
      case "enemyWithCards": return alive.filter((player) => player.battleTeam !== source.battleTeam && player.hand.length > 0);
      case "injuredAlly": return alive.filter((player) => player.id !== source.id && player.battleTeam === source.battleTeam && player.hp < player.maxHp);
      case "self": return [source];
      case "allEnemies": return alive.filter((player) => player.battleTeam !== source.battleTeam);
      case "none": return [];
      default: return [];
    }
  }

  /**
   * 判断卡牌能否主动使用。响应牌永远不能通过出牌区主动使用。
   * @returns {{ok:boolean,reason:string}}
   */
  static canPlayCard(game, source, card) {
    if (!source.alive) return { ok: false, reason: "角色已阵亡" };
    if (game.state.phase !== "play" || game.currentPlayer?.id !== source.id) return { ok: false, reason: "现在不是你的出牌阶段" };
    if (!source.hand.includes(card)) return { ok: false, reason: "这张牌已不在手中" };
    if (card.targetType === "responseOnly") return { ok: false, reason: "响应牌只能在对应时机使用" };
    if (card.definitionId === "assault" && source.turnFlags.attackUsed >= source.turnFlags.attackLimit) return { ok: false, reason: "本回合突袭次数已用尽" };
    if (card.definitionId === "recover" && (source.hp >= source.maxHp || source.turnFlags.recoverUsed >= source.turnFlags.recoverLimit)) return { ok: false, reason: "当前无法调息" };
    if (card.definitionId === "charge" && source.energy >= source.maxEnergy) return { ok: false, reason: "能量已经充满" };
    if (!["none", "self", "allEnemies"].includes(card.targetType) && this.getCardTargets(game, source, card).length === 0) return { ok: false, reason: "没有合法目标" };
    if (card.targetType === "allEnemies" && this.getCardTargets(game, source, card).length === 0) return { ok: false, reason: "没有存活敌人" };
    return { ok: true, reason: "" };
  }

  /** 返回主动技能当前合法目标；技能的额外资源条件由 skillRegistry 判断。 */
  static getSkillTargets(game, source, skillId) {
    const alive = game.state.players.filter((player) => player.alive);
    if (["barrier", "resonance"].includes(skillId)) return alive.filter((player) => player.id !== source.id && player.battleTeam === source.battleTeam);
    if (skillId === "symbiosis") return alive.filter((player) => player.id !== source.id && player.battleTeam === source.battleTeam && player.hp < player.maxHp);
    if (skillId === "stealSkill") return alive.filter((player) => player.battleTeam !== source.battleTeam && player.hand.length > 0);
    if (skillId === "hunt") return alive.filter((player) => player.battleTeam !== source.battleTeam && player.statuses.huntMark?.sourceId === source.id);
    return [];
  }
}
