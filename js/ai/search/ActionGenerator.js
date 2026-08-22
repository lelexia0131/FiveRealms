/*
模块职责
生成真实根局面与 SearchState 深层节点的 AI 候选动作。

上游
AIController 与 Planner 注入能力。

下游
Domain Card/Skill/Status Rules、Domain Definitions、AI RuleProjection、领域概率与策略评分模块。

状态边界
根生成只读 GameState，深层生成只读 SearchState，不执行或结算动作。

信息边界
深层动作只使用 SearchState 的合法可见、记忆与 Belief 字段。

架构约束
不得依赖 AIController；转移资源选择必须由构造时注入的窄能力提供。
*/
import {
  canPlayCard,
  findPlayerFact,
  getAssaultTargetIds,
  getCardTargetIds,
  getLeverageFirstTargetIds,
  getTransferReceiverIds,
  getTransferSourceIds
} from "../../domain/rules/card/CardRules.js";
import { hasStatus } from "../../domain/rules/status/StatusRules.js";
import {
  canUseSkillBase,
  getSkillCost,
  getSkillTargetIds
} from "../../domain/rules/skill/SkillRules.js";
import { getActiveSkillUseCount } from "../../domain/rules/turn/TurnRules.js";
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getLightningStatusStateBranches } from "../domain/LightningModel.js";
import { getSealStatusStateBranches } from "../domain/SealModel.js";
import {
  projectAttackUsage,
  projectRulePlayer,
  projectRulePlayers,
  projectTransferRulePlayers
} from "../state/RuleProjection.js";
import { getRangeConditionBranches } from "../state/DistanceProbabilityBranches.js";
import { ActionCandidatePolicy } from "../policy/ActionCandidatePolicy.js";
import { TransferPolicy } from "../policy/TransferPolicy.js";
import {
  PROBABILITY_EPSILON,
  availableBranchesFromState,
  binaryConditionPartition,
  getAvailabilityStateBranches,
  getValueBranches,
  huntMarkConditionKey,
  joinProbabilityStateBranchesCooperatively,
  mergeProbabilityBranchesCooperatively,
  projectProbabilityStateBranchesCooperatively,
  totalBranchProbability
} from "../state/Probability.js";

/*
功能
把搜索动作键中的数组和普通对象递归规范为稳定属性顺序。

调用方
searchEquivalentActionKey。

输入
动作语义中的普通值、数组或 data-only 对象。

输出
属性顺序稳定且不共享可变容器的新值。

读取状态
无。

写入状态
无。

调用函数
自身递归调用。

边界与不变量
不得删除 selection、概率条件或实体语义字段；只规范表示顺序。
*/
function normalizeSearchKeyValue(value) {
  if (Array.isArray(value)) return value.map(normalizeSearchKeyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalizeSearchKeyValue(value[key])])
  );
}

/*
功能
为当前搜索语义完全等价的动作生成稳定键。

调用方
deduplicateSearchEquivalentActions。

输入
已由 ActionGenerator 枚举的根或深层动作。

输出
忽略可互换使用牌实体 ID、保留所有其它语义字段的字符串键。

读取状态
动作类型、卡牌定义/实例元数据、目标、selection、概率世界与次数槽。

写入状态
无。

调用函数
normalizeSearchKeyValue、JSON.stringify。

边界与不变量
只忽略被打出卡牌自身的 id；identityGroupKey、availability、selection 中的资源 ID、
目标顺序和条件世界任一不同都必须保留独立分支。
*/
function searchEquivalentActionKey(action) {
  const { card = null, skill = null, targets = [], ...actionFields } = action ?? {};
  const cardFields = card
    ? Object.fromEntries(Object.entries(card).filter(([key]) => key !== "id"))
    : null;
  return JSON.stringify(normalizeSearchKeyValue({
    ...actionFields,
    card:cardFields,
    skillId:skill?.id ?? null,
    targetIds:(targets ?? []).map((target) => target?.id ?? null)
  }));
}

/*
功能
在候选生成 owner 内合并仅使用牌实体 ID 不同的搜索等价动作。

调用方
WorkerSearchRuntime 根候选恢复与 generateFromVisible 深层候选生成。

输入
保持稳定枚举顺序的动作数组。

输出
每个搜索语义键保留首个实体代表的动作数组。

读取状态
动作的搜索语义字段。

写入状态
无。

调用函数
searchEquivalentActionKey。

边界与不变量
不修改原动作；真正依赖实体身份、availability、selection 或条件世界的动作不得合并，
首个代表仍携带可由 Main Thread 重绑和执行的真实 card instance ID。
*/
export function deduplicateSearchEquivalentActions(actions) {
  const seen = new Set();
  const unique = [];
  for (const action of actions ?? []) {
    const key = searchEquivalentActionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(action);
  }
  return unique;
}

