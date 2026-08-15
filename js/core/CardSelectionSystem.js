/**
 * 隐藏实体牌令牌服务。依赖 Game 玩家与 createId，只在内存保存 token 映射；
 * DOM 永远只能收到 token/position。手牌版本变化或对局 dispose 后映射必须失效。
 */
import { createId } from "../utils/helpers.js?build=20260815-residual-end-threat-fix";

/** 把隐藏实体牌转换为短期不透明令牌。令牌只在当前手牌版本有效。 */
export class CardSelectionSystem {
  constructor(game) { this.game = game; this.selections = new Map(); this.sessions = new Map(); }

  createHiddenSelection(owner, cards = owner.hand) {
    const selectionId = createId("hidden-selection");
    const version = owner.handVersion;
    this.sessions.set(selectionId, { ownerId:owner.id, version });
    const tokens = cards.map((card, index) => {
      const token = createId("opaque");
      this.selections.set(token, { selectionId, ownerId:owner.id, cardId:card.id, version });
      const ownerIndex = owner.hand.findIndex((held) => held.id === card.id);
      return Object.freeze({ token, position:ownerIndex >= 0 ? ownerIndex + 1 : index + 1 });
    });
    return Object.freeze({ selectionId, ownerId:owner.id, handVersion:version, tokens });
  }

  resolveToken(token, expectedOwner = null, expectedSelectionId = null) {
    const record = this.selections.get(token);
    if (!record) return null;
    const owner = this.game.state.players.find((player) => player.id === record.ownerId);
    if (!owner || (expectedOwner && owner.id !== expectedOwner.id) || (expectedSelectionId && record.selectionId !== expectedSelectionId) || owner.handVersion !== record.version) return null;
    return owner.hand.find((card) => card.id === record.cardId) ?? null;
  }

  /**
   * 把玩家刚确认的一组短期令牌固化为私密实体意图。这里允许无关手牌版本变化，
   * 但仍要求令牌属于当前会话、当前所有者，且原实体此刻仍在该所有者手牌中。
   */
  resolveConfirmedTokens(tokens, expectedOwner, expectedSelectionId, maximum) {
    const session = this.sessions.get(expectedSelectionId);
    if (!session || session.ownerId !== expectedOwner?.id) return [];
    const uniqueTokens = [...new Set(tokens ?? [])].slice(0, Math.max(0, maximum));
    const resolved = uniqueTokens.map((token) => {
      const record = this.selections.get(token);
      if (!record || record.selectionId !== expectedSelectionId || record.ownerId !== expectedOwner.id) return null;
      return expectedOwner.hand.find((card) => card.id === record.cardId) ?? null;
    }).filter(Boolean);
    return [...new Map(resolved.map((card) => [card.id, card])).values()];
  }

  isSelectionActive(selectionId, expectedOwner = null) {
    const session = this.sessions.get(selectionId);
    if (!session) return false;
    const owner = this.game.state.players.find((player) => player.id === session.ownerId);
    return Boolean(owner
      && owner.handVersion === session.version
      && (!expectedOwner || session.ownerId === expectedOwner.id));
  }

  clearSelection(selectionId) {
    for (const [token, record] of this.selections) if (record.selectionId === selectionId) this.selections.delete(token);
    this.sessions.delete(selectionId);
  }
  cleanup() { this.selections.clear(); this.sessions.clear(); }
}
