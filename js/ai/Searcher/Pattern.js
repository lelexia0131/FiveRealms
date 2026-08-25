/*
模块职责
唯一拥有正式 Tactical Pattern definitions、语义匹配、归一化、continuation 约束与 scheduling proposals。

上游
共享搜索组合、Searcher 与 Pattern focused tests。

下游
canonical Action intent 与 Domain CardDefinitions 的公开静态语义。

状态边界
只读传入的 World、行动者、合法 Action 与搜索结构，不创建或修改搜索状态。

信息边界
只消费调用方显式提供的可见搜索上下文、Action 公开语义和卡牌静态定义。

架构约束
Pattern 只提供探索顺序知识；不得定义合法性或价值、调用 Simulator/Probability/Evaluator、
扩大搜索预算或深度、建立第二搜索树、删除候选或改变最终 winner。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { actionIntentKey } from "../Generator/Action.js";

const ATTACK_CARD_IDS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.usageMode === "active"
      && definition.category !== "equipment"
      && definition.subtypes?.includes("attack"))
    .map((definition) => definition.definitionId)
    .sort()
);

const INFORMATION_FOLLOWUP_CARD_IDS = Object.freeze(
  Object.values(CARD_DEFINITIONS)
    .filter((definition) => definition.usageMode === "active"
      && definition.category !== "equipment"
      && definition.definitionId !== "scout"
      && definition.subtypes?.some((subtype) => [
        "attack",
        "attack-discard",
        "control",
        "equipment-control"
      ].includes(subtype)))
    .map((definition) => definition.definitionId)
    .sort()
);

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
sortedUniqueStrings、Object.entries。

边界与不变量
selector 只描述已有 legal Action 的语义集合，不得携带函数、值分数或运行时实体引用。
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
把 exact canonical Action step 或 selector step 编译为统一的只读匹配记录。

调用方
Pattern.match。

输入
definition step。

输出
包含 kind、descriptor/selector、stateAssertions、stepKey 与 identity 的记录。

读取状态
step 已声明的 canonical Action 语义与状态断言。

写入状态
无。

调用函数
actionIntentKey、normalizeSelector。

边界与不变量
identity 只表示动作匹配语义，刻意排除状态断言，使通用/特化 Pattern 的同一 sequence 可以去重；
exact step 只接受 canonical cardId/skillId/targetIds 字段。
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
    cardId:source?.type === "skill"
      ? source?.skillId ?? null
      : source?.cardId ?? null,
    targetIds:Object.freeze(Array.isArray(source?.targetIds) ? [...source.targetIds] : []),
    selection:source?.selection ?? null
  });
  const stepKey = actionIntentKey(descriptor);
  return Object.freeze({
    kind:"exact",
    descriptor,
    selector:null,
    stateAssertions,
    stepKey,
    identity:stepKey
  });
}

/*
功能
检查 selector 是否接受一个真实 legal Action 的语义描述。

调用方
Pattern.matchesStep。

输入
规范 selector 与 canonical Action。

输出
是否匹配。

读取状态
Action type/cardId/skillId/targetIds/selection。

写入状态
无。

调用函数
Array.includes、Object.entries。

边界与不变量
只判断 Action 已经携带的语义；不判断合法性、不读取 hidden identity，也不解释卡牌效果。
*/
function selectorMatches(selector, action) {
  const definitionId = action?.type === "skill" ? action?.skillId : action?.cardId;
  if (selector.types.length && !selector.types.includes(String(action?.type))) return false;
  if (selector.cardIds.length && !selector.cardIds.includes(String(definitionId))) return false;
  if (selector.excludeCardIds.includes(String(definitionId))) return false;
  if (selector.includesTargetId !== null
    && !(action?.targetIds ?? []).includes(selector.includesTargetId)) return false;
  return Object.entries(selector.selectionEquals).every(
    ([key, value]) => action?.selection?.[key] === value
  );
}

