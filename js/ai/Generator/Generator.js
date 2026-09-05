/*
模块职责
从 canonical World 枚举合法目标与选择，并创建 canonical Action。

上游
Controller 与 Searcher。

下游
Domain Card/Skill/Status Rules、Domain Definitions 与 Event Fact/Probability facade。

状态边界
只读 World，不执行或结算动作。

信息边界
候选只使用 World 的确定事实、合法记忆与 Probability bounded query。

架构约束
不得依赖 Controller；不得组合概率分支、构造执行世界或模拟 transition。
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
import {
  canUseSkillBase,
  getSkillCost,
  getSkillTargetIds
} from "../../domain/rules/skill/SkillRules.js";
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import {
  projectAttackUsage,
  projectRulePlayer,
  projectRulePlayers,
  projectTransferRulePlayers
} from "../Event/Fact.js";
import {
  PROBABILITY_EPSILON,
  cardAvailability,
  expectedAnonymousSlots,
  getRangeConditionBranches,
  getRangeLegalityProbability,
  queryAnonymousSlotDistribution,
  statusPresence
} from "../Event/Probability/Probability.js";
import { actionSearchKey, createAction } from "./Action.js";

/*
功能
把未来一次手牌资源选择投影为当前观察者可合法表示的 canonical selection。

调用方
Controller 的 post-Counter future-selection projection。

输入
canonical World player。

输出
known、unknown 或带 uniform-hand 标记的 hand selection；无玩家或空手牌时返回 null。

读取状态
viewer 自己的 hand、合法 knownCards、公开 handCount 与 canonical availability。

写入状态
无。

调用函数
cardAvailability。

边界与不变量
只有唯一可推导身份才返回 known；观察者完整知道的多张手牌保持 uniform-hand，
其余一律保持 anonymous，不读取未暴露的实体定义。
*/
export function projectFutureHandSelection(player) {
  if (!player) return null;
  const knownById = new Map();
  for (const entry of [
    ...(Array.isArray(player.hand) ? player.hand : []),
    ...(Array.isArray(player.knownCards) ? player.knownCards : [])
  ]) {
    const cardId = entry?.id ?? entry?.cardId ?? null;
    if (cardId && entry.definitionId && cardAvailability(entry) > PROBABILITY_EPSILON) {
      knownById.set(cardId, { cardId, definitionId:entry.definitionId });
    }
  }
  const known = [...knownById.values()];
  const handCount = Math.max(0, Number(player.handCount) || 0);
  if (handCount <= PROBABILITY_EPSILON) return null;
  if (known.length === 1 && handCount <= 1) {
    return {
      zone:"hand",
      selectionKind:"known",
      cardId:known[0].cardId,
      definitionId:known[0].definitionId,
      availableUnknownCount:0
    };
  }
  const availableUnknownCount = Math.max(0, handCount - known.length);
  return {
    zone:"hand",
    selectionKind:"unknown",
    cardId:null,
    definitionId:null,
    knownCardIds:known.map((entry) => entry.cardId),
    availableUnknownCount,
    ...(known.length > 1 && availableUnknownCount <= PROBABILITY_EPSILON
      ? { selectionMode:"uniform-hand" }
      : {})
  };
}

/*
功能
在候选生成 owner 内合并仅使用牌实体 ID 不同的搜索等价动作。

调用方
WorkerSearchRuntime 根候选恢复与 generate 深层候选生成。

输入
保持稳定枚举顺序的动作数组。

输出
每个搜索语义键保留首个实体代表的动作数组。

读取状态
动作的搜索语义字段。

写入状态
无。

调用函数
Action.actionSearchKey。

边界与不变量
不修改原动作；真正依赖实体身份、availability、selection 或条件世界的动作不得合并，
首个代表仍携带可由 Main Thread 重绑和执行的真实 card instance ID。
*/
export function deduplicateSearchEquivalentActions(actions) {
  const seen = new Set();
  const unique = [];
  for (const action of actions ?? []) {
    const key = actionSearchKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(action);
  }
  return unique;
}

