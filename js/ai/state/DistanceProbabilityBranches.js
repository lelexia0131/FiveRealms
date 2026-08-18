/*
模块职责
拥有 AI 搜索距离条件的概率分支枚举；确定性距离公式仍由 Domain DistanceRules 唯一解释。

上游
js/ai/search、js/ai/simulation、js/ai/value、js/ai/policy 与 AI 执行边界。

下游
Domain DistanceRules、RuleProjection。

状态边界
只读 players 的公开座位、存活、装备定义与装备保留概率，不写状态。

信息边界
装备存在概率是 AI SearchState/Belief 字段；缺失时按确定性存在处理，不读取隐藏手牌。

架构约束
不得把本模块当成规则 authority；不得复制基础距离、望远镜或屏障公式。
*/
import { getDistance } from "../../domain/rules/distance/DistanceRules.js?build=20260818-skill-rules-locality-refactor";
import { projectRulePlayers } from "./RuleProjection.js?build=20260818-skill-rules-locality-refactor";

/*
功能
读取玩家当前装备定义 ID。

调用方
距离概率分支枚举。

输入
真实 Player 或 SearchState 玩家。

输出
装备定义 ID 或 null。

读取状态
equipment 或 equipmentDefinitionId。

写入状态
无。

调用函数
无。

边界与不变量
只读定义 ID，不读装备实体内容。
*/
export function getEquipmentDefinitionId(player) {
  return player?.equipment?.definitionId ?? player?.equipmentDefinitionId ?? null;
}

/*
功能
读取指定装备效果在概率世界中仍然存在的概率。

调用方
距离概率分支枚举。

输入
玩家与装备定义 ID。

输出
零到一概率；未携带概率字段时按一。

读取状态
equipmentRetentionProbability。

写入状态
无。

调用函数
无。

边界与不变量
这是 AI 概率模型字段；确定性世界使用 Domain 显式装备事实。
*/
export function getEquipmentEffectProbability(player, definitionId) {
  if (getEquipmentDefinitionId(player) !== definitionId) return 0;
  const probability = player?.equipmentRetentionProbability;
  return probability == null ? 1 : Math.max(0, Math.min(1, Number(probability) || 0));
}

/*
功能
生成装备存在变量的稳定条件键。

调用方
距离概率分支枚举。

输入
玩家与装备定义 ID。

输出
条件键字符串。

读取状态
player.id。

写入状态
无。

调用函数
无。

边界与不变量
同一玩家装备只使用同一条件键。
*/
export function equipmentConditionKey(player, definitionId) {
  return `equipment:${player.id}:${definitionId}`;
}

