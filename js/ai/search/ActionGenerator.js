/*
模块职责
生成真实根局面与 SearchState 深层节点的 AI 候选动作。

上游
AIController 与 Planner 注入能力。

下游
RuleEngine、技能注册器、领域概率与策略评分模块。

状态边界
根生成只读 GameState，深层生成只读 SearchState，不执行或结算动作。

信息边界
深层动作只使用 SearchState 的合法可见、记忆与 Belief 字段。

架构约束
不得依赖 AIController；转移资源选择必须由构造时注入的窄能力提供。
*/
import { RuleEngine } from "../../core/RuleEngine.js?build=20260815-shadow-agent-p1-slot";
import { getLightningStatusStateBranches } from "../domain/LightningModel.js?build=20260815-shadow-agent-p1-slot";
import { getSealStatusStateBranches } from "../domain/SealModel.js?build=20260815-shadow-agent-p1-slot";
import {
  ACTIVE_SKILLS, getActiveSkill, getActiveSkillCost
} from "../../generals/skillRegistry.js?build=20260815-shadow-agent-p1-slot";
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260815-shadow-agent-p1-slot";
import { DistanceSystem } from "../../core/DistanceSystem.js?build=20260815-shadow-agent-p1-slot";
import { ActionCandidatePolicy } from "../policy/ActionCandidatePolicy.js?build=20260815-shadow-agent-p1-slot";
import { TransferPolicy } from "../policy/TransferPolicy.js?build=20260815-shadow-agent-p1-slot";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  binaryConditionPartition,
  getAvailabilityStateBranches,
  getValueBranches,
  huntMarkConditionKey,
  joinProbabilityStateBranches,
  mergeProbabilityBranches,
  projectProbabilityStateBranches,
  totalBranchProbability
} from "../state/Probability.js?build=20260815-shadow-agent-p1-slot";

export class ActionGenerator {
  /*
  功能
  创建动作生成器并绑定真实规则边界与转移选择能力。

  调用方
  AIController 组合根与直接独立性测试。

  输入
  Game 规则上下文，以及包含 chooseTransferCombination 的依赖对象。

  输出
  可生成根与深层动作的 ActionGenerator；缺少依赖时立即抛错。

  读取状态
  无。

  写入状态
  实例 game 与转移选择能力。

  调用函数
  无。

  边界与不变量
  只保存具体能力，不接收或查找 AIController。
  */
  constructor(game, {
    chooseTransferCombination,
    transferPolicy,
    actionCandidatePolicy
  } = {}) {
    if (!game) throw new TypeError("ActionGenerator 缺少依赖：game");
    if (typeof chooseTransferCombination !== "function") {
      throw new TypeError("ActionGenerator 缺少依赖：chooseTransferCombination");
    }
    const resolvedTransferPolicy = transferPolicy ?? new TransferPolicy();
    const resolvedActionCandidatePolicy = actionCandidatePolicy ?? new ActionCandidatePolicy();
    if (typeof resolvedTransferPolicy.choose !== "function") {
      throw new TypeError("ActionGenerator 缺少依赖：transferPolicy");
    }
    if (typeof resolvedActionCandidatePolicy.isLightningStrategicallyForbidden !== "function") {
      throw new TypeError("ActionGenerator 缺少依赖：actionCandidatePolicy");
    }
    this.game = game;
    this.chooseTransferCombination = chooseTransferCombination;
    this.transferPolicy = resolvedTransferPolicy;
    this.actionCandidatePolicy = resolvedActionCandidatePolicy;
  }

  /*
  功能
  从 RuleEngine 提供的深层合法 source/receiver 集合选择转移计划。

  调用方
  generateFromVisible。

  输入
  过滤 simulation game、行动者、转移牌与 Belief remaining counts。

  输出
  TransferPolicy 选择描述或 null。

  读取状态
  RuleEngine 合法集合、SearchState 公开/合法信息与 Belief。

  写入状态
  无。

  调用函数
  RuleEngine.getTransferSources/getTransferReceivers、TransferPolicy.choose。

  边界与不变量
  Generator 只提供合法集合；正收益过滤和 tie-break 属正式 Policy，真实实体移动不在此发生。
  */
  chooseVisibleTransferPlan(game, actor, card, remainingCardCounts = null) {
    const sources = RuleEngine.getTransferSources(game, actor, card);
    const excludedCardIds = card.id ? new Set([card.id]) : null;
    return this.transferPolicy.choose({
      actor,
      sources,
      excludedCardIds,
      remainingCardCounts,
      getReceivers:(from) => RuleEngine.getTransferReceivers(game, actor, from, card)
    });
  }

