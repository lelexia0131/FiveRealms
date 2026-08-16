/*
模块职责
描述全体受益牌的 AI 选择顺序、期望选择与受益估值；本模型是 AI probabilistic/search model，不是 Repository Domain Rule authority。

上游
GlobalBenefitValue 价值适配器、ResponsePolicy 适配器与直接领域测试。

下游
Domain CardDefinitions、Domain CombatRules。

状态边界
只读过滤玩家、公开池计数与调用方提供的定义价值查询，返回独立普通对象。

信息边界
互利只使用公开剩余牌构成，不读取未来牌堆顺序、随机数或隐藏手牌。

架构约束
真实 card semantic（哪些牌是全体受益、共生治疗量）来自 Domain Definitions/Rules；本模型只拥有 AI 顺序优势与价值结构。不得导入 value、Controller、Planner、Simulator、Evaluator 或 UI；反制意愿与 root flip 不属于本模型。
*/
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js?build=20260816-fr-arch-14-runtime-closure";
import { calculateHealAmount } from "../../domain/rules/combat/CombatRules.js?build=20260816-fr-arch-14-runtime-closure";

const GLOBAL_BENEFIT_CARDS = new Set(
  Object.entries(CARD_DEFINITIONS)
    .filter(([, definition]) => definition.globalBenefit === true)
    .map(([definitionId]) => definitionId)
);

/*
功能
判断卡牌定义是否属于全体受益模型。

调用方
GlobalBenefitValue 价值与模拟查询与 assessGlobalBenefitOutcome。

输入
卡牌定义 ID。

输出
布尔值。

读取状态
固定全体受益定义集合。

写入状态
无。

调用函数
无。

边界与不变量
只包含互利与共生，不扩张真实卡牌规则。
*/
export function isGlobalBenefitCard(definitionId) {
  return GLOBAL_BENEFIT_CARDS.has(definitionId);
}

/*
功能
计算互利从来源开始顺时针的存活接收者 ID 顺序。

调用方
buildMutualBenefitDraftOutcome 与直接领域测试。

输入
座位顺序玩家数组与来源玩家。

输出
新的存活玩家 ID 数组。

读取状态
player.id、seatIndex 与 alive。

写入状态
无。

调用函数
无。

边界与不变量
来源优先，随后按真实座位环顺时针；输出不持有 Player 引用。
*/
export function mutualBenefitSeatOrderIds(players, source) {
  const all = Array.isArray(players) ? players : [];
  const seatCount = Math.max(1, all.length);
  const sourceSeat = Number(source?.seatIndex) || 0;
  const orderedIds = [];
  for (let offset = 0; offset < seatCount; offset += 1) {
    const player = all[(sourceSeat + offset) % seatCount];
    if (player?.alive) orderedIds.push(player.id);
  }
  return orderedIds;
}