/*
功能
检查 step 对当前合法动作状态声明的只读断言。

调用方
Pattern.matchesStep。

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

/*
功能
返回上下文中指定定义的真实合法 card Actions。

调用方
全部 production Pattern definitions。

输入
Pattern context 与一个或多个 cardId。

输出
保持 legalActions 顺序的匹配动作数组。

读取状态
context.legalActions 中 canonical Action 的 type/cardId。

写入状态
无。

调用函数
Set、Array.filter。

边界与不变量
只筛选调用方已经生成的合法候选，不创造 Action 或重新判断合法性。
*/
function cardActions(context, cardIds) {
  const allowed = new Set(cardIds);
  return context.legalActions.filter(
    (action) => action.type === "card" && allowed.has(action.cardId)
  );
}

/*
功能
解析 setup Action 实际改变资源的一方，供同目标 Pattern 绑定后续攻击。

调用方
TARGET_SETUP_ASSAULT、REMOVE_RADAR_ASSAULT。

输入
canonical 掠夺、破坏或转移 Action。

输出
目标玩家 ID；无法确定时返回 null。

读取状态
Action targetIds 与 transfer selection.sourceId。

写入状态
无。

调用函数
无。

边界与不变量
转移改变的是资源来源方，因此同目标语义绑定 sourceId；不得读取被转移牌的隐藏定义。
*/
function setupTargetId(action) {
  if (action.cardId === "transfer") return action.selection?.sourceId ?? null;
  return action.targetIds?.[0] ?? null;
}

/*
功能
构造同目标 setup 后接突袭的语义 sequences。

调用方
TARGET_SETUP_ASSAULT、REMOVE_RADAR_ASSAULT。

输入
Pattern context、允许的 setup Actions、探索优先级、原因与可选 continuation 状态断言。

输出
只包含真实 root Action 语义的两步 sequences。

读取状态
context.legalActions。

写入状态
无。

调用函数
cardActions、setupTargetId。

边界与不变量
setup 与 assault 必须绑定同一目标；状态断言只在 post-setup legal Action 重新解析时检查。
*/
function sameTargetSetupSequences(
  context,
  setupActions,
  explorationPriority,
  reason,
  requireRadarRemoval = false
) {
  const assaults = cardActions(context, ["assault"]);
  const sequences = [];
  for (const setup of setupActions) {
    const targetId = setupTargetId(setup);
    if (!targetId) continue;
    for (const assault of assaults) {
      if (assault.targetIds?.[0] !== targetId) continue;
      sequences.push({
        steps:[
          setup,
          requireRadarRemoval
            ? {
                descriptor:assault,
                stateAssertions:[{
                  playerId:targetId,
                  field:"equipmentDefinitionId",
                  operator:"notEqual",
                  value:"defenseDevice"
                }]
              }
            : assault
        ],
        explorationPriority,
        reason
      });
    }
  }
  return sequences;
}

/*
功能
判断一条 data-only production definition 是否在当前根上下文命中。

调用方
Pattern.match 通过每条 definition 的共享 match 引用调用。

输入
Pattern context 与当前 definition。

输出
是否应生成该 Pattern 的 sequence proposals。

读取状态
合法根 Action、World 玩家公开装备/手牌计数/合法记忆与行动者自己的手牌。

写入状态
无。

调用函数
cardActions、setupTargetId、Array.find。

边界与不变量
不得读取未知实体牌面；命中只表示存在可提议的探索前缀，不表示 Action 会执行或最终获胜。
*/
function matchProductionPattern(context, definition) {
  switch (definition.kind) {
    case "targetSetup":
      return cardActions(context, definition.setupCardIds).length > 0
        && cardActions(context, ["assault"]).length > 0;
    case "twoCardFamilies":
      return cardActions(context, definition.firstCardIds).length > 0
        && cardActions(context, definition.secondCardIds).length > 0;
    case "prefixSelector":
      return cardActions(context, definition.firstCardIds).length > 0
        && (!definition.requiredRootCardIds
          || cardActions(context, definition.requiredRootCardIds).length > 0);
    case "sealLast":
      return cardActions(context, ["seal"]).length > 0
        && context.legalActions.some(
          (action) => action.type !== "end" && action.cardId !== "seal"
        );
    case "radarSetup":
      return cardActions(context, definition.setupCardIds).some((action) => {
        const targetId = setupTargetId(action);
        const target = context.state?.players?.find((entry) => entry.id === targetId);
        return target?.equipmentDefinitionId === "defenseDevice";
      }) && cardActions(context, ["assault"]).length > 0;
    case "reservation": {
      const actor = context.state?.players?.find(
        (entry) => entry.id === context.player?.id
      ) ?? null;
      const assaultCount = actor?.hand?.filter(
        (card) => card.definitionId === "assault"
      ).length ?? 0;
      return assaultCount >= 2
        && cardActions(context, ["assault"]).length > 0
        && cardActions(context, ["exposeWeakness"]).length > 0;
    }
    case "information":
      return cardActions(context, ["scout"]).some((action) => {
        const targetId = action.targetIds?.[0];
        const target = context.state?.players?.find((entry) => entry.id === targetId);
        return (target?.handCount ?? 0) > (target?.knownCards?.length ?? 0);
      });
    default:
      return false;
  }
}