export class ActionGenerator {
  /*
  功能
  创建动作生成器并绑定真实规则边界与转移选择能力。

  调用方
  AIController 组合根与直接独立性测试。

  输入
  getRootContext 窄能力与包含 chooseTransferCombination 的依赖对象。

  输出
  可生成根与深层动作的 ActionGenerator；缺少依赖时立即抛错。

  读取状态
  无。

  写入状态
  实例 getRootContext 与转移选择能力。

  调用函数
  无。

  边界与不变量
  只保存具体能力，不接收或查找 AIController。
  */
  constructor({
    getRootContext = null,
    chooseTransferCombination = null,
    transferPolicy,
    actionCandidatePolicy
  } = {}) {
    if (getRootContext === null && chooseTransferCombination === null) {
      // Worker-safe deep-only construction；root generate() 会在调用时 fail fast。
    } else {
      if (typeof getRootContext !== "function") {
        throw new TypeError("ActionGenerator 缺少依赖：getRootContext");
      }
      if (typeof chooseTransferCombination !== "function") {
        throw new TypeError("ActionGenerator 缺少依赖：chooseTransferCombination");
      }
    }
    const resolvedTransferPolicy = transferPolicy ?? new TransferPolicy();
    const resolvedActionCandidatePolicy = actionCandidatePolicy ?? new ActionCandidatePolicy();
    if (typeof resolvedTransferPolicy.choose !== "function") {
      throw new TypeError("ActionGenerator 缺少依赖：transferPolicy");
    }
    if (typeof resolvedActionCandidatePolicy.isLightningStrategicallyForbidden !== "function") {
      throw new TypeError("ActionGenerator 缺少依赖：actionCandidatePolicy");
    }
    this.getRootContext = getRootContext;
    this.chooseTransferCombination = chooseTransferCombination;
    this.transferPolicy = resolvedTransferPolicy;
    this.actionCandidatePolicy = resolvedActionCandidatePolicy;
  }

  /*
  功能
  把玩家实体解析为 Domain CardRules 目标 ID 对应的原玩家对象。

  调用方
  generate 与 generateFromVisible 的根/深层动作枚举。

  输入
  原玩家数组、规则目标 ID 数组。

  输出
  原玩家对象数组。

  读取状态
  无。

  写入状态
  无。

  调用函数
  Array.find。

  边界与不变量
  保持 ID 数组顺序；找不到的 ID 不产生伪实体。
  */
  resolveRuleTargets(players, ids) {
    return ids.map((id) => players.find((player) => player.id === id)).filter(Boolean);
  }

  /*
  功能
  把玩家数组投影为 Domain Card/Skill Rule canonical facts。

  调用方
  generate 与 generateFromVisible。

  输入
  原玩家数组。

  输出
  冻结的 canonical player facts。

  读取状态
  无。

  写入状态
  无。

  调用函数
  projectRulePlayers。

  边界与不变量
  保持调用方顺序，保证候选 target order 不变。
  */
  projectPlayers(players) {
    return projectRulePlayers(players);
  }

  /*
  功能
  计算排除当前转移牌后的 Domain transfer source facts。

  调用方
  generate 与 generateFromVisible 的 transfer legality。

  输入
  原玩家数组与要排除的卡牌 ID 集合。

  输出
  冻结的 canonical player facts，handCount 已扣除排除实体。

  读取状态
  无。

  写入状态
  无。

  调用函数
  projectTransferRulePlayers。

  边界与不变量
  只投影可转移手牌数量；Domain Rule 负责来源与接收者公式。
  */
  projectTransferPlayers(players, excludedCardIds) {
    return projectTransferRulePlayers(players, excludedCardIds);
  }

  /*
  功能
  从 Domain CardRules 取得卡牌合法目标实体。

  调用方
  generate 与 generateFromVisible。

  输入
  原玩家数组、source 与 card。

  输出
  原玩家对象数组。

  读取状态
  canonical players facts。

  写入状态
  无。

  调用函数
  projectPlayers、findPlayerFact、getCardTargetIds、resolveRuleTargets。

  边界与不变量
  目标公式只由 Domain CardRules 解释；不在此过滤 AI policy。
  */
  getCardTargetsFromRule(players, source, card, isRangeLegal = null) {
    const rulePlayers = this.projectPlayers(players);
    const sourceFact = findPlayerFact(rulePlayers, source.id);
    return this.resolveRuleTargets(players, getCardTargetIds(rulePlayers, sourceFact, card, isRangeLegal));
  }

