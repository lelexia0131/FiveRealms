/** AI fake thinking timing 已停用；legacy 配置数值仅保留公开 API 兼容，不驱动 AI 决策或 Game RNG。 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260816-fr-arch-14-runtime-closure";

const RANGES = Object.freeze({
  initial: ["aiInitialThinkMinMs", "aiInitialThinkMaxMs"],
  action: ["aiBetweenActionMinMs", "aiBetweenActionMaxMs"],
  response: ["aiResponseThinkMinMs", "aiResponseThinkMaxMs"],
  discard: ["aiDiscardThinkMinMs", "aiDiscardThinkMaxMs"],
  end: ["aiEndThinkMinMs", "aiEndThinkMaxMs"]
});

/*
功能
返回停用后的 AI fake thinking delay。

调用方
legacy timing callers 与 timing regression。

输入
旧 random/min/max/fastMode 参数。

输出
零。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不调用 random，不推进任何 RNG。
*/
export function sampleDelay(_random, _minimum, _maximum, _fastMode = false) {
  return 0;
}

/*
功能
返回停用后的按阶段 AI fake thinking delay。

调用方
legacy timing callers。

输入
game-like phase options。

输出
零。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不读取 game.random；AI thinking 只由实际 search compute 决定。
*/
export function getAiDelay(game, phase, options = {}) {
  const keys = RANGES[phase] ? [...RANGES[phase]] : null;
  if (!keys) throw new RangeError(`未知 AI 延迟阶段：${phase}`);
  if (phase === "initial" && options.complex) keys[1] = "aiComplexThinkMaxMs";
  return GAME_CONFIG.simulationMode || game.simulationMode ? 0 : 0;
}