/*
功能
把命中的 data-only production definition 展开为 semantic sequence proposals。

调用方
Pattern.match 通过每条 definition 的共享 buildSequences 引用调用。

输入
Pattern context 与当前 definition。

输出
带 steps、explorationPriority 与 reason 的普通对象数组。

读取状态
合法根 Action、目标公开装备、合法 knownCards 数量与行动者自己的 World 手牌。

写入状态
无。

调用函数
cardActions、sameTargetSetupSequences、setupTargetId。

边界与不变量
selector 只会在 Searcher 重新生成 post-state legalActions 后解析；信息断言只比较合法记忆数量，
雷达断言只接受 Simulator 已真实移除雷达的 post-state。
*/
function buildProductionSequences(context, definition) {
  if (definition.kind === "targetSetup") {
    return sameTargetSetupSequences(
      context,
      cardActions(context, definition.setupCardIds),
      definition.explorationPriority,
      definition.reason
    );
  }
  if (definition.kind === "radarSetup") {
    const radarSetups = cardActions(context, definition.setupCardIds).filter((action) => {
      const targetId = setupTargetId(action);
      const target = context.state?.players?.find((entry) => entry.id === targetId);
      return target?.equipmentDefinitionId === "defenseDevice";
    });
    return sameTargetSetupSequences(
      context,
      radarSetups,
      definition.explorationPriority,
      definition.reason,
      true
    );
  }
  if (definition.kind === "twoCardFamilies") {
    const sequences = [];
    for (const first of cardActions(context, definition.firstCardIds)) {
      for (const second of cardActions(context, definition.secondCardIds)) {
        sequences.push({
          steps:[first, second],
          explorationPriority:definition.explorationPriority,
          reason:definition.reason
        });
      }
    }
    return sequences;
  }
  if (definition.kind === "prefixSelector") {
    return cardActions(context, definition.firstCardIds).map((first) => ({
      steps:[first, { selector:definition.selector }],
      explorationPriority:definition.explorationPriority,
      reason:definition.reason
    }));
  }
  if (definition.kind === "sealLast") {
    return [{
      steps:[
        { selector:{ types:["card", "skill"], excludeCardIds:["seal"] } },
        { selector:{ types:["card"], cardIds:["seal"] } }
      ],
      explorationPriority:definition.explorationPriority,
      reason:definition.reason
    }];
  }
  if (definition.kind === "reservation") {
    const sequences = [];
    for (const earlyAssault of cardActions(context, ["assault"])) {
      for (const setup of cardActions(context, ["exposeWeakness"])) {
        sequences.push({
          steps:[
            earlyAssault,
            setup,
            { selector:{ types:["card"], cardIds:["assault"] } }
          ],
          explorationPriority:definition.explorationPriority,
          reason:definition.reason
        });
      }
    }
    return sequences;
  }
  if (definition.kind === "information") {
    const sequences = [];
    for (const scout of cardActions(context, ["scout"])) {
      const targetId = scout.targetIds?.[0];
      const target = context.state?.players?.find((entry) => entry.id === targetId);
      if (!targetId || (target?.handCount ?? 0) <= (target?.knownCards?.length ?? 0)) continue;
      const stateAssertions = [{
        playerId:targetId,
        field:"knownCards",
        operator:"arrayLengthGreaterThan",
        value:target.knownCards?.length ?? 0
      }];
      sequences.push({
        steps:[
          scout,
          {
            selector:{
              types:["card"],
              cardIds:INFORMATION_FOLLOWUP_CARD_IDS,
              includesTargetId:targetId
            },
            stateAssertions
          }
        ],
        explorationPriority:definition.explorationPriority,
        reason:definition.reason
      });
      sequences.push({
        steps:[
          scout,
          {
            selector:{
              types:["card"],
              cardIds:["transfer"],
              selectionEquals:{ sourceId:targetId }
            },
            stateAssertions
          }
        ],
        explorationPriority:definition.explorationPriority,
        reason:definition.reason
      });
    }
    return sequences;
  }
  return [];
}

