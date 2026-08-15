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

  static equipmentConditionKey(player, definitionId) {
    return `equipment:${player.id}:${definitionId}`;
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
    if (this.getEquipmentDefinitionId(source) === "telescope") distance -= 1;
    if (this.getEquipmentDefinitionId(target) === "barrierDevice") distance += 1;
    return Math.max(1, distance);
  }

  /*
  功能
  枚举一组距离要求共享的装备世界。

  调用方
  getRangeLegalityProbability、ActionGenerator、ThreatValue 与其它距离概率查询。

  输入
  只读 game 局面、距离要求数组与可选装备/强制存在、逐项匹配选项。

  输出
  每个分支包含 probability、conditions 与 matches；includeRequirementMatches 为 true 时附逐项 requirementMatches。

  读取状态
  game.state.players 的存活、座位与装备保留概率。

  写入状态
  无。

  调用函数
  getBaseDistance、getEquipmentDefinitionId、getEquipmentEffectProbability、equipmentConditionKey。

  边界与不变量
  同一望远镜变量只枚举一次；matches 表示全部要求同时成立，逐项成立事实仅在显式请求时返回。

  */
  static getRangeConditionBranches(game, requirements, options = {}) {
    const entries = (Array.isArray(requirements) ? requirements : [requirements]).filter(Boolean);
    if (!entries.length) {
    const empty = { probability:1, conditions:{}, matches:true };
    if (options.includeRequirementMatches === true) empty.requirementMatches = [];
    return [empty];
  }
    const variables = new Map();
    const forcedConditions = new Map();
    const addVariable = (player, definitionId, forcedPresent = false) => {
      if (!player) return;
      const key = this.equipmentConditionKey(player, definitionId);
      if (forcedPresent) {
        forcedConditions.set(key, "present");
        variables.delete(key);
        return;
      }
      if (forcedConditions.has(key) || variables.has(key)) return;
      const probability = this.getEquipmentDefinitionId(player) === definitionId
        ? this.getEquipmentEffectProbability(player, definitionId)
        : 0;
      variables.set(key, { player, definitionId, probability });
    };

    for (const requirement of entries) {
      addVariable(requirement.source, "telescope", options.sourceEquipmentPresent === true && entries.length === 1);
      addVariable(requirement.target, "barrierDevice", options.targetEquipmentPresent === true && entries.length === 1);
    }
    for (const equipment of options.equipmentRequirements ?? []) {
      addVariable(equipment.player, equipment.definitionId);
    }

    let branches = [{ probability:1, conditions:Object.fromEntries(forcedConditions) }];
    for (const [key, variable] of variables) {
      const probability = Math.max(0, Math.min(1, Number(variable.probability) || 0));
      const next = [];
      if (probability > 0) for (const branch of branches) next.push({
        probability:branch.probability * probability,
        conditions:{ ...branch.conditions, [key]:"present" }
      });
      if (probability < 1) for (const branch of branches) next.push({
        probability:branch.probability * (1 - probability),
        conditions:{ ...branch.conditions, [key]:"absent" }
      });
      branches = next;
    }

    const isPresent = (conditions, player, definitionId) => (
      conditions[this.equipmentConditionKey(player, definitionId)] === "present"
    );
    return branches.map((branch) => {
      const requirementMatches = entries.map(({ source, target, range }) => {
        const baseDistance = this.getBaseDistance(game, source, target);
        if (!Number.isFinite(baseDistance)) return false;
        if (baseDistance === 0) return true;
        const distance = Math.max(1, baseDistance
          - (isPresent(branch.conditions, source, "telescope") ? 1 : 0)
          + (isPresent(branch.conditions, target, "barrierDevice") ? 1 : 0));
        return distance <= range;
      });
      const equipmentLegal = (options.equipmentRequirements ?? []).every(({ player, definitionId, present = true }) => (
        isPresent(branch.conditions, player, definitionId) === present
      ));
      const result = {
        probability:branch.probability,
        conditions:Object.fromEntries(Object.entries(branch.conditions).sort(([left], [right]) => left.localeCompare(right))),
        matches:requirementMatches.every(Boolean) && equipmentLegal
      };
      if (options.includeRequirementMatches === true) result.requirementMatches = requirementMatches;
      return result;
    });
  }

  static getRangeLegalityProbability(game, source, target, range, options = {}) {
    return this.getRangeConditionBranches(game, { source, target, range }, options)
      .filter((branch) => branch.matches)
      .reduce((sum, branch) => sum + branch.probability, 0);
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
