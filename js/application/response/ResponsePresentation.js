/*
模块职责
构建 response family 的 data-only player-visible presentation DTO；不含 DOM 渲染、Domain 规则、Choice 或 workflow。

上游
application/response ResponseWorkflow 与 tests。

下游
UI adapter。

状态边界
只读传入公开上下文；不写状态。

信息边界
只输出公开 ID/name/battleTeam/text/fragment；不输出隐藏牌定义或 Card entity。

架构约束
不得依赖 concrete UI/AI/Audio/Diagnostics、Game runtime、EventDispatcher 或 Domain mutation。
*/

/*
功能
返回响应者视角的玩家显示名。

调用方
ResponsePresentation helpers。

输入
responder 与 player。

输出
“你”或 player.name/未知角色。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不输出隐藏牌信息。
*/
const responsePlayerName = (responder, player) => player?.id === responder?.id ? "你" : (player?.name ?? "未知角色");
/*
功能
返回公开 playerId 的响应者视角显示名。

调用方
ResponsePresentation helpers。

输入
responder、playerId 与 playerName。

输出
“你”或公开名称。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只使用公开名称。
*/
const publicPlayerName = (responder, playerId, playerName) => playerId === responder?.id ? "你" : (playerName ?? "未知角色");
/*
功能
构建公开玩家上下文 DTO。

调用方
ResponseWorkflow counter context。

输入
真实 Player 或公开 player-like。

输出
冻结公开字段 DTO 或 null。

读取状态
公开字段。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不复制隐藏手牌或 AI 内部状态。
*/
export const publicPlayerContext = (player) => player ? Object.freeze({
  id:player.id,
  name:player.name,
  controllerType:player.controllerType,
  battleTeam:player.battleTeam,
  hp:player.hp,
  maxHp:player.maxHp,
  shield:player.shield,
  energy:player.energy,
  alive:player.alive
}) : null;

/*
功能
构建响应目标显示名。

调用方
ResponsePresentation。

输入
responder 与公开 context。

输出
目标名文本。

读取状态
无。

写入状态
无。

调用函数
responsePlayerName。

边界与不变量
targetLabel 优先。
*/
function responseTargetName(responder, context = {}) {
  if (context.targetLabel) return context.targetLabel;
  const targets = (context.targets ?? []).filter(Boolean);
  if (targets.length) return targets.map((target) => responsePlayerName(responder, target)).join("、");
  return context.target ? responsePlayerName(responder, context.target) : "";
}

/*
功能
创建纯文本 presentation fragment。

调用方
ResponsePresentation helpers。

输入
text。

输出
冻结 fragment。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
data-only。
*/
const textFragment = (text) => Object.freeze({ type:"text", text:String(text) });

/*
功能
创建玩家 presentation fragment。

调用方
ResponsePresentation helpers。

输入
player-like、text 与 battleTeam。

输出
冻结 player fragment 或 text fragment。

读取状态
公开玩家字段。

写入状态
无。

调用函数
Object.freeze、textFragment。

边界与不变量
不携带 Card entity 或隐藏信息。
*/
const playerFragment = (player, text, battleTeam) => {
  if (!player?.id) return textFragment(text ?? "未知角色");
  return Object.freeze({
    type:"player",
    text:String(text ?? player.name ?? "未知角色"),
    playerId:player.id,
    battleTeam:battleTeam ?? player.battleTeam
  });
};

/** 返回目标角色的展示片段；与 responseTargetName 使用同一数据源，不解析 eventText。 */
/*
功能
构建响应目标 fragment 列表。

调用方
buildResponsePresentation。

输入
responder 与公开 context。

输出
fragment 数组。

读取状态
无。

写入状态
无。

调用函数
responsePlayerName、textFragment、playerFragment。

边界与不变量
目标顺序不变。
*/
function responseTargetFragments(responder, context = {}) {
  if (context.targetLabel) return [textFragment(context.targetLabel)];
  const targets = (context.targets ?? []).filter(Boolean);
  const list = targets.length ? targets : (context.target ? [context.target] : []);
  const fragments = [];
  list.forEach((target, index) => {
    if (index > 0) fragments.push(textFragment("、"));
    const display = responsePlayerName(responder, target);
    fragments.push(display === "你" ? textFragment("你") : playerFragment(target, display));
  });
  return fragments;
}

