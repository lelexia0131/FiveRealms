/*
模块职责
把真实响应窗口投影为不含 Game 引用的 DecisionContext，并委托正式 ResponsePolicy。

上游
AIController、ResponseWorkflow 与边界专项测试。

下游
policy/ResponsePolicy、ValueSimulationQuery、状态组合与既有 Domain/Value 查询。

状态边界
只读当前 GameState；状态投影和模拟查询均在 Policy 外完成，绝不修改真实状态。

信息边界
只向 Policy 提供公开玩家视图、响应者自己的牌定义、合法记忆、Belief 与纯数值查询结果。

架构约束
本文件是唯一响应执行边界；不得保留第二份响应阈值、分数或选择公式。
*/
import { AI_RUNTIME_POLICY } from "./AiRuntimePolicy.js";
import { assessGlobalBenefit } from "../value/GlobalBenefitValue.js";
import { createInitialSearchState } from "../state/StateContracts.js";
import { ValueSimulationQuery } from "../simulation/ValueSimulationQuery.js";
import {
  hasLightning,
  nextLightningReceiverId
} from "../domain/LightningModel.js";
import {
  hasSeal,
  tacticJudgmentProbability
} from "../domain/SealModel.js";
import { turnOpportunityValue } from "../value/ThreatValue.js";
import { ResponsePolicy } from "./ResponsePolicy.js";
import { getCharacterRoleTags } from "./CharacterRoleMetadata.js";

/*
功能
把真实或过滤 Player 转成响应 Policy 可读的公开 plain object。

调用方
ResponseBoundary.buildDecisionContext。

输入
Player 或玩家快照。

输出
不含 hand 实体和 Game 引用的公开响应视图。

读取状态
公开生命、护盾、能量、阵营、角色、状态、装备和手牌数量。

写入状态
无。

调用函数
无。

边界与不变量
其他玩家真实 hand definitionId 永不进入输出；响应者自己的合法定义另行显式提供。
*/
function responsePlayerView(player) {
  if (!player) return null;
  return {
    id: player.id,
    seatIndex: player.seatIndex,
    alive: Boolean(player.alive),
    battleTeam: player.battleTeam,
    controllerType: player.controllerType,
    characterId: player.characterId ?? player.character?.id ?? null,
    roleTags: [...(player.roleTags ?? getCharacterRoleTags(player.characterId ?? player.character?.id))],
    tags: [...(player.tags ?? [])],
    hp: Number(player.hp ?? 0),
    maxHp: Number(player.maxHp ?? player.hp ?? 0),
    shield: Number(player.shield ?? 0),
    energy: Number(player.energy ?? 0),
    handCount: Number(player.handCount ?? player.hand?.length ?? 0),
    hasEquipment: Boolean(player.equipment ?? player.equipmentDefinitionId),
    equipmentDefinitionId: player.equipment?.definitionId
      ?? player.equipmentDefinitionId
      ?? null,
    statuses: Array.isArray(player.statuses)
      ? [...player.statuses]
      : { ...(player.statuses ?? {}) },
    passiveSkillIds: [...(player.character?.passiveSkillIds ?? [])],
    momentum: Number(player.turnFlags?.momentum ?? player.momentum ?? 0),
    assaultBonus: Number(player.statuses?.allIn?.assaultBonus ?? player.assaultBonus ?? 0),
    guardianAidUsed: Boolean(
      player.turnFlags?.guardianAidUsed
      ?? ((player.guardianAidUsedProbability ?? 0) >= 1)
    )
  };
}

