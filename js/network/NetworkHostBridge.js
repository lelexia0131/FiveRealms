import { projectNetworkCard, projectNetworkResult } from "./NetworkViewerProjection.js";
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js";
import { createHiddenSelectionView } from "../ui/handVisibility.js";
import { presentCard } from "../adapters/ui/CardPresentationDefinitions.js";
import { presentOpeningLog } from "../ui/OpeningLogPresentation.js";

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
  getLeverageFirstTargets, getAssaultTargets, getTransferSources, getTransferReceivers, describeDistance
}) {
  const channel = session.gameChannel;
  const publicLogs = new Map();

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
      intent: candidate.value?.kind ?? null,
      targetIds: candidate.value?.firstTargetId ? [candidate.value.firstTargetId, candidate.value.secondTargetId]
        : candidate.value?.sourceId ? [candidate.value.sourceId, candidate.value.receiverId] : null,
      card: candidate.card ?? null,
      ...(candidate.zone ? { zone: candidate.zone } : {})
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
finiteDecision、原规则查询、projectNetworkCard、createHiddenSelectionView。

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
      const slots = new Map(createHiddenSelectionView(actor, owner, request.selection).map((slot) => [slot.token, slot]));
      candidates = ids.map((id, index) => ({
        id, label: owner?.equipment?.id === id ? `装备：${owner.equipment.name}` : `手牌 ${index + 1}`,
        zone: owner?.equipment?.id === id ? "equipment" : "hand",
        card: owner?.equipment?.id === id ? presentCard(projectNetworkCard(owner.equipment))
          : slots.get(id)?.known ? slots.get(id) : null
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
    const prepared = finiteDecision(request.kind, label, candidates, {
      min: request.kind === "hiddenCard" && !request.constraints.exact ? Math.min(1, count) : count,
      max: count, canDecline: request.canDecline === true
    });
    if (request.kind === "target") {
      const card = actor.hand.find((entry) => entry.id === request.context?.cardId);
      prepared.view.card = projectNetworkCard(card);
      prepared.view.targetDisplay = Object.fromEntries(state.players.filter((target) => target.alive && target.id !== actor.id).map((target) => {
        const info = describeDistance(actor, target);
        const available = candidates.some((candidate) => candidate.id === target.id);
        const distanceState = card?.definitionId === "assault" && target.battleTeam !== actor.battleTeam
          ? `距离 ${info.distance} · ${available ? "可突袭" : info.distance > info.range ? "超出攻击范围" : "不可选"}`
          : `距离 ${info.distance} · ${available ? "可选" : "不可选"}`;
        return [target.id, {
          distance: info.distance,
          range: info.range,
          seat: info.seat,
          reachable: info.distance <= info.range,
          available,
          distanceState
        }];
      }));
    }
    if (request.kind === "response") prepared.view.response = {
      type: request.constraints.responseType,
      eventText: request.context?.presentation?.eventText ?? label,
      responseText: request.context?.presentation?.responseText ?? "请选择是否响应",
      buttonLabel: request.context?.presentation?.buttonLabel ?? label,
      declineLabel: request.context?.presentation?.declineLabel,
      availabilityText: request.context?.presentation?.availabilityText,
      eventFragments: request.context?.presentation?.eventFragments?.map((fragment) => fragment.type === "player"
        ? { type: "player", text: fragment.text, playerId: fragment.playerId, battleTeam: fragment.battleTeam }
        : { type: "text", text: fragment.text })
    };
    return prepared;
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
    if (["hideJudgment", "hideDying", "hideDuel", "resetCurrentCard"].includes(method)) return { kind: "clear", view: method };
    if (["playRadarSuccess", "playLightningHit"].includes(method)) return { kind: "vfx", view: method, playerId: args[0] };
    if (method === "showDuel") return { kind: "duel", playerId: args[0]?.id, opponentId: args[1]?.id };
    if (method === "showMatchPerformance") return { kind: "result", result: projectNetworkResult(args[0]) };
    if (method === "queueFeedback") return { kind: "feedback", effect: String(args[0]), playerId: typeof args[1] === "string" ? args[1] : args[1]?.id, amount: Number(args[2]) || 0, variant: args[3] };
    if (method === "setCurrentCard") return { kind: "action",
      card: typeof args[0] === "object" ? projectNetworkCard(args[0]) : null,
      skillName: typeof args[0] === "string" ? args[0] : null,
      source: args[1], targetLabel: args[2], displayTargets: args[3] };
    if (method === "showJudgment") return { kind: "judgment", playerId: args[0]?.id, card: projectNetworkCard(args[1]), delayedStatus: args[2]?.delayedStatusContext };
    if (method === "setThinking") return { kind: "thinking", playerId: args[0] ? args[1]?.id : null, message: args[2] };
    if (method === "showDying") return { kind: "dying", playerId: args[0]?.id, currentHp: args[1]?.currentHp, need: args[1]?.need };
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
    const observed = new Set(["render", "appendLog", "restoreLogBoundary", "queueFeedback", "setCurrentCard", "resetCurrentCard", "showJudgment", "hideJudgment", "setThinking", "showDying", "hideDying", "showDuel", "hideDuel", "playRadarSuccess", "playLightningHit", "showMatchPerformance"]);
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
          if (property === "appendLog") publicLogs.set(args[0].id, projectPublicLog(args[0]));
          channel.publish(projectPresentation(property, args));
          return result;
        };
      }
    });
  }

  /*
  功能
  从 Host 查询公开距离并脱敏正式日志的本地可见牌名。

  调用方
  NetworkGameChannel.publish。

  输入
  无。

  输出
  公开展示 DTO。

  读取状态
  Host 公开玩家、viewerId、距离查询和日志展示字段。

  写入状态
  无。

  调用函数
  describeDistance。

  边界与不变量
  距离、射程、可达性和说明统一由 Host 生成；窃取、掠夺、转移日志含 Host 本人牌名时必须在广播前去除；不发送日志原始附加字段。
  */
  function getDisplay() {
    const state = getState();
    const viewerId = session.snapshot().matchSetup?.players.find((player) => player.role === "GUEST")?.playerId;
    const viewer = state.players.find((player) => player.id === viewerId);
    return {
      distances: Object.fromEntries(state.players.filter((target) => viewer?.alive && target.alive && target.id !== viewer.id)
        .map((target) => {
          const info = describeDistance(viewer, target);
          return [target.id, {
            ...info,
            reachable: info.distance <= info.range,
            distanceState: `距离 ${info.distance} · ${info.distance <= info.range ? "射程内" : "射程外"}`
          }];
        })),
      // 只广播经正式日志展示边界确认的条目；state.logs 中其它数据不自动获得公开权限。
      logs: (state.logs ?? []).filter((entry) => publicLogs.has(entry.id)).map((entry) => publicLogs.get(entry.id))
    };
  }

  /*
  功能
  把正式日志转换成 Guest viewer 可安全展示的片段。

  调用方
  wrapUi 的 appendLog 观察入口。

  输入
  正式 MatchLogAdapter 的日志 entry。

  输出
  白名单日志 DTO。

  读取状态
  公开日志 fragments、结构化开局事实与 Session 的 Guest viewer。

  写入状态
  无。

  调用函数
  presentOpeningLog、String.replace。

  边界与不变量
  三类私有牌转移日志统一隐去牌名，不借当前牌区猜测历史可见性；其它字段不复制。
  */
  function projectPublicLog(entry) {
    if (entry.presentationFact?.type === "opening") {
      const viewerId = session.snapshot().matchSetup.players.find((player) => player.role === "GUEST").playerId;
      return { id: entry.id, kind: entry.kind, fragments: presentOpeningLog(entry.presentationFact, viewerId) };
    }
    const privateTransfer = /转移给了|处掠夺了|并收入手牌/.test(entry.message ?? "");
    return {
      id: entry.id, kind: entry.kind,
      fragments: (entry.fragments ?? [{ type: "text", text: entry.message ?? "" }]).map((fragment) => {
        if (fragment.type === "player") return {
          type: "player", text: fragment.text, playerId: fragment.playerId, battleTeam: fragment.battleTeam
        };
        // 窃取是已公开的技能名；牌名在所有 viewer 的日志中保守隐藏。
        const text = privateTransfer ? fragment.text.replace(/「([^」]+)」/g, (match, name) => name === "窃取" ? match : "一张牌") : fragment.text;
        return { type: "text", text };
      })
    };
  }


  channel.bindHost({ getState, prepareDecision, getDisplay });
  return Object.freeze({ wrapUi, prepareDecision, publish: () => channel.publish(), dispose: () => channel.reset() });
}