export class Generator {
  /*
  功能
  枚举资源类 root 在 Counter chain 后可产生的全部合法 canonical selection。

  调用方
  Controller 的 runtime future-selection orchestration。

  输入
  root actor 视角 World、root 卡牌、公开目标 ID 与 Transfer 公开来源/接收者声明。

  输出
  Plunder/Destroy 的合法 hand/equipment selections，或 Transfer 固定来源/接收者下的合法 hand selections。

  读取状态
  World 当前资源、合法记忆、Probability anonymous slots 与公开 Transfer declaration。

  写入状态
  无。

  调用函数
  getResourceSelections、getHandSelections。

  边界与不变量
  只枚举合法候选，不比较价值；Transfer 的来源与接收者来自反制前公开声明，
  zone 与 card identity 只作为 Counter 后的未来候选产生。
  */
  getFutureRootSelections(state, rootCard, rootTargetIds, options = {}) {
    const definitionId = rootCard?.definitionId ?? null;
    if (["plunder", "destroy"].includes(definitionId)) {
      const ownerId = rootTargetIds?.[0] ?? null;
      const owner = state?.players?.find((player) => player.id === ownerId && player.alive) ?? null;
      return owner ? this.getResourceSelections(state, owner) : [];
    }
    if (definitionId === "transfer") {
      const context = options.publicTransferContext ?? null;
      const source = state?.players?.find(
        (player) => player.id === context?.fromPlayerId && player.alive
      ) ?? null;
      const receiver = state?.players?.find(
        (player) => player.id === context?.receiverPlayerId && player.alive
      ) ?? null;
      if (!source || !receiver || source.id === receiver.id) return [];
      return this.getHandSelections(state, source).map((selection) => ({
        ...selection,
        sourceId:source.id,
        receiverId:receiver.id,
        zone:"hand"
      }));
    }
    return [];
  }

  /*
  功能
  把 actor 视角选出的未来资源区域投影到响应者视角的合法 selection 表示。

  调用方
  Controller 的 runtime future-selection orchestration。

  输入
  响应者视角 World、root 卡牌、目标 ID、actor 视角选中 selection 与 Transfer 公开声明。

  输出
  可供 Counter gain/probability 查询使用的 canonical future selection；无法投影时返回 null。

  读取状态
  响应者视角的目标手牌摘要、合法身份、公开装备与 Transfer 来源/接收者。

  写入状态
  无。

  调用函数
  projectFutureHandSelection。

  边界与不变量
  只保留 actor post-Counter policy 已选中的资源语义；该 policy 合法确定 known cardId 时
  必须保留其身份，anonymous hand 才按响应者视角投影为 uniform-hand；equipment 使用公开定义。
  selected 只能来自 root actor 合法 World，不得从真实未知牌面补造身份。
  */
  projectFutureRootSelection(state, rootCard, rootTargetIds, selected, options = {}) {
    const definitionId = rootCard?.definitionId ?? null;
    const sourceId = definitionId === "transfer"
      ? options.publicTransferContext?.fromPlayerId ?? null
      : rootTargetIds?.[0] ?? null;
    const source = state?.players?.find((player) => player.id === sourceId && player.alive) ?? null;
    if (!source || !selected?.zone) return null;
    if (selected.zone === "equipment") {
      if (!["plunder", "destroy"].includes(definitionId) || !source.equipmentDefinitionId) return null;
      return {
        zone:"equipment",
        selectionKind:"equipment",
        cardId:null,
        definitionId:source.equipmentDefinitionId,
        availableUnknownCount:0
      };
    }
    if (selected.zone !== "hand") return null;
    const handSelection = selected.selectionKind === "known"
      && selected.cardId && selected.definitionId
      ? {
          zone:"hand",
          selectionKind:"known",
          cardId:selected.cardId,
          definitionId:selected.definitionId,
          availableUnknownCount:0
        }
      : projectFutureHandSelection(source);
    if (!handSelection) return null;
    if (definitionId !== "transfer") return handSelection;
    const receiverId = options.publicTransferContext?.receiverPlayerId ?? null;
    if (!state.players.some((player) => player.id === receiverId && player.alive)) return null;
    return {
      ...handSelection,
      sourceId:source.id,
      receiverId,
      zone:"hand"
    };
  }