export class ResponseBoundary {
  /*
  功能
  绑定真实响应边界、正式 ResponsePolicy 与窄 simulation query。

  调用方
  AIController 组合根（统一组装依赖的位置） 与直接测试。

  输入
  runtime capabilities、Evaluator、Knowledge 及可选正式依赖。

  输出
  建立稳定的 shouldRespond 执行边界。

  读取状态
  保存显式依赖。

  写入状态
  写实例依赖字段。

  调用函数
  ResponsePolicy、ValueSimulationQuery 构造函数。

  边界与不变量
  生产装配由 Controller 注入正式实例；未注入时构造同一依赖，保证边界可独立测试。
  */
  constructor(runtime, evaluator, knowledge, dependencies = {}) {
    for (const name of ["getState", "getDyingRescueOrder", "isSmallTeam"]) {
      if (typeof runtime?.[name] !== "function") {
        throw new TypeError(`ResponseBoundary 缺少依赖：${name}`);
      }
    }
    this.getState = runtime.getState;
    this.getDyingRescueOrder = runtime.getDyingRescueOrder;
    this.isSmallTeam = runtime.isSmallTeam;
    this.forceAiRescueHuman = runtime.forceAiRescueHuman;
    this.evaluator = evaluator;
    this.knowledge = knowledge;
    this.responsePolicy = dependencies.responsePolicy ?? new ResponsePolicy({
      assessGlobalBenefit
    });
    this.simulationQuery = dependencies.simulationQuery
      ?? new ValueSimulationQuery(evaluator);
    this.stateValue = dependencies.stateValue ?? evaluator;
  }

