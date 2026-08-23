/*
模块职责
声明正式 Tactical Pattern registry，只描述应优先探索的语义动作序列。

上游
PatternMatcher 与 Pattern focused tests。

下游
Domain CardDefinitions 的公开静态语义。

状态边界
只读 PatternMatcher 提供的 SearchState、行动者与合法动作快照，不修改任何状态。

信息边界
只消费动作已携带的公开语义、SearchState 中合法可见/记忆字段和卡牌静态定义。

架构约束
不得调用 Simulator、Evaluator、Value、SearchPrior、SearchPolicy 或 ActionGenerator；
definition 只能产生语义 sequence、explorationPriority、reason 与匹配约束。
*/
import { CARD_DEFINITIONS } from "../../../domain/definitions/cards/CardDefinitions.js";

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
返回上下文中指定定义的真实合法 card actions。

调用方
全部 production Pattern definitions。

输入
Pattern context 与一个或多个 definitionId。

输出
保持 legalActions 顺序的匹配动作数组。

读取状态
context.legalActions 与 ActionDescriptor 投影能力。

写入状态
无。

调用函数
context.describeAction。

边界与不变量
只筛选调用方已经生成的合法候选，不创造动作或重新判断合法性。
*/
function cardActions(context, definitionIds) {
  const allowed = new Set(definitionIds);
  return context.legalActions.filter((action) => {
    const descriptor = context.describeAction(action);
    return descriptor.type === "card" && allowed.has(descriptor.cardId);
  });
}

/*
功能
解析 setup action 实际改变资源的一方，供同目标 Pattern 绑定后续攻击。

调用方
TARGET_SETUP_ASSAULT、REMOVE_RADAR_ASSAULT。

输入
Pattern context 与掠夺、破坏或转移动作。

输出
目标玩家 ID；无法确定时返回 null。

读取状态
动作公开 targetIds 与 transfer selection.sourceId。

写入状态
无。

调用函数
context.describeAction。

边界与不变量
转移改变的是资源来源方，因此同目标语义绑定 sourceId；不得读取被转移牌的隐藏定义。
*/
function setupTargetId(context, action) {
  const descriptor = context.describeAction(action);
  if (descriptor.cardId === "transfer") return descriptor.selection?.sourceId ?? null;
  return descriptor.targetIds?.[0] ?? null;
}

/*
功能
返回 SearchState 中与当前行动者对应的搜索玩家。

调用方
PRESERVE_BREAK_STANCE_FOR_LATE_ASSAULT。

输入
Pattern context。

输出
搜索玩家；不存在时返回 null。

读取状态
context.state.players 与 context.player.id。

写入状态
无。

调用函数
Array.find。

边界与不变量
不得回退读取真实 Game/Player 手牌；Worker 与 Main Thread 必须消费同一 SearchState 表示。
*/
function searchActor(context) {
  return context.state?.players?.find((entry) => entry.id === context.player?.id) ?? null;
}

/*
功能
构造同目标 setup 后接突袭的语义 sequences。

调用方
TARGET_SETUP_ASSAULT、REMOVE_RADAR_ASSAULT。

输入
Pattern context、允许的 setup actions、探索优先级、原因与可选 continuation 状态断言。

输出
只包含真实 root action 语义的两步 sequences。

读取状态
context.legalActions。

写入状态
无。

调用函数
cardActions、setupTargetId、context.describeAction。

边界与不变量
setup 与 assault 必须绑定同一目标；状态断言只在 post-setup legal action 重新解析时检查。
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
    const targetId = setupTargetId(context, setup);
    if (!targetId) continue;
    for (const assault of assaults) {
      const assaultDescriptor = context.describeAction(assault);
      if (assaultDescriptor.targetIds?.[0] !== targetId) continue;
      sequences.push({
        steps:[
          context.describeAction(setup),
          requireRadarRemoval
            ? {
                descriptor:assaultDescriptor,
                stateAssertions:[{
                  playerId:targetId,
                  field:"equipmentDefinitionId",
                  operator:"notEqual",
                  value:"defenseDevice"
                }]
              }
            : assaultDescriptor
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
PatternMatcher 通过每条 definition 的共享 match 引用调用。

输入
Pattern context 与当前 definition。

输出
是否应生成该 Pattern 的 sequence proposals。

读取状态
合法根动作、SearchState 玩家公开装备/手牌计数/合法记忆与行动者自己的手牌。

写入状态
无。

调用函数
cardActions、setupTargetId、searchActor。

边界与不变量
不得读取未知实体牌面；命中只表示存在可提议的探索前缀，不表示动作会执行或最终获胜。
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
        && context.legalActions.some((action) => {
          const descriptor = context.describeAction(action);
          return descriptor.type !== "end" && descriptor.cardId !== "seal";
        });
    case "radarSetup":
      return cardActions(context, definition.setupCardIds).some((action) => {
        const targetId = setupTargetId(context, action);
        const target = context.state?.players?.find((entry) => entry.id === targetId);
        return target?.equipmentDefinitionId === "defenseDevice";
      }) && cardActions(context, ["assault"]).length > 0;
    case "reservation": {
      const actor = searchActor(context);
      const assaultCount = actor?.hand?.filter(
        (card) => card.definitionId === "assault"
      ).length ?? 0;
      return assaultCount >= 2
        && cardActions(context, ["assault"]).length > 0
        && cardActions(context, ["exposeWeakness"]).length > 0;
    }
    case "information":
      return cardActions(context, ["scout"]).some((action) => {
        const targetId = context.describeAction(action).targetIds?.[0];
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
PatternMatcher 通过每条 definition 的共享 buildSequences 引用调用。

输入
Pattern context 与当前 definition。

输出
带 steps、explorationPriority 与 reason 的普通对象数组。

读取状态
合法根动作、目标公开装备、合法 knownCards 数量与行动者自己的 SearchState 手牌。

写入状态
无。

调用函数
cardActions、sameTargetSetupSequences、setupTargetId。

边界与不变量
selector 只会在 Planner 重新生成 post-state legalActions 后解析；信息断言只比较合法记忆数量，
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
      const targetId = setupTargetId(context, action);
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
          steps:[context.describeAction(first), context.describeAction(second)],
          explorationPriority:definition.explorationPriority,
          reason:definition.reason
        });
      }
    }
    return sequences;
  }
  if (definition.kind === "prefixSelector") {
    return cardActions(context, definition.firstCardIds).map((first) => ({
      steps:[context.describeAction(first), { selector:definition.selector }],
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
            context.describeAction(earlyAssault),
            context.describeAction(setup),
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
      const targetId = context.describeAction(scout).targetIds?.[0];
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
          context.describeAction(scout),
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
          context.describeAction(scout),
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

export const PRODUCTION_TACTICAL_PATTERNS = Object.freeze([
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
