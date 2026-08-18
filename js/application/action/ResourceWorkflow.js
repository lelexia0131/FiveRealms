/*
模块职责
唯一拥有真实对局能量与实体牌区移动的 Application sequencing，包括事件、版本、知识失效和展示顺序。

上游
Match/Turn/Action/Combat workflows 与 composition root。

下游
Domain resource/zone transitions、zone queries 与显式 presentation/knowledge capabilities。

状态边界
只通过 Domain transitions 写能量、牌区和 handVersion；不写规则定义或 AI SearchState。

信息边界
私密牌知识只经注入 knowledge adapter 更新；公开日志不得泄露未知牌名。

架构约束
不得持有 composition root、UIManager、AIController 或规则 literal；跨 await 后必须复核 session 与实体位置。
*/
import { appendCardToZone, commitEquipmentReplacement, discardEquipment as commitDiscardEquipment, moveCardBetweenZones, moveCardsAtomically, moveEquipmentToHand as commitMoveEquipmentToHand, purgeCardToDiscard, removeCardFromZone } from "../../domain/state/transitions/ZoneTransitions.js?build=20260818-skill-rules-locality-refactor";
import { changeEnergy } from "../../domain/state/transitions/ResourceTransitions.js?build=20260818-skill-rules-locality-refactor";
import { bumpHandVersion } from "../../domain/state/transitions/PlayerStateTransitions.js?build=20260818-skill-rules-locality-refactor";
import { getCardZoneOccurrences, isCardCommittedToDiscard, isCardCommittedToEquipment } from "../../domain/state/queries/ZoneQueries.js?build=20260818-skill-rules-locality-refactor";
import { RESPONSE_STATUS } from "../response/ResponseResult.js?build=20260818-skill-rules-locality-refactor";

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
  执行 state 对应的 ResourceWorkflow 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  const state = () => runtime.getState();
  /*
  功能
  执行 active 对应的 ResourceWorkflow 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  const active = (gameId) => runtime.isSessionValid(gameId);
  const resource = {
    /*
    功能
    执行 gainEnergy 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 drawCards 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 discardCardFromHand 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 payCardsFromHandAtomically 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    async payCardsFromHandAtomically(player, cards, reason = "响应支付", options = {}) {
      const gameId = state().gameId;
      const selected = Array.isArray(cards) ? [...cards] : [];
      const expectedCount = options.expectedCount ?? selected.length;
      /*
      功能
      执行 invalid 对应的 ResourceWorkflow 职责。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
      */
      const invalid = () => Object.freeze({ status:RESPONSE_STATUS.INVALID, cards:[] });
      /*
      功能
      判断 cancelled 对应的 ResourceWorkflow 条件。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
      */
      const cancelled = () => Object.freeze({ status:RESPONSE_STATUS.CANCELLED, cards:[] });
      if (!active(gameId)) return cancelled();
      if (!player?.alive || state().isGameOver || expectedCount <= 0 || selected.length !== expectedCount) return invalid();
      if (new Set(selected).size !== selected.length
        || new Set(selected.map((card) => card?.id)).size !== selected.length
        || selected.some((card) => !card?.id)) return invalid();
      /*
      功能
      判断 canCommit 对应的 ResourceWorkflow 条件。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
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
    执行 moveCardBetweenHands 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 moveEquipmentToHand 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 discardEquipment 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 moveHandToResolving 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 finishResolvingToDiscard 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    执行 equipCard 对应的 ResourceWorkflow 职责。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    async equipCard(player, card, resolutionId = null) {
      const gameId = state().gameId;
      const actions = runtime.getActionWorkflow();
      if (!active(gameId)) return false;
      /*
      功能
      判断 ownsResolution 对应的 ResourceWorkflow 条件。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
      */
      const ownsResolution = () => !resolutionId || actions.ownsResolution(card, resolutionId);
      /*
      功能
      判断 canCommitNew 对应的 ResourceWorkflow 条件。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
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
      执行 oldRemainsValid 对应的 ResourceWorkflow 职责。

      调用方
      本模块内部流程及显式公开边界。

      输入
      函数签名声明的参数。

      输出
      函数实现声明的返回值。

      读取状态
      仅函数体显式读取的参数、模块或实例状态。

      写入状态
      仅执行函数体显式声明的写入；查询路径不写状态。

      调用函数
      仅调用函数体中显式列出的依赖。

      边界与不变量
      遵守模块头定义的 ownership、状态与信息边界。
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
    查询并返回 getCardZoneOccurrences 对应的 ResourceWorkflow 结果。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    getCardZoneOccurrences(card) {
      return getCardZoneOccurrences(state(), card);
    },

    /*
    功能
    判断 isCardCommittedToDiscard 对应的 ResourceWorkflow 条件。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    isCardCommittedToDiscard(card) {
      return isCardCommittedToDiscard(state(), card);
    },

    /*
    功能
    判断 isCardCommittedToEquipment 对应的 ResourceWorkflow 条件。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
    */
    isCardCommittedToEquipment(player, card) {
      return isCardCommittedToEquipment(state(), player, card);
    },

    /*
    功能
    更新或清理 cleanupFailedResolution 对应的 ResourceWorkflow 状态。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
    更新或清理 cleanupDefeatedZones 对应的 ResourceWorkflow 状态。

    调用方
    本模块内部流程及显式公开边界。

    输入
    函数签名声明的参数。

    输出
    函数实现声明的返回值。

    读取状态
    仅函数体显式读取的参数、模块或实例状态。

    写入状态
    仅执行函数体显式声明的写入；查询路径不写状态。

    调用函数
    仅调用函数体中显式列出的依赖。

    边界与不变量
    遵守模块头定义的 ownership、状态与信息边界。
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
