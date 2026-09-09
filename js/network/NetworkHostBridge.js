import { projectNetworkCard, projectNetworkResult } from "./NetworkViewerProjection.js";
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js";

/*
功能
装配 Host 的安全投影、有限决定选项与 presentation 观察。

调用方
MatchApplication composition。

输入
Session、getState 及既有规则查询 callbacks。

输出
wrapUi、prepareDecision、publish、dispose。

读取状态
仅 Host 的真实状态。

写入状态
仅通道 pending 与消息，不写规则状态。

调用函数
session.gameChannel、既有 legality queries。

边界与不变量
不创建 RNG、AI、Match 或 workflow；所有规则查询由原 authority 注入。
*/
export function createNetworkHostBridge({
  session, getState, canPlayCard, getActiveSkill, canUseSkill,
  getLeverageFirstTargets, getAssaultTargets, getTransferSources, getTransferReceivers
}) {
  const channel = session.gameChannel;

  /*
功能
把有限候选映射成安全 UI 选项并在 Host 保留返回值映射。

调用方
prepareDecision。

输入
kind、label、候选、数量与是否可放弃。

输出
view 和 decode。

读取状态
候选内部 returnValue。

写入状态
无。

调用函数
无。

边界与不变量
Guest 只得到序号与公开标签，不能注入 selection 对象。
*/
  function finiteDecision(kind, label, candidates, { min = 1, max = 1, canDecline = false, canonical = true } = {}) {
    const options = candidates.map((candidate, index) => ({
      optionId: canonical ? candidate.id : `option-${index}`,
      label: candidate.label,
      card: candidate.card ?? null
    }));
    return {
      view: { kind, label, options, min, max, canDecline },
      decode: (response) => {
        if (response.status === "declined") return canonical ? { status: "declined", selectedIds: [] } : null;
        if (canonical) return { status: "selected", selectedIds: [...response.selectedIds] };
        return candidates[options.findIndex((option) => option.optionId === response.selectedIds[0])].value;
      }
    };
  }

  /*
功能
把当前 Host 请求转换成只有观看者合法信息的有限决定。

调用方
NetworkGameChannel.request。

输入
内部 request。

输出
safe view 与 Host decoder，或无需输入的 immediate 值。

读取状态
Host state、actor 手中牌与合法候选。

写入状态
无。

调用函数
finiteDecision、原规则查询、projectNetworkCard。

边界与不变量
不传播 request.context/presentation 任意对象；隐藏 token 仅存在当前请求而不进入状态快照。
*/
  function prepareDecision(request) {
    const state = getState();
    const actor = state.players.find((player) => player.id === request.actorId);
    if (!actor) throw new Error("找不到远端行动者");
    if (request.kind === "player-intent") {
      const candidates = actor.hand.filter((card) => canPlayCard(actor, card).ok).map((card) => ({
        label: `使用 ${card.name}`, card: projectNetworkCard(card), value: { kind: "card", cardId: card.id }
      }));
      const skill = getActiveSkill(actor);
      if (skill && canUseSkill(actor, skill).ok) candidates.push({ label: `发动 ${skill.name}`, value: { kind: "skill" } });
      candidates.push({ label: "结束出牌", value: { kind: "end" } });
      return finiteDecision(request.kind, "你的出牌阶段", candidates, { canonical: false });
    }
    if (request.kind === "card-flow") return prepareCardFlow(request, actor);
    if (request.kind === "private-reveal") {
      const cards = state.players.flatMap((player) => player.hand).filter((card) => request.cardIds.includes(card.id));
      const prepared = finiteDecision(request.kind, request.title, [{ label: "关闭", value: true }], { canonical: false });
      // 只允许 Host 既有私密知识已记录的牌面进入揭示，不回传敌方实体身份。
      prepared.view.cards = cards.filter((card) => actor.hand.includes(card)
        || Object.values(actor.aiMemory?.knownCardsByPlayer ?? {}).some((known) => known[card.id] === card.definitionId))
        .map((card) => ({ definitionId: card.definitionId }));
      return prepared;
    }
    const label = request.context?.label || request.context?.prompt || "请选择";
    const count = request.constraints?.requiredCount ?? 1;
    let candidates;
    if (request.kind === "hiddenCard") {
      const ids = request.optionIds ?? request.options.map((option) => option.optionId);
      const owner = state.players.find((player) => player.id === request.context.ownerId);
      candidates = ids.map((id, index) => ({
        id, label: owner?.equipment?.id === id ? `装备：${owner.equipment.name}` : `手牌 ${index + 1}`,
        card: owner?.equipment?.id === id ? projectNetworkCard(owner.equipment) : null
      }));
    } else if (request.kind === "target") {
      candidates = request.options.map((option) => state.players.find((player) => player.id === option.optionId))
        .filter(Boolean).map((player) => ({ id: player.id, label: player.name }));
    } else if (request.kind === "publicCard") {
      candidates = request.options.map((option) => ({ id: option.optionId,
        label: CARD_DEFINITIONS[option.definitionId]?.name ?? "公开牌",
        card: { id: option.optionId, definitionId: option.definitionId } }));
    } else if (["response", "discard"].includes(request.kind)) {
      candidates = request.options.map((option) => actor.hand.find((card) => card.id === option.optionId))
        .filter(Boolean).map((card) => ({ id: card.id, label: card.name, card: projectNetworkCard(card) }));
    } else throw new Error(`未支持的远端决定：${request.kind}`);
    return finiteDecision(request.kind, label, candidates, {
      min: request.kind === "hiddenCard" && !request.constraints.exact ? Math.min(1, count) : count,
      max: count, canDecline: request.canDecline === true
    });
  }

  /*
功能
将既有卡牌附加选择投影成公开的有限组合。

调用方
prepareDecision。

输入
request 与 actor。

输出
有限选择或空选择 immediate。

读取状态
Host 中尚在 actor 手牌的牌及公开资源。

写入状态
无。

调用函数
getTransferSources/getTransferReceivers/getLeverageFirstTargets/getAssaultTargets。

边界与不变量
只枚举原 authority 允许的组合，不结算；客户端返回序号，实际 selection 由 Host 重绑。
*/
  function prepareCardFlow(request, actor) {
    const card = actor.hand.find((entry) => entry.id === request.cardId);
    if (!card) return { immediate: null };
    const candidates = [];
    if (card.definitionId === "transfer") {
      for (const source of getTransferSources(actor, card)) {
        for (const receiver of getTransferReceivers(actor, source, card)) {
          candidates.push({ label: `${source.name} → ${receiver.name}`, value: { sourceId: source.id, receiverId: receiver.id } });
        }
      }
    } else if (card.definitionId === "leverage") {
      for (const first of getLeverageFirstTargets(actor)) {
        for (const second of getAssaultTargets(first)) {
          candidates.push({ label: `${first.name}（${first.equipment.name}） → ${second.name}`,
            value: { firstTargetId: first.id, equipmentCardId: first.equipment.id,
              equipmentDefinitionId: first.equipment.definitionId, secondTargetId: second.id } });
        }
      }
    } else return { immediate: {} };
    return candidates.length
      ? finiteDecision("card-flow", `${card.name}：选择并确认目标组合`, candidates, { canonical: false, canDecline: true })
      : { immediate: null };
  }

  /*
功能
从本地 UI 通知中挑选可广播的公开展示信息。

调用方
wrapUi。

输入
UI method 与原始参数。

输出
白名单 presentation 或 null。

读取状态
方法名与公开反馈、终局结果。

写入状态
无。

调用函数
projectNetworkResult、projectNetworkCard。

边界与不变量
不转发原始日志、提示、私密揭示或任意参数对象，防止 Host 私有知识侧漏。
*/
  function projectPresentation(method, args) {
    if (method === "showMatchPerformance") return { kind: "result", result: projectNetworkResult(args[0]) };
    if (method === "queueFeedback") return { kind: "feedback", effect: String(args[0]), playerId: typeof args[1] === "string" ? args[1] : args[1]?.id, amount: Number(args[2]) || 0 };
    if (method === "setCurrentCard") return { kind: "action",
      card: typeof args[0] === "object" ? projectNetworkCard(args[0]) : null,
      skillName: typeof args[0] === "string" ? args[0] : null };
    if (method === "showJudgment") return { kind: "judgment", playerId: args[0]?.id, card: projectNetworkCard(args[1]) };
    if (method === "setThinking") return { kind: "thinking", playerId: args[0] ? args[1]?.id : null };
    if (method === "showDying") return { kind: "dying", playerId: args[0]?.id };
    return null;
  }

  /*
功能
在既有本地 UI 调用后发布 Host 安全状态和公开展示。

调用方
MatchApplication UI session 装配。

输入
原 UI session。

输出
仅装饰公开更新方法的 Proxy。

读取状态
原 UI 与 Host state。

写入状态
原 UI 行为和投影消息。

调用函数
Reflect.get、projectPresentation、channel.publish。

边界与不变量
不包装 input 等待，不复制私密 UI；所有更新仍由 Host workflow 驱动。
*/
  function wrapUi(ui) {
    const observed = new Set(["render", "queueFeedback", "setCurrentCard", "showJudgment", "setThinking", "showDying", "showMatchPerformance"]);
    return new Proxy(ui, {
/*
功能
为已有 UI 方法附加公开投影，不改变其 receiver。

调用方
Proxy 属性访问。

输入
目标 UI 与属性名。

输出
原值、绑定方法或观察方法。

读取状态
原 UI。

写入状态
无。

调用函数
Reflect.get、channel.publish。

边界与不变量
只有显式公开更新方法被观察，input Promise 保持原样。
*/
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (!observed.has(property)) return value.bind(target);
        return (...args) => {
          const result = value.apply(target, args);
          channel.publish(projectPresentation(property, args));
          return result;
        };
      }
    });
  }

  channel.bindHost({ getState, prepareDecision });
  return Object.freeze({ wrapUi, prepareDecision, publish: () => channel.publish(), dispose: () => channel.reset() });
}