  /*
  功能
  把已经通过真实规则入口的 root 战术与显式 future selection 投影为 canonical Action。

  调用方
  Controller 真实响应边界的 dynamic root flip 查询。

  输入
  当前 World、root 卡牌公开身份、来源 ID、原始目标 ID 与显式 future selection。

  输出
  target 与 selection 完整的 card Action；资源类 root 缺少 future selection 或输入无效时返回 null。

  读取状态
  World 当前存活玩家、root 卡牌公开定义与 future selection。

  写入状态
  无。

  调用函数
  createAction。

  边界与不变量
  该 root 已由真实 ActionWorkflow 完成合法性校验且卡牌成本已经沉没；这里只创建一次
  配对反事实所需的同一动作语义，不重新枚举 legality；Plunder/Destroy/Transfer 只接受
  Counter 后投影得到的 future selection，不读取或沿用 Counter 前的 zone/cardId；
  Counter 响应支付本身不是可独立重放的 root effect。
  */
  createRootResolutionAction(state, rootCard, rootSourceId, rootTargetIds, options = {}) {
    if (!rootCard?.definitionId || !rootSourceId) return null;
    // Counter 是响应支付而非可独立重放的 root effect；其 gain 由 Evaluator 的配对 World 评价。
    if (rootCard.definitionId === "counter") return null;
    const targetIds = (rootTargetIds ?? []).filter((targetId) => (
      state.players.some((player) => player.id === targetId && player.alive)
    ));
    let selection = options.selection ?? null;
    if (rootCard.definitionId === "transfer") {
      selection = options.futureSelection ?? null;
      if (!selection?.sourceId || !selection?.receiverId || selection.zone !== "hand") return null;
    } else if (["plunder", "destroy"].includes(rootCard.definitionId)) {
      selection = options.futureSelection ?? null;
      if (!selection?.zone || !["hand", "equipment"].includes(selection.zone)) return null;
    } else if (rootCard.definitionId === "leverage") {
      selection = {
        firstTargetId:targetIds[0] ?? null,
        secondTargetId:targetIds[1] ?? null
      };
    }
    return createAction({
      type:"card",
      actorId:rootSourceId,
      cardId:rootCard.definitionId,
      cardInstanceId:rootCard.id ?? rootCard.definitionId,
      targetIds,
      selection
    });
  }

  /*
  功能
  判断 World 的任一概率装备世界是否满足 Domain 请求的距离约束。

  调用方
  generate 的 Domain target rule 注入边界。

  输入
  World、source、target 与 Domain 提供的 range。

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
  枚举一名 World 玩家当前所有合法手牌选择语义。

  调用方
  transfer、scout、plunder 与 destroy selection expansion。

  输入
  World、资源拥有者与可选排除实体 ID。

  输出
  每个合法已知实体一个 known 选择，匿名有限池容量存在时一个 unknown 选择。

  读取状态
  自己的 hand、合法 knownCards、实体 availability 与 ProbabilityState 匿名桶。

  写入状态
  无。

  调用函数
  expectedAnonymousSlots。

  边界与不变量
  unknown 是完整的匿名位置语义，不携带隐藏 definitionId；执行边界只能解析该位置，不能重新评分。
  */
  getHandSelections(state, owner, excludedCardIds = null) {
    const resources = Array.isArray(owner?.hand) ? owner.hand : (owner?.knownCards ?? []);
    const selections = resources.filter((entry) => (
      !excludedCardIds?.has(entry.id ?? entry.cardId)
      && cardAvailability(entry) > PROBABILITY_EPSILON
    )).map((entry) => ({
      zone:"hand",
      selectionKind:"known",
      cardId:entry.id ?? entry.cardId,
      definitionId:entry.definitionId,
      availableUnknownCount:0
    }));
    const anonymousCount = expectedAnonymousSlots(state.probabilityState, owner.id);
    if (anonymousCount > PROBABILITY_EPSILON) selections.push({
      zone:"hand",
      selectionKind:"unknown",
      cardId:null,
      definitionId:null,
      knownCardIds:selections.map((entry) => entry.cardId),
      availableUnknownCount:anonymousCount
    });
    return selections;
  }

