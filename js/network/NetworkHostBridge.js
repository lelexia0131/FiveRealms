import { projectNetworkCard, projectNetworkResult } from "./NetworkViewerProjection.js";
import { CARD_DEFINITIONS } from "../domain/definitions/cards/CardDefinitions.js";
import { createHiddenSelectionView } from "../ui/handVisibility.js";
import { presentCard } from "../adapters/ui/CardPresentationDefinitions.js";
import { presentLogFact } from "../ui/LogPresentation.js";
import { presentTargetDistance } from "../ui/TargetPresentation.js";
import { presentPrompt } from "../ui/PromptPresentation.js";
import { NETWORK_LOG_CHUNK_ENTRIES, NETWORK_LOG_CHUNK_BYTES } from "./NetworkProtocol.js";

/*
功能
装配 Host 的安全投影、有限决定选项与 presentation 观察。

调用方
MatchApplication composition。

输入
Session、getState、只读 getAiSpeed 及既有规则查询 callbacks。

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
  session, getState, getAiSpeed, canPlayCard, getActiveSkill, canUseSkill,
  getLeverageFirstTargets, getAssaultTargets, getTransferSources, getTransferReceivers, describeDistance, isCardKnownTo
}) {
  const channel = session.gameChannel;
  const publicLogs = new Map();
  const publicLogBoundaries = [];
  const logOffsets = new Map();
  let logRollbackRevision = 0;
  let prompt = null;
  let promptRevision = 0;
  let hostUi = null;

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
finiteDecision、原规则查询、projectNetworkCard、createHiddenSelectionView、isCardKnownTo、presentTargetDistance。

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
      const prepared = finiteDecision(request.kind, request.title, [{ label: "关闭", value: true }], { canonical: false });
      // 只允许 Host 既有私密知识已记录的牌面进入揭示，不回传敌方实体身份。
      prepared.view.cards = [];
      for (const id of request.cardIds) {
        const owner = state.players.find((player) => player.hand.some((card) => card.id === id));
        const card = owner?.hand.find((entry) => entry.id === id);
        if (card && isCardKnownTo(actor, owner, card)) prepared.view.cards.push({ definitionId: card.definitionId });
      }
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
      prepared.view.targetDisplay = Object.fromEntries(state.players.filter((target) => target.id !== actor.id).map((target) => {
        const info = describeDistance(actor, target);
        const available = candidates.some((candidate) => candidate.id === target.id);
        const distanceState = presentTargetDistance(actor, target, card, info.distance, info.range);
        return [target.id, {
          distance: info.distance,
          range: info.range,
          seat: info.seat,
          reachable: target.alive && info.distance <= info.range,
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
getTransferSources/getTransferReceivers/getLeverageFirstTargets/getAssaultTargets、describeDistance、presentTargetDistance。

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
    if (!candidates.length) return { immediate: null };
    const prepared = finiteDecision("card-flow", `${card.name}：选择并确认目标组合`, candidates, { canonical: false, canDecline: true });
    prepared.view.card = projectNetworkCard(card);
    const sources = card.definitionId === "leverage" ? [actor, ...getLeverageFirstTargets(actor)] : [actor];
    prepared.view.flowDisplay = Object.fromEntries(sources.map((source) => [source.id,
      Object.fromEntries(getState().players.filter((target) => target.id !== source.id).map((target) => {
        const info = describeDistance(source, target);
        return [target.id, { ...info, reachable: target.alive && info.distance <= info.range,
          distanceState: presentTargetDistance(source, target, source === actor ? card : CARD_DEFINITIONS.assault, info.distance, info.range) }];
      }))
    ]));
    return prepared;
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
    if (method === "playSound" && ["playCard", "skill"].includes(args[0])) return { kind: "action-cue", cue: args[0] };
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
原 UI 行为、viewer 提示、有效日志缓存及其追加边界和投影消息。

调用函数
Reflect.get、presentPrompt、projectPresentation、channel.publish。

边界与不变量
不包装 input 等待；只有正式 prompt 描述和结算音效可投影，私密 UI 不广播；日志按正式尾部边界回滚。
*/
  function wrapUi(ui) {
    hostUi = ui;
    const observed = new Set(["render", "setPrompt", "playSound", "appendLog", "restoreLogBoundary", "queueFeedback", "setCurrentCard", "resetCurrentCard", "showJudgment", "hideJudgment", "setThinking", "showDying", "hideDying", "showDuel", "hideDuel", "playRadarSuccess", "playLightningHit", "showMatchPerformance"]);
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
        return (...args) => publishUiCall(target, property, value, args);
      }
    });
  }

  /*
  功能
  观察正式 UI 展示调用并同步 viewer 提示、结算 cue 与有效日志边界。

  调用方
  wrapUi 的方法代理。

  输入
  UI receiver、方法名、原方法与实参。

  输出
  原方法结果。

  读取状态
  正式提示描述、Guest viewer 与日志追加数量。

  写入状态
  原 UI、prompt revision、publicLogs 与其尾部边界。

  调用函数
  原 UI 方法、presentPrompt、projectPublicLog、projectPresentation、channel.publish。

  边界与不变量
  不广播本地私密提示或点击音效；rollback 只删除越界尾项，不重扫或重建历史日志。
  */
  function publishUiCall(target, property, value, args) {
    const result = value.apply(target, args);
    if (property === "setPrompt") {
      // 只有受控 presentation 描述可投影；本地选牌和私密 UI 文案不广播。
      if (!args[2]) return result;
      prompt = structuredClone(args[2]);
      promptRevision += 1;
    }
    if (property === "playSound" && !["playCard", "skill"].includes(args[0])) return result;
    if (property === "appendLog") {
      const projections = new Map();
      for (const seat of session.snapshot().matchSetup.players) {
        if (seat.controller.type === "GUEST") projections.set(seat.playerId, projectPublicLog(args[0], seat.playerId));
      }
      publicLogs.set(args[0].id, projections);
      publicLogBoundaries.push({ id: args[0].id, count: args[1] });
    }
    if (property === "restoreLogBoundary") {
      logRollbackRevision += 1;
      while (publicLogBoundaries.at(-1)?.count > args[0]) publicLogs.delete(publicLogBoundaries.pop().id);
      for (const [viewerId, offset] of logOffsets) logOffsets.set(viewerId, Math.min(offset, publicLogBoundaries.length));
    }
    channel.publish(projectPresentation(property, args));
    return result;
  }

  /*
  功能
  从 Host 查询公开距离并提供已按 Guest 知识渲染的正式日志。

  调用方
  NetworkGameChannel.publish。

  输入
  当前 Guest viewerId；resetLogs 仅用于显式恢复。

  输出
  公开展示 DTO。

  读取状态
  Host AI 速度、公开玩家、viewerId、距离查询和日志展示字段。

  写入状态
  当前 viewer 的日志发送位置。

  调用函数
  getAiSpeed、describeDistance、presentTargetDistance。

  边界与不变量
  距离和日志均由 Host 展示边界生成；不发送日志内部事实或其他 viewer 知识。
  */
  function getDisplay(viewerId, resetLogs = false) {
    const state = getState();
    const viewer = state.players.find((player) => player.id === viewerId);
    return {
      aiSpeed: getAiSpeed(),
      prompt: prompt && { ...presentPrompt(prompt, viewerId), revision: promptRevision },
      distances: Object.fromEntries(state.players.filter((target) => viewer?.alive && target.id !== viewer.id)
        .map((target) => {
          const info = describeDistance(viewer, target);
          return [target.id, {
            ...info,
            reachable: target.alive && info.distance <= info.range,
            distanceState: presentTargetDistance(viewer, target, null, info.distance, info.range)
          }];
        })),
      logSync: getLogChunk(viewerId, resetLogs)
    };
  }

  /*
  功能
  从既有 viewer-safe 日志缓存提取有界的下一块。

  调用方
  getDisplay。

  输入
  viewerId 与是否从头恢复。

  输出
  起点、有效总边界及日志条目。

  读取状态
  publicLogs、正式日志边界和该 viewer 的发送位置。

  写入状态
  仅 viewer 发送位置；不改变正式日志。

  调用函数
  TextEncoder.encode、JSON.stringify。

  边界与不变量
  普通更新不扫描历史；回滚先收缩发送位置，恢复按需继续拉取。单条正式日志仍受原 Transport payload 上限约束。
  */
  function getLogChunk(viewerId, resetLogs) {
    const start = resetLogs ? 0 : (logOffsets.get(viewerId) ?? 0);
    const entries = [];
    let bytes = 2;
    for (let index = start; index < publicLogBoundaries.length && entries.length < NETWORK_LOG_CHUNK_ENTRIES; index += 1) {
      const entry = publicLogs.get(publicLogBoundaries[index].id).get(viewerId);
      const size = new TextEncoder().encode(JSON.stringify(entry)).length + Number(entries.length > 0);
      if (entries.length && bytes + size > NETWORK_LOG_CHUNK_BYTES) break;
      entries.push(entry);
      bytes += size;
    }
    logOffsets.set(viewerId, start + entries.length);
    return { start, total: publicLogBoundaries.length, rollbackRevision: logRollbackRevision, entries };
  }

  /*
  功能
  把正式日志转换成 Guest viewer 可安全展示的片段。

  调用方
  wrapUi 的 appendLog 观察入口。

  输入
  正式 MatchLogAdapter 的日志 entry 和目标 viewerId。

  输出
  白名单日志 DTO。

  读取状态
  公开日志 fragments、结构化日志事实与 Session 的 Guest viewer。

  写入状态
  无。

  调用函数
  presentLogFact。

  边界与不变量
  结构化事实按 Guest 的事件时知识渲染；纯字符串必须是调用方确认公开的文本，禁止从 Host 文案推断或替换私密牌名。
  */
  function projectPublicLog(entry, viewerId) {
    if (entry.presentationFact) {
      return { id: entry.id, kind: entry.kind, fragments: presentLogFact(entry.presentationFact, viewerId) };
    }
    return {
      id: entry.id, kind: entry.kind,
      fragments: entry.fragments.map((fragment) => fragment.type === "player"
        ? { type: "player", text: fragment.text, playerId: fragment.playerId, battleTeam: fragment.battleTeam }
        : { type: "text", text: fragment.text })
    };
  }


  /*
功能
把 authoritative 席位控制元数据应用到原有 Player。

调用方
NetworkGameChannel.syncControllers。

输入
Session 的 Match setup 投影。

输出
无。

读取状态
Host 当前 roster 与 controller ownership。

写入状态
仅 Player.controlType/controllerType/networkRole。

调用函数
getState。

边界与不变量
不更换对象，不写 character、阵营、资源、手牌、状态或回合数据。
*/

  function syncControllers(setup) {
    if (!setup) return;
    let changed = false;
    for (const seat of setup.players) {
      const player = getState().players.find((entry) => entry.id === seat.playerId);
      if (!player) continue;
      changed ||= player.controlType !== seat.controlType || player.networkRole !== seat.networkRole;
      player.controlType = seat.controlType;
      player.controllerType = seat.controlType === "AI" ? "ai" : "human";
      player.networkRole = seat.networkRole;
    }
    if (changed) hostUi?.render();
  }

  /*
功能
声明联机控制权不随卡牌 Action 建立历史副本。

调用方
既有 ActionTransaction participant 扩展点。

输入
无。

输出
null checkpoint。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
房间成员和连接生命周期不属于可回滚的卡牌状态。
*/

  function captureActionCheckpoint() {
    return null;
  }

  /*
功能
在 Action 原位回滚后重新投影当前有效的席位控制权。

调用方
既有 ActionTransaction.rollback。

输入
无；不读取旧 checkpoint。

输出
无。

读取状态
Session 当前 ownership。

写入状态
仅现有 Player 的控制元数据。

调用函数
channel.syncControllers。

边界与不变量
角色资源仍由原 transaction 恢复；断线或踢人不能被卡牌回滚撤销。
*/

  function restoreActionCheckpoint() {
    channel.syncControllers();
  }

  channel.bindHost({ getState, prepareDecision, getDisplay, syncControllers });
  return Object.freeze({
    wrapUi, prepareDecision, publish: () => channel.publish(), dispose: () => channel.reset(),
    captureActionCheckpoint, restoreActionCheckpoint
  });
}
