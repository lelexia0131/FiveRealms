/*
模块职责
唯一拥有 AI 单步思考窗口、纯展示节奏、独立 timing 随机边界与浏览器速度偏好迁移。

上游
Application turn/response timing、UI 设置与 timing tests。

下游
Application RuntimePolicy。

状态边界
纯计算只读运行策略；偏好 helper 只读写调用方提供的 Storage。

信息边界
速度与 timing random 均为公开展示配置，不读取任何隐藏手牌或 AI SearchState。

架构约束
不得读取真实游戏 RNG 或 AI search RNG；只输出 data-only 毫秒窗口，由 composition 决定是否把上限传给搜索；旧 fastMode 只能单向迁移到 speed。
*/
import { AI_PACING, RUNTIME_POLICY } from "../application/policy/RuntimePolicy.js";

export const AI_SPEED_STORAGE_KEY = "five-realms-ai-speed";
export const LEGACY_FAST_MODE_STORAGE_KEYS = Object.freeze([
  "five-realms-fast-mode",
  "fastMode"
]);

/*
功能
把任意输入归一化为合法 AI 速度档位。

调用方
UI、MatchApplication、偏好迁移与 timing callers。

输入
任意速度值与可选 fallback。

输出
1、2、3 之一。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
非法值回退到标准档；不得产生连续倍率。
*/
export function normalizeAiSpeed(speed, fallback = RUNTIME_POLICY.defaultAiSpeed) {
  const numeric = Number(speed);
  return Number.isInteger(numeric) && Object.hasOwn(AI_PACING, numeric)
    ? numeric
    : fallback;
}

/*
功能
读取 AI 速度偏好，并把旧 fastMode 布尔设置单向迁移到新 speed key。

调用方
UIManager constructor 与 preference tests。

输入
Storage-compatible 对象；默认使用 globalThis.localStorage。

输出
1、2、3 之一。

读取状态
新速度键与两个旧 fastMode 兼容键。

写入状态
发现旧设置时写入新速度键并删除旧键。

调用函数
normalizeAiSpeed、Storage getItem/setItem/removeItem。

边界与不变量
存储缺失或异常回退 1×；旧 false 映射 1×，旧 true 映射 3×，迁移后只有新键是权威。
*/
export function readAiSpeedPreference(storage = globalThis.localStorage) {
  try {
    const storedSpeed = storage?.getItem(AI_SPEED_STORAGE_KEY);
    const normalized = normalizeAiSpeed(storedSpeed, null);
    if (normalized !== null) return normalized;
    for (const key of LEGACY_FAST_MODE_STORAGE_KEYS) {
      const legacy = storage?.getItem(key);
      if (legacy === null || legacy === undefined) continue;
      const normalizedLegacy = String(legacy).trim().toLowerCase();
      const speed = ["true", "1", "on"].includes(normalizedLegacy) ? 3
        : ["false", "0", "off"].includes(normalizedLegacy) ? 1
          : null;
      if (speed === null) continue;
      storage?.setItem(AI_SPEED_STORAGE_KEY, String(speed));
      for (const legacyKey of LEGACY_FAST_MODE_STORAGE_KEYS) storage?.removeItem?.(legacyKey);
      return speed;
    }
  } catch { /* 存储不可用时只使用本次会话默认值。 */ }
  return RUNTIME_POLICY.defaultAiSpeed;
}

/*
功能
持久化一个合法 AI 速度档位。

调用方
UIManager.setAiSpeed 与 preference tests。

输入
速度值与 Storage-compatible 对象。

输出
归一化后的 1、2、3。

读取状态
无。

写入状态
新速度键；同时删除旧 fastMode 键。

调用函数
normalizeAiSpeed、Storage setItem/removeItem。

边界与不变量
存储异常不得回滚当前会话设置；永不持久化小数倍率。
*/
export function writeAiSpeedPreference(speed, storage = globalThis.localStorage) {
  const normalized = normalizeAiSpeed(speed);
  try {
    storage?.setItem(AI_SPEED_STORAGE_KEY, String(normalized));
    for (const legacyKey of LEGACY_FAST_MODE_STORAGE_KEYS) storage?.removeItem?.(legacyKey);
  } catch { /* 存储不可用时只保留本次会话设置。 */ }
  return normalized;
}

