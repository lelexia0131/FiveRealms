/*
模块职责
唯一拥有同一 parent 候选间的 end 机会成本与 seal 使用时机项。

上游
CandidateMaterializer。

下游
Economics 的既有 END cap/资源尺度、CardValue 与 ResourceSelectionPolicy。

状态边界
只读行动者自己的 before/after SearchState 手牌身份，并更新候选的显式数值字段。

信息边界
只理解行动者自己的可见手牌、动作终止类型和候选 base transition；不读取敌方隐藏牌。

架构约束
不得执行弃牌或其它模拟、组合最终价值、决定 beam、复制弃牌评分或拥有 Seal 领域概率模型。
*/
import { cardAvailability } from "../value/CardValue.js";
import { END_OPPORTUNITY_CAP, RESOURCE_MATERIAL_SCALE } from "../value/Economics.js";
import { getDiscardKeepValue } from "../policy/ResourceSelectionPolicy.js";

export class SiblingTransitionTerms {
  /*
  功能
  在同一 parent 的候选完整物化后产生 end opportunity term。

  调用方
  CandidateMaterializer.finalizeSiblings。

  输入
  带 action/baseTransition 的同层候选。

  输出
  endFallbackBase；终止候选获得包含真实 sibling 机会成本的 baseTransition。

  读取状态
  候选动作类型、定义和 base transition。

  写入状态
  只修改候选的显式数值 term。

  调用函数
  无。

  边界与不变量
  END cap、正收益 non-end sibling 与 forced-discard option 保持既有运算顺序；
  depth 只属于搜索 horizon，不得缩放终止机会成本；
  end 自身的 base（含手牌上限弃牌等状态变化）叠加在机会成本之上，不能被覆盖丢失。
  */
  finalize(candidates) {
    let bestPositiveMarginal = 0;
    const forcedDiscardByCardId = new Map();
    for (const candidate of candidates) {
      if (!this.isTerminalAction(candidate.action)) continue;
      for (const option of candidate.forcedDiscardOptions ?? []) {
        const previous = forcedDiscardByCardId.get(option.cardId);
        if (!previous || option.value > previous.value) {
          forcedDiscardByCardId.set(option.cardId, option);
        }
      }
    }
    let bestForcedDiscardOpportunity = 0;
    for (const candidate of candidates) {
      if (!this.isTerminalAction(candidate.action)) {
        bestPositiveMarginal = Math.max(
          bestPositiveMarginal,
          candidate.baseTransition
        );
        const forcedOption = forcedDiscardByCardId.get(candidate.action.card?.id);
        if (forcedOption) {
          // 深层概率世界中“会被弃”和“动作可执行”都可能不足 1；标量机会项只能取两者交集上界，
          // 不能因为存在一个低概率合法动作就把整张确定弃牌的选择权重复放大。
          const executionProbability = Math.max(
            0,
            Math.min(1, Number(candidate.action.executionProbability ?? 1) || 0)
          );
          const executableFraction = forcedOption.discardedProbability > 0
            ? Math.min(1, executionProbability / forcedOption.discardedProbability)
            : 0;
          bestForcedDiscardOpportunity = Math.max(
            bestForcedDiscardOpportunity,
            forcedOption.value * executableFraction
          );
        }
      }
    }
    const forcedDiscardOpportunity = Math.min(
      END_OPPORTUNITY_CAP,
      bestForcedDiscardOpportunity
    );
    const endFallbackBase = -Math.min(
      END_OPPORTUNITY_CAP,
      Math.max(bestPositiveMarginal, forcedDiscardOpportunity)
    );
    for (const candidate of candidates) {
      if (this.isTerminalAction(candidate.action)) {
        // 机会成本只覆盖“放弃继续出牌”的部分；end 自身状态变化（例如手牌上限弃牌）
        // 仍必须保留在最终 base 中，否则会被 end 的 sibling 项整段覆盖丢失。
        const ownBase = Number(candidate.baseTerms?.baseTransition);
        candidate.baseTransition = endFallbackBase
          + (Number.isFinite(ownBase) ? ownBase : 0);
        candidate.forcedDiscardOpportunity = forcedDiscardOpportunity;
      }
    }
    return { endFallbackBase, forcedDiscardOpportunity };
  }

  /*
  功能
  识别 end 已实际弃掉的自身手牌选择权，供同层合法 card sibling 匹配。

  调用方
  CandidateMaterializer.materialize 的终止候选路径。

  输入
  before/after SearchState、行动者 ID 与 Simulator 生成的正式弃牌上下文。

  输出
  每个被弃可见实体的 cardId、definitionId、丢失概率与终止机会价值。

  读取状态
  只读行动者自己的 hand/availability、角色、生命和显式弃牌上下文。

  写入状态
  无。

  调用函数
  CardValue.cardAvailability、ResourceSelectionPolicy.getDiscardKeepValue。

  边界与不变量
  after 必须来自既有 mandatory discard 模拟；未知容量没有 definitionId，不能虚构价值；
  Policy keep value 只在终止时按资源尺度进入一次，并由 finalize 限定为确有合法 sibling 的卡牌。
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
