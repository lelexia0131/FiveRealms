import { structuralFingerprint, classifyState } from "./harness.js";

/**
 * 采样状态记录：corpus 阶段写入，实验阶段用于回放。
 * fingerprint 为结构化指纹（不含实体 ID）。
 */
export function recordTurnState(game, player, turnCount, meta = {}) {
  const classification = classifyState(game, player);
  return {
    ...meta,
    turn: turnCount,
    fingerprint: structuralFingerprint(game),
    playerId: player.id,
    seat: player.seatIndex,
    classification
  };
}

export function fingerprintMatches(record, game) {
  return JSON.stringify(record.fingerprint) === JSON.stringify(structuralFingerprint(game));
}
