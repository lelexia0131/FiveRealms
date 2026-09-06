/*
模块职责
拥有「泡泡机」turnStart trigger registration：接收正式回合开始事件、查询 Domain predicate、提交普通护盾并发布既有 shieldGranted 事实。

上游
composition root。

下游
Domain BubbleMachineRules、CardDefinitions、ResourceTransitions 与窄 event/log collaborators。

状态边界
护盾只经 ResourceTransition 写入；不写其它 Domain state。

信息边界
不读取 UI、AI、DOM 或隐藏手牌。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime 或 concrete adapters；不得创建专属回合计数。
*/
import { canTriggerBubbleMachine } from "../../domain/rules/card/BubbleMachineRules.js";
import { CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { changeShield } from "../../domain/state/transitions/ResourceTransitions.js";

const REQUIRED_DEPENDENCIES = ["onEvent", "getState", "isSessionValid", "presentation", "emitEvent"];

/*
功能
创建泡泡机 trigger registry。

调用方
composition root。

输入
显式注入的 event、state、session 与 log collaborators。

输出
冻结 { register }。

读取状态
无。

写入状态
经 listener 与 ResourceTransition。

调用函数
canTriggerBubbleMachine、changeShield。

边界与不变量
只消费既有 turnStart；每次事件只查询一次，不保存额外回合状态。
*/
export function createBubbleMachineTrigger(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`BubbleMachineTrigger 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  /*
  功能
  处理正式回合开始时的泡泡机护盾触发与事实发布。

  调用方
  runtime 的 turnStart 事件监听器。

  输入
  turnStart 事件；player 为当前回合角色。

  输出
  返回 Promise；处理完成或不满足触发条件时解析为 undefined，下游异常保持传播。

  读取状态
  事件角色的存活、装备与护盾状态，以及当前 MatchState 的 gameId。

  写入状态
  通过 changeShield 增加事件角色的普通护盾。

  调用函数
  getState、canTriggerBubbleMachine、changeShield、emitEvent、isSessionValid、presentation.log。

  边界与不变量
  仅事件中的回合角色可触发；真实护盾形成后才发布既有 shieldGranted schema，并在发布完成后校验原 session 再记录日志。
  */
  async function handleTurnStart(event) {
    const owner = event?.player;
    if (!owner) return;
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!canTriggerBubbleMachine({
      ownerAlive: owner.alive,
      equipmentDefinitionId: owner.equipment?.definitionId ?? null,
      currentShield: owner.shield
    })) return;
    const shieldBefore = owner.shield;
    changeShield(state, owner, CARD_DEFINITIONS.bubbleMachine.turnShieldGain);
    const actualAddedAmount = Math.max(0, owner.shield - shieldBefore);
    if (actualAddedAmount <= 0) return;
    await runtime.emitEvent("shieldGranted", {
      source: owner,
      target: owner,
      actualAddedAmount,
      effectDefinitionId: CARD_DEFINITIONS.bubbleMachine.definitionId
    });
    if (!runtime.isSessionValid(gameId)) return;
    runtime.presentation.log(`${owner.name}的「泡泡机」触发，获得${actualAddedAmount}点护盾。`, "heal");
  }

  /*
  功能
  注册 turnStart 泡泡机监听器。

  调用方
  match application.registerGlobalRules bridge。

  输入
  无。

  输出
  无。

  读取状态
  无。

  写入状态
  通过 onEvent 写入 runtime 的事件监听器注册表。

  调用函数
  onEvent。

  边界与不变量
  事件名固定为 turnStart，key 固定为 global:bubbleMachine，handler 固定为 handleTurnStart。
  */
  function register() {
    runtime.onEvent("turnStart", "global:bubbleMachine", handleTurnStart);
  }

  return Object.freeze({ register });
}
