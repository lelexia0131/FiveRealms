/*
模块职责
把静态 Tactical Pattern definitions 转换为有界、确定性的语义动作序列 proposal。

上游
Worker SearchEngineFactory 与 Searcher。

下游
canonical Action intent 与 ProductionPatterns registry。

状态边界
只读传入的 World、合法根动作与搜索结构，不创建或修改搜索状态。

信息边界
只消费调用方显式提供的可见搜索上下文，不读取隐藏信息或运行时实体容器。

架构约束
Pattern provides tactical search-order knowledge, not tactical value；不得调用 Simulator、Probability、Evaluator、
Evaluator 或 SearchBudget internals，也不得判断合法性、修改候选 value 或建立独立搜索树。
*/
import { PRODUCTION_TACTICAL_PATTERNS } from "./ProductionPatterns.js";
import { actionIntentKey } from "../Action.js";

/*
功能
把可选字符串列表规范为去重、排序且冻结的新数组。

调用方
normalizeSelector。

输入
可选字符串数组。

输出
稳定字符串数组。

读取状态
无。

写入状态
无。

调用函数
Set、Array.sort。

边界与不变量
不保留调用方数组引用；null/undefined 视为空列表。
*/
function sortedUniqueStrings(values) {
  return Object.freeze([...new Set(values ?? [])].map(String).sort());
}

/*
功能
把 Pattern selector 规范为确定、可比较且不共享容器的 data-only 描述。

调用方
normalizePatternStep。

输入
definition 提供的 selector。

输出
字段与列表顺序稳定的新 selector。

读取状态
无。

写入状态
无。

调用函数
Array.sort、Object.entries。

边界与不变量
selector 只描述已有 legal action 的语义集合，不得携带函数、值分数或运行时实体引用。
*/
function normalizeSelector(selector = {}) {
  const selectionEquals = Object.freeze(Object.fromEntries(
    Object.entries(selector.selectionEquals ?? {}).sort(([left], [right]) => (
      left.localeCompare(right)
    ))
  ));
  return Object.freeze({
    types:sortedUniqueStrings(selector.types),
    cardIds:sortedUniqueStrings(selector.cardIds),
    excludeCardIds:sortedUniqueStrings(selector.excludeCardIds),
    includesTargetId:selector.includesTargetId ?? null,
    selectionEquals
  });
}

/*
功能
把 exact descriptor 或 selector step 编译为统一的只读匹配记录。

调用方
PatternMatcher.match。

输入
definition step 与 Action owner。

输出
包含 kind、descriptor/selector、stateAssertions、stepKey 与 identity 的记录。

读取状态
step 已声明的动作语义与状态断言。

写入状态
无。

调用函数
Action.semantic/schedulingKeyFromDescriptor、normalizeSelector。

边界与不变量
identity 只表示动作匹配语义，刻意排除状态断言，使通用/特化 Pattern 的同一 sequence 可以去重。
*/
function normalizePatternStep(step) {
  const stateAssertions = Object.freeze((step?.stateAssertions ?? []).map(
    (assertion) => Object.freeze({ ...assertion })
  ));
  if (step?.selector) {
    const selector = normalizeSelector(step.selector);
    return Object.freeze({
      kind:"selector",
      descriptor:null,
      selector,
      stateAssertions,
      stepKey:null,
      identity:JSON.stringify({ selector })
    });
  }
  const source = step?.descriptor ?? step;
  const descriptor = Object.freeze({
    type:source?.type ?? null,
    cardId:source?.cardId ?? source?.definitionId ?? source?.skillId ?? null,
    targetIds:Object.freeze(Array.isArray(source?.targetIds)
      ? [...source.targetIds]
      : source?.targetId == null ? [] : [source.targetId]),
    selection:source?.selection ?? null
  });
  const stepKey = actionIntentKey(descriptor);
  return Object.freeze({
    kind:"exact",
    descriptor:Object.freeze(descriptor),
    selector:null,
    stateAssertions,
    stepKey,
    identity:stepKey
  });
}

/*
功能
检查 selector 是否接受一个真实 legal action 的语义描述。

调用方
PatternMatcher.matchesStep。

输入
规范 selector 与 Action semantic action。

输出
是否匹配。

读取状态
动作 type/cardId/targetIds/selection。

写入状态
无。

调用函数
Array.includes、Object.entries。

边界与不变量
只判断动作已经携带的语义；不判断合法性、不读取 hidden identity，也不解释卡牌效果。
*/
function selectorMatches(selector, descriptor) {
  if (selector.types.length && !selector.types.includes(String(descriptor.type))) return false;
  if (selector.cardIds.length && !selector.cardIds.includes(String(descriptor.cardId))) return false;
  if (selector.excludeCardIds.includes(String(descriptor.cardId))) return false;
  if (selector.includesTargetId !== null
    && !(descriptor.targetIds ?? []).includes(selector.includesTargetId)) return false;
  return Object.entries(selector.selectionEquals).every(
    ([key, value]) => descriptor.selection?.[key] === value
  );
}

