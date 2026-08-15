/*
模块职责
唯一拥有同一 parent 候选间的 end 机会成本与 seal 使用时机项。

上游
CandidateMaterializer。

下游
Economics 的既有 END cap 与 SealTiming。

状态边界
只读并更新候选的显式数值字段，不读取 SearchState。

信息边界
只理解动作的终止类型、封印定义标识和候选 base transition。

架构约束
不得执行模拟、组合最终价值、决定 beam 或拥有 Seal 领域概率模型。
*/
import { END_OPPORTUNITY_CAP } from "../value/Economics.js?build=20260815-card-estimate-parity-fix";
import { sealDelayCost, sealEarlyUsePenalty } from "./SealTiming.js?build=20260815-card-estimate-parity-fix";

export class SiblingTransitionTerms {
  /*
  功能
  在同一 parent 的候选完整物化后产生 end opportunity 与 seal timing term。

  调用方
  CandidateMaterializer.finalizeSiblings。

  输入
  带 action/baseTransition 的同层候选与当前 depth。

  输出
  endFallbackBase；候选获得最终 baseTransition 与 sealTimingPenalty。

  读取状态
  候选动作类型、定义和 base transition。

  写入状态
  只修改候选的显式数值 term。

  调用函数
  sealDelayCost、sealEarlyUsePenalty。

  边界与不变量
  END cap、正收益 non-end sibling、non-seal sibling 与 depth 公式保持既有运算顺序；
  end 自身的 base（含手牌上限弃牌等状态变化）叠加在机会成本之上，不能被覆盖丢失。
  */
  finalize(candidates, depth) {
    let bestNonSealBase = -Infinity;
    let bestPositiveMarginal = 0;
    for (const candidate of candidates) {
      if (candidate.action.card?.definitionId !== "seal"
        && !this.isTerminalAction(candidate.action)) {
        bestNonSealBase = Math.max(bestNonSealBase, candidate.baseTransition);
      }
      if (!this.isTerminalAction(candidate.action)) {
        bestPositiveMarginal = Math.max(
          bestPositiveMarginal,
          candidate.baseTransition * depth
        );
      }
    }
    const endFallbackBase = -Math.min(
      END_OPPORTUNITY_CAP,
      bestPositiveMarginal
    ) / depth;
    for (const candidate of candidates) {
      if (this.isTerminalAction(candidate.action)) {
        // 机会成本只覆盖“放弃继续出牌”的部分；end 自身状态变化（例如手牌上限弃牌）
        // 仍必须保留在最终 base 中，否则会被 end 的 sibling 项整段覆盖丢失。
        const ownBase = Number(candidate.baseTerms?.baseTransition);
        candidate.baseTransition = endFallbackBase
          + (Number.isFinite(ownBase) ? ownBase : 0);
      }
      candidate.sealTimingPenalty = candidate.action.card?.definitionId === "seal"
        ? sealEarlyUsePenalty(sealDelayCost(bestNonSealBase, depth))
        : 0;
    }
    return { endFallbackBase };
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
