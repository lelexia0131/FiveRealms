/**
 * 隐藏实体牌令牌服务。依赖 Game 玩家与 createId，只在内存保存 token 映射；
 * DOM 永远只能收到 token/position。手牌版本变化或对局 dispose 后映射必须失效。
 */
import { createId } from "../utils/helpers.js?build=20260730-tabletop-hands-v20";

/** 把隐藏实体牌转换为短期不透明令牌。令牌只在当前手牌版本有效。 */
export class CardSelectionSystem {
  constructor(game) { this.game = game; this.selections = new Map(); }

  createHiddenSelection(owner, cards = owner.hand) {
    const selectionId = createId("hidden-selection");
    const version = owner.handVersion;
    const tokens = cards.map((card, index) => {
      const token = createId("opaque");
      this.selections.set(token, { selectionId, ownerId:owner.id, cardId:card.id, version });
      return Object.freeze({ token, position:index + 1 });
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

  clearSelection(selectionId) {
    for (const [token, record] of this.selections) if (record.selectionId === selectionId) this.selections.delete(token);
  }
  cleanup() { this.selections.clear(); }
}