/*
功能
检查 step 对当前合法动作状态声明的只读断言。

调用方
PatternMatcher.matchesStep。

输入
状态断言与当前 post-prefix World。

输出
全部断言是否成立。

读取状态
World.players 中指定玩家的单层字段。

写入状态
无。

调用函数
Array.find/every。

边界与不变量
只支持正式 registry 当前需要的 equal/notEqual/arrayLengthGreaterThan；未知操作符 fail closed。
*/
function stateAssertionsMatch(assertions, state) {
  return (assertions ?? []).every((assertion) => {
    const player = state?.players?.find((entry) => entry.id === assertion.playerId);
    if (!player) return false;
    const actual = player[assertion.field];
    if (assertion.operator === "equal") return actual === assertion.value;
    if (assertion.operator === "notEqual") return actual !== assertion.value;
    if (assertion.operator === "arrayLengthGreaterThan") {
      return Array.isArray(actual) && actual.length > Number(assertion.value);
    }
    return false;
  });
}

export class PatternMatcher {
  static definitions = PRODUCTION_TACTICAL_PATTERNS;

  /*
  功能
  创建使用 canonical Action 语义身份与静态 definitions 的 PatternMatcher。

  调用方
  AIController、Worker SearchEngineFactory 与 focused tests。

  输入
  可选的测试 definitions。

  输出
  可生成搜索顺序 proposal 的 matcher。

  读取状态
  PatternMatcher.definitions。

  写入状态
  实例依赖与 definitions 的浅冻结副本。

  调用函数
  无。

  边界与不变量
  production definitions 来自唯一 registry；测试注入不得改变静态 production 列表。
  */
  constructor({ definitions = PatternMatcher.definitions } = {}) {
    this.definitions = Object.freeze([...(definitions ?? [])]);
  }

  /*
  功能
  判断 proposal 的指定 step 是否匹配当前状态中一个真实 legal action。

  调用方
  Searcher root/child scheduling、Pattern prefix 推进与 focused tests。

  输入
  proposal、零基 step index、真实 action 与该 action 生成时的 World。

  输出
  是否同时满足动作语义与只读状态断言。

  读取状态
  proposal.stepMatchers、Action 与 World 断言字段。

  写入状态
  无。

  调用函数
  Action semantic/schedulingKeyFromDescriptor、selectorMatches、stateAssertionsMatch。

  边界与不变量
  action 必须由调用方 legalActions 提供；本方法不生成、执行或评分动作，断言失败时 fail closed。
  */
  matchesStep(proposal, stepIndex, action, state) {
    const matcher = proposal?.stepMatchers?.[stepIndex];
    if (!matcher || !stateAssertionsMatch(matcher.stateAssertions, state)) return false;
    if (matcher.kind === "selector") return selectorMatches(matcher.selector, action);
    return matcher.stepKey === actionIntentKey(action);
  }

  /*
  功能
  匹配当前根上下文并生成有界、确定性的 semantic sequence proposals。

  调用方
  Searcher.search，在任何 Pattern-guided evaluation 前。

  输入
  玩家、当前 World、已去重合法根动作与现有 search structure。

  输出
  匹配数、按 exploration priority 排序的 proposals，以及固定为空的 deferredRootKeys。

  读取状态
  注入 definitions 与 Action。

  写入状态
  无。

  调用函数
  definition.match/buildSequences、Action.semantic/schedulingKeyFromDescriptor。

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
      describeAction:(action) => action,
      semanticKey:(action) => actionIntentKey(action)
    });
    let matchedPatternCount = 0;
    const proposalsByKey = new Map();
    for (const definition of this.definitions) {
      if (!definition?.match?.(context, definition)) continue;
      matchedPatternCount += 1;
      const sequences = definition.buildSequences?.(context, definition) ?? [];
      for (const sequence of sequences) {
        if (!Array.isArray(sequence?.steps)
          || sequence.steps.length === 0
          || sequence.steps.length > depth) continue;
        const stepMatchers = sequence.steps.map(
          (step) => normalizePatternStep(step)
        );
        const steps = stepMatchers.map((matcher) => matcher.kind === "exact"
          ? matcher.descriptor
          : Object.freeze({
              selector:matcher.selector,
              stateAssertions:matcher.stateAssertions
            }));
        const stepKeys = stepMatchers.map((matcher) => matcher.stepKey);
        const patternId = String(definition.id ?? sequence.patternId ?? "");
        if (!patternId) continue;
        const semanticKey = JSON.stringify(stepMatchers.map((matcher) => matcher.identity));
        const explorationPriority = Number(sequence.explorationPriority);
        const proposal = Object.freeze({
          patternId,
          steps:Object.freeze(steps),
          stepKeys:Object.freeze(stepKeys),
          stepMatchers:Object.freeze(stepMatchers),
          explorationPriority:Number.isFinite(explorationPriority) ? explorationPriority : 0,
          semanticKey,
          reason:String(sequence.reason ?? "")
        });
        const existing = proposalsByKey.get(semanticKey);
        if (!existing
          || proposal.explorationPriority > existing.explorationPriority
          || (proposal.explorationPriority === existing.explorationPriority
            && proposal.patternId.localeCompare(existing.patternId) < 0)) {
          proposalsByKey.set(semanticKey, proposal);
        }
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