/** 延迟状态事件只以当前状态持有者和状态本身为主体，不借用普通出牌 source。 */
/*
功能
构建延迟状态响应事件 fragments。

调用方
buildResponsePresentation。

输入
responder 与 context。

输出
fragment 数组或 null。

读取状态
公开 delayedStatus/statusCounter 字段。

写入状态
无。

调用函数
publicPlayerName、textFragment、playerFragment。

边界与不变量
只使用持有者公开身份。
*/
function delayedStatusEventFragments(responder, context = {}) {
  const delayedStatus = context.delayedStatusContext ?? (context.statusCounterContext
    ? {
        ownerId:context.statusCounterContext.holderId,
        ownerName:context.statusCounterContext.holderName,
        ownerBattleTeam:context.statusCounterContext.holderBattleTeam,
        statusId:context.statusCounterContext.statusId,
        statusName:context.statusCounterContext.statusName,
        event:"beforeJudgment"
      }
    : null);
  if (!delayedStatus) return null;
  const ownerDisplay = publicPlayerName(
    responder, delayedStatus.ownerId, delayedStatus.ownerName
  );
  const ownerFragment = ownerDisplay === "你"
    ? textFragment("你的")
    : playerFragment(
        { id:delayedStatus.ownerId, name:delayedStatus.ownerName },
        `${delayedStatus.ownerName}的`,
        delayedStatus.ownerBattleTeam
      );
  const eventSuffix = delayedStatus.event === "judgmentSuccess"
    ? delayedStatus.statusId === "lightning"
      ? "判定成功，被「闪电」击中。"
      : "判定成功。"
    : delayedStatus.event === "judgmentFailure"
      ? "判定未生效。"
      : "即将判定。";
  return [ownerFragment, textFragment(`「${delayedStatus.statusName}」${eventSuffix}`)];
}

