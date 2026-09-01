/*
模块职责
唯一拥有 card-specific preparation/revalidation/nested-assault runtime：transfer declaration/effect、leverage、private-selection/peek intent 与 leverage decline fallback；不拥有 generic Action lifecycle、Domain target rule 或 AI policy。

上游
CardRuntime 与 ActionWorkflow。

下游
Application Response/Action、Domain rules 与 narrow hidden-selection/choice collaborators。

状态边界
leverageResolutionIds 是本 runtime 的 card-specific application state；Domain 写入经 collaborators/transitions。

信息边界
private intent 只存在于当前调用栈；公开 context 不含 hidden card entity。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime 或 concrete adapters。
*/
import { getScoutMaxRevealCount } from "../../domain/rules/card/CardEffectRules.js";
import { ActionRollbackError } from "./ActionTransaction.js";

const REQUIRED_DEPENDENCIES = [
  "getState", "isSessionValid", "presentation", "diagnostics", "responseWorkflow", "playCard",
  "moveEquipmentToHand", "getTransferSources", "getTransferReceivers", "getCardTargets",
  "chooseHiddenCards", "choosePlayerZoneCard", "choosePrivatePeekCards",
  "getLeverageFirstTargets", "getAssaultTargetCandidates",
  "requestHiddenCards", "createHiddenSelection", "resolveConfirmedTokens", "clearSelection"
];

