/**
 * 实时存活座位环与攻击范围工具。只读取 Game/过滤快照中的公开座位和 alive；
 * 不修改状态、不缓存距离矩阵。视觉 seatIndex 只保存原始顺时针次序，阵亡后
 * 必须重新构造 aliveRing，所有卡牌和 AI 模拟都经 RuleEngine 调用本系统。
 */
export class DistanceSystem {
  static getEquipmentDefinitionId(player) {
    return player?.equipment?.definitionId ?? player?.equipmentDefinitionId ?? null;
  }

  /** 真实角色没有概率字段，恒按1处理；AI 快照可携带装备仍存在的概率。 */
  static getEquipmentEffectProbability(player, definitionId) {
    if (this.getEquipmentDefinitionId(player) !== definitionId) return 0;
    const probability = player?.equipmentRetentionProbability;
    return probability == null ? 1 : Math.max(0, Math.min(1, Number(probability) || 0));
  }

  static getAliveRing(game) {
    return game.state.players.filter((player) => player.alive).sort((a,b) => a.seatIndex - b.seatIndex);
  }

  static getBaseDistance(game, source, target) {
    if (!source || !target || !source.alive || !target.alive) return Infinity;
    if (source.id === target.id) return 0;
    const ring = this.getAliveRing(game);
    const sourceIndex = ring.findIndex((player) => player.id === source.id);
    const targetIndex = ring.findIndex((player) => player.id === target.id);
    if (sourceIndex < 0 || targetIndex < 0) return Infinity;
    const clockwise = Math.abs(sourceIndex - targetIndex);
    return Math.min(clockwise, ring.length - clockwise);
  }

  static getDistance(game, source, target) {
    let distance = this.getBaseDistance(game, source, target);
    if (!Number.isFinite(distance) || distance === 0) return distance;
    // 真实距离保持整数规则；概率装备只能通过 getRangeLegalityProbability 参与 AI 推演。
    if (this.getEquipmentDefinitionId(source) === "telescope") distance = Math.max(1, distance - 1);
    if (this.getEquipmentDefinitionId(target) === "barrierDevice") distance += 1;
    return distance;
  }

  /**
   * 枚举距离装备的离散存在分支并返回处于范围内的概率；真实状态只会返回0或1。
   * options 仅供“借势已知指定装备存在”的条件分支使用，不影响真实规则。
   */
  static getRangeLegalityProbability(game, source, target, range, options = {}) {
    const baseDistance = this.getBaseDistance(game, source, target);
    if (!Number.isFinite(baseDistance)) return 0;
    if (baseDistance === 0) return 1;
    const telescopeProbability = options.sourceEquipmentPresent === true
      && this.getEquipmentDefinitionId(source) === "telescope"
      ? 1
      : this.getEquipmentEffectProbability(source, "telescope");
    const barrierProbability = options.targetEquipmentPresent === true
      && this.getEquipmentDefinitionId(target) === "barrierDevice"
      ? 1
      : this.getEquipmentEffectProbability(target, "barrierDevice");
    let legalProbability = 0;
    for (const [telescopePresent, telescopeBranch] of [[false, 1 - telescopeProbability], [true, telescopeProbability]]) {
      if (telescopeBranch <= 0) continue;
      for (const [barrierPresent, barrierBranch] of [[false, 1 - barrierProbability], [true, barrierProbability]]) {
        if (barrierBranch <= 0) continue;
        const distance = Math.max(1, baseDistance - (telescopePresent ? 1 : 0)) + (barrierPresent ? 1 : 0);
        if (distance <= range) legalProbability += telescopeBranch * barrierBranch;
      }
    }
    return Math.max(0, Math.min(1, legalProbability));
  }

  /** 兼容只读工具测试；业务规则统一调用 getDistance(game,...)。 */
  static distance(players, source, target) { return this.getDistance({ state:{ players } }, source, target); }

  static inAttackRange(game, source, target, card = null) {
    if (card?.ignoresDistance) return true;
    return this.getRangeLegalityProbability(game, source, target, source.attackRange ?? 1) > 0;
  }

  static describe(game, source, target) {
    return { seat:target.seatIndex + 1, distance:this.getDistance(game, source, target), range:source.attackRange ?? 1 };
  }
}
