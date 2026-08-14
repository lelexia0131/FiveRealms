/*
模块职责
保留闪电领域查询的历史函数签名，并把 ID 型正式输出适配为旧 Player 引用输出。

上游
历史测试与尚未迁移的外部调用方。

下游
domain/LightningModel。

状态边界
只读调用方玩家数组；所有概率与传播算法均由正式 Domain owner 执行。

信息边界
不增加隐藏信息；对象引用仅是旧 API 边界的 ID 回绑。

架构约束
不得复制闪电状态、判定、座位环或命中分布算法。
*/
import {
  buildLightningHitDistribution as buildDomainLightningHitDistribution,
  buildLightningPropagationChainIds,
  nextLightningReceiverId
} from "./domain/LightningModel.js?build=20260814-ai-policy-domain";

export {
  equipmentJudgmentProbability,
  getLightningStatusStateBranches,
  hasLightning,
  lightningPresenceProbability
} from "./domain/LightningModel.js?build=20260814-ai-policy-domain";

/*
功能
保留返回 Player 的历史下一闪电接收者签名。

调用方
历史测试与迁移期外部调用方。

输入
玩家数组与当前持有者。

输出
与正式 holderId 匹配的输入玩家；不存在时为 null。

读取状态
玩家 ID。

写入状态
无。

调用函数
domain/LightningModel.nextLightningReceiverId、Array.find。

边界与不变量
接收者算法只在正式 Domain owner 中；本函数只做 ID 回绑。
*/
export function nextLightningReceiver(players, holder) {
  const receiverId = nextLightningReceiverId(players, holder);
  return (players ?? []).find((player) => player?.id === receiverId) ?? null;
}

/*
功能
保留返回 Player 数组的历史闪电传播链签名。

调用方
历史测试与迁移期外部调用方。

输入
玩家数组与初始持有者。

输出
按正式 ID 顺序回绑的输入玩家数组。

读取状态
玩家 ID。

写入状态
无。

调用函数
domain/LightningModel.buildLightningPropagationChainIds、Map.get。

边界与不变量
传播算法只在正式 Domain owner 中；本函数不改变顺序或过滤结果。
*/
export function buildLightningPropagationChain(players, initialHolder) {
  const playersById = new Map((players ?? []).map((player) => [player.id, player]));
  return buildLightningPropagationChainIds(players, initialHolder)
    .map((playerId) => playersById.get(playerId))
    .filter(Boolean);
}

/*
功能
保留 holder 字段为 Player 的历史闪电命中分布签名。

调用方
历史测试与迁移期外部调用方。

输入
过滤状态与初始持有者。

输出
将正式 holderId 回绑为 holder 的概率结果数组。

读取状态
state.players 的玩家 ID。

写入状态
无。

调用函数
domain/LightningModel.buildLightningHitDistribution、Map.get。

边界与不变量
概率算法与质量只来自正式 Domain owner；本函数仅恢复旧字段形状。
*/
export function buildLightningHitDistribution(state, initialHolder) {
  const playersById = new Map((state?.players ?? []).map((player) => [player.id, player]));
  return buildDomainLightningHitDistribution(state, initialHolder)
    .map((outcome) => ({
      holder:playersById.get(outcome.holderId),
      hop:outcome.hop,
      probability:outcome.probability
    }))
    .filter((outcome) => Boolean(outcome.holder));
}
