/**
 * 实时存活座位环与攻击范围工具。只读取 Game/过滤快照中的公开座位和 alive；
 * 不修改状态、不缓存距离矩阵。视觉 seatIndex 只保存原始顺时针次序，阵亡后
 * 必须重新构造 aliveRing，所有卡牌和 AI 模拟都经 RuleEngine 调用本系统。
 */
import { getAliveRing as getAliveRingFromRule, getBaseDistance as getBaseDistanceFromRule, getDistance as getDistanceFromRule } from "../domain/rules/distance/DistanceRules.js?build=20260816-legacy-recovery";

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

  /*
  功能
  把真实或 AI 过滤玩家统一投影为 Deterministic Distance Rule 需要的 canonical 事实。

  调用方
  getAliveRing/getBaseDistance/getDistance/getRangeConditionBranches。

  输入
  game。

  输出
  冻结的 { id, seatIndex, alive } 数组。

  读取状态
  game.state.players 或 game.players。

  写入状态
  无。

  调用函数
  Object.freeze。

  边界与不变量
  legacy dual-schema 只归一化到本 facade；Domain Distance Rule 不接触 Real Player/SearchState。
  */
  static getDistancePlayerFacts(game) {
    const players = game?.state?.players ?? game?.players ?? [];
    return players.map((player) => Object.freeze({
      id:player.id,
      seatIndex:player.seatIndex,
      alive:player.alive
    }));
  }

  /*
  功能
  返回按 seatIndex 升序的存活玩家。

  调用方
  Distance deterministic 与 probability branches。

  输入
  game。

  输出
  存活玩家数组。

  读取状态
  game.state.players。

  写入状态
  无。

  调用函数
  getAliveRingFromRule。

  边界与不变量
  不修改输入。
  */
  static getAliveRing(game) {
    const rulePlayers = this.getDistancePlayerFacts(game);
    return getAliveRingFromRule(rulePlayers)
      .map((player) => (game.state?.players ?? game.players ?? []).find((entry) => entry.id === player.id))
      .filter(Boolean);
  }

  /*
  功能
  返回存活环基础距离。

  调用方
  deterministic 与 AI probability。

  输入
  game、source、target。

  输出
  非负整数或 Infinity。

  读取状态
  game.state.players。

  写入状态
  无。

  调用函数
  getBaseDistanceFromRule。

  边界与不变量
  只转发 Domain Rule。
  */
  static getBaseDistance(game, source, target) {
    const rulePlayers = this.getDistancePlayerFacts(game);
    return getBaseDistanceFromRule(
      rulePlayers,
      rulePlayers.find((player) => player.id === source?.id) ?? null,
      rulePlayers.find((player) => player.id === target?.id) ?? null
    );
  }

  /*
  功能
  返回 deterministic 方向性距离。

  调用方
  RuleEngine 与 legacy consumers。

  输入
  game、source、target。

  输出
  非负整数或 Infinity。

  读取状态
  game.state.players 与装备定义。

  写入状态
  无。

  调用函数
  getDistanceFromRule。

  边界与不变量
  AI 概率分支仍留在本 facade。
  */
  static getDistance(game, source, target) {
    const rulePlayers = this.getDistancePlayerFacts(game);
    return getDistanceFromRule(
      rulePlayers,
      rulePlayers.find((player) => player.id === source?.id) ?? null,
      rulePlayers.find((player) => player.id === target?.id) ?? null,
      this.getEquipmentDefinitionId(source),
      this.getEquipmentDefinitionId(target)
    );
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
    const rulePlayers = this.getDistancePlayerFacts(game);
    return branches.map((branch) => {
      const requirementMatches = entries.map(({ source, target, range }) => {
        const distance = getDistanceFromRule(
          rulePlayers,
          rulePlayers.find((player) => player.id === source?.id) ?? null,
          rulePlayers.find((player) => player.id === target?.id) ?? null,
          isPresent(branch.conditions, source, "telescope") ? "telescope" : null,
          isPresent(branch.conditions, target, "barrierDevice") ? "barrierDevice" : null
        );
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
