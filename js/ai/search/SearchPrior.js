/*
模块职责
唯一拥有 Search Prior（只决定候选展开/裁剪先后的搜索先验），包括 actionUtility 与临时 actionSearchPrior。

上游
Searcher 请求本模块提供有界探索优先级；正式边界与测试只做同一用途查询。

下游
CardValue、ThreatValue、现有领域纯函数与闪电模拟查询。

状态边界
只读 Fact/World；不写状态、不执行动作。

信息边界
只使用过滤后的状态、viewer 合法记忆与 Evaluator 提供的 preference primitive。

架构约束
本模块所有返回值只用于剪枝和排序；不得进入 Evaluator Final Utility 或 comparator。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { assessGlobalBenefit } from "../value/GlobalBenefitValue.js";
import { sealUseValue } from "./SealPrior.js";
import {
  cardAvailability,
  getBaseCardAiValue,
  getEquipmentKeepValueDeduction,
  getRoleCardAiValue,
  roleCardDelta
} from "../value/CardValue.js";
import {
  HP_VALUE,
  statePointsToUtility
} from "../value/Economics.js";
import { incomingExposure } from "../value/ThreatValue.js";
import { queryPlayerHandProbability } from "../state/Probability.js";

export const BURNING_FIELD_SEARCH_PRIOR = 8;
// 这些权重只维持有限 beam 的相对探索顺序，不是单位换算，也不得进入 Final Utility。
export const STATE_UTILITY_PRIOR_WEIGHT = 0.4;

const END_PRIOR_PENALTY = 0.8;
const SKILL_THRESHOLD_PRIOR_BONUS = 4;

/*
功能
估算 root 目标可被资源动作分支处理的公开资源数量。

调用方
SearchPrior.rootSchedulingScore。

输入
过滤玩家摘要或根动作携带的公开目标。

输出
手牌数量加至多一个装备资源的非负数量。

读取状态
目标 handCount/hand 与 equipmentDefinitionId/equipment。

写入状态
无。

调用函数
无。

边界与不变量
只用于廉价分支工作估算，不读取隐藏牌身份或生成资源选择。
*/
function rootSchedulingResourceCount(entry) {
  return (entry?.handCount ?? entry?.hand?.length ?? 0)
    + (entry?.equipmentDefinitionId || entry?.equipment ? 1 : 0);
}

export class SearchPrior {
  /*
  功能
  绑定动态难度与闪电生命周期查询能力。

  调用方
  Worker SearchEngineFactory。

  输入
  Evaluator 与 simulationQuery。

  输出
  搜索先验服务实例。

  读取状态
  保存显式能力引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不持有 Game、Searcher、Controller 或隐式 GameState callback；不定义 target preference 公式。
  */
  constructor({
    evaluator,
    simulationQuery
  } = {}) {
    if (typeof evaluator?.threatPriority !== "function") {
      throw new TypeError("SearchPrior 缺少依赖：evaluator");
    }
    this.evaluator = evaluator;
    this.simulationQuery = simulationQuery;
  }

  /*
  功能
  计算破军新增一次攻击容量在当前手牌中的展开优先级。

  调用方
  actionUtility 与正式边界。

  输入
  actor 的过滤后状态。

  输出
  可兑现额外容量乘角色突袭静态值的 prior。

  读取状态
  只读突袭概率手牌与剩余攻击次数分支。

  写入状态
  无。

  调用函数
  CardValue 静态入口。

  边界与不变量
  只用于搜索展开，不能进入 final transition。
  */
  breakArmyUtility(actor) {
    const assaultCount = (actor.hand ?? [])
      .filter((card) => card.definitionId === "assault")
      .reduce((sum, card) => sum + Math.max(
        0,
        Math.min(1, Number(card.availability ?? 1) || 0)
      ), 0);
    const availableAttackUses = Math.max(
      0,
      (Number(actor.attackLimit ?? actor.turnFlags?.attackLimit) || 0)
        - (Number(actor.attackUsed ?? actor.turnFlags?.attackUsed) || 0)
    );
    const redeemableExtraCapacity = Math.min(
      1,
      Math.max(0, assaultCount - availableAttackUses)
    );
    const assaultSearchValue = actor.characterId
      ? getRoleCardAiValue(actor.characterId, "assault")
      : getBaseCardAiValue("assault");
    return redeemableExtraCapacity * assaultSearchValue;
  }