  /*
  功能
  从 Domain CardRules 取得借势第二目标实体。

  调用方
  generate 与 generateFromVisible。

  输入
  原玩家数组与 source。

  输出
  原玩家对象数组。

  读取状态
  canonical players facts。

  写入状态
  无。

  调用函数
  projectPlayers、findPlayerFact、getAssaultTargetIds、resolveRuleTargets。

  边界与不变量
  第二目标只受 Domain 距离规则约束，不检查次数或手牌。
  */
  getAssaultTargetsFromRule(players, source, isRangeLegal = null) {
    const rulePlayers = this.projectPlayers(players);
    const sourceFact = findPlayerFact(rulePlayers, source.id);
    return this.resolveRuleTargets(players, getAssaultTargetIds(rulePlayers, sourceFact, isRangeLegal));
  }

  /*
  功能
  从 Domain CardRules 取得借势第一目标实体。

  调用方
  generate 与 generateFromVisible。

  输入
  原玩家数组与 source。

  输出
  原玩家对象数组。

  读取状态
  canonical players facts。

  写入状态
  无。

  调用函数
  projectPlayers、findPlayerFact、getLeverageFirstTargetIds、resolveRuleTargets。

  边界与不变量
  第一目标装备与第二目标距离公式只由 Domain 解释。
  */
  getLeverageFirstTargetsFromRule(players, source, isRangeLegal = null) {
    const rulePlayers = this.projectPlayers(players);
    const sourceFact = findPlayerFact(rulePlayers, source.id);
    return this.resolveRuleTargets(players, getLeverageFirstTargetIds(rulePlayers, sourceFact, isRangeLegal));
  }

  /*
  功能
  从 Domain CardRules 取得可转移来源实体。

  调用方
  generate 与 generateFromVisible 的转移枚举。

  输入
  原玩家数组、source、card 与排除 ID。

  输出
  原玩家对象数组。

  读取状态
  canonical transfer facts。

  写入状态
  无。

  调用函数
  projectTransferPlayers、findPlayerFact、getTransferSourceIds、resolveRuleTargets。

  边界与不变量
  排除规则与 transferableHandCount 一致。
  */
  getTransferSourcesFromRule(players, source, card, excludedCardIds = null, isRangeLegal = null) {
    const exclusions = excludedCardIds ?? (card?.id ? new Set([card.id]) : null);
    const rulePlayers = this.projectTransferPlayers(players, exclusions);
    const sourceFact = findPlayerFact(rulePlayers, source.id);
    return this.resolveRuleTargets(players, getTransferSourceIds(rulePlayers, sourceFact, card, isRangeLegal));
  }

  /*
  功能
  从 Domain CardRules 取得转移接收者实体。

  调用方
  generate 与 generateFromVisible 的转移枚举。

  输入
  原玩家数组、source、from 与 card。

  输出
  原玩家对象数组。

  读取状态
  canonical transfer facts。

  写入状态
  无。

  调用函数
  projectTransferPlayers、findPlayerFact、getTransferReceiverIds、resolveRuleTargets。

  边界与不变量
  接收者排除来源自身；公式只由 Domain CardRules 解释。
  */
  getTransferReceiversFromRule(players, source, from, card, isRangeLegal = null) {
    const exclusions = card?.id ? new Set([card.id]) : null;
    const rulePlayers = this.projectTransferPlayers(players, exclusions);
    const sourceFact = findPlayerFact(rulePlayers, source.id);
    const fromFact = findPlayerFact(rulePlayers, from.id);
    return this.resolveRuleTargets(players, getTransferReceiverIds(rulePlayers, sourceFact, fromFact, card, isRangeLegal));
  }

  /*
  功能
  从 Domain SkillRules 取得技能目标实体。

  调用方
  generate 与 generateFromVisible。

  输入
  原玩家数组、source 与 skill。

  输出
  原玩家对象数组。

  读取状态
  canonical players facts。

  写入状态
  无。

  调用函数
  projectPlayers、getSkillTargetIds、resolveRuleTargets。

  边界与不变量
  技能目标公式只由 Domain SkillRules 解释。
  */
  getSkillTargetsFromRule(players, source, skill, isRangeLegal = null) {
    if (!skill?.rangeRule) return [];
    const rulePlayers = this.projectPlayers(players);
    return this.resolveRuleTargets(players, getSkillTargetIds(rulePlayers, source.id, skill, isRangeLegal));
  }