/*
功能
创建 card-specific intent runtime。

调用方
CardRuntime composition。

输入
显式注入的 legality/hidden-selection/response/move collaborators。

输出
冻结 card intent API 与 Action transaction checkpoint participant。

读取状态
无。

写入状态
内部 leverageResolutionIds 与短期 hidden selection sessions。

调用函数
无。

边界与不变量
转移公开声明与具体隐藏牌 intent 分属反制前后边界；hidden-information protection 保持不变。
*/
export function createCardIntentRuntime(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`CardIntentRuntime 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  const leverageResolutionIds = new Set();

  /*
  功能
  在反制窗口前准备转移来源与接收者的公开声明。

  调用方
  CardRuntime.prepareCardAction。

  输入
  source、transfer card 与可选 planned selection。

  输出
  frozen declaration/publicContext 或 null。

  读取状态
  state 与 transfer legality。

  写入状态
  仅可能清理调用方预先创建但声明非法的 selection session。

  调用函数
  getTransferSources、getTransferReceivers。

  边界与不变量
  声明只含来源与接收者；不得读取或锁定具体隐藏手牌。
  */
  function prepareTransferDeclaration(source, card, selection = null) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !source?.alive || !state.players.includes(source)) return null;
    const excludedCardIds = new Set([card.id]);
    const sources = runtime.getTransferSources(source, card, excludedCardIds)
      .filter((from) => runtime.getTransferReceivers(source, from, card).length);
    const planned = selection?.sourceId && selection?.receiverId ? selection : null;
    if (planned?.zone && planned.zone !== "hand") {
      if (planned.selectionId) runtime.clearSelection(planned.selectionId);
      return null;
    }
    const from = state.players.find((player) => player.id === planned?.sourceId && player.alive) ?? null;
    const receiver = state.players.find((player) => player.id === planned?.receiverId && player.alive) ?? null;
    if (!sources.includes(from) || !runtime.getTransferReceivers(source, from, card).includes(receiver)) return null;
    return Object.freeze({
      from,
      receiver,
      publicContext: Object.freeze({
        fromPlayerId: from.id,
        fromName: from.name,
        receiverPlayerId: receiver.id,
        receiverName: receiver.name,
        zone: "hand",
        safeItemLabel: "1张牌"
      })
    });
  }

  /*
  功能
  在完整反制链结束后，为仍合法的转移声明选择一张当前手牌实体。

  调用方
  CardRuntime.preparePostCounterEffectIntent。

  输入
  source、transfer card、反制前 declaration 与可选 planned selection。

  输出
  frozen private transfer intent 或 null。

  读取状态
  每个异步边界两侧的当前 session、players、transfer legality 与 from.hand。

  写入状态
  仅通过隐藏选择 collaborator 创建并清理短期 selection session。

  调用函数
  getTransferSources、getTransferReceivers、chooseHiddenCards。

  边界与不变量
  来源与接收者沿用公开声明；具体牌只在反制后选择，返回前必须仍位于来源手牌且不得是正在结算的转移牌。
  */
  async function prepareTransferEffectIntent(source, card, declaration, selection = null) {
    const gameId = runtime.getState().gameId;
    const excludedCardIds = new Set([card.id]);
    const from = declaration?.from ?? null;
    const receiver = declaration?.receiver ?? null;
    const state = runtime.getState();
    if (!runtime.isSessionValid(gameId) || !source?.alive || !state.players.includes(source)
      || !from?.alive || !state.players.includes(from)
      || !receiver?.alive || !state.players.includes(receiver)
      || !runtime.getTransferSources(source, card, excludedCardIds).includes(from)
      || !runtime.getTransferReceivers(source, from, card).includes(receiver)) return null;
    if (selection?.zone && selection.zone !== "hand") return null;

    const hiddenCard = (await runtime.chooseHiddenCards(
      source, from, 1, "转移：选择1张手牌", selection, excludedCardIds,
      { purpose: "transfer", receiver }
    ))[0] ?? null;
    const latestState = runtime.getState();
    if (!runtime.isSessionValid(gameId) || !source?.alive || !latestState.players.includes(source)
      || !from?.alive || !latestState.players.includes(from)
      || !receiver?.alive || !latestState.players.includes(receiver)
      || !hiddenCard || excludedCardIds.has(hiddenCard.id) || !from.hand.includes(hiddenCard)
      || !runtime.getTransferSources(source, card, excludedCardIds).includes(from)
      || !runtime.getTransferReceivers(source, from, card).includes(receiver)) return null;
    return Object.freeze({ from, receiver, card: hiddenCard, zone: "hand" });
  }

  /*
  功能
  锁定借势第一目标、第二目标与装备实例。

  调用方
  CardRuntime.prepareCardAction。

  输入
  source 与 optional selection。

  输出
  frozen intent 或 null。

  读取状态
  state players/equipment。

  写入状态
  无。

  调用函数
  getCardTargets。

  边界与不变量
  只接受装备 ID 对应同一实例。
  */
  function prepareLeverageIntent(source, selection = null) {
    const state = runtime.getState();
    if (!runtime.isSessionValid(state.gameId) || !source?.alive || !selection) return null;
    const firstTarget = state.players.find((player) => player.id === selection.firstTargetId) ?? null;
    const secondTarget = state.players.find((player) => player.id === selection.secondTargetId) ?? null;
    if (!runtime.getLeverageFirstTargets(source).includes(firstTarget)) return null;
    if (!runtime.getAssaultTargetCandidates(firstTarget).includes(secondTarget)) return null;
    const equipmentCard = firstTarget.equipment;
    if (!equipmentCard?.id
      || equipmentCard.definitionId !== selection.equipmentDefinitionId
      || (selection.equipmentCardId && equipmentCard.id !== selection.equipmentCardId)) return null;
    return Object.freeze({ firstTarget, secondTarget, equipmentCard, equipmentCardId: equipmentCard.id });
  }

  /*
  功能
  在完整反制链结束后准备 scout/plunder/destroy 的私密选择意图。

  调用方
  CardRuntime.preparePostCounterEffectIntent。

  输入
  source、card、targets 与 optional selection。

  输出
  frozen { privateIntent, publicContext } 或 null。

  读取状态
  每个异步边界两侧的当前 session、players、合法目标与 target hand/equipment。

  写入状态
  短期 token cleanup。

  调用函数
  getCardTargets、chooseHiddenCards、choosePlayerZoneCard。

  边界与不变量
  打开选择前目标必须仍有合法资源；返回实体必须仍位于原区域。
  */
  async function preparePrivateCardSelectionIntent(source, card, targets, selection = null) {
    const state = runtime.getState();
    const gameId = state.gameId;
    const target = targets[0] ?? null;
    const targetHasSelectableResource = card.definitionId === "scout"
      ? Boolean(target?.hand?.length)
      : Boolean(target?.hand?.length || target?.equipment);
    if (!runtime.isSessionValid(gameId) || !source?.alive || !state.players.includes(source)
      || !target?.alive || !state.players.includes(target) || !targetHasSelectableResource
      || !runtime.getCardTargets(source, card).includes(target)) return null;

    try {
      let zone = "hand";
      let cards = [];
      if (card.definitionId === "scout") {
        const maxRevealCount = getScoutMaxRevealCount();
        cards = await runtime.chooseHiddenCards(
          source, target, Math.min(maxRevealCount, target.hand.length),
          `${card.name}：选择至多${maxRevealCount}张隐藏手牌`, selection, null,
          { purpose: "scout" }, { exact:false }
        );
      } else if (["plunder", "destroy"].includes(card.definitionId)) {
        const chosen = await runtime.choosePlayerZoneCard(
          source, target,
          `${card.name}：选择1张手牌或装备牌`,
          selection, null, { purpose: card.definitionId }
        );
        if (chosen) {
          zone = chosen.zone;
          cards = [chosen.card];
        }
      } else return null;

      const latestState = runtime.getState();
      if (!runtime.isSessionValid(gameId) || !source?.alive || !latestState.players.includes(source)
        || !target?.alive || !latestState.players.includes(target) || !cards.length
        || !runtime.getCardTargets(source, card).includes(target)) return null;
      const uniqueCards = [...new Map(cards.map((entity) => [entity.id, entity])).values()];
      const entitiesRemainInZone = zone === "hand"
        ? uniqueCards.every((entity) => target.hand.includes(entity))
        : uniqueCards.length === 1 && target.equipment === uniqueCards[0];
      if (!entitiesRemainInZone) return null;
      return Object.freeze({
        privateIntent: Object.freeze({ owner: target, zone, cards: Object.freeze(uniqueCards), selectionId: selection?.selectionId ?? null }),
        publicContext: Object.freeze({ ownerPlayerId: target.id, zone, selectedCount: uniqueCards.length })
      });
    } finally {
      if (selection?.selectionId) runtime.clearSelection(selection.selectionId);
    }
  }

  /*
  功能
  为被动窥隙准备不泄漏牌面的私密意图。

  调用方
  passive trigger runtime。

  输入
  viewer、owner、count 与 reason。

  输出
  frozen intent 或 null。

  读取状态
  state、AI hidden selection 与 UI hidden tokens。

  写入状态
  短期 selection sessions。

  调用函数
  chooseHiddenCards、createHiddenSelection、requestHiddenCards、resolveConfirmedTokens、clearSelection。

  边界与不变量
  AI/真人路径与旧实现一致。
  */
  async function preparePrivateHandPeekIntent(viewer, owner, count, reason) {
    const state = runtime.getState();
    const gameId = state.gameId;
    const maximum = Math.min(Math.max(0, count), owner?.hand?.length ?? 0);
    if (!runtime.isSessionValid(gameId) || !viewer?.alive || !owner?.alive || !maximum) return null;
    const cards = await runtime.choosePrivatePeekCards(viewer, owner, maximum, reason, { purpose: "spy-gap" });
    return cards.length
      ? Object.freeze({ owner, zone: "hand", cards: Object.freeze([...cards]), selectionId: null })
      : null;
  }

  /*
  功能
  复验窥隙意图实体仍在原手牌区。

  调用方
  passive trigger runtime。

  输入
  viewer 与 intent。

  输出
  有效 card 数组。

  读取状态
  state/session/owner hand。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不泄漏 hidden entity。
  */
  function resolvePrivateHandPeekIntent(viewer, intent) {
    const state = runtime.getState();
    if (!runtime.isSessionValid(state.gameId) || !viewer?.alive || !intent?.owner?.alive || intent.zone !== "hand") return [];
    return intent.cards.filter((card) => intent.owner.hand.includes(card));
  }

  /*
  功能
  执行借势 response/nested assault/decline fallback sequencing。

  调用方
  CardEffectRuntime.leverage。

  输入
  source、card、intent 与 resolutionId。

  输出
  resolved boolean。

  读取状态
  state/session/response/equipment identity。

  写入状态
  当前调用栈把 resolutionId 加入去重 Set；nested action/equipment movement 经 collaborators；finally 释放该 ID。

  调用函数
  responseWorkflow、playCard、moveEquipmentToHand。

  边界与不变量
  resolutionId 在当前借势调用栈内重复只允许一次，完成或失败后必须释放；
  死亡/装备离场统一取消；nested rollback failure 必须终止父 Action。
  */
  async function resolveLeverage(source, card, intent, resolutionId) {
    const state = runtime.getState();
    const gameId = state.gameId;
    /*
    功能
    判断借势三名玩家是否仍在本局且存活。

    调用方
    resolveLeverage。

    输入
    无。

    输出
    布尔值。

    读取状态
    state.players。

    写入状态
    无。

    调用函数
    inGame。

    边界与不变量
    只做 identity 复验。
    */
    const playersValid = () => {
      /*
      功能
      判断单个借势玩家是否仍存活且属于本局。

      调用方
      playersValid。

      输入
      player。

      输出
      布尔值。

      读取状态
      state.players。

      写入状态
      无。

      调用函数
      Array.includes。

      边界与不变量
      不检查手牌或突袭次数。
      */
      const inGame = (player) => Boolean(player?.alive && state.players.includes(player));
      return inGame(source) && inGame(intent?.firstTarget) && inGame(intent?.secondTarget);
    };
    /*
    功能
      判断借势装备是否仍为发动时同一实体。

      调用方
      resolveLeverage。

      输入
      无。

      输出
      布尔值。

      读取状态
      intent.equipmentCard/firstTarget.equipment。

      写入状态
      无。

      调用函数
      无。

      边界与不变量
      名称相同不得替代。
      */
    const equipmentValid = () => Boolean(intent?.equipmentCard?.id
      && intent.equipmentCard.id === intent.equipmentCardId
      && intent.firstTarget?.equipment === intent.equipmentCard);
    if (!runtime.isSessionValid(gameId) || !intent || !resolutionId || leverageResolutionIds.has(resolutionId)) return false;
    leverageResolutionIds.add(resolutionId);
    try {
      if (!playersValid()) {
        runtime.presentation.log(`目标已离场，「${card.name}」结算取消。`, "important");
        return false;
      }
      if (!equipmentValid()) {
        runtime.presentation.log(`指定装备已离开装备区，「${card.name}」结算取消。`, "important");
        return false;
      }

      const { firstTarget, secondTarget, equipmentCard } = intent;
      const response = await runtime.responseWorkflow.requestLeverageAssault(firstTarget, secondTarget, {
        source, card, equipment: equipmentCard
      });
      if (!runtime.isSessionValid(gameId) || response.status === "cancelled") return false;

      if (!playersValid()) {
        runtime.presentation.log(`目标已离场，「${card.name}」结算取消。`, "important");
        return false;
      }
      if (!equipmentValid()) {
        runtime.presentation.log(`指定装备已离开装备区，「${card.name}」结算取消。`, "important");
        return false;
      }

      if (response.status === "used" && response.card) {
        let used = false;
        try {
          used = await runtime.playCard(firstTarget, response.card, [secondTarget], null, {
            usageContext: "leverageAssault",
            parentResolutionId: resolutionId
          });
        } catch (error) {
          if (error instanceof ActionRollbackError) throw error;
          runtime.diagnostics.reportWorkflowError("Game", `${firstTarget.name}的借势内嵌突袭结算失败`, error);
        }
        if (used) return true;
        if (!runtime.isSessionValid(gameId)) return false;
      }

      if (!playersValid()) {
        runtime.presentation.log(`目标已离场，「${card.name}」结算取消。`, "important");
        return false;
      }
      if (!equipmentValid()) {
        runtime.presentation.log(`指定装备已离开装备区，「${card.name}」结算取消。`, "important");
        return false;
      }
      const moved = await runtime.moveEquipmentToHand(firstTarget, source, equipmentCard, "借势");
      if (!runtime.isSessionValid(gameId)) return false;
      if (moved) {
        runtime.presentation.log(`${firstTarget.name}拒绝使用「突袭」，${source.name}获得了其「${equipmentCard.name}」。`, "important");
        return true;
      }
      if (!equipmentValid()) {
        runtime.presentation.log(`指定装备已离开装备区，「${card.name}」结算取消。`, "important");
      }
      return false;
    } finally {
      // resolutionId 只防当前借势调用栈重入；内嵌 Action 已结束后，历史 ID 不再有合法消费者。
      leverageResolutionIds.delete(resolutionId);
    }
  }

  /*
  功能
  返回 leverage resolution IDs 的只读快照。

  调用方
  match application adapter accessor 与 harness。

  输入
  无。

  输出
  new Set snapshot。

  读取状态
  leverageResolutionIds。

  写入状态
  无。

  调用函数
  Set。

  边界与不变量
  修改快照不影响内部 owner。
  */
  function getLeverageResolutionIdsSnapshot() {
    return new Set(leverageResolutionIds);
  }

  /*
  功能
  捕获真实 Action 开始前已消费的借势 resolution IDs。

  调用方
  ActionTransaction composition participant。

  输入
  无。

  输出
  独立 Set checkpoint。

  读取状态
  leverageResolutionIds。

  写入状态
  无。

  调用函数
  getLeverageResolutionIdsSnapshot。

  边界与不变量
  只保留 checkpoint 时仍在结算的外层 ID；已完成历史 ID 不得进入后续 Action checkpoint。
  */
  function captureActionCheckpoint() {
    return getLeverageResolutionIdsSnapshot();
  }

  /*
  功能
  恢复真实 Action 开始前已消费的借势 resolution IDs。

  调用方
  ActionTransaction rollback。

  输入
  captureActionCheckpoint 返回的 Set。

  输出
  无。

  读取状态
  checkpoint。

  写入状态
  leverageResolutionIds。

  调用函数
  Set.clear/add。

  边界与不变量
  只恢复本 runtime 私有去重状态；牌区和 resolution owner 由同一 transaction 另行恢复。
  */
  function restoreActionCheckpoint(checkpoint) {
    if (!(checkpoint instanceof Set)) throw new TypeError("CardIntentRuntime Action checkpoint 非法");
    leverageResolutionIds.clear();
    for (const resolutionId of checkpoint) leverageResolutionIds.add(resolutionId);
  }

  return Object.freeze({
    getLeverageResolutionIdsSnapshot,
    captureActionCheckpoint,
    restoreActionCheckpoint,
    prepareTransferDeclaration,
    prepareTransferEffectIntent,
    prepareLeverageIntent,
    preparePrivateCardSelectionIntent,
    preparePrivateHandPeekIntent,
    resolvePrivateHandPeekIntent,
    resolveLeverage
  });
}