/** 只包含公开名称与数量的响应展示数据；UI 不接收任何隐藏牌内容。 */
/*
功能
构建 data-only response presentation DTO。

调用方
Application Response Workflow 与 tests。

输入
responder、type、context、requiredCount、availableCount 与 fallbackLabel。

输出
冻结 { eventText,eventFragments,responseText,availabilityText,responseCardName,buttonLabel,requiredCount,availableCount }。

读取状态
公开上下文。

写入状态
无。

调用函数
delayedStatusEventFragments、responsePlayerName、playerFragment、responseTargetFragments、publicPlayerName。

边界与不变量
不渲染 DOM；不输出隐藏 definitionIds。
*/
export function buildResponsePresentation(responder, type, context = {}, requiredCount = 1, availableCount = 0, fallbackLabel = "响应") {
  const actionName = context.card?.name ?? context.actionName ?? "伤害";
  let eventFragments = delayedStatusEventFragments(responder, context);
  let sourceFragment = null;
  if (!eventFragments) {
    const sourceName = responsePlayerName(responder, context.source);
    sourceFragment = sourceName === "你"
      ? textFragment("你")
      : playerFragment(context.source, sourceName);
    eventFragments = [sourceFragment];
    if (context.card?.targetType !== "self") {
      const targetFragments = responseTargetFragments(responder, context);
      if (targetFragments.length) {
        eventFragments.push(textFragment("对"));
        eventFragments.push(...targetFragments);
      }
    }
    eventFragments.push(textFragment(`使用了「${actionName}」。`));
  }
  let responseText = `你可以进行${fallbackLabel}。`;
  let responseCardName = fallbackLabel;
  let buttonLabel = fallbackLabel;

  if (type === "block") {
    responseCardName = "格挡";
    buttonLabel = requiredCount > 1 ? `使用${requiredCount}张「格挡」` : "格挡";
    responseText = `你需要打出${requiredCount}张「格挡」。`;
  } else if (type === "counter") {
    responseCardName = "反制";
    buttonLabel = "反制";
    if (context.statusCounterContext) {
      const statusCounter = context.statusCounterContext;
      const statusName = statusCounter.statusName;
      if (statusCounter.counterOutcome === "cancel") {
        responseText = `是否使用「反制」，取消本次判定并解除「${statusName}」？`;
      } else {
        responseText = `是否使用「反制」，取消本次判定并转移「${statusName}」？`;
      }
    } else if (context.card?.definitionId === "transfer" && context.publicTransferContext) {
      const transfer = context.publicTransferContext;
      const fromDisplay = publicPlayerName(responder, transfer.fromPlayerId, transfer.fromName);
      const receiverDisplay = publicPlayerName(responder, transfer.receiverPlayerId, transfer.receiverName);
      eventFragments = [
        sourceFragment,
        textFragment("准备将"),
        fromDisplay === "你"
          ? textFragment("你")
          : playerFragment({ id:transfer.fromPlayerId, name:transfer.fromName }, transfer.fromName, transfer.fromBattleTeam),
        textFragment(`的${transfer.safeItemLabel}转移给`),
        receiverDisplay === "你"
          ? textFragment("你")
          : playerFragment({ id:transfer.receiverPlayerId, name:transfer.receiverName }, transfer.receiverName, transfer.receiverBattleTeam),
        textFragment("。")
      ];
      responseText = "你可以使用「反制」取消这次转移。";
    } else if (context.card?.definitionId === "counter" && context.counteredCardName) {
      eventFragments = [
        sourceFragment,
        textFragment("对"),
        ...responseTargetFragments(responder, context),
        textFragment(`打出的「${context.counteredCardName}」使用了「反制」。`)
      ];
      responseText = "你可以继续使用「反制」。";
    } else {
      responseText = context.targetScoped
        ? `你可以使用「反制」，仅取消「${actionName}」对你的效果；其他目标仍会继续结算。`
        : "你可以使用「反制」。";
    }
  } else if (type === "assaultDiscard") {
    responseCardName = "突袭";
    buttonLabel = "打出突袭";
    if (context.card?.definitionId === "duel") {
      eventFragments = [
        sourceFragment,
        textFragment("向"),
        ...responseTargetFragments(responder, context),
        textFragment("发起了「决斗」。")
      ];
      responseText = "现在轮到你打出1张「突袭」。";
    } else {
      responseText = "你需要打出1张「突袭」。";
    }
  } else if (type === "leverageAssault") {
    responseCardName = "突袭";
    buttonLabel = "使用「突袭」";
    eventFragments = [
      sourceFragment,
      textFragment("对你使用了「借势」，要求你对"),
      ...responseTargetFragments(responder, context),
      textFragment("使用「突袭」。")
    ];
    responseText = `你可以使用1张「突袭」；若拒绝，对方将获得你的「${context.equipment?.name ?? "指定装备"}」。`;
  } else if (type === "dyingRescue") {
    responseCardName = "调息";
    buttonLabel = "使用「调息」";
    eventFragments = [
      ...responseTargetFragments(responder, context),
      textFragment("已进入濒死状态。")
    ];
    responseText = "现在轮到你使用「调息」进行救援。";
  } else if (type === "skill") {
    responseCardName = context.responseName ?? fallbackLabel;
    buttonLabel = context.buttonLabel ?? fallbackLabel;
    responseText = `你可以发动「${responseCardName}」。`;
  }

  let availabilityText = "";
  if (requiredCount > 0) {
    if (responseCardName === "反制" && availableCount === 0) {
      availabilityText = "你没有可用的「反制」，只能放弃响应。";
    } else if (availableCount < requiredCount) {
      const heldText = availableCount > 0 ? `只有${availableCount}张` : "没有";
      const unavailableAction = type === "block" ? "格挡"
        : type === "dyingRescue" ? "救援"
          : type === "assaultDiscard" || type === "leverageAssault" ? "使用「突袭」" : "完成响应";
      availabilityText = `需要${requiredCount}张「${responseCardName}」，你当前${heldText}，无法${unavailableAction}。`;
    } else {
      availabilityText = `需要${requiredCount}张「${responseCardName}」，当前有${availableCount}张。`;
    }
  }
  const eventText = eventFragments.map((fragment) => fragment.text).join("");
  return Object.freeze({
    eventText,
    eventFragments:Object.freeze(eventFragments.map((fragment) => Object.freeze(fragment))),
    responseText, availabilityText, responseCardName, buttonLabel, requiredCount, availableCount
  });
}