/*
功能
按独立展示随机源采样既有阶段 planned thinking duration。

调用方
getAiDelay 与 timing regression。

输入
presentation random、最小与最大毫秒。

输出
闭区间内的非负整数毫秒。

读取状态
无。

写入状态
只推进调用方显式提供的 random。

调用函数
无。

边界与不变量
该值是原有 presentation plan，不是速度档位的随机目标；不接触真实游戏或 AI search RNG。
*/
export function sampleDelay(random, minimum, maximum) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
    throw new RangeError("AI 延迟范围无效");
  }
  const roll = Math.min(0.999999, Math.max(0, Number(random()) || 0));
  return Math.round(minimum + ((maximum - minimum) * roll));
}

/*
功能
按给定比例和独立随机源轻微扰动一个 pacing 边界。

调用方
getAiPacingBounds。

输入
基础毫秒、jitter 比例与 presentation random。

输出
随机化后的整数毫秒。

读取状态
无。

写入状态
只推进调用方显式提供的 random 一次。

调用函数
无。

边界与不变量
random 被夹取到 [0, 1)；不得读取真实游戏 RNG 或 AI search RNG。
*/
function sampleJitteredBound(base, ratio, random) {
  const roll = Math.min(0.999999, Math.max(0, Number(random()) || 0));
  return Math.round(base * (1 + (((roll * 2) - 1) * ratio)));
}

/*
功能
分别随机化当前速度档位的可观察思考下限与上限。

调用方
getAiDelay 与 timing tests。

输入
速度档位与独立 presentation random。

输出
冻结的 { minimumMs, maximumMs }。

读取状态
AI_PACING 权威配置。

写入状态
random 恰好推进两次。

调用函数
normalizeAiSpeed、sampleJitteredBound。

边界与不变量
MIN/MAX 必须独立 jitter；异常或交叉结果防御性收束为 minimumMs < maximumMs。
*/
export function getAiPacingBounds(speed, random = Math.random) {
  const config = AI_PACING[normalizeAiSpeed(speed)];
  const minimumMs = Math.max(0, sampleJitteredBound(config.baseMinMs, config.minJitter, random));
  const sampledMaximum = Math.max(0, sampleJitteredBound(config.baseMaxMs, config.maxJitter, random));
  return Object.freeze({
    minimumMs,
    maximumMs: Math.max(minimumMs + 1, sampledMaximum)
  });
}

/*
功能
为一次 AI 决策生成思考时间窗口。
调用方
Application TurnWorkflow 的 composition collaborator 与 timing tests。

输入
game-like application runtime，以及可选 timing random。

输出
冻结的 { minimumMs, maximumMs }；simulation/headless 返回零窗口。

读取状态
game.aiSpeed、game.presentationRandom、RUNTIME_POLICY.simulationMode 与 AI_PACING。

写入状态
非 simulation 路径只推进 timing random 两次。

调用函数
getAiPacingBounds。

边界与不变量
同一次 decision 只能调用一次；maximumMs 可作为显式搜索预算，minimumMs 只用于剩余展示等待；不接触游戏或搜索 RNG。
*/
export function sampleAiDecisionWindow(game, options = {}) {
  if (RUNTIME_POLICY.simulationMode || game?.simulationMode) {
    return Object.freeze({ minimumMs: 0, maximumMs: 0 });
  }
  return getAiPacingBounds(
    game?.aiSpeed,
    options.random ?? game?.presentationRandom ?? Math.random
  );
}