  /*
  功能
  判断 SearchState 的任一概率装备世界是否满足 Domain 请求的距离约束。

  调用方
  generateFromVisible 的 Domain target rule 注入边界。

  输入
  SearchState、source、target 与 Domain 提供的 range。

  输出
  布尔值。

  读取状态
  公开座位、存活装备定义与 equipmentRetentionProbability。

  写入状态
  无。

  调用函数
  getRangeConditionBranches。

  边界与不变量
  Domain 仍拥有目标类型语义；这里只回答是否存在概率大于 epsilon 的合法距离世界。
  */
  hasPossibleRangeWorld(state, source, target, range) {
    const sourceState = state?.players?.find((player) => player.id === source?.id) ?? source;
    const targetState = state?.players?.find((player) => player.id === target?.id) ?? target;
    return getRangeConditionBranches({ state }, { source:sourceState, target:targetState, range })
      .some((branch) => branch.matches && branch.probability > PROBABILITY_EPSILON);
  }

  /*
  功能
  按 Domain SkillRules 判断当前真实技能是否可发动。

  调用方
  generate 根枚举。

  输入
  root context、source 与 Domain skill definition。

  输出
  { ok, reason }。

  读取状态
  root context 的 phase/currentPlayer 与 source usage/energy。

  写入状态
  无。

  调用函数
  canUseSkillBase、getSkillCost、getActiveSkillUseCount。

  边界与不变量
  基础费用与次数公式只由 Domain SkillRules 解释；额外目标非空检查保留 registry 行为。
  */
  canUseSkillFromRule(rootContext, source, skill) {
    if (!skill?.id) return { ok:false, reason:"" };
    const players = rootContext?.state?.players ?? [];
    const used = getActiveSkillUseCount(source.turnFlags, skill.id);
    const decision = canUseSkillBase({
      players,
      sourceId: source.id,
      currentPlayerId: rootContext?.currentPlayer?.id ?? rootContext?.state?.currentPlayerId ?? null,
      phase: rootContext?.state?.phase ?? rootContext?.phase ?? "idle",
      skill,
      used,
      limitPerTurn: skill.limitPerTurn ?? 1,
      energy: source.energy,
      minimumEnergy: getSkillCost(skill, source, players)
    });
    if (!decision.ok) return decision;
    if (["barrier", "resonance", "symbiosis", "stealSkill", "hunt"].includes(skill.id)
      && !this.getSkillTargetsFromRule(players, source, skill).length) {
      const reasons = {
        barrier:"没有存活队友",
        resonance:"没有存活队友",
        symbiosis:"自己和队友都未受伤",
        stealSkill:"距离2内没有持有手牌或装备的敌人",
        hunt:"没有猎印目标"
      };
      return { ok:false, reason:reasons[skill.id] };
    }
    return decision;
  }

  /*
  功能
  从 Domain CardRules 提供的深层合法 source/receiver 集合选择转移计划。

  调用方
  generateFromVisible。

  输入
  过滤 SearchState、行动者、转移牌与 Belief remaining counts。

  输出
  TransferPolicy 选择描述或 null。

  读取状态
  Domain CardRules 合法集合、SearchState 公开/合法信息与 Belief。

  写入状态
  无。

  调用函数
  Domain CardRules.getTransferSourceIds/getTransferReceiverIds、TransferPolicy.choose。

  边界与不变量
  Generator 只提供合法集合；正收益过滤和 tie-break 属正式 Policy，真实实体移动不在此发生。
  */
  chooseVisibleTransferPlan(state, actor, card, remainingCardCounts = null, isRangeLegal = null) {
    const players = state?.players ?? [];
    const excludedCardIds = card.id ? new Set([card.id]) : null;
    const sources = this.getTransferSourcesFromRule(players, actor, card, excludedCardIds, isRangeLegal);
    return this.transferPolicy.choose({
      actor,
      sources,
      excludedCardIds,
      remainingCardCounts,
      getReceivers:(from) => this.getTransferReceiversFromRule(players, actor, from, card, isRangeLegal)
    });
  }