  /*
  功能
  枚举破坏或掠夺目标的完整区域选择空间。

  调用方
  generate 的 plunder/destroy 分支。

  输入
  World 与资源拥有者。

  输出
  全部合法手牌选择，加上存在概率大于零的公开装备选择。

  读取状态
  getHandSelections 与装备当前字段。

  写入状态
  无。

  调用函数
  getHandSelections。

  边界与不变量
  区域和实体身份都在 Action 创建前确定；不按策略价值过滤。
  */
  getResourceSelections(state, owner) {
    const selections = this.getHandSelections(state, owner);
    if (owner?.equipmentDefinitionId
      && Number(owner.equipmentRetentionProbability ?? 1) > PROBABILITY_EPSILON) {
      selections.push({
        zone:"equipment",
        selectionKind:"equipment",
        cardId:null,
        definitionId:owner.equipmentDefinitionId,
        availableUnknownCount:0
      });
    }
    return selections;
  }

  /*
  功能
  枚举窥探至多两张手牌的已知实体与匿名位置组合。

  调用方
  generate 的 scout 分支。

  输入
  World 与被查看玩家。

  输出
  每个一至两张合法组合的 selection。

  读取状态
  getHandSelections。

  写入状态
  无。

  调用函数
  getHandSelections。

  边界与不变量
  已知实体不重复，匿名数量不超过当前有限池容量；不读取匿名牌身份。
  */
  getScoutSelections(state, owner) {
    const hand = this.getHandSelections(state, owner);
    const known = hand.filter((entry) => entry.selectionKind === "known");
    const anonymous = hand.find((entry) => entry.selectionKind === "unknown") ?? null;
    const selections = [];
    for (let first = 0; first < known.length; first += 1) {
      selections.push({
        selectionKind:"peek",
        cardIds:[known[first].cardId],
        unknownCount:0
      });
      for (let second = first + 1; second < known.length; second += 1) {
        selections.push({
          selectionKind:"peek",
          cardIds:[known[first].cardId, known[second].cardId],
          unknownCount:0
        });
      }
      if (anonymous) selections.push({
        selectionKind:"peek",
        cardIds:[known[first].cardId],
        unknownCount:1,
        knownCardIds:known.map((entry) => entry.cardId)
      });
    }
    const anonymousMaximum = Math.min(
      2,
      Math.ceil(Number(anonymous?.availableUnknownCount) || 0)
    );
    for (let count = 1; count <= anonymousMaximum; count += 1) selections.push({
      selectionKind:"peek",
      cardIds:[],
      unknownCount:count,
      knownCardIds:known.map((entry) => entry.cardId)
    });
    return selections;
  }

