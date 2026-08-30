/*
模块职责
唯一拥有真实对局能量与实体牌区移动的 Application sequencing，包括事件、版本、知识失效和展示顺序。

上游
Match/Turn/Action/Combat workflows 与 composition root。

下游
Domain resource/zone transitions、zone queries 与显式 presentation/knowledge capabilities。

状态边界
只通过 Domain transitions 写能量、牌区和 handVersion；不写规则定义或 AI World。

信息边界
私密牌知识只经注入 knowledge adapter 更新；公开日志不得泄露未知牌名。

架构约束
不得持有 composition root、UIManager、AIController 或规则 literal；跨 await 后必须复核 session 与实体位置。
*/
import { appendCardToZone, commitEquipmentReplacement, discardEquipment as commitDiscardEquipment, moveCardBetweenZones, moveCardsAtomically, moveEquipmentToHand as commitMoveEquipmentToHand, purgeCardToDiscard, removeCardFromZone } from "../../domain/state/transitions/ZoneTransitions.js";
import { changeEnergy } from "../../domain/state/transitions/ResourceTransitions.js";
import { bumpHandVersion } from "../../domain/state/transitions/PlayerStateTransitions.js";
import { getCardZoneOccurrences, isCardCommittedToDiscard, isCardCommittedToEquipment } from "../../domain/state/queries/ZoneQueries.js";
import { RESPONSE_STATUS } from "../response/ResponseResult.js";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "emitEvent", "log", "queueFeedback", "render",
  "syncDeckAliases", "knowledge", "getActionWorkflow", "getPublicPoolCards", "trace"
];