  /*
  功能
  为窥探候选提供廉价的决策相关性排序代理。

  调用方
  actionUtility 的 scout 分支。

  输入
  窥探使用者、被查看目标与过滤后 World。

  输出
  零到一的排序相关性；只用于 prior。

  读取状态
  使用者合法已知手牌、目标 Belief 资源概率、生命与公开威胁。

  写入状态
  无。

  调用函数
  cardAvailability、ThreatValue.incomingExposure。

  边界与不变量
  只用关键资源的最大二项分布方差作轻量代理，不复制正式 VOI 求和；
  不读装备或隐藏牌面，不以敌友身份给固定加减分。
  */
  scoutDecisionRelevance(actor, target, visible) {
    const decisionDefinitions = (actor?.hand ?? [])
      .filter((entry) => cardAvailability(entry) > 0)
      .map((entry) => entry)
      .filter((definition) => !definition.subtypes?.includes("information"));
    const offensiveDecision = Math.min(1, Math.max(
      0,
      queryPlayerHandProbability(
        visible.probabilityState, actor, "assault"
      ).expected,
      decisionDefinitions.some((definition) => definition.subtypes?.some(
        (subtype) => ["attack", "damage", "attack-buff"].includes(subtype)
      )) ? 1 : 0
    ));
    const tacticDecision = decisionDefinitions.some((definition) => (
      definition.category === "tactic" && definition.counterable !== false
    )) ? 1 : 0;
    const protectionDecision = decisionDefinitions.some((definition) => (
      definition.subtypes?.some(
        (subtype) => ["defense", "response", "rescue", "support"].includes(subtype)
      ) || definition.targetType === "multiStage"
    )) ? 1 : 0;
    const assaultProbability = queryPlayerHandProbability(
      visible.probabilityState, target, "assault"
    ).probability;
    const blockProbability = queryPlayerHandProbability(
      visible.probabilityState, target, "block"
    ).probability;
    const counterProbability = queryPlayerHandProbability(
      visible.probabilityState, target, "counter"
    ).probability;
    const assaultUncertainty = assaultProbability * (1 - assaultProbability) / 0.25;
    const blockUncertainty = blockProbability * (1 - blockProbability) / 0.25;
    const counterUncertainty = counterProbability * (1 - counterProbability) / 0.25;

    if (target.battleTeam !== actor.battleTeam) {
      const teamThreatRelevance = (visible?.players ?? [])
        .filter((player) => player.alive && player.battleTeam === actor.battleTeam)
        .reduce((highest, player) => Math.max(
          highest,
          Math.min(1, Math.max(
            0,
            (player.maxHp > 0 ? (player.maxHp - player.hp) / player.maxHp : 0)
              + incomingExposure(visible, player) / HP_VALUE
          ))
        ), 0);
      return Math.min(1, Math.max(
        blockUncertainty * offensiveDecision,
        counterUncertainty * tacticDecision,
        assaultUncertainty * Math.max(teamThreatRelevance, protectionDecision)
      ));
    }

    const allySurvivalRelevance = Math.min(1, Math.max(
      0,
      (target.maxHp > 0 ? (target.maxHp - target.hp) / target.maxHp : 0)
        + incomingExposure(visible, target) / HP_VALUE
    )) * protectionDecision;
    const enemyKillRelevance = (visible?.players ?? [])
      .filter((player) => player.alive && player.battleTeam !== actor.battleTeam)
      .reduce((highest, player) => Math.max(
        highest,
        player.maxHp > 0 ? Math.min(1, Math.max(0, (player.maxHp - player.hp) / player.maxHp)) : 0
      ), 0);
    return Math.min(1, Math.max(
      allySurvivalRelevance * Math.max(
        blockUncertainty,
        counterUncertainty
      ),
      enemyKillRelevance * Math.max(offensiveDecision, tacticDecision) * assaultUncertainty
    ));
  }