  /*
  功能
  从 canonical World 枚举完整合法 Action。

  调用方
  Controller 根候选与 Searcher 深层展开。

  输入
  World、当前行动者 ID 与可选 SearchBudget 诊断能力。

  输出
  target 与 selection 已完整的 canonical Action 数组。

  读取状态
  World 确定字段、Probability bounded query 与 Domain Rules。

  写入状态
  无。

  调用函数
  Domain Card/Skill Rules、createCompleteAction、deduplicateSearchEquivalentActions。

  边界与不变量
  动态距离只使用实时 alive ring；
  Generator 是唯一合法性与动作补全 owner；返回后 Searcher/Simulator 不得补 target 或 selection，
  transition 的概率资源消费仍由 Simulator owner 处理。
  */
  generate(state, playerId, searchBudget = null) {
    if (state.playPhaseEnded) return [];
    const actor = state.players.find((player) => player.id === playerId && player.alive);
    if (!actor) return [];
    const alive = state.players.filter((player) => player.alive).sort((a,b) => a.seatIndex - b.seatIndex);
    // Domain Rules 只接收 canonical data facts；Generator 保留原规则枚举顺序。
    const enemies = alive.filter((player) => player.battleTeam !== actor.battleTeam);
    const rulePlayers = projectRulePlayers(state.players);
    const actorRule = findPlayerFact(rulePlayers, actor.id);
    /*
    功能
    把当前 World 绑定成 Domain target rules 所需的概率距离 predicate。

    调用方
    generate 内的 card/skill/transfer/leverage target enumeration。

    输入
    Domain 投影的 source、target 与 range。

    输出
    布尔值。

    读取状态
    当前 generate 的 World。

    写入状态
    无。

    调用函数
    hasPossibleRangeWorld。

    边界与不变量
    只回答候选存在性；不为候选构造执行世界。
    */
    const isRangeLegal = (source, target, range) => this.hasPossibleRangeWorld(
      state, source, target, range
    );
    const actions = [];
    for (const held of actor.hand ?? []) {
      const definition = CARD_DEFINITIONS[held.definitionId];
      if (!definition || definition.usageMode === "response") continue;
      const card = { ...definition, ...held, id:held.id };
      const excludedTransferIds = card.definitionId === "transfer" && card.id
        ? new Set([card.id])
        : null;
      const transferRulePlayers = card.definitionId === "transfer"
        ? projectTransferRulePlayers(state.players, excludedTransferIds)
        : null;
      const transferActorRule = transferRulePlayers
        ? findPlayerFact(transferRulePlayers, actor.id)
        : null;
      const transferSourceIds = transferRulePlayers
        ? getTransferSourceIds(
            transferRulePlayers,
            transferActorRule,
            card,
            isRangeLegal
          )
        : null;
      const legality = canPlayCard({
        players:rulePlayers,
        sourceId:actor.id,
        currentPlayerId:actor.id,
        phase:state.phase,
        card,
        inHand:true,
        assaultUsage:projectAttackUsage(actor),
        recoverUsed:actor.recoverUsed ?? 0,
        recoverLimit:actor.recoverLimit ?? null,
        transferSourceIds,
        isRangeLegal
      });
      if (!legality.ok) continue;
      const usesRuleTargets = card.definitionId === "assault"
        || card.definitionId === "scout"
        || [
          "singleEnemy",
          "singleUnsealedEnemy",
          "singleAlly",
          "otherWithCards",
          "otherWithCardsOrEquipment"
        ].includes(card.targetType);
      const cardTargets = usesRuleTargets
        ? getCardTargetIds(rulePlayers, actorRule, card, isRangeLegal)
          .map((targetId) => state.players.find((player) => player.id === targetId))
          .filter(Boolean)
        : [];
      if (card.definitionId === "assault") {
        for (const target of cardTargets) {
          const action = this.createCompleteAction(
            state, actor, "card", card, [target], null, null, searchBudget
          );
          if (action) actions.push(action);
        }
        continue;
      }
      if (card.definitionId === "transfer") {
        for (const sourceId of transferSourceIds) {
          const source = state.players.find((player) => player.id === sourceId);
          const sourceRule = findPlayerFact(transferRulePlayers, sourceId);
          if (!source || !sourceRule) continue;
          const receiverIds = getTransferReceiverIds(
            transferRulePlayers,
            transferActorRule,
            sourceRule,
            card,
            isRangeLegal
          );
          for (const receiverId of receiverIds) {
            const receiver = state.players.find((player) => player.id === receiverId);
            if (!receiver) continue;
            for (const resource of this.getHandSelections(state, source, excludedTransferIds)) {
              const action = this.createCompleteAction(
                state,
                actor,
                "card",
                card,
                [],
                { sourceId:source.id, receiverId:receiver.id, ...resource },
                null,
                searchBudget
              );
              if (action) actions.push(action);
            }
          }
        }
        continue;
      }
      if (card.definitionId === "leverage") {
        const firstTargets = getLeverageFirstTargetIds(
          rulePlayers,
          actorRule,
          isRangeLegal
        ).map((targetId) => state.players.find((player) => player.id === targetId))
          .filter((firstTarget) => firstTarget
            && (firstTarget.equipmentRetentionProbability ?? 1) > PROBABILITY_EPSILON);
        for (const firstTarget of firstTargets) {
          const firstTargetRule = findPlayerFact(rulePlayers, firstTarget.id);
          const secondTargets = getAssaultTargetIds(
            rulePlayers,
            firstTargetRule,
            isRangeLegal
          ).map((targetId) => state.players.find((player) => player.id === targetId))
            .filter(Boolean);
          for (const secondTarget of secondTargets) {
            const action = this.createCompleteAction(
              state,
              actor,
              "card",
              card,
              [firstTarget, secondTarget],
              {
                firstTargetId:firstTarget.id,
                equipmentCardId:null,
                equipmentDefinitionId:firstTarget.equipmentDefinitionId,
                secondTargetId:secondTarget.id
              },
              null,
              searchBudget
            );
            if (action) actions.push(action);
          }
        }
        continue;
      }
      if (card.definitionId === "scout") {
        for (const target of cardTargets) {
          for (const selection of this.getScoutSelections(state, target)) {
            const action = this.createCompleteAction(
              state, actor, "card", card, [target], selection, null, searchBudget
            );
            if (action) actions.push(action);
          }
        }
      } else if (["singleEnemy","singleUnsealedEnemy"].includes(card.targetType)) {
        for (const target of cardTargets) {
          const action = this.createCompleteAction(
            state, actor, "card", card, [target], null, null, searchBudget
          );
          if (action) actions.push(action);
        }
      } else if (card.targetType === "singleAlly" || card.targetType === "otherWithCards") {
        for (const target of cardTargets) {
          const action = this.createCompleteAction(
            state, actor, "card", card, [target], null, null, searchBudget
          );
          if (action) actions.push(action);
        }
      }
      else if (card.targetType === "otherWithCardsOrEquipment") {
        for (const target of cardTargets) {
          for (const selection of this.getResourceSelections(state, target)) {
            const action = this.createCompleteAction(
              state, actor, "card", card, [target], selection, null, searchBudget
            );
            if (action) actions.push(action);
          }
        }
      } else {
        const targets = ["allEnemies","allLiving"].includes(card.targetType)
          ? (card.targetType === "allEnemies" ? enemies : alive)
          : [];
        const action = this.createCompleteAction(
          state, actor, "card", card, targets, null, null, searchBudget
        );
        if (action) actions.push(action);
      }
    }
    const skill = ACTIVE_SKILL_DEFINITIONS[actor.activeSkillId] ?? null;
    const skillLegality = skill ? canUseSkillBase({
      players:rulePlayers,
      sourceId:actor.id,
      currentPlayerId:actor.id,
      phase:state.phase,
      skill,
      used:actor.activeSkillUses ?? 0,
      limitPerTurn:actor.activeSkillLimit ?? skill.limitPerTurn ?? 1,
      energy:actor.energy,
      minimumEnergy:getSkillCost(skill, actor, state.players)
    }) : { ok:false };
    if (skill && skillLegality.ok) {
      const skillRuleTargetIds = skill.rangeRule
        ? getSkillTargetIds(rulePlayers, actor.id, skill, isRangeLegal)
        : [];
      let targets = skillRuleTargetIds
        .map((targetId) => state.players.find((player) => player.id === targetId))
        .filter(Boolean);
      if (skill.id === "hunt") {
        const ruleTargetIds = new Set(skillRuleTargetIds);
        targets = enemies.filter((player) => ruleTargetIds.has(player.id)
          || player.huntMarkSourceId === actor.id);
      }
      if (["none","allEnemies"].includes(skill.targetType)) {
        const action = this.createCompleteAction(
          state,
          actor,
          "skill",
          skill,
          skill.targetType === "allEnemies" ? enemies : [],
          null,
          getSkillCost(skill, actor, state.players),
          searchBudget
        );
        if (action) actions.push(action);
      } else {
        for (const target of targets) {
          const action = this.createCompleteAction(
            state,
            actor,
            "skill",
            skill,
            [target],
            null,
            getSkillCost(skill, actor, state.players),
            searchBudget
          );
          if (action) actions.push(action);
        }
      }
    }
    actions.push(createAction({ type:"end", actorId:actor.id }));
    const uniqueActions = deduplicateSearchEquivalentActions(actions);
    searchBudget?.observeActionGeneration?.({
      physicalCandidates:actions.length,
      uniqueCandidates:uniqueActions.length
    });
    return uniqueActions;
  }