/*
功能
根据已采样的思考时间窗口和实际搜索耗时，计算搜索结束后还需等待的时间。

调用方
Application TurnWorkflow 的 composition collaborator 与 timing tests。

输入
本次 decision window 与 elapsedMs。

输出
补足 minimumMs 所需的非负整数毫秒。

读取状态
无。

写入状态
无。

调用函数
getRemainingAiThinkingDelay。

边界与不变量
elapsed 达到 minimumMs 后立即返回零；maximumMs 不参与二次 clamp，也不会再次随机。
*/
export function getRemainingAiDecisionDelay(window, elapsedMs = 0) {
  return getRemainingAiThinkingDelay(window?.minimumMs, elapsedMs);
}

/*
功能
把原 planned thinking duration 夹取到本次随机化边界。

调用方
getAiDelay 与 timing tests。

输入
rawThinkingTime 毫秒与 { minimumMs, maximumMs }。

输出
边界内的整数 planned thinking duration。

读取状态
无。

写入状态
无。

调用函数
Math.min、Math.max。

边界与不变量
raw 位于区间内时必须原样保留；不得重新随机为另一个目标时间。
*/
export function clampAiThinkingTime(rawThinkingTime, bounds) {
  const raw = Math.max(0, Math.round(Number(rawThinkingTime) || 0));
  const minimum = Math.max(0, Math.round(Number(bounds?.minimumMs) || 0));
  const maximum = Math.max(minimum, Math.round(Number(bounds?.maximumMs) || 0));
  return Math.min(maximum, Math.max(minimum, raw));
}

/*
功能
扣除已经真实发生的 computation/decision elapsed，得到剩余人为等待。

调用方
getAiDelay、turn/response timing tests。

输入
final planned thinking 与 elapsed 毫秒。

输出
非负整数 remaining delay。

读取状态
无。

写入状态
无。

调用函数
Math.max。

边界与不变量
真实 elapsed 超过 presentation MAX 时返回零，绝不伪造倒退的总耗时。
*/
export function getRemainingAiThinkingDelay(plannedThinkingTime, elapsedMs = 0) {
  return Math.max(0, Math.round(Number(plannedThinkingTime) || 0) - Math.max(0, Math.round(Number(elapsedMs) || 0)));
}

/*
功能
返回按阶段 raw plan、速度随机边界与真实 elapsed 计算的剩余展示延迟。

调用方
timing callers。

输入
game-like presentation runtime、phase，以及可选 complex/rawThinkingTime/elapsedMs。

输出
非负整数毫秒；simulation/headless 为零。

读取状态
RUNTIME_POLICY raw range、AI_PACING 与 game.aiSpeed。

写入状态
sampleDelay、getAiPacingBounds、clampAiThinkingTime、getRemainingAiThinkingDelay。

调用函数
无。

边界与不变量
只读取 game.presentationRandom；MIN/MAX 分别采样；raw 位于边界内时保持；simulation/headless 不采样。
*/
export function getAiDelay(game, phase, options = {}) {
  const range = RUNTIME_POLICY.aiRawThinkingRanges[phase];
  if (!range) throw new RangeError(`未知 AI 延迟阶段：${phase}`);
  if (RUNTIME_POLICY.simulationMode || game?.simulationMode) return 0;
  const presentationRandom = options.random ?? game?.presentationRandom ?? Math.random;
  const rawThinkingTime = Number.isFinite(Number(options.rawThinkingTime))
    ? Math.max(0, Number(options.rawThinkingTime))
    : sampleDelay(
      presentationRandom,
      range.minimumMs,
      phase === "initial" && options.complex ? range.complexMaximumMs : range.maximumMs
    );
  const bounds = getAiPacingBounds(game?.aiSpeed, presentationRandom);
  const planned = clampAiThinkingTime(rawThinkingTime, bounds);
  return getRemainingAiThinkingDelay(planned, options.elapsedMs);
}