  /*
  功能
  从当前真实局面枚举 RuleEngine 允许的动作，再应用 AI 专属候选策略形成 Planner 根候选。

  调用方
  AIController.getActionCandidates 与直接动作生成测试。

  输入
  当前行动 Player。

  输出
  包含卡牌、技能和结束阶段的 Planner 候选数组；它不等同于完整游戏合法动作集。

  读取状态
  当前 GameState、RuleEngine 权威、角色技能与转移选择策略。

  写入状态
  无。

  调用函数
  RuleEngine 合法性与目标入口、getActiveSkill、getActiveSkillCost、chooseTransferCombination。

  边界与不变量
  RuleEngine 独占游戏合法性，ActionCandidatePolicy 仅收窄 AI 会考虑的集合；保持既有枚举顺序与候选集合，转移只记录选择描述，不移动实体牌。
  */
  generate(player) {
    const actions = [];
    for (const card of player.hand) {
      if (!RuleEngine.canPlayCard(this.game, player, card).ok) continue;
      if (card.definitionId === "lightning"
        && this.actionCandidatePolicy.isLightningStrategicallyForbidden(
          this.game.state.players,
          player
        )) continue;
      if (card.definitionId === "lightning" && RuleEngine.hasStatus(player, "lightning")) continue;
      const targets = RuleEngine.getCardTargets(this.game, player, card);
      if (card.definitionId === "leverage") {
        for (const firstTarget of RuleEngine.getLeverageFirstTargets(this.game, player)) {
          for (const secondTarget of RuleEngine.getAssaultTargetCandidates(this.game, firstTarget)) {
            actions.push({
              type:"card",
              card,
              targets:[firstTarget, secondTarget],
              selection:{
                firstTargetId:firstTarget.id,
                equipmentCardId:firstTarget.equipment.id,
                secondTargetId:secondTarget.id
              }
            });
          }
        }
        continue;
      }
      if (card.definitionId === "transfer") {
        const sources = RuleEngine.getTransferSources(this.game, player, card)
          .filter((from) => RuleEngine.getTransferReceivers(this.game, player, from, card).length);
        const selection = this.chooseTransferCombination(player, card, sources, null, new Set([card.id]));
        if (selection) actions.push({ type:"card", card, targets:[], selection });
        continue;
      }
      if (["singleEnemy", "singleEnemyInRange", "singleUnsealedEnemy", "singleAlly", "otherWithCards", "otherWithCardsOrEquipment"].includes(card.targetType)) {
        const aiTargets = this.actionCandidatePolicy.filterCardTargets(card, player, targets);
        for (const target of aiTargets) actions.push({ type:"card", card, targets:[target] });
      } else actions.push({ type:"card", card, targets:card.targetType === "allEnemies" || card.targetType === "allLiving" ? targets : [] });
    }
    const skill = getActiveSkill(player);
    if (skill?.canUse(this.game, player).ok
      && (skill.id !== "breakArmy"
        || this.actionCandidatePolicy.canBenefitFromBreakArmy(player))
      && !(skill.id === "allIn" && this.actionCandidatePolicy.isZeroBenefitAllIn(player))) {
      const targets = RuleEngine.getSkillTargets(this.game, player, skill);
      const energyCost = getActiveSkillCost(this.game, player, skill);
      if (skill.targetType === "none" || skill.targetType === "allEnemies") {
        actions.push({ type:"skill", skill, targets, energyCost });
      } else {
        for (const target of targets) actions.push({ type:"skill", skill, targets:[target], energyCost });
      }
    }
    actions.push({ type:"end" });
    return actions;
  }