/*
功能
枚举一组距离要求共享的装备存在概率分支。

调用方
ActionGenerator、ThreatValue、CardSelectionBoundary 与其它距离概率查询。

输入
只读 game、距离要求数组与可选装备约束。

输出
每个分支包含 probability、conditions 与 matches；请求时附加 requirementMatches。

读取状态
game.state.players 或 game.players 的存活、座位、装备定义与保留概率。

写入状态
无。

调用函数
getDistance、projectRulePlayers、getEquipmentDefinitionId、getEquipmentEffectProbability、equipmentConditionKey。

边界与不变量
同一望远镜变量只枚举一次；确定性距离计算完全委托 Domain DistanceRules。
*/
export function getRangeConditionBranches(game, requirements, options = {}) {
  const players = game?.state?.players ?? game?.players ?? [];
  const entries = (Array.isArray(requirements) ? requirements : [requirements]).filter(Boolean);
  if (!entries.length) {
    const empty = { probability: 1, conditions: {}, matches: true };
    if (options.includeRequirementMatches === true) empty.requirementMatches = [];
    return [empty];
  }
  const variables = new Map();
  const forcedConditions = new Map();
  /*
  功能
  登记一个装备存在概率变量并去重。

  调用方
  getRangeConditionBranches。

  输入
  玩家、装备定义 ID 与是否强制存在。

  输出
  无返回值；写入局部 variables/forcedConditions Map。

  读取状态
  仅局部 Map。

  写入状态
  仅写 getRangeConditionBranches 的局部 Map。

  调用函数
  getEquipmentDefinitionId、getEquipmentEffectProbability、equipmentConditionKey。

  边界与不变量
  同一装备变量只登记一次；强制存在优先于概率变量。
  */
  const addVariable = (player, definitionId, forcedPresent = false) => {
    if (!player) return;
    const key = equipmentConditionKey(player, definitionId);
    if (forcedPresent) {
      forcedConditions.set(key, "present");
      variables.delete(key);
      return;
    }
    if (forcedConditions.has(key) || variables.has(key)) return;
    const probability = getEquipmentDefinitionId(player) === definitionId
      ? getEquipmentEffectProbability(player, definitionId)
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

  let branches = [{ probability: 1, conditions: Object.fromEntries(forcedConditions) }];
  for (const [key, variable] of variables) {
    const probability = Math.max(0, Math.min(1, Number(variable.probability) || 0));
    const next = [];
    if (probability > 0) {
      for (const branch of branches) {
        next.push({
          probability: branch.probability * probability,
          conditions: { ...branch.conditions, [key]: "present" }
        });
      }
    }
    if (probability < 1) {
      for (const branch of branches) {
        next.push({
          probability: branch.probability * (1 - probability),
          conditions: { ...branch.conditions, [key]: "absent" }
        });
      }
    }
    branches = next;
  }

  /*
  功能
  判断一个条件世界中的指定装备是否标记为存在。

  调用方
  getRangeConditionBranches。

  输入
  条件对象、玩家与装备定义 ID。

  输出
  布尔值。

  读取状态
  仅条件对象。

  写入状态
  无。

  调用函数
  equipmentConditionKey。

  边界与不变量
  只读取局部条件键，不访问玩家实体。
  */
  const isPresent = (conditions, player, definitionId) => (
    conditions[equipmentConditionKey(player, definitionId)] === "present"
  );
  const rulePlayers = projectRulePlayers(players);
  return branches.map((branch) => {
    const requirementMatches = entries.map(({ source, target, range }) => {
      const distance = getDistance(
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
      probability: branch.probability,
      conditions: Object.fromEntries(Object.entries(branch.conditions).sort(([left], [right]) => left.localeCompare(right))),
      matches: requirementMatches.every(Boolean) && equipmentLegal
    };
    if (options.includeRequirementMatches === true) result.requirementMatches = requirementMatches;
    return result;
  });
}

/*
功能
计算一组距离条件全部成立的总概率。

调用方
ActionGenerator 与距离查询调用方。

输入
game、requirements 与选项。

输出
零到一概率。

读取状态
getRangeConditionBranches 读取的公开距离事实。

写入状态
无。

调用函数
getRangeConditionBranches。

边界与不变量
只合并 matches 分支；不把概率反推为规则合法性。
*/
export function getRangeLegalityProbability(game, source, target, range, options = {}) {
  return getRangeConditionBranches(game, { source, target, range }, options)
    .filter((branch) => branch.matches)
    .reduce((sum, branch) => sum + branch.probability, 0);
}

/*
功能
判断来源在全部可能装备世界中是否至少有一种合法攻击距离。

调用方
AI 距离边界查询。

输入
game、source、target 与可选卡牌。

输出
布尔值。

读取状态
公开座位、存活、装备概率与攻击范围。

写入状态
无。

调用函数
getRangeLegalityProbability。

边界与不变量
ignoresDistance 卡牌恒 true；概率大于零视为可命中。
*/
export function inAttackRange(game, source, target, card = null) {
  if (card?.ignoresDistance) return true;
  return getRangeLegalityProbability(game, source, target, source?.attackRange ?? 1) > 0;
}
