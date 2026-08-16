/*
模块职责
唯一拥有束排序、裁剪、近似平局、随机根选择与中断后的 best-seen candidate（已经完整计算出的最佳候选）选择契约。

上游
Planner 与搜索策略测试。

下游
游戏搜索配置与注入的随机能力。

状态边界
不读取或修改 SearchState，只处理候选数值与停止原因。

信息边界
不读取卡牌、技能、玩家或隐藏信息。

架构约束
不得产生动作先验、领域转移项或最终价值；预算中断不能从 partial frontier（尚未完整物化的搜索前沿）重新选择。
*/
import { GAME_CONFIG } from "../../config/gameConfig.js?build=20260816-legacy-recovery";
import { SEARCH_STOP_REASON } from "./SearchBudget.js?build=20260816-legacy-recovery";

export class SearchPolicy {
  /*
  功能
  绑定运行时随机能力。

  调用方
  AIController 组合根与 Planner 正式边界。

  输入
  随机、随机幅度查询能力与可选显式 search configuration。

  输出
  可供 Planner 使用的搜索策略实例。

  读取状态
  保存显式能力与配置引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接收 Game、Controller 或任何领域归属模块；config 缺省时保持 GAME_CONFIG 兼容默认。
  */
  constructor({
    random,
    getRandomnessRange,
    config = null
  } = {}) {
    const capabilities = {
      random,
      getRandomnessRange
    };
    for (const [name, capability] of Object.entries(capabilities)) {
      if (typeof capability !== "function") {
        throw new TypeError(`SearchPolicy 缺少依赖：${name}`);
      }
    }
    Object.assign(this, capabilities);
    this.config = config;
  }

  /*
  功能
  返回稳定搜索结构配置。

  调用方
  Planner。

  输入
  无。

  输出
  depth、beamWidth、hiddenSamples 与 yieldEvery。

  读取状态
  GAME_CONFIG。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只暴露现有值，不修改阈值或搜索参数。
  */
  structure() {
    return {
      depth:this.config?.depth ?? GAME_CONFIG.aiSearchDepth,
      beamWidth:this.config?.beamWidth ?? GAME_CONFIG.aiBeamWidth,
      hiddenSamples:this.config?.hiddenSamples ?? GAME_CONFIG.aiHiddenStateSamples,
      yieldEvery:this.config?.yieldEvery ?? GAME_CONFIG.aiSearchYieldEvery
    };
  }

  /*
  功能
  返回本次搜索 policy 的完整 data-only configuration snapshot。

  调用方
  AIController 构造 SearchRequest 与 boundary 测试。

  输入
  无。

  输出
  包含搜索结构、预算、近似平局与随机幅度的冻结普通对象。

  读取状态
  this.config 与 GAME_CONFIG 默认。

  写入状态
  无。

  调用函数
  Object.freeze。

  边界与不变量
  只读诊断契约；不能通过返回对象修改搜索行为。
  */
  snapshot() {
    return Object.freeze({
      ...this.structure(),
      timeBudgetMs:this.config?.timeBudgetMs ?? GAME_CONFIG.aiSearchTimeBudgetMs,
      nodeBudget:this.config?.nodeBudget ?? null,
      nearTieRange:this.config?.nearTieRange ?? GAME_CONFIG.aiNearTieRange,
      enableRandomness:this.config?.enableRandomness ?? GAME_CONFIG.enableAiRandomness,
      randomnessRange:this.config?.randomnessRange ?? GAME_CONFIG.aiRandomnessRange,
      difficultyMultiplier:this.config?.difficultyMultiplier ?? GAME_CONFIG.aiDifficultyMultiplier
    });
  }

  /*
  功能
  组合真实候选价值与仅用于裁剪的动作先验。

  调用方
  Planner 节点物化。

  输入
  valueScore、prior 与真实搜索深度。

  输出
  pruneScore。

  读取状态
  无。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  prior 只按 depth 除一次，绝不进入 valueScore。
  */
  pruneScore(valueScore, prior, depth) {
    return valueScore + prior / depth;
  }

