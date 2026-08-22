/*
模块职责
把静态 Tactical Pattern definitions 转换为有界、确定性的语义动作序列 proposal。

上游
AI 组合根与 Planner。

下游
ActionDescriptor 与未来的 patterns definitions。

状态边界
只读传入的 SearchState、合法根动作与搜索结构，不创建或修改搜索状态。

信息边界
只消费调用方显式提供的可见搜索上下文，不读取隐藏信息或运行时实体容器。

架构约束
Pattern provides tactical search-order knowledge, not tactical value；不得调用 Simulator、Probability、Evaluator、
TransitionValue 或 SearchBudget internals，也不得判断合法性、修改候选 value 或建立独立搜索树。
*/

export class PatternMatcher {
  static definitions = Object.freeze([]);

  /*
  功能
  创建使用 ActionDescriptor 语义身份与静态 definitions 的 PatternMatcher。

  调用方
  AIController、Worker SearchEngineFactory 与 focused tests。

  输入
  ActionDescriptor owner；可选的测试 definitions。

  输出
  可生成搜索顺序 proposal 的 matcher。

  读取状态
  PatternMatcher.definitions。

  写入状态
  实例依赖与 definitions 的浅冻结副本。

  调用函数
  无。

  边界与不变量
  production definitions 默认为空；测试注入不得改变静态 production 列表。
  */
  constructor({ actionDescriptor, definitions = PatternMatcher.definitions } = {}) {
    if (typeof actionDescriptor?.semantic !== "function"
      || typeof actionDescriptor?.schedulingKeyFromDescriptor !== "function") {
      throw new TypeError("PatternMatcher 缺少依赖：actionDescriptor");
    }
    this.actionDescriptor = actionDescriptor;
    this.definitions = Object.freeze([...(definitions ?? [])]);
  }

  /*
  功能
  匹配当前根上下文并生成有界、确定性的 semantic sequence proposals。

  调用方
  Planner.plan，在任何 Pattern-guided materialization 前。

  输入
  玩家、当前 SearchState、已去重合法根动作与现有 search structure。

  输出
  匹配数、按 exploration priority 排序的 proposals，以及固定为空的 deferredRootKeys。

  读取状态
  注入 definitions 与 ActionDescriptor。

  写入状态
  无。

  调用函数
  definition.match/buildSequences、ActionDescriptor.semantic/schedulingKeyFromDescriptor。

  边界与不变量
  proposal 数量受 beamWidth 限制，完整 steps 不得超过 structure.depth；只生成正向探索顺序，
  不执行合法性、模拟或价值计算，production deferredRootKeys 永远为空。
  */
  match({ player, state, legalActions, structure }) {
    if (!this.definitions.length) {
      return {
        matchedPatternCount:0,
        proposals:[],
        deferredRootKeys:[]
      };
    }
    const depth = Math.max(1, Math.floor(Number(structure?.depth) || 1));
    const beamWidth = Math.max(0, Math.floor(Number(structure?.beamWidth) || 0));
    const context = Object.freeze({
      player,
      state,
      legalActions:Object.freeze([...(legalActions ?? [])]),
      structure:Object.freeze({ ...structure }),
      describeAction:(action) => this.actionDescriptor.semantic(action),
      semanticKey:(actionOrDescriptor) => (
        this.actionDescriptor.schedulingKeyFromDescriptor(actionOrDescriptor)
      )
    });
    let matchedPatternCount = 0;
    const proposalsByKey = new Map();
    for (const definition of this.definitions) {
      if (!definition?.match?.(context)) continue;
      matchedPatternCount += 1;
      const sequences = definition.buildSequences?.(context) ?? [];
      for (const sequence of sequences) {
        if (!Array.isArray(sequence?.steps)
          || sequence.steps.length === 0
          || sequence.steps.length > depth) continue;
        const steps = sequence.steps.map(
          (step) => this.actionDescriptor.semantic(step)
        );
        const stepKeys = steps.map(
          (step) => this.actionDescriptor.schedulingKeyFromDescriptor(step)
        );
        const patternId = String(definition.id ?? sequence.patternId ?? "");
        if (!patternId) continue;
        const semanticKey = JSON.stringify({ patternId, stepKeys });
        if (proposalsByKey.has(semanticKey)) continue;
        const explorationPriority = Number(sequence.explorationPriority);
        proposalsByKey.set(semanticKey, Object.freeze({
          patternId,
          steps:Object.freeze(steps),
          stepKeys:Object.freeze(stepKeys),
          explorationPriority:Number.isFinite(explorationPriority) ? explorationPriority : 0,
          semanticKey,
          reason:String(sequence.reason ?? "")
        }));
      }
    }
    const proposals = [...proposalsByKey.values()].sort((left, right) => {
      if (left.explorationPriority !== right.explorationPriority) {
        return left.explorationPriority > right.explorationPriority ? -1 : 1;
      }
      return left.semanticKey.localeCompare(right.semanticKey);
    }).slice(0, beamWidth);
    return {
      matchedPatternCount,
      proposals,
      deferredRootKeys:[]
    };
  }
}