  /*
  功能
  从当前真实局面枚举 Domain Rules 允许的动作，再应用 AI 专属候选策略形成 Planner 根候选。

  调用方
  AIController.getActionCandidates 与直接动作生成测试。

  输入
  当前行动 Player。

  输出
  包含卡牌、技能和结束阶段的 Planner 候选数组；它不等同于完整游戏合法动作集。

  读取状态
  当前 GameState、Domain Rules 权威、角色技能与转移选择策略。

  写入状态
  无。

  调用函数
  Domain CardRules/SkillRules 合法性与目标入口、chooseTransferCombination。

  边界与不变量
  Domain CardRules/SkillRules 独占确定性合法性，ActionCandidatePolicy 仅收窄 AI 会考虑的集合；保持既有枚举顺序与候选集合，转移只记录选择描述，不移动实体牌。
  */
  generate(player, rootContext = null) {
    if (typeof this.getRootContext !== "function") {
      throw new Error("Worker deep-only ActionGenerator 不提供 root generate");
    }
    const context = rootContext ?? this.getRootContext();
    const players = context.state.players;
    const actions = [];
    for (const card of player.hand) {
      const transferSourceIds = card.definitionId === "transfer"
        ? this.getTransferSourcesFromRule(players, player, card, new Set([card.id]))
          .map((from) => from.id)
        : null;
      const cardLegality = canPlayCard({
        players: this.projectPlayers(players),
        sourceId: player.id,
        currentPlayerId: context.currentPlayer?.id ?? context.state?.currentPlayerId ?? null,
        phase: context.state?.phase ?? context.phase ?? "idle",
        card,
        inHand: Boolean(player.hand.includes(card) || player.hand.some((entry) => entry?.id === card?.id)),
        assaultUsage: projectAttackUsage(player),
        recoverUsed: player.turnFlags?.recoverUsed ?? player.recoverUsed ?? 0,
        recoverLimit: player.turnFlags?.recoverLimit ?? player.recoverLimit ?? null,
        transferSourceIds
      });
      if (!cardLegality.ok) continue;
      if (card.definitionId === "lightning"
        && this.actionCandidatePolicy.isLightningStrategicallyForbidden(
          players,
          player
        )) continue;
      if (card.definitionId === "lightning" && hasStatus(projectRulePlayer(player), "lightning")) continue;
      const targets = this.getCardTargetsFromRule(players, player, card);
      if (card.definitionId === "leverage") {
        for (const firstTarget of this.getLeverageFirstTargetsFromRule(players, player)) {
          for (const secondTarget of this.getAssaultTargetsFromRule(players, firstTarget)) {
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
        const sources = this.getTransferSourcesFromRule(players, player, card, new Set([card.id]))
          .filter((from) => this.getTransferReceiversFromRule(players, player, from, card).length);
        const selection = this.chooseTransferCombination(player, card, sources, null, new Set([card.id]));
        if (selection) actions.push({ type:"card", card, targets:[], selection });
        continue;
      }
      if (["singleEnemy", "singleEnemyInRange", "singleUnsealedEnemy", "singleAlly", "otherWithCards", "otherWithCardsOrEquipment"].includes(card.targetType)) {
        const aiTargets = this.actionCandidatePolicy.filterCardTargets(card, player, targets);
        for (const target of aiTargets) actions.push({ type:"card", card, targets:[target] });
      } else actions.push({ type:"card", card, targets:card.targetType === "allEnemies" || card.targetType === "allLiving" ? targets : [] });
    }
    const skill = ACTIVE_SKILL_DEFINITIONS[player.character?.activeSkillIds?.[0] ?? ""] ?? null;
    if (skill
      && this.canUseSkillFromRule(context, player, skill).ok
      && (skill.id !== "breakArmy"
        || this.actionCandidatePolicy.canBenefitFromBreakArmy(player))
      && !(skill.id === "allIn" && this.actionCandidatePolicy.isZeroBenefitAllIn(player))) {
      const targets = this.getSkillTargetsFromRule(players, player, skill);
      const energyCost = getSkillCost(skill, player, players);
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
  SearchState、当前行动者 ID 与可选 SearchBudget 诊断能力。

  输出
  带执行概率分支的 AI policy candidate action 数组。

  读取状态
  过滤玩家、Belief、Domain Rules 共享纯规则、正式 Policy 与概率代数。

  写入状态
  无。

  调用函数
  Domain Card/Skill Rules、ActionCandidatePolicy、TransferPolicy、deduplicateSearchEquivalentActions、attachProbabilityBranches。

  边界与不变量
  动态距离只使用实时 alive ring；Policy 过滤不改变 Domain authority 的合法性定义；
  identity、availability、selection 与条件世界可能在 preparation 后才完整，必须保留逐实体准备和原有 post-preparation dedup；
  TIME 可在单个 preparation 的安全概率边界 cooperative abort；当前未完成动作整体作废，
  已完整 preparation 的动作继续保留，且不改变 NODE 的完整候选语义。
  */
  generateFromVisible(state, playerId, searchBudget = null) {
    if (state.playPhaseEnded) return [];
    const actor = state.players.find((player) => player.id === playerId && player.alive);
    if (!actor) return [{ type:"end" }];
    const alive = state.players.filter((player) => player.alive).sort((a,b) => a.seatIndex - b.seatIndex);
    // 深层规则输入是 SearchState canonical projection，Domain Rules 只接收 data-only facts。
    const enemies = alive.filter((player) => player.battleTeam !== actor.battleTeam);
    /*
    功能
    把当前 SearchState 绑定成 Domain target rules 所需的概率距离 predicate。

    调用方
    generateFromVisible 内的 card/skill/transfer/leverage target enumeration。

    输入
    Domain 投影的 source、target 与 range。

    输出
    布尔值。

    读取状态
    当前 generateFromVisible 的 state。

    写入状态
    无。

    调用函数
    hasPossibleRangeWorld。

    边界与不变量
    只回答候选存在性；精确 execution probability 仍由 attachProbabilityBranches 计算。
    */
    const isRangeLegal = (source, target, range) => this.hasPossibleRangeWorld(
      state, source, target, range
    );
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
      if (card.definitionId === "lightning" && hasStatus(projectRulePlayer(actor), "lightning")) continue;
      if (card.definitionId === "assault") {
        for (const target of this.getCardTargetsFromRule(state.players, actor, card, isRangeLegal)) {
          actions.push({ type:"card", card, targets:[target] });
        }
        continue;
      }
      if (card.definitionId === "recover" && (actor.hp >= actor.maxHp || (actor.recoverLimit !== null && actor.recoverUsed >= actor.recoverLimit))) continue;
      if (card.definitionId === "charge" && actor.energy >= actor.maxEnergy) continue;
      if (card.definitionId === "transfer") {
        const selection = this.chooseVisibleTransferPlan(
          state, actor, card, state.remainingCardCounts ?? null, isRangeLegal
        );
        if (selection) actions.push({ type:"card", card, targets:[], selection });
        continue;
      }
      if (card.definitionId === "leverage") {
        const firstTargets = this.getLeverageFirstTargetsFromRule(
          state.players, actor, isRangeLegal
        ).filter((firstTarget) => (firstTarget.equipmentRetentionProbability ?? 1) > PROBABILITY_EPSILON);
        for (const firstTarget of firstTargets) {
          for (const secondTarget of this.getAssaultTargetsFromRule(state.players, firstTarget, isRangeLegal)) {
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
        for (const target of this.getCardTargetsFromRule(state.players, actor, card, isRangeLegal)) {
          actions.push({ type:"card", card, targets:[target] });
        }
      } else if (card.targetType === "singleAlly") for (const target of this.getCardTargetsFromRule(state.players, actor, card, isRangeLegal)) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "otherWithCards") for (const target of this.getCardTargetsFromRule(state.players, actor, card, isRangeLegal)) actions.push({ type:"card", card, targets:[target] });
      else if (card.targetType === "otherWithCardsOrEquipment") {
        const targets = this.getCardTargetsFromRule(state.players, actor, card, isRangeLegal);
        for (const target of this.actionCandidatePolicy.filterCardTargets(
          card,
          actor,
          targets
        )) actions.push({ type:"card", card, targets:[target] });
      }
      else actions.push({ type:"card", card, targets:["allEnemies","allLiving"].includes(card.targetType) ? (card.targetType === "allEnemies" ? enemies : alive) : [] });
    }
    const skill = ACTIVE_SKILL_DEFINITIONS[actor.activeSkillId] ?? null;
    if (skill
      && (skill.id !== "breakArmy"
        || this.actionCandidatePolicy.canBenefitFromBreakArmy(actor))
      && !(skill.id === "allIn" && this.actionCandidatePolicy.isZeroBenefitAllIn(actor))) {
            let targets = [];
      if (skill.id === "barrier") targets = this.getSkillTargetsFromRule(state.players, actor, skill, isRangeLegal);
      else if (skill.id === "resonance") targets = this.getSkillTargetsFromRule(state.players, actor, skill, isRangeLegal);
      else if (skill.id === "symbiosis") targets = this.getSkillTargetsFromRule(state.players, actor, skill, isRangeLegal);
      else if (skill.id === "stealSkill") targets = this.getSkillTargetsFromRule(state.players, actor, skill, isRangeLegal);
      else if (skill.id === "hunt") {
        const ruleTargets = new Set(this.getSkillTargetsFromRule(state.players, actor, skill, isRangeLegal)
          .map((target) => target.id));
        targets = enemies.filter((player) => {
          if (ruleTargets.has(player.id)) return true;
          const markBranches = player.huntMarkStateBranchesBySource?.[actor.id];
          if (Array.isArray(markBranches)) {
            return totalBranchProbability(markBranches.filter((branch) => branch.marked)) > PROBABILITY_EPSILON;
          }
          return Math.max(0, Math.min(1, Number(
            player.huntMarkProbabilities?.[actor.id] ?? (player.huntMarkSourceId === actor.id ? 1 : 0)
          ) || 0)) > 0;
        });
      }
      if (["none","allEnemies"].includes(skill.targetType)) actions.push({ type:"skill", skill, targets:skill.targetType === "allEnemies" ? enemies : [] });
      else for (const target of targets) actions.push({ type:"skill", skill, targets:[target] });
    }
    actions.push({ type:"end" });
    const preparedActions = [];
    for (const action of actions) {
      if (searchBudget?.shouldAbortCurrentWork?.()) break;
      let prepared = null;
      try {
        prepared = this.attachProbabilityBranches(state, actor, action, searchBudget);
      } catch (error) {
        if (searchBudget?.isCurrentWorkInterruption?.(error)) break;
        throw error;
      }
      if (!prepared) continue;
      preparedActions.push(prepared);
      searchBudget?.observeActionGeneration?.({
        preparedCandidates:1,
        probabilityPreparations:action.type === "end" ? 0 : 1,
        conditionBranches:prepared.conditionBranches?.length ?? 0,
        executionWorldBranches:prepared.executionWorldBranches?.length ?? 0
      });
    }
    const uniquePreparedActions = deduplicateSearchEquivalentActions(preparedActions);
    searchBudget?.observeActionGeneration?.({
      physicalCandidates:actions.length,
      uniqueCandidates:uniquePreparedActions.length
    });
    return uniquePreparedActions;
  }

  /*
  功能
  把距离、延迟状态和选择约束投影为动作是否匹配的互斥条件分区。

  调用方
  attachProbabilityBranches。

  输入
  过滤 SearchState、行动者与候选动作。

  输出
  带 probability、conditions 与 matches 的条件分支。

  读取状态
  攻击距离、猎印、封印、闪电和转移/借势公开条件。

  写入状态
  无。

  调用函数
  DistanceProbabilityBranches、LightningModel、SealModel、binaryConditionPartition。

  边界与不变量
  这里只投影既有条件世界，不重新判断 Policy 价值或执行真实规则。
  */
  getActionConditionPartition(state, actor, action) {
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
        return getRangeConditionBranches({ state }, {
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
      const target = state.players.find((player) => player.id === action.targets?.[0]?.id);
      return getSealStatusStateBranches(target).map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        matches:!branch.present
      }));
    }
    if (card.definitionId === "transfer") {
      const source = state.players.find((player) => player.id === action.selection?.sourceId);
      const receiver = state.players.find((player) => player.id === action.selection?.receiverId);
      return getRangeConditionBranches({ state }, [
        { source:actor, target:source, range:card.effectRange },
        { source:actor, target:receiver, range:card.effectRange }
      ]);
    }
    if (card.definitionId === "leverage") {
      const first = state.players.find((player) => player.id === action.selection?.firstTargetId);
      const second = state.players.find((player) => player.id === action.selection?.secondTargetId);
      return getRangeConditionBranches({ state }, {
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
      return getRangeConditionBranches({ state }, {
        source:actor,
        target,
        range:actor.attackRange ?? 1
      });
    }
    if (!card.ignoresDistance && card.effectRange != null && target) {
      return getRangeConditionBranches({ state }, {
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
        { probability:unavailable, conditions:{ [`attackUse:${actor.id}:${index}`]:"used" }, available:false }
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
  在单个 action probability preparation 内观察父 SearchBudget。

  调用方
  buildExecutionWorlds、summarizeExecution 与 attachProbabilityBranches。

  输入
  可选父 SearchBudget。

  输出
  可继续时返回 true；停止时抛出父预算的 cooperative unwind signal。

  读取状态
  传入 SearchBudget。

  写入状态
  SearchBudget 首次过期时写入停止原因。

  调用函数
  SearchBudget.checkpointCurrentWork。

  边界与不变量
  不创建第二套 timeout；无预算的根动作准备保持原完整同步语义。
  */
  checkpointProbabilityPreparation(searchBudget) {
    return searchBudget?.checkpointCurrentWork?.() ?? true;
  }

  /*
  功能
  联合多个共享条件分区并标记每个完整世界是否执行动作。

  调用方
  attachProbabilityBranches。

  输入
  概率分区数组、对联合分支的执行谓词与可选 SearchBudget。

  输出
  新的完整世界数组，每项带 executes 标记。

  读取状态
  只读调用方提供的分支与条件键。

  写入状态
  无。

  调用函数
  joinProbabilityStateBranchesCooperatively、predicate、SearchBudget checkpoint/诊断。

  边界与不变量
  相同条件键必须先联合再求谓词，避免相关资源容量被独立相乘；
  中断时不得返回 partial worlds。
  */
  buildExecutionWorlds(partitions, predicate, searchBudget = null) {
    const joined = joinProbabilityStateBranchesCooperatively(
      partitions,
      () => this.checkpointProbabilityPreparation(searchBudget)
    );
    searchBudget?.observeProbabilityWork?.(joined.length);
    const worlds = [];
    for (let index = 0; index < joined.length; index += 1) {
      if (index % 32 === 0) this.checkpointProbabilityPreparation(searchBudget);
      const branch = joined[index];
      worlds.push({
        ...branch,
        executes:Boolean(predicate(branch))
      });
    }
    return worlds;
  }

  /*
  功能
  从完整执行世界提取动作实际执行的规范分支与总概率。

  调用方
  attachProbabilityBranches。

  输入
  带 executes 标记的完整世界数组与可选 SearchBudget。

  输出
  executionBranches 与 executionProbability。

  读取状态
  世界概率、条件键与 executes 标记。

  写入状态
  无。

  调用函数
  mergeProbabilityBranchesCooperatively、SearchBudget checkpoint/诊断。

  边界与不变量
  合并只发生在已执行世界，条件质量守恒且不改变动作排序；中断不返回 partial summary。
  */
  summarizeExecution(worlds, searchBudget = null) {
    const executed = [];
    for (let index = 0; index < worlds.length; index += 1) {
      if (index % 32 === 0) this.checkpointProbabilityPreparation(searchBudget);
      if (worlds[index].executes) executed.push(worlds[index]);
    }
    const executionBranches = mergeProbabilityBranchesCooperatively(
      executed,
      () => this.checkpointProbabilityPreparation(searchBudget)
    );
    searchBudget?.observeProbabilityWork?.(executionBranches.length);
    let executionProbability = 0;
    for (let index = 0; index < executionBranches.length; index += 1) {
      if (index % 32 === 0) this.checkpointProbabilityPreparation(searchBudget);
      executionProbability += Math.max(0, Number(executionBranches[index]?.probability) || 0);
    }
    return { executionBranches, executionProbability };
  }

  /*
  功能
  联合动作条件、卡牌可用性、次数槽和数量资源，构造互斥的完整执行世界。

  调用方
  根与深层候选生成路径。

  输入
  SearchState、行动者、动作、可选 SearchBudget 及其条件/卡牌/技能/次数槽约束。

  输出
  带 executionWorldBranches 与 executionProbability 的新动作描述。

  读取状态
  只读动作条件、资源概率分支和 SearchState 槽位。

  写入状态
  无；返回浅复制动作与新的世界分支数组。

  调用函数
  getActionConditionPartition、getAvailabilityStateBranches、getAttackUseSlots、getSkillUseSlots、
  cooperative Probability join/project/merge 与 SearchBudget checkpoint。

  边界与不变量
  所有约束必须在同一条件世界联合，不能把相关概率当作独立标量相乘；
  任一 checkpoint 中断会丢弃整个 action preparation。
  */
  attachProbabilityBranches(state, actor, action, searchBudget = null) {
    this.checkpointProbabilityPreparation(searchBudget);
    if (action.type === "end") return action;
    const conditionBranches = this.getActionConditionPartition(state, actor, action);
    this.checkpointProbabilityPreparation(searchBudget);
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
        this.checkpointProbabilityPreparation(searchBudget);
        const attackState = attackSlots[attackUseSlot]?.map((branch) => ({
          probability:branch.probability,
          conditions:branch.conditions,
          attackSlotAvailable:branch.available
        }));
        const worlds = this.buildExecutionWorlds(
          attackState ? [...basePartitions, attackState] : basePartitions,
          (branch) => branch.matches && branch.cardAvailable && (attackState ? branch.attackSlotAvailable : true),
          searchBudget
        );
        const summary = this.summarizeExecution(worlds, searchBudget);
        if (summary.executionProbability <= PROBABILITY_EPSILON) continue;
        const cardAvailabilityStateBranches = projectProbabilityStateBranchesCooperatively(
          worlds,
          (branch) => ({ available:branch.cardAvailable && !branch.executes }),
          () => this.checkpointProbabilityPreparation(searchBudget)
        );
        searchBudget?.observeProbabilityWork?.(cardAvailabilityStateBranches.length);
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
      : getSkillCost(action.skill, actor);
    let bestResult = null;
    for (let skillUseSlot = 0; skillUseSlot < slots.length; skillUseSlot += 1) {
      this.checkpointProbabilityPreparation(searchBudget);
      const slotState = slots[skillUseSlot].map((branch) => ({
        probability:branch.probability,
        conditions:branch.conditions,
        skillSlotAvailable:branch.available ?? true
      }));
      const worlds = this.buildExecutionWorlds(
        [conditionBranches, slotState, energyState],
        (branch) => branch.matches && branch.skillSlotAvailable && branch.energyAmount >= minimumEnergy,
        searchBudget
      );
      const summary = this.summarizeExecution(worlds, searchBudget);
      if (summary.executionProbability <= PROBABILITY_EPSILON) continue;
      const skillAvailabilityStateBranches = projectProbabilityStateBranchesCooperatively(
        worlds,
        (branch) => ({ available:branch.skillSlotAvailable && !branch.executes }),
        () => this.checkpointProbabilityPreparation(searchBudget)
      );
      searchBudget?.observeProbabilityWork?.(skillAvailabilityStateBranches.length);
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