const TARGET_SETUP_ASSAULT = Object.freeze({
  id:"TARGET_SETUP_ASSAULT",
  kind:"targetSetup",
  setupCardIds:Object.freeze(["plunder", "destroy", "transfer"]),
  explorationPriority:70,
  reason:"先改变目标资源状态，再探索对同一目标的突袭",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const BREAK_STANCE_ASSAULT = Object.freeze({
  id:"BREAK_STANCE_ASSAULT",
  kind:"twoCardFamilies",
  firstCardIds:Object.freeze(["exposeWeakness"]),
  secondCardIds:Object.freeze(["assault"]),
  explorationPriority:90,
  reason:"先获得破势，再探索真实合法突袭",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const EQUIP_RECYCLING_FIRST = Object.freeze({
  id:"EQUIP_RECYCLING_FIRST",
  kind:"prefixSelector",
  firstCardIds:Object.freeze(["recycleDevice"]),
  selector:Object.freeze({
    types:Object.freeze(["card", "skill"]),
    excludeCardIds:Object.freeze(["recycleDevice"])
  }),
  explorationPriority:60,
  reason:"先装备回收站，再探索 post-state 中的其它合法行动",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const ARSENAL_BEFORE_ATTACK = Object.freeze({
  id:"ARSENAL_BEFORE_ATTACK",
  kind:"prefixSelector",
  firstCardIds:Object.freeze(["battleDevice"]),
  requiredRootCardIds:Object.freeze(["assault", "shockwave"]),
  selector:Object.freeze({
    types:Object.freeze(["card"]),
    cardIds:Object.freeze(["assault", "shockwave"])
  }),
  explorationPriority:80,
  reason:"先装备军火库，再探索真实 post-state 攻击",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const CHARGE_BEFORE_SKILL = Object.freeze({
  id:"CHARGE_BEFORE_SKILL",
  kind:"prefixSelector",
  firstCardIds:Object.freeze(["charge"]),
  selector:Object.freeze({ types:Object.freeze(["skill"]) }),
  explorationPriority:75,
  reason:"聚能后从真实 post-state legal skill actions 重新解析技能",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const SEAL_LAST = Object.freeze({
  id:"SEAL_LAST",
  kind:"sealLast",
  explorationPriority:20,
  reason:"优先探索其它行动后再封印的完整路线",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const REMOVE_RADAR_ASSAULT = Object.freeze({
  id:"REMOVE_RADAR_ASSAULT",
  kind:"radarSetup",
  setupCardIds:Object.freeze(["plunder", "destroy"]),
  explorationPriority:110,
  reason:"先真实移除目标雷达，再探索对同一目标的突袭",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const SYMBIOSIS_BEFORE_ATTACK = Object.freeze({
  id:"SYMBIOSIS_BEFORE_ATTACK",
  kind:"prefixSelector",
  firstCardIds:Object.freeze(["symbiosis"]),
  requiredRootCardIds:ATTACK_CARD_IDS,
  selector:Object.freeze({ types:Object.freeze(["card"]), cardIds:ATTACK_CARD_IDS }),
  explorationPriority:55,
  reason:"共生后探索 CardDefinitions 标记为 attack 的真实合法动作",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const ATTACK_BEFORE_MUTUAL_BENEFIT = Object.freeze({
  id:"ATTACK_BEFORE_MUTUAL_BENEFIT",
  kind:"prefixSelector",
  firstCardIds:ATTACK_CARD_IDS,
  requiredRootCardIds:Object.freeze(["mutualBenefit"]),
  selector:Object.freeze({ types:Object.freeze(["card"]), cardIds:Object.freeze(["mutualBenefit"]) }),
  explorationPriority:50,
  reason:"先完成真实攻击，再探索互利",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const PRESERVE_BREAK_STANCE_FOR_LATE_ASSAULT = Object.freeze({
  id:"PRESERVE_BREAK_STANCE_FOR_LATE_ASSAULT",
  kind:"reservation",
  explorationPriority:100,
  reason:"有多次突袭资源时，把破势保留给靠后的真实突袭",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const SCOUT_INFORMATION_SETUP = Object.freeze({
  id:"SCOUT_INFORMATION_SETUP",
  kind:"information",
  explorationPriority:45,
  reason:"窥探真实暴露新信息后，再探索针对同一目标的合法行动",
  match:matchProductionPattern,
  buildSequences:buildProductionSequences
});

const PRODUCTION_PATTERNS = Object.freeze([
  TARGET_SETUP_ASSAULT,
  BREAK_STANCE_ASSAULT,
  EQUIP_RECYCLING_FIRST,
  ARSENAL_BEFORE_ATTACK,
  CHARGE_BEFORE_SKILL,
  SEAL_LAST,
  REMOVE_RADAR_ASSAULT,
  SYMBIOSIS_BEFORE_ATTACK,
  ATTACK_BEFORE_MUTUAL_BENEFIT,
  PRESERVE_BREAK_STANCE_FOR_LATE_ASSAULT,
  SCOUT_INFORMATION_SETUP
]);

export class Pattern {
  static definitions = PRODUCTION_PATTERNS;

  /*
  功能
  创建使用 canonical Action 语义身份与静态 definitions 的 Pattern owner。

  调用方
  共享搜索组合 与 focused tests。

  输入
  可选的测试 definitions。

  输出
  可生成搜索顺序 proposal 的 Pattern。

  读取状态
  Pattern.definitions。

  写入状态
  实例 definitions 的浅冻结副本。

  调用函数
  无。

  边界与不变量
  production definitions 来自本模块唯一 registry；测试注入不得改变静态 production 列表。
  */
  constructor({ definitions = Pattern.definitions } = {}) {
    this.definitions = Object.freeze([...(definitions ?? [])]);
  }

  /*
  功能
  判断 proposal 的指定 step 是否匹配当前状态中一个真实 legal Action。

  调用方
  Searcher root/child scheduling、Pattern prefix 推进与 focused tests。

  输入
  proposal、零基 step index、真实 canonical Action 与该 Action 生成时的 World。

  输出
  是否同时满足动作语义与只读状态断言。

  读取状态
  proposal.stepMatchers、Action 与 World 断言字段。

  写入状态
  无。

  调用函数
  actionIntentKey、selectorMatches、stateAssertionsMatch。

  边界与不变量
  Action 必须由调用方 legalActions 提供；本方法不生成、执行或评分动作，断言失败时 fail closed。
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
  玩家、当前 World、已去重合法根 Action 与现有 search structure。

  输出
  匹配数、按 exploration priority 排序的 proposals，以及固定为空的 deferredRootKeys。

  读取状态
  注入 definitions 与 canonical Action。

  写入状态
  无。

  调用函数
  definition.match/buildSequences、normalizePatternStep。

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
      structure:Object.freeze({ ...structure })
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
        const stepMatchers = sequence.steps.map(normalizePatternStep);
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
