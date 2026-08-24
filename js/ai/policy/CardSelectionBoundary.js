/*
模块职责
作为转移牌的临时真实执行边界，把 Domain 合法 source/receiver 与 TransferPolicy 描述解析回当前实体。

上游
AiController 与 CardIntentRuntime 转移执行路径。

下游
Domain CardRules、AI RuleProjection 与 TransferPolicy。

状态边界
只读 runtime 当前 state/Player；不移动卡牌，真实移动仍由 Application runtime 执行。

信息边界
known identity 来自自己手牌或合法 aiMemory；unknown 只按匿名位置解析，不读取真实 definitionId。

架构约束
本边界只保留转移专属 residue；不得重新加入 discard、public/hidden card、destroy/plunder 或通用资源选择。
*/
import {
  findPlayerFact,
  getTransferReceiverIds
} from "../../domain/rules/card/CardRules.js";
import { projectTransferRulePlayers } from "../state/RuleProjection.js";
import {
  buildTransferCandidates,
  chooseBestPositiveTransfer,
  chooseTransferHandCandidate
} from "./TransferPolicy.js";

export class CardSelectionBoundary {
  /*
  功能
  绑定转移执行所需的当前状态、Belief counts 与运行时随机源。

  调用方
  AIController 组合根与转移边界测试。

  输入
  random/getState/remainingCounts 窄 runtime capability。

  输出
  可解析转移实体的临时边界。

  读取状态
  保存显式能力引用。

  写入状态
  写实例依赖字段。

  调用函数
  无。

  边界与不变量
  不保存 Game、Evaluator 或任何 card/resource selection owner；该边界等待 Transfer closure 删除。
  */
  constructor(runtime) {
    if (!runtime || typeof runtime.random !== "function") {
      throw new TypeError("CardSelectionBoundary 缺少 runtime 能力：random");
    }
    this.getState = typeof runtime.getState === "function"
      ? runtime.getState
      : () => runtime.state ?? { players:[] };
    this.remainingCounts = typeof runtime.remainingCounts === "function"
      ? runtime.remainingCounts
      : () => null;
    this.random = runtime.random;
  }

  /*
  功能
  按 TransferPolicy 返回的 known/anonymous 描述解析真实转移手牌实体。

  调用方
  AIController.chooseHiddenCards 的 transfer-only 分支。

  输入
  行动者、来源、合法实体候选、数量、接收者上下文、排除 ID 与可选 Belief counts。

  输出
  当前仍存在的真实 Card 实体数组。

  读取状态
  自己手牌或合法 aiMemory、TransferPolicy 与 runtime RNG。

  写入状态
  仅 anonymous 胜出时推进随机源。

  调用函数
  chooseTransferHandCandidate。

  边界与不变量
  unknown 描述不携带 definitionId；只有胜出后才从非 known 位置解析物理实体。
  */
  chooseTransferCards({
    actor,
    owner,
    cards,
    count,
    receiver,
    excludedCardIds = null,
    remainingCardCounts = null
  }) {
    const selected = [];
    const candidates = [...(cards ?? [])];
    const exclusions = new Set(excludedCardIds ?? []);
    const known = actor.aiMemory?.knownCardsByPlayer?.[owner.id] ?? {};
    const counts = remainingCardCounts ?? this.remainingCounts(actor);
    while (selected.length < count && candidates.length) {
      const choice = chooseTransferHandCandidate(
        actor,
        owner,
        receiver,
        exclusions,
        counts
      );
      if (!choice) break;
      let index = choice.selectionKind === "known"
        ? candidates.findIndex((card) => card.id === choice.cardId)
        : -1;
      if (choice.selectionKind === "unknown") {
        const unknownIndices = [];
        for (let current = 0; current < candidates.length; current += 1) {
          if (!known[candidates[current].id]) unknownIndices.push(current);
        }
        index = unknownIndices[Math.floor(this.random() * unknownIndices.length)] ?? -1;
      }
      if (index < 0) break;
      const [card] = candidates.splice(index, 1);
      selected.push(card);
      exclusions.add(card.id);
    }
    return selected;
  }

  /*
  功能
  从 Domain CardRules 给出的合法 source/receiver 集合选择最佳转移描述。

  调用方
  AIController、CardIntentRuntime 与转移专项测试。

  输入
  行动者、转移牌、合法来源、接收者限制与排除 ID。

  输出
  冻结 transfer selection 或 null。

  读取状态
  当前 MatchState、Domain CardRules、Belief counts 与 TransferPolicy。

  写入状态
  无。

  调用函数
  getTransferReceiverIds、buildTransferCandidates、chooseBestPositiveTransfer。

  边界与不变量
  只保留 Transfer-specific legality binding；不改变方向、分数、阈值或执行 adapter 语义。
  */
  chooseTransferCombination(
    actor,
    card,
    sources,
    allowedReceiverIds = null,
    excludedCardIds = null
  ) {
    const remainingCardCounts = this.remainingCounts(actor);
    const players = this.getState()?.players ?? [];
    return chooseBestPositiveTransfer(buildTransferCandidates({
      actor,
      sources,
      allowedReceiverIds,
      excludedCardIds,
      remainingCardCounts,
      getReceivers:(from) => {
        const exclusions = excludedCardIds ?? (card?.id ? new Set([card.id]) : null);
        const facts = projectTransferRulePlayers(players, exclusions);
        const actorFact = findPlayerFact(facts, actor.id);
        const fromFact = findPlayerFact(facts, from.id);
        const receiverIds = getTransferReceiverIds(facts, actorFact, fromFact, card);
        return players.filter((player) => receiverIds.includes(player.id));
      }
    }));
  }
}
