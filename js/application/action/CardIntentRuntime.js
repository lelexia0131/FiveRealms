/*
模块职责
唯一拥有 card-specific preparation/revalidation/nested-assault runtime：transfer/leverage/private-selection/peek intent 与 leverage decline fallback；不拥有 generic Action lifecycle、Domain target rule 或 AI policy。

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
冻结 { prepareTransferIntent, prepareLeverageIntent, preparePrivateCardSelectionIntent, preparePrivateHandPeekIntent, resolvePrivateHandPeekIntent, resolveLeverage }。

读取状态
无。

写入状态
内部 leverageResolutionIds 与短期 hidden selection sessions。

调用函数
无。

边界与不变量
既有 card-specific prep 顺序与 hidden-information protection 完全保留。
*/
export function createCardIntentRuntime(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`CardIntentRuntime 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  const leverageResolutionIds = new Set();

  /*
  功能
  在反制窗口前锁定转移来源、接收者和手牌实体并分离私密/公开上下文。

  调用方
  CardRuntime.prepareCardAction。

  输入
  source、transfer card 与可选 planned selection。

  输出
  frozen intent/publicContext 或 null。

  读取状态
  state、transfer legality/hidden selection。

  写入状态
  仅可能清理短期 hidden selection session。

  调用函数
  getTransferSources、getTransferReceivers、chooseHiddenCards、resolveConfirmedTokens。

  边界与不变量
  未知手牌不进入公开上下文；实体不得按名称替代。
  */
  async function prepareTransferIntent(source, card, selection = null) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId)) return null;
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
    const hiddenCard = (await runtime.chooseHiddenCards(
      source, from, 1, "转移：选择1张手牌", planned, excludedCardIds, { purpose: "transfer", receiver }
    ))[0] ?? null;
    const chosen = hiddenCard ? { card: hiddenCard, zone: "hand" } : null;
    if (!runtime.isSessionValid(gameId)) return null;
    if (!chosen || excludedCardIds.has(chosen.card.id)
      || !runtime.getTransferSources(source, card, excludedCardIds).includes(from)
      || !runtime.getTransferReceivers(source, from, card).includes(receiver)) return null;
    if (chosen.zone !== "hand" || !from.hand.includes(chosen.card)) return null;
    return Object.freeze({
      privateIntent: Object.freeze({ from, receiver, card: chosen.card, zone: "hand" }),
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
  准备 scout/plunder/destroy 的私密选择意图。

  调用方
  CardRuntime.prepareCardAction。

  输入
  source、card、targets 与 optional selection。

  输出
  frozen { privateIntent, publicContext } 或 null。

  读取状态
  state、hidden selection sessions 与 target hand/equipment。

  写入状态
  短期 token cleanup。

  调用函数
  getCardTargets、chooseHiddenCards、choosePlayerZoneCard。

  边界与不变量
  公开 context 只含 owner/zone/count。
  */
  async function preparePrivateCardSelectionIntent(source, card, targets, selection = null) {
    const state = runtime.getState();
    const gameId = state.gameId;
    const target = targets[0] ?? null;
    if (!runtime.isSessionValid(gameId) || !target?.alive
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

      if (!runtime.isSessionValid(gameId) || !cards.length
        || !runtime.getCardTargets(source, card).includes(target)) return null;
      const uniqueCards = [...new Map(cards.map((entity) => [entity.id, entity])).values()];
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
  nested action 与 equipment movement 经 collaborators。

  调用函数
  responseWorkflow、playCard、moveEquipmentToHand。

  边界与不变量
  resolutionId 重复只允许一次；死亡/装备离场统一取消。
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

  return Object.freeze({
    getLeverageResolutionIdsSnapshot,
    prepareTransferIntent,
    prepareLeverageIntent,
    preparePrivateCardSelectionIntent,
    preparePrivateHandPeekIntent,
    resolvePrivateHandPeekIntent,
    resolveLeverage
  });
}
