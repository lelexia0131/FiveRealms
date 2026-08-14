/** AI 展示节奏的纯函数入口。实际等待仍统一由 CleanupManager 执行。 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260814-ai-state-contract";

const RANGES = Object.freeze({
  initial: ["aiInitialThinkMinMs", "aiInitialThinkMaxMs"],
  action: ["aiBetweenActionMinMs", "aiBetweenActionMaxMs"],
  response: ["aiResponseThinkMinMs", "aiResponseThinkMaxMs"],
  discard: ["aiDiscardThinkMinMs", "aiDiscardThinkMaxMs"],
  end: ["aiEndThinkMinMs", "aiEndThinkMaxMs"]
});

export function sampleDelay(random, minimum, maximum, fastMode = false) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) throw new RangeError("AI 延迟范围无效");
  const roll = Math.min(0.999999, Math.max(0, Number(random()) || 0));
  const natural = Math.round(minimum + (maximum - minimum) * roll);
  return fastMode ? Math.max(GAME_CONFIG.animationFastMinimumMs, Math.round(natural * GAME_CONFIG.animationFastScale)) : natural;
}

export function getAiDelay(game, phase, options = {}) {
  const keys = RANGES[phase] ? [...RANGES[phase]] : null;
  if (!keys) throw new RangeError(`未知 AI 延迟阶段：${phase}`);
  if (phase === "initial" && options.complex) keys[1] = "aiComplexThinkMaxMs";
  if (GAME_CONFIG.simulationMode || game.simulationMode) return 0;
  return sampleDelay(game.random, GAME_CONFIG[keys[0]], GAME_CONFIG[keys[1]], game.animationFastMode);
}
