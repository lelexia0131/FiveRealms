/**
 * 实时存活座位环与攻击范围工具。只读取 Game/过滤快照中的公开座位和 alive；
 * 不修改状态、不缓存距离矩阵。视觉 seatIndex 只保存原始顺时针次序，阵亡后
 * 必须重新构造 aliveRing，所有卡牌和 AI 模拟都经 RuleEngine 调用本系统。
 */
export class DistanceSystem {
  static getEquipmentDefinitionId(player) {
    return player?.equipment?.definitionId ?? player?.equipmentDefinitionId ?? null;
  }

  /** 真实角色没有概率字段，恒按1处理；AI 期望快照按装备仍存在的概率加权效果。 */
  static getEquipmentEffectProbability(player, definitionId) {
    if (this.getEquipmentDefinitionId(player) !== definitionId) return 0;
    const probability = player?.equipmentRetentionProbability;
    return probability == null ? 1 : Math.max(0, Math.min(1, Number(probability) || 0));
  }

  static getAliveRing(game) {
    return game.state.players.filter((player) => player.alive).sort((a,b) => a.seatIndex - b.seatIndex);
  }

  static getDistance(game, source, target) {
    if (!source || !target || !source.alive || !target.alive) return Infinity;
    if (source.id === target.id) return 0;
    const ring = this.getAliveRing(game);
    const sourceIndex = ring.findIndex((player) => player.id === source.id);
    const targetIndex = ring.findIndex((player) => player.id === target.id);
    if (sourceIndex < 0 || targetIndex < 0) return Infinity;
    const clockwise = Math.abs(sourceIndex - targetIndex);
    const counterClockwise = ring.length - clockwise;
    let distance = Math.min(clockwise, counterClockwise);
    // 望远镜是进攻方向修正；屏障是防御方向修正。距离最低保持为1。
    distance = Math.max(1, distance - this.getEquipmentEffectProbability(source, "telescope"));
    distance += this.getEquipmentEffectProbability(target, "barrierDevice");
    return distance;
  }

  /** 兼容只读工具测试；业务规则统一调用 getDistance(game,...)。 */
  static distance(players, source, target) { return this.getDistance({ state:{ players } }, source, target); }

  static inAttackRange(game, source, target, card = null) {
    if (card?.ignoresDistance) return true;
    return this.getDistance(game, source, target) <= (source.attackRange ?? 1);
  }

  static describe(game, source, target) {
    return { seat:target.seatIndex + 1, distance:this.getDistance(game, source, target), range:source.attackRange ?? 1 };
  }
}