  /*
  功能
  把真实响应参数转换成正式 Policy 的 plain DecisionContext。

  调用方
  shouldRespond、assessDyingRescue 与响应专项查询。

  输入
  响应者、响应类型、真实公开上下文和合法响应卡数组。

  输出
  不含 Game/Simulator 引用且只暴露合法信息的 DecisionContext。

  读取状态
  当前 GameState、Knowledge、TeamRules、DyingWorkflow 与显式 Value/Domain query。

  写入状态
  只有被调用的未知位置/状态查询可能写 query 私有缓存；真实状态不变。

  调用函数
  responsePlayerView、createInitialSearchState、ValueSimulationQuery 与既有 Domain/Value 辅助函数。

  边界与不变量
  所有昂贵查询惰性执行且每个响应分支至多一次；状态反制只为同阵营 holder 进入价值比较。
  */
  buildDecisionContext(responder, type, rawContext, cards = []) {
    const rawPlayers = this.getState().players;
    const players = rawPlayers.map(responsePlayerView);
    const byId = new Map(players.map((player) => [player.id, player]));
    const responderView = byId.get(responder.id);
    const publicContext = {
      ...rawContext,
      target: byId.get(rawContext.target?.id) ?? null,
      source: byId.get(rawContext.source?.id) ?? null,
      rootSource: byId.get(rawContext.rootSource?.id) ?? null,
      statusCounterContext: rawContext.statusCounterContext
        ? { ...rawContext.statusCounterContext }
        : null
    };
    let remainingCardCounts;
    /*
    功能
    在一次响应决策内惰性读取并复用同一份 Belief remaining counts。

    调用方
    buildDecisionContext 的状态、guardian 与 dynamic query 闭包。

    输入
    无；闭包捕获当前 responder。

    输出
    Knowledge 返回的剩余牌计数。

    读取状态
    Knowledge 与观察者合法信息。

    写入状态
    只写本次 DecisionContext 构造的局部缓存。

    调用函数
    Knowledge.remainingCounts。

    边界与不变量
    同一响应窗口最多计算一次，不跨决策复用或暴露真实未知牌。
    */
    const getRemainingCardCounts = () => {
      if (remainingCardCounts === undefined) {
        remainingCardCounts = this.knowledge.remainingCounts(responder);
      }
      return remainingCardCounts;
    };
    const needsRemainingCounts = type === "counter" || type === "skill" || type === "dyingRescue";
    if (needsRemainingCounts) getRemainingCardCounts();
    const rescueOrder = type === "dyingRescue"
      ? this.getDyingRescueOrder(rawContext.target ?? responder)
          .map((player) => byId.get(player.id))
          .filter(Boolean)
      : [];
    return {
      responder: responderView,
      responseType: type,
      context: publicContext,
      cards,
      players,
      rescueOrder,
      responderHandDefinitionIds: (responder.hand ?? [])
        .map((card) => card.definitionId),
      knownCardsByPlayer: responder.aiMemory.knownCardsByPlayer,
      recoverDensity: type === "dyingRescue"
        ? this.knowledge.probability(responder, "recover")
        : 0,
      remainingCardCounts: needsRemainingCounts ? remainingCardCounts : null,
      isSmallTeam: this.isSmallTeam(responder),
      forceAiRescueHuman: this.forceAiRescueHuman ?? AI_RUNTIME_POLICY.forceAiRescueHuman,
      leverageMetrics: () => {
        const target = rawContext.target ?? responder;
        const enemyTarget = target.battleTeam !== responder.battleTeam;
        const visible = createInitialSearchState(responder.id, this.getState());
        const visibleResponder = visible.players.find((player) => player.id === responder.id);
        const visibleTarget = visible.players.find((player) => player.id === target.id);
        const threat = enemyTarget && visibleResponder && visibleTarget
          ? this.evaluator.threatPriority(
              visibleResponder,
              visibleTarget,
              responder.aiMemory,
              1
            )
          : 0;
        const blockRisk = Math.min(
          .85,
          (target.hand?.length ?? 0) * this.knowledge.probability(responder, "block")
        );
        return { threat, blockRisk };
      },
      guardianAidValues: () => {
        const target = rawContext.target;
        const visible = createInitialSearchState(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        return this.simulationQuery.guardianAidValues(
          visible,
          responder.id,
          target.id,
          rawContext.source?.id ?? null,
          Math.max(0, Number(rawContext.amount) || 0),
          this.stateValue
        );
      },
      lightningCounterTerms: () => {
        const holder = rawPlayers.find((player) => (
          player.id === rawContext.statusCounterContext?.holderId && player.alive
        ));
        // 反制会让 holder 跳过本次判定并立即转移闪电，敌方 holder 不能进入 AI 的价值比较。
        if (!holder || !hasLightning(holder) || holder.battleTeam !== responder.battleTeam) {
          return { valid: false, noCounterBurden: 0, withCounterBurden: 0 };
        }
        const state = createInitialSearchState(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        const visibleHolder = state.players.find((player) => player.id === holder.id);
        const receiverId = nextLightningReceiverId(rawPlayers, holder);
        const visibleReceiver = state.players.find((player) => player.id === receiverId);
        return {
          valid: true,
          noCounterBurden: this.evaluator.lightningTeamBurden(
            state,
            visibleHolder,
            responder.id
          ),
          withCounterBurden: visibleReceiver
            ? this.evaluator.lightningTransferredBurden(
                state,
                visibleHolder,
                visibleReceiver,
                responder.id
              )
            : 0
        };
      },
      sealCounterTerms: () => {
        const holder = rawPlayers.find((player) => (
          player.id === rawContext.statusCounterContext?.holderId && player.alive
        ));
        if (!holder || !hasSeal(holder) || holder.battleTeam !== responder.battleTeam) {
          return { valid: false, preventedBurden: 0 };
        }
        const skipProbability = 1 - tacticJudgmentProbability(getRemainingCardCounts());
        return {
          valid: true,
          preventedBurden: skipProbability * turnOpportunityValue(holder)
        };
      },
      dynamicRootFlipGain: () => {
        const rootCard = rawContext.rootCard ?? rawContext.card;
        if (!rootCard?.definitionId || rootCard.category !== "tactic") return null;
        const rootSourceId = rawContext.rootSourceId
          ?? rawContext.rootSource?.id
          ?? rawContext.source?.id
          ?? null;
        const visible = createInitialSearchState(
          responder.id,
          this.getState(),
          getRemainingCardCounts()
        );
        return this.simulationQuery.dynamicRootFlipGain(
          visible,
          responder.id,
          rootCard,
          rootSourceId,
          rawContext.counterDepth ?? 0,
          Array.isArray(rawContext.rootTargetIds) ? rawContext.rootTargetIds : [],
          { publicTransferContext: rawContext.publicTransferContext ?? null },
          this.stateValue
        );
      }
    };
  }

  /*
  功能
  评估濒死救援并委托正式 ResponsePolicy。

  调用方
  直接救援策略测试。

  输入
  响应者与濒死目标真实实体。

  输出
  正式 Policy 的救援 assessment object。

  读取状态
  当前救援顺序、合法记忆与 recover density。

  写入状态
  无。

  调用函数
  buildDecisionContext、ResponsePolicy.assessDyingRescue。

  边界与不变量
  不保留第二份救援评分公式。
  */
  assessDyingRescue(responder, target) {
    const decision = this.buildDecisionContext(
      responder,
      "dyingRescue",
      { target },
      []
    );
    return this.responsePolicy.assessDyingRescue({
      responder: decision.responder,
      target: decision.context.target,
      rescueOrder: decision.rescueOrder,
      responderHandDefinitionIds: decision.responderHandDefinitionIds,
      knownCardsByPlayer: decision.knownCardsByPlayer,
      recoverDensity: decision.recoverDensity,
      remainingCardCounts: decision.remainingCardCounts
    });
  }

  /*
  功能
  评估突袭加伤预览并委托正式 ResponsePolicy。

  调用方
  直接测试与正式调用方。

  输入
  真实公开 response context。

  输出
  非负已知加伤。

  读取状态
  仅公开 source 状态。

  写入状态
  无。

  调用函数
  responsePlayerView、ResponsePolicy.knownPendingAssaultBonus。

  边界与不变量
  不触发真实伤害监听器。
  */
  knownPendingAssaultBonus(context) {
    return this.responsePolicy.knownPendingAssaultBonus({
      ...context,
      source: responsePlayerView(context.source)
    });
  }

  /*
  功能
  将真实响应窗口委托给正式 ResponsePolicy。

  调用方
  AIController 与 ResponseWorkflow。

  输入
  响应者、响应类型、公开上下文和合法 Cards。

  输出
  是否响应的布尔值。

  读取状态
  通过 buildDecisionContext 读取当前合法/公开信息。

  写入状态
  无；simulation query 只写独立 clone 或私有缓存。

  调用函数
  buildDecisionContext、ResponsePolicy.shouldRespond。

  边界与不变量
  边界不增加阈值、重排或 fallback 决策。
  */
  shouldRespond(responder, type, context, cards = []) {
    return this.responsePolicy.shouldRespond(
      this.buildDecisionContext(responder, type, context, cards)
    );
  }

  /*
  功能
  评估护援专项响应并走同一 ResponsePolicy 决策。

  调用方
  护援直接回归测试。

  输入
  守誓者与公开伤害上下文。

  输出
  是否使用护援。

  读取状态
  当前 GameState、Knowledge 与窄 simulation query。

  写入状态
  无。

  调用函数
  shouldRespond。

  边界与不变量
  与 ResponseWorkflow 的 skill 分支完全共用一份策略。
  */
  shouldUseGuardianAid(responder, context) {
    return this.shouldRespond(responder, "skill", context, []);
  }

  /*
  功能
  评估闪电状态反制的专项入口。

  调用方
  正式调用方。

  输入
  响应者与含 lightning statusCounterContext 的上下文。

  输出
  是否反制。

  读取状态
  当前状态、Belief、Lightning Domain 与 Value query。

  写入状态
  无。

  调用函数
  shouldRespond。

  边界与不变量
  不保留第二份 burden 比较。
  */
  shouldCounterLightning(responder, context) {
    return this.shouldRespond(responder, "counter", context, []);
  }

  /*
  功能
  评估封印状态反制的专项入口。

  调用方
  正式调用方。

  输入
  响应者与含 sealed statusCounterContext 的上下文。

  输出
  是否反制。

  读取状态
  当前状态、Belief 与 Seal Domain/Policy query。

  写入状态
  无。

  调用函数
  shouldRespond。

  边界与不变量
  不保留第二份判定概率或机会成本。
  */
  shouldCounterSeal(responder, context) {
    return this.shouldRespond(responder, "counter", context, []);
  }

  /*
  功能
  经正式 Policy 与窄 query 评估动态 root 反制。

  调用方
  正式调用方。

  输入
  响应者与当前 response root context。

  输出
  是否追加反制。

  读取状态
  当前过滤 response state 与 State Value。

  写入状态
  仅窄 query 的独立模拟 clone。

  调用函数
  shouldRespond。

  边界与不变量
  不 import 或构造 具体 Simulator，不建立第二套 ResponseSimulation。
  */
  dynamicRootCounterDecision(responder, context) {
    return this.shouldRespond(responder, "counter", context, []);
  }
}
