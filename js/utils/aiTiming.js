/** AI 展示节奏；与 search compute、真实游戏 RNG、AI search RNG 完全分离。 */
import { RUNTIME_POLICY } from "../application/policy/RuntimePolicy.js?build=20260818-skill-rules-locality-refactor";

const RANGES = Object.freeze({
  initial: ["aiInitialThinkMinMs", "aiInitialThinkMaxMs"],
  action: ["aiBetweenActionMinMs", "aiBetweenActionMaxMs"],
  response: ["aiResponseThinkMinMs", "aiResponseThinkMaxMs"],
  discard: ["aiDiscardThinkMinMs", "aiDiscardThinkMaxMs"],
  end: ["aiEndThinkMinMs", "aiEndThinkMaxMs"]
});

/*
功能
按独立展示随机源采样可见 AI 节奏延迟。

调用方
timing callers 与 timing regression。

输入
presentation random、最小/最大毫秒与 fastMode。

输出
非负整数毫秒。

读取状态
RUNTIME_POLICY 的快速展示倍率与最短延迟。

写入状态
random。

调用函数
无。

边界与不变量
只推进调用方显式提供的 presentation random；不接触真实游戏或 AI search RNG。
*/
export function sampleDelay(random, minimum, maximum, fastMode = false) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
    throw new RangeError("AI 延迟范围无效");
  }
  const roll = Math.min(0.999999, Math.max(0, Number(random()) || 0));
  const natural = Math.round(minimum + ((maximum - minimum) * roll));
  return fastMode
    ? Math.max(RUNTIME_POLICY.animationFastMinimumMs, Math.round(natural * RUNTIME_POLICY.animationFastScale))
    : natural;
}

/*
功能
返回按阶段采样的 AI 展示节奏延迟。

调用方
timing callers。

输入
game-like presentation runtime、phase 与 complex 选项。

输出
非负整数毫秒；simulation/headless 为零。

读取状态
RUNTIME_POLICY 展示范围与 game 的展示模式。

写入状态
sampleDelay。

调用函数
无。

边界与不变量
只读取 game.presentationRandom；不读取 game.random 或 AI search RNG；simulationMode 不采样。
*/
export function getAiDelay(game, phase, options = {}) {
  const keys = RANGES[phase] ? [...RANGES[phase]] : null;
  if (!keys) throw new RangeError(`未知 AI 延迟阶段：${phase}`);
  if (phase === "initial" && options.complex) keys[1] = "aiComplexThinkMaxMs";
  if (RUNTIME_POLICY.simulationMode || game?.simulationMode) return 0;
  const presentationRandom = options.random ?? game?.presentationRandom ?? Math.random;
  return sampleDelay(
    presentationRandom,
    RUNTIME_POLICY[keys[0]],
    RUNTIME_POLICY[keys[1]],
    Boolean(game?.animationFastMode)
  );
}
