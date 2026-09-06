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
  注册 turnStart 泡泡机监听器。

  调用方
  match application.registerGlobalRules bridge。

  输入
  无。

  输出
  无。

  读取状态
  正式 turnStart 事件中的 player 与当前 MatchState。

  写入状态
  通过 changeShield 增加事件角色的普通护盾。

  调用函数
  onEvent、canTriggerBubbleMachine、changeShield、emitEvent。

  边界与不变量
  key 固定为 global:bubbleMachine；仅事件中的回合角色可触发，真实护盾形成后再发布既有 shieldGranted schema。
  */
  function register() {
    runtime.onEvent("turnStart", "global:bubbleMachine", async (event) => {
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
    });
  }

  return Object.freeze({ register });
}
