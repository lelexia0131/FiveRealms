/*
模块职责
把全体受益领域结果投影为角色卡牌价值与团队净受益数值。

上游
ResponsePolicy、SearchPrior、Simulation 与 AIController 组合根。

下游
domain/GlobalBenefitModel 与 value/CardValue。

状态边界
只读过滤后的玩家和公开剩余牌计数，返回新的普通数值对象。

信息边界
互利只使用公开剩余定义计数，不读取未来牌堆顺序或未知手牌实体。

架构约束
只负责 Value 投影；不决定响应、不执行模拟、不持有 Game 或 Controller。
*/
import { getBaseCardAiValue, getRoleCardAiValue } from "./CardValue.js?build=20260815-shadow-agent-p1-slot";
import {
  assessGlobalBenefitOutcome,
  buildMutualBenefitDraftOutcome
} from "../domain/GlobalBenefitModel.js?build=20260815-shadow-agent-p1-slot";

/*
功能
按角色身份读取卡牌有效价值，并在角色定义不可用时回退全局基础值。

调用方
mutualBenefitDraftValues 与 assessGlobalBenefit。

输入
角色定义 ID 与卡牌定义 ID。

输出
有限卡牌价值。

读取状态
正式 CardValue 配置。

写入状态
无。

调用函数
getBaseCardAiValue、getRoleCardAiValue。

边界与不变量
回退只处理缺失角色身份或未知角色，不改变已定义的角色差量。
*/
function cardValueFor(generalId, definitionId) {
  if (!generalId) return getBaseCardAiValue(definitionId);
  try {
    return getRoleCardAiValue(generalId, definitionId);
  } catch {
    return getBaseCardAiValue(definitionId);
  }
}

/*
功能
把互利公开池的逐座次选择结果投影为每名接收者的期望牌值。

调用方
CardEffectSimulation 与直接价值测试。

输入
过滤玩家、来源玩家与公开剩余定义计数。

输出
以玩家 ID 为键的期望选牌价值对象。

读取状态
玩家角色 ID、公开座次和 CardValue。

写入状态
无。

调用函数
buildMutualBenefitDraftOutcome、cardValueFor。

边界与不变量
座次和牌池消耗只由 Domain owner 决定；本函数只提供价值查询并投影结果。
*/
export function mutualBenefitDraftValues(players, source, remainingCounts) {
  const playersById = new Map((players ?? []).map((player) => [player.id, player]));
  const outcome = buildMutualBenefitDraftOutcome(
    players,
    source,
    remainingCounts,
    (playerId, definitionId) => cardValueFor(
      playersById.get(playerId)?.generalId,
      definitionId
    )
  );
  return Object.fromEntries(
    outcome.recipients.map((recipient) => [recipient.playerId, recipient.benefit])
  );
}

/*
功能
从指定阵营视角计算互利或共生的盟友、敌方与团队净受益。

调用方
ResponsePolicy、SearchPrior、Simulation 与 AIController 组合根。

输入
过滤玩家、观察阵营、卡牌定义、来源 ID 与公开剩余定义计数。

输出
非全体受益牌为 null，否则返回团队计数与受益摘要。

读取状态
玩家公开字段、CardValue 与 GlobalBenefitModel 领域结果。

写入状态
无。

调用函数
assessGlobalBenefitOutcome、cardValueFor。

边界与不变量
Domain 拥有 recipient 结构；此处只移除领域细节并保留既有 Value 输出字段。
*/
export function assessGlobalBenefit(
  players,
  battleTeam,
  definitionId,
  sourceId = null,
  remainingCounts = null
) {
  const playersById = new Map((players ?? []).map((player) => [player.id, player]));
  const result = assessGlobalBenefitOutcome(players, battleTeam, definitionId, {
    sourceId,
    remainingCounts,
    definitionValue:(playerId, candidateDefinitionId) => cardValueFor(
      playersById.get(playerId)?.generalId,
      candidateDefinitionId
    )
  });
  if (!result) return null;
  return {
    allyAliveCount:result.allyAliveCount,
    enemyAliveCount:result.enemyAliveCount,
    allyBenefit:result.allyBenefit,
    enemyBenefit:result.enemyBenefit,
    netBenefit:result.netBenefit
  };
}