  /*
  功能
  判断完整 selection 在当前 World 中是否至少存在一个可用世界。

  调用方
  createCompleteAction。

  输入
  World、selection 与目标 ID。

  输出
  可能存在返回 true，否则返回 false。

  读取状态
  selection 指定资源、资源 availability、ProbabilityState 匿名桶与装备保留概率。

  写入状态
  无。

  调用函数
  queryAnonymousSlotDistribution。

  边界与不变量
  只验证 Generator 已展开的一个完整 selection；不得组合资源分支、改选、评分或制造替代 selection。
  */
  isSelectionPossible(state, selection, targetIds) {
    if (!selection) return true;
    const ownerId = selection.sourceId ?? targetIds?.[0] ?? null;
    const owner = state.players.find((player) => player.id === ownerId) ?? null;
    if (!owner) return false;
    const selectedCardIds = [
      ...(selection.cardId ? [selection.cardId] : []),
      ...(Array.isArray(selection.cardIds) ? selection.cardIds : [])
    ];
    const resources = [
      ...(Array.isArray(owner.hand) ? owner.hand : []),
      ...(Array.isArray(owner.knownCards) ? owner.knownCards : [])
    ];
    const knownPossible = selectedCardIds.every((selectedCardId) => resources.some((entry) => (
      (entry.id ?? entry.cardId) === selectedCardId
      && cardAvailability(entry) > PROBABILITY_EPSILON
    )));
    if (!knownPossible) return false;
    const anonymousCount = selection.selectionKind === "unknown"
      ? 1
      : Math.max(0, Math.floor(Number(selection.unknownCount) || 0));
    if (anonymousCount > 0 && !queryAnonymousSlotDistribution(
      state.probabilityState,
      owner.id
    ).some((branch) => (
      branch.count >= anonymousCount && branch.probability > PROBABILITY_EPSILON
    ))) return false;
    if (selection.zone === "equipment") return owner.equipmentDefinitionId === selection.definitionId
      && Number(owner.equipmentRetentionProbability ?? 1) > PROBABILITY_EPSILON;
    return true;
  }