/*
功能
按真实接收顺序从公开剩余定义池构造互利的确定性期望选择结果。

调用方
GlobalBenefitValue 价值适配器与直接领域测试。

输入
玩家、来源、公开剩余定义计数，以及由调用方注入的角色定义价值查询。

输出
含 seatOrderIds、publicPoolDefinitionOrder、recipients 与 remainingCounts 的独立结果。

读取状态
玩家公开 ID/座位/存活字段、剩余定义计数和注入价值查询。

写入状态
无。

调用函数
mutualBenefitSeatOrderIds、definitionValue。

边界与不变量
每名接收者只取当前池中最高价值定义并消耗一张；同分沿用公开池定义顺序，输入计数保持只读。
*/
export function buildMutualBenefitDraftOutcome(players, source, remainingCounts, definitionValue) {
  const pool = {};
  let total = 0;
  if (remainingCounts && typeof remainingCounts === "object" && !Array.isArray(remainingCounts)) {
    for (const [definitionId, count] of Object.entries(remainingCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      pool[definitionId] = count;
      total += count;
    }
  }
  const publicPoolDefinitionOrder = Object.keys(pool);
  const seatOrderIds = mutualBenefitSeatOrderIds(players, source);
  const recipients = [];
  for (const playerId of seatOrderIds) {
    if (total <= 0) break;
    let bestDefinitionId = null;
    let bestValue = -Infinity;
    for (const definitionId of publicPoolDefinitionOrder) {
      if (pool[definitionId] <= 0) continue;
      const value = Number(definitionValue?.(playerId, definitionId));
      const normalizedValue = Number.isFinite(value) ? value : 0;
      if (normalizedValue > bestValue) {
        bestValue = normalizedValue;
        bestDefinitionId = definitionId;
      }
    }
    if (bestDefinitionId === null) break;
    pool[bestDefinitionId] -= 1;
    total -= 1;
    recipients.push({ playerId, definitionId:bestDefinitionId, benefit:bestValue });
  }
  return {
    seatOrderIds,
    publicPoolDefinitionOrder:[...publicPoolDefinitionOrder],
    recipients:recipients.map((recipient) => ({ ...recipient })),
    remainingCounts:{ ...pool }
  };
}

/*
功能
计算单名玩家从共生获得的本次实际治疗量。

调用方
assessGlobalBenefitOutcome 与直接领域测试。

输入
过滤玩家与卡牌定义 ID。

输出
零或一的受益量。

读取状态
player.hp 与 maxHp。

写入状态
无。

调用函数
无。

边界与不变量
互利受益由公开池 recipient 模型提供；本函数不承担卡牌价值。
*/
export function directBenefitForPlayer(player, definitionId) {
  if (definitionId === "symbiosis") {
    return calculateHealAmount(
      CARD_DEFINITIONS.symbiosis.healAmount,
      player.maxHp ?? 0,
      player.hp ?? 0
    );
  }
  return 0;
}

/*
功能
从指定阵营视角汇总全体受益牌的盟友、敌方与净受益结构。

调用方
GlobalBenefitValue 价值适配器与直接领域测试。

输入
玩家、观察阵营、定义 ID，以及来源、剩余计数和注入定义价值查询。

输出
非全体受益牌为 null，否则返回独立的计数、受益、座次、公开池与 recipient 摘要。

读取状态
存活玩家公开字段和互利公开池模型。

写入状态
无。

调用函数
isGlobalBenefitCard、buildMutualBenefitDraftOutcome、directBenefitForPlayer。

边界与不变量
团队净值等于盟友受益减敌方受益；输出不持有 Player、Card 或 Game 引用。
*/
export function assessGlobalBenefitOutcome(players, battleTeam, definitionId, options = {}) {
  if (!isGlobalBenefitCard(definitionId)) return null;
  const alive = (players ?? []).filter((player) => player?.alive);
  const source = alive.find((player) => player.id === options.sourceId) ?? null;
  const draft = definitionId === "mutualBenefit"
    ? buildMutualBenefitDraftOutcome(
      alive,
      source,
      options.remainingCounts,
      options.definitionValue
    )
    : { seatOrderIds:[], publicPoolDefinitionOrder:[], recipients:[], remainingCounts:{} };
  const recipientBenefits = new Map(
    draft.recipients.map((recipient) => [recipient.playerId, recipient.benefit])
  );
  const result = {
    allyAliveCount:0,
    enemyAliveCount:0,
    allyBenefit:0,
    enemyBenefit:0,
    netBenefit:0,
    seatOrderIds:[...draft.seatOrderIds],
    publicPoolDefinitionOrder:[...draft.publicPoolDefinitionOrder],
    recipients:draft.recipients.map((recipient) => ({ ...recipient }))
  };
  for (const player of alive) {
    const allied = player.battleTeam === battleTeam;
    const benefit = definitionId === "mutualBenefit"
      ? (recipientBenefits.get(player.id) ?? 0)
      : directBenefitForPlayer(player, definitionId);
    if (allied) {
      result.allyAliveCount += 1;
      result.allyBenefit += benefit;
    } else {
      result.enemyAliveCount += 1;
      result.enemyBenefit += benefit;
    }
  }
  result.netBenefit = result.allyBenefit - result.enemyBenefit;
  return result;
}
