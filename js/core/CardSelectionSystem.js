/**
 * 隐藏实体牌令牌 legacy façade。Application 已拥有 token/session authority；
 * 本文件只把真实 Player/Card entity 适配为 application/choice data-only store。
 */
import { createId } from "../utils/helpers.js?build=20260816-fr-arch-14-runtime-closure";
import { createHiddenCardSelectionStore } from "../application/choice/HiddenCardSelectionStore.js?build=20260816-fr-arch-14-runtime-closure";

export class CardSelectionSystem {
  /*
  功能
  创建 legacy façade 并注入 application-owned hidden selection store。

  调用方
  Game 构造函数。

  输入
  game。

  输出
  初始化完成的 CardSelectionSystem。

  读取状态
  无。

  写入状态
  内部 store Maps。

  调用函数
  createHiddenCardSelectionStore。

  边界与不变量
  不复制 Application token 规则；只负责实体适配。
  */
  constructor(game) {
    this.game = game;
    this.store = createHiddenCardSelectionStore({ createId });
    this.sessions = this.store.sessions;
    this.selections = this.store.tokenRecords;
  }

  /*
  功能
  把真实隐藏牌转换为短期不透明 token selection。

  调用方
  Game、InteractionController 与测试。

  输入
  owner 与可选 cards。

  输出
  冻结 selection DTO。

  读取状态
  owner.handVersion 与 cards。

  写入状态
  store session/token records。

  调用函数
  store.createSelection。

  边界与不变量
  position 优先使用当前手牌顺序；不把 Card entity 交给 Application store。
  */
  createHiddenSelection(owner, cards = owner.hand) {
    const cardRecords = cards.map((card, index) => {
      const ownerIndex = owner.hand.findIndex((held) => held.id === card.id);
      return { cardId: card.id, position: ownerIndex >= 0 ? ownerIndex + 1 : index + 1 };
    });
    const selection = this.store.createSelection({
      ownerId: owner.id,
      handVersion: owner.handVersion,
      cardRecords
    });
    return Object.freeze({
      selectionId: selection.selectionId,
      ownerId: selection.ownerId,
      handVersion: selection.handVersion,
      tokens: selection.tokens
    });
  }

  /*
  功能
  把 token 解析回仍有效的真实 Card entity。

  调用方
  Game、InteractionController 与测试。

  输入
  token、expectedOwner 与 expectedSelectionId。

  输出
  Card entity 或 null。

  读取状态
  game.state.players 与当前手牌实体。

  写入状态
  无。

  调用函数
  store.getTokenRecord。

  边界与不变量
  校验 owner、selectionId 与 handVersion；不按名称/槽位猜测实体。
  */
  resolveToken(token, expectedOwner = null, expectedSelectionId = null) {
    const record = this.store.getTokenRecord(token);
    if (!record) return null;
    const owner = this.game.state.players.find((player) => player.id === record.ownerId);
    if (!owner || (expectedOwner && owner.id !== expectedOwner.id)
      || (expectedSelectionId && record.selectionId !== expectedSelectionId)
      || owner.handVersion !== record.version) return null;
    return owner.hand.find((card) => card.id === record.cardId) ?? null;
  }

  /*
  功能
  固化一组已确认 token 为当前手牌实体意图。

  调用方
  Game、InteractionController 与测试。

  输入
  tokens、expectedOwner、expectedSelectionId 与 maximum。

  输出
  去重 Card entity 数组。

  读取状态
  expectedOwner.hand 与 store records。

  写入状态
  无。

  调用函数
  store.resolveConfirmedCardIds。

  边界与不变量
  确认语义允许无关 handVersion 变化，但实体此刻必须仍在该手牌。
  */
  resolveConfirmedTokens(tokens, expectedOwner, expectedSelectionId, maximum) {
    const cardIds = this.store.resolveConfirmedCardIds(
      tokens, expectedSelectionId, expectedOwner?.id, maximum
    );
    const resolved = cardIds
      .map((cardId) => expectedOwner.hand.find((card) => card.id === cardId))
      .filter(Boolean);
    return [...new Map(resolved.map((card) => [card.id, card])).values()];
  }

  /*
  功能
  判断 selection 会话是否仍 active。

  调用方
  Game 与测试。

  输入
  selectionId 与 expectedOwner。

  输出
  布尔值。

  读取状态
  store session 与 owner.handVersion。

  写入状态
  无。

  调用函数
  store.isSessionActive。

  边界与不变量
  handVersion 变化立即失效。
  */
  isSelectionActive(selectionId, expectedOwner = null) {
    if (expectedOwner) {
      return this.store.isSessionActive(selectionId, expectedOwner.id, expectedOwner.handVersion);
    }
    const session = this.store.getSession(selectionId);
    if (!session) return false;
    const owner = this.game.state.players.find((player) => player.id === session.ownerId);
    return Boolean(owner && owner.handVersion === session.version);
  }

  /*
  功能
  清理指定 selection 的 token 与 session。

  调用方
  Game、InteractionController 与测试。

  输入
  selectionId。

  输出
  无。

  读取状态
  无。

  写入状态
  store Maps。

  调用函数
  store.clearSelection。

  边界与不变量
  只按 selectionId scope 清理。
  */
  clearSelection(selectionId) { this.store.clearSelection(selectionId); }

  /*
  功能
  清空全部隐藏选择状态。

  调用方
  Game.dispose 与重新征召。

  输入
  无。

  输出
  无。

  读取状态
  无。

  写入状态
  store Maps。

  调用函数
  store.cleanup。

  边界与不变量
  对局 dispose 后所有 token 立即失效。
  */
  cleanup() { this.store.cleanup(); }
}