  /*
  功能
  判断距离或延迟状态约束是否至少允许一个动作世界。

  调用方
  createCompleteAction。

  输入
  World、行动者、动作类型、卡牌或技能定义、目标实体与 selection。

  输出
  可能执行返回 true，否则返回 false。

  读取状态
  攻击距离、猎印、封印、闪电和转移/借势公开条件。

  写入状态
  无。

  调用函数
  Probability 的距离合法概率与 status-presence bounded query。

  边界与不变量
  这里只判断候选存在性，不组合条件世界、不重新判断 Evaluator 价值或模拟执行。
  */
  isActionConditionPossible(state, actor, type, definition, targets, selection) {
    if (type === "skill") {
      if (definition.id === "hunt") {
        const target = targets?.[0];
        const markProbability = target?.huntMarkProbabilities?.[actor.id]
          ?? (target?.huntMarkSourceId === actor.id ? 1 : 0);
        return markProbability > PROBABILITY_EPSILON;
      }
      if (definition.rangeRule === "attack" || definition.rangeRule === "fixed") {
        const target = targets?.[0];
        return getRangeLegalityProbability(
          { state },
          actor,
          target,
          definition.rangeRule === "attack" ? actor.attackRange : definition.range
        ) > PROBABILITY_EPSILON;
      }
      return true;
    }

    const card = definition;
    if (card.definitionId === "lightning") {
      return statusPresence(actor, "lightning").probability < 1 - PROBABILITY_EPSILON;
    }
    if (card.definitionId === "seal") {
      const target = state.players.find((player) => player.id === targets?.[0]?.id);
      return statusPresence(target, "sealed").probability < 1 - PROBABILITY_EPSILON;
    }
    if (card.definitionId === "transfer") {
      const source = state.players.find((player) => player.id === selection?.sourceId);
      const receiver = state.players.find((player) => player.id === selection?.receiverId);
      return getRangeConditionBranches({ state }, [
        { source:actor, target:source, range:card.effectRange },
        { source:actor, target:receiver, range:card.effectRange }
      ]).some((branch) => branch.matches && branch.probability > PROBABILITY_EPSILON);
    }
    if (card.definitionId === "leverage") {
      const first = state.players.find((player) => player.id === selection?.firstTargetId);
      const second = state.players.find((player) => player.id === selection?.secondTargetId);
      return getRangeConditionBranches({ state }, {
        source:first,
        target:second,
        range:first?.attackRange ?? 1
      }, {
        equipmentRequirements:[{
          player:first,
          definitionId:selection?.equipmentDefinitionId,
          present:true
        }]
      }).some((branch) => branch.matches && branch.probability > PROBABILITY_EPSILON);
    }
    const target = targets?.[0];
    if (card.definitionId === "assault" && target) {
      return getRangeLegalityProbability(
        { state }, actor, target, actor.attackRange ?? 1
      ) > PROBABILITY_EPSILON;
    }
    if (!card.ignoresDistance && card.effectRange != null && target) {
      return getRangeLegalityProbability(
        { state }, actor, target, card.effectRange
      ) > PROBABILITY_EPSILON;
    }
    return true;
  }

