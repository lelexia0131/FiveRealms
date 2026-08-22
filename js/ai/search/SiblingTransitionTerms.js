/*
模块职责
唯一拥有同一 parent 候选的 end 兼容收口、弃牌诊断与 seal 使用时机项。

上游
CandidateMaterializer。

下游
Economics 的资源尺度、CardValue 与 ResourceSelectionPolicy。

状态边界
只读行动者自己的 before/after SearchState 手牌身份，并更新候选的显式数值字段。

信息边界
只理解行动者自己的可见手牌、动作终止类型和候选 base transition；不读取敌方隐藏牌。

架构约束
不得执行弃牌或其它模拟、组合最终价值、决定 beam、复制弃牌评分或拥有 Seal 领域概率模型。
*/
import { cardAvailability } from "../value/CardValue.js";
import { RESOURCE_MATERIAL_SCALE } from "../value/Economics.js";
import { getDiscardKeepValue } from "../policy/ResourceSelectionPolicy.js";

export class SiblingTransitionTerms {
  /*
  功能
  在同一 parent 的候选完整物化后确认 end 不附加独立机会成本。

  调用方
  CandidateMaterializer.finalizeSiblings。

  输入
  带 action/baseTransition 的同层候选。

  输出
  零值 endFallbackBase；终止候选保留自身 after-state delta。

  读取状态
  候选动作类型、定义和 base transition。

  写入状态
  只修改候选的显式数值 term。

  调用函数
  无。

  边界与不变量
  sibling 自身已经参与最终候选比较，不能再作为 end 的负项重复进入；
  强制弃牌由 end after-state delta 表达，forced-discard option 只保留为诊断。
  */
  finalize(candidates) {
    for (const candidate of candidates) {
      if (this.isTerminalAction(candidate.action)) {
        candidate.baseTransition = Number(candidate.baseTerms?.baseTransition) || 0;
        candidate.forcedDiscardOpportunity = 0;
      }
    }
    return { endFallbackBase:0, forcedDiscardOpportunity:0 };
  }

  /*
  功能
  识别 end 已实际弃掉的自身手牌选择权，供候选诊断解释。

  调用方
  CandidateMaterializer.materialize 的终止候选路径。

  输入
  before/after SearchState、行动者 ID 与 Simulator 生成的正式弃牌上下文。

  输出
  每个被弃可见实体的 cardId、definitionId、丢失概率与诊断保留价值。

  读取状态
  只读行动者自己的 hand/availability、角色、生命和显式弃牌上下文。

  写入状态
  无。

  调用函数
  CardValue.cardAvailability、ResourceSelectionPolicy.getDiscardKeepValue。

  边界与不变量
  after 必须来自既有 mandatory discard 模拟；未知容量没有 definitionId，不能虚构价值；
  Policy keep value 只生成诊断字段，不进入 sibling finalization 或 Final Utility。
  */
  forcedDiscardOptions(beforeState, afterState, actorId, keepContext = {}) {
    const beforeActor = beforeState?.players?.find((player) => player.id === actorId);
    const afterActor = afterState?.players?.find((player) => player.id === actorId);
    if (!beforeActor || !afterActor || !Array.isArray(beforeActor.hand)) return [];
    const afterById = new Map(
      (afterActor.hand ?? []).map((card) => [card.id, cardAvailability(card)])
    );
    return beforeActor.hand.flatMap((card) => {
      if (!card?.id || !card.definitionId) return [];
      const discardedProbability = Math.max(
        0,
        cardAvailability(card) - (afterById.get(card.id) ?? 0)
      );
      if (discardedProbability <= 0) return [];
      const keepValue = Math.max(0, getDiscardKeepValue(beforeActor, card, keepContext));
      return [{
        cardId:card.id,
        definitionId:card.definitionId,
        discardedProbability,
        value:keepValue * RESOURCE_MATERIAL_SCALE * discardedProbability
      }];
    });
  }

  /*
  功能
  判断动作是否为搜索的显式结束动作。

  调用方
  finalize 与 CandidateMaterializer 的 fallback/序列截断。

  输入
  候选动作。

  输出
  是否为 end。

  读取状态
  action.type。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不检查 Game 合法性，结束动作仍必须来自已注入候选集合。
  */
  isTerminalAction(action) {
    return action?.type === "end";
  }
}