  /*
  功能
  按裁剪分数稳定排序并截取束宽。

  调用方
  Planner 每层展开。

  输入
  候选数组与束宽。

  输出
  排序后前 beamWidth 个候选。

  读取状态
  候选 pruneScore。

  写入状态
  原地排序候选数组。

  调用函数
  无。

  边界与不变量
  比较器保持 b-a；相等项依赖 JavaScript 稳定排序维持生成顺序。
  */
  prune(candidates, beamWidth) {
    candidates.sort((a,b) => b.pruneScore - a.pruneScore);
    return candidates.slice(0, beamWidth);
  }

  /*
  功能
  返回候选数组中真实价值最高的节点。

  调用方
  Planner 节点预算提前收束路径。

  输入
  候选数组。

  输出
  首个最高 valueScore 节点或 null。

  读取状态
  候选 valueScore。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  严格大于才替换，保留既有首个平局候选。
  */
  bestByValue(candidates) {
    return candidates.reduce((best, node) => (
      !best || node.valueScore > best.valueScore ? node : best
    ), null);
  }

  /*
  功能
  按真实价值对最终束稳定排序。

  调用方
  Planner 最终根选择。

  输入
  候选束。

  输出
  同一个已排序数组。

  读取状态
  valueScore。

  写入状态
  原地排序候选束。

  调用函数
  无。

  边界与不变量
  最终排序不读取 pruneScore。
  */
  orderFinal(beam) {
    beam.sort((a,b) => b.valueScore - a.valueScore);
    return beam;
  }

  /*
  功能
  从最终束中按既有近似平局与随机扰动规则选择候选。

  调用方
  Planner 搜索收束阶段与策略测试。

  输入
  已按真实价值排序的候选束。

  输出
  被选节点；空束时为 undefined。

  读取状态
  GAME_CONFIG 与注入的随机能力。

  写入状态
  随机源序列。

  调用函数
  getRandomnessRange、random。

  边界与不变量
  随机调用次数、近似平局集合和严格大于 tie-break 保持不变。
  */
  chooseCandidate(beam) {
    const bestScore = beam[0]?.valueScore ?? -Infinity;
    const config = this.snapshot();
    const near = beam.filter((node) => bestScore - node.valueScore <= config.nearTieRange);
    if (near.length <= 1 || !config.enableRandomness) return near[0] ?? beam[0];
    const randomness = Math.max(
      0,
      Number(this.getRandomnessRange() ?? config.randomnessRange) || 0
    );
    if (!randomness) return near[0];
    const scale = Math.max(1, Math.abs(bestScore));
    return near.reduce((best, node) => {
      const adjusted = node.valueScore + (this.random() * 2 - 1) * scale * randomness;
      return !best || adjusted > best.adjusted ? { node, adjusted } : best;
    }, null).node;
  }

  /*
  功能
  按正式停止原因选择完整搜索结果或中断前的 best-seen candidate。

  调用方
  Planner 搜索收束阶段。

  输入
  stopReason、完整 final candidate set 与已完整物化的 bestSeenCandidate。

  输出
  COMPLETE 时按既有近似平局与随机选择规则处理；预算中断时返回 best-seen candidate。

  读取状态
  候选 valueScore 与注入随机能力。

  写入状态
  COMPLETE 可能消耗既有随机序列并原地排序 completedCandidates。

  调用函数
  orderFinal、chooseCandidate。

  边界与不变量
  TIME/NODE 不得从未完整物化的搜索前沿重新执行近似平局选择；CANCELLED 不选择候选。
  */
  selectFinal({ stopReason, completedCandidates, bestSeenCandidate }) {
    if (stopReason === SEARCH_STOP_REASON.COMPLETE) {
      this.orderFinal(completedCandidates);
      return this.chooseCandidate(completedCandidates);
    }
    if (stopReason === SEARCH_STOP_REASON.TIME
      || stopReason === SEARCH_STOP_REASON.NODE) {
      return bestSeenCandidate;
    }
    return null;
  }
}