  /*
  功能
  在首次创建 Action 前确认目标与选择仍可能成立，并排除 AI 专属候选禁令。

  调用方
  generate 的每个规则合法候选。

  输入
  World、行动者角色与阵营、动作类型、卡牌或技能定义、目标实体、selection、能量费用与可选 SearchBudget。

  输出
  target 与 selection 完整的 canonical Action；无可能世界时返回 null。

  读取状态
  只读局部动作语义、World 普通字段与 bounded Probability query。

  写入状态
  无；只在全部字段确定后调用一次 createAction。

  调用函数
  isActionConditionPossible、isSelectionPossible 与 createAction。

  边界与不变量
  Generator 只判断 possible/impossible，不计算联合概率、次数槽或执行世界；
  非调律师不得生成破坏队友手牌的 Action，敌方手牌、队友装备与调律师例外保持可生成；
  所有 AI 不得生成己方来源向敌方接收者转移手牌的 Action，其它 Domain 合法方向保持可生成；
  返回后 Searcher/Simulator 不得补 target、selection 或重新创建另一种 Action。
  */
  createCompleteAction(
    state,
    actor,
    type,
    definition,
    targets = [],
    selection = null,
    energyCost = null,
    searchBudget = null
  ) {
    const targetIds = targets.map((target) => target.id);
    const target = targets[0] ?? null;
    // 调律师可能通过协调从队友资源损失中获益；其余 AI 不搜索破坏队友手牌的分支。
    if (definition.definitionId === "destroy"
      && actor.characterId !== "resonance-tuner"
      && target?.battleTeam === actor.battleTeam
      && selection?.zone === "hand") return null;
    // AI 不搜索把己方手牌送给敌方的转移分支；真人合法性仍由 Domain Rules 独立决定。
    if (definition.definitionId === "transfer") {
      const source = state.players.find((player) => player.id === selection?.sourceId) ?? null;
      const receiver = state.players.find((player) => player.id === selection?.receiverId) ?? null;
      if (source?.battleTeam === actor.battleTeam
        && receiver?.battleTeam !== actor.battleTeam) return null;
    }
    if (!this.isActionConditionPossible(
      state, actor, type, definition, targets, selection
    ) || !this.isSelectionPossible(state, selection, targetIds)) return null;
    if (type === "card") {
      if (cardAvailability(definition) <= PROBABILITY_EPSILON) return null;
      return createAction({
        type:"card",
        actorId:actor.id,
        cardId:definition.definitionId,
        cardInstanceId:definition.id ?? null,
        targetIds,
        selection
      });
    }

    const minimumEnergy = definition.id === "allIn"
      ? 1
      : energyCost ?? getSkillCost(definition, actor);
    return createAction({
      type:"skill",
      actorId:actor.id,
      skillId:definition.id,
      targetIds,
      selection,
      energyCost:minimumEnergy
    });
  }
}
