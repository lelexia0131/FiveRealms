/**
 * 隐藏实体牌令牌服务。依赖 Game 玩家与 createId，只在内存保存 token 映射；
 * DOM 永远只能收到 token/position。手牌版本变化或对局 dispose 后映射必须失效。
 */
import { createId } from "../utils/helpers.js?build=20260731-all-in-response-v27";

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