/*
功能
创建一局对战的资源与牌区工作流。

调用方
composition root。

输入
当前 state、事件、展示、知识、action resolution 与牌池的窄能力。

输出
冻结的资源工作流方法集合。

读取状态
只经 getState 读取当前真实 MatchState。

写入状态
只经 Domain transitions 写能量、牌区和 handVersion。

调用函数
ResourceTransitions、ZoneTransitions、ZoneQueries 与注入能力。

边界与不变量
实体牌在规则区域中必须唯一；所有异步移动在提交前复核 session 和实体位置。
*/
export function createResourceWorkflow(runtime) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!runtime?.[name]) throw new TypeError(`ResourceWorkflow 缺少 ${name} capability`);
  }
  /*
  功能
  读取当前真实 MatchState。

  调用方
  本工作流内所有资源与牌区操作。

  输入
  无。

  输出
  当前 MatchState entity。

  读取状态
  runtime 的 getState capability。

  写入状态
  无。

  调用函数
  runtime.getState。

  边界与不变量
  每次调用都读取当前状态，不缓存可能在 await 后过期的引用。
  */
  const state = () => runtime.getState();
  /*
  功能
  判断异步资源操作所属对局会话是否仍有效。

  调用方
  本工作流内所有异步提交边界。

  输入
  操作开始时捕获的 gameId。

  输出
  会话仍有效时返回 true。

  读取状态
  runtime 的会话有效性状态。

  写入状态
  无。

  调用函数
  runtime.isSessionValid。

  边界与不变量
  旧局 Promise 恢复后必须返回 false，阻止继续提交或刷新。
  */
  const active = (gameId) => runtime.isSessionValid(gameId);
  const resource = {
    /*
    功能
    经可取消事件与 Domain transition 为存活玩家增加能量。

    调用方
    回合、卡牌、技能与被动效果结算。

    输入
    Player entity、请求增量及 reason/card/skill context。

    输出
    Promise<number>，返回实际增加量。

    读取状态
    当前 session、game-over、player.alive 与能量上限。

    写入状态
    经 changeEnergy 写玩家能量，并写日志、反馈与展示。

    调用函数
    emitEvent、changeEnergy、log、queueFeedback、render。

    边界与不变量
    beforeGainEnergy 可取消或调整数量；await 后先复核会话，实际数量由 Domain clamp。
    */
    async gainEnergy(player, amount, context = {}) {
      const gameId = state().gameId;
      if (!active(gameId) || !player?.alive || state().isGameOver) return 0;
      const event = { type:"beforeGainEnergy", player, amount, reason:context.reason ?? "效果", card:context.card ?? null, skill:context.skill ?? null, cancelled:false, metadata:{} };
      await runtime.emitEvent("beforeGainEnergy", event);
      if (!active(gameId) || event.cancelled) return 0;
      const actualAmount = changeEnergy(state(), player, event.amount);
      if (actualAmount > 0) {
        const message = event.reason === "回合开始"
          ? `${player.name}在回合开始时获得${actualAmount}点能量。`
          : event.reason === "聚能"
            ? `${player.name}使用「聚能」，获得${actualAmount}点能量。`
            : event.reason === "余烬"
              ? `${player.name}触发「余烬」，获得${actualAmount}点能量。`
              : `${player.name}通过${event.reason}获得${actualAmount}点能量。`;
        runtime.log(message);
        runtime.queueFeedback("energy", player.id, actualAmount);
      }
      await runtime.emitEvent("afterGainEnergy", { ...event, type:"afterGainEnergy", actualAmount });
      if (active(gameId)) runtime.render();
      return actualAmount;
    },

    /*
    功能
    按牌堆顺序逐张把牌移动到玩家手牌。

    调用方
    回合摸牌、卡牌、技能、被动与击杀奖励流程。

    输入
    Player entity、请求张数、原因与 silent 选项。

    输出
    Promise<number>，返回实际摸牌张数。

    读取状态
    当前 session、牌堆、resolving 区与玩家存活状态。

    写入状态
    deck/resolving/hand zones、handVersion、知识、反馈与展示。

    调用函数
    Deck draw/resolve API、appendCardToZone、bumpHandVersion、emitEvent。

    边界与不变量
    保持逐张事件顺序；取消移动的牌回到牌堆，实体不得同时存在于两个区域。
    */
    async drawCards(player, count, reason = "摸牌", options = {}) {
      const gameId = state().gameId;
      if (!active(gameId) || !player?.alive || state().isGameOver) return 0;
      let drawn = 0;
      for (let index = 0; index < count; index += 1) {
        const card = state().deck.drawOne(state());
        runtime.syncDeckAliases();
        if (!card) break;
        if (!state().deck.beginResolve(state(), card)) break;
        runtime.syncDeckAliases();
        const move = { type:"beforeCardMove", card, from:"deck", to:"hand", player, reason, cancelled:false };
        await runtime.emitEvent("beforeCardMove", move);
        if (!active(gameId)) return drawn;
        if (move.cancelled) {
          state().deck.finishResolveToEquipment(state(), card);
          appendCardToZone(state(), state().deck.cards, card);
          runtime.syncDeckAliases();
          continue;
        }
        if (!state().deck.finishResolveToEquipment(state(), card)) return drawn;
        appendCardToZone(state(), player.hand, card);
        bumpHandVersion(state(), player);
        runtime.knowledge.invalidate(card.id, player.id);
        drawn += 1;
        await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
        if (!active(gameId)) return drawn;
      }
      if (drawn) {
        if (!options.silent) runtime.log(`${player.name}摸了${drawn}张牌。`);
        runtime.queueFeedback("draw", player.id, drawn);
      }
      runtime.render();
      return drawn;
    },

    /*
    功能
    把指定手牌实体移动到弃牌堆。

    调用方
    弃牌、响应费用、技能费用与阵亡清理流程。

    输入
    Player、当前手牌 Card entity、原因与 logReason/silent 选项。

    输出
    Promise<boolean>，仅成功提交移动时为 true。

    读取状态
    当前 session、player.hand 与弃牌堆。

    写入状态
    hand/discard zones、handVersion、知识、反馈与展示。

    调用函数
    emitEvent、moveCardBetweenZones、bumpHandVersion、knowledge.invalidate。

    边界与不变量
    beforeCardMove 后重新验证同一实体仍在手牌；取消或旧会话不产生移动。
    */
    async discardCardFromHand(player, card, reason = "弃置", options = {}) {
      const gameId = state().gameId;
      if (!active(gameId) || player.hand.indexOf(card) < 0) return false;
      const move = { type:"beforeCardMove", card, from:"hand", to:"discard", player, reason, cancelled:false };
      await runtime.emitEvent("beforeCardMove", move);
      if (!active(gameId) || move.cancelled || player.hand.indexOf(card) < 0) return false;
      moveCardBetweenZones(state(), player.hand, state().deck.discardPile, card);
      bumpHandVersion(state(), player);
      runtime.knowledge.invalidate(card.id, player.id);
      runtime.syncDeckAliases();
      if (!options.silent) runtime.log(`${player.name}因${options.logReason ?? reason}弃置了「${card.name}」。`);
      runtime.queueFeedback("discard", player.id);
      await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
      if (active(gameId)) runtime.render();
      return true;
    },

    /*
    功能
    将一组指定手牌实体作为一次响应费用原子移入弃牌堆。

    调用方
    ResponseWorkflow 的格挡、反制与救援支付路径。

    输入
    Player、Card entity 数组、支付原因与 expectedCount/silent 选项。

    输出
    Promise<冻结响应结果>，状态为 used、invalid 或 cancelled。

    读取状态
    当前 session、玩家存活状态及全部牌区中的实体位置。

    写入状态
    成功时原子写 hand/discard zones，并只推进一次 handVersion。

    调用函数
    emitEvent、moveCardsAtomically、bumpHandVersion、knowledge.invalidate。

    边界与不变量
    数量、引用和 ID 必须唯一；任一事件取消或实体位置变化都不得部分支付。
    */
    async payCardsFromHandAtomically(player, cards, reason = "响应支付", options = {}) {
      const gameId = state().gameId;
      const selected = Array.isArray(cards) ? [...cards] : [];
      const expectedCount = options.expectedCount ?? selected.length;
      /*
      功能
      创建无已支付卡牌的非法响应结果。

      调用方
      payCardsFromHandAtomically 的输入与提交校验分支。

      输入
      无。

      输出
      冻结的 INVALID 响应结果。

      读取状态
      RESPONSE_STATUS.INVALID。

      写入状态
      无。

      调用函数
      Object.freeze。

      边界与不变量
      结果的 cards 始终为空，不暗示已发生部分支付。
      */
      const invalid = () => Object.freeze({ status:RESPONSE_STATUS.INVALID, cards:[] });
      /*
      功能
      创建无已支付卡牌的会话取消结果。

      调用方
      payCardsFromHandAtomically 的 session 失效分支。

      输入
      无。

      输出
      冻结的 CANCELLED 响应结果。

      读取状态
      RESPONSE_STATUS.CANCELLED。

      写入状态
      无。

      调用函数
      Object.freeze。

      边界与不变量
      结果的 cards 始终为空，不把旧局支付结果带入新局。
      */
      const cancelled = () => Object.freeze({ status:RESPONSE_STATUS.CANCELLED, cards:[] });
      if (!active(gameId)) return cancelled();
      if (!player?.alive || state().isGameOver || expectedCount <= 0 || selected.length !== expectedCount) return invalid();
      if (new Set(selected).size !== selected.length
        || new Set(selected.map((card) => card?.id)).size !== selected.length
        || selected.some((card) => !card?.id)) return invalid();
      /*
      功能
      复核全部待支付实体仍只位于付款者手牌。

      调用方
      payCardsFromHandAtomically 在事件前后及最终提交前调用。

      输入
      无；读取闭包中的 player 与 selected。

      输出
      全部实体可原子提交时返回 true。

      读取状态
      玩家手牌、牌堆、弃牌堆、结算区、判定区、公开池与装备区。

      写入状态
      无。

      调用函数
      Array.every/includes/some。

      边界与不变量
      校验原 Card 引用而非 definitionId；任一实体出现在其他区域即拒绝整组。
      */
      const canCommit = () => selected.every((card) => player.hand.includes(card)
        && !state().deck.cards.includes(card)
        && !state().deck.discardPile.includes(card)
        && !state().deck.resolvingCards.includes(card)
        && !state().deck.judgmentZone.includes(card)
        && !(state().publicCardPool ?? []).includes(card)
        && !state().players.some((owner) => owner.equipment === card));
      if (!canCommit()) return invalid();
      const moves = selected.map((card) => ({
        type:"beforeCardMove", card, from:"hand", to:"discard", player, reason, cancelled:false,
        atomicGroupSize:selected.length
      }));
      for (const move of moves) {
        await runtime.emitEvent("beforeCardMove", move);
        if (!active(gameId)) return cancelled();
        if (move.cancelled || !canCommit()) return invalid();
      }
      if (!active(gameId)) return cancelled();
      if (!canCommit() || !moveCardsAtomically(state(), player.hand, state().deck.discardPile, selected)) return invalid();
      bumpHandVersion(state(), player);
      for (const card of selected) runtime.knowledge.invalidate(card.id, player.id);
      runtime.syncDeckAliases();
      if (!options.silent) {
        const label = selected.length === 1 ? `「${selected[0].name}」` : `${selected.length}张牌`;
        runtime.log(`${player.name}因${reason}弃置了${label}。`);
      }
      runtime.queueFeedback("discard", player.id, selected.length);
      for (const move of moves) {
        await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
        if (!active(gameId)) return cancelled();
      }
      runtime.render();
      return Object.freeze({ status:RESPONSE_STATUS.USED, cards:Object.freeze([...selected]) });
    },

    /*
    功能
    把指定实体牌从一名玩家手牌转移到另一名玩家手牌。

    调用方
    转移、掠夺与角色效果执行流程。

    输入
    来源 Player、接收 Player、当前手牌 Card entity 与原因。

    输出
    Promise<boolean>，仅成功提交转移时为 true。

    读取状态
    当前 session、双方存活状态、来源手牌与已知牌记忆。

    写入状态
    双方手牌、双方 handVersion、知识、反馈与展示。

    调用函数
    emitEvent、moveCardBetweenZones、bumpHandVersion、knowledge API。

    边界与不变量
    await 后复核原实体仍在来源手牌；仅把原先知情者的记忆迁移到新持有者。
    */
    async moveCardBetweenHands(from, to, card, reason) {
      const gameId = state().gameId;
      if (!active(gameId) || !from?.alive || !to?.alive || state().isGameOver || !from.hand.includes(card)) return false;
      const move = { type:"beforeCardMove", card, from:"hand", to:"hand", fromPlayer:from, player:to, reason, cancelled:false };
      await runtime.emitEvent("beforeCardMove", move);
      if (!active(gameId) || move.cancelled || !from.hand.includes(card)) return false;
      const trackingViewers = state().players.filter((viewer) => viewer.id === from.id || runtime.knowledge.isKnownTo(viewer, from, card));
      moveCardBetweenZones(state(), from.hand, to.hand, card);
      bumpHandVersion(state(), from);
      bumpHandVersion(state(), to);
      runtime.knowledge.invalidate(card.id, from.id);
      for (const viewer of trackingViewers) if (viewer.id !== to.id) runtime.knowledge.remember(viewer, to, card);
      runtime.queueFeedback("draw", to.id, 1);
      await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
      if (active(gameId)) runtime.render();
      return true;
    },

    /*
    功能
    把来源玩家的当前装备实体转移到接收者手牌。

    调用方
    掠夺与装备转移效果执行流程。

    输入
    来源 Player、接收 Player、当前 Equipment entity 与原因。

    输出
    Promise<boolean>，仅成功提交转移时为 true。

    读取状态
    当前 session、双方存活状态与 from.equipment。

    写入状态
    来源装备槽、接收者手牌和 handVersion、知识、反馈与展示。

    调用函数
    emitEvent、commitMoveEquipmentToHand、bumpHandVersion、knowledge API。

    边界与不变量
    beforeCardMove 后装备仍须为同一实体；公开装备转入隐藏手牌后更新全部观察者记忆。
    */
    async moveEquipmentToHand(from, to, card, reason) {
      const gameId = state().gameId;
      if (!active(gameId) || !from?.alive || !to?.alive || from.equipment !== card || state().isGameOver) return false;
      const move = { type:"beforeCardMove", card, from:"equipment", to:"hand", fromPlayer:from, player:to, reason, cancelled:false };
      await runtime.emitEvent("beforeCardMove", move);
      if (!active(gameId) || move.cancelled || from.equipment !== card) return false;
      commitMoveEquipmentToHand(state(), from, to, card);
      bumpHandVersion(state(), to);
      runtime.knowledge.invalidate(card.id, from.id);
      for (const viewer of state().players) if (viewer.id !== to.id) runtime.knowledge.remember(viewer, to, card);
      runtime.queueFeedback("draw", to.id, 1);
      await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
      if (active(gameId)) runtime.render();
      return true;
    },

    /*
    功能
    把玩家当前装备实体移动到弃牌堆。

    调用方
    破坏、弃置装备与资源清理流程。

    输入
    Player、当前 Equipment entity 与弃置原因。

    输出
    Promise<boolean>，仅成功提交弃置时为 true。

    读取状态
    当前 session、player.alive、equipment 与弃牌堆。

    写入状态
    玩家装备槽、弃牌堆、知识、反馈与展示。

    调用函数
    emitEvent、commitDiscardEquipment、knowledge.invalidate、syncDeckAliases。

    边界与不变量
    beforeCardMove 后必须仍装备同一实体；取消或实体变化时不提交。
    */
    async discardEquipment(player, card, reason = "弃置装备") {
      const gameId = state().gameId;
      if (!active(gameId) || !player?.alive || player.equipment !== card) return false;
      const move = { type:"beforeCardMove", card, from:"equipment", to:"discard", player, reason, cancelled:false };
      await runtime.emitEvent("beforeCardMove", move);
      if (!active(gameId) || move.cancelled || player.equipment !== card) return false;
      commitDiscardEquipment(state(), player, card, state().deck.discardPile);
      runtime.knowledge.invalidate(card.id, player.id);
      runtime.syncDeckAliases();
      runtime.queueFeedback("discard", player.id);
      await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
      if (active(gameId)) runtime.render();
      return true;
    },

    /*
    功能
    将待使用的手牌实体移入牌堆结算区并登记 resolution owner。

    调用方
    ActionWorkflow 开始实体牌结算时。

    输入
    Player、当前手牌 Card entity 与可选 resolutionId。

    输出
    Promise<boolean>，实体进入 resolving 且会话有效时为 true。

    读取状态
    当前 session、玩家手牌、resolving 区与已有 resolution owner。

    写入状态
    hand/resolving zones、handVersion、知识与 resolution ownership。

    调用函数
    emitEvent、Deck.beginResolve、removeCardFromZone、claimResolution。

    边界与不变量
    同一实体不能被两个 resolutionId 认领；事件恢复后再次验证手牌位置。
    */
    async moveHandToResolving(player, card, resolutionId = null) {
      const gameId = state().gameId;
      const actions = runtime.getActionWorkflow();
      if (!active(gameId) || !player.hand.includes(card)) return false;
      if (resolutionId && actions.getResolutionOwner(card)) return false;
      const move = { type:"beforeCardMove", card, from:"hand", to:"resolving", player, reason:"使用", cancelled:false };
      await runtime.emitEvent("beforeCardMove", move);
      if (!active(gameId) || move.cancelled) return false;
      if (!player.hand.includes(card) || !state().deck.beginResolve(state(), card)) return false;
      removeCardFromZone(state(), player.hand, card);
      bumpHandVersion(state(), player);
      runtime.knowledge.invalidate(card.id, player.id);
      if (resolutionId) actions.claimResolution(card, resolutionId);
      runtime.syncDeckAliases();
      await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
      return active(gameId);
    },

    /*
    功能
    将已完成结算的实体牌从 resolving 区移入弃牌堆。

    调用方
    ActionWorkflow 的正常结算收束路径。

    输入
    resolving 中的 Card entity 与可选 resolutionId。

    输出
    Promise<boolean>，实体只在弃牌堆时为 true。

    读取状态
    当前 session、resolving/discard zones 与 resolution owner。

    写入状态
    resolving/discard zones 与牌堆兼容别名。

    调用函数
    ownsResolution、emitEvent、Deck.finishResolveToDiscard、syncDeckAliases。

    边界与不变量
    仅当前 owner 可提交；事件取消、旧会话或实体已离开 resolving 时返回 false。
    */
    async finishResolvingToDiscard(card, resolutionId = null) {
      const gameId = state().gameId;
      const actions = runtime.getActionWorkflow();
      if (!active(gameId) || (resolutionId && !actions.ownsResolution(card, resolutionId))
        || !state().deck.resolvingCards.includes(card)) return false;
      const move = { type:"beforeCardMove", card, from:"resolving", to:"discard", reason:"结算完成", cancelled:false };
      await runtime.emitEvent("beforeCardMove", move);
      if (!active(gameId) || move.cancelled || (resolutionId && !actions.ownsResolution(card, resolutionId))) return false;
      if (!state().deck.finishResolveToDiscard(state(), card)) return false;
      runtime.syncDeckAliases();
      await runtime.emitEvent("afterCardMove", { ...move, type:"afterCardMove" });
      return state().deck.discardPile.includes(card) && !state().deck.resolvingCards.includes(card);
    },

    /*
    功能
    把 resolving 中的装备牌装入玩家装备槽，并原子替换旧装备。

    调用方
    装备牌效果结算与 ActionWorkflow 收束。

    输入
    Player、resolving 中的 Equipment entity 与可选 resolutionId。

    输出
    Promise<boolean>，新装备成为唯一装备且离开 resolving 时为 true。

    读取状态
    当前 session、全部牌区、玩家装备与 resolution ownership。

    写入状态
    resolving/equipment/discard zones、牌堆别名、日志与反馈。

    调用函数
    emitEvent、commitEquipmentReplacement、ActionWorkflow ownership API。

    边界与不变量
    新旧装备在两个 before 事件后再次整体校验，任一取消都不允许半替换。
    */
    async equipCard(player, card, resolutionId = null) {
      const gameId = state().gameId;
      const actions = runtime.getActionWorkflow();
      if (!active(gameId)) return false;
      /*
      功能
      判断当前调用是否拥有新装备实体的结算权。

      调用方
      equipCard 的预检与事件后复检。

      输入
      无；读取闭包中的 card、resolutionId 与 actions。

      输出
      未指定 owner 或 owner 匹配时返回 true。

      读取状态
      ActionWorkflow resolution ownership。

      写入状态
      无。

      调用函数
      actions.ownsResolution。

      边界与不变量
      指定 resolutionId 时必须按 Card entity 校验 owner，不接受 definitionId 替代。
      */
      const ownsResolution = () => !resolutionId || actions.ownsResolution(card, resolutionId);
      /*
      功能
      复核新装备实体仍可从 resolving 区提交到装备槽。

      调用方
      equipCard 在 before 事件前后及最终替换前调用。

      输入
      无；读取 equipCard 闭包状态。

      输出
      ownership 与唯一牌区条件全部满足时返回 true。

      读取状态
      resolution owner、resolving、牌堆、弃牌、判定、公开池、手牌与装备区。

      写入状态
      无。

      调用函数
      ownsResolution、Array.includes/some。

      边界与不变量
      新装备必须只存在于 resolving 区，任何重复区域引用都拒绝提交。
      */
      const canCommitNew = () => ownsResolution()
        && state().deck.resolvingCards.includes(card)
        && !state().deck.cards.includes(card)
        && !state().deck.discardPile.includes(card)
        && !state().deck.judgmentZone.includes(card)
        && !(state().publicCardPool ?? []).includes(card)
        && !state().players.some((owner) => owner.hand.includes(card) || owner.equipment === card);
      if (!canCommitNew()) return false;
      const equipMove = { type:"beforeCardMove", card, from:"resolving", to:"equipment", player, reason:"装备", cancelled:false };
      await runtime.emitEvent("beforeCardMove", equipMove);
      if (!active(gameId) || equipMove.cancelled || !canCommitNew()) return false;
      const old = player.equipment;
      const replaceMove = old
        ? { type:"beforeCardMove", card:old, from:"equipment", to:"discard", player, reason:"替换装备", cancelled:false }
        : null;
      /*
      功能
      复核待替换旧装备仍是玩家装备槽中的唯一实体。

      调用方
      equipCard 在旧装备 beforeCardMove 事件后调用。

      输入
      无；读取闭包中的 old 与 player。

      输出
      无旧装备或旧装备位置仍有效时返回 true。

      读取状态
      玩家装备槽及所有其他牌区中的旧实体位置。

      写入状态
      无。

      调用函数
      Array.includes/some。

      边界与不变量
      旧装备不得在事件期间离槽或同时出现在任一其他区域。
      */
      const oldRemainsValid = () => !old || (player.equipment === old
        && !state().deck.cards.includes(old)
        && !state().deck.discardPile.includes(old)
        && !state().deck.resolvingCards.includes(old)
        && !state().deck.judgmentZone.includes(old)
        && !(state().publicCardPool ?? []).includes(old)
        && !state().players.some((owner) => owner.hand.includes(old) || (owner !== player && owner.equipment === old)));
      if (replaceMove) {
        await runtime.emitEvent("beforeCardMove", replaceMove);
        if (!active(gameId) || replaceMove.cancelled) return false;
      }
      if (!canCommitNew() || !oldRemainsValid()) return false;
      if (!commitEquipmentReplacement(
        state(), player, card, old, state().deck.resolvingCards, state().deck.discardPile
      )) return false;
      runtime.syncDeckAliases();
      if (replaceMove) {
        await runtime.emitEvent("afterCardMove", { ...replaceMove, type:"afterCardMove" });
        runtime.log(`${player.name}的「${old.name}」被替换并进入弃牌堆。`);
      }
      runtime.log(`${player.name}装备了「${card.name}」。`, "important");
      runtime.queueFeedback("equip", player.id);
      await runtime.emitEvent("afterCardMove", { ...equipMove, type:"afterCardMove" });
      return player.equipment === card && !state().deck.resolvingCards.includes(card);
    },

    /*
    功能
    查询指定实体牌在所有 canonical 区域中的出现位置。

    调用方
    ActionWorkflow 的结算后置条件与区域不变量测试。

    输入
    Card entity。

    输出
    Domain ZoneQueries 返回的区域出现记录。

    读取状态
    当前 MatchState 的全部 canonical card zones。

    写入状态
    无。

    调用函数
    getCardZoneOccurrences。

    边界与不变量
    按实体引用查询，不按 ID 或 definitionId 合并不同卡牌。
    */
    getCardZoneOccurrences(card) {
      return getCardZoneOccurrences(state(), card);
    },

    /*
    功能
    判断实体牌是否已唯一提交到弃牌堆。

    调用方
    ActionWorkflow 正常与异常结算收束。

    输入
    Card entity。

    输出
    仅满足弃牌后置条件时返回 true。

    读取状态
    当前 MatchState 的 canonical card zones。

    写入状态
    无。

    调用函数
    isCardCommittedToDiscard。

    边界与不变量
    实体必须在弃牌堆出现一次且不在其他区域。
    */
    isCardCommittedToDiscard(card) {
      return isCardCommittedToDiscard(state(), card);
    },

    /*
    功能
    判断实体牌是否已唯一提交到指定玩家装备槽。

    调用方
    ActionWorkflow 的装备结算后置条件。

    输入
    Player entity 与 Card entity。

    输出
    仅满足装备后置条件时返回 true。

    读取状态
    当前 MatchState 的装备槽与其他 canonical card zones。

    写入状态
    无。

    调用函数
    isCardCommittedToEquipment。

    边界与不变量
    实体必须只等于 player.equipment，不能同时出现在其他区域或其他玩家装备槽。
    */
    isCardCommittedToEquipment(player, card) {
      return isCardCommittedToEquipment(state(), player, card);
    },

    /*
    功能
    将显式请求修复的遗留实体从所有区域归一到弃牌堆。

    调用方
    显式资源修复 boundary 与 zone invariant tests；ActionWorkflow 失败已由整体 transaction rollback 拥有。

    输入
    Card entity、可选诊断原因与可选 resolutionId。

    输出
    修复后实体唯一位于弃牌堆时返回 true。

    读取状态
    resolution ownership、全部牌区、公开池与玩家手牌。

    写入状态
    全部受影响牌区、相关 handVersion、resolution ownership 与诊断 trace。

    调用函数
    purgeCardToDiscard、bumpHandVersion、releaseResolution、syncDeckAliases。

    边界与不变量
    指定 resolutionId 时只有 owner 可清理；最终弃牌堆中同一实体恰好一次。
    */
    cleanupFailedResolution(card, reason = null, resolutionId = null) {
      const actions = runtime.getActionWorkflow();
      if (!card || (resolutionId && !actions.ownsResolution(card, resolutionId))) return false;
      if (!resolutionId && !state().deck.resolvingCards.includes(card)) return false;
      const affectedHands = state().players.filter((player) => player.hand.includes(card));
      const zones = [state().deck.cards, state().deck.discardPile, state().deck.resolvingCards, state().deck.judgmentZone];
      const extraZones = [
        state().publicCardPool ?? [],
        ...(runtime.getPublicPoolCards() && runtime.getPublicPoolCards() !== state().publicCardPool
          ? [runtime.getPublicPoolCards()]
          : [])
      ];
      purgeCardToDiscard(state(), card, zones, state().players, extraZones, state().deck.discardPile);
      for (const player of affectedHands) bumpHandVersion(state(), player);
      actions.releaseResolution(card);
      runtime.syncDeckAliases();
      runtime.trace("ResourceWorkflow", `已清理失败结算实体 ${card.id ?? "unknown"}`, reason ?? undefined);
      return state().deck.discardPile.filter((entry) => entry === card).length === 1
        && !state().deck.resolvingCards.includes(card);
    },

    /*
    功能
    把所有阵亡玩家遗留的手牌和装备收回弃牌堆。

    调用方
    阵亡结算完成后的资源清理流程。

    输入
    无。

    输出
    Promise<void>。

    读取状态
    当前 session、玩家 alive、hand、equipment 与弃牌堆。

    写入状态
    阵亡玩家手牌、装备槽、弃牌堆、handVersion 与牌堆别名。

    调用函数
    discardCardFromHand、commitDiscardEquipment、syncDeckAliases。

    边界与不变量
    手牌按当前顺序逐张清理并在每次 await 后校验会话；存活玩家区域不变。
    */
    async cleanupDefeatedZones() {
      const gameId = state().gameId;
      if (!active(gameId)) return;
      for (const player of state().players) {
        if (player.alive) continue;
        for (const card of [...player.hand]) {
          await resource.discardCardFromHand(player, card, "阵亡区域清理");
          if (!active(gameId)) return;
        }
        if (player.equipment) commitDiscardEquipment(state(), player, player.equipment, state().deck.discardPile);
      }
      runtime.syncDeckAliases();
    }
  };
  return Object.freeze(resource);
}
