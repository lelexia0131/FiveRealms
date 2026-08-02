import { joinProbabilityStateBranches } from "../ai/AiProbabilityBranches.js?build=20260802-resource-branches-v57";

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
    // AI partial-death snapshots keep any nonzero-survival player in this union ring.
    // Actor/target legality is intersected with hpBranches; only intermediate-seat
    // removal remains a documented conservative approximation to avoid enumerating rings.
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
   * 枚举一组距离要求共享的装备世界。每个分支保存无条件概率质量、规范化条件集，
   * 以及所有距离/装备要求是否同时成立；同一望远镜变量只枚举一次。
   */
  static getRangeConditionBranches(game, requirements, options = {}) {
    const entries = (Array.isArray(requirements) ? requirements : [requirements]).filter(Boolean);
    if (!entries.length) return [{ probability:1, conditions:{}, matches:true }];
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
      const stateBranches = Array.isArray(player.equipmentStateBranches) && player.equipmentStateBranches.length
        ? player.equipmentStateBranches.map((branch) => {
          const present = Boolean(branch.present && branch.definitionId === definitionId);
          return {
            probability:branch.probability,
            conditions:{ ...branch.conditions, [key]:present ? "present" : "absent" }
          };
        })
        : null;
      const probability = this.getEquipmentDefinitionId(player) === definitionId
        ? this.getEquipmentEffectProbability(player, definitionId)
        : 0;
      variables.set(key, { player, definitionId, probability, stateBranches });
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
      const partition = variable.stateBranches ?? [
        { probability, conditions:{ [key]:"present" } },
        { probability:1 - probability, conditions:{ [key]:"absent" } }
      ].filter((branch) => branch.probability > 0);
      branches = joinProbabilityStateBranches(branches, partition);
    }

    const isPresent = (conditions, player, definitionId) => (
      conditions[this.equipmentConditionKey(player, definitionId)] === "present"
    );
    return branches.map((branch) => {
      const distancesLegal = entries.every(({ source, target, range }) => {
        const baseDistance = this.getBaseDistance(game, source, target);
        if (!Number.isFinite(baseDistance)) return false;
        if (baseDistance === 0) return true;
        const distance = Math.max(1, baseDistance - (isPresent(branch.conditions, source, "telescope") ? 1 : 0))
          + (isPresent(branch.conditions, target, "barrierDevice") ? 1 : 0);
        return distance <= range;
      });
      const equipmentLegal = (options.equipmentRequirements ?? []).every(({ player, definitionId, present = true }) => (
        isPresent(branch.conditions, player, definitionId) === present
      ));
      return {
        probability:branch.probability,
        conditions:Object.fromEntries(Object.entries(branch.conditions).sort(([left], [right]) => left.localeCompare(right))),
        matches:distancesLegal && equipmentLegal
      };
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
