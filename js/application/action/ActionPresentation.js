/*
模块职责
拥有 card/skill action 的展示文案与显示目标决策：目标标签、自然战斗日志与 result-only 卡牌使用日志抑制；不拥有 legality、effect 或 generic Action lifecycle。

上游
composition root 与 Application Action/Turn。

下游
无。

状态边界
只读公开玩家/卡牌事实；不写状态。

信息边界
不读取 hidden hand 或 AI memory。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher 或 concrete adapters。
*/
import { getEnemies } from "../../domain/state/queries/MatchQueries.js?build=20260818-skill-rules-locality-refactor";

const RESULT_ONLY_CARD_IDS = new Set(["charge", "recover", "shield"]);

/*
功能
为中央结算卡生成纯展示 displayTargets。

调用方
composition root 的 ActionWorkflow wiring。

输入
MatchState、source、cardOrSkill 与已决定 targets。

输出
展示目标数组或 null。

读取状态
targetType 与存活敌人。

写入状态
无。

调用函数
getEnemies。

边界与不变量
只决定展示投影，不改变业务 targets、合法性或 AI 决策。
*/
export function resolveActionDisplayTargets(state, source, cardOrSkill, targets = []) {
  if (targets.length) return targets;
  if (cardOrSkill?.targetType === "allEnemies") {
    return getEnemies(state, source).map((target) => ({ id:target.id, name:target.name }));
  }
  if (cardOrSkill?.targetType === "none") {
    return [{ id:source.id, name:source.name, isSelf:true }];
  }
  return null;
}

/*
功能
生成纯展示 action 目标文案。

调用方
ActionWorkflow/TurnWorkflow/CardRuntime composition。

输入
state、source、cardOrSkill、targets 与 selection。

输出
文本。

读取状态
公开 name/id/battleTeam。

写入状态
无。

调用函数
无。

边界与不变量
不参与合法性；transfer/leverage 只解释已提供 selection。
*/
export function getActionTargetLabel(state, source, cardOrSkill, targets = [], selection = null) {
  const uniqueTargets = [...new Map(
    targets.filter((target) => target?.id && target?.name).map((target) => [target.id, target])
  ).values()];
  if (uniqueTargets.length) {
    return uniqueTargets.map((target) => target.id === source.id ? `${target.name}（自己）` : target.name).join("、");
  }
  if (cardOrSkill?.definitionId === "transfer" && selection?.sourceId && selection?.receiverId) {
    const from = state.players.find((player) => player.id === selection.sourceId);
    const receiver = state.players.find((player) => player.id === selection.receiverId);
    if (from && receiver) return `来源 ${from.name} → 接收 ${receiver.name}`;
  }
  if (cardOrSkill?.definitionId === "leverage" && selection?.firstTargetId && selection?.secondTargetId) {
    const first = state.players.find((player) => player.id === selection.firstTargetId);
    const second = state.players.find((player) => player.id === selection.secondTargetId);
    if (first && second) return `${first.name} → ${second.name}`;
  }
  return "";
}

/*
功能
生成右侧战斗日志自然句式。

调用方
CardRuntime composition。

输入
source、card 与 targets。

输出
文本。

读取状态
公开 card targetType/name。

写入状态
无。

调用函数
无。

边界与不变量
单目标与群体牌采用旧句式。
*/
export function getActionLogMessage(source, card, targets = []) {
  const singleTarget = !["allEnemies", "allLiving"].includes(card.targetType)
    && targets.length === 1 && targets[0]?.id !== source.id
    ? targets[0]
    : null;
  return singleTarget
    ? `${source.name}对${singleTarget.name}使用了「${card.name}」。`
    : `${source.name}使用了「${card.name}」。`;
}

/*
功能
判断卡牌是否只输出 result log 而不输出使用 log。

调用方
CardRuntime composition。

输入
definitionId。

输出
布尔值。

读取状态
RESULT_ONLY_CARD_IDS。

写入状态
无。

调用函数
Set.has。

边界与不变量
静态展示 policy。
*/
export function shouldSuppressUseLog(definitionId) {
  return RESULT_ONLY_CARD_IDS.has(definitionId);
}