  /*
  功能
  计算昂贵 root materialization 前的廉价、确定性探索顺序分数。

  调用方
  Searcher root scheduling。

  输入
  根候选动作、行动者与过滤后的根 World。

输出
  由有界机会收益除以估算分支工作得到的有限调度密度；end 始终排在合法 non-end 后。

  读取状态
  只读卡牌/角色静态值、公开阵营、目标 HP/资源、行动者能量门槛与现成 selection。

  写入状态
  无。

  调用函数
  CardValue 静态入口、getEquipmentKeepValueDeduction。

  边界与不变量
  不调用 Simulator、hidden-world query、Seal/Lightning/GlobalBenefit 动态模型或大型概率操作；
  所有动作类别共用同一密度尺度，不设置类别 tier；
  本分数不进入 Evaluator Final Utility、beam prior 或 COMPLETE 最终比较。
  */
  rootSchedulingScore(action, player, visible) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") return Number.NEGATIVE_INFINITY;
    const target = visible.players.find((entry) => entry.id === action.targetIds?.[0]) ?? null;
    if (action.type === "skill") {
      const skill = ACTIVE_SKILL_DEFINITIONS[action.skillId] ?? null;
      const missingHp = target ? Math.max(0, target.maxHp - target.hp) : 0;
      const skillScores = {
        breakArmy: actor.characterId
          ? getRoleCardAiValue(actor.characterId, "assault")
          : getBaseCardAiValue("assault"),
        barrier:missingHp,
        symbiosis:missingHp,
        stealSkill:5 + Math.min(4, rootSchedulingResourceCount(target)),
        burningField:BURNING_FIELD_SEARCH_PRIOR,
        hunt:7 + (target?.hp <= 2 ? 7 : 0),
        allIn:Math.max(0, actor.energy - 1) * 3,
        resonance:5 + (target?.handCount <= 1 ? 3 : 0)
      };
      const branchingWork = skill?.targetType === "enemyWithCardsOrEquipment"
        ? 1 + rootSchedulingResourceCount(target)
        : 1;
      const density = (Number(skillScores[action.skillId] ?? 4) || 0) / branchingWork;
      return density / (1 + Math.abs(density));
    }
    const card = CARD_DEFINITIONS[action.cardId] ?? null;
    if (!card?.definitionId) return 0;
    let score = actor.characterId
      ? getRoleCardAiValue(actor.characterId, card.definitionId)
      : (Number.isFinite(card.aiValue)
        ? card.aiValue
        : getBaseCardAiValue(card.definitionId));
    if (target) {
      const enemy = target.battleTeam !== actor.battleTeam;
      if (card.subtypes?.includes("attack") || card.definitionId === "duel") {
        const missingHp = Math.max(0, target.maxHp - target.hp);
        score += enemy
          ? missingHp * 3 + (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0)
          : -12;
        if (enemy && card.counterable === false && Number(card.baseDamage) > 0) {
          score += Number(card.baseDamage) * HP_VALUE;
        }
      }
      if (["plunder", "destroy"].includes(card.definitionId)) {
        const equipmentWeight = target.equipmentDefinitionId || target.equipment
          ? (card.definitionId === "plunder" ? 1 : 2)
          : 0;
        score += Math.min(
          5,
          (target.handCount ?? target.hand?.length ?? 0) + equipmentWeight
        );
        if (!enemy) score -= 30;
      }
    }
    if (card.definitionId === "charge") {
      score += Math.max(0, actor.maxEnergy - actor.energy) * 1.5
        + (actor.activeSkillId && !actor.activeSkillUsed
          && actor.energy < actor.activeSkillCost
          && actor.energy + 1 >= actor.activeSkillCost
          ? SKILL_THRESHOLD_PRIOR_BONUS
          : 0);
    }
    if (card.definitionId === "transfer") {
      const selectionScore = Number(action.selection?.score);
      if (Number.isFinite(selectionScore)) score = selectionScore;
    }
    const equippedDefinitionId = actor.equipmentDefinitionId
      ?? actor.equipment?.definitionId
      ?? null;
    if (card.category === "equipment" && equippedDefinitionId) {
      score -= getEquipmentKeepValueDeduction(
        actor.characterId ?? null,
        card.definitionId,
        equippedDefinitionId,
        actor.equipmentRetentionProbability ?? 1
      );
    }
    const targets = (action.targetIds ?? []).map((targetId) => (
      visible.players.find((entry) => entry.id === targetId)
    )).filter(Boolean);
    let branchingWork = 1;
    if (card.subtypes?.includes("hidden-selection")) {
      const sourceId = action.selection?.sourceId;
      const resourceOwner = sourceId
        ? visible.players.find((entry) => entry.id === sourceId)
        : target;
      branchingWork += rootSchedulingResourceCount(resourceOwner);
    }
    if (card.subtypes?.includes("attack")) {
      branchingWork += targets.reduce((sum, entry) => {
        const block = queryPlayerHandProbability(
          visible.probabilityState, entry, "block"
        );
        return sum + block.probability + queryPlayerHandProbability(
          visible.probabilityState, entry, "block", 2
        ).probability;
      }, 0);
    }
    if (card.counterable) {
      const responders = card.counterScope === "target"
        ? targets
        : visible.players.filter((entry) => (
            entry.alive && entry.battleTeam !== actor.battleTeam
          ));
      branchingWork += 1 + responders.reduce((sum, entry) => sum
        + queryPlayerHandProbability(
          visible.probabilityState, entry, "counter"
        ).probability, 0);
    }
    if (!Number.isFinite(score)) return 0;
    const density = score / branchingWork;
    // 所有动作类别共用同一有界机会密度尺度；类别本身不构成探索优先级，
    // 否则 basic/tactic/equipment 的固定分层会掩盖实际收益与分支成本。
    return density / (1 + Math.abs(density));
  }

  /*
  功能
  计算动作在 beam pruning/ranking 中的既有静态与上下文 prior。

  调用方
  Searcher pruneScore、正式边界与测试。

  输入
  候选动作、真实 player 执行视图、过滤状态与显式 options。

  输出
  仅用于搜索顺序的数值 prior。

  读取状态
  只读公开动作、合法记忆、可见状态及闪电生命周期查询结果。

  写入状态
  无；闪电查询只写自身缓存。

  调用函数
  CardValue、ThreatValue、sealUseValue、assessGlobalBenefit 与 lightningLifecycleValue。

  边界与不变量
  静态牌值、目标焦点和领域启发式绝不进入 valueScore；已在 after-state 的收益这里只能作展开偏置。
  闪电 nested simulation 必须继承 options.searchBudget。
  */
  actionUtility(action, player, visible, options = {}) {
    const actor = visible.players.find((entry) => entry.id === player.id) ?? player;
    if (action.type === "end") {
      const remainingCards = actor.handCount ?? actor.hand?.length ?? player.hand.length;
      return remainingCards > 0 ? -END_PRIOR_PENALTY : 0;
    }
    if (action.type === "skill") {
      const target = visible.players.find((entry) => entry.id === action.targetIds?.[0]) ?? null;
      const missing = target ? Math.max(0, target.maxHp - target.hp) : 0;
      const values = {
        breakArmy: this.breakArmyUtility(actor),
        barrier: 0,
        symbiosis: 0,
        stealSkill: 5 + Math.min(
          4,
          (target?.handCount ?? 0) + (target?.equipmentDefinitionId ? 1 : 0)
        ),
        burningField: 0,
        hunt: 7 + (target?.hp <= 2 ? 7 : 0),
        allIn: Math.max(0, actor.energy - 1) * 3
          + Math.min(1, actor.energy * 0.25) * (1 - (actor.assaultBonus ?? 0)) * 4,
        resonance: 5 + (target?.handCount <= 1 ? 3 : 0)
      };
      let value = values[action.skillId] ?? 4;
      if (["stealSkill", "hunt"].includes(action.skillId)) {
        value += this.evaluator.threatPriority(actor, target, player.aiMemory, 1);
      }
      return value;
    }
    const card = CARD_DEFINITIONS[action.cardId] ?? null;
    if (!card) return 0;
    const identityDelta = roleCardDelta(actor?.characterId, card?.definitionId);
    let value = actor?.characterId && card?.definitionId
      ? getRoleCardAiValue(actor.characterId, card.definitionId)
      : (Number.isFinite(card?.aiValue)
        ? card.aiValue
        : (card?.definitionId ? getBaseCardAiValue(card.definitionId) : 0));
    if (card.definitionId === "lightning") {
      value = getBaseCardAiValue(card.definitionId)
        + statePointsToUtility(this.simulationQuery.lightningLifecycleValue(
          visible,
          actor,
          actor.id,
          1,
          options.searchBudget ?? null
        )) * STATE_UTILITY_PRIOR_WEIGHT
        + identityDelta;
    }
    const target = visible.players.find((entry) => entry.id === action.targetIds?.[0]) ?? null;
    if (card.definitionId === "seal") {
      value = sealUseValue(actor, target, visible, options.searchBudget ?? null)
        + identityDelta;
    }
    if (target) {
      const enemy = target.battleTeam !== player.battleTeam;
      if (card.subtypes.includes("attack") || card.definitionId === "duel") {
        const focus = (target.maxHp - target.hp) * 3
          + (target.hp <= 2 ? 5 : 0)
          + (target.hp <= 1 ? 8 : 0);
        if (enemy && card.definitionId === "assault") {
          value += (target.hp <= 2 ? 5 : 0) + (target.hp <= 1 ? 8 : 0);
        } else if (enemy && !["assault", "shockwave"].includes(card.definitionId)) {
          value += 3 + focus;
        } else if (!enemy) {
          value -= 12;
        }
      }
      if (["plunder", "destroy"].includes(card.definitionId)) {
        const equipmentValue = target.equipmentDefinitionId || target.equipment
          ? (card.definitionId === "plunder" ? 1 : 2)
          : 0;
        value += Math.min(
          5,
          (target.hand?.length ?? target.handCount ?? 0) + equipmentValue
        );
      }
      if (card.definitionId === "scout") {
        const knownExpectedCount = (target.knownCards ?? [])
          .reduce((sum, entry) => sum + cardAvailability(entry), 0);
        const unknownCount = Math.max(
          0,
          (target.hand?.length ?? target.handCount ?? 0) - knownExpectedCount
        );
        const revealLimit = Math.max(1, Number(card.maxRevealCount) || 1);
        const revealCoverage = Math.min(revealLimit, unknownCount) / revealLimit;
        value += getBaseCardAiValue(card.definitionId)
          * revealCoverage
          * this.scoutDecisionRelevance(actor, target, visible);
      }
      if (!enemy && ["plunder", "destroy"].includes(card.definitionId)) value -= 30;
      if (enemy && ["assault", "duel", "plunder", "destroy"].includes(card.definitionId)) {
        value += this.evaluator.threatPriority(
          actor,
          target,
          player.aiMemory,
          ["assault", "duel"].includes(card.definitionId) ? 1 : 0
        );
      }
    }
    if (card.definitionId === "charge") {
      value += (actor.maxEnergy - actor.energy) * 1.5
        + (actor.activeSkillId && !actor.activeSkillUsed
          && actor.energy < actor.activeSkillCost
          && actor.energy + 1 >= actor.activeSkillCost
          ? SKILL_THRESHOLD_PRIOR_BONUS
          : 0);
    }
    if (card.definitionId === "provoke") {
      value += visible.players
        .filter((enemy) => enemy.alive && enemy.battleTeam !== actor.battleTeam)
        .reduce(
          (sum, enemy) => sum + (1 - queryPlayerHandProbability(
            visible.probabilityState, enemy, "assault"
          ).probability) * 3,
          0
        );
    }
    if (card.definitionId === "duel" && target) {
      value += (queryPlayerHandProbability(
        visible.probabilityState, actor, "assault"
      ).expected - queryPlayerHandProbability(
        visible.probabilityState, target, "assault"
      ).expected) * 2;
    }
    if (card.definitionId === "transfer") value += Number(action.selection?.score ?? 0);
    if (card.definitionId === "symbiosis") {
      const net = this.symbiosisNetFromState(actor, visible);
      value = (net > 0 ? 8 + net : -9 + net) + identityDelta;
    }
    const equippedDefinitionId = actor.equipmentDefinitionId
      ?? actor.equipment?.definitionId
      ?? null;
    if (card.category === "equipment" && equippedDefinitionId) {
      value -= getEquipmentKeepValueDeduction(
        actor?.characterId ?? null,
        card.definitionId,
        equippedDefinitionId,
        actor.equipmentRetentionProbability ?? 1
      );
    }
    return value;
  }

  /*
  功能
  从显式状态计算互利全局收益的搜索 prior。

  调用方
  actionUtility 与正式边界。

  输入
  actor 与过滤后的状态。

  输出
  assessGlobalBenefit 净收益乘既有缩放四。

  读取状态
  只读传入状态的公开玩家字段。

  写入状态
  无。

  调用函数
  assessGlobalBenefit。

  边界与不变量
  属于 SEARCH_PRIOR/POLICY_VALUE，不进入最终 transition。
  */
  symbiosisNetFromState(player, state) {
    return (assessGlobalBenefit(
      state.players,
      player.battleTeam,
      "symbiosis"
    )?.netBenefit ?? 0) * 4;
  }

  /*
  功能
  返回只服务当前层 beam pruning 的临时搜索信用。

  调用方
  Searcher pruneScore 与正式边界。

  输入
  动作、player 与 visible state。

  输出
  焚场返回既有八点 prior，其余返回零。

  读取状态
  只读动作技能 ID。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  BURNING_FIELD_SEARCH_PRIOR 是剪枝经验值，不是游戏价值，绝不进入 final valueScore。
  */
  actionSearchPrior(action, player, visible) {
    if (action.skillId === "burningField") return BURNING_FIELD_SEARCH_PRIOR;
    return 0;
  }
}