  /*
  功能
  从过滤 SearchState 重新生成深层 AI 候选动作。

  调用方
  Planner 注入的 generateFromVisible 能力。

  输入
  SearchState 与当前行动者 ID。

  输出
  带执行概率分支的 AI policy candidate action 数组。

  读取状态
  过滤玩家、Belief、RuleEngine 共享纯规则、正式 Policy 与概率代数。

  写入状态
  无。

  调用函数
  RuleEngine、ActionCandidatePolicy、TransferPolicy、attachProbabilityBranches。

  边界与不变量
  动态距离只使用实时 alive ring；Policy 过滤不改变 Game authority 的合法性定义。
  */
  generateFromVisible(state, playerId) {
    if (state.playPhaseEnded) return [];
    const actor = state.players.find((player) => player.id === playerId && player.alive);
    if (!actor) return [{ type:"end" }];
    const alive = state.players.filter((player) => player.alive).sort((a,b) => a.seatIndex - b.seatIndex);
    // 深层模拟仍走 RuleEngine → DistanceSystem；传入的是过滤快照，不是完整 GameState。
    const simulationGame = { state:{ players:state.players } };
    const enemies = alive.filter((player) => player.battleTeam !== actor.battleTeam);
    const actions = [];
    for (const held of actor.hand ?? []) {
      const definition = CARD_DEFINITIONS[held.definitionId];
      if (!definition || definition.usageMode === "response") continue;
      const card = { ...definition, ...held, id:held.id };
      if (card.definitionId === "lightning"
        && this.actionCandidatePolicy.isLightningStrategicallyForbidden(
          state.players,
          actor
        )) continue;
      if (card.definitionId === "lightning" && RuleEngine.hasStatus(actor, "lightning")) continue;
      if (card.definitionId === "assault") {
        for (const target of RuleEngine.getCardTargets(simulationGame, actor, card)) {
          actions.push({ type:"card", card, targets:[target] });
        }
        continue;
      }
      if (card.definitionId === "recover" && (actor.hp >= actor.maxHp || (actor.recoverLimit !== null && actor.recoverUsed >= actor.recoverLimit))) continue;
      if (card.definitionId === "charge" && actor.energy >= actor.maxEnergy) continue;
      if (card.definitionId === "transfer") {
        const selection = this.chooseVisibleTransferPlan(simulationGame, actor, card, state.remainingCardCounts ?? null);
        if (selection) actions.push({ type:"card", card, targets:[], selection });
        continue;
      }
      if (card.definitionId === "leverage") {
        const firstTargets = alive.filter((firstTarget) => firstTarget.id !== actor.id
          && firstTarget.equipmentDefinitionId
          && (firstTarget.equipmentRetentionProbability ?? 1) > 0
          && RuleEngine.getAssaultTargetCandidates(simulationGame, firstTarget).length > 0);
        for (const firstTarget of firstTargets) {
          for (const secondTarget of RuleEngine.getAssaultTargetCandidates(simulationGame, firstTarget)) {
            actions.push({
              type:"card",
              card,
              targets:[firstTarget, secondTarget],
              selection:{
                firstTargetId:firstTarget.id,
                equipmentCardId:null,
                equipmentDefinitionId:firstTarget.equipmentDefinitionId,
                secondTargetId:secondTarget.id
              }
            });
          }
        }
        continue;
      }
      if (["singleEnemy","singleUnsealedEnemy"].includes(card.targetType)) {
        for (const target of RuleEngine.getCardTargets(simulationGame, actor, card)) {
          actions.push({ type:"card", card, targets:[target] });
        }
      } else if (card.targetType === "singleAlly") for (const target of RuleEngine.getCardTargets(simulationGame, actor, card)) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "otherWithCards") for (const target of alive.filter((entry) => entry.id !== actor.id && entry.handCount > 0)) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "otherWithCardsOrEquipment") {
        const targets = RuleEngine.getCardTargets(simulationGame, actor, card);
        for (const target of this.actionCandidatePolicy.filterCardTargets(
          card,
          actor,
          targets
        )) actions.push({ type:"card", card, targets:[target] });
      }
      else actions.push({ type:"card", card, targets:["allEnemies","allLiving"].includes(card.targetType) ? (card.targetType === "allEnemies" ? enemies : alive) : [] });
    }
    const skill = ACTIVE_SKILLS[actor.activeSkillId];
    if (skill
      && (skill.id !== "breakArmy"
        || this.actionCandidatePolicy.canBenefitFromBreakArmy(actor))
      && !(skill.id === "allIn" && this.actionCandidatePolicy.isZeroBenefitAllIn(actor))) {
      const friendlies = alive.filter((player) => player.battleTeam === actor.battleTeam);
      let targets = [];
      if (skill.id === "barrier") targets = friendlies;
      else if (skill.id === "resonance") targets = friendlies;
      else if (skill.id === "symbiosis") targets = friendlies.filter((player) => player.hp < player.maxHp);
      else if (skill.id === "stealSkill") targets = RuleEngine.getSkillTargets(simulationGame, actor, skill);
      else if (skill.id === "hunt") targets = enemies.filter((player) => {
        const markBranches = player.huntMarkStateBranchesBySource?.[actor.id];
        if (Array.isArray(markBranches)) {
          return totalBranchProbability(markBranches.filter((branch) => branch.marked)) > PROBABILITY_EPSILON;
        }
        return Math.max(0, Math.min(1, Number(
          player.huntMarkProbabilities?.[actor.id] ?? (player.huntMarkSourceId === actor.id ? 1 : 0)
        ) || 0)) > 0;
      });
      if (["none","allEnemies"].includes(skill.targetType)) actions.push({ type:"skill", skill, targets:skill.targetType === "allEnemies" ? enemies : [] });
      else for (const target of targets) actions.push({ type:"skill", skill, targets:[target] });
    }
    actions.push({ type:"end" });
    return actions.map((action) => this.attachProbabilityBranches(simulationGame, actor, action))
      .filter(Boolean);
  }

  /*
  功能
  把距离、延迟状态和选择约束投影为动作是否匹配的互斥条件分区。

  调用方
  attachProbabilityBranches。

  输入
  过滤 simulation game、行动者与候选动作。

  输出
  带 probability、conditions 与 matches 的条件分支。

  读取状态
  攻击距离、猎印、封印、闪电和转移/借势公开条件。

  写入状态
  无。

  调用函数
  DistanceSystem、LightningModel、SealModel、binaryConditionPartition。

  边界与不变量
  这里只投影既有条件世界，不重新判断 Policy 价值或执行真实规则。
  */
  getActionConditionPartition(game, actor, action) {
    if (action.type === "skill") {
      if (action.skill.id === "hunt") {
        const target = action.targets?.[0];
        const markBranches = target?.huntMarkStateBranchesBySource?.[actor.id];
        if (Array.isArray(markBranches) && markBranches.length) {
          return markBranches.map((branch) => ({
            probability:branch.probability,
            conditions:branch.conditions,
            matches:Boolean(branch.marked)
          }));
        }
        const markProbability = Math.max(0, Math.min(1, Number(
          target?.huntMarkProbabilities?.[actor.id] ?? (target?.huntMarkSourceId === actor.id ? 1 : 0)
        ) || 0));
        return binaryConditionPartition(huntMarkConditionKey(actor.id, target?.id), markProbability);
      }
      if (action.skill.rangeRule === "attack" || action.skill.rangeRule === "fixed") {
        const target = action.targets?.[0];
        return DistanceSystem.getRangeConditionBranches(game, {
          source:actor,
          target,
          range:action.skill.rangeRule === "attack" ? actor.attackRange : action.skill.range
        });
      }
      return [{ probability:1, conditions:{}, matches:true }];
    }

    const card = action.card;
    if (card.definitionId === "lightning") {
      return getLightningStatusStateBranches(actor).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        matches:!branch.present
      }));
    }
    if (card.definitionId === "seal") {
      const target = game.state.players.find((player) => player.id === action.targets?.[0]?.id);
      return getSealStatusStateBranches(target).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        matches:!branch.present
      }));
    }
    if (card.definitionId === "transfer") {
      const source = game.state.players.find((player) => player.id === action.selection?.sourceId);
      const receiver = game.state.players.find((player) => player.id === action.selection?.receiverId);
      return DistanceSystem.getRangeConditionBranches(game, [
        { source:actor, target:source, range:card.effectRange },
        { source:actor, target:receiver, range:card.effectRange }
      ]);
    }
    if (card.definitionId === "leverage") {
      const first = game.state.players.find((player) => player.id === action.selection?.firstTargetId);
      const second = game.state.players.find((player) => player.id === action.selection?.secondTargetId);
      return DistanceSystem.getRangeConditionBranches(game, {
        source:first,
        target:second,
        range:first?.attackRange ?? 1
      }, {
        equipmentRequirements:[{
          player:first,
          definitionId:action.selection?.equipmentDefinitionId,
          present:true
        }]
      });
    }
    const target = action.targets?.[0];
    if (card.definitionId === "assault" && target) {
      return DistanceSystem.getRangeConditionBranches(game, {
        source:actor,
        target,
        range:actor.attackRange ?? 1
      });
    }
    if (!card.ignoresDistance && card.effectRange != null && target) {
      return DistanceSystem.getRangeConditionBranches(game, {
        source:actor,
        target,
        range:card.effectRange
      });
    }
    return [{ probability:1, conditions:{}, matches:true }];
  }

  /*
  功能
  将攻击次数容量规范为逐槽可用性概率分支。

  调用方
  attachProbabilityBranches。

  输入
  过滤后的行动者状态。

  输出
  每个攻击槽的互斥 available 分支数组。

  读取状态
  attackUseSlots；输入未携带正式槽位时回退读取 attackLimit 与 attackUsed。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  正式槽位原样返回；标量次数回退只用专用条件键保持已用质量，不改变期望容量。
  */
  getAttackUseSlots(actor) {
    if (Array.isArray(actor.attackUseSlots)) return actor.attackUseSlots;
    const limit = Math.max(0, Math.ceil(Number(actor.attackLimit) || 0));
    const used = Math.max(0, Number(actor.attackUsed) || 0);
    return Array.from({ length:limit }, (_, index) => {
      if (index < Math.floor(used)) return [{ probability:1, conditions:{}, available:false }];
      if (index > Math.floor(used) || used === Math.floor(used)) {
        return [{ probability:1, conditions:{}, available:true }];
      }
      const unavailable = used - Math.floor(used);
      return [
        { probability:1 - unavailable, conditions:{}, available:true },
        { probability:unavailable, conditions:{ [`legacyAttackUse:${actor.id}:${index}`]:"used" }, available:false }
      ];
    });
  }

  /*
  功能
  将主动技能次数容量规范为逐槽可用性概率分支。

  调用方
  attachProbabilityBranches。

  输入
  过滤后的行动者状态与技能定义。

  输出
  每个技能使用槽的互斥 available 分支数组。

  读取状态
  正式技能槽、availability branches 或使用次数/上限。

  写入状态
  无。

  调用函数
  getAvailabilityStateBranches。

  边界与不变量
  只投影次数容量；能量与目标条件由其他分区在同一世界联合。
  */
  getSkillUseSlots(actor, skill) {
    if (Array.isArray(actor.activeSkillUseSlots)) return actor.activeSkillUseSlots;
    if (Array.isArray(actor.activeSkillAvailabilityBranches)) {
      return actor.activeSkillAvailabilityBranches.map((availabilityBranches) => (
        getAvailabilityStateBranches({ availabilityBranches })
      ));
    }
    const uses = Math.max(0, Number(actor.activeSkillUses ?? (actor.activeSkillUsed ? 1 : 0)) || 0);
    const limit = Math.max(0, Math.ceil(Number(actor.activeSkillLimit ?? skill.limitPerTurn ?? 1) || 0));
    return Array.from({ length:limit }, (_, index) => [{
      probability:1,
      conditions:{},
      available:index >= Math.ceil(uses)
    }]);
  }

  /*
  功能
  联合多个共享条件分区并标记每个完整世界是否执行动作。

  调用方
  attachProbabilityBranches。

  输入
  概率分区数组与对联合分支的执行谓词。

  输出
  新的完整世界数组，每项带 executes 标记。

  读取状态
  只读调用方提供的分支与条件键。

  写入状态
  无。

  调用函数
  joinProbabilityStateBranches、predicate。

  边界与不变量
  相同条件键必须先联合再求谓词，避免相关资源容量被独立相乘。
  */
  buildExecutionWorlds(partitions, predicate) {
    return joinProbabilityStateBranches(...partitions).map((branch) => ({
      ...branch,
      executes:Boolean(predicate(branch))
    }));
  }

  /*
  功能
  从完整执行世界提取动作实际执行的规范分支与总概率。

  调用方
  attachProbabilityBranches。

  输入
  带 executes 标记的完整世界数组。

  输出
  executionBranches 与 executionProbability。

  读取状态
  世界概率、条件键与 executes 标记。

  写入状态
  无。

  调用函数
  mergeProbabilityBranches、totalBranchProbability。

  边界与不变量
  合并只发生在已执行世界，条件质量守恒且不改变动作排序。
  */
  summarizeExecution(worlds) {
    const executionBranches = mergeProbabilityBranches(worlds.filter((branch) => branch.executes));
    return { executionBranches, executionProbability:totalBranchProbability(executionBranches) };
  }

  /*
  功能
  联合动作条件、卡牌可用性、次数槽和数量资源，构造互斥的完整执行世界。

  调用方
  根与深层候选生成路径。

  输入
  SearchState、行动者、动作及其条件/卡牌/技能/次数槽约束。

  输出
  带 executionWorldBranches 与 executionProbability 的新动作描述。

  读取状态
  只读动作条件、资源概率分支和 SearchState 槽位。

  写入状态
  无；返回浅复制动作与新的世界分支数组。

  调用函数
  getActionConditionPartition、getAvailabilityStateBranches、getAttackUseSlots、getSkillUseSlots、joinProbabilityStateBranches。

  边界与不变量
  所有约束必须在同一条件世界联合，不能把相关概率当作独立标量相乘。
  */
  attachProbabilityBranches(game, actor, action) {
    if (action.type === "end") return action;
    const conditionBranches = this.getActionConditionPartition(game, actor, action);
    if (action.type === "card") {
      const cardState = getAvailabilityStateBranches(action.card).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        cardAvailable:branch.available
      }));
      const basePartitions = [conditionBranches, cardState];
      const attackSlots = action.card.definitionId === "assault" ? this.getAttackUseSlots(actor) : [null];
      let bestResult = null;
      for (let attackUseSlot = 0; attackUseSlot < attackSlots.length; attackUseSlot += 1) {
        const attackState = attackSlots[attackUseSlot]?.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          attackSlotAvailable:branch.available
        }));
        const worlds = this.buildExecutionWorlds(
          attackState ? [...basePartitions, attackState] : basePartitions,
          (branch) => branch.matches && branch.cardAvailable && (attackState ? branch.attackSlotAvailable : true)
        );
        const summary = this.summarizeExecution(worlds);
        if (summary.executionProbability <= PROBABILITY_EPSILON) continue;
        const cardAvailabilityStateBranches = projectProbabilityStateBranches(worlds, (branch) => ({
          available:branch.cardAvailable && !branch.executes
        }));
        const result = {
          ...action,
          conditionBranches,
          executionWorldBranches:worlds,
          ...summary,
          remainingAvailabilityStateBranches:cardAvailabilityStateBranches,
          remainingAvailabilityBranches:availableBranchesFromState(cardAvailabilityStateBranches)
        };
        if (attackState) result.attackUseSlot = attackUseSlot;
        if (!bestResult || result.executionProbability > bestResult.executionProbability + PROBABILITY_EPSILON) {
          bestResult = result;
        }
      }
      return bestResult;
    }

    const slots = this.getSkillUseSlots(actor, action.skill);
    const energyState = getValueBranches(actor, "energy", actor.energy).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      energyAmount:branch.amount
    }));
    const minimumEnergy = action.skill.id === "allIn"
      ? 1
      : getActiveSkillCost(game, actor, action.skill);
    let bestResult = null;
    for (let skillUseSlot = 0; skillUseSlot < slots.length; skillUseSlot += 1) {
      const slotState = slots[skillUseSlot].map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        skillSlotAvailable:branch.available ?? true
      }));
      const worlds = this.buildExecutionWorlds(
        [conditionBranches, slotState, energyState],
        (branch) => branch.matches && branch.skillSlotAvailable && branch.energyAmount >= minimumEnergy
      );
      const summary = this.summarizeExecution(worlds);
      if (summary.executionProbability <= PROBABILITY_EPSILON) continue;
      const skillAvailabilityStateBranches = projectProbabilityStateBranches(worlds, (branch) => ({
        available:branch.skillSlotAvailable && !branch.executes
      }));
      const result = {
        ...action,
        energyCost:minimumEnergy,
        conditionBranches,
        executionWorldBranches:worlds,
        ...summary,
        remainingSkillAvailabilityStateBranches:skillAvailabilityStateBranches,
        remainingSkillAvailabilityBranches:availableBranchesFromState(skillAvailabilityStateBranches),
        skillUseSlot,
      };
      if (!bestResult || result.executionProbability > bestResult.executionProbability + PROBABILITY_EPSILON) {
        bestResult = result;
      }
    }
    return bestResult;
  }
}
